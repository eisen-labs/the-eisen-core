import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { app } from "../../app.ts";
import { signSession } from "../../lib/jwt.ts";
import { query } from "../../db/client.ts";
import { generateApiKey } from "../../lib/apiKey.ts";
import { resetRateLimitStores } from "../../middleware/rateLimit.ts";
import { nanoid } from "nanoid";

// ── Test fixtures ───────────────────────────────────────

const TEST_USER_ID = `usr_test_${nanoid(12)}`;
const TEST_EMAIL = `test-${nanoid(6)}@eisen.dev`;
let testToken: string;
let testApiKeyRaw: string;
let testApiKeyId: string;

beforeEach(() => {
  resetRateLimitStores();
});

beforeAll(async () => {
  // Create a test user
  await query(
    `INSERT INTO users (id, email, provider, provider_id)
     VALUES ($1, $2, 'github', $3)
     ON CONFLICT DO NOTHING`,
    [TEST_USER_ID, TEST_EMAIL, `gh_${nanoid(10)}`]
  );

  // Create a subscription (pro/active)
  await query(
    `INSERT INTO subscriptions (user_id, tier, status)
     VALUES ($1, 'pro', 'active')
     ON CONFLICT (user_id) DO UPDATE SET tier = 'pro', status = 'active'`,
    [TEST_USER_ID]
  );

  // Create a JWT for the test user
  const session = await signSession({
    sub: TEST_USER_ID,
    email: TEST_EMAIL,
    tier: "pro",
    status: "active",
  });
  testToken = session.sessionToken;

  // Create an API key for the test user
  const { raw, prefix, hash } = await generateApiKey();
  testApiKeyRaw = raw;
  testApiKeyId = `key_${nanoid(21)}`;
  await query(
    `INSERT INTO api_keys (id, user_id, name, prefix, hash)
     VALUES ($1, $2, 'Test Key', $3, $4)`,
    [testApiKeyId, TEST_USER_ID, prefix, hash]
  );
});

afterAll(async () => {
  // Clean up test data
  await query("DELETE FROM workspace_keys WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM api_keys WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM subscriptions WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM users WHERE id = $1", [TEST_USER_ID]);
});

// Helper to make requests against the Hono app
function req(path: string, init?: RequestInit) {
  return app.request(path, init);
}

