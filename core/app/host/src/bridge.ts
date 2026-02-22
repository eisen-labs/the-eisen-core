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
    // 2. Workspace target (cargo workspace builds to repo-root/target/)
    const workspaceTarget = path.join(hostBinDir, "..", "..", "..", "target", "release", binaryName);
    if (fs.existsSync(workspaceTarget)) {
      return path.resolve(workspaceTarget);
    }
    // 3. Crate-local target (standalone cargo build in core/)
    const crateTarget = path.join(hostBinDir, "..", "..", "..", "core", "target", "release", binaryName);
    if (fs.existsSync(crateTarget)) {
      return path.resolve(crateTarget);
    }
  }

  // 4. Cwd-relative (e.g. when run from repo root)
  const cwdWorkspace = path.join(process.cwd(), "target", "release", binaryName);
  if (fs.existsSync(cwdWorkspace)) {
    return path.resolve(cwdWorkspace);
  }
  const cwdCrate = path.join(process.cwd(), "core", "target", "release", binaryName);
  if (fs.existsSync(cwdCrate)) {
    return path.resolve(cwdCrate);
  }

  // 5. System PATH fallback
  return binaryName;
}
