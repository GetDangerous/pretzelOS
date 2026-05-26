-- Session 20C (May 14 2026) — QBO P&L truth table
--
-- Authoritative bookkeeper data pulled from QBO's ProfitAndLoss report API.
-- The bookkeeper was active Feb 2025 - Feb 2026. QBO P&L is cash basis.
--
-- Each row represents ONE line on the QBO P&L for ONE month.
-- Used by Phase 20D to post reconstruction JEs into the GL.
--
-- After 20D, GL revenue/expense should match this table to the cent for the
-- bookkeeper era (Feb 2025 - Jan 2026).

CREATE TABLE IF NOT EXISTS qbo_pnl_truth (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,           -- 'YYYY-MM'
  section TEXT NOT NULL,          -- Income / COGS / Expenses / Other Income / Other Expenses
  account_path TEXT NOT NULL,     -- 'Sales > Food Income > Dine-In / Takeout'
  account_name TEXT NOT NULL,     -- leaf name: 'Dine-In / Takeout'
  amount REAL NOT NULL,           -- the bookkeeper's value for the month
  is_subtotal INTEGER DEFAULT 0,  -- 1 if this is a section/subtotal row (don't post)
  qbo_basis TEXT,                 -- 'Cash' or 'Accrual' (from report header)
  pulled_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qbo_pnl_truth_period ON qbo_pnl_truth(period);
CREATE INDEX IF NOT EXISTS idx_qbo_pnl_truth_section ON qbo_pnl_truth(period, section);
