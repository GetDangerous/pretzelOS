// workers/finance-toast-payroll-reconstruction.js
// Phase 30-B (May 19 2026) — Replace qbo_je_ingest payroll PPE detail with
// per-pay-period source-of-truth aggregation from toast_payroll_gl table.
//
// Drew's directive: bookkeeper transcription of Toast Payroll is NOT source of
// truth. The toast_payroll_gl raw export IS source of truth (66 check_dates,
// 2,250 rows per-employee per-account, Jan 2025–Apr 2026).
//
// One JE per check_date in toast_payroll_gl. Account mapping aggregates
// employees within a Job into a single subaccount.
//
// Toast Payroll GL account → Pretzel COA mapping:
//   REGULAR (DR) by Job → Payroll expenses:Salaries & wages:<Job>
//   OVERTIME (DR) by Job → Payroll expenses:Salaries & wages:<Job> (combined)
//   SALARY (DR) by Job → Payroll expenses:Salaries & wages:<Job> (combined)
//   Retro Pay (DR) → Payroll expenses:Salaries & wages:<Job> (combined)
//   Tips Owed (DR) → Tips Payable (DR draws down liability — clears tips paid out)
//   Gratuity Owed (DR) → Tips Payable
//   Employer FICA Tax (DR) → Payroll expenses:Payroll taxes
//   Employer Social Security Tax (DR) → Payroll expenses:Payroll taxes
//   Employer Medicare Tax (DR) → Payroll expenses:Payroll taxes
//   SUTA - UT (DR) → Payroll expenses:Payroll taxes
//   FUTA - FED (DR) → Payroll expenses:Payroll taxes
//   Direct Deposit (CR) → Mercury Checking (0118) - 1
//   Federal Income Tax (CR) → Payroll Liabilities:Payroll tax to pay
//   State Withholding - UT (CR) → Payroll Liabilities:Payroll tax to pay
//   FICA (CR) → Payroll Liabilities:Payroll tax to pay
//   Medicare (CR) → Payroll Liabilities:Payroll tax to pay
//   Social Security Tax (CR) → Payroll Liabilities:Payroll tax to pay
//   Employer payroll Taxes (CR) → Payroll Liabilities:Payroll tax to pay
//   Checks (CR) → Payroll Liabilities:Manual Checks
//   Voided Net Pay (CR) → Payroll Liabilities:Manual Checks (reversed)
//
// Note: Job-based salary mapping:
//   Back of House → Payroll expenses:Salaries & wages:Back of House
//   Front of House → Payroll expenses:Salaries & wages:Front of House
//   Management → Payroll expenses:Salaries & wages:Management
//   Shift Lead → Payroll expenses:Salaries & wages:Shift Lead
//   (other Jobs default to Front of House)
//
// Idempotent: re-running skips already-posted check_dates unless force=true.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const SOURCE_TYPE = 'toast_payroll_reconstruction';

