use eisen_core::parser::tree::SymbolTree;
use eisen_core::parser::types::{NodeData, NodeKind};

fn main() {
    // Create a tree manually
    let mut tree = SymbolTree::new();

    // Add root folder
    let root_data = NodeData::new(
        0,
        "myproject".to_string(),
        NodeKind::Folder,
        "/home/user/myproject".to_string(),
    );
    let root_id = tree.add_node(None, root_data);

    // Add a source folder
    let src_data = NodeData::new(
        1,
        "src".to_string(),
        NodeKind::Folder,
        "/home/user/myproject/src".to_string(),
    );
    let src_id = tree.add_node(Some(root_id), src_data);

    // Add a Python file
    let file_data = NodeData::new(
        2,
        "main.py".to_string(),
        NodeKind::File("py".to_string()),
        "/home/user/myproject/src/main.py".to_string(),
    )
    .with_lines(1, 100);
    let file_id = tree.add_node(Some(src_id), file_data);

    // Add a class
    let class_data = NodeData::new(
        3,
        "Calculator".to_string(),
        NodeKind::Class,
        "/home/user/myproject/src/main.py".to_string(),
    )
    .with_lines(5, 50);
    let class_id = tree.add_node(Some(file_id), class_data);

    // Add a method to the class
    let method_data = NodeData::new(
        4,
        "add".to_string(),
        NodeKind::Method,
        "/home/user/myproject/src/main.py".to_string(),
    )
    .with_lines(10, 15);
    tree.add_node(Some(class_id), method_data);

    // Add another method
    let method_data2 = NodeData::new(
        5,
        "subtract".to_string(),
        NodeKind::Method,
        "/home/user/myproject/src/main.py".to_string(),
    )
    .with_lines(17, 22);
    tree.add_node(Some(class_id), method_data2);

    // Add a standalone function
    let func_data = NodeData::new(
        6,
        "helper".to_string(),
        NodeKind::Function,
        "/home/user/myproject/src/main.py".to_string(),
    )
    .with_lines(52, 60);
    tree.add_node(Some(file_id), func_data);

    // Serialize to JSON
    let json = tree.to_nested_json();

    // Print it
    match serde_json::to_string_pretty(&json) {
        Ok(json_str) => {
            println!("Generated tree structure:");
            println!("{}", json_str);
        }
        Err(e) => eprintln!("Error: {}", e),
    }
}
