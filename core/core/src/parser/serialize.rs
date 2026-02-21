use indextree::NodeId;
use serde_json::Value;

use crate::parser::tree::SymbolTree;
use crate::parser::types::NodeData;

#[derive(Debug, Clone, serde::Serialize)]
struct SerializableNode {
    id: usize,
    name: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(rename = "startLine")]
    start_line: u32,
    #[serde(rename = "endLine")]
    end_line: u32,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<SerializableNode>>,
}

impl SymbolTree {
    pub fn to_nested_json(&self) -> Value {
        if let Some(root_id) = self.root() {
            let serializable = self.node_to_serializable(root_id);
            serde_json::to_value(serializable).unwrap_or(Value::Null)
        } else {
            Value::Null
        }
    }

    /// Serialize tree to flat JSON array (deprecated, use to_nested_json)
    #[allow(dead_code)]
    pub fn to_flat_json(&self) -> Value {
        let mut nodes: Vec<SerializableNode> = Vec::new();
        if let Some(root_id) = self.root() {
            self.collect_nodes_flat(root_id, &mut nodes);
        }
        serde_json::to_value(nodes).unwrap_or(Value::Array(vec![]))
    }

    fn collect_nodes_flat(&self, node_id: NodeId, nodes: &mut Vec<SerializableNode>) {
        nodes.push(self.node_to_serializable_flat(node_id));
        for child_id in self.get_children(node_id) {
            self.collect_nodes_flat(child_id, nodes);
        }
    }

    fn node_to_serializable(&self, node_id: NodeId) -> SerializableNode {
        let data = self.get_node(node_id).expect("Node must exist");
        
        let children: Option<Vec<SerializableNode>> = if self.get_children(node_id).is_empty() {
            None
        } else {
            Some(
                self.get_children(node_id)
                    .into_iter()
                    .map(|child_id| self.node_to_serializable(child_id))
                    .collect(),
            )
        };

        SerializableNode {
            id: data.id,
            name: data.name.clone(),
            kind: match &data.kind {
                crate::parser::types::NodeKind::Folder => "folder".to_string(),
                crate::parser::types::NodeKind::File(_) => "file".to_string(),
                crate::parser::types::NodeKind::Class => "class".to_string(),
                crate::parser::types::NodeKind::Method => "method".to_string(),
                crate::parser::types::NodeKind::Function => "function".to_string(),
                crate::parser::types::NodeKind::Interface => "interface".to_string(),
                crate::parser::types::NodeKind::Type => "type".to_string(),
                crate::parser::types::NodeKind::Enum => "enum".to_string(),
                crate::parser::types::NodeKind::Const => "const".to_string(),
                crate::parser::types::NodeKind::Struct => "struct".to_string(),
                crate::parser::types::NodeKind::Trait => "trait".to_string(),
                crate::parser::types::NodeKind::Impl => "impl".to_string(),
                crate::parser::types::NodeKind::Mod => "mod".to_string(),
            },
            language: data.language.clone(),
            start_line: data.start_line,
            end_line: data.end_line,
            path: data.path.clone(),
            children,
        }
    }

    fn node_to_serializable_flat(&self, node_id: NodeId) -> SerializableNode {
        let data = self.get_node(node_id).expect("Node must exist");
        
        SerializableNode {
            id: data.id,
            name: data.name.clone(),
            kind: match &data.kind {
                crate::parser::types::NodeKind::Folder => "folder".to_string(),
                crate::parser::types::NodeKind::File(_) => "file".to_string(),
                crate::parser::types::NodeKind::Class => "class".to_string(),
                crate::parser::types::NodeKind::Method => "method".to_string(),
                crate::parser::types::NodeKind::Function => "function".to_string(),
                crate::parser::types::NodeKind::Interface => "interface".to_string(),
                crate::parser::types::NodeKind::Type => "type".to_string(),
                crate::parser::types::NodeKind::Enum => "enum".to_string(),
                crate::parser::types::NodeKind::Const => "const".to_string(),
                crate::parser::types::NodeKind::Struct => "struct".to_string(),
                crate::parser::types::NodeKind::Trait => "trait".to_string(),
                crate::parser::types::NodeKind::Impl => "impl".to_string(),
                crate::parser::types::NodeKind::Mod => "mod".to_string(),
            },
            language: data.language.clone(),
            start_line: data.start_line,
            end_line: data.end_line,
            path: data.path.clone(),
            children: None,
        }
    }
}

/// Convert NodeData to JSON Value
#[allow(dead_code)]
pub fn node_to_json(node: &NodeData) -> Value {
    serde_json::json!({
        "id": node.id,
        "name": node.name,
        "kind": match &node.kind {
            crate::parser::types::NodeKind::Folder => "folder",
            crate::parser::types::NodeKind::File(_) => "file",
            crate::parser::types::NodeKind::Class => "class",
            crate::parser::types::NodeKind::Method => "method",
            crate::parser::types::NodeKind::Function => "function",
            crate::parser::types::NodeKind::Interface => "interface",
            crate::parser::types::NodeKind::Type => "type",
            crate::parser::types::NodeKind::Enum => "enum",
            crate::parser::types::NodeKind::Const => "const",
            crate::parser::types::NodeKind::Struct => "struct",
            crate::parser::types::NodeKind::Trait => "trait",
            crate::parser::types::NodeKind::Impl => "impl",
            crate::parser::types::NodeKind::Mod => "mod",
        },
        "language": node.language,
        "startLine": node.start_line,
        "endLine": node.end_line,
        "path": node.path,
    })
}
