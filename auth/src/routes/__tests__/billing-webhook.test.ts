import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import Stripe from "stripe";
import { createHmac } from "node:crypto";
import { nanoid } from "nanoid";
import { query } from "../../db/client.ts";

// ── Constants shared across tests ───────────────────────────────────────────

const TEST_PRICE_PRO = "price_pro_webhook_test";
const TEST_SUB_ID = `sub_wh_${nanoid(14)}`;
const TEST_CUSTOMER_ID = `cus_wh_${nanoid(14)}`;

// ── Mock getStripe BEFORE app loads ─────────────────────────────────────────
//
// billing.ts calls getStripe().subscriptions.retrieve() inside
// handleCheckoutCompleted. We intercept it here so the test never makes a
// real Stripe API call.  verifyWebhookEvent and priceIdToTier are
// re-implemented using real logic so signature verification still works.

const mockSubscriptionRetrieve = mock(() =>
  Promise.resolve({
    id: TEST_SUB_ID,
    object: "subscription",
    status: "active",
    metadata: {},
    items: {
      data: [
        {
          price: { id: TEST_PRICE_PRO },
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        },
      ],
    },
  })
);

mock.module("../../lib/stripe.ts", () => {
  const _stripe = new Stripe(
    process.env.STRIPE_SECRET_KEY ?? "sk_test_placeholder_hmac_only",
    { apiVersion: "2026-01-28.clover" }
  );

  return {
    getStripe: () => ({ subscriptions: { retrieve: mockSubscriptionRetrieve } }),

    verifyWebhookEvent: async (rawBody: Buffer | string, sig: string) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
      return _stripe.webhooks.constructEventAsync(rawBody, sig, secret);
    },

    priceIdToTier: (priceId: string) => {
      if (priceId === TEST_PRICE_PRO) return "pro";
      return null;
    },
  };
});

// App loaded dynamically so it picks up the mock above
const { app } = await import("../../app.ts");

// ── Test fixtures ────────────────────────────────────────────────────────────

const TEST_USER_ID = `usr_wh_${nanoid(10)}`;
const TEST_EMAIL = `webhook-${nanoid(6)}@eisen.dev`;

beforeAll(async () => {
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
});

afterAll(async () => {
  await query("DELETE FROM subscriptions WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM users WHERE id = $1", [TEST_USER_ID]);
});

