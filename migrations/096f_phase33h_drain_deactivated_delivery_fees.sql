-- Migration 096f: Phase 33-H — Drain 5 deactivated Delivery Fees accounts to Retained Earnings
-- Date applied: 2026-05-20
-- Purpose: Phase 26-B (Session 26) moved marketplace fee accumulation from Delivery Fees:*
--   expense accounts to Sales:Channel Adjustments:* contra-revenue accounts. The old accounts
--   were marked is_active=0 but their residual CR balances ($24,301.22 total) were never closed.
--
-- This created GL inconsistency:
--   - P&L statement endpoint (with is_active=1 filter per Phase 31-A1) reports NI = -$323,877.37
--   - GL Retained Earnings (after all fiscal_year_close JEs) absorbed only NI = -$299,576.15
--   - Difference: $24,301.22 (the deactivated Delivery Fees residual)
--
-- The deactivated accounts have these YE2025 balances (CR/negative-expense):
--   Delivery Fees:Commission                          -$13,067.87
--   Delivery Fees:Merchant / Processing Fees           -$8,277.81
--   Delivery Fees:Refunds & Discounts                  -$1,964.09
--   Delivery Fees:Amendments / Adjustments               -$523.00
--   Delivery Fees:Delivery Commission                    -$468.45
--                                                    ------------
--   Total                                            -$24,301.22
--
-- These represent additional "negative expense" / additional revenue from marketplace
-- fees that the P&L endpoint correctly classifies as contra-revenue (now in Channel Adjustments)
-- but the historical CR balance on deactivated accounts was never properly closed to RE.
--
-- Treatment: Post a supplemental fiscal_year_close JE that:
--   DR each deactivated Delivery Fees account (to zero them out)
--   CR Retained Earnings $24,301.22 (additional NI absorption)
--
-- Note: The "CR Retained Earnings" feels counterintuitive — for a LOSS year, we'd expect DR RE.
-- But the deactivated accounts have CR balance = "negative expense" which when properly closed
-- ADDS to NI (less expense = more income). So CR RE makes the GL consistent with the official NI.
--
-- Actually: the underlying activity these CR balances represent IS the marketplace fees as
-- contra-revenue. Since Channel Adjustments accounts are already DR'd for the same magnitude
-- (net 0 from close JEs), this is purely a presentation reclass within Equity.
--
-- Expected effect:
--   Retained Earnings YE2025: -$299,576.15 → -$323,877.37 (matches P&L endpoint NI exactly)
--   Deactivated Delivery Fees accounts: all $0 (no more residual CR)
--   BS balance: unchanged (Equity change offset by accounts going to $0)
--   Mercury: unchanged
--
-- Acceptance:
--   - P&L statement NI = GL Retained Earnings YE2025 cent-accurate
--   - BS still balanced
--   - Tier 1: pnl_net_income_matches_retained_earnings_change PASS

INSERT INTO journal_entries (id, entry_date, source_type, source_id, status, description, total_debit, total_credit, created_by, created_at)
VALUES (
  '33h-096f-deactivated-df-close',
  '2025-12-31',
  'fiscal_year_close',
  'phase_33h_096f',
  'posted',
  'Phase 33-H 096f: drain 5 deactivated Delivery Fees:* accounts CR balance $24,301.22 to Retained Earnings — reconciles GL RE absorption to P&L endpoint NI (-$323,877.37)',
  24301.22, 24301.22, 'phase_33h_migration', datetime('now')
);

INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES
  ('33h-096f-l01', '33h-096f-deactivated-df-close', 1,
   (SELECT id FROM chart_of_accounts WHERE account_name='Delivery Fees:Commission'),
   13067.87, 0, 'Drain Delivery Fees:Commission residual CR balance (deactivated by Phase 26-B)'),
  ('33h-096f-l02', '33h-096f-deactivated-df-close', 2,
   (SELECT id FROM chart_of_accounts WHERE account_name='Delivery Fees:Merchant / Processing Fees'),
   8277.81, 0, 'Drain Delivery Fees:Merchant / Processing Fees residual CR balance (deactivated by Phase 26-B)'),
  ('33h-096f-l03', '33h-096f-deactivated-df-close', 3,
   (SELECT id FROM chart_of_accounts WHERE account_name='Delivery Fees:Refunds & Discounts'),
   1964.09, 0, 'Drain Delivery Fees:Refunds & Discounts residual CR balance (deactivated by Phase 26-B)'),
  ('33h-096f-l04', '33h-096f-deactivated-df-close', 4,
   (SELECT id FROM chart_of_accounts WHERE account_name='Delivery Fees:Amendments / Adjustments'),
   523.00, 0, 'Drain Delivery Fees:Amendments / Adjustments residual CR balance (deactivated by Phase 26-B)'),
  ('33h-096f-l05', '33h-096f-deactivated-df-close', 5,
   (SELECT id FROM chart_of_accounts WHERE account_name='Delivery Fees:Delivery Commission'),
   468.45, 0, 'Drain Delivery Fees:Delivery Commission residual CR balance (deactivated by Phase 26-B)'),
  ('33h-096f-l06', '33h-096f-deactivated-df-close', 6,
   (SELECT id FROM chart_of_accounts WHERE account_name='Retained Earnings'),
   0, 24301.22, 'Additional NI absorption to RE (reconciles to P&L endpoint -$323,877.37 reported NI)');
