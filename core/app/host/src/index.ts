/**
 * eisen-host — Standalone host binary entry point.
 *
 * Reads JSON commands from stdin (one per line), writes JSON events to
 * stdout (one per line). Manages ACP agent instances, the orchestrator,
 * and TCP graph telemetry.
 *
 * Usage: eisen-host --cwd <directory>
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { marked } from "marked";
import {
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalCommandRequest,
  type KillTerminalCommandResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import * as fs from "node:fs";

import { setCwd, getCwd, StateStore as Memento } from "./env";
import { findFiles } from "./file-search";
import { getAgent, getAgentsWithStatus, ensureAgentStatusLoaded } from "./acp/agents";
import { ACPClient, type ContextChipData } from "./acp/client";
import { CoreClient } from "./core-client";
import { EisenOrchestrator, AGENT_COLORS } from "./orchestrator";
import { FileSearchService } from "./file-search-service";
import {
  orchestrate,
  executeAndEvaluate,
  createAgents,
  CostTracker,
  type OrchestrationConfig,
  type AgentAssignment,
  type PendingApprovalData,
  type WorkspaceContext,
  type OrchestrationOutput,
  type OrchestratorAgents,
} from "./workflow";

marked.setOptions({ breaks: true, gfm: true });

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseCwd(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return process.cwd();
}

const cwd = parseCwd();
setCwd(cwd);

// Load .env from the workspace directory so API keys (OPENAI_API_KEY etc.)
// are available to Mastra agents without requiring them in the system env.
try {
  const envPath = `${cwd}/.env`;
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
    console.error(`[eisen-host] Loaded .env from ${envPath}`);
  }
} catch (e) {
  console.error("[eisen-host] Failed to load .env:", e);
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const globalState = new Memento();
const orchestrator = new EisenOrchestrator();
const useLegacyGraph = false;
const fileSearchService = new FileSearchService(cwd);

const SELECTED_AGENT_KEY = "eisen.selectedAgent";
const SELECTED_MODE_KEY = "eisen.selectedMode";
const SELECTED_MODEL_KEY = "eisen.selectedModel";

const MAX_AGENT_INSTANCES = 10;

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

// ---------------------------------------------------------------------------
// Agents + sessions
// ---------------------------------------------------------------------------

type SessionMode = "single_agent" | "orchestrator";

interface ProviderClient {
  agentType: string;
  client: ACPClient;
  instanceId: string | null;
  connected: boolean;
  core: CoreClient | null;
}

interface AgentSession {
  key: string;
  agentType: string;
  label: string;
  sessionMode: SessionMode;
  /** Null until the first message is sent and newSession() completes. */
  acpSessionId: string | null;
  hasAcpSession: boolean;
  coreSessionId: string | null;
  hasRestoredModeModel: boolean;
  stderrBuffer: string;
  streamingText: string;
  color: string;
  isStreaming: boolean;
  /** True once the eisen-core session RPC has succeeded for this instance */
  coreSessionReady: boolean;
  /** In-flight promise for ensureCoreSession to prevent concurrent calls */
  coreSessionPromise: Promise<void> | null;
  /** Timestamp of last ensureCoreSession attempt, for backoff */
  coreSessionLastAttempt: number;
  /** Key of the orchestrator virtual instance that spawned this sub-agent, if any */
  orchestratorKey?: string;
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

const providerClients = new Map<string, ProviderClient>();
const agentSessions = new Map<string, AgentSession>();
const sessionByAcpId = new Map<string, string>();
let currentInstanceKey: string | null = null;
const instanceCounters = new Map<string, number>();
let nextColorIndex = 0;
const terminals = new Map<string, ManagedTerminal>();
let terminalCounter = 0;

function getActiveSession(): AgentSession | undefined {
  return currentInstanceKey ? agentSessions.get(currentInstanceKey) : undefined;
}

function getProviderForSession(session: AgentSession): ProviderClient | undefined {
  return providerClients.get(session.agentType);
}

function getActiveProvider(): ProviderClient | null {
  const session = getActiveSession();
  if (!session) return null;
  return providerClients.get(session.agentType) ?? null;
}

// ---------------------------------------------------------------------------
// Instance management
// ---------------------------------------------------------------------------

interface InstanceInfo {
  key: string;
  label: string;
  agentType: string;
  color: string;
  connected: boolean;
  isStreaming: boolean;
}

