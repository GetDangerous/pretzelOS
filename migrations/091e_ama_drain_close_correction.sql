-- migrations/091e_ama_drain_close_correction.sql
-- Phase 31-A2 follow-up: corrective adjustment for Utah DMV ($16,028.71) reclass
-- from Ask My Accountant (expense) to Sales tax to pay (liability drain).
--
-- 31-A2 moved $16,028.71 of Mercury IO Utah DMV charges from DR Ask My Accountant
-- to DR Sales tax to pay. The pre-existing 089j supplemental close JE absorbed
-- prior AMA DR balance to RE. After the reclass, BS at FY2026+ dates is off by
-- $16,028.71 (equivalent to the NI improvement from the expense → liability move).
--
-- Other Phase 31-A2 reclassifications (PayPal → COGS Paper Packaging, Anthropic →
-- Software, etc.) moved DRs between expense accounts — they don't change P&L NI,
-- and the close JE's net absorption is unchanged at the aggregate level. The Utah
-- DMV move is the ONLY one that changed an expense to a liability.
--
-- Corrective: DR AMA $16,028.71 / CR Retained Earnings $16,028.71

UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='091e', unlocked_by='phase_31_a2_close' WHERE unlocked_at IS NULL;

INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '31a2-ama-drain-close-correction',
  '2025-12-31',
  'Phase 31-A2 close correction: AMA Utah DMV reclass NI gain absorbed to RE',
  'fiscal_year_close',
  'phase_31_a2_close_correction',
  16028.71,
  16028.71,
  'posted',
  'phase_31_a2_close',
  'After 090 reclassed $16,028.71 of Mercury Utah DMV charges from DR Ask My Accountant to DR Sales tax to pay (drain liability), the 089j supplemental close JE no longer correctly absorbs AMA balance. This JE absorbs the NI improvement ($16,028.71 less expense) to Retained Earnings. The other 090 reclasses (PayPal → COGS Paper Packaging, Anthropic → Software, etc.) are intra-expense moves that don''t change P&L NI and require no close correction.'
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
VALUES (
  '31a2-ama-drain-close-correction-l1',
  '31a2-ama-drain-close-correction',
  1,
  '0192e1f0-c663-4cfa-a884-29743c8e838d',
  16028.71,
  0,
  'DR Ask My Accountant — offset 089j over-CR after Utah DMV reclass'
),
(
  '31a2-ama-drain-close-correction-l2',
  '31a2-ama-drain-close-correction',
  2,
  '2de7d1ae-b613-4bde-b5c4-1653e8677f17',
  0,
  16028.71,
  'CR Retained Earnings — NI gain $16,028.71 from Utah DMV reclass (expense → liability drain)'
);

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason='091e';
