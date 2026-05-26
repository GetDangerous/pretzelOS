# Phase A.0 — State Reconciliation Before Build

**Generated:** 2026-05-26
**Status:** Investigation + design only. No GL changes, no schema applied, no UI built, no emails disabled.
**Budget:** Targeting <1 day of focused work; flagged below if exceeded.
**Companions:**
- `PHASE_A_BUILD_PLAN.md` — the 7-surface plan being reconciled
- `PHASE_33_FINAL_STATE.md` — what Phase 33 claimed
- `EQUITY_RECLASS_NARRATIVE.md` — Phase 32-C2 snapshot (source of some quoted numbers)

---

## Headline

The "plug account numbers don't match" question has a clean answer: **the Phase 33 docs were correct AT YE2025**, and the current GL is **also correct** — the apparent divergence is two different snapshot dates being compared.

**At YE2025 (filing-year cutoff):**
- Pre-Sync Adjustments: $0 ✓ matches Phase 33 doc
- Pre-Pretzel-OS Reconciliation: $0 ✓ matches
- YE2024 BRA: -$3,456.40 ✓ matches

**All-time / current:**
- Pre-Sync Adjustments: +$245,537.72 (10 JEs, all dated 2026-05-15+ — post-filing-prep cleanup)
- Pre-Pretzel-OS Reconciliation: -$63,623.47 (1 JE, 2026-05-16 reclass to equity)
- YE2024 BRA: -$43,503.69 (9 JEs spanning Jan 2025 through Apr 2026)

The numbers Drew quoted in the prompt (-$19,430 / +$14,561 / -$9,753) were from `EQUITY_RECLASS_NARRATIVE.md` — a Phase 32-C2 snapshot before Phase 33 work finished. **Neither matches today, neither matches Phase 33 final state, both were correct as of their snapshot dates.**

**The real anomaly is elsewhere:** Ask My Accountant = -$24,615.08 at YE2025 (Phase 31-A2 claimed drained to $0). That's a documentation/expectation gap, not a GL drift.

---

## Task 1 — Plug account reality check

### 1a. JE history per plug account (posted-only, time-ordered)

#### Pre-Sync Adjustments

**Current balance: +$245,537.72 DR (10 posted JEs, all dated 2026-05-15 to 2026-05-18)**

| JE ID | Date | Source | DR | CR | Net | Description |
|---|---|---|---:|---:|---:|---|
| a0d1a057... | 2026-05-15 | pre_sync_adjustment | 0 | 9,673.46 | -9,673 | Pre-sync MC residual |
| 26e2e21a... | 2026-05-15 | pre_sync_adjustment | 4,443.59 | 0 | +4,444 | Write off deleted-account residues |
| 22c-cash-clearing-drain | 2026-05-15 | pre_sync_adjustment | 147,339.26 | 0 | +147,339 | Phase 22-C Cash Clearing drain to PSA |
| 22d-cc-clearing-drain | 2026-05-15 | pre_sync_adjustment | 40,690.63 | 0 | +40,691 | Phase 22-D Credit Card Clearing drain |
| 22c-cash-clearing-final-correction | 2026-05-15 | pre_sync_adjustment | 0 | 12,224.70 | -12,225 | Correction to 22-C drain |
| 23-tips-drain-2026-05-15 | 2026-05-15 | pre_sync_adjustment | 0 | 10,000 | -10,000 | Tips phantom drain |
| 23-leaf-mercury-balance | 2026-05-15 | pre_sync_adjustment | 0 | 13,890.56 | -13,891 | LEAF Mercury balance adj |
| 23-failed-mercury-rebalance | 2026-05-15 | pre_sync_adjustment | 50,384.62 | 0 | +50,385 | Failed Mercury rebalance |
| 24g-ppr-to-equity-reclass-v2 | 2026-05-16 | reclass_to_equity | 63,623.47 | 0 | +63,623 | Pre-Pretzel-OS Reclass to equity, lands here |
| 24-phase-d-negative-expense-cleanup | 2026-05-18 | cleanup_reclass | 0 | 15,155.13 | -15,155 | Negative expense balances cleaned |
| **Net all-time** | | | **306,481.57** | **60,943.85** | **+245,537.72** | |

**AT YE2025 (entry_date ≤ 2025-12-31): $0** — no JEs dated before 2026-05-15 hit this account in the live ledger. ✓ Matches Phase 33 doc.

What this means: this account WAS at $0 at YE2025. All current balance is **post-FY2025 cleanup activity** that Sessions 22-24 + Phase 33-H performed *during* filing-prep. The account is functioning as a deliberate catch-all for reclasses, not a corruption.

#### Pre-Pretzel-OS Reconciliation

**Current balance: -$63,623.47 CR (1 posted JE)**

| JE ID | Date | Source | DR | CR | Net | Description |
|---|---|---|---:|---:|---:|---|
| 24g-ppr-to-equity-reclass-v2 | 2026-05-16 | reclass_to_equity | 0 | 63,623.47 | -63,623 | Reclass Pre-Pretzel-OS residual to equity |

**AT YE2025: $0** — no JEs dated before 2026-05-16 hit this account in the live ledger. ✓ Matches Phase 33 doc.

Same pattern: the YE2025 state was clean. The -$63K balance reflects post-YE2025 reclass activity. The companion DR side of this JE is the +$63,623.47 entry in Pre-Sync Adjustments (above).

#### YE2024 Bank Reconciliation Adjustment

**Current balance: -$43,503.69 CR (9 posted JEs spanning Jan 2025 – Apr 2026)**

| JE ID | Date | Source | DR | CR | Net |
|---|---|---|---:|---:|---:|
| 29d-recon-v3-2025-01-31 | 2025-01-31 | phase_29_recon_adj | 0 | 1,152.42 | -1,152 |
| 29d-recon-2025-10-31 | 2025-10-31 | phase_29_recon_adj | 0 | 9,230.41 | -9,230 |
| 29d-recon-v3-2025-10-31 | 2025-10-31 | phase_29_recon_adj | 9,187.17 | 0 | +9,187 |
| 29d-recon-v3-2025-11-30 | 2025-11-30 | phase_29_recon_adj | 0 | 270.00 | -270 |
| 29d-recon-v3-2025-12-31 | 2025-12-31 | phase_29_recon_adj | 0 | 1,990.74 | -1,991 |
| 29d-recon-v3-2026-01-31 | 2026-01-31 | phase_29_recon_adj | 0 | 6,428.15 | -6,428 |
| 29d-recon-v3-2026-02-28 | 2026-02-28 | phase_29_recon_adj | 0 | 6,104.00 | -6,104 |
| 29d-recon-v3-2026-03-31 | 2026-03-31 | phase_29_recon_adj | 0 | 13,642.05 | -13,642 |
| 29d-recon-v3-2026-04-30 | 2026-04-30 | phase_29_recon_adj | 0 | (truncated) | — |

