// workers/finance-capex-flagger.js
// Finance v2 — CFO Agent v2, capex auto-flagging (C-3).
// Per PRETZEL_OS_FINANCE_V2.md section 3.5.
//
// Walks mercury_transactions for candidates >$2,500 (Irene's de minimis election)
// that LOOK LIKE equipment purchases, and surfaces them for Drew to either:
//   (a) capitalize → creates fixed_assets row + depreciation schedule, reclassifies JE
//   (b) reject    → leaves the txn as a normal expense
//
// Endpoints:
//   GET  /finance/cfo/capex-candidates[?year=YYYY&since=YYYY-MM-DD]  — list candidates
//   POST /finance/cfo/capex/:mercury_txn_id/capitalize -d {asset_name, asset_class, useful_life_years}
//   POST /finance/cfo/capex/:mercury_txn_id/reject     — mark as expensed (no action on JE)

import { isReadOnly, readOnlySkip } from './finance-shared.js';
import { auditPostJe } from './audit-trail.js';

// Counterparties that are DEFINITELY not capex even if >$2,500.
const NON_CAPEX_PATTERNS = [
  /toast\s*pay/i,               // payroll runs
  /square\s*pay/i,
  /dangerous\s*pretze/i,        // internal transfers
  /lease\s*services|^leaf\b/i,  // loan payments
  /sysco|us\s*foods|shamrock|^pfg\b|performance\s*food/i,  // food vendors
  /mercury\s*fee|wire\s*fee|bank\s*fee/i,
  /utah.*tax|tax\s*commission/i,
  /insurance|allstate|geico/i,
  /^rent\b|property\s*manager/i,
  // Bank-to-bank transfers (interbank, loan payoffs, etc.)
  /chase\s*[-—]/i, /wells\s*fargo|^wf\s/i, /bank\s*of\s*america|^boa\b/i,
  /mercury\s*(checking|savings|credit)/i,
  /american\s*express|^amex\b/i,
];

// Known equipment/fixture vendors (high-signal capex matches).
const CAPEX_VENDOR_PATTERNS = [
  { pattern: /webstaurant/i,                    asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /\bkatom\b/i,                      asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /restaurant\s*equip/i,             asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /grainger/i,                       asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /kemper/i,                         asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /\bhenny\s*penny\b|manitowoc|hobart/i, asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /home\s*depot\s*pro|homedepot/i,  asset_class: 'leasehold_improvement', life_years: 15 },
  { pattern: /lowes/i,                          asset_class: 'leasehold_improvement', life_years: 15 },
  { pattern: /costco\s*business/i,              asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /sams\s*club/i,                    asset_class: 'restaurant_equipment', life_years: 5 },
  { pattern: /\bapple\b\.com|apple\s*store/i,   asset_class: 'office_equipment', life_years: 3 },
  { pattern: /dell\.com|dell\s*inc/i,           asset_class: 'office_equipment', life_years: 3 },
  { pattern: /signage|sign\s*company/i,         asset_class: 'signage', life_years: 7 },
];

// Generic large Amazon purchase — needs review; may or may not be capex.
const AMAZON_CAPEX_HINT = /amazon/i;

function isNonCapex(counterparty, description) {
  const text = `${counterparty || ''} ${description || ''}`;
  return NON_CAPEX_PATTERNS.some(p => p.test(text));
}

function classifyVendor(counterparty, description) {
  const text = `${counterparty || ''} ${description || ''}`;
  for (const rule of CAPEX_VENDOR_PATTERNS) {
    if (rule.pattern.test(text)) return { class: rule.asset_class, life_years: rule.life_years, confidence: 0.9 };
  }
  if (AMAZON_CAPEX_HINT.test(text)) {
    return { class: 'restaurant_equipment', life_years: 5, confidence: 0.5 };  // Amazon is ambiguous
  }
  return null;
}

