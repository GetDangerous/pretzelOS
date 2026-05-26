-- migrations/053_late_txn_buffer.sql
-- RTR-5 (Session 12, May 13 2026): post-close late-txn handling.
--
-- When a backdated transaction arrives for a closed period (rare but possible
-- — Mercury settles 3 days late, QBO bookkeeper adjusts a December invoice in
-- January, etc.), it goes into THIS buffer instead of being posted directly
-- (which would either silently break the closed period OR be blocked by Tier 1).
--
-- Drew sees pending late txns in the dashboard and picks:
--   - 'reopen'        — unlock the closed period, post the JE, recompute brief, re-lock
--   - 'carry_forward' — change entry_date to current period, post normally
--   - 'reject'        — discard (e.g., duplicate or already handled)

CREATE TABLE IF NOT EXISTS late_txn_buffer (
  id TEXT PRIMARY KEY,
  buffered_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- What was attempted
  source_type TEXT NOT NULL,                  -- 'mercury' | 'qbo' | 'chase_cc' | 'manual_je'
  source_id TEXT,                              -- mercury_txn_id / qbo_id / etc.
  intended_entry_date TEXT NOT NULL,           -- YYYY-MM-DD the txn wanted
  intended_period TEXT NOT NULL,               -- 'YYYY-MM' from intended_entry_date
  amount REAL,
  counterparty TEXT,                            -- for human review

  -- Why it was buffered
  reason TEXT NOT NULL,                         -- 'period_closed' | 'period_locked' | etc.

  -- The JE that would have been posted (full payload for replay)
  proposed_je_json TEXT NOT NULL,

  -- Drew's decision
  status TEXT NOT NULL DEFAULT 'pending',      -- 'pending' | 'applied_reopen' | 'applied_forward' | 'rejected'
  decision TEXT,                                -- 'reopen' | 'carry_forward' | 'reject'
  decision_at TEXT,
  decision_note TEXT,
  result_je_id TEXT,                            -- journal_entries.id once applied
  result_entry_date TEXT                         -- actual date the JE landed on
);

CREATE INDEX IF NOT EXISTS idx_late_txn_status ON late_txn_buffer (status, buffered_at DESC);
CREATE INDEX IF NOT EXISTS idx_late_txn_period ON late_txn_buffer (intended_period, status);
