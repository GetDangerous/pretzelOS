// workers/finance-qbo-pnl-truth.js
// Session 20C (May 14 2026) — Pull authoritative QBO P&L per month into
// qbo_pnl_truth table. Used by Phase 20D to post reconstruction JEs.
//
// QBO P&L reports are CASH BASIS (per the report header).
// Bookkeeper was active Feb 2025 - mid-Feb 2026. Pull through Apr 2026 to
// capture partial-bookkeeper Feb 2026 data; later phases will assess what's
// usable vs what needs rebuilding from raw POS.

import { getProfitAndLoss } from './qbo-client.js';

// Walk the nested QBO P&L Rows structure and yield flat (account_path, amount) rows.
// QBO structure: Row{Header,Rows,Summary} for sections + Row{ColData} for leaf accounts.
function* flatten(rows, path = []) {
  for (const r of rows || []) {
    if (r.Header) {
      const headerCols = r.Header?.ColData || [];
      const sectionName = headerCols[0]?.value || '';
      const newPath = [...path, sectionName];
      // QBO P&L quirk: a "parent" account (e.g., "Food Income") may have its own
      // balance posted directly to it (transactions tagged to parent, not a child).
      // The header row will then carry a non-zero amount in its last ColData cell.
      // We MUST emit that as a leaf or we'll under-count by exactly that amount.
      const headerAmt = parseFloat(headerCols[headerCols.length - 1]?.value || '0') || 0;
      if (Math.abs(headerAmt) > 0.001) {
        yield {
          path: newPath,
          account_name: sectionName,
          amount: headerAmt,
          is_subtotal: 0,
          note: 'parent_account_direct_balance',
        };
      }
      // Walk children
      yield* flatten(r.Rows?.Row || [], newPath);
      // Emit subtotal
      if (r.Summary?.ColData) {
        const cols = r.Summary.ColData;
        const total = parseFloat(cols[cols.length - 1]?.value || '0') || 0;
        if (Math.abs(total) > 0.001) {
          yield {
            path: newPath,
            account_name: `Total ${sectionName}`,
            amount: total,
            is_subtotal: 1,
          };
        }
      }
    } else if (r.ColData) {
      const cols = r.ColData;
      const name = cols[0]?.value || '';
      const total = parseFloat(cols[cols.length - 1]?.value || '0') || 0;
      if (name && Math.abs(total) > 0.001) {
        yield {
          path: [...path, name],
          account_name: name,
          amount: total,
          is_subtotal: 0,
        };
      }
    }
  }
}

// Top-level QBO section detection
function detectSection(path) {
  const root = path[0] || '';
  if (root === 'Income') return 'Income';
  if (root === 'Cost of Goods Sold') return 'COGS';
  if (root === 'Expenses') return 'Expenses';
  if (root === 'Other Income') return 'Other Income';
  if (root === 'Other Expenses') return 'Other Expenses';
  return root || 'Unknown';
}

// Pull single month from QBO API, parse, store
async function pullSingleMonth(env, period /* 'YYYY-MM' */) {
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${period}-${String(lastDay).padStart(2, '0')}`;

  const result = await getProfitAndLoss(env, start, end);
  if (result?.error) {
    return { period, ok: false, error: result.error };
  }
  const basis = result?.Header?.ReportBasis || 'Cash';
  const rows = result?.Rows?.Row || [];

  // Delete existing rows for this period (idempotent re-pull)
  await env.DB.prepare(`DELETE FROM qbo_pnl_truth WHERE period = ?`).bind(period).run();

  let inserted = 0;
  for (const item of flatten(rows)) {
    const section = detectSection(item.path);
    const account_path = item.path.join(' > ');
    await env.DB.prepare(`
      INSERT INTO qbo_pnl_truth (id, period, section, account_path, account_name, amount, is_subtotal, qbo_basis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), period, section, account_path,
      item.account_name, item.amount, item.is_subtotal, basis
    ).run();
    inserted++;
  }

  // Also capture key bottom-line totals from outer summary
  const summary = {
    period,
    basis,
    inserted,
    ok: true,
  };

  return summary;
}

// Pull multi-month range, return per-month summary
export async function pullPnLTruth(env, startPeriod, endPeriod) {
  const periods = [];
  let [sy, sm] = startPeriod.split('-').map(Number);
  let [ey, em] = endPeriod.split('-').map(Number);
  while (sy < ey || (sy === ey && sm <= em)) {
    periods.push(`${sy}-${String(sm).padStart(2, '0')}`);
    sm += 1;
    if (sm > 12) { sm = 1; sy += 1; }
  }

  const results = [];
  for (const p of periods) {
    const r = await pullSingleMonth(env, p);
    results.push(r);
    // small delay to be nice to QBO API
    await new Promise(res => setTimeout(res, 100));
  }
  return { ok: true, count: results.length, results };
}

// Summary of stored truth — useful for verification
export async function getPnLTruthSummary(env) {
  const { results } = await env.DB.prepare(`
    SELECT period, qbo_basis,
           ROUND(SUM(CASE WHEN section='Income' AND is_subtotal=0 THEN amount ELSE 0 END), 2) as income_line_total,
           ROUND(SUM(CASE WHEN section='COGS' AND is_subtotal=0 THEN amount ELSE 0 END), 2) as cogs_line_total,
           ROUND(SUM(CASE WHEN section='Expenses' AND is_subtotal=0 THEN amount ELSE 0 END), 2) as expense_line_total,
           ROUND(SUM(CASE WHEN section='Other Income' AND is_subtotal=0 THEN amount ELSE 0 END), 2) as other_income_total,
           ROUND(SUM(CASE WHEN section='Other Expenses' AND is_subtotal=0 THEN amount ELSE 0 END), 2) as other_expense_total,
           COUNT(*) as rows
    FROM qbo_pnl_truth
    GROUP BY period
    ORDER BY period
  `).all();
  return { ok: true, periods: results || [] };
}

// Per-account breakdown for one period
export async function getPnLTruthForPeriod(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT section, account_path, account_name, amount, is_subtotal
    FROM qbo_pnl_truth
    WHERE period = ?
    ORDER BY section, account_path
  `).bind(period).all();
  return { ok: true, period, lines: results || [] };
}
