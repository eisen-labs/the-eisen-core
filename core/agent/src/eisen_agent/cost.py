"""Cost tracking for orchestrator and sub-agent token usage.

Phase 3 extension: detailed per-agent, per-subtask, and per-query breakdown
with A2A router savings tracking and USD cost estimation.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CostEntry:
    source: str  # "orchestrator" | "a2a_router" | agent_id
    tokens_used: int
    description: str
    subtask: str = ""  # subtask description, if associated
    region: str = ""  # workspace region, if associated


@dataclass
class A2AStats:
    """Tracks A2A router resolution statistics."""

    symbol_tree_hits: int = 0  # free resolutions via PyO3
    agent_queries: int = 0  # queries that consumed LLM tokens
    agent_query_tokens: int = 0  # total tokens for agent queries
    total_resolutions: int = 0  # total resolution attempts

    @property
    def tokens_saved_estimate(self) -> int:
        """Estimate tokens saved by symbol tree resolutions.

        Each symbol tree hit avoids ~3000 tokens (reading a full file).
        """
        return self.symbol_tree_hits * 3000


# Rough cost per 1M tokens by model family (input tokens).
# These are rough estimates -- actual costs vary by provider and model.
_COST_PER_1M_TOKENS: dict[str, float] = {
    "default": 3.0,  # $3 per 1M tokens (conservative default)
    "claude": 3.0,
    "gpt-4": 10.0,
    "gemini": 1.25,
}


class CostTracker:
    """Accumulates token usage across orchestrator DSPy calls and sub-agent sessions.

    Phase 3 additions:
    - Per-subtask and per-region tracking
    - A2A router savings tracking
    - USD cost estimation
    - Detailed dashboard breakdown
    """

    def __init__(self) -> None:
        self._entries: list[CostEntry] = []
        self._a2a: A2AStats = A2AStats()
        self._agent_usage: dict[str, dict[str, int]] = {}  # agent_id -> {used, size}

    def record(
        self,
        source: str,
        tokens: int,
        description: str,
        subtask: str = "",
        region: str = "",
    ) -> None:
        self._entries.append(CostEntry(source, tokens, description, subtask, region))

    def record_agent_usage(self, agent_id: str, used: int, size: int) -> None:
        """Record raw usage data from an agent's UsageMessage."""
        self._agent_usage[agent_id] = {"used": used, "size": size}

    def record_a2a_symbol_hit(self) -> None:
        """Record a zero-cost A2A symbol tree resolution."""
        self._a2a.symbol_tree_hits += 1
        self._a2a.total_resolutions += 1

    def record_a2a_agent_query(self, tokens: int) -> None:
        """Record an A2A resolution that required an agent query."""
        self._a2a.agent_queries += 1
        self._a2a.agent_query_tokens += tokens
        self._a2a.total_resolutions += 1
        self.record("a2a_router", tokens, "agent-to-agent query")

    @property
    def total_tokens(self) -> int:
        return sum(e.tokens_used for e in self._entries)

    @property
    def orchestrator_tokens(self) -> int:
        return sum(e.tokens_used for e in self._entries if e.source == "orchestrator")

    @property
    def agent_tokens(self) -> int:
        return sum(
            e.tokens_used
            for e in self._entries
            if e.source not in ("orchestrator", "a2a_router")
        )

    @property
    def a2a_stats(self) -> A2AStats:
        return self._a2a

    def breakdown(self) -> dict[str, int]:
        """Per-source token breakdown."""
        result: dict[str, int] = {}
        for e in self._entries:
            result[e.source] = result.get(e.source, 0) + e.tokens_used
        return result

    def detailed_breakdown(self) -> dict:
        """Full breakdown for dashboard rendering (Phase 3)."""
        # Orchestrator breakdown by DSPy call type
        orch_entries: dict[str, int] = {}
        for e in self._entries:
            if e.source == "orchestrator":
                orch_entries[e.description] = (
                    orch_entries.get(e.description, 0) + e.tokens_used
                )

        # Agent breakdown
        agents: dict[str, dict] = {}
        for e in self._entries:
            if e.source not in ("orchestrator", "a2a_router"):
                if e.source not in agents:
                    agents[e.source] = {
                        "subtask": e.subtask or e.description,
                        "region": e.region,
                        "tokens_used": 0,
                        "tokens_size": 0,
                        "cost_usd": 0.0,
                    }
                agents[e.source]["tokens_used"] += e.tokens_used
                # Update from raw usage data if available
                if e.source in self._agent_usage:
                    agents[e.source]["tokens_size"] = self._agent_usage[e.source][
                        "size"
                    ]

        # Estimate USD costs
        for agent_data in agents.values():
            agent_data["cost_usd"] = self._estimate_cost(agent_data["tokens_used"])

        return {
            "orchestrator": {
                **orch_entries,
                "total": self.orchestrator_tokens,
                "cost_usd": self._estimate_cost(self.orchestrator_tokens),
            },
            "agents": agents,
            "a2a_router": {
                "symbol_tree_hits": self._a2a.symbol_tree_hits,
                "agent_queries": self._a2a.agent_queries,
                "agent_query_tokens": self._a2a.agent_query_tokens,
                "total_saved_tokens": self._a2a.tokens_saved_estimate,
            },
            "total_tokens": self.total_tokens,
            "total_cost_usd": self._estimate_cost(self.total_tokens),
        }

    def format_dashboard(self) -> str:
        """Format the cost dashboard as a human-readable table."""
        breakdown = self.detailed_breakdown()
        lines: list[str] = []

        lines.append("Cost Dashboard:")
        lines.append(f"{'Source':<14} {'Subtask':<20} {'Tokens':>8} {'Cost':>8}")
        lines.append("-" * 54)

        # Orchestrator entries
        orch = breakdown["orchestrator"]
        for desc, tokens in orch.items():
            if desc in ("total", "cost_usd"):
                continue
            cost = self._estimate_cost(tokens)
            lines.append(
                f"{'orchestr.':<14} {'(' + desc + ')':<20} {tokens:>8,} ${cost:>6.3f}"
            )

        # Agent entries
        for agent_id, data in breakdown["agents"].items():
            subtask_str = data["subtask"][:18]
            region = data["region"]
            if region:
                subtask_str = f"{subtask_str} ({region})"
            subtask_str = subtask_str[:20]
            lines.append(
                f"{agent_id[:14]:<14} {subtask_str:<20} "
                f"{data['tokens_used']:>8,} ${data['cost_usd']:>6.3f}"
            )

        # A2A router
        a2a = breakdown["a2a_router"]
        if a2a["symbol_tree_hits"] > 0:
            lines.append(
                f"{'A2A router':<14} {'(' + str(a2a['symbol_tree_hits']) + ' sym queries)':<20} "
                f"{'0':>8} ${'0.000':>6}"
            )
        if a2a["agent_queries"] > 0:
            cost = self._estimate_cost(a2a["agent_query_tokens"])
            lines.append(
                f"{'A2A router':<14} {'(' + str(a2a['agent_queries']) + ' agent query)':<20} "
                f"{a2a['agent_query_tokens']:>8,} ${cost:>6.3f}"
            )

        # Total
        lines.append("-" * 54)
        total_cost = breakdown["total_cost_usd"]
        lines.append(
            f"{'TOTAL':<14} {'':<20} {breakdown['total_tokens']:>8,} ${total_cost:>6.3f}"
        )

        # A2A savings
        if a2a["total_saved_tokens"] > 0:
            lines.append(
                f"\nA2A Savings: ~{a2a['total_saved_tokens']:,} tokens saved "
                f"by symbol tree resolution"
            )

        return "\n".join(lines)

    def summary(self) -> str:
        """Human-readable cost summary (backward-compatible with Phase 1)."""
        lines = ["Cost Summary:"]
        lines.append(f"  Orchestrator: {self.orchestrator_tokens:,} tokens")
        for source, tokens in self.breakdown().items():
            if source not in ("orchestrator", "a2a_router"):
                lines.append(f"  {source}: {tokens:,} tokens")
        if self._a2a.total_resolutions > 0:
            lines.append(
                f"  A2A Router: {self._a2a.agent_query_tokens:,} tokens "
                f"({self._a2a.symbol_tree_hits} free, "
                f"{self._a2a.agent_queries} agent queries)"
            )
        lines.append(f"  Total: {self.total_tokens:,} tokens")
        cost = self._estimate_cost(self.total_tokens)
        if cost > 0:
            lines.append(f"  Estimated cost: ${cost:.3f}")
        return "\n".join(lines)

    @staticmethod
    def _estimate_cost(tokens: int, model_family: str = "default") -> float:
        """Estimate USD cost for a given token count."""
        rate = _COST_PER_1M_TOKENS.get(model_family, _COST_PER_1M_TOKENS["default"])
        return (tokens / 1_000_000) * rate
