import type { SessionNotification } from "@agentclientprotocol/sdk";
import { getAgent } from "./acp/agents";
import type { PlatformAdapter, PlatformHandlers } from "./adapter";
import {
  agentShortName,
  type InstanceInfo,
  MAX_AGENT_INSTANCES,
  SELECTED_AGENT_KEY,
  SELECTED_MODE_KEY,
  SELECTED_MODEL_KEY,
  type SessionMode,
} from "./constants";
import { AGENT_COLORS } from "./orchestrator/types";
import { processSessionUpdate } from "./session-update";
import { parseStderrPatterns } from "./stderr";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  from: string;
  text: string;
  tools?: Array<{ id: string; name: string; title: string | null; status: string; input: string | null }>;
}

export interface AgentSession {
  key: string;
  agentType: string;
  label: string;
  sessionMode: SessionMode;
  client: ACPClientLike | null;
  acpSessionId: string | null;
  hasAcpSession: boolean;
  hasRestoredModeModel: boolean;
  stderrBuffer: string;
  streamingText: string;
  color: string;
  isStreaming: boolean;
  coreSessionId: string | null;
  coreSessionReady: boolean;
  coreSessionPromise: Promise<void> | null;
  coreSessionLastAttempt: number;
  orchestratorKey?: string;
  messages: ChatMessage[];
  liveTools: Array<{ id: string; name: string; title: string | null; status: string; input: string | null }>;
}

// Minimal ACP client interface the SessionManager depends on.
// Both the host and extension ACPClient satisfy this.
export interface ACPClientLike {
  instanceId: string | null;
  connect(): Promise<unknown>;
  dispose(): void;
  isConnected(): boolean;
  getState(): string;
  getAgentId(): string;
  newSession(workingDir: string): Promise<{ sessionId: string }>;
  setActiveSession(sessionId: string): void;
  sendMessage(
    text: string,
    contextChips?: Array<{ filePath: string; fileName: string; isDirectory?: boolean; range?: unknown }>,
    sessionId?: string,
  ): Promise<{ stopReason: string }>;
  setMode(modeId: string, sessionId?: string): Promise<void>;
  setModel(modelId: string, sessionId?: string): Promise<void>;
  getSessionMetadata(sessionId?: string): { modes?: unknown; models?: unknown; commands?: unknown } | null | undefined;
  setOnStateChange(cb: (state: string) => void): void;
  setOnSessionUpdate(cb: (update: SessionNotification) => void): void;
  setOnStderr(cb: (text: string) => void): void;
  setOnReadTextFile(cb: (params: unknown) => Promise<unknown>): void;
  setOnWriteTextFile(cb: (params: unknown) => Promise<unknown>): void;
  setOnCreateTerminal(cb: (params: unknown) => Promise<unknown>): void;
  setOnTerminalOutput(cb: (params: unknown) => Promise<unknown>): void;
  setOnWaitForTerminalExit(cb: (params: unknown) => Promise<unknown>): void;
  setOnKillTerminalCommand(cb: (params: unknown) => Promise<unknown>): void;
  setOnReleaseTerminal(cb: (params: unknown) => Promise<unknown>): void;
}

export interface SessionManagerConfig {
  adapter: PlatformAdapter;
  handlers: PlatformHandlers;
  createACPClient(agentType: string): ACPClientLike;
  renderMarkdown(text: string): string;

