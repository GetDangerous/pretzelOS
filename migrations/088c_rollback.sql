-- migrations/088c_rollback.sql
-- ROLLBACK migration 088c per binding rule #2.
--
-- 088c reversed 52 payroll qbo_je_ingest JEs and posted 50 toast_payroll_reconstruction
-- JEs. The new JEs CR Mercury Checking for Direct Deposit amounts, but Mercury sync
-- ALREADY CR's Mercury Checking for the same Toast Payroll outflow events (via
-- mercury_txn source_type). Double-counting drove Mercury Checking GL to -$86,870
-- (real balance ~$48K-$73K) — a -$135K divergence.
--
-- Per binding rule #2: "If a criterion fails after migration, ROLL BACK migration
-- (not move tolerance). Fix root cause. Re-run."
--
-- ROOT CAUSE: workers/finance-toast-payroll-reconstruction.js maps 'Direct Deposit'
-- to 'Mercury Checking (0118) - 1' (CR side). Should map to a Payroll Clearing
-- account that nets against Mercury sync's CR Mercury for the same outflows.
-- Worker requires architectural rework before re-applying.

-- Step 1: Unlock closed_periods
UPDATE closed_periods
   SET unlocked_at=datetime('now'),
       unlock_reason='Phase 30 narrowed scope: rollback 088c',
       unlocked_by='phase_30_c_rollback'
 WHERE unlocked_at IS NULL;

-- Step 2: Reverse the 50 toast_payroll_reconstruction JEs that were posted
UPDATE journal_entries
   SET status='reversed',
       notes=COALESCE(notes,'') || ' | Phase 30 088c ROLLED BACK: double-counted Mercury Checking with mercury_txn'
 WHERE source_type='toast_payroll_reconstruction'
   AND status='posted';

-- Step 3: Un-reverse the 52 payroll qbo_je_ingest JEs (identified by description prefix)
UPDATE journal_entries
   SET status='posted',
       notes=COALESCE(notes,'') || ' | Phase 30 088c ROLLBACK: restored to posted'
 WHERE source_type='qbo_je_ingest'
   AND status='reversed'
   AND entry_date >= '2025-01-01'
   AND entry_date <= '2025-12-31'
   AND (
     description LIKE 'QBO JE PPE%'
     OR description LIKE 'QBO JE Payroll%'
     OR description LIKE 'QBO JE PR%'
   );

-- Step 4: Re-lock closed_periods
UPDATE closed_periods
   SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
 WHERE unlock_reason='Phase 30 narrowed scope: rollback 088c';
