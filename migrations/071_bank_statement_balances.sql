-- migrations/071_bank_statement_balances.sql
-- Session 29-A (May 19, 2026): Source-of-truth bank statement closing balances.
--
-- Stores actual statement closing balance per account per month-end. Used by:
--   1. Tier 1 invariant `mercury_gl_matches_statement_monthly` (Session 29-F)
--   2. Reconciliation dashboard
--   3. Drift detection — if GL ≠ statement at any month-end, surface immediately
--
-- WHY: After 30 sessions of treating QBO bookkeeper data as truth, we discovered
-- the bookkeeper's QBO had $80K of phantom cash that propagated through every
-- statement. The actual Mercury bank statements are the real source of truth.
-- This table makes that source of truth queryable.

CREATE TABLE IF NOT EXISTS bank_statement_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_name TEXT NOT NULL,   -- 'Mercury Checking (0118) - 1', 'Mercury Savings (5450) - 1', 'Mercury Credit (0000) - 1', 'Chase Ink Business (3178)'
  statement_period TEXT NOT NULL,  -- 'YYYY-MM' e.g., '2024-12' for December 2024 statement
  statement_end_date TEXT NOT NULL,  -- 'YYYY-MM-DD' = last day of statement period
  beginning_balance REAL,
  closing_balance REAL NOT NULL,
  source TEXT,  -- 'mercury_pdf_v2', 'chase_pdf', 'manual_entry'
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account_name, statement_period)
);

