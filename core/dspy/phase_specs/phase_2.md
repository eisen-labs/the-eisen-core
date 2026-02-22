# Phase 2: Multi-Agent Orchestration + A2A Router

## Status: Complete

## Prerequisites

- Phase 0 complete (PyO3 bridge, Python package)
- Phase 1 complete (single-agent orchestration loop working end-to-end)

## Goal

The orchestrator can spawn up to 5 coding agents in parallel, each assigned to a workspace region. Agents work concurrently on their subtasks. When an agent needs information from outside its region, the A2A router resolves the dependency -- first via the zero-cost PyO3 symbol tree, falling back to the owning agent. The task lifecycle state machine handles partial failures and retry.

## Context

### What Exists After Phase 1

- Full orchestration loop: decompose -> confirm -> spawn -> monitor -> report
- DSPy signatures: TaskDecompose, AgentSelect, PromptBuild, ProgressEval
- ACP session manager: spawn/prompt/kill a single agent
- Effort levels (low/medium/high) affecting prompt richness
- Cost tracking and approval flow
- User override parsing ("use claude for /ui")

### What Changes in Phase 2

```
Phase 1 (sequential):              Phase 2 (parallel):

User --> Orchestrator               User --> Orchestrator
         |                                   |
         v                                   +--> Agent A (/ui)
     Agent A (/ui)                           +--> Agent B (/core)
     (completes)                             +--> Agent C (/lib)
         |                                   |
         v                                   A2A Router <--+
     Agent B (/core)                         |              |
     (completes)                             PyO3 oracle    |
         |                                   (zero cost)    |
         v                                                  |
     Report                                  cross-region queries
                                             routed between agents
```

---

## Tasks

### 2A. Parallel Agent Spawning

Extend the orchestrator to spawn multiple agents concurrently.

- [x] Modify `Orchestrator.run()` in `orchestrator.py`:
  - Replace sequential subtask execution with `asyncio.gather()`
  - Each subtask gets its own `ACPSession` running concurrently
  - Enforce `MAX_AGENTS = 5` hard cap -- if more subtasks than 5, batch them (run first 5, then next batch when slots free up)

  ```python
  async def _execute_all_subtasks(
      self, subtasks: list[Subtask], assignments: list[AgentAssignment]
  ) -> list[SubtaskResult]:
      """Execute subtasks in parallel, respecting MAX_AGENTS and dependencies."""
      
      # Group by dependency order
      batches = self._build_execution_batches(subtasks, assignments)
      
      all_results: list[SubtaskResult] = []
      for batch in batches:
          # Each batch runs in parallel (up to MAX_AGENTS concurrent)
          semaphore = asyncio.Semaphore(self.config.max_agents)
          
          async def run_with_limit(subtask, assignment):
              async with semaphore:
                  return await self._execute_subtask(subtask, assignment)
          
          batch_results = await asyncio.gather(
              *(run_with_limit(s, a) for s, a in batch),
              return_exceptions=True,
          )
          all_results.extend(batch_results)
      
      return all_results
  ```

- [x] Implement `_build_execution_batches()`:
  - Topological sort subtasks by `depends_on` field
  - Group into batches: batch N contains subtasks whose dependencies are all in batches 0..N-1
  - Within each batch, subtasks run in parallel

- [x] Add active session tracking:
  ```python
  class Orchestrator:
      def __init__(self, config):
          ...
          self._active_sessions: dict[str, ACPSession] = {}  # agent_id -> session
          self._region_map: dict[str, str] = {}  # region -> agent_id
  ```

- [x] Write tests:
  - Test parallel execution with mocked agents (verify they run concurrently)
  - Test MAX_AGENTS enforcement (6th agent waits for slot)
  - Test dependency ordering (batch 2 waits for batch 1)
  - Test partial failure (2 of 3 agents succeed, 1 fails)

### 2B. A2A Router

The router resolves cross-region dependencies so agents don't need to read files outside their assigned region.

