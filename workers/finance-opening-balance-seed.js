// workers/finance-opening-balance-seed.js
// Session 21-pre (May 14 2026) — Opening Balance JE from QBO Balance Sheet
//
// Drew's bookkeeper was active Feb 2025 - mid-Feb 2026. Before Feb 2025,
// Pretzel had real assets/liabilities/equity from years of operation that
// our GL didn't capture (we only post sweep JEs from bookkeeper era onward).
//
// This seeder posts ONE JE dated 2025-01-31 (last day before bookkeeper era)
// using the QBO Balance Sheet as authoritative source. After this JE:
//   - Assets, liabilities, equity all reflect QBO bookkeeper state
//   - Forward operations (Feb 2025+) layer on top correctly
//   - BS as of 2025-02-01 onward will balance
//
// IDEMPOTENT: posting more than once via source_type+source_id check.
// AUDIT TRAIL: source_type='qbo_opening_balance_seed', preserved on reversal.
//
// Drew's directive (May 14 2026):
//   - Keep $770K Drew/Lindsay note as long-term liability (bookkeeper's
//     classification — preserves consistency with extended 2025 tax filing)
//   - Seed exactly as bookkeeper had it; flag issues separately

import { isReadOnly, readOnlySkip } from './finance-shared.js';

// QBO Balance Sheet as-of 2025-01-31 (pulled via /finance/qbo/balance-sheet)
// Each entry: { account_name, side, amount }
// side: 'debit' for assets (and contra-equity Dr balances), 'credit' for liabilities + equity Cr balances
const OPENING_BALANCE_DATA = [
  // ── ASSETS ── (debit balances)
  { account_name: 'Mercury Checking (0118) - 1',                  side: 'debit',  amount: 92617.86,  memo: 'Mercury checking OB' },
  { account_name: 'Mercury Savings (5450) - 1',                   side: 'debit',  amount: 22899.24,  memo: 'Mercury savings OB' },
  { account_name: 'Clearing Accounts:Cash Clearing',              side: 'debit',  amount: 10528.82,  memo: 'Cash clearing OB (pre-bookkeeper-era retail not yet swept)' },
  { account_name: 'Clearing Accounts:Credit Card Clearing',       side: 'debit',  amount: 38690.63,  memo: 'CC clearing OB' },
  { account_name: 'Clearing Accounts:Doordash Clearing',          side: 'debit',  amount: 13574.06,  memo: 'DoorDash clearing OB' },
  { account_name: 'Clearing Accounts:Grubhub Clearing',           side: 'debit',  amount: 646.67,    memo: 'Grubhub clearing OB' },
  { account_name: 'Clearing Accounts:UberEats Clearing',          side: 'debit',  amount: 3684.27,   memo: 'UberEats clearing OB' },
  { account_name: 'Branding',                                     side: 'debit',  amount: 44375.00,  memo: 'Branding (fixed asset) OB' },
  { account_name: 'Furniture & Fixtures',                         side: 'debit',  amount: 15111.66,  memo: 'F&F OB' },
  { account_name: 'Leasehold Improvements',                       side: 'debit',  amount: 446427.93, memo: 'Buildout (leasehold improvements) OB' },
  { account_name: 'Long-term office equipment',                   side: 'debit',  amount: 909.34,    memo: 'Office equipment OB' },
  { account_name: 'Restaurant equipment, tools, and Machinery',   side: 'debit',  amount: 198072.61, memo: 'Restaurant equipment OB (includes LEAF-financed + cash-purchased)' },
  { account_name: 'Signage',                                      side: 'debit',  amount: 8970.01,   memo: 'Signage OB' },
  { account_name: 'Security deposits',                            side: 'debit',  amount: 20932.49,  memo: 'Security deposits OB (rent + utility deposits)' },

  // ── LIABILITIES ── (credit balances; one negative Note Payable - Toast = debit)
  { account_name: 'Mercury Credit (0000) - 1',                    side: 'credit', amount: 1408.07,   memo: 'Mercury CC balance OB' },
  { account_name: 'Gift Card Liability',                          side: 'credit', amount: 1804.44,   memo: 'Outstanding gift cards OB' },
  { account_name: 'Note Payable - Toast',                         side: 'debit',  amount: 24.70,     memo: 'Note Payable - Toast OB (negative liability per QBO -$24.70)' },
  { account_name: 'Payroll Liabilities:Payroll tax to pay',       side: 'credit', amount: 1106.70,   memo: 'Payroll tax OB' },
  { account_name: 'Payroll Payable',                              side: 'credit', amount: 46869.65,  memo: 'Payroll payable OB (uncashed paychecks / pending payroll)' },
  { account_name: 'Prepaid Orders',                               side: 'credit', amount: 1599.05,   memo: 'Prepaid customer orders OB' },
  { account_name: 'Sales tax to pay',                             side: 'credit', amount: 17808.61,  memo: 'Sales tax OB' },
  { account_name: 'Tips Payable',                                 side: 'credit', amount: 3861.00,   memo: 'Tips payable OB' },
  { account_name: 'N/P LEAF Funding Comm Kitchen - 2',            side: 'credit', amount: 20296.58,  memo: 'LEAF Comm Kitchen #2 N/P balance @ 2025-01-31' },
  { account_name: 'N/P LEAF funding Commercial Kitchen Supply',   side: 'credit', amount: 17330.80,  memo: 'LEAF Commercial Kitchen Supply N/P balance @ 2025-01-31' },
  { account_name: 'N/P LEAF Funding Kemper Bakery',               side: 'credit', amount: 20026.61,  memo: 'LEAF Kemper Bakery N/P balance @ 2025-01-31' },
  { account_name: 'N/P LEAF funding Pizza Ovens',                 side: 'credit', amount: 47303.64,  memo: 'LEAF Pizza Ovens N/P balance @ 2025-01-31' },
  { account_name: 'Note Payable - Drew & Lindsay',                side: 'credit', amount: 770975.00, memo: 'Drew & Lindsay owner note OB (bookkeeper classified as long-term liab; functionally owner equity)' },

  // ── EQUITY ── (credit normal balance; debits = negative equity from accumulated losses)
  { account_name: 'Partner distributions',                        side: 'debit',  amount: 18.00,     memo: 'Partner distributions OB (-$18 negative balance = debit balance)' },
  { account_name: 'Partner investments',                          side: 'credit', amount: 1632.49,   memo: 'Partner investments parent OB' },
  { account_name: 'Partner investments:Drew and Lindsay',         side: 'credit', amount: 130568.80, memo: 'Drew & Lindsay capital contributions OB' },
  { account_name: 'Retained Earnings',                            side: 'debit',  amount: 225000.68, memo: 'Accumulated losses through prior years (negative RE = debit balance)' },
];

