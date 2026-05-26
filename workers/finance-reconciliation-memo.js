// workers/finance-reconciliation-memo.js
// Finance v2 — 2025 Reconciliation memo generator for Irene (Wave 0 spec section 0.2 + 0.5).
//
// Given the data already in D1 (QBO archive, Mercury transactions, Toast data,
// chart of accounts), this module:
//   1. Collects per-section reconciliation data (Revenue / COGS / Payroll / Fixed Assets / Loans & Equity / Suspect Items)
//   2. Sends structured data to Claude Sonnet to draft professional memo prose per section
//   3. Renders a printable HTML memo with all sections + raw data appendix
//   4. Returns the HTML + JSON so Drew can review, forward to Irene, or pipe to PDF later
//
// Endpoint: POST /finance/reconciliation/2025
// Options via query params:
//   ?format=html (default) | json           — response shape
//   ?ai=1                                   — invoke Claude for prose (default off — pure data otherwise)
//
// Design note: R2 upload is NOT required. We return HTML inline so the output
// is immediately downloadable even before the R2 binding is wired (blocker B-8).

// DIF-3: model id now resolved via ai-budget.js.

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── Section A: revenue reconciliation ─────────────────────────────────────
async function sectionRevenue(env, year) {
  const yearStart = `${year}-01-01`;
  const yearEnd   = `${year}-12-31`;

  // QBO: Deposit (retail) + Invoice (wholesale) for calendar year
  const [qboDeposit, qboInvoice] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as n, ROUND(SUM(CAST(json_extract(raw_json,'$.TotalAmt') AS REAL)),2) as total
       FROM qbo_archive_entity WHERE entity_type='Deposit' AND txn_date LIKE ?`
    ).bind(year + '-%').first(),
    env.DB.prepare(
      `SELECT COUNT(*) as n, ROUND(SUM(CAST(json_extract(raw_json,'$.TotalAmt') AS REAL)),2) as total
       FROM qbo_archive_entity WHERE entity_type='Invoice' AND txn_date LIKE ?`
    ).bind(year + '-%').first(),
  ]);

  // Toast POS (via orders table)
  const toast = await env.DB.prepare(`
    SELECT source, COUNT(*) as n, ROUND(SUM(gross_revenue),2) as gross
    FROM orders
    WHERE source LIKE 'toast%'
      AND order_date >= ? AND order_date <= ? || 'T23:59:59Z'
    GROUP BY source
  `).bind(yearStart, yearEnd).all();

  // Square POS (mostly post-migration = 2026)
  const square = await env.DB.prepare(`
    SELECT source, COUNT(*) as n, ROUND(SUM(gross_revenue),2) as gross
    FROM orders
    WHERE source LIKE 'square%'
      AND order_date >= ? AND order_date <= ? || 'T23:59:59Z'
    GROUP BY source
  `).bind(yearStart, yearEnd).all();

  // Mercury inflow (bank-side cross-check)
  const mercury = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 2) as inflow
    FROM mercury_transactions WHERE txn_date LIKE ?
  `).bind(year + '-%').first();

  const qboRetail = round2(qboDeposit?.total || 0);
  const qboWholesale = round2(qboInvoice?.total || 0);
  const qboTotal = round2(qboRetail + qboWholesale);

  return {
    title: 'A. Revenue reconciliation',
    qbo: {
      deposits: { count: qboDeposit?.n || 0, total: qboRetail, note: 'Retail aggregations (Toast daily deposits)' },
      invoices: { count: qboInvoice?.n || 0, total: qboWholesale, note: 'Wholesale B2B invoices' },
      total: qboTotal,
    },
    toast_pos: toast.results || [],
    square_pos: square.results || [],
    mercury_inflow: { count: mercury?.n || 0, total: round2(mercury?.inflow || 0), note: 'Bank-side deposits (includes non-revenue transfers)' },
    variance_check: {
      qbo_total: qboTotal,
      mercury_inflow: round2(mercury?.inflow || 0),
      delta: round2((mercury?.inflow || 0) - qboTotal),
      note: 'Mercury inflow usually exceeds QBO revenue because it includes refunds reversed, transfers, non-revenue deposits.',
    },
    recommended_for_irene: qboTotal,
    notes: [
      'QBO splits revenue across two entities: Deposit (retail) and Invoice (wholesale). Neither alone represents total revenue.',
      'Toast numbers from Pretzel OS orders table may over-count due to toast / toast_tsv / toast_live source overlap — Irene should use QBO or Toast native export as canonical.',
    ],
  };
}

