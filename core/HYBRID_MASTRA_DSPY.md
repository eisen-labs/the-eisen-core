# Hybrid Architecture: Mastra (Runtime) + DSPy (Offline Optimizer)

> This document describes the optional offline DSPy optimizer that sits on top
> of the Mastra migration described in `MASTRA.md`. The optimizer is never a
> runtime dependency — Eisen works fully without it. It is a power-user tool
> that learns from accumulated orchestration history to improve Mastra's
> prompts and agent assignments over time.
>
> **Runtime context:** The Mastra runtime layer runs on **Bun** (replacing
> Node.js). Rust logic is called in-process via a **NAPI-RS** `.node` addon —
> the stable, Bun-endorsed path for native interop. The DSPy optimizer is a
> separate offline Python process that communicates only through LibSQL reads
> and writes; it has no dependency on Bun or the NAPI-RS bridge.

---

## Overview

After the Mastra migration, the Python layer is gone from the critical path.
But DSPy's unique capability — automated prompt optimization from real
execution traces — is still valuable. Rather than discarding it, we relocate
it to an **offline feedback loop** that runs on demand, reads from LibSQL, and
writes improved artifacts back. Mastra picks those up on the next run.

```
┌─────────────────────────────────────────────────────────┐
│                    RUNTIME (critical path)               │
│                                                          │
│  User Query → Mastra Workflow → ACPClient → AI Agents   │
│                    │                                     │
│                    ▼                                     │
│           .eisen/workspace.db (LibSQL)                   │
│              ├── task_history      ◄── written each run  │
│              ├── agent_performance ◄── written each run  │
│              ├── optimized_prompts ──► read if present   │
│              └── assignment_rules  ──► read if present   │
└──────────────────────────────┬──────────────────────────┘
                               │
                         (async, on demand)
                               │
┌──────────────────────────────▼──────────────────────────┐
│               OFFLINE OPTIMIZER (optional)               │
│                                                          │
│  "Optimize Workspace" VS Code command                    │
│       │                                                  │
│       ▼                                                  │
│  python -m eisen_optimizer --workspace <path>            │
│       │                                                  │
│       ├── Read task_history (traces of past runs)        │
│       ├── Read agent_performance (success rates)         │
│       ├── Run DSPy optimization (BootstrapFewShot        │
│       │     or MIPROv2 for premium users)                │
│       │                                                  │
│       └── Write back to LibSQL:                          │
│             ├── optimized_prompts (few-shot + instruct.) │
│             ├── assignment_rules (agent heuristics)      │
│             └── workspace_profile (conventions summary)  │
└─────────────────────────────────────────────────────────┘
```

**Key properties:**
- Mastra workflow is **unchanged** by the optimizer — it reads optional
  artifacts and falls back to defaults when absent
- Python is **never spawned** during normal orchestration
- The optimizer is **triggered explicitly** via VS Code command or auto-suggested
  when trace volume reaches a useful threshold
- Results are **versioned and reversible** — roll back any optimization run

---

## What DSPy Optimizes

### 1. Task Decomposition Prompts

**Problem:** The default `decomposeTask` system prompt is static. A workspace
heavy on microservices decomposes differently from a monolith. A TypeScript
codebase has different patterns from a Rust one.

**What DSPy does:**
- Reads `task_history` rows where `quality_score >= 0.8`
- Extracts `(user_intent, workspace_context, subtasks)` triples as training examples
- Runs BootstrapFewShot (or MIPROv2) against the `TaskDecompose` signature
- Produces: few-shot examples of good decompositions + optimized system instructions

**Written to LibSQL:**
```sql
INSERT OR REPLACE INTO optimized_prompts (target_step, system_prompt, few_shot_json,
  version, compiled_at, trace_count, quality_delta)
VALUES ('decompose', '<optimized instructions>', '<few-shot JSON>', 2, ..., 47, +0.12);
```

**Read by Mastra:**
The `loadWorkspaceContext` step queries `optimized_prompts WHERE target_step = 'decompose'`
and injects the few-shot examples into the `decomposeTask` agent context. If
absent, the default static prompt is used.

---

### 2. Agent Assignment Rules

