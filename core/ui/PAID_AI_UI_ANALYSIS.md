# Paid.ai UI Component Analysis

## Executive Summary

**Current State**: The UI layer (`ui/`) does **not** currently display any paid.ai-specific features. The paid.ai integration exists only in the backend (`app/host/src/paid/`) for monitoring and cost tracking of AI agent operations.

**Architecture**: Eisen UI is a graph-based visualization tool for code structure and AI agent activity, built with TypeScript, D3 force graphs, and Monaco editor. It communicates with a backend host via a transport layer.

---

## UI Architecture Overview

### Technology Stack
- **Build Tool**: esbuild (bundling, minification)
- **Visualization**: force-graph (3D force-directed graphs), d3-force-3d
- **Editor**: Monaco Editor v0.55.1 (VS Code's editor component)
- **Markdown**: marked v17.0.3 (chat message rendering)
- **Type System**: TypeScript 5.3.0
- **Styling**: CSS custom properties (design tokens), no framework

### File Structure (21 files, ~4,335 lines)

```
ui/
├── src/
│   ├── main.ts                    # Application entry point, Eisen class
│   ├── style.css                  # Global styles, design system
│   ├── transport.ts               # Transport interface (send/listen)
│   ├── state.ts                   # State management (nodes, agents, deltas)
│   ├── types.ts                   # Type definitions
│   ├── render.ts                  # Graph rendering logic
│   ├── graph-ui.ts                # Selection & tooltip logic
│   ├── selection.ts               # User selection handling
│   ├── theme.ts                   # Color theming
│   ├── dom.ts                     # DOM helpers
│   ├── utils.ts                   # Utilities
│   ├── region-draw.ts             # Region visualization
│   ├── region-geometry.ts         # Region geometry calculations
│   ├── components/
│   │   ├── top-bar.ts             # Agent tabs, logo, add button
│   │   ├── chat.ts                # Chat interface, message rendering
│   │   ├── inspect.ts             # Node metadata panel
│   │   ├── preview.ts             # Monaco code editor panel
│   │   ├── toolbar.ts             # View controls (layers, deps, fit)
│   │   ├── badge.ts               # Badge component (kind labels)
│   │   └── kv-row.ts              # Key-value row component
│   └── panels/
│       └── icons.ts               # SVG icon definitions
├── index.html                     # Entry HTML
└── package.json                   # Dependencies
```

---

## Key UI Components

### 1. Main Application (`src/main.ts`)

**Purpose**: Application bootstrap, layout management, message handling

**Key Classes**: `Eisen`

**Responsibilities**:
- Initializes all UI components (TopBar, Chat, Inspect, Preview, Toolbar)
- Manages panel layout (left chat panel, right inspect/preview panels)
- Handles resize interactions for panel width adjustment
- Routes messages from transport to appropriate handlers
- Maintains selection state (`selectedId`, `selectedIds`)

**State Management**:
```typescript
private state: State;              // Graph state (nodes, edges, agents)
private selectedId: string | null; // Single selected node
private selectedIds: Set<string>;  // Multi-selection set
```

**Message Handling** (from backend):
- `snapshot` / `delta` → Update graph state
- `agentUpdate` → Update agent list
- `chatMessage` → Display in chat
- `streamStart/Chunk/End` → Handle streaming responses
- `sessionMetadata` → Update modes/models
- `fileContent` → Display in Monaco editor
- `fileSearchResults` → Show file picker

**Layout Structure**:
```
┌─────────────────────────────────────────┐
│ header-bar (TopBar)                     │
├──────────┬─────────────────┬────────────┤
│          │                 │ right-col  │
│ panel-   │   #graph        │ ┌────────┐ │
│ left     │   (canvas)      │ │inspect │ │
│ (Chat)   │                 │ ├────────┤ │
│          │                 │ │preview │ │
└──────────┴─────────────────┴────────────┘
             └── toolbar-anchor (bottom center)
```

**Code Snippets**:

ui/src/main.ts:42-60
```typescript
constructor(transport: Transport) {
  document.documentElement.setAttribute("data-theme", "dark");
  this.state = createState();
  this.transport = transport;

  const canvas = document.getElementById("graph") as HTMLElement;
  this.root = document.body;
  const header = el("div", { className: "header-bar" });

  // Left panel (chat)
  this.left = el("div", { className: "panel panel-left" });
  const leftHandle = el("div", { className: "resize-handle resize-left" });
  leftHandle.addEventListener("mousedown", (e) => this.startResize(e, "left"));
  this.left.append(leftHandle);

  // Right column (inspect + preview)
  this.right = el("div", { className: "right-col" });
  const rightHandle = el("div", { className: "resize-handle resize-right" });
  rightHandle.addEventListener("mousedown", (e) => this.startResize(e, "right"));
  this.right.append(rightHandle);
```

---

### 2. Top Bar (`src/components/top-bar.ts`)

**Purpose**: Agent session management, tab navigation

**Key Classes**: `TopBar`

**UI Elements**:
- **Logo** (Eisen SVG) - clickable
- **Tab Strip** - scrollable agent tabs
  - Each tab shows: color dot, display name, close button
  - Active tab has different styling
  - Streaming indicator (pulsing dot animation)
- **Add Button** - create new agent session

**State Indicators**:
- `connected` → dot opacity (dim if disconnected)
- `streaming` → pulsing animation on dot
- `active` → background highlight
- `pending` → temporary tab before agent is created

**Event Handlers**:
```typescript
onSelect(id: string): void;  // User selects agent tab
onAdd(): void;                // User clicks add button
onClose?(id: string): void;   // User closes agent tab
onLogo?(): void;              // User clicks logo
```

**Color Coding**: Each agent has a unique color (from `AgentInfo.color`)

---

### 3. Chat Component (`src/components/chat.ts`)

**Purpose**: Multi-agent chat interface with markdown rendering

**Key Classes**: `Chat`

**Features**:
1. **Message Display**:
   - User messages (right-aligned, accent color background)
   - Agent messages (left-aligned, markdown formatted)
   - Tool call indicators (italic, dim text)
   - Streaming support (live text updates)

2. **Input System**:
   - Textarea with auto-resize
   - Send button (accent colored)
   - Settings button (opens dropdown)
   - Context chips (file/folder attachments)

3. **Dropdowns** (portaled to body):
   - **Command Picker** (`/` commands)
   - **File Search** (`@` mentions)
   - **Settings** (modes, models)
   - **Agent Picker** (create new agent)

4. **Agent Picker**:
   - Session mode toggle: "Single Agent" vs "Orchestrator"
   - Agent type list (from `AvailableAgent[]`)

**Message Types**:
```typescript
// User message
{ from: "user", text: string, instanceId?: string }

// Agent message (markdown)
{ from: string, text: string, instanceId?: string }
```

**Markdown Rendering**: Uses `marked` library with HTML sanitization

**Code Snippets**:

ui/src/components/chat.ts:130-145 (message rendering)
```typescript
private addMsg(msg: { from: string; text: string }): void {
  const isUser = msg.from === "user";
  const bubble = el("div", { className: isUser ? "msg msg-user" : "msg msg-agent" });
  
  if (isUser) {
    bubble.textContent = msg.text;
  } else {
    bubble.innerHTML = marked.parse(msg.text) as string;
  }
  
  this.messages.append(bubble);
  this.scrollToBottom();
}
```

**Context Chips**: File/folder attachments displayed as removable tags above input

---

### 4. Inspect Panel (`src/components/inspect.ts`)

**Purpose**: Display metadata for selected graph nodes

**Key Classes**: `Inspect`

**Display Modes**:

1. **Single Node**:
   - Badge (node kind: file, folder, class, method)
   - Label (short name)
   - Key-value rows:
     - `lines`: Line range (e.g., "10-50 (40)")
     - `tokens`: Token count
     - `action`: Last action (read/write/search)
     - `agents`: Agent names that touched this node
   - Footer: Full path

2. **Multi-Selection Summary**:
   - Badge: "selection"
   - Label: "N nodes"
   - Counts by kind (e.g., "file: 3", "class: 5")

**Node Metadata Structure**:
```typescript
interface NodeMeta {
  kind: string;           // "file" | "folder" | "class" | "method"
  badgeColor?: string;    // Theme color
  lines?: string;         // "start-end (total)"
  tokens?: string;        // Token count
  action?: string;        // "read" | "write" | "search"
  agents?: string;        // Comma-separated agent names
}
```

---

### 5. Preview Panel (`src/components/preview.ts`)

**Purpose**: Code file viewing with Monaco Editor

**Key Classes**: `Preview`

**Features**:
- Full Monaco editor integration (VS Code editor)
- Syntax highlighting (auto-detected by file extension)
- Line revealing (scroll to specific line)
- Line range highlighting (visual emphasis)
- Custom themes (eisen-dark, eisen-light)
- Save support (Ctrl/Cmd+S)

**Themes**: Transparent background to blend with panel design

**Event Handlers**:
```typescript
onSave: ((path: string, content: string) => void) | null;
```

**Methods**:
```typescript
open(path: string, content: string, languageId: string)
revealLine(line: number)
highlightLines(startLine: number, endLine: number)
clearHighlight()
close()
```

---

### 6. Toolbar (`src/components/toolbar.ts`)

**Purpose**: View mode controls for graph visualization

**Buttons**:
- **View** (cycle through view modes)
- **Layers** (cycle region depth modes)
- **Fit** (zoom to fit all nodes)
- **Marquee** (toggle selection mode: marquee ↔ lasso)
- **Deps** (toggle dependency visualization mode)

**Active States**: Buttons show accent color when active

---

## State Management (`src/state.ts`)

### Core State Structure

```typescript
interface State {
  seq: number;                    // Sequence number for updates
  nodes: Map<string, Node>;       // Graph nodes (files, classes, methods)
  calls: CallEdge[];              // Call graph edges
  agents: AgentInfo[];            // Active agent sessions
  visibleAgents: Set<string>;     // Filtered agent names
  agentFilterActive: boolean;     // Whether filtering is enabled
}
```

### Node Structure

```typescript
interface Node {
  kind?: NodeKind;                // "file" | "folder" | "class" | "method"
  lastWrite?: number;             // Timestamp
  lines?: LineRange;              // { start: number; end: number }
  inContext?: boolean;            // In current context
  changed?: boolean;              // Recently modified
  lastAction?: "read" | "write" | "search";
  tokens?: number;                // Token count
  
  // Multi-agent attribution
  agentHeat?: Record<string, number>;      // Agent activity heat map
  agentContext?: Record<string, boolean>;  // Which agents have this in context
}
```

### Agent Info Structure

```typescript
interface AgentInfo {
  instanceId: string;      // Unique session ID
  displayName: string;     // Human-readable name
  agentType: string;       // Agent type identifier
  color: string;           // Hex color for UI
  connected: boolean;      // Connection status
}
```

### Update Mechanisms

1. **Snapshot** (full state replacement):
```typescript
applySnapshot(state: State, snapshot: Snapshot): void
```

2. **Delta** (incremental updates):
```typescript
applyDelta(state: State, delta: Delta): void
```

Delta updates support:
- Node creation
- Node modification
- Node removal
- Agent list updates

---

## Transport Layer (`src/transport.ts`)

### Interface

```typescript
interface Transport {
  send(msg: { type: string; [key: string]: unknown }): void;
  listen(handler: (msg: { method: string; params?: unknown }) => void): void;
}
```

### Messages Sent (UI → Backend)

```typescript
{ type: "requestSnapshot" }
{ type: "chatMessage", text: string, instanceId: string | null, contextChips?: ContextChip[] }
{ type: "switchAgent", instanceId: string }
{ type: "addAgent", agentType: string, sessionMode: SessionMode }
{ type: "selectMode", modeId: string }
{ type: "selectModel", modelId: string }
{ type: "fileSearch", query: string }
{ type: "readFile", path: string }
{ type: "writeFile", path: string, content: string }
```

### Messages Received (Backend → UI)

```typescript
{ method: "snapshot", params: Snapshot }
{ method: "delta", params: Delta }
{ method: "agentUpdate", params: { agents: AgentInfo[] } }
{ method: "chatMessage", params: { from: string, text: string, instanceId?: string } }
{ method: "streamStart", params: { instanceId: string } }
{ method: "streamChunk", params: { text: string, instanceId: string } }
{ method: "streamEnd", params: { instanceId: string } }
{ method: "sessionMetadata", params: SessionMeta }
{ method: "fileSearchResults", params: FileSearchResult[] }
{ method: "fileContent", params: { path: string, content: string, languageId?: string } }
{ method: "availableAgents", params: AvailableAgent[] }
{ method: "availableCommands", params: { commands: AvailableCommand[], instanceId?: string } }
```

**Note**: The transport implementation is provided by the backend (injected as `globalThis.__eisenTransport`)

---

## Styling & Design System (`src/style.css`)

### Design Tokens

```css
/* Spacing */
--space-xs: 2px;
--space-sm: 4px;
--space-md: 6px;
--space-lg: 8px;

/* Typography */
--fs-xs: 10px;
--fs-sm: 11px;
--fs-md: 13px;
--fs-lg: 15px;
--font-sans: "Geist", system-ui, sans-serif;
--font-mono: "Geist Mono", "SF Mono", monospace;

/* Border Radius */
--radius: 10px;
--radius-sm: 6px;
--radius-xs: 4px;
```

### Theme System

Two themes: `dark` (default) and `light`

**Dark Theme Colors**:
```css
--bg: #141414;
--text: rgba(255, 255, 255, 1);
--text-2: rgba(255, 255, 255, 0.72);
--text-3: rgba(255, 255, 255, 0.5);
--accent: #0c8ce9;
--accent-muted: rgba(12, 140, 233, 0.18);
--raised: rgba(255, 255, 255, 0.08);
--border: rgba(255, 255, 255, 0.14);
--panel-bg: rgba(255, 255, 255, 0.03);
--panel-blur: 24px;
```

### Glass Morphism

Panels use backdrop-filter blur with semi-transparent backgrounds:
```css
.panel {
  background: var(--panel-bg);
  backdrop-filter: blur(var(--panel-blur));
  border: 1px solid var(--glass-border);
}
```

### Component Styles

**Key CSS Classes**:
- `.header-bar` - Top bar (32px height)
- `.panel` - Generic panel container
- `.panel-left` - Chat panel
- `.right-col` - Inspect/Preview column
- `.toolbar` - Bottom center toolbar
- `.glass` - Glass morphism effect
- `.option` - Selectable list item
- `.msg-user` / `.msg-agent` - Chat messages
- `.badge` - Kind indicator badge
- `.chip` - Context chip (file attachment)
- `.hover-tooltip` - Node hover tooltip

---

## Paid.ai Integration Status

### Current Implementation

**Backend Only**: Paid.ai is integrated in `app/host/src/paid/` for cost tracking and monitoring. It wraps Mastra agents to send usage signals to Paid's platform.

**No UI Components**: The UI layer has **zero references** to paid.ai. No mentions of:
- "paid", "payment", "subscription", "premium", "upgrade"
- Cost display
- Usage metrics
- Billing information

### Backend Integration Points (Outside UI Region)

From `PAID_INTEGRATION.md`:

1. **Agent Monitoring**: All agent calls wrapped with `Paid.trace()`
2. **Signal Events**:
   - `task_decompose` - Task decomposition agent
   - `agent_select` - Agent selection agent
   - `prompt_build` - Prompt building agent
   - `progress_eval` - Progress evaluation agent
   - `region_insight` - Region insight generation
   - `prompt_optimize` - Prompt optimization

3. **Metadata Tracked**:
   - Customer ID: workspace path
   - Product ID: "eisen-orchestrator"
   - Event name: agent operation type
   - Duration, success status, agent ID

---

## Potential UI Integration Points for Paid.ai

### 1. Cost Display in Inspect Panel

**Location**: `ui/src/components/inspect.ts`

**Implementation**:
```typescript
// Add to NodeMeta interface
interface NodeMeta {
  // ... existing fields
  cost?: string;          // e.g., "$0.0023"
  tokensUsed?: string;    // e.g., "1,234"
}

// Display in inspect panel
if (meta.cost) this.content.append(KVRow("cost", meta.cost));
if (meta.tokensUsed) this.content.append(KVRow("tokens used", meta.tokensUsed));
```

**Backend Changes Required**:
- Paid cost data must be sent in `delta` updates
- Associate costs with specific nodes/operations

---

### 2. Agent Session Cost Tracking

**Location**: `ui/src/components/top-bar.ts`

**Implementation**:
```typescript
// Add cost badge to each tab
interface AgentInfo {
  // ... existing fields
  totalCost?: number;     // Running total
}

// Display in tab (optional)
const costBadge = el("span", { className: "tab-cost" }, `$${a.totalCost.toFixed(4)}`);
```

**Visual Design**: Small cost indicator next to agent name in tab

---

### 3. Session Metadata Panel

**Location**: New component `ui/src/components/session-stats.ts`

**Purpose**: Show session-wide statistics:
- Total cost
- Total tokens
- Number of operations
- Cost breakdown by agent
- Time-series cost graph

**Placement**: Could be:
- Dropdown from top-bar logo
- New panel in right column
- Overlay modal

---

### 4. Real-time Cost Warnings

**Location**: `ui/src/components/chat.ts`

**Implementation**: Inline warnings in chat when costs exceed thresholds:
```typescript
// After expensive operation
if (operationCost > threshold) {
  this.addSystemMessage(`⚠️ High-cost operation: $${operationCost.toFixed(4)}`);
}
```

---

### 5. Settings Panel Enhancement

**Location**: `ui/src/components/chat.ts` (settings dropdown)

**Add Section**: "Usage & Billing"
- View total costs
- Set cost limits
- Export usage report
- Link to Paid dashboard

---

## Testing Strategy

### UI Component Tests

Since the UI is vanilla TypeScript with no testing framework currently set up, here are recommended test assertions:

#### 1. Component Existence Tests

```typescript
// Test: Top bar renders with logo and add button
describe("TopBar", () => {
  it("should render logo", () => {
    const topBar = new TopBar({ onSelect: jest.fn(), onAdd: jest.fn() });
    const logo = topBar.el.querySelector(".top-logo");
    expect(logo).toBeTruthy();
    expect(logo.innerHTML).toContain("<svg");
  });

  it("should render add button", () => {
    const topBar = new TopBar({ onSelect: jest.fn(), onAdd: jest.fn() });
    const addBtn = topBar.el.querySelector(".add-btn");
    expect(addBtn).toBeTruthy();
  });
});
```

#### 2. State Management Tests

```typescript
// Test: State snapshot application
describe("State Management", () => {
  it("should apply snapshot correctly", () => {
    const state = createState();
    const snapshot = {
      seq: 1,
      nodes: { "file.ts": { kind: "file" } },
      calls: [],
      agents: [{ instanceId: "a1", displayName: "Agent 1", color: "#fff", connected: true }]
    };
    
    applySnapshot(state, snapshot);
    
    expect(state.seq).toBe(1);
    expect(state.nodes.size).toBe(1);
    expect(state.agents.length).toBe(1);
  });

  it("should apply delta updates", () => {
    const state = createState();
    const delta = {
      seq: 2,
      updates: [{ id: "file.ts", kind: "file", action: "write" }]
    };
    
    applyDelta(state, delta);
    
    expect(state.seq).toBe(2);
    expect(state.nodes.has("file.ts")).toBe(true);
  });
});
```

#### 3. Message Handling Tests

```typescript
// Test: Chat message rendering
describe("Chat Component", () => {
  it("should render user messages", () => {
    const chat = new Chat({ onSend: jest.fn(), /* ... */ });
    chat.addMessage({ from: "user", text: "Hello" });
    
    const userMsg = chat.el.querySelector(".msg-user");
    expect(userMsg).toBeTruthy();
    expect(userMsg.textContent).toBe("Hello");
  });

  it("should render markdown in agent messages", () => {
    const chat = new Chat({ onSend: jest.fn(), /* ... */ });
    chat.addMessage({ from: "agent", text: "**Bold text**" });
    
    const agentMsg = chat.el.querySelector(".msg-agent");
    expect(agentMsg.innerHTML).toContain("<strong>Bold text</strong>");
  });
});
```

#### 4. Selection Tests

```typescript
// Test: Node selection behavior
describe("Selection", () => {
  it("should show inspect panel on single selection", () => {
    const ctx = createMockContext();
    const result = applySelection(ctx, new Set(["file.ts"]));
    
    expect(result.selectedId).toBe("file.ts");
    expect(ctx.right.classList.contains("visible")).toBe(true);
  });

  it("should show summary on multi-selection", () => {
    const ctx = createMockContext();
    const result = applySelection(ctx, new Set(["file1.ts", "file2.ts"]));
    
    expect(result.selectedIds.size).toBe(2);
    // Verify inspect.showSummary was called
  });
});
```

#### 5. Transport Integration Tests

```typescript
// Test: Message sending/receiving
describe("Transport", () => {
  it("should send chat messages with correct format", () => {
    const mockTransport = {
      send: jest.fn(),
      listen: jest.fn()
    };
    
    const eisen = new Eisen(mockTransport);
    eisen.chat.onSend("Hello", "agent-1", []);
    
    expect(mockTransport.send).toHaveBeenCalledWith({
      type: "chatMessage",
      text: "Hello",
      instanceId: "agent-1",
      contextChips: undefined
    });
  });
});
```

### Manual Testing Checklist

- [ ] Top bar tabs render correctly with agent colors
- [ ] Chat messages display with proper formatting (user vs agent)
- [ ] Markdown rendering works in agent messages
- [ ] File search (`@`) triggers dropdown
- [ ] Command search (`/`) triggers dropdown
- [ ] Settings dropdown shows modes and models
- [ ] Inspect panel shows node metadata on selection
- [ ] Preview panel displays code with syntax highlighting
- [ ] Monaco editor save (Ctrl/Cmd+S) triggers write
- [ ] Toolbar buttons toggle visual states
- [ ] Panel resizing works smoothly
- [ ] Theme switching (dark/light) updates all components
- [ ] Streaming messages update in real-time
- [ ] Agent tabs show streaming indicator (pulsing dot)
- [ ] Context chips can be added and removed
- [ ] Multi-selection shows summary in inspect panel

---

## Dependencies & Build

### Package Dependencies

```json
{
  "dependencies": {
    "d3-force-3d": "^3.0.6",        // 3D force simulation
    "force-graph": "^1.51.0",        // Graph visualization
    "marked": "^17.0.3",             // Markdown parsing
    "monaco-editor": "0.55.1"        // Code editor
  },
  "devDependencies": {
    "esbuild": "^0.20.0",            // Bundler
    "typescript": "^5.3.0"           // Type checking
  }
}
```

### Build Process

```bash
# Development (watch mode)
npm run dev

# Production build
npm run build
# → Bundles src/main.ts to dist/main.js (IIFE format)
# → Concatenates dist/main.css + src/style.css → dist/style.css
# → Minifies output
```

**Output**:
- `dist/main.js` - Bundled JavaScript
- `dist/style.css` - Combined styles

---

## Coding Conventions

### Naming Conventions

✅ **camelCase**:
- Variables: `selectedId`, `chatView`, `streamText`
- Methods: `applySnapshot`, `handleMessage`, `autoResize`
- Parameters: `instanceId`, `agentType`, `sessionMode`

✅ **PascalCase**:
- Classes: `Eisen`, `TopBar`, `Chat`, `Preview`
- Interfaces: `AgentInfo`, `SessionMeta`, `NodeMeta`
- Types: `SessionMode`, `ViewMode`, `NodeKind`

✅ **SCREAMING_SNAKE_CASE**:
- Constants: `ICON`, `LOGO`, `OPT`, `OPT_ON`

### Framework Idioms

**DOM Manipulation**:
```typescript
// Helper function for element creation
const el = (tag, props?, ...children) => HTMLElement;

// Usage
const btn = el("button", { className: "send-btn", type: "button" }, "Send");
```

**Event Handling**:
```typescript
// Direct addEventListener, no framework
btn.addEventListener("click", () => this.doSend());
```

**State Updates**:
```typescript
// Immutable-style updates (Map, Set)
state.nodes.set(id, { ...existingNode, changed: true });
```

**No Virtual DOM**: Direct DOM manipulation throughout

---

## Areas for Improvement

### 1. **Type Safety**
- Some `any` types (Monaco worker config)
- Could add stricter types for transport messages

### 2. **Error Handling**
- Limited error boundaries
- No retry logic for transport failures

### 3. **Performance**
- Large graphs (>1000 nodes) may slow down
- Could add virtualization for chat messages

### 4. **Accessibility**
- Some ARIA labels present, but incomplete
- Keyboard navigation could be enhanced
- Screen reader support not tested

### 5. **Testing**
- No test suite currently exists
- Would benefit from unit + integration tests

### 6. **Documentation**
- JSDoc comments minimal
- Could add inline documentation for complex functions

### 7. **Paid.ai Display**
- **No cost visibility**: Users cannot see operation costs
- **No budget controls**: No way to set spending limits from UI
- **No usage reports**: Historical cost data not accessible
- **No breakdown**: Cannot see which agents/operations cost most

---

## Recommendations for Paid.ai UI Integration

### Priority 1: Basic Cost Display
1. Add cost to `NodeMeta` and display in inspect panel
2. Show per-agent session costs in top bar tabs
3. Add total session cost to settings dropdown

### Priority 2: Cost Awareness
1. Real-time cost updates during streaming
2. Warning thresholds for expensive operations
3. Cost breakdown by operation type

### Priority 3: Advanced Features
1. Session statistics panel (graphs, breakdowns)
2. Export usage reports (CSV, JSON)
3. Link to Paid dashboard for detailed billing
4. Budget limits and notifications

### Implementation Notes

**Backend Changes Required**:
1. Paid.ai cost data must be sent via `delta` messages
2. Associate costs with:
   - Individual nodes (for operation-level tracking)
   - Agent sessions (for session-level totals)
   - Overall session (for global totals)

**Message Protocol Extension**:
```typescript
// New message type
{ method: "costUpdate", params: {
  nodeId?: string,
  agentId?: string,
  cost: number,
  tokens: number,
  operation: string
}}
```

**State Extension**:
```typescript
interface Node {
  // ... existing fields
  cost?: number;
  costByAgent?: Record<string, number>;
}

interface AgentInfo {
  // ... existing fields
  totalCost?: number;
  operationCount?: number;
}
```

---

## Conclusion

The Eisen UI is a well-structured, modular TypeScript application focused on graph visualization and multi-agent chat. While the backend has comprehensive paid.ai integration for cost tracking, **the UI currently has zero paid.ai-specific features**.

**Key Strengths**:
- Clean component architecture
- Strong type safety with TypeScript
- Modern design with glass morphism
- Real-time updates via delta protocol
- Multi-agent session support

**Key Gaps for Paid.ai**:
- No cost visibility for users
- No budget controls or warnings
- No usage analytics or reporting
- No integration with Paid platform from UI

**Next Steps**:
1. Extend state management to include cost data
2. Add cost display components (inspect panel, tabs)
3. Implement real-time cost streaming
4. Create session statistics dashboard
5. Add budget controls and notifications

This analysis provides a foundation for implementing paid.ai UI features in a way that's consistent with the existing architecture and design patterns.