function getInstanceList(): InstanceInfo[] {
  const list: InstanceInfo[] = [];
  for (const inst of agentSessions.values()) {
    const provider = providerClients.get(inst.agentType);
    list.push({
      key: inst.key,
      label: inst.label,
      agentType: inst.agentType,
      color: inst.color,
      connected: provider?.connected ?? false,
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

function setupClientHandlers(provider: ProviderClient): void {
  const { client } = provider;

  client.setOnStateChange((state) => {
    console.error(
      `[Host] Provider "${provider.agentType}" state -> "${state}" (instanceId=${client.instanceId}, active=${currentInstanceKey})`,
    );

    if (state === "connected") {
      provider.connected = true;
      provider.instanceId = client.instanceId;
      if (currentInstanceKey) {
        const active = agentSessions.get(currentInstanceKey);
        if (active && active.agentType === provider.agentType) {
          sendSessionMetadata(active.key);
        }
      }
    }
    if (state === "disconnected") {
      provider.connected = false;
      provider.instanceId = null;
    }

    sendInstanceList();
    if (currentInstanceKey) {
      const active = agentSessions.get(currentInstanceKey);
      if (active && active.agentType === provider.agentType) {
        send({ type: "connectionState", state });
      }
    }
  });

  client.setOnSessionUpdate((update: SessionNotification) => {
    const sessionId = update.sessionId ?? client.getActiveSessionId();
    if (!sessionId) return;
    const sessionKey = sessionByAcpId.get(sessionId);
    if (!sessionKey) return;
    handleSessionUpdate(update, sessionKey);
  });

  client.setOnStderr((text: string) => {
    const active = getActiveSession();
    if (active && active.agentType === provider.agentType) {
      active.stderrBuffer += text;
      handleStderr(text, active.key);
    }
  });

  client.setOnReadTextFile(async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
    return handleReadTextFile(params);
  });

  client.setOnWriteTextFile(async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
    return handleWriteTextFile(params);
  });

  client.setOnCreateTerminal(async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
    return handleCreateTerminal(params);
  });

  client.setOnTerminalOutput(async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
    return handleTerminalOutput(params);
  });

  client.setOnWaitForTerminalExit(async (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
    return handleWaitForTerminalExit(params);
  });

  client.setOnKillTerminalCommand(async (params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> => {
    return handleKillTerminalCommand(params);
  });

  client.setOnReleaseTerminal(async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
    return handleReleaseTerminal(params);
  });
}

function getOrCreateProvider(agentType: string): ProviderClient {
  const existing = providerClients.get(agentType);
  if (existing) return existing;

  const agent = getAgent(agentType);
  if (!agent) {
    throw new Error(`Unknown agent: ${agentType}`);
  }

  const hostDir = process.execPath;
  const client = new ACPClient({
    agentConfig: agent,
    hostDir: hostDir,
  });

  const provider: ProviderClient = {
    agentType,
    client,
    instanceId: null,
    connected: false,
    core: null,
  };

  setupClientHandlers(provider);
  providerClients.set(agentType, provider);
  return provider;
}

function createSession(agentType: string, sessionMode: SessionMode, orchestratorKey?: string): AgentSession {
  if (agentSessions.size >= MAX_AGENT_INSTANCES) {
    throw new Error(
      `Maximum number of concurrent agents (${MAX_AGENT_INSTANCES}) reached. ` +
        `Close an existing agent tab before spawning a new one.`,
    );
  }

  // Create the provider eagerly so its process starts and state-change handlers
  // are wired up, but do NOT connect yet — connection is deferred to first send.
  getOrCreateProvider(agentType);

  const count = (instanceCounters.get(agentType) ?? 0) + 1;
  instanceCounters.set(agentType, count);
  const key = `${agentShortName(agentType)}${count}`;
  const color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length];
  nextColorIndex++;

  const instance: AgentSession = {
    key,
    agentType,
    label: key,
    sessionMode,
    acpSessionId: null,
    hasAcpSession: false,
    coreSessionId: null,
    hasRestoredModeModel: false,
    stderrBuffer: "",
    streamingText: "",
    color,
    isStreaming: false,
    coreSessionReady: false,
    coreSessionPromise: null,
    coreSessionLastAttempt: 0,
    orchestratorKey,
  };

  agentSessions.set(key, instance);
  return instance;
}

function normalizeAction(action?: string): "read" | "write" | "search" {
  if (action === "write") return "write";
  if (action === "search") return "search";
  return "read";
}

function toMergedSnapshot(msg: any) {
  const nodes: Record<string, any> = {};
  if (msg?.nodes && typeof msg.nodes === "object") {
    for (const [path, node] of Object.entries<any>(msg.nodes)) {
      const action = normalizeAction(node?.last_action);
      nodes[path] = {
        inContext: Boolean(node?.in_context),
        changed: action === "write",
        lastAction: action,
      };
    }
  }
  return {
    type: "mergedSnapshot",
    seq: msg?.seq ?? 0,
    nodes,
    calls: [],
    agents: [],
  };
}

function toMergedDelta(msg: any) {
  const updates: Array<Record<string, any>> = [];
  if (Array.isArray(msg?.updates)) {
    for (const u of msg.updates) {
      const action = normalizeAction(u?.last_action);
      updates.push({
        id: u?.path,
        action,
        inContext: u?.in_context,
        changed: action === "write",
      });
    }
  }
  if (Array.isArray(msg?.removed)) {
    for (const path of msg.removed) {
      updates.push({ id: path, action: "remove" });
    }
  }
  return {
    type: "mergedDelta",
    seq: msg?.seq ?? 0,
    updates,
    agents: [],
  };
}