CREATE INDEX IF NOT EXISTS idx_bank_stmt_account_period ON bank_statement_balances (account_name, statement_end_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_period ON bank_statement_balances (statement_end_date DESC);

-- ── Mercury Checking ••0118 ──────────────────────────────────────────────
INSERT INTO bank_statement_balances (account_name, statement_period, statement_end_date, beginning_balance, closing_balance, source, notes) VALUES
('Mercury Checking (0118) - 1','2023-08','2023-08-31',0.00,30012.50,'mercury_pdf_v2','Account opened 2023-08'),
('Mercury Checking (0118) - 1','2023-09','2023-09-30',30012.50,29981.40,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2023-10','2023-10-31',29981.40,17250.53,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2023-11','2023-11-30',17250.53,49973.76,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2023-12','2023-12-31',49973.76,168230.26,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-01','2024-01-31',168230.26,161059.88,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-02','2024-02-29',161059.88,87684.83,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-03','2024-03-31',87684.83,100536.17,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-04','2024-04-30',100536.17,70304.45,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-05','2024-05-31',70304.45,158832.54,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-06','2024-06-30',158832.54,62910.46,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-07','2024-07-31',62910.46,125882.59,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-08','2024-08-31',125882.59,109490.43,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-09','2024-09-30',109490.43,45812.51,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-10','2024-10-31',45812.51,123870.80,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-11','2024-11-30',123870.80,75445.08,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2024-12','2024-12-31',75445.08,34961.75,'mercury_pdf_v2','YE2024 — true cash OB for Phase 29 reset'),
('Mercury Checking (0118) - 1','2025-01','2025-01-31',34961.75,52591.74,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2025-02','2025-02-28',52591.74,157381.29,'mercury_pdf_v2','Drew $80K wash + Bridge BLOQ TI'),
('Mercury Checking (0118) - 1','2025-03','2025-03-31',157381.29,73064.34,'mercury_pdf_v2','Drew paid Todd $80K back'),
('Mercury Checking (0118) - 1','2025-04','2025-04-30',73064.34,59523.48,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2025-05','2025-05-31',59523.48,44695.00,'mercury_pdf_v2','Savings 5450 activated $13K'),
('Mercury Checking (0118) - 1','2025-06','2025-06-30',44695.00,44241.77,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2025-07','2025-07-31',44241.77,22382.71,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2025-08','2025-08-31',22382.71,19727.86,'mercury_pdf_v2','Closing from next stmt opening'),
('Mercury Checking (0118) - 1','2025-09','2025-09-30',19727.86,1576.98,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2025-10','2025-10-31',1576.98,6112.96,'mercury_pdf_v2','Closing from next stmt opening'),
('Mercury Checking (0118) - 1','2025-11','2025-11-30',6112.96,13585.25,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2025-12','2025-12-31',13585.25,1197.38,'mercury_pdf_v2','YE2025'),
('Mercury Checking (0118) - 1','2026-01','2026-01-31',1197.38,27773.49,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2026-02','2026-02-28',27773.49,24120.66,'mercury_pdf_v2','Closing from next stmt opening'),
('Mercury Checking (0118) - 1','2026-03','2026-03-31',24120.66,18646.15,'mercury_pdf_v2',NULL),
('Mercury Checking (0118) - 1','2026-04','2026-04-30',18646.15,33200.32,'mercury_pdf_v2',NULL);

-- ── Mercury Savings ••5450 ──────────────────────────────────────────────
INSERT INTO bank_statement_balances (account_name, statement_period, statement_end_date, beginning_balance, closing_balance, source, notes) VALUES
('Mercury Savings (5450) - 1','2023-08','2023-08-31',0.00,0.00,'mercury_pdf_v2','Savings dormant pre-May 2025'),
('Mercury Savings (5450) - 1','2023-09','2023-09-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2023-10','2023-10-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2023-11','2023-11-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2023-12','2023-12-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-01','2024-01-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-02','2024-02-29',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-03','2024-03-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-04','2024-04-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-05','2024-05-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-06','2024-06-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-07','2024-07-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-08','2024-08-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-09','2024-09-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-10','2024-10-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-11','2024-11-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2024-12','2024-12-31',0.00,0.00,'mercury_pdf_v2','YE2024 — Savings empty before May 2025'),
('Mercury Savings (5450) - 1','2025-01','2025-01-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-02','2025-02-29',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-03','2025-03-31',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-04','2025-04-30',0.00,0.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-05','2025-05-31',0.00,13000.00,'mercury_pdf_v2','First Savings deposit'),
('Mercury Savings (5450) - 1','2025-06','2025-06-30',13000.00,13000.00,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-07','2025-07-31',13000.00,13000.01,'mercury_pdf_v2','Interest started'),
('Mercury Savings (5450) - 1','2025-08','2025-08-31',13000.01,13000.02,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-09','2025-09-30',13000.02,53000.03,'mercury_pdf_v2','Drew $40K deposit'),
('Mercury Savings (5450) - 1','2025-10','2025-10-31',53000.03,21074.01,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-11','2025-11-30',21074.01,11878.34,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2025-12','2025-12-31',11878.34,11878.35,'mercury_pdf_v2','YE2025'),
('Mercury Savings (5450) - 1','2026-01','2026-01-31',11878.35,22899.24,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2026-02','2026-02-29',22899.24,22899.26,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2026-03','2026-03-31',22899.26,22899.28,'mercury_pdf_v2',NULL),
('Mercury Savings (5450) - 1','2026-04','2026-04-30',22899.28,7899.30,'mercury_pdf_v2',NULL);

-- ── Mercury Credit (IO ••0000) — Due-by balance is the actual outstanding ──
INSERT INTO bank_statement_balances (account_name, statement_period, statement_end_date, beginning_balance, closing_balance, source, notes) VALUES
('Mercury Credit (0000) - 1','2024-03','2024-03-31',NULL,0.00,'mercury_pdf_v2','Auto-pay clears to 0'),
('Mercury Credit (0000) - 1','2024-04','2024-04-30',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-05','2024-05-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-06','2024-06-30',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-07','2024-07-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-08','2024-08-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-09','2024-09-30',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-10','2024-10-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-11','2024-11-30',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2024-12','2024-12-31',NULL,0.00,'mercury_pdf_v2','YE2024'),
('Mercury Credit (0000) - 1','2025-01','2025-01-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-02','2025-02-29',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-03','2025-03-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-04','2025-04-30',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-05','2025-05-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-06','2025-06-30',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-07','2025-07-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-08','2025-08-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2025-09','2025-09-30',NULL,12107.65,'mercury_pdf_v2','Auto-pay broke?'),
('Mercury Credit (0000) - 1','2025-10','2025-10-31',NULL,9335.73,'mercury_pdf_v2','Partial pay'),
('Mercury Credit (0000) - 1','2025-11','2025-11-30',NULL,0.00,'mercury_pdf_v2','Paid off'),
('Mercury Credit (0000) - 1','2025-12','2025-12-31',NULL,4039.69,'mercury_pdf_v2','YE2025'),
('Mercury Credit (0000) - 1','2026-01','2026-01-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2026-02','2026-02-29',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2026-03','2026-03-31',NULL,0.00,'mercury_pdf_v2',NULL),
('Mercury Credit (0000) - 1','2026-04','2026-04-30',NULL,0.00,'mercury_pdf_v2',NULL);

-- ── Chase Ink Business ••3178 (opened March 2026) ────────────────────
INSERT INTO bank_statement_balances (account_name, statement_period, statement_end_date, beginning_balance, closing_balance, source, notes) VALUES
('Chase Ink Business (3178)','2026-03','2026-04-04',0.00,969.80,'chase_pdf','Cycle 3/16/26 - 4/4/26 (first cycle, account opened mid-March)'),
('Chase Ink Business (3178)','2026-04','2026-05-04',969.80,7164.69,'chase_pdf','Cycle 4/5/26 - 5/4/26');
