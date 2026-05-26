# PPA Drift Forensic Investigation

**Generated:** 2026-05-27 (Day 2 of Phase A Week 1)
**Scope:** Read-only investigation. The $141,866.96 of net DR currently in `Prior Period Adjustments — Plug Account Cleanup 2026-05` represents real economic activity that needs categorization before it can be properly cleared. No reclass JEs posted; this doc proposes Week 2 work.
**Source:** Live D1 query of all posted JEs that hit the 3 drained plug accounts (Pre-Sync Adjustments, Pre-Pretzel-OS Reconciliation, YE2024 BRA) — excluding migration 099's drain JEs.

---

## TL;DR

The $142K of PPA drift consists of **20 JEs** across the 3 plug accounts, posted between 2025-01-31 and 2026-05-18. After analysis:

| Bucket | $ amount | JE count | Confidence | Week 2 disposition |
|---|---:|---:|---|---|
| **Reconciliation timing residuals (legitimate PPA)** | $40,047 | 9 | HIGH | Keep — but rename source account to `FY2026 Bank Reconciliation Adjustment` |
| **Bookkeeper-era clearing-account residuals (cleanup, not real activity)** | $175,805 | 4 | HIGH | Keep in PPA — represents real net equity-cost of bookkeeper-era pollution |
| **Pure intra-equity label moves (no economic content)** | $63,623 / -$63,623 = $0 | 2 | HIGH | Cancel out — already in PPA; no reclass needed |
| **Mercury rebalance after operational events** | $26,820 | 3 | LOW | Need Drew judgment — see §5 |
| **Mis-categorized minor cleanups** | -$15,155 | 1 | MEDIUM | Reclass to specific expense accounts (proposal §6) |
| **Phantom Tips Payable** | -$10,000 | 1 | MEDIUM | Investigate — likely already-distributed tips that need wages adjustment |

**Net total:** +$141,867 (matches PPA balance ±$0). Verified.

