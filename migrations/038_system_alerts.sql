-- 038 — system_alerts table
--
-- Tier 1b: catch every alert the router would have emailed Drew about, whether
-- or not the Gmail send succeeded. Solves the silent-alert-failure chain: if
-- the Gmail OAuth token expires, the alert email itself would vanish before
-- Drew saw it. Now every call to sendAlertEmail() writes a row here first,
-- and the System tab surfaces unacked alerts at the top of the page.
--
-- Secondary uses:
--   - Weekly digest can include "5 alerts this week, 2 still unacked"
--   - `status_status` differentiates successful-send from email-failed vs
--     fallback-path-used, so Drew knows which channels are working
--   - cron_runs only logs the agent failure; system_alerts captures the
--     *notification* failure, which is a different class of bug

CREATE TABLE IF NOT EXISTS system_alerts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  severity TEXT NOT NULL,             -- 'critical' | 'high' | 'warn' | 'info'
  source TEXT NOT NULL,               -- agent name or subsystem ('cfo', 'qbo_sync', 'retail', ...)
  subject TEXT NOT NULL,              -- human headline, matches email subject
  body TEXT,                          -- full message body
  email_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'failed'
  email_error TEXT,                   -- populated when email_status='failed'
  fallback_status TEXT,               -- 'none' | 'sms_sent' | 'sms_failed' | null
  fallback_error TEXT,                -- populated when fallback attempted and failed
  acked_at TEXT,                      -- datetime Drew dismissed it on the dashboard
  acked_by TEXT                       -- free-form label of who/what acked (always 'drew' for now)
);

CREATE INDEX IF NOT EXISTS idx_system_alerts_unacked
  ON system_alerts (acked_at, created_at DESC)
  WHERE acked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_system_alerts_source_created
  ON system_alerts (source, created_at DESC);
