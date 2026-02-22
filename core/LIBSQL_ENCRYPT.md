# LibSQL Encryption & API Key Authentication

> Protection strategy for the per-workspace LibSQL database described in
> `MASTRA.md` and `HYBRID_MASTRA_DSPY.md`. Users authenticate with an API key,
> the server returns a per-workspace decryption key, and all learned/optimized
> data in `.eisen/workspace.db` is encrypted at the column level. Without a
> valid subscription the database is inert — the encrypted tables are unusable.

---

## Threat Model

**What we are protecting:**

The optimizer (DSPy) and the Mastra runtime accumulate _learned intelligence_
over time — optimized prompts, agent assignment rules, workspace profiles,
region insights. This data is the product of compute (LLM calls, trace
analysis, optimization runs) and represents the core value of a paid
subscription. Without protection, a user could:

1. Copy `.eisen/workspace.db` out of the workspace
2. Cancel their subscription
3. Continue using the learned data with their own LLM setup

**What we are NOT protecting:**

Tables that are trivially reproducible from the filesystem or git history
(parse caches, file metadata, co-change counts, commit logs). These are
convenience caches — losing them costs a few seconds of re-parsing, not
months of accumulated learning.

---

## Subscription Tiers

| Tier        | Orchestration                                    | Learned Context                                                                                            | Optimizer                  | DB Encryption                              |
| ----------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------ |
| **Free**    | Full Mastra workflow with static default prompts | None — `optimized_prompts`, `assignment_rules`, `workspace_profile`, `region_insights` are absent or empty | No access                  | Not applied (no sensitive data to protect) |
| **Pro**     | Full Mastra workflow + learned context injection | All four tables populated and decryptable                                                                  | BootstrapFewShot           | Column-level AES-256-GCM                   |
| **Premium** | Same as Pro                                      | Same as Pro                                                                                                | BootstrapFewShot + MIPROv2 | Same as Pro                                |

