# Pretzel OS — Equity Reclass + Plug Account Narrative

**Generated**: 2026-05-20
**Purpose**: Plain-English explanation of every equity reclass and plug-account balance composing the YE2025 Balance Sheet, with JE-level decomposition. This is the document Irene should reference when asking "what is this account?"

This addresses every plug/reclass/adjustment account on the BS that isn't a standard expense, revenue, asset, or liability.

---

## Sign convention used in all tables below

> **Δ column shows signed GL posting**: positive value = DR posting to the account; negative value = CR posting to the account.
> **Column sum** = net DR posting to the account (positive sum) or net CR posting (negative sum).
> **BS presentation** at YE2025 reflects the closing balance per standard BS sign convention:
> - DR-balance equity account → presents as negative on BS
> - CR-balance liability account → presents as positive on BS
>
> Each section's Total row shows BOTH the net column sum (GL-posting space) AND the BS-presentation figure (BS space) so the cross-reference is explicit.

---

## 1. Pre-Sync Adjustments

**YE2025 GL balance**: +$19,430.33 net DR posting
**YE2025 BS presentation**: -$19,430.33 (DR-balance equity → negative on BS)
**Account type**: equity / retained_earnings subtype
**Number of posted JEs**: 4

### What it is

A holding account for one-time bookkeeper-era equity reclassifications and reconciliation adjustments that don't fit cleanly into Partner Investments, Retained Earnings, or any operational account. Each balance component represents a discrete economic event verified against bookkeeper records and Drew's confirmation.

### JE composition (every contributing JE)

| Date | JE ID | Source Type | Description | Δ (GL posting) |
|---|---|---|---|---:|
| 2024-12-31 | `24c-payroll-payable-ob-drain-2024-12-31` | fiscal_year_close | YE2024 Payroll Payable opening balance drain — bookkeeper had $46,869.65 of uncashed pre-Pretzel-OS payroll checks recorded as a liability. Per Drew, these checks were never cashed (employees voided them; Drew kept records). | -$46,869.65 |
| 2025-02-24 | `24-bridge-bloq-section-110` | fiscal_year_close | Bridge BLOQ A&Z LLC tenant improvement reimbursement, treated as IRC Section 110 — reduces Leasehold Improvements basis (CR Leasehold Improvements $123,401) with offsetting equity move (DR Pre-Sync). Non-taxable per Section 110. | +$123,400.74 |
| 2025-03-03 | `24-partner-exit-settlement-2025-03-03` | fiscal_year_close | Partner-exit settlement — net effect of a Feb-Mar 2025 round-trip with Drew's brother (loan in / loan out). The $80,000 net represents the equity unwind of that round-trip. | -$80,000.00 |
| 2025-05-28 | `be2829b0606d88aad899431a7905890f` | pre_sync_adjustment | Phase 29-D era Mercury Savings balance correction — bookkeeper-era Mercury Savings GL was $22,899.24 over actual bank statement balance; correction brought GL = statement. (This item was not documented in Phase 29 narrative; first documented here.) | +$22,899.24 |
| | | | **Net column sum (GL posting)** | **+$19,430.33** (net DR) |
| | | | **BS presentation at YE2025** | **-$19,430.33** ✓ |

### Plain English

If Irene asks "what is Pre-Sync Adjustments?":
> "It's a holding account for four bookkeeper-era equity-class events that don't fit cleanly into other accounts: (1) draining $46,870 of YE2024 voided payroll checks that the bookkeeper had recorded as a liability; (2) Section 110 reduce-leasehold-basis treatment of a $123,401 tenant improvement reimbursement from our landlord (non-taxable); (3) the $80,000 net of a partner-exit / brother-loan round-trip that closed in March 2025; and (4) a $22,899 Mercury Savings YE2024 reconciliation correction. Each is a one-time event; the account is not used for ongoing activity."

---

## 2. Pre-Pretzel-OS Reconciliation

**YE2025 GL balance**: -$14,561.14 net CR posting
**YE2025 BS presentation**: +$14,561.14 (CR-balance liability → positive on BS)
**Account type**: liability / current_liability subtype
**Number of posted JEs**: 2

### What it is

A holding account for Q4 2024 + Q2 2025 Utah sales tax filing reclasses — JEs that move sales tax remittance amounts between the per-period sales tax liability and the accumulated holding balance. Currently holds 2 sales_tax_reclass JEs.

### Sign-flip explanation (Phase 29 → Phase 31)

