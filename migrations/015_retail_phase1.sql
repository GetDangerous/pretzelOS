-- ============================================================
-- Migration 015: Retail Agent Phase 1 — Data Foundation
-- Deploy: wrangler d1 execute pretzel-os --file=migrations/015_retail_phase1.sql
-- ============================================================

-- ── ALTER retail_customers — enrich existing profiles ────────
ALTER TABLE retail_customers ADD COLUMN normalized_phone TEXT;
ALTER TABLE retail_customers ADD COLUMN churn_risk_score INTEGER DEFAULT 0;
ALTER TABLE retail_customers ADD COLUMN predicted_clv REAL DEFAULT 0;
ALTER TABLE retail_customers ADD COLUMN order_frequency_days REAL;
ALTER TABLE retail_customers ADD COLUMN last_order_skus TEXT;
ALTER TABLE retail_customers ADD COLUMN sku_diversity_score INTEGER DEFAULT 0;
ALTER TABLE retail_customers ADD COLUMN day_of_week_pattern TEXT;
ALTER TABLE retail_customers ADD COLUMN visits_by_quarter TEXT;
ALTER TABLE retail_customers ADD COLUMN peak_send_hour INTEGER;
ALTER TABLE retail_customers ADD COLUMN active_campaign_id TEXT;
ALTER TABLE retail_customers ADD COLUMN onboarding_complete INTEGER DEFAULT 0;
ALTER TABLE retail_customers ADD COLUMN acquisition_source TEXT DEFAULT 'organic';
ALTER TABLE retail_customers ADD COLUMN sms_eligible INTEGER DEFAULT 0;
ALTER TABLE retail_customers ADD COLUMN sms_opted_out_at TEXT;
ALTER TABLE retail_customers ADD COLUMN external_toast_order_id TEXT;

CREATE INDEX IF NOT EXISTS idx_retail_customers_normalized_phone ON retail_customers(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_retail_customers_segment ON retail_customers(segment);
CREATE INDEX IF NOT EXISTS idx_retail_customers_churn ON retail_customers(churn_risk_score);
CREATE INDEX IF NOT EXISTS idx_retail_customers_sms_eligible ON retail_customers(sms_eligible);

-- Backfill normalized_phone for existing records
UPDATE retail_customers
SET normalized_phone = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+1', ''), '-', ''), '(', ''), ')', ''), ' ', '')
WHERE phone IS NOT NULL AND normalized_phone IS NULL;

-- Backfill sms_eligible for existing records with consent
UPDATE retail_customers
SET sms_eligible = 1
WHERE phone IS NOT NULL AND sms_consent = 1 AND sms_eligible = 0;

-- ── NEW: retail_campaigns ────────────────────────────────────
CREATE TABLE IF NOT EXISTS retail_campaigns (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  campaign_type     TEXT NOT NULL,
  status            TEXT DEFAULT 'draft',
  target_segment    TEXT,
  target_criteria   TEXT,
  estimated_reach   INTEGER DEFAULT 0,
  message_template  TEXT,
  message_variants  TEXT,
  send_strategy     TEXT DEFAULT 'immediate',
  drip_schedule     TEXT,
  daily_send_limit  INTEGER DEFAULT 10,
  total_budget_sms  INTEGER,
  total_sent        INTEGER DEFAULT 0,
  total_returned    INTEGER DEFAULT 0,
  total_revenue_attributed REAL DEFAULT 0,
  roi_estimate      REAL,
  approval_status   TEXT DEFAULT 'pending',
  drew_note         TEXT,
  agent_reasoning   TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  completed_at      TEXT
);

-- ── NEW: retail_campaign_sends ───────────────────────────────
CREATE TABLE IF NOT EXISTS retail_campaign_sends (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL,
  customer_id       TEXT NOT NULL,
  variant_id        TEXT,
  message_text      TEXT NOT NULL,
  sent_at           TEXT,
  delivered_at      TEXT,
  returned_at       TEXT,
  return_order_value REAL,
  days_to_return    INTEGER,
  outcome           TEXT DEFAULT 'pending',
  created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaign_sends_campaign ON retail_campaign_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_customer ON retail_campaign_sends(customer_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sends_outcome ON retail_campaign_sends(outcome);

-- ── NEW: retail_goals ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retail_goals (
  id              TEXT PRIMARY KEY,
  goal_type       TEXT NOT NULL,
  target_value    REAL NOT NULL,
  current_value   REAL DEFAULT 0,
  period_start    TEXT NOT NULL,
  period_end      TEXT NOT NULL,
  status          TEXT DEFAULT 'active',
  set_by          TEXT DEFAULT 'agent',
  reasoning       TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ── NEW: retail_menu_analytics ───────────────────────────────
CREATE TABLE IF NOT EXISTS retail_menu_analytics (
  id               TEXT PRIMARY KEY,
  week_start       TEXT NOT NULL,
  sku              TEXT NOT NULL,
  units_sold       INTEGER DEFAULT 0,
  revenue          REAL DEFAULT 0,
  unique_buyers    INTEGER DEFAULT 0,
  new_buyer_pct    REAL DEFAULT 0,
  repeat_buyer_pct REAL DEFAULT 0,
  units_trend_pct  REAL DEFAULT 0,
  most_paired_sku  TEXT,
  pair_frequency   REAL DEFAULT 0,
  peak_hour        INTEGER,
  peak_day_of_week INTEGER,
  morning_pct      REAL,
  weekend_pct      REAL,
  created_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_menu_analytics_week ON retail_menu_analytics(week_start);
CREATE INDEX IF NOT EXISTS idx_menu_analytics_sku ON retail_menu_analytics(sku);

-- ── NEW: sms_suppressions ────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_suppressions (
  phone         TEXT PRIMARY KEY,
  opted_out_at  TEXT NOT NULL,
  source        TEXT
);

-- ── NEW: retail_campaign_rules ───────────────────────────────
CREATE TABLE IF NOT EXISTS retail_campaign_rules (
  campaign_type       TEXT PRIMARY KEY,
  auto_approve        INTEGER DEFAULT 0,
  min_runs_required   INTEGER DEFAULT 10,
  min_return_rate     REAL DEFAULT 0.20,
  max_opt_out_rate    REAL DEFAULT 0.02,
  runs_completed      INTEGER DEFAULT 0,
  proven_at           TEXT
);

INSERT OR IGNORE INTO retail_campaign_rules VALUES
  ('onboarding', 1, 0, 0, 0.02, 0, datetime('now'));
INSERT OR IGNORE INTO retail_campaign_rules VALUES
  ('vip_thank_you', 1, 0, 0, 0.02, 0, datetime('now'));
INSERT OR IGNORE INTO retail_campaign_rules VALUES
  ('winback', 0, 10, 0.20, 0.02, 0, NULL);
INSERT OR IGNORE INTO retail_campaign_rules VALUES
  ('upsell', 0, 10, 0.15, 0.02, 0, NULL);
INSERT OR IGNORE INTO retail_campaign_rules VALUES
  ('seasonal', 0, 5, 0.20, 0.02, 0, NULL);
INSERT OR IGNORE INTO retail_campaign_rules VALUES
  ('venue_crossover', 0, 3, 0.15, 0.02, 0, NULL);

-- ── Add retail columns to performance_metrics if missing ─────
-- (these may already exist from original schema)
-- ALTER TABLE performance_metrics ADD COLUMN retail_reengagements_sent INTEGER DEFAULT 0;
-- ALTER TABLE performance_metrics ADD COLUMN retail_crossovers_found INTEGER DEFAULT 0;
