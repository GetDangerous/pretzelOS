// workers/finance-scorecard.js
// Single endpoint that returns everything Drew needs to scan the health
// of the business in 30 seconds. Pure data, no Sonnet. Fast.
//
// Endpoint: GET /finance/scorecard
//
// Sections:
//   1. cash       — current + 30d/90d trend + runway (capped)
//   2. this_week  — inflow/outflow/net for last 7d vs prior 7d (WoW)
//   3. ar_30d     — upcoming receivables next 30d, top 5 expected payments
//   4. bills_30d  — recurring + forecast bills next 30d, by-week aggregate
//   5. channel    — this-month-MTD vs last-month, by channel
//   6. pipeline   — review queue depth, JEs posted today, alerts
//
// Reads canonical helpers + posted JEs. Falls back to Mercury bank activity
// when GL is sparse (the same pattern as finance-shared.js burn calc).

import {
  getCanonicalCashOnHand,
  getCanonicalRunway,
  getCanonicalWeeklyRevenue,
  getCanonicalWeeklyBurn,
} from './finance-shared.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function pct(a, b) { if (!b) return null; return Math.round(((a - b) / b) * 1000) / 10; }

// ── 1. CASH + RUNWAY ─────────────────────────────────────────────────────
async function getCashSection(env) {
  const [cash, runway] = await Promise.all([
    getCanonicalCashOnHand(env),
    getCanonicalRunway(env),
  ]);

  // 30-day and 90-day cash trend (week-end balances reconstructed from txns)
  const { results: dailyNet } = await env.DB.prepare(`
    SELECT txn_date as d, ROUND(SUM(amount), 2) as net
    FROM mercury_transactions
    WHERE txn_date >= date('now', '-90 days')
      AND LOWER(counterparty_name) NOT LIKE '%mercury checking%'
      AND LOWER(counterparty_name) NOT LIKE '%mercury savings%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
    GROUP BY txn_date ORDER BY txn_date
  `).all();

  // Reconstruct daily balance: end_today = current; work backwards
  const today = (cash?.total ?? 0);
  const trend = [];
  let bal = today;
  for (let i = dailyNet.length - 1; i >= 0; i--) {
    const d = dailyNet[i];
    trend.unshift({ date: d.d, balance: r2(bal) });
    bal = r2(bal - (d.net || 0));
  }
  // Reduce to weekly samples (every 7th from end) so chart is readable
  const weekly = [];
  for (let i = trend.length - 1; i >= 0; i -= 7) weekly.unshift(trend[i]);

  return {
    current: cash,
    runway,
    trend_weekly: weekly.slice(-14),       // last ~14 weeks of week-end balances
  };
}

// ── 2. THIS WEEK vs LAST WEEK ─────────────────────────────────────────────
async function getThisWeekSection(env) {
  const { results } = await env.DB.prepare(`
    SELECT
      CASE WHEN txn_date >= date('now','-7 days') THEN 'this_week' ELSE 'last_week' END as bucket,
      ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) as inflow,
      ROUND(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 2) as outflow,
      ROUND(SUM(amount), 2) as net,
      COUNT(*) as n
    FROM mercury_transactions
    WHERE txn_date >= date('now','-14 days')
      AND txn_date < date('now')
      AND LOWER(counterparty_name) NOT LIKE '%mercury checking%'
      AND LOWER(counterparty_name) NOT LIKE '%mercury savings%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
    GROUP BY bucket
  `).all();

  const tw = (results || []).find(r => r.bucket === 'this_week') || { inflow: 0, outflow: 0, net: 0, n: 0 };
  const lw = (results || []).find(r => r.bucket === 'last_week') || { inflow: 0, outflow: 0, net: 0, n: 0 };

  return {
    this_week:   { inflow: r2(tw.inflow), outflow: r2(tw.outflow), net: r2(tw.net), txns: tw.n },
    last_week:   { inflow: r2(lw.inflow), outflow: r2(lw.outflow), net: r2(lw.net), txns: lw.n },
    week_over_week: {
      inflow_change_pct: pct(tw.inflow || 0, lw.inflow || 0),
      outflow_change_pct: pct(tw.outflow || 0, lw.outflow || 0),
      net_change: r2((tw.net || 0) - (lw.net || 0)),
    },
  };
}