// ── Scan for capex candidates ─────────────────────────────────────────────
export async function capexCandidates(env, opts = {}) {
  const yearFilter = opts.year ? `${opts.year}-%` : '%';
  const sinceFilter = opts.since || '2024-01-01';
  const threshold = opts.threshold ?? 2500;

  const { results } = await env.DB.prepare(`
    SELECT m.id, m.txn_date, m.amount, m.counterparty_name, m.description, m.category,
           m.is_reconciled, m.matched_journal_entry_id,
           c.account_name as proposed_account
    FROM mercury_transactions m
    LEFT JOIN chart_of_accounts c ON c.id = m.proposed_account_id
    WHERE m.amount < ?
      AND m.txn_date LIKE ?
      AND m.txn_date >= ?
    ORDER BY m.amount ASC
  `).bind(-threshold, yearFilter, sinceFilter).all();

  const candidates = [];
  const rejected_by_pattern = [];

  for (const r of (results || [])) {
    if (isNonCapex(r.counterparty_name, r.description)) {
      rejected_by_pattern.push({
        txn_id: r.id, txn_date: r.txn_date, amount: Math.abs(r.amount),
        counterparty: r.counterparty_name, reason: 'non_capex_pattern (payroll/food/loan/etc)',
      });
      continue;
    }
    const match = classifyVendor(r.counterparty_name, r.description);
    candidates.push({
      txn_id: r.id,
      txn_date: r.txn_date,
      amount: Math.round(Math.abs(r.amount) * 100) / 100,
      counterparty: r.counterparty_name || '(unknown)',
      description: r.description,
      currently_categorized_as: r.proposed_account || '(uncategorized)',
      je_posted: !!r.matched_journal_entry_id,
      je_id: r.matched_journal_entry_id,
      suggested_asset_class: match?.class || 'review_needed',
      suggested_useful_life_years: match?.life_years || null,
      confidence: match?.confidence ?? 0.3,
      monthly_depreciation_estimate: match ? Math.round((Math.abs(r.amount) / (match.life_years * 12)) * 100) / 100 : null,
    });
  }

  return {
    threshold_usd: threshold,
    scan_range: { year: opts.year || 'all', since: sinceFilter },
    candidates_count: candidates.length,
    candidates,
    rejected_by_pattern_count: rejected_by_pattern.length,
    rejected_sample: rejected_by_pattern.slice(0, 10),
  };
}

