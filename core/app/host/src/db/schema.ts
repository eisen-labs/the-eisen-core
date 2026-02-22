/**
 * SQLite schema definitions and migration logic for .eisen/workspace.db.
 *
 * Schema version is tracked in the `_meta` table. On version bump, new
 * migrations run automatically. All tables use INTEGER timestamps (unix ms).
 */

import type { Database } from "bun:sqlite";

// Bump this when adding new tables or altering existing ones.
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Table creation statements (idempotent via IF NOT EXISTS)
// ---------------------------------------------------------------------------

const TABLES: string[] = [
  // Schema metadata
  `CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Cached workspace parse results. Invalidated by tree_hash mismatch.
  `CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_hash    TEXT NOT NULL,
    tree_json    TEXT NOT NULL,
    symbol_json  TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    file_count   INTEGER NOT NULL
  )`,

  // Per-file metadata. Source of truth for staleness detection.
  `CREATE TABLE IF NOT EXISTS file_meta (
    path              TEXT PRIMARY KEY,
    last_modified     INTEGER,
    last_parsed       INTEGER,
    change_frequency  REAL DEFAULT 0,
    primary_language  TEXT,
    symbol_count      INTEGER DEFAULT 0,
    line_count        INTEGER DEFAULT 0
  )`,

  // Raw git commit history. Appended incrementally.
  `CREATE TABLE IF NOT EXISTS git_patterns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_hash   TEXT NOT NULL UNIQUE,
    files_changed TEXT NOT NULL,
    commit_msg    TEXT,
    author        TEXT,
    timestamp     INTEGER NOT NULL
  )`,

  // Derived co-change relationships. Updated after each git_patterns insert.
  `CREATE TABLE IF NOT EXISTS file_cochange (
    file_a         TEXT NOT NULL,
    file_b         TEXT NOT NULL,
    cochange_count INTEGER DEFAULT 1,
    last_seen      INTEGER NOT NULL,
    PRIMARY KEY (file_a, file_b)
  )`,

  // Complete orchestration run history. Primary source for optimizer.
  `CREATE TABLE IF NOT EXISTS task_history (
    id                  TEXT PRIMARY KEY,
    user_intent         TEXT NOT NULL,
    subtasks_json       TEXT NOT NULL,
    assignments_json    TEXT NOT NULL,
    results_json        TEXT NOT NULL,
    quality_score       REAL,
    total_tokens        INTEGER,
    orchestrator_tokens INTEGER,
    duration_ms         INTEGER,
    timestamp           INTEGER NOT NULL
  )`,

  // Agent performance per region and language. Updated after each run.
  `CREATE TABLE IF NOT EXISTS agent_performance (
    agent_type        TEXT NOT NULL,
    region            TEXT NOT NULL,
    language          TEXT NOT NULL,
    task_type         TEXT DEFAULT '',
    success_count     INTEGER DEFAULT 0,
    fail_count        INTEGER DEFAULT 0,
    total_tokens      INTEGER DEFAULT 0,
    total_duration_ms INTEGER DEFAULT 0,
    last_used         INTEGER NOT NULL,
    PRIMARY KEY (agent_type, region, language)
  )`,

  // LLM-generated region summaries. Refreshed when files change significantly.
  // Plaintext layout (free tier / development). Encrypted variant defined
  // in LIBSQL_ENCRYPT.md for pro/premium — deferred.
  `CREATE TABLE IF NOT EXISTS region_insights (
    region        TEXT PRIMARY KEY,
    description   TEXT,
    conventions   TEXT,
    dependencies  TEXT,
    last_updated  INTEGER NOT NULL
  )`,

  // Symbol lookup cache. Invalidates when source file mtime changes.
  `CREATE TABLE IF NOT EXISTS symbol_cache (
    symbol_name    TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    result_json    TEXT NOT NULL,
    file_mtime     INTEGER NOT NULL,
    cached_at      INTEGER NOT NULL,
    PRIMARY KEY (symbol_name, workspace_path)
  )`,
];

// ---------------------------------------------------------------------------
// Indexes for query performance
// ---------------------------------------------------------------------------

const INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_git_patterns_timestamp
     ON git_patterns(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_file_cochange_file_a
     ON file_cochange(file_a)`,
  `CREATE INDEX IF NOT EXISTS idx_task_history_timestamp
     ON task_history(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_performance_region
     ON agent_performance(region, language)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_cache_mtime
     ON symbol_cache(file_mtime)`,
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Initialise the database schema. Creates tables if they don't exist and
 * runs any pending migrations based on the stored schema version.
 */
export function initSchema(db: Database): void {
  for (const sql of TABLES) {
    db.exec(sql);
  }

  for (const sql of INDEXES) {
    db.exec(sql);
  }

  const row = db.query("SELECT value FROM _meta WHERE key = ?").get("schema_version") as
    | { value: string }
    | null;

  const currentVersion = row ? Number.parseInt(row.value, 10) : 0;

  if (currentVersion < SCHEMA_VERSION) {
    runMigrations(db, currentVersion, SCHEMA_VERSION);
  }

  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SCHEMA_VERSION),
  );
}

/**
 * Run migrations between two schema versions.
 * Each version bump gets a case in the switch.
 */
function runMigrations(_db: Database, fromVersion: number, toVersion: number): void {
  for (let v = fromVersion + 1; v <= toVersion; v++) {
    switch (v) {
      case 1:
        // Initial schema — tables created above via CREATE IF NOT EXISTS.
        break;
      // Future migrations go here:
      // case 2:
      //   _db.exec("ALTER TABLE ...");
      //   break;
      default:
        throw new Error(`Unknown schema version: ${v}`);
    }
  }
}
