/**
 * Git log parser for mining commit history.
 *
 * Spawns `git log --format='%H|%an|%at|%s' --name-only` and parses the
 * output into structured RawCommit objects.
 */

export interface RawCommit {
  commitHash: string;
  author: string | null;
  /** Unix seconds (matches DB schema). */
  timestamp: number;
  commitMsg: string | null;
  filesChanged: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a raw `git log --format='%H|%an|%at|%s' --name-only` output string.
 * Exported for unit testing without spawning git.
 */
export function parseGitLogOutput(output: string): RawCommit[] {
  const commits: RawCommit[] = [];
  if (!output.trim()) return commits;

  let current: { header: string; files: string[] } | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();

    // A commit header starts with a 40-char hex SHA followed by |
    if (/^[0-9a-f]{40}\|/.test(line)) {
      if (current !== null) {
        commits.push(headerToCommit(current.header, current.files));
      }
      current = { header: line, files: [] };
    } else if (current !== null && line.trim()) {
      current.files.push(line.trim());
    }
  }

  if (current !== null) {
    commits.push(headerToCommit(current.header, current.files));
  }

  return commits;
}

/**
 * Spawn git and parse the log for the given workspace.
 *
 * @param workspacePath  Absolute path to the git repository root.
 * @param since          Unix seconds — only return commits after this time.
 *                       Omit for initial load (fetches last 200 commits).
 * @returns              Parsed commits, or `[]` if git is unavailable /
 *                       the directory is not a git repo.
 */
export async function parseGitLog(
  workspacePath: string,
  since?: number,
): Promise<RawCommit[]> {
  try {
    const args = ["log", "--format=%H|%an|%at|%s", "--name-only"];

    if (since !== undefined) {
      args.push(`--since=${since}`);
    } else {
      args.push("-200");
    }

    const proc = Bun.spawn(["git", ...args], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return [];

    return parseGitLogOutput(output);
  } catch {
    // git not available or not a repo
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function headerToCommit(header: string, filesChanged: string[]): RawCommit {
  // Format: <40-hex-hash>|<author>|<unix-ts>|<subject>
  // The subject may itself contain '|', so we join parts from index 3 onward.
  const parts = header.split("|");
  const commitHash = parts[0] ?? "";
  const author = parts[1] || null;
  const ts = parseInt(parts[2] ?? "0", 10);
  const commitMsg = parts.length > 3 ? parts.slice(3).join("|") || null : null;

  return {
    commitHash,
    author,
    timestamp: isNaN(ts) ? 0 : ts,
    commitMsg,
    filesChanged,
  };
}
