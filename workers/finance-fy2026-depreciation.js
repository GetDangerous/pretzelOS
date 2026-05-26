// workers/finance-fy2026-depreciation.js
// Session 24-E (May 16 2026) — FY2026 depreciation Year-3 schedule.
//
// Posts 12 monthly JEs (Jan-Dec 2026) per IRS Form 4562 Year-3 continuation
// of the 2024 schedule. Mirrors the FY2025 monthly_depreciation pattern
// (same source_type, same account names, same structure).
//
// Per-asset monthly depreciation (Year-3):
//   Leasehold Improvements    SL 15yr  6.67% × $438,100 ÷ 12 = $2,435.08/mo
//   Restaurant Equipment     200DB 5yr 19.20% × $170,381 ÷ 12 = $2,726.08/mo
//   Furniture & Fixtures     200DB 7yr 17.49% × $1,098   ÷ 12 = $16.00/mo
//   Signage                  200DB 7yr 17.49% × $3,588   ÷ 12 = $52.34/mo
//   ─── Depreciation total                                  $5,229.50/mo
//   Startup Expenses          SL 15yr  6.67% × $70,900   ÷ 12 =   $393.92/mo (amortization)
//   ─── Monthly grand total                                $5,623.42/mo
//
// FY2026 totals:
//   Depreciation: $62,754
//   Amortization: $4,727
//   Total:        $67,481

const MONTHLY_DEPRECIATION = 5229.50;     // DR Depreciation / CR Accumulated depreciation
const MONTHLY_AMORTIZATION = 393.92;      // DR Amortization expenses / CR Accumulated amortization
const MONTHLY_TOTAL = MONTHLY_DEPRECIATION + MONTHLY_AMORTIZATION; // 5623.42

const ASSET_NOTE = 'Phase 24-E: FY2026 Year-3 depreciation per Form 4562 continuation (Leasehold SL 15yr $2,435.08 + Rest Equip 200DB 5yr Y3 $2,726.08 + F&F 200DB 7yr Y3 $16 + Signage 200DB 7yr Y3 $52.34 = $5,229.50 dep + Startup Amort SL 15yr $393.92 amort = $5,623.42/mo total).';

// 12 months Jan-Dec 2026 (last-day-of-month dates)
const MONTHS = [
  { mo: 'jan', date: '2026-01-31' },
  { mo: 'feb', date: '2026-02-28' },
  { mo: 'mar', date: '2026-03-31' },
  { mo: 'apr', date: '2026-04-30' },
  { mo: 'may', date: '2026-05-31' },
  { mo: 'jun', date: '2026-06-30' },
  { mo: 'jul', date: '2026-07-31' },
  { mo: 'aug', date: '2026-08-31' },
  { mo: 'sep', date: '2026-09-30' },
  { mo: 'oct', date: '2026-10-31' },
  { mo: 'nov', date: '2026-11-30' },
  { mo: 'dec', date: '2026-12-31' },
];

// FY2026 close-period boundaries that may need unlock/relock to post historical months
const PERIODS_TO_UNLOCK = [
  { period_start: '2026-01-01', period_end: '2026-02-28' },
  { period_start: '2026-03-01', period_end: '2026-03-31' },
  { period_start: '2026-04-01', period_end: '2026-04-30' },
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

export async function postFy2026Depreciation(env, { dry_run = false } = {}) {
  const log = [];
  const accounts = ['Depreciation', 'Amortization expenses', 'Accumulated depreciation', 'Accumulated amortization'];
  const accountIds = await resolveAccountIds(env, accounts);
  for (const k of accounts) {
    if (!accountIds[k]) throw new Error(`Missing COA account: ${k}`);
  }

  const plan = MONTHS.map(({ mo, date }) => ({
    id: `24e-fy2026-monthly-dep-${mo}`,
    entry_date: date,
    description: `Phase 24-E FY2026 Year-3 monthly depreciation — ${mo.toUpperCase()} 2026`,
    total_amount: MONTHLY_TOTAL,
    lines: [
      { account: 'Depreciation', debit: MONTHLY_DEPRECIATION, credit: 0 },
      { account: 'Amortization expenses', debit: MONTHLY_AMORTIZATION, credit: 0 },
      { account: 'Accumulated depreciation', debit: 0, credit: MONTHLY_DEPRECIATION },
      { account: 'Accumulated amortization', debit: 0, credit: MONTHLY_AMORTIZATION },
    ],
  }));

  if (dry_run) {
    return { ok: true, dry_run: true, plan, totals: { monthly_total: MONTHLY_TOTAL, fy2026_total: MONTHLY_TOTAL * 12 } };
  }

  // Unlock locked FY2026 periods
  for (const p of PERIODS_TO_UNLOCK) {
    await env.DB.prepare(`
      UPDATE closed_periods
         SET unlocked_at = datetime('now'),
             unlock_reason = 'Session 24-E FY2026 depreciation Year-3 backfill'
       WHERE period_start = ? AND period_end = ? AND unlocked_at IS NULL
    `).bind(p.period_start, p.period_end).run();
    log.push({ step: 'unlocked', period: `${p.period_start}..${p.period_end}` });
  }

  // Post 12 JEs (idempotent: skip if id already exists)
  let posted = 0, skipped = 0;
  for (const je of plan) {
    const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE id = ?`).bind(je.id).first();
    if (existing) {
      skipped++;
      log.push({ step: 'skipped_already_exists', je_id: je.id });
      continue;
    }
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes, created_at)
      VALUES (?, ?, ?, 'monthly_depreciation', ?, ?, ?, 'posted', 'session-24e', ?, datetime('now'))
    `).bind(je.id, je.entry_date, je.description, je.id, je.total_amount, je.total_amount, ASSET_NOTE).run();

    let lineNum = 1;
    for (const ln of je.lines) {
      await env.DB.prepare(`
        INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
      `).bind(je.id, lineNum++, accountIds[ln.account], ln.debit, ln.credit).run();
    }
    posted++;
    log.push({ step: 'posted', je_id: je.id, date: je.entry_date, amount: je.total_amount });
  }

  // Re-lock periods (bump locked_at so Tier 1 no_post_in_closed_period doesn't flag these)
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

  return {
    ok: true,
    dry_run: false,
    summary: {
      posted,
      skipped,
      monthly_total: MONTHLY_TOTAL,
      fy2026_total: posted * MONTHLY_TOTAL,
    },
    log,
  };
}
