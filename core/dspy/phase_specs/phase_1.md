# Phase 1: Single-Agent Orchestration

## Status: Complete

## Prerequisites

- Phase 0 complete (PyO3 bridge working, Python package builds, `eisen_bridge` importable)

## Goal

The orchestration agent can receive a user's feature request, decompose it into subtasks scoped to workspace regions, spawn a single coding agent with a guided prompt, monitor its progress, and report the result. This validates the full orchestration loop before adding multi-agent complexity in Phase 2.

## Context

### What Exists After Phase 0

- `pybridge/` crate exposes `parse_workspace()`, `snapshot()`, `lookup_symbol()` to Python
- `agent/` Python package with `eisen_agent` module, config, CLI stub
- `agent-client-protocol` pip package available for ACP client-side communication
- `dspy` pip package available for prompt composition

### Architecture for Phase 1

```
User (CLI stdin)
    |
    v
eisen-agent (Python)
    |
    |-- DSPy: TaskDecompose --> subtasks with regions
    |-- DSPy: AgentSelect   --> pick agent type
    |-- DSPy: PromptBuild   --> guided prompt at effort level
    |-- PyO3: eisen_bridge   --> symbol tree for context
    |
    v
ACP Session Manager
    |
    |-- spawns: eisen-core observe --agent-id X -- <agent-cmd>
    |-- sends: initialize, session/new, session/prompt
    |-- receives: session/update (streaming)
    |-- detects: stopReason (task complete)
    |
    v
Single coding agent (claude-code, opencode, codex, etc.)
```

### Key Constraint: One Agent at a Time

Phase 1 is deliberately single-agent. The orchestrator decomposes the task into subtasks but executes them **sequentially** with one agent at a time. Phase 2 adds parallel execution.

---

## Tasks

### 1A. DSPy Signatures

Define the four core DSPy signatures that power the orchestrator's reasoning.

- [x] Create `agent/src/eisen_agent/signatures/__init__.py`

- [x] Create `agent/src/eisen_agent/signatures/decompose.py`:
  ```python
  """Task decomposition: user intent --> subtasks with workspace regions."""
  import dspy
  from dataclasses import dataclass


  @dataclass
  class Subtask:
      description: str
      region: str          # workspace path, e.g. "/ui", "/core/src/parser"
      expected_files: list[str]  # files likely to be created/modified
      depends_on: list[int]      # indices of subtasks this depends on (for ordering)


  class TaskDecompose(dspy.Signature):
      """Decompose a user's feature request into parallel subtasks,
      each scoped to a workspace region (directory subtree)."""

      user_intent: str = dspy.InputField(
          desc="The user's feature request in natural language"
      )
      workspace_tree: str = dspy.InputField(
          desc="Top-level directory structure of the workspace"
      )
      symbol_index: str = dspy.InputField(
          desc="Key symbols (functions, classes, types) per directory region"
      )

      subtasks: list[dict] = dspy.OutputField(
          desc="List of subtask objects with: description, region, expected_files, depends_on"
      )
      reasoning: str = dspy.OutputField(
          desc="Explanation of why this decomposition makes sense"
      )
  ```

- [x] Create `agent/src/eisen_agent/signatures/assign.py`:
  ```python
  """Agent selection: subtask characteristics --> best agent type."""
  import dspy


  class AgentSelect(dspy.Signature):
      """Select the best coding agent type for a given subtask based on
      the task characteristics, language, and agent strengths."""

      subtask_description: str = dspy.InputField()
      subtask_region: str = dspy.InputField(desc="Workspace region path")
      primary_language: str = dspy.InputField(desc="Primary language in the region")
      available_agents: str = dspy.InputField(
          desc="JSON list of available agent configs with id and name"
      )

      agent_id: str = dspy.OutputField(desc="Selected agent id (e.g. 'claude-code')")
      reasoning: str = dspy.OutputField()
  ```

  **Note on user overrides:** If the user says "use claude for /ui", the orchestrator should detect this and skip the DSPy AgentSelect call for that region. Detection is simple string matching: look for patterns like `"use <agent> for <path>"` or `"@<agent> <path>"` in the user intent. Parse these out before calling TaskDecompose.

