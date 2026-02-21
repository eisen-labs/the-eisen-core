/**
 * File search service using fast-glob.
 *
 * Replaces VS Code's `workspace.findFiles()` for the standalone host.
 */

import * as path from "node:path";
import fg from "fast-glob";
import { getCwd } from "./env";

const EXCLUDE_DIRS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.venv/**",
  "**/__pycache__/**",
];

export interface Uri {
  fsPath: string;
  scheme: string;
}

/**
 * Implementation of vscode.workspace.findFiles using fast-glob.
 */
export async function findFiles(
  glob: string,
  exclude?: string,
  maxResults?: number,
): Promise<Uri[]> {
  const cwd = getCwd();

  // Parse the VS Code exclude pattern: "{pattern1,pattern2,...}"
  let ignorePatterns = [...EXCLUDE_DIRS];
  if (exclude) {
    // Strip surrounding braces if present
    const inner = exclude.startsWith("{") && exclude.endsWith("}")
      ? exclude.slice(1, -1)
      : exclude;
    ignorePatterns = inner.split(",").map((p) => p.trim());
  }

  const entries = await fg(glob, {
    cwd,
    ignore: ignorePatterns,
    dot: false,
    onlyFiles: true,
    absolute: true,
    suppressErrors: true,
  });

  const limit = maxResults ?? entries.length;
  return entries.slice(0, limit).map((p) => ({
    fsPath: path.resolve(p),
    scheme: "file",
  }));
}
