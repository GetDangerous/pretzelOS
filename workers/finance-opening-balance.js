// workers/finance-opening-balance.js
// Finance v2 — Opening balance load (Wave 2.17).
// Per PRETZEL_OS_FINANCE_V2.md section 2.17.
//
// CRITICAL SAFETY: this writes a single giant JE that sets opening balances for
// every account as-of a cutover date (default 2026-05-01). Once committed, the
// JE is locked. Drew MUST review the dry-run output before committing.
//
// Endpoint:
//   POST /finance/cfo/opening-balance/preview?cutover=YYYY-MM-DD
//   POST /finance/cfo/opening-balance/commit?cutover=YYYY-MM-DD   (also requires ?acknowledge=1 and Irene sign-off note)
//
// Sources of truth used:
//   - Mercury live balances (cash: overrides the stale QBO figure)
//   - chart_of_accounts for all accounts; QBO archive for balance as-of
//   - Spec section 2.17 corrections:
//       * Drew/Lindsay $770,975 Note Payable → Equity (Capital Contribution)
//       * Todd & Amanda $80,000 N/P and their equity contribution → zeroed
//       * $57,784 accumulated depreciation per 2024 Form 4562 (catch-up)
//       * LEAF loan balances reconciled against Mercury payment history
//       * Payroll Payable $46,869 → write off per B2 audit (<$5k residual)
//       * $4,698 Ask My Accountant → zero, categorize to Uncategorized Expense
//       * $67,124 in clearing accounts → investigate per B2, write off stale

import { isReadOnly, readOnlySkip } from './finance-shared.js';

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// Named corrections from the spec. Drew + Irene can adjust the dollar amounts
// before committing by POSTing overrides.
const DEFAULT_CORRECTIONS = {
  drew_lindsay_loan: {
    from_account_pattern: /note payable.*drew.*lindsay/i,
    amount: -770975,  // current book value (liability)
    to_account_name: 'Partner investments',
    treatment: 'reclassify',
    note: 'Reclassify from Note Payable to Capital Contribution per 2024 tax return + Drew confirmation',
  },
  todd_amanda_loan: {
    from_account_pattern: /note payable.*todd.*amanda|note payable.*partner/i,
    amount: 0,  // zero out the whole thing
    to_account_name: null,
    treatment: 'zero_out',
    note: 'Todd & Amanda paid off; their N/P and equity both zero out',
  },
  accumulated_depreciation_catchup: {
    amount: -57784,  // credit (increase accum dep = contra-asset credit balance)
    to_account_name: 'Accumulated depreciation',
    treatment: 'catchup',
    note: '2024 tax return Form 4562: $53,119 depreciation + $2,363 amortization + 2025 YTD carryforward. Confirm with Irene before committing.',
  },
  payroll_payable_writeoff: {
    from_account_pattern: /payroll payable/i,
    amount_min: 4000,       // leave this much accrued (residual for legit unpaid wages)
    to_account_name: 'Other income',
    treatment: 'writeoff_excess',
    note: 'Per B2 audit: net imbalance ~$4,255 by EOY 2025. Spec\'s $46,869 was a stale snapshot.',
  },
  ask_my_accountant_writeoff: {
    from_account_pattern: /ask my accountant/i,
    amount: 0,
    to_account_name: 'Uncategorized expense',  // or per-transaction review if known
    treatment: 'zero_out',
    note: 'Move $4,698 uncategorized to holding expense account for Irene review.',
  },
  clearing_aged_writeoff: {
    from_account_patterns: [/cash clearing/i, /credit card clearing/i, /doordash clearing/i, /ubereats clearing/i, /grubhub clearing/i],
    threshold_days: 90,
    to_account_name: 'Reconciliation discrepancies',  // or Other Income per spec option
    treatment: 'age_and_writeoff',
    note: 'Clearing balances older than 90 days get written off. $67,124 total per spec — Irene to apportion.',
  },
};

// ── Gather Mercury live balances as the AUTHORITATIVE cash position ───────
async function mercuryLiveBalances(env) {
  const { results } = await env.DB.prepare(
    `SELECT account_name, current_balance FROM mercury_accounts WHERE is_active = 1`
  ).all();
  const out = {};
  for (const r of (results || [])) {
    const m = r.account_name?.match(/\((\d{4})\)/) || r.account_name?.match(/\b(\d{4})\b/);
    const suffix = m?.[1];
    if (suffix) out[suffix] = { name: r.account_name, balance: r.current_balance || 0 };
  }
  return out;
}

