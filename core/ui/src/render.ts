// @ts-expect-error no type declarations
import { forceCollide, forceLink, forceManyBody } from "d3-force-3d";
import ForceGraph from "force-graph";
import { drawRegionLabel as paintRegionLabel } from "./region-draw";
import { convexHull, expandPolygon, type Point, pointInPolygon, polygonArea, resamplePolygon } from "./region-geometry";
import {
  type AgentInfo,
  deriveParent,
  formatLabelWithLines,
  getNodeDisplayInfo,
  type NodeKind,
  type State,
  type ViewMode,
} from "./state";
import {
  getFolderBg,
  getFolderBgReferenced,
  getFolderBgSelected,
  getFolderStroke,
  getFolderStrokeReferenced,
  getFolderStrokeSelected,
  getNodeColor,
  getNodeStroke,
  getRegionKey,
  nodeRadius,
  nodeVal,
  palette,
} from "./theme";

interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  inContext?: boolean;
  lastAction?: "read" | "write" | "search";
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
  tokens?: number;
  x?: number;
  y?: number;
}

interface SimNode extends GraphNode {
  vx?: number;
  vy?: number;
}

interface GraphLink {
  source: string;
  target: string;
  type?: "structure" | "call";
}

interface RegionInputPoint extends Point {
  kind: NodeKind;
}

interface RegionLayer {
  points: Point[];
}

interface RegionBubble {
  members: SimNode[];
  cx: number;
  cy: number;
  radius: number;
  mass: number;
}

interface RegionLabelDraw {
  points: Point[];
  alpha: number;
  label: string;
}

type Graph = any;

const REGION_MASS: Record<NodeKind, number> = {
  folder: 1.5,
  file: 1,
  class: 0.7,
  function: 0.65,
  method: 0.55,
};
const REGION_SPREAD_BY_KIND: Record<NodeKind, number> = {
  folder: 1,
  file: 0.85,
  class: 0.62,
  function: 0.62,
  method: 0.5,
};

export class Renderer {
  private graph: Graph;
  private nodes: GraphNode[] = [];
  private links: GraphLink[] = [];
  private nodeMap = new Map<string, GraphNode>();
  private initialized = false;
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();
  private callerIds = new Set<string>();
  private selectedRegionKeys = new Set<string>();
  private referencedRegionKeys = new Set<string>();
  private callEdges: Array<{ from: string; to: string }> = [];
  private regionLabelDraws: RegionLabelDraw[] = [];
  private hoveredRegionKey: string | null = null;
  private pointerScreen: Point | null = null;
  private regionLayers = new Map<string, RegionLayer>();
  private viewMode: ViewMode = 0;
  private activeNodeIds = new Set<string>();
  private activeRegionKeys = new Set<string>();
  private viewNodeIds = new Set<string>();
  private viewSignature = "";
  private lastAppliedViewMode: ViewMode | null = null;
  private regionDepthMode: number | null = null;
  private maxRegionDepth = 0;
  private pendingGraphUpdate: ReturnType<typeof setTimeout> | null = null;
  private agents: AgentInfo[] = [];
  private visibleAgents = new Set<string>();
  private agentFilterActive = false;
  private depsMode = false;
  private depsVisibleIds = new Set<string>();
  private onHoverCallback?: (id: string | null, screenX?: number, screenY?: number) => void;
  private static readonly ACTIVE_LINK_DISTANCE_FACTOR = 0.9;
  private static readonly ACTIVE_LINK_STRENGTH_FACTOR = 2.0;
  private static readonly ACTIVE_CHARGE_FACTOR = 0.7;
  private static readonly ACTIVE_CHARGE_DISTANCE_FACTOR = 0.75;
  private static readonly ACTIVE_COLLIDE_FACTOR = 0.95;

  constructor(
    container: HTMLElement,
    opts?: { onHover?: (id: string | null, screenX?: number, screenY?: number) => void },
  ) {
    this.onHoverCallback = opts?.onHover;
    this.graph = this.createGraph(container);
    this.bindPointerEvents(container);
    new ResizeObserver(() => {
      this.graph.width(container.clientWidth);
      this.graph.height(container.clientHeight);
    }).observe(container);
  }

  cycleRegionDepthMode(): void {
    const mode = this.regionDepthMode ?? this.maxRegionDepth;
    const max = this.maxRegionDepth;
    this.regionDepthMode = max <= 0 ? 0 : (mode + 1) % (max + 1);
    if (this.regionDepthMode === 0) this.hoveredRegionKey = null;
  }

  cycleViewMode(): void {
    if (this.depsMode) return;
    this.viewMode = ((this.viewMode + 1) % 3) as ViewMode;
  }

  toggleDepsMode(): boolean {
    this.depsMode = !this.depsMode;
    this.viewMode = 2 as ViewMode;
    return this.depsMode;
  }

  getDepsMode(): boolean {
    return this.depsMode;
  }

