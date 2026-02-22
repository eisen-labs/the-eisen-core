"""Prompt construction: subtask + context --> guided prompt for sub-agent."""

import dspy


class PromptBuild(dspy.Signature):
    """Build a guided prompt for a coding sub-agent based on effort level.

    The prompt should give the agent enough context to work efficiently
    within its assigned region without scanning the entire codebase."""

    subtask_description: str = dspy.InputField()
    region: str = dspy.InputField(desc="Workspace region path the agent is confined to")
    region_files: str = dspy.InputField(
        desc="JSON list of files in the region with line counts"
    )
    cross_region_deps: str = dspy.InputField(
        desc="JSON list of dependency signatures from outside the region"
    )
    effort_level: str = dspy.InputField(desc="low | medium | high")

    agent_prompt: str = dspy.OutputField(
        desc="The complete prompt to send to the coding agent"
    )
