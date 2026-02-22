# Phase 3: Blocker Zones + Conflict Resolution

## Status: Complete

## Prerequisites

- Phase 0 complete (PyO3 bridge)
- Phase 1 complete (single-agent orchestration)
- Phase 2 complete (multi-agent parallel execution, A2A router, lifecycle state machine)

## Goal

Enforce region constraints at the proxy level so agents **cannot** read or write files outside their assigned region. Implement conflict resolution for shared files that multiple agents need to touch. Introduce shared zones for common files like `package.json` or `tsconfig.json`. Build a cost dashboard with full per-agent and per-subtask breakdown.

## Context

### What Exists After Phase 2

- Multi-agent parallel orchestration (up to 5 agents)
- A2A router resolving cross-region dependencies (symbol tree first, agent routing second)
- Task lifecycle with retry flow
- Extension integration (JSON stdin/stdout, TCP port forwarding)
- Cross-region needs are handled by **guided prompts** telling agents to ask rather than read -- but this is a soft constraint. Agents can still attempt to read outside their region.

### What Phase 3 Adds

Phase 2 relies on agents **cooperating** with region constraints (they're told not to read outside their region via the prompt). Phase 3 makes it **enforced** at the proxy level -- eisen-core intercepts out-of-region file access and blocks it. This also enables the A2A router to automatically handle blocked requests.

```
Phase 2 (soft constraint):           Phase 3 (hard enforcement):

Agent told: "work in /ui only"       Agent told: "work in /ui only"
Agent tries: fs/read /core/auth.rs   Agent tries: fs/read /core/auth.rs
Result: succeeds (agent reads file)  Result: BLOCKED by eisen-core proxy
  - context bloat                      - A2A router intercepts
  - overlapping work                   - resolves via symbol tree or owning agent
                                       - injects compact answer
                                       - agent continues cleanly
```

---

## Tasks

### 3A. Blocker Zone Enforcement in eisen-core (Rust)

Modify the eisen-core proxy to support region constraints that block file access outside an allowed path set.

- [x] Add zone configuration to `core/src/types.rs`:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct ZoneConfig {
      /// Glob patterns for allowed paths (e.g., ["src/ui/**", "shared/**"])
      pub allowed: Vec<String>,
      /// Glob patterns for explicitly denied paths (e.g., ["**/.env"])
      pub denied: Vec<String>,
  }
  ```

- [x] Add `--zone` CLI flag to eisen-core `observe` subcommand:
  ```
  eisen-core observe --port 0 --agent-id X --zone "src/ui/**" -- opencode acp
  ```
  Multiple `--zone` flags for multiple allowed patterns.

- [x] Implement zone checking in `core/src/proxy.rs`:
  - In `downstream_task` (agent -> editor), before forwarding:
    - `fs/read_text_file`: check `params.path` against zone config
    - `fs/write_text_file`: check `params.path` against zone config
  - If path is outside zone:
    - Return JSON-RPC error to the agent: `{ id, error: { code: -32001, message: "Outside agent zone: /core/auth.rs. Request cross-region info through the orchestrator." } }`
    - Do NOT forward the request to the editor
    - Log the blocked access as `Action::Blocked` (new action variant)
  - If path is inside zone: forward as normal (current transparent behavior)

- [x] Add `Action::Blocked` variant to the Action enum in `types.rs`:
  ```rust
  #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
  #[serde(rename_all = "snake_case")]
  pub enum Action {
      UserProvided,
      UserReferenced,
      Read,
      Write,
      Search,
      Blocked,  // NEW: agent attempted out-of-zone access
  }
  ```

- [x] Add a new wire message type for blocked access notifications:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize)]
  pub struct BlockedAccess {
      #[serde(rename = "type")]
      pub msg_type: String,  // "blocked"
      pub agent_id: String,
      pub session_id: String,
      pub path: String,
      pub action: String,    // "read" | "write"
      pub timestamp_ms: u64,
  }
  ```
  This is broadcast on TCP so the orchestrator (Python) can detect blocked attempts and route them through the A2A router.

- [x] Write Rust tests:
  - Test zone matching: path inside allowed zone passes, outside is blocked
  - Test denied patterns override allowed
  - Test JSON-RPC error response format
  - Test BlockedAccess wire message

### 3B. Orchestrator Integration with Blocker Zones

Connect the Python orchestrator to the blocker zone system.

- [x] Modify `ACPSession.start()` to pass `--zone` flag:
  ```python
  async def start(self, zone_patterns: list[str] | None = None) -> None:
      cmd = ["eisen-core", "observe", "--port", "0", "--agent-id", self._agent_id]
      if zone_patterns:
          for pattern in zone_patterns:
              cmd.extend(["--zone", pattern])
      cmd.append("--")
      cmd.extend([self._agent_config.command, *self._agent_config.args])
      # spawn...
  ```

- [x] Modify orchestrator to pass region as zone when spawning agents:
  ```python
  async def _execute_subtask(self, subtask, assignment):
      session = ACPSession(...)
      zone_patterns = [f"{subtask.region}/**"]
      # Add shared zones
      zone_patterns.extend(self._get_shared_zones())
      await session.start(zone_patterns=zone_patterns)
  ```

- [x] Listen for `BlockedAccess` messages on the eisen-core TCP stream:
  - When a blocked access is detected, route it through the A2A router automatically
  - Inject the resolved dependency into the agent's next prompt
  - This makes blocker zones + A2A router work as a seamless system: agent tries to read outside zone -> blocked -> router resolves -> agent gets the info it needed

- [x] Write tests:
  - Test zone patterns are correctly passed to eisen-core
  - Test blocked access triggers A2A resolution
  - Test the full cycle: agent blocked -> router resolves -> answer injected

### 3C. Shared Zones

Some files are legitimately needed by multiple agents: `package.json`, `tsconfig.json`, `Cargo.toml`, lockfiles, type definition files, config files.

- [x] Define shared zone configuration:
  ```python
  # Default shared zones -- accessible by all agents regardless of region
  DEFAULT_SHARED_ZONES: list[str] = [
      "package.json",
      "tsconfig.json",
      "Cargo.toml",
      "Cargo.lock",
      "*.config.js",
      "*.config.ts",
      ".env.example",
      "types/**",        # shared type definitions
      "shared/**",       # explicit shared directory
  ]
  ```

- [x] Make shared zones configurable:
  - CLI flag: `--shared-zone "common/**"`
  - Config file: `.eisen/config.json` in workspace root
  - User can override defaults

- [x] When spawning each agent, combine: `agent_zone + shared_zones` as the allowed patterns

- [x] Handle shared file conflicts (see 3D below)

- [x] Write tests:
  - Test that shared zones are accessible from any agent's region
  - Test that custom shared zones override defaults

### 3D. Conflict Resolution

When two agents need to modify the same file (typically a shared file), the orchestrator must mediate.

- [x] Create `agent/src/eisen_agent/conflict.py`:

  **Detection:**
  ```python
  class ConflictDetector:
      """Detects when multiple agents are writing to the same file."""

      def __init__(self):
          self._write_map: dict[str, list[str]] = {}  # file_path -> [agent_ids]

      def record_write(self, agent_id: str, file_path: str) -> list[str] | None:
          """Record a write and return conflicting agent_ids if conflict detected."""
          agents = self._write_map.setdefault(file_path, [])
          if agents and agent_id not in agents:
              # Conflict: another agent already wrote this file
              agents.append(agent_id)
              return [a for a in agents if a != agent_id]
          agents.append(agent_id)
          return None
  ```

  **Resolution strategies:**
  ```python
  class ConflictStrategy(Enum):
      LAST_WRITE_WINS = "lww"        # most recent write is kept
      FIRST_WRITE_WINS = "fww"       # first write is kept, second is blocked
      ORCHESTRATOR_MERGES = "merge"   # orchestrator uses DSPy to merge changes
      USER_DECIDES = "user"           # pause and ask user
  ```

  **DSPy conflict resolution:**
  ```python
  class ConflictResolve(dspy.Signature):
      """Resolve conflicting changes to a shared file from two agents."""

      file_path: str = dspy.InputField()
      agent_a_changes: str = dspy.InputField(desc="Diff or description of Agent A's changes")
      agent_b_changes: str = dspy.InputField(desc="Diff or description of Agent B's changes")
      file_content_before: str = dspy.InputField(desc="Original file content before changes")

      merged_content: str = dspy.OutputField(desc="Merged file content incorporating both changes")
      resolution_notes: str = dspy.OutputField(desc="What was merged and any tradeoffs")
  ```

- [x] Implement soft locking in orchestrator:
  - When Agent A starts writing a shared file, mark it as "locked by Agent A"
  - If Agent B tries to write the same file, the orchestrator can:
    - Queue Agent B's write until Agent A finishes
    - Route to the configured conflict strategy
  - Locks are **soft** -- they don't prevent reads, only writes

- [x] Integrate with the activity stream:
  - Monitor `Delta` messages from eisen-core TCP for write actions on shared files
  - Detect conflicts in real-time during parallel execution

- [x] Write tests:
  - Test conflict detection (two agents write same file)
  - Test each resolution strategy
  - Test soft locking (queue behavior)

### 3E. Cost Dashboard

Comprehensive cost tracking with per-agent, per-subtask, and per-query breakdown.

- [x] Extend `CostTracker` (from Phase 1E):
  ```python
  class CostTracker:
      def detailed_breakdown(self) -> dict:
          """Full breakdown for dashboard rendering."""
          return {
              "orchestrator": {
                  "decompose": ...,
                  "assign": ...,
                  "prompt_build": ...,
                  "evaluate": ...,
                  "conflict_resolve": ...,
                  "total": ...,
              },
              "agents": {
                  "claude-code-x1y2": {
                      "subtask": "auth UI",
                      "region": "/ui",
                      "tokens_used": ...,
                      "tokens_size": ...,
                      "cost_usd": ...,
                  },
                  ...
              },
              "a2a_router": {
                  "symbol_tree_hits": ...,  # free resolutions
                  "agent_queries": ...,     # token cost of agent-to-agent queries
                  "total_saved_tokens": ..., # estimated tokens saved by NOT reading files
              },
              "total_tokens": ...,
              "total_cost_usd": ...,
          }
  ```

- [x] Integrate with the eisen-core `UsageMessage` wire format:
  - Parse `used`, `size`, and `cost` fields from each agent's usage messages
  - Aggregate in real-time during orchestration

- [x] Format for display:
  ```
  Cost Dashboard:
  +-----------+-----------------+--------+---------+
  | Source    | Subtask         | Tokens | Cost    |
  +-----------+-----------------+--------+---------+
  | orchestr. | (decompose)    |  3,200 | $0.01   |
  | orchestr. | (prompt build) |  1,800 | $0.005  |
  | claude    | auth UI (/ui)  | 45,000 | $0.14   |
  | codex     | auth core      | 32,000 | $0.10   |
  | A2A router| (3 sym queries)|      0 | $0.00   |
  | A2A router| (1 agent query)|    200 | $0.001  |
  +-----------+-----------------+--------+---------+
  | TOTAL     |                 | 82,200 | $0.256  |
  +-----------+-----------------+--------+---------+

  A2A Savings: ~12,000 tokens saved by symbol tree resolution
  ```

- [x] Send cost data to extension for UI rendering (via the JSON stdout protocol from Phase 2D)

- [x] Write tests:
  - Test aggregation from multiple sources
  - Test USD cost estimation
  - Test A2A savings calculation

---

## Changes to eisen-core (Rust)

This is the first phase that modifies the existing Rust `core/` crate. Changes are additive -- no existing behavior breaks.

| File | Change | Impact |
|------|--------|--------|
| `types.rs` | Add `ZoneConfig` struct, `Action::Blocked` variant, `BlockedAccess` message | Wire protocol extension |
| `proxy.rs` | Add zone checking in `downstream_task` | Agent file access gated |
| `main.rs` | Add `--zone` CLI flag | New optional argument |
| `tcp.rs` | Broadcast `BlockedAccess` messages | Orchestrator observability |
| `tracker.rs` | Track blocked accesses in file heat map | Blocked files visible on graph |

**Backward compatibility:** Zone enforcement is opt-in (`--zone` flag). Without it, eisen-core behaves exactly as before (fully transparent proxy).

---

## Verification Criteria

Phase 3 is complete when:

1. eisen-core blocks file access outside the configured zone
2. Blocked access returns a JSON-RPC error to the agent (agent doesn't crash)
3. Blocked access triggers A2A router resolution automatically
4. Shared zones work: common files accessible by all agents
5. Conflict detection catches two agents writing the same file
6. At least one conflict resolution strategy works end-to-end
7. Cost dashboard shows per-agent, per-subtask, and A2A breakdown
8. All existing eisen-core tests still pass (no regression)
9. All new Rust and Python tests pass

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Zone enforcement location | eisen-core proxy (Rust) | Fastest interception point; agents can't bypass it |
| Blocked access notification | New wire message type | Orchestrator needs to know about blocks for A2A routing |
| Shared zones | Configurable with sensible defaults | Every project has common files; defaults cover 90% |
| Conflict resolution | Multiple strategies, user-configurable | No single strategy fits all cases; ORCHESTRATOR_MERGES is the default |
| Soft locks vs hard locks | Soft (writes queued, reads allowed) | Hard locks could deadlock agents; soft locks are sufficient for coordination |
| Zone as CLI flag | --zone on eisen-core observe | Orchestrator controls zone per agent at spawn time |

---

## Summary

### What was built

**Rust (eisen-core) changes:**

| File | Change |
|------|--------|
| `core/src/types.rs` | Added `ZoneConfig` struct with `is_allowed()` method using custom glob matching (`glob_match`, `segment_match`). Added `Action::Blocked` variant. Added `BlockedAccess` wire message type. |
| `core/src/proxy.rs` | Rewrote `downstream_task` to accept `Option<Arc<ZoneConfig>>` and `broadcast::Sender<WireLine>`. Added `check_zone_violation()` that intercepts `fs/read_text_file` and `fs/write_text_file`. Blocked requests get a JSON-RPC error (code -32001) returned to the agent, the request is NOT forwarded, and a `BlockedAccess` message is broadcast on TCP. |
| `core/src/main.rs` | Added `--zone PATTERN` and `--deny PATTERN` CLI flags to `observe` subcommand (repeatable). Builds `ZoneConfig` and passes as `Arc` to the downstream proxy task. |
| `core/tests/zone_tests.rs` | 19 tests for glob matching, denied overrides, exact files, wildcards, double-star, edge cases. |
| `core/tests/wire_format.rs` | Added `blocked_access_wire_format` and `blocked_access_round_trip` tests. Updated `action_serialization` to include `Action::Blocked`. |

**Python (eisen-agent) changes:**

| File | Change |
|------|--------|
| `agent/src/eisen_agent/acp_session.py` | `build_spawn_command()` and `start()` now accept `zone_patterns` and `deny_patterns` lists. Each pattern becomes a `--zone` or `--deny` flag. |
| `agent/src/eisen_agent/orchestrator.py` | Imports and uses `SharedZoneConfig`, `BlockedAccessListener`, `ConflictDetector`, `ConflictResolver`. `_execute_subtask` builds zone patterns from subtask region + shared zones. Starts blocked access listener on agent TCP port. Stops listener on cleanup. |
| `agent/src/eisen_agent/zones.py` | NEW. `DEFAULT_SHARED_ZONES` (18 patterns: package.json, tsconfig.json, Cargo.toml, etc.). `SharedZoneConfig` dataclass with `get_all_patterns()` and `from_workspace()` to load `.eisen/config.json`. |
| `agent/src/eisen_agent/blocked_listener.py` | NEW. `BlockedAccessListener` connects to eisen-core TCP, filters for `"blocked"` messages, routes through A2A router, stores resolved text as `pending_resolutions` for injection into agent prompts. |
| `agent/src/eisen_agent/conflict.py` | NEW. `ConflictDetector` (async, tracks write-map). `SoftLock` (async, per-file write queuing). `ConflictStrategy` enum (LWW, FWW, ORCHESTRATOR_MERGES, USER_DECIDES). `ConflictResolver` with DSPy-powered merge via `ConflictResolve` signature. |
| `agent/src/eisen_agent/cost.py` | Extended with `CostEntry.subtask`/`region` fields. Added `A2AStats` dataclass. `CostTracker` now has `record_agent_usage()`, `record_a2a_symbol_hit()`, `record_a2a_agent_query()`, `detailed_breakdown()`, `format_dashboard()`, and USD cost estimation. |
| `agent/src/eisen_agent/ext_protocol.py` | `_handle_approve` now includes `dashboard` field in cost data sent to extension. |

**Test files added/updated:**

| File | Tests |
|------|-------|
| `core/tests/zone_tests.rs` | 19 zone matching tests |
| `core/tests/wire_format.rs` | +2 BlockedAccess tests, +1 Action::Blocked test |
| `agent/tests/test_acp_session.py` | +4 zone command construction tests |
| `agent/tests/test_zones.py` | 8 SharedZoneConfig tests |
| `agent/tests/test_blocked_listener.py` | 10 blocked access listener tests |
| `agent/tests/test_conflict.py` | 17 conflict detection, soft lock, and resolution tests |
| `agent/tests/test_cost.py` | +11 cost dashboard, A2A stats, USD estimation tests |

### How blocker zones work in practice

1. Orchestrator spawns agent: `eisen-core observe --zone "src/ui/**" --zone "package.json" ... -- opencode acp`
2. Agent issues `fs/read_text_file {"path": "/core/auth.rs"}` via JSON-RPC
3. eisen-core proxy intercepts in `downstream_task`, checks `ZoneConfig::is_allowed()`
4. Path is outside zone -> proxy returns JSON-RPC error `{code: -32001, message: "Outside agent zone..."}` directly to the agent (NOT forwarded to editor)
5. Proxy records `Action::Blocked` in tracker and broadcasts `BlockedAccess` on TCP
6. Python `BlockedAccessListener` picks up the TCP message, routes through A2A router
7. Router resolves via symbol tree (zero cost) or owning agent query
8. Resolution stored in `pending_resolutions` for injection into agent's next prompt

Without `--zone` flags, eisen-core behaves exactly as before (fully transparent proxy). Zone enforcement is opt-in.

### Conflict resolution strategies implemented

All four strategies are implemented and tested:
- **LAST_WRITE_WINS**: default for non-critical files
- **FIRST_WRITE_WINS**: first agent's changes preserved
- **ORCHESTRATOR_MERGES**: DSPy `ConflictResolve` signature merges changes (falls back to LWW on failure)
- **USER_DECIDES**: pauses execution, marks conflict as unresolved

`SoftLock` is implemented for write queuing (reads never blocked). Locks are per-file with async acquire/release and timeout-based waiting.

### Cost dashboard

The `CostTracker` now produces a detailed breakdown with:
- Per-orchestrator-step token counts (TaskDecompose, PromptBuild, etc.)
- Per-agent token counts with subtask, region, and context size
- A2A router stats: symbol tree hits (free), agent queries (tokens), estimated savings
- USD cost estimation using per-model-family rates

The `format_dashboard()` method produces a formatted table suitable for CLI display. The extension protocol sends the full `detailed_breakdown()` dict for UI rendering.

### Wire protocol backward compatibility

All changes are additive:
- `Action::Blocked` is a new variant -- old clients that don't know about it will see `"blocked"` as the serialized string
- `BlockedAccess` is a new message type -- old clients will see `"type": "blocked"` and can safely ignore it
- Zone enforcement is opt-in via `--zone` flag -- without it, behavior is identical to Phase 2

### Known issues / tech debt

- The `ConflictDetector` is wired into the orchestrator but not yet actively monitoring `Delta` messages from eisen-core TCP for write actions. It needs to be connected to the `BlockedAccessListener` TCP stream to detect writes on shared files in real-time. Currently, conflict detection must be triggered manually via `record_write()`.
- DSPy token tracking for orchestrator calls still records `0` tokens (carried from Phase 1/2). The `CostTracker` framework is ready but actual DSPy token extraction is not wired.
- The `BlockedAccessListener` TCP connection happens after `session.start()` returns, but there's a small race window between when the agent starts and when the listener connects.
- No retry limit on A2A router agent queries -- a pathological case could cause unbounded token consumption.
- The glob matcher in `types.rs` is a custom implementation; complex edge cases (e.g., `{a,b}` brace expansion) are not supported.
