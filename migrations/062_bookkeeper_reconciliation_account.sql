-- Session 21-validate (May 15 2026) — Add Pre-Pretzel-OS Reconciliation account
--
-- The bookkeeper-era QBO P&L truth includes expenses from sources we don't have
-- raw data for (Chase Business CC, vendor bills entered directly in QBO, etc.).
-- The monthly truth-up JEs need an offset account to balance.
--
-- This account holds the cumulative delta (qbo_truth_expense - gl_categorizer_expense)
-- as a current liability. When Drew connects Chase Plaid + ingests historical bills,
-- those real transactions can drain this liability over time.
--
-- Idempotent via account_name fixed.

INSERT INTO chart_of_accounts (id, account_name, account_type, account_subtype)
SELECT lower(hex(randomblob(16))), 'Pre-Pretzel-OS Reconciliation', 'liability', 'current_liability'
WHERE NOT EXISTS (
  SELECT 1 FROM chart_of_accounts WHERE account_name = 'Pre-Pretzel-OS Reconciliation'
);

SELECT account_name, account_type, account_subtype
FROM chart_of_accounts WHERE account_name = 'Pre-Pretzel-OS Reconciliation';
