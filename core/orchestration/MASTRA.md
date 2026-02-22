# Mastra Migration Plan — DSPy (Python) to Mastra (TypeScript)

> Full architectural plan for replacing the Python orchestration layer with a
> TypeScript-native Mastra workflow backed by a per-workspace LibSQL database.
> See `HYBRID_MASTRA_DSPY.md` for the optional offline DSPy optimizer that
> sits on top of this architecture. See `TODO.md` for the actionable checklist.

## Current Structure

- **`app/host/src/workflow/`** — Mastra workflow implementation (Phase 2 complete)
  - `schemas.ts` — Zod schemas (ports of all 4 DSPy signatures)
  - `agents.ts` — Mastra agent factory (TaskDecompose, AgentSelect, PromptBuild, ProgressEval)
  - `orchestrate.ts` — Main orchestration pipeline (replaces Python Orchestrator class)
  - `context-loader.ts` — LibSQL + NAPI-RS context loading, git sync integration
  - `region-insights.ts` — Background region insight generator (Phase 3)
  - `topo-sort.ts` — Topological batch sort for dependency-ordered execution
  - `cost-tracker.ts` — Token usage tracking
  - `zones.ts` — Shared zone configuration
  - `index.ts` — Barrel exports
- **`app/host/src/db/`** — Per-workspace LibSQL database (Phase 1 complete)
- **`app/host/src/napi/`** — NAPI-RS bridge wrapper (Phase 0 complete)
- **`app/host/src/git/`** — Git history mining (Phase 3 complete)
  - `parser.ts` — `git log` parser and spawn helper
  - `index.ts` — Barrel exports
- **`dspy/`** — Legacy Python orchestrator (preserved for reference and future hybrid optimizer)

> DSPy and Python work is deferred. The Mastra workflow in `app/host/src/workflow/`
> is the active orchestration implementation.

---

## Motivation

The legacy Python orchestration layer (now in `dspy/`) was connected to the
TypeScript extension via a JSON-over-stdin/stdout bridge (`OrchestratorBridge`).
The Python layer in turn calls into Rust via a PyO3 native extension
(`pybridge/`). This creates a three-runtime stack:

```
TypeScript/Node (extension) → Python (orchestrator) → Rust (eisen-core/PyO3)
```

The problems this creates:

- **Runtime complexity** — Python 3.11+, Maturin build toolchain, and a
  compiled `.so` must all be present and version-matched
- **Bridge fragility** — two JSON protocol boundaries (TS↔Python,
  Python↔Rust) each with their own serialization bugs and timeout edge cases
- **Debugging span** — a single orchestration run touches three languages,
  making traces hard to follow
- **Onboarding friction** — contributors need Python, Rust, and TypeScript
  toolchains plus `maturin develop` to run locally
- **DSPy runtime cost** — DSPy's unique value (automated prompt optimization)
  is used only for `BootstrapFewShot`, which runs rarely and offline. It does
  not justify being on the critical path for every user query.

**The goal:** collapse to two runtimes (Bun + Rust), with Python retained as
an optional offline optimizer rather than a runtime dependency. Bun replaces
Node.js as the JavaScript runtime for the extension host and all TypeScript
tooling. The Rust↔TypeScript bridge is implemented via **NAPI-RS** — the
Node-API native module approach that Bun itself recommends as the stable path
for native code interop (`bun:ffi` is explicitly marked experimental with known
bugs by Oven and should not be used in production). NAPI-RS compiles a `.node`
addon that Bun loads in-process, eliminating both the Python process and the
JSON-over-stdio serialization boundary.

---

## Architecture: Before & After

### Before

