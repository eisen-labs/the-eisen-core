import { Hono } from "hono";
import { getPool } from "../db/client.ts";

const health = new Hono();

health.get("/health", async (c) => {
  // Quick DB connectivity check
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
  } catch {
    return c.json({ status: "error", error: "database unreachable", ts: Date.now() }, 503);
  }

  return c.json({ status: "ok", ts: Date.now() });
});

export { health };
