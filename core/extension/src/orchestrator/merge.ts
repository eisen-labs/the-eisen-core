import type { AgentFileState, MergedFileNode, NormalizedAction } from "./types";

// ---------------------------------------------------------------------------
// Action priority for LWW tiebreak
// ---------------------------------------------------------------------------

const ACTION_PRIORITY: Record<string, number> = {
  write: 3,
  search: 2,
  read: 1,
};

// ---------------------------------------------------------------------------
// Derive merged view from per-agent replicas
// ---------------------------------------------------------------------------

export interface DerivedView {
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  lastActionAgentId: string;
  lastActionTimestampMs: number;
}

/**
 * Recompute the merged derived view from the agents map.
 *
 * Properties:
 * - Commutative: merge(A, B) = merge(B, A)
 * - Associative: merge(merge(A, B), C) = merge(A, merge(B, C))
 * - Idempotent:  merge(A, A) = A
 *
 * These guarantee convergence regardless of message ordering.
 */
export function deriveMergedView(agents: Map<string, AgentFileState>): DerivedView {
  let heat = 0;
  let inContext = false;
  let lastAction: NormalizedAction = "read";
  let lastAgentId = "";
  let lastTimestamp = 0;

  for (const [agentId, state] of agents) {
    // Heat: max across all agents
    heat = Math.max(heat, state.heat);

    // In-context: OR across all agents
    inContext = inContext || state.inContext;

    // Last action: LWW with priority tiebreak
    const dominates =
      state.timestampMs > lastTimestamp ||
      (state.timestampMs === lastTimestamp &&
        (ACTION_PRIORITY[state.lastAction] ?? 0) > (ACTION_PRIORITY[lastAction] ?? 0));

    if (dominates) {
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

// ---------------------------------------------------------------------------
// Apply an update to a MergedFileNode
// ---------------------------------------------------------------------------

/**
 * Update a single agent's state within a merged file node and recompute
 * the derived view. Returns the updated node.
 */
export function applyAgentUpdate(node: MergedFileNode, instanceId: string, state: AgentFileState): MergedFileNode {
  node.agents.set(instanceId, state);
  const view = deriveMergedView(node.agents);
  node.heat = view.heat;
  node.inContext = view.inContext;
  node.lastAction = view.lastAction;
  node.lastActionAgentId = view.lastActionAgentId;
  node.lastActionTimestampMs = view.lastActionTimestampMs;
  return node;
}

/**
 * Remove an agent's state from a merged file node and recompute.
 * Returns true if the node still has agents (should be kept),
 * false if the agents map is empty (should be removed).
 */
export function removeAgentFromNode(node: MergedFileNode, instanceId: string): boolean {
  node.agents.delete(instanceId);

  if (node.agents.size === 0) {
    return false;
  }

  const view = deriveMergedView(node.agents);
  node.heat = view.heat;
  node.inContext = view.inContext;
  node.lastAction = view.lastAction;
  node.lastActionAgentId = view.lastActionAgentId;
  node.lastActionTimestampMs = view.lastActionTimestampMs;
  return true;
}

/**
 * Create a new MergedFileNode from an initial agent state.
 */
export function createMergedNode(path: string, instanceId: string, state: AgentFileState): MergedFileNode {
  const agents = new Map<string, AgentFileState>();
  agents.set(instanceId, state);
  return {
    path,
    agents,
    heat: state.heat,
    inContext: state.inContext,
    lastAction: state.lastAction,
    lastActionAgentId: instanceId,
    lastActionTimestampMs: state.timestampMs,
  };
}
