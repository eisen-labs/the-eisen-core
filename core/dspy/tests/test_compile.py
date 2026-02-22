"""Tests for DSPy compilation pipeline (Phase 4A)."""

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from eisen_agent.training.collector import TraceEntry
from eisen_agent.training.compile import (
    _quality_metric,
    _traces_to_agent_select_examples,
    _traces_to_decompose_examples,
    _traces_to_prompt_build_examples,
    load_module,
    run_compilation,
)


def _make_trace(
    run_id: str = "t1",
    quality: float = 0.9,
    num_subtasks: int = 2,
) -> TraceEntry:
    subtasks = [
        {
            "description": f"subtask-{i}",
            "region": f"/region-{i}",
            "expected_files": [f"file-{i}.ts"],
            "depends_on": [],
        }
        for i in range(num_subtasks)
    ]
    assignments = [
        {
            "agent_id": "claude-code",
            "subtask_index": i,
            "language": "typescript",
            "available_agents": [{"id": "claude-code", "name": "Claude Code"}],
        }
        for i in range(num_subtasks)
    ]
    results = [
        {
            "subtask_index": i,
            "description": f"subtask-{i}",
            "region": f"/region-{i}",
            "agent_id": "claude-code",
            "status": "completed",
            "failure_reason": None,
            "cost_tokens": 100,
        }
        for i in range(num_subtasks)
    ]
    return TraceEntry(
        run_id=run_id,
        timestamp=1000.0,
        user_intent="implement feature",
        workspace="/project",
        workspace_tree_summary="root/\n  ui/\n  core/",
        symbol_index_summary="ui/main.ts\n  function: render",
        subtasks=subtasks,
        assignments=assignments,
        results=results,
        quality=quality,
    )


def test_traces_to_decompose_examples():
    traces = [_make_trace("t1"), _make_trace("t2")]
    examples = _traces_to_decompose_examples(traces)
    assert len(examples) == 2
    # Check example has the right input fields
    assert hasattr(examples[0], "user_intent")
    assert hasattr(examples[0], "workspace_tree")


def test_traces_to_decompose_examples_skips_empty():
    trace = _make_trace()
    trace.subtasks = []
    examples = _traces_to_decompose_examples([trace])
    assert len(examples) == 0


def test_traces_to_agent_select_examples():
    traces = [_make_trace()]
    examples = _traces_to_agent_select_examples(traces)
    assert len(examples) == 2  # 2 completed subtasks
    assert hasattr(examples[0], "subtask_description")
    assert hasattr(examples[0], "agent_id")


def test_traces_to_agent_select_skips_failed():
    trace = _make_trace()
    trace.results[0]["status"] = "failed"
    examples = _traces_to_agent_select_examples([trace])
    assert len(examples) == 1  # Only the completed one


def test_traces_to_prompt_build_examples():
    traces = [_make_trace()]
    examples = _traces_to_prompt_build_examples(traces)
    assert len(examples) == 2
    assert hasattr(examples[0], "subtask_description")
    assert hasattr(examples[0], "agent_prompt")


def test_quality_metric_with_subtasks():
    prediction = MagicMock()
    prediction.subtasks = [{"description": "task"}]
    assert _quality_metric(None, prediction) is True

    prediction.subtasks = []
    assert _quality_metric(None, prediction) is False


def test_quality_metric_with_agent_id():
    prediction = MagicMock(spec=[])
    prediction.agent_id = "claude-code"
    assert _quality_metric(None, prediction) is True


def test_quality_metric_with_prompt():
    prediction = MagicMock(spec=[])
    prediction.agent_prompt = "Do the thing"
    assert _quality_metric(None, prediction) is True


def test_load_module_no_compiled(tmp_path):
    """When no compiled module exists, return the fallback."""
    import dspy
    from eisen_agent.training.compile import COMPILED_DIR

    fallback = MagicMock()
    # Patch COMPILED_DIR to a temp path with no files
    with patch("eisen_agent.training.compile.COMPILED_DIR", tmp_path / "compiled"):
        result = load_module("nonexistent", fallback)
    assert result is fallback


def test_load_module_with_compiled(tmp_path):
    """When a compiled module exists but fails to load, return fallback."""
    import dspy

    compiled_dir = tmp_path / "compiled"
    compiled_dir.mkdir()
    # Write a dummy file that will fail to load
    (compiled_dir / "decompose.json").write_text("{}")

    fallback = MagicMock()
    fallback.load.side_effect = Exception("bad format")

    with patch("eisen_agent.training.compile.COMPILED_DIR", compiled_dir):
        result = load_module("decompose", fallback)
    assert result is fallback
    fallback.load.assert_called_once()


def test_run_compilation_no_traces(tmp_path):
    """Compilation with no traces should return all False."""
    with patch("eisen_agent.training.compile.TraceCollector") as MockCollector:
        instance = MockCollector.return_value
        instance.load_traces.return_value = []
        results = run_compilation()
    assert results == {"decompose": False, "agent_select": False, "prompt_build": False}