Free users get the complete orchestration pipeline — decompose, assign,
build, execute, evaluate. They just never accumulate learned behaviour.
The agent works; it just does not improve over time.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  VS Code Extension (User Machine)                           │
│                                                             │
│  1. User enters API key (once) → VS Code SecretStorage      │
│  2. Extension calls POST /auth/validate with API key        │
│  3. Server returns session_token (JWT, 24h TTL)             │
│  4. Extension calls POST /workspace/key with session_token  │
│     + workspace_id                                          │
│  5. Server returns workspace decryption key (encrypted      │
│     with user's API key so it is safe in transit)           │
│  6. Extension unwraps key, holds in memory only             │
│  7. All reads/writes to encrypted tables use this key       │
│                                                             │
│  On deactivate or after 24h (whichever first):              │
│     - Decryption key cleared from memory                    │
│     - Session token remains in SecretStorage for re-auth    │
│                                                             │
│  After 7 days offline:                                      │
│     - Session token expires, user must re-authenticate      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                     HTTPS (TLS 1.3)
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  eisen-auth  (separate repo / self-hosted server)           │
│                                                             │
│  POST /auth/validate                                        │
│    ← API key                                                │
│    → session_token, subscription tier, expiry               │
│                                                             │
│  POST /workspace/key                                        │
│    ← session_token + workspace_id                           │
│    → encrypted workspace decryption key + key_version       │
│                                                             │
│  Key derivation (server-side, never exposed):               │
│    master_key         → HSM / KMS                           │
│    user_key           = HMAC-SHA256(master_key, user_id)    │
│    workspace_key      = HMAC-SHA256(user_key, workspace_id) │
│    wrapped_key        = AES-256-GCM(workspace_key, api_key) │
│                                                             │
│  POST /auth/refresh                                         │
│    ← session_token (within 7-day window)                    │
│    → new session_token                                      │
└─────────────────────────────────────────────────────────────┘
```

### Workspace ID Derivation

Each workspace is identified by a deterministic, collision-resistant hash:

```
workspace_id = SHA-256(user_id + absolute_workspace_path)
```

This means:

- Same user, different workspace → different key
- Different user, same codebase → different key
- Moving a workspace directory invalidates the key (re-auth re-derives)

---

## Encrypted vs Plaintext Tables

### Encrypted (column-level, AES-256-GCM)

These tables contain accumulated intelligence that required compute to
produce. They are the value proposition of a paid subscription.

| Table               | What is encrypted                                                                             | What stays plaintext                                                                |
| ------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `optimized_prompts` | `system_prompt`, `few_shot_json` → single `encrypted_payload` BLOB                            | `target_step`, `strategy`, `version`, `compiled_at`, `trace_count`, `quality_delta` |
| `assignment_rules`  | `region_pattern`, `preferred_agent`, `task_type` → single `encrypted_rule` BLOB               | `confidence`, `sample_count`, `created_at`                                          |
| `workspace_profile` | `tech_stack`, `conventions`, `architecture`, `common_tasks` → single `encrypted_profile` BLOB | `workspace_path`, `updated_at`                                                      |
| `region_insights`   | `description`, `conventions`, `dependencies` → single `encrypted_insight` BLOB                | `region`, `last_updated`                                                            |

Plaintext columns are kept for indexing, querying, and staleness detection.
They contain no proprietary logic — just metadata (timestamps, scores,
counts) that are useless without the encrypted payloads.

### Plaintext (no encryption)

These tables are reproducible from the filesystem and git history. Encrypting
them would add latency for zero security benefit.

| Table                 | Reason                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| `workspace_snapshots` | Re-derive via `eisen.parseWorkspace()` in seconds                      |
| `file_meta`           | Re-derive from filesystem `stat()` calls                               |
| `git_patterns`        | Re-derive from `git log`                                               |
| `file_cochange`       | Re-derive from `git_patterns`                                          |
| `task_history`        | Execution logs — useful for optimizer but not proprietary on their own |
| `agent_performance`   | Aggregate counts — meaningful only with `assignment_rules`             |
| `symbol_cache`        | Re-derive via `eisen.lookupSymbol()`                                   |

---

## Schema Modifications

The base schema from `MASTRA.md` is unchanged for plaintext tables. The
optimizer tables from `HYBRID_MASTRA_DSPY.md` gain encryption columns:

```sql
-- Optimized prompts. Sensitive columns collapsed into encrypted_payload.
CREATE TABLE IF NOT EXISTS optimized_prompts (
  target_step       TEXT PRIMARY KEY,   -- 'decompose' | 'assign' | 'prompt_build_*'
  encrypted_payload BLOB NOT NULL,      -- AES-256-GCM({ system_prompt, few_shot_json })
  strategy          TEXT NOT NULL,      -- 'bootstrap' | 'mipro'
  version           INTEGER NOT NULL DEFAULT 1,
  compiled_at       INTEGER NOT NULL,   -- unix ms
  trace_count       INTEGER NOT NULL,
  quality_delta     REAL,
  key_version       INTEGER NOT NULL DEFAULT 1
);

-- Learned agent assignment rules. Sensitive columns in encrypted_rule.
CREATE TABLE IF NOT EXISTS assignment_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  encrypted_rule  BLOB NOT NULL,        -- AES-256-GCM({ region_pattern, language,
                                        --   task_type, preferred_agent })
  confidence      REAL NOT NULL,
  sample_count    INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,     -- unix ms
  key_version     INTEGER NOT NULL DEFAULT 1
);

-- Workspace profile. Sensitive columns in encrypted_profile.
CREATE TABLE IF NOT EXISTS workspace_profile (
  workspace_path    TEXT PRIMARY KEY,
  encrypted_profile BLOB NOT NULL,      -- AES-256-GCM({ tech_stack, conventions,
                                        --   architecture, common_tasks })
  updated_at        INTEGER NOT NULL,   -- unix ms
  key_version       INTEGER NOT NULL DEFAULT 1
);

-- Region insights. Sensitive columns in encrypted_insight.
CREATE TABLE IF NOT EXISTS region_insights (
  region            TEXT PRIMARY KEY,
  encrypted_insight BLOB NOT NULL,      -- AES-256-GCM({ description, conventions,
                                        --   dependencies })
  last_updated      INTEGER NOT NULL,   -- unix ms
  key_version       INTEGER NOT NULL DEFAULT 1
);
```

Each encrypted BLOB is structured as:

```
[ 12-byte IV ][ ciphertext ][ 16-byte GCM auth tag ]
```

The `key_version` column enables key rotation — the client detects version
mismatches and re-encrypts on first write after a rotation.

---

## Authentication Flow

### First-time setup

```
1. User installs extension, runs any Eisen command
2. Extension checks SecretStorage for existing API key
3. None found → show input prompt: "Enter your Eisen API key"
4. User pastes API key
5. Extension calls POST /auth/validate { apiKey }
6. Server validates key, returns:
   {
     valid: true,
     sessionToken: "<JWT>",
     expiresAt: <unix_ms>,         // 24h from now
     offlineDeadline: <unix_ms>,   // 7 days from now
     subscription: {
       tier: "pro" | "premium" | "free",
       status: "active" | "expired" | "cancelled"
     }
   }
