use std::path::Path;
use std::sync::Mutex;
use tree_sitter::Parser;

use crate::parser::languages::{LanguageParser, Symbol};
use crate::parser::types::NodeKind;

pub struct TypeScriptParser {
    ts_parser: Mutex<Parser>,
    tsx_parser: Mutex<Parser>,
}

impl TypeScriptParser {
    pub fn new() -> Self {
        let mut ts_parser = Parser::new();
        let mut tsx_parser = Parser::new();
        
        let ts_lang = tree_sitter_typescript::language_typescript();
        let tsx_lang = tree_sitter_typescript::language_tsx();
        
        ts_parser.set_language(ts_lang)
            .expect("Failed to load TypeScript grammar");
        tsx_parser.set_language(tsx_lang)
            .expect("Failed to load TSX grammar");
        
        Self {
            ts_parser: Mutex::new(ts_parser),
            tsx_parser: Mutex::new(tsx_parser),
        }
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
            "member_expression" => node
                .child_by_field_name("property")
                .and_then(|n| self.extract_name(&n, content)),
            _ => None,
        }
    }
}

impl Default for TypeScriptParser {
    fn default() -> Self {
        Self::new()
    }
}

impl LanguageParser for TypeScriptParser {
    fn can_parse(&self, extension: &str) -> bool {
        matches!(extension, "ts" | "tsx")
    }

    fn parse_file(&self, content: &str, path: &Path) -> Vec<Symbol> {
        let mut symbols = Vec::new();
        
        let is_tsx = path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("tsx"))
            .unwrap_or(false);

        let parser = if is_tsx { &self.tsx_parser } else { &self.ts_parser };
        
        let mut parser_guard = match parser.lock() {
            Ok(guard) => guard,
            Err(_) => return symbols,
        };
        
        let tree = match parser_guard.parse(content, None) {
            Some(t) => t,
            None => return symbols,
        };

        let root_node = tree.root_node();
        let mut cursor = root_node.walk();

        // First pass: extract top-level declarations
        for child in root_node.children(&mut cursor) {
            match child.kind() {
                "class_declaration" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
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
                }
                "function_declaration" => {
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
                "interface_declaration" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Interface,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                "type_alias_declaration" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Type,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
                                calls: vec![],
                            });
                        }
                    }
                }
                "enum_declaration" => {
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
                "lexical_declaration" => {
                    // Handle const/let with arrow functions
                    let mut decl_cursor = child.walk();
                    for decl_child in child.children(&mut decl_cursor) {
                        if decl_child.kind() == "variable_declarator" {
                            if let Some(name_node) = decl_child.child_by_field_name("name") {
                                if let Some(value_node) = decl_child.child_by_field_name("value") {
                                    if value_node.kind() == "arrow_function" {
                                        if let Some(name) = self.extract_name(&name_node, content) {
                                            let mut calls = Vec::new();
                                            if let Some(body) = value_node.child_by_field_name("body") {
                                                self.extract_calls_from_node(body, content, &mut calls);
                                            }
                                            symbols.push(Symbol {
                                                name,
                                                kind: NodeKind::Const,
                                                start_line: self.node_start_line(&decl_child),
                                                end_line: self.node_end_line(&decl_child),
                                                parent: None,
                                                calls,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // Second pass: find methods within classes
        let mut cursor = root_node.walk();
        for child in root_node.children(&mut cursor) {
            if child.kind() == "class_declaration" {
                if let Some(class_name_node) = child.child_by_field_name("name") {
                    if let Some(class_name) = self.extract_name(&class_name_node, content) {
                        if let Some(body) = child.child_by_field_name("body") {
                            let mut class_cursor = body.walk();
                            for class_child in body.children(&mut class_cursor) {
                                if class_child.kind() == "method_definition" {
                                    if let Some(method_name_node) = class_child.child_by_field_name("name") {
                                        if let Some(method_name) = self.extract_name(&method_name_node, content) {
                                            let mut calls = Vec::new();
                                            if let Some(body) = class_child.child_by_field_name("value") {
                                                if let Some(fn_body) = body.child_by_field_name("body") {
                                                    self.extract_calls_from_node(fn_body, content, &mut calls);
                                                }
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
            }
        }

        symbols
    }
}
