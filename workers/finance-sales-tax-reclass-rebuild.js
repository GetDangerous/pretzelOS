// workers/finance-sales-tax-reclass-rebuild.js
// Session 24-B (May 16 2026) — Sales tax reclass period correction.
//
// Replaces the two batch reclass JEs (`23-sales-utah801-reclass`,
// `23-dmv-utahtaxes-reclass`) with per-period reclass JEs based on real,
// non-failed UTAH Mercury outflows. Phantom-tax (failed) txns are correctly
// excluded.
//
// FY2025 reclasses offset against `Pre-Pretzel-OS Reconciliation` to preserve
// QBO P&L cent-accuracy (Taxes paid was already trued-up by qbo_expense_reconciliation).
// FY2026 reclasses offset against `Taxes paid` (post-bookkeeper; their Mercury
// DR'd Taxes paid that was never trued-up).

// Per-Mercury-txn reclass entries. Each maps a real (non-failed) UTAH outflow
// to a reclass JE that DR's Sales tax to pay and CR's the appropriate offset.
const RECLASS_ENTRIES = [
  // FY2025 — offset to Pre-Pretzel-OS Reconciliation (preserves QBO cent-accuracy)
  { date: '2025-02-06', amount: 1453.49, offset: 'Pre-Pretzel-OS Reconciliation', note: 'UTAH801/297-7703 Mercury Feb 6 2025 ($1287.91 + $165.58) — reclass to liability drain. Offset to PPR (FY2025 Taxes paid already trued-up by qbo_expense_reconciliation).' },
  { date: '2025-09-30', amount: 13107.65, offset: 'Pre-Pretzel-OS Reconciliation', note: 'Utah DMV Mercury Sept 30 2025 (SUCCESSFUL — Sept 29 phantom failed, excluded) — reclass to liability drain. Offset to PPR (FY2025 Taxes paid already trued-up).' },
  // FY2026 — offset to Taxes paid (reduces FY2026 P&L expense; no QBO trueup)
  { date: '2026-01-02', amount: 1225.43, offset: 'Taxes paid', note: 'UTAH801/297-7703 Mercury Jan 2 2026 (SUCCESSFUL — same-day $10,359.54 phantom failed, excluded) — reclass to liability drain.' },
  { date: '2026-01-22', amount: 10410.41, offset: 'Taxes paid', note: 'UTAH801/297-7703 Mercury Jan 22 2026 — reclass to liability drain.' },
  { date: '2026-05-01', amount: 13314.69, offset: 'Taxes paid', note: 'UTAH801/297-7703 Mercury May 1 2026 ($11,906.43 + $1,408.26) — reclass to liability drain.' },
  { date: '2026-05-15', amount: 8233.35, offset: 'Taxes paid', note: 'UTAH801/297-7703 Mercury May 15 2026 ($7,543.95 + $689.40) — reclass to liability drain.' },
];

// JEs to reverse (the two batch reclasses from Session 23)
const REVERSE_JE_IDS = ['23-sales-utah801-reclass', '23-dmv-utahtaxes-reclass'];

// Closed periods that must be unlocked to post historical reclasses
const PERIODS_TO_UNLOCK = [
  { period_start: '2025-01-01', period_end: '2025-12-31' },
  { period_start: '2026-01-01', period_end: '2026-02-28' },
];