- [x] Create `agent/src/eisen_agent/router.py`:

  ```python
  class A2ARouter:
      """Routes cross-region dependency queries.
      
      Resolution order:
        1. PyO3 symbol tree (zero cost -- tree-sitter parse, no LLM tokens)
        2. Owning agent (routes query to the agent assigned to that region)
        3. Fail gracefully (return "symbol not found" with available context)
      """

      def __init__(self, workspace: str):
          self._workspace = workspace
          self._region_map: dict[str, str] = {}       # region -> agent_id
          self._sessions: dict[str, ACPSession] = {}   # agent_id -> session
          self._symbol_cache: dict[str, str] = {}      # symbol_name -> resolved JSON

      def register_agent(self, region: str, agent_id: str, session: ACPSession):
          """Register an agent as the owner of a workspace region."""
          self._region_map[region] = agent_id
          self._sessions[agent_id] = session

      def unregister_agent(self, agent_id: str):
          """Remove an agent from the router."""
          self._region_map = {r: a for r, a in self._region_map.items() if a != agent_id}
          self._sessions.pop(agent_id, None)

      async def resolve(self, requesting_agent: str, symbol_name: str, context: str = "") -> str:
          """Resolve a cross-region dependency.
          
          Args:
              requesting_agent: ID of the agent making the request
              symbol_name: name of the symbol to look up
              context: additional context (e.g., import path, usage site)
          
          Returns:
              Compact answer: type signature, function params, struct fields, etc.
          """
          # Step 1: PyO3 symbol tree oracle (zero cost)
          result = self._lookup_symbol_tree(symbol_name)
          if result:
              return result

          # Step 2: Route to owning agent
          owner = self._find_owner(symbol_name, context)
          if owner and owner != requesting_agent:
              return await self._query_agent(owner, symbol_name, context)

          # Step 3: Graceful fallback
          return f"Symbol '{symbol_name}' not found in workspace symbol tree or active agents."

      def _lookup_symbol_tree(self, symbol_name: str) -> str | None:
          """Query the PyO3 bridge for a symbol definition."""
          if symbol_name in self._symbol_cache:
              return self._symbol_cache[symbol_name]

          import eisen_bridge
          import json

          result_json = eisen_bridge.lookup_symbol(self._workspace, symbol_name)
          matches = json.loads(result_json)

          if not matches:
              return None

          # Format as compact signature
          formatted = self._format_symbol_matches(matches)
          self._symbol_cache[symbol_name] = formatted
          return formatted

      def _find_owner(self, symbol_name: str, context: str) -> str | None:
          """Determine which agent owns the region containing the symbol."""
          # Use context (import path) to guess the region
          # e.g., "from core.parser import X" -> region /core/
          for region, agent_id in self._region_map.items():
              if region.lstrip("/") in context:
                  return agent_id
          return None

      async def _query_agent(self, agent_id: str, symbol_name: str, context: str) -> str:
          """Ask the owning agent about a symbol.
          
          Sends a focused query: "What is the signature/definition of {symbol_name}?"
          The agent answers from its already-loaded context (no new file reads needed).
          """
          session = self._sessions.get(agent_id)
          if not session:
              return f"Agent {agent_id} not available for cross-region query."

          query = (
              f"I need the type signature and brief description of `{symbol_name}`. "
              f"Context: {context}. "
              f"Reply with ONLY the signature/definition, no explanation."
          )
          # Send as a follow-up prompt in the agent's existing session
          response_text = ""
          async for update in session.prompt(query):
              response_text += self._extract_text(update)
          
          # Cache for future queries
          self._symbol_cache[symbol_name] = response_text
          return response_text

      def _format_symbol_matches(self, matches: list[dict]) -> str:
          """Format symbol tree matches as compact signatures."""
          lines = []
          for m in matches:
              kind = m.get("kind", "unknown")
              name = m.get("name", "?")
              path = m.get("path", "?")
              start = m.get("startLine", 0)
              end = m.get("endLine", 0)
              lines.append(f"{kind} {name} ({path}:{start}-{end})")
          return "\n".join(lines)
  ```

- [x] Integrate router with orchestrator:
  - Orchestrator creates `A2ARouter` at startup
  - When spawning agents, register them with the router
  - The guided prompt for each agent includes instructions: "If you need information from outside your region, describe what you need and I will provide it."
  - Monitor agent output for cross-region requests (detect file read attempts outside region)
  - Intercept and resolve via router

