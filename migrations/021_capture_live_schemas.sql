-- Capture live schema for tables that were created out-of-band and have no migration file.
-- Produced by dumping sqlite_master from the production D1 on 2026-04-16.
-- Without these, a `wrangler d1 create + migrations apply` on a fresh DB would leave
-- the app broken because workers reference tables that don't exist.

-- ── catering_leads ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catering_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_title TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  company_size TEXT,
  headcount INTEGER,
  industry TEXT,
  address TEXT,
  city TEXT DEFAULT 'Salt Lake City',
  state TEXT DEFAULT 'UT',
  website TEXT,
  linkedin TEXT,
  source TEXT DEFAULT 'apollo',
  source_customer_id TEXT,
  tier INTEGER,
  qual_score INTEGER,
  qual_summary TEXT,
  seasonal_flags TEXT,
  status TEXT DEFAULT 'prospect',
  last_contacted TEXT,
  notes TEXT,
  approval_status TEXT DEFAULT 'auto_sent',
  agent_reasoning TEXT,
  self_score INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_catering_industry ON catering_leads(industry);
CREATE INDEX IF NOT EXISTS idx_catering_source   ON catering_leads(source);
CREATE INDEX IF NOT EXISTS idx_catering_status   ON catering_leads(status);
CREATE INDEX IF NOT EXISTS idx_catering_tier     ON catering_leads(tier);

-- ── inbound_replies ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbound_replies (
  id                        TEXT PRIMARY KEY,
  channel                   TEXT NOT NULL,
  outreach_log_id           TEXT,
  venue_id                  TEXT REFERENCES venues(id),
  lead_id                   TEXT REFERENCES catering_leads(id),
  gmail_message_id          TEXT NOT NULL UNIQUE,
  gmail_thread_id           TEXT NOT NULL,
  from_email                TEXT NOT NULL,
  from_name                 TEXT,
  subject                   TEXT,
  body_text                 TEXT NOT NULL,
  received_at               TEXT NOT NULL,
  classification            TEXT,
  classification_confidence REAL,
  classification_reasoning  TEXT,
  sentiment                 TEXT,
  urgency                   TEXT DEFAULT 'normal',
  suggested_subject         TEXT,
  suggested_reply           TEXT,
  suggested_reply_generated_at TEXT,
  status                    TEXT DEFAULT 'open',
  drew_sent_reply           TEXT,
  handled_at                TEXT,
  snooze_until              TEXT,
  handling_note             TEXT,
  prompt_version            INTEGER,
  sequence_step             INTEGER,
  days_to_reply             INTEGER,
  created_at                TEXT DEFAULT (datetime('now')),
  updated_at                TEXT DEFAULT (datetime('now')),
  auto_send_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_auto_send ON inbound_replies(auto_send_at);
CREATE INDEX IF NOT EXISTS idx_replies_channel   ON inbound_replies(channel);
CREATE INDEX IF NOT EXISTS idx_replies_gmail     ON inbound_replies(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_replies_received  ON inbound_replies(received_at);
CREATE INDEX IF NOT EXISTS idx_replies_status    ON inbound_replies(status);
CREATE INDEX IF NOT EXISTS idx_replies_venue     ON inbound_replies(venue_id);

-- ── retail_customers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retail_customers (
  id TEXT PRIMARY KEY,
  phone TEXT,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  visit_count INTEGER DEFAULT 0,
  total_lifetime_value REAL DEFAULT 0,
  avg_order_value REAL DEFAULT 0,
  avg_items_per_order REAL DEFAULT 0,
  favorite_sku TEXT,
  largest_single_order INTEGER DEFAULT 0,
  first_visit_date TEXT,
  last_visit_date TEXT,
  segment TEXT DEFAULT 'new',
  is_group_buyer INTEGER DEFAULT 0,
  catering_flagged INTEGER DEFAULT 0,
  catering_lead_id TEXT,
  sms_consent INTEGER DEFAULT 0,
  sms_consent_source TEXT,
  reengagement_sent_at TEXT,
  reengagement_outcome TEXT,
  reengagement_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  normalized_phone TEXT,
  churn_risk_score INTEGER DEFAULT 0,
  predicted_clv REAL DEFAULT 0,
  order_frequency_days REAL,
  last_order_skus TEXT,
  sku_diversity_score INTEGER DEFAULT 0,
  day_of_week_pattern TEXT,
  visits_by_quarter TEXT,
  peak_send_hour INTEGER,
  active_campaign_id TEXT,
  onboarding_complete INTEGER DEFAULT 0,
  acquisition_source TEXT DEFAULT 'organic',
  sms_eligible INTEGER DEFAULT 0,
  sms_opted_out_at TEXT,
  external_toast_order_id TEXT,
  momentum_score INTEGER DEFAULT 0,
  behavior_type TEXT,
  churn_probability_7d REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_retail_catering                 ON retail_customers(catering_flagged, catering_lead_id);
CREATE INDEX IF NOT EXISTS idx_retail_customers_behavior       ON retail_customers(behavior_type);
CREATE INDEX IF NOT EXISTS idx_retail_customers_churn          ON retail_customers(churn_risk_score);
CREATE INDEX IF NOT EXISTS idx_retail_customers_momentum       ON retail_customers(momentum_score);
CREATE INDEX IF NOT EXISTS idx_retail_customers_normalized_phone ON retail_customers(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_retail_customers_segment        ON retail_customers(segment);
CREATE INDEX IF NOT EXISTS idx_retail_customers_sms_eligible   ON retail_customers(sms_eligible);
CREATE INDEX IF NOT EXISTS idx_retail_last_visit               ON retail_customers(last_visit_date);
CREATE INDEX IF NOT EXISTS idx_retail_phone                    ON retail_customers(phone);
CREATE INDEX IF NOT EXISTS idx_retail_segment                  ON retail_customers(segment);
