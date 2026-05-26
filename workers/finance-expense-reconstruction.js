// workers/finance-expense-reconstruction.js
// Session 21-validate (May 15 2026) — Reconcile bookkeeper-era expense GL
// to QBO P&L truth.
//
// Strategy: per-month adjustment JE that does NOT touch existing categorizer
// JEs (preserving Mercury reconciliation). For each QBO P&L expense line:
//   delta = qbo_truth_amount - current_gl_net
//   if delta > 0: DR account at delta
//   if delta < 0: CR account at -delta
// Offset net to "Pre-Pretzel-OS Reconciliation" liability (Chase / vendor bills
// the bookkeeper recorded that we don't yet have raw data for).
//
// Idempotent via source_type='qbo_expense_reconciliation', source_id=period.
// Audit-of-record: QBO P&L API (cash basis, bookkeeper authoritative).

import { isReadOnly, readOnlySkip } from './finance-shared.js';

// QBO P&L account_path → COA account_name. All from migration 061 + base COA.
const EXPENSE_PATH_TO_COA = {
  // COGS
  'Cost of Goods Sold > Cost of goods sold > Beer Purchases':            'Cost of goods sold:Beer Purchases',
  'Cost of Goods Sold > Cost of goods sold > Food Purchases':            'Cost of goods sold:Food Purchases',
  'Cost of Goods Sold > Cost of goods sold > Liquor Purchases':          'Cost of goods sold:Liquor Purchases',
  'Cost of Goods Sold > Cost of goods sold > N/A Beverage Purchases':    'Cost of goods sold:N/A Beverage Purchases',
  'Cost of Goods Sold > Cost of goods sold > Paper Packaging Products':  'Cost of goods sold:Paper Packaging Products',
  // Expenses
  'Expenses > Advertising & marketing':            'Advertising & marketing',
  'Expenses > Bank fees & service charges':        'Bank fees & service charges',
  'Expenses > Business licenses & Permits':        'Business licenses & Permits',
  'Expenses > Cleaning Expense':                   'Cleaning Expense',
  'Expenses > Contract labor':                     'Contract labor',
  'Expenses > Delivery Fees > Amendments / Adjustments':            'Delivery Fees:Amendments / Adjustments',
  'Expenses > Delivery Fees > Commission':                          'Delivery Fees:Commission',
  'Expenses > Delivery Fees > Delivery Commission':                 'Delivery Fees:Delivery Commission',
  'Expenses > Delivery Fees > Marketing Spend / Targeted Promotions':'Delivery Fees:Marketing Spend / Targeted Promotions',
  'Expenses > Delivery Fees > Merchant / Processing Fees':          'Delivery Fees:Merchant / Processing Fees',
  'Expenses > Delivery Fees > Refunds & Discounts':                 'Delivery Fees:Refunds & Discounts',
  'Expenses > Delivery Fees > TDS Toast & Uber Fees':               'Delivery Fees:TDS Toast & Uber Fees',
  'Expenses > Insurance':                          'Insurance',
  'Expenses > Insurance > Business insurance':     'Insurance:Business insurance',
  'Expenses > Insurance > LEAF Insurance':         'Insurance:LEAF Insurance',
  'Expenses > Interest paid':                      'Interest paid',
  'Expenses > Laundry Expense':                    'Laundry Expense',
  'Expenses > Lease Expense':                      'Lease Expense',
  'Expenses > Legal & accounting services > Accounting fees':       'Legal & accounting services:Accounting fees',
  'Expenses > Legal & accounting services > Legal fees':            'Legal & accounting services:Legal fees',
  'Expenses > Meals':                              'Meals',
  'Expenses > Memberships & subscriptions':        'Memberships & subscriptions',
  'Expenses > Merchant account fees':              'Merchant account fees',
  'Expenses > Office expenses':                    'Office expenses',
  'Expenses > Payroll expenses':                                    'Payroll expenses',
  'Expenses > Payroll expenses > Payroll Fees':                     'Payroll expenses:Payroll Fees',
  'Expenses > Payroll expenses > Payroll taxes':                    'Payroll expenses:Payroll taxes',
  'Expenses > Payroll expenses > Salaries & wages > Back of House': 'Payroll expenses:Salaries & wages:Back of House',
  'Expenses > Payroll expenses > Salaries & wages > Front of House':'Payroll expenses:Salaries & wages:Front of House',
  'Expenses > Payroll expenses > Salaries & wages > Management':    'Payroll expenses:Salaries & wages:Management',
  'Expenses > Payroll expenses > Salaries & wages > Shift Lead':    'Payroll expenses:Salaries & wages:Shift Lead',
  'Expenses > QuickBooks Payments Fees':           'Merchant account fees',  // map to merchant account fees
  'Expenses > R&D':                                'R&D',
  'Expenses > Recruiting Expenses':                'Recruiting Expenses',
  'Expenses > Rent':                               'Rent',
  'Expenses > Repairs & maintenance':              'Repairs & maintenance',
  'Expenses > Restaurant Supplies & Equipment':    'Restaurant Supplies & Equipment',
  'Expenses > Shipping & postage':                 'Shipping & postage',
  'Expenses > Software & apps':                    'Software & apps',
  'Expenses > Storage':                            'Storage',
  'Expenses > Supplies':                           'Supplies',
  'Expenses > Taxes paid':                         'Taxes paid',
  'Expenses > Utilities > Internet & TV services': 'Utilities:Internet & TV services',
  'Expenses > Utilities > Phone service':          'Utilities:Phone service',
  // Other Expenses
  'Other Expenses > Ask My Accountant':            'Ask My Accountant',
  'Other Expenses > Cash Over/Short':              'Cash Over/Short',
  'Other Expenses > Penalties & Fees':             'Penalties & Fees',
  'Other Expenses > Sales Tax Over/Under':         'Sales Tax Over/Under',
  'Other Expenses > Vehicle expenses > Parking & tolls':     'Vehicle expenses:Parking & tolls',
  'Other Expenses > Vehicle expenses > Vehicle gas & fuel':  'Vehicle expenses:Vehicle gas & fuel',
};

