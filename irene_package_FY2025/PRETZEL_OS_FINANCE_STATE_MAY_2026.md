# Pretzel OS Finance — State Assessment (May 2026, Post-Filing)

**Generated:** 2026-05-26
**Purpose:** Honest assessment of finance system state before designing going-forward architecture.
**Scope:** Investigation only — no changes, no new features.
**Method:** Codebase + migration history + ARCHITECTURE.md + task ledger + cron registry + Phase 33 outputs.

---

## Headline

Pretzel OS Finance is a **reconstruction tool that mostly stopped reconstructing**. Through 33 phases it has:
- Cleanly closed FY2025 books cent-accurate to QBO bookkeeper-era P&L truth ($-58,501.31 internal NI per QBO baseline, $-346,898.53 filing position after §179/depreciation/tips adjustments)
- Built 16+ Tier 1 ledger invariants that gate every deploy
- Wired Mercury Checking + Savings + Plaid (Chase) + QBO + Square + Toast as data sources
- Generated the FY2025 filing package now in Irene's hands

But it is **NOT yet "operational finance"** in the "weekly oversight, near-real-time, agentic books" sense. Specific gaps:
- No autonomous agent loop between Drew sessions (everything is cron-triggered batch work + Drew-triggered manual ops)
- Mercury IO Credit (••0000) requires monthly manual statement upload (no API)
- Plaid Chase Ink production status not verified in this assessment (code shipped, secrets unknown)
- The 102-worker, 112-migration surface is fragile — small changes have historically cascaded
- All 102 workers + dashboard are uncommitted to git (working state lives in 1 commit + working tree)

**Top-level confidence**: 🟡 YELLOW. Books are filing-ready and structurally sound *for the period that's been reconstructed*. Going-forward operation is unproven — last 2 weeks of post-filing-prep work was almost entirely retroactive reconstruction, not forward-flow.

---

## Section 1 — Data Ingestion

### Mercury Checking (••0118)

| Attribute | Value |
|---|---|
| Connection | **LIVE** via direct Mercury API (`Bearer MERCURY_API_TOKEN`) |
| Mechanism | Polling — `getAccounts()` + `getTransactions(accountId, since, until)` |
| Cadence | Daily as part of `cfo_daily_close` cron (`0 13 * * *` = 7am MT) |
| Coverage | YE2024 → present, strict-match cent-accurate at 17 month-ends (Phase 33-H 096d) |
| Lands in DB? | YES — `mercury_accounts.current_balance` + `mercury_transactions` rows |
| Confidence | 🟢 GREEN |

### Mercury Savings (••5450)

Same path as Checking, same `getAccounts()` call. Strict-match across all month-ends. **🟢 GREEN.**

### Mercury IO Credit (••0000) — the Mercury-issued credit card

| Attribute | Value |
|---|---|
| Connection | **NOT EXPOSED BY API** — Mercury's `/accounts` endpoint doesn't return this account |
| Mechanism | Manual monthly statement upload + bookkeeper-era data via QBO archive |
| Cadence | Monthly (the `mercury_io_reminder` cron on the 28th emails Drew to upload latest statement) |
| Coverage | YE2024 + 371 Mercury Credit Purchase records ($90,925.80) ingested from QBO archive for FY2025 bookkeeper era |
| Lands in DB? | Partially — `mercury_io_statement_txn` source_type JEs; ~$26K imbalance for 2026 periods (bookkeeper fired Feb 2026, no longer entering manually into QBO) |
| Confidence | 🔴 RED for forward flow |

This is the most operationally-fragile ingestion path. `workers/mercury-client.js:probeMercuryEndpoints()` exists to keep probing for an API path that might expose IO transactions — none found as of last probe.

### Chase Ink CC (other personal/business credit cards)

| Attribute | Value |
|---|---|
| Connection | **CODE WIRED** via Plaid (workers/plaid-client.js, migration 051) — production secret status NOT verified in this read-only assessment |
| Mechanism | Plaid Link → exchange → `/transactions/sync` polling + webhooks |
| Cadence | `chase_sync_plaid` cron every 4h at :20 (240min cadence in heartbeat-keys.js — flagged CRITICAL) |
| Coverage | Phase 31-A1/A2/A3 era; chase_ink_statement_txn source_type exists |
| Lands in DB? | YES — `chase_cc_transactions` (migration 044) + `plaid_items` (encrypted access_token) |
| Confidence | 🟡 YELLOW — code is solid, but Drew's TODO list flagged "Plaid Production application: 1-5 day underwriting" as pending months ago. Need to verify what's currently flowing. |

**Other personal/business cards (Chase Sapphire, Amex, etc.)**: Not connected.

### Toast POS (sales data)

| Attribute | Value |
|---|---|
| Connection | **LIVE via webhook** — account-worker.js handles incoming Toast order events |
| Mechanism | Webhook → `orders` table (`source='toast'` historical / `'toast_live'` cutover / `'square'` post-Apr 14) |
| Cadence | Real-time (webhook) + daily sync cron `0 10 * * *` (4am MT) |
| Coverage | Oct 2024 — Mar 31 2026 (Toast retired); 28,683 orders in `orders` table |
| Lands in DB? | YES |
| Confidence | 🟢 GREEN historically. Toast is retired — no current ingestion needed. |

