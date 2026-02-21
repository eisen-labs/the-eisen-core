use indextree::{Arena, NodeId};
use std::path::Path;

use crate::parser::types::NodeData;
use crate::parser::walk::DirectoryWalker;

pub struct SymbolTree {
    arena: Arena<NodeData>,
    root: Option<NodeId>,
}

impl SymbolTree {
    pub fn new() -> Self {
        Self {
            arena: Arena::new(),
            root: None,
        }
    }

    pub fn init_tree(root_path: &Path) -> anyhow::Result<Self> {
        let mut tree = Self::new();
        let walker = DirectoryWalker::new(root_path);
        walker.walk_and_build(&mut tree)?;
        Ok(tree)
    }

    pub fn add_node(&mut self, parent_id: Option<NodeId>, data: NodeData) -> NodeId {
        let node_id = self.arena.new_node(data);

        if let Some(parent) = parent_id {
            parent.append(node_id, &mut self.arena);
        } else if self.root.is_none() {
            self.root = Some(node_id);
        }

        node_id
    }

    #[allow(dead_code)]
    pub fn delete_node(&mut self, node_id: NodeId) -> anyhow::Result<()> {
        // Check if node is root BEFORE removing it
        if Some(node_id) == self.root {
            self.root = None;
        }

        node_id.remove_subtree(&mut self.arena);

        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_node(&mut self, node_id: NodeId, data: NodeData) -> anyhow::Result<()> {
        let node = self
            .arena
            .get_mut(node_id)
            .ok_or_else(|| anyhow::anyhow!("Node not found"))?;
        *node.get_mut() = data;
        Ok(())
    }

    pub fn get_node(&self, node_id: NodeId) -> Option<&NodeData> {
        self.arena.get(node_id).map(|n| n.get())
    }

    #[allow(dead_code)]
    pub fn get_node_mut(&mut self, node_id: NodeId) -> Option<&mut NodeData> {
        self.arena.get_mut(node_id).map(|n| n.get_mut())
    }

    pub fn root(&self) -> Option<NodeId> {
        self.root
    }

    #[allow(dead_code)]
    pub fn arena(&self) -> &Arena<NodeData> {
        &self.arena
    }

    #[allow(dead_code)]
    pub fn find_by_path(&self, path: &str) -> Option<NodeId> {
        if let Some(root_id) = self.root {
            self.find_by_path_recursive(root_id, path)
        } else {
            None
        }
    }

    fn find_by_path_recursive(&self, node_id: NodeId, path: &str) -> Option<NodeId> {
        if let Some(data) = self.get_node(node_id) {
            if data.path == path {
                return Some(node_id);
            }
        }

        for child_id in self.get_children(node_id) {
            if let Some(found) = self.find_by_path_recursive(child_id, path) {
                return Some(found);
            }
        }

        None
    }

    pub fn get_children(&self, node_id: NodeId) -> Vec<NodeId> {
        node_id.children(&self.arena).collect()
    }
}

impl Default for SymbolTree {
    fn default() -> Self {
        Self::new()
    }
}
