use std::path::Path;
use std::sync::Mutex;

use tree_sitter::Parser;

use crate::parser::languages::{LanguageParser, Symbol};
use crate::parser::types::NodeKind;

pub struct PythonParser {
    parser: Mutex<Parser>,
}

impl PythonParser {
    pub fn new() -> Self {
        let mut parser = Parser::new();
        let language = tree_sitter_python::language();
        // This expect is safe: tree-sitter-python grammar is always valid
        parser.set_language(language).expect("Failed to load Python grammar");
        Self { parser: Mutex::new(parser) }
    }

    fn node_start_line(&self, node: &tree_sitter::Node) -> u32 {
        (node.start_position().row + 1) as u32
    }

    fn node_end_line(&self, node: &tree_sitter::Node) -> u32 {
        (node.end_position().row + 1) as u32
    }

    fn extract_name(&self, node: &tree_sitter::Node, content: &str) -> Option<String> {
        node.utf8_text(content.as_bytes()).ok().map(|s| s.to_string())
    }

    fn extract_calls_from_node(&self, node: tree_sitter::Node, content: &str, out: &mut Vec<String>) {
        if node.kind() == "call" {
            if let Some(func_node) = node.child_by_field_name("function") {
                if let Some(name) = self.extract_callee_name(&func_node, content) {
                    out.push(name);
                }
            }
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            self.extract_calls_from_node(child, content, out);
        }
    }

    fn extract_callee_name(&self, node: &tree_sitter::Node, content: &str) -> Option<String> {
        match node.kind() {
            "identifier" => self.extract_name(node, content),
            "attribute" => node
                .child_by_field_name("attribute")
                .and_then(|n| self.extract_name(&n, content)),
            _ => None,
        }
    }
}

impl Default for PythonParser {
    fn default() -> Self {
        Self::new()
    }
}

impl LanguageParser for PythonParser {
    fn can_parse(&self, extension: &str) -> bool {
        extension.eq_ignore_ascii_case("py")
    }

    fn parse_file(&self, content: &str, _path: &Path) -> Vec<Symbol> {
        let mut symbols = Vec::new();
        
        // Lock the parser; if poisoned, return empty symbols
        let mut parser_guard = match self.parser.lock() {
            Ok(guard) => guard,
            Err(_) => return symbols,
        };
        let tree = match parser_guard.parse(content, None) {
            Some(t) => t,
            None => return symbols,
        };

        let root_node = tree.root_node();
        let mut cursor = root_node.walk();

        for child in root_node.children(&mut cursor) {
            match child.kind() {
                "class_definition" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = name_node.utf8_text(content.as_bytes()).unwrap_or("").to_string();
                        symbols.push(Symbol {
                            name,
                            kind: NodeKind::Class,
                            start_line: self.node_start_line(&child),
                            end_line: self.node_end_line(&child),
                            parent: None,
                            calls: vec![],
                        });
                    }
                }
                "function_definition" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        let name = name_node.utf8_text(content.as_bytes()).unwrap_or("").to_string();
                        let mut calls = Vec::new();
                        if let Some(body) = child.child_by_field_name("body") {
                            self.extract_calls_from_node(body, content, &mut calls);
                        }
                        symbols.push(Symbol {
                            name,
                            kind: NodeKind::Function,
                            start_line: self.node_start_line(&child),
                            end_line: self.node_end_line(&child),
                            parent: None,
                            calls,
                        });
                    }
                }
                _ => {}
            }
        }

        // Second pass: find methods within classes
        let mut cursor = root_node.walk();
        for child in root_node.children(&mut cursor) {
            if child.kind() == "class_definition" {
                if let Some(class_name_node) = child.child_by_field_name("name") {
                    let class_name = class_name_node
                        .utf8_text(content.as_bytes())
                        .unwrap_or("")
                        .to_string();

                    let mut class_cursor = child.walk();
                    if let Some(body) = child.child_by_field_name("body") {
                        for class_child in body.children(&mut class_cursor) {
                            if class_child.kind() == "function_definition" {
                                if let Some(method_name_node) = class_child.child_by_field_name("name") {
                                    let method_name = method_name_node
                                        .utf8_text(content.as_bytes())
                                        .unwrap_or("")
                                        .to_string();
                                    
                                    // Remove standalone function entry if exists
                                    symbols.retain(|s| !(s.name == method_name && s.kind == NodeKind::Function && s.parent.is_none()));
                                    
                                    let mut calls = Vec::new();
                                    if let Some(body) = class_child.child_by_field_name("body") {
                                        self.extract_calls_from_node(body, content, &mut calls);
                                    }
                                    symbols.push(Symbol {
                                        name: method_name,
                                        kind: NodeKind::Method,
                                        start_line: self.node_start_line(&class_child),
                                        end_line: self.node_end_line(&class_child),
                                        parent: Some(class_name.clone()),
                                        calls,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        symbols
    }
}
