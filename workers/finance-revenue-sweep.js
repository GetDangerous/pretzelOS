// workers/finance-revenue-sweep.js
// Finance v2 — Daily revenue sweep (D2).
//
// Problem: Mercury-derived JEs post Toast/Square/DoorDash deposits to Clearing
// accounts (asset). P&L shows $0 revenue because nothing lands in Sales.
//
// Solution: each day, sweep the current balance of each Clearing account into
// the matching Sales:Food Income sub-account. One JE per non-zero clearing.
//
// Limitations:
//   - Marketplace deposits (DoorDash/Uber/Grubhub) are ALREADY NET of platform
//     commissions. We recognize the net amount as revenue. Gross-up + fee
//     recognition requires Toast marketplace settlement parsing, noted as a
//     future refinement.
//   - Sweep is idempotent: we only sweep amounts that haven't already been
//     swept. We track the "last swept through" balance via an audit log lookup.
//     (Simpler: we zero out the clearing via the sweep JE — if you re-run, the
//     balance is already 0 and nothing posts.)
//
// Endpoints:
//   POST /finance/cfo/sweep-revenue  — run the sweep once
//   GET  /finance/cfo/sweep-preview  — show what would be swept without posting

import { isReadOnly, readOnlySkip } from './finance-shared.js';

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// Map each clearing account to the revenue account that should receive it.
// Keys match the end of the COA account_name; values are the destination names.
const SWEEP_MAP = [
  { from_match: /Cash Clearing/i,      to: 'Sales:Food Income:Dine-In / Takeout', label: 'Toast POS' },
  { from_match: /Square Clearing/i,    to: 'Sales:Food Income:Dine-In / Takeout', label: 'Square POS' },
  { from_match: /Doordash Clearing/i,  to: 'Sales:Food Income:Delivery',          label: 'DoorDash' },
  { from_match: /UberEats Clearing/i,  to: 'Sales:Food Income:Delivery',          label: 'UberEats' },
  { from_match: /Grubhub Clearing/i,   to: 'Sales:Food Income:Delivery',          label: 'Grubhub' },
];

// Compute current balance of each clearing account from posted JEs.
async function currentClearingBalances(env) {
  const { results } = await env.DB.prepare(`
    SELECT c.id, c.account_name,
           ROUND(SUM(l.debit - l.credit), 2) as balance
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND c.account_name LIKE 'Clearing%'
      AND c.account_name NOT LIKE '%Credit Card%'
    GROUP BY c.id, c.account_name
  `).all();
  return results || [];
}

async function resolveAccount(env, name) {
  const row = await env.DB.prepare(
    `SELECT id FROM chart_of_accounts WHERE LOWER(account_name) = LOWER(?) LIMIT 1`
  ).bind(name).first();
  return row?.id || null;
}

export async function previewSweep(env) {
  const balances = await currentClearingBalances(env);
  const plan = [];
  for (const b of balances) {
    const rule = SWEEP_MAP.find(r => r.from_match.test(b.account_name));
    if (!rule) continue;
    // Clearing has a CREDIT balance (negative in debit - credit terms) when deposits
    // arrived. To sweep to Sales, we Dr clearing (to zero it) and Cr Sales.
    // The magnitude we recognize as revenue is |balance|.
    const amount = Math.abs(b.balance || 0);
    if (amount < 0.01) continue;
    const toAccountId = await resolveAccount(env, rule.to);
    plan.push({
      from_account_id: b.id,
      from_account_name: b.account_name,
      to_account_id: toAccountId,
      to_account_name: rule.to,
      channel: rule.label,
      balance: b.balance,
      sweep_amount: amount,
      direction: b.balance < 0 ? 'dr_clearing_cr_sales' : 'cr_clearing_dr_sales',
      can_post: toAccountId != null,
    });
  }
  const total = round2(plan.reduce((s, p) => s + p.sweep_amount, 0));
  return { clearing_accounts: balances.length, sweepable: plan.length, total_to_sweep: total, plan };
}

