// workers/finance-je-poster.js
// Finance v2 — CFO Agent v2, journal-entry poster (C-5).
//
// Converts categorized Mercury transactions into double-entry journal entries
// and marks the underlying txn as `is_reconciled=1`.
//
// Entry shape for a single Mercury transaction:
//   Inflow  (amount > 0):  Debit  Mercury account,   Credit proposed_account
//   Outflow (amount < 0):  Debit  proposed_account,  Credit Mercury account
//
// Double-entry invariant enforced by `journal_entries.CHECK(ABS(total_debit - total_credit) < 0.01)`
// and `journal_entry_lines.CHECK(debit XOR credit)`.
//
// Endpoints (registered in finance-worker.js):
//   POST /finance/cfo/post-jes[?limit=N&min_confidence=0.90]
//   POST /finance/cfo/post-jes-one?txn_id=X
//   GET  /finance/cfo/posted-stats
//   POST /finance/cfo/reverse-je?entry_id=X       (for mistakes)
//
// Safety:
//   - Only posts if proposed_account_id is set AND proposed_confidence >= min_confidence
//   - Skips transactions already reconciled (`is_reconciled=1`)
//   - Skips transactions that land in a closed period (per closed_periods)
//   - Every post gets an audit log entry + is reversible via entry_reversal_of_entry_id chain

import { isReadOnly, readOnlySkip } from './finance-shared.js';
import { auditPostJe, auditReverseJe } from './audit-trail.js';

// ── Mercury account → COA id resolver (cached per invocation) ─────────────
let _mercuryAccountCache = null;
async function resolveMercuryAccountId(env, mercuryAccountName) {
  if (!_mercuryAccountCache) {
    const { results } = await env.DB.prepare(`
      SELECT id, account_name FROM chart_of_accounts
      WHERE LOWER(account_name) LIKE 'mercury %'
    `).all();
    _mercuryAccountCache = new Map();
    for (const r of (results || [])) {
      // Key by the 4-digit account suffix (0118, 5450, 0000)
      const m = r.account_name.match(/\((\d{4})\)/);
      if (m) _mercuryAccountCache.set(m[1], r.id);
    }
  }
  // Mercury API names are "Mercury Checking ••0118" — extract the 4 digits
  const m = (mercuryAccountName || '').match(/\b(\d{4})\b/);
  if (m) return _mercuryAccountCache.get(m[1]);
  return null;
}

// ── Closed-period check ──────────────────────────────────────────────────
async function isInClosedPeriod(env, date) {
  const row = await env.DB.prepare(
    `SELECT id FROM closed_periods WHERE period_start <= ? AND period_end >= ? AND unlocked_at IS NULL LIMIT 1`
  ).bind(date, date).first();
  return !!row;
}

