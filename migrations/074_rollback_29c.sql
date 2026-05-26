-- migrations/074_rollback_29c.sql
-- Session 29-C rollback (May 19, 2026): the blanket reversal of bookkeeper-era
-- reconstruction JEs created phantom clearing balances ($512K Cash Clearing)
-- and broke BS double-entry at recent dates. Rolling back to the post-29B state
-- and taking a simpler approach in next steps:
--   - Keep all existing bookkeeper-era reconstruction (qbo_pnl_reconstruction,
--     qbo_je_ingest, qbo_expense_reconciliation, pre_sync_adjustment, etc.)
--   - Add per-month-end reconciliation adjustment JEs that bring Mercury GL
--     into exact match with actual statement balances
--   - The audit trail shows "this is what bookkeeper recorded + this is the
--     reconciliation adjustment to match actual bank"

-- Step 1: Mark phase_29c_reset reversal JEs as 'reversed' (so they're excluded)
UPDATE journal_entries
   SET status = 'reversed',
       notes = COALESCE(notes,'') || ' | Rolled back 2026-05-19; 29-C approach abandoned'
 WHERE source_type = 'phase_29c_reset'
   AND status = 'posted';

-- Step 2: Re-activate the original bookkeeper-era JEs (un-mark as 'reversed')
UPDATE journal_entries
   SET status = 'posted',
       notes = REPLACE(COALESCE(notes,''), ' | Phase 29-C reversed 2026-05-19', '')
 WHERE source_type IN ('pre_sync_adjustment','qbo_expense_reconciliation','reclass_to_equity','cleanup_reclass')
   AND status = 'reversed'
   AND notes LIKE '%Phase 29-C reversed%';
