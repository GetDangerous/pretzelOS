-- migrations/093_mercury_ye2025_reconciliation.sql
-- Phase 31-A5: Mercury Checking YE2025 reconciliation to bank statement.
--
-- BACKGROUND (root cause documented):
-- Phase 29-D v3 (May 2026) posted monthly Mercury reconciliation JEs that compensated
-- for bookkeeper-era PPE Mercury CR errors. The v3 JEs include cumulative -$3,910 of
-- net CR Mercury across 9 month-ends Sept 2025 - YE2025 that align GL to bookkeeper
-- PPE amounts, NOT to bank statement amounts.
--
-- Phase 30 (May 2026) reversed bookkeeper PPE (089e) and replaced cash legs with
-- Pattern B phase_30_dp_cash_leg using EXACT mercury_transactions.amount values
-- (bank truth). The Phase 29-D v3 adjustments designed for PPE error compensation
-- now over-correct, leaving Mercury Checking GL @ YE2025 = -$2,713 vs actual bank
-- statement closing balance $1,197.38 (delta -$3,910.38).
--
-- For YE2025 filing, Mercury Checking GL must equal bank statement balance. This
-- migration posts ONE reconciliation JE at YE2025 with explicit source citation.
--
-- AUDIT TRAIL FOR EXTERNAL REVIEWER:
-- - Phase 29-D v3 monthly recon JEs that contributed: 29d-recon-v3-2025-09-30,
--   29d-recon-v3-2025-10-31, 29d-recon-v3-2025-11-30, 29d-recon-v3-2025-12-31
--   (each contributed ~$3,910 of CR Mercury that exceeded the corresponding v2 DR
--   in compensation for bookkeeper PPE duplicate JEs).
-- - The over-correction surfaced when Phase 30 reversed those PPE JEs in 089e.
-- - This reconciliation aligns GL to bank statement at the FY2025 filing-relevant
--   date (YE2025). Earlier month-end drifts remain documented in `bank_statement_balances`
--   but don't affect the YE2025 BS that's used for filing.
--
-- Offset account: YE2024 Bank Reconciliation Adjustment (already exists in COA,
-- equity/retained_earnings subtype). This account was created in Phase 29-B for
-- the same class of reconciliation event (Mercury OB correction). Re-using it for
-- this YE2025 reconciliation maintains a single source of bank-vs-GL adjustments
-- across all periods.

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='31-A5', unlocked_by='phase_31_a5' WHERE unlocked_at IS NULL;

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '31a5-mercury-ye2025-recon',
  '2025-12-31',
  'Phase 31-A5: Mercury Checking YE2025 reconciliation to bank statement ($1,197.38)',
  'mercury_recon_adj',
  'phase_31_a5_ye2025',
  3910.38,
  3910.38,
  'posted',
  'phase_31_a5',
  'Reconciliation source: Phase 29-D v3 monthly recon JEs (29d-recon-v3-2025-09-30/10-31/11-30/12-31) cumulatively over-corrected Mercury by $3,910.38 to align with bookkeeper PPE duplicate JEs. Phase 30 089e reversed those PPE JEs and 089d posted exact mercury_transactions.amount-based replacements, but the Phase 29 v3 over-correction was not unwound. This JE brings Mercury Checking YE2025 GL to actual bank statement closing balance $1,197.38 (was -$2,713). Auditor trace: see also bank_statement_balances table for the 64 Mercury statements ingested in Phase 29-A.'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
VALUES (
  '31a5-mercury-ye2025-recon-l1',
  '31a5-mercury-ye2025-recon',
  1,
  '0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',
  3910.38,
  0,
  'DR Mercury Checking — align YE2025 GL to bank statement ($1,197.38)'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
VALUES (
  '31a5-mercury-ye2025-recon-l2',
  '31a5-mercury-ye2025-recon',
  2,
  '0fe1d3f8396c77a7592023f02ca947b9',
  0,
  3910.38,
  'CR YE2024 Bank Reconciliation Adjustment — Phase 29-D v3 over-correction unwind (specific JE IDs cited in JE notes)'
);

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='31-A5';
