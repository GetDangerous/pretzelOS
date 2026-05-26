# DIF-1 Inventory (May 13, 2026)

Comprehensive scan of the workers/ codebase for data-integrity drift points.
Produces the punch list that DIF-2 through DIF-7 close.

Status legend:
- ✅ Already correct
- ⚠️ Needs fix in this DIF cycle
- 🚧 Architectural risk; address in later phase

---

## 1. Anthropic API Call Sites (DIF-3 targets)

**29 direct fetches need wrapping through `callAI()` in workers/ai-budget.js.**

### ✅ Already WIRED through ai-budget.js (6 sites)

| File:Line | Model | Use case |
|---|---|---|
| workers/chat-worker.js:439 | resolved via callAI | Chat routing + streaming |
| workers/finance-capex-reasoner.js:122 | resolved via callAI | Capex reasoning |
| workers/finance-cfo-categorizer.js:229 | haiku-4-5 | Novel-vendor categorization |
| workers/finance-email-briefs.js:301 | sonnet-4-6 | Daily morning brief narrative |
| workers/finance-receipts.js:25 | resolved via callAI | Receipt vision extraction |
| workers/finance-weekly-directive.js:149 | sonnet-4-5 | Weekly directive narrative |

### ⚠️ DIRECT fetches (29 sites — must wire in DIF-3)

| File:Line | Model hardcoded | Use case | Priority |
|---|---|---|---|
| workers/account-worker.js:1374 | haiku-4-5-20251001 | Check-in email | M |
| workers/account-worker.js:1594 | sonnet-4-6 | Churn risk analysis | M |
| workers/account-worker.js:3008 | haiku | Monday digest curation | H |
| workers/catering-agent.js:136 | sonnet-4-6 | Catering review summary | M |
| workers/catering-agent.js:1243 | sonnet-4-6 | Availability planning | M |
| workers/catering-agent.js:1481 | sonnet-4-6 | Event scheduling | M |
| workers/catering-agent.js:1530 | sonnet-4-6 | Catering proposal draft | M |
| workers/catering-agent.js:1742 | haiku-4-5-20251001 | Cost optimization | L |
| workers/cfo-agent.js:371 | sonnet-4-6 | API health check (1 sentence; should be Haiku) | L |
| workers/cfo-agent.js:1404 | sonnet-4-6 | Financial decision support | H |
| workers/coach-agent.js:307 | sonnet-4-6 | Sales coaching | L |
| workers/finance-audit-engine.js:1145 | haiku-4-5 | Audit log analysis | M |
| workers/optimizer-worker.js:235 | sonnet-4-6 | Next-action optimization | M |
| workers/outreach-agent.js:1056 | sonnet-4-6 | Venue outreach generation | M |
| workers/outreach-agent.js:2504 | sonnet-4-6 | Outreach email drafting | H |
| workers/outreach-agent.js:2962 | sonnet-4-6 | Outreach copy review | M |
| workers/outreach-agent.js:3159 | sonnet-4-6 | Response generation | M |
| workers/outreach-agent.js:3377 | haiku-4-5-20251001 | Outreach evaluation | L |
| workers/pilot-tracker-worker.js:204 | sonnet-4-6 | Pilot status tracking | M |
| workers/qbo-webhook-worker.js:569 | haiku-4-5-20251001 | QB transaction notes | M |
| workers/qualifier-worker.js:349 | haiku-4-5-20251001 | Lead qualification | M |
| workers/rep-enablement-worker.js:98 | sonnet-4-6 | Rep coaching content | L |
| workers/reply-handler-worker.js:893 | haiku-4-5-20251001 | Email reply generation | H |
| workers/retail-agent.js:1004 | sonnet-4-6 | Retail transaction analysis | M |
| workers/retail-agent.js:1428 | haiku-4-5-20251001 | Product recommendation | L |
| workers/retail-agent.js:2716 | sonnet-4-6 | Inventory optimization | M |
| workers/retail-agent.js:2925 | sonnet-4-20250514 | Verdict generation | M |
| workers/retail-agent.js:3195 | sonnet-4-6 | Performance review | M |
| workers/scout-worker.js:432 | haiku-4-5-20251001 | Venue discovery | M |

**Top file priorities (where most rewiring lands):**
1. workers/outreach-agent.js — 5 sites
2. workers/retail-agent.js — 5 sites
3. workers/catering-agent.js — 5 sites
4. workers/account-worker.js — 3 sites
5. workers/cfo-agent.js — 2 sites

---

## 2. Cash/Revenue Computation Drift

**✅ NO drift detected.** All display paths through canonical helpers.

### Verified canonical-helper consumers

