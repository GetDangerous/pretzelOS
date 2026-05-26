-- migrations/049_ai_cost_tracking.sql
-- Track every Anthropic API call: tokens used, cost incurred, outcome.
-- Drives the budget enforcer in workers/ai-budget.js — every call is logged
-- so daily/monthly spend can be tallied and capped.

CREATE TABLE IF NOT EXISTS ai_calls (
  id             TEXT PRIMARY KEY,
  call_at        TEXT NOT NULL DEFAULT (datetime('now')),
  use_case       TEXT NOT NULL,             -- 'daily_brief' | 'chat_turn' | 'categorizer_fallback' | 'capex_reasoner' | 'issue_surfacer' | 'scenario' | 'receipt_extraction' | 'weekly_directive'
  model          TEXT NOT NULL,             -- 'claude-sonnet-4-6' | 'claude-haiku-4-5' | etc.
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  conversation_id TEXT,                      -- groups chat-turn costs
  caller         TEXT,                       -- worker file or function origin
  outcome        TEXT NOT NULL DEFAULT 'success',  -- 'success' | 'error' | 'timeout' | 'budget_blocked' | 'rate_limit'
  error_message  TEXT,
  request_summary TEXT,                      -- first 200 chars of prompt for debugging
  response_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_date ON ai_calls(call_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_case_date ON ai_calls(use_case, call_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_calls_conversation ON ai_calls(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_calls_outcome ON ai_calls(outcome) WHERE outcome != 'success';

-- Daily roll-up for fast budget queries (refreshed on each call).
-- Cheaper than COUNT/SUM over ai_calls every request.
CREATE TABLE IF NOT EXISTS ai_cost_daily (
  date_utc       TEXT PRIMARY KEY,           -- 'YYYY-MM-DD' in UTC
  total_calls    INTEGER NOT NULL DEFAULT 0,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_usd REAL    NOT NULL DEFAULT 0,
  by_use_case    TEXT,                       -- JSON: { use_case: cost_usd }
  by_model       TEXT,                       -- JSON: { model: cost_usd }
  last_updated   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_cost_daily_date ON ai_cost_daily(date_utc DESC);
