# Multi-Agent Graph UI

## Status: Design (orchestrator data flow implemented, webview UI pending)

## Vision

The graph shows all active agents simultaneously. Each agent's activity is visually distinct -- colored by agent, toggleable via a legend panel. The user can see the full picture (all agents merged) or isolate a single agent's view.

```
+-----------------------------------------------+
|                                                |
|         [force-directed graph canvas]          |
|                                                |
|    o  o      o                                 |
|     \/ \    / \                                |
|     o   o--o   o                               |
|    / \       \                                 |
|   o   o       o                                |
|                                                |
|                                                |
|                                                |
| +----------------------------+                 |
| | claude_1    * connected    |  [funnel] [layers]
| | opencode_1  * connected    |                 |
| | aider_1       disconnected |                 |
| | [ Show All ]               |                 |
| +----------------------------+                 |
+-----------------------------------------------+
```

## Agent Naming Convention

Each agent instance gets a display name: `{agent_type}_{n}` where `n` is a sequential counter per agent type within the session.

| Wire `agent_id` (instanceId) | Display Name |
|-------------------------------|-------------|
| `claude-code-f8k2m1` | `claude_1` |
| `opencode-a1b2c3` | `opencode_1` |
| `claude-code-x9p4n7` | `claude_2` |
| `aider-m3n4o5` | `aider_1` |

The orchestrator maintains a counter per agent type and assigns the display name when `addAgent()` is called. The display name is included in merged snapshots/deltas sent to the graph so the UI never needs to parse instance IDs.

## Agent Color Palette

Each agent gets assigned a color from a fixed palette. Colors are chosen to be distinct on the dark `#141414` background and not conflict with existing semantic colors (green=in-context, amber=write, blue=selected, purple=caller).

| Slot | Color | Hex | Use Case |
|------|-------|-----|----------|
| 0 | Cyan | `#22d3ee` | First agent |
| 1 | Rose | `#fb7185` | Second agent |
| 2 | Violet | `#a78bfa` | Third agent |
| 3 | Amber | `#fbbf24` | Fourth agent |
| 4 | Emerald | `#34d399` | Fifth agent |
| 5 | Sky | `#38bdf8` | Sixth agent |
| 6 | Pink | `#f472b6` | Seventh agent |

Colors are assigned in order of agent connection. If an agent disconnects, its color slot is not recycled within the session (to avoid confusion if nodes from that agent are still fading).

## Legend Panel

### Position & Layout

Bottom-left corner of the graph canvas, overlaid on top of the force-graph. Semi-transparent dark background (`rgba(20, 20, 20, 0.85)`) with a subtle border (`rgba(255,255,255,0.1)`). Rounded corners (`6px`).

```
+----------------------------+
|  claude_1    * connected   |
|  opencode_1  * connected   |
|  aider_1       disconnected|
|  [ Show All ]              |
+----------------------------+
```

### Row Structure

Each agent row contains:

```
[color dot] [display_name] [status indicator] [toggle area]
```

- **Color dot**: 8px filled circle in the agent's assigned color
- **Display name**: `claude_1`, `opencode_1`, etc. Monospace, `11px`, `#e5e7eb`
- **Status indicator**: Small circle -- filled green for connected, hollow gray for disconnected
- **Toggle area**: Entire row is clickable. Clicking toggles that agent's visibility

### Interaction

| Action | Result |
|--------|--------|
| Click agent row | Toggle that agent solo/off. If one agent is solo'd, clicking another switches to that one. Clicking the solo'd agent returns to "show all." |
| Click "Show All" | Reset to showing all agents (default state) |
| Hover agent row | Briefly highlight that agent's nodes on the graph (brighter stroke, 200ms transition) |

### Filter States

The legend drives a `visibleAgents: Set<string>` filter on the graph. Three logical states:

1. **All visible** (default): `visibleAgents` contains all connected agent IDs. "Show All" button is dimmed/hidden.
2. **Solo mode**: `visibleAgents` contains exactly one agent ID. Only that agent's nodes appear active. Other agents' nodes are dimmed to `alpha 0.08` (nearly invisible but still occupying space in the force layout). "Show All" button is prominent.
3. **Agent hidden**: Possible future extension. For now, toggling cycles between solo and all.

## Node Rendering Changes

### Agent Attribution on Nodes

Each node in the merged state carries `agents: Map<string, AgentFileState>` (from CRDT.md). The UI uses this for visual attribution.

