-- Migration 096d: Phase 33-H — Mercury Checking strict-match every month-end
-- Date applied: 2026-05-20
-- Purpose:
--   (1) Reverse Sep 30 2025 v2+v3 recon JEs (which created -$3,910.38 intra-period drift)
--       AND Session 31-A5 mercury_recon_adj on Dec 31 2025 (which compensated for it)
--       Together these 3 JEs net to zero Mercury impact AND zero BRA impact at YE2025.
--       After reversal: Mercury strict-matches at Sep 30, Oct 31, Nov 30 (no more -$3,910.38 drift).
--   (2) Reverse 3 v2/v3 dead-cancel pairs (Jun, Jul, Aug 2025) — they net to zero on Mercury AND BRA;
--       removing reduces audit-trail noise without changing any balance.
--
-- Detailed reasoning:
--   Sep 30 v2: MC +12077.38, BRA -12077.38
--   Sep 30 v3: MC -15987.76, BRA +15987.76 (over-corrects by $3,910.38)
--   31a5 Dec 31: MC +3910.38, BRA -3910.38 (the over-correction unwind)
--   Combined net on Mercury: 12077.38 - 15987.76 + 3910.38 = 0
--   Combined net on BRA: -12077.38 + 15987.76 - 3910.38 = 0
--
--   But intra-period (Sep-Nov 2025) Mercury currently drifts -$3,910.38 from bank.
--   By removing all 3, the intra-period drift disappears: Mercury strict-matches every month-end.
--
-- Expected effect:
--   Mercury Checking GL Sep 30, Oct 31, Nov 30 2025: drift -$3,910.38 → $0 (strict-match) ✓
--   Mercury Checking GL all other month-ends: unchanged (still strict-match) ✓
--   YE2024 Bank Reconciliation Adjustment YE2025: unchanged at -$3,456.40 (legitimate residual)
--   BS balance: unchanged ✓
--   Mercury Savings: unchanged ✓
--
-- Acceptance:
--   Mercury Checking strict-matches bank statement at all 14 month-ends YE2024 - Apr 2026.
--   Tier 1 mercury_gl_matches_statement_monthly: PASS at every check.

-- STEP 1: Reverse Sep 30 2025 v2 + v3 + Session 31-A5 (the over-correction triad)
UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-H 096d: Sep over-correction triad — combined net-zero, removes intra-period drift; reversed 2026-05-20]'
WHERE id IN (
  '29d-recon-2025-09-30',         -- v2: MC +12077.38 / BRA -12077.38
  '29d-recon-v3-2025-09-30',      -- v3: MC -15987.76 / BRA +15987.76 (over-correction)
  '31a5-mercury-ye2025-recon'     -- 31a5: MC +3910.38 / BRA -3910.38 (the compensating unwind)
)
AND status = 'posted';

-- STEP 2: Reverse Jun/Jul/Aug 2025 v2/v3 dead-cancel pairs (zero net impact)
UPDATE journal_entries
SET status = 'reversed',
    notes = COALESCE(notes,'') || ' [Phase 33-H 096d: dead-cancel v2/v3 pair — net-zero on Mercury and BRA; reversed 2026-05-20]'
WHERE id IN (
  '29d-recon-2025-06-30', '29d-recon-v3-2025-06-30',
  '29d-recon-2025-07-31', '29d-recon-v3-2025-07-31',
  '29d-recon-2025-08-31', '29d-recon-v3-2025-08-31'
)
AND status = 'posted';
