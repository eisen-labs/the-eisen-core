# Testing the Eisen Orchestration Agent (CLI Only)

Local CLI testing guide. No frontend/extension integration required.

## Prerequisites

```bash
python3 --version  # >= 3.11
cargo --version

cd agent
uv sync --extra dev

# Build eisen-core binary
cd .. && cargo build -p eisen-core --release
```

## 1. Unit Tests (No LLM Required)

```bash
cd agent
uv run python -m pytest tests/ -v
```

Expected: 226 tests pass. Run specific groups:

```bash
# Phase 0: PyO3 bridge
uv run python -m pytest tests/test_bridge.py -v

# Phase 1: signatures, ACP, orchestrator, cost
uv run python -m pytest tests/test_signatures.py tests/test_acp_session.py \
  tests/test_orchestrator.py tests/test_cost.py -v

# Phase 2: lifecycle, router, extension protocol
uv run python -m pytest tests/test_lifecycle.py tests/test_router.py \
  tests/test_ext_protocol.py -v

# Phase 3: zones, blocked listener, conflict
uv run python -m pytest tests/test_zones.py tests/test_blocked_listener.py \
  tests/test_conflict.py -v

# Phase 4: traces, stats, sessions, persistence, perf, compilation
uv run python -m pytest tests/test_trace_collector.py tests/test_agent_stats.py \
  tests/test_session_memory.py tests/test_persistence.py \
  tests/test_perf.py tests/test_compile.py -v
```

## 2. PyO3 Bridge

```bash
uv run python -c "
import eisen_bridge, json
tree = json.loads(eisen_bridge.parse_workspace('.'))
print(json.dumps(tree, indent=2)[:500])
"

uv run python -c "
import eisen_bridge, json
snap = json.loads(eisen_bridge.snapshot('.'))
print(f'Nodes: {len(snap.get(\"nodes\", {}))}')
"

uv run python -c "
import eisen_bridge, json
matches = json.loads(eisen_bridge.lookup_symbol('.', 'Orchestrator'))
print(f'Found {len(matches)} match(es)')
for m in matches[:3]:
    print(f'  {m.get(\"kind\")} {m.get(\"name\")} in {m.get(\"path\")}')
"
```

## 3. CLI Info Commands (No LLM Required)

```bash
uv run python -m eisen_agent --help
uv run python -m eisen_agent --stats        # Agent performance (empty initially)
uv run python -m eisen_agent --sessions     # Previous sessions (empty initially)
uv run python -m eisen_agent --resume       # "No resumable runs found"
```

## 4. Full Orchestration (Requires LLM)

Set an LLM backend by creating a `.env` file (the agent loads it automatically via `python-dotenv`):

```bash
cp .env.example .env
# Edit .env — uncomment ONE provider block and fill in your key
```

For example, to use Anthropic:

```env
ANTHROPIC_API_KEY=sk-ant-...
EISEN_AGENT_MODEL=anthropic/claude-sonnet-4-20250514
```

See [`.env.example`](.env.example) for all available options.

### Dry run (reject plan)

```bash
uv run python -m eisen_agent --workspace /path/to/project --effort medium
# Type: "add a hello world function to the main file"
# Press Enter twice, review plan, type 'n' to reject
```

### Auto-approve

```bash
uv run python -m eisen_agent --workspace . --effort low --auto-approve
# Type: "list the files in the ui directory"
# Requires a coding agent on PATH (opencode, claude-code, etc.)
```

### User overrides

```bash
uv run python -m eisen_agent --workspace .
# Type: "use claude for /ui and assign opencode to /core"
# Verify agent assignments in the plan
```

## 5. Phase 4: Trace Collection

Traces are saved automatically after each orchestration run:

```bash
ls ~/.eisen/traces/
cat ~/.eisen/traces/run_*.json | python -m json.tool | head -40

uv run python -c "
from eisen_agent.training.collector import TraceCollector
tc = TraceCollector()
print(f'Traces: {tc.count_traces()}')
for t in tc.load_traces(min_quality=0.0):
    print(f'  {t.run_id}: quality={t.quality:.2f}, \"{t.user_intent[:50]}\"')
"
```

## 6. Phase 4: DSPy Compilation

Requires 2+ traces with quality >= 0.5:

```bash
uv run python -m eisen_agent --compile
ls ~/.eisen/compiled/  # decompose.json, agent_select.json, prompt_build.json
```

## 7. Phase 4: Agent Stats

Recorded automatically after each run:

```bash
uv run python -m eisen_agent --stats

uv run python -c "
from eisen_agent.training.agent_stats import AgentStats
stats = AgentStats()
best = stats.best_agent_for('ui', 'typescript')
print(f'Best for ui/ts: {best or \"insufficient data (need 3+ runs)\"}')
"
```

## 8. Phase 4: Session Memory

Saved automatically after each run:

```bash
uv run python -m eisen_agent --sessions

uv run python -c "
from eisen_agent.session_memory import SessionMemory
mem = SessionMemory()
results = mem.load_relevant_context('update auth', '/path/to/workspace')
for ctx in results:
    print(f'Relevant: {ctx.session_id} - {ctx.user_intent[:60]}')
"
```

## 9. Phase 4: Persistence & Resume

```bash
uv run python -c "
from eisen_agent.persistence import RunPersistence
rp = RunPersistence()
for run in rp.list_resumable():
    print(f'{run.run_id}: \"{run.user_intent[:50]}\" ({run.progress_summary})')
"

# Resume interactively
uv run python -m eisen_agent --resume

# Resume specific run
uv run python -m eisen_agent --resume-id <run-id>
```

## 10. Extension Protocol (JSON mode)

```bash
echo '{"type":"run","intent":"list files","effort":"low"}' | \
  uv run python -m eisen_agent --mode extension --workspace .
```

## 11. Data Storage

```bash
find ~/.eisen -type f | sort
# ~/.eisen/
# ├── traces/run_*.json        # DSPy compilation traces
# ├── compiled/*.json           # Compiled DSPy modules
# ├── agent_stats.json          # Agent performance data
# ├── sessions/sess_*.json      # Previous session context
# ├── runs/run_*.json           # In-progress run state
# └── cache/                    # Symbol tree cache

# Clean all data
rm -rf ~/.eisen
```

## 12. Rust Tests

```bash
cargo test --workspace
cargo test -p eisen-core zone        # Zone enforcement
cargo test -p eisen-core wire_format # Wire protocol
```

## Quick Smoke Test (No LLM)

```bash
cd agent
uv run python -m pytest tests/ -v --tb=short
uv run python -c "import eisen_bridge; print('Bridge OK')"
uv run python -m eisen_agent --help
uv run python -m eisen_agent --stats
uv run python -m eisen_agent --sessions
uv run python -c "
from eisen_agent.training.collector import TraceCollector
from eisen_agent.training.agent_stats import AgentStats
from eisen_agent.training.compile import load_module
from eisen_agent.session_memory import SessionMemory
from eisen_agent.persistence import RunPersistence
from eisen_agent.perf import SymbolTreeCache
print('All Phase 4 modules import OK')
"
```
