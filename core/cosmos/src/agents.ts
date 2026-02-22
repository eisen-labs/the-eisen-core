import type { CosmosGraph } from "./cosmos";
import type { Node, State } from "./state";
import { palette } from "./theme";

const SPRITE_PX = 64;
const RING_PX = 4;
const RING_GAP = 0.08;
const RING_OFFSET = 3.5;
const RING_R = SPRITE_PX / 2 - RING_PX / 2 - 1;
const RING_FRAC = RING_R / (SPRITE_PX / 2);

export class AgentLayer {
  private graph: CosmosGraph;
  private spriteCtx: CanvasRenderingContext2D | null = null;
  private dimmed: Uint8Array = new Uint8Array(0);
  private ringsSeq = -1;

  constructor(graph: CosmosGraph) {
    this.graph = graph;
  }

  apply(state: State, structureChanged: boolean): void {
    if (structureChanged || state.seq !== this.ringsSeq) {
      this.ringsSeq = state.seq;
      this.pushRings(state);
    }
    this.pushFilter(state);
    this.graph.render();
  }

  destroy(): void {}

  private pushRings(state: State): void {
    const { data } = this.graph;
    const n = data.count;
    const ids = data.allIds();

    const agentColors = new Map<string, string>();
    for (const agent of state.agents) agentColors.set(agent.displayName, agent.color);

    const images: ImageData[] = [];
    const indices = new Float32Array(n).fill(-1);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) sizes[i] = data.sizes[i];

    for (let i = 0; i < n; i++) {
      const node = state.nodes.get(ids[i]);
      if (!node?.agentHeat) continue;

      const entries: [string, number, string][] = [];
      let totalHeat = 0;
      for (const [name, heat] of Object.entries(node.agentHeat)) {
        if (heat <= 0) continue;
        entries.push([name, heat, agentColors.get(name) ?? "#888"]);
        totalHeat += heat;
      }
      if (entries.length === 0) continue;
      entries.sort((a, b) => a[0].localeCompare(b[0]));

      indices[i] = images.length;
      images.push(this.renderSprite(entries, totalHeat, state));
      sizes[i] = (data.sizes[i] + 2 * RING_OFFSET) / RING_FRAC;
    }

    this.graph.pushImages(images, indices, sizes);
  }

  private renderSprite(
    entries: [string, number, string][],
    totalHeat: number,
    state: State,
  ): ImageData {
    if (!this.spriteCtx) {
      const c = document.createElement("canvas");
      c.width = SPRITE_PX;
      c.height = SPRITE_PX;
      this.spriteCtx = c.getContext("2d")!;
    }
    const ctx = this.spriteCtx;
    ctx.clearRect(0, 0, SPRITE_PX, SPRITE_PX);

    const cx = SPRITE_PX / 2;
    const totalGap = entries.length * RING_GAP;
    const available = 2 * Math.PI - totalGap;
    if (available <= 0) return ctx.getImageData(0, 0, SPRITE_PX, SPRITE_PX);

    ctx.lineWidth = RING_PX;
    let angle = -Math.PI / 2;
    for (const [name, heat, color] of entries) {
      const sweep = (heat / totalHeat) * available;
      ctx.globalAlpha = (state.agentFilterActive && !state.visibleAgents.has(name)) ? 0.15 : 1.0;
      ctx.beginPath();
      ctx.arc(cx, cx, RING_R, angle, angle + sweep);
      ctx.strokeStyle = color;
      ctx.stroke();
      angle += sweep + RING_GAP;
    }
    ctx.globalAlpha = 1.0;
    return ctx.getImageData(0, 0, SPRITE_PX, SPRITE_PX);
  }

  private isNodeActive(node: Node | undefined): boolean {
    if (!node) return false;
    return !!(node.inContext || node.lastAction === "read" || node.lastAction === "write" || node.lastAction === "search");
  }

  private pushFilter(state: State): void {
    const { data } = this.graph;
    const ids = data.allIds();
    const n = ids.length;
    const { colors, linkColors, links } = data;

    for (let i = 0; i < n; i++) colors[i * 4 + 3] = 1.0;
    const linkCount = links.length / 2;
    for (let i = 0; i < linkCount; i++) linkColors[i * 4 + 3] = palette.link[3];

    if (this.dimmed.length < n) this.dimmed = new Uint8Array(n);
    else this.dimmed.fill(0);

    // Mode 1: all nodes in graph, inactive dimmed to 0.15
    if (state.viewMode === 1) {
      for (let i = 0; i < n; i++) {
        if (!this.isNodeActive(state.nodes.get(ids[i]))) {
          colors[i * 4 + 3] = 0.15;
          this.dimmed[i] = 1;
        }
      }
    }

    // Agent filter dimming stacks on top
    if (state.agentFilterActive) {
      for (let i = 0; i < n; i++) {
        if (this.dimmed[i]) continue;
        const node = state.nodes.get(ids[i]);
        if (!node?.agentHeat) continue;
        let visible = false;
        for (const [agent, heat] of Object.entries(node.agentHeat)) {
          if (heat > 0 && state.visibleAgents.has(agent)) { visible = true; break; }
        }
        if (!visible) {
          colors[i * 4 + 3] = 0.08;
          this.dimmed[i] = 1;
        }
      }
    }

    for (let i = 0; i < linkCount; i++) {
      if (this.dimmed[links[i * 2]] || this.dimmed[links[i * 2 + 1]]) {
        linkColors[i * 4 + 3] = 0.06;
      }
    }

    this.graph.pushColors();
  }
}
