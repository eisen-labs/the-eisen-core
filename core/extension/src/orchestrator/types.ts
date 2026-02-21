// ---------------------------------------------------------------------------
// Wire protocol types — what eisen-core sends over TCP (snake_case JSON)
// ---------------------------------------------------------------------------

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
  seq: number;
  nodes: Record<string, WireFileNode>;
}

export interface WireDelta {
  type: "delta";
  agent_id: string;
  session_id: string;
  seq: number;
  updates: WireNodeUpdate[];
  removed: string[];
}

export interface WireUsage {
  type: "usage";
  agent_id: string;
  session_id: string;
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export type WireMessage = WireSnapshot | WireDelta | WireUsage;

// ---------------------------------------------------------------------------
// Normalized action type — collapse user_provided/user_referenced into read
// ---------------------------------------------------------------------------

export type NormalizedAction = "read" | "write" | "search";

export function normalizeAction(action: string): NormalizedAction {
  if (action === "write") return "write";
  if (action === "search") return "search";
  return "read";
}

// ---------------------------------------------------------------------------
// Per-agent state for a single file (the CRDT "replica")
// ---------------------------------------------------------------------------

export interface AgentFileState {
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  timestampMs: number;
  turnAccessed: number;
}

// ---------------------------------------------------------------------------
// Merged file node — stored in the orchestrator
// ---------------------------------------------------------------------------

export interface MergedFileNode {
  path: string;

  /** Per-agent replicas — the source of truth */
  agents: Map<string, AgentFileState>; // keyed by instanceId

  /** Derived merged view — recomputed from agents map */
  heat: number;
  inContext: boolean;
  lastAction: NormalizedAction;
  lastActionAgentId: string;
  lastActionTimestampMs: number;
}

// ---------------------------------------------------------------------------
// Agent info — metadata about a connected agent
// ---------------------------------------------------------------------------

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
  instanceId: string; // "claude-code-f8k2m1"
  displayName: string; // "claude_1"
  agentType: string; // "claude-code"
  color: string; // "#22d3ee"
  connected: boolean;
}

// ---------------------------------------------------------------------------
// Merged messages sent to the graph webview
// ---------------------------------------------------------------------------

export interface MergedGraphNode {
  inContext: boolean;
  changed: boolean;
  lastAction: NormalizedAction;
  /** Per-agent heat for ring rendering: { "claude_1": 0.8, "opencode_1": 0.4 } */
  agentHeat: Record<string, number>;
  /** Per-agent context status: { "claude_1": true, "opencode_1": false } */
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
