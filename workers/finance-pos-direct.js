// workers/finance-pos-direct.js
// RTR-6 (Session 13, May 13 2026) — POS-direct revenue recognition.
//
// THE ARCHITECTURAL CHANGE that fixes revenue timing at its root.
//
// Old model (sweep-based):
//   1. Order written to `orders` (sale event)
//   2. Mercury settlement lands → Dr Mercury / Cr Clearing
//   3. Daily sweep → Dr Clearing / Cr Sales Revenue (dated to sweep date)
//   Problem: revenue JE date = sweep date != sale date.
//
// New model (POS-direct):
//   1. Order written to `orders` + immediately post Dr AR / Cr Sales Revenue
//      at order.order_date  ← THIS MODULE OWNS THIS JE
//   2. Mercury settlement lands → Dr Mercury / Cr AR (categorizer wires this
//      Session 14; for now the existing sweep is adapted to land in AR
//      instead of Revenue for post-cutover periods)
//   3. Processing fees become Dr Processing Fees / Cr AR delta (Session 14)
//
// Cutover: set via KV `RTR_CUTOVER_DATE` (YYYY-MM-DD). Only orders with
// `order_date >= cutover` get the new model. Pre-cutover orders stay on
// sweep model — historical JEs are not retroactively rewritten.
//
// Idempotency: every order has at most ONE pos_direct_sales JE. Check by
// (source_type = 'pos_direct_sales' AND source_id = order.id).

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Channel → revenue account ID mapping ──────────────────────────────────
// Hardcoded today; could move to a config table later. These IDs match
// chart_of_accounts in production (verified May 13 2026).
const CHANNEL_REVENUE_ACCOUNT = {
  // Square POS in-person / Web / Kiosk → Dine-In/Takeout
  retail:      '4f4038a0-8130-4280-85ca-ed620b450f1a',
  // Marketplace (DoorDash, UberEats, Grubhub, Postmates via Square)
  marketplace: '939aa87f-8d6c-40ae-a35c-eea54549b5e0',
  // QBO Invoices / wholesale orders
  wholesale:   '5ca16d4a-e0b7-4057-914b-80378a7673a9',
  // Catering (Square Catering line items + catering_orders + toast_catering)
  catering:    'a61f1e06-8aba-4b9b-8fe4-1456b7a81bd0',
};

const AR_ACCOUNT_ID = '36fb48df-17f7-4044-8246-fc5f09395a46';

// ── Cutover state ─────────────────────────────────────────────────────────
export async function getRtrCutoverDate(env) {
  return (await env.KV.get('RTR_CUTOVER_DATE')) || null;
}

export async function setRtrCutoverDate(env, date) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'date must be YYYY-MM-DD or empty' };
  }
  if (!date) {
    await env.KV.delete('RTR_CUTOVER_DATE');
  } else {
    await env.KV.put('RTR_CUTOVER_DATE', date);
  }
  return { ok: true, cutover_date: date || null };
}

// ── Channel inference ─────────────────────────────────────────────────────
// Map an `orders` row to its revenue channel.
function inferChannel(order) {
  const src = (order.source || '').toLowerCase();
  if (src.startsWith('qbo')) return 'wholesale';
  if (src === 'toast_catering') return 'catering';
  // Square Catering: line item name prefix
  try {
    if (order.raw_payload && typeof order.raw_payload === 'string') {
      const rp = JSON.parse(order.raw_payload);
      const firstItem = rp?.line_items?.[0]?.name || '';
      if (firstItem.startsWith('Catering:')) return 'catering';
      const sourceName = rp?.source?.name;
      if (sourceName && ['DoorDash', 'Uber Eats', 'Grubhub', 'Postmates'].includes(sourceName)) {
        return 'marketplace';
      }
    }
  } catch { /* ignore parse errors */ }
  if (src === 'square_delivery') return 'retail';   // Kiosk/Web direct (non-marketplace)
  return 'retail';
}

