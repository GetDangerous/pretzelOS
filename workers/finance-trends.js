// workers/finance-trends.js
// Trend detector — rolling 3/6/12 month values for key business metrics.
//
// Endpoint:
//   GET /finance/trends                — all metrics, 3+6mo windows
//   GET /finance/trends/:metric?window= — single metric series
//
// Metrics supported:
//   revenue, cogs, cogs_pct, gross_margin_pct, payroll_pct,
//   operating_expense_pct, net_income, cash_burn_weekly,
//   dso, ar_overdue_pct, ar_total
//
// RTR-2 (May 13 2026): per-month revenue is sourced from `orders` (sale-event
// timing) via getOrdersRevenueForPeriod. COGS + expense + payroll stay
// GL-sourced because those JE dates equal the actual expense date.

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function pct(n) { return Math.round(n * 1000) / 10; }

// Helper: produce the list of YYYY-MM keys for the last N months (oldest first).
function monthKeys(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function monthBoundsUTC(period) {
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  };
}

// ── Per-month revenue + COGS + expense aggregates ────────────────────────
// Revenue: orders-based (RTR-2). COGS + expense: GL-based.
async function getMonthlyPL(env, months) {
  // 1) Get COGS + expense + other_income aggregates from GL for the window.
  //    (Includes other_income for parity with prior behavior; renders into
  //    'revenue' field via the orders-based total instead.)
  const { results: glRows } = await env.DB.prepare(`
    SELECT SUBSTR(j.entry_date, 1, 7) as month,
           ROUND(SUM(CASE WHEN c.account_type = 'cogs' THEN l.debit - l.credit ELSE 0 END), 2) as cogs,
           ROUND(SUM(CASE WHEN c.account_type = 'expense' THEN l.debit - l.credit ELSE 0 END), 2) as expense
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.source_type != 'fiscal_year_close'
      AND j.entry_date >= date('now', 'start of month', '-' || ? || ' months')
    GROUP BY month
    ORDER BY month
  `).bind(months).all();
  const glMap = new Map((glRows || []).map(r => [r.month, r]));

  // Session 20: revenue from GL (single source of truth after reconstruction).
  // Was getOrdersRevenueForPeriod — that's now AUDIT-ONLY.
  const { getGLRevenueForPeriod } = await import('./finance-shared.js');
  const monthsList = monthKeys(months);
  const revenuesByMonth = await Promise.all(monthsList.map(async (m) => {
    const { start, end } = monthBoundsUTC(m);
    const glRev = await getGLRevenueForPeriod(env, start, end);
    return { month: m, revenue: glRev.total };
  }));

  // Stitch GL revenue + GL cogs/expense (both from same source now).
  return revenuesByMonth.map(({ month, revenue }) => {
    const gl = glMap.get(month) || { cogs: 0, expense: 0 };
    const cogs = r2(gl.cogs || 0);
    const expense = r2(gl.expense || 0);
    return {
      month,
      revenue: r2(revenue),
      cogs,
      expense,
      gross_profit: r2(revenue - cogs),
      net_income: r2(revenue - cogs - expense),
      cogs_pct: revenue ? pct(cogs / revenue) : null,
      gross_margin_pct: revenue ? pct((revenue - cogs) / revenue) : null,
    };
  });
}

// ── Per-month payroll from posted JEs ────────────────────────────────────
async function getMonthlyPayroll(env, months) {
  const { results } = await env.DB.prepare(`
    SELECT SUBSTR(j.entry_date, 1, 7) as month,
           ROUND(SUM(l.debit - l.credit), 2) as payroll
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.source_type != 'fiscal_year_close'
      AND j.entry_date >= date('now', 'start of month', '-' || ? || ' months')
      AND (c.account_name LIKE 'Payroll%' OR c.account_subtype = 'payroll')
    GROUP BY month
    ORDER BY month
  `).bind(months).all();
  return new Map((results || []).map(r => [r.month, r2(r.payroll || 0)]));
}

// ── Per-week cash burn from Mercury (excludes interbank) ─────────────────
async function getWeeklyCashBurn(env, weeks) {
  const { results } = await env.DB.prepare(`
    SELECT strftime('%Y-W%W', txn_date) as week,
           MIN(txn_date) as week_start,
           ROUND(SUM(amount), 2) as net
    FROM mercury_transactions
    WHERE txn_date >= date('now', '-' || ? || ' days')
      AND counterparty_name IS NOT NULL
      AND LOWER(counterparty_name) NOT LIKE '%mercury checking%'
      AND LOWER(counterparty_name) NOT LIKE '%mercury savings%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
      AND LOWER(counterparty_name) NOT LIKE '%chase business%'
    GROUP BY week
    ORDER BY week
  `).bind(weeks * 7).all();
  return (results || []).map(r => ({
    week: r.week,
    week_start: r.week_start.slice(0, 10),
    net: r2(r.net || 0),
  }));
}

