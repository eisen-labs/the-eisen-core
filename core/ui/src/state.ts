export type NodeKind = "folder" | "file" | "class" | "method" | "function";

export interface LineRange {
  start: number;
  end: number;
}

export interface Node {
  kind?: NodeKind;
  lastWrite?: number;
  lines?: LineRange;
  inContext?: boolean;
  changed?: boolean;
  lastAction?: "read" | "write" | "search";

  // Multi-agent attribution
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

export interface Delta {
  seq: number;
  updates: Array<{
    id: string;
    kind?: NodeKind;
    lines?: LineRange;
    inContext?: boolean;
    changed?: boolean;
    action: "read" | "write" | "search" | "remove";
    agentHeat?: Record<string, number>;
    agentContext?: Record<string, boolean>;
  }>;
  agents?: AgentInfo[];
}

export interface State {
  seq: number;
  nodes: Map<string, Node>;
  calls: CallEdge[];
  agents: AgentInfo[];
  /** When agentFilterActive is true, only agents in this set are shown (empty = none). When false, all are shown. */
  visibleAgents: Set<string>;
  /** Whether the agent toggle filter is engaged. False = show all, true = use visibleAgents set. */
  agentFilterActive: boolean;
}

export function createState(): State {
  return { seq: 0, nodes: new Map(), calls: [], agents: [], visibleAgents: new Set(), agentFilterActive: false };
}

export function deriveParent(id: string): string {
  if (id.includes("::")) return id.slice(0, id.lastIndexOf("::"));
  const parts = id.split("/");
  parts.pop();
  return parts.join("/");
}

const EXTENSIONLESS_FILE_NAMES = new Set([
  "dockerfile",
  "makefile",
  "gemfile",
  "procfile",
  "podfile",
  "rakefile",
  "vagrantfile",
  "jenkinsfile",
  "brewfile",
  "license",
  "licence",
  "readme",
  "notice",
  "copying",
  "changelog",
  "authors",
  "contributing",
]);

export function isLikelyFilePath(path: string): boolean {
  if (!path || path.endsWith("/")) return false;
  const leaf = path.split("/").filter(Boolean).pop() ?? "";
  if (!leaf) return false;
  return (
    /\.[A-Za-z0-9]+$/.test(leaf) ||
    EXTENSIONLESS_FILE_NAMES.has(leaf.toLowerCase()) ||
    /^[A-Z0-9][A-Z0-9._-]*$/.test(leaf)
  );
}

function deriveKind(id: string): NodeKind {
  if (!id.includes("::")) {
    return isLikelyFilePath(id) ? "file" : "folder";
  }
  return id.split("::").length === 2 ? "class" : "method";
}

export function getNodeDisplayInfo(id: string, kind?: NodeKind): { label: string; kind: NodeKind } {
  const depth = id.includes("::") ? id.split("::").length - 1 : 0;
  const k = depth >= 2 ? "method" : (kind ?? deriveKind(id));
  let label: string;
  if (id.includes("::")) label = id.split("::").pop()!;
  else if (!id) label = "/";
  else label = id.split("/").filter(Boolean).pop() || "/";
  if (k === "folder" && id !== "") label += "/";
  return { label, kind: k };
}

export function formatLabelWithLines(name: string, lines?: LineRange): string {
  return lines ? `${name} (${lines.start}–${lines.end})` : name;
}

export function applySnapshot(state: State, snapshot: Snapshot): void {
  if (!snapshot || typeof snapshot !== "object") return;
  state.seq = Number(snapshot.seq) || 0;
  state.nodes.clear();
  const nodes = snapshot.nodes;
  if (nodes && typeof nodes === "object") {
    for (const [id, node] of Object.entries(nodes)) {
      if (node && typeof node === "object") state.nodes.set(id, { ...node });
    }
  }
  state.calls = Array.isArray(snapshot.calls) ? snapshot.calls : [];
  if (Array.isArray(snapshot.agents)) {
    state.agents = snapshot.agents;
  }
}

export function applyDelta(state: State, delta: Delta): void {
  if (!delta || typeof delta !== "object" || delta.seq == null) return;
  const nextSeq = Number(delta.seq);
  if (nextSeq <= state.seq) return;
  state.seq = nextSeq;
  const updates = Array.isArray(delta.updates) ? delta.updates : [];
  for (const u of updates) {
    if (u.action === "remove") {
      state.nodes.delete(u.id);
      continue;
    }

    const existing = state.nodes.get(u.id);
    const changed = u.changed ?? u.action === "write";

    if (existing) {
      if (u.kind !== undefined) existing.kind = u.kind;
      if (u.lines !== undefined) existing.lines = u.lines;
      if (u.inContext !== undefined) existing.inContext = u.inContext;
      existing.changed = changed;
      existing.lastAction = u.action;
      if (u.agentHeat !== undefined) existing.agentHeat = u.agentHeat;
      if (u.agentContext !== undefined) existing.agentContext = u.agentContext;
    } else {
      state.nodes.set(u.id, {
        kind: u.kind,
        lines: u.lines,
        inContext: u.inContext,
        changed,
        lastAction: u.action,
        agentHeat: u.agentHeat,
        agentContext: u.agentContext,
      });
    }
  }
  if (Array.isArray(delta.agents)) {
    state.agents = delta.agents;
  }
}
