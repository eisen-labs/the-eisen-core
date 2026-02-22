# Eisen Core Architecture Documentation

## Overview

**eisen-core** is a Rust-based observability layer that sits between an AI coding agent and its editor, transparently tracking file access patterns and broadcasting real-time activity data to UI clients. It operates as a stdio proxy that never modifies messages, only observes and extracts context.

**Key Capabilities:**
- Real-time file activity tracking with heat-based decay
- Multi-session support with orchestrator mode for coordinating multiple agents
- Zone-based access control for region-isolated development
- Session persistence and state management
- TCP broadcast server for UI integration
- Code parsing and graph generation for visualization

---

## Architecture Diagram

```
Editor (stdin) ──> eisen-core ──> Agent (child process)
                      |
                      | (observes ACP messages, extracts file context)
                      |
                      ├─> ContextTracker (per-session state)
                      ├─> SessionRegistry (persistent storage)
                      ├─> OrchestratorAggregator (multi-agent coordination)
                      |
                      v
                 TCP Server ──> UI Clients (VS Code webview, etc.)
```

---

## Core Modules

### 1. **types.rs** — Data Structures & Wire Protocol

Defines all data structures that cross module boundaries, including wire protocol messages sent to UI clients.

#### Action Enum
```rust
pub enum Action {
    UserProvided,    // User embedded file in prompt (@mention)
    UserReferenced,  // User linked to file in prompt
    Read,           // Agent read file
    Write,          // Agent wrote/edited file
    Search,         // Agent searched (path is a directory)
    Blocked,        // Out-of-zone access blocked by proxy
}
```

#### FileNode — Tracked File State
```rust
pub struct FileNode {
    pub path: String,
    pub heat: f32,              // 0.0-1.0 activity level
    pub in_context: bool,       // Still in agent's context window?
    pub last_action: Action,
    pub turn_accessed: u32,     // Which turn was it last touched
    pub timestamp_ms: u64,      // Wall-clock timestamp for LWW merge
}
```

#### Wire Messages (Server → Client)

**Snapshot** — Full state dump on connect:
```rust
pub struct Snapshot {
    pub msg_type: String,       // always "snapshot"
    pub agent_id: String,
    pub session_id: String,
    pub session_mode: SessionMode,
    pub seq: u64,
    pub nodes: HashMap<String, FileNode>,
}
```

**Delta** — Incremental updates every 100ms:
```rust
pub struct Delta {
    pub msg_type: String,       // always "delta"
    pub agent_id: String,
    pub session_id: String,
    pub session_mode: SessionMode,
    pub seq: u64,
    pub updates: Vec<NodeUpdate>,
    pub removed: Vec<String>,
}
```

**UsageMessage** — Token usage reports:
```rust
pub struct UsageMessage {
    pub msg_type: String,       // always "usage"
    pub agent_id: String,
    pub session_id: String,
    pub session_mode: SessionMode,
    pub used: u32,
    pub size: u32,
    pub cost: Option<Cost>,
}
```

**BlockedAccess** — Zone violation notifications:
```rust
pub struct BlockedAccess {
    pub msg_type: String,       // always "blocked"
    pub agent_id: String,
    pub session_id: String,
    pub path: String,
    pub action: String,         // "read" or "write"
    pub timestamp_ms: u64,
}
```

#### Session Management Types

**SessionMode**:
- `SingleAgent` — Standard single-agent session
- `Orchestrator` — Coordinator session aggregating multiple providers

**SessionState** — Persistent session data:
```rust
pub struct SessionState {
    pub agent_id: String,
    pub session_id: String,
    pub mode: SessionMode,
    pub model: Option<SessionModel>,
    pub history: Vec<Value>,
    pub summary: Option<String>,
    pub context: Vec<Value>,
    pub providers: Vec<SessionKey>,  // For orchestrator mode
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
```

#### Zone Configuration

```rust
pub struct ZoneConfig {
    pub allowed: Vec<String>,   // Glob patterns like ["src/ui/**"]
    pub denied: Vec<String>,    // Denied patterns (override allowed)
}
```

Supports glob matching with `*` (single segment) and `**` (any depth).

---

### 2. **tracker.rs** — Context Tracking Engine

