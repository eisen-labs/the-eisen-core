import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  type AvailableCommand,
  type Client,
  ClientSideConnection,
  type ContentBlock,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalCommandRequest,
  type KillTerminalCommandResponse,
  type NewSessionResponse,
  ndJsonStream,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModelState,
  type SessionModeState,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { getCorePath } from "../bridge";
import {
  type AgentConfig,
  getAgentsWithStatus,
  getDefaultAgent,
  hasAnyAvailableAgent,
  isAgentAvailable,
} from "./agents";

export interface ContextChipData {
  filePath: string;
  fileName: string;
  isDirectory?: boolean;
  range?: { startLine: number; endLine: number };
}

const MIME_TYPE_MAP: Record<string, string> = {
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".cs": "text/x-csharp",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".swift": "text/x-swift",
  ".kt": "text/x-kotlin",
  ".scala": "text/x-scala",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".less": "text/x-less",
  ".json": "application/json",
  ".xml": "text/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".md": "text/markdown",
  ".sql": "text/x-sql",
  ".graphql": "text/x-graphql",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPE_MAP[ext] || "text/plain";
}

const DIR_FILE_SIZE_LIMIT = 32 * 1024; // 32 KB per file
const DIR_TOTAL_BUDGET = 512 * 1024; // 512 KB total per directory attachment

const DIR_EXCLUDE_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".DS_Store",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".svg",
  ".webp",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".o",
  ".a",
  ".wasm",
  ".pyc",
  ".class",
  ".lock",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

interface DirEntry {
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
}

/** Recursively enumerate directory entries, respecting exclusions. */
async function walkDirectory(dirPath: string, rootPath: string, maxFiles = 500): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];

  async function walk(currentPath: string): Promise<void> {
    if (entries.length >= maxFiles) return;

    let dirEntries: import("fs").Dirent[];
    try {
      dirEntries = await fs.promises.readdir(currentPath, {
        withFileTypes: true,
      });
    } catch {
      return;
    }

    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      if (entries.length >= maxFiles) return;
      if (DIR_EXCLUDE_NAMES.has(entry.name)) continue;

      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(rootPath, fullPath);

      if (entry.isDirectory()) {
        entries.push({
          relativePath,
          absolutePath: fullPath,
          isDirectory: true,
        });
        await walk(fullPath);
      } else {
        entries.push({
          relativePath,
          absolutePath: fullPath,
          isDirectory: false,
        });
      }
    }
  }

  await walk(dirPath);
  return entries;
}

function buildDirectoryTree(dirName: string, entries: DirEntry[]): string {
  const lines: string[] = [`Directory: ${dirName}/`];

  for (const entry of entries) {
    const depth = entry.relativePath.split(path.sep).length - 1;
    const indent = "  ".repeat(depth + 1);
    const name = path.basename(entry.relativePath);
    lines.push(entry.isDirectory ? `${indent}${name}/` : `${indent}${name}`);
  }

  return lines.join("\n");
}

async function readFileContent(filePath: string, range?: { startLine: number; endLine: number }): Promise<string> {
  const content = await fs.promises.readFile(filePath, "utf-8");
  if (range) {
    const lines = content.split("\n");
    // range uses 1-based line numbers
    return lines.slice(range.startLine - 1, range.endLine).join("\n");
  }
  return content;
}

async function buildPromptBlocks(
  text: string,
  chips: ContextChipData[] | undefined,
  supportsEmbeddedContext: boolean,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  if (chips && chips.length > 0) {
    for (const chip of chips) {
      if (chip.isDirectory) {
        const dirBlocks = await buildDirectoryBlocks(chip.filePath, chip.fileName, supportsEmbeddedContext);
        blocks.push(...dirBlocks);
      } else if (chip.range) {
        const content = await readFileContent(chip.filePath, chip.range);
        blocks.push({
          type: "resource",
          resource: {
            uri: `file://${chip.filePath}`,
            text: content,
            mimeType: getMimeType(chip.filePath),
          },
        });
      } else if (supportsEmbeddedContext) {
        const content = await readFileContent(chip.filePath);
        blocks.push({
          type: "resource",
          resource: {
            uri: `file://${chip.filePath}`,
            text: content,
            mimeType: getMimeType(chip.filePath),
          },
        });
      } else {
        blocks.push({
          type: "resource_link",
          uri: `file://${chip.filePath}`,
          name: chip.fileName,
          mimeType: getMimeType(chip.filePath),
        });
      }
    }
  }

  if (text) {
    blocks.push({ type: "text", text });
  }

  return blocks;
}