// Net Income $59,892.53 from QBO BS is FY2024-pending-close (or YTD Jan 2025).
// QBO splits it out until year-end close. For our seed, we credit Retained Earnings
// for this amount as if the year had been closed — BUT note that Drew's accountant
// may want to keep it separate for the 2024 vs 2025 tax filing distinction.
// Posting as a separate equity adjustment.
const PENDING_NET_INCOME = {
  account_name: 'Retained Earnings',
  side: 'credit',
  amount: 59892.53,
  memo: 'FY2024 net income (per QBO BS line "Net Income" $59,892.53) — pending year-end close to RE. Combined here for OB balance; if 2024 close is filed separately, adjust accordingly.',
};

// Date OB JE on YE 2024 (12-31-2024) so it cleanly precedes Jan 2025
// reconstruction JEs (which are dated 2025-01-31). QBO's BS as of YE 2024
// and 2025-01-31 are IDENTICAL because year-end close hasn't run in QBO —
// so dating OB at YE 2024 gives us cleanest separation between OB and ops.
const ENTRY_DATE = '2024-12-31';
const SOURCE_TYPE = 'qbo_opening_balance_seed';
const SOURCE_ID = 'qbo_bs_ye_2024';

export async function seedOpeningBalance(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'opening_balance_seed' });

  // Idempotency
  const existing = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE source_type = ? AND source_id = ? AND status = 'posted' LIMIT 1`
  ).bind(SOURCE_TYPE, SOURCE_ID).first();
  if (existing && !opts.force) {
    return { ok: false, error: 'already_seeded', existing_je: existing.id, note: 'Pass force=true to reverse + reseed' };
  }
  if (existing && opts.force) {
    await env.DB.prepare(
      `UPDATE journal_entries SET status='reversed', notes=COALESCE(notes,'') || ' | Force-reseeded at ' || datetime('now') WHERE id = ?`
    ).bind(existing.id).run();
  }

  // Resolve account ids
  const { results: accountRows } = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts`).all();
  const idByName = {};
  for (const r of accountRows || []) idByName[r.account_name] = r.id;

  // Build lines + verify all accounts exist + compute totals
  const lines = [...OPENING_BALANCE_DATA, PENDING_NET_INCOME];
  const missingAccounts = lines.filter(l => !idByName[l.account_name]);
  if (missingAccounts.length > 0) {
    return {
      ok: false,
      error: 'missing_coa_accounts',
      missing: missingAccounts.map(l => l.account_name),
    };
  }

  // Compute Dr/Cr totals
  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    if (l.side === 'debit') totalDebit += l.amount;
    else totalCredit += l.amount;
  }
  totalDebit = Math.round(totalDebit * 100) / 100;
  totalCredit = Math.round(totalCredit * 100) / 100;

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return {
      ok: false,
      error: 'unbalanced',
      total_debit: totalDebit,
      total_credit: totalCredit,
      delta: Math.round((totalDebit - totalCredit) * 100) / 100,
      note: 'Opening Balance JE does not balance. QBO BS may have rounding or missing accounts.',
    };
  }

  // Post the JE
  const entryId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session_21_pre', ?)
  `).bind(
    entryId, ENTRY_DATE,
    'Opening Balance from QBO BS as-of 2025-01-31 (bookkeeper-truth seed)',
    SOURCE_TYPE, SOURCE_ID, totalDebit, totalCredit,
    `Seeds all assets, liabilities, equity per QBO Balance Sheet on 2025-01-31. ${lines.length} lines. Bookkeeper-faithful per Drew (May 14 2026) — keeps $770K owner note as long-term liability for consistency with extended 2025 tax filing.`
  ).run();

  let lineNum = 1;
  for (const l of lines) {
    const accId = idByName[l.account_name];
    const dr = l.side === 'debit' ? l.amount : 0;
    const cr = l.side === 'credit' ? l.amount : 0;
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), entryId, lineNum++, accId, dr, cr, l.memo).run();
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'opening_balance_seed', 'journal_entries', ?, 'session_21_pre', ?, ?)
  `).bind(
    crypto.randomUUID(), entryId,
    `Seeded Opening Balance JE: ${lines.length} accounts, Dr/Cr $${totalDebit}`,
    JSON.stringify({ entry_id: entryId, line_count: lines.length, total: totalDebit })
  ).run().catch(() => {});

  return {
    ok: true,
    entry_id: entryId,
    entry_date: ENTRY_DATE,
    line_count: lines.length,
    total_debit: totalDebit,
    total_credit: totalCredit,
    summary: {
      assets_seeded: OPENING_BALANCE_DATA.filter(l => l.side === 'debit' && !l.account_name.includes('Note Payable - Toast') && !l.account_name.includes('Partner distributions') && !l.account_name.includes('Retained Earnings')).length,
      liabilities_seeded: OPENING_BALANCE_DATA.filter(l => l.side === 'credit' && (l.account_name.includes('N/P') || l.account_name.includes('Note Payable') || l.account_name.includes('Payable') || l.account_name.includes('tax to pay') || l.account_name.includes('Gift Card') || l.account_name.includes('Credit (') || l.account_name.includes('Prepaid'))).length,
      equity_seeded: OPENING_BALANCE_DATA.filter(l => l.account_name.startsWith('Partner') || l.account_name === 'Retained Earnings').length,
    },
  };
}

