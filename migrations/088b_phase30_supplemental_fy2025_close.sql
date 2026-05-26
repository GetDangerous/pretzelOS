-- migrations/088b_phase30_supplemental_fy2025_close.sql
-- Phase 30 supplemental FY2025 close: absorb qbo_expense_reconciliation reversal NI delta to RE
--
-- Migration 088a reversed 14 qbo_expense_reconciliation JEs (Jan 2025-Feb 2026, $292K activity).
-- This worsened FY2025 NI from -$353,119.31 to -$408,043.13 (delta -$54,923.82).
-- The existing 21v-audit5-fy2025-close JE was sized for the OLD NI. BS now off at FY2026
-- dates by exactly $54,923.82.
--
-- Foundational fix: supplemental fiscal_year_close JE dated 2025-12-31 that zeros each
-- P&L account residual to Retained Earnings (mirrors 22f-fy2025-supplemental-close pattern).
-- Per-account residuals + RE plug computed from current GL state.

-- Step 1: Unlock closed_periods so close can post to 2025-12-31
UPDATE closed_periods
   SET unlocked_at=datetime('now'),
       unlock_reason='Phase 30 supplemental FY2025 close',
       unlocked_by='phase_30_a_supplemental'
 WHERE unlocked_at IS NULL AND period_start LIKE '2025%';

-- Step 2: Insert supplemental close JE header
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES (
  '088a-supplemental-fy2025-close',
  '2025-12-31',
  'Phase 30 supplemental FY2025 close — absorb qbo_expense_reconciliation reversal NI delta ($54,923.82) to Retained Earnings',
  'fiscal_year_close',
  'phase_30_088a_supplemental',
  165753.54,
  165753.54,
  'posted',
  'phase_30_a_supplemental',
  'Phase 30 narrowed scope step 2: absorb qbo_expense_reconciliation reversal NI delta into Retained Earnings via supplemental FY2025 close. Per-account residuals computed from GL state on 2026-05-19.'
);

