"""Main orchestration loop.

Ties together DSPy signatures, ACP sessions, the PyO3 bridge, lifecycle
state machine, and A2A router to decompose user tasks, spawn coding
agents in parallel, and collect results.

Phase 2: supports parallel agent spawning with dependency ordering,
retry of failed subtasks, and formal lifecycle management.

Phase 4: adds DSPy compilation, agent stats learning, cross-session
context handoff, run persistence, and symbol tree caching.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any

import dspy

from eisen_agent.acp_session import ACPSession
from eisen_agent.blocked_listener import BlockedAccessListener
from eisen_agent.conflict import ConflictDetector, ConflictResolver, ConflictStrategy
from eisen_agent.agent_registry import (
    get_agent,
    get_available_agents,
    resolve_agent_name,
)
from eisen_agent.config import AgentConfig, EffortLevel, OrchestratorConfig
from eisen_agent.zones import SharedZoneConfig
from eisen_agent.context_builder import ContextBuilder
from eisen_agent.cost import CostTracker
from eisen_agent.router import A2ARouter
from eisen_agent.lifecycle import (
    InvalidTransitionError,
    SubtaskLifecycle,
    SubtaskState,
    TaskLifecycle,
    TaskState,
)
from eisen_agent.persistence import RunPersistence, RunState, SavedSubtask
from eisen_agent.session_memory import SessionContext, SessionMemory
from eisen_agent.training.agent_stats import AgentStats
from eisen_agent.training.collector import TraceCollector
from eisen_agent.training.compile import load_module
from eisen_agent.signatures import (
    AgentSelect,
    ProgressEval,
    PromptBuild,
    Subtask,
    TaskDecompose,
)
from eisen_agent.types import OrchestratorResult, SubtaskResult

logger = logging.getLogger(__name__)

# Patterns for detecting explicit agent-to-region overrides in user input
OVERRIDE_PATTERNS = [
    r"use\s+(\w[\w-]*)\s+for\s+(/\S+)",
    r"@(\w[\w-]*)\s+(/\S+)",
    r"assign\s+(\w[\w-]*)\s+to\s+(/\S+)",
]


def parse_user_overrides(intent: str) -> dict[str, str]:
    """Extract explicit agent-to-region assignments from user intent.

    Returns: {region: agent_id}
    """
    overrides: dict[str, str] = {}
    for pattern in OVERRIDE_PATTERNS:
        for match in re.finditer(pattern, intent, re.IGNORECASE):
            agent_name, region = match.group(1), match.group(2)
            agent_id = resolve_agent_name(agent_name)
            if agent_id:
                overrides[region] = agent_id
    return overrides


def _parse_depends_on(raw_deps: list) -> list[int]:
    """Safely parse depends_on values from DSPy output.

    The LLM may return ints, numeric strings, or garbage (e.g. region paths).
    We keep only valid integer indices and silently discard the rest.
    """
    result: list[int] = []
    for d in raw_deps:
        try:
            result.append(int(d))
        except (ValueError, TypeError):
            logger.debug(f"Ignoring non-numeric depends_on value: {d!r}")
    return result


@dataclass
class AgentAssignment:
    """Links a subtask to its assigned agent and lifecycle."""

    subtask: Subtask
    subtask_index: int
    agent_id: str
    lifecycle: SubtaskLifecycle


def _build_execution_batches(
    assignments: list[AgentAssignment],
) -> list[list[AgentAssignment]]:
    """Topological sort subtasks into execution batches based on depends_on.

    Subtasks within a batch can run in parallel.
    Batch N contains subtasks whose dependencies are all in batches 0..N-1.
    """
    total = len(assignments)
    if total == 0:
        return []

    # Map subtask index to assignment
    by_index: dict[int, AgentAssignment] = {a.subtask_index: a for a in assignments}

    # Track which batch each subtask lands in
    assigned_batch: dict[int, int] = {}
    batches: list[list[AgentAssignment]] = []

    # Compute batch level for each subtask
    def get_batch_level(idx: int, visited: set[int] | None = None) -> int:
        if idx in assigned_batch:
            return assigned_batch[idx]
        if visited is None:
            visited = set()
        if idx in visited:
            # Circular dependency -- break the cycle
            logger.warning(f"Circular dependency detected at subtask {idx}")
            return 0
        visited.add(idx)

        assignment = by_index.get(idx)
        if assignment is None:
            return 0

        deps = assignment.subtask.depends_on
        if not deps:
            assigned_batch[idx] = 0
            return 0

        max_dep_level = 0
        for dep_idx in deps:
            if dep_idx in by_index:
                dep_level = get_batch_level(dep_idx, visited)
                max_dep_level = max(max_dep_level, dep_level + 1)

        assigned_batch[idx] = max_dep_level
        return max_dep_level

    for idx in by_index:
        get_batch_level(idx)

    # Group into batches
    max_level = max(assigned_batch.values()) if assigned_batch else 0
    for level in range(max_level + 1):
        batch = [
            by_index[idx]
            for idx, batch_level in sorted(assigned_batch.items())
            if batch_level == level
        ]
        if batch:
            batches.append(batch)

    return batches


class Orchestrator:
    """Main orchestration loop with parallel execution support.

    Lifecycle:
      IDLE --> DECOMPOSING --> CONFIRMING --> SPAWNING --> RUNNING --> DONE/COMPLETED
      DONE --> RETRYING --> RUNNING --> ...

    Phase 2 additions:
      - Parallel agent spawning with asyncio.gather + semaphore
      - Dependency-ordered batch execution
      - Formal lifecycle state machine
      - Active session tracking for A2A routing
      - Retry flow for failed subtasks
    """

    def __init__(self, config: OrchestratorConfig):
        self.config = config
        self._context = ContextBuilder(config.workspace)
        self._cost = CostTracker()
        self._lifecycle = TaskLifecycle()
        self._router = A2ARouter(config.workspace)
        self._shared_zones = SharedZoneConfig.from_workspace(config.workspace)
        self._blocked_listener = BlockedAccessListener(self._router)
        self._conflict_detector = ConflictDetector()
        self._conflict_resolver = ConflictResolver()
        self._active_sessions: dict[str, ACPSession] = {}  # agent_id -> session
        self._region_map: dict[str, str] = {}  # region -> agent_id
        self._assignments: list[AgentAssignment] = []
        self._results: list[SubtaskResult] = []

        # Phase 4: optimization components
        self._run_id = str(uuid.uuid4())[:8]
        self._run_start: float = 0.0
        self._trace_collector = TraceCollector()
        self._agent_stats = AgentStats()
        self._session_memory = SessionMemory()
        self._persistence = RunPersistence()
        self._user_intent: str = ""
        self._workspace_tree: str = ""
        self._symbol_index: str = ""

        # Load compiled DSPy modules (Phase 4A)
        self._decomposer = load_module("decompose", dspy.ChainOfThought(TaskDecompose))
        self._agent_selector = load_module("agent_select", dspy.Predict(AgentSelect))
        self._prompt_builder = load_module("prompt_build", dspy.Predict(PromptBuild))

    @property
    def state(self) -> TaskState:
        return self._lifecycle.state

    @property
    def router(self) -> A2ARouter:
        """The A2A router for cross-region dependency resolution."""
        return self._router

    @property
    def active_sessions(self) -> dict[str, ACPSession]:
        """Map of currently active agent sessions (agent_id -> ACPSession)."""
        return dict(self._active_sessions)

    @property
    def region_map(self) -> dict[str, str]:
        """Map of workspace regions to agent IDs."""
        return dict(self._region_map)

    def on_state_change(self, callback: Any) -> None:
        """Register a callback for orchestrator state changes."""
        self._lifecycle.on_state_change(callback)

    async def run(self, user_intent: str) -> OrchestratorResult:
        """Execute the full orchestration loop for a user request."""
        self._run_start = time.time()
        self._user_intent = user_intent

        # Phase 4C: Load relevant context from previous sessions
        prev_contexts = self._session_memory.load_relevant_context(
            user_intent, self.config.workspace
        )

        # 1. Decompose
        self._lifecycle.transition(TaskState.DECOMPOSING)
        self._workspace_tree = self._context.get_workspace_tree()
        self._symbol_index = self._context.get_symbol_index()
        overrides = parse_user_overrides(user_intent)

        # Inject previous session context into decomposition
        decompose_intent = user_intent
        if prev_contexts:
            context_summary = "\n".join(
                f"- Previous task '{c.user_intent[:60]}' modified "
                f"{sum(len(v) for v in c.modified_files.values())} files"
                for c in prev_contexts
            )
            decompose_intent = (
                f"{user_intent}\n\nPrevious related work:\n{context_summary}"
            )

        subtasks = await self._decompose(
            decompose_intent, self._workspace_tree, self._symbol_index
        )

        # 2. Assign agents (with stats-informed selection -- Phase 4B)
        agent_ids = await self._assign_agents(subtasks, overrides)

        # 3. Build assignments with lifecycles
        self._assignments = [
            AgentAssignment(
                subtask=subtask,
                subtask_index=i,
                agent_id=agent_id,
                lifecycle=SubtaskLifecycle(i, subtask.description),
            )
            for i, (subtask, agent_id) in enumerate(zip(subtasks, agent_ids))
        ]

        # 4. Confirm with user
        self._lifecycle.transition(TaskState.CONFIRMING)
        if not self.config.auto_approve:
            approved = await self._confirm_with_user()
            if not approved:
                self._lifecycle.transition(TaskState.CANCELLED)
                return OrchestratorResult(status="cancelled")

        # Phase 4D: Save run state after confirmation
        self._save_run_state("spawning")

        # 5. Execute
        self._lifecycle.transition(TaskState.SPAWNING)
        self._lifecycle.transition(TaskState.RUNNING)
        self._results = await self._execute_all_subtasks(self._assignments)

        # 6. Determine final state
        all_completed = all(r.status == "completed" for r in self._results)
        if all_completed:
            self._lifecycle.transition(TaskState.COMPLETED)
        else:
            self._lifecycle.transition(TaskState.DONE)

        result = self._build_result(self._results)

        # Phase 4: Post-run recording
        self._record_trace(result)
        self._record_agent_stats()
        self._save_session_context(result, prev_contexts)
        self._save_run_state(result.status)

        return result

    async def retry_failed(self) -> OrchestratorResult:
        """Retry any failed/partial subtasks from the last run.

        Can only be called when state is DONE.
        """
        if not self._lifecycle.can_retry:
            raise InvalidTransitionError(self._lifecycle.state, TaskState.RETRYING)

        self._lifecycle.transition(TaskState.RETRYING)

        # Identify failed assignments
        failed_assignments: list[AgentAssignment] = []
        for assignment in self._assignments:
            if assignment.lifecycle.can_retry:
                assignment.lifecycle.transition(SubtaskState.RETRYING)
                failed_assignments.append(assignment)

        # Re-execute only the failed subtasks
        self._lifecycle.transition(TaskState.RUNNING)
        retry_results = await self._execute_all_subtasks(failed_assignments)

        # Merge retry results into the full results list
        for retry_result in retry_results:
            self._results[retry_result.subtask_index] = retry_result

        # Check final state
        all_completed = all(r.status == "completed" for r in self._results)
        if all_completed:
            self._lifecycle.transition(TaskState.COMPLETED)
        else:
            self._lifecycle.transition(TaskState.DONE)

        return self._build_result(self._results)

    async def _execute_all_subtasks(
        self,
        assignments: list[AgentAssignment],
    ) -> list[SubtaskResult]:
        """Execute subtasks in parallel, respecting MAX_AGENTS and dependencies.

        Groups subtasks into batches by dependency order. Within each batch,
        subtasks run concurrently up to max_agents limit.
        """
        batches = _build_execution_batches(assignments)
        all_results: list[SubtaskResult] = []

        for batch_idx, batch in enumerate(batches):
            logger.info(
                f"Executing batch {batch_idx + 1}/{len(batches)} "
                f"({len(batch)} subtask(s))"
            )
            semaphore = asyncio.Semaphore(self.config.max_agents)

            async def run_with_limit(assignment: AgentAssignment) -> SubtaskResult:
                async with semaphore:
                    return await self._execute_subtask(assignment)

            batch_coros = [run_with_limit(a) for a in batch]
            batch_raw_results = await asyncio.gather(
                *batch_coros, return_exceptions=True
            )

            for assignment, raw_result in zip(batch, batch_raw_results):
                if isinstance(raw_result, BaseException):
                    logger.error(
                        f"Subtask {assignment.subtask_index} raised: {raw_result}"
                    )
                    result = SubtaskResult(
                        subtask_index=assignment.subtask_index,
                        description=assignment.subtask.description,
                        region=assignment.subtask.region,
                        agent_id=assignment.agent_id,
                        status="failed",
                        agent_output="",
                        failure_reason=str(raw_result),
                    )
                    assignment.lifecycle.transition(SubtaskState.FAILED)
                else:
                    result = raw_result
                all_results.append(result)

        return all_results

    async def _execute_subtask(
        self,
        assignment: AgentAssignment,
    ) -> SubtaskResult:
        """Spawn an ACP session, send guided prompt, collect and evaluate output."""
        index = assignment.subtask_index
        subtask = assignment.subtask
        agent_id = assignment.agent_id
        lifecycle = assignment.lifecycle

        lifecycle.transition(SubtaskState.RUNNING)

        agent_config = get_agent(agent_id)
        if not agent_config:
            lifecycle.transition(SubtaskState.FAILED)
            return SubtaskResult(
                subtask_index=index,
                description=subtask.description,
                region=subtask.region,
                agent_id=agent_id,
                status="failed",
                agent_output="",
                failure_reason=f"Agent '{agent_id}' not found in registry",
            )

        # Build context-enriched prompt
        region_context = self._context.build_region_context(
            subtask.region, self.config.effort
        )

        # Include failure context in retry prompt
        failure_context = ""
        if lifecycle.retry_count > 0:
            prev_results = [r for r in self._results if r.subtask_index == index]
            if prev_results and prev_results[-1].failure_reason:
                failure_context = (
                    f"\n\nPREVIOUS ATTEMPT FAILED: {prev_results[-1].failure_reason}\n"
                    f"Suggested approach: {prev_results[-1].suggested_retry or 'Try a different approach.'}\n"
                )

        prompt_text = await self._build_prompt(subtask, region_context)
        if failure_context:
            prompt_text = failure_context + "\n" + prompt_text

        # Spawn agent and execute
        instance_id = f"{agent_id}-{index}"
        session = ACPSession(
            agent_config,
            workspace=self.config.workspace,
            agent_id=instance_id,
        )

        # Build zone patterns: agent's region + shared zones
        zone_patterns = [f"{subtask.region}/**"]
        zone_patterns.extend(self._shared_zones.get_all_patterns())

        # Register in active sessions, region map, and router
        self._active_sessions[instance_id] = session
        self._region_map[subtask.region] = instance_id
        self._router.register_agent(subtask.region, instance_id, session)

        agent_output_parts: list[str] = []
        try:
            await session.start(zone_patterns=zone_patterns)
            await session.initialize()
            await session.new_session()

            # Start blocked access listener if zone enforcement is active
            if zone_patterns and session.tcp_port:
                await self._blocked_listener.start_listening(
                    instance_id, session.tcp_port
                )

            # Stream agent output
            async for update in session.prompt(prompt_text):
                if update.kind == "text":
                    agent_output_parts.append(update.text)
                    print(update.text, end="", flush=True)
                elif update.kind == "usage":
                    usage = update.raw.get("usage", {})
                    tokens = usage.get("used", 0)
                    if tokens:
                        self._cost.record(agent_id, tokens, subtask.description)
                elif update.kind == "done":
                    logger.info(f"Subtask {index + 1} agent done: {update.text}")
                elif update.kind == "error":
                    logger.error(f"Subtask {index + 1} error: {update.text}")

            print()  # newline after streaming

        except Exception as e:
            logger.error(f"Subtask {index + 1} execution error: {e}")
            lifecycle.transition(SubtaskState.FAILED)
            return SubtaskResult(
                subtask_index=index,
                description=subtask.description,
                region=subtask.region,
                agent_id=agent_id,
                status="failed",
                agent_output="".join(agent_output_parts),
                failure_reason=str(e),
            )
        finally:
            self._blocked_listener.stop_listening(instance_id)
            await session.kill()
            self._active_sessions.pop(instance_id, None)
            self._router.unregister_agent(instance_id)
            # Only remove from region_map if this session still owns it
            if self._region_map.get(subtask.region) == instance_id:
                self._region_map.pop(subtask.region, None)

        # Evaluate result
        agent_output = "".join(agent_output_parts)
        result = await self._evaluate_result(index, subtask, agent_id, agent_output)

        # Update lifecycle based on evaluation
        if result.status == "completed":
            lifecycle.transition(SubtaskState.COMPLETED)
        elif result.status == "partial":
            lifecycle.transition(SubtaskState.PARTIAL)
        else:
            lifecycle.transition(SubtaskState.FAILED)

        return result

    async def _decompose(
        self, intent: str, workspace_tree: str, symbol_index: str
    ) -> list[Subtask]:
        """Run TaskDecompose via DSPy ChainOfThought (uses compiled module if available)."""
        result = self._decomposer(
            user_intent=intent,
            workspace_tree=workspace_tree,
            symbol_index=symbol_index,
        )

        self._cost.record("orchestrator", 0, "TaskDecompose")

        raw_subtasks = result.subtasks
        subtasks: list[Subtask] = []
        for raw in raw_subtasks:
            if isinstance(raw, dict):
                subtasks.append(
                    Subtask(
                        description=raw.get("description", ""),
                        region=raw.get("region", "."),
                        expected_files=raw.get("expected_files", []),
                        depends_on=_parse_depends_on(raw.get("depends_on", [])),
                    )
                )
            elif isinstance(raw, Subtask):
                subtasks.append(raw)

        logger.info(f"Decomposed into {len(subtasks)} subtasks: {result.reasoning}")
        return subtasks

    async def _assign_agents(
        self,
        subtasks: list[Subtask],
        overrides: dict[str, str],
    ) -> list[str]:
        """Select an agent for each subtask. Respects user overrides."""
        available = get_available_agents()
        if not available:
            from eisen_agent.config import AGENTS

            available_json = json.dumps(
                [{"id": a.id, "name": a.name} for a in AGENTS[:3]]
            )
        else:
            available_json = json.dumps(
                [{"id": a.id, "name": a.name} for a in available]
            )

        assignments: list[str] = []

        for subtask in subtasks:
            override_agent = overrides.get(subtask.region)
            if override_agent:
                logger.info(f"Using override: {override_agent} for {subtask.region}")
                assignments.append(override_agent)
                continue

            # Phase 4B: Check agent stats for a recommendation
            language = self._detect_language(subtask.region)
            task_type = self._infer_task_type(subtask.region)
            stats_recommendation = self._agent_stats.best_agent_for(task_type, language)
            stats_summary = self._agent_stats.get_stats_summary(task_type, language)

            # Include stats in DSPy input if available
            agents_input = available_json
            if stats_summary:
                agents_input = f"{available_json}\n\n{stats_summary}"
                if stats_recommendation:
                    agents_input += (
                        f"\nRecommended: {stats_recommendation} "
                        f"(based on historical performance)"
                    )

            result = self._agent_selector(
                subtask_description=subtask.description,
                subtask_region=subtask.region,
                primary_language=language,
                available_agents=agents_input,
            )
            self._cost.record("orchestrator", 0, "AgentSelect")
            assignments.append(result.agent_id)

        return assignments

    async def _confirm_with_user(self) -> bool:
        """Present the plan and wait for user approval."""
        print("\nTask Decomposition:\n")
        for assignment in self._assignments:
            agent = get_agent(assignment.agent_id)
            agent_name = agent.name if agent else assignment.agent_id
            subtask = assignment.subtask
            deps_str = ""
            if subtask.depends_on:
                deps_str = f" (depends on: {', '.join(str(int(d) + 1) for d in subtask.depends_on)})"

            print(
                f"  Subtask {assignment.subtask_index + 1}: {subtask.description}{deps_str}"
            )
            print(f"    Region:  {subtask.region}")
            print(f"    Agent:   {agent_name}")
            if subtask.expected_files:
                files_str = ", ".join(subtask.expected_files)
                print(f"    Files:   {files_str}")
            print()

        try:
            response = input("Proceed? [y/n]: ").strip().lower()
            return response in ("y", "yes")
        except (EOFError, KeyboardInterrupt):
            return False

    async def _build_prompt(
        self,
        subtask: Subtask,
        region_context: dict[str, Any],
    ) -> str:
        """Build a guided prompt for the sub-agent via DSPy PromptBuild (compiled if available)."""
        result = self._prompt_builder(
            subtask_description=subtask.description,
            region=subtask.region,
            region_files=json.dumps(region_context.get("region_files", [])),
            cross_region_deps=json.dumps(region_context.get("cross_region_deps", [])),
            effort_level=self.config.effort.value,
        )
        self._cost.record("orchestrator", 0, "PromptBuild")

        # Inject cross-region guidance for multi-agent mode
        cross_region_instruction = (
            "\n\nIMPORTANT: You are working within the region '{region}'. "
            "If you need information about types, functions, or APIs from outside "
            "your region, describe what you need instead of reading those files directly. "
            "The orchestrator will provide the information you need."
        ).format(region=subtask.region)

        return result.agent_prompt + cross_region_instruction

    async def _evaluate_result(
        self,
        index: int,
        subtask: Subtask,
        agent_id: str,
        agent_output: str,
    ) -> SubtaskResult:
        """Evaluate whether the sub-agent completed its subtask."""
        evaluator = dspy.Predict(ProgressEval)
        result = evaluator(
            subtask_description=subtask.description,
            agent_output=agent_output[:4000],
            files_changed=json.dumps(subtask.expected_files),
        )
        self._cost.record("orchestrator", 0, "ProgressEval")

        return SubtaskResult(
            subtask_index=index,
            description=subtask.description,
            region=subtask.region,
            agent_id=agent_id,
            status=result.status,
            agent_output=agent_output,
            failure_reason=result.failure_reason
            if result.status != "completed"
            else None,
            suggested_retry=result.suggested_retry
            if result.status != "completed"
            else None,
        )

    def _build_result(self, results: list[SubtaskResult]) -> OrchestratorResult:
        """Aggregate subtask results into final orchestrator result."""
        all_completed = all(r.status == "completed" for r in results)
        status = "completed" if all_completed else "done"

        return OrchestratorResult(
            status=status,
            subtask_results=results,
            total_cost_tokens=self._cost.total_tokens,
            orchestrator_cost_tokens=self._cost.orchestrator_tokens,
        )

    def _detect_language(self, region: str) -> str:
        """Detect the primary language in a workspace region."""
        region_path = region.lstrip("/")
        if "core" in region_path or "src" in region_path:
            if "rs" in region_path or region_path.startswith("core"):
                return "rust"
        if "ui" in region_path or "extension" in region_path:
            return "typescript"
        if "agent" in region_path or "py" in region_path:
            return "python"
        return "unknown"

    def _infer_task_type(self, region: str) -> str:
        """Infer the task type from the workspace region path."""
        region_path = region.lstrip("/").lower()
        if any(k in region_path for k in ("ui", "frontend", "views", "components")):
            return "ui"
        if any(k in region_path for k in ("test", "spec", "__tests__")):
            return "tests"
        if any(k in region_path for k in ("config", ".config", "settings")):
            return "config"
        if any(k in region_path for k in ("core", "backend", "server", "api")):
            return "backend"
        if any(k in region_path for k in ("lib", "utils", "shared", "common")):
            return "library"
        return "general"

    # ------------------------------------------------------------------
    # Phase 4: Post-run recording helpers
    # ------------------------------------------------------------------

    def _record_trace(self, result: OrchestratorResult) -> None:
        """Record the orchestration run as a training trace (Phase 4A)."""
        try:
            subtask_dicts = [
                {
                    "description": a.subtask.description,
                    "region": a.subtask.region,
                    "expected_files": a.subtask.expected_files,
                    "depends_on": a.subtask.depends_on,
                }
                for a in self._assignments
            ]
            assignment_dicts = [
                {
                    "agent_id": a.agent_id,
                    "subtask_index": a.subtask_index,
                    "language": self._detect_language(a.subtask.region),
                    "available_agents": [],
                }
                for a in self._assignments
            ]
            duration = time.time() - self._run_start if self._run_start else 0.0

            self._trace_collector.record_run(
                run_id=self._run_id,
                user_intent=self._user_intent,
                workspace=self.config.workspace,
                result=result,
                subtasks=subtask_dicts,
                assignments=assignment_dicts,
                workspace_tree_summary=self._workspace_tree[:500],
                symbol_index_summary=self._symbol_index[:500],
                orchestrator_tokens=self._cost.orchestrator_tokens,
                duration_s=duration,
            )
        except Exception as e:
            logger.warning(f"Failed to record trace: {e}")

    def _record_agent_stats(self) -> None:
        """Record agent performance stats from this run (Phase 4B)."""
        try:
            for assignment, result in zip(self._assignments, self._results):
                task_type = self._infer_task_type(assignment.subtask.region)
                language = self._detect_language(assignment.subtask.region)
                self._agent_stats.record_outcome(
                    agent_type=assignment.agent_id.rsplit("-", 1)[0]
                    if "-" in assignment.agent_id
                    else assignment.agent_id,
                    task_type=task_type,
                    language=language,
                    success=result.status == "completed",
                    tokens=result.cost_tokens,
                )
        except Exception as e:
            logger.warning(f"Failed to record agent stats: {e}")

    def _save_session_context(
        self,
        result: OrchestratorResult,
        prev_contexts: list[SessionContext] | None = None,
    ) -> None:
        """Save session context for cross-session handoff (Phase 4C)."""
        try:
            modified_files: dict[str, list[str]] = {}
            key_decisions: list[str] = []
            subtask_summaries: list[dict[str, Any]] = []

            for r in result.subtask_results:
                modified_files.setdefault(r.region, []).extend(
                    getattr(r, "expected_files", [])
                )
                subtask_summaries.append(
                    {
                        "description": r.description,
                        "region": r.region,
                        "status": r.status,
                        "agent_id": r.agent_id,
                    }
                )
                if r.status == "completed":
                    key_decisions.append(
                        f"Completed '{r.description}' in {r.region} using {r.agent_id}"
                    )

            ctx = SessionContext(
                session_id=self._run_id,
                timestamp=time.time(),
                user_intent=self._user_intent,
                workspace=self.config.workspace,
                modified_files=modified_files,
                key_decisions=key_decisions,
                subtask_summaries=subtask_summaries,
                status=result.status,
            )
            self._session_memory.save_session(ctx)
        except Exception as e:
            logger.warning(f"Failed to save session context: {e}")

    def _save_run_state(self, state_label: str) -> None:
        """Save current run state for resume capability (Phase 4D)."""
        try:
            saved_subtasks: list[SavedSubtask] = []
            for i, assignment in enumerate(self._assignments):
                result = self._results[i] if i < len(self._results) else None
                saved_subtasks.append(
                    SavedSubtask(
                        index=assignment.subtask_index,
                        description=assignment.subtask.description,
                        region=assignment.subtask.region,
                        expected_files=assignment.subtask.expected_files,
                        depends_on=assignment.subtask.depends_on,
                        agent_id=assignment.agent_id,
                        status=result.status if result else "pending",
                        agent_output=result.agent_output[:1000] if result else "",
                        failure_reason=result.failure_reason if result else None,
                        suggested_retry=result.suggested_retry if result else None,
                        cost_tokens=result.cost_tokens if result else 0,
                    )
                )

            run_state = RunState(
                run_id=self._run_id,
                user_intent=self._user_intent,
                workspace=self.config.workspace,
                effort=self.config.effort.value,
                auto_approve=self.config.auto_approve,
                max_agents=self.config.max_agents,
                state=state_label,
                subtasks=saved_subtasks,
                total_tokens=self._cost.total_tokens,
                orchestrator_tokens=self._cost.orchestrator_tokens,
            )
            self._persistence.save(run_state)
        except Exception as e:
            logger.warning(f"Failed to save run state: {e}")

    async def resume_run(self, run_state: RunState) -> OrchestratorResult:
        """Resume an interrupted run from saved state (Phase 4D).

        Skips completed subtasks and re-executes pending/failed ones.
        """
        self._run_id = run_state.run_id
        self._run_start = time.time()
        self._user_intent = run_state.user_intent

        # Rebuild assignments from saved state
        self._assignments = []
        self._results = [
            SubtaskResult(
                subtask_index=s.index,
                description=s.description,
                region=s.region,
                agent_id=s.agent_id,
                status=s.status,
                agent_output=s.agent_output,
                failure_reason=s.failure_reason,
                suggested_retry=s.suggested_retry,
                cost_tokens=s.cost_tokens,
            )
            for s in run_state.subtasks
        ]

        resume_assignments: list[AgentAssignment] = []
        for saved in run_state.subtasks:
            lifecycle = SubtaskLifecycle(saved.index, saved.description)
            assignment = AgentAssignment(
                subtask=Subtask(
                    description=saved.description,
                    region=saved.region,
                    expected_files=saved.expected_files,
                    depends_on=saved.depends_on,
                ),
                subtask_index=saved.index,
                agent_id=saved.agent_id,
                lifecycle=lifecycle,
            )
            self._assignments.append(assignment)

            if saved.status in ("pending", "running", "failed", "partial"):
                resume_assignments.append(assignment)

        if not resume_assignments:
            logger.info("No subtasks to resume -- all completed.")
            return self._build_result(self._results)

        logger.info(
            f"Resuming run {run_state.run_id}: "
            f"{len(resume_assignments)} subtask(s) to (re-)execute"
        )

        # Execute only the pending/failed subtasks
        self._lifecycle.transition(TaskState.DECOMPOSING)
        self._lifecycle.transition(TaskState.CONFIRMING)
        self._lifecycle.transition(TaskState.SPAWNING)
        self._lifecycle.transition(TaskState.RUNNING)

        resume_results = await self._execute_all_subtasks(resume_assignments)

        # Merge results
        for res in resume_results:
            self._results[res.subtask_index] = res

        all_completed = all(r.status == "completed" for r in self._results)
        if all_completed:
            self._lifecycle.transition(TaskState.COMPLETED)
        else:
            self._lifecycle.transition(TaskState.DONE)

        result = self._build_result(self._results)
        self._record_trace(result)
        self._record_agent_stats()
        self._save_run_state(result.status)
        return result

    def print_summary(self, result: OrchestratorResult) -> None:
        """Print a human-readable summary of the orchestration result."""
        print(f"\nOrchestration {result.status}.")
        print()
        for r in result.subtask_results:
            status_icon = "[OK]" if r.status == "completed" else "[FAIL]"
            print(f"  {status_icon} Subtask {r.subtask_index + 1}: {r.description}")
            print(f"         Region: {r.region}, Agent: {r.agent_id}")
            if r.failure_reason:
                print(f"         Reason: {r.failure_reason}")
            if r.suggested_retry:
                print(f"         Retry:  {r.suggested_retry}")
        print()
        print(self._cost.summary())

        # If some failed, offer retry
        if result.status == "done" and self._lifecycle.can_retry:
            print(
                "\nSome subtasks failed. You can retry with orchestrator.retry_failed()."
            )
