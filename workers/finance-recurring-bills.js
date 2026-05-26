// workers/finance-recurring-bills.js
// Finance v2 — Recurring bill detection (M5 / spec 2.4).
//
// Scans the last 90 days of Mercury transactions, finds counterparties with
// monthly-ish cadence, and proposes a recurring_bills entry for each. Drew
// reviews + approves individually.
//
// Detection logic:
//   - Group Mercury outflows by counterparty_name (normalized lowercase)
//   - Require ≥ 3 txns in the window (enough to establish a pattern)
//   - Cadence: median inter-txn gap should be within ±5 days of a common
//     interval (weekly=7d, biweekly=14d, monthly=28–31d, quarterly=90d)
//   - Expected amount: rolling average of the amounts
//   - Variance: flag if actual varies > ±10% from average
//
// Skip list: counterparties that are obviously NOT recurring bills.
//
// Endpoints:
//   POST /finance/cfo/bills/propose-recurring[?days=90&post_as_draft=1]
//   GET  /finance/cfo/bills/recurring        — list what's been proposed/confirmed
//   POST /finance/cfo/bills/recurring/:id/activate  — Drew approves a proposal
//   POST /finance/cfo/bills/recurring/:id/dismiss   — not actually recurring

import { isReadOnly, readOnlySkip } from './finance-shared.js';

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function normalize(name) { return (name || '').toLowerCase().trim().replace(/\s+/g, ' '); }

// Counterparties we don't want to propose as recurring bills.
const SKIP_PATTERNS = [
  /toast\s*pay/i,           // payroll — treated separately
  /square\s*pay/i,
  /lease\s*services|^leaf\b/i,  // loans — treated separately
  /^amazon/i,               // too diverse
  /sysco|us\s*foods|shamrock|^pfg\b/i,  // food vendors — order-by-order, not fixed recurring
  /dangerous\s*pretze/i,    // internal transfers
  /chase|wells\s*fargo|bank\s*of\s*america|^boa\b/i,  // interbank
  /utah.*tax/i,             // quarterly tax remits
];

function detectCadence(dates) {
  if (dates.length < 3) return null;
  const sorted = dates.map(d => new Date(d + 'T00:00:00Z').getTime()).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 86400000);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // Match to nearest known cadence
  if (median >= 6 && median <= 8)   return { cadence: 'weekly',    days: 7,  expected_day_of_week: new Date(sorted[sorted.length - 1]).getUTCDay() };
  if (median >= 12 && median <= 16) return { cadence: 'biweekly',  days: 14, expected_day_of_week: new Date(sorted[sorted.length - 1]).getUTCDay() };
  if (median >= 26 && median <= 33) return { cadence: 'monthly',   days: 30, expected_day_of_month: new Date(sorted[sorted.length - 1]).getUTCDate() };
  if (median >= 85 && median <= 100) return { cadence: 'quarterly', days: 90 };
  return null;  // no clean cadence match
}

