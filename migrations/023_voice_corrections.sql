-- voice_corrections was being created lazily inside /account/migrate.
-- Move to a proper migration so a fresh D1 `migrations apply` creates it.
-- Existing prod already has the table (created by the lazy path), so IF NOT EXISTS is safe.

CREATE TABLE IF NOT EXISTS voice_corrections (
  id TEXT PRIMARY KEY,
  log_id TEXT,
  venue_id TEXT,
  original_subject TEXT,
  edited_subject TEXT,
  original_body TEXT,
  edited_body TEXT,
  optimizer_consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_corrections_unconsumed
  ON voice_corrections(optimizer_consumed_at)
  WHERE optimizer_consumed_at IS NULL;
