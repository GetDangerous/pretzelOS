-- migrations/083_create_toast_payroll_gl.sql
-- Phase 29-final: Toast Payroll GL Standard Report (per-pay-period detail).
-- Source-of-truth for payroll line items, employee, and Mercury cash legs.
-- Drew exported from Toast Payroll on 2026-05-19.

CREATE TABLE IF NOT EXISTS toast_payroll_gl (
  id TEXT PRIMARY KEY,
  payroll_run TEXT,
  job TEXT,
  account_name TEXT,
  employee_name TEXT,
  employee_no TEXT,
  debit REAL DEFAULT 0,
  credit REAL DEFAULT 0,
  check_date TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  memo TEXT,
  source TEXT DEFAULT 'toast_payroll_gl_export_2026-05-19',
  loaded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_toast_payroll_gl_check_date ON toast_payroll_gl(check_date);
CREATE INDEX IF NOT EXISTS idx_toast_payroll_gl_account ON toast_payroll_gl(account_name);
