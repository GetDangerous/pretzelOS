-- migrations/089a_clearing_accounts.sql
-- Phase 30 Pattern B: create Payroll Clearing + LEAF Clearing transit accounts.
--
-- Architectural foundation: Mercury sync owns the "cash moved" source-of-truth;
-- reconstruction workers own the "expense recognition + liability accrual" source-of-truth.
-- They net through a clearing account.
--
-- Pre-existing pattern in COA: Cash Clearing, Square Clearing, Doordash Clearing,
-- UberEats Clearing, Grubhub Clearing, Credit Card Clearing — all asset/current_asset.
-- These 2 new accounts follow the same naming + classification.

INSERT INTO chart_of_accounts (
  id, account_name, account_type, account_subtype, parent_account_id,
  detail_type, is_active, is_system, description, notes,
  expense_class, expense_category, revenue_channel, working_capital_category
) VALUES
(
  '50000-payroll-clearing',
  'Clearing Accounts:Payroll Clearing',
  'asset',
  'current_asset',
  NULL,
  NULL,
  1,
  0,
  'Transit account between Mercury Toast Payroll cash outflows and toast_payroll_reconstruction expense/liability recognition. Nets to ~$0 per pay cycle.',
  'Created Phase 30 Pattern B (May 20 2026). Mercury sync DR''s this account for Toast Payroll cash outflows; toast_payroll_reconstruction CR''s this account for Direct Deposit total. Per-cycle balance should be < $5K.',
  NULL,
  NULL,
  NULL,
  NULL
),
(
  '50001-leaf-clearing',
  'Clearing Accounts:LEAF Clearing',
  'asset',
  'current_asset',
  NULL,
  NULL,
  1,
  0,
  'Transit account between Mercury LEAF Funding lease cash outflows and leaf_amortization_reconstruction Principal/Interest/Tax split. Nets to ~$0 per monthly payment.',
  'Created Phase 30 Pattern B (May 20 2026). Mercury sync DR''s this account for LEAF SERVICES outflows; leaf_amortization_reconstruction CR''s this account for the full payment amount. Per-cycle balance should be < $4K.',
  NULL,
  NULL,
  NULL,
  NULL
);
