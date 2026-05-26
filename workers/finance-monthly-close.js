// workers/finance-monthly-close.js
// Finance v2 — CFO Agent v2, monthly close (3.4).
// Per PRETZEL_OS_FINANCE_V2.md section 3.4.
//
// On the 1st of each month at 6am MT, runs the close for the PRIOR month:
//   1. Final reconciliation pass (sync + categorize + post for the closed period)
//   2. Monthly depreciation (post scheduled depreciation_schedules rows)
//   3. Generate financial statements (P&L, Balance Sheet, Cash Flow) via JE rollup
//   4. Variance analysis vs prior month
//   5. Lock the period in closed_periods
//   6. Write monthly brief to cfo_briefs + log
//
// Idempotent: re-running returns the existing close if the period is already locked.
//
// Endpoint: POST /finance/cfo/monthly-close[?period=YYYY-MM]  (default: prior month)

import { isReadOnly, readOnlySkip, getOrdersRevenueForPeriod, getGLRevenueForPeriod } from './finance-shared.js';

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function prevMonth(date) {
  const d = new Date(date + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  };
}

// ── P&L rollup from posted JEs ────────────────────────────────────────────
// RTR-2 (May 13 2026): revenue is now read from `orders` (sale-event timing)
// via getOrdersRevenueForPeriod. COGS + expense + other_income + other_expense
// remain GL-sourced (sweep timing doesn't affect those). The brief records
// BOTH the canonical (orders) and the GL revenue for audit / Tier 5.
async function computeProfitAndLoss(env, start, end) {
  // Session 20: revenue from GL (single source of truth)
  const glRev = await getGLRevenueForPeriod(env, start, end);
  const revenueByChannel = (glRev.lines || []).map(l => ({
    account_name: l.account_name,
    amount: round2(l.amount),
  })).filter(r => Math.abs(r.amount) > 0.01);

  // COGS + expense + other_* from GL
  const { results } = await env.DB.prepare(`
    SELECT c.account_type, c.account_subtype, c.account_name, c.id as account_id,
           ROUND(SUM(CASE WHEN c.account_type IN ('other_income') THEN l.credit - l.debit
                          WHEN c.account_type IN ('expense','cogs','other_expense') THEN l.debit - l.credit
                          ELSE 0 END), 2) as amount
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND c.account_type IN ('other_income','expense','cogs','other_expense')
    GROUP BY c.account_type, c.account_subtype, c.account_name, c.id
    ORDER BY c.account_type, c.account_name
  `).bind(start, end).all();

  const rows = results || [];
  const buckets = {
    revenue: glRev.total,
    cogs: 0,
    gross_profit: 0,
    expense: 0,
    operating_income: 0,
    other_income: 0,
    other_expense: 0,
    net_income: 0,
  };
  const byType = { revenue: revenueByChannel, cogs: [], expense: [], other_income: [], other_expense: [] };

  for (const r of rows) {
    const bucket = r.account_type === 'cogs' ? 'cogs'
                : r.account_type === 'expense' ? 'expense'
                : r.account_type === 'other_income' ? 'other_income'
                : 'other_expense';
    byType[bucket].push({ account_name: r.account_name, amount: r.amount });
    buckets[bucket] += r.amount || 0;
  }
  buckets.gross_profit     = round2(buckets.revenue - buckets.cogs);
  buckets.operating_income = round2(buckets.gross_profit - buckets.expense);
  buckets.net_income       = round2(buckets.operating_income + buckets.other_income - buckets.other_expense);
  for (const k of Object.keys(buckets)) buckets[k] = round2(buckets[k]);

  return {
    period: { start, end },
    totals: {
      ...buckets,
      revenue_source: 'gl_reconstruction',  // Session 20
      gl_revenue: glRev.total,              // same as buckets.revenue (audit transparency)
    },
    by_account: byType,
    revenue_breakdown: glRev.breakdown,
  };
}

