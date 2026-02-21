import { test, expect, describe } from "bun:test";
import { env } from "../../env.ts";

const { priceIdToTier } = await import("../stripe.ts");

describe("Stripe", () => {
  describe("priceIdToTier", () => {
    test("maps pro price ID correctly", () => {
      if (!env.STRIPE_PRO_PRICE_ID) {
        console.log("  (skipped — STRIPE_PRO_PRICE_ID not set)");
        return;
      }
      expect(priceIdToTier(env.STRIPE_PRO_PRICE_ID)).toBe("pro");
    });

    test("maps premium price ID correctly", () => {
      if (!env.STRIPE_PREMIUM_PRICE_ID) {
        console.log("  (skipped — STRIPE_PREMIUM_PRICE_ID not set)");
        return;
      }
      // If pro and premium price IDs are identical (placeholder), skip
      if (env.STRIPE_PRO_PRICE_ID === env.STRIPE_PREMIUM_PRICE_ID) {
        console.log("  (skipped — pro and premium price IDs are identical placeholders)");
        return;
      }
      expect(priceIdToTier(env.STRIPE_PREMIUM_PRICE_ID)).toBe("premium");
    });

    test("returns null for unknown price ID", () => {
      expect(priceIdToTier("price_unknown_does_not_exist")).toBeNull();
    });

    test("returns null for empty string", () => {
      expect(priceIdToTier("")).toBeNull();
    });

    test("function correctly distinguishes distinct price IDs", () => {
      // Direct test with known distinct values to validate logic
      // This tests the actual matching without relying on env placeholders
      const originalPro = env.STRIPE_PRO_PRICE_ID;
      const originalPremium = env.STRIPE_PREMIUM_PRICE_ID;

      // Temporarily patch env for this unit test
      (env as any).STRIPE_PRO_PRICE_ID = "price_pro_test_distinct";
      (env as any).STRIPE_PREMIUM_PRICE_ID = "price_premium_test_distinct";

      try {
        expect(priceIdToTier("price_pro_test_distinct")).toBe("pro");
        expect(priceIdToTier("price_premium_test_distinct")).toBe("premium");
        expect(priceIdToTier("price_other")).toBeNull();
      } finally {
        (env as any).STRIPE_PRO_PRICE_ID = originalPro;
        (env as any).STRIPE_PREMIUM_PRICE_ID = originalPremium;
      }
    });
  });
});
