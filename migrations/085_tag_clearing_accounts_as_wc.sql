-- migrations/085_tag_clearing_accounts_as_wc.sql
-- Phase 29-final: Tag POS clearing accounts as working_capital_category='clearing'
-- so the SOCF treats them as current-asset working capital (like AR).
--
-- ROOT CAUSE OF $26K SOCF leak (post-restatement section): clearing accounts
-- aren't probed by SOCF. Their balance changes during the period leak from
-- the cash flow reconciliation. FY2025 net clearing growth was ~$76K (Cash
-- Clearing grew $162K + others shrunk net -$86K) — that $76K of "should-be-cash"
-- trapped in transit needs to appear as a WC line (asset growth = cash out).

UPDATE chart_of_accounts
SET working_capital_category='clearing'
WHERE account_name LIKE 'Clearing Accounts:%';
