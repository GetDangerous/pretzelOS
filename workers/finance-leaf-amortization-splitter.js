// workers/finance-leaf-amortization-splitter.js
// Phase 30-B (May 19 2026) — Per-loan amortization schedule for 4 LEAF leases.
// Splits each monthly Mercury LEASE SERVICES outflow into:
//   Principal portion (per amortization)
//   Interest portion (per amortization)
//   Sales tax portion (residual)
//
// Each loan solved to 9.50% APR (confirmed against contract Pmt × Term ≈ Principal × factor).
//
// Drew supplied 4 lease agreement PDFs (May 19 2026):
//   875130 (Jan 25 2024, 60 mo, $30,550 principal, $641.55 pmt) — Unknown vendor
//   890331 (Feb 5 2024, 59 mo, $26,041 principal, $554.15 pmt) — Comm Kitchen Supply Quote 5673 (addendum)
//   902878 (Mar 19 2024, 60 mo, $68,752 principal, $1,443.79 pmt) — Pizza Ovens LLC
//   906769 (Mar 28 2024, 58 mo, $29,388 principal, $633.85 pmt) — Comm Kitchen Supply Quote 4589 (addendum)
//
// Total monthly base pmt: $3,273.34
// Verified Mercury outflow: $3,472.64 (= $3,273.34 base + ~$199 sales tax across 4 ACHs)
//
// For each Mercury LEASE SERVICES outflow JE in the GL, this worker:
//   1. Matches the txn amount to one of the 4 loans (by amount + month)
//   2. Computes Principal/Interest split per amortization schedule for that period
//   3. Posts adjustment JE that RE-CATEGORIZES the existing categorizer expense JE
//      into proper Principal + Interest + Tax breakdown
//
// JE structure (per Mercury LEASE SERVICES outflow):
//   - existing categorizer posted: DR <some expense account> $payment / CR Mercury $payment
//   - this worker posts ADJUSTMENT: DR N/P LEAF <loan> $principal + DR Interest paid $interest
//                                  + DR Taxes paid $tax / CR <expense account> $payment
//   - net effect: original expense $0; new split: principal to loan, interest to interest, tax to taxes paid
//
// Alternative simpler: this worker rebuilds the Mercury LEASE SERVICES JE entirely
// from scratch. That requires reversing the categorizer-posted JE first.
//
// For Phase 30, we use the simpler approach:
//   1. Reverse all existing Mercury LEASE SERVICES JEs from mercury_txn source
//   2. Post fresh JEs from this worker with proper splits
//
// source_type='leaf_amortization_reconstruction'

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const SOURCE_TYPE = 'leaf_amortization_reconstruction';

// 4 LEAF loans — verified from contract PDFs (Phase 30-A)
// Loan → COA account mapping confirmed via existing categorizer behavior +
// monthly payment amount matching (Mar 2025 Mercury LEASE SERVICES ACHs):
//   $591.33 ACH → App 890331 (base $554.15 + tax) → N/P LEAF funding Commercial Kitchen Supply
//   $674.61 ACH → App 906769 (base $633.85 + tax) → N/P LEAF Funding Comm Kitchen - 2
//   $683.03 ACH → App 875130 (base $641.55 + tax) → N/P LEAF Funding Kemper Bakery
//   $1523.67 ACH → App 902878 (base $1,443.79 + tax) → N/P LEAF funding Pizza Ovens
const LOANS = [
  { app: '875130',
    name: 'N/P LEAF Funding Kemper Bakery',
    principal: 30550.00,
    term_months: 60,
    monthly_payment: 641.55,
    annual_rate: 0.095,  // 9.50% APR (solved from P, n, M)
    start_date: '2024-01-25',
    first_payment_date: '2024-02-25',
  },
  { app: '890331',
    name: 'N/P LEAF funding Commercial Kitchen Supply',
    principal: 26040.65,
    term_months: 59,
    monthly_payment: 554.15,
    annual_rate: 0.095,
    start_date: '2024-02-05',
    first_payment_date: '2024-03-05',
  },
  { app: '902878',
    name: 'N/P LEAF funding Pizza Ovens',
    principal: 68752.00,
    term_months: 60,
    monthly_payment: 1443.79,
    annual_rate: 0.095,
    start_date: '2024-03-19',
    first_payment_date: '2024-04-19',
  },
  { app: '906769',
    name: 'N/P LEAF Funding Comm Kitchen - 2',
    principal: 29387.90,
    term_months: 58,
    monthly_payment: 633.85,
    annual_rate: 0.095,
    start_date: '2024-03-28',
    first_payment_date: '2024-04-28',
  },
];