// ── Section B: COGS reconciliation ────────────────────────────────────────
async function sectionCOGS(env, year) {
  // QBO Purchase entities (expenses + COGS all flow through Purchase in Pretzel's setup)
  const qboPurchase = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(CAST(json_extract(raw_json,'$.TotalAmt') AS REAL)),2) as total
    FROM qbo_archive_entity WHERE entity_type='Purchase' AND txn_date LIKE ?
  `).bind(year + '-%').first();

  // Purchases by vendor (top 20 for analysis)
  const { results: byVendor } = await env.DB.prepare(`
    SELECT
      json_extract(raw_json,'$.EntityRef.name') as vendor,
      COUNT(*) as n,
      ROUND(SUM(CAST(json_extract(raw_json,'$.TotalAmt') AS REAL)), 2) as total
    FROM qbo_archive_entity
    WHERE entity_type='Purchase' AND txn_date LIKE ?
    GROUP BY vendor
    ORDER BY total DESC
    LIMIT 20
  `).bind(year + '-%').all();

  // Mercury outflow (bank-side cross-check)
  const mercury = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 2) as outflow
    FROM mercury_transactions WHERE txn_date LIKE ?
  `).bind(year + '-%').first();

  return {
    title: 'B. COGS + expenses reconciliation',
    qbo: { count: qboPurchase?.n || 0, total: round2(qboPurchase?.total || 0) },
    top_20_vendors: byVendor || [],
    mercury_outflow: { count: mercury?.n || 0, total: round2(mercury?.outflow || 0) },
    variance: round2((mercury?.outflow || 0) - (qboPurchase?.total || 0)),
    notes: [
      'Pretzel OS QBO uses Purchase entity for all expenses (not Bill). Deposit-plus-Purchase captures ~95% of cash activity.',
      'Mercury outflow exceeds QBO Purchase when there are JE-only adjustments (e.g. payroll runs, transfers).',
    ],
  };
}

// ── Section C: payroll reconciliation ─────────────────────────────────────
async function sectionPayroll(env, year) {
  // QBO Employee records are empty for Dangerous Pretzel (Square Payroll handles payroll).
  const qboEmployee = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM qbo_archive_entity WHERE entity_type='Employee'`
  ).first();

  // Mercury withdrawals tagged as Toast Payroll / Square Payroll / payroll-related
  const { results: payrollByVendor } = await env.DB.prepare(`
    SELECT counterparty_name as vendor, COUNT(*) as n, ROUND(SUM(-amount), 2) as total
    FROM mercury_transactions
    WHERE amount < 0
      AND (LOWER(counterparty_name) LIKE '%payroll%'
        OR LOWER(counterparty_name) LIKE '%toast%'
        OR LOWER(counterparty_name) LIKE '%square%'
        OR LOWER(description) LIKE '%payroll%')
      AND txn_date LIKE ?
    GROUP BY vendor
    ORDER BY total DESC
    LIMIT 10
  `).bind(year + '-%').all();

  // Payroll Payable liability account activity
  const payablePurchase = await env.DB.prepare(`
    SELECT ROUND(SUM(CAST(json_extract(raw_json,'$.TotalAmt') AS REAL)), 2) as total, COUNT(*) as n
    FROM qbo_archive_entity
    WHERE entity_type='Purchase'
      AND txn_date LIKE ?
      AND json_extract(raw_json,'$.EntityRef.name') LIKE '%Toast Payroll%'
  `).bind(year + '-%').first();

  return {
    title: 'C. Payroll reconciliation',
    qbo_employee_records: qboEmployee?.n || 0,
    payroll_via_mercury: payrollByVendor || [],
    toast_payroll_purchases: { count: payablePurchase?.n || 0, total: round2(payablePurchase?.total || 0) },
    notes: [
      'QBO Employee entity is empty: Pretzel runs payroll through Toast Payroll (2025) and Square Payroll (post-migration).',
      'Full-year payroll detail must come from Toast Payroll export + Square Payroll export — Pretzel OS does not have live access to either.',
      `Payroll Payable on QBO balance sheet was $46,869 per Drew — separate account audit endpoint (/finance/audit/account?account=Payroll Payable) shows a net imbalance of ~$4,255 by 2025-12-28, suggesting the spec's number was from an earlier snapshot.`,
    ],
  };
}

