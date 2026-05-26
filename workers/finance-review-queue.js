// workers/finance-review-queue.js
// Finance v2 — Inline categorization review (M2).
//
// Backs the Money-page review UI. Returns a paginated list of Mercury txns
// that need Drew's attention (uncategorized OR proposed-confidence < 0.90),
// plus a simple accounts dropdown source.
//
// Approve = accept current proposal (or new override) and post JE.
// Override = pick a different account (proposal stays as draft until approved or post-jes runs).
// Reject   = stop proposing anything for this txn (user_overridden=1, proposal cleared).
//
// Endpoints:
//   GET  /finance/cfo/review-queue[?limit=50&min_confidence=0.90]
//   POST /finance/cfo/review/:txn_id/approve  -d {account_id, note}
//   POST /finance/cfo/review/:txn_id/override -d {account_id, note}
//   POST /finance/cfo/review/:txn_id/reject   -d {reason}
//   GET  /finance/cfo/coa-simple  — minimal list for dropdown

import { isReadOnly, readOnlySkip } from './finance-shared.js';
import { postJeForTxn } from './finance-je-poster.js';

function trim(s, n = 80) { return (s || '').slice(0, n); }

// ── Review queue list ────────────────────────────────────────────────────
export async function getReviewQueue(env, opts = {}) {
  const limit = Math.min(parseInt(opts.limit, 10) || 50, 200);
  const minConf = opts.min_confidence ?? 0.90;

  // Three buckets:
  //   uncategorized   — no proposal yet
  //   low_confidence  — proposal present but < minConf
  //   capex_candidate — outflow > $2500 to equipment-like vendor (surfaced separately)
  const { results: uncategorized } = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description, status,
           proposed_account_id, proposed_confidence, proposed_reasoning, user_overridden
    FROM mercury_transactions
    WHERE is_reconciled = 0
      AND proposed_account_id IS NULL
      AND user_overridden = 0
    ORDER BY ABS(amount) DESC
    LIMIT ?
  `).bind(limit).all();

  const { results: lowConf } = await env.DB.prepare(`
    SELECT m.id, m.txn_date, m.amount, m.counterparty_name, m.description, m.status,
           m.proposed_account_id, m.proposed_confidence, m.proposed_reasoning, m.user_overridden,
           c.account_name as proposed_account_name, c.account_type as proposed_account_type
    FROM mercury_transactions m
    LEFT JOIN chart_of_accounts c ON c.id = m.proposed_account_id
    WHERE m.is_reconciled = 0
      AND m.proposed_account_id IS NOT NULL
      AND m.proposed_confidence < ?
      AND m.user_overridden = 0
    ORDER BY ABS(m.amount) DESC
    LIMIT ?
  `).bind(minConf, limit).all();

  // Counts (total, not just the paged rows)
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN proposed_account_id IS NULL AND is_reconciled=0 AND user_overridden=0 THEN 1 ELSE 0 END) as uncategorized,
      SUM(CASE WHEN proposed_account_id IS NOT NULL AND is_reconciled=0 AND user_overridden=0 AND proposed_confidence < ? THEN 1 ELSE 0 END) as low_confidence,
      SUM(CASE WHEN user_overridden=1 THEN 1 ELSE 0 END) as rejected
    FROM mercury_transactions
  `).bind(minConf).first();

  return {
    counts: {
      uncategorized: counts?.uncategorized || 0,
      low_confidence: counts?.low_confidence || 0,
      rejected: counts?.rejected || 0,
    },
    uncategorized: (uncategorized || []).map(t => ({ ...t, txn_date: (t.txn_date || '').slice(0, 10) })),
    low_confidence: (lowConf || []).map(t => ({ ...t, txn_date: (t.txn_date || '').slice(0, 10) })),
    min_confidence: minConf,
    page_limit: limit,
  };
}

