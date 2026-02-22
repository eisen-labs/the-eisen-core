use std::sync::Arc;

use anyhow::Result;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tracing::debug;

use crate::orchestrator::OrchestratorAggregator;
use crate::session_registry::SessionRegistry;
use crate::tracker::ContextTracker;
use crate::types::{ClientMessage, RpcResponse, SessionKey, SessionMode, SessionModel};

/// Default TCP port for the eisen-core delta server.
pub const DEFAULT_PORT: u16 = 17320;

/// Serialized ndJSON line, ready to write to a TCP socket.
/// Includes the trailing newline.
pub type WireLine = String;

#[derive(Debug, Clone)]
enum StreamFilter {
    All,
    Session(String),
    Mode(SessionMode),
}

impl StreamFilter {
    fn allows(&self, session_id: Option<&str>, session_mode: Option<SessionMode>) -> bool {
        match self {
            StreamFilter::All => true,
            StreamFilter::Session(expected) => session_id.map(|s| s == expected).unwrap_or(false),
            StreamFilter::Mode(expected) => session_mode.map(|m| m == *expected).unwrap_or(false),
        }
    }
}

/// Start the TCP server with a pre-bound listener.
///
/// - Accepts clients in a loop, spawning a task per client.
/// - On connect, sends the current snapshot.
/// - Forwards all deltas from the broadcast channel.
/// - Handles `request_snapshot` messages from clients.
/// - Handles lagged receivers by sending a fresh snapshot.
///
/// The caller is responsible for binding the `TcpListener` (which allows
/// port 0 / ephemeral port allocation and printing the actual port before
/// this function is called).
///
/// This function runs forever (until the runtime shuts down).
pub async fn serve(
    listener: TcpListener,
    tracker: Arc<Mutex<ContextTracker>>,
    delta_tx: broadcast::Sender<WireLine>,
    registry: Arc<Mutex<SessionRegistry>>,
    orchestrator: Arc<Mutex<OrchestratorAggregator>>,
) -> Result<()> {
    loop {
        let (stream, addr) = listener.accept().await?;
        debug!(client = %addr, "TCP client connected");
        let tracker = tracker.clone();
        let delta_rx = delta_tx.subscribe();
        let registry = registry.clone();
        let orchestrator = orchestrator.clone();

        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, tracker, delta_rx, registry, orchestrator).await {
                // Client disconnected or I/O error — not fatal.
                eprintln!("eisen tcp client error: {e}");
            }
            debug!("TCP client disconnected");
        });
    }
}

