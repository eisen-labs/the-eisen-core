import { Hono, type Context } from "hono";
import { Google, GitHub, generateState, generateCodeVerifier } from "arctic";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { env } from "../env.ts";
import { query } from "../db/client.ts";
import { signSession, refreshSession } from "../lib/jwt.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { revokeToken } from "../lib/tokenRevocation.ts";
import { resolveApiKey } from "../lib/apiKey.ts";
import { strictRateLimit, authRateLimit } from "../middleware/rateLimit.ts";
import { nanoid } from "nanoid";

const auth = new Hono();

// ── OAuth provider singletons (created lazily) ──────────

let _google: Google | null = null;
function google(): Google {
  if (!_google) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
      throw new Error("Google OAuth env vars not configured");
    }
    _google = new Google(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
  }
  return _google;
}

let _github: GitHub | null = null;
function github(): GitHub {
  if (!_github) {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.GITHUB_REDIRECT_URI) {
      throw new Error("GitHub OAuth env vars not configured");
    }
    _github = new GitHub(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET, env.GITHUB_REDIRECT_URI);
  }
  return _github;
}

// ── Helpers ─────────────────────────────────────────────

interface OAuthProfile {
  provider: "google" | "github";
  providerId: string;
  email: string;
}

/**
 * Upsert user + ensure subscription row exists.
 * Returns the user ID and current subscription.
 */
async function upsertUser(profile: OAuthProfile) {
  const userId = `usr_${nanoid(21)}`;

  // Upsert user — on conflict by (provider, provider_id) update email
  const result = await query(
    `INSERT INTO users (id, email, provider, provider_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_id)
     DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [userId, profile.email, profile.provider, profile.providerId]
  );

  const user = result.rows[0] as { id: string; email: string };

  // Ensure subscription row exists (default free/active)
  await query(
    `INSERT INTO subscriptions (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );

  // Fetch current subscription
  const subResult = await query(
    `SELECT tier, status FROM subscriptions WHERE user_id = $1`,
    [user.id]
  );
  const sub = subResult.rows[0] as { tier: string; status: string };

  return {
    id: user.id,
    email: user.email,
    tier: sub.tier as "free" | "pro" | "premium",
    status: sub.status as "active" | "expired" | "cancelled",
  };
}

/**
 * Issue a short-lived one-time code and redirect to the frontend.
 *
 * The JWT is never placed in the URL — the frontend exchanges the code for
 * the session token via POST /auth/exchange within 60 seconds.
 * This prevents the token from appearing in browser history, server logs,
 * or Referer headers.
 */
async function issueSessionAndRedirect(
  c: Context,
  user: Awaited<ReturnType<typeof upsertUser>>
) {
  const session = await signSession({
    sub: user.id,
    email: user.email,
    tier: user.tier,
    status: user.status,
  });

  const code = nanoid(32);
  const expiresAt = new Date(Date.now() + 60_000); // 60-second window

  await query(
    `INSERT INTO auth_codes (code, session_json, expires_at) VALUES ($1, $2, $3)`,
    [code, JSON.stringify(session), expiresAt.toISOString()]
  );

  const url = new URL(env.FRONTEND_URL);
  url.pathname = "/auth/callback";
  url.searchParams.set("code", code);

  return c.redirect(url.toString());
}

// ── Google OAuth ────────────────────────────────────────

auth.get("/auth/google", authRateLimit, async (c) => {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  // Store state + verifier in secure cookies (short-lived, 10 min)
  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  setCookie(c, "oauth_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const url = google().createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
    "profile",
  ]);

  return c.redirect(url.toString());
});

auth.get("/auth/google/callback", authRateLimit, async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");
  const codeVerifier = getCookie(c, "oauth_code_verifier");

  // Clean up cookies
  deleteCookie(c, "oauth_state");
  deleteCookie(c, "oauth_code_verifier");

  if (!code || !state || !storedState || !codeVerifier || state !== storedState) {
    return c.json({ error: "Invalid OAuth callback" }, 400);
  }

  try {
    const tokens = await google().validateAuthorizationCode(code, codeVerifier);
    const accessToken = tokens.accessToken();

    // Fetch Google user profile
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      return c.json({ error: "Failed to fetch Google profile" }, 502);
    }

    const profile = (await res.json()) as { sub: string; email: string };

    const user = await upsertUser({
      provider: "google",
      providerId: profile.sub,
      email: profile.email,
    });

    return issueSessionAndRedirect(c, user);
  } catch (err) {
    console.error("Google OAuth error:", err);
    return c.json({ error: "OAuth authentication failed" }, 500);
  }
});

// ── GitHub OAuth ────────────────────────────────────────