// Compute per-month amortization schedule for a loan
function amortizeLoan(loan) {
  const r = loan.annual_rate / 12;  // monthly rate
  const n = loan.term_months;
  const P = loan.principal;
  // M = P × r(1+r)^n / ((1+r)^n - 1)
  const factor = Math.pow(1 + r, n);
  const M = P * r * factor / (factor - 1);
  // Verify M ≈ loan.monthly_payment (within 1 cent)
  const M_rounded = Math.round(M * 100) / 100;

  const schedule = [];
  let balance = P;
  for (let i = 1; i <= n; i++) {
    const interest = balance * r;
    const principal = M - interest;
    balance -= principal;
    if (balance < 0) balance = 0;
    schedule.push({
      payment_num: i,
      principal: Math.round(principal * 100) / 100,
      interest: Math.round(interest * 100) / 100,
      balance: Math.round(balance * 100) / 100,
      payment: Math.round(M * 100) / 100,
    });
  }
  return { computed_payment: M_rounded, contract_payment: loan.monthly_payment, schedule };
}

// Get the amortization period (payment_num) for a given payment_date
// payment_num=1 means the first scheduled payment, etc.
function getPaymentNumForDate(loan, paymentDate) {
  const first = new Date(loan.first_payment_date + 'T00:00:00Z');
  const pay = new Date(paymentDate + 'T00:00:00Z');
  const monthsDiff = (pay.getUTCFullYear() - first.getUTCFullYear()) * 12 + (pay.getUTCMonth() - first.getUTCMonth());
  return monthsDiff + 1;  // 1-indexed
}

// Match a Mercury LEASE SERVICES txn amount to one of the 4 loans
// Each loan has base monthly + ~6% sales tax added. Use base × 1.10 as upper bound for matching.
function matchLoan(amount) {
  // Find the loan whose monthly base is closest to amount / 1.06 (deducting tax)
  // Or match within ±$10 of any loan's expected Mercury outflow (base + tax)
  const candidates = LOANS.map(L => {
    const expectedMercury = L.monthly_payment * 1.06;  // ~6% sales tax estimate
    return { loan: L, delta: Math.abs(amount - expectedMercury) };
  });
  candidates.sort((a, b) => a.delta - b.delta);
  if (candidates[0].delta > 20) return null;  // no close match
  return candidates[0].loan;
}

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

// Identify all Mercury LEASE SERVICES outflows in the period
async function getLeaseOutflows(env, startDate, endDate) {
  const { results } = await env.DB.prepare(`
    SELECT id, txn_date, ROUND(-amount, 2) as amount, description, counterparty_name
    FROM mercury_transactions
    WHERE amount < 0
      AND (counterparty_name LIKE 'LEASE SERVICES%' OR description LIKE '%LEASE SERVICES%')
      AND txn_date BETWEEN ? AND ?
    ORDER BY txn_date, amount
  `).bind(startDate, endDate).all();
  return results || [];
}

export async function previewLeafAmortization(env, startDate = '2025-01-01', endDate = '2026-04-30') {
  // Precompute amortization schedules
  const schedules = {};
  for (const L of LOANS) {
    schedules[L.app] = amortizeLoan(L);
  }

  // Get all Mercury LEASE outflows
  const outflows = await getLeaseOutflows(env, startDate, endDate);

  // For each outflow: match to loan + lookup amortization period
  const matched = [];
  const unmatched = [];
  for (const t of outflows) {
    const loan = matchLoan(t.amount);
    if (!loan) {
      unmatched.push(t);
      continue;
    }
    const paymentNum = getPaymentNumForDate(loan, t.txn_date);
    const sched = schedules[loan.app].schedule[paymentNum - 1];
    if (!sched) {
      unmatched.push({ ...t, reason: `payment_num=${paymentNum} out of range for ${loan.app}` });
      continue;
    }
    const principal = sched.principal;
    const interest = sched.interest;
    const base_payment = sched.payment;  // == loan.monthly_payment (within rounding)
    const sales_tax = Math.round((t.amount - base_payment) * 100) / 100;
    matched.push({
      mercury_txn_id: t.id,
      txn_date: t.txn_date,
      amount: t.amount,
      loan_app: loan.app,
      loan_name: loan.name,
      payment_num: paymentNum,
      principal,
      interest,
      sales_tax,
      base_payment,
      balance_after: sched.balance,
    });
  }

  // Aggregate totals
  const totals = matched.reduce((a, m) => ({
    txns: a.txns + 1,
    amount: a.amount + m.amount,
    principal: a.principal + m.principal,
    interest: a.interest + m.interest,
    sales_tax: a.sales_tax + m.sales_tax,
  }), { txns: 0, amount: 0, principal: 0, interest: 0, sales_tax: 0 });
  for (const k of ['amount', 'principal', 'interest', 'sales_tax']) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }

  return {
    ok: true,
    source_type: SOURCE_TYPE,
    period: { start: startDate, end: endDate },
    schedules_summary: Object.fromEntries(
      Object.entries(schedules).map(([app, s]) => [app, { computed_payment: s.computed_payment, contract_payment: LOANS.find(L => L.app === app).monthly_payment }])
    ),
    matched_count: matched.length,
    unmatched_count: unmatched.length,
    totals,
    sample_matches: matched.slice(0, 8),
    unmatched_sample: unmatched.slice(0, 5),
  };
}