// Toast account_name → Pretzel COA + DR/CR direction
// Returns: { account, side } where side is 'dr' or 'cr'
const ACCOUNT_MAP = {
  // DR side (employer cost or liability drawn down)
  'REGULAR':                            { coa: 'JOB_SALARY', side: 'dr' },  // uses Job
  'OVERTIME':                           { coa: 'JOB_SALARY', side: 'dr' },
  'SALARY':                             { coa: 'JOB_SALARY', side: 'dr' },
  'Retro Pay':                          { coa: 'JOB_SALARY', side: 'dr' },
  'Tips Owed':                          { coa: 'Tips Payable', side: 'dr' },
  'Gratuity Owed - Credit Card & Other':{ coa: 'Tips Payable', side: 'dr' },
  'Employer FICA Tax':                  { coa: 'Payroll expenses:Payroll taxes', side: 'dr' },
  'Employer Social Security Tax':       { coa: 'Payroll expenses:Payroll taxes', side: 'dr' },
  'Employer Medicare Tax':              { coa: 'Payroll expenses:Payroll taxes', side: 'dr' },
  'SUTA - UT':                          { coa: 'Payroll expenses:Payroll taxes', side: 'dr' },
  'FUTA - FED':                         { coa: 'Payroll expenses:Payroll taxes', side: 'dr' },
  // CR side (cash out or liability accrued)
  'Direct Deposit':                     { coa: 'Clearing Accounts:Payroll Clearing', side: 'cr' },
  'Federal Income Tax':                 { coa: 'Payroll Liabilities:Payroll tax to pay', side: 'cr' },
  'State Withholding - UT':             { coa: 'Payroll Liabilities:Payroll tax to pay', side: 'cr' },
  'FICA':                               { coa: 'Payroll Liabilities:Payroll tax to pay', side: 'cr' },
  'Medicare':                           { coa: 'Payroll Liabilities:Payroll tax to pay', side: 'cr' },
  'Social Security Tax':                { coa: 'Payroll Liabilities:Payroll tax to pay', side: 'cr' },
  'Employer payroll Taxes':             { coa: 'Payroll Liabilities:Payroll tax to pay', side: 'cr' },
  'Checks':                             { coa: 'Payroll Liabilities:Manual Checks', side: 'cr' },
  'Voided Net Pay':                     { coa: 'Payroll Liabilities:Manual Checks', side: 'cr' },
};

const JOB_TO_SALARY_ACCOUNT = {
  'Back of House':  'Payroll expenses:Salaries & wages:Back of House',
  'Front of House': 'Payroll expenses:Salaries & wages:Front of House',
  'Management':     'Payroll expenses:Salaries & wages:Management',
  'Shift Lead':     'Payroll expenses:Salaries & wages:Shift Lead',
};
const JOB_DEFAULT = 'Payroll expenses:Salaries & wages:Front of House';

function jobSalaryAccount(job) {
  return JOB_TO_SALARY_ACCOUNT[job] || JOB_DEFAULT;
}

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

// Build per-check_date aggregation for all Toast Payroll GL rows in date range
export async function buildToastPayrollPlan(env, startDate, endDate) {
  const { results: rows } = await env.DB.prepare(`
    SELECT check_date, job, account_name, debit, credit
    FROM toast_payroll_gl
    WHERE check_date >= ? AND check_date <= ?
    ORDER BY check_date
  `).bind(startDate, endDate).all();

  // Group by check_date → account_target → {debit, credit}
  const byCheckDate = {};
  const skipped = [];
  for (const r of (rows || [])) {
    const cd = r.check_date;
    if (!byCheckDate[cd]) byCheckDate[cd] = {};
    const m = ACCOUNT_MAP[r.account_name];
    if (!m) {
      // Unknown account — skip with warning
      skipped.push({ check_date: cd, account_name: r.account_name, debit: r.debit, credit: r.credit });
      continue;
    }
    const acct = m.coa === 'JOB_SALARY' ? jobSalaryAccount(r.job) : m.coa;
    if (!byCheckDate[cd][acct]) byCheckDate[cd][acct] = { debit: 0, credit: 0 };
    if (m.side === 'dr') byCheckDate[cd][acct].debit += (r.debit || 0);
    else byCheckDate[cd][acct].credit += (r.credit || 0);
  }

  // Build per-period plan
  const plan = [];
  for (const cd of Object.keys(byCheckDate).sort()) {
    const lines = [];
    let lineNum = 1;
    for (const acct of Object.keys(byCheckDate[cd]).sort()) {
      const { debit, credit } = byCheckDate[cd][acct];
      lines.push({
        line_number: lineNum++,
        account: acct,
        debit: Math.round(debit * 100) / 100,
        credit: Math.round(credit * 100) / 100,
        memo: `Toast Payroll ${cd}`,
      });
    }
    const totalDr = lines.reduce((s, l) => s + l.debit, 0);
    const totalCr = lines.reduce((s, l) => s + l.credit, 0);
    plan.push({
      check_date: cd,
      lines,
      total_debit: Math.round(totalDr * 100) / 100,
      total_credit: Math.round(totalCr * 100) / 100,
      balanced: Math.abs(totalDr - totalCr) < 0.01,
    });
  }
  return { plan, skipped };
}

