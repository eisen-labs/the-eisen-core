"""Tests for BlockedAccess listener and A2A routing (Phase 3B)."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eisen_agent.blocked_listener import BlockedAccessEvent, BlockedAccessListener


@pytest.fixture
def mock_router():
    router = MagicMock()
    router.resolve = AsyncMock(return_value="fn authenticate() -> bool")
    return router


def test_blocked_access_event_creation():
    event = BlockedAccessEvent(
        agent_id="claude-code-0",
        session_id="sess_1",
        path="/core/auth.rs",
        action="read",
        timestamp_ms=1700000000000,
    )
    assert event.agent_id == "claude-code-0"
    assert event.path == "/core/auth.rs"
    assert event.action == "read"


async def test_listener_initial_state(mock_router):
    listener = BlockedAccessListener(mock_router)
    assert listener.blocked_events == []
    assert listener.pending_resolutions == {}


async def test_handle_blocked_records_event(mock_router):
    listener = BlockedAccessListener(mock_router)

    msg = {
        "type": "blocked",
        "agent_id": "claude-code-0",
        "session_id": "sess_1",
        "path": "/core/auth.rs",
        "action": "read",
        "timestamp_ms": 1700000000000,
    }
    await listener._handle_blocked(msg)

    assert len(listener.blocked_events) == 1
    event = listener.blocked_events[0]
    assert event.agent_id == "claude-code-0"
    assert event.path == "/core/auth.rs"


async def test_handle_blocked_triggers_resolution(mock_router):
    listener = BlockedAccessListener(mock_router)

    msg = {
        "type": "blocked",
        "agent_id": "claude-code-0",
        "session_id": "sess_1",
        "path": "/core/auth.rs",
        "action": "read",
        "timestamp_ms": 1700000000000,
    }
    await listener._handle_blocked(msg)

    # Router should have been called with the symbol hint
    mock_router.resolve.assert_called_once()
    call_args = mock_router.resolve.call_args
    assert call_args.kwargs["requesting_agent"] == "claude-code-0"
    assert call_args.kwargs["symbol_name"] == "auth"  # extracted from path


async def test_handle_blocked_stores_resolution(mock_router):
    listener = BlockedAccessListener(mock_router)

    msg = {
        "type": "blocked",
        "agent_id": "agent-0",
        "session_id": "sess_1",
        "path": "/core/auth.rs",
        "action": "read",
        "timestamp_ms": 1700000000000,
    }
    await listener._handle_blocked(msg)

    resolutions = listener.pending_resolutions
    assert "agent-0" in resolutions
    assert "auth.rs" in resolutions["agent-0"]
    assert "fn authenticate() -> bool" in resolutions["agent-0"]


async def test_take_resolution(mock_router):
    listener = BlockedAccessListener(mock_router)

    msg = {
        "type": "blocked",
        "agent_id": "agent-0",
        "session_id": "sess_1",
        "path": "/core/auth.rs",
        "action": "read",
        "timestamp_ms": 1700000000000,
    }
    await listener._handle_blocked(msg)

    resolution = listener.take_resolution("agent-0")
    assert resolution is not None
    assert "fn authenticate() -> bool" in resolution

    # Second call should return None
    assert listener.take_resolution("agent-0") is None


async def test_multiple_blocked_same_agent(mock_router):
    listener = BlockedAccessListener(mock_router)

    for path in ["/core/auth.rs", "/core/db.rs"]:
        msg = {
            "type": "blocked",
            "agent_id": "agent-0",
            "session_id": "sess_1",
            "path": path,
            "action": "read",
            "timestamp_ms": 1700000000000,
        }
        await listener._handle_blocked(msg)

    assert len(listener.blocked_events) == 2
    # Resolutions should be concatenated
    resolution = listener.pending_resolutions.get("agent-0", "")
    assert "auth.rs" in resolution
    assert "db.rs" in resolution


async def test_path_to_symbol_hint():
    assert BlockedAccessListener._path_to_symbol_hint("/core/src/auth.rs") == "auth"
    assert BlockedAccessListener._path_to_symbol_hint("/ui/Button.tsx") == "Button"
    assert BlockedAccessListener._path_to_symbol_hint("package.json") == "package"
    assert BlockedAccessListener._path_to_symbol_hint("/a/b/c/utils.py") == "utils"


async def test_stop_listening(mock_router):
    listener = BlockedAccessListener(mock_router)
    # Stop a non-existent listener should not error
    listener.stop_listening("non-existent-agent")
    assert True


async def test_stop_all(mock_router):
    listener = BlockedAccessListener(mock_router)
    listener.stop_all()
    assert True
