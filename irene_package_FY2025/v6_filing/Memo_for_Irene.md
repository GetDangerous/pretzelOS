# FY2025 Filing Package — Memo to Irene Bodenstab

**From:** Drew Sparks, Dangerous Pretzel Company LLC
**Date:** May 21, 2026
**Re:** FY2025 Form 1065 preparation — adjusted positions vs QBO baseline
**Net Loss for filing:** $(352,625.31)

---

Hi Irene,

Bookkeeper let go February 2026 after discovering errors. QBO has 2025 in reasonable shape at the transaction level. The attached statements reflect QBO's data with four tax-position corrections layered on top.

## Items adjusted from the QBO baseline (4 items)

**1. FY2025 depreciation per Form 4562 Year-2 schedule: $89,618 ($84,891 regular depreciation + $4,727 amortization on Startup Costs).** The bookkeeper did not record any depreciation in 2025 — QBO P&L shows $0 for the year. The attached `Form_4562_Y2_Schedule.csv` shows per-asset detail (Leasehold Improvements $29,221, Restaurant Equipment $54,522, F&F $269, Signage $879, Startup Amortization $4,727).

**2. Sprinter Van Section 179 election: $200,000.** Mercedes Sprinter cargo van contributed by Drew and Lindsay to the business on January 15, 2025. Title transferred, GVWR confirmed >6,000 lbs (qualifies as heavy vehicle, not subject to SUV cap under §179(b)(6)). 100% business use. The Sprinter was not on QBO at all — bookkeeper was unaware of the contribution. Title and GVWR documentation attached.

**3. Tips Income reclassification: $4,506.** QBO had this as Other Income. Per the 2025 W-3 Box 7 (Social Security tips $24,907) and the Toast Payroll GL Standard Report tip-distribution lines (also $24,907 — ties cent-accurate), all tips collected at POS pass through to employees and are reported on their W-2s. They should not be partnership income. Removed from Other Income. No BS adjustment needed — tips were collected at POS and paid out to employees in cash during the year (per Toast Payroll GL); they were never partnership income to begin with. YE2025 Tips Payable balance reflects only the small year-end timing accrual ($1,551), unchanged from QBO.

**4. Bridge BLOQ tenant improvement reimbursement, $123,401 — your call on Section 110.** Reimbursement received February 24, 2025 from the Bridge BLOQ tenant improvement allowance per the lease agreement. The lease and landlord settlement letter are attached. Two interpretations:

  - **(a) Treat as Section 110 qualified lessee construction allowance**, requiring leasehold basis reduction. This would require amending the 2024 Form 4562 (which currently carries the full $438K leasehold basis without reduction) and recalculating 2024 depreciation and the YE2024 Schedule L.

  - **(b) Treat as receivable-clearing per lease terms, no income recognition, no basis reduction.** Conservative interpretation, matches the 2024 return as-filed. The attached BS reflects interpretation (b). The QBO bookkeeper had recorded the cash receipt as a basis reduction (interpretation a-ish) but didn't formally elect §110 or clear the receivable, so QBO has both the reduced LI basis AND the open $123K receivable — which is internally inconsistent. The filing BS reverses the bookkeeper's LI reduction (restoring the full $438K basis) and clears the receivable.

  Happy to revise to interpretation (a) if you prefer — would just need to amend the 2024 4562.

## Items handled on the BS that match the 2024 filed return

- **Todd & Amanda buyout:** paid in full February 13, 2025 ($80K final settlement payment to Chase ••7262 from Mercury). Note Payable cleared. The bookkeeper had miscoded part of the payment, leaving $18,368 on the BS at YE2025 in QBO. The filing BS shows the correct $0 balance.

- **Bridge BLOQ Receivable:** cleared via the February 24 cash receipt described above. QBO still shows $123,401 receivable at YE2025; filing BS shows $0.

- **Mercury Checking balances reconcile to bank statements at every month-end YE2024 - YE2025** in our internal management ledger. (Filing BS uses QBO figures for your workpaper consistency.)

