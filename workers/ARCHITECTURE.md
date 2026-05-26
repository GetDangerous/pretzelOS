# Pretzel OS Finance — Architecture

Status: living document. Last major update May 13 2026 (RTR-1 / Session 8).

This is the contract for "where does every dollar value come from." When a
new feature is added, this doc must be updated. When a question arises about
"is this number right?", this doc is the first place to look.

---

## Source of truth — one canonical helper per metric

| Metric | Canonical helper | Source data | Notes |
|---|---|---|---|
| Cash on hand | `getCanonicalCashOnHand(env)` | `mercury_accounts.current_balance` | 5-min TTL with inline refresh. Returns `{ total, breakdown, as_of, age_seconds }`. |
| Weekly burn | `getCanonicalWeeklyBurn(env)` | `journal_entry_lines` (expense + cogs + other_expense, last 30d) + Mercury outflows fallback | Max of GL burn and Mercury outflows × 0.7, then ÷ 4.3 to weekly. |
| Runway | `getCanonicalRunway(env)` | cash / weekly_burn | Display string handles infinity / critical / negative. |
| Revenue (last N days) | `getCanonicalWeeklyRevenue(env, daysBack)` | `orders.gross_revenue` (paid-state filter) + `catering_orders` | Channels: retail, wholesale, catering, marketplace. Total = retail + wholesale + catering (marketplace separate). |
| Revenue (date range) | `getOrdersRevenueForPeriod(env, start, end)` | Same as above, but [start,end] bounds | **RTR-2: used by monthly-pl, trends, monthly-close.** |
| Trust score | `getTrustScore(env)` | 6 component checks weighted | data_freshness, ledger_integrity, categorization, sync_health, cost_budget, decision_quality |

**Registry:** `workers/finance-canonical-truth.js` re-exports + documents these. New canonical metrics MUST be added to the `CANONICAL` map and have a cross-consumer probe.

**DIF-4 enforcement:** `tests/deprecation.test.sh` greps for direct
`mercury_accounts.current_balance` SUMs outside the canonical helper.

---

## Revenue Truth Reset (RTR) — the May 13 fix

### The problem (pre-RTR)

Revenue display read from `journal_entry_lines` filtered by `account_type='revenue'`. Those JEs are written by the daily sweep (Clearing → Revenue). **Sweep date ≠ sale date.**

Symptom: March 2026 showed $0 revenue in the closed monthly brief because the sweep hadn't run for March's clearing balance when monthly-close fired on April 1. Late sweeps on April 30 dumped both March's residual AND April's clearing → April showed $79K (real activity ~$50K).

### The fix (RTR-2, shipped Session 8)

| Consumer | Pre-RTR source | Post-RTR source |
|---|---|---|
| `getMonthlyPL` (single + quad) | `journal_entry_lines` SUM by `account_type='revenue'` | `getOrdersRevenueForPeriod` — orders + catering_orders + paid-state filter |
| `getTrends` per-month revenue | `journal_entry_lines` GROUP BY month | `getOrdersRevenueForPeriod` per month |
| `runMonthlyClose` `computeProfitAndLoss` | `journal_entry_lines` SUM by `account_type='revenue'` | `getOrdersRevenueForPeriod` |

**COGS + expense + other_income + other_expense remain GL-sourced.** Sweep timing doesn't affect these — the JE date IS the expense date.

The brief now records BOTH:
- `totals.revenue` (canonical, orders-based)
- `totals.gl_revenue` (audit, what the GL says)
- `totals.gl_orders_drift` (the difference)

If drift > 5% the brief surfaces a warning. Tier 5 acceptance can replay any month against external references (QBO archive).

### Recompute-safe close (RTR-3)

`POST /finance/cfo/monthly-close/:period/recompute?write=false`

- Always computes a fresh brief from current data
- Compares to stored brief
- Surfaces revenue + net income deltas
- `?write=true` overwrites the stored brief (with audit log entry)
- Without `write=true`, stored brief remains audit-of-record

This handles the case where the stored brief is stale (e.g., March 2026 frozen at $0): Drew (or chat) calls recompute to see actual numbers, decides whether to overwrite.

### Still pending (RTR-4 → RTR-8)

