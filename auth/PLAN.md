# eisen-auth Build Plan

Backend-only Bun + Hono server. Handles OAuth, JWT sessions, API key management,
workspace key derivation, and Stripe billing. Consumed by the website frontend
(separate repo), the VS Code extension, and the CLI tool.

---

## Stack

| Concern | Choice |
|---|---|
| Runtime | Bun |
| Framework | Hono |
| Database | NeonDB — Postgres, pooled (pgbouncer) |
| OAuth client | Arctic |
| JWT | jose (Web Crypto, no native addons) |
| Payments | Stripe Node SDK |
| Secrets (prod) | GCP Secret Manager |
| Master key (prod) | GCP Cloud KMS |
| Deploy | GCP Cloud Run |

---

## Directory Layout (final state)

```
eisen-auth/
├── .env.example
├── .gitignore
├── Dockerfile
├── cloudbuild.yaml
├── package.json
├── tsconfig.json
├── PLAN.md
└── src/
    ├── index.ts                  # Bun.serve() entry point
    ├── app.ts                    # Hono app factory, middleware wiring
    ├── env.ts                    # Zod env validation — fails fast on missing vars
    │
    ├── db/
    │   ├── client.ts             # NeonDB pooled client singleton
    │   └── migrations/
    │       ├── 001_users.sql
    │       ├── 002_subscriptions.sql
    │       ├── 003_api_keys.sql
    │       └── 004_workspace_keys.sql
    │
    ├── lib/
    │   ├── apiKey.ts             # generate / hash / verify API keys
    │   ├── jwt.ts                # sign / verify / refresh JWTs
    │   ├── crypto.ts             # HMAC chain, HKDF, AES-GCM wrap
    │   ├── kms.ts                # GCP KMS (prod) / env var fallback (dev)
    │   └── stripe.ts             # Stripe client singleton + webhook verify
    │
    ├── middleware/
    │   ├── requireAuth.ts        # Bearer JWT → ctx.var.user
    │   ├── requireAdmin.ts       # ADMIN_SECRET header guard
    │   └── cors.ts               # Allowed origins from env
    │
    └── routes/
        ├── health.ts             # GET  /health
        ├── auth.ts               # OAuth + session endpoints
        ├── apikeys.ts            # API key CRUD (dashboard users)
        ├── workspace.ts          # POST /workspace/key (extension / CLI)
        └── billing.ts            # Stripe checkout, portal, webhook
```

---

## Consumer Map

| Consumer | Auth mechanism | Endpoints used |
|---|---|---|
| Website frontend (separate repo) | OAuth (Google / GitHub) → JWT | `/auth/google`, `/auth/github`, `/auth/me`, `/apikeys/*`, `/billing/*` |
| VS Code extension | API key → JWT | `/auth/validate`, `/auth/refresh`, `/workspace/key` |
| CLI tool | API key → JWT | same as extension |
| Stripe | Webhook signature | `/billing/webhook` |

---

## Phase 1 — Scaffold, Database, Health Check

**Summary:** Stand up a working Bun + Hono server with environment validation,
a NeonDB pooled connection, all four SQL migrations, and a `/health` endpoint.
No external service credentials required — this phase can run entirely locally.
The output is a server that starts, connects to the DB, and responds to pings.

### Deliverables

- `package.json` with all dependencies declared
- `tsconfig.json`
- `.gitignore`
- `.env.example` — full annotated list of every env var used across all phases
- `src/env.ts` — Zod schema; process exits with a clear message on missing vars
- `src/db/client.ts` — NeonDB `Pool` singleton (pooled connection string)
- `src/db/migrations/` — four SQL files (run manually or via a `bun run migrate` script)
- `src/routes/health.ts` — `GET /health → { status: "ok", ts: <unix_ms> }`
- `src/app.ts` — Hono app with CORS middleware and health route mounted
- `src/index.ts` — `Bun.serve()` entry, logs port on start
- `Dockerfile` — multi-stage, `oven/bun:1` base, Cloud Run compatible (port 8080)

### Database Schema

