# Abstract Agent Processor Class

## Status: Design

## Concept

Each agent type gets its own processor implementation that sits between the raw eisen-core TCP data and the orchestrator's merged state. The processor normalizes, enriches, and filters agent-specific data into a uniform format.

```
eisen-core #1 -> ClaudeCodeProcessor.process()  --\
eisen-core #2 -> OpenCodeProcessor.process()    ---+--> merge --> Graph
eisen-core #3 -> AiderProcessor.process()       --/
```

## Why Per-Agent Processing?

ACP standardizes the protocol, so most data is predictable and uniform. But there are dimensions that ACP doesn't fully capture:

### What ACP gives us (predictable)

- File reads/writes via `fs/read_text_file`, `fs/write_text_file`
- Tool call names and locations
- Session updates with structured content blocks
- Token usage reports
- Terminal operations

This is the 80%. eisen-core already extracts this cleanly, and it looks identical across all agents.

### Where it gets spicy (agent-specific)

- **Tool naming conventions**: Claude Code uses `Read`, `Write`, `Edit`. Aider uses `editor.open`, `editor.write`. Codex might use something else entirely. The tool name affects how we interpret the action semantics.

- **Search patterns**: Some agents emit structured search results with file paths in tool call output. Others dump grep output as plain text. The quality of file path extraction from search results varies by agent.

- **Context management style**: Claude Code aggressively manages its context window (compaction events are common). Aider tends to keep files loaded longer. OpenCode has its own patterns. These affect how the "in_context" inference should be tuned.

- **Multi-step tool chains**: Claude Code often does read -> edit -> read-to-verify as an atomic pattern. Recognizing this as a single "edit operation" rather than three separate accesses produces a cleaner graph. Other agents have different compound patterns.

- **Stderr signals**: Some agents emit progress indicators, warnings, or debug output on stderr that carries useful graph metadata. What's signal vs noise is agent-specific.

- **Non-ACP side channels**: Some agents write to temp files, spawn subprocesses, or use MCP servers in ways that produce file system activity not captured by ACP. A per-agent processor could know to watch for these patterns.

## Interface

```typescript
abstract class AgentProcessor {
  readonly agentType: string;

  /**
   * Process a raw snapshot from this agent's eisen-core.
   * Returns normalized nodes ready for merging.
   */
  abstract processSnapshot(snapshot: RawSnapshot): ProcessedSnapshot;

  /**
   * Process a raw delta from this agent's eisen-core.
   * Returns normalized updates ready for merging.
   */
  abstract processDelta(delta: RawDelta): ProcessedDelta;

  /**
   * Optional: process usage messages if the agent has specific
   * token accounting quirks.
   */
  processUsage(usage: RawUsageMessage): ProcessedUsageMessage {
    return usage; // default: pass through
  }

  /**
   * Optional: custom context window heuristics.
   * Override to adjust how quickly files exit "in_context" state
   * based on agent-specific behavior.
   */
  getContextConfig(): ContextConfig {
    return ContextConfig.default(); // default: standard context_turns=3
  }
}
```

## Implementations

### DefaultProcessor

The baseline. Does no agent-specific transformation. Passes data through with minimal normalization (path cleanup, consistent action naming). Used for any agent that doesn't have a dedicated processor.

```typescript
class DefaultProcessor extends AgentProcessor {
  processSnapshot(snapshot: RawSnapshot): ProcessedSnapshot {
    return normalizeSnapshot(snapshot);
  }

  processDelta(delta: RawDelta): ProcessedDelta {
    return normalizeDelta(delta);
  }
}
```

### ClaudeCodeProcessor

```typescript
class ClaudeCodeProcessor extends AgentProcessor {
  readonly agentType = "claude-code";

  processDelta(delta: RawDelta): ProcessedDelta {
    const normalized = normalizeDelta(delta);

    // Claude Code pattern: Read -> Edit -> Read-to-verify
    // Collapse rapid read-edit-read on same file into a single "edit" action
    return this.collapseEditPatterns(normalized);
  }

  getContextConfig(): ContextConfig {
    // Claude Code compacts aggressively -- shorter context window
    return { contextTurns: 2, compactionThreshold: 0.4 };
  }
}
```

