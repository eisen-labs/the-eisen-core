//! Integration smoke test: validates the TCP wire format against DELTA_PROTOCOL.md.
//!
//! Spins up the full server stack (ContextTracker + tick loop + TCP server),
//! connects a TCP client, and validates every message type and field against
//! the spec.

use std::sync::Arc;
use std::time::Duration;

use eisen_core::tcp::{self, WireLine};
use eisen_core::tracker::ContextTracker;
use eisen_core::types::{Action, TrackerConfig};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};

// -----------------------------------------------------------------------
// Test harness: full server stack on an ephemeral port
// -----------------------------------------------------------------------

struct TestServer {
    port: u16,
    tracker: Arc<Mutex<ContextTracker>>,
    delta_tx: broadcast::Sender<WireLine>,
}

impl TestServer {
    async fn start() -> Self {
        Self::start_with_config(TrackerConfig::default()).await
    }

    async fn start_with_config(config: TrackerConfig) -> Self {
        let tracker = Arc::new(Mutex::new(ContextTracker::new(config)));
        let (delta_tx, _) = broadcast::channel::<WireLine>(64);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // TCP accept loop
        let t = tracker.clone();
        let tx = delta_tx.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let t2 = t.clone();
                let rx = tx.subscribe();
                tokio::spawn(async move {
                    let _ = tcp::serve_client(stream, t2, rx).await;
                });
            }
        });

        // Tick loop (mirrors main.rs but faster for tests)
        let t = tracker.clone();
        let tx = delta_tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            loop {
                interval.tick().await;
                let mut guard = t.lock().await;
                if let Some(delta) = guard.tick() {
                    tcp::broadcast_line(&tx, &delta);
                }
                for usage in guard.take_pending_usage() {
                    tcp::broadcast_line(&tx, &usage);
                }
            }
        });

        Self {
            port,
            tracker,
            delta_tx,
        }
    }

    async fn connect(&self) -> TestClient {
        let stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        TestClient {
            reader: BufReader::new(stream),
        }
    }
}

struct TestClient {
    reader: BufReader<TcpStream>,
}

impl TestClient {
    /// Read one ndJSON line, parse as serde_json::Value.
    async fn read_msg(&mut self) -> serde_json::Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
            .await
            .expect("timed out waiting for message")
            .expect("read error");
        assert!(line.ends_with('\n'), "wire line must end with newline");
        serde_json::from_str(line.trim()).expect("wire line must be valid JSON")
    }

    /// Send a raw ndJSON line to the server.
    async fn send(&mut self, msg: &serde_json::Value) {
        let line = serde_json::to_string(msg).unwrap() + "\n";
        self.reader
            .get_mut()
            .write_all(line.as_bytes())
            .await
            .unwrap();
    }
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

/// Validate snapshot wire format: fields, types, nested FileNode structure.
#[tokio::test]
async fn snapshot_wire_format() {
    let srv = TestServer::start().await;

    // Seed some state
    {
        let mut t = srv.tracker.lock().await;
        t.file_access("/home/user/src/auth.ts", Action::Write);
        t.file_access("/home/user/src/db.ts", Action::Read);
    }

    let mut client = srv.connect().await;
    let msg = client.read_msg().await;

    // Top-level fields per DELTA_PROTOCOL.md
    assert_eq!(msg["type"], "snapshot", "snapshot must have type=snapshot");
    assert!(msg["session_id"].is_string(), "session_id must be a string");
    assert!(msg["seq"].is_u64(), "seq must be u64");
    assert!(msg["nodes"].is_object(), "nodes must be an object");

    // FileNode structure
    let node = &msg["nodes"]["/home/user/src/auth.ts"];
    assert!(node.is_object(), "node must be an object keyed by path");
    assert_eq!(node["path"], "/home/user/src/auth.ts");
    assert!(node["heat"].is_f64(), "heat must be a number");
    let heat = node["heat"].as_f64().unwrap();
    assert!((0.0..=1.0).contains(&heat), "heat must be 0.0-1.0, got {heat}");
    assert!(node["in_context"].is_boolean(), "in_context must be bool");
    assert!(node["last_action"].is_string(), "last_action must be string");
    assert!(node["turn_accessed"].is_u64(), "turn_accessed must be u64");

    // Verify both nodes present
    assert!(msg["nodes"]["/home/user/src/db.ts"].is_object());
}

