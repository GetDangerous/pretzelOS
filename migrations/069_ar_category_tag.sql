-- migrations/069_ar_category_tag.sql
-- Session 28-A (May 19, 2026): Tag AR with working_capital_category.
--
-- WHY: The SOCF AR filter used `c.account_name LIKE '%AR%'` substring match,
-- which catches: Clearing Accounts (cle**AR**ing), Partner Investments (p**ar**tner),
-- Retained Earnings (e**ar**nings), Partner Distributions, Gift Card Liability,
-- Startup costs, Payroll Clearing — 14 wrong accounts. The "AR change" line in
-- the SOCF was summing equity + clearing + 1 true AR account; for FY2025 the
-- $111,804 figure was almost entirely equity churn + clearing growth, with $0
-- of real AR activity (we have no AR JEs — wholesale recognized cash-basis via
-- QBO Payment recon).
--
-- WHAT: Tag Accounts Receivable (A/R) with working_capital_category='ar' so
-- SOCF can lookup by category instead of substring.

UPDATE chart_of_accounts SET working_capital_category = 'ar'
 WHERE account_name = 'Accounts Receivable (A/R)';

-- Sanity check: this account should now be the ONLY one with wc_category='ar'.