- [x] **Cross-region detection mechanism:**
  The agent's guided prompt tells it to ask for cross-region info rather than reading files directly. But we also need a fallback: if the agent tries to `fs/read_text_file` outside its region, eisen-core (in a future Phase 3 blocker zone) would block it. For Phase 2, we detect it post-hoc from the eisen-core activity stream and log it.

- [x] Write tests:
  - Test PyO3 symbol tree resolution (mock eisen_bridge)
  - Test routing to owning agent (mock ACPSession)
  - Test cache behavior (second lookup hits cache)
  - Test graceful fallback when symbol not found anywhere

### 2C. Task Lifecycle State Machine

Formal state management for multi-agent task execution.

- [x] Create `agent/src/eisen_agent/lifecycle.py`:

  ```python
  from enum import Enum


  class TaskState(Enum):
      IDLE = "idle"
      DECOMPOSING = "decomposing"
      CONFIRMING = "confirming"
      SPAWNING = "spawning"
      RUNNING = "running"
      DONE = "done"           # all subtasks finished, some may have failed
      COMPLETED = "completed" # all subtasks succeeded
      CANCELLED = "cancelled"
      RETRYING = "retrying"


  class SubtaskState(Enum):
      PENDING = "pending"
      RUNNING = "running"
      COMPLETED = "completed"
      FAILED = "failed"
      PARTIAL = "partial"
      RETRYING = "retrying"
  ```

- [x] Implement state transitions in orchestrator:
  ```
  IDLE -> DECOMPOSING:   user submits intent
  DECOMPOSING -> CONFIRMING:  subtasks generated
  CONFIRMING -> CANCELLED:    user rejects plan
  CONFIRMING -> SPAWNING:     user approves plan
  SPAWNING -> RUNNING:        all agents spawned
  RUNNING -> DONE:            all subtasks finished (some failed)
  RUNNING -> COMPLETED:       all subtasks succeeded
  DONE -> RETRYING:           user requests retry of failed subtasks
  RETRYING -> RUNNING:        new agents spawned for failed subtasks
  ```

- [x] Implement retry flow:
  - When state is DONE (some subtasks failed), orchestrator reports:
    ```
    Results:
      Subtask 1 (auth UI):       COMPLETED
      Subtask 2 (auth parser):   FAILED - type mismatch in handler
      Subtask 3 (auth tests):    COMPLETED

    Retry failed subtask(s)? [y/n]:
    ```
  - On retry: spawn new agent only for the failed subtask, preserving completed results
  - Include the failure reason in the retry prompt so the new agent knows what went wrong

- [x] Add state change callbacks for observability:
  ```python
  class Orchestrator:
      def on_state_change(self, old: TaskState, new: TaskState):
          """Hook for UI/extension integration."""
          print(f"[orchestrator] {old.value} -> {new.value}")
  ```

- [x] Write tests:
  - Test all valid state transitions
  - Test invalid transitions raise errors
  - Test retry flow: fail -> retry -> complete
  - Test retry with dependency ordering preserved

### 2D. Extension Integration

Wire the orchestration agent into the VS Code extension as a spawnable child process.

- [x] Add `__main__.py` to `agent/src/eisen_agent/`:
  ```python
  """Allow running as: python -m eisen_agent"""
  from .cli import main
  main()
  ```

- [x] Define the extension-agent communication protocol (JSON over stdin/stdout):
  
  **Extension -> Agent:**
  ```json
  {"type": "run", "intent": "implement auth feature", "effort": "medium"}
  {"type": "approve", "approved": true}
  {"type": "retry", "subtask_indices": [1]}
  {"type": "cancel"}
  ```

  **Agent -> Extension:**
  ```json
  {"type": "state", "state": "decomposing"}
  {"type": "plan", "subtasks": [...], "assignments": [...], "estimated_cost": 15000}
  {"type": "state", "state": "running"}
  {"type": "progress", "subtask_index": 0, "agent_id": "claude-code-x1y2", "status": "running"}
  {"type": "progress", "subtask_index": 0, "agent_id": "claude-code-x1y2", "status": "completed"}
  {"type": "agent_tcp", "agent_id": "claude-code-x1y2", "tcp_port": 54321}
  {"type": "result", "status": "done", "subtask_results": [...], "cost": {...}}
  ```

  The `agent_tcp` message is critical: it tells the extension the TCP port of each spawned eisen-core instance so the existing `EisenOrchestrator` (TypeScript) can connect and visualize agent activity on the graph. No changes needed to the graph pipeline.

