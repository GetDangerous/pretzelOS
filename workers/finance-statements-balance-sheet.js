// workers/finance-statements-balance-sheet.js
// Session 21C (May 14 2026) — Complete Balance Sheet statement.
//
// Replaces QBO as Drew's primary BS source. Reads from GL only.
//
// Standard BS structure:
//   ASSETS
//     Current Assets (cash, bank accounts, AR, inventory, security deposits)
//     Fixed Assets (equipment, leasehold improvements, less accumulated depreciation)
//     Other Assets
//   = TOTAL ASSETS
//
//   LIABILITIES
//     Current Liabilities (CC, AP, sales tax, tips, gift cards, payroll, current loan portion)
//     Long-term Liabilities (LEAF loans, Drew/Lindsay note)
//   = TOTAL LIABILITIES
//
//   EQUITY
//     Owner Capital (Partner investments)
//     Owner Distributions (negative)
//     Retained Earnings (prior years cumulative)
//     Current Year Earnings (YTD net income, computed live)
//   = TOTAL EQUITY
//
//   TOTAL LIABILITIES + EQUITY = TOTAL ASSETS  (balance check)

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// Determine fiscal year start for a given as-of date
function fiscalYearStart(asOf) {
  const date = new Date(asOf + 'T00:00:00Z');
  return `${date.getUTCFullYear()}-01-01`;
}

// Read balances by account, classified by account_type + account_subtype
async function readBalances(env, asOf) {
  const { results } = await env.DB.prepare(`
    SELECT c.id as account_id,
           c.account_name,
           c.account_type,
           c.account_subtype,
           ROUND(SUM(
             CASE
               WHEN c.account_type = 'asset' THEN l.debit - l.credit
               WHEN c.account_type IN ('liability','equity') THEN l.credit - l.debit
               ELSE 0
             END
           ), 2) as balance
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date <= ?
      AND c.account_type IN ('asset','liability','equity')
    GROUP BY c.id
    HAVING balance != 0
    ORDER BY c.account_type, c.account_subtype, c.account_name
  `).bind(asOf).all();
  return results || [];
}

// Compute current year earnings (P&L net income from fiscal year start to as-of).
//
// Foundational behavior (Phase 21V-audit-6): INCLUDES fiscal_year_close JEs in
// the sum. The close JE explicitly zeros out P&L accounts (DR Revenue + CR Expense
// to net out FY net income into Retained Earnings). When the close JE has already
// fired for the current FY (close dated within current FY <= as_of), summing all
// P&L activity including the close naturally yields 0 (the close zeroed it).
// When no close JE has posted yet (mid-year or YE-before-close), the close JE
// doesn't exist so CYE = real P&L net.
//
// This avoids double-counting: pre-audit-6, we filtered close from CYE which
// meant after close fires, equityGL got the RE roll-in PLUS CYE got the P&L net,
// double-counting the FY result. Including close in CYE makes CYE = 0 post-close.
async function computeCurrentYearEarnings(env, asOf) {
  const fyStart = fiscalYearStart(asOf);
  const row = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit
        WHEN c.account_type IN ('cogs','expense','other_expense') THEN -(l.debit - l.credit)
        ELSE 0
      END
    ), 2) as cye
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND c.account_type IN ('revenue','cogs','expense','other_expense','other_income')
  `).bind(fyStart, asOf).first();
  return r2(row?.cye || 0);
}

// Compute cumulative net income from prior fiscal years that has NOT yet been
// closed into Retained Earnings via a fiscal_year_close JE.
//
// Foundational behavior (Phase 21V-audit-5 F3): when a real close JE exists for
// a year, that year's P&L net is already in the GL Retained Earnings account, so
// we don't double-count it here. We only sum P&L from years AFTER the most-recent
// posted close, up to the FY before current.
//
// If close JEs are posted every year (standard practice), this returns ~0.
// If no close JE has been posted yet, returns the full cumulative prior-year P&L
// (the synthetic rollover that was the previous workaround).
async function computePriorYearEarnings(env, asOf) {
  const fyStart = fiscalYearStart(asOf);
  const d = new Date(fyStart + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  const priorFyEnd = d.toISOString().slice(0, 10);

  // Find the latest close JE date that's <= priorFyEnd. After that date,
  // P&L starts accumulating again (the next FY) until the next close.
  const closeRow = await env.DB.prepare(`
    SELECT MAX(entry_date) as last_close FROM journal_entries
    WHERE status='posted' AND source_type='fiscal_year_close' AND entry_date <= ?
  `).bind(asOf).first();

  // P&L summed from (last close date) to (prior FY end). If no prior close,
  // sums from the earliest GL date up to priorFyEnd.
  const startDate = closeRow?.last_close || '1970-01-01';
  const row = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit
        WHEN c.account_type IN ('cogs','expense','other_expense') THEN -(l.debit - l.credit)
        ELSE 0
      END
    ), 2) as pye
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date > ?
      AND j.entry_date <= ?
      AND c.account_type IN ('revenue','cogs','expense','other_expense','other_income')
  `).bind(startDate, priorFyEnd).first();
  return r2(row?.pye || 0);
}

