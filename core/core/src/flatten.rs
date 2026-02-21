//! Flattens a `SymbolTree` (file/class/method hierarchy) into a `UiSnapshot`
//! suitable for the graph webview. Maps parser-level `NodeKind` variants to the
//! simplified set the UI understands (folder, file, class, method, function)
//! and resolves function call edges between symbols.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use indextree::NodeId;

use crate::parser::tree::SymbolTree;
use crate::parser::types::NodeKind;
use crate::types::{UiCallEdge, UiLineRange, UiNode, UiSnapshot};

const SKIP_CALLEE_NAMES: &[&str] = &[
    "new", "len", "print", "println", "format", "toString", "__init__",
];

pub fn flatten(tree: &SymbolTree, root_path: &Path, seq: u64) -> UiSnapshot {
    let mut nodes = HashMap::new();
    let mut caller_calls: Vec<(String, Vec<String>)> = Vec::new();
    if let Some(root_id) = tree.root() {
        walk(tree, root_id, root_path, "", &mut nodes, &mut caller_calls);
    }
    let calls = resolve_calls(&nodes, &caller_calls);
    UiSnapshot { seq, nodes, calls }
}

fn resolve_calls(
    nodes: &HashMap<String, UiNode>,
    caller_calls: &[(String, Vec<String>)],
) -> Vec<UiCallEdge> {
    let mut name_to_ids: HashMap<String, Vec<String>> = HashMap::new();
    for id in nodes.keys() {
        if id.contains("::") {
            let name = id.rsplit("::").next().unwrap_or(id);
            name_to_ids
                .entry(name.to_string())
                .or_default()
                .push(id.clone());
        }
    }

    let mut edges = Vec::new();
    let mut seen = HashSet::new();

    for (caller_id, callee_names) in caller_calls {
        let caller_file: &str = if caller_id.contains("::") {
            caller_id.split("::").next().unwrap_or("")
        } else {
            caller_id
        };
        for name in callee_names {
            let name = name.trim();
            if name.len() < 3 || SKIP_CALLEE_NAMES.contains(&name) {
                continue;
            }
            let Some(candidate_ids) = name_to_ids.get(name) else {
                continue;
            };
            let target_id = if candidate_ids.len() == 1 {
                candidate_ids[0].clone()
            } else {
                let same_file = candidate_ids
                    .iter()
                    .find(|id| {
                        let f: &str = if id.contains("::") {
                            id.split("::").next().unwrap_or("")
                        } else {
                            id
                        };
                        f == caller_file
                    })
                    .cloned();
                same_file
                    .or_else(|| candidate_ids.first().cloned())
                    .unwrap_or_default()
            };
            if target_id.is_empty()
                || target_id == *caller_id
                || !nodes.contains_key(&target_id)
                || !seen.insert((caller_id.clone(), target_id.clone()))
            {
                continue;
            }
            edges.push(UiCallEdge {
                from: caller_id.clone(),
                to: target_id,
            });
        }
    }
    edges
}

fn walk(
    tree: &SymbolTree,
    node_id: NodeId,
    root: &Path,
    parent_id: &str,
    nodes: &mut HashMap<String, UiNode>,
    caller_calls: &mut Vec<(String, Vec<String>)>,
) {
    let data = match tree.get_node(node_id) {
        Some(d) => d,
        None => return,
    };

    if data.name.starts_with('.') {
        return;
    }

    let id = match &data.kind {
        NodeKind::Folder => {
            for child in tree.get_children(node_id) {
                walk(tree, child, root, parent_id, nodes, caller_calls);
            }
            return;
        }
        NodeKind::File(_) => {
            let rel = Path::new(&data.path)
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| data.path.clone());
            if rel.split('/').any(|seg| seg.starts_with('.')) {
                return;
            }
            rel
        }
        _ => format!("{}::{}", parent_id, data.name),
    };

    let lines = if data.start_line > 0 || data.end_line > 0 {
        Some(UiLineRange {
            start: data.start_line,
            end: data.end_line,
        })
    } else {
        None
    };

    nodes.insert(
        id.clone(),
        UiNode {
            kind: Some(ui_kind(&data.kind).into()),
            lines,
            last_write: None,
            changed: None,
        },
    );

    if !data.calls.is_empty() {
        caller_calls.push((id.clone(), data.calls.clone()));
    }

    for child in tree.get_children(node_id) {
        walk(tree, child, root, &id, nodes, caller_calls);
    }
}

/// Map parser NodeKind to the simplified UI kind used by the graph.
/// The graph only understands: folder, file, class, method, function.
fn ui_kind(kind: &NodeKind) -> &str {
    match kind {
        NodeKind::Folder => "folder",
        NodeKind::File(_) => "file",
        NodeKind::Class
        | NodeKind::Struct
        | NodeKind::Trait
        | NodeKind::Interface
        | NodeKind::Enum
        | NodeKind::Impl => "class",
        NodeKind::Method => "method",
        NodeKind::Function | NodeKind::Const | NodeKind::Type | NodeKind::Mod => "function",
    }
}