- **Partner capital walk follows Schedule M-2 logic anchored to the 2024 filed return.** Attached M-2 worksheet shows the full reconciliation: starting capital $593,615 (filed YE2024 Sch M-2 Line 9, verified cent-accurate to filed return PDF) + $200K Sprinter contribution + $50K cash contributions (Sep 23 + 26 Wells Fargo transfers) − $20,975 SLCBADJ reclass to N/P D&L (per my Feb 26 2025 instruction to the bookkeeper) + $1,632 minor partner adjustment − $352,625 net loss = $471,647 ending capital. (Plus a -$600 reconciling residual line — rounding + accumulated minor entries through the bookkeeper-handover, disclosed on Schedule M-2 Line 7; 0.13% of equity, immaterial.)

## One short-term cash event worth knowing about

February 12, 2025, I personally loaned the partnership $80,000 from my Wells Fargo account to fund the T&A final settlement payment before the Bridge BLOQ TI reimbursement landed. The loan was repaid in full on March 3, 2025 after the BB TI was received February 24. Short-term bridge loan (19 days), no interest, no Section 7872 implication at this tenor. Mercury shows the inflow Feb 12 and outflow Mar 3, but no permanent capital impact. Properly recorded as "Loan from Drew Sparks" → drained to $0 at YE2025.

## OpEx line categorization note

The operating expense line categorization in the filing P&L reflects a small amount of reclassification from QBO's structure (a few items moved between Contract Labor, Restaurant Supplies, and other lines based on our review of the underlying transactions). Total OpEx and bottom-line NI still tie to QBO + the four corrections documented above. Line-by-line variances are immaterial and consistent with a normal bookkeeper-handover review.

## Leasehold Improvements — small Year-1 addition

The Form 4562 Year-2 schedule applies Year-2 conventions to the original $438,100 leasehold basis (per filed 2024 4562). A small $3,700 LI addition was posted in March 2025 that would technically be its own Year-1 asset; depreciation impact is immaterial (~$100-200 under half-year convention). Worth a Y-1 line on the FY2025 4562 if you want strict treatment.

## Payroll figures

Wages per W-3 Box 3 (SSA-filed): **$166,070.37**. Toast Payroll GL ties to that within $218 (0.13%). QBO's Salaries & Wages total of $169,488 is within 2% of the W-3 figure (slight bookkeeper over-statement we elected not to chase). The filing P&L uses the QBO figure of $169,488 for workpaper consistency. The full W-3 (eStratex, EIN 93-2570614) is attached.

There's a known issue I want to flag: the bookkeeper's xtraCHEF integration had been posting payroll JEs twice in QBO for many pay periods, which we believe inflated QBO's pre-deduplication wages to ~$339K. The QBO Total Salaries & Wages line of $169,488 reflects the de-duplicated view. If you'd prefer the W-3-ties number ($166,070), that's a $3,400 deduction adjustment we can apply.

## Tips residual ($1,143 unaccounted)

POS-collected tips $30,575; W-3 Box 7 tips paid to employees $24,907; YE Tips Payable accrual on BS $4,307. That leaves $1,143 unaccounted. Likely auto-gratuity / mandatory service charges (which ARE restaurant revenue under IRS rules) on large parties. Magnitude is immaterial (~0.2% of revenue). Happy to investigate further if you want a strict reconciliation.

## Attached files

1. `PnL_FY2025_filing.csv` — Profit & Loss, filing position
2. `BS_YE2025_filing.csv` — Balance Sheet, filing position
3. `M2_Worksheet_FY2025.csv` — Schedule M-2 capital reconciliation
4. `Form_4562_Y2_Schedule.csv` — Per-asset depreciation detail (supporting workpaper)
5. **Title document and GVWR documentation for Sprinter Van** — *Drew to attach separately*
6. **Single-purpose business-use statement for Sprinter Van (one-page, signed by Drew)** — *Drew to attach separately*
7. **Bridge BLOQ lease document** — *Drew to attach separately*
8. **Bridge BLOQ landlord settlement letter** — *Drew to attach separately*
9. `ViewW3Report.pdf` — 2025 W-3 (eStratex, EIN 93-2570614)

## What I need from you

1. **Section 110 election decision** (item 4 above) — your judgment on whether the Bridge BLOQ reimbursement qualifies for formal §110 election (requiring 2024 amendment) or stays as receivable-clearing.
2. **Final 1065 + K-1s** — split 50/50 between Drew and Lindsay (per filed 2024 K-1 convention).
3. **Anything else you spot.** This was a messy year of bookkeeper handover. If you see an issue, please flag it.

Thanks Irene. Let me know if you need anything else.

Drew
