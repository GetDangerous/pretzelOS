# Pretzel OS Finance — Known Gaps

Last reviewed: Apr 30, 2026 (post-reset).

These are not bugs. They are real, expected divergences between what the system reports and "ideal" reality. Each has a remediation plan.

## 1. Opening balance not loaded — `mercury_live_vs_book` permanently drifts

**Symptom:** Tier 2 `mercury_live_vs_book` shows live cash $41K vs book $-83K (or whatever the running tally is). Adjusted variance ~$120K.

**Root cause:** The book has no historical Mercury balance — no opening-balance JE has been posted. So sum(Mercury debits) - sum(Mercury credits) starts from zero, while live cash reflects 1+ years of business activity.

**Why we haven't fixed it:** Drew is waiting for Irene's signoff on the opening balance corrections (Drew/Lindsay $770K loan reclassification, Todd & Amanda zero-out, Payroll Payable writeoff, etc.). See `PRETZEL_OS_FINANCE_V2.md` section 2.17.

**Remediation:** Run the OB load workflow (see RUNBOOKS.md "Opening balance commit"). After commit, the variance should drop to <$50 within hours.

**Status:** Pending Irene · indefinite timeline.

---

## 2. Expense side of P&L understated

**Symptom:** Tier 5 acceptance replay shows expense delta -23% to -86% across 2025 months.

**Root cause:** 130 Mercury txns are categorized but below the 0.90 confidence threshold for auto-posting, so they sit in the review queue. Until Drew approves (or rejects) them via the Money page, they don't hit the GL — and P&L expense is understated by their amount.

**Why we haven't fixed it:** The judgment items (Drew M Sparks $80K, Bridge BLOQ $123K, BB Billboard $108K, LEASE SERVICES $55K) genuinely require Drew's input. The mechanical ones (Amazon, Instacart, Sysco, etc.) were bulk-approved Apr 29.

**Remediation:** Walk the queue on the Money page. Bulk approve repeat counterparties. Use override dropdown when proposed account is wrong.

**Status:** Drew working through queue · partial.

---

## 3. `total_volume` metric ~40% inflated

**Symptom:** `/finance/cfo/posted-stats` shows total_volume $2.92M, but Pretzel's actual annual activity is ~$1.5-2M.

**Root cause:** Revenue-sweep posts a SECOND JE per Mercury inflow that lands in a Clearing account. Same dollar counted twice in volume rollups.

**Why we haven't fixed it:** Switching to POS-direct posting (Toast/Square webhooks → JE directly) is 2-3 days of work. Phase 4 of the reset gave us the right metric (`source_volume` = $1.75M, the honest number).

**Remediation:** Use `source_volume` for "money flowed" reporting. `total_volume` kept for backward compatibility but documented as inflated.

**Status:** Mitigated by separated metric.

---

## 4. Sep 2025 revenue -56% gap

**Symptom:** Tier 5 replay shows Sep 2025 revenue $40.6K vs QBO $91.8K — $51K short.

**Root cause:** Unexplained. Either:
- Mercury sync coverage gap (a few days of data missing)
- A QBO Deposit entity that wasn't categorized as retail revenue
- A large one-time inflow that flowed differently

**Why we haven't fixed it:** Lower priority than the other gaps. Tier 5 surfaces it; investigation is its own work.

**Remediation:** Pull Sep 2025 Mercury txns + QBO archive Deposit entities. Diff. Find the missing transaction(s).

**Status:** Open · low priority.

---

## 5. Q4 2025 Utah sales tax — not yet filed

**Symptom:** Drew filed Q1 2026 Apr 22. Q4 2025 was due Jan 31, 2026. Estimated owed: ~$10,890 (TC-62 ~$9,990 + SPF ~$900) plus ~$1,000-1,200 in penalties + interest.

**Root cause:** Pre-existing — when Drew picked up the system, Q4 was already past due.

**Why we haven't fixed it:** Drew needs to coordinate with Irene on the late filing strategy + may negotiate penalty waiver.

**Remediation:** Drew exports Toast Q4 2025 daily report → POSTs to `/finance/sales-tax/toast-upload?period=Q4-2025` → runs `/finance/sales-tax/quarter?year=2025&quarter=4` for canonical numbers → files via tap.utah.gov → records via `/finance/sales-tax/filings/Q4-2025/filed`.

**Status:** Awaiting Drew + Irene.

---

## 6. SPF -003 account has $1,408.26 unexplained balance

**Symptom:** When Drew filed Q1 2026 SPF, the tap.utah.gov account showed an existing $1,408.26 balance.

**Root cause:** Likely Q4 2025 unfiled. Could also be a prior-period adjustment.

**Why we haven't fixed it:** Need Irene to verify before paying.

**Remediation:** Drew asks Irene; resolves with Q4 2025 filing.

**Status:** Awaiting Irene.

---

## 7. LEAF loan amortization not modeled

**Symptom:** LEASE SERVICES Mercury payments (64 txns, $55K) categorized as "Interest Paid" — but they're really principal + interest combined.

**Root cause:** `loans` table is empty. The principal/interest split logic exists in `processLoanPayments` but has no loan terms to apply.

**Why we haven't fixed it:** Drew needs to seed 4 loans (Pizza Ovens, Comm Kitchen ×2, Kemper Bakery) with rate + term + monthly payment.

**Remediation:** `POST /finance/cfo/loans` × 4. Then run `POST /finance/cfo/loans/process-payments` to retroactively split the LEASE SERVICES payments.

**Status:** Awaiting Drew (has the agreements).

---

## 8. Toast POS tax rate is wrong

**Symptom:** Q1 2026 had $85.12 shortfall — Toast collected at 8.41% but Utah state rate is 8.45%.

**Root cause:** Toast tax tables haven't been updated.

**Why we haven't fixed it:** Drew action — has to log into Toast UI.

**Remediation:** Drew updates Toast: in-store rate 8.41 → 8.45%, marketplace 8.15 → 8.45%.

**Status:** Awaiting Drew.

---

## 9. Resale certificates not on file

**Symptom:** Q1 2026 had $55,705 in wholesale revenue claimed exempt — but `resale_certs` table is empty.

**Root cause:** Pretzel's wholesale customers (41 in Q1) haven't been asked for TC-721 certificates.

**Why we haven't fixed it:** Drew action.

**Remediation:** `POST /finance/resale-cert/request -d {customer_id}` per customer generates the request email template.

**Status:** Awaiting Drew · audit risk if not addressed.

---

## 10. Square 2025 historical data is near-zero

**Symptom:** Tier 5 references for 2025 Square revenue show $0.

**Root cause:** Pretzel's Square integration came online ~April 2026. Pre-April 2026, Square wasn't being used as a POS.

**Why we haven't fixed it:** Not fixable — there's no historical data.

**Status:** Documented limitation.
