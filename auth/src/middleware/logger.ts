import type { Context, Next } from "hono";
import { env } from "../env.ts";

/**
 * Structured JSON logger middleware for production.
 * Falls back to Hono's built-in text logger in development.
 *
 * Production output (one JSON line per request):
 * {
 *   "level": "info",
 *   "method": "POST",
 *   "path": "/auth/validate",
 *   "status": 200,
 *   "duration": 42,
 *   "requestId": "abc123...",
 *   "ip": "1.2.3.4",
 *   "userAgent": "...",
 *   "ts": "2026-02-21T..."
 * }
 *
 * Cloud Run and Cloud Logging parse JSON stdout automatically.
 */
export async function structuredLogger(c: Context, next: Next) {
  const start = Date.now();

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  if (env.NODE_ENV === "production") {
    const entry = {
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      method: c.req.method,
      path: c.req.path,
      status,
      duration,
      requestId: c.get("requestId") ?? null,
      ip:
        c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
        c.req.header("X-Real-IP") ||
        null,
      userAgent: c.req.header("User-Agent") || null,
      ts: new Date().toISOString(),
    };

    console.log(JSON.stringify(entry));
  } else if (env.NODE_ENV !== "test") {
    // Dev: simple colored log (skip in test to reduce noise)
    const color = status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : "\x1b[32m";
    const reset = "\x1b[0m";
    console.log(
      `<-- ${c.req.method} ${c.req.path}\n--> ${c.req.method} ${c.req.path} ${color}${status}${reset} ${duration}ms`
    );
  }
}
