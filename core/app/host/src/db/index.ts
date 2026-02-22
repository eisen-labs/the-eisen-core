/**
 * Database module for per-workspace LibSQL storage.
 *
 * Usage:
 *   import { WorkspaceDB } from "./db";
 *   const db = new WorkspaceDB("/path/to/workspace");
 *   const snap = await db.getLatestSnapshot();
 */

export { WorkspaceDB } from "./workspace-db";
export type {
  WorkspaceSnapshot,
  FileMeta,
  GitPattern,
  FileCochange,
  TaskHistoryEntry,
  AgentPerformance,
  RegionInsight,
  SymbolCacheEntry,
  OptimizedPrompt,
  OptimizedPromptStep,
} from "./workspace-db";

export {
  getDatabase,
  closeDatabase,
  getDatabasePath,
} from "./connection";

export { SCHEMA_VERSION, initSchema } from "./schema";
