# Adding TypeScript and Rust Parsing Support

## Quick Implementation Guide

This document provides the exact steps to add TypeScript and Rust language parsing to eisen-core.

---

## Step 1: Add Dependencies

**File:** `core/Cargo.toml`

Add these lines to the `[dependencies]` section:

```toml
tree-sitter-typescript = "0.20"
tree-sitter-javascript = "0.20"
tree-sitter-rust = "0.20"
```

---

## Step 2: Extend NodeKind Enum

**File:** `core/src/parser/types.rs`

### Update the enum definition:

```rust
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub enum NodeKind {
    Folder,
    File(String),
    // Python
    Class,
    Method,
    Function,
    // TypeScript/JavaScript
    Interface,
    Type,
    Enum,
    Const,
    // Rust
    Struct,
    Trait,
    Impl,
    Mod,
}
```

### Update the Serialize implementation:

```rust
impl Serialize for NodeKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let kind_str = match self {
            NodeKind::Folder => "folder",
            NodeKind::File(_) => "file",
            NodeKind::Class => "class",
            NodeKind::Method => "method",
            NodeKind::Function => "function",
            NodeKind::Interface => "interface",
            NodeKind::Type => "type",
            NodeKind::Enum => "enum",
            NodeKind::Const => "const",
            NodeKind::Struct => "struct",
            NodeKind::Trait => "trait",
            NodeKind::Impl => "impl",
            NodeKind::Mod => "mod",
        };
        serializer.serialize_str(kind_str)
    }
}
```

---

## Step 3: Create TypeScript Parser

**File:** `core/src/parser/languages/typescript.rs` (new file)

```rust
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
                            });
                        }
                    }
                }
                "function_declaration" => {
                    if let Some(name_node) = child.child_by_field_name("name") {
                        if let Some(name) = self.extract_name(&name_node, content) {
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Function,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
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
                                            symbols.push(Symbol {
                                                name,
                                                kind: NodeKind::Const,
                                                start_line: self.node_start_line(&decl_child),
                                                end_line: self.node_end_line(&decl_child),
                                                parent: None,
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
                                            symbols.push(Symbol {
                                                name: method_name,
                                                kind: NodeKind::Method,
                                                start_line: self.node_start_line(&class_child),
                                                end_line: self.node_end_line(&class_child),
                                                parent: Some(class_name.clone()),
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
```

---

## Step 4: Create Rust Parser

**File:** `core/src/parser/languages/rust.rs` (new file)

```rust
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
                            });

                            // Extract methods from impl block
                            if let Some(body) = child.child_by_field_name("body") {
                                let mut impl_cursor = body.walk();
                                for impl_child in body.children(&mut impl_cursor) {
                                    if impl_child.kind() == "function_item" {
                                        if let Some(fn_name_node) = impl_child.child_by_field_name("name") {
                                            if let Some(fn_name) = self.extract_name(&fn_name_node, content) {
                                                symbols.push(Symbol {
                                                    name: fn_name,
                                                    kind: NodeKind::Method,
                                                    start_line: self.node_start_line(&impl_child),
                                                    end_line: self.node_end_line(&impl_child),
                                                    parent: Some(impl_name.clone()),
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
                            symbols.push(Symbol {
                                name,
                                kind: NodeKind::Function,
                                start_line: self.node_start_line(&child),
                                end_line: self.node_end_line(&child),
                                parent: None,
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
```

---

## Step 5: Update Language Module

**File:** `core/src/parser/languages/mod.rs`

Add these lines:

```rust
pub mod python;
pub mod typescript;
pub mod rust;
```

---

## Step 6: Update Directory Walker

**File:** `core/src/parser/walk.rs`

Import the new parsers at the top:

```rust
use crate::parser::languages::{
    python::PythonParser,
    typescript::TypeScriptParser,
    rust::RustParser,
    LanguageParser
};
```

Update the `process_file` method to handle new extensions:

```rust
fn process_file(
    &self,
    tree: &mut SymbolTree,
    entry: &DirEntry,
    parent_id: NodeId,
    path_to_node: &mut HashMap<PathBuf, NodeId>,
) -> anyhow::Result<()> {
    let path = entry.path();
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    if let Some(ref ext) = extension {
        match ext.as_str() {
            "py" => return self.process_python_file(tree, entry, parent_id, path_to_node),
            "ts" | "tsx" => return self.process_typescript_file(tree, entry, parent_id, path_to_node),
            "rs" => return self.process_rust_file(tree, entry, parent_id, path_to_node),
            _ => {}
        }
    }

    let name = entry.file_name().to_string_lossy().to_string();
    let path_str = path.to_string_lossy().to_string();
    let data = NodeData::new(0, name, NodeKind::File(extension.unwrap_or_default()), path_str);
    let node_id = tree.add_node(Some(parent_id), data);
    path_to_node.insert(path.to_path_buf(), node_id);

    Ok(())
}
```

Add the new processing methods (copy pattern from `process_python_file`):

