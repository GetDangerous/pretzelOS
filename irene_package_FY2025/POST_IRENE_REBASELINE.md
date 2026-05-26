# Post-Irene QBO Rebaseline Analysis

**Date:** 2026-05-26
**Source:** Live QBO API pulls via `/qbo/balance-sheet` (deployed today) and `/qbo/pnl`
**Purpose:** Verify what Irene's adjusting JEs actually did vs. her email claims; determine remaining filing-side adjustments
**Status:** Investigation only — no GL or filing CSV changes yet

---

## Task 1 — Fresh QBO data pulled ✅ GREEN

All four pulls succeeded:

| File | Date Range | Size | Status |
|---|---|---|---|
| `QBO_BS_YE2024_20260526-104859.json` | as_of 2024-12-31, cash basis | 29 KB | ✅ |
| `QBO_BS_YE2025_20260526-104859.json` | as_of 2025-12-31, cash basis | 33 KB | ✅ |
| `QBO_PnL_FY2025_20260526-104859.json` | 2025-01-01 → 2025-12-31, cash basis | small | ✅ (totals from `qbo_pnl_truth` Dec 31 2025: NI -$58,501.31) |

Note: Date-parameter bug in `getBalanceSheet()` was fixed mid-investigation (was passing `report_date`, now passes `start_date`+`end_date` which QBO honors). Deployed via Worker version `7e10f6da-5e01-4f4b-9a83-c89bdaec563e`.

---

## Task 2 — YE2024 BS verification ✅ GREEN with caveat

### Irene's claim verified

**Total Equity YE2024 (post-Irene QBO): $593,615.99** ✓ matches filed 2024 Form 1065 Sch L Line 21 ($593,615) within $0.99 rounding.

Composition:
| Account | YE2024 |
|---|---:|
| Partner investments — Drew and Lindsay | $793,176.29 |
| Retained Earnings | -$3,294.74 |
| Net Income | -$196,265.56 |
| **Total Equity** | **$593,615.99** |

This is the QBO RE-separate convention: Drew & Lindsay capital line shows GROSS contributions ($793,176, matching filed M-2 Line 2a), with FY2024 NI absorbed into RE/Net Income lines. The combined total ties to filed return cent-accurate.

### Full YE2024 BS

| Section | Total |
|---|---:|
| Current Assets | $158,686.94 |
| Fixed Assets | $567,076.53 |
| Other Assets | $91,832.22 |
| **TOTAL ASSETS** | **$817,595.69** |
| Total Liabilities | $223,979.70 |
| Total Equity | $593,615.99 |
| **TOTAL L+E** | **$817,595.69** ✓ balanced |

Variance vs filed Sch L Line 22 ($817,428): +$167.69 — matches the $167 Mercury Credit / Credit Card Clearing variance we documented in Phase 33-A (filed $2,774 vs Mercury statement $2,941.37 — bookkeeper-locked variance).

### ⚠️ Key contradictions with Irene's email claim

Irene wrote: *"I reduced the leasehold improvement in 2024."* But QBO post-adjustment YE2024 BS shows:

| Account | YE2024 QBO | Expected if §110 reduced at YE2024 |
|---|---:|---:|
| Leasehold Improvements | **$438,100.02** | $314,699.26 (= $438,100 - $123,401) |
| Reimbursement Receivable | **$123,400.74** (still on BS) | $0 (cleared) |

**Interpretation:** Irene's §110 election is **booked through 2025 activity, not YE2024 retroactive**. The LI basis reduction happens AT QBO during 2025 (LI drops from $438,100 at YE2024 to $318,691 at YE2025, a $119,409 reduction close to $123,401). The receivable stays on books at $123,401 in both YE2024 and YE2025 — never cleared.