7. Extension stores API key in SecretStorage (OS keychain)
8. Extension stores session token in SecretStorage
9. Extension calls POST /workspace/key {
     sessionToken,
     workspaceId: SHA256(userId + workspacePath)
   }
10. Server returns:
    {
      wrappedKey: "<base64>",       // AES-256-GCM(workspace_key, api_key)
      keyVersion: 1
    }
11. Extension unwraps key using API key → workspace_key (Buffer)
12. workspace_key held in memory only — never written to disk
13. Extension initialises SecureWorkspaceDB with workspace_key
```

### Subsequent sessions (within 24h)

```
1. Extension activates
2. Reads session token from SecretStorage
3. Token not expired → calls POST /workspace/key directly
4. Unwraps key → ready
```

### Subsequent sessions (24h–7d, offline OK)

```
1. Extension activates
2. Reads session token from SecretStorage
3. Token expired but within 7-day offline deadline
4. Attempts POST /auth/refresh { sessionToken }
5. If online → new token, fetch workspace key
6. If offline → use cached session token to derive a temporary
   read-only key (see "Offline Mode" below)
```

### After 7 days offline

```
1. Extension activates
2. Session token expired, offline deadline passed
3. Prompt user to re-enter API key
4. Full re-authentication flow
```

### Subscription expired or cancelled

```
1. POST /auth/validate returns { subscription: { status: "expired" } }
2. Extension clears workspace key from memory
3. Encrypted tables become unreadable
4. Graceful fallback to free-tier defaults (static prompts, no learned context)
5. Status bar shows "Eisen Free — Upgrade to unlock learned optimizations"
6. Plaintext tables (caches, task_history) remain fully functional
```

---

## Offline Mode

The 7-day offline grace period works as follows:

- On each successful server authentication, the extension stores:
  - `session_token` → SecretStorage (encrypted by OS keychain)
  - `offlineDeadline` → SecretStorage (unix ms, 7 days from auth)
  - `cachedKeyMaterial` → SecretStorage (the wrapped workspace key)

- When offline and within the 7-day window:
  - Extension unwraps `cachedKeyMaterial` using the API key from SecretStorage
  - Full read/write access to encrypted tables
  - A "Working offline" indicator appears in the status bar

- When offline and past the 7-day window:
  - Cached key material is invalidated
  - Falls back to free-tier behaviour
  - Prompts user to connect to the internet and re-authenticate

- The workspace decryption key (unwrapped) is **never** persisted to disk.
  It is derived from `cachedKeyMaterial` + `apiKey` at extension activation
  and held in memory only. On extension deactivate, it is cleared.

---

## Key Lifecycle

### Key derivation (server-side — `eisen-auth`)

```
master_key         stored in HSM / AWS KMS / equivalent
                   never leaves the secure boundary

user_key         = HMAC-SHA256(master_key, user_id)
                   deterministic, one per user

workspace_key    = HMAC-SHA256(user_key, workspace_id)
                   deterministic, one per user+workspace pair

wrapped_key      = AES-256-GCM-Encrypt(workspace_key, key=api_key_derived)
                   this is what travels over the wire
```

`api_key_derived` is `HKDF-SHA256(api_key, salt="eisen-key-wrap", length=32)`.
This ensures the raw API key is never used directly as an encryption key.

### Key rotation

1. Server bumps `key_version` for a workspace (admin action or scheduled)
2. Next `POST /workspace/key` returns the new key + new `key_version`
3. Client detects `key_version` mismatch on read (row version != current)
4. Client decrypts with old key (server provides both during rotation window)
5. Client re-encrypts with new key and updates `key_version` on the row
6. Old key remains valid for a 7-day rotation window, then revoked

### Key clearing

The workspace decryption key is cleared from memory when **any** of these
conditions is met (whichever comes first):

- Extension deactivates (VS Code closes or extension is disabled)
- 24 hours since the key was fetched
- User explicitly signs out (`eisen.logout` command)
- Subscription status changes to expired/cancelled (detected on next server call)

---

## Extension Integration

### New modules

```
extension/src/
  auth/
    authManager.ts          -- Session lifecycle, token refresh, key fetch
    keyStorage.ts           -- SecretStorage wrapper for API key + tokens
    apiClient.ts            -- HTTP client for Eisen Auth API
    types.ts                -- AuthSession, WorkspaceKeyResponse, etc.
  db/
    secureDatabase.ts       -- Encrypted read/write wrapper over libsql
    encryption.ts           -- AES-256-GCM encrypt/decrypt utilities
    schema.ts               -- Table creation + migration logic
