"""Tests for the extension communication protocol."""

import json
from unittest.mock import patch

import pytest

from eisen_agent.ext_protocol import _emit, ExtensionProtocol
from eisen_agent.config import EffortLevel, OrchestratorConfig


# ---------------------------------------------------------------------------
# _emit helper
# ---------------------------------------------------------------------------


def test_emit_writes_json_line(capsys):
    _emit({"type": "state", "state": "running"})
    captured = capsys.readouterr()
    line = captured.out.strip()
    msg = json.loads(line)
    assert msg["type"] == "state"
    assert msg["state"] == "running"


def test_emit_multiple_messages(capsys):
    _emit({"type": "state", "state": "decomposing"})
    _emit({"type": "plan", "subtasks": []})
    captured = capsys.readouterr()
    lines = [l for l in captured.out.strip().split("\n") if l]
    assert len(lines) == 2
    msg1 = json.loads(lines[0])
    msg2 = json.loads(lines[1])
    assert msg1["type"] == "state"
    assert msg2["type"] == "plan"


# ---------------------------------------------------------------------------
# Protocol message format
# ---------------------------------------------------------------------------


def test_plan_message_format(capsys):
    """Verify the plan message includes all required fields."""
    _emit(
        {
            "type": "plan",
            "subtasks": [
                {
                    "index": 0,
                    "description": "Implement auth UI",
                    "region": "/ui",
                    "expected_files": ["login.ts"],
                    "depends_on": [],
                }
            ],
            "assignments": [
                {"subtask_index": 0, "agent_id": "claude-code"},
            ],
            "estimated_cost": 15000,
        }
    )
    captured = capsys.readouterr()
    msg = json.loads(captured.out.strip())
    assert msg["type"] == "plan"
    assert len(msg["subtasks"]) == 1
    assert msg["subtasks"][0]["description"] == "Implement auth UI"
    assert len(msg["assignments"]) == 1
    assert msg["estimated_cost"] == 15000


def test_result_message_format(capsys):
    """Verify the result message format."""
    _emit(
        {
            "type": "result",
            "status": "done",
            "subtask_results": [
                {
                    "subtask_index": 0,
                    "description": "Auth UI",
                    "region": "/ui",
                    "agent_id": "claude-code-0",
                    "status": "completed",
                    "failure_reason": None,
                    "suggested_retry": None,
                },
                {
                    "subtask_index": 1,
                    "description": "Auth parser",
                    "region": "/core",
                    "agent_id": "opencode-1",
                    "status": "failed",
                    "failure_reason": "type mismatch",
                    "suggested_retry": "fix the return type",
                },
            ],
            "cost": {"total_tokens": 5000, "orchestrator_tokens": 1000},
        }
    )
    captured = capsys.readouterr()
    msg = json.loads(captured.out.strip())
    assert msg["type"] == "result"
    assert msg["status"] == "done"
    assert len(msg["subtask_results"]) == 2
    assert msg["subtask_results"][0]["status"] == "completed"
    assert msg["subtask_results"][1]["failure_reason"] == "type mismatch"
    assert msg["cost"]["total_tokens"] == 5000


def test_agent_tcp_message_format(capsys):
    """Verify the agent_tcp message includes port and agent type."""
    _emit(
        {
            "type": "agent_tcp",
            "agent_id": "claude-code-0",
            "tcp_port": 54321,
            "agent_type": "claude-code",
        }
    )
    captured = capsys.readouterr()
    msg = json.loads(captured.out.strip())
    assert msg["type"] == "agent_tcp"
    assert msg["agent_id"] == "claude-code-0"
    assert msg["tcp_port"] == 54321
    assert msg["agent_type"] == "claude-code"


def test_progress_message_format(capsys):
    """Verify progress updates include subtask info."""
    _emit(
        {
            "type": "progress",
            "subtask_index": 0,
            "agent_id": "claude-code-0",
            "status": "running",
        }
    )
    captured = capsys.readouterr()
    msg = json.loads(captured.out.strip())
    assert msg["type"] == "progress"
    assert msg["subtask_index"] == 0
    assert msg["status"] == "running"


def test_error_message_format(capsys):
    """Verify error messages."""
    _emit({"type": "error", "message": "Something went wrong"})
    captured = capsys.readouterr()
    msg = json.loads(captured.out.strip())
    assert msg["type"] == "error"
    assert "Something went wrong" in msg["message"]


# ---------------------------------------------------------------------------
# ExtensionProtocol initialization
# ---------------------------------------------------------------------------


def test_extension_protocol_init():
    config = OrchestratorConfig(workspace="/tmp/project")
    protocol = ExtensionProtocol(config)
    assert protocol._config.workspace == "/tmp/project"
    assert protocol._orchestrator is None


# ---------------------------------------------------------------------------
# Command parsing (_read_command)
# ---------------------------------------------------------------------------


def test_read_command_valid(monkeypatch):
    from eisen_agent.ext_protocol import _read_command

    monkeypatch.setattr(
        "sys.stdin", __import__("io").StringIO('{"type": "run", "intent": "test"}\n')
    )
    cmd = _read_command()
    assert cmd is not None
    assert cmd["type"] == "run"
    assert cmd["intent"] == "test"


def test_read_command_invalid_json(monkeypatch):
    from eisen_agent.ext_protocol import _read_command

    monkeypatch.setattr("sys.stdin", __import__("io").StringIO("not json\n"))
    cmd = _read_command()
    assert cmd is None


def test_read_command_empty(monkeypatch):
    from eisen_agent.ext_protocol import _read_command

    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(""))
    cmd = _read_command()
    assert cmd is None
