"""Tests for trace collection (Phase 4A)."""

import json
from pathlib import Path

import pytest

from eisen_agent.training.collector import TraceCollector, TraceEntry
from eisen_agent.types import OrchestratorResult, SubtaskResult


@pytest.fixture
def tmp_traces(tmp_path):
    """Create a TraceCollector with a temp directory."""
    return TraceCollector(traces_dir=tmp_path / "traces")


def _make_result(status="completed", num_subtasks=2) -> OrchestratorResult:
    """Helper to create a test OrchestratorResult."""
    results = []
    for i in range(num_subtasks):
        s = "completed" if i < num_subtasks - 1 or status == "completed" else "failed"
        results.append(
            SubtaskResult(
                subtask_index=i,
                description=f"subtask-{i}",
                region=f"/region-{i}",
                agent_id=f"agent-{i}",
                status=s,
                agent_output="output",
                failure_reason="fail" if s == "failed" else None,
            )
        )
    return OrchestratorResult(
        status=status,
        subtask_results=results,
        total_cost_tokens=1000,
    )


def test_record_run(tmp_traces):
    result = _make_result()
    entry = tmp_traces.record_run(
        run_id="test-001",
        user_intent="implement auth",
        workspace="/project",
        result=result,
        subtasks=[{"description": "s1"}, {"description": "s2"}],
    )
    assert entry.run_id == "test-001"
    assert entry.quality == 1.0  # all completed
    assert entry.user_intent == "implement auth"


def test_record_run_partial_quality(tmp_traces):
    result = _make_result(status="done", num_subtasks=2)
    entry = tmp_traces.record_run(
        run_id="test-002",
        user_intent="add search",
        workspace="/project",
        result=result,
    )
    # 1 completed out of 2
    assert entry.quality == 0.5


def test_record_run_writes_file(tmp_traces):
    result = _make_result()
    tmp_traces.record_run(
        run_id="test-003",
        user_intent="test",
        workspace="/project",
        result=result,
    )
    files = list(tmp_traces._traces_dir.glob("run_*.json"))
    assert len(files) == 1
    data = json.loads(files[0].read_text())
    assert data["run_id"] == "test-003"


def test_load_traces_filters_by_quality(tmp_traces):
    # High quality run
    tmp_traces.record_run(
        run_id="good",
        user_intent="good task",
        workspace="/project",
        result=_make_result(status="completed"),
    )
    # Low quality run (all failed)
    bad_result = OrchestratorResult(
        status="done",
        subtask_results=[
            SubtaskResult(
                subtask_index=0,
                description="bad",
                region="/r",
                agent_id="a",
                status="failed",
                agent_output="",
            )
        ],
    )
    tmp_traces.record_run(
        run_id="bad",
        user_intent="bad task",
        workspace="/project",
        result=bad_result,
    )

    traces = tmp_traces.load_traces(min_quality=0.5)
    assert len(traces) == 1
    assert traces[0].run_id == "good"


def test_load_traces_empty_dir(tmp_traces):
    traces = tmp_traces.load_traces()
    assert traces == []


def test_count_traces(tmp_traces):
    assert tmp_traces.count_traces() == 0
    tmp_traces.record_run(
        run_id="a", user_intent="x", workspace="/p", result=_make_result()
    )
    assert tmp_traces.count_traces() == 1


def test_clear_traces(tmp_traces):
    tmp_traces.record_run(
        run_id="a", user_intent="x", workspace="/p", result=_make_result()
    )
    tmp_traces.record_run(
        run_id="b", user_intent="y", workspace="/p", result=_make_result()
    )
    assert tmp_traces.count_traces() == 2
    deleted = tmp_traces.clear_traces()
    assert deleted == 2
    assert tmp_traces.count_traces() == 0


def test_trace_entry_roundtrip():
    entry = TraceEntry(
        run_id="rt",
        timestamp=1000.0,
        user_intent="test",
        workspace="/w",
        quality=0.75,
    )
    d = entry.to_dict()
    restored = TraceEntry.from_dict(d)
    assert restored.run_id == "rt"
    assert restored.quality == 0.75


def test_trace_entry_from_dict_ignores_extra_keys():
    data = {
        "run_id": "x",
        "timestamp": 0,
        "user_intent": "y",
        "workspace": "/w",
        "extra_key": True,
    }
    entry = TraceEntry.from_dict(data)
    assert entry.run_id == "x"