The heart of eisen-core. Maintains a heat map of file activity across multiple sessions.

#### SessionTracker (Internal)
Per-session state tracking:

```rust
struct SessionTracker {
    session_id: String,
    session_mode: SessionMode,
    files: HashMap<String, FileNode>,
    seq: u64,              // Monotonic sequence number
    current_turn: u32,     // Current conversation turn
    last_used_tokens: u32,
    context_size: u32,
    config: TrackerConfig,
    changed_paths: HashSet<String>,  // Dirty tracking for efficient deltas
    pending_usage: Vec<UsageMessage>,
}
```

#### ContextTracker (Public API)
Multi-session tracker with workspace awareness:

**Key Methods:**
- `file_access(path, action)` — Record file access, set heat to 1.0
- `usage_update(used, size)` — Track token usage, detect compaction
- `end_turn()` — Advance turn counter, expire stale files from context
- `tick()` — Apply heat decay, return delta if changed
- `snapshot()` — Full state for new TCP clients

**Heat Decay Algorithm:**
1. Files accessed → heat = 1.0, marked in_context
2. Each tick (100ms), non-context files decay: `heat *= decay_rate` (default 0.95)
3. When heat < 0.01, set to 0.0 and prune from map
4. Files exit context after `context_turns` turns without access

**Compaction Detection:**
When token usage drops by >50% (configurable threshold), assume LLM context was compacted. All files evicted from context.

**Path Normalization:**
- Strips workspace root to create relative paths
- Filters out ignored directories: `node_modules`, `.git`, `dist`, etc.
- Converts backslashes to forward slashes

---

### 3. **proxy.rs** — Transparent Stdio Proxy

Manages bidirectional message flow between editor and agent.

#### Core Functions

**spawn_agent(command, args)** — Spawns agent as child process with piped stdio.

**upstream_task(tracker, agent_stdin)** — Editor → Agent
1. Read lines from editor stdin
2. Extract context via `extract::extract_upstream()`
3. Forward unchanged to agent stdin

**downstream_task(tracker, agent_stdout, zone_config, blocked_tx)** — Agent → Editor
1. Read lines from agent stdout
2. **Zone enforcement**: If `zone_config` is set, intercept `fs/read_text_file` and `fs/write_text_file`:
   - Check if path allowed by `zone.is_allowed(path)`
   - If blocked: send JSON-RPC error to agent, broadcast `BlockedAccess`, skip forwarding
   - If allowed: continue normal flow
3. Extract context via `extract::extract_downstream()`
4. Forward to editor stdout

**Zone Violation Response:**
```json
{
  "jsonrpc": "2.0",
  "id": <request_id>,
  "error": {
    "code": -32001,
    "message": "Outside agent zone: <path>. Request cross-region info through the orchestrator."
  }
}
```

---

### 4. **extract.rs** — ACP Message Parsing

Parses Agent Client Protocol (ACP) JSON-RPC messages to extract file operations.

#### Upstream Extraction (Editor → Agent)

**`extract_upstream(line, tracker)`**

Handles:
- `session/prompt` — User prompts containing:
  - `ContentBlock::Resource` → `Action::UserProvided`
  - `ContentBlock::ResourceLink` → `Action::UserReferenced`
- `terminal/output` responses — Extracts file paths from terminal output

#### Downstream Extraction (Agent → Editor)

**`extract_downstream(line, tracker)`**

Handles:
- `session/update` — Tool call notifications:
  - `ToolCall::Update` with `ToolKind::Read` → `Action::Read`
  - `ToolKind::Edit/Delete/Move` → `Action::Write`
  - `ToolKind::Search` → `Action::Search`
  - Extracts paths from `location.uri` and `diff` content
- `fs/read_text_file` → `Action::Read`
- `fs/write_text_file` → `Action::Write`
- `terminal/output` requests — Track request ID for response matching

**Session ID Auto-Detection:**
Looks for `sessionId` in:
1. `params.sessionId` (requests)
2. `result.sessionId` (session/new response)

**End-Turn Detection:**
Detects `result.stopReason` in PromptResponse to call `tracker.end_turn()`

**Terminal Output Parsing:**
Extracts file paths from terminal output using regex patterns for common formats:
- `path/to/file.rs:123:45` (line:column)
- `"path/to/file.ts"` (quoted paths)
- `Error in /path/to/file.py` (error messages)

