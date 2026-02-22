import { SignJWT, jwtVerify, decodeJwt } from "jose";
import { nanoid } from "nanoid";
import { env } from "../env.ts";
import { isTokenRevoked } from "./tokenRevocation.ts";

export interface SessionPayload {
  jti: string;  // unique token ID used for revocation
  sub: string;
  email: string;
  tier: "free" | "pro" | "premium";
  status: "active" | "expired" | "cancelled";
  offlineDeadline: number; // unix seconds
}

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ALGORITHM = "HS256";

/**
 * Sign a new session JWT.
 */
export async function signSession(payload: Omit<SessionPayload, "jti" | "offlineDeadline">): Promise<{
  jti: string;
  sessionToken: string;
  expiresAt: number;
  offlineDeadline: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + env.JWT_EXPIRES_IN;
  const offlineDeadline = now + env.JWT_OFFLINE_WINDOW;
  const jti = nanoid(21);

  const sessionToken = await new SignJWT({
    email: payload.email,
    tier: payload.tier,
    status: payload.status,
    offlineDeadline,
  } as Record<string, unknown>)
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(payload.sub)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(secret);

  return {
    jti,
    sessionToken,
    expiresAt: expiresAt * 1000, // return as unix ms for client consistency
    offlineDeadline: offlineDeadline * 1000,
  };
}

/**
 * Verify a session JWT. Throws if expired or invalid signature.
 */
export async function verifySession(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: [ALGORITHM],
  });

  return {
    jti: payload.jti as string,
    sub: payload.sub as string,
    email: payload.email as string,
    tier: payload.tier as SessionPayload["tier"],
    status: payload.status as SessionPayload["status"],
    offlineDeadline: payload.offlineDeadline as number,
  };
}

/**
 * Refresh an expired session token. Only works within the offline deadline window.
 *
 * Decodes without verifying expiry, checks the offlineDeadline claim,
 * verifies the signature, then issues a new token.
 */
export async function refreshSession(token: string): Promise<{
  jti: string;
  sessionToken: string;
  expiresAt: number;
  offlineDeadline: number;
} | null> {
  // Decode without expiry check to read claims
  let claims;
  try {
    claims = decodeJwt(token);
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const offlineDeadline = claims.offlineDeadline as number | undefined;

  // If past the offline deadline, refuse refresh
  if (!offlineDeadline || now > offlineDeadline) {
    return null;
  }

  // Verify signature (ignore expiry via clockTolerance large enough to cover the offline window)
  try {
    await jwtVerify(token, secret, {
      algorithms: [ALGORITHM],
      clockTolerance: env.JWT_OFFLINE_WINDOW,
    });
  } catch {
    return null;
  }

  // Refuse refresh if the token was explicitly revoked (e.g. user logged out)
  const oldJti = claims.jti as string | undefined;
  if (oldJti && (await isTokenRevoked(oldJti))) {
    return null;
  }

  // Issue a fresh token with the same identity claims
  return signSession({
    sub: claims.sub as string,
    email: claims.email as string,
    tier: claims.tier as SessionPayload["tier"],
    status: claims.status as SessionPayload["status"],
  });
}
