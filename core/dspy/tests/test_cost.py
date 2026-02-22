"""Tests for cost tracking (Phase 1 + Phase 3 extensions)."""

from eisen_agent.cost import CostEntry, CostTracker


def test_cost_entry():
    e = CostEntry(source="orchestrator", tokens_used=100, description="TaskDecompose")
    assert e.source == "orchestrator"
    assert e.tokens_used == 100


def test_cost_entry_with_subtask():
    e = CostEntry(
        source="claude-code",
        tokens_used=5000,
        description="auth UI",
        subtask="Implement auth UI",
        region="/ui",
    )
    assert e.subtask == "Implement auth UI"
    assert e.region == "/ui"


def test_cost_tracker_empty():
    t = CostTracker()
    assert t.total_tokens == 0
    assert t.orchestrator_tokens == 0
    assert t.agent_tokens == 0


def test_cost_tracker_record():
    t = CostTracker()
    t.record("orchestrator", 100, "TaskDecompose")
    t.record("orchestrator", 50, "PromptBuild")
    t.record("claude-code", 500, "implement auth")
    assert t.total_tokens == 650
    assert t.orchestrator_tokens == 150
    assert t.agent_tokens == 500


def test_cost_tracker_breakdown():
    t = CostTracker()
    t.record("orchestrator", 100, "a")
    t.record("claude-code", 200, "b")
    t.record("opencode", 300, "c")
    t.record("claude-code", 150, "d")

    breakdown = t.breakdown()
    assert breakdown["orchestrator"] == 100
    assert breakdown["claude-code"] == 350
    assert breakdown["opencode"] == 300


def test_cost_tracker_summary():
    t = CostTracker()
    t.record("orchestrator", 100, "a")
    t.record("claude-code", 500, "b")

    summary = t.summary()
    assert "Cost Summary:" in summary
    assert "Orchestrator: 100" in summary
    assert "claude-code: 500" in summary
    assert "Total: 600" in summary


# ---------------------------------------------------------------
# Phase 3: A2A stats
# ---------------------------------------------------------------


def test_a2a_symbol_hit():
    t = CostTracker()
    t.record_a2a_symbol_hit()
    t.record_a2a_symbol_hit()

    stats = t.a2a_stats
    assert stats.symbol_tree_hits == 2
    assert stats.agent_queries == 0
    assert stats.total_resolutions == 2
    assert stats.tokens_saved_estimate == 6000  # 2 * 3000


def test_a2a_agent_query():
    t = CostTracker()
    t.record_a2a_agent_query(200)

    stats = t.a2a_stats
    assert stats.agent_queries == 1
    assert stats.agent_query_tokens == 200
    assert stats.total_resolutions == 1
    # Also recorded as an entry
    assert t.breakdown().get("a2a_router", 0) == 200


def test_a2a_mixed_stats():
    t = CostTracker()
    t.record_a2a_symbol_hit()
    t.record_a2a_symbol_hit()
    t.record_a2a_symbol_hit()
    t.record_a2a_agent_query(150)

    stats = t.a2a_stats
    assert stats.symbol_tree_hits == 3
    assert stats.agent_queries == 1
    assert stats.total_resolutions == 4
    assert stats.tokens_saved_estimate == 9000


def test_a2a_in_summary():
    t = CostTracker()
    t.record_a2a_symbol_hit()
    t.record_a2a_agent_query(200)

    summary = t.summary()
    assert "A2A Router" in summary
    assert "1 free" in summary
    assert "1 agent queries" in summary


# ---------------------------------------------------------------
# Phase 3: Detailed breakdown
# ---------------------------------------------------------------


def test_detailed_breakdown_structure():
    t = CostTracker()
    t.record("orchestrator", 3200, "TaskDecompose")
    t.record("orchestrator", 1800, "PromptBuild")
    t.record("claude-code", 45000, "auth UI", subtask="auth UI", region="/ui")
    t.record("codex", 32000, "auth core", subtask="auth core", region="/core")
    t.record_a2a_symbol_hit()
    t.record_a2a_symbol_hit()
    t.record_a2a_symbol_hit()
    t.record_a2a_agent_query(200)

    bd = t.detailed_breakdown()

    # Orchestrator
    assert "orchestrator" in bd
    assert bd["orchestrator"]["TaskDecompose"] == 3200
    assert bd["orchestrator"]["PromptBuild"] == 1800
    assert bd["orchestrator"]["total"] == 5000
    assert bd["orchestrator"]["cost_usd"] > 0

    # Agents
    assert "agents" in bd
    assert "claude-code" in bd["agents"]
    assert bd["agents"]["claude-code"]["tokens_used"] == 45000
    assert bd["agents"]["claude-code"]["region"] == "/ui"
    assert bd["agents"]["claude-code"]["cost_usd"] > 0

    assert "codex" in bd["agents"]
    assert bd["agents"]["codex"]["tokens_used"] == 32000

    # A2A
    assert "a2a_router" in bd
    assert bd["a2a_router"]["symbol_tree_hits"] == 3
    assert bd["a2a_router"]["agent_queries"] == 1
    assert bd["a2a_router"]["total_saved_tokens"] == 9000

    # Totals
    assert bd["total_tokens"] == 45000 + 32000 + 3200 + 1800 + 200
    assert bd["total_cost_usd"] > 0


def test_agent_usage_tracking():
    t = CostTracker()
    t.record("claude-code", 45000, "auth", subtask="auth", region="/ui")
    t.record_agent_usage("claude-code", 45000, 200000)

    bd = t.detailed_breakdown()
    assert bd["agents"]["claude-code"]["tokens_size"] == 200000


# ---------------------------------------------------------------
# Phase 3: Format dashboard
# ---------------------------------------------------------------


def test_format_dashboard():
    t = CostTracker()
    t.record("orchestrator", 3200, "TaskDecompose")
    t.record("claude-code", 45000, "auth UI", subtask="auth UI", region="/ui")
    t.record_a2a_symbol_hit()

    dashboard = t.format_dashboard()
    assert "Cost Dashboard:" in dashboard
    assert "orchestr." in dashboard
    assert "TOTAL" in dashboard
    assert "A2A Savings:" in dashboard


def test_format_dashboard_empty():
    t = CostTracker()
    dashboard = t.format_dashboard()
    assert "Cost Dashboard:" in dashboard
    assert "TOTAL" in dashboard


# ---------------------------------------------------------------
# Phase 3: USD estimation
# ---------------------------------------------------------------


def test_cost_estimation():
    cost = CostTracker._estimate_cost(1_000_000)
    assert cost == 3.0  # default rate $3/1M

    cost_zero = CostTracker._estimate_cost(0)
    assert cost_zero == 0.0

    cost_small = CostTracker._estimate_cost(100_000)
    assert abs(cost_small - 0.3) < 0.001


def test_a2a_excluded_from_agent_tokens():
    """A2A router tokens should not count as agent tokens."""
    t = CostTracker()
    t.record("claude-code", 1000, "work")
    t.record_a2a_agent_query(200)

    assert t.agent_tokens == 1000  # only claude-code
    assert t.total_tokens == 1200  # both