// ── Simplified COA for dropdown ──────────────────────────────────────────
export async function getCoaSimple(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, account_name, account_type, account_subtype
    FROM chart_of_accounts
    WHERE is_active = 1
      AND account_type IN ('revenue','expense','cogs','other_income','other_expense','asset','liability','equity')
    ORDER BY account_type, account_name
  `).all();
  return { count: (results || []).length, accounts: results || [] };
}

// NOTE: Review-queue mutations (approve/override/reject/bulk) are NOT blocked
// by FINANCE_READ_ONLY. They are user-initiated reconciliation and are often
// the exact mechanism by which Drew CLOSES the gap that put the system into
// read-only in the first place. Automated paths (post-jes batch, sweep, etc.)
// remain blocked.

// ── Approve = set proposal (from body if given) + post JE ────────────────
export async function approveTxn(env, txnId, body = {}) {
  const txn = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description, status, account_name,
           proposed_account_id, proposed_confidence, proposed_reasoning, is_reconciled
    FROM mercury_transactions WHERE id = ?
  `).bind(txnId).first();
  if (!txn) return { error: 'txn_not_found' };
  if (txn.is_reconciled) return { error: 'already_reconciled' };

  // If body.account_id passed, override the proposal first.
  if (body.account_id) {
    const exists = await env.DB.prepare(
      `SELECT id FROM chart_of_accounts WHERE id = ? AND is_active = 1`
    ).bind(body.account_id).first();
    if (!exists) return { error: 'invalid_account_id' };
    await env.DB.prepare(`
      UPDATE mercury_transactions
      SET proposed_account_id = ?, proposed_confidence = 1.0,
          proposed_reasoning = ?, user_overridden = 1
      WHERE id = ?
    `).bind(body.account_id, trim(body.note || 'User-approved override', 500), txnId).run();
    txn.proposed_account_id = body.account_id;
    txn.proposed_confidence = 1.0;
    txn.proposed_reasoning = body.note || 'User-approved override';
  } else {
    // Just mark the existing proposal as user-approved
    await env.DB.prepare(`
      UPDATE mercury_transactions SET proposed_confidence = 1.0, user_overridden = 1 WHERE id = ?
    `).bind(txnId).run();
    txn.proposed_confidence = 1.0;
  }

  // Post the JE (force through confidence + read-only gates — user-initiated)
  const result = await postJeForTxn(env, txn, { min_confidence: 0, bypass_read_only: true });

  // Audit
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'review_approve', 'mercury_transactions', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), txnId,
    `Drew approved txn ${trim(txn.counterparty_name, 60)} $${Math.abs(txn.amount).toFixed(2)}`,
    JSON.stringify({ account_id: txn.proposed_account_id, post_result: result })
  ).run().catch(() => {});

  return { ok: true, txn_id: txnId, post_result: result };
}

// ── Override = set account but DON'T post yet (draft) ────────────────────
export async function overrideTxn(env, txnId, body = {}) {
  if (!body.account_id) return { error: 'account_id required' };

  const exists = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts WHERE id = ? AND is_active = 1`
  ).bind(body.account_id).first();
  if (!exists) return { error: 'invalid_account_id' };

  const res = await env.DB.prepare(`
    UPDATE mercury_transactions
    SET proposed_account_id = ?, proposed_confidence = 0.99,
        proposed_reasoning = ?
    WHERE id = ? AND is_reconciled = 0
  `).bind(body.account_id, trim(body.note || 'User override (not yet posted)', 500), txnId).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
    VALUES (?, 'review_override', 'mercury_transactions', ?, 'drew', ?)
  `).bind(
    crypto.randomUUID(), txnId,
    `Drew overrode proposal to ${exists.account_name}`
  ).run().catch(() => {});

  return { ok: true, txn_id: txnId, new_account: exists.account_name, changes: res.meta?.changes || 0 };
}

