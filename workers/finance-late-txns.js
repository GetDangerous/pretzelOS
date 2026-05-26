// workers/finance-late-txns.js
// RTR-5 (Session 12) — Late-txn buffer.
//
// When postJeBatch (or any other JE-posting path) encounters a transaction
// whose entry_date falls in a CLOSED period, the txn is buffered here
// instead of being posted (which would either silently corrupt the close OR
// be blocked by Tier 1's no_post_in_closed_period check).
//
// Endpoints:
//   GET  /finance/late-txns              — list pending late txns
//   GET  /finance/late-txns/:id          — single txn detail
//   POST /finance/late-txns/:id/decision — apply Drew's decision
//
// Drew's decisions:
//   reopen        — unlock closed period, post JE, recompute brief, re-lock
//   carry_forward — change entry_date to current month, post normally
//   reject        — discard (mark as rejected, don't post)

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// Check if a date falls in a closed period
export async function isInClosedPeriod(env, entryDate) {
  const row = await env.DB.prepare(
    `SELECT id, period_start, period_end FROM closed_periods
     WHERE ? BETWEEN period_start AND period_end
       AND unlocked_at IS NULL
     LIMIT 1`
  ).bind(entryDate).first();
  return row || null;
}

// Buffer a transaction that should have posted to a closed period.
// Caller passes the full intended JE payload (header + lines).
export async function bufferLateTxn(env, {
  source_type,
  source_id,
  intended_entry_date,
  amount,
  counterparty,
  reason,
  proposed_je,        // { description, total_debit, total_credit, lines: [...] }
}) {
  const id = crypto.randomUUID();
  const intended_period = (intended_entry_date || '').slice(0, 7);
  await env.DB.prepare(`
    INSERT INTO late_txn_buffer
      (id, source_type, source_id, intended_entry_date, intended_period,
       amount, counterparty, reason, proposed_je_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    source_type,
    source_id ?? null,
    intended_entry_date,
    intended_period,
    amount ?? null,
    counterparty ?? null,
    reason,
    JSON.stringify(proposed_je),
  ).run();

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'late_txn_buffered', 'late_txn_buffer', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), id,
    `Late txn buffered: ${source_type} ${source_id || ''} ${counterparty || ''} for ${intended_entry_date} ($${amount || '?'}) — period ${intended_period} is closed`,
    JSON.stringify({ intended_entry_date, intended_period, amount, counterparty, reason }),
  ).run().catch(() => {});

  return { ok: true, id, status: 'pending' };
}

export async function listLateTxns(env, opts = {}) {
  const status = opts.status || 'pending';
  const { results } = await env.DB.prepare(`
    SELECT id, buffered_at, source_type, source_id, intended_entry_date,
           intended_period, amount, counterparty, reason, status, decision,
           decision_at, decision_note, result_je_id
    FROM late_txn_buffer
    WHERE status = ?
    ORDER BY buffered_at DESC
    LIMIT 100
  `).bind(status).all();

  const pending = (results || []).map(r => ({
    ...r,
    amount: r2(r.amount || 0),
  }));

  return {
    ok: true,
    count: pending.length,
    status_filter: status,
    txns: pending,
  };
}

export async function getLateTxn(env, id) {
  const row = await env.DB.prepare(`
    SELECT * FROM late_txn_buffer WHERE id = ?
  `).bind(id).first();
  if (!row) return { ok: false, error: 'not found' };
  let proposed_je = null;
  try { proposed_je = JSON.parse(row.proposed_je_json || 'null'); } catch {}
  return { ok: true, ...row, proposed_je };
}

// Apply Drew's decision.
// For now, this records the decision and audit-logs it. Actually executing
// the reopen+repost flow is RTR-6 territory because the JE-posting path
// needs to be re-entrant. For Session 12 we mark the buffer entry and
// leave the post-execution stub for later.
export async function applyLateTxnDecision(env, id, { decision, note }) {
  if (!['reopen', 'carry_forward', 'reject'].includes(decision)) {
    return { ok: false, error: 'decision must be one of: reopen, carry_forward, reject' };
  }
  const row = await env.DB.prepare(
    `SELECT * FROM late_txn_buffer WHERE id = ?`
  ).bind(id).first();
  if (!row) return { ok: false, error: 'not found' };
  if (row.status !== 'pending') {
    return { ok: false, error: `already decided (status=${row.status})` };
  }

  const newStatus = decision === 'reopen' ? 'applied_reopen'
                  : decision === 'carry_forward' ? 'applied_forward'
                  : 'rejected';
  await env.DB.prepare(`
    UPDATE late_txn_buffer
    SET status = ?, decision = ?, decision_at = datetime('now'), decision_note = ?
    WHERE id = ?
  `).bind(newStatus, decision, note ?? null, id).run();

  // Audit log
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, before_json, after_json)
    VALUES (?, 'late_txn_decision', 'late_txn_buffer', ?, 'drew', ?, ?, ?)
  `).bind(
    crypto.randomUUID(), id,
    `Late txn ${decision}: ${row.source_type} ${row.source_id || ''} for ${row.intended_entry_date} ($${row.amount || '?'})`,
    JSON.stringify({ status: 'pending' }),
    JSON.stringify({ status: newStatus, decision, note }),
  ).run().catch(() => {});

  // NOTE: actual execution of reopen+repost or carry_forward+post is
  // intentionally deferred to a follow-up. The buffer status reflects
  // Drew's intent; the JE poster (after the next sync) sees the decision
  // and acts. This keeps Session 12 scope small + verifiable.
  //
  // To execute now:
  //   - decision='reopen': UPDATE closed_periods SET unlocked_at=now; call
  //     postJeForTxn with the proposed_je; recomputeMonthlyClose with write=true;
  //     re-lock.
  //   - decision='carry_forward': replay proposed_je with entry_date set to
  //     first day of current open month.
  //   - decision='reject': no further action.

  return {
    ok: true,
    id,
    status: newStatus,
    decision,
    note: 'Decision recorded. Execution stub — full reopen/repost flow lands in a follow-up.',
  };
}
