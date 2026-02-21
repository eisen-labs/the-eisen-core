"""Tests for the A2A router."""

import json
from unittest.mock import MagicMock, patch

import pytest

from eisen_agent.acp_session import SessionUpdate
from eisen_agent.router import A2ARouter


# ---------------------------------------------------------------------------
# Registration / unregistration
# ---------------------------------------------------------------------------


def test_router_initial_state():
    router = A2ARouter("/workspace")
    assert router.registered_agents == {}
    assert router.cache_size == 0


def test_router_register_agent():
    router = A2ARouter("/workspace")
    session = MagicMock()
    router.register_agent("/ui", "claude-code-0", session)
    assert router.registered_agents == {"/ui": "claude-code-0"}


def test_router_register_multiple():
    router = A2ARouter("/workspace")
    router.register_agent("/ui", "claude-code-0", MagicMock())
    router.register_agent("/core", "opencode-1", MagicMock())
    assert len(router.registered_agents) == 2
    assert router.registered_agents["/ui"] == "claude-code-0"
    assert router.registered_agents["/core"] == "opencode-1"


def test_router_unregister_agent():
    router = A2ARouter("/workspace")
    router.register_agent("/ui", "claude-code-0", MagicMock())
    router.register_agent("/core", "opencode-1", MagicMock())
    router.unregister_agent("claude-code-0")
    assert len(router.registered_agents) == 1
    assert "/ui" not in router.registered_agents


def test_router_unregister_nonexistent():
    """Unregistering a non-existent agent is a no-op."""
    router = A2ARouter("/workspace")
    router.unregister_agent("nonexistent")  # should not raise


# ---------------------------------------------------------------------------
# PyO3 symbol tree resolution (mocked)
# ---------------------------------------------------------------------------


async def test_resolve_via_symbol_tree():
    """Symbol found in the tree-sitter symbol tree (zero cost)."""
    router = A2ARouter("/workspace")

    mock_matches = [
        {
            "kind": "function",
            "name": "AuthValidator",
            "path": "core/src/auth.rs",
            "startLine": 10,
            "endLine": 25,
        }
    ]

    formatted = router._format_symbol_matches(mock_matches)
    with patch.object(router, "_lookup_symbol_tree", return_value=formatted):
        result = await router.resolve("agent-0", "AuthValidator")

    assert "AuthValidator" in result
    assert "core/src/auth.rs" in result


async def test_resolve_symbol_tree_cache():
    """Second lookup hits the cache -- cache is populated after first lookup."""
    router = A2ARouter("/workspace")

    # Pre-populate cache (simulates a successful first lookup)
    router._symbol_cache["Config"] = "struct Config (core/src/config.rs:1-5)"

    result1 = await router.resolve("agent-0", "Config")
    result2 = await router.resolve("agent-0", "Config")

    assert result1 == result2
    assert "Config" in result1
    assert router.cache_size == 1


async def test_resolve_symbol_tree_no_match():
    """Symbol not in tree-sitter output."""
    router = A2ARouter("/workspace")

    with patch.object(router, "_lookup_symbol_tree", return_value=None):
        result = await router.resolve("agent-0", "NonExistent")

    assert "not found" in result.lower()


async def test_resolve_symbol_tree_unavailable():
    """Graceful fallback when symbol tree returns None."""
    router = A2ARouter("/workspace")

    with patch.object(router, "_lookup_symbol_tree", return_value=None):
        result = await router.resolve("agent-0", "Missing")
    assert "not found" in result.lower()
    assert "Missing" in result


# ---------------------------------------------------------------------------
# Agent-to-agent routing (mocked)
# ---------------------------------------------------------------------------


async def test_resolve_via_owning_agent():
    """Symbol resolved by routing to the owning agent."""
    router = A2ARouter("/workspace")

    mock_session = MagicMock()
    mock_session.session_id = "session-123"

    # Mock the prompt method to return an async iterator
    async def mock_prompt(query):
        yield SessionUpdate(kind="text", text="fn validate(token: &str) -> bool")
        yield SessionUpdate(kind="done", text="done")

    mock_session.prompt = mock_prompt

    router.register_agent("/core", "opencode-1", mock_session)

    # Symbol not in tree, but context mentions "core"
    with patch.object(router, "_lookup_symbol_tree", return_value=None):
        result = await router.resolve(
            "claude-code-0",
            "AuthValidator",
            context="from core.auth import AuthValidator",
        )

    assert "validate" in result
    # Should be cached now
    assert router.cache_size == 1


async def test_resolve_does_not_route_to_self():
    """Agent should not be routed to itself."""
    router = A2ARouter("/workspace")
    mock_session = MagicMock()
    mock_session.session_id = "session-123"
    router.register_agent("/core", "opencode-1", mock_session)

    with patch.object(router, "_lookup_symbol_tree", return_value=None):
        result = await router.resolve(
            "opencode-1",  # requesting agent IS the owner
            "SomeSymbol",
            context="from core.parser import SomeSymbol",
        )

    assert "not found" in result.lower()


async def test_resolve_agent_session_unavailable():
    """Graceful handling when owning agent's session is not available."""
    router = A2ARouter("/workspace")
    mock_session = MagicMock()
    mock_session.session_id = None  # session not established

    router.register_agent("/core", "opencode-1", mock_session)

    with patch.object(router, "_lookup_symbol_tree", return_value=None):
        result = await router.resolve(
            "claude-code-0",
            "Parser",
            context="from core.parser import Parser",
        )

    assert "not found" in result.lower()


# ---------------------------------------------------------------------------
# Fallback
# ---------------------------------------------------------------------------


async def test_resolve_fallback_no_agents():
    """Graceful fallback when no agents registered and symbol not in tree."""
    router = A2ARouter("/workspace")

    with patch.object(router, "_lookup_symbol_tree", return_value=None):
        result = await router.resolve("agent-0", "UnknownSymbol")

    assert "not found" in result.lower()
    assert "UnknownSymbol" in result


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------


def test_router_clear_cache():
    router = A2ARouter("/workspace")
    router._symbol_cache["test"] = "cached value"
    assert router.cache_size == 1
    router.clear_cache()
    assert router.cache_size == 0


# ---------------------------------------------------------------------------
# Find owner heuristics
# ---------------------------------------------------------------------------


def test_find_owner_from_context():
    router = A2ARouter("/workspace")
    router._region_map = {"/core": "agent-a", "/ui": "agent-b"}

    owner = router._find_owner("Parser", "from core.parser import Parser")
    assert owner == "agent-a"


def test_find_owner_from_context_ui():
    router = A2ARouter("/workspace")
    router._region_map = {"/core": "agent-a", "/ui": "agent-b"}

    owner = router._find_owner("Button", "import { Button } from ui/components")
    assert owner == "agent-b"


def test_find_owner_no_match():
    router = A2ARouter("/workspace")
    router._region_map = {"/core": "agent-a"}

    owner = router._find_owner("Unknown", "no relevant context")
    assert owner is None


# ---------------------------------------------------------------------------
# Format symbol matches
# ---------------------------------------------------------------------------


def test_format_symbol_matches():
    router = A2ARouter("/workspace")
    matches = [
        {
            "kind": "function",
            "name": "foo",
            "path": "src/lib.rs",
            "startLine": 10,
            "endLine": 20,
        },
        {
            "kind": "struct",
            "name": "Bar",
            "path": "src/types.rs",
            "start_line": 5,
            "end_line": 15,
        },
    ]
    result = router._format_symbol_matches(matches)
    assert "function foo" in result
    assert "struct Bar" in result
    assert "src/lib.rs:10-20" in result
    assert "src/types.rs:5-15" in result
