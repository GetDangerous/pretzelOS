-- Migration 100: audit_trail schema + append-only triggers
-- STATUS: DRAFT — NOT APPLIED. Awaiting Drew approval per Phase A Week 1 Day 2 EOD.
-- Date drafted: 2026-05-27
-- Authorization: Phase A Week 1 Task B1 (schema design phase only)
--
-- See docs/AUDIT_TRAIL_DESIGN.md for full design rationale.
--
-- This file is intentionally named with `_DRAFT.sql` suffix so it cannot be
-- accidentally applied via `wrangler d1 execute --file=`. Once Drew approves,
-- rename to `100_audit_trail.sql` and apply.
--
-- Schema choices:
--   - id TEXT PRIMARY KEY (UUID; matches existing pattern in journal_entries, finance_audit_log)
--   - occurred_at TEXT NOT NULL (ISO timestamp, default datetime('now'))
--   - actor TEXT NOT NULL ('drew' | 'system:<source>' | 'agent:<name>')
--   - action_type TEXT NOT NULL (categorize_transaction, override_categorization,
--     post_je, reverse_je, close_period, reopen_period, approve_capex,
--     ai_decision_applied, ai_decision_overridden, manual_reclass, etc.)
--   - entity_type TEXT NOT NULL (journal_entry | mercury_txn | accounting_period |
--     vendor | chart_of_account | mercury_io_charge | chase_ink_charge)
--   - entity_id TEXT NOT NULL
--   - before_state TEXT (JSON; nullable for create actions)
--   - after_state TEXT (JSON; nullable for delete actions)
--   - reason_note TEXT (free-form text from actor or system explanation)
--   - source_metadata TEXT (JSON: LLM confidence, rule_matched, parent_je_id, etc.)
--   - commit_hash TEXT (deployed worker version when entry written; from env var or stored value)
--   - related_je_id TEXT (soft FK to journal_entries.id; for fast JE-centric query)
--   - related_audit_id TEXT (soft FK to audit_trail.id; for chained actions like reopen→edit→reclose)
--   - immutable INTEGER NOT NULL DEFAULT 1 (informational flag; triggers enforce true immutability)
--
-- Append-only enforcement:
--   Two triggers prevent UPDATE and DELETE on audit_trail rows.
--   To recover from a tampering attempt or migration need, the triggers can be
--   dropped + recreated in a single migration (auditable).
--
-- Indexes:
--   - by occurred_at DESC (Surface 7 timeline view)
--   - by entity_type + entity_id (drill into "what happened to this txn / JE")
--   - by actor + occurred_at (filter by who did what)
--   - by action_type + occurred_at (filter by what kind of action)
--   - by related_je_id (fast JE → audit chain lookup)
--
-- Retention: NONE. Forever-grow per prompt. D1 handles millions of rows; even at
-- 100 actions/day this is ~36K rows/year. Revisit if growth exceeds 1M rows.
--
-- Filing-impact check:
--   New table; no GL changes; no FY2025 impact. Safe to apply.

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 1: Create audit_trail table
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_trail (
  id              TEXT PRIMARY KEY,                                    -- UUID
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor           TEXT NOT NULL,                                       -- 'drew' | 'system:<source>' | 'agent:<name>'
  action_type     TEXT NOT NULL,                                       -- post_je | reverse_je | categorize | override | close_period | etc.
  entity_type     TEXT NOT NULL,                                       -- journal_entry | mercury_txn | accounting_period | chart_of_account | etc.
  entity_id       TEXT NOT NULL,                                       -- FK-soft to the entity table
  before_state    TEXT,                                                -- JSON snapshot pre-action (null for create)
  after_state     TEXT,                                                -- JSON snapshot post-action (null for delete)
  reason_note     TEXT,                                                -- free-form
  source_metadata TEXT,                                                -- JSON: LLM confidence, rule, parent_id, etc.
  commit_hash     TEXT,                                                -- worker version at write time
  related_je_id   TEXT,                                                -- soft FK to journal_entries.id
  related_audit_id TEXT,                                               -- soft FK to audit_trail.id (chains)
  immutable       INTEGER NOT NULL DEFAULT 1
);

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 2: Create indexes for Surface 7 query patterns
-- ──────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_audit_trail_occurred_at      ON audit_trail(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_entity           ON audit_trail(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_actor            ON audit_trail(actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_action_type      ON audit_trail(action_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_related_je       ON audit_trail(related_je_id);

-- ──────────────────────────────────────────────────────────────────────────
-- STEP 3: Append-only enforcement via triggers
-- ──────────────────────────────────────────────────────────────────────────

CREATE TRIGGER IF NOT EXISTS audit_trail_no_update
BEFORE UPDATE ON audit_trail
BEGIN
  SELECT RAISE(FAIL, 'audit_trail is append-only; UPDATE blocked');
END;

CREATE TRIGGER IF NOT EXISTS audit_trail_no_delete
BEFORE DELETE ON audit_trail
BEGIN
  SELECT RAISE(FAIL, 'audit_trail is append-only; DELETE blocked');
END;

-- ──────────────────────────────────────────────────────────────────────────
-- VERIFY (post-migration smoke test):
--   INSERT INTO audit_trail (id, actor, action_type, entity_type, entity_id, after_state)
--     VALUES ('test-smoke', 'system:migration_test', 'smoke_test', 'audit_trail', 'self', '{"hello":"world"}');
--   UPDATE audit_trail SET actor='evil' WHERE id='test-smoke';
--     → should FAIL with 'audit_trail is append-only; UPDATE blocked'
--   DELETE FROM audit_trail WHERE id='test-smoke';
--     → should FAIL with 'audit_trail is append-only; DELETE blocked'
--   (Manually clean smoke-test row after verification; for now it remains as audit history.)