- workers/account-worker.js (line 25, 1465-1467)
- workers/chat-worker.js (lines 650-652, 915-916, 1008-1010)
- workers/finance-worker.js (line 21, 1227-1237) — API endpoint owner
- workers/finance-scorecard.js (lines 19-22, 31-32, 176, 214)
- workers/cfo-agent.js (lines 49, 654, 932-934)
- workers/finance-weekly-directive.js
- workers/finance-scenario.js
- workers/finance-cashflow.js
- workers/cfo-pulse-worker.js
- workers/finance-audit-engine.js

### Direct SUMs (all legitimate — backend/audit, not display)

- workers/finance-shared.js:117 — internal helper computation (canonical)
- workers/finance-breakeven.js:55,69 — breakdown for the breakeven model
- workers/finance-monthly-close.js:43,81,107,134,154 — P&L rollup at close
- Plus 8 audit/categorization paths

### ✅ Deprecated fields status

| Field | Status |
|---|---|
| `financial_directives.cash_on_hand` | ✅ Zero live reads. Write path removed in Phase 2. |
| `cfo_briefs.content` | ✅ Historical/email only; not consulted for live numbers |
| `mercury_accounts.current_balance` | ✅ Wrapped by getCanonicalCashOnHand 5-min-TTL helper |

**DIF-2 implication:** The canonical-truth registry is largely a documentation exercise — the code is correct. The Tier 1 cross-consumer check still belongs (it catches FUTURE drift).

---

## 3. Hardcoded Model IDs (DIF-3 + DIF-4)

40+ hardcoded `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` strings.

| File | Count | Lines (sample) |
|---|---|---|
| workers/retail-agent.js | 6 | 1012, 1436, 2933, 3203, 3557, 9377 |
| workers/catering-agent.js | 5 | 144, 1251, 1489, 1538, 1745 |
| workers/outreach-agent.js | 5 | 1059, 2512, 2970, 3167, 3385 |
| workers/account-worker.js | 3 | 1382, 1602, 3016 |
| workers/chat-worker.js | 2 | 542, 578 (in addition to wired path) |
| workers/reply-handler-worker.js | 2 | 355, 415 |
| workers/finance-cfo-categorizer.js | 1 | 20 (HAIKU_MODEL const) |
| workers/finance-audit-engine.js | 1 | 1153 |

**DIF-3 closes this:** every site routed through `callAI()` reads model from KV (`ACTIVE_SONNET_MODEL` / `ACTIVE_HAIKU_MODEL`), so model rotation = one KV update, zero code change.

**DIF-4 closes this:** `tests/deprecation.test.sh` greps for the literal model strings outside `workers/ai-budget.js`. Build fails if any exist.

---

## 4. External API Contract-Test Targets (DIF-5)

6 external APIs to capture fixtures + write schema contract tests for:

| API | Files using it | Key fields read |
|---|---|---|
| Mercury | workers/mercury-client.js | id, amount, counterpartyName, postedAt, status |
| Square | workers/square-sync-worker.js, workers/finance-square-extract.js, workers/square-labor-sync.js | id, total_money.amount, tenders, state, source.name |
| QBO/Intuit | workers/qbo-client.js, workers/qbo-webhook-worker.js, workers/finance-qbo-extract.js | Id, TxnDate, TotalAmt, Line[].AccountBasedExpenseLineDetail.AccountRef |
| Plaid | workers/plaid-client.js, workers/plaid-webhook.js | item_id, accounts[].balances.current, added/modified/removed arrays |
| Gmail | workers/finance-email-briefs.js, workers/approval-mailer.js | access_token, message.id |
| Anthropic | workers/ai-budget.js (centralizing in DIF-3) | content[0].text, usage.input_tokens, usage.output_tokens |
| Apollo (lead gen) | workers/scout-worker.js, workers/outreach-agent.js, workers/catering-agent.js | results, organizations, people_list |
| Swell CX | workers/account-worker.js, workers/outreach-agent.js | contact, invite.id |

---

## 5. Timezone Hazards (DIF-6 advisory)

15+ date calculations mix UTC ISO with local-time methods. Sample:

| File:Line | Pattern | Risk |
|---|---|---|
| workers/finance-shared.js:357-358 | `toISOString().split('T')[0]` + `getMonth()+1` | DST + UTC vs local mix |
| workers/finance-ar-aging.js:40,137 | `new Date()` then math with UTC dates | Off-by-hours on day boundary |
| workers/square-labor-sync.js:95-96 | `Date.now() - lookbackDays * 86400000` | Assumes UTC |
| workers/finance-email-briefs.js:407 | `toLocaleDateString` no TZ | Renders in server-default TZ |
| workers/finance-cfo-tools.js:379 | `setUTCMonth()` | ✅ correct; pattern to standardize on |

**DIF-6 mitigation:** Add `workers/finance-time.js` with `mtBoundsForDate()` + `mtToday()` + `mtNow()` helpers. Migrate over time as files are touched. Not blocking for this DIF cycle.

