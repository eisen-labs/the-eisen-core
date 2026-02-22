# TODO — Mastra Migration & Workspace Learning

> Actionable task checklist for migrating from DSPy (Python) to Mastra
> (TypeScript) with per-workspace LibSQL. See `MASTRA.md` for the full
> architectural plan and `HYBRID_MASTRA_DSPY.md` for the optional offline
> DSPy optimizer.

## Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

---

## Phase 0: NAPI-RS Bridge

Replace the PyO3 bridge with a NAPI-RS `.node` addon. Bun supports Node-API
natively and explicitly recommends it as the stable path for native interop
(over `bun:ffi`, which is experimental with known bugs). The `.node` addon
loads in-process — no spawning, no JSON-over-stdio boundary.

- [x] Create `crates/eisen-napi/` crate with `napi` + `napi-derive` dependencies
- [x] Expose `parseWorkspace`, `parseFile`, `lookupSymbol`, `snapshot` as `#[napi]` fns
- [x] Add `@napi-rs/cli` as a dev dependency and configure build scripts
- [x] Write TypeScript wrapper at `extension/src/napi/eisen.ts`
- [x] Verify JSON output is identical to PyO3 bridge output for all four functions
- [x] Add integration tests for all four NAPI-RS exports (18 tests, `bun test`)
- [x] Set up GitHub Actions matrix for multi-platform `.node` builds
  - `linux-x64-gnu`, `darwin-arm64`, `darwin-x64`, `win32-x64-msvc`
- [x] Confirm `.node` binary is correctly bundled into the VS Code VSIX
- [x] Document NAPI-RS setup in `crates/eisen-napi/README.md`

---

## Phase 1: LibSQL Per-Workspace Database

Create `.eisen/workspace.db` in each workspace root. Zero external services.

- [x] Add `@libsql/client` dependency to `extension/` (using raw client, `@mastra/libsql` deferred to Phase 2)
- [x] Create `extension/src/db/` module with schema init and connection management
- [x] Implement schema auto-migration on version bump
- [x] `workspace_snapshots` table — tree_hash based staleness detection
- [x] `file_meta` table — mtime tracking per file
- [x] `git_patterns` table — initial load (last 200 commits) and incremental updates
- [x] `file_cochange` table — derive from `git_patterns`, upsert on new commits
- [x] `task_history` table — write after each orchestration run with quality score
- [x] `agent_performance` table — rolling success/token averages per agent/region/language
- [x] `region_insights` table — LLM-generated region summaries, refresh trigger on file changes
- [x] `symbol_cache` table — mtime-based cache for `lookup-symbol` CLI results
- [x] Auto-create `.eisen/workspace.db` on first orchestration run
- [x] Implement staleness refresh strategy (mtime sampling, tree_hash comparison)
- [x] Add DB vacuum/cleanup for long-lived workspaces

---

## Phase 2: Mastra Workflow

Replace `OrchestratorBridge` + Python process with a Mastra workflow running
directly in the eisen-host Bun process (`app/host/`).

**Dependencies**
- [x] Bun is the runtime for `app/host/` (compiles to standalone binary)
- [x] Add `@mastra/core` v1.5.0 to `app/host/` (`bun add @mastra/core`)
- [x] Add `ai` v6.x (Vercel AI SDK) to `app/host/` (`bun add ai`)
- [x] Add `zod` v4.x to `app/host/` (`bun add zod`)

**Port DSPy signatures to Zod schemas + Mastra agents**
- [x] `TaskDecompose` → `DecomposeOutputSchema` + Mastra agent (`app/host/src/workflow/schemas.ts`, `agents.ts`)
- [x] `AgentSelect` → `AgentSelectOutputSchema` + Mastra agent
- [x] `PromptBuild` → `PromptBuildOutputSchema` + Mastra agent
- [x] `ProgressEval` → `ProgressEvalOutputSchema` + Mastra agent

**Workflow steps**
- [x] `loadWorkspaceContext` — query LibSQL for context, call NAPI-RS `parseWorkspace` if stale (`context-loader.ts`)
- [x] `decomposeTask` — LLM structured output with workspace context injected (`orchestrate.ts`)
- [x] `assignAgents` — query `agent_performance` first, fall back to LLM (`orchestrate.ts`)
- [x] `confirmPlan` — IPC suspend/resume for user approval (sends `plan` event, awaits `approve` message)
- [x] `buildAndExecute` — topological batch execution via existing `ACPClient` (`orchestrate.ts`)
- [x] `evaluateAndRecord` — evaluate each subtask, write results to LibSQL (`orchestrate.ts`)

**Wiring**
- [x] Wire workflow into host `orchestrate` / `approve` / `retry` / `cancel` IPC commands (`app/host/src/index.ts`)
- [~] Remove `OrchestratorBridge` and `acp/orchestrator-bridge.ts` (kept for reference; not used by new workflow)
- [x] Port topological sort (`_build_execution_batches`) to TypeScript (`topo-sort.ts`)
- [~] Port A2A router to TypeScript (deferred — zone enforcement covers most cases)
- [ ] Port conflict detection and resolution to TypeScript (deferred — last-write-wins per MASTRA.md Open Questions)
- [x] Port zone enforcement to TypeScript (`zones.ts`)
- [x] Port cost tracking to TypeScript (`cost-tracker.ts`)

**Tests**
- [x] 33 workflow unit tests pass (`app/host/__tests__/workflow.test.ts`)
- [x] 23 DB tests still pass (`app/host/__tests__/db.test.ts`)
- [x] TypeScript compiles clean (`bunx tsc --noEmit`)

---

## Phase 3: Git Integration

Mine git history for workspace structure knowledge — zero LLM tokens.

