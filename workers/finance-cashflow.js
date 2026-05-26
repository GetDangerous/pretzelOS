// workers/finance-cashflow.js
// Finance v2 — CFO Agent v2, cash flow projection engine (C-4).
// Per PRETZEL_OS_FINANCE_V2.md section 3.9.
//
// 30-day rolling cash forecast. Pulls from:
//   Inflows:
//     - AR invoices due within window (weighted by historical pay-on-time rate)
//     - Projected retail revenue (30-day rolling Mercury inflow average × season factor)
//     - Known recurring inflows (Too Good To Go, etc.) — future
//   Outflows:
//     - bills.due_date within window (open bills)
//     - recurring_bills.next_expected_date
//     - loan_payments (from amortization schedules)
//     - payroll_runs.pay_date upcoming
//     - sales_tax_filings.due_date within window (tax_owed)
//     - depreciation_schedules (not cash — excluded)
//     - Estimated discretionary (30-day rolling avg of small outflows)
//
// Output: daily projected ending balance for next 30 days, lowest-balance day,
// days-of-runway calculation. Writes rows to cash_flow_forecast table.
//
// Endpoints:
//   POST /finance/cfo/forecast/rebuild[?days=30]
//   GET  /finance/cfo/forecast[?days=30]

import { getCanonicalCashOnHand } from './finance-shared.js';

const DEFAULT_DAYS = 30;

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(date, n) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + n); return d; }

// ── Pull the current cash position from Mercury ──────────────────────────
// Uses canonical helper (refresh-on-read, 5-min TTL). Phase 2 reset Apr 30
// 2026 — was direct read which silently served 12-day-stale data.
async function getCurrentCashBalance(env) {
  const canonical = await getCanonicalCashOnHand(env);
  return {
    accounts: canonical.breakdown.map(b => ({ account_name: b.account_name, current_balance: b.balance })),
    total: canonical.total,
    as_of: canonical.as_of,
    age_seconds: canonical.age_seconds,
    refreshed_inline: canonical.refreshed_inline,
  };
}

// ── Pull AR expected collections ─────────────────────────────────────────
async function arCollectionsForecast(env, startDate, endDate) {
  // Invoices currently open/sent/past_due with due_date in window.
  const { results } = await env.DB.prepare(`
    SELECT i.id, i.invoice_number, i.customer_id, c.display_name, i.due_date,
           i.amount_total, i.amount_paid, (i.amount_total - i.amount_paid) as outstanding,
           i.status
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('sent','past_due','partially_paid')
      AND (i.amount_total - i.amount_paid) > 0.01
    ORDER BY i.due_date ASC
  `).all();

  // For each invoice, assume 90% pay-on-time (conservative). Anything past due
  // is expected within 14 days of its due date.
  const collections = [];
  const today = isoDate(new Date());
  for (const inv of (results || [])) {
    let expectedDate = inv.due_date;
    if (inv.due_date < today) expectedDate = isoDate(addDays(new Date(), 7));
    if (expectedDate >= startDate && expectedDate <= endDate) {
      collections.push({
        target_date: expectedDate,
        amount: round2(inv.outstanding * 0.90),  // 90% weighting
        source: 'invoice',
        source_id: inv.id,
        detail: `${inv.customer_display_name || inv.display_name} · INV ${inv.invoice_number}`,
      });
    }
  }
  return collections;
}

// ── Pull retail revenue forecast (30-day rolling Mercury inflow avg) ─────
async function retailInflowForecast(env, startDate, endDate, days) {
  // Use trailing 30-day Mercury inflow as baseline.
  const { avg } = await env.DB.prepare(`
    SELECT AVG(daily_total) as avg FROM (
      SELECT DATE(txn_date) as day, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as daily_total
      FROM mercury_transactions
      WHERE txn_date >= date('now', '-30 days') AND amount > 0
      GROUP BY day
    )
  `).first() || {};
  const dailyAvg = round2(avg || 0);

  // Scale down retail deposit days — assume 5 deposit days per week.
  // Daily inflow line items for the forecast window.
  const forecast = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(new Date(startDate + 'T00:00:00Z'), i);
    const iso = isoDate(d);
    const dow = d.getUTCDay();  // 0=Sun, 6=Sat
    const scale = (dow === 0) ? 0.0 : 1.0;  // no deposits Sunday (rough heuristic)
    if (iso >= startDate && iso <= endDate && scale > 0) {
      forecast.push({
        target_date: iso,
        amount: round2(dailyAvg * scale),
        source: 'retail_forecast',
        detail: `Estimated retail deposit (${round2(dailyAvg).toLocaleString()} avg)`,
      });
    }
  }
  return { daily_avg: dailyAvg, forecast };
}

