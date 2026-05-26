// workers/finance-statements-pnl.js
// Session 21B (May 14 2026) — Complete P&L Statement endpoint.
//
// Replaces QBO as Drew's primary P&L source. Reads from GL only.
//
// Supports:
//   - period: month, quarter, ytd, year, trailing_12, custom
//   - compare_to: prior_period, prior_year, none
//   - format: json (default), csv
//
// Standard P&L structure:
//   Revenue
//     - Sales:Food Income:* sub-accounts
//     - Beverage Income
//     - Apparel, TGTG, Services, Discounts (negative)
//   Cost of Goods Sold
//   Gross Profit (Revenue - COGS)
//   Gross Margin %
//   Operating Expenses (by category)
//   Operating Income
//   Other Income (Tips Income, Credit card rewards, etc.)
//   Other Expenses (Cash Over/Short, etc.)
//   Net Income

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Period resolution ────────────────────────────────────────────────────
// Returns { start, end, label } for a given period spec.
export function resolvePeriod(period, params = {}) {
  const today = params.today ? new Date(params.today) : new Date();
  const tStr = today.toISOString().slice(0, 10);

  if (period === 'custom') {
    if (!params.start || !params.end) {
      throw new Error('custom period requires start + end (YYYY-MM-DD)');
    }
    return { start: params.start, end: params.end, label: `${params.start} → ${params.end}` };
  }

  if (period === 'month') {
    const m = params.month || tStr.slice(0, 7);  // YYYY-MM
    const [y, mo] = m.split('-').map(Number);
    const start = `${m}-01`;
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { start, end: `${m}-${String(lastDay).padStart(2, '0')}`, label: monthLabel(m) };
  }

  if (period === 'quarter') {
    const q = params.quarter;  // 'YYYY-Q1' format
    if (!q || !/^\d{4}-Q[1-4]$/.test(q)) {
      throw new Error('quarter requires format YYYY-Q1');
    }
    const [y, qStr] = q.split('-');
    const qNum = parseInt(qStr.slice(1));
    const startMonth = (qNum - 1) * 3 + 1;
    const endMonth = qNum * 3;
    const start = `${y}-${String(startMonth).padStart(2, '0')}-01`;
    const lastDay = new Date(Date.UTC(parseInt(y), endMonth, 0)).getUTCDate();
    const end = `${y}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end, label: q };
  }

  if (period === 'ytd') {
    const year = params.year || today.getUTCFullYear();
    const start = `${year}-01-01`;
    const end = (year == today.getUTCFullYear()) ? tStr : `${year}-12-31`;
    return { start, end, label: `YTD ${year}` };
  }

  if (period === 'year') {
    const year = params.year || today.getUTCFullYear();
    return { start: `${year}-01-01`, end: `${year}-12-31`, label: `FY ${year}` };
  }

  if (period === 'trailing_12') {
    const endDate = today;
    const startDate = new Date(endDate);
    startDate.setUTCMonth(startDate.getUTCMonth() - 12);
    startDate.setUTCDate(startDate.getUTCDate() + 1);
    return {
      start: startDate.toISOString().slice(0, 10),
      end: endDate.toISOString().slice(0, 10),
      label: `Trailing 12 mo (${startDate.toISOString().slice(0, 10)} → ${tStr})`,
    };
  }

  throw new Error(`unsupported period: ${period}`);
}

function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[parseInt(m) - 1]} ${y}`;
}

// Resolve the comparison period
function resolveComparePeriod(currentPeriod, current, compareTo) {
  if (!compareTo || compareTo === 'none') return null;

  if (compareTo === 'prior_period') {
    // Shift back by the same length
    const startD = new Date(current.start);
    const endD = new Date(current.end);
    const lengthMs = endD - startD;
    const priorEnd = new Date(startD.getTime() - 86400000);  // day before current.start
    const priorStart = new Date(priorEnd.getTime() - lengthMs);
    return {
      start: priorStart.toISOString().slice(0, 10),
      end: priorEnd.toISOString().slice(0, 10),
      label: `Prior period (${priorStart.toISOString().slice(0, 10)} → ${priorEnd.toISOString().slice(0, 10)})`,
    };
  }

  if (compareTo === 'prior_year') {
    // Same window, one year earlier
    const start = new Date(current.start);
    const end = new Date(current.end);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    end.setUTCFullYear(end.getUTCFullYear() - 1);
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
      label: `Prior year (${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)})`,
    };
  }

  return null;
}

