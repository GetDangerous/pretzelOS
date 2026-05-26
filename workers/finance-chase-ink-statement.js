// workers/finance-chase-ink-statement.js
// Session 21V-Chase (May 15 2026)
//
// Parse Chase Ink Business Cash credit card statements (••3178). Drew opened
// the card March 2026, replacing/supplementing Mercury IO Credit. No Plaid
// integration yet. Statements are the source of truth.
//
// JE pattern per Chase Ink statement:
//   - For each charge txn: DR Expense / CR Chase Ink Business (3178)
//   - For each payment: DR Chase Ink Business (3178) / CR (source account)
//   - For fees/interest: DR Bank fees & service charges (or Interest paid) / CR Chase
//
// Idempotency: source_type='chase_ink_statement_txn', source_id=YYYY-MM:line

import { isReadOnly, readOnlySkip } from './finance-shared.js';
import { callAI } from './ai-budget.js';
import { lookupVendor } from './finance-vendor-kb.js';

const CHASE_ACCOUNT_NAME = 'Chase Ink Business (3178)';
const TXN_SOURCE_TYPE = 'chase_ink_statement_txn';

const EXTRACTION_PROMPT = `You are extracting transaction data from a Chase Ink Business Cash credit card monthly statement PDF.

Return STRICT JSON with this shape:
{
  "statement_month": "YYYY-MM",  // from cover header (the month the statement is FOR — e.g. May 2026 statement closing 05/04 → 2026-05)
  "period_start": "YYYY-MM-DD",  // opening date
  "period_end": "YYYY-MM-DD",    // closing date
  "summary": {
    "previous_balance": <number>,
    "payments_credits": <number>,
    "purchases": <number>,
    "fees_charged": <number>,
    "interest_charged": <number>,
    "new_balance": <number>,
    "minimum_payment": <number>
  },
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "merchant or charge description",
      "amount": <number>,  // POSITIVE for charges, NEGATIVE for payments/credits
      "type": "charge" | "payment" | "fee" | "interest" | "credit"
    }
  ]
}

Rules:
- Extract every transaction in ACCOUNT ACTIVITY section
- Chase shows charges as POSITIVE amounts (opposite of Mercury IO) — keep that convention
- Payments show as negative or labeled "PAYMENT"/"Credit"
- "LATE FEE" → type='fee'
- "FLEX FOR BUSINESS INTEREST CHARGE" or any interest → type='interest'
- "PAYMENT THANK YOU" or any payment toward card → type='payment'
- Other vendor charges → type='charge'
- Use period_end year for dates shown as MM/DD only
- Output ONLY valid JSON, no commentary, no markdown fence`;

async function extractStatement(env, pdfBase64) {
  const result = await callAI(env, {
    use_case: 'chase_ink_statement_extract',
    model: 'sonnet',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: EXTRACTION_PROMPT }
      ]
    }]
  });
  const text = result.content || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return { ok: true, parsed: JSON.parse(cleaned) }; }
  catch (e) { return { ok: false, error: 'JSON parse failed', raw_text: text.slice(0, 2000) }; }
}

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

async function categorizeTxn(env, vendor) {
  const v = await lookupVendor(env, vendor);
  if (v.found) return { account_name: v.account_name, source: v.source, confidence: v.confidence };
  return { account_name: 'Ask My Accountant', source: 'fallback_unknown_vendor', confidence: 0 };
}

export async function previewChaseInkIngest(env, pdfBase64, period) {
  const extract = await extractStatement(env, pdfBase64);
  if (!extract.ok) return { ok: false, ...extract };
  const data = extract.parsed;
  const txns = data.transactions || [];
  let chargeCount = 0, paymentCount = 0, feeCount = 0, interestCount = 0;
  const sample = [];
  for (const t of txns) {
    if (t.type === 'payment') paymentCount++;
    else if (t.type === 'fee') feeCount++;
    else if (t.type === 'interest') interestCount++;
    else chargeCount++;
    if (sample.length < 30 && t.type === 'charge') {
      const cat = await categorizeTxn(env, t.description);
      sample.push({ ...t, proposed_account: cat.account_name, source: cat.source, confidence: cat.confidence });
    } else if (sample.length < 30) {
      sample.push({ ...t });
    }
  }
  return {
    ok: true,
    period: period || data.statement_month,
    summary: data.summary,
    txn_count: txns.length,
    charges: chargeCount, payments: paymentCount, fees: feeCount, interest: interestCount,
    sample,
  };
}

