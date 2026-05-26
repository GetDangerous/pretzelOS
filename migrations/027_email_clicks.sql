-- Migration 027: email_clicks — V3 Bug 1.5 (click tracking only, per Drew's call)
-- Opens were already instrumented via /outreach/pixel/:logId but the dashboard
-- showed 0% open-rate across 42 sends, signaling the pixel path was either
-- stripped by Gmail's image proxy or mis-logged. Click tracking is stronger:
-- we rewrite each https:// link in outgoing bodies to a redirect on this worker,
-- then log the hit here and 302 to the real destination.

CREATE TABLE IF NOT EXISTS email_clicks (
  id          TEXT PRIMARY KEY,
  log_id      TEXT NOT NULL,                  -- outreach_logs.id reference
  clicked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  url         TEXT NOT NULL,                  -- destination URL (decoded)
  user_agent  TEXT,                           -- raw UA for debugging
  ip          TEXT                            -- CF-Connecting-IP
);

CREATE INDEX IF NOT EXISTS idx_email_clicks_log_id ON email_clicks (log_id);
CREATE INDEX IF NOT EXISTS idx_email_clicks_clicked_at ON email_clicks (clicked_at);
