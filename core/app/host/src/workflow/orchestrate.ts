/**
 * Mastra orchestration workflow — replaces the Python Orchestrator class.
 *
 * This is NOT a Mastra createWorkflow() (which requires Mastra server).
 * Instead it's a plain async function that uses Mastra agents for structured
 * LLM calls and orchestrates the full pipeline:
 *
 *   loadWorkspaceContext → decomposeTask → assignAgents → confirmPlan
 *   → buildAndExecute → evaluateAndRecord
 *
 * The workflow communicates with the Tauri frontend via the IPC `send()`
 * callback passed at construction time.
 */

import { WorkspaceDB } from "../db";
import type { ACPClient } from "../acp/client";
import { refreshStaleRegionInsights } from "./region-insights";
import type { OrchestratorAgents } from "./agents";
import { loadWorkspaceContext, formatContextForPrompt, type WorkspaceContext } from "./context-loader";
import { buildExecutionBatches, type BatchItem } from "./topo-sort";
import { CostTracker } from "./cost-tracker";
import { SharedZoneConfig } from "./zones";
import {
  DecomposeOutputSchema,
  AgentSelectOutputSchema,
  PromptBuildOutputSchema,
  ProgressEvalOutputSchema,
} from "./schemas";
import type {
  Subtask,
  SubtaskResult,
  EffortLevel,
  OrchestrationOutput,
  DecomposeOutput,
  AgentSelectOutput,
  PromptBuildOutput,
  ProgressEvalOutput,
} from "./schemas";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestrationConfig {
  workspacePath: string;
  userIntent: string;
  effort: EffortLevel;
  autoApprove: boolean;
  maxAgents: number;
  agents: OrchestratorAgents;
  /** IPC send function — writes JSON events to stdout for Tauri. */
  send: (msg: Record<string, unknown>) => void;
  /** NAPI-RS parser functions (optional, for workspace parsing). */
  napi?: {
    parseWorkspace: (path: string) => unknown;
    parseFile: (path: string) => unknown;
    lookupSymbol: (workspace: string, name: string) => unknown;
    snapshot: (path: string) => unknown;
  };
  /** Factory to create an ACP client for a given agent type. */
  createACPClient?: (agentType: string) => ACPClient;
}

export interface AgentAssignment {
  subtask: Subtask;
  subtaskIndex: number;
  agentId: string;
}

type ConfirmCallback = (plan: {
  subtasks: Subtask[];
  assignments: AgentAssignment[];
}) => Promise<{ approved: boolean; assignments?: AgentAssignment[] }>;

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

/**
 * Run the full orchestration pipeline.
 *
 * This replaces the Python Orchestrator.run() method.
 */
export async function orchestrate(config: OrchestrationConfig): Promise<OrchestrationOutput> {
  const {
    workspacePath,
    userIntent,
    effort,
    autoApprove,
    maxAgents,
    agents,
    send,
    napi,
  } = config;

  const cost = new CostTracker();
  const runStart = Date.now();
  const runId = crypto.randomUUID().slice(0, 8);

  // -----------------------------------------------------------------------
  // 1. Load workspace context
  // -----------------------------------------------------------------------
  send({ type: "state", state: "loading-context" });

  const context = await loadWorkspaceContext(workspacePath, userIntent, {
    parseWorkspace: napi?.parseWorkspace,
    snapshot: napi?.snapshot,
  });

  // -----------------------------------------------------------------------
  // 2. Decompose task
  // -----------------------------------------------------------------------
  send({ type: "state", state: "decomposing" });

  const contextPrompt = formatContextForPrompt(userIntent, context);
  const decomposeInput = contextPrompt
    ? `${userIntent}\n\n---\nWorkspace context:\n${contextPrompt}`
    : userIntent;

  const decomposeResult = await agents.taskDecompose.generate(decomposeInput, {
    structuredOutput: {
      schema: DecomposeOutputSchema,
    },
  });

  const subtasks = (decomposeResult.object as DecomposeOutput).subtasks;
  cost.record("orchestrator", 0, "TaskDecompose");

  send({
    type: "decomposition",
    subtasks,
    reasoning: (decomposeResult.object as DecomposeOutput).reasoning,
  });

  // -----------------------------------------------------------------------
  // 3. Assign agents
  // -----------------------------------------------------------------------
  send({ type: "state", state: "assigning" });

  const assignments = await assignAgents(
    subtasks,
    agents,
    context,
    workspacePath,
    cost,
  );

  // -----------------------------------------------------------------------
  // 4. Confirm plan
  // -----------------------------------------------------------------------
  send({ type: "state", state: "confirming" });

  const plan = {
    subtasks: assignments.map((a) => ({
      index: a.subtaskIndex,
      description: a.subtask.description,
      region: a.subtask.region,
      expectedFiles: a.subtask.expectedFiles,
      dependsOn: a.subtask.dependsOn,
    })),
    assignments: assignments.map((a) => ({
      subtaskIndex: a.subtaskIndex,
      agentId: a.agentId,
    })),
  };

  send({ type: "plan", ...plan });

  if (!autoApprove) {
    // The workflow suspends here. The Tauri frontend will display the plan
    // and send an "approve" message back via stdin. The host process resumes
    // the workflow by calling resumeOrchestration().
    //
    // For now, we return a "pending_approval" result. The host index.ts
    // will handle the approve/reject message and call executeApprovedPlan().
    return {
      status: "pending_approval",
      subtaskResults: [],
      totalTokens: cost.totalTokens,
      orchestratorTokens: cost.orchestratorTokens,
    };
  }

  // -----------------------------------------------------------------------
  // 5 & 6. Execute and evaluate
  // -----------------------------------------------------------------------
  return executeAndEvaluate(config, assignments, context, cost, runId, runStart);
}

