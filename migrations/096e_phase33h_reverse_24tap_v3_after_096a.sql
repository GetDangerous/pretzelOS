-- Migration 096e: Phase 33-H — Reverse 24tap-v3 sales tax band-aid (now redundant)
-- Date applied: 2026-05-20
-- Purpose: After 096a reversed the 2 redundant sales_tax_reclass JEs at root, the Phase 24
--   24tap-v3 band-aid that was added to "drain Sales tax to pay against Retained Earnings"
--   (DR Sales tax to pay $14,360.10 / CR Retained Earnings $14,360.10) is no longer needed
--   and is now causing $14,360.10 of distortion between FY2025 P&L NI and RE absorption.
--
-- Pre-reversal state (post 096a-d):
--   Sales tax to pay YE2025: $121.43 DR (incorrect — should be ~$14K CR for accrued Q4 2025 tax)
--   Retained Earnings YE2025: -$285,216.05 (incorrect — should be -$299,576.15 matching full FY2025 NI)
--
-- After reversal:
--   Sales tax to pay YE2025: $121.43 - $14,360.10 = -$14,238.67 CR balance ✓ (real accrued tax liability)
--   Retained Earnings YE2025: -$285,216.05 - $14,360.10 = -$299,576.15 ✓ (matches FY2025 P&L NI)
--
-- BS balance unchanged (assets unchanged; liability decreases by $14,360.10 cancelled by equity decrease).
-- Mercury accounts unchanged.
--
-- Acceptance:
--   - YE2025 Retained Earnings = -$299,576.15 (matches FY2025 P&L NI cent-accurate)
--   - YE2025 Sales tax to pay = ~$14,239 CR (real accrued Q4 2025 sales tax liability)
--   - BS still balances at YE2025

UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-H 096e: Phase 24 band-aid no longer needed after 096a sales_tax_reclass reversals; reversed 2026-05-20]'
WHERE id = '24tap-v3-mio-2025-fy-tax-paid'
AND status = 'posted';