---

### 5. **tcp.rs** — Broadcast Server

Serves real-time updates to UI clients via TCP.

#### Server Architecture

**`serve(listener, tracker, delta_tx, registry, orchestrator)`**
- Accept loop spawning `handle_client` per connection
- Pre-bound listener allows ephemeral port allocation

**`handle_client(stream, tracker, delta_rx, registry, orchestrator)`**
- Sends snapshot immediately on connect
- Spawns two concurrent tasks:
  1. **Delta forwarder**: Streams deltas from broadcast channel
  2. **Request handler**: Processes client RPC calls

**Stream Filtering:**
Clients can filter messages by session or mode:
```rust
enum StreamFilter {
    All,
    Session(String),
    Mode(SessionMode),
}
```

#### Client → Server Messages

**Request Snapshot:**
```json
{"type": "request_snapshot", "session_id": "optional_session"}
```

**Set Stream Filter:**
```json
{"type": "set_stream_filter", "session_id": "sess_123"}
{"type": "set_stream_filter", "session_mode": "orchestrator"}
```

**RPC Calls:**
```json
{
  "type": "rpc",
  "id": "req_1",
  "method": "list_sessions",
  "params": {"agent_id": "opencode-a1b2c3"}
}
```

#### RPC Methods

| Method | Description |
|--------|-------------|
| `list_sessions` | List all sessions, optionally filtered by agent_id |
| `create_session` | Create/update session with mode, model, history, providers |
| `close_session` | Remove session from registry |
| `set_active_session` | Set default session for tracker |
| `get_session_state` | Retrieve full session state |
| `set_orchestrator_providers` | Configure orchestrator provider list |
| `add_context_items` | Append items to session context array |

**Lag Recovery:**
If client falls behind broadcast buffer, sends fresh snapshot to resync.

---

### 6. **session_registry.rs** — Persistent Session Management

Manages session lifecycle with JSON file persistence.

#### Storage Location
Default: `$HOME/.eisen/core_sessions.json` (or `$EISEN_DIR`)

#### SessionRegistry API

**Persistence Operations:**
- `load_default()` / `load_from_path(path)` — Load from disk
- `persist()` — Atomic write with temp file + rename

**Session Management:**
- `create_session(...)` — Create or update session
- `close_session(key)` — Remove session
- `set_active_session(key)` — Set default session
- `get_session_state(key)` — Retrieve session

**Orchestrator Operations:**
- `orchestrator_sessions()` — List all orchestrator-mode sessions
- `set_orchestrator_providers(key, providers)` — Set provider list
- `add_context_items(key, items)` — Append context

**Query:**
- `list_sessions(agent_id)` — List sessions sorted by updated_at_ms
- `active_session()` — Get currently active session key

#### Storage Format
```json
{
  "active": {
    "agent_id": "opencode-a1b2c3",
    "session_id": "sess_123"
  },
  "sessions": [
    {
      "agent_id": "opencode-a1b2c3",
      "session_id": "sess_123",
      "mode": "single_agent",
      "model": {"model_id": "claude-sonnet-4", "name": null},
      "history": [...],
      "summary": null,
      "context": [...],
      "providers": [],
      "created_at_ms": 1234567890123,
      "updated_at_ms": 1234567890456
    }
  ]
}
```

---

### 7. **orchestrator.rs** — Multi-Agent Aggregation

Coordinates multiple single-agent sessions into unified orchestrator view.

#### OrchestratorAggregator

**State Management:**
```rust
struct OrchestratorSessionState {
    seq: u64,
    nodes: HashMap<String, FileNode>,
    provider_usage: HashMap<SessionKey, UsageMessage>,
}
```

**Core Operations:**

**`snapshot_for_session(session, tracker)`**
- Aggregates nodes from all provider sessions
- Applies LWW (last-write-wins) merge based on `timestamp_ms`
- Returns unified snapshot with orchestrator session_id

**`tick(tracker, registry)`**
- Called by main tick loop
- Generates deltas for all orchestrator sessions
- Diff algorithm computes minimal updates/removed sets

**`aggregate_usage(tracker, registry, usage_msgs)`**
- Sums token usage across provider sessions
- Aggregates costs (if same currency)
- Returns usage messages for orchestrator sessions

