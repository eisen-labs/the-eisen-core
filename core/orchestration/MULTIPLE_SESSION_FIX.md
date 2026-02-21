# Multiple Session Issues & Fixes

## Status: Analysis Complete

## Context

With the orchestrator in place (`extension/src/orchestrator/`), the extension can aggregate N simultaneous agent TCP streams into a unified graph. However, several issues in the existing chat/ACP layer prevent multiple sessions from working correctly. This document catalogs each issue, its severity, and the fix required.

## Architecture Recap

```
ChatViewProvider
  agentClients: Map<string, ACPClient>   // keyed by agent TYPE (not instance)
  activeClient: ACPClient | null         // one active at a time
    |
    |  onDidConnect / onActiveClientChanged
    v
extension.ts
    |
    v
EisenOrchestrator
  connections: Map<string, AgentConnection>  // keyed by instanceId
    |
    TCP :N1  TCP :N2  ...
    |
  eisen-core instances
```

## Issue 1: `removeAgent()` never called — dead agents persist forever

**Severity: High**
**Files: `extension/src/extension.ts`, `extension/src/views/chat.ts`**

### Problem

`EisenOrchestrator.removeAgent()` is implemented but never invoked. When an agent's eisen-core subprocess exits:

1. The process `exit` handler fires (`client.ts:620`)
2. `setState("disconnected")` fires (`client.ts:622`)
3. The state change listener in `chat.ts:120` checks `this.currentAgentId === agentId` — if the disconnecting agent is NOT the active one, nothing happens
4. Even if it IS the active one, `onDidConnect` only fires on `"connected"` state, not `"disconnected"`

The orchestrator's TCP socket receives a `close` event (marking `conn.connected = false`), but the entry, display name, and color allocation remain permanently.

### Consequences

- Agent list in the legend grows monotonically — dead agents appear as "disconnected" forever
- Color slots are never reclaimed
- Display name counters never reset (`claude_1`, `claude_2`, `claude_3`...)
- Stale merged state data persists from dead agents (their file nodes remain until heat decays to zero in eisen-core, which already happened before disconnect — so they may stay forever)

### Fix

Wire a disconnect handler in `extension.ts`:

```typescript
// In extension.ts, add a disconnect callback on ChatViewProvider
chatProvider.onDidDisconnect = (instanceId: string) => {
  orchestrator?.removeAgent(instanceId);
};
```

This requires:

1. **Add `onDidDisconnect` callback to `ChatViewProvider`** — fires when any agent's state changes to `"disconnected"`, passing the `instanceId` (must be captured BEFORE it's nulled)
2. **Fix `ACPClient.dispose()` ordering** — currently `_instanceId` is set to `null` on line 876 BEFORE `setState("disconnected")` fires on line 880. Swap the order so the instanceId is available in the disconnect callback.
3. **Remove the `currentAgentId` guard for disconnect events** — the disconnect handler in `chat.ts:120` currently only fires if the disconnecting agent is the active one. Disconnect events should ALWAYS propagate to the orchestrator, regardless of which agent is currently selected.

### Implementation

In `chat.ts`, modify `setupClientHandlers`:

```typescript
client.setOnStateChange((state) => {
  // Always notify orchestrator of disconnects, regardless of active agent
  if (state === "disconnected") {
    const instId = client.instanceId;
    if (instId) {
      this.onDidDisconnect?.(instId);
    }
  }

  if (this.currentAgentId === agentId) {
    this.postMessage({ type: "connectionState", state });
    if (state === "connected") {
      this.onDidConnect?.();
    }
  }
});
```

In `client.ts`, fix `dispose()` ordering:

```typescript
dispose(): void {
  const oldInstanceId = this._instanceId;  // capture before nulling
  if (this.process) {
    this.process.kill();
    this.process = null;
  }
  this.connection = null;
  this.sessions.clear();
  this.activeSessionId = null;
  this.setState("disconnected");  // fire BEFORE nulling instanceId
  this._instanceId = null;
  this._tcpPort = null;
  this.tcpPortResolvers = [];
}
```

