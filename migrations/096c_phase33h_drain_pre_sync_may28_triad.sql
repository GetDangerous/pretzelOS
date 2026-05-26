-- Migration 096c: Phase 33-H — Drain Pre-Sync Adjustments via May 28/31 2025 triad reversal
-- Date applied: 2026-05-20
-- Purpose: Reverse 3 JEs that together net-zero on Mercury but accumulate $22,899.24 across plug accounts.
--
-- The triad (analysis from D1):
--   1. be2829b0606d88aad899431a7905890f (2025-05-28 pre_sync_adjustment):
--      DR Pre-Sync Adjustments $22,899.24 / CR Mercury Savings $22,899.24
--   2. 29d-recon-2025-05-31 (v2 phase_29_recon_adj):
--      DR Mercury Checking $4,811.12 / CR YE2024 Bank Rec Adj $4,811.12
--   3. 29d-recon-v3-2025-05-31 (v3 phase_29_recon_adj):
--      DR Mercury Savings $22,899.24 / CR Mercury Checking $4,811.12 / CR YE2024 Bank Rec Adj $18,088.12
--
-- Combined effect:
--   Mercury Checking: +4,811.12 - 4,811.12 = $0 ✓ (no impact)
--   Mercury Savings: -22,899.24 + 22,899.24 = $0 ✓ (no impact)
--   Pre-Sync Adjustments: +$22,899.24 DR (this is the plug we want to drain)
--   YE2024 Bank Rec Adj: -$4,811.12 - $18,088.12 = -$22,899.24 CR (this is the offsetting plug)
--
-- Reversing all 3 together: Mercury unchanged. Pre-Sync → -$22,899.24. BRA → +$22,899.24.
-- Net plug residual eliminated.
--
-- Expected effect:
--   Pre-Sync Adjustments YE2025: $22,899.24 → $0.00 (AC15 satisfied for this account)
--   YE2024 Bank Reconciliation Adjustment YE2025: -$26,355.64 → -$3,456.40 (much smaller residual)
--   Mercury Checking GL: unchanged (still strict-matches every month-end where it already did)
--   Mercury Savings GL: unchanged (still strict-matches at YE2025)
--
-- Risk: LOW. Mercury accounts net to zero across the triad. Only plug accounts move.

UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-H 096c: triad reversal — Mercury net-zero, drains Pre-Sync to $0 and partial-drains BRA; reversed 2026-05-20]'
WHERE id IN (
  'be2829b0606d88aad899431a7905890f',
  '29d-recon-2025-05-31',
  '29d-recon-v3-2025-05-31'
)
AND status = 'posted';
