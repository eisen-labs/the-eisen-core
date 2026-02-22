import { CONFIG } from "./config";
import { deriveKind, deriveParent, isLikelyFilePath, type Node, type NodeKind, type State } from "./state";
import { palette, getNodeRgba, nodeSize } from "./theme";

export interface NodeMeta {
  kind: NodeKind;
  inContext?: boolean;
  lastAction?: "read" | "write" | "search";
  lines?: { start: number; end: number };
  tokens?: number;
  parentId: string;
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
}

export class GraphData {
  private idToIndex = new Map<string, number>();
  private indexToId: string[] = [];
  private nodeMeta = new Map<string, NodeMeta>();

  positions: Float32Array = new Float32Array(0);
  colors: Float32Array = new Float32Array(0);
  sizes: Float32Array = new Float32Array(0);
  links: Float32Array = new Float32Array(0);
  linkColors: Float32Array = new Float32Array(0);

  get count(): number {
    return this.indexToId.length;
  }

  indexOf(id: string): number | undefined {
    return this.idToIndex.get(id);
  }

  idOf(index: number): string | undefined {
    return this.indexToId[index];
  }

  getMeta(id: string): NodeMeta | undefined {
    return this.nodeMeta.get(id);
  }

  folderKeyOf(id: string): string {
    const path = id.includes("::") ? id.slice(0, id.indexOf("::")) : id;
    const parts = path.split("/").filter(Boolean);
    const isFile = isLikelyFilePath(path);
    if (!isFile) return path || (parts[0] ?? "");
    if (parts.length <= 1) return "";
    return parts.slice(0, -1).join("/");
  }

  allIds(): readonly string[] {
    return this.indexToId;
  }

  rebuild(state: State, existingPositions?: Map<string, [number, number]>): void {
    this.idToIndex.clear();
    this.indexToId = [];
    this.nodeMeta.clear();

    // Walk up from each node to root, adding implicit parents
    const allIds = new Set<string>();
    for (const id of state.nodes.keys()) {
      allIds.add(id);
      let parent = deriveParent(id);
      while (parent && !allIds.has(parent)) {
        allIds.add(parent);
        parent = deriveParent(parent);
      }
      if (!allIds.has("")) allIds.add("");
    }

    const ids = [...allIds].sort();
    for (let i = 0; i < ids.length; i++) {
      this.idToIndex.set(ids[i], i);
      this.indexToId.push(ids[i]);
    }

    for (const id of ids) {
      const node: Node | undefined = state.nodes.get(id);
      this.nodeMeta.set(id, {
        kind: node?.kind ?? deriveKind(id),
        inContext: node?.inContext,
        lastAction: node?.lastAction,
        lines: node?.lines,
        tokens: node?.tokens,
        parentId: deriveParent(id),
        agentHeat: node?.agentHeat,
        agentContext: node?.agentContext,
      });
    }

    const n = ids.length;
    if (existingPositions && existingPositions.size > 0) {
      this.reusePositions(n, ids, existingPositions);
    } else {
      this.buildPositions(n, ids);
    }
    this.buildColors(n, ids);
    this.buildSizes(n, ids);
    this.buildLinks(ids);
  }

  updateMeta(state: State): void {
    for (const [id, meta] of this.nodeMeta) {
      const node = state.nodes.get(id);
      if (!node) continue;
      meta.inContext = node.inContext;
      meta.lastAction = node.lastAction;
      meta.agentHeat = node.agentHeat;
      meta.agentContext = node.agentContext;
    }
    this.buildColors(this.indexToId.length, this.indexToId);
  }

  matchesNodeSet(state: State): boolean {
    const allIds = new Set<string>();
    for (const id of state.nodes.keys()) {
      allIds.add(id);
      let parent = deriveParent(id);
      while (parent && !allIds.has(parent)) {
        allIds.add(parent);
        parent = deriveParent(parent);
      }
      if (!allIds.has("")) allIds.add("");
    }
    if (allIds.size !== this.idToIndex.size) return false;
    for (const id of allIds) {
      if (!this.idToIndex.has(id)) return false;
    }
    return true;
  }