// Returns the COA account name to use for a given loan
// COA account names need to be verified to match what's actually in chart_of_accounts
function loanCoaAccount(loan, accountIds) {
  // Try exact name; if not found, try variants
  if (accountIds[loan.name]) return loan.name;
  // Fallback: search account names containing 'LEAF' + loan number
  // For now, return the loan.name and let the validation step catch missing accounts
  return loan.name;
}

export async function postLeafAmortization(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'leaf_amortization' });
  const force = !!opts.force;
  const accountIds = await resolveAccountIds(env);

  // Validate all 4 loan accounts exist
  const missing = LOANS.filter(L => !accountIds[loanCoaAccount(L, accountIds)]);
  if (missing.length > 0) {
    return { ok: false, error: 'Missing loan accounts in COA', missing: missing.map(L => ({ app: L.app, name: L.name })) };
  }
  const interestAccount = accountIds['Interest paid'];
  const taxAccount = accountIds['Taxes paid'];
  const leafClearingAccount = accountIds['Clearing Accounts:LEAF Clearing'];
  if (!interestAccount || !taxAccount || !leafClearingAccount) {
    return { ok: false, error: 'Missing system accounts (Interest paid / Taxes paid / LEAF Clearing)' };
  }

  const preview = await previewLeafAmortization(env, opts.start, opts.end);
  if (preview.unmatched_count > 0) {
    return { ok: false, error: 'Unmatched LEASE SERVICES txns', unmatched: preview.unmatched_sample };
  }

  const results = [];
  for (const m of preview.sample_matches /* not the right field — fix */) {
    // Actually we want ALL matched, not just sample. Let me re-call with full list:
  }

  // Re-fetch with full data
  const outflows = await getLeaseOutflows(env, opts.start || '2025-01-01', opts.end || '2026-04-30');
  const schedules = {};
  for (const L of LOANS) schedules[L.app] = amortizeLoan(L);

  for (const t of outflows) {
    const loan = matchLoan(t.amount);
    if (!loan) { results.push({ txn: t.id, status: 'unmatched' }); continue; }
    const paymentNum = getPaymentNumForDate(loan, t.txn_date);
    const sched = schedules[loan.app].schedule[paymentNum - 1];
    if (!sched) { results.push({ txn: t.id, status: 'period_out_of_range' }); continue; }

    // Pattern B Phase 30 (May 20 2026): strict rounding so DR sum = CR amount EXACTLY.
    // Round principal + interest first, derive sales_tax as the exact remainder.
    const principal = Math.round(sched.principal * 100) / 100;
    const interest = Math.round(sched.interest * 100) / 100;
    // sales_tax = mercury_amount - principal - interest (computed last to absorb rounding)
    const sales_tax = Math.round((t.amount - principal - interest) * 100) / 100;

    const jeId = `leaf-${loan.app}-${t.id}`;
    const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE id=? AND status='posted'`).bind(jeId).first();
    if (existing && !force) { results.push({ txn: t.id, status: 'skipped_existing' }); continue; }
    if (existing && force) {
      await env.DB.prepare(`UPDATE journal_entries SET status='reversed' WHERE id=?`).bind(jeId).run();
    }

    const totalDr = Math.round((principal + interest + sales_tax) * 100) / 100;
    const totalCr = t.amount;

    // Strict balance: DR sum must equal CR exactly (within $0.01 for float artifacts)
    if (Math.abs(totalDr - totalCr) > 0.01) {
      results.push({ txn: t.id, status: 'imbalanced', dr: totalDr, cr: totalCr });
      continue;
    }

    await env.DB.prepare(
      `INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'phase_30')`
    ).bind(
      jeId, t.txn_date.slice(0, 10),
      `Phase 30 LEAF ${loan.app} payment ${paymentNum} — P/I/Tax split`,
      SOURCE_TYPE, t.id, totalDr, totalCr
    ).run();

    let lineNum = 1;
    // DR Loan principal
    await env.DB.prepare(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(`${jeId}-l${lineNum}`, jeId, lineNum, accountIds[loan.name], principal, 0, `LEAF ${loan.app} principal pmt ${paymentNum}`).run();
    lineNum++;
    // DR Interest
    await env.DB.prepare(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(`${jeId}-l${lineNum}`, jeId, lineNum, interestAccount, interest, 0, `LEAF ${loan.app} interest pmt ${paymentNum}`).run();
    lineNum++;
    // DR Sales tax
    if (sales_tax > 0.005) {
      await env.DB.prepare(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(`${jeId}-l${lineNum}`, jeId, lineNum, taxAccount, sales_tax, 0, `LEAF ${loan.app} sales tax pmt ${paymentNum}`).run();
      lineNum++;
    }
    // CR LEAF Clearing (transit account; Mercury sync's DR LEAF Clearing nets against this)
    await env.DB.prepare(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(`${jeId}-l${lineNum}`, jeId, lineNum, leafClearingAccount, 0, t.amount, `LEAF ${loan.app} drain clearing (Mercury cash already DR'd clearing)`).run();

    results.push({ txn: t.id, status: 'posted', je_id: jeId, principal, interest, sales_tax });
  }

  return { ok: true, results, source_type: SOURCE_TYPE };
}