**Problem:** The `assignAgents` step currently calls an LLM for every subtask.
But after 20+ runs, the pattern is clear: "claude-code always wins for
TypeScript in `src/api/`." This is wasteful — it should be a table lookup.

**What DSPy does:**
- Reads `agent_performance` grouped by `(agent_type, region, language)`
- For groups with ≥3 samples and a dominant winner (>20% margin), generates
  deterministic assignment rules
- Runs BootstrapFewShot on `AgentSelect` examples from successful runs to
  improve the LLM fallback for novel situations

**Written to LibSQL:**
```sql
INSERT OR REPLACE INTO assignment_rules
  (region_pattern, language, task_type, preferred_agent, confidence, sample_count, created_at)
VALUES ('src/api/**', 'typescript', '', 'claude-code', 0.92, 12, ...);
```

**Read by Mastra:**
The `assignAgents` step queries `assignment_rules` first. If a confident match
exists (confidence > 0.75, sample_count >= 3), it skips the LLM call entirely
and uses the rule directly. Saves tokens on every subtask where the answer is
already known.

---

### 3. Region Insights

**Problem:** Region descriptions in `region_insights` are generated one at a
time as background LLM calls. They lack synthesis across the whole workspace —
a description of `src/api/` doesn't know how it relates to `src/middleware/`.

**What DSPy does:**
- Reads `region_insights`, `git_patterns`, `file_cochange`, and `file_meta`
- Generates a richer cross-region description that includes dependency
  relationships and historical change patterns
- Rewrites `region_insights` rows with synthesized descriptions

This is less about prompt optimization and more about using DSPy's
`ChainOfThought` to produce higher-quality structured summaries than a single
background LLM call can manage.

---

### 4. Prompt Templates

**Problem:** The `buildPrompts` step generates agent prompts from scratch for
every subtask. Successful runs have already figured out what works.

**What DSPy does:**
- Reads `task_history` subtask-level data where status = 'completed'
- Identifies prompt structures that correlate with first-attempt success
- Runs BootstrapFewShot on `PromptBuild` examples
- Produces optimized prompt templates per `effort_level`

**Written to LibSQL:**
```sql
INSERT OR REPLACE INTO optimized_prompts (target_step, system_prompt, few_shot_json, ...)
VALUES ('prompt_build_high', '<optimized instructions for high effort>', ...);
```

---

### 5. Workspace Personality Profile

**Problem:** Every orchestration run rebuilds workspace context from scratch.
The tech stack, architectural patterns, and conventions of the workspace are
stable — they should be captured once and reused.

**What DSPy does:**
- Reads all available LibSQL data holistically
- Produces a structured `workspace_profile` row summarizing:
  - Tech stack (languages, frameworks, build tools)
  - Architecture pattern (monolith, monorepo, microservices, etc.)
  - Naming and structure conventions
  - Common task types observed in `task_history`

**Written to LibSQL:**
```sql
INSERT OR REPLACE INTO workspace_profile
  (workspace_path, tech_stack, conventions, architecture, common_tasks, updated_at)
VALUES ('/path/to/project', '{"languages":["typescript","rust"],...}', ...);
```

**Read by Mastra:**
The `loadWorkspaceContext` step prepends the `workspace_profile` as a short
system prompt prefix for all LLM calls. This replaces the current approach of
re-deriving workspace characteristics from the symbol index on every run.

---

## Optimization Strategies

### BootstrapFewShot (default, free tier)

**How it works:**

1. Takes training examples (high-quality traces from `task_history`)
2. Runs each example through the module, collects the outputs
3. Filters outputs by a quality metric
4. Selects the best outputs as few-shot demonstrations
5. Prepends those demonstrations to future prompts

**Characteristics:**

| Property | Value |
|---|---|
| Cost per run | ~$0.50 (depends on trace count and model) |
| Time per run | ~1 minute |
| Minimum traces needed | 2 (useful results from ~10+) |
| What it optimizes | Few-shot demonstrations only |
| Deterministic | Yes — same traces produce same demos |
| Debuggable | Yes — read the selected examples directly |

**Best for:** Workspaces in early use (10-50 runs). Gets the LLM to
pattern-match on concrete examples of good decompositions. Works well for
task decomposition and prompt building where "show don't tell" is effective.

