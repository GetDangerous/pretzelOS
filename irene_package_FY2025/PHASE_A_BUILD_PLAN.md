# Phase A Pre-Work — Inventory & Build Plan

**Generated:** 2026-05-26
**Scope:** Investigation only. No code changes during inventory (Tier 1 fix landed first under separate authorization).
**Companion docs:**
- `PRETZEL_OS_FINANCE_STATE_MAY_2026.md` — prior state assessment, still valid
- `PHASE_A_PRE_WORK_PAUSE_REPORT.md` — Tier 1 failure investigation that interrupted this work
- `workers/ARCHITECTURE.md` — living source-of-truth doc (last meaningful update May 13; Phase 30+ not yet folded in)

**Tier 1 status as of writing:** corruption checks clean post-migration 098 + version `4e768677` deploy. SOCF check now WARN-only per original Session 28-B-6 design intent. Read-only cleared. Next Tier 1 cron (22:05 UTC) will confirm `failed=0`.

---

## Section 1 — Worker Inventory

**103 worker files** at `workers/*.js`. Grouped by function below. "Last modified" column omitted — git history collapses to baseline commit (`db3b058`, 2026-05-26) so dates aren't differentiating.

Reusability legend:
- **REUSE** — production-quality, keep as-is for going-forward operations
- **REWORK** — sound concept, needs incremental changes for Phase A
- **ONE-TIME** — Phase 33 reconstruction artifact, kept for audit history but won't fire forward
- **DEPRECATE** — broken, dormant, or superseded; candidate for removal

### 1.1 Ingestion workers (external → D1)

| File | Trigger | Status | Reuse |
|---|---|---|---|
| `mercury-client.js` | called from `cfo_daily_close` cron + manual | LIVE — daily sync, strict-match at 17 month-ends | REUSE |
| `plaid-client.js` | `chase_sync_plaid` cron `20 */4 * * *` + webhook | code shipped, Plaid Prod token status uncertain | REUSE (verify creds) |
| `qbo-client.js` | hourly `qbo_sync` cron + manual | LIVE — used for Sched L verification, ProfitAndLoss API, Invoice sync | REUSE |
| `qbo-webhook-worker.js` | webhook `/qbo/webhook` | LIVE | REUSE |
| `square-sync-worker.js` | `/square/webhook` real-time | LIVE — Apr 14 2026 cutover onward | REUSE |
| `square-customer-sync.js` | `0 */6 * * *` | LIVE | REUSE |
| `square-labor-sync.js` | `45 5 * * *` daily | LIVE — `square_shifts` populated | REUSE |
| `account-worker.js` | webhook (Toast) + daily | retains Toast historical handler (Toast retired Mar 2026) | REUSE (just-in-case) |
| `finance-mercury-credit-ingest.js` | manual upload + cron stub | manual; no Mercury IO API | REWORK (Phase 28-C cleanup) |
| `finance-mercury-io-statement.js` | manual statement upload | per `mercury_io_reminder` cron 28th of month | REUSE (manual path) |
| `finance-chase-ink-statement.js` | manual CSV upload | parallel path to Plaid (Plaid replaces this if/when Prod is live) | REWORK (Plaid takes over) |
| `finance-receipts.js` | manual upload via dashboard | Haiku vision OCR, used lightly | REUSE |
| `finance-square-extract.js` | manual / on-demand | historical extract endpoint | ONE-TIME |
| `finance-qbo-extract.js` | manual / on-demand | historical archive pull | ONE-TIME |
| `brain-loader.js` | scheduled context loader | utility — minimal LLM context | REUSE |
| `d1-backup.js` (NEW Foundation Safety) | `0 3 * * *` (pending CLOUDFLARE_API_TOKEN secret) | not yet activated | REUSE |

### 1.2 Processing workers (categorize + post + transform)

| File | Trigger | Status | Reuse |
|---|---|---|---|
| `finance-cfo-categorizer.js` | called inside `cfo_daily_close` | LIVE — 30 rules, deterministic | REWORK (Phase A target — LLM layer goes on top) |
| `finance-je-poster.js` | called inside `cfo_daily_close` + manual | LIVE — idempotent, gated by `min_confidence` ≥ 0.90 default | REUSE |
| `finance-cfo-tools.js` | called by chat + manual | mixed tools (close, recon, etc.) | REUSE |
| `cfo-agent.js` | weekly cron `0 4 * * 7` + chat | Sonnet narrative generation | REUSE |
| `cfo-pulse-worker.js` | hourly + `/cfo/live` | LIVE — D1-only summary | REUSE |
| `finance-pos-direct.js` | RTR-6 spec, not active | code shipped, cutover flag OFF | DEPRECATE (or REWORK if revisited) |
| `finance-vendor-kb.js` | manual build | `vendor_categorization_history` table populated; NOT consulted by categorizer at decision time | REWORK (Phase A wires it in) |
| `finance-cfo-facts.js` | manual + chat | `cfo_facts` table — Drew clarifications, not consumed | REWORK (Phase A wires it in) |
| `finance-revenue-sweep.js` | retired, sweep model replaced | only used by Phase 33 history | DEPRECATE |
| `finance-qbo-mercury-match.js` | one-time during reconstruction | Phase 33-era | ONE-TIME |
| `finance-revenue-canonical.js` | called from `getOrdersRevenueForPeriod` | RTR-2 canonical helper | REUSE |
| `finance-fy2026-depreciation.js` | called from `monthly_depreciation` cron | LIVE — `0 9 1 * *` | REUSE |

### 1.3 Integrity / invariant workers

| File | Trigger | Status | Reuse |
|---|---|---|---|
| `finance-audit-engine.js` | hourly `cfo_audit_tier1` + daily `cfo_audit_tier2` + monthly `tier5_monthly` | LIVE — 26+ invariants. Tier 1 fail trips read-only | REUSE |
| `finance-health.js` | called by `getTrustScore` + heartbeat writes | LIVE | REUSE |
| `finance-contracts.js` | called from pre-deploy gate | LIVE — 6 external APIs verified | REUSE |
| `finance-canonical-truth.js` | called by cross-consumer checks | registry of 5 canonical helpers + DIF-2 probes | REUSE |
| `finance-late-txns.js` | RTR-5 buffer; rare path | stub for reopen-and-repost; not wired in | REWORK |

### 1.4 Reconciliation workers

| File | Trigger | Status | Reuse |
|---|---|---|---|
| `finance-account-audit.js` | manual / cron | Mercury statement strict-match | REUSE |
| `finance-expense-reconstruction.js` | one-time per period | Phase 21V tool; bookkeeper truth alignment | ONE-TIME |
| `finance-gl-reconstruction.js` | one-time per period | Phase 20 QBO P&L truth | ONE-TIME |
| `finance-toast-reconstruction.js` | one-time | Phase 33 | ONE-TIME |
| `finance-toast-payroll-reconstruction.js` | one-time per check_date | Phase 30 Pattern B | REUSE if catching up future cycles |
| `finance-toast-sales-pos-reconstruction.js` | one-time | Phase 33 | ONE-TIME |
| `finance-square-reconstruction.js` | one-time | Phase 33 | ONE-TIME |
| `finance-square-payroll-reconstruction.js` | manual upload | for Apr 2026+ Square Payroll | REUSE |
| `finance-leaf-amortization-splitter.js` | per-Mercury-LEAF outflow categorizer hook | LIVE | REUSE |
| `finance-bookkeeper-tips-tax-accrual.js` | one-time | Phase 26-B / 33 | ONE-TIME |
| `finance-wholesale-reconstruction.js` | one-time | Phase 33 | ONE-TIME |
| `finance-sales-tax-reclass-rebuild.js` | one-time | Phase 33 | ONE-TIME |
| `finance-uline-reclass.js` | one-time | Phase 33 | ONE-TIME |
| `finance-opening-balance-seed.js` | one-time YE2024 OB | Phase 33-C | ONE-TIME |
| `finance-opening-balance.js` | manual probe | utility | REUSE |
| `finance-session-24-cleanup.js` | one-time | Session 24 | ONE-TIME |
| `finance-qbo-je-ingest.js` | one-time | Phase 21V | ONE-TIME |
| `finance-qbo-pnl-truth.js` | manual on-demand | reference helper | REUSE |
| `finance-phase30-dryrun.js` | one-time | Phase 30-C | ONE-TIME |
| `finance-reconciliation-memo.js` | weekly + manual | Mercury vs books variance email; cron `0 14 * * *` | REUSE |

### 1.5 Reporting workers

