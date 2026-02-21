//! Bidirectional stdio proxy between editor and ACP agent.
//!
//! Reads lines from editor stdin, inspects for context, forwards to agent stdin.
//! Reads lines from agent stdout, inspects for context, forwards to editor stdout.
//! Agent stderr is inherited (passes through to the editor's stderr).
//!
//! Phase 3 addition: Zone enforcement. When a ZoneConfig is provided, the proxy
//! intercepts `fs/read_text_file` and `fs/write_text_file` requests from the
//! agent and blocks access to paths outside the allowed zone. Blocked requests
//! receive a JSON-RPC error response directly from the proxy (not forwarded to
//! the editor).

use std::sync::Arc;

use anyhow::Result;
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};
use tracing::{debug, warn};

use crate::extract;
use crate::tcp::WireLine;
use crate::tracker::ContextTracker;
use crate::types::{Action, BlockedAccess, ZoneConfig};

/// JSON-RPC error code for zone violation.
const ZONE_VIOLATION_CODE: i64 = -32001;

/// Spawn the ACP agent as a child process with piped stdin/stdout.
pub fn spawn_agent(command: &str, args: &[String]) -> Result<Child> {
    let child = Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    Ok(child)
}

/// Task 1: Read from editor stdin, extract context, forward to agent stdin.
///
/// Returns when editor closes stdin (EOF).
pub async fn upstream_task(
    tracker: Arc<Mutex<ContextTracker>>,
    mut agent_stdin: impl io::AsyncWrite + Unpin,
) -> Result<()> {
    let mut reader = BufReader::new(io::stdin());
    let mut line = String::new();
    while reader.read_line(&mut line).await? > 0 {
        // Log the method (if JSON-RPC) for upstream messages
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let method = v
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("<response>");
            let id = v.get("id").and_then(|i| i.as_u64());
            debug!(
                direction = "upstream",
                method,
                id,
                bytes = line.len(),
                "editor -> agent"
            );
        }
        {
            let mut t = tracker.lock().await;
            extract::extract_upstream(&line, &mut t);
        }
        agent_stdin.write_all(line.as_bytes()).await?;
        line.clear();
    }
    Ok(())
}

/// Task 2: Read from agent stdout, extract context, forward to editor stdout.
///
/// When zone enforcement is active (`zone_config` is `Some`), intercepts
/// `fs/read_text_file` and `fs/write_text_file` requests. If the path is
/// outside the allowed zone:
///   - Returns a JSON-RPC error to the agent (via agent stdin, not shown here
///     -- the error is written directly to editor stdout for the agent to receive)
///   - Broadcasts a `BlockedAccess` message to TCP listeners
///   - Records the blocked access in the tracker
///   - Does NOT forward the request to the editor
///
/// Returns when agent closes stdout (EOF / exit).
pub async fn downstream_task(
    tracker: Arc<Mutex<ContextTracker>>,
    agent_stdout: impl io::AsyncRead + Unpin,
    zone_config: Option<Arc<ZoneConfig>>,
    blocked_tx: broadcast::Sender<WireLine>,
) -> Result<()> {
    let mut reader = BufReader::new(agent_stdout);
    let mut writer = io::stdout();
    let mut line = String::new();
    while reader.read_line(&mut line).await? > 0 {
        // Log the method (if JSON-RPC) for downstream messages
        let parsed = serde_json::from_str::<serde_json::Value>(&line).ok();
        if let Some(ref v) = parsed {
            let method = v
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("<response>");
            let id = v.get("id").and_then(|i| i.as_u64());
            debug!(
                direction = "downstream",
                method,
                id,
                bytes = line.len(),
                "agent -> editor"
            );
        }

        // Zone enforcement check
        if let (Some(ref zone), Some(ref v)) = (&zone_config, &parsed) {
            if let Some(block_result) = check_zone_violation(v, zone) {
                // Blocked! Don't forward to editor.
                let id = v.get("id");
                let (agent_id, session_id) = {
                    let t = tracker.lock().await;
                    (t.agent_id().to_string(), t.session_id().to_string())
                };

                warn!(
                    path = block_result.path.as_str(),
                    action = block_result.action.as_str(),
                    "zone violation: blocked out-of-zone access"
                );

                // Record in tracker as Blocked action
                {
                    let mut t = tracker.lock().await;
                    t.file_access(&block_result.path, Action::Blocked);
                }

                // Build JSON-RPC error response for the agent
                if let Some(id) = id {
                    let error_response = serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": ZONE_VIOLATION_CODE,
                            "message": format!(
                                "Outside agent zone: {}. Request cross-region info through the orchestrator.",
                                block_result.path
                            )
                        }
                    });
                    let error_line = serde_json::to_string(&error_response)? + "\n";
                    // Write the error response back to editor stdout so the
                    // ACP connection delivers it to the agent as a response
                    writer.write_all(error_line.as_bytes()).await?;
                }

                // Broadcast BlockedAccess message to TCP listeners
                let blocked_msg = BlockedAccess::new(
                    &agent_id,
                    &session_id,
                    &block_result.path,
                    &block_result.action,
                );
                crate::tcp::broadcast_line(&blocked_tx, &blocked_msg);

                line.clear();
                continue; // Do NOT forward to editor
            }
        }

        // Normal path: extract context and forward
        {
            let mut t = tracker.lock().await;
            extract::extract_downstream(&line, &mut t);
        }
        writer.write_all(line.as_bytes()).await?;
        line.clear();
    }
    Ok(())
}

