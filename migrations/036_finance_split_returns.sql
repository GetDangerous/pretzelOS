-- Migration 036 — Split sales_tax_filings to track multiple returns per period.
--
-- Context: Utah requires TWO separate returns for a single quarter:
--   1. TC-62 Sales and Use Tax Return  (account suffix -003-STC)
--   2. Sales Prepared Food Return       (account suffix -003-SPF, 1% restaurant tax)
--
-- The original schema (migration 034) had UNIQUE(jurisdiction, period) which forced
-- one row per period. Drew filed Q1-2026 on Apr 22 as two separate returns; the
-- calculator now needs to render, store, and track them independently.
--
-- Strategy (SQLite UNIQUE constraints can't be dropped via ALTER):
--   1. Rename the existing sales_tax_filings table → _legacy
--   2. Create new sales_tax_filings with (jurisdiction, period, return_type) UNIQUE
--   3. Copy legacy rows forward as return_type='combined' (preserves filed status/audit trail)
--   4. Drop the _legacy table

-- Step 1: rename legacy
ALTER TABLE sales_tax_filings RENAME TO sales_tax_filings_legacy;

-- Step 2: create the new table with return_type dimension
CREATE TABLE sales_tax_filings (
  id                           TEXT PRIMARY KEY,
  jurisdiction                 TEXT NOT NULL,
  period                       TEXT NOT NULL,            -- Q1-2026 | Q2-2026 | ...
  return_type                  TEXT NOT NULL,            -- tc_62 | spf | combined (legacy rollup)
  account_suffix               TEXT,                     -- -003-STC | -003-SPF
  form_name                    TEXT,                     -- TC-62 Sales and Use Tax Return | Sales Prepared Food Return
  due_date                     TEXT NOT NULL,
  filed_date                   TEXT,
  filing_confirmation_number   TEXT,
  gross_sales                  REAL,
  exempt_sales                 REAL,
  taxable_sales                REAL,
  tax_rate                     REAL,                     -- effective blended rate for this return
  tax_collected                REAL,                     -- from POS
  tax_owed                     REAL,                     -- what Utah says we owe
  payment_date                 TEXT,
  payment_amount               REAL,
  status                       TEXT DEFAULT 'pending',   -- pending | calculated | filed | paid | amended
  worksheet_pdf_r2_key         TEXT,
  worksheet_json               TEXT,
  notes                        TEXT,
  created_at                   TEXT DEFAULT (datetime('now')),
  updated_at                   TEXT DEFAULT (datetime('now')),
  UNIQUE(jurisdiction, period, return_type)
);

-- Step 3: copy legacy rows forward. Existing Q1-2026 row becomes `combined`
-- so Drew doesn't lose filed status / confirmation / worksheet_json. A
-- separate step will backfill SPF + TC-62 rows for Q1-2026 based on the
-- canonical Toast breakdown.
INSERT INTO sales_tax_filings (
  id, jurisdiction, period, return_type, due_date, filed_date,
  filing_confirmation_number, gross_sales, exempt_sales, taxable_sales,
  tax_collected, tax_owed, payment_date, payment_amount, status,
  worksheet_pdf_r2_key, worksheet_json, notes, created_at, updated_at
)
SELECT
  id, jurisdiction, period, 'combined' AS return_type, due_date, filed_date,
  filing_confirmation_number, gross_sales, exempt_sales, taxable_sales,
  tax_collected, tax_owed, payment_date, payment_amount, status,
  worksheet_pdf_r2_key, worksheet_json, notes, created_at, updated_at
FROM sales_tax_filings_legacy;

-- Step 4: rebuild the index that existed on the legacy table
CREATE INDEX IF NOT EXISTS idx_stf_due    ON sales_tax_filings (due_date, status);
CREATE INDEX IF NOT EXISTS idx_stf_period ON sales_tax_filings (period, return_type);

-- Step 5: drop the legacy table (data already copied)
DROP TABLE sales_tax_filings_legacy;

-- Also extend sales_tax_liability with a return_type so we can allocate rows
-- to the correct Utah return when multiple returns cover the same period.
-- Default NULL = "applies to all returns" (for now everything with Utah
-- collects both Sales & Use tax and the 1% Restaurant Tax in parallel, so
-- existing Toast upload rows don't need to be re-allocated).
ALTER TABLE sales_tax_liability ADD COLUMN return_type TEXT;
CREATE INDEX IF NOT EXISTS idx_stl_return ON sales_tax_liability (filing_period, return_type);
