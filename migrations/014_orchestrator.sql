-- Migration 014 — Orchestrator + Agent Tracing
-- Adds tables for pipeline run tracking and agent-to-agent message logging

CREATE TABLE IF NOT EXISTS orchestrator_runs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,          -- 'outreach_pipeline' | 'catering' | 'cfo_cycle' | 'full'
  status      TEXT DEFAULT 'running', -- running | completed | partial | failed
  triggered_by TEXT DEFAULT 'manual', -- 'cron' | 'manual' | 'dashboard'
  steps_total     INTEGER DEFAULT 0,
  steps_completed INTEGER DEFAULT 0,
  steps_failed    INTEGER DEFAULT 0,
  summary     TEXT,                   -- JSON: { venues_found, emails_drafted, ... }
  created_at  TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES orchestrator_runs(id),
  from_agent  TEXT NOT NULL,          -- 'orchestrator' | 'scout' | 'qualifier' | 'outreach' | etc.
  to_agent    TEXT NOT NULL,
  task        TEXT NOT NULL,          -- 'discover_venues' | 'score_venues' | 'draft_email' | etc.
  status      TEXT DEFAULT 'running', -- running | completed | failed
  duration_ms INTEGER,
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_run_id   ON agent_messages(run_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_type  ON orchestrator_runs(type, created_at DESC);