// ── Pull outflow — open bills, recurring, loan, sales tax ────────────────
async function outflowsForecast(env, startDate, endDate) {
  const outflows = [];

  // 1. Open bills with due_date in window
  const { results: bills } = await env.DB.prepare(`
    SELECT id, vendor_id, bill_number, due_date, (amount - amount_paid) as outstanding
    FROM bills
    WHERE status IN ('open','partially_paid')
      AND due_date >= ? AND due_date <= ?
      AND (amount - amount_paid) > 0.01
  `).bind(startDate, endDate).all();
  for (const b of (bills || [])) {
    outflows.push({
      target_date: b.due_date,
      amount: -round2(b.outstanding),
      source: 'bill',
      source_id: b.id,
      detail: `Bill ${b.bill_number || b.id}`,
    });
  }

  // 2. Recurring bills next expected
  const { results: recurring } = await env.DB.prepare(`
    SELECT id, vendor_id, description, expected_amount, cadence, next_expected_date
    FROM recurring_bills
    WHERE is_active = 1
      AND next_expected_date >= ? AND next_expected_date <= ?
  `).bind(startDate, endDate).all();
  for (const r of (recurring || [])) {
    outflows.push({
      target_date: r.next_expected_date,
      amount: -round2(r.expected_amount),
      source: 'recurring_bill',
      source_id: r.id,
      detail: r.description,
    });
  }

  // 3. Loan payments due
  const { results: loanPmts } = await env.DB.prepare(`
    SELECT id, loan_name, next_payment_date, monthly_payment
    FROM loans
    WHERE status = 'active'
      AND next_payment_date >= ? AND next_payment_date <= ?
  `).bind(startDate, endDate).all();
  for (const l of (loanPmts || [])) {
    outflows.push({
      target_date: l.next_payment_date,
      amount: -round2(l.monthly_payment),
      source: 'loan_payment',
      source_id: l.id,
      detail: l.loan_name,
    });
  }

  // 4. Sales tax filings due in window
  const { results: taxes } = await env.DB.prepare(`
    SELECT id, period, return_type, due_date, tax_owed
    FROM sales_tax_filings
    WHERE return_type IN ('spf','tc_62')
      AND status IN ('calculated','pending','filed')
      AND payment_date IS NULL
      AND due_date >= ? AND due_date <= ?
  `).bind(startDate, endDate).all();
  for (const t of (taxes || [])) {
    outflows.push({
      target_date: t.due_date,
      amount: -round2(t.tax_owed || 0),
      source: 'sales_tax',
      source_id: t.id,
      detail: `${t.period} ${t.return_type}`,
    });
  }

  // 5. Estimated discretionary outflow (30-day rolling average, excluding large known buckets)
  const { avg } = await env.DB.prepare(`
    SELECT AVG(daily_total) as avg FROM (
      SELECT DATE(txn_date) as day, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) as daily_total
      FROM mercury_transactions
      WHERE txn_date >= date('now', '-30 days') AND amount < 0
      GROUP BY day
    )
  `).first() || {};
  const discretionaryDaily = round2((avg || 0) * 0.4);  // 40% of recent average (conservative — specific outflows cover the rest)
  return { line_items: outflows, discretionary_daily: discretionaryDaily };
}

