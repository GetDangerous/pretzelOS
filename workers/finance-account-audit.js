// workers/finance-account-audit.js
// Finance v2 — Account forensic audit (Wave 0 spec section 0.3 + 0.6).
//
// Walks the QBO 2025 archive (qbo_archive_entity) for every transaction line
// that hits a named account, aggregates patterns, and asks Claude Sonnet for
// a recommended resolution. Used to investigate stale suspect balances:
//   - Payroll Payable ($46,869 accrued but possibly unpaid)
//   - Ask My Accountant ($4,698 uncategorized)
//   - Sales Tax Payable ($17,808 — Q1 2026 portion now filed; Q4 2025 remainder?)
//   - All 6 clearing accounts ($67,124 total: DoorDash/Uber/Grubhub/CC/Cash)
//
// Reads from qbo_archive_entity (populated by extract2025Archive) — does NOT
// re-hit QBO API. Fast, repeatable, cheap.
//
// Endpoint: POST /finance/audit/account?account=<name>

// DIF-3: model id now resolved via ai-budget.js.

// ── Account name → QBO account id resolver ────────────────────────────────
async function resolveAccount(env, nameOrId) {
  // Try exact match by name, then by id, then by partial name.
  let row = await env.DB.prepare(
    `SELECT id, account_name, account_type, qbo_account_id FROM chart_of_accounts WHERE LOWER(account_name) = LOWER(?)`
  ).bind(nameOrId).first();
  if (!row) {
    row = await env.DB.prepare(
      `SELECT id, account_name, account_type, qbo_account_id FROM chart_of_accounts WHERE qbo_account_id = ?`
    ).bind(nameOrId).first();
  }
  if (!row) {
    row = await env.DB.prepare(
      `SELECT id, account_name, account_type, qbo_account_id FROM chart_of_accounts WHERE LOWER(account_name) LIKE LOWER(?) LIMIT 1`
    ).bind('%' + nameOrId + '%').first();
  }
  return row;
}

// ── Walk archive for transactions hitting this account ────────────────────
// QBO structure varies by entity type:
//   JournalEntry: .Line[].JournalEntryLineDetail.AccountRef {value, name} + PostingType
//   Purchase:     .AccountRef (bank/card account) + .Line[].AccountBasedExpenseLineDetail.AccountRef (expense category)
//   Bill:         .Line[].AccountBasedExpenseLineDetail.AccountRef
//   Payment:      .DepositToAccountRef
//   Deposit:      .Line[].DepositLineDetail.AccountRef (source) + .DepositToAccountRef (destination)
//
// We extract all lines whose AccountRef matches the target account.
async function walkArchive(env, qboAccountId, accountName) {
  const { results } = await env.DB.prepare(
    `SELECT id, entity_type, qbo_id, txn_date, raw_json FROM qbo_archive_entity WHERE entity_type IN ('JournalEntry','Purchase','Bill','Payment','BillPayment','Deposit') ORDER BY txn_date ASC`
  ).all();

  const hits = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const row of (results || [])) {
    let raw;
    try { raw = JSON.parse(row.raw_json); } catch { continue; }
    const hit = findAccountHits(raw, row.entity_type, qboAccountId, accountName);
    for (const h of hit) {
      const line = {
        entity_type: row.entity_type,
        entity_id: row.qbo_id,
        txn_date: row.txn_date,
        amount: h.amount,
        posting_type: h.posting_type,            // 'debit' | 'credit' | null
        description: h.description || raw.PrivateNote || raw.DocNumber || '',
        counterparty: h.counterparty || raw.EntityRef?.name || raw.CustomerRef?.name || raw.VendorRef?.name || null,
        other_account: h.other_account || null,  // the account on the opposite side of the JE
      };
      hits.push(line);
      if (h.posting_type === 'debit')  totalDebit += h.amount || 0;
      if (h.posting_type === 'credit') totalCredit += h.amount || 0;
    }
  }
  return { hits, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit), netBalance: round2(totalCredit - totalDebit) };
}