// ── Backlog rewind: reverse all prior revenue_sweep JEs ────────────────
// Used when switching from the all-in-one catch-up sweep to per-month
// apportionment. Reverses every revenue_sweep JE so Clearing balances go
// back to their pre-sweep state, then the caller can re-sweep per-month.
export async function rewindRevenueSweeps(env) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'revenue_sweep_rewind' });

  // All balance queries filter `status = 'posted'`, so flipping status to
  // 'reversed' is sufficient to remove the entry's effect from the ledger.
  // (Posting an offsetting entry would double-count.)
  const { results: priorSweeps } = await env.DB.prepare(`
    SELECT id, entry_date, description, total_debit
    FROM journal_entries
    WHERE source_type = 'revenue_sweep' AND status = 'posted'
    ORDER BY entry_date
  `).all();

  const reversed = [];
  for (const entry of (priorSweeps || [])) {
    await env.DB.prepare(
      `UPDATE journal_entries SET status = 'reversed', notes = COALESCE(notes,'') || ' | Rewound for per-month re-apportionment at ' || datetime('now') WHERE id = ?`
    ).bind(entry.id).run();
    reversed.push({ original: entry.id, amount: entry.total_debit });
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'revenue_sweep_rewound', 'journal_entries', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `rewind_${Date.now()}`,
    `Rewound ${reversed.length} prior revenue_sweep JEs (status flip only, no offset entries)`,
    JSON.stringify({ reversed })
  ).run().catch(() => {});

  return { ok: true, rewound: reversed.length, reversed };
}

