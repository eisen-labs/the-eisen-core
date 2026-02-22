/**
 * Unit tests for the workflow module.
 *
 * Tests the non-LLM parts: schemas, topo-sort, cost-tracker, zones,
 * and context-loader helpers. LLM-dependent tests (agents, full orchestrate)
 * require API keys and are covered by integration tests.
 */

import { describe, test, expect } from "bun:test";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

import {
  SubtaskSchema,
  DecomposeOutputSchema,
  AgentSelectOutputSchema,
  PromptBuildOutputSchema,
  ProgressEvalOutputSchema,
  OrchestrationInputSchema,
  SubtaskResultSchema,
  OrchestrationOutputSchema,
  EffortLevel,
} from "../src/workflow/schemas";

describe("Zod Schemas", () => {
  test("SubtaskSchema validates correct input", () => {
    const result = SubtaskSchema.safeParse({
      description: "Add auth middleware",
      region: "src/middleware",
      expectedFiles: ["src/middleware/auth.ts"],
      dependsOn: [0],
    });
    expect(result.success).toBe(true);
  });

  test("SubtaskSchema rejects missing fields", () => {
    const result = SubtaskSchema.safeParse({
      description: "Add auth",
    });
    expect(result.success).toBe(false);
  });

  test("DecomposeOutputSchema validates complete output", () => {
    const result = DecomposeOutputSchema.safeParse({
      subtasks: [
        {
          description: "Implement login",
          region: "src/auth",
          expectedFiles: ["src/auth/login.ts"],
          dependsOn: [],
        },
      ],
      reasoning: "Single subtask because the change is localized",
    });
    expect(result.success).toBe(true);
  });

  test("AgentSelectOutputSchema validates", () => {
    const result = AgentSelectOutputSchema.safeParse({
      agentId: "claude-code",
      reasoning: "Best for TypeScript tasks",
    });
    expect(result.success).toBe(true);
  });

  test("PromptBuildOutputSchema validates", () => {
    const result = PromptBuildOutputSchema.safeParse({
      agentPrompt: "Please implement the following...",
    });
    expect(result.success).toBe(true);
  });

  test("ProgressEvalOutputSchema validates completed", () => {
    const result = ProgressEvalOutputSchema.safeParse({
      status: "completed",
    });
    expect(result.success).toBe(true);
  });

  test("ProgressEvalOutputSchema validates failed with reason", () => {
    const result = ProgressEvalOutputSchema.safeParse({
      status: "failed",
      failureReason: "Tests did not pass",
      suggestedRetry: "Fix the test assertions",
    });
    expect(result.success).toBe(true);
  });

  test("ProgressEvalOutputSchema rejects invalid status", () => {
    const result = ProgressEvalOutputSchema.safeParse({
      status: "unknown",
    });
    expect(result.success).toBe(false);
  });

  test("EffortLevel validates enum values", () => {
    expect(EffortLevel.safeParse("low").success).toBe(true);
    expect(EffortLevel.safeParse("medium").success).toBe(true);
    expect(EffortLevel.safeParse("high").success).toBe(true);
    expect(EffortLevel.safeParse("extreme").success).toBe(false);
  });

  test("OrchestrationInputSchema has defaults", () => {
    const result = OrchestrationInputSchema.parse({
      userIntent: "Add dark mode",
      workspacePath: "/project",
    });
    expect(result.effort).toBe("medium");
    expect(result.autoApprove).toBe(false);
  });

  test("SubtaskResultSchema validates with defaults", () => {
    const result = SubtaskResultSchema.parse({
      subtaskIndex: 0,
      description: "task",
      region: "src/",
      agentId: "opencode",
      status: "completed",
      agentOutput: "done",
    });
    expect(result.costTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Topological sort tests
// ---------------------------------------------------------------------------

import { buildExecutionBatches, type BatchItem } from "../src/workflow/topo-sort";

function makeBatchItem(
  index: number,
  dependsOn: number[] = [],
): BatchItem<string> {
  return {
    index,
    subtask: {
      description: `Task ${index}`,
      region: `src/region-${index}`,
      expectedFiles: [],
      dependsOn,
    },
    data: `task-${index}`,
  };
}

describe("buildExecutionBatches", () => {
  test("empty input returns empty", () => {
    expect(buildExecutionBatches([])).toEqual([]);
  });

  test("single item returns single batch", () => {
    const batches = buildExecutionBatches([makeBatchItem(0)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].index).toBe(0);
  });

  test("independent items all in batch 0", () => {
    const items = [makeBatchItem(0), makeBatchItem(1), makeBatchItem(2)];
    const batches = buildExecutionBatches(items);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  test("linear chain produces N batches", () => {
    const items = [
      makeBatchItem(0),
      makeBatchItem(1, [0]),
      makeBatchItem(2, [1]),
    ];
    const batches = buildExecutionBatches(items);
    expect(batches).toHaveLength(3);
    expect(batches[0][0].index).toBe(0);
    expect(batches[1][0].index).toBe(1);
    expect(batches[2][0].index).toBe(2);
  });

  test("diamond dependency", () => {
    // 0 -> 1, 0 -> 2, 1+2 -> 3
    const items = [
      makeBatchItem(0),
      makeBatchItem(1, [0]),
      makeBatchItem(2, [0]),
      makeBatchItem(3, [1, 2]),
    ];
    const batches = buildExecutionBatches(items);
    expect(batches).toHaveLength(3);
    expect(batches[0].map((b) => b.index)).toEqual([0]);
    expect(batches[1].map((b) => b.index).sort()).toEqual([1, 2]);
    expect(batches[2].map((b) => b.index)).toEqual([3]);
  });

  test("circular dependency doesn't hang", () => {
    const items = [
      makeBatchItem(0, [1]),
      makeBatchItem(1, [0]),
    ];
    // Should not throw or infinite loop
    const batches = buildExecutionBatches(items);
    expect(batches.length).toBeGreaterThan(0);
  });

  test("missing dependency is ignored", () => {
    const items = [makeBatchItem(0, [99])]; // dep 99 doesn't exist
    const batches = buildExecutionBatches(items);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CostTracker tests
// ---------------------------------------------------------------------------

import { CostTracker } from "../src/workflow/cost-tracker";

describe("CostTracker", () => {
  test("starts empty", () => {
    const ct = new CostTracker();
    expect(ct.totalTokens).toBe(0);
    expect(ct.orchestratorTokens).toBe(0);
  });

  test("accumulates tokens", () => {
    const ct = new CostTracker();
    ct.record("orchestrator", 100, "TaskDecompose");
    ct.record("orchestrator", 50, "AgentSelect");
    ct.record("claude-code", 1000, "subtask-1");
    expect(ct.totalTokens).toBe(1150);
    expect(ct.orchestratorTokens).toBe(150);
  });

  test("breakdown groups by source", () => {
    const ct = new CostTracker();
    ct.record("orchestrator", 100, "a");
    ct.record("opencode", 200, "b");
    ct.record("orchestrator", 50, "c");
    const bd = ct.breakdown();
    expect(bd["orchestrator"]).toBe(150);
    expect(bd["opencode"]).toBe(200);
  });

  test("summary is human-readable", () => {
    const ct = new CostTracker();
    ct.record("orchestrator", 500, "test");
    const summary = ct.summary();
    expect(summary).toContain("500");
    expect(summary).toContain("orchestrator");
  });

  test("reset clears entries", () => {
    const ct = new CostTracker();
    ct.record("orchestrator", 100, "a");
    ct.reset();
    expect(ct.totalTokens).toBe(0);
    expect(ct.getEntries()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SharedZoneConfig tests
// ---------------------------------------------------------------------------

import { SharedZoneConfig, DEFAULT_SHARED_ZONES } from "../src/workflow/zones";

describe("SharedZoneConfig", () => {
  test("defaults include standard patterns", () => {
    const zones = new SharedZoneConfig();
    const patterns = zones.getAllPatterns();
    expect(patterns).toContain("package.json");
    expect(patterns).toContain("tsconfig.json");
    expect(patterns).toContain("Cargo.toml");
    expect(patterns.length).toBe(DEFAULT_SHARED_ZONES.length);
  });

  test("custom patterns are appended", () => {
    const zones = new SharedZoneConfig({
      customPatterns: ["custom/**"],
    });
    const patterns = zones.getAllPatterns();
    expect(patterns).toContain("custom/**");
    expect(patterns.length).toBe(DEFAULT_SHARED_ZONES.length + 1);
  });

  test("useDefaults=false excludes defaults", () => {
    const zones = new SharedZoneConfig({
      useDefaults: false,
      customPatterns: ["my-file.json"],
    });
    const patterns = zones.getAllPatterns();
    expect(patterns).toEqual(["my-file.json"]);
  });

  test("fromWorkspace returns defaults for missing config", () => {
    const zones = SharedZoneConfig.fromWorkspace("/nonexistent/path");
    expect(zones.getAllPatterns().length).toBe(DEFAULT_SHARED_ZONES.length);
  });
});

// ---------------------------------------------------------------------------
// Context loader helpers test
// ---------------------------------------------------------------------------

import { formatContextForPrompt, extractFilesFromIntent } from "../src/workflow/context-loader";
import type { WorkspaceContext } from "../src/workflow/context-loader";

describe("formatContextForPrompt", () => {
  test("empty context returns empty string", () => {
    const ctx: WorkspaceContext = {
      workspaceTree: "",
      symbolIndex: "",
      similarTasks: [],
      cochangeHints: [],
      agentStats: [],
      regionInsights: [],
    };
    expect(formatContextForPrompt("test", ctx)).toBe("");
  });

  test("includes similar tasks", () => {
    const ctx: WorkspaceContext = {
      workspaceTree: "",
      symbolIndex: "",
      similarTasks: [
        {
          id: "1",
          userIntent: "Add auth middleware",
          subtasksJson: "[]",
          assignmentsJson: "[]",
          resultsJson: "[]",
          qualityScore: 0.95,
          totalTokens: 1000,
          orchestratorTokens: 200,
          durationMs: 5000,
          timestamp: Date.now(),
        },
      ],
      cochangeHints: [],
      agentStats: [],
      regionInsights: [],
    };
    const result = formatContextForPrompt("test intent", ctx);
    expect(result).toContain("Add auth middleware");
    expect(result).toContain("0.95");
  });

  test("includes co-change hints", () => {
    const ctx: WorkspaceContext = {
      workspaceTree: "",
      symbolIndex: "",
      similarTasks: [],
      cochangeHints: [
        {
          fileA: "src/api.ts",
          fileB: "src/types.ts",
          cochangeCount: 12,
          lastSeen: Date.now(),
        },
      ],
      agentStats: [],
      regionInsights: [],
    };
    const result = formatContextForPrompt("test", ctx);
    expect(result).toContain("src/api.ts");
    expect(result).toContain("src/types.ts");
    expect(result).toContain("12");
  });

  test("includes region insights", () => {
    const ctx: WorkspaceContext = {
      workspaceTree: "",
      symbolIndex: "",
      similarTasks: [],
      cochangeHints: [],
      agentStats: [],
      regionInsights: [
        {
          region: "src/api",
          description: "REST API layer with Express",
          conventions: null,
          dependencies: null,
          lastUpdated: Date.now(),
        },
      ],
    };
    const result = formatContextForPrompt("test", ctx);
    expect(result).toContain("src/api");
    expect(result).toContain("REST API layer");
  });
});

// ---------------------------------------------------------------------------
// extractFilesFromIntent
// ---------------------------------------------------------------------------

describe("extractFilesFromIntent", () => {
  test("extracts path with directory separator", () => {
    const files = extractFilesFromIntent("fix src/api/auth.ts");
    expect(files).toContain("src/api/auth.ts");
  });

  test("extracts tokens ending with a file extension", () => {
    const files = extractFilesFromIntent("update config.json and schema.ts");
    expect(files).toContain("config.json");
    expect(files).toContain("schema.ts");
  });

  test("ignores plain words without path or extension", () => {
    const files = extractFilesFromIntent("refactor the auth middleware");
    expect(files).toEqual([]);
  });

  test("handles empty string", () => {
    expect(extractFilesFromIntent("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatContextForPrompt — co-change hints (additional coverage)
// ---------------------------------------------------------------------------

describe("formatContextForPrompt with co-change hints", () => {
  test("hint lines appear in the output", () => {
    const ctx: WorkspaceContext = {
      workspaceTree: "",
      symbolIndex: "",
      similarTasks: [],
      cochangeHints: [
        {
          fileA: "src/db/schema.ts",
          fileB: "src/db/connection.ts",
          cochangeCount: 7,
          lastSeen: Date.now(),
        },
      ],
      agentStats: [],
      regionInsights: [],
    };
    const result = formatContextForPrompt("add migration", ctx);
    expect(result).toContain("src/db/schema.ts");
    expect(result).toContain("src/db/connection.ts");
    expect(result).toContain("7");
    expect(result).toContain("frequently change together");
  });
});

// ---------------------------------------------------------------------------
// Agent factory test (no LLM calls)
// ---------------------------------------------------------------------------

import { createAgents } from "../src/workflow/agents";

describe("createAgents", () => {
  test("creates four agents with correct IDs", () => {
    const agents = createAgents({ model: "openai/gpt-4o" });
    expect(agents.taskDecompose.id).toBe("task-decompose");
    expect(agents.agentSelect.id).toBe("agent-select");
    expect(agents.promptBuild.id).toBe("prompt-build");
    expect(agents.progressEval.id).toBe("progress-eval");
  });

  test("agents have correct names", () => {
    const agents = createAgents({ model: "anthropic/claude-sonnet-4-20250514" });
    expect(agents.taskDecompose.name).toBe("Task Decompose");
    expect(agents.agentSelect.name).toBe("Agent Select");
    expect(agents.promptBuild.name).toBe("Prompt Build");
    expect(agents.progressEval.name).toBe("Progress Eval");
  });
});