// QBO Other Income paths (positive income, not expense — handle separately)
const OTHER_INCOME_PATH_TO_COA = {
  'Other Income > Credit card rewards': 'Credit card rewards',
  'Other Income > Interest earned':     'Interest earned',
  'Other Income > Tips Income':         'Tips Income',
};

const OFFSET_ACCOUNT_NAME = 'Pre-Pretzel-OS Reconciliation';
const SOURCE_TYPE = 'qbo_expense_reconciliation';

// Resolve account name → id (cached per call)
async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts`
  ).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

// Build the planned adjustment per period
async function buildAdjustmentPlan(env, period, accountIds) {
  const start = `${period}-01`;
  const [y, m] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${period}-${String(lastDay).padStart(2, '0')}`;

  // 1. Pull QBO truth per account_path
  const { results: qboRows } = await env.DB.prepare(`
    SELECT account_path, amount
    FROM qbo_pnl_truth
    WHERE period = ?
      AND is_subtotal = 0
      AND section IN ('COGS','Expenses','Other Expenses','Other Income')
  `).bind(period).all();

  // Map: coa_account_name -> qbo_truth_total (sum if multiple paths point to same COA)
  const qboTruth = {};
  const unmapped = [];
  for (const row of (qboRows || [])) {
    const mapping = EXPENSE_PATH_TO_COA[row.account_path] || OTHER_INCOME_PATH_TO_COA[row.account_path];
    if (!mapping) {
      unmapped.push({ path: row.account_path, amount: row.amount });
      continue;
    }
    qboTruth[mapping] = (qboTruth[mapping] || 0) + row.amount;
  }

  if (unmapped.length > 0) {
    return { ok: false, error: 'unmapped_qbo_paths', unmapped };
  }

  // 2. Pull current GL net per account for the period (expense + other_income for cards-rewards/tips/interest)
  // Excludes:
  //   - prior reconciliation JEs (idempotency)
  //   - fiscal_year_close JEs (close P&L into RE — not real activity)
  //   - depreciation source_types (intentional post-bookkeeper adjustments per Drew's
  //     tax-strategy decision; not part of QBO bookkeeper P&L truth we're matching against)
  //   - cash_drawer_reclass (Contract labor for non-W2 worker; intentional adjustment)
  //   - sales_tax_reclass (UTAH801 reclass to liability; intentional fix)
  // (Phase 23-Sales-B foundational fix: mirror exclusion list used by verifyExpenseReconciliation.)
  const { results: glRows } = await env.DB.prepare(`
    SELECT c.account_name, c.account_type, ROUND(SUM(l.debit - l.credit), 2) as gl_net
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_entry_id = j.id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.source_type != ?
      AND j.source_type NOT IN (
        'fiscal_year_close',
        'monthly_depreciation',
        'sec179_depreciation',
        'depreciation_backfill',
        'cash_drawer_reclass',
        'sales_tax_reclass'
      )
      AND j.entry_date BETWEEN ? AND ?
      AND c.account_type IN ('expense','cogs','other_expense','other_income','income')
    GROUP BY c.id
  `).bind(SOURCE_TYPE, start, end).all();

  const glCurrent = {};
  for (const r of glRows || []) {
    glCurrent[r.account_name] = { net: r.gl_net || 0, type: r.account_type };
  }

  // 3. Compute deltas (QBO truth - current GL) for EVERY current expense/income account
  //    that's either in QBO truth OR has a non-zero GL balance. Parent accounts without
  //    QBO entries (categorizer posted to "Insurance" parent when QBO uses sub-accounts)
  //    must be zeroed out too.
  const adjustmentLines = [];
  const allAccounts = new Set([
    ...Object.keys(qboTruth),
    ...Object.keys(glCurrent).filter(name => {
      const type = glCurrent[name].type;
      return type === 'expense' || type === 'cogs' || type === 'other_expense'
          || type === 'other_income' || type === 'income';
    }),
  ]);

  for (const accountName of allAccounts) {
    const qboAmount = qboTruth[accountName] || 0;
    const current = glCurrent[accountName]?.net || 0;
    const accountType = glCurrent[accountName]?.type;

    // Normalize GL sign to match QBO sign convention (positive = income earned OR expense incurred)
    let currentNormalized;
    if (accountType === 'income' || accountType === 'other_income' || accountType === 'revenue') {
      currentNormalized = -current;  // income: credit-heavy → negative GL net → flip to positive
    } else {
      currentNormalized = current;  // expense: debit-heavy → positive GL net → same sign
    }

    const delta = qboAmount - currentNormalized;
    if (Math.abs(delta) < 0.01) continue;  // already in sync

    // Income accounts (other_income/income/revenue): positive delta = need more CR
    // Expense accounts: positive delta = need more DR
    const isIncomeSide = accountType === 'income' || accountType === 'other_income' || accountType === 'revenue'
      || accountName === 'Credit card rewards' || accountName === 'Interest earned' || accountName === 'Tips Income';
    adjustmentLines.push({ account_name: accountName, delta, is_income: isIncomeSide });
  }

  // 4. Net offset = sum of all expense deltas (positive = need more expense recorded = CR offset)
  //                 minus sum of income deltas (positive = need more income recorded = DR offset)
  let offsetCredit = 0; // amount we need to CR the offset account
  let offsetDebit = 0;
  let totalDebits = 0;
  let totalCredits = 0;
  const lines = [];

  for (const adj of adjustmentLines) {
    if (adj.is_income) {
      // Income: positive delta = more CR to income, balance via DR to offset
      if (adj.delta > 0) {
        lines.push({ account: adj.account_name, debit: 0, credit: adj.delta });
        totalCredits += adj.delta;
        offsetDebit += adj.delta;
      } else {
        lines.push({ account: adj.account_name, debit: -adj.delta, credit: 0 });
        totalDebits += -adj.delta;
        offsetCredit += -adj.delta;
      }
    } else {
      // Expense: positive delta = more DR to expense, balance via CR to offset
      if (adj.delta > 0) {
        lines.push({ account: adj.account_name, debit: adj.delta, credit: 0 });
        totalDebits += adj.delta;
        offsetCredit += adj.delta;
      } else {
        lines.push({ account: adj.account_name, debit: 0, credit: -adj.delta });
        totalCredits += -adj.delta;
        offsetDebit += -adj.delta;
      }
    }
  }

  // Net offset
  const netOffsetCredit = offsetCredit - offsetDebit;
  if (Math.abs(netOffsetCredit) > 0.001) {
    if (netOffsetCredit > 0) {
      lines.push({ account: OFFSET_ACCOUNT_NAME, debit: 0, credit: netOffsetCredit });
      totalCredits += netOffsetCredit;
    } else {
      lines.push({ account: OFFSET_ACCOUNT_NAME, debit: -netOffsetCredit, credit: 0 });
      totalDebits += -netOffsetCredit;
    }
  }

  // Round to 2dp + reconcile any floating-point residual on the offset line
  const rounded = lines.map(l => ({
    account: l.account,
    debit: Math.round(l.debit * 100) / 100,
    credit: Math.round(l.credit * 100) / 100,
  }));
  const sumDebits = rounded.reduce((a, l) => a + l.debit, 0);
  const sumCredits = rounded.reduce((a, l) => a + l.credit, 0);
  const drift = Math.round((sumDebits - sumCredits) * 100) / 100;
  if (Math.abs(drift) > 0 && rounded.length > 0) {
    // Adjust offset line by drift
    const offsetIdx = rounded.findIndex(l => l.account === OFFSET_ACCOUNT_NAME);
    if (offsetIdx >= 0) {
      if (drift > 0) {
        rounded[offsetIdx].credit = Math.round((rounded[offsetIdx].credit + drift) * 100) / 100;
      } else {
        rounded[offsetIdx].debit = Math.round((rounded[offsetIdx].debit + (-drift)) * 100) / 100;
      }
    }
  }

  return {
    ok: true,
    period,
    entry_date: end,
    lines: rounded,
    totals: {
      debit: rounded.reduce((a, l) => a + l.debit, 0),
      credit: rounded.reduce((a, l) => a + l.credit, 0),
    },
    unmapped: [],
  };
}