---

## Issue 2: Two agents of the same type cannot run simultaneously

**Severity: By Design (but limits multi-agent)**
**Files: `extension/src/views/chat.ts`**

### Problem

`ChatViewProvider.agentClients` is a `Map<string, ACPClient>` keyed by **agent type** (e.g. `"opencode"`, `"claude-code"`), not by instance ID. When the user selects an agent type, it either reuses the existing client or creates a new one:

```typescript
// chat.ts:101-103
if (!this.agentClients.has(agentId)) {
  this.agentClients.set(agentId, new ACPClient(agent, this.globalState));
}
```

This means you can run one OpenCode and one Claude simultaneously, but NOT two OpenCode instances.

### Consequence

The orchestrator supports N agents of the same type (it generates unique instanceIds and display names like `opencode_1`, `opencode_2`). But the chat layer prevents this scenario from occurring.

### Fix (Future)

Change the keying strategy to allow multiple instances per agent type. This is a larger refactor of the chat UI (need a way to spawn "another instance" of an agent type, session list per instance, etc.). Not blocking for the initial multi-agent graph — different agent types can already run simultaneously.

---

## Issue 3: Background agent connect not registered with orchestrator

**Severity: Medium**
**Files: `extension/src/extension.ts`, `extension/src/views/chat.ts`**

### Problem

The `onDidConnect` callback in `chat.ts:120-127` has a guard:

```typescript
if (this.currentAgentId === agentId) {
  this.onDidConnect?.();
}
```

If a non-active agent finishes connecting in the background (e.g. user switched away while it was still starting up), `onDidConnect` is never called, and `orchestrator.addAgent()` is never called for that agent.

### Scenario

1. User selects Agent A, sends a message → `connect()` starts, spawns eisen-core subprocess
2. User switches to Agent B before Agent A finishes connecting
3. Agent A finishes connecting → state changes to `"connected"` → guard fails → `onDidConnect` NOT fired
4. Agent A is alive with a TCP port, but the orchestrator doesn't know about it
5. If user switches back to Agent A, `onActiveClientChanged` fires, and IF the client has a TCP port, `addAgent()` is called (partial mitigation)

### Fix

Remove the guard for the `"connected"` state in the orchestrator notification path (keep it for the UI notification):

```typescript
client.setOnStateChange((state) => {
  // Always notify orchestrator of connects/disconnects
  if (state === "connected") {
    this.onDidConnect?.();
  }
  if (state === "disconnected") {
    const instId = client.instanceId;
    if (instId) this.onDidDisconnect?.(instId);
  }

  // Only notify the webview UI if this is the active agent
  if (this.currentAgentId === agentId) {
    this.postMessage({ type: "connectionState", state });
  }
});
```

Wait — `onDidConnect` currently calls `chatProvider?.getActiveClient()` in extension.ts. If we fire it for a background agent, `getActiveClient()` returns the wrong client.

**Better fix:** Change `onDidConnect` to pass the client reference:

```typescript
// In chat.ts
public onDidConnect: ((client: ACPClient) => void) | null = null;

// In setupClientHandlers:
if (state === "connected") {
  this.onDidConnect?.(client);
}
```

```typescript
// In extension.ts
chatProvider.onDidConnect = async (client) => {
  try {
    const port = await client.waitForTcpPort();
    const instanceId = client.instanceId;
    const agentType = client.getAgentId();
    if (instanceId && agentType) {
      orchestrator?.addAgent(instanceId, port, agentType);
    }
  } catch (e) {
    console.error("[Extension] Failed to register agent:", e);
  }
};
```

---

## Issue 4: `onDidConnect` fires twice per connect

**Severity: Low (guarded)**
**Files: `extension/src/views/chat.ts`**

### Problem

When `ACPClient.connect()` is called:

1. Internally, `setState("connected")` fires the state change listener → `onDidConnect?.()` fires (first time)
2. After `connect()` returns, the caller (`handleConnect` or `handleUserMessage`) calls `this.onDidConnect?.()` explicitly (second time)

