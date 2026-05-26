// workers/finance-toast-sales-pos-reconstruction.js
// Phase 30-B (May 19 2026) — Replace qbo_pnl_reconstruction with per-order
// Toast POS source-of-truth aggregation. Sources directly from orders table
// (source IN ('toast','toast_live')) with dining_option channel split.
//
// ARCHITECTURE — mirrors bookkeeper's qbo_pnl_reconstruction structure:
//   - Revenue side ONLY: posts revenue + discount to Cash Clearing.
//   - Tax + Tips remain handled by bookkeeper_tips_tax_accrual (POS-derived monthly
//     aggregate, KEPT as-is — same data source we'd use).
//   - Cash Clearing balance is drained by mercury_txn JEs (Toast settlements to Mercury).
//
// JE structure per month:
//   DR Cash Clearing             $net_revenue (= gross - tax - tips - discount)
//   DR Discounts                  $discount
//   CR Sales:Food Income:Dine-In  $net_dinein_rev (= gross_dinein - allocated tax - allocated tips)
//   CR Sales:Food Income:Delivery $net_delivery_rev (= gross_delivery - allocated tax - allocated tips)
//
// Balance check:
//   DR = net_cc + discount = (gross - tax - tips - discount) + discount = gross - tax - tips
//   CR = net_dinein_rev + net_delivery_rev = (gross - tax - tips) ✓
//
// dining_option → channel mapping (Drew-confirmed):
//   Dine-In/Takeout: Take Out, Kiosk, In Store, Dine In, Toast Local,
//                    Branded Online Ordering, API
//   Delivery: DoorDash - Delivery, Uber Eats - Delivery, Toast Delivery Services,
//             Online, Delivery, Text Delivery, Email Delivery
//
// Scope: Jan 2025 – Feb 2026 (14 periods) matching qbo_pnl_reconstruction.
// Mar+Apr 2026 already covered by existing toast_sales_summary_reconstruction.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const COA = {
  offset: 'Clearing Accounts:Cash Clearing',
  retail_dinein: 'Sales:Food Income:Dine-In / Takeout',
  retail_delivery: 'Sales:Food Income:Delivery',
  discount: 'Discounts, Comps & Refunds',
};
const SOURCE_TYPE = 'toast_sales_pos_reconstruction';

const DELIVERY_OPTIONS = new Set([
  'DoorDash - Delivery', 'Uber Eats - Delivery', 'Toast Delivery Services',
  'Online', 'Delivery', 'Text Delivery', 'Email Delivery',
]);

function isDelivery(dining_option) {
  return DELIVERY_OPTIONS.has(dining_option);
}

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

async function aggregateMonth(env, periodStart, periodEnd) {
  const { results } = await env.DB.prepare(`
    SELECT dining_option,
      COUNT(*) as cnt,
      ROUND(SUM(COALESCE(gross_revenue, 0)), 2) as gross,
      ROUND(SUM(COALESCE(tip_amount, 0)), 2) as tips,
      ROUND(SUM(COALESCE(discount_amount, 0)), 2) as discounts
    FROM orders
    WHERE source IN ('toast', 'toast_live')
      AND order_date >= ? AND order_date < ?
    GROUP BY dining_option
  `).bind(periodStart, periodEnd).all();
  const agg = { dinein: { gross: 0, tips: 0, discounts: 0, cnt: 0 },
                delivery: { gross: 0, tips: 0, discounts: 0, cnt: 0 } };
  for (const r of (results || [])) {
    const ch = isDelivery(r.dining_option) ? 'delivery' : 'dinein';
    agg[ch].gross += r.gross || 0;
    agg[ch].tips += r.tips || 0;
    agg[ch].discounts += r.discounts || 0;
    agg[ch].cnt += r.cnt || 0;
  }
  for (const ch of ['dinein', 'delivery']) {
    for (const k of ['gross', 'tips', 'discounts']) {
      agg[ch][k] = Math.round(agg[ch][k] * 100) / 100;
    }
  }
  return agg;
}

// Get bookkeeper monthly tax (POS-derived). Read all-status since these JEs
// stay POSTED in Phase 30 (KEEP bookkeeper_tips_tax_accrual; POS-derived source).
async function getMonthlyTax(env, periodStart, periodEnd) {
  const row = await env.DB.prepare(`
    SELECT ROUND(SUM(l.credit - l.debit), 2) as tax
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_entry_id = j.id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.source_type='bookkeeper_tips_tax_accrual'
      AND j.entry_date >= ? AND j.entry_date < ?
      AND c.account_name='Sales tax to pay'
  `).bind(periodStart, periodEnd).first();
  return row?.tax || 0;
}

const PERIODS = [
  ['2025-01-01', '2025-02-01', '2025-01', '2025-01-31'],
  ['2025-02-01', '2025-03-01', '2025-02', '2025-02-28'],
  ['2025-03-01', '2025-04-01', '2025-03', '2025-03-31'],
  ['2025-04-01', '2025-05-01', '2025-04', '2025-04-30'],
  ['2025-05-01', '2025-06-01', '2025-05', '2025-05-31'],
  ['2025-06-01', '2025-07-01', '2025-06', '2025-06-30'],
  ['2025-07-01', '2025-08-01', '2025-07', '2025-07-31'],
  ['2025-08-01', '2025-09-01', '2025-08', '2025-08-31'],
  ['2025-09-01', '2025-10-01', '2025-09', '2025-09-30'],
  ['2025-10-01', '2025-11-01', '2025-10', '2025-10-31'],
  ['2025-11-01', '2025-12-01', '2025-11', '2025-11-30'],
  ['2025-12-01', '2026-01-01', '2025-12', '2025-12-31'],
  ['2026-01-01', '2026-02-01', '2026-01', '2026-01-31'],
  ['2026-02-01', '2026-03-01', '2026-02', '2026-02-28'],
];

