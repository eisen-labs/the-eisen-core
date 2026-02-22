import type { AgentFileState, MergedFileNode, NormalizedAction } from "./types";

const ACTION_PRIORITY: Record<string, number> = {
  write: 3,
  search: 2,
  read: 1,
};

export interface DerivedView {
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  lastActionAgentId: string;
  lastActionTimestampMs: number;
}

export function deriveMergedView(agents: Map<string, AgentFileState>): DerivedView {
  let heat = 0;
  let inContext = false;
  let lastAction: NormalizedAction = "read";
  let lastAgentId = "";
  let lastTimestamp = 0;

  for (const [agentId, state] of agents) {
    heat = Math.max(heat, state.heat);
    inContext = inContext || state.inContext;

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