  private reusePositions(n: number, ids: string[], existing: Map<string, [number, number]>): void {
    const positions = new Float32Array(n * 2);
    const center = CONFIG.spaceSize / 2;
    for (let i = 0; i < n; i++) {
      const pos = existing.get(ids[i]);
      if (pos) {
        positions[i * 2] = pos[0];
        positions[i * 2 + 1] = pos[1];
      } else {
        const parentId = this.nodeMeta.get(ids[i])!.parentId;
        const pp = existing.get(parentId);
        const bx = pp ? pp[0] : center;
        const by = pp ? pp[1] : center;
        positions[i * 2] = bx + (Math.random() - 0.5) * 10;
        positions[i * 2 + 1] = by + (Math.random() - 0.5) * 10;
      }
    }
    this.positions = positions;
  }

  private buildPositions(n: number, ids: string[]): void {
    const positions = new Float32Array(n * 2);
    const center = CONFIG.spaceSize / 2;

    const childrenOf = new Map<string, string[]>();
    for (const id of ids) {
      if (id === "") continue;
      const parent = this.nodeMeta.get(id)!.parentId;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(id);
    }

    // Place root at center
    const rootIdx = this.idToIndex.get("");
    if (rootIdx !== undefined) {
      positions[rootIdx * 2] = center;
      positions[rootIdx * 2 + 1] = center;
    }

    const queue = [""];
    let radius = CONFIG.initialSpread;
    while (queue.length > 0) {
      const next: string[] = [];
      for (const parentId of queue) {
        const children = childrenOf.get(parentId);
        if (!children) continue;
        const pIdx = this.idToIndex.get(parentId);
        const px = pIdx !== undefined ? positions[pIdx * 2] : center;
        const py = pIdx !== undefined ? positions[pIdx * 2 + 1] : center;
        const r = Math.max(radius, children.length * 8);
        const step = (2 * Math.PI) / children.length;
        for (let i = 0; i < children.length; i++) {
          const idx = this.idToIndex.get(children[i])!;
          const angle = step * i + (Math.random() - 0.5) * 0.15;
          positions[idx * 2] = px + Math.cos(angle) * r;
          positions[idx * 2 + 1] = py + Math.sin(angle) * r;
          next.push(children[i]);
        }
      }
      queue.length = 0;
      queue.push(...next);
      radius *= 0.75;
    }
    this.positions = positions;
  }

  private buildColors(n: number, ids: string[]): void {
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const meta = this.nodeMeta.get(ids[i])!;
      let [r, g, b, a] = ids[i] === ""
        ? [255, 255, 255, 1] as [number, number, number, number]
        : getNodeRgba(ids[i], meta.kind);

      if (meta.inContext) {
        r = r * 0.6 + palette.inContextTint.r * 0.4;
        g = g * 0.6 + palette.inContextTint.g * 0.4;
        b = b * 0.6 + palette.inContextTint.b * 0.4;
      }

      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }
    this.colors = colors;
  }

  private buildSizes(n: number, ids: string[]): void {
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sizes[i] = nodeSize(this.nodeMeta.get(ids[i])!.kind, ids[i] === "");
    }
    this.sizes = sizes;
  }

  private buildLinks(ids: string[]): void {
    let n = 0;
    for (const id of ids) {
      const parentIdx = this.idToIndex.get(this.nodeMeta.get(id)!.parentId);
      if (parentIdx !== undefined && parentIdx !== this.idToIndex.get(id)!) n++;
    }

    const links = new Float32Array(n * 2);
    const linkColors = new Float32Array(n * 4);
    let w = 0;

    for (const id of ids) {
      const selfIdx = this.idToIndex.get(id)!;
      const parentIdx = this.idToIndex.get(this.nodeMeta.get(id)!.parentId);
      if (parentIdx !== undefined && parentIdx !== selfIdx) {
        links[w * 2] = parentIdx; links[w * 2 + 1] = selfIdx; w++;
      }
    }
    for (let i = 0; i < n; i++) {
      linkColors[i * 4] = palette.link[0]; linkColors[i * 4 + 1] = palette.link[1];
      linkColors[i * 4 + 2] = palette.link[2]; linkColors[i * 4 + 3] = palette.link[3];
    }
    this.links = links;
    this.linkColors = linkColors;
  }
}