#### Node Merge Strategy

**Last-Write-Wins with Priority:**
```rust
fn merge_node(target: &mut HashMap, node: &FileNode) {
    match target.get_mut(&node.path) {
        None => insert node,
        Some(existing) => {
            heat = max(existing.heat, node.heat)
            in_context = existing.in_context || node.in_context
            turn_accessed = max(existing.turn_accessed, node.turn_accessed)
            
            // LWW for last_action, with tie-breaking by priority
            if node.timestamp_ms > existing.timestamp_ms {
                existing.last_action = node.last_action
            } else if timestamps equal {
                // Write > Search > others
                if action_priority(node) > action_priority(existing) {
                    existing.last_action = node.last_action
                }
            }
        }
    }
}
```

---

### 8. **flatten.rs** — Code Graph Generation

Converts parsed syntax trees into UI-friendly graph snapshots.

#### Purpose
Transforms parser output (detailed AST) into simplified graph for webview visualization.

#### UI Node Types
Parser `NodeKind` → UI kind mapping:
- `Folder` → `"folder"`
- `File` → `"file"`
- `Class/Struct/Trait/Interface/Enum/Impl` → `"class"`
- `Method` → `"method"`
- `Function/Const/Type/Mod` → `"function"`

#### Call Edge Resolution
```rust
pub struct UiCallEdge {
    pub from: String,  // caller node ID
    pub to: String,    // callee node ID
}
```

**Resolution Algorithm:**
1. Parse AST to extract function call names
2. Build name→ID index for all functions/methods
3. For each caller's call list:
   - Skip trivial names (len, print, new, etc.)
   - Match by name to candidate IDs
   - Prefer same-file matches for disambiguation
   - Generate edge from caller to callee

**Node ID Format:**
- Files: relative path `"src/ui/button.tsx"`
- Symbols: `"<file_path>::<symbol_name>"`

---

### 9. **main.rs** — Entry Point & Orchestration

#### CLI Commands

**`snapshot --root PATH`**
Parses workspace and prints UI snapshot JSON (one-shot mode).

**`observe --port N --agent-id ID --session-id ID --zone PATTERN --deny PATTERN -- <command> [args]`**
Proxy mode with full tracking.

**Flags:**
- `--port 0` — Ephemeral port (recommended)
- `--agent-id` — Instance identifier (e.g., `opencode-a1b2c3`)
- `--session-id` — Override auto-detected session
- `--cwd` — Workspace root for path normalization
- `--zone` — Allowed glob pattern (repeatable)
- `--deny` — Denied glob pattern (repeatable)

#### Observe Mode Lifecycle

1. **Setup:**
   - Initialize tracker with config
   - Set agent_id, session_id, workspace root
   - Build zone config from CLI flags
   - Bind TCP listener (port 0 for ephemeral)
   - Print `eisen-core tcp port: XXXXX` to stderr

2. **Spawn Tasks:**
   - **Agent child process** with piped stdio
   - **Upstream proxy** (editor stdin → agent stdin)
   - **Downstream proxy** (agent stdout → editor stdout)
   - **TCP server** (accept loop)
   - **Tick loop** (100ms decay + delta broadcast)

3. **Tick Loop:**
   ```rust
   loop {
       interval.tick().await;
       
       // Broadcast usage messages
       let usage = tracker.take_pending_usage_all();
       let orch_usage = orchestrator.aggregate_usage(...);
       for msg in usage + orch_usage {
           broadcast_line(&delta_tx, &msg);
       }
       
       // Generate and broadcast deltas
       let single_deltas = tracker.tick_all();
       let orch_deltas = orchestrator.tick(...);
       for delta in single_deltas + orch_deltas {
           broadcast_line(&delta_tx, &delta);
       }
       
       // Adaptive interval (100ms active, 500ms idle)
       if no_activity_for_20_ticks {
           interval = 500ms;
       }
   }
   ```

4. **Shutdown:**
   - Detects agent exit, editor disconnect, or Ctrl+C
   - Aborts tick loop and TCP server
   - Process exits cleanly

---

## Data Flow Diagrams

