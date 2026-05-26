# Current GL State (Living Document)

**As of:** 2026-05-26 22:05 UTC
**Source:** Live D1 query on production worker (`pretzel-os` database, UUID `950cc9e0-9dd2-4f78-af55-de6385ab293b`)
**Cadence:** Manually regenerated for now (auto-regen cadence TBD by Drew). See "Regeneration" section below.

> This is the **living source of truth** for current GL state. For historical Phase 33 close snapshot, see [`PHASE_33_AS_DOCUMENTED_AT_CLOSE.md`](../irene_package_FY2025/PHASE_33_AS_DOCUMENTED_AT_CLOSE.md).

---

## Plug account balances (post-Phase A Week 1 Task A1 drain)

All-time balances, posted JEs only. Migration 099 (2026-05-26) drained the three primary plugs.

| Account | Live balance | Target / expected | Status |
|---|---:|---:|---|
| Pre-Sync Adjustments | **$0.00** | $0 | ✅ at target |
| Pre-Pretzel-OS Reconciliation | **$0.00** | $0 | ✅ at target |
| YE2024 Bank Reconciliation Adjustment | **-$3,456.40** | -$3,456.40 (Phase 33 legitimate residual) | ✅ at target |
| Prior Period Adjustments — Plug Account Cleanup 2026-05 (NEW) | **+$141,866.96** | n/a — new account holding plug drain offsets | ℹ️ informational |
| Ask My Accountant | **-$14,001.83** | $0 (Phase 31-A2 partial drain) | 🟡 anomaly — see Phase A.0 §1d |

## Marketplace clearing balances

Live all-time balances (transit accounts):

| Account | Live balance | Steady-state target | Status vs threshold |
|---|---:|---:|---|
| Cash Clearing | $939,577.05 | $0 to $5K | 🔴 RED (bookkeeper-era residual; cleanup proposed per Phase A0 §2e) |
| Credit Card Clearing | $79,381.26 | -$3K to $3K | 🔴 RED |
| Doordash Clearing | $123,420.90 | -$1.5K to $1.5K | 🔴 RED |
| UberEats Clearing | $21,710.45 | -$300 to $300 | 🔴 RED |
| Grubhub Clearing | $6,838.30 | -$150 to $150 | 🔴 RED |
| Square Clearing | $123,162.42 | -$1K to $1.5K | 🔴 RED |
| Payroll Clearing | $41,737.84 | -$5K to $10K | 🔴 RED |
| LEAF Clearing | $0.00 | $0 | ✅ GREEN |

See [`MARKETPLACE_CLEARING_THRESHOLDS.md`](./MARKETPLACE_CLEARING_THRESHOLDS.md) for empirical basis. Cleanup proposed pending Drew approval.

## Balance Sheet check

**As-of today (all posted JEs through current date):**

| Section | Amount |
|---|---:|
| Total Assets | $569,588.49 |
| Total Liabilities | $136,577.39 |
| Total Equity | $506,267.78 |
| L + E | $642,845.17 |
| **Unbalanced by** | **$73,242.68** ⚠️ |

The "as-of-today" view above does NOT balance — but this is because revenue/expense for the current open period (FY2026) is not yet closed to RE. P&L flow is in flight.

**As-of FY2025 close (entry_date ≤ 2025-12-31), the locked filing-period BS DOES balance:**

| Section | Amount |
|---|---:|
| Total Assets | $690,781.02 |
| Total Liabilities | $162,646.28 |
| Total Equity | $528,134.74 |
| L + E | $690,781.02 |
| **Unbalanced by** | **$0.00** ✅ |

## Net Income year-to-date

| Period | Revenue | Expense | NI | Notes |
|---|---:|---:|---:|---|
| FY2025 (internal Path A) | $498,929.94 | $798,506.09 | **-$299,576.15** | Closed to RE at YE2025 via fiscal_year_close JEs |
| FY2025 (filing position v3 sent to Irene) | n/a | n/a | **-$346,898.53** | Layered on top of internal; depreciation + §179 + tips reclass not yet in GL |
| FY2026 YTD (live) | TBD | TBD | TBD (BS imbalance suggests ~-$73K through May 2026) | Open period |