// ── Paid-state predicate (same as canonical revenue helper) ──────────────
function isPaidOrder(order) {
  // QBO Invoices: source='qbo_wholesale'/'qbo_invoice', status != voided/estimate
  if ((order.source || '').startsWith('qbo')) {
    return order.status && !['voided', 'estimate', 'draft'].includes(order.status);
  }
  // Square: state=COMPLETED or (state=OPEN with tenders)
  try {
    const rp = order.raw_payload ? JSON.parse(order.raw_payload) : null;
    const state = rp?.state;
    if (state === 'COMPLETED') return true;
    if (state === 'OPEN' && rp?.tenders && Array.isArray(rp.tenders) && rp.tenders.length > 0) return true;
    return false;
  } catch {
    return false;
  }
}

// ── Post the sales-recognition JE for one order ──────────────────────────
// Returns { ok, je_id, skipped?, error? }
export async function postSalesRecognitionJe(env, order) {
  if (!order || !order.id || !order.order_date) {
    return { ok: false, error: 'order requires id + order_date' };
  }

  // Cutover guard
  const cutover = await getRtrCutoverDate(env);
  if (!cutover) return { ok: false, skipped: 'cutover_not_set' };
  if (order.order_date < cutover) {
    return { ok: false, skipped: 'pre_cutover', order_date: order.order_date, cutover };
  }

  // Paid-state guard
  if (!isPaidOrder(order)) {
    return { ok: false, skipped: 'not_paid', state: order.status };
  }

  // Idempotency guard
  const existing = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE source_type = 'pos_direct_sales' AND source_id = ?`
  ).bind(order.id).first();
  if (existing) return { ok: true, skipped: 'already_posted', je_id: existing.id };

  // Amount check
  const grossRevenue = r2(order.gross_revenue || 0);
  if (grossRevenue < 0.01) return { ok: false, skipped: 'zero_or_negative_amount', amount: grossRevenue };

  // Channel inference
  const channel = inferChannel(order);
  const revenueAccountId = CHANNEL_REVENUE_ACCOUNT[channel];
  if (!revenueAccountId) {
    return { ok: false, error: `unknown channel: ${channel}` };
  }

  // Post the JE
  const entryId = crypto.randomUUID();
  const line1Id = crypto.randomUUID();
  const line2Id = crypto.randomUUID();
  const description = `POS-direct sales recognition · ${channel} · order ${order.id.slice(0, 8)}`.slice(0, 255);

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO journal_entries (
          id, entry_date, description, source_type, source_id,
          total_debit, total_credit, status, created_by, notes
        ) VALUES (?, ?, ?, 'pos_direct_sales', ?, ?, ?, 'posted', 'rtr_v6', ?)
      `).bind(
        entryId,
        order.order_date.slice(0, 10),
        description,
        order.id,
        grossRevenue,
        grossRevenue,
        `RTR-6 POS-direct: ${channel} order. AR will net to zero when Mercury settlement arrives.`.slice(0, 500),
      ),
      // Line 1: Dr Accounts Receivable (gross amount)
      env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, 1, ?, ?, 0, ?)
      `).bind(line1Id, entryId, AR_ACCOUNT_ID, grossRevenue, `AR for ${channel} sale ${order.id.slice(0, 8)}`),
      // Line 2: Cr Sales Revenue (channel-specific)
      env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, 2, ?, 0, ?, ?)
      `).bind(line2Id, entryId, revenueAccountId, grossRevenue, `${channel} revenue at sale date`),
    ]);
  } catch (e) {
    return { ok: false, error: `je_insert_failed: ${e.message?.slice(0, 200)}` };
  }

  return { ok: true, je_id: entryId, channel, amount: grossRevenue, entry_date: order.order_date.slice(0, 10) };
}