// ── Core: read GL data for a period and structure as P&L ─────────────────
// Session 26-D: extended to expose expense_category + revenue_channel sub-groupings
// for Prime Cost, EBITDA, Channel-Adjusted Gross Profit, and Net Revenue subtotals.
async function readPnLData(env, start, end) {
  // Pull all relevant accounts with their balances for the period.
  // Revenue + other_income: credit balance is positive (income)
  // COGS + expense + other_expense: debit balance is positive (cost)
  const { results } = await env.DB.prepare(`
    SELECT c.id as account_id,
           c.account_name,
           c.account_type,
           c.account_subtype,
           c.expense_category,
           c.revenue_channel,
           ROUND(SUM(
             CASE
               WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit
               WHEN c.account_type IN ('cogs','expense','other_expense') THEN l.debit - l.credit
               ELSE 0
             END
           ), 2) as amount,
           COUNT(DISTINCT l.journal_entry_id) as je_count
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.source_type != 'fiscal_year_close'  -- exclude year-end close JEs that zero P&L into RE
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND c.account_type IN ('revenue','cogs','expense','other_expense','other_income')
      AND c.is_active = 1  -- Phase 31-A1 (May 20 2026): suppress deactivated accounts. Migration 067 deactivated old Delivery Fees:* accounts when Phase 26-B reclassed them to Sales:Channel Adjustments:* contra-revenue, but their GL balances persist. Without this filter, marketplace fees show in BOTH contra-revenue AND as negative OpEx, double-presenting $24K of marketplace fee drag and overstating NI.
    GROUP BY c.id
    HAVING amount != 0
    ORDER BY c.account_type, c.account_name
  `).bind(start, end).all();

  const byType = { revenue: [], cogs: [], expense: [], other_income: [], other_expense: [] };
  let totals = { revenue: 0, cogs: 0, expense: 0, other_income: 0, other_expense: 0 };

  // Session 26-D: sub-aggregations
  // Revenue split: gross (non-contra) vs channel adjustments (contra_revenue_marketplace)
  // Expense split: by expense_category; payment_processing pulled out separately
  let revenueGross = 0;       // all revenue lines NOT tagged contra_revenue_marketplace
  let channelAdjustments = 0; // contra_revenue_marketplace lines (DR balance, negative impact)
  const expenseByCategory = {};  // { category: { lines: [], total: 0 } }
  let paymentProcessing = 0;  // expense_category='payment_processing' (pulled out below GP)
  let laborTotal = 0;         // expense_category IN (labor, payroll_taxes, payroll_fees)
  let depreciationOther = 0;  // other_expense w/ expense_category='depreciation'
  let amortizationOther = 0;  // other_expense w/ expense_category='amortization'

  for (const r of results || []) {
    if (byType[r.account_type]) {
      byType[r.account_type].push({
        account_id: r.account_id,
        account_name: r.account_name,
        amount: r.amount,
        je_count: r.je_count,
        expense_category: r.expense_category,
        revenue_channel: r.revenue_channel,
      });
      totals[r.account_type] += r.amount;
    }

    // Revenue sub-split
    if (r.account_type === 'revenue') {
      if (r.revenue_channel === 'contra_revenue_marketplace') {
        channelAdjustments += r.amount;  // amount is already credit-debit; DR on revenue = negative
      } else {
        revenueGross += r.amount;
      }
    }

    // Expense sub-split by category
    if (r.account_type === 'expense') {
      const cat = r.expense_category || 'uncategorized';
      if (!expenseByCategory[cat]) expenseByCategory[cat] = { lines: [], total: 0 };
      expenseByCategory[cat].lines.push({
        account_id: r.account_id,
        account_name: r.account_name,
        amount: r.amount,
        je_count: r.je_count,
      });
      expenseByCategory[cat].total += r.amount;

      // Specific cluster totals
      if (cat === 'payment_processing') paymentProcessing += r.amount;
      if (cat === 'labor' || cat === 'payroll_taxes' || cat === 'payroll_fees') laborTotal += r.amount;
    }

    // Other expense → identify D&A for EBITDA calc
    if (r.account_type === 'other_expense') {
      if (r.expense_category === 'depreciation') depreciationOther += r.amount;
      if (r.expense_category === 'amortization') amortizationOther += r.amount;
    }
  }

  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
  for (const cat of Object.keys(expenseByCategory)) expenseByCategory[cat].total = r2(expenseByCategory[cat].total);
  revenueGross = r2(revenueGross);
  channelAdjustments = r2(channelAdjustments);
  paymentProcessing = r2(paymentProcessing);
  laborTotal = r2(laborTotal);
  depreciationOther = r2(depreciationOther);
  amortizationOther = r2(amortizationOther);

  // Session 26-D: 'revenue' total preserves GROSS revenue (excluding new
  // contra_revenue_marketplace accounts) so it matches QBO bookkeeper truth
  // and the getGLRevenueForPeriod helper. 'net_revenue' is the post-contra
  // ASC 606 view. Existing contra_revenue_retail (Discounts/Comps/Refunds)
  // stays in both gross + net since QBO bookkeeper convention groups it inside revenue.
  totals.revenue = revenueGross;
  const netRevenue = r2(revenueGross + channelAdjustments);  // channelAdj is already negative (DR on revenue acct)
  const grossProfit = r2(netRevenue - totals.cogs);
  const channelAdjustedGrossProfit = r2(grossProfit - paymentProcessing);
  const primeCost = r2(totals.cogs + laborTotal);
  const operatingIncome = r2(grossProfit - totals.expense);
  const netIncome = r2(operatingIncome + totals.other_income - totals.other_expense);
  // EBITDA = Operating Income + D&A (D&A lives in other_expense after Session 26 plan;
  // adding back NORMALIZES for non-cash items below the operating line)
  const ebitda = r2(operatingIncome + depreciationOther + amortizationOther);
  const opexExclPaymentProcessing = r2(totals.expense - paymentProcessing);

  return {
    start, end,
    by_type: byType,
    expense_by_category: expenseByCategory,
    totals: {
      ...totals,
      revenue_gross: revenueGross,
      channel_adjustments: channelAdjustments,
      net_revenue: netRevenue,
      gross_profit: grossProfit,
      gross_margin_pct: netRevenue > 0 ? r2((grossProfit / netRevenue) * 100) : null,
      payment_processing: paymentProcessing,
      channel_adjusted_gross_profit: channelAdjustedGrossProfit,
      channel_adjusted_gross_margin_pct: netRevenue > 0 ? r2((channelAdjustedGrossProfit / netRevenue) * 100) : null,
      labor_total: laborTotal,
      labor_pct_of_revenue: netRevenue > 0 ? r2((laborTotal / netRevenue) * 100) : null,
      prime_cost: primeCost,
      prime_cost_pct_of_revenue: netRevenue > 0 ? r2((primeCost / netRevenue) * 100) : null,
      operating_expense_excl_payment_processing: opexExclPaymentProcessing,
      operating_income: operatingIncome,
      operating_margin_pct: netRevenue > 0 ? r2((operatingIncome / netRevenue) * 100) : null,
      ebitda,
      ebitda_margin_pct: netRevenue > 0 ? r2((ebitda / netRevenue) * 100) : null,
      net_income: netIncome,
      net_margin_pct: netRevenue > 0 ? r2((netIncome / netRevenue) * 100) : null,
    },
  };
}

