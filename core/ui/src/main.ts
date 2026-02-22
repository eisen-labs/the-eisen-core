import { Chat } from "./components/chat";
import { Inspect, type NodeMeta } from "./components/inspect";
import { Toolbar } from "./components/toolbar";
import { TopBar } from "./components/top-bar";
import { el } from "./dom";
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
import type { Transport } from "./transport";
import type { AvailableAgent, AvailableCommand, FileSearchResult, SessionMeta } from "./types";

class Eisen {
  private state: State;
  private renderer: Renderer;
  private transport: Transport;
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

  constructor(transport: Transport) {
    document.documentElement.setAttribute("data-theme", "dark");
    this.state = createState();
    this.transport = transport;

    const canvas = document.getElementById("graph") as HTMLElement;

    this.root = document.body;

    const header = el("div", { className: "header-bar" });

    // Left panel (chat)
    this.left = el("div", { className: "panel panel-left" });
    const leftHandle = el("div", { className: "resize-handle resize-left" });
    leftHandle.addEventListener("mousedown", (e) => this.startResize(e, "left"));
    this.left.append(leftHandle);

    // Right panel (inspect)
    this.right = el("div", { className: "panel panel-right" });
    const rightHandle = el("div", { className: "resize-handle resize-right" });
    rightHandle.addEventListener("mousedown", (e) => this.startResize(e, "right"));
    this.right.append(rightHandle);

    // Components
    this.topBar = new TopBar({
      onSelect: (id) => {
        this.chat.selectAgent(id);
        this.transport.send({ type: "switchAgent", instanceId: id });
      },
      onAdd: () => {
        this.chat.showAgentPicker();
      },
    });

    this.chat = new Chat({
      onSend: (text, instanceId, chips) => {
        if (text) this.chat.addMessage({ from: "user", text, instanceId: instanceId ?? undefined });
        this.transport.send({
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
      onAddAgent: (agentType, sessionMode) => {
        this.transport.send({ type: "addAgent", agentType, sessionMode });
      },
      onModeChange: (modeId) => {
        this.transport.send({ type: "selectMode", modeId });
      },
      onModelChange: (modelId) => {
        this.transport.send({ type: "selectModel", modelId });
      },
      onFileSearch: (query) => {
        this.transport.send({ type: "fileSearch", query });
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

    header.append(this.topBar.el);
    this.left.append(this.chat.el);
    this.right.append(this.inspect.el);

    const toolbarWrap = el("div", { className: "toolbar-anchor" });
    toolbarWrap.append(toolbar.el);

    this.root.append(header, canvas, this.left, this.right, toolbarWrap);
    this.updateLayout();

    // Renderer + selection
    this.renderer = new Renderer(canvas, {
      onHover: (id) => {
        if (id) this.showInspect(id);
      },
    });

    this.selection = new Selection(canvas, this.renderer.getGraph(), (ids) => {
      this.applySelection(ids);
    });

    this.transport.send({ type: "requestSnapshot" });
    this.transport.listen((msg) => this.handleMessage(msg));
    this.bindEvents();
    this.bindKeyboard();
  }

  private updateLayout(): void {
    this.left.style.width = `${this.leftWidth}px`;
    this.right.style.width = `${this.rightWidth}px`;
  }

  private startResize(e: MouseEvent, side: "left" | "right"): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? this.leftWidth : this.rightWidth;
    let raf = 0;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ew-resize";
    const move = (ev: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const d = ev.clientX - startX;
        if (side === "left") this.leftWidth = Math.max(240, Math.min(600, startW + d));
        else this.rightWidth = Math.max(200, Math.min(600, startW - d));
        this.updateLayout();
        this.chat.repositionDropdowns();
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  private bindEvents(): void {
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

  destroy(): void {
    this.chat.destroy();
    this.selection.destroy();
    this.renderer.destroy();
  }
}

const transport = ((globalThis as Record<string, unknown>).__eisenTransport as Transport) ?? null;
if (transport) {
  new Eisen(transport);
} else {
  document.documentElement.setAttribute("data-theme", "dark");
  document.body.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100%;background:var(--bg-primary,#0a0a0a)">' +
    '<svg width="153" height="90" viewBox="0 0 306 180" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M153 111.737L59.5283 180L95.5 69.5L112.206 81.6987L97.4355 127.55L136.088 99.3217L153 111.737Z" fill="white"/>' +
    '<path d="M306 0.0322266L211.064 70.083L246.472 180L0 0L306 0.0322266ZM208.564 127.55L187.619 62.5273L245.219 20.0254L61.3057 20.0059L208.564 127.55Z" fill="white"/>' +
    "</svg></div>";
}