// Preview without posting
export async function previewExpenseReconciliation(env, startPeriod, endPeriod) {
  const accountIds = await resolveAccountIds(env);
  const periods = enumeratePeriods(startPeriod, endPeriod);
  const plans = [];
  for (const p of periods) plans.push(await buildAdjustmentPlan(env, p, accountIds));
  return { ok: true, count: plans.length, plans };
}

// Post all reconciliation JEs for a date range. Idempotent.
export async function postExpenseReconciliation(env, startPeriod, endPeriod, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'expense_reconciliation' });

  const accountIds = await resolveAccountIds(env);
  const offsetId = accountIds[OFFSET_ACCOUNT_NAME];
  if (!offsetId) {
    return { ok: false, error: `offset account "${OFFSET_ACCOUNT_NAME}" not found in COA` };
  }

  const periods = enumeratePeriods(startPeriod, endPeriod);
  const posted = [];
  const skipped = [];
  const errors = [];

  for (const period of periods) {
    // Idempotent check — find ALL existing posted recon JEs for this period
    const { results: existingRows } = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? AND status = 'posted'`
    ).bind(SOURCE_TYPE, period).all();
    if ((existingRows || []).length > 0 && !opts.force) {
      skipped.push({ period, reason: 'already_reconciled', existing_count: existingRows.length });
      continue;
    }
    if ((existingRows || []).length > 0 && opts.force) {
      // Reverse EVERY existing posted recon JE for this period (not just first)
      for (const row of existingRows) {
        await env.DB.prepare(
          `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
        ).bind(row.id).run();
      }
    }

    const plan = await buildAdjustmentPlan(env, period, accountIds);
    if (!plan.ok) {
      errors.push({ period, ...plan });
      continue;
    }
    if (plan.lines.length === 0) {
      skipped.push({ period, reason: 'already_in_sync' });
      continue;
    }

    // Validate every line maps to a COA id
    const missing = plan.lines.filter(l => !accountIds[l.account]);
    if (missing.length > 0) {
      errors.push({ period, reason: 'coa_account_missing', missing });
      continue;
    }

    // Sanity: debits = credits
    if (Math.abs(plan.totals.debit - plan.totals.credit) > 0.01) {
      errors.push({ period, reason: 'unbalanced', totals: plan.totals });
      continue;
    }

    const entryId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21_validate', ?)
    `).bind(
      entryId, plan.entry_date,
      `QBO P&L expense reconciliation ${period} — true-up to bookkeeper truth`,
      SOURCE_TYPE, period, plan.totals.debit, plan.totals.credit,
      `Adjustment to match QBO bookkeeper P&L truth. Offset to Pre-Pretzel-OS Reconciliation. Includes Chase CC + QBO Bills not yet ingested.`
    ).run();

    let lineNum = 1;
    for (const line of plan.lines) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), entryId, lineNum++, accountIds[line.account],
        line.debit, line.credit,
        `${line.account} true-up to QBO ${period}`
      ).run();
    }

    posted.push({
      period, entry_id: entryId, lines: plan.lines.length,
      total: plan.totals.debit,
    });
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'expense_reconciliation_post', 'journal_entries', ?, 'session_21_validate', ?, ?)
  `).bind(
    crypto.randomUUID(), `expense_recon_${Date.now()}`,
    `Reconciled ${posted.length} months expense to QBO truth`,
    JSON.stringify({ posted: posted.length, skipped: skipped.length, errors: errors.length })
  ).run().catch(() => {});

  return { ok: true, posted, skipped, errors };
}