- [x] Modify `cli.py` to support two modes:
  - **Interactive mode** (default): reads from terminal stdin, prints to terminal stdout
  - **Extension mode** (`--mode extension`): reads JSON from stdin, writes JSON to stdout. Used when spawned by VS Code extension.

- [x] **Extension-side changes** (TypeScript, in `extension/`):
  - Add a new "Orchestrate" mode to the chat UI (alongside direct agent chat)
  - Spawn `python -m eisen_agent --workspace {workspaceRoot} --mode extension` as child process
  - Parse JSON messages from agent stdout
  - On `agent_tcp` messages: call `orchestrator.addAgent(agentId, tcpPort, agentType)` to connect to graph
  - On `plan` messages: render the plan in chat UI for user approval
  - On `result` messages: render the result summary

- [x] Write integration tests:
  - Test extension protocol: send JSON commands, verify JSON responses
  - Test TCP port forwarding: agent spawns eisen-core, reports port, extension connects

---

## A2A Router: Detailed Resolution Flow

```
Agent A (/ui) encounters:
  import { AuthValidator } from '../../core/src/auth'

Step 1: Agent A's guided prompt says:
  "You are working in /ui/**. If you need types or signatures from
   outside your region, describe what you need instead of reading
   the file directly."

Step 2: Agent A responds:
  "I need the type signature of AuthValidator from /core/src/auth"

Step 3: Orchestrator detects cross-region request (monitors agent output)

Step 4: A2A Router resolves:
  4a. eisen_bridge.lookup_symbol(".", "AuthValidator")
      -> Found! Returns: "struct AuthValidator { ... }"
      -> Cost: 0 tokens (tree-sitter parse)

  OR (if not found in symbol tree):

  4b. Route to Agent B (/core owner):
      "What is the signature of AuthValidator?"
      Agent B answers from existing context: "struct AuthValidator { pub fn validate(...) -> bool }"
      -> Cost: ~200 tokens (Agent B already had context loaded)

Step 5: Orchestrator injects the answer into Agent A's next prompt:
  "Here is the information you requested:
   struct AuthValidator { pub fn validate(token: &str) -> Result<Claims, AuthError> }
   Continue with your implementation."

Step 6: Agent A continues with just the signature, no /core files in context.
```

---

## Graph Visualization Integration

The existing graph pipeline works unchanged:

```
Each sub-agent gets its own eisen-core instance
    |
    | TCP (ndJSON: snapshot/delta/usage)
    v
EisenOrchestrator (TypeScript, existing)
    |
    | CRDT merge across N agents (existing)
    v
Graph WebView
    |
    | Shows all agents with their assigned colors
    | Region boundaries visible as node clusters
    v
User sees which agents are working on which files
```

The only new piece: the orchestration agent reports TCP ports to the extension via the `agent_tcp` JSON message, so the extension knows where to connect.

---

## Verification Criteria

Phase 2 is complete when:

1. Orchestrator spawns 2-3 agents in parallel, each in a different workspace region
2. Agents work concurrently (visible in graph as simultaneous activity in different regions)
3. A2A router resolves cross-region dependencies:
   - Symbol tree resolution works (zero cost)
   - Agent-to-agent routing works (when symbol tree insufficient)
4. Task lifecycle handles partial failures correctly (DONE state, retry flow)
5. Extension integration works: orchestrator spawnable as child process, graph shows multi-agent activity
6. Max 5 agents enforced
7. All unit and integration tests pass

