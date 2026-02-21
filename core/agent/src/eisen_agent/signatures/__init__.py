"""DSPy signatures for the orchestration agent."""

from eisen_agent.signatures.assign import AgentSelect
from eisen_agent.signatures.decompose import Subtask, TaskDecompose
from eisen_agent.signatures.evaluate import ProgressEval
from eisen_agent.signatures.prompt import PromptBuild

__all__ = [
    "AgentSelect",
    "ProgressEval",
    "PromptBuild",
    "Subtask",
    "TaskDecompose",
]