// Verify GL matches QBO truth post-reconciliation.
//
// Excludes JE source_types that represent INTENTIONAL ADJUSTMENTS beyond QBO
// bookkeeper-era P&L truth:
//   - fiscal_year_close: zeros P&L into Retained Earnings (accounting close)
//   - monthly_depreciation, sec179_depreciation, depreciation_backfill: depreciation
//     per 2024 Form 4562 tax-return schedule (bookkeeper QBO did not post any).
//     Drew elected to recognize these in 2025 P&L to maximize losses.
//   - cash_drawer_reclass: cash payments to non-W2 worker reclassified from
//     Cash Clearing to Contract labor (real expense bookkeeper missed).
//
// This endpoint verifies the bookkeeper-era foundation (Mercury txns + QBO archive
// + expense reconciliation) still matches QBO P&L truth. It is NOT meant to flag
// our deliberate post-bookkeeper-era adjustments.
// (Phase 22 foundational refinement — May 15 2026)
export async function verifyExpenseReconciliation(env) {
  const { results: glRows } = await env.DB.prepare(`
    SELECT strftime('%Y-%m', j.entry_date) as period,
           ROUND(SUM(CASE WHEN c.account_type IN ('expense','cogs','other_expense') THEN (l.debit - l.credit) ELSE 0 END), 2) as gl_expense,
           ROUND(SUM(CASE WHEN c.account_type IN ('other_income','income','revenue') AND l.credit > 0 THEN l.credit - l.debit ELSE 0 END), 2) as gl_other_income
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status='posted'
      AND j.source_type NOT IN (
        'fiscal_year_close',
        'monthly_depreciation',
        'sec179_depreciation',
        'depreciation_backfill',
        'cash_drawer_reclass',
        'sales_tax_reclass'
      )
      AND j.entry_date BETWEEN '2025-01-01' AND '2026-02-28'
    GROUP BY period
  `).all();

  const { results: qboRows } = await env.DB.prepare(`
    SELECT period,
           ROUND(SUM(CASE WHEN section IN ('COGS','Expenses','Other Expenses') AND is_subtotal=0 THEN amount ELSE 0 END), 2) as qbo_expense
    FROM qbo_pnl_truth
    GROUP BY period
  `).all();

  const glMap = {};
  for (const r of glRows || []) glMap[r.period] = r;
  const qboMap = {};
  for (const r of qboRows || []) qboMap[r.period] = r;

  const allPeriods = new Set([...Object.keys(glMap), ...Object.keys(qboMap)]);
  const summary = [];
  for (const p of Array.from(allPeriods).sort()) {
    const gl_e = glMap[p]?.gl_expense || 0;
    const qbo_e = qboMap[p]?.qbo_expense || 0;
    const delta = Math.round((gl_e - qbo_e) * 100) / 100;
    summary.push({
      period: p,
      gl_expense: gl_e,
      qbo_expense: qbo_e,
      delta,
      match: Math.abs(delta) < 0.01,
    });
  }
  return { ok: true, summary };
}

function enumeratePeriods(startPeriod, endPeriod) {
  const periods = [];
  let [sy, sm] = startPeriod.split('-').map(Number);
  let [ey, em] = endPeriod.split('-').map(Number);
  while (sy < ey || (sy === ey && sm <= em)) {
    periods.push(`${sy}-${String(sm).padStart(2, '0')}`);
    sm += 1;
    if (sm > 12) { sm = 1; sy += 1; }
  }
  return periods;
}
