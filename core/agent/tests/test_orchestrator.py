"""Tests for the orchestration loop."""

import pytest

from eisen_agent.orchestrator import (
    AgentAssignment,
    Orchestrator,
    _build_execution_batches,
    parse_user_overrides,
)
from eisen_agent.types import OrchestratorResult, SubtaskResult
from eisen_agent.config import EffortLevel, OrchestratorConfig
from eisen_agent.lifecycle import SubtaskLifecycle, TaskState
from eisen_agent.signatures import Subtask


# ---------------------------------------------------------------------------
# User override parsing
# ---------------------------------------------------------------------------


def test_parse_override_use_for():
    overrides = parse_user_overrides("use claude for /ui")
    assert overrides == {"/ui": "claude-code"}


def test_parse_override_at_sign():
    overrides = parse_user_overrides("@opencode /core")
    assert overrides == {"/core": "opencode"}


def test_parse_override_assign_to():
    overrides = parse_user_overrides("assign codex to /lib")
    assert overrides == {"/lib": "codex"}


def test_parse_override_multiple():
    text = "use claude for /ui and assign opencode to /core"
    overrides = parse_user_overrides(text)
    assert overrides["/ui"] == "claude-code"
    assert overrides["/core"] == "opencode"


def test_parse_override_case_insensitive():
    overrides = parse_user_overrides("Use Claude for /ui")
    assert overrides == {"/ui": "claude-code"}


def test_parse_override_no_match():
    overrides = parse_user_overrides("implement a feature in the login page")
    assert overrides == {}


def test_parse_override_unknown_agent():
    # Unknown agent name should not be included
    overrides = parse_user_overrides("use unknowntool for /lib")
    assert overrides == {}


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


def test_subtask_result():
    r = SubtaskResult(
        subtask_index=0,
        description="Add auth",
        region="/ui",
        agent_id="claude-code",
        status="completed",
        agent_output="Done!",
    )
    assert r.failure_reason is None
    assert r.cost_tokens == 0


def test_orchestrator_result_defaults():
    r = OrchestratorResult(status="completed")
    assert r.subtask_results == []
    assert r.total_cost_tokens == 0


def test_orchestrator_result_with_subtasks():
    r = OrchestratorResult(
        status="done",
        subtask_results=[
            SubtaskResult(
                subtask_index=0,
                description="a",
                region="/a",
                agent_id="x",
                status="completed",
                agent_output="ok",
            ),
            SubtaskResult(
                subtask_index=1,
                description="b",
                region="/b",
                agent_id="y",
                status="failed",
                agent_output="err",
                failure_reason="test failure",
            ),
        ],
    )
    assert len(r.subtask_results) == 2
    assert r.subtask_results[1].failure_reason == "test failure"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def test_orchestrator_config_defaults():
    config = OrchestratorConfig()
    assert config.workspace == "."
    assert config.effort == EffortLevel.MEDIUM
    assert config.auto_approve is False
    assert config.max_agents == 5


def test_orchestrator_config_custom():
    config = OrchestratorConfig(
        workspace="/tmp/project",
        effort=EffortLevel.HIGH,
        auto_approve=True,
        max_agents=3,
    )
    assert config.workspace == "/tmp/project"
    assert config.effort == EffortLevel.HIGH
    assert config.auto_approve is True
    assert config.max_agents == 3


# ---------------------------------------------------------------------------
# Context builder (basic tests)
# ---------------------------------------------------------------------------


def test_context_builder_low_effort():
    from eisen_agent.context_builder import ContextBuilder

    builder = ContextBuilder(".")
    ctx = builder.build_region_context("/core", EffortLevel.LOW)
    assert ctx["region_files"] == []
    assert ctx["cross_region_deps"] == []
    assert ctx["step_plan"] is None


def test_context_builder_workspace_tree():
    from eisen_agent.context_builder import ContextBuilder

    builder = ContextBuilder(".")
    tree = builder.get_workspace_tree()
    assert isinstance(tree, str)
    assert len(tree) > 0


def test_context_builder_symbol_index():
    from eisen_agent.context_builder import ContextBuilder

    builder = ContextBuilder(".")
    index = builder.get_symbol_index()
    assert isinstance(index, str)
    assert len(index) > 0


