import { nanoid } from "nanoid";
import { query } from "../db/client.ts";

const PREFIX = "eisen_";
const KEY_BYTE_LENGTH = 32;

/**
 * Generate a new API key.
 *
 * Format: eisen_<nanoid(43)>
 * The nanoid(43) gives ~256 bits of entropy (base64url alphabet, 6 bits/char).
 *
 * Returns the raw key (shown to the user once), the lookup prefix, and the bcrypt hash.
 */
export async function generateApiKey(): Promise<{
  raw: string;
  prefix: string;
  hash: string;
}> {
  // nanoid with length 43 gives ~258 bits of entropy
  const random = nanoid(43);
  const raw = `${PREFIX}${random}`;
  const prefix = raw.slice(0, PREFIX.length + 8); // "eisen_" + first 8 chars
  const hash = await Bun.password.hash(raw, { algorithm: "bcrypt", cost: 12 });

  return { raw, prefix, hash };
}

/**
 * Hash a raw API key with bcrypt.
 */
export async function hashApiKey(raw: string): Promise<string> {
  return Bun.password.hash(raw, { algorithm: "bcrypt", cost: 12 });
}

/**
 * Verify a raw API key against a bcrypt hash.
 */
export async function verifyApiKey(raw: string, hash: string): Promise<boolean> {
  return Bun.password.verify(raw, hash);
}

/**
 * Look up an API key row by prefix. Returns the first non-revoked match.
 *
 * The caller must then verify the raw key against the returned hash.
 */
export async function findKeyByPrefix(
  prefix: string
): Promise<{ id: string; userId: string; hash: string } | null> {
  const result = await query(
    `SELECT id, user_id, hash
     FROM api_keys
     WHERE prefix = $1 AND revoked_at IS NULL
     LIMIT 1`,
    [prefix]
  );

  if (!result.rows.length) return null;

  const row = result.rows[0] as { id: string; user_id: string; hash: string };
  return { id: row.id, userId: row.user_id, hash: row.hash };
}

/**
 * Resolve a raw API key to a user ID.
 *
 * 1. Extract the prefix from the raw key
 * 2. Look up candidates by prefix
 * 3. Bcrypt verify the full key
 * 4. Update last_used_at on match
 *
 * Returns the user ID and key row ID, or null if invalid.
 */
export async function resolveApiKey(
  raw: string
): Promise<{ userId: string; keyId: string } | null> {
  if (!raw.startsWith(PREFIX)) return null;

  const prefix = raw.slice(0, PREFIX.length + 8);
  const candidate = await findKeyByPrefix(prefix);

  if (!candidate) return null;

  const valid = await verifyApiKey(raw, candidate.hash);
  if (!valid) return null;

  // Update last_used_at (fire and forget — don't block the response)
  query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [candidate.id]).catch(() => {});

  return { userId: candidate.userId, keyId: candidate.id };
}
