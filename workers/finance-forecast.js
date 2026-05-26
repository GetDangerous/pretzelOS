// workers/finance-forecast.js
// Session 17b (May 14, 2026) — canonical runway forecast.
//
// REPLACES the naive `cash / weekly_burn` runway hero number with a real
// 30/60/90-day projection. Inputs:
//   - Today's cash (canonical)
//   - AR collections expected (from `orders` due_date + customer reliability)
//   - Recurring revenue patterns (retail POS avg, recurring wholesale)
//   - Recurring expense calendar (rent, payroll, loans, sales tax)
//
// Built on top of existing `rebuildForecast` (workers/finance-cashflow.js)
// which already produces a daily projection. This module wraps that to
// return the SHAPE the hero strip needs.
//
// Endpoint: GET /finance/canonical/forecast?days=90
//
// Returns:
//   {
//     cash_now,
//     projected_30d, projected_60d, projected_90d,
//     lowest_projected: { balance, date, days_out },
//     trend: 'improving' | 'stable' | 'declining',
//     goes_negative: false | { on_date, days_out },
//     confidence: 'high' | 'medium' | 'low',
//     confidence_caveats: [...],
//     hero_display: { value, label, color }   ← what the hero strip renders
//   }

import { rebuildForecast } from './finance-cashflow.js';
import { getCanonicalCashOnHand } from './finance-shared.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

export async function getCanonicalForecast(env, days = 90) {
  // Re-run the forecast (cheap; recomputes from current data)
  const fc = await rebuildForecast(env, days).catch(err => ({ error: err.message, timeline: [] }));

  if (fc.error || !fc.timeline || !fc.timeline.length) {
    // Graceful degradation per audit W6: never blank, always SOMETHING.
    const cash = await getCanonicalCashOnHand(env);
    return {
      ok: false,
      error: fc.error || 'no_timeline',
      cash_now: cash?.total || 0,
      hero_display: {
        value: '—',
        label: 'Forecast unavailable',
        color: 'amber',
        sub: '(showing cash only; forecast endpoint failed)',
      },
      degraded: true,
    };
  }

  const tl = fc.timeline;
  const cashNow = fc.cash_now?.total || (tl[0]?.opening_balance || 0);
  const at = (n) => tl[Math.min(n, tl.length - 1)]?.closing_balance ?? null;
  const projected_30d = at(30);
  const projected_60d = at(60);
  const projected_90d = at(Math.min(89, tl.length - 1));

  // Lowest projected point
  let lowest = tl[0];
  for (const t of tl) if (t.closing_balance < lowest.closing_balance) lowest = t;
  const lowestDaysOut = Math.round((new Date(lowest.date) - new Date(tl[0].date)) / 86400000);

  // Trend: compare 30d / 60d / 90d projection vs today
  let trend = 'stable';
  const net30 = (projected_30d || 0) - cashNow;
  const net90 = (projected_90d || 0) - cashNow;
  if (net90 > 5000 && net30 > 0) trend = 'improving';
  else if (net90 < -5000) trend = 'declining';

  // Goes negative
  const negativeDay = tl.find(t => t.closing_balance < 0);

  // Confidence — soft estimate based on data quality.
  const caveats = [];
  // Check AR data presence
  if (!fc.ar_forecast || fc.ar_forecast.count === 0) caveats.push('no AR due-date data — recurring revenue inferred from history only');
  // Check recurring expense breadth
  if (!fc.outflow_forecast || fc.outflow_forecast.line_item_count < 3) caveats.push('few scheduled outflows — recurring expense calendar sparse');
  // Negative-balance dates create wider uncertainty
  if (negativeDay) caveats.push(`projects negative ${negativeDay.date} — high uncertainty after that`);

  const confidence = caveats.length === 0 ? 'high'
                   : caveats.length <= 1 ? 'medium'
                   : 'low';

  // Hero display shape: what dashboard renders in the runway card
  let heroValue, heroColor, heroLabel, heroSub;
  if (negativeDay) {
    heroValue = '⚠ ' + negativeDay.date;
    heroLabel = 'Cash runs out';
    heroColor = 'red';
    heroSub = `Lowest projected $${Math.round(lowest.closing_balance).toLocaleString()} on day ${lowestDaysOut}`;
  } else if (lowest.closing_balance < cashNow * 0.5) {
    heroValue = '$' + Math.round(lowest.closing_balance / 1000) + 'k';
    heroLabel = 'Lowest cash';
    heroColor = 'amber';
    heroSub = `On ${lowest.date} (day ${lowestDaysOut}) · ${trend}`;
  } else {
    heroValue = '$' + Math.round((projected_90d || 0) / 1000) + 'k';
    heroLabel = '90d projected cash';
    heroColor = trend === 'declining' ? 'amber' : 'green';
    heroSub = `Lowest $${Math.round(lowest.closing_balance / 1000)}k on ${lowest.date} · ${trend}`;
  }

  return {
    ok: true,
    cash_now: cashNow,
    horizon_days: days,
    projected_30d,
    projected_60d,
    projected_90d,
    lowest_projected: {
      balance: r2(lowest.closing_balance),
      date: lowest.date,
      days_out: lowestDaysOut,
    },
    trend,
    goes_negative: negativeDay ? { on_date: negativeDay.date, days_out: Math.round((new Date(negativeDay.date) - new Date(tl[0].date)) / 86400000) } : false,
    confidence,
    confidence_caveats: caveats,
    ar_total_expected_30d: fc.ar_forecast?.total || 0,
    retail_total_expected_30d: fc.retail_forecast?.total || 0,
    outflow_total_30d: fc.outflow_forecast?.total_scheduled || 0,
    hero_display: { value: heroValue, label: heroLabel, color: heroColor, sub: heroSub },
    generated_at: fc.generated_at,
    note: 'Canonical forecast. Replaces naive cash/burn runway. Inputs: AR (orders.due_date), retail POS avg, recurring expense calendar. Confidence reflects data completeness.',
  };
}
