// workers/finance-square-reconstruction.js
// Session 20F (May 14 2026) — Post Square POS revenue JEs from raw_payload.
//
// Square API stores complete tender/tax/tip/service breakdown in raw_payload
// per-order. We aggregate per period and post one JE with proper accounting:
//   Dr Cash Clearing            (total minus gift card redemptions)
//   Dr Gift Card Liability      (gift card redemptions)
//   Cr Sales:Food Income:...    (net retail revenue)
//   Cr Sales tax to pay         (tax collected)
//   Cr Tips Payable             (tips collected)
//   Cr Service Fee Income       (service charges)
//
// One JE per (year, month, half) — since Square era Apr 14+ doesn't align with
// month boundaries.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const COA_MAP = {
  offset: 'Clearing Accounts:Cash Clearing',
  retail: 'Sales:Food Income:Dine-In / Takeout',
  catering: 'Sales:Food Income:Catering',
  tax: 'Sales tax to pay',
  tips: 'Tips Payable',
  gift_card: 'Gift Card Liability',
  service_fee: 'Service Fee Income',
};
const SOURCE_TYPE = 'square_pos_reconstruction';

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

// Compute per-period Square totals direct from orders.raw_payload (authoritative)
export async function computeSquarePeriod(env, startDate, endDate) {
  const PAID_CLAUSE = `(json_extract(raw_payload,'$.state') = 'COMPLETED'
       OR (json_extract(raw_payload,'$.state') = 'OPEN'
           AND json_extract(raw_payload,'$.tenders') IS NOT NULL
           AND json_extract(raw_payload,'$.tenders') != '[]'))`;
  const CATERING_CLAUSE = `json_extract(raw_payload,'$.line_items[0].name') LIKE 'Catering:%'`;

  // Build totals separately for retail (non-catering) and catering
  const buildTotals = (cateringFilter) => `
    SELECT
      COUNT(*) as orders,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_money.amount') AS REAL))/100,2) as gross_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_tax_money.amount') AS REAL))/100,2) as tax_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_tip_money.amount') AS REAL))/100,2) as tip_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_service_charge_money.amount') AS REAL))/100,2) as svc_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_discount_money.amount') AS REAL))/100,2) as discount_total
    FROM orders
    WHERE source IN ('square','square_delivery')
      AND order_date >= ? AND order_date <= ?
      AND ${PAID_CLAUSE}
      AND ${cateringFilter}
  `;

  const retailTotals = await env.DB.prepare(buildTotals(`NOT (${CATERING_CLAUSE} OR ${CATERING_CLAUSE} IS NULL)
    AND (json_extract(raw_payload,'$.line_items[0].name') IS NULL
         OR json_extract(raw_payload,'$.line_items[0].name') NOT LIKE 'Catering:%')`)).bind(startDate, endDate).first();
  // Note: nested LIKE works because we want NOT catering. Simpler:
  const retailTotalsClean = await env.DB.prepare(`
    SELECT
      COUNT(*) as orders,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_money.amount') AS REAL))/100,2) as gross_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_tax_money.amount') AS REAL))/100,2) as tax_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_tip_money.amount') AS REAL))/100,2) as tip_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_service_charge_money.amount') AS REAL))/100,2) as svc_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_discount_money.amount') AS REAL))/100,2) as discount_total
    FROM orders
    WHERE source IN ('square','square_delivery')
      AND order_date >= ? AND order_date <= ?
      AND ${PAID_CLAUSE}
      AND (json_extract(raw_payload,'$.line_items[0].name') IS NULL
           OR json_extract(raw_payload,'$.line_items[0].name') NOT LIKE 'Catering:%')
  `).bind(startDate, endDate).first();

  const cateringTotals = await env.DB.prepare(`
    SELECT
      COUNT(*) as orders,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_money.amount') AS REAL))/100,2) as gross_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_tax_money.amount') AS REAL))/100,2) as tax_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_tip_money.amount') AS REAL))/100,2) as tip_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_service_charge_money.amount') AS REAL))/100,2) as svc_total,
      ROUND(SUM(CAST(json_extract(raw_payload,'$.total_discount_money.amount') AS REAL))/100,2) as discount_total
    FROM orders
    WHERE source IN ('square','square_delivery')
      AND order_date >= ? AND order_date <= ?
      AND ${PAID_CLAUSE}
      AND json_extract(raw_payload,'$.line_items[0].name') LIKE 'Catering:%'
  `).bind(startDate, endDate).first();

  // Combined totals (for backward compat / verification)
  const totals = {
    orders: (retailTotalsClean?.orders || 0) + (cateringTotals?.orders || 0),
    gross_total: r2((retailTotalsClean?.gross_total || 0) + (cateringTotals?.gross_total || 0)),
    tax_total: r2((retailTotalsClean?.tax_total || 0) + (cateringTotals?.tax_total || 0)),
    tip_total: r2((retailTotalsClean?.tip_total || 0) + (cateringTotals?.tip_total || 0)),
    svc_total: r2((retailTotalsClean?.svc_total || 0) + (cateringTotals?.svc_total || 0)),
    discount_total: r2((retailTotalsClean?.discount_total || 0) + (cateringTotals?.discount_total || 0)),
  };

  // Tender breakdown via json_each
  const { results: tenderRows } = await env.DB.prepare(`
    SELECT
      json_extract(t.value, '$.type') as tender_type,
      ROUND(SUM(CAST(json_extract(t.value, '$.amount_money.amount') AS REAL))/100,2) as amount,
      COUNT(*) as txns
    FROM orders o, json_each(json_extract(o.raw_payload,'$.tenders')) t
    WHERE o.source IN ('square','square_delivery')
      AND o.order_date >= ? AND o.order_date <= ?
      AND ${PAID_CLAUSE}
    GROUP BY tender_type
  `).bind(startDate, endDate).all();

  const tenders = {};
  for (const r of tenderRows || []) tenders[r.tender_type] = { amount: r.amount, txns: r.txns };

  const giftCardRedemptions = tenders.SQUARE_GIFT_CARD?.amount || 0;

  // Per-channel net sales
  const retailNet = r2((retailTotalsClean?.gross_total || 0) - (retailTotalsClean?.tax_total || 0) - (retailTotalsClean?.tip_total || 0) - (retailTotalsClean?.svc_total || 0));
  const cateringNet = r2((cateringTotals?.gross_total || 0) - (cateringTotals?.tax_total || 0) - (cateringTotals?.tip_total || 0) - (cateringTotals?.svc_total || 0));

  return {
    period_start: startDate,
    period_end: endDate,
    orders: totals.orders,
    gross_total: totals.gross_total,
    net_sales: r2(retailNet + cateringNet),
    retail_net: retailNet,
    catering_net: cateringNet,
    tax: totals.tax_total,
    tips: totals.tip_total,
    service_charge: totals.svc_total,
    discount: totals.discount_total,
    gift_card_redemptions: giftCardRedemptions,
    tenders,
    retail_breakdown: {
      orders: retailTotalsClean?.orders || 0,
      gross: retailTotalsClean?.gross_total || 0,
      tax: retailTotalsClean?.tax_total || 0,
      tip: retailTotalsClean?.tip_total || 0,
    },
    catering_breakdown: {
      orders: cateringTotals?.orders || 0,
      gross: cateringTotals?.gross_total || 0,
      tax: cateringTotals?.tax_total || 0,
      tip: cateringTotals?.tip_total || 0,
    },
  };
}

