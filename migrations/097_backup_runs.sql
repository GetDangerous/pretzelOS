-- Migration 097: backup_runs status table
-- Foundation Safety Workstream 1, Task 3b
-- Purpose: track D1 → R2 backup execution history. One row per run (cron or manual).
-- Surfaced via GET /finance/backup/status for visibility on whether the backup actually fired.

CREATE TABLE IF NOT EXISTS backup_runs (
  id              TEXT PRIMARY KEY,
  run_date        TEXT NOT NULL,                  -- YYYY-MM-DD of the backup run
  r2_key          TEXT NOT NULL,                  -- e.g., d1-backups/daily/pretzel-os-2026-05-27.sql
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'success', 'failed')),
  size_bytes      INTEGER,                        -- size of the SQL dump in R2
  duration_ms     INTEGER,                        -- total runtime including export + upload
  error_message   TEXT,                           -- populated when status = 'failed'
  started_at      TEXT NOT NULL,
  completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_status ON backup_runs(status, run_date DESC);
