#[cfg(test)]
mod tests {
    use crate::parser::languages::python::PythonParser;
    use crate::parser::languages::LanguageParser;
    use crate::parser::tree::SymbolTree;
    use crate::parser::types::{NodeData, NodeKind};
    use crate::parser::walk::DirectoryWalker;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn test_node_kind_serialization() {
        let folder = NodeKind::Folder;
        let file = NodeKind::File("py".to_string());
        let class = NodeKind::Class;
        let method = NodeKind::Method;
        let function = NodeKind::Function;

        assert_eq!(serde_json::to_string(&folder).unwrap(), "\"folder\"");
        assert_eq!(serde_json::to_string(&file).unwrap(), "\"file\"");
        assert_eq!(serde_json::to_string(&class).unwrap(), "\"class\"");
        assert_eq!(serde_json::to_string(&method).unwrap(), "\"method\"");
        assert_eq!(serde_json::to_string(&function).unwrap(), "\"function\"");
    }

    #[test]
    fn test_node_data_creation() {
        let data = NodeData::new(
            1,
            "main.py".to_string(),
            NodeKind::File("py".to_string()),
            "/project/main.py".to_string(),
        );

        assert_eq!(data.id, 1);
        assert_eq!(data.name, "main.py");
        assert_eq!(data.language, Some("py".to_string()));
        assert_eq!(data.path, "/project/main.py");
        assert_eq!(data.start_line, 0);
        assert_eq!(data.end_line, 0);
    }

    #[test]
    fn test_node_data_with_lines() {
        let data = NodeData::new(
            1,
            "MyClass".to_string(),
            NodeKind::Class,
            "/project/main.py".to_string(),
        )
        .with_lines(10, 50);

        assert_eq!(data.start_line, 10);
        assert_eq!(data.end_line, 50);
    }

    #[test]
    fn test_symbol_tree_new() {
        let tree = SymbolTree::new();
        assert!(tree.root().is_none());
    }

