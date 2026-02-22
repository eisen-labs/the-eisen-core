import { Hono } from "hono";
import type Stripe from "stripe";
import { env } from "../env.ts";
import { query } from "../db/client.ts";
import { requireAuth } from "../middleware/requireAuth.ts";
import { getStripe, verifyWebhookEvent, priceIdToTier } from "../lib/stripe.ts";

const billing = new Hono();

// ── Public ──────────────────────────────────────────────

/**
 * GET /billing/plans — public plan metadata (no auth required)
 */
billing.get("/billing/plans", (c) => {
  return c.json({
    plans: [
      {
        tier: "free",
        price: 0,
        interval: null,
        features: [
          "Full Mastra orchestration pipeline",
          "Static default prompts",
          "Plaintext cache tables",
        ],
      },
      {
        tier: "pro",
        priceId: env.STRIPE_PRO_PRICE_ID ?? null,
        price: null, // filled by frontend from Stripe
        interval: "month",
        features: [
          "Everything in Free",
          "Learned context (optimized prompts, assignment rules)",
          "Column-level AES-256-GCM encryption",
          "BootstrapFewShot optimizer",
          "7-day offline grace period",
        ],
      },
      {
        tier: "premium",
        priceId: env.STRIPE_PREMIUM_PRICE_ID ?? null,
        price: null,
        interval: "month",
        features: [
          "Everything in Pro",
          "MIPROv2 optimizer",
          "Priority support",
        ],
      },
    ],
  });
});

// ── Authenticated ───────────────────────────────────────

/**
 * POST /billing/checkout — create a Stripe Checkout session
 *
 * Body: { tier: "pro" | "premium" }
 * Returns: { url: string } — the Checkout URL to redirect the user to
 */
billing.post("/billing/checkout", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ tier?: string }>();

  if (!body.tier || (body.tier !== "pro" && body.tier !== "premium")) {
    return c.json({ error: "tier must be 'pro' or 'premium'" }, 400);
  }

  const priceId =
    body.tier === "pro" ? env.STRIPE_PRO_PRICE_ID : env.STRIPE_PREMIUM_PRICE_ID;

  if (!priceId) {
    return c.json({ error: `Price ID not configured for tier: ${body.tier}` }, 500);
  }

  const stripe = getStripe();

  // Check if user already has a Stripe customer ID
  const subResult = await query(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
    [user.sub]
  );

  let customerId: string | undefined;

  if (subResult.rows.length && (subResult.rows[0] as { stripe_customer_id: string | null }).stripe_customer_id) {
    customerId = (subResult.rows[0] as { stripe_customer_id: string }).stripe_customer_id;
  } else {
    // Create a new Stripe customer
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId: user.sub },
    });
    customerId = customer.id;

    // Store the customer ID immediately
    await query(
      `UPDATE subscriptions SET stripe_customer_id = $1, updated_at = now()
       WHERE user_id = $2`,
      [customerId, user.sub]
    );
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${env.FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.FRONTEND_URL}/billing/cancel`,
    metadata: { userId: user.sub },
    subscription_data: {
      metadata: { userId: user.sub },
    },
  });

  return c.json({ url: session.url });
});

/**
 * POST /billing/portal — create a Stripe Customer Portal session
 *
 * Returns: { url: string } — the portal URL for managing the subscription
 */
billing.post("/billing/portal", requireAuth, async (c) => {
  const user = c.get("user");

  const subResult = await query(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
    [user.sub]
  );

  const row = subResult.rows[0] as { stripe_customer_id: string | null } | undefined;

  if (!row?.stripe_customer_id) {
    return c.json({ error: "No billing account found. Subscribe to a plan first." }, 400);
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${env.FRONTEND_URL}/billing`,
  });

  return c.json({ url: session.url });
});

// ── Webhook ─────────────────────────────────────────────

/**
 * POST /billing/webhook — Stripe webhook receiver
 *
 * IMPORTANT: This route must receive the raw body (not parsed JSON)
 * for Stripe signature verification. It does NOT use the requireAuth
 * middleware — authentication is via the Stripe-Signature header.
 */
billing.post("/billing/webhook", async (c) => {
  const signature = c.req.header("Stripe-Signature");
  if (!signature) {
    return c.json({ error: "Missing Stripe-Signature header" }, 400);
  }

  const rawBody = await c.req.arrayBuffer();

  let event: Stripe.Event;
  try {
    event = await verifyWebhookEvent(Buffer.from(rawBody), signature);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  try {
    await handleWebhookEvent(event);
  } catch (err) {
    console.error(`Webhook handler error [${event.type}]:`, err);
    // Return 200 anyway — Stripe will retry on non-2xx which could cause loops
    // for transient DB errors. Log the error for alerting.
  }

  return c.json({ received: true });
});

// ── Webhook Event Handlers ──────────────────────────────

async function handleWebhookEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;

    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
      break;

    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
      break;

    case "invoice.payment_failed":
      await handlePaymentFailed(event.data.object as Stripe.Invoice);
      break;

    default:
      // Unhandled event type — ignore
      break;
  }
}

