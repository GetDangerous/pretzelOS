-- migrations/079_phase29c_foundational_reversal.sql
-- Phase 29-C foundational: reverse pure "GL-to-QBO true-up" cleanup JEs that have
-- no source-of-truth basis. Drew's directive: QBO is NOT source of truth for FY2025+.
--
-- REVERSING:
--   1. All 14 `qbo_expense_reconciliation` JEs (FY2025-Feb2026 monthly true-ups)
--      Purpose was "make GL expense match QBO P&L expense". Removed because QBO
--      is no longer the truth source.
--   2. 1 `pre_sync_adjustment` JE (May 28 2025 Mercury Savings $22,899 correction)
--      Now redundant — Phase 29 monthly recon (migration 075/077/078) handles
--      Mercury Savings reconciliation directly.
--
-- KEEPING (annotated, not reversed):
--   - qbo_pnl_reconstruction (14): POS revenue via bookkeeper transcription —
--     best available source for Jan 2025-Feb 2026 retail revenue (no Toast
--     Sales Summary direct export available for that period)
--   - qbo_je_ingest (64): Toast Payroll PPE detail via bookkeeper transcription —
--     best available payroll detail (no Toast Payroll Journal direct export)
--   - 9 pre_sync_adjustment from Sessions 22-23: legitimate cleanup of Cash
--     Clearing $147K, CC Clearing $40K, Tips Payable $10K, etc. Reversing these
--     would re-introduce those phantom balances.
--   - cleanup_reclass, reclass_to_equity: Drew's accounting decisions
--
-- EXPECTED P&L IMPACT:
--   FY2025 expense decreases by ~$17K net (qbo_expense_reconciliation net)
--   FY2025 NI improves from -$353,119.31 toward ~-$336,000
--   FY2026 (Jan-Feb partial) expense decreases by ~$82K
--   Mercury GL drift will be re-corrected by migration 080 (Phase 29 recon v4)

-- Step 0: Unlock all closed periods for FY2025 reversal
UPDATE closed_periods SET unlocked_at=datetime('now'),
  unlock_reason='Phase 29-C foundational reversal of qbo_expense_reconciliation + pre_sync MSavings',
  unlocked_by='session_29c_foundational'
WHERE unlocked_at IS NULL;

-- Step 1: Reverse 14 qbo_expense_reconciliation JEs
UPDATE journal_entries
  SET status='reversed',
      notes=COALESCE(notes,'') || ' | Phase 29-C reversed 2026-05-19; QBO no longer source of truth per Drew directive'
WHERE source_type='qbo_expense_reconciliation'
  AND status='posted';

-- Step 2: Reverse pre_sync_adjustment Mercury Savings $22,899 (May 28 2025)
UPDATE journal_entries
  SET status='reversed',
      notes=COALESCE(notes,'') || ' | Phase 29-C reversed; redundant with Phase 29 monthly recon (migration 075/077/078)'
WHERE id='be2829b0606d88aad899431a790589';

-- Step 3: Annotate kept source_types so future reviewers understand source attribution
UPDATE journal_entries
  SET notes=COALESCE(notes,'') || ' | KEPT Phase 29-C 2026-05-19: POS revenue via bookkeeper transcription (no direct Toast Sales Summary export available for FY2025)'
WHERE source_type='qbo_pnl_reconstruction' AND status='posted';

UPDATE journal_entries
  SET notes=COALESCE(notes,'') || ' | KEPT Phase 29-C 2026-05-19: Toast Payroll PPE detail via bookkeeper transcription (no direct Toast Payroll Journal export available)'
WHERE source_type='qbo_je_ingest' AND status='posted';

-- Step 4: Re-lock unlocked periods
UPDATE closed_periods
  SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
WHERE unlock_reason LIKE 'Phase 29-C foundational%';