```sql
-- 001_users.sql
CREATE TABLE users (
  id           TEXT PRIMARY KEY,          -- "usr_<nanoid>"
  email        TEXT UNIQUE NOT NULL,
  provider     TEXT NOT NULL,             -- 'google' | 'github'
  provider_id  TEXT NOT NULL,             -- OAuth subject ID
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (provider, provider_id)
);

-- 002_subscriptions.sql
CREATE TABLE subscriptions (
  user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier                   TEXT NOT NULL DEFAULT 'free',    -- 'free' | 'pro' | 'premium'
  status                 TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'expired' | 'cancelled'
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ DEFAULT now()
);

-- 003_api_keys.sql
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,          -- "key_<nanoid>"
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,             -- user-facing label e.g. "My CLI key"
  prefix       TEXT NOT NULL,             -- first 8 chars of raw key (plaintext, for lookup)
  hash         TEXT NOT NULL,             -- bcrypt hash of full raw key
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ               -- NULL = active
);
CREATE INDEX idx_api_keys_prefix ON api_keys(prefix);
CREATE INDEX idx_api_keys_user   ON api_keys(user_id);

-- 004_workspace_keys.sql
CREATE TABLE workspace_keys (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,             -- SHA-256(user_id + abs_workspace_path)
  key_version  INTEGER NOT NULL DEFAULT 1,
  rotated_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, workspace_id)
);
```

### Environment Variables (Phase 1)

```bash
PORT=3000
NODE_ENV=development
DATABASE_URL=postgres://...@...neon.tech/eisenauth?sslmode=require
ALLOWED_ORIGINS=http://localhost:5173,https://eisenlabs.com
```

---

## Phase 2 — OAuth + JWT Session Auth

**Summary:** Google and GitHub OAuth login flows, JWT issuance, session refresh,
and a `/auth/me` introspection endpoint. After this phase the website frontend
can authenticate users end-to-end: user clicks "Sign in with Google", gets
redirected back to the frontend with a JWT, and all subsequent dashboard API
calls are authenticated. No API key infrastructure yet — that comes next.

### Endpoints

```
GET  /auth/google              → redirect to Google OAuth consent screen
GET  /auth/google/callback     → exchange code → upsert user + subscription row
                                 → redirect to FRONTEND_URL?token=<jwt>

GET  /auth/github              → redirect to GitHub OAuth consent screen
GET  /auth/github/callback     → same pattern as Google

GET  /auth/me                  → Bearer JWT → { userId, email, tier, status }

POST /auth/refresh             → { sessionToken } → new JWT (within 7-day window)

POST /auth/logout              → Bearer JWT → 200 OK
                                 (stateless — client discards token;
                                  token blocklist added if needed later)
```

### JWT Shape

```jsonc
{
  "sub": "usr_abc123",
  "email": "user@example.com",
  "tier": "pro",               // 'free' | 'pro' | 'premium'
  "status": "active",          // 'active' | 'expired' | 'cancelled'
  "exp": 1740086400,           // now + 24h
  "offlineDeadline": 1740604800 // now + 7 days (for extension offline grace)
}
```

### Key Files

- `src/lib/jwt.ts` — `signSession()`, `verifySession()`, `refreshSession()`
- `src/middleware/requireAuth.ts` — extracts Bearer token, attaches `ctx.var.user`
- `src/routes/auth.ts` — all OAuth + session handlers
- Arctic used for OAuth code exchange and profile fetch (no passport)

### Environment Variables (Phase 2, additions)

```bash
JWT_SECRET=                        # openssl rand -hex 32
JWT_EXPIRES_IN=86400               # 24h in seconds
JWT_OFFLINE_WINDOW=604800          # 7 days in seconds

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=http://localhost:3000/auth/github/callback

FRONTEND_URL=http://localhost:5173  # post-OAuth redirect destination
```

---

## Phase 3 — API Key Management

**Summary:** Authenticated dashboard users can create, list, and revoke named
API keys. These keys are the credentials used by the VS Code extension and CLI
to authenticate without a browser. A key is shown in full exactly once at
creation — only a bcrypt hash is stored. This mirrors the UX of providers like
Anthropic and OpenAI. After this phase the extension can be pointed at a
real key and tested against the server.

### Endpoints (all require `Authorization: Bearer <jwt>`)

```
GET    /apikeys          → list active keys for the authed user
                           [{ id, name, prefix, createdAt, lastUsedAt }]
                           hash is never returned

POST   /apikeys          → { name: string }
                           → { id, name, key: "eisen_<raw>" }  — returned ONCE only
                           raw key is not stored; only bcrypt hash persisted

DELETE /apikeys/:id      → revoke key (sets revoked_at = now())
                           only the owning user can revoke their own keys
```

### Key Format

```
eisen_<base58-encoded 32 random bytes>

Example: eisen_3mFGhK9pQrXwNvBzLcTdYs...
```

The `eisen_` prefix makes the key identifiable in leaked-credential scanners
(similar to `sk-ant-`, `sk-`, `ghp_`). The first 8 chars after the prefix are
stored as `prefix` for O(1) DB lookup — no full table scan on every request.

### Key Files

- `src/lib/apiKey.ts` — `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`, `findKeyByPrefix()`
- `src/routes/apikeys.ts` — CRUD handlers

