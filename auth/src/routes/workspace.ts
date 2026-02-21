import { Hono } from "hono";
import { requireAuth } from "../middleware/requireAuth.ts";
import { strictRateLimit } from "../middleware/rateLimit.ts";
import { query } from "../db/client.ts";
import { deriveFullWorkspaceKey, wrapKey } from "../lib/crypto.ts";
import { resolveApiKey } from "../lib/apiKey.ts";

const workspace = new Hono();

/**
 * POST /workspace/key
 *
 * Returns a workspace-specific decryption key, wrapped with the user's API key
 * so it is safe in transit. The client unwraps it using their raw API key.
 *
 * Auth: Bearer JWT (from /auth/validate)
 * Body: { workspaceId: string, apiKey: string }
 *
 * The apiKey is required for two reasons:
 *   1. To wrap the workspace key (HKDF-derived wrap key from the API key)
 *   2. To verify the caller actually possesses the key (not just a stolen JWT)
 *
 * Returns 403 if subscription tier is 'free' or status is not 'active'.
 */
workspace.post("/workspace/key", strictRateLimit, requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ workspaceId?: string; apiKey?: string }>();

  // ── Validate input ──────────────────────────────────
  if (!body.workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }

  if (!/^[0-9a-f]{64}$/i.test(body.workspaceId)) {
    return c.json({ error: "workspaceId must be a SHA-256 hex string (64 chars)" }, 400);
  }

  if (!body.apiKey) {
    return c.json({ error: "apiKey is required for key wrapping" }, 400);
  }

  // ── Verify API key ownership ────────────────────────
  const resolved = await resolveApiKey(body.apiKey);
  if (!resolved || resolved.userId !== user.sub) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // ── Check subscription ──────────────────────────────
  const subResult = await query(
    `SELECT tier, status FROM subscriptions WHERE user_id = $1`,
    [user.sub]
  );

  if (!subResult.rows.length) {
    return c.json({ error: "Subscription not found" }, 404);
  }

  const sub = subResult.rows[0] as { tier: string; status: string };

  if (sub.tier === "free") {
    return c.json({ error: "Subscription does not include encrypted storage" }, 403);
  }

  if (sub.status !== "active") {
    return c.json({ error: `Subscription is ${sub.status}` }, 403);
  }

  // ── Ensure workspace_keys row exists ────────────────
  await query(
    `INSERT INTO workspace_keys (user_id, workspace_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, workspace_id) DO NOTHING`,
    [user.sub, body.workspaceId]
  );

  // Fetch key version
  const keyRow = await query(
    `SELECT key_version FROM workspace_keys
     WHERE user_id = $1 AND workspace_id = $2`,
    [user.sub, body.workspaceId]
  );

  const keyVersion = (keyRow.rows[0] as { key_version: number }).key_version;

  // ── Derive and wrap workspace key ───────────────────
  const workspaceKey = await deriveFullWorkspaceKey(user.sub, body.workspaceId);
  const wrappedKey = wrapKey(workspaceKey, body.apiKey);

  // Zero the workspace key from memory immediately
  workspaceKey.fill(0);

  return c.json({
    wrappedKey,
    keyVersion,
  });
});

export { workspace };