### Consequence

`addAgent()` is called twice with the same instanceId. The orchestrator's duplicate guard (`orchestrator.ts:79`) makes this harmless, but it produces a spurious warning log.

### Fix

Remove the explicit `this.onDidConnect?.()` calls in `handleConnect()` and `handleUserMessage()`. The state change listener already handles it:

```typescript
// chat.ts:720-721 — remove the onDidConnect call
await this.activeClient.connect();
// this.onDidConnect?.();  // REMOVE: already fired by state change listener

// chat.ts:587-589 — same
await this.activeClient.connect();
// this.onDidConnect?.();  // REMOVE
```

---

## Issue 5: `dispose()` nulls instanceId before firing disconnect state

**Severity: High (blocks Issue 1 fix)**
**Files: `extension/src/acp/client.ts`**

### Problem

In `ACPClient.dispose()` (line 867-881):

```typescript
this._instanceId = null; // line 876 — nulled first
this._tcpPort = null; // line 877
this.tcpPortResolvers = [];
this.setState("disconnected"); // line 880 — fires after null
```

By the time the `"disconnected"` state fires and the disconnect callback tries to read `client.instanceId`, it's already `null`.

### Fix

Covered in Issue 1's implementation section. Capture `instanceId` before nulling, or reorder operations.

---

## Issue 6: `waitForTcpPort()` hangs forever when eisen-core not used

**Severity: Medium**
**Files: `extension/src/acp/client.ts`, `extension/src/extension.ts`**

### Problem

When `buildSpawnCommand()` falls back to spawning the agent directly (no eisen-core binary found), `_instanceId` and `_tcpPort` are never set. The `waitForTcpPort()` promise hangs indefinitely, blocking the `onDidConnect` handler in extension.ts.

### Fix

Add a timeout to `waitForTcpPort()`:

```typescript
waitForTcpPort(timeoutMs = 10000): Promise<number> {
  if (this._tcpPort !== null) return Promise.resolve(this._tcpPort);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for TCP port"));
    }, timeoutMs);
    this.tcpPortResolvers.push((port) => {
      clearTimeout(timer);
      resolve(port);
    });
  });
}
```

---

## Issue 7: Shared `terminals` map across agents

**Severity: Low**
**Files: `extension/src/views/chat.ts`**

### Problem

The `terminals` map (chat.ts:86) is shared across all agents. Terminals spawned by Agent A can be accessed by Agent B if Agent B happens to reference the same terminal ID.

### Fix (Future)

Namespace terminal IDs by agent instanceId, or maintain per-agent terminal maps. Not critical for initial multi-agent support since terminal IDs are generated with random components.

---

## Issue 8: Streaming response dropped on agent switch

**Severity: Medium**
**Files: `extension/src/views/chat.ts`**

### Problem

If Agent A is mid-stream when the user switches to Agent B:

1. `streamingText` is reset/saved
2. Agent A's `sessionUpdate` callbacks check `this.currentAgentId === agentId` — they are silently dropped
3. When the user switches back, the response appears incomplete

### Fix (Future)

Buffer streaming responses per-agent and restore on switch-back. The `agentStates` cache (chat.ts:88) already stores some state per agent but doesn't include the streaming buffer. Add `streamingText` to the cached state.

---

## Priority Order for Fixes

### Must-fix for multi-agent to work

1. **Issue 1**: Wire `removeAgent()` — without this, the agent list and graph state leak indefinitely
2. **Issue 5**: Fix `dispose()` ordering — prerequisite for Issue 1
3. **Issue 3**: Register background agents — without this, non-active agents are invisible to the graph

### Should-fix for robustness

4. **Issue 4**: Remove double `onDidConnect` calls — reduces noise
5. **Issue 6**: Add `waitForTcpPort()` timeout — prevents hanging promises

### Nice-to-have

6. **Issue 8**: Buffer streaming per-agent
7. **Issue 7**: Namespace terminals
8. **Issue 2**: Multiple instances of same agent type