// ── Main entry: build a full P&L statement ───────────────────────────────
export async function getPnLStatement(env, period, params = {}) {
  const current = resolvePeriod(period, params);
  const comparePeriod = resolveComparePeriod(period, current, params.compare_to);

  const currentData = await readPnLData(env, current.start, current.end);
  const priorData = comparePeriod ? await readPnLData(env, comparePeriod.start, comparePeriod.end) : null;

  // Build comparison-aware structure
  const buildSection = (typeKey, label) => {
    const currentItems = currentData.by_type[typeKey] || [];
    const priorItems = priorData?.by_type[typeKey] || [];
    const allNames = new Set([
      ...currentItems.map(i => i.account_name),
      ...priorItems.map(i => i.account_name),
    ]);
    const lines = Array.from(allNames).map(name => {
      const cur = currentItems.find(i => i.account_name === name);
      const pri = priorItems.find(i => i.account_name === name);
      const curAmt = cur?.amount || 0;
      const priAmt = pri?.amount || 0;
      const variance = r2(curAmt - priAmt);
      const variancePct = priAmt !== 0 ? r2((variance / Math.abs(priAmt)) * 100) : null;
      return {
        account_name: name,
        account_id: cur?.account_id || pri?.account_id,
        current: curAmt,
        prior: priorData ? priAmt : null,
        variance: priorData ? variance : null,
        variance_pct: priorData ? variancePct : null,
        je_count: cur?.je_count || 0,
      };
    }).sort((a, b) => Math.abs(b.current) - Math.abs(a.current));

    return { label, lines };
  };

  // Session 27 fix: build revenue section with contra-revenue lines REMOVED.
  // The contra_revenue_marketplace lines (Sales:Channel Adjustments:*) live in
  // their own section below so the Revenue section foots cleanly to revenue_gross.
  // Round-2 footing defect fix: previously sections.revenue.lines included
  // contras → CSV "Total Revenue" line ($522,889) didn't match section line sum
  // ($497,582) → internal contradiction.
  const buildRevenueFiltered = () => {
    const baseSection = buildSection('revenue', 'Revenue');
    const curContraNames = new Set((currentData.by_type.revenue || [])
      .filter(i => i.revenue_channel === 'contra_revenue_marketplace')
      .map(i => i.account_name));
    const priContraNames = new Set((priorData?.by_type?.revenue || [])
      .filter(i => i.revenue_channel === 'contra_revenue_marketplace')
      .map(i => i.account_name));
    return {
      label: 'Revenue',
      lines: baseSection.lines.filter(l => !curContraNames.has(l.account_name) && !priContraNames.has(l.account_name)),
    };
  };

  const sections = {
    revenue: buildRevenueFiltered(),
    cogs: buildSection('cogs', 'Cost of Goods Sold'),
    expense: buildSection('expense', 'Operating Expenses'),
    other_income: buildSection('other_income', 'Other Income'),
    other_expense: buildSection('other_expense', 'Other Expenses'),
  };

  // Build channel_adjustments section — contra_revenue_marketplace lines lifted
  // out of revenue. Sum of these lines = totals.channel_adjustments (negative).
  // Revenue + Channel Adjustments = Net Revenue.
  const buildChannelAdjustments = () => {
    // Build a complete unfiltered revenue section to pick contras from
    const fullRevenueSection = buildSection('revenue', 'Revenue');
    const allLines = fullRevenueSection.lines || [];
    const curItems = (currentData.by_type.revenue || []).filter(i => i.revenue_channel === 'contra_revenue_marketplace');
    const priItems = (priorData?.by_type?.revenue || []).filter(i => i.revenue_channel === 'contra_revenue_marketplace');
    const names = new Set([...curItems.map(i => i.account_name), ...priItems.map(i => i.account_name)]);
    const lines = Array.from(names).map(name => allLines.find(l => l.account_name === name)).filter(Boolean);
    return { label: 'Channel Adjustments (ASC 606 contra-revenue)', lines };
  };
  sections.channel_adjustments = buildChannelAdjustments();

  // Build payment_processing section (subset of expense tagged payment_processing)
  const buildPaymentProcessing = () => {
    const allLines = sections.expense.lines || [];
    const curItems = (currentData.by_type.expense || []).filter(i => i.expense_category === 'payment_processing');
    const priItems = (priorData?.by_type?.expense || []).filter(i => i.expense_category === 'payment_processing');
    const names = new Set([...curItems.map(i => i.account_name), ...priItems.map(i => i.account_name)]);
    const lines = Array.from(names).map(name => allLines.find(l => l.account_name === name)).filter(Boolean);
    return { label: 'Payment Processing', lines };
  };
  sections.payment_processing = buildPaymentProcessing();

  // Build expense_by_category — group operating expenses by expense_category for sub-totals
  const expenseCategoryLabels = {
    labor: 'Labor',
    payroll_taxes: 'Payroll Taxes',
    payroll_fees: 'Payroll Service Fees',
    occupancy: 'Occupancy (Rent, Utilities, Insurance, Repairs)',
    marketing: 'Marketing & Advertising',
    payment_processing: 'Payment Processing',
    software: 'Software & Subscriptions',
    professional_services: 'Professional Services (Legal, Accounting)',
    interest: 'Interest Paid',
    taxes_penalties: 'Taxes & Permits',
    other_opex: 'Other Operating Expenses',
    channel_fees_pending_reclass: 'Channel Fees (pending reclass)',
    channel_fees_inactive_replaced: 'Channel Fees (inactive, replaced by contra-revenue)',
    uncategorized: 'Uncategorized',
  };
  const buildExpenseByCategory = () => {
    const out = {};
    const curCats = currentData.expense_by_category || {};
    const priCats = priorData?.expense_by_category || {};
    const allCats = new Set([...Object.keys(curCats), ...Object.keys(priCats)]);
    for (const cat of allCats) {
      const allLines = sections.expense.lines || [];
      const curAccountNames = new Set((curCats[cat]?.lines || []).map(l => l.account_name));
      const priAccountNames = new Set((priCats[cat]?.lines || []).map(l => l.account_name));
      const names = new Set([...curAccountNames, ...priAccountNames]);
      const lines = Array.from(names).map(name => allLines.find(l => l.account_name === name)).filter(Boolean);
      const curTotal = curCats[cat]?.total || 0;
      const priTotal = priCats[cat]?.total || 0;
      const variance = priorData ? r2(curTotal - priTotal) : null;
      const variancePct = priorData && priTotal !== 0 ? r2((variance / Math.abs(priTotal)) * 100) : null;
      out[cat] = {
        label: expenseCategoryLabels[cat] || cat,
        lines,
        total: { current: curTotal, prior: priorData ? priTotal : null, variance, variance_pct: variancePct },
      };
    }
    return out;
  };
  sections.expense_by_category = buildExpenseByCategory();

  // Subtotals + key calculated lines
  const buildTotal = (key, label) => {
    const cur = currentData.totals[key];
    const pri = priorData?.totals?.[key];
    const variance = priorData ? r2(cur - pri) : null;
    const variancePct = priorData && pri !== 0 ? r2((variance / Math.abs(pri)) * 100) : null;
    return { label, current: cur, prior: priorData ? pri : null, variance, variance_pct: variancePct };
  };

  return {
    ok: true,
    period_label: current.label,
    period_start: current.start,
    period_end: current.end,
    compare_label: comparePeriod?.label || null,
    compare_start: comparePeriod?.start || null,
    compare_end: comparePeriod?.end || null,
    sections,
    totals: {
      // Revenue split (NEW in Session 26-D)
      revenue_gross: buildTotal('revenue_gross', 'Gross Revenue'),
      channel_adjustments: buildTotal('channel_adjustments', 'Channel Adjustments'),
      net_revenue: buildTotal('net_revenue', 'Net Revenue (ASC 606)'),
      // Backward-compat: legacy 'revenue' key still returned with GROSS value
      // (matches QBO bookkeeper truth + getGLRevenueForPeriod). 'net_revenue' is
      // the post-contra-marketplace view.
      revenue: buildTotal('revenue', 'Total Revenue'),
      // Gross profit chain
      cogs: buildTotal('cogs', 'Total COGS'),
      gross_profit: buildTotal('gross_profit', 'Gross Profit'),
      gross_margin_pct: { label: 'Gross Margin %', current: currentData.totals.gross_margin_pct, prior: priorData?.totals?.gross_margin_pct ?? null },
      // NEW: Payment Processing + Channel-Adjusted GP
      payment_processing: buildTotal('payment_processing', 'Payment Processing'),
      channel_adjusted_gross_profit: buildTotal('channel_adjusted_gross_profit', 'Channel-Adjusted Gross Profit'),
      channel_adjusted_gross_margin_pct: { label: 'Channel-Adj GM %', current: currentData.totals.channel_adjusted_gross_margin_pct, prior: priorData?.totals?.channel_adjusted_gross_margin_pct ?? null },
      // NEW: Labor + Prime Cost
      labor_total: buildTotal('labor_total', 'Total Labor (incl. payroll tax/fees)'),
      labor_pct_of_revenue: { label: 'Labor % of Revenue', current: currentData.totals.labor_pct_of_revenue, prior: priorData?.totals?.labor_pct_of_revenue ?? null },
      prime_cost: buildTotal('prime_cost', 'Prime Cost (COGS + Labor)'),
      prime_cost_pct_of_revenue: { label: 'Prime Cost % of Revenue', current: currentData.totals.prime_cost_pct_of_revenue, prior: priorData?.totals?.prime_cost_pct_of_revenue ?? null },
      // OpEx + Operating Income
      operating_expense_excl_payment_processing: buildTotal('operating_expense_excl_payment_processing', 'Operating Expenses (excl. Payment Processing)'),
      expense: buildTotal('expense', 'Total Operating Expenses (incl. Payment Processing)'),
      operating_income: buildTotal('operating_income', 'Operating Income'),
      operating_margin_pct: { label: 'Operating Margin %', current: currentData.totals.operating_margin_pct, prior: priorData?.totals?.operating_margin_pct ?? null },
      // NEW: EBITDA (Operating Income + D&A)
      ebitda: buildTotal('ebitda', 'EBITDA'),
      ebitda_margin_pct: { label: 'EBITDA Margin %', current: currentData.totals.ebitda_margin_pct, prior: priorData?.totals?.ebitda_margin_pct ?? null },
      // Other + Net
      other_income: buildTotal('other_income', 'Total Other Income'),
      other_expense: buildTotal('other_expense', 'Total Other Expenses'),
      net_income: buildTotal('net_income', 'Net Income'),
      net_margin_pct: { label: 'Net Margin %', current: currentData.totals.net_margin_pct, prior: priorData?.totals?.net_margin_pct ?? null },
    },
    source: 'gl_reconstruction (Session 20+) + OB 2024-12-31 (Session 21-pre) + Channel Adj reclass (Session 26-B)',
    accounting_basis: 'cash',
  };
}

