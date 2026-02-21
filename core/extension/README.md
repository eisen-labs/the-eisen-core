# Eisen

Live visualization of AI agent activity in your codebase.

## Features

- **Live Graph View** -- See a real-time force-directed graph of your codebase as AI agents read and edit files. Nodes heat up to show where the agent is focused.
- **Integrated Agent Chat** -- Start and manage AI agent sessions directly from the sidebar. Supports any agent that implements the Agent Client Protocol (ACP).
- **Symbol-Level Tracking** -- Eisen parses your code with tree-sitter to track activity at the function and class level, not just files.

## How It Works

Eisen wraps your AI agent with `eisen-core`, a lightweight Rust binary that acts as a transparent proxy. It intercepts ACP messages to track which files and symbols the agent is reading and editing, then streams live updates to the graph visualization over a local TCP connection.

## Getting Started

1. Install the Eisen extension
2. Open the Eisen sidebar
3. Configure your agent command in settings
4. Start a session from the Agents panel

## Supported Languages

Tree-sitter based symbol parsing for:

- TypeScript / JavaScript
- Python
- Rust

## Requirements

- VS Code 1.85+
- An ACP-compatible AI agent
