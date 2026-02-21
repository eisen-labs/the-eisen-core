"""Task lifecycle state machine for multi-agent orchestration.

Manages state transitions for both the overall orchestration task
and individual subtasks, including retry flows.
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Callable

logger = logging.getLogger(__name__)


class TaskState(Enum):
    """Top-level orchestration states."""

    IDLE = "idle"
    DECOMPOSING = "decomposing"
    CONFIRMING = "confirming"
    SPAWNING = "spawning"
    RUNNING = "running"
    DONE = "done"  # all subtasks finished, some may have failed
    COMPLETED = "completed"  # all subtasks succeeded
    CANCELLED = "cancelled"
    RETRYING = "retrying"


class SubtaskState(Enum):
    """Per-subtask execution states."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    PARTIAL = "partial"
    RETRYING = "retrying"


# Valid state transitions for the orchestration task
_VALID_TRANSITIONS: dict[TaskState, set[TaskState]] = {
    TaskState.IDLE: {TaskState.DECOMPOSING},
    TaskState.DECOMPOSING: {TaskState.CONFIRMING},
    TaskState.CONFIRMING: {TaskState.CANCELLED, TaskState.SPAWNING},
    TaskState.SPAWNING: {TaskState.RUNNING},
    TaskState.RUNNING: {TaskState.DONE, TaskState.COMPLETED},
    TaskState.DONE: {TaskState.RETRYING},
    TaskState.COMPLETED: set(),  # terminal state
    TaskState.CANCELLED: set(),  # terminal state
    TaskState.RETRYING: {TaskState.RUNNING},
}

# Valid state transitions for subtasks
_VALID_SUBTASK_TRANSITIONS: dict[SubtaskState, set[SubtaskState]] = {
    SubtaskState.PENDING: {SubtaskState.RUNNING},
    SubtaskState.RUNNING: {
        SubtaskState.COMPLETED,
        SubtaskState.FAILED,
        SubtaskState.PARTIAL,
    },
    SubtaskState.COMPLETED: set(),  # terminal state
    SubtaskState.FAILED: {SubtaskState.RETRYING},
    SubtaskState.PARTIAL: {SubtaskState.RETRYING},
    SubtaskState.RETRYING: {SubtaskState.RUNNING},
}


class InvalidTransitionError(Exception):
    """Raised when an invalid state transition is attempted."""

    def __init__(self, current: Any, target: Any) -> None:
        self.current = current
        self.target = target
        super().__init__(f"Invalid transition: {current.value} -> {target.value}")


StateChangeCallback = Callable[[Any, Any], None]


class TaskLifecycle:
    """Manages the state machine for the overall orchestration task."""

    def __init__(self) -> None:
        self._state = TaskState.IDLE
        self._callbacks: list[StateChangeCallback] = []

    @property
    def state(self) -> TaskState:
        return self._state

    def on_state_change(self, callback: StateChangeCallback) -> None:
        """Register a callback for state transitions."""
        self._callbacks.append(callback)

    def transition(self, target: TaskState) -> None:
        """Transition to a new state, validating the transition is legal."""
        if target not in _VALID_TRANSITIONS.get(self._state, set()):
            raise InvalidTransitionError(self._state, target)

        old = self._state
        self._state = target
        logger.info(f"[orchestrator] {old.value} -> {target.value}")

        for callback in self._callbacks:
            try:
                callback(old, target)
            except Exception as e:
                logger.warning(f"State change callback error: {e}")

    @property
    def is_terminal(self) -> bool:
        """Whether the current state is terminal (no further transitions possible)."""
        return len(_VALID_TRANSITIONS.get(self._state, set())) == 0

    @property
    def can_retry(self) -> bool:
        """Whether retry is possible from the current state."""
        return TaskState.RETRYING in _VALID_TRANSITIONS.get(self._state, set())


class SubtaskLifecycle:
    """Manages the state machine for a single subtask."""

    def __init__(self, index: int, description: str) -> None:
        self.index = index
        self.description = description
        self._state = SubtaskState.PENDING
        self._retry_count = 0
        self._callbacks: list[StateChangeCallback] = []

    @property
    def state(self) -> SubtaskState:
        return self._state

    @property
    def retry_count(self) -> int:
        return self._retry_count

    def on_state_change(self, callback: StateChangeCallback) -> None:
        """Register a callback for state transitions."""
        self._callbacks.append(callback)

    def transition(self, target: SubtaskState) -> None:
        """Transition to a new state, validating the transition is legal."""
        if target not in _VALID_SUBTASK_TRANSITIONS.get(self._state, set()):
            raise InvalidTransitionError(self._state, target)

        old = self._state
        self._state = target

        if target == SubtaskState.RETRYING:
            self._retry_count += 1

        logger.info(
            f"[subtask {self.index}] {old.value} -> {target.value}"
            + (
                f" (retry #{self._retry_count})"
                if target == SubtaskState.RETRYING
                else ""
            )
        )

        for callback in self._callbacks:
            try:
                callback(old, target)
            except Exception as e:
                logger.warning(f"Subtask state change callback error: {e}")

    @property
    def is_terminal(self) -> bool:
        """Whether the current state is terminal."""
        return len(_VALID_SUBTASK_TRANSITIONS.get(self._state, set())) == 0

    @property
    def can_retry(self) -> bool:
        """Whether retry is possible from the current state."""
        return SubtaskState.RETRYING in _VALID_SUBTASK_TRANSITIONS.get(
            self._state, set()
        )

    @property
    def needs_execution(self) -> bool:
        """Whether this subtask needs (re-)execution."""
        return self._state in (SubtaskState.PENDING, SubtaskState.RETRYING)
