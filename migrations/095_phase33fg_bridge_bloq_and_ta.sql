-- Migration 095: Phase 33-F + Phase 33-G — Bridge BLOQ + T&A flow correction
-- Date applied: 2026-05-20
-- Purpose: Replace Phase 24 narrative JEs (Section 110 + partner-exit) with proper
-- source-of-truth mercury_txn JEs for the 4 critical 2025 cash events.
-- Also reverses corresponding phase_29_recon_adj JEs that compensated for the missing entries.
--
-- 4 critical cash events:
--   Feb 12 2025: $80,000 IN from Drew Sparks personal (bridge loan to LLC)
--   Feb 13 2025: $80,000 OUT to Chase ••7262 (T&A Final Settlement Payment)
--   Feb 24 2025: $123,400.74 IN from Bridge BLOQ A&Z LLC (TI reimbursement clears YE2024 AR)
--   Mar 03 2025: $80,000 OUT to Wells Fargo ••6788 (Drew reimburses himself after TI received)
--
-- Section 110 treatment per Drew Q1: "not as income" + filed Form 4562 shows NO basis reduction.
-- Treatment: Cash receipt simply clears Bridge BLOQ Receivable. Leasehold basis stays $438,100.

-- STEP 1: Reverse Phase 24 narrative JEs
UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-F/G: replaced by mercury_txn JEs 2026-05-20]'
WHERE id IN ('24-bridge-bloq-section-110','24-partner-exit-settlement-2025-03-03')
AND status = 'posted';

-- STEP 2: Reverse phase_29_recon_adj for Feb/Mar/Apr 2025 (compensated for missing txns)
UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-F/G: replaced by proper mercury_txn JEs 2026-05-20]'
WHERE id IN ('29d-recon-v3-2025-02-28','29d-recon-v3-2025-03-31','29d-recon-v3-2025-04-30')
AND status = 'posted';

-- STEP 3: Post 4 new mercury_txn JEs

-- 3a: Feb 12 2025 - Drew Sparks personal IN $80K (bridge loan from owner to LLC)
INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES ('33fg-mercury-2025-02-12-drew-loan-in','2025-02-12','mercury_txn','mercury-drew-personal-feb12','posted',
  'Mercury inflow · DREW M SPARKS personal — bridge loan to LLC to fund T&A Final Settlement Payment (TI reimbursement not yet received). To be repaid on Mar 3 2025 after Bridge BLOQ TI lands Feb 24.',
  80000.00, 80000.00, 'phase_33fg_migration', datetime('now'));

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33fg-feb12-l1','33fg-mercury-2025-02-12-drew-loan-in',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',80000.00,0,'Mercury Checking received Drew personal $80K bridge loan'),
  ('33fg-feb12-l2','33fg-mercury-2025-02-12-drew-loan-in',2,'33c-loan-from-drew-sparks',0,80000.00,'Short-term Loan from Drew Sparks (bridge for T&A Final Payment)');

-- 3b: Feb 13 2025 - T&A Final Settlement Payment $80K OUT to Chase ••7262
INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES ('33fg-mercury-2025-02-13-ta-final-payment','2025-02-13','mercury_txn','mercury-ta-final-feb13','posted',
  'Mercury outflow · $80K transfer to Chase ••7262 — Final Settlement Payment to Todd & Amanda Sparks per 12/18/2024 Settlement Agreement Section 2. Clears YE2024 Settlement Payable - T&A to $0.',
  80000.00, 80000.00, 'phase_33fg_migration', datetime('now'));

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33fg-feb13-l1','33fg-mercury-2025-02-13-ta-final-payment',1,'33c-settlement-payable-ta',80000.00,0,'Clear Settlement Payable - Todd and Amanda (YE2024 $80K Final Payment paid in full)'),
  ('33fg-feb13-l2','33fg-mercury-2025-02-13-ta-final-payment',2,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0,80000.00,'Mercury Checking outflow to Chase ••7262 - T&A Final Settlement');

-- 3c: Feb 24 2025 - Bridge BLOQ TI reimbursement $123,400.74 IN
INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES ('33fg-mercury-2025-02-24-bbloq-ti-in','2025-02-24','mercury_txn','mercury-bbloq-ti-feb24','posted',
  'Mercury inflow · Bridge BLOQ A&Z LLC TI reimbursement $123,400.74 — clears YE2024 Bridge BLOQ Reimbursement Receivable. Per Drew Q1: NOT income (Section 110 / non-taxable treatment per filed Form 4562 which shows no Leasehold basis reduction).',
  123400.74, 123400.74, 'phase_33fg_migration', datetime('now'));

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33fg-feb24-l1','33fg-mercury-2025-02-24-bbloq-ti-in',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',123400.74,0,'Mercury Checking received Bridge BLOQ TI reimbursement'),
  ('33fg-feb24-l2','33fg-mercury-2025-02-24-bbloq-ti-in',2,'33c-bbloq-ar',0,123400.74,'Clear Bridge BLOQ Reimbursement Receivable (YE2024 AR $123,401 satisfied)');

-- 3d: Mar 3 2025 - Drew reimbursement OUT $80K to Wells Fargo ••6788
INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES ('33fg-mercury-2025-03-03-drew-loan-repay','2025-03-03','mercury_txn','mercury-drew-personal-mar3','posted',
  'Mercury outflow · $80K transfer to Wells Fargo ••6788 — repayment of Drew Sparks personal bridge loan made Feb 12 (LLC funded T&A Final Payment before TI reimbursement landed; now repaying after Bridge BLOQ TI received Feb 24).',
  80000.00, 80000.00, 'phase_33fg_migration', datetime('now'));

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33fg-mar3-l1','33fg-mercury-2025-03-03-drew-loan-repay',1,'33c-loan-from-drew-sparks',80000.00,0,'Clear Loan from Drew Sparks bridge loan (Feb 12 inflow repaid in full)'),
  ('33fg-mar3-l2','33fg-mercury-2025-03-03-drew-loan-repay',2,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0,80000.00,'Mercury Checking outflow to Wells Fargo ••6788 - Drew personal reimbursement');

-- STEP 4: Re-point Mercury transactions to new mercury_txn JEs
UPDATE mercury_transactions SET matched_journal_entry_id = '33fg-mercury-2025-02-12-drew-loan-in'
  WHERE txn_date='2025-02-12' AND amount=80000 AND counterparty_name LIKE '%DREW%SPARKS%';
UPDATE mercury_transactions SET matched_journal_entry_id = '33fg-mercury-2025-02-13-ta-final-payment'
  WHERE txn_date='2025-02-13' AND amount=-80000 AND counterparty_name LIKE '%Chase%7262%';
UPDATE mercury_transactions SET matched_journal_entry_id = '33fg-mercury-2025-02-24-bbloq-ti-in'
  WHERE txn_date='2025-02-24' AND amount=123400.74 AND counterparty_name LIKE '%Bridge%BLOQ%';
UPDATE mercury_transactions SET matched_journal_entry_id = '33fg-mercury-2025-03-03-drew-loan-repay'
  WHERE txn_date='2025-03-03' AND amount=-80000 AND counterparty_name LIKE '%Wells%';
