import { Chat } from "./ui/components/chat";
import { Inspect, type NodeMeta } from "./ui/components/inspect";
import { Toolbar } from "./ui/components/toolbar";
import { TopBar } from "./ui/components/top-bar";
import { Welcome } from "./ui/components/welcome";
// biome-ignore lint/correctness/noUnusedImports: JSX runtime
import { h } from "./ui/jsx-runtime";
import { ICON } from "./ui/panels/icons";
import { Renderer } from "./ui/render";
import { Selection, type SelectionMode } from "./ui/selection";
import {
  type AgentInfo,
  applyDelta,
  applySnapshot,
  createState,
  type Delta,
  type Node,
  type Snapshot,
  type State,
} from "./ui/state";
import type { AvailableAgent, AvailableCommand, FileSearchResult, SessionMeta } from "./ui/types";
import { ipc, getLaunchCwd, type HostMessage } from "./ipc";
import { AppStore } from "./store";
import "./ui/style.css";

class Eisen {
  private state: State;
  private renderer!: Renderer;
  private selectedId: string | null = null;
  private selectedIds = new Set<string>();

  private topBar!: TopBar;
  private chat!: Chat;
  private inspect!: Inspect;
  private selection!: Selection;

  private root: HTMLElement;
  private header!: HTMLElement;
  private left!: HTMLElement;
  private right!: HTMLElement;
  private canvas!: HTMLElement;
  private toolbarWrap!: HTMLElement;
  private welcome!: Welcome;

  private leftWidth = 340;
  private rightWidth = 280;
  private panelsOpen = true;

  constructor() {
    console.log("[Eisen] Initializing...");
    document.documentElement.setAttribute("data-theme", "dark");
    this.state = createState();
    
    const rootEl = document.getElementById("app");
    if (!rootEl) throw new Error("Root #app not found");
    this.root = rootEl;
    this.root.style.width = "100%";
    this.root.style.height = "100%";

    this.init().catch(err => {
      console.error("[Eisen] Critical initialization error:", err);
      this.showError(err);
    });
  }

  private showError(err: any) {
    this.root.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    this.root.append((
      <div className="flex flex-col items-center justify-center w-full h-full bg-bg text-foreground p-8">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-6 max-w-lg">
          <h1 className="text-red-500 font-semibold mb-2">Failed to start Eisen</h1>
          <pre className="text-xs font-mono text-muted whitespace-pre-wrap">{msg}</pre>
          <button 
            type="button"
            className="mt-4 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm transition-colors"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </div>
    ) as HTMLElement);
  }

  private async init() {
    console.log("[Eisen] Checking launch CWD...");
    let launchCwd: string | null = null;
    try {
      launchCwd = await getLaunchCwd();
    } catch (e) {
      console.warn("[Eisen] getLaunchCwd failed:", e);
    }

    if (launchCwd) {
      console.log("[Eisen] Launching with CWD:", launchCwd);
      this.openWorkspace(launchCwd);
    } else {
      console.log("[Eisen] Showing welcome screen");
      this.showWelcome();
    }
  }

  private showWelcome() {
    this.root.innerHTML = "";
    this.root.style.display = "block"; // Standard layout for welcome
    
    try {
      this.welcome = new Welcome({
        onOpen: (path) => this.openWorkspace(path)
      });
      this.root.append(this.welcome.el);
    } catch (e) {
      this.showError(e);
    }
  }

  private async openWorkspace(cwd: string) {
    console.log("[Eisen] Opening workspace:", cwd);
    this.root.innerHTML = "";
    this.root.style.display = "grid"; // Grid layout for main UI
    this.updateGrid();

    try {
      // Persist to recent
      await AppStore.getInstance().addRecentWorkspace(cwd).catch(e => console.warn("[Eisen] Failed to save recent:", e));

      // Setup main UI
      this.canvas = document.createElement("div");
      this.canvas.id = "graph";
      this.canvas.className = "relative bg-bg overflow-hidden";

      this.header = (
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
      this.canvas.append(chevron);

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
          ipc.send({ type: "switchInstance", instanceKey: id });
        },
        onAdd: () => {
          this.topBar.showPending("New chat");
          this.chat.showAgentPicker();
        },
        onClose: (id) => {
          this.chat.removeAgent(id);
          ipc.send({ type: "closeInstance", instanceKey: id });
        },
      });

