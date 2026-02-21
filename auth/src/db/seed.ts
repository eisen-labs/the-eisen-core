/**
 * Seed script — inserts test data for local development and manual testing.
 *
 * Usage: bun run seed
 *
 * Creates:
 *   - A test user (GitHub provider)
 *   - A pro subscription (active)
 *   - An API key (prints the raw key — save it!)
 *   - A workspace key entry
 *
 * The raw API key is only shown once. Use it with:
 *   POST /auth/validate  { "apiKey": "<key>" }
 *   POST /workspace/key  { "workspaceId": "...", "apiKey": "<key>" }
 */
import { getPool, closePool } from "./client.ts";
import { generateApiKey } from "../lib/apiKey.ts";
import { signSession } from "../lib/jwt.ts";

const SEED_USER_ID = "usr_seed_dev_001";
const SEED_EMAIL = "dev@eisen.dev";
const SEED_PROVIDER = "github";
const SEED_PROVIDER_ID = "gh_seed_12345";
const SEED_WORKSPACE_ID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

async function seed() {
  const pool = getPool();

  console.log("Seeding database...\n");

  // ── User ────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO users (id, email, provider, provider_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_id)
     DO UPDATE SET email = EXCLUDED.email`,
    [SEED_USER_ID, SEED_EMAIL, SEED_PROVIDER, SEED_PROVIDER_ID]
  );
  console.log(`  User:         ${SEED_USER_ID} (${SEED_EMAIL})`);

  // ── Subscription (Pro, active) ──────────────────────────
  await pool.query(
    `INSERT INTO subscriptions (user_id, tier, status)
     VALUES ($1, 'pro', 'active')
     ON CONFLICT (user_id)
     DO UPDATE SET tier = 'pro', status = 'active', updated_at = now()`,
    [SEED_USER_ID]
  );
  console.log(`  Subscription: pro (active)`);

  // ── API Key ─────────────────────────────────────────────
  // Revoke any existing seed keys to keep things clean
  await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE user_id = $1 AND name = 'Seed Dev Key' AND revoked_at IS NULL`,
    [SEED_USER_ID]
  );

  const { raw, prefix, hash } = await generateApiKey();
  const keyId = `key_seed_${Date.now()}`;

  await pool.query(
    `INSERT INTO api_keys (id, user_id, name, prefix, hash)
     VALUES ($1, $2, 'Seed Dev Key', $3, $4)`,
    [keyId, SEED_USER_ID, prefix, hash]
  );

  console.log(`  API Key ID:   ${keyId}`);
  console.log(`  API Key:      ${raw}`);
  console.log(`  Key Prefix:   ${prefix}`);

  // ── Workspace key entry ─────────────────────────────────
  await pool.query(
    `INSERT INTO workspace_keys (user_id, workspace_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [SEED_USER_ID, SEED_WORKSPACE_ID]
  );
  console.log(`  Workspace ID: ${SEED_WORKSPACE_ID}`);

  // ── Generate a JWT for convenience ──────────────────────
  const session = await signSession({
    sub: SEED_USER_ID,
    email: SEED_EMAIL,
    tier: "pro",
    status: "active",
  });

  console.log(`\n  JWT Token:    ${session.sessionToken}`);
  console.log(`  Expires at:   ${new Date(session.expiresAt).toISOString()}`);

  console.log("\n── Example requests ──────────────────────────────────────\n");

  console.log(`# Health check`);
  console.log(`curl http://localhost:3000/health\n`);

  console.log(`# Validate API key → get JWT`);
  console.log(`curl -X POST http://localhost:3000/auth/validate \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"apiKey": "${raw}"}'\n`);

  console.log(`# Get user info`);
  console.log(`curl http://localhost:3000/auth/me \\`);
  console.log(`  -H "Authorization: Bearer ${session.sessionToken}"\n`);

  console.log(`# List API keys`);
  console.log(`curl http://localhost:3000/apikeys \\`);
  console.log(`  -H "Authorization: Bearer ${session.sessionToken}"\n`);

  console.log(`# Get workspace decryption key`);
  console.log(`curl -X POST http://localhost:3000/workspace/key \\`);
  console.log(`  -H "Authorization: Bearer ${session.sessionToken}" \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '{"workspaceId": "${SEED_WORKSPACE_ID}", "apiKey": "${raw}"}'\n`);

  console.log(`# Get billing plans`);
  console.log(`curl http://localhost:3000/billing/plans\n`);

  console.log("Done.\n");

  await closePool();
}

seed();
