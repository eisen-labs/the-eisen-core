import type { CosmosGraph } from "./cosmos";
import { convexHull, expandPolygon, type Point, polygonArea, polygonCentroid } from "./region-geometry";
import { palette } from "./theme";

function hashKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface FolderStyle { f: number; s: number; label: string }

function computeStyle(key: string): FolderStyle {
  const depth = key ? key.split("/").filter(Boolean).length : 0;
  const amount = Math.min(0.05 + depth * 0.03, 0.2) + (hashKey(key || "root") % 6) * 0.012;
  const bri = (a: number) => Math.min(255, (20 + (255 - 20) * a) | 0);
  const parts = key.split("/").filter(Boolean);
  return { f: bri(amount), s: bri(amount + 0.16), label: parts[parts.length - 1] ?? "/" };
}

const WARMUP_TICKS = 3;
const PAD = 28;
const CAM_EPS = 0.5;

export class Zones {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private graph: CosmosGraph;
  private raf = 0;
  private observer: ResizeObserver;

  private keys: string[] = [];
  private nodeCount = -1;
  private styles = new Map<string, FolderStyle>();
  private sbuf = new Float64Array(0);
  private ready = false;
  private enabled = true;
  private depth = 99;
  private camOx = 0; private camOy = 0; private camSx = 0;

  private groups = new Map<string, number[]>();
  private hotNodes = new Set<number>();
  private hotGroups: number[][] = [];

  constructor(container: HTMLElement, graph: CosmosGraph) {
    this.graph = graph;
    this.canvas = document.createElement("canvas");
    const s = this.canvas.style;
    s.position = "absolute"; s.top = s.left = "0";
    s.width = s.height = "100%"; s.pointerEvents = "none";
    container.style.position = "relative";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();

    graph.onTick((tick) => {
      if (tick <= WARMUP_TICKS) return;
      this.ready = true;
      if (this.needsPaint()) this.paint();
    });
    this.startFrameLoop();
  }

  setDepth(d: number): void {
    this.depth = d;
    this.enabled = d > 0;
    this.nodeCount = -1;
    this.styles.clear();
    if (this.ready) this.paint();
  }

  addHotNodes(indices: ReadonlySet<number>): void {
    const ids = this.graph.data.allIds();
    const prefixes: string[] = [];
    for (const i of indices) {
      if (ids[i] === undefined || ids[i] === "") continue;
      this.hotNodes.add(i);
      prefixes.push(ids[i]);
    }
    for (let i = 0; i < ids.length; i++) {
      if (this.hotNodes.has(i)) continue;
      const id = ids[i];
      for (const p of prefixes) {
        if (id.startsWith(p + "/") || id.startsWith(p + "::")) { this.hotNodes.add(i); break; }
      }
    }
    this.recomputeHotGroups();
    if (this.ready) this.paint();
  }

  clearHotNodes(): void {
    this.hotNodes.clear();
    this.hotGroups = [];
    if (this.ready) this.paint();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.canvas.remove();
  }

  private needsPaint(): boolean { return this.enabled || this.hotGroups.length > 0; }

