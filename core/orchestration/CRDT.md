# Merge Strategy: State-Based CRDT for Multi-Agent Graph

## Status: Design (wire protocol timestamp addition: implemented)

## The Problem

The orchestrator receives interleaved deltas from N eisen-core TCP streams. Two agents can touch the same file concurrently:

```
t=0ms: Agent A reads  /src/api.ts  -> heat=1.0, action=read
t=5ms: Agent B writes /src/api.ts  -> heat=1.0, action=write
t=100ms: Agent A's heat decays     -> heat=0.9
t=150ms: Agent B reads /src/api.ts -> heat=1.0
```

The orchestrator must merge these into a single coherent view for the graph. The merge must be:

- **Deterministic**: Same inputs, same result, regardless of arrival order
- **Convergent**: All observers eventually see the same state
- **Tolerant of reordering**: TCP delivers in-order per connection, but deltas from different agents interleave arbitrarily

## Approach: State-Based CRDT with Per-Agent Replicas

Each file node in the merged state maintains **independent per-agent state**. The merged view is a **derived projection** recomputed on every update. This gives us CRDT convergence guarantees (commutative, associative, idempotent merge) without the complexity of delta-CRDTs or vector clocks.

### Data Model

```typescript
/** Per-agent state for a single file. This is the "replica." */
interface AgentFileState {
  heat: number;
  inContext: boolean;
  lastAction: "read" | "write" | "search";
  timestampMs: number; // wall-clock ms from eisen-core
  turnAccessed: number;
}

/** Merged file node. Stored in the orchestrator. */
interface MergedFileNode {
  path: string;

  /** Per-agent replicas -- the source of truth */
  agents: Map<string, AgentFileState>; // keyed by instanceId

  /** Derived merged view -- recomputed from agents map */
  heat: number;
  inContext: boolean;
  lastAction: "read" | "write" | "search";
  lastActionAgentId: string;
  lastActionTimestampMs: number;
}
```

### Join Semi-Lattice Per Field

Each field has a defined join (merge) operation that satisfies the semi-lattice properties:

| Field        | Join           | Operation                                                 | Why                                                                                                                                                 |
| ------------ | -------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heat`       | Max            | `max(a.heat, b.heat, ...)`                                | File is "as hot as the most active agent." If Agent A has heat 0.3 and Agent B has heat 1.0, the file appears hot -- because it IS hot for Agent B. |
| `inContext`  | Boolean OR     | `a \|\| b \|\| ...`                                       | If ANY agent has the file in its context window, the merged view shows it as in-context. The file is relevant to at least one active agent.         |
| `lastAction` | LWW + priority | Most recent `timestampMs`; ties broken by action priority | Shows what happened most recently. Priority tiebreak ensures writes trump reads at the same instant.                                                |

#### Action Priority (for tiebreak)

```
write > search > read
```

Writes are the most impactful action. If two agents touch a file at the exact same millisecond (unlikely but possible), the write wins.

### Merge Function

```typescript
const ACTION_PRIORITY: Record<string, number> = {
  write: 3,
  search: 2,
  read: 1,
};

function deriveMergedView(agents: Map<string, AgentFileState>): MergedView {
  let heat = 0;
  let inContext = false;
  let lastAction: string = "read";
  let lastAgentId = "";
  let lastTimestamp = 0;

  for (const [agentId, state] of agents) {
    // Heat: max
    heat = Math.max(heat, state.heat);

    // In-context: OR
    inContext = inContext || state.inContext;

    // Last action: LWW with priority tiebreak
    const dominated =
      state.timestampMs > lastTimestamp ||
      (state.timestampMs === lastTimestamp &&
        ACTION_PRIORITY[state.lastAction] > ACTION_PRIORITY[lastAction]);

    if (dominated) {
      lastAction = state.lastAction;
      lastAgentId = agentId;
      lastTimestamp = state.timestampMs;
    }
  }

  return {
    heat,
    inContext,
    lastAction,
    lastActionAgentId: lastAgentId,
    lastActionTimestampMs: lastTimestamp,
  };
}
```

### Properties

**Commutativity**: `merge(A_update, B_update) = merge(B_update, A_update)`

Both orderings produce the same derived view because max, OR, and LWW are all commutative. If Agent A's delta arrives before Agent B's or vice versa, the merged state is identical.

**Associativity**: `merge(merge(A, B), C) = merge(A, merge(B, C))`

Each agent's state is stored independently in the map. The derived view is computed from the full map. Grouping doesn't matter.

**Idempotency**: `merge(A, A) = A`

Reprocessing the same delta overwrites the same agent's entry with the same values. The derived view doesn't change.

**Convergence**: All three properties together guarantee that regardless of message ordering, all observers converge to the same state.

## Operations

### Agent Produces Delta

```
1. Receive delta from eisen-core (agent_id: "claude-code-f8k2m1")
2. For each NodeUpdate in delta:
   a. Get or create MergedFileNode for path
   b. Update agents.get("claude-code-f8k2m1") with new state
   c. Recompute derived view via deriveMergedView()
