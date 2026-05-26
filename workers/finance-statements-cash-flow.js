// workers/finance-statements-cash-flow.js
// Session 21D (May 14 2026) — Complete Cash Flow Statement (indirect method).
//
// Standard CF structure:
//   OPERATING ACTIVITIES
//     Net Income (from P&L)
//     +/- Non-cash items (Depreciation)
//     +/- Working capital changes:
//       (Increase)/Decrease in AR
//       Increase/(Decrease) in AP
//       Increase/(Decrease) in Sales Tax Payable
//       Increase/(Decrease) in Tips Payable
//       Increase/(Decrease) in Gift Card Liability
//       Increase/(Decrease) in Payroll Payable
//       (Note: Inventory NOT tracked per Drew's decision May 14)
//     = Net Cash from Operating
//
//   INVESTING ACTIVITIES
//     Purchases of fixed assets
//     Disposals of fixed assets
//     = Net Cash from Investing
//
//   FINANCING ACTIVITIES
//     Loan principal payments (LEAF, owner notes)
//     Owner capital contributions
//     Owner distributions
//     = Net Cash from Financing
//
//   = NET CHANGE IN CASH
//
//   Opening Cash + Net Change = Closing Cash (reconciles to Mercury bank delta)

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ─────────────────────────────────────────────────────────────────────────
// SESSION 28-B FOUNDATIONAL: source_type whitelist for cash events.
// ─────────────────────────────────────────────────────────────────────────
// The SOCF "direct cash" components (capex, equity contributions/distributions,
// loan principal) must ONLY count JEs that represent REAL movement at the
// bank level. Indirect-method WC adjustments (AR, AP, accruals) intentionally
// include ALL source types because they bridge accrual NI back to cash.
//
// Whitelist (CASH events at the bank):
//   - 'mercury_txn' — Mercury bank txn (the only real cash source today)
//   - Future: 'plaid_chase_txn', 'plaid_bank_txn' when Plaid Production wires up
//
// Non-cash source types (intentionally excluded from cash items):
//   - 'mercury_io_statement_txn', 'chase_ink_statement_txn' — CC charges; cash leg
//     happens when Mercury pays the CC statement (captured separately via mercury_txn)
//   - 'qbo_je_ingest' — bookkeeper-era PPE JEs; real cash legs already in mercury_txn
//   - 'qbo_pnl_reconstruction', 'qbo_expense_reconciliation' — bookkeeper P&L truth
//   - 'qbo_payment_wholesale_reconstruction' — wholesale recon (touches Cash Clearing)
//   - 'toast_sales_summary_reconstruction', 'square_pos_reconstruction' — POS recon
//   - 'monthly_depreciation', 'monthly_amortization', 'sec179_depreciation',
//     'depreciation_backfill' — non-cash by definition
//   - 'partner_contribution' — non-cash partner asset contribution (e.g., Sprinter)
//   - 'qbo_opening_balance_seed' — YE2024 OB (no cash event)
//   - 'fiscal_year_close' — Year-end close to RE
//   - 'pre_sync_adjustment', 'reclass_to_equity', 'sales_tax_reclass', 'cogs_reclass',
//     'channel_fees_reclass_v1', 'cash_drawer_reclass', 'cleanup_reclass',
//     'bookkeeper_tips_tax_accrual' — all non-cash reclasses/accruals
//
// Why whitelist (not blacklist): a new bookkeeper-era source_type added in the
// future would NOT leak into capex/equity/loan calcs. Blacklist is fragile —
// the round-2/3 feedback specifically called out the Bridge BLOQ Section 110
// reclass (fiscal_year_close source) leaking into capex via blacklist gaps.
// Phase 29-D: 'dp_payroll_cash_leg' added — these are the cash legs of Toast
// Payroll Mercury settlements that the bookkeeper-era PPE accruals never closed.
// Each one is a real Mercury Checking CR matching a Mercury bank statement txn.
// Same cash-event semantics as mercury_txn for SOCF purposes.
// Phase 31-B1 (May 20 2026): 'leaf_amortization_reconstruction' added — under
// Pattern B clearing architecture, this worker's DR N/P LEAF principal lines
// ARE the cash-event representation of loan paydown (paired with CR LEAF Clearing,
// which is funded by mercury_txn). Excluding it from the whitelist hid $27,694
// of FY2025 LEAF principal paydown from the SOCF financing section.
// Same cash-event semantics as the other two for SOCF purposes.
// Phase 31-B1 also adds 'phase_30_dp_cash_leg' (the Phase 30 replacement of
// dp_payroll_cash_leg consolidating all 40 Dangerous Pretze cycles).
export const CASH_SOURCE_TYPES = ['mercury_txn', 'dp_payroll_cash_leg', 'phase_30_dp_cash_leg', 'leaf_amortization_reconstruction'];
// SQL fragment used in cash-event queries. Quoted exactly once here so the
// Tier 1 invariant can verify it appears in all four cash queries.
const CASH_SOURCE_WHITELIST_SQL = `j.source_type IN ('mercury_txn','dp_payroll_cash_leg','phase_30_dp_cash_leg','leaf_amortization_reconstruction')`;

