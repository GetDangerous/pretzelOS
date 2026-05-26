# Y-2 vs Y-3 Depreciation Methodology Verification — FY2025

**Generated:** 2026-05-26
**Purpose:** Confirm whether FY2025 is Year-2 or Year-3 for each MACRS asset class before locking the Form 4562 schedule.
**Status:** Investigation only. No GL changes, no CSV regeneration.

---

## Headline Conclusion

**FY2025 IS Year-2 for ALL asset classes.** The original v6 Form 4562 schedule's Y-2 assumption is correct directionally. However, the math reveals:

| Finding | NI swing |
|---|---:|
| ✅ All assets placed in service 2024 (not 2023) — Y-3 hypothesis REJECTED | $0 (Y-2 correct) |
| ✅ Leasehold §110-reduced basis $314,699 (per rebaseline) → Y-2 dep $20,980 | +$8,241 (less expense) |
| ⚠️ **Restaurant Equipment basis discrepancy** — v6 used $170,381; filed YE2024 Acc Dep math implies $177,409 (no §179 was taken) | -$2,249 (more expense) |
| ✅ F&F + Signage post-§179 bases verified cent-accurate vs filed Y-1 | $0 |
| **Net D&A change vs v6 schedule** | **-$5,992 less expense** |
| **Revised filing NI** | **-$346,632.39** |

vs. rebaseline doc target of -$344,394.28 — my number is $2,238 more negative because I'm flagging the **Restaurant Equipment basis correction** the rebaseline didn't address.

🔔 **STOP signal triggered:** Restaurant Equipment basis math doesn't reconcile to the v6 schedule's "$170,381 post-bonus" label. Drew should either (a) pull the filed 4562 PDF to confirm RE basis, or (b) accept the math-derived finding that no §179/bonus was taken on RE in 2024.

---

## Task 1 — Filed 2024 Form 4562 PDF search

**Result: PDF NOT findable in project directory.**

Searched:
- `/Users/drew/Code/claude code context/dangerous-pretzel/` (and subdirs)
- `/Users/drew/Downloads/`
- `/Users/drew/Desktop/`
- `/Users/drew/Documents/`

No file matching `1065*.pdf`, `4562*.pdf`, `*return*2024*`, `*IB*Tax*`, `*bodenstab*`.

**However, sufficient ground-truth data IS available** in `migrations/094_phase33c_ob_reset_to_filed_1065.sql` (the migration that seeded YE2024 OB cent-accurate to the filed return). Key data points extracted from migration:

| Asset | Filed gross basis | Filed YE2024 Acc Dep | Placed-in-service |
|---|---:|---:|---|
| Leasehold Improvements | $438,100.00 | $14,604.00 | **07/01/24** (explicit in migration line 4) |
| Furniture & Fixtures | $2,744.00 | $1,803.00 | 2024 (inferred — see Task 2) |
| Restaurant Equipment | $177,409.00 | $35,482.00 | 2024 (inferred — see Task 2) |
| Signage | $8,970.00 | $5,895.00 | 2024 (inferred — see Task 2) |
| Startup Costs (Part VI) | $70,900.00 | $2,363.00 amort | **07/01/24** (180-mo start) |

Acc Dep total per migration line 58: "Leasehold $14,604 + F&F $1,803 + Equip $35,482 + Signage $5,895" = **$57,784** ✓ matches Sched L Line 10b.

**For the RE basis question (see Task 2 Hypothesis B vs A), the filed 4562 PDF would close the question definitively. Recommend Drew pull it from records or Irene's portal.**

---

## Task 2 — Year determination per asset class

### Methodology

For each asset class, test three hypotheses against filed YE2024 Acc Dep:

- **Hypothesis A** — placed in service 2024, no §179, pure MACRS Y-1
- **Hypothesis B** — placed in service 2024, §179 + MACRS Y-1 on remaining
- **Hypothesis C** — placed in service 2023, Y-2 in 2024 (cumulative Y-1+Y-2)

The hypothesis whose computed Y-1 (or cumulative) exactly ties to filed YE2024 Acc Dep is the actual methodology. From that, 2025 year follows directly.

### Leasehold Improvements

| Test | Computation | Result |
|---|---|---:|
| Filed YE2024 Acc Dep | from Form 4562 | $14,604.00 |
| 15-yr SL full year | $438,100 / 15 | $29,206.67 |
| **Half-year on $438,100 (placed 07/01/24)** | $29,206.67 × 6/12 | **$14,603.33** ✓ |

**Conclusion: Placed in service 07/01/24 (confirmed by migration 094 note). 2024 = partial Y-1 (6 months). 2025 IS first full year = Y-2.**

Y-2 rate for 15-yr SL is 6.67% every year regardless — Y-2/Y-3 distinction doesn't change FY2025 number for Leasehold methodology. **§110 basis reduction** does change it (see Task 4).

### Furniture & Fixtures