/**
 * Execute an approved plan. Called after user confirms the plan
 * (or immediately if autoApprove is true).
 */
export async function executeAndEvaluate(
  config: OrchestrationConfig,
  assignments: AgentAssignment[],
  context: WorkspaceContext,
  cost: CostTracker,
  runId: string,
  runStart: number,
): Promise<OrchestrationOutput> {
  const { workspacePath, userIntent, maxAgents, agents, send, napi } = config;

  // -----------------------------------------------------------------------
  // 5. Build prompts and execute via ACP
  // -----------------------------------------------------------------------
  send({ type: "state", state: "executing" });

  const batchItems: BatchItem<AgentAssignment>[] = assignments.map((a) => ({
    index: a.subtaskIndex,
    subtask: a.subtask,
    data: a,
  }));

  const batches = buildExecutionBatches(batchItems);
  const allResults: SubtaskResult[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    send({
      type: "batchStart",
      batchIndex: batchIdx,
      totalBatches: batches.length,
      subtaskCount: batch.length,
    });

    // Run batch with concurrency limiter
    const semaphore = new Semaphore(maxAgents);
    const batchPromises = batch.map(async (item) => {
      await semaphore.acquire();
      try {
        return await executeSingleSubtask(
          item.data,
          agents,
          context,
          config,
          cost,
        );
      } finally {
        semaphore.release();
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);

    for (let i = 0; i < batch.length; i++) {
      const result = batchResults[i];
      const assignment = batch[i].data;

      if (result.status === "fulfilled") {
        allResults.push(result.value);
      } else {
        allResults.push({
          subtaskIndex: assignment.subtaskIndex,
          description: assignment.subtask.description,
          region: assignment.subtask.region,
          agentId: assignment.agentId,
          status: "failed",
          agentOutput: "",
          failureReason: String(result.reason),
          costTokens: 0,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6. Evaluate and record
  // -----------------------------------------------------------------------
  send({ type: "state", state: "evaluating" });

  const evaluatedResults = await evaluateResults(allResults, agents, cost);

  // Record to database
  await recordResults(workspacePath, userIntent, assignments, evaluatedResults, cost, runId, runStart);

  // Fire-and-forget background region insight refresh (non-blocking)
  const touchedRegions = [...new Set(assignments.map((a) => a.subtask.region))];
  const insightModel =
    process.env.EISEN_ORCHESTRATOR_MODEL ?? "anthropic/claude-sonnet-4-20250514";
  const insightDb = new WorkspaceDB(workspacePath);
  void refreshStaleRegionInsights(insightDb, workspacePath, touchedRegions, insightModel).finally(
    () => insightDb.close(),
  );

  const allCompleted = evaluatedResults.every((r) => r.status === "completed");
  const output: OrchestrationOutput = {
    status: allCompleted ? "completed" : "done",
    subtaskResults: evaluatedResults,
    totalTokens: cost.totalTokens,
    orchestratorTokens: cost.orchestratorTokens,
  };

  send({ type: "result", ...output });
  return output;
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

async function assignAgents(
  subtasks: Subtask[],
  agents: OrchestratorAgents,
  context: WorkspaceContext,
  workspacePath: string,
  cost: CostTracker,
): Promise<AgentAssignment[]> {
  const assignments: AgentAssignment[] = [];

  for (let i = 0; i < subtasks.length; i++) {
    const subtask = subtasks[i];
    const language = detectLanguage(subtask.region);

    // Check if DB has a confident agent recommendation
    const dbBest = findBestAgentFromStats(
      context.agentStats,
      subtask.region,
      language,
    );

    if (dbBest) {
      assignments.push({
        subtask,
        subtaskIndex: i,
        agentId: dbBest,
      });
      continue;
    }

    // Fall back to LLM selection
    const statsInfo = formatAgentStats(context.agentStats, subtask.region, language);
    const prompt = [
      `Subtask: ${subtask.description}`,
      `Region: ${subtask.region}`,
      `Primary language: ${language}`,
      `Available agents: opencode, claude-code, codex, gemini, goose, amp, aider`,
      statsInfo ? `\nPerformance data:\n${statsInfo}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await agents.agentSelect.generate(prompt, {
      structuredOutput: { schema: AgentSelectOutputSchema },
    });

    cost.record("orchestrator", 0, "AgentSelect");
    assignments.push({
      subtask,
      subtaskIndex: i,
      agentId: (result.object as AgentSelectOutput).agentId,
    });
  }

  return assignments;
}

async function executeSingleSubtask(
  assignment: AgentAssignment,
  agents: OrchestratorAgents,
  context: WorkspaceContext,
  config: OrchestrationConfig,
  cost: CostTracker,
): Promise<SubtaskResult> {
  const { subtask, subtaskIndex, agentId } = assignment;
  const { send } = config;

  send({
    type: "progress",
    subtaskIndex,
    agentId,
    status: "running",
  });

  // Build prompt for the coding agent
  const regionInsight = context.regionInsights.find((r) => r.region === subtask.region);
  const promptInput = [
    `Subtask: ${subtask.description}`,
    `Region: ${subtask.region}`,
    `Expected files: ${subtask.expectedFiles.join(", ")}`,
    `Effort level: ${config.effort}`,
    regionInsight?.description ? `\nRegion description: ${regionInsight.description}` : "",
    regionInsight?.conventions ? `\nConventions: ${regionInsight.conventions}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const promptResult = await agents.promptBuild.generate(promptInput, {
    structuredOutput: { schema: PromptBuildOutputSchema },
  });

  cost.record("orchestrator", 0, "PromptBuild");

  let agentPrompt = (promptResult.object as PromptBuildOutput).agentPrompt;

  // Append zone-enforcement instruction
  agentPrompt += `\n\nIMPORTANT: You are working within the region '${subtask.region}'. ` +
    `If you need information about types, functions, or APIs from outside ` +
    `your region, describe what you need instead of reading those files directly. ` +
    `The orchestrator will provide the information you need.`;

  // Execute via ACP client if available
  if (config.createACPClient) {
    try {
      const agentOutput = await executeViaACP(
        config,
        agentId,
        agentPrompt,
        subtask,
        cost,
      );

      send({
        type: "progress",
        subtaskIndex,
        agentId,
        status: "evaluating",
      });

      return {
        subtaskIndex,
        description: subtask.description,
        region: subtask.region,
        agentId,
        status: "completed", // Will be re-evaluated in evaluateResults
        agentOutput,
        costTokens: 0,
      };
    } catch (error) {
      return {
        subtaskIndex,
        description: subtask.description,
        region: subtask.region,
        agentId,
        status: "failed",
        agentOutput: "",
        failureReason: error instanceof Error ? error.message : String(error),
        costTokens: 0,
      };
    }
  }

  // No ACP client — return the prompt as output (useful for testing)
  return {
    subtaskIndex,
    description: subtask.description,
    region: subtask.region,
    agentId,
    status: "completed",
    agentOutput: `[No ACP client] Prompt built:\n${agentPrompt}`,
    costTokens: 0,
  };
}

async function executeViaACP(
  config: OrchestrationConfig,
  agentId: string,
  prompt: string,
  subtask: Subtask,
  cost: CostTracker,
): Promise<string> {
  const client = config.createACPClient!(agentId);
  const zones = SharedZoneConfig.fromWorkspace(config.workspacePath);
  const zonePatterns = [
    `${subtask.region}/**`,
    ...zones.getAllPatterns(),
  ];

  try {
    await client.connect();
    const session = await client.newSession(config.workspacePath);

    // TODO: Stream output back via send() for real-time UI updates.
    // For now we collect the full response.
    const response = await client.sendMessage(prompt);

    cost.record(agentId, 0, subtask.description, subtask.description, subtask.region);

    return typeof response === "string" ? response : JSON.stringify(response);
  } finally {
    try {
      client.dispose();
    } catch {
      // Ignore cleanup errors
    }
  }
}

async function evaluateResults(
  results: SubtaskResult[],
  agents: OrchestratorAgents,
  cost: CostTracker,
): Promise<SubtaskResult[]> {
  const evaluated: SubtaskResult[] = [];

  for (const result of results) {
    // Skip already-failed results (no agent output to evaluate)
    if (result.status === "failed" && !result.agentOutput) {
      evaluated.push(result);
      continue;
    }

    try {
      const evalInput = [
        `Subtask: ${result.description}`,
        `Agent output (truncated):\n${result.agentOutput.slice(0, 4000)}`,
        `Expected files: ${result.region}`,
      ].join("\n\n");

      const evalResult = await agents.progressEval.generate(evalInput, {
        structuredOutput: { schema: ProgressEvalOutputSchema },
      });

      cost.record("orchestrator", 0, "ProgressEval");

      const evalObj = evalResult.object as ProgressEvalOutput;
      evaluated.push({
        ...result,
        status: evalObj.status,
        failureReason: evalObj.failureReason ?? null,
        suggestedRetry: evalObj.suggestedRetry ?? null,
      });
    } catch {
      // If evaluation fails, keep the original status
      evaluated.push(result);
    }
  }

  return evaluated;
}

async function recordResults(
  workspacePath: string,
  userIntent: string,
  assignments: AgentAssignment[],
  results: SubtaskResult[],
  cost: CostTracker,
  runId: string,
  runStart: number,
): Promise<void> {
  const db = new WorkspaceDB(workspacePath);

  try {
    // Record task history
    const completed = results.filter((r) => r.status === "completed").length;
    const qualityScore = results.length > 0 ? completed / results.length : 0;

    await db.insertTaskHistory({
      id: runId,
      userIntent,
      subtasksJson: JSON.stringify(assignments.map((a) => a.subtask)),
      assignmentsJson: JSON.stringify(assignments.map((a) => ({
        subtaskIndex: a.subtaskIndex,
        agentId: a.agentId,
      }))),
      resultsJson: JSON.stringify(results),
      qualityScore,
      totalTokens: cost.totalTokens,
      orchestratorTokens: cost.orchestratorTokens,
      durationMs: Date.now() - runStart,
      timestamp: Date.now(),
    });

    // Record agent performance
    for (const result of results) {
      const assignment = assignments.find((a) => a.subtaskIndex === result.subtaskIndex);
      if (!assignment) continue;

      const language = detectLanguage(assignment.subtask.region);
      await db.upsertAgentPerformance({
        agentType: result.agentId,
        region: assignment.subtask.region,
        language,
        success: result.status === "completed",
        tokens: result.costTokens,
        durationMs: 0, // TODO: track per-subtask duration
      });
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect primary language from a workspace region path. */
function detectLanguage(region: string): string {
  const r = region.replace(/^\//, "").toLowerCase();
  if (r.includes("core") || r.endsWith(".rs") || r.startsWith("crates/")) return "rust";
  if (r.includes("ui") || r.includes("extension") || r.endsWith(".ts") || r.endsWith(".tsx")) return "typescript";
  if (r.includes("agent") || r.includes("py") || r.endsWith(".py")) return "python";
  if (r.includes("app") || r.includes("src")) return "typescript"; // default for app/src dirs
  return "unknown";
}

/** Infer task type from region path (mirrors Python _infer_task_type). */
function inferTaskType(region: string): string {
  const r = region.replace(/^\//, "").toLowerCase();
  if (["ui", "frontend", "views", "components"].some((k) => r.includes(k))) return "ui";
  if (["test", "spec", "__tests__"].some((k) => r.includes(k))) return "tests";
  if (["config", ".config", "settings"].some((k) => r.includes(k))) return "config";
  if (["core", "backend", "server", "api"].some((k) => r.includes(k))) return "backend";
  if (["lib", "utils", "shared", "common"].some((k) => r.includes(k))) return "library";
  return "general";
}

/** Find the best agent from performance stats if confident enough. */
function findBestAgentFromStats(
  stats: AgentPerformance[],
  region: string,
  language: string,
): string | null {
  const matching = stats.filter(
    (s) => s.region === region && s.language === language,
  );

  for (const stat of matching) {
    const total = stat.successCount + stat.failCount;
    if (total >= 3) {
      const successRate = stat.successCount / total;
      if (successRate > 0.8) {
        return stat.agentType;
      }
    }
  }

  return null;
}

/** Format agent stats for LLM context injection. */
function formatAgentStats(
  stats: AgentPerformance[],
  region: string,
  language: string,
): string {
  const relevant = stats.filter(
    (s) => s.region === region || s.language === language,
  );
  if (relevant.length === 0) return "";

  return relevant
    .map((s) => {
      const total = s.successCount + s.failCount;
      const rate = total > 0 ? ((s.successCount / total) * 100).toFixed(0) : "N/A";
      return `  ${s.agentType}: ${rate}% success (${total} runs, ${s.language}, ${s.region})`;
    })
    .join("\n");
}

type AgentPerformance = import("../db").AgentPerformance;

// ---------------------------------------------------------------------------
// Semaphore (simple async concurrency limiter)
// ---------------------------------------------------------------------------

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.limit) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}
