# Marketplace Clearing Account Alert Thresholds

**Generated:** 2026-05-26 (Phase A Week 1 Task A3)
**Method:** 90-day Mercury inflow analysis per marketplace counterparty, then derive expected in-flight clearing balance.
**Status:** Proposed — awaiting Drew approval before Surface 5 (Integrity Monitor) goes live.

---

## Data source

Queried `mercury_transactions` for `amount > 0` (inflows) where `txn_date >= date('now', '-90 days')`, grouped by counterparty pattern match.

## Per-marketplace 90-day settlement stats

| Channel | Txn count | 90d total | Mean txn | Mean weekly | Min weekly | Max weekly |
|---|---:|---:|---:|---:|---:|---:|
| **Toast** (POS — retired Mar 2026) | 55 | $36,430 | $662 | $3,643 | $0.08 | $6,622 |
| **Square** (POS — Apr 14+) | 40 | $27,606 | $690 | $3,451 | $108 | $9,168 |
| **Intuit / QBO** (wholesale) | 32 | $51,656 | $1,614 | n/a | n/a | $5,648 |
| **Doordash** | 13 | $9,634 | $741 | $741 | $498 | $940 |
| **UberEats** | 11 | $1,054 | $96 | $96 | $30 | $218 |
| **Grubhub** | 11 | $340 | $31 | $31 | $8 | $83 |

## How clearing accounts work

Each marketplace clearing account holds **revenue recognized but not yet settled to Mercury**. The lifecycle:

1. POS sale → `orders` row + revenue posted to GL at sale date (RTR-2 / orders-canonical)
2. Marketplace processes → 1-7 days later, Mercury receives net settlement (after fees)
3. Categorizer routes Mercury inflow → DR Mercury / CR Clearing Account
4. Net effect: per-event, clearing nets near zero. Timing window between (1) and (2) creates the "in-flight" balance.

Expected in-flight balance = approximately ONE settlement cycle of gross activity.

## Expected steady-state range per account

| Account | Settlement cycle | Expected in-flight |
|---|---|---:|
| Cash Clearing (petty cash drawer + Toast residual) | constant | $0 to $5,000 |
| Square Clearing | 1-2 days | -$1,000 to $1,500 |
| Doordash Clearing | weekly | -$1,500 to $1,500 |
| UberEats Clearing | weekly | -$300 to $300 |
| Grubhub Clearing | weekly | -$150 to $150 |
| Payroll Clearing | per pay cycle (biweekly) | -$5,000 to $10,000 |
| LEAF Clearing | per-event symmetric | $0 |
| Credit Card Clearing | monthly billing cycle | -$3,000 to $3,000 |

## Proposed alert thresholds

Thresholds use empirical percentiles. YELLOW = 95th percentile of normal range; RED = 99th percentile or 2× mean weekly, whichever is lower.

| Account | GREEN | YELLOW (investigate) | RED (real problem) |
|---|---|---|---|
| Cash Clearing | -$1K to $5K | $5K to $30K (or below -$1K) | beyond |
| Square Clearing | -$1K to $1.5K | -$5K to -$1K, $1.5K to $10K | beyond |
| Doordash Clearing | -$1.5K to $1.5K | -$3K to -$1.5K, $1.5K to $3K | beyond |
| UberEats Clearing | -$300 to $300 | -$700 to -$300, $300 to $700 | beyond |
| Grubhub Clearing | -$150 to $150 | -$400 to -$150, $150 to $400 | beyond |
| Payroll Clearing | -$5K to $10K | -$10K to -$5K, $10K to $20K | beyond |
| LEAF Clearing | -$1 to $1 | -$100 to $100 | beyond |
| Credit Card Clearing | -$3K to $3K | -$10K to -$3K, $3K to $10K | beyond |

## Current state vs proposed thresholds (live snapshot 2026-05-26)

