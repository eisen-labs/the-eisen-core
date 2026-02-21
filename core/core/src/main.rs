//! eisen-core binary
//!
//! Usage:
//!   eisen-core snapshot [--root PATH]
//!   eisen-core observe [--port N] [--agent-id ID] [--session-id ID] -- <agent-command> [agent-args...]
//!
//! Runs as a transparent ACP proxy between the editor (stdin/stdout) and the
//! agent process. Simultaneously extracts context from ACP messages to feed
//! the graph visualization, broadcast over TCP to connected UI clients.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{bail, Result};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tracing_subscriber::EnvFilter;

use tracing::debug;

use eisen_core::flatten::flatten;
use eisen_core::parser::tree::SymbolTree;
use eisen_core::proxy;
use eisen_core::tcp::{self, WireLine};
use eisen_core::tracker::ContextTracker;
use eisen_core::types::TrackerConfig;

/// Parsed CLI arguments.
struct Args {
    port: u16,
    agent_id: Option<String>,
    session_id: Option<String>,
    agent_command: String,
    agent_args: Vec<String>,
}

enum Command {
    Observe(Args),
    Snapshot { root_path: PathBuf },
}

fn parse_command() -> Result<Command> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.is_empty() {
        bail!(
            "Usage: eisen-core snapshot [--root PATH] | eisen-core observe [--port N] [--agent-id ID] [--session-id ID] -- <command> [args...]"
        );
    }

    match raw[0].as_str() {
        "snapshot" => {
            let mut root_path: Option<PathBuf> = None;
            let mut i = 1;
            while i < raw.len() {
                match raw[i].as_str() {
                    "--root" => {
                        i += 1;
                        let Some(root) = raw.get(i) else {
                            bail!("Missing value after --root");
                        };
                        root_path = Some(PathBuf::from(root));
                    }
                    other => bail!("Unknown flag for snapshot: {other}"),
                }
                i += 1;
            }

            Ok(Command::Snapshot {
                root_path: root_path.unwrap_or(std::env::current_dir()?),
            })
        }
        "observe" => parse_observe_args(&raw).map(Command::Observe),
        other => bail!("Unknown command: {other}"),
    }
}