```
User Query
    │
    ▼
VS Code Extension (TypeScript)
    │  JSON over stdin/stdout
    ▼
OrchestratorBridge
    │  spawns
    ▼
python -m eisen_agent --mode extension
    │
    ├── DSPy (TaskDecompose, AgentSelect, PromptBuild, ProgressEval)
    │     └── LLM API
    │
    ├── eisen_bridge (PyO3 .so)
    │     └── Rust: parse_workspace, snapshot, lookup_symbol
    │
    ├── ~/.eisen/traces/     (flat JSON files)
    ├── ~/.eisen/sessions/   (flat JSON files)
    ├── ~/.eisen/compiled/   (DSPy compiled modules)
    └── ~/.eisen/agent_stats.json

    │  ACP over stdin/stdout (per subtask)
    ▼
eisen-core observe → AI Agent (opencode, claude, etc.)
    │  TCP
    ▼
EisenOrchestrator (TypeScript CRDT merge)
    │
    ▼
GraphViewProvider (webview)
```

### After

```
User Query
    │
    ▼
VS Code Extension (TypeScript / Bun runtime)
    │  direct call (in-process)
    ▼
Mastra Workflow (TypeScript / Bun runtime)
    │
    ├── loadWorkspaceContext
    │     ├── LibSQL (.eisen/workspace.db)      ← learned context
    │     └── NAPI-RS .node addon               ← in-process Rust (no spawn)
    │
    ├── decomposeTask      ─── LLM API (structured output via Zod)
    ├── assignAgents       ─── LLM API + agent_performance from DB
    ├── confirmPlan        ─── Mastra suspend/resume (user approval)
    ├── buildAndExecute    ─── ACPClient (existing TS implementation)
    └── evaluateAndRecord  ─── LLM API + write back to LibSQL
          │
          ▼
    .eisen/workspace.db (LibSQL, per workspace)
          ├── task_history
          ├── agent_performance
          ├── git_patterns / file_cochange
          ├── region_insights
          └── symbol_cache

    │  ACP over stdin/stdout (per subtask, unchanged)
    ▼
eisen-core observe → AI Agent (unchanged)
    │  TCP (unchanged)
    ▼
EisenOrchestrator (TypeScript CRDT merge, unchanged)
    │
    ▼
GraphViewProvider (webview, unchanged)
```

The ACP agent execution layer, TCP observation, CRDT merge, and graph view are
**entirely unchanged**. Only the orchestration decision layer changes.

---

## Phase 0: NAPI-RS Bridge — Rust `.node` Addon

The PyO3 bridge exposes four functions to Python over FFI. The replacement is
a **NAPI-RS** native module — a `.node` addon that Bun loads in-process via
the Node-API interface. Bun explicitly supports Node-API as the stable,
production-ready path for native code interop (its own docs recommend this
over `bun:ffi`, which is experimental with known bugs).

> **Why not `bun:ffi`?** Bun's own documentation states: "`bun:ffi` is
> experimental, with known bugs and limitations, and should not be relied on
> in production. The most stable way to interact with native code from Bun is
> to write a Node-API module." We follow that guidance.

### Rust side — `napi` + `napi-derive`

Create a `crates/eisen-napi/` crate alongside the existing `core/`:

```toml
# crates/eisen-napi/Cargo.toml
[package]
name    = "eisen-napi"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
eisen-core = { path = "../core" }
napi        = { version = "2", features = ["napi4"] }
napi-derive = "2"
serde_json  = "1"
```

```rust
// crates/eisen-napi/src/lib.rs
use napi_derive::napi;

#[napi]
pub fn parse_workspace(path: String) -> napi::Result<String> {
    eisen_core::parse_workspace(&path)
        .map(|tree| serde_json::to_string(&tree).unwrap())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn parse_file(path: String) -> napi::Result<String> {
    eisen_core::parse_file(&path)
        .map(|nodes| serde_json::to_string(&nodes).unwrap())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn lookup_symbol(workspace: String, name: String) -> napi::Result<String> {
    eisen_core::lookup_symbol(&workspace, &name)
        .map(|nodes| serde_json::to_string(&nodes).unwrap())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn snapshot(path: String) -> napi::Result<String> {
    eisen_core::snapshot(&path)
        .map(|s| serde_json::to_string(&s).unwrap())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}
```