// ── Post one JE for one txn ──────────────────────────────────────────────
export async function postJeForTxn(env, txn, opts = {}) {
  if (!txn.proposed_account_id) return { skipped: 'no_proposal' };
  if (txn.is_reconciled) return { skipped: 'already_reconciled' };

  const minConfidence = opts.min_confidence ?? 0.90;
  if ((txn.proposed_confidence ?? 0) < minConfidence) {
    return { skipped: 'below_confidence_threshold', confidence: txn.proposed_confidence };
  }

  // Closed period guard — RTR-5 (Session 12): instead of silently skipping,
  // route to the late_txn_buffer so Drew sees the issue + decides what to do.
  if (await isInClosedPeriod(env, txn.txn_date)) {
    try {
      const { bufferLateTxn } = await import('./finance-late-txns.js');
      await bufferLateTxn(env, {
        source_type: 'mercury',
        source_id: txn.id,
        intended_entry_date: (txn.txn_date || '').slice(0, 10),
        amount: txn.amount,
        counterparty: txn.counterparty_name || txn.description || null,
        reason: 'period_closed',
        proposed_je: {
          description: `Mercury ${(Number(txn.amount) > 0) ? 'inflow' : 'outflow'} · ${txn.counterparty_name || txn.description || 'untagged'}`,
          proposed_account_id: txn.proposed_account_id,
          proposed_confidence: txn.proposed_confidence,
          proposed_reasoning: txn.proposed_reasoning,
        },
      });
    } catch (e) { /* buffer failed — fall through to skip */ }
    return { skipped: 'in_closed_period_buffered', date: txn.txn_date, note: 'See /finance/late-txns for review' };
  }

  // Read-only mode guard — trip by the daily reconciliation when variance > $50 × 2d.
  // User-initiated paths (review queue / bulk approve) pass bypass_read_only because
  // they are the mechanism that CLOSES the gap that tripped read-only.
  if (!opts.bypass_read_only && (await isReadOnly(env))) return readOnlySkip({ txn_id: txn.id });

  // Resolve the Mercury bank-side account
  const mercuryAccountId = await resolveMercuryAccountId(env, txn.account_name);
  if (!mercuryAccountId) return { skipped: 'mercury_account_not_in_coa', mercury_account: txn.account_name };

  const amount = Math.abs(Number(txn.amount) || 0);
  if (amount < 0.01) return { skipped: 'zero_amount' };
  const isInflow = Number(txn.amount) > 0;

  // Self-referential guard: if the categorizer proposed the SAME account as the
  // Mercury bank-side, this is a no-op (DR + CR same account = trash). This
  // catches both the inflow side of intercompany transfers (where the categorizer
  // explicitly marked it for skip via the resolver) and any other categorizer bug
  // that would produce a self-pair JE.
  if (txn.proposed_account_id === mercuryAccountId) {
    // Mark as reconciled to skip future re-processing, but DON'T post a JE.
    // The matching outflow on the other Mercury account will post the real JE.
    await env.DB.prepare(
      `UPDATE mercury_transactions SET is_reconciled = 1, matched_journal_entry_id = NULL, notes = COALESCE(notes,'') || ' | Intercompany inflow — no JE posted; matching outflow records the transfer.' WHERE id = ?`
    ).bind(txn.id).run().catch(() => {});
    return { skipped: 'intercompany_inflow_no_je', mercury_account: txn.account_name };
  }

  const entryId = crypto.randomUUID();
  const line1Id = crypto.randomUUID();
  const line2Id = crypto.randomUUID();

  // Debits/credits:
  //   inflow:  Dr Mercury (bank), Cr proposed (income/clearing)
  //   outflow: Dr proposed (expense), Cr Mercury (bank)
  const debitAccount  = isInflow ? mercuryAccountId       : txn.proposed_account_id;
  const creditAccount = isInflow ? txn.proposed_account_id : mercuryAccountId;

  // Create the JE header
  try {
    await env.DB.prepare(`
      INSERT INTO journal_entries (
        id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes
      ) VALUES (?, ?, ?, 'mercury_txn', ?, ?, ?, 'posted', 'cfo_agent', ?)
    `).bind(
      entryId,
      (txn.txn_date || '').slice(0, 10),
      `Mercury ${isInflow ? 'inflow' : 'outflow'} · ${txn.counterparty_name || txn.description || 'untagged'}`.slice(0, 255),
      txn.id,
      amount,
      amount,
      (txn.proposed_reasoning || 'Auto-posted by CFO Agent v2 categorizer').slice(0, 500),
    ).run();
  } catch (err) {
    return { error: 'je_header_insert_failed', detail: err.message };
  }

  // Lines
  try {
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 1, ?, ?, 0, ?)
    `).bind(line1Id, entryId, debitAccount, amount, `${txn.counterparty_name || ''} ${txn.description || ''}`.slice(0, 255).trim()).run();
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 2, ?, 0, ?, ?)
    `).bind(line2Id, entryId, creditAccount, amount, `offset for ${txn.id}`).run();
  } catch (err) {
    // Rollback header on line-insert failure
    await env.DB.prepare(`DELETE FROM journal_entries WHERE id = ?`).bind(entryId).run().catch(() => {});
    return { error: 'je_lines_insert_failed', detail: err.message };
  }

  // Mark the Mercury txn as reconciled + linked
  await env.DB.prepare(`
    UPDATE mercury_transactions
    SET is_reconciled = 1, matched_journal_entry_id = ?
    WHERE id = ?
  `).bind(entryId, txn.id).run();

  // Phase A Week 1 B1: audit_trail entry for this JE post
  await auditPostJe(env, {
    je_id: entryId,
    source_type: 'mercury_txn',
    je_data: {
      id: entryId,
      entry_date: (txn.txn_date || '').slice(0, 10),
      total_debit: amount,
      total_credit: amount,
      direction: isInflow ? 'inflow' : 'outflow',
      debit_account: debitAccount,
      credit_account: creditAccount,
    },
    metadata: {
      mercury_txn_id: txn.id,
      counterparty: txn.counterparty_name || null,
      proposed_confidence: txn.proposed_confidence || null,
      categorizer_reasoning: (txn.proposed_reasoning || '').slice(0, 200) || null,
    },
  }).catch(err => {
    // Don't fail the JE post if audit write fails — log and continue
    console.error('[je-poster] audit_trail write failed for', entryId, err.message);
  });

  return {
    posted: true,
    entry_id: entryId,
    direction: isInflow ? 'inflow' : 'outflow',
    amount,
    debit_account: debitAccount,
    credit_account: creditAccount,
  };
}

