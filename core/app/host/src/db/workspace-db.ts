/**
 * WorkspaceDB — typed read/write interface over .eisen/workspace.db.
 *
 * This is the PlainWorkspaceDB implementation (free tier / development).
 * The SecureWorkspaceDB variant (LIBSQL_ENCRYPT.md) will wrap this with
 * AES-256-GCM encryption on sensitive columns — deferred.
 */

import type { Database } from "bun:sqlite";
import { getDatabase } from "./connection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshot {
  id: number;
  treeHash: string;
  treeJson: string;
  symbolJson: string;
  createdAt: number;
  fileCount: number;
}

export interface FileMeta {
  path: string;
  lastModified: number | null;
  lastParsed: number | null;
  changeFrequency: number;
  primaryLanguage: string | null;
  symbolCount: number;
  lineCount: number;
}

export interface GitPattern {
  id: number;
  commitHash: string;
  filesChanged: string[];
  commitMsg: string | null;
  author: string | null;
  timestamp: number;
}

export interface FileCochange {
  fileA: string;
  fileB: string;
  cochangeCount: number;
  lastSeen: number;
}

export interface TaskHistoryEntry {
  id: string;
  userIntent: string;
  subtasksJson: string;
  assignmentsJson: string;
  resultsJson: string;
  qualityScore: number | null;
  totalTokens: number | null;
  orchestratorTokens: number | null;
  durationMs: number | null;
  timestamp: number;
}

export interface AgentPerformance {
  agentType: string;
  region: string;
  language: string;
  taskType: string;
  successCount: number;
  failCount: number;
  totalTokens: number;
  totalDurationMs: number;
  lastUsed: number;
}

export interface RegionInsight {
  region: string;
  description: string | null;
  conventions: string | null;
  dependencies: string | null;
  lastUpdated: number;
}

export interface SymbolCacheEntry {
  symbolName: string;
  workspacePath: string;
  resultJson: string;
  fileMtime: number;
  cachedAt: number;
}

export type OptimizedPromptStep = "taskDecompose" | "agentSelect" | "promptBuild" | "progressEval";

export interface OptimizedPrompt {
  targetStep: OptimizedPromptStep;
  systemPrompt: string;
  generatedAt: number;
  repoProfile: string; // JSON
  model: string;
}

// ---------------------------------------------------------------------------
// WorkspaceDB
// ---------------------------------------------------------------------------