```

### New commands (package.json)

```json
{
  "command": "eisen.authenticate",
  "title": "Eisen: Sign In"
},
{
  "command": "eisen.logout",
  "title": "Eisen: Sign Out"
},
{
  "command": "eisen.checkSubscription",
  "title": "Eisen: Subscription Status"
}
```

### Activation sequence (extension.ts)

```typescript
export async function activate(context: vscode.ExtensionContext) {
  const auth = new AuthManager(context);
  const session = await auth.restoreOrPrompt();

  // Free tier: no encryption, no learned context
  if (session.subscription.tier === "free") {
    const db = new PlainWorkspaceDB(workspaceDbPath);
    const orchestrator = new EisenOrchestrator(db, { learnedContext: false });
    // ... register commands, views
    return;
  }

  // Pro/Premium: fetch workspace key, init encrypted DB
  const workspaceKey = await auth.getWorkspaceKey(workspacePath);
  const db = new SecureWorkspaceDB(workspaceDbPath, workspaceKey);
  const orchestrator = new EisenOrchestrator(db, { learnedContext: true });

  // Clear key on deactivate
  context.subscriptions.push({
    dispose: () => {
      workspaceKey.fill(0); // Zero out key buffer
      auth.clearSession();
    },
  });

  // ... register commands, views
}
```

### Status bar

```
Pro user, online:     $(key) Eisen Pro
Pro user, offline:    $(key) Eisen Pro (offline — 5d remaining)
Free user:            $(key) Eisen Free
Expired:              $(warning) Eisen — subscription expired
```

---

## Encryption Implementation

### AES-256-GCM utilities

```typescript
// extension/src/db/encryption.ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  // [ IV (12) ][ ciphertext (variable) ][ auth tag (16) ]
  return Buffer.concat([iv, encrypted, tag]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH, blob.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
```

### Secure database wrapper

```typescript
// extension/src/db/secureDatabase.ts
import { createClient } from "@mastra/libsql";
import { encrypt, decrypt } from "./encryption";

export class SecureWorkspaceDB {
  private db: ReturnType<typeof createClient>;
  private key: Buffer;
  private keyVersion: number;

  constructor(dbPath: string, key: Buffer, keyVersion: number = 1) {
    this.db = createClient({ url: `file:${dbPath}` });
    this.key = key;
    this.keyVersion = keyVersion;
  }

  // --- optimized_prompts ---

  async writeOptimizedPrompt(data: {
    target_step: string;
    system_prompt: string;
    few_shot_json: string;
    strategy: string;
    version: number;
    compiled_at: number;
    trace_count: number;
    quality_delta: number | null;
  }): Promise<void> {
    const payload = JSON.stringify({
      system_prompt: data.system_prompt,
      few_shot_json: data.few_shot_json,
    });

    const encrypted = encrypt(payload, this.key);

    await this.db.execute({
      sql: `INSERT OR REPLACE INTO optimized_prompts
            (target_step, encrypted_payload, strategy, version,
             compiled_at, trace_count, quality_delta, key_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.target_step,
        encrypted,
        data.strategy,
        data.version,
        data.compiled_at,
        data.trace_count,
        data.quality_delta,
        this.keyVersion,
      ],
    });
  }

  async readOptimizedPrompt(targetStep: string): Promise<{
    system_prompt: string;
    few_shot_json: string;
  } | null> {
    const row = await this.db.execute({
      sql: `SELECT encrypted_payload, key_version FROM optimized_prompts
            WHERE target_step = ?`,
      args: [targetStep],
    });

    if (!row.rows.length) return null;

    const blob = row.rows[0].encrypted_payload as Buffer;
    const decrypted = decrypt(blob, this.key);
    return JSON.parse(decrypted);
  }

  // --- assignment_rules ---

  async writeAssignmentRule(data: {
    region_pattern: string;
    language: string;
    task_type: string;
    preferred_agent: string;
    confidence: number;
    sample_count: number;
  }): Promise<void> {
    const rule = JSON.stringify({
      region_pattern: data.region_pattern,
      language: data.language,
      task_type: data.task_type,
      preferred_agent: data.preferred_agent,
    });

    const encrypted = encrypt(rule, this.key);

    await this.db.execute({
      sql: `INSERT INTO assignment_rules
            (encrypted_rule, confidence, sample_count, created_at, key_version)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        encrypted,
        data.confidence,
        data.sample_count,
        Date.now(),
        this.keyVersion,
      ],
    });
  }

  async readAssignmentRules(
    minConfidence: number = 0.75,
    minSamples: number = 3,
  ): Promise<
    Array<{
      region_pattern: string;
      language: string;
      task_type: string;
      preferred_agent: string;
      confidence: number;
      sample_count: number;
    }>
  > {
    const result = await this.db.execute({
      sql: `SELECT encrypted_rule, confidence, sample_count FROM assignment_rules
            WHERE confidence > ? AND sample_count >= ?
            ORDER BY confidence DESC`,
      args: [minConfidence, minSamples],
    });

    return result.rows.map((row) => {
      const decrypted = JSON.parse(
        decrypt(row.encrypted_rule as Buffer, this.key),
      );
      return {
        ...decrypted,
        confidence: row.confidence as number,
        sample_count: row.sample_count as number,
      };
    });
  }

  // --- region_insights ---

  async writeRegionInsight(
    region: string,
    data: {
      description: string;
      conventions: string;
      dependencies: string;
    },
  ): Promise<void> {
    const encrypted = encrypt(JSON.stringify(data), this.key);

    await this.db.execute({
      sql: `INSERT OR REPLACE INTO region_insights
            (region, encrypted_insight, last_updated, key_version)
            VALUES (?, ?, ?, ?)`,
      args: [region, encrypted, Date.now(), this.keyVersion],
    });
  }

  async readRegionInsight(region: string): Promise<{
    description: string;
    conventions: string;
    dependencies: string;
  } | null> {
    const result = await this.db.execute({
      sql: `SELECT encrypted_insight FROM region_insights WHERE region = ?`,
      args: [region],
    });

    if (!result.rows.length) return null;

    return JSON.parse(
      decrypt(result.rows[0].encrypted_insight as Buffer, this.key),
    );
  }

  // --- workspace_profile ---

  async writeWorkspaceProfile(
    workspacePath: string,
    data: {
      tech_stack: string;
      conventions: string;
      architecture: string;
      common_tasks: string;
    },
  ): Promise<void> {
    const encrypted = encrypt(JSON.stringify(data), this.key);

    await this.db.execute({
      sql: `INSERT OR REPLACE INTO workspace_profile
            (workspace_path, encrypted_profile, updated_at, key_version)
            VALUES (?, ?, ?, ?)`,
      args: [workspacePath, encrypted, Date.now(), this.keyVersion],
    });
  }

  async readWorkspaceProfile(workspacePath: string): Promise<{
    tech_stack: string;
    conventions: string;
    architecture: string;
    common_tasks: string;
  } | null> {
    const result = await this.db.execute({
      sql: `SELECT encrypted_profile FROM workspace_profile
            WHERE workspace_path = ?`,
      args: [workspacePath],
    });

    if (!result.rows.length) return null;

    return JSON.parse(
      decrypt(result.rows[0].encrypted_profile as Buffer, this.key),
    );
  }

  dispose(): void {
    this.key.fill(0); // Zero out key material
  }
}
```

---

## Mastra Workflow Integration

The existing workflow steps from `MASTRA.md` are modified to accept either a
`SecureWorkspaceDB` (pro/premium) or a `PlainWorkspaceDB` (free). The
interface is identical — the encryption is transparent to the workflow logic.

### loadWorkspaceContext (modified)

```typescript
// Free tier: context has no learned data
// Pro/Premium: context includes decrypted optimized prompts, rules, profile

