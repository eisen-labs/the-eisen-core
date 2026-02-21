"""Configuration for the orchestration agent."""

from dataclasses import dataclass
from enum import Enum


class EffortLevel(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


MAX_AGENTS = 5


@dataclass
class AgentConfig:
    id: str
    name: str
    command: str
    args: list[str]


# Mirror of extension/src/acp/agents.ts
AGENTS: list[AgentConfig] = [
    AgentConfig("opencode", "OpenCode", "opencode", ["acp"]),
    AgentConfig(
        "claude-code", "Claude Code", "npx", ["@zed-industries/claude-code-acp"]
    ),
    AgentConfig("codex", "Codex CLI", "npx", ["@zed-industries/codex-acp"]),
    AgentConfig("gemini", "Gemini CLI", "gemini", ["--experimental-acp"]),
    AgentConfig("goose", "Goose", "goose", ["acp"]),
    AgentConfig("amp", "Amp", "amp", ["acp"]),
    AgentConfig("aider", "Aider", "aider", ["--acp"]),
]


@dataclass
class OrchestratorConfig:
    workspace: str = "."
    effort: EffortLevel = EffortLevel.MEDIUM
    auto_approve: bool = False
    max_agents: int = MAX_AGENTS