Build via `@napi-rs/cli`:

```bash
bun add -D @napi-rs/cli
bunx napi build --release --platform
# outputs: eisen_napi.<platform>.node
```

No `maturin`, no Python, no `node-gyp`.

### TypeScript side

NAPI-RS generates TypeScript type declarations automatically:

```typescript
// extension/src/napi/eisen.ts
import {
  parseWorkspace,
  parseFile,
  lookupSymbol,
  snapshot,
} from "../../eisen_napi.node";

export const eisen = {
  parseWorkspace: (path: string) => JSON.parse(parseWorkspace(path)),
  parseFile: (path: string) => JSON.parse(parseFile(path)),
  lookupSymbol: (workspace: string, name: string) =>
    JSON.parse(lookupSymbol(workspace, name)),
  snapshot: (path: string) => JSON.parse(snapshot(path)),
};
```

### Function parity with PyO3 bridge

| NAPI-RS export                  | Current PyO3 equivalent          | Output                              |
| ------------------------------- | -------------------------------- | ----------------------------------- |
| `parseWorkspace(path)`          | `parse_workspace(path)`          | Nested `SerializableNode` tree JSON |
| `parseFile(path)`               | `parse_file(path)`               | Array of `NodeData` JSON            |
| `lookupSymbol(workspace, name)` | `lookup_symbol(workspace, name)` | Array of `NodeData` JSON            |
| `snapshot(path)`                | `snapshot(path)`                 | `UiSnapshot` JSON                   |

### Performance

NAPI-RS calls are in-process with no spawn overhead. The only cost is JSON
serialisation of the return value, which is unavoidable regardless of bridge
approach. `lookupSymbol` results are cached in the `symbol_cache` LibSQL table
(invalidated per-file by mtime), so most calls never reach Rust at all.

### Platform distribution

`@napi-rs/cli` handles cross-platform builds and per-platform npm package
distribution automatically. The CI matrix produces:

- `eisen-napi-linux-x64-gnu`
- `eisen-napi-darwin-arm64`
- `eisen-napi-darwin-x64`
- `eisen-napi-win32-x64-msvc`

The root `eisen-napi` package lists these as `optionalDependencies` and
selects the correct binary at runtime. The correct `.node` file is bundled
into the VS Code extension VSIX.

### Transition

The PyO3 bridge (`pybridge/`) continues to work during migration. Remove it
only after the NAPI-RS wrapper is verified to produce identical JSON output
for all four functions.

---

## Phase 1: LibSQL Per-Workspace Database

### Location

`.eisen/workspace.db` in each workspace root. Created automatically on first
orchestration run. File-based SQLite via LibSQL — zero external services, no
server process.

### Dependency

```bash
bun add @mastra/libsql
```

That is the only new dependency for the database layer.

> **Encryption note:** A subset of tables will store sensitive learned data
> (optimized prompts, assignment rules, workspace profile, region insights)
> in AES-256-GCM encrypted BLOBs so that the database is inert without a
> valid subscription key. The schema below shows the **base plaintext
> structure**; `LIBSQL_ENCRYPT.md` describes the full encryption layer,
> schema modifications, and auth flow. Do not finalise the `region_insights`
> column layout here — the encrypted variant defined in `LIBSQL_ENCRYPT.md`
> takes precedence once that work begins.

### Schema