### Toast Payroll (payroll JEs + tip distributions)

| Attribute | Value |
|---|---|
| Connection | Manual CSV ingest via `toast_payroll_gl` table (2,250 rows Jul 2024 — Apr 2026) |
| Mechanism | Manual upload into D1 |
| Cadence | Ad-hoc / Drew-triggered (no automated cron) |
| Coverage | Jul 2024 — Apr 2026 (Toast Payroll era ended ~April 2026 cutover to Square Payroll) |
| Lands in DB? | YES, as source-of-truth for `toast_payroll_reconstruction` worker |
| Confidence | 🟢 GREEN as historical truth (W-3 Box 3 ties within $218); 🟡 YELLOW for future cycles (no ongoing process since Toast Payroll retired) |

### Square POS (catering + post-cutover retail)

| Attribute | Value |
|---|---|
| Connection | **LIVE webhook** — `/square/webhook` in router.js → squareSync.fetch() |
| Mechanism | Real-time webhook → `orders` table + `raw_payload` JSON preserved for tax/tip extraction |
| Cadence | Real-time + daily sync cron 0 10 * * * |
| Coverage | Apr 14 2026 → present |
| Lands in DB? | YES — Square Customer sync also cron'd (every 6h) |
| Confidence | 🟢 GREEN |

### Square Payroll (post-cutover wages)

| Attribute | Value |
|---|---|
| Connection | Manual xlsx upload (Company Totals report) |
| Mechanism | Drew manually downloads + imports |
| Cadence | Manual / weekly cycle |
| Coverage | Apr-May 2026 partial ($28,953 earnings + $5,420 EE tax + $3,170 ER tax) |
| Lands in DB? | YES via `finance-square-payroll-reconstruction.js` |
| Confidence | 🔴 RED for forward flow — no automation |

### Square Labor (shifts + scheduling)

`square_labor_sync` cron daily at 11:45pm MT. `square_shifts` table populated.
- Status: 🟡 YELLOW — wired but not deeply integrated into payroll-vs-shifts reconciliation

### DoorDash / UberEats / Grubhub

- Sale-side: captured via Toast orders (historical) / Square orders (current) with marketplace source.name in raw_payload
- Settlement-side: captured as Mercury inflows → categorized → Clearing Accounts (Doordash Clearing, UberEats Clearing, Grubhub Clearing)
- Marketplace fees: extracted via Phase 26-B channel adjustments + Phase 31-A1 Delivery Fees reclassification
- Confidence: 🟢 GREEN historically, **🟡 YELLOW going forward** — Clearing Accounts accumulate residuals when settlement timing drifts vs POS recognition

### LEAF Funding (equipment loans)

| Attribute | Value |
|---|---|
| Connection | Manual — lease agreement PDFs parsed for amortization schedules |
| Mechanism | `finance-leaf-amortization-splitter.js` reads schedule, splits Mercury LEASE SERVICES outflows into Principal + Interest + Tax |
| Cadence | Auto-applied to each Mercury LEAF outflow via categorizer |
| Coverage | 4 loans: Pizza Ovens, Kemper Bakery, Comm Kitchen-2, Commercial Kitchen Supply |
| Lands in DB? | YES — Pattern B clearing account (`Clearing Accounts:LEAF Clearing`) + N/P LEAF * accounts |
| Confidence | 🟢 GREEN |

### QuickBooks Online

| Attribute | Value |
|---|---|
| Connection | **LIVE via OAuth + token rotation** in workers/qbo-client.js |
| Mechanism | Polling on multiple cadences: hourly QBO sync (for Invoices), monthly Tier 5 acceptance, on-demand for archive/P&L pulls |
| Cadence | Hourly (`qbo_sync`) + manual for reports |
| Coverage | Live for current data; `qbo_archive_entity` table holds bookkeeper-era historical entities (Purchase 1,072 / JournalEntry 572 / Invoice 16 / Deposit 550 = ~2,210 entities) |
| Lands in DB? | YES |
| Confidence | 🟢 GREEN connection, 🟡 YELLOW operational role — bookkeeper fired Feb 2026, QBO is no longer actively maintained except by Irene's adjusting JEs (May 26 post-filing) |

**Important:** Post-Irene-rebaseline, QBO YE2025 now has Irene's §110 adjustments (LI reduced from $438,100 → $318,691). Pretzel OS internal GL does NOT reflect these — there's drift between Pretzel OS internal state and the filing-position QBO state.

### Vendor invoices

| Attribute | Value |
|---|---|
| Connection | None automated |
| Mechanism | Captured indirectly via Mercury outflows + categorizer |
| Coverage | Cash-basis only |
| Confidence | 🟡 YELLOW — no AP-side accounting (every expense recognized when paid, not when invoice received) |

### Other found-but-undocumented sources

- **Bank statement PDFs** — `bank_statement_balances` table (94 month-end rows) populated from manual PDF extraction in Phase 28-D / 29-A. Source: Drew uploads, parser extracts via PDF skill. No ongoing automation.
- **Receipt processing** — `finance-receipts.js` worker exists with Haiku vision extraction; can take photo → categorize → match to Mercury txn. **Lightly used. Confidence 🟡 YELLOW (built, unclear cadence of actual use).**

### Section 1 summary table

