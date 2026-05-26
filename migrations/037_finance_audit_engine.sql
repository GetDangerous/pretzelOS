-- migrations/037_finance_audit_engine.sql
-- Finance v2 — Audit engine storage.
--
-- Tracks every audit run (tier 1 hourly invariants, tier 2 daily pipeline
-- health, tier 3 weekly recon, tier 4 monthly deep recon, tier 5 on-demand
-- acceptance) + every individual check result. Enables trending ("we've been
-- green for 14 days") and targeted forensics ("when did this check first fail?").

CREATE TABLE IF NOT EXISTS finance_audit_runs (
  id                 TEXT PRIMARY KEY,
  tier               INTEGER NOT NULL,           -- 1=invariants, 2=pipeline, 3=external, 4=deep, 5=acceptance
  ran_at             TEXT DEFAULT (datetime('now')),
  triggered_by       TEXT,                       -- cron | manual | deploy
  passed             INTEGER NOT NULL DEFAULT 0,
  failed             INTEGER NOT NULL DEFAULT 0,
  warnings           INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER,
  read_only_tripped  INTEGER DEFAULT 0,
  result_json        TEXT NOT NULL               -- full check-by-check detail
);
CREATE INDEX IF NOT EXISTS idx_fin_audit_runs_tier_ran ON finance_audit_runs(tier, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_audit_runs_fails ON finance_audit_runs(failed, ran_at DESC) WHERE failed > 0;

-- Per-check history — lets us trend individual checks over time.
CREATE TABLE IF NOT EXISTS finance_audit_checks (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES finance_audit_runs(id) ON DELETE CASCADE,
  tier            INTEGER NOT NULL,
  check_id        TEXT NOT NULL,                -- stable id like 'dr_eq_cr_per_je'
  description     TEXT,
  status          TEXT NOT NULL,                -- pass | fail | warn
  expected        TEXT,
  actual          TEXT,
  detail          TEXT,
  duration_ms     INTEGER,
  ran_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fin_audit_checks_run ON finance_audit_checks(run_id);
CREATE INDEX IF NOT EXISTS idx_fin_audit_checks_check ON finance_audit_checks(check_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_audit_checks_fail ON finance_audit_checks(status, ran_at DESC) WHERE status = 'fail';

-- Canonical known-good reference values for acceptance replay (tier 5).
-- Seeded by Drew from QBO archive / Mercury / bank statement before running
-- a replay. Replay compares computed numbers to these references.
CREATE TABLE IF NOT EXISTS finance_acceptance_references (
  id              TEXT PRIMARY KEY,
  reference_month TEXT NOT NULL,                -- e.g. '2025-06'
  source          TEXT NOT NULL,                -- qbo | mercury_statement | toast | irene
  metric          TEXT NOT NULL,                -- gross_revenue | total_expenses | net_income | bank_ending_balance | txn_count | ...
  value           REAL NOT NULL,
  note            TEXT,
  added_at        TEXT DEFAULT (datetime('now')),
  UNIQUE(reference_month, source, metric)
);
CREATE INDEX IF NOT EXISTS idx_fin_accept_refs_month ON finance_acceptance_references(reference_month);
