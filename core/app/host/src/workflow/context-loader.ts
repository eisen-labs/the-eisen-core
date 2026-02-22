/**
 * Context loader — replaces Python ContextBuilder + SessionMemory.
 *
 * Queries the LibSQL workspace database and NAPI-RS parser to build
 * a structured context object for LLM calls. This is the first step
 * in the orchestration workflow.
 */

import { WorkspaceDB } from "../db";
import type {
  TaskHistoryEntry,
  FileCochange,
  AgentPerformance,
  RegionInsight,
} from "../db";
import { parseGitLog } from "../git";
import type { RawCommit } from "../git";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceContext {
  /** Parsed workspace tree (JSON string from NAPI-RS). */
  workspaceTree: string;
  /** Symbol index (JSON string from NAPI-RS). */
  symbolIndex: string;
  /** Similar past tasks (Jaccard-matched from task_history). */
  similarTasks: TaskHistoryEntry[];
  /** Co-change hints for affected regions. */
  cochangeHints: FileCochange[];
  /** Agent performance stats for relevant regions/languages. */
  agentStats: AgentPerformance[];
  /** Region descriptions and conventions. */
  regionInsights: RegionInsight[];
}

/**
 * Format a structured context block for injection into LLM system prompts.
 * This replaces the raw workspace dump approach with targeted, relevant context.
 */
