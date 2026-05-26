// workers/finance-square-payroll-reconstruction.js
// Phase 30-B (May 19 2026) — Square Payroll aggregate reconstruction from
// Company Totals xlsx export (Drew supplied Jan 1 – May 19 2026 single file).
//
// Square Payroll started April 14, 2026 (Toast → Square cutover). Drew's xlsx
// covers Jan 1 – May 19 2026 as ONE aggregate (per-pay-period detail not in xlsx).
// Since Square only started Apr 14, the entire $24K of earnings happened in
// Apr-May 2026 (~5 weeks).
//
// Hardcoded data (parsed from /Users/drew/Downloads/Company-Totals-2026-01-01-2026-05-19-.xlsx):
//   Total Earnings (Regular wages):   $22,890.79
//   Total Earnings (Overtime wages):  $4,653.82
//   Total Earnings (Paycheck tips):   $1,409.36
//   Total Earnings (Pay):             $28,953.97
//   Employee Taxes Withheld:          $5,420.34
//     - EE Fed Income:   $1,992.00
//     - EE Soc Security: $1,795.20
//     - EE Medicare:       $419.82
//     - UT State Income: $1,213.32
//   Employer Taxes:                   $3,170.53
//     - ER Fed Unemployment: $173.74
//     - ER Soc Security:   $1,795.20
//     - ER Medicare:         $419.82
//     - UT State Unemploy:   $781.77
//   Total Hours: 1,463.77 regular + overtime
//
// We post ONE aggregate JE dated 2026-04-30 (Square covers Apr 14 onward; we
// recognize the full Apr-May aggregate at month-end Apr 2026 for simplicity).
// Future months would have separate Square Payroll Company Totals exports.
//
// JE structure:
//   DR Payroll Expenses:Salaries & wages:Front of House  $22,890.79 (Regular)
//   DR Payroll Expenses:Salaries & wages:Front of House  $4,653.82  (Overtime)
//   DR Payroll Expenses:Payroll taxes                    $3,170.53  (Employer)
//   DR Tips Payable                                       $1,409.36  (Tips drawdown)
//   CR Mercury Checking                                  $X (Net cash out)
//   CR Payroll Liabilities:Payroll tax to pay            $X (Employee + Employer tax to remit)
//
// Net cash out = Total Pay $28,953.97 - Employee tax withheld $5,420.34 = $23,533.63
// Tax to remit = Employee withheld $5,420.34 + Employer tax $3,170.53 = $8,590.87
//
// Balance check:
//   DR: 22890.79 + 4653.82 + 3170.53 + 1409.36 = $32,124.50
//   CR: 23533.63 + 8590.87 = $32,124.50 ✓

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const SOURCE_TYPE = 'square_payroll_reconstruction';
const SQUARE_PAYROLL_DATA = {
  period_label: '2026-Apr-May',
  je_date: '2026-04-30',  // month-end Apr 2026
  earnings: {
    regular_wages: 22890.79,
    overtime_wages: 4653.82,
    paycheck_tips: 1409.36,
    total_pay: 28953.97,
  },
  ee_tax_withheld: {
    ee_fed_income: 1992.00,
    ee_soc_security: 1795.20,
    ee_medicare: 419.82,
    ut_state_income: 1213.32,
    total: 5420.34,
  },
  er_tax_expense: {
    er_fed_unemp: 173.74,
    er_soc_security: 1795.20,
    er_medicare: 419.82,
    ut_state_unemp: 781.77,
    total: 3170.53,
  },
  hours: { regular: 1282.15, overtime: 181.62, total: 1463.77 },
};

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

export async function previewSquarePayrollReconstruction(env) {
  const d = SQUARE_PAYROLL_DATA;
  const net_cash_out = d.earnings.total_pay - d.ee_tax_withheld.total;
  const tax_to_remit = d.ee_tax_withheld.total + d.er_tax_expense.total;
  // Note: paycheck_tips $1,409 is included in total_pay; we DR Tips Payable
  // to drain accrued tips owed to employees (since this JE pays them out)
  const lines = [
    { account: 'Payroll expenses:Salaries & wages:Front of House', debit: d.earnings.regular_wages, credit: 0, memo: 'Square Payroll Regular wages Apr-May 2026' },
    { account: 'Payroll expenses:Salaries & wages:Front of House', debit: d.earnings.overtime_wages, credit: 0, memo: 'Square Payroll Overtime wages Apr-May 2026' },
    { account: 'Payroll expenses:Payroll taxes', debit: d.er_tax_expense.total, credit: 0, memo: 'Square Payroll Employer taxes (FICA/SS/Medicare/SUTA/FUTA)' },
    { account: 'Tips Payable', debit: d.earnings.paycheck_tips, credit: 0, memo: 'Square Payroll Paycheck Tips drawdown' },
    { account: 'Mercury Checking (0118) - 1', debit: 0, credit: net_cash_out, memo: 'Square Payroll net cash to employees + Square fees' },
    { account: 'Payroll Liabilities:Payroll tax to pay', debit: 0, credit: tax_to_remit, memo: 'Square Payroll EE + ER taxes to remit' },
  ];
  const totalDr = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCr = lines.reduce((s, l) => s + (l.credit || 0), 0);
  return {
    ok: true,
    source_type: SOURCE_TYPE,
    period: d.period_label,
    je_date: d.je_date,
    total_debit: Math.round(totalDr * 100) / 100,
    total_credit: Math.round(totalCr * 100) / 100,
    balanced: Math.abs(totalDr - totalCr) < 0.01,
    lines,
    data: d,
  };
}

export async function postSquarePayrollReconstruction(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'square_payroll_reconstruction' });
  const force = !!opts.force;
  const preview = await previewSquarePayrollReconstruction(env);
  if (!preview.balanced) return { ok: false, error: 'unbalanced', preview };
  const accountIds = await resolveAccountIds(env);
  for (const l of preview.lines) {
    if (!accountIds[l.account]) return { ok: false, error: `Missing account: ${l.account}` };
  }
  const jeId = `square-payroll-${preview.period}`;
  const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE id=? AND status='posted'`).bind(jeId).first();
  if (existing && !force) return { ok: true, status: 'skipped_existing', je_id: existing.id };
  if (existing && force) {
    await env.DB.prepare(`UPDATE journal_entries SET status='reversed' WHERE id=?`).bind(jeId).run();
  }
  await env.DB.prepare(
    `INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'phase_30')`
  ).bind(jeId, preview.je_date, `Phase 30 Square Payroll aggregate Apr-May 2026 (from Company Totals xlsx)`, SOURCE_TYPE, preview.period, preview.total_debit, preview.total_credit).run();
  let lineNum = 1;
  for (const l of preview.lines) {
    await env.DB.prepare(
      `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(`${jeId}-l${lineNum}`, jeId, lineNum, accountIds[l.account], l.debit || 0, l.credit || 0, l.memo).run();
    lineNum++;
  }
  return { ok: true, status: 'posted', je_id: jeId, total: preview.total_debit };
}