async function loadWorkspaceContext(
  db: WorkspaceDB,
  workspacePath: string,
  userIntent: string,
) {
  // Always available (plaintext tables)
  const taskHistory = await db.getRecentTaskHistory(userIntent);
  const cochangeHints = await db.getCochangeHints(affectedRegions);
  const agentPerformance = await db.getAgentPerformance(regions, languages);

  // Only available for pro/premium (encrypted tables)
  const optimizedPrompts =
    (await db.readOptimizedPrompt?.("decompose")) ?? null;
  const assignmentRules = (await db.readAssignmentRules?.()) ?? [];
  const workspaceProfile =
    (await db.readWorkspaceProfile?.(workspacePath)) ?? null;
  const regionInsights = (await db.readRegionInsights?.(affectedRegions)) ?? [];

  return {
    // Plaintext context (all tiers)
    taskHistory,
    cochangeHints,
    agentPerformance,

    // Encrypted context (pro/premium only, null/empty for free)
    decomposeSystemPrompt:
      optimizedPrompts?.system_prompt ?? DEFAULT_DECOMPOSE_PROMPT,
    decomposeFewShot: optimizedPrompts
      ? JSON.parse(optimizedPrompts.few_shot_json)
      : [],
    assignmentRules,
    workspaceProfile,
    regionInsights,
  };
}
```

### assignAgents (modified)

```typescript
async function assignAgents(subtask: Subtask, context: WorkspaceContext) {
  // Pro/Premium: check learned rules first (encrypted table)
  if (context.assignmentRules.length > 0) {
    const rule = context.assignmentRules.find((r) =>
      micromatch.isMatch(subtask.region, r.region_pattern),
    );

    if (rule) {
      return {
        agentId: rule.preferred_agent,
        reasoning:
          `Learned rule (${rule.sample_count} observations, ` +
          `${rule.confidence.toFixed(2)} confidence)`,
        source: "learned-rule",
      };
    }
  }

  // All tiers: fall back to LLM call
  return await assignAgentLLM(subtask, context);
}
```

---

## Optimizer Integration (HYBRID_MASTRA_DSPY.md)

The offline DSPy optimizer writes to encrypted tables via the same
`SecureWorkspaceDB` interface. The optimizer receives the workspace key
through the same auth flow:

```python
# optimizer/src/eisen_optimizer/db.py
#
# The optimizer CLI authenticates with the same API key and fetches
# the workspace key before writing. It uses the Python libsql-client
# and the same AES-256-GCM scheme.

