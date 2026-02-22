import type { Context, Next } from "hono";
import { verifySession, type SessionPayload } from "../lib/jwt.ts";
import { isTokenRevoked } from "../lib/tokenRevocation.ts";

/**
 * Middleware: extracts Bearer token from Authorization header,
 * verifies the JWT, checks the revocation list, and attaches the decoded
 * payload to context variables.
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

  let payload: SessionPayload;
  try {
    payload = await verifySession(token);
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  if (await isTokenRevoked(payload.jti)) {
    return c.json({ error: "Token has been revoked" }, 401);
  }

  c.set("user", payload);
  await next();
}
