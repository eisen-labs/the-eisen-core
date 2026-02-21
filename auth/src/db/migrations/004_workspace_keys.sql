CREATE TABLE IF NOT EXISTS workspace_keys (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  rotated_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, workspace_id)
);