| Hypothesis | Computation | Result |
|---|---|---:|
| Filed YE2024 Acc Dep | from Form 4562 | $1,803.00 |
| A: Pure Y-1 MACRS 14.29% × $2,744 | $392.12 | **REJECT** |
| **B: §179 $1,646 + Y-1 14.29% × $1,098** | $1,646 + $157 = $1,803 | ✓ EXACT |
| C: Placed 2023, cumulative Y-1+Y-2 by YE2024 | rejected by magnitude | REJECT |

**Conclusion: §179 of $1,646 elected in 2024 + Y-1 200DB on remaining $1,098. 2024 = Y-1. 2025 IS Y-2.**

Y-2 = 24.49% × $1,098 = **$268.90** (matches v6 schedule cent-accurate).

### Signage

| Hypothesis | Computation | Result |
|---|---|---:|
| Filed YE2024 Acc Dep | from Form 4562 | $5,895.00 |
| **B: §179 $5,382 + Y-1 14.29% × $3,588** | $5,382 + $513 = $5,895 | ✓ EXACT |

**Conclusion: §179 of $5,382 + Y-1 200DB on remaining $3,588. 2024 = Y-1. 2025 IS Y-2.**

Y-2 = 24.49% × $3,588 = **$878.70** (matches v6 schedule cent-accurate).

### Restaurant Equipment — ⚠️ FINDING

| Hypothesis | Computation | Result |
|---|---|---:|
| Filed YE2024 Acc Dep | from Form 4562 | $35,482.00 |
| **A: Pure Y-1 MACRS 20% × $177,409 (no §179, no bonus)** | $35,481.80 | **✓ EXACT** |
| B: §179 $7,028 + Y-1 20% × $170,381 | $7,028 + $34,076 = $41,104 | **REJECT** ($5,622 over) |
| C: Placed 2023, cumulative Y-1 ($35K) + Y-2 ($57K) by YE2024 | $92,253 | REJECT |

**Conclusion: NO §179 and NO bonus taken on Restaurant Equipment in 2024. Pure MACRS 5-yr 200DB. Filed YE2024 Acc Dep of $35,482 = exactly 20% × $177,409 (rounding to whole dollar).**

**This contradicts the v6 schedule.** The v6 schedule uses basis $170,381 labeled "post-bonus" and applies Y-2 32%, but $170,381 is not consistent with any of the three hypotheses given the filed YE2024 Acc Dep.

**Correct Y-2 (per Hypothesis A) = 32% × $177,409 = $56,770.88**
**v6 schedule Y-2 = 32% × $170,381 = $54,521.92**
**Discrepancy: $2,248.96 of MISSED deduction in v6 schedule.**

🔔 **Recommend Drew pull filed Form 4562 PDF** to confirm:
1. Is the actual depreciable basis on the 2024 4562 Restaurant Equipment line $170,381 or $177,409?
2. Was any §179 election made on Restaurant Equipment in 2024 (it would appear in Part I)?

If filed return shows $170,381 basis with §179 of $7,028, then YE2024 Acc Dep "should be" $41,104, but filed Sched L shows $35,482. Either way there's an inconsistency requiring Irene's clarification.

If filed return shows $177,409 basis with no §179, the v6 schedule has a $2,249 understatement of FY2025 depreciation.

---

## Task 3 — Backup verification via FY2024 P&L

FY2024 P&L from QBO would show total depreciation expense claimed in 2024. Cross-reference target = $57,784 (sum of filed Y-1 Acc Dep on the four MACRS assets) + $2,363 (Startup amort Jul-Dec 2024) = **$60,147**.

Did not pull FY2024 QBO P&L for this verification because the YE2024 Acc Dep figures from the filed return are already locked in migration 094 as the ground truth. If Irene's QBO matches, fine; if not, the filed return controls. No new finding expected here.

---

## Task 4 — Revised FY2025 Form 4562 schedule

Using corrected per-asset year and basis:

| Asset | Cost Basis | Method | Rate | FY2025 Expense |
|---|---:|---|---:|---:|
| Leasehold Improvements (§110-reduced) | $314,699.00 | SL 15yr (Y-2, full year) | 6.67%* | **$20,979.93** |
| Restaurant Equipment | $177,409.00 | 200DB 5yr (Y-2) | 32.00% | **$56,770.88** |
| Furniture & Fixtures | $1,098.00 | 200DB 7yr (Y-2) | 24.49% | $268.90 |
| Signage | $3,588.00 | 200DB 7yr (Y-2) | 24.49% | $878.70 |
| **Subtotal Depreciation** | | | | **$78,898.41** |
| Startup & Organizational Costs | $70,900.00 | SL 180-mo | full year | $4,726.67 |
| Sprinter Van | $200,000.00 | §179 | 100% | $200,000.00 |
| **Total FY2025 D&A** | | | | **$283,625.08** |

\* Computed as $314,699 / 15 = $20,980 (effectively 6.67%); §110 election reduces depreciable basis going forward per Irene's QBO adjustment.

### Revised Filing NI

