import { Hono } from "hono";
import { requireAdmin } from "../middleware/requireAdmin.ts";
import { query } from "../db/client.ts";

const admin = new Hono();

// All admin routes require X-Admin-Secret header
admin.use("/admin/*", requireAdmin);

/**
 * POST /admin/workspace/rotate-key
 *
 * Increments the key_version for a user's workspace, which causes
 * future key derivation to produce a different wrapped key.
 *
 * The actual workspace key changes because the version is incorporated
 * into re-encryption on the client side — this endpoint simply bumps
 * the version and records the rotation timestamp.
 *
 * Body: { userId: string, workspaceId: string }
 * Returns: { keyVersion: number, rotatedAt: string }
 *
 * Use cases:
 *   - Suspected key compromise
 *   - Employee offboarding (rotate all their workspace keys)
 *   - Periodic key rotation policy
 */
admin.post("/admin/workspace/rotate-key", async (c) => {
  const body = await c.req.json<{ userId?: string; workspaceId?: string }>();

  if (!body.userId) {
    return c.json({ error: "userId is required" }, 400);
  }

  if (!body.workspaceId) {
    return c.json({ error: "workspaceId is required" }, 400);
  }

  if (!/^[0-9a-f]{64}$/i.test(body.workspaceId)) {
    return c.json({ error: "workspaceId must be a SHA-256 hex string (64 chars)" }, 400);
  }

  // Verify user exists
  const userResult = await query("SELECT id FROM users WHERE id = $1", [body.userId]);
  if (!userResult.rows.length) {
    return c.json({ error: "User not found" }, 404);
  }

  // Upsert workspace key row and increment version
  const result = await query(
    `INSERT INTO workspace_keys (user_id, workspace_id, key_version, rotated_at)
     VALUES ($1, $2, 2, now())
     ON CONFLICT (user_id, workspace_id)
     DO UPDATE SET key_version = workspace_keys.key_version + 1,
                   rotated_at = now()
     RETURNING key_version, rotated_at`,
    [body.userId, body.workspaceId]
  );

  const row = result.rows[0] as { key_version: number; rotated_at: string };

  console.log(
    `Key rotated: user=${body.userId} workspace=${body.workspaceId} version=${row.key_version}`
  );

  return c.json({
    keyVersion: row.key_version,
    rotatedAt: row.rotated_at,
  });
});

/**
 * POST /admin/workspace/rotate-all
 *
 * Rotate all workspace keys for a given user (e.g. on offboarding).
 *
 * Body: { userId: string }
 * Returns: { rotated: number }
 */
admin.post("/admin/workspace/rotate-all", async (c) => {
  const body = await c.req.json<{ userId?: string }>();

  if (!body.userId) {
    return c.json({ error: "userId is required" }, 400);
  }

  const userResult = await query("SELECT id FROM users WHERE id = $1", [body.userId]);
  if (!userResult.rows.length) {
    return c.json({ error: "User not found" }, 404);
  }

  const result = await query(
    `UPDATE workspace_keys
     SET key_version = key_version + 1,
         rotated_at = now()
     WHERE user_id = $1`,
    [body.userId]
  );

  console.log(`All keys rotated: user=${body.userId} count=${result.rowCount}`);

  return c.json({ rotated: result.rowCount ?? 0 });
});

export { admin };