// ── Section D: fixed asset adjustments ────────────────────────────────────
async function sectionFixedAssets(env, year) {
  // Fixed assets currently seeded? (Wave 2 work — may be empty)
  const seeded = await env.DB.prepare(
    `SELECT COUNT(*) as n, ROUND(SUM(acquisition_cost), 2) as total FROM fixed_assets`
  ).first();

  // Scan Mercury for 2025 capex candidates (>$2,500 de minimis threshold per Irene's 2024 election)
  const { results: capexCandidates } = await env.DB.prepare(`
    SELECT txn_date, -amount as amount, counterparty_name, description
    FROM mercury_transactions
    WHERE amount < -2500
      AND txn_date LIKE ?
    ORDER BY amount ASC
    LIMIT 50
  `).bind(year + '-%').all();

  return {
    title: 'D. Fixed asset adjustments',
    fixed_assets_seeded: { count: seeded?.n || 0, total: round2(seeded?.total || 0) },
    capex_candidates_over_2500_from_mercury: capexCandidates || [],
    per_2024_form_4562: {
      leasehold_improvements: { basis: 438100, method: '15yr SL', annual_depreciation: 29207 },
      restaurant_equipment:   { basis: 177409, method: '5yr 200DB', year_1: 35482, year_2: 34082 },
      furniture:              { basis: 2744, method: '7yr', year_1: 157 },
      signage:                { basis: 8970, method: '7yr', year_1: 513 },
      startup_costs:          { basis: 70900, method: '180mo amortization', monthly: 394 },
    },
    notes: [
      'Pretzel OS `fixed_assets` table is empty — awaiting Drew + Irene seed with the authoritative 2024 Form 4562 basis + 2025 additions.',
      'Candidate 2025 capex from Mercury is >$2,500 per Irene\'s de minimis election. Each row is a potential capitalization — needs Drew review to distinguish capex vs supplies vs repairs.',
      'Branding $44,375 (intangible, Section 197) also needs amortization schedule: $246/mo over 15 years.',
    ],
  };
}

// ── Section E: loan & equity adjustments ──────────────────────────────────
async function sectionLoansEquity(env, year) {
  // Loans currently seeded
  const seededLoans = await env.DB.prepare(
    `SELECT loan_name, lender, original_principal, current_balance FROM loans ORDER BY original_principal DESC`
  ).all();

  // LEAF payment detection in Mercury
  const { results: leafPayments } = await env.DB.prepare(`
    SELECT txn_date, counterparty_name, -amount as amount
    FROM mercury_transactions
    WHERE LOWER(counterparty_name) LIKE '%leaf%'
      AND amount < 0
      AND txn_date LIKE ?
    ORDER BY txn_date
  `).bind(year + '-%').all();

  // Drew/Lindsay equity contributions in Mercury
  const { results: ownerContributions } = await env.DB.prepare(`
    SELECT txn_date, counterparty_name, amount, description
    FROM mercury_transactions
    WHERE (LOWER(counterparty_name) LIKE '%drew%' OR LOWER(counterparty_name) LIKE '%lindsay%' OR LOWER(counterparty_name) LIKE '%sparks%')
      AND amount > 0
      AND txn_date LIKE ?
    ORDER BY txn_date
  `).bind(year + '-%').all();

  return {
    title: 'E. Loan & equity adjustments',
    loans_in_db: seededLoans.results || [],
    leaf_loan_payments_from_mercury: leafPayments || [],
    owner_contributions_from_mercury: ownerContributions || [],
    per_2024_tax_return: {
      drew_lindsay_note: { amount: 770975, treatment_per_2024_tax: 'Capital Contribution (equity)', treatment_on_books: 'Note Payable (debt)', recommendation: 'Continue equity treatment — reclassify on books at opening balance' },
      todd_amanda_note:  { amount: 80000, treatment: 'Paid off, walked away — zero out on books' },
      leaf_balances_qbo_snapshot: {
        pizza_ovens: 47303,
        comm_kitchen: 20296,
        comm_kitchen_supply: 17330,
        kemper_bakery: 20026,
        total: 104957,
      },
    },
    notes: [
      'Drew/Lindsay $770,975 loan on QBO books. 2024 tax treated it as equity. Recommend Irene continue equity treatment for 2025 (matches Drew\'s confirmed position).',
      'Todd & Amanda exited — need one-time JE to zero out their $80k N/P plus their equity balance.',
      'LEAF loan interest/principal split for 2025 requires loan amortization schedules (not yet in D1 — Drew uploads LEAF agreements).',
    ],
  };
}