**Limitation:** Does not discover new strategies or phrasings. If the baseline
prompts have structural problems, few-shot can't fix them — it can only
demonstrate the best available behavior.

---

### MIPROv2 (premium, `--strategy mipro`)

**How it works:**

1. **Bootstrap stage:** Same as BootstrapFewShot — collect demonstrations
2. **Grounded proposal stage:** An LLM reads the task, training data, and
   existing instructions, then drafts multiple candidate instruction sets
3. **Discrete search stage:** Samples combinations of (instructions +
   demonstrations), evaluates each on mini-batches using a quality metric,
   uses a surrogate model (Bayesian optimization) to converge on the best
   combination

**Characteristics:**

| Property | Value |
|---|---|
| Cost per run | ~$2-5 (depends on `num_candidates`, `num_trials`) |
| Time per run | ~15-30 minutes |
| Minimum traces needed | 20 (useful results from ~50+) |
| What it optimizes | Instructions **and** demonstrations |
| Deterministic | No — search is stochastic |
| Debuggable | Medium — inspect generated instructions |

**Best for:** Workspaces with 50+ runs where BootstrapFewShot has plateaued.
MIPROv2 can discover that "decompose by ownership boundary rather than
directory structure" works better for this specific workspace, or that the
agent assignment prompt should emphasize token efficiency for Rust tasks.

**Premium gate:** MIPROv2 runs are gated behind a license check in
`eisen_optimizer/cli.py`. The BootstrapFewShot path is always available.

---

### Strategy Comparison for Eisen's Four Signatures

| Signature | BootstrapFewShot fit | MIPROv2 fit | Notes |
|---|---|---|---|
| `TaskDecompose` | Good — concrete decomposition examples transfer well | Excellent — can learn workspace-specific decomposition strategies | Highest value target for MIPROv2 |
| `AgentSelect` | Moderate — examples help but rules (see above) often supersede | Good — can learn nuanced assignment reasoning | Rules generated from `agent_performance` often make LLM fallback rare |
| `PromptBuild` | Good — successful prompt structures are clear examples | Moderate — prompt structure is fairly stable | BootstrapFewShot likely sufficient |
| `ProgressEval` | Low — evaluation criteria are stable, don't need optimization | Low | Leave as static prompt; optimize only if eval accuracy becomes a problem |

**Recommended progression:**

```
Runs 0-10:   No optimization needed, defaults are fine
Runs 10-50:  Run BootstrapFewShot on TaskDecompose and PromptBuild
Runs 50+:    Run MIPROv2 on TaskDecompose (premium)
             Generate assignment_rules from agent_performance (no DSPy needed)
             Run BootstrapFewShot on AgentSelect LLM fallback
```

---

## Implementation

### Package structure (in-repo, `optimizer/` directory)

```
optimizer/
  pyproject.toml
  README.md
  src/
    eisen_optimizer/
      __init__.py
      cli.py                  # Entry point: python -m eisen_optimizer
      db.py                   # LibSQL read/write via Python libsql-client
      license.py              # Premium strategy gate (MIPROv2 check)
      metrics.py              # Quality metrics for all four signatures
      signatures.py           # DSPy signatures (ported from agent/signatures/)
      optimizers/
        __init__.py
        decompose.py          # BootstrapFewShot + MIPROv2 on TaskDecompose
        assign.py             # Rule generation from agent_performance + AgentSelect
        prompts.py            # BootstrapFewShot on PromptBuild
        insights.py           # Region insight synthesis via ChainOfThought
        profile.py            # Workspace personality compilation
```

### pyproject.toml

```toml
[project]
name = "eisen-optimizer"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "dspy>=2.5",
    "libsql-client>=0.3",
]

[project.scripts]
eisen-optimizer = "eisen_optimizer.cli:main"
```

### CLI interface

```
# Run all optimizers (BootstrapFewShot by default)
python -m eisen_optimizer --workspace /path/to/project

# Run specific optimizer
python -m eisen_optimizer --workspace /path/to/project --target decompose

# Premium: use MIPROv2 (requires valid license)
python -m eisen_optimizer --workspace /path/to/project --strategy mipro

# Preview what would change without writing
python -m eisen_optimizer --workspace /path/to/project --dry-run

# Revert all optimized artifacts to defaults
python -m eisen_optimizer --workspace /path/to/project --reset

# Show optimization history and quality deltas
python -m eisen_optimizer --workspace /path/to/project --history
```

