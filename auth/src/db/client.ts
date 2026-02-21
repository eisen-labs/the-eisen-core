import { Pool, neonConfig } from "@neondatabase/serverless";
import { env } from "../env.ts";

// Use WebSocket for pooled connections in serverless environments
// neonConfig.webSocketConstructor is auto-detected by Bun's native WebSocket

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL });
  }
  return pool;
}

export async function query(sql: string, params?: unknown[]) {
  const p = getPool();
  return p.query(sql, params);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
