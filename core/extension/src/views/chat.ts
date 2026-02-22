import { spawn } from "node:child_process";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { marked } from "marked";
import * as vscode from "vscode";
import { getAgent, getAgentsWithStatus, getDefaultAgent } from "../acp/agents";
import { ACPClient } from "../acp/client";
import type { SessionMode } from "../constants";
import { FileSearchService } from "../fileSearchService";
import { createSessionManager, type SessionManager } from "../session-manager";

marked.setOptions({ breaks: true, gfm: true });

interface WebviewMessage {
  type:
    | "sendMessage"
    | "ready"
    | "selectAgent"
    | "selectMode"
    | "selectModel"
    | "connect"
    | "newChat"
    | "clearChat"
    | "cancel"
    | "copyMessage"
    | "fileSearch"
    | "spawnAgent"
    | "switchInstance"
    | "closeInstance";
  text?: string;
  agentId?: string;
  modeId?: string;
  modelId?: string;
  query?: string;
  instanceKey?: string;
  agentType?: string;
  sessionMode?: SessionMode;
  contextChips?: Array<{
    filePath: string;
    fileName: string;
    isDirectory?: boolean;
    range?: { startLine: number; endLine: number };
  }>;
}

interface ManagedTerminal {
  id: string;
  proc: ReturnType<typeof spawn> | null;
  output: string;
  outputByteLimit: number | null;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  exitPromise: Promise<void>;
  exitResolve: () => void;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "eisen.chatView";

  private view?: vscode.WebviewView;
  private sm: SessionManager;
  private terminals: Map<string, ManagedTerminal> = new Map();
  private terminalCounter = 0;
  private fileSearchService = new FileSearchService();
  private connectedInstanceIds = new Set<string>();

  // Extension-specific callbacks (used by graph webview, extension.ts)
  public onDidConnect: ((client: ACPClient) => void) | null = null;
  public onDidDisconnect: ((instanceId: string) => void) | null = null;
  public onActiveClientChanged: ((client: ACPClient) => void) | null = null;
  public onAgentResponse?: (response: { from: string; agent: string; text: string; instanceId?: string }) => void;
  public onStreamStart?: (instanceId: string) => void;
  public onStreamChunk?: (text: string, instanceId: string) => void;
  public onStreamEnd?: (instanceId: string) => void;
  public onSessionMetadataChanged?: (meta: { modes?: unknown; models?: unknown }) => void;
  public onCommandsChanged?: (commands: Array<{ name: string; description?: string }>, instanceId?: string) => void;

  constructor(
    private readonly extensionUri: vscode.Uri,
    globalState: vscode.Memento,
  ) {
    this.sm = createSessionManager({
      adapter: {
        send: (msg) => {
          this.view?.webview.postMessage(msg);
          this.dispatchCallbacks(msg);
        },
        getWorkingDir: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
        stateGet: <T>(key: string) => globalState.get<T>(key),
        stateUpdate: (key, value) => globalState.update(key, value) as Promise<void>,
        log: (msg) => console.log(msg),
      },
      handlers: {
        readTextFile: (params) => this.handleReadTextFile(params),
        writeTextFile: (params) => this.handleWriteTextFile(params),
        createTerminal: (params) => this.handleCreateTerminal(params),
        terminalOutput: (params) => this.handleTerminalOutput(params),
        waitForTerminalExit: (params) => this.handleWaitForTerminalExit(params),
        killTerminalCommand: (params) => this.handleKillTerminalCommand(params),
        releaseTerminal: (params) => this.handleReleaseTerminal(params),
      },
      renderMarkdown: (text) => marked.parse(text) as string,
      createACPClient: (agentType) => {
        const agent = getAgent(agentType);
        if (!agent) throw new Error(`Unknown agent: ${agentType}`);
        return new ACPClient({
          agentConfig: agent,
          extensionUri: { fsPath: this.extensionUri.fsPath },
        });
      },
      onInstanceConnected: (session) => {
        const instId = session.client?.instanceId;
        if (instId) this.connectedInstanceIds.add(instId);
        if (session.client) this.onDidConnect?.(session.client as unknown as ACPClient);
      },
      onInstanceDisconnected: (session) => {
        const instId = session.client?.instanceId;
        if (instId && this.connectedInstanceIds.has(instId)) {
          this.connectedInstanceIds.delete(instId);
          this.onDidDisconnect?.(instId);
        }
      },
      onStreamingChunk: (rawText, instanceKey) => {
        const acpId = this.getAcpInstanceId(instanceKey);
        if (acpId) this.onStreamChunk?.(rawText, acpId);
      },
      onStreamingComplete: (instanceKey, response) => {
        const acpId = this.getAcpInstanceId(instanceKey);
        if (acpId) this.onStreamEnd?.(acpId);
        if (response.text) {
          this.onAgentResponse?.({
            from: "agent",
            agent: response.label,
            text: response.error ? `Error: ${response.error}` : response.text,
            instanceId: acpId ?? undefined,
          });
        } else if (response.error) {
          this.onAgentResponse?.({
            from: "agent",
            agent: response.label,
            text: `Error: ${response.error}`,
            instanceId: acpId ?? undefined,
          });
        }
      },
      onCommandsUpdate: (commands, instanceKey) => {
        const acpId = this.getAcpInstanceId(instanceKey);
        this.onCommandsChanged?.(commands as Array<{ name: string; description?: string }>, acpId ?? undefined);
      },
    });
  }

