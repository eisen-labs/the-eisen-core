# Frontend Integration Guide

Base URL: `https://auth.eisenlabs.com`

All authenticated endpoints require:
```
Authorization: Bearer <sessionToken>
Content-Type: application/json
```

---

## Authentication

### OAuth Login

Redirect the user's browser to one of these URLs. No API call needed — it is a full browser navigation.

```
GET /auth/google
GET /auth/github
```

After the OAuth flow completes, the user is redirected back to:
```
<FRONTEND_URL>/auth/callback?code=<one-time-code>
```

**The code expires in 60 seconds and is single-use.** Exchange it immediately on page load.

---

### POST /auth/exchange

Exchange the one-time OAuth code for a session token. Call this as the first thing on `/auth/callback`.

**Request**
```json
{ "code": "string" }
```

**Response `200`**
```json
{
  "sessionToken": "string",
  "expiresAt": 1234567890000,
  "offlineDeadline": 1234567890000
}
```
- `expiresAt` — unix milliseconds when the JWT expires (default 24 hours)
- `offlineDeadline` — unix milliseconds after which refresh is no longer allowed (default 7 days)

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `400` | `{ "error": "code is required" }` | Missing body field |
| `401` | `{ "error": "Invalid or expired code" }` | Code already used, never existed, or >60s old |

---

### POST /auth/refresh

Refresh an expired session token. Works up until `offlineDeadline`. After that the user must log in again.

**Request**
```json
{ "sessionToken": "string" }
```

**Response `200`**
```json
{
  "sessionToken": "string",
  "expiresAt": 1234567890000,
  "offlineDeadline": 1234567890000
}
```

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `400` | `{ "error": "sessionToken is required" }` | Missing body field |
| `401` | `{ "error": "Offline deadline exceeded, re-authentication required" }` | Must log in again |

---

### GET /auth/me

Returns the current user's profile with live subscription state from the database. Use this to hydrate the UI after login or on page load.

**Auth:** required

**Response `200`**
```json
{
  "userId": "usr_abc123",
  "email": "user@example.com",
  "subscription": {
    "tier": "free | pro | premium",
    "status": "active | expired | cancelled"
  }
}
```

---

### POST /auth/logout

Revokes the current session token server-side. The token cannot be used or refreshed after this call. Clear it from local storage on the client after a successful response.

**Auth:** required

**Response `200`**
```json
{ "ok": true }
```

---

## API Keys

### GET /apikeys

List all active API keys for the current user. The raw key value is never returned after creation.

**Auth:** required

**Response `200`**
```json
{
  "keys": [
    {
      "id": "key_abc123",
      "name": "My VS Code key",
      "prefix": "eisen_abcd1234",
      "createdAt": "2024-01-01T00:00:00Z",
      "lastUsedAt": "2024-01-15T12:00:00Z"
    }
  ]
}
```

---

### POST /apikeys

Create a new API key. The raw key is returned **once only** — store it immediately, it cannot be retrieved again. Maximum 10 active keys per user.

**Auth:** required

**Request**
```json
{ "name": "string" }
```
- `name` — max 100 characters, required

**Response `201`**
```json
{
  "id": "key_abc123",
  "name": "My VS Code key",
  "key": "eisen_<43 random chars>"
}
```

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `400` | `{ "error": "name is required" }` | Missing or blank name |
| `400` | `{ "error": "name must be 100 characters or fewer" }` | Name too long |
| `400` | `{ "error": "Maximum of 10 active API keys per user" }` | Key limit reached |

---

### DELETE /apikeys/:id

Revoke an API key by ID. Revoked keys cannot be used. The action is permanent.

**Auth:** required

**Response `200`**
```json
{ "ok": true, "id": "key_abc123" }
```

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `404` | `{ "error": "API key not found or already revoked" }` | Wrong ID or already revoked |

---

## Billing

### GET /billing/plans

Returns plan metadata. Public — no auth required. Use this to render the pricing page.

