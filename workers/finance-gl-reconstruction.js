// workers/finance-gl-reconstruction.js
// Session 20D (May 14 2026) — Post bookkeeper-truth reconstruction JEs from
// qbo_pnl_truth into the GL.
//
// One JE per month, cash basis, per-channel breakdown from QBO P&L API.
// EXCLUDES Too Good To Go (those are already posted as Mercury-direct JEs).
// Offsetting debit goes to Clearing Accounts:Cash Clearing (which the Mercury
// inflow JEs have built up over the period).
//
// Idempotent: re-running for a period already reconstructed will skip unless
// `force=true`. Audit trail preserved via source_type='qbo_pnl_reconstruction'.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

// Map QBO P&L account_path → our chart_of_accounts account_name
// Only INCOME paths handled here. SKIP entries are excluded from reconstruction
// (because they're posted elsewhere — TGTG via Mercury direct, etc.).
const INCOME_PATH_TO_COA = {
  'Income > Sales > Food Income > Dine-In / Takeout': 'Sales:Food Income:Dine-In / Takeout',
  'Income > Sales > Food Income > Delivery':          'Sales:Food Income:Delivery',
  'Income > Sales > Food Income > Wholesale':         'Sales:Food Income:Wholesale',
  'Income > Sales > Food Income > Catering':          'Sales:Food Income:Catering',
  'Income > Sales > Food Income':                     'Sales:Food Income',  // parent-direct
  'Income > Sales > Beverage Income > Beer':          'Sales:Beverage Income:Beer',
  'Income > Sales > Apparel Retail Sales':            'Sales:Apparel Retail Sales',
  'Income > Services':                                'Services',
  'Income > Service Fee Income':                      'Service Fee Income',
  'Income > Discounts, Comps & Refunds':              'Discounts, Comps & Refunds',
};
const SKIP_INCOME_PATHS = new Set([
  'Income > Too Good To Go',  // posted via Mercury direct (verified 1:1 match)
]);

const OFFSET_ACCOUNT_NAME = 'Clearing Accounts:Cash Clearing';
const SOURCE_TYPE = 'qbo_pnl_reconstruction';

// Resolve account name → id (cached per call)
async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts`
  ).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

// Build a per-period plan from qbo_pnl_truth income lines
async function buildPlanForPeriod(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT account_path, account_name, amount
    FROM qbo_pnl_truth
    WHERE period = ? AND section = 'Income' AND is_subtotal = 0
    ORDER BY account_path
  `).bind(period).all();

  const lines = [];
  const skipped = [];
  let unmapped = [];

  for (const row of (results || [])) {
    if (SKIP_INCOME_PATHS.has(row.account_path)) {
      skipped.push({ path: row.account_path, amount: row.amount, reason: 'posted_elsewhere' });
      continue;
    }
    const coa = INCOME_PATH_TO_COA[row.account_path];
    if (!coa) {
      unmapped.push({ path: row.account_path, amount: row.amount });
      continue;
    }
    lines.push({
      account_path: row.account_path,
      account_name: coa,
      amount: row.amount,
    });
  }

  return { period, lines, skipped, unmapped };
}

// Preview without posting (read-only)
export async function previewReconstruction(env, startPeriod, endPeriod) {
  const periods = enumeratePeriods(startPeriod, endPeriod);
  const plans = [];
  for (const p of periods) plans.push(await buildPlanForPeriod(env, p));
  return { ok: true, count: plans.length, plans };
}

