-- migrations/065_coa_classification.sql
-- Session 26-A (May 18, 2026): COA classification scaffold for un-lumped P&L.
--
-- WHY: P&L statement currently has structural sections (revenue/cogs/expense/
-- other_*) but no SUB-grouping within them. Operating Expenses is a flat
-- 43-line list. No Prime Cost, no EBITDA, no Labor subtotal. The 110 of 168
-- COA rows that need categorization for proper P&L sub-grouping currently
-- have NULL on every sub-category field except expense_class (which is for
-- operational forecasting, not P&L sectioning).
--
-- WHAT: Three new columns + indexes + seed values from account_name patterns.
--   - expense_category: P&L sub-grouping (labor, occupancy, marketing, etc.)
--   - revenue_channel: P&L revenue split (retail, wholesale, catering, etc.)
--   - working_capital_category: SOCF working capital line lookup (replaces brittle name-LIKE)
--
-- WHERE: chart_of_accounts (account-level, not JE-level — categorizer routes
-- each txn to an account, so account-level classification flows through).
--
-- WHAT THIS DOES NOT TOUCH: account_type, account_subtype, expense_class.
-- Those are locked behind Tier 1 invariants + P&L/BS sectioning logic.
--
-- DESIGN CHOICE: account_name pattern matching for seeds, conservative — leave
-- NULL where genuinely ambiguous so Drew + Phase 26-A2 review surfaces them.

-- ── Schema: 3 new columns ─────────────────────────────────────────────────

ALTER TABLE chart_of_accounts ADD COLUMN expense_category TEXT;
ALTER TABLE chart_of_accounts ADD COLUMN revenue_channel TEXT;
ALTER TABLE chart_of_accounts ADD COLUMN working_capital_category TEXT;

CREATE INDEX IF NOT EXISTS idx_coa_expense_category ON chart_of_accounts (expense_category) WHERE expense_category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coa_revenue_channel ON chart_of_accounts (revenue_channel) WHERE revenue_channel IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coa_wc_category ON chart_of_accounts (working_capital_category) WHERE working_capital_category IS NOT NULL;

-- ── EXPENSE_CATEGORY seeds (FOR account_type IN ('expense','other_expense')) ──

-- LABOR (Payroll wages — 6 accounts: parent, S&W parent, 4 wage children)
UPDATE chart_of_accounts SET expense_category = 'labor'
 WHERE account_type = 'expense' AND (
   account_name = 'Payroll expenses'
   OR account_name = 'Payroll expenses:Salaries & wages'
   OR account_name = 'Payroll expenses:Salaries & wages:Back of House'
   OR account_name = 'Payroll expenses:Salaries & wages:Front of House'
   OR account_name = 'Payroll expenses:Salaries & wages:Management'
   OR account_name = 'Payroll expenses:Salaries & wages:Shift Lead'
   OR account_name = 'Contract labor'
   OR account_name = 'Recruiting Expenses'
   OR account_name = 'Employee benefits'
   OR account_name = 'Uniforms'
 );

-- PAYROLL_TAXES (separated from labor for Prime Cost / Burden split)
UPDATE chart_of_accounts SET expense_category = 'payroll_taxes'
 WHERE account_name = 'Payroll expenses:Payroll taxes';

-- PAYROLL_FEES (Square Payroll / Toast Payroll service fees)
UPDATE chart_of_accounts SET expense_category = 'payroll_fees'
 WHERE account_name = 'Payroll expenses:Payroll Fees';

-- OCCUPANCY (Rent + Utilities + Insurance + Repairs + Storage + Cleaning + Laundry + Lease)
UPDATE chart_of_accounts SET expense_category = 'occupancy'
 WHERE account_type = 'expense' AND (
   account_name = 'Rent'
   OR account_name = 'Lease Expense'
   OR account_name LIKE 'Utilities%'
   OR account_name LIKE 'Insurance%'
   OR account_name = 'Repairs & maintenance'
   OR account_name = 'Storage'
   OR account_name = 'Cleaning Expense'
   OR account_name = 'Laundry Expense'
 );

-- MARKETING (Ads + marketplace marketing promos)
UPDATE chart_of_accounts SET expense_category = 'marketing'
 WHERE account_type = 'expense' AND (
   account_name = 'Advertising & marketing'
   OR account_name = 'Delivery Fees:Marketing Spend / Targeted Promotions'
 );

