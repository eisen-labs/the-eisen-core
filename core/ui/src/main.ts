import { Renderer } from "./render";
import { type AgentInfo, applyDelta, applySnapshot, createState, type Delta, type Snapshot, type State } from "./state";

declare const acquireVsCodeApi: () => {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

class Eisen {
  private state: State;
  private renderer: Renderer;
  private vscode: ReturnType<typeof acquireVsCodeApi> | null = null;
  private selectedId: string | null = null;

  constructor(container: HTMLElement) {
    this.state = createState();
    this.renderer = new Renderer(container);
    this.initVscode();
    this.bindEvents();
    this.mountControls();
  }

  private initVscode(): void {
    try {
      this.vscode = acquireVsCodeApi();
    } catch {
      this.loadMockData();
    }
  }

  private bindEvents(): void {
    window.addEventListener("message", (e) => this.handleMessage(e.data));

    window.addEventListener("eisen:openFile", ((e: CustomEvent) => {
      this.vscode?.postMessage({ type: "openFile", path: e.detail });
    }) as EventListener);

    window.addEventListener("eisen:selectNode", ((e: CustomEvent<string | null>) => {
      const id = e.detail;
      this.selectedId = id == null || this.selectedId === id ? null : id;
      if (this.selectedId !== null) {
        const path = id?.includes("::") ? id?.split("::")[0] : id!;
        const line = this.state.nodes.get(id!)?.lines?.start;
        this.vscode?.postMessage(line != null ? { type: "openFile", path, line } : { type: "openFile", path });
      }
      this.rerender();
    }) as EventListener);

    // Legend click handling — intercept canvas clicks before they reach the graph
    const container = document.getElementById("graph")!;
    container.addEventListener(
      "click",
      (e: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;
        const hit = this.renderer.handleLegendClick(canvasX, canvasY);
        if (hit === null) return; // click was outside legend, let graph handle it

        e.stopPropagation();
        const vis = this.state.visibleAgents;
        if (hit === "__show_all__") {
          // Reset — show all agents
          vis.clear();
          this.state.agentFilterActive = false;
        } else {
          // Ensure filter is active; if transitioning from show-all, seed with all agents on
          if (!this.state.agentFilterActive) {
            vis.clear();
            for (const a of this.state.agents) vis.add(a.displayName);
            this.state.agentFilterActive = true;
          }
          // Simple toggle: clicked agent flips on/off, others untouched
          if (vis.has(hit)) {
            vis.delete(hit);
          } else {
            vis.add(hit);
          }
        }
        this.rerender();
      },
      true,
    ); // capture phase so we intercept before force-graph
  }

  private rerender(): void {
    this.renderer.render(this.state, this.selectedId);
  }

  private mountControls(): void {
    const root = document.createElement("div");
    root.className = "eisen-controls";

    const funnelBtn = document.createElement("button");
    funnelBtn.type = "button";
    funnelBtn.className = "eisen-icon-button";
    funnelBtn.setAttribute("aria-label", "Cycle graph focus mode");
    funnelBtn.setAttribute("title", "Cycle focus mode");
    funnelBtn.innerHTML = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '<path d="M3 5h18l-7 8v6l-4-2v-4L3 5z"/>',
      "</svg>",
    ].join("");
    funnelBtn.addEventListener("click", () => {
      this.renderer.cycleViewMode();
      this.rerender();
    });

    const layersBtn = document.createElement("button");
    layersBtn.type = "button";
    layersBtn.className = "eisen-icon-button eisen-icon-button-layers";
    layersBtn.setAttribute("aria-label", "Cycle region depth mode");
    layersBtn.setAttribute("title", "Cycle region depth");
    layersBtn.innerHTML = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '<path d="m12.82 2.18 6.44 3.72a1 1 0 0 1 0 1.74l-6.44 3.72a2 2 0 0 1-2.02 0L4.36 7.64a1 1 0 0 1 0-1.74l6.44-3.72a2 2 0 0 1 2.02 0Z"/>',
      '<path d="m4.4 10.16 6.4 3.72a2 2 0 0 0 2.02 0l6.4-3.72"/>',
      '<path d="m4.4 14.16 6.4 3.72a2 2 0 0 0 2.02 0l6.4-3.72"/>',
      "</svg>",
    ].join("");
    layersBtn.addEventListener("click", () => {
      this.renderer.cycleRegionDepthMode();
      this.rerender();
    });

    root.append(funnelBtn, layersBtn);
    document.body.append(root);

    this.mountLegend();
  }

  private mountLegend(): void {
    const legend = document.createElement("div");
    legend.className = "eisen-legend";

    const header = document.createElement("div");
    header.className = "eisen-legend-header";

    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("viewBox", "0 0 10 10");
    chevron.setAttribute("class", "eisen-legend-chevron");
    chevron.innerHTML =
      '<path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

    const title = document.createElement("span");
    title.textContent = "Legend";

    header.append(chevron, title);
    header.addEventListener("click", () => {
      legend.classList.toggle("collapsed");
    });

    const body = document.createElement("div");
    body.className = "eisen-legend-body";

    const items: [string, string][] = [
      ["read", "Recently read"],
      ["write", "Edit"],
      ["faded", "Faded context"],
    ];

    for (const [cls, label] of items) {
      const row = document.createElement("div");
      row.className = "eisen-legend-item";

      const dot = document.createElement("div");
      dot.className = `eisen-legend-dot ${cls}`;

      const text = document.createElement("span");
      text.textContent = label;

      row.append(dot, text);
      body.append(row);
    }

    legend.append(header, body);
    document.body.append(legend);
  }

  private handleMessage(msg: { method?: string; params?: unknown }): void {
    if (!msg || typeof msg !== "object" || !msg.method) return;
    switch (msg.method) {
      case "init":
      case "snapshot":
        if (msg.params != null) applySnapshot(this.state, msg.params as Snapshot);
        break;
      case "delta":
        if (msg.params != null) applyDelta(this.state, msg.params as Delta);
        break;
      case "agentUpdate": {
        const p = msg.params as { agents?: AgentInfo[] } | undefined;
        if (p?.agents) {
          this.state.agents = p.agents;
          // Clean up removed agents from the visible set
          if (this.state.agentFilterActive) {
            const names = new Set(p.agents.map((a) => a.displayName));
            for (const name of this.state.visibleAgents) {
              if (!names.has(name)) this.state.visibleAgents.delete(name);
            }
            // If all visible agents were removed, deactivate filter
            if (this.state.visibleAgents.size === 0 && p.agents.length > 0) {
              this.state.agentFilterActive = false;
            }
          }
        }
        break;
      }
      default:
        return;
    }
    this.rerender();
  }

  private loadMockData(): void {
    applySnapshot(this.state, { seq: 0, nodes: {}, calls: [] });
    this.rerender();
  }
}

new Eisen(document.getElementById("graph")!);