- [x] Create `agent/src/eisen_agent/signatures/prompt.py`:
  ```python
  """Prompt construction: subtask + context --> guided prompt for sub-agent."""
  import dspy


  class PromptBuild(dspy.Signature):
      """Build a guided prompt for a coding sub-agent based on effort level.

      The prompt should give the agent enough context to work efficiently
      within its assigned region without scanning the entire codebase."""

      subtask_description: str = dspy.InputField()
      region: str = dspy.InputField(desc="Workspace region path the agent is confined to")
      region_files: str = dspy.InputField(
          desc="JSON list of files in the region with line counts"
      )
      cross_region_deps: str = dspy.InputField(
          desc="JSON list of dependency signatures from outside the region"
      )
      effort_level: str = dspy.InputField(desc="low | medium | high")

      agent_prompt: str = dspy.OutputField(
          desc="The complete prompt to send to the coding agent"
      )
  ```

- [x] Create `agent/src/eisen_agent/signatures/evaluate.py`:
  ```python
  """Progress evaluation: agent output --> task status."""
  import dspy


  class ProgressEval(dspy.Signature):
      """Evaluate whether a sub-agent completed its assigned subtask."""

      subtask_description: str = dspy.InputField()
      agent_output: str = dspy.InputField(
          desc="The agent's final response/output text"
      )
      files_changed: str = dspy.InputField(
          desc="JSON list of files the agent created or modified"
      )

      status: str = dspy.OutputField(desc="completed | failed | partial")
      failure_reason: str = dspy.OutputField(
          desc="If failed or partial, explain why"
      )
      suggested_retry: str = dspy.OutputField(
          desc="If failed, suggest an approach for retry"
      )
  ```

- [x] Write tests in `agent/tests/test_signatures.py`:
  - Test that each signature class can be instantiated
  - Test that DSPy `Predict` or `ChainOfThought` modules can wrap each signature (mock LLM)
  - Test the Subtask dataclass serialization

### 1B. ACP Session Manager

The session manager handles spawning a coding agent subprocess, communicating via ACP JSON-RPC over stdio, and collecting results.