```sql
-- Cached workspace parse results. Invalidated by tree_hash mismatch.
CREATE TABLE workspace_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_hash    TEXT NOT NULL,      -- hash of directory listing (not file contents)
  tree_json    TEXT NOT NULL,      -- parse-workspace output
  symbol_json  TEXT NOT NULL,      -- snapshot output
  created_at   INTEGER NOT NULL,   -- unix ms
  file_count   INTEGER NOT NULL
);

-- Per-file metadata. Source of truth for staleness detection.
CREATE TABLE file_meta (
  path              TEXT PRIMARY KEY,
  last_modified     INTEGER,        -- filesystem mtime (unix ms)
  last_parsed       INTEGER,        -- when eisen last parsed this file
  change_frequency  REAL DEFAULT 0, -- changes per week, rolling average
  primary_language  TEXT,
  symbol_count      INTEGER DEFAULT 0,
  line_count        INTEGER DEFAULT 0
);

-- Raw git commit history. Appended incrementally.
CREATE TABLE git_patterns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_hash   TEXT NOT NULL UNIQUE,
  files_changed TEXT NOT NULL,      -- JSON array of relative paths
  commit_msg    TEXT,
  author        TEXT,
  timestamp     INTEGER NOT NULL    -- unix seconds
);

-- Derived co-change relationships. Updated after each git_patterns insert.
CREATE TABLE file_cochange (
  file_a         TEXT NOT NULL,
  file_b         TEXT NOT NULL,
  cochange_count INTEGER DEFAULT 1,
  last_seen      INTEGER NOT NULL,  -- unix ms
  PRIMARY KEY (file_a, file_b)
);

-- Complete orchestration run history. Primary source for optimizer.
CREATE TABLE task_history (
  id               TEXT PRIMARY KEY,  -- run_id (uuid)
  user_intent      TEXT NOT NULL,
  subtasks_json    TEXT NOT NULL,     -- decomposition used
  assignments_json TEXT NOT NULL,     -- agent assignments
  results_json     TEXT NOT NULL,     -- outcomes per subtask
  quality_score    REAL,              -- completed / total subtasks
  total_tokens     INTEGER,
  orchestrator_tokens INTEGER,
  duration_ms      INTEGER,
  timestamp        INTEGER NOT NULL   -- unix ms
);

-- Agent performance per region and language. Updated after each run.
CREATE TABLE agent_performance (
  agent_type    TEXT NOT NULL,
  region        TEXT NOT NULL,        -- directory path (workspace-relative)
  language      TEXT NOT NULL,
  task_type     TEXT DEFAULT '',
  success_count INTEGER DEFAULT 0,
  fail_count    INTEGER DEFAULT 0,
  total_tokens  INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  last_used     INTEGER NOT NULL,     -- unix ms
  PRIMARY KEY (agent_type, region, language)
);

-- LLM-generated region summaries. Refreshed when files change significantly.
-- ⚠️  ENCRYPTION PLANNED: For pro/premium users the description, conventions,
--     and dependencies columns will be collapsed into a single
--     encrypted_insight BLOB (AES-256-GCM). See LIBSQL_ENCRYPT.md for the
--     final schema. Treat the plaintext columns below as the free-tier /
--     development layout only.
CREATE TABLE region_insights (
  region        TEXT PRIMARY KEY,     -- directory path (workspace-relative)
  description   TEXT,                 -- what this region does
  conventions   TEXT,                 -- detected naming/structure patterns
  dependencies  TEXT,                 -- JSON: key imports/exports
  last_updated  INTEGER NOT NULL      -- unix ms
);

-- Symbol lookup cache. Invalidates when source file mtime changes.
CREATE TABLE symbol_cache (
  symbol_name    TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  result_json    TEXT NOT NULL,       -- array of NodeData
  file_mtime     INTEGER NOT NULL,    -- source file mtime at cache time
  cached_at      INTEGER NOT NULL,    -- unix ms
  PRIMARY KEY (symbol_name, workspace_path)
);
```

### Staleness strategy

| Data                  | Staleness detection                                   | Refresh trigger                                           |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `workspace_snapshots` | Recompute tree_hash from `ls -R`; if mismatch → stale | Call `eisen.parseWorkspace()` via NAPI-RS                 |
| `file_meta`           | Compare `last_modified` against filesystem mtime      | Update on mismatch                                        |
| `git_patterns`        | Track max `timestamp`; query `git log --since=<that>` | Append new commits                                        |
| `file_cochange`       | Derived from `git_patterns`                           | Recompute on new git_patterns rows                        |
| `agent_performance`   | Always current (updated after each run)               | N/A                                                       |
| `region_insights`     | Check `file_meta.last_modified` for files in region   | Re-generate if >20% of files changed since `last_updated` |
| `symbol_cache`        | Compare stored `file_mtime` against current mtime     | Evict and re-lookup on mismatch                           |