### VS Code integration

The "Optimize Workspace" command in the extension command palette:

1. Checks whether `python` (or `python3`) is available in PATH
2. Checks whether `eisen_optimizer` is installed (`python -m eisen_optimizer --version`)
3. If not installed, shows a notification with install instructions
4. If installed, spawns `python -m eisen_optimizer --workspace <workspacePath>`
5. Streams stdout to an output channel ("Eisen Optimizer") in VS Code
6. On completion, shows a summary notification: "Optimization complete.
   TaskDecompose improved by +12% quality delta. 47 traces used."
7. No restart required — the next orchestration run reads the new artifacts

For premium users, the command includes a `--strategy mipro` flag gated behind
a license check. The optimizer itself validates the license and exits cleanly
with a descriptive message if invalid.

---

## LibSQL Schema Additions

These three tables are written by the optimizer and read by Mastra. They are
added to `.eisen/workspace.db` alongside the base schema defined in `MASTRA.md`.

```sql
-- Optimized prompts written by DSPy, read by Mastra workflow steps.
CREATE TABLE IF NOT EXISTS optimized_prompts (
  target_step   TEXT PRIMARY KEY,   -- 'decompose' | 'assign' | 'prompt_build_low'
                                    -- | 'prompt_build_medium' | 'prompt_build_high'
  system_prompt TEXT NOT NULL,      -- optimized system instructions
  few_shot_json TEXT NOT NULL,      -- JSON array of {input, output} example pairs
  strategy      TEXT NOT NULL,      -- 'bootstrap' | 'mipro'
  version       INTEGER NOT NULL DEFAULT 1,
  compiled_at   INTEGER NOT NULL,   -- unix ms
  trace_count   INTEGER NOT NULL,   -- number of traces used for optimization
  quality_delta REAL                -- improvement over baseline (positive = better)
);

-- Learned agent assignment rules. High-confidence rules skip the LLM entirely.
CREATE TABLE IF NOT EXISTS assignment_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  region_pattern  TEXT NOT NULL,    -- glob pattern, e.g. 'src/api/**'
  language        TEXT NOT NULL,    -- primary language in region
  task_type       TEXT DEFAULT '',  -- empty = applies to all task types
  preferred_agent TEXT NOT NULL,    -- agent_id, e.g. 'claude-code'
  confidence      REAL NOT NULL,    -- 0.0 to 1.0
  sample_count    INTEGER NOT NULL, -- number of observations backing this rule
  created_at      INTEGER NOT NULL  -- unix ms
);

-- Workspace-level profile. Short summary prepended to all LLM system prompts.
CREATE TABLE IF NOT EXISTS workspace_profile (
  workspace_path TEXT PRIMARY KEY,
  tech_stack     TEXT,              -- JSON: {languages, frameworks, build_tools}
  conventions    TEXT,              -- detected naming and structure patterns
  architecture   TEXT,              -- 'monolith' | 'monorepo' | 'microservices' | ...
  common_tasks   TEXT,              -- JSON: frequent task types from task_history
  updated_at     INTEGER NOT NULL   -- unix ms
);
```

---

## How Mastra Reads Optimized Artifacts

The optimizer writes; Mastra reads. The interface is the LibSQL tables above.
No direct Python↔TypeScript communication at runtime.

```typescript
// In loadWorkspaceContext step (extension/src/orchestrator/workflow/steps/loadContext.ts)

// 1. Check for optimized decomposition prompt
const optimizedDecompose = await db.get(
  'SELECT system_prompt, few_shot_json FROM optimized_prompts WHERE target_step = ?',
  ['decompose']
);

// 2. Check for workspace profile
const profile = await db.get(
  'SELECT tech_stack, conventions, architecture FROM workspace_profile WHERE workspace_path = ?',
  [workspacePath]
);

// 3. Check for high-confidence assignment rules for this region
const assignmentRules = await db.all(
  `SELECT preferred_agent, confidence FROM assignment_rules
   WHERE language = ? AND confidence > 0.75 AND sample_count >= 3
   ORDER BY confidence DESC`,
  [primaryLanguage]
);

return {
  // Injected into decomposeTask agent as system prompt additions
  decomposeSystemPrompt: optimizedDecompose?.system_prompt ?? DEFAULT_DECOMPOSE_PROMPT,
  decomposeFewShot:      optimizedDecompose ? JSON.parse(optimizedDecompose.few_shot_json) : [],

  // Prepended to all LLM calls as workspace context
  workspaceProfile: profile ?? null,

  // Used in assignAgents to skip LLM for known patterns
  assignmentRules: assignmentRules ?? [],

  // ... rest of context (co-change, region insights, etc.)
};
```