// ── Capitalize a candidate ────────────────────────────────────────────────
// Creates fixed_assets row + depreciation_schedules for the asset's life,
// AND reverses the original expense JE, posting a new one to the asset account.
export async function capitalize(env, mercuryTxnId, body) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'capitalize', txn_id: mercuryTxnId });
  const txn = await env.DB.prepare(`
    SELECT m.*, c.account_name as current_account
    FROM mercury_transactions m
    LEFT JOIN chart_of_accounts c ON c.id = m.proposed_account_id
    WHERE m.id = ?
  `).bind(mercuryTxnId).first();
  if (!txn) return { error: 'Mercury transaction not found' };

  const assetName      = body.asset_name || txn.counterparty_name || 'Unnamed asset';
  const assetClass     = body.asset_class || 'restaurant_equipment';
  const usefulLife     = Number(body.useful_life_years) || 5;
  const depMethod      = body.depreciation_method || (usefulLife <= 5 ? '200db' : 'straight_line');
  const acquisitionDate = body.acquisition_date || txn.txn_date?.slice(0, 10);
  const cost           = Math.abs(Number(txn.amount));
  const salvage        = Number(body.salvage_value) || 0;

  // Straight-line monthly depreciation (200DB fallback uses straight-line for simplicity here)
  const monthlyDep = Math.round(((cost - salvage) / (usefulLife * 12)) * 100) / 100;

  const assetId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO fixed_assets (
      id, asset_name, asset_class, acquisition_date, acquisition_cost,
      useful_life_years, depreciation_method, salvage_value,
      monthly_depreciation, accumulated_depreciation, net_book_value,
      status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)
  `).bind(
    assetId, assetName, assetClass, acquisitionDate, cost,
    usefulLife, depMethod, salvage,
    monthlyDep, cost,
    `Capitalized from Mercury txn ${mercuryTxnId}${body.notes ? '. ' + body.notes : ''}`,
  ).run();

  // Seed depreciation schedule — one row per month for the asset's useful life.
  const startDate = new Date(acquisitionDate + 'T00:00:00Z');
  const scheduleRows = [];
  for (let i = 0; i < usefulLife * 12; i++) {
    const d = new Date(startDate);
    d.setUTCMonth(d.getUTCMonth() + i + 1);  // first charge is the month after acquisition
    const scheduleDate = d.toISOString().slice(0, 7) + '-01';
    scheduleRows.push({ date: scheduleDate, amount: monthlyDep });
  }
  // Insert in chunks to stay under the D1 batch limit.
  for (const r of scheduleRows) {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO depreciation_schedules (id, asset_id, schedule_date, amount, status)
      VALUES (?, ?, ?, ?, 'scheduled')
    `).bind(crypto.randomUUID(), assetId, r.date, r.amount).run();
  }

  // If there was an expense JE for this txn, reverse it so the ledger reflects
  // the capitalization. The reversal logic is in finance-je-poster.js but we
  // duplicate the minimal reversal here to avoid import churn.
  if (txn.matched_journal_entry_id) {
    const oldEntry = await env.DB.prepare(
      `SELECT id, entry_date, description, total_debit, total_credit FROM journal_entries WHERE id = ?`
    ).bind(txn.matched_journal_entry_id).first();
    if (oldEntry) {
      const { results: oldLines } = await env.DB.prepare(
        `SELECT * FROM journal_entry_lines WHERE journal_entry_id = ? ORDER BY line_number`
      ).bind(oldEntry.id).all();
      const reversalId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
          total_debit, total_credit, status, reversal_of_entry_id, created_by, notes)
        VALUES (?, ?, ?, 'manual', ?, ?, ?, 'posted', ?, 'cfo_agent', ?)
      `).bind(
        reversalId, oldEntry.entry_date,
        `CAPITALIZE: reversing expense for ${assetName}`,
        oldEntry.id, oldEntry.total_debit, oldEntry.total_credit,
        oldEntry.id,
        `Reversing expense posting for fixed-asset capitalization (asset ${assetId})`
      ).run();
      let ln = 1;
      for (const line of (oldLines || [])) {
        await env.DB.prepare(`
          INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), reversalId, ln++, line.account_id, line.credit, line.debit, `Capitalization reversal`).run();
      }
      await env.DB.prepare(`UPDATE journal_entries SET status = 'reversed' WHERE id = ?`).bind(oldEntry.id).run();
    }
  }

  // Post a new JE: Dr <asset COA>, Cr Mercury checking (bank).
  // Find the asset-side account in COA — prefer "Restaurant equipment, tools, and Machinery" or similar.
  const assetAccount = await env.DB.prepare(`
    SELECT id, account_name FROM chart_of_accounts
    WHERE (account_type = 'asset' AND account_subtype = 'fixed_asset')
       OR LOWER(account_name) LIKE '%restaurant equipment%'
       OR LOWER(account_name) LIKE '%leasehold%'
       OR LOWER(account_name) LIKE '%fixed asset%'
    ORDER BY CASE
      WHEN ? = 'restaurant_equipment' AND LOWER(account_name) LIKE '%restaurant equipment%' THEN 1
      WHEN ? = 'leasehold_improvement' AND LOWER(account_name) LIKE '%leasehold%' THEN 1
      WHEN LOWER(account_name) LIKE '%restaurant equipment%' THEN 2
      ELSE 3
    END
    LIMIT 1
  `).bind(assetClass, assetClass).first();

  const mercuryAccountId = await env.DB.prepare(`
    SELECT id FROM chart_of_accounts WHERE LOWER(account_name) LIKE 'mercury %' LIMIT 1
  `).first();

  let newEntryId = null;
  if (assetAccount?.id && mercuryAccountId?.id) {
    newEntryId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, 'capitalization', ?, ?, ?, 'posted', 'cfo_agent', ?)
    `).bind(
      newEntryId, acquisitionDate,
      `Capitalize: ${assetName} — ${assetClass}`,
      assetId, cost, cost,
      `Drew approved capitalization of Mercury txn ${mercuryTxnId}`,
    ).run();
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 1, ?, ?, 0, ?)
    `).bind(crypto.randomUUID(), newEntryId, assetAccount.id, cost, `Capitalize ${assetName}`).run();
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, 2, ?, 0, ?, ?)
    `).bind(crypto.randomUUID(), newEntryId, mercuryAccountId.id, cost, `Paid from Mercury`).run();
    await env.DB.prepare(
      `UPDATE mercury_transactions SET matched_journal_entry_id = ? WHERE id = ?`
    ).bind(newEntryId, mercuryTxnId).run();
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'capex_capitalized', 'fixed_assets', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), assetId,
    `Capitalized ${assetName} ($${cost}, ${usefulLife}yr ${depMethod}) from Mercury txn ${mercuryTxnId}`,
    JSON.stringify({ asset_id: assetId, new_entry_id: newEntryId, monthly_depreciation: monthlyDep, schedule_months: scheduleRows.length })
  ).run();

  // Phase A Week 1 B1: audit_trail entries (capex approval + capitalization JE)
  if (newEntryId) {
    await auditPostJe(env, {
      je_id: newEntryId,
      source_type: 'capitalization',
      actor: 'drew',
      je_data: { id: newEntryId, entry_date: acquisitionDate, total_debit: cost, total_credit: cost },
      metadata: {
        asset_id: assetId, asset_name: assetName, asset_class: assetClass,
        useful_life_years: usefulLife, depreciation_method: depMethod, monthly_depreciation: monthlyDep,
        mercury_txn_id: mercuryTxnId, prior_expense_je_id: oldEntry?.id || null,
      },
    }).catch(err => console.error('[capex] audit capitalize failed:', err.message));
  }

  return {
    ok: true,
    asset_id: assetId,
    asset_name: assetName,
    cost,
    useful_life_years: usefulLife,
    monthly_depreciation: monthlyDep,
    scheduled_months: scheduleRows.length,
    new_capitalization_je_id: newEntryId,
  };
}

// ── Reject a capex candidate (mark it as expensed; no action needed on JE) ──
export async function rejectCapex(env, mercuryTxnId, reason) {
  const txn = await env.DB.prepare(
    `SELECT id, amount, counterparty_name FROM mercury_transactions WHERE id = ?`
  ).bind(mercuryTxnId).first();
  if (!txn) return { error: 'Mercury transaction not found' };

  // Just log the decision — the existing expense JE stands.
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'capex_rejected', 'mercury_transactions', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), mercuryTxnId,
    `Capex candidate rejected: $${Math.abs(txn.amount)} to ${txn.counterparty_name} — ${reason || 'expensed as supplies'}`,
    JSON.stringify({ reason })
  ).run();

  return { ok: true, action: 'rejected_as_expense', txn_id: mercuryTxnId };
}