// ── Per-month sweep ──────────────────────────────────────────────────────
// Walks each underlying Mercury-txn JE that lands in a clearing account,
// groups by the TXN's date month, and posts ONE sweep JE per (channel, month).
// This replaces the all-in-one sweep so historical monthly P&L is accurate.
export async function runRevenueSweepByMonth(env) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'revenue_sweep_by_month' });

  // For each clearing account, find all posted JE lines that credit it (deposits)
  // or debit it (reversals). Sum by txn-date month.
  const clearings = await currentClearingBalances(env);
  const accountsByPattern = {};
  for (const b of clearings) {
    const rule = SWEEP_MAP.find(r => r.from_match.test(b.account_name));
    if (rule) accountsByPattern[b.id] = { clearing: b, rule };
  }

  const posted = [];
  let totalSwept = 0;

  for (const [clearingAccountId, { clearing, rule }] of Object.entries(accountsByPattern)) {
    // Get net (debit - credit) per month for this clearing account,
    // joining back to the parent entry so we pick up its entry_date.
    const { results: monthly } = await env.DB.prepare(`
      SELECT SUBSTR(j.entry_date, 1, 7) as month,
             ROUND(SUM(l.debit - l.credit), 2) as net_debit
      FROM journal_entry_lines l
      JOIN journal_entries j ON j.id = l.journal_entry_id
      WHERE l.account_id = ? AND j.status = 'posted'
      GROUP BY month
      HAVING ABS(net_debit) > 0.01
      ORDER BY month
    `).bind(clearingAccountId).all();

    const toAccount = await env.DB.prepare(
      `SELECT id FROM chart_of_accounts WHERE LOWER(account_name) = LOWER(?) LIMIT 1`
    ).bind(rule.to).first();
    if (!toAccount) continue;

    for (const m of (monthly || [])) {
      // Clearing had a Cr balance (net_debit < 0) when deposits accumulated.
      // To recognize revenue for the month: Dr clearing by |net_debit|, Cr sales.
      if (m.net_debit >= 0) continue;  // nothing to sweep this month
      const amount = Math.abs(m.net_debit);
      const entryDate = m.month + '-' + new Date(m.month + '-01T00:00:00Z').toISOString().slice(8, 10);
      // Use last day of month as the sweep date so it's captured in that month's close.
      const [y, mm] = m.month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10);

      const entryId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
          total_debit, total_credit, status, created_by, notes)
        VALUES (?, ?, ?, 'revenue_sweep', ?, ?, ?, 'posted', 'cfo_agent', ?)
      `).bind(
        entryId, lastDay,
        `Sweep ${rule.label} ${m.month} → ${rule.to}`,
        clearingAccountId, amount, amount,
        `Per-month revenue recognition sweep for ${rule.label}`
      ).run();

      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, 1, ?, ?, 0, ?)
      `).bind(crypto.randomUUID(), entryId, clearingAccountId, amount, `Zero out ${clearing.account_name} for ${m.month}`).run();
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
        VALUES (?, ?, 2, ?, 0, ?, ?)
      `).bind(crypto.randomUUID(), entryId, toAccount.id, amount, `Recognize ${rule.label} revenue for ${m.month}`).run();

      posted.push({ channel: rule.label, month: m.month, amount, entry_id: entryId });
      totalSwept += amount;
    }
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'revenue_sweep_by_month', 'journal_entries', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `sweep_monthly_${Date.now()}`,
    `Per-month sweep: ${posted.length} JEs posted, total $${round2(totalSwept)}`,
    JSON.stringify({ count: posted.length, total: round2(totalSwept) })
  ).run().catch(() => {});

  return { ok: true, swept_count: posted.length, total_swept: round2(totalSwept), posted };
}

export async function runRevenueSweep(env) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'revenue_sweep' });

  // RTR-6 (Session 13): if POS-direct cutover is set AND today is at/after cutover,
  // the sweep would double-count (POS-direct already posted revenue at order time).
  // For post-cutover sweep runs, redirect Cr from Sales Revenue → AR.
  // This makes the sweep a "cash arrived, net AR" operation:
  //   Dr Clearing  / Cr AR  (cash from clearing reduces outstanding AR)
  // Pre-cutover dates: unchanged (existing sweep model).
  const cutover = await env.KV.get('RTR_CUTOVER_DATE');
  const today = new Date().toISOString().slice(0, 10);
  const useArTarget = !!cutover && today >= cutover;
  const arAccountId = '36fb48df-17f7-4044-8246-fc5f09395a46';   // Accounts Receivable (A/R)

  const preview = await previewSweep(env);
  if (!preview.plan.length) return { ok: true, swept: 0, note: 'nothing to sweep', ...preview, rtr6_mode: useArTarget ? 'ar_target' : 'sweep_to_revenue' };

  const posted = [];
  let totalSwept = 0;

  for (const p of preview.plan) {
    if (!p.can_post) continue;
    const amount = p.sweep_amount;
    const entryId = crypto.randomUUID();

    // Target account: AR (post-cutover) or Sales Revenue (pre-cutover, original model)
    const targetAccountId = useArTarget ? arAccountId : p.to_account_id;
    const targetAccountLabel = useArTarget ? 'Accounts Receivable (A/R) — RTR-6' : p.to_account_name;

    const clearingLineDebit  = p.balance < 0 ? amount : 0;
    const clearingLineCredit = p.balance < 0 ? 0 : amount;
    const targetLineDebit    = p.balance < 0 ? 0 : amount;
    const targetLineCredit   = p.balance < 0 ? amount : 0;

    await env.DB.prepare(`
      INSERT INTO journal_entries (
        id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes
      ) VALUES (?, ?, ?, 'revenue_sweep', ?, ?, ?, 'posted', 'cfo_agent', ?)
    `).bind(
      entryId, today,
      `Sweep ${p.channel} clearing → ${targetAccountLabel}`,
      p.from_account_id, amount, amount,
      useArTarget
        ? `RTR-6 cash-arrival sweep for ${p.channel}. Revenue was already recognized at order_date via pos_direct_sales JE. This sweep nets the AR balance.`
        : `Revenue recognition sweep for ${p.channel} (net of platform fees) — pre-cutover sweep model.`
    ).run();

    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 1, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), entryId, p.from_account_id,
      clearingLineDebit, clearingLineCredit,
      `Zero out ${p.from_account_name}`
    ).run();

    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 2, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), entryId, targetAccountId,
      targetLineDebit, targetLineCredit,
      useArTarget ? `Net ${p.channel} AR (cash arrived)` : `Recognize ${p.channel} revenue`
    ).run();

    posted.push({ channel: p.channel, amount, entry_id: entryId, target: useArTarget ? 'AR' : 'Revenue' });
    totalSwept += amount;
  }
  // Preserve the rtr6_mode field in the success response below.

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'revenue_sweep', 'journal_entries', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `sweep_${Date.now()}`,
    `Swept ${posted.length} clearing accounts → Sales:Food Income. Total $${round2(totalSwept)}.`,
    JSON.stringify({ posted, total: round2(totalSwept) })
  ).run().catch(() => {});

  return { ok: true, swept_count: posted.length, total_swept: round2(totalSwept), posted, rtr6_mode: useArTarget ? 'ar_target' : 'sweep_to_revenue', cutover_date: cutover || null };
}
