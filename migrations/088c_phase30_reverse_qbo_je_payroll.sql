-- migrations/088c_phase30_reverse_qbo_je_payroll.sql
-- Phase 30 narrowed scope step 3: reverse 52 payroll-tagged qbo_je_ingest JEs
-- (Toast Payroll bookkeeper transcription via xtraCHEF). To be replaced by
-- toast_payroll_reconstruction in the next step (POST /finance/gl/toast-payroll-reconstruct).
--
-- KEPT (12 non-payroll qbo_je_ingest JEs, $35,355.64): legitimate bookkeeper
-- adjustments where Pretzel OS has no replacement source (Toast Lease,
-- SLCBADJ rent accrual, Square fees, GC Mktg, SalesTax Adj, etc.). Drew + Irene
-- can review these later; for now they're preserved as economic events.
--
-- EXPECTED IMPACT: payroll JEs total $218,270.72. Will be replaced by ~$208,701
-- of toast_payroll_reconstruction (source-of-truth from toast_payroll_gl table).
-- Net FY2025 NI delta: ~+$9,570 (expense reduces, NI improves slightly).
-- BS imbalance will be resolved by a supplemental FY2025 close JE (next step).
--
-- Audit trail: each JE marked status='reversed' with notes appended.

-- Step 1: Unlock closed_periods so reversal can apply to historical dates
UPDATE closed_periods
   SET unlocked_at=datetime('now'),
       unlock_reason='Phase 30 narrowed scope: reverse payroll qbo_je_ingest',
       unlocked_by='phase_30_c'
 WHERE unlocked_at IS NULL;

-- Step 2: Mark payroll-tagged qbo_je_ingest JEs as 'reversed'
UPDATE journal_entries
   SET status='reversed',
       notes=COALESCE(notes,'') || ' | Phase 30 reversed 2026-05-19: bookkeeper Toast Payroll transcription; replaced by toast_payroll_reconstruction'
 WHERE source_type='qbo_je_ingest'
   AND status='posted'
   AND (
     description LIKE 'QBO JE PPE%'
     OR description LIKE 'QBO JE Payroll%'
     OR description LIKE 'QBO JE PR%'
   );

-- Step 3: Re-lock closed_periods
UPDATE closed_periods
   SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
 WHERE unlock_reason LIKE 'Phase 30 narrowed scope%';
