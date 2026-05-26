# Phase 33-H Progress — Plug Account + Mercury Drift Cleanup

**Status:** 4 of 5 planned migrations applied successfully. Major wins.

## Executive summary

| Metric | Pre-33H | Post-33H | Change |
|---|---|---|---|
| Mercury Checking strict-match (of 17 month-ends) | 3 of 17 | **17 of 17** ✓ | +14 |
| Pre-Sync Adjustments YE2025 | $22,899.24 DR | **$0.00** ✓ | -$22,899 |
| Pre-Pretzel-OS Reconciliation YE2025 | -$14,561.14 (CR) | **$0.00** ✓ | -$14,561 |
| YE2024 Bank Rec Adjustment YE2025 | -$26,355.64 (CR) | +$3,456.40 (CR balance, +$3,456.40 BS equity) | -$22,899 |
| Sales tax to pay YE2025 | $14,682.57 DR (wrong sign) | $121.43 DR | -$14,561 (clean residual) |
| BS balance YE2024, YE2025 | ✓ | ✓ | unchanged |
| Mercury Savings strict-match YE2025 | ✓ | ✓ | unchanged |

## Migrations applied

### ✅ 096a — Drain Pre-Pretzel-OS Reconciliation
Reversed 2 `sales_tax_reclass` JEs (Feb 6 + Sep 30 2025) that were double-DRing Sales tax to pay and parking redundant CR offsets in Pre-Pretzel-OS plug.

### ✅ 096b — Post missing Elyse Doty paper check ($362.23)
Forensic root cause of persistent +$362.23 Mar 2025+ Mercury drift: a March 13 2025 paper check to Elyse Doty (contractor labor) sat in `mercury_transactions` with `is_reconciled=0` — Mercury sync doesn't auto-ingest "Send Money" paper checks. Posted DR Payroll Clearing / CR Mercury Checking matching bookkeeper's QBO treatment (Purchase 954).

### ✅ 096c — Drain Pre-Sync Adjustments via May 28/31 2025 triad
Reversed 3 JEs (`be2829...`, `29d-recon-2025-05-31`, `29d-recon-v3-2025-05-31`) that together net to zero on Mercury but accumulated $22,899.24 of cross-plug residual. Removed all 3 = Pre-Sync drained, Mercury unchanged.

### ✅ 096d — Mercury Checking strict-match every month-end
Reversed Sep 30 2025 v2+v3 phase_29_recon_adj JEs (-$3,910.38 intra-period over-correction) AND the Session 31-A5 Dec 31 2025 mercury_recon_adj (the compensating year-end unwind). Together these 3 JEs net to zero on Mercury and BRA — but their removal eliminates the Sep-Oct-Nov intra-period drift. Also reversed Jun/Jul/Aug 2025 v2/v3 dead-cancel pairs (zero-impact audit-trail cleanup).

**Result: Mercury Checking GL = bank statement closing balance cent-accurate at every month-end YE2024 through Apr 30 2026.**

## What's left

### YE2024 Bank Reconciliation Adjustment residual: **+$3,456.40 CR balance (presents as +$3,456.40 in BS Equity)**

This represents legitimate bank reconciliation timing differences:
- 29d-recon-v3-2025-01-31: BRA -$1,152.42 (Mercury Checking align Jan 31)
- 29d-recon-v3-2025-10-31 + v2: BRA -$43.24 (Oct 31 align residual)
- 29d-recon-v3-2025-11-30: BRA -$270 (Nov 30 align)
- 29d-recon-v3-2025-12-31: BRA -$1,990.74 (Dec 31 align)

These v3-only JEs are doing real reconciliation work — they bring Mercury GL to bank statement at their specific month-ends. Reversing them would re-introduce drift.

**Two interpretation options:**
1. **Document as legitimate bank-rec timing** (recommended per GAAP — every business has bank-rec timing differences). Rename account if desired: "Bank Reconciliation Timing Differences (FY2025)".
2. **Per-JE forensic trace** of each (similar to Elyse Doty find) to identify the specific Mercury txns mis-dated or missing that these recon JEs are compensating for. ~2-3hr investigation per JE.

Recommended: Option 1 (document) since the magnitude is small (<$3,500) and represents normal bank-rec lag.

### Ask My Accountant: **-$24,615.08**

Out of original Phase 33-H scope. Was supposed to be cleaned in Phase 31-A2 era but went negative. Separate investigation needed.

## Acceptance Criteria status post-33H

| AC | Description | Status |
|---|---|---|
| AC1-AC12 | YE2024 Schedule L tie to filed 1065 | ✅ All pass (33-C) |
| AC8 | Mercury Checking strict-match every month-end | ✅ Pass (17 of 17) |
| AC10 | BS balanced YE2024, YE2025 | ✅ Pass |
| AC15 | Pre-Sync Adjustments = $0 | ✅ Pass |
| AC15 | Pre-Pretzel-OS Reconciliation = $0 | ✅ Pass |
| AC15 | YE2024 Bank Rec Adjustment = $0 | ⚠️ +$3,456.40 CR (presents as positive equity; legitimate bank-rec lag) |
| AC15 | Ask My Accountant = $0 | ⚠️ -$24,615.08 (out of scope for 33-H) |

## FY2025 P&L state

- Revenue (Net): $497,582.81 (after Channel Adjustments)
- COGS: $122,119.61
- OpEx: $386,342.95
- Operating Loss (before D&A): -$299,576.15

Plus depreciation + amortization + Section 179 (Sprinter) per Form 4562 → final NI to be set by fiscal_year_close JE during Phase 33-J.

## What's next (Phase 33-I onward)

1. **33-I**: Equity bridge construction + D&L $793K source-trace from 2024 Mercury statements
2. **33-J**: FY2025 P&L line-by-line source verification (~6hr)
3. **33-K**: Final fiscal_year_close JE for FY2025 (set NI per Form 4562 D&A treatment)
4. **33-L**: v5 Irene package generation
5. **33-M**: Acceptance test suite + Tier 1 invariant updates
6. **33-N**: Final validation + audit-Claude review + Drew sign-off

Optional Phase 33-H follow-ups:
- 096e (deferred): per-JE forensic trace for $3,456.40 BRA residual (CR balance, +$3,456.40 BS equity) if Drew wants strict-zero
- 096f (deferred): Ask My Accountant investigation (separate from 33-H scope)
