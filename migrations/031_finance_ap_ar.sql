-- Migration 031 — Finance v2 Wave 2: AP (vendors/bills) + AR (customers/invoices/deliveries) + resale certs.
-- Per PRETZEL_OS_FINANCE_V2.md sections 2.4, 2.7, 2.8, 2.9, 1.4.

-- ── Vendors ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendors (
  id                           TEXT PRIMARY KEY,
  name                         TEXT NOT NULL,
  vendor_type                  TEXT,                  -- supplier | utility | software | service | rent | insurance
  default_category_account_id  TEXT REFERENCES chart_of_accounts(id),
  payment_method               TEXT,                  -- ach | card | check | auto_debit
  is_1099_vendor               INTEGER DEFAULT 0,
  ytd_paid                     REAL DEFAULT 0,
  w9_on_file                   INTEGER DEFAULT 0,
  w9_attachment_r2_key         TEXT,
  qbo_vendor_id                TEXT,
  email                        TEXT,
  phone                        TEXT,
  notes                        TEXT,
  created_at                   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_name  ON vendors (name);
CREATE INDEX IF NOT EXISTS idx_vendor_1099  ON vendors (is_1099_vendor);

-- ── Bills (AP) ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bills (
  id                   TEXT PRIMARY KEY,
  vendor_id            TEXT NOT NULL REFERENCES vendors(id),
  bill_number          TEXT,
  bill_date            TEXT NOT NULL,
  due_date             TEXT NOT NULL,
  amount               REAL NOT NULL,
  status               TEXT DEFAULT 'open',   -- open | paid | partially_paid | voided
  amount_paid          REAL DEFAULT 0,
  payment_date         TEXT,
  payment_terms        TEXT,                  -- Net 15 | Net 30 | Due on Receipt
  category_account_id  TEXT REFERENCES chart_of_accounts(id),
  description          TEXT,
  is_recurring         INTEGER DEFAULT 0,
  recurring_template_id TEXT,
  source_type          TEXT,                  -- manual | mercury_inferred | vendor_email | subscription
  attachment_r2_key    TEXT,
  journal_entry_id     TEXT REFERENCES journal_entries(id),
  notes                TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bill_status ON bills (status);
CREATE INDEX IF NOT EXISTS idx_bill_due    ON bills (due_date, status);
CREATE INDEX IF NOT EXISTS idx_bill_vendor ON bills (vendor_id, bill_date);

CREATE TABLE IF NOT EXISTS recurring_bills (
  id                     TEXT PRIMARY KEY,
  vendor_id              TEXT NOT NULL REFERENCES vendors(id),
  description            TEXT NOT NULL,
  expected_amount        REAL NOT NULL,       -- rolling average
  amount_variance_pct    REAL DEFAULT 10,
  cadence                TEXT NOT NULL,       -- monthly | quarterly | annually | biweekly | weekly
  expected_day_of_month  INTEGER,             -- 1-31
  expected_day_of_week   INTEGER,             -- 0-6
  next_expected_date     TEXT,
  category_account_id    TEXT REFERENCES chart_of_accounts(id),
  is_active              INTEGER DEFAULT 1,
  notes                  TEXT,
  created_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_next ON recurring_bills (next_expected_date, is_active);

-- ── Finance customers (wholesale + catering B2B) ────────────────────────────
-- Distinct from retail_customers (POS loyalty). This table drives AR + invoices.
CREATE TABLE IF NOT EXISTS customers (
  id                              TEXT PRIMARY KEY,
  square_customer_id              TEXT UNIQUE,
  qbo_customer_id                 TEXT,
  customer_type                   TEXT NOT NULL,  -- wholesale | catering | retail
  display_name                    TEXT NOT NULL,
  legal_name                      TEXT,
  email                           TEXT,
  phone                           TEXT,
  billing_address_json            TEXT,
  payment_terms                   TEXT DEFAULT 'Net 15',
  is_tax_exempt                   INTEGER DEFAULT 0,
  resale_cert_on_file             INTEGER DEFAULT 0,
  resale_cert_attachment_r2_key   TEXT,
  ap_contact_name                 TEXT,
  ap_contact_email                TEXT,
  ap_contact_phone                TEXT,
  is_active                       INTEGER DEFAULT 1,
  notes                           TEXT,
  created_at                      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_type    ON customers (customer_type);
CREATE INDEX IF NOT EXISTS idx_customers_active  ON customers (is_active);

-- ── Pending deliveries (stage before invoicing) ─────────────────────────────
CREATE TABLE IF NOT EXISTS pending_deliveries (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  delivery_date  TEXT NOT NULL,
  delivered_by   TEXT,
  status         TEXT DEFAULT 'delivered',     -- scheduled | delivered | invoiced | voided
  notes          TEXT,
  invoiced_at    TEXT,
  invoice_id     TEXT,
  total_amount   REAL,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_status    ON pending_deliveries (status);
CREATE INDEX IF NOT EXISTS idx_delivery_customer  ON pending_deliveries (customer_id, delivery_date);

CREATE TABLE IF NOT EXISTS pending_delivery_lines (
  id                    TEXT PRIMARY KEY,
  pending_delivery_id   TEXT NOT NULL REFERENCES pending_deliveries(id),
  sku                   TEXT NOT NULL,
  description           TEXT NOT NULL,
  quantity              INTEGER NOT NULL,
  unit_price            REAL NOT NULL,
  line_total            REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdl_delivery ON pending_delivery_lines (pending_delivery_id);

-- ── Invoices (AR) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id                   TEXT PRIMARY KEY,
  square_invoice_id    TEXT UNIQUE,
  customer_id          TEXT NOT NULL REFERENCES customers(id),
  invoice_number       TEXT NOT NULL,
  invoice_date         TEXT NOT NULL,
  due_date             TEXT NOT NULL,
  amount_total         REAL NOT NULL,
  amount_paid          REAL DEFAULT 0,
  amount_outstanding   REAL,
  status               TEXT DEFAULT 'sent',   -- draft | sent | partially_paid | paid | past_due | voided
  payment_method_used  TEXT,
  paid_at              TEXT,
  pdf_r2_key           TEXT,
  square_public_url    TEXT,
  journal_entry_id     TEXT REFERENCES journal_entries(id),
  created_at           TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inv_customer ON invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_inv_status   ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_inv_due      ON invoices (due_date, status);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                    TEXT PRIMARY KEY,
  invoice_id            TEXT NOT NULL REFERENCES invoices(id),
  pending_delivery_id   TEXT REFERENCES pending_deliveries(id),
  description           TEXT NOT NULL,
  quantity              INTEGER NOT NULL,
  unit_price            REAL NOT NULL,
  line_total            REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invline_invoice ON invoice_lines (invoice_id);

-- ── Resale certificates (per Wave 1.4) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS resale_certs (
  id                    TEXT PRIMARY KEY,
  customer_id           TEXT NOT NULL REFERENCES customers(id),
  jurisdiction          TEXT DEFAULT 'UT',
  cert_number           TEXT,
  received_at           TEXT,
  attachment_r2_key     TEXT,
  expires_at            TEXT,
  requested_at          TEXT DEFAULT (datetime('now')),
  request_email_sent_at TEXT,
  notes                 TEXT,
  UNIQUE(customer_id, jurisdiction)
);
