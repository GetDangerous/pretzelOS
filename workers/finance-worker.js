// workers/finance-worker.js
// Pretzel OS Finance v2 — Wave 0/1/2 endpoints.
import { syncAccountsToD1 as mercurySyncAccounts, syncTransactionsToD1 as mercurySyncTransactions, syncStatus as mercuryStatus } from './mercury-client.js';
import { extractChartOfAccounts, extract2025Archive } from './finance-qbo-extract.js';
import { extractSquareHistorical, squareExtractStatus } from './finance-square-extract.js';
import { auditAccount } from './finance-account-audit.js';
import { generateReconciliationMemo } from './finance-reconciliation-memo.js';
import { categorizeBatch, categorizeOneById, categorizationStats } from './finance-cfo-categorizer.js';
import { postJeBatch, postJeOne, reverseJe, postedStats } from './finance-je-poster.js';
import { capexCandidates, capitalize, rejectCapex } from './finance-capex-flagger.js';
import { rebuildForecast, getForecast } from './finance-cashflow.js';
import { getCanonicalForecast } from './finance-forecast.js';
import { getPageNarrative, generatePageNarrative, getPageMode } from './finance-page-narrative.js';
import { runMonthlyClose, getMonthlyClose, recomputeMonthlyClose, checkCloseGate } from './finance-monthly-close.js';
import { listLateTxns, getLateTxn, applyLateTxnDecision } from './finance-late-txns.js';
import { getRtrCutoverStatus, setRtrCutoverDate, backfillSalesRecognition, postSalesRecognitionJe } from './finance-pos-direct.js';
import { runWeeklyDirective, getWeeklyDirective } from './finance-weekly-directive.js';
import { createLoan, processLoanPayments, find1099Candidates, runDailyReconciliation, getReadOnlyMode, setReadOnlyMode, createWarmer, placeWarmer, listWarmers } from './finance-cfo-tools.js';
import { previewSweep, runRevenueSweep, rewindRevenueSweeps, runRevenueSweepByMonth } from './finance-revenue-sweep.js';
import { previewOpeningBalance, commitOpeningBalance } from './finance-opening-balance.js';
import { sendDailyCloseEmail, sendWeeklyDirectiveEmail } from './finance-email-briefs.js';
import { proposeRecurringBills, listRecurringBills, activateRecurringBill, dismissRecurringBill } from './finance-recurring-bills.js';
import { getReviewQueue, getCoaSimple, approveTxn, overrideTxn, rejectTxn, unrejectTxn, getReviewQueueByCounterparty, bulkApproveCounterparty, bulkRejectCounterparty } from './finance-review-queue.js';
import { runTier1, runTier2, runTier5Acceptance, runTier5Year, runInjectionTests, addAcceptanceReference, listAcceptanceReferences, seedReferencesFromQbo, getAuditHistory, getAuditLatest, getAuditDetail, getSystemHealth, runThreeWayTier5 } from './finance-audit-engine.js';
import { computeAndStoreMonthlyRevenue, backfillCanonicalRevenue, getCanonicalRevenue, listCanonicalRevenue, refreshRecentCanonicalRevenue } from './finance-revenue-canonical.js';
import { getCanonicalCashOnHand, getCanonicalWeeklyBurn, getCanonicalRunway, getCanonicalWeeklyRevenue, getCanonicalRecurringBurn } from './finance-shared.js';
import { getCanonicalTruthState, checkCrossConsumerAgreement } from './finance-canonical-truth.js';
import { checkContracts } from './finance-contracts.js';
import { getScorecard } from './finance-scorecard.js';
import { getMonthlyPL, getMonthlyPLQuad } from './finance-monthly-pl.js';
import { getArAging, getArCustomer, buildReminderDraft } from './finance-ar-aging.js';
import { sendDailyMorningBrief } from './finance-email-briefs.js';
import { previewMatch as qboMatchPreview, applyMatch as qboMatchApply } from './finance-qbo-mercury-match.js';
import { getBudgetStatus, getCostBreakdown } from './ai-budget.js';
import { getTrustScore, getTrustHistory, snapshotTrustScore, heartbeat } from './finance-health.js';
import { buildVendorKB, lookupVendor, listTopVendors } from './finance-vendor-kb.js';
import { recordFact, lookupFacts, listFacts, supersedeFact, deactivateFact } from './finance-cfo-facts.js';
import { createLinkToken as plaidLinkToken, exchangePublicToken as plaidExchange, syncItem as plaidSyncItem, syncAllItems as plaidSyncAll, handleWebhook as plaidHandleWebhook, getPlaidStatus, disconnectItem as plaidDisconnect } from './plaid-client.js';
import { getBreakeven } from './finance-breakeven.js';
import { getTrends, getTrend } from './finance-trends.js';
import { runScenario } from './finance-scenario.js';
import { getCustomerIntel, getCustomerProfile } from './finance-customer-intel.js';
import { scanIssues, listIssues, snoozeIssue, resolveIssue, dismissIssue } from './finance-issue-surfacer.js';
import { syncSquareLabor, getLaborForecast, getLaborProductivity } from './square-labor-sync.js';
import { reasonAboutCapex, listPendingCapexApprovals, approveCapexDecision, rejectCapexDecision } from './finance-capex-reasoner.js';
import { processReceipt, listPendingReceipts, approveReceipt, rejectReceipt } from './finance-receipts.js';
// Per PRETZEL_OS_FINANCE_V2.md section 1 (sales tax) + section 2.5 (schema).
//
// Endpoints owned by this worker:
//   POST /finance/sales-tax/quarter?year=YYYY&quarter=N      — calculate worksheet
//   GET  /finance/sales-tax/filings                           — list all filings
//   GET  /finance/sales-tax/filings/:period                   — detail one filing
//   POST /finance/sales-tax/filings/:period/filed            — mark as filed
//   POST /finance/sales-tax/manual-revenue                    — Toast/manual upload
//   POST /finance/sales-tax/schedule-year                     — seed Q1-Q4 schedule
//   POST /finance/resale-cert/request                         — email template for cert request
//
// Utah rate reference: Salt Lake City filing rates.
//   - TC-62 Sales & Use Tax: state 5.35% + county 1.54% + city 0.50% + special 1.06% = 8.45%
//   - Sales Prepared Food Return (SPF): 1% restaurant tax on prepared food sales
// These two returns are filed SEPARATELY on tap.utah.gov with different account suffixes
// (-003-STC and -003-SPF respectively). Both are due on the same quarterly deadline.

const UTAH_RATE     = 0.0785;   // legacy combined estimate — still used for order-aggregate fallback
const UT_TC62_RATE  = 0.0845;   // SLC combined state+local Sales & Use (per Apr 2026 TC-62 form)
const UT_SPF_RATE   = 0.0100;   // UT Restaurant/Prepared Food Tax

// ── Quarter math ───────────────────────────────────────────────────────────
function quarterDateRange(year, quarter) {
  const q = parseInt(quarter, 10);
  if (q < 1 || q > 4) throw new Error('quarter must be 1..4');
  const startMonth = (q - 1) * 3;          // Q1 -> 0 (Jan), Q2 -> 3 (Apr), ...
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));  // last day of quarter
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start_date: iso(start), end_date: iso(end), label: `Q${q}-${year}` };
}

// Per-period due dates (Utah: quarterly returns due end of month following quarter).
function quarterDueDate(year, quarter) {
  const dueMap = { 1: [year, 3, 30], 2: [year, 6, 31], 3: [year, 9, 31], 4: [year + 1, 0, 31] };
  const [y, m, d] = dueMap[quarter];
  const dt = new Date(Date.UTC(y, m, d));    // month is 0-indexed; m+1 would be wrong
  // Actually easier: Q1 -> Apr 30, Q2 -> Jul 31, Q3 -> Oct 31, Q4 -> Jan 31 next year.
  const cal = { 1: `${year}-04-30`, 2: `${year}-07-31`, 3: `${year}-10-31`, 4: `${year + 1}-01-31` };
  return cal[quarter];
}