/**
 * checkout.session.completed
 *
 * Fired when a user completes Stripe Checkout.
 * Activates the subscription and sets the tier.
 */
async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error("checkout.session.completed: missing userId in metadata");
    return;
  }

  const subscriptionId = session.subscription as string | null;
  if (!subscriptionId) return;

  // Fetch the subscription to get the price and period
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price.id;
  const tier = priceId ? priceIdToTier(priceId) : null;

  if (!tier) {
    console.error(`checkout.session.completed: unknown price ID ${priceId}`);
    return;
  }

  // current_period_end is on the subscription item in the latest Stripe API
  const periodEnd = firstItem?.current_period_end ?? null;

  await query(
    `UPDATE subscriptions
     SET tier = $1,
         status = 'active',
         stripe_customer_id = $2,
         stripe_subscription_id = $3,
         current_period_end = ${periodEnd ? "to_timestamp($4)" : "NULL"},
         updated_at = now()
     WHERE user_id = ${periodEnd ? "$5" : "$4"}`,
    [
      tier,
      session.customer as string,
      subscriptionId,
      ...(periodEnd ? [periodEnd, userId] : [userId]),
    ]
  );

  console.log(`Subscription activated: user=${userId} tier=${tier}`);
}

/**
 * customer.subscription.updated
 *
 * Fired when a subscription changes (upgrade, downgrade, renewal).
 * Syncs tier, status, and period end.
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    // Try to find user by stripe_subscription_id
    const result = await query(
      `SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1`,
      [subscription.id]
    );
    if (!result.rows.length) {
      console.error(`subscription.updated: cannot find user for sub ${subscription.id}`);
      return;
    }
    await syncSubscription(
      (result.rows[0] as { user_id: string }).user_id,
      subscription
    );
    return;
  }

  await syncSubscription(userId, subscription);
}

/**
 * customer.subscription.deleted
 *
 * Fired when a subscription is cancelled (end of billing period or immediate).
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const result = await query(
    `UPDATE subscriptions
     SET status = 'cancelled',
         updated_at = now()
     WHERE stripe_subscription_id = $1
     RETURNING user_id`,
    [subscription.id]
  );

  if (result.rows.length) {
    const userId = (result.rows[0] as { user_id: string }).user_id;
    console.log(`Subscription cancelled: user=${userId}`);
  }
}

/**
 * invoice.payment_failed
 *
 * Fired when a payment attempt fails. Marks the subscription as expired.
 */
async function handlePaymentFailed(invoice: Stripe.Invoice) {
  // In the latest Stripe API, subscription is under invoice.parent.subscription_details
  const subscriptionId =
    invoice.parent?.subscription_details?.subscription as string | null;
  if (!subscriptionId) return;

  const result = await query(
    `UPDATE subscriptions
     SET status = 'expired',
         updated_at = now()
     WHERE stripe_subscription_id = $1
     RETURNING user_id`,
    [subscriptionId]
  );

  if (result.rows.length) {
    const userId = (result.rows[0] as { user_id: string }).user_id;
    console.log(`Payment failed: user=${userId} subscription=${subscriptionId}`);
  }
}

/**
 * Sync a subscription row from a Stripe Subscription object.
 */
async function syncSubscription(userId: string, subscription: Stripe.Subscription) {
  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price.id;
  const tier = priceId ? priceIdToTier(priceId) : null;
  const periodEnd = firstItem?.current_period_end ?? null;

  // Map Stripe status to our status
  let status: "active" | "expired" | "cancelled";
  switch (subscription.status) {
    case "active":
    case "trialing":
      status = "active";
      break;
    case "canceled":
    case "unpaid":
      status = "cancelled";
      break;
    default:
      status = "expired";
      break;
  }

  await query(
    `UPDATE subscriptions
     SET tier = COALESCE($1, tier),
         status = $2,
         stripe_subscription_id = $3,
         current_period_end = ${periodEnd ? "to_timestamp($4)" : "NULL"},
         updated_at = now()
     WHERE user_id = ${periodEnd ? "$5" : "$4"}`,
    [
      tier,
      status,
      subscription.id,
      ...(periodEnd ? [periodEnd, userId] : [userId]),
    ]
  );

  console.log(`Subscription synced: user=${userId} tier=${tier} status=${status}`);
}

export { billing };
