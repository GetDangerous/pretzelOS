-- migrations/066_channel_adjustments_accounts.sql
-- Session 26-B (May 18, 2026): Create contra-revenue accounts for marketplace channel.
--
-- WHY: ASC 606 — marketplace commissions/processing fees/refunds where the
-- marketplace is the principal in the transaction (DoorDash/Uber/Grubhub take
-- the order, charge the customer, take their cut, remit net to Pretzel) should
-- reduce revenue at the gross-to-net point. Currently they sit in Operating
-- Expenses ($25,307 FY2025), which inflates Gross Profit and distorts channel
-- unit economics.
--
-- WHAT: Three contra-revenue accounts under Sales:Channel Adjustments.
-- Tagged revenue_channel='contra_revenue_marketplace' for P&L sub-grouping.
-- account_type='revenue' so they live in the Revenue section; DR balances
-- naturally subtract from Net Revenue (P&L sums credit-debit for revenue).
--
-- AFTER THIS MIGRATION:
--   - 3 new accounts ready to receive reclass JEs (Phase 26-B step 2)
--   - 5 old Delivery Fees:* accounts still active (deactivate after reclass)
--   - Marketing Spend account stays (just retagged to 'marketing' in Phase 26-A)

INSERT INTO chart_of_accounts (id, account_name, account_type, account_subtype, expense_class, revenue_channel, is_active, is_system, created_at)
VALUES
  (lower(hex(randomblob(16))), 'Sales:Channel Adjustments:Marketplace Commission', 'revenue', NULL, NULL, 'contra_revenue_marketplace', 1, 0, datetime('now')),
  (lower(hex(randomblob(16))), 'Sales:Channel Adjustments:Marketplace Processing Fees', 'revenue', NULL, NULL, 'contra_revenue_marketplace', 1, 0, datetime('now')),
  (lower(hex(randomblob(16))), 'Sales:Channel Adjustments:Marketplace Refunds & Adjustments', 'revenue', NULL, NULL, 'contra_revenue_marketplace', 1, 0, datetime('now'));
