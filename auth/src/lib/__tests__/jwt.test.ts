import { test, expect, describe } from "bun:test";
import { SignJWT } from "jose";

const { signSession, verifySession, refreshSession } = await import("../jwt.ts");

describe("JWT", () => {
  const payload = {
    sub: "usr_test123",
    email: "test@eisen.dev",
    tier: "pro" as const,
    status: "active" as const,
  };

  describe("signSession + verifySession", () => {
    test("sign returns token with correct shape", async () => {
      const result = await signSession(payload);

      expect(result.sessionToken).toBeString();
      expect(result.sessionToken.split(".")).toHaveLength(3);
      expect(result.expiresAt).toBeNumber();
      expect(result.offlineDeadline).toBeNumber();
      expect(result.offlineDeadline).toBeGreaterThan(result.expiresAt);
    });

    test("expiresAt and offlineDeadline are in milliseconds", async () => {
      const result = await signSession(payload);
      const nowMs = Date.now();

      // expiresAt should be in the future and in ms (not seconds)
      expect(result.expiresAt).toBeGreaterThan(nowMs);
      expect(result.offlineDeadline).toBeGreaterThan(nowMs);
    });

    test("verify returns correct payload", async () => {
      const { sessionToken } = await signSession(payload);
      const decoded = await verifySession(sessionToken);

      expect(decoded.sub).toBe(payload.sub);
      expect(decoded.email).toBe(payload.email);
      expect(decoded.tier).toBe(payload.tier);
      expect(decoded.status).toBe(payload.status);
      expect(decoded.offlineDeadline).toBeNumber();
    });

    test("verify rejects tampered token", async () => {
      const { sessionToken } = await signSession(payload);
      const tampered = sessionToken.slice(0, -2) + "XX";

      expect(verifySession(tampered)).rejects.toThrow();
    });

    test("verify rejects token signed with wrong secret", async () => {
      const wrongSecret = new TextEncoder().encode("wrong_secret_wrong_secret_wrong_secret");
      const token = await new SignJWT({
        email: "test@eisen.dev",
        tier: "pro",
        status: "active",
        offlineDeadline: Math.floor(Date.now() / 1000) + 9999,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("usr_test123")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(wrongSecret);

      expect(verifySession(token)).rejects.toThrow();
    });
  });

  describe("refreshSession", () => {
    test("refresh works for a valid non-expired token", async () => {
      const { sessionToken } = await signSession(payload);
      // Token is still valid (not expired), refresh should still work
      const refreshed = await refreshSession(sessionToken);

      expect(refreshed).not.toBeNull();
      expect(refreshed!.sessionToken).toBeString();
    });

    test("refresh returns null for garbage token", async () => {
      const result = await refreshSession("not.a.jwt");
      expect(result).toBeNull();
    });

    test("refresh returns null for completely invalid string", async () => {
      const result = await refreshSession("garbage");
      expect(result).toBeNull();
    });

    test("refresh returns null for token with wrong signature", async () => {
      const wrongSecret = new TextEncoder().encode("wrong_secret_wrong_secret_wrong_secret");
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        email: "test@eisen.dev",
        tier: "pro",
        status: "active",
        offlineDeadline: now + 99999,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("usr_test123")
        .setIssuedAt()
        .setExpirationTime(now + 1) // already expired
        .sign(wrongSecret);

      const result = await refreshSession(token);
      expect(result).toBeNull();
    });
  });
});