| Phase | What | When |
|---|---|---|
| RTR-4 | Atomic period boundary — 5-day grace period + data-completeness gates before close | Session 12 |
| RTR-5 | Post-close late-txn handling — adjustments buffer + Drew decides reopen vs carry-forward | Session 12 |
| RTR-6 | POS-direct revenue recognition — `Dr AR / Cr Sales` at order webhook time, not sweep | Session 13 |
| RTR-7 | Backfill canonical revenue table for Nov 2025 → present | Session 14 |
| RTR-8 | Strengthen Tier 5 — three-way (orders ≈ GL ≈ QBO archive) | Session 14 |

---

## What flows through what — dependency graph

```
Mercury API ──────► mercury_accounts.current_balance ─────► getCanonicalCashOnHand
                    mercury_transactions             ─────► getCanonicalWeeklyBurn (fallback)
                                                            categorizer → journal_entries

Square API  ──────► orders (source='square*')         ─────► getCanonicalWeeklyRevenue
                                                            getOrdersRevenueForPeriod

QBO API     ──────► orders (source='qbo_*')           ─────► getCanonicalWeeklyRevenue
                    qbo_archive_entity (historical)   ─────► vendor_kb / Tier 5 acceptance

Plaid API   ──────► chase_cc_transactions             ─────► (categorizer pipeline, GL JEs)

Square Labor─────► square_shifts                     ─────► labor productivity, payroll forecast

Anthropic   ──────► ai_calls (cost tracking)         ─────► trust score, budget endpoints
                                                            ALL calls flow through callAI() in ai-budget.js
```

---

## Cross-consumer agreement (DIF-2, Tier 1)

Every hour, Tier 1 audit runs two cross-consumer checks:

- **`cash_consumers_agree`** — canonical cash must equal scorecard cash within $0.01. Fail → trips FINANCE_READ_ONLY.
- **`revenue_consumers_agree_30d`** — 4× weekly revenue ≈ 30d revenue (60% tolerance, smoke test only). Returns WARN not FAIL.

Adding a new consumer of a canonical metric? Add it to `CROSS_CONSUMER_PROBES` in `workers/finance-canonical-truth.js` so this check verifies agreement.

---

## What the GL is for

The GL (journal_entries + journal_entry_lines) is the accounting record:
- Balanced (debits = credits) — Tier 1 invariant
- Audit trail (every JE has a `source_type` and `source_id`)
- Tax / bookkeeper-facing (matches QBO archive within tolerance)

The GL is NOT canonical for revenue **display** — its timing is determined by sweep cadence. It IS canonical for:
- COGS (expense JE dated to actual expense date)
- Operating expense (same)
- Balance sheet (asset/liability/equity by `entry_date`)
- Net income (revenue per orders, expense per GL, computed via formula)

---

## Phase 21V — Bookkeeper-truth expense GL reconciliation (May 15, 2026)

GL now matches QBO bookkeeper P&L truth cent-accurate for FY2025:
- Revenue: $522,889.89 (from `orders` via Phase 20D + Toast SalesSummary + Square raw_payload)
- COGS: $118,384.82 (from QBO P&L truth reconciliation)
- Operating Expense: $460,971.33 (categorizer + Mercury Credit purchases + QBO JE accruals + recon adjustments)
- Other Income: $5,913.33
- Other Expense: $7,948.38
- **Net Income: -$58,501.31** (operating loss; matches QBO bookkeeper P&L)

Balance Sheet balances cent-accurate at:
- 2024-12-31 ✓
- 2025-06-30 ✓
- 2025-12-31 ✓
- Q1 2026 has documented $26,028 imbalance from Mercury IO post-bookkeeper gap

### GL ingestion sources

| Source | What it provides | Path |
|---|---|---|
| `qbo_pnl_reconstruction` | Monthly bookkeeper-truth revenue + COGS + expense per `qbo_pnl_truth` | `workers/finance-gl-reconstruction.js` |
| `qbo_expense_reconciliation` | Adjustment JEs trueing GL to QBO P&L per account per month | `workers/finance-expense-reconstruction.js` |
| `qbo_mercury_credit_ingest` | Mercury IO Credit card purchases from QBO Purchase records | `workers/finance-mercury-credit-ingest.js` |
| `qbo_je_ingest` | Bookkeeper manual accruals/reclassifications from QBO JournalEntry records | `workers/finance-qbo-je-ingest.js` |
| `mercury_txn` | Categorizer-posted Mercury Checking transactions | `workers/finance-cfo-categorizer.js` |
| `qbo_opening_balance_seed` | YE2024 opening balance JE | `workers/finance-opening-balance-seed.js` |

