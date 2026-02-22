-- One-time authorization codes issued after OAuth to avoid putting JWTs in URLs.
-- The frontend exchanges the code for the real session token via POST /auth/exchange.
CREATE TABLE IF NOT EXISTS auth_codes (
  code         TEXT PRIMARY KEY,
  session_json TEXT        NOT NULL,  -- JSON: { sessionToken, expiresAt, offlineDeadline }
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

-- Allow efficient cleanup of expired codes
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);
