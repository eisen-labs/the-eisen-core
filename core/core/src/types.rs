use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Action — the type of file access observed from ACP messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// User embedded file content in prompt (@mention)
    UserProvided,
    /// User sent resource_link in prompt
    UserReferenced,
    /// Agent read file (tool call or fs/read_text_file)
    Read,
    /// Agent wrote file (tool call or fs/write_text_file)
    Write,
    /// Agent searched (grep/glob — path is a directory)
    Search,
}

// ---------------------------------------------------------------------------
// FileNode — a tracked file in the graph
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub path: String,
    /// 0.0 to 1.0 — activity level, decayed over time
    pub heat: f32,
    /// Whether the file is inferred to still be in the agent's context window
    pub in_context: bool,
    /// Most recent action type
    pub last_action: Action,
    /// Last turn this file was accessed
    pub turn_accessed: u32,
    /// Wall-clock milliseconds (epoch) when this file was last accessed.
    /// Used by the orchestrator for LWW merge ordering across agents.
    pub timestamp_ms: u64,
}

// ---------------------------------------------------------------------------
// NodeUpdate — an update to a single file within a delta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeUpdate {
    pub path: String,
    pub heat: f32,
    pub in_context: bool,
    pub last_action: Action,
    pub turn_accessed: u32,
    /// Wall-clock milliseconds (epoch) when this event was recorded.
    pub timestamp_ms: u64,
}

// ---------------------------------------------------------------------------
// Wire messages: server -> client
// ---------------------------------------------------------------------------

/// Full state snapshot, sent on connect and on request_snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(rename = "type")]
    pub msg_type: String, // always "snapshot"
    pub agent_id: String,
    pub session_id: String,
    pub seq: u64,
    pub nodes: HashMap<String, FileNode>,
}

/// Incremental update — only changed nodes since last emission.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delta {
    #[serde(rename = "type")]
    pub msg_type: String, // always "delta"
    pub agent_id: String,
    pub session_id: String,
    pub seq: u64,
    pub updates: Vec<NodeUpdate>,
    pub removed: Vec<String>,
}

/// Token usage report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageMessage {
    #[serde(rename = "type")]
    pub msg_type: String, // always "usage"
    pub agent_id: String,
    pub session_id: String,
    pub used: u32,
    pub size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cost {
    pub amount: f64,
    pub currency: String,
}

// ---------------------------------------------------------------------------
// Wire messages: client -> server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ClientMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
}

// ---------------------------------------------------------------------------
// TrackerConfig — tuning knobs for the ContextTracker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TrackerConfig {
    /// Number of turns before a file exits context (default: 3)
    pub context_turns: u32,
    /// Usage drop ratio that signals compaction (default: 0.5)
    pub compaction_threshold: f32,
    /// Heat multiplier per tick for non-context files (default: 0.95)
    pub decay_rate: f32,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            context_turns: 3,
            compaction_threshold: 0.5,
            decay_rate: 0.95,
        }
    }
}

// ---------------------------------------------------------------------------
// Constructors for wire messages
// ---------------------------------------------------------------------------

impl Snapshot {
    pub fn new(
        agent_id: &str,
        session_id: &str,
        seq: u64,
        nodes: HashMap<String, FileNode>,
    ) -> Self {
        Self {
            msg_type: "snapshot".to_string(),
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
            seq,
            nodes,
        }
    }
}

impl Delta {
    pub fn new(
        agent_id: &str,
        session_id: &str,
        seq: u64,
        updates: Vec<NodeUpdate>,
        removed: Vec<String>,
    ) -> Self {
        Self {
            msg_type: "delta".to_string(),
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
            seq,
            updates,
            removed,
        }
    }
}

impl UsageMessage {
    pub fn new(agent_id: &str, session_id: &str, used: u32, size: u32, cost: Option<Cost>) -> Self {
        Self {
            msg_type: "usage".to_string(),
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
            used,
            size,
            cost,
        }
    }
}

impl FileNode {
    pub fn to_update(&self) -> NodeUpdate {
        NodeUpdate {
            path: self.path.clone(),
            heat: self.heat,
            in_context: self.in_context,
            last_action: self.last_action,
            turn_accessed: self.turn_accessed,
            timestamp_ms: self.timestamp_ms,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct InitParams {
    pub root_path: String,
}

// ---------------------------------------------------------------------------
// UI types — used by flatten.rs to produce graph snapshots for the webview
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct UiLineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<UiLineRange>,
    #[serde(rename = "lastWrite", skip_serializing_if = "Option::is_none")]
    pub last_write: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiCallEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiSnapshot {
    pub seq: u64,
    pub nodes: HashMap<String, UiNode>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub calls: Vec<UiCallEdge>,
}