// ── Backfill: post sales-rec for all paid post-cutover orders in a period ─
export async function backfillSalesRecognition(env, opts = {}) {
  const cutover = opts.cutover || await getRtrCutoverDate(env);
  if (!cutover) {
    return { ok: false, error: 'No cutover set. POST /finance/rtr/set-cutover first, or pass cutover in body.' };
  }
  const period = opts.period;
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return { ok: false, error: 'period required (YYYY-MM)' };
  }
  const [y, m] = period.split('-').map(Number);
  const periodStart = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const periodEnd = `${period}-${String(lastDay).padStart(2, '0')}`;
  const effectiveStart = periodStart >= cutover ? periodStart : cutover;
  const dryRun = !!opts.dry_run;
  const limit = Math.min(opts.limit || 500, 2000);

  // Find paid orders in the period at/after cutover, with no existing pos_direct_sales JE
  const { results: orders } = await env.DB.prepare(`
    SELECT o.* FROM orders o
    WHERE o.order_date >= ? AND o.order_date <= ?
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries je
        WHERE je.source_type = 'pos_direct_sales' AND je.source_id = o.id
      )
    ORDER BY o.order_date
    LIMIT ?
  `).bind(effectiveStart, periodEnd, limit).all();

  const results = {
    period,
    cutover,
    effective_window: { start: effectiveStart, end: periodEnd },
    dry_run: dryRun,
    candidates: orders.length,
    posted: 0,
    skipped_pre_cutover: 0,
    skipped_not_paid: 0,
    skipped_zero: 0,
    skipped_already: 0,
    errors: [],
    by_channel: { retail: 0, marketplace: 0, wholesale: 0, catering: 0 },
    total_revenue_posted: 0,
  };

  for (const order of orders) {
    if (dryRun) {
      // Just classify without posting
      if (order.order_date < cutover) { results.skipped_pre_cutover++; continue; }
      if (!isPaidOrder(order)) { results.skipped_not_paid++; continue; }
      const amt = r2(order.gross_revenue || 0);
      if (amt < 0.01) { results.skipped_zero++; continue; }
      const ch = inferChannel(order);
      results.by_channel[ch] = (results.by_channel[ch] || 0) + 1;
      results.posted++;     // count of would-post
      results.total_revenue_posted += amt;
    } else {
      const r = await postSalesRecognitionJe(env, order);
      if (r.ok && !r.skipped) {
        results.posted++;
        results.by_channel[r.channel] = (results.by_channel[r.channel] || 0) + 1;
        results.total_revenue_posted += r.amount;
      } else if (r.skipped === 'pre_cutover') results.skipped_pre_cutover++;
      else if (r.skipped === 'not_paid') results.skipped_not_paid++;
      else if (r.skipped === 'zero_or_negative_amount') results.skipped_zero++;
      else if (r.skipped === 'already_posted') results.skipped_already++;
      else if (!r.ok) results.errors.push({ order_id: order.id, error: r.error });
    }
  }
  results.total_revenue_posted = r2(results.total_revenue_posted);
  return { ok: true, ...results };
}

// ── Cutover status — what's posted vs what's pending ─────────────────────
export async function getRtrCutoverStatus(env) {
  const cutover = await getRtrCutoverDate(env);
  if (!cutover) {
    return {
      ok: true,
      cutover_set: false,
      note: 'RTR-6 cutover not yet enabled. POST /finance/rtr/set-cutover with {date:"YYYY-MM-DD"} to enable. Until then, revenue recognition follows the sweep model.',
    };
  }

  // Count post-cutover orders + post-cutover sales-rec JEs
  const ordersRow = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(gross_revenue), 2) as total
    FROM orders
    WHERE order_date >= ?
  `).bind(cutover).first();
  const jesRow = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(total_debit), 2) as total
    FROM journal_entries
    WHERE source_type = 'pos_direct_sales' AND status = 'posted'
      AND entry_date >= ?
  `).bind(cutover).first();

  return {
    ok: true,
    cutover_set: true,
    cutover_date: cutover,
    orders_post_cutover: {
      count: ordersRow?.n || 0,
      gross_revenue_total: r2(ordersRow?.total || 0),
    },
    pos_direct_jes_post_cutover: {
      count: jesRow?.n || 0,
      total_volume: r2(jesRow?.total || 0),
    },
    coverage_pct: ordersRow?.n
      ? Math.round(((jesRow?.n || 0) / ordersRow.n) * 1000) / 10
      : null,
    note: 'Use POST /finance/rtr/backfill-sales-recognition?period=YYYY-MM to backfill paid orders without JEs.',
  };
}
