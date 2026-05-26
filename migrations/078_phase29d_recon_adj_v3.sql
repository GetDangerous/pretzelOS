-- migrations/078_phase29d_recon_adj_v3.sql
-- Phase 29-D recon v3: 077 only posted 6 months. v3 covers ALL 16 months
-- with incremental adjustments to bring GL = actual at every month-end.
UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='Phase 29-D v3 recon', unlocked_by='session_29d' WHERE unlocked_at IS NULL;

-- 2025-01-31: inc_chk=$+1,152.42 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-01-31','2025-01-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-01-31_v3',1152.42,1152.42,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-c480d512bff912095f57e723','29d-recon-v3-2025-01-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',1152.42,0.00,'DR Mercury Checking incremental 2025-01-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-0e58d48e3cb8d13561d68bcc','29d-recon-v3-2025-01-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,1152.42,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-02-28: inc_chk=$+123,400.74 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-02-28','2025-02-28','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-02-28_v3',123400.74,123400.74,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-b5c41365408cbbfbafb534f8','29d-recon-v3-2025-02-28',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',123400.74,0.00,'DR Mercury Checking incremental 2025-02-28');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-29c01b94cdb3ad75aeeffd51','29d-recon-v3-2025-02-28',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,123400.74,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-03-31: inc_chk=$-76,300.81 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-03-31','2025-03-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-03-31_v3',76300.81,76300.81,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-2c6ec3d7e03829dbd626295d','29d-recon-v3-2025-03-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,76300.81,'CR Mercury Checking incremental 2025-03-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-7d454e38c1b61cc65d940024','29d-recon-v3-2025-03-31',2,'0fe1d3f8396c77a7592023f02ca947b9',76300.81,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-04-30: inc_chk=$-4,061.42 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-04-30','2025-04-30','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-04-30_v3',4061.42,4061.42,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-7cd08d3802573c7d4e96d3b3','29d-recon-v3-2025-04-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,4061.42,'CR Mercury Checking incremental 2025-04-30');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-7e7a290149040ed8bd9bbec7','29d-recon-v3-2025-04-30',2,'0fe1d3f8396c77a7592023f02ca947b9',4061.42,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-05-31: inc_chk=$-4,811.12 inc_sav=$+22,899.24
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-05-31','2025-05-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-05-31_v3',22899.24,22899.24,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-42701cde6249ade5dfb2b1b1','29d-recon-v3-2025-05-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,4811.12,'CR Mercury Checking incremental 2025-05-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-fe9de649d8077ed71151c210','29d-recon-v3-2025-05-31',2,'b0992150-2601-4f15-a810-96ca068fc548',22899.24,0.00,'DR Mercury Savings incremental 2025-05-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-32c90c480639b85e79b7d6cf','29d-recon-v3-2025-05-31',3,'0fe1d3f8396c77a7592023f02ca947b9',0.00,18088.12,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-06-30: inc_chk=$-10,307.30 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-06-30','2025-06-30','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-06-30_v3',10307.30,10307.30,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-2eb5d1f97209d4d3d486de1f','29d-recon-v3-2025-06-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,10307.30,'CR Mercury Checking incremental 2025-06-30');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-208aa875414c1642f5db4149','29d-recon-v3-2025-06-30',2,'0fe1d3f8396c77a7592023f02ca947b9',10307.30,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-07-31: inc_chk=$-13,562.81 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-07-31','2025-07-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-07-31_v3',13562.81,13562.81,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-5e5a06812bfb035cc1b419ee','29d-recon-v3-2025-07-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,13562.81,'CR Mercury Checking incremental 2025-07-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-f97eada9bd58667fad52638b','29d-recon-v3-2025-07-31',2,'0fe1d3f8396c77a7592023f02ca947b9',13562.81,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-08-31: inc_chk=$-11,536.66 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-08-31','2025-08-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-08-31_v3',11536.66,11536.66,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-ac1be50556d2aa0aa52d4c50','29d-recon-v3-2025-08-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,11536.66,'CR Mercury Checking incremental 2025-08-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-51b5ee0e67cbc68d840ed8e2','29d-recon-v3-2025-08-31',2,'0fe1d3f8396c77a7592023f02ca947b9',11536.66,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-09-30: inc_chk=$-15,987.76 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-09-30','2025-09-30','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-09-30_v3',15987.76,15987.76,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-801f6083c6dc5c90f2f55546','29d-recon-v3-2025-09-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,15987.76,'CR Mercury Checking incremental 2025-09-30');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-8f9094d5bedb42fa91e09824','29d-recon-v3-2025-09-30',2,'0fe1d3f8396c77a7592023f02ca947b9',15987.76,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-10-31: inc_chk=$-9,187.17 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-10-31','2025-10-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-10-31_v3',9187.17,9187.17,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-2ce8aeff061e3ad7a1eb44e4','29d-recon-v3-2025-10-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',0.00,9187.17,'CR Mercury Checking incremental 2025-10-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-6a2d1fbeed9578bf9219fd15','29d-recon-v3-2025-10-31',2,'0fe1d3f8396c77a7592023f02ca947b9',9187.17,0.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-11-30: inc_chk=$+270.00 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-11-30','2025-11-30','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-11-30_v3',270.00,270.00,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-86f95bf39e17f9cfce952f3a','29d-recon-v3-2025-11-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',270.00,0.00,'DR Mercury Checking incremental 2025-11-30');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-b6865ea10db08c65f45074d1','29d-recon-v3-2025-11-30',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,270.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2025-12-31: inc_chk=$+1,990.74 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2025-12-31','2025-12-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2025-12-31_v3',1990.74,1990.74,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-b64ff5eb767f35f66d78ff41','29d-recon-v3-2025-12-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',1990.74,0.00,'DR Mercury Checking incremental 2025-12-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-d3bba8d3f6531c1ee19e5dce','29d-recon-v3-2025-12-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,1990.74,'Offset to YE2024 Bank Recon Adjustment');