function authReq(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${testToken}`);
  return app.request(path, { ...init, headers });
}

// ── Health ──────────────────────────────────────────────

describe("GET /health", () => {
  test("returns 200 with status ok", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; ts: number };
    expect(body.status).toBe("ok");
    expect(body.ts).toBeNumber();
  });
});

// ── Billing Plans ───────────────────────────────────────

describe("GET /billing/plans", () => {
  test("returns 200 with 3 plans", async () => {
    const res = await req("/billing/plans");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { plans: Array<{ tier: string }> };
    expect(body.plans).toHaveLength(3);

    const tiers = body.plans.map((p) => p.tier);
    expect(tiers).toContain("free");
    expect(tiers).toContain("pro");
    expect(tiers).toContain("premium");
  });

  test("free plan has price 0", async () => {
    const res = await req("/billing/plans");
    const body = (await res.json()) as { plans: Array<{ tier: string; price: number | null }> };
    const free = body.plans.find((p) => p.tier === "free");

    expect(free).toBeDefined();
    expect(free!.price).toBe(0);
  });
});

// ── Auth endpoints ──────────────────────────────────────

describe("Auth", () => {
  test("GET /auth/me returns user info with valid token", async () => {
    const res = await authReq("/auth/me");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      userId: string;
      email: string;
      subscription: { tier: string; status: string };
    };
    expect(body.userId).toBe(TEST_USER_ID);
    expect(body.email).toBe(TEST_EMAIL);
    expect(body.subscription.tier).toBe("pro");
    expect(body.subscription.status).toBe("active");
  });

  test("GET /auth/me returns 401 without token", async () => {
    const res = await req("/auth/me");
    expect(res.status).toBe(401);
  });

  test("GET /auth/me returns 401 with invalid token", async () => {
    const res = await req("/auth/me", {
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    expect(res.status).toBe(401);
  });

  test("POST /auth/validate returns JWT for valid API key", async () => {
    const res = await req("/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: testApiKeyRaw }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      valid: boolean;
      userId: string;
      sessionToken: string;
      subscription: { tier: string };
    };
    expect(body.valid).toBe(true);
    expect(body.userId).toBe(TEST_USER_ID);
    expect(body.sessionToken).toBeString();
    expect(body.subscription.tier).toBe("pro");
  });

  test("POST /auth/validate returns 401 for invalid API key", async () => {
    const res = await req("/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "eisen_invalid_key_that_does_not_exist_at_all_xxx" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /auth/validate returns 400 without apiKey", async () => {
    const res = await req("/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /auth/refresh returns new token for valid token", async () => {
    const res = await req("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionToken: testToken }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { sessionToken: string; expiresAt: number };
    expect(body.sessionToken).toBeString();
    expect(body.expiresAt).toBeNumber();
  });

  test("POST /auth/refresh returns 400 without sessionToken", async () => {
    const res = await req("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /auth/logout returns ok with valid token", async () => {
    const res = await authReq("/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── API Keys ────────────────────────────────────────────

describe("API Keys", () => {
  test("GET /apikeys returns keys for authenticated user", async () => {
    const res = await authReq("/apikeys");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { keys: Array<{ id: string; name: string; prefix: string }> };
    expect(body.keys).toBeArray();
    expect(body.keys.length).toBeGreaterThanOrEqual(1);

    const testKey = body.keys.find((k) => k.id === testApiKeyId);
    expect(testKey).toBeDefined();
    expect(testKey!.name).toBe("Test Key");
    expect(testKey!.prefix).toStartWith("eisen_");
  });

  test("GET /apikeys returns 401 without auth", async () => {
    const res = await req("/apikeys");
    expect(res.status).toBe(401);
  });

  test("POST /apikeys creates a new key", async () => {
    const res = await authReq("/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Integration Test Key" }),
    });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { id: string; name: string; key: string };
    expect(body.id).toStartWith("key_");
    expect(body.name).toBe("Integration Test Key");
    expect(body.key).toStartWith("eisen_");

    // Clean up — revoke the created key
    await authReq(`/apikeys/${body.id}`, { method: "DELETE" });
  });

  test("POST /apikeys returns 400 without name", async () => {
    const res = await authReq("/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("DELETE /apikeys/:id revokes a key", async () => {
    // Create a key to revoke
    const createRes = await authReq("/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "To Revoke" }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const res = await authReq(`/apikeys/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(id);
  });

  test("DELETE /apikeys/:id returns 404 for nonexistent key", async () => {
    const res = await authReq("/apikeys/key_nonexistent123456789", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

// ── Workspace Key ───────────────────────────────────────

describe("POST /workspace/key", () => {
  const workspaceId = "ab".repeat(32); // valid 64-char hex

  test("returns wrapped key for pro user", async () => {
    const res = await authReq("/workspace/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, apiKey: testApiKeyRaw }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { wrappedKey: string; keyVersion: number };
    expect(body.wrappedKey).toBeString();
    expect(body.wrappedKey.length).toBeGreaterThan(0);
    expect(body.keyVersion).toBe(1);

    // wrappedKey should be valid base64
    expect(() => Buffer.from(body.wrappedKey, "base64")).not.toThrow();
  });

  test("returns 403 for free tier user", async () => {
    // Temporarily downgrade to free
    await query("UPDATE subscriptions SET tier = 'free' WHERE user_id = $1", [TEST_USER_ID]);

    // Need a new token with free tier
    const session = await signSession({
      sub: TEST_USER_ID,
      email: TEST_EMAIL,
      tier: "free",
      status: "active",
    });

    const res = await app.request("/workspace/key", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId, apiKey: testApiKeyRaw }),
    });
    expect(res.status).toBe(403);

    // Restore pro tier
    await query("UPDATE subscriptions SET tier = 'pro' WHERE user_id = $1", [TEST_USER_ID]);
  });

  test("returns 400 without workspaceId", async () => {
    const res = await authReq("/workspace/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: testApiKeyRaw }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 with invalid workspaceId format", async () => {
    const res = await authReq("/workspace/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "not-a-sha256-hex", apiKey: testApiKeyRaw }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 400 without apiKey", async () => {
    const res = await authReq("/workspace/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 401 with invalid apiKey", async () => {
    const res = await authReq("/workspace/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, apiKey: "eisen_invalid_key_that_does_not_exist_at_all_xxx" }),
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 without auth", async () => {
    const res = await req("/workspace/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, apiKey: testApiKeyRaw }),
    });
    expect(res.status).toBe(401);
  });
});

// ── Admin ───────────────────────────────────────────────

describe("Admin", () => {
  const workspaceId = "cd".repeat(32); // valid 64-char hex

  function adminReq(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    // Use a test secret — if ADMIN_SECRET is not configured, these tests
    // will verify the 503 "not configured" response instead.
    headers.set("X-Admin-Secret", process.env.ADMIN_SECRET || "test-secret");
    return app.request(path, { ...init, headers });
  }

  test("POST /admin/workspace/rotate-key returns 401 without secret", async () => {
    const res = await req("/admin/workspace/rotate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER_ID, workspaceId }),
    });
    // Either 401 (wrong secret) or 503 (not configured)
    expect([401, 503]).toContain(res.status);
  });

  test("POST /admin/workspace/rotate-key validates input", async () => {
    // If ADMIN_SECRET not configured, skip input validation tests
    if (!process.env.ADMIN_SECRET) {
      console.log("  (skipped — ADMIN_SECRET not set, admin routes return 503)");
      return;
    }

    const res = await adminReq("/admin/workspace/rotate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /admin/workspace/rotate-key rotates key version", async () => {
    if (!process.env.ADMIN_SECRET) {
      console.log("  (skipped — ADMIN_SECRET not set)");
      return;
    }

    // Ensure workspace_keys row exists first
    await query(
      `INSERT INTO workspace_keys (user_id, workspace_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [TEST_USER_ID, workspaceId]
    );

    const res = await adminReq("/admin/workspace/rotate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER_ID, workspaceId }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { keyVersion: number; rotatedAt: string };
    expect(body.keyVersion).toBeGreaterThanOrEqual(2);
    expect(body.rotatedAt).toBeString();
  });

  test("POST /admin/workspace/rotate-all returns 401 without secret", async () => {
    const res = await req("/admin/workspace/rotate-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER_ID }),
    });
    expect([401, 503]).toContain(res.status);
  });
});

// ── 404 ─────────────────────────────────────────────────

describe("404", () => {
  test("returns 404 for unknown routes", async () => {
    const res = await req("/nonexistent");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not found");
  });
});
