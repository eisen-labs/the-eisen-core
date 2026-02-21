import * as net from "net";
import type {
  AgentFileState,
  AgentInfo,
  MergedFileNode,
  MergedGraphDelta,
  MergedGraphDeltaUpdate,
  MergedGraphNode,
  MergedGraphSnapshot,
  NormalizedAction,
  WireMessage,
} from "./types";
import { AGENT_COLORS, normalizeAction } from "./types";
import { getProcessor, type AgentProcessor } from "./processor";
import {
  applyAgentUpdate,
  createMergedNode,
  removeAgentFromNode,
} from "./merge";

// ---------------------------------------------------------------------------
// Internal agent connection state
// ---------------------------------------------------------------------------

interface AgentConnection {
  instanceId: string;
  agentType: string;
  displayName: string;
  color: string;
  tcpPort: number;
  socket: net.Socket | null;
  buffer: string;
  processor: AgentProcessor;
  connected: boolean;
  lastSeq: number;
}

// ---------------------------------------------------------------------------
// EisenOrchestrator
// ---------------------------------------------------------------------------

/**
 * The orchestrator is the sole consumer of eisen-core TCP streams.
 * It maintains connections to N eisen-core instances, merges their
 * data via CRDT, and emits unified snapshots/deltas to the graph.
 */
export class EisenOrchestrator {
  private connections = new Map<string, AgentConnection>();
  private mergedState = new Map<string, MergedFileNode>();
  private seq = 0;

  /** Counter per agent type for display names: "claude-code" -> 1, 2, ... */
  private typeCounters = new Map<string, number>();

  /** Color assignment counter */
  private nextColorIndex = 0;

  // -----------------------------------------------------------------------
  // Event callbacks — set by the extension wiring layer
  // -----------------------------------------------------------------------

  /** Called when a merged snapshot is ready (full state replacement) */
  onMergedSnapshot: ((snapshot: MergedGraphSnapshot) => void) | null = null;

  /** Called when a merged delta is ready (incremental update) */
  onMergedDelta: ((delta: MergedGraphDelta) => void) | null = null;

  /** Called when the agent list changes (connect/disconnect) */
  onAgentUpdate: ((agents: AgentInfo[]) => void) | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Register and connect to a new agent's eisen-core TCP server.
   */
  addAgent(instanceId: string, tcpPort: number, agentType: string): void {
    if (this.connections.has(instanceId)) {
      console.warn(
        `[Orchestrator] Agent ${instanceId} already registered, skipping`,
      );
      return;
    }

    const displayName = this.allocateDisplayName(agentType);
    const color = this.allocateColor();
    const processor = getProcessor(agentType);

    const conn: AgentConnection = {
      instanceId,
      agentType,
      displayName,
      color,
      tcpPort,
      socket: null,
      buffer: "",
      processor,
      connected: false,
      lastSeq: 0,
    };

    this.connections.set(instanceId, conn);
    this.connectTcp(conn);
    this.emitAgentUpdate();

    console.log(
      `[Orchestrator] Added agent ${displayName} (${instanceId}) on port ${tcpPort}`,
    );
  }

  /**
   * Disconnect and remove an agent.
   */
  removeAgent(instanceId: string): void {
    const conn = this.connections.get(instanceId);
    if (!conn) {
      console.warn(
        `[Orchestrator] removeAgent called for unknown instanceId=${instanceId}, ignoring`,
      );
      return;
    }
    console.log(
      `[Orchestrator] Removing agent ${conn.displayName} (${instanceId}), mergedState has ${this.mergedState.size} nodes`,
    );

    // Disconnect TCP
    if (conn.socket) {
      conn.socket.destroy();
      conn.socket = null;
    }

    // Remove this agent's data from merged state
    const removedPaths: string[] = [];
    const updatedPaths: string[] = [];

    for (const [path, node] of this.mergedState) {
      const kept = removeAgentFromNode(node, instanceId);
      if (!kept) {
        removedPaths.push(path);
      } else {
        updatedPaths.push(path);
      }
    }

    // Clean up empty nodes
    for (const path of removedPaths) {
      this.mergedState.delete(path);
    }

    this.connections.delete(instanceId);
    this.emitAgentUpdate();

    // Emit delta reflecting the removal
    this.emitMergedDelta(updatedPaths, removedPaths);

    console.log(
      `[Orchestrator] Removed agent ${conn.displayName} (${instanceId})`,
    );
  }

