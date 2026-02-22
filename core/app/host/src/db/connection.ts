/**
 * SQLite connection manager for .eisen/workspace.db.
 *
 * Uses Bun's built-in bun:sqlite (no native addon required) so the
 * compiled eisen-host binary works without external .node files.
 *
 * Auto-creates the `.eisen/` directory and database file on first access.
 * Provides a singleton connection per workspace path.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { initSchema } from "./schema";

const DB_DIR = ".eisen";
const DB_FILE = "workspace.db";

/** Active connections keyed by workspace path. */
const connections = new Map<string, Database>();

/**
 * Get or create a SQLite Database for the given workspace.
 *
 * Creates `.eisen/workspace.db` on first call. Runs schema init
 * (idempotent table creation + migration) before returning.
 *
 * @param workspacePath - Absolute path to the workspace root
 * @returns Initialised Database instance
 */
export async function getDatabase(workspacePath: string): Promise<Database> {
  const existing = connections.get(workspacePath);
  if (existing) return existing;

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

  connections.set(workspacePath, db);
  return db;
}

/**
 * Close and remove the connection for a workspace.
 * Called on extension deactivation.
 */
export function closeDatabase(workspacePath: string): void {
  const db = connections.get(workspacePath);
  if (db) {
    db.close();
    connections.delete(workspacePath);
  }
}

/**
 * Close all open database connections.
 * Called on extension deactivation.
 */
export function closeAllDatabases(): void {
  for (const [wsPath, db] of connections) {
    db.close();
    connections.delete(wsPath);
  }
}

/**
 * Get the path to the database file for a workspace.
 */
export function getDatabasePath(workspacePath: string): string {
  return path.join(workspacePath, DB_DIR, DB_FILE);
}