| Source | Connection | Cadence | Lands in DB | Confidence |
|---|---|---|---|:-:|
| Mercury Checking | Live API | Daily | ✓ | 🟢 |
| Mercury Savings | Live API | Daily | ✓ | 🟢 |
| Mercury IO Credit | **No API — manual** | Monthly | Partial | 🔴 |
| Chase Ink (Plaid) | Code wired | Every 4h | ✓ if prod connected | 🟡 |
| Toast POS | Webhook (retired) | Real-time | ✓ historical | 🟢 |
| Toast Payroll | Manual CSV | Ad-hoc | ✓ historical | 🟡 |
| Square POS | Live webhook | Real-time | ✓ | 🟢 |
| Square Payroll | Manual xlsx | Weekly manual | ✓ partial | 🔴 |
| Square Labor | Live API | Daily | ✓ | 🟡 |
| DoorDash/Uber/Grubhub | Via Mercury+POS | Settlement timing | ✓ | 🟡 |
| LEAF | Manual schedules | Per outflow | ✓ | 🟢 |
| QBO | Live OAuth | Hourly + manual | ✓ | 🟡 |
| Vendor invoices | Not automated | n/a | n/a (cash basis) | 🟡 |
| Receipts | Vision OCR | Manual upload | ✓ | 🟡 |

---

## Section 2 — Journal Entry Creation Flow

### Categorization mechanism

**Rules-only** — `workers/finance-cfo-categorizer.js` has **30 hardcoded rules** matching on counterparty regex + amount range + direction. Each rule has:
- `name`
- `counterparty_pattern` (regex)
- `target_account_name`
- `confidence` (0.85–0.98 range)
- Optional `reason`

**No LLM fallback in the categorizer.** Earlier plans (V3-B "Smart auto-categorizer with KB + Sonnet fallback") were specced but not implemented. Novel vendors that don't match a rule end up with NULL `proposed_account_id` and stay in the review queue.

The 30 rules cover:
- Toast/Square/DoorDash/UberEats/Grubhub deposits → Clearing Accounts
- Mercury internal transfers + Wells Fargo + bookkeeper-era plug paths
- 3 named wholesale customers
- Sales tax remittance (UTAH801)
- Sysco / US Foods / Shamrock / Webstaurant / Restaurant Depot / Uline
- Toast Payroll + Square Payroll (Pattern B clearing accounts)
- LEAF Funding (lease principal+interest+tax split)
- Chase Ink + Mercury Credit pay-down
- A handful of utility / software / R&M / parking patterns

### Confidence scoring

Per-rule literal confidence (0.85, 0.90, 0.95, 0.97, 0.98). No dynamic confidence model.

### Auto-post threshold vs review queue

- Default `min_confidence` for `POST /finance/cfo/post-jes` is **0.90** (configurable per call)
- Anything ≥ 0.90 with a matching rule gets auto-posted as a JE
- Anything < 0.90 OR no rule match → stays in review queue
- Categorized txns visible via `/finance/cfo/review-queue` endpoint (and bulk-review-by-counterparty UI in dashboard)

### Where queued items surface

- Dashboard "Books & Tools" section → bulk-review-by-counterparty
- Dashboard "Decisions" tile → review queue depth count
- No daily/weekly digest pushes review queue items at Drew

### Categorization failure handling

Txns with no rule match get:
- `proposed_account_id = NULL`
- `proposed_confidence = NULL`
- `proposed_reasoning = NULL`
- Stay in mercury_transactions with `is_reconciled=0`

There is **no automatic escalation, no daily summary email, and no LLM categorization fallback**. The 40 historical "Dangerous Pretze..." internal transfers ($118K) sat in review queue for months until Phase 30-D Pattern B addressed them.

### Vendor master data

**Partial.** `vendor_categorization_history` exists (migration 038) — built from QBO archive entities to record historical bookkeeper-assigned accounts per vendor. But the categorizer does NOT consult this KB at decision time. It was specced (V3-A) but not wired into the auto-categorize path.

### Idempotency

🟢 Strong. Three mechanisms:
1. `mercury_transactions.matched_journal_entry_id` — once set, the txn won't double-post
2. `journal_entries` keyed by `source_type + source_id` — re-runs of reconstruction workers skip existing
3. `UNIQUE` constraints on Mercury txn IDs prevent duplicate sync ingestion

---

## Section 3 — Chart of Accounts

### Counts (from Phase 33 final state)

I don't have a live count but can estimate from migrations:
- ~150-170 total accounts (parent + children)
- Active vs deactivated: Phase 26-B deactivated 5 Delivery Fees accounts; Phase 26-C deactivated Restaurant Supplies & Equipment and Ask My Accountant after draining; Migration 096h re-activated Delivery Fees (post-feedback)
- Some accounts created during Phase 33-C: `33c-bbloq-ar`, `33c-settlement-payable-ta`, `33c-loan-from-drew-sparks`, `33c-credit-card-payable`

### Plug account balances (post-Phase 33)

