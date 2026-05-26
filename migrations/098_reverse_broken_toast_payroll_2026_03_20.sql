-- Migration 098: Reverse broken toast-payroll-2026-03-20 JE
-- Date applied: 2026-05-26
-- Trigger: Phase A pre-work investigation found Tier 1 invariants failing for
--          ≥5 hours with read-only mode tripped.
--
-- Root cause:
--   Single broken JE id='toast-payroll-2026-03-20' (entry_date 2026-03-20,
--   created 2026-05-20 17:03:16 during Phase 30 Pattern B Toast Payroll
--   reconstruction). The JE has ONE line — a $5,084.32 CR to
--   'Clearing Accounts:Payroll Clearing' — with NO DR side at all.
--   Header total_debit/total_credit ($4,839.75) doesn't even match the actual
--   line CR ($5,084.32), confirming the write went wrong at creation.
--
--   This single JE accounted for 3 of 4 Tier 1 failures:
--     1. dr_eq_cr_per_je           (1 unbalanced JE)
--     2. dr_eq_cr_ledger           (-$5,084.32 ledger DR-CR gap)
--     3. je_touches_distinct_accounts (1 JE has only 1 account)
--
--   The 4th failure (socf_reconciles_within_tolerance $36,845 > $20K) is a
--   separate issue and is investigated separately post-deploy.
--
-- Filing-impact check:
--   Entry date 2026-03-20 is post-FY2025 cutoff (2025-12-31). FY2025 filing
--   position is UNAFFECTED by this reversal. Verified pre-migration:
--     - FY2025 BS at YE2025 balances cent-accurate ($690,781 = $162,646 + $528,134)
--     - FY2025 NI -$299,576.15 (Path A internal) unchanged
--     - v3 filing CSVs sent to Irene reflect FY2025-only data — unaffected
--
-- Action:
--   Mark JE status='reversed' (preserves audit trail; ledger queries that
--   filter for status='posted' will exclude this row going forward).
--   Tier 1 will return to green on the next hourly run (5 * * * *).
--
-- Followup (NOT in this migration — explicit decision deferred to Drew):
--   The 2026-03-20 Toast Payroll cycle is now MISSING from the GL.
--   If the data needs to be restored, the toast_payroll_reconstruction worker
--   can be re-run for just that check_date. Until then, FY2026 Payroll
--   Clearing balance no longer reflects the (broken) Mar 20 cycle.

UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') ||
            ' [Migration 098: reversed 2026-05-26 — Phase 30 Pattern B write produced a' ||
            ' single-line CR to Payroll Clearing with no DR side. JE was corrupt from creation.' ||
            ' 2026-03-20 cycle data NOT yet restored — re-run toast_payroll_reconstruction' ||
            ' worker for this check_date if needed.]'
WHERE id = 'toast-payroll-2026-03-20'
  AND status = 'posted';

-- Sanity check: the entry_date must be FY2026 to protect filing year. Migration
-- will silently no-op if the JE has already been reversed (status='posted' filter).