// Build a balance sheet section grouped by subtype
function buildSection(rows, predicate, label, subtypeLabels) {
  const filtered = rows.filter(predicate);
  const grouped = {};
  for (const r of filtered) {
    const subtype = r.account_subtype || 'unclassified';
    if (!grouped[subtype]) grouped[subtype] = [];
    grouped[subtype].push(r);
  }
  const subsections = Object.keys(grouped).map(subtype => {
    const items = grouped[subtype].map(r => ({
      account_id: r.account_id,
      account_name: r.account_name,
      balance: r.balance,
    }));
    const total = r2(items.reduce((s, i) => s + i.balance, 0));
    return {
      subtype,
      label: subtypeLabels?.[subtype] || subtype,
      items,
      total,
    };
  });
  const sectionTotal = r2(subsections.reduce((s, ss) => s + ss.total, 0));
  return { label, subsections, total: sectionTotal };
}

// ── Main: build Balance Sheet ────────────────────────────────────────────
export async function getBalanceSheet(env, asOf, compareTo = 'none', compareDate = null) {
  const balances = await readBalances(env, asOf);
  const cye = await computeCurrentYearEarnings(env, asOf);
  const pye = await computePriorYearEarnings(env, asOf);  // synthetic year-end-close rollover

  // Build sections
  const assetLabels = { current_asset: 'Current Assets', fixed_asset: 'Fixed Assets', other_asset: 'Other Assets' };
  const liabLabels = { current_liability: 'Current Liabilities', long_term_liability: 'Long-term Liabilities' };
  const equityLabels = {
    partner_contributions: 'Partner Investments',
    partner_distributions: 'Partner Distributions',
    retained_earnings: 'Retained Earnings (prior years)',
    opening_balance_equity: 'Opening Balance Equity',
  };

  const assets = buildSection(balances, r => r.account_type === 'asset', 'ASSETS', assetLabels);
  const liabilities = buildSection(balances, r => r.account_type === 'liability', 'LIABILITIES', liabLabels);
  const equityGL = buildSection(balances, r => r.account_type === 'equity', 'EQUITY (from GL)', equityLabels);

  // Add CYE (current FY P&L net) + PYE (synthetic prior-FY rollover) as synthetic equity
  // PYE represents the cumulative net income from prior fiscal years that should have
  // been closed into Retained Earnings via year-end JEs. We compute it dynamically so
  // the BS balances even without those JEs ever being posted.
  const equityTotal = r2(equityGL.total + cye + pye);

  // Balance check
  const liabPlusEquity = r2(liabilities.total + equityTotal);
  const unbalancedBy = r2(assets.total - liabPlusEquity);

  let comparison = null;
  if (compareTo && compareTo !== 'none') {
    let priorAsOf;
    if (compareTo === 'prior_year_end') {
      const d = new Date(asOf + 'T00:00:00Z');
      priorAsOf = `${d.getUTCFullYear() - 1}-12-31`;
    } else if (compareTo === 'prior_month_end') {
      const d = new Date(asOf + 'T00:00:00Z');
      d.setUTCDate(0);  // last day of prior month
      priorAsOf = d.toISOString().slice(0, 10);
    } else if (compareTo === 'custom' && compareDate) {
      priorAsOf = compareDate;
    }
    if (priorAsOf) {
      const priorBS = await getBalanceSheet(env, priorAsOf, 'none');
      comparison = {
        as_of: priorAsOf,
        total_assets: priorBS.summary.total_assets,
        total_liabilities: priorBS.summary.total_liabilities,
        total_equity: priorBS.summary.total_equity,
        current_year_earnings: priorBS.summary.current_year_earnings,
      };
    }
  }

  return {
    ok: true,
    as_of: asOf,
    fiscal_year_start: fiscalYearStart(asOf),
    basis: 'cash',
    sections: {
      assets,
      liabilities,
      equity: {
        label: 'EQUITY',
        subsections: [
          ...equityGL.subsections,
          ...(Math.abs(pye) > 0.005 ? [{
            subtype: 'prior_year_earnings_rollover',
            label: 'Retained Earnings (FY close rollover)',
            items: [{
              account_id: null,
              account_name: `Net P&L through FY ${parseInt(asOf.slice(0, 4)) - 1} (synthetic close)`,
              balance: pye,
            }],
            total: pye,
          }] : []),
          {
            subtype: 'current_year_earnings',
            label: 'Current Year Earnings',
            items: [{
              account_id: null,
              account_name: `Net Income FY ${asOf.slice(0, 4)} YTD`,
              balance: cye,
            }],
            total: cye,
          },
        ],
        total: equityTotal,
      },
    },
    summary: {
      total_assets: assets.total,
      total_liabilities: liabilities.total,
      total_equity_gl: equityGL.total,
      prior_year_earnings_rollover: pye,
      current_year_earnings: cye,
      total_equity: equityTotal,
      total_liabilities_plus_equity: liabPlusEquity,
      unbalanced_by: unbalancedBy,
      balances: Math.abs(unbalancedBy) < 0.01,
    },
    compare_to: compareTo,
    comparison,
    source: 'gl_reconstruction (Session 20+) + OB 2024-12-31',
  };
}