class OptimizerDB:
    def __init__(self, db_path: str, encryption_key: bytes, key_version: int):
        self.db = libsql_client.create_client(url=f"file:{db_path}")
        self.key = encryption_key
        self.key_version = key_version

    def write_optimized_prompt(self, target_step: str, system_prompt: str,
                                few_shot_json: str, strategy: str, ...):
        payload = json.dumps({
            "system_prompt": system_prompt,
            "few_shot_json": few_shot_json,
        })
        encrypted = aes_gcm_encrypt(payload.encode(), self.key)
        self.db.execute(
            "INSERT OR REPLACE INTO optimized_prompts ...",
            [target_step, encrypted, strategy, ..., self.key_version]
        )
```

The optimizer CLI authenticates before running:

```
python -m eisen_optimizer --workspace /path/to/project --api-key <key>
```

Or reads the API key from the `EISEN_API_KEY` environment variable.

---

## Auth API Specification (`eisen-auth` repo)

> This section belongs to the **`eisen-auth`** repository — a standalone,
> self-hosted server that can be deployed independently of `eisen-core`.
> Everything below documents the HTTP contract that the extension client
> (`extension/src/auth/apiClient.ts`) expects. The server implementation
> lives in `eisen-auth`; only the contract is pinned here.

### POST /auth/validate

Validates an API key and returns a session.

```
Request:
  POST https://api.eisenlabs.com/auth/validate
  Content-Type: application/json

  {
    "apiKey": "eisen_sk_abc123..."
  }

Response (200):
  {
    "valid": true,
    "userId": "usr_abc123",
    "sessionToken": "<JWT>",
    "expiresAt": 1740000000000,
    "offlineDeadline": 1740604800000,
    "subscription": {
      "tier": "pro",
      "status": "active"
    }
  }

Response (401):
  {
    "valid": false,
    "error": "Invalid API key"
  }
```

### POST /workspace/key

Returns a workspace-specific decryption key, wrapped with the user's API key.

```
Request:
  POST https://api.eisenlabs.com/workspace/key
  Content-Type: application/json
  Authorization: Bearer <session_token>

  {
    "workspaceId": "sha256hex..."
  }

