-- Session 21-pre (May 14 2026) — Account subtypes + Opening Balance prep
--
-- 1. Seed equity account subtypes matching bookkeeper's QBO classifications
--    (verified via /finance/qbo/accounts?type=Equity on May 14 2026)
--
-- 2. Ensure all accounts referenced in QBO Balance Sheet as-of 2025-01-31
--    have proper subtypes for Balance Sheet rendering (Current vs Long-term, etc.)
--
-- No data inserted here — the Opening Balance JE is posted via the seeder
-- worker (finance-opening-balance-seed.js) so it's auditable + reversible.

-- Equity subtypes (the 5 NULL → bookkeeper-truth from QBO)
UPDATE chart_of_accounts SET account_subtype = 'opening_balance_equity'
  WHERE account_name = 'Opening balance equity' AND account_subtype IS NULL;
UPDATE chart_of_accounts SET account_subtype = 'partner_distributions'
  WHERE account_name = 'Partner distributions' AND account_subtype IS NULL;
UPDATE chart_of_accounts SET account_subtype = 'partner_contributions'
  WHERE account_name LIKE 'Partner investments%' AND account_subtype IS NULL;
UPDATE chart_of_accounts SET account_subtype = 'retained_earnings'
  WHERE account_name = 'Retained Earnings' AND account_subtype IS NULL;

-- Add "Current Year Earnings" sub-account if needed (for proper BS YE close handling)
-- Bookkeeper QBO shows this as a calculated "Net Income" line on BS, not a stored account.
-- For Pretzel OS we'll compute it the same way (live aggregate from current-FY revenue/expense JEs).

-- Verify result
SELECT account_name, account_subtype FROM chart_of_accounts
  WHERE account_type = 'equity'
  ORDER BY account_name;