// ── CSV export ─────────────────────────────────────────────────────────────
export function pnlToCsv(statement) {
  const lines = [];
  lines.push(`Pretzel OS — Profit & Loss Statement`);
  lines.push(`Period: ${statement.period_label} (${statement.period_start} → ${statement.period_end})`);
  if (statement.compare_label) lines.push(`Compared to: ${statement.compare_label}`);
  lines.push(`Basis: ${statement.accounting_basis}`);
  lines.push('');
  const hasCompare = !!statement.compare_label;
  const header = hasCompare
    ? 'Account,Current,Prior,Variance,Variance %'
    : 'Account,Amount';
  lines.push(header);

  const fmt = (n) => n == null ? '' : n.toFixed(2);
  const writeLine = (label, total) => {
    if (hasCompare) {
      lines.push(`"${label}",${fmt(total.current)},${fmt(total.prior)},${fmt(total.variance)},${fmt(total.variance_pct)}`);
    } else {
      lines.push(`"${label}",${fmt(total.current)}`);
    }
  };

  const writeSection = (section) => {
    lines.push(`"--- ${section.label} ---"`);
    for (const line of section.lines) {
      writeLine(line.account_name, { current: line.current, prior: line.prior, variance: line.variance, variance_pct: line.variance_pct });
    }
  };

  // Session 27 fix: Revenue section emits non-contra revenue only.
  // Channel Adjustments section emits contras separately.
  // CSV now foots: Revenue lines sum to revenue_gross; Channel Adj lines sum
  // to channel_adjustments; Net Revenue = sum of both. Gross Profit derived
  // from Net Revenue, not Total Revenue (ASC 606 convention).
  writeSection(statement.sections.revenue);
  writeLine(statement.totals.revenue_gross.label, statement.totals.revenue_gross);
  lines.push('');
  if (statement.sections.channel_adjustments && statement.sections.channel_adjustments.lines.length > 0) {
    writeSection(statement.sections.channel_adjustments);
    writeLine(statement.totals.channel_adjustments.label, statement.totals.channel_adjustments);
    lines.push('');
  }
  writeLine(statement.totals.net_revenue.label, statement.totals.net_revenue);
  lines.push('');
  writeSection(statement.sections.cogs);
  writeLine(statement.totals.cogs.label, statement.totals.cogs);
  lines.push('');
  writeLine(statement.totals.gross_profit.label, statement.totals.gross_profit);
  if (statement.totals.gross_margin_pct.current != null) {
    writeLine('Gross Margin %', { current: statement.totals.gross_margin_pct.current, prior: statement.totals.gross_margin_pct.prior, variance: null, variance_pct: null });
  }
  lines.push('');
  if (statement.totals.payment_processing && statement.totals.payment_processing.current > 0) {
    writeLine(statement.totals.payment_processing.label, statement.totals.payment_processing);
    writeLine(statement.totals.channel_adjusted_gross_profit.label, statement.totals.channel_adjusted_gross_profit);
    if (statement.totals.channel_adjusted_gross_margin_pct.current != null) {
      writeLine('Channel-Adjusted GM %', { current: statement.totals.channel_adjusted_gross_margin_pct.current, prior: statement.totals.channel_adjusted_gross_margin_pct.prior, variance: null, variance_pct: null });
    }
    lines.push('');
  }
  writeSection(statement.sections.expense);
  writeLine(statement.totals.expense.label, statement.totals.expense);
  lines.push('');
  if (statement.totals.labor_total && statement.totals.labor_total.current > 0) {
    writeLine(statement.totals.labor_total.label, statement.totals.labor_total);
    writeLine(statement.totals.prime_cost.label, statement.totals.prime_cost);
    if (statement.totals.prime_cost_pct_of_revenue.current != null) {
      writeLine('Prime Cost % of Revenue', { current: statement.totals.prime_cost_pct_of_revenue.current, prior: statement.totals.prime_cost_pct_of_revenue.prior, variance: null, variance_pct: null });
    }
    lines.push('');
  }
  writeLine(statement.totals.operating_income.label, statement.totals.operating_income);
  if (statement.totals.operating_margin_pct.current != null) {
    writeLine('Operating Margin %', { current: statement.totals.operating_margin_pct.current, prior: statement.totals.operating_margin_pct.prior, variance: null, variance_pct: null });
  }
  if (statement.totals.ebitda && (statement.totals.ebitda.current !== 0)) {
    writeLine(statement.totals.ebitda.label, statement.totals.ebitda);
    if (statement.totals.ebitda_margin_pct.current != null) {
      writeLine('EBITDA Margin %', { current: statement.totals.ebitda_margin_pct.current, prior: statement.totals.ebitda_margin_pct.prior, variance: null, variance_pct: null });
    }
  }
  lines.push('');
  if (statement.sections.other_income.lines.length > 0) {
    writeSection(statement.sections.other_income);
    writeLine(statement.totals.other_income.label, statement.totals.other_income);
    lines.push('');
  }
  if (statement.sections.other_expense.lines.length > 0) {
    writeSection(statement.sections.other_expense);
    writeLine(statement.totals.other_expense.label, statement.totals.other_expense);
    lines.push('');
  }
  writeLine(statement.totals.net_income.label, statement.totals.net_income);
  if (statement.totals.net_margin_pct.current != null) {
    writeLine('Net Margin %', { current: statement.totals.net_margin_pct.current, prior: statement.totals.net_margin_pct.prior, variance: null, variance_pct: null });
  }

  return lines.join('\n');
}

