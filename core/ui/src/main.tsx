import { Chat } from "./components/chat";
import { Inspect, type NodeMeta } from "./components/inspect";
import { Toolbar } from "./components/toolbar";
import { TopBar } from "./components/top-bar";
// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "./jsx-runtime";
import { ICON } from "./panels/icons";
import { Renderer } from "./render";
import { Selection, type SelectionMode } from "./selection";
import {
  type AgentInfo,
  applyDelta,
  applySnapshot,
  createState,
  type Delta,
  type Node,
  type Snapshot,
  type State,
} from "./state";
import type { AvailableAgent, AvailableCommand, FileSearchResult, SessionMeta } from "./types";

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
  private selectedIds = new Set<string>();

  private topBar: TopBar;
  private chat: Chat;
  private inspect: Inspect;
  private selection: Selection;

  private root: HTMLElement;
  private left: HTMLElement;
  private right: HTMLElement;
  private leftWidth = 340;
  private rightWidth = 280;
  private panelsOpen = true;

  constructor() {
    document.documentElement.setAttribute("data-theme", "dark");
    this.state = createState();

    // Use existing #graph div from the HTML template as canvas
    const canvas = document.getElementById("graph") as HTMLElement;
    canvas.className = "relative bg-bg overflow-hidden";

    this.root = document.body;
    this.root.style.cssText = "display:grid; width:100%; height:100%;";
    this.updateGrid();

    const header = (
      <div className="bg-surface border-b border-border" style={{ gridColumn: "1 / -1" }} />
    ) as HTMLElement;
    const PANEL = "relative bg-surface rounded-xl overflow-hidden flex flex-col border border-border";

    // Left panel (chat)
    this.left = (<div className={`${PANEL} m-2 mr-0`} />) as HTMLElement;
    const leftHandle = (
      <div className="absolute top-0 right-[-3px] w-[6px] h-full cursor-ew-resize z-10" />
    ) as HTMLElement;
    leftHandle.addEventListener("mousedown", (e) => this.startResize(e, "left"));
    this.left.append(leftHandle);

    // Chevron toggle
    const chevron = (
      <button
        type="button"
        className="absolute left-2 top-2 z-20 w-5 h-5 bg-transparent border-none flex items-center justify-center cursor-pointer text-muted hover:text-foreground rounded [&>svg]:w-3.5 [&>svg]:h-3.5"
        innerHTML={ICON.chevronLeft}
      />
    ) as HTMLButtonElement;
    chevron.addEventListener("click", () => {
      this.panelsOpen = !this.panelsOpen;
      this.left.style.display = this.panelsOpen ? "" : "none";
      this.right.style.display = this.panelsOpen ? "" : "none";
      chevron.innerHTML = this.panelsOpen ? ICON.chevronLeft : ICON.chevronRight;
      this.updateGrid();
    });
    canvas.append(chevron);

    // Right panel (inspect)
    this.right = (<div className={`${PANEL} m-2 ml-0`} />) as HTMLElement;
    const rightHandle = (
      <div className="absolute top-0 left-[-3px] w-[6px] h-full cursor-ew-resize z-10" />
    ) as HTMLElement;
    rightHandle.addEventListener("mousedown", (e) => this.startResize(e, "right"));
    this.right.append(rightHandle);

    // Components
    this.topBar = new TopBar({
      onSelect: (id) => {
        this.chat.selectAgent(id);
        this.vscode?.postMessage({ type: "switchAgent", instanceId: id });
      },
      onAdd: () => {
        this.topBar.showPending("New chat");
        this.chat.showAgentPicker();
      },
    });

    this.chat = new Chat({
      onSend: (text, instanceId, chips) => {
        if (text) this.chat.addMessage({ from: "user", text, instanceId: instanceId ?? undefined });
        this.vscode?.postMessage({
          type: "chatMessage",
          text,
          instanceId,
          contextChips:
            chips.length > 0
              ? chips.map((c) => ({
                  filePath: c.filePath,
                  fileName: c.fileName,
                  isDirectory: c.isDirectory,
                }))
              : undefined,
        });
      },
      onAddAgent: (agentType) => {
        this.vscode?.postMessage({ type: "addAgent", agentType });
      },
      onModeChange: (modeId) => {
        this.vscode?.postMessage({ type: "selectMode", modeId });
      },
      onModelChange: (modelId) => {
        this.vscode?.postMessage({ type: "selectModel", modelId });
      },
      onFileSearch: (query) => {
        this.vscode?.postMessage({ type: "fileSearch", query });
      },
    });

    this.inspect = new Inspect();

    const toolbar = new Toolbar({
      onView: () => {
        this.renderer.cycleViewMode();
        this.rerender();
      },
      onLayers: () => {
        this.renderer.cycleRegionDepthMode();
        this.rerender();
      },
      onFit: () => this.renderer.zoomToFit(),
      onMarquee: () => {
        const next: SelectionMode = this.selection.getMode() === "marquee" ? "lasso" : "marquee";
        this.selection.setMode(next);
      },
      onDeps: () => {
        this.renderer.toggleDepsMode();
        this.selection.setEnabled(!this.renderer.getDepsMode());
        this.rerender();
      },
    });

    // Assemble layout around existing #graph div
    header.append(this.topBar.el);
    this.left.append(this.chat.el);
    this.chat.el.style.height = "100%";
    this.right.append(this.inspect.el);

    this.left.style.gridColumn = "1";
    canvas.style.gridColumn = "2";
    this.right.style.gridColumn = "3";

    const toolbarWrap = (<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30" />) as HTMLElement;
    toolbarWrap.append(toolbar.el);

    // Insert header before canvas, then left before canvas, right after canvas
    this.root.insertBefore(header, canvas);
    this.root.insertBefore(this.left, canvas);
    canvas.after(this.right);
    this.root.append(toolbarWrap);

    // Renderer + selection
    this.renderer = new Renderer(canvas, {
      onHover: (id) => {
        if (id) this.showInspect(id);
      },
    });

    this.selection = new Selection(canvas, this.renderer.getGraph(), (ids) => {
      this.applySelection(ids);
    });

    this.initVscode();
    this.bindEvents();
    this.bindKeyboard();
  }

  private updateGrid(): void {
    this.root.style.gridTemplateRows = "auto 1fr";
    const l = this.panelsOpen ? `${this.leftWidth}px` : "0px";
    const r = this.panelsOpen ? `${this.rightWidth}px` : "0px";
    this.root.style.gridTemplateColumns = `${l} 1fr ${r}`;
  }

  private startResize(e: MouseEvent, side: "left" | "right"): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? this.leftWidth : this.rightWidth;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    const move = (ev: MouseEvent) => {
      const d = ev.clientX - startX;
      if (side === "left") this.leftWidth = Math.max(240, Math.min(600, startW + d));
      else this.rightWidth = Math.max(200, Math.min(600, startW - d));
      this.updateGrid();
    };
    const up = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  private initVscode(): void {
    try {
      this.vscode = acquireVsCodeApi();
      this.vscode.postMessage({ type: "requestSnapshot" });
    } catch {
      this.loadMockData();
    }
  }

  private bindEvents(): void {
    window.addEventListener("message", (e) => this.handleMessage(e.data));

    window.addEventListener("eisen:selectNode", ((e: CustomEvent<{ id: string | null; metaKey: boolean }>) => {
      const { id, metaKey } = e.detail;
      this.selection.handleClick(id ?? undefined, this.renderer.getDepsMode() ? false : metaKey);
      if (id && !metaKey && !this.renderer.getDepsMode()) this.renderer.zoomToNode(id);
    }) as EventListener);
  }

  private bindKeyboard(): void {
    const scales = [
      { xs: "9px", sm: "10px", md: "12px", lg: "14px" },
      { xs: "10px", sm: "11px", md: "13px", lg: "15px" },
      { xs: "11px", sm: "12px", md: "14px", lg: "16px" },
    ];
    let scaleIdx = 1;
    document.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "t") {
        const cur = document.documentElement.getAttribute("data-theme");
        document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
      }
      if (e.key === "s") {
        scaleIdx = (scaleIdx + 1) % scales.length;
        const s = scales[scaleIdx];
        const r = document.documentElement.style;
        r.setProperty("--fs-xs", s.xs);
        r.setProperty("--fs-sm", s.sm);
        r.setProperty("--fs-md", s.md);
        r.setProperty("--fs-lg", s.lg);
      }
    });
  }

  private applySelection(ids: Set<string>): void {
    this.selectedIds = new Set(ids);
    if (ids.size === 0) {
      this.selectedId = null;
      this.inspect.hide();
    } else {
      const last = [...ids].pop() as string;
      this.selectedId = last;
      this.showInspect(last);
    }
    this.rerender();
  }

  private showInspect(id: string): void {
    const node = this.state.nodes.get(id);
    const meta: NodeMeta = { kind: this.deriveKind(id, node) };

    if (node?.lines) meta.lines = `${node.lines.start}-${node.lines.end}`;
    if (node?.tokens) meta.tokens = String(node.tokens);
    if (node?.lastAction) meta.action = node.lastAction;

    const agentNames: string[] = [];
    if (node?.agentHeat) {
      for (const name of Object.keys(node.agentHeat)) agentNames.push(name);
    }
    if (agentNames.length) meta.agents = agentNames.join(", ");

    this.inspect.show(id, meta);
  }

  private deriveKind(id: string, node?: Node): string {
    if (node?.kind) return node.kind;
    if (!id.includes("::")) return id.includes(".") ? "file" : "folder";
    return id.split("::").length === 2 ? "class" : "method";
  }

  private rerender(): void {
    this.renderer.render(this.state, this.selectedId, this.selectedIds);
    this.topBar.apply(this.state.agents);
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
          if (this.state.agentFilterActive) {
            const names = new Set(p.agents.map((a) => a.displayName));
            for (const name of this.state.visibleAgents) {
              if (!names.has(name)) this.state.visibleAgents.delete(name);
            }
            if (this.state.visibleAgents.size === 0 && p.agents.length > 0) {
              this.state.agentFilterActive = false;
            }
          }
        }
        break;
      }
      case "availableAgents":
        if (Array.isArray(msg.params)) this.chat.setAgents(msg.params as AvailableAgent[]);
        return;
      case "chatMessage":
        if (msg.params) this.chat.addMessage(msg.params as { from: string; text: string; instanceId?: string });
        return;
      case "streamStart": {
        const sp = msg.params as { instanceId?: string } | undefined;
        if (sp?.instanceId) {
          this.topBar.setStreaming(sp.instanceId, true);
          this.chat.streamStart(sp.instanceId);
        }
        return;
      }
      case "streamChunk": {
        const sc = msg.params as { text?: string; instanceId?: string } | undefined;
        if (sc?.text && sc?.instanceId) this.chat.streamChunk(sc.text, sc.instanceId);
        return;
      }
      case "streamEnd": {
        const se = msg.params as { instanceId?: string } | undefined;
        if (se?.instanceId) {
          this.topBar.setStreaming(se.instanceId, false);
          this.chat.streamEnd(se.instanceId);
        }
        return;
      }
      case "sessionMetadata": {
        const meta = msg.params as SessionMeta | undefined;
        if (meta) this.chat.setMeta(meta);
        return;
      }
      case "fileSearchResults": {
        const results = msg.params as FileSearchResult[] | undefined;
        if (results) this.chat.showFiles(results);
        return;
      }
      case "availableCommands": {
        const ac = msg.params as { commands?: AvailableCommand[]; instanceId?: string } | undefined;
        if (ac?.commands) this.chat.setCommands(ac.commands);
        return;
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

new Eisen();
