/**
 * TypeScript wrapper around the eisen-napi NAPI-RS native addon.
 *
 * The `.node` binary is loaded in-process — no spawning, no JSON-over-stdio.
 *
 * Loading strategy (eisen-host sidecar context):
 *  1. Same dir as the host binary: `<hostDir>/eisen_napi.node`
 *  2. Repo-relative (dev): `<repoRoot>/crates/eisen-napi/index.js`
 */

import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types matching the JSON output from eisen-core
// ---------------------------------------------------------------------------

export interface SerializableNode {
  id: number;
  name: string;
  kind: string;
  language?: string;
  startLine: number;
  endLine: number;
  path: string;
  children?: SerializableNode[];
}

export interface NodeData {
  id: number;
  name: string;
  kind: string;
  language?: string;
  startLine: number;
  endLine: number;
  path: string;
  tokens?: number;
}

export interface UiLineRange {
  start: number;
  end: number;
}

export interface UiNode {
  kind?: string;
  lines?: UiLineRange;
  lastWrite?: number;
  changed?: boolean;
  tokens?: number;
}

export interface UiCallEdge {
  from: string;
  to: string;
}

export interface UiSnapshot {
  seq: number;
  nodes: Record<string, UiNode>;
  calls?: UiCallEdge[];
}

// ---------------------------------------------------------------------------
// Native binding interface (raw JSON string returns from Rust)
// ---------------------------------------------------------------------------

interface EisenNapiBindings {
  parseWorkspace(path: string): string;
  parseFile(path: string): string;
  snapshot(path: string): string;
  lookupSymbol(workspacePath: string, symbolName: string): string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

let _bindings: EisenNapiBindings | null = null;

/**
 * Resolve and load the NAPI-RS bindings. Call once during host startup.
 *
 * Uses the napi-rs generated `index.js` which handles cross-platform binary
 * resolution automatically. Two load paths:
 *  1. Same directory as the host binary (production Tauri sidecar)
 *  2. Dev fallback: `<repoRoot>/crates/eisen-napi/index.js`
 *
 * @param hostDir - Directory containing the host binary (process.execPath dir)
 */
export function loadNapiBindings(hostDir?: string): void {
  if (_bindings) return;

  const candidates: string[] = [];

  if (hostDir) {
    const binDir = path.dirname(hostDir);
    // 1. Production: napi loader next to host binary
    candidates.push(path.join(binDir, "napi", "index.js"));
    // 2. Repo-relative from host: host is in app/src-tauri/bin
    candidates.push(
      path.join(binDir, "..", "..", "..", "crates", "eisen-napi", "index.js"),
    );
  }

  // 3. Dev fallback from cwd (repo root)
  candidates.push(
    path.join(process.cwd(), "crates", "eisen-napi", "index.js"),
  );

  for (const candidate of candidates) {
    try {
      _bindings = require(candidate) as EisenNapiBindings;
      return;
    } catch {
      // Try next candidate
    }
  }

  throw new Error(
    `eisen-napi bindings not found. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
}

function getBindings(): EisenNapiBindings {
  if (!_bindings) {
    throw new Error(
      "NAPI bindings not loaded. Call loadNapiBindings() first.",
    );
  }
  return _bindings;
}

// ---------------------------------------------------------------------------
// Public API — typed wrappers that parse the JSON from Rust
// ---------------------------------------------------------------------------

/**
 * Parse an entire workspace directory into a nested symbol tree.
 */
export function parseWorkspace(workspacePath: string): SerializableNode {
  return JSON.parse(getBindings().parseWorkspace(workspacePath));
}

/**
 * Parse a single file and return its symbols.
 */
export function parseFile(filePath: string): NodeData[] {
  return JSON.parse(getBindings().parseFile(filePath));
}

/**
 * Build a flattened UI snapshot of a workspace.
 */
export function snapshot(workspacePath: string): UiSnapshot {
  return JSON.parse(getBindings().snapshot(workspacePath));
}

/**
 * Search for symbols matching a name in a workspace.
 */
export function lookupSymbol(
  workspacePath: string,
  symbolName: string,
): NodeData[] {
  return JSON.parse(
    getBindings().lookupSymbol(workspacePath, symbolName),
  );
}