-- Step 3: Insert JE lines
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l1', '088a-supplemental-fy2025-close', 1, '2de7d1ae-b613-4bde-b5c4-1653e8677f17', 54923.82, 0, 'Absorb FY2025 NI delta from qbo_expense_reconciliation reversal');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l2', '088a-supplemental-fy2025-close', 2, 'b8f265b7-e9f6-45b4-a24d-b03393b910fe', 0, 3715.61, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l3', '088a-supplemental-fy2025-close', 3, '2585f0d1-a4ab-436a-8394-1ead56b3ccf1', 0, 3468.43, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l4', '088a-supplemental-fy2025-close', 4, '8747ac4b-3c67-4dfd-800d-9ed80224b294', 3178.96, 0, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l5', '088a-supplemental-fy2025-close', 5, '6fe11a6a-eae8-4aa5-b65e-5b9f0dc6c289', 2248.12, 0, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l6', '088a-supplemental-fy2025-close', 6, 'c5962c07-1b37-47bb-bedf-324e5fea7d12', 1680, 0, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l7', '088a-supplemental-fy2025-close', 7, 'cd2d38a4-2daf-4541-9d78-145dc16370ea', 0, 704.03, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l8', '088a-supplemental-fy2025-close', 8, '00e39376-235f-4310-aa62-d87f7f8d8814', 0, 329.55, 'Close FY2025 residual to RE: cogs');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l9', '088a-supplemental-fy2025-close', 9, '48d0a202-41e9-47b8-b42f-7e04b5c341aa', 0, 60011.84, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l10', '088a-supplemental-fy2025-close', 10, 'f8b3d005-6fbb-42cb-8018-0b04430865af', 0, 41029.94, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l11', '088a-supplemental-fy2025-close', 11, 'd9696c33-71f2-4360-b812-b8e6dfadda38', 19597.65, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l12', '088a-supplemental-fy2025-close', 12, '2e1a557d-d9d6-426a-a9b2-f567b675e515', 0, 15790, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l13', '088a-supplemental-fy2025-close', 13, '219b6726-780e-406f-aefb-e4605b1117e1', 15055.05, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l14', '088a-supplemental-fy2025-close', 14, '59c8fe56-cb71-463c-844a-5ea9e32fdecb', 13067.87, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l15', '088a-supplemental-fy2025-close', 15, '32b02c4e-ff6b-4a4b-ad44-3166a2cc2769', 11624.36, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l16', '088a-supplemental-fy2025-close', 16, '831aaaa5-12fd-48eb-be78-d2d33804f47f', 8277.81, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l17', '088a-supplemental-fy2025-close', 17, '9966cd80-7889-4c8d-899b-2cf7fe6162ed', 0, 5700.3, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l18', '088a-supplemental-fy2025-close', 18, '92c9c510-3e6a-4e93-a2c8-94bcb4ce9ada', 0, 5177, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l19', '088a-supplemental-fy2025-close', 19, 'f251e0c7-7286-49e2-a0e7-09cbadcf6152', 5177, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l20', '088a-supplemental-fy2025-close', 20, '0c1ff2ad-45a7-4cbb-948a-4b04b053ba35', 4899.92, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l21', '088a-supplemental-fy2025-close', 21, 'fb1e3700-e9fa-4f7c-bc22-b1996d83375d', 4250, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l22', '088a-supplemental-fy2025-close', 22, '58a6237b-235f-44b0-a297-20bab06d175d', 3437.58, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l23', '088a-supplemental-fy2025-close', 23, '936eff9f-bcfe-45ac-811c-0ec095c73f46', 2733.87, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l24', '088a-supplemental-fy2025-close', 24, '883fca46-b1cc-443f-8b0f-c7e7da60ca26', 2391.6, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l25', '088a-supplemental-fy2025-close', 25, 'f56e93c9-e07a-4591-8c81-0d66edf63a37', 2323.06, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l26', '088a-supplemental-fy2025-close', 26, '57d69f3e-3e5c-4b5a-9ca2-f7c52fbc990b', 1964.09, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l27', '088a-supplemental-fy2025-close', 27, 'd8126687-7156-4131-92cf-6acc61e272e3', 1702.51, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l28', '088a-supplemental-fy2025-close', 28, '8103988a-ad3e-470a-83ac-63b0306199cb', 1308.18, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l29', '088a-supplemental-fy2025-close', 29, '40e89e24-12cd-4af2-8e00-294994e88dde', 652.75, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l30', '088a-supplemental-fy2025-close', 30, '2dba4fba-9997-4dd3-a16d-0705fbad382b', 523, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l31', '088a-supplemental-fy2025-close', 31, 'eca7f996-e1c4-4bd5-a1ae-8e33ef21dbd8', 0, 515, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l32', '088a-supplemental-fy2025-close', 32, 'd4116e24-62ba-466e-847a-a38fe8b33e68', 468.45, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l33', '088a-supplemental-fy2025-close', 33, 'ffb54885-616b-42fd-816e-83a7257cffd1', 436.99, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l34', '088a-supplemental-fy2025-close', 34, 'cf9a2669-b3f3-4116-bb77-fde7d7fecf01', 0, 354.79, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l35', '088a-supplemental-fy2025-close', 35, 'f354cb4b-8d1d-458f-bf0e-156cbb375396', 354.79, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l36', '088a-supplemental-fy2025-close', 36, '7a88a17c-a7aa-4a88-b7d5-371c70f1c997', 0, 341.85, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l37', '088a-supplemental-fy2025-close', 37, 'c45ba5f7-3cd4-4b43-b5e7-395883602704', 0, 189.95, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l38', '088a-supplemental-fy2025-close', 38, '85352a16-9460-4585-9f30-e51ba64898d9', 0, 128.94, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l39', '088a-supplemental-fy2025-close', 39, 'f5a5cd1e-44e2-49d5-9e31-118f8363476c', 0, 113.26, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l40', '088a-supplemental-fy2025-close', 40, 'ddf881f9-7ec2-41ff-ace4-c05af5ef0c14', 85.52, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l41', '088a-supplemental-fy2025-close', 41, '1d205d35-a9de-4e9b-b77f-531d3520daa2', 25.27, 0, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l42', '088a-supplemental-fy2025-close', 42, 'c53ad66b-1442-44c7-a84f-d7c63e79ec04', 0, 1.68, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l43', '088a-supplemental-fy2025-close', 43, '8671cff2-5a9d-4da6-9a1f-0a9647d7524e', 0, 0.24, 'Close FY2025 residual to RE: expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l44', '088a-supplemental-fy2025-close', 44, '0192e1f0-c663-4cfa-a884-29743c8e838d', 0, 23518.93, 'Close FY2025 residual to RE: other_expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l45', '088a-supplemental-fy2025-close', 45, '1f5410f5-a38a-40cc-a434-82c80f587d45', 1819.68, 0, 'Close FY2025 residual to RE: other_expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l46', '088a-supplemental-fy2025-close', 46, 'fadd4ef3-b1c4-4e50-8084-c1d94c4a0821', 1113.11, 0, 'Close FY2025 residual to RE: other_expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l47', '088a-supplemental-fy2025-close', 47, 'd0c089ad-cd58-4aab-9079-35db10c0b5f3', 432.53, 0, 'Close FY2025 residual to RE: other_expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l48', '088a-supplemental-fy2025-close', 48, '3ef8407b-1abb-4297-ac99-889ee8365c3e', 0, 96, 'Close FY2025 residual to RE: other_expense');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l49', '088a-supplemental-fy2025-close', 49, '1e977095-49f0-42a9-97c5-8473bdb409e3', 0, 4505.63, 'Close FY2025 residual to RE: other_income');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES ('088a-supplemental-fy2025-close-l50', '088a-supplemental-fy2025-close', 50, 'ef806ccb-b821-4ab0-9011-f557b689da24', 0, 60.57, 'Close FY2025 residual to RE: other_income');

-- Step 4: Re-lock closed_periods
UPDATE closed_periods
   SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL
 WHERE unlock_reason='Phase 30 supplemental FY2025 close';
