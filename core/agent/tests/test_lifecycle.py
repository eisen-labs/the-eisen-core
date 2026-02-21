"""Tests for the task lifecycle state machine."""

import pytest

from eisen_agent.lifecycle import (
    InvalidTransitionError,
    SubtaskLifecycle,
    SubtaskState,
    TaskLifecycle,
    TaskState,
)


# ---------------------------------------------------------------------------
# TaskLifecycle: valid transitions
# ---------------------------------------------------------------------------


def test_task_lifecycle_initial_state():
    lc = TaskLifecycle()
    assert lc.state == TaskState.IDLE
    assert not lc.is_terminal
    assert not lc.can_retry


def test_task_lifecycle_happy_path():
    """IDLE -> DECOMPOSING -> CONFIRMING -> SPAWNING -> RUNNING -> COMPLETED."""
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    assert lc.state == TaskState.DECOMPOSING

    lc.transition(TaskState.CONFIRMING)
    assert lc.state == TaskState.CONFIRMING

    lc.transition(TaskState.SPAWNING)
    assert lc.state == TaskState.SPAWNING

    lc.transition(TaskState.RUNNING)
    assert lc.state == TaskState.RUNNING

    lc.transition(TaskState.COMPLETED)
    assert lc.state == TaskState.COMPLETED
    assert lc.is_terminal


def test_task_lifecycle_with_failures():
    """IDLE -> ... -> RUNNING -> DONE (some failed)."""
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)
    lc.transition(TaskState.SPAWNING)
    lc.transition(TaskState.RUNNING)
    lc.transition(TaskState.DONE)
    assert lc.state == TaskState.DONE
    assert not lc.is_terminal
    assert lc.can_retry


def test_task_lifecycle_cancel():
    """IDLE -> DECOMPOSING -> CONFIRMING -> CANCELLED."""
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)
    lc.transition(TaskState.CANCELLED)
    assert lc.state == TaskState.CANCELLED
    assert lc.is_terminal


def test_task_lifecycle_retry_flow():
    """DONE -> RETRYING -> RUNNING -> COMPLETED."""
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)
    lc.transition(TaskState.SPAWNING)
    lc.transition(TaskState.RUNNING)
    lc.transition(TaskState.DONE)
    lc.transition(TaskState.RETRYING)
    assert lc.state == TaskState.RETRYING

    lc.transition(TaskState.RUNNING)
    assert lc.state == TaskState.RUNNING

    lc.transition(TaskState.COMPLETED)
    assert lc.state == TaskState.COMPLETED
    assert lc.is_terminal


# ---------------------------------------------------------------------------
# TaskLifecycle: invalid transitions
# ---------------------------------------------------------------------------


def test_task_lifecycle_invalid_idle_to_running():
    lc = TaskLifecycle()
    with pytest.raises(InvalidTransitionError) as exc_info:
        lc.transition(TaskState.RUNNING)
    assert exc_info.value.current == TaskState.IDLE
    assert exc_info.value.target == TaskState.RUNNING


def test_task_lifecycle_invalid_completed_to_running():
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)
    lc.transition(TaskState.SPAWNING)
    lc.transition(TaskState.RUNNING)
    lc.transition(TaskState.COMPLETED)
    with pytest.raises(InvalidTransitionError):
        lc.transition(TaskState.RUNNING)


def test_task_lifecycle_invalid_cancelled_to_retrying():
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)
    lc.transition(TaskState.CANCELLED)
    with pytest.raises(InvalidTransitionError):
        lc.transition(TaskState.RETRYING)


def test_task_lifecycle_invalid_running_to_retrying():
    """Can't retry directly from RUNNING -- must go to DONE first."""
    lc = TaskLifecycle()
    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)
    lc.transition(TaskState.SPAWNING)
    lc.transition(TaskState.RUNNING)
    with pytest.raises(InvalidTransitionError):
        lc.transition(TaskState.RETRYING)


# ---------------------------------------------------------------------------
# TaskLifecycle: callbacks
# ---------------------------------------------------------------------------


def test_task_lifecycle_callback():
    lc = TaskLifecycle()
    transitions: list[tuple[TaskState, TaskState]] = []
    lc.on_state_change(lambda old, new: transitions.append((old, new)))

    lc.transition(TaskState.DECOMPOSING)
    lc.transition(TaskState.CONFIRMING)

    assert len(transitions) == 2
    assert transitions[0] == (TaskState.IDLE, TaskState.DECOMPOSING)
    assert transitions[1] == (TaskState.DECOMPOSING, TaskState.CONFIRMING)