    #[test]
    fn test_symbol_tree_add_node() {
        let mut tree = SymbolTree::new();

        // Add root
        let root_data = NodeData::new(
            0,
            "project".to_string(),
            NodeKind::Folder,
            "/project".to_string(),
        );
        let root_id = tree.add_node(None, root_data);

        assert!(tree.root().is_some());
        assert_eq!(tree.root(), Some(root_id));

        // Add child
        let file_data = NodeData::new(
            1,
            "main.py".to_string(),
            NodeKind::File("py".to_string()),
            "/project/main.py".to_string(),
        );
        let file_id = tree.add_node(Some(root_id), file_data);

        let children = tree.get_children(root_id);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0], file_id);
    }

    #[test]
    fn test_symbol_tree_get_node() {
        let mut tree = SymbolTree::new();
        let data = NodeData::new(0, "test".to_string(), NodeKind::Folder, "/test".to_string());
        let node_id = tree.add_node(None, data);

        let retrieved = tree.get_node(node_id).unwrap();
        assert_eq!(retrieved.name, "test");
    }

    #[test]
    fn test_symbol_tree_update_node() {
        let mut tree = SymbolTree::new();
        let data = NodeData::new(
            0,
            "old_name".to_string(),
            NodeKind::Folder,
            "/test".to_string(),
        );
        let node_id = tree.add_node(None, data);

        let new_data = NodeData::new(
            0,
            "new_name".to_string(),
            NodeKind::Folder,
            "/test".to_string(),
        );
        tree.update_node(node_id, new_data).unwrap();

        let retrieved = tree.get_node(node_id).unwrap();
        assert_eq!(retrieved.name, "new_name");
    }

    #[test]
    fn test_symbol_tree_delete_node() {
        let mut tree = SymbolTree::new();
        let data = NodeData::new(0, "test".to_string(), NodeKind::Folder, "/test".to_string());
        let node_id = tree.add_node(None, data);

        tree.delete_node(node_id).unwrap();
        // Can't call get_node on deleted node - NodeId is invalid after remove_subtree
        // Verify by checking root is cleared and path lookup fails
        assert!(tree.root().is_none());
        assert!(tree.find_by_path("/test").is_none());
    }

    #[test]
    fn test_symbol_tree_delete_node_with_children() {
        let mut tree = SymbolTree::new();

        // Create hierarchy: root -> child -> grandchild
        let root_data = NodeData::new(0, "root".to_string(), NodeKind::Folder, "/root".to_string());
        let root_id = tree.add_node(None, root_data);

        let child_data = NodeData::new(
            1,
            "child".to_string(),
            NodeKind::Folder,
            "/root/child".to_string(),
        );
        let child_id = tree.add_node(Some(root_id), child_data);

        let grandchild_data = NodeData::new(
            2,
            "grandchild".to_string(),
            NodeKind::File("py".to_string()),
            "/root/child/file.py".to_string(),
        );
        let _grandchild_id = tree.add_node(Some(child_id), grandchild_data);

        // Delete child (should also delete grandchild)
        tree.delete_node(child_id).unwrap();

        // Can't call get_node on deleted nodes - verify deletion via path lookup and parent check
        assert!(tree.find_by_path("/root/child").is_none());
        assert!(tree.find_by_path("/root/child/file.py").is_none());
        assert!(tree.get_node(root_id).is_some()); // Root should still exist
        assert_eq!(tree.get_children(root_id).len(), 0); // Root should have no children
    }

    #[test]
    fn test_symbol_tree_find_by_path() {
        let mut tree = SymbolTree::new();
        let data = NodeData::new(
            0,
            "test".to_string(),
            NodeKind::Folder,
            "/project/test".to_string(),
        );
        let node_id = tree.add_node(None, data);

        let found = tree.find_by_path("/project/test");
        assert_eq!(found, Some(node_id));

        let not_found = tree.find_by_path("/nonexistent");
        assert!(not_found.is_none());
    }

    #[test]
    fn test_python_parser_can_parse() {
        let parser = PythonParser::new();
        assert!(parser.can_parse("py"));
        assert!(parser.can_parse("PY"));
        assert!(!parser.can_parse("rs"));
        assert!(!parser.can_parse("js"));
    }

    #[test]
    fn test_python_parser_empty_file() {
        let parser = PythonParser::new();
        let code = "";
        let symbols = parser.parse_file(code, Path::new("test.py"));
        assert!(symbols.is_empty());
    }

    #[test]
    fn test_python_parser_simple_function() {
        let parser = PythonParser::new();
        let code = r#"
def hello():
    pass
"#;
        let symbols = parser.parse_file(code, Path::new("test.py"));

        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "hello");
        assert!(matches!(symbols[0].kind, NodeKind::Function));
        assert_eq!(symbols[0].start_line, 2);
        assert_eq!(symbols[0].end_line, 3);
    }

    #[test]
    fn test_python_parser_simple_class() {
        let parser = PythonParser::new();
        let code = r#"
class MyClass:
    pass
"#;
        let symbols = parser.parse_file(code, Path::new("test.py"));

        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "MyClass");
        assert!(matches!(symbols[0].kind, NodeKind::Class));
    }

    #[test]
    fn test_python_parser_class_with_methods() {
        let parser = PythonParser::new();
        let code = r#"
class Calculator:
    def __init__(self):
        self.value = 0
    
    def add(self, x):
        self.value += x
        return self
    
    def get_value(self):
        return self.value
"#;
        let symbols = parser.parse_file(code, Path::new("test.py"));

        assert_eq!(symbols.len(), 4); // 1 class + 3 methods

        let class = symbols.iter().find(|s| s.name == "Calculator").unwrap();
        assert!(matches!(class.kind, NodeKind::Class));

        let init = symbols.iter().find(|s| s.name == "__init__").unwrap();
        assert!(matches!(init.kind, NodeKind::Method));
        assert_eq!(init.parent, Some("Calculator".to_string()));

        let add = symbols.iter().find(|s| s.name == "add").unwrap();
        assert!(matches!(add.kind, NodeKind::Method));

        let get_value = symbols.iter().find(|s| s.name == "get_value").unwrap();
        assert!(matches!(get_value.kind, NodeKind::Method));
    }

    #[test]
    fn test_python_parser_mixed_symbols() {
        let parser = PythonParser::new();
        let code = r#"
def standalone_function():
    pass

class MyClass:
    def method1(self):
        pass
    
    def method2(self):
        pass

def another_function():
    pass
"#;
        let symbols = parser.parse_file(code, Path::new("test.py"));

        assert_eq!(symbols.len(), 5); // 2 standalone functions + 1 class + 2 methods

        let standalone = symbols
            .iter()
            .filter(|s| matches!(s.kind, NodeKind::Function))
            .count();
        assert_eq!(standalone, 2);

        let methods = symbols
            .iter()
            .filter(|s| matches!(s.kind, NodeKind::Method))
            .count();
        assert_eq!(methods, 2);

        let classes = symbols
            .iter()
            .filter(|s| matches!(s.kind, NodeKind::Class))
            .count();
        assert_eq!(classes, 1);
    }

    #[test]
    fn test_python_parser_line_numbers() {
        let parser = PythonParser::new();
        let code = r#"
# Line 1 - comment
# Line 2 - comment

class MyClass:
    # Line 5 - inside class
    def method(self):
        pass

# Line 9 - after class
"#;
        let symbols = parser.parse_file(code, Path::new("test.py"));

        let class = symbols.iter().find(|s| s.name == "MyClass").unwrap();
        assert_eq!(class.start_line, 5);
        assert_eq!(class.end_line, 8);

        let method = symbols.iter().find(|s| s.name == "method").unwrap();
        assert_eq!(method.start_line, 7);
        assert_eq!(method.end_line, 8);
    }

    #[test]
    fn test_directory_walker_ignores() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();

        // Create directory structure
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join(".git")).unwrap();
        fs::create_dir(root.join("__pycache__")).unwrap();
        fs::create_dir(root.join("target")).unwrap();

        // Create files - use proper path joining
        fs::write(root.join("src").join("main.py"), "def foo(): pass").unwrap();
        fs::write(root.join("src").join("__init__.py"), "").unwrap();
        fs::write(root.join(".git").join("config"), "").unwrap();
        fs::write(root.join("__pycache__").join("cache.pyc"), "").unwrap();
        fs::write(root.join("README.md"), "# Test").unwrap();

        let mut tree = SymbolTree::new();
        let walker = DirectoryWalker::new(root);
        walker.walk_and_build(&mut tree).unwrap();

        // Verify tree was built
        assert!(tree.root().is_some());

        // Verify .git was ignored (won't be in tree)
        let git_path = root.join(".git").to_string_lossy().to_string();
        assert!(tree.find_by_path(&git_path).is_none());

        // Verify __pycache__ was ignored
        let pycache_path = root.join("__pycache__").to_string_lossy().to_string();
        assert!(tree.find_by_path(&pycache_path).is_none());

        // Verify src was included
        let src_path = root.join("src").to_string_lossy().to_string();
        assert!(tree.find_by_path(&src_path).is_some());

        // Verify main.py was included - use proper path joining
        let main_path = root
            .join("src")
            .join("main.py")
            .to_string_lossy()
            .to_string();
        assert!(tree.find_by_path(&main_path).is_some());
    }

    #[test]
    fn test_directory_walker_python_parsing() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();

        // Create a Python file with classes and functions
        fs::create_dir(root.join("src")).unwrap();
        fs::write(
            root.join("src").join("main.py"),
            r#"
class Calculator:
    def add(self, x, y):
        return x + y

def helper():
    return 42
"#,
        )
        .unwrap();

        let mut tree = SymbolTree::new();
        let walker = DirectoryWalker::new(root);
        walker.walk_and_build(&mut tree).unwrap();

        // Find main.py - use proper path joining
        let main_path = root
            .join("src")
            .join("main.py")
            .to_string_lossy()
            .to_string();
        let main_id = tree.find_by_path(&main_path).unwrap();

        // Check that file has children (parsed symbols)
        let children = tree.get_children(main_id);
        assert_eq!(children.len(), 2); // 1 class + 1 function

        // Verify Calculator class exists
        let calculator = children
            .iter()
            .map(|&id| tree.get_node(id).unwrap())
            .find(|n| n.name == "Calculator");
        assert!(calculator.is_some());
        assert!(matches!(calculator.unwrap().kind, NodeKind::Class));

        // Verify helper function exists
        let helper = children
            .iter()
            .map(|&id| tree.get_node(id).unwrap())
            .find(|n| n.name == "helper");
        assert!(helper.is_some());
        assert!(matches!(helper.unwrap().kind, NodeKind::Function));

        // Verify method exists as child of class
        let calculator_id = children
            .iter()
            .find(|&&id| tree.get_node(id).unwrap().name == "Calculator")
            .copied()
            .unwrap();
        let class_children = tree.get_children(calculator_id);
        assert_eq!(class_children.len(), 1);

        let method = tree.get_node(class_children[0]).unwrap();
        assert_eq!(method.name, "add");
        assert!(matches!(method.kind, NodeKind::Method));
    }

    #[test]
    fn test_serialization_nested_json() {
        let mut tree = SymbolTree::new();

        let root_data = NodeData::new(
            0,
            "project".to_string(),
            NodeKind::Folder,
            "/project".to_string(),
        );
        let root_id = tree.add_node(None, root_data);

        let file_data = NodeData::new(
            1,
            "main.py".to_string(),
            NodeKind::File("py".to_string()),
            "/project/main.py".to_string(),
        )
        .with_lines(1, 10);
        let file_id = tree.add_node(Some(root_id), file_data);

        let class_data = NodeData::new(
            2,
            "MyClass".to_string(),
            NodeKind::Class,
            "/project/main.py".to_string(),
        )
        .with_lines(2, 9);
        tree.add_node(Some(file_id), class_data);

        let json = tree.to_nested_json();

        // Verify structure
        assert!(json.is_object());
        assert_eq!(json["name"], "project");
        assert_eq!(json["kind"], "folder");
        assert!(json["children"].is_array());
        assert_eq!(json["children"].as_array().unwrap().len(), 1);

        let file = &json["children"][0];
        assert_eq!(file["name"], "main.py");
        assert_eq!(file["kind"], "file");
        assert_eq!(file["language"], "py");
        assert_eq!(file["startLine"], 1);
        assert_eq!(file["endLine"], 10);
        assert!(file["children"].is_array());

        let class = &file["children"][0];
        assert_eq!(class["name"], "MyClass");
        assert_eq!(class["kind"], "class");
        assert_eq!(class["startLine"], 2);
        assert_eq!(class["endLine"], 9);
    }

    #[test]
    fn test_init_tree() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();

        // Create test structure
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/main.py"), "def foo(): pass").unwrap();
        fs::write(root.join("README.md"), "# Test").unwrap();

        let tree = SymbolTree::init_tree(root).unwrap();

        assert!(tree.root().is_some());

        let root_node = tree.get_node(tree.root().unwrap()).unwrap();
        assert!(matches!(root_node.kind, NodeKind::Folder));

        // Should have children (src, README.md)
        let root_children = tree.get_children(tree.root().unwrap());
        assert!(!root_children.is_empty());
    }

    #[test]
    fn test_node_kind_helpers() {
        let file = NodeKind::File("py".to_string());
        let folder = NodeKind::Folder;

        assert!(file.is_file());
        assert!(!folder.is_file());

        assert_eq!(file.language(), Some("py"));
        assert_eq!(folder.language(), None);
    }

    #[test]
    fn test_python_parser_error_handling() {
        let parser = PythonParser::new();
        // Invalid Python syntax should still not crash
        let code = "def broken():";
        let _symbols = parser.parse_file(code, Path::new("test.py"));
        // Tree-sitter might parse partial results or return empty
        // The important thing is it doesn't panic
    }

    #[test]
    fn test_walker_handles_unreadable_files() {
        let temp_dir = TempDir::new().unwrap();
        let root = temp_dir.path();

        fs::write(root.join("valid.py"), "def foo(): pass").unwrap();
        // Create a file with invalid UTF-8 (binary)
        fs::write(root.join("binary.dat"), vec![0x80, 0x81, 0x82]).unwrap();

        let mut tree = SymbolTree::new();
        let walker = DirectoryWalker::new(root);
        // Should not panic on binary file
        walker.walk_and_build(&mut tree).unwrap();

        assert!(tree.root().is_some());
    }
}
