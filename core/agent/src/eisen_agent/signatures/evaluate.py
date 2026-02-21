"""Progress evaluation: agent output --> task status."""

import dspy


class ProgressEval(dspy.Signature):
    """Evaluate whether a sub-agent completed its assigned subtask."""

    subtask_description: str = dspy.InputField()
    agent_output: str = dspy.InputField(desc="The agent's final response/output text")
    files_changed: str = dspy.InputField(
        desc="JSON list of files the agent created or modified"
    )

    status: str = dspy.OutputField(desc="completed | failed | partial")
    failure_reason: str = dspy.OutputField(desc="If failed or partial, explain why")
    suggested_retry: str = dspy.OutputField(
        desc="If failed, suggest an approach for retry"
    )
