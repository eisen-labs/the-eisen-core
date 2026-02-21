use indextree::NodeId;
use serde_json::Value;

use crate::parser::tree::SymbolTree;

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

    fn node_to_serializable(&self, node_id: NodeId) -> SerializableNode {
        let data = self.get_node(node_id).expect("Node must exist");
        let children_ids = self.get_children(node_id);

        let children = if children_ids.is_empty() {
            None
        } else {
            Some(
                children_ids
                    .into_iter()
                    .map(|child_id| self.node_to_serializable(child_id))
                    .collect(),
            )
        };

        SerializableNode {
            id: data.id,
            name: data.name.clone(),
            kind: data.kind.as_str().to_string(),
            language: data.language.clone(),
            start_line: data.start_line,
            end_line: data.end_line,
            path: data.path.clone(),
            children,
        }
    }
}
