import { Hono } from "hono";
import { nanoid } from "nanoid";
import { requireAuth } from "../middleware/requireAuth.ts";
import { generateApiKey } from "../lib/apiKey.ts";
import { generalRateLimit } from "../middleware/rateLimit.ts";
import { query } from "../db/client.ts";

const apikeys = new Hono();

// All routes require a valid JWT session + rate limiting
apikeys.use("/apikeys/*", generalRateLimit, requireAuth);
apikeys.use("/apikeys", generalRateLimit, requireAuth);

/**
 * GET /apikeys — list all active (non-revoked) API keys for the authed user.
 *
 * Returns metadata only — the raw key and hash are never exposed.
 */
apikeys.get("/apikeys", async (c) => {
  const user = c.get("user");

  const result = await query(
    `SELECT id, name, prefix, created_at, last_used_at
     FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [user.sub]
  );

  const keys = result.rows.map((row: Record<string, unknown>) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));

  return c.json({ keys });
});

/**
 * POST /apikeys — create a new API key.
 *
 * The raw key is returned ONCE in the response.
 * It is never stored in plaintext — only the bcrypt hash is persisted.
 */
apikeys.post("/apikeys", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ name?: string }>();

  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  if (name.length > 100) {
    return c.json({ error: "name must be 100 characters or fewer" }, 400);
  }

  // Cap the number of active keys per user
  const countResult = await query(
    `SELECT COUNT(*) as count FROM api_keys
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.sub]
  );
  const count = Number((countResult.rows[0] as { count: string }).count);

  if (count >= 10) {
    return c.json({ error: "Maximum of 10 active API keys per user" }, 400);
  }

  const { raw, prefix, hash } = await generateApiKey();
  const id = `key_${nanoid(21)}`;

  await query(
    `INSERT INTO api_keys (id, user_id, name, prefix, hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, user.sub, name, prefix, hash]
  );

  // Return raw key — the only time it is ever shown
  return c.json({ id, name, key: raw }, 201);
});

/**
 * DELETE /apikeys/:id — revoke an API key.
 *
 * Sets revoked_at = now(). The row is preserved for audit purposes.
 * Only the owning user can revoke their own keys.
 */
apikeys.delete("/apikeys/:id", async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id");

  const result = await query(
    `UPDATE api_keys
     SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [keyId, user.sub]
  );

  if (!result.rows.length) {
    return c.json({ error: "API key not found or already revoked" }, 404);
  }

  return c.json({ ok: true, id: keyId });
});

export { apikeys };
