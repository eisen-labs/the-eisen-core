# Phase A: Pre-Orchestrator -- Per-Agent Identity on the Wire

## Status: Implemented

## Goal

Ensure every eisen-core instance is uniquely identifiable on the wire protocol. This is the prerequisite for any multi-agent work: an orchestrator (or any TCP consumer) must be able to tell which agent produced a given snapshot, delta, or usage message.

## What Changed

### 1. Wire Protocol: `agent_id` field

Every server-to-client message now carries an `agent_id` string:

```jsonc
// snapshot
{ "type": "snapshot", "agent_id": "opencode-a1b2c3", "session_id": "sess_1", "seq": 5, "nodes": { ... } }

// delta
{ "type": "delta", "agent_id": "opencode-a1b2c3", "session_id": "sess_1", "seq": 6, "updates": [...], "removed": [...] }

// usage
{ "type": "usage", "agent_id": "opencode-a1b2c3", "session_id": "sess_1", "used": 45000, "size": 200000 }
```

The `agent_id` is an **instance ID**, not just an agent type. Format: `{agentType}-{random6}` (e.g. `claude-code-f8k2m1`). This means two instances of the same agent type have distinct IDs.

### 2. CLI: `--agent-id` flag

```
eisen-core observe --port 0 --agent-id opencode-a1b2c3 -- opencode acp
```

Falls back to empty string if not provided (backward compatible with direct invocation).

### 3. Extension: Instance ID Generation

`ACPClient.buildSpawnCommand()` generates a unique instance ID at spawn time and passes it via `--agent-id`. The ID is available as `client.instanceId` after connection.

## Files Changed

| File                          | Change                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `core/src/types.rs`           | Added `agent_id: String` to `Snapshot`, `Delta`, `UsageMessage` and their constructors                                 |
| `core/src/main.rs`            | Added `--agent-id` CLI flag parsing, passed to `ContextTracker`                                                        |
| `core/src/tracker.rs`         | Added `agent_id` field, `set_agent_id()`/`agent_id()` methods, threaded through `snapshot()`/`tick()`/`usage_update()` |
| `extension/src/acp/client.ts` | Generate instance ID, pass `--agent-id` in spawn args, expose `instanceId` getter                                      |
| `core/src/tcp.rs` (tests)     | Updated `Delta::new` call for new constructor signature                                                                |
| `core/tests/wire_format.rs`   | Updated `UsageMessage::new` calls for new constructor signature                                                        |

## Data Flow (Current)

```
Extension Host
  |
  ACPClient (agent: opencode, instanceId: opencode-a1b2c3)
    |
    eisen-core observe --port 0 --agent-id opencode-a1b2c3 -- opencode acp
      |
      ContextTracker { agent_id: "opencode-a1b2c3", session_id: "sess_1" }
        |
        TCP :N --> snapshot/delta/usage all carry agent_id
          |
          GraphViewProvider connects here (single active agent)
```

Each `ACPClient` spawns its own eisen-core process. Each eisen-core has its own `ContextTracker` with its own `agent_id`. There is no shared state between agents. The graph currently follows one active client at a time -- the orchestrator (Phase B) will aggregate multiple.

## What This Enables

- **Any TCP consumer** can now identify which agent produced each message
- **Multiple simultaneous TCP connections** from an orchestrator can be demuxed by `agent_id`
- **Logging and diagnostics** include agent identity
- **Graph nodes** can be attributed to specific agent instances

## What This Does NOT Change

- `GraphViewProvider` still connects to one eisen-core at a time
- No orchestrator exists yet
- No multi-agent visualization
- Agent spawning model unchanged (1 `ACPClient` per agent type, created on demand)

## Design Decisions

### Why instance ID, not agent type ID?

If we later support running two Claude Code agents simultaneously (e.g. one for frontend, one for backend), the orchestrator needs to distinguish them. `claude-code-f8k2m1` vs `claude-code-x9p4n7` are unambiguous. The agent type can always be extracted by splitting on the last hyphen-segment.

### Why on the wire, not just in the extension?

The orchestrator will be a TCP consumer. It needs agent identity in the data it receives, not as out-of-band metadata it has to track separately. Putting `agent_id` in every message makes the protocol self-describing -- any consumer can process messages without knowing the connection topology.

### Backward compatibility

`agent_id` defaults to empty string when `--agent-id` is not provided. Existing consumers that don't use the field are unaffected. The field is always present in JSON (not `skip_serializing_if`), so parsers won't break on missing keys.