function findAccountHits(raw, entityType, accountId, accountName) {
  const hits = [];
  const matches = (ref) => {
    if (!ref) return false;
    if (accountId && ref.value === accountId) return true;
    if (accountName && ref.name && ref.name.toLowerCase() === accountName.toLowerCase()) return true;
    return false;
  };

  if (entityType === 'JournalEntry' && Array.isArray(raw.Line)) {
    // Collect "other accounts" (everything NOT the target) to understand the JE's shape.
    const targetLines = [];
    const otherLines = [];
    for (const line of raw.Line) {
      const detail = line.JournalEntryLineDetail || {};
      const ref = detail.AccountRef;
      if (matches(ref)) {
        targetLines.push({
          amount: Number(line.Amount || 0),
          posting_type: (detail.PostingType || '').toLowerCase(),
          description: line.Description,
          counterparty: detail.Entity?.EntityRef?.name,
        });
      } else if (ref) {
        otherLines.push(ref.name);
      }
    }
    for (const t of targetLines) {
      hits.push({ ...t, other_account: otherLines.slice(0, 3).join(' / ') });
    }
  } else if ((entityType === 'Purchase' || entityType === 'Bill') && Array.isArray(raw.Line)) {
    // The AccountRef at the top of a Purchase is the BANK/CARD. Lines point at expense accounts.
    if (matches(raw.AccountRef)) {
      // This account is the payment account — amount is the full TotalAmt (credit to this account).
      hits.push({
        amount: Number(raw.TotalAmt || 0),
        posting_type: 'credit',
        description: raw.PrivateNote || raw.DocNumber || '',
        counterparty: raw.EntityRef?.name || raw.VendorRef?.name,
        other_account: (raw.Line[0]?.AccountBasedExpenseLineDetail?.AccountRef?.name) || null,
      });
    }
    for (const line of raw.Line) {
      const detail = line.AccountBasedExpenseLineDetail || line.ItemBasedExpenseLineDetail;
      if (detail && matches(detail.AccountRef)) {
        hits.push({
          amount: Number(line.Amount || 0),
          posting_type: 'debit',  // expense account is debited
          description: line.Description,
          counterparty: raw.EntityRef?.name || raw.VendorRef?.name,
          other_account: raw.AccountRef?.name,
        });
      }
    }
  } else if (entityType === 'Deposit' && Array.isArray(raw.Line)) {
    if (matches(raw.DepositToAccountRef)) {
      hits.push({
        amount: Number(raw.TotalAmt || 0),
        posting_type: 'debit',
        description: raw.PrivateNote || '',
        counterparty: null,
        other_account: raw.Line[0]?.DepositLineDetail?.AccountRef?.name,
      });
    }
    for (const line of raw.Line) {
      const detail = line.DepositLineDetail;
      if (detail && matches(detail.AccountRef)) {
        hits.push({
          amount: Number(line.Amount || 0),
          posting_type: 'credit',
          description: line.Description,
          counterparty: line.LinkedTxn?.[0]?.TxnType,
          other_account: raw.DepositToAccountRef?.name,
        });
      }
    }
  } else if (entityType === 'Payment' && raw.DepositToAccountRef) {
    if (matches(raw.DepositToAccountRef)) {
      hits.push({
        amount: Number(raw.TotalAmt || 0),
        posting_type: 'debit',
        description: raw.PaymentRefNum,
        counterparty: raw.CustomerRef?.name,
        other_account: 'Accounts Receivable',
      });
    }
  }
  return hits;
}

function round2(n) { return Math.round(n * 100) / 100; }

// ── Aggregate pattern stats ───────────────────────────────────────────────
function aggregatePatterns(hits) {
  const byMonth = {};
  const byCounterparty = {};
  const byOtherAccount = {};
  const byEntityType = {};

  for (const h of hits) {
    const month = h.txn_date?.slice(0, 7) || 'unknown';
    byMonth[month] = byMonth[month] || { count: 0, debit: 0, credit: 0 };
    byMonth[month].count += 1;
    if (h.posting_type === 'debit')  byMonth[month].debit += h.amount;
    if (h.posting_type === 'credit') byMonth[month].credit += h.amount;

    const cp = h.counterparty || '(none)';
    byCounterparty[cp] = byCounterparty[cp] || { count: 0, total: 0 };
    byCounterparty[cp].count += 1;
    byCounterparty[cp].total += (h.posting_type === 'credit' ? h.amount : -h.amount);

    const other = h.other_account || '(unknown)';
    byOtherAccount[other] = (byOtherAccount[other] || 0) + 1;

    byEntityType[h.entity_type] = (byEntityType[h.entity_type] || 0) + 1;
  }

  return {
    by_month: Object.fromEntries(
      Object.entries(byMonth).map(([k, v]) => [k, { count: v.count, debit: round2(v.debit), credit: round2(v.credit), net: round2(v.credit - v.debit) }])
    ),
    top_counterparties: Object.entries(byCounterparty)
      .map(([cp, v]) => ({ counterparty: cp, count: v.count, net_balance: round2(v.total) }))
      .sort((a, b) => Math.abs(b.net_balance) - Math.abs(a.net_balance))
      .slice(0, 10),
    top_other_accounts: Object.entries(byOtherAccount)
      .map(([acc, n]) => ({ other_account: acc, line_count: n }))
      .sort((a, b) => b.line_count - a.line_count)
      .slice(0, 10),
    by_entity_type: byEntityType,
  };
}

