"""Agent selection: subtask characteristics --> best agent type."""

import dspy


class AgentSelect(dspy.Signature):
    """Select the best coding agent type for a given subtask based on
    the task characteristics, language, and agent strengths."""

    subtask_description: str = dspy.InputField()
    subtask_region: str = dspy.InputField(desc="Workspace region path")
    primary_language: str = dspy.InputField(desc="Primary language in the region")
    available_agents: str = dspy.InputField(
        desc="JSON list of available agent configs with id and name"
    )

    agent_id: str = dspy.OutputField(desc="Selected agent id (e.g. 'claude-code')")
    reasoning: str = dspy.OutputField()