// ── Reject = stop proposing anything; excludes from review queue ─────────
export async function rejectTxn(env, txnId, body = {}) {
  await env.DB.prepare(`
    UPDATE mercury_transactions
    SET proposed_account_id = NULL, proposed_confidence = NULL,
        proposed_reasoning = ?, user_overridden = 1
    WHERE id = ? AND is_reconciled = 0
  `).bind(trim(body.reason || 'User rejected — not a bookkeeping txn', 500), txnId).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
    VALUES (?, 'review_reject', 'mercury_transactions', ?, 'drew', ?)
  `).bind(
    crypto.randomUUID(), txnId,
    `Drew rejected txn from review queue: ${trim(body.reason || '', 120)}`
  ).run().catch(() => {});

  return { ok: true, txn_id: txnId };
}

// ── Undo reject = bring back to queue ────────────────────────────────────
export async function unrejectTxn(env, txnId) {
  await env.DB.prepare(`
    UPDATE mercury_transactions SET user_overridden = 0 WHERE id = ? AND is_reconciled = 0
  `).bind(txnId).run();
  return { ok: true, txn_id: txnId };
}

// ────────────────────────────────────────────────────────────────────────
// BULK APPROVAL BY COUNTERPARTY (the big lever)
// ────────────────────────────────────────────────────────────────────────

function normalizeName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\s-]/g, '');
}

// Return review queue GROUPED by (counterparty normalized, proposed_account_id).
// Each group shows count, $ sum, confidence range, date range, 3 sample txns.
export async function getReviewQueueByCounterparty(env, opts = {}) {
  const minConf = opts.min_confidence ?? 0.90;

  // Group with SQL. Include both low-confidence-with-proposal AND uncategorized.
  const { results } = await env.DB.prepare(`
    SELECT
      LOWER(TRIM(REPLACE(m.counterparty_name, '  ', ' '))) as counterparty_key,
      m.counterparty_name as counterparty_display,
      m.proposed_account_id,
      c.account_name as proposed_account_name,
      c.account_type as proposed_account_type,
      COUNT(*) as txn_count,
      ROUND(SUM(m.amount), 2) as amount_sum,
      ROUND(SUM(CASE WHEN m.amount < 0 THEN m.amount ELSE 0 END), 2) as outflow_sum,
      ROUND(SUM(CASE WHEN m.amount > 0 THEN m.amount ELSE 0 END), 2) as inflow_sum,
      ROUND(MIN(m.proposed_confidence), 2) as min_conf,
      ROUND(MAX(m.proposed_confidence), 2) as max_conf,
      MIN(m.txn_date) as first_date,
      MAX(m.txn_date) as last_date
    FROM mercury_transactions m
    LEFT JOIN chart_of_accounts c ON c.id = m.proposed_account_id
    WHERE m.is_reconciled = 0
      AND m.user_overridden = 0
      AND m.counterparty_name IS NOT NULL
      AND m.counterparty_name != ''
      AND (
        m.proposed_account_id IS NULL
        OR m.proposed_confidence < ?
      )
    GROUP BY counterparty_key, m.proposed_account_id
    ORDER BY ABS(amount_sum) DESC
    LIMIT 200
  `).bind(minConf).all();

  // For each group, pull 3 sample descriptions/dates for Drew to eyeball.
  const groups = [];
  for (const r of (results || [])) {
    const { results: sample } = await env.DB.prepare(`
      SELECT id, txn_date, amount, description
      FROM mercury_transactions
      WHERE LOWER(TRIM(REPLACE(counterparty_name, '  ', ' '))) = ?
        AND is_reconciled = 0 AND user_overridden = 0
        AND (proposed_account_id = ? OR (proposed_account_id IS NULL AND ? IS NULL))
      ORDER BY ABS(amount) DESC
      LIMIT 3
    `).bind(r.counterparty_key, r.proposed_account_id, r.proposed_account_id).all();
    groups.push({
      counterparty_key: r.counterparty_key,
      counterparty_display: r.counterparty_display,
      proposed_account_id: r.proposed_account_id,
      proposed_account_name: r.proposed_account_name || '(uncategorized)',
      proposed_account_type: r.proposed_account_type || null,
      txn_count: r.txn_count,
      amount_sum: r.amount_sum,
      outflow_sum: r.outflow_sum,
      inflow_sum: r.inflow_sum,
      confidence_range: r.proposed_account_id
        ? `${r.min_conf}–${r.max_conf}`
        : 'none',
      date_range: `${(r.first_date || '').slice(0, 10)} → ${(r.last_date || '').slice(0, 10)}`,
      samples: (sample || []).map(s => ({
        id: s.id,
        date: (s.txn_date || '').slice(0, 10),
        amount: s.amount,
        description: (s.description || '').slice(0, 100),
      })),
    });
  }

  // Totals for the banner
  const totalRow = await env.DB.prepare(`
    SELECT
      COUNT(*) as total_txns,
      COUNT(DISTINCT LOWER(TRIM(REPLACE(counterparty_name, '  ', ' ')))) as total_counterparties,
      ROUND(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 2) as total_outflow,
      ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) as total_inflow
    FROM mercury_transactions
    WHERE is_reconciled = 0 AND user_overridden = 0
      AND counterparty_name IS NOT NULL AND counterparty_name != ''
      AND (proposed_account_id IS NULL OR proposed_confidence < ?)
  `).bind(minConf).first();

  return {
    min_confidence: minConf,
    totals: {
      txns_in_queue: totalRow?.total_txns || 0,
      counterparties_in_queue: totalRow?.total_counterparties || 0,
      outflow_dollars: totalRow?.total_outflow || 0,
      inflow_dollars: totalRow?.total_inflow || 0,
    },
    groups,
  };
}

// Bulk approve all txns for a counterparty+proposal group.
//   body: {
//     counterparty_key,              // normalized name
//     proposed_account_id,           // current proposal to match (or null for uncategorized)
//     override_account_id,           // OPTIONAL — if set, use this instead
//     confirm: true,                 // must be true (safety gate)
//     note,                          // audit description
//   }
export async function bulkApproveCounterparty(env, body = {}) {
  if (!body.confirm) return { error: 'confirm: true required' };
  if (!body.counterparty_key) return { error: 'counterparty_key required' };

  // Figure out which account to post to
  let targetAccountId = body.override_account_id || body.proposed_account_id;
  if (!targetAccountId) return { error: 'no target account — either proposed_account_id or override_account_id required' };

  // Verify target exists
  const acct = await env.DB.prepare(
    `SELECT id, account_name, account_type FROM chart_of_accounts WHERE id = ? AND is_active = 1`
  ).bind(targetAccountId).first();
  if (!acct) return { error: 'invalid target account_id' };

  // Find all matching txns
  const matchClause = body.proposed_account_id
    ? 'proposed_account_id = ?'
    : 'proposed_account_id IS NULL';
  const params = body.proposed_account_id
    ? [body.counterparty_key, body.proposed_account_id]
    : [body.counterparty_key];

  // CRITICAL: must include `account_name` — postJeForTxn uses it to resolve
  // the Mercury bank-side account in resolveMercuryAccountId(). Missing it
  // causes every JE to skip with `mercury_account_not_in_coa`.
  const { results: txns } = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name, description, status, account_name,
           proposed_account_id, proposed_confidence, proposed_reasoning, is_reconciled
    FROM mercury_transactions
    WHERE LOWER(TRIM(REPLACE(counterparty_name, '  ', ' '))) = ?
      AND is_reconciled = 0
      AND ${matchClause}
    ORDER BY txn_date
  `).bind(...params).all();

  if (!txns || txns.length === 0) {
    return { ok: true, approved: 0, posted: 0, failed: 0, note: 'no matching txns found' };
  }

  const stats = { approved: 0, posted: 0, failed: 0, errors: [], sample_jes: [] };
  const note = body.note || `Bulk-approved by counterparty: ${body.counterparty_display || body.counterparty_key} → ${acct.account_name}`;

  for (const txn of txns) {
    try {
      // Set the proposal to the target + mark user_overridden
      await env.DB.prepare(`
        UPDATE mercury_transactions
        SET proposed_account_id = ?,
            proposed_confidence = 1.0,
            proposed_reasoning = ?,
            user_overridden = 1
        WHERE id = ?
      `).bind(targetAccountId, note.slice(0, 500), txn.id).run();
      stats.approved += 1;
      txn.proposed_account_id = targetAccountId;
      txn.proposed_confidence = 1.0;

      // Post the JE (bypass confidence gate + read-only since user-initiated)
      const result = await postJeForTxn(env, txn, { min_confidence: 0, bypass_read_only: true });
      if (result?.posted) {
        stats.posted += 1;
        if (stats.sample_jes.length < 3) stats.sample_jes.push({ txn_id: txn.id, je_id: result.entry_id, amount: txn.amount });
      } else if (result?.skipped) {
        stats.failed += 1;
        stats.errors.push({ txn_id: txn.id, reason: result.skipped, detail: result.note || result.reason });
      } else if (result?.error) {
        stats.failed += 1;
        stats.errors.push({ txn_id: txn.id, reason: 'error', detail: result.error });
      }
    } catch (err) {
      stats.failed += 1;
      stats.errors.push({ txn_id: txn.id, reason: 'threw', detail: (err.message || String(err)).slice(0, 200) });
    }
  }

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'bulk_approve_counterparty', 'mercury_transactions', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), `bulk_${Date.now()}`,
    `Drew bulk-approved ${stats.approved} txns from ${body.counterparty_display || body.counterparty_key} → ${acct.account_name}: posted=${stats.posted}, failed=${stats.failed}`,
    JSON.stringify({ counterparty: body.counterparty_key, target_account: acct.account_name, stats: { ...stats, errors: stats.errors.slice(0, 5) } })
  ).run().catch(() => {});

  return {
    ok: true,
    counterparty: body.counterparty_display || body.counterparty_key,
    target_account: acct.account_name,
    ...stats,
    errors: stats.errors.slice(0, 20),
  };
}

// Bulk reject — "stop asking about these, they're not real bookkeeping txns"
export async function bulkRejectCounterparty(env, body = {}) {
  if (!body.confirm) return { error: 'confirm: true required' };
  if (!body.counterparty_key) return { error: 'counterparty_key required' };

  const res = await env.DB.prepare(`
    UPDATE mercury_transactions
    SET proposed_account_id = NULL, proposed_confidence = NULL,
        proposed_reasoning = ?, user_overridden = 1
    WHERE LOWER(TRIM(REPLACE(counterparty_name, '  ', ' '))) = ?
      AND is_reconciled = 0 AND user_overridden = 0
  `).bind(
    (body.reason || 'Bulk rejected — not a bookkeeping txn').slice(0, 500),
    body.counterparty_key,
  ).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
    VALUES (?, 'bulk_reject_counterparty', 'mercury_transactions', ?, 'drew', ?)
  `).bind(
    crypto.randomUUID(), `bulk_reject_${Date.now()}`,
    `Drew bulk-rejected ${res.meta?.changes || 0} txns from ${body.counterparty_display || body.counterparty_key}: ${(body.reason || '').slice(0, 120)}`
  ).run().catch(() => {});

  return { ok: true, rejected: res.meta?.changes || 0 };
}
