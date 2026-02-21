"""Tests for agent performance statistics (Phase 4B)."""

import json
from pathlib import Path

import pytest

from eisen_agent.training.agent_stats import AgentPerformance, AgentStats


@pytest.fixture
def tmp_stats(tmp_path):
    """Create an AgentStats instance with a temp file."""
    return AgentStats(stats_path=tmp_path / "agent_stats.json")


def test_empty_stats(tmp_stats):
    assert tmp_stats.all_stats() == []
    assert tmp_stats.best_agent_for("ui", "typescript") is None


def test_record_outcome(tmp_stats):
    tmp_stats.record_outcome(
        "claude-code", "ui", "typescript", success=True, tokens=1000
    )
    stats = tmp_stats.all_stats()
    assert len(stats) == 1
    assert stats[0].agent_type == "claude-code"
    assert stats[0].success_rate == 1.0
    assert stats[0].sample_count == 1


def test_record_multiple_outcomes(tmp_stats):
    tmp_stats.record_outcome(
        "claude-code", "ui", "typescript", success=True, tokens=1000
    )
    tmp_stats.record_outcome(
        "claude-code", "ui", "typescript", success=True, tokens=2000
    )
    tmp_stats.record_outcome(
        "claude-code", "ui", "typescript", success=False, tokens=500
    )

    perf = tmp_stats.get_performance("claude-code", "ui", "typescript")
    assert perf is not None
    assert perf.sample_count == 3
    assert abs(perf.success_rate - 2 / 3) < 0.01
    assert perf.avg_tokens == (1000 + 2000 + 500) // 3


def test_best_agent_insufficient_data(tmp_stats):
    """Should return None if fewer than MIN_SAMPLES (3)."""
    tmp_stats.record_outcome("claude-code", "ui", "typescript", success=True)
    tmp_stats.record_outcome("claude-code", "ui", "typescript", success=True)
    # Only 2 samples
    assert tmp_stats.best_agent_for("ui", "typescript") is None


def test_best_agent_sufficient_data(tmp_stats):
    for _ in range(3):
        tmp_stats.record_outcome("claude-code", "ui", "typescript", success=True)
    for _ in range(3):
        tmp_stats.record_outcome("opencode", "ui", "typescript", success=False)

    best = tmp_stats.best_agent_for("ui", "typescript")
    assert best == "claude-code"


def test_best_agent_picks_higher_rate(tmp_stats):
    # claude: 2/3 success
    tmp_stats.record_outcome("claude-code", "backend", "rust", success=True)
    tmp_stats.record_outcome("claude-code", "backend", "rust", success=True)
    tmp_stats.record_outcome("claude-code", "backend", "rust", success=False)

    # codex: 3/3 success
    tmp_stats.record_outcome("codex", "backend", "rust", success=True)
    tmp_stats.record_outcome("codex", "backend", "rust", success=True)
    tmp_stats.record_outcome("codex", "backend", "rust", success=True)

    best = tmp_stats.best_agent_for("backend", "rust")
    assert best == "codex"


def test_get_stats_summary_empty(tmp_stats):
    summary = tmp_stats.get_stats_summary("ui", "typescript")
    assert summary == ""


def test_get_stats_summary(tmp_stats):
    tmp_stats.record_outcome(
        "claude-code", "ui", "typescript", success=True, tokens=500
    )
    summary = tmp_stats.get_stats_summary("ui", "typescript")
    assert "claude-code" in summary
    assert "100%" in summary


def test_persistence_roundtrip(tmp_path):
    path = tmp_path / "stats.json"
    stats1 = AgentStats(stats_path=path)
    stats1.record_outcome("claude-code", "ui", "typescript", success=True, tokens=1000)
    stats1.record_outcome("claude-code", "ui", "typescript", success=False, tokens=500)

    # Load from disk
    stats2 = AgentStats(stats_path=path)
    perf = stats2.get_performance("claude-code", "ui", "typescript")
    assert perf is not None
    assert perf.sample_count == 2
    assert perf.success_rate == 0.5


def test_clear(tmp_stats):
    tmp_stats.record_outcome("claude-code", "ui", "typescript", success=True)
    assert len(tmp_stats.all_stats()) == 1
    tmp_stats.clear()
    assert len(tmp_stats.all_stats()) == 0


def test_agent_performance_dataclass():
    perf = AgentPerformance(
        agent_type="claude-code",
        task_type="ui",
        language="typescript",
        success_rate=0.75,
        sample_count=4,
    )
    d = perf.to_dict()
    assert d["agent_type"] == "claude-code"
    assert d["success_rate"] == 0.75

    restored = AgentPerformance.from_dict(d)
    assert restored.agent_type == "claude-code"
    assert restored.success_rate == 0.75


def test_different_task_types_independent(tmp_stats):
    """Stats for different task_type/language combos should be independent."""
    tmp_stats.record_outcome("claude-code", "ui", "typescript", success=True)
    tmp_stats.record_outcome("claude-code", "backend", "rust", success=False)

    assert len(tmp_stats.all_stats()) == 2
    perf_ui = tmp_stats.get_performance("claude-code", "ui", "typescript")
    perf_be = tmp_stats.get_performance("claude-code", "backend", "rust")
    assert perf_ui.success_rate == 1.0
    assert perf_be.success_rate == 0.0
