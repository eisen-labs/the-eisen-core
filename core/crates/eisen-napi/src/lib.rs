//! NAPI-RS bridge exposing eisen-core's parser and types to TypeScript/Bun.
//!
//! Direct port of the PyO3 bridge (`pybridge/src/lib.rs`). All functions
//! return JSON strings — the Rust types already implement `Serialize`, so
//! this keeps the FFI boundary simple. The `.node` addon loads in-process
//! via Node-API — no spawning, no JSON-over-stdio boundary.

use std::path::Path;

use eisen_core::flatten::flatten;
use eisen_core::parser::tree::SymbolTree;
use eisen_core::parser::types::NodeData;
use napi_derive::napi;

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/// Parse an entire workspace directory into a nested symbol tree.
///
/// Returns a JSON string representing the tree (nested nodes with children).
/// Output is identical to `pybridge::parse_workspace`.
#[napi]
pub fn parse_workspace(path: String) -> napi::Result<String> {
    let tree = SymbolTree::init_tree(Path::new(&path))
        .map_err(|e| napi::Error::from_reason(format!("parse_workspace failed: {e}")))?;
    let json = tree.to_nested_json();
    serde_json::to_string(&json)
        .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
}

/// Parse a single file and return its symbols as a JSON array of NodeData.
///
/// Builds the full tree for the file's parent directory, then extracts
/// only the nodes belonging to the requested file path.
/// Output is identical to `pybridge::parse_file`.
#[napi]
pub fn parse_file(path: String) -> napi::Result<String> {
    let file_path = Path::new(&path);
    let abs_path = if file_path.is_absolute() {
        file_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| napi::Error::from_reason(format!("cannot resolve cwd: {e}")))?
            .join(file_path)
    };

    let parent = abs_path
        .parent()
        .ok_or_else(|| napi::Error::from_reason("file has no parent directory"))?;

    let tree = SymbolTree::init_tree(parent)
        .map_err(|e| napi::Error::from_reason(format!("parse_file failed: {e}")))?;

    let abs_str = abs_path.to_string_lossy();
    let mut results = Vec::new();
    collect_nodes(&tree, &|data| data.path == *abs_str, &mut results);

    serde_json::to_string(&results)
        .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
}

/// Build a SymbolTree, flatten it into a UiSnapshot, and return as JSON.
///
/// Output is identical to `pybridge::snapshot`.
#[napi]
pub fn snapshot(path: String) -> napi::Result<String> {
    let root = Path::new(&path);
    let tree = SymbolTree::init_tree(root)
        .map_err(|e| napi::Error::from_reason(format!("snapshot failed: {e}")))?;
    let ui = flatten(&tree, root, 0);
    serde_json::to_string(&ui)
        .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
}

/// Search for symbols matching the given name in a workspace.
///
/// Returns a JSON array of matching NodeData entries (may be empty).
/// Output is identical to `pybridge::lookup_symbol`.
#[napi]
pub fn lookup_symbol(workspace_path: String, symbol_name: String) -> napi::Result<String> {
    let tree = SymbolTree::init_tree(Path::new(&workspace_path))
        .map_err(|e| napi::Error::from_reason(format!("lookup_symbol failed: {e}")))?;

    let mut results = Vec::new();
    collect_nodes(&tree, &|data| data.name == symbol_name, &mut results);

    serde_json::to_string(&results)
        .map_err(|e| napi::Error::from_reason(format!("JSON serialization failed: {e}")))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Recursively collect serializable NodeData from the tree where the predicate matches.
fn collect_nodes(
    tree: &SymbolTree,
    predicate: &dyn Fn(&NodeData) -> bool,
    out: &mut Vec<serde_json::Value>,
) {
    if let Some(root_id) = tree.root() {
        collect_nodes_recursive(tree, root_id, predicate, out);
    }
}

fn collect_nodes_recursive(
    tree: &SymbolTree,
    node_id: indextree::NodeId,
    predicate: &dyn Fn(&NodeData) -> bool,
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