def test_task_lifecycle_callback_error_handled():
    """Callbacks that raise should not break state transitions."""
    lc = TaskLifecycle()

    def bad_callback(old: TaskState, new: TaskState) -> None:
        raise RuntimeError("callback error")

    lc.on_state_change(bad_callback)

    # Should not raise, callback error is swallowed
    lc.transition(TaskState.DECOMPOSING)
    assert lc.state == TaskState.DECOMPOSING


# ---------------------------------------------------------------------------
# SubtaskLifecycle: valid transitions
# ---------------------------------------------------------------------------


def test_subtask_lifecycle_initial_state():
    sl = SubtaskLifecycle(0, "test task")
    assert sl.state == SubtaskState.PENDING
    assert sl.index == 0
    assert sl.description == "test task"
    assert sl.retry_count == 0
    assert not sl.is_terminal
    assert not sl.can_retry
    assert sl.needs_execution


def test_subtask_lifecycle_happy_path():
    """PENDING -> RUNNING -> COMPLETED."""
    sl = SubtaskLifecycle(0, "implement auth")
    sl.transition(SubtaskState.RUNNING)
    assert sl.state == SubtaskState.RUNNING
    assert not sl.needs_execution

    sl.transition(SubtaskState.COMPLETED)
    assert sl.state == SubtaskState.COMPLETED
    assert sl.is_terminal
    assert not sl.needs_execution


def test_subtask_lifecycle_failure():
    """PENDING -> RUNNING -> FAILED."""
    sl = SubtaskLifecycle(1, "add parser")
    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.FAILED)
    assert sl.state == SubtaskState.FAILED
    assert not sl.is_terminal
    assert sl.can_retry


def test_subtask_lifecycle_partial():
    """PENDING -> RUNNING -> PARTIAL."""
    sl = SubtaskLifecycle(2, "write tests")
    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.PARTIAL)
    assert sl.state == SubtaskState.PARTIAL
    assert sl.can_retry


def test_subtask_lifecycle_retry():
    """PENDING -> RUNNING -> FAILED -> RETRYING -> RUNNING -> COMPLETED."""
    sl = SubtaskLifecycle(0, "auth feature")
    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.FAILED)

    assert sl.retry_count == 0
    sl.transition(SubtaskState.RETRYING)
    assert sl.retry_count == 1
    assert sl.needs_execution

    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.COMPLETED)
    assert sl.state == SubtaskState.COMPLETED
    assert sl.retry_count == 1


def test_subtask_lifecycle_multiple_retries():
    """Multiple retry cycles increment the counter."""
    sl = SubtaskLifecycle(0, "flaky task")
    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.FAILED)
    sl.transition(SubtaskState.RETRYING)
    assert sl.retry_count == 1

    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.FAILED)
    sl.transition(SubtaskState.RETRYING)
    assert sl.retry_count == 2

    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.COMPLETED)
    assert sl.retry_count == 2


# ---------------------------------------------------------------------------
# SubtaskLifecycle: invalid transitions
# ---------------------------------------------------------------------------


def test_subtask_lifecycle_invalid_pending_to_completed():
    sl = SubtaskLifecycle(0, "test")
    with pytest.raises(InvalidTransitionError):
        sl.transition(SubtaskState.COMPLETED)


def test_subtask_lifecycle_invalid_completed_to_running():
    sl = SubtaskLifecycle(0, "test")
    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.COMPLETED)
    with pytest.raises(InvalidTransitionError):
        sl.transition(SubtaskState.RUNNING)


def test_subtask_lifecycle_invalid_running_to_retrying():
    """Can't retry directly from RUNNING -- must fail/partial first."""
    sl = SubtaskLifecycle(0, "test")
    sl.transition(SubtaskState.RUNNING)
    with pytest.raises(InvalidTransitionError):
        sl.transition(SubtaskState.RETRYING)


# ---------------------------------------------------------------------------
# SubtaskLifecycle: callbacks
# ---------------------------------------------------------------------------


def test_subtask_lifecycle_callback():
    sl = SubtaskLifecycle(0, "test")
    transitions: list[tuple[SubtaskState, SubtaskState]] = []
    sl.on_state_change(lambda old, new: transitions.append((old, new)))

    sl.transition(SubtaskState.RUNNING)
    sl.transition(SubtaskState.COMPLETED)

    assert len(transitions) == 2
    assert transitions[0] == (SubtaskState.PENDING, SubtaskState.RUNNING)
    assert transitions[1] == (SubtaskState.RUNNING, SubtaskState.COMPLETED)