// ── Balance Sheet rollup (as-of end) ──────────────────────────────────────
async function computeBalanceSheet(env, asOfDate) {
  const { results } = await env.DB.prepare(`
    SELECT c.account_type, c.account_subtype, c.account_name, c.id as account_id,
           ROUND(SUM(CASE WHEN c.account_type IN ('asset') THEN l.debit - l.credit
                          WHEN c.account_type IN ('liability','equity') THEN l.credit - l.debit
                          ELSE 0 END), 2) as balance
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date <= ?
      AND c.account_type IN ('asset','liability','equity')
    GROUP BY c.account_type, c.account_subtype, c.account_name, c.id
    HAVING ABS(balance) > 0.01
    ORDER BY c.account_type, c.account_name
  `).bind(asOfDate).all();

  const groups = { asset: [], liability: [], equity: [] };
  const totals = { asset: 0, liability: 0, equity: 0 };
  for (const r of (results || [])) {
    const type = r.account_type;
    if (type in groups) {
      groups[type].push({ account_name: r.account_name, balance: r.balance });
      totals[type] += r.balance || 0;
    }
  }
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  // Retained earnings plug: net income from all posted periods that isn't yet in equity
  const { net_to_date } = (await env.DB.prepare(`
    SELECT ROUND(SUM(CASE WHEN c.account_type = 'revenue' OR c.account_type = 'other_income' THEN l.credit - l.debit
                          WHEN c.account_type IN ('expense','cogs','other_expense') THEN -(l.debit - l.credit)
                          ELSE 0 END), 2) as net_to_date
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.entry_date <= ?
  `).bind(asOfDate).first()) || {};

  totals.retained_earnings = round2(net_to_date || 0);
  totals.equity_with_retained = round2(totals.equity + totals.retained_earnings);
  totals.liabilities_plus_equity = round2(totals.liability + totals.equity_with_retained);
  totals.unbalanced_by = round2(totals.asset - totals.liabilities_plus_equity);

  return { as_of: asOfDate, totals, by_account: groups };
}

// ── Cash Flow Statement (indirect method — simplified) ───────────────────
async function computeCashFlow(env, start, end) {
  // Operating: net income + non-cash items (depreciation) + working capital changes (AR/AP moves)
  // Simplification for a pretzel shop: just use cash movements through Mercury.
  const { results: cashByKind } = await env.DB.prepare(`
    SELECT CASE
             WHEN c.account_type IN ('revenue','other_income') THEN 'operating_in'
             WHEN c.account_type IN ('expense','cogs','other_expense') THEN 'operating_out'
             WHEN c.account_subtype = 'fixed_asset' THEN 'investing'
             WHEN c.account_type = 'liability' AND c.account_name LIKE '%loan%' THEN 'financing'
             ELSE 'other'
           END as kind,
           ROUND(SUM(CASE WHEN l.account_id IN (SELECT id FROM chart_of_accounts WHERE account_name LIKE 'Mercury %') THEN l.debit - l.credit ELSE 0 END), 2) as cash_delta
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.entry_date >= ? AND j.entry_date <= ?
    GROUP BY kind
  `).bind(start, end).all();

  const buckets = { operating: 0, investing: 0, financing: 0 };
  for (const r of (cashByKind || [])) {
    if (r.kind === 'operating_in' || r.kind === 'operating_out') buckets.operating += r.cash_delta || 0;
    else if (r.kind === 'investing') buckets.investing += r.cash_delta || 0;
    else if (r.kind === 'financing') buckets.financing += r.cash_delta || 0;
  }
  for (const k of Object.keys(buckets)) buckets[k] = round2(buckets[k]);
  buckets.net_change = round2(buckets.operating + buckets.investing + buckets.financing);

  const { opening, closing } = (await env.DB.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN j.entry_date < ? THEN l.debit - l.credit ELSE 0 END), 2) as opening,
      ROUND(SUM(CASE WHEN j.entry_date <= ? THEN l.debit - l.credit ELSE 0 END), 2) as closing
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND c.account_name LIKE 'Mercury %'
  `).bind(start, end).first()) || {};

  return {
    period: { start, end },
    cash_by_activity: buckets,
    opening_cash: round2(opening || 0),
    closing_cash: round2(closing || 0),
  };
}

// ── Run scheduled depreciation for the month ─────────────────────────────
async function runMonthlyDepreciation(env, period) {
  const { results: scheduled } = await env.DB.prepare(`
    SELECT d.id, d.asset_id, d.schedule_date, d.amount, a.asset_name
    FROM depreciation_schedules d
    JOIN fixed_assets a ON a.id = d.asset_id
    WHERE d.status = 'scheduled'
      AND SUBSTR(d.schedule_date, 1, 7) = ?
  `).bind(period).all();

  const posted = [];
  for (const s of (scheduled || [])) {
    // Find Depreciation Expense + Accumulated Depreciation in COA
    const depExp = await env.DB.prepare(
      `SELECT id FROM chart_of_accounts WHERE LOWER(account_name) LIKE '%depreciation expense%' OR LOWER(account_name) LIKE '%depreciation%expense%' LIMIT 1`
    ).first();
    const accDep = await env.DB.prepare(
      `SELECT id FROM chart_of_accounts WHERE LOWER(account_name) LIKE '%accumulated depreciation%' OR LOWER(account_name) LIKE '%accum%dep%' LIMIT 1`
    ).first();
    if (!depExp?.id || !accDep?.id) continue;

    const entryId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, 'depreciation', ?, ?, ?, 'posted', 'cfo_agent', ?)
    `).bind(
      entryId, s.schedule_date,
      `Monthly depreciation: ${s.asset_name}`,
      s.asset_id, s.amount, s.amount,
      `Scheduled depreciation posting for ${period}`
    ).run();
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 1, ?, ?, 0, ?)
    `).bind(crypto.randomUUID(), entryId, depExp.id, s.amount, s.asset_name).run();
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 2, ?, 0, ?, ?)
    `).bind(crypto.randomUUID(), entryId, accDep.id, s.amount, s.asset_name).run();
    await env.DB.prepare(
      `UPDATE depreciation_schedules SET status='posted', journal_entry_id=? WHERE id = ?`
    ).bind(entryId, s.id).run();
    await env.DB.prepare(
      `UPDATE fixed_assets SET accumulated_depreciation = COALESCE(accumulated_depreciation, 0) + ?, net_book_value = acquisition_cost - (COALESCE(accumulated_depreciation, 0) + ?) WHERE id = ?`
    ).bind(s.amount, s.amount, s.asset_id).run();

    posted.push({ asset: s.asset_name, amount: s.amount, date: s.schedule_date });
  }

  return { count: posted.length, total: round2(posted.reduce((s, p) => s + p.amount, 0)), detail: posted };
}