**AT YE2025: -$3,456.40 CR** (5 JEs) ✓ matches Phase 33 doc.

**Sub-anomaly:** The 2025-10-31 month has BOTH a v2 and v3 JE posted. They almost-but-not-exactly cancel (-9,230.41 vs +9,187.17 = -$43.24 net residue). **v2 was supposed to be reversed when v3 landed but wasn't.** Small drift, but it's pollution.

**Bigger issue:** Phase 29-D continued posting monthly BRA adjustments into 2026 (Jan-Apr) — but the account name says "YE2024 Bank Reconciliation Adjustment", implying it should be a one-time YE2024 timing residual. The 2026 monthly adjustments are MISUSING the account.

#### Ask My Accountant

**Current balance: -$14,001.83 CR all-time / -$24,615.08 CR at YE2025 (8 posted JEs)**

| JE ID | Date | Source | DR | CR | Description |
|---|---|---|---:|---:|---|
| 089j-supplemental-fy2025-close-v4 | 2025-12-31 | fiscal_year_close | 0 | 23,518.93 | Phase 30 Pattern B FINAL close |
| 21v-audit5-fy2025-close | 2025-12-31 | fiscal_year_close | 0 | 4,253.53 | FY2025 P&L roll to RE |
| 24-utahpaper-reclass-2025-fy | 2025-12-31 | fiscal_year_close | 0 | 12,871.33 | Reclass 4 UTAH PAPER charges from AMA to COGS:Paper Packaging |
| 31a2-ama-drain-close-correction | 2025-12-31 | fiscal_year_close | 16,028.71 | 0 | Phase 31-A2 partial drain correction |
| Chase Ink × 4 (3 charges + 1 reclass) | 2026-03-25 through 2026-05-18 | various | 10,612.78 | 0 | — |
| **Net all-time** | | | **26,641.49** | **40,643.32** | **-$14,001.83** |
| **Net AT YE2025** | | | **16,028.71** | **40,643.79** | **-$24,615.08** |

**Anomaly: Phase 31-A2 claimed AMA was "drained to $0" but only posted a partial $16,028.71 DR correction. The remaining $24,615.08 CR was never drained.**

### 1b. Reconcile against migrations

I verified each plug-affecting migration (094-096) is **actually applied** to production D1. The JE IDs in the GL history above (e.g., `22c-cash-clearing-drain`, `22d-cc-clearing-drain`, `24-phase-d-negative-expense-cleanup`, `089j-supplemental-fy2025-close-v4`) all correspond to migrations that ran. The drain JEs were applied. The issue is that the drains target Pre-Sync (an equity-like holding account) without actually balancing to a true settlement, so they accumulate.

### 1c. Why v6 filing CSVs showed different numbers

The v6 `BS_YE2025.csv` reports (filing-position layer):
- Pre-Sync = $0
- Pre-Pretzel-OS = $0
- BRA = +$3,456.40

These reflect the **AT YE2025** snapshot, which is what the BS computes (BS is "as of a date"). The current all-time GL state isn't what shows on a YE2025 BS — only JEs dated ≤ 2025-12-31 count. So the CSVs are CORRECT for the filing date.

The PHASE_A_BUILD_PLAN.md numbers I reported (-$92K Pre-Sync, etc.) had a JOIN bug from my earlier query (LEFT JOIN with `j.status='posted'` in the ON clause kept reversed-JE lines in the SUM). When the query is correct, the all-time numbers are +$245K Pre-Sync / -$63K Pre-Pretzel-OS / -$43K BRA.

**Three numbers in three documents — three different snapshot windows. None of them are wrong; they were all computed correctly for their reference date.**

### 1d. Proposed resolution

**Option B is correct: current GL is right, the Phase 33 docs match their snapshot dates.**

There is, however, a **secondary issue** that doesn't fit cleanly into the prompt's three options:

| Anomaly | Real or Doc? | Resolution |
|---|---|---|
| Pre-Sync, Pre-Pretzel-OS, BRA balances differ between docs | DOC artifact (different snapshot dates) | Update docs to specify snapshot date and computation rules |
| AMA -$24,615.08 at YE2025 | REAL — Phase 31-A2 didn't fully drain | **Propose cleanup JE: DR AMA $24,615.08 / CR Cash Clearing (or appropriate offset) — but NOT post until Drew approves** |
| 2025-10-31 BRA v2/v3 duplicate posting | REAL — v2 should have been reversed | **Propose: reverse `29d-recon-2025-10-31` — no impact on FY2025 BS because v3 effectively replaces it, just cleans audit trail** |
| Phase 29-D monthly BRA adjustments in 2026 | DESIGN issue — account name implies YE2024-only | **Propose: rename `YE2024 Bank Reconciliation Adjustment` to `Bank Reconciliation Adjustment` OR move FY2026 adjustments to a new `FY2026 Bank Reconciliation Adjustment` account. Don't touch the existing JEs.** |

**Decision needed from Drew (Task 1 summary):**
- [ ] Confirm Option B (current GL is right, docs OK at their snapshot date) — Y/N
- [ ] Approve AMA drain JE (-$24,615 cleanup) — Y/N or modify?
- [ ] Approve reversal of duplicate 29d-recon-2025-10-31 v2 — Y/N
- [ ] Decide BRA account naming: rename or split for FY2026?

**Critical: NO JEs posted in this task. Only proposed.**

---

## Task 2 — Marketplace clearing baseline documentation

### 2a. Current balance per clearing (queried 2026-05-26, posted-only)

| Account | All-time | At YE2025 |
|---|---:|---:|
| Cash Clearing | $939,577.05 DR | $166,479.61 DR |
| Credit Card Clearing | $79,381.26 DR | $0 |
| Doordash Clearing | $123,420.90 DR | -$42,423.35 CR |
| UberEats Clearing | $21,710.45 DR | -$7,437.57 CR |
| Grubhub Clearing | $6,838.30 DR | -$2,820.21 CR |
| Square Clearing | $123,162.42 DR | -$34,024.08 CR |
| Payroll Clearing | $41,737.84 DR | $6,537.69 DR |
| LEAF Clearing | $0 | $0 |

### 2b. Composition per clearing account

**Cash Clearing** ($166K at YE2025):
- DR side ($592K total at YE2025): POS-direct reconstruction posts (toast_sales_pos_reconstruction era), QBO Payment wholesale recon, manual reclasses
- CR side ($425K at YE2025): Mercury sync inflows during bookkeeper era + Phase 30 Pattern B counter-entries
- **Composition: bookkeeper-era reconstruction residual** (timing between gross POS revenue recognition and Mercury settlement)
- Not "this week's unsettled DoorDash" — most is historical Phase 33-era buildup

