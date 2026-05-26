# Phase 33 — Questions Queue for Drew

**Drew status**: Stepped away. I continued read-only work. Below are everything I'm blocked on. Numbered for easy reply.

## Critical (blocks Phase 33-C execution)

### Q1 — Bridge BLOQ Section 110 treatment
Filed Form 4562 shows **Reduction in Basis is BLANK** for Leasehold Improvements. This means **Irene did NOT apply Section 110 basis reduction at YE2024**. The $123,401 sits on YE2024 Schedule L Statement 5 as "Reimbursement Receivable" (current asset).

When the $123,401 cash is received from BB Billboard in Feb 2025, what's the offsetting entry?

**Options:**
- **(a)** Apply Section 110 in 2025: DR Cash $123,401 / CR Bridge BLOQ Receivable $123,401, AND DR Bridge BLOQ Receivable $123,401 / CR Leasehold Improvements $123,401 (reduces future depreciation basis)
- **(b)** Treat as non-taxable other income in 2025 (TI reimbursement under landlord's standard treatment)
- **(c)** Defer / clear receivable only without Section 110 election (basis stays at $438,100)
- **(d)** Ask Irene — she filed it as a receivable so she likely intended a 2025 treatment

**My recommendation**: Ask Irene directly. Pretzel OS treatment depends on her answer.

### Q2 — T&A $80,000 Final Settlement Payment
The filed return has N/P Todd and Amanda = $80,000 at YE2024 (Settlement Payable). Per Settlement Agreement, the Final Payment was due within 60 days of Dec 18 2024 Effective Date = ~Feb 16, 2025.

**Two $80K Mercury outflows found in early 2025:**
- **Feb 13, 2025**: $80,000 transfer to Chase Checking ••7262
- **Mar 3, 2025**: $80,000 transfer to Wells Fargo ••6788

Which one was the T&A Final Settlement Payment?

(The other one might be Drew's personal owner-related transfer — but you said no distributions. So one of these IS T&A. Could you check your records?)

## Important (blocks Phase 33-F/G but not 33-C)

### Q3 — Mercury Credit $167 variance — accept or chase?
Mercury Credit Dec 2024 statement closing: **$2,941.37**.
Filed Schedule L Statement 7 Credit Card Payable: **$2,774**.
Variance: **$167.37** (statement shows $44.09 cashback; rest unexplained).

**Options:**
- **(a)** Use filed $2,774 for YE2024 OB; accept $167 variance as documented "filed-1065-only" item
- **(b)** Ask Irene for the bookkeeper's reconciling math
- **(c)** Use $2,941.37 (Mercury statement) and document filed return as off by $167 (cannot — filed return is locked per P1)

**My recommendation**: (a) — accept as documented variance. The amount is small.

### Q4 — N/P Toast $3,874 — accept bookkeeper value?
Jan 15 PDF showed Note Payable - Toast amortizing from $5,593 (Jun 2024) to $3,874 (Dec 2024) — ~$200/month principal paydown over 7 months.

The actual Toast equipment financing agreement isn't in our possession (per DEC3).

**Options:**
- **(a)** Use filed $3,874 for YE2024 OB; document as "bookkeeper-recorded value; original agreement not in our possession"
- **(b)** Drew tries to pull the Toast equipment financing agreement from Drew's Toast account
- **(c)** Ask Irene to provide her workpaper

**My recommendation**: (a) — accept. Amount is small.

### Q5 — D&L $793,176 capital contributions — source-trace required?
Filed M-2 shows Drew + Lindsay contributed **$793,176 cash** during 2024 ($396,588 each).

We have Mercury statement PDFs Aug 2023 - Dec 2024 (in `bank_statement_balances` extracted at month-end only). We do NOT have per-transaction Mercury data pre-Jan 2025.

**Options:**
- **(a)** Accept filed M-2 as authoritative; equity bridge starts from $593,615 ending capital with no source-trace
- **(b)** I attempt to identify D&L cash inflow transactions from Mercury 2024 PDFs (would need to read each monthly PDF and extract inflows that look like partner contributions)
- **(c)** Drew supplies a list of D&L contribution transactions with dates/amounts

**My recommendation**: (a) — accept filed M-2. Source-tracing is nice-to-have but not blocking. Irene already verified $793K when she filed.

## Documentation-only (Drew confirms intent)

### Q6 — Sprinter Van Section 179 for FY2025
Pretzel OS has these JEs dated Jan 15, 2025:
- `22f-sprinter-contribution-2025`: DR Vehicles $200K / CR Partner investments:Drew and Lindsay $200K (capital contribution, non-cash)
- `22f-sprinter-sec179-2025`: DR Depreciation $200K / CR Accumulated depreciation $200K (Section 179 full first-year expense)

Filed 2024 return has NO vehicles, NO Section 179 (Line 12 blank). So Sprinter is a 2025 event.

**Confirm**: For FY2025 1065 (when Irene files it), is the intended treatment:
- $200K Sprinter capital contribution by D&L ✓
- $200K Section 179 election in 2025 (full first-year expense)
- Or alternative: 5-yr MACRS depreciation (or 200DB 5-yr) rather than Section 179?

**Default per current JEs**: Section 179 $200K. If Drew + Irene want different treatment, adjust now.

### Q7 — DEC8 confirmation
You said "yes and yes" earlier — confirming you want **Option A** for Mercury GL strict-match every month-end (no bounded drift). That requires reconciling every month-end Aug 2023 - present.

**Reconfirm**: For pre-2025 months (when Pretzel OS didn't sync Mercury), this means I need to:
- Read every Mercury Aug 2023 - Dec 2024 statement PDF
- Compute GL effect of each Mercury txn (if not categorized, leave in Cash Clearing)
- Match GL Mercury Checking to bank statement closing balance at every month-end

This is significant additional work. Alternative: accept "Mercury GL ties cent-accurate at YE2024 OB and at every post-YE2024 month-end; pre-YE2024 month-ends documented as bookkeeper-era reconstructed from bank statements".

**Confirm Option A (strict every month-end including pre-2025) or Option B (cutover at YE2024)?**

### Q8 — FY2025 monthly depreciation review
Phase 22-F backfill at YE2024 ($57,784 dep + $2,363 amort = $60,147) ✓ ties cent-accurate to Form 4562.

But FY2025 monthly depreciation in Pretzel OS is posting **$7,074.25/month flat** ($84,891 total FY2025).

Per IRS MACRS Year-2 schedule for the 5 assets (placed in service 7/1/24, HY convention applied in Year 1):
- Leasehold Improvements (15yr SL): Year-2 = 6.67% × $438,100 = $29,222 (vs half-year Year-1 was $14,604)
- Restaurant Equipment (5yr 200DB): Year-2 = 32% × $170,381 NBV = ~$54,522
- Furniture & Fixtures (7yr 200DB): Year-2 = 24.49% × $1,098 NBV = ~$269
- Signage (7yr 200DB): Year-2 = 24.49% × $3,588 NBV = ~$879
- Startup Expenses (SL 180mo): Year-2 = $4,727 full year

Total FY2025 per Year-2 schedule: ~$89,619

Pretzel OS FY2025 amount $84,891 is in the ballpark but doesn't tie per-asset. Could be:
- Pretzel OS is using even monthly amortization (Year-1 + Year-2 averaged)
- Or schedule is slightly different per-asset

**Action**: Phase 33-D-pre confirmed FY2025 LEAF interest is fine. But FY2025 depreciation needs a per-asset re-derivation to tie cent-accurate to Form 4562 Year-2 carryforward. Drew + Irene to confirm Year-2 schedule is acceptable as-is or wants the per-asset breakdown.

## Status of Phase 33 — what's been done while you're away

**Completed (read-only)**:
- ✅ Phase 33-A: Schedule L Source-of-Truth Audit → `SCHEDULE_L_AUDIT_v1.csv`
- ✅ Phase 33-B: JE Reversal Dependency Map → `JE_REVERSAL_MAP_v1.csv`
- ✅ Phase 33-D-pre: LEAF amortization dry-run → expected FY2025 NI shift only -$40 (de minimis)
- ✅ Source-verified all 4 LEAF lease PDFs (origination dates + principals + rates)
- ✅ Source-verified Settlement Agreement (T&A Dec 18 2024 — $20K + $80K structure)
- ✅ Verified Mercury Credit Dec 2024 statement (Drew has these in zip files)

**Findings ready for review**:
- 9 Schedule L lines exact match to source-of-truth (filed return)
- 4 lines small variance (≤$2)
- 2 lines documented variance ($157 Cash + $167 CC) — need Drew sign-off on Q3
- All major bookkeeper post-filing inflations identified (Payroll Payable $46K phantom, LEAF $30K understated, Bridge BLOQ $123K missing, T&A $80K missing)

**Waiting on Drew (7 questions above)**:
- Q1 (CRITICAL): Bridge BLOQ Section 110 — affects Phase 33-F
- Q2 (CRITICAL): T&A $80K Mercury outflow ID — affects Phase 33-G
- Q3-Q7: documentation / nice-to-have

**Cannot proceed past Phase 33-B without Q1 and Q2 answered. Phase 33-C atomic migration is fully scoped and ready to execute once those two questions are answered.**

## What's locked + ready for execution

Once Drew answers Q1 + Q2:

| Phase | Description | Hours | Status |
|---|---|---|---|
| 33-C | Atomic OB reset migration | 3hr | ready (waiting on Q1) |
| 33-D | LEAF re-amortization | 3hr | ready — confirmed near-zero NI impact |
| 33-E | Toast Payroll verify | 1hr | ready |
| 33-F | Bridge BLOQ Section 110 + AR clearing | 2hr | **blocked on Q1** |
| 33-G | T&A loan repayment + elimination | 1hr | **blocked on Q2** |
| 33-H | Phase 31-A re-validate | 2hr | ready |
| 33-I | Equity bridge | 2hr | ready |
| 33-J | FY2025 P&L source ties | 6hr | ready |
| 33-K | Mercury GL strict-match | 3hr | depends on Q7 (Option A or B) |
| 33-L | v5 Irene package | 2hr | ready |
| 33-M | Acceptance + Tier 1 | 2hr | ready |
| 33-N | Final validation | 2hr | ready |

Total remaining: ~29 hours (5-6 sessions) after Drew unblocks.

## TL;DR

- ~119 JEs need to be reversed to clear OB-era artifacts
- 1 new clean OB JE will replace them, seeded from filed 1065 cent-accurate
- FY2025 NI will be re-derived from source data — current -$323,877 NI is built on wrong OB and will likely shift materially
- LEAF impact is minor (-$40). The bigger shifts will come from:
  - Bridge BLOQ $123K receivable correctly on YE2024 (affects 2025 AR/cash flow)
  - T&A $80K liability correctly recognized + cleared
  - Payroll Payable $46K phantom drain reversed (small P&L effect since it's BS-only)
  - Mercury Checking GL strict-match (depends on Q7)
- I need Q1 + Q2 minimum to start execution; rest are nice-to-have

Answer Q1, Q2 when ready and I'll start Phase 33-C.