```
QBO Post-Irene YE2025 NI:                  -$58,501.31

Adjustments to align with filing position:
  − Revised LI dep (§110, Y-2):           -$20,979.93
  − Revised RE dep (Y-2 32% × $177,409):  -$56,770.88
  − Revised F&F dep (Y-2 24.49%):              -$268.90
  − Revised Signage dep (Y-2 24.49%):          -$878.70
  − Startup amortization:                   -$4,726.67
  − Sprinter §179 first-year expensing:   -$200,000.00
  − Tips Income reclass (pass-through):     -$4,506.00
                                          ─────────────
Revised Filing NI:                        -$346,632.39
```

Saved as proposed `Form_4562_FY2025_Schedule_REVISED.csv` (not yet written — investigation only).

---

## Task 5 — Year-by-year sanity check

If Hypothesis C (placed 2023) were true for Restaurant Equipment:

| Year | Rate | Dep | Cumulative |
|---|---:|---:|---:|
| 2023 Y-1 (placed Q?) | 20% | $35,482 | $35,482 |
| 2024 Y-2 | 32% | $56,771 | **$92,253** |

Filed YE2024 Acc Dep on Restaurant Equipment = **$35,482**, not $92,253. **Hypothesis C definitively REJECTED.**

Same test applied to F&F and Signage — both filed YE2024 Acc Dep values ($1,803 and $5,895) are consistent ONLY with §179 + Y-1 in 2024 (Hypothesis B), not cumulative Y-1+Y-2 placement-in-2023 scenarios.

All four MACRS asset classes confirmed placed in service 2024.

---

## Comparison to existing v6 Form 4562 schedule

| Asset | v6 FY2025 dep | Revised FY2025 dep | Δ |
|---|---:|---:|---:|
| Leasehold ($438,100 basis → §110-reduced $314,699) | $29,221.00 | $20,979.93 | **-$8,241.07** (less expense) |
| Restaurant Equip ($170,381 → $177,409 basis) | $54,521.92 | $56,770.88 | **+$2,248.96** (more expense) |
| F&F | $268.90 | $268.90 | $0.00 |
| Signage | $878.71 | $878.70 | -$0.01 |
| **Total dep change** | | | **-$5,992.22** |

**Net: revised schedule has $5,992 LESS depreciation expense than v6.** Driven by:
- §110 basis reduction on Leasehold: -$8,241 (already in rebaseline doc)
- RE basis correction: +$2,249 (NEW finding, not in rebaseline doc)

---

## Stop signals — triggered

🔔 **The filed 2024 4562 PDF isn't findable in the project directory.** Working from migration 094's embedded YE2024 Acc Dep totals which were extracted from the filed return. Sufficient for Y-2 vs Y-3 determination but not for confirming the RE basis discrepancy.

🔔 **Restaurant Equipment 2024 actuals don't reconcile cleanly to the v6 schedule's "$170,381 post-bonus basis" label.** The filed Y-1 Acc Dep of $35,482 ties exactly to 20% × $177,409 (no §179, no bonus). The v6 schedule's $170,381 implies §179 of $7,028 was taken, but that would put YE2024 Acc Dep at $41,104 — $5,622 higher than filed. **Drew needs to confirm whether v6 schedule basis was wrong or whether there's a different convention/election we're missing.**

---

## Recommendations for filing CSV regeneration

When Drew approves, regenerate with the following:

1. **`Form_4562_FY2025_Schedule_REVISED.csv`** — apply revised per-asset basis + rates
2. **`PnL_FY2025_filing.csv`** — revised NI = -$346,632.39
3. **`BS_YE2025_filing.csv`** — Acc Dep += $283,625; NI absorbed to Capital
4. **`M2_Worksheet_FY2025.csv`** — Line 4 (NI per books) = -$346,632
5. **`Memo_for_Irene.md`** — Add note: "Restaurant Equipment basis corrected from $170,381 (v6) to $177,409 (filed Sched L), adds $2,249 of FY2025 deduction"

If Drew prefers to stick with v6's $170,381 RE basis (for consistency with whatever Irene has in workpapers), revised NI = **-$344,383** (≈ rebaseline doc's -$344,394, ~$10 rounding diff).

---

## What Drew needs to decide

| Question | Default | Better-data option |
|---|---|---|
| **A. RE basis $170,381 vs $177,409** | Use $177,409 (math-confirmed from filed Sched L) → Y-2 = $56,771 → adds $2,249 deduction | Pull filed 4562 PDF; if it shows $170,381 with §179 of $7,028, ask Irene how Y-1 reconciled to filed $35,482 Acc Dep |
| **B. §110 basis $314,699 vs $318,691** | Use $314,699 per rebaseline (matches your prior position) → Y-2 = $20,980 | Confirm with Irene whether to use $314,699 or her QBO YE2025 LI of $318,691 (drops dep further by $266) |
| **C. Final filing NI position** | -$346,632 (with RE fix) or -$344,383 (without) | After answering A+B, lock the final number |

---

## Budget

Time spent: ~30 min (closer to 45 with the file searches). Investigation only, no CSV/GL changes.

Document complete. Awaiting Drew's review + filed 4562 PDF (if available) + decisions on Questions A/B/C.
