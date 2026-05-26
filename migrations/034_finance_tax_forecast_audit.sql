-- Migration 034 — Finance v2 Wave 2: sales tax, cash forecast, audit log, CFO briefs, Irene packages.
-- Per PRETZEL_OS_FINANCE_V2.md sections 2.5, 2.12, 2.13, 3.4 (briefs), 0.7 (packages).

-- ── Sales tax liability (per-transaction collection) ────────────────────────
CREATE TABLE IF NOT EXISTS sales_tax_liability (
  id              TEXT PRIMARY KEY,
  collection_date TEXT NOT NULL,
  source_type     TEXT NOT NULL,            -- square_order | qbo_invoice | manual
  source_id       TEXT NOT NULL,
  jurisdiction    TEXT DEFAULT 'UT',
  taxable_amount  REAL NOT NULL,
  tax_rate        REAL NOT NULL,
  tax_collected   REAL NOT NULL,
  filing_period   TEXT,                     -- Q1-2026 | Q2-2026 | ...
  filing_status   TEXT DEFAULT 'unfiled',   -- unfiled | filed | paid
  filing_id       TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stl_period  ON sales_tax_liability (filing_period, filing_status);
CREATE INDEX IF NOT EXISTS idx_stl_source  ON sales_tax_liability (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_stl_date    ON sales_tax_liability (collection_date);

-- ── Sales tax filings (quarterly) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_tax_filings (
  id                           TEXT PRIMARY KEY,
  jurisdiction                 TEXT NOT NULL,
  period                       TEXT NOT NULL,  -- Q1-2026 | Q2-2026 | ...
  due_date                     TEXT NOT NULL,
  filed_date                   TEXT,
  filing_confirmation_number   TEXT,
  gross_sales                  REAL,
  exempt_sales                 REAL,
  taxable_sales                REAL,
  tax_collected                REAL,
  tax_owed                     REAL,
  payment_date                 TEXT,
  payment_amount               REAL,
  status                       TEXT DEFAULT 'pending',  -- pending | calculated | filed | paid | amended
  worksheet_pdf_r2_key         TEXT,
  worksheet_json               TEXT,                    -- stored alongside PDF for dashboard render
  notes                        TEXT,
  created_at                   TEXT DEFAULT (datetime('now')),
  updated_at                   TEXT DEFAULT (datetime('now')),
  UNIQUE(jurisdiction, period)
);
CREATE INDEX IF NOT EXISTS idx_stf_due    ON sales_tax_filings (due_date, status);

-- ── Cash flow forecast ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_flow_forecast (
  id                     TEXT PRIMARY KEY,
  forecast_date          TEXT NOT NULL,        -- when this forecast was generated
  target_date            TEXT NOT NULL,        -- the date being forecasted
  inflow_invoices        REAL DEFAULT 0,
  inflow_retail          REAL DEFAULT 0,
  inflow_other           REAL DEFAULT 0,
  outflow_payroll        REAL DEFAULT 0,
  outflow_bills          REAL DEFAULT 0,
  outflow_loan_payments  REAL DEFAULT 0,
  outflow_sales_tax      REAL DEFAULT 0,
  outflow_other          REAL DEFAULT 0,
  net_change             REAL,
  projected_balance      REAL,
  confidence_level       TEXT,                 -- high | medium | low
  notes                  TEXT,
  created_at             TEXT DEFAULT (datetime('now')),
  UNIQUE(forecast_date, target_date)
);
CREATE INDEX IF NOT EXISTS idx_cff_target ON cash_flow_forecast (target_date);

-- ── Finance audit log (every financial action) ─────────────────────────────
CREATE TABLE IF NOT EXISTS finance_audit_log (
  id                   TEXT PRIMARY KEY,
  action_type          TEXT NOT NULL,         -- journal_entry_posted | invoice_sent | bill_paid | reconciliation | depreciation_run | opening_balance_set | sales_tax_filed | capex_flagged | ...
  entity_type          TEXT,
  entity_id            TEXT,
  actor                TEXT NOT NULL,         -- cfo_agent | drew | irene | system
  description          TEXT NOT NULL,
  before_json          TEXT,
  after_json           TEXT,
  reversal_action_id   TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fal_actor     ON finance_audit_log (actor, created_at);
CREATE INDEX IF NOT EXISTS idx_fal_entity    ON finance_audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fal_action    ON finance_audit_log (action_type, created_at);

-- ── CFO briefs (daily / weekly / monthly outputs) ──────────────────────────
CREATE TABLE IF NOT EXISTS cfo_briefs (
  id          TEXT PRIMARY KEY,
  brief_date  TEXT NOT NULL,
  type        TEXT NOT NULL,              -- daily | weekly | monthly
  content     TEXT NOT NULL,              -- JSON blob
  pdf_r2_key  TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(brief_date, type)
);
CREATE INDEX IF NOT EXISTS idx_brief_type ON cfo_briefs (type, brief_date);

-- ── Irene packages (Wave 0 delivery tracking) ──────────────────────────────
CREATE TABLE IF NOT EXISTS irene_packages (
  id                 TEXT PRIMARY KEY,
  tax_year           INTEGER NOT NULL,
  zip_r2_key         TEXT,
  memo_r2_key        TEXT,
  file_count         INTEGER,
  total_bytes        INTEGER,
  shareable_url      TEXT,
  url_expires_at     TEXT,
  delivered_at       TEXT,
  notes              TEXT,
  created_at         TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_irene_year ON irene_packages (tax_year);
