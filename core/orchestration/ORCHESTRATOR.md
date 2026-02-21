# Phase B: Eisen Orchestrator

## Status: Design

## Vision

The orchestrator is the **sole consumer** of eisen-core TCP streams. The graph talks only to the orchestrator, never directly to individual eisen-core instances. This creates a clean aggregation layer that merges N independent agent data streams into a unified view.

```
Graph WebView
     |  (postMessage)
GraphViewProvider
     |  (internal API)
EisenOrchestrator
     |-----------|-----------|
  TCP :N1     TCP :N2     TCP :N3
     |           |           |
eisen-core #1  eisen-core #2  eisen-core #3
     |           |           |
  agent-1      agent-2     agent-3
```

## Architecture

### Core Responsibility

The orchestrator maintains a `Map<instanceId, TcpConnection>` and:

1. **Connects** to each agent's eisen-core TCP port as agents come online
2. **Receives** snapshots/deltas/usage from each, tagged by `agent_id`
3. **Processes** each stream through an agent-specific processor (see `ABSTRACT_AGENT_CLASS.md`)
4. **Merges** processed data into a unified state
5. **Forwards** merged snapshots/deltas to the graph
6. **Disconnects** from eisen-core TCP when agents go offline

### Data Flow

```
eisen-core #1 (agent_id: opencode-a1b2c3)
  | TCP snapshot/delta/usage
  v
Orchestrator.handleMessage(msg)
  | msg.agent_id -> route to correct processor
  v
OpenCodeProcessor.process(msg)
  | normalized/enriched data
  v
Orchestrator.mergedState
  | unified snapshot/delta
  v
GraphViewProvider
  | postMessage
  v
Graph WebView (renders all agents)
```

### Agent Lifecycle

```
1. ACPClient connects agent
   -> eisen-core spawns with --agent-id opencode-a1b2c3
   -> eisen-core prints TCP port to stderr
   -> ACPClient exposes { instanceId, tcpPort }

2. Extension notifies orchestrator
   -> orchestrator.addAgent(instanceId, tcpPort)
   -> orchestrator opens TCP connection to 127.0.0.1:{tcpPort}
   -> receives initial snapshot, processes, merges into unified state
   -> pushes merged snapshot to graph

3. Agent produces activity
   -> eisen-core broadcasts deltas on TCP
   -> orchestrator receives, processes, merges
   -> pushes merged delta to graph

4. Agent disconnects
   -> orchestrator.removeAgent(instanceId)
   -> TCP connection closed
   -> agent's nodes removed (or faded) from merged state
   -> pushes removal delta to graph
```

### Merged State

The orchestrator maintains a unified node map where each node is annotated with which agent(s) have touched it:

```typescript
interface MergedNode {
  // Standard node data
  path: string;
  heat: number;
  inContext: boolean;
  lastAction: "read" | "write" | "search";

  // Multi-agent attribution
  agents: Map<
    string,
    {
      // keyed by instanceId
      heat: number;
      inContext: boolean;
      lastAction: "read" | "write" | "search";
      turnAccessed: number;
    }
  >;
}
```

A file touched by multiple agents has multiple entries in `agents`. The top-level fields represent the "hottest" state across all agents (max heat, any-in-context, most-recent action).

## Graph Multi-Agent Visualization

### Node Rendering

- **Single-agent node**: Colored by agent (e.g. blue for Claude, green for OpenCode)
- **Multi-agent node**: Ring segments per agent, sized by relative heat
- **Active agent indicator**: Brighter color or pulsing for the agent currently producing activity

### Agent Legend

Sidebar or overlay showing:

- Agent instance ID and type (icon + color)
- Connection status (connected / disconnected)
- Current activity (idle / reading / writing)
- Toggle visibility per agent

### Filtering

- Show all agents (default)
- Solo mode: show only one agent's activity
- Highlight shared files: emphasize nodes touched by 2+ agents

## IPC Possibilities (Future)

The orchestrator's position as the central aggregation point makes it the natural place for inter-agent communication:

### File Conflict Detection

