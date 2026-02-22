/**
 * E2E billing test — real Stripe test API + Test Clocks
 *
 * What this covers:
 *   1. Create a Stripe customer + attach test card (pm_card_visa)
 *   2. Start a subscription → verify the initial invoice is paid
 *   3. Fire the checkout.session.completed webhook → verify DB upgraded to pro
 *   4. Advance a Stripe Test Clock by 32 days → verify renewal invoice is paid
 *   5. Fire the customer.subscription.updated webhook → verify DB stays active
 *
 * Skips automatically when STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET are
 * not configured (placeholder values starting with "sk_test_" but short, or
 * "whsec_...").
 *
 * Run in isolation:
 *   bun test src/routes/__tests__/billing-e2e.test.ts
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import Stripe from "stripe";
import { createHmac } from "node:crypto";
import { nanoid } from "nanoid";
import { query } from "../../db/client.ts";
import { env } from "../../env.ts";
import { app } from "../../app.ts";

// ── Skip guard ───────────────────────────────────────────────────────────────

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

// Treat placeholder values ("whsec_..." / very-short keys) as unconfigured
const STRIPE_READY =
  STRIPE_KEY.startsWith("sk_test_") &&
  STRIPE_KEY.length > 30 &&
  WEBHOOK_SECRET.startsWith("whsec_") &&
  WEBHOOK_SECRET.length > 20 &&
  !WEBHOOK_SECRET.endsWith("...");

// ── Helpers ──────────────────────────────────────────────────────────────────

function signEvent(event: object): { body: string; sig: string } {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { body, sig: `t=${timestamp},v1=${hmac}` };
}

function postWebhook(body: string, sig: string) {
  return app.request("/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": sig },
    body,
  });
}

/** Poll until test clock status is 'ready' (Stripe advances clocks async). */
async function waitForClock(
  stripe: Stripe,
  clockId: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Test clock ${clockId} did not reach 'ready' within ${timeoutMs}ms`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_USER_ID = `usr_e2e_${nanoid(10)}`;
const TEST_EMAIL = `e2e-${nanoid(6)}@eisen.dev`;

// Stripe objects created during the test — cleaned up in afterAll
let stripe: Stripe;
let testClockId: string;
let customerId: string;
let subscriptionId: string;
let testProductId: string;
let testPriceId: string;

beforeAll(async () => {
  if (!STRIPE_READY) return;

  stripe = new Stripe(STRIPE_KEY, { apiVersion: "2026-01-28.clover" });

  // Insert test user + free subscription row into DB
  await query(
    `INSERT INTO users (id, email, provider, provider_id)
     VALUES ($1, $2, 'github', $3)
     ON CONFLICT DO NOTHING`,
    [TEST_USER_ID, TEST_EMAIL, `gh_${nanoid(10)}`]
  );
  await query(
    `INSERT INTO subscriptions (user_id, tier, status)
     VALUES ($1, 'free', 'active')
     ON CONFLICT (user_id) DO UPDATE
       SET tier = 'free', status = 'active',
           stripe_customer_id = NULL,
           stripe_subscription_id = NULL`,
    [TEST_USER_ID]
  );

  // Create a self-contained product + monthly price so the test doesn't
  // depend on STRIPE_PRO_PRICE_ID being configured.
  const product = await stripe.products.create({ name: "E2E Test Product" });
  testProductId = product.id;

  const price = await stripe.prices.create({
    product: testProductId,
    unit_amount: 1000, // $10
    currency: "usd",
    recurring: { interval: "month" },
  });
  testPriceId = price.id;

  // Patch env so priceIdToTier() maps our test price → "pro"
  (env as any).STRIPE_PRO_PRICE_ID = testPriceId;
});

afterAll(async () => {
  if (!STRIPE_READY) return;

  // Delete test clock (cascades to customer + subscription inside Stripe)
  if (testClockId) {
    try {
      await stripe.testHelpers.testClocks.del(testClockId);
    } catch {
      // ignore if already deleted
    }
  }

  // Restore patched env
  (env as any).STRIPE_PRO_PRICE_ID = undefined;

  // Archive the test price + product
  if (testPriceId) {
    await stripe.prices.update(testPriceId, { active: false }).catch(() => {});
  }
  if (testProductId) {
    await stripe.products.update(testProductId, { active: false }).catch(() => {});
  }

  // Clean up DB
  await query("DELETE FROM subscriptions WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM users WHERE id = $1", [TEST_USER_ID]);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Billing E2E — real Stripe test API + Test Clocks", () => {
  // ── 1. Subscribe with test card ────────────────────────────────────────────

  test("initial charge succeeds with test Visa card", async () => {
    if (!STRIPE_READY) {
      console.log("  (skipped — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not configured)");
      return;
    }

    const frozenNow = Math.floor(Date.now() / 1000);

    // Test clock lets us fast-forward billing cycles later
    const clock = await stripe.testHelpers.testClocks.create({
      frozen_time: frozenNow,
    });
    testClockId = clock.id;

    // Create Stripe customer tied to the test clock
    const customer = await stripe.customers.create({
      email: TEST_EMAIL,
      name: "E2E Test User",
      metadata: { userId: TEST_USER_ID },
      test_clock: testClockId,
    });
    customerId = customer.id;

    // Attach Stripe's pre-built test Visa card to the customer.
    // attach() returns the PaymentMethod with its real ID (e.g. pm_1Xxx…).
    // We MUST use that resolved ID — not the "pm_card_visa" token string —
    // when setting defaults; Stripe does not resolve the token in those fields.
    const attachedPm = await stripe.paymentMethods.attach("pm_card_visa", {
      customer: customerId,
    });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: attachedPm.id },
    });

    // Create subscription — Stripe immediately creates + pays the first invoice
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: testPriceId }],
      default_payment_method: attachedPm.id,
      metadata: { userId: TEST_USER_ID },
    });
    subscriptionId = sub.id;

    // An "active" status means the initial payment was collected successfully
    expect(sub.status).toBe("active");

    // Retrieve the first invoice separately and verify it was paid
    const invoices = await stripe.invoices.list({ customer: customerId, limit: 1 });
    expect(invoices.data[0]?.status).toBe("paid");
  });

  // ── 2. Webhook → DB upgraded to pro ───────────────────────────────────────

  test("checkout.session.completed webhook upgrades DB to pro", async () => {
    if (!STRIPE_READY) return;

    // Simulate the event Stripe sends after a user completes Checkout.
    // We use the real subscription ID so the handler's subscriptions.retrieve()
    // call returns live data from Stripe.
    const event = {
      id: `evt_e2e_${nanoid(20)}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_e2e_${nanoid(20)}`,
          object: "checkout.session",
          mode: "subscription",
          metadata: { userId: TEST_USER_ID },
          subscription: subscriptionId,
          customer: customerId,
        },
      },
    };

    const { body, sig } = signEvent(event);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);

    // The handler calls stripe.subscriptions.retrieve() with the real
    // subscription ID, maps the price → tier, then writes to DB.
    const { rows } = await query(
      `SELECT tier, status, stripe_customer_id, stripe_subscription_id
       FROM subscriptions WHERE user_id = $1`,
      [TEST_USER_ID]
    );
    const row = rows[0] as {
      tier: string;
      status: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
    };

    expect(row.tier).toBe("pro");
    expect(row.status).toBe("active");
    expect(row.stripe_customer_id).toBe(customerId);
    expect(row.stripe_subscription_id).toBe(subscriptionId);
  });

  // ── 3. Advance Test Clock → renewal charge ─────────────────────────────────

  // Allow 60s — Stripe processes the clock advancement asynchronously
  test("subscription renews automatically after 32 days (Test Clock)", async () => {
    if (!STRIPE_READY) return;

    // Fast-forward the test clock past the end of the first billing period.
    // Stripe will automatically generate and pay a renewal invoice.
    const subBefore = await stripe.subscriptions.retrieve(subscriptionId);
    const firstItem = subBefore.items.data[0];
    // Advance to 2 days past the current period end
    const targetTime = (firstItem?.current_period_end ?? Math.floor(Date.now() / 1000)) + 2 * 24 * 3600;
    await stripe.testHelpers.testClocks.advance(testClockId, {
      frozen_time: targetTime,
    });

    // Wait for Stripe to finish processing the clock advancement
    await waitForClock(stripe, testClockId, 60_000);

    // List invoices for this customer — should now have 2 paid invoices
    const invoiceList = await stripe.invoices.list({ customer: customerId });
    const paidInvoices = invoiceList.data.filter((inv) => inv.status === "paid");

    expect(paidInvoices.length).toBeGreaterThanOrEqual(2);

    // Subscription should still be active
    const updatedSub = await stripe.subscriptions.retrieve(subscriptionId);
    expect(updatedSub.status).toBe("active");
  });

  // ── 4. Renewal webhook → DB stays active ──────────────────────────────────

  test("customer.subscription.updated webhook keeps DB active after renewal", async () => {
    if (!STRIPE_READY) return;

    // Retrieve the live subscription state after the clock was advanced
    const updatedSub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });

    // Fire the event our app would normally receive from stripe listen
    const event = {
      id: `evt_e2e_${nanoid(20)}`,
      object: "event",
      type: "customer.subscription.updated",
      data: { object: updatedSub },
    };

    const { body, sig } = signEvent(event);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);

    const { rows } = await query(
      "SELECT status FROM subscriptions WHERE user_id = $1",
      [TEST_USER_ID]
    );
    expect((rows[0] as { status: string }).status).toBe("active");
  });
});