# ---------------------------------------------------------------------------
# Orchestrator state (Phase 2)
# ---------------------------------------------------------------------------


def test_orchestrator_initial_state():
    config = OrchestratorConfig()
    orch = Orchestrator(config)
    assert orch.state == TaskState.IDLE
    assert orch.active_sessions == {}
    assert orch.region_map == {}


def test_orchestrator_state_change_callback():
    config = OrchestratorConfig()
    orch = Orchestrator(config)
    transitions: list[tuple] = []
    orch.on_state_change(lambda old, new: transitions.append((old, new)))
    # Manually trigger a lifecycle transition (normally done via run())
    orch._lifecycle.transition(TaskState.DECOMPOSING)
    assert len(transitions) == 1
    assert transitions[0] == (TaskState.IDLE, TaskState.DECOMPOSING)


# ---------------------------------------------------------------------------
# Execution batching (Phase 2)
# ---------------------------------------------------------------------------


def _make_assignment(
    index: int, depends_on: list[int] | None = None
) -> AgentAssignment:
    """Helper to create a test AgentAssignment."""
    return AgentAssignment(
        subtask=Subtask(
            description=f"task-{index}",
            region=f"/region-{index}",
            expected_files=[],
            depends_on=depends_on or [],
        ),
        subtask_index=index,
        agent_id=f"agent-{index}",
        lifecycle=SubtaskLifecycle(index, f"task-{index}"),
    )


def test_build_batches_empty():
    batches = _build_execution_batches([])
    assert batches == []


def test_build_batches_no_dependencies():
    """All subtasks in one batch when no dependencies."""
    assignments = [_make_assignment(0), _make_assignment(1), _make_assignment(2)]
    batches = _build_execution_batches(assignments)
    assert len(batches) == 1
    assert len(batches[0]) == 3


def test_build_batches_linear_chain():
    """A -> B -> C: three batches."""
    assignments = [
        _make_assignment(0),
        _make_assignment(1, depends_on=[0]),
        _make_assignment(2, depends_on=[1]),
    ]
    batches = _build_execution_batches(assignments)
    assert len(batches) == 3
    assert batches[0][0].subtask_index == 0
    assert batches[1][0].subtask_index == 1
    assert batches[2][0].subtask_index == 2


def test_build_batches_diamond():
    """Diamond dependency: A -> B, A -> C, B+C -> D."""
    assignments = [
        _make_assignment(0),
        _make_assignment(1, depends_on=[0]),
        _make_assignment(2, depends_on=[0]),
        _make_assignment(3, depends_on=[1, 2]),
    ]
    batches = _build_execution_batches(assignments)
    assert len(batches) == 3
    # Batch 0: task 0
    assert len(batches[0]) == 1
    assert batches[0][0].subtask_index == 0
    # Batch 1: tasks 1 and 2 (can run in parallel)
    assert len(batches[1]) == 2
    indices_batch1 = {a.subtask_index for a in batches[1]}
    assert indices_batch1 == {1, 2}
    # Batch 2: task 3
    assert len(batches[1 + 1]) == 1
    assert batches[2][0].subtask_index == 3


def test_build_batches_mixed():
    """Mix of independent and dependent tasks."""
    assignments = [
        _make_assignment(0),  # independent
        _make_assignment(1),  # independent
        _make_assignment(2, depends_on=[0]),  # depends on 0
    ]
    batches = _build_execution_batches(assignments)
    assert len(batches) == 2
    # Batch 0: tasks 0 and 1 (both independent)
    indices_batch0 = {a.subtask_index for a in batches[0]}
    assert indices_batch0 == {0, 1}
    # Batch 1: task 2
    assert batches[1][0].subtask_index == 2


def test_build_batches_circular_dependency():
    """Circular dependencies should not hang -- cycle is broken."""
    assignments = [
        _make_assignment(0, depends_on=[1]),
        _make_assignment(1, depends_on=[0]),
    ]
    # Should not hang or raise
    batches = _build_execution_batches(assignments)
    assert len(batches) >= 1
    # Both tasks should be present somewhere
    all_indices = {a.subtask_index for batch in batches for a in batch}
    assert all_indices == {0, 1}