function r2(n) { return Math.round((n || 0) * 100) / 100; }

export async function postSquareReconstruction(env, periods /* [{start,end}] */, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'square_reconstruction' });

  const accountIds = await resolveAccountIds(env);
  for (const key of ['offset', 'retail', 'tax', 'tips', 'gift_card', 'service_fee']) {
    if (!accountIds[COA_MAP[key]]) {
      return { ok: false, error: `COA account missing: ${COA_MAP[key]}` };
    }
  }

  const posted = [];
  const skipped = [];
  const errors = [];

  for (const period of periods) {
    const sourceId = `square_${period.start}_to_${period.end}`;
    const existing = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? AND status='posted' LIMIT 1`
    ).bind(SOURCE_TYPE, sourceId).first();
    if (existing && !opts.force) {
      skipped.push({ period: sourceId, reason: 'already_posted', je: existing.id });
      continue;
    }
    if (existing && opts.force) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
      ).bind(existing.id).run();
    }

    const summary = await computeSquarePeriod(env, period.start, period.end);
    if (summary.gross_total < 0.01) {
      skipped.push({ period: sourceId, reason: 'no_orders' });
      continue;
    }

    const entryId = crypto.randomUUID();
    const drCashClearing = summary.gross_total - summary.gift_card_redemptions;
    const drGiftCard = summary.gift_card_redemptions;
    const totalDr = drCashClearing + drGiftCard;
    // Credits — separate retail vs catering
    const crRetail = summary.retail_net;
    const crCatering = summary.catering_net;
    const crTax = summary.tax;
    const crTips = summary.tips;
    const crSvc = summary.service_charge;
    const totalCr = crRetail + crCatering + crTax + crTips + crSvc;

    if (Math.abs(totalDr - totalCr) > 0.05) {
      errors.push({ period: sourceId, reason: 'unbalanced', dr: totalDr, cr: totalCr, delta: totalDr - totalCr });
      continue;
    }

    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_20f', ?)
    `).bind(
      entryId, period.end,
      `Square POS ${period.start} → ${period.end}`,
      SOURCE_TYPE, sourceId, totalDr, totalCr,
      `Authoritative Square POS revenue from raw_payload (live Square API). Per-tender breakdown: ${JSON.stringify(summary.tenders)}.`
    ).run();

    let lineNum = 1;
    if (drCashClearing > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.offset], drCashClearing,
        `Cash Clearing offset for Square ${period.start}→${period.end} (drained by Mercury Square + DD/Uber/GH + cash drawer + petty)`).run();
    }
    if (drGiftCard > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.gift_card], drGiftCard,
        `Gift card redemptions Square ${period.start}→${period.end}`).run();
    }
    if (crRetail > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.retail], crRetail,
        `Net retail sales (Square raw_payload, excl. catering-tagged) ${period.start}→${period.end}`).run();
    }
    if (crCatering > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.catering], crCatering,
        `Catering revenue (Square line_items.name LIKE 'Catering:%') ${period.start}→${period.end}`).run();
    }
    if (crTax > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.tax], crTax,
        `Sales tax collected (Square) ${period.start}→${period.end}`).run();
    }
    if (crTips > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.tips], crTips,
        `Tips collected (Square) ${period.start}→${period.end}`).run();
    }
    if (crSvc > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.service_fee], crSvc,
        `Service charges (Square) ${period.start}→${period.end}`).run();
    }

    posted.push({ period: sourceId, je_id: entryId, summary });
  }

  return { ok: true, posted, skipped, errors };
}
