/**
 * SQLite connection helpers for .eisen/workspace.db.
 *
 * Uses Bun's built-in bun:sqlite (no native addon required) so the
 * compiled eisen-host binary works without external .node files.
 *
 * Auto-creates the `.eisen/` directory and database file on first access.
 *
 * NOTE: There is deliberately NO connection singleton here. Each WorkspaceDB
 * instance owns its own Database object. SQLite in WAL mode handles concurrent
 * readers natively, so a singleton adds no value and introduces close-races
 * when multiple short-lived WorkspaceDB instances are used concurrently
 * (e.g. loadOptimizedPrompts running in parallel with loadWorkspaceContext).
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { initSchema } from "./schema";

const DB_DIR = ".eisen";
const DB_FILE = "workspace.db";

/**
 * Open a new SQLite Database for the given workspace.
 *
 * Creates `.eisen/workspace.db` on first call. Runs schema init
 * (idempotent table creation + migration) before returning.
 *
 * @param workspacePath - Absolute path to the workspace root
 * @returns Initialised Database instance (caller is responsible for closing)
 */
export async function getDatabase(workspacePath: string): Promise<Database> {
  const dbDir = path.join(workspacePath, DB_DIR);
  const dbPath = path.join(dbDir, DB_FILE);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = OFF");

  initSchema(db);

  return db;
}

/**
 * Close a specific Database instance.
 * Provided for callers that need an explicit close outside of WorkspaceDB.
 */
export function closeDatabase(db: Database): void {
  try {
    db.close();
  } catch {
    // Ignore double-close errors
  }
}

/**
 * Get the path to the database file for a workspace.
 */
export function getDatabasePath(workspacePath: string): string {
  return path.join(workspacePath, DB_DIR, DB_FILE);
}
