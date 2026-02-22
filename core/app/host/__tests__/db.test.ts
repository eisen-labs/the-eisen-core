/**
 * Integration tests for WorkspaceDB.
 *
 * Uses a temp directory so tests don't pollute the real workspace.
 * Run with: bun test app/host/__tests__/db.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceDB, closeAllDatabases, getDatabasePath } from "../src/db";

let tmpDir: string;
let db: WorkspaceDB;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eisen-db-test-"));
  db = new WorkspaceDB(tmpDir);
  // Force init by accessing via any method
  await db.getLatestSnapshot();
});

afterAll(() => {
  closeAllDatabases();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema & connection
// ---------------------------------------------------------------------------

describe("schema", () => {
  test("creates .eisen/workspace.db", () => {
    const dbPath = getDatabasePath(tmpDir);
    expect(fs.existsSync(dbPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// workspace_snapshots
// ---------------------------------------------------------------------------

describe("workspace_snapshots", () => {
  test("returns null when no snapshots exist", async () => {
    const snap = await db.getLatestSnapshot();
    expect(snap).toBeNull();
  });

  test("save and retrieve snapshot", async () => {
    await db.saveSnapshot({
      treeHash: "abc123",
      treeJson: '{"name":"root"}',
      symbolJson: '{"seq":0}',
      fileCount: 42,
    });

    const snap = await db.getLatestSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.treeHash).toBe("abc123");
    expect(snap!.fileCount).toBe(42);
  });

  test("getSnapshotByHash finds matching snapshot", async () => {
    const snap = await db.getSnapshotByHash("abc123");
    expect(snap).not.toBeNull();
    expect(snap!.treeJson).toBe('{"name":"root"}');
  });

  test("getSnapshotByHash returns null for unknown hash", async () => {
    const snap = await db.getSnapshotByHash("unknown");
    expect(snap).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// file_meta
// ---------------------------------------------------------------------------

describe("file_meta", () => {
  test("upsert and retrieve file metadata", async () => {
    await db.upsertFileMeta({
      path: "src/main.ts",
      lastModified: 1000,
      primaryLanguage: "typescript",
      symbolCount: 10,
      lineCount: 200,
    });

    const meta = await db.getFileMeta("src/main.ts");
    expect(meta).not.toBeNull();
    expect(meta!.primaryLanguage).toBe("typescript");
    expect(meta!.symbolCount).toBe(10);
  });

  test("upsert updates existing entry", async () => {
    await db.upsertFileMeta({
      path: "src/main.ts",
      lastModified: 2000,
      symbolCount: 15,
    });

    const meta = await db.getFileMeta("src/main.ts");
    expect(meta!.lastModified).toBe(2000);
    expect(meta!.symbolCount).toBe(15);
    expect(meta!.primaryLanguage).toBe("typescript");
  });

  test("getStaleFiles detects mtime changes", async () => {
    const mtimes = new Map([["src/main.ts", 9999]]);
    const stale = await db.getStaleFiles(mtimes);
    expect(stale).toContain("src/main.ts");
  });
});

// ---------------------------------------------------------------------------
// git_patterns & file_cochange
// ---------------------------------------------------------------------------

describe("git_patterns", () => {
  test("insert and query git patterns", async () => {
    await db.insertGitPatterns([
      {
        commitHash: "aaa111",
        filesChanged: ["src/a.ts", "src/b.ts"],
        commitMsg: "feat: add feature",
        author: "dev",
        timestamp: 1000,
      },
      {
        commitHash: "bbb222",
        filesChanged: ["src/a.ts", "src/c.ts"],
        commitMsg: "fix: bug",
        author: "dev",
        timestamp: 2000,
      },
    ]);

    const latest = await db.getLatestGitTimestamp();
    expect(latest).toBe(2000);

    const since = await db.getGitPatternsSince(1500);
    expect(since.length).toBe(1);
    expect(since[0].commitHash).toBe("bbb222");
  });

  test("duplicate commit hashes are ignored", async () => {
    await db.insertGitPatterns([
      {
        commitHash: "aaa111",
        filesChanged: ["src/x.ts"],
        commitMsg: "dupe",
        author: "dev",
        timestamp: 3000,
      },
    ]);
    const all = await db.getGitPatternsSince(0);
    const aaa = all.find((p) => p.commitHash === "aaa111");
    expect(aaa!.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("file_cochange", () => {
  test("derive and query cochange relationships", async () => {
    const patterns = await db.getGitPatternsSince(0);
    await db.deriveCochangeFromPatterns(patterns);

    const hints = await db.getCochangeHints(["src/a.ts"]);
    expect(hints.length).toBeGreaterThan(0);

    const ab = hints.find(
      (h) =>
        (h.fileA === "src/a.ts" && h.fileB === "src/b.ts") ||
        (h.fileA === "src/b.ts" && h.fileB === "src/a.ts"),
    );
    expect(ab).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// task_history
// ---------------------------------------------------------------------------

describe("task_history", () => {
  test("insert and retrieve task history", async () => {
    await db.insertTaskHistory({
      id: "run-001",
      userIntent: "refactor the auth middleware",
      subtasksJson: "[]",
      assignmentsJson: "{}",
      resultsJson: "[]",
      qualityScore: 0.95,
      totalTokens: 5000,
      orchestratorTokens: 200,
      durationMs: 12000,
      timestamp: Date.now(),
    });

    const recent = await db.getRecentTaskHistory(10);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0].id).toBe("run-001");
  });

  test("findSimilarTasks returns relevant matches", async () => {
    await db.insertTaskHistory({
      id: "run-002",
      userIntent: "add rate limiting to the auth middleware",
      subtasksJson: "[]",
      assignmentsJson: "{}",
      resultsJson: "[]",
      qualityScore: 0.8,
      totalTokens: 3000,
      orchestratorTokens: 100,
      durationMs: 8000,
      timestamp: Date.now(),
    });

    const similar = await db.findSimilarTasks("refactor auth middleware");
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].id).toBe("run-001");
  });
});

// ---------------------------------------------------------------------------
// agent_performance
// ---------------------------------------------------------------------------

describe("agent_performance", () => {
  test("upsert and query agent performance", async () => {
    await db.upsertAgentPerformance({
      agentType: "claude-code",
      region: "src/api",
      language: "typescript",
      success: true,
      tokens: 8000,
      durationMs: 5000,
    });
    await db.upsertAgentPerformance({
      agentType: "claude-code",
      region: "src/api",
      language: "typescript",
      success: true,
      tokens: 7000,
      durationMs: 4000,
    });
    await db.upsertAgentPerformance({
      agentType: "claude-code",
      region: "src/api",
      language: "typescript",
      success: false,
      tokens: 10000,
      durationMs: 6000,
    });

    const perf = await db.getAgentPerformance("src/api", "typescript");
    expect(perf.length).toBe(1);
    expect(perf[0].successCount).toBe(2);
    expect(perf[0].failCount).toBe(1);
    expect(perf[0].totalTokens).toBe(25000);
  });

  test("getBestAgent with minimum samples", async () => {
    const best = await db.getBestAgent("src/api", "typescript", 3);
    expect(best).not.toBeNull();
    expect(best!.agentType).toBe("claude-code");
  });

  test("getBestAgent returns null with insufficient samples", async () => {
    const best = await db.getBestAgent("src/api", "typescript", 100);
    expect(best).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// region_insights
// ---------------------------------------------------------------------------

describe("region_insights", () => {
  test("upsert and retrieve region insight", async () => {
    await db.upsertRegionInsight({
      region: "src/api",
      description: "REST API layer",
      conventions: "Express middleware pattern",
      dependencies: '["express","cors"]',
    });

    const insight = await db.getRegionInsight("src/api");
    expect(insight).not.toBeNull();
    expect(insight!.description).toBe("REST API layer");
  });

  test("getRegionInsights batch query", async () => {
    await db.upsertRegionInsight({
      region: "src/db",
      description: "Database layer",
    });

    const insights = await db.getRegionInsights(["src/api", "src/db", "src/unknown"]);
    expect(insights.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// symbol_cache
// ---------------------------------------------------------------------------

describe("symbol_cache", () => {
  test("cache and retrieve symbol", async () => {
    await db.cacheSymbol({
      symbolName: "SymbolTree",
      workspacePath: "/ws",
      resultJson: '[{"name":"SymbolTree"}]',
      fileMtime: 1000,
    });

    const cached = await db.getCachedSymbol("SymbolTree", "/ws", 1000);
    expect(cached).toBe('[{"name":"SymbolTree"}]');
  });

  test("invalidates on mtime change", async () => {
    const cached = await db.getCachedSymbol("SymbolTree", "/ws", 2000);
    expect(cached).toBeNull();
  });

  test("clearSymbolCache removes all entries", async () => {
    await db.cacheSymbol({
      symbolName: "Foo",
      workspacePath: "/ws",
      resultJson: "[]",
      fileMtime: 1000,
    });
    await db.clearSymbolCache();
    const cached = await db.getCachedSymbol("Foo", "/ws", 1000);
    expect(cached).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getFilesInRegion
// ---------------------------------------------------------------------------

describe("getFilesInRegion", () => {
  test("returns only files whose path starts with region/", async () => {
    await db.upsertFileMeta({ path: "src/api/handler.ts", lastModified: 1000 });
    await db.upsertFileMeta({ path: "src/db/schema.ts", lastModified: 2000 });

    const apiFiles = await db.getFilesInRegion("src/api");
    const paths = apiFiles.map((f) => f.path);
    expect(paths).toContain("src/api/handler.ts");
    expect(paths).not.toContain("src/db/schema.ts");
  });

  test("returns empty array when no files match", async () => {
    const files = await db.getFilesInRegion("nonexistent/region");
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getRecentCommitsForFiles
// ---------------------------------------------------------------------------

describe("getRecentCommitsForFiles", () => {
  test("returns only patterns touching the requested files", async () => {
    await db.insertGitPatterns([
      {
        commitHash: "touch-001",
        filesChanged: ["src/api/handler.ts", "src/shared.ts"],
        commitMsg: "feat: touches api",
        author: "dev",
        timestamp: 9001,
      },
      {
        commitHash: "touch-002",
        filesChanged: ["src/unrelated.ts"],
        commitMsg: "chore: unrelated",
        author: "dev",
        timestamp: 9002,
      },
    ]);

    const results = await db.getRecentCommitsForFiles(["src/api/handler.ts"]);
    expect(results.length).toBe(1);
    expect(results[0].commitHash).toBe("touch-001");
  });

  test("respects the limit parameter", async () => {
    // Insert extra patterns that all touch the target file
    for (let i = 3; i <= 7; i++) {
      await db.insertGitPatterns([
        {
          commitHash: `touch-00${i}`,
          filesChanged: ["src/api/handler.ts"],
          commitMsg: `commit ${i}`,
          author: "dev",
          timestamp: 9000 + i,
        },
      ]);
    }

    const limited = await db.getRecentCommitsForFiles(["src/api/handler.ts"], 2);
    expect(limited.length).toBe(2);
  });

  test("returns empty array for empty file list", async () => {
    const results = await db.getRecentCommitsForFiles([]);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

describe("maintenance", () => {
  test("cleanup runs without error", async () => {
    await db.cleanup();
  });

  test("vacuum runs without error", async () => {
    await db.vacuum();
  });
});
