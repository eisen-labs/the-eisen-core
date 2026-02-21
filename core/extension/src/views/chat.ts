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
  SessionNotification,
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
import { ACPClient, type ContextChipData } from "../acp/client";
import { FileSearchService } from "../fileSearchService";
import { AGENT_COLORS } from "../orchestrator";

marked.setOptions({ breaks: true, gfm: true });

const SELECTED_AGENT_KEY = "eisen.selectedAgent";
const SELECTED_MODE_KEY = "eisen.selectedMode";
const SELECTED_MODEL_KEY = "eisen.selectedModel";

/** Maximum number of concurrent agent instances to prevent resource exhaustion */
const MAX_AGENT_INSTANCES = 10;

// 2-letter abbreviations for agent types (used in tab labels)
const AGENT_SHORT_NAMES: Record<string, string> = {
  opencode: "op",
  "claude-code": "cl",
  codex: "cx",
  gemini: "ge",
  goose: "go",
  amp: "am",
  aider: "ai",
};

function agentShortName(agentType: string): string {
  return AGENT_SHORT_NAMES[agentType] ?? agentType.slice(0, 2);
}

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
  contextChips?: Array<{
    filePath: string;
    fileName: string;
    isDirectory?: boolean;
    range?: { startLine: number; endLine: number };
  }>;
}

interface AgentInstance {
  key: string; // "op1", "cl2" — the tab identity
  agentType: string; // "opencode", "claude-code" — which agent config
  label: string; // "op1", "cl2" — displayed on the tab
  client: ACPClient;
  acpSessionId: string | null;
  hasAcpSession: boolean;
  hasRestoredModeModel: boolean;
  stderrBuffer: string;
  streamingText: string;
  color: string; // from AGENT_COLORS palette
  isStreaming: boolean; // true while sendMessage() is in flight
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

export interface InstanceInfo {
  key: string;
  label: string;
  agentType: string;
  color: string;
  connected: boolean;
  isStreaming: boolean;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "eisen.chatView";

  private view?: vscode.WebviewView;
  private globalState: vscode.Memento;
  private terminals: Map<string, ManagedTerminal> = new Map();
  private terminalCounter = 0;
  private fileSearchService = new FileSearchService();

  public onDidConnect: ((client: ACPClient) => void) | null = null;
  public onDidDisconnect: ((instanceId: string) => void) | null = null;
  public onActiveClientChanged: ((client: ACPClient) => void) | null = null;

  private connectedInstanceIds = new Set<string>();
  private agentInstances = new Map<string, AgentInstance>();
  private currentInstanceKey: string | null = null;
  private instanceCounters = new Map<string, number>();
  private nextColorIndex = 0;

  private get activeInstance(): AgentInstance | undefined {
    return this.currentInstanceKey ? this.agentInstances.get(this.currentInstanceKey) : undefined;
  }

  private get activeClient(): ACPClient | null {
    return this.activeInstance?.client ?? null;
  }