// ── Section F: suspect items ──────────────────────────────────────────────
async function sectionSuspectItems(env, year) {
  // These are the items Drew flagged per PRETZEL_OS_FINANCE_V2.md section "Current state findings"
  const SUSPECT_ACCOUNTS = [
    { name: 'Payroll Payable',         snapshot: 46869, note: 'Bookkeeper accruing wages — check audit endpoint for pattern' },
    { name: 'Ask My Accountant',       snapshot: 4698,  note: 'Uncategorized txns parked by bookkeeper' },
    { name: 'Sales Tax Payable',       snapshot: 17808, note: 'Q1 2026 portion ($7,841.32) NOW FILED Apr 22. Remainder likely Q4 2025.' },
    { name: 'Cash Clearing',           snapshot: 10528, note: 'Reconciliation — investigate aging' },
    { name: 'Credit Card Clearing',    snapshot: 38690, note: 'Largest clearing — primary forensic target' },
    { name: 'DoorDash Clearing',       snapshot: 13574, note: 'DoorDash deposits not swept to cash' },
    { name: 'Grubhub Clearing',        snapshot: 646,   note: 'Small — candidate for write-off' },
    { name: 'UberEats Clearing',       snapshot: 3684,  note: 'UberEats deposits not swept' },
  ];
  const total_qbo_snapshot = SUSPECT_ACCOUNTS.reduce((s, a) => s + a.snapshot, 0);

  // QBO live-check: what do current books actually show via chart_of_accounts?
  const coaRows = await Promise.all(SUSPECT_ACCOUNTS.map(async (a) => {
    const row = await env.DB.prepare(
      `SELECT id, account_name, account_type FROM chart_of_accounts WHERE LOWER(account_name) LIKE ?`
    ).bind('%' + a.name.toLowerCase() + '%').first();
    return { ...a, found_in_coa: !!row, coa_id: row?.id || null };
  }));

  return {
    title: 'F. Suspect items requiring Irene\'s professional judgment',
    accounts: coaRows,
    total_qbo_snapshot,
    q1_2026_sales_tax_filed: {
      date: '2026-04-22',
      spf_amount: 656.60,
      tc62_amount: 7184.72,
      total: 7841.32,
      q4_2025_estimate: round2(17808 - 7841.32),
    },
    recommended_actions: [
      'Run POST /finance/audit/account?account=<each suspect account>&ai=1 for Claude-powered pattern analysis',
      'Payroll Payable: net imbalance $4,255 by end of 2025 (much less than $46k QBO snapshot) — Toast Payroll mostly paid out by EOY',
      'Sales Tax Payable: Q1 2026 filed; Q4 2025 remainder (~$10k) — Irene to file Q4 2025 late if not already done',
      'Clearing accounts: age each balance, write off stale items to Other Income with Irene sign-off',
      'Ask My Accountant: per-transaction review — Utah State Tax Commission + Amazon purchases noted',
    ],
  };
}

// ── Claude memo prose (optional) ──────────────────────────────────────────
async function generateMemoProse(env, sections) {
  if (!env.ANTHROPIC_API_KEY) return { enabled: false, reason: 'ANTHROPIC_API_KEY not set' };
  const prompt = `You are a senior CPA preparing a professional tax reconciliation memo for Irene Bodenstab (IB Tax & Accounting PLLC) who is preparing the 2025 tax return for Dangerous Pretzel Company LLC.

Draft a cover letter + brief per-section narrative (2-3 sentences each) that summarizes what Irene should know. Keep it crisp — she is a busy professional and wants signal, not fluff.

The full data payload (JSON) is below. Do NOT repeat numbers she can read in the data — just call out what's important, what's surprising, and what requires her professional judgment.

${JSON.stringify(sections, null, 2).slice(0, 40000)}

Return STRICT JSON with this shape:
{
  "cover_paragraph": "<2-3 sentence opener>",
  "sections": {
    "A": "<2-3 sentence narrative for revenue>",
    "B": "<2-3 sentence narrative for COGS>",
    "C": "<2-3 sentence narrative for payroll>",
    "D": "<2-3 sentence narrative for fixed assets>",
    "E": "<2-3 sentence narrative for loans & equity>",
    "F": "<2-3 sentence narrative for suspect items>"
  },
  "top_3_items_needing_irene_judgment": [
    "<most important>",
    "<second>",
    "<third>"
  ]
}`;
  // DIF-3 (May 13 2026): wired through ai-budget
  const { callAI } = await import('./ai-budget.js');
  const result = await callAI(env, {
    use_case: 'reconciliation_memo_narrative',
    model: 'sonnet',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
    caller: 'finance-reconciliation-memo.js',
  });
  if (!result.ok) {
    return { enabled: false, reason: result.blocked_reason || result.error || 'Anthropic call failed' };
  }
  const text = result.content || '';
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return { enabled: true, prose: JSON.parse(stripped) };
  } catch {
    return { enabled: false, reason: 'could not parse Claude JSON', raw: text };
  }
}