// ── Rebuild the forecast + write to cash_flow_forecast ───────────────────
export async function rebuildForecast(env, days = DEFAULT_DAYS) {
  const today = new Date();
  const startDate = isoDate(today);
  const endDate = isoDate(addDays(today, days));

  const [cashNow, arCollect, retailIn, outData] = await Promise.all([
    getCurrentCashBalance(env),
    arCollectionsForecast(env, startDate, endDate),
    retailInflowForecast(env, startDate, endDate, days),
    outflowsForecast(env, startDate, endDate),
  ]);

  // Aggregate per-day buckets
  const byDay = {};
  const ensure = (date) => byDay[date] = byDay[date] || {
    target_date: date, inflow_invoices: 0, inflow_retail: 0, inflow_other: 0,
    outflow_payroll: 0, outflow_bills: 0, outflow_loan_payments: 0, outflow_sales_tax: 0, outflow_other: 0,
    line_items: [],
  };

  for (const inv of arCollect) {
    const b = ensure(inv.target_date);
    b.inflow_invoices += inv.amount;
    b.line_items.push({ kind: 'ar', amount: inv.amount, detail: inv.detail });
  }
  for (const r of retailIn.forecast) {
    const b = ensure(r.target_date);
    b.inflow_retail += r.amount;
  }
  for (const out of outData.line_items) {
    const b = ensure(out.target_date);
    const k = out.source;
    if (k === 'bill' || k === 'recurring_bill') b.outflow_bills += out.amount;
    else if (k === 'loan_payment') b.outflow_loan_payments += out.amount;
    else if (k === 'sales_tax') b.outflow_sales_tax += out.amount;
    else b.outflow_other += out.amount;
    b.line_items.push({ kind: k, amount: out.amount, detail: out.detail });
  }

  // Apply discretionary daily outflow to every weekday
  for (let i = 0; i < days; i++) {
    const d = addDays(new Date(startDate + 'T00:00:00Z'), i);
    const iso = isoDate(d);
    const dow = d.getUTCDay();
    const scale = (dow === 0 || dow === 6) ? 0.3 : 1.0;
    const b = ensure(iso);
    b.outflow_other -= round2(outData.discretionary_daily * scale);
  }

  // Daily projection timeline
  const timeline = [];
  let balance = cashNow.total;
  for (let i = 0; i <= days; i++) {
    const iso = isoDate(addDays(today, i));
    const b = byDay[iso];
    const inflow = b ? b.inflow_invoices + b.inflow_retail + b.inflow_other : 0;
    const outflow = b ? b.outflow_bills + b.outflow_loan_payments + b.outflow_sales_tax + b.outflow_other + b.outflow_payroll : 0;
    const net = round2(inflow + outflow);  // outflows are already negative
    balance = round2(balance + net);
    timeline.push({
      date: iso,
      opening_balance: round2(balance - net),
      inflow: round2(inflow),
      outflow: round2(outflow),
      net_change: net,
      closing_balance: balance,
      line_items: (b?.line_items) || [],
    });
  }

  // Identify lowest day + days of runway
  let minDay = timeline[0];
  for (const d of timeline) if (d.closing_balance < minDay.closing_balance) minDay = d;
  const endingBalance = timeline[timeline.length - 1].closing_balance;
  const daysTillNegative = timeline.find(d => d.closing_balance < 0);

  // Persist (one row per target date)
  const forecastDate = isoDate(today);
  for (const b of Object.values(byDay)) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO cash_flow_forecast (
        id, forecast_date, target_date,
        inflow_invoices, inflow_retail, inflow_other,
        outflow_payroll, outflow_bills, outflow_loan_payments, outflow_sales_tax, outflow_other,
        net_change, projected_balance, confidence_level
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), forecastDate, b.target_date,
      round2(b.inflow_invoices), round2(b.inflow_retail), round2(b.inflow_other),
      round2(b.outflow_payroll), round2(b.outflow_bills), round2(b.outflow_loan_payments), round2(b.outflow_sales_tax), round2(b.outflow_other),
      round2(b.inflow_invoices + b.inflow_retail + b.inflow_other + b.outflow_payroll + b.outflow_bills + b.outflow_loan_payments + b.outflow_sales_tax + b.outflow_other),
      timeline.find(t => t.date === b.target_date)?.closing_balance || null,
      'medium'
    ).run();
  }

  return {
    generated_at: new Date().toISOString(),
    horizon_days: days,
    cash_now: cashNow,
    ar_forecast: { count: arCollect.length, total: round2(arCollect.reduce((s, r) => s + r.amount, 0)) },
    retail_forecast: { daily_avg: retailIn.daily_avg, total: round2(retailIn.forecast.reduce((s, r) => s + r.amount, 0)) },
    outflow_forecast: {
      line_item_count: outData.line_items.length,
      discretionary_daily: outData.discretionary_daily,
      total_scheduled: round2(outData.line_items.reduce((s, o) => s + o.amount, 0)),
    },
    timeline,
    summary: {
      ending_balance: endingBalance,
      lowest_day: { date: minDay.date, balance: minDay.closing_balance },
      goes_negative: !!daysTillNegative,
      negative_on: daysTillNegative?.date || null,
      projected_net_change: round2(endingBalance - cashNow.total),
    },
  };
}

// ── Read the most recent forecast ─────────────────────────────────────────
export async function getForecast(env, days = DEFAULT_DAYS) {
  const { results } = await env.DB.prepare(`
    SELECT forecast_date, target_date,
           inflow_invoices, inflow_retail, inflow_other,
           outflow_payroll, outflow_bills, outflow_loan_payments, outflow_sales_tax, outflow_other,
           net_change, projected_balance, confidence_level
    FROM cash_flow_forecast
    WHERE forecast_date = (SELECT MAX(forecast_date) FROM cash_flow_forecast)
      AND target_date <= date('now', '+' || ? || ' days')
    ORDER BY target_date
  `).bind(days).all();
  return { forecast_date: results?.[0]?.forecast_date || null, days: results || [] };
}