### File Access Flow
```
1. Agent sends fs/read_text_file request
   ↓
2. downstream_task intercepts in proxy.rs
   ↓
3. Zone check (if configured)
   ├─ Allowed: continue to step 4
   └─ Blocked: return error, broadcast BlockedAccess, record Action::Blocked
   ↓
4. extract::extract_downstream() parses request
   ↓
5. tracker.file_access_for_session(session_id, path, Action::Read)
   ↓
6. SessionTracker sets heat=1.0, in_context=true, marks path dirty
   ↓
7. Forward request to editor stdout
   ↓
8. Next tick: tracker.tick() generates Delta with updated node
   ↓
9. Delta broadcast to all TCP clients via delta_tx channel
```

### Multi-Session Orchestrator Flow
```
1. Provider agents (e.g., ui-agent, core-agent) operate independently
   ↓
2. Each has own SessionTracker with session_mode=SingleAgent
   ↓
3. Orchestrator session created with mode=Orchestrator, providers=[ui-key, core-key]
   ↓
4. SessionRegistry persists orchestrator config
   ↓
5. Tick loop calls orchestrator.tick(tracker, registry)
   ↓
6. OrchestratorAggregator:
   - Fetches snapshots from provider sessions
   - Merges nodes using LWW strategy
   - Diffs against previous state
   - Returns Delta with orchestrator session_id
   ↓
7. Delta broadcast to filtered TCP clients
```

---

## Integration Points

### External Dependencies

**From Cargo.toml:**
- `agent-client-protocol-schema` — ACP type definitions (types only)
- `tokio` — Async runtime (tasks, TCP, process, timers)
- `serde` + `serde_json` — JSON serialization
- `anyhow` — Error handling
- `tracing` + `tracing-subscriber` — Structured logging
- `indextree` — Tree data structure for parser
- `tree-sitter-*` — Language parsers (Python, TypeScript, JavaScript, Rust)
- `walkdir` + `ignore` — Filesystem traversal
- `tiktoken-rs` — Token counting

### Cross-Region Communication

**Blocked Access Workflow:**
1. Agent in "ui" zone tries to read `core/src/auth.rs`
2. Proxy blocks with zone violation error
3. `BlockedAccess` message broadcast to TCP
4. Orchestrator (Python) receives blocked notification
5. Orchestrator routes request to "core" agent
6. Core agent performs read, result returned to orchestrator
7. Orchestrator forwards result to ui agent

**Required from Orchestrator:**
- **Type Definitions**: `SessionKey`, `SessionMode`, `SessionModel` structures
- **RPC Protocol**: JSON-RPC format for session management calls
- **Blocked Access Handling**: Subscribe to `blocked` messages via TCP

---

## Configuration & Tuning

### TrackerConfig
```rust
pub struct TrackerConfig {
    pub context_turns: u32,         // Default: 3
    pub compaction_threshold: f32,  // Default: 0.5 (50% drop)
    pub decay_rate: f32,            // Default: 0.95 per tick
}
```

**Tuning Guidelines:**
- **High activity projects**: Increase `context_turns` to 5-7
- **Large context models**: Lower `compaction_threshold` to 0.3
- **Faster decay**: Decrease `decay_rate` to 0.90

### Environment Variables
- `RUST_LOG` — Log level (default: `warn`, set to `debug` for verbose)
- `EISEN_DIR` — Session storage directory (default: `~/.eisen`)

---

## Coding Conventions

### Naming
- **camelCase**: JSON wire protocol field names (via `#[serde(rename = "type")]`)
- **snake_case**: Rust struct fields, function names
- **PascalCase**: Struct/enum type names

### Error Handling
- Public APIs return `Result<T>` with `anyhow::Error`
- Internal functions may use `Option<T>` for expected missing data
- Network/IO errors logged but not fatal (client disconnect is normal)

### Concurrency
- `Arc<Mutex<ContextTracker>>` for shared state
- `tokio::sync::Mutex` (not `std::sync::Mutex`) for async-safe locking
- Lock scopes kept minimal to reduce contention
- Broadcast channels (`tokio::sync::broadcast`) for TCP delta distribution

### Testing
- Unit tests in `#[cfg(test)]` blocks within each module
- Integration tests in `core/tests/`
- Test coverage: 79 unit + 3 binary = 82 tests total

