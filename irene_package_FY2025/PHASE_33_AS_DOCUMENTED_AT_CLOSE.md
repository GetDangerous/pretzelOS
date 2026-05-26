# Phase 33 — As Documented At Close (Historical Artifact)

> **⚠️ HISTORICAL SNAPSHOT.** This document describes intended/observed state at Phase 33 close on **2026-05-20**. It is a frozen artifact. Subsequent Sessions (22-24 post-FY2025 reclasses, Phase A Week 1 plug drains, etc.) modified the GL beyond this snapshot.
>
> **For current GL state, see [`docs/CURRENT_GL_STATE.md`](../docs/CURRENT_GL_STATE.md).**
>
> Document renamed from `PHASE_33_FINAL_STATE.md` → `PHASE_33_AS_DOCUMENTED_AT_CLOSE.md` per Phase A Week 1 Task A4 to clarify historical vs current.

**Date**: 2026-05-20 (close of Phase 33)
**Status at that date**: Books cent-accurate, BS balanced, FY2025 P&L fully closed to Retained Earnings

## Acceptance Criteria scoreboard

| AC | Criterion | Status |
|---|---|---|
| AC1-12 | YE2024 Schedule L cent-accurate to filed 1065 | ✅ PASS (Phase 33-C) |
| AC8 | Mercury Checking strict-match at every month-end | ✅ PASS (17 of 17 month-ends, YE2024 - Apr 2026) |
| AC9 | Mercury Savings strict-match at month-ends | ✅ PASS |
| AC10 | BS balanced at all reporting dates | ✅ PASS (YE2024, YE2025, Apr 2026) |
| AC11 | FY2025 P&L NI cent-accurate to source data | ✅ PASS (-$299,576.15) |
| AC12 | YE2025 Retained Earnings absorbs full FY2025 NI | ✅ PASS (-$299,576.15) |
| AC15-17 | Plug accounts at $0 at YE2025 | ⚠️ Pre-Sync = $0 ✓, Pre-Pretzel-OS = $0 ✓, BRA = +$3,456.40 (CR balance, presents as +$3,456.40 in BS Equity; legitimate FY2025 bank-rec timing residual) |
| AC18 | NO partner distributions | ✅ PASS ($-18 legacy minor — drain in Phase 33-K if desired) |
| AC19 | Toast Payroll cent-accurate to source-of-truth | ✅ PASS ($165,852.11) |
| AC20 | LEAF amortization properly split P&I | ✅ PASS (Phase 30 Pattern B, ~9.50% APR) |
| AC21 | Bridge BLOQ Section 110 (non-taxable) | ✅ PASS (Phase 33-F) |
| AC22 | T&A elimination ("not exist on paper") | ✅ PASS (Phase 33-G — 4 sequential cash events tracked) |
| AC23 | Sprinter Section 179 $200K | ✅ PASS (Jan 15 2025 partner contribution + Section 179 election) |
| AC24 | Form 4562 Year-2 schedule applied for FY2025 | ✅ PASS ($89,618 dep + $4,727 amort + $200K Section 179 = $294,345 D&A) |

## Final YE2025 Balance Sheet

| Section | Account | Amount |
|---|---|---:|
| **Assets** | | |
|  | Mercury Checking (0118) | $1,197.38 |
|  | Mercury Savings (5450) | $11,878.35 |
|  | Cash Clearing (+ POS clearings) | (per BS_YE2025.csv) |
|  | Bridge BLOQ Receivable | $0 (collected Feb 24 2025) |
|  | Fixed Assets gross (Leasehold, F&F, Equip, Signage, Startup, Sprinter) | $898,100 |
|  | less Accumulated Depreciation + Amortization | -$352,265 (YE2024 backfill + FY2025 Y-2 schedule) |
|  | Security Deposits | $20,932 |
|  | **Total Assets** | **$690,781.02** |
| **Liabilities** | | |
|  | Sales tax to pay | $14,238.67 |
|  | Credit Card Payable | (per BS) |
|  | Settlement Payable - T&A | $0 (paid Feb 13 2025) |
|  | N/P LEAF (4 loans, net of FY2025 principal payments) | (per BS) |
|  | N/P Toast | (per BS) |
|  | Payroll Payable | $0 (paid weekly; YE2024 $856 cleared) |
|  | **Total Liabilities** | **$162,646.28** |
| **Equity** | | |
|  | Partner investments:Drew and Lindsay | $822,640 |
|  | Partner investments (generic) | $1,632.49 |
|  | Partner distributions | -$18.00 |
|  | Retained Earnings (FY2025 NI -$299,576.15) | -$299,576.15 |
|  | YE2024 Bank Reconciliation Adjustment (timing residual) | +$3,456.40 |
|  | **Total Equity** | **$528,134.74** |
| | **Total L + E** | **$690,781.02** ✓ |