-- 2026-01-31: inc_chk=$+6,428.15 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2026-01-31','2026-01-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2026-01-31_v3',6428.15,6428.15,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-2a6febfa7303c4aa6814a96f','29d-recon-v3-2026-01-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',6428.15,0.00,'DR Mercury Checking incremental 2026-01-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-0fd839f04681e9fafab118fb','29d-recon-v3-2026-01-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,6428.15,'Offset to YE2024 Bank Recon Adjustment');

-- 2026-02-28: inc_chk=$+6,104.00 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2026-02-28','2026-02-28','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2026-02-28_v3',6104.00,6104.00,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-c71a9696886bbd5eec830c14','29d-recon-v3-2026-02-28',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',6104.00,0.00,'DR Mercury Checking incremental 2026-02-28');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-f7f8abd397b968ed7079ea98','29d-recon-v3-2026-02-28',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,6104.00,'Offset to YE2024 Bank Recon Adjustment');

-- 2026-03-31: inc_chk=$+13,642.05 inc_sav=$-0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2026-03-31','2026-03-31','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2026-03-31_v3',13642.05,13642.05,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-58c51693a04d6714e054b972','29d-recon-v3-2026-03-31',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',13642.05,0.00,'DR Mercury Checking incremental 2026-03-31');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-621f3db015f7bf6908666953','29d-recon-v3-2026-03-31',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,13642.05,'Offset to YE2024 Bank Recon Adjustment');

-- 2026-04-30: inc_chk=$+13,873.09 inc_sav=$+0.00
INSERT INTO journal_entries (id,entry_date,description,source_type,source_id,total_debit,total_credit,status,created_by) VALUES ('29d-recon-v3-2026-04-30','2026-04-30','Phase 29-D v3 recon: bring Mercury GL = actual statement','phase_29_recon_adj','2026-04-30_v3',13873.09,13873.09,'posted','session_29d');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-ed357595f7cb78c08c8f8c38','29d-recon-v3-2026-04-30',1,'0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',13873.09,0.00,'DR Mercury Checking incremental 2026-04-30');
INSERT INTO journal_entry_lines (id,journal_entry_id,line_number,account_id,debit,credit,memo) VALUES ('29d-v3-efcb08d7ec8b1f7a2e611e6c','29d-recon-v3-2026-04-30',2,'0fe1d3f8396c77a7592023f02ca947b9',0.00,13873.09,'Offset to YE2024 Bank Recon Adjustment');

UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, unlocked_by=NULL WHERE unlock_reason LIKE 'Phase 29-D v3%';