### Single-Agent Node

When a file is touched by exactly one agent, the node gets a colored **ring** (2px stroke) in that agent's color, drawn outside the existing node circle. This replaces the current white default stroke for active nodes.

```
Canvas rendering (nodeCanvasObject):

1. Draw filled circle (existing: file color based on extension)
2. Draw agent ring: arc(0, 2*PI) with agent color, lineWidth=2
3. Draw overlay (existing: green for in-context, amber for write)
4. Draw selection/caller stroke if applicable (existing, on top)
```

### Multi-Agent Node

When a file is touched by 2+ agents, the ring is split into **arc segments** proportional to each agent's heat contribution. This creates a pie-chart-like border.

```
Example: claude_1 (heat 0.8) + opencode_1 (heat 0.4)
  Total heat = 1.2
  claude_1 arc:   0.8/1.2 = 66.7% of ring = 0 to 4.19 radians
  opencode_1 arc: 0.4/1.2 = 33.3% of ring = 4.19 to 6.28 radians

Canvas rendering:
  for each agent in node.agents:
    ctx.beginPath()
    ctx.arc(x, y, radius + 2, startAngle, endAngle)
    ctx.strokeStyle = agentColor
    ctx.lineWidth = 2.5
    ctx.stroke()
```

### Dimmed Nodes (Solo Mode)

When filtering to a single agent, nodes not touched by that agent are rendered at `alpha 0.08`. Nodes touched by the solo'd agent but also by others show only the solo'd agent's arc segment at full opacity; other segments dim to `alpha 0.15`.

## Data Flow: Orchestrator -> Graph

### New Message Fields

The orchestrator's merged snapshot/delta messages to the graph include agent attribution:

```typescript
// Merged snapshot sent to graph webview
interface MergedGraphSnapshot {
  seq: number;
  nodes: Record<string, MergedGraphNode>;
  calls: Array<{ from: string; to: string }>;
  agents: AgentInfo[];  // <-- NEW: list of all known agents
}

interface MergedGraphNode {
  // Existing fields
  inContext: boolean;
  changed: boolean;
  lastAction: "read" | "write" | "search";

  // New: per-agent attribution
  agentHeat: Record<string, number>;    // { "claude_1": 0.8, "opencode_1": 0.4 }
  agentContext: Record<string, boolean>; // { "claude_1": true, "opencode_1": false }
}

interface AgentInfo {
  instanceId: string;     // "claude-code-f8k2m1"
  displayName: string;    // "claude_1"
  agentType: string;      // "claude-code"
  color: string;          // "#22d3ee"
  connected: boolean;     // true
}
```

### Delta Messages

Deltas carry the same `agentHeat`/`agentContext` fields per updated node. Additionally, agent connect/disconnect events are sent as a dedicated message type:

```typescript
// Agent lifecycle event
interface AgentEvent {
  method: "agentUpdate";
  params: {
    agents: AgentInfo[];  // full updated agent list
  };
}
```

The graph webview maintains its own `agents: AgentInfo[]` and `visibleAgents: Set<string>` state, updated when it receives `agentUpdate` messages.

## State Changes in `ui/src/state.ts`

### Extended Node Type

```typescript
export interface Node {
  kind?: NodeKind;
  lastWrite?: number;
  lines?: LineRange;
  inContext?: boolean;
  changed?: boolean;
  lastAction?: 'read' | 'write' | 'search';

  // Multi-agent attribution (new)
  agentHeat?: Record<string, number>;
  agentContext?: Record<string, boolean>;
}
```

### Extended State

```typescript
export interface AgentInfo {
  instanceId: string;
  displayName: string;
  agentType: string;
  color: string;
  connected: boolean;
}

export interface State {
  seq: number;
  nodes: Map<string, Node>;
  calls: CallEdge[];
  agents: AgentInfo[];           // new
  visibleAgents: Set<string>;    // new: display names of visible agents
}
```

## Theme Changes in `ui/src/theme.ts`

### New Exports