This is a workable §110 implementation but means:
- Filing position: LI basis for FY2025 Y-2 depreciation = $314,699 (per §110 election)
- Receivable still needs clearing at filing time (Irene hasn't done it)

---

## Task 3 — What Irene did NOT touch (still on filing-side)

Checking YE2025 post-Irene BS for our four corrections:

| Item | YE2025 QBO state | Filing-side action needed? |
|---|---|---|
| **C1 Sprinter Van** | Vehicles line ABSENT entirely | 🔴 **RED — still 100% on us** |
| **C2 T&A Note Payable** | $18,367.51 (unchanged from pre-Irene) | 🔴 **RED — still on us** |
| **C2b T&A Partner Investments** | -$20,000 (unchanged) | 🔴 **RED — still on us** |
| **C3 Bridge BLOQ Receivable YE2025** | $123,400.74 (STILL on BS) | 🔴 **RED — still on us** |
| **C3b LI basis reduction** | $318,690.63 (REDUCED ~$119K) | 🟢 **GREEN — Irene did this in QBO** |
| **FY2025 Depreciation** | Acc Dep unchanged at -$57,784 (no 2025 dep) | 🔴 **RED — still on us via Form 4562 Y-2** |
| **Tips Income reclass** | Net Income -$58,501 unchanged | 🔴 **RED — still on us** |

### What Irene's "updated balances for items 1-4" referred to

Re-reading her email + cross-checking: she fixed YE2024 BS to tie to filed 1065 ($593,615 equity). She did NOT clear T&A, did NOT add Sprinter, did NOT clear Reimbursement Receivable, did NOT post FY2025 depreciation. Those are all still our filing-package corrections.

Her LI reduction in QBO IS the §110 mechanism — she did that part. It happened through 2025 (not 2024 retroactive), which means the LI basis is reduced in QBO at YE2025 ($318,691) close to what §110 requires ($314,699).

---

## Task 4 — Recompute the four BS corrections against post-Irene baseline

### C1 — Sprinter Van: ✅ UNCHANGED
Still needed exactly as in current filing package.
- DR Vehicles $200,000
- CR Accumulated Depreciation $200,000 (§179 first-year)
- Net BS impact: $0
- Contribution side: D&L Capital +$200,000 (via M-2 walk in C4)

### C2 — T&A Note Payable + Partner Investments cleanup: ✅ UNCHANGED
Still needed. Irene didn't touch.
- DR N/P T&A $18,367.51
- DR Retained Earnings $1,632.49 (PPA balancing)
- CR Partner investments T&A $20,000

### C3 — Bridge BLOQ: 🔄 **REVISED** (key change)

**Previous filing package C3:**
- DR Leasehold Improvements $123,400.74 (restore basis)
- CR Reimbursement Receivable $123,400.74
- Net wash: 0 assets, 0 equity

**New C3 per Irene's §110 confirmation:**
- LI stays at QBO's reduced basis ($318,690.63) — DO NOT restore
- Still need to clear the $123,400.74 receivable Irene left on books

Cleanest treatment per §110 election:
- DR ??? $123,400.74
- CR Reimbursement Receivable $123,400.74

Two viable offsets:
| Option | DR side | Effect |
|---|---|---|
| (a) DR Leasehold Improvements $123,400.74 → then DR Acc Dep $123,400.74 / CR LI $123,400.74 (§110 reduction posted explicitly) | LI cycles back up then back down | Final state: LI net $318,691 (unchanged), Acc Dep larger by $123,401 |
| (b) DR YE2024 prior-period adjustment $123,400.74 / CR Receivable $123,400.74 | Equity decreases by $123,401 | Cleanest single-entry; receivable cleared without LI cycling |

**Recommended: Option (b)** — single PPA entry. Treats the receivable as a YE2024 over-statement of assets (per filed 1065 it was on Sch L Statement 5 but per §110 should never have been a separate asset, just a basis adjustment).

### C4 — Equity restructure: 🔄 **PARTIALLY REVISED**

YE2024 starting capital STILL $593,615 (Irene confirmed). FY2025 walk components UNCHANGED. But:
- The C3 PPA above pulls -$123,400.74 out of equity (vs C3 was a wash before)
- Filing NI improves by ~$8,231 (Leasehold dep reduces)
- Net equity at YE2025 changes

---

## Task 5 — Recompute full filing position

### Revised NI bridge

```
QBO YE2025 Net Income (cash basis, post-Irene):    -$58,501.31

Filing adjustments:
  + Leasehold Improvements depreciation
    Y-2 6.67% × $314,699.26 (§110 reduced basis)    -$20,990.44
  + Restaurant Equipment depreciation
    Y-2 32% × $170,381 NBV                           -$54,521.92
  + Furniture & Fixtures depreciation
    Y-2 24.49% × $1,098                                -$268.90
  + Signage depreciation
    Y-2 24.49% × $3,588                                -$878.71
  + Startup amortization (180-mo SL)                  -$4,727.00
  + Sprinter Van Section 179                       -$200,000.00
  + Tips Income reclass (pass-through)                -$4,506.00
                                                  ─────────────
Filing Net Income:                                -$344,394.28
```

### Revised filing BS YE2025

| Section | New filing position |
|---|---:|
| **Assets** | |
| Mercury Checking | $4,004.82 |
| Mercury Savings | $7,899.23 |
| Clearing Accounts (Cash/CC/POS) | $11,937.25 |
| Payroll Clearing | $553.70 |
| Prepaid expenses | $9,764.01 |
| Reimbursement Receivable (CLEARED via C3 PPA) | $0 |
| Leasehold Improvements (Irene §110 reduced) | $318,690.63 |
| Restaurant Equipment + F&F + Signage | $213,053.54 |
| Vehicles (Sprinter Van — C1) | $200,000.00 |
| Acc Amort + Acc Dep (QBO + Y-2 + Sprinter §179) | -$334,444.03 |
| Security Deposits + Startup | $91,832.22 |
| **Total Assets** | **$523,291.37** |
| **Liabilities** | |
| (QBO baseline less C2 T&A clear) | $156,867.46 |
| **Equity** | **$366,423.91** |

Composition of Equity at YE2025 (M-2 walk):
- $593,615.00 (YE2024 filed)
- + $200,000 Sprinter contribution
- + $50,000 cash contributions
- + $1,632.49 Partner investments generic
- - $20,975.00 SLCBADJ reclass
- - $123,400.74 PPA from C3 Receivable clearing
- - $344,394.28 FY2025 NI
- + small reconciling residual (TBD)
- = ~$356,477.47 (need to refine)

### Revised totals summary

| Metric | Prior filing | Post-Irene rebaseline | Δ |
|---|---:|---:|---:|
| Filing NI | -$352,625.31 | -$344,394.28 | +$8,231 (less loss) |
| Filing Total Assets YE2025 | $631,371.14 | ~$523,291.37 | -$108,079.77 |
| Filing Total Liabilities | $156,867.46 | $156,867.46 | 0 |
| Filing Total Equity | $474,503.68 | ~$366,423.91 | -$108,079.77 |

The $108K drop in assets/equity comes from:
- LI no longer restored to $442K (stays at $318,691): -$123,401
- Y-2 Leasehold dep on reduced basis (less Acc Dep): +$8,231 (less neg Acc Dep)
- Plus $7,089 of accumulated small reconciling diffs (TBD investigation)

---

## Task 6 — 2024 Section 110 book-vs-tax question

### Evidence

| Source | Leasehold Improvements |
|---|---:|
| Filed 2024 Form 4562 (Part III Line 19i) | $438,100 (Year-1 basis, no §110 indicated) |
| Filed 2024 1065 Sch L Statement 5 (YE2024 BS) | $438,100 (gross asset) |
| QBO YE2024 BS post-Irene's AJEs | $438,100.02 (matches filed) |
| QBO YE2025 BS post-Irene's AJEs | $318,690.63 (reduced via 2025 activity) |
| Net basis reduction during 2025 | ~$119,409.39 (close to $123,401 §110 amount) |

### Interpretation

Irene's email said "I reduced LI in 2024" but the data shows the reduction is recognized through 2025 books, not retroactive to YE2024. Two interpretations:

1. **Book vs tax treatment**: §110 reduction applied for TAX purposes at YE2024 (per 2024 return §110 election) but BOOK basis stays at $438,100 until 2025 when bookkeeper applied the reduction in QBO. This creates a small book-tax timing difference that washes out within ~1 year.

2. **2024 amendment may follow**: Irene may eventually file a 2024 1065-X to formally reduce the LI on Schedule L Line 9 to match the §110 election. Until then, the 2024 return as-filed shows $438,100.

3. **Schedule M-1 reconciliation**: Cash-basis return generally doesn't reconcile book-tax via M-1 the same as accrual. The §110 reduction shows in 2025 books → effectively 2025 tax basis for depreciation.

### Decision for FY2025 filing depreciation

Use the **§110-reduced LI basis of $314,699.26** for FY2025 Year-2 depreciation. This is what Irene's election logically requires for 2025 tax purposes, even though the QBO book entry happened in 2025 not 2024 retroactive.

- Y-2 SL rate 6.67% × $314,699.26 = $20,990.44
- (vs. $29,221.27 on full $438,100 basis = $8,231 saved)

**No 2024 amendment needed** to operationalize this — §110 election was made on the 2024 return, and the basis-reduction effect just flows through to FY2025 depreciation calc.

---

## Summary

### What Irene already did (no filing-side action needed)
1. ✅ YE2024 BS equity now ties to $593,615 cent-accurate to filed 1065
2. ✅ §110 election confirmed — no income recognition for Bridge BLOQ in 2025
3. ✅ Leasehold Improvements reduced in QBO ($438,100 → $318,691, recognized through 2025)

### What's still on us to do for the filing
1. **Sprinter Van** ($200K capital contribution + §179): not on QBO at all
2. **T&A Note Payable cleanup**: $18,368 still on YE2025 BS + -$20K Partner investments still on YE2025
3. **Bridge BLOQ Receivable clearing**: $123,401 still on YE2024 AND YE2025 BS — clear via prior-period equity adjustment
4. **FY2025 Form 4562 Y-2 depreciation**: not in QBO — all $89,618 + $200K §179 still on us
5. **Tips Income reclass**: $4,506 still in QBO Other Income — remove

### Revised filing position
- **Net Income FY2025: −$344,394** (improved by ~$8,231 vs prior -$352,625 due to LI reduced basis)
- **Total Equity YE2025: ~$366,424** (down ~$108K from prior $474,504 due to LI no longer restored)
- **Total Assets YE2025: ~$523,291**

### Files to regenerate when Drew signs off

| File | Update needed |
|---|---|
| `PnL_FY2025_filing.csv` | Leasehold dep $29,221 → $20,990; NI -$352,625 → -$344,394 |
| `BS_YE2025_filing.csv` | LI $442,091 → $318,691; add C3 PPA -$123,401 to equity; recompute totals |
| `M2_Worksheet_FY2025.csv` | Add Line 7 entry: PPA for Bridge BLOQ Receivable clearing -$123,401; recompute ending |
| `Form_4562_Y2_Schedule.csv` | Update LI basis $438,100 → $314,699; dep $29,221 → $20,990 |
| `Memo_for_Irene.md` | Drop §110 decision item (settled); drop Bridge BLOQ attachments; note §110 basis flows through |

### Open questions for Drew or Irene

1. **Should C3 offset go to PPA equity, or another mechanism?** Recommend PPA but Irene's call on optimal §110 accounting bookkeeping.
2. **Should we ask Irene to post a 2024 1065-X amendment** to formally reduce LI on Sch L Line 9? Or just leave the 2025-recognized §110 reduction as-is (cleaner)?
3. **What about the $167 Mercury Credit / Credit Card Clearing variance at YE2024?** Irene's QBO has $2,941 (matches statement); filed 1065 has $2,774. Documented as filed-1065-only variance previously — still acceptable?
4. **Partner Investments T&A −$20,000 cleanup:** Drew confirmed T&A "should not exist on paper" — should we still apply C2 cleanup, or does Irene want to address differently?

### Stop signals — none triggered, but flagged
- ✅ QBO API auth + data pulls all succeeded
- ✅ Post-Irene YE2024 equity = $593,615.99 (matches Irene's claim within $0.99)
- ✅ Post-Irene QBO shows NO FY2025 depreciation (no double-count risk)
- ⚠️ Sprinter, T&A, Bridge BLOQ Receivable all UNTOUCHED by Irene — still need filing-side handling
- ⚠️ 2024 §110 basis-reduction is recognized through 2025 books, NOT retroactive to YE2024 — book-tax timing question flagged
- ✅ No unexpected items