// Post all reconstruction JEs for a date range. Idempotent.
export async function postReconstruction(env, startPeriod, endPeriod, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'gl_reconstruction' });

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
    // Idempotent check
    const existing = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? LIMIT 1`
    ).bind(SOURCE_TYPE, period).first();
    if (existing && !opts.force) {
      skipped.push({ period, reason: 'already_reconstructed', existing_je: existing.id });
      continue;
    }
    if (existing && opts.force) {
      // Reverse existing reconstruction JE first
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound for re-reconstruction at ' || datetime('now') WHERE id = ?`
      ).bind(existing.id).run();
    }

    const plan = await buildPlanForPeriod(env, period);
    if (plan.unmapped.length > 0) {
      errors.push({ period, reason: 'unmapped_accounts', unmapped: plan.unmapped });
      continue;
    }
    if (plan.lines.length === 0) {
      skipped.push({ period, reason: 'no_income_lines' });
      continue;
    }

    // Validate every account_name maps to a COA id
    const missingIds = plan.lines.filter(l => !accountIds[l.account_name]);
    if (missingIds.length > 0) {
      errors.push({ period, reason: 'coa_account_missing', missing: missingIds });
      continue;
    }

    // Compute totals. Note: Discounts is NEGATIVE (income reducer).
    // CR side = positive incomes; DR side = absolute negatives + offset balance.
    let totalCredits = 0;
    let totalNegativeAdjustments = 0;
    for (const line of plan.lines) {
      if (line.amount > 0) totalCredits += line.amount;
      else totalNegativeAdjustments += Math.abs(line.amount);
    }
    const netIncome = totalCredits - totalNegativeAdjustments;
    if (netIncome <= 0) {
      skipped.push({ period, reason: 'net_income_non_positive', netIncome });
      continue;
    }

    // Period last day for entry_date
    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const entryDate = `${period}-${String(lastDay).padStart(2, '0')}`;

    const entryId = crypto.randomUUID();
    const totalDebit = netIncome + totalNegativeAdjustments;  // = totalCredits
    const totalCredit = totalCredits;

    // Sanity check: debit = credit
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      errors.push({ period, reason: 'unbalanced', totalDebit, totalCredit });
      continue;
    }

    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_20d', ?)
    `).bind(
      entryId, entryDate,
      `QBO P&L reconstruction ${period} — cash basis bookkeeper truth`,
      SOURCE_TYPE, period, totalDebit, totalCredit,
      `Per-channel income from QBO P&L API. Offset to Cash Clearing. Excludes TGTG (Mercury direct).`
    ).run();

    let lineNum = 1;
    // 1) Offset DR to Cash Clearing for netIncome
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).bind(crypto.randomUUID(), entryId, lineNum++, offsetId, netIncome, `Zero out Cash Clearing for ${period} via QBO P&L truth`).run();

    // 2) DR for any negative income lines (discounts)
    for (const line of plan.lines) {
      if (line.amount < 0) {
        await env.DB.prepare(`
          INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[line.account_name], Math.abs(line.amount), `${line.account_name} for ${period}`).run();
      }
    }

    // 3) CR for positive income lines
    for (const line of plan.lines) {
      if (line.amount > 0) {
        await env.DB.prepare(`
          INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
          VALUES (?, ?, ?, ?, 0, ?, ?)
        `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[line.account_name], line.amount, `${line.account_name} for ${period} (QBO P&L truth)`).run();
      }
    }

    posted.push({ period, entry_id: entryId, lines: plan.lines.length, total: netIncome });
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'gl_reconstruction_post', 'journal_entries', ?, 'session_20d', ?, ?)
  `).bind(
    crypto.randomUUID(), `reconstruct_${Date.now()}`,
    `Reconstructed ${posted.length} months from QBO P&L truth (cash basis)`,
    JSON.stringify({ posted: posted.length, skipped: skipped.length, errors: errors.length })
  ).run().catch(() => {});

  return { ok: true, posted, skipped, errors };
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

// Verify: GL revenue per month vs QBO P&L truth, deltas
export async function verifyReconstruction(env) {
  const { results: glRows } = await env.DB.prepare(`
    SELECT strftime('%Y-%m', j.entry_date) as period,
           ROUND(SUM(l.credit - l.debit), 2) as gl_revenue
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status='posted' AND c.account_type='revenue'
      AND j.entry_date BETWEEN '2025-01-01' AND '2026-02-28'
    GROUP BY period
  `).all();

  const { results: qboRows } = await env.DB.prepare(`
    SELECT period,
           ROUND(SUM(CASE WHEN is_subtotal=0 THEN amount ELSE 0 END), 2) as qbo_income
    FROM qbo_pnl_truth
    WHERE section='Income'
    GROUP BY period
  `).all();

  const glMap = {};
  for (const r of glRows || []) glMap[r.period] = r.gl_revenue || 0;
  const qboMap = {};
  for (const r of qboRows || []) qboMap[r.period] = r.qbo_income || 0;

  const allPeriods = new Set([...Object.keys(glMap), ...Object.keys(qboMap)]);
  const summary = [];
  for (const p of Array.from(allPeriods).sort()) {
    const gl = glMap[p] || 0;
    const qbo = qboMap[p] || 0;
    const delta = Math.round((gl - qbo) * 100) / 100;
    summary.push({ period: p, gl_revenue: gl, qbo_income: qbo, delta, match: Math.abs(delta) < 0.01 });
  }
  return { ok: true, summary };
}
