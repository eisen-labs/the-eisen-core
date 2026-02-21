# VSCode ACP Protocol Documentation

This document describes the ACP (Agent Client Protocol) communication patterns used by the Eisen extension. This is for implementing the Eisen proxy that intercepts these messages.

## Transport Layer

- **Protocol**: ndJSON (newline-delimited JSON)
- **Transport**: stdio pipes (stdin/stdout)
- **Library**: `@agentclientprotocol/sdk` provides `ndJsonStream()`
- **Process spawning**: `stdio: ["pipe", "pipe", "pipe"]`

```typescript
const stream = ndJsonStream(
  Writable.toWeb(process.stdin) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>,
);
```

## Connection Flow

1. Extension spawns agent process with piped stdio
2. Establishes `ClientSideConnection` with client capability handlers
3. Sends `initialize` request
4. Agent responds with capabilities
5. Extension sends `newSession` with working directory
6. Session established, ready for `prompt` requests

## Client → Agent Requests

### Initialize

```typescript
{
  protocolVersion: 1,
  clientCapabilities: {
    fs: {
      readTextFile: true,
      writeTextFile: true
    },
    terminal: true
  },
  clientInfo: {
    name: "eisen",
    version: "0.0.1"
  }
}
```

### New Session

```typescript
{
  cwd: string,        // Working directory
  mcpServers: []      // MCP server configurations
}
```

### Prompt (Send Message)

```typescript
{
  sessionId: string,
  prompt: [
    { type: "text", text: string }
  ]
}
```

### Set Session Mode

```typescript
{
  sessionId: string,
  modeId: string
}
```

### Set Session Model (Unstable)

```typescript
{
  sessionId: string,
  modelId: string
}
```

### Cancel

```typescript
{
  sessionId: string;
}
```

## Agent → Client Requests (Handlers)

### Request Permission

Agent requests permission for an operation.

**Request:**

```typescript
{
  options: [
    { kind: "allow_once", optionId: string },
    { kind: "allow_always", optionId: string },
    { kind: "deny", optionId: string },
  ];
}
```

**Response:**

```typescript
// Approved
{ outcome: { outcome: "selected", optionId: string } }
// Denied
{ outcome: { outcome: "cancelled" } }
```

### Read Text File

Agent requests file content.

**Request:**

```typescript
{
  path: string,
  line?: number,      // Start line (optional)
  limit?: number      // Max lines to read (optional)
}
```

**Response:**

```typescript
{
  content: string;
}
```

### Write Text File

Agent writes file content.

**Request:**

```typescript
{
  path: string,
  content: string
}
```

**Response:**

```typescript
{
} // Empty object on success
```

### Create Terminal

Agent spawns a terminal process.

**Request:**

```typescript
{
  command: string,
  args?: string[],
  cwd?: string,
  env?: Array<{ name: string, value: string }>,
  outputByteLimit?: number | null
}
```

**Response:**

```typescript
{
  terminalId: string;
}
```

### Terminal Output

Agent requests terminal output.

**Request:**

```typescript
{
  terminalId: string;
}
```

**Response:**

```typescript
{
  output: string,
  truncated: boolean,
  exitStatus: {
    exitCode: number,
    signal?: string
  } | null
}
```

### Wait for Terminal Exit

Agent waits for terminal process completion.

**Request:**

```typescript
{
  terminalId: string;
}
```

**Response:**

```typescript
{
  exitCode: number | null,
  signal?: string | null
}
```

### Kill Terminal

Agent requests to kill a terminal.

**Request:**

```typescript
{
  terminalId: string;
}
```

**Response:**

```typescript
{
} // Empty object
```

### Release Terminal

Agent releases/cleans up a terminal.

**Request:**

```typescript
{
  terminalId: string;
}
```

**Response:**

```typescript
{
} // Empty object
```

## Session Updates (Agent → Client)

Session updates are sent via the `sessionUpdate` handler and contain various update types.

### Agent Message Chunk

Streaming response from agent.

```typescript
{
  sessionUpdate: "agent_message_chunk",
  content: {
    type: "text",
    text: string
  }
}
```

### Agent Thought Chunk

Agent's reasoning/thinking process.

```typescript
{
  sessionUpdate: "agent_thought_chunk",
  content: {
    type: "text",
    text: string
  }
}
```

### Tool Call Start

Agent starts executing a tool.

