// workers/finance-uline-reclass.js
// Session 24-F (May 16 2026) — Reclass 5 historical Uline Mercury txns.
//
// The categorizer's vendor_kb (May 14) caught Uline → COGS:Paper Packaging
// Products correctly. The 5 historical Uline txns (Oct 2025 - Apr 2026) were
// categorized BEFORE the vendor_kb pattern was active — they DR'd Restaurant
// Supplies & Equipment instead. This reclasses them via supplemental JEs.
//
// Each reclass JE: DR Cost of goods sold:Paper Packaging Products / CR
// Restaurant Supplies & Equipment, dated to original txn date.

// 5 historical Uline Mercury txns with original DR account = Restaurant Supplies & Equipment
const HISTORICAL_TXNS = [
  { date: '2025-10-23', amount: 216.83, mercury_je_id_prefix: 'f1011b4b' },
  { date: '2026-01-07', amount: 789.67, mercury_je_id_prefix: '1fc28eb2' },
  { date: '2026-02-06', amount: 392.42, mercury_je_id_prefix: 'c8bdd114' },
  { date: '2026-03-13', amount: 465.68, mercury_je_id_prefix: '7a3b28ab' },
  { date: '2026-04-22', amount: 537.58, mercury_je_id_prefix: '213e733c' },
];

const PERIODS_TO_UNLOCK = [
  { period_start: '2025-01-01', period_end: '2025-12-31' },
  { period_start: '2026-01-01', period_end: '2026-02-28' },
  { period_start: '2026-03-01', period_end: '2026-03-31' },
  { period_start: '2026-04-01', period_end: '2026-04-30' },
];

async function resolveAccountIds(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, account_name FROM chart_of_accounts
     WHERE account_name IN ('Restaurant Supplies & Equipment','Cost of goods sold:Paper Packaging Products')
  `).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

export async function reclassUlineHistorical(env, { dry_run = false } = {}) {
  const log = [];
  const accountIds = await resolveAccountIds(env);
  const rseId = accountIds['Restaurant Supplies & Equipment'];
  const ppId = accountIds['Cost of goods sold:Paper Packaging Products'];
  if (!rseId || !ppId) throw new Error('Missing COA account');

  const plan = HISTORICAL_TXNS.map(t => ({
    id: `24f-uline-reclass-${t.date}`,
    entry_date: t.date,
    description: `Phase 24-F Uline reclass — ${t.date}`,
    total_amount: t.amount,
    lines: [
      { account_id: ppId, debit: t.amount, credit: 0 },     // DR Paper Packaging COGS
      { account_id: rseId, debit: 0, credit: t.amount },    // CR Restaurant Supplies & Equipment
    ],
    note: `Phase 24-F: Reclass Uline ${t.date} \$${t.amount.toFixed(2)} from Restaurant Supplies & Equipment to COGS:Paper Packaging Products per vendor KB pattern (bookkeeper categorized Uline as Paper Packaging 100% in QBO archive).`,
  }));

  if (dry_run) {
    return { ok: true, dry_run: true, plan, total: HISTORICAL_TXNS.reduce((s, t) => s + t.amount, 0) };
  }

  // Unlock periods
  for (const p of PERIODS_TO_UNLOCK) {
    await env.DB.prepare(`
      UPDATE closed_periods SET unlocked_at = datetime('now'), unlock_reason = 'Session 24-F Uline reclass'
       WHERE period_start = ? AND period_end = ? AND unlocked_at IS NULL
    `).bind(p.period_start, p.period_end).run();
    log.push({ step: 'unlocked', period: `${p.period_start}..${p.period_end}` });
  }

  let posted = 0, skipped = 0;
  for (const je of plan) {
    const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE id = ?`).bind(je.id).first();
    if (existing) { skipped++; log.push({ step: 'skipped', je_id: je.id }); continue; }

    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes, created_at)
      VALUES (?, ?, ?, 'cogs_reclass', ?, ?, ?, 'posted', 'session-24f', ?, datetime('now'))
    `).bind(je.id, je.entry_date, je.description, je.id, je.total_amount, je.total_amount, je.note).run();

    let lineNum = 1;
    for (const ln of je.lines) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
      `).bind(je.id, lineNum++, ln.account_id, ln.debit, ln.credit).run();
    }
    posted++;
    log.push({ step: 'posted', je_id: je.id, amount: je.total_amount });
  }

  // Re-lock periods + bump locked_at
  for (const p of PERIODS_TO_UNLOCK) {
    await env.DB.prepare(`
      UPDATE closed_periods SET unlocked_at = NULL, unlock_reason = NULL, locked_at = datetime('now')
       WHERE period_start = ? AND period_end = ?
    `).bind(p.period_start, p.period_end).run();
    log.push({ step: 'relocked', period: `${p.period_start}..${p.period_end}` });
  }

  return {
    ok: true,
    dry_run: false,
    summary: { posted, skipped, total_reclassed: HISTORICAL_TXNS.reduce((s, t) => s + t.amount, 0) },
    log,
  };
}