  private createInstance(agentType: string): AgentInstance {
    if (this.agentInstances.size >= MAX_AGENT_INSTANCES) {
      throw new Error(
        `Maximum number of concurrent agents (${MAX_AGENT_INSTANCES}) reached. ` +
          `Close an existing agent tab before spawning a new one.`,
      );
    }

    const agent = getAgent(agentType);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentType}`);
    }

    const count = (this.instanceCounters.get(agentType) ?? 0) + 1;
    this.instanceCounters.set(agentType, count);
    const short = agentShortName(agentType);
    const key = `${short}${count}`;
    const label = key;

    const color = AGENT_COLORS[this.nextColorIndex % AGENT_COLORS.length];
    this.nextColorIndex++;

    const client = new ACPClient({
      agentConfig: agent,
      extensionUri: { fsPath: this.extensionUri.fsPath },
    });

    const instance: AgentInstance = {
      key,
      agentType,
      label,
      client,
      acpSessionId: null,
      hasAcpSession: false,
      hasRestoredModeModel: false,
      stderrBuffer: "",
      streamingText: "",
      color,
      isStreaming: false,
    };

    this.setupClientHandlers(client, key);
    this.agentInstances.set(key, instance);
    return instance;
  }

  private setupClientHandlers(client: ACPClient, instanceKey: string): void {
    client.setOnStateChange((state) => {
      const inst = this.agentInstances.get(instanceKey);
      console.log(
        `[Chat] Instance "${instanceKey}" (type=${inst?.agentType}) state -> "${state}" (instanceId=${client.instanceId}, isActive=${this.currentInstanceKey === instanceKey})`,
      );

      if (state === "connected") {
        const instId = client.instanceId;
        if (instId) {
          this.connectedInstanceIds.add(instId);
          console.log(`[Chat] Firing onDidConnect for instance "${instanceKey}" (instanceId=${instId})`);
        }
        this.onDidConnect?.(client);
        this.sendInstanceList();
      }
      if (state === "disconnected") {
        const instId = client.instanceId;
        if (instId && this.connectedInstanceIds.has(instId)) {
          this.connectedInstanceIds.delete(instId);
          console.log(`[Chat] Firing onDidDisconnect for instance "${instanceKey}" (instanceId=${instId})`);
          this.onDidDisconnect?.(instId);
        }
        this.sendInstanceList();
      }

      if (this.currentInstanceKey === instanceKey) {
        this.postMessage({ type: "connectionState", state });
      }
    });

    client.setOnSessionUpdate((update) => {
      if (this.currentInstanceKey === instanceKey) {
        this.handleSessionUpdate(update);
      } else {
        const bgInst = this.agentInstances.get(instanceKey);
        if (
          bgInst &&
          update.update?.sessionUpdate === "agent_message_chunk" &&
          update.update?.content?.type === "text"
        ) {
          bgInst.streamingText += update.update.content.text;
        }
      }
    });

    client.setOnStderr((text) => {
      const inst = this.agentInstances.get(instanceKey);
      if (inst) {
        inst.stderrBuffer += text;
      }
      if (this.currentInstanceKey === instanceKey) {
        this.handleStderr(text, instanceKey);
      }
    });

    client.setOnReadTextFile(async (params: ReadTextFileRequest) => {
      return this.handleReadTextFile(params);
    });

    client.setOnWriteTextFile(async (params: WriteTextFileRequest) => {
      return this.handleWriteTextFile(params);
    });

    client.setOnCreateTerminal(async (params: CreateTerminalRequest) => {
      return this.handleCreateTerminal(params);
    });

    client.setOnTerminalOutput(async (params: TerminalOutputRequest) => {
      return this.handleTerminalOutput(params);
    });

    client.setOnWaitForTerminalExit(async (params: WaitForTerminalExitRequest) => {
      return this.handleWaitForTerminalExit(params);
    });

    client.setOnKillTerminalCommand(async (params: KillTerminalCommandRequest) => {
      return this.handleKillTerminalCommand(params);
    });

    client.setOnReleaseTerminal(async (params: ReleaseTerminalRequest) => {
      return this.handleReleaseTerminal(params);
    });
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    globalState: vscode.Memento,
  ) {
    this.globalState = globalState;

    this.currentInstanceKey = null;
  }

  public getActiveClient(): ACPClient | null {
    return this.activeClient;
  }

  public onAgentResponse?: (response: { from: string; agent: string; text: string; instanceId?: string }) => void;
  public onStreamStart?: (instanceId: string) => void;
  public onStreamChunk?: (text: string, instanceId: string) => void;
  public onStreamEnd?: (instanceId: string) => void;
  public onSessionMetadataChanged?: (meta: { modes?: unknown; models?: unknown }) => void;
  public onCommandsChanged?: (commands: Array<{ name: string; description?: string }>, instanceId?: string) => void;

  private async ensureClientConnected(inst: AgentInstance): Promise<void> {
    const state = inst.client.getState();
    if (state === "connected") return;
    if (state === "connecting") {
      await new Promise<void>((resolve, reject) => {
        const unsub = inst.client.setOnStateChange((s) => {
          if (s === "connected") {
            unsub();
            resolve();
          } else if (s === "disconnected") {
            unsub();
            reject(new Error("Connection failed"));
          }
        });
      });
      return;
    }
    await inst.client.connect();
  }

  public async spawnAndConnect(agentType?: string): Promise<void> {
    this.spawnAgent(agentType);
    const inst = this.activeInstance;
    if (inst) await this.ensureClientConnected(inst);
  }

  public async sendFromGraph(
    text: string,
    contextChips?: Array<{ filePath: string; fileName: string; isDirectory?: boolean }>,
  ): Promise<void> {
    return this.handleUserMessage(text, contextChips);
  }

  public async searchFiles(
    query: string,
  ): Promise<
    Array<{ path: string; fileName: string; relativePath: string; languageId: string; isDirectory: boolean }>
  > {
    return this.fileSearchService.search(query);
  }

  public switchToInstanceByInstanceId(instanceId: string): void {
    for (const [key, inst] of this.agentInstances) {
      if (inst.client.instanceId === instanceId) {
        this.switchToInstance(key);
        return;
      }
    }
  }

  public async handleGraphModeChange(modeId: string): Promise<void> {
    return this.handleModeChange(modeId);
  }

  public async handleGraphModelChange(modelId: string): Promise<void> {
    return this.handleModelChange(modelId);
  }

  public getActiveSessionMetadata(): { modes?: unknown; models?: unknown } | null {
    const inst = this.activeInstance;
    if (!inst) return null;
    return inst.client.getSessionMetadata(inst.acpSessionId ?? undefined) ?? null;
  }

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
            await this.handleUserMessage(message.text || "", message.contextChips);
          }
          break;
        case "fileSearch":
          if (message.query !== undefined) {
            const results = await this.fileSearchService.search(message.query);
            this.postMessage({
              type: "fileSearchResults",
              searchResults: results,
            });
          }
          break;
        case "selectAgent":
          // Legacy: when agent selector dropdown is used, spawn a new instance of that type
          if (message.agentId) {
            this.handleSpawnAgent(message.agentId);
          }
          break;
        case "spawnAgent":
          if (message.agentType) {
            this.handleSpawnAgent(message.agentType);
          }
          break;
        case "switchInstance":
          if (message.instanceKey) {
            this.switchToInstance(message.instanceKey);
          }
          break;
        case "closeInstance":
          if (message.instanceKey) {
            this.handleCloseInstance(message.instanceKey);
          }
          break;
        case "selectMode":
          if (message.modeId) {
            await this.handleModeChange(message.modeId);
          }
          break;
        case "selectModel":
          if (message.modelId) {
            await this.handleModelChange(message.modelId);
          }
          break;
        case "connect":
          await this.handleConnect();
          break;
        case "newChat":
          await this.handleNewChat();
          break;
        case "cancel":
          await this.activeClient?.cancel();
          break;
        case "clearChat":
          this.handleClearChat();
          break;
        case "copyMessage":
          if (message.text) {
            await vscode.env.clipboard.writeText(message.text);
          }
          break;
        case "ready": {
          // Send current connection state
          if (this.activeClient) {
            this.postMessage({
              type: "connectionState",
              state: this.activeClient.getState(),
            });
          }
          // Send agent list for the spawn dropdown
          const agentsWithStatus = getAgentsWithStatus();
          this.postMessage({
            type: "agents",
            agents: agentsWithStatus.map((a) => ({
              id: a.id,
              name: a.name,
              available: a.available,
            })),
            selected: this.activeInstance?.agentType ?? null,
          });
          // Send instance list for the tab bar (includes isStreaming per instance)
          this.sendInstanceList();
          // Send streaming state for the active instance so webview can sync stop button
          if (this.activeInstance) {
            this.postMessage({
              type: "streamingState",
              isStreaming: this.activeInstance.isStreaming,
            });
          }
          // Send session metadata
          this.sendSessionMetadata();
          break;
        }
      }
    });
  }

  private switchToInstance(instanceKey: string): void {
    if (instanceKey === this.currentInstanceKey) return;
    const target = this.agentInstances.get(instanceKey);
    if (!target) return;

    this.currentInstanceKey = instanceKey;
    this.globalState.update(SELECTED_AGENT_KEY, target.agentType);

    this.onActiveClientChanged?.(target.client);

    this.postMessage({
      type: "instanceChanged",
      instanceKey,
      isStreaming: target.isStreaming,
    });
    this.postMessage({
      type: "connectionState",
      state: target.client.getState(),
    });
    this.sendInstanceList();

    if (target.client.isConnected()) {
      this.sendSessionMetadata();
    } else {
      this.postMessage({ type: "sessionMetadata", modes: null, models: null });
    }
  }

  private handleSpawnAgent(agentType: string): void {
    const agent = getAgent(agentType);
    if (!agent) return;

    try {
      const instance = this.createInstance(agentType);
      this.switchToInstance(instance.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn agent";
      this.postMessage({ type: "error", text: message });
    }
  }

  private handleCloseInstance(instanceKey: string): void {
    const instance = this.agentInstances.get(instanceKey);
    if (!instance) return;

    const instId = instance.client.instanceId;
    try {
      instance.client.dispose();
    } catch {}

    if (instId && this.connectedInstanceIds.has(instId)) {
      this.connectedInstanceIds.delete(instId);
      this.onDidDisconnect?.(instId);
    }

    this.agentInstances.delete(instanceKey);

    if (this.currentInstanceKey === instanceKey) {
      const remaining = Array.from(this.agentInstances.keys());
      if (remaining.length > 0) {
        this.switchToInstance(remaining[remaining.length - 1]);
      } else {
        this.currentInstanceKey = null;
        this.instanceCounters.clear();
        this.nextColorIndex = 0;
        this.postMessage({
          type: "instanceChanged",
          instanceKey: null,
          isStreaming: false,
        });
      }
    }

    this.sendInstanceList();
  }

  private getInstanceList(): InstanceInfo[] {
    const list: InstanceInfo[] = [];
    for (const inst of this.agentInstances.values()) {
      list.push({
        key: inst.key,
        label: inst.label,
        agentType: inst.agentType,
        color: inst.color,
        connected: inst.client.isConnected(),
        isStreaming: inst.isStreaming,
      });
    }
    return list;
  }

  private sendInstanceList(): void {
    this.postMessage({
      type: "instanceList",
      instances: this.getInstanceList(),
      currentInstanceKey: this.currentInstanceKey,
    });
  }

  public async newChat(): Promise<void> {
    await this.handleNewChat();
  }

  public spawnAgent(agentType?: string): void {
    const type = agentType ?? getDefaultAgent().id;
    this.handleSpawnAgent(type);
  }

  public clearChat(): void {
    this.postMessage({ type: "triggerClearChat" });
  }

  private handleStderr(_text: string, instanceKey: string): void {
    const inst = this.agentInstances.get(instanceKey);
    if (!inst) return;
    const errorMatch = inst.stderrBuffer.match(/(\w+Error):\s*(\w+)?\s*\n?\s*data:\s*\{([^}]+)\}/);
    if (errorMatch) {
      const errorType = errorMatch[1];
      const errorData = errorMatch[3];
      const providerMatch = errorData.match(/providerID:\s*"([^"]+)"/);
      const modelMatch = errorData.match(/modelID:\s*"([^"]+)"/);
      let message = `Agent error: ${errorType}`;
      if (providerMatch && modelMatch) {
        message = `Model not found: ${providerMatch[1]}/${modelMatch[1]}`;
      }
      if (this.currentInstanceKey === instanceKey) {
        this.postMessage({ type: "agentError", text: message });
      }
      inst.stderrBuffer = "";
    }
    if (inst.stderrBuffer.length > 10000) {
      inst.stderrBuffer = inst.stderrBuffer.slice(-5000);
    }
  }

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

    // Use shell only when no explicit args are provided (command may be a
    // shell expression like "echo foo && bar"). When args are present the
    // command is a concrete executable and shell: false avoids spawning an
    // extra /bin/sh process per terminal command, reducing process pressure.
    const useShell = !params.args || params.args.length === 0;
    const proc = spawn(params.command, params.args || [], {
      cwd,
      env: {
        ...process.env,
        ...(params.env?.reduce((acc, e) => ({ ...acc, [e.name]: e.value }), {}) || {}),
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
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
    const exitStatus =
      terminal.exitCode !== null
        ? {
            exitCode: terminal.exitCode,
            ...(terminal.signal !== null && { signal: terminal.signal }),
          }
        : null;
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus,
    };
  }

  private async handleWaitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
    await terminal.exitPromise;
    return {
      exitCode: terminal.exitCode,
      ...(terminal.signal !== null && { signal: terminal.signal }),
    };
  }

  private async handleKillTerminalCommand(params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) {
      throw new Error(`Terminal not found: ${params.terminalId}`);
    }
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

  public dispose(): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.proc && !terminal.proc.killed) {
        try {
          terminal.proc.kill();
        } catch {}
      }
    }
    this.terminals.clear();

    for (const inst of this.agentInstances.values()) {
      try {
        inst.client.dispose();
      } catch {}
    }
    this.agentInstances.clear();
    this.currentInstanceKey = null;
    this.fileSearchService.dispose();
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    const inst = this.activeInstance;

    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        if (inst) inst.streamingText += update.content.text;
        this.postMessage({ type: "streamChunk", text: update.content.text });
        if (inst?.client.instanceId) this.onStreamChunk?.(update.content.text, inst.client.instanceId);
      }
    } else if (update.sessionUpdate === "tool_call") {
      this.postMessage({
        type: "toolCallStart",
        name: update.title,
        toolCallId: update.toolCallId,
        kind: update.kind,
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      if (update.status === "completed" || update.status === "failed") {
        let terminalOutput: string | undefined;
        let terminalId: string | undefined;
        if (update.content && update.content.length > 0) {
          const terminalContent = update.content.find((c: { type: string }) => c.type === "terminal");
          if (terminalContent && "terminalId" in terminalContent) {
            terminalId = String(terminalContent.terminalId);
            terminalOutput = `[Terminal: ${terminalId}]`;
          }
        }
        this.postMessage({
          type: "toolCallComplete",
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          content: update.content,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          status: update.status,
          terminalOutput,
        });
      }
    } else if (update.sessionUpdate === "current_mode_update") {
      this.postMessage({ type: "modeUpdate", modeId: update.currentModeId });
    } else if (update.sessionUpdate === "available_commands_update") {
      this.postMessage({
        type: "availableCommands",
        commands: update.availableCommands,
      });
      const inst = this.activeInstance;
      if (update.availableCommands) {
        this.onCommandsChanged?.(update.availableCommands, inst?.client.instanceId ?? undefined);
      }
    } else if (update.sessionUpdate === "plan") {
      this.postMessage({ type: "plan", plan: { entries: update.entries } });
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content?.type === "text") {
        this.postMessage({ type: "thoughtChunk", text: update.content.text });
      }
    } else if (update.sessionUpdate === "usage_update") {
      this.postMessage({
        type: "usageUpdate",
        used: update.used,
        size: update.size,
        cost: update.cost,
      });
    }
  }

  private async handleUserMessage(
    text: string,
    contextChips?: Array<{
      filePath: string;
      fileName: string;
      isDirectory?: boolean;
      range?: { startLine: number; endLine: number };
    }>,
  ): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;

    const chipNames = contextChips?.map((c) => {
      const name = c.fileName;
      if (c.isDirectory) return `${name}/`;
      return c.range ? `${name}:${c.range.startLine}-${c.range.endLine}` : name;
    });
    this.postMessage({
      type: "userMessage",
      text,
      contextChipNames: chipNames,
    });

    try {
      await this.ensureClientConnected(inst);

      if (!inst.hasAcpSession) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        const resp = await inst.client.newSession(workingDir);
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        this.sendSessionMetadata();
      } else if (inst.acpSessionId) {
        inst.client.setActiveSession(inst.acpSessionId);
      }

      inst.streamingText = "";
      inst.stderrBuffer = "";
      inst.isStreaming = true;
      this.postMessage({ type: "streamStart" });
      if (inst.client.instanceId) this.onStreamStart?.(inst.client.instanceId);

      const chipData: ContextChipData[] | undefined = contextChips?.map((c) => ({
        filePath: c.filePath,
        fileName: c.fileName,
        isDirectory: c.isDirectory,
        range: c.range,
      }));
      const response = await inst.client.sendMessage(text, chipData);

      inst.isStreaming = false;
      if (inst.streamingText.length === 0) {
        this.postMessage({
          type: "error",
          text: "Agent returned no response.",
        });
        this.postMessage({ type: "streamEnd", stopReason: "error", html: "" });
      } else {
        const renderedHtml = marked.parse(inst.streamingText) as string;
        this.postMessage({
          type: "streamEnd",
          stopReason: response.stopReason,
          html: renderedHtml,
        });
        this.onAgentResponse?.({
          from: "agent",
          agent: inst.label,
          text: inst.streamingText,
          instanceId: inst.client.instanceId ?? undefined,
        });
      }
      if (inst.client.instanceId) this.onStreamEnd?.(inst.client.instanceId);
      inst.streamingText = "";
    } catch (error) {
      inst.isStreaming = false;
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      this.postMessage({ type: "error", text: `Error: ${errorMessage}` });
      this.onAgentResponse?.({
        from: "agent",
        agent: inst.label,
        text: `Error: ${errorMessage}`,
        instanceId: inst.client.instanceId ?? undefined,
      });
      this.postMessage({ type: "streamEnd", stopReason: "error", html: "" });
      if (inst.client.instanceId) this.onStreamEnd?.(inst.client.instanceId);
      inst.streamingText = "";
      inst.stderrBuffer = "";
    }
  }

  private async handleModeChange(modeId: string): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;
    try {
      await inst.client.setMode(modeId);
      const key = `${SELECTED_MODE_KEY}.${inst.agentType}`;
      await this.globalState.update(key, modeId);
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to set mode:", error);
    }
  }

  private async handleModelChange(modelId: string): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;
    try {
      await inst.client.setModel(modelId);
      const key = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
      await this.globalState.update(key, modelId);
      this.sendSessionMetadata();
    } catch (error) {
      console.error("[Chat] Failed to set model:", error);
    }
  }

  private async handleConnect(): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;
    try {
      await this.ensureClientConnected(inst);
      if (!inst.hasAcpSession) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        const resp = await inst.client.newSession(workingDir);
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        this.sendSessionMetadata();
      }
    } catch (error) {
      this.postMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to connect",
      });
    }
  }

  private async handleNewChat(): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;

    inst.acpSessionId = null;
    inst.hasAcpSession = false;
    inst.hasRestoredModeModel = false;
    inst.streamingText = "";

    this.postMessage({ type: "chatCleared" });
    this.postMessage({ type: "sessionMetadata", modes: null, models: null });

    try {
      if (inst.client.isConnected()) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workingDir = workspaceFolder?.uri.fsPath || process.cwd();
        const resp = await inst.client.newSession(workingDir);
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        this.sendSessionMetadata();
      }
    } catch (error) {
      console.error("[Chat] Failed to create new session:", error);
    }
  }

  private handleClearChat(): void {
    this.postMessage({ type: "chatCleared" });
  }

  private sendSessionMetadata(): void {
    const inst = this.activeInstance;
    if (!inst) return;
    const metadata = inst.client.getSessionMetadata(inst.acpSessionId ?? undefined);
    const meta = {
      modes: metadata?.modes ?? null,
      models: metadata?.models ?? null,
      commands: metadata?.commands ?? null,
    };
    this.postMessage({ type: "sessionMetadata", ...meta });
    this.onSessionMetadataChanged?.(meta);

    if (!inst.hasRestoredModeModel && inst.hasAcpSession) {
      inst.hasRestoredModeModel = true;
      this.restoreSavedModeAndModel().catch((error) =>
        console.warn("[Chat] Failed to restore saved mode/model:", error),
      );
    }
  }

  private async restoreSavedModeAndModel(): Promise<void> {
    const inst = this.activeInstance;
    if (!inst) return;
    const metadata = inst.client.getSessionMetadata();
    const availableModes = Array.isArray(metadata?.modes?.availableModes) ? metadata.modes.availableModes : [];
    const availableModels = Array.isArray(metadata?.models?.availableModels) ? metadata.models.availableModels : [];

    const modeKey = `${SELECTED_MODE_KEY}.${inst.agentType}`;
    const modelKey = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
    const savedModeId = this.globalState.get<string>(modeKey);
    const savedModelId = this.globalState.get<string>(modelKey);

    let modeRestored = false;
    let modelRestored = false;

    if (savedModeId && availableModes.some((m: any) => m?.id === savedModeId)) {
      await inst.client.setMode(savedModeId);
      modeRestored = true;
    }

    if (savedModelId && availableModels.some((m: any) => m?.modelId === savedModelId)) {
      await inst.client.setModel(savedModelId);
      modelRestored = true;
    }

    if (modeRestored || modelRestored) {
      this.postMessage({ type: "sessionMetadata", ...metadata });
    }
  }

  public postChipToWebview(chip: {
    id: string;
    filePath: string;
    fileName: string;
    languageId: string;
    range?: { startLine: number; endLine: number };
  }): void {
    this.postMessage({ type: "addContextChipFromEditor", chip });
    this.postMessage({ type: "focusChatInput" });
  }

  private postMessage(message: Record<string, unknown>): void {
    this.view?.webview.postMessage(message);
  }

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