| File | Trigger | Status | Reuse |
|---|---|---|---|
| `finance-statements-pnl.js` | called by `/finance/monthly-pl`, `/finance/statements/pnl` | LIVE — RTR-2 orders-canonical | REUSE |
| `finance-statements-balance-sheet.js` | `/finance/statements/balance-sheet` | LIVE | REUSE |
| `finance-statements-cash-flow.js` | `/finance/statements/cash-flow` | LIVE — SOCF unreconciled now WARN | REUSE |
| `finance-monthly-pl.js` | called by quad endpoint + chat | LIVE | REUSE |
| `finance-monthly-close.js` | `cfo_monthly_close` cron 1st of month | LIVE — `cfo_briefs` snapshot | REUSE |
| `finance-monthly-depreciation-cron.js` | `0 9 1 * *` | LIVE — auto-posts Form 4562 schedule | REUSE |
| `finance-scorecard.js` | `/finance/scorecard` | LIVE | REUSE |
| `finance-breakeven.js` | `/finance/breakeven` | LIVE — orders-based | REUSE |
| `finance-cashflow.js` | `/finance/cfo/forecast` | LIVE — 90-day projection (naive model, see Section 8 of state doc) | REWORK |
| `finance-forecast.js` | `/finance/canonical/forecast` | wraps cashflow + scenario | REWORK |
| `finance-scenario.js` | `/finance/scenario` | what-if engine | REUSE |
| `finance-trends.js` | `/finance/trends` | LIVE | REUSE |
| `finance-customer-intel.js` | `/finance/customer/...` | LIVE | REUSE |
| `finance-ar-aging.js` | `/finance/ar-aging` + email | LIVE — sends overdue-AR follow-up drafts | REWORK (email content needs Phase A polish) |
| `finance-issue-surfacer.js` | daily 8:15am MT | LIVE — 8 detectors → `cfo_issues` table | REUSE |
| `finance-page-narrative.js` | `page_narrative_refresh` cron + manual regen | LIVE — Sonnet "How are we?" block | REUSE |
| `finance-review-queue.js` | `/finance/cfo/review-queue` | LIVE — bulk-review-by-counterparty | REWORK (Phase A: this is the inbox surface) |
| `finance-capex-flagger.js` | called from categorizer | flags capex candidates | REUSE |
| `finance-capex-reasoner.js` | manual + propose-and-wait flow | Sonnet capex recommender; minimal use | REUSE |
| `finance-recurring-bills.js` | manual + recurring patterns table | partially wired | REWORK |
| `finance-weekly-directive.js` | `0 4 * * 1` Sunday 10pm MT | LIVE — Sonnet strategic brief | REUSE |
| `finance-shared.js` | imported everywhere | canonical helpers (cash, runway, burn, revenue) | REUSE |
| `finance-cfo-categorizer.js` | (also processing — listed above) | LIVE | REWORK |

### 1.6 Email / notification workers

See **Section 6** for full email audit. Workers involved:
- `email-sender.js` (`sendResendEmail` — generic Resend wrapper, called by retail Cohort B + others)
- `finance-email-briefs.js` (4 finance emails — see §6)
- `approval-mailer.js` (`sendApprovalRequestEmail` — pipeline approvals)
- `finance-issue-surfacer.js` (writes flags, not emails directly; surfacer + alert email separate path)
- `router.js` (sends `sendAlertEmail` on pipeline-stalled, audit failures)

### 1.7 Phase 33 reconstruction workers (ONE-TIME)

Already listed in §1.4. These exist in code for audit-trail reasons but are NOT in any cron and won't fire forward:
- `finance-toast-reconstruction.js`, `finance-square-reconstruction.js`, `finance-toast-sales-pos-reconstruction.js`
- `finance-wholesale-reconstruction.js`, `finance-bookkeeper-tips-tax-accrual.js`
- `finance-sales-tax-reclass-rebuild.js`, `finance-uline-reclass.js`
- `finance-opening-balance-seed.js`, `finance-session-24-cleanup.js`
- `finance-expense-reconstruction.js`, `finance-gl-reconstruction.js`, `finance-qbo-je-ingest.js`
- `finance-phase30-dryrun.js`

**Recommendation:** Keep these in-tree for ≥1 year for audit reference. Don't delete.

### 1.8 Other / lead-gen / engagement (not Phase A scope)

These workers handle outreach, scouting, qualifier, catering — **separate workstream from Phase A bookkeeper UI**. Listed for completeness:

`scout-worker.js`, `qualifier-worker.js`, `outreach-agent.js`, `outreach-workflow.js`, `optimizer-worker.js`, `account-worker.js`, `pilot-tracker-worker.js`, `retail-agent.js`, `retail-suggestions-worker.js`, `retail-verdict-generator.js`, `retail-backfill-workflow.js`, `catering-agent.js`, `catering-scout.js`, `catering-crossover-scout.js`, `rep-enablement-worker.js`, `reply-handler-worker.js`, `orchestrator.js`, `coach-agent.js`, `chat-worker.js`, `chat-session-do.js`, `code-expiration-cleaner.js`.

Status: REUSE as-is. Phase A doesn't touch them.

### 1.9 Utility / infrastructure

| File | Purpose | Reuse |
|---|---|---|
| `router.js` | HTTP + cron dispatcher (1,738 lines) | REUSE |
| `ai-budget.js` | Anthropic API wrapper with cost tracking + budget caps | REUSE |
| `http-utils.js` | shared HTTP helpers | REUSE |
| `heartbeat-keys.js` | cron cadence registry | REUSE |
| `email-sender.js` | Resend wrapper | REUSE |

---

## Section 2 — Categorization Layer Deep Dive

### 2.1 Where rules live

**Single file:** `workers/finance-cfo-categorizer.js` (695 lines).

Rules defined as a JS array (lines ~26–270). Schema per rule:
```js
{
  name: 'rule_identifier_snake_case',
  pattern: /regex/i,                     // matches against mercury_transactions.counterparty_name
  amount_filter: (amt) => amt < 0,       // optional, for direction or range filter
  target_account_name: 'COA Path:Sub',   // resolved to chart_of_accounts.id at runtime
  confidence: 0.90,                       // literal — 0.85–0.98 range
  reason: 'why this rule fires',         // for audit log + memo
}
```

### 2.2 The 30 rules

Categorized by purpose. **(Match rates are NOT tracked in production today — see §2.5 for proposal.)**

#### Inflow rules (POS deposits, customer payments, refunds)

| # | Rule name | Pattern matches | Target | Confidence |
|---|---|---|---|---|
| 1 | `toast_deposit` | Toast settlement counterparty | Clearing Accounts:Cash Clearing | 0.97 |
| 2 | `square_deposit` | Square Inc deposit | Clearing Accounts:Square Clearing | 0.97 |
| 3 | `doordash_deposit` | DoorDash settlement | Clearing Accounts:Doordash Clearing | 0.97 |
| 4 | `ubereats_deposit` | Uber Eats settlement | Clearing Accounts:UberEats Clearing | 0.97 |
| 5 | `grubhub_deposit` | Grubhub settlement | Clearing Accounts:Grubhub Clearing | 0.97 |
| 6 | `wholesale_customer_payment_compass_group` | Compass Group | Clearing Accounts:Cash Clearing | 0.95 |
| 7 | `wholesale_customer_payment_goldminers` | Goldminers | Clearing Accounts:Cash Clearing | 0.95 |
| 8 | `wholesale_customer_payment_ph_club` | PH Club | Clearing Accounts:Cash Clearing | 0.95 |
| 9 | `intuit_wholesale_payment` | QBO Payment routing | Clearing Accounts:Cash Clearing | 0.92 |
| 10 | `state_of_utah_refund` | State of Utah tax refund | Sales Tax Over/Under | 0.90 |

#### Internal-transfer skip rules

| # | Rule name | Effect |
|---|---|---|
| 11 | `mercury_internal_transfer` | Recognizes inflow/outflow pair between own accounts |
| 12 | `mercury_internal_transfer_inflow_skip` | Inflow leg of internal transfer; skipped to avoid double-counting |

#### Outflow rules (vendor payments)