## Last sync / reconciliation timestamps

| Source | Last sync | Status |
|---|---|---|
| Mercury (Checking + Savings) | within last 24h (daily `cfo_daily_close` 7am MT) | 🟢 |
| Mercury IO Credit (••0000) | Manual upload (no API) | 🟡 |
| Plaid Chase Ink | every 4h | 🟢 (pending Prod token verification) |
| QBO | hourly invoice sync | 🟢 |
| Square POS | real-time webhook | 🟢 |
| Square Customers | every 6h | 🟢 |
| Square Labor | daily 11:45pm MT | 🟢 |
| Toast POS | retired Mar 2026 | n/a |
| Last journal_entry posted | 2026-05-26 22:03 UTC (migration 099 plug drain) | 🟢 |

## Tier 1 integrity status

Last hourly Tier 1 run: see live `/finance/audit/tier/1` endpoint. As of 2026-05-26 22:05 UTC:
- 26 of 28 checks passing
- 1 warning (`socf_reconciles_within_tolerance` $36,845 — known residual from bookkeeper-era equity/loan reclasses; design-target $5K)
- 1 warning (`working_capital_categories_assigned` — 1 current_liability with balance but no wc_category)
- 0 corruption-tier failures (fixed via migration 098 earlier today)
- Read-only mode: OFF ✅

## Recent activity (last 7 days)

| Date | Source type | Count | Description |
|---|---|---:|---|
| 2026-05-26 | phase_a_plug_drain_2026_05 | 3 | Phase A Week 1 plug drain (this migration) |
| 2026-05-26 | (migration 098 reversal) | 1 | Reverse broken toast-payroll-2026-03-20 (Tier 1 fix) |
| 2026-05-21 | mercury_txn | 4 | Mercury sync ($363K activity) |
| 2026-05-21 | mercury_txn_paper_check | 1 | Mercury IO paper check $362 |
| 2026-05-20 | leaf_amortization_reconstruction | 64 | LEAF amort backfill |
| 2026-05-20 | toast_payroll_reconstruction | 62 | Toast payroll Pattern B reconstruction |
| 2026-05-20 | phase_30_dp_cash_leg | 40 | "Dangerous Pretze" cash leg backfill |

## Regeneration

This document is a **manual snapshot for now**. Drew will decide auto-regen cadence after Phase A Surfaces 1 (Activity Feed) and 5 (Integrity Monitor) are live. Likely candidates:

- Daily 7:30am MT alongside the morning brief
- After each cron-triggered Tier 1 run
- On-demand via dashboard "Refresh state snapshot" button

To regenerate manually:
```bash
# Run queries in this file's headers section against production D1
# Update timestamps in this file
# Commit + push
```

Future automation: a worker that produces this doc as a structured JSON snapshot + renders to markdown daily.

---

**Related documents:**
- [`PHASE_33_AS_DOCUMENTED_AT_CLOSE.md`](../irene_package_FY2025/PHASE_33_AS_DOCUMENTED_AT_CLOSE.md) — historical snapshot 2026-05-20
- [`MARKETPLACE_CLEARING_THRESHOLDS.md`](./MARKETPLACE_CLEARING_THRESHOLDS.md) — alert thresholds for Surface 5
- [`PHASE_A0_RECONCILIATION.md`](../irene_package_FY2025/PHASE_A0_RECONCILIATION.md) — Phase A.0 reconciliation findings
- [`PHASE_A_BUILD_PLAN.md`](../irene_package_FY2025/PHASE_A_BUILD_PLAN.md) — 13-section inventory + build plan
- [`PRETZEL_OS_FINANCE_STATE_MAY_2026.md`](../irene_package_FY2025/PRETZEL_OS_FINANCE_STATE_MAY_2026.md) — pre-Phase-A honest assessment
- [`RECOVERY_PROCEDURES.md`](./RECOVERY_PROCEDURES.md) — disaster recovery + D1 backup