**Response `200`**
```json
{
  "plans": [
    {
      "tier": "free",
      "price": 0,
      "interval": null,
      "features": ["..."]
    },
    {
      "tier": "pro",
      "priceId": "price_xxx",
      "price": null,
      "interval": "month",
      "features": ["..."]
    },
    {
      "tier": "premium",
      "priceId": "price_xxx",
      "price": null,
      "interval": "month",
      "features": ["..."]
    }
  ]
}
```

`price` is `null` for paid tiers — fetch the live price from Stripe using the `priceId` if you need to display it.

---

### POST /billing/checkout

Create a Stripe Checkout session for upgrading to a paid plan. Redirect the user to the returned URL.

**Auth:** required

**Request**
```json
{ "tier": "pro | premium" }
```

**Response `200`**
```json
{ "url": "https://checkout.stripe.com/..." }
```

After Stripe Checkout completes, the user lands on `<FRONTEND_URL>/billing/success?session_id=<id>`. On cancel they land on `<FRONTEND_URL>/billing/cancel`. Subscription state is updated automatically via webhook — call `GET /auth/me` to refresh it.

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `400` | `{ "error": "tier must be 'pro' or 'premium'" }` | Invalid tier |

---

### POST /billing/portal

Create a Stripe Customer Portal session for managing an existing subscription (cancel, change plan, update payment). Redirect the user to the returned URL.

**Auth:** required

**Response `200`**
```json
{ "url": "https://billing.stripe.com/..." }
```

After leaving the portal, Stripe returns the user to `<FRONTEND_URL>/billing`.

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `400` | `{ "error": "No billing account found. Subscribe to a plan first." }` | User has never subscribed |

---

## Workspace Keys

### POST /workspace/key

Fetch the encrypted workspace key for a given workspace. Only available to `pro` and `premium` users with an `active` subscription.

The returned key is wrapped (XOR-encrypted) with a key derived from the user's raw API key. The client must unwrap it locally before use.

**Auth:** required (JWT + API key)

**Request**
```json
{
  "workspaceId": "<64 hex chars — SHA-256 of the workspace path>",
  "apiKey": "eisen_<raw key>"
}
```

**Response `200`**
```json
{
  "wrappedKey": "<hex string>",
  "keyVersion": 1
}
```

- `wrappedKey` — XOR of the 32-byte workspace key with a 32-byte wrap key derived from the API key via HKDF
- `keyVersion` — increments on admin key rotation; cache the key locally keyed by `(workspaceId, keyVersion)`

**Errors**
| Status | Body | Meaning |
|--------|------|---------|
| `400` | `{ "error": "workspaceId is required" }` | Missing field |
| `400` | `{ "error": "workspaceId must be a SHA-256 hex string (64 chars)" }` | Wrong format |
| `400` | `{ "error": "apiKey is required for key wrapping" }` | Missing field |
| `401` | `{ "error": "Invalid API key" }` | Key invalid or belongs to different user |
| `403` | `{ "error": "Subscription does not include encrypted storage" }` | Free tier |
| `403` | `{ "error": "Subscription is expired" }` | Subscription lapsed |

---

## Common Error Responses

All authenticated endpoints return these when auth fails:

| Status | Body | Action |
|--------|------|--------|
| `401` | `{ "error": "Missing or malformed Authorization header" }` | Attach `Authorization: Bearer <token>` |
| `401` | `{ "error": "Invalid or expired token" }` | Token expired — call `POST /auth/refresh` |
| `401` | `{ "error": "Token has been revoked" }` | User logged out — redirect to login |
| `429` | `{ "error": "Too many requests" }` | Back off, check `Retry-After` response header |

---

## Session Management Flow

```
1. User clicks "Login with Google/GitHub"
   → navigate to GET /auth/google or GET /auth/github

2. OAuth completes, server redirects to /auth/callback?code=<code>
   → immediately call POST /auth/exchange with the code
   → store { sessionToken, expiresAt, offlineDeadline } in local storage

3. Attach to every API call:
   Authorization: Bearer <sessionToken>

4. When a request returns 401 "Invalid or expired token":
   → if Date.now() < offlineDeadline: call POST /auth/refresh
   → else: clear storage, redirect to login

5. On logout:
   → call POST /auth/logout
   → clear sessionToken from local storage
   → redirect to login
```