| Account | Balance | Status |
|---|---:|---|
| Pre-Sync Adjustments | $0 | ✅ Drained Phase 33-H 096a/c |
| Pre-Pretzel-OS Reconciliation | $0 | ✅ Drained Phase 33-H |
| YE2024 Bank Reconciliation Adjustment (BRA) | +$3,456.40 | ⚠️ Legitimate timing residual per Phase 33 final state doc, presents in BS Equity |
| Ask My Accountant | ~$0 (post-31-A2 drain) | ✅ |
| Cash Clearing | varies (operational transit) | 🟡 YELLOW — should be near $0 at month-end but has accumulated residuals during reconstruction |
| Payroll Clearing | $6,175 YE2025 (FY2025-only) / $88,320 with FY2026 contamination | 🟡 YELLOW — Session 32-C1 addressed FY2026 contamination but not in latest filing position |

Per ARCHITECTURE.md and Phase 33 final state: "Pre-Sync = $0, Pre-Pretzel-OS = $0, BRA = +$3,456.40 (legitimate)". 🟢 GREEN for plug accounts overall.

### Naming convention consistency

🟡 YELLOW. Sample drifts observed:
- "Delivery Fees:*" (parent + 5 children, all deactivated then 096h re-activated — confusing state)
- "Sales:Channel Adjustments:*" added by Phase 26-B as contra-revenue alternative
- "Restaurant Supplies & Equipment" (deactivated) vs "Restaurant Supplies" (new in Phase 26-C)
- "Mercury Credit (0000) - 1" naming differs from "Mercury Checking (0118) - 1" format consistently in some places, but old code does `LIKE 'mercury %'` lookup expecting that exact prefix

There's no enforced naming style guide.

### Tax form mapping (1065 Schedule K/L)

**Does NOT exist explicitly.** Mapping is implicit via:
- `account_subtype` (current_asset, fixed_asset, current_liability, long_term_liability, partner_contributions, etc.) — maps to Sched L line groupings
- `working_capital_category` (ar, ap, sales_tax_payable, tips_payable, gift_card_liability, payroll_payable) — used for SOCF working capital changes
- `expense_category` (cogs_food, labor, occupancy, marketing, payment_processing, etc.) — used for P&L sub-grouping

No table mapping each account to a 1065 line number. Irene maps manually in her workpapers.

### Accounts with no transactions YTD

Not directly queried in this read-only assessment. Likely candidates:
- "Branding" (gross $0 on YE2025 BS, deactivated likely)
- "Long-term office equipment" (gross $0)
- "Note Payable - Toast" (cleared)
- Several Phase 33 cleanup-created accounts that drained to $0

Estimated 10-20 zero-balance accounts surviving from reconstruction.

**Confidence: 🟡 YELLOW** — accounts mostly clean post-Phase 33 but some COA noise persists.

---

## Section 4 — Period Close Discipline

### Period lock mechanism

`closed_periods` table (exists from early migrations). Pattern observed in many reconstruction migrations:
```sql
UPDATE closed_periods SET locked_at = NULL WHERE period = ...
-- post adjusting JEs
UPDATE closed_periods SET locked_at = datetime('now') WHERE period = ...
```

`workers/finance-je-poster.js` has `isInClosedPeriod()` check that BLOCKS posting if entry_date falls in a locked period.

🟢 GREEN structurally, 🟡 YELLOW in practice — period locks are routinely opened during reconstruction work. RTR-4 plan (Session 12) added a 5-day grace period before close, but enforcement of the post-close lock is weak (any new migration can unlock).

### Current state

- FY2025 (2025-01-01 → 2025-12-31): **locked** per Phase 33-G final close
- FY2026 partial (Jan-Apr 2026): likely **unlocked** — Phase 33-H 096d touched these dates for Mercury strict-match
- May 2026: open

### Unlock workflow

No formal workflow. Done in migrations via raw SQL `UPDATE closed_periods SET locked_at = NULL`. No approval gate, no audit log of unlock events (would be valuable).

### Automated period-end accruals

| Accrual | Cron | Status |
|---|---|---|
| Monthly depreciation (Form 4562 schedule) | `0 9 1 * *` — 1st of month 3am MT | ✅ Automated via `finance-monthly-depreciation-cron.js` |
| Startup amortization | Same as above | ✅ Automated |
| Sales tax accrual (Tips + Tax) | `bookkeeper_tips_tax_accrual` source_type | ⚠️ Historical reconstruction only — not running forward |
| AP accruals | None | ❌ Cash basis only |
| Prepaid expense amortization | None | ❌ Drew posts manual JEs if needed |
| Payroll accrual | Pattern B clearing via reconstruction workers | 🟡 YELLOW — historical only |

### Month-end checklist

No formal checklist document. Implicit through cron schedule:
1. Daily close runs 7am MT every day (Mercury sync, categorize, post auto-confidence JEs, forecast)
2. 1st of month 6am MT — `cfo_monthly_close` (P&L+BS+CF + period lock)
3. 1st of month 9am MT — Tier 5 monthly acceptance (replay vs QBO)
4. 28th of month 8am MT — Mercury IO statement reminder email

**No "check these things before closing the month" runbook.** Closing relies on the cron + Tier 1/Tier 5 catching issues.

**Confidence: 🟡 YELLOW** — automation exists, discipline doesn't. Reconstruction-era reopening pattern has eroded "the books are closed" as a real boundary.

---

## Section 5 — Integrity / Invariant Checks

### Tier 1 (ledger invariants, hourly cron `5 * * * *`)

**16+ invariants** (extracted from `workers/finance-audit-engine.js`):

