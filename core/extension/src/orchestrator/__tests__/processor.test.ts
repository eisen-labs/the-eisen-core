import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DefaultProcessor, getProcessor } from "../processor";
import type { WireDelta, WireSnapshot, WireUsage } from "../types";

// ---------------------------------------------------------------------------
// DefaultProcessor
// ---------------------------------------------------------------------------

describe("DefaultProcessor", () => {
  const processor = new DefaultProcessor("opencode");

  it("has correct agentType", () => {
    assert.equal(processor.agentType, "opencode");
  });

  describe("processSnapshot", () => {
    it("normalizes a wire snapshot", () => {
      const wire: WireSnapshot = {
        type: "snapshot",
        agent_id: "opencode-a1b2c3",
        session_id: "sess_1",
        session_mode: "single_agent",
        seq: 5,
        nodes: {
          "/src/api.ts": {
            path: "/src/api.ts",
            heat: 0.8,
            in_context: true,
            last_action: "write",
            turn_accessed: 3,
            timestamp_ms: 1739228400000,
          },
          "/src/db.ts": {
            path: "/src/db.ts",
            heat: 0.3,
            in_context: false,
            last_action: "read",
            turn_accessed: 1,
            timestamp_ms: 1739228300000,
          },
        },
      };

      const result = processor.processSnapshot(wire);

      assert.equal(result.agentId, "opencode-a1b2c3");
      assert.equal(result.sessionId, "sess_1");
      assert.equal(result.seq, 5);
      assert.equal(result.nodes.size, 2);

      const api = result.nodes.get("/src/api.ts");
      assert.ok(api);
      assert.equal(api.heat, 0.8);
      assert.equal(api.inContext, true);
      assert.equal(api.lastAction, "write");
      assert.equal(api.timestampMs, 1739228400000);
    });

    it("normalizes user_provided to read", () => {
      const wire: WireSnapshot = {
        type: "snapshot",
        agent_id: "test",
        session_id: "s",
        session_mode: "single_agent",
        seq: 1,
        nodes: {
          "/f.ts": {
            path: "/f.ts",
            heat: 1.0,
            in_context: true,
            last_action: "user_provided",
            turn_accessed: 1,
            timestamp_ms: 1000,
          },
        },
      };

      const result = processor.processSnapshot(wire);
      assert.equal(result.nodes.get("/f.ts")?.lastAction, "read");
    });

    it("handles empty nodes", () => {
      const wire: WireSnapshot = {
        type: "snapshot",
        agent_id: "test",
        session_id: "s",
        session_mode: "single_agent",
        seq: 1,
        nodes: {},
      };

      const result = processor.processSnapshot(wire);
      assert.equal(result.nodes.size, 0);
    });
  });

  describe("processDelta", () => {
    it("normalizes a wire delta", () => {
      const wire: WireDelta = {
        type: "delta",
        agent_id: "opencode-a1b2c3",
        session_id: "sess_1",
        session_mode: "single_agent",
        seq: 10,
        updates: [
          {
            path: "/src/api.ts",
            heat: 1.0,
            in_context: true,
            last_action: "write",
            turn_accessed: 5,
            timestamp_ms: 1739228500000,
          },
        ],
        removed: ["/src/old.ts"],
      };

      const result = processor.processDelta(wire);

      assert.equal(result.agentId, "opencode-a1b2c3");
      assert.equal(result.seq, 10);
      assert.equal(result.updates.length, 1);
      assert.equal(result.updates[0].path, "/src/api.ts");
      assert.equal(result.updates[0].lastAction, "write");
      assert.deepEqual(result.removed, ["/src/old.ts"]);
    });

    it("normalizes user_referenced to read", () => {
      const wire: WireDelta = {
        type: "delta",
        agent_id: "test",
        session_id: "s",
        session_mode: "single_agent",
        seq: 1,
        updates: [
          {
            path: "/f.ts",
            heat: 1.0,
            in_context: true,
            last_action: "user_referenced",
            turn_accessed: 1,
            timestamp_ms: 1000,
          },
        ],
        removed: [],
      };

      const result = processor.processDelta(wire);
      assert.equal(result.updates[0].lastAction, "read");
    });
  });

  describe("processUsage", () => {
    it("passes through usage data", () => {
      const wire: WireUsage = {
        type: "usage",
        agent_id: "opencode-a1b2c3",
        session_id: "sess_1",
        session_mode: "single_agent",
        used: 45000,
        size: 200000,
      };

      const result = processor.processUsage(wire);
      assert.equal(result.agentId, "opencode-a1b2c3");
      assert.equal(result.used, 45000);
      assert.equal(result.size, 200000);
      assert.equal(result.cost, undefined);
    });

    it("includes cost when present", () => {
      const wire: WireUsage = {
        type: "usage",
        agent_id: "test",
        session_id: "s",
        session_mode: "single_agent",
        used: 1000,
        size: 5000,
        cost: { amount: 0.05, currency: "USD" },
      };

      const result = processor.processUsage(wire);
      assert.deepEqual(result.cost, { amount: 0.05, currency: "USD" });
    });
  });
});

// ---------------------------------------------------------------------------
// getProcessor registry
// ---------------------------------------------------------------------------

describe("getProcessor", () => {
  it("returns DefaultProcessor for unknown agent types", () => {
    const p = getProcessor("some-new-agent");
    assert.ok(p instanceof DefaultProcessor);
    assert.equal(p.agentType, "some-new-agent");
  });

  it("returns DefaultProcessor for known agents (all use default for now)", () => {
    for (const type of ["opencode", "claude-code", "aider", "codex"]) {
      const p = getProcessor(type);
      assert.ok(p instanceof DefaultProcessor);
      assert.equal(p.agentType, type);
    }
  });
});
