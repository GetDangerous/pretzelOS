-- Session 21-validate (May 15 2026) — Add bookkeeper's expense sub-accounts
--
-- Phase 21-validate found 26 sub-accounts in QBO bookkeeper P&L that don't
-- exist in our COA. Adding them so we can post expense reconstruction JEs
-- (Option A — full expense reconstruction to match QBO cent-accurate).
--
-- Naming convention: parent:child with colon separator (matches our existing
-- pattern like "Sales:Food Income:Dine-In / Takeout").

-- COGS sub-accounts (under parent "Cost of goods sold")
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Cost of goods sold:Beer Purchases', 'cogs', NULL),
  (lower(hex(randomblob(16))), 'Cost of goods sold:Food Purchases', 'cogs', NULL),
  (lower(hex(randomblob(16))), 'Cost of goods sold:Liquor Purchases', 'cogs', NULL),
  (lower(hex(randomblob(16))), 'Cost of goods sold:N/A Beverage Purchases', 'cogs', NULL),
  (lower(hex(randomblob(16))), 'Cost of goods sold:Paper Packaging Products', 'cogs', NULL);

-- Payroll sub-accounts (under "Payroll expenses")
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Payroll expenses:Salaries & wages:Back of House', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Payroll expenses:Salaries & wages:Front of House', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Payroll expenses:Salaries & wages:Management', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Payroll expenses:Salaries & wages:Shift Lead', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Payroll expenses:Payroll Fees', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Payroll expenses:Payroll taxes', 'expense', NULL);

-- Delivery Fees sub-accounts
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Delivery Fees:Amendments / Adjustments', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Delivery Fees:Commission', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Delivery Fees:Delivery Commission', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Delivery Fees:Marketing Spend / Targeted Promotions', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Delivery Fees:Merchant / Processing Fees', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Delivery Fees:Refunds & Discounts', 'expense', NULL);

-- Insurance sub-accounts
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Insurance:Business insurance', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Insurance:LEAF Insurance', 'expense', NULL);

-- Utilities sub-accounts
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Utilities:Internet & TV services', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Utilities:Phone service', 'expense', NULL);

-- Legal & accounting sub-accounts
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Legal & accounting services:Accounting fees', 'expense', NULL),
  (lower(hex(randomblob(16))), 'Legal & accounting services:Legal fees', 'expense', NULL);

-- Vehicle expenses sub-accounts (under Other Expenses)
INSERT OR IGNORE INTO chart_of_accounts (id, account_name, account_type, account_subtype) VALUES
  (lower(hex(randomblob(16))), 'Vehicle expenses:Parking & tolls', 'other_expense', NULL),
  (lower(hex(randomblob(16))), 'Vehicle expenses:Vehicle gas & fuel', 'other_expense', NULL);

SELECT 'Sub-accounts added' as result, COUNT(*) as new_accounts
FROM chart_of_accounts
WHERE account_name IN (
  'Cost of goods sold:Beer Purchases','Cost of goods sold:Food Purchases','Cost of goods sold:Liquor Purchases',
  'Cost of goods sold:N/A Beverage Purchases','Cost of goods sold:Paper Packaging Products',
  'Payroll expenses:Salaries & wages:Back of House','Payroll expenses:Salaries & wages:Front of House',
  'Payroll expenses:Salaries & wages:Management','Payroll expenses:Salaries & wages:Shift Lead',
  'Payroll expenses:Payroll Fees','Payroll expenses:Payroll taxes',
  'Delivery Fees:Amendments / Adjustments','Delivery Fees:Commission','Delivery Fees:Delivery Commission',
  'Delivery Fees:Marketing Spend / Targeted Promotions','Delivery Fees:Merchant / Processing Fees',
  'Delivery Fees:Refunds & Discounts',
  'Insurance:Business insurance','Insurance:LEAF Insurance',
  'Utilities:Internet & TV services','Utilities:Phone service',
  'Legal & accounting services:Accounting fees','Legal & accounting services:Legal fees',
  'Vehicle expenses:Parking & tolls','Vehicle expenses:Vehicle gas & fuel'
);
