"""Training and optimization for the orchestration agent (Phase 4).

Includes trace collection for DSPy compilation, agent performance
statistics, and module loading utilities.
"""

from eisen_agent.training.agent_stats import AgentPerformance, AgentStats
from eisen_agent.training.collector import TraceCollector
from eisen_agent.training.compile import (
    compile_agent_select,
    compile_decompose,
    compile_prompt_build,
    load_module,
)

__all__ = [
    "AgentPerformance",
    "AgentStats",
    "TraceCollector",
    "compile_agent_select",
    "compile_decompose",
    "compile_prompt_build",
    "load_module",
]