---

## 6. Counterparty Matching Brittleness (advisory)

12+ SQL LIKE clauses with hardcoded vendor name fragments. Highest concentration:

| File | Pattern |
|---|---|
| workers/finance-breakeven.js:182-193 | LOWER LIKE for mercury / wells / chase / payroll / etc. |
| workers/finance-cfo-tools.js:91 | LIKE '%leaf%' OR '%lease%services%' |
| workers/finance-shared.js:133-136 | Duplicated vendor LIKE filters |
| workers/finance-trends.js:69-72 | Same LIKE filters |
| workers/finance-cfo-categorizer.js:66, 155 | /mercury\|transfer/i regex |

**Risk:** "Sysco Corporatio" (truncated) vs "Sysco Corporation" — exact-match queries miss; LIKE %sysco% could match "Sysco Specialty Foods" or "Cysco" by accident.

**DIF-6 mitigation later:** Centralize a `vendor_aliases` table; vendor_kb normalization function (`normalizeVendorName`) becomes the only canonical name resolver. Not blocking; defer to a v3.6 phase after DIF + RTR + UX ship.

---

## 7. Closed Period / Race Conditions (RTR-4 territory)

Multiple writers to `closed_periods` + `cfo_briefs`:

| File:Line | Operation |
|---|---|
| workers/finance-monthly-close.js:225,239 | INSERT OR IGNORE closed_periods + SELECT |
| workers/finance-je-poster.js:52 | SELECT period lock state |
| workers/finance-opening-balance.js:328 | INSERT OR IGNORE closed_periods |
| workers/finance-cfo-tools.js:280,295 | INSERT cfo_briefs |
| workers/finance-weekly-directive.js:176 | INSERT cfo_briefs |
| workers/finance-reconciliation-memo.js:495 | INSERT cfo_briefs |
| workers/finance-audit-engine.js:1104-1105 | Validates closed_periods index |

**Recommendation:** RTR-3 (recompute-safe close) + RTR-4 (atomic period boundary) explicitly address this. INSERT OR IGNORE handles duplicates idempotently; D1 BEGIN IMMEDIATE wraps are added in RTR-4.

---

## 8. Square Edge Cases (advisory)

Tip / service charge / discount / fee handling is not fully reconciled:

| File:Line | Field | Risk |
|---|---|---|
| workers/finance-square-extract.js:99-102,124 | `tipMoney`, `discMoney`, `feeMoney`, `net_amount` | net = totalMoney - taxMoney (ignores tip/discount/fee in some paths) |
| workers/square-sync-worker.js:365-387 | `o.discounts[]` | Loyalty-discount naming collisions possible |
| workers/retail-agent.js:8698-8740 | `createSquareDiscount` | No refund-tracking on redemption |

**Defer:** outside DIF-7 scope; capture in `KNOWN_GAPS.md` for v4.

---

## Action Items for Session 7

### DIF-2 (next, ~2hr)
- [ ] Create `workers/finance-canonical-truth.js` that re-exports the canonical helpers under a single `CANONICAL.{cash, revenue, runway, burn}` registry
- [ ] Add Tier 1 invariant `cash_consumers_agree` (cross-consumer check)
- [ ] Add Tier 1 invariant `revenue_consumers_agree_30d`
- [ ] Acceptance test: both invariants pass

### DIF-3 (after, ~2hr)
- [ ] Wire all 29 direct Anthropic fetches through `callAI()`. Group by file:
  - retail-agent (5 sites)
  - outreach-agent (5 sites)
  - catering-agent (5 sites)
  - account-worker (3 sites)
  - cfo-agent (2 sites)
  - One-offs: chat-worker (2 extra), reply-handler (2), pilot-tracker, qualifier, qbo-webhook, optimizer, scout, coach, rep-enablement, finance-audit-engine, retail-agent verdict-gen
- [ ] Acceptance test: `ai-cost-breakdown` shows by-use-case counts for at least 5 distinct cases after invocation

### DIF-4 (after, ~1.5hr)
- [ ] `tests/deprecation.test.sh` — greps for:
  - `financial_directives.cash_on_hand` reads anywhere
  - Direct `fetch('https://api.anthropic.com'` outside `workers/ai-budget.js`
  - Hardcoded `claude-sonnet-4-6` / `claude-haiku-4-5` outside `workers/ai-budget.js`
- [ ] Wire into `tests/acceptance.test.sh` so it runs pre-deploy
- [ ] Acceptance test: deprecation.test.sh exits 0 when no violations

### Carry-over to later phases
- DIF-5 contract tests → Session 11
- DIF-6 timezone helpers + vendor alias table → Session 11 / v3.6
- DIF-7 deploy gate → Session 11
- Square edge cases + closed_periods race → RTR sessions 12-14