// ── 3. AR — UPCOMING RECEIVABLES NEXT 30 DAYS ─────────────────────────────
async function getArSection(env) {
  // Read open QBO invoices from `orders` table
  const { results: openInvoices } = await env.DB.prepare(`
    SELECT id, customer_name, gross_revenue, order_date,
           json_extract(raw_payload, '$.due_date') as due_date,
           json_extract(raw_payload, '$.balance') as balance,
           json_extract(raw_payload, '$.invoice_id') as invoice_id
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','paid','estimate')
      AND CAST(json_extract(raw_payload, '$.balance') AS REAL) > 0
    ORDER BY json_extract(raw_payload, '$.due_date') ASC
    LIMIT 50
  `).all();

  // Bucket by week from today
  const buckets = {
    next_week: { invoices: 0, total: 0 },
    next_2_week: { invoices: 0, total: 0 },
    next_3_4_week: { invoices: 0, total: 0 },
    later: { invoices: 0, total: 0 },
    overdue: { invoices: 0, total: 0 },
  };
  const today = new Date();
  for (const inv of (openInvoices || [])) {
    const due = inv.due_date ? new Date(inv.due_date) : null;
    const bal = parseFloat(inv.balance) || 0;
    if (!due || bal <= 0) continue;
    const daysOut = Math.floor((due - today) / 86400000);
    let key;
    if (daysOut < 0) key = 'overdue';
    else if (daysOut <= 7) key = 'next_week';
    else if (daysOut <= 14) key = 'next_2_week';
    else if (daysOut <= 28) key = 'next_3_4_week';
    else key = 'later';
    buckets[key].invoices += 1;
    buckets[key].total = r2(buckets[key].total + bal);
  }

  // Top 5 expected by due date (next 30d)
  const top5 = (openInvoices || [])
    .filter(i => {
      const due = i.due_date ? new Date(i.due_date) : null;
      return due && (due - today) / 86400000 <= 30 && parseFloat(i.balance) > 0;
    })
    .slice(0, 5)
    .map(i => ({
      customer: i.customer_name,
      due_date: i.due_date,
      amount: r2(parseFloat(i.balance) || 0),
      days_out: Math.floor((new Date(i.due_date) - today) / 86400000),
    }));

  const totalOpen = r2((openInvoices || []).reduce((s, i) => s + (parseFloat(i.balance) || 0), 0));

  return {
    total_open: totalOpen,
    open_count: (openInvoices || []).length,
    buckets,
    top_5_expected: top5,
  };
}

// ── 4. BILLS — UPCOMING OUTFLOWS NEXT 30 DAYS ─────────────────────────────
async function getBillsSection(env) {
  // Active recurring bills with next_expected in next 30 days
  const { results: recurring } = await env.DB.prepare(`
    SELECT rb.description, rb.expected_amount, rb.cadence, rb.next_expected_date,
           v.name as vendor
    FROM recurring_bills rb
    LEFT JOIN vendors v ON v.id = rb.vendor_id
    WHERE rb.is_active = 1
      AND rb.next_expected_date <= date('now', '+30 days')
    ORDER BY rb.next_expected_date
  `).all();

  // 30-day average burn pattern as a forecast for the unstructured portion
  const burn = await getCanonicalWeeklyBurn(env);
  const projectedNonRecurringMonthly = r2(burn.weekly_burn * 4.3 - (recurring || []).reduce((s, r) => s + (r.expected_amount || 0), 0));

  // Bucket recurring by week
  const buckets = { next_week: [], next_2_week: [], next_3_4_week: [] };
  const today = new Date();
  for (const r of (recurring || [])) {
    const due = new Date(r.next_expected_date);
    const daysOut = Math.floor((due - today) / 86400000);
    let key;
    if (daysOut <= 7) key = 'next_week';
    else if (daysOut <= 14) key = 'next_2_week';
    else key = 'next_3_4_week';
    buckets[key].push({
      vendor: r.vendor || r.description,
      amount: r2(r.expected_amount || 0),
      due_date: r.next_expected_date,
      cadence: r.cadence,
    });
  }

  return {
    recurring_count: (recurring || []).length,
    recurring_total: r2((recurring || []).reduce((s, r) => s + (r.expected_amount || 0), 0)),
    projected_non_recurring_monthly: Math.max(0, projectedNonRecurringMonthly),
    buckets,
  };
}