// ── Claude analysis ───────────────────────────────────────────────────────
async function analyzeWithClaude(env, accountName, accountType, summary, hits) {
  if (!env.ANTHROPIC_API_KEY) {
    return { analysis: null, reason: 'ANTHROPIC_API_KEY not set — skipping AI analysis' };
  }
  const sampleHits = hits.slice(0, 20);   // just the first 20 for context-window efficiency
  const prompt = `You are a forensic accountant examining a QuickBooks Online account for Dangerous Pretzel Company LLC (single-location food service in Salt Lake City, UT, ~$786K 2025 revenue).

ACCOUNT UNDER REVIEW: "${accountName}" (${accountType})

TRANSACTION AGGREGATES (calendar year 2025):
${JSON.stringify(summary, null, 2)}

SAMPLE TRANSACTIONS (first 20 of ${hits.length} total):
${JSON.stringify(sampleHits, null, 2)}

Your task: identify the pattern of how this account has been used and recommend a resolution. Return STRICT JSON with this exact shape:

{
  "pattern_summary": "<2-3 sentence plain-English explanation of what's been hitting this account>",
  "root_cause": "<what's actually going on — e.g. 'bookkeeper accruing wages but not running payroll', 'clearing account never swept'>",
  "recommended_resolution": "<what the action should be — e.g. 'write off $46,869 to Other Income with Irene sign-off', 'reconcile DoorDash deposits against clearing balance'>",
  "resolution_amount_cents": <integer cents of the write-off/reversal, or 0 if no amount>,
  "resolution_dr_account": "<account to debit, e.g. 'Payroll Payable'>",
  "resolution_cr_account": "<account to credit, e.g. 'Other Income — Stale Liability'>",
  "confidence": "<low | medium | high>",
  "requires_irene_signoff": <true | false>
}

If there's not enough transaction data to reach a conclusion, say so honestly in pattern_summary. Do not invent detail.`;

  // DIF-3 (May 13 2026): wired through ai-budget
  const { callAI } = await import('./ai-budget.js');
  const result = await callAI(env, {
    use_case: 'account_audit_narrative',
    model: 'sonnet',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    caller: 'finance-account-audit.js',
  });
  if (!result.ok) {
    return { analysis: null, reason: result.blocked_reason || result.error || 'Anthropic call failed' };
  }
  const text = result.content || '';
  // Strip fences if Claude added them.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return { analysis: JSON.parse(stripped), raw: null };
  } catch {
    return { analysis: null, raw: text, reason: 'Could not parse Claude JSON output' };
  }
}

// ── Main audit endpoint ───────────────────────────────────────────────────
export async function auditAccount(env, accountNameOrId, opts = {}) {
  const acct = await resolveAccount(env, accountNameOrId);
  if (!acct) {
    return { error: `Account '${accountNameOrId}' not found in chart_of_accounts. Seed with POST /finance/qbo/extract-coa first.` };
  }
  const { hits, totalDebit, totalCredit, netBalance } = await walkArchive(env, acct.qbo_account_id, acct.account_name);
  const summary = aggregatePatterns(hits);

  const response = {
    account: {
      id: acct.id,
      name: acct.account_name,
      type: acct.account_type,
      qbo_account_id: acct.qbo_account_id,
    },
    summary: {
      transaction_count: hits.length,
      total_debit: totalDebit,
      total_credit: totalCredit,
      net_balance_from_archive: netBalance,
      earliest_date: hits[0]?.txn_date,
      latest_date: hits[hits.length - 1]?.txn_date,
      ...summary,
    },
    transactions: opts.include_transactions ? hits : hits.slice(0, 50),
    transactions_truncated: hits.length > 50 && !opts.include_transactions,
  };

  // Claude analysis (optional, controlled by ?ai=1).
  if (opts.ai) {
    const aiResult = await analyzeWithClaude(env, acct.account_name, acct.account_type, response.summary, hits);
    response.ai_analysis = aiResult.analysis || null;
    if (aiResult.raw) response.ai_raw = aiResult.raw;
    if (aiResult.reason) response.ai_error = aiResult.reason;
  }

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'account_audit', 'chart_of_accounts', ?, 'system', ?, ?)
  `).bind(
    crypto.randomUUID(), acct.id,
    `Audited ${acct.account_name}: ${hits.length} txns, net $${netBalance}${opts.ai ? ' (+ AI analysis)' : ''}`,
    JSON.stringify({ hits_count: hits.length, net: netBalance, ai: opts.ai })
  ).run();

  return response;
}
