# JE-Posting Paths Catalog (Day 2 Step 1 — Phase A Week 1)

**Generated:** 2026-05-27 (Day 2)
**Method:** Grep across `workers/*.js` for `INSERT INTO journal_entries` and `INSERT OR (IGNORE|REPLACE) INTO journal_entries`. Cross-reference against cron schedule + finance-worker.js import graph.
**Status:** Read-only investigation. No refactoring.

## TL;DR

**Total worker files with JE INSERT: 27** (exceeds the 15-file "flag" threshold from prompt)

**However, the breakdown is:**
- **9 active going-forward paths** — need audit_trail integration
- **18 dormant Phase 33 reconstruction / one-time workers** — no cron, no active endpoints; will not fire forward unless explicitly invoked

**Recommendation:** wrap audit_trail around the 9 active paths only. Document the 18 dormant. If any dormant worker is re-activated for a future cleanup or backfill, audit_trail wrapping is added at that time.

**Decision needed from Drew before Task B1 can proceed past schema design:**
- (a) Wrap all 27 paths (more thorough, ~3-4 days of refactoring)
- (b) Wrap only the 9 active paths (recommended, ~1 day of refactoring) + add a Tier 1 invariant `audit_trail_covers_active_writers` to prevent regression
- (c) Wrap the 9 active + reserve a `pre_phase_a` actor for any future-activated dormant worker's first JE (they auto-write audit_trail on next invocation)

---

## Section 1 — Active going-forward JE-posting paths (9 files)

These fire on cron OR via active HTTP endpoints from `finance-worker.js`. Need audit_trail wrapping for Surface 7 to work properly.

| # | File | INSERT line(s) | Posts what kind of JE | Triggered by | Current error handling |
|---|---|---|---|---|---|
| 1 | `finance-je-poster.js` | 130, 266 | Categorizer-driven JEs (per-txn from Mercury+Chase) AND manual single-txn post | `cfo_daily_close` cron + endpoints `/finance/cfo/post-jes`, `/finance/cfo/post-jes-one`, `/finance/cfo/reverse-je` | Try-catch wraps; on failure rolls back via D1 batch; logs to `finance_audit_log` |
| 2 | `finance-cfo-tools.js` | 127 | Manual reconciliation + loan principal JEs (createLoan, processLoanPayments, runDailyReconciliation) | Endpoints `/finance/cfo/loans/*`, `/finance/cfo/daily-recon` | Try-catch; idempotent on `source_type` + `source_id` |
| 3 | `finance-monthly-close.js` | 220 | Monthly close JE (P&L roll to RE, fiscal year close) | `cfo_monthly_close` cron (`0 12 1 * *`) + endpoint `/finance/cfo/monthly-close` | Period gate (RTR-4 5-day grace); refuses if gate fails; recompute path posts reversal then re-post |
| 4 | `finance-monthly-depreciation-cron.js` | 111 | Monthly per-asset depreciation accrual | `monthly_depreciation` cron (`0 9 1 * *`) | Idempotent on `source_id = {asset_id}-{period}`; logs to console; failures don't block other assets |
| 5 | `finance-fy2026-depreciation.js` | 107 | FY2026 forward depreciation (12 monthly JEs upfront) | Manual one-shot endpoint `/finance/depreciation/fy2026/post` | Idempotent on `source_id`; partial-application safe |
| 6 | `finance-leaf-amortization-splitter.js` | 306 | Per-Mercury-LEAF-outflow Principal/Interest/Tax split | Called from categorizer hook (postJeForTxn for LEAF txns) | Tolerates rounding ≤ $0.05; idempotent on Mercury txn ID |
| 7 | `finance-capex-flagger.js` | 195, 241 | Capex capitalization JE (capex candidate → fixed_asset + capitalize JE) | Endpoint `/finance/capex/capitalize`, `/finance/capex/reject` | Try-catch; writes to `fixed_assets` table + JE; reject path doesn't post |
| 8 | `finance-chase-ink-statement.js` | 217 | Chase Ink statement CSV import (one JE per charge) | Endpoint `/finance/chase-ink/upload-statement` (manual CSV upload) | Idempotent on `source_id = chase_charge_id`; per-row error log; doesn't halt batch on single failure |
| 9 | `finance-mercury-io-statement.js` | 244 | Mercury IO Credit (••0000) statement manual upload | Endpoint `/finance/mercury-io/upload-statement` (monthly manual) | Same pattern as #8 |

**Sub-total: 9 active paths.** Plus `mercury-client.js` which only UPDATEs status (no INSERT — would need audit_trail entry for reversals only, simpler integration).

## Section 2 — Dormant Phase 33 reconstruction workers (18 files)

These are one-time use during Phase 33 or earlier. NOT in any cron, NOT in any active HTTP endpoint. They sit in-tree for audit-trail reasons (the JEs they posted in Phase 33 are still in the GL).