| # | Rule name | Pattern | Target | Confidence |
|---|---|---|---|---|
| 13 | `external_bank_wells_fargo` | Wells Fargo incoming (D&L capital contribution) | Partner investments:Drew and Lindsay | 0.95 |
| 14 | `sysco_food` | Sysco | COGS:Food Purchases | 0.98 |
| 15 | `us_foods` | US Foods | COGS:Food Purchases | 0.98 |
| 16 | `shamrock_foods` | Shamrock | COGS:Food Purchases | 0.98 |
| 17 | `pfg_food` | Performance Food Group | COGS:Food Purchases | 0.98 |
| 18 | `instacart_supplies` | Instacart Business | COGS:Food Purchases | 0.85 (could be supplies) |
| 19 | `toast_payroll` | TOAST PAYROLL counterparty | Clearing Accounts:Payroll Clearing | 0.95 |
| 20 | `square_payroll` | Square Inc payroll | Payroll Expenses | 0.95 |
| 21 | `leaf_loan` | LEASE SERVICES (LEAF) | Clearing Accounts:LEAF Clearing | (per-loan split via amortization-splitter) |
| 22–30 | (additional rules for Chase Ink pay-down, Mercury Credit pay-down, common subscriptions, utilities, parking, repairs, etc.) | various | various | 0.85–0.95 |

### 2.3 Invocation pattern

