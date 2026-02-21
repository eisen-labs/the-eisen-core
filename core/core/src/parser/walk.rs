use ignore::WalkBuilder;
use indextree::NodeId;
use log::warn;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::parser::languages::{
    python::PythonParser, rust::RustParser, typescript::TypeScriptParser, LanguageParser,
};
use crate::parser::tree::SymbolTree;
use crate::parser::types::{NodeData, NodeKind};

pub struct DirectoryWalker<'a> {
    root_path: &'a Path,
    ignore_patterns: Vec<&'static str>,
}

impl<'a> DirectoryWalker<'a> {
    pub fn new(root_path: &'a Path) -> Self {
        Self {
            root_path,
            ignore_patterns: vec![
                ".git",
                "target",
                "node_modules",
                "__pycache__",
                ".venv",
                "venv",
                ".pytest_cache",
                ".mypy_cache",
                ".tox",
                "dist",
                "build",
                ".egg-info",
            ],
        }
    }

    pub fn walk_and_build(&self, tree: &mut SymbolTree) -> anyhow::Result<()> {
        let root_path_str = self.root_path.to_string_lossy().to_string();
        let root_name = self
            .root_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "root".to_string());

        let root_data = NodeData::new(0, root_name, NodeKind::Folder, root_path_str);
        let root_id = tree.add_node(None, root_data);

        let mut path_to_node: HashMap<PathBuf, NodeId> = HashMap::new();
        path_to_node.insert(self.root_path.to_path_buf(), root_id);