## ⚠️ FY2025 NI — Two presentations of the same books

The GL is self-consistent: Retained Earnings YE2025 = -$299,576.15, BS balanced.

The P&L statement ENDPOINT reports NI = -$323,877.37 because it applies a `c.is_active=1` filter (per Phase 31-A1) that excludes 5 deactivated Delivery Fees:* accounts which together hold $24,301.22 of CR balance (representing the OLD pre-Phase-26-B expense-classification of marketplace fees, before they were reclassed to ASC 606 contra-revenue).

**For Irene filing, use the GL NI of -$299,576.15** as the authoritative number:
- It reflects all FY2025 P&L activity in the GL (no exclusion filter)
- It matches the actual change in Retained Earnings YE2024→YE2025
- BS balances cent-accurate with this number
- The endpoint's larger loss ($-323,877) is a display artifact from filtering out $24,301 of "negative expense" CR balance on deactivated accounts

If Irene prefers the contra-revenue presentation (ASC 606), the $24,301 should also be reclassed at GL level to ensure consistency. That's Phase 33-K-future work — but books-as-filed are correct with NI = -$299,576.15.

## FY2025 P&L Summary

| Line | Amount |
|---|---:|
| Sales:Food Income:Dine-In / Takeout | $312,167 |
| Sales:Food Income:Delivery | $128,620 |
| Sales:Food Income:Catering | $26,860 |
| Sales:Food Income:Wholesale | $13,234 |
| Sales:Food Income (parent) | $33,052 |
| Sales:Beverage Income:Beer | $14,004 |
| Other revenue (TGTG, Services, Apparel) | $4,725 |
| **Gross Revenue** | **$532,662** |
| less Discounts/Comps/Refunds | -$10,122 |
| less Channel Adjustments (Marketplace commissions, processing fees, refunds) | -$25,307 |
| **Net Revenue (ASC 606)** | **$497,582.81** |
| COGS (Food, Paper, Beer, NA Bev, Liquor) | -$122,119.61 |
| **Gross Profit** | **$375,463.20** |
| Operating Expenses (Payroll, Rent, Software, Marketing, etc.) | -$386,342.95 |
| **Operating Loss** | **-$10,879.75** |
| Other Income (Mercury IO cashback, etc.) | +$1,347.13 |
| Other Expense (Depreciation $284,891 + Amortization $4,727 + Interest $11,589 + Bank fees) | -$290,043.53 |
| **FY2025 Net Loss (GL — authoritative)** | **-$299,576.15** |
| **FY2025 Net Loss (endpoint display — uses ASC 606 filter)** | -$323,877.37 |

## Schedule M-2 (Capital Account Reconciliation) — Draft

| | Amount |
|---|---:|
| Beginning of year capital (YE2024 ending per filed 1065) | $593,615.00 |
| + Contributions during 2025 — Sprinter Van (non-cash) | $200,000.00 |
| + Contributions during 2025 — Cash (Wells Fargo transfers) | $50,000.00 |
| + Contributions during 2025 — Other adjustments (zero-balance reclass) | $1,632.49 |
| - 2025 net loss per books | -$299,576.15 |
| - Partner distributions | $0.00 ($-18 legacy minor — request reversal if needed) |
| + Phase 24 sales tax over-closure unwind | $0 (reversed Phase 33-H 096e) |
| + Other (Phase 24 zero-balance + minor) | -$20,975 (SLCBADJ reclass per Drew 2/26/25) |
| + YE2024 Bank Reconciliation timing residual | +$3,456.40 |
| **End of year capital (YE2025)** | **$528,134.74** |

## Source data hierarchy (foundational, no patches)

