import type { Context, Next } from "hono";
import { verifySession, type SessionPayload } from "../lib/jwt.ts";

/**
 * Middleware: extracts Bearer token from Authorization header,
 * verifies the JWT, and attaches the decoded payload to context variables.
 *
 * Downstream handlers access the user via: c.get("user")
 */

// Extend Hono's variable map so c.get("user") is typed
declare module "hono" {
  interface ContextVariableMap {
    user: SessionPayload;
  }
}

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "Missing or malformed Authorization header" }, 401);
  }

  const token = header.slice(7);

  try {
    const payload = await verifySession(token);
    c.set("user", payload);
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  await next();
}
