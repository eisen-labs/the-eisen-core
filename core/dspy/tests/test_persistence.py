"""Tests for session persistence and resume (Phase 4D)."""

import json
import time
from pathlib import Path

import pytest

from eisen_agent.persistence import RunPersistence, RunState, SavedSubtask


@pytest.fixture
def tmp_persistence(tmp_path):
    """Create a RunPersistence with a temp directory."""
    return RunPersistence(runs_dir=tmp_path / "runs")


def _make_run_state(
    run_id: str = "run-001",
    state: str = "running",
    num_subtasks: int = 3,
    completed: int = 1,
) -> RunState:
    subtasks = []
    for i in range(num_subtasks):
        if i < completed:
            status = "completed"
        elif i == completed:
            status = "failed"
        else:
            status = "pending"
        subtasks.append(
            SavedSubtask(
                index=i,
                description=f"subtask-{i}",
                region=f"/region-{i}",
                agent_id=f"agent-{i}",
                status=status,
            )
        )
    return RunState(
        run_id=run_id,
        user_intent="implement feature X",
        workspace="/project",
        state=state,
        subtasks=subtasks,
    )


def test_save_and_load(tmp_persistence):
    run = _make_run_state()
    tmp_persistence.save(run)

    loaded = tmp_persistence.load("run-001")
    assert loaded is not None
    assert loaded.run_id == "run-001"
    assert loaded.user_intent == "implement feature X"
    assert len(loaded.subtasks) == 3


def test_load_nonexistent(tmp_persistence):
    assert tmp_persistence.load("nonexistent") is None


def test_list_resumable(tmp_persistence):
    # Resumable: has pending subtasks
    tmp_persistence.save(_make_run_state("r1", "running", completed=1))
    # Not resumable: all completed
    all_done = RunState(
        run_id="r2",
        user_intent="done task",
        workspace="/p",
        state="completed",
        subtasks=[
            SavedSubtask(
                index=0, description="s", region="/r", agent_id="a", status="completed"
            ),
        ],
    )
    tmp_persistence.save(all_done)

    resumable = tmp_persistence.list_resumable()
    assert len(resumable) == 1
    assert resumable[0].run_id == "r1"


def test_list_all(tmp_persistence):
    tmp_persistence.save(_make_run_state("r1"))
    tmp_persistence.save(_make_run_state("r2"))
    all_runs = tmp_persistence.list_all()
    assert len(all_runs) == 2


def test_delete(tmp_persistence):
    tmp_persistence.save(_make_run_state("r1"))
    assert tmp_persistence.delete("r1") is True
    assert tmp_persistence.load("r1") is None
    assert tmp_persistence.delete("r1") is False


def test_clear(tmp_persistence):
    tmp_persistence.save(_make_run_state("r1"))
    tmp_persistence.save(_make_run_state("r2"))
    deleted = tmp_persistence.clear()
    assert deleted == 2
    assert len(tmp_persistence.list_all()) == 0


# RunState tests


def test_run_state_counts():
    run = _make_run_state(completed=1)  # 0=completed, 1=failed, 2=pending
    assert run.completed_count == 1
    assert run.failed_count == 1
    assert run.pending_count == 1


def test_run_state_is_resumable():
    run = _make_run_state(completed=1)
    assert run.is_resumable is True

    all_done = RunState(
        run_id="x",
        user_intent="y",
        workspace="/p",
        subtasks=[
            SavedSubtask(
                index=0, description="s", region="/r", agent_id="a", status="completed"
            ),
        ],
    )
    assert all_done.is_resumable is False


def test_run_state_progress_summary():
    run = _make_run_state(completed=1)
    summary = run.progress_summary
    assert "1/3 done" in summary
    assert "1 failed" in summary
    assert "1 pending" in summary


def test_run_state_roundtrip():
    run = _make_run_state()
    d = run.to_dict()
    restored = RunState.from_dict(d)
    assert restored.run_id == run.run_id
    assert len(restored.subtasks) == len(run.subtasks)
    assert restored.subtasks[0].description == run.subtasks[0].description


def test_saved_subtask_roundtrip():
    sub = SavedSubtask(
        index=0,
        description="test task",
        region="/ui",
        agent_id="claude-code",
        status="completed",
        expected_files=["login.ts"],
        depends_on=[1, 2],
    )
    d = sub.to_dict()
    restored = SavedSubtask.from_dict(d)
    assert restored.description == "test task"
    assert restored.expected_files == ["login.ts"]
    assert restored.depends_on == [1, 2]


def test_run_state_sets_timestamp(tmp_persistence):
    run = _make_run_state()
    assert run.timestamp == 0.0
    tmp_persistence.save(run)
    assert run.timestamp > 0.0
    assert run.created_at > 0.0


def test_run_state_preserves_created_at(tmp_persistence):
    run = _make_run_state()
    run.created_at = 1000.0
    tmp_persistence.save(run)
    assert run.created_at == 1000.0  # Not overwritten
    assert run.timestamp > 1000.0  # Updated