// CSV export
export function bsToCsv(bs) {
  const lines = [];
  lines.push(`Pretzel OS — Balance Sheet`);
  lines.push(`As of: ${bs.as_of}`);
  lines.push(`Fiscal Year Start: ${bs.fiscal_year_start}`);
  lines.push(`Basis: ${bs.basis}`);
  if (bs.comparison) lines.push(`Compared to: ${bs.comparison.as_of}`);
  lines.push('');

  const hasCompare = !!bs.comparison;
  lines.push(hasCompare ? 'Account,Balance,Prior,Variance' : 'Account,Balance');

  const writeSection = (section) => {
    lines.push(`"=== ${section.label} ==="`);
    for (const sub of section.subsections) {
      lines.push(`"--- ${sub.label} ---"`);
      for (const item of sub.items) {
        lines.push(`"${item.account_name}",${item.balance.toFixed(2)}`);
      }
      lines.push(`"  Total ${sub.label}",${sub.total.toFixed(2)}`);
    }
    lines.push(`"=== Total ${section.label} ===",${section.total.toFixed(2)}`);
    lines.push('');
  };

  writeSection(bs.sections.assets);
  writeSection(bs.sections.liabilities);
  writeSection(bs.sections.equity);
  lines.push(`"TOTAL LIABILITIES + EQUITY",${bs.summary.total_liabilities_plus_equity.toFixed(2)}`);
  lines.push(`"Unbalanced by",${bs.summary.unbalanced_by.toFixed(2)}`);

  return lines.join('\n');
}

// Drill-down: explain a balance — show all JEs that built it
export async function explainBalanceChange(env, accountId, fromDate, toDate) {
  const account = await env.DB.prepare(
    `SELECT id, account_name, account_type FROM chart_of_accounts WHERE id = ?`
  ).bind(accountId).first();
  if (!account) return { ok: false, error: 'account_not_found' };

  // Opening balance as-of fromDate (one day before)
  const dayBefore = new Date(fromDate + 'T00:00:00Z');
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const openingBalanceRow = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN ? IN ('asset') THEN l.debit - l.credit
        WHEN ? IN ('liability','equity') THEN l.credit - l.debit
        ELSE 0
      END
    ), 2) as balance
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    WHERE j.status = 'posted'
      AND l.account_id = ?
      AND j.entry_date <= ?
  `).bind(account.account_type, account.account_type, accountId, dayBefore.toISOString().slice(0, 10)).first();

  const opening = r2(openingBalanceRow?.balance || 0);

  const { results } = await env.DB.prepare(`
    SELECT j.id as je_id, j.entry_date, j.description, j.source_type,
           l.debit, l.credit, l.memo
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    WHERE j.status = 'posted'
      AND l.account_id = ?
      AND j.entry_date >= ? AND j.entry_date <= ?
    ORDER BY j.entry_date, j.id
  `).bind(accountId, fromDate, toDate).all();

  const debits = (results || []).reduce((s, r) => s + (r.debit || 0), 0);
  const credits = (results || []).reduce((s, r) => s + (r.credit || 0), 0);
  const periodChange = ['asset'].includes(account.account_type)
    ? r2(debits - credits)
    : r2(credits - debits);
  const closing = r2(opening + periodChange);

  return {
    ok: true,
    account: account.account_name,
    account_type: account.account_type,
    from_date: fromDate,
    to_date: toDate,
    opening_balance: opening,
    period_change: periodChange,
    closing_balance: closing,
    je_count: results?.length || 0,
    lines: results || [],
  };
}
