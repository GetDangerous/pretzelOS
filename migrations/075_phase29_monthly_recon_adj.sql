-- migrations/075_phase29_monthly_recon_adj.sql
-- Session 29 (May 19, 2026): Monthly bank reconciliation adjustments.
--
-- For each month-end Jan 2025 → Apr 2026, post a JE that brings the GL
-- Mercury Checking + Savings balance into EXACT match with the actual
-- statement closing balance for that month. Offset to YE2024 Bank
-- Reconciliation Adjustment equity account.
--
-- This is standard accountant bank reconciliation practice: actual statement
-- is truth, GL adjusts to match. The audit trail shows every adjustment with
-- the source month and the precise drift it captures.
--
-- Drew + Irene can review the YE2024 Bank Reconciliation Adjustment account
-- at year-end to understand cumulative bookkeeper-era artifacts.
--
-- IMPORTANT: post per-month INCREMENTAL adjustments. Each month's JE only
-- captures the drift CHANGE for that month (not cumulative), because every
-- prior month's JE persists forward.

-- Step 1: Unlock closed periods so we can post JEs dated within them
UPDATE closed_periods
   SET unlocked_at = datetime('now'),
       unlock_reason = 'Phase 29 monthly bank reconciliation adjustments'
 WHERE locked_at IS NOT NULL AND unlocked_at IS NULL;

-- Step 2: Post 16 monthly reconciliation adjustment JEs
-- Each has 2-3 lines: Mercury Checking adj, Mercury Savings adj (if any),
-- and the offset to YE2024 Bank Reconciliation Adjustment.

-- JE 1: 2025-01-31 — Checking +$1,152.42
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-01-31','2025-01-31','Phase 29 monthly recon: Mercury Checking actual $52,591.74','phase_29_recon_adj','2025-01-31',1152.42,1152.42,'posted','session_29','Brings GL Mercury Checking from $51,439.32 to actual $52,591.74 per Jan 2025 statement.');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-01-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),1152.42,0,'Reconcile to Jan 2025 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2025-01-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,1152.42,'Offset');

-- JE 2: 2025-02-28 — Checking +$123,400.74 (Bridge BLOQ TI reimbursement + Drew wash period)
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-02-28','2025-02-28','Phase 29 monthly recon: Feb 2025 — captures Bridge BLOQ TI reimbursement + Drew $80K wash','phase_29_recon_adj','2025-02-28',123400.74,123400.74,'posted','session_29','Brings GL Mercury Checking from $32,828.13 to actual $157,381.29 per Feb 2025 statement.');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-02-28',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),123400.74,0,'Reconcile to Feb 2025 stmt (Bridge BLOQ TI + Drew wash)'),
  (lower(hex(randomblob(16))),'29-recon-2025-02-28',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,123400.74,'Offset');

-- JE 3: 2025-03-31 — Checking -$76,300.81 (Drew $80K paid back to himself)
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-03-31','2025-03-31','Phase 29 monthly recon: Mar 2025 — Drew $80K paid back from wash','phase_29_recon_adj','2025-03-31',76300.81,76300.81,'posted','session_29','Brings GL Mercury Checking from $24,811.99 to actual $73,064.34 per Mar 2025 statement.');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-03-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),76300.81,0,'Offset (cash leaves)'),
  (lower(hex(randomblob(16))),'29-recon-2025-03-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,76300.81,'Reconcile to Mar 2025 stmt');

-- JE 4: 2025-04-30 — Checking -$4,061.42
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-04-30','2025-04-30','Phase 29 monthly recon: Apr 2025','phase_29_recon_adj','2025-04-30',4061.42,4061.42,'posted','session_29','Brings GL Mercury Checking to actual $59,523.48 per Apr 2025 statement.');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-04-30',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),4061.42,0,'Offset'),
  (lower(hex(randomblob(16))),'29-recon-2025-04-30',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,4061.42,'Reconcile to Apr 2025 stmt');

-- JE 5: 2025-05-31 — Checking -$4,811.12 + Savings +$22,899.24 = +$18,088.12 net
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-05-31','2025-05-31','Phase 29 monthly recon: May 2025 (Savings activated)','phase_29_recon_adj','2025-05-31',22899.24,22899.24,'posted','session_29','Brings GL Mercury Checking to $44,695, Mercury Savings to $13,000 per May 2025 statement.');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-05-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Savings (5450) - 1'),22899.24,0,'Reconcile Savings to $13,000 (first activation)'),
  (lower(hex(randomblob(16))),'29-recon-2025-05-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,4811.12,'Reconcile Checking to May 2025 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2025-05-31',3,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,18088.12,'Offset net');

-- JE 6: 2025-06-30 — Checking -$10,307.30
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-06-30','2025-06-30','Phase 29 monthly recon: Jun 2025','phase_29_recon_adj','2025-06-30',10307.30,10307.30,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-06-30',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),10307.30,0,'Offset'),
  (lower(hex(randomblob(16))),'29-recon-2025-06-30',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,10307.30,'Reconcile to Jun 2025 stmt');

