-- migrations/038_vendor_kb.sql
-- Vendor Knowledge Base — what the bookkeeper categorized each vendor as.
--
-- Built once from qbo_archive_entity (Purchase + Bill + JournalEntry + Deposit
-- entities) and refreshed weekly. Each row represents a unique (vendor, account)
-- pair with frequency + dollar volume.
--
-- The categorizer consults this BEFORE its rule-based logic. If a vendor has a
-- dominant categorization in the KB (≥70% of historical activity to one account),
-- new Mercury txns get that account at 0.95 confidence.

CREATE TABLE IF NOT EXISTS vendor_categorization_history (
  id              TEXT PRIMARY KEY,
  vendor_name     TEXT NOT NULL,                -- normalized lowercase, trimmed
  vendor_display  TEXT NOT NULL,                -- original casing
  account_id      TEXT NOT NULL REFERENCES chart_of_accounts(id),
  account_name    TEXT,                         -- denormalized for fast reads
  account_type    TEXT,
  count_seen      INTEGER NOT NULL DEFAULT 0,   -- how many times this vendor mapped here
  total_amount    REAL    NOT NULL DEFAULT 0,   -- sum of dollar volume
  first_seen      TEXT,
  last_seen       TEXT,
  source          TEXT NOT NULL DEFAULT 'qbo',  -- 'qbo' | 'cfo_facts' | 'drew_override'
  last_refreshed  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(vendor_name, account_id, source)
);
CREATE INDEX IF NOT EXISTS idx_vendor_kb_name ON vendor_categorization_history(vendor_name);
CREATE INDEX IF NOT EXISTS idx_vendor_kb_account ON vendor_categorization_history(account_id);

-- Per-vendor summary view for fast lookups (computed dominant account + confidence).
CREATE TABLE IF NOT EXISTS vendor_kb_summary (
  vendor_name           TEXT PRIMARY KEY,
  vendor_display        TEXT,
  total_txns            INTEGER NOT NULL DEFAULT 0,
  total_dollar_volume   REAL    NOT NULL DEFAULT 0,
  dominant_account_id   TEXT,                   -- the most-common account
  dominant_account_name TEXT,
  dominant_share        REAL,                   -- fraction of txns going to dominant (0-1)
  dominant_dollar_share REAL,                   -- fraction of $ volume to dominant
  account_count         INTEGER,                -- how many distinct accounts this vendor has hit
  last_refreshed        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_kb_summary_share ON vendor_kb_summary(dominant_share DESC);
