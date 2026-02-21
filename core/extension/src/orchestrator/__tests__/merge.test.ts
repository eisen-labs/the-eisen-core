import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deriveMergedView,
  applyAgentUpdate,
  removeAgentFromNode,
  createMergedNode,
} from "../merge";
import type { AgentFileState, MergedFileNode } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentFileState> = {}): AgentFileState {
  return {
    heat: 1.0,
    inContext: true,
    lastAction: "read",
    timestampMs: 1000,
    turnAccessed: 1,
    ...overrides,
  };
}

function makeAgentsMap(
  entries: Array<[string, Partial<AgentFileState>]>
): Map<string, AgentFileState> {
  const map = new Map<string, AgentFileState>();
  for (const [id, overrides] of entries) {
    map.set(id, makeState(overrides));
  }
  return map;
}

// ---------------------------------------------------------------------------
// deriveMergedView
// ---------------------------------------------------------------------------

describe("deriveMergedView", () => {
  it("single agent returns that agent's state", () => {
    const agents = makeAgentsMap([
      ["agent-a", { heat: 0.7, inContext: true, lastAction: "write", timestampMs: 5000 }],
    ]);
    const view = deriveMergedView(agents);
    assert.equal(view.heat, 0.7);
    assert.equal(view.inContext, true);
    assert.equal(view.lastAction, "write");
    assert.equal(view.lastActionAgentId, "agent-a");
    assert.equal(view.lastActionTimestampMs, 5000);
  });

  it("heat is max across agents", () => {
    const agents = makeAgentsMap([
      ["agent-a", { heat: 0.3 }],
      ["agent-b", { heat: 0.9 }],
      ["agent-c", { heat: 0.5 }],
    ]);
    const view = deriveMergedView(agents);
    assert.equal(view.heat, 0.9);
  });

  it("inContext is OR across agents", () => {
    const agents = makeAgentsMap([
      ["agent-a", { inContext: false }],
      ["agent-b", { inContext: true }],
    ]);
    assert.equal(deriveMergedView(agents).inContext, true);

    const allFalse = makeAgentsMap([
      ["agent-a", { inContext: false }],
      ["agent-b", { inContext: false }],
    ]);
    assert.equal(deriveMergedView(allFalse).inContext, false);

    const allTrue = makeAgentsMap([
      ["agent-a", { inContext: true }],
      ["agent-b", { inContext: true }],
    ]);
    assert.equal(deriveMergedView(allTrue).inContext, true);
  });

  it("lastAction uses LWW — most recent timestamp wins", () => {
    const agents = makeAgentsMap([
      ["agent-a", { lastAction: "read", timestampMs: 1000 }],
      ["agent-b", { lastAction: "write", timestampMs: 2000 }],
    ]);
    const view = deriveMergedView(agents);
    assert.equal(view.lastAction, "write");
    assert.equal(view.lastActionAgentId, "agent-b");
  });

  it("lastAction tiebreak: write > search > read at same timestamp", () => {
    const agents = makeAgentsMap([
      ["agent-a", { lastAction: "read", timestampMs: 1000 }],
      ["agent-b", { lastAction: "write", timestampMs: 1000 }],
    ]);
    assert.equal(deriveMergedView(agents).lastAction, "write");

    const agents2 = makeAgentsMap([
      ["agent-a", { lastAction: "search", timestampMs: 1000 }],
      ["agent-b", { lastAction: "read", timestampMs: 1000 }],
    ]);
    assert.equal(deriveMergedView(agents2).lastAction, "search");

    const agents3 = makeAgentsMap([
      ["agent-a", { lastAction: "write", timestampMs: 1000 }],
      ["agent-b", { lastAction: "search", timestampMs: 1000 }],
    ]);
    assert.equal(deriveMergedView(agents3).lastAction, "write");
  });

  it("empty agents map returns zero/default values", () => {
    const view = deriveMergedView(new Map());
    assert.equal(view.heat, 0);
    assert.equal(view.inContext, false);
    assert.equal(view.lastAction, "read");
    assert.equal(view.lastActionAgentId, "");
    assert.equal(view.lastActionTimestampMs, 0);
  });

  // -------------------------------------------------------------------------
  // CRDT properties
  // -------------------------------------------------------------------------

  it("commutativity: merge(A, B) === merge(B, A)", () => {
    const stateA: AgentFileState = makeState({
      heat: 0.8, inContext: true, lastAction: "read", timestampMs: 1000,
    });
    const stateB: AgentFileState = makeState({
      heat: 0.4, inContext: false, lastAction: "write", timestampMs: 2000,
    });

    const mapAB = new Map<string, AgentFileState>([
      ["agent-a", stateA],
      ["agent-b", stateB],
    ]);
    const mapBA = new Map<string, AgentFileState>([
      ["agent-b", stateB],
      ["agent-a", stateA],
    ]);

    const viewAB = deriveMergedView(mapAB);
    const viewBA = deriveMergedView(mapBA);

    assert.equal(viewAB.heat, viewBA.heat);
    assert.equal(viewAB.inContext, viewBA.inContext);
    assert.equal(viewAB.lastAction, viewBA.lastAction);
    assert.equal(viewAB.lastActionAgentId, viewBA.lastActionAgentId);
    assert.equal(viewAB.lastActionTimestampMs, viewBA.lastActionTimestampMs);
  });

  it("associativity: merge(merge(A, B), C) === merge(A, merge(B, C))", () => {
    const stateA: AgentFileState = makeState({
      heat: 0.3, inContext: false, lastAction: "read", timestampMs: 100,
    });
    const stateB: AgentFileState = makeState({
      heat: 0.9, inContext: true, lastAction: "write", timestampMs: 200,
    });
    const stateC: AgentFileState = makeState({
      heat: 0.5, inContext: false, lastAction: "search", timestampMs: 150,
    });

    // All three together — this is what the orchestrator actually computes
    const mapAll = new Map<string, AgentFileState>([
      ["a", stateA],
      ["b", stateB],
      ["c", stateC],
    ]);
    const viewAll = deriveMergedView(mapAll);

    // Since deriveMergedView is computed from the full map, associativity
    // holds trivially — but let's verify the result is correct
    assert.equal(viewAll.heat, 0.9); // max
    assert.equal(viewAll.inContext, true); // OR
    assert.equal(viewAll.lastAction, "write"); // LWW: ts 200 > 150 > 100
    assert.equal(viewAll.lastActionAgentId, "b");
  });

  it("idempotency: merge(A, A) === A", () => {
    const stateA: AgentFileState = makeState({
      heat: 0.7, inContext: true, lastAction: "write", timestampMs: 5000,
    });

    // Single agent
    const map1 = new Map<string, AgentFileState>([["a", stateA]]);
    const view1 = deriveMergedView(map1);

    // Same agent applied twice (same key overwrites — idempotent)
    const map2 = new Map<string, AgentFileState>([["a", stateA]]);
    map2.set("a", { ...stateA }); // re-set same value
    const view2 = deriveMergedView(map2);

    assert.equal(view1.heat, view2.heat);
    assert.equal(view1.inContext, view2.inContext);
    assert.equal(view1.lastAction, view2.lastAction);
  });
});

