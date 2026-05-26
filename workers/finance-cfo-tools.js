// workers/finance-cfo-tools.js
// Finance v2 — CFO Agent v2 utilities: loans (3.8), 1099 (3.7), daily reconciliation (3.11), warmers (3.6).
//
// All of these are relatively small single-purpose helpers grouped here to
// keep the worker import graph shallow.

import { isReadOnly, readOnlySkip } from './finance-shared.js';

// DIF-3: model id now resolved via ai-budget.js.

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ══════════════════════════════════════════════════════════════════════════
// 3.8 — LOAN AMORTIZATION
// ══════════════════════════════════════════════════════════════════════════

// Drew uploads LEAF loan terms (either via PDF+Sonnet parse or manual entry).
// For each Mercury outflow matching LEAF patterns, split into principal vs interest
// using the loan's current amortization state and post to Loan Payable + Interest Expense.

function splitPayment(loan, paymentAmount) {
  const monthlyRate = (loan.interest_rate / 100) / 12;
  const interest  = round2(loan.current_balance * monthlyRate);
  const principal = round2(paymentAmount - interest);
  return { interest, principal };
}

// Seed a loan from manual input (or PDF parse result).
export async function createLoan(env, body) {
  const loan = {
    id: crypto.randomUUID(),
    loan_name: body.loan_name || body.name,
    lender: body.lender || 'LEAF Capital',
    origination_date: body.origination_date,
    original_principal: Number(body.original_principal || body.principal || 0),
    current_balance: Number(body.current_balance ?? body.original_principal ?? body.principal ?? 0),
    interest_rate: Number(body.interest_rate),
    term_months: parseInt(body.term_months, 10),
    monthly_payment: Number(body.monthly_payment),
    payment_day_of_month: body.payment_day_of_month ? parseInt(body.payment_day_of_month, 10) : null,
    next_payment_date: body.next_payment_date || null,
    status: 'active',
    collateral: body.collateral || null,
    notes: body.notes || null,
  };

  if (!loan.loan_name || !loan.original_principal || !loan.interest_rate || !loan.term_months || !loan.monthly_payment) {
    return { error: 'loan_name, original_principal, interest_rate, term_months, monthly_payment required' };
  }

  await env.DB.prepare(`
    INSERT INTO loans (id, loan_name, lender, origination_date, original_principal, current_balance,
      interest_rate, term_months, monthly_payment, payment_day_of_month, next_payment_date,
      status, collateral, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    loan.id, loan.loan_name, loan.lender, loan.origination_date,
    loan.original_principal, loan.current_balance, loan.interest_rate,
    loan.term_months, loan.monthly_payment,
    loan.payment_day_of_month, loan.next_payment_date,
    loan.status, loan.collateral, loan.notes
  ).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'loan_created', 'loans', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), loan.id,
    `Loan created: ${loan.loan_name} — $${loan.original_principal} at ${loan.interest_rate}% over ${loan.term_months}mo`,
    JSON.stringify(loan)
  ).run();

  return { ok: true, loan };
}

// Find LEAF outflow payments, split them, and post the JEs.
// This REPLACES the single-line expense JE that the categorizer posted earlier.
export async function processLoanPayments(env, opts = {}) {
  if (await isReadOnly(env)) return readOnlySkip({ operation: 'loan_payment_processing' });
  const { results: loans } = await env.DB.prepare(
    `SELECT * FROM loans WHERE status = 'active'`
  ).all();
  if (!(loans || []).length) return { ok: true, loans: 0, payments_posted: 0, note: 'no active loans — seed via POST /finance/cfo/loans first' };

  // Find Mercury txns to LEAF / LEASE SERVICES that haven't been split yet.
  const { results: payments } = await env.DB.prepare(`
    SELECT m.id, m.txn_date, m.amount, m.counterparty_name, m.matched_journal_entry_id
    FROM mercury_transactions m
    WHERE m.amount < 0
      AND (LOWER(m.counterparty_name) LIKE '%leaf%' OR LOWER(m.counterparty_name) LIKE '%lease%services%')
      AND NOT EXISTS (
        SELECT 1 FROM loan_payments lp WHERE lp.mercury_txn_id = m.id
      )
    ORDER BY m.txn_date
    LIMIT ?
  `).bind(opts.limit || 100).all();

  let posted = 0;
  const processed = [];
  const loanInterest = await env.DB.prepare(`SELECT id FROM chart_of_accounts WHERE LOWER(account_name) LIKE 'interest paid%' LIMIT 1`).first();
  const mercuryChecking = await env.DB.prepare(`SELECT id FROM chart_of_accounts WHERE account_name LIKE 'Mercury Checking%' LIMIT 1`).first();
  const loanPayable = await env.DB.prepare(`SELECT id FROM chart_of_accounts WHERE LOWER(account_name) LIKE '%loan%' AND account_type = 'liability' LIMIT 1`).first();

  for (const p of (payments || [])) {
    // For Pretzel there are 4 LEAF loans. Pick the one whose monthly_payment is closest to the abs value.
    const pmt = Math.abs(p.amount);
    let bestLoan = null, bestDiff = Infinity;
    for (const l of loans) {
      const diff = Math.abs((l.monthly_payment || 0) - pmt);
      if (diff < bestDiff) { bestDiff = diff; bestLoan = l; }
    }
    if (!bestLoan) continue;

    const split = splitPayment(bestLoan, pmt);
    const remaining = round2(bestLoan.current_balance - split.principal);

    // Reverse the original expense JE if it exists
    if (p.matched_journal_entry_id) {
      await env.DB.prepare(
        `UPDATE journal_entries SET status='reversed' WHERE id = ?`
      ).bind(p.matched_journal_entry_id).run().catch(() => {});
    }

    // Post new JE: Dr Loan Payable (principal) + Dr Interest Paid (interest), Cr Mercury
    const entryId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_type, source_id,
        total_debit, total_credit, status, created_by, notes)
      VALUES (?, ?, ?, 'loan_payment', ?, ?, ?, 'posted', 'cfo_agent', ?)
    `).bind(
      entryId, p.txn_date.slice(0, 10),
      `Loan payment split: ${bestLoan.loan_name}`,
      p.id, pmt, pmt,
      `Auto-split into P=$${split.principal}, I=$${split.interest}`
    ).run();

    if (loanPayable?.id) {
      await env.DB.prepare(`INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES (?, ?, 1, ?, ?, 0, ?)`).bind(
        crypto.randomUUID(), entryId, loanPayable.id, split.principal, `Principal on ${bestLoan.loan_name}`
      ).run();
    }
    if (loanInterest?.id) {
      await env.DB.prepare(`INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES (?, ?, 2, ?, ?, 0, ?)`).bind(
        crypto.randomUUID(), entryId, loanInterest.id, split.interest, `Interest on ${bestLoan.loan_name}`
      ).run();
    }
    if (mercuryChecking?.id) {
      await env.DB.prepare(`INSERT INTO journal_entry_lines (id, journal_entry_id, line_number, account_id, debit, credit, memo) VALUES (?, ?, 3, ?, 0, ?, ?)`).bind(
        crypto.randomUUID(), entryId, mercuryChecking.id, pmt, `Paid from Mercury`
      ).run();
    }

    // Record loan_payment
    await env.DB.prepare(`
      INSERT INTO loan_payments (id, loan_id, payment_date, total_amount, principal_portion, interest_portion, remaining_balance, mercury_txn_id, journal_entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), bestLoan.id, p.txn_date.slice(0, 10),
      pmt, split.principal, split.interest, remaining, p.id, entryId
    ).run();

    // Update loan current_balance
    await env.DB.prepare(`
      UPDATE loans SET current_balance = ? WHERE id = ?
    `).bind(remaining, bestLoan.id).run();

    processed.push({ loan: bestLoan.loan_name, amount: pmt, principal: split.principal, interest: split.interest, remaining });
    posted++;
  }

  return { ok: true, loans: loans.length, payments_posted: posted, detail: processed };
}

// ══════════════════════════════════════════════════════════════════════════
// 3.7 — 1099 VENDOR TRACKING
// ══════════════════════════════════════════════════════════════════════════

// Find all vendors paid >$600 in the tax year. Returns draft 1099 list.
export async function find1099Candidates(env, year) {
  // Use Mercury transactions to identify counterparties + totals for the year.
  // Exclude corporations (banks, big software) by filtering out known LLC/Corp-only names.
  const CORPORATE_EXCLUDE = [
    /mercury|chase|wells\s*fargo|bank\s*of/i,
    /toast\s*pay|square\s*pay|square\s*inc/i,
    /amazon|apple|google|microsoft|adobe|dropbox/i,
    /sysco|us\s*foods|shamrock|pfg|performance\s*food/i,
    /utah.*tax|internal\s*revenue/i,
    /allstate|geico|progressive|state\s*farm/i,
    /lease\s*services|^leaf\b/i,
  ];

  const { results: vendorTotals } = await env.DB.prepare(`
    SELECT counterparty_name, COUNT(*) as n, ROUND(SUM(-amount), 2) as total
    FROM mercury_transactions
    WHERE amount < 0
      AND counterparty_name IS NOT NULL AND counterparty_name != ''
      AND txn_date LIKE ?
    GROUP BY counterparty_name
    HAVING total > 600
    ORDER BY total DESC
  `).bind(`${year}-%`).all();

  const candidates = [];
  const auto_excluded = [];
  for (const v of (vendorTotals || [])) {
    if (CORPORATE_EXCLUDE.some(p => p.test(v.counterparty_name))) {
      auto_excluded.push(v);
    } else {
      // Look up any existing vendor record
      const vendorRec = await env.DB.prepare(
        `SELECT id, is_1099_vendor, w9_on_file FROM vendors WHERE LOWER(name) = LOWER(?) LIMIT 1`
      ).bind(v.counterparty_name).first();
      candidates.push({
        counterparty: v.counterparty_name,
        payments: v.n,
        total_paid: v.total,
        existing_vendor_id: vendorRec?.id || null,
        is_1099_vendor: vendorRec?.is_1099_vendor || 0,
        w9_on_file: vendorRec?.w9_on_file || 0,
      });
    }
  }

  return {
    tax_year: year,
    candidates_count: candidates.length,
    total_1099_amount: candidates.reduce((s, c) => s + c.total_paid, 0),
    candidates,
    auto_excluded_count: auto_excluded.length,
    auto_excluded_sample: auto_excluded.slice(0, 10),
    irs_note: 'Per IRS rules, issue 1099-NEC to any non-corporate vendor paid >$600 for services. Review each candidate and confirm W-9 is on file before filing.',
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 3.11 — DAILY RECONCILIATION + READ-ONLY ESCAPE HATCH
// ══════════════════════════════════════════════════════════════════════════

// Compare Mercury live balance vs sum of JE movements on Mercury accounts.
// If variance > $1 for 2 consecutive days, flip FINANCE_READ_ONLY in KV.
export async function runDailyReconciliation(env) {
  // Per-account live balance from Mercury
  const { results: accounts } = await env.DB.prepare(
    `SELECT account_name, current_balance FROM mercury_accounts WHERE is_active = 1`
  ).all();

  const results = [];
  let maxVariance = 0;

  for (const a of (accounts || [])) {
    // Find the matching COA id
    const coa = await env.DB.prepare(
      `SELECT id FROM chart_of_accounts WHERE LOWER(account_name) LIKE ? LIMIT 1`
    ).bind(a.account_name.toLowerCase().replace(/••/g, '').replace(/\s+/g, '%')).first();

    let bookBalance = null;
    if (coa?.id) {
      const row = await env.DB.prepare(`
        SELECT ROUND(SUM(debit - credit), 2) as balance
        FROM journal_entry_lines l
        JOIN journal_entries j ON j.id = l.journal_entry_id
        WHERE l.account_id = ? AND j.status = 'posted'
      `).bind(coa.id).first();
      bookBalance = row?.balance || 0;
    }

    const variance = round2((a.current_balance || 0) - (bookBalance || 0));
    if (Math.abs(variance) > maxVariance) maxVariance = Math.abs(variance);
    results.push({
      account: a.account_name,
      live_balance: round2(a.current_balance || 0),
      book_balance: round2(bookBalance || 0),
      variance,
    });
  }

  // Read-only trip logic
  const lastRecon = await env.KV.get('finance_last_recon_variance').catch(() => null);
  const twoDaysBig = maxVariance > 50 && lastRecon && parseFloat(lastRecon) > 50;
  if (twoDaysBig) {
    await env.KV.put('FINANCE_READ_ONLY', '1').catch(() => {});
  }
  await env.KV.put('finance_last_recon_variance', String(maxVariance)).catch(() => {});

  const payload = {
    date: new Date().toISOString().slice(0, 10),
    accounts: results,
    max_variance: round2(maxVariance),
    read_only_mode_active: twoDaysBig,
    note: 'Variance >$1 = investigate; >$50 for 2 consecutive days flips FINANCE_READ_ONLY in KV.',
  };

  await env.DB.prepare(`
    INSERT INTO cfo_briefs (id, brief_date, type, content)
    VALUES (?, date('now'), 'daily_recon', ?)
    ON CONFLICT(brief_date, type) DO UPDATE SET content = excluded.content
  `).bind(crypto.randomUUID(), JSON.stringify(payload)).run().catch(() => {});

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'daily_reconciliation', 'mercury_accounts', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), payload.date,
    `Daily recon ${payload.date}: max variance $${payload.max_variance}${twoDaysBig ? ' — FINANCE_READ_ONLY flipped' : ''}`,
    JSON.stringify(payload)
  ).run().catch(() => {});

  return payload;
}

export async function getReadOnlyMode(env) {
  const v = await env.KV.get('FINANCE_READ_ONLY').catch(() => null);
  return { read_only: v === '1', value: v };
}

export async function setReadOnlyMode(env, active, reason) {
  if (active) {
    await env.KV.put('FINANCE_READ_ONLY', '1');
  } else {
    await env.KV.delete('FINANCE_READ_ONLY');
  }
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
    VALUES (?, ?, 'system', 'FINANCE_READ_ONLY', 'drew', ?)
  `).bind(
    crypto.randomUUID(),
    active ? 'read_only_enabled' : 'read_only_disabled',
    reason || (active ? 'Enabled by Drew' : 'Disabled by Drew')
  ).run().catch(() => {});
  return { ok: true, read_only: active };
}