```
Agent A writes /src/api.ts
Agent B starts reading /src/api.ts
  -> Orchestrator detects overlap
  -> Could warn: "Agent B is reading a file Agent A just modified"
  -> Could pause Agent B and surface the conflict to the user
```

### Context Handoff

```
Agent A finishes task involving /src/auth.ts, /src/middleware.ts
User assigns related task to Agent B
  -> Orchestrator injects Agent A's relevant context into Agent B's prompt
  -> Agent B starts with pre-digested understanding instead of re-reading
```

### Shared Workspace Lock

```
Orchestrator maintains soft locks:
  Agent A: writing /src/db.ts (locked)
  Agent B: wants to write /src/db.ts
    -> Orchestrator queues Agent B's write
    -> Or routes Agent B to a different file
```

## Implementation Approach

### Phase B.1: TypeScript In-Process (First Iteration)

Build `EisenOrchestrator` as a TypeScript class inside the extension:

```typescript
// extension/src/orchestrator.ts
class EisenOrchestrator {
  private connections = new Map<string, net.Socket>();
  private processors = new Map<string, AgentProcessor>();
  private mergedState = new Map<string, MergedNode>();

  addAgent(instanceId: string, tcpPort: number, agentType: string): void;
  removeAgent(instanceId: string): void;
  getMergedSnapshot(): MergedSnapshot;
  onMergedDelta: (delta: MergedDelta) => void;
}
```

Advantages:

- Simple to build, direct access to VS Code APIs
- Can reuse existing `GraphViewProvider` infrastructure
- Fast iteration

### Phase B.2: Rust Binary (Future Extraction)

If the orchestrator needs to serve non-VS Code consumers (Neovim, web UI, CLI dashboard), extract to a standalone `eisen-orchestrator` binary:

```
eisen-orchestrator --ports 12345,12346,12347 --listen 17320
```

Advantages:

- Decoupled from any editor
- Better performance for high-throughput multi-agent scenarios
- Could run as a long-lived daemon

### Migration Path

The TypeScript orchestrator and Rust orchestrator would expose the same TCP wire protocol to the graph. Switching between them is transparent to the graph webview -- it just connects to a TCP port and receives merged snapshots/deltas with `agent_id` attribution.

## Refactoring Required

### GraphViewProvider

Currently connects directly to eisen-core TCP. After orchestrator:

```
Before:  GraphViewProvider --TCP--> eisen-core
After:   GraphViewProvider --API--> EisenOrchestrator --TCP--> eisen-core(s)
```

`GraphViewProvider` stops managing TCP connections entirely. It receives pre-merged data from the orchestrator via internal API (method calls or EventEmitter). This simplifies the graph code significantly.

### Extension Wiring (extension.ts)

```typescript
// Before
chatProvider.onDidConnect = () => graphProvider.connectWhenReady();
chatProvider.onActiveClientChanged = (client) =>
  graphProvider.switchToClient(client);

// After
chatProvider.onDidConnect = (client) =>
  orchestrator.addAgent(client.instanceId, client.tcpPort, client.getAgentId());
chatProvider.onDidDisconnect = (client) =>
  orchestrator.removeAgent(client.instanceId);
orchestrator.onMergedSnapshot = (snap) => graphProvider.setSnapshot(snap);
orchestrator.onMergedDelta = (delta) => graphProvider.applyDelta(delta);
```

The graph no longer needs to know about agent switching. It always shows the merged view. Agent switching becomes a UI concern (highlighting one agent) rather than a data concern (changing TCP connections).

## Open Questions

1. **Merge strategy for conflicting writes**: If Agent A and Agent B both write the same file, which `lastAction` wins in the merged state? Options: most recent timestamp, highest heat, or keep both and let the graph show conflict state.

2. **Disconnected agent retention**: When an agent disconnects, should its nodes immediately disappear, fade out over time, or persist until manually cleared? Fade-out (reduce heat to trigger natural decay) feels most natural.

3. **Orchestrator lifecycle**: Should it start on extension activation (always running) or on-demand when the first agent connects? On-demand is simpler; always-running allows pre-warming.

4. **Multiple workspaces**: If agents operate in different workspace roots, path normalization becomes complex. Probably scope the orchestrator per workspace folder.