// ── Batch poster ─────────────────────────────────────────────────────────
export async function postJeBatch(env, opts = {}) {
  _mercuryAccountCache = null;  // fresh resolver
  const minConfidence = opts.min_confidence ?? 0.90;
  const limit = Math.min(opts.limit || 300, 1000);

  const { results: txns } = await env.DB.prepare(`
    SELECT id, txn_date, account_name, amount, counterparty_name, description,
           proposed_account_id, proposed_confidence, proposed_reasoning, is_reconciled
    FROM mercury_transactions
    WHERE proposed_account_id IS NOT NULL
      AND is_reconciled = 0
      AND proposed_confidence >= ?
    ORDER BY txn_date ASC
    LIMIT ?
  `).bind(minConfidence, limit).all();

  const stats = {
    scanned: txns?.length || 0,
    posted: 0,
    skipped: 0,
    errored: 0,
    total_debit: 0,
    total_credit: 0,
    skip_reasons: {},
    errors: [],
    entry_ids_sample: [],
  };

  for (const txn of (txns || [])) {
    const res = await postJeForTxn(env, txn, { min_confidence: minConfidence });
    if (res.posted) {
      stats.posted += 1;
      stats.total_debit += res.amount;
      stats.total_credit += res.amount;
      if (stats.entry_ids_sample.length < 5) stats.entry_ids_sample.push(res.entry_id);
    } else if (res.error) {
      stats.errored += 1;
      stats.errors.push({ txn_id: txn.id, error: res.error, detail: res.detail });
    } else {
      stats.skipped += 1;
      stats.skip_reasons[res.skipped] = (stats.skip_reasons[res.skipped] || 0) + 1;
    }
  }

  stats.total_debit = Math.round(stats.total_debit * 100) / 100;
  stats.total_credit = Math.round(stats.total_credit * 100) / 100;

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'cfo_je_batch_posted', 'journal_entries', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `batch_${Date.now()}`,
    `Posted ${stats.posted} JEs, total $${stats.total_debit} (scanned ${stats.scanned}, skipped ${stats.skipped}, errored ${stats.errored})`,
    JSON.stringify(stats)
  ).run();

  return stats;
}

// ── Single-txn manual posting ────────────────────────────────────────────
export async function postJeOne(env, txnId) {
  _mercuryAccountCache = null;
  const txn = await env.DB.prepare(`
    SELECT id, txn_date, account_name, amount, counterparty_name, description,
           proposed_account_id, proposed_confidence, proposed_reasoning, is_reconciled
    FROM mercury_transactions WHERE id = ?
  `).bind(txnId).first();
  if (!txn) return { error: 'transaction not found' };
  return await postJeForTxn(env, txn, { min_confidence: 0 });  // manual path bypasses threshold
}