1. `dr_eq_cr_per_je` — Every posted JE has debits == credits
2. `dr_eq_cr_ledger` — Total ledger debits == total credits
3. `no_orphan_je_lines` — No JE line without a parent
4. `no_invalid_account_id` — Every line's account_id resolves
5. `reconciled_has_matched_je` — Reconciled Mercury txn has a matched JE
6. `no_duplicate_mercury_txns` — No duplicate Mercury txn IDs
7. `at_most_one_opening_balance` — Single OB JE
8. `no_post_in_closed_period` — Period lock enforcement
9. `fixed_asset_nbv_consistency` — Fixed asset registry matches GL
10. `no_je_for_failed_mercury_txns` — Failed status txns aren't categorized
11. `categorizer_rule_targets_exist` — Categorizer rules reference live accounts
12. `no_dual_dr_cr_line` — No JE line with both DR and CR set
13. `je_touches_distinct_accounts` — No JE that hits same account twice
14. `no_mercury_proposes_self` — Mercury account can't be its own offset
15. `directive_cash_not_written` — Deprecated `financial_directives.cash_on_hand` not being written
16. `cash_consumers_agree` — Every consumer of cash metric returns same value
17. `revenue_consumers_agree_30d` — 4× weekly revenue ≈ 30d revenue (WARN-only)
18. `runway_consumers_agree`
19. `ar_overdue_consumers_agree`
20. `monthly_pl_uses_gl_revenue` (post-Phase 20J)
21. `contra_revenue_marketplace` (Phase 26-B)
22. `coa_categorization_complete` (Session 26-F)
23. `working_capital_categories_assigned` (Session 26-F)
24. `socf_reconciles_within_tolerance` (Session 28-B, WARN at $150K, intended FAIL at $5K)
25. `socf_uses_whitelist_for_cash_items` (Session 28-B)
26. `mercury_gl_matches_statement_monthly` (Phase 29-F — strict-match at all month-ends)

Plus several others. **🟢 GREEN — comprehensive and battle-tested.**

### Tier 2 (state/drift, daily cron `30 14 * * *`)

State checks: mercury_balance_fresh, last_je_posted age, daily_close_success, cron_lag, review_queue depth, mercury_recon variance. Informational only — never trips read-only.

### Tier 5 (acceptance, monthly cron `0 15 1 * *`)

Three-way replay: GL ≈ orders ≈ QBO archive. Alerts on drift >2%. Phase 20K added this. 🟢 GREEN.

### Failure behavior

- Tier 1 fail → trips `FINANCE_READ_ONLY` flag → JE poster refuses to post → financial_flags table gets a critical row → dashboard shows red banner
- Tier 2 fail → financial_flags entry → no posting block
- Tier 5 fail → email alert

### Pre-deploy gate

`tests/pre-deploy.sh` (Session 11): 4 gates — acceptance tests (90+), deprecation grep, contract tests (Mercury/Square/QBO/Plaid/Gmail/Anthropic), cross-consumer agreement. Hard block on `npm run deploy`.

### Currently disabled / failing

- `socf_reconciles_within_tolerance` is set to WARN at $150K reflecting the known FY2025 unmatched-txn gap. Should become FAIL at $5K when Phase 28-C completes.
- Tier 1 `socf_reconciles_within_tolerance` is the one routinely-failing check at the moment.

**Confidence: 🟢 GREEN overall.** This is the strongest part of the system.

---

## Section 6 — Review Surfaces

### Dashboard

`dashboard/index.html` (8,833 lines, single-page web app) + Cloudflare Pages deploy.
- **Money page** has 5-section accordion: Decisions / Where We Stand / What's Changing / What-If / Books & Tools
- Hero strip: Cash · Runway · This Week Revenue · Breakeven gap
- Drill-down drawer (Session 10) for any $ value
- Sonnet-narrated "How are we?" block at top (page_narrative_refresh cron)
- Ask CFO quick-prompt buttons (chat integration)
- Auth: `X-Pretzel-Auth` header against DASHBOARD_AUTH_TOKEN secret

🟢 GREEN structurally, 🟡 YELLOW usage frequency unknown.

### Daily/weekly emails

| Email | Cron | Content |
|---|---|---|
| Daily morning brief (7:30am MT) | `30 13 * * *` | Sonnet-narrated narrative + scorecard |
| Daily reconciliation (8am MT) | `0 14 * * *` | Mercury vs books variance |
| Weekly directive (Sun 10pm MT) | `0 4 * * 1` | Sonnet strategic brief |
| Weekly digest (Fri 5pm MT) | `0 23 * * 5` | Generic activity digest |
| Mercury IO reminder (28th of month) | `0 14 28 * *` | "Upload latest IO statement" |

🟢 GREEN — emails exist and are wired to cron. Quality of content depends on Sonnet output + data accuracy.

### Anomaly flagging

`finance-issue-surfacer.js` runs daily at 8:15am MT. 8 detectors:
- Vendor anomaly (>1.5× rolling avg with whitelist for recurring patterns like UTAH801)
- Margin drift (>10pp month-over-month, data-quality-aware)
- AR aging slip
- Cash trajectory
- Unusual transaction (>2σ)
- Customer concentration (top 5 > 30%)
- Vendor concentration (top 1 > 40%)
- Pipeline depth (review queue > 50)

Writes to `cfo_issues` table → surfaces in dashboard Issues tile + Decisions inbox.