// ── Scan + propose ───────────────────────────────────────────────────────
export async function proposeRecurringBills(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'propose_recurring_bills' });

  const days = parseInt(opts.days, 10) || 90;
  const postAsDraft = opts.post_as_draft !== false;

  const { results } = await env.DB.prepare(`
    SELECT counterparty_name, txn_date, amount, description
    FROM mercury_transactions
    WHERE amount < 0
      AND counterparty_name IS NOT NULL AND counterparty_name != ''
      AND txn_date >= date('now', '-' || ? || ' days')
    ORDER BY counterparty_name, txn_date
  `).bind(days).all();

  // Group by normalized counterparty
  const byParty = {};
  for (const r of (results || [])) {
    const key = normalize(r.counterparty_name);
    if (SKIP_PATTERNS.some(p => p.test(r.counterparty_name))) continue;
    byParty[key] = byParty[key] || { display: r.counterparty_name, txns: [] };
    byParty[key].txns.push({ date: r.txn_date.slice(0, 10), amount: Math.abs(r.amount), description: r.description });
  }

  const proposals = [];
  const skipped = { too_few_txns: 0, no_cadence: 0, already_exists: 0 };

  for (const [key, group] of Object.entries(byParty)) {
    if (group.txns.length < 3) { skipped.too_few_txns++; continue; }
    const cadenceInfo = detectCadence(group.txns.map(t => t.date));
    if (!cadenceInfo) { skipped.no_cadence++; continue; }

    const amounts = group.txns.map(t => t.amount);
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const stdev = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length);
    const variance_pct = mean > 0 ? round2(100 * stdev / mean) : 0;
    const last_date = group.txns[group.txns.length - 1].date;
    const next_expected = new Date(new Date(last_date + 'T00:00:00Z').getTime() + cadenceInfo.days * 86400000).toISOString().slice(0, 10);

    // Is there already a recurring_bills row for this counterparty?
    const existing = await env.DB.prepare(`
      SELECT id FROM recurring_bills
      WHERE LOWER(description) LIKE ? LIMIT 1
    `).bind('%' + key + '%').first();
    if (existing) { skipped.already_exists++; continue; }

    const proposal = {
      counterparty: group.display,
      cadence: cadenceInfo.cadence,
      expected_amount: round2(mean),
      variance_pct,
      expected_day_of_month: cadenceInfo.expected_day_of_month || null,
      expected_day_of_week: cadenceInfo.expected_day_of_week ?? null,
      next_expected_date: next_expected,
      observed_count: group.txns.length,
      history_sample: group.txns.slice(-5),
    };
    proposals.push(proposal);

    if (postAsDraft) {
      // Create a draft row in recurring_bills. Drew activates via
      // POST /finance/cfo/bills/recurring/:id/activate after review.
      // First ensure we have a vendor record.
      let vendor = await env.DB.prepare(
        `SELECT id FROM vendors WHERE LOWER(name) = LOWER(?) LIMIT 1`
      ).bind(group.display).first();
      if (!vendor) {
        const vendorId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO vendors (id, name, vendor_type, payment_method)
          VALUES (?, ?, 'supplier', 'ach')
        `).bind(vendorId, group.display).run();
        vendor = { id: vendorId };
      }

      const rbId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO recurring_bills (id, vendor_id, description, expected_amount,
          amount_variance_pct, cadence, expected_day_of_month, expected_day_of_week,
          next_expected_date, is_active, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).bind(
        rbId, vendor.id, group.display,
        proposal.expected_amount, proposal.variance_pct, proposal.cadence,
        proposal.expected_day_of_month, proposal.expected_day_of_week,
        proposal.next_expected_date,
        `DRAFT — auto-proposed by Mercury scan on ${new Date().toISOString().slice(0, 10)}. ${proposal.observed_count} txns in last ${days}d. Drew to activate or dismiss.`
      ).run();
      proposal.recurring_bill_id = rbId;
    }
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'recurring_bills_proposed', 'recurring_bills', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), `scan_${Date.now()}`,
    `Proposed ${proposals.length} recurring bills from ${days}-day Mercury scan. Skipped: ${JSON.stringify(skipped)}`,
    JSON.stringify({ count: proposals.length, skipped })
  ).run().catch(() => {});

  return { ok: true, scan_days: days, proposals_count: proposals.length, skipped, proposals };
}

// ── List recurring bills (active + draft) ────────────────────────────────
export async function listRecurringBills(env) {
  const { results } = await env.DB.prepare(`
    SELECT rb.id, rb.description, rb.expected_amount, rb.amount_variance_pct,
           rb.cadence, rb.expected_day_of_month, rb.expected_day_of_week,
           rb.next_expected_date, rb.is_active, rb.notes,
           v.name as vendor_name
    FROM recurring_bills rb
    LEFT JOIN vendors v ON v.id = rb.vendor_id
    ORDER BY rb.is_active DESC, rb.next_expected_date ASC
  `).all();

  const rows = results || [];
  const active = rows.filter(r => r.is_active);
  const drafts = rows.filter(r => !r.is_active);
  return {
    count: rows.length,
    active_count: active.length,
    draft_count: drafts.length,
    active,
    drafts,
  };
}

export async function activateRecurringBill(env, id) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'activate_recurring_bill' });
  const row = await env.DB.prepare(`SELECT id, description FROM recurring_bills WHERE id = ?`).bind(id).first();
  if (!row) return { error: 'not found' };
  await env.DB.prepare(`
    UPDATE recurring_bills SET is_active = 1,
      notes = COALESCE(notes, '') || ' | Activated ' || datetime('now') WHERE id = ?
  `).bind(id).run();
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
    VALUES (?, 'recurring_bill_activated', 'recurring_bills', ?, 'drew', ?)
  `).bind(crypto.randomUUID(), id, `Activated recurring bill: ${row.description}`).run().catch(() => {});
  return { ok: true, id, description: row.description };
}

export async function dismissRecurringBill(env, id, reason) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'dismiss_recurring_bill' });
  await env.DB.prepare(`DELETE FROM recurring_bills WHERE id = ? AND is_active = 0`).bind(id).run();
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
    VALUES (?, 'recurring_bill_dismissed', 'recurring_bills', ?, 'drew', ?)
  `).bind(crypto.randomUUID(), id, `Dismissed draft recurring bill: ${reason || 'no reason given'}`).run().catch(() => {});
  return { ok: true, id };
}
