/**
 * Zod schemas — direct ports of the four DSPy signatures.
 *
 * Each schema defines the structured output contract for one Mastra agent.
 * The LLM returns typed JSON matching these schemas; no prompt-template hacks.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// TaskDecompose
// ---------------------------------------------------------------------------

/** A single subtask produced by decomposition. */
export const SubtaskSchema = z.object({
  description: z.string().describe("What the subtask should accomplish"),
  region: z.string().describe("Workspace-relative directory path this subtask operates in"),
  expectedFiles: z.array(z.string()).describe("Files expected to be created or modified"),
  dependsOn: z.array(z.number()).describe("Indices of subtasks that must complete first"),
});

export type Subtask = z.infer<typeof SubtaskSchema>;

/** Output of the TaskDecompose agent. */
export const DecomposeOutputSchema = z.object({
  subtasks: z.array(SubtaskSchema).describe("Ordered list of subtasks"),
  reasoning: z.string().describe("Explanation of why the task was split this way"),
});

export type DecomposeOutput = z.infer<typeof DecomposeOutputSchema>;

// ---------------------------------------------------------------------------
// AgentSelect
// ---------------------------------------------------------------------------

/** Output of the AgentSelect agent. */
export const AgentSelectOutputSchema = z.object({
  agentId: z.string().describe("ID of the selected agent (e.g. 'claude-code', 'opencode')"),
  reasoning: z.string().describe("Why this agent was chosen for the subtask"),
});

export type AgentSelectOutput = z.infer<typeof AgentSelectOutputSchema>;

// ---------------------------------------------------------------------------
// PromptBuild
// ---------------------------------------------------------------------------

/** Output of the PromptBuild agent. */
export const PromptBuildOutputSchema = z.object({
  agentPrompt: z.string().describe("The complete prompt to send to the coding agent"),
});

export type PromptBuildOutput = z.infer<typeof PromptBuildOutputSchema>;

// ---------------------------------------------------------------------------
// ProgressEval
// ---------------------------------------------------------------------------

/** Output of the ProgressEval agent. */
export const ProgressEvalOutputSchema = z.object({
  status: z.enum(["completed", "failed", "partial"]).describe("Outcome of the subtask"),
  failureReason: z.string().optional().describe("Why the subtask failed, if applicable"),
  suggestedRetry: z.string().optional().describe("Suggested approach for retrying, if applicable"),
});

export type ProgressEvalOutput = z.infer<typeof ProgressEvalOutputSchema>;

// ---------------------------------------------------------------------------
// Workflow I/O
// ---------------------------------------------------------------------------

export const EffortLevel = z.enum(["low", "medium", "high"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/** Input to the orchestrate workflow. */
export const OrchestrationInputSchema = z.object({
  userIntent: z.string(),
  workspacePath: z.string(),
  effort: EffortLevel.default("medium"),
  autoApprove: z.boolean().default(false),
});

export type OrchestrationInput = z.infer<typeof OrchestrationInputSchema>;

/** Result of a single subtask execution. */
export const SubtaskResultSchema = z.object({
  subtaskIndex: z.number(),
  description: z.string(),
  region: z.string(),
  agentId: z.string(),
  status: z.string(),
  agentOutput: z.string(),
  failureReason: z.string().nullable().optional(),
  suggestedRetry: z.string().nullable().optional(),
  costTokens: z.number().default(0),
});

export type SubtaskResult = z.infer<typeof SubtaskResultSchema>;

/** Final output of the orchestrate workflow. */
export const OrchestrationOutputSchema = z.object({
  status: z.string(),
  subtaskResults: z.array(SubtaskResultSchema),
  totalTokens: z.number(),
  orchestratorTokens: z.number(),
});

export type OrchestrationOutput = z.infer<typeof OrchestrationOutputSchema>;