        this.chat = new Chat({
          onSend: (text, instanceId, chips) => {
            ipc.send({
              type: "sendMessage",
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
          ipc.send({ type: "spawnAgent", agentType, sessionMode });
        },
        onModeChange: (modeId) => {
          ipc.send({ type: "selectMode", modeId });
        },
        onModelChange: (modelId) => {
          ipc.send({ type: "selectModel", modelId });
        },
        onFileSearch: (query) => {
          ipc.send({ type: "fileSearch", query });
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

      // Assemble layout
      this.header.append(this.topBar.el);
      this.left.append(this.chat.el);
      this.chat.el.style.height = "100%";
      this.right.append(this.inspect.el);

      this.left.style.gridColumn = "1";
      this.canvas.style.gridColumn = "2";
      this.right.style.gridColumn = "3";

      this.toolbarWrap = (<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30" />) as HTMLElement;
      this.toolbarWrap.append(toolbar.el);

      this.root.append(this.header, this.left, this.canvas, this.right, this.toolbarWrap);

      // Renderer + selection
      this.renderer = new Renderer(this.canvas, {
        onHover: (id) => {
          if (id) this.showInspect(id);
        },
      });

      this.selection = new Selection(this.canvas, this.renderer.getGraph(), (ids) => {
        this.applySelection(ids);
      });

      this.bindEvents();
      this.bindKeyboard();

      // Start sidecar
      console.log("[Eisen] Spawning sidecar...");
      await ipc.init(cwd);
      ipc.onMessage((msg) => this.handleMessage(msg));
    } catch (e) {
      this.showError(e);
    }
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

  private bindEvents(): void {
    window.addEventListener("eisen:selectNode", ((e: CustomEvent<{ id: string | null; metaKey: boolean }>) => {
      const { id, metaKey } = e.detail;
      this.selection.handleClick(id ?? undefined, this.renderer.getDepsMode() ? false : metaKey);
      if (id && !metaKey && !this.renderer.getDepsMode()) this.renderer.zoomToNode(id);
    }) as EventListener);
  }

  private bindKeyboard(): void {
    document.addEventListener("keydown", (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "t") {
        const cur = document.documentElement.getAttribute("data-theme");
        document.documentElement.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
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
    // Do NOT call topBar.apply() here — the tab list is owned by instanceList
    // messages from the host. Graph snapshots/deltas have no agent data and
    // would overwrite state.agents with an empty array, clearing all tabs.
  }

  private handleMessage(msg: HostMessage): void {
    switch (msg.type) {
      case "mergedSnapshot": {
        const savedAgents = this.state.agents;
        applySnapshot(this.state, msg as unknown as Snapshot);
        // Snapshots from eisen-core carry no agent/tab data — preserve the
        // agent list that was set by the most recent instanceList message.
        this.state.agents = savedAgents;
        break;
      }
      case "mergedDelta": {
        const savedAgents = this.state.agents;
        applyDelta(this.state, msg as unknown as Delta);
        this.state.agents = savedAgents;
        break;
      }
      case "agentUpdate": {
        const p = msg as unknown as { agents?: AgentInfo[] };
        if (p?.agents) {
          this.state.agents = p.agents;
        }
        break;
      }
      case "agents":
        if (Array.isArray(msg.agents)) this.chat.setAgents(msg.agents as AvailableAgent[]);
        return;
      case "userMessage":
        this.chat.addMessage({ from: "user", text: msg.text as string });
        return;
      case "streamStart": {
        // Find the instanceId from the message if available
        const instanceId = (msg.instanceId as string) || this.topBar.getSelected();
        if (instanceId) {
          this.topBar.setStreaming(instanceId, true);
          this.chat.streamStart(instanceId);
        }
        return;
      }
      case "streamChunk": {
        const text = msg.text as string;
        const instanceId = (msg.instanceId as string) || this.topBar.getSelected();
        if (typeof text === "string" && instanceId) {
          this.chat.streamChunk(text, instanceId);
        }
        return;
      }
      case "streamEnd": {
        const instanceId = (msg.instanceId as string) || this.topBar.getSelected();
        if (instanceId) {
          this.topBar.setStreaming(instanceId, false);
          this.chat.streamEnd(instanceId);
        }
        return;
      }
      case "sessionMetadata": {
        const meta = msg as unknown as SessionMeta;
        if (meta) this.chat.setMeta(meta);
        return;
      }
      case "fileSearchResults": {
        const results = msg.searchResults as FileSearchResult[];
        if (results) this.chat.showFiles(results);
        return;
      }
      case "availableCommands": {
        const ac = msg.commands as AvailableCommand[];
        if (ac) this.chat.setCommands(ac);
        return;
      }
      case "instanceList": {
        const instances = msg.instances as any[];
        if (Array.isArray(instances)) {
          const agents: AgentInfo[] = instances.map((i) => ({
            instanceId: i.key,
            displayName: i.label,
            agentType: i.agentType,
            color: i.color,
            connected: i.connected,
          }));
          this.state.agents = agents;
          this.topBar.apply(agents);
          for (const i of instances) {
            this.topBar.setStreaming(i.key, !!i.isStreaming);
            this.chat.setConnected(i.key, !!i.connected);
          }
          const activeKey = msg.currentInstanceKey as string | null | undefined;
          const selectedKey = activeKey ?? this.topBar.getSelected();
          if (selectedKey && instances.some((i) => i.key === selectedKey)) {
            this.chat.selectAgent(selectedKey);
            this.topBar.select(selectedKey);
          }
        }
        return;
      }
      case "instanceChanged": {
        const key = msg.instanceKey as string | null;
        if (key) {
          this.chat.selectAgent(key);
          this.topBar.select(key);
        } else {
          this.chat.clearAgent();
        }
        return;
      }
      case "error": {
        const errText = msg.text as string;
        if (errText) this.chat.addError(errText);
        return;
      }
      case "agentError": {
        const errText = msg.text as string;
        if (errText) this.chat.addError(errText);
        return;
      }
      case "connectionState":
      case "streamingState":
        return;
      default:
        // Try to handle generic {method, params} if they come through
        if ("method" in msg && "params" in msg) {
          this.handleGenericMethod(msg.method as string, msg.params);
        }
        return;
    }
    this.rerender();
  }

  private handleGenericMethod(method: string, params: any) {
    // Ported from old handleMessage
    switch (method) {
      case "snapshot":
        applySnapshot(this.state, params as Snapshot);
        break;
      case "delta":
        applyDelta(this.state, params as Delta);
        break;
      case "chatMessage":
        this.chat.addMessage(params);
        break;
      case "streamStart":
        if (params?.instanceId) {
          this.topBar.setStreaming(params.instanceId, true);
          this.chat.streamStart(params.instanceId);
        }
        break;
      case "streamChunk":
        if (params?.text && params?.instanceId) this.chat.streamChunk(params.text, params.instanceId);
        break;
      case "streamEnd":
        if (params?.instanceId) {
          this.topBar.setStreaming(params.instanceId, false);
          this.chat.streamEnd(params.instanceId);
        }
        break;
    }
  }
}

// Wait for DOM
window.addEventListener("DOMContentLoaded", () => {
  new Eisen();
});
