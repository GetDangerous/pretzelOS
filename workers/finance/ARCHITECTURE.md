# Pretzel OS Finance — Architecture

Last reviewed: Apr 30, 2026 (post-reset).

## How money flows

```
Mercury API (live, source of truth for cash)
    │
    ▼
┌────────────────────────────────────────────────────────────────────┐
│  mercury_accounts (cached balances, refreshed:                     │
│    • daily by cfo_daily_close cron                                 │
│    • inline-on-read by getCanonicalCashOnHand if cache > 5min)     │
│  mercury_transactions (paginated sync, daily by cron)              │
└────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────────────┐
│  Categorizer (workers/finance-cfo-categorizer.js)                  │
│  - Rule-based fast path (~85% hit rate on Pretzel data)            │
│  - Haiku fallback for long-tail counterparties                     │
│  Output: proposed_account_id + proposed_confidence on the txn      │
└────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────────────┐
│  JE Poster (workers/finance-je-poster.js)                          │
│  - Auto-posts at confidence ≥ 0.90                                 │
│  - Below threshold → review queue (Drew's judgment)                │
│  - Direction: inflow = Dr Mercury / Cr Clearing                    │
│             outflow = Dr Expense / Cr Mercury                      │
│  - Bypassed by user-initiated review-queue paths                   │
└────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌────────────────────────────────────────────────────────────────────┐
│  journal_entries / journal_entry_lines (the GL)                    │
│  - Double-entry, balanced (Tier 1 invariants enforce)              │
│  - Source types: mercury_txn, revenue_sweep, opening_balance,      │
│    monthly_close (depreciation), capitalize, loan_payment          │
└────────────────────────────────────────────────────────────────────┘
    │
    ▼ (Toast/Square/marketplace inflows that landed in Clearing)
┌────────────────────────────────────────────────────────────────────┐
│  Revenue Sweep (workers/finance-revenue-sweep.js)                  │
│  Daily: Clearing:Toast → Sales:Food Income:Dine-In, etc.           │
│  Posts a SECOND JE per inflow — that's why total_volume inflates.  │
│  Use source_volume (excludes revenue_sweep) for honest counts.     │
└────────────────────────────────────────────────────────────────────┘
```

## Source of truth — single answer per metric

| Metric | Source | Helper |
|---|---|---|
| Cash on hand | `mercury_accounts.current_balance` (5-min TTL refresh-on-read) | `getCanonicalCashOnHand` |
| Weekly revenue (operational) | `orders` + `catering_orders` (paid-state filtered) | `getCanonicalWeeklyRevenue` |
| Weekly burn | GL expense JEs (with Mercury fallback when GL is sparse) | `getCanonicalWeeklyBurn` |
| Runway | cash / weekly burn | `getCanonicalRunway` |
| Book Mercury balance | sum of GL JEs to Mercury accounts | direct SQL |
| 30-day forecast | `cash_flow_forecast` table (rebuilt daily) | `getForecast` |

**Rule:** every dashboard, email, audit, brief reads from the helper. NEVER from `financial_directives.cash_on_hand` (column is vestigial; no longer written by cfo-agent).

## Audit framework (post-reset)

```
Tier 1 — corruption (hourly cron 0:05)
  ├─ dr_eq_cr_per_je
  ├─ dr_eq_cr_ledger
  ├─ no_orphan_je_lines
  ├─ no_invalid_account_id
  ├─ reconciled_has_matched_je
  ├─ no_duplicate_mercury_txns
  ├─ at_most_one_opening_balance
  ├─ no_post_in_closed_period
  ├─ fixed_asset_nbv_consistency
  ├─ no_dual_dr_cr_line
  └─ directive_cash_not_written        ← regression detector
  → ANY fail = TRIPS FINANCE_READ_ONLY

Tier 2 — state/drift (daily cron 14:30 UTC, post daily-close)
  ├─ mercury_live_vs_book              ← OB-pending (warn until OB loads)
  ├─ clearing_near_zero
  ├─ mercury_balance_freshness
  ├─ mercury_txn_freshness
  ├─ last_je_posted_age
  ├─ daily_close_last_success
  └─ cron_lag
  → INFORMATIONAL — never trips read-only

Tier 5 — acceptance replay (manual, per-month)
  Compare ledger totals to QBO archive references.
  Establishes "expected gap" while OB pending + review queue not empty.

Injection tests — manual (every deploy)
  Verify schema constraints, KV reachability, model id validity, sweep coverage.
```

## What's expected to drift (and why it's not corruption)

1. **`mercury_live_vs_book` ≠ 0**: until opening balance loads, the book has no historical Mercury starting balance. Live cash will be off by ~$100K. Closes when Irene signs OB.
2. **Tier 5 expense gaps 20-90%**: 130+ Mercury txns sit in review queue at < 0.90 confidence. Drew's judgment unblocks them. Closes when queue is processed.
3. **`total_volume` ~40% inflated**: revenue_sweep posts a second JE per Mercury inflow. Use `source_volume` instead.
4. **Sep 2025 revenue -56%**: unexplained gap — likely Mercury sync coverage issue. Revisit when investigating historical data.

## Read-only mode semantics

`KV.FINANCE_READ_ONLY = '1'` blocks:
- `postJeBatch` (auto-posting from categorizer)
- `runRevenueSweep` (clearing → revenue)
- `capitalize` (capex)
- `runMonthlyDepreciation`
- `commitOpeningBalance`
- `processLoanPayments`

It does NOT block:
- `mercurySyncAccounts` / `mercurySyncTransactions` (always safe to read)
- `categorizeBatch` (just labels, doesn't post)
- `runDailyRecon` (it's the trip mechanism)
- Review-queue user paths: `approveTxn`, `bulkApproveCounterparty`, etc. (they bypass via `opts.bypass_read_only`)

Trips on:
- Tier 1 corruption check failure
- Daily-recon variance > $50 for 2 consecutive days (legacy — Phase 3 reset disabled this)
- Manual override

Cleared by:
- POST `/finance/cfo/read-only -d {active: false, reason}`

## Cron schedule (finance-relevant)

See `finance-cron-schedule.md`.