// ── HTML renderer ─────────────────────────────────────────────────────────
function renderHtml(year, sections, prose) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Humanize a snake_case key for display ("top_20_vendors" → "Top 20 Vendors")
  const label = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  // Format a cell value. Money fields get money formatting; counts stay as plain integers.
  const isMoneyKey = (k) => /total|amount|balance|gross|net|inflow|outflow|debit|credit|revenue|cost|value|principal/i.test(k);
  const fmtCell = (k, v) => {
    if (typeof v === 'number') return isMoneyKey(k) ? fmtMoney(v) : v.toLocaleString();
    return esc(v);
  };

  // Render a flat key/value table.
  const kvTable = (obj, opts = {}) => {
    const rows = Object.entries(obj).map(([k, v]) =>
      `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#555;width:40%">${esc(label(k))}</td>` +
      `<td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-family:'Menlo',monospace">${fmtCell(k, v)}</td></tr>`
    ).join('');
    return `<table style="width:${opts.width || '100%'};border-collapse:collapse;font-size:13px;margin:8px 0 16px">${rows}</table>`;
  };

  // Render an array of objects as a table, autodetecting columns from the first row.
  const arrayTable = (arr, opts = {}) => {
    if (!arr.length) return '<p style="color:#888;font-size:12px;margin:8px 0">(empty)</p>';
    const cols = Object.keys(arr[0]);
    const head = `<tr>${cols.map(c => `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #333;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#666">${esc(label(c))}</th>`).join('')}</tr>`;
    const rows = arr.map(r =>
      `<tr>${cols.map(c => {
        const v = r[c];
        const align = typeof v === 'number' ? 'right' : 'left';
        const font = typeof v === 'number' ? "font-family:'Menlo',monospace" : '';
        return `<td style="padding:5px 10px;border-bottom:1px solid #eee;font-size:12px;text-align:${align};${font}">${fmtCell(c, v)}</td>`;
      }).join('')}</tr>`
    ).join('');
    return `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">${head}${rows}</table>`;
  };

  // Render one section with automatic handling of nested objects + arrays.
  const sectionHtml = (s, narrative) => {
    let html = `<h2 style="border-bottom:2px solid #333;padding-bottom:6px;margin-top:32px">${esc(s.title)}</h2>`;
    if (narrative) html += `<p style="color:#333;font-style:italic;margin:12px 0;padding:10px 14px;background:#f5f5f5;border-left:3px solid #666">${esc(narrative)}</p>`;

    for (const [k, v] of Object.entries(s)) {
      if (k === 'title' || k === 'notes' || k === 'recommended_actions') continue;
      if (v == null) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        html += `<div style="margin:6px 0"><b style="color:#333">${esc(label(k))}:</b> <span style="font-family:'Menlo',monospace">${fmtCell(k, v)}</span></div>`;
      } else if (Array.isArray(v)) {
        html += `<h4 style="margin:16px 0 4px 0;color:#444;font-weight:600">${esc(label(k))}</h4>`;
        html += arrayTable(v);
      } else if (typeof v === 'object') {
        html += `<h4 style="margin:16px 0 4px 0;color:#444;font-weight:600">${esc(label(k))}</h4>`;
        // Nested object: render as kv table (one layer deep is enough)
        const flattened = {};
        for (const [nk, nv] of Object.entries(v)) {
          if (nv !== null && typeof nv === 'object') {
            flattened[nk] = JSON.stringify(nv);
          } else {
            flattened[nk] = nv;
          }
        }
        html += kvTable(flattened);
      }
    }

    if (Array.isArray(s.notes)) {
      html += `<p style="margin:12px 0 4px 0;font-weight:600;color:#555">Notes:</p><ul style="margin:0 0 0 20px;padding:0;color:#555;font-size:13px">${s.notes.map(n => `<li style="margin:4px 0">${esc(n)}</li>`).join('')}</ul>`;
    }
    if (Array.isArray(s.recommended_actions)) {
      html += `<p style="margin:16px 0 4px 0;font-weight:600;color:#b45309">Recommended actions:</p><ol style="margin:0 0 0 20px;padding:0;color:#333;font-size:13px">${s.recommended_actions.map(n => `<li style="margin:4px 0">${esc(n)}</li>`).join('')}</ol>`;
    }
    return html;
  };

  const coverPara = prose?.prose?.cover_paragraph || `Reconciliation data package for 2025 tax year for Dangerous Pretzel Company LLC. All figures derived from QBO 2025 archive, Mercury transaction history, Toast/Square POS data, and the 2024 Form 4562 baseline.`;
  const top3 = prose?.prose?.top_3_items_needing_irene_judgment || [];

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Dangerous Pretzel ${year} Reconciliation Memo — for Irene Bodenstab</title>
</head>
<body style="font-family:Georgia,serif;max-width:900px;margin:40px auto;padding:0 20px;color:#222;line-height:1.6">
  <header style="border-bottom:3px double #333;padding-bottom:20px;margin-bottom:20px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#888">Reconciliation Memorandum</p>
    <h1 style="margin:8px 0 4px 0;font-size:26px">Dangerous Pretzel Company LLC — Tax Year ${year}</h1>
    <p style="margin:0;color:#555;font-size:14px">Prepared for Irene Bodenstab, IB Tax &amp; Accounting PLLC</p>
    <p style="margin:4px 0 0 0;color:#888;font-size:12px">Generated ${new Date().toISOString().slice(0, 10)} by Pretzel OS Finance v2</p>
  </header>

  <p>${esc(coverPara)}</p>

  ${top3.length ? `
  <div style="background:#fff9e6;border-left:4px solid #f59e0b;padding:12px 16px;margin:20px 0">
    <p style="margin:0 0 8px 0;font-weight:bold">Top items needing your professional judgment:</p>
    <ol style="margin:0 0 0 20px;padding:0">${top3.map(t => `<li style="margin:4px 0">${esc(t)}</li>`).join('')}</ol>
  </div>` : ''}

  ${sectionHtml(sections.A, prose?.prose?.sections?.A)}
  ${sectionHtml(sections.B, prose?.prose?.sections?.B)}
  ${sectionHtml(sections.C, prose?.prose?.sections?.C)}
  ${sectionHtml(sections.D, prose?.prose?.sections?.D)}
  ${sectionHtml(sections.E, prose?.prose?.sections?.E)}
  ${sectionHtml(sections.F, prose?.prose?.sections?.F)}

  <hr style="margin:40px 0 20px 0;border:none;border-top:1px solid #ccc">
  <p style="color:#888;font-size:11px">Raw data payloads for each section are available as JSON via <code>GET /finance/reconciliation/${year}?format=json</code>. Individual account forensics: <code>POST /finance/audit/account?account=&lt;name&gt;&amp;ai=1</code>. Contact Drew with questions.</p>
