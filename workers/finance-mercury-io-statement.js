// workers/finance-mercury-io-statement.js
// Session 21V-Mercury-IO-Statement (May 15 2026)
//
// Parse Mercury IO Credit card monthly statement PDFs and post authoritative
// JEs. Mercury's API does NOT expose credit card data (probed 14 endpoints,
// all 404). The bookkeeper-era QBO archive Purchase records were partial
// (e.g., Oct 2025 QBO showed $3,822 vs statement actual $9,335). Statements
// are the only authoritative source.
//
// Architecture:
//   POST /finance/mercury-io/ingest-statement  (body: { pdf_base64, period })
//   → calls Claude vision to extract structured transactions
//   → for each txn: lookupVendor() to categorize, else surface as question
//   → posts JE per transaction: DR Expense / CR Mercury Credit (or refund: swap)
//   → posts payment JE: DR Mercury Credit / CR Mercury Savings (or Checking)
//
// Idempotency: source_type='mercury_io_statement', source_id=period (YYYY-MM)
//   + per-txn source_id=period:line_number

import { isReadOnly, readOnlySkip } from './finance-shared.js';
import { callAI } from './ai-budget.js';
import { lookupVendor } from './finance-vendor-kb.js';
import { auditPostJe } from './audit-trail.js';

const MERCURY_CREDIT_ACCOUNT_NAME = 'Mercury Credit (0000) - 1';
const STATEMENT_SOURCE_TYPE = 'mercury_io_statement';
const TXN_SOURCE_TYPE = 'mercury_io_statement_txn';

const EXTRACTION_PROMPT = `You are extracting transaction data from a Mercury IO Credit Card monthly statement PDF.

Return STRICT JSON with this shape:
{
  "statement_month": "YYYY-MM",  // from "Month YYYY statement" header
  "period_start": "YYYY-MM-DD",
  "period_end": "YYYY-MM-DD",
  "overview": {
    "limit": <number>,
    "spending": <number>,  // total spend this period
    "cashback": <number>
  },
  "balance": {
    "starting_balance": <number>,  // typically negative if owing
    "posted_transactions": <number>,  // total of all posted txns (negative)
    "manual_payments": <number>,  // payments toward card (positive)
    "automatic_payments": <number>,
    "due_amount": <number>
  },
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "vendor name as shown",
      "card_mask": "3877" | "0475" | null,
      "amount": <number>,  // negative for charges, positive for payments/refunds
      "is_payment": <bool>,  // true if "Credit Account Payment" or transfer in
      "payment_source_account": "Mercury Checking" | "Mercury Savings" | null
    }
  ]
}

Rules:
- Extract EVERY transaction row visible
- amount: negative for card charges; positive for "Credit Account Payment" (incoming payments to settle balance) and refunds
- date format: convert "Jan 03" or "Oct 17" to "YYYY-MM-DD" using statement_month context
- card_mask: extract the last 4 digits from "••3877" or "••0475". For payments from another account, set null
- payment txns have description like "Mercury Savings ••5450" or "Mercury Checking ••0118" — set is_payment=true and payment_source_account
- vendor name should be the merchant exactly as it appears (e.g., "The Webstaurant Store", "Statefoodsafetycom")
- Be exhaustive — multi-page statements will have transactions across pages
- Output ONLY valid JSON, no commentary, no markdown code fence`;

async function extractStatement(env, pdfBase64) {
  const result = await callAI(env, {
    use_case: 'mercury_io_statement_extract',
    model: 'sonnet',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
        },
        { type: 'text', text: EXTRACTION_PROMPT }
      ]
    }]
  });
  const text = result.content || '';
  // Strip optional markdown code fence
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return { ok: true, parsed: JSON.parse(cleaned), raw_text: text };
  } catch (e) {
    return { ok: false, error: 'JSON parse failed', raw_text: text.slice(0, 2000) };
  }
}

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

// Default expense fallback when vendor lookup misses
async function categorizeTxn(env, vendor) {
  try {
    const v = await lookupVendor(env, vendor);
    if (v.found) return { account_name: v.account_name, source: v.source, confidence: v.confidence };
  } catch (e) {
    // Fuzzy match LIKE patterns can hit SQLite complexity limits on certain vendor names
    return { account_name: 'Ask My Accountant', source: 'fallback_lookup_error', confidence: 0, error: e.message };
  }
  return { account_name: 'Ask My Accountant', source: 'fallback_unknown_vendor', confidence: 0 };
}

