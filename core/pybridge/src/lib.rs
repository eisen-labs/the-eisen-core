//! PyO3 bridge exposing eisen-core's parser and types to Python.
//!
//! All functions return JSON strings — the Rust types already implement
//! `Serialize`, so this keeps the FFI boundary simple and avoids modifying
//! `core/` with `#[pyclass]` annotations.

// PyO3 proc-macros generate conversion code that triggers this lint.
#![allow(clippy::useless_conversion)]

use std::path::Path;

use eisen_core::flatten::flatten;
use eisen_core::parser::tree::SymbolTree;
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;

/// Parse an entire workspace directory into a nested symbol tree.
///
/// Returns a JSON string representing the tree (nested nodes with children).
#[pyfunction]
fn parse_workspace(path: &str) -> PyResult<String> {
    let tree = SymbolTree::init_tree(Path::new(path))
        .map_err(|e| PyRuntimeError::new_err(format!("parse_workspace failed: {e}")))?;
    let json = tree.to_nested_json();
    serde_json::to_string(&json)
        .map_err(|e| PyRuntimeError::new_err(format!("JSON serialization failed: {e}")))
}

/// Parse a single file and return its symbols as a JSON array of NodeData.
///
/// Builds the full tree for the file's parent directory, then extracts
/// only the nodes belonging to the requested file path.
#[pyfunction]
fn parse_file(path: &str) -> PyResult<String> {
    let file_path = Path::new(path);
    let abs_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| PyRuntimeError::new_err(format!("cannot resolve cwd: {e}")))?
            .join(file_path)
    };

    let parent = abs_path
        .parent()
        .ok_or_else(|| PyRuntimeError::new_err("file has no parent directory"))?;

    let tree = SymbolTree::init_tree(parent)
        .map_err(|e| PyRuntimeError::new_err(format!("parse_file failed: {e}")))?;

    // Walk the tree and collect NodeData entries whose path matches
    let abs_str = abs_path.to_string_lossy();
    let mut results = Vec::new();
    collect_matching_nodes(&tree, &abs_str, &mut results);

    serde_json::to_string(&results)
        .map_err(|e| PyRuntimeError::new_err(format!("JSON serialization failed: {e}")))
}

/// Build a SymbolTree, flatten it into a UiSnapshot, and return as JSON.
#[pyfunction]
fn snapshot(path: &str) -> PyResult<String> {
    let root = Path::new(path);
    let tree = SymbolTree::init_tree(root)
        .map_err(|e| PyRuntimeError::new_err(format!("snapshot failed: {e}")))?;
    let ui = flatten(&tree, root, 0);
    serde_json::to_string(&ui)
        .map_err(|e| PyRuntimeError::new_err(format!("JSON serialization failed: {e}")))
}

/// Search for symbols matching the given name in a workspace.
///
/// Returns a JSON array of matching NodeData entries (may be empty).
/// This is the zero-cost A2A oracle: Python asks for a type signature,
/// Rust answers from tree-sitter with no LLM tokens burned.
#[pyfunction]
fn lookup_symbol(workspace_path: &str, symbol_name: &str) -> PyResult<String> {
    let tree = SymbolTree::init_tree(Path::new(workspace_path))
        .map_err(|e| PyRuntimeError::new_err(format!("lookup_symbol failed: {e}")))?;

    let mut results = Vec::new();
    collect_matching_nodes_by_name(&tree, symbol_name, &mut results);

    serde_json::to_string(&results)
        .map_err(|e| PyRuntimeError::new_err(format!("JSON serialization failed: {e}")))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Recursively collect serializable NodeData from the tree where the path matches.
fn collect_matching_nodes(tree: &SymbolTree, target_path: &str, out: &mut Vec<serde_json::Value>) {
    if let Some(root_id) = tree.root() {
        collect_nodes_recursive(tree, root_id, &|data| data.path == target_path, out);
    }
}

/// Recursively collect serializable NodeData from the tree where the name matches.
fn collect_matching_nodes_by_name(tree: &SymbolTree, name: &str, out: &mut Vec<serde_json::Value>) {
    if let Some(root_id) = tree.root() {
        collect_nodes_recursive(tree, root_id, &|data| data.name == name, out);
    }
}

fn collect_nodes_recursive(
    tree: &SymbolTree,
    node_id: indextree::NodeId,
    predicate: &dyn Fn(&eisen_core::parser::types::NodeData) -> bool,
    out: &mut Vec<serde_json::Value>,
) {
    if let Some(data) = tree.get_node(node_id) {
        if predicate(data) {
            if let Ok(val) = serde_json::to_value(data) {
                out.push(val);
            }
        }
    }
    for child_id in tree.get_children(node_id) {
        collect_nodes_recursive(tree, child_id, predicate, out);
    }
}

/// Python module definition.
#[pymodule]
fn eisen_bridge(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(parse_workspace, m)?)?;
    m.add_function(wrap_pyfunction!(parse_file, m)?)?;
    m.add_function(wrap_pyfunction!(snapshot, m)?)?;
    m.add_function(wrap_pyfunction!(lookup_symbol, m)?)?;
    Ok(())
}