auth.get("/auth/github", authRateLimit, async (c) => {
  const state = generateState();

  setCookie(c, "oauth_state", state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const url = github().createAuthorizationURL(state, ["user:email"]);

  return c.redirect(url.toString());
});

auth.get("/auth/github/callback", authRateLimit, async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, "oauth_state");

  deleteCookie(c, "oauth_state");

  if (!code || !state || !storedState || state !== storedState) {
    return c.json({ error: "Invalid OAuth callback" }, 400);
  }

  try {
    const tokens = await github().validateAuthorizationCode(code);
    const accessToken = tokens.accessToken();

    // Fetch GitHub user profile
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!userRes.ok) {
      return c.json({ error: "Failed to fetch GitHub profile" }, 502);
    }

    const ghUser = (await userRes.json()) as { id: number; email: string | null };

    // GitHub email can be private — fetch from /user/emails if needed
    let email = ghUser.email;
    if (!email) {
      const emailRes = await fetch("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (emailRes.ok) {
        const emails = (await emailRes.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        email = primary?.email ?? emails[0]?.email ?? null;
      }
    }

    if (!email) {
      return c.json({ error: "Could not retrieve email from GitHub" }, 400);
    }

    const user = await upsertUser({
      provider: "github",
      providerId: ghUser.id.toString(),
      email,
    });

    return issueSessionAndRedirect(c, user);
  } catch (err) {
    console.error("GitHub OAuth error:", err);
    return c.json({ error: "OAuth authentication failed" }, 500);
  }
});

// ── API key auth (extension / CLI) ──────────────────────

/**
 * POST /auth/validate — exchange an API key for a JWT session.
 *
 * This is the entry point for the VS Code extension and CLI.
 * No browser session needed — the client sends their raw API key,
 * the server verifies it and returns the same JWT format as OAuth.
 */
auth.post("/auth/validate", strictRateLimit, async (c) => {
  const body = await c.req.json<{ apiKey?: string }>();

  if (!body.apiKey) {
    return c.json({ error: "apiKey is required" }, 400);
  }

  // Resolve the API key to a user
  const resolved = await resolveApiKey(body.apiKey);

  if (!resolved) {
    return c.json({ valid: false, error: "Invalid API key" }, 401);
  }

  // Fetch user + subscription
  const result = await query(
    `SELECT u.id, u.email, s.tier, s.status
     FROM users u
     JOIN subscriptions s ON s.user_id = u.id
     WHERE u.id = $1`,
    [resolved.userId]
  );

  if (!result.rows.length) {
    return c.json({ valid: false, error: "User not found" }, 401);
  }

  const user = result.rows[0] as {
    id: string;
    email: string;
    tier: string;
    status: string;
  };

  const session = await signSession({
    sub: user.id,
    email: user.email,
    tier: user.tier as "free" | "pro" | "premium",
    status: user.status as "active" | "expired" | "cancelled",
  });

  return c.json({
    valid: true,
    userId: user.id,
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
    offlineDeadline: session.offlineDeadline,
    subscription: {
      tier: user.tier,
      status: user.status,
    },
  });
});

// ── Session endpoints ───────────────────────────────────

/**
 * GET /auth/me — returns current user info from JWT
 */
auth.get("/auth/me", requireAuth, async (c) => {
  const user = c.get("user");

  // Fetch latest subscription state from DB (JWT might be stale)
  const result = await query(
    `SELECT u.email, s.tier, s.status
     FROM users u
     JOIN subscriptions s ON s.user_id = u.id
     WHERE u.id = $1`,
    [user.sub]
  );

  if (!result.rows.length) {
    return c.json({ error: "User not found" }, 404);
  }

  const row = result.rows[0] as { email: string; tier: string; status: string };

  return c.json({
    userId: user.sub,
    email: row.email,
    subscription: {
      tier: row.tier,
      status: row.status,
    },
  });
});

/**
 * POST /auth/exchange — exchange a one-time auth code for a session token.
 *
 * The frontend calls this immediately after the OAuth redirect with the ?code=
 * query param. The code expires after 60 seconds and can only be used once.
 */
auth.post("/auth/exchange", authRateLimit, async (c) => {
  const body = await c.req.json<{ code?: string }>();

  if (!body.code) {
    return c.json({ error: "code is required" }, 400);
  }

  const result = await query(
    `UPDATE auth_codes
     SET used_at = now()
     WHERE code = $1
       AND used_at IS NULL
       AND expires_at > now()
     RETURNING session_json`,
    [body.code]
  );

  if (!result.rows.length) {
    return c.json({ error: "Invalid or expired code" }, 401);
  }

  const row = result.rows[0] as { session_json: string };
  const session = JSON.parse(row.session_json) as {
    jti: string;
    sessionToken: string;
    expiresAt: number;
    offlineDeadline: number;
  };

  return c.json({
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
    offlineDeadline: session.offlineDeadline,
  });
});

/**
 * POST /auth/refresh — refresh an expired JWT within the 7-day offline window
 */
auth.post("/auth/refresh", authRateLimit, async (c) => {
  const body = await c.req.json<{ sessionToken?: string }>();

  if (!body.sessionToken) {
    return c.json({ error: "sessionToken is required" }, 400);
  }

  const result = await refreshSession(body.sessionToken);

  if (!result) {
    return c.json({ error: "Offline deadline exceeded, re-authentication required" }, 401);
  }

  return c.json({
    sessionToken: result.sessionToken,
    expiresAt: result.expiresAt,
    offlineDeadline: result.offlineDeadline,
  });
});

/**
 * POST /auth/logout — revokes the current JWT so it cannot be reused.
 */
auth.post("/auth/logout", requireAuth, async (c) => {
  const user = c.get("user");
  const tokenExpiresAt = new Date(user.offlineDeadline * 1000);
  await revokeToken(user.jti, tokenExpiresAt);
  return c.json({ ok: true });
});

export { auth };
