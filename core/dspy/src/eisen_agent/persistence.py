"""Session persistence and resume for interrupted orchestration runs (Phase 4D).

Saves the state of an in-progress run at key transitions so that
interrupted tasks can be resumed.

Storage: ~/.eisen/runs/ directory, one JSON file per run.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

RUNS_DIR = Path.home() / ".eisen" / "runs"


@dataclass
class SavedSubtask:
    """Serializable subtask data."""

    index: int
    description: str
    region: str
    expected_files: list[str] = field(default_factory=list)
    depends_on: list[int] = field(default_factory=list)
    agent_id: str = ""
    status: str = (
        "pending"  # "pending" | "running" | "completed" | "failed" | "partial"
    )
    agent_output: str = ""
    failure_reason: str | None = None
    suggested_retry: str | None = None
    cost_tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SavedSubtask:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class RunState:
    """Serializable snapshot of an in-progress orchestration run."""

    run_id: str
    user_intent: str
    workspace: str
    effort: str = "medium"
    auto_approve: bool = False
    max_agents: int = 5
    state: str = "idle"  # TaskState value
    subtasks: list[SavedSubtask] = field(default_factory=list)
    total_tokens: int = 0
    orchestrator_tokens: int = 0
    timestamp: float = 0.0
    created_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["subtasks"] = [s.to_dict() for s in self.subtasks]
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RunState:
        subtasks_raw = data.pop("subtasks", [])
        filtered = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
        obj = cls(**filtered)
        obj.subtasks = [SavedSubtask.from_dict(s) for s in subtasks_raw]
        return obj

    @property
    def completed_count(self) -> int:
        return sum(1 for s in self.subtasks if s.status == "completed")

    @property
    def failed_count(self) -> int:
        return sum(1 for s in self.subtasks if s.status in ("failed", "partial"))

    @property
    def pending_count(self) -> int:
        return sum(1 for s in self.subtasks if s.status in ("pending", "running"))

    @property
    def is_resumable(self) -> bool:
        """A run is resumable if it has pending or failed subtasks."""
        return self.pending_count > 0 or self.failed_count > 0

    @property
    def progress_summary(self) -> str:
        total = len(self.subtasks)
        return (
            f"{self.completed_count}/{total} done, "
            f"{self.failed_count} failed, "
            f"{self.pending_count} pending"
        )


class RunPersistence:
    """Save and restore orchestration run state.

    Storage: ~/.eisen/runs/{run_id}.json
    """

    def __init__(self, runs_dir: Path | None = None) -> None:
        self._runs_dir = runs_dir or RUNS_DIR
        self._runs_dir.mkdir(parents=True, exist_ok=True)

    def save(self, run: RunState) -> None:
        """Save run state to disk."""
        run.timestamp = time.time()
        if run.created_at == 0.0:
            run.created_at = run.timestamp

        filepath = self._runs_dir / f"run_{run.run_id}.json"
        filepath.write_text(json.dumps(run.to_dict(), indent=2))
        logger.info(
            f"Saved run state {run.run_id} ({run.state}, "
            f"{run.progress_summary}) to {filepath}"
        )

    def load(self, run_id: str) -> RunState | None:
        """Load a saved run state."""
        filepath = self._runs_dir / f"run_{run_id}.json"
        if not filepath.exists():
            return None
        try:
            data = json.loads(filepath.read_text())
            return RunState.from_dict(data)
        except Exception as e:
            logger.warning(f"Failed to load run {run_id}: {e}")
            return None

    def list_resumable(self) -> list[RunState]:
        """List runs that can be resumed.

        Returns RunState objects for runs that have pending or failed subtasks.
        Sorted by most recent first.
        """
        runs: list[RunState] = []
        if not self._runs_dir.exists():
            return runs

        for filepath in self._runs_dir.glob("run_*.json"):
            try:
                data = json.loads(filepath.read_text())
                run = RunState.from_dict(data)
                if run.is_resumable:
                    runs.append(run)
            except Exception as e:
                logger.warning(f"Failed to read run {filepath}: {e}")

        runs.sort(key=lambda r: r.timestamp, reverse=True)
        return runs

    def list_all(self) -> list[RunState]:
        """List all saved runs (including completed), sorted by most recent."""
        runs: list[RunState] = []
        if not self._runs_dir.exists():
            return runs

        for filepath in self._runs_dir.glob("run_*.json"):
            try:
                data = json.loads(filepath.read_text())
                runs.append(RunState.from_dict(data))
            except Exception as e:
                logger.warning(f"Failed to read run {filepath}: {e}")

        runs.sort(key=lambda r: r.timestamp, reverse=True)
        return runs

    def delete(self, run_id: str) -> bool:
        """Clean up a completed/cancelled run. Returns True if deleted."""
        filepath = self._runs_dir / f"run_{run_id}.json"
        if filepath.exists():
            filepath.unlink()
            logger.info(f"Deleted run {run_id}")
            return True
        return False

    def clear(self) -> int:
        """Delete all run files. Returns count deleted."""
        if not self._runs_dir.exists():
            return 0
        count = 0
        for filepath in self._runs_dir.glob("run_*.json"):
            filepath.unlink()
            count += 1
        return count