### Context injection

Before any LLM call, the orchestrator queries LibSQL for a structured context
block — not a raw workspace dump. This keeps the context window small and
relevant:

```
Given your query "{user_intent}":

Relevant previous tasks:
  - "refactor auth middleware" (quality: 0.95, 3 subtasks, all completed)
  - "add rate limiting to API" (quality: 0.80, 2 subtasks, 1 partial)

Files that tend to change together with src/api/:
  - src/middleware/auth.ts (co-changed 12 times)
  - src/types/request.ts (co-changed 8 times)
  - tests/api.test.ts (co-changed 15 times)

Region src/api/ — TypeScript Express API layer. Follows REST conventions,
  uses middleware chain pattern. Key exports: Router, RequestHandler.

Agent performance for TypeScript in src/api/:
  - claude-code: 92% success (12 runs, avg 8,400 tokens)
  - opencode: 78% success (9 runs, avg 11,200 tokens)
```

This replaces the current approach of dumping `workspace_tree` and
`symbol_index` in full into every LLM call.

---

## Phase 2: Mastra Workflow

### Dependencies

```bash
bun add @mastra/core ai zod
```

No Mastra Cloud. No external services. `ai` is the Vercel AI SDK used by
Mastra for LLM provider abstraction (supports Ollama, Anthropic, OpenAI, etc.).

### DSPy signature → Zod schema mapping

All four DSPy signatures map directly to Zod schemas with Mastra structured
output:

**TaskDecompose**

```typescript
// DSPy inputs: user_intent, workspace_tree, symbol_index
// DSPy outputs: subtasks (list[dict]), reasoning

const SubtaskSchema = z.object({
  description: z.string(),
  region: z.string(),
  expectedFiles: z.array(z.string()),
  dependsOn: z.array(z.number()),
});

const DecomposeOutputSchema = z.object({
  subtasks: z.array(SubtaskSchema),
  reasoning: z.string(),
});
```

**AgentSelect**

```typescript
// DSPy inputs: subtask_description, subtask_region, primary_language, available_agents
// DSPy outputs: agent_id, reasoning

const AgentSelectOutputSchema = z.object({
  agentId: z.string(),
  reasoning: z.string(),
});
```

**PromptBuild**

```typescript
// DSPy inputs: subtask_description, region, region_files, cross_region_deps, effort_level
// DSPy outputs: agent_prompt

const PromptBuildOutputSchema = z.object({
  agentPrompt: z.string(),
});
```

**ProgressEval**

```typescript
// DSPy inputs: subtask_description, agent_output, files_changed
// DSPy outputs: status, failure_reason, suggested_retry

const ProgressEvalOutputSchema = z.object({
  status: z.enum(["completed", "failed", "partial"]),
  failureReason: z.string().optional(),
  suggestedRetry: z.string().optional(),
});
```

Each becomes a Mastra `Agent` with the schema passed as structured output. The
LLM returns typed data directly — no prompt template hacks.

### Workflow definition

```typescript
// extension/src/orchestrator/workflow/orchestrate.ts

export const orchestrateWorkflow = createWorkflow({
  id: "orchestrate",
  inputSchema: z.object({
    userIntent: z.string(),
    workspacePath: z.string(),
    effort: z.enum(["low", "medium", "high"]),
    autoApprove: z.boolean().default(false),
  }),
  outputSchema: z.object({
    status: z.string(),
    subtaskResults: z.array(SubtaskResultSchema),
    totalTokens: z.number(),
  }),
})
  .then(loadWorkspaceContext) // LibSQL + NAPI-RS → eisen-core
  .then(decomposeTask) // LLM structured output
  .then(assignAgents) // LLM + agent stats from DB
  .then(confirmPlan) // suspend/resume for user approval
  .then(buildAndExecute) // parallel subtask execution via ACPClient
  .then(evaluateAndRecord) // eval each subtask + write back to LibSQL
  .commit();
```

