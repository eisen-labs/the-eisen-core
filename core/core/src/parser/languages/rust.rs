use std::path::Path;
use std::sync::Mutex;
use tree_sitter::Parser;

use crate::parser::languages::{LanguageParser, Symbol};
use crate::parser::types::NodeKind;

pub struct RustParser {
    parser: Mutex<Parser>,
}

impl RustParser {
    pub fn new() -> Self {
        let mut parser = Parser::new();
        let language = tree_sitter_rust::language();
        parser.set_language(language)
            .expect("Failed to load Rust grammar");
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
        if node.kind() == "call_expression" {
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
            "scoped_identifier" => node
                .child_by_field_name("name")
                .and_then(|n| self.extract_name(&n, content)),
            "field_expression" => node
                .child_by_field_name("field")
                .and_then(|n| self.extract_name(&n, content)),
            _ => None,
        }
    }
}

impl Default for RustParser {
    fn default() -> Self {
        Self::new()
    }
}

impl LanguageParser for RustParser {
    fn can_parse(&self, extension: &str) -> bool {
        extension.eq_ignore_ascii_case("rs")
    }

    fn parse_file(&self, content: &str, _path: &Path) -> Vec<Symbol> {
        let mut symbols = Vec::new();
        
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

        // Extract top-level declarations
        for child in root_node.children(&mut cursor) {
            match child.kind() {
                "struct_item" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Struct,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                "enum_item" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Enum,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                "trait_item" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Trait,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                "impl_item" => {
                    // Extract impl block name (trait or type)
                    if let Some(type_node) = child.child_by_field_name("type") {
                        if let Some(type_name) = self.extract_name(&type_node, content) {
                            let impl_name = if let Some(trait_node) = child.child_by_field_name("trait") {
                                if let Some(trait_name) = self.extract_name(&trait_node, content) {
                                    format!("{} for {}", trait_name, type_name)
                                } else {
                                    type_name
                                }
                            } else {
                                type_name
                            };
                            
                            symbols.push(Symbol {
                                name: impl_name.clone(),
                                kind: NodeKind::Impl,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });

                            // Extract methods from impl block
                            if let Some(body) = child.child_by_field_name("body") {
                                let mut impl_cursor = body.walk();
                                for impl_child in body.children(&mut impl_cursor) {
                                    if impl_child.kind() == "function_item" {
                                        if let Some(fn_name_node) = impl_child.child_by_field_name("name") {
                                            if let Some(fn_name) = self.extract_name(&fn_name_node, content) {
                                                let mut calls = Vec::new();
                                                if let Some(fn_body) = impl_child.child_by_field_name("body") {
                                                    self.extract_calls_from_node(fn_body, content, &mut calls);
                                                }
                                                symbols.push(Symbol {
                                                    name: fn_name,
                                                    kind: NodeKind::Method,
                                                    start_line: self.node_start_line(&impl_child),
                                                    end_line: self.node_end_line(&impl_child),
                                                    parent: Some(impl_name.clone()),
                                                    calls,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                "function_item" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
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
                }
                "mod_item" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Mod,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                "const_item" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Const,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                _ => {}
            }
        }

        symbols
    }
}
