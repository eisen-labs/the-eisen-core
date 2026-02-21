"""Tests for conflict detection and resolution (Phase 3D)."""

import asyncio

import pytest

from eisen_agent.conflict import (
    Conflict,
    ConflictDetector,
    ConflictResolver,
    ConflictStrategy,
    SoftLock,
    WriteRecord,
)


# ---------------------------------------------------------------
# ConflictDetector
# ---------------------------------------------------------------


async def test_no_conflict_single_writer():
    detector = ConflictDetector()
    result = await detector.record_write("agent-0", "package.json")
    assert result is None
    assert len(detector.conflicts) == 0


async def test_conflict_detected_two_writers():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "package.json")
    conflict = await detector.record_write("agent-1", "package.json")

    assert conflict is not None
    assert conflict.file_path == "package.json"
    assert set(conflict.writers) == {"agent-0", "agent-1"}
    assert conflict.first_writer == "agent-0"
    assert conflict.latest_writer == "agent-1"
    assert not conflict.resolved


async def test_same_agent_no_conflict():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "package.json")
    result = await detector.record_write("agent-0", "package.json")
    assert result is None


async def test_three_writers_conflict():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "shared.ts")
    await detector.record_write("agent-1", "shared.ts")
    conflict = await detector.record_write("agent-2", "shared.ts")

    assert conflict is not None
    assert len(conflict.writers) == 3
    assert len(detector.conflicts) == 2  # two conflict events


async def test_different_files_no_conflict():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "file_a.ts")
    result = await detector.record_write("agent-1", "file_b.ts")
    assert result is None


async def test_get_writers():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "pkg.json")
    await detector.record_write("agent-1", "pkg.json")

    writers = detector.get_writers("pkg.json")
    assert set(writers) == {"agent-0", "agent-1"}


async def test_unresolved_conflicts():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "file.ts")
    await detector.record_write("agent-1", "file.ts")

    assert len(detector.unresolved_conflicts) == 1
    detector.conflicts[0].resolved = True
    assert len(detector.unresolved_conflicts) == 0


async def test_clear():
    detector = ConflictDetector()
    await detector.record_write("agent-0", "file.ts")
    await detector.record_write("agent-1", "file.ts")

    detector.clear()
    assert len(detector.conflicts) == 0
    assert detector.get_writers("file.ts") == []


# ---------------------------------------------------------------
# SoftLock
# ---------------------------------------------------------------


async def test_soft_lock_acquire_release():
    lock = SoftLock()
    assert await lock.acquire("file.ts", "agent-0")
    assert lock.held_locks == {"file.ts": "agent-0"}

    await lock.release("file.ts", "agent-0")
    assert lock.held_locks == {}


async def test_soft_lock_same_agent_reentrant():
    lock = SoftLock()
    assert await lock.acquire("file.ts", "agent-0")
    assert await lock.acquire("file.ts", "agent-0")  # same agent, still True


async def test_soft_lock_different_agent_blocked():
    lock = SoftLock()
    assert await lock.acquire("file.ts", "agent-0")
    assert not await lock.acquire("file.ts", "agent-1")  # blocked


async def test_soft_lock_wait_for_release():
    lock = SoftLock()
    await lock.acquire("file.ts", "agent-0")

    async def release_after_delay():
        await asyncio.sleep(0.1)
        await lock.release("file.ts", "agent-0")

    asyncio.create_task(release_after_delay())
    result = await lock.wait_for_release("file.ts", timeout=2.0)
    assert result is True


async def test_soft_lock_wait_timeout():
    lock = SoftLock()
    await lock.acquire("file.ts", "agent-0")
    result = await lock.wait_for_release("file.ts", timeout=0.1)
    assert result is False


async def test_soft_lock_different_files_independent():
    lock = SoftLock()
    assert await lock.acquire("file_a.ts", "agent-0")
    assert await lock.acquire("file_b.ts", "agent-1")
    assert lock.held_locks == {"file_a.ts": "agent-0", "file_b.ts": "agent-1"}


# ---------------------------------------------------------------
# ConflictResolver
# ---------------------------------------------------------------


async def test_lww_strategy():
    resolver = ConflictResolver(ConflictStrategy.LAST_WRITE_WINS)
    conflict = Conflict(
        file_path="pkg.json",
        writers=["agent-0", "agent-1"],
        first_writer="agent-0",
        latest_writer="agent-1",
    )
    result = await resolver.resolve(conflict)
    assert "agent-1" in result
    assert conflict.resolved


async def test_fww_strategy():
    resolver = ConflictResolver(ConflictStrategy.FIRST_WRITE_WINS)
    conflict = Conflict(
        file_path="pkg.json",
        writers=["agent-0", "agent-1"],
        first_writer="agent-0",
        latest_writer="agent-1",
    )
    result = await resolver.resolve(conflict)
    assert "agent-0" in result
    assert conflict.resolved


async def test_user_decides_strategy():
    resolver = ConflictResolver(ConflictStrategy.USER_DECIDES)
    conflict = Conflict(
        file_path="pkg.json",
        writers=["agent-0", "agent-1"],
        first_writer="agent-0",
        latest_writer="agent-1",
    )
    result = await resolver.resolve(conflict)
    assert "user" in result.lower()
    assert not conflict.resolved  # user hasn't decided yet