```typescript
// In assignAgents step — skip LLM when a rule covers this case

const rule = context.assignmentRules.find(r =>
  micromatch.isMatch(subtask.region, r.region_pattern)
);

if (rule && rule.confidence > 0.75) {
  return {
    agentId: rule.preferred_agent,
    reasoning: `Learned from ${rule.sample_count} previous runs (confidence: ${rule.confidence.toFixed(2)})`,
    source: 'learned-rule',
  };
}

// Fall back to LLM with optimized prompt
return await assignAgentLLM(subtask, context);
```

---

## Quality Metrics (Improved Over Current)

The current `_quality_metric` in `compile.py` is trivially weak:
```python
def _quality_metric(example, prediction, trace=None) -> bool:
    return bool(prediction.subtasks)  # just checks non-empty
```

This means any decomposition that produces output, no matter how poor, counts
as a success. Replacing this is the most impactful change in the optimizer.

### Decomposition quality metric

```python
def decompose_metric(example: dspy.Example, prediction, trace=None) -> float:
    score = 0.0

    # 1. Outcome: did the actual run succeed? (from task_history quality_score)
    score += example.quality_score * 0.5  # 50% weight on real outcome

    # 2. Coverage: do subtasks span all regions that were actually touched?
    predicted_regions = {s['region'] for s in prediction.subtasks}
    actual_regions    = {r['region'] for r in example.results}
    if actual_regions:
        coverage = len(predicted_regions & actual_regions) / len(actual_regions)
        score += coverage * 0.2

    # 3. Granularity: penalize single-subtask decompositions for complex tasks
    if len(example.results) > 2 and len(prediction.subtasks) == 1:
        score -= 0.1

    # 4. Dependency correctness: were depends_on orderings respected in execution?
    # (Check against actual execution batch order recorded in task_history)
    score += example.dependency_score * 0.2  # pre-computed from task_history

    # 5. Efficiency: fewer subtasks for same outcome (penalize over-decomposition)
    efficiency = min(len(example.results), len(prediction.subtasks)) / \
                 max(len(example.results), len(prediction.subtasks))
    score += efficiency * 0.1

    return min(score, 1.0)
```

### Agent assignment quality metric

```python
def assign_metric(example: dspy.Example, prediction, trace=None) -> float:
    # Did this agent actually succeed on this subtask?
    if prediction.agent_id == example.agent_id and example.status == 'completed':
        base = 1.0
    elif example.status == 'completed':
        base = 0.3  # different agent but task still succeeded
    else:
        base = 0.0  # failed

    # Bonus for token efficiency
    if example.cost_tokens and example.cost_tokens < example.avg_tokens_for_agent:
        base += 0.1

    # Penalty if the assignment needed a retry
    if example.needed_retry:
        base -= 0.2

    return max(0.0, min(base, 1.0))
```

### Prompt quality metric

```python
def prompt_metric(example: dspy.Example, prediction, trace=None) -> float:
    # Did the agent complete without retry on this prompt?
    score = 1.0 if example.status == 'completed' and not example.needed_retry else 0.3

    # Penalize prompts that led to high token usage relative to task complexity
    if example.cost_tokens and example.baseline_tokens:
        efficiency = example.baseline_tokens / max(example.cost_tokens, 1)
        score *= min(efficiency, 1.0)

    return score
```

---

## Upgrade Path from Current DSPy

The current `agent/src/eisen_agent/training/` code has much of the logic
already. Here is what migrates to `optimizer/`:

### What stays (refactored into optimizer/)

