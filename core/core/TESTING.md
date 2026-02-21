# Testing Guide for Eisen Core Parser

## Quick Start

### 1. Build the Project
```bash
cd core
cargo build
```

### 2. Run Unit Tests
```bash
# Run all tests
cargo test

# Run tests with output visible
cargo test -- --nocapture

# Run specific test
cargo test test_python_parser_class_with_methods
```

### 3. Run Integration Tests
```bash
cargo test --test integration_tests -- --nocapture
```

### 4. Run Examples
```bash
# Example 1: Parse current directory
cargo run --example parse_directory

# Example 2: Parse specific directory
cargo run --example parse_directory -- /path/to/project

# Example 3: Manual tree construction
cargo run --example manual_tree
```

## Test Coverage

### Unit Tests (`src/parser/tests.rs`)

#### Node Types
- ✓ `test_node_kind_serialization` - Verifies JSON serialization matches TypeScript types
- ✓ `test_node_data_creation` - Tests NodeData builder
- ✓ `test_node_data_with_lines` - Tests line range setting
- ✓ `test_node_kind_helpers` - Tests is_file() and language() helpers

#### SymbolTree CRUD Operations
- ✓ `test_symbol_tree_new` - Creates empty tree
- ✓ `test_symbol_tree_add_node` - Adds nodes with parent relationships
- ✓ `test_symbol_tree_get_node` - Retrieves nodes by ID
- ✓ `test_symbol_tree_update_node` - Updates existing nodes
- ✓ `test_symbol_tree_delete_node` - Deletes nodes
- ✓ `test_symbol_tree_delete_node_with_children` - Cascading delete
- ✓ `test_symbol_tree_find_by_path` - Finds nodes by path string

#### Python Parser
- ✓ `test_python_parser_can_parse` - Extension matching
- ✓ `test_python_parser_empty_file` - Empty file handling
- ✓ `test_python_parser_simple_function` - Basic function parsing
- ✓ `test_python_parser_simple_class` - Basic class parsing
- ✓ `test_python_parser_class_with_methods` - Class + method detection
- ✓ `test_python_parser_mixed_symbols` - Functions, classes, methods
- ✓ `test_python_parser_line_numbers` - Correct line range extraction
- ✓ `test_python_parser_error_handling` - Invalid syntax handling

#### Directory Walker
- ✓ `test_directory_walker_ignores` - Ignores .git, __pycache__, etc.
- ✓ `test_directory_walker_python_parsing` - Full directory parsing
- ✓ `test_walker_handles_unreadable_files` - Binary file handling

#### Serialization
- ✓ `test_serialization_nested_json` - Nested structure output
- ✓ `test_serialization_flat_json` - Flat array output

#### Full Integration
- ✓ `test_init_tree` - End-to-end directory parsing

### Integration Tests (`tests/integration_tests.rs`)

#### Real-World Scenarios
- ✓ `integration_full_workflow` - Complete Python project with:
  - Package structure (__init__.py files)
  - Multiple modules (models, services)
  - Class inheritance
  - Test files
  - Nested directories
  
- ✓ `integration_empty_project` - Empty directory handling
- ✓ `integration_single_file` - Single file project

## Example Output

### Input: Python File
```python
class Calculator:
    def __init__(self):
        self.value = 0
    
    def add(self, x):
        self.value += x
        return self

def helper():
    return 42
```

### Output: JSON Structure
```json
{
  "id": 0,
  "name": "project",
  "kind": "folder",
  "startLine": 0,
  "endLine": 0,
  "path": "/project",
  "children": [
    {
      "id": 1,
      "name": "main.py",
      "kind": "file",
      "language": "py",
      "startLine": 1,
      "endLine": 12,
      "path": "/project/main.py",
      "children": [
        {
          "id": 2,
          "name": "Calculator",
          "kind": "class",
          "startLine": 1,
          "endLine": 7,
          "path": "/project/main.py",
          "children": [
            {
              "id": 3,
              "name": "__init__",
              "kind": "method",
              "startLine": 2,
              "endLine": 3,
              "path": "/project/main.py"
            },
            {
              "id": 4,
              "name": "add",
              "kind": "method",
              "startLine": 5,
              "endLine": 7,
              "path": "/project/main.py"
            }
          ]
        },
        {
          "id": 5,
          "name": "helper",
          "kind": "function",
          "startLine": 9,
          "endLine": 10,
          "path": "/project/main.py"
        }
      ]
    }
  ]
}
```

## Manual Testing via RPC

Start the core:
```bash
cd core
cargo run
```

Send a parse_tree request:
```bash
echo '{"id":1,"method":"parse_tree","params":{"root_path":"."}}' | cargo run
```

Expected response:
```json
{"id":1,"result":{...tree structure...}}
```

## Debugging Tips

### Enable Debug Output
```bash
RUST_LOG=debug cargo test -- --nocapture
```

### Print Tree Structure
```rust
let tree = SymbolTree::init_tree(path).unwrap();
let json = tree.to_nested_json();
println!("{}", serde_json::to_string_pretty(&json).unwrap());
```

### Check Node Count
```rust
let count = tree.arena().iter().count();
println!("Total nodes: {}", count);
```

## Performance Testing

Test with large projects:
```bash
# Time the parsing
time cargo run --example parse_directory -- /path/to/large/project

# Profile with release mode
cargo build --release
time ./target/release/examples/parse_directory /path/to/project
```

## Common Issues

### Issue: Tree-sitter grammar not found
**Solution**: Ensure `tree-sitter-python` is in Cargo.toml and run `cargo build`

### Issue: Permission denied on directory
**Solution**: The walker skips unreadable files - check file permissions

### Issue: Empty tree returned
**Solution**: Verify the directory exists and contains supported files (.py)

### Issue: Methods not detected
**Solution**: Ensure functions are indented inside class bodies (tree-sitter requirement)