// ── RTR-4: Atomic close gate ─────────────────────────────────────────────
// Before locking a period, verify the data for that period is COMPLETE.
// Without this gate, monthly close would happen on schedule regardless of
// whether late settlements / sweeps / categorizations were in — which was
// the root cause of the $0 March / $79K April symptom.
//
// Gate rules:
//   1. Grace period — period_end + N days must have passed (default 5)
//   2. Mercury sync ran since period_end (last_synced_at for any active acct)
//   3. Revenue sweep ran for period_end (sweep_runs has entry covering it)
//   4. No mercury_transactions in period are uncategorized
//      (proposed_account_id IS NULL with no manual decision)
//   5. No pending JEs for the period (status='pending')
//
// Returns { ok, can_close, gates: [{name, status, detail}], blockers, note }
//
// Default behavior: runMonthlyClose REFUSES if gate fails. Override via
// `force=true` (Drew acknowledged the data is intentionally partial).
export async function checkCloseGate(env, period, opts = {}) {
  const gracePeriodDays = opts.gracePeriodDays ?? 5;
  const { start, end } = monthBounds(period);
  const today = new Date().toISOString().slice(0, 10);

  // Gate 1: grace period
  const endDate = new Date(end + 'T00:00:00Z');
  const graceEnd = new Date(endDate.getTime() + gracePeriodDays * 86400000);
  const inGracePeriod = new Date() < graceEnd;
  const gate1 = {
    name: 'grace_period',
    status: inGracePeriod ? 'fail' : 'pass',
    detail: inGracePeriod
      ? `Period ends ${end}; ${gracePeriodDays}-day grace period until ${graceEnd.toISOString().slice(0, 10)}. Still ${Math.ceil((graceEnd - new Date()) / 86400000)}d to go.`
      : `Period ends ${end}; grace period (${gracePeriodDays}d) elapsed.`,
  };

  // Gate 2: Mercury sync occurred since period_end
  const mercurySync = await env.DB.prepare(`
    SELECT MAX(last_synced_at) as last_sync
    FROM mercury_accounts WHERE is_active = 1
  `).first();
  const lastSync = mercurySync?.last_sync;
  const syncAfterPeriodEnd = lastSync && lastSync >= end;
  const gate2 = {
    name: 'mercury_sync_after_period_end',
    status: syncAfterPeriodEnd ? 'pass' : 'fail',
    detail: lastSync
      ? `Last Mercury sync: ${lastSync}. Period end: ${end}. ${syncAfterPeriodEnd ? 'OK' : 'sync predates period end'}`
      : 'No Mercury sync recorded',
  };

  // Gate 3: Revenue sweep covers period_end
  // Check if there's a revenue_sweep JE entry dated within the period
  const sweepCovered = await env.DB.prepare(`
    SELECT COUNT(*) as n
    FROM journal_entries
    WHERE source_type = 'revenue_sweep'
      AND entry_date >= ? AND entry_date <= ?
      AND status = 'posted'
  `).bind(start, end).first();
  const gate3 = {
    name: 'revenue_sweep_ran',
    status: (sweepCovered?.n || 0) > 0 ? 'pass' : 'warn',
    detail: `${sweepCovered?.n || 0} revenue_sweep JE(s) dated in period`,
  };

  // Gate 4: No uncategorized Mercury txns in period
  const uncat = await env.DB.prepare(`
    SELECT COUNT(*) as n
    FROM mercury_transactions
    WHERE txn_date >= ? AND txn_date <= ?
      AND proposed_account_id IS NULL
      AND user_overridden = 0
      AND is_reconciled = 0
  `).bind(start, end).first();
  const uncatCount = uncat?.n || 0;
  const gate4 = {
    name: 'no_uncategorized_txns',
    status: uncatCount === 0 ? 'pass' : (uncatCount < 10 ? 'warn' : 'fail'),
    detail: `${uncatCount} uncategorized Mercury txn(s) in period`,
  };

  // Gate 5: No pending JEs for the period
  const pendingJes = await env.DB.prepare(`
    SELECT COUNT(*) as n
    FROM journal_entries
    WHERE entry_date >= ? AND entry_date <= ?
      AND status = 'pending'
  `).bind(start, end).first();
  const pendingCount = pendingJes?.n || 0;
  const gate5 = {
    name: 'no_pending_jes',
    status: pendingCount === 0 ? 'pass' : 'fail',
    detail: `${pendingCount} pending JE(s) for period`,
  };

  const gates = [gate1, gate2, gate3, gate4, gate5];
  const failing = gates.filter(g => g.status === 'fail');
  const warnings = gates.filter(g => g.status === 'warn');
  const can_close = failing.length === 0;

  return {
    ok: true,
    period,
    period_bounds: { start, end },
    can_close,
    gates,
    blockers: failing.map(g => g.name),
    warnings: warnings.map(g => g.name),
    note: can_close
      ? (warnings.length > 0
          ? `Period CAN close but has ${warnings.length} warning(s). Review before locking.`
          : 'All gates passed — period ready to close.')
      : `Period CANNOT close — ${failing.length} gate(s) failing: ${failing.map(g => g.name).join(', ')}. Override with force=true.`,
  };
}