---

## Phase 4 — Extension / CLI Auth and Workspace Key Derivation

**Summary:** The three endpoints the VS Code extension and CLI use. Entry is
via API key (not OAuth — no browser involved). The server validates the key,
issues the same JWT format as OAuth, and can return a workspace-specific
decryption key wrapped so it is safe in transit. The workspace key is derived
server-side via an HMAC chain rooted at the master key — the raw key never
leaves the server. Free-tier users get session tokens but are blocked from
the workspace key endpoint.

### Endpoints

```
POST /auth/validate     → { apiKey }
                          → { valid, userId, sessionToken, expiresAt,
                              offlineDeadline, subscription }
                          updates api_keys.last_used_at

POST /auth/refresh      → { sessionToken }
                          → { sessionToken, expiresAt, offlineDeadline }
                          (same handler as Phase 2 — no changes needed)

POST /workspace/key     → Authorization: Bearer <session_token>
                          body: { workspaceId: "<sha256 hex>" }
                          → { wrappedKey: "<base64>", keyVersion: <int> }
                          403 if subscription tier is 'free'
                          403 if subscription status is not 'active'
```

### Key Derivation (server-side only)

```
masterKey        loaded from GCP KMS (prod) or MASTER_KEY env var (dev)
                 held in module memory as Buffer, never logged

userKey        = HMAC-SHA256(masterKey, userId)
workspaceKey   = HMAC-SHA256(userKey, workspaceId)

wrapKey        = HKDF-SHA256(rawApiKey, salt="eisen-key-wrap", length=32)
wrappedKey     = AES-256-GCM-Encrypt(workspaceKey, key=wrapKey)
               → base64 encoded [ 12-byte IV | ciphertext | 16-byte GCM tag ]
```

The client unwraps using its raw API key. The workspace decryption key is
never stored on the server — it is derived deterministically on every request.

### Key Files

- `src/lib/crypto.ts` — `deriveUserKey()`, `deriveWorkspaceKey()`, `wrapKey()`
- `src/lib/kms.ts` — `getMasterKey()` abstraction (KMS prod / env dev)
- `src/routes/workspace.ts` — `/workspace/key` handler
- `src/routes/auth.ts` — `/auth/validate` added to existing auth router

### Environment Variables (Phase 4, additions)

```bash
# Development
MASTER_KEY=<64 hex chars>              # openssl rand -hex 32

# Production (replaces MASTER_KEY)
GCP_PROJECT_ID=
GCP_KMS_LOCATION=global
GCP_KMS_KEY_RING=eisen-auth
GCP_KMS_KEY_NAME=master-key
```

---

## Phase 5 — Stripe Billing

**Summary:** Stripe Checkout for upgrades, Customer Portal for self-service
billing management, and a webhook handler that keeps the `subscriptions` table
authoritative. Subscription state is the source of truth for tier enforcement
in Phase 4 — Stripe events are what flip a user from `free` to `pro`, and
from `active` to `cancelled`. The webhook endpoint receives a raw (unparsed)
body and verifies the Stripe signature before touching the database.

### Endpoints

```
GET  /billing/plans       → public, no auth
                            → [{ tier, priceId, amount, interval, features }]

POST /billing/checkout    → Bearer JWT
                            body: { tier: 'pro' | 'premium' }
                            creates or reuses Stripe customer for the user
                            → { url: <Stripe Checkout session URL> }

POST /billing/portal      → Bearer JWT
                            → { url: <Stripe Customer Portal session URL> }

POST /billing/webhook     → raw body, Stripe-Signature header
                            NO JWT auth — verified by Stripe signature only
                            → 200 OK (Stripe retries on non-2xx)
```

### Webhook Event Handlers

| Stripe Event | Database Action |
|---|---|
| `checkout.session.completed` | Write `stripe_customer_id`, `stripe_subscription_id`, set `tier`, `status=active`, `current_period_end` |
| `customer.subscription.updated` | Sync `tier`, `status`, `current_period_end` |
| `customer.subscription.deleted` | Set `status=cancelled` |
| `invoice.payment_failed` | Set `status=expired` |

**Note:** The `/billing/webhook` route is registered before the global JSON
body parser in `app.ts`. Hono requires the raw `Request` body for Stripe
signature verification — parsing it as JSON first breaks the HMAC check.

### Key Files

- `src/lib/stripe.ts` — Stripe client singleton, `verifyWebhook()` helper
- `src/routes/billing.ts` — all billing handlers