        let walker = WalkBuilder::new(self.root_path)
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true)
            .build();

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    warn!("Failed to read directory entry: {}", e);
                    continue;
                }
            };

            let path = entry.path();
            if path == self.root_path {
                continue;
            }

            let Some(file_type) = entry.file_type() else {
                continue;
            };

            if self.should_ignore(path, file_type.is_file()) {
                continue;
            }

            let parent_path = path.parent().unwrap_or(self.root_path);

            if let Some(&parent_id) = path_to_node.get(parent_path) {
                if file_type.is_dir() {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let path_str = path.to_string_lossy().to_string();
                    let data = NodeData::new(0, name, NodeKind::Folder, path_str);
                    let node_id = tree.add_node(Some(parent_id), data);
                    path_to_node.insert(path.to_path_buf(), node_id);
                } else if file_type.is_file() {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    self.process_file(tree, path, &name, parent_id, &mut path_to_node)?;
                }
            }
        }

        Ok(())
    }

    fn should_ignore(&self, path: &Path, is_file: bool) -> bool {
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if file_name.starts_with('.')
            && file_name != "."
            && file_name != ".."
            && self
                .ignore_patterns
                .iter()
                .any(|p| file_name.starts_with(*p))
        {
            return true;
        }

        if self
            .ignore_patterns
            .iter()
            .any(|pattern| file_name == *pattern)
        {
            return true;
        }

        if is_file
            && (file_name.ends_with(".pyc")
                || file_name.ends_with(".pyo")
                || file_name.ends_with(".so")
                || file_name.ends_with(".dylib")
                || file_name.ends_with(".dll"))
        {
            return true;
        }

        false
    }

    fn process_file(
        &self,
        tree: &mut SymbolTree,
        path: &Path,
        name: &str,
        parent_id: NodeId,
        path_to_node: &mut HashMap<PathBuf, NodeId>,
    ) -> anyhow::Result<()> {
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());

        if let Some(ref ext) = extension {
            match ext.as_str() {
                "py" => return self.process_python_file(tree, path, name, parent_id, path_to_node),
                "ts" | "tsx" => {
                    return self.process_typescript_file(tree, path, name, parent_id, path_to_node)
                }
                "rs" => return self.process_rust_file(tree, path, name, parent_id, path_to_node),
                _ => {}
            }
        }

        let path_str = path.to_string_lossy().to_string();
        let data = NodeData::new(
            0,
            name.to_string(),
            NodeKind::File(extension.unwrap_or_default()),
            path_str,
        );
        let node_id = tree.add_node(Some(parent_id), data);
        path_to_node.insert(path.to_path_buf(), node_id);

        Ok(())
    }

    fn process_python_file(
        &self,
        tree: &mut SymbolTree,
        path: &Path,
        name: &str,
        parent_id: NodeId,
        path_to_node: &mut HashMap<PathBuf, NodeId>,
    ) -> anyhow::Result<()> {
        let path_str = path.to_string_lossy().to_string();

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read file {}: {}", path.display(), e);
                let data = NodeData::new(
                    0,
                    name.to_string(),
                    NodeKind::File("py".to_string()),
                    path_str,
                );
                let node_id = tree.add_node(Some(parent_id), data);
                path_to_node.insert(path.to_path_buf(), node_id);
                return Ok(());
            }
        };

        let line_count = content.lines().count() as u32;
        let file_data = NodeData::new(
            0,
            name.to_string(),
            NodeKind::File("py".to_string()),
            path_str.clone(),
        )
        .with_lines(1, line_count.max(1));
        let file_id = tree.add_node(Some(parent_id), file_data);
        path_to_node.insert(path.to_path_buf(), file_id);

        let parser = PythonParser::new();
        let symbols = parser.parse_file(&content, path);

        let mut class_nodes: HashMap<String, NodeId> = HashMap::new();

        for symbol in symbols {
            let symbol_data = match symbol.kind {
                NodeKind::Class => {
                    let data =
                        NodeData::new(0, symbol.name.clone(), NodeKind::Class, path_str.clone())
                            .with_lines(symbol.start_line, symbol.end_line)
                            .with_calls(symbol.calls.clone());
                    let node_id = tree.add_node(Some(file_id), data);
                    class_nodes.insert(symbol.name.clone(), node_id);
                    continue;
                }
                NodeKind::Method => {
                    // Methods should have a parent class
                    NodeData::new(0, symbol.name.clone(), NodeKind::Method, path_str.clone())
                        .with_lines(symbol.start_line, symbol.end_line)
                        .with_calls(symbol.calls.clone())
                }
                NodeKind::Function => {
                    NodeData::new(0, symbol.name.clone(), NodeKind::Function, path_str.clone())
                        .with_lines(symbol.start_line, symbol.end_line)
                        .with_calls(symbol.calls.clone())
                }
                _ => continue,
            };

            if let Some(ref parent_class) = symbol.parent {
                if let Some(&class_id) = class_nodes.get(parent_class) {
                    tree.add_node(Some(class_id), symbol_data);
                } else {
                    tree.add_node(Some(file_id), symbol_data);
                }
            } else {
                tree.add_node(Some(file_id), symbol_data);
            }
        }

        Ok(())
    }

    fn process_typescript_file(
        &self,
        tree: &mut SymbolTree,
        path: &Path,
        name: &str,
        parent_id: NodeId,
        path_to_node: &mut HashMap<PathBuf, NodeId>,
    ) -> anyhow::Result<()> {
        let path_str = path.to_string_lossy().to_string();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_else(|| "ts".to_string());

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read file {}: {}", path.display(), e);
                let data = NodeData::new(0, name.to_string(), NodeKind::File(ext), path_str);
                let node_id = tree.add_node(Some(parent_id), data);
                path_to_node.insert(path.to_path_buf(), node_id);
                return Ok(());
            }
        };

        let line_count = content.lines().count() as u32;
        let file_data = NodeData::new(0, name.to_string(), NodeKind::File(ext), path_str.clone())
            .with_lines(1, line_count.max(1));
        let file_id = tree.add_node(Some(parent_id), file_data);
        path_to_node.insert(path.to_path_buf(), file_id);

        let parser = TypeScriptParser::new();
        let symbols = parser.parse_file(&content, path);

        let mut parent_nodes: HashMap<String, NodeId> = HashMap::new();

        for symbol in symbols {
            let symbol_data = match symbol.kind {
                NodeKind::Class | NodeKind::Interface | NodeKind::Impl => {
                    let data = NodeData::new(0, symbol.name.clone(), symbol.kind, path_str.clone())
                        .with_lines(symbol.start_line, symbol.end_line)
                        .with_calls(symbol.calls.clone());
                    let node_id = tree.add_node(Some(file_id), data);
                    parent_nodes.insert(symbol.name.clone(), node_id);
                    continue;
                }
                NodeKind::Method => {
                    NodeData::new(0, symbol.name.clone(), NodeKind::Method, path_str.clone())
                        .with_lines(symbol.start_line, symbol.end_line)
                        .with_calls(symbol.calls.clone())
                }
                _ => NodeData::new(0, symbol.name.clone(), symbol.kind, path_str.clone())
                    .with_lines(symbol.start_line, symbol.end_line)
                    .with_calls(symbol.calls.clone()),
            };

            if let Some(ref parent_name) = symbol.parent {
                if let Some(&parent_id) = parent_nodes.get(parent_name) {
                    tree.add_node(Some(parent_id), symbol_data);
                } else {
                    tree.add_node(Some(file_id), symbol_data);
                }
            } else {
                tree.add_node(Some(file_id), symbol_data);
            }
        }

        Ok(())
    }

    fn process_rust_file(
        &self,
        tree: &mut SymbolTree,
        path: &Path,
        name: &str,
        parent_id: NodeId,
        path_to_node: &mut HashMap<PathBuf, NodeId>,
    ) -> anyhow::Result<()> {
        let path_str = path.to_string_lossy().to_string();

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read file {}: {}", path.display(), e);
                let data = NodeData::new(
                    0,
                    name.to_string(),
                    NodeKind::File("rs".to_string()),
                    path_str,
                );
                let node_id = tree.add_node(Some(parent_id), data);
                path_to_node.insert(path.to_path_buf(), node_id);
                return Ok(());
            }
        };

        let line_count = content.lines().count() as u32;
        let file_data = NodeData::new(
            0,
            name.to_string(),
            NodeKind::File("rs".to_string()),
            path_str.clone(),
        )
        .with_lines(1, line_count.max(1));
        let file_id = tree.add_node(Some(parent_id), file_data);
        path_to_node.insert(path.to_path_buf(), file_id);

        let parser = RustParser::new();
        let symbols = parser.parse_file(&content, path);

        let mut parent_nodes: HashMap<String, NodeId> = HashMap::new();

        for symbol in symbols {
            let symbol_data = match symbol.kind {
                NodeKind::Struct | NodeKind::Trait | NodeKind::Impl => {
                    let data = NodeData::new(0, symbol.name.clone(), symbol.kind, path_str.clone())
                        .with_lines(symbol.start_line, symbol.end_line)
                        .with_calls(symbol.calls.clone());
                    let node_id = tree.add_node(Some(file_id), data);
                    parent_nodes.insert(symbol.name.clone(), node_id);
                    continue;
                }
                NodeKind::Method => {
                    NodeData::new(0, symbol.name.clone(), NodeKind::Method, path_str.clone())
                        .with_lines(symbol.start_line, symbol.end_line)
                        .with_calls(symbol.calls.clone())
                }
                _ => NodeData::new(0, symbol.name.clone(), symbol.kind, path_str.clone())
                    .with_lines(symbol.start_line, symbol.end_line)
                    .with_calls(symbol.calls.clone()),
            };

            if let Some(ref parent_name) = symbol.parent {
                if let Some(&parent_id) = parent_nodes.get(parent_name) {
                    tree.add_node(Some(parent_id), symbol_data);
                } else {
                    tree.add_node(Some(file_id), symbol_data);
                }
            } else {
                tree.add_node(Some(file_id), symbol_data);
            }
        }

        Ok(())
    }
}
