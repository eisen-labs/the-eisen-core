import Stripe from "stripe";
import { env } from "../env.ts";

let _stripe: Stripe | null = null;

/**
 * Lazily initialized Stripe client singleton.
 * Throws if STRIPE_SECRET_KEY is not configured.
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY env var not configured");
    }
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-01-28.clover",
    });
  }
  return _stripe;
}

/**
 * Verify a Stripe webhook signature and parse the event.
 *
 * Requires the raw request body (not parsed JSON) and the
 * Stripe-Signature header.
 */
export async function verifyWebhookEvent(
  rawBody: string,
  signature: string
): Promise<Stripe.Event> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET env var not configured");
  }

  const stripe = getStripe();
  return stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET
  );
}

/**
 * Map a Stripe Price ID to a subscription tier.
 */
export function priceIdToTier(priceId: string): "pro" | "premium" | null {
  if (priceId === env.STRIPE_PRO_PRICE_ID) return "pro";
  if (priceId === env.STRIPE_PREMIUM_PRICE_ID) return "premium";
  return null;
}