/** Expand a directory attachment into a tree block + per-file content blocks. */
async function buildDirectoryBlocks(
  dirPath: string,
  dirName: string,
  supportsEmbeddedContext: boolean,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  const entries = await walkDirectory(dirPath, dirPath);

  const treeText = buildDirectoryTree(dirName, entries);
  blocks.push({ type: "text", text: treeText });

  const fileEntries = entries.filter((e) => !e.isDirectory);
  let totalEmbedded = 0;

  for (const entry of fileEntries) {
    if (isBinaryFile(entry.absolutePath)) continue;

    if (supportsEmbeddedContext && totalEmbedded < DIR_TOTAL_BUDGET) {
      try {
        const stat = await fs.promises.stat(entry.absolutePath);
        if (stat.size <= DIR_FILE_SIZE_LIMIT) {
          const content = await fs.promises.readFile(entry.absolutePath, "utf-8");
          const contentBytes = Buffer.byteLength(content, "utf-8");
          if (totalEmbedded + contentBytes <= DIR_TOTAL_BUDGET) {
            totalEmbedded += contentBytes;
            blocks.push({
              type: "resource",
              resource: {
                uri: `file://${entry.absolutePath}`,
                text: content,
                mimeType: getMimeType(entry.absolutePath),
              },
            });
            continue;
          }
        }
      } catch {
        // Fall through to resource_link below
      }
    }

    blocks.push({
      type: "resource_link",
      uri: `file://${entry.absolutePath}`,
      name: path.basename(entry.absolutePath),
      mimeType: getMimeType(entry.absolutePath),
    });
  }

  return blocks;
}

export interface SessionMetadata {
  modes: SessionModeState | null;
  models: SessionModelState | null;
  commands: AvailableCommand[] | null;
}

export type ACPConnectionState = "disconnected" | "connecting" | "connected" | "error";

