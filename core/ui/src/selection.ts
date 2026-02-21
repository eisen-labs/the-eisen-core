import { type Point, pointInPolygon } from "./region-geometry";

export type SelectionMode = "marquee" | "lasso";

interface Graph {
  screen2GraphCoords: (x: number, y: number) => { x: number; y: number };
  graph2ScreenCoords: (x: number, y: number) => { x: number; y: number };
  graphData: () => { nodes?: Array<{ id: string; x?: number; y?: number }> } | undefined;
}

const LASSO_FILL = "rgba(96, 165, 250, 0.04)";
const LASSO_STROKE = "rgba(96, 165, 250, 0.35)";

export class Selection {
  private selected = new Set<string>();
  private marqueeEl: HTMLDivElement;
  private dragging = false;
  private startX = 0;
  private startY = 0;
  private mode: SelectionMode = "marquee";
  private lassoCanvas: HTMLCanvasElement;
  private lassoCtx: CanvasRenderingContext2D;
  private lassoing = false;
  private lassoPath: number[] = [];
  private enabled = true;

  constructor(
    private container: HTMLElement,
    private graph: Graph,
    private onChange?: (ids: Set<string>) => void,
  ) {
    this.marqueeEl = document.createElement("div");
    this.marqueeEl.className = "marquee";
    document.body.appendChild(this.marqueeEl);

    this.lassoCanvas = document.createElement("canvas");
    const s = this.lassoCanvas.style;
    s.position = "absolute";
    s.top = s.left = "0";
    s.width = s.height = "100%";
    s.pointerEvents = "none";
    container.appendChild(this.lassoCanvas);
    const ctx = this.lassoCanvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context");
    this.lassoCtx = ctx;

    container.addEventListener("mousedown", this.onMouseDown, true);
    container.addEventListener("mouseup", this.onMouseUp, true);
    container.addEventListener("click", this.onClickBlock, true);
    window.addEventListener("keydown", this.onShiftKey);
    window.addEventListener("keyup", this.onShiftKey);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mouseup", this.onMouseUpGlobal);
  }

  getSelected(): ReadonlySet<string> {
    return this.selected;
  }

  getMode(): SelectionMode {
    return this.mode;
  }