🟢 GREEN.

### Pending-review surface

- Review queue grouped by counterparty (Books & Tools section)
- Capex pending approval (Decisions inbox)
- Receipts pending (Decisions inbox)
- Late-txn buffer (Session 12 RTR-5) — `late_txn_buffer` table; decision endpoint exists but full reopen-and-repost is stubbed

🟡 YELLOW — surfaces exist but Drew has to remember to look.

---

## Section 7 — Agent / Autonomy Layer

### Is there an "agent" running between sessions?

**No, not in the autonomous-decision-maker sense.** There are 41 cron entries triggering scheduled work, but the work itself is deterministic (sync → categorize via rules → post if confidence≥0.90 → email).

The only Sonnet-powered autonomy points:
1. **Daily morning brief narrative** — Sonnet wraps scorecard data in prose, sends email. Bounded; no actions.
2. **Weekly directive** — Sonnet generates a longer strategic brief weekly. Bounded; no actions.
3. **Page narrative refresh** — Sonnet generates the "How are we?" block daily. Bounded.
4. **Issue surfacer** — Sonnet may rank/explain issues (Haiku for ranking, Sonnet for narrative). Writes to cfo_issues. Bounded.
5. **Receipt processing** — Haiku vision OCR when Drew uploads a receipt. Drew-triggered.
6. **Capex reasoner** — Sonnet recommends capitalize-vs-expense for capex-class txns. Writes to `agent_decisions` but does NOT auto-apply (Drew approval required per v3.1 Q3=B decision).
7. **Chat** — when Drew talks to the agent via dashboard.

### What does the agent do autonomously (no human in loop)?

- Categorize Mercury txns matching rule patterns
- Post JEs at ≥0.90 confidence
- Run depreciation monthly
- Send emails on schedule
- Run Tier 1/2/5 audits
- Sync data (Mercury, QBO, Square, Plaid)

That's it. **No autonomous decisions on novel vendors, no autonomous capex calls, no autonomous reclassifications.**

### Trigger model

100% cron + webhook. There's no event loop, no Drew-session-aware agent that knows "Drew is logged in now, surface X."

### Human review touchpoint

- Daily morning email (passive)
- Dashboard visits (active, when Drew chooses)
- Chat session (when Drew initiates)

### Failure mode if agent makes a bad decision

- Auto-posted bad JE → caught by Tier 1 invariant if structural, otherwise survives in GL until Drew or Tier 5 catches it
- Categorizer rule too broad → mis-categorized txns accumulate in review queue (low-confidence) or auto-post wrong (high-confidence)
- Sonnet hallucination in narrative → factually wrong email, no downstream action since narrative writes to nothing actionable
- Sync failure → trust score component drops, but no automatic rollback

**Confidence: 🟡 YELLOW** — robust failure containment (read-only mode + invariants) but the "agent" framing in the original plan was never fully built. This is a sophisticated scheduled batch system, not an agent.

---

## Section 8 — Technical Debt and Pending Work

### Half-built features (per task ledger + plan)

| Feature | Status | Reference |
|---|---|---|
| Plaid Chase Production connection | Code shipped, prod secrets uncertain | Drew TODO from plan May 13 |
| Mercury Credit (••0000) forward sync | No API path; manual statement upload only | ARCHITECTURE.md known forward gap |
| LEAF exact amortization (vs current 25/75 approximation) | Schedule data exists, splitter wired | Most loans correctly split per Pattern B |
| Cloudflare Access dashboard auth | Pending | Drew TODO from plan |
| Phase 30-D atomic rebuild migration 088 | Incomplete | task list |
| Phase 31-B2 POS Clearing breakdown in SOCF | Pending | task list |
| Phase 31-B3 Clear FY2026 contamination from YE2025 BS | Pending | task list |
| Phase 31-C1 runTier1Filing() check class | Pending | task list |
| Phase 31-C2/C3 Package metadata + pre-deploy gate 5 | Pending | task list |
| 088d LEAF amortization split (post-Pattern-B re-application) | Pending | task list |
| V3-B Smart auto-categorizer (KB + facts + LLM fallback) | Specced, not implemented | v3.1 plan |
| V3-A vendor_kb consultation in categorizer | Table exists, not wired | v3.1 plan |
| Goals tracking | Specced, not built | v3.3 plan |
| Loans tracking dashboard | Specced, not built | v3.3 plan |
| Menu engineering | Specced, not built | v3.3 plan |
| Sales tax filings auto-record | `sales_tax_filings` table empty per Session 23 audit | task |

### Known bugs

- **40 "Dangerous Pretze..." Mercury internal transfers ($118K)** — historically uncategorized; Phase 30 Pattern B addressed by Drew confirming pattern, but forward similar txns may need re-confirmation
- **$167 YE2024 Mercury Credit / CC Clearing variance** — documented in POST_IRENE_REBASELINE.md; immaterial but not closed
- **Partner Investments T&A -$20,000** — sits on QBO YE2025 BS; Irene rebaseline doesn't address; not in our v3 filing position
- **SOCF $150K tolerance** — currently WARN; should be FAIL at $5K but unmatched txn gap blocks
- **Pretzel OS internal NI ($-299,576) ≠ filing NI ($-346,898)** — $47K drift between Pretzel OS books and the v3 filing package because Pretzel OS internal RE absorbs Path A (Phase 26-B close-mirror JE), filing uses Path B presentation

