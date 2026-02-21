import type { NormalizedAction, WireDelta, WireFileNode, WireNodeUpdate, WireSnapshot, WireUsage } from "./types";
import { normalizeAction } from "./types";

// ---------------------------------------------------------------------------
// Processed output types — what processors return to the orchestrator
// ---------------------------------------------------------------------------

export interface ProcessedNodeUpdate {
  path: string;
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  turnAccessed: number;
  timestampMs: number;
}

export interface ProcessedSnapshot {
  agentId: string;
  sessionId: string;
  seq: number;
  nodes: Map<string, ProcessedNodeUpdate>;
}

export interface ProcessedDelta {
  agentId: string;
  sessionId: string;
  seq: number;
  updates: ProcessedNodeUpdate[];
  removed: string[];
}

export interface ProcessedUsage {
  agentId: string;
  sessionId: string;
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

// ---------------------------------------------------------------------------
// Abstract AgentProcessor
// ---------------------------------------------------------------------------

export abstract class AgentProcessor {
  abstract readonly agentType: string;

  /**
   * Process a raw snapshot from this agent's eisen-core.
   * Returns normalized nodes ready for merging.
   */
  abstract processSnapshot(snapshot: WireSnapshot): ProcessedSnapshot;

  /**
   * Process a raw delta from this agent's eisen-core.
   * Returns normalized updates ready for merging.
   */
  abstract processDelta(delta: WireDelta): ProcessedDelta;

  /**
   * Process usage messages. Override for agent-specific token accounting.
   */
  processUsage(usage: WireUsage): ProcessedUsage {
    return {
      agentId: usage.agent_id,
      sessionId: usage.session_id,
      used: usage.used,
      size: usage.size,
      cost: usage.cost,
    };
  }
}

// ---------------------------------------------------------------------------
// Default normalization helpers
// ---------------------------------------------------------------------------

function normalizeFileNode(path: string, node: WireFileNode): ProcessedNodeUpdate {
  return {
    path,
    heat: node.heat,
    inContext: node.in_context,
    lastAction: normalizeAction(node.last_action),
    turnAccessed: node.turn_accessed,
    timestampMs: node.timestamp_ms,
  };
}

function normalizeNodeUpdate(update: WireNodeUpdate): ProcessedNodeUpdate {
  return {
    path: update.path,
    heat: update.heat,
    inContext: update.in_context,
    lastAction: normalizeAction(update.last_action),
    turnAccessed: update.turn_accessed,
    timestampMs: update.timestamp_ms,
  };
}

// ---------------------------------------------------------------------------
// DefaultProcessor — pass-through with normalization
// ---------------------------------------------------------------------------

export class DefaultProcessor extends AgentProcessor {
  readonly agentType: string;

  constructor(agentType: string) {
    super();
    this.agentType = agentType;
  }

  processSnapshot(snapshot: WireSnapshot): ProcessedSnapshot {
    const nodes = new Map<string, ProcessedNodeUpdate>();
    if (snapshot.nodes) {
      for (const [path, node] of Object.entries(snapshot.nodes)) {
        nodes.set(path, normalizeFileNode(path, node));
      }
    }
    return {
      agentId: snapshot.agent_id,
      sessionId: snapshot.session_id,
      seq: snapshot.seq,
      nodes,
    };
  }

  processDelta(delta: WireDelta): ProcessedDelta {
    const updates: ProcessedNodeUpdate[] = [];
    if (delta.updates) {
      for (const u of delta.updates) {
        updates.push(normalizeNodeUpdate(u));
      }
    }
    return {
      agentId: delta.agent_id,
      sessionId: delta.session_id,
      seq: delta.seq,
      updates,
      removed: delta.removed ?? [],
    };
  }
}

// ---------------------------------------------------------------------------
// Processor registry
// ---------------------------------------------------------------------------

const PROCESSORS: Record<string, new (agentType: string) => AgentProcessor> = {
  // All agents use DefaultProcessor for now.
  // Agent-specific processors can be added here as needed:
  // "claude-code": ClaudeCodeProcessor,
  // "aider": AiderProcessor,
};

export function getProcessor(agentType: string): AgentProcessor {
  const Ctor = PROCESSORS[agentType];
  return Ctor ? new Ctor(agentType) : new DefaultProcessor(agentType);
}
