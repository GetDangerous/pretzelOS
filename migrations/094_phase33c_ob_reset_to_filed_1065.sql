-- Migration 094: Phase 33-C — YE2024 OB Reset to Filed 2024 1065
-- Date applied: 2026-05-20
-- Purpose: Reset Pretzel OS YE2024 opening balance to match the IRS-filed 2024 1065 Schedule L cent-accurate.
-- Per Phase 33 Principle P1: Filed 1065 is IMMUTABLE for YE2024 OB.
--
-- Action:
--   1. Create 4 new accounts (Bridge BLOQ Receivable, Settlement Payable - T&A, Loan from Drew Sparks, Credit Card Payable)
--   2. Reverse 5 OB-affecting JEs that were sized against wrong references
--   3. Post single clean filed_1065_ob_seed_v2 JE matching every Schedule L line cent-accurate
--
-- Acceptance criteria (per Phase 33 plan):
--   AC1-AC12 all PASS at YE2024 (verified post-migration)
--   BS off=$0.00 at YE2024 (verified)
--   BS off=$0.00 at YE2025 (verified)
--
-- See: irene_package_FY2025/SCHEDULE_L_AUDIT_v1.csv, JE_REVERSAL_MAP_v1.csv

-- STEP 1: Create new accounts
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype, is_active, expense_class, created_at)
VALUES
  ('33c-bbloq-ar', 'Bridge BLOQ Reimbursement Receivable', 'asset', 'current_asset', 1, NULL, datetime('now')),
  ('33c-settlement-payable-ta', 'Settlement Payable - Todd and Amanda', 'liability', 'current_liability', 1, NULL, datetime('now')),
  ('33c-loan-from-drew-sparks', 'Loan from Drew Sparks', 'liability', 'current_liability', 1, NULL, datetime('now')),
  ('33c-credit-card-payable', 'Credit Card Payable', 'liability', 'current_liability', 1, NULL, datetime('now'));

-- STEP 2: Reverse 5 OB-affecting JEs (replaced by 33c-filed-1065-ob-v2)
UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-C: OB reset to filed 1065 — reversed 2026-05-20]'
WHERE id IN (
  '6e4b31cd-e41c-4c24-90c4-d1064e62b756',   -- qbo_opening_balance_seed
  '29b-ob-correction-mercury',                -- phase_29_ob_correction
  '22f-accumdep-backfill-ye2024',             -- depreciation_backfill
  '24-drew-lindsay-note-to-equity-reclass',   -- fiscal_year_close D&L note reclass
  '24c-payroll-payable-ob-drain-2024-12-31'   -- fiscal_year_close Payroll Payable phantom drain
)
AND status = 'posted';

