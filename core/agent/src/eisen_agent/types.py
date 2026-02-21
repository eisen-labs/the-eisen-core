"""Result types for orchestration."""

from dataclasses import dataclass, field


@dataclass
class SubtaskResult:
    subtask_index: int
    description: str
    region: str
    agent_id: str
    status: str  # "completed" | "failed" | "partial"
    agent_output: str
    failure_reason: str | None = None
    suggested_retry: str | None = None
    cost_tokens: int = 0


@dataclass
class OrchestratorResult:
    status: str  # "completed" | "done" (has failures) | "cancelled"
    subtask_results: list[SubtaskResult] = field(default_factory=list)
    total_cost_tokens: int = 0
    orchestrator_cost_tokens: int = 0
