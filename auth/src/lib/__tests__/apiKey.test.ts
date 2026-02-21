import { test, expect, describe } from "bun:test";

const { generateApiKey, hashApiKey, verifyApiKey } = await import("../apiKey.ts");

describe("API Key", () => {
  describe("generateApiKey", () => {
    test("returns raw key with eisen_ prefix", async () => {
      const { raw } = await generateApiKey();

      expect(raw).toStartWith("eisen_");
      expect(raw.length).toBe(6 + 43); // "eisen_" + nanoid(43)
    });

    test("prefix is first 14 chars of raw key", async () => {
      const { raw, prefix } = await generateApiKey();

      expect(prefix).toBe(raw.slice(0, 14)); // "eisen_" (6) + 8 chars
      expect(prefix.length).toBe(14);
    });

    test("hash is a bcrypt string", async () => {
      const { hash } = await generateApiKey();

      expect(hash).toStartWith("$2");
      expect(hash.length).toBeGreaterThan(50);
    });

    test("each call generates unique keys", async () => {
      const key1 = await generateApiKey();
      const key2 = await generateApiKey();

      expect(key1.raw).not.toBe(key2.raw);
      expect(key1.hash).not.toBe(key2.hash);
    });
  });

  describe("hashApiKey + verifyApiKey", () => {
    test("verify succeeds for matching key", async () => {
      const raw = "eisen_test_key_for_hashing_12345";
      const hash = await hashApiKey(raw);
      const valid = await verifyApiKey(raw, hash);

      expect(valid).toBe(true);
    });

    test("verify fails for wrong key", async () => {
      const raw = "eisen_test_key_for_hashing_12345";
      const hash = await hashApiKey(raw);
      const valid = await verifyApiKey("eisen_wrong_key_xxxxxxxxxxxxx", hash);

      expect(valid).toBe(false);
    });

    test("generated key verifies against its own hash", async () => {
      const { raw, hash } = await generateApiKey();
      const valid = await verifyApiKey(raw, hash);

      expect(valid).toBe(true);
    });
  });
});