// ── JSON helper ────────────────────────────────────────────────────────────
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── CSV/TSV export helper ──────────────────────────────────────────────────
// Handles nested objects by JSON-stringifying them, nulls as empty cells,
// and escapes quotes per RFC 4180 (CSV only). For CSV we wrap any field
// containing a comma, quote, or newline in double quotes.
function tsvOrCsv(rows, format, filename) {
  rows = rows || [];
  if (!rows.length) {
    return new Response(`(no rows)\n`, {
      headers: { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${filename}"` },
    });
  }
  const delim = format === 'tsv' ? '\t' : ',';
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (format === 'tsv') return s.replace(/[\t\r\n]/g, ' ');
    // CSV escape
    if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const header = cols.join(delim);
  const body = rows.map(r => cols.map(c => escape(r[c])).join(delim)).join('\n');
  const csv = header + '\n' + body + '\n';
  return new Response(csv, {
    headers: {
      'Content-Type': format === 'tsv' ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ── Build the single-return worksheet (internal, reused by both returns) ──
// Pulls from:
//   1. sales_tax_liability rows for the period (most authoritative — per-transaction)
//   2. Falls back to aggregating `orders` WHERE source IN ('square','toast','square_delivery','manual_upload')
//      for the date range, estimating tax at the UTAH_RATE.
// Returns a flat totals object that calculateQuarter then splits into SPF + TC-62.
async function _computePeriodTotals(env, year, quarter) {
  const { start_date, end_date, label } = quarterDateRange(year, quarter);
  const due_date = quarterDueDate(year, parseInt(quarter, 10));

  // Source 1: per-transaction tax liability rows (richest data once Square is live).
  const liab = await env.DB.prepare(`
    SELECT
      SUM(taxable_amount)       AS taxable_total,
      SUM(tax_collected)        AS tax_total,
      COUNT(*)                  AS liab_rows
    FROM sales_tax_liability
    WHERE jurisdiction = 'UT'
      AND collection_date >= ? AND collection_date <= ?
  `).bind(start_date, end_date).first();

  // Source 2: aggregate orders table, split by channel.
  //  - Retail (Square/Toast) = taxable
  //  - Wholesale (qbo_wholesale/shopify_wholesale) = exempt (resale certs cover)
  //  - Delivery platforms (DoorDash/Uber) = retail-taxable (we collect tax on gross)
  // Use the first run of each Toast source to avoid double-counting toast_tsv/toast_live overlaps.
  const ordRetail = await env.DB.prepare(`
    SELECT COUNT(*) AS order_count, COALESCE(SUM(gross_revenue), 0) AS gross_total
    FROM orders
    WHERE source IN ('square','square_delivery','toast','manual_upload')
      AND order_date >= ? AND order_date <= ? || 'T23:59:59Z'
  `).bind(start_date, end_date).first();
  const ordWholesale = await env.DB.prepare(`
    SELECT COUNT(*) AS order_count, COALESCE(SUM(gross_revenue), 0) AS gross_total
    FROM orders
    WHERE source IN ('qbo_wholesale','shopify_wholesale','wholesale_manual')
      AND order_date >= ? AND order_date <= ? || 'T23:59:59Z'
  `).bind(start_date, end_date).first();
  const ord = {
    order_count: (ordRetail?.order_count || 0) + (ordWholesale?.order_count || 0),
    gross_total: (ordRetail?.gross_total || 0) + (ordWholesale?.gross_total || 0),
    retail_total: ordRetail?.gross_total || 0,
    wholesale_total: ordWholesale?.gross_total || 0,
  };

  // Source 3: any manually-entered period totals (Toast CSV upload, Drew override).
  // Stored as a single sales_tax_liability row with source_type='manual_period_upload'.
  const manual = await env.DB.prepare(`
    SELECT taxable_amount, tax_collected, source_id
    FROM sales_tax_liability
    WHERE jurisdiction = 'UT'
      AND source_type = 'manual_period_upload'
      AND filing_period = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(label).first();

  // Choose the best available signal.
  let taxable_sales, tax_collected, gross_sales, source;
  if (manual) {
    // Manual override wins — Drew uploaded a canonical number from Toast/etc.
    taxable_sales = manual.taxable_amount || 0;
    tax_collected = manual.tax_collected || 0;
    gross_sales   = taxable_sales;
    source = 'manual_period_upload';
  } else if ((liab?.liab_rows || 0) > 0) {
    taxable_sales = liab.taxable_total || 0;
    tax_collected = liab.tax_total || 0;
    gross_sales   = taxable_sales;   // per-txn liability only tracks taxable events
    source = 'sales_tax_liability';
  } else {
    // Fallback estimate from orders. Retail = taxable, wholesale = exempt.
    gross_sales   = ord.gross_total;
    taxable_sales = ord.retail_total;
    tax_collected = Math.round(taxable_sales * UTAH_RATE * 100) / 100;
    source = 'orders_aggregate_estimate';
  }

  // Exempt sales: from orders (wholesale rollup) + invoices table (future Square invoices).
  const invoiceExempt = await env.DB.prepare(`
    SELECT COALESCE(SUM(i.amount_total), 0) AS exempt_total
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE c.is_tax_exempt = 1
      AND i.invoice_date >= ? AND i.invoice_date <= ?
  `).bind(start_date, end_date).first();
  const exempt_sales = source === 'orders_aggregate_estimate'
    ? ord.wholesale_total + (invoiceExempt?.exempt_total || 0)
    : ord.wholesale_total + (invoiceExempt?.exempt_total || 0);  // wholesale always exempt when present

  return {
    label,
    start_date,
    end_date,
    due_date,
    source,
    gross_sales: Math.round((source === 'orders_aggregate_estimate' ? gross_sales : gross_sales + exempt_sales) * 100) / 100,
    exempt_sales: Math.round(exempt_sales * 100) / 100,
    taxable_sales: Math.round(taxable_sales * 100) / 100,
    tax_collected_total: Math.round(tax_collected * 100) / 100,
    retail_total: Math.round(ord.retail_total * 100) / 100,
    wholesale_total: Math.round(ord.wholesale_total * 100) / 100,
    order_count: ord.order_count || 0,
    liab_rows: liab?.liab_rows || 0,
    has_manual_override: !!manual,
  };
}

// ── Calculate the two Utah returns (SPF + TC-62) from the totals ──────────
// Utah splits Q1 into two filings: Restaurant Tax (SPF, 1%) and Sales & Use
// Tax (TC-62, SLC combined 8.45%). Both filed same day at tap.utah.gov under
// different account suffixes. This function:
//   1. Pulls period totals via _computePeriodTotals
//   2. Allocates tax into SPF vs TC-62 based on their rates
//   3. UPSERTs three rows in sales_tax_filings: 'spf', 'tc_62', and 'combined' (audit)
//   4. Returns an envelope with all three worksheets + filing instructions
async function calculateQuarter(env, year, quarter) {
  const t = await _computePeriodTotals(env, year, quarter);

  // Allocate the POS-collected tax between SPF and TC-62.
  // Toast collects both taxes on the same prepared-food sale. Split by rate:
  //   SPF collected   = taxable_sales * 1%  (authoritative from Toast Restaurant Tax row when available)
  //   TC-62 collected = tax_collected_total - SPF collected
  const spf_collected = Math.round(t.taxable_sales * UT_SPF_RATE * 100) / 100;
  const tc62_collected = Math.round(Math.max(0, t.tax_collected_total - spf_collected) * 100) / 100;

  // Owed at Utah's filing rates (what tap.utah.gov will compute).
  const spf_owed  = Math.round(t.taxable_sales * UT_SPF_RATE * 100) / 100;
  const tc62_owed = Math.round(t.taxable_sales * UT_TC62_RATE * 100) / 100;

  const shared_warnings = [];
  if (t.source === 'orders_aggregate_estimate') {
    shared_warnings.push('No per-transaction sales_tax_liability rows yet — this is an ESTIMATE. Upload Toast data via /finance/sales-tax/toast-upload before filing.');
  }
  if (t.order_count === 0 && !t.has_manual_override && t.liab_rows === 0) {
    shared_warnings.push('No orders found in D1 for this period. Upload POS data before filing.');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (t.due_date < today) shared_warnings.push(`PAST DUE: filing was due ${t.due_date}.`);
  else {
    const daysLeft = Math.ceil((new Date(t.due_date + 'T00:00:00Z').getTime() - Date.now()) / 86400000);
    if (daysLeft <= 14) shared_warnings.push(`Due in ${daysLeft} days (${t.due_date}).`);
  }

  // Reconciliation gap: if Toast undercollected, Drew pays the delta out of pocket.
  const collected_combined = Math.round((spf_collected + tc62_collected) * 100) / 100;
  const owed_combined      = Math.round((spf_owed + tc62_owed) * 100) / 100;
  const shortfall          = Math.round((owed_combined - collected_combined) * 100) / 100;
  if (Math.abs(shortfall) > 1) {
    shared_warnings.push(`POS tax collection shortfall: Toast collected $${collected_combined.toFixed(2)}, Utah computes $${owed_combined.toFixed(2)} owed — shortfall of $${shortfall.toFixed(2)}. You'll pay the delta out of pocket. Update Toast tax tables to Utah's 8.45% (in-store) and 8.45% (marketplace) rates to prevent recurrence.`);
  }

  // Build the three worksheets.
  const spf = {
    jurisdiction: 'UT',
    period: t.label,
    return_type: 'spf',
    account_suffix: '-003-SPF',
    form_name: 'Sales Prepared Food Return',
    period_start: t.start_date,
    period_end: t.end_date,
    due_date: t.due_date,
    tax_rate: UT_SPF_RATE,
    gross_sales: t.taxable_sales,            // SPF applies only to prepared food sales (== taxable_sales)
    exempt_sales: 0,
    taxable_sales: t.taxable_sales,
    tax_collected: spf_collected,
    tax_owed: spf_owed,
    data_source: t.source,
    warnings: shared_warnings,
    filing_instructions: {
      url: 'https://tap.utah.gov',
      account: 'Restaurant and Customized Food Tax (-003-SPF)',
      steps: [
        `Log in to tap.utah.gov → Restaurant and Customized Food Tax → Period ${t.end_date}.`,
        `On the by-county page, enter Total Charge for Salt Lake County: $${t.taxable_sales.toFixed(2)}.`,
        `Leave all other counties at $0.00.`,
        `Form auto-calculates Tax Due: ~$${spf_owed.toFixed(2)} (1% rate).`,
        'Submit. Pay via ACH from Mercury Checking.',
        `POST /finance/sales-tax/filings/${t.label}/filed?return=spf with {"confirmation_number":"…"} to record.`,
      ],
    },
  };

  const tc62 = {
    jurisdiction: 'UT',
    period: t.label,
    return_type: 'tc_62',
    account_suffix: '-003-STC',
    form_name: 'Sales and Use Tax Return (TC-62)',
    period_start: t.start_date,
    period_end: t.end_date,
    due_date: t.due_date,
    tax_rate: UT_TC62_RATE,
    gross_sales: t.gross_sales,              // Line 1: retail + wholesale
    exempt_sales: t.exempt_sales,            // Line 2: non-taxable + wholesale exempt
    taxable_sales: t.taxable_sales,          // Line 3: taxable prepared food (retail)
    tax_collected: tc62_collected,
    tax_owed: tc62_owed,
    data_source: t.source,
    breakdown: {
      retail_taxable: t.retail_total,
      wholesale_exempt: t.wholesale_total,
      order_count: t.order_count,
    },
    warnings: shared_warnings,
    filing_instructions: {
      url: 'https://tap.utah.gov',
      account: 'Sales and Use Tax (-003-STC)',
      steps: [
        `Log in to tap.utah.gov → Sales and Use Tax → Period ${t.end_date}.`,
        `Taxable Sales Detail page:`,
        `  Line 1 Total sales: $${t.gross_sales.toFixed(2)}`,
        `  Line 2 Exempt sales: $${t.exempt_sales.toFixed(2)}`,
        `  Line 3 Taxable sales (auto): $${t.taxable_sales.toFixed(2)}`,
        `  Line 4 Use tax: $0.00 (unless Irene flagged use-tax obligations)`,
        `Tax Calculation page:`,
        `  Line 8a Non-food and prepared food Sales: $${t.taxable_sales.toFixed(2)}`,
        `  Line 8b Grocery food Sales: $0.00 (Dangerous Pretzel sells no unprepared groceries)`,
        `  Form auto-calculates total tax: ~$${tc62_owed.toFixed(2)} at 8.45%`,
        'Submit. Pay via ACH from Mercury Checking.',
        `POST /finance/sales-tax/filings/${t.label}/filed?return=tc_62 with {"confirmation_number":"…"} to record.`,
      ],
    },
  };

  const combined = {
    jurisdiction: 'UT',
    period: t.label,
    return_type: 'combined',
    period_start: t.start_date,
    period_end: t.end_date,
    due_date: t.due_date,
    gross_sales: t.gross_sales,
    exempt_sales: t.exempt_sales,
    taxable_sales: t.taxable_sales,
    tax_collected: collected_combined,
    tax_owed: owed_combined,
    shortfall,
    data_source: t.source,
    note: 'Audit rollup — the two filed returns are `spf` and `tc_62` below. File both to tap.utah.gov.',
  };

  // UPSERT all three rows into sales_tax_filings.
  for (const w of [combined, spf, tc62]) {
    const existing = await env.DB.prepare(
      `SELECT id, status FROM sales_tax_filings WHERE jurisdiction = 'UT' AND period = ? AND return_type = ?`
    ).bind(w.period, w.return_type).first();
    if (existing) {
      const isLocked = ['filed', 'paid', 'amended'].includes(existing.status);
      if (isLocked) {
        // Filed returns are a historical record. Only refresh worksheet_json
        // (so the "what would we calculate today?" reference stays current)
        // and due_date/form metadata. Financial fields are frozen.
        await env.DB.prepare(`
          UPDATE sales_tax_filings
          SET due_date = ?, form_name = COALESCE(form_name, ?), account_suffix = COALESCE(account_suffix, ?),
              worksheet_json = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          w.due_date, w.form_name || null, w.account_suffix || null,
          JSON.stringify(w),
          existing.id
        ).run();
      } else {
        // Pending/calculated rows: fully refresh.
        await env.DB.prepare(`
          UPDATE sales_tax_filings
          SET due_date = ?, form_name = ?, account_suffix = ?,
              gross_sales = ?, exempt_sales = ?, taxable_sales = ?,
              tax_rate = ?, tax_collected = ?, tax_owed = ?,
              worksheet_json = ?,
              status = 'calculated',
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          w.due_date, w.form_name || null, w.account_suffix || null,
          w.gross_sales, w.exempt_sales, w.taxable_sales,
          w.tax_rate || null, w.tax_collected, w.tax_owed,
          JSON.stringify(w),
          existing.id
        ).run();
      }
    } else {
      await env.DB.prepare(`
        INSERT INTO sales_tax_filings (
          id, jurisdiction, period, return_type, account_suffix, form_name,
          due_date, gross_sales, exempt_sales, taxable_sales,
          tax_rate, tax_collected, tax_owed, status, worksheet_json
        ) VALUES (?, 'UT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'calculated', ?)
      `).bind(
        crypto.randomUUID(), w.period, w.return_type,
        w.account_suffix || null, w.form_name || null, w.due_date,
        w.gross_sales, w.exempt_sales, w.taxable_sales,
        w.tax_rate || null, w.tax_collected, w.tax_owed,
        JSON.stringify(w)
      ).run();
    }
  }

  // Audit log (one entry for the whole recalc).
  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'sales_tax_calculated', 'sales_tax_filings', ?, 'system', ?, ?)
  `).bind(
    crypto.randomUUID(), t.label,
    `Calculated ${t.label}: SPF $${spf_owed} + TC-62 $${tc62_owed} = $${owed_combined} owed (source: ${t.source}, shortfall: $${shortfall})`,
    JSON.stringify({ spf, tc62, combined })
  ).run();

  return { period: t.label, combined, spf, tc_62: tc62 };
}

// ── Manual revenue upload (Toast / CSV / correction) ───────────────────────
// Drew POSTS the canonical number for a period when automated data isn't available.
async function recordManualRevenue(env, body) {
  const period = body.period;                      // e.g. "Q1-2026"
  const taxable_amount = Number(body.taxable_amount || 0);
  const tax_collected = Number(body.tax_collected || 0);
  const note = (body.note || '').slice(0, 500);
  if (!period || !taxable_amount) return json({ error: 'period + taxable_amount required' }, 400);

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO sales_tax_liability (
      id, collection_date, source_type, source_id, jurisdiction,
      taxable_amount, tax_rate, tax_collected, filing_period, filing_status
    ) VALUES (?, date('now'), 'manual_period_upload', ?, 'UT', ?, ?, ?, ?, 'unfiled')
  `).bind(id, `manual_${period}_${Date.now()}`, taxable_amount, UTAH_RATE, tax_collected, period).run();

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'sales_tax_manual_upload', 'sales_tax_liability', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), id, `Manual upload for ${period}: $${taxable_amount} taxable, $${tax_collected} tax${note ? ` — ${note}` : ''}`,
    JSON.stringify({ period, taxable_amount, tax_collected, note })
  ).run();

  return json({ ok: true, id, period, taxable_amount, tax_collected });
}

// ── Toast CSV/JSON upload for a quarter ────────────────────────────────────
// Accepts a Toast "Sales & Taxes by Day" report and writes per-day rows to
// sales_tax_liability so the quarter worksheet flips from estimate to exact.
// Two input shapes supported:
//   1. application/json — body { period:"Q1-2026", daily:[{date, gross, exempt, taxable, tax}] }
//   2. text/csv         — headers: date, gross_sales, exempt_sales, taxable_sales, tax_collected
//                         Flexible column matching: tries common Toast export variants.
async function uploadToastCsv(request, env) {
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  let period = null;
  let rows = [];

  if (ct.includes('application/json')) {
    const body = await request.json();
    period = body.period;
    rows = Array.isArray(body.daily) ? body.daily : [];
  } else {
    // CSV body
    const url = new URL(request.url);
    period = url.searchParams.get('period');
    const csv = await request.text();
    rows = parseToastCsv(csv);
  }

  if (!period) return json({ error: 'period required (query param ?period=Q1-2026 for CSV, or body.period for JSON)' }, 400);
  if (!rows.length) return json({ error: 'no rows parsed from body' }, 400);

  // Clear prior Toast rows for this period (re-upload is idempotent).
  await env.DB.prepare(
    `DELETE FROM sales_tax_liability WHERE filing_period = ? AND source_type = 'toast_export'`
  ).bind(period).run();

  let totalTaxable = 0;
  let totalExempt = 0;
  let totalTax = 0;
  let inserted = 0;
  const errors = [];

  for (const r of rows) {
    const date = (r.date || '').slice(0, 10);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push({ row: r, error: 'invalid date' }); continue; }
    const taxable = Number(r.taxable_sales ?? r.taxable ?? r.net_sales ?? 0);
    const exempt  = Number(r.exempt_sales ?? r.exempt ?? 0);
    const tax     = Number(r.tax_collected ?? r.tax ?? 0);
    if (!taxable && !tax) { errors.push({ row: r, error: 'zero taxable + tax, skipped' }); continue; }

    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO sales_tax_liability (
        id, collection_date, source_type, source_id, jurisdiction,
        taxable_amount, tax_rate, tax_collected, filing_period, filing_status
      ) VALUES (?, ?, 'toast_export', ?, 'UT', ?, ?, ?, ?, 'unfiled')
    `).bind(
      id, date, `toast_${period}_${date}`,
      taxable, UTAH_RATE, tax, period
    ).run();
    totalTaxable += taxable;
    totalExempt  += exempt;
    totalTax     += tax;
    inserted++;
  }

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'sales_tax_toast_upload', 'sales_tax_liability', ?, 'drew', ?, ?)
  `).bind(
    crypto.randomUUID(), period,
    `Toast upload for ${period}: ${inserted} days, $${totalTaxable.toFixed(2)} taxable, $${totalTax.toFixed(2)} tax${errors.length ? ` (${errors.length} errors)` : ''}`,
    JSON.stringify({ period, inserted, totalTaxable, totalExempt, totalTax, errorCount: errors.length })
  ).run();

  return json({
    ok: true,
    period,
    rows_inserted: inserted,
    totals: {
      taxable_sales: Math.round(totalTaxable * 100) / 100,
      exempt_sales: Math.round(totalExempt * 100) / 100,
      tax_collected: Math.round(totalTax * 100) / 100,
    },
    errors: errors.slice(0, 10),
    next_step: `GET /finance/sales-tax/quarter?year=${period.slice(3)}&quarter=${period.slice(1, 2)} to re-render the worksheet`,
  });
}

// Best-effort Toast CSV parser. Accepts common header names.
function parseToastCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  // Column aliases Toast uses across its report variants.
  const aliasMap = {
    date: ['date', 'business date', 'order date', 'day'],
    gross_sales: ['gross sales', 'gross', 'total sales', 'sales total'],
    exempt_sales: ['exempt sales', 'exempt', 'tax exempt sales', 'non-taxable sales', 'non taxable sales'],
    taxable_sales: ['taxable sales', 'net sales', 'taxable', 'net'],
    tax_collected: ['tax', 'tax collected', 'sales tax', 'utah sales tax', 'tax amount'],
  };
  const colIndex = {};
  for (const [key, aliases] of Object.entries(aliasMap)) {
    for (let i = 0; i < headers.length; i++) {
      if (aliases.includes(headers[i])) { colIndex[key] = i; break; }
    }
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (!cells.length) continue;
    const row = {};
    for (const [key, idx] of Object.entries(colIndex)) {
      let raw = (cells[idx] || '').trim();
      if (key !== 'date') raw = raw.replace(/[\$,]/g, '');
      row[key] = raw;
    }
    // Normalize date: accept YYYY-MM-DD or MM/DD/YYYY or M/D/YY.
    if (row.date && !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      const m = row.date.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) {
        let [, mm, dd, yy] = m;
        if (yy.length === 2) yy = '20' + yy;
        row.date = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      }
    }
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  // Minimal CSV splitter that honors double-quoted fields with embedded commas.
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ── Mark a period as filed ─────────────────────────────────────────────────
// Supports `?return=spf|tc_62|combined` to mark a specific return filed.
// If return_type is omitted, marks ALL returns for the period (legacy behavior).
async function markFiled(env, period, body, returnType) {
  const confirmation = body.confirmation_number;
  const payment_amount = body.payment_amount != null ? Number(body.payment_amount) : null;
  const payment_date = body.payment_date || (payment_amount ? new Date().toISOString().slice(0, 10) : null);
  if (!confirmation) return json({ error: 'confirmation_number required' }, 400);

  // Validate return_type if supplied.
  if (returnType && !['spf', 'tc_62', 'combined'].includes(returnType)) {
    return json({ error: `invalid return_type '${returnType}' (must be spf | tc_62 | combined)` }, 400);
  }

  const rows = returnType
    ? [await env.DB.prepare(
        `SELECT * FROM sales_tax_filings WHERE jurisdiction = 'UT' AND period = ? AND return_type = ?`
      ).bind(period, returnType).first()].filter(Boolean)
    : (await env.DB.prepare(
        `SELECT * FROM sales_tax_filings WHERE jurisdiction = 'UT' AND period = ? ORDER BY return_type`
      ).bind(period).all()).results || [];

  if (!rows.length) {
    return json({ error: `no filings found for period=${period}${returnType ? `, return=${returnType}` : ''} — run /finance/sales-tax/quarter first` }, 404);
  }

  const updated = [];
  for (const filing of rows) {
    await env.DB.prepare(`
      UPDATE sales_tax_filings
      SET status = 'filed', filed_date = date('now'),
          filing_confirmation_number = ?,
          payment_amount = COALESCE(?, payment_amount),
          payment_date = COALESCE(?, payment_date),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(confirmation, payment_amount, payment_date, filing.id).run();

    await env.DB.prepare(`
      INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
      VALUES (?, 'sales_tax_filed', 'sales_tax_filings', ?, 'drew', ?)
    `).bind(
      crypto.randomUUID(), filing.id,
      `${period} ${filing.return_type} filed · confirmation=${confirmation}${payment_amount ? `, paid $${payment_amount}` : ''}`
    ).run();

    updated.push({
      return_type: filing.return_type,
      account_suffix: filing.account_suffix,
      tax_owed: filing.tax_owed,
      confirmation_number: confirmation,
    });
  }

  // Also mark per-transaction liability rows as filed (scoped to period).
  await env.DB.prepare(
    `UPDATE sales_tax_liability SET filing_status = 'filed' WHERE filing_period = ? AND jurisdiction = 'UT'`
  ).bind(period).run();

  return json({ ok: true, period, status: 'filed', returns_updated: updated });
}

// ── Seed annual filing schedule (Q1-Q4, all three return_types per quarter) ─
async function scheduleYear(env, year) {
  const created = [];
  const RETURN_TYPES = [
    { type: 'spf',      suffix: '-003-SPF', form: 'Sales Prepared Food Return' },
    { type: 'tc_62',    suffix: '-003-STC', form: 'Sales and Use Tax Return' },
    { type: 'combined', suffix: null,       form: null },
  ];
  for (const q of [1, 2, 3, 4]) {
    const period = `Q${q}-${year}`;
    const due = quarterDueDate(year, q);
    for (const rt of RETURN_TYPES) {
      const existing = await env.DB.prepare(
        `SELECT id FROM sales_tax_filings WHERE jurisdiction = 'UT' AND period = ? AND return_type = ?`
      ).bind(period, rt.type).first();
      if (existing) { created.push({ period, return_type: rt.type, status: 'already_exists' }); continue; }
      await env.DB.prepare(`
        INSERT INTO sales_tax_filings (id, jurisdiction, period, return_type, account_suffix, form_name, due_date, status)
        VALUES (?, 'UT', ?, ?, ?, ?, ?, 'pending')
      `).bind(crypto.randomUUID(), period, rt.type, rt.suffix, rt.form, due).run();
      created.push({ period, return_type: rt.type, due_date: due, status: 'scheduled' });
    }
  }
  return json({ ok: true, year, filings: created });
}

// ── List filings ───────────────────────────────────────────────────────────
async function listFilings(env, returnType) {
  const where = returnType
    ? `WHERE return_type = ?`
    : ``;
  const stmt = env.DB.prepare(`
    SELECT id, jurisdiction, period, return_type, account_suffix, form_name,
           due_date, filed_date, filing_confirmation_number,
           gross_sales, exempt_sales, taxable_sales, tax_rate, tax_collected, tax_owed,
           status, payment_date, payment_amount
    FROM sales_tax_filings ${where}
    ORDER BY period DESC, return_type
  `);
  const rows = returnType ? await stmt.bind(returnType).all() : await stmt.all();
  return json({ filings: rows.results || [] });
}

async function getFiling(env, period, returnType) {
  if (returnType) {
    const row = await env.DB.prepare(
      `SELECT * FROM sales_tax_filings WHERE jurisdiction = 'UT' AND period = ? AND return_type = ?`
    ).bind(period, returnType).first();
    if (!row) return json({ error: 'not found' }, 404);
    if (row.worksheet_json) {
      try { row.worksheet = JSON.parse(row.worksheet_json); } catch {}
      delete row.worksheet_json;
    }
    return json(row);
  }
  // No return_type filter: return all rows for the period grouped by type.
  const { results } = await env.DB.prepare(
    `SELECT * FROM sales_tax_filings WHERE jurisdiction = 'UT' AND period = ? ORDER BY return_type`
  ).bind(period).all();
  if (!results?.length) return json({ error: 'not found' }, 404);
  const byType = {};
  for (const row of results) {
    if (row.worksheet_json) {
      try { row.worksheet = JSON.parse(row.worksheet_json); } catch {}
      delete row.worksheet_json;
    }
    byType[row.return_type] = row;
  }
  return json({ period, returns: byType });
}

// ── Resale cert request (templated email body for Drew to send) ────────────
async function resaleCertRequest(env, body) {
  const customerId = body.customer_id;
  const customer = await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(customerId).first();
  if (!customer) return json({ error: 'customer not found' }, 404);
  const to = customer.ap_contact_email || customer.email || '';
  const contactName = customer.ap_contact_name || customer.display_name || 'there';
  const template = {
    to,
    subject: 'Tax exemption certificate request — Dangerous Pretzel',
    body:
`Hi ${contactName.split(/\s/)[0]},

As we update our records, can you send your Utah sales tax exemption certificate (TC-721) for our files? This ensures your wholesale invoices are properly tax-exempt going forward.

Thanks,
Drew`,
  };
  // Record the request so we track who's been asked.
  await env.DB.prepare(`
    INSERT OR IGNORE INTO resale_certs (id, customer_id, jurisdiction, requested_at)
    VALUES (?, ?, 'UT', datetime('now'))
  `).bind(crypto.randomUUID(), customerId).run();
  return json({ ok: true, email: template, customer: { id: customer.id, name: customer.display_name } });
}

// ── Router ─────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // POST /finance/sales-tax/quarter?year=YYYY&quarter=N
      if (path === '/finance/sales-tax/quarter' && (method === 'POST' || method === 'GET')) {
        const year = parseInt(url.searchParams.get('year'), 10);
        const quarter = parseInt(url.searchParams.get('quarter'), 10);
        if (!year || !quarter) return json({ error: 'year + quarter query params required' }, 400);
        const worksheet = await calculateQuarter(env, year, quarter);
        return json(worksheet);
      }

      if (path === '/finance/sales-tax/filings' && method === 'GET') {
        return await listFilings(env, url.searchParams.get('return') || null);
      }

      const filingMatch = path.match(/^\/finance\/sales-tax\/filings\/([^/]+)$/);
      if (filingMatch && method === 'GET') {
        return await getFiling(env, filingMatch[1], url.searchParams.get('return') || null);
      }

      const filedMatch = path.match(/^\/finance\/sales-tax\/filings\/([^/]+)\/filed$/);
      if (filedMatch && method === 'POST') {
        const body = await request.json();
        return await markFiled(env, filedMatch[1], body, url.searchParams.get('return') || null);
      }

      if (path === '/finance/sales-tax/manual-revenue' && method === 'POST') {
        const body = await request.json();
        return await recordManualRevenue(env, body);
      }

      // Toast CSV/JSON upload for a quarter (A1 — Q1 validation path).
      if (path === '/finance/sales-tax/toast-upload' && method === 'POST') {
        return await uploadToastCsv(request, env);
      }

      // ── Mercury sync (A2) ────────────────────────────────────────────────
      if (path === '/finance/mercury/sync-accounts' && method === 'POST') {
        const result = await mercurySyncAccounts(env);
        // Sanitize — don't echo full raw account objects (account + routing numbers).
        return json({
          ok: true,
          accounts_synced: result.accounts_synced,
          accounts: (result.accounts || []).map(a => ({
            id: a.id,
            name: a.name,
            type: a.type || a.kind,
            current_balance: a.currentBalance ?? a.balance,
            available_balance: a.availableBalance ?? a.available,
            status: a.status,
          })),
        });
      }
      if (path === '/finance/mercury/sync-transactions' && method === 'POST') {
        const since = url.searchParams.get('since') || '2026-01-01';
        const until = url.searchParams.get('until') || new Date().toISOString().slice(0, 10);
        const result = await mercurySyncTransactions(env, since, until);
        await env.DB.prepare(`
          INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
          VALUES (?, 'mercury_txn_sync', 'mercury_transactions', ?, 'system', ?, ?)
        `).bind(
          crypto.randomUUID(), `${since}_to_${until}`,
          `Mercury sync ${since}..${until}: ${result.inserted} inserted, ${result.skipped} skipped`,
          JSON.stringify(result)
        ).run();
        return json(result);
      }
      if (path === '/finance/mercury/probe' && method === 'GET') {
        const { probeMercuryEndpoints } = await import('./mercury-client.js');
        return json(await probeMercuryEndpoints(env));
      }
      if (path === '/finance/mercury/status' && method === 'GET') {
        const status = await mercuryStatus(env);
        // Reveal QBO-vs-live variance so Drew can see staleness.
        // Mercury returns names like "Mercury Checking ••0118"; match by prefix.
        const QBO_STALE = [
          { match: /^Mercury Checking/i, qbo: 64245.07, label: 'Mercury Checking (QBO 0118 - 1)' },
          { match: /^Mercury Savings/i,  qbo: 22899.24, label: 'Mercury Savings (QBO 5450 - 1)' },
          { match: /^Mercury Credit/i,   qbo: -1408.07, label: 'Mercury Credit (QBO 0000 - 1)' },
        ];
        status.qbo_vs_live = (status.accounts || []).map(a => {
          const stale = QBO_STALE.find(s => s.match.test(a.account_name || ''));
          return {
            account: a.account_name,
            live_balance: a.current_balance,
            qbo_stale_balance: stale?.qbo ?? null,
            variance: stale ? Math.round(((a.current_balance || 0) - stale.qbo) * 100) / 100 : null,
            qbo_source: stale?.label ?? null,
          };
        });
        const live_total = (status.accounts || []).reduce((s, a) => s + (a.current_balance || 0), 0);
        const qbo_total = 64245.07 + 22899.24 - 1408.07; // per Account List CSV
        status.summary = {
          live_total_cash: Math.round(live_total * 100) / 100,
          qbo_total_cash: Math.round(qbo_total * 100) / 100,
          overstatement_on_qbo: Math.round((qbo_total - live_total) * 100) / 100,
        };
        return json(status);
      }

      // ── QBO extract (A3 + A4) ────────────────────────────────────────────
      if (path === '/finance/qbo/extract-coa' && method === 'POST') {
        const result = await extractChartOfAccounts(env);
        return json(result);
      }
      if (path === '/finance/qbo/extract-2025' && method === 'POST') {
        const result = await extract2025Archive(env);
        return json(result);
      }

      // ── Square historical extract (B5) ──────────────────────────────────
      if (path === '/finance/square/extract-historical' && method === 'POST') {
        const since = url.searchParams.get('since') || '2025-01-01';
        const until = url.searchParams.get('until') || new Date().toISOString().slice(0, 10);
        const result = await extractSquareHistorical(env, since, until);
        await env.DB.prepare(`
          INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
          VALUES (?, 'square_historical_extract', 'fin_square_orders', ?, 'system', ?, ?)
        `).bind(
          crypto.randomUUID(), `${since}_to_${until}`,
          `Square historical extract ${since}..${until}: ${result.orders.inserted} orders, ${result.customers.inserted} customers`,
          JSON.stringify(result)
        ).run();
        return json(result);
      }
      if (path === '/finance/square/extract-status' && method === 'GET') {
        return json(await squareExtractStatus(env));
      }

      // ── Account forensic audit (B6) ─────────────────────────────────────
      // POST /finance/audit/account?account=Payroll%20Payable&ai=1
      if (path === '/finance/audit/account' && method === 'POST') {
        const account = url.searchParams.get('account');
        if (!account) return json({ error: "query param 'account' required (account name or QBO id)" }, 400);
        const ai = url.searchParams.get('ai') === '1' || url.searchParams.get('ai') === 'true';
        const includeAll = url.searchParams.get('all') === '1';
        const result = await auditAccount(env, account, { ai, include_transactions: includeAll });
        return json(result);
      }

      // ── Reconciliation memo generator (B7) ──────────────────────────────
      // GET/POST /finance/reconciliation/2025?format=html|json&ai=1
      const memoMatch = path.match(/^\/finance\/reconciliation\/(\d{4})$/);
      if (memoMatch && (method === 'GET' || method === 'POST')) {
        const year = parseInt(memoMatch[1], 10);
        const format = url.searchParams.get('format') || 'html';
        const ai = url.searchParams.get('ai') === '1' || url.searchParams.get('ai') === 'true';
        const memo = await generateReconciliationMemo(env, year, { ai });
        if (format === 'json') return json({ year: memo.year, sections: memo.sections, prose: memo.prose });
        return new Response(memo.html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `inline; filename="dangerous_pretzel_${year}_reconciliation_memo.html"`,
          },
        });
      }

      // ── CSV exports for Irene package (B8) ──────────────────────────────
      // GET /finance/export/qbo-archive.csv?year=2025
      // GET /finance/export/mercury-transactions.csv?year=2025
      // GET /finance/export/chart-of-accounts.csv
      // GET /finance/export/sales-tax-filings.csv
      if (path === '/finance/export/qbo-archive.csv' && method === 'GET') {
        const yr = url.searchParams.get('year') || '2025';
        const { results } = await env.DB.prepare(`
          SELECT entity_type, qbo_id, txn_date,
                 json_extract(raw_json,'$.DocNumber') as doc_number,
                 CAST(json_extract(raw_json,'$.TotalAmt') AS REAL) as total_amt,
                 json_extract(raw_json,'$.EntityRef.name') as entity_name,
                 json_extract(raw_json,'$.CustomerRef.name') as customer_name,
                 json_extract(raw_json,'$.VendorRef.name') as vendor_name,
                 json_extract(raw_json,'$.PrivateNote') as private_note
          FROM qbo_archive_entity
          WHERE txn_date LIKE ?
          ORDER BY txn_date, entity_type
        `).bind(yr + '-%').all();
        return tsvOrCsv(results, 'csv', `qbo_archive_${yr}.csv`);
      }
      if (path === '/finance/export/mercury-transactions.csv' && method === 'GET') {
        const yr = url.searchParams.get('year') || '2025';
        const { results } = await env.DB.prepare(`
          SELECT txn_date, account_name, amount, counterparty_name, description, category, status
          FROM mercury_transactions
          WHERE txn_date LIKE ?
          ORDER BY txn_date
        `).bind(yr + '-%').all();
        return tsvOrCsv(results, 'csv', `mercury_transactions_${yr}.csv`);
      }
      if (path === '/finance/export/chart-of-accounts.csv' && method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT account_name, account_type, account_subtype, detail_type, is_active, is_system, qbo_account_id, notes
          FROM chart_of_accounts
          ORDER BY account_type, account_name
        `).all();
        return tsvOrCsv(results, 'csv', 'chart_of_accounts.csv');
      }
      if (path === '/finance/export/sales-tax-filings.csv' && method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT period, return_type, account_suffix, form_name, due_date, filed_date,
                 filing_confirmation_number, gross_sales, exempt_sales, taxable_sales,
                 tax_rate, tax_collected, tax_owed, payment_date, payment_amount, status
          FROM sales_tax_filings
          ORDER BY period, return_type
        `).all();
        return tsvOrCsv(results, 'csv', 'sales_tax_filings.csv');
      }

      // ── CFO Agent v2 categorizer (C-1) ──────────────────────────────────
      if (path === '/finance/cfo/categorize' && method === 'POST') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 500;
        const skipAi = url.searchParams.get('skip_ai') === '1' || url.searchParams.get('skip_ai') === 'true';
        const result = await categorizeBatch(env, { limit, skip_ai: skipAi });
        return json(result);
      }
      if (path === '/finance/cfo/categorize-one' && method === 'POST') {
        const txnId = url.searchParams.get('txn_id');
        if (!txnId) return json({ error: 'query param txn_id required' }, 400);
        const result = await categorizeOneById(env, txnId);
        return json(result);
      }
      if (path === '/finance/cfo/categorize-stats' && method === 'GET') {
        return json(await categorizationStats(env));
      }

      // ── Session 5: Square Labor + Capex Reasoner ────────────────────────
      if (path === '/finance/square-labor/sync' && method === 'POST') {
        return json(await syncSquareLabor(env));
      }
      if (path === '/finance/square-labor/forecast' && method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 30;
        return json(await getLaborForecast(env, days));
      }
      if (path === '/finance/square-labor/productivity' && method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 30;
        return json(await getLaborProductivity(env, days));
      }
      const capexReasonMatch = path.match(/^\/finance\/capex\/([^/]+)\/reason$/);
      if (capexReasonMatch && method === 'POST') {
        return json(await reasonAboutCapex(env, capexReasonMatch[1]));
      }
      if (path === '/finance/capex/pending-approvals' && method === 'GET') {
        return json(await listPendingCapexApprovals(env));
      }
      const capexApproveMatch = path.match(/^\/finance\/capex\/decisions\/([^/]+)\/approve$/);
      if (capexApproveMatch && method === 'POST') {
        return json(await approveCapexDecision(env, capexApproveMatch[1]));
      }
      const capexRejectMatch = path.match(/^\/finance\/capex\/decisions\/([^/]+)\/reject$/);
      if (capexRejectMatch && method === 'POST') {
        return json(await rejectCapexDecision(env, capexRejectMatch[1]));
      }

      // ── Session 6: Receipt processing ───────────────────────────────────
      if (path === '/finance/receipts/process' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await processReceipt(env, body));
      }
      if (path === '/finance/receipts/pending' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
        return json(await listPendingReceipts(env, { limit }));
      }
      const receiptApproveMatch = path.match(/^\/finance\/receipts\/([^/]+)\/approve$/);
      if (receiptApproveMatch && method === 'POST') {
        return json(await approveReceipt(env, receiptApproveMatch[1]));
      }
      const receiptRejectMatch = path.match(/^\/finance\/receipts\/([^/]+)\/reject$/);
      if (receiptRejectMatch && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await rejectReceipt(env, receiptRejectMatch[1], body.note));
      }

      // ── Session 4: Issue Surfacer ───────────────────────────────────────
      if (path === '/finance/issues/scan' && method === 'POST') {
        return json(await scanIssues(env));
      }
      if (path === '/finance/issues' && method === 'GET') {
        const sev = url.searchParams.get('severity') || null;
        const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
        return json(await listIssues(env, { severity: sev, limit }));
      }
      const issueSnoozeMatch = path.match(/^\/finance\/issues\/([^/]+)\/snooze$/);
      if (issueSnoozeMatch && method === 'POST') {
        const days = parseInt(url.searchParams.get('days'), 10) || 7;
        return json(await snoozeIssue(env, issueSnoozeMatch[1], days));
      }
      const issueResolveMatch = path.match(/^\/finance\/issues\/([^/]+)\/resolve$/);
      if (issueResolveMatch && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await resolveIssue(env, issueResolveMatch[1], body.note));
      }
      const issueDismissMatch = path.match(/^\/finance\/issues\/([^/]+)\/dismiss$/);
      if (issueDismissMatch && method === 'POST') {
        return json(await dismissIssue(env, issueDismissMatch[1]));
      }

      // ── Session 3: Analysis Engine (breakeven / trends / scenarios / customers) ──
      if (path === '/finance/breakeven' && method === 'GET') {
        const lookback = parseInt(url.searchParams.get('lookback_days'), 10) || 90;
        return json(await getBreakeven(env, { lookback_days: lookback }));
      }
      if (path === '/finance/trends' && method === 'GET') {
        return json(await getTrends(env, { months: parseInt(url.searchParams.get('months'), 10) || 12 }));
      }
      const trendMetricMatch = path.match(/^\/finance\/trends\/([^/]+)$/);
      if (trendMetricMatch && method === 'GET') {
        return json(await getTrend(env, trendMetricMatch[1], { months: parseInt(url.searchParams.get('months'), 10) || 12 }));
      }
      if (path === '/finance/scenario' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await runScenario(env, body));
      }
      if (path === '/finance/customer-intel' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 25;
        return json(await getCustomerIntel(env, { limit }));
      }
      const custProfileMatch = path.match(/^\/finance\/customer-intel\/(.+)$/);
      if (custProfileMatch && method === 'GET') {
        return json(await getCustomerProfile(env, decodeURIComponent(custProfileMatch[1])));
      }

      // ── Session 2: Plaid integration ────────────────────────────────────
      if (path === '/finance/plaid/link-token' && method === 'POST') {
        try {
          const body = await request.json().catch(() => ({}));
          const result = await plaidLinkToken(env, body);
          return json(result);
        } catch (err) {
          return json({ error: err.message }, 400);
        }
      }
      if (path === '/finance/plaid/exchange' && method === 'POST') {
        try {
          const body = await request.json().catch(() => ({}));
          if (!body.public_token) return json({ error: 'public_token required' }, 400);
          return json(await plaidExchange(env, body.public_token));
        } catch (err) {
          return json({ error: err.message }, 500);
        }
      }
      if (path === '/finance/plaid/sync' && method === 'POST') {
        const itemId = url.searchParams.get('item_id');
        if (itemId) return json(await plaidSyncItem(env, itemId));
        return json(await plaidSyncAll(env));
      }
      if (path === '/finance/plaid/status' && method === 'GET') {
        return json(await getPlaidStatus(env));
      }
      if (path === '/finance/plaid/disconnect' && method === 'POST') {
        const itemId = url.searchParams.get('item_id');
        if (!itemId) return json({ error: 'item_id required' }, 400);
        return json(await plaidDisconnect(env, itemId));
      }

      // ── Session 1: Vendor KB + CFO facts (foundation) ──────────────────
      if (path === '/finance/vendor-kb/build' && method === 'POST') {
        return json(await buildVendorKB(env));
      }
      if (path === '/finance/vendor-kb/summary' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
        return json(await listTopVendors(env, limit));
      }
      const vendorKbMatch = path.match(/^\/finance\/vendor-kb\/(.+)$/);
      if (vendorKbMatch && method === 'GET' && !path.endsWith('/build') && !path.endsWith('/summary')) {
        return json(await lookupVendor(env, decodeURIComponent(vendorKbMatch[1])));
      }

      if (path === '/finance/cfo-facts' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await recordFact(env, body));
      }
      if (path === '/finance/cfo-facts' && method === 'GET') {
        const factType = url.searchParams.get('type') || null;
        const limit = parseInt(url.searchParams.get('limit'), 10) || 100;
        return json(await listFacts(env, { fact_type: factType, limit }));
      }
      const cfoFactsLookupMatch = path.match(/^\/finance\/cfo-facts\/lookup\/(.+)$/);
      if (cfoFactsLookupMatch && method === 'GET') {
        const factType = url.searchParams.get('type') || null;
        return json(await lookupFacts(env, decodeURIComponent(cfoFactsLookupMatch[1]), factType));
      }
      const cfoFactsDeactivateMatch = path.match(/^\/finance\/cfo-facts\/([^/]+)\/deactivate$/);
      if (cfoFactsDeactivateMatch && method === 'POST') {
        return json(await deactivateFact(env, cfoFactsDeactivateMatch[1]));
      }
      const cfoFactsSupersedeMatch = path.match(/^\/finance\/cfo-facts\/([^/]+)\/supersede$/);
      if (cfoFactsSupersedeMatch && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await supersedeFact(env, cfoFactsSupersedeMatch[1], body.new_fact_id));
      }

      // ── Session 0: AI budget + trust score (safety net) ─────────────────
      if (path === '/finance/ai-budget' && method === 'GET') {
        return json(await getBudgetStatus(env));
      }
      if (path === '/finance/ai-cost-breakdown' && method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 7;
        return json(await getCostBreakdown(env, days));
      }
      if (path === '/finance/trust-score' && method === 'GET') {
        return json(await getTrustScore(env));
      }
      if (path === '/finance/trust-score/history' && method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 30;
        return json(await getTrustHistory(env, days));
      }
      if (path === '/finance/trust-score/snapshot' && method === 'POST') {
        return json(await snapshotTrustScore(env));
      }

      // ── Phase 2 visibility tools (May 13 reset) ─────────────────────────
      if (path === '/finance/scorecard' && method === 'GET') {
        return json(await getScorecard(env));
      }
      if (path === '/finance/monthly-pl/quad' && method === 'GET') {
        return json(await getMonthlyPLQuad(env));
      }
      if (path === '/finance/monthly-pl' && method === 'GET') {
        const period = url.searchParams.get('period');
        if (!period) return json({ error: 'query param period=YYYY-MM required' }, 400);
        const recompute = url.searchParams.get('recompute') === 'true';
        return json(await getMonthlyPL(env, period, { recompute }));
      }
      if (path === '/finance/ar-aging' && method === 'GET') {
        return json(await getArAging(env));
      }
      const arCustMatch = path.match(/^\/finance\/ar-aging\/customer\/(.+)$/);
      if (arCustMatch && method === 'GET') {
        return json(await getArCustomer(env, decodeURIComponent(arCustMatch[1])));
      }
      if (path === '/finance/ar-aging/draft-reminder' && method === 'POST') {
        const invId = url.searchParams.get('id');
        if (!invId) return json({ error: 'query param id required' }, 400);
        return json(await buildReminderDraft(env, invId));
      }
      if (path === '/finance/cfo/email/daily-morning' && method === 'POST') {
        return json(await sendDailyMorningBrief(env));
      }
      // QBO ↔ Mercury matcher — uses bookkeeper's existing QBO categorizations
      // to re-categorize pre-cutoff Mercury txns instead of guessing fresh.
      if (path === '/finance/qbo-match/preview' && method === 'GET') {
        const start = url.searchParams.get('start');
        const cutoff = url.searchParams.get('cutoff');
        return json(await qboMatchPreview(env, { start, cutoff }));
      }
      if (path === '/finance/qbo-match/apply' && method === 'POST') {
        const start = url.searchParams.get('start');
        const cutoff = url.searchParams.get('cutoff');
        return json(await qboMatchApply(env, { start, cutoff }));
      }

      // ── Canonical financial helpers (single source of truth) ────────────
      // Every other report (Monday Digest, CFO Pulse, chat) MUST read from
      // these endpoints — not from QBO and not from financial_directives.
      if (path === '/finance/canonical/cash-on-hand' && method === 'GET') {
        return json(await getCanonicalCashOnHand(env));
      }
      if (path === '/finance/canonical/weekly-burn' && method === 'GET') {
        return json(await getCanonicalWeeklyBurn(env));
      }
      // Session 16a (May 14 2026): recurring burn — what runway display reads
      if (path === '/finance/canonical/recurring-burn' && method === 'GET') {
        return json(await getCanonicalRecurringBurn(env));
      }
      // Session 17b (May 14 2026): canonical forecast — what runway hero reads
      if (path === '/finance/canonical/forecast' && method === 'GET') {
        const d = parseInt(url.searchParams.get('days'), 10) || 90;
        return json(await getCanonicalForecast(env, d));
      }
      // Session 17c (May 14 2026): page-top Sonnet narrative + page mode
      if (path === '/finance/page-narrative' && method === 'GET') {
        return json(await getPageNarrative(env));
      }
      if (path === '/finance/page-narrative/regenerate' && method === 'POST') {
        return json(await generatePageNarrative(env));
      }
      if (path === '/finance/page-mode' && method === 'GET') {
        return json(await getPageMode(env));
      }
      if (path === '/finance/canonical/runway' && method === 'GET') {
        return json(await getCanonicalRunway(env));
      }
      if (path === '/finance/canonical/weekly-revenue' && method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 7;
        return json(await getCanonicalWeeklyRevenue(env, days));
      }
      // DIF-2: canonical-truth registry — single page that lists every
      // canonical metric + its current value + cross-consumer agreement.
      if (path === '/finance/canonical-truth' && method === 'GET') {
        return json(await getCanonicalTruthState(env));
      }
      if (path === '/finance/canonical-truth/agreement' && method === 'GET') {
        return json({ checks: await checkCrossConsumerAgreement(env) });
      }
      // DIF-5: contract tests for every external API boundary
      if (path === '/finance/contracts' && method === 'GET') {
        return json(await checkContracts(env));
      }

      // ── Audit engine (tier 1 hourly + tier 5 acceptance + injection) ────
      if (path === '/finance/audit/tier/1' && method === 'POST') {
        const trig = url.searchParams.get('triggered_by') || 'manual';
        return json(await runTier1(env, trig));
      }
      if (path === '/finance/audit/tier/2' && method === 'POST') {
        const trig = url.searchParams.get('triggered_by') || 'manual';
        return json(await runTier2(env, trig));
      }
      if (path === '/finance/system-health' && method === 'GET') {
        return json(await getSystemHealth(env));
      }
      if (path === '/finance/audit/injection-tests' && method === 'POST') {
        return json(await runInjectionTests(env, 'manual'));
      }
      if (path === '/finance/audit/acceptance' && method === 'POST') {
        const month = url.searchParams.get('month');
        if (!month) return json({ error: 'query param month=YYYY-MM required' }, 400);
        return json(await runTier5Acceptance(env, month, 'manual'));
      }
      if (path === '/finance/audit/acceptance/year' && method === 'POST') {
        const year = url.searchParams.get('year');
        if (!year) return json({ error: 'query param year=YYYY required' }, 400);
        return json(await runTier5Year(env, year, 'manual'));
      }
      if (path === '/finance/audit/acceptance/references' && method === 'GET') {
        return json(await listAcceptanceReferences(env, url.searchParams.get('month')));
      }
      if (path === '/finance/audit/acceptance/reference' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await addAcceptanceReference(env, body));
      }
      if (path === '/finance/audit/acceptance/seed-qbo' && method === 'POST') {
        const month = url.searchParams.get('month');
        if (!month) return json({ error: 'query param month=YYYY-MM required' }, 400);
        return json(await seedReferencesFromQbo(env, month));
      }
      if (path === '/finance/audit/history' && method === 'GET') {
        const tier = url.searchParams.get('tier');
        const days = parseInt(url.searchParams.get('days'), 10) || 7;
        return json(await getAuditHistory(env, { tier: tier != null ? parseInt(tier, 10) : null, days }));
      }
      if (path === '/finance/audit/latest' && method === 'GET') {
        return json(await getAuditLatest(env));
      }
      const auditDetailMatch = path.match(/^\/finance\/audit\/([0-9a-f-]{36})$/);
      if (auditDetailMatch && method === 'GET') {
        return json(await getAuditDetail(env, auditDetailMatch[1]));
      }

      // ── Review queue (M2) — inline approve/override/reject UI ───────────
      if (path === '/finance/cfo/review-queue' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 50;
        const minConf = parseFloat(url.searchParams.get('min_confidence')) || 0.90;
        return json(await getReviewQueue(env, { limit, min_confidence: minConf }));
      }
      if (path === '/finance/cfo/coa-simple' && method === 'GET') {
        return json(await getCoaSimple(env));
      }
      const reviewMatch = path.match(/^\/finance\/cfo\/review\/([^\/]+)\/(approve|override|reject|unreject)$/);
      if (reviewMatch && method === 'POST') {
        const txnId = reviewMatch[1];
        const action = reviewMatch[2];
        const body = await request.json().catch(() => ({}));
        if (action === 'approve')   return json(await approveTxn(env, txnId, body));
        if (action === 'override')  return json(await overrideTxn(env, txnId, body));
        if (action === 'reject')    return json(await rejectTxn(env, txnId, body));
        if (action === 'unreject')  return json(await unrejectTxn(env, txnId));
      }

      // ── Bulk review by counterparty (the lever that moves 953 txns fast) ─
      if (path === '/finance/cfo/review-queue-by-counterparty' && method === 'GET') {
        const minConf = parseFloat(url.searchParams.get('min_confidence')) || 0.90;
        return json(await getReviewQueueByCounterparty(env, { min_confidence: minConf }));
      }
      if (path === '/finance/cfo/bulk-approve-counterparty' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await bulkApproveCounterparty(env, body));
      }
      if (path === '/finance/cfo/bulk-reject-counterparty' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await bulkRejectCounterparty(env, body));
      }

      // ── CFO Agent v2 JE poster (C-5) ────────────────────────────────────
      if (path === '/finance/cfo/post-jes' && method === 'POST') {
        const limit = parseInt(url.searchParams.get('limit'), 10) || 300;
        const minConfidence = parseFloat(url.searchParams.get('min_confidence')) || 0.90;
        const result = await postJeBatch(env, { limit, min_confidence: minConfidence });
        return json(result);
      }
      if (path === '/finance/cfo/post-jes-one' && method === 'POST') {
        const txnId = url.searchParams.get('txn_id');
        if (!txnId) return json({ error: 'query param txn_id required' }, 400);
        return json(await postJeOne(env, txnId));
      }
      if (path === '/finance/cfo/posted-stats' && method === 'GET') {
        return json(await postedStats(env));
      }
      if (path === '/finance/cfo/reverse-je' && method === 'POST') {
        const entryId = url.searchParams.get('entry_id');
        if (!entryId) return json({ error: 'query param entry_id required' }, 400);
        const body = await request.json().catch(() => ({}));
        return json(await reverseJe(env, entryId, body.reason));
      }

      // ── Capex auto-flagging (C-3) ────────────────────────────────────────
      if (path === '/finance/cfo/capex-candidates' && method === 'GET') {
        const year = url.searchParams.get('year');
        const since = url.searchParams.get('since');
        const threshold = parseFloat(url.searchParams.get('threshold')) || 2500;
        return json(await capexCandidates(env, { year, since, threshold }));
      }
      const capMatch = path.match(/^\/finance\/cfo\/capex\/([^/]+)\/(capitalize|reject)$/);
      if (capMatch && method === 'POST') {
        const [, txnId, action] = capMatch;
        const body = await request.json().catch(() => ({}));
        if (action === 'capitalize') return json(await capitalize(env, txnId, body));
        return json(await rejectCapex(env, txnId, body.reason));
      }

      // ── Cash flow forecast (C-4) ────────────────────────────────────────
      if (path === '/finance/cfo/forecast/rebuild' && method === 'POST') {
        const days = parseInt(url.searchParams.get('days'), 10) || 30;
        return json(await rebuildForecast(env, days));
      }
      if (path === '/finance/cfo/forecast' && method === 'GET') {
        const days = parseInt(url.searchParams.get('days'), 10) || 30;
        return json(await getForecast(env, days));
      }

      // ── Daily close orchestrator (C-2 / C-6) ────────────────────────────
      if (path === '/finance/cfo/daily-close' && method === 'POST') {
        return json(await runDailyClose(env));
      }

      // ── Monthly close (3.4) ─────────────────────────────────────────────
      if (path === '/finance/cfo/monthly-close' && method === 'POST') {
        const period = url.searchParams.get('period');  // YYYY-MM; defaults to prior month
        const force = url.searchParams.get('force') === 'true';
        return json(await runMonthlyClose(env, period, { force }));
      }
      // RTR-4: gate check endpoint (read-only) — verifies a period is ready to close
      const mcGateMatch = path.match(/^\/finance\/cfo\/monthly-close\/(\d{4}-\d{2})\/gate-check$/);
      if (mcGateMatch && method === 'GET') {
        return json(await checkCloseGate(env, mcGateMatch[1]));
      }
      // RTR-5: late-txn buffer endpoints
      if (path === '/finance/late-txns' && method === 'GET') {
        const status = url.searchParams.get('status') || 'pending';
        return json(await listLateTxns(env, { status }));
      }
      const lateGetMatch = path.match(/^\/finance\/late-txns\/([^/]+)$/);
      if (lateGetMatch && method === 'GET') {
        return json(await getLateTxn(env, lateGetMatch[1]));
      }
      const lateDecMatch = path.match(/^\/finance\/late-txns\/([^/]+)\/decision$/);
      if (lateDecMatch && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await applyLateTxnDecision(env, lateDecMatch[1], body));
      }
      // RTR-6: POS-direct revenue recognition (cutover, backfill, status)
      if (path === '/finance/rtr/cutover-status' && method === 'GET') {
        return json(await getRtrCutoverStatus(env));
      }
      if (path === '/finance/rtr/set-cutover' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await setRtrCutoverDate(env, body.date || null));
      }
      if (path === '/finance/rtr/backfill-sales-recognition' && method === 'POST') {
        const period = url.searchParams.get('period');
        const cutover = url.searchParams.get('cutover') || null;
        const dryRun = url.searchParams.get('dry_run') === 'true';
        const limit = parseInt(url.searchParams.get('limit'), 10) || 500;
        return json(await backfillSalesRecognition(env, { period, cutover, dry_run: dryRun, limit }));
      }
      // Manual post for a single order (testing)
      const rtrPostMatch = path.match(/^\/finance\/rtr\/post-sales-rec\/([^/]+)$/);
      if (rtrPostMatch && method === 'POST') {
        const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?`).bind(rtrPostMatch[1]).first();
        if (!order) return json({ ok: false, error: 'order not found' }, 404);
        return json(await postSalesRecognitionJe(env, order));
      }
      // RTR-7: canonical monthly revenue table
      if (path === '/finance/canonical-revenue' && method === 'GET') {
        const period = url.searchParams.get('period');
        if (period) return json(await getCanonicalRevenue(env, period));
        return json(await listCanonicalRevenue(env));
      }
      if (path === '/finance/canonical-revenue/refresh' && method === 'POST') {
        return json(await refreshRecentCanonicalRevenue(env));
      }
      if (path === '/finance/rtr/backfill-canonical-revenue' && method === 'POST') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        return json(await backfillCanonicalRevenue(env, { from, to }));
      }
      // RTR-8: three-way Tier 5 acceptance
      if (path === '/finance/audit/three-way' && method === 'GET') {
        const period = url.searchParams.get('period');
        if (!period) return json({ ok: false, error: 'period=YYYY-MM required' }, 400);
        return json(await runThreeWayTier5(env, period));
      }
      const mcMatch = path.match(/^\/finance\/cfo\/monthly-close\/(\d{4}-\d{2})$/);
      if (mcMatch && method === 'GET') {
        return json(await getMonthlyClose(env, mcMatch[1]));
      }
      // RTR-3 (May 13 2026): recompute a (closed) period's brief from current data
      const mcRecomputeMatch = path.match(/^\/finance\/cfo\/monthly-close\/(\d{4}-\d{2})\/recompute$/);
      if (mcRecomputeMatch && method === 'POST') {
        const write = url.searchParams.get('write') === 'true';
        return json(await recomputeMonthlyClose(env, mcRecomputeMatch[1], { write }));
      }

      // ── Weekly directive (3.3) ──────────────────────────────────────────
      if (path === '/finance/cfo/weekly-directive' && method === 'POST') {
        const ai = url.searchParams.get('ai') !== '0';
        return json(await runWeeklyDirective(env, { ai }));
      }
      if (path === '/finance/cfo/weekly-directive' && method === 'GET') {
        return json(await getWeeklyDirective(env));
      }

      // ── Loans (3.8) ──────────────────────────────────────────────────────
      if (path === '/finance/cfo/loans' && method === 'POST') {
        const body = await request.json();
        return json(await createLoan(env, body));
      }
      if (path === '/finance/cfo/loans' && method === 'GET') {
        const { results } = await env.DB.prepare(`
          SELECT id, loan_name, lender, origination_date, original_principal, current_balance,
                 interest_rate, term_months, monthly_payment, next_payment_date, status
          FROM loans ORDER BY current_balance DESC
        `).all();
        return json({ loans: results || [] });
      }
      if (path === '/finance/cfo/loans/process-payments' && method === 'POST') {
        return json(await processLoanPayments(env, { limit: parseInt(url.searchParams.get('limit'), 10) || 100 }));
      }

      // ── 1099 tracking (3.7) ─────────────────────────────────────────────
      if (path === '/finance/cfo/1099-candidates' && method === 'GET') {
        const year = url.searchParams.get('year') || new Date().getFullYear().toString();
        return json(await find1099Candidates(env, year));
      }

      // ── Daily reconciliation + read-only mode (3.11) ────────────────────
      if (path === '/finance/cfo/daily-recon' && method === 'POST') {
        return json(await runDailyReconciliation(env));
      }
      if (path === '/finance/cfo/read-only' && method === 'GET') {
        return json(await getReadOnlyMode(env));
      }
      if (path === '/finance/cfo/read-only' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await setReadOnlyMode(env, !!body.active, body.reason));
      }

      // ── Pretzel warmer tracking (3.6) ───────────────────────────────────
      if (path === '/finance/cfo/warmers' && method === 'GET') {
        return json(await listWarmers(env));
      }
      if (path === '/finance/cfo/warmers' && method === 'POST') {
        const body = await request.json();
        return json(await createWarmer(env, body));
      }
      const warmerPlaceMatch = path.match(/^\/finance\/cfo\/warmers\/([^/]+)\/place$/);
      if (warmerPlaceMatch && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await placeWarmer(env, warmerPlaceMatch[1], body));
      }

      // ── Revenue sweep (D2) ──────────────────────────────────────────────
      if (path === '/finance/cfo/sweep-preview' && method === 'GET') {
        return json(await previewSweep(env));
      }
      if (path === '/finance/cfo/sweep-revenue' && method === 'POST') {
        return json(await runRevenueSweep(env));
      }
      if (path === '/finance/cfo/sweep-revenue-by-month' && method === 'POST') {
        return json(await runRevenueSweepByMonth(env));
      }
      if (path === '/finance/cfo/sweep-rewind' && method === 'POST') {
        return json(await rewindRevenueSweeps(env));
      }

      // Session 20C — QBO P&L truth puller
      if (path === '/finance/qbo/pull-pnl-truth' && method === 'POST') {
        const { pullPnLTruth } = await import('./finance-qbo-pnl-truth.js');
        const startP = url.searchParams.get('start') || '2025-01';
        const endP = url.searchParams.get('end') || '2026-04';
        return json(await pullPnLTruth(env, startP, endP));
      }
      if (path === '/finance/qbo/pnl-truth/summary' && method === 'GET') {
        const { getPnLTruthSummary } = await import('./finance-qbo-pnl-truth.js');
        return json(await getPnLTruthSummary(env));
      }
      if (path.startsWith('/finance/qbo/pnl-truth/') && method === 'GET') {
        const period = path.split('/').pop();
        const { getPnLTruthForPeriod } = await import('./finance-qbo-pnl-truth.js');
        return json(await getPnLTruthForPeriod(env, period));
      }

      // Session 20D — GL reconstruction from QBO P&L truth
      if (path === '/finance/gl/reconstruct/preview' && method === 'POST') {
        const { previewReconstruction } = await import('./finance-gl-reconstruction.js');
        const startP = url.searchParams.get('start') || '2025-01';
        const endP = url.searchParams.get('end') || '2026-02';
        return json(await previewReconstruction(env, startP, endP));
      }
      if (path === '/finance/gl/reconstruct' && method === 'POST') {
        const { postReconstruction } = await import('./finance-gl-reconstruction.js');
        const startP = url.searchParams.get('start') || '2025-01';
        const endP = url.searchParams.get('end') || '2026-02';
        const force = url.searchParams.get('force') === 'true';
        return json(await postReconstruction(env, startP, endP, { force }));
      }
      // Session 20G — Canonical GL revenue helper (the single source of truth)
      if (path === '/finance/gl/revenue' && method === 'GET') {
        const { getGLRevenueForPeriod } = await import('./finance-shared.js');
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        if (!start || !end) return json({ error: 'start + end required (YYYY-MM-DD)' }, 400);
        return json(await getGLRevenueForPeriod(env, start, end));
      }
      if (path === '/finance/gl/revenue/by-month' && method === 'GET') {
        const { getGLRevenueForPeriod } = await import('./finance-shared.js');
        const start = url.searchParams.get('start') || '2025-01-01';
        const end = url.searchParams.get('end') || '2026-05-31';
        // Walk months
        const out = [];
        let [sy, sm] = start.split('-').map(Number);
        const [ey, em] = end.split('-').map(Number);
        while (sy < ey || (sy === ey && sm <= em)) {
          const period = `${sy}-${String(sm).padStart(2, '0')}`;
          const lastDay = new Date(Date.UTC(sy, sm, 0)).getUTCDate();
          const result = await getGLRevenueForPeriod(env, `${period}-01`, `${period}-${String(lastDay).padStart(2, '0')}`);
          out.push({ period, total: result.total, breakdown: result.breakdown });
          sm++;
          if (sm > 12) { sm = 1; sy++; }
        }
        return json({ ok: true, months: out });
      }
      if (path === '/finance/gl/reconstruct/verify' && method === 'GET') {
        const { verifyReconstruction } = await import('./finance-gl-reconstruction.js');
        return json(await verifyReconstruction(env));
      }

      // Session 21-validate — Expense reconciliation to QBO P&L truth
      if (path === '/finance/gl/expense-reconcile/preview' && method === 'POST') {
        const { previewExpenseReconciliation } = await import('./finance-expense-reconstruction.js');
        const startP = url.searchParams.get('start') || '2025-01';
        const endP = url.searchParams.get('end') || '2026-02';
        return json(await previewExpenseReconciliation(env, startP, endP));
      }
      if (path === '/finance/gl/expense-reconcile' && method === 'POST') {
        const { postExpenseReconciliation } = await import('./finance-expense-reconstruction.js');
        const startP = url.searchParams.get('start') || '2025-01';
        const endP = url.searchParams.get('end') || '2026-02';
        const force = url.searchParams.get('force') === 'true';
        return json(await postExpenseReconciliation(env, startP, endP, { force }));
      }
      if (path === '/finance/gl/expense-reconcile/verify' && method === 'GET') {
        const { verifyExpenseReconciliation } = await import('./finance-expense-reconstruction.js');
        return json(await verifyExpenseReconciliation(env));
      }

      // Phase 21V-audit-6 F6: bookkeeper Tips + Sales Tax accrual restoration
      if (path === '/finance/gl/bookkeeper-tips-tax-accrual/preview' && method === 'GET') {
        const { previewAccrual } = await import('./finance-bookkeeper-tips-tax-accrual.js');
        return json(await previewAccrual(env));
      }
      if (path === '/finance/gl/bookkeeper-tips-tax-accrual' && method === 'POST') {
        const { postAccruals } = await import('./finance-bookkeeper-tips-tax-accrual.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await postAccruals(env, { force }));
      }

      // Phase 21V-MC-hist — Mercury Credit historical purchase ingestion from QBO archive
      if (path === '/finance/gl/ingest-mercury-credit/preview' && method === 'POST') {
        const { previewMercuryCreditIngest } = await import('./finance-mercury-credit-ingest.js');
        const year = parseInt(url.searchParams.get('year') || '2025', 10);
        return json(await previewMercuryCreditIngest(env, year));
      }
      if (path === '/finance/gl/ingest-mercury-credit' && method === 'POST') {
        const { ingestMercuryCreditPurchases } = await import('./finance-mercury-credit-ingest.js');
        const year = parseInt(url.searchParams.get('year') || '2025', 10);
        const force = url.searchParams.get('force') === 'true';
        return json(await ingestMercuryCreditPurchases(env, year, { force }));
      }
      if (path === '/finance/gl/ingest-mercury-credit/verify' && method === 'GET') {
        const { verifyMercuryCreditState } = await import('./finance-mercury-credit-ingest.js');
        return json(await verifyMercuryCreditState(env));
      }

      // Phase 21V Mercury IO statement ingestion
      if (path === '/finance/mercury-io/ingest-statement/preview' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { previewMercuryIOStatementIngest } = await import('./finance-mercury-io-statement.js');
        return json(await previewMercuryIOStatementIngest(env, body.pdf_base64, body.period));
      }
      if (path === '/finance/mercury-io/ingest-statement' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { ingestMercuryIOStatement } = await import('./finance-mercury-io-statement.js');
        return json(await ingestMercuryIOStatement(env, body.pdf_base64, body.period, { force: body.force === true }));
      }
      if (path === '/finance/mercury-io/verify-statements' && method === 'GET') {
        const { verifyMercuryIOStatements } = await import('./finance-mercury-io-statement.js');
        return json(await verifyMercuryIOStatements(env));
      }

      // Phase 21V-Chase — Chase Ink ••3178 statement ingestion
      if (path === '/finance/chase-ink/ingest-statement/preview' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { previewChaseInkIngest } = await import('./finance-chase-ink-statement.js');
        return json(await previewChaseInkIngest(env, body.pdf_base64, body.period));
      }
      if (path === '/finance/chase-ink/ingest-statement' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const { ingestChaseInkStatement } = await import('./finance-chase-ink-statement.js');
        return json(await ingestChaseInkStatement(env, body.pdf_base64, body.period, { force: body.force === true }));
      }

      // Phase 21V-QBO-JE — QBO JournalEntry ingestion with overlap detection
      if (path === '/finance/gl/ingest-qbo-je/preview' && method === 'POST') {
        const { previewQboJeIngest } = await import('./finance-qbo-je-ingest.js');
        const year = parseInt(url.searchParams.get('year') || '2025', 10);
        return json(await previewQboJeIngest(env, year));
      }
      if (path === '/finance/gl/ingest-qbo-je' && method === 'POST') {
        const { ingestQboJournalEntries } = await import('./finance-qbo-je-ingest.js');
        const year = parseInt(url.searchParams.get('year') || '2025', 10);
        const force = url.searchParams.get('force') === 'true';
        return json(await ingestQboJournalEntries(env, year, { force }));
      }

      // Session 24-B — Sales tax reclass period correction
      if (path === '/finance/gl/sales-tax-reclass-rebuild' && method === 'POST') {
        const { rebuildSalesTaxReclass } = await import('./finance-sales-tax-reclass-rebuild.js');
        const dry_run = url.searchParams.get('dry_run') === 'true';
        return json(await rebuildSalesTaxReclass(env, { dry_run }));
      }

      // Session 24-E — FY2026 depreciation Year-3 backfill
      if (path === '/finance/gl/fy2026-depreciation' && method === 'POST') {
        const { postFy2026Depreciation } = await import('./finance-fy2026-depreciation.js');
        const dry_run = url.searchParams.get('dry_run') === 'true';
        return json(await postFy2026Depreciation(env, { dry_run }));
      }

      // Session 24-F — Reclass historical Uline txns to COGS:Paper Packaging
      if (path === '/finance/gl/uline-reclass' && method === 'POST') {
        const { reclassUlineHistorical } = await import('./finance-uline-reclass.js');
        const dry_run = url.searchParams.get('dry_run') === 'true';
        return json(await reclassUlineHistorical(env, { dry_run }));
      }

      // Session 24 final cleanup — Mercury categorization + Payroll Payable drain
      if (path === '/finance/gl/session-24-cleanup' && method === 'POST') {
        const { runFinalCleanup } = await import('./finance-session-24-cleanup.js');
        const dry_run = url.searchParams.get('dry_run') === 'true';
        return json(await runFinalCleanup(env, { dry_run }));
      }

      // Monthly depreciation auto-post (also runs on cron 0 9 1 * *)
      if (path === '/finance/gl/monthly-depreciation' && method === 'POST') {
        const { postMonthlyDepreciation } = await import('./finance-monthly-depreciation-cron.js');
        const period = url.searchParams.get('period') || null;
        const force = url.searchParams.get('force') === 'true';
        return json(await postMonthlyDepreciation(env, { period, force }));
      }

      // Session 20F — Toast Sales Summary reconstruction (Mar 2026 + Apr 1-13)
      if (path === '/finance/gl/toast-reconstruct/preview' && method === 'GET') {
        const { previewToastReconstruction } = await import('./finance-toast-reconstruction.js');
        return json(await previewToastReconstruction(env));
      }
      if (path === '/finance/gl/toast-reconstruct' && method === 'POST') {
        const { postToastReconstruction } = await import('./finance-toast-reconstruction.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await postToastReconstruction(env, { force }));
      }

      // Phase 30-B — Toast POS per-order reconstruction (replaces qbo_pnl_reconstruction)
      if (path === '/finance/gl/toast-pos-reconstruct/preview' && method === 'GET') {
        const { previewToastPosReconstruction } = await import('./finance-toast-sales-pos-reconstruction.js');
        return json(await previewToastPosReconstruction(env));
      }
      if (path === '/finance/gl/toast-pos-reconstruct' && method === 'POST') {
        const { postToastPosReconstruction } = await import('./finance-toast-sales-pos-reconstruction.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await postToastPosReconstruction(env, { force }));
      }

      // Phase 30-B — Toast Payroll GL reconstruction (replaces qbo_je_ingest)
      if (path === '/finance/gl/toast-payroll-reconstruct/preview' && method === 'GET') {
        const { previewToastPayrollReconstruction } = await import('./finance-toast-payroll-reconstruction.js');
        return json(await previewToastPayrollReconstruction(env));
      }
      if (path === '/finance/gl/toast-payroll-reconstruct' && method === 'POST') {
        const { postToastPayrollReconstruction } = await import('./finance-toast-payroll-reconstruction.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await postToastPayrollReconstruction(env, { force }));
      }

      // Phase 30-B — LEAF amortization Principal/Interest/Tax split
      if (path === '/finance/gl/leaf-amortization/preview' && method === 'GET') {
        const { previewLeafAmortization } = await import('./finance-leaf-amortization-splitter.js');
        const start = url.searchParams.get('start') || '2025-01-01';
        const end = url.searchParams.get('end') || '2026-04-30';
        return json(await previewLeafAmortization(env, start, end));
      }
      if (path === '/finance/gl/leaf-amortization' && method === 'POST') {
        const { postLeafAmortization } = await import('./finance-leaf-amortization-splitter.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await postLeafAmortization(env, { force }));
      }

      // Phase 30-B — Square Payroll aggregate reconstruction (Apr-May 2026)
      if (path === '/finance/gl/square-payroll-reconstruct/preview' && method === 'GET') {
        const { previewSquarePayrollReconstruction } = await import('./finance-square-payroll-reconstruction.js');
        return json(await previewSquarePayrollReconstruction(env));
      }
      if (path === '/finance/gl/square-payroll-reconstruct' && method === 'POST') {
        const { postSquarePayrollReconstruction } = await import('./finance-square-payroll-reconstruction.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await postSquarePayrollReconstruction(env, { force }));
      }

      // Phase 30-C — Dry-run aggregator for atomic rebuild
      if (path === '/finance/phase30/dryrun' && method === 'GET') {
        const { runPhase30DryRun } = await import('./finance-phase30-dryrun.js');
        return json(await runPhase30DryRun(env));
      }
      // Session 21D — Cash Flow Statement (indirect method)
      if (path === '/finance/statements/cash-flow' && method === 'GET') {
        const { getCashFlowStatement, cfToCsv } = await import('./finance-statements-cash-flow.js');
        let start = url.searchParams.get('start');
        let end = url.searchParams.get('end');
        const period = url.searchParams.get('period');
        if (period === 'year' && url.searchParams.get('year')) {
          const y = url.searchParams.get('year');
          start = `${y}-01-01`; end = `${y}-12-31`;
        } else if (period === 'ytd') {
          const y = url.searchParams.get('year') || new Date().getUTCFullYear();
          start = `${y}-01-01`;
          end = new Date().toISOString().slice(0, 10);
        }
        if (!start || !end) return json({ error: 'start + end required (or period=year&year=)' }, 400);
        const cf = await getCashFlowStatement(env, start, end);
        const format = url.searchParams.get('format') || 'json';
        if (format === 'csv') {
          return new Response(cfToCsv(cf), {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': `attachment; filename="pretzel-cash-flow-${start}-${end}.csv"`,
            },
          });
        }
        return json(cf);
      }

      // Session 21C — Balance Sheet (standalone, multi-period, CSV, drill-down)
      if (path === '/finance/statements/balance-sheet' && method === 'GET') {
        const { getBalanceSheet, bsToCsv } = await import('./finance-statements-balance-sheet.js');
        const asOf = url.searchParams.get('as_of') || new Date().toISOString().slice(0, 10);
        const compareTo = url.searchParams.get('compare_to') || 'none';
        const compareDate = url.searchParams.get('compare_date');
        const bs = await getBalanceSheet(env, asOf, compareTo, compareDate);
        const format = url.searchParams.get('format') || 'json';
        if (format === 'csv') {
          return new Response(bsToCsv(bs), {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': `attachment; filename="pretzel-balance-sheet-${asOf}.csv"`,
            },
          });
        }
        return json(bs);
      }
      if (path === '/finance/statements/balance-sheet/explain' && method === 'GET') {
        const { explainBalanceChange } = await import('./finance-statements-balance-sheet.js');
        const accountId = url.searchParams.get('account_id');
        const fromDate = url.searchParams.get('from');
        const toDate = url.searchParams.get('to');
        if (!accountId || !fromDate || !toDate) return json({ error: 'account_id, from, to required' }, 400);
        return json(await explainBalanceChange(env, accountId, fromDate, toDate));
      }

      // Session 21B — P&L Statement (multi-period, compare, CSV)
      if (path === '/finance/statements/pnl' && method === 'GET') {
        const { getPnLStatement, pnlToCsv } = await import('./finance-statements-pnl.js');
        const period = url.searchParams.get('period') || 'ytd';
        const params = {
          start: url.searchParams.get('start'),
          end: url.searchParams.get('end'),
          month: url.searchParams.get('month'),
          quarter: url.searchParams.get('quarter'),
          year: url.searchParams.get('year') ? parseInt(url.searchParams.get('year')) : null,
          compare_to: url.searchParams.get('compare_to') || 'none',
        };
        const statement = await getPnLStatement(env, period, params);
        const format = url.searchParams.get('format') || 'json';
        if (format === 'csv') {
          return new Response(pnlToCsv(statement), {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': `attachment; filename="pretzel-pnl-${statement.period_start}-${statement.period_end}.csv"`,
            },
          });
        }
        return json(statement);
      }
      if (path === '/finance/statements/pnl/explain' && method === 'GET') {
        const { explainPnLLine } = await import('./finance-statements-pnl.js');
        const accountId = url.searchParams.get('account_id');
        const start = url.searchParams.get('start');
        const end = url.searchParams.get('end');
        if (!accountId || !start || !end) return json({ error: 'account_id, start, end required' }, 400);
        return json(await explainPnLLine(env, accountId, start, end));
      }

      // Session 21-pre — Opening Balance seeder + BS verifier
      if (path === '/finance/gl/seed-opening-balance' && method === 'POST') {
        const { seedOpeningBalance } = await import('./finance-opening-balance-seed.js');
        const force = url.searchParams.get('force') === 'true';
        return json(await seedOpeningBalance(env, { force }));
      }
      if (path === '/finance/gl/verify-balance-sheet' && method === 'GET') {
        const { verifyBalanceSheet } = await import('./finance-opening-balance-seed.js');
        const asOf = url.searchParams.get('as_of') || '2025-01-31';
        return json(await verifyBalanceSheet(env, asOf));
      }

      // Session 21-pre — QBO Balance Sheet as-of (for opening balance seed)
      if (path === '/finance/qbo/balance-sheet' && method === 'GET') {
        const { getBalanceSheet } = await import('./qbo-client.js');
        const asOf = url.searchParams.get('as_of') || new Date().toISOString().split('T')[0];
        const raw = await getBalanceSheet(env, asOf);
        // Flatten the QBO BS report into structured account list
        const flatten = (rows, path = []) => {
          const out = [];
          for (const r of rows || []) {
            if (r.Header) {
              const section = r.Header?.ColData?.[0]?.value || '';
              const cols = r.Header?.ColData || [];
              const headerAmt = parseFloat(cols[cols.length - 1]?.value || '0') || 0;
              if (Math.abs(headerAmt) > 0.001) {
                out.push({ path: [...path, section].join(' > '), account_name: section, amount: headerAmt, is_subtotal: 0, note: 'parent_direct' });
              }
              out.push(...flatten(r.Rows?.Row || [], [...path, section]));
              if (r.Summary?.ColData) {
                const sCols = r.Summary.ColData;
                const total = parseFloat(sCols[sCols.length - 1]?.value || '0') || 0;
                if (Math.abs(total) > 0.001) {
                  out.push({ path: [...path, section].join(' > '), account_name: `Total ${section}`, amount: total, is_subtotal: 1 });
                }
              }
            } else if (r.ColData) {
              const cols = r.ColData;
              const name = cols[0]?.value || '';
              const total = parseFloat(cols[cols.length - 1]?.value || '0') || 0;
              if (name && Math.abs(total) > 0.001) {
                out.push({ path: [...path, name].join(' > '), account_name: name, amount: total, is_subtotal: 0 });
              }
            }
          }
          return out;
        };
        const rows = raw?.Rows?.Row || [];
        const lines = flatten(rows);
        return json({ ok: true, as_of: asOf, basis: raw?.Header?.ReportBasis, lines });
      }

      // Session 21-pre — QBO Account list (for verifying bookkeeper classifications)
      if (path === '/finance/qbo/accounts' && method === 'GET') {
        const { qboSqlQuery } = await import('./qbo-client.js');
        const accountType = url.searchParams.get('type');
        const sql = accountType
          ? `SELECT * FROM Account WHERE AccountType = '${accountType}' MAXRESULTS 500`
          : `SELECT * FROM Account MAXRESULTS 500`;
        const result = await qboSqlQuery(env, sql);
        const accounts = (result?.QueryResponse?.Account || []).map(a => ({
          id: a.Id,
          name: a.Name,
          fully_qualified_name: a.FullyQualifiedName,
          account_type: a.AccountType,
          account_subtype: a.AccountSubType,
          classification: a.Classification,
          current_balance: a.CurrentBalance,
          active: a.Active,
        }));
        return json({ ok: true, count: accounts.length, accounts });
      }

      // Session 20F — QBO Payment list for cash-basis wholesale recognition
      if (path === '/finance/qbo/payments' && method === 'GET') {
        const { qboSqlQuery } = await import('./qbo-client.js');
        const start = url.searchParams.get('start') || '2026-03-01';
        const end = url.searchParams.get('end') || '2026-05-31';
        const sql = `SELECT * FROM Payment WHERE TxnDate >= '${start}' AND TxnDate <= '${end}' MAXRESULTS 500`;
        const result = await qboSqlQuery(env, sql);
        const payments = (result?.QueryResponse?.Payment || []).map(p => ({
          id: p.Id,
          txn_date: p.TxnDate,
          customer_id: p.CustomerRef?.value,
          customer: p.CustomerRef?.name,
          total: p.TotalAmt,
          unapplied: p.UnappliedAmt || 0,
          deposit_account: p.DepositToAccountRef?.name,
          linked_invoices: (p.Line || []).flatMap(l => (l.LinkedTxn || []).filter(t => t.TxnType === 'Invoice').map(t => ({ invoice_id: t.TxnId, amount: l.Amount }))),
          payment_method: p.PaymentMethodRef?.name,
        }));
        return json({ ok: true, count: payments.length, total: payments.reduce((s, p) => s + (p.total || 0), 0), payments });
      }
      // Session 20F — Wholesale reconstruction from QBO Payments (cash basis)
      if (path === '/finance/gl/wholesale-reconstruct/preview' && method === 'GET') {
        const { previewWholesaleReconstruction } = await import('./finance-wholesale-reconstruction.js');
        const start = url.searchParams.get('start') || '2026-03-01';
        const end = url.searchParams.get('end') || '2026-05-31';
        return json(await previewWholesaleReconstruction(env, start, end));
      }
      if (path === '/finance/gl/wholesale-reconstruct' && method === 'POST') {
        const { postWholesaleReconstruction } = await import('./finance-wholesale-reconstruction.js');
        const start = url.searchParams.get('start') || '2026-03-01';
        const end = url.searchParams.get('end') || '2026-05-31';
        const force = url.searchParams.get('force') === 'true';
        return json(await postWholesaleReconstruction(env, start, end, { force }));
      }
      // Session 20F — Square POS reconstruction (Apr 14+)
      if (path === '/finance/gl/square-reconstruct/preview' && method === 'GET') {
        const { computeSquarePeriod } = await import('./finance-square-reconstruction.js');
        const start = url.searchParams.get('start') || '2026-04-14';
        const end = url.searchParams.get('end') || '2026-04-30';
        return json(await computeSquarePeriod(env, start, end));
      }
      if (path === '/finance/gl/square-reconstruct' && method === 'POST') {
        const { postSquareReconstruction } = await import('./finance-square-reconstruction.js');
        const body = await request.json().catch(() => ({}));
        const periods = body.periods || [
          { start: '2026-04-14', end: '2026-04-30' },
          { start: '2026-05-01', end: '2026-05-14' },
        ];
        const force = url.searchParams.get('force') === 'true';
        return json(await postSquareReconstruction(env, periods, { force }));
      }

      // ── Opening balance (Wave 2.17, + M3 overrides API) ─────────────────
      // Both GET and POST accept the cutover date. POST body can carry overrides
      // (see /finance/cfo/opening-balance/preview response.override_hint for shape).
      if (path === '/finance/cfo/opening-balance/preview' && (method === 'GET' || method === 'POST')) {
        const cutover = url.searchParams.get('cutover') || '2026-05-01';
        const overrides = method === 'POST' ? await request.json().catch(() => ({})) : {};
        return json(await previewOpeningBalance(env, cutover, overrides));
      }
      if (path === '/finance/cfo/opening-balance/commit' && method === 'POST') {
        if (url.searchParams.get('acknowledge') !== '1') {
          return json({ error: 'requires ?acknowledge=1 to confirm you have reviewed the preview' }, 400);
        }
        const cutover = url.searchParams.get('cutover') || '2026-05-01';
        const body = await request.json().catch(() => ({}));
        return json(await commitOpeningBalance(env, cutover, body));
      }

      // ── Recurring bills / M5 ────────────────────────────────────────────
      if (path === '/finance/cfo/bills/propose-recurring' && method === 'POST') {
        const days = parseInt(url.searchParams.get('days'), 10) || 90;
        const post_as_draft = url.searchParams.get('post_as_draft') !== '0';
        return json(await proposeRecurringBills(env, { days, post_as_draft }));
      }
      if (path === '/finance/cfo/bills/recurring' && method === 'GET') {
        return json(await listRecurringBills(env));
      }
      const rbActivateMatch = path.match(/^\/finance\/cfo\/bills\/recurring\/([^/]+)\/activate$/);
      if (rbActivateMatch && method === 'POST') {
        return json(await activateRecurringBill(env, rbActivateMatch[1]));
      }
      const rbDismissMatch = path.match(/^\/finance\/cfo\/bills\/recurring\/([^/]+)\/dismiss$/);
      if (rbDismissMatch && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        return json(await dismissRecurringBill(env, rbDismissMatch[1], body.reason));
      }

      // ── Email briefs (manual trigger for testing; crons will fire automatically) ─
      if (path === '/finance/cfo/email/daily-close' && method === 'POST') {
        const latest = await env.DB.prepare(
          `SELECT content FROM cfo_briefs WHERE type = 'daily_close' ORDER BY brief_date DESC LIMIT 1`
        ).first();
        if (!latest) return json({ error: 'no daily close yet' }, 404);
        return json(await sendDailyCloseEmail(env, JSON.parse(latest.content)));
      }
      if (path === '/finance/cfo/email/weekly-directive' && method === 'POST') {
        const latest = await env.DB.prepare(
          `SELECT content FROM cfo_briefs WHERE type = 'weekly_directive' ORDER BY brief_date DESC LIMIT 1`
        ).first();
        if (!latest) return json({ error: 'no directive yet' }, 404);
        return json(await sendWeeklyDirectiveEmail(env, JSON.parse(latest.content)));
      }

      // ── Irene package manifest (B8) ─────────────────────────────────────
      // Lists the download URLs to forward to Irene, no R2 required.
      if (path === '/finance/irene-package' && (method === 'GET' || method === 'POST')) {
        const yr = url.searchParams.get('year') || '2025';
        const base = 'https://pretzel-os.drew-f39.workers.dev';
        const manifest = {
          tax_year: yr,
          generated_at: new Date().toISOString(),
          company: 'Dangerous Pretzel Company LLC',
          prepared_for: 'Irene Bodenstab, IB Tax & Accounting PLLC',
          files: [
            { name: `reconciliation_memo_${yr}.html`, url: `${base}/finance/reconciliation/${yr}?format=html`, description: 'Executive reconciliation memo with narrative summary + all 6 reconciliation sections' },
            { name: `qbo_archive_${yr}.csv`,          url: `${base}/finance/export/qbo-archive.csv?year=${yr}`, description: 'Every QBO invoice, purchase, deposit, JE, payment, bill for the year' },
            { name: `mercury_transactions_${yr}.csv`, url: `${base}/finance/export/mercury-transactions.csv?year=${yr}`, description: 'Every Mercury checking/savings transaction for the year' },
            { name: 'chart_of_accounts.csv',         url: `${base}/finance/export/chart-of-accounts.csv`, description: 'Full 162-account chart with reclassifications flagged (Drew/Lindsay note → equity, etc.)' },
            { name: 'sales_tax_filings.csv',         url: `${base}/finance/export/sales-tax-filings.csv`, description: 'All Utah sales tax filings — Q1 2026 SPF + TC-62 filed Apr 22' },
          ],
          cover_email_draft: `Subject: 2025 Tax Prep Materials — Dangerous Pretzel Company LLC

Hi Irene,

Attached package has everything for the 2025 return:

1. Reconciliation memo (HTML) — narrative summary with 6 sections: revenue, COGS, payroll, fixed assets, loans/equity, suspect items. This is the quick-read doc.

2. QBO archive (CSV) — every 2025 transaction pulled from QBO. Source of truth for calendar-year 2025 revenue ($786,730 = Deposits $764,885 retail + Invoices $21,845 wholesale).

3. Mercury transactions (CSV) — bank-side cross-check. 1,266 transactions, $801,255 inflow / $857,757 outflow. Use for COGS validation and for catching anything that bypassed QBO.

4. Chart of accounts (CSV) — reclassifications flagged. Key item: Drew/Lindsay $770,975 note is marked for equity treatment per your 2024 return.

5. Sales tax filings (CSV) — Q1 2026 Utah (SPF $656.60 + TC-62 $7,184.72) filed Apr 22.

Key items needing your judgment:
• $46,869 Payroll Payable balance per QBO snapshot — our audit shows net ~$4,255 imbalance by year-end, suggesting the snapshot was stale
• $67,124 in clearing accounts needs aging analysis
• $4,698 Ask My Accountant entries need category resolution
• Q4 2025 sales tax (~$10K) likely unfiled — please check

Let me know what else you need.

Drew`,
          notes: [
            'CSV files are regenerated live on each download — always reflect current D1 state.',
            'R2-backed ZIP bundling is not yet wired. For now, save each file individually from the URLs above.',
            'To add AI-generated narrative prose to the reconciliation memo, append &ai=1 to the memo URL.',
          ],
        };
        return json(manifest);
      }

      if (path === '/finance/sales-tax/schedule-year' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const year = body.year || new Date().getFullYear();
        return await scheduleYear(env, year);
      }

      if (path === '/finance/resale-cert/request' && method === 'POST') {
        const body = await request.json();
        return await resaleCertRequest(env, body);
      }

      return json({ error: 'Not found', path }, 404);
    } catch (err) {
      console.error('[finance-worker]', err.message, err.stack?.slice(0, 400));
      return json({ error: err.message }, 500);
    }
  },
};

// ── Exported cron-callable wrappers ──────────────────────────────────────
// These let router.js invoke the finance cron jobs via trackedRun.

export async function runFinanceMonthlyClose(env) {
  return await runMonthlyClose(env);  // defaults to prior month
}

export async function runFinanceWeeklyDirective(env) {
  const payload = await runWeeklyDirective(env, { ai: true });
  // Tier 4e — email is fire-and-forget but failures now log to console + return
  // flag so caller can see whether Drew got the weekly directive email. Previous
  // empty catch meant "Gmail token expired" wiped the directive silently.
  try {
    await sendWeeklyDirectiveEmail(env, payload);
    payload._email_sent = true;
  } catch (err) {
    console.error('[runFinanceWeeklyDirective] sendWeeklyDirectiveEmail failed:', err.message, err.stack?.slice(0, 200));
    payload._email_sent = false;
    payload._email_error = err.message;
  }
  return payload;
}

export async function runFinanceDailyRecon(env) {
  return await runDailyReconciliation(env);
}

// ── Exported daily close (cron entry point — C-6) ──────────────────────────
// Runs the full daily pipeline. Called from:
//   - POST /finance/cfo/daily-close (Drew manual trigger)
//   - router.js cron at 7am MT / 13:00 UTC
// Each step is isolated in try/catch so a single failure doesn't block the rest.
export async function runDailyClose(env) {
  const started = Date.now();
  const steps = {};

  // Phase 5 reset Apr 30 2026: capture read-only state at start so we can
  // surface "skipped due to read-only" loud and clear in the email subject.
  const readOnlyAtStart = (await env.KV.get('FINANCE_READ_ONLY')) === '1';
  const readOnlyReason = readOnlyAtStart ? (await env.KV.get('FINANCE_READ_ONLY_REASON')) : null;

  try {
    // CRITICAL: refresh ACCOUNT BALANCES before transactions. Without this the
    // mercury_accounts.current_balance cache stays static (transactions sync
    // is a separate Mercury API endpoint and does NOT touch balances). This
    // was the bug that left cash showing $16K when reality was $38K — found
    // Apr 30 when Drew showed his Mercury app screenshot.
    const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const accountSync = await mercurySyncAccounts(env).catch(e => ({ error: e.message }));
    const txnSync = await mercurySyncTransactions(env, since, until).catch(e => ({ error: e.message }));
    steps.mercury_sync = { accounts: accountSync, transactions: txnSync };
  } catch (err) {
    steps.mercury_sync = { error: err.message };
  }

  try {
    // skip_ai: false → Haiku catches long-tail counterparties that rules miss.
    // Cap limit to keep daily Haiku spend bounded (~$0.50/day at current scale).
    steps.categorize = await categorizeBatch(env, { limit: 500, skip_ai: false });
  } catch (err) {
    steps.categorize = { error: err.message };
  }

  try {
    steps.post_jes = await postJeBatch(env, { limit: 300, min_confidence: 0.90 });
  } catch (err) {
    steps.post_jes = { error: err.message };
  }

  // 3.5: Daily revenue sweep DISABLED (Phase 21V-audit-6 foundational fix).
  // The legacy sweep posted in wrong direction (DR Sales / CR Clearing) on
  // 2026-05-15 and corrupted FY2026 P&L. Revenue recognition is now handled by:
  //   - Phase 20D qbo_pnl_reconstruction (monthly QBO P&L truth)
  //   - Toast Sales Summary + Square POS reconstruction (per-batch)
  //   - RTR-6 POS-direct (when cutover flag is flipped)
  // Sweep cron remains disabled until/unless Drew explicitly re-enables.
  steps.revenue_sweep = { skipped: 'legacy_sweep_disabled', note: 'Phase 20D + statement reconstruction handle revenue. Re-enable only if RTR-6 cutover is intentionally NOT used.' };

  try {
    const forecast = await rebuildForecast(env, 30);
    steps.forecast = {
      ending_balance: forecast.summary.ending_balance,
      lowest_day: forecast.summary.lowest_day,
      goes_negative: forecast.summary.goes_negative,
      projected_net_change: forecast.summary.projected_net_change,
    };
  } catch (err) {
    steps.forecast = { error: err.message };
  }

  // Phase 5: outcome-based summary. The previous "ok" was true if no step
  // threw an error — but a daily close that posts 0 JEs and skips sweep is
  // a stuck state masquerading as success. Compute did_useful_work explicitly.
  const jesPosted = steps.post_jes?.posted || 0;
  const jesPostedDebit = steps.post_jes?.total_debit || 0;
  const sweepCount = steps.revenue_sweep?.swept_count || 0;
  const sweepTotal = steps.revenue_sweep?.total_swept || 0;
  const txnsCategorized = steps.categorize?.processed || 0;
  const newTxnsSynced = steps.mercury_sync?.transactions?.inserted || 0;

  const post_jes_skipped_read_only = (steps.post_jes?.skip_reasons?.read_only_mode || 0) > 0;
  const sweep_skipped_read_only = steps.revenue_sweep?.skipped === 'read_only_mode';
  const did_useful_work = jesPosted > 0 || sweepCount > 0;

  const duration_ms = Date.now() - started;
  const result = {
    ok: Object.values(steps).every(s => !s.error),
    close_date: new Date().toISOString().slice(0, 10),
    duration_ms,
    steps,
    // Phase 5: outcome metadata for email subject + audit trail
    outcome: {
      did_useful_work,
      jes_posted: jesPosted,
      jes_posted_debit: jesPostedDebit,
      sweep_count: sweepCount,
      sweep_total: sweepTotal,
      txns_categorized: txnsCategorized,
      new_txns_synced: newTxnsSynced,
      read_only_at_start: readOnlyAtStart,
      read_only_reason: readOnlyReason,
      blocked_by_read_only: readOnlyAtStart && (post_jes_skipped_read_only || sweep_skipped_read_only),
    },
  };

  // Send daily close email — Tier 4e: log failures instead of silent swallow.
  try {
    await sendDailyCloseEmail(env, result);
    result._email_sent = true;
  } catch (err) {
    console.error('[daily-close] sendDailyCloseEmail failed:', err.message, err.stack?.slice(0, 200));
    result._email_sent = false;
    result._email_error = err.message;
  }

  await env.DB.prepare(`
    INSERT INTO cfo_briefs (id, brief_date, type, content)
    VALUES (?, date('now'), 'daily_close', ?)
    ON CONFLICT(brief_date, type) DO UPDATE SET content = excluded.content
  `).bind(crypto.randomUUID(), JSON.stringify(result)).run().catch(() => {});

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'cfo_daily_close', 'cfo_briefs', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), result.close_date,
    `Daily close ${result.close_date}: ${result.ok ? 'SUCCESS' : 'PARTIAL FAILURE'} in ${duration_ms}ms`,
    JSON.stringify(result)
  ).run().catch(() => {});

  return result;
}
