"""Extension communication protocol.

JSON over stdin/stdout for VS Code extension integration.
The extension spawns `python -m eisen_agent --mode extension` and
communicates via newline-delimited JSON.

Extension -> Agent (stdin):
  {"type": "run", "intent": "...", "effort": "medium"}
  {"type": "approve", "approved": true}
  {"type": "retry", "subtask_indices": [1]}
  {"type": "cancel"}

Agent -> Extension (stdout):
  {"type": "state", "state": "decomposing"}
  {"type": "plan", "subtasks": [...], "assignments": [...], "estimated_cost": 15000}
  {"type": "state", "state": "running"}
  {"type": "progress", "subtask_index": 0, "agent_id": "...", "status": "running"}
  {"type": "agent_tcp", "agent_id": "...", "tcp_port": 54321}
  {"type": "result", "status": "done", "subtask_results": [...], "cost": {...}}
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from dataclasses import asdict
from typing import Any

import dspy

from eisen_agent.config import EffortLevel, OrchestratorConfig
from eisen_agent.lifecycle import TaskState
from eisen_agent.orchestrator import Orchestrator
from eisen_agent.types import OrchestratorResult

logger = logging.getLogger(__name__)


def _emit(msg: dict[str, Any]) -> None:
    """Write a JSON message to stdout (extension reads this)."""
    line = json.dumps(msg, default=str)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _read_command() -> dict[str, Any] | None:
    """Read a JSON command from stdin (extension sends this)."""
    try:
        line = sys.stdin.readline()
        if not line:
            return None
        return json.loads(line.strip())
    except (json.JSONDecodeError, EOFError):
        return None


class ExtensionProtocol:
    """Runs the orchestration agent in extension mode.

    Reads JSON commands from stdin, emits JSON events to stdout.
    Designed to be spawned as a child process by the VS Code extension.
    """

    def __init__(self, config: OrchestratorConfig):
        self._config = config
        self._orchestrator: Orchestrator | None = None

    def _on_state_change(self, old: TaskState, new: TaskState) -> None:
        """Emit state change to extension."""
        _emit({"type": "state", "state": new.value})

    async def run(self) -> None:
        """Main extension mode loop.

        Reads commands from stdin and processes them sequentially.
        """
        while True:
            cmd = await asyncio.get_event_loop().run_in_executor(None, _read_command)
            if cmd is None:
                break

            cmd_type = cmd.get("type", "")

            if cmd_type == "run":
                await self._handle_run(cmd)
            elif cmd_type == "approve":
                await self._handle_approve(cmd)
            elif cmd_type == "retry":
                await self._handle_retry(cmd)
            elif cmd_type == "cancel":
                _emit({"type": "state", "state": "cancelled"})
                break
            else:
                _emit({"type": "error", "message": f"Unknown command type: {cmd_type}"})

    async def _handle_run(self, cmd: dict[str, Any]) -> None:
        """Handle a 'run' command: decompose, plan, and optionally execute."""
        intent = cmd.get("intent", "")
        effort = cmd.get("effort", self._config.effort.value)

        config = OrchestratorConfig(
            workspace=self._config.workspace,
            effort=EffortLevel(effort),
            auto_approve=False,  # Extension always confirms
            max_agents=self._config.max_agents,
        )

        self._orchestrator = Orchestrator(config)
        self._orchestrator.on_state_change(self._on_state_change)

        # Run decomposition and assignment (but don't execute yet)
        _emit({"type": "state", "state": "decomposing"})

        try:
            # Build context
            workspace_tree = self._orchestrator._context.get_workspace_tree()
            symbol_index = self._orchestrator._context.get_symbol_index()

            from eisen_agent.orchestrator import parse_user_overrides

            overrides = parse_user_overrides(intent)
            subtasks = await self._orchestrator._decompose(
                intent, workspace_tree, symbol_index
            )
            agent_ids = await self._orchestrator._assign_agents(subtasks, overrides)

            from eisen_agent.lifecycle import SubtaskLifecycle
            from eisen_agent.orchestrator import AgentAssignment

            self._orchestrator._assignments = [
                AgentAssignment(
                    subtask=subtask,
                    subtask_index=i,
                    agent_id=agent_id,
                    lifecycle=SubtaskLifecycle(i, subtask.description),
                )
                for i, (subtask, agent_id) in enumerate(zip(subtasks, agent_ids))
            ]

            # Emit plan for extension to display
            _emit(
                {
                    "type": "plan",
                    "subtasks": [
                        {
                            "index": a.subtask_index,
                            "description": a.subtask.description,
                            "region": a.subtask.region,
                            "expected_files": a.subtask.expected_files,
                            "depends_on": a.subtask.depends_on,
                        }
                        for a in self._orchestrator._assignments
                    ],
                    "assignments": [
                        {
                            "subtask_index": a.subtask_index,
                            "agent_id": a.agent_id,
                        }
                        for a in self._orchestrator._assignments
                    ],
                    "estimated_cost": 0,  # TODO: estimate
                }
            )

            _emit({"type": "state", "state": "confirming"})

        except Exception as e:
            _emit({"type": "error", "message": str(e)})

    async def _handle_approve(self, cmd: dict[str, Any]) -> None:
        """Handle an 'approve' command: execute the plan."""
        if not self._orchestrator:
            _emit({"type": "error", "message": "No plan to approve. Send 'run' first."})
            return

        approved = cmd.get("approved", False)
        if not approved:
            _emit({"type": "state", "state": "cancelled"})
            return

        _emit({"type": "state", "state": "spawning"})

        try:
            # Override auto_approve since extension sent explicit approval
            self._orchestrator.config.auto_approve = True

            # Wire up TCP port reporting
            original_execute = self._orchestrator._execute_subtask

            orch: Orchestrator = self._orchestrator  # type: ignore[assignment]

            async def execute_with_tcp_reporting(assignment: Any) -> Any:
                assert orch is not None
                result = await original_execute(assignment)
                # Report TCP port if session captured one
                instance_id = f"{assignment.agent_id}-{assignment.subtask_index}"
                session = orch._active_sessions.get(instance_id)
                if session and session.tcp_port:
                    _emit(
                        {
                            "type": "agent_tcp",
                            "agent_id": instance_id,
                            "tcp_port": session.tcp_port,
                            "agent_type": assignment.agent_id,
                        }
                    )

                # Report progress
                _emit(
                    {
                        "type": "progress",
                        "subtask_index": assignment.subtask_index,
                        "agent_id": instance_id,
                        "status": result.status,
                    }
                )

                return result

            self._orchestrator._execute_subtask = execute_with_tcp_reporting  # type: ignore[assignment]

            _emit({"type": "state", "state": "running"})

            # Execute all subtasks
            results = await self._orchestrator._execute_all_subtasks(
                self._orchestrator._assignments
            )
            self._orchestrator._results = results

            # Build final result
            orchestrator_result = self._orchestrator._build_result(results)

            _emit(
                {
                    "type": "result",
                    "status": orchestrator_result.status,
                    "subtask_results": [
                        {
                            "subtask_index": r.subtask_index,
                            "description": r.description,
                            "region": r.region,
                            "agent_id": r.agent_id,
                            "status": r.status,
                            "failure_reason": r.failure_reason,
                            "suggested_retry": r.suggested_retry,
                        }
                        for r in orchestrator_result.subtask_results
                    ],
                    "cost": {
                        "total_tokens": orchestrator_result.total_cost_tokens,
                        "orchestrator_tokens": orchestrator_result.orchestrator_cost_tokens,
                        "dashboard": self._orchestrator._cost.detailed_breakdown()
                        if self._orchestrator
                        else {},
                    },
                }
            )

        except Exception as e:
            _emit({"type": "error", "message": str(e)})

    async def _handle_retry(self, cmd: dict[str, Any]) -> None:
        """Handle a 'retry' command: re-execute failed subtasks."""
        if not self._orchestrator:
            _emit({"type": "error", "message": "No orchestrator. Send 'run' first."})
            return

        try:
            result = await self._orchestrator.retry_failed()
            _emit(
                {
                    "type": "result",
                    "status": result.status,
                    "subtask_results": [
                        {
                            "subtask_index": r.subtask_index,
                            "description": r.description,
                            "region": r.region,
                            "agent_id": r.agent_id,
                            "status": r.status,
                            "failure_reason": r.failure_reason,
                            "suggested_retry": r.suggested_retry,
                        }
                        for r in result.subtask_results
                    ],
                    "cost": {
                        "total_tokens": result.total_cost_tokens,
                        "orchestrator_tokens": result.orchestrator_cost_tokens,
                    },
                }
            )
        except Exception as e:
            _emit({"type": "error", "message": str(e)})