beforeEach(() => {
  mockSubscriptionRetrieve.mockClear();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Stripe signature format: t=<unix_ts>,v1=HMAC-SHA256("<ts>.<body>", secret)
// Implementing this manually because stripe.webhooks.generateTestHeaderString
// is synchronous and Bun's default SubtleCryptoProvider is async-only.
function signEvent(event: object): { body: string; sig: string } {
  const body = JSON.stringify(event);
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { body, sig: `t=${timestamp},v1=${hmac}` };
}

function post(body: string, sig?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sig) headers["Stripe-Signature"] = sig;
  return app.request("/billing/webhook", { method: "POST", headers, body });
}

function fakeEvent(type: string, object: object) {
  return {
    id: `evt_${nanoid(24)}`,
    object: "event",
    type,
    data: { object },
  };
}

// ── Signature verification ───────────────────────────────────────────────────

describe("POST /billing/webhook — signature verification", () => {
  test("returns 400 when Stripe-Signature header is missing", async () => {
    const res = await post(JSON.stringify({ type: "test" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Missing Stripe-Signature header");
  });

  test("returns 400 when signature is invalid", async () => {
    const res = await post(JSON.stringify({ type: "test" }), "t=123,v1=badhash");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid signature");
  });

  test("returns 200 for a validly signed unrecognised event type", async () => {
    const { body, sig } = signEvent(fakeEvent("unknown.event.type", {}));
    const res = await post(body, sig);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { received: boolean };
    expect(data.received).toBe(true);
  });
});

// ── checkout.session.completed ───────────────────────────────────────────────

describe("POST /billing/webhook — checkout.session.completed", () => {
  test("upgrades subscription to pro and stores Stripe IDs", async () => {
    const session = {
      id: `cs_${nanoid(24)}`,
      object: "checkout.session",
      mode: "subscription",
      metadata: { userId: TEST_USER_ID },
      subscription: TEST_SUB_ID,
      customer: TEST_CUSTOMER_ID,
    };

    const { body, sig } = signEvent(fakeEvent("checkout.session.completed", session));
    const res = await post(body, sig);
    expect(res.status).toBe(200);

    expect(mockSubscriptionRetrieve).toHaveBeenCalledWith(TEST_SUB_ID);

    const { rows } = await query(
      `SELECT tier, status, stripe_customer_id, stripe_subscription_id
       FROM subscriptions WHERE user_id = $1`,
      [TEST_USER_ID]
    );
    const sub = rows[0] as {
      tier: string;
      status: string;
      stripe_customer_id: string;
      stripe_subscription_id: string;
    };
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
    expect(sub.stripe_customer_id).toBe(TEST_CUSTOMER_ID);
    expect(sub.stripe_subscription_id).toBe(TEST_SUB_ID);
  });

  test("returns 200 but skips DB update when userId is absent from metadata", async () => {
    const session = {
      id: `cs_${nanoid(24)}`,
      object: "checkout.session",
      mode: "subscription",
      metadata: {},
      subscription: TEST_SUB_ID,
      customer: TEST_CUSTOMER_ID,
    };

    const { body, sig } = signEvent(fakeEvent("checkout.session.completed", session));
    const res = await post(body, sig);
    expect(res.status).toBe(200);
    expect(mockSubscriptionRetrieve).not.toHaveBeenCalled();
  });
});

// ── customer.subscription.updated ───────────────────────────────────────────

describe("POST /billing/webhook — customer.subscription.updated", () => {
  beforeAll(async () => {
    await query(
      `UPDATE subscriptions
       SET tier = 'pro', status = 'active',
           stripe_subscription_id = $1, stripe_customer_id = $2
       WHERE user_id = $3`,
      [TEST_SUB_ID, TEST_CUSTOMER_ID, TEST_USER_ID]
    );
  });

  test("syncs tier and status when userId is in subscription metadata", async () => {
    const subscription = {
      id: TEST_SUB_ID,
      object: "subscription",
      status: "active",
      metadata: { userId: TEST_USER_ID },
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          },
        ],
      },
    };

    const { body, sig } = signEvent(fakeEvent("customer.subscription.updated", subscription));
    const res = await post(body, sig);
    expect(res.status).toBe(200);

    const { rows } = await query(
      "SELECT tier, status FROM subscriptions WHERE user_id = $1",
      [TEST_USER_ID]
    );
    const sub = rows[0] as { tier: string; status: string };
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
  });

  test("marks subscription cancelled when Stripe status is 'canceled'", async () => {
    const subscription = {
      id: TEST_SUB_ID,
      object: "subscription",
      status: "canceled",
      metadata: { userId: TEST_USER_ID },
      items: {
        data: [{ price: { id: TEST_PRICE_PRO }, current_period_end: null }],
      },
    };

    const { body, sig } = signEvent(fakeEvent("customer.subscription.updated", subscription));
    const res = await post(body, sig);
    expect(res.status).toBe(200);

    const { rows } = await query(
      "SELECT status FROM subscriptions WHERE user_id = $1",
      [TEST_USER_ID]
    );
    expect((rows[0] as { status: string }).status).toBe("cancelled");
  });

  test("looks up user by stripe_subscription_id when userId absent from metadata", async () => {
    await query(
      "UPDATE subscriptions SET status = 'active' WHERE user_id = $1",
      [TEST_USER_ID]
    );

    const subscription = {
      id: TEST_SUB_ID,
      object: "subscription",
      status: "active",
      metadata: {},
      items: {
        data: [
          {
            price: { id: TEST_PRICE_PRO },
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
          },
        ],
      },
    };

    const { body, sig } = signEvent(fakeEvent("customer.subscription.updated", subscription));
    const res = await post(body, sig);
    expect(res.status).toBe(200);

    const { rows } = await query(
      "SELECT tier, status FROM subscriptions WHERE user_id = $1",
      [TEST_USER_ID]
    );
    const sub = rows[0] as { tier: string; status: string };
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
  });
});

// ── customer.subscription.deleted ───────────────────────────────────────────

describe("POST /billing/webhook — customer.subscription.deleted", () => {
  beforeAll(async () => {
    await query(
      "UPDATE subscriptions SET tier = 'pro', status = 'active' WHERE user_id = $1",
      [TEST_USER_ID]
    );
  });

  test("sets status to cancelled in DB", async () => {
    const subscription = {
      id: TEST_SUB_ID,
      object: "subscription",
      status: "canceled",
      metadata: {},
      items: { data: [] },
    };

    const { body, sig } = signEvent(fakeEvent("customer.subscription.deleted", subscription));
    const res = await post(body, sig);
    expect(res.status).toBe(200);

    const { rows } = await query(
      "SELECT status FROM subscriptions WHERE user_id = $1",
      [TEST_USER_ID]
    );
    expect((rows[0] as { status: string }).status).toBe("cancelled");
  });
});

// ── invoice.payment_failed ───────────────────────────────────────────────────

describe("POST /billing/webhook — invoice.payment_failed", () => {
  beforeAll(async () => {
    await query(
      "UPDATE subscriptions SET tier = 'pro', status = 'active' WHERE user_id = $1",
      [TEST_USER_ID]
    );
  });

  test("sets status to expired in DB", async () => {
    const invoice = {
      id: `in_${nanoid(24)}`,
      object: "invoice",
      parent: {
        subscription_details: {
          subscription: TEST_SUB_ID,
        },
      },
    };

    const { body, sig } = signEvent(fakeEvent("invoice.payment_failed", invoice));
    const res = await post(body, sig);
    expect(res.status).toBe(200);

    const { rows } = await query(
      "SELECT status FROM subscriptions WHERE user_id = $1",
      [TEST_USER_ID]
    );
    expect((rows[0] as { status: string }).status).toBe("expired");
  });

  test("returns 200 but skips DB update when subscription ID is missing", async () => {
    const invoice = {
      id: `in_${nanoid(24)}`,
      object: "invoice",
      parent: null,
    };

    const { body, sig } = signEvent(fakeEvent("invoice.payment_failed", invoice));
    const res = await post(body, sig);
    expect(res.status).toBe(200);
  });
});