export function formatContextForPrompt(
  userIntent: string,
  ctx: WorkspaceContext,
): string {
  const parts: string[] = [];

  // Similar past tasks
  if (ctx.similarTasks.length > 0) {
    parts.push("Relevant previous tasks:");
    for (const task of ctx.similarTasks.slice(0, 3)) {
      const quality = task.qualityScore != null ? ` (quality: ${task.qualityScore.toFixed(2)})` : "";
      parts.push(`  - "${task.userIntent.slice(0, 80)}"${quality}`);
    }
  }

  // Co-change hints
  if (ctx.cochangeHints.length > 0) {
    parts.push("\nFiles that frequently change together:");
    for (const hint of ctx.cochangeHints.slice(0, 5)) {
      parts.push(`  - ${hint.fileA} ↔ ${hint.fileB} (${hint.cochangeCount} times)`);
    }
  }

  // Region insights
  if (ctx.regionInsights.length > 0) {
    parts.push("\nRegion descriptions:");
    for (const insight of ctx.regionInsights) {
      if (insight.description) {
        parts.push(`  ${insight.region} — ${insight.description}`);
      }
    }
  }

  // Agent performance
  if (ctx.agentStats.length > 0) {
    parts.push("\nAgent performance:");
    for (const stat of ctx.agentStats.slice(0, 5)) {
      const total = stat.successCount + stat.failCount;
      const rate = total > 0 ? ((stat.successCount / total) * 100).toFixed(0) : "N/A";
      parts.push(
        `  - ${stat.agentType} in ${stat.region} (${stat.language}): ${rate}% success (${total} runs)`,
      );
    }
  }

  if (parts.length === 0) {
    return "";
  }

  return `Given the query "${userIntent}":\n\n${parts.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Git sync helpers
// ---------------------------------------------------------------------------

/**
 * Sync git history into the workspace DB.
 *
 * On first call (no prior timestamps) fetches the last 200 commits.
 * On subsequent calls fetches only commits newer than the latest stored one.
 * Co-change pairs are derived from newly inserted patterns.
 *
 * @param parseLog  Injected parser — defaults to `parseGitLog` (overridable in tests).
 */
export async function syncGitPatterns(
  db: WorkspaceDB,
  workspacePath: string,
  parseLog: (path: string, since?: number) => Promise<RawCommit[]> = parseGitLog,
): Promise<void> {
  const latestTs = await db.getLatestGitTimestamp();
  const commits = await parseLog(workspacePath, latestTs ?? undefined);
  if (commits.length === 0) return;
  await db.insertGitPatterns(commits);
  // Fetch back typed patterns (with real IDs) for co-change derivation
  const newPatterns = await db.getGitPatternsSince(latestTs ?? 0);
  await db.deriveCochangeFromPatterns(newPatterns);
}

// ---------------------------------------------------------------------------
// Context loader
// ---------------------------------------------------------------------------

/**
 * Load workspace context from LibSQL and (optionally) NAPI-RS.
 *
 * This is the `loadWorkspaceContext` workflow step. It:
 * 1. Opens the workspace database
 * 2. Checks workspace snapshot freshness (tree_hash)
 * 3. Queries similar past tasks (Jaccard)
 * 4. Queries co-change hints for affected regions
 * 5. Queries agent performance stats
 * 6. Queries region insights
 *
 * The NAPI-RS parseWorkspace call is optional — if the parser isn't
 * available (e.g. in tests), we fall back to cached data.
 */
export async function loadWorkspaceContext(
  workspacePath: string,
  userIntent: string,
  options?: {
    parseWorkspace?: (path: string) => unknown;
    snapshot?: (path: string) => unknown;
  },
): Promise<WorkspaceContext> {
  const db = new WorkspaceDB(workspacePath);

  // 1. Sync git patterns (non-critical — errors are swallowed)
  try {
    await syncGitPatterns(db, workspacePath);
  } catch {
    // Continue without git sync
  }

  let workspaceTree = "";
  let symbolIndex = "";

  try {
    // Try to use NAPI-RS parser if available
    if (options?.parseWorkspace) {
      const tree = options.parseWorkspace(workspacePath);
      workspaceTree = typeof tree === "string" ? tree : JSON.stringify(tree);
    }
    if (options?.snapshot) {
      const snap = options.snapshot(workspacePath);
      symbolIndex = typeof snap === "string" ? snap : JSON.stringify(snap);
    }
  } catch (e) {
    // Fall back to cached snapshot from DB
    const cached = await db.getLatestSnapshot();
    if (cached) {
      workspaceTree = cached.treeJson;
      symbolIndex = cached.symbolJson;
    }
  }

  // If we got fresh data, cache it
  if (workspaceTree && symbolIndex) {
    try {
      const hash = simpleHash(workspaceTree);
      const existing = await db.getSnapshotByHash(hash);
      if (!existing) {
        await db.saveSnapshot({
          treeHash: hash,
          treeJson: workspaceTree,
          symbolJson: symbolIndex,
          fileCount: countFiles(workspaceTree),
        });
      }
    } catch {
      // Non-critical — continue without caching
    }
  }

  // Query similar past tasks
  const similarTasks = await db.findSimilarTasks(userIntent, 5);

  // Query co-change hints — seed from similar task files AND intent tokens
  const seedFiles = [
    ...new Set([
      ...extractFilesFromTasks(similarTasks),
      ...extractFilesFromIntent(userIntent),
    ]),
  ];
  const cochangeHints = seedFiles.length > 0
    ? await db.getCochangeHints(seedFiles, 10)
    : [];

  // Query agent performance
  const agentStats = await db.getAgentPerformance();

  // Query region insights for regions mentioned in similar tasks
  const regions = extractRegionsFromTasks(similarTasks);
  const regionInsights = regions.length > 0
    ? await db.getRegionInsights(regions)
    : [];

  db.close();

  return {
    workspaceTree,
    symbolIndex,
    similarTasks,
    cochangeHints,
    agentStats,
    regionInsights,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple FNV-1a-like hash for tree strings. */
function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Count top-level files in a workspace tree JSON string. */
function countFiles(treeJson: string): number {
  try {
    const tree = JSON.parse(treeJson);
    if (Array.isArray(tree)) return tree.length;
    if (typeof tree === "object" && tree !== null) return Object.keys(tree).length;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Extract file-like tokens from a user intent string.
 * Matches tokens that contain a path separator or end with a common extension.
 */
export function extractFilesFromIntent(intent: string): string[] {
  return intent
    .split(/\s+/)
    .filter((t) => t.includes("/") || /\.[a-z]{2,4}$/.test(t));
}

/** Extract unique file paths from task history entries. */
function extractFilesFromTasks(tasks: TaskHistoryEntry[]): string[] {
  const files = new Set<string>();
  for (const task of tasks) {
    try {
      const subtasks = JSON.parse(task.subtasksJson);
      if (Array.isArray(subtasks)) {
        for (const st of subtasks) {
          const expectedFiles = st.expectedFiles ?? st.expected_files ?? [];
          for (const f of expectedFiles) {
            if (typeof f === "string") files.add(f);
          }
        }
      }
    } catch {
      // Skip malformed entries
    }
  }
  return [...files];
}

/** Extract unique region paths from task history entries. */
function extractRegionsFromTasks(tasks: TaskHistoryEntry[]): string[] {
  const regions = new Set<string>();
  for (const task of tasks) {
    try {
      const subtasks = JSON.parse(task.subtasksJson);
      if (Array.isArray(subtasks)) {
        for (const st of subtasks) {
          if (typeof st.region === "string") regions.add(st.region);
        }
      }
    } catch {
      // Skip
    }
  }
  return [...regions];
}