### Step: loadWorkspaceContext

1. Open `.eisen/workspace.db` (create if absent)
2. Check `workspace_snapshots` tree_hash — call `eisen.parseWorkspace(path)`
   via NAPI-RS if stale (in-process, no spawn)
3. Query `task_history` for intents similar to current (Jaccard similarity,
   same as current `session_memory.py`)
4. Query `file_cochange` for regions likely to be affected
5. Query `agent_performance` for relevant agent stats
6. Query `region_insights` for region descriptions
7. Run `git log --since=<last_git_patterns_timestamp>` to append new commits
8. Return structured context object (not a raw string dump)

### Step: decomposeTask

Calls the `TaskDecompose` Mastra agent with:

- `userIntent` — the user's query
- `workspaceContext` — the structured context from `loadWorkspaceContext`
  (co-change hints, region descriptions, similar past tasks)

Context is injected into the system prompt, not the user message, so it does
not dominate the query. Returns typed `SubtaskSchema[]`.

### Step: assignAgents

For each subtask, queries LibSQL `agent_performance` first. If a confident
match exists (≥3 samples, >80% success rate), uses it directly without an LLM
call. Otherwise calls the `AgentSelect` Mastra agent with agent stats injected
into context.

### Step: confirmPlan

Uses Mastra's native `suspend()` / `resume()` mechanism. The workflow suspends
and emits the plan to the extension UI. The extension shows the subtask list
and agent assignments. User clicks approve → `resume()` called with
`{ approved: true }`. User edits assignments → `resume()` called with
modified assignments.

This replaces the current `ext_protocol.py` `approve` JSON command with a
first-class workflow primitive.

### Step: buildAndExecute

Reuses the existing `ACPClient` from `extension/src/acp/client.ts` — this
code is unchanged. The topological sort (currently `_build_execution_batches`
in Python) moves to TypeScript. Parallel batches run via `Promise.all()` with
a semaphore for `MAX_AGENTS` concurrency.

For each subtask:

1. Call `buildPrompt` (Mastra agent with `PromptBuild` schema) to build the
   agent-specific prompt, enriched with `region_insights` and `symbol_cache`
   lookups (cache misses resolved via `eisen.lookupSymbol` NAPI-RS call)
2. Spawn `ACPClient` → `eisen-core observe` → AI agent (unchanged ACP flow)
3. Stream output back to extension UI via existing events

### Step: evaluateAndRecord

For each completed subtask:

1. Call `evaluateResult` (Mastra agent with `ProgressEval` schema)
2. Write outcome to `task_history` and `agent_performance` in LibSQL
3. Update `file_meta` for any files that were modified
4. Update `region_insights` generation queue if files changed significantly

### User approval flow (suspend/resume)

```typescript
// Extension sends run command
const run = await orchestrateWorkflow.createRun();
const stream = run.stream({ inputData: { userIntent, workspacePath, effort } });

// Workflow suspends at confirmPlan step — emits plan to UI
for await (const event of stream.fullStream) {
  if (event.type === "suspend") {
    // Show plan in UI
    showPlanInWebview(event.suspendPayload);
  }
}

// User approves in webview → extension resumes
await run.resume({ resumeData: { approved: true, assignments } });
```

---

## Phase 3: Git Integration

Git history is the highest-signal source of workspace structure knowledge that
requires no LLM tokens.

### Initial load (first run)

```bash
git log --format='%H|%an|%at|%s' --name-only -200
```

Parse into `git_patterns` rows. Derive `file_cochange` from co-occurring
files within each commit. Files that change together > N times are strongly
related regardless of directory structure.

### Incremental updates

On each orchestration run, query:

```bash
git log --format='%H|%an|%at|%s' --name-only \
  --since=<unix_timestamp_of_last_git_patterns_row>
```

