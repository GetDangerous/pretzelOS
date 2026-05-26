// workers/finance-session-24-cleanup.js
// Session 24 final cleanup batch — Mercury categorization + Payroll Payable drain.
//
// Per Drew direction (May 16 2026):
//   - No owner draws — Drew Sparks $80K = equity contribution
//   - Uncashed paychecks (Payroll Payable OB) are void → drain to Pre-Sync Adjustments
//   - 41 INTUIT wholesale settlements need DR Mercury / CR AR
//
// Bridge BLOQ $123K and Wells Fargo -$80K and Elyse Doty -$362 deferred for Drew decision.

const ACCOUNTS = {
  mercury_checking: '0d8b692d-01fa-44fe-9e8f-a7ef1f3dacb8',
  partner_inv_dl: 'f7eb67c2-68d0-42f6-8dbb-4e4d856c662f',
  ar: '36fb48df-17f7-4044-8246-fc5f09395a46',
  payroll_payable: 'f512c947-f299-4871-8c8e-da20a9669715',
  psa: 'b1a7490b7f01d75b0283398a268b5452',
};

async function unlockClosedPeriods(env, periods) {
  for (const p of periods) {
    await env.DB.prepare(`
      UPDATE closed_periods SET unlocked_at = datetime('now'), unlock_reason = 'Session 24 final cleanup'
       WHERE period_start = ? AND period_end = ? AND unlocked_at IS NULL
    `).bind(p.start, p.end).run();
  }
}

async function relockClosedPeriods(env, periods) {
  for (const p of periods) {
    await env.DB.prepare(`
      UPDATE closed_periods SET unlocked_at = NULL, unlock_reason = NULL, locked_at = datetime('now')
       WHERE period_start = ? AND period_end = ?
    `).bind(p.start, p.end).run();
  }
}

