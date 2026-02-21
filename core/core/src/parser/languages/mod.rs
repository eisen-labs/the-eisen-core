pub mod python;
pub mod rust;
pub mod typescript;

use std::path::Path;

use crate::parser::types::NodeKind;

#[derive(Debug, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: NodeKind,
    pub start_line: u32,
    pub end_line: u32,
    pub parent: Option<String>,
    pub calls: Vec<String>,
}

pub trait LanguageParser: Send + Sync {
    fn can_parse(&self, extension: &str) -> bool;
    fn parse_file(&self, content: &str, path: &Path) -> Vec<Symbol>;
}
