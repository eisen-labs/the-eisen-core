# Future Topics — Brainstorming

> Living document for future Eisen features. Each topic includes a concept overview,
> mapping to the current architecture, ACP protocol alignment, implementation sketch,
> open questions, and a feasibility rating.
>
> **Architecture baseline:** The extension host runs on **Bun**. Rust core logic
> is called in-process via a **NAPI-RS** `.node` addon (Node-API — the stable,
> Bun-endorsed native interop path). Orchestration is handled by a **Mastra**
> workflow backed by a per-workspace **LibSQL** database. See `MASTRA.md` for
> the full plan.

---

## Table of Contents

1. [Hot Zones — Context Re-freshening](#1-hot-zones--context-re-freshening)
2. [Agent Overlap — Cross-Agent Context Handoff](#2-agent-overlap--cross-agent-context-handoff)
3. [Blocker Zones — Bounded Agent Directories](#3-blocker-zones--bounded-agent-directories)
4. [Dependency Graph Between Topics](#4-dependency-graph-between-topics)
5. [ACP Protocol Reference Notes](#5-acp-protocol-reference-notes)

---

## 1. Hot Zones — Context Re-freshening

**Feasibility: HIGH**

### Concept

Certain files are critical to a task — entry points, shared types, config — but agents
drop them from context after a few turns of inactivity. A "hot zone" is a set of files
that get **re-injected into the agent's context** when compaction is detected or the
files decay out. The agent never "forgets" what matters most.

### Architecture Alignment

Eisen already has all the detection primitives:

| Component                                  | Role in hot zones                          |
| ------------------------------------------ | ------------------------------------------ |
| `FileNode.heat` (decays at 0.95/100ms)     | Detects when a file is cooling off         |
| `FileNode.in_context` (3-turn window)      | Detects when a file exits inferred context |
| Compaction detection (`tracker.rs:94-108`) | Fires on >50% token usage drop             |
| `ContentBlock::Resource` in ACP prompts    | Vehicle for re-injecting file content      |

**Missing**: a hot zone registry, a re-injection trigger, and proxy interception — the
proxy is currently transparent (read-only). Injecting `Resource` blocks into
`session/prompt` requires it to become an active interceptor on the upstream path.

### Implementation Sketch

```
Phase A — Registry
  Add hot_zones: HashSet<String> to ContextTracker
  TCP command: { type: "set_hotzone", paths: [...] }
  Extension UI: right-click graph node → "Pin to hot zone"
  (or auto-detect: files accessed in >60% of turns)

Phase B — Trigger
  On compaction: collect hot zone files not in_context, queue for re-injection
  On end_turn when a hot zone file's in_context flips false: queue it
  Debounce: skip re-injection if the file was injected within N turns

Phase C — Proxy Interception
  In upstream_task, after parsing session/prompt:
    deserialize JSON-RPC params → append ContentBlock::Resource for queued files
    re-serialize and forward the modified message
  Log injections as Action::Refreshed
```

### ACP Alignment

- Appending `Resource` blocks to `session/prompt` is fully compliant — no extensions.
- Gate on `InitializeResponse.capabilities.promptCapabilities.embeddedContext`.
- No protocol changes needed. This is pure message augmentation.

### Open Questions

- Silent injection vs. user-visible indicator ("Re-injected 3 files")?
- Token budget: size cap per file (32KB?) and total budget with prioritization.
- Auto-detection heuristic: access frequency alone may not suffice — writes
  might matter more than reads.
- Should hot zones persist across sessions or reset per session?

---

## 2. Agent Overlap — Cross-Agent Context Handoff

**Feasibility: MEDIUM-LOW (stretch goal)**

### Concept

When two concurrent agents overlap on the graph (touching the same files), the first
agent has already built context about those files. Instead of the second agent re-reading
from scratch, the first **hands off accumulated context** — summaries, extracted facts,
inferred relationships — so the second agent skips redundant work.

### Architecture Alignment

Eisen is currently **single-agent** (one `ACPClient` → one `eisen-core` → one agent).
Multi-agent is a Phase 4 goal with no implementation yet.

| Exists                                       | Relevance                                               |
| -------------------------------------------- | ------------------------------------------------------- |
| `ContextTracker` per session                 | Each agent gets its own tracker instance                |
| TCP broadcast (ndJSON)                       | Coordination service can subscribe to multiple trackers |
| Graph with per-node metadata                 | Extend with `ownerAgent` field                          |
| `session/update` with `ToolCall.locations[]` | Reveals exactly which files each agent touches          |

**Missing**: multi-agent spawning (N `ACPClient` instances), overlap detection service,
handoff message format (ACP has no built-in "context from another agent" type), and
agent willingness to trust external context.

### Implementation Sketch

```
Phase A — Multi-Agent Infrastructure
  Extend agents.ts: spawn multiple agents, each with own proxy + TCP port
  GraphViewProvider subscribes to all TCP streams, tags nodes with agent_id
  Graph renders agent-colored overlays (Agent A = blue, Agent B = orange)

Phase B — Overlap Detection
  Maintain Map<FilePath, Set<AgentId>> from merged tracker state
  On delta: update map → when file appears in 2+ active sets:
    emit OverlapEvent { file, agents, first_accessor }
  Graph highlights shared nodes with a ring

Phase C — Context Handoff
  On overlap: query first accessor's session history
    (ACP distributed sessions: GET /sessions/{id} → history URLs)
  Extract relevant content blocks, inject into second agent's prompt as
    ContentBlock::Resource with annotation: { source: "agent-handoff" }
  Second agent gets pre-digested context instead of raw file
```

### ACP Alignment

- **Distributed sessions** return history as URL references — fetchable by the
  coordination layer for cross-agent context sharing.
- **Router pattern** is documented ACP architecture. Eisen could act as
  coordinator routing context between specialist agents.
- **`metadata.annotations`** is open-schema — handoff provenance fits without
  protocol extensions.
- **Limitation**: ACP composition uses REST (`/runs`). Eisen agents use stdio
  JSON-RPC. Bridging these two transport modes is a significant challenge.

### Open Questions

- How does the receiving agent _trust_ handed-off context? May re-read anyway.
- Handoff granularity: full file, diffs, summaries, or extracted symbols?
- Latency: overlap detection + context assembly may be slower than just re-reading.
- Better as a _user suggestion_ ("Agent B is about to re-read files Agent A
  processed — merge sessions?") rather than automatic?

---

## 3. Blocker Zones — Bounded Agent Directories

**Feasibility: MEDIUM**

### Concept

Restrict an agent's file access to a defined directory subtree. The agent cannot read,
write, or search outside its zone. This enables **expert agents** (authority over
`src/api/`), **safety boundaries** (no touching secrets/configs), and **A2A routing**
(out-of-zone requests routed to the zone's owner agent).

### Architecture Alignment

The proxy already sees every file access via `extract.rs`:

| ACP method                    | Captures                           |
| ----------------------------- | ---------------------------------- |
| `fs/read_text_file`           | `params.path`                      |
| `fs/write_text_file`          | `params.path`                      |
| `session/update` (tool calls) | `ToolCall.locations[]`             |
| Search result extraction      | Parsed paths from grep/glob output |

Enforcement = intercept these and **block/error** when the path is out-of-zone.

**Missing**: zone config format, proxy enforcement (transparent → gatekeeper),
graceful denial UX (agents may retry or hallucinate on permission errors),
cross-zone routing (requires multi-agent from Topic #2).

### Implementation Sketch

```
Phase A — Zone Configuration
  BlockerZone { agent_id, allowed: Vec<Glob>, denied: Vec<Glob> }
  CLI: eisen-core observe --zone "src/api/**" -- opencode acp
  Extension UI: select folder nodes on graph to define boundaries
  TCP command: { type: "set_zone", allowed: [...], denied: [...] }

Phase B — Proxy Enforcement
  In extract_downstream, before forwarding fs/read or fs/write:
    check path against zone config
    if out-of-zone: return JSON-RPC error to agent
      { id, error: { code: -32001, message: "Outside agent zone" } }
  For tool call locations[]: filter or block out-of-zone entries
  For search results: redact out-of-zone paths
  Log blocked accesses as Action::Blocked

Phase C — Cross-Zone A2A Routing (depends on Topic #2)
  On out-of-zone request: identify owning agent
  Route via ACP composition: POST /runs on owner's server
  Return response as ContentBlock to requester
  Graph: render cross-zone requests as directed edges between agents
```

### ACP Alignment

- **JSON-RPC errors** are standard — custom code `-32001` for zone violations.
- **Router pattern** fits cross-zone routing: coordinator detects out-of-zone
  request, creates a `run` on the target agent.
- **Agent manifest** can declare zones via `metadata.annotations`:
  `{ "eisen.zone.allowed": ["src/api/**"], "eisen.zone.denied": ["**/.env"] }`
- **Limitation**: `fs/*` methods are Agent Client Protocol (stdio), not
  ACP-over-REST. Proxy blocking works, but cross-zone routing requires bridging.

### Open Questions

- How do agents react to access denials? Test each (OpenCode, Claude Code,
  Codex, Gemini, Goose, Amp, Aider) for graceful degradation.
- Hard boundaries (error) vs. soft boundaries (warn + log, allow access)?
- Shared files (e.g., `package.json`): allow a "shared zone" for all agents?
- Zone granularity: directory, file, or symbol level?
- Auto-suggest zones from directory structure or CODEOWNERS?

---

## 4. Dependency Graph Between Topics

```
┌─────────────────────┐
│   1. HOT ZONES      │  ◄── Standalone. Introduces proxy interception.
│   (HIGH feasibility)│
└────────┬────────────┘
         │  interception pattern reused
         ▼
┌─────────────────────┐
│  3. BLOCKER ZONES   │  ◄── Phases A-B standalone.
│  (MEDIUM)           │      Phase C depends on #2.
└────────┬────────────┘
         │  cross-zone routing needs multi-agent
         ▼
┌─────────────────────┐
│  2. AGENT OVERLAP   │  ◄── Most ambitious. Requires multi-agent (Phase 4).
│  (MEDIUM-LOW)       │      Builds on #1 and #3.
└─────────────────────┘
```

**Recommended order:**

1. **Hot Zones** — immediate value, establishes proxy interception.
2. **Blocker Zones A-B** — enforcement using the same interception, no multi-agent needed.
3. **Agent Overlap + Blocker Zones C** — requires Phase 4 multi-agent infrastructure.

---

## 5. ACP Protocol Reference Notes

### Message Injection (Hot Zones)

```
session/prompt → params.content[] → ContentBlock::Resource
  { "type": "resource", "resource": { "uri": "file:///path", "text": "..." } }

Gate: InitializeResponse.capabilities.promptCapabilities.embeddedContext
```

### Distributed Sessions (Agent Overlap)

```
GET /sessions/{session_id} → { id, history: [url, ...], state: url }
History entries are HTTP URLs to message content on resource servers.
Cross-agent sharing = fetching another agent's history URLs.
```

### Agent Manifest Metadata (Blocker Zones)

```json
{
  "name": "api-expert",
  "metadata": {
    "capabilities": [{ "name": "zone-expert", "description": "src/api/**" }],
    "domains": ["api-layer"],
    "annotations": {
      "eisen.zone.allowed": ["src/api/**", "shared/types/**"],
      "eisen.zone.denied": ["**/.env"]
    }
  }
}
```

### Composition Patterns (Cross-Zone Routing)

ACP supports **router** (route sub-tasks to specialists), **chaining** (sequential
pipeline), and **parallelization** (concurrent independent tasks) — all via
`POST /runs` with `agent_name`.

### Protocol Boundary

Eisen agents use **Agent Client Protocol** (stdio JSON-RPC) while ACP composition
uses **REST**. Bridge options: wrap agents in a lightweight REST server, implement
composition in the proxy/extension layer, or wait for dual-transport support.