// ══════════════════════════════════════════════════════════════════════════
// 3.6 — PRETZEL WARMER TRACKING
// ══════════════════════════════════════════════════════════════════════════

// Warmers are a special fixed_asset subclass. Each one is tracked with location + customer.
// Typical lifecycle: Purchased → Placed at venue (customer_id set) → Removed/replaced
// → Status='disposed' with disposal_date.

export async function createWarmer(env, body) {
  const warmer = {
    id: crypto.randomUUID(),
    asset_name: body.asset_name || body.name || `Warmer ${body.serial || crypto.randomUUID().slice(0, 8)}`,
    asset_class: 'warmer',
    acquisition_date: body.acquisition_date || new Date().toISOString().slice(0, 10),
    acquisition_cost: Number(body.acquisition_cost || 0),
    useful_life_years: parseInt(body.useful_life_years, 10) || 5,
    depreciation_method: body.depreciation_method || '200db',
    monthly_depreciation: 0,
    location: body.location || null,
    customer_id: body.customer_id || null,
    notes: body.notes || null,
    serial: body.serial,
    model: body.model,
  };
  warmer.monthly_depreciation = round2((warmer.acquisition_cost / (warmer.useful_life_years * 12)));

  if (!warmer.acquisition_cost) {
    return { error: 'acquisition_cost required' };
  }

  await env.DB.prepare(`
    INSERT INTO fixed_assets (id, asset_name, asset_class, acquisition_date, acquisition_cost,
      useful_life_years, depreciation_method, salvage_value, monthly_depreciation,
      accumulated_depreciation, net_book_value, status, location, customer_id, notes)
    VALUES (?, ?, 'warmer', ?, ?, ?, ?, 0, ?, 0, ?, 'active', ?, ?, ?)
  `).bind(
    warmer.id, warmer.asset_name, warmer.acquisition_date, warmer.acquisition_cost,
    warmer.useful_life_years, warmer.depreciation_method, warmer.monthly_depreciation,
    warmer.acquisition_cost, warmer.location, warmer.customer_id,
    `${warmer.serial ? `Serial: ${warmer.serial}. ` : ''}${warmer.model ? `Model: ${warmer.model}. ` : ''}${warmer.notes || ''}`.trim()
  ).run();

  // Seed depreciation schedule
  const start = new Date(warmer.acquisition_date + 'T00:00:00Z');
  for (let i = 0; i < warmer.useful_life_years * 12; i++) {
    const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i + 1);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO depreciation_schedules (id, asset_id, schedule_date, amount, status)
      VALUES (?, ?, ?, ?, 'scheduled')
    `).bind(crypto.randomUUID(), warmer.id, d.toISOString().slice(0, 7) + '-01', warmer.monthly_depreciation).run();
  }

  return { ok: true, warmer_id: warmer.id, monthly_depreciation: warmer.monthly_depreciation };
}

export async function placeWarmer(env, warmerId, body) {
  const customer_id = body.customer_id;
  const venue_name = body.venue_name || body.location;
  await env.DB.prepare(`
    UPDATE fixed_assets
    SET customer_id = ?, location = ?, updated_at = datetime('now')
    WHERE id = ? AND asset_class = 'warmer'
  `).bind(customer_id || null, venue_name || null, warmerId).run();
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'warmer_placed', 'fixed_assets', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), warmerId,
    `Warmer placed at ${venue_name || customer_id}`,
    JSON.stringify({ customer_id, venue_name })
  ).run();
  return { ok: true, warmer_id: warmerId, customer_id, venue_name };
}

export async function listWarmers(env) {
  const { results } = await env.DB.prepare(`
    SELECT a.id, a.asset_name, a.acquisition_date, a.acquisition_cost,
           a.accumulated_depreciation, a.net_book_value, a.status,
           a.location, a.customer_id, c.display_name as customer_name
    FROM fixed_assets a
    LEFT JOIN customers c ON c.id = a.customer_id
    WHERE a.asset_class = 'warmer'
    ORDER BY a.acquisition_date
  `).all();
  return { count: (results || []).length, warmers: results || [] };
}
