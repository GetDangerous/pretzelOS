// workers/finance-monthly-depreciation-cron.js
// Forward automation: monthly depreciation + amortization posting per fixed_assets registry.
// Replaces manual annual rebuild — Drew wants near-real-time accurate books.
//
// Runs on cron 0 9 1 * * (1st of each month 09:00 UTC = 03:00 MT).
// Posts JEs for prior month for each active fixed_asset.
//
// Strategy:
//   - Read fixed_assets where status='active' AND monthly_depreciation > 0
//   - For each, post one JE per period:
//       DR Depreciation expense (or Amortization expense for startup_expenses class)
//       CR Accumulated depreciation (or Accumulated amortization)
//   - Idempotent: skip if JE exists with source_id = period+asset_id
//   - Optionally unlock+relock prior period if backfilling

import { auditPostJe } from './audit-trail.js';

async function resolveAccountIds(env, names) {
  const placeholders = names.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, account_name FROM chart_of_accounts WHERE account_name IN (${placeholders})`
  ).bind(...names).all();
  const map = {};
  for (const r of results || []) map[r.account_name] = r.id;
  return map;
}

function lastDayOfPeriod(period) {
  // period = 'YYYY-MM'
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function priorMonthPeriod(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; this means "prior month" naturally
  const prior = new Date(Date.UTC(y, m - 1, 1));
  return `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function postMonthlyDepreciation(env, { period = null, force = false } = {}) {
  const targetPeriod = period || priorMonthPeriod();
  const entryDate = lastDayOfPeriod(targetPeriod);
  const log = [];

  // Resolve accounts
  const accounts = ['Depreciation', 'Amortization expenses', 'Accumulated depreciation', 'Accumulated amortization'];
  const accountIds = await resolveAccountIds(env, accounts);
  for (const k of accounts) {
    if (!accountIds[k]) throw new Error(`Missing COA account: ${k}`);
  }

  // Read active assets with non-zero monthly depreciation
  const { results: assets } = await env.DB.prepare(
    `SELECT id, asset_name, asset_class, monthly_depreciation, depreciation_method
       FROM fixed_assets
      WHERE status='active' AND monthly_depreciation > 0`
  ).all();

  if (!assets || assets.length === 0) {
    return { ok: true, period: targetPeriod, message: 'No active depreciable assets', posted: 0 };
  }

  // Sum totals for combined JE (one JE per period for efficiency)
  let totalDep = 0;
  let totalAmort = 0;
  const breakdown = [];
  for (const a of assets) {
    const isAmort = a.asset_class === 'startup_expenses';
    if (isAmort) totalAmort += a.monthly_depreciation;
    else totalDep += a.monthly_depreciation;
    breakdown.push({ asset: a.asset_name, amount: a.monthly_depreciation, kind: isAmort ? 'amortization' : 'depreciation' });
  }
  const totalAll = totalDep + totalAmort;

  const jeId = `auto-monthly-dep-${targetPeriod}`;

  // Idempotency check — match by source_type + entry_date + amount.
  // This catches THIS cron's id format AND prior manual posts (Session 22-F: `22f-fy2025-monthly-dep-{mon}`, Session 24-E: `24e-fy2026-monthly-dep-{mon}`).
  const existing = await env.DB.prepare(`
    SELECT id FROM journal_entries
     WHERE status='posted'
       AND source_type='monthly_depreciation'
       AND entry_date = ?
       AND ROUND(total_debit, 2) = ROUND(?, 2)
     LIMIT 1
  `).bind(entryDate, totalAll).first();

  if (existing && !force) {
    return { ok: true, period: targetPeriod, skipped: true, reason: `JE already exists (id=${existing.id})`, je_id: existing.id };
  }
  if (existing && force) {
    await env.DB.prepare(`UPDATE journal_entries SET status='reversed' WHERE id=?`).bind(existing.id).run();
  }

  // If forcing, mark existing as reversed
  if (existing && force) {
    await env.DB.prepare(`UPDATE journal_entries SET status='reversed' WHERE id=?`).bind(jeId).run();
  }

  // Unlock period if closed (rare for current month, possible for backfills)
  const periodStart = `${targetPeriod}-01`;
  const periodEnd = entryDate;
  await env.DB.prepare(`
    UPDATE closed_periods SET unlocked_at=datetime('now'), unlock_reason='Monthly depreciation auto-post'
     WHERE period_start <= ? AND period_end >= ? AND unlocked_at IS NULL
  `).bind(periodStart, periodStart).run();

  const description = `Auto monthly depreciation ${targetPeriod}: dep $${totalDep.toFixed(2)} + amort $${totalAmort.toFixed(2)} = $${totalAll.toFixed(2)}`;
  const notes = `Auto-posted by monthly depreciation cron. Per fixed_assets registry: ${breakdown.map(b => `${b.asset} $${b.amount.toFixed(2)} (${b.kind})`).join(' · ')}.`;

  await env.DB.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes, created_at)
    VALUES (?, ?, ?, 'monthly_depreciation', ?, ?, ?, 'posted', 'auto-cron', ?, datetime('now'))
  `).bind(jeId, entryDate, description, jeId, totalAll, totalAll, notes).run();

  let lineNum = 1;
  const lines = [];
  if (totalDep > 0) {
    lines.push({ acct_id: accountIds['Depreciation'], dr: totalDep, cr: 0 });
    lines.push({ acct_id: accountIds['Accumulated depreciation'], dr: 0, cr: totalDep });
  }
  if (totalAmort > 0) {
    lines.push({ acct_id: accountIds['Amortization expenses'], dr: totalAmort, cr: 0 });
    lines.push({ acct_id: accountIds['Accumulated amortization'], dr: 0, cr: totalAmort });
  }
  for (const ln of lines) {
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
    `).bind(jeId, lineNum++, ln.acct_id, ln.dr, ln.cr).run();
  }

  // Re-lock the period (bump locked_at to cover this new JE)
  await env.DB.prepare(`
    UPDATE closed_periods SET unlocked_at=NULL, unlock_reason=NULL, locked_at=datetime('now')
     WHERE period_start <= ? AND period_end >= ? AND unlocked_at IS NOT NULL
  `).bind(periodStart, periodStart).run();

  // Update fixed_assets.accumulated_depreciation + net_book_value
  for (const a of assets) {
    const newAccum = (a.accumulated_depreciation || 0) + a.monthly_depreciation;
    await env.DB.prepare(`
      UPDATE fixed_assets SET accumulated_depreciation=?, net_book_value=acquisition_cost-? WHERE id=?
    `).bind(newAccum, newAccum, a.id).run();
  }

  // Phase A Week 1 B1: audit_trail entry for monthly depreciation cron JE
  await auditPostJe(env, {
    je_id: jeId,
    source_type: 'monthly_depreciation',
    actor: 'system:cron:monthly_depreciation',
    je_data: { id: jeId, entry_date: entryDate, total_debit: totalAll, total_credit: totalAll, description },
    metadata: { period_start: periodStart, total_dep: totalDep, total_amort: totalAmort, asset_count: assets.length },
  }).catch(err => console.error('[monthly-dep-cron] audit failed:', err.message));

  return {
    ok: true,
    period: targetPeriod,
    je_id: jeId,
    total_depreciation: totalDep,
    total_amortization: totalAmort,
    total: totalAll,
    assets_processed: assets.length,
    breakdown,
  };
}
