import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { getCorePath } from "../bridge";
import type { AgentInfo, MergedGraphDelta, MergedGraphDeltaUpdate, MergedGraphSnapshot } from "../orchestrator";

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
  tokens?: number;
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
  private pendingMessages: Array<{ method: string; params: unknown }> = [];
  private baselineNodes: Record<string, UiNode> | null = null;
  private baselineCalls: Array<{ from: string; to: string }> = [];
  private baselineLoading: Promise<void> | null = null;
  private workspaceRoot: string | null = null;
  private baselineGeneration = 0;

  private liveNodes: Record<string, UiNode> = {};
  private agents: AgentInfo[] = [];
  private availableAgentTypes: Array<{ id: string; name: string }> = [];

  /** Throttle delta postMessage to avoid saturating the webview IPC channel.
   *  Deltas are batched and flushed at most every DELTA_FLUSH_MS. */
  private static readonly DELTA_FLUSH_MS = 200; // ~5 Hz max
  private pendingDeltaUpdates: MergedGraphDeltaUpdate[] = [];
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
    const nodes: Record<string, UiNode> = this.baselineNodes ? { ...this.baselineNodes } : {};

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
    const latestById = new Map<string, MergedGraphDeltaUpdate>();
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
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel("eisen.graphPanel", "Eisen Graph", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.extensionUri],
    });

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

  private sendToTargets(msg: { method: string; params: unknown }): void {
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
      .catch((err) => console.error("[Graph] Background baseline parse failed:", err))
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
      execFile(corePath, ["snapshot", "--root", root], { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (error, out) => {
        if (error) {
          console.error("[Graph] eisen-core snapshot failed:", error.message);
          reject(error);
          return;
        }
        resolve(out);
      });
    }).catch(() => "");

    if (!stdout) return null;

    let parsed: { nodes?: Record<string, Record<string, unknown>>; calls?: Array<{ from?: string; to?: string }> };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }

    const nodes: Record<string, UiNode> = {};
    const inputNodes = parsed?.nodes;
    if (!inputNodes) return null;

    for (const [rawId, rawNode] of Object.entries(inputNodes)) {
      const id = this.normalizeNodeId(rawId);
      if (!id || this.shouldIgnorePath(id)) continue;
      const lines = rawNode.lines as { start?: unknown; end?: unknown } | undefined;
      nodes[id] = {
        kind: typeof rawNode.kind === "string" ? (rawNode.kind as UiNodeKind) : undefined,
        lines:
          lines && typeof lines === "object"
            ? {
                start: Number(lines.start) || 0,
                end: Number(lines.end) || 0,
              }
            : undefined,
        tokens: typeof rawNode.tokens === "number" ? rawNode.tokens : undefined,
      };
    }

    const calls: Array<{ from: string; to: string }> = [];
    if (Array.isArray(parsed?.calls)) {
      for (const edge of parsed.calls) {
        const from = this.normalizeNodeId(String(edge?.from ?? ""));
        const to = this.normalizeNodeId(String(edge?.to ?? ""));
        if (!from || !to || this.shouldIgnorePath(from) || this.shouldIgnorePath(to)) continue;
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
    return symbolParts.length === 0 ? file : `${file}::${symbolParts.join("::")}`;
  }

  private toWorkspaceRelative(filePath: string): string {
    const normalized = filePath.replaceAll("\\", "/");
    if (!this.workspaceRoot || !path.isAbsolute(filePath)) {
      return normalized.replace(/^\.\//, "");
    }
    const relative = path.relative(this.workspaceRoot, filePath).replaceAll(path.sep, "/");
    return relative.replace(/^\.\//, "");
  }

  private shouldIgnorePath(filePath: string): boolean {
    const id = filePath.includes("::") ? filePath.slice(0, filePath.indexOf("::")) : filePath;
    return id === ".gitignore" || id.endsWith("/.gitignore") || id === ".DS_Store" || id.endsWith("/.DS_Store");
  }

  // -----------------------------------------------------------------------
  // Webview messaging
  // -----------------------------------------------------------------------

  /** Post a message to the webview, or queue it if the view isn't resolved yet. */
  private postToWebview(msg: { method: string; params: unknown }): void {
    if (this.hasWebviewTarget()) {
      this.sendToTargets(msg);
    } else {
      console.log(`[Graph] View not ready, queuing ${msg.method} message (${this.pendingMessages.length + 1} pending)`);
      this.pendingMessages.push(msg);
    }
  }

  public onChatMessage?: (
    text: string,
    instanceId: string | null,
    contextChips?: Array<{ filePath: string; fileName: string; isDirectory?: boolean }>,
  ) => void;
  public onAddAgent?: (agentType?: string, sessionMode?: "single_agent" | "orchestrator") => void;
  public onSwitchAgent?: (instanceId: string) => void;
  public onModeChange?: (modeId: string) => void;
  public onModelChange?: (modelId: string) => void;
  public onFileSearch?: (query: string) => void;

  public setAvailableAgentTypes(agents: Array<{ id: string; name: string }>): void {
    this.availableAgentTypes = agents;
    this.postToWebview({ method: "availableAgents", params: agents });
  }

  public relayChatResponse(response: { from: string; agent: string; text: string; instanceId?: string }): void {
    this.postToWebview({ method: "chatMessage", params: response });
  }

  public relayStreamStart(instanceId: string): void {
    this.postToWebview({ method: "streamStart", params: { instanceId } });
  }

  public relayStreamChunk(text: string, instanceId: string): void {
    this.postToWebview({ method: "streamChunk", params: { text, instanceId } });
  }

  public relayStreamEnd(instanceId: string): void {
    this.postToWebview({ method: "streamEnd", params: { instanceId } });
  }

  public relaySessionMetadata(meta: { modes?: unknown; models?: unknown }): void {
    this.postToWebview({ method: "sessionMetadata", params: meta });
  }

  public relayFileSearchResults(
    results: Array<{ path: string; fileName: string; relativePath: string; languageId: string; isDirectory: boolean }>,
  ): void {
    this.postToWebview({ method: "fileSearchResults", params: results });
  }

  public relayAvailableCommands(commands: Array<{ name: string; description?: string }>, instanceId?: string): void {
    this.postToWebview({ method: "availableCommands", params: { commands, instanceId } });
  }

  private handleWebviewMessage(msg: {
    type: string;
    path?: string;
    line?: number;
    text?: string;
    agent?: string;
    agentType?: string;
    sessionMode?: string;
    instanceId?: string;
    modeId?: string;
    modelId?: string;
    query?: string;
    contextChips?: Array<{ filePath: string; fileName: string; isDirectory?: boolean }>;
  }) {
    console.log(`[Graph] <- webview message: type=${msg.type}${msg.path ? `, path=${msg.path}` : ""}`);
    switch (msg.type) {
      case "openFile":
        if (msg.path) {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const fullPath = workspaceRoot ? path.join(workspaceRoot, msg.path) : msg.path;
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
      case "readFile":
        if (msg.path) {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const full = root ? path.join(root, msg.path) : msg.path;
          const node = this.liveNodes[msg.path] ?? this.baselineNodes?.[msg.path];
          vscode.workspace.openTextDocument(full).then(
            (doc) => {
              this.postToWebview({
                method: "fileContent",
                params: {
                  path: msg.path,
                  content: doc.getText(),
                  startLine: node?.lines?.start,
                },
              });
            },
            (err) => console.error("[Graph] Failed to read file:", err),
          );
        }
        break;
      case "addToContext":
        if (msg.path) {
          console.log(`[Graph] Add to context: ${msg.path}`);
        }
        break;
      case "requestSnapshot":
        this.postToWebview({
          method: "snapshot",
          params: {
            seq: 0,
            nodes: { ...(this.baselineNodes ?? {}), ...this.liveNodes },
            calls: this.baselineCalls,
            agents: this.agents,
          },
        });
        if (this.availableAgentTypes.length > 0) {
          this.postToWebview({ method: "availableAgents", params: this.availableAgentTypes });
        }
        break;
      case "chatMessage":
        if (msg.text) this.onChatMessage?.(msg.text, msg.instanceId ?? null, msg.contextChips);
        break;
      case "fileSearch":
        if (msg.query !== undefined) this.onFileSearch?.(msg.query);
        break;
      case "addAgent":
        this.onAddAgent?.(
          msg.agentType as string | undefined,
          msg.sessionMode as "single_agent" | "orchestrator" | undefined,
        );
        break;
      case "switchAgent":
        if (msg.instanceId) this.onSwitchAgent?.(msg.instanceId);
        break;
      case "selectMode":
        if (msg.modeId) this.onModeChange?.(msg.modeId);
        break;
      case "selectModel":
        if (msg.modelId) this.onModelChange?.(msg.modelId);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // HTML
  // -----------------------------------------------------------------------

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "graph.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "graph.css"));
    const nonce = crypto.randomBytes(16).toString("base64");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-eval' 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <style nonce="${nonce}">*:focus,*:focus-visible{outline:none!important;outline-offset:0!important;box-shadow:none!important;}</style>
  <title>Eisen</title>
</head>
<body>
  <div id="graph"></div>
  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      window.__eisenTransport = {
        send: function(msg) { vscode.postMessage(msg); },
        listen: function(handler) {
          window.addEventListener("message", function(e) { handler(e.data); });
        }
      };
    })();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
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
