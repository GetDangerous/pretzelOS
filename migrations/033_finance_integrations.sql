-- Migration 033 — Finance v2 Wave 2: Mercury + Square finance-ledger sync tables.
-- Per PRETZEL_OS_FINANCE_V2.md sections 2.10, 2.11.
-- Note: `fin_square_orders` is INTENTIONALLY distinct from the existing `orders`
-- table. `orders` serves the retail dashboard (churn/loyalty/reviews). This
-- table is the GL-grade Square mirror used by CFO Agent v2 to post daily JEs.

-- ── Mercury ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mercury_accounts (
  id                   TEXT PRIMARY KEY,
  mercury_account_id   TEXT UNIQUE NOT NULL,
  account_name         TEXT NOT NULL,
  account_type         TEXT,                   -- checking | savings | credit_card
  current_balance      REAL,
  available_balance    REAL,
  last_synced_at       TEXT,
  is_active            INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mercury_transactions (
  id                        TEXT PRIMARY KEY,
  mercury_txn_id            TEXT UNIQUE NOT NULL,
  account_id                TEXT NOT NULL,     -- references mercury_accounts.mercury_account_id (Mercury-side id)
  account_name              TEXT NOT NULL,
  txn_date                  TEXT NOT NULL,
  amount                    REAL NOT NULL,     -- positive inflow, negative outflow
  description               TEXT,
  counterparty_name         TEXT,
  category                  TEXT,              -- raw Mercury category
  status                    TEXT,              -- posted | pending
  is_reconciled             INTEGER DEFAULT 0,
  matched_journal_entry_id  TEXT REFERENCES journal_entries(id),
  matched_invoice_id        TEXT REFERENCES invoices(id),
  matched_bill_id           TEXT REFERENCES bills(id),
  proposed_account_id       TEXT REFERENCES chart_of_accounts(id),
  proposed_confidence       REAL,              -- 0..1
  proposed_reasoning        TEXT,
  user_overridden           INTEGER DEFAULT 0,
  created_at                TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mtx_date       ON mercury_transactions (txn_date);
CREATE INDEX IF NOT EXISTS idx_mtx_reconciled ON mercury_transactions (is_reconciled, txn_date);
CREATE INDEX IF NOT EXISTS idx_mtx_counter    ON mercury_transactions (counterparty_name);

-- ── Finance-grade Square mirror ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fin_square_orders (
  id                  TEXT PRIMARY KEY,
  square_order_id     TEXT UNIQUE NOT NULL,
  order_date          TEXT NOT NULL,
  location_id         TEXT,
  total_amount        REAL NOT NULL,
  total_tax           REAL DEFAULT 0,
  total_tip           REAL DEFAULT 0,
  total_discount      REAL DEFAULT 0,
  total_fees          REAL DEFAULT 0,
  net_amount          REAL NOT NULL,           -- amount Square deposits to Mercury
  payment_method      TEXT,
  fulfillment_type    TEXT,                    -- pickup | delivery | dine_in
  customer_id         TEXT,
  channel             TEXT,                    -- in_store | online | doordash | ubereats
  source_type         TEXT,                    -- square_pos | doordash | ubereats | grubhub
  is_reconciled       INTEGER DEFAULT 0,
  journal_entry_id    TEXT REFERENCES journal_entries(id),
  raw_payload         TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fsq_date      ON fin_square_orders (order_date);
CREATE INDEX IF NOT EXISTS idx_fsq_reconciled ON fin_square_orders (is_reconciled, order_date);

CREATE TABLE IF NOT EXISTS fin_square_order_items (
  id                 TEXT PRIMARY KEY,
  square_order_id    TEXT NOT NULL REFERENCES fin_square_orders(square_order_id),
  sku                TEXT,
  name               TEXT NOT NULL,
  category           TEXT,                     -- maps to revenue accounts
  quantity           INTEGER NOT NULL,
  unit_price         REAL NOT NULL,
  line_total         REAL NOT NULL,
  is_tax_exempt      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fsqi_order ON fin_square_order_items (square_order_id);