// Scope: Jan 2025 – Dec 2025 (matching qbo_je_ingest bookkeeper coverage).
// Post-bookkeeper Q1 2026 Toast Payroll stays on mercury_txn (real source).
// Apr 14 2026+ Square Payroll covered by finance-square-payroll-reconstruction.
export async function previewToastPayrollReconstruction(env) {
  // Phase 32-C1 (May 20 2026): extended default scope to 2026-04-30 to cover the Toast Payroll
  // era (Toast Payroll → Square Payroll cutover ~Apr 14 2026). FY2026 portion drains the
  // Payroll Clearing FY2026 cash legs ($82K of mercury_txn TOAST PAYROLL outflows) that were
  // previously sitting on YE2025 BS without matching accrual.
  const { plan, skipped } = await buildToastPayrollPlan(env, '2025-01-01', '2026-04-30');
  const totalDR = plan.reduce((s, p) => s + p.total_debit, 0);
  const balanced = plan.every(p => p.balanced);
  return {
    ok: true,
    source_type: SOURCE_TYPE,
    check_dates: plan.length,
    total_debit: Math.round(totalDR * 100) / 100,
    all_balanced: balanced,
    unbalanced_count: plan.filter(p => !p.balanced).length,
    skipped_unknown_accounts: skipped.length,
    skipped_sample: skipped.slice(0, 5),
    plan_sample: plan.slice(0, 3),
  };
}

export async function postToastPayrollReconstruction(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'toast_payroll_reconstruction' });
  const force = !!opts.force;
  const { plan, skipped } = await buildToastPayrollPlan(env, opts.start || '2025-01-01', opts.end || '2026-04-30');  // Phase 32-C1: extended to include FY2026 Q1 Toast Payroll era
  const accountIds = await resolveAccountIds(env);

  // Validate all accounts exist
  const missingAccounts = new Set();
  for (const p of plan) {
    for (const l of p.lines) {
      if (!accountIds[l.account]) missingAccounts.add(l.account);
    }
  }
  if (missingAccounts.size > 0) {
    return { ok: false, error: 'Missing accounts in COA', missing: [...missingAccounts] };
  }

  // Validate all balanced
  const unbalanced = plan.filter(p => !p.balanced);
  if (unbalanced.length > 0) {
    return { ok: false, error: 'Unbalanced check_dates', unbalanced: unbalanced.map(u => ({ cd: u.check_date, dr: u.total_debit, cr: u.total_credit })) };
  }

  const results = [];
  for (const p of plan) {
    const jeId = `toast-payroll-${p.check_date}`;
    const existing = await env.DB.prepare(
      `SELECT id, status FROM journal_entries WHERE id=?`
    ).bind(jeId).first();
    if (existing && existing.status === 'posted' && !force) {
      results.push({ check_date: p.check_date, status: 'skipped_existing', je_id: existing.id });
      continue;
    }
    if (existing && force) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Reversed by force-rebuild' WHERE id=?`
      ).bind(jeId).run();
    }
    await env.DB.prepare(
      `INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'phase_30')`
    ).bind(
      jeId, p.check_date,
      `Phase 30 Toast Payroll PPE reconstruction (from toast_payroll_gl) ${p.check_date}`,
      SOURCE_TYPE, p.check_date, p.total_debit, p.total_credit
    ).run();
    for (const l of p.lines) {
      const lineId = `${jeId}-l${l.line_number}`;
      await env.DB.prepare(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(lineId, jeId, l.line_number, accountIds[l.account], l.debit, l.credit, l.memo).run();
    }
    results.push({ check_date: p.check_date, status: 'posted', je_id: jeId, total: p.total_debit });
  }
  return { ok: true, results, source_type: SOURCE_TYPE, skipped_unknown: skipped.length };
}