  /**
   * Get a full merged snapshot of current state.
   */
  getMergedSnapshot(
    baselineNodes?: Record<string, any>,
    baselineCalls?: Array<{ from: string; to: string }>,
  ): MergedGraphSnapshot {
    this.seq++;
    const nodes: Record<string, MergedGraphNode> = {};

    // Include baseline nodes (workspace symbols)
    if (baselineNodes) {
      for (const [id, node] of Object.entries(baselineNodes)) {
        nodes[id] = {
          inContext: false,
          changed: false,
          lastAction: "read",
          agentHeat: {},
          agentContext: {},
          ...node,
        };
      }
    }

    // Overlay merged live state
    for (const [path, node] of this.mergedState) {
      const agentHeat: Record<string, number> = {};
      const agentContext: Record<string, boolean> = {};

      for (const [instId, agentState] of node.agents) {
        const conn = this.connections.get(instId);
        const name = conn?.displayName ?? instId;
        agentHeat[name] = agentState.heat;
        agentContext[name] = agentState.inContext;
      }

      nodes[path] = {
        ...nodes[path],
        inContext: node.inContext,
        changed: node.lastAction === "write",
        lastAction: node.lastAction,
        agentHeat,
        agentContext,
      };
    }

    return {
      seq: this.seq,
      nodes,
      calls: baselineCalls ?? [],
      agents: this.getAgentInfoList(),
    };
  }

  /**
   * Get the list of all known agents.
   */
  getAgentInfoList(): AgentInfo[] {
    const list: AgentInfo[] = [];
    for (const conn of this.connections.values()) {
      list.push({
        instanceId: conn.instanceId,
        displayName: conn.displayName,
        agentType: conn.agentType,
        color: conn.color,
        connected: conn.connected,
      });
    }
    return list;
  }