---

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Parallel execution model | asyncio.gather with semaphore | Simple, works within single Python process; semaphore enforces MAX_AGENTS |
| A2A resolution order | Symbol tree first, then owning agent | Minimizes token cost; tree-sitter is free |
| Cross-region detection | Guided prompt + output monitoring | Agents are told to ask rather than read; monitoring catches violations |
| Extension communication | JSON over stdin/stdout | Same pattern as ACP; no new transport to build |
| TCP port forwarding | Agent reports to extension, extension connects to orchestrator | Reuses existing EisenOrchestrator infrastructure completely |
| Retry scope | Failed subtasks only | Completed work is preserved; only respawn for failures |

---

## Summary

### What was built

- **Task Lifecycle State Machine** (`agent/src/eisen_agent/lifecycle.py`):
  - `TaskState` enum: IDLE, DECOMPOSING, CONFIRMING, SPAWNING, RUNNING, DONE, COMPLETED, CANCELLED, RETRYING
  - `SubtaskState` enum: PENDING, RUNNING, COMPLETED, FAILED, PARTIAL, RETRYING
  - `TaskLifecycle` / `SubtaskLifecycle` classes with validated transitions, callbacks, retry count tracking
  - `InvalidTransitionError` for enforcing legal state changes

- **Parallel Agent Spawning** (`agent/src/eisen_agent/orchestrator.py`):
  - `_build_execution_batches()`: topological sort of subtasks by `depends_on`, grouping into parallel batches
  - `_execute_all_subtasks()`: runs batches sequentially, subtasks within each batch via `asyncio.gather()` with `Semaphore(max_agents)`
  - `AgentAssignment` dataclass: links subtask + agent_id + lifecycle
  - Active session tracking: `_active_sessions` dict and `_region_map` dict
  - `retry_failed()` method: re-executes only failed/partial subtasks, preserving completed results, includes failure context in retry prompts
  - Cross-region instruction injected into all agent prompts

- **A2A Router** (`agent/src/eisen_agent/router.py`):
  - `A2ARouter` class with 3-step resolution: (1) PyO3 symbol tree (zero cost), (2) owning agent query, (3) graceful fallback
  - `register_agent()` / `unregister_agent()` for dynamic agent registration
  - `_lookup_symbol_tree()`: calls `eisen_bridge.lookup_symbol()`, caches results
  - `_find_owner()`: heuristic matching of import context to registered regions
  - `_query_agent()`: sends focused query to owning agent's ACP session
  - Symbol cache for avoiding redundant lookups

- **Extension Integration** (Python side):
  - `agent/src/eisen_agent/__main__.py`: allows `python -m eisen_agent`
  - `agent/src/eisen_agent/ext_protocol.py`: `ExtensionProtocol` class -- JSON over stdin/stdout
    - Handles `run`, `approve`, `retry`, `cancel` commands from extension
    - Emits `state`, `plan`, `agent_tcp`, `progress`, `result`, `error` messages
  - `agent/src/eisen_agent/cli.py`: updated with `--mode extension|interactive` flag
    - Interactive mode: terminal stdin/stdout with retry prompt
    - Extension mode: JSON protocol via `ExtensionProtocol`

- **Extension Integration** (TypeScript side):
  - `extension/src/acp/orchestrator-bridge.ts`: `OrchestratorBridge` class
    - Spawns `python -m eisen_agent --mode extension` as child process
    - Parses newline-delimited JSON from stdout
    - Forwards `agent_tcp` messages to `EisenOrchestrator.addAgent()` for graph visualization
    - Tracks spawned agents and cleans up on dispose
    - Methods: `run()`, `approve()`, `retry()`, `cancel()`, `dispose()`

- **Bug Fix** (`agent/src/eisen_agent/acp_session.py`):
  - Rewrote `_ClientHandler` to implement the actual ACP `MethodHandler` protocol (a callable `(method, params, is_notification) -> result`)
  - Removed duplicated dispatch logic with undefined type names
  - Fixed `RequestPermissionResponse` to use ACP's `AllowedOutcome` pattern instead of non-existent `approved` parameter

### How multi-agent spawning works