/// Validate delta wire format: fields, updates array, removed array.
#[tokio::test]
async fn delta_wire_format() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;
    let _snap = client.read_msg().await; // consume initial snapshot

    // Trigger a file access — tick loop will produce a delta
    {
        let mut t = srv.tracker.lock().await;
        t.file_access("/home/user/src/new.ts", Action::Search);
    }

    // Wait for tick to produce delta
    let msg = client.read_msg().await;
    assert_eq!(msg["type"], "delta", "expected delta message");
    assert!(msg["session_id"].is_string(), "session_id must be a string");
    assert!(msg["seq"].is_u64(), "seq must be u64");
    assert!(msg["updates"].is_array(), "updates must be array");
    assert!(msg["removed"].is_array(), "removed must be array");

    // NodeUpdate structure
    let updates = msg["updates"].as_array().unwrap();
    assert!(!updates.is_empty(), "should have at least one update");
    let update = &updates[0];
    assert_eq!(update["path"], "/home/user/src/new.ts");
    assert!(update["heat"].is_f64());
    assert!(update["in_context"].is_boolean());
    assert!(update["last_action"].is_string());
    assert!(update["turn_accessed"].is_u64());
}

/// Validate all Action variants serialize to the correct snake_case strings.
#[tokio::test]
async fn action_serialization() {
    let srv = TestServer::start().await;

    let actions = vec![
        ("/a", Action::UserProvided, "user_provided"),
        ("/b", Action::UserReferenced, "user_referenced"),
        ("/c", Action::Read, "read"),
        ("/d", Action::Write, "write"),
        ("/e", Action::Search, "search"),
    ];

    {
        let mut t = srv.tracker.lock().await;
        for (path, action, _) in &actions {
            t.file_access(path, *action);
        }
    }

    let mut client = srv.connect().await;
    let msg = client.read_msg().await;
    assert_eq!(msg["type"], "snapshot");

    for (path, _, expected_str) in &actions {
        let node = &msg["nodes"][path];
        assert_eq!(
            node["last_action"].as_str().unwrap(),
            *expected_str,
            "Action for {path} should serialize as {expected_str}"
        );
    }
}

/// Validate request_snapshot round-trip.
#[tokio::test]
async fn request_snapshot_round_trip() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;
    let snap1 = client.read_msg().await; // initial snapshot (empty)
    assert_eq!(snap1["type"], "snapshot");
    assert!(snap1["nodes"].as_object().unwrap().is_empty());

    // Add state after initial connection
    {
        let mut t = srv.tracker.lock().await;
        t.file_access("/x.rs", Action::Write);
    }

    // Request a fresh snapshot
    client
        .send(&serde_json::json!({"type": "request_snapshot"}))
        .await;

    // May receive a delta first from the tick loop — drain until we get snapshot
    let mut snap2 = client.read_msg().await;
    while snap2["type"] != "snapshot" {
        snap2 = client.read_msg().await;
    }

    assert_eq!(snap2["type"], "snapshot");
    assert!(snap2["nodes"]["/x.rs"].is_object(), "new file should be in snapshot");
}

/// Validate seq numbers are monotonically increasing across deltas.
#[tokio::test]
async fn seq_monotonic_across_deltas() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;
    let snap = client.read_msg().await;
    let mut last_seq = snap["seq"].as_u64().unwrap();

    // Generate several deltas
    for i in 0..3 {
        {
            let mut t = srv.tracker.lock().await;
            t.file_access(&format!("/file_{i}.rs"), Action::Read);
        }
        let msg = client.read_msg().await;
        let seq = msg["seq"].as_u64().unwrap();
        assert!(
            seq > last_seq,
            "seq must be monotonically increasing: {seq} > {last_seq}"
        );
        last_seq = seq;
    }
}