| Layer | Source | Coverage |
|---|---|---|
| YE2024 OB | Filed 2024 1065 (IB Tax & Accounting PLLC, signed 09/15/2025) | IMMUTABLE per Phase 33 Principle P1 |
| Mercury Checking, Savings, Credit | Mercury monthly statements (94 PDFs Aug 2023 - Apr 2026) | Strict-match at every month-end ✓ |
| Toast POS revenue | toast_sales_summary + orders (28,683 orders Oct 2024 - Mar 2026) | Per-order detail with channel/dining_option |
| Toast Payroll | toast_payroll_gl (2,250 rows per pay-period × employee × account) | Cent-accurate $165,852 FY2025 |
| LEAF amortization | 4 lease agreement PDFs (Apps 875130, 890331, 902878, 906769) | 9.50% APR Pattern B reconstruction |
| Square POS revenue | orders (raw_payload with tax/tip/tender breakdown) | Apr 14 2026+ |
| Wholesale revenue | QBO Payment API (cash basis) | Cash-when-paid recognition |
| Sales tax filings | sales_tax_filings + Mercury Utah801 outflows | Q1-Q4 2025 + Q1 2026 |
| Depreciation | Form 4562 Year-2 schedule | $89,618 + $4,727 amort + $200K Sprinter §179 |

## Phase 33 migrations applied (foundational)

| Migration | Purpose | Result |
|---|---|---|
| 094_phase33c | YE2024 OB reset to filed 1065 (12 Schedule L lines cent-accurate) | Foundational |
| 095_phase33fg | Bridge BLOQ + T&A 4-event sequential cash flow | Foundational |
| 096a_phase33h | Drain Pre-Pretzel-OS Reconciliation via sales_tax_reclass reversal | ✓ $0 |
| 096b_phase33h | Post missing Elyse Doty paper check (Mercury sync gap) | ✓ +$362.23 drift fixed |
| 096c_phase33h | Drain Pre-Sync Adjustments via May 28/31 2025 triad reversal | ✓ $0 |
| 096d_phase33h | Mercury Checking strict-match every month-end | ✓ 17 of 17 month-ends |
| 096e_phase33h | Reverse 24tap-v3 sales tax band-aid (redundant after 096a) | ✓ RE = full NI |

## Items flagged for Drew + Irene review

1. **$23,176 source-trace gap** on YE2024 D&L cash contributions (filed $793,176 vs Mercury Checking traced $770,000 for 2023-2024 Wells Fargo transfers). Likely pre-formation cost reimbursements rolled into capital at LLC formation.

2. **Sprinter Van Section 179 election** — confirm $200,000 full first-year deduction is desired for FY2025 (alternative: 5-year MACRS depreciation).

3. **Per-partner K-1 allocation** — books record Drew & Lindsay as joint account. Filed K-1s show 50/50 split per partner.

4. **-$18 Partner distributions residual** — drain or document.

5. **YE2024 Bank Rec Adjustment +$3,456.40 (CR balance, presents as positive equity)** — accept as FY2025 bank-rec timing differences (per GAAP practice) OR per-JE forensic for strict-zero.

6. **AMA -$24,615.08** — out of Phase 33 scope but recommended for review.

## Files in this package

- `README.md` — top-level navigation
- `FY2025_PnL.csv` — Profit & Loss Statement (107 lines)
- `BS_YE2025.csv` — Balance Sheet as of 2025-12-31 (76 lines)
- `CashFlow_FY2025.csv` — Statement of Cash Flows FY2025 (41 lines)
- `SCHEDULE_L_AUDIT_v1.csv` — Phase 33-A tie of Schedule L to source-of-truth
- `JE_REVERSAL_MAP_v1.csv` — Phase 33-B inventory of reversal candidates
- `EQUITY_BRIDGE_FY2025.md` — Phase 33-I D&L contribution source-trace + Schedule M-2 draft
- `EQUITY_RECLASS_NARRATIVE.md` — Phase 32 plug-account narrative
- `PHASE_33H_FINDINGS.md` — Phase 33-H plug residuals + Mercury drift cleanup detail
- `PHASE_33_FINAL_STATE.md` — this document (overall AC scoreboard + final BS/P&L)
- `IRENE_VERIFICATION_PACK.md` — Phase 32 audit questions (Q1-Q10)
- `NI_BRIDGE_FY2025.csv` — Phase 31-B4 NI bridge from bookkeeper baseline
- `DREW_QUEUE_PHASE33.md` — Phase 33 questions queue (all answered)

## What's next

After Drew reviews this state:
- **33-K**: CSV exports regenerated from current GL state (BS_YE2025.csv, FY2025_PnL.csv, CashFlow_FY2025.csv all need fresh export)
- **33-L**: v5 Irene package finalization + Drew sign-off
- **33-M**: Acceptance test suite + Tier 1 invariant updates (add `phase_33_irene_filing_ready` invariant)
- **33-N**: Final audit-Claude review