function updateGraphSelection(): void {
  const active = getActiveSession();
  if (!active) return;
  const provider = providerClients.get(active.agentType);
  if (!provider?.core || !active.coreSessionId) return;
  provider.core.setStreamFilter({ sessionId: active.coreSessionId });
  provider.core.requestSnapshot(active.coreSessionId);
}

async function ensureCoreClient(provider: ProviderClient): Promise<CoreClient | null> {
  if (provider.core) return provider.core;
  let port: number;
  try {
    port = await provider.client.waitForTcpPort();
  } catch {
    return null;
  }
  const core = new CoreClient((msg) => {
    const active = getActiveSession();
    if (!active) return;
    if (active.agentType !== provider.agentType) return;
    if (!active.coreSessionId || msg?.session_id !== active.coreSessionId) return;

    if (msg?.type === "snapshot") {
      send(toMergedSnapshot(msg));
    } else if (msg?.type === "delta") {
      send(toMergedDelta(msg));
    } else if (msg?.type === "usage") {
      send({ type: "usageUpdate", used: msg.used, size: msg.size, cost: msg.cost });
    }
  });
  core.connect(port);
  provider.core = core;
  return core;
}

async function ensureCoreSession(session: AgentSession): Promise<void> {
  const provider = providerClients.get(session.agentType);
  if (!provider) return;
  if (!provider.client.isConnected()) {
    await provider.client.connect();
  }
  const core = await ensureCoreClient(provider);
  if (!core) return;

  const agentId = provider.client.instanceId;
  if (!agentId) return;

  if (session.sessionMode === "single_agent") {
    session.coreSessionId = session.acpSessionId;
  }

  if (!session.coreSessionId) {
    session.coreSessionId = `${agentId}-${Date.now().toString(36)}`;
  }

  const created = await core.rpc("create_session", {
    agent_id: agentId,
    session_id: session.coreSessionId,
    mode: session.sessionMode,
  });
  session.coreSessionId = created?.session_id ?? session.coreSessionId;

  if (session.sessionMode === "orchestrator") {
    await core.rpc("set_orchestrator_providers", {
      agent_id: agentId,
      session_id: session.coreSessionId,
      providers: [{ agent_id: agentId, session_id: session.acpSessionId }],
    });
  }

  await core.rpc("set_active_session", { agent_id: agentId, session_id: session.coreSessionId });

  if (currentInstanceKey === session.key && session.coreSessionId) {
    core.setStreamFilter({ sessionId: session.coreSessionId });
    core.requestSnapshot(session.coreSessionId);
  }
}

// ---------------------------------------------------------------------------
// Orchestrator wiring
// ---------------------------------------------------------------------------

orchestrator.onMergedSnapshot = (snapshot) => {
  if (useLegacyGraph) {
    send({ type: "mergedSnapshot", ...snapshot });
  }
};

orchestrator.onMergedDelta = (delta) => {
  if (useLegacyGraph) {
    send({ type: "mergedDelta", ...delta });
  }
};

orchestrator.onAgentUpdate = (agents) => {
  if (useLegacyGraph) {
    send({ type: "agentUpdate", agents });
  }
};

async function registerAgentWithOrchestrator(client: ACPClient): Promise<void> {
  const agentType = client.getAgentId();
  try {
    const port = await client.waitForTcpPort();
    const instanceId = client.instanceId;
    if (instanceId && agentType) {
      orchestrator.addAgent(instanceId, port, agentType);
    }
  } catch (e) {
    console.error(`[Host] Failed to register agent "${agentType}" with orchestrator:`, e);
  }
}


// ---------------------------------------------------------------------------
// Session update handler
// ---------------------------------------------------------------------------

