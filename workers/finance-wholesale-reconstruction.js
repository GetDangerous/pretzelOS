// workers/finance-wholesale-reconstruction.js
// Session 20F (May 14 2026) — Wholesale revenue from QBO Payment records.
// Session 25 (May 18 2026) — Forward-only architecture change: offset moved
// from Cash Clearing → Payments to deposit so Mercury INTUIT settlements drain
// a dedicated clearing instead of polluting petty-cash Cash Clearing. Historical
// wholesale recon JEs (Mar/Apr/May 2026) remain in Cash Clearing pending 23-ARCH
// architectural cleanup with accountant input (would otherwise drive Cash Clearing
// deeply negative if reversed without simultaneous unwind of bookkeeper-era recon).
//
// Cash basis: recognize wholesale revenue when customer pays the invoice.
// QBO Payment.TxnDate = the payment date.
//
// JE per month:
//   Dr Payments to deposit  (offset by Mercury INTUIT inflow later; ~2.9% Intuit fee expensed separately)
//   Cr Sales:Food Income:Wholesale

import { isReadOnly, readOnlySkip } from './finance-shared.js';
import { qboSqlQuery } from './qbo-client.js';

const COA_MAP = {
  offset: 'Payments to deposit',
  wholesale: 'Sales:Food Income:Wholesale',
};
const SOURCE_TYPE = 'qbo_payment_wholesale_reconstruction';

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const m = {};
  for (const r of results || []) m[r.account_name] = r.id;
  return m;
}

async function fetchPaymentsForRange(env, startDate, endDate) {
  const sql = `SELECT * FROM Payment WHERE TxnDate >= '${startDate}' AND TxnDate <= '${endDate}' MAXRESULTS 500`;
  const result = await qboSqlQuery(env, sql);
  return (result?.QueryResponse?.Payment || []).map(p => ({
    id: p.Id,
    txn_date: p.TxnDate,
    customer_id: p.CustomerRef?.value,
    customer: p.CustomerRef?.name,
    total: p.TotalAmt,
    unapplied: p.UnappliedAmt || 0,
    deposit_account: p.DepositToAccountRef?.name,
  }));
}

// Group payments by YYYY-MM and sum
function groupByMonth(payments) {
  const groups = {};
  for (const p of payments) {
    const m = p.txn_date?.slice(0, 7);
    if (!m) continue;
    groups[m] = groups[m] || { count: 0, total: 0, payments: [] };
    groups[m].count += 1;
    groups[m].total += p.total || 0;
    groups[m].payments.push({ id: p.id, date: p.txn_date, customer: p.customer, amount: p.total });
  }
  return groups;
}

export async function previewWholesaleReconstruction(env, startDate, endDate) {
  const payments = await fetchPaymentsForRange(env, startDate, endDate);
  return { ok: true, count: payments.length, total: payments.reduce((s, p) => s + p.total, 0), by_month: groupByMonth(payments) };
}

export async function postWholesaleReconstruction(env, startDate, endDate, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'wholesale_reconstruction' });

  const accountIds = await resolveAccountIds(env);
  for (const key of ['offset', 'wholesale']) {
    if (!accountIds[COA_MAP[key]]) {
      return { ok: false, error: `COA account missing: ${COA_MAP[key]}` };
    }
  }

  const payments = await fetchPaymentsForRange(env, startDate, endDate);
  const groups = groupByMonth(payments);
  const posted = [];
  const skipped = [];

  for (const [month, group] of Object.entries(groups)) {
    if (group.total < 0.01) {
      skipped.push({ month, reason: 'zero_total' });
      continue;
    }
    const sourceId = `wholesale_${month}`;
    const existing = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? AND status='posted' LIMIT 1`
    ).bind(SOURCE_TYPE, sourceId).first();
    if (existing && !opts.force) {
      skipped.push({ month, reason: 'already_posted', je: existing.id });
      continue;
    }
    if (existing && opts.force) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
      ).bind(existing.id).run();
    }

    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const entryDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    const entryId = crypto.randomUUID();
    const totalAmt = Math.round(group.total * 100) / 100;

    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_20f', ?)
    `).bind(
      entryId, entryDate,
      `QBO Wholesale Payments ${month} (cash basis)`,
      SOURCE_TYPE, sourceId, totalAmt, totalAmt,
      `${group.count} customer payments recorded in QBO during ${month}. Cash-basis recognition: revenue = payment date. Payment IDs: ${group.payments.slice(0,5).map(p => p.id).join(',')}${group.payments.length > 5 ? '...' : ''}`
    ).run();

    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 1, ?, ?, 0, ?)
    `).bind(crypto.randomUUID(), entryId, accountIds[COA_MAP.offset], totalAmt,
      `Payments to deposit for wholesale ${month} (Mercury INTUIT settlement drains this; ~2.9% Intuit fee expensed separately as Merchant fees)`).run();
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 2, ?, 0, ?, ?)
    `).bind(crypto.randomUUID(), entryId, accountIds[COA_MAP.wholesale], totalAmt,
      `Wholesale revenue (QBO Payments cash basis) ${month}`).run();

    posted.push({ month, je_id: entryId, payments: group.count, total: totalAmt });
  }

  return { ok: true, posted, skipped };
}