### Environment Variables (Phase 5, additions)

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_PRICE_ID=price_...
STRIPE_PREMIUM_PRICE_ID=price_...
PUBLIC_URL=https://api.eisenlabs.com   # used for Stripe success/cancel redirect URLs
```

---

## Phase 6 — GCP Cloud Run Deployment

**Summary:** Production container build, Cloud Run service configuration, GCP
KMS wiring for the master key, and a Cloud Build CI/CD pipeline. After this
phase the server is live at a stable HTTPS URL, all secrets are managed via
GCP Secret Manager (not env files), and every push to `main` triggers an
automatic deploy. CORS is locked to production origins.

### Deliverables

- `Dockerfile` — multi-stage, `oven/bun:1`, non-root user, port 8080
- `.dockerignore` — excludes node_modules, .env, .git, markdown
- `cloudbuild.yaml` — build → push → deploy pipeline with Secret Manager refs
- `src/lib/kms.ts` — production path using `@google-cloud/kms`
- `src/middleware/requireAdmin.ts` — `X-Admin-Secret` header guard for admin routes

### GCP Setup Instructions

#### 1. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  cloudkms.googleapis.com \
  secretmanager.googleapis.com \
  containerregistry.googleapis.com
```

#### 2. Create a Cloud KMS key ring and key

```bash
gcloud kms keyrings create eisen-auth --location=global

gcloud kms keys create master-key \
  --location=global \
  --keyring=eisen-auth \
  --purpose=encryption
```

#### 3. Encrypt the master key

```bash
# Generate a 32-byte master key
MASTER_KEY=$(openssl rand -hex 32)

# Encrypt it with Cloud KMS and store the base64 ciphertext
echo -n "$MASTER_KEY" | xxd -r -p | \
  gcloud kms encrypt \
    --location=global \
    --keyring=eisen-auth \
    --key=master-key \
    --plaintext-file=- \
    --ciphertext-file=- | base64 -w0

# The output is the value for MASTER_KEY_CIPHERTEXT
```

#### 4. Store secrets in Secret Manager

```bash
# For each secret:
echo -n "VALUE" | gcloud secrets create SECRET_NAME --data-file=-

# Required secrets:
#   DATABASE_URL, JWT_SECRET, MASTER_KEY_CIPHERTEXT,
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
#   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
#   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
#   ADMIN_SECRET
```

#### 5. Grant Cloud Run service account permissions

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Decrypt master key ciphertext
gcloud kms keys add-iam-policy-binding master-key \
  --location=global \
  --keyring=eisen-auth \
  --member="serviceAccount:${SA}" \
  --role=roles/cloudkms.cryptoKeyDecrypter

# Read secrets
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:${SA}" \
  --role=roles/secretmanager.secretAccessor
```

#### 6. Connect Cloud Build to the repo

```bash
# Trigger on push to main
gcloud builds triggers create github \
  --repo-name=eisen-auth \
  --repo-owner=eisenlabs \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml
```

#### 7. Run migrations against NeonDB

```bash
# From a machine with access to the production DATABASE_URL
DATABASE_URL=<prod-url> JWT_SECRET=<any> bun run migrate
```

### GCP Service Account Roles Required

| Role | Purpose |
|---|---|
| `roles/cloudkms.cryptoKeyDecrypter` | Decrypt master key ciphertext on cold start |
| `roles/secretmanager.secretAccessor` | Read all runtime secrets |

### Cloud Run Configuration

| Setting | Value |
|---|---|
| Port | 8080 |
| CPU | 1 |
| Memory | 512Mi |
| Min instances | 0 (scale to zero) |
| Max instances | 10 |
| Concurrency | 80 |
| Timeout | 30s |

All env vars from `.env.example` are stored as Secret Manager secrets and
injected into the Cloud Run service via `--set-secrets`. Non-secret env vars
(origins, URLs, KMS config) are set via `--set-env-vars`. No `.env` file
exists in production.

The `MASTER_KEY` env var is **not used** in production. Instead,
`MASTER_KEY_CIPHERTEXT` (base64-encoded KMS ciphertext) is decrypted by
`src/lib/kms.ts` on cold start using the Cloud KMS API. The decrypted
32-byte key is held in process memory for the lifetime of the instance.

---

## Implementation Order

```
Phase 1  scaffold + DB + health         no external credentials needed      ✓
Phase 2  OAuth + JWT                    needs Google/GitHub OAuth app        ✓
Phase 3  API key CRUD                   depends on Phase 2                  ✓
Phase 4  workspace/key + crypto         depends on Phase 3                  ✓
Phase 5  Stripe billing                 depends on Phase 2                  ✓
Phase 6  Cloud Run + KMS               deployment infrastructure            ✓
```

All phases complete.