  /**
   * Check if any agents are connected.
   */
  hasConnectedAgents(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.connected) return true;
    }
    return false;
  }

  /**
   * Get agent count.
   */
  get agentCount(): number {
    return this.connections.size;
  }

  /**
   * Dispose all connections.
   */
  dispose(): void {
    for (const conn of this.connections.values()) {
      if (conn.socket) {
        conn.socket.destroy();
        conn.socket = null;
      }
    }
    this.connections.clear();
    this.mergedState.clear();
  }

  // -----------------------------------------------------------------------
  // TCP connection management
  // -----------------------------------------------------------------------

  private connectTcp(conn: AgentConnection): void {
    if (conn.socket) {
      conn.socket.destroy();
    }

    console.log(
      `[Orchestrator] Connecting to eisen-core TCP on port ${conn.tcpPort} for ${conn.displayName}`,
    );

    const socket = net.createConnection(
      { host: "127.0.0.1", port: conn.tcpPort },
      () => {
        console.log(
          `[Orchestrator] Connected to ${conn.displayName} TCP on port ${conn.tcpPort}`,
        );
        conn.connected = true;
        this.emitAgentUpdate();
      },
    );

    conn.socket = socket;
    conn.buffer = "";

    socket.on("data", (data: Buffer) => {
      conn.buffer += data.toString();

      // Back-pressure: if the buffer grows too large, pause the socket
      // until we've drained it. This prevents unbounded memory growth when
      // agents produce data faster than we can process it.
      const BUFFER_HIGH_WATER = 256 * 1024; // 256 KB
      if (conn.buffer.length > BUFFER_HIGH_WATER && !socket.isPaused()) {
        socket.pause();
      }

      const lines = conn.buffer.split("\n");
      conn.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: WireMessage = JSON.parse(line);
          this.handleMessage(conn, msg);
        } catch (e) {
          console.warn(
            `[Orchestrator] Failed to parse TCP line from ${conn.displayName}:`,
            (e as Error).message,
            line.substring(0, 200),
          );
        }
      }

      // Resume reading once buffer is drained
      if (socket.isPaused() && conn.buffer.length < BUFFER_HIGH_WATER) {
        socket.resume();
      }
    });

    socket.on("error", (err) => {
      console.error(
        `[Orchestrator] TCP error for ${conn.displayName}:`,
        err.message,
      );
    });

    socket.on("close", () => {
      console.log(
        `[Orchestrator] TCP connection closed for ${conn.displayName}`,
      );
      conn.connected = false;
      conn.socket = null;
      this.emitAgentUpdate();
    });
  }

  // -----------------------------------------------------------------------
  // Message handling & merge
  // -----------------------------------------------------------------------

  private handleMessage(conn: AgentConnection, msg: WireMessage): void {
    switch (msg.type) {
      case "snapshot":
        this.handleSnapshot(conn, msg);
        break;
      case "delta":
        this.handleDelta(conn, msg);
        break;
      case "usage":
        // Usage messages are processed but not merged into graph state.
        // Future: could track per-agent usage in the legend.
        conn.processor.processUsage(msg);
        break;
      default:
        console.log(
          `[Orchestrator] Unknown message type from ${conn.displayName}:`,
          (msg as any).type,
        );
    }
  }

  private handleSnapshot(
    conn: AgentConnection,
    msg: WireMessage & { type: "snapshot" },
  ): void {
    const processed = conn.processor.processSnapshot(msg);
    console.log(
      `[Orchestrator] Received snapshot from ${conn.displayName} (${conn.instanceId}): seq=${processed.seq}, ${processed.nodes.size} nodes`,
    );
    conn.lastSeq = processed.seq;

    // Clear this agent's existing entries from merged state
    for (const [path, node] of this.mergedState) {
      if (node.agents.has(conn.instanceId)) {
        removeAgentFromNode(node, conn.instanceId);
        if (node.agents.size === 0) {
          this.mergedState.delete(path);
        }
      }
    }

    // Apply all nodes from the snapshot
    for (const [path, update] of processed.nodes) {
      const agentState: AgentFileState = {
        heat: update.heat,
        inContext: update.inContext,
        lastAction: update.lastAction,
        timestampMs: update.timestampMs,
        turnAccessed: update.turnAccessed,
      };

      const existing = this.mergedState.get(path);
      if (existing) {
        applyAgentUpdate(existing, conn.instanceId, agentState);
      } else {
        this.mergedState.set(
          path,
          createMergedNode(path, conn.instanceId, agentState),
        );
      }
    }

    // After a snapshot, emit a full merged snapshot to the graph
    this.emitFullSnapshot();
  }

  private handleDelta(
    conn: AgentConnection,
    msg: WireMessage & { type: "delta" },
  ): void {
    const processed = conn.processor.processDelta(msg);

    // Skip stale deltas
    if (processed.seq <= conn.lastSeq) {
      console.log(
        `[Orchestrator] Skipping stale delta from ${conn.displayName}: seq=${processed.seq} <= lastSeq=${conn.lastSeq}`,
      );
      return;
    }
    conn.lastSeq = processed.seq;

    const updatedPaths: string[] = [];
    const removedPaths: string[] = [];

    // Apply updates
    for (const update of processed.updates) {
      const agentState: AgentFileState = {
        heat: update.heat,
        inContext: update.inContext,
        lastAction: update.lastAction,
        timestampMs: update.timestampMs,
        turnAccessed: update.turnAccessed,
      };

      const existing = this.mergedState.get(update.path);
      if (existing) {
        applyAgentUpdate(existing, conn.instanceId, agentState);
      } else {
        this.mergedState.set(
          update.path,
          createMergedNode(update.path, conn.instanceId, agentState),
        );
      }
      updatedPaths.push(update.path);
    }

    // Apply removals
    for (const path of processed.removed) {
      const node = this.mergedState.get(path);
      if (node) {
        const kept = removeAgentFromNode(node, conn.instanceId);
        if (!kept) {
          this.mergedState.delete(path);
          removedPaths.push(path);
        } else {
          updatedPaths.push(path);
        }
      }
    }

    if (updatedPaths.length > 0 || removedPaths.length > 0) {
      this.emitMergedDelta(updatedPaths, removedPaths);
    }
  }

  // -----------------------------------------------------------------------
  // Emit merged data to the graph
  // -----------------------------------------------------------------------

  private emitFullSnapshot(): void {
    if (!this.onMergedSnapshot) return;
    // The graph provider will call getMergedSnapshot() with its baseline
    // nodes overlaid. We emit a signal and let it pull.
    this.onMergedSnapshot(this.getMergedSnapshot());
  }

  private emitMergedDelta(
    updatedPaths: string[],
    removedPaths: string[],
  ): void {
    if (!this.onMergedDelta) return;

    this.seq++;
    const updates: MergedGraphDeltaUpdate[] = [];

    for (const path of updatedPaths) {
      const node = this.mergedState.get(path);
      if (!node) continue;

      const agentHeat: Record<string, number> = {};
      const agentContext: Record<string, boolean> = {};
      for (const [instId, agentState] of node.agents) {
        const conn = this.connections.get(instId);
        const name = conn?.displayName ?? instId;
        agentHeat[name] = agentState.heat;
        agentContext[name] = agentState.inContext;
      }

      updates.push({
        id: path,
        action: node.lastAction,
        inContext: node.inContext,
        changed: node.lastAction === "write",
        agentHeat,
        agentContext,
      });
    }

    for (const path of removedPaths) {
      updates.push({ id: path, action: "remove" });
    }

    if (updates.length > 0) {
      this.onMergedDelta({
        seq: this.seq,
        updates,
        agents: this.getAgentInfoList(),
      });
    }
  }

  private emitAgentUpdate(): void {
    this.onAgentUpdate?.(this.getAgentInfoList());
  }

  // -----------------------------------------------------------------------
  // Display name & color allocation
  // -----------------------------------------------------------------------

  private allocateDisplayName(agentType: string): string {
    const count = (this.typeCounters.get(agentType) ?? 0) + 1;
    this.typeCounters.set(agentType, count);
    // Simplify agent type for display: "claude-code" -> "claude"
    const shortType = agentType.split("-")[0];
    return `${shortType}_${count}`;
  }

  private allocateColor(): string {
    const color = AGENT_COLORS[this.nextColorIndex % AGENT_COLORS.length];
    this.nextColorIndex++;
    return color;
  }
}
