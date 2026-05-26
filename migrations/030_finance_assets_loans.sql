-- Migration 030 — Finance v2 Wave 2: fixed assets, depreciation, loans.
-- Per PRETZEL_OS_FINANCE_V2.md sections 2.3 and 3.8.

-- ── Fixed assets ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                       TEXT PRIMARY KEY,
  asset_name               TEXT NOT NULL,
  asset_class              TEXT NOT NULL,      -- leasehold_improvement | restaurant_equipment | furniture | signage | vehicle | branding | warmer
  acquisition_date         TEXT NOT NULL,
  acquisition_cost         REAL NOT NULL,
  useful_life_years        INTEGER NOT NULL,   -- 3, 5, 7, 15
  depreciation_method      TEXT NOT NULL,      -- straight_line | 200db | macrs
  salvage_value            REAL DEFAULT 0,
  monthly_depreciation     REAL NOT NULL,      -- pre-calculated for cron
  accumulated_depreciation REAL DEFAULT 0,
  net_book_value           REAL,               -- computed: cost - accumulated
  status                   TEXT DEFAULT 'active',  -- active | disposed | fully_depreciated
  disposal_date            TEXT,
  disposal_proceeds        REAL,
  location                 TEXT,               -- storefront, delta center (warmers)
  customer_id              TEXT,               -- for warmers placed at venues
  qbo_asset_account_id     TEXT,
  notes                    TEXT,
  created_at               TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fa_status    ON fixed_assets (status);
CREATE INDEX IF NOT EXISTS idx_fa_class     ON fixed_assets (asset_class);
CREATE INDEX IF NOT EXISTS idx_fa_customer  ON fixed_assets (customer_id);

CREATE TABLE IF NOT EXISTS depreciation_schedules (
  id                TEXT PRIMARY KEY,
  asset_id          TEXT NOT NULL REFERENCES fixed_assets(id),
  schedule_date     TEXT NOT NULL,             -- YYYY-MM-01
  amount            REAL NOT NULL,
  journal_entry_id  TEXT REFERENCES journal_entries(id),
  status            TEXT DEFAULT 'scheduled',  -- scheduled | posted | skipped
  UNIQUE(asset_id, schedule_date)
);
CREATE INDEX IF NOT EXISTS idx_dep_date ON depreciation_schedules (schedule_date, status);

-- ── Loans ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loans (
  id                     TEXT PRIMARY KEY,
  loan_name              TEXT NOT NULL,
  lender                 TEXT NOT NULL,
  origination_date       TEXT NOT NULL,
  original_principal     REAL NOT NULL,
  current_balance        REAL NOT NULL,
  interest_rate          REAL NOT NULL,         -- annual percentage (e.g. 8.5)
  term_months            INTEGER NOT NULL,
  monthly_payment        REAL NOT NULL,
  payment_day_of_month   INTEGER,               -- 1-31
  next_payment_date      TEXT,
  status                 TEXT DEFAULT 'active', -- active | paid_off | delinquent
  collateral             TEXT,
  agreement_r2_key       TEXT,                  -- optional PDF upload
  notes                  TEXT,
  created_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loan_status ON loans (status);
CREATE INDEX IF NOT EXISTS idx_loan_next   ON loans (next_payment_date);

CREATE TABLE IF NOT EXISTS loan_payments (
  id                TEXT PRIMARY KEY,
  loan_id           TEXT NOT NULL REFERENCES loans(id),
  payment_date      TEXT NOT NULL,
  total_amount      REAL NOT NULL,
  principal_portion REAL NOT NULL,
  interest_portion  REAL NOT NULL,
  remaining_balance REAL NOT NULL,
  mercury_txn_id    TEXT,
  journal_entry_id  TEXT REFERENCES journal_entries(id),
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lp_loan ON loan_payments (loan_id, payment_date);
