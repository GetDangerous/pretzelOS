-- migrations/081_load_toast_sales_daily.sql
-- Phase 29-final: Load Toast Sales Summary DAILY data from Aug 2024 - Jun 2026
-- as primary source-of-truth table for retail revenue verification.
--
-- Drew exported the Sales Summary ZIP from Toast back office on 2026-05-19.
-- Daily net sales for 474 days. This becomes the verification basis for
-- all retail revenue posted to GL.

CREATE TABLE IF NOT EXISTS toast_sales_daily (
  sale_date TEXT PRIMARY KEY,    -- YYYY-MM-DD
  net_sales REAL NOT NULL,
  total_orders INTEGER NOT NULL,
  total_guests INTEGER NOT NULL,
  source TEXT DEFAULT 'toast_sales_summary_export_2026-05-19',
  loaded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_toast_sales_daily_month
  ON toast_sales_daily(sale_date);
