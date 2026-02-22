import type { ViewMode } from "../state";

const LAYERS_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2L2 7l10 5 10-5z"/>
  <path d="M2 17l10 5 10-5"/>
  <path d="M2 12l10 5 10-5"/>
</svg>`;

const FIT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 3H5a2 2 0 00-2 2v3"/>
  <path d="M16 3h3a2 2 0 012 2v3"/>
  <path d="M8 21H5a2 2 0 01-2-2v-3"/>
  <path d="M16 21h3a2 2 0 002-2v-3"/>
</svg>`;

const VIEW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"/>
  <circle cx="12" cy="12" r="4"/>
</svg>`;

const DEPTH_CYCLE = [99, 1, 2, 3];

export class Controls {
  private el: HTMLElement;
  private depthIndex = 0;
  private depthBtn: HTMLButtonElement;
  private viewBtn: HTMLButtonElement;
  private viewMode: ViewMode = 0;

  constructor(opts: {
    onDepthChange: (depth: number) => void;
    onFitView: () => void;
    onViewModeChange: (mode: ViewMode) => void;
  }) {
    this.el = document.createElement("div");
    this.el.className = "graph-controls";

    this.viewBtn = this.makeButton(VIEW_SVG, "view");
    this.viewBtn.addEventListener("click", () => {
      this.viewMode = ((this.viewMode + 1) % 3) as ViewMode;
      opts.onViewModeChange(this.viewMode);
    });

    this.depthBtn = this.makeButton(LAYERS_SVG, "layers");
    this.depthBtn.addEventListener("click", () => {
      this.depthIndex = (this.depthIndex + 1) % DEPTH_CYCLE.length;
      opts.onDepthChange(DEPTH_CYCLE[this.depthIndex]);
    });

    const fitBtn = this.makeButton(FIT_SVG, "fit");
    fitBtn.addEventListener("click", () => opts.onFitView());

    this.el.append(this.viewBtn, this.depthBtn, fitBtn);
    document.body.appendChild(this.el);
  }

  private makeButton(svg: string, cls: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = `graph-control-btn graph-control-btn--${cls}`;
    btn.tabIndex = -1;
    btn.innerHTML = svg;
    return btn;
  }

  destroy(): void {
    this.el.remove();
  }
}