-- STEP 3: Post new clean OB JE
INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES (
  '33c-filed-1065-ob-v2', '2024-12-31', 'filed_1065_ob_seed_v2', 'sched_l_filed_2024',
  'posted',
  'Phase 33-C: YE2024 OB seeded cent-accurate to filed 2024 1065 Schedule L (filed by IB Tax & Accounting PLLC, signed 09/15/2025). Replaces qbo_opening_balance_seed + phase_29_ob_correction + 22f-accumdep-backfill + 24-drew-lindsay-note-to-equity-reclass + 24c-payroll-payable-ob-drain (all reversed in step 2).',
  877575.00, 877575.00, 'phase_33c_migration', datetime('now')
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33c-ob-l01', '33c-filed-1065-ob-v2', 1, '0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8', 34961.75, 0, 'Mercury Checking (0118) - bank statement closing YE2024'),
  ('33c-ob-l02', '33c-filed-1065-ob-v2', 2, '02c1e63a-8bcb-4d7a-bacc-bb0c57912125', 157.25, 0, 'Cash Clearing residual (filed Sched L Line 1 $35119 minus bank $34961.75)'),
  ('33c-ob-l03', '33c-filed-1065-ob-v2', 3, '33c-bbloq-ar', 123401.00, 0, 'Bridge BLOQ TI Reimbursement Receivable per Sched L Statement 5 ($123401 collected Feb 24 2025)'),
  ('33c-ob-l04', '33c-filed-1065-ob-v2', 4, '4e2d41cb-c77c-4217-8ffe-853f1648afe6', 438100.00, 0, 'Leasehold Improvements gross per Form 4562 (placed in service 07/01/24)'),
  ('33c-ob-l05', '33c-filed-1065-ob-v2', 5, '32014eb5-e1b2-4617-b8c1-c1337dbdfa18', 2744.00, 0, 'Furniture & Fixtures gross per Form 4562'),
  ('33c-ob-l06', '33c-filed-1065-ob-v2', 6, 'a70ed6ae-2040-47ad-92a6-7266cf77c3a7', 177409.00, 0, 'Restaurant Equipment gross per Form 4562'),
  ('33c-ob-l07', '33c-filed-1065-ob-v2', 7, '4a09b940-ed3c-4b4b-8110-438e53e224eb', 8970.00, 0, 'Signage gross per Form 4562'),
  ('33c-ob-l08', '33c-filed-1065-ob-v2', 8, '3a859fa9-5be8-4cac-9af7-1a46ae312639', 70900.00, 0, 'Startup & Organizational Costs per Form 4562 Part VI (180-mo amort start 07/01/24)'),
  ('33c-ob-l09', '33c-filed-1065-ob-v2', 9, 'e4d47eed-6f53-4dfb-903e-22db025ae602', 20932.00, 0, 'Security Deposits per Sched L Statement 6'),
  ('33c-ob-l10', '33c-filed-1065-ob-v2', 10, '534695dc-4a43-479a-b2e0-59d265cb242e', 0, 57784.00, 'Accumulated Depreciation per Form 4562 Year-1 total (Leasehold $14604 + F&F $1803 + Equip $35482 + Signage $5895)'),
  ('33c-ob-l11', '33c-filed-1065-ob-v2', 11, 'c6abcb6f-d172-47f0-8478-aa6b23445e19', 0, 2363.00, 'Accumulated Amortization per Form 4562 Part VI Line 44 ($70900/180mo x 6 months Jul-Dec 2024)'),
  ('33c-ob-l12', '33c-filed-1065-ob-v2', 12, '33c-credit-card-payable', 0, 2774.00, 'Credit Card Payable per Sched L Statement 7 (bookkeeper-recorded; Mercury Credit YE2024 bank balance was $0 after Jan 1 auto-pay — variance documented)'),
  ('33c-ob-l13', '33c-filed-1065-ob-v2', 13, '008bbf75-940b-4163-a6e8-0084bc84e9d1', 0, 60394.00, 'N/P LEAF Pizza Ovens (App 902878, $68752 orig 03/19/24, 60mo @ 9.50% APR)'),
  ('33c-ob-l14', '33c-filed-1065-ob-v2', 14, 'd76c464c-94d9-4d64-9acc-9088c3a22deb', 0, 25939.00, 'N/P LEAF Kemper Bakery (App 875130, $30550 orig 01/25/24, 60mo @ 9.50% APR)'),
  ('33c-ob-l15', '33c-filed-1065-ob-v2', 15, '4136c83a-c99d-46e5-a799-5f0d27c551d0', 0, 26088.00, 'N/P LEAF Comm Kitchen-2 (App 906769 addendum 03/28/24, 58mo @ 9.50% APR)'),
  ('33c-ob-l16', '33c-filed-1065-ob-v2', 16, '35a81285-b677-4a38-a548-6c4392827d96', 0, 22434.00, 'N/P LEAF Commercial Kitchen Supply (App 890331 addendum 02/05/24, 59mo @ 9.50% APR)'),
  ('33c-ob-l17', '33c-filed-1065-ob-v2', 17, '194d83d3-b5ae-4c8a-b5c1-ed98ef8b3c06', 0, 3874.00, 'N/P Toast equipment financing per Sched L Statement 7'),
  ('33c-ob-l18', '33c-filed-1065-ob-v2', 18, '33c-settlement-payable-ta', 0, 80000.00, 'Settlement Payable - Todd and Amanda per Sched L Statement 7 ($100K total per 12/18/2024 Settlement Agreement; $20K paid Dec 2024; $80K Final paid Feb 13 2025)'),
  ('33c-ob-l19', '33c-filed-1065-ob-v2', 19, 'f512c947-f299-4871-8c8e-da20a9669715', 0, 856.00, 'Payroll Payable per Sched L Statement 7 (~1 weekend Dec 28-31 2024 accrual)'),
  ('33c-ob-l20', '33c-filed-1065-ob-v2', 20, 'b9aa9dc6-be2d-4447-9787-b2e5be83c388', 0, 1454.00, 'Sales Tax Payable per Sched L Statement 7 (Q4 2024 Utah TC-62 paid Feb 6 2025)'),
  ('33c-ob-l21', '33c-filed-1065-ob-v2', 21, 'f7eb67c2-68d0-42f6-8dbb-4e4d856c662f', 0, 593615.00, 'Partners Capital - Drew & Lindsay per Statement 8 (Drew $296807 + Lindsay $296808) = $793176 contributed - $199561 NI - $813 M&E');
