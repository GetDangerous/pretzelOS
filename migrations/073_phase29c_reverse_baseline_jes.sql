-- migrations/073_phase29c_reverse_baseline_jes.sql
-- Session 29-C (May 19, 2026): Reverse 27 bookkeeper-era reconstruction JEs
-- that were calibrated against the broken OB baseline.
--
-- WHY: With Phase 29-B correcting the YE2024 OB to actual statement values,
-- the JEs that "drained the phantom cash" via pre_sync_adjustment + reclass
-- are no longer needed (the phantom is gone). Likewise the qbo_expense_reconciliation
-- "force match QBO" JEs are no longer needed — we now reconcile to actual bank.
--
-- KEEP (intentionally not reversed):
--   qbo_pnl_reconstruction (12) — POS-derived monthly P&L, ties to bank deposits
--   qbo_je_ingest (64) — bookkeeper PPE; cash legs ARE actual Mercury Toast Payroll events
--                       (verified Apr 6 2025: $3,982.01 matches Dangerous Pretze)
--   mercury_txn, mercury_io_statement_txn, chase_ink_statement_txn — real bank events
--   All depreciation, partner_contribution, channel_fees, tips_tax_accrual JEs
--
-- Mark reversed JEs with status='reversed' (the existing convention used by
-- earlier phase reversals). Post a fresh JE that EXACTLY MIRRORS each original
-- with DR/CR swapped + source_type='phase_29c_reset' + reversal_of_entry_id
-- pointing to original.

-- Step 1: Mark originals as 'reversed' status
UPDATE journal_entries
   SET status = 'reversed',
       notes = COALESCE(notes,'') || ' | Phase 29-C reversed 2026-05-19'
 WHERE source_type IN ('pre_sync_adjustment','qbo_expense_reconciliation','reclass_to_equity','cleanup_reclass')
   AND status = 'posted';

-- Step 2: Create reversal JEs (mirror DR/CR of each original)
-- Insert reversal journal_entries headers + lines in one go

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes, reversal_of_entry_id)
SELECT
  'rev29c-' || substr(orig.id, 1, 32) as id,
  orig.entry_date,
  'Phase 29-C reversal of: ' || orig.description,
  'phase_29c_reset',
  'reversal_of_' || orig.id,
  orig.total_credit as total_debit,  -- swap totals
  orig.total_debit as total_credit,
  'posted',
  'session_29c',
  'Reverses bookkeeper-era baseline-dependent JE; OB now matches actual bank',
  orig.id
FROM journal_entries orig
WHERE orig.source_type IN ('pre_sync_adjustment','qbo_expense_reconciliation','reclass_to_equity','cleanup_reclass')
  AND orig.status = 'reversed'
  AND orig.notes LIKE '%Phase 29-C reversed%';

-- Step 3: Create reversal JE lines (mirror DR/CR of each original line)
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
SELECT
  lower(hex(randomblob(16))) as id,
  'rev29c-' || substr(orig_je.id, 1, 32) as journal_entry_id,
  orig_line.line_number,
  orig_line.account_id,
  orig_line.credit as debit,   -- swap DR/CR
  orig_line.debit as credit,
  'Phase 29-C reversal: ' || COALESCE(orig_line.memo, '')
FROM journal_entry_lines orig_line
JOIN journal_entries orig_je ON orig_je.id = orig_line.journal_entry_id
WHERE orig_je.source_type IN ('pre_sync_adjustment','qbo_expense_reconciliation','reclass_to_equity','cleanup_reclass')
  AND orig_je.status = 'reversed'
  AND orig_je.notes LIKE '%Phase 29-C reversed%';