export async function ingestChaseInkStatement(env, pdfBase64, period, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'chase_ink_statement_ingest' });

  const extract = await extractStatement(env, pdfBase64);
  if (!extract.ok) return { ok: false, ...extract };
  const data = extract.parsed;
  const txns = data.transactions || [];
  const statementMonth = period || data.statement_month;
  if (!statementMonth || !/^\d{4}-\d{2}$/.test(statementMonth)) {
    return { ok: false, error: `invalid statement period: ${statementMonth}` };
  }

  const accountIds = await resolveAccountIds(env);
  const chaseId = accountIds[CHASE_ACCOUNT_NAME];
  if (!chaseId) return { ok: false, error: `${CHASE_ACCOUNT_NAME} not found in COA` };
  const bankFeesId = accountIds['Bank fees & service charges'];
  const interestId = accountIds['Interest paid'];

  // Idempotency
  const { results: existing } = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE source_type = ? AND source_id LIKE ? AND status='posted'`
  ).bind(TXN_SOURCE_TYPE, `${statementMonth}%`).all();
  if ((existing || []).length > 0 && !opts.force) {
    return { ok: false, error: 'already_ingested', existing_je_count: existing.length, hint: 'pass force=true to reverse + re-ingest' };
  }
  if ((existing || []).length > 0 && opts.force) {
    for (const row of existing) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-rewound at ' || datetime('now') WHERE id = ?`
      ).bind(row.id).run();
    }
  }

  const posted = [];
  const errors = [];
  let lineNumber = 0;

  for (const t of txns) {
    lineNumber++;
    const sourceId = `${statementMonth}:${lineNumber}`;
    if (!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
      errors.push({ line: lineNumber, reason: 'bad_date', txn: t }); continue;
    }
    if (typeof t.amount !== 'number' || t.amount === 0) {
      errors.push({ line: lineNumber, reason: 'bad_amount', txn: t }); continue;
    }

    const absAmt = Math.abs(t.amount);
    const entryId = crypto.randomUUID();
    let je_lines = [];
    let desc = '';

    if (t.type === 'payment' || (t.amount < 0 && t.type !== 'credit')) {
      // Payment toward Chase. Default source: Mercury Checking
      const checkingId = accountIds['Mercury Checking (0118) - 1'];
      je_lines = [
        { account_id: chaseId, debit: absAmt, credit: 0, memo: 'Chase Ink payment' },
        { account_id: checkingId, debit: 0, credit: absAmt, memo: 'Payment to Chase Ink ••3178' },
      ];
      desc = `Chase Ink payment · ${t.description}`;
    } else if (t.type === 'fee') {
      if (!bankFeesId) { errors.push({ line: lineNumber, reason: 'no_bank_fees_acct', txn: t }); continue; }
      je_lines = [
        { account_id: bankFeesId, debit: absAmt, credit: 0, memo: `Chase Ink fee · ${t.description}` },
        { account_id: chaseId, debit: 0, credit: absAmt, memo: `Chase Ink fee` },
      ];
      desc = `Chase Ink fee · ${t.description}`;
    } else if (t.type === 'interest') {
      if (!interestId) { errors.push({ line: lineNumber, reason: 'no_interest_acct', txn: t }); continue; }
      je_lines = [
        { account_id: interestId, debit: absAmt, credit: 0, memo: `Chase Ink interest · ${t.description}` },
        { account_id: chaseId, debit: 0, credit: absAmt, memo: `Chase Ink interest charge` },
      ];
      desc = `Chase Ink interest · ${t.description}`;
    } else if (t.type === 'credit' || (t.amount < 0 && t.type === 'credit')) {
      // Vendor refund — DR Chase, CR previously-charged expense
      const cat = await categorizeTxn(env, t.description);
      const exId = accountIds[cat.account_name];
      if (!exId) { errors.push({ line: lineNumber, reason: 'coa_missing', proposed: cat.account_name, txn: t }); continue; }
      je_lines = [
        { account_id: chaseId, debit: absAmt, credit: 0, memo: `Credit from ${t.description}` },
        { account_id: exId, debit: 0, credit: absAmt, memo: `Credit/refund: ${t.description}` },
      ];
      desc = `Chase Ink credit · ${t.description}`;
    } else {
      // Standard charge
      const cat = await categorizeTxn(env, t.description);
      const exId = accountIds[cat.account_name];
      if (!exId) { errors.push({ line: lineNumber, reason: 'coa_missing', proposed: cat.account_name, txn: t }); continue; }
      je_lines = [
        { account_id: exId, debit: absAmt, credit: 0, memo: t.description.slice(0, 200) },
        { account_id: chaseId, debit: 0, credit: absAmt, memo: `Chase Ink charge ${t.description.slice(0, 100)}` },
      ];
      desc = `Chase Ink charge · ${t.description}`;
    }

    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21v_chase', ?)
    `).bind(
      entryId, t.date, desc.slice(0, 250), TXN_SOURCE_TYPE, sourceId,
      absAmt, absAmt,
      `Chase Ink ${statementMonth} statement line ${lineNumber} (type=${t.type})`
    ).run();

    for (let i = 0; i < je_lines.length; i++) {
      const ln = je_lines[i];
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), entryId, i + 1, ln.account_id, ln.debit, ln.credit, ln.memo.slice(0, 200)).run();
    }

    posted.push({ line: lineNumber, date: t.date, type: t.type, vendor: t.description, amount: t.amount, entry_id: entryId });
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'chase_ink_statement_ingest', 'journal_entries', ?, 'session_21v', ?, ?)
  `).bind(
    crypto.randomUUID(), `chase_ink_${statementMonth}_${Date.now()}`,
    `Chase Ink statement ${statementMonth} ingested: ${posted.length} txns`,
    JSON.stringify({ statement_month: statementMonth, posted: posted.length, errors: errors.length })
  ).run().catch(() => {});

  return {
    ok: true, period: statementMonth, posted: posted.length, errors: errors.length,
    summary: data.summary, error_details: errors.slice(0, 10),
  };
}
