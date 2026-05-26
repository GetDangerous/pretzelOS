-- migrations/052_receipts.sql
-- Receipt processing — Drew snaps a photo, agent extracts + matches + categorizes.
-- One row per uploaded receipt.

CREATE TABLE IF NOT EXISTS receipts (
  id              TEXT PRIMARY KEY,
  uploaded_at     TEXT NOT NULL DEFAULT (datetime('now')),
  uploaded_by     TEXT DEFAULT 'drew',
  image_size_bytes INTEGER,
  mime_type       TEXT,
  -- Extracted via Haiku vision
  vendor_extracted TEXT,
  date_extracted  TEXT,
  amount_extracted REAL,
  items_extracted TEXT,                          -- JSON array
  raw_extraction  TEXT,                          -- full Haiku JSON for audit
  extraction_confidence REAL,
  extraction_cost_usd REAL,
  -- Matching
  matched_txn_type TEXT,                         -- 'mercury' | 'chase_cc' | NULL
  matched_txn_id  TEXT,
  match_confidence REAL,
  match_method    TEXT,                          -- 'amount_date_vendor' | 'amount_date_only' | etc.
  -- Suggested categorization
  suggested_account_id TEXT,
  suggested_account_name TEXT,
  suggested_via   TEXT,                          -- 'vendor_kb' | 'cfo_fact' | 'rule' | 'manual'
  -- Drew's decision
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'no_match'
  drew_action_at  TEXT,
  drew_note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_matched ON receipts(matched_txn_type, matched_txn_id) WHERE matched_txn_id IS NOT NULL;
