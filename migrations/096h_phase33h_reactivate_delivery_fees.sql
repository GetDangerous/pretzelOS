-- Migration 096h: Phase 33-H — Re-activate 5 Delivery Fees:* accounts
-- Date applied: 2026-05-20
-- Purpose: Phase 31-A1 (May 20 2026) deactivated these accounts via `is_active=0` to suppress
--   them from the P&L endpoint, on the theory that their CR balance was a "double-presentation"
--   of marketplace fees already captured in Sales:Channel Adjustments:* contra-revenue.
--
-- This created an inconsistency between:
--   - P&L endpoint NI: -$323,877.37 (excludes these via is_active=1 filter)
--   - GL Retained Earnings YE2025: -$299,576.15 (includes all activity)
--
-- For Irene filing, the GL is the source-of-truth. The endpoint's filter is a presentation
-- Band-Aid that hides $24,301.22 of legitimate "negative expense" CR balance (representing
-- the offsetting side of Phase 26-B's reclass from these expense accounts to Sales:Channel
-- Adjustments contra-revenue).
--
-- Re-activating these accounts:
--   - Does NOT modify any JE (no DR/CR changes)
--   - Does NOT change BS (assets, liabilities, equity all unchanged)
--   - Does NOT change Mercury balances
--   - DOES make the P&L endpoint report the GL-truthful NI of -$299,576.15 instead of -$323,877.37
--   - Consistency: P&L NI will match BS Retained Earnings exactly ($-299,576.15)
--
-- The accounts have no FY2025 activity AFTER excluding fiscal_year_close JEs that drained them.
-- Their persistent CR balance is the offsetting side of Phase 26-B reclass JE pairs:
--   Phase 26-B did: DR Sales:Channel Adjustments:* $X / CR Delivery Fees:* $X
--   The reclass CR exceeded the original DR balance on these accounts, leaving net -$24,301 CR.
--
-- Acceptance:
--   - P&L endpoint NI: -$323,877.37 → -$299,576.15 (matches BS RE)
--   - Tier 1: pnl_net_income_matches_retained_earnings (potential new invariant — Phase 33-K)

UPDATE chart_of_accounts
SET is_active = 1
WHERE account_name IN (
  'Delivery Fees:Commission',
  'Delivery Fees:Merchant / Processing Fees',
  'Delivery Fees:Refunds & Discounts',
  'Delivery Fees:Amendments / Adjustments',
  'Delivery Fees:Delivery Commission'
)
AND is_active = 0;