The auditor noted Pre-Pretzel-OS flipped from -$40,362.68 (Phase 29) to +$14,561.14 (Phase 31) — a $54,924 swing. This is the Phase 30 088a effect:

Pre-Phase-30, this account had 14 additional `qbo_expense_reconciliation` JEs (bookkeeper "true-ups to QBO P&L") that were the dominant contributor. Phase 30 088a reversed all 14 (Drew directive: QBO is NOT source of truth). What remains are the 2 legitimate sales_tax_reclass JEs that were preserved per narrowed Phase 30 scope. The $54,924 swing IS the net contribution of the 14 reversed `qbo_expense_reconciliation` JEs.

### JE composition (every contributing JE)

| Date | JE ID | Source Type | Description | Δ (GL posting) |
|---|---|---|---|---:|
| 2025-02-06 | `24b-sales-tax-reclass-2025-02-06` | sales_tax_reclass | Session 24-B reclass: Q4 2024 Utah sales tax filing (TC-62) — moves remittance amount to liability holding | -$1,453.49 |
| 2025-09-30 | `24b-sales-tax-reclass-2025-09-30` | sales_tax_reclass | Session 24-B reclass: Q2 2025 Utah sales tax filing — moves remittance amount to liability holding | -$13,107.65 |
| | | | **Net column sum (GL posting)** | **-$14,561.14** (net CR) |
| | | | **BS presentation at YE2025** | **+$14,561.14** ✓ |

### Plain English

If Irene asks "what is Pre-Pretzel-OS Reconciliation?":
> "It's a current liability holding for two Utah sales tax filing reclassifications totaling $14,561.14 — the Q4 2024 filing ($1,453) and the Q2 2025 filing ($13,108). The account name is a Phase 23 artifact from bookkeeper-era reconciliation work and is being retained as the destination for these specific reclass JEs. The 14 historical bookkeeper-era `qbo_expense_reconciliation` JEs that previously composed this account were reversed in Phase 30 (Drew directive: QBO is not source of truth)."

---

## 3. YE2024 Bank Reconciliation Adjustment

**YE2025 GL balance**: +$9,753.13 net DR posting
**YE2025 BS presentation**: -$9,753.13 (DR-balance equity → negative on BS)
**Account type**: equity / retained_earnings subtype
**Number of posted JEs**: 20

### What it is

A "contra-equity" holding account for Mercury bank account opening balance corrections and monthly reconciliation adjustments. Created in Phase 29-B to align Mercury GL to actual bank statement balances. The account holds:
- 1 Phase 29-B YE2024 OB correction (+$79,147.28 DR — sets opening Mercury balances to actual Dec 2024 statements)
- 18 Phase 29-D monthly reconciliation JEs (v2 + v3 versions — many v2/v3 pairs cancel out, see table)
- 1 Phase 31-A5 YE2025 Mercury reconciliation (-$3,910.38 CR)

### Note A — Why negative BS presentation is expected

This account is a "contra-equity" — it represents the cumulative effect of bringing GL into alignment with actual bank statements. The +$9,753.13 net DR position means: after all monthly reconciliations and the YE2025 final adjustment, GL had a small remaining CR-side bias relative to bank statements that required DR this account. Standard accountant pattern; can be reviewed and either absorbed into Retained Earnings or kept as a separate disclosure line at filing time per Irene's preference.

### JE composition (every contributing JE)