---

## Testing & Validation

### Running Tests
```bash
cd core
cargo test           # All tests
cargo test tracker   # Tracker module only
cargo test --test wire_format  # Integration tests
```

### Test Coverage Highlights

**tracker.rs** (40 tests):
- Heat decay, context expiry, compaction detection
- Multi-session tracking, edge cases (unicode paths, 1000+ nodes)

**extract.rs** (24 tests):
- ACP message parsing for all supported methods
- Session ID auto-detection, end-turn detection

**tcp.rs** (4 tests):
- Client snapshot on connect, delta broadcast, request handling

**wire_format.rs** (11 tests):
- Snapshot/delta structure validation
- ndjson framing, sequence monotonicity

### Validation Steps

**Manual Testing:**
1. Start eisen-core in observe mode: `./eisen-core observe --port 0 -- opencode acp`
2. Note TCP port from stderr
3. Connect with `nc localhost <port>`
4. Receive initial snapshot (JSON line)
5. Trigger agent activity, observe deltas
6. Send `{"type":"request_snapshot"}\n`, receive fresh snapshot

**Zone Enforcement:**
```bash
./eisen-core observe --port 0 --zone "src/ui/**" -- opencode acp
# Agent reads outside zone → receive BlockedAccess message
```

---

## Performance Characteristics

### Memory
- ~100 bytes per tracked file (FileNode + HashMap overhead)
- 1000 files ≈ 100 KB
- Pruning at heat=0.0 prevents unbounded growth

### CPU
- Tick loop: O(changed_files) per tick
- 100ms interval with ~10-50 files = <1ms CPU time
- Adaptive interval drops to 500ms when idle (>2s no changes)

### Network
- ndJSON messages: ~200-500 bytes per delta
- Typical throughput: 5-10 deltas/second during active coding
- Snapshot on connect: 50-500 KB depending on file count

### Disk I/O
- Session registry: ~5-50 KB JSON file
- Written only on session create/update/close (not per tick)
- Atomic write with temp file prevents corruption

---

## Future Enhancements

### Planned Features
1. **Incremental Parsing** — Update AST on file changes instead of full reparse
2. **Symbol-Level Tracking** — Track individual function/class edits, not just files
3. **Network Metrics** — Track API calls, latencies, error rates
4. **Diff Visualization** — Store actual diffs for replay/audit
5. **Multi-Agent Routing** — Intelligent cross-region request routing

### Integration Targets
- VS Code webview (primary UI)
- CLI dashboard (terminal UI)
- Prometheus metrics export
- Distributed tracing (OpenTelemetry)

---

## Troubleshooting

### Common Issues

**"TCP client lagged" warnings:**
- Client consuming deltas too slowly
- Automatic recovery via snapshot resync
- Consider reducing tick frequency or filtering streams

**Session not persisted:**
- Check `$EISEN_DIR` write permissions
- Verify JSON syntax in core_sessions.json
- Review stderr for serialization errors

**Zone violations not blocking:**
- Confirm `--zone` flags provided at startup
- Check glob pattern syntax (use `**` for recursive)
- Enable debug logging: `RUST_LOG=debug`

**Missing file accesses:**
- Agent using non-ACP protocol methods
- Check for unsupported ACP extensions
- Enable `RUST_LOG=debug` and search for method names

---

## Summary

**eisen-core** provides a robust, production-ready foundation for AI coding agent observability. Its transparent proxy design ensures zero interference with agent operation while capturing comprehensive activity data. The multi-session architecture with orchestrator mode enables advanced workflows like region-isolated development and cross-agent coordination.

**Key Strengths:**
- ✅ Zero message modification (transparent proxy)
- ✅ Real-time tracking with sub-100ms latency
- ✅ Persistent session management
- ✅ Zone-based access control
- ✅ Scalable to 1000+ files with adaptive throttling
- ✅ Comprehensive test coverage (82 tests)
- ✅ Production-ready error handling and logging

**Integration Requirements:**
For full paid.ai platform integration, the orchestrator (Python) must implement:
1. TCP client subscribing to eisen-core broadcast
2. RPC calls for session management (create_session, set_orchestrator_providers)
3. Blocked access handler routing cross-region requests
4. UI rendering of graph snapshots and deltas