// Resolve a COA id by name match
async function findAccount(env, pattern) {
  if (pattern instanceof RegExp) {
    const { results } = await env.DB.prepare(
      `SELECT id, account_name, account_type FROM chart_of_accounts WHERE is_active = 1`
    ).all();
    return (results || []).find(r => pattern.test(r.account_name)) || null;
  }
  return await env.DB.prepare(
    `SELECT id, account_name, account_type FROM chart_of_accounts WHERE LOWER(account_name) = LOWER(?) LIMIT 1`
  ).bind(pattern).first();
}

// Resolve account by explicit override (COA id, exact name, or regex).
// Overrides let Drew/Irene remap the spec's named accounts onto the real
// QBO account names in this COA without editing code.
async function resolveOverride(env, overrides, key) {
  const override = overrides?.[key];
  if (!override) return null;
  if (override.account_id) {
    const row = await env.DB.prepare(`SELECT id, account_name FROM chart_of_accounts WHERE id = ?`).bind(override.account_id).first();
    return row || null;
  }
  if (override.account_name) {
    return await findAccount(env, override.account_name);
  }
  return null;
}

// ── Generate the dry-run (preview) of what the opening balance JE will be ─
// Overrides shape (all optional):
// {
//   drew_lindsay_loan:   { account_id | account_name, amount? },
//   partner_equity:      { account_id | account_name },
//   todd_amanda_loan:    { account_id | account_name, amount? },
//   accumulated_depreciation: { account_id | account_name, amount? },
//   depreciation_expense: { account_id | account_name },
//   payroll_payable:     { account_id | account_name, writeoff_amount?, residual? },
//   other_income:        { account_id | account_name },
//   ask_my_accountant:   { account_id | account_name, amount? },
//   uncategorized_expense: { account_id | account_name },
//   skip: ['drew_lindsay_loan', ...]  // keys to exclude entirely
// }
export async function previewOpeningBalance(env, cutoverDate, overrides = {}) {
  cutoverDate = cutoverDate || '2026-05-01';
  overrides = overrides || {};
  const skip = new Set(overrides.skip || []);

  const mercury = await mercuryLiveBalances(env);

  // Build proposed JE lines. Each line is either Dr or Cr.
  const lines = [];
  let totalDr = 0, totalCr = 0;
  const push = (account_name, account_id, debit, credit, memo) => {
    const d = round2(debit || 0), c = round2(credit || 0);
    lines.push({ account_name, account_id, debit: d, credit: c, memo });
    totalDr += d; totalCr += c;
  };

  const unresolved = [];  // corrections we couldn't apply because no account matched

  // 1. Mercury cash (LIVE from Mercury API — overrides QBO staleness)
  for (const [suffix, info] of Object.entries(mercury)) {
    const coa = await findAccount(env, new RegExp(`Mercury.*\\(${suffix}\\)`));
    if (!coa) continue;
    if (info.balance >= 0) {
      push(coa.account_name, coa.id, info.balance, 0, `Opening cash balance from Mercury API (${cutoverDate})`);
    } else {
      push(coa.account_name, coa.id, 0, -info.balance, `Opening cash balance from Mercury API (${cutoverDate}) — negative means credit card debt`);
    }
  }

  // 2. Drew/Lindsay reclassification (spec 2.17)
  if (!skip.has('drew_lindsay_loan')) {
    const dlLoan = (await resolveOverride(env, overrides, 'drew_lindsay_loan')) ||
                   (await findAccount(env, DEFAULT_CORRECTIONS.drew_lindsay_loan.from_account_pattern));
    const partnerEquity = (await resolveOverride(env, overrides, 'partner_equity')) ||
                          (await findAccount(env, /partner.*investment|member.*equity|partner.*contribution/i));
    const amount = Number(overrides.drew_lindsay_loan?.amount ?? 770975);
    if (dlLoan && partnerEquity) {
      push(dlLoan.account_name, dlLoan.id, amount, 0, `Reclassify Drew/Lindsay $${amount.toLocaleString()} from Note Payable to equity`);
      push(partnerEquity.account_name, partnerEquity.id, 0, amount, 'Reclassify from Drew/Lindsay Note Payable');
    } else {
      unresolved.push({ correction: 'drew_lindsay_loan', reason: `missing ${dlLoan ? '' : 'drew_lindsay_loan account, '}${partnerEquity ? '' : 'partner_equity account'}`, override_via: "POST ?overrides with drew_lindsay_loan.account_name and partner_equity.account_name" });
    }
  }

  // 3. Todd & Amanda zero-out
  if (!skip.has('todd_amanda_loan')) {
    const taLoan = (await resolveOverride(env, overrides, 'todd_amanda_loan')) ||
                   (await findAccount(env, /note payable.*todd.*amanda|todd.*amanda.*note/i));
    const partnerEquity = (await resolveOverride(env, overrides, 'partner_equity')) ||
                          (await findAccount(env, /partner.*investment|member.*equity|partner.*contribution/i));
    const amount = Number(overrides.todd_amanda_loan?.amount ?? 80000);
    if (taLoan) {
      push(taLoan.account_name, taLoan.id, amount, 0, 'Zero out Todd & Amanda N/P (paid off)');
      if (partnerEquity) push(partnerEquity.account_name, partnerEquity.id, 0, amount, 'Offset against Todd & Amanda equity removal');
    } else if (!overrides.todd_amanda_loan) {
      // Quietly skip — spec says account may already be cleared. Only flag if Drew explicitly configured.
    }
  }

  // 4. Accumulated depreciation catchup
  if (!skip.has('accumulated_depreciation')) {
    const accDep = (await resolveOverride(env, overrides, 'accumulated_depreciation')) ||
                   (await findAccount(env, /accumulated depreciation/i));
    const depExp = (await resolveOverride(env, overrides, 'depreciation_expense')) ||
                   (await findAccount(env, /depreciation expense|depreciation$/i));
    const amount = Number(overrides.accumulated_depreciation?.amount ?? 57784);
    if (accDep && depExp) {
      push(depExp.account_name, depExp.id, amount, 0, 'Catch-up depreciation per 2024 Form 4562');
      push(accDep.account_name, accDep.id, 0, amount, 'Offsetting accumulated depreciation');
    } else {
      unresolved.push({ correction: 'accumulated_depreciation', reason: `missing ${accDep ? '' : 'accumulated_depreciation account, '}${depExp ? '' : 'depreciation_expense account'}`, override_via: "POST ?overrides with accumulated_depreciation.account_name and depreciation_expense.account_name" });
    }
  }

  // 5. Payroll Payable write-off (excess beyond residual)
  if (!skip.has('payroll_payable')) {
    const prPayable = (await resolveOverride(env, overrides, 'payroll_payable')) ||
                      (await findAccount(env, /payroll payable/i));
    const otherIncome = (await resolveOverride(env, overrides, 'other_income')) ||
                        (await findAccount(env, /^other income/i));
    const residual = Number(overrides.payroll_payable?.residual ?? 4255);
    const writeoff = Number(overrides.payroll_payable?.writeoff_amount ?? (46869 - residual));
    if (prPayable && otherIncome) {
      push(prPayable.account_name, prPayable.id, writeoff, 0, `Write off excess Payroll Payable (keep $${residual.toLocaleString()} residual per audit)`);
      push(otherIncome.account_name, otherIncome.id, 0, writeoff, 'Stale liability writeoff to Other Income');
    } else {
      unresolved.push({ correction: 'payroll_payable', reason: `missing ${prPayable ? '' : 'payroll_payable account, '}${otherIncome ? '' : 'other_income account'}`, override_via: "POST ?overrides with payroll_payable.account_name and other_income.account_name" });
    }
  }

  // 6. Ask My Accountant zero-out
  if (!skip.has('ask_my_accountant')) {
    const askAcct = (await resolveOverride(env, overrides, 'ask_my_accountant')) ||
                    (await findAccount(env, /ask my accountant/i));
    const uncatExp = (await resolveOverride(env, overrides, 'uncategorized_expense')) ||
                     (await findAccount(env, /uncategorized expense|miscellaneous expense|legal.*accounting/i));
    const amount = Number(overrides.ask_my_accountant?.amount ?? 4698);
    if (askAcct && uncatExp) {
      push(uncatExp.account_name, uncatExp.id, amount, 0, `Move $${amount.toLocaleString()} Ask My Accountant to Uncategorized Expense for Irene review`);
      push(askAcct.account_name, askAcct.id, 0, amount, 'Zero out Ask My Accountant');
    } else if (askAcct) {
      unresolved.push({ correction: 'ask_my_accountant', reason: 'missing uncategorized_expense account', override_via: "POST ?overrides with uncategorized_expense.account_name" });
    }
  }

  // Check if balanced
  const unbalancedBy = round2(totalDr - totalCr);
  const status = Math.abs(unbalancedBy) < 0.01 ? 'balanced' : 'UNBALANCED';

  return {
    cutover_date: cutoverDate,
    status,
    total_debit: round2(totalDr),
    total_credit: round2(totalCr),
    unbalanced_by: unbalancedBy,
    lines_count: lines.length,
    lines,
    unresolved_corrections: unresolved,
    overrides_applied: Object.keys(overrides).filter(k => k !== 'skip'),
    safeguards: [
      'DRY RUN — no JE has been posted. To commit: POST /finance/cfo/opening-balance/commit?cutover=YYYY-MM-DD&acknowledge=1 with body {"irene_signoff_note":"..."}',
      'Once committed, the opening balance JE is LOCKED and can only be reversed with a manual unlock + new JE.',
      'Verify each line against QBO Balance Sheet + 2024 tax return before committing.',
    ],
    next_steps: [
      unbalancedBy !== 0
        ? '1. Preview is UNBALANCED. POST with ?overrides={"drew_lindsay_loan":{"account_name":"<real QBO name>"}, ...} to remap corrections onto real accounts.'
        : '1. Drew + Irene review this balanced preview line-by-line',
      '2. If specific accounts do not map: POST with ?overrides={"skip":["correction_key"]} to exclude',
      '3. POST /finance/cfo/opening-balance/commit with ?acknowledge=1 + body.irene_signoff_note',
    ],
    override_hint: {
      shape: {
        drew_lindsay_loan: { account_id_or_account_name: 'string', amount: 770975 },
        partner_equity: { account_name: 'Partner investments:Drew and Lindsay' },
        todd_amanda_loan: { account_name: '...', amount: 80000 },
        accumulated_depreciation: { account_name: '...', amount: 57784 },
        depreciation_expense: { account_name: '...' },
        payroll_payable: { account_name: '...', writeoff_amount: 42614, residual: 4255 },
        other_income: { account_name: '...' },
        ask_my_accountant: { account_name: '...', amount: 4698 },
        uncategorized_expense: { account_name: '...' },
        skip: ['drew_lindsay_loan', 'payroll_payable'],
      },
      example_curl: `curl -X POST 'https://pretzel-os.drew-f39.workers.dev/finance/cfo/opening-balance/preview?cutover=2026-05-01' -H 'Content-Type: application/json' -d '{"drew_lindsay_loan":{"account_name":"Partner Capital - Drew and Lindsay"}}'`,
    },
  };
}

