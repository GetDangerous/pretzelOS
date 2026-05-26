// workers/finance-mercury-credit-ingest.js
// Session 21-validate (May 15 2026) — Phase 21V-MC-hist
//
// Ingest QBO Purchase records sourced from "Mercury Credit (0000) - 1" as
// proper JEs. This card was active throughout 2025 but never synced into our
// mercury_transactions table — only the pay-down side (DR Mercury Credit /
// CR Mercury Checking) was visible to the categorizer, so Mercury Credit
// liability went to -$108K by YE2025. This worker fixes that by posting
// the SPENDING side from authoritative QBO Purchase records.
//
// JE pattern per Purchase:
//   - For each Line in raw_json.Line[]:
//       DR Line.AccountBasedExpenseLineDetail.AccountRef.name @ Line.Amount
//   - CR Mercury Credit (0000) - 1 @ raw_json.TotalAmt
//   - If raw_json.Credit=true (refund): swap DR ↔ CR direction
//
// Idempotency: source_type='qbo_mercury_credit_ingest', source_id=Purchase.Id

import { isReadOnly, readOnlySkip } from './finance-shared.js';

const MERCURY_CREDIT_ACCOUNT_NAME = 'Mercury Credit (0000) - 1';
const SOURCE_TYPE = 'qbo_mercury_credit_ingest';

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts`
  ).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

async function fetchPurchases(env, yearStart, yearEnd) {
  const { results } = await env.DB.prepare(`
    SELECT raw_json
    FROM qbo_archive_entity
    WHERE entity_type = 'Purchase'
      AND json_extract(raw_json, '$.AccountRef.name') = ?
      AND json_extract(raw_json, '$.TxnDate') BETWEEN ? AND ?
    ORDER BY json_extract(raw_json, '$.TxnDate')
  `).bind(MERCURY_CREDIT_ACCOUNT_NAME, yearStart, yearEnd).all();
  return (results || []).map(r => JSON.parse(r.raw_json));
}

function parsePurchase(p) {
  const lines = [];
  const rawLines = Array.isArray(p.Line) ? p.Line : [];
  for (const line of rawLines) {
    const det = line?.AccountBasedExpenseLineDetail;
    if (!det) continue;  // skip non-expense lines (e.g., item-based)
    const accountName = det?.AccountRef?.name;
    const amount = parseFloat(line?.Amount) || 0;
    if (!accountName || amount === 0) continue;
    lines.push({
      account_name: accountName,
      amount,
      description: line?.Description || p.PrivateNote || p.EntityRef?.name || 'QBO Mercury Credit purchase',
    });
  }
  return {
    purchase_id: p.Id,
    txn_date: p.TxnDate,
    total_amt: parseFloat(p.TotalAmt) || 0,
    is_credit: p.Credit === true || p.Credit === 'true',  // refund flag
    vendor: p.EntityRef?.name || '(no vendor)',
    private_note: p.PrivateNote || '',
    lines,
  };
}

export async function previewMercuryCreditIngest(env, year = 2025) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const purchases = await fetchPurchases(env, yearStart, yearEnd);
  const accountIds = await resolveAccountIds(env);

  let postCount = 0;
  let skipNoLines = 0;
  let skipNoAccount = 0;
  let totalAmount = 0;
  const unmappedAccounts = new Set();
  const sample = [];
  const byMonth = {};

  for (const p of purchases) {
    const parsed = parsePurchase(p);
    if (parsed.lines.length === 0) { skipNoLines++; continue; }
    let allMapped = true;
    for (const line of parsed.lines) {
      if (!accountIds[line.account_name]) {
        unmappedAccounts.add(line.account_name);
        allMapped = false;
      }
    }
    if (!allMapped) { skipNoAccount++; continue; }
    postCount++;
    totalAmount += parsed.total_amt * (parsed.is_credit ? -1 : 1);
    const month = parsed.txn_date.slice(0, 7);
    byMonth[month] = (byMonth[month] || 0) + parsed.total_amt * (parsed.is_credit ? -1 : 1);
    if (sample.length < 5) sample.push(parsed);
  }

  return {
    ok: true,
    year,
    purchases_found: purchases.length,
    would_post: postCount,
    skipped_no_lines: skipNoLines,
    skipped_unmapped_account: skipNoAccount,
    unmapped_accounts: Array.from(unmappedAccounts),
    total_amount: Math.round(totalAmount * 100) / 100,
    by_month: byMonth,
    sample,
  };
}

export async function ingestMercuryCreditPurchases(env, year = 2025, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'mercury_credit_ingest' });

  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const purchases = await fetchPurchases(env, yearStart, yearEnd);
  const accountIds = await resolveAccountIds(env);
  const mcId = accountIds[MERCURY_CREDIT_ACCOUNT_NAME];
  if (!mcId) {
    return { ok: false, error: `${MERCURY_CREDIT_ACCOUNT_NAME} not found in COA` };
  }

  const posted = [];
  const skipped = [];
  const errors = [];

  for (const p of purchases) {
    const parsed = parsePurchase(p);
    const sourceId = `qbo_purchase_${parsed.purchase_id}`;

    // Idempotency check
    const existing = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? LIMIT 1`
    ).bind(SOURCE_TYPE, sourceId).first();
    if (existing && !opts.force) {
      skipped.push({ purchase_id: parsed.purchase_id, reason: 'already_ingested', existing_je: existing.id });
      continue;
    }
    if (existing && opts.force) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
      ).bind(existing.id).run();
    }

    if (parsed.lines.length === 0) {
      skipped.push({ purchase_id: parsed.purchase_id, reason: 'no_expense_lines' });
      continue;
    }

    // Validate all line accounts map to COA
    const missing = parsed.lines.filter(l => !accountIds[l.account_name]);
    if (missing.length > 0) {
      errors.push({
        purchase_id: parsed.purchase_id,
        reason: 'coa_account_missing',
        missing: missing.map(m => m.account_name),
      });
      continue;
    }

    // Sum lines should equal total_amt (within rounding)
    const lineSum = parsed.lines.reduce((a, l) => a + l.amount, 0);
    if (Math.abs(lineSum - parsed.total_amt) > 0.05) {
      errors.push({
        purchase_id: parsed.purchase_id,
        reason: 'lines_dont_sum_to_total',
        line_sum: lineSum,
        total_amt: parsed.total_amt,
      });
      continue;
    }

    const entryId = crypto.randomUUID();
    const totalDebit = parsed.total_amt;
    const totalCredit = parsed.total_amt;

    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21_validate', ?)
    `).bind(
      entryId, parsed.txn_date,
      `Mercury Credit ${parsed.is_credit ? 'refund' : 'purchase'} · ${parsed.vendor} · ${parsed.private_note}`.slice(0, 250),
      SOURCE_TYPE, sourceId, totalDebit, totalCredit,
      `QBO Purchase ${parsed.purchase_id}. ${parsed.lines.length} expense line(s). ${parsed.is_credit ? 'Refund (DR Mercury Credit / CR expense)' : 'Purchase (DR expense / CR Mercury Credit)'}.`
    ).run();

    let lineNum = 1;
    if (parsed.is_credit) {
      // Refund: DR Mercury Credit, CR expense accounts
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, mcId, parsed.total_amt, `Refund credit ${parsed.vendor}`).run();
      for (const line of parsed.lines) {
        await env.DB.prepare(`
          INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
          VALUES (?, ?, ?, ?, 0, ?, ?)
        `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[line.account_name], line.amount, line.description.slice(0, 200)).run();
      }
    } else {
      // Purchase: DR expense accounts, CR Mercury Credit
      for (const line of parsed.lines) {
        await env.DB.prepare(`
          INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `).bind(crypto.randomUUID(), entryId, lineNum++, accountIds[line.account_name], line.amount, line.description.slice(0, 200)).run();
      }
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, lineNum++, mcId, parsed.total_amt, `Mercury Credit charge ${parsed.vendor}`).run();
    }

    posted.push({
      purchase_id: parsed.purchase_id,
      entry_id: entryId,
      txn_date: parsed.txn_date,
      vendor: parsed.vendor,
      amount: parsed.total_amt,
      is_credit: parsed.is_credit,
      lines: parsed.lines.length,
    });
  }

  // Audit log entry
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'mercury_credit_ingest', 'journal_entries', ?, 'session_21_validate', ?, ?)
  `).bind(
    crypto.randomUUID(), `mc_ingest_${year}_${Date.now()}`,
    `Ingested ${posted.length} Mercury Credit purchases for FY${year}`,
    JSON.stringify({ posted: posted.length, skipped: skipped.length, errors: errors.length })
  ).run().catch(() => {});

  return {
    ok: true,
    year,
    purchases_processed: purchases.length,
    posted: posted.length,
    skipped: skipped.length,
    errors: errors.length,
    total_amount_posted: Math.round(posted.reduce((a, p) => a + p.amount * (p.is_credit ? -1 : 1), 0) * 100) / 100,
    error_details: errors.slice(0, 10),
    skip_details: skipped.slice(0, 10),
  };
}

// Verify Mercury Credit GL balance and Pre-Pretzel-OS Reconciliation after ingestion
export async function verifyMercuryCreditState(env) {
  const { results } = await env.DB.prepare(`
    SELECT strftime('%Y-%m', j.entry_date) as period,
           ROUND(SUM(CASE WHEN c.account_name = 'Mercury Credit (0000) - 1' THEN l.credit - l.debit ELSE 0 END), 2) as mc_change,
           ROUND(SUM(CASE WHEN c.account_name = 'Pre-Pretzel-OS Reconciliation' THEN l.credit - l.debit ELSE 0 END), 2) as offset_change
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_entry_id = j.id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
    GROUP BY period
    ORDER BY period
  `).all();

  let mcRunning = 0;
  let offsetRunning = 0;
  const summary = [];
  for (const r of results || []) {
    mcRunning += r.mc_change || 0;
    offsetRunning += r.offset_change || 0;
    summary.push({
      period: r.period,
      mercury_credit_balance: Math.round(mcRunning * 100) / 100,
      pre_pretzel_os_balance: Math.round(offsetRunning * 100) / 100,
    });
  }
  return { ok: true, summary };
}