// Read net income (P&L) for period.
// Excludes fiscal_year_close (the close JE inverts all P&L lines to wash NI to $0 — would corrupt SOCF).
// Mirrors the same filter applied in finance-statements-pnl.js, finance-monthly-pl.js, finance-trends.js.
async function netIncome(env, start, end) {
  const r = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit
        WHEN c.account_type IN ('cogs','expense','other_expense') THEN -(l.debit - l.credit)
        ELSE 0
      END
    ), 2) as ni
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND j.source_type != 'fiscal_year_close'
      AND c.account_type IN ('revenue','other_income','cogs','expense','other_expense')
      AND c.is_active = 1  -- Phase 31-A1 (May 20 2026): mirror P&L is_active filter — suppresses deactivated Delivery Fees:* contra-revenue mirror accounts
  `).bind(start, end).first();
  return r2(r?.ni || 0);
}

// Read depreciation expense for period (non-cash add-back).
// Excludes fiscal_year_close (close JE CR's Depreciation Expense to wash it for FY end — would zero out the add-back).
async function depreciationExpense(env, start, end) {
  const r = await env.DB.prepare(`
    SELECT ROUND(SUM(l.debit - l.credit), 2) as dep
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND j.source_type != 'fiscal_year_close'
      AND (c.account_name LIKE '%Depreciation%' OR c.account_name LIKE '%Amortization%')
      AND c.account_type IN ('expense','other_expense')
      AND c.is_active = 1  -- Phase 31-A1: mirror P&L filter
  `).bind(start, end).first();
  return r2(r?.dep || 0);
}

// Balance of an account as-of a date (positive convention: liability/equity = credit, asset = debit).
// excludeSourceTypes: optional array of j.source_type values to exclude (e.g., ['partner_contribution']).
async function accountBalance(env, accountFilter, asOf, excludeSourceTypes = null) {
  let sourceFilter = '';
  if (Array.isArray(excludeSourceTypes) && excludeSourceTypes.length) {
    const list = excludeSourceTypes.map(s => `'${String(s).replace(/'/g, "''")}'`).join(',');
    sourceFilter = ` AND j.source_type NOT IN (${list})`;
  }
  const r = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN c.account_type = 'asset' THEN l.debit - l.credit
        WHEN c.account_type IN ('liability','equity') THEN l.credit - l.debit
        ELSE 0
      END
    ), 2) as bal
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.entry_date <= ?${sourceFilter}
      AND (${accountFilter})
  `).bind(asOf).first();
  return r2(r?.bal || 0);
}

// Working capital change: (closing - opening). For assets: positive = cash OUT.
// For liabilities: positive = cash IN.
// excludeSourceTypes: array of source_type values to exclude from BOTH balances (e.g., 'partner_contribution' for non-cash equity).
async function wcChange(env, accountFilter, start, end, isAsset, excludeSourceTypes = null) {
  const dayBefore = new Date(start + 'T00:00:00Z');
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const opening = await accountBalance(env, accountFilter, dayBefore.toISOString().slice(0, 10), excludeSourceTypes);
  const closing = await accountBalance(env, accountFilter, end, excludeSourceTypes);
  const change = r2(closing - opening);
  // Cash impact: -change for assets (more AR = less cash); +change for liabilities (more AP = more cash held)
  const cashImpact = isAsset ? -change : change;
  return { opening, closing, change, cash_impact: cashImpact };
}

// Capex (fixed asset additions during period, excluding depreciation).
// Excludes partner_contribution (e.g., Sprinter $200K contributed as capital — non-cash, would double-count
// with equity contributions and falsely appear as an investing outflow).
async function capexAdditions(env, start, end) {
  // Session 28-B foundational fix: WHITELIST source_type to only count
  // real cash events (mercury_txn) for capex. Replaces fragile blacklist
  // from Session 27. A new bookkeeper-era source_type added in the future
  // would not leak into capex.
  //
  // FY2025 historical context: $12,338.93 of real Mercury capex purchases
  // (Shauna Spencer Des design + Restaurant Equipment via Mercury txns).
  // Excludes: partner_contribution (Sprinter $200K non-cash), fiscal_year_close
  // (Bridge BLOQ Section 110 reclass), depreciation_backfill, qbo_opening_balance_seed.
  const r = await env.DB.prepare(`
    SELECT ROUND(SUM(l.debit - l.credit), 2) as capex
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND ${CASH_SOURCE_WHITELIST_SQL}
      AND c.account_subtype = 'fixed_asset'
      AND c.account_name NOT LIKE '%Depreciation%'
      AND c.account_name NOT LIKE '%Amortization%'
  `).bind(start, end).first();
  return r2(r?.capex || 0);
}

// Session 28-B foundational: sum REAL CASH activity for an account category
// over a period, using only whitelisted source_types. Differs from wcChange
// (which computes balance changes from opening to closing including non-cash
// reclasses). For SOCF cash items (capex, equity, loans), only real cash
// movements at the bank count.
//
// Returns: { activity, cash_impact, jes_counted }
// - activity = SUM(credit-debit) for liability/equity, SUM(debit-credit) for asset
//   (matches the convention that increasing equity/liability = cash in, increasing asset = cash out)
// - cash_impact = +activity for liability/equity (more = cash in)
//                = -activity for asset (more = cash out)
async function cashActivityForCategory(env, accountFilter, start, end, isAsset) {
  const r = await env.DB.prepare(`
    SELECT ROUND(SUM(
      CASE
        WHEN c.account_type = 'asset' THEN l.debit - l.credit
        WHEN c.account_type IN ('liability','equity') THEN l.credit - l.debit
        ELSE 0
      END
    ), 2) as activity,
    COUNT(DISTINCT l.journal_entry_id) as jes_counted
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND ${CASH_SOURCE_WHITELIST_SQL}
      AND (${accountFilter})
  `).bind(start, end).first();
  const activity = r2(r?.activity || 0);
  const cashImpact = isAsset ? -activity : activity;
  return { activity, cash_impact: cashImpact, jes_counted: r?.jes_counted || 0 };
}

// Net loan principal payments — REAL cash only (mercury_txn whitelisted).
// Session 28-B: replaced wcChange (balance delta, includes non-cash reclasses
// like the $19K bookkeeper qbo_je_ingest Equity→Note Payable Drew & Lindsay
// reclass) with cashActivityForCategory (whitelisted activity only).
// FY2025 expected: -$41,672 of LEAF principal payments (4 loans).
async function loanPrincipalChange(env, start, end) {
  const filter = `c.account_subtype = 'long_term_liability'`;
  const r = await cashActivityForCategory(env, filter, start, end, false);
  // Backward-compat shape: return wcChange-like object with opening/closing/change/cash_impact
  // Opening/closing intentionally null — this is activity-based, not balance-delta-based.
  return {
    opening: null, closing: null,
    change: r.activity, cash_impact: r.cash_impact,
    jes_counted: r.jes_counted, source: 'mercury_txn-only (Session 28-B whitelist)',
  };
}

// Owner contributions and distributions — REAL cash only (mercury_txn whitelisted).
// Session 28-B foundational fix: replaced wcChange (balance delta) with
// cashActivityForCategory (whitelisted activity).
//
// FY2025 historical context — what gets EXCLUDED by whitelist:
//   - $200K Sprinter (partner_contribution) — non-cash asset contribution
//   - $80K partner-exit settlement (fiscal_year_close) — DR Partner Inv / CR Pre-Sync Adj (both equity)
//   - $19K qbo_je_ingest equity reclasses to Note Payable — non-cash
// FY2025 EXPECTED: +$50K real cash (Drew Sept 2025 Wells Fargo Mercury transfers).
async function equityChanges(env, start, end) {
  const contributionsFilter = `c.account_type = 'equity' AND c.account_subtype = 'partner_contributions'`;
  const distributionsFilter = `c.account_type = 'equity' AND c.account_subtype = 'partner_distributions'`;
  const contrib = await cashActivityForCategory(env, contributionsFilter, start, end, false);
  const distrib = await cashActivityForCategory(env, distributionsFilter, start, end, false);
  // Backward-compat shape for callers expecting opening/closing/change/cash_impact
  // Distributions: more distributions = contra-equity DR balance = cash OUT
  // Activity for distributions account_type='equity' subtype='partner_distributions':
  //   When Drew takes a distribution: DR Partner Distributions / CR Mercury → in cashActivityForCategory
  //   activity = credit - debit on equity account = negative (DR side > CR side)
  //   cash_impact = activity (negative) — correct (cash out)
  return {
    contributions: { opening: null, closing: null, change: contrib.activity, cash_impact: contrib.cash_impact, jes_counted: contrib.jes_counted, source: 'mercury_txn-only (Session 28-B whitelist)' },
    distributions: { opening: null, closing: null, change: distrib.activity, cash_impact: distrib.cash_impact, jes_counted: distrib.jes_counted, source: 'mercury_txn-only (Session 28-B whitelist)' },
  };
}

// Read cash balance (sum of Mercury asset accounts) at as-of date
async function cashBalance(env, asOf) {
  const filter = `c.account_name LIKE 'Mercury Checking%' OR c.account_name LIKE 'Mercury Savings%'`;
  return accountBalance(env, filter, asOf);
}

// ── Main: Cash Flow Statement (indirect method) ──────────────────────────
export async function getCashFlowStatement(env, start, end) {
  // 1. Net Income
  const ni = await netIncome(env, start, end);

  // 2. Non-cash: depreciation
  const dep = await depreciationExpense(env, start, end);

  // 3. Working capital — current assets (excl. cash)
  // Session 28-A fix: replaced brittle LIKE '%AR%' substring with category lookup.
  // The previous filter caught: Clearing Accounts (cle**AR**ing), Partner
  // Investments + distributions + Retained E**ar**nings (equity), Gift C**ar**d
  // Liability, St**ar**tup costs, Payroll Cle**ar**ing. For FY2025 it summed to
  // $111,804 "AR change" — almost entirely equity + clearing churn with $0 real AR.
  // True AR (`working_capital_category='ar'`) is the only thing that should
  // appear in this working-capital line.
  const arFilter = `c.working_capital_category = 'ar'`;
  const ar = await wcChange(env, arFilter, start, end, true);

  // Inventory — Drew's decision May 14: NOT tracked. Skip.

  // 4. Working capital — current liabilities (excl. CC, loans)
  // Session 26-E: replaced brittle account_name LIKE patterns with
  // working_capital_category lookup (migration 065). New accounts in these
  // buckets surface automatically without code changes.
  const apFilter = `c.working_capital_category = 'ap'`;
  const ap = await wcChange(env, apFilter, start, end, false);

  // Sales tax + payroll tax both flow through wcChange; treated together for
  // the SOCF "Increase/Decrease in Tax Payable" line.
  const salesTaxFilter = `c.working_capital_category IN ('sales_tax_payable','payroll_tax_payable')`;
  const salesTax = await wcChange(env, salesTaxFilter, start, end, false);

  const tipsFilter = `c.working_capital_category = 'tips_payable'`;
  const tips = await wcChange(env, tipsFilter, start, end, false);

  const giftFilter = `c.working_capital_category = 'gift_card_liability'`;
  const gift = await wcChange(env, giftFilter, start, end, false);

  const payrollPayFilter = `c.working_capital_category = 'payroll_payable'`;
  const payrollPay = await wcChange(env, payrollPayFilter, start, end, false);

  // Phase 29-final: POS clearing accounts treated as working-capital (current asset).
  // Their growth/shrinkage during the period is "should-be-cash" in transit.
  // FY2025 Cash Clearing grew $162K (bookkeeper-era reconstruction posting gross
  // revenue to clearing before Mercury settlement closed the loop). This needs
  // to appear in SOCF as a working capital line, not leak from the reconciliation.
  const clearingFilter = `c.working_capital_category = 'clearing'`;
  const clearing = await wcChange(env, clearingFilter, start, end, true);  // isAsset=true

  // Phase 29-final: Prepaid expenses + other current assets (asset)
  const prepaidFilter = `c.working_capital_category IN ('prepaid_expenses','other_current_asset')`;
  const prepaid = await wcChange(env, prepaidFilter, start, end, true);

  // Accrued liabilities + other current liabilities
  const accruedFilter = `c.working_capital_category = 'accrued_liabilities'`;
  const accrued = await wcChange(env, accruedFilter, start, end, false);

  // Credit card balances (Mercury Credit + Chase Ink) — financing-cash equivalent
  const ccFilter = `c.working_capital_category = 'credit_card_liability'`;
  const cc = await wcChange(env, ccFilter, start, end, false);

  // Short-term loans (Note Payable - Toast)
  const shortLoanFilter = `c.working_capital_category = 'short_term_loan'`;
  const shortLoan = await wcChange(env, shortLoanFilter, start, end, false);

  // Reclass holding (Pre-Pretzel-OS Reconciliation — bookkeeper artifact)
  const reclassHoldingFilter = `c.working_capital_category = 'reclass_holding'`;
  const reclassHolding = await wcChange(env, reclassHoldingFilter, start, end, false);

  // Operating cash flow
  const operatingCash = r2(ni + dep + ar.cash_impact + ap.cash_impact + salesTax.cash_impact + tips.cash_impact + gift.cash_impact + payrollPay.cash_impact + clearing.cash_impact + prepaid.cash_impact + accrued.cash_impact + cc.cash_impact + shortLoan.cash_impact + reclassHolding.cash_impact);

  // 5. Investing: Capex
  const capex = await capexAdditions(env, start, end);  // positive = bought fixed asset = cash OUT
  const investingCash = r2(-capex);

  // 6. Financing: loan principal changes + equity changes
  const loans = await loanPrincipalChange(env, start, end);  // positive change = took new loan = cash IN
  const equity = await equityChanges(env, start, end);
  const financingCash = r2(loans.cash_impact + equity.contributions.cash_impact + equity.distributions.cash_impact);

  // 7. Prior-Period Restatement Adjustments (Phase 29 — GAAP supplemental)
  // ────────────────────────────────────────────────────────────────────
  // Phase 29 corrected bookkeeper-era OB drift and reconciled GL Mercury to
  // actual bank statements at every month-end. These adjustments touch Mercury
  // (cash impact) but offset to equity accounts that aren't in standard SOCF
  // operating/investing/financing buckets (YE2024 Bank Reconciliation Adjustment,
  // Pre-Sync Adjustments). Under GAAP these are PRIOR-PERIOD RESTATEMENTS —
  // they should appear as supplemental disclosures, not in operating cash flow.
  //
  // Captures Mercury Checking + Mercury Savings impact for the period from
  // source_types whose offset is to "restatement equity" reserves.
  const restatementR = await env.DB.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN c.account_name IN ('Mercury Checking (0118) - 1','Mercury Savings (5450) - 1')
                     THEN l.debit - l.credit ELSE 0 END), 2) AS mercury_impact,
      COUNT(DISTINCT j.id) AS je_count
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_entry_id = j.id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status='posted'
      AND j.entry_date >= ? AND j.entry_date <= ?
      AND j.source_type IN (
        'phase_29_ob_correction',
        'phase_29_recon_adj',
        'pre_sync_adjustment'
      )
  `).bind(start, end).first();
  const restatementCash = r2(restatementR?.mercury_impact || 0);
  const restatementJeCount = restatementR?.je_count || 0;

  // Net change
  const netChange = r2(operatingCash + investingCash + financingCash + restatementCash);

  // Reconcile against actual cash balance change
  const dayBefore = new Date(start + 'T00:00:00Z');
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const openingCash = await cashBalance(env, dayBefore.toISOString().slice(0, 10));
  const closingCash = await cashBalance(env, end);
  const actualCashChange = r2(closingCash - openingCash);
  const unreconciled = r2(netChange - actualCashChange);

  return {
    ok: true,
    period_start: start,
    period_end: end,
    basis: 'cash',
    sections: {
      operating: {
        label: 'Operating Activities',
        lines: [
          { label: 'Net Income', amount: ni },
          { label: 'Depreciation & Amortization (non-cash)', amount: dep },
          { label: '(Increase)/Decrease in Accounts Receivable', amount: ar.cash_impact, detail: { opening: ar.opening, closing: ar.closing, change: ar.change } },
          { label: 'Increase/(Decrease) in Accounts Payable', amount: ap.cash_impact, detail: { opening: ap.opening, closing: ap.closing, change: ap.change } },
          { label: 'Increase/(Decrease) in Sales Tax Payable', amount: salesTax.cash_impact, detail: { opening: salesTax.opening, closing: salesTax.closing, change: salesTax.change } },
          { label: 'Increase/(Decrease) in Tips Payable', amount: tips.cash_impact, detail: { opening: tips.opening, closing: tips.closing, change: tips.change } },
          { label: 'Increase/(Decrease) in Gift Card Liability', amount: gift.cash_impact, detail: { opening: gift.opening, closing: gift.closing, change: gift.change } },
          { label: 'Increase/(Decrease) in Payroll Payable', amount: payrollPay.cash_impact, detail: { opening: payrollPay.opening, closing: payrollPay.closing, change: payrollPay.change } },
          { label: '(Increase)/Decrease in POS Clearing Accounts', amount: clearing.cash_impact, detail: { opening: clearing.opening, closing: clearing.closing, change: clearing.change } },
          { label: '(Increase)/Decrease in Prepaid + Other Current Assets', amount: prepaid.cash_impact, detail: { opening: prepaid.opening, closing: prepaid.closing, change: prepaid.change } },
          { label: 'Increase/(Decrease) in Accrued Liabilities', amount: accrued.cash_impact, detail: { opening: accrued.opening, closing: accrued.closing, change: accrued.change } },
          { label: 'Increase/(Decrease) in Credit Card Liabilities', amount: cc.cash_impact, detail: { opening: cc.opening, closing: cc.closing, change: cc.change } },
          { label: 'Increase/(Decrease) in Short-Term Loans', amount: shortLoan.cash_impact, detail: { opening: shortLoan.opening, closing: shortLoan.closing, change: shortLoan.change } },
          { label: 'Increase/(Decrease) in Reclass Holding (bookkeeper artifact)', amount: reclassHolding.cash_impact, detail: { opening: reclassHolding.opening, closing: reclassHolding.closing, change: reclassHolding.change } },
        ],
        total: operatingCash,
      },
      investing: {
        label: 'Investing Activities',
        lines: [
          { label: 'Purchases of Fixed Assets', amount: -capex },
        ],
        total: investingCash,
      },
      financing: {
        label: 'Financing Activities',
        lines: [
          { label: 'Net Loan Activity (proceeds - principal payments)', amount: loans.cash_impact, detail: { opening: loans.opening, closing: loans.closing, change: loans.change } },
          { label: 'Owner Capital Contributions', amount: equity.contributions.cash_impact },
          { label: 'Owner Distributions', amount: equity.distributions.cash_impact },
        ],
        total: financingCash,
      },
      prior_period_restatement: {
        label: 'Prior-Period Restatement Adjustments (Non-Cash GL Corrections)',
        note: 'Phase 29 OB correction + monthly Mercury reconciliation + pre-sync adjustments. These are GAAP supplemental disclosures of GL corrections that bring book Mercury balance to actual bank statements. They touch cash but offset to restatement-equity reserves (YE2024 Bank Reconciliation Adjustment + Pre-Sync Adjustments) rather than P&L.',
        lines: [
          { label: 'Phase 29 / Pre-Sync GL Corrections (Mercury impact)', amount: restatementCash, detail: { je_count: restatementJeCount } },
        ],
        total: restatementCash,
      },
    },
    summary: {
      net_change_in_cash: netChange,
      opening_cash: openingCash,
      closing_cash: closingCash,
      actual_cash_change: actualCashChange,
      unreconciled: unreconciled,
      reconciles: Math.abs(unreconciled) < 1.0,  // Within $1
    },
    notes: [
      'Inventory not tracked separately per operational decision (May 14 2026). Supply purchases hit COGS as period expense.',
      `Reconciliation: Net Change ${netChange} ${unreconciled === 0 ? '=' : 'vs'} Actual Cash Change ${actualCashChange} (unreconciled: ${unreconciled})`,
      'Cash basis statements. Other-than-Mercury cash sources (e.g., petty cash in drawer) flow through Cash Clearing.',
    ],
    source: 'gl_reconstruction (Session 20+) + OB 2024-12-31',
  };
}