const r2 = x => Math.round(x * 100) / 100;

export async function buildToastPosReconstructionPlan(env) {
  const plan = [];
  for (const [start, end, label, jeDate] of PERIODS) {
    const agg = await aggregateMonth(env, start, end);
    const tax = await getMonthlyTax(env, start, end);
    const gross_dinein = agg.dinein.gross;
    const gross_delivery = agg.delivery.gross;
    const gross_total = r2(gross_dinein + gross_delivery);
    const tips_total = r2(agg.dinein.tips + agg.delivery.tips);
    const discount_total = r2(agg.dinein.discounts + agg.delivery.discounts);

    // Allocate tax + tips per channel proportional to gross
    let net_dinein_rev = 0, net_delivery_rev = 0;
    if (gross_total > 0.005) {
      const ratio_dinein = gross_dinein / gross_total;
      const tax_dinein = r2(tax * ratio_dinein);
      const tax_delivery = r2(tax - tax_dinein);
      const tips_dinein = r2(tips_total * ratio_dinein);
      const tips_delivery = r2(tips_total - tips_dinein);
      net_dinein_rev = r2(gross_dinein - tax_dinein - tips_dinein);
      net_delivery_rev = r2(gross_delivery - tax_delivery - tips_delivery);
    }

    // Cash Clearing DR = net revenue net of discount
    const net_cc = r2(gross_total - tax - tips_total - discount_total);

    const je_lines = [
      { account: COA.offset, debit: net_cc, credit: 0, memo: `Toast POS net Cash Clearing ${label}` },
      { account: COA.discount, debit: discount_total, credit: 0, memo: `Toast discount contra-revenue ${label}` },
      { account: COA.retail_dinein, debit: 0, credit: net_dinein_rev, memo: `Toast Dine-In/Takeout revenue ${label}` },
      { account: COA.retail_delivery, debit: 0, credit: net_delivery_rev, memo: `Toast Delivery revenue ${label}` },
    ];

    plan.push({
      period_label: label,
      period_start: start,
      period_end: end,
      je_date: jeDate,
      orders_dinein: agg.dinein.cnt,
      orders_delivery: agg.delivery.cnt,
      gross_total, gross_dinein, gross_delivery,
      tax, tips: tips_total, discount: discount_total,
      net_cc, net_dinein_rev, net_delivery_rev,
      je_lines,
    });
  }
  return plan;
}

export async function previewToastPosReconstruction(env) {
  const plan = await buildToastPosReconstructionPlan(env);
  const totals = plan.reduce((a, p) => ({
    gross: a.gross + p.gross_total,
    net_dinein: a.net_dinein + p.net_dinein_rev,
    net_delivery: a.net_delivery + p.net_delivery_rev,
    tax: a.tax + p.tax,
    tips: a.tips + p.tips,
    discount: a.discount + p.discount,
    net_cc: a.net_cc + p.net_cc,
  }), { gross: 0, net_dinein: 0, net_delivery: 0, tax: 0, tips: 0, discount: 0, net_cc: 0 });
  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);

  // Verify each period balances
  const balance_checks = plan.map(p => {
    const dr = p.je_lines.reduce((s, l) => s + (l.debit || 0), 0);
    const cr = p.je_lines.reduce((s, l) => s + (l.credit || 0), 0);
    return { period: p.period_label, dr: r2(dr), cr: r2(cr), ok: Math.abs(dr - cr) < 0.01 };
  });
  const all_balanced = balance_checks.every(b => b.ok);

  return { ok: true, source_type: SOURCE_TYPE, periods: plan, totals, balance_checks, all_balanced };
}

export async function postToastPosReconstruction(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'toast_pos_reconstruction' });
  const force = !!opts.force;
  const accountIds = await resolveAccountIds(env);
  for (const key of Object.keys(COA)) {
    if (!accountIds[COA[key]]) return { ok: false, error: `Account not found: ${COA[key]}` };
  }
  const plan = await buildToastPosReconstructionPlan(env);
  const results = [];
  for (const p of plan) {
    const dr = p.je_lines.reduce((s, l) => s + (l.debit || 0), 0);
    const cr = p.je_lines.reduce((s, l) => s + (l.credit || 0), 0);
    if (Math.abs(dr - cr) > 0.01) {
      results.push({ period: p.period_label, status: 'imbalanced', dr: r2(dr), cr: r2(cr) });
      continue;
    }
    const jeId = `toast-pos-${p.period_label}`;
    const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE id=? AND status='posted'`).bind(jeId).first();
    if (existing && !force) { results.push({ period: p.period_label, status: 'skipped_existing' }); continue; }
    if (existing && force) {
      await env.DB.prepare(`UPDATE journal_entries SET status='reversed' WHERE id=?`).bind(jeId).run();
    }
    await env.DB.prepare(
      `INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'phase_30')`
    ).bind(jeId, p.je_date,
      `Phase 30 Toast POS revenue reconstruction ${p.period_label} (${p.orders_dinein + p.orders_delivery} orders)`,
      SOURCE_TYPE, p.period_label, r2(dr), r2(cr)).run();
    let n = 1;
    for (const l of p.je_lines) {
      await env.DB.prepare(
        `INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(`${jeId}-l${n}`, jeId, n, accountIds[l.account], l.debit || 0, l.credit || 0, l.memo).run();
      n++;
    }
    results.push({ period: p.period_label, status: 'posted', je_id: jeId });
  }
  return { ok: true, source_type: SOURCE_TYPE, results };
}
