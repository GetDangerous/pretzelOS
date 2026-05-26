// workers/finance-breakeven.js
// Break-even calculator — answers Drew's "how close are we to breakeven?"
//
// Method:
//   1. Trailing 90d monthly revenue (canonical, all channels including marketplace)
//   2. Fixed monthly costs (rent + payroll + loans + insurance + software + recurring SaaS)
//   3. Variable cost % (COGS + processing fees + marketplace fees + delivery fees) / revenue
//   4. Contribution margin = 1 - variable_cost_pct
//   5. break_even_revenue = fixed_costs / contribution_margin
//   6. Gap to breakeven (current trailing 3mo avg - breakeven) and paths to close it
//
// Endpoint: GET /finance/breakeven

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function r0(n) { return Math.round(n || 0); }
function pct(n) { return Math.round(n * 1000) / 10; }

// Account name patterns we treat as "fixed" vs "variable" expenses
const FIXED_PATTERNS = [
  /^Rent$/i,
  /^Payroll/i,
  /^Lease Expense/i,
  /^Interest paid/i,                // loan interest
  /^Insurance/i,
  /^Software & apps/i,
  /^Bank fees/i,
  /^Internet & telephone/i,
  /^Utilities/i,
];
const VARIABLE_PATTERNS = [
  /Food Purchases/i,
  /Beer Purchases/i,
  /Beverage Purchases/i,
  /Paper Packaging/i,
  /Restaurant Supplies/i,
  /^Cost of goods sold/i,
  /Processing fees/i,
  /Marketplace/i,
  /Delivery Fees/i,
];

function classifyExpense(accountName) {
  if (!accountName) return 'unclassified';
  for (const p of FIXED_PATTERNS) if (p.test(accountName)) return 'fixed';
  for (const p of VARIABLE_PATTERNS) if (p.test(accountName)) return 'variable';
  return 'other';
}

