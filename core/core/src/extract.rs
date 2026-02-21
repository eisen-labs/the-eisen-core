//! Context extraction from ACP JSON-RPC messages using typed schema types.
//!
//! Parses each ndJSON line, checks the `method` field against known ACP methods,
//! then deserializes `params` into the corresponding typed struct from
//! `agent-client-protocol-schema`. Extracted file paths are fed to the
//! `ContextTracker`.
//!
//! ## Channels Covered
//!
//! | # | Method                | Direction       | Typed Params                |
//! |---|----------------------|-----------------|----------------------------|
//! | 1 | `session/prompt`     | Editor → Agent  | `PromptRequest`            |
//! | 2 | `session/prompt`     | Editor → Agent  | `PromptRequest`            |
//! | 5 | `session/update`     | Agent → Editor  | `SessionNotification`      |
//! | 6 | `fs/read_text_file`  | Agent → Editor  | `ReadTextFileRequest`      |
//! | 7 | `fs/write_text_file` | Agent → Editor  | `WriteTextFileRequest`     |
//!
//! ## End-Turn Detection
//!
//! JSON-RPC responses to `session/prompt` carry a `stopReason` field.
//! We detect these and call `tracker.end_turn()` to advance the turn counter,
//! which causes files to age out of context after `context_turns` turns.

use agent_client_protocol_schema::{
    ContentBlock, EmbeddedResourceResource, PromptRequest, ReadTextFileRequest,
    SessionNotification, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate, ToolKind,
    WriteTextFileRequest, AGENT_METHOD_NAMES, CLIENT_METHOD_NAMES,
};
use tracing::{debug, warn};

use crate::tracker::ContextTracker;
use crate::types::Action;

// ---------------------------------------------------------------------------
// Public entry points — called by proxy.rs for each forwarded line
// ---------------------------------------------------------------------------

/// Extract context from an editor → agent message line.
///
/// Handles channels #1 (embedded resource) and #2 (resource link) via
/// `session/prompt`.
pub fn extract_upstream(line: &str, tracker: &mut ContextTracker) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Check for terminal/output responses (no "method", have "result" with "output")
    if v.get("method").is_none() {
        if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
            if tracker.take_pending_terminal_output(id) {
                if let Some(output) = v.get("result").and_then(|r| r.get("output")).and_then(|o| o.as_str()) {
                    extract_paths_from_terminal_output(output, tracker);
                }
            }
        }
        return;
    }

    let method = match v.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return,
    };

    debug!(method, "upstream ACP message");

    if method == AGENT_METHOD_NAMES.session_prompt {
        if let Some(params) = v.get("params") {
            match serde_json::from_value::<PromptRequest>(params.clone()) {
                Ok(req) => {
                    debug!(prompt_blocks = req.prompt.len(), "extracting from session/prompt");
                    extract_from_prompt(&req, tracker);
                }
                Err(e) => warn!(method, error = %e, "failed to deserialize PromptRequest"),
            }
        }
    }
}