// ── 5. CHANNEL MIX — THIS MONTH MTD vs LAST MONTH ─────────────────────────
async function getChannelSection(env) {
  const today = new Date();
  const mtdStart = `${today.toISOString().slice(0, 7)}-01`;
  const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lmStart = lastMonthDate.toISOString().slice(0, 10);
  const lmEnd = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);

  // Use canonical helper for current period
  const mtd = await getCanonicalWeeklyRevenue(env, Math.max(1, Math.floor((today - new Date(mtdStart)) / 86400000) + 1));

  // Last month: derive via orders + catering_orders
  const [retail, marketplace, wholesale, catering] = await Promise.all([
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue),2) as r, COUNT(*) as n FROM orders
      WHERE source IN ('toast','toast_live','toast_tsv','toast_csv','square')
        AND order_date BETWEEN ? AND ?
        AND (json_extract(raw_payload,'$.state')='COMPLETED' OR (json_extract(raw_payload,'$.state')='OPEN' AND json_extract(raw_payload,'$.tenders') IS NOT NULL AND json_extract(raw_payload,'$.tenders') != '[]'))
        AND (json_extract(raw_payload,'$.line_items[0].name') IS NULL OR json_extract(raw_payload,'$.line_items[0].name') NOT LIKE 'Catering:%')
    `).bind(lmStart, lmEnd).first(),
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue),2) as r, COUNT(*) as n FROM orders
      WHERE source = 'square_delivery'
        AND order_date BETWEEN ? AND ?
        AND json_extract(raw_payload,'$.source.name') IN ('DoorDash','Uber Eats','Grubhub','Postmates')
        AND (json_extract(raw_payload,'$.state')='COMPLETED' OR (json_extract(raw_payload,'$.state')='OPEN' AND json_extract(raw_payload,'$.tenders') IS NOT NULL AND json_extract(raw_payload,'$.tenders') != '[]'))
    `).bind(lmStart, lmEnd).first(),
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue),2) as r, COUNT(*) as n FROM orders
      WHERE source IN ('qbo_wholesale','qbo_invoice','qbo_estimate')
        AND status NOT IN ('voided','estimate')
        AND order_date BETWEEN ? AND ?
    `).bind(lmStart, lmEnd).first(),
    env.DB.prepare(`
      SELECT ROUND(
        COALESCE((SELECT SUM(gross_revenue) FROM orders WHERE source='toast_catering' AND order_date BETWEEN ?1 AND ?2),0) +
        COALESCE((SELECT SUM(order_value) FROM catering_orders WHERE status='confirmed' AND event_date BETWEEN ?1 AND ?2),0) +
        COALESCE((SELECT SUM(gross_revenue) FROM orders WHERE source IN ('square','square_delivery') AND order_date BETWEEN ?1 AND ?2 AND json_extract(raw_payload,'$.line_items[0].name') LIKE 'Catering:%' AND (json_extract(raw_payload,'$.state')='COMPLETED' OR (json_extract(raw_payload,'$.state')='OPEN' AND json_extract(raw_payload,'$.tenders') IS NOT NULL AND json_extract(raw_payload,'$.tenders') != '[]'))),0)
      , 2) as r
    `).bind(lmStart, lmEnd).first(),
  ]);

  const lm = {
    retail: r2(retail?.r || 0),
    marketplace: r2(marketplace?.r || 0),
    wholesale: r2(wholesale?.r || 0),
    catering: r2(catering?.r || 0),
  };
  lm.total = r2(lm.retail + lm.wholesale + lm.catering);  // marketplace separate

  const tm = {
    retail: mtd?.retail?.revenue || 0,
    marketplace: mtd?.marketplace?.revenue || 0,
    wholesale: mtd?.wholesale?.revenue || 0,
    catering: mtd?.catering?.revenue || 0,
    total: mtd?.total || 0,
  };

  return {
    this_month_mtd: { ...tm, period: { start: mtdStart, end: today.toISOString().slice(0, 10) } },
    last_month_full: { ...lm, period: { start: lmStart, end: lmEnd } },
    deltas_pct: {
      retail: pct(tm.retail, lm.retail),
      wholesale: pct(tm.wholesale, lm.wholesale),
      catering: pct(tm.catering, lm.catering),
      marketplace: pct(tm.marketplace, lm.marketplace),
      total: pct(tm.total, lm.total),
    },
  };
}

// ── 6. PIPELINE HEALTH ────────────────────────────────────────────────────
async function getPipelineSection(env) {
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM mercury_transactions WHERE is_reconciled=0 AND proposed_account_id IS NULL AND user_overridden=0) as uncategorized,
      (SELECT COUNT(*) FROM mercury_transactions WHERE is_reconciled=0 AND proposed_account_id IS NOT NULL AND proposed_confidence < 0.90 AND user_overridden=0) as low_confidence,
      (SELECT COUNT(*) FROM mercury_transactions WHERE is_reconciled=0 AND proposed_account_id IS NOT NULL AND proposed_confidence >= 0.90 AND user_overridden=0) as ready_to_post,
      (SELECT COUNT(*) FROM journal_entries WHERE status='posted' AND created_at >= datetime('now','-1 day')) as je_posted_24h,
      (SELECT COUNT(*) FROM financial_flags WHERE status='open' AND severity IN ('critical','high')) as critical_flags,
      (SELECT MAX(created_at) FROM journal_entries WHERE status='posted') as last_je_at
  `).first();

  return {
    review_queue: { uncategorized: row?.uncategorized || 0, low_confidence: row?.low_confidence || 0 },
    ready_to_post: row?.ready_to_post || 0,
    posted_last_24h: row?.je_posted_24h || 0,
    critical_flags: row?.critical_flags || 0,
    last_je_posted_at: row?.last_je_at || null,
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────
export async function getScorecard(env) {
  const [cash, thisWeek, ar, bills, channel, pipeline] = await Promise.all([
    getCashSection(env),
    getThisWeekSection(env),
    getArSection(env),
    getBillsSection(env),
    getChannelSection(env),
    getPipelineSection(env),
  ]);

  return {
    generated_at: new Date().toISOString(),
    cash,
    this_week: thisWeek,
    ar_30d: ar,
    bills_30d: bills,
    channel,
    pipeline,
  };
}