| Date | JE ID | Source Type | Description | Δ (GL posting) |
|---|---|---|---|---:|
| 2024-12-31 | `29b-ob-correction-mercury` | phase_29_ob_correction | Phase 29-B: correct Mercury OB to actual Dec 2024 bank statements | +$79,147.28 |
| 2025-01-31 | `29d-recon-v3-2025-01-31` | phase_29_recon_adj | v3 monthly recon | -$1,152.42 |
| 2025-02-28 | `29d-recon-v3-2025-02-28` | phase_29_recon_adj | v3 monthly recon | -$123,400.74 |
| 2025-03-31 | `29d-recon-v3-2025-03-31` | phase_29_recon_adj | v3 monthly recon | +$76,300.81 |
| 2025-04-30 | `29d-recon-v3-2025-04-30` | phase_29_recon_adj | v3 monthly recon | +$4,061.42 |
| 2025-05-31 | `29d-recon-2025-05-31` | phase_29_recon_adj | v2 monthly recon | -$4,811.12 |
| 2025-05-31 | `29d-recon-v3-2025-05-31` | phase_29_recon_adj | v3 monthly recon | -$18,088.12 |
| 2025-06-30 | `29d-recon-2025-06-30` | phase_29_recon_adj | v2 monthly recon | -$10,307.30 |
| 2025-06-30 | `29d-recon-v3-2025-06-30` | phase_29_recon_adj | v3 monthly recon (reverses v2) | +$10,307.30 |
| 2025-07-31 | `29d-recon-2025-07-31` | phase_29_recon_adj | v2 monthly recon | -$13,562.81 |
| 2025-07-31 | `29d-recon-v3-2025-07-31` | phase_29_recon_adj | v3 monthly recon (reverses v2) | +$13,562.81 |
| 2025-08-31 | `29d-recon-2025-08-31` | phase_29_recon_adj | v2 monthly recon | -$11,536.66 |
| 2025-08-31 | `29d-recon-v3-2025-08-31` | phase_29_recon_adj | v3 monthly recon (reverses v2) | +$11,536.66 |
| 2025-09-30 | `29d-recon-2025-09-30` | phase_29_recon_adj | v2 monthly recon | -$12,077.38 |
| 2025-09-30 | `29d-recon-v3-2025-09-30` | phase_29_recon_adj | v3 monthly recon | +$15,987.76 |
| 2025-10-31 | `29d-recon-2025-10-31` | phase_29_recon_adj | v2 monthly recon | -$9,230.41 |
| 2025-10-31 | `29d-recon-v3-2025-10-31` | phase_29_recon_adj | v3 monthly recon (near-reverses v2) | +$9,187.17 |
| 2025-11-30 | `29d-recon-v3-2025-11-30` | phase_29_recon_adj | v3 monthly recon | -$270.00 |
| 2025-12-31 | `29d-recon-v3-2025-12-31` | phase_29_recon_adj | v3 monthly recon | -$1,990.74 |
| 2025-12-31 | `31a5-mercury-ye2025-recon` | mercury_recon_adj | Phase 31-A5: Mercury YE2025 reconciliation to bank statement closing ($1,197.38) | -$3,910.38 |
| | | | **Net column sum (GL posting)** | **+$9,753.13** (net DR) |
| | | | **BS presentation at YE2025** | **-$9,753.13** ✓ |

### Reading the v2/v3 pairs

Several months show both a `29d-recon-YYYY-MM-DD` (v2) and a `29d-recon-v3-YYYY-MM-DD` (v3) JE. The v3 versions were posted to correct over-compensation in v2 (June through October 2025). Where v3 exactly reverses v2, the net effect on this account is $0 for that month and the actual reconciliation lives on Mercury Checking itself. Where v3 partially reverses v2 (e.g., September: -$12,077 v2 + $15,988 v3 = +$3,910 net), the net is the correct end-state.

### Plain English

If Irene asks "what is YE2024 Bank Reconciliation Adjustment?":
> "It's a contra-equity holding account for bookkeeper-era Mercury bank reconciliation. The bulk is a Phase 29-B opening-balance correction (+$79,147 DR) that aligned YE2024 Mercury GL to actual bank statements when we discovered Mercury Checking had been over-stated. Subsequent monthly reconciliation JEs (Phase 29-D, v2 + v3 corrections) net to about -$65,484 across the year. A final YE2025 adjustment (Phase 31-A5, -$3,910) brought GL = bank statement at year-end. The net +$9,753 DR appears as -$9,753 on the BS (DR-balance equity → negative). If you'd prefer this absorbed into Retained Earnings at filing, we can post a closing JE."

---

## Verification — All plug accounts characterized

| Account | YE2025 GL (net posting) | YE2025 BS presentation | JE count | Characterized? |
|---|---:|---:|---:|:---:|
| Pre-Sync Adjustments | +$19,430.33 (net DR) | -$19,430.33 | 4 | ✓ |
| Pre-Pretzel-OS Reconciliation | -$14,561.14 (net CR) | +$14,561.14 | 2 | ✓ |
| YE2024 Bank Reconciliation Adjustment | +$9,753.13 (net DR) | -$9,753.13 | 20 | ✓ |

All accounts with material balances on the YE2025 BS have JE-level decomposition + plain-English narrative + Irene-answer template. Every BS-presentation figure ties to BS_YE2025.csv.

---

## Cross-references

- Source-of-truth hierarchy: see README.md
- NI walk from bookkeeper baseline: see NI_BRIDGE_FY2025.csv
- BS detailed line items: see BS_YE2025.csv
- Underlying Pretzel OS plan + retrospective: `/Users/drew/.claude/plans/delightful-marinating-puzzle.md`