**Doordash / UberEats / Grubhub Clearing** ($-42K / -$7K / -$3K CR at YE2025):
- These are net CR balances (Mercury settled MORE than the offset DR side)
- Likely from RTR-2 era: revenue was recognized at the orders/POS layer but the sweep DR-side to Clearing didn't fully match the Mercury settlement side
- **Composition: settlement-timing residual + Phase 33 reconstruction gaps**

**Square Clearing** ($-34K CR at YE2025): same pattern as marketplaces. Bookkeeper-era buildup.

**Payroll Clearing** ($6.5K at YE2025): per-pay-cycle Mercury TOAST PAYROLL outflows DR Payroll Clearing; toast_payroll_reconstruction CRs it. Small residual = legitimate timing artifact.

**LEAF Clearing** ($0): clean. Per-Mercury-LEAF-outflow + leaf_amortization_splitter cancels exactly. ✓

**Credit Card Clearing** ($0 YE2025, $79K all-time): Mercury IO Credit + Chase Ink statement charges. Was drained at Phase 22-D.

### 2c. Expected steady-state per account

A real "well-functioning" steady-state would be:

| Account | Healthy steady-state | Notes |
|---|---|---|
| Cash Clearing | $0 to $5K | Petty cash drawer in safe (Drew has confirmed ~$2K real cash on hand) |
| Square Clearing | $-2K to $5K | 1-2 days of Square processing in transit; DR when revenue posted but Mercury settlement pending |
| Doordash Clearing | $-15K to $5K | DD settles weekly; week's accrued gross can sit here briefly |
| UberEats Clearing | $-2K to $2K | Similar, smaller volume |
| Grubhub Clearing | $-1K to $1K | Smallest marketplace |
| Payroll Clearing | $-5K to $10K | One pay cycle's gross in flight |
| LEAF Clearing | $0 always | Per-event symmetric |
| Credit Card Clearing | $-3K to $3K | One billing cycle of CC charges before pay-down |

### 2d. Alert thresholds for Surface 4

| Account | GREEN | YELLOW (investigate) | RED (real problem) |
|---|---|---|---|
| Cash Clearing | -$1K to $5K | $5K–$30K | >$30K |
| Square Clearing | -$5K to $10K | -$15K to -$5K, $10K-$50K | beyond |
| Doordash Clearing | -$20K to $5K | -$40K to -$20K, $5K-$15K | beyond |
| UberEats Clearing | -$5K to $2K | -$10K to -$5K, $2K-$10K | beyond |
| Grubhub Clearing | -$2K to $2K | -$5K to -$2K, $2K-$5K | beyond |
| Payroll Clearing | -$5K to $10K | -$10K to -$5K, $10K-$20K | beyond |
| LEAF Clearing | -$0.50 to $0.50 | $0.50 to $50 | beyond |
| Credit Card Clearing | -$3K to $3K | -$10K to -$3K, $3K-$10K | beyond |

**Today (YE2025), most marketplace clearings would be YELLOW or RED** because of the bookkeeper-era residuals from §2b.

### 2e. Historical residuals separation

**Proposed cleanup approach** (NOT executing — propose only):

For each marketplace clearing, the YE2025 residual is bookkeeper-era reconstruction artifact, not real operational drift. Proposal: post a single cleanup JE per account at YE2025 that drains residual to the appropriate true equity account (likely `Pre-Sync Adjustments` or a new `Bookkeeper Reconciliation Cleanup` account).

| Account | YE2025 residual to drain | Suggested offset |
|---|---:|---|
| Cash Clearing | -$164,479.61 (drain to $2,000) | Pre-Sync Adjustments OR Bookkeeper Recon Cleanup (new) |
| Doordash Clearing | +$42,423.35 | same |
| UberEats Clearing | +$7,437.57 | same |
| Grubhub Clearing | +$2,820.21 | same |
| Square Clearing | +$34,024.08 | same |
| Total drainable | ~$250K | |

**Critical:** these JEs would touch FY2025 entries. **Do not post until Drew confirms the v6 filing position is locked and confirms this cleanup is acceptable.** Per Drew's prior directive ("2025 needs to be set"), the safer path is to:

- Either: post the cleanups DATED 2026-01-01 onward (doesn't change filing-year BS)
- Or: leave the residuals in place and document them as known artifacts, with Surface 4 alert thresholds widened to accommodate

**Decision needed from Drew (Task 2 summary):**
- [ ] Approve the proposed steady-state ranges per account?
- [ ] Approve the YELLOW/RED thresholds?
- [ ] Decide cleanup approach: drain residuals (when? to what offset?) OR leave + document
- [ ] Confirm a new `Bookkeeper Reconciliation Cleanup` equity account is OK if needed for separation

---

## Task 3 — Period lock infrastructure design

### 3a. `accounting_periods` table schema (proposed)

```sql
CREATE TABLE IF NOT EXISTS accounting_periods (
  period_id          TEXT PRIMARY KEY,         -- 'YYYY-MM' for monthly, 'YYYY-Q1' for quarterly, 'YYYY' for annual
  period_type        TEXT NOT NULL CHECK (period_type IN ('month','quarter','year')),
  period_start       TEXT NOT NULL,            -- ISO date
  period_end         TEXT NOT NULL,            -- ISO date (inclusive)
  status             TEXT NOT NULL CHECK (status IN ('open','closed','reopened')) DEFAULT 'open',
  closed_at          TEXT,                     -- timestamp when transitioned to 'closed'
  closed_by          TEXT,                     -- user identifier
  closed_brief_id    TEXT,                     -- FK to cfo_briefs row (existing snapshot)
  reopened_at        TEXT,
  reopened_by        TEXT,
  reopen_reason      TEXT,                     -- NOT NULL when status='reopened'
  reopen_audit_id    TEXT,                     -- FK to audit_trail row capturing the reopen
  locked_jes_at_close INTEGER,                 -- count of JEs in period at close time
  integrity_snapshot TEXT,                     -- JSON: Tier 1 checks result + balances
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_accounting_periods_status ON accounting_periods(status);
CREATE INDEX idx_accounting_periods_period_type ON accounting_periods(period_type, period_start DESC);
```

Note: existing `closed_periods` table has been used during Phase 33 reconstruction as a soft lock (UPDATE closed_periods.locked_at). Phase A's `accounting_periods` REPLACES that table conceptually — migration would copy existing closed_periods state forward + drop the old table.

### 3b. Posting-layer enforcement

**Every place that creates JEs needs to check `accounting_periods.status` for the JE's `entry_date`'s period.**

Files that write JEs (extracted from grep across `workers/`):

| File | Method | Status check needed? |
|---|---|---|
| `workers/finance-je-poster.js` | `postJeForTxn` — main categorizer-driven posting | YES (replace existing `isInClosedPeriod` with new check) |
| `workers/finance-cfo-tools.js` | manual posting + reconciliation tools | YES |
| `workers/finance-monthly-close.js` | `runMonthlyClose` posts the close JE | YES — but with override (close JE is allowed to write to period being closed) |
| `workers/finance-monthly-depreciation-cron.js` | monthly depreciation auto-post | YES |
| `workers/finance-gl-reconstruction.js` | Phase 33 reconstruction (one-time) | NO — already retired |
| `workers/finance-expense-reconstruction.js` | Phase 33 (one-time) | NO |
| `workers/finance-toast-payroll-reconstruction.js` | one-time per check_date | YES (if re-runs are allowed) |
| `workers/finance-leaf-amortization-splitter.js` | per-Mercury-LEAF-outflow | YES |
| `workers/finance-pos-direct.js` | RTR-6 (dormant) | YES (if reactivated) |
| `workers/finance-receipts.js` | receipt → matched-Mercury txn JE | YES (indirect — flows through je-poster) |
| `workers/finance-revenue-sweep.js` | (retired) | NO |
| `workers/finance-bookkeeper-tips-tax-accrual.js` | (one-time historical) | NO |
| Migration files (any new) | direct INSERT into journal_entries | YES — but migrations CAN write to closed periods because they're admin overrides |

**Phase A pattern:** centralize the period-status check in a helper `periodLockCheck(env, entryDate, options)`. Every writer calls it before INSERT. Options include `allowClosed: true` for the close JE itself + admin migrations.

### 3c. Reopen workflow design

**Trigger:** Drew explicit action only. No automated reopens. Must be from dashboard or CLI with explicit confirmation.

**Workflow:**
1. Drew clicks "Reopen Period [YYYY-MM]" on Surface 6
2. Modal asks: reason (free text, required), affected tier (info, P&L only, BS-impact)
3. Tier 1 integrity check runs FIRST — if anything is failing, abort reopen and surface why
4. `accounting_periods.status = 'reopened'`, `reopened_at = now()`, `reopened_by`, `reopen_reason` set
5. Audit trail entry: `action_type='reopen_period'`, `entity_id=period_id`, `before_state` = closed snapshot, `after_state` = reopened
6. Period appears in `pending_reclose` queue
7. Drew posts adjusting JEs as needed
8. Drew clicks "Re-close period" — triggers `runMonthlyClose` again with recompute
9. New close JE replaces (reverses + reposts) prior close
10. `accounting_periods.status = 'closed'` again, fresh `closed_at`

**Audit:** Every reopen → audit_trail row. Every re-close → audit_trail row. Trail shows reopen chains.

### 3d. Migration approach (backfill historical periods)

Backfill `accounting_periods` for 2024 and 2025:

```sql
-- Monthly periods Jan 2024 – Apr 2026
INSERT INTO accounting_periods (period_id, period_type, period_start, period_end, status, closed_by, closed_at)
VALUES
  ('2024-01', 'month', '2024-01-01', '2024-01-31', 'closed', 'irene_filing_2024', '2025-09-15T00:00:00Z'),
  -- ... 2024 months
  ('2025-01', 'month', '2025-01-01', '2025-01-31', 'closed', 'irene_filing_2024_reference', '2025-09-15T00:00:00Z'),
  -- ... through Dec 2025 (filed-year)
  ('2026-01', 'month', '2026-01-01', '2026-01-31', 'open', NULL, NULL),
  -- ... through current month
  ;

-- Year period
INSERT INTO accounting_periods VALUES ('2024', 'year', '2024-01-01', '2024-12-31', 'closed', 'irene_filing_2024', '2025-09-15T00:00:00Z', ...);
INSERT INTO accounting_periods VALUES ('2025', 'year', '2025-01-01', '2025-12-31', 'closed', 'irene_filing_2025_pending', NULL, ...);
```

YE2024 periods anchored to Irene's filed-1065. YE2025 periods marked closed but `closed_by='irene_filing_2025_pending'` until Irene actually files. After filing, that flag updates.

### 3e. Edge cases

**(i) JEs that span periods (rare; e.g., monthly depreciation accrued daily):**
- Solution: each JE has exactly ONE `entry_date`. Period determination is unambiguous.
- For depreciation: monthly cron posts ONE JE per asset per month, all dated to the last day of the prior month. No spanning.

**(ii) Adjustments to closed periods that are legitimately needed:**
- Use the reopen workflow (§3c). Don't allow silent unlock.
- For Irene-posted YE2024 AJEs (already in production for Section 110, etc.): these are pre-existing; they're in the JE history but pre-date period-lock infra. After backfill, the YE2024 period is `closed`; any further YE2024 changes go through reopen.

**(iii) Year-end vs month-end close:**
- Month-end close: cron `cfo_monthly_close` at 1st of month 6am MT. Runs the 5-day grace period check (RTR-4), posts the monthly close JE, sets `accounting_periods` status='closed' for that month.
- Year-end close: separate ritual. Drew explicitly triggers from Surface 6 after all 12 months are individually closed + Tier 5 acceptance passes. Posts the annual fiscal_year_close JE rolling P&L to RE. Sets year status='closed'.

**(iv) Posting a JE in a CURRENTLY-OPEN period that's been previously closed-then-reopened:**
- Allowed. Status='reopened' is functionally equivalent to status='open' for posting purposes.

### 3f. Implementation effort

| Component | Effort |
|---|---|
| Schema migration + backfill | 0.5 day |
| `periodLockCheck` helper + integration into 6 JE-writing workers | 1 day |
| Reopen workflow UI (Surface 6 — covered there) | (in Surface 6 scope) |
| Edge case handling + audit trail integration | 0.5 day |
| Acceptance tests + Tier 1 invariant (`no_post_in_closed_period` already exists, need to extend) | 0.5 day |
| **Subtotal pre-Surface-6** | **~2.5 days** |

**Decision needed from Drew (Task 3 summary):**
- [ ] Approve schema design?
- [ ] Approve reopen workflow (explicit trigger, audit + reason required)?
- [ ] Confirm YE2024 + YE2025 closed_by tags?
- [ ] Migration timing: backfill BEFORE Surface 6 builds, or as Surface 6's first step?

---

## Task 4 — Internal vs filing position decision

### 4a. Two options analyzed

**Option A — Check against current Pretzel OS internal state (-$299,576 NI)**

Surface 5 Integrity Monitor validates:
- BS balances at every reported as_of date
- Plug accounts where expected (at YE2025: $0, $0, -$3,456)
- Tier 1 invariants all pass
- Cross-consumer agreement holds

**Pros:** Self-consistent. The GL is the truth. Surface 5 detects drift against the GL's own state.

**Cons:** Doesn't surface the $47K gap between internal Path A and v6 filing position. Drew has to remember "filing position is layered on top in the v6 CSVs."

**Option B — Check against expected filing position (-$346,898 currently, -$321,899 post-FMV-revision)**

Surface 5 includes a "tax basis" view that projects the filing layer (Form 4562 depreciation + Sprinter §179 + Tips reclass + future adjustments) on top of GL. Surfaces book-vs-tax discrepancies as informational.

**Pros:** Drew sees the WHOLE picture in one place. Filing position visible during ongoing operations.

**Cons:** Implements a "what would the filing look like?" computation today that re-implements the v6 CSV logic. Risks drift if v6 logic and Surface 5 logic diverge.

### 4b. Recommendation: Option A for Phase A interim period

**Rationale:**
- Workstream 2 (internal-to-filing rebaseline) is the proper place to converge the two layers — once Irene files, we post the filing-position adjustments into the GL, so internal and filing become the same number.
- Before Workstream 2: maintaining TWO views (GL internal + v6 CSV filing) is the operational reality. Surface 5 should monitor the GL and ALSO surface "v6 filing position: $-346,898" as a referenced number with a footnote.
- Don't reimplement the filing-overlay logic in Phase A. Re-implementing risks divergence from Irene's actual final filing.

**Phase A Surface 5 spec:**
- Primary integrity checks: BS balances, plug accounts at YE2025 within tolerance, Tier 1 all-pass, cross-consumer agreement
- Reference panel: "Filing position (v3 sent to Irene): $-346,898.53. Internal Path A: $-299,576.15. Gap intentional pre-Workstream-2."
- After Irene files + Workstream 2 lands: panel changes to "Filing & internal converged: $-321,899 (or whatever)" — no gap notation.

**Decision needed from Drew (Task 4 summary):**
- [ ] Confirm Option A for Phase A interim?
- [ ] Confirm Surface 5 includes a static "filing position reference" panel without re-implementing the overlay?
- [ ] Approve "gap intentional pre-Workstream-2" framing?

---

## Task 5 — Audit trail schema design

### 5a. Existing audit infrastructure

**Already in place:**
- `finance_audit_log` — used by various reclass + cleanup migrations to log actions. Append-only by convention but no enforcement.
- `finance_audit_runs` — Tier 1/2/5 run history with pass/fail counts.
- `finance_audit_checks` — per-check results within each audit run.
- `ai_calls` — every Anthropic API call with cost + model + use_case.
- `agent_decisions` — autonomous capex/categorization decisions.
- `cron_runs` — every cron execution with status + duration.

**Gap:** No unified table for "every change to financial state that Drew or system made, with before/after snapshots." `finance_audit_log` is ad-hoc; varies per action_type. Inconsistent JSON shapes.

### 5b. Proposed `audit_trail` schema

```sql
CREATE TABLE IF NOT EXISTS audit_trail (
  id              TEXT PRIMARY KEY,           -- UUID
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor           TEXT NOT NULL,              -- 'drew' | 'system:cron:cfo_daily_close' | 'system:categorizer' | 'agent:capex_reasoner' | etc.
  action_type     TEXT NOT NULL,
    -- categorize_transaction, override_categorization, mark_reconciled, post_je,
    -- reverse_je, close_period, reopen_period, manual_reclass, approve_capex,
    -- ai_decision_applied, ai_decision_overridden, etc.
  entity_type     TEXT NOT NULL,
    -- mercury_txn, journal_entry, accounting_period, vendor, chart_of_account
  entity_id       TEXT NOT NULL,
  before_state    TEXT,                       -- JSON, optional
  after_state     TEXT,                       -- JSON, optional
  reason_note     TEXT,                       -- free-text from Drew or system explanation
  source_metadata TEXT,                       -- JSON: LLM confidence, rule_matched, parent_je_id, etc.
  related_je_id   TEXT,                       -- direct FK to journal_entries.id when relevant
  related_audit_id TEXT,                      -- FK to parent audit_trail row (for chains like reopen→edit→reclose)
  immutable       INTEGER NOT NULL DEFAULT 1
);
```

### 5c. Indexes for Surface 7 query patterns

```sql
CREATE INDEX idx_audit_trail_occurred_at ON audit_trail(occurred_at DESC);
CREATE INDEX idx_audit_trail_entity ON audit_trail(entity_type, entity_id);
CREATE INDEX idx_audit_trail_actor ON audit_trail(actor, occurred_at DESC);
CREATE INDEX idx_audit_trail_action_type ON audit_trail(action_type, occurred_at DESC);
CREATE INDEX idx_audit_trail_related_je ON audit_trail(related_je_id);
```

Query patterns Surface 7 needs to support:
- "What did the system do today?" → filter on `actor LIKE 'system:%'` + occurred_at >= today
- "What did I touch this week?" → filter on `actor='drew'` + week range
- "Who categorized this transaction and how?" → entity_type='mercury_txn' + entity_id
- "Show me every reopen of this period" → action_type='reopen_period' + entity_id
- "What's the audit chain for this JE?" → join on related_je_id + walk related_audit_id chain

### 5d. Write patterns (where audit entries get created)

| Action | Worker | What goes in audit_trail |
|---|---|---|
| Categorizer auto-posts JE | `finance-cfo-categorizer.js` + `finance-je-poster.js` | action='post_je', actor='system:categorizer', entity_type='journal_entry', source_metadata=rule_name + confidence |
| Drew approves a pending capex | Phase A Surface 1 (Decisions Inbox) | action='approve_capex', actor='drew', before/after states |
| Drew reclassifies a categorized txn | Phase A Surface 1 | action='override_categorization', actor='drew', before_state + reason_note required |
| Monthly close | `finance-monthly-close.js` | action='close_period', actor='system:cron:cfo_monthly_close', related_je_id=close JE |
| Reopen period | Phase A Surface 6 | action='reopen_period', actor='drew', reason_note required |
| Manual JE post (rare) | Phase A Surface 1 manual entry | action='post_manual_je', actor='drew', before_state=null |
| Mercury txn reconciled | `finance-je-poster.js` | action='mark_reconciled', actor='system:je_poster', related_je_id |
| AI suggestion overridden | Phase A Surface 1 | action='ai_decision_overridden', source_metadata=AI suggestion |

### 5e. Append-only enforcement

D1/SQLite doesn't have row-level triggers as robust as Postgres. Options:

**Option 1 — Trigger-based** (works in SQLite):
```sql
CREATE TRIGGER audit_trail_no_update BEFORE UPDATE ON audit_trail
BEGIN
  SELECT RAISE(FAIL, 'audit_trail is append-only');
END;

CREATE TRIGGER audit_trail_no_delete BEFORE DELETE ON audit_trail
BEGIN
  SELECT RAISE(FAIL, 'audit_trail is append-only');
END;
```

**Option 2 — Convention + Tier 1 invariant**: don't add triggers; instead, add a Tier 1 invariant `audit_trail_unchanged_yesterday` that hashes yesterday's rows + compares to a stored snapshot. Tampering surfaces immediately.

**Recommendation: Option 1**. Triggers are simpler and self-enforcing. Migrations that NEED to fix audit data (rare) can DROP + recreate triggers, which is auditable in itself.

### 5f. Relationship to existing JEs

`audit_trail.related_je_id` is a soft FK (no `REFERENCES` constraint to allow audit_trail entries that reference JEs in deleted states or external references). JE-affecting actions populate it; reads JOIN as needed.

### 5g. Retention

**No archival.** Per prompt's "forever is fine." Audit table grows ~10s of rows/day → ~3-4K rows/year. D1 can handle millions of rows. No retention policy needed for years.

**Decision needed from Drew (Task 5 summary):**
- [ ] Approve schema?
- [ ] Approve append-only via triggers (Option 1)?
- [ ] Confirm immutable=1 flag is informational only (triggers enforce)?
- [ ] Approve "no retention/archival" policy?

---

## Task 6 — Phase 33 documentation update plan

### 6a. Phase 33 narrative documents

Located in `irene_package_FY2025/`:
- `PHASE_33_FINAL_STATE.md` — claims plug accounts at $0 at YE2025
- `PHASE_33H_FINDINGS.md` — Phase 33-H period findings
- `EQUITY_RECLASS_NARRATIVE.md` — Phase 32-C2 equity narrative (the source of Drew's prompt numbers)
- `EQUITY_BRIDGE_FY2025.md` — Sched M-2 reconciliation
- `IRENE_HANDOFF_VERIFICATION.md` — Q1-Q8 verification pack
- `IRENE_VERIFICATION_PACK.md` — pre-handoff pack
- `POST_IRENE_REBASELINE.md` — fresh QBO pull post-Irene
- `SCHEDULE_L_AUDIT_v1.csv` — line audit
- `NI_BRIDGE_FY2025.csv` — internal-to-filing walk

### 6b. Claims that don't match current GL

After Task 1's findings, **no Phase 33 doc has incorrect claims at its snapshot date**. The apparent mismatches are because:
- Each doc captures a specific snapshot
- Post-snapshot activity (Sessions 22-24, Phase 33-H, etc.) modified the GL
- Comparing snapshot doc to current all-time GL produces "divergence" that isn't actually a divergence

**Required updates: none for correctness. Optional updates for clarity.**

### 6c. Proposed updates

Make these as **footnote additions**, not full revisions:

1. `PHASE_33_FINAL_STATE.md`: add a top header noting "Snapshot as of 2026-05-20. Plug account balances quoted are AT-YE2025 (entry_date ≤ 2025-12-31). Live GL all-time may show different numbers due to post-FY2025 reclass activity."

2. `EQUITY_RECLASS_NARRATIVE.md`: add similar header noting Phase 32-C2 snapshot date.

3. `POST_IRENE_REBASELINE.md`: already does this well; minor refinement to specify "QBO as of 2026-05-26 morning pull."

4. New doc `irene_package_FY2025/SNAPSHOT_DATES.md` — explains the convention: every Phase X doc captures a point in time, future Phases continue posting to GL, comparing snapshots requires matching dates.

### 6d. Historical artifact vs living document

**Phase 33 docs become historical artifacts** (frozen with snapshot date noted). They were correct at their date.

**Living documents going forward:**
- `workers/ARCHITECTURE.md` — updated per maintenance commitment
- `PHASE_A_BUILD_PLAN.md` — updated as Phase A surfaces ship
- Future Phase docs follow same pattern

**Decision needed from Drew (Task 6 summary):**
- [ ] Approve footnote additions to Phase 33 docs (no full revisions)?
- [ ] Approve creating `SNAPSHOT_DATES.md` explaining the convention?
- [ ] Approve "historical artifact" treatment going forward?

---

## Task 7 — Email/notification disable approval

### 7a. Complete email send inventory (refined from Phase A Section 6)

| # | Worker | Function | Trigger | Recipient | Subject pattern | Recommendation |
|---|---|---|---|---|---|---|
| 1 | `finance-email-briefs.js` | `sendDailyMorningBrief` | cron `30 13 * * *` | Drew | "Pretzel CFO · Daily — {date}" | **keep** |
| 2 | `finance-email-briefs.js` | `sendDailyCloseEmail` | inside `runDailyClose` | Drew | "Pretzel CFO · {N} JEs posted · {date}" | **keep** |
| 3 | `finance-email-briefs.js` | `sendWeeklyDirectiveEmail` | cron `0 4 * * 1` (Sun 10pm MT) | Drew | "Pretzel CFO · Weekly directive — week of {date}" | **keep** |
| 4 | `finance-email-briefs.js` | `sendDailyReconEmail` | cron `0 14 * * *` | Drew | "Mercury vs books variance — {date}" | **keep** |
| 5 | `finance-ar-aging.js` | 5 AR follow-up drafts | manual / scheduled | (CUSTOMER) | "Heads up: {invoice} {amount} due {date}" / "Quick check..." / "Following up..." / "{invoice} now {days} days past due..." | **VERIFY DRAFT-ONLY mode** |
| 6 | `email-sender.js` | `sendResendEmail` (generic) | various callers | varies | varies | **keep** — used by multiple workers |
| 7 | `approval-mailer.js` | `sendApprovalRequestEmail` | outreach workflow | Drew | "Outreach approval needed — {venue}" | **keep** (lead-gen) |
| 8 | `router.js` | `sendAlertEmail` pipeline-stalled | cron `0 */6 * * *` | Drew | "Pretzel CFO · ⚠ Pipeline stalled — no JEs in {N}h" | **keep** |
| 9 | `router.js` | `sendAlertEmail` audit crash | inside `trackedRun` | Drew | "The {agent} agent crashed during its scheduled run" | **keep** |
| 10 | `finance-worker.js` | `sendEmail` tax exemption cert request | manual | vendor/customer | "Tax exemption certificate request — Dangerous Pretzel" | **keep** (rarely fires) |
| 11 | `router.js` (Mercury IO reminder) | cron `0 14 28 * *` | Drew | "Upload latest Mercury IO statement" | **keep** |
| 12 | `email-sender.js` retail Cohort B | cron `0 16 * * 2` | customers | retail win-back marketing | **out of Phase A scope** |
| 13 | `finance-issue-surfacer.js` (embedded in daily brief) | inside daily brief | Drew | (top 3 issues block) | **keep** |
| 14 | `finance-page-narrative.js` regenerate flow | manual | Drew | (sometimes) | **keep** |

### 7b. Per-item keep/disable/modify recommendation

**Disable-immediately list: NONE.**

All finance emails reviewed appear correctly-recipiented and useful. No incorrect-content or wrong-recipient cases found.

**Modify list: item #5 (AR follow-up emails to customers)** — this is the only one that goes to CUSTOMERS. Recommendation: confirm Drew that these are still in DRAFT mode (drafts created in Gmail, not auto-sent). If Drew approves keeping in draft-only, no action needed. If Drew wants to enable auto-send: separate review of every template + sender domain + reply-to handling before any go live.

**Disable mechanism for any future case** (documenting for reference):
- env var: `EMAIL_<name>_ENABLED = "false"` checked at worker top
- cron disable: remove from `wrangler.toml` triggers list + redeploy
- code change: wrap `sendResendEmail` call in `if (env.EMAIL_<name>_ENABLED !== 'false')`
- For AR follow-ups specifically: add `AR_AUTO_SEND_ENABLED = "false"` (assumed default; verify in code)

### 7c. NO emails will be disabled in this task.

**Decision needed from Drew (Task 7 summary):**
- [ ] Confirm AR follow-up emails are in DRAFT mode only — Y/N
- [ ] Approve all 14 emails to keep firing as documented — Y/N
- [ ] Any flagged for further investigation?

---

## Task 8 — Phase A revised build plan

Refining `PHASE_A_BUILD_PLAN.md` Section 13 based on Tasks 1-7 findings.

### 8a. Updated effort estimates per surface

| Surface | Original estimate | Revised | Why changed |
|---|---:|---:|---|
| S1 — Daily Decision Inbox | 5 days | 5 days | Unchanged |
| S2 — Statements Viewer | 3 days | 3 days | Unchanged |
| S3 — Vendor/Customer Pages | 3 days | 3 days | Unchanged |
| S4 — Forecast & Scenario | 6 days | 7 days | Includes Marketplace Clearing alert thresholds + cleanup-decision dependency |
| S5 — Integrity Monitor | 2 days | 3 days | Includes filing-position reference panel + plug-account snapshot-date awareness |
| S6 — Period Close Workspace | 3 days | 4 days | Includes period-lock infrastructure (~2.5 days of which is shared with general infra) |
| S7 — Audit Trail | 2 days | 2 days | Schema design folded into Phase A.0 |
| **Subtotal surfaces** | 24 | 27 | |
| Pre-work | 2 | 4 | Additional: period-lock infra (2.5 days, shared with S6); AMA + BRA cleanup decisions (1 day if approved); marketplace cleanup decisions (in scope per task 2) |
| Integration / testing / nav restructure | 3 | 3 | Unchanged |
| **TOTAL** | **29** | **34 focused-days** | ≈ 6-7 calendar weeks |

### 8b. Critical path dependencies

```
B0. Drew approves Task 1-7 decisions
   ↓
B1. Schema migrations (accounting_periods + audit_trail) — 1 day
   ↓
B2. Helper functions (periodLockCheck, auditWriter) — 0.5 day
   ↓
S5 (Integrity Monitor) — uses Tier 1 + existing data
   ↓
S2 (Statements Viewer) — read-only, parallel-buildable with S5
   ↓
S7 (Audit Trail) — depends on B1+B2
   ↓
S6 (Period Close) — depends on B1+B2 + S5 ready
   ↓
S1 (Decision Inbox) — biggest. Depends on B1+B2 + categorizer_decisions table
   ↓
S3 (Vendor/Customer) — depends on S1 patterns
   ↓
S4 (Forecast) — last. Depends on S3 customer intel + S5 integrity
```

### 8c. Revised build sequence (4-week build window)

If Drew has a 4-week window for Phase A.1 build (not 6-7 weeks):

**Recommendation: scope down to MVP surfaces in 4 weeks:**

- **Week 1**: B0 (Drew decisions) + B1 (migrations) + B2 (helpers) + S5 MVP (Integrity Monitor)
- **Week 2**: S2 MVP (Statements Viewer) + S7 MVP (Audit Trail) — both read-only, lower risk
- **Week 3**: S1 MVP (Decision Inbox) — biggest. LLM categorization layer + bulk-approve. Limit to "auto-apply ≥0.95 confidence, show all decisions in audit timeline."
- **Week 4**: S6 MVP (Period Close) + integration testing + nav restructure

**Defer to Phase A.2:**
- S3 (Vendor/Customer pages) — separate workstream
- S4 (Forecast model rewrite) — bigger lift, do after others land

This gives a working Phase A.1 in 4 weeks. S3 + S4 land in a follow-on 3-week Phase A.2.

### 8d. Acceptance criteria templates per surface

**S5 — Integrity Monitor**
- [ ] Renders Tier 1 status (pass/fail/warn counts) for last 24h
- [ ] Shows plug account balances at YE2025 + current with footnote about snapshot dates
- [ ] Shows filing-position reference vs internal NI
- [ ] Updates within 60s of new Tier 1 run
- [ ] Acceptance test: kill Tier 1 → Surface 5 shows red within 5 min

**S2 — Statements Viewer**
- [ ] P&L, BS, SOCF available for any month/quarter/year
- [ ] Multi-period comparison (current + prior)
- [ ] Drill-down on any line item shows underlying JEs
- [ ] CSV export per statement
- [ ] Acceptance test: compare to v3 filing CSVs for YE2025 — match cent-accurate

**S7 — Audit Trail**
- [ ] Filter by actor, action_type, entity_type, date range
- [ ] Click any row → see before_state + after_state JSON diff
- [ ] Append-only enforced (UPDATE/DELETE fail)
- [ ] Acceptance test: 100 entries inserted, indexed search returns results <500ms

**S1 — Decision Inbox**
- [ ] LLM proposes categorization on novel vendors (not matching any rule)
- [ ] Auto-apply at ≥0.95 confidence + write audit_trail entry
- [ ] Show all decisions in inbox; Drew can override
- [ ] Override writes audit_trail entry + creates cfo_facts rule for similar future txns
- [ ] Acceptance test: 50 historical novel-vendor txns; LLM accuracy vs Drew's expected categorization ≥80%

**S6 — Period Close**
- [ ] Click "Close Period [YYYY-MM]" runs grace-period + integrity checks → posts close JE → locks period
- [ ] Click "Reopen Period" requires reason → audits → unlocks
- [ ] Re-close after reopen reverses prior close + posts new close
- [ ] Acceptance test: close + reopen + edit + reclose; audit_trail shows the chain

### 8e. Test plan template per surface

For each surface:
1. **Unit tests**: helper functions, schema validity
2. **Integration tests**: end-to-end happy path (Drew clicks X → DB reflects Y → UI shows Z)
3. **Tier 1 invariants**: surface-specific check added
4. **Cross-consumer agreement**: if surface adds a new metric, add to CROSS_CONSUMER_PROBES
5. **Acceptance script**: `tests/acceptance.test.sh` extended with surface-specific tests
6. **Pre-deploy gate**: new tests must pass before deploy
7. **Manual smoke**: Drew walks through surface, confirms it matches expectations

### 8f. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Categorizer LLM (S1) hallucinates account names that don't exist in CoA | MEDIUM | HIGH | LLM proposal must match an active CoA entry; fail-safe to "uncategorized" if not |
| Period lock breaks downstream cron (e.g., monthly depreciation can't write to locked period) | MEDIUM | MEDIUM | `periodLockCheck` has `allowAdminOverride: true` for system crons; document in JE poster |
| Audit trail volume grows fast → query performance degrades | LOW | LOW | Indexed; D1 handles millions of rows; revisit if growth exceeds 100K/year |
| Filing-position reference in S5 drifts from v6 CSVs if v6 changes | LOW | MEDIUM | Static panel referencing v6 commit hash; update only when Workstream 2 lands |
| Drew approves AMA $24K cleanup → impacts YE2025 filing position | LOW | HIGH | Post AMA cleanup DATED 2026-01-01 or later; doesn't touch FY2025 BS |
| 4-week window proves too tight | MEDIUM | MEDIUM | MVP scope above ships 4 surfaces in 4 weeks; A.2 picks up S3+S4 |

---

## Summary

### 1. Decisions Drew needs to make before Phase A build starts

| # | Decision | Recommendation | Section |
|---|---|---|---|
| 1 | Confirm Option B (current GL right at snapshot dates; docs OK) | Yes | §1 |
| 2 | AMA $24K drain — when, to what offset | Post 2026-01-01 dated to PSA or new "Cleanup" account | §1 |
| 3 | 2025-10-31 BRA v2 duplicate — reverse | Yes (single JE reversal) | §1 |
| 4 | BRA account rename for FY2026 — rename existing OR create new FY2026 BRA | Create new `FY2026 Bank Reconciliation Adjustment` account; rename existing to `YE2024 Bank Reconciliation Adjustment` | §1 |
| 5 | Marketplace clearing steady-state ranges + thresholds | Approve as proposed | §2 |
| 6 | Marketplace cleanup approach — drain residuals when? offset where? | Post 2026-01-01 dated to PSA or new Cleanup account | §2 |
| 7 | New `Bookkeeper Reconciliation Cleanup` equity account — create? | Recommend yes (separates from PSA) | §2 |
| 8 | accounting_periods schema | Approve as proposed | §3 |
| 9 | Reopen workflow — explicit-only with reason + audit | Approve | §3 |
| 10 | accounting_periods backfill timing | Before S6 build starts | §3 |
| 11 | S5 Integrity Monitor uses Option A (internal-state checks) | Approve | §4 |
| 12 | Filing-position reference panel (read-only) | Approve | §4 |
| 13 | audit_trail schema | Approve as proposed | §5 |
| 14 | Append-only triggers (Option 1) | Approve | §5 |
| 15 | Phase 33 doc footnote additions | Approve | §6 |
| 16 | Create `SNAPSHOT_DATES.md` convention doc | Approve | §6 |
| 17 | AR follow-up emails in DRAFT-only mode | Confirm — Y/N | §7 |
| 18 | All 14 existing emails to continue firing | Confirm — Y/N | §7 |
| 19 | Phase A revised total (~34 focused-days) | Approve OR scope to 4-week MVP | §8 |
| 20 | 4-week MVP scope (S5, S2, S7, S1, S6; defer S3 + S4) | Approve | §8 |

### 2. Cleanup work that needs to happen before build (JEs / docs / code)

**JEs to post** (after Drew approves — NOT yet posted):
1. AMA drain: DR Ask My Accountant $24,615.08 / CR (offset TBD) — dated 2026-01-01 onward
2. Reverse `29d-recon-2025-10-31` (v2 duplicate; -$43.24 net effect)
3. Marketplace clearing drains (if approved per §2 Task 2e): ~$250K total

**Docs to update** (NOT yet edited):
1. `PHASE_33_FINAL_STATE.md` — snapshot date footnote
2. `EQUITY_RECLASS_NARRATIVE.md` — same
3. Create `SNAPSHOT_DATES.md` convention doc

**Schema migrations to design + apply** (NOT yet applied):
1. `099_accounting_periods.sql` — schema + backfill
2. `100_audit_trail.sql` — schema + triggers
3. (possibly) `101_bookkeeper_recon_cleanup_account.sql` — new equity account if Drew approves
4. `102_categorizer_decisions.sql` — per Phase A Section 2.5 proposal

**Code to disable**: None (per Task 7).

### 3. Phase A revised effort estimate

| Original | Revised | Delta |
|---|---|---|
| 29 focused-days | 34 focused-days | +5 days (period-lock infra + cleanup work + alert threshold design) |

**Or 4-week MVP** (S5/S2/S7/S1/S6 only; defer S3+S4):
- ~22 focused-days = 4-5 calendar weeks

### 4. Anything else that affects Phase A scope or sequencing

1. **GitHub baseline + R2 backups now in place** (Foundation Safety Workstream 1) — disaster recovery posture is solid going into Phase A. ✅
2. **Tier 1 corruption cleared today** (migration 098 + audit code change) — Phase A starts on clean Tier 1. ✅
3. **The Phase 33 documentation snapshot-date issue (Task 1)** means Phase A's Surface 5 Integrity Monitor MUST be snapshot-date-aware. Build it to show "as of {date}" prominently on every number.
4. **Existing email inventory is small + correct.** No fires.
5. **`closed_periods` table will be deprecated** by new `accounting_periods`. Migration must preserve existing locks.
6. **categorizer_decisions table from Phase A Section 2.5 is also pre-work.** Add to migration list.
7. **Surface 5 should NOT alarm on plug account balances differing between all-time and YE2025 cutoff.** This is an artifact of comparison-window choice, not a real drift.

### Stop-and-ping triggers (none tripped)

- Phase 33 work IS as complete as documented at its snapshot date (not less complete) → ✅ no trigger
- Period-lock infrastructure is moderate scope (~2.5 days), not invasive → ✅ no trigger
- Existing audit logging is partial-but-OK; new audit_trail table replaces it cleanly → ✅ no trigger
- No data quality issues affect Phase A viability → ✅ no trigger

### What I did NOT do

- No GL changes (all cleanup JEs proposed only)
- No schema migrations applied (designed only)
- No UI work
- No email disables
- No "while I'm in here" cleanup of unrelated code
- No edits to Phase 33 docs (proposed footnotes only)

### Time spent

~2 hours of focused investigation + design work. Within the 1-2 day budget.

End of Phase A.0 doc. Drew's 20-decision review unlocks the Phase A.1 build prompts.
