-- migrations/077_phase29d_recon_adj_v2.sql
-- Phase 29-D continued: After posting 22 new DP payroll cash legs (migration 076),
-- Mercury Checking GL is now under actual by $61,525.68 at month-ends Oct+.
-- This migration:
--   1. Reverses migration 075 (16 monthly recon JEs from pre-076 GL state)
--   2. Posts new monthly recon JEs based on current GL state (post-076)
--
-- Result: Mercury Checking + Savings GL cumulative balance EQUALS actual statement
-- closing balance at EVERY month-end Jan 2025 → Apr 2026.

-- Unlock closed periods
UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='Phase 29-D v2 recon adj', unlocked_by='session_29d' WHERE unlocked_at IS NULL;

-- Step 1: Reverse migration 075's 16 monthly recon JEs
UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Phase 29-D v2 reversed; superseded by 077' WHERE source_type='phase_29_recon_adj' AND status='posted';

-- 2025-05-31: Chk drift_inc=$+4,811.12  Sav drift_inc=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-2025-05-31','2025-05-31','Phase 29-D v2 monthly recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-05-31_v2',4811.12,4811.12,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-caebf1e01edac43cf1463e4e','29d-recon-2025-05-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',4811.12,0.00,'Phase 29-D recon: DR Mercury Checking to match 2025-05-31 statement');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-4ab93fe80d9370a162b0f79e','29d-recon-2025-05-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,4811.12,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-06-30: Chk drift_inc=$+10,307.30  Sav drift_inc=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-2025-06-30','2025-06-30','Phase 29-D v2 monthly recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-06-30_v2',10307.30,10307.30,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-3f519e992e642cf4350a7999','29d-recon-2025-06-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',10307.30,0.00,'Phase 29-D recon: DR Mercury Checking to match 2025-06-30 statement');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-cd5f84ee0c9476974fb6f397','29d-recon-2025-06-30',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,10307.30,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-07-31: Chk drift_inc=$+13,562.81  Sav drift_inc=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-2025-07-31','2025-07-31','Phase 29-D v2 monthly recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-07-31_v2',13562.81,13562.81,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-bf253834623aba8d92794c1e','29d-recon-2025-07-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',13562.81,0.00,'Phase 29-D recon: DR Mercury Checking to match 2025-07-31 statement');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-746e9d7b49f12fd34ebd532a','29d-recon-2025-07-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,13562.81,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-08-31: Chk drift_inc=$+11,536.66  Sav drift_inc=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-2025-08-31','2025-08-31','Phase 29-D v2 monthly recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-08-31_v2',11536.66,11536.66,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-a2bb79915318cb5d430cdb5b','29d-recon-2025-08-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',11536.66,0.00,'Phase 29-D recon: DR Mercury Checking to match 2025-08-31 statement');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-9ecce05ac6e53cb4472f9d18','29d-recon-2025-08-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,11536.66,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-09-30: Chk drift_inc=$+12,077.38  Sav drift_inc=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-2025-09-30','2025-09-30','Phase 29-D v2 monthly recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-09-30_v2',12077.38,12077.38,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-a63526667e4ceda7be32d810','29d-recon-2025-09-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',12077.38,0.00,'Phase 29-D recon: DR Mercury Checking to match 2025-09-30 statement');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-4932be67db4f81072ae9d14f','29d-recon-2025-09-30',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,12077.38,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-10-31: Chk drift_inc=$+9,230.41  Sav drift_inc=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-2025-10-31','2025-10-31','Phase 29-D v2 monthly recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-10-31_v2',9230.41,9230.41,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-7004ff775c02c49c82e6d8ab','29d-recon-2025-10-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',9230.41,0.00,'Phase 29-D recon: DR Mercury Checking to match 2025-10-31 statement');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-recon-line-8622e33f9f5d78ea33a4462e','29d-recon-2025-10-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,9230.41,'Offset to YE2024 Bank Recon Adjustment');

-- Re-lock unlocked periods
UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason LIKE 'Phase 29-D v2%';