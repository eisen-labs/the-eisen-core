import { query } from "../db/client.ts";

/**
 * Record a revoked JWT so it cannot be used after logout.
 *
 * We only need to keep the row until the token would have naturally expired —
 * after that point the JWT itself would fail signature verification due to `exp`.
 */
export async function revokeToken(jti: string, tokenExpiresAt: Date): Promise<void> {
  await query(
    `INSERT INTO revoked_tokens (jti, expires_at)
     VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING`,
    [jti, tokenExpiresAt.toISOString()]
  );
}

/**
 * Returns true if the given JTI has been explicitly revoked.
 */
export async function isTokenRevoked(jti: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM revoked_tokens WHERE jti = $1 AND expires_at > now() LIMIT 1`,
    [jti]
  );
  return result.rows.length > 0;
}

/**
 * Delete revocation records that are no longer needed (token has expired anyway).
 * Safe to call periodically — e.g. on a Cloud Scheduler job or lazily on requests.
 */
export async function cleanupRevokedTokens(): Promise<void> {
  await query(`DELETE FROM revoked_tokens WHERE expires_at <= now()`);
}
