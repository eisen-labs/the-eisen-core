# eisen-core

The Rust binary that powers Eisen. It sits between an editor (like VS Code) and an AI coding agent, silently observing the JSON-RPC messages that flow between them. From those messages it extracts which files the agent is reading, writing, and searching, then serves that information over TCP so a UI can visualize agent activity in real time.

## How it works at a high level

```
Editor (stdin) ──> eisen-core ──> Agent (child process)
                      |
                      | (observes messages, extracts file context)
                      v
                 TCP server ──> UI clients (VS Code webview, etc.)
```

eisen-core is a **transparent stdio proxy**. The editor thinks it's talking directly to the agent, and the agent thinks it's talking directly to the editor. eisen-core just reads every line passing through, looks for file-related information, and forwards the line unchanged. It never modifies the messages.

On a separate TCP port, eisen-core broadcasts what it learned: which files are "hot" (recently touched), which are still in the agent's context window, and token usage statistics. UI clients connect to this port and receive a live stream of updates.

## Building and running

```bash
cd core
cargo build
cargo test

# Run it:
./target/debug/eisen-core --port 0 observe -- <agent-command> [agent-args...]

# Example with opencode:
./target/debug/eisen-core --port 0 observe -- opencode acp
```

When it starts, eisen-core prints the TCP port to stderr:

```
eisen: tcp server listening on port 54321
```

A UI client (like the VS Code extension) reads this line to know where to connect.

## Source files

```
core/
  src/
    main.rs        Entry point: CLI parsing, wiring, shutdown
    lib.rs         Module declarations (just `pub mod` lines)
    types.rs       Data structures for the wire protocol and tracker config
    tracker.rs     ContextTracker: the stateful core that tracks file activity
    extract.rs     Parses ACP JSON-RPC messages to find file paths
    proxy.rs       Bidirectional stdio proxy between editor and agent
    tcp.rs         TCP server that broadcasts state to UI clients
  tests/
    wire_format.rs Integration tests that validate the TCP wire protocol
  Cargo.toml       Package manifest and dependencies
```

---

## Module-by-module guide

### types.rs — Data structures

This file defines every struct that crosses a boundary: the wire protocol messages sent to UI clients, the internal file node representation, and the tracker configuration.

#### Wire protocol messages (server -> client)

These structs get serialized to JSON and sent over TCP. Every message has a `type` field (called `msg_type` in Rust because `type` is a reserved keyword — the `#[serde(rename = "type")]` attribute handles the JSON conversion).

**Snapshot** — Full state dump. Sent when a client first connects, or when a client explicitly requests one.

```rust
pub struct Snapshot {
    pub msg_type: String,    // always "snapshot"
    pub session_id: String,  // ACP session ID (empty until detected)
    pub seq: u64,            // sequence number, increments with each change
    pub nodes: HashMap<String, FileNode>,  // all tracked files, keyed by path
}
```

**Delta** — Incremental update. Sent every 100ms when something changed. Only includes files that were modified since the last delta.

```rust
pub struct Delta {
    pub msg_type: String,         // always "delta"
    pub session_id: String,
    pub seq: u64,
    pub updates: Vec<NodeUpdate>, // files that changed
    pub removed: Vec<String>,     // file paths that were pruned (heat decayed to zero)
}
```

**UsageMessage** — Token usage report. Sent whenever the agent reports how many tokens it's using.

```rust
pub struct UsageMessage {
    pub msg_type: String,    // always "usage"
    pub session_id: String,
    pub used: u32,           // tokens currently used
    pub size: u32,           // total context window size
    pub cost: Option<Cost>,  // optional cost tracking
}
```

#### FileNode and NodeUpdate

A `FileNode` represents one tracked file:

```rust
pub struct FileNode {
    pub path: String,          // absolute file path
    pub heat: f32,             // 0.0 to 1.0 — how "active" this file is
    pub in_context: bool,      // is this file still in the agent's context window?
    pub last_action: Action,   // what the agent last did with this file
    pub turn_accessed: u32,    // which turn it was last touched
}
```

