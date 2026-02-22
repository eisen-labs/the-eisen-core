export type NodeKind = "folder" | "file" | "class" | "method" | "function";

export interface LineRange {
  start: number;
  end: number;
}

export interface Node {
  kind?: NodeKind;
  lines?: LineRange;
  tokens?: number;
  inContext?: boolean;
  lastAction?: "read" | "write" | "search";
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
}

export interface CallEdge {
  from: string;
  to: string;
}

export interface AgentInfo {
  instanceId: string;
  displayName: string;
  agentType: string;
  color: string;
  connected: boolean;
}

export interface Snapshot {
  seq: number;
  nodes: Record<string, Node>;
  calls?: CallEdge[];
  agents?: AgentInfo[];
}

export type ViewMode = 0 | 1 | 2;

export interface State {
  seq: number;
  nodes: Map<string, Node>;
  calls: CallEdge[];
  agents: AgentInfo[];
  visibleAgents: Set<string>;
  agentFilterActive: boolean;
  viewMode: ViewMode;
}

export function createState(): State {
  return { seq: 0, nodes: new Map(), calls: [], agents: [], visibleAgents: new Set(), agentFilterActive: false, viewMode: 0 };
}

export function applySnapshot(state: State, snapshot: Snapshot): void {
  if (!snapshot || typeof snapshot !== "object") return;
  state.seq = Number(snapshot.seq) || 0;
  state.nodes.clear();
  if (snapshot.nodes && typeof snapshot.nodes === "object") {
    for (const [id, node] of Object.entries(snapshot.nodes)) {
      if (node && typeof node === "object") state.nodes.set(id, { ...node });
    }
  }
  state.calls = Array.isArray(snapshot.calls) ? snapshot.calls : [];
  if (Array.isArray(snapshot.agents)) state.agents = snapshot.agents;
}

export interface DeltaUpdate {
  id: string;
  action: "read" | "write" | "search" | "remove";
  inContext?: boolean;
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
}

export interface Delta {
  seq: number;
  updates: DeltaUpdate[];
  agents?: AgentInfo[];
}

export interface DeltaResult {
  topologyChanged: boolean;
}

export function applyDelta(state: State, delta: Delta): DeltaResult {
  state.seq = delta.seq;
  if (Array.isArray(delta.agents)) state.agents = delta.agents;

  let topologyChanged = false;
  for (const u of delta.updates) {
    if (u.action === "remove") {
      if (state.nodes.has(u.id)) topologyChanged = true;
      state.nodes.delete(u.id);
      continue;
    }
    const existing = state.nodes.get(u.id);
    if (!existing) topologyChanged = true;
    state.nodes.set(u.id, {
      ...existing,
      lastAction: u.action,
      inContext: u.inContext,
      agentHeat: u.agentHeat ?? existing?.agentHeat,
      agentContext: u.agentContext ?? existing?.agentContext,
    });
  }
  return { topologyChanged };
}

export function isLikelyFilePath(path: string): boolean {
  if (!path || path.endsWith("/")) return false;
  const leaf = path.split("/").filter(Boolean).pop() ?? "";
  if (!leaf) return false;
  return /\.[A-Za-z0-9]+$/.test(leaf) || /^[A-Z0-9][A-Z0-9._-]*$/.test(leaf);
}

export function deriveKind(id: string): NodeKind {
  if (!id.includes("::")) return isLikelyFilePath(id) ? "file" : "folder";
  return id.split("::").length === 2 ? "class" : "method";
}

export function deriveParent(id: string): string {
  if (id.includes("::")) return id.slice(0, id.lastIndexOf("::"));
  const parts = id.split("/");
  parts.pop();
  return parts.join("/");
}

export function computeActiveView(state: State): State {
  if (state.viewMode !== 0) return state;

  const activeIds = new Set<string>();
  for (const [id, node] of state.nodes) {
    if (node.inContext || node.lastAction === "read" || node.lastAction === "write" || node.lastAction === "search") {
      activeIds.add(id);
    }
  }
  if (activeIds.size === 0) return state;

  // Add ancestors so the tree stays connected
  for (const id of [...activeIds]) {
    let cur = id;
    while (true) {
      const parent = deriveParent(cur);
      if (parent === cur) break;
      activeIds.add(parent);
      cur = parent;
    }
  }

  const filtered = new Map<string, Node>();
  for (const id of activeIds) {
    const node = state.nodes.get(id);
    if (node) filtered.set(id, node);
  }

  return { ...state, nodes: filtered };
}
