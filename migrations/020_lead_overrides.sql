-- Phase D: per-step overrides for both funnels.
-- Lets Drew edit subject/body OR skip OR reschedule any future step in the cadence.
-- Agent code reads this table before drafting; if an override exists for (lead_id, step_n)
-- and skip=1 → no-op; if custom_body present → use verbatim (bypass LLM draft);
-- if custom_send_at is in the future → skip this cron, try next window.

CREATE TABLE IF NOT EXISTS lead_overrides (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  funnel TEXT NOT NULL CHECK(funnel IN ('wholesale','catering')),
  step_n INTEGER NOT NULL,
  custom_subject TEXT,
  custom_body TEXT,
  custom_send_at TEXT,
  skip INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, funnel, step_n)
);

CREATE INDEX IF NOT EXISTS idx_lead_overrides_lookup
  ON lead_overrides (lead_id, funnel, step_n);