  private getAcpInstanceId(instanceKey: string): string | null {
    const session = this.sm.getSession(instanceKey);
    if (!session) return null;
    return session.client?.instanceId ?? null;
  }

  private dispatchCallbacks(msg: Record<string, unknown>): void {
    if (msg.type === "streamStart" && msg.instanceId) {
      const acpId = this.getAcpInstanceId(msg.instanceId as string);
      if (acpId) this.onStreamStart?.(acpId);
    }
    if (msg.type === "instanceChanged" && msg.instanceKey) {
      const session = this.sm.getSession(msg.instanceKey as string);
      if (session?.client) {
        this.onActiveClientChanged?.(session.client as unknown as ACPClient);
      }
    }
    if (msg.type === "sessionMetadata") {
      this.onSessionMetadataChanged?.({ modes: msg.modes, models: msg.models });
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (used by extension.ts and graph webview)
  // ---------------------------------------------------------------------------

  public getActiveClient(): ACPClient | null {
    const session = this.sm.getActiveSession();
    return (session?.client as unknown as ACPClient) ?? null;
  }

  public async spawnAndConnect(agentType?: string, sessionMode?: SessionMode): Promise<void> {
    const type = agentType ?? getDefaultAgent().id;
    await this.sm.spawnAgent(type, sessionMode ?? "single_agent");
  }

  public async sendFromGraph(
    text: string,
    contextChips?: Array<{ filePath: string; fileName: string; isDirectory?: boolean }>,
  ): Promise<void> {
    return this.sm.sendMessage(text, contextChips);
  }

  public async searchFiles(
    query: string,
  ): Promise<
    Array<{ path: string; fileName: string; relativePath: string; languageId: string; isDirectory: boolean }>
  > {
    return this.fileSearchService.search(query);
  }

  public switchToInstanceByInstanceId(instanceId: string): void {
    for (const [key, session] of this.sm.getSessions()) {
      if (session.client?.instanceId === instanceId) {
        this.sm.switchToInstance(key);
        return;
      }
    }
  }

  public async handleGraphModeChange(modeId: string): Promise<void> {
    return this.sm.setMode(modeId);
  }

  public async handleGraphModelChange(modelId: string): Promise<void> {
    return this.sm.setModel(modelId);
  }

  public getActiveSessionMetadata(): { modes?: unknown; models?: unknown } | null {
    const session = this.sm.getActiveSession();
    if (!session?.client) return null;
    return session.client.getSessionMetadata(session.acpSessionId ?? undefined) ?? null;
  }

  public async newChat(): Promise<void> {
    await this.sm.resetChat();
  }

  public async spawnAgent(agentType?: string, sessionMode?: SessionMode): Promise<void> {
    const type = agentType ?? getDefaultAgent().id;
    await this.sm.spawnAgent(type, sessionMode ?? "single_agent");
  }

  public clearChat(): void {
    this.view?.webview.postMessage({ type: "triggerClearChat" });
  }

  public postChipToWebview(chip: {
    id: string;
    filePath: string;
    fileName: string;
    languageId: string;
    range?: { startLine: number; endLine: number };
  }): void {
    this.view?.webview.postMessage({ type: "addContextChipFromEditor", chip });
    this.view?.webview.postMessage({ type: "focusChatInput" });
  }

  // ---------------------------------------------------------------------------
  // WebviewViewProvider
  // ---------------------------------------------------------------------------

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      switch (message.type) {
        case "sendMessage":
          if (message.text || (message.contextChips && message.contextChips.length > 0)) {
            await this.sm.sendMessage(message.text || "", message.contextChips);
          }
          break;
        case "fileSearch":
          if (message.query !== undefined) {
            const results = await this.fileSearchService.search(message.query);
            this.view?.webview.postMessage({ type: "fileSearchResults", searchResults: results });
          }
          break;
        case "selectAgent":
          if (message.agentId) await this.sm.spawnAgent(message.agentId);
          break;
        case "spawnAgent":
          if (message.agentType) await this.sm.spawnAgent(message.agentType, message.sessionMode);
          break;
        case "switchInstance":
          if (message.instanceKey) this.sm.switchToInstance(message.instanceKey);
          break;
        case "closeInstance":
          if (message.instanceKey) this.sm.closeInstance(message.instanceKey);
          break;
        case "selectMode":
          if (message.modeId) await this.sm.setMode(message.modeId);
          break;
        case "selectModel":
          if (message.modelId) await this.sm.setModel(message.modelId);
          break;
        case "connect":
          await this.sm.connect();
          break;
        case "newChat":
          await this.sm.resetChat();
          break;
        case "cancel":
          await this.sm.cancel();
          break;
        case "clearChat":
          this.sm.clearChat();
          break;
        case "copyMessage":
          if (message.text) await vscode.env.clipboard.writeText(message.text);
          break;
        case "ready": {
          const activeSession = this.sm.getActiveSession();
          if (activeSession?.client) {
            this.view?.webview.postMessage({ type: "connectionState", state: activeSession.client.getState() });
          }
          const agentsWithStatus = getAgentsWithStatus();
          this.view?.webview.postMessage({
            type: "agents",
            agents: agentsWithStatus.map((a) => ({ id: a.id, name: a.name, available: a.available })),
            selected: activeSession?.agentType ?? null,
          });
          this.sm.sendInstanceList();
          if (activeSession) {
            this.view?.webview.postMessage({ type: "streamingState", isStreaming: activeSession.isStreaming });
          }
          this.sm.sendSessionMetadata();
          break;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // File I/O handlers (VSCode-specific)
  // ---------------------------------------------------------------------------

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      const uri = vscode.Uri.file(params.path);
      const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath);
      let content: string;
      if (openDoc) {
        content = openDoc.getText();
      } else {
        const fileContent = await vscode.workspace.fs.readFile(uri);
        content = new TextDecoder().decode(fileContent);
      }
      if (params.line !== undefined || params.limit !== undefined) {
        const lines = content.split("\n");
        const startLine = params.line ?? 0;
        const lineLimit = params.limit ?? lines.length;
        content = lines.slice(startLine, startLine + lineLimit).join("\n");
      }
      return { content };
    } catch (error) {
      console.error("[Chat] Failed to read file:", error);
      throw error;
    }
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      const uri = vscode.Uri.file(params.path);
      const content = new TextEncoder().encode(params.content);
      await vscode.workspace.fs.writeFile(uri, content);
      return {};
    } catch (error) {
      console.error("[Chat] Failed to write file:", error);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Terminal handlers (VSCode-specific)
  // ---------------------------------------------------------------------------

  private async handleCreateTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term-${++this.terminalCounter}-${Date.now()}`;
    let exitResolve: () => void = () => {};
    const exitPromise = new Promise<void>((resolve) => {
      exitResolve = resolve;
    });

    const managedTerminal: ManagedTerminal = {
      id: terminalId,
      proc: null,
      output: "",
      outputByteLimit: params.outputByteLimit ?? null,
      truncated: false,
      exitCode: null,
      signal: null,
      exitPromise,
      exitResolve,
    };

    const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cwd = params.cwd && params.cwd.trim() !== "" ? params.cwd : workspaceCwd || process.env.HOME || process.cwd();

    const useShell = !params.args || params.args.length === 0;
    const proc = spawn(params.command, params.args || [], {
      cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(params.env?.map((e) => [e.name, e.value]) || []),
      },
      shell: useShell,
    });

    managedTerminal.proc = proc;

    proc.stdout?.on("data", (data: Buffer) => {
      this.appendTerminalOutput(managedTerminal, data.toString());
    });

    proc.stderr?.on("data", (data: Buffer) => {
      this.appendTerminalOutput(managedTerminal, data.toString());
    });

    proc.on("close", (code: number | null, signal: string | null) => {
      managedTerminal.exitCode = code;
      managedTerminal.signal = signal;
      managedTerminal.exitResolve();
    });

    proc.on("error", (_err: Error) => {
      managedTerminal.exitCode = 1;
      managedTerminal.exitResolve();
    });

    this.terminals.set(terminalId, managedTerminal);

    return { terminalId };
  }

  private appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
    terminal.output += text;
    if (terminal.outputByteLimit !== null) {
      const byteLength = Buffer.byteLength(terminal.output, "utf8");
      if (byteLength > terminal.outputByteLimit) {
        const encoded = Buffer.from(terminal.output, "utf8");
        const sliced = encoded.slice(-terminal.outputByteLimit);
        terminal.output = sliced.toString("utf8");
        terminal.truncated = true;
      }
    }
  }

  private async handleTerminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${params.terminalId}`);
    const exitStatus =
      terminal.exitCode !== null
        ? { exitCode: terminal.exitCode, ...(terminal.signal !== null && { signal: terminal.signal }) }
        : null;
    return { output: terminal.output, truncated: terminal.truncated, exitStatus };
  }

