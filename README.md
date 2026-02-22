# the-eisen-core

Agentic desktop platform with local context awareness and intelligent orchestration.

## Architecture

```mermaid
flowchart TB
    subgraph Web["@website/ - Web Interface"]
        AuthUI["Auth Pages<br/>Login / Callback"]
        BillingUI["Billing Portal<br/>Stripe Cards"]
        KeysUI["API Key Management"]
        Dash["Account Dashboard"]
    end

    subgraph Auth["@auth/ - Auth Service"]
        AuthAPI["Auth API<br/>JWT / Sessions"]
        Stripe["Stripe Billing"]
        KeyVerify["API Key Verification"]
        AuthDB[("Auth DB<br/>Users / Billing")]
    end

    subgraph Core["@core/ - Desktop Agent"]
        App["Tauri Desktop App"]
        Orchestrator["Orchestrator"]
        UI["React UI"]
        Graph["Agent Graph"]
        Observer["Observability"]
        LibSQL[("LibSQL DB<br/>Per Workspace<br/>Repo Context / Commits")]
    end

    AuthUI -->|"User login"| AuthAPI
    BillingUI -->|"Manage cards"| Stripe
    KeysUI -->|"Create/View keys"| AuthAPI
    Dash -->|"View usage"| AuthDB

    App -->|"Verify API Key"| KeyVerify
    App -->|"Get JWT"| AuthAPI
    AuthAPI -->|"Store user data"| AuthDB

    Orchestrator -->|"Query context"| LibSQL
    Orchestrator -->|"Build prompts from"| LibSQL
    Graph -->|"Log execution"| Observer
    UI -->|"Display agent state"| Observer
```

## Package Roles

| Package | Responsibility |
|---------|---------------|
| **@website/** | User-facing web interface for auth, Stripe billing, API key management |
| **@auth/** | Backend auth service: user authentication, billing processing, API key verification |
| **@core/** | Desktop agent layer: orchestrator, UI, agent graph, observability, local LibSQL per workspace |

## How It Works

### Auth Flow

```mermaid
sequenceDiagram
    participant User
    participant Web as @website/
    participant Auth as @auth/
    participant Core as @core/

    User->>Web: Visit login page
    Web->>Auth: POST /auth/login
    Auth-->>Web: Auth URL
    Web->>User: Redirect to auth provider
    User->>Auth: Authenticate
    Auth-->>Web: Callback with code
    Web->>Auth: Exchange code for JWT
    Auth-->>Web: JWT + User data
    
    User->>Web: View API Keys page
    Web->>Auth: GET /apikeys
    Auth-->>Web: List of keys
    
    User->>Core: Enter API Key
    Core->>Auth: Verify key
    Auth-->>Core: Valid + Workspace ID
```

### Context-Aware Agents

```mermaid
flowchart LR
    subgraph Workspace["Workspace LibSQL"]
        Repo["Repo Structure"]
        Commits["Commit History"]
        Context["Agent Context"]
    end

    Orchestrator -->|"Analyze repo"| Repo
    Orchestrator -->|"Check previous"| Commits
    Orchestrator -->|"Load state"| Context
    Orchestrator -->|"Form prompt"| Agent["Agent Graph"]
    Agent -->|"Execute"| Tools["Tools"]
    Agent -->|"Update"| Context
```

### Observability

```mermaid
flowchart TB
    Agent["Agent Execution"] --> Observer["Observer"]
    Observer --> Logs["Execution Logs"]
    Observer --> Metrics["Usage Metrics"]
    Logs --> UI["Desktop UI"]
    Metrics --> Auth["@auth/<br/>Billing"]
```

## Key Features

**Local Context**: Each workspace has its own LibSQL database storing repo structure, commit history, and agent state. Orchestrators query this to form better prompts.

**Smart Orchestration**: Agents coordinate without overlap by checking workspace state in local DB.

**Observability**: Full visibility into agent decisions, tool calls, and execution flow.

**API Key Verification**: Core verifies keys against @auth/ service before executing agents.

## Quick Start

```bash
# Start auth backend
cd auth && bun run dev

# Start web frontend
cd website && bun run dev

# Run desktop app
cd core/app && bun run tauri dev
```

## File Structure

```
auth/                      # @auth/ - Auth & billing service
├── src/routes/
│   ├── auth.ts           # Login/callback
│   ├── apikeys.ts        # Key management
│   ├── billing.ts        # Stripe integration
│   └── workspace.ts      # Workspace data
└── src/db/               # Auth database

website/                   # @website/ - Web interface
├── src/app/
│   ├── login/            # Auth pages
│   ├── (protected)/
│   │   ├── account/
│   │   │   ├── api-keys/   # Key management UI
│   │   │   └── billing/    # Stripe billing UI
│   │   └── usage/          # Usage dashboard
│   └── auth/callback/    # OAuth callback

 core/                     # @core/ - Desktop agent
 ├── app/
 │   ├── src-tauri/        # Rust backend
 │   │   ├── main.rs
 │   │   └── lib.rs
 │   └── src/ui/           # React frontend
 ├── core/src/
 │   ├── orchestrator.rs   # Agent coordination
 │   ├── session_registry.rs
 │   └── tracker.rs        # Context tracking
 └── crates/eisen-napi/    # Node bindings
```

## Data Flow

1. User authenticates via @website/ → @auth/ creates session
2. User creates API key on @website/ → stored in @auth/
3. User enters key in @core/ → verified with @auth/
4. @core/ loads workspace from local LibSQL
5. Orchestrator queries repo context from LibSQL to build prompts
6. Agent executes, logs to observer, updates context in LibSQL
