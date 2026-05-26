-- migrations/044_chase_cc.sql
-- Chase Business Credit Card (synced via Plaid).
-- Categorized through the same KB-first stack as Mercury, just to a different
-- liability account on the chart of accounts.

CREATE TABLE IF NOT EXISTS chase_cc_accounts (
  id              TEXT PRIMARY KEY,
  plaid_account_id TEXT UNIQUE,            -- from Plaid
  plaid_item_id   TEXT,                     -- which Plaid Item this belongs to
  account_name    TEXT,                     -- 'Chase Business CC ••4321'
  account_type    TEXT DEFAULT 'credit_card',
  account_mask    TEXT,                     -- last 4 of card number
  current_balance REAL,                     -- NEGATIVE = balance owed (we're using account-perspective)
  available_credit REAL,
  credit_limit    REAL,
  iso_currency    TEXT DEFAULT 'USD',
  is_active       INTEGER DEFAULT 1,
  last_synced_at  TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chase_cc_accounts_active ON chase_cc_accounts(is_active);

CREATE TABLE IF NOT EXISTS chase_cc_transactions (
  id                TEXT PRIMARY KEY,
  account_id        TEXT REFERENCES chase_cc_accounts(id),
  plaid_transaction_id TEXT UNIQUE,         -- Plaid's stable identifier
  txn_date          TEXT,                   -- date the user spent the money
  posted_date       TEXT,                   -- date the bank posted it
  amount            REAL,                   -- POSITIVE = charge (debit), NEGATIVE = payment/refund (Plaid convention)
  merchant          TEXT,
  description       TEXT,
  plaid_category    TEXT,                   -- Plaid's own category (informational)
  pending           INTEGER DEFAULT 0,      -- 1 = still pending (don't post JE yet)
  proposed_account_id  TEXT REFERENCES chart_of_accounts(id),
  proposed_confidence  REAL,
  proposed_reasoning   TEXT,
  user_overridden   INTEGER DEFAULT 0,
  is_reconciled     INTEGER DEFAULT 0,
  matched_journal_entry_id TEXT,
  raw_payload       TEXT,                   -- full Plaid txn JSON for audit
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chase_cc_txns_date ON chase_cc_transactions(txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_chase_cc_txns_review ON chase_cc_transactions(is_reconciled, proposed_confidence) WHERE is_reconciled = 0;
CREATE INDEX IF NOT EXISTS idx_chase_cc_txns_pending ON chase_cc_transactions(pending) WHERE pending = 1;
