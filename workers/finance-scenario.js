// workers/finance-scenario.js
// Scenario engine — "what-if" calculator.
//
// Inputs:
//   revenue_delta: { retail: 0, wholesale: 5000, catering: 0 }  (monthly $ added)
//   expense_delta: { payroll: -1000, cogs_pct_change: -0.02 }   (monthly $ delta + ratio shift)
//   one_time: [{ amount: 5000, description: 'new equipment', month: '2026-06' }]
//   horizon_months: 6
//
// Outputs:
//   projected monthly P&L for next N months
//   projected ending cash position each month
//   compared to baseline (do-nothing)
//   new breakeven date under scenario
//
// Endpoint: POST /finance/scenario

import { getBreakeven } from './finance-breakeven.js';
import { getCanonicalCashOnHand } from './finance-shared.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// Channel-specific COGS assumptions (for revenue_delta routing)
const CHANNEL_COGS_PCT = {
  retail:      0.35,   // typical fast-casual food cost on POS
  wholesale:   0.30,   // B2B has better margins
  catering:    0.40,   // higher COGS (labor + delivery embedded)
  marketplace: 0.50,   // marketplace fees eat margin (DoorDash/UberEats)
};

export async function runScenario(env, body = {}) {
  const revenue_delta = body.revenue_delta || {};
  const expense_delta = body.expense_delta || {};
  const one_time = body.one_time || [];
  const horizon = Math.min(body.horizon_months || 6, 24);

  // 1. Get current state via breakeven calc (gives us baseline monthly numbers)
  const be = await getBreakeven(env, { lookback_days: 90 });
  const cash = await getCanonicalCashOnHand(env);

  const baseline = {
    revenue: be.current_monthly_revenue || 0,
    fixed_costs: be.fixed_monthly_costs || 0,
    variable_pct: (be.variable_cost_pct || 0) / 100,
    contribution_margin: 1 - ((be.variable_cost_pct || 0) / 100),
    starting_cash: cash.total || 0,
  };
  const baseline_monthly_net = r2(baseline.revenue - (baseline.revenue * baseline.variable_pct) - baseline.fixed_costs);

  // 2. Compute scenario monthly figures
  const new_revenue = r2(baseline.revenue +
    (revenue_delta.retail || 0) +
    (revenue_delta.wholesale || 0) +
    (revenue_delta.catering || 0) +
    (revenue_delta.marketplace || 0));

  // Variable cost from existing revenue at OLD pct, plus new revenue at channel-specific pct
  const incremental_variable =
    (revenue_delta.retail || 0)      * (CHANNEL_COGS_PCT.retail) +
    (revenue_delta.wholesale || 0)   * (CHANNEL_COGS_PCT.wholesale) +
    (revenue_delta.catering || 0)    * (CHANNEL_COGS_PCT.catering) +
    (revenue_delta.marketplace || 0) * (CHANNEL_COGS_PCT.marketplace);

  // Apply COGS pct change to existing revenue base
  const cogs_pct_shift = expense_delta.cogs_pct_change || 0;
  const adjusted_baseline_variable = baseline.revenue * (baseline.variable_pct + cogs_pct_shift);

  const new_variable = r2(Math.max(0, adjusted_baseline_variable + incremental_variable));

  // Fixed costs adjusted by expense_delta
  const new_fixed = r2(baseline.fixed_costs +
    (expense_delta.payroll || 0) +
    (expense_delta.rent || 0) +
    (expense_delta.fixed_other || 0));

  const new_monthly_net = r2(new_revenue - new_variable - new_fixed);

  // 3. Build month-by-month projection
  const today = new Date();
  const projections = [];
  let running_cash = baseline.starting_cash;
  let running_cash_baseline = baseline.starting_cash;

  for (let m = 0; m < horizon; m++) {
    const projDate = new Date(today.getFullYear(), today.getMonth() + m, 1);
    const monthLabel = `${projDate.getFullYear()}-${String(projDate.getMonth() + 1).padStart(2, '0')}`;

    // One-time hits this month
    const monthOnetime = one_time
      .filter(o => o.month === monthLabel)
      .reduce((s, o) => s + (o.amount || 0), 0);

    running_cash = r2(running_cash + new_monthly_net - monthOnetime);
    running_cash_baseline = r2(running_cash_baseline + baseline_monthly_net);

    projections.push({
      month: monthLabel,
      revenue: new_revenue,
      variable_cost: new_variable,
      fixed_cost: new_fixed,
      one_time_hit: r2(monthOnetime),
      monthly_net: new_monthly_net,
      ending_cash: running_cash,
      baseline_ending_cash: running_cash_baseline,
      improvement_vs_baseline: r2(running_cash - running_cash_baseline),
    });
  }

  // 4. New breakeven check
  const new_breakeven_revenue = (1 - baseline.variable_pct - cogs_pct_shift) > 0
    ? r2(new_fixed / (1 - baseline.variable_pct - cogs_pct_shift))
    : null;
  const new_gap = new_breakeven_revenue != null ? r2(new_breakeven_revenue - new_revenue) : null;
  const at_breakeven_under_scenario = new_gap != null && new_gap <= 0;

  // 5. Runway under scenario
  const monthly_burn = new_monthly_net < 0 ? Math.abs(new_monthly_net) : 0;
  const runway_months = monthly_burn > 0 ? r2(baseline.starting_cash / monthly_burn) : null;

  return {
    baseline: {
      monthly_revenue: baseline.revenue,
      monthly_net: baseline_monthly_net,
      breakeven_revenue: be.breakeven_revenue,
      gap_to_breakeven: be.gap_to_breakeven,
    },
    scenario: {
      monthly_revenue: new_revenue,
      monthly_variable_cost: new_variable,
      monthly_fixed_cost: new_fixed,
      monthly_net: new_monthly_net,
      new_breakeven_revenue,
      new_gap_to_breakeven: new_gap,
      at_breakeven: at_breakeven_under_scenario,
      runway_months,
    },
    inputs: { revenue_delta, expense_delta, one_time, horizon_months: horizon },
    projections,
    summary: {
      starting_cash: baseline.starting_cash,
      ending_cash_under_scenario: projections.length ? projections[projections.length - 1].ending_cash : baseline.starting_cash,
      ending_cash_baseline:       projections.length ? projections[projections.length - 1].baseline_ending_cash : baseline.starting_cash,
      improvement_vs_baseline:    projections.length ? projections[projections.length - 1].improvement_vs_baseline : 0,
      monthly_net_improvement:    r2(new_monthly_net - baseline_monthly_net),
    },
    note: 'Channel COGS assumptions: retail 35%, wholesale 30%, catering 40%, marketplace 50%. Pass cogs_pct_change in expense_delta as a fraction (e.g., -0.02 = drop COGS by 2pp).',
  };
}
