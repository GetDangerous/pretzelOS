-- migrations/088c_rollback_fix.sql
-- The 088c_rollback over-restored: it un-reversed 53 qbo_je_ingest JEs that were
-- reversed BEFORE today (by earlier phases — Phase 29 etc.), in addition to the
-- 52 JEs 088c actually reversed.
--
-- Fix: re-reverse the 53 OVER_RESTORED JEs identified by:
--   - notes contain '088c ROLLBACK' (touched by rollback today)
--   - notes do NOT contain 'bookkeeper Toast Payroll' (NOT reversed by 088c)
-- These should be back to 'reversed' status with their original markers preserved.

-- Step 1: Unlock closed_periods
UPDATE closed_periods
   SET unlocked_at=datetime('now'),
       unlock_reason='Phase 30: 088c rollback fix — re-reverse OVER_RESTORED qbo_je_ingest',
       unlocked_by='phase_30_c_rollback_fix'
 WHERE unlocked_at IS NULL;

-- Step 2: Re-reverse the 53 OVER_RESTORED JEs
UPDATE journal_entries
   SET status='reversed',
       notes=COALESCE(notes,'') || ' | 088c rollback fix 2026-05-19: re-reversed (was reversed by earlier phase before today)'
 WHERE source_type='qbo_je_ingest'
   AND status='posted'
   AND notes LIKE '%088c ROLLBACK%'
   AND notes NOT LIKE '%bookkeeper Toast Payroll%';

-- Step 3: Re-lock closed_periods
UPDATE closed_periods
   SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
 WHERE unlock_reason='Phase 30: 088c rollback fix — re-reverse OVER_RESTORED qbo_je_ingest';
