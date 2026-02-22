/**
 * Mastra agents — one per DSPy signature.
 *
 * Each agent wraps a single LLM call with a system prompt and structured
 * output schema. They replace the DSPy ChainOfThought / Predict calls in
 * the Python orchestrator.
 *
 * Model selection: agents use a model string (e.g. "anthropic/claude-sonnet-4-20250514")
 * configured at workflow-init time. The `createAgents()` factory accepts
 * the model config so it can be changed per-workspace or per-user.
 *
 * Prompt overrides: if `optimizedPrompts` is provided (loaded from the
 * `optimized_prompts` DB table by scripts/optimize-prompts.ts), those
 * system prompts replace the static defaults below. Falls back gracefully
 * to the static defaults for any step that has not been optimized yet.
 *
 * Structured output is passed at generate() call time via `structuredOutput`
 * rather than at Agent construction time — this is the Mastra v1.5 pattern.
 */

import { Agent } from "@mastra/core/agent";
import type { OptimizedPromptStep } from "../db";
import { createMonitoredAgent, type PaidSignalData } from "../paid";

// ---------------------------------------------------------------------------
// Default static system prompts
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPTS: Record<OptimizedPromptStep, string> = {
  taskDecompose: `You are an expert software architect. Given a user's intent and workspace context, \
decompose the task into a minimal set of independent subtasks that can be assigned to coding agents.

Guidelines:
- Each subtask should target a specific workspace region (directory path).
- Include expected files that will be created or modified.
- Use dependsOn to express ordering constraints (index-based, 0-indexed).
- Prefer fewer, larger subtasks over many tiny ones.
- If the task is simple enough for a single agent, return exactly one subtask.
- The reasoning field should explain your decomposition strategy.`,

  agentSelect: `You are an agent assignment optimizer. Given a subtask description, workspace region, \
primary language, and a list of available agents (with optional performance stats), \
select the best agent for the job.

Guidelines:
- If the user's query explicitly names an agent (e.g. "use claude", "with codex", "run gemini"),
  always honour that preference and return that agent regardless of performance data.
- If performance stats show an agent with >80% success rate and >=3 samples for the
  given region/language combo, prefer that agent.
- Consider the agent's strengths: some agents are better at specific languages or task types.
- Available agents and their typical strengths:
    claude-code  — excellent at TypeScript/Python, large context, reasoning-heavy tasks
    opencode     — fast iteration, good general-purpose coding
    codex        — strong at Python and algorithmic tasks
    openai       — reliable across languages, good at structured output
    gemini       — strong at large context windows and multi-file refactors
    goose        — autonomous agentic tasks, shell-heavy workflows
    amp          — fast edits, good at targeted single-file changes
    aider        — git-aware, good at refactors with clear diffs
- The reasoning field should justify your choice.
- Return exactly one agentId from the available agents list.`,

  promptBuild: `You are a prompt engineer for coding agents. Given a subtask description, \
workspace region, file listing, cross-region dependencies, and effort level, \
construct a detailed, actionable prompt for the coding agent.

Guidelines:
- The prompt should be specific and self-contained — the agent has no other context.
- Include relevant file paths and expected changes.
- For "high" effort: include comprehensive test requirements and edge cases.
- For "medium" effort: include basic tests and main logic.
- For "low" effort: focus on the minimal change needed.
- Reference cross-region dependencies so the agent knows what interfaces to respect.
- State the coding conventions and language idioms the agent should follow.
- End with a clear, verifiable success criteria.`,

  progressEval: `You are a code review evaluator. Given a subtask description, the agent's output, \
and the list of files that were expected to change, evaluate whether the subtask \
was completed successfully.

Guidelines:
- "completed": The agent addressed the subtask fully. Files were modified as expected.
- "partial": The agent made progress but didn't finish. Some files may be missing changes.
- "failed": The agent did not address the subtask or produced errors.
- If failed or partial, provide a clear failureReason.
- If suggesting a retry, describe a different approach the agent should try.`,
};

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

export interface AgentModelConfig {
  /** AI SDK model string, e.g. "anthropic/claude-sonnet-4-20250514" or "openai/gpt-4o" */
  model: string;
  /**
   * Optional per-step system prompt overrides loaded from the `optimized_prompts`
   * DB table (written by scripts/optimize-prompts.ts). Any step not present here
   * falls back to the corresponding DEFAULT_PROMPTS entry.
   */
  optimizedPrompts?: Partial<Record<OptimizedPromptStep, string>>;
  /**
   * Optional Paid monitoring configuration. If provided, agents will send signals
   * to Paid for usage tracking and billing. Requires PAID_API_KEY env var.
   */
  paid?: {
    /** Customer identifier for Paid (e.g., workspace path or user ID) */
    customerId: string;
    /** Product identifier for Paid (e.g., "eisen-orchestrator") */
    productId: string;
  };
}

export interface OrchestratorAgents {
  taskDecompose: Agent<"task-decompose">;
  agentSelect: Agent<"agent-select">;
  promptBuild: Agent<"prompt-build">;
  progressEval: Agent<"progress-eval">;
}

/**
 * Create the four orchestrator agents with the given model config.
 *
 * Called once per orchestration run so that optimizedPrompts overrides
 * (which are loaded fresh from the DB per run) are always reflected.
 *
 * Structured output schemas are passed at generate() call time, not here.
 */
export function createAgents(config: AgentModelConfig): OrchestratorAgents {
  const p = config.optimizedPrompts ?? {};

  const taskDecompose = new Agent({
    id: "task-decompose",
    name: "Task Decompose",
    model: config.model,
    instructions: p.taskDecompose ?? DEFAULT_PROMPTS.taskDecompose,
  });

  const agentSelect = new Agent({
    id: "agent-select",
    name: "Agent Select",
    model: config.model,
    instructions: p.agentSelect ?? DEFAULT_PROMPTS.agentSelect,
  });

  const promptBuild = new Agent({
    id: "prompt-build",
    name: "Prompt Build",
    model: config.model,
    instructions: p.promptBuild ?? DEFAULT_PROMPTS.promptBuild,
  });

  const progressEval = new Agent({
    id: "progress-eval",
    name: "Progress Eval",
    model: config.model,
    instructions: p.progressEval ?? DEFAULT_PROMPTS.progressEval,
  });

  // Wrap with Paid monitoring if configured
  if (config.paid) {
    return {
      taskDecompose: createMonitoredAgent(taskDecompose, {
        eventName: "task_decompose",
        customerId: config.paid.customerId,
        productId: config.paid.productId,
      }),
      agentSelect: createMonitoredAgent(agentSelect, {
        eventName: "agent_select",
        customerId: config.paid.customerId,
        productId: config.paid.productId,
      }),
      promptBuild: createMonitoredAgent(promptBuild, {
        eventName: "prompt_build",
        customerId: config.paid.customerId,
        productId: config.paid.productId,
      }),
      progressEval: createMonitoredAgent(progressEval, {
        eventName: "progress_eval",
        customerId: config.paid.customerId,
        productId: config.paid.productId,
      }),
    };
  }

  return { taskDecompose, agentSelect, promptBuild, progressEval };
}
