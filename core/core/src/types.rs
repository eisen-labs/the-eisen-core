use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// Agent attempted out-of-zone file access (blocked by proxy)
    Blocked,
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
// Zone configuration — blocker zone enforcement (Phase 3)
// ---------------------------------------------------------------------------

/// Zone configuration for agent file access enforcement.
///
/// When a zone is configured, the proxy blocks file reads/writes outside
/// the allowed patterns. Denied patterns take priority over allowed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneConfig {
    /// Glob patterns for allowed paths (e.g., ["src/ui/**", "shared/**"])
    pub allowed: Vec<String>,
    /// Glob patterns for explicitly denied paths (e.g., ["**/.env"])
    pub denied: Vec<String>,
}

impl ZoneConfig {
    /// Create a new ZoneConfig with allowed patterns only.
    pub fn new(allowed: Vec<String>) -> Self {
        Self {
            allowed,
            denied: Vec::new(),
        }
    }

    /// Check if a path is permitted under this zone configuration.
    ///
    /// A path is allowed if:
    /// 1. It matches at least one allowed pattern, AND
    /// 2. It does NOT match any denied pattern (denied overrides allowed)
    ///
    /// Paths are matched against glob patterns using a simple glob matcher.
    /// Both the path and patterns are compared after stripping any leading `/`.
    pub fn is_allowed(&self, path: &str) -> bool {
        let normalized = path.strip_prefix('/').unwrap_or(path);

        // Denied patterns take priority
        for pattern in &self.denied {
            let pat = pattern.strip_prefix('/').unwrap_or(pattern);
            if glob_match(pat, normalized) {
                return false;
            }
        }

        // Must match at least one allowed pattern
        for pattern in &self.allowed {
            let pat = pattern.strip_prefix('/').unwrap_or(pattern);
            if glob_match(pat, normalized) {
                return true;
            }
        }

        false
    }
}

/// Simple glob matching supporting `*` (single segment) and `**` (any depth).
///
/// This is a minimal implementation sufficient for workspace path matching.
/// Supports patterns like:
///   - `src/ui/**`       matches `src/ui/foo.ts`, `src/ui/sub/bar.tsx`
///   - `*.config.js`     matches `eslint.config.js`
///   - `package.json`    matches `package.json` exactly
///   - `**/.env`         matches `.env`, `sub/.env`, `a/b/.env`
fn glob_match(pattern: &str, path: &str) -> bool {
    glob_match_impl(
        &pattern.split('/').collect::<Vec<_>>(),
        &path.split('/').collect::<Vec<_>>(),
    )
}

fn glob_match_impl(pattern_parts: &[&str], path_parts: &[&str]) -> bool {
    if pattern_parts.is_empty() {
        return path_parts.is_empty();
    }

    let pat = pattern_parts[0];

    if pat == "**" {
        // "**" can match zero or more path segments
        // Try matching remaining pattern against every suffix of the path
        for i in 0..=path_parts.len() {
            if glob_match_impl(&pattern_parts[1..], &path_parts[i..]) {
                return true;
            }
        }
        return false;
    }

    if path_parts.is_empty() {
        return false;
    }

    // Match single segment (supports `*` as wildcard within segment)
    if segment_match(pat, path_parts[0]) {
        glob_match_impl(&pattern_parts[1..], &path_parts[1..])
    } else {
        false
    }
}

/// Match a single path segment against a pattern segment.
/// Supports `*` as a wildcard matching any characters within the segment.
fn segment_match(pattern: &str, segment: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return pattern == segment;
    }

    // Split pattern by '*' and match parts
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut pos = 0;

    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if let Some(found) = segment[pos..].find(part) {
            if i == 0 && found != 0 {
                // First part must match at the start
                return false;
            }
            pos += found + part.len();
        } else {
            return false;
        }
    }

    // If pattern doesn't end with *, remaining segment must be consumed
    if !pattern.ends_with('*') {
        return pos == segment.len();
    }

    true
}

// ---------------------------------------------------------------------------
// BlockedAccess — wire message for out-of-zone access attempts
// ---------------------------------------------------------------------------

/// Notification broadcast when the proxy blocks an out-of-zone file access.
///
/// Sent over TCP so the orchestrator (Python) can detect blocked attempts
/// and route them through the A2A router.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockedAccess {
    #[serde(rename = "type")]
    pub msg_type: String, // always "blocked"
    pub agent_id: String,
    pub session_id: String,
    pub path: String,
    /// "read" or "write"
    pub action: String,
    pub timestamp_ms: u64,
}

impl BlockedAccess {
    pub fn new(agent_id: &str, session_id: &str, path: &str, action: &str) -> Self {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Self {
            msg_type: "blocked".to_string(),
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
            path: path.to_string(),
            action: action.to_string(),
            timestamp_ms: ts,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u32>,
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
