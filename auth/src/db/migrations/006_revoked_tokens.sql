-- Tracks revoked JWT IDs so that logged-out tokens cannot be reused.
-- Rows are cleaned up once expires_at has passed (nothing to revoke for expired tokens).
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        TEXT        PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Allow efficient cleanup of rows that are no longer needed
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