### QBO JE ingest filters

`workers/finance-qbo-je-ingest.js` skips QBO JEs that would double-count with Phase 20D revenue reconstruction:
- DocNumber patterns: `Sales (DD-MM-YYYY)`, `TipsAdj`, `Income Adjustment`, `SLCB GH/UE/DD Adjust`
- Any JE touching a revenue/income/other_income account (covered by monthly P&L total)

JEs that touch only expense/liability/equity/asset accounts are posted (181 → 64 after revenue-touch filter for FY2025).

### Known forward gap

Mercury IO Credit card transactions are not exposed by Mercury's `/accounts` API endpoint. The bookkeeper entered them manually into QBO from IO statements. After mid-Feb 2026 (bookkeeper fired), Mercury Credit purchases stop landing in our books, but pay-down JEs continue via the categorizer. Result: ~$26K balance sheet imbalance for 2026 periods.

**Resolution path (deferred)**: manual IO statement upload (similar to Chase Plaid pattern) OR Mercury IO API access if available with elevated token scope.

### Pre-Pretzel-OS Reconciliation account

A current liability that absorbs the delta between QBO bookkeeper P&L truth and our categorizer-built GL. After all ingestion phases, this account holds the residual gap (~$0 to ~$50K depending on period — represents timing reclassifications + small unmatched accruals). Drains as more raw data sources land.

### Phase 21V audit findings

- Mercury Credit (Mercury IO card, account ••0000) was active throughout FY2025
- 371 Mercury Credit Purchase records ($90,925.80) ingested from QBO archive
- 3 duplicate Mercury txn pairs identified + reversed (IO AUTOPAY + MERCURY INITIATED PAYMENT for same payment, both being categorized as DR Mercury Credit)
- 64 bookkeeper manual JEs ingested (payroll accruals, vendor bill accruals, partner equity reclassifications)

---

## Deprecated / dormant

| Path | Status | Notes |
|---|---|---|
| `financial_directives.cash_on_hand` column | Dormant (Phase 2 reset, Apr 30 2026) | Writes removed. Zero live reads. Tier 1 `directive_cash_not_written` watches for regression. |
| `cfo_briefs.content` as live source | Treated as snapshot/audit only | `getMonthlyPL` now consults BOTH the brief and live recompute. |
| Hardcoded `claude-sonnet-*` / `claude-haiku-*` model ids outside ai-budget.js | Deprecated (DIF-3) | KV-driven via `resolveModelId`. `tests/deprecation.test.sh` blocks deploy if added. |
| Direct `fetch('https://api.anthropic.com')` outside ai-budget.js | Deprecated (DIF-3) | Must go through `callAI()`. 4 documented exceptions in `tests/deprecation.allowlist`. |

---

## Session 28-B — Source-type whitelist for cash events (May 19, 2026)

The Statement of Cash Flows (SOCF) decomposes activity into operating / investing
/ financing sections. The "direct cash" components (capex, equity contributions,
loan principal payments) must ONLY count JEs that represent REAL movement at the
bank — otherwise bookkeeper-era reconstruction artifacts pollute cash flow.

**`CASH_SOURCE_TYPES` whitelist** (defined in `workers/finance-statements-cash-flow.js`):
- `'mercury_txn'` — Mercury bank transactions (the only real cash source today)
- Future: `'plaid_chase_txn'`, `'plaid_bank_txn'` when Plaid Production wires up

**Non-cash source types** (intentionally excluded from cash items):
- `mercury_io_statement_txn`, `chase_ink_statement_txn` — CC charges; cash leg
  happens when Mercury pays the CC statement (captured separately via mercury_txn)
- `qbo_je_ingest` — bookkeeper-era PPE JEs; real cash legs already in mercury_txn
- `qbo_pnl_reconstruction`, `qbo_expense_reconciliation` — bookkeeper P&L truth
- `qbo_payment_wholesale_reconstruction` — wholesale recon (touches Cash Clearing)
- `toast_sales_summary_reconstruction`, `square_pos_reconstruction` — POS recon
- `monthly_depreciation`, `monthly_amortization`, `sec179_depreciation`,
  `depreciation_backfill` — non-cash by definition