fn parse_observe_args(raw: &[String]) -> Result<Args> {
    // Find the "observe" subcommand
    if raw.is_empty() || raw[0] != "observe" {
        bail!("Usage: eisen-core observe [--port N] [--agent-id ID] [--session-id ID] -- <command> [args...]");
    }

    let mut port: u16 = tcp::DEFAULT_PORT;
    let mut agent_id: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut i = 1; // skip "observe"

    // Parse flags before "--"
    while i < raw.len() && raw[i] != "--" {
        match raw[i].as_str() {
            "--port" => {
                i += 1;
                port = raw.get(i).map(|s| s.parse()).transpose()?.unwrap_or(port);
            }
            "--agent-id" => {
                i += 1;
                agent_id = raw.get(i).cloned();
            }
            "--session-id" => {
                i += 1;
                session_id = raw.get(i).cloned();
            }
            other => bail!("Unknown flag: {other}"),
        }
        i += 1;
    }

    // Skip "--"
    if i < raw.len() && raw[i] == "--" {
        i += 1;
    }

    if i >= raw.len() {
        bail!("Missing agent command after '--'");
    }

    let agent_command = raw[i].clone();
    let agent_args = raw[i + 1..].to_vec();

    Ok(Args {
        port,
        agent_id,
        session_id,
        agent_command,
        agent_args,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing (respects RUST_LOG env var)
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    match parse_command()? {
        Command::Snapshot { root_path } => {
            let tree = SymbolTree::init_tree(&root_path)?;
            let snapshot = flatten(&tree, &root_path, 0);
            println!("{}", serde_json::to_string(&snapshot)?);
            return Ok(());
        }
        Command::Observe(args) => {
            // Create the context tracker
            let mut tracker = ContextTracker::new(TrackerConfig::default());
            if let Some(aid) = &args.agent_id {
                tracker.set_agent_id(aid.clone());
            }
            if let Some(sid) = &args.session_id {
                tracker.set_session_id(sid.clone());
            }
            let tracker = Arc::new(Mutex::new(tracker));

            // Bind TCP listener for graph UI clients
            let listener = TcpListener::bind(format!("127.0.0.1:{}", args.port)).await?;
            let actual_port = listener.local_addr()?.port();
            // Print port to stderr so the extension can read it
            eprintln!("eisen-core tcp port: {actual_port}");

            // Broadcast channel for deltas -> TCP clients
            let (delta_tx, _) = broadcast::channel::<WireLine>(256);

            // Spawn TCP server
            let tcp_tracker = tracker.clone();
            let tcp_delta_tx = delta_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = tcp::serve(listener, tcp_tracker, tcp_delta_tx).await {
                    eprintln!("eisen-core tcp server error: {e}");
                }
            });

            // Spawn the agent process
            let mut child = proxy::spawn_agent(&args.agent_command, &args.agent_args)?;
            let agent_stdin = child.stdin.take().expect("agent stdin should be piped");
            let agent_stdout = child.stdout.take().expect("agent stdout should be piped");

            // Spawn upstream proxy (editor stdin -> agent stdin)
            let up_tracker = tracker.clone();
            let upstream = tokio::spawn(async move {
                if let Err(e) = proxy::upstream_task(up_tracker, agent_stdin).await {
                    eprintln!("eisen-core upstream error: {e}");
                }
            });

            // Spawn downstream proxy (agent stdout -> editor stdout)
            let down_tracker = tracker.clone();
            let downstream = tokio::spawn(async move {
                if let Err(e) = proxy::downstream_task(down_tracker, agent_stdout).await {
                    eprintln!("eisen-core downstream error: {e}");
                }
            });

            // Tick loop: decay heat, broadcast deltas adaptively.
            // Starts at 100ms intervals. If nothing changes for several consecutive
            // ticks, backs off to 500ms to reduce CPU/IO when idle. Returns to
            // 100ms as soon as activity resumes.
            let tick_tracker = tracker.clone();
            let tick_tx = delta_tx.clone();
            let tick_loop = tokio::spawn(async move {
                const ACTIVE_INTERVAL_MS: u64 = 100;
                const IDLE_INTERVAL_MS: u64 = 500;
                const IDLE_THRESHOLD: u32 = 20; // ~2s of no-ops before backing off

                let mut idle_ticks: u32 = 0;
                let mut interval =
                    tokio::time::interval(std::time::Duration::from_millis(ACTIVE_INTERVAL_MS));

                loop {
                    interval.tick().await;
                    let mut t = tick_tracker.lock().await;

                    let mut had_activity = false;

                    // Broadcast any pending usage messages
                    let usage_msgs = t.take_pending_usage();
                    if !usage_msgs.is_empty() {
                        had_activity = true;
                        debug!(
                            count = usage_msgs.len(),
                            "broadcasting pending usage messages"
                        );
                    }
                    for usage in usage_msgs {
                        tcp::broadcast_line(&tick_tx, &usage);
                    }

                    // Broadcast delta if anything changed
                    if let Some(ref delta) = t.tick() {
                        had_activity = true;
                        debug!(
                            seq = delta.seq,
                            updates = delta.updates.len(),
                            removed = delta.removed.len(),
                            "broadcasting delta from tick"
                        );
                        tcp::broadcast_line(&tick_tx, delta);
                    }

                    // Adaptive interval: back off when idle, speed up on activity
                    if had_activity {
                        if idle_ticks >= IDLE_THRESHOLD {
                            // Resuming from idle — switch back to fast interval
                            interval = tokio::time::interval(std::time::Duration::from_millis(
                                ACTIVE_INTERVAL_MS,
                            ));
                            debug!("tick loop resumed active interval (100ms)");
                        }
                        idle_ticks = 0;
                    } else {
                        idle_ticks = idle_ticks.saturating_add(1);
                        if idle_ticks == IDLE_THRESHOLD {
                            // Switch to slow interval
                            interval = tokio::time::interval(std::time::Duration::from_millis(
                                IDLE_INTERVAL_MS,
                            ));
                            debug!("tick loop entering idle interval (500ms)");
                        }
                    }
                }
            });

            // Wait for either proxy direction to finish (agent exited or editor closed stdin)
            tokio::select! {
                _ = upstream => {}
                _ = downstream => {}
            }

            // Clean up
            tick_loop.abort();
            let _ = child.kill().await;

            Ok(())
        }
    }
}