- [x] Create `agent/src/eisen_agent/acp_session.py`:

  **Core class: `ACPSession`**
  ```python
  class ACPSession:
      """Manages a single ACP session with a coding agent."""

      def __init__(self, agent_config: AgentConfig, workspace: str, agent_id: str):
          ...

      async def start(self) -> None:
          """Spawn the agent process wrapped with eisen-core observe.
          
          Command: eisen-core observe --port 0 --agent-id {agent_id} -- {agent_cmd}
          
          Parse 'eisen-core tcp port: XXXXX' from stderr to get the TCP port
          for graph visualization (stored but not used in Phase 1).
          """

      async def initialize(self) -> dict:
          """Send ACP initialize request, receive capabilities."""

      async def new_session(self) -> str:
          """Send session/new, return session_id."""

      async def prompt(self, content: str) -> AsyncIterator[dict]:
          """Send session/prompt with content, yield streaming session/update messages.
          
          Detects stopReason in response to know when the agent is done.
          """

      async def kill(self) -> None:
          """Terminate the agent process."""

      @property
      def tcp_port(self) -> int | None:
          """The eisen-core TCP port (for graph visualization)."""

      @property
      def session_id(self) -> str | None:
          """The active ACP session ID."""
  ```

  **Key implementation details:**
  - Use `asyncio.create_subprocess_exec()` to spawn the agent process
  - The `agent-client-protocol` Python SDK provides `acp.client.StdioClient` for JSON-RPC over stdio -- use this if it supports client-side usage, otherwise implement the JSON-RPC framing directly (it's just newline-delimited JSON)
  - Parse `eisen-core tcp port: XXXXX` from stderr (same pattern as `extension/src/acp/client.ts:waitForTcpPort`)
  - Store the TCP port for later use by Phase 2D (extension integration)
  - The `eisen-core` binary path: check `PATH` first, fall back to `core/target/release/eisen-core` for dev

- [x] Create `agent/src/eisen_agent/agent_registry.py`:
  ```python
  """Agent availability checking (mirrors extension/src/acp/agents.ts)."""
  import shutil
  from .config import AGENTS, AgentConfig


  def get_available_agents() -> list[AgentConfig]:
      """Return agents whose commands are found on PATH."""
      return [a for a in AGENTS if shutil.which(a.command) is not None]


  def get_agent(agent_id: str) -> AgentConfig | None:
      """Look up an agent by ID."""
      return next((a for a in AGENTS if a.id == agent_id), None)


  def is_agent_available(agent_id: str) -> bool:
      agent = get_agent(agent_id)
      return agent is not None and shutil.which(agent.command) is not None
  ```

- [x] Write tests in `agent/tests/test_acp_session.py`:
  - Test that `ACPSession` constructs the correct spawn command (eisen-core wrapping)
  - Test stderr parsing for TCP port extraction
  - Test agent registry (get_agent, resolve_agent_name, get_available_agents)
  - Test session initial state

### 1C. Core Orchestration Loop

The main orchestrator that ties DSPy signatures + ACP sessions + PyO3 bridge together.

- [x] Create `agent/src/eisen_agent/orchestrator.py`:

  **Core class: `Orchestrator`**
  ```python
  class Orchestrator:
      """Main orchestration loop.
      
      Lifecycle:
        IDLE --> DECOMPOSING --> CONFIRMING --> SPAWNING --> RUNNING --> DONE
      
      States:
        IDLE:         waiting for user input
        DECOMPOSING:  DSPy TaskDecompose running
        CONFIRMING:   presenting plan to user, waiting for approval
        SPAWNING:     creating ACP session(s)
        RUNNING:      sub-agent(s) executing
        DONE:         all subtasks finished (some may have failed)
      """

      def __init__(self, config: OrchestratorConfig):
          ...

      async def run(self, user_intent: str) -> OrchestratorResult:
          """Execute the full orchestration loop for a user request."""
          # 1. Build workspace context via PyO3
          workspace_tree = self._get_workspace_tree()
          symbol_index = self._get_symbol_index()

          # 2. Check for explicit user agent/region overrides
          overrides = self._parse_user_overrides(user_intent)

          # 3. Decompose task
          subtasks = await self._decompose(user_intent, workspace_tree, symbol_index)

          # 4. Select agents (respecting overrides)
          assignments = await self._assign_agents(subtasks, overrides)

          # 5. Present plan and get approval
          if not self.config.auto_approve:
              approved = await self._confirm_with_user(subtasks, assignments)
              if not approved:
                  return OrchestratorResult(status="cancelled")

          # 6. Execute subtasks sequentially (Phase 1)
          results = []
          for subtask, assignment in zip(subtasks, assignments):
              result = await self._execute_subtask(subtask, assignment)
              results.append(result)

          # 7. Evaluate and report
          return self._build_result(subtasks, results)
  ```

  **Helper methods:**
  - `_get_workspace_tree()`: calls `eisen_bridge.parse_workspace()`, formats as compact directory listing
  - `_get_symbol_index()`: calls `eisen_bridge.snapshot()`, extracts top-level symbols per directory
  - `_parse_user_overrides(intent)`: regex/string matching for `"use <agent> for <path>"` and `"@<agent> <path>"` patterns
  - `_decompose(intent, tree, symbols)`: runs `TaskDecompose` via `dspy.ChainOfThought`
  - `_assign_agents(subtasks, overrides)`: runs `AgentSelect` per subtask (skips if override exists)
  - `_confirm_with_user(subtasks, assignments)`: prints plan, reads y/n from stdin
  - `_execute_subtask(subtask, assignment)`: spawns ACPSession, builds prompt via `PromptBuild`, sends prompt, collects output, evaluates via `ProgressEval`
  - `_build_result(subtasks, results)`: aggregates into `OrchestratorResult` with per-subtask status

- [x] Create `agent/src/eisen_agent/types.py`:
  ```python
  """Result types for orchestration."""
  from dataclasses import dataclass, field


  @dataclass
  class SubtaskResult:
      subtask_index: int
      description: str
      region: str
      agent_id: str
      status: str  # "completed" | "failed" | "partial"
      agent_output: str
      failure_reason: str | None = None
      suggested_retry: str | None = None
      cost_tokens: int = 0


  @dataclass
  class OrchestratorResult:
      status: str  # "completed" | "done" (has failures) | "cancelled"
      subtask_results: list[SubtaskResult] = field(default_factory=list)
      total_cost_tokens: int = 0
      orchestrator_cost_tokens: int = 0
  ```

- [x] Update `agent/src/eisen_agent/cli.py` to wire up the orchestrator:
  ```python
  async def main() -> None:
      # parse args...
      config = OrchestratorConfig(
          workspace=args.workspace,
          effort=EffortLevel(args.effort),
          auto_approve=args.auto_approve,
      )
      orchestrator = Orchestrator(config)

      # Read user intent from stdin
      print("Enter your task (press Enter twice to submit):")
      lines = []
      while True:
          line = input()
          if line == "":
              break
          lines.append(line)
      user_intent = "\n".join(lines)

      result = await orchestrator.run(user_intent)
      # print result summary...
  ```

- [x] Write tests in `agent/tests/test_orchestrator.py`:
  - Test `parse_user_overrides` with various input patterns (7 tests)
  - Test result types (SubtaskResult, OrchestratorResult)
  - Test OrchestratorConfig defaults and custom values
  - Test ContextBuilder (low effort, workspace tree, symbol index)

### 1D. Effort Level Implementation

The effort level controls how much context `PromptBuild` injects into the sub-agent's prompt.

- [x] Implement effort level logic in `agent/src/eisen_agent/context_builder.py`:

  ```python
  class ContextBuilder:
      """Builds context for sub-agent prompts based on effort level."""

      def __init__(self, workspace: str):
          self._workspace = workspace

      def build_region_context(self, region: str, effort: EffortLevel) -> dict:
          """Build context for a region at the given effort level.
          
          Returns:
            {
              "region_files": [...],       # files in region with line counts
              "cross_region_deps": [...],  # dependency signatures from outside region
              "step_plan": [...] | None,   # step-by-step plan (high effort only)
            }
          """
  ```

  **Effort levels:**
  | Level | region_files | cross_region_deps | step_plan |
  |-------|-------------|-------------------|-----------|
  | low   | No          | No                | No        |
  | medium| Yes (from eisen_bridge.snapshot) | Yes (from eisen_bridge.lookup_symbol) | No |
  | high  | Yes         | Yes               | Yes (generated by DSPy) |

- [x] For **medium**: use `eisen_bridge.snapshot(region)` to get file listing (cross-region deps stubbed as TODO)
- [x] For **high**: same as medium for now; step plan generated by DSPy in orchestrator
- [x] Tests included in `agent/tests/test_orchestrator.py` (context builder tests)

### 1E. Cost Tracking

- [x] Create `agent/src/eisen_agent/cost.py`:
  ```python
  """Cost tracking for orchestrator and sub-agent token usage."""
  from dataclasses import dataclass, field


  @dataclass
  class CostEntry:
      source: str  # "orchestrator" | agent_id
      tokens_used: int
      description: str


  class CostTracker:
      """Accumulates token usage across orchestrator DSPy calls and sub-agent sessions."""

      def __init__(self):
          self._entries: list[CostEntry] = []

      def record(self, source: str, tokens: int, description: str) -> None:
          self._entries.append(CostEntry(source, tokens, description))

      @property
      def total_tokens(self) -> int:
          return sum(e.tokens_used for e in self._entries)

      @property
      def orchestrator_tokens(self) -> int:
          return sum(e.tokens_used for e in self._entries if e.source == "orchestrator")

      @property
      def agent_tokens(self) -> int:
          return sum(e.tokens_used for e in self._entries if e.source != "orchestrator")

      def breakdown(self) -> dict[str, int]:
          """Per-source token breakdown."""
          result: dict[str, int] = {}
          for e in self._entries:
              result[e.source] = result.get(e.source, 0) + e.tokens_used
          return result

      def summary(self) -> str:
          """Human-readable cost summary."""
          lines = ["Cost Summary:"]
          lines.append(f"  Orchestrator: {self.orchestrator_tokens:,} tokens")
          for source, tokens in self.breakdown().items():
              if source != "orchestrator":
                  lines.append(f"  {source}: {tokens:,} tokens")
          lines.append(f"  Total: {self.total_tokens:,} tokens")
          return "\n".join(lines)
  ```

- [x] Integrate with Orchestrator: record DSPy call token usage after each signature execution
- [x] Parse sub-agent `UsageUpdate` from ACP session/update notifications and record
- [x] Print cost summary at end of orchestration run (`orchestrator.print_summary()`)
- [x] Write tests in `agent/tests/test_cost.py` (5 tests)

### 1F. Approval Flow

- [x] Implement `_confirm_with_user()` in `orchestrator.py`:
  - Print formatted plan:
    ```
    Task Decomposition:
    
    Subtask 1: Implement auth UI components
      Region:  /ui/src/views/auth/
      Agent:   claude-code
      Files:   login.ts, register.ts, auth-state.ts (new)
    
    Subtask 2: Add auth extraction to core parser
      Region:  /core/src/
      Agent:   opencode
      Files:   extract.rs (modify), auth.rs (new)
    
    Estimated cost: ~15,000 tokens ($0.04)
    
    Proceed? [y/n]:
    ```
  - Wait for user input
  - Return `True` for 'y'/'yes', `False` for anything else
  - If `config.auto_approve` is `True`, skip and return `True` immediately

- [x] Approval flow implemented (auto_approve skips, else reads y/n from stdin)

---

## LLM Backend Configuration

The orchestration agent's DSPy modules need an LLM to run. This is configurable:

```python
# At startup in cli.py or orchestrator.py
import dspy

# Option A: Remote (Claude, OpenAI, etc.)
lm = dspy.LM("anthropic/claude-sonnet-4-20250514")

# Option B: Local (Ollama, etc.)
lm = dspy.LM("ollama_chat/llama3.1")

dspy.configure(lm=lm)
```

The choice is made via `--model` CLI flag or `EISEN_AGENT_MODEL` env var. Default is unset (user must configure).

---

## User Override Detection

The orchestrator should detect explicit agent/region assignments in the user's natural language input:

**Patterns to detect:**
- `"use claude for /ui"` --> `{agent: "claude-code", region: "/ui"}`
- `"use codex for /core"` --> `{agent: "codex", region: "/core"}`
- `"@claude-code /ui"` --> `{agent: "claude-code", region: "/ui"}`
- `"assign opencode to /lib"` --> `{agent: "opencode", region: "/lib"}`

**Implementation:**
```python
import re

OVERRIDE_PATTERNS = [
    r"use\s+(\w[\w-]*)\s+for\s+(/\S+)",
    r"@(\w[\w-]*)\s+(/\S+)",
    r"assign\s+(\w[\w-]*)\s+to\s+(/\S+)",
]

def parse_user_overrides(intent: str) -> dict[str, str]:
    """Extract explicit agent-to-region assignments from user intent.
    Returns: {region: agent_id}
    """
    overrides = {}
    for pattern in OVERRIDE_PATTERNS:
        for match in re.finditer(pattern, intent, re.IGNORECASE):
            agent_name, region = match.group(1), match.group(2)
            agent_id = resolve_agent_name(agent_name)  # "claude" -> "claude-code"
            if agent_id:
                overrides[region] = agent_id
    return overrides
```

---

## Verification Criteria

Phase 1 is complete when:

1. `python -m eisen_agent --workspace . --effort medium` starts, accepts user input
2. Given "implement feature X in /some/dir", the orchestrator:
   - Calls `eisen_bridge.parse_workspace()` successfully
   - Runs `TaskDecompose` and outputs subtasks
   - Runs `AgentSelect` and picks an agent
   - Presents a plan and waits for approval
   - On approval, spawns the selected coding agent via ACP
   - Sends a guided prompt with region context
   - Collects the agent's streaming response
   - Evaluates the result via `ProgressEval`
   - Prints a cost summary
3. User override patterns are correctly parsed
4. Effort levels produce different prompt richness
5. All unit tests pass

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sequential execution in Phase 1 | Single agent at a time | Validate the loop before adding concurrency complexity |
| DSPy over raw prompts | DSPy signatures | Testable, optimizable, declarative; can compile later in Phase 4 |
| User override via regex | Pattern matching on input | Simple, explicit; DSPy can also learn to interpret these in Phase 4 |
| Agent wrapping with eisen-core | Always wrap | Consistent activity tracking even in Phase 1; TCP port stored for Phase 2 |
| LLM backend | Configurable via CLI/env | User chooses: remote (Claude, GPT) or local (Ollama); no default assumed |

---

## Summary

### What was built

- **DSPy Signatures** (`agent/src/eisen_agent/signatures/`):
  - `decompose.py` -- `TaskDecompose` signature + `Subtask` dataclass
  - `assign.py` -- `AgentSelect` signature
  - `prompt.py` -- `PromptBuild` signature
  - `evaluate.py` -- `ProgressEval` signature
  - `__init__.py` -- re-exports all signatures

- **ACP Session Manager** (`agent/src/eisen_agent/acp_session.py`):
  - `ACPSession` class: spawns agent wrapped in `eisen-core observe`, communicates via ACP JSON-RPC over stdio
  - `_ClientHandler` class: handles incoming ACP notifications (text chunks, thoughts, tool calls, usage)
  - `parse_tcp_port_from_stderr()` helper
  - Uses `acp.connection.Connection` for JSON-RPC framing
  - Auto-approves permission requests from agents

- **Agent Registry** (`agent/src/eisen_agent/agent_registry.py`):
  - `get_available_agents()`, `get_agent()`, `is_agent_available()`
  - `resolve_agent_name()` maps short names ("claude" -> "claude-code")

- **Core Orchestration Loop** (`agent/src/eisen_agent/orchestrator.py`):
  - `Orchestrator` class with full lifecycle: IDLE -> DECOMPOSING -> CONFIRMING -> RUNNING -> DONE
  - `parse_user_overrides()` for detecting "use X for /path" patterns
  - Sequential subtask execution (Phase 1 constraint)
  - Integrates DSPy signatures, ACP sessions, PyO3 bridge, cost tracking

- **Context Builder** (`agent/src/eisen_agent/context_builder.py`):
  - `ContextBuilder` class: builds region context at different effort levels
  - Uses `eisen_bridge.parse_workspace()` and `eisen_bridge.snapshot()` for workspace understanding
  - Formats tree and symbol index for DSPy input

- **Cost Tracking** (`agent/src/eisen_agent/cost.py`):
  - `CostTracker` class: records per-source token usage, provides breakdown and summary

- **Result Types** (`agent/src/eisen_agent/types.py`):
  - `SubtaskResult` and `OrchestratorResult` dataclasses

- **CLI** (`agent/src/eisen_agent/cli.py`):
  - Full CLI with `--workspace`, `--effort`, `--auto-approve`, `--model`, `--verbose`
  - DSPy LLM backend configuration via `--model` or `EISEN_AGENT_MODEL` env var
  - Reads user intent from stdin (enter twice to submit)

### What commands run it end-to-end

```bash
# Build (from repo root)
cd agent && source .venv/bin/activate && maturin develop

# Run
python -m eisen_agent.cli --workspace /path/to/project --model anthropic/claude-sonnet-4-20250514 --effort medium

# Run tests
python -m pytest tests/ -v

# Run with auto-approve and verbose
python -m eisen_agent.cli --workspace . --model ollama_chat/llama3.1 --auto-approve --verbose
```

### How to configure the LLM backend

```bash
# Via CLI flag
python -m eisen_agent.cli --model anthropic/claude-sonnet-4-20250514

# Via environment variable
export EISEN_AGENT_MODEL=openai/gpt-4o
python -m eisen_agent.cli
```

### Test results

46 tests pass across 5 test files:
- `test_signatures.py` (9 tests): signature fields, Predict/ChainOfThought wrapping, Subtask dataclass
- `test_acp_session.py` (14 tests): TCP port parsing, spawn command, agent registry, session state
- `test_orchestrator.py` (14 tests): user overrides, result types, config, context builder
- `test_cost.py` (5 tests): cost tracking, breakdown, summary
- `test_bridge.py` (3 tests): PyO3 bridge integration (from Phase 0)

### Deviations from plan

1. **ACP SDK usage**: Used `acp.connection.Connection` directly instead of a higher-level client, since the SDK's `Client` protocol is designed for the server side. The session manager handles JSON-RPC framing directly.
2. **Cross-region dependency resolution** is stubbed (returns empty list). Full implementation requires parsing import statements from source files, which is deferred to Phase 2+.
3. **High effort level** currently behaves like medium. The step-by-step plan generation is wired to happen via DSPy in the orchestrator, but the ContextBuilder doesn't distinguish high from medium yet.
4. **DSPy token tracking** records 0 tokens for orchestrator calls (DSPy's internal token tracking needs to be integrated -- the `record()` calls are in place but actual counts are not extracted yet).
5. **No mocked subprocess tests** for the full ACP session flow (initialize/new_session/prompt). The tests focus on spawn command construction, TCP port parsing, and agent registry. Full integration testing requires a running coding agent.

### Known issues / tech debt

- `_get_cross_region_deps()` returns `[]` -- needs import parsing to resolve cross-region dependencies
- DSPy token usage not actually extracted from LLM responses (records 0)
- High effort level doesn't generate a step-by-step plan yet
- No retry logic when a subtask fails
- `_detect_language()` uses simple heuristics instead of actual file extension analysis
- The `_ClientHandler` auto-approves all permission requests -- may want configurable approval in the future