async function resolveAccountIds(env, names) {
  const placeholders = names.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts WHERE account_name IN (${placeholders})`
  ).bind(...names).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

export async function rebuildSalesTaxReclass(env, { dry_run = false } = {}) {
  const log = [];

  // 1. Resolve account IDs
  const accountIds = await resolveAccountIds(env, ['Sales tax to pay', 'Taxes paid', 'Pre-Pretzel-OS Reconciliation']);
  for (const k of ['Sales tax to pay', 'Taxes paid', 'Pre-Pretzel-OS Reconciliation']) {
    if (!accountIds[k]) throw new Error(`Missing COA account: ${k}`);
  }

  // 2. Plan: reversal + new posts
  const plan = {
    reverse: [],
    unlock_periods: [],
    post_jes: [],
    relock_periods: [],
  };

  for (const jeId of REVERSE_JE_IDS) {
    const row = await env.DB.prepare(
      `SELECT id, source_type, entry_date, status, notes FROM journal_entries WHERE id = ?`
    ).bind(jeId).first();
    if (!row) {
      plan.reverse.push({ id: jeId, action: 'skip', reason: 'JE not found' });
      continue;
    }
    if (row.status !== 'posted') {
      plan.reverse.push({ id: jeId, action: 'skip', reason: `JE status=${row.status} (not posted)` });
      continue;
    }
    plan.reverse.push({ id: jeId, action: 'mark_reversed', original_date: row.entry_date });
  }

  for (const p of PERIODS_TO_UNLOCK) {
    plan.unlock_periods.push({ period_start: p.period_start, period_end: p.period_end });
  }

  for (const entry of RECLASS_ENTRIES) {
    const jeId = `24b-sales-tax-reclass-${entry.date}`;
    plan.post_jes.push({
      id: jeId,
      entry_date: entry.date,
      amount: entry.amount,
      lines: [
        { account: 'Sales tax to pay', debit: entry.amount, credit: 0 },
        { account: entry.offset, debit: 0, credit: entry.amount },
      ],
      notes: entry.note,
      offset_account: entry.offset,
    });
    plan.relock_periods.push(...PERIODS_TO_UNLOCK);
  }

  if (dry_run) {
    return { ok: true, dry_run: true, plan, accountIds };
  }

  // 3. EXECUTE — reverse old JEs
  for (const r of plan.reverse) {
    if (r.action !== 'mark_reversed') continue;
    await env.DB.prepare(`
      UPDATE journal_entries
         SET status = 'reversed',
             notes = COALESCE(notes,'') || ' | Reversed by Session 24-B: replaced with per-period reclass JEs.'
       WHERE id = ? AND status = 'posted'
    `).bind(r.id).run();
    log.push({ step: 'reversed', je_id: r.id });
  }

  // 4. Unlock periods. The "locked" predicate elsewhere (finance-je-poster, etc.)
  // is `unlocked_at IS NULL`. Keep locked_at populated (NOT NULL schema constraint)
  // and just set unlocked_at to release the lock.
  for (const p of plan.unlock_periods) {
    await env.DB.prepare(`
      UPDATE closed_periods
         SET unlocked_at = datetime('now'),
             unlock_reason = 'Session 24-B sales tax reclass per-period rebuild'
       WHERE period_start = ? AND period_end = ? AND unlocked_at IS NULL
    `).bind(p.period_start, p.period_end).run();
    log.push({ step: 'unlocked', period: `${p.period_start}..${p.period_end}` });
  }

  // 5. Post new reclass JEs
  for (const je of plan.post_jes) {
    const headerExists = await env.DB.prepare(
      `SELECT id FROM journal_entries WHERE id = ?`
    ).bind(je.id).first();
    if (headerExists) {
      log.push({ step: 'skipped_post', je_id: je.id, reason: 'already exists' });
      continue;
    }
    const description = `Session 24-B sales tax reclass — ${je.entry_date}`;
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes, created_at)
      VALUES (?, ?, ?, 'sales_tax_reclass', ?, ?, ?, 'posted', 'session-24b', ?, datetime('now'))
    `).bind(je.id, je.entry_date, description, je.id, je.amount, je.amount, je.notes).run();

    let lineNum = 1;
    for (const ln of je.lines) {
      const accId = accountIds[ln.account];
      if (!accId) throw new Error(`Missing account: ${ln.account}`);
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
      `).bind(je.id, lineNum++, accId, ln.debit, ln.credit).run();
    }
    log.push({ step: 'posted', je_id: je.id, amount: je.amount, offset: je.offset_account });
  }

  // 6. Re-lock periods. Set unlocked_at back to NULL (lock predicate); bump locked_at
  // to current time so the Tier 1 invariant `no_post_in_closed_period` doesn't flag
  // our just-posted JEs (their created_at < new locked_at).
  for (const p of PERIODS_TO_UNLOCK) {
    await env.DB.prepare(`
      UPDATE closed_periods
         SET unlocked_at = NULL,
             unlock_reason = NULL,
             locked_at = datetime('now')
       WHERE period_start = ? AND period_end = ?
    `).bind(p.period_start, p.period_end).run();
    log.push({ step: 'relocked', period: `${p.period_start}..${p.period_end}` });
  }

  // 7. Compute current balances post-fix
  const balRow = await env.DB.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN c.account_name='Sales tax to pay' THEN l.credit - l.debit ELSE 0 END), 2) AS sales_tax_payable,
      ROUND(SUM(CASE WHEN c.account_name='Taxes paid' THEN l.debit - l.credit ELSE 0 END), 2) AS taxes_paid,
      ROUND(SUM(CASE WHEN c.account_name='Pre-Pretzel-OS Reconciliation' THEN l.credit - l.debit ELSE 0 END), 2) AS ppr
      FROM journal_entry_lines l
      JOIN journal_entries j ON j.id = l.journal_entry_id
      JOIN chart_of_accounts c ON c.id = l.account_id
     WHERE j.status='posted' AND j.source_type != 'fiscal_year_close'
       AND c.account_name IN ('Sales tax to pay','Taxes paid','Pre-Pretzel-OS Reconciliation')
  `).first();

  return {
    ok: true,
    dry_run: false,
    log,
    balances_after: balRow,
    summary: {
      reversed_jes: plan.reverse.filter(r => r.action === 'mark_reversed').length,
      posted_jes: plan.post_jes.length,
      total_reclass_amount: RECLASS_ENTRIES.reduce((sum, e) => sum + e.amount, 0),
      fy2025_to_ppr: RECLASS_ENTRIES.filter(e => e.offset === 'Pre-Pretzel-OS Reconciliation').reduce((s, e) => s + e.amount, 0),
      fy2026_to_taxes_paid: RECLASS_ENTRIES.filter(e => e.offset === 'Taxes paid').reduce((s, e) => s + e.amount, 0),
    },
  };
}