export class WorkspaceDB {
  private db: Database | null = null;
  private readonly workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /** Lazily initialise the database connection. */
  private async client(): Promise<Database> {
    if (!this.db) {
      this.db = await getDatabase(this.workspacePath);
    }
    return this.db;
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore double-close errors
      }
      this.db = null;
    }
  }

  // -------------------------------------------------------------------------
  // workspace_snapshots
  // -------------------------------------------------------------------------

  async getLatestSnapshot(): Promise<WorkspaceSnapshot | null> {
    const db = await this.client();
    const row = db
      .query("SELECT * FROM workspace_snapshots ORDER BY created_at DESC LIMIT 1")
      .get() as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToSnapshot(row);
  }

  async getSnapshotByHash(treeHash: string): Promise<WorkspaceSnapshot | null> {
    const db = await this.client();
    const row = db
      .query(
        "SELECT * FROM workspace_snapshots WHERE tree_hash = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(treeHash) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToSnapshot(row);
  }

  async saveSnapshot(data: {
    treeHash: string;
    treeJson: string;
    symbolJson: string;
    fileCount: number;
  }): Promise<void> {
    const db = await this.client();
    db.prepare(
      `INSERT INTO workspace_snapshots (tree_hash, tree_json, symbol_json, created_at, file_count)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(data.treeHash, data.treeJson, data.symbolJson, Date.now(), data.fileCount);
  }

  private rowToSnapshot(row: Record<string, unknown>): WorkspaceSnapshot {
    return {
      id: row.id as number,
      treeHash: row.tree_hash as string,
      treeJson: row.tree_json as string,
      symbolJson: row.symbol_json as string,
      createdAt: row.created_at as number,
      fileCount: row.file_count as number,
    };
  }

  // -------------------------------------------------------------------------
  // file_meta
  // -------------------------------------------------------------------------

  async getFileMeta(filePath: string): Promise<FileMeta | null> {
    const db = await this.client();
    const row = db.query("SELECT * FROM file_meta WHERE path = ?").get(filePath) as Record<
      string,
      unknown
    > | null;
    if (!row) return null;
    return this.rowToFileMeta(row);
  }

  async upsertFileMeta(data: {
    path: string;
    lastModified?: number;
    lastParsed?: number;
    changeFrequency?: number;
    primaryLanguage?: string;
    symbolCount?: number;
    lineCount?: number;
  }): Promise<void> {
    const db = await this.client();
    db.prepare(
      `INSERT INTO file_meta (path, last_modified, last_parsed, change_frequency, primary_language, symbol_count, line_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         last_modified = COALESCE(excluded.last_modified, file_meta.last_modified),
         last_parsed = COALESCE(excluded.last_parsed, file_meta.last_parsed),
         change_frequency = COALESCE(excluded.change_frequency, file_meta.change_frequency),
         primary_language = COALESCE(excluded.primary_language, file_meta.primary_language),
         symbol_count = COALESCE(excluded.symbol_count, file_meta.symbol_count),
         line_count = COALESCE(excluded.line_count, file_meta.line_count)`,
    ).run(
      data.path,
      data.lastModified ?? null,
      data.lastParsed ?? null,
      data.changeFrequency ?? 0,
      data.primaryLanguage ?? null,
      data.symbolCount ?? 0,
      data.lineCount ?? 0,
    );
  }

  /** Returns all file_meta entries whose path starts with `region/`. */
  async getFilesInRegion(region: string): Promise<FileMeta[]> {
    const db = await this.client();
    const rows = db
      .query("SELECT * FROM file_meta WHERE path LIKE ? || '/%'")
      .all(region) as Record<string, unknown>[];
    return rows.map((r) => this.rowToFileMeta(r));
  }

  async getStaleFiles(currentMtimes: Map<string, number>): Promise<string[]> {
    const db = await this.client();
    const rows = db.query("SELECT path, last_modified FROM file_meta").all() as Record<
      string,
      unknown
    >[];
    const stale: string[] = [];
    for (const row of rows) {
      const filePath = row.path as string;
      const storedMtime = row.last_modified as number | null;
      const currentMtime = currentMtimes.get(filePath);
      if (currentMtime !== undefined && storedMtime !== currentMtime) {
        stale.push(filePath);
      }
    }
    return stale;
  }

  private rowToFileMeta(row: Record<string, unknown>): FileMeta {
    return {
      path: row.path as string,
      lastModified: row.last_modified as number | null,
      lastParsed: row.last_parsed as number | null,
      changeFrequency: (row.change_frequency as number) ?? 0,
      primaryLanguage: row.primary_language as string | null,
      symbolCount: (row.symbol_count as number) ?? 0,
      lineCount: (row.line_count as number) ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // git_patterns
  // -------------------------------------------------------------------------

  async getLatestGitTimestamp(): Promise<number | null> {
    const db = await this.client();
    const row = db.query("SELECT MAX(timestamp) as max_ts FROM git_patterns").get() as Record<
      string,
      unknown
    > | null;
    if (!row) return null;
    return (row.max_ts as number) ?? null;
  }

  async insertGitPatterns(
    patterns: Array<{
      commitHash: string;
      filesChanged: string[];
      commitMsg: string | null;
      author: string | null;
      timestamp: number;
    }>,
  ): Promise<void> {
    const db = await this.client();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO git_patterns (commit_hash, files_changed, commit_msg, author, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const p of patterns) {
      stmt.run(p.commitHash, JSON.stringify(p.filesChanged), p.commitMsg, p.author, p.timestamp);
    }
  }

  /**
   * Returns commit patterns that touched any of the given file paths.
   * Fetches the 200 most recent patterns and filters in JS (SQLite has no
   * native JSON-array-contains operator).
   */
  async getRecentCommitsForFiles(filePaths: string[], limit: number = 10): Promise<GitPattern[]> {
    if (filePaths.length === 0) return [];
    const db = await this.client();
    const rows = db
      .query("SELECT * FROM git_patterns ORDER BY timestamp DESC LIMIT 200")
      .all() as Record<string, unknown>[];
    const pathSet = new Set(filePaths);
    return rows
      .map((r) => this.rowToGitPattern(r))
      .filter((p) => p.filesChanged.some((f) => pathSet.has(f)))
      .slice(0, limit);
  }

  async getGitPatternsSince(sinceTimestamp: number): Promise<GitPattern[]> {
    const db = await this.client();
    const rows = db
      .query("SELECT * FROM git_patterns WHERE timestamp > ? ORDER BY timestamp ASC")
      .all(sinceTimestamp) as Record<string, unknown>[];
    return rows.map((r) => this.rowToGitPattern(r));
  }

  private rowToGitPattern(row: Record<string, unknown>): GitPattern {
    return {
      id: row.id as number,
      commitHash: row.commit_hash as string,
      filesChanged: JSON.parse(row.files_changed as string),
      commitMsg: row.commit_msg as string | null,
      author: row.author as string | null,
      timestamp: row.timestamp as number,
    };
  }

  // -------------------------------------------------------------------------
  // file_cochange
  // -------------------------------------------------------------------------

  async upsertCochange(fileA: string, fileB: string, lastSeen: number): Promise<void> {
    const db = await this.client();
    // Normalise order so (a,b) and (b,a) are the same row
    const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
    db.prepare(
      `INSERT INTO file_cochange (file_a, file_b, cochange_count, last_seen)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(file_a, file_b) DO UPDATE SET
         cochange_count = file_cochange.cochange_count + 1,
         last_seen = excluded.last_seen`,
    ).run(a, b, lastSeen);
  }

  async getCochangeHints(filePaths: string[], limit: number = 10): Promise<FileCochange[]> {
    if (filePaths.length === 0) return [];
    const db = await this.client();
    const placeholders = filePaths.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT * FROM file_cochange
         WHERE file_a IN (${placeholders}) OR file_b IN (${placeholders})
         ORDER BY cochange_count DESC
         LIMIT ?`,
      )
      .all(...filePaths, ...filePaths, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      fileA: r.file_a as string,
      fileB: r.file_b as string,
      cochangeCount: r.cochange_count as number,
      lastSeen: r.last_seen as number,
    }));
  }

  /**
   * Derive co-change relationships from a set of git patterns.
   * For each commit with N files, creates N*(N-1)/2 co-change pairs.
   *
   * Commits touching more than MAX_COCHANGE_FILES files are skipped — these
   * are bulk refactors / renames that produce O(N²) low-signal pairs and
   * are the primary cause of table bloat.
   */
  async deriveCochangeFromPatterns(patterns: GitPattern[]): Promise<void> {
    const MAX_COCHANGE_FILES = 25;
    for (const pattern of patterns) {
      const files = pattern.filesChanged;
      // Skip large commits — they produce noisy, low-value pairs at O(N²) cost
      if (files.length > MAX_COCHANGE_FILES) continue;
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          await this.upsertCochange(files[i], files[j], pattern.timestamp);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // task_history
  // -------------------------------------------------------------------------

  async insertTaskHistory(entry: TaskHistoryEntry): Promise<void> {
    const db = await this.client();
    db.prepare(
      `INSERT OR REPLACE INTO task_history
       (id, user_intent, subtasks_json, assignments_json, results_json,
        quality_score, total_tokens, orchestrator_tokens, duration_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.userIntent,
      entry.subtasksJson,
      entry.assignmentsJson,
      entry.resultsJson,
      entry.qualityScore,
      entry.totalTokens,
      entry.orchestratorTokens,
      entry.durationMs,
      entry.timestamp,
    );
  }

  async getRecentTaskHistory(limit: number = 20): Promise<TaskHistoryEntry[]> {
    const db = await this.client();
    const rows = db
      .query("SELECT * FROM task_history ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToTaskHistory(r));
  }

  /**
   * Find tasks with similar intents using word overlap (Jaccard similarity).
   * Returns the top N most similar past tasks.
   */
  async findSimilarTasks(intent: string, limit: number = 5): Promise<TaskHistoryEntry[]> {
    const db = await this.client();
    const rows = db
      .query("SELECT * FROM task_history ORDER BY timestamp DESC LIMIT 200")
      .all() as Record<string, unknown>[];

    const intentWords = new Set(
      intent
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );

    const scored = rows
      .map((row) => {
        const entry = this.rowToTaskHistory(row);
        const entryWords = new Set(
          entry.userIntent
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2),
        );
        const intersection = new Set([...intentWords].filter((w) => entryWords.has(w)));
        const union = new Set([...intentWords, ...entryWords]);
        const jaccard = union.size > 0 ? intersection.size / union.size : 0;
        return { entry, jaccard };
      })
      .filter((s) => s.jaccard > 0.1)
      .sort((a, b) => b.jaccard - a.jaccard)
      .slice(0, limit);

    return scored.map((s) => s.entry);
  }

  private rowToTaskHistory(row: Record<string, unknown>): TaskHistoryEntry {
    return {
      id: row.id as string,
      userIntent: row.user_intent as string,
      subtasksJson: row.subtasks_json as string,
      assignmentsJson: row.assignments_json as string,
      resultsJson: row.results_json as string,
      qualityScore: row.quality_score as number | null,
      totalTokens: row.total_tokens as number | null,
      orchestratorTokens: row.orchestrator_tokens as number | null,
      durationMs: row.duration_ms as number | null,
      timestamp: row.timestamp as number,
    };
  }

  // -------------------------------------------------------------------------
  // agent_performance
  // -------------------------------------------------------------------------

  async upsertAgentPerformance(data: {
    agentType: string;
    region: string;
    language: string;
    taskType?: string;
    success: boolean;
    tokens: number;
    durationMs: number;
  }): Promise<void> {
    const db = await this.client();
    const successInc = data.success ? 1 : 0;
    const failInc = data.success ? 0 : 1;
    db.prepare(
      `INSERT INTO agent_performance
       (agent_type, region, language, task_type, success_count, fail_count,
        total_tokens, total_duration_ms, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_type, region, language) DO UPDATE SET
         success_count = agent_performance.success_count + excluded.success_count,
         fail_count = agent_performance.fail_count + excluded.fail_count,
         total_tokens = agent_performance.total_tokens + excluded.total_tokens,
         total_duration_ms = agent_performance.total_duration_ms + excluded.total_duration_ms,
         last_used = excluded.last_used`,
    ).run(
      data.agentType,
      data.region,
      data.language,
      data.taskType ?? "",
      successInc,
      failInc,
      data.tokens,
      data.durationMs,
      Date.now(),
    );
  }

  async getAgentPerformance(region?: string, language?: string): Promise<AgentPerformance[]> {
    const db = await this.client();
    let sql = "SELECT * FROM agent_performance";
    const args: (string | number)[] = [];
    const conditions: string[] = [];

    if (region) {
      conditions.push("region = ?");
      args.push(region);
    }
    if (language) {
      conditions.push("language = ?");
      args.push(language);
    }
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY success_count DESC";

    const rows = db.query(sql).all(...args) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAgentPerformance(r));
  }

  /**
   * Get the best performing agent for a region+language combo.
   * Returns null if fewer than 3 samples exist.
   */
  async getBestAgent(
    region: string,
    language: string,
    minSamples: number = 3,
  ): Promise<AgentPerformance | null> {
    const db = await this.client();
    const row = db
      .query(
        `SELECT *, (CAST(success_count AS REAL) / MAX(success_count + fail_count, 1)) as success_rate
         FROM agent_performance
         WHERE region = ? AND language = ? AND (success_count + fail_count) >= ?
         ORDER BY success_rate DESC
         LIMIT 1`,
      )
      .get(region, language, minSamples) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToAgentPerformance(row);
  }

  private rowToAgentPerformance(row: Record<string, unknown>): AgentPerformance {
    return {
      agentType: row.agent_type as string,
      region: row.region as string,
      language: row.language as string,
      taskType: (row.task_type as string) ?? "",
      successCount: (row.success_count as number) ?? 0,
      failCount: (row.fail_count as number) ?? 0,
      totalTokens: (row.total_tokens as number) ?? 0,
      totalDurationMs: (row.total_duration_ms as number) ?? 0,
      lastUsed: row.last_used as number,
    };
  }

  // -------------------------------------------------------------------------
  // region_insights
  // -------------------------------------------------------------------------

  async getRegionInsight(region: string): Promise<RegionInsight | null> {
    const db = await this.client();
    const row = db
      .query("SELECT * FROM region_insights WHERE region = ?")
      .get(region) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToRegionInsight(row);
  }

  async getRegionInsights(regions: string[]): Promise<RegionInsight[]> {
    if (regions.length === 0) return [];
    const db = await this.client();
    const placeholders = regions.map(() => "?").join(",");
    const rows = db
      .query(`SELECT * FROM region_insights WHERE region IN (${placeholders})`)
      .all(...regions) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRegionInsight(r));
  }

  async upsertRegionInsight(data: {
    region: string;
    description?: string;
    conventions?: string;
    dependencies?: string;
  }): Promise<void> {
    const db = await this.client();
    db.prepare(
      `INSERT OR REPLACE INTO region_insights (region, description, conventions, dependencies, last_updated)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      data.region,
      data.description ?? null,
      data.conventions ?? null,
      data.dependencies ?? null,
      Date.now(),
    );
  }

  /**
   * Check which regions need insight refresh based on file changes.
   * Returns regions where >20% of files changed since last_updated.
   */
  async getStaleRegions(
    regionFileCounts: Map<string, { total: number; changed: number }>,
  ): Promise<string[]> {
    const stale: string[] = [];
    for (const [region, counts] of regionFileCounts) {
      if (counts.total > 0 && counts.changed / counts.total > 0.2) {
        stale.push(region);
      }
    }
    return stale;
  }

  private rowToRegionInsight(row: Record<string, unknown>): RegionInsight {
    return {
      region: row.region as string,
      description: row.description as string | null,
      conventions: row.conventions as string | null,
      dependencies: row.dependencies as string | null,
      lastUpdated: row.last_updated as number,
    };
  }

  // -------------------------------------------------------------------------
  // symbol_cache
  // -------------------------------------------------------------------------

  async getCachedSymbol(
    symbolName: string,
    workspacePath: string,
    currentMtime: number,
  ): Promise<string | null> {
    const db = await this.client();
    const row = db
      .query(
        "SELECT result_json, file_mtime FROM symbol_cache WHERE symbol_name = ? AND workspace_path = ?",
      )
      .get(symbolName, workspacePath) as Record<string, unknown> | null;
    if (!row) return null;
    // Invalidate if source file mtime changed
    if ((row.file_mtime as number) !== currentMtime) {
      db.prepare(
        "DELETE FROM symbol_cache WHERE symbol_name = ? AND workspace_path = ?",
      ).run(symbolName, workspacePath);
      return null;
    }
    return row.result_json as string;
  }

  async cacheSymbol(data: {
    symbolName: string;
    workspacePath: string;
    resultJson: string;
    fileMtime: number;
  }): Promise<void> {
    const db = await this.client();
    db.prepare(
      `INSERT OR REPLACE INTO symbol_cache
       (symbol_name, workspace_path, result_json, file_mtime, cached_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(data.symbolName, data.workspacePath, data.resultJson, data.fileMtime, Date.now());
  }

  async clearSymbolCache(): Promise<void> {
    const db = await this.client();
    db.exec("DELETE FROM symbol_cache");
  }

  // -------------------------------------------------------------------------
  // optimized_prompts
  // -------------------------------------------------------------------------

  /**
   * Read an optimized system prompt for a given orchestration step.
   * Returns null if no optimized prompt has been generated yet (caller
   * falls back to the static default in agents.ts).
   */
  async getOptimizedPrompt(targetStep: OptimizedPromptStep): Promise<OptimizedPrompt | null> {
    const db = await this.client();
    const row = db
      .query("SELECT * FROM optimized_prompts WHERE target_step = ?")
      .get(targetStep) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      targetStep: row.target_step as OptimizedPromptStep,
      systemPrompt: row.system_prompt as string,
      generatedAt: row.generated_at as number,
      repoProfile: row.repo_profile as string,
      model: row.model as string,
    };
  }

  /**
   * Read all optimized prompts at once (one query instead of four).
   * Returns a map of step → system prompt string for steps that have been optimized.
   */
  async getAllOptimizedPrompts(): Promise<Partial<Record<OptimizedPromptStep, string>>> {
    const db = await this.client();
    const rows = db
      .query("SELECT target_step, system_prompt FROM optimized_prompts")
      .all() as Record<string, unknown>[];
    const result: Partial<Record<OptimizedPromptStep, string>> = {};
    for (const row of rows) {
      result[row.target_step as OptimizedPromptStep] = row.system_prompt as string;
    }
    return result;
  }

  /** Write or replace an optimized prompt. Called by scripts/optimize-prompts.ts. */
  async upsertOptimizedPrompt(data: {
    targetStep: OptimizedPromptStep;
    systemPrompt: string;
    repoProfile: string;
    model: string;
  }): Promise<void> {
    const db = await this.client();
    db.prepare(
      `INSERT OR REPLACE INTO optimized_prompts
         (target_step, system_prompt, generated_at, repo_profile, model)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(data.targetStep, data.systemPrompt, Date.now(), data.repoProfile, data.model);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Run VACUUM to reclaim space in long-lived workspaces.
   * Should be called periodically (e.g. once per week).
   */
  async vacuum(): Promise<void> {
    const db = await this.client();
    db.exec("VACUUM");
  }

  /**
   * Clean up old data to keep the database lean.
   *
   * - task_history: keep last 500 entries
   * - git_patterns: keep last 1000 commits
   * - symbol_cache: evict entries older than 7 days
   * - file_cochange: keep top 500 pairs by frequency; drop pairs not seen in 90 days
   */
  async cleanup(): Promise<void> {
    const db = await this.client();
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;

    db.exec(
      `DELETE FROM task_history WHERE id NOT IN
       (SELECT id FROM task_history ORDER BY timestamp DESC LIMIT 500)`,
    );
    db.exec(
      `DELETE FROM git_patterns WHERE id NOT IN
       (SELECT id FROM git_patterns ORDER BY timestamp DESC LIMIT 1000)`,
    );
    db.prepare("DELETE FROM symbol_cache WHERE cached_at < ?").run(sevenDaysAgo);

    // Prune stale co-change pairs (not seen in 90 days)
    db.prepare("DELETE FROM file_cochange WHERE last_seen < ?").run(ninetyDaysAgo);
    // Keep only the top 500 most frequent pairs — the long tail is noise
    db.exec(
      `DELETE FROM file_cochange WHERE (file_a, file_b) NOT IN (
         SELECT file_a, file_b FROM file_cochange
         ORDER BY cochange_count DESC LIMIT 500
       )`,
    );
  }
}