Append new rows to `git_patterns`. Upsert `file_cochange` counts.

### Co-change query at decomposition time

When the user's intent mentions files in a region, query:

```sql
SELECT file_b, cochange_count
FROM file_cochange
WHERE file_a IN (<files_in_affected_regions>)
ORDER BY cochange_count DESC
LIMIT 10
```

This tells the decomposer: "when touching `src/api/router.ts`, also consider
`src/middleware/auth.ts` and `tests/api.test.ts`." The LLM can then include
those files in the appropriate subtask's `expectedFiles` rather than
discovering them mid-execution.

### Region insight generation

Runs as a background operation (not blocking the main workflow) when:

- A region has no entry in `region_insights`
- More than 20% of files in the region changed since `last_updated`

Input to the LLM: file list, top exported symbols, recent git commit messages
touching the region. Output: stored in `region_insights` as a structured
summary. This is the one place where a small LLM call is made proactively
rather than reactively.

> **Status:** Phase 3 fully implemented in `app/host/src/git/` and
> `app/host/src/workflow/region-insights.ts`. Git sync runs automatically
> during `loadWorkspaceContext`, and region insight refresh is triggered
> fire-and-forget after each orchestration run.

---

## Phase 4: Migration Execution Order

### Step 1 — NAPI-RS bridge

Create `crates/eisen-napi/` with `napi` + `napi-derive` dependencies.
Expose `parseWorkspace`, `parseFile`, `lookupSymbol`, `snapshot` as `#[napi]`
functions backed by existing `eisen-core` logic. Set up `@napi-rs/cli` build
and multi-platform CI matrix. Write the TypeScript wrapper in
`extension/src/napi/eisen.ts`. Verify JSON parity with PyO3 output.
Write integration tests. No removal of `pybridge/` yet.

### Step 2 — LibSQL module

Create `extension/src/db/` with schema init, migration, and query helpers.
Write unit tests for each table's read/write/staleness logic. Create
`.eisen/workspace.db` on first orchestration run.

Design the DB layer around a shared `WorkspaceDB` interface from the start:

- `PlainWorkspaceDB` — plaintext reads/writes, used by free-tier and in tests
- `SecureWorkspaceDB` — AES-256-GCM encrypted reads/writes for pro/premium
  (workspace key injected at construction, never written to disk)

This interface boundary costs nothing to add now and avoids a painful
refactor when `LIBSQL_ENCRYPT.md` is implemented. Add an `encryption.ts`
stub exporting `encrypt` / `decrypt` function signatures so callers can
reference it without the implementation being final.

### Step 3 — Port signatures to Mastra agents

Port each of the 4 DSPy signatures to Zod schemas + Mastra agents. Test each
independently against the same inputs used in the existing Python test suite.

### Step 4 — Build Mastra workflow

Wire the steps together. Integrate LibSQL reads and writes. Implement
suspend/resume for user approval. Connect to existing `ACPClient`.

### Step 5 — Replace OrchestratorBridge

New workflow runs directly in the extension process. Remove
`OrchestratorBridge`. Extension commands (`run`, `approve`, `retry`, `cancel`)
map to workflow operations.

### Step 6 — Git integration

Implement `git log` parsing on first run, incremental updates, co-change
derivation, and background region insight generation.

### Step 7 — Cleanup (Deferred to Hybrid Version)

> **Note:** Cleanup of Python artifacts is deferred. The legacy Python
> orchestrator has been moved to `dspy/` for reference. Mastra implementation
> work continues in the new `agent/` folder.

- Remove `dspy/` directory (legacy Python orchestrator) — deferred
- Remove `pybridge/` directory (PyO3 bridge superseded by NAPI-RS)
- Remove Maturin build config from `Cargo.toml` workspace
- Remove Python from CI/CD
- NAPI-RS multi-platform CI matrix handles native binary builds and publishing
- Pre-built `.node` binaries bundled per platform in the VS Code extension VSIX
- Update `README.md`

