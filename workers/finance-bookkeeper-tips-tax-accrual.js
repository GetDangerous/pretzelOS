// workers/finance-bookkeeper-tips-tax-accrual.js
// Phase 21V-audit-6 F6 (foundational fix): Restore Tips Payable + Sales Tax
// Payable accruals from bookkeeper-era daily Sales JEs that the QBO JE ingest
// filtered out (because they also touched revenue accounts, which Phase 20D
// reconstructs from QBO P&L truth).
//
// The bookkeeper's daily "Sales (DD-MM-YYYY)" JEs typically posted:
//   DR Cash Clearing total
//   CR Sales:Food Income net
//   CR Sales tax to pay tax
//   CR Tips Payable tips
//
// By filtering them, we lost both revenue AND tax/tips accrual. Phase 20D added
// back revenue. This worker adds back the tax + tips CR portion, with offset to
// Cash Clearing (matching the bookkeeper's pattern).
//
// Idempotent: source_type='bookkeeper_tips_tax_accrual'.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const SOURCE_TYPE = 'bookkeeper_tips_tax_accrual';

export async function previewAccrual(env) {
  const { results } = await env.DB.prepare(`
    SELECT
      strftime('%Y-%m', json_extract(raw_json, '$.TxnDate')) as period,
      json_extract(line.value, '$.JournalEntryLineDetail.AccountRef.name') as acct,
      ROUND(SUM(CAST(json_extract(line.value, '$.Amount') AS REAL)), 2) as total
    FROM qbo_archive_entity, json_each(json_extract(raw_json, '$.Line')) AS line
    WHERE entity_type='JournalEntry'
      AND json_extract(raw_json, '$.DocNumber') LIKE 'Sales %'
      AND json_extract(line.value, '$.JournalEntryLineDetail.AccountRef.name') IN ('Tips Payable','Sales tax to pay')
      AND json_extract(line.value, '$.JournalEntryLineDetail.PostingType')='Credit'
    GROUP BY period, acct
    ORDER BY period, acct
  `).all();

  const byMonth = {};
  for (const r of (results || [])) {
    if (!byMonth[r.period]) byMonth[r.period] = { tips: 0, sales_tax: 0 };
    if (r.acct === 'Tips Payable') byMonth[r.period].tips = r.total;
    if (r.acct === 'Sales tax to pay') byMonth[r.period].sales_tax = r.total;
  }
  return { ok: true, by_month: byMonth, periods: Object.keys(byMonth).sort() };
}

export async function postAccruals(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'bookkeeper_tips_tax_accrual' });

  const accountIds = {};
  const accounts = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts WHERE account_name IN ('Tips Payable','Sales tax to pay','Clearing Accounts:Cash Clearing')`
  ).all();
  for (const a of accounts.results || []) accountIds[a.account_name] = a.id;

  const { by_month, periods } = await previewAccrual(env);

  const posted = [];
  const skipped = [];

  for (const period of periods) {
    const { tips, sales_tax } = by_month[period];
    if ((tips + sales_tax) < 0.01) {
      skipped.push({ period, reason: 'zero_total' });
      continue;
    }

    // Idempotency
    const existing = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type=? AND source_id=? AND status='posted'`
    ).bind(SOURCE_TYPE, period).first();
    if (existing && !opts.force) {
      skipped.push({ period, reason: 'already_posted' });
      continue;
    }
    if (existing && opts.force) {
      await env.DB.prepare(`UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force at ' || datetime('now') WHERE id=?`).bind(existing.id).run();
    }

    // Post per-month: DR Cash Clearing total / CR Tips Payable + CR Sales Tax
    // entry_date = last day of period
    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const entryDate = `${period}-${String(lastDay).padStart(2,'0')}`;

    const total = tips + sales_tax;
    const entryId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21v_audit6_f6', ?)
    `).bind(
      entryId, entryDate,
      `Bookkeeper-era Tips + Sales Tax accrual ${period} (extracted from daily Sales JEs filtered during qbo_je_ingest)`,
      SOURCE_TYPE, period, total, total,
      `Restores Tips Payable CR \$${tips.toFixed(2)} and Sales tax to pay CR \$${sales_tax.toFixed(2)} from bookkeeper daily "Sales (...)" JEs. Offset to Cash Clearing matches bookkeeper's original pattern.`
    ).run();

    let lineNum = 1;
    // DR Cash Clearing total
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds['Clearing Accounts:Cash Clearing'], total,
      `Tips + Sales Tax portion of POS receipts (bookkeeper era ${period})`).run();

    // CR Tips Payable
    if (tips > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds['Tips Payable'], tips,
        `Tips collected via POS ${period} (sum of bookkeeper daily Sales JEs)`).run();
    }

    // CR Sales tax to pay
    if (sales_tax > 0.01) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds['Sales tax to pay'], sales_tax,
        `Sales tax collected via POS ${period}`).run();
    }

    posted.push({ period, entry_id: entryId, tips, sales_tax, total });
  }

  return { ok: true, posted, skipped };
}
