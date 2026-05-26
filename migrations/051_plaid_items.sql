-- migrations/051_plaid_items.sql
-- Plaid Item state — one row per connected bank login (Drew's Chase CC, etc.)
-- access_tokens are encrypted at rest using PLAID_ENCRYPTION_KEY (env secret).

CREATE TABLE IF NOT EXISTS plaid_items (
  id                  TEXT PRIMARY KEY,
  plaid_item_id       TEXT UNIQUE,             -- Plaid's identifier
  institution_id      TEXT,                    -- e.g., 'ins_56' for Chase
  institution_name    TEXT,                    -- 'Chase Business'
  account_ids         TEXT,                    -- JSON array of plaid account_ids on this item
  access_token_encrypted TEXT,                  -- encrypted via PLAID_ENCRYPTION_KEY
  encryption_iv       TEXT,                    -- IV for AES-GCM decryption
  cursor              TEXT,                    -- last cursor from /transactions/sync
  webhook_url         TEXT,
  status              TEXT NOT NULL DEFAULT 'good',  -- 'good' | 'login_required' | 'pending_disconnect' | 'expired'
  last_synced_at      TEXT,
  last_error          TEXT,
  consecutive_errors  INTEGER DEFAULT 0,
  created_at          TEXT DEFAULT (datetime('now')),
  updated_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plaid_items_status ON plaid_items(status);

-- Webhook log — every Plaid webhook received, for audit + retry
CREATE TABLE IF NOT EXISTS plaid_webhooks (
  id              TEXT PRIMARY KEY,
  plaid_item_id   TEXT,
  webhook_type    TEXT,                       -- 'TRANSACTIONS' | 'ITEM' | etc.
  webhook_code    TEXT,                       -- 'SYNC_UPDATES_AVAILABLE' | 'INITIAL_UPDATE' | 'ITEM_LOGIN_REQUIRED' | etc.
  payload         TEXT,                       -- raw JSON
  received_at     TEXT DEFAULT (datetime('now')),
  processed_at    TEXT,
  process_outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_plaid_webhooks_received ON plaid_webhooks(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaid_webhooks_unprocessed ON plaid_webhooks(processed_at) WHERE processed_at IS NULL;