/// Result of a zone violation check.
struct ZoneViolation {
    path: String,
    action: String, // "read" or "write"
}

/// Check if a JSON-RPC message from the agent is a zone violation.
///
/// Returns `Some(ZoneViolation)` if the message is an `fs/read_text_file` or
/// `fs/write_text_file` request with a path outside the allowed zone.
/// Returns `None` if the message is allowed or not a file access method.
fn check_zone_violation(v: &serde_json::Value, zone: &ZoneConfig) -> Option<ZoneViolation> {
    let method = v.get("method")?.as_str()?;

    let (action_str, path) = match method {
        "fs/read_text_file" => {
            let path = v
                .get("params")
                .and_then(|p| p.get("path"))
                .and_then(|p| p.as_str())?;
            ("read", path.to_string())
        }
        "fs/write_text_file" => {
            let path = v
                .get("params")
                .and_then(|p| p.get("path"))
                .and_then(|p| p.as_str())?;
            ("write", path.to_string())
        }
        _ => return None, // Not a file access method — allow through
    };

    if zone.is_allowed(&path) {
        None // Path is within the zone — allow
    } else {
        Some(ZoneViolation {
            path,
            action: action_str.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test that check_zone_violation blocks reads outside zone.
    #[test]
    fn test_zone_blocks_read_outside() {
        let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "fs/read_text_file",
            "params": {"path": "/workspace/core/auth.rs", "sessionId": "s1"}
        });
        let result = check_zone_violation(&msg, &zone);
        assert!(result.is_some());
        let v = result.unwrap();
        assert_eq!(v.action, "read");
        assert_eq!(v.path, "/workspace/core/auth.rs");
    }

    /// Test that check_zone_violation allows reads inside zone.
    #[test]
    fn test_zone_allows_read_inside() {
        let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "fs/read_text_file",
            "params": {"path": "src/ui/components/button.tsx", "sessionId": "s1"}
        });
        assert!(check_zone_violation(&msg, &zone).is_none());
    }

    /// Test that check_zone_violation blocks writes outside zone.
    #[test]
    fn test_zone_blocks_write_outside() {
        let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "fs/write_text_file",
            "params": {"path": "core/src/proxy.rs", "content": "hello", "sessionId": "s1"}
        });
        let result = check_zone_violation(&msg, &zone);
        assert!(result.is_some());
        assert_eq!(result.unwrap().action, "write");
    }

    /// Test that non-file methods are not blocked.
    #[test]
    fn test_zone_ignores_non_file_methods() {
        let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "session/update",
            "params": {"sessionId": "s1"}
        });
        assert!(check_zone_violation(&msg, &zone).is_none());
    }

    /// Test that JSON-RPC responses (no method) are not blocked.
    #[test]
    fn test_zone_ignores_responses() {
        let zone = ZoneConfig::new(vec!["src/ui/**".to_string()]);
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 5,
            "result": {"content": "hello"}
        });
        assert!(check_zone_violation(&msg, &zone).is_none());
    }
}
