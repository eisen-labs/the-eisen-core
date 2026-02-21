import { test, expect, describe } from "bun:test";

const {
  deriveUserKey,
  deriveWorkspaceKey,
  deriveFullWorkspaceKey,
  deriveWrapKey,
  wrapKey,
  unwrapKey,
} = await import("../crypto.ts");

describe("Crypto", () => {
  const userId = "usr_test123";
  const workspaceId = "a".repeat(64); // valid SHA-256 hex
  const rawApiKey = "eisen_testkey1234567890abcdefghijklmnopqrstuvw";

  describe("key derivation", () => {
    test("deriveUserKey returns 32-byte buffer", async () => {
      const key = await deriveUserKey(userId);

      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    test("deriveUserKey is deterministic", async () => {
      const key1 = await deriveUserKey(userId);
      const key2 = await deriveUserKey(userId);

      expect(key1.equals(key2)).toBe(true);
    });

    test("deriveUserKey differs for different users", async () => {
      const key1 = await deriveUserKey("usr_alice");
      const key2 = await deriveUserKey("usr_bob");

      expect(key1.equals(key2)).toBe(false);
    });

    test("deriveWorkspaceKey returns 32-byte buffer", async () => {
      const userKey = await deriveUserKey(userId);
      const wsKey = deriveWorkspaceKey(userKey, workspaceId);

      expect(wsKey).toBeInstanceOf(Buffer);
      expect(wsKey.length).toBe(32);
    });

    test("deriveWorkspaceKey differs for different workspaces", async () => {
      const userKey = await deriveUserKey(userId);
      const wsKey1 = deriveWorkspaceKey(userKey, "a".repeat(64));
      const wsKey2 = deriveWorkspaceKey(userKey, "b".repeat(64));

      expect(wsKey1.equals(wsKey2)).toBe(false);
    });

    test("deriveFullWorkspaceKey matches manual chain", async () => {
      const fullKey = await deriveFullWorkspaceKey(userId, workspaceId);

      const userKey = await deriveUserKey(userId);
      const manualKey = deriveWorkspaceKey(userKey, workspaceId);

      expect(fullKey.equals(manualKey)).toBe(true);
    });
  });

  describe("wrap key derivation", () => {
    test("deriveWrapKey returns 32-byte buffer", () => {
      const wrapKeyBuf = deriveWrapKey(rawApiKey);

      expect(wrapKeyBuf).toBeInstanceOf(Buffer);
      expect(wrapKeyBuf.length).toBe(32);
    });

    test("deriveWrapKey is deterministic", () => {
      const k1 = deriveWrapKey(rawApiKey);
      const k2 = deriveWrapKey(rawApiKey);

      expect(k1.equals(k2)).toBe(true);
    });

    test("deriveWrapKey differs for different API keys", () => {
      const k1 = deriveWrapKey("eisen_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      const k2 = deriveWrapKey("eisen_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

      expect(k1.equals(k2)).toBe(false);
    });
  });

  describe("wrapKey + unwrapKey round-trip", () => {
    test("unwrap recovers original workspace key", async () => {
      const wsKey = await deriveFullWorkspaceKey(userId, workspaceId);
      const wsKeyCopy = Buffer.from(wsKey);

      const wrapped = wrapKey(wsKey, rawApiKey);
      const unwrapped = unwrapKey(wrapped, rawApiKey);

      expect(unwrapped.equals(wsKeyCopy)).toBe(true);
    });

    test("wrapped output is base64 and correct length", async () => {
      const wsKey = await deriveFullWorkspaceKey(userId, workspaceId);
      const wrapped = wrapKey(wsKey, rawApiKey);

      expect(() => Buffer.from(wrapped, "base64")).not.toThrow();

      // IV(12) + ciphertext(32) + tag(16) = 60 bytes
      const decoded = Buffer.from(wrapped, "base64");
      expect(decoded.length).toBe(60);
    });

    test("unwrap with wrong API key throws", async () => {
      const wsKey = await deriveFullWorkspaceKey(userId, workspaceId);
      const wrapped = wrapKey(wsKey, rawApiKey);

      expect(() => unwrapKey(wrapped, "eisen_wrongkeywrongkeywrongkeywrongkeywrongkeywro")).toThrow();
    });

    test("each wrap produces different ciphertext (random IV)", async () => {
      const wsKey = await deriveFullWorkspaceKey(userId, workspaceId);

      const wrapped1 = wrapKey(Buffer.from(wsKey), rawApiKey);
      const wrapped2 = wrapKey(Buffer.from(wsKey), rawApiKey);

      expect(wrapped1).not.toBe(wrapped2);
    });
  });
});