- `partner_contribution` — non-cash partner asset contribution (e.g., Sprinter)
- `qbo_opening_balance_seed` — YE2024 OB (no cash event)
- `fiscal_year_close` — Year-end close to RE
- `pre_sync_adjustment`, `reclass_to_equity`, `sales_tax_reclass`, `cogs_reclass`,
  `channel_fees_reclass_v1`, `cash_drawer_reclass`, `cleanup_reclass`,
  `bookkeeper_tips_tax_accrual` — non-cash reclasses/accruals

### Why whitelist (not blacklist)

A new bookkeeper-era source_type added in the future will NOT leak into capex/
equity/loan calcs. Blacklist is fragile — round-2 of feedback specifically called
out the Bridge BLOQ Section 110 reclass (fiscal_year_close source) leaking into
capex via blacklist gaps.

### Where whitelist applies

| SOCF helper | Whitelist applied | Why |
|---|---|---|
| `capexAdditions` | ✅ Yes (Session 28-B) | Real capex = real cash purchases via Mercury |
| `equityChanges` (contrib + distrib) | ✅ Yes (Session 28-B) | Real owner equity events = Mercury cash IN/OUT |
| `loanPrincipalChange` | ✅ Yes (Session 28-B) | Real loan principal = Mercury cash OUT to LEAF |
| `wcChange` (AR, AP, Sales Tax, Tips, Gift Card, Payroll Payable) | ❌ No — intentional | WC adjustments bridge accrual NI to cash. They MUST include all balance changes (including non-cash accruals) to convert NI properly. |
| `netIncome` | Excludes `fiscal_year_close` only | NI is accrual-based; close JE inverts P&L lines so excluded |
| `depreciationExpense` (add-back) | Excludes `fiscal_year_close` only | D&A is non-cash by structure regardless of source |

### Tier 1 invariants protecting this

- `socf_uses_whitelist_for_cash_items` — verifies CASH_SOURCE_TYPES exists and includes 'mercury_txn'; probes FY2025 capex equals documented mercury_txn-only value ($12,338.93)
- `socf_reconciles_within_tolerance` — verifies FY2025 SOCF net_change ≈ actual_cash_change within tolerance. Currently warn-only at $150K reflecting known unmatched txn gap (see below). After Phase 28-C cleanup → FAIL at $5K.

### Known FY2025 SOCF gap — 40 unmatched "Dangerous Pretze..." Mercury txns

After whitelist refactor, FY2025 SOCF still has ~$134K unreconciled. Root cause:
**40 real Mercury Checking outflows with counterparty "Dangerous Pretze..."
($118,330.78 total) have NO journal entries** — `matched_journal_entry_id IS NULL`
on all 40 in `mercury_transactions` table.

These are real bank events that affected actual_cash_change but contribute $0 to
mercury_txn-sourced JEs. Phase 28-C will categorize these (likely Owner
Distributions or internal transfers) and post proper JEs, which should close the
reconciliation gap to within $5K.

---

## Maintenance commitment

When adding new code that reads or writes financial state:

1. **Use a canonical helper** if one exists. Don't roll your own SUM.
2. **If a new metric is needed**, add it to `workers/finance-canonical-truth.js` AND add a cross-consumer probe.
3. **Add an acceptance test** in `tests/acceptance.test.sh`.
4. **Add a contract test** if touching an external API (DIF-5, Session 11).
5. **Update this file** with the new metric + helper.
6. **For new Anthropic calls**, use `callAI()` from `ai-budget.js`. Hardcoded model ids are blocked by `tests/deprecation.test.sh`.

Drift detection happens automatically:
- Tier 1 hourly cross-consumer check fails if two consumers disagree
- Pre-deploy gate (acceptance + deprecation) blocks bad code
- Tier 5 monthly acceptance replays against external truth (QBO)
- Trust score makes "what's degrading right now?" visible to Drew

If the system stops working in 6 months, this doc tells whoever picks it up
exactly where each dollar comes from. That's the antidote to drift.
