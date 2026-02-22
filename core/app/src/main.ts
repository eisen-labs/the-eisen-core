import { Chat } from "../../ui/src/components/chat";
import { Inspect } from "../../ui/src/components/inspect";
import { Preview } from "../../ui/src/components/preview";
import { Toolbar } from "../../ui/src/components/toolbar";
import { TopBar } from "../../ui/src/components/top-bar";
import { el } from "../../ui/src/dom";
import {
  type SelectionContext,
  applySelection,
  handleFileContent,
  hideTooltip,
  showTooltip,
} from "../../ui/src/graph-ui";
import { Renderer } from "../../ui/src/render";
import { Selection, type SelectionMode } from "../../ui/src/selection";
import { applyDelta, applySnapshot, createState, type Delta, type Node, type Snapshot, type State } from "../../ui/src/state";
import type { AvailableAgent, SessionMeta } from "../../ui/src/types";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { ipc, getLaunchCwd } from "./ipc";
import { addRecent, getRecent } from "./store";
import { Welcome } from "./welcome";
import "./app.css";

class Eisen {
  private state: State = createState();
  private renderer!: Renderer;
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();
  private baselineNodes: Record<string, Node> = {};
  private baselineCalls: Array<{ from: string; to: string }> = [];

  private topBar!: TopBar;
  private chat!: Chat;
  private selection!: Selection;
  private root: HTMLElement;
  private left!: HTMLElement;
  private right!: HTMLElement;
  private ctx!: SelectionContext;
  private leftWidth = 240;
  private rightWidth = 280;
  private agents: AvailableAgent[] = [];
  private cwd = "";
  private pendingLine: number | null = null;
  private pendingHighlight: { start: number; end: number } | null = null;
  private ac: AbortController | null = null;