type StateChangeCallback = (state: ACPConnectionState) => void;
type SessionUpdateCallback = (update: SessionNotification) => void;
type StderrCallback = (data: string) => void;
type ReadTextFileCallback = (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>;
type WriteTextFileCallback = (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>;
type CreateTerminalCallback = (params: CreateTerminalRequest) => Promise<CreateTerminalResponse>;
type TerminalOutputCallback = (params: TerminalOutputRequest) => Promise<TerminalOutputResponse>;
type WaitForTerminalExitCallback = (params: WaitForTerminalExitRequest) => Promise<WaitForTerminalExitResponse>;
type KillTerminalCommandCallback = (params: KillTerminalCommandRequest) => Promise<KillTerminalCommandResponse>;
type ReleaseTerminalCallback = (params: ReleaseTerminalRequest) => Promise<ReleaseTerminalResponse>;

export type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface ACPClientOptions {
  agentConfig?: AgentConfig;
  spawn?: SpawnFunction;
  skipAvailabilityCheck?: boolean;
  hostDir?: string;
  cwd?: string;
}

export interface ACPSessionState {
  sessionId: string;
  metadata: SessionMetadata | null;
}

export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private state: ACPConnectionState = "disconnected";
  private sessions: Map<string, ACPSessionState> = new Map();
  private activeSessionId: string | null = null;
  private pendingCommands: AvailableCommand[] | null = null;
  private stateChangeListeners: Set<StateChangeCallback> = new Set();
  private sessionUpdateListeners: Set<SessionUpdateCallback> = new Set();
  private stderrListeners: Set<StderrCallback> = new Set();
  private readTextFileHandler: ReadTextFileCallback | null = null;
  private writeTextFileHandler: WriteTextFileCallback | null = null;
  private createTerminalHandler: CreateTerminalCallback | null = null;
  private terminalOutputHandler: TerminalOutputCallback | null = null;
  private waitForTerminalExitHandler: WaitForTerminalExitCallback | null = null;
  private killTerminalCommandHandler: KillTerminalCommandCallback | null = null;
  private releaseTerminalHandler: ReleaseTerminalCallback | null = null;
  private agentConfig: AgentConfig;
  private spawnFn: SpawnFunction;
  private skipAvailabilityCheck: boolean;
  private hostDir: string | null;
  private cwd: string | null;
  private supportsEmbeddedContext = false;

  private _instanceId: string | null = null;
  private _tcpPort: number | null = null;
  private tcpPortWaiters: Array<{
    resolve: (port: number) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private stderrThrottleBuffer = "";
  private stderrThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STDERR_THROTTLE_MS = 50;
  private static readonly STDERR_BUFFER_MAX = 16 * 1024;

  // Connection promise cache to prevent concurrent connection attempts
  private connectPromise: Promise<InitializeResponse> | null = null;

  constructor(options?: ACPClientOptions) {
    this.agentConfig = options?.agentConfig ?? getDefaultAgent();
    this.spawnFn = options?.spawn ?? (nodeSpawn as SpawnFunction);
    this.skipAvailabilityCheck = options?.skipAvailabilityCheck ?? false;
    this.hostDir = options?.hostDir ?? null;
    this.cwd = options?.cwd ?? null;
  }

  get tcpPort(): number | null {
    return this._tcpPort;
  }

  get instanceId(): string | null {
    return this._instanceId;
  }

  waitForTcpPort(timeoutMs = 10000): Promise<number> {
    if (this._tcpPort !== null) return Promise.resolve(this._tcpPort);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for TCP port"));
      }, timeoutMs);
      this.tcpPortWaiters.push({ resolve, reject, timer });
    });
  }

  setAgent(config: AgentConfig): void {
    if (this.state !== "disconnected") {
      this.dispose();
    }
    this.agentConfig = config;
  }

  getAgentId(): string {
    return this.agentConfig.id;
  }

  setOnStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeListeners.add(callback);
    return () => this.stateChangeListeners.delete(callback);
  }

  setOnSessionUpdate(callback: SessionUpdateCallback): () => void {
    this.sessionUpdateListeners.add(callback);
    return () => this.sessionUpdateListeners.delete(callback);
  }

  setOnStderr(callback: StderrCallback): () => void {
    this.stderrListeners.add(callback);
    return () => this.stderrListeners.delete(callback);
  }

  setOnReadTextFile(callback: ReadTextFileCallback): void {
    this.readTextFileHandler = callback;
  }

  setOnWriteTextFile(callback: WriteTextFileCallback): void {
    this.writeTextFileHandler = callback;
  }

  setOnCreateTerminal(callback: CreateTerminalCallback): void {
    this.createTerminalHandler = callback;
  }

  setOnTerminalOutput(callback: TerminalOutputCallback): void {
    this.terminalOutputHandler = callback;
  }

  setOnWaitForTerminalExit(callback: WaitForTerminalExitCallback): void {
    this.waitForTerminalExitHandler = callback;
  }

  setOnKillTerminalCommand(callback: KillTerminalCommandCallback): void {
    this.killTerminalCommandHandler = callback;
  }

  setOnReleaseTerminal(callback: ReleaseTerminalCallback): void {
    this.releaseTerminalHandler = callback;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }

  getState(): ACPConnectionState {
    return this.state;
  }

  /** Build spawn command, wrapping the agent with eisen-core when available. */
  private buildSpawnCommand(): { command: string; args: string[] } {
    const corePath = this.hostDir ? getCorePath(this.hostDir) : null;

    let useEisenCore = false;
    if (corePath) {
      try {
        useEisenCore = fs.existsSync(corePath);
      } catch {
        useEisenCore = false;
      }
    }

    if (useEisenCore && corePath) {
      this._instanceId = `${this.agentConfig.id}-${Math.random().toString(36).slice(2, 8)}`;
      console.error(
        `[ACP] Generated instanceId="${this._instanceId}" for agent "${this.agentConfig.id}" (eisen-core at ${corePath})`,
      );

      const coreArgs = [
        "observe",
        "--port",
        "0",
        "--agent-id",
        this._instanceId,
      ];
      if (this.cwd) {
        coreArgs.push("--cwd", this.cwd);
      }
      coreArgs.push("--", this.agentConfig.command, ...this.agentConfig.args);
      return { command: corePath, args: coreArgs };
    }

    return {
      command: this.agentConfig.command,
      args: this.agentConfig.args,
    };
  }

  async connect(): Promise<InitializeResponse> {
    // Return existing connection promise if one is in progress
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // If already connected, return a resolved promise with cached response
    if (this.state === "connected") {
      return Promise.resolve({} as InitializeResponse);
    }

    if (!this.skipAvailabilityCheck && !isAgentAvailable(this.agentConfig.id)) {
      const availableAgents = getAgentsWithStatus().filter((a) => a.available);

      if (!hasAnyAvailableAgent()) {
        throw new Error(
          `No ACP agents are installed. Please install one of the following:\n` +
            `  - Claude Code: npm install -g @zed-industries/claude-code-acp\n` +
            `  - Aider: pip install aider-chat\n` +
            `  - Goose: pip install goose-ai\n` +
            `  - Or visit the Eisen documentation for more options.`,
        );
      }

      throw new Error(
        `Agent "${this.agentConfig.name}" is not installed. ` +
          `Please install "${this.agentConfig.command}" or use one of these available agents: ` +
          availableAgents.map((a) => a.name).join(", "),
      );
    }

    this._instanceId = null;
    this._tcpPort = null;
    this.rejectTcpPortWaiters("Connection reset");

    this.setState("connecting");

    // Create the connection promise
    this.connectPromise = this.doConnect();
    
    try {
      const result = await this.connectPromise;
      return result;
    } finally {
      // Clear the promise cache after completion (success or failure)
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<InitializeResponse> {

    try {
      const { command, args } = this.buildSpawnCommand();
      console.error(`[ACP] Spawning: ${command} ${args.join(" ")}`);

      const proc = this.spawnFn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          RUST_LOG: process.env.RUST_LOG || "eisen_core=debug",
        },
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command), // Required on Windows for .cmd/.bat files, but NOT for .exe (shell:true breaks paths with spaces)
      });
      this.process = proc;

      const spawnedInstanceId = this._instanceId;

      proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();

        if (this.process === proc) {
          const portMatch = text.match(/eisen-core tcp port: (\d+)/);
          if (portMatch) {
            this._tcpPort = parseInt(portMatch[1], 10);
            console.error(`[ACP] eisen-core TCP port: ${this._tcpPort} (instanceId=${spawnedInstanceId})`);
            for (const waiter of this.tcpPortWaiters) {
              clearTimeout(waiter.timer);
              waiter.resolve(this._tcpPort);
            }
            this.tcpPortWaiters = [];
          }
        }

        this.stderrThrottleBuffer += text;
        if (this.stderrThrottleBuffer.length > ACPClient.STDERR_BUFFER_MAX) {
          this.stderrThrottleBuffer = this.stderrThrottleBuffer.slice(-ACPClient.STDERR_BUFFER_MAX);
        }
        if (!this.stderrThrottleTimer) {
          this.stderrThrottleTimer = setTimeout(() => {
            this.stderrThrottleTimer = null;
            const buffered = this.stderrThrottleBuffer;
            this.stderrThrottleBuffer = "";
            if (buffered) {
              console.error("[ACP stderr]", buffered.length > 500 ? buffered.slice(-500) : buffered);
              for (const cb of this.stderrListeners) cb(buffered);
            }
          }, ACPClient.STDERR_THROTTLE_MS);
        }
      });

      // Reject initialize() if the process dies before the ACP handshake completes
      let earlyExitReject: ((err: Error) => void) | null = null;
      const earlyExitPromise = new Promise<never>((_, reject) => {
        earlyExitReject = reject;
      });

      proc.on("error", (error) => {
        console.error(`[ACP] Process error (instanceId=${spawnedInstanceId}):`, error);
        if (this.process === proc) {
          this.setState("error");
        }
        earlyExitReject?.(new Error(`Agent process error: ${error.message}`));
      });

      proc.on("exit", (code) => {
        console.error(
          `[ACP] Process exited with code=${code} (instanceId=${spawnedInstanceId}, isCurrentProcess=${this.process === proc})`,
        );
        if (this.process === proc) {
          // Still connecting: let the catch block set "error" instead of "disconnected"
          if (!earlyExitReject) {
            this.setState("disconnected");
          }
          this.connection = null;
          this.process = null;
        }
        earlyExitReject?.(
          new Error(
            `Agent "${this.agentConfig.name}" process exited unexpectedly with code ${code}. ` +
              `Check that "${this.agentConfig.command}" is installed correctly and supports ACP mode.`,
          ),
        );
      });

      const stdin = this.process.stdin;
      const stdout = this.process.stdout;
      if (!stdin || !stdout) {
        throw new Error("Process stdin/stdout not available");
      }
      const stream = ndJsonStream(
        Writable.toWeb(stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      );

      const client: Client = {
        requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
          const allowOption = params.options.find((opt) => opt.kind === "allow_once" || opt.kind === "allow_always");
          if (allowOption) {
            return {
              outcome: { outcome: "selected", optionId: allowOption.optionId },
            };
          }
          return { outcome: { outcome: "cancelled" } };
        },
        sessionUpdate: async (params: SessionNotification): Promise<void> => {
          const updateType = params.update?.sessionUpdate ?? "unknown";
          if (updateType === "available_commands_update") {
            const update = params.update as {
              availableCommands: AvailableCommand[];
            };
            const targetSessionId = params.sessionId ?? this.activeSessionId;
            const session = targetSessionId ? this.sessions.get(targetSessionId) : null;
            if (session?.metadata) {
              session.metadata.commands = update.availableCommands;
            } else {
              this.pendingCommands = update.availableCommands;
            }
          }
          try {
            for (const cb of this.sessionUpdateListeners) cb(params);
          } catch (error) {
            console.error("[ACP] Error in session update listener:", error);
          }
        },
        readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
          if (this.readTextFileHandler) {
            return this.readTextFileHandler(params);
          }
          throw new Error("No readTextFile handler registered");
        },
        writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
          if (this.writeTextFileHandler) {
            return this.writeTextFileHandler(params);
          }
          throw new Error("No writeTextFile handler registered");
        },
        createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
          if (this.createTerminalHandler) {
            return this.createTerminalHandler(params);
          }
          throw new Error("No createTerminal handler registered");
        },
        terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
          if (this.terminalOutputHandler) {
            return this.terminalOutputHandler(params);
          }
          throw new Error("No terminalOutput handler registered");
        },
        waitForTerminalExit: async (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
          if (this.waitForTerminalExitHandler) {
            return this.waitForTerminalExitHandler(params);
          }
          throw new Error("No waitForTerminalExit handler registered");
        },
        killTerminal: async (params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> => {
          if (this.killTerminalCommandHandler) {
            return this.killTerminalCommandHandler(params);
          }
          throw new Error("No killTerminal handler registered");
        },
        releaseTerminal: async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
          if (this.releaseTerminalHandler) {
            return this.releaseTerminalHandler(params);
          }
          throw new Error("No releaseTerminal handler registered");
        },
      };

      this.connection = new ClientSideConnection(() => client, stream);

      const initResponse = await Promise.race([
        this.connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
          clientInfo: {
            name: "eisen",
            version: "0.0.1",
          },
        }),
        earlyExitPromise,
      ]);

      earlyExitReject = null;

      this.supportsEmbeddedContext = initResponse.agentCapabilities?.promptCapabilities?.embeddedContext === true;

      this.setState("connected");
      return initResponse;
    } catch (error) {
      this.setState("error");
      // Clean up TCP port waiters on connection failure
      this.rejectTcpPortWaiters("Connection failed");
      throw error;
    }
  }

  async newSession(workingDirectory: string): Promise<NewSessionResponse> {
    if (!this.connection) {
      throw new Error("Not connected");
    }

    const response = await this.connection.newSession({
      cwd: workingDirectory,
      mcpServers: [],
    });

    const sessionState: ACPSessionState = {
      sessionId: response.sessionId,
      metadata: {
        modes: response.modes ?? null,
        models: response.models ?? null,
        commands: this.pendingCommands,
      },
    };
    this.sessions.set(response.sessionId, sessionState);
    this.activeSessionId = response.sessionId;
    this.pendingCommands = null;

    return response;
  }

  getSessionMetadata(sessionId?: string): SessionMetadata | null {
    const id = sessionId ?? this.activeSessionId;
    if (!id) return null;
    return this.sessions.get(id)?.metadata ?? null;
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.activeSessionId = sessionId;
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  async setMode(modeId: string, sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeSessionId;
    if (!this.connection || !id) {
      throw new Error("No active session");
    }
    await this.connection.setSessionMode({
      sessionId: id,
      modeId,
    });
    const session = this.sessions.get(id);
    if (session?.metadata?.modes) {
      session.metadata.modes.currentModeId = modeId;
    }
  }

  async setModel(modelId: string, sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeSessionId;
    if (!this.connection || !id) {
      throw new Error("No active session");
    }
    await this.connection.unstable_setSessionModel({
      sessionId: id,
      modelId,
    });
    const session = this.sessions.get(id);
    if (session?.metadata?.models) {
      session.metadata.models.currentModelId = modelId;
    }
  }

  async sendMessage(message: string, contextChips?: ContextChipData[], sessionId?: string): Promise<PromptResponse> {
    const id = sessionId ?? this.activeSessionId;
    if (!this.connection || !id) {
      throw new Error("No active session");
    }
    try {
      const prompt = await buildPromptBlocks(message, contextChips, this.supportsEmbeddedContext);
      const response = await this.connection.prompt({
        sessionId: id,
        prompt,
      });
      return response;
    } catch (error) {
      console.error("[ACP] Prompt error:", error);
      throw error;
    }
  }

  async cancel(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.activeSessionId;
    if (!this.connection || !id) {
      return;
    }
    await this.connection.cancel({
      sessionId: id,
    });
  }

  dispose(): void {
    console.error(
      `[ACP] dispose() called for agent "${this.agentConfig.id}" (instanceId=${this._instanceId}, state=${this.state})`,
    );
    // Clear connection promise to prevent hanging promises
    this.connectPromise = null;
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.stderrThrottleTimer) {
      clearTimeout(this.stderrThrottleTimer);
      this.stderrThrottleTimer = null;
    }
    this.stderrThrottleBuffer = "";
    this.connection = null;
    this.sessions.clear();
    this.activeSessionId = null;
    this.pendingCommands = null;
    this.supportsEmbeddedContext = false;
    this.setState("disconnected");
    this._instanceId = null;
    this._tcpPort = null;
    this.rejectTcpPortWaiters("Client disposed");
  }

  private rejectTcpPortWaiters(reason: string): void {
    for (const waiter of this.tcpPortWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.tcpPortWaiters = [];
  }

  private setState(state: ACPConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      for (const cb of this.stateChangeListeners) cb(state);
    }
  }
}
