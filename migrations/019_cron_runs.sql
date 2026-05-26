-- Track every cron-triggered agent run for visibility
CREATE TABLE IF NOT EXISTS cron_runs (
  id            TEXT PRIMARY KEY,
  agent         TEXT NOT NULL,
  cron          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  started_at    TEXT DEFAULT (datetime('now')),
  completed_at  TEXT,
  duration_ms   INTEGER,
  error         TEXT,
  summary       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_agent ON cron_runs(agent);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC);