export async function getBreakeven(env, opts = {}) {
  const lookbackDays = opts.lookback_days || 90;

  // 1. Trailing N-day revenue from posted JEs (revenue + other_income accounts)
  const revRow = await env.DB.prepare(`
    SELECT ROUND(SUM(l.credit - l.debit), 2) as revenue
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND c.account_type IN ('revenue', 'other_income')
      AND j.entry_date >= date('now', '-' || ? || ' days')
  `).bind(lookbackDays).first();
  const trailing_revenue = r2(revRow?.revenue || 0);
  const monthly_revenue = r2(trailing_revenue / (lookbackDays / 30.0));

  // 2. Expense breakdown by account over same window
  const { results: expenseRows } = await env.DB.prepare(`
    SELECT c.account_name, c.account_type,
           ROUND(SUM(l.debit - l.credit), 2) as amount
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND c.account_type IN ('expense', 'cogs', 'other_expense')
      AND j.entry_date >= date('now', '-' || ? || ' days')
    GROUP BY c.id
    HAVING amount > 0
    ORDER BY amount DESC
  `).bind(lookbackDays).all();

  const fixed_items = [];
  const variable_items = [];
  const other_items = [];

  for (const row of (expenseRows || [])) {
    const monthly = r2(row.amount / (lookbackDays / 30.0));
    const kind = classifyExpense(row.account_name);
    const item = { account_name: row.account_name, account_type: row.account_type, trailing_amount: r2(row.amount), monthly_avg: monthly, kind };
    if (kind === 'fixed') fixed_items.push(item);
    else if (kind === 'variable') variable_items.push(item);
    else other_items.push(item);
  }

  // 3. Aggregate
  const fixed_monthly = r2(fixed_items.reduce((s, i) => s + i.monthly_avg, 0));
  const variable_monthly = r2(variable_items.reduce((s, i) => s + i.monthly_avg, 0));
  const other_monthly = r2(other_items.reduce((s, i) => s + i.monthly_avg, 0));

  // Mercury-side fallback for fixed costs the GL hasn't captured yet
  // (we know payroll is being undercounted because Square Payroll txns are still
  // landing as "other" until KB hits them). Use Mercury outflow-by-counterparty.
  const mercuryFallback = await mercuryFallbackFixed(env, lookbackDays);

  const fixed_with_fallback = r2(Math.max(fixed_monthly, mercuryFallback.estimated_monthly_fixed));

  const variable_cost_pct = monthly_revenue > 0 ? variable_monthly / monthly_revenue : 0;
  const contribution_margin = 1 - variable_cost_pct;
  const breakeven_revenue = contribution_margin > 0 ? r2(fixed_with_fallback / contribution_margin) : null;
  const gap = breakeven_revenue != null ? r2(breakeven_revenue - monthly_revenue) : null;
  const gap_pct = breakeven_revenue && monthly_revenue ? pct(gap / monthly_revenue) : null;

  // Session 16b (May 14 2026): data-quality gate.
  // If month-over-month COGS% volatility in the trailing window is >10pp,
  // the trailing-90d average is masking a regime change (e.g., RTR-2
  // April-under-counted vs May-correct). Switch to range-mode output and
  // mark confidence as low.
  const cogsVolatility = await detectCogsVolatility(env, lookbackDays);
  let confidence = 'high';
  let gap_low_estimate = gap;
  let gap_high_estimate = gap;
  if (cogsVolatility.max_delta_pp > 10) {
    confidence = 'low';
    // When COGS data is volatile, the variable_cost_pct could be off by the
    // delta. Recompute the breakeven under both extremes (low COGS estimate +
    // high COGS estimate) and show the gap range.
    const stable_cogs_pct = cogsVolatility.most_recent_clean_month_cogs_pct;
    if (stable_cogs_pct != null && stable_cogs_pct > variable_cost_pct) {
      const corrected_cm = 1 - stable_cogs_pct - 0.05;  // +5pp processing/marketplace fee buffer
      const corrected_be = corrected_cm > 0 ? r2(fixed_with_fallback / corrected_cm) : null;
      gap_high_estimate = corrected_be != null ? r2(corrected_be - monthly_revenue) : null;
      gap_low_estimate = gap;  // current (rosy) estimate
    }
  }

  // 4. Paths to close the gap (top 3 ranked by feasibility)
  const paths = [];
  if (gap != null && gap > 0) {
    // Path A: add wholesale revenue
    const wholesale_cogs_pct = 0.30;  // typical B2B
    const wholesale_needed = r2(gap / (1 - wholesale_cogs_pct));
    paths.push({
      lever: 'add_wholesale_revenue',
      headline: `Add $${r0(wholesale_needed).toLocaleString()}/mo wholesale at ~30% COGS`,
      monthly_revenue_required: wholesale_needed,
      monthly_net_added: gap,
      detail: 'Closes the gap. ~3-5 new wholesale accounts at $1.5-2K each.',
    });
    // Path B: cut payroll
    const payroll_item = fixed_items.find(i => /payroll/i.test(i.account_name));
    if (payroll_item && payroll_item.monthly_avg > gap) {
      paths.push({
        lever: 'reduce_payroll',
        headline: `Reduce payroll by $${r0(gap).toLocaleString()}/mo (${pct(gap / payroll_item.monthly_avg)}% of current)`,
        monthly_payroll_now: payroll_item.monthly_avg,
        monthly_payroll_target: r2(payroll_item.monthly_avg - gap),
        detail: 'Direct equivalent to revenue at current margins.',
      });
    }
    // Path C: improve COGS
    const cogs_items = variable_items.filter(i => /Food Purchases|Cost of goods sold/i.test(i.account_name));
    if (cogs_items.length) {
      const cogs_monthly = r2(cogs_items.reduce((s, i) => s + i.monthly_avg, 0));
      const cogs_pct_now = monthly_revenue > 0 ? cogs_monthly / monthly_revenue : 0;
      // Need to reduce COGS by $gap/mo while holding revenue → cogs reduction $
      const cogs_savings_needed = gap;
      const cogs_pct_reduction_needed = monthly_revenue > 0 ? cogs_savings_needed / monthly_revenue : 0;
      paths.push({
        lever: 'improve_cogs',
        headline: `Drop COGS% from ${pct(cogs_pct_now)}% → ${pct(cogs_pct_now - cogs_pct_reduction_needed)}%`,
        cogs_pct_now: pct(cogs_pct_now),
        cogs_pct_target: pct(cogs_pct_now - cogs_pct_reduction_needed),
        monthly_savings_needed: cogs_savings_needed,
        detail: 'Hardest path — requires vendor negotiation, recipe optimization, or yield improvement.',
      });
    }
  }

  return {
    period_days: lookbackDays,
    monthly_revenue,
    fixed_monthly_costs: fixed_with_fallback,
    fixed_breakdown: fixed_items.slice(0, 10),
    mercury_fallback_used: fixed_with_fallback > fixed_monthly,
    mercury_fallback_added: r2(fixed_with_fallback - fixed_monthly),
    variable_monthly_costs: variable_monthly,
    variable_cost_pct: pct(variable_cost_pct),
    contribution_margin_pct: pct(contribution_margin),
    breakeven_revenue,
    current_monthly_revenue: monthly_revenue,
    gap_to_breakeven: gap,
    gap_pct,
    at_breakeven: gap != null && gap <= 0,
    // Session 16b: confidence + range
    confidence,
    gap_low_estimate,
    gap_high_estimate,
    cogs_volatility_pp: cogsVolatility.max_delta_pp,
    cogs_volatility_note: cogsVolatility.note,
    paths_to_close: paths,
    other_expenses_monthly: other_monthly,
    note: 'Fixed = rent+payroll+loans+insurance+SaaS. Variable = COGS+fees+marketplace+delivery. Other = uncategorized; may include catch-up payments distorting the picture.',
    other_expense_items: other_items.slice(0, 10),
  };
}

