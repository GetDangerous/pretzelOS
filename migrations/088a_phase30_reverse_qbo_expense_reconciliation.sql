-- migrations/088a_phase30_reverse_qbo_expense_reconciliation.sql
-- Phase 30 narrowed scope step 1: reverse bookkeeper-era expense true-ups.
--
-- qbo_expense_reconciliation (14 JEs, $292K activity Jan 2025-Feb 2026) posted
-- "true-ups to bookkeeper truth" — making GL expense match QBO bookkeeper P&L
-- per-account categorization. Drew's directive: QBO is NOT source of truth.
-- These true-ups have no source-of-truth basis (no LEAF amortization schedule
-- referenced, no specific Mercury txn reclassified).
--
-- EXPECTED IMPACT:
--   FY2025 NI: -$353,119.31 → ~-$408,000 (bigger tax loss, Drew approves)
--   Pre-Pretzel-OS Reconciliation: net change ~$54K (less DR — liability moves
--     toward zero before reversal of reclass_to_equity)
--   Various expense accounts re-shift (Payroll Expenses parent +$73K, Taxes paid
--     +$72K, Marketing -$20K, BOH/FOH Salaries -$13K, etc.)
--
-- After this migration, NO compensating JEs posted. If BS imbalances or Mercury
-- GL diverges from bank statements, the migration is unsuccessful and gets rolled back.
--
-- Audit trail: each JE marked status='reversed' with notes appended.

-- Step 1: Unlock closed_periods so reversal can apply to historical dates
UPDATE closed_periods
   SET unlocked_at=datetime('now'),
       unlock_reason='Phase 30 narrowed scope: reverse qbo_expense_reconciliation noise',
       unlocked_by='phase_30_a'
 WHERE unlocked_at IS NULL;

-- Step 2: Mark all qbo_expense_reconciliation JEs as 'reversed'
UPDATE journal_entries
   SET status='reversed',
       notes=COALESCE(notes,'') || ' | Phase 30 reversed 2026-05-19: bookkeeper-era GL-vs-QBO true-up; no source-of-truth basis'
 WHERE source_type='qbo_expense_reconciliation'
   AND status='posted';

-- Step 3: Re-lock closed_periods
UPDATE closed_periods
   SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
 WHERE unlock_reason LIKE 'Phase 30 narrowed scope%';
