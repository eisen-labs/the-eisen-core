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

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const globalState = new Memento();
const orchestrator = new EisenOrchestrator();
const coreClients = new Map<string, CoreClient>();
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
// Agent instances
// ---------------------------------------------------------------------------

type SessionMode = "single_agent" | "orchestrator";

interface AgentInstance {
  key: string;
  agentType: string;
  label: string;
  sessionMode: SessionMode;
  client: ACPClient;
  acpSessionId: string | null;
  coreSessionId: string | null;
  hasAcpSession: boolean;
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

const agentInstances = new Map<string, AgentInstance>();
let currentInstanceKey: string | null = null;
const instanceCounters = new Map<string, number>();
let nextColorIndex = 0;
const connectedInstanceIds = new Set<string>();
const terminals = new Map<string, ManagedTerminal>();
let terminalCounter = 0;

/**
 * Insertion-order list of ALL instance keys (both virtual orchestrators and
 * regular agent instances), used to preserve chronological tab order while
 * still grouping each orchestrator's sub-agents directly to its right.
 * Sub-agents (with orchestratorKey set) are NOT added here; they are injected
 * inline after their parent when building the display list.
 */
const instanceOrder: string[] = [];

// ---------------------------------------------------------------------------
// Virtual orchestrator instances (no ACP agent, pure Mastra workflow)
// ---------------------------------------------------------------------------

interface VirtualInstance {
  key: string;
  label: string;
  agentType: "orchestrator";
  color: string;
  isStreaming: boolean;
  /** Set when the orchestration workflow is waiting for user approval. */
  pendingApproval?: PendingApprovalData & { config: OrchestrationConfig };
}

const virtualInstances = new Map<string, VirtualInstance>();

function getActiveInstance(): AgentInstance | undefined {
  return currentInstanceKey ? agentInstances.get(currentInstanceKey) : undefined;
}

function getActiveClient(): ACPClient | null {
  return getActiveInstance()?.client ?? null;
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

  for (const key of instanceOrder) {
    const vi = virtualInstances.get(key);
    if (vi) {
      // Orchestrator tab followed immediately by its sub-agents.
      list.push({
        key: vi.key,
        label: vi.label,
        agentType: vi.agentType,
        color: vi.color,
        connected: true,
        isStreaming: vi.isStreaming,
      });
      for (const inst of agentInstances.values()) {
        if (inst.orchestratorKey === vi.key) {
          list.push({
            key: inst.key,
            label: inst.label,
            agentType: inst.agentType,
            color: inst.color,
            connected: inst.client.isConnected(),
            isStreaming: inst.isStreaming,
          });
        }
      }
      continue;
    }

    const inst = agentInstances.get(key);
    if (inst && !inst.orchestratorKey) {
      list.push({
        key: inst.key,
        label: inst.label,
        agentType: inst.agentType,
        color: inst.color,
        connected: inst.client.isConnected(),
        isStreaming: inst.isStreaming,
      });
    }
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

function updateGraphSelection(): void {
  const inst = getActiveInstance();
  if (!inst) return;
  const coreSessionId = inst.coreSessionId;
  if (!coreSessionId) return;
  const core = coreClients.get(inst.key);
  if (!core) return;
  core.setStreamFilter({ sessionId: coreSessionId });
  core.requestSnapshot(coreSessionId);
}

function setupClientHandlers(client: ACPClient, instanceKey: string): void {
  client.setOnStateChange((state) => {
    const inst = agentInstances.get(instanceKey);
    console.error(
      `[Host] Instance "${instanceKey}" (type=${inst?.agentType}) state -> "${state}" (instanceId=${client.instanceId}, isActive=${currentInstanceKey === instanceKey})`,
    );

    if (state === "connected") {
      const instId = client.instanceId;
      if (instId) {
        connectedInstanceIds.add(instId);
        // Register with orchestrator for graph visualization
        registerAgentWithOrchestrator(client);
      }
      sendInstanceList();
    }
    if (state === "disconnected") {
      const instId = client.instanceId;
      if (instId && connectedInstanceIds.has(instId)) {
        connectedInstanceIds.delete(instId);
        orchestrator.removeAgent(instId);
      }
      sendInstanceList();
    }

    if (currentInstanceKey === instanceKey) {
      send({ type: "connectionState", state });
    }
  });

  client.setOnSessionUpdate((update: SessionNotification) => {
    if (currentInstanceKey === instanceKey) {
      handleSessionUpdate(update);
    } else {
      const bgInst = agentInstances.get(instanceKey);
      if (bgInst && update.update?.sessionUpdate === "agent_message_chunk" && update.update?.content?.type === "text") {
        const chunk = update.update.content.text as string;
        bgInst.streamingText += chunk;
        // Forward the chunk with instanceId so the frontend can buffer it per-tab.
        send({ type: "streamChunk", text: chunk, instanceId: instanceKey });
      }
    }
  });

  client.setOnStderr((text: string) => {
    const inst = agentInstances.get(instanceKey);
    if (inst) {
      inst.stderrBuffer += text;
    }
    if (currentInstanceKey === instanceKey) {
      handleStderr(text, instanceKey);
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

function createInstance(agentType: string, sessionMode: SessionMode, orchestratorKey?: string): AgentInstance {
  if (agentInstances.size >= MAX_AGENT_INSTANCES) {
    throw new Error(
      `Maximum number of concurrent agents (${MAX_AGENT_INSTANCES}) reached. ` +
        `Close an existing agent tab before spawning a new one.`,
    );
  }

  const agent = getAgent(agentType);
  if (!agent) {
    throw new Error(`Unknown agent: ${agentType}`);
  }

  const count = (instanceCounters.get(agentType) ?? 0) + 1;
  instanceCounters.set(agentType, count);
  const short = agentShortName(agentType);
  const key = `${short}${count}`;

  const color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length];
  nextColorIndex++;

  const hostDir = process.execPath;
  const client = new ACPClient({
    agentConfig: agent,
    hostDir: hostDir,
  });

  const instance: AgentInstance = {
    key,
    agentType,
    label: key,
    sessionMode,
    client,
    acpSessionId: null,
    coreSessionId: null,
    hasAcpSession: false,
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

  setupClientHandlers(client, key);
  agentInstances.set(key, instance);
  if (!orchestratorKey) instanceOrder.push(key);
  return instance;
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

async function ensureCoreClient(inst: AgentInstance): Promise<CoreClient | null> {
  if (coreClients.has(inst.key)) return coreClients.get(inst.key) ?? null;
  const port = await inst.client.waitForTcpPort().catch(() => null);
  if (!port) return null;
  const core = new CoreClient((msg) => {
    if (currentInstanceKey !== inst.key) return;
    if (msg?.type === "snapshot") {
      send(toMergedSnapshot(msg));
    } else if (msg?.type === "delta") {
      send(toMergedDelta(msg));
    } else if (msg?.type === "usage") {
      send({ type: "usageUpdate", used: msg.used, size: msg.size, cost: msg.cost });
    }
  });
  core.connect(port);
  coreClients.set(inst.key, core);
  return core;
}

const CORE_SESSION_RETRY_COOLDOWN_MS = 10_000;

async function ensureCoreSession(inst: AgentInstance): Promise<void> {
  // If already set up, just refresh the stream filter and return
  if (inst.coreSessionReady && inst.coreSessionId) {
    const core = coreClients.get(inst.key);
    if (core) {
      core.setStreamFilter({ sessionId: inst.coreSessionId });
      core.requestSnapshot(inst.coreSessionId);
    }
    return;
  }

  // Deduplicate concurrent calls — return the in-flight promise if one exists
  if (inst.coreSessionPromise) {
    return inst.coreSessionPromise;
  }

  // Cooldown: don't retry too quickly after a failure
  const now = Date.now();
  if (inst.coreSessionLastAttempt > 0 && now - inst.coreSessionLastAttempt < CORE_SESSION_RETRY_COOLDOWN_MS) {
    return;
  }

  inst.coreSessionLastAttempt = now;
  inst.coreSessionPromise = doEnsureCoreSession(inst).finally(() => {
    inst.coreSessionPromise = null;
  });

  return inst.coreSessionPromise;
}

/**
 * Ensure the ACP client is connected and has an active session.
 * This is the minimum required before sending a message. It does NOT
 * set up the eisen-core graph session (that's handled separately).
 */
async function ensureAcpSession(inst: AgentInstance): Promise<void> {
  const state = inst.client.getState();
  if (state === "connecting") {
    await new Promise<void>((resolve, reject) => {
      const unsub = inst.client.setOnStateChange((s) => {
        if (s === "connected") { unsub(); resolve(); }
        else if (s === "disconnected" || s === "error") { unsub(); reject(new Error(`Connection failed: ${s}`)); }
      });
    });
  } else if (state !== "connected") {
    await inst.client.connect();
  }

  if (!inst.hasAcpSession) {
    const workingDir = getCwd();
    const resp = await inst.client.newSession(workingDir);
    inst.acpSessionId = resp.sessionId;
    inst.hasAcpSession = true;
    sendSessionMetadata();
  } else if (inst.acpSessionId) {
    inst.client.setActiveSession(inst.acpSessionId);
  }
}

async function doEnsureCoreSession(inst: AgentInstance): Promise<void> {
  // ACP connection + session must exist first
  await ensureAcpSession(inst);

  const core = await ensureCoreClient(inst);
  if (!core) return;

  const agentId = inst.client.instanceId;
  if (!agentId) return;

  if (inst.sessionMode === "single_agent") {
    if (inst.acpSessionId && inst.coreSessionId !== inst.acpSessionId) {
      inst.coreSessionId = inst.acpSessionId;
    }
  }

  if (!inst.coreSessionId) {
    inst.coreSessionId =
      inst.sessionMode === "single_agent" && inst.acpSessionId
        ? inst.acpSessionId
        : `${agentId}-${Date.now().toString(36)}`;
  }

  const session = await core.rpc("create_session", {
    agent_id: agentId,
    session_id: inst.coreSessionId,
    mode: inst.sessionMode,
  });
  inst.coreSessionId = session?.session_id ?? inst.coreSessionId;

  const coreSessionId = inst.coreSessionId;
  if (!coreSessionId) return;
  if (inst.sessionMode === "orchestrator" && inst.acpSessionId) {
    const providerKey = { agent_id: agentId, session_id: inst.acpSessionId };
    const providers = [providerKey];
    await core.rpc("set_orchestrator_providers", {
      agent_id: agentId,
      session_id: coreSessionId,
      providers,
    });
  }

  await core.rpc("set_active_session", { agent_id: agentId, session_id: coreSessionId });
  core.setStreamFilter({ sessionId: coreSessionId });
  core.requestSnapshot(coreSessionId);

  inst.coreSessionReady = true;
}

// ---------------------------------------------------------------------------
// Session update handler
// ---------------------------------------------------------------------------

function handleSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;
  const inst = getActiveInstance();

  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      if (inst) inst.streamingText += update.content.text;
      send({ type: "streamChunk", text: update.content.text, instanceId: currentInstanceKey });
    }
  } else if (update.sessionUpdate === "tool_call") {
    send({
      type: "toolCallStart",
      name: update.title,
      toolCallId: update.toolCallId,
      kind: update.kind,
    });
  } else if (update.sessionUpdate === "tool_call_update") {
    if (update.status === "completed" || update.status === "failed") {
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
    send({ type: "modeUpdate", modeId: update.currentModeId });
  } else if (update.sessionUpdate === "available_commands_update") {
    send({
      type: "availableCommands",
      commands: update.availableCommands,
    });
  } else if (update.sessionUpdate === "plan") {
    send({ type: "plan", plan: { entries: update.entries } });
  } else if (update.sessionUpdate === "agent_thought_chunk") {
    if (update.content?.type === "text") {
      send({ type: "thoughtChunk", text: update.content.text });
    }
  } else if (update.sessionUpdate === "usage_update") {
    send({
      type: "usageUpdate",
      used: update.used,
      size: update.size,
      cost: update.cost,
    });
  }
}

// ---------------------------------------------------------------------------
// Stderr handler
// ---------------------------------------------------------------------------

function handleStderr(_text: string, instanceKey: string): void {
  const inst = agentInstances.get(instanceKey);
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

    // Handle virtual orchestrator instances
    const vi = virtualInstances.get(instanceKey);
    if (vi) {
      currentInstanceKey = instanceKey;
      globalState.update(SELECTED_AGENT_KEY, "orchestrator");
      send({ type: "instanceChanged", instanceKey, isStreaming: vi.isStreaming });
      send({ type: "connectionState", state: "connected" });
      sendInstanceList();
      send({ type: "sessionMetadata", modes: null, models: null });
      return;
    }

    const target = agentInstances.get(instanceKey);
    if (!target) return;

  currentInstanceKey = instanceKey;
  globalState.update(SELECTED_AGENT_KEY, target.agentType);

  send({
    type: "instanceChanged",
    instanceKey,
    isStreaming: target.isStreaming,
  });
  send({
    type: "connectionState",
    state: target.client.getState(),
  });
  sendInstanceList();

    if (target.client.isConnected()) {
      sendSessionMetadata();
    } else {
      send({ type: "sessionMetadata", modes: null, models: null });
    }

    ensureCoreSession(target).catch((e) =>
      console.error("[Host] Failed to initialize core session:", e),
    );
    updateGraphSelection();
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function handleSpawnOrchestratorVirtual(): void {
  const count = (instanceCounters.get("orchestrator") ?? 0) + 1;
  instanceCounters.set("orchestrator", count);
  const key = `orch${count}`;
  const color = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length];
  nextColorIndex++;

  const vi: VirtualInstance = { key, label: key, agentType: "orchestrator", color, isStreaming: false };
  virtualInstances.set(key, vi);
  instanceOrder.push(key);

  currentInstanceKey = key;
  globalState.update(SELECTED_AGENT_KEY, "orchestrator");
  send({ type: "instanceChanged", instanceKey: key, isStreaming: false });
  send({ type: "connectionState", state: "connected" });
  sendInstanceList();
  send({ type: "sessionMetadata", modes: null, models: null });

  const model = process.env.EISEN_ORCHESTRATOR_MODEL ?? "anthropic/claude-sonnet-4-20250514";
  const displayModel = model.split("/").pop() ?? model;
  send({
    method: "chatMessage",
    params: { from: "agent", text: `I'm ${displayModel}, ready to orchestrate`, instanceId: key },
  });
}

function handleSpawnAgent(agentType: string, sessionMode: SessionMode = "single_agent"): void {
    if (agentType === "orchestrator") {
      handleSpawnOrchestratorVirtual();
      return;
    }

    const agent = getAgent(agentType);
    if (!agent) return;

    try {
      const instance = createInstance(agentType, sessionMode);
      switchToInstance(instance.key);
      ensureCoreSession(instance).catch((e) =>
        console.error("[Host] Failed to initialize core session:", e),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn agent";
      send({ type: "error", text: message });
  }
}

function handleCloseInstance(instanceKey: string): void {
  // Handle virtual orchestrator instances
  if (virtualInstances.has(instanceKey)) {
    virtualInstances.delete(instanceKey);
    const viOrderIdx = instanceOrder.indexOf(instanceKey);
    if (viOrderIdx !== -1) instanceOrder.splice(viOrderIdx, 1);
    if (currentInstanceKey === instanceKey) {
      const remaining = [...Array.from(agentInstances.keys()), ...Array.from(virtualInstances.keys())];
      if (remaining.length > 0) {
        switchToInstance(remaining[remaining.length - 1]);
      } else {
        currentInstanceKey = null;
        instanceCounters.clear();
        nextColorIndex = 0;
        send({ type: "instanceChanged", instanceKey: null, isStreaming: false });
      }
    }
    sendInstanceList();
    return;
  }

    const instance = agentInstances.get(instanceKey);
    if (!instance) return;

  const instId = instance.client.instanceId;
  try {
    instance.client.dispose();
  } catch {}

  if (instId && connectedInstanceIds.has(instId)) {
    connectedInstanceIds.delete(instId);
    orchestrator.removeAgent(instId);
  }

  const core = coreClients.get(instanceKey);
  if (core) {
    core.disconnect();
    coreClients.delete(instanceKey);
  }

  agentInstances.delete(instanceKey);
  const orderIdx = instanceOrder.indexOf(instanceKey);
  if (orderIdx !== -1) instanceOrder.splice(orderIdx, 1);

  if (currentInstanceKey === instanceKey) {
    const remaining = [...Array.from(agentInstances.keys()), ...Array.from(virtualInstances.keys())];
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

async function handleUserMessage(
  text: string,
  contextChips?: Array<{
    filePath: string;
    fileName: string;
    isDirectory?: boolean;
    range?: { startLine: number; endLine: number };
  }>,
): Promise<void> {
  // Route to Mastra workflow for virtual orchestrator instances
  const vi = currentInstanceKey ? virtualInstances.get(currentInstanceKey) : undefined;
  if (vi) {
    send({ type: "userMessage", text });

    const sendChatMsg = (msg: string) =>
      send({ method: "chatMessage", params: { from: "agent", text: msg, instanceId: vi.key } });

    // If waiting for approval, this message is the user's response.
    if (vi.pendingApproval) {
      const pending = vi.pendingApproval;
      vi.pendingApproval = undefined;

      if (text.trim().toLowerCase() === "cancel") {
        sendChatMsg("Orchestration cancelled.");
        return;
      }

      sendChatMsg("Executing approved plan...");
      vi.isStreaming = true;
      try {
        const result = await executeAndEvaluate(
          pending.config,
          pending.assignments,
          pending.context,
          pending.cost,
          pending.runId,
          pending.runStart,
        );
        if (result.status !== "completed" && result.status !== "done") {
          sendChatMsg(`Orchestration finished with status: ${result.status}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sendChatMsg(`Error during execution: ${msg}`);
      } finally {
        vi.isStreaming = false;
      }
      return;
    }

    vi.isStreaming = true;
    await handleOrchestrate(text);
    vi.isStreaming = false;
    return;
  }

  const inst = getActiveInstance();
  if (!inst) return;

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
    // Ensure ACP is connected and has a session — this is required for messaging.
    await ensureAcpSession(inst);

    // Kick off eisen-core graph session in the background — failure is non-fatal.
    ensureCoreSession(inst).catch((e) =>
      console.error("[Host] Non-fatal: failed to set up core session:", e),
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
    const response = await inst.client.sendMessage(text, chipData);

    inst.isStreaming = false;
    if (inst.streamingText.length === 0) {
      send({ type: "error", text: "Agent returned no response." });
      send({ type: "streamEnd", instanceId: inst.key, stopReason: "error", html: "" });
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
    send({ type: "streamEnd", instanceId: inst.key, stopReason: "error", html: "" });
    inst.streamingText = "";
    inst.stderrBuffer = "";
  }
}

async function handleModeChange(modeId: string): Promise<void> {
  const inst = getActiveInstance();
  if (!inst) return;
  try {
    await inst.client.setMode(modeId);
    const key = `${SELECTED_MODE_KEY}.${inst.agentType}`;
    await globalState.update(key, modeId);
    sendSessionMetadata();
  } catch (error) {
    console.error("[Host] Failed to set mode:", error);
  }
}

async function handleModelChange(modelId: string): Promise<void> {
  const inst = getActiveInstance();
  if (!inst) return;
  try {
    await inst.client.setModel(modelId);
    const key = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
    await globalState.update(key, modelId);
    sendSessionMetadata();
  } catch (error) {
    console.error("[Host] Failed to set model:", error);
  }
}

async function handleConnect(): Promise<void> {
  const inst = getActiveInstance();
  if (!inst) return;
  try {
    await ensureCoreSession(inst);
  } catch (error) {
    send({
      type: "error",
      text: error instanceof Error ? error.message : "Failed to connect",
    });
  }
}

async function handleNewChat(): Promise<void> {
  const inst = getActiveInstance();
  if (!inst) return;

  inst.acpSessionId = null;
  inst.hasAcpSession = false;
  inst.hasRestoredModeModel = false;
  inst.streamingText = "";

  send({ type: "chatCleared" });
  send({ type: "sessionMetadata", modes: null, models: null });

  try {
    if (inst.client.isConnected()) {
      const workingDir = getCwd();
      const resp = await inst.client.newSession(workingDir);
      inst.acpSessionId = resp.sessionId;
      inst.hasAcpSession = true;
      sendSessionMetadata();
      await ensureCoreSession(inst);
    }
  } catch (error) {
    console.error("[Host] Failed to create new session:", error);
  }
}

function handleClearChat(): void {
  send({ type: "chatCleared" });
}

function sendSessionMetadata(): void {
  const inst = getActiveInstance();
  if (!inst) return;
  const metadata = inst.client.getSessionMetadata(inst.acpSessionId ?? undefined);
  send({
    type: "sessionMetadata",
    modes: metadata?.modes ?? null,
    models: metadata?.models ?? null,
    commands: metadata?.commands ?? null,
  });

  if (!inst.hasRestoredModeModel && inst.hasAcpSession) {
    inst.hasRestoredModeModel = true;
    restoreSavedModeAndModel().catch((error) =>
      console.warn("[Host] Failed to restore saved mode/model:", error),
    );
  }
}

async function restoreSavedModeAndModel(): Promise<void> {
  const inst = getActiveInstance();
  if (!inst) return;
  const metadata = inst.client.getSessionMetadata();
  const availableModes = Array.isArray(metadata?.modes?.availableModes) ? metadata!.modes!.availableModes : [];
  const availableModels = Array.isArray(metadata?.models?.availableModels) ? metadata!.models!.availableModels : [];

  const modeKey = `${SELECTED_MODE_KEY}.${inst.agentType}`;
  const modelKey = `${SELECTED_MODEL_KEY}.${inst.agentType}`;
  const savedModeId = globalState.get<string>(modeKey);
  const savedModelId = globalState.get<string>(modelKey);

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
        const instance = createInstance(agentType, "single_agent", instanceId ?? undefined);
        clientInstanceMap.set(instance.client, instance.key);
        sendInstanceList();
        return instance.client;
      },
      onSubtaskStart: (client, subtask, agentId) => {
        const key = clientInstanceMap.get(client);
        if (!key) return;
        const inst = agentInstances.get(key);
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
        const inst = agentInstances.get(key);
        if (inst) inst.isStreaming = false;
        send({
          method: "chatMessage",
          params: { from: "agent", text: agentOutput, instanceId: key },
        });
        sendInstanceList();
      },
      onPendingApproval: (data) => {
        const vi = instanceId ? virtualInstances.get(instanceId) : undefined;
        if (vi) vi.pendingApproval = { ...data, config };
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
        handleSpawnAgent(message.agentId);
      }
      break;
    case "spawnAgent":
      if (message.agentType) {
        handleSpawnAgent(message.agentType, message.sessionMode as SessionMode | undefined);
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
    case "cancel":
      await getActiveClient()?.cancel();
      break;
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
      const activeClient = getActiveClient();
      if (activeClient) {
        send({ type: "connectionState", state: activeClient.getState() });
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
        selected: getActiveInstance()?.agentType ?? null,
      });
      sendInstanceList();
      // Send streaming state for active instance
      const active = getActiveInstance();
      if (active) {
        send({ type: "streamingState", isStreaming: active.isStreaming });
      }
      sendSessionMetadata();
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
    // Dispose all agents
    for (const inst of agentInstances.values()) {
      try {
        inst.client.dispose();
      } catch {}
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
