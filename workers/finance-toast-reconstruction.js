// workers/finance-toast-reconstruction.js
// Session 20F (May 14 2026) — Post Toast Sales Summary records as monthly JEs.
//
// For Mar 2026 + Apr 1-13 (post-bookkeeper Toast era), Drew exports official
// Toast SalesSummary ZIPs. We ingest the Revenue Summary numbers (the GAAP-
// canonical: net sales, tax, tips, gratuity, gifts) into toast_sales_summary
// then post a single JE per period with proper liability breakdown.
//
// JE structure:
//   Dr Clearing Accounts:Cash Clearing  TOTAL
//   Cr Sales:Food Income:Dine-In / Takeout  NET_SALES
//   Cr Sales tax to pay                     TAX
//   Cr Tips Payable                         TIPS + GRATUITY
//   Cr Gift Card Liability                  GIFT_CARDS_DEFERRED
//
// Mercury inflows (card processor settlements, DoorDash direct deposits, etc.)
// already-posted as mercury_txn JEs will progressively drain the Cash Clearing
// balance.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const COA_MAP = {
  offset: 'Clearing Accounts:Cash Clearing',
  retail: 'Sales:Food Income:Dine-In / Takeout',
  tax: 'Sales tax to pay',
  tips: 'Tips Payable',
  gift_card: 'Gift Card Liability',
};
const SOURCE_TYPE = 'toast_sales_summary_reconstruction';

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

export async function previewToastReconstruction(env) {
  const { results } = await env.DB.prepare(`
    SELECT * FROM toast_sales_summary ORDER BY period_start
  `).all();
  return { ok: true, periods: results || [] };
}

export async function postToastReconstruction(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'toast_reconstruction' });

  const accountIds = await resolveAccountIds(env);
  for (const key of ['offset', 'retail', 'tax', 'tips', 'gift_card']) {
    if (!accountIds[COA_MAP[key]]) {
      return { ok: false, error: `COA account missing: ${COA_MAP[key]}` };
    }
  }

  const { results: records } = await env.DB.prepare(
    `SELECT * FROM toast_sales_summary ORDER BY period_start`
  ).all();

  const posted = [];
  const skipped = [];
  const errors = [];

  for (const rec of records || []) {
    const sourceId = `toast_${rec.period_start}_to_${rec.period_end}`;

    // Idempotent: skip if already posted unless force
    const existing = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? AND status = 'posted' LIMIT 1`
    ).bind(SOURCE_TYPE, sourceId).first();
    if (existing && !opts.force) {
      skipped.push({ period: rec.period_start, reason: 'already_posted', je: existing.id });
      continue;
    }
    if (existing && opts.force) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
      ).bind(existing.id).run();
    }

    const tipsTotal = (rec.tips || 0) + (rec.gratuity || 0);
    const giftCards = rec.gift_cards_deferred || 0;
    const tax = rec.tax_amount || 0;
    const netSales = rec.net_sales || 0;
    // Total Cr = netSales + tax + tipsTotal + giftCards. We'll handle any small
    // residual (e.g., $450 Deposit Sales) by ensuring Dr = Cr exactly.
    const totalCr = netSales + tax + tipsTotal + giftCards;
    // total in Revenue summary may differ — use computed Cr as the Dr
    const totalDr = totalCr;

    if (Math.abs(totalCr) < 0.01) {
      skipped.push({ period: rec.period_start, reason: 'zero_total' });
      continue;
    }

    const entryId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_20f', ?)
    `).bind(
      entryId, rec.period_end,
      `Toast Sales Summary ${rec.period_start} → ${rec.period_end}`,
      SOURCE_TYPE, sourceId, totalDr, totalCr,
      `Authoritative Toast retail revenue from official Sales Summary export. Net sales recognized at POS. Tax + tips + gifts broken out per GAAP. Cash drawer change: $${rec.total_cash_drawer_change}.`
    ).run();

    let lineNum = 1;
    // DR Cash Clearing (offset — Mercury inflows will progressively drain this)
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.offset], totalDr,
      `Cash Clearing offset for Toast ${rec.period_start}→${rec.period_end} (drained by Mercury TOAST + DD/Uber/GH inflows + cash drawer)`).run();

    // CR revenue (net sales)
    if (netSales > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.retail], netSales,
        `Net retail sales (Toast official) for ${rec.period_start}→${rec.period_end}`).run();
    }
    // CR tax payable
    if (tax > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.tax], tax,
        `Sales tax collected (Toast official) for ${rec.period_start}→${rec.period_end}`).run();
    }
    // CR tips + gratuity
    if (tipsTotal > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.tips], tipsTotal,
        `Tips ($${rec.tips}) + gratuity ($${rec.gratuity}) collected at POS (Toast official)`).run();
    }
    // CR gift card liability
    if (giftCards > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[COA_MAP.gift_card], giftCards,
        `Gift cards sold ${rec.period_start}→${rec.period_end} (deferred — recognize on redemption)`).run();
    }

    posted.push({
      period: `${rec.period_start} to ${rec.period_end}`,
      entry_id: entryId,
      net_sales: netSales,
      tax, tips_grat: tipsTotal, gifts: giftCards, total_cr: totalCr,
    });
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'toast_sales_reconstruction', 'journal_entries', ?, 'session_20f', ?, ?)
  `).bind(
    crypto.randomUUID(), `toast_recon_${Date.now()}`,
    `Posted ${posted.length} Toast Sales Summary JEs (Mar 2026 + Apr 1-13)`,
    JSON.stringify({ posted: posted.length, skipped: skipped.length, errors: errors.length })
  ).run().catch(() => {});

  return { ok: true, posted, skipped, errors };
}