  private bindPointerEvents(container: HTMLElement): void {
    container.addEventListener("mousemove", (event) => {
      const rect = container.getBoundingClientRect();
      this.pointerScreen = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      this.updateHoveredRegionFromPointer();
    });

    container.addEventListener("mouseleave", () => {
      this.pointerScreen = null;
      this.hoveredRegionKey = null;
    });
  }

  private updateHoveredRegionFromPointer(): void {
    if (!this.pointerScreen || this.regionLayers.size === 0) {
      this.hoveredRegionKey = null;
      return;
    }

    const toGraph = this.graph.screen2GraphCoords;
    if (typeof toGraph !== "function") {
      this.hoveredRegionKey = null;
      return;
    }

    const point = toGraph(this.pointerScreen.x, this.pointerScreen.y);
    this.hoveredRegionKey = this.pickRegionAt(point.x, point.y);
  }

  private pickRegionAt(x: number, y: number): string | null {
    const layers = [...this.regionLayers.entries()]
      .filter(([, layer]) => layer.points.length >= 3)
      .sort((a, b) => polygonArea(a[1].points) - polygonArea(b[1].points));

    for (const [key, layer] of layers) {
      if (pointInPolygon(x, y, layer.points)) return key;
    }

    return null;
  }

  private linkEndpointId(endpoint: unknown): string | null {
    if (typeof endpoint === "string") return endpoint;
    if (endpoint && typeof endpoint === "object" && "id" in endpoint) {
      const id = (endpoint as { id?: unknown }).id;
      return typeof id === "string" ? id : null;
    }
    return null;
  }

  private isNodeActive(id: string): boolean {
    return this.activeNodeIds.has(id);
  }

  private isNodeVisible(id: string): boolean {
    return this.viewNodeIds.has(id);
  }

  private nodeAlpha(id: string): number {
    if (this.viewMode === 1 && !this.isNodeActive(id)) return 0.15;
    if (this.agentFilterActive) {
      const gn = this.nodeMap.get(id);
      if (gn?.agentHeat && Object.keys(gn.agentHeat).length > 0) {
        const hasVisibleAgent = Object.entries(gn.agentHeat).some(([name, h]) => h > 0 && this.visibleAgents.has(name));
        if (!hasVisibleAgent) return 0.08;
      }
    }
    return 1;
  }

  private linkAlpha(link: any): number {
    const sourceId = this.linkEndpointId(link.source);
    const targetId = this.linkEndpointId(link.target);
    if (this.viewMode === 1) {
      if (sourceId == null || targetId == null) return 0.15;
      return this.isNodeActive(sourceId) && this.isNodeActive(targetId) ? 1 : 0.12;
    }
    // Agent filter — dim links where both endpoints are hidden-agent-only
    if (this.agentFilterActive && sourceId != null && targetId != null) {
      const srcAlpha = this.nodeAlpha(sourceId);
      const tgtAlpha = this.nodeAlpha(targetId);
      if (srcAlpha < 0.5 || tgtAlpha < 0.5) return 0.06;
    }
    return 1;
  }

  private isLinkVisible(link: any): boolean {
    if (this.viewMode !== 0) return true;
    const sourceId = this.linkEndpointId(link.source);
    const targetId = this.linkEndpointId(link.target);
    return sourceId !== null && targetId !== null && this.isNodeVisible(sourceId) && this.isNodeVisible(targetId);
  }

  private colorWithAlpha(color: string, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    if (a >= 1) return color;

    const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
    if (hex) {
      const raw = hex[1];
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${a})`;
    }

    const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
    if (rgb) {
      return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`;
    }

    const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
    if (rgba) {
      const baseA = Number(rgba[4]);
      const outA = Math.max(0, Math.min(1, baseA * a));
      return `rgba(${rgba[1]},${rgba[2]},${rgba[3]},${outA})`;
    }

