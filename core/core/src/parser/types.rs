use serde::{Deserialize, Serialize};

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

impl Serialize for NodeKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl NodeKind {
    pub fn as_str(&self) -> &str {
        match self {
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
        }
    }

    pub fn is_file(&self) -> bool {
        matches!(self, NodeKind::File(_))
    }

    pub fn language(&self) -> Option<&str> {
        match self {
            NodeKind::File(ext) => Some(ext.as_str()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeData {
    pub id: usize,
    pub name: String,
    #[serde(rename = "kind")]
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(rename = "startLine")]
    pub start_line: u32,
    #[serde(rename = "endLine")]
    pub end_line: u32,
    pub path: String,
    #[serde(skip)]
    pub calls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u32>,
}

impl NodeData {
    pub fn new(id: usize, name: String, kind: NodeKind, path: String) -> Self {
        let language = match &kind {
            NodeKind::File(ext) => Some(ext.clone()),
            _ => None,
        };

        Self {
            id,
            name,
            kind,
            language,
            start_line: 0,
            end_line: 0,
            path,
            calls: Vec::new(),
            tokens: None,
        }
    }

    pub fn with_lines(mut self, start: u32, end: u32) -> Self {
        self.start_line = start;
        self.end_line = end;
        self
    }

    pub fn with_calls(mut self, calls: Vec<String>) -> Self {
        self.calls = calls;
        self
    }

    pub fn with_tokens(mut self, tokens: u32) -> Self {
        self.tokens = Some(tokens);
        self
    }
}