function handleSessionUpdate(notification: SessionNotification, sessionKey: string): void {
  const update = notification.update;
  const inst = agentSessions.get(sessionKey);
  if (!inst) return;
  const isActive = currentInstanceKey === sessionKey;

  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      inst.streamingText += update.content.text;
      if (isActive) {
        send({ type: "streamChunk", text: update.content.text, instanceId: sessionKey });
      }
    }
  } else if (update.sessionUpdate === "tool_call") {
    if (isActive) {
      send({
        type: "toolCallStart",
        name: update.title,
        toolCallId: update.toolCallId,
        kind: update.kind,
      });
    }
  } else if (update.sessionUpdate === "tool_call_update") {
    if (isActive && (update.status === "completed" || update.status === "failed")) {
      let terminalOutput: string | undefined;
      if (update.content && update.content.length > 0) {
        const terminalContent = update.content.find((c: { type: string }) => c.type === "terminal");
        if (terminalContent && "terminalId" in terminalContent) {
          terminalOutput = `[Terminal: ${String(terminalContent.terminalId)}]`;
        }
      }
      send({
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
    if (isActive) {
      send({ type: "modeUpdate", modeId: update.currentModeId });
    }
  } else if (update.sessionUpdate === "available_commands_update") {
    if (isActive) {
      send({
        type: "availableCommands",
        commands: update.availableCommands,
      });
    }
  } else if (update.sessionUpdate === "plan") {
    if (isActive) {
      send({ type: "plan", plan: { entries: update.entries } });
    }
  } else if (update.sessionUpdate === "agent_thought_chunk") {
    if (isActive && update.content?.type === "text") {
      send({ type: "thoughtChunk", text: update.content.text });
    }
  } else if (update.sessionUpdate === "usage_update") {
    if (isActive) {
      send({
        type: "usageUpdate",
        used: update.used,
        size: update.size,
        cost: update.cost,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Stderr handler
// ---------------------------------------------------------------------------

function handleStderr(_text: string, instanceKey: string): void {
  const inst = agentSessions.get(instanceKey);
  if (!inst) return;

  // Check for rate limit errors
  const rateLimitMatch = inst.stderrBuffer.match(/rate_limit_exceeded|Rate limit reached/i);
  if (rateLimitMatch) {
    // Extract retry time if available
    const retryMatch = inst.stderrBuffer.match(/try again in (\d+)s/i);
    const retryTime = retryMatch ? retryMatch[1] : "a few";
    const message = `Rate limit exceeded. Please wait ${retryTime} seconds before sending another message.`;

    if (currentInstanceKey === instanceKey) {
      send({ type: "agentError", text: message });
    }
    inst.stderrBuffer = "";
    return;
  }

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
    if (currentInstanceKey === instanceKey) {
      send({ type: "agentError", text: message });
    }
    inst.stderrBuffer = "";
  }
  if (inst.stderrBuffer.length > 10000) {
    inst.stderrBuffer = inst.stderrBuffer.slice(-5000);
  }
}

// ---------------------------------------------------------------------------
// File I/O handlers
// ---------------------------------------------------------------------------

async function handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  try {
    let content = await fs.promises.readFile(params.path, "utf-8");
    if (params.line !== undefined || params.limit !== undefined) {
      const lines = content.split("\n");
      const startLine = params.line ?? 0;
      const lineLimit = params.limit ?? lines.length;
      content = lines.slice(startLine, startLine + lineLimit).join("\n");
    }
    return { content };
  } catch (error) {
    console.error("[Host] Failed to read file:", error);
    throw error;
  }
}

async function handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  try {
    await fs.promises.writeFile(params.path, params.content);
    return {};
  } catch (error) {
    console.error("[Host] Failed to write file:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Terminal handlers
// ---------------------------------------------------------------------------

function appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
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

async function handleCreateTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
  const terminalId = `term-${++terminalCounter}-${Date.now()}`;
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

  const termCwd =
    params.cwd && params.cwd.trim() !== "" ? params.cwd : getCwd();

  const useShell = !params.args || params.args.length === 0;
  const proc = spawn(params.command, params.args || [], {
    cwd: termCwd,
    env: {
      ...process.env,
      ...(params.env?.reduce(
        (acc: Record<string, string>, e: { name: string; value: string }) => ({
          ...acc,
          [e.name]: e.value,
        }),
        {},
      ) || {}),
    },
    shell: useShell,
  });

  managedTerminal.proc = proc;

  proc.stdout?.on("data", (data: Buffer) => {
    appendTerminalOutput(managedTerminal, data.toString());
  });

  proc.stderr?.on("data", (data: Buffer) => {
    appendTerminalOutput(managedTerminal, data.toString());
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

  terminals.set(terminalId, managedTerminal);
  return { terminalId };
}

async function handleTerminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
  const terminal = terminals.get(params.terminalId);
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

async function handleWaitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
  const terminal = terminals.get(params.terminalId);
  if (!terminal) {
    throw new Error(`Terminal not found: ${params.terminalId}`);
  }
  await terminal.exitPromise;
  return {
    exitCode: terminal.exitCode,
    ...(terminal.signal !== null && { signal: terminal.signal }),
  };
}

async function handleKillTerminalCommand(params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> {
  const terminal = terminals.get(params.terminalId);
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

async function handleReleaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
  const terminal = terminals.get(params.terminalId);
  if (!terminal) return {};
  if (terminal.proc && !terminal.proc.killed) {
    try {
      terminal.proc.kill();
    } catch {}
  }
  terminals.delete(params.terminalId);
  return {};
}

// ---------------------------------------------------------------------------
// Instance switching
// ---------------------------------------------------------------------------

function switchToInstance(instanceKey: string): void {
  if (instanceKey === currentInstanceKey) return;
  const target = agentSessions.get(instanceKey);
  if (!target) return;
  const provider = providerClients.get(target.agentType);

  currentInstanceKey = instanceKey;
  globalState.update(SELECTED_AGENT_KEY, target.agentType);

  if (provider && target.acpSessionId && target.hasAcpSession) {
    try {
      provider.client.setActiveSession(target.acpSessionId);
    } catch {}
  }

  send({
    type: "instanceChanged",
    instanceKey,
    isStreaming: target.isStreaming,
  });
  send({
    type: "connectionState",
    state: provider?.client.getState() ?? "disconnected",
  });
  sendInstanceList();

  if (provider?.client.isConnected() && target.hasAcpSession) {
    sendSessionMetadata(target.key);
  } else {
    send({ type: "sessionMetadata", modes: null, models: null });
  }

  updateGraphSelection();
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function handleSpawnAgent(agentType: string, sessionMode: SessionMode = "single_agent"): void {
  let instance: AgentSession;
  try {
    instance = createSession(agentType, sessionMode);
    switchToInstance(instance.key);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to spawn agent";
    send({ type: "error", text: message });
    return;
  }

  // Eagerly connect in the background so the session is ready by the time
  // the user types their first message.
  const provider = getOrCreateProvider(agentType);
  (async () => {
    try {
      if (!provider.client.isConnected()) {
        await provider.client.connect();
      }
      if (!instance.hasAcpSession) {
        const resp = await provider.client.newSession(getCwd());
        instance.acpSessionId = resp.sessionId;
        instance.hasAcpSession = true;
        sessionByAcpId.set(instance.acpSessionId, instance.key);
        sendInstanceList();
        sendSessionMetadata(instance.key);
      }
      ensureCoreSession(instance).catch((e) =>
        console.error("[Host] ensureCoreSession failed (non-fatal):", e),
      );
    } catch (e) {
      console.error("[Host] Background connect failed:", e);
    }
  })();
}

function handleCloseInstance(instanceKey: string): void {
  const instance = agentSessions.get(instanceKey);
  if (!instance) return;

  const provider = providerClients.get(instance.agentType);
  if (provider?.core && provider.instanceId && instance.coreSessionId) {
    provider.core
      .rpc("close_session", {
        agent_id: provider.instanceId,
        session_id: instance.coreSessionId,
      })
      .catch(() => {});
  }

  if (instance.acpSessionId) sessionByAcpId.delete(instance.acpSessionId);

  agentSessions.delete(instanceKey);

  if (currentInstanceKey === instanceKey) {
    const remaining = Array.from(agentSessions.keys());
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

  if (provider) {
    const stillOpen = Array.from(agentSessions.values()).some((s) => s.agentType === provider.agentType);
    if (!stillOpen) {
      try {
        provider.client.dispose();
      } catch {}
      provider.core?.disconnect();
      providerClients.delete(provider.agentType);
    }
  }

  sendInstanceList();
}

async function handleUserMessage(
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
  const provider = providerClients.get(inst.agentType);
  if (!provider) return;

  const chipNames = contextChips?.map((c) => {
    const name = c.fileName;
    if (c.isDirectory) return `${name}/`;
    return c.range ? `${name}:${c.range.startLine}-${c.range.endLine}` : name;
  });
  send({
    type: "userMessage",
    text,
    contextChipNames: chipNames,
  });

  try {
    if (!provider.client.isConnected()) {
      await provider.client.connect();
    }

    if (!inst.hasAcpSession) {
      const resp = await provider.client.newSession(getCwd());
      inst.acpSessionId = resp.sessionId;
      inst.hasAcpSession = true;
      sessionByAcpId.set(inst.acpSessionId, inst.key);
      sendSessionMetadata(inst.key);
    } else if (inst.acpSessionId) {
      provider.client.setActiveSession(inst.acpSessionId);
    }

    ensureCoreSession(inst).catch((e) =>
      console.error("[Host] ensureCoreSession failed (non-fatal):", e),
    );

    inst.streamingText = "";
    inst.stderrBuffer = "";
    inst.isStreaming = true;
    send({ type: "streamStart", instanceId: inst.key });

    const chipData: ContextChipData[] | undefined = contextChips?.map((c) => ({
      filePath: c.filePath,
      fileName: c.fileName,
      isDirectory: c.isDirectory,
      range: c.range,
    }));
    const response = await provider.client.sendMessage(text, chipData, inst.acpSessionId ?? undefined);

    inst.isStreaming = false;
    if (inst.streamingText.length === 0) {
      send({ type: "error", text: "Agent returned no response." });
      send({ type: "streamEnd", stopReason: "error", html: "", instanceId: inst.key });
    } else {
      const renderedHtml = marked.parse(inst.streamingText) as string;
      send({
        type: "streamEnd",
        instanceId: inst.key,
        stopReason: response.stopReason,
        html: renderedHtml,
      });
    }
    inst.streamingText = "";
  } catch (error) {
    inst.isStreaming = false;
    const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
    send({ type: "error", text: `Error: ${errorMessage}` });
    send({ type: "streamEnd", stopReason: "error", html: "", instanceId: inst.key });
    inst.streamingText = "";
    inst.stderrBuffer = "";
  }
}

async function handleModeChange(modeId: string): Promise<void> {
  const inst = getActiveSession();
  if (!inst) return;
  const provider = providerClients.get(inst.agentType);
  if (!provider) return;
  try {
    await provider.client.setMode(modeId, inst.acpSessionId ?? undefined);
    const key = `${SELECTED_MODE_KEY}.${inst.agentType}`;
    await globalState.update(key, modeId);
    sendSessionMetadata(inst.key);
  } catch (error) {
    console.error("[Host] Failed to set mode:", error);
  }
}

async function handleModelChange(modelId: string): Promise<void> {
  const inst = getActiveSession();
  if (!inst) return;
  const provider = providerClients.get(inst.agentType);
  if (!provider) return;
  try {
    await provider.client.setModel(modelId, inst.acpSessionId ?? undefined);
    const key = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
    await globalState.update(key, modelId);
    sendSessionMetadata(inst.key);
  } catch (error) {
    console.error("[Host] Failed to set model:", error);
  }
}

async function handleConnect(): Promise<void> {
  const inst = getActiveSession();
  if (!inst) return;
  const provider = providerClients.get(inst.agentType);
  if (!provider) return;
  try {
    if (!provider.client.isConnected()) {
      await provider.client.connect();
    }
    await ensureCoreSession(inst);
  } catch (error) {
    send({
      type: "error",
      text: error instanceof Error ? error.message : "Failed to connect",
    });
  }
}

async function handleNewChat(): Promise<void> {
  const inst = getActiveSession();
  if (!inst) return;
  try {
    const next = await createSession(inst.agentType, inst.sessionMode);
    switchToInstance(next.key);
    await ensureCoreSession(next);
  } catch (error) {
    console.error("[Host] Failed to create new session:", error);
  }
}

function handleClearChat(): void {
  send({ type: "chatCleared" });
}

function sendSessionMetadata(sessionKey?: string): void {
  const inst = sessionKey ? agentSessions.get(sessionKey) : getActiveSession();
  if (!inst) return;
  const provider = providerClients.get(inst.agentType);
  if (!provider) return;
  const metadata = provider.client.getSessionMetadata(inst.acpSessionId ?? undefined);
  send({
    type: "sessionMetadata",
    modes: metadata?.modes ?? null,
    models: metadata?.models ?? null,
    commands: metadata?.commands ?? null,
  });

  if (!inst.hasRestoredModeModel) {
    inst.hasRestoredModeModel = true;
    restoreSavedModeAndModel(inst).catch((error) =>
      console.warn("[Host] Failed to restore saved mode/model:", error),
    );
  }
}

async function restoreSavedModeAndModel(inst: AgentSession): Promise<void> {
  const provider = providerClients.get(inst.agentType);
  if (!provider) return;
  const metadata = provider.client.getSessionMetadata(inst.acpSessionId ?? undefined);
  const availableModes = Array.isArray(metadata?.modes?.availableModes) ? metadata!.modes!.availableModes : [];
  const availableModels = Array.isArray(metadata?.models?.availableModels) ? metadata!.models!.availableModels : [];

  const modeKey = `${SELECTED_MODE_KEY}.${inst.agentType}`;
  const modelKey = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
  const savedModeId = globalState.get<string>(modeKey);
  const savedModelId = globalState.get<string>(modelKey);

  let modeRestored = false;
  let modelRestored = false;

  if (savedModeId && availableModes.some((m: any) => m?.id === savedModeId)) {
    await provider.client.setMode(savedModeId, inst.acpSessionId ?? undefined);
    modeRestored = true;
  }

  if (savedModelId && availableModels.some((m: any) => m?.modelId === savedModelId)) {
    await provider.client.setModel(savedModelId, inst.acpSessionId ?? undefined);
    modelRestored = true;
  }

  if (modeRestored || modelRestored) {
    send({ type: "sessionMetadata", ...metadata });
  }
}

// ---------------------------------------------------------------------------
// Orchestration workflow (Mastra-based, replaces OrchestratorBridge)
// ---------------------------------------------------------------------------

/** Pending orchestration run — stored while awaiting user approval. */
let pendingOrchestration: {
  config: OrchestrationConfig;
  assignments: AgentAssignment[];
  context: WorkspaceContext;
  cost: CostTracker;
  runId: string;
  runStart: number;
} | null = null;

/** Lazily-created orchestrator agents (shared across runs). */
let orchestratorAgents: OrchestratorAgents | null = null;

function getOrchestratorAgents(): OrchestratorAgents {
  if (!orchestratorAgents) {
    // Default model — can be overridden per-workspace via config
    const model = process.env.EISEN_ORCHESTRATOR_MODEL ?? "anthropic/claude-sonnet-4-20250514";
    orchestratorAgents = createAgents({ model });
  }
  return orchestratorAgents;
}

async function handleOrchestrate(
  intent: string,
  effort: string = "medium",
  autoApprove: boolean = false,
): Promise<void> {
  const instanceId = currentInstanceKey;

  // Tracks ACPClient → instanceKey for workflow-spawned sub-agent tabs.
  const clientInstanceMap = new Map<ACPClient, string>();

  const sendChatMsg = (text: string) => {
    send({
      method: "chatMessage",
      params: { from: "agent", text, instanceId },
    });
  };

  // Wrap the IPC send to surface key orchestration events as chat bubbles.
  const orchestrateSend = (msg: Record<string, unknown>) => {
    send(msg);
    const STATE_LABELS: Record<string, string> = {
      "loading-context": "Loading workspace context...",
      decomposing: "Decomposing task into subtasks...",
      assigning: "Assigning agents to subtasks...",
      confirming: "Confirming plan...",
      executing: "Executing subtasks with ACP agents...",
      evaluating: "Evaluating results...",
    };
    if (msg.type === "state" && typeof msg.state === "string") {
      const label = STATE_LABELS[msg.state];
      if (label) sendChatMsg(label);
    } else if (msg.type === "decomposition" && Array.isArray(msg.subtasks)) {
      const lines = (msg.subtasks as Array<{ description: string }>)
        .map((s, i) => `${i + 1}. ${s.description}`)
        .join("\n");
      sendChatMsg(`Decomposed into ${msg.subtasks.length} subtask(s):\n${lines}`);
    } else if (msg.type === "progress") {
      const { subtaskIndex, agentId, status } = msg as Record<string, unknown>;
      sendChatMsg(`Subtask ${subtaskIndex}: ${agentId} → ${status}`);
    } else if (msg.type === "result") {
      const results = (msg.subtaskResults as Array<{ status: string }>) ?? [];
      const completed = results.filter((r) => r.status === "completed").length;
      sendChatMsg(`Done! ${completed}/${results.length} subtasks completed.`);
    }
  };

  try {
    sendChatMsg("Starting orchestration...");

    const config: OrchestrationConfig = {
      workspacePath: getCwd(),
      userIntent: intent,
      effort: effort as "low" | "medium" | "high",
      autoApprove,
      maxAgents: MAX_AGENT_INSTANCES,
      agents: getOrchestratorAgents(),
      send: orchestrateSend,
      createACPClient: (agentType: string) => {
        const agent = getAgent(agentType);
        if (!agent) throw new Error(`Unknown agent for orchestration: ${agentType}`);

        // Each sub-agent gets its own dedicated client for concurrent execution.
        const count = (instanceCounters.get(agentType) ?? 0) + 1;
        instanceCounters.set(agentType, count);
        const key = `${agentShortName(agentType)}${count}`;
        const color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length];
        nextColorIndex++;

        const client = new ACPClient({ agentConfig: agent, hostDir: process.execPath });
        const session: AgentSession = {
          key,
          agentType,
          label: key,
          sessionMode: "single_agent",
          acpSessionId: null,
          hasAcpSession: false,
          coreSessionId: null,
          hasRestoredModeModel: false,
          stderrBuffer: "",
          streamingText: "",
          color,
          isStreaming: false,
          coreSessionReady: false,
          coreSessionPromise: null,
          coreSessionLastAttempt: 0,
          orchestratorKey: instanceId ?? undefined,
        };
        agentSessions.set(key, session);
        clientInstanceMap.set(client, key);
        sendInstanceList();
        return client;
      },
      onSubtaskStart: (client, subtask, _agentId) => {
        const key = clientInstanceMap.get(client);
        if (!key) return;
        const inst = agentSessions.get(key);
        if (inst) inst.isStreaming = true;
        send({
          method: "chatMessage",
          params: {
            from: "user",
            text: `Subtask: ${subtask.description}\nRegion: ${subtask.region}`,
            instanceId: key,
          },
        });
        sendInstanceList();
      },
      onSubtaskComplete: (client, subtask, agentOutput) => {
        const key = clientInstanceMap.get(client);
        if (!key) return;
        const inst = agentSessions.get(key);
        if (inst) inst.isStreaming = false;
        send({
          method: "chatMessage",
          params: { from: "agent", text: agentOutput, instanceId: key },
        });
        sendInstanceList();
      },
      onPendingApproval: (data) => {
        pendingOrchestration = { ...data, config };
      },
    };

    const result = await orchestrate(config);

    if (result.status === "pending_approval") {
      sendChatMsg("Plan ready. Approve to proceed, or say 'cancel' to abort.");
      console.error("[eisen-host] Orchestration awaiting user approval");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[eisen-host] Orchestration error:", msg);
    send({ type: "orchestrationError", message: msg });
    sendChatMsg(`Error: ${msg}`);
  }
}

async function handleOrchestrationApprove(approved: boolean): Promise<void> {
  if (!pendingOrchestration) {
    send({ type: "error", text: "No pending orchestration to approve" });
    return;
  }

  if (!approved) {
    send({ type: "state", state: "cancelled" });
    pendingOrchestration = null;
    return;
  }

  const { config, assignments, context, cost, runId, runStart } = pendingOrchestration;
  pendingOrchestration = null;

  try {
    await executeAndEvaluate(config, assignments, context, cost, runId, runStart);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    send({ type: "orchestrationError", message: msg });
  }
}

// ---------------------------------------------------------------------------
// Main stdin/stdout IPC loop
// ---------------------------------------------------------------------------

async function handleMessage(message: Record<string, any>): Promise<void> {
  switch (message.type) {
    case "sendMessage":
      if (message.text || (message.contextChips && message.contextChips.length > 0)) {
        await handleUserMessage(message.text || "", message.contextChips);
      }
      break;
    case "fileSearch":
      if (message.query !== undefined) {
        const results = await fileSearchService.search(message.query);
        send({ type: "fileSearchResults", searchResults: results });
      }
      break;
    case "selectAgent":
      if (message.agentId) {
        await handleSpawnAgent(message.agentId);
      }
      break;
    case "spawnAgent":
      if (message.agentType) {
        await handleSpawnAgent(message.agentType, message.sessionMode as SessionMode | undefined);
      }
      break;
    case "switchInstance":
      if (message.instanceKey) {
        switchToInstance(message.instanceKey);
      }
      break;
    case "closeInstance":
      if (message.instanceKey) {
        handleCloseInstance(message.instanceKey);
      }
      break;
    case "selectMode":
      if (message.modeId) {
        await handleModeChange(message.modeId);
      }
      break;
    case "selectModel":
      if (message.modelId) {
        await handleModelChange(message.modelId);
      }
      break;
    case "connect":
      await handleConnect();
      break;
    case "newChat":
      await handleNewChat();
      break;
    case "cancel": {
      const active = getActiveSession();
      const provider = active ? providerClients.get(active.agentType) : null;
      if (active && provider) {
        await provider.client.cancel(active.acpSessionId ?? undefined);
      }
      break;
    }
    case "clearChat":
      handleClearChat();
      break;
    case "copyMessage":
      if (message.text) {
        // Forward to frontend for clipboard access
        send({ type: "copyToClipboard", text: message.text });
      }
      break;
    // Orchestration commands (Mastra workflow)
    case "orchestrate":
      if (message.intent) {
        await handleOrchestrate(
          message.intent,
          message.effort,
          message.autoApprove,
        );
      }
      break;
    case "approve":
      await handleOrchestrationApprove(message.approved !== false);
      break;
    case "retry":
      // TODO: Implement retry of failed subtasks from last run
      send({ type: "error", text: "Retry not yet implemented" });
      break;
  case "ready": {
      // Send current connection state
      const activeSession = getActiveSession();
      const activeProvider = activeSession ? providerClients.get(activeSession.agentType) : null;
      if (activeProvider) {
        send({ type: "connectionState", state: activeProvider.client.getState() });
      }
      // Send agent list for spawn dropdown
      const agentsWithStatus = getAgentsWithStatus();
      send({
        type: "agents",
        agents: agentsWithStatus.map((a) => ({
          id: a.id,
          name: a.name,
          available: a.available,
        })),
        selected: activeSession?.agentType ?? null,
      });
      sendInstanceList();
      // Send streaming state for active instance
      if (activeSession) {
        send({ type: "streamingState", isStreaming: activeSession.isStreaming });
        sendSessionMetadata(activeSession.key);
        await ensureCoreSession(activeSession);
      }
      updateGraphSelection();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.error(`[eisen-host] Starting with cwd: ${cwd}`);

  // Probe agent availability in the background
  ensureAgentStatusLoaded().catch((e) =>
    console.error("[eisen-host] Failed to probe agent availability:", e),
  );

  // Read stdin line by line
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const message = JSON.parse(trimmed);
      await handleMessage(message);
    } catch (e) {
      console.error("[eisen-host] Failed to parse stdin line:", e, trimmed.substring(0, 200));
    }
  });

  rl.on("close", () => {
    console.error("[eisen-host] stdin closed, shutting down");
    // Dispose all provider clients
    for (const provider of providerClients.values()) {
      try {
        provider.client.dispose();
      } catch {}
      provider.core?.disconnect();
    }
    // Dispose terminals
    for (const terminal of terminals.values()) {
      if (terminal.proc && !terminal.proc.killed) {
        try {
          terminal.proc.kill();
        } catch {}
      }
    }
    orchestrator.dispose();
    process.exit(0);
  });
}

main();
