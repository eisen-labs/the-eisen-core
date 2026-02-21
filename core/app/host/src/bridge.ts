/**
 * Resolve the path to the eisen-core binary.
 *
 * Resolution order:
 *  1. Same directory as host: <hostDir's dir>/eisen-core(.exe) — host and core both in app/src-tauri/bin/
 *  2. Repo-relative from host: from .../app/src-tauri/bin go up to repo root, then core/target/release/
 *  3. Cwd-relative (when run from repo root): cwd/../../core/target/release/
 *  4. System PATH fallback: just "eisen-core"
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function getCorePath(hostDir?: string): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `eisen-core${ext}`;

  if (hostDir) {
    const hostBinDir = path.dirname(hostDir);
    // 1. Same dir as host (both in src-tauri/bin/)
    const sameDir = path.join(hostBinDir, binaryName);
    if (fs.existsSync(sameDir)) {
      return path.resolve(sameDir);
    }
    // 2. Repo-relative from host: host is in app/src-tauri/bin, so ../../../../ = repo root
    const repoRelative = path.join(hostBinDir, "..", "..", "..", "..", "core", "target", "release", binaryName);
    if (fs.existsSync(repoRelative)) {
      return path.resolve(repoRelative);
    }
  }

  // 3. Cwd-relative (e.g. when run from repo root)
  const devPath = path.join(process.cwd(), "..", "..", "core", "target", "release", binaryName);
  if (fs.existsSync(devPath)) {
    return path.resolve(devPath);
  }
  const devPath2 = path.join(process.cwd(), "core", "target", "release", binaryName);
  if (fs.existsSync(devPath2)) {
    return path.resolve(devPath2);
  }

  // 4. System PATH fallback
  return binaryName;
}
