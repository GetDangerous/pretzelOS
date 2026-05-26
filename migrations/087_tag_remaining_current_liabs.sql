-- migrations/087_tag_remaining_current_liabs.sql
-- Tag remaining current_liability accounts so SOCF captures their changes.

UPDATE chart_of_accounts SET working_capital_category='credit_card_liability'
  WHERE account_name IN ('Mercury Credit (0000) - 1','Chase Ink Business (3178)');

UPDATE chart_of_accounts SET working_capital_category='short_term_loan'
  WHERE account_name = 'Note Payable - Toast';

UPDATE chart_of_accounts SET working_capital_category='payroll_payable'
  WHERE account_name = 'Payroll Clearing (deleted)';

UPDATE chart_of_accounts SET working_capital_category='reclass_holding'
  WHERE account_name = 'Pre-Pretzel-OS Reconciliation';