// ── Drill-down: per-line P&L explanation ─────────────────────────────────
// Returns the actual JE lines that built a given account's balance for a period.
export async function explainPnLLine(env, accountId, start, end) {
  const account = await env.DB.prepare(
    `SELECT id, account_name, account_type FROM chart_of_accounts WHERE id = ?`
  ).bind(accountId).first();
  if (!account) return { ok: false, error: 'account_not_found' };

  const { results } = await env.DB.prepare(`
    SELECT j.id as je_id,
           j.entry_date,
           j.description,
           j.source_type,
           l.debit,
           l.credit,
           l.memo
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    WHERE j.status = 'posted'
      AND l.account_id = ?
      AND j.entry_date >= ? AND j.entry_date <= ?
    ORDER BY j.entry_date, j.id
  `).bind(accountId, start, end).all();

  const debitTotal = (results || []).reduce((s, r) => s + (r.debit || 0), 0);
  const creditTotal = (results || []).reduce((s, r) => s + (r.credit || 0), 0);
  // For revenue/other_income: credit positive
  // For cogs/expense/other_expense: debit positive
  const balance = ['revenue', 'other_income'].includes(account.account_type)
    ? r2(creditTotal - debitTotal)
    : r2(debitTotal - creditTotal);

  return {
    ok: true,
    account: account.account_name,
    account_type: account.account_type,
    period_start: start,
    period_end: end,
    balance,
    je_count: results?.length || 0,
    lines: results || [],
  };
}