Response (200):
  {
    "wrappedKey": "<base64 encoded AES-256-GCM ciphertext>",
    "keyVersion": 1
  }

Response (403):
  {
    "error": "Subscription does not include encrypted storage"
  }
```

### POST /auth/refresh

Refreshes an expired session token within the 7-day offline window.

```
Request:
  POST https://api.eisenlabs.com/auth/refresh
  Content-Type: application/json

  {
    "sessionToken": "<expired JWT>"
  }

Response (200):
  {
    "sessionToken": "<new JWT>",
    "expiresAt": 1740086400000,
    "offlineDeadline": 1740604800000
  }

Response (401):
  {
    "error": "Offline deadline exceeded, re-authentication required"
  }
```

---

## Security Properties

| Property                        | How it is achieved                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| DB useless without subscription | Encrypted columns require workspace key from server                                                     |
| Key never on disk               | Held in memory only; cleared on deactivate or 24h timeout                                               |
| API key protected at rest       | VS Code SecretStorage (OS keychain: Keychain on macOS, libsecret on Linux, Credential Vault on Windows) |
| Transit security                | All API calls over HTTPS (TLS 1.3); workspace key additionally wrapped with API key                     |
| Key rotation                    | `key_version` column per row; client re-encrypts transparently during rotation window                   |
| Offline resilience              | 7-day grace period using cached wrapped key material in SecretStorage                                   |
| Subscription enforcement        | Server refuses to issue workspace key for expired/cancelled subscriptions                               |
| Free tier unaffected            | No encryption applied; plaintext tables work normally; no server dependency                             |
| Tamper detection                | AES-256-GCM authentication tag rejects any modified ciphertext                                          |
| Per-workspace isolation         | Different key per workspace; compromise of one does not affect others                                   |

---

## Migration: Existing Users Upgrading to Pro

When a free user upgrades to pro for the first time on an existing workspace:

1. Extension detects: encrypted tables exist but have no `encrypted_payload`
   (or tables do not exist yet)
2. Extension runs schema migration: adds `encrypted_payload`, `encrypted_rule`,
   `encrypted_insight`, `encrypted_profile`, `key_version` columns
3. If any plaintext learned data exists from a prior beta period, encrypt it
   in-place using the new workspace key
4. Mark migration complete in a `_meta` table:
   ```sql
   CREATE TABLE IF NOT EXISTS _meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   INSERT OR REPLACE INTO _meta (key, value)
   VALUES ('encryption_migrated_at', '<unix_ms>');
   ```

---

## Dependencies

### Extension (added to package.json)

| Package          | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `@mastra/libsql` | LibSQL client (already planned in `MASTRA.md`) |

No additional dependencies. `node:crypto` provides AES-256-GCM natively.
VS Code's `SecretStorage` API provides secure key storage natively.

### Optimizer (added to pyproject.toml)

| Package        | Purpose                                |
| -------------- | -------------------------------------- |
| `cryptography` | AES-256-GCM for Python-side encryption |

`libsql-client` is already a dependency per `HYBRID_MASTRA_DSPY.md`.

---

## Implementation Order

1. **`extension/src/db/encryption.ts`** — AES-256-GCM encrypt/decrypt utilities
2. **`extension/src/db/schema.ts`** — Table creation with encrypted columns
3. **`extension/src/db/secureDatabase.ts`** — Encrypted read/write wrapper
4. **`extension/src/auth/types.ts`** — TypeScript interfaces
5. **`extension/src/auth/keyStorage.ts`** — SecretStorage wrapper
6. **`extension/src/auth/apiClient.ts`** — Eisen Auth API HTTP client
7. **`extension/src/auth/authManager.ts`** — Session lifecycle, key fetch,
   offline handling
8. **Wire into `extension.ts`** — Auth check on activation, key inject into DB
9. **Add commands** — `eisen.authenticate`, `eisen.logout`,
   `eisen.checkSubscription`
10. **Status bar** — Auth state indicator
11. **Optimizer update** — Add encryption to Python `db.py`

Steps 1-3 can proceed independently of the auth API server implementation.
Steps 4-7 require the API contract above but not a running server (mock in
tests). Step 8+ requires the full integration.

---

## Related Documents

- `MASTRA.md` — Base LibSQL schema and Mastra workflow architecture
- `HYBRID_MASTRA_DSPY.md` — Offline DSPy optimizer and additional schema tables
- `TODO.md` — Actionable checklist (add encryption tasks to this)