| # | File | Last fired | Purpose |
|---|---|---|---|
| 10 | `finance-bookkeeper-tips-tax-accrual.js` | Phase 26-B | Tips/tax accrual reconstruction (one-time) |
| 11 | `finance-expense-reconstruction.js` | Phase 21V | QBO P&L truth alignment per-month (one-time per period) |
| 12 | `finance-gl-reconstruction.js` | Phase 20 | Monthly QBO P&L truth reconstruction |
| 13 | `finance-mercury-credit-ingest.js` | Phase 21V | Mercury IO Credit historical from QBO archive |
| 14 | `finance-opening-balance-seed.js` | Phase 33-C | YE2024 OB cent-accurate to filed 1065 |
| 15 | `finance-opening-balance.js` | Utility | Manual OB preview/probe (not in production cron) |
| 16 | `finance-pos-direct.js` | RTR-6 cutover OFF | POS-direct revenue recognition (built, dormant) |
| 17 | `finance-qbo-je-ingest.js` | Phase 21V | QBO archive JournalEntry import |
| 18 | `finance-revenue-sweep.js` | Retired (RTR-2) | Old sweep model — replaced by RTR-2 orders-canonical |
| 19 | `finance-sales-tax-reclass-rebuild.js` | Phase 33 | Sales tax reclass historical |
| 20 | `finance-session-24-cleanup.js` | Session 24 | One-time Session 24 cleanup |
| 21 | `finance-square-payroll-reconstruction.js` | Manual upload (rare) | Square Payroll xlsx ingestion. **Could be re-activated** going forward as needed |
| 22 | `finance-square-reconstruction.js` | Phase 33 | Square POS reconstruction (historical) |
| 23 | `finance-toast-payroll-reconstruction.js` | Phase 30 Pattern B | Toast Payroll reconstruction per check_date. **Could be re-activated** if more historical Toast cycles need posting |
| 24 | `finance-toast-reconstruction.js` | Phase 33 | Toast revenue reconstruction (historical) |
| 25 | `finance-toast-sales-pos-reconstruction.js` | Phase 33 | Toast Sales Summary export ingestion |
| 26 | `finance-uline-reclass.js` | Phase 33 | Uline supplies reclass |
| 27 | `finance-wholesale-reconstruction.js` | Phase 33 | Wholesale revenue reconstruction (QBO Invoice path) |

**Sub-total: 18 dormant.**

## Section 3 — Recommendation for Task B1

**Recommended approach (Option B from TL;DR):**

Wrap audit_trail around the **9 active paths** only. For each active worker, the integration is consistent:

```js
// PSEUDO-CODE for the wrapping pattern
async function postJeWithAudit(env, jeData, options) {
  // 1. Existing JE INSERT logic (unchanged)
  await env.DB.prepare('INSERT INTO journal_entries (...) VALUES (...)').bind(...).run();
  await env.DB.prepare('INSERT INTO journal_entry_lines (...) VALUES (...)').bind(...).run();

  // 2. NEW: write audit_trail entry
  await writeAuditEntry(env, {
    actor: options.actor || 'system:' + options.source_type,
    action_type: 'post_je',
    entity_type: 'journal_entry',
    entity_id: jeData.id,
    after_state: { je_id: jeData.id, total_debit, total_credit, source_type, source_id },
    source_metadata: options.metadata || null,
    related_je_id: jeData.id,
  });
}
```

For the 18 dormant workers, add a Tier 1 invariant `audit_trail_covers_active_writers` that:
- Lists every JE created post-deploy by source_type
- Verifies each has at least one matching audit_trail entry
- Fails (warns) if a JE was posted without an audit entry

This means: if any dormant worker IS re-activated and starts posting, the invariant catches it on the next hourly run. Drew gets a clear signal to wrap that worker too.

**Why this is safer than wrapping all 27:**
- ~1 day of refactoring vs ~3-4 days
- Doesn't touch Phase 33 reconstruction workers (which produced filing-ready books — leave them alone)
- Tier 1 invariant catches regression automatically
- Forward-flow audit coverage is what matters for Phase A surfaces

## Section 4 — Decision needed from Drew

- (a) **Wrap all 27 paths** (3-4 days, thorough, includes dormant)
- (b) **Wrap 9 active + Tier 1 invariant** (1 day, recommended)
- (c) **Wrap 9 active + add `pre_phase_a` retroactive audit** (1.5 days; back-fills audit_trail entries for the ~2,632 existing posted JEs with `actor='pre_phase_a_legacy'` so Surface 7 timeline is complete from project inception)

Choice impacts Day 3 plan. If (a): B1 extends to Day 4. If (b): B1 fits Day 3. If (c): B1 extends ~0.5 day past (b).

## Section 5 — Detailed line references for B1 implementation

Each of the 9 active workers has 1-2 INSERT locations:

```
workers/finance-je-poster.js:130              — postJeForTxn batch insert
workers/finance-je-poster.js:266              — reverseJe path
workers/finance-cfo-tools.js:127              — manual + loan posting
workers/finance-monthly-close.js:220          — close JE
workers/finance-monthly-depreciation-cron.js:111  — depreciation
workers/finance-fy2026-depreciation.js:107    — fy2026 dep
workers/finance-leaf-amortization-splitter.js:306 — LEAF split
workers/finance-capex-flagger.js:195, 241    — capex JE + reversal
workers/finance-chase-ink-statement.js:217   — Chase Ink statement
workers/finance-mercury-io-statement.js:244  — Mercury IO statement
```

Total INSERT sites in active paths: **11** (matches PHASE_A_BUILD_PLAN.md estimate exactly).

## Conclusion

The 27-file count looks alarming but isn't architectural sprawl. It's 9 active + 18 dormant. The active set matches Drew's original 11-site estimate from the build plan. Path forward is clean once Drew picks (a)/(b)/(c).