`NodeUpdate` is identical but used inside deltas (it's a separate struct to keep serialization clean).

The `Action` enum tracks what kind of operation was performed:

```rust
pub enum Action {
    UserProvided,    // user embedded the file in their prompt (@mention)
    UserReferenced,  // user linked to the file in their prompt
    Read,            // agent read the file
    Write,           // agent wrote/edited the file
    Search,          // agent searched in this directory
}
```

These serialize to snake_case strings in JSON (`"user_provided"`, `"read"`, etc.) thanks to the `#[serde(rename_all = "snake_case")]` attribute.

#### TrackerConfig

Tuning knobs for the tracker's behavior:

```rust
pub struct TrackerConfig {
    pub context_turns: u32,         // turns before a file exits context (default: 3)
    pub compaction_threshold: f32,  // usage drop ratio that signals compaction (default: 0.5)
    pub decay_rate: f32,            // heat multiplier per tick for cooling files (default: 0.95)
}
```

#### Constructors

All three wire message types have `::new()` constructors that take `session_id: &str` as the first argument. This converts the `&str` to an owned `String` internally, so callers don't need to worry about ownership:

```rust
Snapshot::new("sess_123", seq, nodes)
Delta::new("sess_123", seq, updates, removed)
UsageMessage::new("sess_123", used, size, cost)
```

---

### tracker.rs — ContextTracker

This is the brain of eisen-core. It maintains a map of every file the agent has touched, tracks which ones are still "in context", applies heat decay over time, and generates the snapshots/deltas that get sent to UI clients.

#### How the tracker works conceptually

Think of it like a heat map of your codebase:

- When the agent reads or writes a file, that file's **heat** goes to 1.0 (maximum).
- Every 100ms (one "tick"), files that are no longer in context cool down — their heat is multiplied by `decay_rate` (0.95 by default).
- When heat drops below 0.01, the file is considered cold and gets pruned from the map entirely.
- Files are considered **in context** if they were accessed within the last `context_turns` turns. A "turn" is one prompt-response cycle between the user and the agent.

#### The struct

```rust
pub struct ContextTracker {
    session_id: String,                 // ACP session ID
    files: HashMap<String, FileNode>,   // all tracked files
    seq: u64,                           // monotonically increasing sequence number
    current_turn: u32,                  // current turn counter
    last_used_tokens: u32,              // for compaction detection
    context_size: u32,                  // total context window size
    config: TrackerConfig,              // tuning knobs
    dirty: HashMap<String, ()>,         // paths that changed since last tick
    pending_usage: Vec<UsageMessage>,   // usage messages waiting to be broadcast
}
```

The `dirty` map is a key optimization. Instead of comparing the entire file map every tick, we only look at files that actually changed. When `file_access()`, `end_turn()`, or `usage_update()` modify a file, they add its path to `dirty`. Then `tick()` only processes those paths.

#### Public API

**`file_access(path, action)`** — Call this whenever you detect the agent touching a file. Sets heat to 1.0, marks it as in-context, records the action type, and updates the turn counter.

**`usage_update(used, size)`** — Call this when the agent reports token usage. If usage drops sharply (by more than `compaction_threshold`), all files are evicted from context — this means the LLM runtime compacted/summarized the context window.

**`end_turn()`** — Call this when the agent finishes responding. Increments the turn counter and checks if any files have been idle too long (more than `context_turns` since last access).

**`tick()`** — Called every 100ms by the tick loop. Applies heat decay to non-context files, collects all dirty changes, and returns a `Delta` if anything changed. Returns `None` on quiet ticks.

**`snapshot()`** — Returns a full `Snapshot` of the current state. Only includes files that are warm (heat > 0) or in context.

**`set_session_id(id)` / `session_id()`** — Getter/setter for the ACP session ID. The session ID is embedded in every snapshot, delta, and usage message.

**`take_pending_usage()`** — Drains the queue of `UsageMessage`s that were created by `usage_update()`. The tick loop calls this to broadcast them to TCP clients.

#### Compaction detection

When the agent's LLM runtime compacts the context window (summarizes old messages to free up tokens), eisen-core detects this as a sudden drop in token usage. For example, if usage goes from 180k to 45k tokens, that's a 75% drop — well above the default 50% threshold.

When compaction is detected, all files are marked as out-of-context. This reflects reality: after compaction, the LLM has lost the detailed file contents and only retains summaries. Files that the agent re-accesses afterward will re-enter context.

#### Concurrency model

`ContextTracker` is NOT internally synchronized. It's wrapped in `Arc<Mutex<ContextTracker>>` by main.rs. Every access to the tracker goes through `tracker.lock().await`. This is a `tokio::sync::Mutex` (not `std::sync::Mutex`), which means the lock can be held across `.await` points without deadlocking the async runtime.

The lock is held for very short durations — just long enough to call one method like `file_access()` or `tick()`. This keeps contention low.

---

### extract.rs — ACP message parsing

This module reads JSON-RPC messages from the ACP (Agent Client Protocol) stream and extracts file-related information. It's the bridge between raw protocol messages and the tracker.

#### What is ACP?

ACP is the protocol that editors and AI coding agents use to communicate. Messages flow as ndJSON (newline-delimited JSON) over stdio. Each message is a JSON-RPC request, response, or notification.

eisen-core uses the `agent-client-protocol-schema` crate for type definitions. This is a **types-only** crate — it gives us Rust structs like `PromptRequest`, `SessionNotification`, `ReadTextFileRequest`, etc., but no runtime behavior. We just use them for deserialization.

#### Two entry points

**`extract_upstream(line, tracker)`** — Parses messages going from editor to agent. Currently handles:

- `session/prompt` — The user's prompt. May contain embedded file contents (`ContentBlock::Resource` -> `UserProvided` action) or file links (`ContentBlock::ResourceLink` -> `UserReferenced` action).

**`extract_downstream(line, tracker)`** — Parses messages going from agent to editor. Handles:

- `session/update` — Agent activity notifications. Contains tool calls with file locations and diff content.
- `fs/read_text_file` — Agent reading a file.
- `fs/write_text_file` — Agent writing a file.
- JSON-RPC responses with `stopReason` — End of an agent turn (triggers `tracker.end_turn()`).
- JSON-RPC responses with `sessionId` — Auto-detects the session ID from `session/new` responses.

#### How extraction works

Each function:

1. Parses the line as JSON. If it fails, silently returns (not all lines are JSON).
2. Checks for a `method` field to identify the message type.
3. Deserializes the `params` into the appropriate typed struct from the ACP schema crate.
4. Extracts file paths and calls `tracker.file_access(path, action)`.

For tool calls, the `ToolKind` enum from ACP maps to our `Action` enum:

- `ToolKind::Read` -> `Action::Read`
- `ToolKind::Edit`, `Delete`, `Move` -> `Action::Write`
- `ToolKind::Search` -> `Action::Search`
- Everything else defaults to `Action::Read`

#### Session ID auto-detection

When the agent creates a new session, the response looks like:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "sessionId": "sess_abc123" } }
```

`extract_downstream` picks up the `sessionId` field and calls `tracker.set_session_id()`. It only does this if the tracker's session ID is currently empty — a `--session-id` CLI flag takes priority over auto-detection.

#### URI handling

ACP uses `file://` URIs for file paths. The `uri_to_path()` helper strips the `file://` prefix to get a filesystem path. Non-file URIs (like `https://`) are ignored.