// ── Lock the period ──────────────────────────────────────────────────────
async function lockPeriod(env, period) {
  const { start, end } = monthBounds(period);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO closed_periods (id, period_start, period_end, locked_at, locked_by)
    VALUES (?, ?, ?, datetime('now'), 'cfo_agent')
  `).bind(crypto.randomUUID(), start, end).run();
}

// ── Orchestrator ─────────────────────────────────────────────────────────
export async function runMonthlyClose(env, period, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'monthly_close', period: period || 'prior' });
  period = period || prevMonth(new Date().toISOString().slice(0, 7));
  const { start, end } = monthBounds(period);
  const started = Date.now();

  // Idempotency: if already locked, return the existing brief
  const existing = await env.DB.prepare(
    `SELECT id FROM closed_periods WHERE period_start = ? AND period_end = ? AND unlocked_at IS NULL`
  ).bind(start, end).first();
  if (existing) {
    const prior = await env.DB.prepare(
      `SELECT content FROM cfo_briefs WHERE brief_date = ? AND type = 'monthly_close'`
    ).bind(start).first();
    if (prior) return { ok: true, already_closed: true, period, summary: JSON.parse(prior.content) };
  }

  // RTR-4: Close gate. Don't close if data is incomplete. Override with force=true.
  if (!opts.force) {
    const gate = await checkCloseGate(env, period, { gracePeriodDays: opts.gracePeriodDays });
    if (!gate.can_close) {
      return {
        ok: false,
        period,
        gate_blocked: true,
        gate,
        note: `Close gate blocked. ${gate.note} Pass force=true to override.`,
      };
    }
  }

  const [pl, bs, cf, dep] = await Promise.all([
    computeProfitAndLoss(env, start, end),
    computeBalanceSheet(env, end),
    computeCashFlow(env, start, end),
    runMonthlyDepreciation(env, period),
  ]);

  const priorPeriod = prevMonth(period);
  const priorBounds = monthBounds(priorPeriod);
  const priorPL = await computeProfitAndLoss(env, priorBounds.start, priorBounds.end);

  const variance = {
    revenue_pct: priorPL.totals.revenue ? round2((pl.totals.revenue - priorPL.totals.revenue) / priorPL.totals.revenue * 100) : null,
    cogs_pct:    priorPL.totals.cogs    ? round2((pl.totals.cogs - priorPL.totals.cogs) / priorPL.totals.cogs * 100)         : null,
    expense_pct: priorPL.totals.expense ? round2((pl.totals.expense - priorPL.totals.expense) / priorPL.totals.expense * 100) : null,
    net_income_delta: round2(pl.totals.net_income - priorPL.totals.net_income),
  };

  const summary = {
    period,
    period_bounds: { start, end },
    profit_and_loss: pl,
    balance_sheet: bs,
    cash_flow: cf,
    depreciation: dep,
    vs_prior_month: { prior: priorPeriod, variance, prior_totals: priorPL.totals },
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
  };

  // Write to cfo_briefs + finance_audit_log
  await env.DB.prepare(`
    INSERT INTO cfo_briefs (id, brief_date, type, content)
    VALUES (?, ?, 'monthly_close', ?)
    ON CONFLICT(brief_date, type) DO UPDATE SET content = excluded.content
  `).bind(crypto.randomUUID(), start, JSON.stringify(summary)).run().catch(() => {});

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'cfo_monthly_close', 'cfo_briefs', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), period,
    `Monthly close ${period}: revenue $${pl.totals.revenue}, net income $${pl.totals.net_income}, depreciation posted: ${dep.count} assets`,
    JSON.stringify({ period, totals: pl.totals, bs_totals: bs.totals, cf_totals: cf.cash_by_activity })
  ).run().catch(() => {});

  await lockPeriod(env, period);

  return { ok: true, already_closed: false, period, summary };
}

export async function getMonthlyClose(env, period) {
  const { start } = monthBounds(period);
  const row = await env.DB.prepare(
    `SELECT content, created_at FROM cfo_briefs WHERE brief_date = ? AND type = 'monthly_close'`
  ).bind(start).first();
  if (!row) return { error: `no close found for ${period}` };
  try {
    return { period, generated_at: row.created_at, summary: JSON.parse(row.content) };
  } catch {
    return { error: 'could not parse stored close' };
  }
}

// ── RTR-3: Recompute a (possibly-closed) period's brief from current data ──
//
// Why: closed monthly briefs may be stale because (a) sweep timing dropped
// revenue into the wrong period, (b) more JEs landed for that month after
// close, (c) categorizations were updated. The stored brief is the audit-
// of-record — what was REPORTED at close time — but the live numbers might
// be more accurate now.
//
// This endpoint:
//   - Always computes a fresh brief from current data (orders + GL)
//   - Compares to the stored brief if one exists
//   - Surfaces the deltas
//   - With `?write=true`, overwrites the stored brief (locks deferred — RTR-4
//     handles the atomic boundary)
//
// Endpoint: POST /finance/cfo/monthly-close/:period/recompute?write=false
export async function recomputeMonthlyClose(env, period, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(period || '')) {
    return { ok: false, error: 'period must be YYYY-MM' };
  }
  const { start, end } = monthBounds(period);
  const started = Date.now();

  // Compute fresh
  const [pl, bs, cf] = await Promise.all([
    computeProfitAndLoss(env, start, end),
    computeBalanceSheet(env, end),
    computeCashFlow(env, start, end),
  ]);

  const priorPeriod = prevMonth(period);
  const priorBounds = monthBounds(priorPeriod);
  const priorPL = await computeProfitAndLoss(env, priorBounds.start, priorBounds.end);
  const variance = {
    revenue_pct: priorPL.totals.revenue ? round2((pl.totals.revenue - priorPL.totals.revenue) / priorPL.totals.revenue * 100) : null,
    cogs_pct:    priorPL.totals.cogs    ? round2((pl.totals.cogs - priorPL.totals.cogs) / priorPL.totals.cogs * 100)         : null,
    expense_pct: priorPL.totals.expense ? round2((pl.totals.expense - priorPL.totals.expense) / priorPL.totals.expense * 100) : null,
    net_income_delta: round2(pl.totals.net_income - priorPL.totals.net_income),
  };

  const recomputed = {
    period,
    period_bounds: { start, end },
    profit_and_loss: pl,
    balance_sheet: bs,
    cash_flow: cf,
    depreciation: { count: 0, total: 0, detail: [], note: 'recompute does not re-post depreciation; original close owned that' },
    vs_prior_month: { prior: priorPeriod, variance, prior_totals: priorPL.totals },
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    is_recompute: true,
  };

  // Read stored brief for comparison
  const row = await env.DB.prepare(
    `SELECT content, created_at FROM cfo_briefs WHERE brief_date = ? AND type = 'monthly_close'`
  ).bind(start).first();
  let stored = null;
  let storedRev = null, storedNet = null;
  if (row) {
    try {
      stored = JSON.parse(row.content);
      storedRev = stored?.profit_and_loss?.totals?.revenue ?? null;
      storedNet = stored?.profit_and_loss?.totals?.net_income ?? null;
    } catch { /* ignore */ }
  }

  const deltas = stored ? {
    revenue: storedRev != null ? round2(pl.totals.revenue - storedRev) : null,
    revenue_pct: storedRev ? round2(((pl.totals.revenue - storedRev) / storedRev) * 100) : null,
    net_income: storedNet != null ? round2(pl.totals.net_income - storedNet) : null,
  } : null;

  // Optionally overwrite the stored brief
  let wrote = false;
  if (opts.write) {
    await env.DB.prepare(`
      INSERT INTO cfo_briefs (id, brief_date, type, content)
      VALUES (?, ?, 'monthly_close', ?)
      ON CONFLICT(brief_date, type) DO UPDATE SET content = excluded.content
    `).bind(crypto.randomUUID(), start, JSON.stringify(recomputed)).run();
    await env.DB.prepare(`
      INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, before_json, after_json)
      VALUES (?, 'cfo_monthly_close_recompute', 'cfo_briefs', ?, 'cfo_agent', ?, ?, ?)
    `).bind(
      crypto.randomUUID(), period,
      `Monthly close ${period} RECOMPUTED: revenue $${pl.totals.revenue} (delta from stored: $${deltas?.revenue ?? 'n/a'})`,
      stored ? JSON.stringify({ revenue: storedRev, net_income: storedNet }) : null,
      JSON.stringify({ revenue: pl.totals.revenue, net_income: pl.totals.net_income, gl_revenue: pl.totals.gl_revenue })
    ).run().catch(() => {});
    wrote = true;
  }

  return {
    ok: true,
    period,
    recomputed,
    stored_summary: stored ? {
      revenue: storedRev,
      net_income: storedNet,
      generated_at: stored?.generated_at,
    } : null,
    deltas,
    wrote_to_brief: wrote,
    note: wrote
      ? `Stored brief overwritten with recomputed values.`
      : stored
        ? `Stored brief NOT overwritten. Add ?write=true to persist recomputed values. Stored brief remains the audit-of-record until written.`
        : `No stored brief existed; recomputed values returned but not persisted (use POST /finance/cfo/monthly-close to create one).`,
  };
}