// Session 16b — data-quality gate. Computes per-month COGS% over the trailing
// window and returns the max month-over-month delta in percentage points.
// If >10pp delta, the trailing-window CM is unreliable (regime change).
async function detectCogsVolatility(env, lookbackDays) {
  const { results } = await env.DB.prepare(`
    SELECT SUBSTR(j.entry_date, 1, 7) as month,
           ROUND(SUM(CASE WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit ELSE 0 END), 2) as revenue,
           ROUND(SUM(CASE WHEN c.account_type = 'cogs' THEN l.debit - l.credit ELSE 0 END), 2) as cogs
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= date('now', '-' || ? || ' days')
    GROUP BY month
    ORDER BY month
  `).bind(lookbackDays).all();

  const monthly = (results || []).map(r => {
    const rev = r.revenue || 0;
    const cogs = r.cogs || 0;
    return {
      month: r.month,
      cogs_pct: rev > 0 ? cogs / rev : null,
    };
  }).filter(m => m.cogs_pct != null);

  if (monthly.length < 2) {
    return { max_delta_pp: 0, note: 'Insufficient months to assess volatility', most_recent_clean_month_cogs_pct: null };
  }

  // Compute max month-over-month delta (in percentage points)
  let max_delta = 0;
  let max_delta_pair = null;
  for (let i = 1; i < monthly.length; i++) {
    const delta = Math.abs(monthly[i].cogs_pct - monthly[i-1].cogs_pct) * 100;
    if (delta > max_delta) {
      max_delta = delta;
      max_delta_pair = `${monthly[i-1].month} (${(monthly[i-1].cogs_pct*100).toFixed(1)}%) → ${monthly[i].month} (${(monthly[i].cogs_pct*100).toFixed(1)}%)`;
    }
  }

  // For the "clean" reference, take the most recent month's COGS%
  // (assuming it's the most accurate / most reflective of current state)
  const most_recent = monthly[monthly.length - 1];

  return {
    max_delta_pp: Math.round(max_delta * 10) / 10,
    max_delta_pair,
    monthly_cogs_pct: monthly.map(m => ({ month: m.month, cogs_pct: r2(m.cogs_pct * 100) })),
    most_recent_clean_month_cogs_pct: most_recent.cogs_pct,
    note: max_delta > 10
      ? `COGS% varies ${max_delta.toFixed(1)}pp across trailing months (${max_delta_pair}). Likely data quality issue (RTR-2 catch-up). Breakeven gap shown as range.`
      : `COGS% stable (max delta ${max_delta.toFixed(1)}pp). Breakeven gap is precise.`,
  };
}

// Mercury fallback — for fixed costs the GL hasn't captured (payroll cutover, etc.)
async function mercuryFallbackFixed(env, lookbackDays) {
  const { results } = await env.DB.prepare(`
    SELECT counterparty_name, ROUND(SUM(ABS(amount)), 2) as total
    FROM mercury_transactions
    WHERE amount < 0 AND txn_date >= date('now', '-' || ? || ' days')
      AND LOWER(counterparty_name) NOT LIKE '%mercury%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
      AND LOWER(counterparty_name) NOT LIKE '%chase%'
      AND (
        LOWER(counterparty_name) LIKE '%payroll%' OR
        LOWER(counterparty_name) LIKE '%square inc%' OR
        LOWER(counterparty_name) LIKE '%bb billboard%' OR
        LOWER(counterparty_name) LIKE '%lease services%' OR
        LOWER(counterparty_name) LIKE '%insurance%' OR
        LOWER(counterparty_name) LIKE '%selective%' OR
        LOWER(counterparty_name) LIKE '%travelers%' OR
        LOWER(counterparty_name) LIKE '%leaf%'
      )
    GROUP BY counterparty_name
    ORDER BY total DESC
  `).bind(lookbackDays).all();

  const monthly_factor = 30.0 / lookbackDays;
  const items = (results || []).map(r => ({
    counterparty: r.counterparty_name,
    trailing_total: r2(r.total),
    monthly_estimate: r2(r.total * monthly_factor),
  }));
  const estimated_monthly_fixed = r2(items.reduce((s, i) => s + i.monthly_estimate, 0));
  return { estimated_monthly_fixed, items };
}