export async function previewMercuryIOStatementIngest(env, pdfBase64, period) {
  const extract = await extractStatement(env, pdfBase64);
  if (!extract.ok) return { ok: false, ...extract };
  const data = extract.parsed;
  const txns = data.transactions || [];
  let chargeCount = 0, paymentCount = 0, totalCharges = 0, totalPayments = 0;
  const categorization = [];
  for (const t of txns) {
    if (t.is_payment) {
      paymentCount++;
      totalPayments += Math.abs(t.amount);
    } else {
      chargeCount++;
      totalCharges += Math.abs(t.amount);
      const cat = await categorizeTxn(env, t.description);
      if (categorization.length < 30) categorization.push({
        date: t.date, vendor: t.description, amount: t.amount, card: t.card_mask,
        proposed_account: cat.account_name, source: cat.source, confidence: cat.confidence,
      });
    }
  }
  return {
    ok: true,
    period: period || data.statement_month,
    overview: data.overview,
    balance: data.balance,
    txn_count: txns.length,
    charge_count: chargeCount,
    payment_count: paymentCount,
    total_charges: Math.round(totalCharges * 100) / 100,
    total_payments: Math.round(totalPayments * 100) / 100,
    statement_spending_check: Math.abs((data.overview?.spending || 0) - totalCharges) < 0.5,
    categorization_sample: categorization,
  };
}

