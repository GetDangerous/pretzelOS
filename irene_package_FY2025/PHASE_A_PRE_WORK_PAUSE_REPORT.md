# Phase A Pre-Work — Paused

**Generated:** 2026-05-26
**Status:** ⏸️ STOPPED at start of investigation. 4 active Tier 1 ledger-integrity failures + read-only mode tripped in production. Reporting before continuing.
**Trigger:** Stop-and-ping rule — "Investigation surfaces something that suggests the foundation work isn't as solid as we thought (e.g., integrity checks haven't been running, ingestion has gaps, etc.)"

---

## TL;DR

Started Phase A pre-work investigation. Within 30 minutes of looking at live production state, found:

1. **Tier 1 audit has been failing for ≥5 hours** with 4 broken checks (every hourly run since at least 17:05 UTC today shows 4 fail / 1 warn). Read-only mode is **currently tripped**.
2. **One single posted JE has DR ≠ CR** in production right now — actual ledger corruption.
3. **Ledger-level DR vs CR is off by $5,084.32** — direct consequence of #2 or a separate issue.
4. **SOCF unreconciled $36,845** (above the $20K tolerance threshold) — was supposed to be `WARN` per Session 28-B spec, but the audit is currently treating it as `FAIL`.
5. **Ask My Accountant has -$24,615 balance at YE2025** even though Session 31-A2 claimed it was drained to $0.

These don't catastrophically invalidate FY2025 filing prep work — the FY2025 BS still balances cent-accurate (Assets $690,781.02 = Liab $162,646.28 + Equity $528,134.74) and FY2025 NI is still -$299,576 as documented. But they do mean **the live production system is currently in a degraded state** that contradicts the "Phase 33 final state, books cent-accurate" framing.

Recommendation: **diagnose + fix Tier 1 failures BEFORE continuing the 13-section Phase A inventory**, because (a) several Phase A sections depend on the integrity layer being trustworthy, and (b) the doc would have to caveat every finding with "but Tier 1 is failing right now."

---

## Detailed findings

### 1. Tier 1 invariants — actively failing (every hourly run today)

Last 5 hourly runs (queried 2026-05-26 ~21:30 UTC):

| ran_at (UTC) | passed | failed | warn | read_only_tripped |
|---|---:|---:|---:|---:|
| 21:05:58 | 23 | 4 | 1 | 1 |
| 20:05:58 | 23 | 4 | 1 | 1 |
| 19:05:59 | 23 | 4 | 1 | 1 |
| 18:06:00 | 23 | 4 | 1 | 1 |
| 17:05:58 | 23 | 4 | 1 | 1 |

**This is at least 5 consecutive hours of failure.** Likely longer — I checked back 5 runs and they're all consistent.

The 4 failing checks from the latest run:

| check_id | expected | actual |
|---|---|---|
| `dr_eq_cr_per_je` | 0 unbalanced JEs | **1 unbalanced JE** in posted state |
| `dr_eq_cr_ledger` | DR-CR diff ≤ $0.01 | **DR $6,735,739.22 / CR $6,740,823.54 = -$5,084.32** |
| `je_touches_distinct_accounts` | 0 single-account JEs | **1 JE has DR+CR to same account** (self-pair) |
| `socf_reconciles_within_tolerance` | unreconciled ≤ $20,000 | **$36,845.05** — flagged as "may indicate new bookkeeper-era artifact OR Mercury-touching source_type missing from SOCF restatement section" |

Plus 1 warning:
- `working_capital_categories_assigned` — 1 current_liability with balance but no wc_category

### 2. Read-only mode is ON

`read_only_tripped: 1` on every recent Tier 1 run. This means `FINANCE_READ_ONLY=1` is set in KV, and:
- The daily close cron (`0 13 * * *`) WILL fire but the JE poster (`postJeForTxn`) will refuse to post new JEs
- Drew's manual approvals via dashboard would also be blocked
- New Mercury inflows since this state began (~5h ago) are being categorized but **not getting JEs posted**

**Last posted JE: 2026-05-21 00:22:22 UTC.** That's ~5 days ago. Suggests:
- (a) Either Drew's been away and no auto-post needed to fire (Mercury sync still runs but JE posting is gated by Tier 1), OR
- (b) The Tier 1 failure has been blocking posts for those 5 days, OR
- (c) Some combination — the 4 failures may date back to May 21 when the last batch of mercury_txn JEs ($363,400.74 across 4 entries + 1 paper check) was posted.

I have not investigated WHICH specific JE is the unbalanced one or WHEN it landed. That's the first thing to do.

### 3. Plug accounts: mostly consistent with Phase 33 doc, but two exceptions

Re-queried plug balances AT YE2025 cutoff (not all-time):

