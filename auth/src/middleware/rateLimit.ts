import type { Context, Next } from "hono";

/**
 * In-memory sliding window rate limiter.
 *
 * Each key (IP) tracks a list of request timestamps. On each request,
 * expired entries are pruned and the count is checked against the limit.
 *
 * This is suitable for single-instance deployments (Cloud Run with
 * max-instances=1) or as a per-instance guard. For multi-instance
 * deployments, replace with Redis-backed rate limiting.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  max: number;
  /** Time window in seconds */
  windowSec: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(name: string): Map<string, RateLimitEntry> {
  let store = stores.get(name);
  if (!store) {
    store = new Map();
    stores.set(name, store);
  }
  return store;
}

/**
 * Periodic cleanup of stale entries to prevent memory leaks.
 * Runs every 60 seconds per store.
 */
function scheduleCleanup(name: string, windowSec: number) {
  const interval = setInterval(() => {
    const store = stores.get(name);
    if (!store) return;

    const cutoff = Date.now() - windowSec * 1000;
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, 60_000);

  // Don't prevent process from exiting
  if (interval.unref) interval.unref();
}

const cleanupScheduled = new Set<string>();

/**
 * Extract the client IP from the request.
 * Cloud Run sets X-Forwarded-For; falls back to connecting IP.
 */
function getClientIp(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) {
    // Cloud Run appends the real client IP at the end of X-Forwarded-For.
    // Taking the last entry prevents spoofing via a client-supplied header.
    const last = xff.split(",").at(-1)?.trim();
    if (last) return last;
  }
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Real-IP") ||
    "unknown"
  );
}

/**
 * Create a rate limiting middleware.
 *
 * @param name - Unique name for this rate limiter (used to isolate stores)
 * @param config - Rate limit configuration
 */
export function rateLimit(name: string, config: RateLimitConfig) {
  const store = getStore(name);

  if (!cleanupScheduled.has(name)) {
    scheduleCleanup(name, config.windowSec);
    cleanupScheduled.add(name);
  }

  return async (c: Context, next: Next) => {
    const key = getClientIp(c);
    const now = Date.now();
    const windowMs = config.windowSec * 1000;
    const cutoff = now - windowMs;

    let entry = store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Prune expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= config.max) {
      const retryAfter = Math.ceil(
        (entry.timestamps[0]! + windowMs - now) / 1000
      );

      c.header("Retry-After", retryAfter.toString());
      c.header("X-RateLimit-Limit", config.max.toString());
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", new Date(entry.timestamps[0]! + windowMs).toISOString());

      return c.json({ error: "Too many requests" }, 429);
    }

    entry.timestamps.push(now);

    // Set rate limit headers on success
    c.header("X-RateLimit-Limit", config.max.toString());
    c.header("X-RateLimit-Remaining", (config.max - entry.timestamps.length).toString());

    await next();
  };
}

/**
 * Pre-configured rate limiters for different endpoint categories.
 */

/** Strict: 10 requests per 60 seconds. For bcrypt-heavy endpoints like /auth/validate */
export const strictRateLimit = rateLimit("strict", { max: 10, windowSec: 60 });

/** Auth: 30 requests per 60 seconds. For OAuth and session endpoints */
export const authRateLimit = rateLimit("auth", { max: 30, windowSec: 60 });

/** General: 100 requests per 60 seconds. For authenticated API endpoints */
export const generalRateLimit = rateLimit("general", { max: 100, windowSec: 60 });

/**
 * Reset all rate limit stores (for testing).
 */
export function resetRateLimitStores() {
  for (const store of stores.values()) {
    store.clear();
  }
}