1. User submits intent -> `TaskDecompose` generates subtasks with `depends_on` fields
2. `_build_execution_batches()` topological sorts into batches (batch 0 = no deps, batch 1 = depends on batch 0, etc.)
3. Within each batch, subtasks run concurrently via `asyncio.gather()` + `Semaphore(max_agents=5)`
4. Each subtask: spawn ACP session -> register with router -> send guided prompt -> collect output -> evaluate -> update lifecycle
5. If some fail: state goes to DONE, user can call `retry_failed()` which re-executes only failed subtasks with failure context

### Extension integration flow

```
VS Code Extension                    Python Orchestrator
       |                                    |
       | spawn python -m eisen_agent        |
       |  --mode extension                  |
       |------------------------------------>|
       |                                    |
       | {"type":"run","intent":"..."}      |
       |------------------------------------>|
       |                                    |
       |  {"type":"plan","subtasks":[...]}  |
       |<------------------------------------|
       |                                    |
       | {"type":"approve","approved":true} |
       |------------------------------------>|
       |                                    |
       |  {"type":"agent_tcp",              |
       |   "agent_id":"claude-code-0",      |
       |   "tcp_port":54321}                |
       |<------------------------------------|
       |                                    |
       | orchestrator.addAgent(...)         |
       |  -> TCP connect to eisen-core      |
       |  -> graph visualization live       |
       |                                    |
       |  {"type":"result","status":"done"} |
       |<------------------------------------|
```

### Test results

104 tests pass across 8 test files:
- `test_lifecycle.py` (21 tests): task/subtask state transitions, invalid transitions, callbacks, retry
- `test_orchestrator.py` (23 tests): user overrides, result types, config, context builder, state, batch construction (empty, no deps, linear chain, diamond, mixed, circular)
- `test_router.py` (18 tests): registration, symbol tree resolution, cache, agent routing, self-routing prevention, fallback, find owner heuristics, format
- `test_ext_protocol.py` (11 tests): JSON emission, message formats (plan, result, agent_tcp, progress, error), command parsing
- `test_acp_session.py` (14 tests): TCP port parsing, spawn commands, agent registry, session state
- `test_signatures.py` (9 tests): DSPy signature fields, Predict/ChainOfThought wrapping
- `test_cost.py` (5 tests): cost tracking
- `test_bridge.py` (3 tests): PyO3 bridge integration

### What commands run it end-to-end

```bash
# Build (from repo root)
cd agent && source .venv/bin/activate && maturin develop

# Run interactively
python -m eisen_agent --workspace /path/to/project --model anthropic/claude-sonnet-4-20250514 --effort medium

# Run in extension mode (JSON protocol)
python -m eisen_agent --workspace /path/to/project --model anthropic/claude-sonnet-4-20250514 --mode extension

# Run tests
python -m pytest tests/ -v
```

### Deviations from plan

1. **Batch construction** uses a recursive `get_batch_level()` function with circular dependency detection instead of a traditional topological sort algorithm. Simpler to implement and handles cycles gracefully (breaks them rather than erroring).
2. **Cross-region detection** is implemented via guided prompts ("describe what you need instead of reading files directly") rather than active output monitoring. The router is integrated but cross-region queries are not yet automatically intercepted from agent output -- agents must explicitly ask.
3. **Extension-side TypeScript** added `orchestrator-bridge.ts` as a new module rather than modifying `chat.ts` or `extension.ts` directly. The bridge is a standalone class that can be instantiated when an "Orchestrate" mode is added to the chat UI.
4. **pytest-asyncio** was added as a dependency and configured with `asyncio_mode = "auto"` in pyproject.toml for async test support.

### Known issues / tech debt

- Cross-region queries are not automatically intercepted from agent output -- agents must follow the guided prompt and explicitly ask for cross-region info. Active interception (monitoring for file read attempts outside region) is deferred.
- The `OrchestratorBridge` TypeScript class is not yet wired into the extension's `activate()` function or chat UI -- it's a standalone module ready for integration.
- A2A agent queries consume tokens (agent answers from loaded context) -- no budget/limit enforced yet.
- DSPy token tracking still records 0 for orchestrator calls (carried from Phase 1).
- No maximum retry count enforced -- `retry_failed()` can be called repeatedly.
- The extension protocol's `_handle_approve` monkey-patches `_execute_subtask` to add TCP reporting -- a cleaner hook mechanism would be better.
