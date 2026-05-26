// workers/finance-revenue-canonical.js
// RTR-7 (Session 14, May 13 2026) — canonical monthly revenue table.
//
// Stores per-month revenue computed via `getOrdersRevenueForPeriod` so
// historical reports + UI display + Tier 5 acceptance can pull a
// consistent number without rerunning the SQL each time. Drew's CFO chat
// + dashboard sparklines + monthly P&L all benefit.
//
// Refresh model:
//   - Backfill: explicit POST /finance/rtr/backfill-canonical-revenue
//   - Weekly cron: refreshes last 3 months (catches late settlements)
//   - On monthly-close: writes/updates the row for the just-closed period
//
// This is a CACHE of orders truth. The source of truth is still `orders`
// (RTR-2). This table just makes "what was revenue for month X" a single
// indexed row read instead of a fan-out SQL scan over the orders table.

import { getGLRevenueForPeriod } from './finance-shared.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${period}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function monthKeysBetween(fromPeriod, toPeriod) {
  const [fy, fm] = fromPeriod.split('-').map(Number);
  const [ty, tm] = toPeriod.split('-').map(Number);
  const out = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// ── Compute + upsert one period ──────────────────────────────────────────
export async function computeAndStoreMonthlyRevenue(env, period) {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return { ok: false, error: 'period must be YYYY-MM' };
  }
  const { start, end } = monthBounds(period);
  // Session 20: revenue from GL (single source of truth)
  const data = await getGLRevenueForPeriod(env, start, end);

  // Is this period closed?
  const closed = await env.DB.prepare(
    `SELECT id FROM closed_periods WHERE period_start = ? AND period_end = ? AND unlocked_at IS NULL`
  ).bind(start, end).first();
  const is_closed = closed ? 1 : 0;

  const b = data.breakdown || {};
  await env.DB.prepare(`
    INSERT INTO monthly_revenue_canonical
      (id, period, computed_at, revenue_orders, retail, wholesale, catering, marketplace,
       revenue_gl, gl_orders_drift, gl_orders_drift_pct, orders_count, source, is_closed)
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'getGLRevenueForPeriod', ?)
    ON CONFLICT(period) DO UPDATE SET
      computed_at = excluded.computed_at,
      revenue_orders = excluded.revenue_orders,
      retail = excluded.retail,
      wholesale = excluded.wholesale,
      catering = excluded.catering,
      marketplace = excluded.marketplace,
      revenue_gl = excluded.revenue_gl,
      gl_orders_drift = excluded.gl_orders_drift,
      gl_orders_drift_pct = excluded.gl_orders_drift_pct,
      orders_count = excluded.orders_count,
      is_closed = excluded.is_closed
  `).bind(
    crypto.randomUUID(),
    period,
    r2(data.total),
    r2(b.retail || 0),
    r2(b.wholesale || 0),
    r2(b.catering || 0),
    0,                                  // marketplace: 0 (now part of retail in GL)
    r2(data.total),                     // revenue_gl = revenue_orders (single source now)
    0, 0,                                // no drift (single source = no comparison)
    0,                                  // orders_count: not tracked in GL (drill via getOrdersRevenueForPeriod for audit)
    is_closed,
  ).run();

  return {
    ok: true,
    period,
    revenue: r2(data.total),
    retail: r2(b.retail || 0),
    wholesale: r2(b.wholesale || 0),
    catering: r2(b.catering || 0),
    tgtg: r2(b.tgtg || 0),
    beverage: r2(b.beverage || 0),
    services: r2(b.services || 0),
    is_closed,
    source: 'gl_reconstruction',
  };
}

// ── Backfill a range of months ───────────────────────────────────────────
export async function backfillCanonicalRevenue(env, opts = {}) {
  const from = opts.from || '2025-11';     // default: business cutover
  const today = new Date().toISOString().slice(0, 7);
  const to = opts.to || today;
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    return { ok: false, error: 'from + to must be YYYY-MM' };
  }
  const months = monthKeysBetween(from, to);
  const results = [];
  for (const period of months) {
    const r = await computeAndStoreMonthlyRevenue(env, period);
    results.push(r);
  }
  return {
    ok: true,
    from, to,
    months_processed: results.length,
    series: results.map(r => ({
      period: r.period,
      revenue: r.revenue_orders,
      retail: r.retail,
      wholesale: r.wholesale,
      catering: r.catering,
      marketplace: r.marketplace,
      gl_drift_pct: r.gl_orders_drift_pct,
      is_closed: !!r.is_closed,
    })),
  };
}

// ── Read a period (cache-first; computes + stores if missing) ────────────
export async function getCanonicalRevenue(env, period) {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return { ok: false, error: 'period must be YYYY-MM' };
  }
  const row = await env.DB.prepare(
    `SELECT * FROM monthly_revenue_canonical WHERE period = ?`
  ).bind(period).first();
  if (row) {
    return { ok: true, cached: true, ...row };
  }
  // Compute + store on miss
  const fresh = await computeAndStoreMonthlyRevenue(env, period);
  if (!fresh.ok) return fresh;
  return { ok: true, cached: false, ...fresh };
}

// ── List all stored periods (newest first) ────────────────────────────────
export async function listCanonicalRevenue(env) {
  const { results } = await env.DB.prepare(`
    SELECT period, computed_at, revenue_orders, retail, wholesale, catering,
           marketplace, revenue_gl, gl_orders_drift, gl_orders_drift_pct,
           orders_count, is_closed
    FROM monthly_revenue_canonical
    ORDER BY period DESC
    LIMIT 36
  `).all();
  return { ok: true, count: results.length, periods: results };
}

// ── Weekly cron entrypoint: refresh last 3 months ────────────────────────
export async function refreshRecentCanonicalRevenue(env) {
  const today = new Date();
  const months = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const results = await Promise.all(months.map(p => computeAndStoreMonthlyRevenue(env, p)));
  return { ok: true, refreshed: results };
}