/// Handle a single connected TCP client.
///
/// 1. Send snapshot immediately.
/// 2. Concurrently:
///    a. Forward deltas from broadcast channel to the client.
///    b. Read lines from the client looking for `request_snapshot`.
///
/// Public so integration tests can drive individual client connections
/// without going through the accept loop.
pub async fn handle_client(
    stream: tokio::net::TcpStream,
    tracker: Arc<Mutex<ContextTracker>>,
    mut delta_rx: broadcast::Receiver<WireLine>,
    registry: Arc<Mutex<SessionRegistry>>,
    orchestrator: Arc<Mutex<OrchestratorAggregator>>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();

    // Send initial snapshot
    {
        let snap = resolve_snapshot(
            &tracker,
            &registry,
            &orchestrator,
            None,
            &StreamFilter::All,
        )
        .await;
        debug!(
            node_count = snap.nodes.len(),
            seq = snap.seq,
            "sending initial snapshot to TCP client"
        );
        let json = serde_json::to_string(&snap)? + "\n";
        writer.write_all(json.as_bytes()).await?;
    }

    let tracker_for_reader = tracker.clone();
    let registry_for_reader = registry.clone();
    let orchestrator_for_reader = orchestrator.clone();

    // Task: read client messages (only request_snapshot is defined)
    let mut buf_reader = BufReader::new(reader);

    // We need shared write access between the delta forwarder and the
    // snapshot responder. Use a Mutex on the writer.
    let writer = Arc::new(Mutex::new(writer));
    let writer_for_deltas = writer.clone();
    let writer_for_requests = writer.clone();

    let filter = Arc::new(Mutex::new(StreamFilter::All));
    let filter_for_deltas = filter.clone();
    let filter_for_requests = filter.clone();

    // Forward deltas to the client
    let delta_task = tokio::spawn(async move {
        loop {
            match delta_rx.recv().await {
                Ok(line) => {
                    let filter = filter_for_deltas.lock().await.clone();
                    if matches!(filter, StreamFilter::All) {
                        debug!(bytes = line.len(), "forwarding delta to TCP client");
                        let mut w = writer_for_deltas.lock().await;
                        if w.write_all(line.as_bytes()).await.is_err() {
                            break; // client disconnected
                        }
                        continue;
                    }

                    let parsed = serde_json::from_str::<serde_json::Value>(line.trim()).ok();
                    let session_id = parsed
                        .as_ref()
                        .and_then(|v| v.get("session_id"))
                        .and_then(|s| s.as_str());
                    let session_mode = parsed
                        .as_ref()
                        .and_then(|v| v.get("session_mode"))
                        .and_then(|m| serde_json::from_value::<SessionMode>(m.clone()).ok());

                    if filter.allows(session_id, session_mode) {
                        debug!(bytes = line.len(), "forwarding delta to TCP client");
                        let mut w = writer_for_deltas.lock().await;
                        if w.write_all(line.as_bytes()).await.is_err() {
                            break; // client disconnected
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    // Client was too slow — send a fresh snapshot to resync
                    debug!(lagged = count, "client lagged, sending fresh snapshot");
                    let filter = filter_for_deltas.lock().await.clone();
                    let snap = resolve_snapshot(
                        &tracker,
                        &registry,
                        &orchestrator,
                        None,
                        &filter,
                    )
                    .await;
                    let json = match serde_json::to_string(&snap) {
                        Ok(j) => j + "\n",
                        Err(_) => break,
                    };
                    let mut w = writer_for_deltas.lock().await;
                    if w.write_all(json.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Read client messages
    let request_task = tokio::spawn(async move {
        let mut line = String::new();
        loop {
            line.clear();
            match buf_reader.read_line(&mut line).await {
                Ok(0) => break, // client disconnected (EOF)
                Ok(_) => {
                    // Try to parse as a client message
                    if let Ok(msg) = serde_json::from_str::<ClientMessage>(line.trim()) {
                        match msg {
                            ClientMessage::RequestSnapshot { session_id } => {
                                debug!(msg_type = "request_snapshot", "received client message");
                                let filter = filter_for_requests.lock().await.clone();
                                let snap = resolve_snapshot(
                                    &tracker_for_reader,
                                    &registry_for_reader,
                                    &orchestrator_for_reader,
                                    session_id,
                                    &filter,
                                )
                                .await;
                                debug!(
                                    node_count = snap.nodes.len(),
                                    seq = snap.seq,
                                    "sending requested snapshot to TCP client"
                                );
                                let json = match serde_json::to_string(&snap) {
                                    Ok(j) => j + "\n",
                                    Err(_) => break,
                                };
                                let mut w = writer_for_requests.lock().await;
                                if w.write_all(json.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                            ClientMessage::SetStreamFilter {
                                session_id,
                                session_mode,
                            } => {
                                let mut next = StreamFilter::All;
                                if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
                                    next = StreamFilter::Session(sid);
                                } else if let Some(mode) = session_mode {
                                    next = StreamFilter::Mode(mode);
                                }
                                *filter_for_requests.lock().await = next;
                            }
                            ClientMessage::Rpc { id, method, params } => {
                                debug!(msg_type = "rpc", method = method.as_str(), "received client message");
                                let response =
                                    handle_rpc_request(
                                        id,
                                        method,
                                        params,
                                        &registry_for_reader,
                                        &tracker_for_reader,
                                    )
                                        .await;
                                let json = match serde_json::to_string(&response) {
                                    Ok(j) => j + "\n",
                                    Err(_) => break,
                                };
                                let mut w = writer_for_requests.lock().await;
                                if w.write_all(json.as_bytes()).await.is_err() {
                                    break;
                                }
                            }
                        }
                    } else {
                        debug!(raw = line.trim(), "malformed JSON from TCP client");
                    }
                }
                Err(_) => break, // read error
            }
        }
    });

    // Wait for either task to finish (client disconnect or channel close)
    tokio::select! {
        _ = delta_task => {}
        _ = request_task => {}
    }

    Ok(())
}

async fn resolve_snapshot(
    tracker: &Arc<Mutex<ContextTracker>>,
    registry: &Arc<Mutex<SessionRegistry>>,
    orchestrator: &Arc<Mutex<OrchestratorAggregator>>,
    requested_session_id: Option<String>,
    filter: &StreamFilter,
) -> crate::types::Snapshot {
    let (agent_id, default_session, session_ids) = {
        let t = tracker.lock().await;
        (
            t.agent_id().to_string(),
            t.session_id().to_string(),
            t.session_ids(),
        )
    };

    let (target_key, session_state) = {
        let reg = registry.lock().await;
        let mut target: Option<SessionKey> = requested_session_id
            .as_ref()
            .map(|sid| SessionKey::new(&agent_id, sid));

        if target.is_none() {
            target = match filter {
                StreamFilter::Session(sid) => Some(SessionKey::new(&agent_id, sid)),
                StreamFilter::Mode(mode) => reg
                    .orchestrator_sessions()
                    .into_iter()
                    .find(|s| s.mode == *mode)
                    .map(|s| s.key())
                    .or_else(|| {
                        reg.list_sessions(Some(&agent_id))
                            .into_iter()
                            .find(|s| s.mode == *mode)
                            .map(|s| SessionKey::new(&s.agent_id, &s.session_id))
                    }),
                StreamFilter::All => None,
            };
        }

        if target.is_none() {
            target = reg.active_session();
        }

        if target.is_none() {
            if !default_session.is_empty() {
                target = Some(SessionKey::new(&agent_id, &default_session));
            } else if let Some(first) = session_ids.first() {
                target = Some(SessionKey::new(&agent_id, first));
            }
        }

        let state = target
            .as_ref()
            .and_then(|key| reg.get_session_state(key));

        (target, state)
    };

    if let Some(state) = session_state {
        if state.mode == SessionMode::Orchestrator {
            let mut agg = orchestrator.lock().await;
            let t = tracker.lock().await;
            return agg.snapshot_for_session(&state, &t);
        }
    }

    let t = tracker.lock().await;
    if let Some(key) = target_key {
        t.snapshot_for_session(&key.session_id)
    } else {
        t.snapshot()
    }
}

#[derive(Debug, Deserialize, Default)]
struct ListSessionsParams {
    agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateSessionParams {
    agent_id: String,
    session_id: String,
    mode: SessionMode,
    model: Option<SessionModel>,
    summary: Option<String>,
    history: Option<Vec<serde_json::Value>>,
    context: Option<Vec<serde_json::Value>>,
    providers: Option<Vec<SessionKey>>,
}

#[derive(Debug, Deserialize)]
struct SessionKeyParams {
    agent_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
struct AddContextItemsParams {
    agent_id: String,
    session_id: String,
    items: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct SetOrchestratorProvidersParams {
    agent_id: String,
    session_id: String,
    providers: Vec<SessionKey>,
}

async fn handle_rpc_request(
    id: String,
    method: String,
    params: Option<serde_json::Value>,
    registry: &Arc<Mutex<SessionRegistry>>,
    tracker: &Arc<Mutex<ContextTracker>>,
) -> RpcResponse {
    match method.as_str() {
        "list_sessions" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<ListSessionsParams>(value)
                    .map_err(|e| e.to_string()),
                None => Ok(ListSessionsParams::default()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let sessions = registry.lock().await.list_sessions(params.agent_id.as_deref());
            match serde_json::to_value(sessions) {
                Ok(value) => RpcResponse::result(id, value),
                Err(err) => RpcResponse::error(id, 500, err.to_string()),
            }
        }
        "create_session" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<CreateSessionParams>(value)
                    .map_err(|e| e.to_string()),
                None => Err("missing params".to_string()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let result = registry.lock().await.create_session(
                params.agent_id,
                params.session_id,
                params.mode,
                params.model,
                params.summary,
                params.history,
                params.context,
                params.providers,
            );
            match result {
                Ok(session) => {
                    tracker
                        .lock()
                        .await
                        .set_session_mode(&session.session_id, session.mode);
                    match serde_json::to_value(session) {
                        Ok(value) => RpcResponse::result(id, value),
                        Err(err) => RpcResponse::error(id, 500, err.to_string()),
                    }
                }
                Err(err) => RpcResponse::error(id, 500, err.to_string()),
            }
        }
        "close_session" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<SessionKeyParams>(value)
                    .map_err(|e| e.to_string()),
                None => Err("missing params".to_string()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let key = SessionKey::new(&params.agent_id, &params.session_id);
            match registry.lock().await.close_session(&key) {
                Ok(closed) => RpcResponse::result(id, serde_json::json!({"closed": closed})),
                Err(err) => RpcResponse::error(id, 500, err.to_string()),
            }
        }
        "set_active_session" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<SessionKeyParams>(value)
                    .map_err(|e| e.to_string()),
                None => Err("missing params".to_string()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let key = SessionKey::new(&params.agent_id, &params.session_id);
            match registry.lock().await.set_active_session(key.clone()) {
                Ok(true) => {
                    if let Some(session) = registry.lock().await.get_session_state(&key) {
                        let mut t = tracker.lock().await;
                        t.set_session_id(session.session_id.clone());
                        t.set_session_mode(&session.session_id, session.mode);
                    }
                    RpcResponse::result(id, serde_json::json!({"active": true}))
                }
                Ok(false) => RpcResponse::error(id, 404, "session not found".to_string()),
                Err(err) => RpcResponse::error(id, 500, err.to_string()),
            }
        }
        "set_orchestrator_providers" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<SetOrchestratorProvidersParams>(value)
                    .map_err(|e| e.to_string()),
                None => Err("missing params".to_string()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let key = SessionKey::new(&params.agent_id, &params.session_id);
            let result = registry
                .lock()
                .await
                .set_orchestrator_providers(&key, params.providers);
            match result {
                Ok(Some(session)) => {
                    tracker
                        .lock()
                        .await
                        .set_session_mode(&session.session_id, session.mode);
                    match serde_json::to_value(session) {
                        Ok(value) => RpcResponse::result(id, value),
                        Err(err) => RpcResponse::error(id, 500, err.to_string()),
                    }
                }
                Ok(None) => RpcResponse::error(id, 404, "session not found".to_string()),
                Err(err) => RpcResponse::error(id, 500, err.to_string()),
            }
        }
        "get_session_state" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<SessionKeyParams>(value)
                    .map_err(|e| e.to_string()),
                None => Err("missing params".to_string()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let key = SessionKey::new(&params.agent_id, &params.session_id);
            let state = registry.lock().await.get_session_state(&key);
            match state {
                Some(session) => match serde_json::to_value(session) {
                    Ok(value) => RpcResponse::result(id, value),
                    Err(err) => RpcResponse::error(id, 500, err.to_string()),
                },
                None => RpcResponse::error(id, 404, "session not found".to_string()),
            }
        }
        "add_context_items" => {
            let parsed = match params {
                Some(value) => serde_json::from_value::<AddContextItemsParams>(value)
                    .map_err(|e| e.to_string()),
                None => Err("missing params".to_string()),
            };
            let params = match parsed {
                Ok(p) => p,
                Err(err) => return RpcResponse::error(id, 400, err),
            };
            let key = SessionKey::new(&params.agent_id, &params.session_id);
            match registry
                .lock()
                .await
                .add_context_items(&key, params.items)
            {
                Ok(Some(session)) => match serde_json::to_value(session) {
                    Ok(value) => RpcResponse::result(id, value),
                    Err(err) => RpcResponse::error(id, 500, err.to_string()),
                },
                Ok(None) => RpcResponse::error(id, 404, "session not found".to_string()),
                Err(err) => RpcResponse::error(id, 500, err.to_string()),
            }
        }
        _ => RpcResponse::error(id, 404, "unknown rpc method".to_string()),
    }
}

/// Serialize a value to an ndJSON line and broadcast it to all connected
/// TCP clients. Returns the number of active receivers (0 if none connected).
pub fn broadcast_line(tx: &broadcast::Sender<WireLine>, value: &impl serde::Serialize) -> usize {
    let json = serde_json::to_string(value).expect("delta serialization should not fail") + "\n";
    let json_len = json.len();
    // send returns Err if there are no receivers — that's OK
    let receivers = tx.send(json).unwrap_or(0);
    debug!(receivers, bytes = json_len, "broadcast line to TCP clients");
    receivers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::OrchestratorAggregator;
    use crate::session_registry::SessionRegistry;
    use crate::types::{Action, TrackerConfig};
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// Helper: start a TCP server on an ephemeral port, return the port
    /// and broadcast sender.
    async fn start_test_server(
    ) -> (
        u16,
        broadcast::Sender<WireLine>,
        Arc<Mutex<ContextTracker>>,
        Arc<Mutex<SessionRegistry>>,
        Arc<Mutex<OrchestratorAggregator>>,
        TempDir,
    ) {
        let tracker = Arc::new(Mutex::new(ContextTracker::new(TrackerConfig::default())));
        let registry_dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(Mutex::new(SessionRegistry::load_from_path(
            registry_dir.path().join("core_sessions.json"),
        )));
        let orchestrator = Arc::new(Mutex::new(OrchestratorAggregator::new()));
        let (delta_tx, _) = broadcast::channel::<WireLine>(64);

        // Bind to port 0 for ephemeral port assignment
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let t = tracker.clone();
        let reg = registry.clone();
        let orch = orchestrator.clone();
        let tx = delta_tx.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let t2 = t.clone();
                let reg2 = reg.clone();
                let orch2 = orch.clone();
                let rx = tx.subscribe();
                tokio::spawn(async move {
                    let _ = handle_client(stream, t2, rx, reg2, orch2).await;
                });
            }
        });

        (port, delta_tx, tracker, registry, orchestrator, registry_dir)
    }

    /// Read one ndJSON line from a stream.
    async fn read_line(stream: &mut TcpStream) -> String {
        let mut buf = vec![0u8; 8192];
        let mut total = Vec::new();
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            total.extend_from_slice(&buf[..n]);
            if let Some(pos) = total.iter().position(|&b| b == b'\n') {
                return String::from_utf8(total[..pos].to_vec()).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn client_receives_snapshot_on_connect() {
        let (port, _tx, tracker, _registry, _orchestrator, _dir) = start_test_server().await;

        // Add a file to the tracker before client connects
        tracker
            .lock()
            .await
            .file_access("/src/main.rs", Action::Read);

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let line = read_line(&mut stream).await;

        let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(msg["type"], "snapshot");
        assert!(msg["nodes"]["/src/main.rs"].is_object());
    }

    #[tokio::test]
    async fn client_receives_broadcast_delta() {
        let (port, delta_tx, tracker, _registry, _orchestrator, _dir) = start_test_server().await;

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        // Read and discard initial snapshot
        let _snap = read_line(&mut stream).await;

        // Produce a delta
        {
            let mut t = tracker.lock().await;
            t.file_access("/src/lib.rs", Action::Write);
            if let Some(delta) = t.tick() {
                broadcast_line(&delta_tx, &delta);
            }
        }

        let line = read_line(&mut stream).await;
        let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(msg["type"], "delta");
        assert!(!msg["updates"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn client_request_snapshot() {
        let (port, _tx, tracker, _registry, _orchestrator, _dir) = start_test_server().await;

        tracker.lock().await.file_access("/src/a.rs", Action::Read);

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let _snap = read_line(&mut stream).await; // initial snapshot

        // Add another file after connection
        tracker.lock().await.file_access("/src/b.rs", Action::Write);

        // Request snapshot
        stream
            .write_all(b"{\"type\":\"request_snapshot\"}\n")
            .await
            .unwrap();

        // Should receive a fresh snapshot that includes both files
        let line = read_line(&mut stream).await;
        let msg: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(msg["type"], "snapshot");
        assert!(msg["nodes"]["/src/a.rs"].is_object());
        assert!(msg["nodes"]["/src/b.rs"].is_object());
    }

    #[test]
    fn broadcast_line_serializes_correctly() {
        let (tx, mut rx) = broadcast::channel::<WireLine>(8);
        let delta = crate::types::Delta::new(
            "",
            "",
            crate::types::SessionMode::SingleAgent,
            42,
            vec![crate::types::NodeUpdate {
                path: "/test.rs".to_string(),
                heat: 0.8,
                in_context: true,
                last_action: Action::Read,
                turn_accessed: 3,
                timestamp_ms: 1700000000000,
            }],
            vec![],
        );

        let count = broadcast_line(&tx, &delta);
        assert_eq!(count, 1);

        let line = rx.try_recv().unwrap();
        assert!(line.ends_with('\n'));
        let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["type"], "delta");
        assert_eq!(parsed["seq"], 42);
    }
}
