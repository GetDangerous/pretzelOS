-- migrations/091c_taxes_paid_close_correction.sql
-- Phase 31-A3 follow-up: corrective close adjustment after Taxes Paid reclass.
--
-- 091 reclassed $59,887.34 of mercury_txn DR lines from Taxes Paid to proper
-- liability accounts (Sales tax to pay $14,561 + Payroll tax to pay $45,326).
-- The pre-existing 089j supplemental close JE CR'd Taxes Paid $65,397 to absorb
-- the prior balance. After 091's reclass, Taxes Paid is over-CR'd by $59,887.
--
-- Corrective JE: DR Taxes Paid $59,887 (offset the over-CR) / CR Retained Earnings
-- $59,887 (NI improved by $59,887 — less double-counted expense → RE absorbs less loss).

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='091c', unlocked_by='phase_31_a3_close' WHERE unlocked_at IS NULL;

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '31a3-taxes-paid-close-correction',
  '2025-12-31',
  'Phase 31-A3 close correction: Taxes Paid reclass NI gain absorbed to RE',
  'fiscal_year_close',
  'phase_31_a3_close_correction',
  59887.34,
  59887.34,
  'posted',
  'phase_31_a3_close',
  'After 091 reclassed $59,887 of Mercury Utah sales tax + Strategy Executive payroll tax remittances from DR Taxes Paid to DR Sales tax to pay / DR Payroll Tax to pay (proper liability drains), the 089j supplemental close JE no longer correctly zeros Taxes Paid. This JE adjusts Taxes Paid back to its post-reclass residual and absorbs the NI improvement ($59,887) to Retained Earnings.'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
VALUES (
  '31a3-taxes-paid-close-correction-l1',
  '31a3-taxes-paid-close-correction',
  1,
  '48d0a202-41e9-47b8-b42f-7e04b5c341aa',
  59887.34,
  0,
  'DR Taxes paid — un-do 089j over-CR after 091 reclass'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
VALUES (
  '31a3-taxes-paid-close-correction-l2',
  '31a3-taxes-paid-close-correction',
  2,
  '2de7d1ae-b613-4bde-b5c4-1653e8677f17',
  0,
  59887.34,
  'CR Retained Earnings — NI gain $59,887 from Taxes Paid reclass (double-counted expense removed)'
);

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='091c';
