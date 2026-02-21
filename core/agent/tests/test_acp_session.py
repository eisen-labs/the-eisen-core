"""Tests for ACP session management."""

import pytest

from eisen_agent.acp_session import ACPSession, parse_tcp_port_from_stderr
from eisen_agent.agent_registry import (
    get_agent,
    get_available_agents,
    resolve_agent_name,
)
from eisen_agent.config import AgentConfig


@pytest.fixture(autouse=True)
def mock_eisen_core(monkeypatch):
    """Mock _find_eisen_core_binary to return a fake path for tests."""
    monkeypatch.setattr(
        "eisen_agent.acp_session._find_eisen_core_binary",
        lambda: "/usr/local/bin/eisen-core",
    )


# ---------------------------------------------------------------------------
# TCP port parsing
# ---------------------------------------------------------------------------


def test_parse_tcp_port_from_stderr_valid():
    assert parse_tcp_port_from_stderr("eisen-core tcp port: 12345") == 12345


def test_parse_tcp_port_from_stderr_with_prefix():
    assert parse_tcp_port_from_stderr("some prefix eisen-core tcp port: 54321") == 54321


def test_parse_tcp_port_from_stderr_no_match():
    assert parse_tcp_port_from_stderr("random log line") is None


def test_parse_tcp_port_from_stderr_port_zero():
    assert parse_tcp_port_from_stderr("eisen-core tcp port: 0") == 0


def test_parse_tcp_port_from_stderr_extra_spaces():
    assert parse_tcp_port_from_stderr("eisen-core tcp port:   17320") == 17320


# ---------------------------------------------------------------------------
# Spawn command construction
# ---------------------------------------------------------------------------


def test_build_spawn_command():
    config = AgentConfig(
        id="claude-code",
        name="Claude Code",
        command="npx",
        args=["@zed-industries/claude-code-acp"],
    )
    session = ACPSession(config, workspace="/tmp/test", agent_id="agent-1")

    cmd = session.build_spawn_command()
    # Command should be: eisen-core observe --port 0 --agent-id agent-1 -- npx @zed-industries/claude-code-acp
    assert cmd[0].endswith("eisen-core") or "eisen-core" in cmd[0]
    assert "observe" in cmd
    assert "--port" in cmd
    assert "0" in cmd
    assert "--agent-id" in cmd
    assert "agent-1" in cmd
    assert "--" in cmd
    # After "--", the agent command and args
    separator_idx = cmd.index("--")
    assert cmd[separator_idx + 1] == "npx"
    assert cmd[separator_idx + 2] == "@zed-industries/claude-code-acp"


def test_build_spawn_command_simple_agent():
    config = AgentConfig(
        id="opencode",
        name="OpenCode",
        command="opencode",
        args=["acp"],
    )
    session = ACPSession(config, workspace=".", agent_id="oc-1")
    cmd = session.build_spawn_command()
    separator_idx = cmd.index("--")
    assert cmd[separator_idx + 1] == "opencode"
    assert cmd[separator_idx + 2] == "acp"


# ---------------------------------------------------------------------------
# Agent registry
# ---------------------------------------------------------------------------


def test_get_agent_by_id():
    agent = get_agent("claude-code")
    assert agent is not None
    assert agent.name == "Claude Code"


def test_get_agent_unknown():
    assert get_agent("nonexistent") is None


def test_resolve_agent_name_short():
    assert resolve_agent_name("claude") == "claude-code"
    assert resolve_agent_name("Claude") == "claude-code"


def test_resolve_agent_name_full():
    assert resolve_agent_name("opencode") == "opencode"
    assert resolve_agent_name("codex") == "codex"


def test_resolve_agent_name_unknown():
    assert resolve_agent_name("unknown_agent_xyz") is None


def test_get_available_agents_returns_list():
    # May be empty if no agents installed, but should always return a list
    result = get_available_agents()
    assert isinstance(result, list)


# ---------------------------------------------------------------------------
# Session properties
# ---------------------------------------------------------------------------


def test_session_initial_state():
    config = AgentConfig(id="test", name="Test", command="echo", args=[])
    session = ACPSession(config, workspace="/tmp", agent_id="test-1")
    assert session.tcp_port is None
    assert session.session_id is None


# ---------------------------------------------------------------------------
# Phase 3: Zone patterns in spawn command
# ---------------------------------------------------------------------------


def test_build_spawn_command_with_zone_patterns():
    config = AgentConfig(
        id="claude-code",
        name="Claude Code",
        command="npx",
        args=["@zed-industries/claude-code-acp"],
    )
    session = ACPSession(config, workspace="/tmp", agent_id="agent-0")
    cmd = session.build_spawn_command(zone_patterns=["src/ui/**", "shared/**"])

    assert "--zone" in cmd
    # Should have two --zone flags
    zone_indices = [i for i, x in enumerate(cmd) if x == "--zone"]
    assert len(zone_indices) == 2
    assert cmd[zone_indices[0] + 1] == "src/ui/**"
    assert cmd[zone_indices[1] + 1] == "shared/**"

    # Zones should come before "--"
    separator_idx = cmd.index("--")
    for zi in zone_indices:
        assert zi < separator_idx


def test_build_spawn_command_with_deny_patterns():
    config = AgentConfig(
        id="opencode",
        name="OpenCode",
        command="opencode",
        args=["acp"],
    )
    session = ACPSession(config, workspace="/tmp", agent_id="agent-0")
    cmd = session.build_spawn_command(
        zone_patterns=["src/**"],
        deny_patterns=["**/.env"],
    )

    assert "--zone" in cmd
    assert "--deny" in cmd
    deny_idx = cmd.index("--deny")
    assert cmd[deny_idx + 1] == "**/.env"


def test_build_spawn_command_no_zones():
    """Without zones, command should be the same as before Phase 3."""
    config = AgentConfig(
        id="opencode",
        name="OpenCode",
        command="opencode",
        args=["acp"],
    )
    session = ACPSession(config, workspace="/tmp", agent_id="agent-0")
    cmd = session.build_spawn_command()

    assert "--zone" not in cmd
    assert "--deny" not in cmd


def test_build_spawn_command_zone_preserves_agent_args():
    """Zone flags should not interfere with agent command after '--'."""
    config = AgentConfig(
        id="gemini",
        name="Gemini CLI",
        command="gemini",
        args=["--experimental-acp"],
    )
    session = ACPSession(config, workspace="/tmp", agent_id="gem-0")
    cmd = session.build_spawn_command(zone_patterns=["src/**"])

    separator_idx = cmd.index("--")
    assert cmd[separator_idx + 1] == "gemini"
    assert cmd[separator_idx + 2] == "--experimental-acp"
