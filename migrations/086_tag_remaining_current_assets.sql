-- migrations/086_tag_remaining_current_assets.sql
-- Tag remaining current_assets as working_capital_category so SOCF captures their changes.
UPDATE chart_of_accounts SET working_capital_category='prepaid_expenses'
  WHERE account_name='Prepaid expenses' AND account_subtype='current_asset';
UPDATE chart_of_accounts SET working_capital_category='other_current_asset'
  WHERE account_subtype='current_asset' AND working_capital_category IS NULL
    AND account_name NOT LIKE 'Mercury%';
