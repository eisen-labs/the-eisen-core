"""Task decomposition: user intent --> subtasks with workspace regions."""

from dataclasses import dataclass, field

import dspy


@dataclass
class Subtask:
    description: str
    region: str  # workspace path, e.g. "/ui", "/core/src/parser"
    expected_files: list[str] = field(default_factory=list)
    depends_on: list[int] = field(default_factory=list)


class TaskDecompose(dspy.Signature):
    """Decompose a user's feature request into parallel subtasks,
    each scoped to a workspace region (directory subtree)."""

    user_intent: str = dspy.InputField(
        desc="The user's feature request in natural language"
    )
    workspace_tree: str = dspy.InputField(
        desc="Top-level directory structure of the workspace"
    )
    symbol_index: str = dspy.InputField(
        desc="Key symbols (functions, classes, types) per directory region"
    )

    subtasks: list[dict] = dspy.OutputField(
        desc="List of subtask objects with: description, region, expected_files, depends_on"
    )
    reasoning: str = dspy.OutputField(
        desc="Explanation of why this decomposition makes sense"
    )
