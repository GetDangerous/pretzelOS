-- Migration 096b: Phase 33-H — Post missing Elyse Doty paper check Mar 13 2025
-- Date applied: 2026-05-20
-- Purpose: Mercury sync doesn't ingest paper checks. One $362.23 check to Elyse Doty on Mar 13 2025
--   sat in mercury_transactions with is_reconciled=0 since the start. This is the EXACT source of the
--   persistent +$362.23 Mercury Checking GL drift from Mar 31 2025 onward.
--
-- Source confirmation:
--   - Mercury Mar 2025 statement (dangerous-pretzel-company-llc-0118-monthly-statement-2025-03.pdf):
--     Line: "Mar 13 · Elyse Doty · Check Payment · -$362.23"
--   - mercury_transactions: id=6c7f6542-e24b-44bd-a2f8-b7d3c5e8833c, amount=-362.23, is_reconciled=0
--   - QBO archive Purchase Id=954 (TxnDate 2025-03-04 recorded by bookkeeper, paid 2025-03-13):
--     EntityRef: Elyse Doti (Vendor 130)
--     AccountRef: "Payroll Clearing (deleted)" (modern equivalent: Clearing Accounts:Payroll Clearing)
--     PrivateNote: "Elyse Doty; From Dangerous Pretzel Company LLC"
--   - Single one-off payment; bookkeeper treated as contractor labor routed through Payroll Clearing.
--
-- Treatment: post DR Payroll Clearing / CR Mercury Checking on Mar 13 2025 (matches bookkeeper exactly).
--   Pattern B (Session 30) routes payroll-related cash legs through Payroll Clearing — this fits cleanly.
--
-- Expected effect:
--   Mercury Checking GL Mar 31 2025+ drift: +$362.23 → $0.00 (strict-match resumed) ✓
--   Payroll Clearing balance increases by $362.23 (joins other transient payroll-related items)
--   mercury_transactions: is_reconciled=1 and matched_journal_entry_id set
--
-- Acceptance:
--   AC for Mercury strict-match: Mar 31 2025 GL = bank statement $73,064.34 cent-accurate

-- STEP 1: Post the missing JE
INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES (
  '33h-elyse-doty-paper-check-2025-03-13',
  '2025-03-13',
  'mercury_txn_paper_check',
  '6c7f6542-e24b-44bd-a2f8-b7d3c5e8833c',
  'posted',
  'Phase 33-H 096b: Elyse Doty paper check $362.23 — Mar 13 2025 paper check not auto-ingested by Mercury sync (Send Money txn). Per QBO archive Purchase Id=954, bookkeeper routed through Payroll Clearing (contractor labor).',
  362.23, 362.23, 'phase_33h_migration', datetime('now')
);

-- STEP 2: Post lines (DR Payroll Clearing / CR Mercury Checking)
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33h-elyse-l01', '33h-elyse-doty-paper-check-2025-03-13', 1, '50000-payroll-clearing', 362.23, 0, 'Elyse Doty contractor labor — bookkeeper coded to Payroll Clearing per QBO Purchase 954'),
  ('33h-elyse-l02', '33h-elyse-doty-paper-check-2025-03-13', 2, '0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8', 0, 362.23, 'Mercury Checking paper check Mar 13 2025 per Mercury statement');

-- STEP 3: Mark mercury_transactions row as reconciled
UPDATE mercury_transactions
SET is_reconciled = 1,
    matched_journal_entry_id = '33h-elyse-doty-paper-check-2025-03-13'
WHERE id = '6c7f6542-e24b-44bd-a2f8-b7d3c5e8833c';