  private startFrameLoop(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => this.frameLoop());
  }

  private recomputeHotGroups(): void {
    if (this.hotNodes.size === 0) { this.hotGroups = []; return; }
    const adj = new Map<number, number[]>();
    for (const i of this.hotNodes) adj.set(i, []);
    const links = this.graph.data.links;
    for (let i = 0; i < links.length; i += 2) {
      const a = links[i], b = links[i + 1];
      if (adj.has(a) && adj.has(b)) { adj.get(a)!.push(b); adj.get(b)!.push(a); }
    }
    const visited = new Set<number>();
    this.hotGroups = [];
    for (const node of this.hotNodes) {
      if (visited.has(node)) continue;
      const comp: number[] = [];
      const stack = [node];
      visited.add(node);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        comp.push(cur);
        for (const nb of adj.get(cur)!) {
          if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
        }
      }
      this.hotGroups.push(comp);
    }
  }

  private resize(): void {
    const el = this.canvas.parentElement!;
    const dpr = devicePixelRatio || 1;
    this.canvas.width = el.clientWidth * dpr;
    this.canvas.height = el.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private frameLoop(): void {
    this.raf = 0;
    if (this.ready && this.needsPaint() && this.cameraChanged()) this.paint();
    this.startFrameLoop();
  }

  private cameraChanged(): boolean {
    const [ox, oy] = this.graph.gl.spaceToScreenPosition([0, 0]);
    const [ax] = this.graph.gl.spaceToScreenPosition([1, 0]);
    const sx = ax - ox;
    if (Math.abs(ox - this.camOx) > CAM_EPS || Math.abs(oy - this.camOy) > CAM_EPS || Math.abs(sx - this.camSx) > CAM_EPS) {
      this.camOx = ox; this.camOy = oy; this.camSx = sx;
      return true;
    }
    return false;
  }

  private ensureKeys(): void {
    const ids = this.graph.data.allIds();
    if (ids.length === this.nodeCount) return;
    this.nodeCount = ids.length;
    this.keys = new Array(ids.length);
    this.styles.clear();
    const d = this.depth;
    for (let i = 0; i < ids.length; i++) {
      const full = this.graph.data.folderKeyOf(ids[i]);
      if (!full || d >= 99) { this.keys[i] = full; continue; }
      const parts = full.split("/");
      this.keys[i] = parts.length <= d ? full : parts.slice(0, d).join("/");
    }
    if (this.sbuf.length < ids.length * 2) this.sbuf = new Float64Array(ids.length * 2);
  }

  private style(key: string): FolderStyle {
    let s = this.styles.get(key);
    if (!s) { s = computeStyle(key); this.styles.set(key, s); }
    return s;
  }

  private paint(): void {
    const { ctx, canvas, graph: { gl } } = this;
    const dpr = devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    let pos: number[];
    try { pos = gl.getPointPositions(); } catch { return; }
    if (!pos || pos.length === 0) return;

    this.ensureKeys();
    const n = this.nodeCount;
    const [ox, oy] = gl.spaceToScreenPosition([0, 0]);
    const [dx, dy] = gl.spaceToScreenPosition([1, 1]);
    const sx = dx - ox, sy = dy - oy;
    this.camOx = ox; this.camOy = oy; this.camSx = sx;

    const sbuf = this.sbuf;
    for (let i = 0; i < n; i++) {
      sbuf[i * 2]     = ox + pos[i * 2]     * sx;
      sbuf[i * 2 + 1] = oy + pos[i * 2 + 1] * sy;
    }

    const pts: Point[] = [];
    if (this.enabled) this.paintFolderZones(ctx, sbuf, n, pts);
    if (this.hotGroups.length > 0) this.paintHotzones(ctx, sbuf, pts);
  }

  private drawHull(ctx: CanvasRenderingContext2D, pts: Point[]): void {
    const hull = convexHull(pts);
    if (hull.length < 3) return;
    const poly = expandPolygon(hull, PAD);
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }

  private paintFolderZones(ctx: CanvasRenderingContext2D, sbuf: Float64Array, n: number, pts: Point[]): void {
    const groups = this.groups;
    for (const arr of groups.values()) arr.length = 0;
    for (let i = 0; i < n; i++) {
      const key = this.keys[i];
      if (!key) continue;
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(sbuf[i * 2], sbuf[i * 2 + 1]);
    }

    // Collect hulls sorted by area (largest first)
    const hulls: { key: string; poly: Point[] }[] = [];
    for (const [key, coords] of groups) {
      const c = coords.length >> 1;
      if (c < 2) continue;
      pts.length = c;
      for (let i = 0; i < c; i++) pts[i] = { x: coords[i * 2], y: coords[i * 2 + 1] };
      const hull = convexHull(pts);
      if (hull.length < 3) continue;
      hulls.push({ key, poly: expandPolygon(hull, PAD) });
    }
    hulls.sort((a, b) => polygonArea(b.poly) - polygonArea(a.poly));

    ctx.font = "500 11px sans-serif";
    for (const { key, poly: p } of hulls) {
      const { f, s, label } = this.style(key);
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
      ctx.closePath();
      ctx.fillStyle = `rgba(${f},${f},${f},0.1)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${s},${s},${s},0.2)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      const c = polygonCentroid(p);
      const tw = ctx.measureText(label).width;
      const bw = tw + 6, bh = 21;
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.rect(c.x - bw / 2, c.y - bh / 2, bw, bh);
      ctx.fillStyle = "rgba(30,30,30,0.5)";
      ctx.fill();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(label, c.x, c.y);
      ctx.restore();
    }
  }

  private paintHotzones(ctx: CanvasRenderingContext2D, sbuf: Float64Array, pts: Point[]): void {
    ctx.fillStyle = palette.hotzoneFill;
    ctx.strokeStyle = palette.hotzoneStroke;
    ctx.lineWidth = 1.5;
    for (const group of this.hotGroups) {
      if (group.length < 3) {
        for (const idx of group) {
          const cx = sbuf[idx * 2], cy = sbuf[idx * 2 + 1];
          ctx.beginPath();
          ctx.moveTo(cx, cy - PAD); ctx.lineTo(cx + PAD, cy);
          ctx.lineTo(cx, cy + PAD); ctx.lineTo(cx - PAD, cy);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        }
        continue;
      }
      pts.length = group.length;
      for (let i = 0; i < group.length; i++) {
        const idx = group[i];
        pts[i] = { x: sbuf[idx * 2], y: sbuf[idx * 2 + 1] };
      }
      this.drawHull(ctx, pts);
    }
  }
}