// ── Commit (writes the JE + locks it) ────────────────────────────────────
export async function commitOpeningBalance(env, cutoverDate, body) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'opening_balance_commit' });
  if (!body?.irene_signoff_note || body.irene_signoff_note.length < 5) {
    return { error: 'irene_signoff_note required (paste the email from Irene acknowledging these numbers)' };
  }

  // Refuse if already committed
  const existing = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE source_type = 'opening_balance' AND status = 'posted'`
  ).first();
  if (existing) {
    return { error: 'opening balance already committed', existing_entry_id: existing.id, note: 'To re-do: reverse existing entry + unlock closed period first.' };
  }

  // Pass overrides through so commit uses the same remapping Drew previewed.
  const preview = await previewOpeningBalance(env, cutoverDate, body?.overrides || {});
  if (preview.status !== 'balanced') {
    return { error: 'preview is not balanced — cannot commit. Adjust overrides and preview again.', preview };
  }

  // Post the massive JE
  const entryId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
      total_debit, total_credit, status, created_by, notes)
    VALUES (?, ?, 'OPENING BALANCE — DO NOT MODIFY', 'opening_balance', ?, ?, ?, 'posted', 'opening_balance', ?)
  `).bind(
    entryId, cutoverDate,
    cutoverDate,
    preview.total_debit, preview.total_credit,
    `Opening balance as of ${cutoverDate}. Irene signoff: ${body.irene_signoff_note}`
  ).run();

  let lineNum = 1;
  for (const line of preview.lines) {
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), entryId, lineNum++,
      line.account_id, line.debit, line.credit, line.memo
    ).run();
  }

  // Lock all prior periods (anything before cutover_date)
  await env.DB.prepare(`
    INSERT OR IGNORE INTO closed_periods (id, period_start, period_end, locked_at, locked_by, unlock_reason)
    VALUES (?, '2020-01-01', ?, datetime('now'), 'opening_balance', 'Opening balance committed; all pre-cutover periods locked.')
  `).bind(crypto.randomUUID(), cutoverDate).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'opening_balance_committed', 'journal_entries', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), entryId,
    `Opening balance committed for ${cutoverDate}. Total Dr/Cr $${preview.total_debit}. Irene: ${body.irene_signoff_note}`,
    JSON.stringify({ cutover: cutoverDate, entry_id: entryId, lines: preview.lines_count })
  ).run();

  return { ok: true, entry_id: entryId, cutover_date: cutoverDate, lines: preview.lines_count, locked: true };
}
