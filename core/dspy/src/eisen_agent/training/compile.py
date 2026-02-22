"""DSPy prompt compilation pipeline.

Uses DSPy's optimization (BootstrapFewShot) to improve the quality of
task decomposition, agent selection, and prompt building based on real
execution traces collected from previous runs.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import dspy

from eisen_agent.signatures import AgentSelect, PromptBuild, TaskDecompose
from eisen_agent.training.collector import TraceCollector, TraceEntry

logger = logging.getLogger(__name__)

COMPILED_DIR = Path.home() / ".eisen" / "compiled"


def _traces_to_decompose_examples(traces: list[TraceEntry]) -> list[dspy.Example]:
    """Convert traces into DSPy examples for TaskDecompose compilation."""
    examples: list[dspy.Example] = []
    for trace in traces:
        if not trace.subtasks:
            continue
        ex = dspy.Example(
            user_intent=trace.user_intent,
            workspace_tree=trace.workspace_tree_summary or "(workspace)",
            symbol_index=trace.symbol_index_summary or "(symbols)",
            subtasks=trace.subtasks,
            reasoning=f"Decomposed into {len(trace.subtasks)} subtasks with quality {trace.quality:.2f}",
        ).with_inputs("user_intent", "workspace_tree", "symbol_index")
        examples.append(ex)
    return examples


def _traces_to_agent_select_examples(traces: list[TraceEntry]) -> list[dspy.Example]:
    """Convert traces into DSPy examples for AgentSelect compilation."""
    examples: list[dspy.Example] = []
    for trace in traces:
        for assignment, result in zip(trace.assignments, trace.results):
            if result.get("status") != "completed":
                continue
            ex = dspy.Example(
                subtask_description=result.get("description", ""),
                subtask_region=result.get("region", ""),
                primary_language=assignment.get("language", "unknown"),
                available_agents=json.dumps(assignment.get("available_agents", [])),
                agent_id=assignment.get("agent_id", ""),
                reasoning=f"Agent {assignment.get('agent_id', '')} completed successfully",
            ).with_inputs(
                "subtask_description",
                "subtask_region",
                "primary_language",
                "available_agents",
            )
            examples.append(ex)
    return examples


def _traces_to_prompt_build_examples(traces: list[TraceEntry]) -> list[dspy.Example]:
    """Convert traces into DSPy examples for PromptBuild compilation."""
    examples: list[dspy.Example] = []
    for trace in traces:
        for subtask_dict, result in zip(trace.subtasks, trace.results):
            if result.get("status") != "completed":
                continue
            ex = dspy.Example(
                subtask_description=subtask_dict.get("description", ""),
                region=subtask_dict.get("region", ""),
                region_files=json.dumps(subtask_dict.get("expected_files", [])),
                cross_region_deps="[]",
                effort_level="medium",
                agent_prompt=f"Implement: {subtask_dict.get('description', '')} in {subtask_dict.get('region', '')}",
            ).with_inputs(
                "subtask_description",
                "region",
                "region_files",
                "cross_region_deps",
                "effort_level",
            )
            examples.append(ex)
    return examples


def _quality_metric(example: dspy.Example, prediction: Any, trace: Any = None) -> bool:
    """Basic quality metric: did the prediction produce non-empty output?"""
    if hasattr(prediction, "subtasks"):
        return bool(prediction.subtasks)
    if hasattr(prediction, "agent_id"):
        return bool(prediction.agent_id)
    if hasattr(prediction, "agent_prompt"):
        return bool(prediction.agent_prompt)
    return True


def compile_decompose(traces: list[TraceEntry]) -> dspy.Module | None:
    """Compile TaskDecompose signature against real traces.

    Uses DSPy's BootstrapFewShot to optimize the decomposition prompt
    based on which decompositions led to successful outcomes.
    """
    examples = _traces_to_decompose_examples(traces)
    if len(examples) < 2:
        logger.warning(
            f"Not enough traces for TaskDecompose compilation "
            f"({len(examples)} examples, need >= 2)"
        )
        return None

    logger.info(f"Compiling TaskDecompose with {len(examples)} examples")
    module = dspy.ChainOfThought(TaskDecompose)

    try:
        optimizer = dspy.BootstrapFewShot(
            metric=_quality_metric,
            max_bootstrapped_demos=min(4, len(examples)),
            max_labeled_demos=min(4, len(examples)),
        )
        compiled = optimizer.compile(module, trainset=examples)
        _save_compiled(compiled, "decompose")
        return compiled
    except Exception as e:
        logger.error(f"TaskDecompose compilation failed: {e}")
        return None


def compile_agent_select(traces: list[TraceEntry]) -> dspy.Module | None:
    """Compile AgentSelect based on which agent types succeeded for which task types."""
    examples = _traces_to_agent_select_examples(traces)
    if len(examples) < 2:
        logger.warning(
            f"Not enough traces for AgentSelect compilation "
            f"({len(examples)} examples, need >= 2)"
        )
        return None

    logger.info(f"Compiling AgentSelect with {len(examples)} examples")
    module = dspy.Predict(AgentSelect)

    try:
        optimizer = dspy.BootstrapFewShot(
            metric=_quality_metric,
            max_bootstrapped_demos=min(4, len(examples)),
            max_labeled_demos=min(4, len(examples)),
        )
        compiled = optimizer.compile(module, trainset=examples)
        _save_compiled(compiled, "agent_select")
        return compiled
    except Exception as e:
        logger.error(f"AgentSelect compilation failed: {e}")
        return None


def compile_prompt_build(traces: list[TraceEntry]) -> dspy.Module | None:
    """Compile PromptBuild based on which prompt structures led to agent success."""
    examples = _traces_to_prompt_build_examples(traces)
    if len(examples) < 2:
        logger.warning(
            f"Not enough traces for PromptBuild compilation "
            f"({len(examples)} examples, need >= 2)"
        )
        return None

    logger.info(f"Compiling PromptBuild with {len(examples)} examples")
    module = dspy.Predict(PromptBuild)

    try:
        optimizer = dspy.BootstrapFewShot(
            metric=_quality_metric,
            max_bootstrapped_demos=min(4, len(examples)),
            max_labeled_demos=min(4, len(examples)),
        )
        compiled = optimizer.compile(module, trainset=examples)
        _save_compiled(compiled, "prompt_build")
        return compiled
    except Exception as e:
        logger.error(f"PromptBuild compilation failed: {e}")
        return None


def _save_compiled(module: dspy.Module, name: str) -> Path:
    """Save a compiled DSPy module to ~/.eisen/compiled/."""
    COMPILED_DIR.mkdir(parents=True, exist_ok=True)
    path = COMPILED_DIR / f"{name}.json"
    module.save(str(path))
    logger.info(f"Saved compiled module to {path}")
    return path


def load_module(name: str, fallback: dspy.Module) -> dspy.Module:
    """Load a compiled DSPy module if available, else return the fallback.

    Args:
        name: Module name (e.g. "decompose", "agent_select", "prompt_build")
        fallback: Uncompiled module to use if no compiled version exists

    Returns:
        The compiled module if found, otherwise the fallback.
    """
    compiled_path = COMPILED_DIR / f"{name}.json"
    if compiled_path.exists():
        try:
            fallback.load(str(compiled_path))
            logger.info(f"Loaded compiled module from {compiled_path}")
            return fallback
        except Exception as e:
            logger.warning(
                f"Failed to load compiled module {compiled_path}: {e}. Using fallback."
            )
    return fallback


def run_compilation(min_quality: float = 0.5) -> dict[str, bool]:
    """Run the full compilation pipeline.

    Reads traces from ~/.eisen/traces/, runs DSPy compilation for each
    signature, saves optimized modules to ~/.eisen/compiled/.

    Returns a dict of {module_name: success_bool}.
    """
    collector = TraceCollector()
    traces = collector.load_traces(min_quality=min_quality)

    if not traces:
        logger.warning("No traces available for compilation.")
        return {"decompose": False, "agent_select": False, "prompt_build": False}

    logger.info(f"Running compilation with {len(traces)} traces")

    results: dict[str, bool] = {}
    results["decompose"] = compile_decompose(traces) is not None
    results["agent_select"] = compile_agent_select(traces) is not None
    results["prompt_build"] = compile_prompt_build(traces) is not None

    return results
