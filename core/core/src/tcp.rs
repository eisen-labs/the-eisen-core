use std::sync::Arc;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex};
use tracing::debug;

use crate::tracker::ContextTracker;

/// Default TCP port for the eisen-core delta server.
pub const DEFAULT_PORT: u16 = 17320;

/// Parse `--port <N>` from command-line args, falling back to `DEFAULT_PORT`.
///
/// Simple manual parsing — no external dependency. Scans `std::env::args()`
/// for `--port` followed by a valid u16. Dev A can replace this with a
/// proper arg parser (e.g. clap) when adding the full CLI.
pub fn parse_port() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len().saturating_sub(1) {
        if args[i] == "--port" {
            if let Ok(port) = args[i + 1].parse::<u16>() {
                return port;
            }
        }
    }
    DEFAULT_PORT
}

/// Serialized ndJSON line, ready to write to a TCP socket.
/// Includes the trailing newline.
pub type WireLine = String;

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
) -> Result<()> {
    loop {
        let (stream, addr) = listener.accept().await?;
        debug!(client = %addr, "TCP client connected");
        let tracker = tracker.clone();
        let delta_rx = delta_tx.subscribe();

        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, tracker, delta_rx).await {
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
/// without going through the accept loop. Also re-exported as `serve_client`.
pub async fn handle_client(
    stream: tokio::net::TcpStream,
    tracker: Arc<Mutex<ContextTracker>>,
    mut delta_rx: broadcast::Receiver<WireLine>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();

    // Send initial snapshot
    {
        let snap = tracker.lock().await.snapshot();
        debug!(
            node_count = snap.nodes.len(),
            seq = snap.seq,
            "sending initial snapshot to TCP client"
        );
        let json = serde_json::to_string(&snap)? + "\n";
        writer.write_all(json.as_bytes()).await?;
    }

    let tracker_for_reader = tracker.clone();

    // Task: read client messages (only request_snapshot is defined)
    let mut buf_reader = BufReader::new(reader);

    // We need shared write access between the delta forwarder and the
    // snapshot responder. Use a Mutex on the writer.
    let writer = Arc::new(Mutex::new(writer));
    let writer_for_deltas = writer.clone();
    let writer_for_requests = writer.clone();

    // Forward deltas to the client
    let delta_task = tokio::spawn(async move {
        loop {
            match delta_rx.recv().await {
                Ok(line) => {
                    debug!(bytes = line.len(), "forwarding delta to TCP client");
                    let mut w = writer_for_deltas.lock().await;
                    if w.write_all(line.as_bytes()).await.is_err() {
                        break; // client disconnected
                    }
                }
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    // Client was too slow — send a fresh snapshot to resync
                    debug!(lagged = count, "client lagged, sending fresh snapshot");
                    let snap = tracker.lock().await.snapshot();
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
                    if let Ok(msg) =
                        serde_json::from_str::<crate::types::ClientMessage>(line.trim())
                    {
                        debug!(msg_type = msg.msg_type.as_str(), "received client message");
                        if msg.msg_type == "request_snapshot" {
                            let snap = tracker_for_reader.lock().await.snapshot();
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
                        // Unknown message types are silently ignored
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

/// Serialize a delta (or usage message) to a wire line and broadcast it
/// to all connected TCP clients.
///
/// Returns `Ok(receivers)` with the number of active receivers, or
/// `Err` if there are no active receivers (which is fine — it just means
/// no TCP clients are connected).
/// Alias for `handle_client` — convenience name for integration tests.
pub async fn serve_client(
    stream: tokio::net::TcpStream,
    tracker: Arc<Mutex<ContextTracker>>,
    delta_rx: broadcast::Receiver<WireLine>,
) -> Result<()> {
    handle_client(stream, tracker, delta_rx).await
}

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
    use crate::types::{Action, TrackerConfig};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// Helper: start a TCP server on an ephemeral port, return the port
    /// and broadcast sender.
    async fn start_test_server() -> (u16, broadcast::Sender<WireLine>, Arc<Mutex<ContextTracker>>)
    {
        let tracker = Arc::new(Mutex::new(ContextTracker::new(TrackerConfig::default())));
        let (delta_tx, _) = broadcast::channel::<WireLine>(64);

        // Bind to port 0 for ephemeral port assignment
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let t = tracker.clone();
        let tx = delta_tx.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let t2 = t.clone();
                let rx = tx.subscribe();
                tokio::spawn(async move {
                    let _ = handle_client(stream, t2, rx).await;
                });
            }
        });

        (port, delta_tx, tracker)
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
        let (port, _tx, tracker) = start_test_server().await;

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
        let (port, delta_tx, tracker) = start_test_server().await;

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
        let (port, _tx, tracker) = start_test_server().await;

        tracker
            .lock()
            .await
            .file_access("/src/a.rs", Action::Read);

        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let _snap = read_line(&mut stream).await; // initial snapshot

        // Add another file after connection
        tracker
            .lock()
            .await
            .file_access("/src/b.rs", Action::Write);

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
