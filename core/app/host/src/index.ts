/**
 * eisen-host -- Standalone host binary entry point.
 *
 * Reads JSON commands from stdin (one per line), writes JSON events to
 * stdout (one per line). Session management is delegated to the shared
 * SessionManager; this file handles host-specific concerns: CLI args,
 * .env loading, stdin/stdout IPC, file I/O, terminals, graph TCP, and
 * the Mastra orchestration workflow.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
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
import * as fs from "node:fs";
import * as path from "node:path";

import { setCwd, getCwd, StateStore as Memento } from "./env";
import { getAgent, getAgentsWithStatus, ensureAgentStatusLoaded } from "./acp/agents";
import { ACPClient } from "./acp/client";
import { CoreClient } from "./core-client";
import { EisenOrchestrator } from "./orchestrator";
import { FileSearchService } from "./file-search-service";
import {
  orchestrate,
  executeAndEvaluate,
  createAgents,
  CostTracker,
  type OrchestrationConfig,
  type AgentAssignment,
  type WorkspaceContext,
  type OrchestratorAgents,
} from "./workflow";
import { marked } from "marked";
import { MAX_AGENT_INSTANCES, type SessionMode } from "./constants";
import { processSessionUpdate } from "./session-update";
import { parseStderrPatterns } from "./stderr";
import { createSessionManager, type AgentSession, type ChatMessage } from "./session-manager";

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

// Load .env from the project root (4 levels up from app/src-tauri/bin/<binary>)
function loadEnvFile(envPath: string): void {
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
    console.error(`[eisen-host] Loaded .env from ${envPath}`);
  } catch (e) {
    console.error(`[eisen-host] Failed to load .env from ${envPath}:`, e);
  }
}
const projectRoot = path.resolve(path.dirname(process.execPath), "..", "..", "..");
loadEnvFile(path.join(projectRoot, ".env"));
loadEnvFile(path.join(cwd, ".env"));

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// ---------------------------------------------------------------------------
// Host-only services
// ---------------------------------------------------------------------------

const globalState = new Memento();
const orchestrator = new EisenOrchestrator(cwd);
const fileSearchService = new FileSearchService(cwd);

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
  json: "json", md: "markdown", css: "css", scss: "scss", less: "less", html: "html",
  py: "python", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c",
  hpp: "cpp", cs: "csharp", rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", sh: "shell", bash: "shell",
  zsh: "shell", sql: "sql", graphql: "graphql", vue: "vue", svelte: "svelte",
};

function languageIdFromPath(filePath: string): string {
  const ext = filePath.split(".").pop() ?? "";
  return LANG_MAP[ext] ?? "plaintext";
}

async function handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
  try {
    let content = await fs.promises.readFile(params.path, "utf-8");
    if (params.line !== undefined || params.limit !== undefined) {
      const lines = content.split("\n");
      const startLine = params.line ?? 0;
      const lineLimit = params.limit ?? lines.length;
      content = lines.slice(startLine, startLine + lineLimit).join("\n");
    }
    return { content, languageId: languageIdFromPath(params.path) };
  } catch (error) {
    console.error("[Host] Failed to read file:", error);
    throw error;
  }
}

async function handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  try {
    const dir = path.dirname(params.path);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(params.path, params.content);
    return {};
  } catch (error) {
    console.error("[Host] Failed to write file:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Terminal management
// ---------------------------------------------------------------------------

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

const terminals = new Map<string, ManagedTerminal>();
let terminalCounter = 0;

function appendTerminalOutput(terminal: ManagedTerminal, text: string): void {
  if (terminal.truncated) return;
  terminal.output += text;
  if (terminal.outputByteLimit !== null && Buffer.byteLength(terminal.output) > terminal.outputByteLimit) {
    terminal.truncated = true;
  }
}

async function handleCreateTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
  const id = `term_${++terminalCounter}`;
  let exitResolve!: () => void;
  const exitPromise = new Promise<void>((r) => { exitResolve = r; });
  const terminal: ManagedTerminal = {
    id,
    proc: null,
    output: "",
    outputByteLimit: params.outputByteLimit ?? null,
    truncated: false,
    exitCode: null,
    signal: null,
    exitPromise,
    exitResolve,
  };
  terminals.set(id, terminal);

  try {
    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.workingDirectory || getCwd(),
      env: { ...process.env, ...(params.env ?? {}) },
      shell: true,
    });
    terminal.proc = proc;

    proc.stdout?.on("data", (data: Buffer) => appendTerminalOutput(terminal, data.toString()));
    proc.stderr?.on("data", (data: Buffer) => appendTerminalOutput(terminal, data.toString()));
    proc.on("exit", (code, signal) => {
      terminal.exitCode = code;
      terminal.signal = signal;
      terminal.exitResolve();
    });
    proc.on("error", (err) => {
      appendTerminalOutput(terminal, `[Process error: ${err.message}]`);
      terminal.exitCode = -1;
      terminal.exitResolve();
    });
  } catch (err) {
    appendTerminalOutput(terminal, `[Failed to spawn: ${err instanceof Error ? err.message : String(err)}]`);
    terminal.exitCode = -1;
    terminal.exitResolve();
  }

  return { terminalId: id };
}

async function handleTerminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
  const terminal = terminals.get(params.terminalId);
  if (!terminal) return { output: "", exitCode: null };
  return {
    output: terminal.output,
    exitCode: terminal.exitCode,
    exitSignal: terminal.signal ?? undefined,
    truncated: terminal.truncated,
  };
}

async function handleWaitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
  const terminal = terminals.get(params.terminalId);
  if (!terminal) return { exitCode: -1 };
  await terminal.exitPromise;
  return { exitCode: terminal.exitCode ?? -1, exitSignal: terminal.signal ?? undefined };
}

async function handleKillTerminalCommand(params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> {
  const terminal = terminals.get(params.terminalId);
  if (!terminal?.proc || terminal.proc.killed) return {};
  try {
    terminal.proc.kill(params.signal as NodeJS.Signals | undefined);
  } catch {}
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
// Graph TCP (eisen-core)
// ---------------------------------------------------------------------------

// Per-instance core client map (keyed by instance key)
const instanceCoreMap = new Map<string, CoreClient | null>();

function ensureCoreClient(session: AgentSession): Promise<CoreClient | null> {
  const existing = instanceCoreMap.get(session.key);
  if (existing) return Promise.resolve(existing);
  if (!session.client) return Promise.resolve(null);
  return (async () => {
    let port: number;
    try {
      port = await (session.client as ACPClient).waitForTcpPort();
    } catch {
      return null;
    }
    const core = new CoreClient((msg) => {
      if (!session.coreSessionId || msg?.session_id !== session.coreSessionId) return;

      if (msg?.type === "usage") {
        send({ type: "usageUpdate", used: msg.used, size: msg.size, cost: msg.cost });
      }
    });
    core.connect(port);
    instanceCoreMap.set(session.key, core);
    return core;
  })();
}

function ensureCoreSession(session: AgentSession): Promise<void> {
  if (session.coreSessionReady) return Promise.resolve();
  if (session.coreSessionPromise) return session.coreSessionPromise;
  const now = Date.now();
  if (now - session.coreSessionLastAttempt < 10_000) return Promise.resolve();
  session.coreSessionLastAttempt = now;
  session.coreSessionPromise = _ensureCoreSessionInner(session)
    .then(() => { session.coreSessionReady = true; })
    .finally(() => { session.coreSessionPromise = null; });
  return session.coreSessionPromise;
}

async function _ensureCoreSessionInner(session: AgentSession): Promise<void> {
  if (!session.client) return;
  if (!session.client.isConnected()) {
    await session.client.connect();
  }
  const core = await ensureCoreClient(session);
  if (!core) return;

  const agentId = session.client.instanceId;
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

  core.setStreamFilter({});
  core.requestSnapshot();
}

function updateGraphSelection(): void {
  orchestrator.requestSnapshot();
}

async function registerAgentWithOrchestrator(
  client: ACPClient,
  opts?: { displayName?: string; color?: string },
): Promise<void> {
  const agentType = client.getAgentId();
  try {
    const port = await client.waitForTcpPort();
    const instanceId = client.instanceId;
    if (instanceId && agentType) {
      orchestrator.addAgent(instanceId, port, agentType, opts);
    }
  } catch (e) {
    console.error(`[Host] Failed to register agent "${agentType}" with orchestrator:`, e);
  }
}

// Orchestrator wiring -- ALL agents are registered with the orchestrator
// so graph data is always unified across all tabs/sessions.
orchestrator.onMergedSnapshot = (snapshot) => {
  send({ type: "mergedSnapshot", ...snapshot });
};
orchestrator.onMergedDelta = (delta) => {
  send({ type: "mergedDelta", ...delta });
};
orchestrator.onAgentUpdate = (agents) => {
  send({ type: "agentUpdate", agents });
};

// ---------------------------------------------------------------------------
// SessionManager setup
// ---------------------------------------------------------------------------

const sm = createSessionManager({
  adapter: {
    send,
    getWorkingDir: getCwd,
    stateGet: <T>(key: string) => globalState.get<T>(key),
    stateUpdate: (key, value) => globalState.update(key, value),
    log: (msg) => console.error(msg),
  },
  handlers: {
    readTextFile: handleReadTextFile,
    writeTextFile: handleWriteTextFile,
    createTerminal: handleCreateTerminal,
    terminalOutput: handleTerminalOutput,
    waitForTerminalExit: handleWaitForTerminalExit,
    killTerminalCommand: handleKillTerminalCommand,
    releaseTerminal: handleReleaseTerminal,
  },
  renderMarkdown: (text: string) => marked.parse(text) as string,
  createACPClient: (agentType: string) => {
    const agent = getAgent(agentType);
    if (!agent) throw new Error(`Unknown agent: ${agentType}`);
    return new ACPClient({ agentConfig: agent, hostDir: process.execPath, cwd });
  },
  onInstanceConnected: (session) => {
    if (session.client) {
      registerAgentWithOrchestrator(session.client as ACPClient, {
        displayName: session.label,
        color: session.color,
      }).catch((e) => console.error("[Host] registerAgentWithOrchestrator failed:", e));
    }
  },
  onCoreSession: (session) => ensureCoreSession(session),
  onGraphUpdate: () => updateGraphSelection(),
});

// Set up the orchestration approval interceptor
let pendingOrchestration: {
  config: OrchestrationConfig;
  assignments: AgentAssignment[];
  context: WorkspaceContext;
  cost: CostTracker;
  runId: string;
  runStart: number;
} | null = null;

sm.setMessageInterceptor(async (text: string) => {
  const trimmed = text.trim();
  if (pendingOrchestration && /^(y|yes|approve|accept)$/i.test(trimmed)) {
    await handleOrchestrationApprove(true);
    return true;
  }
  if (pendingOrchestration && /^(n|no|cancel|decline)$/i.test(trimmed)) {
    await handleOrchestrationApprove(false);
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Orchestration workflow (Mastra-based)
// ---------------------------------------------------------------------------

let orchestratorAgents: OrchestratorAgents | null = null;

function pickOrchestratorModel(): string {
  if (process.env.EISEN_ORCHESTRATOR_MODEL) return process.env.EISEN_ORCHESTRATOR_MODEL;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic/claude-sonnet-4-20250514";
  if (process.env.OPENAI_API_KEY) return "openai/gpt-4o";
  return "anthropic/claude-sonnet-4-20250514";
}

function getOrchestratorAgents(): OrchestratorAgents {
  if (!orchestratorAgents) {
    const model = pickOrchestratorModel();
    console.error(`[eisen-host] Orchestrator model: ${model}`);
    orchestratorAgents = createAgents({ model });
  }
  return orchestratorAgents;
}

async function handleOrchestrate(
  intent: string,
  effort: string = "medium",
  autoApprove: boolean = false,
): Promise<void> {
  const instanceId = sm.getCurrentInstanceKey();
  const sessionInstanceMap = new Map<string, string>();

  const sendChatMsg = (text: string, from: string = "agent") => {
    if (instanceId) sm.pushMessage(instanceId, { from, text });
    send({ type: "chatMessage", from, text, instanceId });
  };

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
      sendChatMsg(`Subtask ${Number(subtaskIndex) + 1}: ${agentId} -> ${status}`);
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
      availableAgents: getAgentsWithStatus().filter((a) => a.available).map((a) => a.id),
      createACPClient: async (agentType: string) => {
        const agent = getAgent(agentType);
        if (!agent) throw new Error(`Unknown agent for orchestration: ${agentType}`);

        const inst = sm.createSession(agentType, "single_agent", instanceId ?? undefined);
        sm.sendInstanceList();

        const client = new ACPClient({
          agentConfig: agent,
          hostDir: process.execPath,
          skipAvailabilityCheck: true,
          cwd,
        });
        client.setOnSessionUpdate((update: SessionNotification) => {
          const sid = update.sessionId ?? client.getActiveSessionId();
          if (!sid) return;
          const key = sm.getSessionByAcpId(sid);
          if (!key) return;
          const instForUpdate = sm.getSession(key);
          if (!instForUpdate) return;
          const { messages, streamingTextDelta } = processSessionUpdate(update, {
            streamingText: instForUpdate.streamingText,
            isActive: sm.getCurrentInstanceKey() === key,
            instanceId: key,
          });
          instForUpdate.streamingText += streamingTextDelta;
          for (const msg of messages) send(msg);
        });
        client.setOnStderr((text: string) => {
          inst.stderrBuffer += text;
          const { event, clearBuffer, truncateBuffer } = parseStderrPatterns(inst.stderrBuffer);
          if (event && sm.getCurrentInstanceKey() === inst.key) {
            send({ type: "agentError", text: event.message });
          }
          if (clearBuffer) inst.stderrBuffer = "";
          if (truncateBuffer) inst.stderrBuffer = inst.stderrBuffer.slice(-5000);
        });
        client.setOnReadTextFile(async (params) => handleReadTextFile(params));
        client.setOnWriteTextFile(async (params) => handleWriteTextFile(params));
        client.setOnCreateTerminal(async (params) => handleCreateTerminal(params));
        client.setOnTerminalOutput(async (params) => handleTerminalOutput(params));
        client.setOnWaitForTerminalExit(async (params) => handleWaitForTerminalExit(params));
        client.setOnKillTerminalCommand(async (params) => handleKillTerminalCommand(params));
        client.setOnReleaseTerminal(async (params) => handleReleaseTerminal(params));

        await client.connect();
        registerAgentWithOrchestrator(client, {
          displayName: inst.label,
          color: inst.color,
        }).catch((e) => console.error("[Host] registerAgentWithOrchestrator failed:", e));
        const resp = await client.newSession(getCwd());
        inst.acpSessionId = resp.sessionId;
        inst.hasAcpSession = true;
        sessionInstanceMap.set(resp.sessionId, inst.key);

        return {
          client,
          sessionId: resp.sessionId,
          dispose: () => {
            const id = client.instanceId;
            if (id) orchestrator.removeAgent(id);
            client.dispose();
          },
        };
      },
      onSubtaskStart: (sessionId, subtask, _agentId) => {
        const key = sessionInstanceMap.get(sessionId);
        if (!key) return;
        const inst = sm.getSession(key);
        if (inst) {
          inst.isStreaming = true;
          inst.streamingText = "";
          inst.stderrBuffer = "";
        }
        send({ type: "streamStart", instanceId: key });
        const subtaskText = `Subtask: ${subtask.description}\nRegion: ${subtask.region}`;
        sm.pushMessage(key, { from: "user", text: subtaskText });
        send({ type: "chatMessage", from: "user", text: subtaskText, instanceId: key });
        sm.sendInstanceList();
      },
      onSubtaskComplete: (sessionId, subtask, agentOutput) => {
        const key = sessionInstanceMap.get(sessionId);
        if (!key) return;
        const inst = sm.getSession(key);
        if (inst) {
          inst.isStreaming = false;
          inst.streamingText = "";
        }
        send({ type: "streamEnd", instanceId: key, stopReason: "complete" });
        sm.pushMessage(key, { from: "agent", text: agentOutput });
        send({ type: "chatMessage", from: "agent", text: agentOutput, instanceId: key });
        sm.sendInstanceList();
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
        await sm.sendMessage(message.text || "", message.contextChips);
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
        await sm.spawnAgent(message.agentId);
      }
      break;
    case "spawnAgent":
      if (message.agentType) {
        await sm.spawnAgent(message.agentType, message.sessionMode as SessionMode | undefined);
      }
      break;
    case "spawnAndSend":
      if (message.agentType && message.text) {
        if ((message.sessionMode ?? "single_agent") === "orchestrator") {
          const inst = sm.createSession(message.agentType, "orchestrator");
          sm.switchToInstance(inst.key);
          sm.pushMessage(inst.key, { from: "user", text: message.text });
          await handleOrchestrate(message.text);
        } else {
          await sm.spawnAndSend(
            message.agentType,
            (message.sessionMode ?? "single_agent") as SessionMode,
            message.text,
            message.contextChips,
          );
        }
      }
      break;
    case "switchInstance":
      if (message.instanceKey) {
        sm.switchToInstance(message.instanceKey);
      }
      break;
    case "closeInstance":
      if (message.instanceKey) {
        const instance = sm.getSession(message.instanceKey);
        if (instance) {
          const core = instanceCoreMap.get(instance.key);
          if (core && instance.client?.instanceId && instance.coreSessionId) {
            core.rpc("close_session", {
              agent_id: instance.client.instanceId,
              session_id: instance.coreSessionId,
            }).catch(() => {});
          }
          instanceCoreMap.delete(instance.key);
          if (instance.client?.instanceId) {
            orchestrator.removeAgent(instance.client.instanceId);
          }
        }
        sm.closeInstance(message.instanceKey);
      }
      break;
    case "selectMode":
      if (message.modeId) {
        await sm.setMode(message.modeId);
      }
      break;
    case "selectModel":
      if (message.modelId) {
        await sm.setModel(message.modelId);
      }
      break;
    case "connect":
      await sm.connect();
      break;
    case "newChat":
      await sm.newChat();
      break;
    case "cancel": {
      const active = sm.getActiveSession();
      if (active && !active.orchestratorKey) {
        await sm.cancel();
      }
      break;
    }
    case "clearChat":
      sm.clearChat();
      break;
    case "copyMessage":
      if (message.text) {
        send({ type: "copyToClipboard", text: message.text });
      }
      break;
    case "orchestrate":
      if (message.intent) {
        await handleOrchestrate(message.intent, message.effort, message.autoApprove);
      }
      break;
    case "approve":
      await handleOrchestrationApprove(message.approved !== false);
      break;
    case "retry":
      send({ type: "error", text: "Retry not yet implemented" });
      break;
    case "readFile":
      if (message.path) {
        try {
          const filePath = message.path as string;
          const content = await fs.promises.readFile(filePath, "utf-8");
          send({ type: "fileContent", path: filePath, content, languageId: languageIdFromPath(filePath) });
        } catch {
          send({ type: "error", text: `Failed to read file: ${message.path}` });
        }
      }
      break;
    case "writeFile":
      if (message.path && typeof message.content === "string") {
        try {
          await fs.promises.writeFile(message.path as string, message.content as string);
          send({ type: "fileSaved", path: message.path });
        } catch {
          send({ type: "error", text: `Failed to write file: ${message.path}` });
        }
      }
      break;
    case "ready": {
      await agentProbePromise;
      const activeSession = sm.getActiveSession();
      if (activeSession?.client) {
        send({ type: "connectionState", state: activeSession.client.getState() });
      }
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
      sm.sendInstanceList();
      if (activeSession) {
        send({ type: "streamingState", isStreaming: activeSession.isStreaming });
        sm.sendSessionMetadata(activeSession.key);
        ensureCoreSession(activeSession).catch((e) =>
          console.error("[Host] ensureCoreSession failed (non-fatal):", e),
        );
      }
      updateGraphSelection();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const agentProbePromise = ensureAgentStatusLoaded().catch((e) => {
  console.error("[eisen-host] Agent probe failed:", e);
});

async function main(): Promise<void> {
  console.error(`[eisen-host] Starting with cwd: ${cwd}`);

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const message = JSON.parse(trimmed);
      handleMessage(message).catch((e) => {
        console.error("[eisen-host] Unhandled error in handleMessage:", e);
      });
    } catch (e) {
      console.error("[eisen-host] Failed to parse stdin line:", e, trimmed.substring(0, 200));
    }
  });

  rl.on("close", () => {
    console.error("[eisen-host] stdin closed, shutting down");
    sm.dispose();
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