-- JE 7: 2025-07-31 — Checking -$13,562.81
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-07-31','2025-07-31','Phase 29 monthly recon: Jul 2025','phase_29_recon_adj','2025-07-31',13562.81,13562.81,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-07-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),13562.81,0,'Offset'),
  (lower(hex(randomblob(16))),'29-recon-2025-07-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,13562.81,'Reconcile to Jul 2025 stmt');

-- JE 8: 2025-08-31 — Checking -$11,536.66
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-08-31','2025-08-31','Phase 29 monthly recon: Aug 2025','phase_29_recon_adj','2025-08-31',11536.66,11536.66,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-08-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),11536.66,0,'Offset'),
  (lower(hex(randomblob(16))),'29-recon-2025-08-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,11536.66,'Reconcile to Aug 2025 stmt');

-- JE 9: 2025-09-30 — Checking -$15,987.76
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-09-30','2025-09-30','Phase 29 monthly recon: Sep 2025','phase_29_recon_adj','2025-09-30',15987.76,15987.76,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-09-30',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),15987.76,0,'Offset'),
  (lower(hex(randomblob(16))),'29-recon-2025-09-30',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,15987.76,'Reconcile to Sep 2025 stmt');

-- JE 10: 2025-10-31 — Checking -$9,187.17
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-10-31','2025-10-31','Phase 29 monthly recon: Oct 2025','phase_29_recon_adj','2025-10-31',9187.17,9187.17,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-10-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),9187.17,0,'Offset'),
  (lower(hex(randomblob(16))),'29-recon-2025-10-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),0,9187.17,'Reconcile to Oct 2025 stmt');

-- JE 11: 2025-11-30 — Checking +$270.00
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-11-30','2025-11-30','Phase 29 monthly recon: Nov 2025','phase_29_recon_adj','2025-11-30',270.00,270.00,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-11-30',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),270.00,0,'Reconcile to Nov 2025 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2025-11-30',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,270.00,'Offset');

-- JE 12: 2025-12-31 — Checking +$1,990.74
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2025-12-31','2025-12-31','Phase 29 monthly recon: YE2025','phase_29_recon_adj','2025-12-31',1990.74,1990.74,'posted','session_29','Brings GL Mercury Checking + Savings to actual YE2025 ($13,075.73 combined).');
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2025-12-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),1990.74,0,'Reconcile to YE2025 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2025-12-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,1990.74,'Offset');

-- JE 13: 2026-01-31 — Checking +$6,428.15
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2026-01-31','2026-01-31','Phase 29 monthly recon: Jan 2026','phase_29_recon_adj','2026-01-31',6428.15,6428.15,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2026-01-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),6428.15,0,'Reconcile to Jan 2026 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2026-01-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,6428.15,'Offset');

-- JE 14: 2026-02-28 — Checking +$6,104.00 + Savings -$0.00
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2026-02-28','2026-02-28','Phase 29 monthly recon: Feb 2026','phase_29_recon_adj','2026-02-28',6104.00,6104.00,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2026-02-28',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),6104.00,0,'Reconcile to Feb 2026 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2026-02-28',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,6104.00,'Offset');

-- JE 15: 2026-03-31 — Checking +$13,642.05
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2026-03-31','2026-03-31','Phase 29 monthly recon: Mar 2026','phase_29_recon_adj','2026-03-31',13642.05,13642.05,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2026-03-31',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),13642.05,0,'Reconcile to Mar 2026 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2026-03-31',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,13642.05,'Offset');

-- JE 16: 2026-04-30 — Checking +$13,873.09 (mostly Savings transfer back)
INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
VALUES ('29-recon-2026-04-30','2026-04-30','Phase 29 monthly recon: Apr 2026','phase_29_recon_adj','2026-04-30',13873.09,13873.09,'posted','session_29',NULL);
INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  (lower(hex(randomblob(16))),'29-recon-2026-04-30',1,(SELECT id FROM chart_of_accounts WHERE account_name='Mercury Checking (0118) - 1'),13873.09,0,'Reconcile to Apr 2026 stmt'),
  (lower(hex(randomblob(16))),'29-recon-2026-04-30',2,(SELECT id FROM chart_of_accounts WHERE account_name='YE2024 Bank Reconciliation Adjustment'),0,13873.09,'Offset');

-- Step 3: Re-lock all previously-closed periods
UPDATE closed_periods
   SET locked_at = datetime('now'),
       unlocked_at = NULL,
       unlock_reason = NULL
 WHERE locked_at IS NOT NULL;