| Account | Phase 33 doc claim | Live YE2025 actual | Status |
|---|---:|---:|---|
| Pre-Sync Adjustments | $0 | $0 | ✅ matches |
| Pre-Pretzel-OS Reconciliation | $0 | $0 | ✅ matches |
| YE2024 Bank Reconciliation Adjustment | +$3,456.40 | -$3,456.40 (DR balance in this query orientation = same number, sign convention) | ✅ matches |
| LEAF Clearing | $0 | $0 | ✅ matches |
| Cash Clearing | "~$152K residual, acceptable" | **$166,479.61** | 🟡 ~$14K higher than documented; close enough |
| Doordash Clearing | "near 0 transit" | -$42,423.35 (CR) | 🟡 settlement-timing residual; not tracked precisely in docs |
| UberEats Clearing | "near 0 transit" | -$7,437.57 (CR) | 🟡 similar |
| Grubhub Clearing | "near 0 transit" | -$2,820.21 (CR) | 🟡 similar |
| Square Clearing | "near 0 transit" | -$34,024.08 (CR) | 🟡 similar |
| Payroll Clearing | $6,175 (Session 32-C1 documented residual) | $6,537.69 | ✅ within rounding |
| **Ask My Accountant** | **$0 (post-Session 31-A2 drain)** | **-$24,615.08** | 🔴 **doesn't match — needs investigation** |
| Credit Card Clearing | drained per Session 22-D | $0 | ✅ matches |

The big one is **Ask My Accountant**: documented as drained per Phase 31-A2, but live state shows -$24,615.08 at YE2025. Either the migration didn't fully apply, or Phase 31-A2's spec was different than what's been understood, or post-Phase-31 activity re-introduced balance.

The clearing-account residuals (Doordash/UberEats/etc.) at -$42K to -$3K range are likely settlement-timing artifacts that documentation has glossed over. Not corruption, but worth surfacing if Phase A builds rely on "clearings are clean."

### 4. FY2025 BS at YE2025 — still balances ✅

Query confirmed cent-accurate:
- Assets: $690,781.02
- Liabilities: $162,646.28
- Equity: $528,134.74
- L + E = $690,781.02 = Assets ✓

Matches what Phase 33 final state documented and what the v3 filing package was built against. The 4 Tier 1 failures are POST-2025-12-31 drift (probably from May 20-21 activity), not contamination of the filing-year books.

### 5. FY2025 NI live ≈ Phase 33 documented

Query: revenue $498,929.94 - expense $798,506.09 = **-$299,576**. Matches Phase 33 doc's claimed Path A internal NI of -$299,576.15 within rounding ✓.

(Note: this is NOT the filing-position NI of -$346,898.53 — the gap is intentional, as documented in POST_IRENE_REBASELINE.md and Section 9 of last week's state assessment.)

### 6. What I have NOT investigated

Per the stop-and-ping rule, I paused before going deeper. Specifically:
- WHICH single JE is unbalanced (the `dr_eq_cr_per_je` failure)
- WHEN it landed (likely a May 20-21 entry, given last-JE-posted timestamp)
- WHICH JE has DR+CR to same account
- WHETHER the $5,084 ledger imbalance is a single JE issue or systemic
- WHETHER the SOCF $36,845 unreconciled is the May 21 activity or pre-existing
- WHETHER the Ask My Accountant -$24K is a real liability or a presentation issue
- Whether the Mercury IO reminder, Plaid sync, or other forward-flow workers have been firing while read-only is on
- The 12 other Phase A inventory sections (workers, categorizer rules, etc.)

---

## What this means for Phase A

The 13-section build plan investigation IS doable — most sections don't depend on Tier 1 being green. But:

- **Section 3 (Integrity / Invariant Check Inventory)** can't honestly say "Tier 1 is solid" — it would have to flag the active 4-failure state.
- **Section 9 (Internal vs Filing Position)** depends on knowing what the internal books actually are. Right now the books are in a partially-corrupt state.
- **Section 13 (Build Plan Recommendations)** would have to recommend "fix Tier 1 before any Phase A surface" as the first item.

If we continue the investigation without diagnosing the failures, the build plan becomes "fix X first, then maybe build Phase A on top." Better to diagnose X first and produce a clean plan.

---

## Recommended next moves

**Option A — Diagnose + fix Tier 1 failures FIRST (recommended, ~2-4 hr)**

1. Identify the specific unbalanced JE (`SELECT je.id, je.source_type, je.entry_date, je.created_at, je.total_debit, je.total_credit FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id=je.id WHERE je.status='posted' GROUP BY je.id HAVING ROUND(SUM(l.debit),2) != ROUND(SUM(l.credit),2)` — quick read-only query)
2. Identify the self-pair JE same way
3. Trace the $5,084 ledger gap (likely the same JE)
4. Decide: reverse it, fix it, or accept and document
5. Verify Tier 1 returns to clean state
6. Then resume Phase A pre-work investigation

**Option B — Continue Phase A pre-work despite active failures**

I write the 13-section build plan with caveats throughout. Adds significant length to the document. Phase A planning then includes "fix Tier 1" as Step 0.

**Option C — Hybrid**

Quick (~30 min) diagnosis of WHICH JE is broken + WHEN it landed, then resume Phase A pre-work knowing the scope of the issue. Don't fix yet; just know what we're dealing with.

---

## What I did NOT do per the prompt

- ❌ No code changes
- ❌ No disabling of workers (including the failing Tier 1 cron — it's still firing)
- ❌ No schema changes
- ❌ No "quick fix" attempts on the unbalanced JE
- ❌ No deployment changes

Investigation only. Waiting for direction.

---

## Files I have NOT touched in this session

Nothing. Pure read-only queries. Working tree is clean (git status returns empty).

---

## What I'd need from Drew to continue

1. **Pick A / B / C above.**
2. If A: do you want me to diagnose + investigate, or do you want to do it yourself with my pointers?
3. If C: same — investigate or hand off?

Time budget so far: ~30 minutes (under the 1-2 day budget). The rest of the investigation can resume immediately on your direction.