```typescript
// Agent color palette
export const AGENT_COLORS = [
  '#22d3ee',  // cyan
  '#fb7185',  // rose
  '#a78bfa',  // violet
  '#fbbf24',  // amber
  '#34d399',  // emerald
  '#38bdf8',  // sky
  '#f472b6',  // pink
];

// Agent ring rendering
export const AGENT_RING_WIDTH = 2.5;
export const AGENT_RING_GAP = 1;        // gap between arc segments in radians (0.05)
export const AGENT_RING_OFFSET = 2;     // pixels outside the node circle

// Legend panel
export const LEGEND_BG = 'rgba(20, 20, 20, 0.85)';
export const LEGEND_BORDER = 'rgba(255, 255, 255, 0.1)';
export const LEGEND_TEXT = '#e5e7eb';
export const LEGEND_TEXT_DIM = 'rgba(255, 255, 255, 0.4)';
export const LEGEND_DOT_SIZE = 8;
export const LEGEND_FONT_SIZE = 11;
export const LEGEND_ROW_HEIGHT = 22;
export const LEGEND_PADDING = 10;
export const LEGEND_CORNER_RADIUS = 6;
```

## Render Changes in `ui/src/render.ts`

### New: `drawAgentRings()`

Called inside `nodeCanvasObject`, after the base fill and before overlays:

```typescript
function drawAgentRings(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  radius: number,
  agentHeat: Record<string, number>,
  agents: AgentInfo[],
  visibleAgents: Set<string>
): void {
  const entries = Object.entries(agentHeat)
    .filter(([name]) => visibleAgents.has(name) || visibleAgents.size === 0)
    .sort((a, b) => a[0].localeCompare(b[0]));  // stable order

  if (entries.length === 0) return;

  const totalHeat = entries.reduce((sum, [, h]) => sum + h, 0);
  if (totalHeat === 0) return;

  const ringRadius = radius + AGENT_RING_OFFSET;
  let angle = -Math.PI / 2;  // start at top

  for (const [displayName, heat] of entries) {
    const agent = agents.find(a => a.displayName === displayName);
    if (!agent) continue;

    const sweep = (heat / totalHeat) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, angle, angle + sweep);
    ctx.strokeStyle = agent.color;
    ctx.lineWidth = AGENT_RING_WIDTH;
    ctx.stroke();
    angle += sweep;
  }
}
```

### New: `drawLegend()`

Called in `onRenderFramePost`, after labels. Draws the legend panel on the canvas:

```typescript
function drawLegend(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  agents: AgentInfo[],
  visibleAgents: Set<string>
): void {
  if (agents.length === 0) return;

  const x = LEGEND_PADDING;
  const y = canvas.height - LEGEND_PADDING
    - (agents.length * LEGEND_ROW_HEIGHT)
    - LEGEND_PADDING * 2
    - LEGEND_ROW_HEIGHT;  // extra row for "Show All"

  const width = 200;
  const height = (agents.length + 1) * LEGEND_ROW_HEIGHT + LEGEND_PADDING * 2;

  // Background
  ctx.fillStyle = LEGEND_BG;
  roundRect(ctx, x, y, width, height, LEGEND_CORNER_RADIUS);
  ctx.fill();

  // Border
  ctx.strokeStyle = LEGEND_BORDER;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, width, height, LEGEND_CORNER_RADIUS);
  ctx.stroke();

  // Agent rows
  let rowY = y + LEGEND_PADDING;
  for (const agent of agents) {
    const isVisible = visibleAgents.size === 0 || visibleAgents.has(agent.displayName);
    const alpha = isVisible ? 1.0 : 0.3;

    // Color dot
    ctx.beginPath();
    ctx.arc(x + LEGEND_PADDING + 4, rowY + LEGEND_ROW_HEIGHT / 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = agent.color;
    ctx.globalAlpha = alpha;
    ctx.fill();

    // Display name
    ctx.font = `${LEGEND_FONT_SIZE}px monospace`;
    ctx.fillStyle = LEGEND_TEXT;
    ctx.globalAlpha = alpha;
    ctx.fillText(agent.displayName, x + LEGEND_PADDING + 16, rowY + LEGEND_ROW_HEIGHT / 2 + 4);

    // Status dot
    const statusX = x + width - LEGEND_PADDING - 8;
    ctx.beginPath();
    ctx.arc(statusX, rowY + LEGEND_ROW_HEIGHT / 2, 3, 0, Math.PI * 2);
    if (agent.connected) {
      ctx.fillStyle = '#22c55e';  // green-500
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'transparent';
    }
    ctx.globalAlpha = alpha;
    ctx.fill();

    ctx.globalAlpha = 1.0;
    rowY += LEGEND_ROW_HEIGHT;
  }

  // "Show All" row
  const allActive = visibleAgents.size === 0;
  ctx.font = `${LEGEND_FONT_SIZE}px monospace`;
  ctx.fillStyle = allActive ? LEGEND_TEXT_DIM : LEGEND_TEXT;
  ctx.fillText('Show All', x + LEGEND_PADDING, rowY + LEGEND_ROW_HEIGHT / 2 + 4);
}
```

