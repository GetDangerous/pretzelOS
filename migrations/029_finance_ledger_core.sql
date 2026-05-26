-- Migration 029 — Finance v2 Wave 2: ledger core
-- Chart of accounts, journal entries (double-entry with CHECK), closed periods.
-- Per PRETZEL_OS_FINANCE_V2.md sections 2.1, 2.2, 3.4 (closed periods).

-- ── Chart of accounts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id                 TEXT PRIMARY KEY,
  account_number     INTEGER UNIQUE,
  account_name       TEXT NOT NULL,
  account_type       TEXT NOT NULL,        -- asset | liability | equity | revenue | cogs | expense | other_income | other_expense
  account_subtype    TEXT,                 -- current_asset | fixed_asset | long_term_liability | etc.
  parent_account_id  TEXT REFERENCES chart_of_accounts(id),
  detail_type        TEXT,                 -- maps to QBO detail types for tax mapping
  is_active          INTEGER DEFAULT 1,
  is_system          INTEGER DEFAULT 0,    -- protected from deletion
  qbo_account_id     TEXT,                 -- for migration mapping (2025 archive)
  description        TEXT,
  created_at         TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coa_type    ON chart_of_accounts (account_type);
CREATE INDEX IF NOT EXISTS idx_coa_active  ON chart_of_accounts (is_active);
CREATE INDEX IF NOT EXISTS idx_coa_parent  ON chart_of_accounts (parent_account_id);

-- ── Journal entries ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS journal_entries (
  id                   TEXT PRIMARY KEY,
  entry_date           TEXT NOT NULL,          -- YYYY-MM-DD
  entry_number         INTEGER UNIQUE,         -- sequential ledger number
  description          TEXT NOT NULL,
  source_type          TEXT NOT NULL,          -- square_order | square_payroll | mercury_txn | manual | depreciation | sales_tax | opening_balance | adjustment | loan_payment
  source_id            TEXT,                   -- original id from source system (square order id, mercury txn id, etc.)
  total_debit          REAL NOT NULL,
  total_credit         REAL NOT NULL,
  status               TEXT DEFAULT 'posted',  -- draft | posted | reversed | reviewed
  reversal_of_entry_id TEXT REFERENCES journal_entries(id),
  created_by           TEXT NOT NULL,          -- cfo_agent | drew | irene | opening_balance | system
  reviewed_by          TEXT,                   -- drew | irene
  reviewed_at          TEXT,
  notes                TEXT,
  created_at           TEXT DEFAULT (datetime('now')),
  -- SQLite floats are fine as long as we don't pretend exact equality; use cent-level tolerance.
  CHECK (ABS(total_debit - total_credit) < 0.01)
);
CREATE INDEX IF NOT EXISTS idx_je_date    ON journal_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_je_source  ON journal_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_je_status  ON journal_entries (status);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id                 TEXT PRIMARY KEY,
  journal_entry_id   TEXT NOT NULL REFERENCES journal_entries(id),
  line_number        INTEGER NOT NULL,
  account_id         TEXT NOT NULL REFERENCES chart_of_accounts(id),
  debit              REAL DEFAULT 0,
  credit             REAL DEFAULT 0,
  memo               TEXT,
  customer_id        TEXT,
  vendor_id          TEXT,
  employee_id        TEXT,
  -- Each line is EITHER a debit OR a credit, never both, never both zero.
  CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0))
);
CREATE INDEX IF NOT EXISTS idx_jel_entry    ON journal_entry_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account  ON journal_entry_lines (account_id);
CREATE INDEX IF NOT EXISTS idx_jel_customer ON journal_entry_lines (customer_id);
CREATE INDEX IF NOT EXISTS idx_jel_vendor   ON journal_entry_lines (vendor_id);

-- ── Closed periods (monthly close lock) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS closed_periods (
  id            TEXT PRIMARY KEY,
  period_start  TEXT NOT NULL,           -- YYYY-MM-01
  period_end    TEXT NOT NULL,           -- last day of month
  locked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  locked_by     TEXT NOT NULL,           -- cfo_agent | drew
  unlock_reason TEXT,                    -- populated if period is temporarily unlocked
  unlocked_at   TEXT,
  unlocked_by   TEXT,
  UNIQUE(period_start, period_end)
);
CREATE INDEX IF NOT EXISTS idx_closed_period ON closed_periods (period_start, period_end);
