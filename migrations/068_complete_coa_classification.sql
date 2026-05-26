-- migrations/068_complete_coa_classification.sql
-- Session 26-F (May 18, 2026): Catch the 12 accounts migration 065 didn't seed.
-- 8 cogs + 4 other_income accounts had NULL expense_category AND NULL revenue_channel.
-- Tier 1 invariant `coa_categorization_complete` flagged them.

-- COGS sub-categories
UPDATE chart_of_accounts SET expense_category = 'cogs_food'
 WHERE account_name IN (
   'Cost of goods sold',  -- parent — most txns are food-vendor
   'Cost of goods sold:Food Purchases'
 );

UPDATE chart_of_accounts SET expense_category = 'cogs_beverage'
 WHERE account_name IN (
   'Cost of goods sold:Beer Purchases',
   'Cost of goods sold:N/A Beverage Purchases',
   'Cost of goods sold:Liquor Purchases',
   'Cost of goods sold:Wine Purchases'
 );

UPDATE chart_of_accounts SET expense_category = 'cogs_paper'
 WHERE account_name = 'Cost of goods sold:Paper Packaging Products';

UPDATE chart_of_accounts SET expense_category = 'cogs_other'
 WHERE account_name = 'Cost of goods sold:Apparel for Resale';

-- Other Income → tag with revenue_channel='other_revenue' (these are non-operating income)
UPDATE chart_of_accounts SET revenue_channel = 'other_revenue'
 WHERE account_type = 'other_income' AND revenue_channel IS NULL;
