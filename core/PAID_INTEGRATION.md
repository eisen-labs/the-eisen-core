# Paid Integration for Mastra Agents

## Overview
All Mastra agents in the Eisen orchestrator are now wrapped with Paid monitoring for cost tracking and usage billing.

## Implementation

### Files Created
1. **`app/host/src/paid/client.ts`** - PaidClient initialization using `PAID_API_KEY` from environment
2. **`app/host/src/paid/monitor.ts`** - Agent wrapper that tracks agent calls and sends signals to Paid
3. **`app/host/src/paid/index.ts`** - Module exports

### Files Modified
1. **`app/host/src/workflow/agents.ts`** - Updated `createAgents()` to optionally wrap agents with Paid monitoring
2. **`app/host/src/workflow/orchestrate.ts`** - Updated to pass Paid configuration to agent factory
3. **`app/host/src/workflow/region-insights.ts`** - Wrapped region insight agent with monitoring
4. **`app/host/scripts/optimize-prompts.ts`** - Wrapped meta-optimizer agent with monitoring

## How It Works

### Agent Monitoring
Each agent call is now wrapped with Paid's `trace()` function:

```typescript
// Agent execution is automatically traced
const result = await agent.generate(input, options);

// Behind the scenes, this sends a signal to Paid with:
// - Customer ID: workspace path
// - Product ID: "eisen-orchestrator" (or specific product per agent)
// - Event name: task_decompose, agent_select, etc.
// - Metadata: agent ID, duration, success status
```

### Signal Events
Each orchestrator agent sends signals with these event names:
- `task_decompose` - Task decomposition agent
- `agent_select` - Agent selection agent  
- `prompt_build` - Prompt building agent
- `progress_eval` - Progress evaluation agent
- `region_insight` - Region insight generation (background)
- `prompt_optimize` - Prompt optimization script

### Configuration
The integration uses these environment variables:
- `PAID_API_KEY` - Your Paid API key (required)

## Usage

No changes required to existing code. The agents are automatically wrapped when `PAID_API_KEY` is present in the environment.

To disable monitoring, simply remove `PAID_API_KEY` from the environment.

### Manual Initialization

If you need to initialize Paid tracing manually (e.g., in tests or scripts):

```typescript
import { initializePaidTracing } from "./paid";

// Initialize before creating any agents
initializePaidTracing();
```

This is called automatically in `index.ts` after `.env` is loaded.

## Monitoring Dashboard

View usage and costs in the Paid dashboard at https://app.paid.ai/signals

## Architecture

```
User Request
    ↓
Orchestrate Workflow
    ↓
Create Agents (with Paid monitoring)
    ↓
Agent.generate() → Paid.trace() → signal()
    ↓
Paid Platform
```

The wrapper intercepts all `generate()` calls on Mastra agents and:
1. Starts a Paid trace context
2. Executes the original agent call
3. Sends a signal with metadata (duration, success, agent info)
4. Cost tracking is enabled so AI provider costs are automatically attributed

## Graceful Degradation

If `PAID_API_KEY` is not set:
- Agents work normally without monitoring
- No errors are thrown
- A warning is logged: "[Paid] PAID_API_KEY not set. Paid monitoring is disabled."