### Stale data / migration issues

- **Migrations are append-only with some duplicate filenames** (096a / 096b / 096c / 096d / 096e / 096f / 096h appear twice in `ls` output — likely just duplicate listings in my grep, but worth verifying)
- **No migration runner** — Drew applies migrations manually via `wrangler d1 execute`
- **Some migrations from prior Sessions (087 → 089a-k, 090, 091a-e, 093, 094, 095, 096a-h)** rapid-fire iterations during Phase 33; not all may have been atomically applied in clean state

### Documentation gaps

- ARCHITECTURE.md is current as of May 13 (RTR-1) — does NOT reflect Phase 30/31/32/33 changes
- No formal Schedule K/L mapping doc
- No month-end checklist
- No "what does each cron actually do" runbook beyond inline comments in wrangler.toml
- POST_IRENE_REBASELINE.md is good but is one-off snapshot, not maintained

### Things blocking "production mode"

1. **Git history**: 1 commit ever. 60+ workers modified in working tree, uncommitted. Disaster recovery story is non-existent.
2. **No source-of-truth for "what's deployed right now"** — wrangler deploys from working tree, not git
3. **No staging environment** — dev = sandbox via wrangler dev; prod = the live deploy. Wrong fix gets shipped in 30 seconds.
4. **No data backups visible** in this assessment — D1 has Cloudflare-side backup retention but no documented export cadence
5. **Auth = single shared secret** ("defense in depth, not real auth" per wrangler.toml comment). Cloudflare Access pending.
6. **Mercury IO Credit forward gap** described above
7. **Plaid Production gap** described above

**Confidence: 🔴 RED on tech debt overall.** Pretzel OS works *today* because Drew built it and knows where the bodies are buried, not because it's documented or sustainable.

---

## Section 9 — What Surprised Me (the honest part)

### 1. The system has no real "agent"

The plan documents repeatedly describe a "CFO Agent" with 38+ tools, autonomous categorization, propose-and-wait capex flow, etc. The reality after 33 phases is **a sophisticated scheduled batch system with Sonnet-narrated email and chat endpoints**. The "agentic" framing was aspirational; what shipped is conventional cron+rules+LLM-wrap.

This isn't a failure — the cron+rules approach is more robust than an LLM-driven categorizer. But it does mean the "weekly oversight, near-real-time, agentic books" framing in Drew's prompt is asking for capabilities that aren't built. There's no autonomous agent making financial decisions between sessions. There's a categorizer that auto-posts known patterns and queues the rest.

### 2. 60+ uncommitted file changes in working tree, 1 git commit ever

`git log --oneline` shows 2 commits total. The "Initial commit — Pretzel OS complete" was followed by *one* commit ("Retail data integrity fix, Square integration, mobile dashboard"). All subsequent work — 100+ workers, 100+ migrations, the entire finance system, Phase 33 — is **uncommitted in the working tree**. If the Cloudflare deploy ever needs to be reverted, there is no "last known good" to revert to. The only state of record is the live D1 + KV + deployed worker version.

This is **the single highest hidden risk** in the system.

### 3. Pretzel OS internal books ≠ filing package books

Phase 33 final state declares NI = $-299,576.15 (Path A internal). The v3 filing package declares NI = $-346,898.53. The $47K delta isn't a bug — it's intentional (filing applies Form 4562 depreciation + Sprinter §179 + tips reclass on top of internal P&L). But it means **Pretzel OS internal state is NOT the books for tax purposes**. Going forward, this gap will widen as 2026 depreciation accrues differently between the two.

If Drew thinks "Pretzel OS is the books," he's mistaken. Pretzel OS is the *transactional* book; Irene's QBO + the filing package is the *tax* book. These have drifted post-Irene-rebaseline.

### 4. Mercury IO Credit (••0000) is a real operational hole

Mercury issues credit cards to itself but doesn't expose them via API. This means the system *cannot* be self-sufficient for forward credit card txn ingestion. The current workaround (monthly reminder email to Drew, manual statement upload) is **brittle and Drew-dependent**. If Drew is sick for 2 months, IO Credit charges go un-recorded.

This was framed in earlier plans as "deferred" but it's structural — Mercury isn't going to add API access just because we want it. A real fix needs either: (a) Plaid integration with Mercury Credit, (b) a Mercury-issued Plaid alternative, or (c) accept the manual workflow and build a strong reminder loop.

### 5. The categorizer has only 30 rules but does most of the work

30 rules is small. The system has been running this way for months. This suggests two things:
- Pretzel's vendor universe is genuinely small (a single restaurant has maybe 50-80 recurring vendors total)
- The categorizer is *successful enough* with rule-only coverage that LLM fallback hasn't been built

But this also means: any new vendor (new food supplier, new service provider) drops into the review queue and stays there until Drew adds a rule. No graceful degradation.

### 6. There is no Schedule K/L mapping

For a system aimed at "near-real-time books" for a partnership filing 1065, the absence of explicit Sched K/L line mapping is striking. Every K-1, every Sched L line gets manually mapped by Irene each year. Pretzel OS could pre-mark each account with its destination line; this would make the filing package generation purely mechanical. It doesn't.

### 7. Phase 33 reconstruction work was extremely expensive — and largely retroactive