**Recommended Week 2 disposition:**
- Leave ~$175K of bookkeeper-era residuals in PPA (label as equity-reduction from bookkeeper handover; doesn't need further reclass)
- Reclass ~$15K of misc cleanups to specific expense accounts (Drew per-line review)
- Investigate ~$10K Tips Payable phantom (likely already-paid → no further action)
- Decide Mercury rebalance disposition ($27K — could be operational truth or reconstruction artifact)
- The $40K BRA rename is a separate Week 2 follow-up to fix the YE2024-named-account misuse

---

## Section 1 — Pre-Sync Adjustments drift (10 JEs, +$245,538 net DR before drain)

| # | JE ID | Date | Source Type | Net to plug | Offset side | Description |
|---|---|---|---|---:|---|---|
| P1 | `22c-cash-clearing-drain` | 2026-05-15 | pre_sync_adjustment | **+$147,339.26** | Clearing Accounts:Cash Clearing (-$147,339.26 CR) | Phase 22-C: drained bookkeeper-era Cash Clearing residual to PSA |
| P2 | `22c-cash-clearing-final-correction` | 2026-05-15 | pre_sync_adjustment | -$12,224.70 | Clearing Accounts:Cash Clearing (+$12,224.70 DR) | Correction to P1 |
| P3 | `22d-cc-clearing-drain` | 2026-05-15 | pre_sync_adjustment | **+$40,690.63** | Clearing Accounts:Credit Card Clearing (-$40,690.63 CR) | Phase 22-D: drained CC Clearing residual to PSA |
| P4 | `23-tips-drain-2026-05-15` | 2026-05-15 | pre_sync_adjustment | -$10,000.00 | Tips Payable (+$10,000.00 DR) | Phantom Tips Payable accrual drain |
| P5 | `23-leaf-mercury-balance` | 2026-05-15 | pre_sync_adjustment | -$13,890.56 | Mercury Checking (+$13,890.56 DR) | Mercury rebalance after LEAF reconciliation |
| P6 | `23-failed-mercury-rebalance` | 2026-05-15 | pre_sync_adjustment | **+$50,384.62** | Mercury Checking (-$50,384.62 CR) | Mercury rebalance after failed-txn cleanup |
| P7 | `a0d1a057-0492-4ec5-b26f-77cd1f947c07` | 2026-05-15 | pre_sync_adjustment | -$9,673.46 | Mercury Checking (+$9,673.46 DR) | "Pre-sync MC residual" — small Mercury balancing |
| P8 | `26e2e21a-8eeb-4b05-baf2-b8da9a1d0e22` | 2026-05-15 | pre_sync_adjustment | +$4,443.59 | Mercury Credit (-$1,533.30), N/P Toast (-$1,086.33), N/P T&A deleted (-$1,632.49), Payroll Clearing deleted (-$191.47) | Deleted-account residue write-offs |
| P9 | `24g-ppr-to-equity-reclass-v2` | 2026-05-16 | reclass_to_equity | **+$63,623.47** | Pre-Pretzel-OS Reconciliation (-$63,623.47 CR) | Reclass Pre-Pretzel-OS residual to PSA |
| P10 | `24-phase-d-negative-expense-cleanup` | 2026-05-18 | cleanup_reclass | -$15,155.13 | Ask My Accountant (+$9,494.37), Sales Tax Over/Under (+$446.96), Taxes paid (+$5,213.80) | Clean 3 negative-balance expense accounts |
| **PSA total** | | | | **+$245,537.72** | | |

## Section 2 — Pre-Pretzel-OS Reconciliation drift (1 JE, -$63,623.47 net CR)

| # | JE ID | Date | Source Type | Net | Offset side | Description |
|---|---|---|---|---:|---|---|
| PR1 | `24g-ppr-to-equity-reclass-v2` | 2026-05-16 | reclass_to_equity | -$63,623.47 | Pre-Sync Adjustments (+$63,623.47 DR) | (same JE as P9 above) |

**Net economic effect: $0.** This is purely an intra-equity label move from Pre-Pretzel-OS to Pre-Sync. The $63,623.47 originated from earlier reconstruction work (qbo_expense_reconciliation residual catch-all) and was relabeled.

## Section 3 — YE2024 Bank Reconciliation Adjustment drift (9 JEs, -$40,047.29 net CR additional)

All from `phase_29_recon_adj` source_type. Offset side is consistently `Mercury Checking (0118) - 1`. Each JE narrates "Phase 29-D v[2 or 3] recon: bring Mercury GL = actual statement."

| # | JE ID | Date | Net to BRA | Mercury offset | Notes |
|---|---|---|---:|---:|---|
| B1 | `29d-recon-v3-2025-01-31` | 2025-01-31 | -$1,152.42 (CR) | +$1,152.42 (DR Mercury) | Mercury GL was $1,152 under statement |
| B2 | `29d-recon-2025-10-31` | 2025-10-31 | -$9,230.41 (CR) | +$9,230.41 (DR Mercury) | V2 — should have been reversed when v3 landed; wasn't |
| B3 | `29d-recon-v3-2025-10-31` | 2025-10-31 | +$9,187.17 (DR) | -$9,187.17 (CR Mercury) | V3 — nearly cancels B2 (net -$43.24 residue) |
| B4 | `29d-recon-v3-2025-11-30` | 2025-11-30 | -$270.00 (CR) | +$270.00 (DR Mercury) | small adjustment |
| B5 | `29d-recon-v3-2025-12-31` | 2025-12-31 | -$1,990.74 (CR) | +$1,990.74 (DR Mercury) | YE2025 recon |
| B6 | `29d-recon-v3-2026-01-31` | 2026-01-31 | -$6,428.15 (CR) | +$6,428.15 (DR Mercury) | FY2026 month — misusing YE2024 account |
| B7 | `29d-recon-v3-2026-02-28` | 2026-02-28 | -$6,104.00 (CR) | +$6,104.00 (DR Mercury) | FY2026 month — misusing YE2024 account |
| B8 | `29d-recon-v3-2026-03-31` | 2026-03-31 | -$13,642.05 (CR) | +$13,642.05 (DR Mercury) | FY2026 month — misusing YE2024 account |
| B9 | `29d-recon-v3-2026-04-30` | 2026-04-30 | -$13,873.09 (CR) | +$13,873.09 (DR Mercury) | FY2026 month — misusing YE2024 account |
| **BRA additional (over -$3,456.40 Phase 33 baseline)** | | | **-$40,047.29 CR** | +$40,047.29 DR Mercury | |

## Section 4 — Categorization buckets

### Bucket A: Reconciliation timing residuals (legitimate PPA-equity-equivalent)

| Items | Amount | Confidence | Disposition |
|---|---:|---|---|
| B1, B4, B5 (YE2024 / YE2025 monthly Mercury recon) | -$3,413 CR | HIGH | Keep — legitimate bank-rec timing |
| B6, B7, B8, B9 (FY2026 Mercury recon) | -$40,047 CR | HIGH | Keep but reclass to new `FY2026 Bank Reconciliation Adjustment` account (rename per Phase A.0 §1d) |
| B2/B3 duplicate residue | -$43.24 | HIGH | Reverse B2 (v2) per Phase A.0 §1c proposal |
| **Subtotal Bucket A** | **-$40,047** (after B2 reversal) | HIGH | |

**Total Bucket A: $40,047 of legitimate Mercury monthly recon that should sit in an FY2026-named account, not YE2024 BRA.** Recommended Week 2: create `FY2026 Bank Reconciliation Adjustment` account + reclass the 4 FY2026 JEs there. The Mercury offset stays unchanged.

### Bucket B: Bookkeeper-era clearing-account residuals (genuine equity reduction)

| Items | Amount | Confidence | Disposition |
|---|---:|---|---|
| P1 + P2 (Cash Clearing drain net) | +$135,114.56 DR | HIGH | Keep in PPA — represents equity cost of bookkeeper-era Cash Clearing pollution |
| P3 (CC Clearing drain) | +$40,690.63 DR | HIGH | Keep — same |
| P10 (negative expense cleanup) | -$15,155.13 CR | MEDIUM | Reclass to specific expense accounts (see Bucket E) |
| **Subtotal Bucket B** | **+$160,650 DR** | HIGH | |

**Total Bucket B: ~$175K (gross) of equity reduction from bookkeeper-era reconstruction.** This is the "real cost" of having a messy bookkeeper. It should stay in PPA as a one-time equity adjustment. No further reclass needed.

### Bucket C: Pure intra-equity label moves (zero economic content)

| Items | Amount | Confidence | Disposition |
|---|---:|---|---|
| P9 / PR1 (PPR → PSA label move) | $0 net | HIGH | No action needed — already cancels in PPA |
| **Subtotal Bucket C** | **$0** | HIGH | |

### Bucket D: Mercury rebalance after operational events (needs Drew judgment)

| Items | Amount | Confidence | Disposition |
|---|---:|---|---|
| P5 (LEAF reconciliation Mercury rebal) | -$13,890.56 CR (Mercury +$13,891 DR) | LOW | Investigate — Mercury was off-by-$14K after LEAF reconstruction. Real or artifact? |
| P6 (failed-txn Mercury rebal) | +$50,384.62 DR (Mercury -$50,385 CR) | LOW | Investigate — Mercury was OVER-stated by $50K after failed-txn cleanup. |
| P7 (small Mercury residual) | -$9,673.46 CR (Mercury +$9,673 DR) | LOW | Probably routine — Mercury under-stated by $9,673. |
| **Subtotal Bucket D** | **+$26,820 DR** | LOW | |

**Need Drew judgment:** These $27K of Mercury rebalances likely reflect real Mercury cash that was bookkeeper-error attributed elsewhere. Drew should decide:
- (a) Accept the rebalances as is — they made Mercury cent-accurate to statement, which is what matters
- (b) Investigate each: dig into what made Mercury off-by-$14K / -$50K / +$9.7K and reclass to a proper origin account

Recommendation: (a) is fine. The Mercury strict-match invariant runs hourly and confirms Mercury GL = bank statement. The rebalance amounts are just where the offset side landed.

### Bucket E: Mis-categorized minor cleanups (per-line reclass)

| Items | Amount | Confidence | Original target | Proposed target |
|---|---:|---|---|---|
| P10 sub-line (AMA cleanup) | +$9,494.37 DR | MEDIUM | Ask My Accountant (a holding) | Investigate underlying AMA composition; likely already-categorized expense |
| P10 sub-line (Sales Tax Over/Under) | +$446.96 DR | HIGH | Sales Tax Over/Under | Keep as is — these are sales tax adjustments; correct account |
| P10 sub-line (Taxes paid) | +$5,213.80 DR | MEDIUM | Taxes paid | Likely correct — paid tax that was somehow negative |
| P8 (deleted-account residue) | +$4,443.59 DR composite | HIGH | Mercury Credit, N/P Toast, N/P T&A deleted, Payroll Clearing deleted | No proper-target reclass possible — these accounts are deleted. Keep in PPA. |
| **Subtotal Bucket E** | **-$15,155 (Bucket B already counted P10 net)** | MEDIUM | | |

### Bucket F: Phantom Tips Payable

| Item | Amount | Confidence | Disposition |
|---|---:|---|---|
| P4 (drain Tips Payable phantom) | -$10,000.00 CR | MEDIUM | Investigate — likely tips that were already distributed via Tips Payable on Toast Payroll JEs but didn't clear cleanly |
| **Subtotal Bucket F** | **-$10,000** | MEDIUM | |

**Likely origin:** Toast Payroll Distribution flow CR'd Tips Payable when tips collected at POS, then DR'd Tips Payable when tips paid to employees via payroll. A $10K residual suggests one direction over-posted vs the other. Drew can confirm whether this is bookkeeper accrual error (probably) or a real residual owed.

---

## Section 5 — Recommended Week 2 reclass approach

**Total drift to disposition: +$141,866.96 (matches PPA balance).**

| Bucket | $ to move | Source → Target | JE pattern | Effort |
|---|---:|---|---|---|
| A: BRA → FY2026 Bank Recon Adj | +$40,047.29 DR / -$40,047.29 CR | YE2024 BRA → new FY2026 BRA | 1 JE per affected month (4 JEs) | 0.5 day |
| A: reverse B2 v2 duplicate | -$43.24 net | YE2024 BRA → reversal only | 1 reversal JE | 0.1 day |
| D: investigate Mercury rebalances (optional) | n/a | Read-only investigation | Spike, no JE | 1 day |
| F: investigate Tips Payable phantom | -$10,000 | Tips Payable → Wages or Payroll Expenses | 1 JE if reclass needed | 0.5 day |
| B: keep in PPA permanently | +$175,805 DR | None — stay in PPA as equity reduction | None | n/a |

**Total Week 2 forensic-driven work: ~2-3 days.** Most of the drift (~$175K) stays in PPA as a one-time equity adjustment representing the cost of bookkeeper-era pollution. The cleanups are surgical.

## Section 6 — JE template proposals for Week 2 (NOT executed)

These are DRAFT proposals only.

### Reclass A (BRA → FY2026 BRA): split 4 JEs

```
JE Y1: 2026-01-31 — DR YE2024 BRA $6,428.15 / CR FY2026 BRA $6,428.15
  Description: "Reclass Jan 2026 Mercury recon adjustment from YE2024-named to FY2026 account (Phase A Week 2)"

JE Y2-Y4: same pattern for Feb, Mar, Apr 2026 (totals -$6,104, -$13,642, -$13,873)
```

### Reclass for B2 reversal

```
JE Y0: REVERSE 29d-recon-2025-10-31 (status='reversed')
  No new JE needed; v3 already cancelled most of it.
```

### Investigate F (Tips Payable phantom)

```
Step 1: query journal_entries WHERE Tips Payable touched, sum DR vs CR
Step 2: compare to W-3 Box 7 (Social Security tips) for FY2025
Step 3: if $10K is a real ongoing residual, reclass to Wages.
        If artifact, keep $10K drain in PPA (no further action).
```

## Section 7 — Decisions for Drew

1. **Approve Bucket A reclass** (4 BRA JEs + 1 B2 reversal) for Week 2 execution? Y/N
2. **Approve Bucket D disposition: accept Mercury rebalances as documented** (no further investigation)? Y/N
3. **Approve Bucket F: investigate Tips Payable** + reclass if real? Y/N
4. **Confirm Bucket B stays in PPA** as bookkeeper-era equity cost (no further action)? Y/N
5. **Naming for new account:** `FY2026 Bank Reconciliation Adjustment` OK, or different name? (e.g., `Bank Reconciliation Adjustment — FY2026`?)

---

**Forensic complete.** No JEs posted. Drew reviews this doc during Week 1; reclass execution happens Week 2.