3. For each removed path:
   a. Delete agent entry from MergedFileNode.agents
   b. If agents map is empty, remove MergedFileNode entirely
   c. Otherwise recompute derived view
4. Emit merged delta to graph
```

### Agent Disconnects

```
1. For each MergedFileNode in state:
   a. Delete agents.get(disconnectedAgentId)
   b. If agents map is empty, mark node for removal (fade-out)
   c. Otherwise recompute derived view
2. Emit merged delta reflecting the removal
```

This is clean because per-agent state is stored independently. Removing an agent is just deleting its entries and re-deriving. No tombstones, no GC, no causal history to unwind.

### Agent Reconnects

Fresh start. New instance ID means new agent entries. Old state from a previous connection of the same agent type was already cleaned up on disconnect. No state leakage between connections.

## Wire Protocol: `timestamp_ms`

For LWW merge on `lastAction`, the orchestrator needs wall-clock timestamps from eisen-core. Added to the wire protocol:

### `FileNode` (tracker state)

```rust
pub struct FileNode {
    pub path: String,
    pub heat: f32,
    pub in_context: bool,
    pub last_action: Action,
    pub turn_accessed: u32,
    pub timestamp_ms: u64,  // wall-clock millis, stamped on file_access()
}
```

### `NodeUpdate` (delta payload)

```rust
pub struct NodeUpdate {
    pub path: String,
    pub heat: f32,
    pub in_context: bool,
    pub last_action: Action,
    pub turn_accessed: u32,
    pub timestamp_ms: u64,  // carried through from FileNode
}
```

### Wire Example

```jsonc
{
  "type": "delta",
  "agent_id": "claude-code-f8k2m1",
  "session_id": "sess_1",
  "seq": 42,
  "updates": [
    {
      "path": "/src/api.ts",
      "heat": 1.0,
      "in_context": true,
      "last_action": "write",
      "turn_accessed": 5,
      "timestamp_ms": 1739228400000,
    },
  ],
  "removed": [],
}
```

### Why Wall-Clock, Not Vector Clocks?

All agents run on the same machine (same clock source). Wall-clock + agent_id is sufficient for LWW ordering:

- **Same machine**: No clock skew between agents. `Instant::now()` / `Date.now()` from two processes on the same host are comparable.
- **Millisecond granularity**: Two agents touching the same file in the same millisecond is rare. When it happens, action priority tiebreak resolves it deterministically.
- **No distributed partition recovery**: Agents don't go offline and come back with diverged state. They either exist (connected) or don't (disconnected + state deleted).

Vector clocks solve distributed causality tracking across machines with clock skew. That's not our problem. Adding them would be complexity for no benefit.

## Worked Example

### Setup

Two agents running concurrently:

- Agent A: `opencode-a1b2c3`
- Agent B: `claude-code-x9p4n7`

### Timeline

```
t=1000ms: Agent A reads /src/api.ts
  -> MergedFileNode {
       agents: { "opencode-a1b2c3": { heat: 1.0, inContext: true, lastAction: "read", timestampMs: 1000 } }
       heat: 1.0, inContext: true, lastAction: "read"
     }

