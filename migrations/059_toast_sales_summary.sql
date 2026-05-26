-- Session 20F (May 14 2026) — Toast Sales Summary authoritative records
--
-- Drew exports official Toast "SalesSummary" reports per date range from
-- Toast Web. We store the headline numbers from "Revenue summary.csv" plus
-- payment-type breakdown for reconciliation against Mercury inflows.
--
-- One row per ingested period range. Authoritative source for net sales,
-- tax collected, tips collected, gratuity, gifts (deferred), cash activity.

CREATE TABLE IF NOT EXISTS toast_sales_summary (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  -- Revenue summary (the canonical numbers)
  net_sales REAL NOT NULL,        -- GAAP revenue
  gross_sales REAL,
  discounts REAL,                  -- negative
  refunds REAL,                    -- negative
  gratuity REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  tips REAL DEFAULT 0,
  gift_cards_deferred REAL DEFAULT 0,
  deposit_sales_collected REAL DEFAULT 0,
  total REAL NOT NULL,
  -- Cash activity (drawer)
  cash_payments REAL DEFAULT 0,
  cash_adjustments REAL DEFAULT 0,
  cash_refunds REAL DEFAULT 0,
  total_cash_drawer_change REAL DEFAULT 0,
  -- Payment-type breakdown (for reconciliation against Mercury)
  payment_card REAL DEFAULT 0,           -- Visa/MC/AMEX/Discover combined
  payment_cash REAL DEFAULT 0,
  payment_gift_card REAL DEFAULT 0,
  payment_doordash REAL DEFAULT 0,
  payment_ubereats REAL DEFAULT 0,
  payment_grubhub REAL DEFAULT 0,
  payment_other REAL DEFAULT 0,
  ingested_at TEXT DEFAULT (datetime('now')),
  source_file TEXT,
  raw_csv TEXT,                    -- preserve the Revenue summary.csv content
  UNIQUE(period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_toast_sales_summary_period ON toast_sales_summary(period_start, period_end);