  setMode(mode: SelectionMode): void {
    this.mode = mode;
    if (this.lassoing) this.clearLasso();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.cancelMarquee();
      this.clearLasso();
      this.container.classList.remove("shift-active");
    }
  }

  clear(): void {
    this.selected.clear();
    this.onChange?.(this.selected);
  }

  handleClick(nodeId: string | undefined, metaKey: boolean): void {
    if (metaKey && nodeId !== undefined) {
      if (this.selected.has(nodeId)) this.selected.delete(nodeId);
      else this.selected.add(nodeId);
    } else if (nodeId !== undefined) {
      this.selected.clear();
      this.selected.add(nodeId);
    } else if (!metaKey) {
      this.selected.clear();
    }
    this.onChange?.(this.selected);
  }

  destroy(): void {
    this.container.removeEventListener("mousedown", this.onMouseDown, true);
    this.container.removeEventListener("mouseup", this.onMouseUp, true);
    this.container.removeEventListener("click", this.onClickBlock, true);
    window.removeEventListener("keydown", this.onShiftKey);
    window.removeEventListener("keyup", this.onShiftKey);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mouseup", this.onMouseUpGlobal);
    this.marqueeEl.remove();
    this.lassoCanvas.remove();
  }

  private onShiftKey = (e: KeyboardEvent): void => {
    if (e.key !== "Shift") return;
    if (!this.enabled) return;
    if (e.type === "keydown") {
      this.container.classList.add("shift-active");
    } else {
      this.container.classList.remove("shift-active");
    }
    if (e.type === "keyup" && this.dragging) this.cancelMarquee();
    if (e.type === "keyup" && this.lassoing) this.clearLasso();
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!e.shiftKey || !this.enabled) return;
    e.stopPropagation();
    e.preventDefault();
    if (this.mode === "lasso") {
      this.lassoing = true;
      this.lassoPath = [];
      this.sizeLassoCanvas();
      this.pushPoint(e);
    } else {
      this.dragging = true;
      this.startX = e.clientX;
      this.startY = e.clientY;
      this.marqueeEl.style.display = "block";
      this.setMarqueeRect(e.clientX, e.clientY);
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (this.lassoing) {
      e.stopPropagation();
      e.preventDefault();
      this.finishLasso(e.metaKey);
      return;
    }
    if (!this.dragging) return;
    e.stopPropagation();
    e.preventDefault();
    this.finishMarquee(e.clientX, e.clientY, e.metaKey);
  };

  private onClickBlock = (e: MouseEvent): void => {
    if (e.shiftKey) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.lassoing) {
      this.pushPoint(e);
      this.drawLasso();
      return;
    }
    if (this.dragging) this.setMarqueeRect(e.clientX, e.clientY);
  };

  private onMouseUpGlobal = (e: MouseEvent): void => {
    if (this.lassoing) {
      this.finishLasso(e.metaKey);
      return;
    }
    if (this.dragging) this.finishMarquee(e.clientX, e.clientY, e.metaKey);
  };

  // --- Lasso ---

  private pushPoint(e: MouseEvent): void {
    const r = this.container.getBoundingClientRect();
    this.lassoPath.push(e.clientX - r.left, e.clientY - r.top);
  }

  private drawLasso(): void {
    const { lassoPath: p, lassoCtx: ctx, lassoCanvas: c } = this;
    const dpr = devicePixelRatio || 1;
    ctx.clearRect(0, 0, c.width / dpr, c.height / dpr);
    if (p.length < 4) return;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
    ctx.fillStyle = LASSO_FILL;
    ctx.fill();
    ctx.strokeStyle = LASSO_STROKE;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private finishLasso(additive: boolean): void {
    this.lassoing = false;
    const p = this.lassoPath;
    if (p.length < 6) {
      this.clearLasso();
      if (!additive) {
        this.selected.clear();
        this.onChange?.(this.selected);
      }
      return;
    }

    const polygon: Point[] = [];
    for (let i = 0; i < p.length; i += 2) polygon.push({ x: p[i], y: p[i + 1] });

    if (!additive) this.selected.clear();

    const toGraph = this.graph.screen2GraphCoords;
    if (typeof toGraph !== "function") {
      this.clearLasso();
      return;
    }

    const r = this.container.getBoundingClientRect();
    const data = this.graph.graphData();
    if (data?.nodes) {
      for (const node of data.nodes) {
        if (node.x == null || node.y == null) continue;
        const screen = this.graph.graph2ScreenCoords(node.x, node.y);
        const sx = screen.x - r.left;
        const sy = screen.y - r.top;
        if (pointInPolygon(sx, sy, polygon)) {
          this.selected.add(node.id);
        }
      }
    }

    this.clearLasso();
    this.onChange?.(this.selected);
  }

  private sizeLassoCanvas(): void {
    const dpr = devicePixelRatio || 1;
    this.lassoCanvas.width = this.container.clientWidth * dpr;
    this.lassoCanvas.height = this.container.clientHeight * dpr;
    this.lassoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clearLasso(): void {
    this.lassoing = false;
    this.lassoPath = [];
    const dpr = devicePixelRatio || 1;
    this.lassoCtx.clearRect(0, 0, this.lassoCanvas.width / dpr, this.lassoCanvas.height / dpr);
  }

  // --- Marquee ---

  private finishMarquee(cx: number, cy: number, additive: boolean): void {
    this.dragging = false;
    this.marqueeEl.style.display = "none";

    const x1 = Math.min(this.startX, cx);
    const y1 = Math.min(this.startY, cy);
    const x2 = Math.max(this.startX, cx);
    const y2 = Math.max(this.startY, cy);

    if (x2 - x1 < 4 && y2 - y1 < 4) {
      if (!additive) {
        this.selected.clear();
        this.onChange?.(this.selected);
      }
      return;
    }

    const toGraph = this.graph.screen2GraphCoords;
    if (typeof toGraph !== "function") return;

    const tl = toGraph.call(this.graph, x1, y1);
    const br = toGraph.call(this.graph, x2, y2);
    const minX = Math.min(tl.x, br.x);
    const maxX = Math.max(tl.x, br.x);
    const minY = Math.min(tl.y, br.y);
    const maxY = Math.max(tl.y, br.y);

    if (!additive) this.selected.clear();

    const data = this.graph.graphData();
    if (data?.nodes) {
      for (const node of data.nodes) {
        if (node.x == null || node.y == null) continue;
        if (node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY) {
          this.selected.add(node.id);
        }
      }
    }

    this.onChange?.(this.selected);
  }

  private setMarqueeRect(cx: number, cy: number): void {
    const s = this.marqueeEl.style;
    s.left = `${Math.min(this.startX, cx)}px`;
    s.top = `${Math.min(this.startY, cy)}px`;
    s.width = `${Math.abs(cx - this.startX)}px`;
    s.height = `${Math.abs(cy - this.startY)}px`;
  }

  private cancelMarquee(): void {
    this.dragging = false;
    this.marqueeEl.style.display = "none";
  }
}