// ---------------------------------------------------------------------------
// createMergedNode
// ---------------------------------------------------------------------------

describe("createMergedNode", () => {
  it("creates a node with one agent entry", () => {
    const state = makeState({ heat: 0.8, lastAction: "write", timestampMs: 3000 });
    const node = createMergedNode("/src/api.ts", "agent-a", state);

    assert.equal(node.path, "/src/api.ts");
    assert.equal(node.agents.size, 1);
    assert.equal(node.heat, 0.8);
    assert.equal(node.lastAction, "write");
    assert.equal(node.lastActionAgentId, "agent-a");
  });
});

// ---------------------------------------------------------------------------
// applyAgentUpdate
// ---------------------------------------------------------------------------

describe("applyAgentUpdate", () => {
  it("adds a second agent to an existing node", () => {
    const node = createMergedNode(
      "/src/api.ts",
      "agent-a",
      makeState({ heat: 0.5, inContext: false, lastAction: "read", timestampMs: 1000 })
    );

    applyAgentUpdate(
      node,
      "agent-b",
      makeState({ heat: 1.0, inContext: true, lastAction: "write", timestampMs: 2000 })
    );

    assert.equal(node.agents.size, 2);
    assert.equal(node.heat, 1.0); // max(0.5, 1.0)
    assert.equal(node.inContext, true); // false || true
    assert.equal(node.lastAction, "write"); // LWW: 2000 > 1000
    assert.equal(node.lastActionAgentId, "agent-b");
  });

  it("updates an existing agent's state and recomputes", () => {
    const node = createMergedNode(
      "/src/api.ts",
      "agent-a",
      makeState({ heat: 1.0, lastAction: "write", timestampMs: 1000 })
    );
    applyAgentUpdate(
      node,
      "agent-b",
      makeState({ heat: 0.5, lastAction: "read", timestampMs: 500 })
    );

    // Now agent-a's heat decays and its action changes to "read"
    applyAgentUpdate(
      node,
      "agent-a",
      makeState({ heat: 0.3, inContext: false, lastAction: "read", timestampMs: 1000 })
    );

    assert.equal(node.agents.size, 2);
    assert.equal(node.heat, 0.5); // max(0.3, 0.5) — agent-b is hotter now
    // LWW: agent-a ts=1000 > agent-b ts=500, agent-a's action is now "read"
    assert.equal(node.lastAction, "read");
    assert.equal(node.lastActionAgentId, "agent-a");
  });
});

