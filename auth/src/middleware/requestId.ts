import type { Context, Next } from "hono";
import { nanoid } from "nanoid";

/**
 * Middleware: assigns a unique request ID to each request.
 *
 * - Checks for an existing X-Request-Id header (e.g. from Cloud Run or a load balancer)
 * - Falls back to generating a nanoid
 * - Sets the ID on the response header and in context variables
 *
 * Access in handlers via: c.get("requestId")
 */

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export async function requestId(c: Context, next: Next) {
  const id = c.req.header("X-Request-Id") || nanoid(21);

  c.set("requestId", id);
  c.header("X-Request-Id", id);

  await next();
}
