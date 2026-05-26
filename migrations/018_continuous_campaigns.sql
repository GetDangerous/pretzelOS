-- Migration 018: Continuous/Evergreen Campaign Support
-- Adds campaign_mode, trigger system, variant A/B testing, frequency capping, health monitoring

-- ── Campaign table extensions ──────────────────────────────────────
ALTER TABLE retail_campaigns ADD COLUMN campaign_mode TEXT DEFAULT 'batch';
-- 'batch' (current behavior) | 'continuous' (evergreen, never auto-completes)

ALTER TABLE retail_campaigns ADD COLUMN trigger_type TEXT;
-- 'event' (webhook-driven) | 'condition' (daily scan) | NULL (legacy/manual batch)

ALTER TABLE retail_campaigns ADD COLUMN trigger_config TEXT;
-- JSON: event → {event, delay_seconds, conditions: {...}}
-- JSON: condition → {conditions: {...}, re_enrollment_days: 90}

ALTER TABLE retail_campaigns ADD COLUMN optimal_delay_seconds INTEGER;
-- Learned optimal delay for event-triggered campaigns

ALTER TABLE retail_campaigns ADD COLUMN paused_at TEXT;
-- When manually or auto-paused (sends stop but status stays 'active')

ALTER TABLE retail_campaigns ADD COLUMN pause_reason TEXT;
-- 'manual' | 'auto_optout_spike' | 'auto_conversion_drop'

ALTER TABLE retail_campaigns ADD COLUMN health_status TEXT DEFAULT 'healthy';
-- 'healthy' | 'warning' | 'critical' | 'auto_paused'

ALTER TABLE retail_campaigns ADD COLUMN lifetime_enrolled INTEGER DEFAULT 0;

-- Rolling metrics (updated daily by health monitor)
ALTER TABLE retail_campaigns ADD COLUMN rolling_7d_sent INTEGER DEFAULT 0;
ALTER TABLE retail_campaigns ADD COLUMN rolling_7d_returned INTEGER DEFAULT 0;
ALTER TABLE retail_campaigns ADD COLUMN rolling_7d_optouts INTEGER DEFAULT 0;
ALTER TABLE retail_campaigns ADD COLUMN rolling_30d_sent INTEGER DEFAULT 0;
ALTER TABLE retail_campaigns ADD COLUMN rolling_30d_returned INTEGER DEFAULT 0;
ALTER TABLE retail_campaigns ADD COLUMN rolling_30d_revenue REAL DEFAULT 0;
ALTER TABLE retail_campaigns ADD COLUMN last_health_check TEXT;
ALTER TABLE retail_campaigns ADD COLUMN last_enrollment_scan TEXT;

-- ── Campaign variants (A/B testing) ───────────────────────────────
CREATE TABLE IF NOT EXISTS retail_campaign_variants (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL,
  variant_label   TEXT NOT NULL,
  message_template TEXT NOT NULL,
  weight          REAL DEFAULT 0.5,
  delay_seconds   INTEGER,
  discount_amount INTEGER,
  total_sent      INTEGER DEFAULT 0,
  total_returned  INTEGER DEFAULT 0,
  total_optouts   INTEGER DEFAULT 0,
  total_revenue   REAL DEFAULT 0,
  avg_days_to_return REAL,
  active          INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_variants_campaign ON retail_campaign_variants(campaign_id);

-- ── Cross-campaign frequency capping ──────────────────────────────
CREATE TABLE IF NOT EXISTS retail_frequency_cap (
  customer_id     TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  campaign_type   TEXT
);
CREATE INDEX IF NOT EXISTS idx_freqcap_customer_date ON retail_frequency_cap(customer_id, sent_at);

-- ── Health audit log ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retail_campaign_health_log (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  old_status      TEXT,
  new_status      TEXT,
  metrics_snapshot TEXT,
  reason          TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_health_log_campaign ON retail_campaign_health_log(campaign_id);

-- ── Send table extensions for trigger tracking ────────────────────
ALTER TABLE retail_campaign_sends ADD COLUMN delay_seconds_actual INTEGER;
ALTER TABLE retail_campaign_sends ADD COLUMN trigger_event_id TEXT;
ALTER TABLE retail_campaign_sends ADD COLUMN enrolled_at TEXT;