  // Hooks for platform-specific behavior
  onInstanceConnected?(session: AgentSession): void;
  onInstanceDisconnected?(session: AgentSession): void;
  onSessionCreated?(session: AgentSession): void;
  onCoreSession?(session: AgentSession): Promise<void>;
  onGraphUpdate?(): void;
  onStreamingChunk?(rawText: string, instanceKey: string): void;
  onStreamingComplete?(instanceKey: string, response: { label: string; text: string; error?: string }): void;
  onCommandsUpdate?(commands: unknown[], instanceKey: string): void;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export interface SessionManager {
  // Session lifecycle
  createSession(agentType: string, sessionMode: SessionMode, orchestratorKey?: string): AgentSession;
  spawnAgent(agentType: string, sessionMode?: SessionMode): Promise<void>;
  spawnAndSend(
    agentType: string,
    sessionMode: SessionMode,
    text: string,
    contextChips?: Array<{
      filePath: string;
      fileName: string;
      isDirectory?: boolean;
      range?: { startLine: number; endLine: number };
    }>,
  ): Promise<void>;
  closeInstance(instanceKey: string): void;
  switchToInstance(instanceKey: string): void;

  // Messaging
  sendMessage(
    text: string,
    contextChips?: Array<{
      filePath: string;
      fileName: string;
      isDirectory?: boolean;
      range?: { startLine: number; endLine: number };
    }>,
  ): Promise<void>;
  cancel(): Promise<void>;

  // Session config
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  connect(): Promise<void>;
  newChat(): Promise<void>;
  clearChat(): void;
  resetChat(): Promise<void>;

  // Queries
  getActiveSession(): AgentSession | undefined;
  getActiveClient(): ACPClientLike | null;
  getInstanceList(): InstanceInfo[];
  getCurrentInstanceKey(): string | null;
  getSession(key: string): AgentSession | undefined;
  getSessionByAcpId(acpId: string): string | undefined;
  getSessions(): Map<string, AgentSession>;

  // Store a chat message on a session (for orchestration / external callers)
  pushMessage(instanceKey: string, msg: ChatMessage): void;

  // UI sync
  sendInstanceList(): void;
  sendSessionMetadata(sessionKey?: string): void;

  // Custom message handler hook (for orchestration dispatch)
  setMessageInterceptor(fn: ((text: string) => Promise<boolean>) | null): void;

  // Disposal
  dispose(): void;
}

const CONNECT_TIMEOUT_MS = 30_000;

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const { adapter, handlers } = config;
  const send = adapter.send.bind(adapter);

  // Session state
  const sessions = new Map<string, AgentSession>();
  let currentInstanceKey: string | null = null;
  const instanceCounters = new Map<string, number>();
  let nextColorIndex = 0;
  let messageInterceptor: ((text: string) => Promise<boolean>) | null = null;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function getActiveSession(): AgentSession | undefined {
    return currentInstanceKey ? sessions.get(currentInstanceKey) : undefined;
  }

  function getActiveClient(): ACPClientLike | null {
    return getActiveSession()?.client ?? null;
  }

  function getInstanceList(): InstanceInfo[] {
    const list: InstanceInfo[] = [];
    for (const inst of sessions.values()) {
      const skipClient = !!inst.orchestratorKey || inst.sessionMode === "orchestrator";
      list.push({
        key: inst.key,
        label: inst.label,
        agentType: inst.agentType,
        color: inst.color,
        connected: skipClient || (inst.client?.isConnected() ?? false),
        isStreaming: inst.isStreaming,
      });
    }
    return list;
  }

  function sendInstanceList(): void {
    send({
      type: "instanceList",
      instances: getInstanceList(),
      currentInstanceKey,
    });
  }

  function getSessionByAcpId(acpId: string): string | undefined {
    for (const [key, session] of sessions) {
      if (session.acpSessionId === acpId) return key;
    }
    return undefined;
  }

