"""Tests for DSPy signatures."""

import json

import dspy

from eisen_agent.signatures import (
    AgentSelect,
    ProgressEval,
    PromptBuild,
    Subtask,
    TaskDecompose,
)


def test_subtask_dataclass():
    s = Subtask(
        description="Add login page",
        region="/ui/src/views/auth",
        expected_files=["login.ts", "register.ts"],
        depends_on=[0],
    )
    assert s.description == "Add login page"
    assert s.region == "/ui/src/views/auth"
    assert s.expected_files == ["login.ts", "register.ts"]
    assert s.depends_on == [0]


def test_subtask_defaults():
    s = Subtask(description="test", region="/core")
    assert s.expected_files == []
    assert s.depends_on == []


def test_subtask_serialization():
    s = Subtask(
        description="Add parser",
        region="/core/src/parser",
        expected_files=["parser.rs"],
        depends_on=[],
    )
    d = {
        "description": s.description,
        "region": s.region,
        "expected_files": s.expected_files,
        "depends_on": s.depends_on,
    }
    serialized = json.dumps(d)
    loaded = json.loads(serialized)
    assert loaded["description"] == "Add parser"
    assert loaded["region"] == "/core/src/parser"


def test_task_decompose_signature_fields():
    """TaskDecompose has the expected input/output fields."""
    fields = TaskDecompose.model_fields
    input_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "input"
    }
    output_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "output"
    }
    assert "user_intent" in input_names
    assert "workspace_tree" in input_names
    assert "symbol_index" in input_names
    assert "subtasks" in output_names
    assert "reasoning" in output_names


def test_agent_select_signature_fields():
    fields = AgentSelect.model_fields
    input_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "input"
    }
    output_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "output"
    }
    assert "subtask_description" in input_names
    assert "available_agents" in input_names
    assert "agent_id" in output_names


def test_prompt_build_signature_fields():
    fields = PromptBuild.model_fields
    input_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "input"
    }
    output_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "output"
    }
    assert "subtask_description" in input_names
    assert "effort_level" in input_names
    assert "agent_prompt" in output_names


def test_progress_eval_signature_fields():
    fields = ProgressEval.model_fields
    input_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "input"
    }
    output_names = {
        k
        for k, v in fields.items()
        if hasattr(v, "json_schema_extra")
        and v.json_schema_extra
        and v.json_schema_extra.get("__dspy_field_type") == "output"
    }
    assert "subtask_description" in input_names
    assert "agent_output" in input_names
    assert "status" in output_names
    assert "failure_reason" in output_names


def test_predict_wraps_signatures():
    """Each signature can be wrapped with dspy.Predict."""
    p1 = dspy.Predict(TaskDecompose)
    p2 = dspy.Predict(AgentSelect)
    p3 = dspy.Predict(PromptBuild)
    p4 = dspy.Predict(ProgressEval)
    assert p1 is not None
    assert p2 is not None
    assert p3 is not None
    assert p4 is not None


def test_chain_of_thought_wraps_signatures():
    """Each signature can be wrapped with dspy.ChainOfThought."""
    c1 = dspy.ChainOfThought(TaskDecompose)
    c2 = dspy.ChainOfThought(AgentSelect)
    c3 = dspy.ChainOfThought(PromptBuild)
    c4 = dspy.ChainOfThought(ProgressEval)
    assert c1 is not None
    assert c2 is not None
    assert c3 is not None
    assert c4 is not None