33 phases over ~3 months of dev work. Most of that work was *fixing historical books to match an external truth* (the filed 1065, QBO bookkeeper-era data, Toast Payroll GL, Mercury statements). Very little of it was building forward-flow operational capacity. The plan throughout was "reconstruct first, then operationalize" — but reconstruction has dominated, and operationalization (Sessions 24+ that originally promised goals/loans/menu engineering/etc.) keeps getting pushed.

---

## Top 5 Things Working Well (keep as-is)

1. **Mercury Checking + Savings ingestion + strict-match invariants** — cent-accurate at 17 month-ends, daily sync, Tier 1 invariant gates regression. This is the gold standard of the system.
2. **Tier 1 ledger invariants + pre-deploy gate** — 16+ checks running hourly, 4-gate deploy block, deprecation grep. The system can't ship corrupting code without manual override.
3. **Categorizer + idempotent JE poster** — 30 rules cover the high-volume patterns; idempotency means re-runs are safe; review queue catches the rest. Boring and reliable.
4. **Form 4562 depreciation cron + fixed_assets registry** — monthly cron auto-posts depreciation per asset per schedule. Sprinter §179 baked in. Y-2/Y-3 confusion fixed.
5. **The dashboard's accordion + drill-down drawer** — Drew can find any number in 2 clicks. Hero strip + Decisions inbox give 30-second orientation. Even though chat had a streaming bug at one point, the surface is well-designed.

---

## Top 5 Gaps that Block "Weekly-Oversight, Near-Real-Time, Agentic Books"

1. **No autonomous agent loop** — current crons execute deterministic batch logic. For "agentic," there needs to be a Sonnet-driven decision layer that handles novel patterns, escalates ambiguity, and proactively surfaces concerns to Drew. The V3-B smart categorizer + V3-C chat agent specs were never built.

2. **Mercury IO Credit (••0000) forward sync** — no API, manual statement upload pattern. Until this is solved (Plaid integration, alternative card, or automated email parser), forward credit card txn ingestion will lag and require Drew's manual intervention.

3. **Plaid Chase production status uncertain + other personal cards not connected** — if Drew uses Chase Sapphire / Amex personally for any business expense, none of that flows. Need Plaid Production verified + additional cards added OR a documented manual workflow.

4. **Pretzel OS internal books ≠ filing books drift** — post-Irene-rebaseline, the system has 2 versions of the truth: internal Phase 33 books and v3 filing books. Going forward into FY2026, this drift will grow (each month's depreciation, each adjusting JE). Need a reconciliation cron + drift-alert OR pick one source of truth and converge to it.

5. **No vendor master / Sched K-L mapping / accruals discipline** — for "real-time books," need (a) vendor master with KB consultation in categorizer, (b) explicit Sched L mapping so YE statements generate mechanically, (c) AP accrual layer so books aren't pure cash-basis. None of these exist.

---

## Top 3 Hidden Risks (things that work today but are fragile)

1. **🔴 No git history, no backup story.** 60+ uncommitted workers in working tree. If Cloudflare's D1 has data corruption, or if a `wrangler deploy` ships broken code, there's nothing to revert to. The system runs on Drew's working tree being the source of record. **This is the existential risk.**

2. **🟡 Period-lock discipline has eroded through reconstruction-era unlocking.** `closed_periods` exists but every Phase 33 migration unlocked YE2024 / FY2025 to post adjusting JEs. The "books are closed" boundary is a soft norm at this point, not a hard rule. If Pretzel OS becomes operational without re-establishing this boundary, every "minor adjustment" will keep accumulating, the audit trail will fray, and Irene will end up redoing reconciliation work next year.

3. **🟡 Sonnet usage cost is bounded but cost-quality tradeoff is invisible.** AI cost cap is $50/mo enforced. But there's no quality-monitoring on Sonnet output — daily emails might generate hallucinated numbers, scenario engine might produce misleading projections. Tier 1 catches *structural* corruption but not *narrative-quality* drift. If Sonnet starts producing subtly wrong "How are we?" briefs Drew acts on, the system has no automatic guard. (The narrative_csv_consistency check from Session 32 is the only nascent guard here.)

---

## What's NOT in this assessment

- I did not query the live deployed system (no auth token available locally)
- I did not run any new audits or invariants
- I did not benchmark categorizer accuracy on recent txns
- I did not verify Plaid Chase Production status (would need secret access)
- I did not count exact COA rows (would need D1 query)
- I did not audit dashboard usage logs (none exist anyway)

If any of the above changes the picture materially, this assessment should be revised.

---

## Recommended next moves (informational only, not a build plan)

Before any new feature work:
- **Commit current working tree to git** — establish a baseline of "what's deployed today"
- **Document Schedule K/L mapping** — make filing generation mechanical
- **Verify Plaid Chase Production** — single yes/no question with one curl
- **Decide internal-vs-filing book strategy** — converge or formally diverge with documented reconciliation

Then if pursuing "agentic books":
- Build the smart categorizer (V3-B) so novel vendors don't dead-end in review queue
- Wire vendor_kb into the categorizer decision path
- Add Sonnet-driven exception escalation (daily summary of items the rules didn't handle, with proposed categorization + reasoning)
- Re-establish period-lock discipline (no unlock without audit log entry + Drew approval)

End of assessment.