---

### proxy.rs — Stdio proxy

This is the simplest module. It creates two async tasks that shuttle lines between the editor and the agent, calling the extraction functions along the way.

#### spawn_agent(command, args)

Starts the agent as a child process with:

- **stdin** piped (so we can write to it)
- **stdout** piped (so we can read from it)
- **stderr** inherited (agent errors go straight to the terminal)
- **kill_on_drop** enabled (if eisen-core exits, the agent gets killed automatically)

#### upstream_task(tracker, agent_stdin)

Reads lines from the editor's stdin, calls `extract_upstream()` on each line, then forwards the line unchanged to the agent's stdin. Runs until the editor closes stdin (EOF).

#### downstream_task(tracker, agent_stdout)

Reads lines from the agent's stdout, calls `extract_downstream()` on each line, then forwards the line unchanged to the editor's stdout. Runs until the agent closes stdout (exits).

Both tasks acquire the tracker lock briefly for each line, then release it before doing any I/O. This is important — you don't want to hold a lock while waiting for a write to complete.

---

### tcp.rs — TCP server

Serves the tracker's state to UI clients over TCP. Each message is one line of JSON (ndJSON framing).

#### serve(listener, tracker, delta_tx)

The main accept loop. Takes a pre-bound `TcpListener` (the caller binds it so they can discover the actual port before this function starts). For each incoming connection, spawns a task to handle that client.

The `delta_tx` parameter is a `broadcast::Sender<WireLine>`. This is Tokio's broadcast channel — one producer (the tick loop), many consumers (TCP client tasks). When the tick loop produces a delta, it gets cloned to every connected client.

#### handle_client(stream, tracker, delta_rx)

Handles one TCP client connection. Does three things:

1. **On connect**: Sends a full snapshot immediately so the client has the current state.

2. **Delta forwarding**: Listens on the broadcast channel and forwards every delta/usage message to the client. If the client falls behind (the channel buffer fills up), it gets a `Lagged` error. The handler recovers by sending a fresh snapshot — the client resyncs.

3. **Client requests**: Reads lines from the client. The only supported message is `{"type":"request_snapshot"}`, which triggers sending a fresh snapshot.

