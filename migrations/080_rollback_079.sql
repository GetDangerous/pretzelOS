-- migrations/080_rollback_079.sql
-- Rollback migration 079 — after applying it, FY2025 NI went from -$353K to -$408K
-- (worse, not better). Analysis revealed that qbo_expense_reconciliation was actually
-- CORRECTING miscategorized Mercury txns (LEAF loan principal posted as Interest,
-- owner draws posted as Payroll, generic expense accounts that should be specific
-- subcategories per bookkeeper's review).
--
-- Reversing those corrections lost real expense reclassifications. Until the
-- categorizer is fixed at the source (rule changes for LEAF / Mercury Intuit /
-- owner transfers), keeping qbo_expense_reconciliation is the foundational fix
-- because it captures the bookkeeper's manual corrections.
--
-- Restoring: 14 qbo_expense_reconciliation + 1 pre_sync_adjustment Mercury Savings JE.

UPDATE closed_periods SET unlocked_at=datetime('now'),
  unlock_reason='Rollback of migration 079',
  unlocked_by='session_29c_rollback'
WHERE unlocked_at IS NULL;

-- Restore qbo_expense_reconciliation JEs
UPDATE journal_entries
  SET status='posted',
      notes=REPLACE(COALESCE(notes,''), ' | Phase 29-C reversed 2026-05-19; QBO no longer source of truth per Drew directive', '')
WHERE source_type='qbo_expense_reconciliation'
  AND status='reversed'
  AND notes LIKE '%Phase 29-C reversed%';

-- Restore Mercury Savings pre_sync_adjustment
UPDATE journal_entries
  SET status='posted',
      notes=REPLACE(COALESCE(notes,''), ' | Phase 29-C reversed; redundant with Phase 29 monthly recon (migration 075/077/078)', '')
WHERE id='be2829b0606d88aad899431a790589';

-- Remove the annotations on kept source_types (just to keep notes clean)
UPDATE journal_entries
  SET notes=REPLACE(COALESCE(notes,''), ' | KEPT Phase 29-C 2026-05-19: POS revenue via bookkeeper transcription (no direct Toast Sales Summary export available for FY2025)', '')
WHERE source_type='qbo_pnl_reconstruction' AND status='posted';

UPDATE journal_entries
  SET notes=REPLACE(COALESCE(notes,''), ' | KEPT Phase 29-C 2026-05-19: Toast Payroll PPE detail via bookkeeper transcription (no direct Toast Payroll Journal export available)', '')
WHERE source_type='qbo_je_ingest' AND status='posted';

UPDATE closed_periods
  SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
WHERE unlock_reason LIKE 'Rollback of migration 079%';