    return color;
  }

  private getLinkColor(link: any): string {
    if (!this.isLinkVisible(link)) return "rgba(0,0,0,0)";
    const alpha = this.linkAlpha(link);
    if (link.type === "call") return this.colorWithAlpha(palette.link.callColor, alpha);
    return this.colorWithAlpha(palette.link.color, alpha);
  }

  private getLinkWidth(link: any): number {
    if (!this.isLinkVisible(link)) return 0;
    if (link.type === "call") return palette.link.callWidth;
    return palette.link.width;
  }

  private buildViewData(): {
    nodes: GraphNode[];
    links: GraphLink[];
    signature: string;
  } {
    const activeIds = [...this.activeNodeIds].filter((id) => this.nodeMap.has(id)).sort();
    const activeSig = activeIds.join(",");

    if (this.depsMode && this.depsVisibleIds.size > 0) {
      const idSet = this.depsVisibleIds;
      this.viewNodeIds = idSet;
      const depsSig = [...idSet].sort().join(",");
      const nodes = [...idSet].map((id) => this.nodeMap.get(id)).filter((n): n is GraphNode => !!n);
      const links: GraphLink[] = [];
      for (const l of this.links) {
        const source = this.linkEndpointId(l.source);
        const target = this.linkEndpointId(l.target);
        if (source == null || target == null) continue;
        if (!idSet.has(source) || !idSet.has(target)) continue;
        links.push({ source, target, type: l.type });
      }
      return { nodes, links, signature: `deps:${depsSig}` };
    }

    if (this.viewMode !== 0) {
      const allIds = new Set(this.nodes.map((n) => n.id));
      this.viewNodeIds = allIds;
      return {
        nodes: this.nodes,
        links: this.links,
        signature: `full:${this.viewMode}:${activeSig}`,
      };
    }

    const idSet = new Set(activeIds);
    this.viewNodeIds = idSet;

    const nodes = activeIds.map((id) => this.nodeMap.get(id)).filter((n): n is GraphNode => !!n);
    const links: GraphLink[] = [];
    for (const l of this.links) {
      const source = this.linkEndpointId(l.source);
      const target = this.linkEndpointId(l.target);
      if (source == null || target == null) continue;
      if (!idSet.has(source) || !idSet.has(target)) continue;
      links.push({ source, target, type: l.type });
    }

    return {
      nodes,
      links,
      signature: `v0:${activeSig}`,
    };
  }

  private createGraph(container: HTMLElement): Graph {
    return (ForceGraph as any)()(container)
      .autoPauseRedraw(false)
      .backgroundColor(palette.background)
      .maxZoom(2)
      .nodeId("id")
      .nodeLabel("")
      .nodeVal((n: any) => nodeVal(n.kind))
      .linkColor((l: any) => this.getLinkColor(l))
      .linkWidth((l: any) => this.getLinkWidth(l))
      .cooldownTicks(palette.force.cooldownTicks)
      .d3Force(
        "link",
        forceLink()
          .distance((l: any) => {
            if (l.type === "call") return 0;
            const sourceKind = l.source?.kind as NodeKind | undefined;
            const targetKind = l.target?.kind as NodeKind | undefined;
            let base = palette.force.linkDistance;
            if (sourceKind === "folder" || targetKind === "folder") {
              base = palette.force.linkDistanceFolder;
            } else if (targetKind === "class" || targetKind === "method" || targetKind === "function") {
              base = palette.force.linkDistanceSymbol;
            }
            if (this.viewMode === 0) {
              return Math.max(6, base * Renderer.ACTIVE_LINK_DISTANCE_FACTOR);
            }
            return base;
          })
          .strength((l: any) => {
            if (l.type === "call") return 0;
            if (this.viewMode === 0) {
              return Math.min(1.2, palette.force.linkStrength * Renderer.ACTIVE_LINK_STRENGTH_FACTOR);
            }
            return palette.force.linkStrength;
          })
          .iterations(2),
      )
      .d3Force(
        "charge",
        forceManyBody()
          .strength((n: any) => {
            const base =
              n.kind !== "folder"
                ? palette.force.charge
                : n.id === ""
                  ? palette.force.chargeRoot
                  : palette.force.chargeFolder;
            if (this.viewMode === 0) {
              return base * Renderer.ACTIVE_CHARGE_FACTOR;
            }
            return base;
          })
          .distanceMax(
            this.viewMode === 0
              ? Math.max(80, palette.force.chargeDistanceMax * Renderer.ACTIVE_CHARGE_DISTANCE_FACTOR)
              : palette.force.chargeDistanceMax,
          ),
      )
      .d3Force(
        "collide",
        forceCollide()
          .radius((n: any) =>
            Math.max(
              1,
              (nodeRadius(n.kind) +
                palette.force.collidePadding +
                (n.kind === "folder" ? palette.force.collideFolderExtra : 0)) *
                (this.viewMode === 0 ? Renderer.ACTIVE_COLLIDE_FACTOR : 1),
            ),
          )
          .strength(palette.force.collideStrength)
          .iterations(palette.force.collideIterations),
      )
      .d3Force("region-repel", this.createRegionRepelForce())
      .d3VelocityDecay(palette.force.velocityDecay)
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, scale: number) => this.drawNode(node, ctx, scale))
      .nodePointerAreaPaint((node: any, color: string, ctx: CanvasRenderingContext2D) =>
        this.drawHitArea(node, color, ctx),
      )
      .onNodeHover((node: any) => {
        if (node && node.x != null && node.y != null) {
          const screen = this.graph.graph2ScreenCoords(node.x, node.y);
          this.onHoverCallback?.(node.id, screen.x, screen.y);
        } else {
          this.onHoverCallback?.(null);
        }
      })
      .onNodeClick((node: any, event: MouseEvent) =>
        window.dispatchEvent(new CustomEvent("eisen:selectNode", { detail: { id: node.id, metaKey: event.metaKey } })),
      )
      .onBackgroundClick((event: MouseEvent) =>
        window.dispatchEvent(new CustomEvent("eisen:selectNode", { detail: { id: null, metaKey: event.metaKey } })),
      )
      .onRenderFramePre((ctx: CanvasRenderingContext2D, scale: number) => {
        this.drawRegionBacks(ctx, scale);
        this.drawCallEdges(ctx, scale);
      })
      .onRenderFramePost((ctx: CanvasRenderingContext2D, scale: number) => {
        this.drawRegionLabelsOverlay(ctx, scale);
      });
  }

  private createRegionRepelForce(): {
    (alpha: number): void;
    initialize(nodes: SimNode[]): void;
  } {
    let simNodes: SimNode[] = [];
    const force = ((alpha: number) => {
      if (simNodes.length === 0 || alpha <= 0) return;
      const bubbles = this.buildRegionBubbles(simNodes);
      if (bubbles.length < 2) return;

      for (let i = 0; i < bubbles.length; i++) {
        const a = bubbles[i];
        for (let j = i + 1; j < bubbles.length; j++) {
          const b = bubbles[j];
          const dx = b.cx - a.cx;
          const dy = b.cy - a.cy;
          const dist = Math.hypot(dx, dy) || 1e-6;
          const minDist = a.radius + b.radius + 14;
          if (dist >= minDist) continue;

          const overlap = minDist - dist;
          const push = Math.min(1.1, overlap * 0.05) * alpha;
          if (push <= 0) continue;

          const nx = dx / dist;
          const ny = dy / dist;
          const totalMass = a.mass + b.mass;
          const pushA = push * (b.mass / totalMass);
          const pushB = push * (a.mass / totalMass);

          this.applyVelocityShift(a.members, -nx * pushA, -ny * pushA);
          this.applyVelocityShift(b.members, nx * pushB, ny * pushB);

          a.cx -= nx * pushA;
          a.cy -= ny * pushA;
          b.cx += nx * pushB;
          b.cy += ny * pushB;
        }
      }
    }) as { (alpha: number): void; initialize(nodes: SimNode[]): void };

    force.initialize = (nodes: SimNode[]) => {
      simNodes = nodes;
    };

    return force;
  }

  private buildRegionBubbles(nodes: SimNode[]): RegionBubble[] {
    const byKey = new Map<string, SimNode[]>();
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      const key = this.regionKeyForDisplay(n.id);
      if (!key) continue;
      const regionNodes = byKey.get(key) ?? [];
      regionNodes.push(n);
      byKey.set(key, regionNodes);
    }

    const out: RegionBubble[] = [];
    for (const members of byKey.values()) {
      if (members.length < 2) continue;

      let cx = 0;
      let cy = 0;
      let totalWeight = 0;
      for (const n of members) {
        const w = REGION_MASS[n.kind];
        cx += n.x! * w;
        cy += n.y! * w;
        totalWeight += w;
      }
      if (totalWeight <= 0) continue;
      cx /= totalWeight;
      cy /= totalWeight;

      let radius = 0;
      for (const n of members) {
        const d = Math.hypot(n.x! - cx, n.y! - cy) + nodeRadius(n.kind);
        if (d > radius) radius = d;
      }

      out.push({
        members,
        cx,
        cy,
        radius: radius + 6,
        mass: Math.max(1, totalWeight),
      });
    }

    return out;
  }

  private applyVelocityShift(nodes: SimNode[], vx: number, vy: number): void {
    for (const n of nodes) {
      n.vx = (n.vx ?? 0) + vx;
      n.vy = (n.vy ?? 0) + vy;
    }
  }

  private drawRegionBacks(ctx: CanvasRenderingContext2D, scale: number): void {
    const targets = this.computeRegionTargets(scale);
    this.updateRegionLayers(targets);
    this.updateHoveredRegionFromPointer();
    this.regionLabelDraws = [];

    const layers = [...this.regionLayers.entries()]
      .map(([key, layer]) => ({ key, layer, area: polygonArea(layer.points) }))
      .sort((a, b) => b.area - a.area || a.key.localeCompare(b.key));

    for (const { key, layer } of layers) {
      if (layer.points.length < 3) continue;

      const alpha = this.hoveredRegionKey === key ? 0.15 : 1;
      if (alpha <= 0.01) continue;

      const style = this.regionStyle(key, alpha);

      ctx.beginPath();
      ctx.moveTo(layer.points[0].x, layer.points[0].y);
      for (let i = 1; i < layer.points.length; i++) ctx.lineTo(layer.points[i].x, layer.points[i].y);
      ctx.closePath();
      ctx.fillStyle = style.fill;
      ctx.fill();
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = 1 / scale;
      ctx.stroke();

      this.regionLabelDraws.push({
        points: layer.points,
        alpha,
        label: this.shouldShowRegionLabel(key) ? this.regionLabel(key) : "",
      });
    }
  }

  private drawRegionLabelsOverlay(ctx: CanvasRenderingContext2D, scale: number): void {
    for (const item of this.regionLabelDraws) {
      paintRegionLabel(ctx, {
        points: item.points,
        scale,
        alpha: item.alpha,
        label: item.label,
        lineHeight: palette.label.lineHeight,
        labelBg: palette.label.bg,
        labelFg: palette.label.fg,
      });
    }
  }

  private regionStyle(key: string, alpha: number): { fill: string; stroke: string } {
    const isSelected = this.selectedRegionKeys.has(key);
    const isReferenced = !isSelected && this.referencedRegionKeys.has(key);
    const modeAlpha = this.viewMode === 1 && !this.activeRegionKeys.has(key) ? 0.15 : 1;
    const fillAlpha = 0.14 * alpha * modeAlpha;
    const strokeAlpha = 0.24 * alpha * modeAlpha;

    if (isSelected) {
      return {
        fill: getFolderBgSelected(key, fillAlpha),
        stroke: getFolderStrokeSelected(key, strokeAlpha),
      };
    }
    if (isReferenced) {
      return {
        fill: getFolderBgReferenced(key, fillAlpha),
        stroke: getFolderStrokeReferenced(key, strokeAlpha),
      };
    }

    return {
      fill: getFolderBg(key, fillAlpha),
      stroke: getFolderStroke(key, strokeAlpha),
    };
  }

  private collectRegionKeys(ids: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      const key = this.regionKeyForDisplay(id);
      if (key) out.add(key);
    }
    return out;
  }

  private regionKeyForDisplay(id: string): string | null {
    const depthLimit = this.regionDepthMode ?? this.maxRegionDepth;
    if (depthLimit <= 0) return null;

    const key = getRegionKey(id);
    if (!key) return null;

    const parts = key.split("/").filter(Boolean);
    if (parts.length <= depthLimit) return key;
    return parts.slice(0, depthLimit).join("/");
  }

  private syncRegionDepthFromFolders(folders: Set<string>): void {
    let max = 0;
    for (const folder of folders) {
      const depth = folder ? folder.split("/").filter(Boolean).length : 0;
      if (depth > max) max = depth;
    }
    this.maxRegionDepth = max;
    this.regionDepthMode = this.regionDepthMode == null ? max : Math.max(0, Math.min(this.regionDepthMode, max));
  }

  private shouldShowRegionLabel(key: string): boolean {
    if (!this.selectedId) return true;
    if (this.depsMode) return true;
    return this.selectedRegionKeys.has(key) || this.referencedRegionKeys.has(key);
  }

  private regionLabel(key: string): string {
    if (!key) return "/";
    const parts = key.split("/").filter(Boolean);
    if (parts.length === 0) return "/";
    return `${parts[parts.length - 1]}/`;
  }

  private computeRegionTargets(scale: number): Map<string, Point[]> {
    const byKey = new Map<string, RegionInputPoint[]>();
    for (const n of this.nodes) {
      if (n.x == null || n.y == null) continue;
      if (!this.isNodeVisible(n.id)) continue;

      const key = this.regionKeyForDisplay(n.id);
      if (!key) continue;

      const point = this.projectRegionPoint(n);
      const points = byKey.get(key) ?? [];
      points.push({ x: point.x, y: point.y, kind: n.kind });
      byKey.set(key, points);
    }

    const regionKeys = [...byKey.keys()];
    const clampedScale = Math.max(0.85, Math.min(1.35, scale));
    const padding = 24 / clampedScale;
    const spread = Math.max(8 / clampedScale, padding * 0.22);
    const targets = new Map<string, Point[]>();

    for (const key of regionKeys) {
      const points = byKey.get(key);
      if (!points || points.length === 0) continue;

      const hullInput = this.expandPointsForArea(points, spread);
      const hull = convexHull(hullInput);
      if (hull.length < 3) continue;

      const expanded = expandPolygon(hull, padding);
      targets.set(key, resamplePolygon(expanded, 18));
    }

    return targets;
  }

  private projectRegionPoint(node: GraphNode): Point {
    if (node.kind === "folder" || node.kind === "file") {
      return { x: node.x!, y: node.y! };
    }

    const parent = this.nodeMap.get(deriveParent(node.id));
    if (parent?.x == null || parent?.y == null) {
      return { x: node.x!, y: node.y! };
    }

    const t = 0.38;
    return {
      x: node.x! + (parent.x - node.x!) * t,
      y: node.y! + (parent.y - node.y!) * t,
    };
  }

  private updateRegionLayers(targets: Map<string, Point[]>): void {
    for (const [key, target] of targets) {
      const layer = this.regionLayers.get(key);
      if (!layer) {
        this.regionLayers.set(key, { points: target.map((p) => ({ x: p.x, y: p.y })) });
      } else {
        layer.points = target.map((p) => ({ x: p.x, y: p.y }));
      }
    }

    for (const key of this.regionLayers.keys()) {
      if (targets.has(key)) continue;
      this.regionLayers.delete(key);
      if (this.hoveredRegionKey === key) this.hoveredRegionKey = null;
    }
  }

  private expandPointsForArea(points: RegionInputPoint[], spread: number): Point[] {
    const out: Point[] = [];
    for (const p of points) {
      const s = spread * REGION_SPREAD_BY_KIND[p.kind];
      out.push({ x: p.x, y: p.y });
      out.push({ x: p.x + s, y: p.y });
      out.push({ x: p.x - s, y: p.y });
      out.push({ x: p.x, y: p.y + s });
      out.push({ x: p.x, y: p.y - s });
    }
    return out;
  }

  private drawAgentRings(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    agentHeat: Record<string, number>,
    scale: number,
  ): void {
    const entries = Object.entries(agentHeat)
      .filter(([, h]) => h > 0)
      .sort((a, b) => a[0].localeCompare(b[0])); // stable order

    if (entries.length === 0) return;

    const totalHeat = entries.reduce((sum, [, h]) => sum + h, 0);
    if (totalHeat === 0) return;

    ctx.save(); // preserve parent globalAlpha and stroke state

    const ringRadius = radius + palette.agent.ringOffset;
    const totalGap = entries.length > 1 ? entries.length * palette.agent.ringGap : 0;
    const availableAngle = Math.PI * 2 - totalGap;
    let angle = -Math.PI / 2; // start at top

    for (const [displayName, heat] of entries) {
      const agent = this.agents.find((a) => a.displayName === displayName);
      if (!agent) continue;

      const sweep = (heat / totalHeat) * availableAngle;
      if (sweep <= 0) continue;

      // Dim if filtering and this agent isn't visible
      const isVisible = !this.agentFilterActive || this.visibleAgents.has(displayName);
      const ringAlpha = isVisible ? 1.0 : 0.15;

      ctx.beginPath();
      ctx.arc(x, y, ringRadius, angle, angle + sweep);
      ctx.strokeStyle = agent.color;
      ctx.globalAlpha = ringAlpha;
      ctx.lineWidth = palette.agent.ringWidth / scale;
      ctx.stroke();

      angle += sweep + (entries.length > 1 ? palette.agent.ringGap : 0);
    }

    ctx.restore(); // restore parent globalAlpha
  }

  zoomToNode(id: string): void {
    const node = this.nodeMap.get(id);
    if (node?.x != null && node?.y != null) {
      this.graph.centerAt(node.x, node.y, 400);
      this.graph.zoom(1.5, 400);
    }
  }

  zoomToFit(): void {
    this.graph.zoomToFit(palette.zoom.fitDuration, palette.zoom.fitPadding);
  }

  getGraph(): Graph {
    return this.graph;
  }

  getNodeScreenPosition(id: string): { x: number; y: number } | null {
    const node = this.nodeMap.get(id);
    if (!node || node.x == null || node.y == null) return null;
    return this.graph.graph2ScreenCoords(node.x, node.y);
  }

  private drawNode(node: GraphNode, ctx: CanvasRenderingContext2D, scale: number): void {
    const { id, kind, name, inContext } = node;
    if (!this.isNodeVisible(id)) return;

    const x = node.x!;
    const y = node.y!;
    const r = nodeRadius(kind);
    const isSelected = this.selectedIds.has(id);
    const isCaller = this.callerIds.has(id);
    const isListed = node.lastAction === "search";
    const isWritten = node.lastAction === "write";
    const alpha = this.nodeAlpha(id);

    ctx.save();
    ctx.globalAlpha = alpha;

    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = getNodeColor(id, kind);
    ctx.fill();

    if (kind !== "folder") {
      const overlay = isWritten
        ? palette.node.writeOverlay
        : inContext && !isListed
          ? palette.node.inContextOverlay
          : null;
      if (overlay) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        ctx.fillStyle = overlay;
        ctx.fill();
      }
    }

    ctx.strokeStyle = isSelected
      ? palette.node.selectedStroke
      : isCaller
        ? palette.node.callerStroke
        : isWritten
          ? palette.node.writeStroke
          : isListed
            ? palette.node.stroke
            : getNodeStroke(inContext);
    ctx.lineWidth = (isSelected ? palette.node.selectedStrokeWidth : palette.node.strokeWidth) / scale;
    ctx.stroke();

    // Draw agent attribution rings AFTER the node stroke so they aren't obscured
    if (node.agentHeat && Object.keys(node.agentHeat).length > 0 && this.agents.length > 0) {
      this.drawAgentRings(ctx, x, y, r, node.agentHeat, scale);
    }

    ctx.restore();
  }

  private drawHitArea(node: GraphNode, color: string, ctx: CanvasRenderingContext2D): void {
    if (!this.isNodeVisible(node.id)) return;
    const r = nodeRadius(node.kind);
    ctx.beginPath();
    ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  }

  private drawCallEdges(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this.callEdges.length === 0) return;
    ctx.lineWidth = palette.link.callWidth / scale;

    for (const { from, to } of this.callEdges) {
      if (this.viewMode === 0 && (!this.isNodeVisible(from) || !this.isNodeVisible(to))) continue;
      const a = this.nodeMap.get(from);
      const b = this.nodeMap.get(to);
      if (a?.x == null || a?.y == null || b?.x == null || b?.y == null) continue;

      const alpha = this.viewMode === 1 && !(this.isNodeActive(from) || this.isNodeActive(to)) ? 0.12 : 1;
      ctx.strokeStyle = this.colorWithAlpha(palette.link.callColor, alpha);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  private expandSelection(id: string, allIds: Iterable<string>): Set<string> {
    const out = new Set<string>([id]);
    const depth = id.split("::").length - 1;
    if (depth <= 1) {
      const prefix = `${id}::`;
      for (const other of allIds) {
        if (other.startsWith(prefix)) out.add(other);
      }
    }
    return out;
  }

  /** Check if a node has any activity from a visible agent */
  private isNodeVisibleToAgentFilter(node: {
    agentHeat?: Record<string, number>;
    agentContext?: Record<string, boolean>;
  }): boolean {
    if (!this.agentFilterActive) return true;
    // If the node has per-agent data, check if any visible agent has heat or context
    if (node.agentHeat) {
      for (const [name, heat] of Object.entries(node.agentHeat)) {
        if (heat > 0 && this.visibleAgents.has(name)) return true;
      }
    }
    if (node.agentContext) {
      for (const [name, ctx] of Object.entries(node.agentContext)) {
        if (ctx && this.visibleAgents.has(name)) return true;
      }
    }
    // If the node has no per-agent data at all (baseline), it's visible to all
    if (!node.agentHeat && !node.agentContext) return true;
    return false;
  }

  private computeDepsVisible(state: State): Set<string> {
    const ids = new Set<string>();

    for (const id of this.selectedIds) ids.add(id);
    for (const id of this.callerIds) ids.add(id);

    for (const id of [...ids]) {
      for (const ex of this.expandSelection(id, state.nodes.keys())) ids.add(ex);
    }

    for (const id of [...ids]) {
      let parent = deriveParent(id);
      while (parent !== id) {
        ids.add(parent);
        if (parent === "") break;
        const next = deriveParent(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    ids.add("");

    return ids;
  }

  private computeActiveNodeIds(state: State, folders: Set<string>): Set<string> {
    const allIds = [...state.nodes.keys()];
    const activeSeeds = allIds.filter((id) => {
      const node = state.nodes.get(id);
      if (!node) return false;
      if (!(node.inContext || node.changed || node.lastAction === "search")) return false;
      return this.isNodeVisibleToAgentFilter(node);
    });

    const out = new Set<string>();

    const addAncestors = (id: string) => {
      let parent = deriveParent(id);
      while (parent !== id) {
        if (parent === "") {
          out.add("");
          break;
        }
        if (state.nodes.has(parent) || folders.has(parent)) out.add(parent);
        const next = deriveParent(parent);
        if (next === parent) break;
        parent = next;
      }
    };

    for (const seed of activeSeeds) {
      const seedNode = state.nodes.get(seed);
      const seedKind = getNodeDisplayInfo(seed, seedNode?.kind).kind;

      if (seedNode?.lastAction === "search" && seedKind === "folder") {
        const prefix = `${seed}/`;
        for (const id of allIds) {
          if (id === seed || id.startsWith(prefix)) {
            if (!id.includes("::")) {
              out.add(id);
              addAncestors(id);
            }
          }
        }
      } else if (seedNode?.lastAction === "search") {
        out.add(seed);
        addAncestors(seed);
      } else {
        for (const id of this.expandSelection(seed, allIds)) {
          out.add(id);
          addAncestors(id);
        }
      }

      out.add("");
    }

    return out;
  }

  render(state: State, selectedId?: string | null, selectedIds?: Set<string>): void {
    this.selectedId = selectedId ?? null;
    this.agents = state.agents;
    this.visibleAgents = state.visibleAgents;
    this.agentFilterActive = state.agentFilterActive;
    const folders = this.collectFolders(state);
    this.syncRegionDepthFromFolders(folders);
    this.activeNodeIds = this.computeActiveNodeIds(state, folders);
    this.activeRegionKeys = this.collectRegionKeys(this.activeNodeIds);

    if (selectedIds && selectedIds.size > 0) {
      this.selectedIds = new Set(selectedIds);
      for (const id of selectedIds) {
        for (const expanded of this.expandSelection(id, state.nodes.keys())) {
          this.selectedIds.add(expanded);
        }
      }
    } else {
      this.selectedIds = this.selectedId ? this.expandSelection(this.selectedId, state.nodes.keys()) : new Set();
    }
    this.callerIds = new Set(
      this.selectedIds.size > 0 ? state.calls.filter((c) => this.selectedIds.has(c.to)).map((c) => c.from) : [],
    );
    this.selectedRegionKeys = this.collectRegionKeys(this.selectedIds);
    this.referencedRegionKeys = this.collectRegionKeys(this.callerIds);
    for (const key of this.selectedRegionKeys) this.referencedRegionKeys.delete(key);

    const structureChanged = this.syncNodes(state, folders);
    if (structureChanged) this.rebuildLinks();

    if (this.depsMode && this.selectedIds.size > 0) {
      this.depsVisibleIds = this.computeDepsVisible(state);
      this.callEdges = state.calls
        .filter((c) => this.selectedIds.has(c.to) && this.nodeMap.has(c.from) && this.nodeMap.has(c.to))
        .map((c) => ({ from: c.from, to: c.to }));
    } else {
      this.depsVisibleIds.clear();
      this.callEdges =
        this.selectedIds.size > 0
          ? state.calls
              .filter((c) => this.selectedIds.has(c.to) && this.nodeMap.has(c.from) && this.nodeMap.has(c.to))
              .map((c) => ({ from: c.from, to: c.to }))
          : [];
    }

    const viewData = this.buildViewData();

    const viewChanged = this.viewSignature !== viewData.signature;
    const modeChanged = this.lastAppliedViewMode !== this.viewMode;
    const depsChanged =
      viewChanged &&
      (this.depsMode || viewData.signature.startsWith("deps:") !== this.viewSignature.startsWith("deps:"));

    if (structureChanged || viewChanged) {
      this.viewSignature = viewData.signature;
      this.lastAppliedViewMode = this.viewMode;

      const isFirst = !this.initialized;
      const doUpdate = () => {
        this.pendingGraphUpdate = null;
        this.graph.graphData({ nodes: viewData.nodes, links: viewData.links });
        if (isFirst) {
          this.initialized = true;
          setTimeout(
            () => this.graph.zoomToFit(palette.zoom.fitDuration, palette.zoom.fitPadding),
            palette.zoom.fitDelay,
          );
        }
      };

      if (isFirst || modeChanged || depsChanged) {
        if (this.pendingGraphUpdate) clearTimeout(this.pendingGraphUpdate);
        doUpdate();
        if ((modeChanged || depsChanged) && !isFirst) {
          this.graph.d3ReheatSimulation();
          setTimeout(() => this.graph.zoomToFit(Math.min(280, palette.zoom.fitDuration), palette.zoom.fitPadding), 40);
        }
      } else {
        if (this.pendingGraphUpdate) clearTimeout(this.pendingGraphUpdate);
        this.pendingGraphUpdate = setTimeout(doUpdate, 300);
      }
    }
  }

  private collectFolders(state: State): Set<string> {
    const folders = new Set<string>([""]);
    for (const id of state.nodes.keys()) {
      const pathPart = id.includes("::") ? id.slice(0, id.indexOf("::")) : id;
      let dir = pathPart.split("/").slice(0, -1).join("/");
      while (dir !== "") {
        if (folders.has(dir)) break;
        folders.add(dir);
        dir = dir.split("/").slice(0, -1).join("/");
      }
    }
    return folders;
  }

  private syncNodes(state: State, folders: Set<string>): boolean {
    let changed = false;

    for (const [id, node] of state.nodes) {
      const { label, kind } = getNodeDisplayInfo(id, node.kind);
      const name = formatLabelWithLines(label, node.lines);
      const fileId = id.includes("::") ? id.slice(0, id.indexOf("::")) : id;
      const fileNode = fileId === id ? node : state.nodes.get(fileId);
      const inContext = node.inContext ?? fileNode?.inContext;
      const lastAction = node.lastAction ?? fileNode?.lastAction;
      let gn = this.nodeMap.get(id);

      if (!gn) {
        gn = {
          id,
          name,
          kind,
          inContext,
          lastAction,
          agentHeat: node.agentHeat,
          agentContext: node.agentContext,
          tokens: node.tokens,
        };
        this.nodes.push(gn);
        this.nodeMap.set(id, gn);
        changed = true;
      } else {
        Object.assign(gn, {
          name,
          kind,
          inContext,
          lastAction,
          agentHeat: node.agentHeat,
          agentContext: node.agentContext,
          tokens: node.tokens,
        });
      }
    }

    for (const fid of folders) {
      if (this.nodeMap.has(fid)) continue;
      const { label } = getNodeDisplayInfo(fid, "folder");
      const gn: GraphNode = { id: fid, name: label, kind: "folder" };
      this.nodes.push(gn);
      this.nodeMap.set(fid, gn);
      changed = true;
    }

    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (!state.nodes.has(n.id) && !folders.has(n.id)) {
        this.nodeMap.delete(n.id);
        this.nodes.splice(i, 1);
        changed = true;
      }
    }

    return changed;
  }

  private rebuildLinks(): void {
    this.links = [];
    for (const node of this.nodes) {
      const parent = deriveParent(node.id);
      if (parent !== node.id && this.nodeMap.has(parent)) {
        this.links.push({ source: parent, target: node.id, type: "structure" });
      }
    }
  }
}