</body>
</html>`;
}

// ── Main generator ────────────────────────────────────────────────────────
export async function generateReconciliationMemo(env, year, opts = {}) {
  const [A, B, C, D, E, F] = await Promise.all([
    sectionRevenue(env, year),
    sectionCOGS(env, year),
    sectionPayroll(env, year),
    sectionFixedAssets(env, year),
    sectionLoansEquity(env, year),
    sectionSuspectItems(env, year),
  ]);
  const sections = { A, B, C, D, E, F };

  let prose = { enabled: false };
  if (opts.ai) prose = await generateMemoProse(env, sections);

  const html = renderHtml(year, sections, prose);

  // Store in cfo_briefs for audit (migration 034) — content blob + html appendix.
  try {
    await env.DB.prepare(`
      INSERT INTO cfo_briefs (id, brief_date, type, content, created_at)
      VALUES (?, date('now'), ?, ?, datetime('now'))
      ON CONFLICT(brief_date, type) DO UPDATE SET content = excluded.content
    `).bind(
      crypto.randomUUID(),
      `reconciliation_${year}`,
      JSON.stringify({ sections, prose, generated_at: new Date().toISOString() }).slice(0, 1000000)
    ).run();
  } catch (e) {
    // Non-fatal; memo still returns even if the log fails.
    console.error('[memo] log failed:', e.message);
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'reconciliation_memo_generated', 'cfo_briefs', ?, 'system', ?, ?)
  `).bind(
    crypto.randomUUID(), `reconciliation_${year}`,
    `Reconciliation memo generated for tax year ${year}${opts.ai ? ' (with AI prose)' : ''}`,
    JSON.stringify({ year, ai: opts.ai, sections: Object.keys(sections) })
  ).run();

  return { year, sections, prose, html };
}