| Current file | Destination | Changes |
|---|---|---|
| `training/compile.py` | `optimizers/decompose.py`, `assign.py`, `prompts.py` | Storage: JSON files → LibSQL; metrics: trivial → meaningful |
| `training/collector.py` | `db.py` | Reads from LibSQL `task_history` instead of `~/.eisen/traces/` |
| `training/agent_stats.py` | `optimizers/assign.py` | Reads from LibSQL `agent_performance` instead of `~/.eisen/agent_stats.json` |
| `signatures/*.py` | `signatures.py` | Identical DSPy signatures — straight copy |

### What changes

- **Storage:** `~/.eisen/traces/*.json` → `task_history` in LibSQL  
- **Storage:** `~/.eisen/agent_stats.json` → `agent_performance` in LibSQL  
- **Storage:** `~/.eisen/compiled/*.json` → `optimized_prompts` in LibSQL  
- **Runtime:** DSPy is completely removed from the orchestration critical path
- **Package:** Moves from `agent/` (required) to `optimizer/` (optional)
- **Interface:** CLI → VS Code command (spawns subprocess, streams output)

### One-time data migration

When the optimizer is first run against a workspace that previously used the
Python orchestrator, it migrates existing data automatically:

```python
# eisen_optimizer/cli.py -- run before first optimization

def migrate_legacy_data(workspace_path: str, db: EisenDB) -> None:
    traces_dir = Path.home() / '.eisen' / 'traces'
    stats_path  = Path.home() / '.eisen' / 'agent_stats.json'

    # Migrate trace JSON files → task_history table
    for trace_file in traces_dir.glob('run_*.json'):
        entry = json.loads(trace_file.read_text())
        db.insert_task_history(entry)

    # Migrate agent_stats.json → agent_performance table
    if stats_path.exists():
        stats = json.loads(stats_path.read_text())
        for key, perf in stats.items():
            db.upsert_agent_performance(perf)
```

---

## Trigger Strategies

| Trigger | Condition | Action |
|---|---|---|
| **Manual** | User runs "Optimize Workspace" command | Run all optimizers immediately |
| **Threshold** | `task_history` count reaches 20 runs | Show notification: "Enough data to optimize — run now?" |
| **Stale** | `optimized_prompts.compiled_at` is >30 days old and new traces exist | Show notification on workspace open |
| **Degradation** | Rolling 7-day quality average drops >10% from historical average | Proactive notification: "Recent runs performing worse — optimize?" |
| **Post-cleanup** | After major refactor (many files changed) | Auto-invalidate `assignment_rules` in affected regions; suggest re-run |

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Python remains a dependency | Optional — Mastra works fully without it. Extension gracefully handles `python` not found. |
| Two frameworks to debug | Clear boundary: DSPy only reads/writes LibSQL. No Python↔TypeScript calls at runtime. |
| Optimization makes things worse | `quality_delta` tracked per artifact. `--reset` reverts to defaults. Version column allows rollback. |
| Stale optimized artifacts | `compiled_at` + `trace_count` tracked. Degradation trigger auto-suggests re-run. |
| MIPROv2 non-determinism | Run results vary. Store best result by quality metric. Re-run if result looks wrong. |
| Cold start (no traces) | Mastra defaults used when `optimized_prompts` is empty. Optimizer is a no-op with <2 traces. |
| Over-fitting to workspace | Optimizer only runs on same-workspace traces. Cross-workspace contamination is impossible. |

---

## When to Implement

**Defer optimizer implementation until:**
1. The Mastra migration (`MASTRA.md`) is complete and stable
2. LibSQL is collecting real orchestration data (50+ runs from real usage)
3. Manual inspection of `task_history` reveals patterns that better prompts
   would meaningfully address

**Ship as:**
- In-repo `optimizer/` Python package (same repo, separate pip install)
- VS Code "Optimize Workspace" command (optional, not auto-run)
- Never a runtime dependency or auto-installed requirement

**MIPROv2 paywall:**
- BootstrapFewShot: always free, bundled with `optimizer/`
- MIPROv2: gated via `license.py` check — implementation TBD (see open
  decisions in `TODO.md`)

---

## Related Documents

- `MASTRA.md` — Full Mastra migration plan (prerequisite for this)
- `TODO.md` — Actionable checklist including optimizer tasks under "Stretch"
- `FUTURE.md` — Longer-term feature brainstorming (Hot Zones, Agent Overlap)