### OpenCodeProcessor

```typescript
class OpenCodeProcessor extends AgentProcessor {
  readonly agentType = "opencode";

  processDelta(delta: RawDelta): ProcessedDelta {
    const normalized = normalizeDelta(delta);
    // OpenCode-specific enrichment
    return normalized;
  }
}
```

### AiderProcessor

```typescript
class AiderProcessor extends AgentProcessor {
  readonly agentType = "aider";

  processDelta(delta: RawDelta): ProcessedDelta {
    const normalized = normalizeDelta(delta);

    // Aider keeps large working sets in context --
    // boost heat retention for files Aider is tracking
    return this.adjustHeatForWorkingSet(normalized);
  }

  getContextConfig(): ContextConfig {
    // Aider holds files longer in context
    return { contextTurns: 5, compactionThreshold: 0.5 };
  }
}
```

## Registration

```typescript
// Processor registry
const PROCESSORS: Record<string, new () => AgentProcessor> = {
  "claude-code": ClaudeCodeProcessor,
  opencode: OpenCodeProcessor,
  aider: AiderProcessor,
};

function getProcessor(agentType: string): AgentProcessor {
  const Ctor = PROCESSORS[agentType];
  return Ctor ? new Ctor() : new DefaultProcessor();
}
```

The orchestrator looks up the processor when an agent connects:

```typescript
class EisenOrchestrator {
  addAgent(instanceId: string, tcpPort: number, agentType: string) {
    const processor = getProcessor(agentType);
    this.processors.set(instanceId, processor);
    this.connectTcp(instanceId, tcpPort);
  }
}
```

## Data Flow Through the Processor

```
1. eisen-core broadcasts delta on TCP:
   { "type": "delta", "agent_id": "claude-code-f8k2m1", "updates": [...] }

2. Orchestrator receives, routes to processor:
   const processor = this.processors.get("claude-code-f8k2m1");
   const processed = processor.processDelta(rawDelta);

3. Orchestrator merges processed data into unified state:
   for (const update of processed.updates) {
     this.mergedState.applyUpdate("claude-code-f8k2m1", update);
   }

4. Orchestrator emits merged delta to graph:
   this.onMergedDelta(mergedDelta);
```

## Second Layer, Not Replacement

The processor operates on **already-extracted graph data** from eisen-core, not raw ACP messages. eisen-core handles the heavy lifting of ACP message parsing and file path extraction. The processor is a lightweight second pass for agent-specific refinement.

```
ACP messages (stdio JSON-RPC)
  |
  v
eisen-core extract.rs  <-- first layer: ACP -> graph data
  |
  v
TCP wire protocol (snapshot/delta/usage)
  |
  v
AgentProcessor.process()  <-- second layer: agent-specific refinement
  |
  v
Orchestrator merged state
```

This layering means:

- eisen-core stays agent-agnostic (it just parses ACP, which is the same for all agents)
- Agent-specific logic lives in TypeScript, close to the UI, easy to iterate on
- Adding a new agent type = add a processor class, no Rust changes needed

## When to Build This

Not now. The abstract class pattern is documented here for when we implement the orchestrator (Phase B). In the meantime:

1. eisen-core handles all ACP extraction uniformly (works well for all agents today)
2. The `agent_id` on the wire (Phase A, already implemented) is the prerequisite
3. When we build the orchestrator, we start with `DefaultProcessor` for all agents
4. We add agent-specific processors as we observe behavioral differences worth encoding

The key insight is that **most of the value comes from just having the orchestrator aggregate N streams**. Per-agent processors are a refinement layer on top of that -- they can be added incrementally as we learn each agent's quirks.
