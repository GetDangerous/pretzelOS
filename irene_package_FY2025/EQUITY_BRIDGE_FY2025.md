# Equity Bridge — YE2024 → YE2025

Per Drew's Phase 33 directive: source-trace D&L capital contributions from Mercury statements.
Filed 2024 1065 Schedule M-2 is IMMUTABLE for YE2024 starting capital.

## YE2024 starting capital (filed 2024 1065 Schedule M-2)

| Partner | Beginning capital 2024 | 2024 contributions | 2024 distributions | 2024 NI share | YE2024 ending capital |
|---|---:|---:|---:|---:|---:|
| Drew Sparks (50%) | $0 | $396,588 | $0 | -$99,781 | $296,807 |
| Lindsay Sparks (50%) | $0 | $396,588 | $0 | -$99,781 | $296,807 |
| **Total** | **$0** | **$793,176** | **$0** | **-$199,562** | **$593,615** |

Pretzel OS GL records `Partner investments:Drew and Lindsay` = $593,615 at YE2024 (joint per filed 1065 M-2; partner-level allocation per filed K-1s). ✓ Matches filed M-2 exactly.

## D&L cash contributions source-trace (Mercury statements)

Per Drew (Phase 33-H DEC5): "around $900k contributed in total or so + the sprinter van". Filed 1065 reports $793,176 for 2024 fiscal year. Cash inflows from Drew & Lindsay's Wells Fargo personal account (••6788) into Mercury Checking (••0118):

| Date | Amount | Mercury statement line |
|---|---:|---|
| 2023-08-10 | $20,000 | "Drew and Lindsay Wells · Transfer In · $20,000.00" |
| 2023-12-08 | $20,000 | "Drew and Lindsay Wells · Transfer In · $20,000.00" |
| 2023-12-12 | $100,000 | "Drew and Lindsay Wells · Transfer In · $100,000.00" |
| 2024-03-?? | $150,000 | "Drew and Lindsay Wells · Transfer In · $150,000.00" |
| 2024-05-08 | $180,000 | "Drew and Lindsay Wells · Transfer In · $180,000.00" |
| 2024-07-17 | $150,000 | "Drew and Lindsay Wells · Transfer In · $150,000.00" |
| 2024-10-?? | $150,000 | "Drew and Lindsay Wells · Transfer In · $150,000.00" |
| **Total through YE2024** | **$770,000** | |

**Variance vs filed**: $793,176 - $770,000 = **$23,176** of additional contributions per filed M-2 vs Mercury Checking trace. Possible sources:
- Pre-formation D&L direct payments (legal, accounting, organization costs) rolled into capital at LLC formation
- Mercury Savings inflows from D&L (not yet traced — but typical D&L pattern routes to Checking)
- Other personal D&L payments to vendors that bookkeeper credited to capital (e.g., Drew paid a vendor $X personally, bookkeeper recorded as DR Expense / CR D&L Capital)

**Recommendation**: Accept filed $793,176 as authoritative (signed by Irene). Document the $23K source-trace gap for Irene's review.

## FY2025 D&L contributions + adjustments

| Date | Source | $ | Type |
|---|---|---:|---|
| 2025-01-01 | qbo_je_ingest SLCBADJ | -$20,975 | Reclass investment to N/P D&L (per Drew 2/26/25; **reversed in Phase 24 — see equity reclass narrative**) |
| 2025-01-15 | partner_contribution `22f-sprinter-contribution-2025` | +$200,000 | Sprinter Van capital contribution (non-cash; 100% business use, $200K basis) |
| 2025-06-30 | qbo_je_ingest SLCB ADJ | +$1,632.49 | Adjustment to zero balance (bookkeeper note: "they have been paid back in full, he is not sure what this addit...") |
| 2025-09-23 | mercury_txn | +$40,000 | Transfer from D&L Wells Fargo ••6788 → Mercury Savings ••5450 |
| 2025-09-26 | mercury_txn | +$10,000 | Transfer from D&L Wells Fargo ••6788 → Mercury Checking ••0118 |
| **Total FY2025 contributions** | | **+$230,657.49** | |
| 2025-FY2025 | partner_distribution | -$18.00 | Minor adjustment (legacy from Phase 24 — investigate if Drew wants exactly $0) |
| **Net FY2025 equity change (excl. NI)** | | **+$230,639.49** | |

GL math: $593,615 (YE2024 starting capital) + $230,639.49 (FY2025 contributions net) - $1,614.49 (other minor) = $822,640 ✓ matches GL `Partner investments:Drew and Lindsay` YE2025 balance.

## Sprinter Van capital contribution detail (Jan 15 2025)

Per `22f-sprinter-contribution-2025` JE notes:
- Asset: Sprinter Van, contributed Jan 15 2025
- Basis: $200,000 (100% business use)
- Treatment: NOT a cash contribution. Sprinter contributed in-kind by Drew & Lindsay.
- Section 179 election: $200K full first-year expense per Form 4562 (Drew approved as 2025 election in Phase 33-D-pre prep).

JE structure:
- DR Vehicles (Fixed Asset) $200,000
- CR Partner investments:Drew and Lindsay $200,000

This adds $200K to D&L capital account at YE2025.

## NO distributions

Per Drew (Phase 33-H DEC3 + F3): **No partner distributions ever made.** The -$18 in `Partner distributions` is a Phase 24 legacy artifact that should be reversed for cleanliness. Cumulative distributions across all years = $0.

## YE2025 equity composition (post-Phase 33 cleanup)

| Account | YE2025 balance |
|---:|---:|
| Partner investments:Drew and Lindsay | $822,640.00 |
| Partner investments (generic) | $1,632.49 |
| Partner distributions | -$18.00 |
| Retained Earnings (FY2025 NI to be allocated by fiscal_year_close) | $0 (pre-close) |
| YE2024 Bank Reconciliation Adjustment | +$3,456.40 CR (presents as positive equity; legitimate bank-rec lag — see PHASE_33H_FINDINGS.md) |
| **Total equity YE2025** | **$820,798.09** |

After FY2025 fiscal_year_close JE (Phase 33-K to be executed): YE2025 equity = $820,798.09 - $X (FY2025 NI absorbed to RE).

## Schedule M-2 form for Irene (draft)

| | Amount |
|---|---:|
| **Beginning of year capital (YE2024 ending)** | **$593,615** |
| + Contributions during year (cash) | $50,000 (Sep 23 + 26 2025) |
| + Contributions during year (non-cash Sprinter Van) | $200,000 |
| + Net income (or loss) per books (FY2025) | (per Phase 33-K) |
| - Distributions | $0 |
| + Other adjustments (small Phase 24 residuals) | -$19,360.51 |
| **= End of year capital (YE2025 ending)** | **= per Phase 33-K** |

## What needs Drew + Irene review

1. **$23,176 source-trace gap** (filed $793,176 vs Mercury Checking traced $770,000 for 2023-2024). Likely pre-formation cost reimbursements or Mercury Savings inflows.
2. **Sprinter Van Section 179 election** — confirm $200K full first-year deduction is desired for FY2025 (alternative: 5-yr MACRS).
3. **-$18 distribution residual** — drain or document.
4. **YE2024 Bank Rec Adjustment +$3,456.40 CR (positive equity)** — accept as bank-rec timing OR per-JE forensic if strict-zero required.
5. **Per-partner allocation** — split D&L joint account into separate Drew + Lindsay capital accounts? Filed K-1s show 50/50 split. GL currently records as joint.