```typescript
{
  sessionUpdate: "tool_call",
  toolCallId: string,
  title: string,
  kind: ToolKind
}
```

**Tool Kinds:**

- `read` - File read operations
- `edit` - File edits
- `delete` - File deletion
- `move` - File move/rename
- `search` - Search/grep operations
- `execute` - Command execution
- `think` - Thinking/reasoning
- `fetch` - Web fetch
- `switch_mode` - Mode switching
- `other` - Uncategorized

### Tool Call Update

Tool execution completed or updated.

```typescript
{
  sessionUpdate: "tool_call_update",
  toolCallId: string,
  title: string,
  kind: ToolKind,
  status: "completed" | "failed",
  content: ToolCallContentItem[],
  rawInput?: { command?: string, description?: string },
  rawOutput?: { output?: string }
}
```

### Current Mode Update

Session mode changed.

```typescript
{
  sessionUpdate: "current_mode_update",
  currentModeId: string
}
```

### Available Commands Update

Slash commands available.

```typescript
{
  sessionUpdate: "available_commands_update",
  availableCommands: Array<{
    name: string,
    description?: string,
    input?: { hint?: string }
  }>
}
```

### Plan Update

Agent execution plan.

```typescript
{
  sessionUpdate: "plan",
  entries: Array<{
    content: string,
    priority: "high" | "medium" | "low",
    status: "pending" | "in_progress" | "completed"
  }>
}
```

## Tool Call Content Types

Tools can return different content types:

### Text Content

```typescript
{
  type: "content",
  content: {
    type: "text",
    text: string
  }
}
```

### Diff Content

File changes with before/after.

```typescript
{
  type: "diff",
  path?: string,
  oldText?: string,
  newText?: string
}
```

### Terminal Content

Reference to terminal output.

```typescript
{
  type: "terminal",
  terminalId?: string
}
```

## Session Metadata

After session creation, the agent returns:

```typescript
{
  sessionId: string,
  modes?: {
    availableModes: Array<{ id: string, name: string }>,
    currentModeId: string
  },
  models?: {
    availableModels: Array<{ modelId: string, name: string }>,
    currentModelId: string
  }
}
```

## Initialize Response

Agent responds to initialize with:

```typescript
{
  protocolVersion: number,
  serverCapabilities: {
    fs?: { readTextFile?: boolean, writeTextFile?: boolean },
    terminal?: boolean
  },
  serverInfo: {
    name: string,
    version: string
  }
}
```

## Proxy Implementation Notes

For the Eisen proxy (`eisen-core`), you need to:

1. **Intercept all messages** - Both directions on the stdio pipe
2. **Forward transparently** - Don't modify messages, just pass through
3. **Extract file paths** from:
   - `readTextFile` requests (path field)
   - `writeTextFile` requests (path field)
   - Tool call `diff` content (path field)
   - Embedded resources in prompts (if any)
4. **Track session state**:
   - Turn count for context window
   - File access patterns
   - Tool call patterns
5. **Emit to TCP** (port 17320):
   - File nodes with heat values
   - Context state changes
   - Usage updates (if available)

## Example Message Flow

```
Client                              Agent
  |                                   |
  |-- initialize -------------------->|
  |<-- InitializeResponse ------------|
  |                                   |
  |-- newSession -------------------->|
  |<-- NewSessionResponse ------------|
  |                                   |
  |-- prompt: "Read file X" --------->|
  |<-- sessionUpdate: tool_call ------|
  |-- readTextFile: "/path/to/X" --->|
  |<-- ReadTextFileResponse ---------|
  |<-- sessionUpdate: tool_complete -|
  |<-- sessionUpdate: agent_chunk ---|
  |<-- ... more chunks ...           |
  |<-- PromptResponse ----------------|
```

## File Path Extraction Points

For context tracking, extract file paths from:

1. **readTextFile requests** - `params.path`
2. **writeTextFile requests** - `params.path`
3. **Tool call diffs** - `content.path` when `type: "diff"`
4. **Session prompt** - Parse text for @mentions or file references
5. **Tool rawInput** - May contain file paths in command strings

## Related Documentation

- [ACP Specification](https://agentclientprotocol.com)
- [SACP Proxy Framework](https://docs.rs/sacp-proxy/latest/sacp_proxy/)
- [SACP Conductor](https://docs.rs/sacp-conductor/latest/sacp_conductor/)