/// Validate that removed files appear in delta.removed after heat decays to zero.
#[tokio::test]
async fn removed_files_in_delta() {
    // Use aggressive decay so files prune quickly
    let config = TrackerConfig {
        context_turns: 0,  // exit context immediately on end_turn
        compaction_threshold: 0.5,
        decay_rate: 0.001, // heat drops below 0.01 in one tick
    };
    let srv = TestServer::start_with_config(config).await;

    {
        let mut t = srv.tracker.lock().await;
        t.file_access("/ephemeral.rs", Action::Read);
        t.end_turn(); // file exits context
    }

    let mut client = srv.connect().await;

    // Collect messages until we see the file in `removed`
    let mut found_removed = false;
    for _ in 0..20 {
        let msg = client.read_msg().await;
        if msg["type"] == "delta" {
            if let Some(removed) = msg["removed"].as_array() {
                if removed
                    .iter()
                    .any(|v| v.as_str() == Some("/ephemeral.rs"))
                {
                    found_removed = true;
                    break;
                }
            }
        }
        // snapshot won't have it if it already decayed
        if msg["type"] == "snapshot" {
            if !msg["nodes"]
                .as_object()
                .unwrap()
                .contains_key("/ephemeral.rs")
            {
                // File was already pruned before we connected — also acceptable
                found_removed = true;
                break;
            }
        }
    }
    assert!(found_removed, "file should appear in delta.removed after decay");
}

/// Validate usage messages are broadcast via the tick loop (not just direct broadcast).
/// This tests the fix for the usage_update broadcast gap.
#[tokio::test]
async fn usage_broadcast_via_tick_loop() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;
    let _snap = client.read_msg().await;

    // Call usage_update on the tracker — this queues a UsageMessage internally.
    // The tick loop should drain it and broadcast to TCP clients.
    {
        let mut t = srv.tracker.lock().await;
        t.usage_update(120_000, 200_000);
    }

    // Wait for the tick loop to pick it up (50ms interval in tests)
    let msg = client.read_msg().await;
    // We might get a delta first if there was state, but usage should come through
    // The test server has no prior file_access, so no delta — first message should be usage
    assert_eq!(msg["type"], "usage");
    assert_eq!(msg["used"], 120_000);
    assert_eq!(msg["size"], 200_000);
}

/// Validate usage message wire format when broadcast directly.
#[tokio::test]
async fn usage_message_wire_format() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;
    let _snap = client.read_msg().await;

    // Broadcast a usage message directly (simulating what the wiring layer does)
    let usage = eisen_core::types::UsageMessage::new("", "", 45_000, 200_000, None);
    tcp::broadcast_line(&srv.delta_tx, &usage);

    let msg = client.read_msg().await;
    assert_eq!(msg["type"], "usage");
    assert!(msg["session_id"].is_string(), "session_id must be a string");
    assert_eq!(msg["used"], 45_000);
    assert_eq!(msg["size"], 200_000);
    // cost should be absent (null/missing) when None
    assert!(msg["cost"].is_null(), "cost should be null when not provided");
}

/// Validate usage message with cost field.
#[tokio::test]
async fn usage_message_with_cost() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;
    let _snap = client.read_msg().await;

    let usage = eisen_core::types::UsageMessage::new(
        "",
        "",
        45_000,
        200_000,
        Some(eisen_core::types::Cost {
            amount: 0.04,
            currency: "USD".to_string(),
        }),
    );
    tcp::broadcast_line(&srv.delta_tx, &usage);

    let msg = client.read_msg().await;
    assert_eq!(msg["type"], "usage");
    assert_eq!(msg["cost"]["amount"], 0.04);
    assert_eq!(msg["cost"]["currency"], "USD");
}

/// Validate that multiple clients get the same messages.
#[tokio::test]
async fn multiple_clients_same_data() {
    let srv = TestServer::start().await;

    {
        let mut t = srv.tracker.lock().await;
        t.file_access("/shared.rs", Action::Write);
    }

    let mut c1 = srv.connect().await;
    let mut c2 = srv.connect().await;

    let snap1 = c1.read_msg().await;
    let snap2 = c2.read_msg().await;

    assert_eq!(snap1["type"], "snapshot");
    assert_eq!(snap2["type"], "snapshot");
    // Both should have the same file
    assert!(snap1["nodes"]["/shared.rs"].is_object());
    assert!(snap2["nodes"]["/shared.rs"].is_object());
}

/// Validate ndJSON framing: each message is exactly one line.
#[tokio::test]
async fn ndjson_framing() {
    let srv = TestServer::start().await;
    let mut client = srv.connect().await;

    // Read raw bytes to verify framing
    let mut line = String::new();
    client.reader.read_line(&mut line).await.unwrap();

    // Must be valid JSON
    let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(parsed["type"], "snapshot");

    // Must end with exactly one newline
    assert!(line.ends_with('\n'));
    assert!(!line.ends_with("\n\n"));

    // Must not contain embedded newlines (single line)
    assert_eq!(line.matches('\n').count(), 1);
}
