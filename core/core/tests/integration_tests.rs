use eisen_core::parser::tree::SymbolTree;
use eisen_core::parser::types::NodeKind;
use std::fs;
use tempfile::TempDir;

#[test]
fn integration_full_workflow() {
    // Create a realistic Python project
    let temp_dir = TempDir::new().unwrap();
    let project_root = temp_dir.path();

    // Create project structure
    fs::create_dir_all(project_root.join("src/models")).unwrap();
    fs::create_dir_all(project_root.join("src/services")).unwrap();
    fs::create_dir_all(project_root.join("tests")).unwrap();

    // Create main module
    fs::write(
        project_root.join("src/__init__.py"),
        r#"""Main package initialization."""
"#,
    )
    .unwrap();

    // Create models
    fs::write(
        project_root.join("src/models/__init__.py"),
        r#"""Models package."""
"#,
    )
    .unwrap();

    fs::write(
        project_root.join("src/models/user.py"),
        r#"
class User:
    def __init__(self, name, email):
        self.name = name
        self.email = email
    
    def validate(self):
        return bool(self.name and self.email)
    
    def to_dict(self):
        return {"name": self.name, "email": self.email}

class AdminUser(User):
    def __init__(self, name, email, permissions):
        super().__init__(name, email)
        self.permissions = permissions
    
    def has_permission(self, perm):
        return perm in self.permissions
"#,
    )
    .unwrap();

    // Create services
    fs::write(
        project_root.join("src/services/__init__.py"),
        r#"""Services package."""
"#,
    )
    .unwrap();

    fs::write(
        project_root.join("src/services/auth.py"),
        r#"
def authenticate(username, password):
    # TODO: Implement authentication
    return True

def logout(user):
    pass

class AuthService:
    def __init__(self, db):
        self.db = db
    
    def login(self, username, password):
        if authenticate(username, password):
            return self.create_session(username)
        return None
    
    def create_session(self, username):
        return {"user": username, "token": "abc123"}
    
    def validate_token(self, token):
        return token == "abc123"
"#,
    )
    .unwrap();

    // Create main entry point
    fs::write(
        project_root.join("src/main.py"),
        r#"
from models.user import User
from services.auth import AuthService

def main():
    user = User("John", "john@example.com")
    auth = AuthService(None)
    print(f"User: {user.name}")

if __name__ == "__main__":
    main()
"#,
    )
    .unwrap();

    // Create test file
    fs::write(
        project_root.join("tests/test_user.py"),
        r#"
import unittest
from src.models.user import User, AdminUser

class TestUser(unittest.TestCase):
    def setUp(self):
        self.user = User("Test", "test@example.com")
    
    def test_validation(self):
        self.assertTrue(self.user.validate())
    
    def test_to_dict(self):
        d = self.user.to_dict()
        self.assertEqual(d["name"], "Test")

def test_helper():
    """Standalone test function."""
    user = User("Helper", "helper@test.com")
    assert user.validate()
"#,
    )
    .unwrap();

    // Parse the tree
    let tree = SymbolTree::init_tree(project_root).expect("Failed to parse tree");

    // Verify root exists
    let root = tree.root().expect("Root should exist");
    let root_node = tree.get_node(root).unwrap();
    assert!(matches!(root_node.kind, NodeKind::Folder));

    // Serialize to JSON
    let json = tree.to_nested_json();
    let json_str = serde_json::to_string_pretty(&json).unwrap();

    // Print for inspection
    println!("Generated JSON structure:\n{}", json_str);

    // Verify JSON structure
    assert!(json.is_object());
    assert_eq!(json["kind"], "folder");

    // Find src folder
    let src = json["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "src")
        .expect("src folder should exist");

    // Find user.py and verify it has classes
    let user_py = src["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "models")
        .and_then(|models| models["children"].as_array())
        .and_then(|children: &Vec<serde_json::Value>| {
            children.iter().find(|c| c["name"] == "user.py")
        })
        .expect("user.py should exist");

    assert_eq!(user_py["kind"], "file");
    assert_eq!(user_py["language"], "py");

    // Verify User class exists
    let user_class = user_py["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "User")
        .expect("User class should exist");

    assert_eq!(user_class["kind"], "class");

    // Verify methods exist
    let methods: Vec<_> = user_class["children"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "method")
        .map(|c| c["name"].as_str().unwrap())
        .collect();

    assert!(methods.contains(&"__init__"));
    assert!(methods.contains(&"validate"));
    assert!(methods.contains(&"to_dict"));

    // Verify AdminUser class exists
    let admin_class = user_py["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "AdminUser")
        .expect("AdminUser class should exist");

    assert_eq!(admin_class["kind"], "class");

    // Verify auth.py has both classes and functions
    let auth_py = src["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "services")
        .and_then(|services| services["children"].as_array())
        .and_then(|children: &Vec<serde_json::Value>| {
            children.iter().find(|c| c["name"] == "auth.py")
        })
        .expect("auth.py should exist");

    // Should have authenticate and logout as functions
    let auth_functions: Vec<_> = auth_py["children"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "function")
        .map(|c| c["name"].as_str().unwrap())
        .collect();

    assert!(auth_functions.contains(&"authenticate"));
    assert!(auth_functions.contains(&"logout"));

    // Should have AuthService as class
    let auth_service = auth_py["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "AuthService")
        .expect("AuthService should exist");

    assert_eq!(auth_service["kind"], "class");

    // Verify AuthService has methods
    let service_methods: Vec<_> = auth_service["children"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "method")
        .map(|c| c["name"].as_str().unwrap())
        .collect();

    assert!(service_methods.contains(&"__init__"));
    assert!(service_methods.contains(&"login"));
    assert!(service_methods.contains(&"create_session"));
    assert!(service_methods.contains(&"validate_token"));

    // Verify tests folder
    let tests = json["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "tests")
        .expect("tests folder should exist");

    let test_file = tests["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "test_user.py")
        .expect("test_user.py should exist");

    // Verify TestUser class exists
    let test_class = test_file["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "TestUser")
        .expect("TestUser class should exist");

    assert_eq!(test_class["kind"], "class");

    // Verify standalone test function
    let test_helper = test_file["children"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "test_helper")
        .expect("test_helper should exist");

    assert_eq!(test_helper["kind"], "function");
}

#[test]
fn integration_empty_project() {
    let temp_dir = TempDir::new().unwrap();
    let tree = SymbolTree::init_tree(temp_dir.path()).unwrap();

    let root = tree.root().expect("Should have root");
    let root_node = tree.get_node(root).unwrap();
    assert!(matches!(root_node.kind, NodeKind::Folder));
}

#[test]
fn integration_single_file() {
    let temp_dir = TempDir::new().unwrap();
    let root = temp_dir.path();

    fs::write(root.join("script.py"), "def hello():\n    print('Hello')\n").unwrap();

    let tree = SymbolTree::init_tree(root).unwrap();
    let json = tree.to_nested_json();

    assert_eq!(json["children"].as_array().unwrap().len(), 1);
    assert_eq!(json["children"][0]["name"], "script.py");
}
