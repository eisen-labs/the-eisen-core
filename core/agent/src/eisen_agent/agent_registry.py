"""Agent availability checking (mirrors extension/src/acp/agents.ts)."""

import shutil

from eisen_agent.config import AGENTS, AgentConfig

# Map common short names to agent IDs for user override resolution.
_AGENT_ALIASES: dict[str, str] = {
    "claude": "claude-code",
    "claude-code": "claude-code",
    "opencode": "opencode",
    "codex": "codex",
    "gemini": "gemini",
    "goose": "goose",
    "amp": "amp",
    "aider": "aider",
}


def get_available_agents() -> list[AgentConfig]:
    """Return agents whose commands are found on PATH."""
    return [a for a in AGENTS if shutil.which(a.command) is not None]


def get_agent(agent_id: str) -> AgentConfig | None:
    """Look up an agent by ID."""
    return next((a for a in AGENTS if a.id == agent_id), None)


def is_agent_available(agent_id: str) -> bool:
    agent = get_agent(agent_id)
    return agent is not None and shutil.which(agent.command) is not None


def resolve_agent_name(name: str) -> str | None:
    """Resolve a potentially short/fuzzy agent name to a canonical agent ID.

    Returns None if the name doesn't match any known agent.
    """
    lower = name.lower().strip()
    return _AGENT_ALIASES.get(lower)
