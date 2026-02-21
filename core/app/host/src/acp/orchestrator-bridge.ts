/**
 * Bridges the Python orchestration agent to the VS Code extension.
 *
 * Spawns `python -m eisen_agent --mode extension` as a child process,
 * reads JSON messages from its stdout, and forwards agent_tcp events
 * to the EisenOrchestrator for graph visualization.
 *
 * Extension -> Agent (stdin):
 *   {"type": "run", "intent": "...", "effort": "medium"}
 *   {"type": "approve", "approved": true}
 *   {"type": "retry"}
 *   {"type": "cancel"}
 *
 * Agent -> Extension (stdout):
 *   {"type": "state", "state": "decomposing"}
 *   {"type": "plan", "subtasks": [...], "assignments": [...]}
 *   {"type": "agent_tcp", "agent_id": "...", "tcp_port": 54321, "agent_type": "..."}
 *   {"type": "progress", "subtask_index": 0, "agent_id": "...", "status": "running"}
 *   {"type": "result", "status": "done", "subtask_results": [...], "cost": {...}}
 *   {"type": "error", "message": "..."}
 */

import * as cp from "node:child_process";
import type { EisenOrchestrator } from "../orchestrator";

/** Messages sent by the Python orchestrator. */
export interface OrchestratorMessage {
  type: string;
  [key: string]: unknown;
}

export interface PlanMessage extends OrchestratorMessage {
  type: "plan";
  subtasks: Array<{
    index: number;
    description: string;
    region: string;
    expected_files: string[];
    depends_on: number[];
  }>;
  assignments: Array<{
    subtask_index: number;
    agent_id: string;
  }>;
  estimated_cost: number;
}

export interface AgentTcpMessage extends OrchestratorMessage {
  type: "agent_tcp";
  agent_id: string;
  tcp_port: number;
  agent_type: string;
}

export interface ProgressMessage extends OrchestratorMessage {
  type: "progress";
  subtask_index: number;
  agent_id: string;
  status: string;
}

export interface ResultMessage extends OrchestratorMessage {
  type: "result";
  status: string;
  subtask_results: Array<{
    subtask_index: number;
    description: string;
    region: string;
    agent_id: string;
    status: string;
    failure_reason: string | null;
    suggested_retry: string | null;
  }>;
  cost: {
    total_tokens: number;
    orchestrator_tokens: number;
  };
}

export type OrchestratorEventHandler = (message: OrchestratorMessage) => void;

/**
 * Manages the Python orchestration agent child process.
 *
 * Connects agent_tcp messages to the EisenOrchestrator so that
 * graph visualization works for orchestrator-spawned agents.
 */
export class OrchestratorBridge {
  private _process: cp.ChildProcess | null = null;
  private _buffer = "";
  private _trackedAgentIds: Set<string> = new Set();

  /** Callback for all messages from the orchestrator. */
  public onMessage: OrchestratorEventHandler | null = null;

  constructor(
    private readonly _eisenOrchestrator: EisenOrchestrator | undefined,
    private readonly _workspaceRoot: string,
    private readonly _pythonPath: string = "python",
    private readonly _model: string = "",
  ) {}

  /**
   * Spawn the Python orchestrator process.
   */
  start(): void {
    if (this._process) {
      console.warn("[OrchestratorBridge] Process already running");
      return;
    }

    const args = ["-m", "eisen_agent", "--workspace", this._workspaceRoot, "--mode", "extension"];

    if (this._model) {
      args.push("--model", this._model);
    }

    this._process = cp.spawn(this._pythonPath, args, {
      cwd: this._workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Read stdout for JSON messages
    this._process.stdout?.on("data", (data: Buffer) => {
      this._buffer += data.toString("utf-8");
      this._processBuffer();
    });

    // Read stderr for debug logging
    this._process.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf-8").trim();
      if (text) {
        console.error(`[OrchestratorBridge stderr] ${text}`);
      }
    });

    this._process.on("exit", (code) => {
      console.error(`[OrchestratorBridge] Process exited with code ${code}`);
      this._process = null;
    });

    this._process.on("error", (err) => {
      console.error("[OrchestratorBridge] Process error:", err);
      this._process = null;
    });
  }

  /**
   * Send a command to the orchestrator.
   */
  send(command: Record<string, unknown>): void {
    if (!this._process?.stdin?.writable) {
      console.warn("[OrchestratorBridge] Cannot send — process not running");
      return;
    }
    const line = JSON.stringify(command) + "\n";
    this._process.stdin.write(line);
  }

  /**
   * Send a "run" command to start orchestration.
   */
  run(intent: string, effort: string = "medium"): void {
    this.send({ type: "run", intent, effort });
  }

  /**
   * Send an "approve" command to execute the plan.
   */
  approve(approved: boolean = true): void {
    this.send({ type: "approve", approved });
  }

  /**
   * Send a "retry" command to re-execute failed subtasks.
   */
  retry(): void {
    this.send({ type: "retry" });
  }

  /**
   * Send a "cancel" command and stop the process.
   */
  cancel(): void {
    this.send({ type: "cancel" });
  }

  /**
   * Kill the orchestrator process and clean up tracked agents.
   */
  dispose(): void {
    if (this._process) {
      this._process.kill();
      this._process = null;
    }

    // Remove all agents that were registered via this bridge
    for (const agentId of this._trackedAgentIds) {
      this._eisenOrchestrator?.removeAgent(agentId);
    }
    this._trackedAgentIds.clear();
    this._buffer = "";
  }

  get isRunning(): boolean {
    return this._process !== null;
  }

  private _processBuffer(): void {
    const lines = this._buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this._buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as OrchestratorMessage;
        this._handleMessage(msg);
      } catch {
        console.warn(`[OrchestratorBridge] Failed to parse: ${trimmed}`);
      }
    }
  }

  private _handleMessage(msg: OrchestratorMessage): void {
    // Handle agent_tcp messages — connect to EisenOrchestrator for graph
    if (msg.type === "agent_tcp") {
      const tcpMsg = msg as AgentTcpMessage;
      console.error(
        `[OrchestratorBridge] Agent TCP: ${tcpMsg.agent_id} on port ${tcpMsg.tcp_port} (${tcpMsg.agent_type})`,
      );
      if (this._eisenOrchestrator) {
        this._eisenOrchestrator.addAgent(tcpMsg.agent_id, tcpMsg.tcp_port, tcpMsg.agent_type);
        this._trackedAgentIds.add(tcpMsg.agent_id);
      }
    }

    // Forward all messages to the handler
    this.onMessage?.(msg);
  }
}
