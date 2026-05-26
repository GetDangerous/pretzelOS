-- 040_retail_v2.sql
-- Retail Tab V2: Verdict cache + Suggestions engine + tab-scoped alerts + NPD auto-hide.
-- See plan: /Users/drew/.claude/plans/iterative-frolicking-hollerith.md

-- ── Suggestions engine table ──────────────────────────────────────────
-- Populated hourly by retail-suggestions-worker. Operator marks done/snooze
-- via dashboard buttons. Closed-loop: done_outcome_pct measured at 30d
-- followup feeds future track-record multiplier on the same suggestion_id.
CREATE TABLE IF NOT EXISTS retail_suggestions (
  id                  TEXT PRIMARY KEY,
  generated_at        TEXT NOT NULL,
  suggestion_id       TEXT NOT NULL,        -- 'email_capture', 'loyalty_signups', 'fix_email_tracking', etc.
  rank                INTEGER,
  title               TEXT,
  math                TEXT,                 -- one-sentence calculation explainer
  how_to              TEXT,                 -- specific instruction
  annual_lift_low     REAL,
  annual_lift_high    REAL,
  effort              TEXT,                 -- low / medium / high / urgent
  state               TEXT DEFAULT 'open',  -- open / done / snoozed / dismissed / superseded
  done_at             TEXT,
  done_outcome_pct    REAL,                 -- (actual_lift / projected_lift) measured 30d post-done
  followup_due_at     TEXT,                 -- when to measure outcome
  current_value       TEXT,                 -- "16% identified" rendered as-is
  goal_value          TEXT,                 -- "50% (industry std)"
  metric_signal       TEXT                  -- JSON snapshot of inputs (for audit)
);
CREATE INDEX IF NOT EXISTS idx_retail_sugg_state ON retail_suggestions (state, generated_at);
CREATE INDEX IF NOT EXISTS idx_retail_sugg_followup ON retail_suggestions (followup_due_at);

-- ── Snooze list ───────────────────────────────────────────────────────
-- Snoozed suggestion IDs don't reappear in /retail/suggestions until snooze_until passes.
CREATE TABLE IF NOT EXISTS snoozed_suggestions (
  suggestion_id   TEXT PRIMARY KEY,
  snoozed_at      TEXT NOT NULL,
  snooze_until    TEXT NOT NULL
);

-- ── Verdict cache ─────────────────────────────────────────────────────
-- One row per period. Daily Sonnet pass writes; refresh button forces.
CREATE TABLE IF NOT EXISTS verdict_cache (
  period          TEXT PRIMARY KEY,         -- 'last_7_days' / 'last_30_days' / etc.
  state           TEXT,                     -- green / yellow / orange / red
  headline        TEXT,                     -- 3-5 word phrase
  body            TEXT,                     -- 2-3 sentence paragraph
  confidence      TEXT,                     -- high / medium / low
  basis           TEXT,                     -- data window phrase
  generated_at    TEXT,
  expires_at      TEXT,
  signals_used    TEXT                      -- JSON snapshot of inputs (for audit)
);

-- ── Tab scope on alerts ───────────────────────────────────────────────
-- Filters cross-tab pollution. CFO/finance.* alerts now scope to 'money',
-- email/campaign alerts to 'retail', etc. Renderer respects scope.
ALTER TABLE system_alerts ADD COLUMN tab_scope TEXT DEFAULT 'all';

-- ── NPD auto-hide via event_end_date ──────────────────────────────────
ALTER TABLE retail_campaigns ADD COLUMN event_end_date TEXT;
UPDATE retail_campaigns SET event_end_date = '2026-04-26'
  WHERE name LIKE '%National Pretzel Day%';