// ── Reverse a JE (posts offsetting entry) ────────────────────────────────
export async function reverseJe(env, entryId, reason) {
  const entry = await env.DB.prepare(
    `SELECT * FROM journal_entries WHERE id = ?`
  ).bind(entryId).first();
  if (!entry) return { error: 'entry not found' };
  if (entry.status === 'reversed') return { error: 'already reversed' };

  const { results: lines } = await env.DB.prepare(
    `SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_number`
  ).bind(entryId).all();

  const reversalId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO journal_entries (
      id, entry_date, description, source_type, source_id,
      total_debit, total_credit, status, reversal_of_entry_id, created_by, notes
    ) VALUES (?, date('now'), ?, 'manual', ?, ?, ?, 'posted', ?, 'cfo_agent', ?)
  `).bind(
    reversalId,
    `REVERSAL: ${entry.description}`.slice(0, 255),
    entryId,
    entry.total_debit, entry.total_credit,
    entryId,
    (reason || 'Manual reversal').slice(0, 500)
  ).run();

  let lineNum = 1;
  for (const line of (lines || [])) {
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), reversalId, lineNum++,
      line.account_id,
      line.credit, line.debit,  // swap!
      `Reversal of ${entryId} line ${line.line_number}`
    ).run();
  }

  await env.DB.prepare(`UPDATE journal_entries SET status = 'reversed' WHERE id = ?`).bind(entryId).run();

  // Unlink source Mercury txn if applicable
  if (entry.source_type === 'mercury_txn' && entry.source_id) {
    await env.DB.prepare(
      `UPDATE mercury_transactions SET is_reconciled = 0, matched_journal_entry_id = NULL WHERE id = ?`
    ).bind(entry.source_id).run();
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'je_reversed', 'journal_entries', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), entryId,
    `Reversed JE ${entryId}: ${reason || 'no reason given'}`,
    JSON.stringify({ reversal_id: reversalId, original_entry: entry })
  ).run();

  // Phase A Week 1 B1: audit_trail entries (2 — one for reversal JE post, one for status flip)
  await auditPostJe(env, {
    je_id: reversalId,
    source_type: 'manual_reversal',
    actor: 'drew',
    je_data: {
      id: reversalId,
      entry_date: new Date().toISOString().slice(0, 10),
      total_debit: entry.total_debit,
      total_credit: entry.total_credit,
      reversal_of: entryId,
    },
    metadata: { reverses_entry_id: entryId, reverses_source_type: entry.source_type, reason },
  }).catch(err => console.error('[je-poster] audit reversal post failed:', err.message));

  await auditReverseJe(env, {
    je_id: entryId,
    source_type: entry.source_type || 'unknown',
    actor: 'drew',
    reason,
    metadata: { reversal_id: reversalId },
  }).catch(err => console.error('[je-poster] audit reverse failed:', err.message));

  return { reversed: true, reversal_id: reversalId, original_entry_id: entryId };
}

// ── Stats ────────────────────────────────────────────────────────────────
// Phase 4 reset Apr 30 2026: split total_volume into source_volume vs sweep_volume.
//
// Why: revenue-sweep posts a SECOND JE for every Mercury inflow that lands in
// a Clearing account. Toast deposit $1,000:
//   1. Mercury inflow JE: Dr Mercury $1k, Cr Clearing:Toast $1k  (posted by post-jes)
//   2. Sweep JE:          Dr Clearing:Toast $1k, Cr Sales       (posted by sweep)
// Both add to total_debit. So the same $1k counts twice in raw `total_volume`.
//
// `source_volume` = JEs from real Mercury txns + manual + opening_balance
// (the "money flowed once" count).
// `sweep_volume` = JEs from revenue-sweep (the offsetting clearing→revenue leg).
// `total_volume` = both summed (kept for backward compatibility, but the
// honest number is `source_volume`).
//
// Other source types in use: mercury_txn, revenue_sweep, opening_balance,
// monthly_close (depreciation), capitalize (asset capitalize), loan_payment.
const SWEEP_SOURCE_TYPES = ['revenue_sweep'];
export async function postedStats(env) {
  const [overall, byMonth, bySourceType] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total_entries,
             ROUND(SUM(total_debit), 2) as total_volume,
             ROUND(SUM(CASE WHEN source_type IN ('revenue_sweep') THEN total_debit ELSE 0 END), 2) as sweep_volume,
             ROUND(SUM(CASE WHEN source_type NOT IN ('revenue_sweep') OR source_type IS NULL THEN total_debit ELSE 0 END), 2) as source_volume,
             SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) as posted,
             SUM(CASE WHEN status = 'reversed' THEN 1 ELSE 0 END) as reversed,
             SUM(CASE WHEN source_type IN ('revenue_sweep') THEN 1 ELSE 0 END) as sweep_entries,
             SUM(CASE WHEN source_type NOT IN ('revenue_sweep') OR source_type IS NULL THEN 1 ELSE 0 END) as source_entries
      FROM journal_entries
    `).first(),
    env.DB.prepare(`
      SELECT SUBSTR(entry_date, 1, 7) as month, COUNT(*) as n,
             ROUND(SUM(total_debit), 2) as volume,
             ROUND(SUM(CASE WHEN source_type NOT IN ('revenue_sweep') OR source_type IS NULL THEN total_debit ELSE 0 END), 2) as source_volume,
             ROUND(SUM(CASE WHEN source_type IN ('revenue_sweep') THEN total_debit ELSE 0 END), 2) as sweep_volume
      FROM journal_entries
      WHERE status = 'posted'
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `).all(),
    env.DB.prepare(`
      SELECT source_type, COUNT(*) as n, ROUND(SUM(total_debit), 2) as volume
      FROM journal_entries
      WHERE status = 'posted'
      GROUP BY source_type
      ORDER BY n DESC
    `).all(),
  ]);
  return {
    overall,
    by_month: byMonth.results || [],
    by_source_type: bySourceType.results || [],
    metric_notes: {
      total_volume: 'Sum of total_debit across all JEs. Counts sweep + source double, kept for backward compatibility.',
      source_volume: 'Sum excluding revenue_sweep. The honest "money that flowed" number — use this.',
      sweep_volume: 'Revenue-sweep JEs only (clearing → revenue). Adds to total_volume but is offset by source.',
      sweep_source_types: SWEEP_SOURCE_TYPES,
    },
  };
}