---

## Dependency Impact

### Added

| Package / artifact           | Purpose                                                           | External service? |
| ---------------------------- | ----------------------------------------------------------------- | ----------------- |
| `@mastra/core`               | Workflow engine, agent abstraction                                | No                |
| `@mastra/libsql`             | File-based SQLite storage                                         | No                |
| `ai`                         | Vercel AI SDK (LLM provider abstraction)                          | No                |
| `zod`                        | Runtime schema validation                                         | No                |
| `eisen-napi` (`.node` addon) | NAPI-RS — Rust parser as a Node-API native module                 | No                |
| Bun runtime                  | JS/TS runtime (fast startup, native bundler, Node-API compatible) | No                |

### Removed

| Package                          | Purpose                                    |
| -------------------------------- | ------------------------------------------ |
| `dspy>=2.5`                      | Python LLM framework (~25 transitive deps) |
| `agent-client-protocol` (Python) | Python ACP SDK                             |
| `python-dotenv`                  | Python env loading                         |
| `maturin>=1.0`                   | Python/Rust build tool                     |
| PyO3 bridge (`.so`)              | Replaced by NAPI-RS `.node` addon          |
| Python 3.11+ runtime             | Entire runtime requirement                 |
| Node.js runtime                  | Replaced by Bun                            |

**Cloud services required:** None.
**External services required:** None beyond existing LLM API keys.

---

## Open Questions

**1. Encryption and subscription enforcement**
The LibSQL database will need to be inert without a valid subscription key.
`LIBSQL_ENCRYPT.md` defines the full threat model, schema modifications,
auth API contract, and key lifecycle. No decisions should be made here —
this is a placeholder to ensure the DB module (`Step 2`) is designed with
a `WorkspaceDB` interface that cleanly separates plaintext and encrypted
implementations. Defer all auth and crypto specifics to that document.

**2. Symbol lookup latency**
NAPI-RS calls are in-process with no spawn overhead. The remaining cost is JSON
serialisation of the return value. The `symbol_cache` LibSQL table mitigates
hot-path lookups. If serialisation overhead becomes measurable at scale,
consider returning a `Buffer` directly from Rust rather than a JSON string —
defer until profiled.

**3. Semantic search on task_history**
Current Python `session_memory.py` uses Jaccard word overlap. This is fast and
requires no embedding model. Upgrade path: store embeddings in `task_history`
using a local model via Ollama. Defer until Jaccard proves insufficient.

**4. ConflictResolver**
Currently a DSPy signature (`ConflictResolve`) that LLM-merges conflicting
file writes. Zone enforcement in `eisen-core` prevents most conflicts before
they happen. Recommendation: start with last-write-wins in the TypeScript port,
revisit if conflicts surface in practice.

**5. NAPI-RS platform distribution**
`@napi-rs/cli` scaffolds the multi-platform GitHub Actions matrix and per-platform
npm package structure out of the box. Each platform produces a separate
`eisen-napi-<platform>` package listed as `optionalDependencies`. The correct
`.node` binary is resolved automatically at runtime. Bundling into the VSIX
requires including the resolved `.node` file in the extension package step.

**6. Mastra Studio**
Useful for debugging workflow steps during development. Enable via `mastra dev`
in development only. Not shipped to users.

---

## Related Documents

- `HYBRID_MASTRA_DSPY.md` — Optional offline DSPy optimizer that reads/writes
  LibSQL to improve Mastra workflow prompts over time
- `LIBSQL_ENCRYPT.md` — Encryption layer for the LibSQL database: threat model,
  encrypted vs plaintext table split, AES-256-GCM schema modifications,
  subscription tiers, API key auth flow, offline grace period, and key lifecycle.
  Implement after the base LibSQL module is stable.
- `TODO.md` — Actionable task checklist for this migration
- `FUTURE.md` — Longer-term feature brainstorming (Hot Zones, Agent Overlap,
  Blocker Zones)