export function cfToCsv(cf) {
  const lines = [];
  lines.push(`Pretzel OS — Cash Flow Statement (Indirect Method)`);
  lines.push(`Period: ${cf.period_start} → ${cf.period_end}`);
  lines.push(`Basis: ${cf.basis}`);
  lines.push('');
  lines.push('Activity,Description,Amount');

  for (const sectionKey of ['operating', 'investing', 'financing', 'prior_period_restatement']) {
    const section = cf.sections[sectionKey];
    lines.push(`"=== ${section.label} ==="`);
    for (const line of section.lines) {
      lines.push(`"${section.label}","${line.label}",${line.amount.toFixed(2)}`);
    }
    lines.push(`"${section.label}","Net Cash from ${section.label}",${section.total.toFixed(2)}`);
    lines.push('');
  }

  const s = cf.summary;
  lines.push(`"=== Reconciliation ==="`);
  lines.push(`"Summary","Net Change in Cash",${s.net_change_in_cash.toFixed(2)}`);
  lines.push(`"Summary","Opening Cash Balance",${s.opening_cash.toFixed(2)}`);
  lines.push(`"Summary","Closing Cash Balance",${s.closing_cash.toFixed(2)}`);
  lines.push(`"Summary","Actual Cash Change (from bank)",${s.actual_cash_change.toFixed(2)}`);
  lines.push(`"Summary","Unreconciled",${s.unreconciled.toFixed(2)}`);

  return lines.join('\n');
}