/// Extract context from an agent → editor message line.
///
/// Handles:
/// - Channel #5: `session/update` (tool_call / tool_call_update)
/// - Channel #6: `fs/read_text_file`
/// - Channel #7: `fs/write_text_file`
pub fn extract_downstream(line: &str, tracker: &mut ContextTracker) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    // --- JSON-RPC responses (no "method", have "result") ---
    // Detect session/new response (sessionId) and PromptResponse (stopReason).
    if v.get("method").is_none() {
        if let Some(result) = v.get("result") {
            // Auto-detect sessionId from session/new response:
            // {"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess_abc123"}}
            // Only set if the tracker doesn't already have one (CLI flag takes priority).
            if let Some(sid) = result.get("sessionId").and_then(|s| s.as_str()) {
                if tracker.session_id().is_empty() {
                    tracker.set_session_id(sid.to_string());
                    tracing::info!(session_id = sid, "auto-detected ACP session ID");
                }
            }
            // Detect PromptResponse by the presence of result.stopReason.
            // This signals end-of-turn so the tracker can advance the turn counter.
            if let Some(stop_reason) = result.get("stopReason").and_then(|s| s.as_str()) {
                debug!(stop_reason, "end-of-turn detected from PromptResponse");
                tracker.end_turn();
            }
        } else {
            debug!("downstream JSON-RPC response (no result)");
        }
        return;
    }

    let method = match v.get("method").and_then(|m| m.as_str()) {
        Some(m) => m,
        None => return,
    };

    debug!(method, "downstream ACP message");

    if method == CLIENT_METHOD_NAMES.session_update {
        if let Some(params) = v.get("params") {
            match serde_json::from_value::<SessionNotification>(params.clone()) {
                Ok(notif) => {
                    debug!(
                        update_type = format!("{:?}", std::mem::discriminant(&notif.update)).as_str(),
                        "extracting from session/update"
                    );
                    extract_from_session_update(&notif.update, tracker);
                }
                Err(e) => warn!(method, error = %e, "failed to deserialize SessionNotification"),
            }
        }
    } else if method == CLIENT_METHOD_NAMES.fs_read_text_file {
        if let Some(params) = v.get("params") {
            match serde_json::from_value::<ReadTextFileRequest>(params.clone()) {
                Ok(req) => {
                    let path = req.path.to_string_lossy().to_string();
                    debug!(path = path.as_str(), action = "read", "fs/read_text_file");
                    tracker.file_access(&path, Action::Read);
                }
                Err(e) => warn!(method, error = %e, "failed to deserialize ReadTextFileRequest"),
            }
        }
    } else if method == CLIENT_METHOD_NAMES.terminal_output {
        if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
            debug!(id, "tracking terminal/output request");
            tracker.add_pending_terminal_output(id);
        }
    } else if method == CLIENT_METHOD_NAMES.fs_write_text_file {
        if let Some(params) = v.get("params") {
            match serde_json::from_value::<WriteTextFileRequest>(params.clone()) {
                Ok(req) => {
                    let path = req.path.to_string_lossy().to_string();
                    debug!(path = path.as_str(), action = "write", "fs/write_text_file");
                    tracker.file_access(&path, Action::Write);
                }
                Err(e) => warn!(method, error = %e, "failed to deserialize WriteTextFileRequest"),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internal extraction helpers
// ---------------------------------------------------------------------------

/// Extract file paths from a `session/prompt` request.
///
/// - Channel #1: `ContentBlock::Resource` → embedded file content → `UserProvided`
/// - Channel #2: `ContentBlock::ResourceLink` → file reference → `UserReferenced`
fn extract_from_prompt(req: &PromptRequest, tracker: &mut ContextTracker) {
    for block in &req.prompt {
        match block {
            ContentBlock::Resource(embedded) => {
                let uri = match &embedded.resource {
                    EmbeddedResourceResource::TextResourceContents(text) => &text.uri,
                    EmbeddedResourceResource::BlobResourceContents(blob) => &blob.uri,
                    _ => continue, // future variants
                };
                if let Some(path) = uri_to_path(uri) {
                    debug!(path = path.as_str(), action = "user_provided", "prompt: embedded resource");
                    tracker.file_access(&path, Action::UserProvided);
                }
            }
            ContentBlock::ResourceLink(link) => {
                if let Some(path) = uri_to_path(&link.uri) {
                    debug!(path = path.as_str(), action = "user_referenced", "prompt: resource link");
                    tracker.file_access(&path, Action::UserReferenced);
                }
            }
            _ => {} // Text, Image, Audio — no file paths
        }
    }
}

/// Extract file paths from a `session/update` notification.
///
/// - Channel #5a: `SessionUpdate::ToolCall` → new tool call with locations
/// - Channel #5b: `SessionUpdate::ToolCallUpdate` → update with optional locations
fn extract_from_session_update(update: &SessionUpdate, tracker: &mut ContextTracker) {
    match update {
        SessionUpdate::ToolCall(tc) => {
            extract_from_tool_call(tc, tracker);
        }
        SessionUpdate::ToolCallUpdate(tcu) => {
            extract_from_tool_call_update(tcu, tracker);
        }
        _ => {} // AgentMessageChunk, Plan, etc. — no file context
    }
}

/// Extract file locations from a new `ToolCall`.
fn extract_from_tool_call(tc: &ToolCall, tracker: &mut ContextTracker) {
    let action = tool_kind_to_action(&tc.kind);
    debug!(
        tool_call_id = %tc.tool_call_id.0,
        title = tc.title.as_str(),
        kind = format!("{:?}", tc.kind).as_str(),
        locations = tc.locations.len(),
        content_blocks = tc.content.len(),
        "tool_call"
    );
    for loc in &tc.locations {
        let path = loc.path.to_string_lossy().to_string();
        debug!(path = path.as_str(), action = format!("{:?}", action).as_str(), "tool_call location");
        tracker.file_access(&path, action);
    }
    extract_diff_paths(&tc.content, Action::Write, tracker);
    if matches!(tc.kind, ToolKind::Search | ToolKind::Execute) {
        extract_search_result_paths(&tc.content, tracker);
    }
    if matches!(tc.kind, ToolKind::Execute) {
        extract_shell_write_paths(&tc.title, tracker);
    }
}

/// Extract file locations from a `ToolCallUpdate`.
fn extract_from_tool_call_update(tcu: &ToolCallUpdate, tracker: &mut ContextTracker) {
    let action = tcu
        .fields
        .kind
        .as_ref()
        .map(tool_kind_to_action)
        .unwrap_or(Action::Read);
    let is_search_or_execute = tcu
        .fields
        .kind
        .as_ref()
        .map(|k| matches!(k, ToolKind::Search | ToolKind::Execute))
        .unwrap_or(false);
    let loc_count = tcu.fields.locations.as_ref().map(|l| l.len()).unwrap_or(0);
    let content_count = tcu.fields.content.as_ref().map(|c| c.len()).unwrap_or(0);
    debug!(
        tool_call_id = %tcu.tool_call_id.0,
        action = format!("{:?}", action).as_str(),
        locations = loc_count,
        content_blocks = content_count,
        "tool_call_update"
    );
    if let Some(locations) = &tcu.fields.locations {
        for loc in locations {
            let path = loc.path.to_string_lossy().to_string();
            debug!(path = path.as_str(), action = format!("{:?}", action).as_str(), "tool_call_update location");
            tracker.file_access(&path, action);
        }
    }
    if let Some(content) = &tcu.fields.content {
        extract_diff_paths(content, Action::Write, tracker);
        if is_search_or_execute {
            extract_search_result_paths(content, tracker);
        }
    }
}

/// Extract file paths from `ToolCallContent::Diff` blocks.
///
/// Diffs always represent file modifications, so action is `Write`.
fn extract_diff_paths(
    content: &[ToolCallContent],
    action: Action,
    tracker: &mut ContextTracker,
) {
    for item in content {
        if let ToolCallContent::Diff(diff) = item {
            let path = diff.path.to_string_lossy().to_string();
            debug!(path = path.as_str(), "diff content block");
            tracker.file_access(&path, action);
        }
    }
}

/// Extract file paths from the text content of search tool results.
///
/// Search tools (grep, glob, find, etc.) return results as text where each
/// line typically starts with an absolute file path. We extract these paths
/// and track them as `Action::Search` so they appear in the context graph.
fn extract_search_result_paths(
    content: &[ToolCallContent],
    tracker: &mut ContextTracker,
) {
    for item in content {
        let text = match item {
            ToolCallContent::Content(c) => match &c.content {
                ContentBlock::Text(t) => &t.text,
                _ => continue,
            },
            _ => continue,
        };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some(path) = extract_path_from_line(line) {
                if std::path::Path::new(&path)
                    .extension()
                    .is_some()
                {
                    debug!(path = path.as_str(), "search result file");
                    tracker.file_access(&path, Action::Search);
                }
            }
        }
    }
}

/// Try to extract an absolute file path from a search output line.
///
/// Handles common formats:
/// - `/path/to/file.rs`           (glob / find output)
/// - `/path/to/file.rs:42:…`      (grep / ripgrep output)
fn extract_path_from_line(line: &str) -> Option<String> {
    if !line.starts_with('/') {
        return None;
    }
    let path = match line.find(':') {
        Some(idx) => &line[..idx],
        None => line,
    };
    let path = path.trim();
    if path.len() > 1 {
        Some(path.to_string())
    } else {
        None
    }
}

/// Extract file write paths from shell command titles.
///
/// Detects redirect patterns like `cat > file`, `echo >> file`, `tee file`.
fn extract_shell_write_paths(title: &str, tracker: &mut ContextTracker) {
    for part in title.split("&&").chain(title.split(";")) {
        let part = part.trim();
        if let Some(path) = extract_redirect_target(part) {
            debug!(path = path.as_str(), "shell write target");
            tracker.file_access(&path, Action::Write);
        }
    }
}

/// Extract the file path from a shell redirect (`>` or `>>`).
fn extract_redirect_target(cmd: &str) -> Option<String> {
    let after = if let Some(idx) = cmd.rfind(">>") {
        cmd[idx + 2..].trim()
    } else if let Some(idx) = cmd.rfind('>') {
        cmd[idx + 1..].trim()
    } else {
        return None;
    };
    let token = after.split_whitespace().next()?;
    if token.is_empty() { return None; }
    Some(token.to_string())
}

/// Extract file paths from terminal output text (find, grep, ls, etc.).
fn extract_paths_from_terminal_output(output: &str, tracker: &mut ContextTracker) {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(path) = extract_path_from_line(line) {
            debug!(path = path.as_str(), "terminal output file");
            tracker.file_access(&path, Action::Search);
        }
    }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/// Map an ACP `ToolKind` to our internal `Action` type.
pub fn tool_kind_to_action(kind: &ToolKind) -> Action {
    match kind {
        ToolKind::Read => Action::Read,
        ToolKind::Edit | ToolKind::Delete | ToolKind::Move => Action::Write,
        ToolKind::Search => Action::Search,
        // Execute, Fetch, Think, SwitchMode, Other — no file-level action
        _ => Action::Read,
    }
}

/// Convert a `file://` URI to a filesystem path.
///
/// Returns `None` for non-file URIs.
pub fn uri_to_path(uri: &str) -> Option<String> {
    uri.strip_prefix("file://").map(|p| p.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TrackerConfig;

    fn make_tracker() -> ContextTracker {
        ContextTracker::new(TrackerConfig::default())
    }

    // -- Channel #1: Embedded resource in prompt -------------------------

    #[test]
    fn extract_prompt_embedded_resource() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"Fix auth"},{"type":"resource","resource":{"uri":"file:///home/user/src/auth.ts","mimeType":"text/typescript","text":"export function login() {}"}}]}}"#;
        extract_upstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/auth.ts"));
        let node = &snap.nodes["/home/user/src/auth.ts"];
        assert_eq!(node.last_action, Action::UserProvided);
        assert!(node.in_context);
        assert_eq!(node.heat, 1.0);
    }

    // -- Channel #2: Resource link in prompt -----------------------------

    #[test]
    fn extract_prompt_resource_link() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"resource_link","uri":"file:///home/user/src/config.ts","name":"config.ts"}]}}"#;
        extract_upstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/config.ts"));
        let node = &snap.nodes["/home/user/src/config.ts"];
        assert_eq!(node.last_action, Action::UserReferenced);
    }

    // -- Channel #5a: Tool call with locations ---------------------------

    #[test]
    fn extract_tool_call_read() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc1","title":"Read file","kind":"read","status":"in_progress","content":[],"locations":[{"path":"/home/user/src/main.rs"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/main.rs"));
        assert_eq!(snap.nodes["/home/user/src/main.rs"].last_action, Action::Read);
    }

    #[test]
    fn extract_tool_call_edit() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc2","title":"Edit file","kind":"edit","status":"in_progress","content":[],"locations":[{"path":"/home/user/src/lib.rs","line":42}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/lib.rs"));
        assert_eq!(snap.nodes["/home/user/src/lib.rs"].last_action, Action::Write);
    }

    #[test]
    fn extract_tool_call_search() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc3","title":"Search","kind":"search","status":"completed","content":[],"locations":[{"path":"/home/user/src"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src"));
        assert_eq!(snap.nodes["/home/user/src"].last_action, Action::Search);
    }

    #[test]
    fn extract_search_result_files_from_text_content() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc3b","title":"Grep","kind":"search","status":"completed","content":[{"type":"content","content":{"type":"text","text":"/home/user/src/main.rs:42:    fn main() {}\n/home/user/src/lib.rs:10:    pub mod foo;\n/home/user/src/utils.rs"}}],"locations":[{"path":"/home/user/src"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src"));
        assert!(snap.nodes.contains_key("/home/user/src/main.rs"));
        assert!(snap.nodes.contains_key("/home/user/src/lib.rs"));
        assert!(snap.nodes.contains_key("/home/user/src/utils.rs"));
        assert_eq!(snap.nodes["/home/user/src/main.rs"].last_action, Action::Search);
        assert_eq!(snap.nodes["/home/user/src/lib.rs"].last_action, Action::Search);
        assert_eq!(snap.nodes["/home/user/src/utils.rs"].last_action, Action::Search);
    }

    #[test]
    fn extract_search_result_files_from_tool_call_update() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tc3c","kind":"search","content":[{"type":"content","content":{"type":"text","text":"/home/user/src/app.rs\n/home/user/src/db.rs"}}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/app.rs"));
        assert!(snap.nodes.contains_key("/home/user/src/db.rs"));
        assert_eq!(snap.nodes["/home/user/src/app.rs"].last_action, Action::Search);
    }

    #[test]
    fn search_result_ignores_non_file_lines() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc3d","title":"Search","kind":"search","status":"completed","content":[{"type":"content","content":{"type":"text","text":"Results found:\n/home/user/src/main.rs:42: code\nno-path-here\n  indented line\n"}}],"locations":[]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert_eq!(snap.nodes.len(), 1);
        assert!(snap.nodes.contains_key("/home/user/src/main.rs"));
    }

    // -- Channel #5b: Tool call update -----------------------------------

    #[test]
    fn extract_tool_call_update_locations() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tc4","kind":"edit","locations":[{"path":"/home/user/src/db.rs"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/db.rs"));
        assert_eq!(snap.nodes["/home/user/src/db.rs"].last_action, Action::Write);
    }

    #[test]
    fn extract_tool_call_update_no_kind_defaults_to_read() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tc5","locations":[{"path":"/home/user/README.md"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/README.md"));
        assert_eq!(snap.nodes["/home/user/README.md"].last_action, Action::Read);
    }

    // -- Channel #6: fs/read_text_file -----------------------------------

    #[test]
    fn extract_fs_read_text_file() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":10,"method":"fs/read_text_file","params":{"sessionId":"s1","path":"/home/user/src/db.ts","line":1,"limit":100}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/db.ts"));
        assert_eq!(snap.nodes["/home/user/src/db.ts"].last_action, Action::Read);
    }

    // -- Channel #7: fs/write_text_file ----------------------------------

    #[test]
    fn extract_fs_write_text_file() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":11,"method":"fs/write_text_file","params":{"sessionId":"s1","path":"/home/user/src/config.ts","content":"export const config = {}"}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/config.ts"));
        assert_eq!(
            snap.nodes["/home/user/src/config.ts"].last_action,
            Action::Write
        );
    }

    // -- Edge cases -------------------------------------------------------

    #[test]
    fn malformed_json_skipped() {
        let mut tracker = make_tracker();
        extract_upstream("not json at all", &mut tracker);
        extract_downstream("{broken", &mut tracker);
        assert_eq!(tracker.snapshot().nodes.len(), 0);
    }

    #[test]
    fn non_file_uri_skipped() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"resource_link","uri":"https://example.com/foo","name":"foo"}]}}"#;
        extract_upstream(line, &mut tracker);
        assert_eq!(tracker.snapshot().nodes.len(), 0);
    }

    #[test]
    fn unknown_method_ignored() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":99,"method":"some/unknown","params":{}}"#;
        extract_upstream(line, &mut tracker);
        extract_downstream(line, &mut tracker);
        assert_eq!(tracker.snapshot().nodes.len(), 0);
    }

    #[test]
    fn non_prompt_response_ignored() {
        let mut tracker = make_tracker();
        // JSON-RPC response without stopReason — not a PromptResponse
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"content":"hello"}}"#;
        extract_downstream(line, &mut tracker);
        assert_eq!(tracker.snapshot().nodes.len(), 0);
    }

    #[test]
    fn multiple_resources_in_single_prompt() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"resource","resource":{"uri":"file:///a.ts","text":"a"}},{"type":"resource_link","uri":"file:///b.ts","name":"b"},{"type":"text","text":"fix both"}]}}"#;
        extract_upstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert_eq!(snap.nodes.len(), 2);
        assert_eq!(snap.nodes["/a.ts"].last_action, Action::UserProvided);
        assert_eq!(snap.nodes["/b.ts"].last_action, Action::UserReferenced);
    }

    #[test]
    fn multiple_locations_in_tool_call() {
        let mut tracker = make_tracker();
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc6","title":"Multi","kind":"read","status":"in_progress","content":[],"locations":[{"path":"/x.rs"},{"path":"/y.rs"},{"path":"/z.rs"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert_eq!(snap.nodes.len(), 3);
    }

    // -- End-turn detection -----------------------------------------------

    #[test]
    fn prompt_response_triggers_end_turn() {
        let mut tracker = make_tracker();
        // Access a file in turn 0
        tracker.file_access("/a.rs", Action::Read);
        assert!(tracker.snapshot().nodes["/a.rs"].in_context);

        // Agent returns PromptResponse with stopReason — each advances turn
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#;

        // Default context_turns = 3. File accessed at turn 0.
        // end_turn checks: current_turn - turn_accessed > context_turns
        // After 1 end_turn: turn=1, 1-0=1 (not > 3) → still in context
        // After 3 end_turns: turn=3, 3-0=3 (not > 3) → still in context
        // After 4 end_turns: turn=4, 4-0=4 (> 3) → exits context
        extract_downstream(line, &mut tracker); // turn 1
        assert!(tracker.snapshot().nodes["/a.rs"].in_context);
        extract_downstream(line, &mut tracker); // turn 2
        extract_downstream(line, &mut tracker); // turn 3
        assert!(tracker.snapshot().nodes["/a.rs"].in_context);
        extract_downstream(line, &mut tracker); // turn 4

        let snap = tracker.snapshot();
        assert!(!snap.nodes["/a.rs"].in_context);
    }

    #[test]
    fn prompt_response_max_tokens_triggers_end_turn() {
        let mut tracker = make_tracker();
        tracker.file_access("/b.rs", Action::Read);

        // max_tokens also has stopReason
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"max_tokens"}}"#;
        extract_downstream(line, &mut tracker);

        // Turn should have advanced (turn 0 → 1)
        // File was accessed at turn 0, now at turn 1 — still in context (< 3 turns)
        let snap = tracker.snapshot();
        assert!(snap.nodes["/b.rs"].in_context);
    }

    #[test]
    fn prompt_response_cancelled_triggers_end_turn() {
        let mut tracker = make_tracker();
        tracker.file_access("/c.rs", Action::Read);

        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"cancelled"}}"#;
        extract_downstream(line, &mut tracker);
        // Turn should have advanced
        assert_eq!(tracker.snapshot().nodes["/c.rs"].turn_accessed, 0);
    }

    // -- Diff content extraction -------------------------------------------

    #[test]
    fn extract_diff_from_tool_call() {
        let mut tracker = make_tracker();
        // tool_call with a diff in content[] and no locations
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc10","title":"Edit","kind":"edit","status":"completed","content":[{"type":"diff","path":"/home/user/src/app.rs","newText":"fn main() {}"}],"locations":[]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/app.rs"));
        assert_eq!(snap.nodes["/home/user/src/app.rs"].last_action, Action::Write);
    }

    #[test]
    fn extract_diff_from_tool_call_update() {
        let mut tracker = make_tracker();
        // tool_call_update with a diff in content[]
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tc11","content":[{"type":"diff","path":"/home/user/src/lib.rs","newText":"pub mod foo;"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert!(snap.nodes.contains_key("/home/user/src/lib.rs"));
        assert_eq!(snap.nodes["/home/user/src/lib.rs"].last_action, Action::Write);
    }

    #[test]
    fn diff_and_locations_both_extracted() {
        let mut tracker = make_tracker();
        // tool_call with both locations and diff content pointing to different files
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"tc12","title":"Edit","kind":"edit","status":"completed","content":[{"type":"diff","path":"/diff.rs","newText":"new"}],"locations":[{"path":"/loc.rs"}]}}}"#;
        extract_downstream(line, &mut tracker);
        let snap = tracker.snapshot();
        assert_eq!(snap.nodes.len(), 2);
        assert!(snap.nodes.contains_key("/diff.rs"));
        assert!(snap.nodes.contains_key("/loc.rs"));
    }

    // -- tool_kind_to_action mapping ------------------------------------

    #[test]
    fn tool_kind_mapping() {
        assert_eq!(tool_kind_to_action(&ToolKind::Read), Action::Read);
        assert_eq!(tool_kind_to_action(&ToolKind::Edit), Action::Write);
        assert_eq!(tool_kind_to_action(&ToolKind::Delete), Action::Write);
        assert_eq!(tool_kind_to_action(&ToolKind::Move), Action::Write);
        assert_eq!(tool_kind_to_action(&ToolKind::Search), Action::Search);
        assert_eq!(tool_kind_to_action(&ToolKind::Execute), Action::Read);
        assert_eq!(tool_kind_to_action(&ToolKind::Fetch), Action::Read);
        assert_eq!(tool_kind_to_action(&ToolKind::Other), Action::Read);
    }

    // -- uri_to_path helper -----------------------------------------------

    #[test]
    fn uri_to_path_file() {
        assert_eq!(uri_to_path("file:///home/user/a.rs"), Some("/home/user/a.rs".to_string()));
    }

    #[test]
    fn uri_to_path_non_file() {
        assert_eq!(uri_to_path("https://example.com"), None);
        assert_eq!(uri_to_path("ftp://host/file"), None);
    }

    // -- Session ID auto-detection ----------------------------------------

    #[test]
    fn auto_detect_session_id_from_new_session_response() {
        let mut tracker = make_tracker();
        assert_eq!(tracker.session_id(), "");

        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess_abc123"}}"#;
        extract_downstream(line, &mut tracker);
        assert_eq!(tracker.session_id(), "sess_abc123");
    }

    #[test]
    fn cli_session_id_not_overridden_by_auto_detect() {
        let mut tracker = make_tracker();
        tracker.set_session_id("cli-provided".to_string());

        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"sess_from_agent"}}"#;
        extract_downstream(line, &mut tracker);
        assert_eq!(tracker.session_id(), "cli-provided");
    }

    #[test]
    fn session_id_not_set_from_non_session_response() {
        let mut tracker = make_tracker();
        // A response with stopReason but no sessionId should not set session_id
        let line = r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#;
        extract_downstream(line, &mut tracker);
        assert_eq!(tracker.session_id(), "");
    }
}
