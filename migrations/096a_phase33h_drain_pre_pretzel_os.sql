-- Migration 096a: Phase 33-H — Drain Pre-Pretzel-OS Reconciliation
-- Date applied: 2026-05-20
-- Purpose: Reverse 2 sales_tax_reclass JEs that are double-DRing Sales tax to pay AND parking offsets in Pre-Pretzel-OS Reconciliation plug.
--
-- Background:
--   These JEs were added in Session 24-B to "reclass" sales tax. They DR Sales tax to pay AND CR Pre-Pretzel-OS Reconciliation.
--   But the actual Mercury sales tax remittance txns ALSO DR Sales tax to pay correctly.
--   Result: $14,561.14 of DUPLICATE Sales tax to pay reduction + $14,561.14 of CR plugged into Pre-Pretzel-OS.
--   Removing these JEs drains Pre-Pretzel-OS to $0 AND removes the duplicate Sales tax to pay reduction.
--
-- Expected effect after reversal:
--   Pre-Pretzel-OS Reconciliation balance: -$14,561.14 → $0.00 (AC15 satisfied for this account)
--   Sales tax to pay balance: -$14,561.14 reduction removed → balance increases by $14,561.14
--   YE2025 Sales tax to pay: $14,682.57 + $14,561.14 = $29,243.71
--     (This reflects the true accumulated unremitted sales tax — needs further analysis to confirm reasonable)
--
-- Note: Two other sales_tax_reclass JEs in 2026 (2026-01-02 $1,225.43, 2026-01-22 $10,410.41, 2026-05-01 $13,314.69, 2026-05-15 $8,233.35)
--   are OUT OF SCOPE for this migration — they may need similar treatment but are post-FY2025 so don't affect Irene filing yet.
--   The 4 not reversed here will be analyzed in a follow-up if Sales tax to pay still shows double-recognition pattern.

-- STEP 1: Reverse 2 FY2025 sales_tax_reclass JEs hitting Pre-Pretzel-OS Reconciliation
UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-H 096a: drained Pre-Pretzel-OS plug — Mercury txn already correctly DR Sales tax to pay; this JE was redundant double-DR; reversed 2026-05-20]'
WHERE id IN (
  '24b-sales-tax-reclass-2025-02-06',   -- DR Sales tax to pay 1453.49 / CR Pre-Pretzel-OS 1453.49 (Q4 2024 Utah sales tax payment)
  '24b-sales-tax-reclass-2025-09-30'    -- DR Sales tax to pay 13107.65 / CR Pre-Pretzel-OS 13107.65 (Q2 2025 Utah sales tax payment)
)
AND status = 'posted';
