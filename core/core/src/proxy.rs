//! Bidirectional stdio proxy between editor and ACP agent.
//!
//! Reads lines from editor stdin, inspects for context, forwards to agent stdin.
//! Reads lines from agent stdout, inspects for context, forwards to editor stdout.
//! Agent stderr is inherited (passes through to the editor's stderr).

use std::sync::Arc;

use anyhow::Result;
use tokio::io::{self, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::debug;

use crate::extract;
use crate::tracker::ContextTracker;

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
            let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("<response>");
            let id = v.get("id").and_then(|i| i.as_u64());
            debug!(direction = "upstream", method, id, bytes = line.len(), "editor -> agent");
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
/// Returns when agent closes stdout (EOF / exit).
pub async fn downstream_task(
    tracker: Arc<Mutex<ContextTracker>>,
    agent_stdout: impl io::AsyncRead + Unpin,
) -> Result<()> {
    let mut reader = BufReader::new(agent_stdout);
    let mut writer = io::stdout();
    let mut line = String::new();
    while reader.read_line(&mut line).await? > 0 {
        // Log the method (if JSON-RPC) for downstream messages
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("<response>");
            let id = v.get("id").and_then(|i| i.as_u64());
            debug!(direction = "downstream", method, id, bytes = line.len(), "agent -> editor");
        }
        {
            let mut t = tracker.lock().await;
            extract::extract_downstream(&line, &mut t);
        }
        writer.write_all(line.as_bytes()).await?;
        line.clear();
    }
    Ok(())
}