// ── DSO + AR aging snapshot ──────────────────────────────────────────────
async function getArMetrics(env) {
  // Total open + overdue, plus weighted DSO from invoice age
  const { results } = await env.DB.prepare(`
    SELECT
      json_extract(raw_payload, '$.due_date') as due_date,
      json_extract(raw_payload, '$.txn_date') as txn_date,
      CAST(json_extract(raw_payload, '$.balance') AS REAL) as balance,
      order_date
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','paid','estimate')
      AND CAST(json_extract(raw_payload, '$.balance') AS REAL) > 0
  `).all();

  const today = new Date();
  let total = 0, overdue = 0, weighted_age_sum = 0, balance_sum = 0;
  for (const inv of (results || [])) {
    const bal = inv.balance || 0;
    total += bal;
    const due = inv.due_date ? new Date(inv.due_date) : null;
    if (due && due < today) overdue += bal;
    const txn = inv.txn_date ? new Date(inv.txn_date) : null;
    if (txn) {
      const age = Math.floor((today - txn) / 86400000);
      weighted_age_sum += age * bal;
      balance_sum += bal;
    }
  }
  return {
    ar_total: r2(total),
    ar_overdue: r2(overdue),
    ar_overdue_pct: total > 0 ? pct(overdue / total) : 0,
    dso_days: balance_sum > 0 ? Math.round(weighted_age_sum / balance_sum) : 0,
  };
}

// ── Public: full trend summary ───────────────────────────────────────────
export async function getTrends(env, opts = {}) {
  const months = opts.months || 12;
  const monthly = await getMonthlyPL(env, months);
  const payrollMap = await getMonthlyPayroll(env, months);
  const weeklyBurn = await getWeeklyCashBurn(env, 14);
  const ar = await getArMetrics(env);

  // Annotate payroll % per month
  for (const m of monthly) {
    const payroll = payrollMap.get(m.month) || 0;
    m.payroll = r2(payroll);
    m.payroll_pct = m.revenue > 0 ? pct(payroll / m.revenue) : null;
    m.operating_expense_pct = m.revenue > 0 ? pct(m.expense / m.revenue) : null;
  }

  // Computed averages over windows
  const window3 = monthly.slice(-3);
  const window6 = monthly.slice(-6);
  const window12 = monthly.slice(-12);
  const avg = (arr, key) => {
    const vals = arr.map(m => m[key]).filter(v => v != null);
    if (!vals.length) return null;
    return r2(vals.reduce((s, v) => s + v, 0) / vals.length);
  };

  const trend_summary = {
    revenue:           { '3mo_avg': avg(window3, 'revenue'),  '6mo_avg': avg(window6, 'revenue'),  '12mo_avg': avg(window12, 'revenue') },
    cogs:              { '3mo_avg': avg(window3, 'cogs'),     '6mo_avg': avg(window6, 'cogs'),     '12mo_avg': avg(window12, 'cogs') },
    cogs_pct:          { '3mo_avg': avg(window3, 'cogs_pct'), '6mo_avg': avg(window6, 'cogs_pct'), '12mo_avg': avg(window12, 'cogs_pct') },
    gross_margin_pct:  { '3mo_avg': avg(window3, 'gross_margin_pct'), '6mo_avg': avg(window6, 'gross_margin_pct'), '12mo_avg': avg(window12, 'gross_margin_pct') },
    payroll:           { '3mo_avg': avg(window3, 'payroll'),  '6mo_avg': avg(window6, 'payroll'),  '12mo_avg': avg(window12, 'payroll') },
    payroll_pct:       { '3mo_avg': avg(window3, 'payroll_pct'), '6mo_avg': avg(window6, 'payroll_pct'), '12mo_avg': avg(window12, 'payroll_pct') },
    net_income:        { '3mo_avg': avg(window3, 'net_income'),'6mo_avg': avg(window6, 'net_income'),'12mo_avg': avg(window12, 'net_income') },
    operating_expense_pct: { '3mo_avg': avg(window3, 'operating_expense_pct'), '6mo_avg': avg(window6, 'operating_expense_pct'), '12mo_avg': avg(window12, 'operating_expense_pct') },
  };

  // Direction arrows: 3mo vs 6mo for each metric
  const direction = {};
  for (const [key, vals] of Object.entries(trend_summary)) {
    const a = vals['3mo_avg'], b = vals['6mo_avg'];
    if (a == null || b == null) { direction[key] = '—'; continue; }
    const diff = a - b;
    const absPct = Math.abs(b) > 0 ? Math.abs(diff / b) : 0;
    if (absPct < 0.05) direction[key] = '→';
    else direction[key] = diff > 0 ? '▲' : '▼';
  }

  // Weekly burn metrics
  const weekly_burn_avg = weeklyBurn.length ? r2(weeklyBurn.reduce((s, w) => s + w.net, 0) / weeklyBurn.length) : 0;

  return {
    monthly_series: monthly,
    trend_summary,
    direction,
    weekly_cashflow: weeklyBurn,
    weekly_cashflow_avg: weekly_burn_avg,
    ar,
    note: 'Direction arrows compare 3mo avg vs 6mo avg. ▲ rising, ▼ falling, → stable (<5% delta).',
  };
}

// ── Single metric series (for chart drilldown) ───────────────────────────
export async function getTrend(env, metric, opts = {}) {
  const months = opts.months || 12;
  const monthly = await getMonthlyPL(env, months);
  const payrollMap = await getMonthlyPayroll(env, months);
  for (const m of monthly) {
    const p = payrollMap.get(m.month) || 0;
    m.payroll = r2(p);
    m.payroll_pct = m.revenue > 0 ? pct(p / m.revenue) : null;
    m.operating_expense_pct = m.revenue > 0 ? pct(m.expense / m.revenue) : null;
  }
  const series = monthly.map(m => ({ month: m.month, value: m[metric] }));
  return { metric, months, series };
}