// ---------------------------------------------------------------------------
// removeAgentFromNode
// ---------------------------------------------------------------------------

describe("removeAgentFromNode", () => {
  it("removes an agent and recomputes — node survives", () => {
    const node = createMergedNode(
      "/src/api.ts",
      "agent-a",
      makeState({ heat: 0.5, inContext: true, lastAction: "read", timestampMs: 1000 })
    );
    applyAgentUpdate(
      node,
      "agent-b",
      makeState({ heat: 0.8, inContext: false, lastAction: "write", timestampMs: 2000 })
    );

    const kept = removeAgentFromNode(node, "agent-a");
    assert.equal(kept, true);
    assert.equal(node.agents.size, 1);
    assert.equal(node.heat, 0.8); // only agent-b remains
    assert.equal(node.inContext, false); // only agent-b: false
    assert.equal(node.lastAction, "write");
    assert.equal(node.lastActionAgentId, "agent-b");
  });

  it("removes last agent — node should be deleted", () => {
    const node = createMergedNode(
      "/src/api.ts",
      "agent-a",
      makeState()
    );

    const kept = removeAgentFromNode(node, "agent-a");
    assert.equal(kept, false);
    assert.equal(node.agents.size, 0);
  });

  it("removing non-existent agent is a no-op", () => {
    const node = createMergedNode(
      "/src/api.ts",
      "agent-a",
      makeState({ heat: 0.7 })
    );

    const kept = removeAgentFromNode(node, "agent-z");
    assert.equal(kept, true);
    assert.equal(node.agents.size, 1);
    assert.equal(node.heat, 0.7);
  });
});

// ---------------------------------------------------------------------------
// Worked example from CRDT.md
// ---------------------------------------------------------------------------

