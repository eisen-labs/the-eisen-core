// Wire protocol types — what eisen-core sends over TCP (snake_case JSON)

export interface WireFileNode {
  path: string;
  heat: number;
  in_context: boolean;
  last_action: "read" | "write" | "search" | "user_provided" | "user_referenced";
  turn_accessed: number;
  timestamp_ms: number;
}

export interface WireNodeUpdate {
  path: string;
  heat: number;
  in_context: boolean;
  last_action: "read" | "write" | "search" | "user_provided" | "user_referenced";
  turn_accessed: number;
  timestamp_ms: number;
}

export interface WireSnapshot {
  type: "snapshot";
  agent_id: string;
  session_id: string;
  session_mode?: "single_agent" | "orchestrator";
  seq: number;
  nodes: Record<string, WireFileNode>;
}

export interface WireDelta {
  type: "delta";
  agent_id: string;
  session_id: string;
  session_mode?: "single_agent" | "orchestrator";
  seq: number;
  updates: WireNodeUpdate[];
  removed: string[];
}

export interface WireUsage {
  type: "usage";
  agent_id: string;
  session_id: string;
  session_mode?: "single_agent" | "orchestrator";
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface RpcResult {
  type: "rpc_result" | "rpc_error";
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

export type WireMessage = WireSnapshot | WireDelta | WireUsage | RpcResult;

export type NormalizedAction = "read" | "write" | "search";

export function normalizeAction(action: string): NormalizedAction {
  if (action === "write") return "write";
  if (action === "search") return "search";
  return "read";
}

export interface AgentFileState {
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  timestampMs: number;
  turnAccessed: number;
}

export interface MergedFileNode {
  path: string;
  agents: Map<string, AgentFileState>;
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  lastActionAgentId: string;
  lastActionTimestampMs: number;
}

// Keep in sync with ui/src/theme.ts AGENT_COLORS
export const AGENT_COLORS = [
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#a78bfa", // violet
  "#fbbf24", // amber
  "#34d399", // emerald
  "#38bdf8", // sky
  "#f472b6", // pink
];

export interface AgentInfo {
  instanceId: string;
  displayName: string;
  agentType: string;
  color: string;
  connected: boolean;
}

export interface MergedGraphNode {
  inContext: boolean;
  changed: boolean;
  lastAction: NormalizedAction;
  agentHeat: Record<string, number>;
  agentContext: Record<string, boolean>;
}

export interface MergedGraphSnapshot {
  seq: number;
  nodes: Record<string, MergedGraphNode>;
  calls: Array<{ from: string; to: string }>;
  agents: AgentInfo[];
}

export interface MergedGraphDeltaUpdate {
  id: string;
  action: NormalizedAction | "remove";
  inContext?: boolean;
  changed?: boolean;
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
}

export interface MergedGraphDelta {
  seq: number;
  updates: MergedGraphDeltaUpdate[];
  agents: AgentInfo[];
}
