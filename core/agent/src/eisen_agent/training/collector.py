"""Trace collection for DSPy compilation.

Collects orchestration traces that capture: user intent, workspace state,
decomposition result, agent assignments, execution outcomes (success/fail
per subtask), cost data, and timing.  Stored as JSON files in
~/.eisen/traces/ for later use by the compilation pipeline.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from eisen_agent.types import OrchestratorResult, SubtaskResult

logger = logging.getLogger(__name__)

TRACES_DIR = Path.home() / ".eisen" / "traces"


@dataclass
class TraceEntry:
    """A single orchestration trace for DSPy compilation."""

    run_id: str
    timestamp: float
    user_intent: str
    workspace: str
    workspace_tree_summary: str = ""
    symbol_index_summary: str = ""
    subtasks: list[dict[str, Any]] = field(default_factory=list)
    assignments: list[dict[str, Any]] = field(default_factory=list)
    results: list[dict[str, Any]] = field(default_factory=list)
    total_tokens: int = 0
    orchestrator_tokens: int = 0
    duration_s: float = 0.0
    quality: float = 0.0  # completed_subtasks / total_subtasks

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TraceEntry:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


class TraceCollector:
    """Collects orchestration traces for DSPy compilation.

    A trace captures: user intent, workspace state, decomposition result,
    agent assignments, actual execution outcomes (success/fail per subtask),
    cost data, and timing.
    """

    def __init__(self, traces_dir: Path | None = None) -> None:
        self._traces_dir = traces_dir or TRACES_DIR
        self._traces_dir.mkdir(parents=True, exist_ok=True)

    def record_run(
        self,
        run_id: str,
        user_intent: str,
        workspace: str,
        result: OrchestratorResult,
        subtasks: list[dict[str, Any]] | None = None,
        assignments: list[dict[str, Any]] | None = None,
        workspace_tree_summary: str = "",
        symbol_index_summary: str = "",
        orchestrator_tokens: int = 0,
        duration_s: float = 0.0,
    ) -> TraceEntry:
        """Save a completed orchestration run as a training trace."""
        completed = sum(1 for r in result.subtask_results if r.status == "completed")
        total = len(result.subtask_results) if result.subtask_results else 1
        quality = completed / total if total > 0 else 0.0

        results_dicts = []
        for r in result.subtask_results:
            results_dicts.append(
                {
                    "subtask_index": r.subtask_index,
                    "description": r.description,
                    "region": r.region,
                    "agent_id": r.agent_id,
                    "status": r.status,
                    "failure_reason": r.failure_reason,
                    "cost_tokens": r.cost_tokens,
                }
            )

        entry = TraceEntry(
            run_id=run_id,
            timestamp=time.time(),
            user_intent=user_intent,
            workspace=workspace,
            workspace_tree_summary=workspace_tree_summary,
            symbol_index_summary=symbol_index_summary,
            subtasks=subtasks or [],
            assignments=assignments or [],
            results=results_dicts,
            total_tokens=result.total_cost_tokens,
            orchestrator_tokens=orchestrator_tokens,
            duration_s=duration_s,
            quality=quality,
        )

        # Write to disk
        filename = f"run_{run_id}.json"
        filepath = self._traces_dir / filename
        filepath.write_text(json.dumps(entry.to_dict(), indent=2))
        logger.info(f"Saved trace {run_id} (quality={quality:.2f}) to {filepath}")

        return entry

    def load_traces(self, min_quality: float = 0.5) -> list[TraceEntry]:
        """Load traces filtered by outcome quality.

        Quality = (completed_subtasks / total_subtasks).
        Only successful or partially successful runs are useful for compilation.
        """
        traces: list[TraceEntry] = []

        if not self._traces_dir.exists():
            return traces

        for filepath in sorted(self._traces_dir.glob("run_*.json")):
            try:
                data = json.loads(filepath.read_text())
                entry = TraceEntry.from_dict(data)
                if entry.quality >= min_quality:
                    traces.append(entry)
            except Exception as e:
                logger.warning(f"Failed to load trace {filepath}: {e}")

        logger.info(
            f"Loaded {len(traces)} traces (min_quality={min_quality}) "
            f"from {self._traces_dir}"
        )
        return traces

    def count_traces(self) -> int:
        """Count the number of trace files on disk."""
        if not self._traces_dir.exists():
            return 0
        return len(list(self._traces_dir.glob("run_*.json")))

    def clear_traces(self) -> int:
        """Delete all trace files. Returns the count deleted."""
        if not self._traces_dir.exists():
            return 0
        count = 0
        for filepath in self._traces_dir.glob("run_*.json"):
            filepath.unlink()
            count += 1
        return count