// Verify BS balances as of a given date
export async function verifyBalanceSheet(env, asOf = '2025-01-31') {
  const { results } = await env.DB.prepare(`
    SELECT c.account_type, c.account_subtype, c.account_name,
           ROUND(SUM(
             CASE
               WHEN c.account_type IN ('asset') THEN l.debit - l.credit
               WHEN c.account_type IN ('liability','equity') THEN l.credit - l.debit
               ELSE 0
             END
           ), 2) as balance
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.entry_date <= ?
      AND c.account_type IN ('asset','liability','equity')
    GROUP BY c.id
    HAVING balance != 0
    ORDER BY c.account_type, c.account_name
  `).bind(asOf).all();

  // Add cumulative net income to date (for Current Year Earnings line)
  const netIncome = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN c.account_type = 'revenue' THEN l.credit - l.debit
        WHEN c.account_type IN ('cogs','expense','other_expense') THEN -(l.debit - l.credit)
        WHEN c.account_type = 'other_income' THEN l.credit - l.debit
        ELSE 0
      END
    ), 2) as ytd_net_income
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.entry_date <= ?
      AND c.account_type IN ('revenue','cogs','expense','other_expense','other_income')
  `).bind(asOf).first();

  let totalAssets = 0;
  let totalLiabilities = 0;
  let totalEquity = 0;
  for (const r of results || []) {
    if (r.account_type === 'asset') totalAssets += r.balance;
    else if (r.account_type === 'liability') totalLiabilities += r.balance;
    else if (r.account_type === 'equity') totalEquity += r.balance;
  }
  // Current year earnings rolls into equity
  const currentYearEarnings = netIncome?.ytd_net_income || 0;
  totalEquity += currentYearEarnings;

  totalAssets = Math.round(totalAssets * 100) / 100;
  totalLiabilities = Math.round(totalLiabilities * 100) / 100;
  totalEquity = Math.round(totalEquity * 100) / 100;
  const totalLiabPlusEquity = Math.round((totalLiabilities + totalEquity) * 100) / 100;
  const unbalancedBy = Math.round((totalAssets - totalLiabPlusEquity) * 100) / 100;

  return {
    as_of: asOf,
    accounts: results || [],
    summary: {
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      total_equity_gl_accounts: Math.round((totalEquity - currentYearEarnings) * 100) / 100,
      current_year_earnings_live: currentYearEarnings,
      total_equity_including_cye: totalEquity,
      total_liabilities_plus_equity: totalLiabPlusEquity,
      unbalanced_by: unbalancedBy,
      balances: Math.abs(unbalancedBy) < 0.01,
    },
  };
}