  async function connectWithTimeout(inst: AgentSession): Promise<void> {
    if (!inst.client) throw new Error("No client for this instance");
    if (inst.client.isConnected()) return;
    const result = await Promise.race([
      inst.client.connect().then(() => "ok" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), CONNECT_TIMEOUT_MS)),
    ]);
    if (result === "timeout") {
      try {
        inst.client.dispose();
      } catch {}
      throw new Error(
        `Connection to "${inst.agentType}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s. ` +
          `Check that the agent is installed and working.`,
      );
    }
  }

  function setupClientHandlers(session: AgentSession): void {
    const { client } = session;
    if (!client) return;
    const instanceKey = session.key;

    client.setOnStateChange((state: string) => {
      adapter.log(
        `[SessionManager] Instance "${instanceKey}" (type=${session.agentType}) state -> "${state}" (instanceId=${client.instanceId}, active=${currentInstanceKey})`,
      );

      if (state === "connected") {
        config.onInstanceConnected?.(session);
        if (currentInstanceKey === instanceKey && session.hasAcpSession) {
          sendSessionMetadata(instanceKey);
        }
      }
      if (state === "disconnected") {
        config.onInstanceDisconnected?.(session);
      }

      sendInstanceList();
      if (currentInstanceKey === instanceKey) {
        send({ type: "connectionState", state });
      }
    });

    client.setOnSessionUpdate((update: SessionNotification) => {
      if (currentInstanceKey === instanceKey) {
        handleSessionUpdate(update, instanceKey);
      } else {
        // Background instance - accumulate streaming text
        if (update.update?.sessionUpdate === "agent_message_chunk" && update.update?.content?.type === "text") {
          session.streamingText += update.update.content.text;
        }
      }
    });

    client.setOnStderr((text: string) => {
      session.stderrBuffer += text;
      if (currentInstanceKey === instanceKey) {
        handleStderr(text, instanceKey);
      }
    });

    client.setOnReadTextFile(async (params: any) => handlers.readTextFile(params));
    client.setOnWriteTextFile(async (params: any) => handlers.writeTextFile(params));
    client.setOnCreateTerminal(async (params: any) => handlers.createTerminal(params));
    client.setOnTerminalOutput(async (params: any) => handlers.terminalOutput(params));
    client.setOnWaitForTerminalExit(async (params: any) => handlers.waitForTerminalExit(params));
    client.setOnKillTerminalCommand(async (params: any) => handlers.killTerminalCommand(params));
    client.setOnReleaseTerminal(async (params: any) => handlers.releaseTerminal(params));
  }

  function handleSessionUpdate(notification: SessionNotification, sessionKey: string): void {
    const inst = sessions.get(sessionKey);
    if (!inst) return;
    const isActive = currentInstanceKey === sessionKey;

    const { messages: outMsgs, streamingTextDelta } = processSessionUpdate(notification, {
      streamingText: inst.streamingText,
      isActive,
      instanceId: sessionKey,
    });
    inst.streamingText += streamingTextDelta;
    for (const msg of outMsgs) send(msg);

    // Track tool calls on the session
    for (const msg of outMsgs) {
      if (msg.type === "toolCallStart") {
        inst.liveTools.push({
          id: msg.toolCallId as string,
          name: msg.name as string,
          title: null,
          status: "running",
          input: null,
        });
      } else if (msg.type === "toolCallComplete") {
        const t = inst.liveTools.find((x) => x.id === msg.toolCallId);
        if (t) {
          if (msg.title) t.title = msg.title as string;
          t.status = msg.status as string;
          const raw = msg.rawInput as Record<string, unknown> | undefined;
          if (raw) {
            const path = (raw.path || raw.command || raw.description || "") as string;
            if (path) t.input = path;
          }
        }
      }
    }

    if (streamingTextDelta) {
      config.onStreamingChunk?.(streamingTextDelta, sessionKey);
    }
    if (notification.update?.sessionUpdate === "available_commands_update") {
      config.onCommandsUpdate?.(notification.update.availableCommands, sessionKey);
    }
  }

  function handleStderr(_text: string, instanceKey: string): void {
    const inst = sessions.get(instanceKey);
    if (!inst) return;
    const { event, clearBuffer, truncateBuffer } = parseStderrPatterns(inst.stderrBuffer);
    if (event && currentInstanceKey === instanceKey) {
      send({ type: "agentError", text: event.message });
    }
    if (clearBuffer) inst.stderrBuffer = "";
    if (truncateBuffer) inst.stderrBuffer = inst.stderrBuffer.slice(-5000);
  }

  // -------------------------------------------------------------------------
  // Session CRUD
  // -------------------------------------------------------------------------

  function createSession(agentType: string, sessionMode: SessionMode, orchestratorKey?: string): AgentSession {
    if (sessions.size >= MAX_AGENT_INSTANCES) {
      throw new Error(
        `Maximum number of concurrent agents (${MAX_AGENT_INSTANCES}) reached. Close an existing agent tab before spawning a new one.`,
      );
    }

    const count = (instanceCounters.get(agentType) ?? 0) + 1;
    instanceCounters.set(agentType, count);
    const key = `${agentShortName(agentType)}${count}`;
    const agentCfg = getAgent(agentType);
    const label = `${agentCfg?.name ?? agentType} ${count}`;
    const color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length];
    nextColorIndex++;

    // Per-instance client (null for orchestrator-managed sub-agents AND
    // the orchestrator virtual tab itself which has no ACP agent)
    let client: ACPClientLike | null = null;
    if (!orchestratorKey && sessionMode !== "orchestrator") {
      client = config.createACPClient(agentType);
    }

    const instance: AgentSession = {
      key,
      agentType,
      label,
      sessionMode,
      client,
      acpSessionId: null,
      hasAcpSession: false,
      hasRestoredModeModel: false,
      stderrBuffer: "",
      streamingText: "",
      color,
      isStreaming: false,
      coreSessionId: null,
      coreSessionReady: false,
      coreSessionPromise: null,
      coreSessionLastAttempt: 0,
      orchestratorKey,
      messages: [],
      liveTools: [],
    };

    if (client) {
      setupClientHandlers(instance);
    }

    sessions.set(key, instance);
    config.onSessionCreated?.(instance);
    return instance;
  }

  function switchToInstance(instanceKey: string): void {
    if (instanceKey === currentInstanceKey) return;
    const target = sessions.get(instanceKey);
    if (!target) return;
    const skipClient = !!target.orchestratorKey || target.sessionMode === "orchestrator";

    currentInstanceKey = instanceKey;
    adapter.stateUpdate(SELECTED_AGENT_KEY, target.agentType).catch(() => {});

    send({
      type: "instanceChanged",
      instanceKey,
      isStreaming: target.isStreaming,
    });
    if (target.messages.length > 0) {
      send({
        type: "sessionHistory",
        instanceKey,
        messages: target.messages,
      });
    }
    send({
      type: "connectionState",
      state: skipClient ? "connected" : (target.client?.getState() ?? "disconnected"),
    });
    sendInstanceList();

    if (skipClient) {
      send({ type: "sessionMetadata", modes: null, models: null });
    } else if (target.client?.isConnected() && target.hasAcpSession) {
      sendSessionMetadata(target.key);
    } else {
      send({ type: "sessionMetadata", modes: null, models: null });
    }

    if (!skipClient) {
      config
        .onCoreSession?.(target)
        ?.catch((e: unknown) => adapter.log(`[SessionManager] Failed to initialize core session: ${e}`));
    }
    config.onGraphUpdate?.();
  }

  async function spawnAgent(agentType: string, sessionMode: SessionMode = "single_agent"): Promise<void> {
    let instance: AgentSession;
    try {
      instance = createSession(agentType, sessionMode);
      switchToInstance(instance.key);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn agent";
      send({ type: "error", text: message });
      return;
    }

    try {
      await connectWithTimeout(instance);
      if (!instance.hasAcpSession) {
        const resp = await instance.client!.newSession(adapter.getWorkingDir());
        instance.acpSessionId = resp.sessionId;
        instance.hasAcpSession = true;
        sendInstanceList();
        sendSessionMetadata(instance.key);
      }
      config
        .onCoreSession?.(instance)
        ?.catch((e: unknown) => adapter.log(`[SessionManager] ensureCoreSession failed (non-fatal): ${e}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect";
      send({ type: "error", text: message });
    }
  }

  async function spawnAndSend(
    agentType: string,
    sessionMode: SessionMode,
    text: string,
    contextChips?: Array<{
      filePath: string;
      fileName: string;
      isDirectory?: boolean;
      range?: { startLine: number; endLine: number };
    }>,
  ): Promise<void> {
    try {
      const instance = createSession(agentType, sessionMode);
      switchToInstance(instance.key);
      await connectWithTimeout(instance);
      await sendMessageImpl(text, contextChips);
    } catch (error) {
      adapter.log(`[SessionManager] spawnAndSend error: ${error}`);
      const message = error instanceof Error ? error.message : "Failed to spawn agent";
      send({ type: "error", text: message });
      send({ type: "streamEnd", instanceId: currentInstanceKey, stopReason: "error" });
    }
  }

  function closeInstance(instanceKey: string): void {
    const instance = sessions.get(instanceKey);
    if (!instance) return;

    // Dispose the instance's own client
    if (instance.client) {
      try {
        instance.client.dispose();
      } catch {}
    }

    sessions.delete(instanceKey);

    if (currentInstanceKey === instanceKey) {
      const remaining = Array.from(sessions.keys());
      if (remaining.length > 0) {
        switchToInstance(remaining[remaining.length - 1]);
      } else {
        currentInstanceKey = null;
        instanceCounters.clear();
        nextColorIndex = 0;
        send({
          type: "instanceChanged",
          instanceKey: null,
          isStreaming: false,
        });
      }
    }

    sendInstanceList();
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  async function sendMessageImpl(
    text: string,
    contextChips?: Array<{
      filePath: string;
      fileName: string;
      isDirectory?: boolean;
      range?: { startLine: number; endLine: number };
    }>,
  ): Promise<void> {
    const inst = getActiveSession();
    if (!inst) return;
    if (inst.orchestratorKey) {
      send({ type: "error", text: "This agent is managed by the orchestrator." });
      return;
    }
    if (!inst.client) return;
    if (inst.isStreaming) {
      send({ type: "error", text: "Agent is still processing a message." });
      return;
    }

    const chipNames = contextChips?.map((c) => {
      const name = c.fileName;
      if (c.isDirectory) return `${name}/`;
      return c.range ? `${name}:${c.range.startLine}-${c.range.endLine}` : name;
    });
    inst.messages.push({ from: "user", text });
    send({
      type: "userMessage",
      text,
      instanceId: inst.key,
      contextChipNames: chipNames,
    });

    try {
      if (!inst.client.isConnected()) {
        await connectWithTimeout(inst);
      }

      if (!inst.hasAcpSession) {
        const resp = await inst.client.newSession(adapter.getWorkingDir());
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        sendSessionMetadata(inst.key);
      } else if (inst.acpSessionId) {
        inst.client.setActiveSession(inst.acpSessionId);
      }

      config
        .onCoreSession?.(inst)
        ?.catch((e: unknown) => adapter.log(`[SessionManager] ensureCoreSession failed (non-fatal): ${e}`));

      inst.streamingText = "";
      inst.stderrBuffer = "";
      inst.isStreaming = true;
      send({ type: "streamStart", instanceId: inst.key });

      const chipData = contextChips?.map((c) => ({
        filePath: c.filePath,
        fileName: c.fileName,
        isDirectory: c.isDirectory,
        range: c.range,
      }));
      const response = await inst.client.sendMessage(text, chipData, inst.acpSessionId ?? undefined);

      inst.isStreaming = false;
      const tools = inst.liveTools.length ? [...inst.liveTools] : undefined;
      inst.liveTools = [];
      if (inst.streamingText.length === 0) {
        inst.messages.push({ from: "agent", text: "Agent returned no response.", tools });
        send({ type: "error", text: "Agent returned no response." });
        send({ type: "streamEnd", stopReason: "error", html: "", instanceId: inst.key });
        config.onStreamingComplete?.(inst.key, { label: inst.label, text: "", error: "Agent returned no response." });
      } else {
        const fullText = inst.streamingText;
        inst.messages.push({ from: "agent", text: fullText, tools });
        const renderedHtml = config.renderMarkdown(fullText);
        send({
          type: "streamEnd",
          instanceId: inst.key,
          stopReason: response.stopReason,
          html: renderedHtml,
        });
        config.onStreamingComplete?.(inst.key, { label: inst.label, text: fullText });
      }
      inst.streamingText = "";
    } catch (error) {
      inst.isStreaming = false;
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      const tools = inst.liveTools.length ? [...inst.liveTools] : undefined;
      inst.liveTools = [];
      inst.messages.push({ from: "agent", text: `Error: ${errorMessage}`, tools });
      send({ type: "error", text: `Error: ${errorMessage}` });
      send({ type: "streamEnd", stopReason: "error", html: "", instanceId: inst.key });
      config.onStreamingComplete?.(inst.key, { label: inst.label, text: "", error: errorMessage });
      inst.streamingText = "";
      inst.stderrBuffer = "";
    }
  }

  async function sendMessage(
    text: string,
    contextChips?: Array<{
      filePath: string;
      fileName: string;
      isDirectory?: boolean;
      range?: { startLine: number; endLine: number };
    }>,
  ): Promise<void> {
    if (messageInterceptor) {
      const handled = await messageInterceptor(text);
      if (handled) return;
    }
    return sendMessageImpl(text, contextChips);
  }

  async function cancel(): Promise<void> {
    const inst = getActiveSession();
    if (!inst?.client) return;
    try {
      await (inst.client as any).cancel?.(inst.acpSessionId ?? undefined);
    } catch (error) {
      adapter.log(`[SessionManager] Cancel failed: ${error}`);
    }
  }

  // -------------------------------------------------------------------------
  // Mode/Model/Connection
  // -------------------------------------------------------------------------

  async function setMode(modeId: string): Promise<void> {
    const inst = getActiveSession();
    if (!inst?.client) return;
    try {
      await inst.client.setMode(modeId, inst.acpSessionId ?? undefined);
      const key = `${SELECTED_MODE_KEY}.${inst.agentType}`;
      await adapter.stateUpdate(key, modeId);
      sendSessionMetadata(inst.key);
    } catch (error) {
      adapter.log(`[SessionManager] Failed to set mode: ${error}`);
    }
  }

  async function setModel(modelId: string): Promise<void> {
    const inst = getActiveSession();
    if (!inst?.client) return;
    try {
      await inst.client.setModel(modelId, inst.acpSessionId ?? undefined);
      const key = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
      await adapter.stateUpdate(key, modelId);
      sendSessionMetadata(inst.key);
    } catch (error) {
      adapter.log(`[SessionManager] Failed to set model: ${error}`);
    }
  }

  async function connectActive(): Promise<void> {
    const inst = getActiveSession();
    if (!inst?.client) return;
    try {
      if (!inst.client.isConnected()) {
        await connectWithTimeout(inst);
      }
      if (!inst.hasAcpSession) {
        const resp = await inst.client.newSession(adapter.getWorkingDir());
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        sendSessionMetadata(inst.key);
      }
      await config.onCoreSession?.(inst);
    } catch (error) {
      send({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to connect",
      });
    }
  }

  async function newChat(): Promise<void> {
    return resetChat();
  }

  function clearChat(): void {
    send({ type: "chatCleared" });
  }

  async function resetChat(): Promise<void> {
    const inst = getActiveSession();
    if (!inst) return;
    inst.acpSessionId = null;
    inst.hasAcpSession = false;
    inst.hasRestoredModeModel = false;
    inst.streamingText = "";
    inst.messages = [];
    inst.liveTools = [];
    send({ type: "chatCleared" });
    send({ type: "sessionMetadata", modes: null, models: null });
    if (inst.client?.isConnected()) {
      try {
        const resp = await inst.client.newSession(adapter.getWorkingDir());
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        sendSessionMetadata(inst.key);
      } catch (e) {
        adapter.log(`[SessionManager] Failed to reset session: ${e}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  function sendSessionMetadata(sessionKey?: string): void {
    const inst = sessionKey ? sessions.get(sessionKey) : getActiveSession();
    if (!inst?.client) return;
    const metadata = inst.client.getSessionMetadata(inst.acpSessionId ?? undefined);
    send({
      type: "sessionMetadata",
      modes: metadata?.modes ?? null,
      models: metadata?.models ?? null,
      commands: metadata?.commands ?? null,
    });

    if (!inst.hasRestoredModeModel && inst.hasAcpSession) {
      inst.hasRestoredModeModel = true;
      restoreSavedModeAndModel(inst).catch((error: unknown) =>
        adapter.log(`[SessionManager] Failed to restore saved mode/model: ${error}`),
      );
    }
  }

  async function restoreSavedModeAndModel(inst: AgentSession): Promise<void> {
    if (!inst.client) return;
    const metadata = inst.client.getSessionMetadata(inst.acpSessionId ?? undefined);
    const availableModes = Array.isArray((metadata?.modes as any)?.availableModes)
      ? (metadata!.modes as any).availableModes
      : [];
    const availableModels = Array.isArray((metadata?.models as any)?.availableModels)
      ? (metadata!.models as any).availableModels
      : [];

    const modeKey = `${SELECTED_MODE_KEY}.${inst.agentType}`;
    const modelKey = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
    const savedModeId = adapter.stateGet<string>(modeKey);
    const savedModelId = adapter.stateGet<string>(modelKey);

    let modeRestored = false;
    let modelRestored = false;

    if (savedModeId && availableModes.some((m: any) => m?.id === savedModeId)) {
      await inst.client.setMode(savedModeId, inst.acpSessionId ?? undefined);
      modeRestored = true;
    }

    if (savedModelId && availableModels.some((m: any) => m?.modelId === savedModelId)) {
      await inst.client.setModel(savedModelId, inst.acpSessionId ?? undefined);
      modelRestored = true;
    }

    if (modeRestored || modelRestored) {
      send({ type: "sessionMetadata", ...metadata });
    }
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  function dispose(): void {
    for (const session of sessions.values()) {
      if (session.client) {
        try {
          session.client.dispose();
        } catch {}
      }
    }
    sessions.clear();
    currentInstanceKey = null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    createSession,
    spawnAgent,
    spawnAndSend,
    closeInstance,
    switchToInstance,
    sendMessage,
    cancel,
    setMode,
    setModel,
    connect: connectActive,
    newChat,
    resetChat,
    clearChat,
    getActiveSession,
    getActiveClient,
    getInstanceList,
    getCurrentInstanceKey: () => currentInstanceKey,
    getSession: (key: string) => sessions.get(key),
    getSessionByAcpId,
    getSessions: () => sessions,
    pushMessage: (instanceKey: string, msg: ChatMessage) => {
      const inst = sessions.get(instanceKey);
      if (inst) inst.messages.push(msg);
    },
    sendInstanceList,
    sendSessionMetadata,
    setMessageInterceptor: (fn) => {
      messageInterceptor = fn;
    },
    dispose,
  };
}