```rust
fn process_typescript_file(
    &self,
    tree: &mut SymbolTree,
    entry: &DirEntry,
    parent_id: NodeId,
    path_to_node: &mut HashMap<PathBuf, NodeId>,
) -> anyhow::Result<()> {
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let path_str = path.to_string_lossy().to_string();
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "ts".to_string());

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Failed to read file {}: {}", path.display(), e);
            let data = NodeData::new(0, name, NodeKind::File(ext), path_str);
            let node_id = tree.add_node(Some(parent_id), data);
            path_to_node.insert(path.to_path_buf(), node_id);
            return Ok(());
        }
    };

    let line_count = content.lines().count() as u32;
    let file_data = NodeData::new(0, name, NodeKind::File(ext), path_str.clone())
        .with_lines(1, line_count.max(1));
    let file_id = tree.add_node(Some(parent_id), file_data);
    path_to_node.insert(path.to_path_buf(), file_id);

    let parser = TypeScriptParser::new();
    let symbols = parser.parse_file(&content, path);

    let mut parent_nodes: HashMap<String, NodeId> = HashMap::new();

    for symbol in symbols {
        let symbol_data = match symbol.kind {
            NodeKind::Class | NodeKind::Interface | NodeKind::Impl => {
                let data = NodeData::new(
                    0,
                    symbol.name.clone(),
                    symbol.kind,
                    path_str.clone(),
                )
                .with_lines(symbol.start_line, symbol.end_line);
                let node_id = tree.add_node(Some(file_id), data);
                parent_nodes.insert(symbol.name.clone(), node_id);
                continue;
            }
            NodeKind::Method => {
                NodeData::new(
                    0,
                    symbol.name.clone(),
                    NodeKind::Method,
                    path_str.clone(),
                )
                .with_lines(symbol.start_line, symbol.end_line)
            }
            _ => {
                NodeData::new(
                    0,
                    symbol.name.clone(),
                    symbol.kind,
                    path_str.clone(),
                )
                .with_lines(symbol.start_line, symbol.end_line)
            }
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
    entry: &DirEntry,
    parent_id: NodeId,
    path_to_node: &mut HashMap<PathBuf, NodeId>,
) -> anyhow::Result<()> {
    let path = entry.path();
    let name = entry.file_name().to_string_lossy().to_string();
    let path_str = path.to_string_lossy().to_string();

    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Failed to read file {}: {}", path.display(), e);
            let data = NodeData::new(0, name, NodeKind::File("rs".to_string()), path_str);
            let node_id = tree.add_node(Some(parent_id), data);
            path_to_node.insert(path.to_path_buf(), node_id);
            return Ok(());
        }
    };

    let line_count = content.lines().count() as u32;
    let file_data = NodeData::new(0, name, NodeKind::File("rs".to_string()), path_str.clone())
        .with_lines(1, line_count.max(1));
    let file_id = tree.add_node(Some(parent_id), file_data);
    path_to_node.insert(path.to_path_buf(), file_id);

    let parser = RustParser::new();
    let symbols = parser.parse_file(&content, path);

    let mut parent_nodes: HashMap<String, NodeId> = HashMap::new();

    for symbol in symbols {
        let symbol_data = match symbol.kind {
            NodeKind::Struct | NodeKind::Trait | NodeKind::Impl => {
                let data = NodeData::new(
                    0,
                    symbol.name.clone(),
                    symbol.kind,
                    path_str.clone(),
                )
                .with_lines(symbol.start_line, symbol.end_line);
                let node_id = tree.add_node(Some(file_id), data);
                parent_nodes.insert(symbol.name.clone(), node_id);
                continue;
            }
            NodeKind::Method => {
                NodeData::new(
                    0,
                    symbol.name.clone(),
                    NodeKind::Method,
                    path_str.clone(),
                )
                .with_lines(symbol.start_line, symbol.end_line)
            }
            _ => {
                NodeData::new(
                    0,
                    symbol.name.clone(),
                    symbol.kind,
                    path_str.clone(),
                )
                .with_lines(symbol.start_line, symbol.end_line)
            }
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
```

---

## Step 7: Build and Test

```bash
cd core
cargo build
cargo test
```

All existing tests should still pass, and the parser will now support TypeScript and Rust files!

---

## Testing the Implementation

Create test files to verify:

**test.ts:**

```typescript
interface User {
  name: string;
  email: string;
}

class UserService {
  findUser(id: number): User {
    return { name: "Test", email: "test@example.com" };
  }
}

const helper = () => "helper";
```

**test.rs:**

```rust
pub struct User {
    name: String,
    email: String,
}

impl User {
    pub fn new(name: String, email: String) -> Self {
        Self { name, email }
    }
}

pub fn helper() -> String {
    "helper".to_string()
}
```

Run: `cargo run --example parse_directory -- /path/to/test/files`

---

## Expected Output Structure

TypeScript file should show:

- Interface: User
- Class: UserService
  - Method: findUser
- Const: helper

Rust file should show:

- Struct: User
- Impl: User
  - Method: new
- Function: helper

---

## Troubleshooting

**Error: "Failed to load grammar"**

- Run `cargo clean && cargo build`
- Verify tree-sitter versions match (all 0.20)

**Symbols not appearing:**

- Check tree-sitter node types with the online playground
- Add debug logging to see what node kinds are being encountered
- Verify file extensions are lowercase in comparisons

**Methods not nested:**

- Ensure parent tracking is working in the walker
- Verify the parent HashMap is being populated correctly

---

## Next Steps

1. Add comprehensive tests for each language
2. Add JavaScript support (very similar to TypeScript)
3. Handle edge cases (empty files, syntax errors)
4. Consider adding more node types (variables, imports, etc.)