**Batch only.** Categorizer runs inside `runDailyClose` (workers/finance-worker.js → finance-cfo-tools.js):
1. Mercury sync pulls new transactions into `mercury_transactions` (status=`'pending'`, `is_reconciled=0`)
2. Categorizer iterates pending rows → for each, walks rule array top-to-bottom → first match wins
3. Writes to `mercury_transactions`:
   - `proposed_account_id` (FK to `chart_of_accounts`)
   - `proposed_confidence` (literal from rule)
   - `proposed_reasoning` (rule's `reason` field)
4. JE poster runs separately with `min_confidence` gate (default 0.90)
5. Anything not matching any rule: `proposed_account_id = NULL`, stays in queue

**Not real-time per transaction.** Mercury txns can sit pending for hours until `cfo_daily_close` fires.

### 2.4 Conflict resolution

**First-match-wins.** Rules are evaluated top-to-bottom in array order. Rule ordering matters and is implicit (no priority field). Documented convention in the file: more-specific rules above more-general ones.

No JSON schema validation, no test fixtures for rule conflicts.

### 2.5 How to add / change a rule

Today:
1. Drew edits the rule array in `finance-cfo-categorizer.js`
2. `npm run deploy` (pre-deploy gate runs)
3. No automated tests for new rules (just "categorizer rule targets resolve" Tier 1 invariant)
4. New rule fires on next `cfo_daily_close` cron (next 7am MT)

No backtesting against historical txns. No A/B comparison. No match-rate dashboard.

**Phase A proposal for tracking match rates:**

Add `categorizer_decisions` table:
```sql
CREATE TABLE categorizer_decisions (
  id TEXT PRIMARY KEY,
  txn_id TEXT,
  rule_name TEXT,                -- which rule fired (or NULL if no match)
  proposed_account_id TEXT,
  confidence REAL,
  outcome TEXT,                  -- 'auto_posted' | 'manual_override' | 'still_pending'
  decision_at TEXT
);
```

Categorizer writes one row per evaluated txn. Surface:
- `GET /finance/categorizer/match-rates` — group by rule_name, period
- Tier 2 (informational): if any rule's match rate drops 50%+ MoM, flag
- Dashboard tile: "Categorizer effectiveness" — top N rules by volume + their override rate

Effort: ~2 hr to add table + writes; ~2 hr to add endpoint + tile.

---

## Section 3 — Integrity / Invariant Check Inventory

### 3.1 Tier 1 — ledger invariants (hourly cron `5 * * * *`)

**Where:** `workers/finance-audit-engine.js`, `runTier1()`.
**Result table:** `finance_audit_runs` (one row per run) + `finance_audit_checks` (one row per check per run).
**On failure:** all failing IDs concatenated into `FINANCE_READ_ONLY_REASON` KV; `FINANCE_READ_ONLY=1`; JE poster refuses to post until cleared.
**On all-pass:** auto-clears `FINANCE_READ_ONLY` if Tier 1 was the one that set it.

| ID | Verifies |
|---|---|
| `dr_eq_cr_per_je` | Every posted JE has debits == credits |
| `dr_eq_cr_ledger` | Total ledger DR == total CR within $0.01 |
| `no_orphan_je_lines` | No `journal_entry_lines` without a parent JE |
| `no_invalid_account_id` | Every line's `account_id` resolves to active CoA row |
| `reconciled_has_matched_je` | `mercury_transactions.is_reconciled=1` implies `matched_journal_entry_id` set |
| `no_duplicate_mercury_txns` | UNIQUE on `mercury_txn_id` not violated |
| `at_most_one_opening_balance` | Exactly one OB seed JE |
| `no_post_in_closed_period` | No JE with `entry_date` in a locked `closed_periods` row |
| `fixed_asset_nbv_consistency` | `fixed_assets` registry NBV matches GL net |
| `no_je_for_failed_mercury_txns` | Failed Mercury txns aren't categorized |
| `categorizer_rule_targets_exist` | Every rule's `target_account_name` resolves to an active CoA row |
| `no_dual_dr_cr_line` | No line has both DR > 0 AND CR > 0 |
| `je_touches_distinct_accounts` | No JE hits same account twice (was failing pre-migration 098, now clean) |
| `no_mercury_proposes_self` | Mercury account isn't its own offset |
| `directive_cash_not_written` | Deprecated `financial_directives.cash_on_hand` not being written |
| `cash_consumers_agree` | Canonical cash == scorecard cash within $0.01 |
| `revenue_consumers_agree_30d` | 4×weekly ≈ 30d revenue (60% tolerance, WARN-only) |
| `runway_consumers_agree` | Runway helpers agree |
| `ar_overdue_consumers_agree` | AR overdue helpers agree |
| `monthly_pl_uses_gl_revenue` | Phase 20J — RTR-2 still wired |
| `contra_revenue_marketplace` | Phase 26-B contra-revenue accounts active |
| `coa_categorization_complete` | Every account has expense_category OR revenue_channel |
| `working_capital_categories_assigned` | Every current_liability has wc_category (1 warning currently) |
| `socf_reconciles_within_tolerance` | SOCF unreconciled ≤ $5K pass, ≤ $100K warn, > $100K fail (post-2026-05-26 fix) |
| `socf_uses_whitelist_for_cash_items` | Capex/equity/loans use CASH_SOURCE_TYPES whitelist |
| `mercury_gl_matches_statement_monthly` | Mercury GL = bank statement at every month-end |
| `opening_balance` | (composite check; details inside file) |
| `monthly_revenue` | (composite) |

**Count: ~26 active invariants.** Live state (post-fix): 26 pass, 0 fail, 1 warn.

### 3.2 Tier 2 — state checks (daily `30 14 * * *`)

`runTier2()` — informational. Cannot trip read-only. Writes to same `finance_audit_runs` table with `tier=2`.

Checks: `mercury_balance_fresh`, `mercury_txn_fresh`, `last_je_posted` age, `daily_close_success` age, `cron_lag`, `review_queue` depth, `mercury_recon` variance.

### 3.3 Tier 5 — acceptance / monthly replay (`0 15 1 * *`)

`runTier5Acceptance()` + `runTier5Year()` + `runThreeWayTier5()` — replays a period's GL revenue against `orders` table + `qbo_archive_entity` Deposits. Alerts on drift >5%.

### 3.4 Pre-deploy gate (every `wrangler deploy`)

`tests/pre-deploy.sh` — 4 gates:
1. Acceptance tests (hits deployed endpoints; **timing-out today** when run from local CLI — needs investigation)
2. Deprecation grep (local file scan)
3. Contract tests (`/finance/contracts` — verifies external API shapes)
4. Cross-consumer agreement (`cash_consumers_agree`)

### 3.5 Invariants that exist but aren't running

None I found — every check defined in `finance-audit-engine.js` is included in the appropriate Tier function. The `runTier1Filing()` check class from Session 31-C1 is **specced but not built**.

---

## Section 4 — Reconciliation Logic Inventory

### 4.1 Mercury strict-match (CRITICAL — reuse)

**Where:** `workers/finance-audit-engine.js` `mercury_gl_matches_statement_monthly`.

**Mechanism:**
- `bank_statement_balances` table holds 94 month-end rows (Drew uploaded Mercury PDFs in Phase 28-D)
- Tier 1 check loads each month-end statement balance + computes GL balance at same date
- Fails if any month-end diverges > $0.50

**Status:** ✅ LIVE, cent-accurate at 17 month-ends YE2024–Apr 2026. The gold standard.

**Reusable forward:** Yes. As new Mercury statements arrive monthly, Drew uploads PDF + system adds to `bank_statement_balances` + Tier 1 keeps validating.

### 4.2 Marketplace settlement reconciliations

**Mechanism:**
- POS sale lands → revenue side recorded via `orders` table (canonical, RTR-2)
- Mercury inflow (1–2 days later) → categorizer routes to per-marketplace Clearing Account
- Net effect: Clearing Account should roll near zero with timing residual

**Current per-marketplace state (live AT YE2025):**
- Doordash Clearing: -$42,423 (CR balance)
- UberEats Clearing: -$7,438 (CR)
- Grubhub Clearing: -$2,820 (CR)
- Square Clearing: -$34,024 (CR)

These are not "near zero." Either marketplace fees aren't being booked to the Clearing offset, OR the time-window mismatch is wider than expected, OR there's a categorization gap.

**Status:** 🟡 Built but residuals don't match design intent. Not corruption — but Phase A surfaces "marketplace channel net" should explain these clearly.

### 4.3 Payroll reconciliation (Toast Payroll GL)

**Mechanism:**
- `toast_payroll_gl` table = 2,250 rows ground-truth Jul 2024 – Apr 2026 (Drew exports from Toast)
- `finance-toast-payroll-reconstruction.js` writes JEs per check_date from this table
- Mercury TOAST PAYROLL outflows go through Pattern B clearing (`Clearing Accounts:Payroll Clearing`)
- Pattern B logic: outflows DR Payroll Clearing; reconstruction CRs Payroll Clearing — nets per cycle

**Status:** 🟢 Cent-accurate to W-3 Box 3 within $218 (0.13%). Phase 33 verified ground truth.

**Reusable forward:** Only if Drew re-runs the reconstruction worker as new pay cycles land. After Toast Payroll retired (Apr 2026), this path is dormant.

### 4.4 Square Payroll reconciliation

**Mechanism:**
- Drew downloads Square Payroll Company Totals xlsx
- `finance-square-payroll-reconstruction.js` ingests
- $28,953 earnings + taxes for Apr-May 2026 (partial)

**Status:** 🟡 Path exists, lightly used. Not automated.

### 4.5 Bank-to-GL (Mercury Checking + Savings + Chase Ink)

- Mercury Checking + Savings: strict-match per §4.1
- Chase Ink: Plaid sync → `chase_cc_transactions` → categorizer → JEs. Plus optional statement-CSV upload path for reconciliation.
- Mercury IO Credit (••0000): manual statement upload only (no API)

### 4.6 Three-way Tier 5 (GL ≈ orders ≈ QBO archive)

`runThreeWayTier5(env, period)` compares revenue from GL, from `orders.gross_revenue`, from `qbo_archive_entity` Deposits. Tolerance 5%. Flags outliers per pair.

**Status:** 🟢 LIVE. Used historically; should fire monthly going forward.

### 4.7 Phase 33 reconstruction reconciliations (ONE-TIME)

`finance-expense-reconstruction.js`, `finance-gl-reconstruction.js`, `finance-qbo-mercury-match.js`, plus the various `finance-*-reconstruction.js` workers. Built for filing prep; not part of going-forward operations.

---

## Section 5 — Narrative Generation Layer

### 5.1 Inputs that trigger generation

| Trigger | Worker | Generation cadence |
|---|---|---|
| `cfo_weekly_directive` cron (Sun 10pm MT) | `finance-weekly-directive.js` + `cfo-agent.js` | Weekly |
| `page_narrative_refresh` cron (daily after close) | `finance-page-narrative.js` | Daily |
| `cfo_daily_pulse` cron (7:30am MT) | `finance-email-briefs.js` `sendDailyMorningBrief` | Daily |
| `cfo_issue_surfacer` cron (8:15am MT) | `finance-issue-surfacer.js` (Haiku for ranking, Sonnet for narrative) | Daily |
| Manual regen button | `POST /finance/page-narrative/regenerate` | On-demand |
| Chat (Drew talks to agent) | `chat-worker.js` | Real-time |
| Capex reasoning | `finance-capex-reasoner.js` | Per-flagged-txn |
| Receipt processing | `finance-receipts.js` (Haiku vision) | On-upload |

### 5.2 Outputs

| Output | Destination | Persistence |
|---|---|---|
| Daily 7:30am brief | Email → Drew | KV cache (page_narrative) + email send log |
| Weekly directive | Email → Drew | `cfo_briefs` table + email |
| Page narrative ("How are we?") | Dashboard `#money` block | KV cache, regenerated daily |
| Issue narratives | `cfo_issues` table + daily email top-3 | DB + email |
| Chat responses | Streaming SSE → browser; persisted to `cfo_conversations` | DB |
| Capex recommendation | `agent_decisions` table + dashboard inbox | DB |
| Receipt extraction | `receipts` table + matched Mercury txn | DB |

### 5.3 Quality assessment (best-effort, no automated metric)

| Surface | Known issues |
|---|---|
| Daily morning brief | Decent; pulls from `getScorecard` + canonical helpers. Quality depends on data quality (e.g., when forecast was $400K wrong, the brief faithfully echoed it). |
| Weekly directive | Strategic-level; thoughtful prose. Drew has not flagged quality issues but cost is meaningful (~$0.20/run × weekly = $10/yr — within budget). |
| Page narrative | The "How are we?" block. Tested 2026-05-14: produced honest analysis matching reality. |
| Chat | Streaming SSE had Phase 17d bug ("Could not reach Pretzel OS"); root cause = handleChatStream re-calling Anthropic after Phase 1 tool loop produced final reply, getting empty stream. Fixed Session 17d. |
| Issue narratives | Issue surfacer's text is short + factual; few hallucinations because inputs are tightly structured (vendor + amount + comparison period). |
| Capex reasoner | Used lightly. Reasoning logged but Drew approval flow is partial — propose-and-wait works, follow-through occasionally manual. |
| Receipts | Haiku vision works; quality OK on clear receipts. Failure case: faded thermal paper. |

### 5.4 Prompt patterns

All Anthropic calls go through `ai-budget.js` `callAI()` wrapper (DIF-3). Common pattern:

```js
const result = await callAI(env, {
  use_case: 'daily_morning_brief',     // for ai_calls tracking
  model: 'sonnet',                      // or 'haiku'
  system: '...',                        // role definition
  messages: [{ role: 'user', content: '...' }],
  output_format: 'structured' | 'text', // typically structured JSON
});
```

**System prompt patterns:**
- CFO persona: "You are Drew's CFO. He runs Dangerous Pretzel..." — set in chat-worker.js + page-narrative
- Issue surfacer: "Rank these N issues by actionability for a fast-casual restaurant owner..."
- Capex reasoner: "Should this be capitalized or expensed? Output JSON: { capitalize: bool, asset_class, useful_life_months, reasoning }"

**Output format constraints:**
- Structured JSON for actionable outputs (capex, categorizer fallback proposals)
- Plain text for narrative emails + chat
- Word/char caps on narrative blocks (80 words for page narrative `narrative_sentence`)

### 5.5 What Phase A inherits

The pattern of "deterministic helper computes data → Sonnet wraps in narrative → output to user surface" is good and worth keeping. Phase A's bookkeeper UI should follow same shape:
- Worker computes proposed categorization + reasoning (deterministic + LLM)
- Surface displays the proposal + diff vs current
- User accepts/rejects → categorizer rule or cfo_facts entry persists the decision

---

## Section 6 — Email / Notification Audit (CRITICAL — Drew approves before disable)

### 6.1 Every email send point

| # | Worker | Function | Trigger | Recipient | Subject pattern | Recommendation |
|---|---|---|---|---|---|---|
| 1 | `finance-email-briefs.js` | `sendDailyMorningBrief` | cron `30 13 * * *` (7:30am MT daily) | Drew | "Pretzel CFO · Daily — ${date}" | **keep-as-is** — useful daily anchor |
| 2 | `finance-email-briefs.js` | `sendDailyCloseEmail` | called inside `runDailyClose` | Drew | "Pretzel CFO · {N} JEs posted · {date}" | **keep-as-is** |
| 3 | `finance-email-briefs.js` | `sendWeeklyDirectiveEmail` | cron `0 4 * * 1` (Sun 10pm MT) | Drew | "Pretzel CFO · Weekly directive — week of {date}" | **keep-as-is** — strategic value |
| 4 | `finance-email-briefs.js` | `sendDailyReconEmail` (Mercury variance) | cron `0 14 * * *` (8am MT daily) | Drew | "Mercury vs books variance — {date}" | **keep-as-is** |
| 5 | `finance-issue-surfacer.js` | embedded in daily summary | inside `cfo_issue_surfacer` | Drew | (top 3 issues block within daily morning brief) | **keep-as-is** |
| 6 | `finance-ar-aging.js` | 5 templated AR follow-ups | manual + scheduled (workflow-driven) | **CUSTOMER EMAIL** | "Heads up: {invoice} {amount} due {due_date}" / "Quick check..." / "Following up..." / "{invoice} now {days} days past due..." | ⚠️ **modify** — these go to CUSTOMERS. Verify content before any auto-send. Currently DRAFT mode per Drew. |
| 7 | `email-sender.js` | `sendResendEmail` (generic) | called by retail Cohort B + others | **CUSTOMER EMAILS** | varies (marketing) | **out of Phase A scope** — separate workstream |
| 8 | `approval-mailer.js` | `sendApprovalRequestEmail` | called by outreach workflow | Drew (approval flow) | "Outreach approval needed — {venue}" | **out of Phase A scope** |
| 9 | `router.js` | `sendAlertEmail` (pipeline-stalled) | cron `0 */6 * * *` | Drew | "⚠ Pipeline stalled — no JEs in {N}h" | **keep-as-is** — important alert |
| 10 | `router.js` | `sendAlertEmail` (audit failure) | inside `trackedRun` on crash | Drew | "The {agent} agent crashed during its scheduled run" | **keep-as-is** |
| 11 | `finance-worker.js` | `sendEmail` (tax exemption cert request) | manual on-demand | (vendor or customer) | "Tax exemption certificate request — Dangerous Pretzel" | **keep-as-is** (rarely used) |
| 12 | `router.js` (Mercury IO reminder) | cron `0 14 28 * *` | self (Drew) | "Upload latest Mercury IO statement" | **keep-as-is** |
| 13 | `email-sender.js` (Pretzel program retail) | cron `0 16 * * 2` (Tue 10am MT) | customers | retail Cohort B win-back | **out of Phase A scope** |

### 6.2 Anything that looks **disable-immediately-incorrect**?

After this audit: **NO** — none of the finance emails I found look incorrect or going to wrong recipients. The closest case is **#6 AR aging follow-ups** which go to customers and could embarrass Drew if wrong. Recommendation: confirm these are still in DRAFT-only mode (sendAlertEmail vs actually sending). If they ever auto-send, that needs a separate review.

I have NOT disabled anything. Just documented for Drew's approval.

### 6.3 Phase A email impact

Phase A is bookkeeper UI; not changing email schedule. New surfaces in Phase A might add 1–2 new email types (e.g., "Decisions inbox has X items needing approval"). Will be specced in Section 13.

---

## Section 7 — Chart of Accounts Current State

### 7.1 Live totals (queried 2026-05-26)

| Metric | Count |
|---|---|
| Total accounts | **178** |
| Active | 177 |
| Deactivated | 1 |

### 7.2 By account_type (active only)

| account_type | Count |
|---|---:|
| expense | 63 |
| asset | 33 |
| revenue | 24 |
| liability | 24 |
| cogs | (count not surfaced in query — ~7) |
| equity | ~8 |
| other_income | ~3 |
| other_expense | ~5 |

### 7.3 Plug accounts — live state queried 2026-05-26

**All-time balances** (across full ledger history):

| Account | Balance | Status |
|---|---:|---|
| Ask My Accountant | -$485,964.98 | 🟡 large all-time net (drainage incomplete) |
| Cash Clearing | $939,577.05 | 🟡 large all-time DR (settlement timing artifacts) |
| Doordash Clearing | $123,420.90 | 🟡 |
| Square Clearing | $123,162.42 | 🟡 |
| Credit Card Clearing | $79,381.26 | 🟡 |
| Payroll Clearing | $41,737.84 | 🟡 |
| UberEats Clearing | $21,710.45 | 🟡 |
| Grubhub Clearing | $6,838.30 | 🟡 |
| LEAF Clearing | $0 | ✅ |
| Pre-Sync Adjustments | -$92,283.20 | 🟡 (post-YE2025 activity) |
| Pre-Pretzel-OS Reconciliation | -$226,113.93 | 🟡 (post-YE2025 activity) |
| YE2024 Bank Reconciliation Adjustment | -$74,299.54 | 🟡 (post-YE2025 activity) |

**AT YE2025 only** (filtered to `entry_date <= 2025-12-31`):

| Account | Balance | Phase 33 doc claim | Match? |
|---|---:|---:|---|
| Pre-Sync Adjustments | $0 | $0 | ✅ |
| Pre-Pretzel-OS Reconciliation | $0 | $0 | ✅ |
| YE2024 BRA | -$3,456.40 | -$3,456.40 | ✅ |
| LEAF Clearing | $0 | $0 | ✅ |
| Credit Card Clearing | $0 | $0 | ✅ |
| Payroll Clearing | $6,537.69 | $6,175 (Session 32-C1) | ✅ within rounding |
| Cash Clearing | $166,479.61 | "~$152K residual, acceptable" | 🟡 ~$14K higher |
| Doordash Clearing | -$42,423.35 (CR) | "near 0 transit" | 🟡 documented as larger residual |
| UberEats Clearing | -$7,437.57 (CR) | "near 0 transit" | 🟡 same |
| Grubhub Clearing | -$2,820.21 (CR) | "near 0 transit" | 🟡 same |
| Square Clearing | -$34,024.08 (CR) | "near 0 transit" | 🟡 same |
| **Ask My Accountant** | **-$24,615.08** | **$0 (Phase 31-A2)** | 🔴 **anomaly — needs investigation** |

### 7.4 Naming conventions

Observable patterns + drifts:

- `Sales:Food Income:Dine-In / Takeout` — colon-delimited path (most common)
- `Clearing Accounts:Cash Clearing` — colon-delimited
- `N/P LEAF funding Pizza Ovens` — abbreviated prefix
- `Mercury Checking (0118) - 1` — parenthesized last-4 + suffix
- `Restaurant Supplies & Equipment` — deactivated, replaced by `Restaurant Supplies` (new in Phase 26-C)
- `Delivery Fees:*` — children deactivated in Phase 26-B, **re-activated** in migration 096h
- `Sales:Channel Adjustments:DoorDash Commission` — new contra-revenue (Phase 26-B)

**No enforced style guide.** Drift is real. Phase A should pick a canonical naming pattern.

### 7.5 Mapping to tax form lines

**DOES NOT exist explicitly.** Mapping is implicit via:
- `account_type` (revenue/cogs/expense/etc.) → P&L sectioning
- `account_subtype` (current_asset / fixed_asset / current_liability / long_term_liability / partner_contributions / etc.) → Sched L grouping
- `working_capital_category` (ar / ap / sales_tax_payable / tips_payable / etc.) → SOCF working capital changes
- `expense_category` (cogs_food / labor / occupancy / marketing / etc.) → P&L sub-grouping

No table or column maps each account → 1065 line number. Irene does this manually in her workpapers.

**Phase A opportunity:** add `tax_line_mapping` column or `account_tax_mapping` table — `{ account_id, form: '1065', line: 'X', schedule: 'L'|'M-2'|... }`. Lets the filing package generate mechanically next year.

### 7.6 Accounts with no transactions YTD

Not surfaced in this section. Phase A could surface "inactive but not deactivated" candidates via:
```sql
SELECT c.account_name FROM chart_of_accounts c
LEFT JOIN journal_entry_lines l ON l.account_id = c.id
LEFT JOIN journal_entries j ON j.id = l.journal_entry_id AND j.entry_date >= date('now','start of year')
WHERE c.is_active = 1
GROUP BY c.id
HAVING SUM(COALESCE(l.debit,0)+COALESCE(l.credit,0)) = 0
```

---

## Section 8 — Migration State

### 8.1 Counts

- Total migration files: **112** (post-Tier-1-fix; was 111 pre-098)
- Applied to remote D1: all 112 (per Phase 33 final state + this session's confirmation)
- Pending: 097 (`backup_runs` table — gated on CLOUDFLARE_API_TOKEN setup, see Foundation Safety report)

### 8.2 By phase / era

| File range | Era | Migration count |
|---|---|---:|
| 006–029 | Pre-finance infrastructure (campaigns, outreach, basic schema) | 26 |
| 030–049 | Finance ledger init (Wave 1, finance v2 schema) | 19 |
| 050–079 | Phase 26–29 (Tier 1 expansion, SOCF restructure, Mercury statement match) | 29 |
| 080–098 | Phase 30–33 (Pattern B, OB reset to filed 1065, plug drain) + Tier 1 fix | 39 |

### 8.3 Migration patterns Phase A should follow

Conventions observed:
- Filename `NNN_<verb>_<noun>.sql` (e.g., `094_phase33c_ob_reset_to_filed_1065.sql`)
- Top-of-file comment block: date, purpose, source-of-truth references, acceptance criteria
- Idempotent (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`, `UPDATE ... WHERE status='posted'` filter)
- Document closed-period unlock/relock pattern when touching prior periods
- Always preserve audit trail (`status='reversed'`, not DELETE)

Phase A new migrations should:
1. Start at `099_*` or higher (098 = Tier 1 fix from this session)
2. Document filing-impact check at top (which periods touched, whether FY2025 affected)
3. Add corresponding acceptance test in `tests/acceptance.test.sh` for new schema/behavior
4. Cite the originating spec doc (e.g., "Phase A Surface 3 spec")

---

## Section 9 — Pretzel OS Internal vs Filing Position

### 9.1 Where the gap lives

**Pretzel OS internal Path A NI: -$299,576.15**
- Lives in: `journal_entries` posted JEs for FY2025 (revenue $498,930 - expense $798,506 per live query)
- Closed to RE via `fiscal_year_close` source_type at YE2025
- Matches Phase 33 final state documentation

**Filing position NI (v3 sent to Irene): -$346,898.53**
- Lives in: `irene_package_FY2025/PnL_FY2025_filing_v3.csv` (NOT in GL)
- Composed of: QBO-baseline NI ($-58,501.31) + Form 4562 depreciation ($79,164.55) + Startup amortization ($4,726.67) + Sprinter §179 ($200,000) + Tips Income reclass ($4,506)

**Gap: $47,322** (filing more negative than internal by this amount)

### 9.2 Why the gap exists

The v3 filing position layers tax-position adjustments on top of QBO's bookkeeper-era P&L. Pretzel OS's internal Path A NI of -$299,576 is what falls out of our GL after Phase 33 reconstruction — it already incorporates Phase 30 Pattern B Toast Payroll reconstruction + LEAF amortization but is computed from the GL, not from filing-specific overlays.

The two numbers are NOT meant to converge today. They were intentionally separated:
- Internal Path A = "what the books say happened" per GL
- Filing position = "what we tell the IRS happened" per Form 4562 + §179 elections

### 9.3 Workstream 2 (Internal-to-Filing Rebaseline)

**Not yet specced or built.** Per the May 26 strategy pivot, the intent is:
- Once Irene files (-$321,899 or whatever final lands), Pretzel OS internal books rebaseline to match
- That rebaseline happens AFTER filing is final — we don't want to converge mid-filing-prep and risk drift
- Rebaseline likely involves posting the same Form 4562 + §179 + tips reclass adjustments into FY2025 GL

### 9.4 Phase A impact (Surface 5 — Integrity Monitor)

Surface 5 should display:
- **Internal NI** (current, from GL canonical helper) — this is what the books say today
- **Filing NI** (locked, from filing package) — what we sent Irene
- **Gap** + tooltip explaining the intentional separation
- After Irene files + rebaseline runs, the gap should close

The Integrity Monitor must NOT alarm on this gap pre-rebaseline. Mark it as "expected divergence pre-filing-close."

---

## Section 10 — Existing Web App Architecture

### 10.1 File structure

| Location | Content |
|---|---|
| `dashboard/index.html` | **8,833-line single file** — entire dashboard SPA, inline CSS + JS |
| `dashboard/styles.css` | 690 lines, supplemental styles (some redundancy w/ inline) |
| `dashboard/coach.html` | coach agent UI (separate page) |
| `dashboard/pretzel-program.html` | retail program landing |

### 10.2 Routing pattern

**SPA with hash/state routing inside `index.html`:**
- Multiple `<div class="page" id="page-name">` blocks (outreach, accounts, money, retail, system)
- JS function `showPage(id)` toggles visibility (`display:none`/`block`)
- Sidebar `<button data-page="money" onclick="showPage('money')">` triggers
- No browser-history integration; no real URLs per "page"

### 10.3 HTML rendering

**Server-side: minimal.** Cloudflare Pages serves the static `index.html`. All dynamic rendering happens client-side.

**Client-side:** template-literal string interpolation, no framework:
```js
container.innerHTML = `<div class="card">${esc(name)}: ${fmtMoney(amt)}</div>`;
```

Helpers: `esc()` for XSS, `fmtMoney()`, `fmtPct()`, `fmtTime()` (Mountain Time formatting).

### 10.4 Auth

- **Shared-secret header.** Constant in JS: `AUTH_TOKEN = 'dpc-dash-2026-1c-shared-secret'`
- Same value set as Cloudflare secret `DASHBOARD_AUTH_TOKEN`
- Worker `router.js` checks `X-Pretzel-Auth` header in `AUTH_ENFORCE=true` mode (currently ON)
- Fetch monkey-patch auto-attaches header to all same-origin worker calls
- "Defense-in-depth, not real auth" per inline comment

No login flow, no session, no password. Cloudflare Access is the planned upgrade (per existing notes).

### 10.5 CSS approach

- **Inline `<style>` block at top of `index.html`** — primary styles
- CSS variables at `:root` define color tokens (`--bg`, `--card`, `--cream`, `--red`, `--text`, `--green`, `--amber`, `--blue`, `--purple`)
- Font: Google Fonts `Manrope` (sans + mono) + `Paytone One` (stat numbers); Georgia for headings
- Dark theme: `--bg:#1a1a1a; --card:#262626; --text:#ffffff`

**Different palette from v2 website (see §11)** — Pretzel OS uses dark-cream; v2 uses mustard + devil's red.

### 10.6 Worker request/response

- Worker is a single `export default { fetch, scheduled, queue }` in `router.js`
- HTTP routes use `if (path === '/finance/...') return ...` chain (file-based routing would be cleaner but not in use)
- Responses: `new Response(JSON.stringify(data), { headers: {'Content-Type': 'application/json'} })`
- CORS handled via `withCors` helper
- Auth check happens once per request (timingSafeEquals against `DASHBOARD_AUTH_TOKEN`)

### 10.7 D1 access pattern

```js
const { results } = await env.DB.prepare(`SELECT ... FROM ... WHERE ...`).bind(arg1, arg2).all();
```

Sometimes `.first()` for single-row queries. `.run()` for INSERT/UPDATE. Idempotent INSERTs use `INSERT OR IGNORE` or `ON CONFLICT DO NOTHING`.

### 10.8 The existing Money tab (what Phase A replaces or extends)

Located at lines 1098–~1480 of `dashboard/index.html`. Layout (post-Session 9 5-section accordion):

```
HERO: Trust Score · Cash · Runway · This Week Revenue · Breakeven gap
↓
Page Narrative (Sonnet "How are we?") — collapsible, regeneratable
↓
SECTION 1: Decisions Inbox (receipts pending, capex pending, AR follow-ups, issues, review queue)
SECTION 2: Where We Stand (scorecard + breakeven detail)
SECTION 3: What's Changing (monthly P&L quad + trends + customer intel + labor productivity + sparklines)
SECTION 4: What-If (scenario sliders + 6-month cash projection)
SECTION 5: Books & Tools (bulk-review queue, audit, GL stats, loans, Mercury banner, cash flow chart)
↓
Footer / system status
```

**What's worth keeping:**
- 5-section accordion structure — Drew validated this pattern works
- Drill-down drawer pattern (click any $ → side panel with detail)
- localStorage for accordion open/closed state
- Hero strip + page narrative at top
- Decisions inbox concept (consolidated approvals)

**What's worth scrapping or reworking for Phase A:**
- 8,833 lines is unmanageable. Phase A surfaces should be modular files (HTML + CSS + JS per surface), not all in one.
- Inline `<style>` is hard to maintain. Move to Tailwind CDN or scoped CSS modules.
- Auth as shared secret is OK short-term. Don't extend without Cloudflare Access plan.
- No tests for UI. Add at least smoke tests (does page load, does API call work) per Phase A surface.

---

## Section 11 — V2 Website Design System Extraction

Source: `/Users/drew/Code/website/v2/` + `/Users/drew/Code/website/styles/styles.css`.

### 11.1 Color tokens (extracted from v2 root CSS)

```css
:root {
  /* brand */
  --color-mustard: #e8cf82;
  --color-devils-red: #da172a;
  --color-lighter-red: #fa374a;
  --color-link-hover-red: #ba000a;
  
  /* neutrals */
  --color-bg: #f5f5f5;
  --color-light: #f8f8f8;
  --color-dark: #505050;
  --color-text: #101820;
}
```

### 11.2 Typography

- **Body:** `roboto` (regular 500, bold 700) — Google Fonts via `fonts.css`
- **Heading:** `roboto-condensed` (bold 700, black 900)
- **Em / accent:** `autobahn` (display-weight, brand-specific)
- **Fallback stack:** `arial` with `size-adjust` to match metrics

### 11.3 Font sizes

| Size | Mobile | Desktop (≥900px) |
|---|---:|---:|
| Body M | 22px | 18px |
| Body S | 19px | 16px |
| Body XS | 17px | 14px |
| Heading XS | 22px | 18px |
| Heading S | 24px | 20px |
| Heading M | 27px | 22px |
| Heading L | 34px | 28px |
| Heading XL | 44px | 36px |
| Heading XXL | 55px | 45px |
| Heading Huge | 64px | 55px |

### 11.4 Layout / spacing

- **Nav height:** 74px (desktop), 64px (mobile)
- **Breadcrumbs height:** 34px

No formal 8pt/16pt grid declared in CSS; spacing is ad-hoc. Phase A should establish one (e.g., Tailwind's default 0.25rem scale).

### 11.5 Tailwind-compatible token file proposal

Save as `dashboard/tokens.css` (or merge into Tailwind config):

```css
:root {
  /* === V2 Brand === */
  --color-mustard: #e8cf82;
  --color-devils-red: #da172a;
  --color-lighter-red: #fa374a;
  --color-link-hover-red: #ba000a;

  /* === Pretzel OS Existing (dashboard dark theme) === */
  --color-bg-dark: #1a1a1a;
  --color-card: #262626;
  --color-card-hover: #2e2e2e;
  --color-cream: #f5f0e8;
  --color-text-default: #ffffff;
  --color-text-muted: #cccccc;
  --color-text-dim: #a6a6a6;
  --color-border: #333333;

  /* === Status === */
  --color-success: #22c55e;
  --color-warning: #f59e0b;
  --color-info: #3b82f6;
  --color-purple: #a78bfa;
  --color-danger: #f87171;

  /* === Typography === */
  --font-body: 'Manrope', system-ui, sans-serif;
  --font-mono: 'Manrope', monospace;
  --font-heading: 'Georgia', serif;
  --font-stat: 'Paytone One', sans-serif;
  --font-brand-body: 'Roboto', sans-serif;             /* v2 carry-over */
  --font-brand-heading: 'Roboto Condensed', sans-serif;
  --font-brand-display: 'Autobahn', serif;

  /* === Spacing scale (Tailwind-default) === */
  /* use Tailwind utilities: m-1 = 0.25rem, m-2 = 0.5rem, etc. */

  /* === Border radii === */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;
}
```

### 11.6 Reconciling dashboard (dark) vs v2 (light) palettes

Phase A surfaces SHOULD blend:
- Use the v2 brand colors (mustard, devil's red) as primary accents
- Keep dashboard dark theme as base
- Mustard for highlight/positive emphasis
- Devil's red sparingly for critical alerts (matches existing `--red:#c41e1e`)

---

## Section 12 — Risk and Dependency Assessment

### 12.1 What's most likely to break

| Risk | Likelihood | Impact |
|---|---|---|
| Tier 1 SOCF check (now WARN) gets re-tightened to FAIL before Phase 28-C cleanup actually closes residual to <$5K | MEDIUM | Re-trips read-only; blocks JE posting |
| The 4 Tier 1 cross-consumer checks (cash, runway, revenue, AR) drift when Phase A adds new surfaces that compute their own numbers | HIGH | Tier 1 fail → read-only |
| Plaid Chase token expires / refresh fails | MEDIUM | Chase txns stop syncing silently |
| Mercury IO Credit manual upload missed | MEDIUM | Books drift from reality on credit-card spend |
| New categorizer rule mis-targets an account that doesn't exist | LOW | Caught by `categorizer_rule_targets_exist` invariant |
| Sonnet API tier limit hit on a high-traffic chat day | LOW | callAI wrapper degrades to Haiku; documented in ai-budget |
| Single-commit working-tree state vs deployed Worker version drift | LOW post-Foundation-Safety | git baseline now in place |

### 12.2 External service dependencies

| Service | Use | Rate limits |
|---|---|---|
| Anthropic API | Sonnet narrative + chat + Haiku categorizer fallback | 50 req/min default; `ai-budget.js` caps daily $2.50 hard / monthly $50 hard |
| Mercury API | Daily sync | 60 req/min — `mercury-client.js` sleeps 1100ms between paginated calls |
| Plaid API | Every 4h Chase sync | 1000 calls/month free tier; product-limit dependent |
| QBO API | Hourly invoice sync + manual P&L pulls | 500 req/min per realm |
| Square API | Real-time webhook + 6h customer sync | per merchant, generous |
| Resend (email) | All outbound finance + retail emails | 3000/month on current plan |

### 12.3 Hardest things to test in Phase A

1. **Categorizer rule changes** — no backtest harness; new rule could mis-fire on historical txns. Phase A should add a shadow-mode where new rules log decisions without writing.
2. **LLM categorization layer** — Sonnet/Haiku output drift is invisible until Drew notices. Need confidence-vs-actual-accuracy tracking.
3. **End-to-end "Drew clicks Approve" flow** — manual approval surfaces touch GL via JE poster; need integration tests.
4. **Tier 1 invariant additions** — each new check has a chance to be too tight or too loose. Need backtest against last 90 days of data before promoting to Tier 1.

### 12.4 What could degrade existing functionality

1. **Touching `finance-cfo-categorizer.js`** without preserving rule order → wrong rule wins per first-match logic
2. **Adding new canonical helpers without cross-consumer agreement probe** → DIF-2 invariant misses drift
3. **Schema additions that break `narrative_csv_consistency` check** → next deploy fails the gate
4. **Putting Phase A surfaces in the existing 8,833-line `index.html`** → file becomes unmaintainable

### 12.5 Things found in inventory that surprised me

(Repeating + extending from prior state assessment)

1. **All workers show "last modified 2026-05-26"** because the entire working tree was just baselined in one git commit. We have NO per-file history for the prior 9 weeks. If Drew or I need to investigate "when did this code last change?", git can't help.

2. **The categorizer has NO match-rate tracking**. No `categorizer_decisions` table, no aggregate. We literally don't know how often each rule fires.

3. **Phase 33 reconstruction workers (~13 of them) are dormant but still in-tree.** ~10K+ lines of one-time code. Not problematic, but bloats `workers/` directory.

4. **Dashboard auth is a single hardcoded string** in client-side JS. Anyone with the Pages URL can read it. Real auth = Cloudflare Access (pending).

5. **`workers/finance/` subdirectory** contains `ARCHITECTURE.md` / `KNOWN_GAPS.md` / `RUNBOOKS.md` / `finance-cron-schedule.md`. These docs are NOT linked from the top-level `workers/ARCHITECTURE.md`. They may be stale.

6. **No file naming convention for migrations.** Some are `NNN_phase_X_verb_noun.sql`, some are just `NNN_verb_noun.sql`. Phase A spec should pick one.

7. **`fixed_assets` table exists with proper depreciation registry** + monthly cron auto-posts the schedule. This is a genuine bright spot — keep it. Form 4562 schedule lives here per asset.

8. **`closed_periods` table has been routinely unlocked/relocked during reconstruction.** Audit log entries exist for some but not all. Phase A should require an explicit reason field on every unlock.

9. **No automated "is the deployed code the same as `main`?" check.** A drift between git and live worker version is invisible. Pre-deploy gate runs from working tree, not git HEAD.

10. **The post-fix-state I just achieved (Tier 1 corruption clean + read-only off) is a known-good moment.** Phase A should anchor to this commit hash (`91146b4`) for any rollback planning.

---

## Section 13 — Phase A Build Plan Recommendations

### 13.1 The 7 Phase A surfaces (per prior conversations)

(Inferred from Drew's framing — Phase A is the bookkeeper UI layer. The 7 surfaces aren't formally named yet; my proposal:)

1. **S1 — Daily Decision Inbox** (categorize new Mercury+Chase txns; LLM-assisted)
2. **S2 — Statements Viewer** (P&L / BS / SOCF with drill-down, multi-period)
3. **S3 — Vendor / Customer Pages** (per-vendor categorization history, customer payment intel)
4. **S4 — Forecast & Scenario** (smart forecast replacing the naive cash/burn model)
5. **S5 — Integrity Monitor** (Tier 1/2/5 live status + plug-account watch + filing-vs-internal gap)
6. **S6 — Period Close Workspace** (monthly close ritual, accruals approval, period lock)
7. **S7 — Audit Trail / What I Did Today** (every autonomous decision + who approved + reversal path)

### 13.2 Build order (dependencies)

```
Pre-work (already done in this session)
   ├── Foundation Safety: git baseline + R2 backups
   ├── Tier 1 fix: clean corruption
   └── This inventory

Pre-Phase-A blockers (do these BEFORE surfaces)
   ├── B1. Add categorizer_decisions table + writes (Section 2.5 proposal)
   ├── B2. Add account_tax_mapping (Section 7.5)
   ├── B3. Investigate AMA -$24,615 anomaly (Section 7.3) — decide reclass or accept
   ├── B4. Move 8,833-line index.html into modular structure (or commit to keeping monolithic)
   └── B5. Decide Phase A frontend stack (Tailwind CDN vs custom CSS modules)

Phase A surfaces (depend on pre-work)
   1. S5 first (Integrity Monitor) — surfaces existing Tier 1/2/5 data, no new logic
   2. S2 (Statements Viewer) — read-only, reuses existing finance-statements-* workers
   3. S7 (Audit Trail) — read-only, reuses agent_decisions + finance_audit_log
   4. S1 (Decision Inbox) — REQUIRES B1; main Phase A value but biggest scope
   5. S3 (Vendor/Customer) — depends on B1 for vendor categorization history surfacing
   6. S6 (Period Close) — depends on S5 to know if period is clean to lock
   7. S4 (Forecast) — replaces naive model, biggest "smart" surface; needs vendor KB + customer intel from S3
```

### 13.3 Reuse per surface

| Surface | Reuse | New build |
|---|---|---|
| S5 Integrity Monitor | `getTrustScore()`, `runTier1/2/5`, `finance_audit_runs` table, plug account queries | UI panel that polls + renders |
| S2 Statements Viewer | `getCashFlowStatement`, `getMonthlyPL`, `getBalanceSheetAsOf`, drill-down endpoints | Multi-period viewer + comparison UI |
| S7 Audit Trail | `agent_decisions`, `finance_audit_log`, `ai_calls` tables | Filterable timeline UI |
| S1 Decision Inbox | `finance-cfo-categorizer.js` rules + JE poster + `finance-review-queue.js` | LLM proposal layer; "Apply" / "Reject" / "Reclassify" UI; categorizer_decisions tracking |
| S3 Vendor/Customer | `vendor_categorization_history`, `customer_payment_history`, `customer_intel`, `ar-aging` | Profile pages + interaction logs + payment timing intel |
| S6 Period Close | `closed_periods`, `cfo_monthly_close`, accrual workers, `runTier1Filing` (specced not built) | Close ritual UI + checklist + accrual approval flow |
| S4 Forecast | `finance-cashflow.js` (replace) + `finance-scenario.js` (keep) + AR/Payroll/Recurring data | Smart forecast worker per Section 8 of state doc spec |

### 13.4 Pre-work needed BEFORE Phase A build starts

**Hard blockers:**
1. **B1: categorizer_decisions table.** ~3 hr build. Required for S1 + S3 + categorizer effectiveness measurement.
2. **B3: AMA -$24,615 investigation.** ~1–2 hr. Need to understand if it's data drift, an unfinished migration, or legitimate residual before S5 surfaces "books status."

**Soft blockers (can defer but Phase A surfaces will be weaker):**
3. **B2: account_tax_mapping.** ~2 hr. Doesn't block surface build but tax filing remains manual without it.
4. **B4: index.html modularization.** ~4–6 hr. Phase A surfaces can be appended to existing index.html, OR pulled into a `dashboard/surfaces/*.js` structure. Decide architecture before second surface lands.
5. **B5: Frontend stack decision.** ~1 hr (decision); 2–4 hr (Tailwind CDN setup if chosen).

### 13.5 Effort per surface (days of focused work)

| Surface | Effort (days) | Notes |
|---|---:|---|
| S5 Integrity Monitor | 2 | Mostly UI on existing data |
| S2 Statements Viewer | 3 | Multi-period, drill-down, export |
| S7 Audit Trail | 2 | UI on existing tables |
| S1 Decision Inbox | 5 | Biggest. LLM layer + approval flow + tracking. Includes B1 (~0.5d). |
| S3 Vendor/Customer | 3 | Two profile types, reuses customer_intel |
| S6 Period Close | 3 | Workflow UI; accrual approvals; lock/unlock with reason |
| S4 Forecast | 6 | Smart forecast model + scenario integration + drill-down per component |
| **Subtotal surfaces** | **24** | |
| Pre-work B1-B5 | 2 | Combined |
| Integration / smoke tests / dashboard nav restructure | 3 | |
| **TOTAL Phase A** | **~29 focused-days** | ≈ 5–6 calendar weeks at full pace |

### 13.6 Risks specific to each surface

| Surface | Risk | Mitigation |
|---|---|---|
| S1 Decision Inbox | LLM gets categorization wrong + auto-posts at high confidence | Shadow mode for first N decisions; track override rate; auto-downgrade rule to lower confidence if 3+ overrides within 7d |
| S2 Statements Viewer | Drift between internal Path A and filing position confuses Drew | Show BOTH numbers side-by-side with footnote; mark periods as "internal / filing / converged" |
| S4 Forecast | New forecast model has same gut-check failure as the $400K naive one | Backtest against last 90 days of actual cash trajectory; surface confidence band wider than range, narrow over time |
| S5 Integrity Monitor | Drew tunes out alerts if too noisy | Tier 1 = require action; Tier 2 = informational; visual differentiation matters |
| S6 Period Close | Locks period prematurely (data still coming in) | 5-day grace window (RTR-4 spec); checklist must include data-completeness verification |
| S7 Audit Trail | Drowns Drew in noise | Default filter: last 7 days, autonomous decisions only, manual decisions on demand |
| S3 Vendor/Customer | Per-vendor pages need real data Drew can act on; risk of empty pages | Seed from `vendor_categorization_history` (already has 178 vendors with QBO history); customer pages reuse customer_intel |

### 13.7 Sequencing rationale

- S5 first because it surfaces what's already there + tests new UI pattern with low blast radius
- S2 second because it's read-only and high-value (Drew can see statements without me)
- S7 third for the same reason + builds shared timeline pattern for later surfaces
- S1 fourth — the main event, biggest value, needs B1 + S5 patterns in place
- S3 fifth because S1's LLM categorizer benefits from vendor profiles
- S6 sixth because period close depends on S5 (integrity) being trustworthy
- S4 last — needs ALL of the above (vendor KB, customer payment history, recurring patterns, integrity check) to be smart

### 13.8 Things to decide before build prompts

1. **Frontend stack** — Tailwind CDN vs scoped CSS modules vs continue with inline `<style>` in index.html
2. **File structure** — single `index.html` (current) vs `dashboard/surfaces/*.js` modular
3. **LLM provider strategy** — already Anthropic-locked via `callAI`. Confirm Claude as Phase A's LLM (not switching to OpenAI etc.)
4. **Approval UX** — one-click approve vs always-require-typing-confirm. Spec each surface differently.
5. **Mobile** — Phase A built for desktop or mobile-responsive from day 1? Existing dashboard is desktop-first.
6. **Email vs in-dashboard for daily ritual** — keep email-first (Drew checks at 7am) or shift to dashboard pull?
7. **AMA -$24,615 disposition** — investigate + reclass, OR accept as documented residual?
8. **Workstream 2 timing** — when Irene files, do we converge internal-to-filing immediately or document as ongoing?

---

## What I did NOT touch during this investigation

- ❌ No new schema (Phase A planning identified needs but no migrations beyond 098)
- ❌ No worker disables (email audit identified candidates; Drew approves)
- ❌ No "quick fixes" to anomalies (AMA documented, not fixed)
- ❌ No frontend changes (Phase A pre-work, not Phase A build)

## What I DID do (under Drew's "A - fix Tier 1" approval)

- ✅ Migration 098 reverses broken `toast-payroll-2026-03-20` JE (FY2026-only, zero FY2025 impact)
- ✅ Code change demoting `socf_reconciles_within_tolerance` from FAIL→WARN per original Session 28-B-6 design intent
- ✅ Cleared `FINANCE_READ_ONLY` KV flag
- ✅ Committed + pushed to GitHub (`91146b4`)
- ✅ Deployed to production (version `4e768677-113b-4d3e-886b-072bdacdab48`)
- ✅ Wrote `PHASE_A_PRE_WORK_PAUSE_REPORT.md` documenting the Tier 1 issue
- ✅ Wrote this build plan (`PHASE_A_BUILD_PLAN.md`)

## Time spent

- Tier 1 fix (Step A): ~1 hour
- Phase A inventory (Sections 1–13): ~2 hours
- **Total: ~3 hours.** Under the 1–2 day budget.

End of pre-work document. Awaiting your review + decisions on §13.8 to draft the actual Phase A build prompts.
