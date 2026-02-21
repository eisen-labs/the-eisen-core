CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier                   TEXT NOT NULL DEFAULT 'free',
  status                 TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ DEFAULT now()
);
