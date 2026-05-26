-- Migration 032 — Finance v2 Wave 2: payroll + employees + shifts.
-- Per PRETZEL_OS_FINANCE_V2.md section 2.6.

CREATE TABLE IF NOT EXISTS employees (
  id                   TEXT PRIMARY KEY,
  square_employee_id   TEXT UNIQUE,
  first_name           TEXT NOT NULL,
  last_name            TEXT NOT NULL,
  email                TEXT,
  phone                TEXT,
  role_classification  TEXT NOT NULL,       -- BOH | FOH | management | shift_lead
  hire_date            TEXT,
  termination_date     TEXT,
  pay_rate             REAL,
  pay_type             TEXT,                -- hourly | salary
  is_active            INTEGER DEFAULT 1,
  notes                TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emp_active ON employees (is_active);
CREATE INDEX IF NOT EXISTS idx_emp_role   ON employees (role_classification);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                    TEXT PRIMARY KEY,
  square_payroll_id     TEXT UNIQUE,
  pay_period_start      TEXT NOT NULL,
  pay_period_end        TEXT NOT NULL,
  pay_date              TEXT NOT NULL,
  total_gross           REAL NOT NULL,
  total_taxes           REAL NOT NULL,
  total_net             REAL NOT NULL,
  total_employer_taxes  REAL NOT NULL,
  status                TEXT DEFAULT 'pending',  -- pending | processed | paid
  journal_entry_id      TEXT REFERENCES journal_entries(id),
  created_at            TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payroll_date ON payroll_runs (pay_date);
CREATE INDEX IF NOT EXISTS idx_payroll_status ON payroll_runs (status);

CREATE TABLE IF NOT EXISTS payroll_run_lines (
  id                TEXT PRIMARY KEY,
  payroll_run_id    TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id       TEXT NOT NULL REFERENCES employees(id),
  hours_worked      REAL,
  gross_pay         REAL NOT NULL,
  net_pay           REAL NOT NULL,
  federal_tax       REAL DEFAULT 0,
  state_tax         REAL DEFAULT 0,
  fica_tax          REAL DEFAULT 0,
  medicare_tax      REAL DEFAULT 0,
  tips_reported     REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prl_run      ON payroll_run_lines (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_prl_employee ON payroll_run_lines (employee_id);

CREATE TABLE IF NOT EXISTS shifts (
  id               TEXT PRIMARY KEY,
  employee_id      TEXT NOT NULL REFERENCES employees(id),
  shift_date       TEXT NOT NULL,
  clock_in         TEXT,
  clock_out        TEXT,
  hours            REAL,
  square_shift_id  TEXT UNIQUE,
  role_at_shift    TEXT
);
CREATE INDEX IF NOT EXISTS idx_shift_employee_date ON shifts (employee_id, shift_date);