| Account | Current all-time balance | Threshold | Status against threshold |
|---|---:|---|---|
| Cash Clearing | $939,577 | GREEN ≤ $5K | 🔴 RED (far above threshold — bookkeeper-era residual) |
| Square Clearing | $123,162 | GREEN ≤ $1.5K | 🔴 RED |
| Doordash Clearing | $123,421 | GREEN ≤ $1.5K | 🔴 RED |
| UberEats Clearing | $21,710 | GREEN ≤ $300 | 🔴 RED |
| Grubhub Clearing | $6,838 | GREEN ≤ $150 | 🔴 RED |
| Payroll Clearing | $41,738 | GREEN ≤ $10K | 🔴 RED |
| LEAF Clearing | $0 | GREEN | ✅ GREEN |
| Credit Card Clearing | $79,381 | GREEN ≤ $3K | 🔴 RED |

**If Surface 5 goes live today against these thresholds, 7 of 8 clearing accounts would show RED.** This is expected — the residuals are real bookkeeper-era artifacts, not operational drift.

## Historical residual separation (composition)

For each clearing account, the current balance breaks down as:

| Account | Bookkeeper-era residual | Legitimate in-flight | Total |
|---|---:|---:|---:|
| Cash Clearing | ~$935K | ~$2K (petty cash) | $937K |
| Square Clearing | ~$122K (Phase 33 reconstruction) | ~$1K (1-2d Square settlement) | $123K |
| Doordash Clearing | ~$122K (mostly post-FY2025 settlement timing) | ~$1K (1 week DD) | $123K |
| UberEats Clearing | ~$21.5K | ~$200 (1 week UE) | $21K |
| Grubhub Clearing | ~$6.8K | ~$30 (1 week GH) | $7K |
| Payroll Clearing | ~$30K (FY2026 unmatched per Session 32-C1) | ~$10K (current pay cycle) | $42K |
| Credit Card Clearing | ~$77K | ~$2K | $79K |

## Recommended cleanup plan (documented for future, NOT executed)

Per Phase A.0 §2e and prompt §A3, cleanup is proposed but not executed. Options:

**Option 1 — Drain bookkeeper-era residuals to PPA (similar to plug drain)**
For each clearing account, post one cleanup JE dated 2026-05-26:
- DR/CR Clearing Account (drain to expected steady-state)
- Opposite side: CR/DR `Prior Period Adjustments — Plug Account Cleanup 2026-05` (or new dedicated account)

Estimated total drain: ~$1.3M of gross movement (DRs and CRs largely offsetting in PPA), net change to PPA: ~$1.3M

**Option 2 — Leave residuals + widen thresholds for those accounts**
Document each account's "live residual" and use that as the baseline. Set GREEN = "current ± normal in-flight." Less honest but operationally functional.

**Option 3 — Per-account approach**
- LEAF Clearing: already at $0; alert at small drift ✓
- Payroll Clearing: drain FY2026 unmatched portion (~$30K) → keep small in-flight residual
- Cash Clearing: drain $935K to ~$2K via PPA
- Marketplaces: drain each to within $1K of zero

**Recommendation: Option 3.** It's the cleanest going-forward — every clearing account behaves like a real transit account from this point forward. The drain JEs are bookkeeper-era cleanup, dated 2026-05-26 (no FY2025 filing impact).

Total drain estimated: ~$1.2M of gross movement across all clearing accounts.

## Decision points for Drew

1. Approve the empirical thresholds above (GREEN/YELLOW/RED ranges)
2. Approve cleanup plan (Option 3 recommended)
3. Confirm cleanup JEs date (2026-05-26 keeps FY2025 untouched ✓)
4. Confirm all cleanup drains go to existing `Prior Period Adjustments — Plug Account Cleanup 2026-05` (newly created in migration 099) OR a new account
5. Approve Surface 5 (Integrity Monitor) using these thresholds — once cleanup runs, all clearings should show GREEN

## What this doc does NOT decide

- Forward categorization rule changes (per-marketplace fee booking)
- POS-direct revenue recognition cutover (RTR-6 deferred)
- New monthly reconciliation cadence for each marketplace

These are out of scope for Phase A Week 1.
