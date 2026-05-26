-- migrations/050_system_health.sql
-- Heartbeat tracking for every cron, sync, and critical scheduled task.
-- Drives the trust score on /cfo page + the daily "what's degraded today" email.
--
-- Every cron that runs MUST call heartbeat(env, component_name) on success.
-- Tier 2 checks heartbeats daily; surfaces stale or failing components.

CREATE TABLE IF NOT EXISTS system_heartbeats (
  component                TEXT PRIMARY KEY,        -- 'mercury_sync' | 'chase_sync_plaid' | 'square_sync' | 'qbo_sync' | 'daily_close' | 'tier1_audit' | 'tier2_audit' | 'tier5_acceptance' | 'cfo_daily_pulse' | etc.
  last_success_at          TEXT,                    -- UTC timestamp of last successful run
  last_attempt_at          TEXT,                    -- whether or not it succeeded
  last_duration_ms         INTEGER,
  expected_max_lag_minutes INTEGER NOT NULL,        -- alerting threshold (e.g., 60 for hourly cron, 1440 for daily)
  consecutive_failures     INTEGER NOT NULL DEFAULT 0,
  last_error               TEXT,
  status                   TEXT NOT NULL DEFAULT 'unknown',  -- 'green' | 'yellow' | 'red' | 'unknown'
  notes                    TEXT,                    -- one-line description of what the component does
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_status ON system_heartbeats(status) WHERE status != 'green';

-- Seed the known components so /finance/trust-score knows what to expect even
-- before each first run.
INSERT OR IGNORE INTO system_heartbeats (component, expected_max_lag_minutes, notes) VALUES
  ('mercury_sync',         70,    'Mercury txn sync — runs hourly'),
  ('chase_sync_plaid',     360,   'Chase CC via Plaid — runs every 4h'),
  ('square_sync',          70,    'Square orders + customers webhook + reconciliation'),
  ('square_labor_sync',    1440,  'Square Labor / shifts — runs daily'),
  ('qbo_sync',             1440,  'QBO invoice + estimate sync — runs daily'),
  ('daily_close',          1440,  'CFO daily close orchestrator'),
  ('cfo_daily_pulse',      1440,  'Daily morning pulse email'),
  ('cfo_daily_recon',      1440,  'Daily Mercury-vs-books reconciliation'),
  ('cfo_weekly_directive', 10080, 'Sunday weekly strategic directive'),
  ('cfo_monthly_close',    44640, '1st-of-month monthly close'),
  ('tier1_audit',          70,    'Tier 1 hourly ledger invariants'),
  ('tier2_audit',          1440,  'Tier 2 daily state/drift checks'),
  ('tier5_acceptance',     10080, 'Tier 5 weekly acceptance replay against QBO');

-- Trust score components — recorded hourly so we can show a trendline.
CREATE TABLE IF NOT EXISTS trust_score_snapshots (
  id                       TEXT PRIMARY KEY,
  snapshot_at              TEXT NOT NULL DEFAULT (datetime('now')),
  overall_score            INTEGER NOT NULL,        -- 0-100
  data_freshness_score     INTEGER NOT NULL,
  ledger_integrity_score   INTEGER NOT NULL,
  categorization_score     INTEGER NOT NULL,
  sync_health_score        INTEGER NOT NULL,
  cost_budget_score        INTEGER NOT NULL,
  decision_quality_score   INTEGER NOT NULL,
  details_json             TEXT                     -- per-component reasoning
);
CREATE INDEX IF NOT EXISTS idx_trust_snapshots_date ON trust_score_snapshots(snapshot_at DESC);