The writer half of the TCP stream is shared between the delta forwarder and the request handler using an `Arc<Mutex<>>` on the write half. Both tasks might need to write at the same time (a delta arrives while we're sending a snapshot response), so we serialize writes through the lock.

#### broadcast_line(tx, value)

Helper that serializes any `Serialize`-able value to JSON, appends a newline, and sends it through the broadcast channel. Returns the number of receivers that got it (0 if no clients are connected, which is fine).

#### parse_port()

Scans command-line args for `--port <N>`. Falls back to `DEFAULT_PORT` (17320) if not provided. The extension typically passes `--port 0` for ephemeral port allocation.

---

### main.rs — Entry point and wiring

Ties everything together. Here's what happens on startup:

1. **Initialize tracing** — Log output controlled by `EISEN_LOG` env var (defaults to `warn`). Logs go to stderr.

2. **Parse CLI** — Extracts `--port`, `--session-id`, and the `-- <command> [args...]` separator. The agent command comes after `--`.

3. **Create tracker** — Builds a `ContextTracker` with default config, optionally sets a CLI-provided session ID, wraps in `Arc<Mutex<>>`.

4. **Bind TCP listener** — Binds before spawning any tasks so the actual port is known immediately. Prints `eisen: tcp server listening on port XXXXX` to stderr.

5. **Spawn agent** — Starts the agent child process with piped stdio.

6. **Spawn four async tasks**:
   - **Upstream proxy** — editor stdin -> agent stdin (with extraction)
   - **Downstream proxy** — agent stdout -> editor stdout (with extraction)
   - **Tick loop** — every 100ms, calls `tracker.tick()` and broadcasts deltas
   - **TCP server** — accepts client connections and serves state

7. **Wait for shutdown** — Uses `tokio::select!` to wait for whichever happens first: agent exits, editor disconnects, agent stdout closes, or Ctrl+C. Then aborts the tick loop and TCP server tasks so the process exits cleanly.

#### CLI format

```
eisen-core [--port N] [--session-id ID] observe -- <agent-command> [agent-args...]
```

- `--port 0` — Use an ephemeral port (OS assigns one). Recommended for programmatic use.
- `--port 17320` — Use the default fixed port. Good for manual testing.
- `--session-id sess_123` — Pre-set the session ID. Takes priority over auto-detection.

---

### tests/wire_format.rs — Integration tests

End-to-end tests that spin up the full stack (tracker + tick loop + TCP server) on an ephemeral port, connect a TCP client, and validate every message against the wire protocol spec.

#### Test harness

`TestServer` starts a tracker, tick loop (50ms interval for faster tests), and TCP accept loop on port 0. `TestClient` wraps a TCP connection with helpers to read/send ndJSON messages.

#### What the tests validate

- **snapshot_wire_format** — Snapshot has all required fields with correct types (`type`, `session_id`, `seq`, `nodes`, and nested `FileNode` fields).
- **delta_wire_format** — Delta has `type`, `session_id`, `seq`, `updates[]`, `removed[]`, and `NodeUpdate` structure.
- **action_serialization** — All five `Action` variants serialize to the correct snake_case strings.
- **request_snapshot_round_trip** — Client can request a fresh snapshot after state changes.
- **seq_monotonic_across_deltas** — Sequence numbers always increase.
- **removed_files_in_delta** — Files appear in `delta.removed` after their heat decays to zero.
- **usage_broadcast_via_tick_loop** — Usage messages queued by `usage_update()` get broadcast through the tick loop.
- **usage_message_wire_format** — Usage messages have correct fields, `cost` is null when not provided.
- **usage_message_with_cost** — Cost object serializes correctly when present.
- **multiple_clients_same_data** — Two clients connected simultaneously receive the same snapshots.
- **ndjson_framing** — Each message is exactly one JSON line terminated by `\n`.

---

## Dependencies

| Crate                            | Purpose                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `serde` + `serde_json`           | JSON serialization/deserialization for all wire messages          |
| `tokio`                          | Async runtime — tasks, timers, TCP, process spawning, signals     |
| `anyhow`                         | Ergonomic error handling (`Result<T>` without custom error types) |
| `agent-client-protocol-schema`   | ACP type definitions (structs only, no runtime)                   |
| `tracing` + `tracing-subscriber` | Structured logging to stderr                                      |

## Wire protocol summary

All messages are newline-delimited JSON (ndJSON) over TCP.

### Server -> Client

| Message                                                                       | When sent                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `{"type":"snapshot","session_id":"...","seq":N,"nodes":{...}}`                | On connect, on `request_snapshot`, on lag recovery |
| `{"type":"delta","session_id":"...","seq":N,"updates":[...],"removed":[...]}` | Every 100ms when state changed                     |
| `{"type":"usage","session_id":"...","used":N,"size":N,"cost":null}`           | When agent reports token usage                     |

### Client -> Server

| Message                       | Effect                               |
| ----------------------------- | ------------------------------------ |
| `{"type":"request_snapshot"}` | Server responds with a full snapshot |

## Test counts

```
tracker.rs    40 tests (36 original + 4 session_id)
extract.rs    24 tests (21 original + 3 session_id)
tcp.rs         4 tests
wire_format.rs 11 tests
─────────────────
Total          79 unit + 3 binary = 82 tests
```

Run with `cargo test` from the `core/` directory.
