import type { Context, Next } from "hono";
import { env } from "../env.ts";

/**
 * Middleware: requires the X-Admin-Secret header to match ADMIN_SECRET env var.
 * Used to protect administrative endpoints (key rotation, etc.).
 */
export async function requireAdmin(c: Context, next: Next) {
  if (!env.ADMIN_SECRET) {
    return c.json({ error: "Admin access not configured" }, 503);
  }

  const secret = c.req.header("X-Admin-Secret");

  if (!secret || secret !== env.ADMIN_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}
