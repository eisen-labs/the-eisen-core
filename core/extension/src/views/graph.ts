import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import { getCorePath } from "../bridge";
import type {
  AgentInfo,
  MergedGraphDelta,
  MergedGraphSnapshot,
} from "../orchestrator";

type UiNodeKind = "file" | "class" | "method" | "function";

interface UiLineRange {
  start: number;
  end: number;
}

interface UiNode {
  kind?: UiNodeKind;
  lines?: UiLineRange;
  inContext?: boolean;
  changed?: boolean;
  lastWrite?: number;
  lastAction?: "read" | "write" | "search";
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
}

/**
 * GraphViewProvider renders the force-directed graph in a webview view.
 *
 * After the orchestrator refactor, this class no longer manages TCP
 * connections directly. It receives pre-merged data from the
 * EisenOrchestrator via setSnapshot() and applyDelta().
 */
export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "eisen.graphView";

  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private pendingMessages: Array<{ method: string; params: any }> = [];
  private baselineNodes: Record<string, UiNode> | null = null;
  private baselineCalls: Array<{ from: string; to: string }> = [];
  private baselineLoading: Promise<void> | null = null;
  private workspaceRoot: string | null = null;
  private baselineGeneration = 0;

  private liveNodes: Record<string, UiNode> = {};
  private agents: AgentInfo[] = [];

  /** Throttle delta postMessage to avoid saturating the webview IPC channel.
   *  Deltas are batched and flushed at most every DELTA_FLUSH_MS. */
  private static readonly DELTA_FLUSH_MS = 200; // ~5 Hz max
  private pendingDeltaUpdates: any[] = [];
  private pendingDeltaSeq = 0;
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // -----------------------------------------------------------------------
  // Public API — called by extension.ts wiring with orchestrator
  // -----------------------------------------------------------------------

  /**
   * Receive a full merged snapshot from the orchestrator.
   * Overlays onto baseline nodes and pushes to webview.
   */
  setSnapshot(snapshot: MergedGraphSnapshot): void {
    // Build the combined node map: baseline + live merged data
    const nodes: Record<string, UiNode> = this.baselineNodes
      ? { ...this.baselineNodes }
      : {};

    for (const [id, node] of Object.entries(snapshot.nodes)) {
      const normalizedId = this.normalizeNodeId(id);
      if (!normalizedId || this.shouldIgnorePath(normalizedId)) continue;
      nodes[normalizedId] = {
        ...nodes[normalizedId],
        inContext: node.inContext,
        changed: node.changed,
        lastAction: node.lastAction,
        lastWrite: node.changed ? Date.now() : nodes[normalizedId]?.lastWrite,
        agentHeat: node.agentHeat,
        agentContext: node.agentContext,
      };
    }

    this.liveNodes = nodes;
    this.agents = snapshot.agents;

    this.postToWebview({
      method: "snapshot",
      params: {
        seq: snapshot.seq,
        nodes,
        calls: snapshot.calls.length > 0 ? snapshot.calls : this.baselineCalls,
        agents: snapshot.agents,
      },
    });
  }

  /**
   * Apply a merged delta from the orchestrator.
   *
   * Deltas are batched internally and flushed to the webview at most every
   * DELTA_FLUSH_MS (200ms / ~5 Hz). This prevents saturating the webview
   * IPC channel when many agents are producing concurrent updates.
   */
  applyDelta(delta: MergedGraphDelta): void {
    for (const u of delta.updates) {
      const normalizedId = this.normalizeNodeId(u.id);
      if (!normalizedId || this.shouldIgnorePath(normalizedId)) continue;

      if (u.action === "remove") {
        delete this.liveNodes[normalizedId];
        this.pendingDeltaUpdates.push({ id: normalizedId, action: "remove" });
      } else {
        this.liveNodes[normalizedId] = {
          ...this.liveNodes[normalizedId],
          inContext: u.inContext,
          changed: u.changed,
          lastAction: u.action,
          agentHeat: u.agentHeat,
          agentContext: u.agentContext,
        };
        this.pendingDeltaUpdates.push({
          id: normalizedId,
          action: u.action,
          inContext: u.inContext,
          changed: u.changed,
          agentHeat: u.agentHeat,
          agentContext: u.agentContext,
        });
      }
    }

    this.agents = delta.agents;
    this.pendingDeltaSeq = delta.seq;

    // Schedule a flush if one isn't already pending
    if (!this.deltaFlushTimer && this.pendingDeltaUpdates.length > 0) {
      this.deltaFlushTimer = setTimeout(() => {
        this.flushDeltaBatch();
      }, GraphViewProvider.DELTA_FLUSH_MS);
    }
  }

  /** Flush batched delta updates to the webview. */
  private flushDeltaBatch(): void {
    this.deltaFlushTimer = null;
    if (this.pendingDeltaUpdates.length === 0) return;

    // Deduplicate: keep only the latest update per node id
    const latestById = new Map<string, any>();
    for (const update of this.pendingDeltaUpdates) {
      latestById.set(update.id, update);
    }

    this.postToWebview({
      method: "delta",
      params: {
        seq: this.pendingDeltaSeq,
        updates: Array.from(latestById.values()),
        agents: this.agents,
      },
    });

    this.pendingDeltaUpdates = [];
  }

  /**
   * Update the agent list (e.g. on connect/disconnect).
   */
  updateAgents(agents: AgentInfo[]): void {
    this.agents = agents;
    this.postToWebview({
      method: "agentUpdate",
      params: { agents },
    });
  }

  /**
   * Get baseline nodes for the orchestrator to include in merged snapshots.
   */
  getBaselineNodes(): Record<string, UiNode> | null {
    return this.baselineNodes;
  }

  /**
   * Get baseline calls for the orchestrator to include in merged snapshots.
   */
  getBaselineCalls(): Array<{ from: string; to: string }> {
    return this.baselineCalls;
  }

  // -----------------------------------------------------------------------
  // Webview lifecycle
  // -----------------------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    this.setupWebview(webviewView.webview);
    this.flushPendingMessages();
    void this.ensureBaselineSnapshot();

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  openGraphPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "eisen.graphPanel",
      "Eisen Graph",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.setupWebview(this.panel.webview);
    this.flushPendingMessages();
    void this.ensureBaselineSnapshot();

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private setupWebview(webview: vscode.Webview): void {
    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webview.html = this.getHtml(webview);
    webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });
  }

  private hasWebviewTarget(): boolean {
    return !!this.view || !!this.panel;
  }

  private sendToTargets(msg: { method: string; params: any }): void {
    this.view?.webview.postMessage(msg);
    this.panel?.webview.postMessage(msg);
  }

  private flushPendingMessages(): void {
    if (!this.hasWebviewTarget() || this.pendingMessages.length === 0) return;
    const queued = this.pendingMessages;
    this.pendingMessages = [];
    for (const msg of queued) this.sendToTargets(msg);
  }

  // -----------------------------------------------------------------------
  // Baseline symbol snapshot (workspace structure)
  // -----------------------------------------------------------------------

  private async ensureBaselineSnapshot(): Promise<void> {
    if (this.baselineNodes) {
      this.postToWebview({
        method: "snapshot",
        params: {
          seq: 0,
          nodes: { ...this.baselineNodes, ...this.liveNodes },
          calls: this.baselineCalls,
          agents: this.agents,
        },
      });
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.baselineNodes = {};
      this.baselineCalls = [];
      return;
    }

    this.workspaceRoot = root;
    this.postToWebview({
      method: "snapshot",
      params: { seq: 0, nodes: {}, calls: [], agents: this.agents },
    });
    this.runBaselineParseInBackground(root);
  }

  private runBaselineParseInBackground(root: string): void {
    if (this.baselineLoading) return;
    const gen = this.baselineGeneration;
    this.baselineLoading = this.loadCoreSymbolSnapshot(root)
      .then((parsed) => {
        if (gen !== this.baselineGeneration) return;
        this.baselineNodes = parsed?.nodes ?? {};
        this.baselineCalls = parsed?.calls ?? [];
        this.postToWebview({
          method: "snapshot",
          params: {
            seq: 0,
            nodes: { ...this.baselineNodes, ...this.liveNodes },
            calls: this.baselineCalls,
            agents: this.agents,
          },
        });
      })
      .catch((err) =>
        console.error("[Graph] Background baseline parse failed:", err),
      )
      .finally(() => {
        if (gen === this.baselineGeneration) this.baselineLoading = null;
      });
  }

  private async loadCoreSymbolSnapshot(root: string): Promise<{
    nodes: Record<string, UiNode>;
    calls: Array<{ from: string; to: string }>;
  } | null> {
    const corePath = getCorePath(this.extensionUri);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        corePath,
        ["snapshot", "--root", root],
        { cwd: root, maxBuffer: 32 * 1024 * 1024 },
        (error, out) => {
          if (error) {
            console.error("[Graph] eisen-core snapshot failed:", error.message);
            reject(error);
            return;
          }
          resolve(out);
        },
      );
    }).catch(() => "");

    if (!stdout) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }

    const nodes: Record<string, UiNode> = {};
    const inputNodes = parsed?.nodes as Record<string, any> | undefined;
    if (!inputNodes) return null;

    for (const [rawId, rawNode] of Object.entries(inputNodes)) {
      const id = this.normalizeNodeId(rawId);
      if (!id || this.shouldIgnorePath(id)) continue;
      nodes[id] = {
        kind:
          typeof rawNode?.kind === "string"
            ? (rawNode.kind as UiNodeKind)
            : undefined,
        lines:
          rawNode?.lines && typeof rawNode.lines === "object"
            ? {
                start: Number(rawNode.lines.start) || 0,
                end: Number(rawNode.lines.end) || 0,
              }
            : undefined,
      };
    }

    const calls: Array<{ from: string; to: string }> = [];
    if (Array.isArray(parsed?.calls)) {
      for (const edge of parsed.calls) {
        const from = this.normalizeNodeId(String(edge?.from ?? ""));
        const to = this.normalizeNodeId(String(edge?.to ?? ""));
        if (
          !from ||
          !to ||
          this.shouldIgnorePath(from) ||
          this.shouldIgnorePath(to)
        )
          continue;
        if (!nodes[from] || !nodes[to]) continue;
        calls.push({ from, to });
      }
    }

    return { nodes, calls };
  }

  // -----------------------------------------------------------------------
  // Path normalization
  // -----------------------------------------------------------------------

  private normalizeNodeId(rawId: string): string {
    const [filePart, ...symbolParts] = rawId.split("::");
    const file = this.toWorkspaceRelative(filePart);
    if (!file || file.startsWith("..")) return "";
    return symbolParts.length === 0
      ? file
      : `${file}::${symbolParts.join("::")}`;
  }

  private toWorkspaceRelative(filePath: string): string {
    const normalized = filePath.replaceAll("\\", "/");
    if (!this.workspaceRoot || !path.isAbsolute(filePath)) {
      return normalized.replace(/^\.\//, "");
    }
    const relative = path
      .relative(this.workspaceRoot, filePath)
      .replaceAll(path.sep, "/");
    return relative.replace(/^\.\//, "");
  }

  private shouldIgnorePath(filePath: string): boolean {
    const id = filePath.includes("::")
      ? filePath.slice(0, filePath.indexOf("::"))
      : filePath;
    return (
      id === ".gitignore" ||
      id.endsWith("/.gitignore") ||
      id === ".DS_Store" ||
      id.endsWith("/.DS_Store")
    );
  }

  // -----------------------------------------------------------------------
  // Webview messaging
  // -----------------------------------------------------------------------

  /** Post a message to the webview, or queue it if the view isn't resolved yet. */
  private postToWebview(msg: { method: string; params: any }): void {
    if (this.hasWebviewTarget()) {
      this.sendToTargets(msg);
    } else {
      console.log(
        `[Graph] View not ready, queuing ${msg.method} message (${this.pendingMessages.length + 1} pending)`,
      );
      this.pendingMessages.push(msg);
    }
  }

  private handleWebviewMessage(msg: {
    type: string;
    path?: string;
    line?: number;
  }) {
    console.log(
      `[Graph] <- webview message: type=${msg.type}${msg.path ? `, path=${msg.path}` : ""}`,
    );
    switch (msg.type) {
      case "openFile":
        if (msg.path) {
          const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const fullPath = workspaceRoot
            ? path.join(workspaceRoot, msg.path)
            : msg.path;
          const line = msg.line != null ? Math.max(0, msg.line - 1) : 0;
          vscode.workspace.openTextDocument(fullPath).then(
            (doc) => {
              const opts: vscode.TextDocumentShowOptions =
                line > 0
                  ? {
                      selection: new vscode.Range(line, 0, line, 0),
                      preview: false,
                    }
                  : { preview: false };
              return vscode.window.showTextDocument(doc, opts);
            },
            (err) => console.error("[Graph] Failed to open file:", err),
          );
        }
        break;
      case "requestSnapshot":
        // In orchestrator mode, the graph doesn't have direct TCP access.
        // Emit the current merged state as a snapshot.
        this.postToWebview({
          method: "snapshot",
          params: {
            seq: 0,
            nodes: { ...(this.baselineNodes ?? {}), ...this.liveNodes },
            calls: this.baselineCalls,
            agents: this.agents,
          },
        });
        break;
    }
  }

  // -----------------------------------------------------------------------
  // HTML
  // -----------------------------------------------------------------------

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "graph.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "graph.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Eisen Graph</title>
</head>
<body>
  <div id="graph"></div>
  <script src="${scriptUri}"></script>
</body>
</html>`;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  dispose(): void {
    // No TCP to disconnect — orchestrator owns the connections
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer);
      this.deltaFlushTimer = null;
    }
  }
}
