"""Conflict detection and resolution for shared file writes.

When multiple agents write to the same file (typically shared config files
like package.json), the orchestrator must detect and resolve the conflict.

Resolution strategies:
  - LAST_WRITE_WINS: most recent write is kept (default for non-critical files)
  - FIRST_WRITE_WINS: first write is kept, subsequent blocked
  - ORCHESTRATOR_MERGES: DSPy-powered merge of conflicting changes
  - USER_DECIDES: pause and ask the user
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import dspy

logger = logging.getLogger(__name__)


class ConflictStrategy(Enum):
    """Strategy for resolving write conflicts on shared files."""

    LAST_WRITE_WINS = "lww"
    FIRST_WRITE_WINS = "fww"
    ORCHESTRATOR_MERGES = "merge"
    USER_DECIDES = "user"


@dataclass
class WriteRecord:
    """Record of a file write by an agent."""

    agent_id: str
    file_path: str
    timestamp_ms: int = 0
    description: str = ""


@dataclass
class Conflict:
    """A detected conflict between two agents writing the same file."""

    file_path: str
    writers: list[str]  # agent_ids that wrote to this file
    first_writer: str
    latest_writer: str
    resolved: bool = False
    resolution: str = ""  # description of how it was resolved


class ConflictDetector:
    """Detects when multiple agents write to the same file."""

    def __init__(self) -> None:
        self._write_map: dict[str, list[WriteRecord]] = {}  # file_path -> records
        self._conflicts: list[Conflict] = []
        self._lock = asyncio.Lock()

    @property
    def conflicts(self) -> list[Conflict]:
        """All detected conflicts."""
        return list(self._conflicts)

    @property
    def unresolved_conflicts(self) -> list[Conflict]:
        """Conflicts that haven't been resolved yet."""
        return [c for c in self._conflicts if not c.resolved]

    async def record_write(
        self,
        agent_id: str,
        file_path: str,
        timestamp_ms: int = 0,
        description: str = "",
    ) -> Conflict | None:
        """Record a file write and return a Conflict if one is detected.

        Returns None if no conflict (this is the first writer).
        Returns a Conflict object if another agent already wrote this file.
        """
        record = WriteRecord(
            agent_id=agent_id,
            file_path=file_path,
            timestamp_ms=timestamp_ms,
            description=description,
        )

        async with self._lock:
            records = self._write_map.setdefault(file_path, [])
            existing_writers = [r.agent_id for r in records if r.agent_id != agent_id]

            records.append(record)

            if existing_writers:
                # Conflict detected
                all_writers = list(dict.fromkeys([r.agent_id for r in records]))
                conflict = Conflict(
                    file_path=file_path,
                    writers=all_writers,
                    first_writer=records[0].agent_id,
                    latest_writer=agent_id,
                )
                self._conflicts.append(conflict)
                logger.warning(
                    f"Conflict detected on {file_path}: writers={all_writers}"
                )
                return conflict

            return None

    def get_writers(self, file_path: str) -> list[str]:
        """Return list of agent_ids that have written to a file."""
        records = self._write_map.get(file_path, [])
        return list(dict.fromkeys(r.agent_id for r in records))

    def clear(self) -> None:
        """Reset all tracking state."""
        self._write_map.clear()
        self._conflicts.clear()