describe("CRDT.md worked example", () => {
  it("follows the full timeline correctly", () => {
    // t=1000ms: Agent A reads /src/api.ts
    const node = createMergedNode(
      "/src/api.ts",
      "opencode-a1b2c3",
      makeState({ heat: 1.0, inContext: true, lastAction: "read", timestampMs: 1000 })
    );
    assert.equal(node.heat, 1.0);
    assert.equal(node.inContext, true);
    assert.equal(node.lastAction, "read");

    // t=1005ms: Agent B writes /src/api.ts
    applyAgentUpdate(node, "claude-code-x9p4n7", makeState({
      heat: 1.0, inContext: true, lastAction: "write", timestampMs: 1005,
    }));
    assert.equal(node.heat, 1.0); // max(1.0, 1.0)
    assert.equal(node.inContext, true); // true || true
    assert.equal(node.lastAction, "write"); // LWW: 1005 > 1000

    // t=1100ms: Agent A's heat decays to 0.9
    applyAgentUpdate(node, "opencode-a1b2c3", makeState({
      heat: 0.9, inContext: true, lastAction: "read", timestampMs: 1000,
    }));
    assert.equal(node.heat, 1.0); // max(0.9, 1.0) — Agent B still hot
    assert.equal(node.inContext, true);
    assert.equal(node.lastAction, "write"); // LWW: Agent B ts=1005 > Agent A ts=1000

    // t=1200ms: Agent A's context evicts /src/api.ts
    applyAgentUpdate(node, "opencode-a1b2c3", makeState({
      heat: 0.85, inContext: false, lastAction: "read", timestampMs: 1000,
    }));
    assert.equal(node.inContext, true); // false || true — Agent B still has it

    // t=1300ms: Agent B also evicts /src/api.ts
    applyAgentUpdate(node, "claude-code-x9p4n7", makeState({
      heat: 0.9, inContext: false, lastAction: "write", timestampMs: 1005,
    }));
    assert.equal(node.inContext, false); // false || false — now truly out
    assert.equal(node.heat, 0.9); // max(0.85, 0.9)

    // t=2000ms: Agent B disconnects
    const kept = removeAgentFromNode(node, "claude-code-x9p4n7");
    assert.equal(kept, true);
    assert.equal(node.agents.size, 1);
    assert.equal(node.lastAction, "read"); // only Agent A remains
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("same file, same millisecond, different actions — write wins", () => {
    const agents = makeAgentsMap([
      ["agent-a", { lastAction: "read", timestampMs: 1000 }],
      ["agent-b", { lastAction: "write", timestampMs: 1000 }],
    ]);
    const view = deriveMergedView(agents);
    assert.equal(view.lastAction, "write");
  });

  it("three agents same ms — write > search > read", () => {
    const agents = makeAgentsMap([
      ["agent-a", { lastAction: "read", timestampMs: 1000 }],
      ["agent-b", { lastAction: "search", timestampMs: 1000 }],
      ["agent-c", { lastAction: "write", timestampMs: 1000 }],
    ]);
    const view = deriveMergedView(agents);
    assert.equal(view.lastAction, "write");
    assert.equal(view.lastActionAgentId, "agent-c");
  });

  it("all agents disconnect from a file — node removal", () => {
    const node = createMergedNode("/src/api.ts", "a", makeState());
    applyAgentUpdate(node, "b", makeState());

    let kept = removeAgentFromNode(node, "a");
    assert.equal(kept, true);
    kept = removeAgentFromNode(node, "b");
    assert.equal(kept, false);
  });

  it("heat zero agents are still tracked", () => {
    const agents = makeAgentsMap([
      ["agent-a", { heat: 0 }],
      ["agent-b", { heat: 0 }],
    ]);
    const view = deriveMergedView(agents);
    assert.equal(view.heat, 0);
  });

  it("convergence: different insertion orders produce same result", () => {
    const stateA = makeState({ heat: 0.3, inContext: false, lastAction: "read", timestampMs: 100 });
    const stateB = makeState({ heat: 0.9, inContext: true, lastAction: "write", timestampMs: 200 });
    const stateC = makeState({ heat: 0.6, inContext: true, lastAction: "search", timestampMs: 150 });

    // Order 1: A, B, C
    const node1 = createMergedNode("/f", "a", stateA);
    applyAgentUpdate(node1, "b", stateB);
    applyAgentUpdate(node1, "c", stateC);

    // Order 2: C, A, B
    const node2 = createMergedNode("/f", "c", stateC);
    applyAgentUpdate(node2, "a", stateA);
    applyAgentUpdate(node2, "b", stateB);

    // Order 3: B, C, A
    const node3 = createMergedNode("/f", "b", stateB);
    applyAgentUpdate(node3, "c", stateC);
    applyAgentUpdate(node3, "a", stateA);

    // All three should converge to the same derived view
    assert.equal(node1.heat, node2.heat);
    assert.equal(node2.heat, node3.heat);
    assert.equal(node1.inContext, node2.inContext);
    assert.equal(node2.inContext, node3.inContext);
    assert.equal(node1.lastAction, node2.lastAction);
    assert.equal(node2.lastAction, node3.lastAction);
    assert.equal(node1.lastActionAgentId, node2.lastActionAgentId);
    assert.equal(node2.lastActionAgentId, node3.lastActionAgentId);

    // Verify actual values
    assert.equal(node1.heat, 0.9);
    assert.equal(node1.inContext, true);
    assert.equal(node1.lastAction, "write");
    assert.equal(node1.lastActionAgentId, "b");
  });
});
