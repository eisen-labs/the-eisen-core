use eisen_core::parser::tree::SymbolTree;
use std::path::Path;

fn main() {
    // Example 1: Parse a directory
    let args: Vec<String> = std::env::args().collect();
    let root_path = args.get(1).map(|s| s.as_str()).unwrap_or(".");
    
    println!("Parsing directory: {}", root_path);
    
    match SymbolTree::init_tree(Path::new(root_path)) {
        Ok(tree) => {
            // Convert to nested JSON
            let json = tree.to_nested_json();
            
            // Print as pretty JSON
            match serde_json::to_string_pretty(&json) {
                Ok(json_str) => println!("{}", json_str),
                Err(e) => eprintln!("Failed to serialize: {}", e),
            }
        }
        Err(e) => {
            eprintln!("Error parsing directory: {}", e);
            std::process::exit(1);
        }
    }
}