t=1005ms: Agent B writes /src/api.ts
  -> MergedFileNode {
       agents: {
         "opencode-a1b2c3": { heat: 1.0, inContext: true, lastAction: "read", timestampMs: 1000 },
         "claude-code-x9p4n7": { heat: 1.0, inContext: true, lastAction: "write", timestampMs: 1005 }
       }
       heat: 1.0,         // max(1.0, 1.0)
       inContext: true,    // true || true
       lastAction: "write" // LWW: 1005 > 1000
     }

t=1100ms: Agent A's heat decays to 0.9
  -> agents["opencode-a1b2c3"].heat = 0.9
  -> MergedFileNode {
       heat: 1.0,         // max(0.9, 1.0) -- Agent B still hot
       inContext: true,
       lastAction: "write"
     }

t=1200ms: Agent A's context evicts /src/api.ts
  -> agents["opencode-a1b2c3"].inContext = false
  -> MergedFileNode {
       heat: 1.0,
       inContext: true,    // false || true -- Agent B still has it
       lastAction: "write"
     }

t=1300ms: Agent B also evicts /src/api.ts
  -> agents["claude-code-x9p4n7"].inContext = false
  -> MergedFileNode {
       heat: max(0.85, 0.9),  // both decaying
       inContext: false,       // false || false -- now truly out of context
       lastAction: "write"
     }

t=2000ms: Agent B disconnects
  -> delete agents["claude-code-x9p4n7"]
  -> MergedFileNode {
       agents: { "opencode-a1b2c3": { heat: 0.5, inContext: false, ... } }
       heat: 0.5,
       inContext: false,
       lastAction: "read"   // only Agent A's state remains, its last action was read
     }
```

### Key Observations

1. **Heat never drops prematurely**: Even though Agent A's heat decayed, Agent B kept the file hot. The graph shows the file as active as long as ANY agent cares about it.

2. **Context is sticky across agents**: The file stays "in context" in the merged view until ALL agents evict it. This is correct -- the file IS relevant to the system as long as one agent is working with it.

3. **Agent removal is clean**: When Agent B disconnects, its state is simply deleted. The derived view immediately reflects only Agent A's state. No residual ghost data.

4. **Arrival order doesn't matter**: If the t=1005ms delta from Agent B arrived before the t=1000ms delta from Agent A (due to TCP buffering), the result would be identical. Each agent's state is stored independently, and the derived view is recomputed from the full map.

## Edge Cases

### Same file, same millisecond, different actions

Agent A reads, Agent B writes at t=1000ms. Priority tiebreak: write > read. The merged `lastAction` is "write". Deterministic regardless of arrival order.

### Agent reconnects as same type, different instance

Agent A (`opencode-a1b2c3`) disconnects. New Agent A connects (`opencode-x7y8z9`). These are distinct entries in the agents map. No state confusion. The old instance's state was cleaned up on disconnect.

### All agents disconnect from a file

All agent entries removed. `agents` map is empty. Node is removed from merged state. Graph removes the node (or fades it if implementing visual decay).

### Single agent mode (backward compatible)

With one agent, the agents map has one entry. `deriveMergedView()` returns that agent's state directly. Equivalent to the current single-agent behavior. Zero overhead.

### Heat decay across agents

Each eisen-core decays heat independently (100ms tick loop). The orchestrator receives decayed values in deltas. The merged heat is `max()` across whatever each agent reports. No need for the orchestrator to run its own decay -- it's just reflecting the max of N independent decay curves.

## Relationship to Other Docs

- **PRE_ORCHESTRATOR.md**: Phase A added `agent_id` to the wire protocol, making per-agent demuxing possible. `timestamp_ms` (added here) extends the wire protocol further.
- **ORCHESTRATOR.md**: The orchestrator uses this merge strategy in its `mergedState`. The `MergedFileNode` described here IS the orchestrator's internal data model.
- **ABSTRACT_AGENT_CLASS.md**: Agent processors run BEFORE the merge. The flow is: `eisen-core -> AgentProcessor.process() -> CRDT merge -> derived view -> graph`. Processors normalize data; the CRDT merges it.