### Legend Click Handling

The legend is rendered on the canvas, so clicks must be detected via the canvas `click` event (or the force-graph's `onBackgroundClick`). The `Renderer` tracks the legend bounding box and agent row positions, then hit-tests on click:

```typescript
// In Renderer class
private legendBounds: { x: number; y: number; width: number; height: number } | null = null;
private legendRowBounds: Array<{ displayName: string; y: number; height: number }> = [];

handleCanvasClick(canvasX: number, canvasY: number): string | null {
  if (!this.legendBounds) return null;
  const { x, y, width, height } = this.legendBounds;
  if (canvasX < x || canvasX > x + width || canvasY < y || canvasY > y + height) {
    return null;  // outside legend
  }

  // Check which row was clicked
  for (const row of this.legendRowBounds) {
    if (canvasY >= row.y && canvasY < row.y + row.height) {
      return row.displayName;  // return clicked agent's display name
    }
  }
  return 'show_all';
}
```

The `Eisen` class in `main.ts` handles the returned value:

- If `displayName` returned and currently showing all: switch to solo mode for that agent
- If `displayName` returned and already solo'd on that agent: switch back to show all
- If `displayName` returned and solo'd on a different agent: switch to the clicked agent
- If `'show_all'` returned: clear filter, show all

## Backward Compatibility

### Single Agent Mode

With one connected agent, the legend shows a single row. The agent ring is a full circle in that agent's color. Functionally identical to the current single-agent behavior, but with agent attribution visible.

### No Agents Connected

If no agents are connected (only baseline snapshot), the legend is hidden. No agent rings are drawn. Rendering is identical to current behavior.

## Implementation Order

1. ~~**Orchestrator integration**: Ensure merged snapshots/deltas include agent attribution fields~~ **DONE** — `extension/src/orchestrator/` implements all types and data flow. `MergedGraphSnapshot`, `MergedGraphDelta`, `AgentInfo` are defined in `types.ts`. The orchestrator populates `agentHeat` and `agentContext` per node. `GraphViewProvider` receives pre-merged data via `setSnapshot()` / `applyDelta()` / `updateAgents()`.
2. ~~**GraphViewProvider refactor**: Remove direct TCP, consume orchestrator API~~ **DONE** — `extension/src/views/graph.ts` rewritten. Node type extended with `agentHeat?` and `agentContext?` fields.
3. **State model** (pending): Add `agents: AgentInfo[]` and `visibleAgents: Set<string>` to `ui/src/state.ts`. Extend `Node` with `agentHeat`, `agentContext`. Update `applySnapshot()` / `applyDelta()` to handle new fields.
4. **Theme** (pending): Add `AGENT_COLORS`, ring constants, and legend constants to `ui/src/theme.ts`.
5. **Agent rings** (pending): Draw multi-color arcs in `nodeCanvasObject` within `ui/src/render.ts`.
6. **Legend panel** (pending): Draw in `onRenderFramePost`, handle clicks via canvas hit-testing.
7. **Filter logic** (pending): Implement `visibleAgents` filtering in the render pass (alpha dimming for non-visible agents).
8. **Agent events** (pending): Handle `agentUpdate` messages in `ui/src/main.ts` to add/remove/update agent list.
9. **Rebuild graph bundle** (pending): Compile `ui/` and copy to `extension/media/graph.js`.

See also `MULTIPLE_SESSION_FIX.md` for prerequisite fixes to the chat/ACP layer that must be completed before multi-agent sessions work end-to-end.

## Open Questions

1. **Ring vs. glow**: Should multi-agent attribution be shown as ring arc segments or as a colored glow/shadow behind the node? Rings are more precise; glows are more atmospheric. Starting with rings, can revisit.

2. **Legend position**: Bottom-left avoids conflicting with the existing top-right control buttons (funnel, layers). Could also be a collapsible sidebar. Starting with bottom-left overlay.

3. **Heat threshold for ring display**: Should agent rings only appear when heat > some threshold (e.g. 0.1)? Or always show if the agent has touched the file in the current session? Starting with always-show for any non-zero heat.
