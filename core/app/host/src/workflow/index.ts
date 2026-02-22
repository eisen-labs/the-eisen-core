/**
 * Workflow module — Mastra-based orchestration pipeline.
 *
 * Replaces the Python OrchestratorBridge with a pure TypeScript workflow
 * that runs in-process in the eisen-host Bun binary.
 */

// Schemas (Zod)
export {
  SubtaskSchema,
  DecomposeOutputSchema,
  AgentSelectOutputSchema,
  PromptBuildOutputSchema,
  ProgressEvalOutputSchema,
  EffortLevel,
  OrchestrationInputSchema,
  SubtaskResultSchema,
  OrchestrationOutputSchema,
} from "./schemas";

export type {
  Subtask,
  DecomposeOutput,
  AgentSelectOutput,
  PromptBuildOutput,
  ProgressEvalOutput,
  SubtaskResult,
  OrchestrationInput,
  OrchestrationOutput,
} from "./schemas";

// Agents
export { createAgents } from "./agents";
export type { AgentModelConfig, OrchestratorAgents } from "./agents";

// Workflow
export { orchestrate, executeAndEvaluate } from "./orchestrate";
export type { OrchestrationConfig, AgentAssignment, PendingApprovalData } from "./orchestrate";

// Supporting utilities
export { buildExecutionBatches } from "./topo-sort";
export type { BatchItem } from "./topo-sort";

export { CostTracker } from "./cost-tracker";
export type { CostEntry } from "./cost-tracker";

export { SharedZoneConfig, DEFAULT_SHARED_ZONES } from "./zones";
export type { SharedZoneOptions } from "./zones";

export { loadWorkspaceContext, formatContextForPrompt } from "./context-loader";
export type { WorkspaceContext } from "./context-loader";