  private async handleWaitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${params.terminalId}`);
    await terminal.exitPromise;
    return { exitCode: terminal.exitCode, ...(terminal.signal !== null && { signal: terminal.signal }) };
  }

  private async handleKillTerminalCommand(params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${params.terminalId}`);
    if (terminal.proc && !terminal.proc.killed) {
      try {
        terminal.proc.kill();
      } catch {}
    }
    return {};
  }

  private async handleReleaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) return {};
    if (terminal.proc && !terminal.proc.killed) {
      try {
        terminal.proc.kill();
      } catch {}
    }
    this.terminals.delete(params.terminalId);
    return {};
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  public dispose(): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.proc && !terminal.proc.killed) {
        try {
          terminal.proc.kill();
        } catch {}
      }
    }
    this.terminals.clear();
    this.sm.dispose();
    this.fileSearchService.dispose();
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private getHtmlContent(webview: vscode.Webview): string {
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "reset.css"));
    const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "vscode.css"));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
    const webviewScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "chatWebview.js"));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link href="${styleResetUri}" rel="stylesheet">
  <link href="${styleVSCodeUri}" rel="stylesheet">
  <link href="${styleMainUri}" rel="stylesheet">
</head>
<body>
  <div id="top-bar">
    <select id="agent-selector" class="inline-select"></select>
    <button id="add-agent-btn" title="Add agent">+ Add</button>
  </div>
  <div id="main-area">
    <div id="empty-state" class="empty-state">
      <p>Select an agent and add them to get started</p>
    </div>
    <div id="tab-sidebar" style="display:none">
      <div id="instance-tabs"></div>
    </div>
    <div id="chat-main" style="display:none">
      <div id="status-bar">
        <span class="status-indicator">
          <span class="status-dot" id="status-dot"></span>
          <span id="status-text">Disconnected</span>
        </span>
        <button id="connect-btn">Connect</button>
      </div>
      <div id="welcome-view" class="welcome-view">
        <p>Interact with AI coding agents while visualizing their activity.</p>
      </div>
      <div id="agent-plan-container"></div>
      <div id="messages" role="log" tabindex="0"></div>
      <div id="input-container">
        <div id="command-autocomplete"></div>
        <div id="file-picker"></div>
        <div id="chip-stack"></div>
        <textarea id="input" rows="1" placeholder="Ask your agent... (@ for files, / for commands)"></textarea>
        <button id="stop" title="Stop agent" disabled>Stop</button>
        <button id="send" title="Send (Enter)">Send</button>
      </div>
      <div id="options-bar">
        <select id="mode-selector" class="inline-select" style="display:none"></select>
        <select id="model-selector" class="inline-select" style="display:none"></select>
        <span id="usage-meter"></span>
      </div>
    </div>
  </div>
<script src="${webviewScriptUri}"></script>
</body>
</html>`;
  }
}