class SoftLock:
    """Soft lock for shared file writes.

    When an agent starts writing a shared file, the lock is acquired.
    Other agents attempting to write the same file are queued until
    the first agent finishes. Reads are never blocked.
    """

    def __init__(self) -> None:
        self._locks: dict[str, str] = {}  # file_path -> agent_id holding lock
        self._waiters: dict[str, asyncio.Event] = {}  # file_path -> release event
        self._mutex = asyncio.Lock()

    async def acquire(self, file_path: str, agent_id: str) -> bool:
        """Try to acquire a soft lock for writing.

        Returns True if the lock was acquired (or was already held by this agent).
        Returns False if another agent holds the lock -- caller should wait.
        """
        async with self._mutex:
            holder = self._locks.get(file_path)
            if holder is None or holder == agent_id:
                self._locks[file_path] = agent_id
                return True
            return False

    async def wait_for_release(self, file_path: str, timeout: float = 30.0) -> bool:
        """Wait for a lock to be released.

        Returns True if the lock was released within the timeout.
        Returns False on timeout.
        """
        async with self._mutex:
            if file_path not in self._locks:
                return True
            if file_path not in self._waiters:
                self._waiters[file_path] = asyncio.Event()
            event = self._waiters[file_path]

        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def release(self, file_path: str, agent_id: str) -> None:
        """Release a soft lock."""
        async with self._mutex:
            if self._locks.get(file_path) == agent_id:
                del self._locks[file_path]
                event = self._waiters.pop(file_path, None)
                if event:
                    event.set()

    @property
    def held_locks(self) -> dict[str, str]:
        """Map of file_path -> agent_id for currently held locks."""
        return dict(self._locks)


class ConflictResolve(dspy.Signature):
    """Resolve conflicting changes to a shared file from two agents."""

    file_path: str = dspy.InputField()
    agent_a_changes: str = dspy.InputField(
        desc="Diff or description of Agent A's changes"
    )
    agent_b_changes: str = dspy.InputField(
        desc="Diff or description of Agent B's changes"
    )
    file_content_before: str = dspy.InputField(
        desc="Original file content before changes"
    )

    merged_content: str = dspy.OutputField(
        desc="Merged file content incorporating both changes"
    )
    resolution_notes: str = dspy.OutputField(desc="What was merged and any tradeoffs")


class ConflictResolver:
    """Resolves file conflicts using configured strategy."""

    def __init__(
        self, strategy: ConflictStrategy = ConflictStrategy.ORCHESTRATOR_MERGES
    ) -> None:
        self._strategy = strategy

    @property
    def strategy(self) -> ConflictStrategy:
        return self._strategy

    async def resolve(
        self,
        conflict: Conflict,
        agent_a_changes: str = "",
        agent_b_changes: str = "",
        file_content_before: str = "",
    ) -> str:
        """Resolve a conflict using the configured strategy.

        Returns the resolved file content or a description of the resolution.
        """
        if self._strategy == ConflictStrategy.LAST_WRITE_WINS:
            conflict.resolved = True
            conflict.resolution = (
                f"Last write wins: kept {conflict.latest_writer}'s changes"
            )
            return conflict.resolution

        elif self._strategy == ConflictStrategy.FIRST_WRITE_WINS:
            conflict.resolved = True
            conflict.resolution = (
                f"First write wins: kept {conflict.first_writer}'s changes"
            )
            return conflict.resolution

        elif self._strategy == ConflictStrategy.ORCHESTRATOR_MERGES:
            return await self._dspy_merge(
                conflict, agent_a_changes, agent_b_changes, file_content_before
            )

        elif self._strategy == ConflictStrategy.USER_DECIDES:
            conflict.resolution = "Awaiting user decision"
            return conflict.resolution

        return "Unknown strategy"

    async def _dspy_merge(
        self,
        conflict: Conflict,
        agent_a_changes: str,
        agent_b_changes: str,
        file_content_before: str,
    ) -> str:
        """Use DSPy to merge conflicting changes."""
        try:
            merger = dspy.Predict(ConflictResolve)
            result = merger(
                file_path=conflict.file_path,
                agent_a_changes=agent_a_changes
                or f"Changes by {conflict.first_writer}",
                agent_b_changes=agent_b_changes
                or f"Changes by {conflict.latest_writer}",
                file_content_before=file_content_before
                or "(original content not available)",
            )

            conflict.resolved = True
            conflict.resolution = result.resolution_notes
            return result.merged_content

        except Exception as e:
            logger.error(f"DSPy merge failed for {conflict.file_path}: {e}")
            # Fallback to last-write-wins
            conflict.resolved = True
            conflict.resolution = (
                f"DSPy merge failed ({e}), fell back to last-write-wins"
            )
            return conflict.resolution