  constructor() {
    document.documentElement.setAttribute("data-theme", "dark");
    this.root = document.getElementById("app")!;

    document.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "t") {
        const cur = document.documentElement.getAttribute("data-theme");
        const next = cur === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        if (this.renderer) {
          this.renderer.setTheme(next);
          this.renderGraph();
        }
        if (this.ctx?.preview) this.ctx.preview.setTheme(next === "dark");
      }
    });

    this.boot();
  }

  private async boot() {
    try {
      const cwd = await getLaunchCwd();
      cwd ? this.openWorkspace(cwd) : this.showWelcome();
    } catch {
      this.showWelcome();
    }
  }

  private showWelcome() {
    this.root.innerHTML = "";
    this.root.append(new Welcome({ onOpen: (p) => this.openWorkspace(p) }).el);
  }

  private showError(err: unknown) {
    this.root.innerHTML = "";
    const box = el("div", { className: "error-screen" });
    const label = el("pre", { className: "error-label" }, err instanceof Error ? err.message : String(err));
    const retry = el("button", { type: "button", className: "welcome-btn glass" }, "Retry");
    retry.addEventListener("click", () => location.reload());
    box.append(label, retry);
    this.root.append(box);
  }

  private goHome() {
    this.chat.close();
    this.showWelcome();
  }

  private async openWorkspace(cwd: string) {
    this.cwd = cwd.endsWith("/") ? cwd : cwd + "/";
    addRecent(cwd);
    this.root.innerHTML = "";

    try {
      this.build();
      this.resetToNewChat();

      invoke<string>("scan_workspace", { cwd })
        .then((json) => {
          const snap = JSON.parse(json) as Snapshot & { nodes: Record<string, Node> };
          this.baselineNodes = snap.nodes;
          this.baselineCalls = snap.calls ?? [];
          applySnapshot(this.state, snap);
          this.renderGraph();
        })
        .catch(() => {});

      await ipc.init(cwd, (msg) => this.handleMessage(msg));
    } catch (e) {
      this.showError(e);
    }
  }

  private build() {
    if (this.ac) this.ac.abort();
    if (this.graphTimer) { clearTimeout(this.graphTimer); this.graphTimer = null; }
    this.ac = new AbortController();
    const { signal } = this.ac;

    const left = el("div", { className: "panel panel-left" });
    const leftHandle = el("div", { className: "resize-handle resize-left" });
    leftHandle.addEventListener("mousedown", (e) => this.startResize(e, "left"));
    left.append(leftHandle);
    this.left = left;

    const right = el("div", { className: "right-col" });
    const rightHandle = el("div", { className: "resize-handle resize-right" });
    rightHandle.addEventListener("mousedown", (e) => this.startResize(e, "right"));
    right.append(rightHandle);
    this.right = right;

    this.updateLayout();

    this.topBar = new TopBar({
      onSelect: (id) => { this.chat.selectAgent(id); ipc.send({ type: "switchInstance", instanceKey: id }); },
      onAdd: () => { this.topBar.showPending("New chat"); this.chat.clearAgent(); this.chat.showAgentPicker(); },
      onClose: (id) => ipc.send({ type: "closeInstance", instanceKey: id }),
      onLogo: () => this.goHome(),
    });

    this.chat = new Chat({
      onSend: (text, id, chips) => this.handleSend(text, id, chips),
      onAddAgent: () => {},
      onModeChange: (id) => ipc.send({ type: "selectMode", modeId: id }),
      onModelChange: (id) => ipc.send({ type: "selectModel", modelId: id }),
      onFileSearch: (q) => ipc.send({ type: "fileSearch", query: q }),
      onPickerDismiss: () => this.topBar.cancelPending(),
    });

    const inspect = new Inspect();
    const preview = new Preview();
    preview.onSave = (path, content) => ipc.send({ type: "writeFile", path, content });

    left.append(this.chat.el);
    const inspectPanel = el("div", { className: "panel right-inspect" });
    inspectPanel.append(inspect.el);
    const previewPanel = el("div", { className: "panel right-preview" });
    previewPanel.append(preview.el);
    right.append(inspectPanel, previewPanel);

    const graphContainer = el("div", { id: "graph" });
    const header = el("div", { className: "header-bar" });
    header.append(this.topBar.el);

    const toolbar = new Toolbar({
      onView: () => { this.renderer.cycleViewMode(); this.renderGraph(); },
      onLayers: () => { this.renderer.cycleRegionDepthMode(); this.renderGraph(); },
      onFit: () => this.renderer.zoomToFit(),
      onMarquee: () => {
        const next: SelectionMode = this.selection.getMode() === "marquee" ? "lasso" : "marquee";
        this.selection.setMode(next);
      },
      onDeps: () => { this.renderer.toggleDepsMode(); this.selection.setEnabled(!this.renderer.getDepsMode()); this.renderGraph(); },
    });
    const toolbarWrap = el("div", { className: "toolbar-anchor" });
    toolbarWrap.append(toolbar.el);

    this.root.append(graphContainer, header, left, right, toolbarWrap);

    const tooltip = el("div", { className: "hover-tooltip" });
    const tooltipInspect = new Inspect();
    tooltip.append(tooltipInspect.el);
    this.root.append(tooltip);

    this.ctx = {
      state: this.state,
      inspect,
      preview,
      right: this.right,
      tooltip,
      tooltipInspect,
      sendReadFile: (filePath) => ipc.send({ type: "readFile", path: this.cwd + filePath }),
    };

    this.renderer = new Renderer(graphContainer, {
      onHover: (id, sx, sy) => {
        if (id && sx != null && sy != null) {
          showTooltip(this.ctx, id, sx, sy);
        } else {
          hideTooltip(this.ctx);
        }
      },
    });
    this.renderer.cycleViewMode();
    this.renderer.cycleViewMode();

    this.selection = new Selection(graphContainer, this.renderer.getGraph(), (ids) => {
      const result = applySelection(this.ctx, ids);
      this.selectedId = result.selectedId;
      this.selectedIds = result.selectedIds;
      this.pendingLine = result.pendingLine;
      this.pendingHighlight = result.pendingHighlight;
      this.renderGraph();
    });

    window.addEventListener("eisen:selectNode", ((e: CustomEvent<{ id: string | null; metaKey: boolean }>) => {
      const { id, metaKey } = e.detail;
      hideTooltip(this.ctx);
      this.selection.handleClick(id ?? undefined, this.renderer.getDepsMode() ? false : metaKey);
      if (id && !metaKey && !this.renderer.getDepsMode()) this.renderer.zoomToNode(id);
    }) as EventListener, { signal });

  }

  private updateLayout() {
    this.left.style.width = `${this.leftWidth}px`;
    this.right.style.width = `${this.rightWidth}px`;
  }

  private startResize(e: MouseEvent, side: "left" | "right") {
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

  private handleSend(text: string, instanceId: string | null, chips: any[]) {
    const contextChips = chips.length ? chips : undefined;

    // Resolve active instance: use the explicit one from the chat component,
    // or fall back to whatever the top bar has selected (covers the orchestration
    // "awaiting approval" state where the orchestrator tab is active but the
    // chat's internal activeId may be null).
    const resolvedId = instanceId ?? this.topBar.getSelected();

    if (resolvedId) {
      this.chat.addMessage({ from: "user", text, instanceId: resolvedId });
      ipc.send({ type: "sendMessage", text, instanceId: resolvedId, contextChips });
      return;
    }

    // No active session at all — spawn a new one.
    const pending = this.chat.getPendingAgent()
      ?? (this.agents.length ? { type: this.agents[0].id, mode: "single_agent" as const } : null);
    if (!pending) return;

    this.chat.addPendingMessage(text);
    ipc.send({ type: "spawnAndSend", agentType: pending.type, sessionMode: pending.mode, text, contextChips });
  }

  private graphTimer: ReturnType<typeof setTimeout> | null = null;

  private renderGraph() {
    this.renderer.render(this.state, this.selectedId, this.selectedIds);
  }

  private renderGraphDebounced() {
    if (this.graphTimer !== null) return;
    this.graphTimer = setTimeout(() => { this.graphTimer = null; this.renderGraph(); }, 200);
  }

  private resetToNewChat() {
    this.chat.clearAgent();
    this.chat.showAgentPicker();
    this.topBar.showPending("New chat");
  }

  private stripCwd(s: string): string {
    return this.cwd && s.includes(this.cwd) ? s.replaceAll(this.cwd, "") : s;
  }

  private msgInstanceId(msg: any): string | null {
    return msg.instanceId || this.topBar.getSelected();
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case "mergedSnapshot": {
        const snap = msg as unknown as Snapshot;
        const merged = { ...this.baselineNodes };
        if (snap.nodes) for (const [id, n] of Object.entries(snap.nodes)) merged[id] = { ...merged[id], ...n };
        applySnapshot(this.state, { seq: snap.seq, nodes: merged, calls: snap.calls?.length ? snap.calls : this.baselineCalls, agents: snap.agents });
        this.renderGraph();
        return;
      }
      case "mergedDelta":
        applyDelta(this.state, msg as unknown as Delta);
        this.renderGraphDebounced();
        return;
      case "agentUpdate":
        this.renderGraphDebounced();
        return;

      case "agents":
        if (Array.isArray(msg.agents)) {
          this.agents = (msg.agents as Array<AvailableAgent & { available?: boolean }>).filter((a) => a.available !== false);
          this.chat.setAgents(this.agents);
        }
        return;

      case "instanceList": {
        const list = msg.instances as Array<{ key: string; label: string; agentType: string; color: string; connected: boolean; isStreaming?: boolean }>;
        if (!Array.isArray(list)) return;
        this.topBar.apply(list.map((i) => ({ instanceId: i.key, displayName: i.label, agentType: i.agentType, color: i.color, connected: i.connected })));
        for (const i of list) if (i.isStreaming) this.topBar.setStreaming(i.key, true);
        if (!list.length) this.resetToNewChat();
        return;
      }
      case "instanceChanged": {
        const key = msg.instanceKey as string | null;
        if (!key) { this.resetToNewChat(); return; }
        this.chat.selectAgent(key);
        if (this.topBar.hasPending()) { this.topBar.select(key); }
        return;
      }
      case "sessionHistory": {
        const key = msg.instanceKey as string;
        if (key && Array.isArray(msg.messages)) {
          this.chat.setHistory(key, msg.messages as any);
        }
        return;
      }

      case "userMessage": return;
      case "streamStart": {
        const id = this.msgInstanceId(msg);
        if (id) {
          this.topBar.setStreaming(id, true);
          // Chat component keeps a single live stream buffer; only render
          // stream events for the currently selected tab to avoid cross-tab
          // stream clobbering when orchestrator subtasks run in parallel.
          if (id === this.topBar.getSelected()) this.chat.streamStart(id);
        }
        return;
      }
      case "streamChunk": {
        const id = this.msgInstanceId(msg);
        if (id && typeof msg.text === "string" && id === this.topBar.getSelected()) {
          this.chat.streamChunk(msg.text as string, id);
        }
        return;
      }
      case "streamEnd": {
        const id = this.msgInstanceId(msg);
        if (id) {
          this.topBar.setStreaming(id, false);
          if (id === this.topBar.getSelected()) this.chat.streamEnd(id);
        }
        return;
      }

      case "toolCallStart": {
        const id = this.msgInstanceId(msg);
        if (id === this.topBar.getSelected()) {
          this.chat.toolCallStart(this.stripCwd(msg.name ?? msg.title ?? ""), msg.toolCallId ?? "", id);
        }
        return;
      }
      case "toolCallComplete": {
        const rawPath = msg.rawInput?.path || msg.rawInput?.command || msg.rawInput?.description || "";
        const input = rawPath ? this.stripCwd(String(rawPath)) : null;
        const id = this.msgInstanceId(msg);
        if (id === this.topBar.getSelected()) {
          this.chat.toolCallComplete(
            msg.toolCallId ?? "",
            msg.title ? this.stripCwd(msg.title) : null,
            msg.status ?? "completed",
            input,
            id,
          );
        }
        return;
      }

      case "hostDied":
        this.showError(new Error("Host process exited unexpectedly. Restart the app."));
        return;
      case "error":
        this.chat.addMessage({ from: "agent", text: `Error: ${msg.text}` });
        return;
      case "sessionMetadata":
        this.chat.setMeta(msg as unknown as SessionMeta);
        return;
      case "fileSearchResults":
        if (msg.searchResults) this.chat.showFiles(msg.searchResults as any);
        return;
      case "fileContent":
        if (msg.path && typeof msg.content === "string") {
          handleFileContent(this.ctx.preview, msg.path as string, msg.content as string, (msg.languageId as string) ?? "plaintext", this.pendingLine, this.pendingHighlight);
          this.pendingLine = null;
          this.pendingHighlight = null;
        }
        return;
      case "fileSaved":
        return;
      case "availableCommands":
        if (msg.commands) this.chat.setCommands(msg.commands as any);
        return;
      case "chatMessage":
        if (msg.text) {
          const id = this.msgInstanceId(msg);
          this.chat.addMessage({ from: msg.from as string ?? "agent", text: msg.text as string, instanceId: id ?? undefined });
        }
        return;
      case "orchestrationError":
        this.chat.addMessage({ from: "agent", text: `Orchestration error: ${msg.message}` });
        return;
      case "state": {
        // Orchestration lifecycle states surfaced to the chat.
        const stateLabels: Record<string, string> = {
          cancelled: "Orchestration cancelled.",
          completed: "Orchestration completed.",
          done: "Orchestration finished.",
        };
        const label = stateLabels[msg.state as string];
        if (label) {
          const id = this.topBar.getSelected();
          this.chat.addMessage({ from: "agent", text: label, instanceId: id ?? undefined });
        }
        return;
      }
    }
  }
}

document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  open(a.href);
});

window.addEventListener("DOMContentLoaded", () => new Eisen());