**Git parsing and sync**
- [x] Parse `git log` on first run (last 200 commits) into `git_patterns` (`app/host/src/git/parser.ts`)
- [x] Incremental `git log --since=<timestamp>` on subsequent runs (`syncGitPatterns()` in `context-loader.ts`)
- [x] Derive `file_cochange` relationships from co-occurring files per commit (`db.deriveCochangeFromPatterns()`)

**Integration into workflow**
- [x] Query `file_cochange` during `loadWorkspaceContext` to enrich context (`context-loader.ts`)
- [x] Extract file-like tokens from user intent for co-change seeding (`extractFilesFromIntent()`)

**Region insights (background, LLM-powered)**
- [x] Trigger background `region_insights` generation after orchestration runs (`orchestrate.ts`)
- [x] Refresh `region_insights` when >20% of region files changed since last update (`region-insights.ts`)
- [x] Agent-generated descriptions, conventions, and dependencies stored in `region_insights` table

**New files**
- `app/host/src/git/parser.ts` — `git log` parser and spawn helper
- `app/host/src/git/index.ts` — barrel exports
- `app/host/src/workflow/region-insights.ts` — background insight generator
- `app/host/__tests__/git.test.ts` — 17 unit tests for git sync

**Tests**: 73 total tests pass (23 DB + 33 workflow + 17 git)

---

## Phase 4: Cleanup

Remove the Python runtime layer. The DSPy optimizer (`dspy/`) is kept as a
reference implementation for the hybrid optimizer (see `HYBRID_MASTRA_DSPY.md`).

- [ ] Remove `dspy/` directory (Python orchestrator) [DEFERRED — kept for hybrid optimizer reference]
- [x] Remove `pybridge/` directory (PyO3 bridge — superseded by NAPI-RS)
- [x] Remove `pybridge` from `Cargo.toml` workspace members
- [x] Remove Maturin build config and `pyproject.toml` (none at repo root — N/A)
- [x] Remove Python CI job from `check.yml` (`agent/` dir no longer exists)
- [x] Update `extension/package.json` scripts (no bridge-related scripts — N/A)
- [x] Update `README.md` — no Python setup instructions present — N/A

---

## Stretch: Hybrid DSPy Optimizer [DEFERRED]

Optional offline optimizer that reads `task_history` from LibSQL and writes
improved prompts back. See `HYBRID_MASTRA_DSPY.md` for full design.

> **Status:** Deferred. Will be implemented after Mastra core is stable.
> The legacy Python orchestrator remains available in `dspy/` for reference.

**Package setup**
- [ ] Create `optimizer/` directory in repo root
- [ ] Set up `optimizer/pyproject.toml` with `dspy>=2.5`, `libsql-client`
- [ ] Create `optimizer/src/eisen_optimizer/` package structure

**Core optimizer**
- [ ] Implement LibSQL reader/writer (`db.py`) using Python `libsql-client`
- [ ] Port `compile.py` → `optimizers/decompose.py` (BootstrapFewShot, default)
- [ ] Port `agent_stats.py` → `optimizers/assign.py` (rule generation)
- [ ] Add `optimizers/prompts.py` (PromptBuild optimization)
- [ ] Add `optimizers/insights.py` (region insight generation)
- [ ] Add `optimizers/profile.py` (workspace personality compilation)
- [ ] Add MIPROv2 strategy to each optimizer (`--strategy mipro`, premium)
- [ ] Improve quality metrics beyond the current non-empty check

**LibSQL schema additions for optimizer**
- [ ] `optimized_prompts` table — few-shot examples + system instructions per step
- [ ] `assignment_rules` table — learned agent assignment rules per region/language
- [ ] `workspace_profile` table — tech stack, conventions, architecture summary

**VS Code integration**
- [ ] Add "Optimize Workspace" command to extension command palette
- [ ] Extension spawns `python -m eisen_optimizer --workspace <path>` on command
- [ ] Show optimization progress and summary in extension UI
- [ ] Mastra `loadWorkspaceContext` reads `optimized_prompts` and `assignment_rules`
- [ ] Fall back gracefully to defaults when no optimized artifacts exist

**Migration of existing data**
- [ ] One-time migration: `~/.eisen/traces/*.json` → `task_history` table
- [ ] One-time migration: `~/.eisen/agent_stats.json` → `agent_performance` table
- [ ] One-time migration: `~/.eisen/compiled/*.json` → `optimized_prompts` table

**Optimizer CLI**
- [ ] `--dry-run` flag — show what would change without writing
- [ ] `--reset` flag — revert optimized artifacts to defaults
- [ ] `--target` flag — run a specific optimizer only
- [ ] `--history` flag — show optimization run history and quality deltas

---

## Stretch: LibSQL Advanced Features

- [ ] Semantic search on `task_history` using local embedding model (via Ollama)
- [ ] Auto-suggest workspace conventions surfaced from `file_meta` + `git_patterns`
- [ ] "Workspace personality" system prompt prefix derived from `workspace_profile`
- [ ] User feedback loop — thumbs up/down on orchestrator suggestions → update quality scores
- [ ] `eisen reset-db` command to clear workspace learnings
- [ ] `eisen-core serve` mode — persistent process with Unix socket for low-latency symbol lookup
- [ ] Export/import workspace learnings between machines

---

## Open Decisions

- [ ] **Intent similarity:** Jaccard word overlap (current) vs. local embedding model
- [ ] **ConflictResolver:** Port DSPy signature to Mastra agent, or simplify to last-write-wins
- [ ] **`eisen-core serve` mode:** Implement now or defer until spawn latency is measured as a bottleneck
- [ ] **Mastra Studio:** Include in dev workflow for debugging, or skip
- [ ] **MIPROv2 paywall boundary:** Per-workspace license check, cloud validation, or honour system
