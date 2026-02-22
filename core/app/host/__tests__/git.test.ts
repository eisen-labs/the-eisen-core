/**
 * Unit tests for the git parser and syncGitPatterns helper.
 *
 * No actual git invocations — the parser is tested against a mock output
 * string, and syncGitPatterns receives an injected mock parser function.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseGitLogOutput } from "../src/git/parser";
import type { RawCommit } from "../src/git/parser";
import { syncGitPatterns } from "../src/workflow/context-loader";
import { WorkspaceDB, closeAllDatabases } from "../src/db";

// ---------------------------------------------------------------------------
// Mock git log output
// ---------------------------------------------------------------------------

const COMMIT_A_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMMIT_C_HASH = "cccccccccccccccccccccccccccccccccccccccc";

// Simulates two commits: A touches a.ts + b.ts, B touches c.ts only
const MOCK_GIT_OUTPUT = [
  `${COMMIT_A_HASH}|Alice|1700000000|feat: add feature`,
  `src/a.ts`,
  `src/b.ts`,
  ``,
  `${COMMIT_B_HASH}|Bob|1700001000|fix: bug in c`,
  `src/c.ts`,
].join("\n");

// ---------------------------------------------------------------------------
// parseGitLogOutput
// ---------------------------------------------------------------------------

describe("parseGitLogOutput", () => {
  test("parses two commits correctly", () => {
    const commits = parseGitLogOutput(MOCK_GIT_OUTPUT);
    expect(commits).toHaveLength(2);

    expect(commits[0].commitHash).toBe(COMMIT_A_HASH);
    expect(commits[0].author).toBe("Alice");
    expect(commits[0].timestamp).toBe(1700000000);
    expect(commits[0].commitMsg).toBe("feat: add feature");
    expect(commits[0].filesChanged).toEqual(["src/a.ts", "src/b.ts"]);

    expect(commits[1].commitHash).toBe(COMMIT_B_HASH);
    expect(commits[1].author).toBe("Bob");
    expect(commits[1].timestamp).toBe(1700001000);
    expect(commits[1].filesChanged).toEqual(["src/c.ts"]);
  });

  test("empty output returns []", () => {
    expect(parseGitLogOutput("")).toEqual([]);
    expect(parseGitLogOutput("\n\n\n")).toEqual([]);
    expect(parseGitLogOutput("   ")).toEqual([]);
  });

  test("commit with no files has empty filesChanged", () => {
    const output = `${COMMIT_A_HASH}|Author|1700000000|msg with no files\n\n`;
    const commits = parseGitLogOutput(output);
    expect(commits).toHaveLength(1);
    expect(commits[0].filesChanged).toEqual([]);
  });

  test("subject containing pipe characters is preserved", () => {
    const output = `${COMMIT_A_HASH}|Dev|1700000000|feat: a|b|c\nsrc/x.ts\n`;
    const commits = parseGitLogOutput(output);
    expect(commits[0].commitMsg).toBe("feat: a|b|c");
  });
});

// ---------------------------------------------------------------------------
// syncGitPatterns — uses an in-memory DB in a temp directory
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: WorkspaceDB;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eisen-git-sync-test-"));
  db = new WorkspaceDB(tmpDir);
  // Force DB init
  await db.getLatestGitTimestamp();
});

afterAll(() => {
  closeAllDatabases();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Mock parser that always returns commits from the shared mock output. */
const mockParser = async (_path: string, _since?: number): Promise<RawCommit[]> =>
  parseGitLogOutput(MOCK_GIT_OUTPUT);

describe("syncGitPatterns — first run", () => {
  test("populates git_patterns", async () => {
    await syncGitPatterns(db, tmpDir, mockParser);

    const latest = await db.getLatestGitTimestamp();
    expect(latest).toBe(1700001000);

    const all = await db.getGitPatternsSince(0);
    expect(all.length).toBe(2);
    expect(all.map((p) => p.commitHash)).toContain(COMMIT_A_HASH);
    expect(all.map((p) => p.commitHash)).toContain(COMMIT_B_HASH);
  });

  test("derives file_cochange from patterns", async () => {
    // a.ts and b.ts were in the same commit → should have a co-change pair
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

describe("syncGitPatterns — incremental run", () => {
  test("only inserts new commits (no duplicate)", async () => {
    // At this point DB already has COMMIT_A and COMMIT_B (timestamp 1700001000).
    // Feed a new commit C with a later timestamp.
    const newCommit: RawCommit = {
      commitHash: COMMIT_C_HASH,
      author: "Carol",
      timestamp: 1700002000,
      commitMsg: "chore: new commit",
      filesChanged: ["src/d.ts"],
    };

    const incrementalParser = async (
      _path: string,
      _since?: number,
    ): Promise<RawCommit[]> => [newCommit];

    await syncGitPatterns(db, tmpDir, incrementalParser);

    // DB should now have 3 total patterns
    const all = await db.getGitPatternsSince(0);
    expect(all.length).toBe(3);

    // Original commits are not duplicated
    const aCount = all.filter((p) => p.commitHash === COMMIT_A_HASH).length;
    const bCount = all.filter((p) => p.commitHash === COMMIT_B_HASH).length;
    const cCount = all.filter((p) => p.commitHash === COMMIT_C_HASH).length;
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
    expect(cCount).toBe(1);
  });
});