-- PAYMENT_PROCESSING (card processing fees — restaurant convention: separate line)
UPDATE chart_of_accounts SET expense_category = 'payment_processing'
 WHERE account_type = 'expense' AND (
   account_name = 'Merchant account fees'
   OR account_name = 'QuickBooks Payments Fees'
 );

-- SOFTWARE (SaaS subscriptions)
UPDATE chart_of_accounts SET expense_category = 'software'
 WHERE account_type = 'expense' AND (
   account_name = 'Software & apps'
   OR account_name = 'Memberships & subscriptions'
 );

-- PROFESSIONAL_SERVICES (Legal + Accounting)
UPDATE chart_of_accounts SET expense_category = 'professional_services'
 WHERE account_type = 'expense' AND account_name LIKE 'Legal & accounting%';

-- INTEREST (Interest paid)
UPDATE chart_of_accounts SET expense_category = 'interest'
 WHERE account_type = 'expense' AND account_name = 'Interest paid';

-- TAXES_PENALTIES (Operating taxes + business licenses)
UPDATE chart_of_accounts SET expense_category = 'taxes_penalties'
 WHERE account_type = 'expense' AND (
   account_name LIKE 'Taxes paid%'
   OR account_name = 'Business licenses & Permits'
 );

-- OTHER_OPEX (catch-all for legitimate operating expenses)
UPDATE chart_of_accounts SET expense_category = 'other_opex'
 WHERE account_type = 'expense' AND (
   account_name = 'Office expenses'
   OR account_name = 'Shipping & postage'
   OR account_name = 'Meals'
   OR account_name = 'Supplies'
   OR account_name = 'R&D'
   OR account_name = 'Education'
   OR account_name = 'Travel'
   OR account_name = 'Entertainment'
   OR account_name = 'Contributions to charities'
   OR account_name = 'Bank fees & service charges'
   OR account_name = 'Bad Debt'
   OR account_name = 'Uncategorized Expense'
   OR account_name = 'Delivery Fees:TDS Toast & Uber Fees'
   OR account_name = 'Restaurant Supplies & Equipment'
 );

