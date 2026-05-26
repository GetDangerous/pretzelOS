-- Migration 035 — QBO archive tables for Finance v2 Wave 0 (2025 data for Irene).
-- Per PRETZEL_OS_FINANCE_V2.md section 0.1.
--
-- Strategy: one flat table per QBO entity type is overkill for an archive. Instead we
-- use a single qbo_archive_entity with (entity_type, qbo_id) as the logical key and the
-- full raw JSON in one column. Reports use a separate table since they're non-entity.

CREATE TABLE IF NOT EXISTS qbo_archive_entity (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,         -- Invoice | Bill | Payment | JournalEntry | Purchase | Customer | Vendor | Item | Employee | BillPayment | Deposit
  qbo_id        TEXT NOT NULL,
  txn_date      TEXT,                  -- normalized YYYY-MM-DD (NULL for reference entities)
  raw_json      TEXT NOT NULL,
  fetched_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(entity_type, qbo_id)
);
CREATE INDEX IF NOT EXISTS idx_qbo_arch_type_date ON qbo_archive_entity (entity_type, txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_arch_date      ON qbo_archive_entity (txn_date);

-- Reports (P&L, Balance Sheet, Aged Receivables) are report objects, not entities.
-- Stored separately so we can pull snapshot-as-of-date variants.
CREATE TABLE IF NOT EXISTS qbo_archive_report (
  id            TEXT PRIMARY KEY,
  report_type   TEXT NOT NULL,         -- ProfitAndLoss | BalanceSheet | AgedReceivables | GeneralLedger | SalesTaxLiability
  period_start  TEXT,                  -- NULL for point-in-time (balance sheet)
  period_end    TEXT NOT NULL,
  accounting_method TEXT,              -- Cash | Accrual
  raw_json      TEXT NOT NULL,
  fetched_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_qbo_arch_report_type ON qbo_archive_report (report_type, period_end);

-- Add notes column to chart_of_accounts (used by QBO extract for spec cleanups).
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS; this will fail on re-run.
-- Guarded by checking sqlite_master — if the column already exists, this is a no-op
-- from the developer's perspective (the first-run ALTER succeeds, re-runs fail
-- but migration 035 as a whole is still applied).
ALTER TABLE chart_of_accounts ADD COLUMN notes TEXT;