async function postJE(env, { id, date, description, source_type, notes, lines }) {
  const total = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const existing = await env.DB.prepare(`SELECT id FROM journal_entries WHERE id = ?`).bind(id).first();
  if (existing) return { skipped: true, je_id: id };
  await env.DB.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, source_type, source_id, total_debit, total_credit, status, created_by, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', 'session-24-cleanup', ?, datetime('now'))
  `).bind(id, date, description, source_type, id, total, total, notes).run();
  let n = 1;
  for (const l of lines) {
    await env.DB.prepare(`
      INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
    `).bind(id, n++, l.account_id, l.debit || 0, l.credit || 0).run();
  }
  return { posted: true, je_id: id, total };
}

export async function runFinalCleanup(env, { dry_run = false } = {}) {
  const log = [];
  const allPeriods = [
    { start: '2025-01-01', end: '2025-12-31' },
    { start: '2024-12-01', end: '2024-12-31' },
  ];

  // ── Batch 1: Drew Sparks $80K equity contribution (Feb 12 2025) ───────────
  const drewSparksJE = {
    id: '24c-drew-sparks-contrib-2025-02-12',
    date: '2025-02-12',
    description: 'Drew Sparks owner equity contribution Feb 12 2025',
    source_type: 'fiscal_year_close', // exclude from P&L; preserves FY2025 cent-accuracy
    notes: 'Drew Sparks +$80,000 Mercury Checking inflow Feb 12 2025 (description: "SCH REF"). Per Drew direction May 16: no owner draws, contributions are equity. CR Partner investments:Drew and Lindsay. DR Mercury Checking (cash inflow already in actual balance). Tagged fiscal_year_close so this doesnt affect FY2025 P&L recompute.',
    lines: [
      { account_id: ACCOUNTS.mercury_checking, debit: 80000.00, credit: 0 },
      { account_id: ACCOUNTS.partner_inv_dl, debit: 0, credit: 80000.00 },
    ],
  };

  // ── Batch 2: Drain Payroll Payable OB $46,869.65 ──────────────────────────
  const payrollDrainJE = {
    id: '24c-payroll-payable-ob-drain-2024-12-31',
    date: '2024-12-31',
    description: 'Drain Payroll Payable OB — uncashed paychecks void per Drew',
    source_type: 'fiscal_year_close',
    notes: 'Payroll Payable OB $46,869.65 (from QBO YE2024 BS seed) represents pre-Pretzel-OS-era uncashed paychecks. Per Drew direction May 16 2026: all old uncashed paychecks are void — payroll was taken care of in cash or on next paycheck. DR Payroll Payable to drain; CR Pre-Sync Adjustments to absorb (bookkeeper-era reconciliation residual). Tagged fiscal_year_close.',
    lines: [
      { account_id: ACCOUNTS.payroll_payable, debit: 46869.65, credit: 0 },
      { account_id: ACCOUNTS.psa, debit: 0, credit: 46869.65 },
    ],
  };

  // ── Batch 3: 41 INTUIT wholesale settlements ──────────────────────────────
  // Get them dynamically — these are unmatched sent INTUIT Mercury inflows
  const { results: intuit } = await env.DB.prepare(`
    SELECT id, txn_date, amount, counterparty_name
      FROM mercury_transactions
     WHERE status='sent' AND amount > 0
       AND counterparty_name LIKE 'INTUIT%'
       AND (matched_journal_entry_id IS NULL
            OR matched_journal_entry_id NOT IN (SELECT id FROM journal_entries WHERE status='posted'))
     ORDER BY txn_date
  `).all();

  const intuitTotal = (intuit || []).reduce((s, t) => s + (t.amount || 0), 0);
  const intuitJE = {
    id: '24c-intuit-wholesale-settlements-bulk',
    date: '2026-05-16',
    description: `Bulk post ${(intuit || []).length} INTUIT QBO wholesale settlement inflows`,
    source_type: 'qbo_payment_wholesale_settlement',
    notes: `${(intuit || []).length} INTUIT inflows totaling $${intuitTotal.toFixed(2)} representing QBO wholesale customer payments via Intuit Payment Network. DR Mercury Checking (cash receipt); CR Accounts Receivable (drain AR). Per Session 24 audit — these were the "41 INTUIT JEs not yet posted" Phase 24-C deferred work, posted as single bulk JE for efficiency.`,
    lines: [
      { account_id: ACCOUNTS.mercury_checking, debit: intuitTotal, credit: 0 },
      { account_id: ACCOUNTS.ar, debit: 0, credit: intuitTotal },
    ],
  };

  if (dry_run) {
    return {
      ok: true, dry_run: true,
      plan: {
        drew_sparks: { amount: 80000.00, je_id: drewSparksJE.id },
        payroll_drain: { amount: 46869.65, je_id: payrollDrainJE.id },
        intuit_bulk: { count: (intuit || []).length, total: intuitTotal, je_id: intuitJE.id },
      },
    };
  }

  // Execute
  await unlockClosedPeriods(env, allPeriods);

  const drewResult = await postJE(env, drewSparksJE);
  log.push({ step: 'drew_sparks', ...drewResult });

  const payrollResult = await postJE(env, payrollDrainJE);
  log.push({ step: 'payroll_drain', ...payrollResult });

  const intuitResult = await postJE(env, intuitJE);
  log.push({ step: 'intuit_bulk', count: (intuit || []).length, ...intuitResult });

  // Mark the 41 INTUIT mercury_transactions as matched to the bulk JE
  if (intuitResult.posted) {
    for (const t of (intuit || [])) {
      await env.DB.prepare(`
        UPDATE mercury_transactions SET matched_journal_entry_id = ?, is_reconciled = 1 WHERE id = ?
      `).bind(intuitJE.id, t.id).run();
    }
    log.push({ step: 'intuit_link', count: (intuit || []).length });
  }

  // Also link the Drew Sparks Mercury txn
  await env.DB.prepare(`
    UPDATE mercury_transactions SET matched_journal_entry_id = ?, is_reconciled = 1
     WHERE counterparty_name LIKE 'DREW M SPARKS%' AND txn_date='2025-02-12' AND amount=80000.00
  `).bind(drewSparksJE.id).run();
  log.push({ step: 'drew_sparks_link' });

  await relockClosedPeriods(env, allPeriods);

  // Compute balances after
  const bal = await env.DB.prepare(`
    SELECT
      ROUND(SUM(CASE WHEN c.account_name='Payroll Payable' THEN l.credit - l.debit ELSE 0 END), 2) AS payroll_payable,
      ROUND(SUM(CASE WHEN c.account_name='Accounts Receivable (A/R)' THEN l.debit - l.credit ELSE 0 END), 2) AS ar,
      ROUND(SUM(CASE WHEN c.account_name='Partner investments:Drew and Lindsay' THEN l.credit - l.debit ELSE 0 END), 2) AS partner_dl
      FROM journal_entry_lines l JOIN journal_entries j ON j.id=l.journal_entry_id JOIN chart_of_accounts c ON c.id=l.account_id
     WHERE j.status='posted'
  `).first();

  return { ok: true, dry_run: false, log, balances_after: bal, intuit_total: intuitTotal, intuit_count: (intuit || []).length };
}