-- CHANNEL_FEES_PENDING_RECLASS (these will move to contra-revenue in Phase 26-B —
-- tag now so we know what's pending. After Phase 26-B these accounts get is_active=0.)
UPDATE chart_of_accounts SET expense_category = 'channel_fees_pending_reclass'
 WHERE account_type = 'expense' AND account_name IN (
   'Delivery Fees',
   'Delivery Fees:Commission',
   'Delivery Fees:Delivery Commission',
   'Delivery Fees:Merchant / Processing Fees',
   'Delivery Fees:Refunds & Discounts',
   'Delivery Fees:Amendments / Adjustments'
 );

-- ── OTHER_EXPENSE seeds (below operating income) ──────────────────────────

UPDATE chart_of_accounts SET expense_category = 'depreciation'
 WHERE account_type = 'other_expense' AND account_name = 'Depreciation';

UPDATE chart_of_accounts SET expense_category = 'amortization'
 WHERE account_type = 'other_expense' AND account_name = 'Amortization expenses';

UPDATE chart_of_accounts SET expense_category = 'taxes_penalties'
 WHERE account_type = 'other_expense' AND (
   account_name = 'Penalties & Fees'
   OR account_name = 'Sales Tax Over/Under'
 );

UPDATE chart_of_accounts SET expense_category = 'vehicle'
 WHERE account_type = 'other_expense' AND account_name LIKE 'Vehicle expenses%';

-- Ask My Accountant + Cash Over/Short + Reconciliation Discrepancies = "junk drawer" items
-- Categorized as other_one_time so they surface separately on P&L
UPDATE chart_of_accounts SET expense_category = 'other_one_time'
 WHERE account_type = 'other_expense' AND (
   account_name LIKE 'Ask My Accountant%'
   OR account_name = 'Cash Over/Short'
   OR account_name = 'Reconciliation Discrepancies'
 );

-- ── REVENUE_CHANNEL seeds ─────────────────────────────────────────────────

-- RETAIL (Dine-In / Takeout + Beverages sold in-store + Take-out + parent Food Income)
UPDATE chart_of_accounts SET revenue_channel = 'retail'
 WHERE account_type = 'revenue' AND (
   account_name = 'Sales:Food Income'
   OR account_name = 'Sales:Food Income:Dine-In / Takeout'
   OR account_name = 'Sales:Food Income:Take-out'
   OR account_name LIKE 'Sales:Beverage Income%'
   OR account_name = 'Sales:Apparel Retail Sales'
   OR account_name = 'Sales of Product Income'
   OR account_name = 'Sales'
 );

-- DELIVERY_MARKETPLACE (DoorDash/Uber/Grubhub/TGTG)
UPDATE chart_of_accounts SET revenue_channel = 'delivery_marketplace'
 WHERE account_type = 'revenue' AND (
   account_name = 'Sales:Food Income:Delivery'
   OR account_name = 'Too Good To Go'
 );

-- WHOLESALE (B2B wholesale customers — Compass, SLC Bees, etc.)
UPDATE chart_of_accounts SET revenue_channel = 'wholesale'
 WHERE account_type = 'revenue' AND account_name = 'Sales:Food Income:Wholesale';

-- CATERING
UPDATE chart_of_accounts SET revenue_channel = 'catering'
 WHERE account_type = 'revenue' AND account_name = 'Sales:Food Income:Catering';

-- SERVICES (catering setup fees, delivery fees charged to customer)
UPDATE chart_of_accounts SET revenue_channel = 'services'
 WHERE account_type = 'revenue' AND (
   account_name = 'Services'
   OR account_name = 'Service Fee Income'
   OR account_name = 'Billable Expense Income'
 );

-- CONTRA_REVENUE (Discounts/Comps/Refunds reduce gross revenue)
UPDATE chart_of_accounts SET revenue_channel = 'contra_revenue_retail'
 WHERE account_type = 'revenue' AND account_name = 'Discounts, Comps & Refunds';

-- OTHER_REVENUE (un-mappable revenue catch-all)
UPDATE chart_of_accounts SET revenue_channel = 'other_revenue'
 WHERE account_type = 'revenue' AND (
   account_name = 'Unapplied Cash Payment Income'
   OR account_name = 'Uncategorized Income'
 );

-- ── WORKING_CAPITAL_CATEGORY seeds (current liabilities only) ─────────────

UPDATE chart_of_accounts SET working_capital_category = 'ap'
 WHERE account_name = 'Accounts Payable (A/P)';

UPDATE chart_of_accounts SET working_capital_category = 'sales_tax_payable'
 WHERE account_name = 'Sales tax to pay';

UPDATE chart_of_accounts SET working_capital_category = 'tips_payable'
 WHERE account_name = 'Tips Payable';

UPDATE chart_of_accounts SET working_capital_category = 'gift_card_liability'
 WHERE account_name = 'Gift Card Liability';

UPDATE chart_of_accounts SET working_capital_category = 'payroll_payable'
 WHERE account_name = 'Payroll Payable';

UPDATE chart_of_accounts SET working_capital_category = 'payroll_tax_payable'
 WHERE account_name = 'Payroll Liabilities:Payroll tax to pay';

UPDATE chart_of_accounts SET working_capital_category = 'payroll_payable'
 WHERE account_name = 'Payroll Liabilities:Manual Checks';

UPDATE chart_of_accounts SET working_capital_category = 'accrued_liabilities'
 WHERE account_name IN (
   'Payroll Liabilities',
   'Payroll Liabilities:Retirement benefits to pay',
   'Customer prepayments',
   'Prepaid Orders'
 );

-- NOTE: Chase Ink Business (3178), Mercury Credit (0000) - 1, Note Payable - Toast
-- intentionally LEFT NULL — these are credit/loan liabilities, not working capital.
-- Pre-Pretzel-OS Reconciliation is a bookkeeper-era offset, not WC. Left NULL.
-- Payroll Clearing (deleted) is closed, no WC tag needed.

-- ── Sanity check: NULL counts post-seed ───────────────────────────────────
-- After this migration we expect:
--   expense_category NULL: 0 in expense/other_expense (every P&L expense account categorized)
--   revenue_channel NULL: 0 in revenue (every revenue account channeled)
--   working_capital_category NULL: ~7 current_liability rows (CC + loan + Pre-Pretzel + Clearing)
