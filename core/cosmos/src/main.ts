import { AgentLayer } from "./agents";
import { CosmosGraph } from "./cosmos";
import { Selection } from "./selection";
import { applyDelta, applySnapshot, computeActiveView, createState } from "./state";
import type { Delta, DeltaResult, Snapshot } from "./state";
import { ChatPanel } from "./ui/ChatPanel";
import { Controls } from "./ui/Controls";
import { InfoPanel } from "./ui/InfoPanel";
import { applyTheme } from "./ui/tokens";
import { mountTweakpane } from "./tweaks";
import { Zones } from "./zones";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

class EisenCosmos {
  private state = createState();
  private graph: CosmosGraph;
  private agents: AgentLayer;
  private selection: Selection;
  private zones: Zones;
  private infoPanel: InfoPanel;
  private chatPanel: ChatPanel;
  private controls: Controls;
  private needsRebuild = false;
  private pendingTopologyChange = false;
  private focusedId: string | null = null;

  constructor(container: HTMLDivElement) {
    applyTheme("dark");

    this.infoPanel = new InfoPanel();

    this.graph = new CosmosGraph(container, {
      onClick: (index) => this.handleClick(index),
      onHover: (id) => { if (!this.focusedId) this.showInfo(id); },
      onSimulationEnd: () => {},
    });

    this.selection = new Selection(container, this.graph, (indices) => {
      const last = indices.size > 0 ? [...indices].pop()! : undefined;
      this.showInfo(last !== undefined ? this.graph.data.idOf(last) ?? null : null);
    });

    this.zones = new Zones(container, this.graph);
    this.agents = new AgentLayer(this.graph);

    this.controls = new Controls({
      onDepthChange: (depth) => this.zones.setDepth(depth),
      onFitView: () => this.graph.fitView(),
      onViewModeChange: (mode) => {
        const prev = this.state.viewMode;
        this.state.viewMode = mode;
        const structureChanged = (prev === 0) !== (mode === 0);
        if (structureChanged) {
          this.applyView(true);
        } else {
          this.applyFilter();
        }
      },
    });

    this.chatPanel = new ChatPanel({
      onAgentToggle: (name) => {
        this.toggleAgent(name);
        this.applyFilter();
        this.chatPanel.apply(this.state);
      },
      onAddAgent: (agentType) => {
        if (vscode) vscode.postMessage({ type: "addAgent", agentType });
      },
      onSend: (text, agent) => {
        this.chatPanel.addMessage({ from: "user", text });
        if (vscode) vscode.postMessage({ type: "chatMessage", text, agent });
      },
    });

    mountTweakpane(this.graph);

    window.addEventListener("message", (e) => this.onMessage(e.data));

    if (vscode) {
      vscode.postMessage({ type: "requestSnapshot" });
    }
  }

  private onMessage(msg: { method: string; params: any }): void {
    if (!msg || !msg.method) return;

    switch (msg.method) {
      case "snapshot":
        this.onSnapshot(msg.params as Snapshot);
        break;
      case "delta":
        this.onDelta(msg.params as Delta);
        break;
      case "agentUpdate":
        if (Array.isArray(msg.params?.agents)) {
          this.state.agents = msg.params.agents;
          this.chatPanel.apply(this.state);
        }
        break;
      case "availableAgents":
        if (Array.isArray(msg.params)) this.chatPanel.setAvailableAgents(msg.params);
        break;
      case "chatMessage":
        if (msg.params) this.chatPanel.addMessage(msg.params);
        break;
    }
  }

  private onSnapshot(snapshot: Snapshot): void {
    applySnapshot(this.state, snapshot);
    this.applyView(false);
  }

  private onDelta(delta: Delta): void {
    const { topologyChanged } = applyDelta(this.state, delta);
    if (topologyChanged) this.pendingTopologyChange = true;

    if (!this.needsRebuild) {
      this.needsRebuild = true;
      requestAnimationFrame(() => {
        this.needsRebuild = false;
        const topology = this.pendingTopologyChange;
        this.pendingTopologyChange = false;

        if (topology) {
          this.applyView(true);
        } else {
          this.applyMetaOnly();
        }
      });
    }
  }

  private applyMetaOnly(): void {
    const view = computeActiveView(this.state);
    if (!this.graph.data.matchesNodeSet(view)) {
      this.applyView(true);
      return;
    }
    this.graph.applyMetaUpdate(view);
    this.agents.apply(view, false);
    this.chatPanel.apply(this.state);
  }

  private applyView(preservePositions: boolean): void {
    const view = computeActiveView(this.state);
    this.graph.applyState(view, preservePositions, preservePositions ? 0.3 : undefined);
    this.agents.apply(view, true);
    this.chatPanel.apply(this.state);
    if (preservePositions) {
      setTimeout(() => this.graph.fitView(), 50);
    }
  }

  private applyFilter(): void {
    const view = computeActiveView(this.state);
    this.agents.apply(view, false);
  }

  private toggleAgent(name: string): void {
    const s = this.state;
    if (!s.agentFilterActive) {
      s.agentFilterActive = true;
      s.visibleAgents.clear();
      for (const a of s.agents) s.visibleAgents.add(a.displayName);
      s.visibleAgents.delete(name);
    } else {
      if (s.visibleAgents.has(name)) s.visibleAgents.delete(name);
      else s.visibleAgents.add(name);
      if (s.visibleAgents.size === s.agents.length) {
        s.agentFilterActive = false;
        s.visibleAgents.clear();
      }
    }
  }

  private handleClick(index: number | undefined): void {
    this.selection.handleClick(index);

    if (index !== undefined) {
      const id = this.graph.data.idOf(index) ?? null;
      this.focusedId = id;
      this.graph.zoomToNode(index);
      this.showInfo(id);
    } else {
      this.focusedId = null;
      this.showInfo(null);
    }
  }

  private showInfo(id: string | null): void {
    if (!id) { this.infoPanel.update(null, null); return; }
    const meta = this.graph.data.getMeta(id);
    this.infoPanel.update(id, meta ?? null);
  }
}

new EisenCosmos(document.getElementById("graph") as HTMLDivElement);
