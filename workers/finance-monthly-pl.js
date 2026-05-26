// workers/finance-monthly-pl.js
// Monthly P&L API — returns a structured P&L for any month, plus an MTD +
// prior-3-months side-by-side view for the dashboard tile.
//
// Endpoints:
//   GET /finance/monthly-pl?period=YYYY-MM
//   GET /finance/monthly-pl/quad           — current MTD + last 3 closed months
//
// SESSION 20G/H (May 14 2026):
//   Revenue is now sourced from the GL via getGLRevenueForPeriod — the
//   SINGLE SOURCE OF TRUTH after Session 20 reconstruction. The GL contains
//   bookkeeper-truth JEs (Feb 2025 - Feb 2026 from QBO P&L), Toast Sales
//   Summary JEs (Mar 2026 + Apr 1-13), Square raw_payload JEs (Apr 14+),
//   and QBO Payment-based wholesale JEs.
//
//   COGS and expense were always GL-sourced. Now revenue is too.
//   getOrdersRevenueForPeriod is now AUDIT-ONLY (drill-down to underlying POS).

import { getGLRevenueForPeriod } from './finance-shared.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

function monthBounds(period) {
  // period = "YYYY-MM"
  const [y, mo] = period.split('-').map(n => parseInt(n, 10));
  const start = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const end = `${period}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

// ── Compute P&L live (for unclosed months OR re-validation) ──────────────
async function computePLLive(env, period) {
  const { start, end } = monthBounds(period);

  // Session 20: revenue from GL (single source of truth after reconstruction)
  const glRev = await getGLRevenueForPeriod(env, start, end);
  const revenueTotal = glRev.total;
  const revenueByChannel = (glRev.lines || []).map(l => ({
    account_name: l.account_name,
    amount: l.amount,
  })).filter(r => Math.abs(r.amount) > 0.01);

  // COGS + Expense + Other_income + Other_expense still from GL — sweep
  // timing doesn't affect those (the JE date IS the expense date).
  const { results } = await env.DB.prepare(`
    SELECT c.account_type, c.account_subtype, c.account_name,
           ROUND(SUM(CASE WHEN c.account_type IN ('other_income') THEN l.credit - l.debit
                          WHEN c.account_type IN ('expense','cogs','other_expense') THEN l.debit - l.credit
                          ELSE 0 END), 2) as amount
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.source_type != 'fiscal_year_close'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND c.account_type IN ('other_income','expense','cogs','other_expense')
    GROUP BY c.account_type, c.account_subtype, c.account_name, c.id
    ORDER BY c.account_type, amount DESC
  `).bind(start, end).all();

  const buckets = { revenue: revenueTotal, cogs: 0, expense: 0, other_income: 0, other_expense: 0 };
  const byType = {
    revenue: revenueByChannel,
    cogs: [],
    expense: [],
    other_income: [],
    other_expense: [],
  };
  for (const r of (results || [])) {
    const bucket = r.account_type === 'cogs' ? 'cogs'
                 : r.account_type === 'expense' ? 'expense'
                 : r.account_type === 'other_income' ? 'other_income'
                 : 'other_expense';
    byType[bucket].push({ account_name: r.account_name, amount: r2(r.amount || 0) });
    buckets[bucket] += r.amount || 0;
  }
  const gross_profit = r2(buckets.revenue - buckets.cogs);
  const operating_income = r2(gross_profit - buckets.expense);
  const net_income = r2(operating_income + buckets.other_income - buckets.other_expense);
  return {
    period,
    period_bounds: { start, end },
    totals: {
      revenue: r2(buckets.revenue),
      revenue_source: 'gl_reconstruction',  // Session 20
      cogs: r2(buckets.cogs),
      gross_profit,
      gross_margin_pct: buckets.revenue ? Math.round((gross_profit / buckets.revenue) * 1000) / 10 : null,
      expense: r2(buckets.expense),
      operating_income,
      other_income: r2(buckets.other_income),
      other_expense: r2(buckets.other_expense),
      net_income,
      cogs_pct: buckets.revenue ? Math.round((buckets.cogs / buckets.revenue) * 1000) / 10 : null,
    },
    by_account: byType,
    revenue_breakdown: glRev.breakdown,
  };
}

// ── Read closed-month brief from cfo_briefs ──────────────────────────────
async function readClosedBrief(env, period) {
  const row = await env.DB.prepare(
    `SELECT brief_date, content FROM cfo_briefs
     WHERE type = 'monthly_close' AND brief_date = ? OR (type='monthly_close' AND content LIKE '%"period":"' || ? || '"%')
     ORDER BY brief_date DESC LIMIT 1`
  ).bind(`${period}-01`, period).first();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content);
    // Brief structure: { period, period_bounds, profit_and_loss, balance_sheet, cash_flow }
    const pl = parsed?.profit_and_loss;
    if (!pl) return null;
    return {
      period,
      period_bounds: pl.period,
      totals: {
        ...pl.totals,
        gross_margin_pct: pl.totals?.revenue
          ? Math.round((pl.totals.gross_profit / pl.totals.revenue) * 1000) / 10
          : null,
        cogs_pct: pl.totals?.revenue
          ? Math.round((pl.totals.cogs / pl.totals.revenue) * 1000) / 10
          : null,
      },
      by_account: pl.by_account || {},
      source: 'closed_brief',
      closed_at: row.brief_date,
    };
  } catch {
    return null;
  }
}

// ── Public: single-month P&L ──────────────────────────────────────────────
//
// RTR-2 behavior:
//   - For ALL periods: compute revenue live from orders (canonical sale event)
//   - If a closed brief exists: surface BOTH stored values + live values so
//     Drew can see if the stored brief is stale (e.g., March 2026 closed at $0
//     because the sweep hadn't run; live shows the real revenue).
//   - `?recompute=true` makes the response drop the stored brief entirely.
//   - The brief stays the audit-of-record (what was reported at close time).
export async function getMonthlyPL(env, period, opts = {}) {
  if (!/^\d{4}-\d{2}$/.test(period || '')) {
    return { error: 'period must be YYYY-MM' };
  }
  const recompute = !!opts.recompute;
  const live = await computePLLive(env, period);
  if (recompute) {
    return { ...live, source: 'live_recompute' };
  }
  const closed = await readClosedBrief(env, period);
  if (closed) {
    // Compare stored vs live so consumers (UI + chat) can see drift.
    const storedRev = closed.totals?.revenue ?? null;
    const liveRev = live.totals?.revenue ?? null;
    const drift = (storedRev != null && liveRev != null) ? r2(liveRev - storedRev) : null;
    const driftPct = (storedRev && liveRev) ? Math.round((drift / Math.max(storedRev, 1)) * 1000) / 10 : null;
    return {
      ...closed,
      live_recompute: {
        totals: live.totals,
        revenue_breakdown: live.revenue_breakdown,
        drift_vs_stored: drift,
        drift_pct: driftPct,
        note: drift != null && Math.abs(drift) > 100
          ? `Stored brief revenue $${storedRev} differs from live orders-based revenue $${liveRev} (delta $${drift}, ${driftPct}%). The stored brief was computed at close time from GL; live reads from orders. Either re-close (POST /finance/cfo/monthly-close/${period}/recompute) or accept the stored value as the audit-of-record.`
          : 'Stored brief and live recompute agree.',
      },
    };
  }
  return { ...live, source: 'live' };
}

// ── Public: 4-month side-by-side view ─────────────────────────────────────
export async function getMonthlyPLQuad(env) {
  const now = new Date();
  const periods = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const results = await Promise.all(periods.map(p => getMonthlyPL(env, p)));

  // Compute variance arrows between consecutive months
  const months = results.map((r, i) => ({
    period: r.period,
    is_current: i === results.length - 1,
    source: r.source,
    revenue: r.totals?.revenue || 0,
    cogs: r.totals?.cogs || 0,
    cogs_pct: r.totals?.cogs_pct,
    gross_profit: r.totals?.gross_profit || 0,
    gross_margin_pct: r.totals?.gross_margin_pct,
    expense: r.totals?.expense || 0,
    net_income: r.totals?.net_income || 0,
  }));

  // Top 5 expense changes between most recent two months
  let biggest_expense_moves = [];
  if (results.length >= 2) {
    const current = results[results.length - 1];
    const prior = results[results.length - 2];
    const curExpenses = new Map((current.by_account?.expense || []).map(e => [e.account_name, e.amount]));
    const priExpenses = new Map((prior.by_account?.expense || []).map(e => [e.account_name, e.amount]));
    const allAccounts = new Set([...curExpenses.keys(), ...priExpenses.keys()]);
    biggest_expense_moves = Array.from(allAccounts)
      .map(name => ({
        account_name: name,
        current: curExpenses.get(name) || 0,
        prior: priExpenses.get(name) || 0,
        change: r2((curExpenses.get(name) || 0) - (priExpenses.get(name) || 0)),
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 5);
  }

  return {
    months,
    biggest_expense_moves,
    note: 'Months marked source="live" are not yet closed (computed from posted JEs). source="closed_brief" means monthly close was run.',
  };
}