export async function ingestMercuryIOStatement(env, pdfBase64, period, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'mercury_io_statement_ingest' });

  const extract = await extractStatement(env, pdfBase64);
  if (!extract.ok) return { ok: false, ...extract };
  const data = extract.parsed;
  const txns = data.transactions || [];
  const statementMonth = period || data.statement_month;
  if (!statementMonth || !/^\d{4}-\d{2}$/.test(statementMonth)) {
    return { ok: false, error: `invalid statement period: ${statementMonth}` };
  }

  const accountIds = await resolveAccountIds(env);
  const mcId = accountIds[MERCURY_CREDIT_ACCOUNT_NAME];
  const checkingId = accountIds['Mercury Checking (0118) - 1'];
  const savingsId = accountIds['Mercury Savings (5450) - 1'];
  if (!mcId) return { ok: false, error: `Mercury Credit COA not found` };

  // Idempotency: are we already ingested? Range comparison (faster + no LIKE complexity issue)
  const { results: existing } = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE source_type IN (?, ?) AND source_id >= ? AND source_id < ? AND status='posted'`
  ).bind(STATEMENT_SOURCE_TYPE, TXN_SOURCE_TYPE, `${statementMonth}:`, `${statementMonth};`).all();

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
  const skipped = [];
  const errors = [];
  let lineNumber = 0;

  for (const t of txns) {
    lineNumber++;
    const sourceId = `${statementMonth}:${lineNumber}`;

    if (!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) {
      errors.push({ line: lineNumber, reason: 'bad_date', txn: t });
      continue;
    }
    if (typeof t.amount !== 'number' || t.amount === 0) {
      errors.push({ line: lineNumber, reason: 'bad_amount', txn: t });
      continue;
    }

    const isPayment = t.is_payment === true;
    const absAmt = Math.abs(t.amount);
    const entryId = crypto.randomUUID();
    let je_lines = [];

    if (isPayment) {
      // Payment toward Mercury Credit. DR Mercury Credit / CR (Source account, Checking or Savings)
      let sourceAcctId = null;
      let sourceAcctLabel = t.payment_source_account || '';
      if (/savings/i.test(sourceAcctLabel)) sourceAcctId = savingsId;
      else if (/checking/i.test(sourceAcctLabel)) sourceAcctId = checkingId;
      // Default to Savings if unspecified (per Mercury IO statement pattern)
      if (!sourceAcctId) { sourceAcctId = savingsId; sourceAcctLabel = 'Mercury Savings (5450) - 1 (defaulted)'; }
      je_lines = [
        { account_id: mcId, debit: absAmt, credit: 0, memo: `Mercury IO payment from ${sourceAcctLabel}` },
        { account_id: sourceAcctId, debit: 0, credit: absAmt, memo: `Payment to Mercury IO Credit` },
      ];
    } else {
      // Charge. amount is negative → DR Expense, CR Mercury Credit
      // OR refund (positive amount on a non-payment row) → DR Mercury Credit, CR Expense
      const isRefund = t.amount > 0 && !isPayment;
      const cat = await categorizeTxn(env, t.description);
      const exAcctId = accountIds[cat.account_name];
      if (!exAcctId) {
        errors.push({ line: lineNumber, reason: 'coa_account_missing', proposed: cat.account_name, txn: t });
        continue;
      }
      if (isRefund) {
        je_lines = [
          { account_id: mcId, debit: absAmt, credit: 0, memo: `Refund from ${t.description}` },
          { account_id: exAcctId, debit: 0, credit: absAmt, memo: `Refund: ${t.description}` },
        ];
      } else {
        je_lines = [
          { account_id: exAcctId, debit: absAmt, credit: 0, memo: `${t.description} on ••${t.card_mask || '?'}` },
          { account_id: mcId, debit: 0, credit: absAmt, memo: `Mercury IO charge: ${t.description}` },
        ];
      }
    }

    // Insert JE header
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21v_io_statement', ?)
    `).bind(
      entryId, t.date,
      isPayment
        ? `Mercury IO payment · ${t.description}`.slice(0, 250)
        : `Mercury IO ${t.amount > 0 ? 'refund' : 'charge'} · ${t.description} · ••${t.card_mask || '?'}`.slice(0, 250),
      TXN_SOURCE_TYPE, sourceId,
      absAmt, absAmt,
      `Mercury IO ${statementMonth} statement line ${lineNumber}`
    ).run();

    for (let i = 0; i < je_lines.length; i++) {
      const ln = je_lines[i];
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), entryId, i + 1, ln.account_id, ln.debit, ln.credit, ln.memo.slice(0, 200)).run();
    }

    // Phase A Week 1 B1: audit_trail entry per Mercury IO statement line
    await auditPostJe(env, {
      je_id: entryId,
      source_type: TXN_SOURCE_TYPE,
      actor: 'system:mercury_io_statement_upload',
      je_data: { id: entryId, entry_date: t.date, total_debit: absAmt, total_credit: absAmt, vendor: t.description, is_payment: isPayment },
      metadata: { statement_month: statementMonth, line_number: lineNumber, card_mask: t.card_mask || null, source_id: sourceId },
    }).catch(err => console.error('[mercury-io] audit failed:', err.message));

    posted.push({
      line: lineNumber, date: t.date, vendor: t.description, amount: t.amount,
      is_payment: isPayment, entry_id: entryId,
    });
  }

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'mercury_io_statement_ingest', 'journal_entries', ?, 'session_21v', ?, ?)
  `).bind(
    crypto.randomUUID(), `mercury_io_${statementMonth}_${Date.now()}`,
    `Mercury IO statement ${statementMonth} ingested: ${posted.length} txns`,
    JSON.stringify({ statement_month: statementMonth, posted: posted.length, skipped: skipped.length, errors: errors.length })
  ).run().catch(() => {});

  // Final balance validation per statement summary
  const expectedSpending = data.overview?.spending || 0;
  const actualCharges = posted.filter(p => !p.is_payment && p.amount < 0).reduce((a, p) => a + Math.abs(p.amount), 0);
  const balanceMatch = Math.abs(expectedSpending - actualCharges) < 0.5;

  return {
    ok: true,
    period: statementMonth,
    posted: posted.length,
    skipped: skipped.length,
    errors: errors.length,
    statement_spending: expectedSpending,
    posted_charges_total: Math.round(actualCharges * 100) / 100,
    balance_matches_statement: balanceMatch,
    overview: data.overview,
    balance: data.balance,
    error_details: errors.slice(0, 10),
  };
}

// Verify Mercury Credit GL ending balance per month vs statement
export async function verifyMercuryIOStatements(env) {
  const { results } = await env.DB.prepare(`
    SELECT strftime('%Y-%m', j.entry_date) as period,
           ROUND(SUM(l.credit - l.debit), 2) as mc_monthly_change
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_entry_id = j.id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status='posted' AND c.account_name = ?
    GROUP BY period
    ORDER BY period
  `).bind(MERCURY_CREDIT_ACCOUNT_NAME).all();

  let running = 0;
  const summary = [];
  for (const r of results || []) {
    running += r.mc_monthly_change || 0;
    summary.push({ period: r.period, monthly_change: r.mc_monthly_change, end_balance: Math.round(running * 100) / 100 });
  }
  return { ok: true, summary };
}
