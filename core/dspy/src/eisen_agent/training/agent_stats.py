"""Agent performance statistics for selection learning (Phase 4B).

Tracks which agent types perform best for which kinds of tasks and
regions.  Stats are persisted to ~/.eisen/agent_stats.json and used
to inform the AgentSelect DSPy signature over time.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

STATS_PATH = Path.home() / ".eisen" / "agent_stats.json"

# Minimum number of samples before stats are considered reliable
MIN_SAMPLES = 3


@dataclass
class AgentPerformance:
    """Performance metrics for a specific agent+task+language combination."""

    agent_type: str
    task_type: str  # inferred: "ui", "backend", "tests", "config", etc.
    language: str  # primary language in region
    success_rate: float = 0.0  # 0.0 to 1.0
    avg_tokens: int = 0  # average token usage
    avg_duration_s: float = 0.0  # average task duration
    sample_count: int = 0  # number of observations
    _total_successes: int = 0
    _total_tokens: int = 0
    _total_duration_s: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentPerformance:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


def _make_key(agent_type: str, task_type: str, language: str) -> str:
    """Create a composite key for the stats lookup."""
    return f"{agent_type}|{task_type}|{language}"


class AgentStats:
    """Learns agent performance characteristics from historical runs.

    Persists to ~/.eisen/agent_stats.json.
    """

    def __init__(self, stats_path: Path | None = None) -> None:
        self._path = stats_path or STATS_PATH
        self._data: dict[str, AgentPerformance] = {}
        self._load()

    def _load(self) -> None:
        """Load stats from disk."""
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text())
            for key, entry_data in raw.items():
                self._data[key] = AgentPerformance.from_dict(entry_data)
            logger.info(f"Loaded {len(self._data)} agent stats from {self._path}")
        except Exception as e:
            logger.warning(f"Failed to load agent stats: {e}")

    def _save(self) -> None:
        """Persist stats to disk."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        raw = {key: perf.to_dict() for key, perf in self._data.items()}
        self._path.write_text(json.dumps(raw, indent=2))

    def record_outcome(
        self,
        agent_type: str,
        task_type: str,
        language: str,
        success: bool,
        tokens: int = 0,
        duration_s: float = 0.0,
    ) -> None:
        """Record an agent's performance on a task."""
        key = _make_key(agent_type, task_type, language)

        if key not in self._data:
            self._data[key] = AgentPerformance(
                agent_type=agent_type,
                task_type=task_type,
                language=language,
            )

        perf = self._data[key]
        perf.sample_count += 1
        perf._total_tokens += tokens
        perf._total_duration_s += duration_s
        if success:
            perf._total_successes += 1

        # Recompute averages
        perf.success_rate = perf._total_successes / perf.sample_count
        perf.avg_tokens = perf._total_tokens // perf.sample_count
        perf.avg_duration_s = perf._total_duration_s / perf.sample_count

        self._save()
        logger.debug(
            f"Recorded outcome for {agent_type}/{task_type}/{language}: "
            f"success={success}, rate={perf.success_rate:.2f}, "
            f"samples={perf.sample_count}"
        )

    def best_agent_for(self, task_type: str, language: str) -> str | None:
        """Return the agent type with the highest success rate for this combo.

        Returns None if insufficient data (< MIN_SAMPLES samples).
        """
        best_agent: str | None = None
        best_rate: float = -1.0

        for key, perf in self._data.items():
            if perf.task_type != task_type or perf.language != language:
                continue
            if perf.sample_count < MIN_SAMPLES:
                continue
            if perf.success_rate > best_rate:
                best_rate = perf.success_rate
                best_agent = perf.agent_type

        return best_agent

    def get_performance(
        self, agent_type: str, task_type: str, language: str
    ) -> AgentPerformance | None:
        """Get raw performance data for a specific combination."""
        key = _make_key(agent_type, task_type, language)
        return self._data.get(key)

    def get_stats_summary(self, task_type: str, language: str) -> str:
        """Get a human-readable summary of agent stats for a task/language.

        Intended for injection into the AgentSelect DSPy input.
        """
        lines: list[str] = []
        for key, perf in self._data.items():
            if perf.task_type != task_type or perf.language != language:
                continue
            if perf.sample_count < 1:
                continue
            lines.append(
                f"{perf.agent_type}: {perf.success_rate:.0%} success "
                f"({perf.sample_count} runs, avg {perf.avg_tokens} tokens)"
            )

        if not lines:
            return ""
        return "Historical agent performance:\n" + "\n".join(lines)

    def all_stats(self) -> list[AgentPerformance]:
        """Return all recorded performance entries."""
        return list(self._data.values())

    def clear(self) -> None:
        """Clear all stats (for testing)."""
        self._data.clear()
        if self._path.exists():
            self._path.unlink()
