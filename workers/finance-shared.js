// workers/finance-shared.js
// Small helpers used across multiple finance modules.

// ── Read-only mode guard (3.11) ──────────────────────────────────────────
// Returns true if the FINANCE_READ_ONLY flag is tripped in KV. When tripped,
// every mutation path that posts journal entries must short-circuit and
// return { skipped: 'read_only_mode' } instead of writing.
//
// Flag is set by:
//   1. Drew manually via POST /finance/cfo/read-only -d {active:true}
//   2. Daily reconciliation auto-trip when Mercury-vs-books variance > $50
//      for 2 consecutive days (runDailyReconciliation in finance-cfo-tools.js)
export async function isReadOnly(env) {
  try {
    const v = await env.KV.get('FINANCE_READ_ONLY');
    return v === '1';
  } catch {
    return false;
  }
}

// Shorthand for the "skipped because read-only" response shape that all
// mutation paths return. Keeping this consistent makes the orchestrator's
// daily-close summary self-documenting.
export function readOnlySkip(opts = {}) {
  return {
    skipped: 'read_only_mode',
    note: 'FINANCE_READ_ONLY flag active — daily reconciliation found Mercury-vs-books variance > $50 for 2 consecutive days OR Drew manually enabled read-only mode. No journal entries posted.',
    ...opts,
  };
}

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Canonical financial helpers ──────────────────────────────────────────
// Every other report (Monday Digest, CFO Pulse, chat dashboard, etc.) MUST
// read cash/runway/revenue from these helpers — not from QBO and not from
// `financial_directives`. These functions are the single source of truth.
// The Mercury feed disconnected from QBO ~60 days ago, so any QBO-derived
// cash number is stale; only `mercury_accounts.current_balance` is live.

// Refresh-on-read TTL. If mercury_accounts.last_synced_at is older than this,
// we call Mercury API inline before returning. Cron is now a warmer, not the
// only path to fresh data. (Reset plan Apr 30, 2026 — Phase 2.)
const CASH_ON_HAND_TTL_SECONDS = 300; // 5 minutes

// Canonical cash on hand — sum of live Mercury account balances.
//
// Returns:
//   { total, breakdown, source, as_of, age_seconds, refreshed_inline }
//
// `as_of` is the actual `last_synced_at` of the underlying Mercury data
// (NOT the current wall clock — that was a bug). `age_seconds` makes
// freshness machine-checkable without timestamp parsing.
export async function getCanonicalCashOnHand(env) {
  // First read: what's in the cache + how old is it?
  const initial = await env.DB.prepare(`
    SELECT ROUND(SUM(current_balance), 2) as total,
           MAX(last_synced_at) as last_sync
    FROM mercury_accounts WHERE is_active = 1
  `).first();

  let refreshed_inline = false;
  let lastSync = initial?.last_sync ? new Date(initial.last_sync.replace(' ', 'T') + 'Z') : null;
  const now = new Date();
  const ageSec = lastSync ? Math.round((now - lastSync) / 1000) : Infinity;

  // Inline refresh if stale OR if we have no data at all.
  // Wrapped in try/catch — if Mercury API hiccups we fall back to the cached
  // value rather than 500'ing every consumer.
  if (ageSec > CASH_ON_HAND_TTL_SECONDS) {
    try {
      const { syncAccountsToD1 } = await import('./mercury-client.js');
      await syncAccountsToD1(env);
      refreshed_inline = true;
    } catch (err) {
      console.error('[finance-shared] inline mercury refresh failed:', err.message);
      // Continue with stale cache — better than a hard error
    }
  }

  // Re-read after potential refresh
  const row = await env.DB.prepare(`
    SELECT ROUND(SUM(current_balance), 2) as total,
           MAX(last_synced_at) as last_sync
    FROM mercury_accounts WHERE is_active = 1
  `).first();
  const { results: breakdown } = await env.DB.prepare(`
    SELECT account_name, account_type,
           ROUND(current_balance, 2) as balance,
           last_synced_at
    FROM mercury_accounts WHERE is_active = 1
    ORDER BY current_balance DESC
  `).all();

  const finalLastSync = row?.last_sync ? new Date(row.last_sync.replace(' ', 'T') + 'Z') : null;
  const finalAgeSec = finalLastSync ? Math.round((now - finalLastSync) / 1000) : null;

  return {
    total: r2(row?.total || 0),
    breakdown: breakdown || [],
    source: 'mercury_accounts.current_balance',
    as_of: finalLastSync ? finalLastSync.toISOString() : null,
    age_seconds: finalAgeSec,
    refreshed_inline,
    ttl_seconds: CASH_ON_HAND_TTL_SECONDS,
    is_fresh: finalAgeSec != null && finalAgeSec <= CASH_ON_HAND_TTL_SECONDS,
  };
}

// Canonical weekly burn — average expense outflow over last 30 days.
// Prefers posted JEs (most accurate); falls back to Mercury outflows when
// the GL is sparse (which we know it is — see Tier 5 audit findings).
export async function getCanonicalWeeklyBurn(env) {
  const fromGl = await env.DB.prepare(`
    SELECT ROUND(SUM(l.debit - l.credit), 2) as gl_burn
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND c.account_type IN ('expense', 'cogs', 'other_expense')
      AND j.entry_date >= date('now', '-30 days')
  `).first();
  const glBurn30 = r2(fromGl?.gl_burn || 0);

  // Mercury fallback: outflows over last 30d, excluding interbank transfers
  const merc = await env.DB.prepare(`
    SELECT ROUND(SUM(ABS(amount)), 2) as out
    FROM mercury_transactions
    WHERE amount < 0
      AND txn_date >= date('now', '-30 days')
      AND counterparty_name IS NOT NULL
      AND LOWER(counterparty_name) NOT LIKE '%mercury%'
      AND LOWER(counterparty_name) NOT LIKE '%wells fargo%'
      AND LOWER(counterparty_name) NOT LIKE '%chase%'
      AND LOWER(counterparty_name) NOT LIKE '%bank of america%'
  `).first();
  const mercOut30 = r2(merc?.out || 0);

  // Take the larger of (GL burn, 70% of Mercury outflows) — Mercury floor
  // protects against the well-known under-reporting from unposted JEs.
  // The 0.7 multiplier discounts borderline interbank/transfer noise.
  const burn30 = Math.max(glBurn30, mercOut30 * 0.7);
  const weeklyBurn = r2(burn30 / 4.3);

  return {
    weekly_burn: weeklyBurn,
    monthly_burn: burn30,
    gl_burn_30d: glBurn30,
    mercury_outflows_30d: mercOut30,
    source: glBurn30 >= mercOut30 * 0.5 ? 'gl' : 'mercury_fallback',
    note: glBurn30 >= mercOut30 * 0.5
      ? 'GL has enough posted expenses to be the source of truth'
      : 'GL is sparse — using Mercury outflows × 0.7 as floor (review queue clearance will fix this)',
  };
}

// ── Canonical RECURRING weekly burn (Session 16a, May 14 2026) ──────────────
// Splits expenses by chart_of_accounts.expense_class so one-time events
// (quarterly sales tax, IRS payments, capex) don't inflate the runway burn.
//
// This is the number that should DRIVE runway display. The old getCanonicalWeeklyBurn
// stays for "what did we actually spend last month" totals.
//
// Returns:
//   {
//     weekly_burn:    recurring + variable, ÷ 4.3
//     monthly_recurring, monthly_variable, monthly_one_time, monthly_capex
//     one_time_excluded: [{account_name, amount}]   — for transparency
//     source: 'gl_with_classification',
//   }
export async function getCanonicalRecurringBurn(env) {
  const { results } = await env.DB.prepare(`
    SELECT COALESCE(c.expense_class, 'variable') as expense_class,
           c.account_name,
           ROUND(SUM(l.debit - l.credit), 2) as amount
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND c.account_type IN ('expense', 'cogs', 'other_expense')
      AND j.entry_date >= date('now', '-30 days')
    GROUP BY c.id
  `).all();

  const buckets = { recurring: 0, variable: 0, one_time: 0, capex: 0 };
  const one_time_excluded = [];
  for (const r of (results || [])) {
    const cls = r.expense_class;
    if (!(cls in buckets)) continue;
    buckets[cls] += r.amount || 0;
    if (cls === 'one_time' && Math.abs(r.amount) > 50) {
      one_time_excluded.push({ account_name: r.account_name, amount: r2(r.amount) });
    }
  }
  const monthly_recurring_burn = r2(buckets.recurring + buckets.variable);
  const weekly_burn = r2(monthly_recurring_burn / 4.3);
  return {
    weekly_burn,
    monthly_recurring_burn,
    monthly_recurring: r2(buckets.recurring),
    monthly_variable: r2(buckets.variable),
    monthly_one_time_excluded: r2(buckets.one_time),
    monthly_capex_excluded: r2(buckets.capex),
    one_time_excluded: one_time_excluded.sort((a,b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 10),
    source: 'journal_entry_lines × chart_of_accounts.expense_class',
    note: 'Recurring + variable only. One-time (sales tax catch-up, IRS) and capex excluded. This is the number that drives runway.',
  };
}

// Canonical runway — cash / weekly burn, with caps so Drew never sees "999".
// Session 16a (May 14 2026): runway now uses RECURRING burn by default. The
// old getCanonicalWeeklyBurn (total 30d) remains for "what did we actually spend"
// reporting, but the runway display should reflect ongoing-operations burn.
export async function getCanonicalRunway(env, cashOverride = null) {
  const cash = cashOverride != null ? cashOverride : (await getCanonicalCashOnHand(env)).total;
  // Session 16a (May 14 2026): use RECURRING burn for runway, not total 30d outflows.
  // Q1 sales tax catch-up + IRS payments inflate the total — runway should
  // reflect "what does it cost to run the business in a steady state."
  const recurringBurn = await getCanonicalRecurringBurn(env);
  const totalBurn = await getCanonicalWeeklyBurn(env);
  const burn = recurringBurn.weekly_burn;

  if (burn <= 0) {
    return {
      weeks: null,
      display: 'no burn measured',
      warning: 'cannot compute runway — recurring weekly burn is zero',
      cash,
      weekly_burn: burn,
    };
  }
  const weeksRaw = cash / burn;
  const weeks = r2(weeksRaw);
  const display = weeksRaw < 0
    ? 'NEGATIVE — burning cash faster than inflow'
    : weeksRaw > 52 ? '> 1 year'
    : weeksRaw > 12 ? `${Math.round(weeksRaw)} weeks`
    : weeksRaw > 4 ? `${weeksRaw.toFixed(1)} weeks (TIGHT)`
    : `${weeksRaw.toFixed(1)} weeks (CRITICAL)`;
  return {
    weeks,
    display,
    cash,
    weekly_burn: burn,
    burn_source: 'recurring (16a)',
    weekly_burn_total: totalBurn.weekly_burn,
    one_time_excluded_30d: recurringBurn.monthly_one_time_excluded,
    one_time_top_excluded: recurringBurn.one_time_excluded.slice(0, 3),
    note: recurringBurn.monthly_one_time_excluded > 0
      ? `Recurring burn = $${burn.toFixed(0)}/wk. Excludes $${recurringBurn.monthly_one_time_excluded.toFixed(0)} one-time in last 30d (top: ${recurringBurn.one_time_excluded.slice(0,2).map(x => x.account_name).join(', ')}).`
      : 'No one-time expenses to exclude in last 30d.',
  };
}

// Canonical weekly revenue split — by channel.
//
// Recognition rule (CRITICAL — only count revenue that's actually been paid):
//   Square orders count IF (state='COMPLETED') OR (state='OPEN' AND tenders exists)
//   Excludes: DRAFT (never finalized), CANCELED (rejected), OPEN-with-no-tender
//   (Square Invoices that have been sent but not yet paid).
//
// Channels:
//   - Retail Direct: Square POS in-person + Square Kiosk/Web orders. Money
//     Pretzel got directly from end customers via own infra.
//   - Marketplace: DoorDash/UberEats/Grubhub orders via Square's marketplace
//     facilitator. NOT in retail because (a) marketplace fees not deducted,
//     (b) marketplace net also lands in Mercury — would double-count.
//   - Wholesale: QBO invoices/wholesale orders.
//   - Catering: catering_orders confirmed + any toast_catering tagged.
//
// Toast was retired ~Apr 2026 (no longer used as POS).
export async function getCanonicalWeeklyRevenue(env, daysBack = 7) {
  // Session 19a REVERTED (May 14 2026) — Drew's directive: no patches, ever.
  // The Session 19 source-aware date-bound filter was a display-time patch
  // that papered over the real architectural issue (display reading from
  // `orders` instead of GL). Session 20 moves display to GL-as-truth.
  //
  // This original Square-shaped filter remains for orders helpers that are
  // legitimately audit-only (not used for revenue display).
  //
  // Square paid-state predicate. tenders is a JSON array; `tenders IS NOT NULL`
  // AND `!= '[]'` covers both "has tender array" and "explicit COMPLETED state
  // without an array".
  const PAID_STATE_CLAUSE = `
    (json_extract(raw_payload, '$.state') = 'COMPLETED'
     OR (json_extract(raw_payload, '$.state') = 'OPEN'
         AND json_extract(raw_payload, '$.tenders') IS NOT NULL
         AND json_extract(raw_payload, '$.tenders') != '[]'))
  `;
  // Square Catering items show up via Square Invoices / DPC Website with line
  // item names prefixed "Catering:" — these belong in the catering channel,
  // NOT retail. (Verified Apr 27 2026: Cassie NA $4002 Catering: Salty Pretzel
  // Box × 20, Chloe Wallin $110 Catering: Salty Bomb Tray, etc.)
  const NOT_CATERING_ITEM_CLAUSE = `
    (json_extract(raw_payload, '$.line_items[0].name') IS NULL
     OR json_extract(raw_payload, '$.line_items[0].name') NOT LIKE 'Catering:%')
  `;

  const [retailSquare, retailDelivery, marketplaceVia, unpaid, wholesale, catering, gl] = await Promise.all([
    // In-person Square POS — only paid/completed AND not catering-tagged
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 2) as r, COUNT(*) as n
      FROM orders
      WHERE source IN ('toast','toast_live','toast_tsv','toast_csv','square')
        AND order_date >= date('now', '-' || ? || ' days')
        AND ${PAID_STATE_CLAUSE}
        AND ${NOT_CATERING_ITEM_CLAUSE}
    `).bind(daysBack).first(),
    // Square_delivery DIRECT only — Kiosk/Web/null AND paid/completed AND not catering
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 2) as r, COUNT(*) as n
      FROM orders
      WHERE source = 'square_delivery'
        AND order_date >= date('now', '-' || ? || ' days')
        AND (json_extract(raw_payload, '$.source.name') IS NULL
             OR json_extract(raw_payload, '$.source.name') NOT IN ('DoorDash','Uber Eats','Grubhub','Postmates'))
        AND ${PAID_STATE_CLAUSE}
        AND ${NOT_CATERING_ITEM_CLAUSE}
    `).bind(daysBack).first(),
    // Marketplace via Square — only paid (marketplace orders always have tender)
    env.DB.prepare(`
      SELECT json_extract(raw_payload, '$.source.name') as platform,
             ROUND(SUM(gross_revenue), 2) as r,
             COUNT(*) as n
      FROM orders
      WHERE source = 'square_delivery'
        AND order_date >= date('now', '-' || ? || ' days')
        AND json_extract(raw_payload, '$.source.name') IN ('DoorDash','Uber Eats','Grubhub','Postmates')
        AND ${PAID_STATE_CLAUSE}
      GROUP BY platform
    `).bind(daysBack).all(),
    // SURFACE the unpaid pipeline so Drew sees what's pending
    env.DB.prepare(`
      SELECT json_extract(raw_payload, '$.state') as state,
             json_extract(raw_payload, '$.source.name') as src_name,
             COUNT(*) as n,
             ROUND(SUM(gross_revenue), 2) as r
      FROM orders
      WHERE source IN ('square','square_delivery')
        AND order_date >= date('now', '-' || ? || ' days')
        AND NOT (${PAID_STATE_CLAUSE})
        AND json_extract(raw_payload, '$.state') != 'CANCELED'
      GROUP BY state, src_name
      ORDER BY r DESC
    `).bind(daysBack).all(),
    // Wholesale: QBO invoices/wholesale (exclude voided/pending estimates)
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 2) as r, COUNT(*) as n
      FROM orders
      WHERE source IN ('qbo_wholesale','qbo_invoice','qbo_estimate')
        AND status NOT IN ('voided','estimate')
        AND order_date >= date('now', '-' || ? || ' days')
    `).bind(daysBack).first(),
    // Catering: toast_catering + catering_orders (confirmed) + Square orders
    // tagged with "Catering:" line items that are PAID (the unpaid catering
    // invoices stay in unpaid_pipeline below for explicit visibility).
    env.DB.prepare(`
      SELECT ROUND(
        COALESCE((SELECT SUM(gross_revenue) FROM orders
                   WHERE source='toast_catering'
                     AND order_date >= date('now', '-' || ?1 || ' days')), 0)
      + COALESCE((SELECT SUM(order_value) FROM catering_orders
                   WHERE status='confirmed'
                     AND event_date >= date('now', '-' || ?1 || ' days')), 0)
      + COALESCE((SELECT SUM(gross_revenue) FROM orders
                   WHERE source IN ('square','square_delivery')
                     AND order_date >= date('now', '-' || ?1 || ' days')
                     AND json_extract(raw_payload, '$.line_items[0].name') LIKE 'Catering:%'
                     AND (json_extract(raw_payload, '$.state') = 'COMPLETED'
                          OR (json_extract(raw_payload, '$.state') = 'OPEN'
                              AND json_extract(raw_payload, '$.tenders') IS NOT NULL
                              AND json_extract(raw_payload, '$.tenders') != '[]'))), 0), 2) as r,
        COALESCE((SELECT COUNT(*) FROM orders
                   WHERE source='toast_catering'
                     AND order_date >= date('now', '-' || ?1 || ' days')), 0)
      + COALESCE((SELECT COUNT(*) FROM catering_orders
                   WHERE status='confirmed'
                     AND event_date >= date('now', '-' || ?1 || ' days')), 0)
      + COALESCE((SELECT COUNT(*) FROM orders
                   WHERE source IN ('square','square_delivery')
                     AND order_date >= date('now', '-' || ?1 || ' days')
                     AND json_extract(raw_payload, '$.line_items[0].name') LIKE 'Catering:%'
                     AND (json_extract(raw_payload, '$.state') = 'COMPLETED'
                          OR (json_extract(raw_payload, '$.state') = 'OPEN'
                              AND json_extract(raw_payload, '$.tenders') IS NOT NULL
                              AND json_extract(raw_payload, '$.tenders') != '[]'))), 0) as n
    `).bind(daysBack).first(),
    // GL cross-check
    env.DB.prepare(`
      SELECT ROUND(SUM(l.credit - l.debit), 2) as gl_revenue
      FROM journal_entry_lines l
      JOIN journal_entries j ON j.id = l.journal_entry_id
      JOIN chart_of_accounts c ON c.id = l.account_id
      WHERE j.status = 'posted'
        AND c.account_type = 'revenue'
        AND j.entry_date >= date('now', '-' || ? || ' days')
    `).bind(daysBack).first(),
  ]);

  // Retail = in-person Square + direct delivery (Kiosk/Web)
  const retailSquareRev = r2(retailSquare?.r || 0);
  const retailDeliveryRev = r2(retailDelivery?.r || 0);
  const retailRev = r2(retailSquareRev + retailDeliveryRev);
  const retailOrders = (retailSquare?.n || 0) + (retailDelivery?.n || 0);

  // Marketplace = grouped by platform (separate channel)
  const marketplacePlatforms = (marketplaceVia?.results || []).map(p => ({
    platform: p.platform || 'unknown',
    revenue: r2(p.r || 0),
    orders: p.n || 0,
  }));
  const marketplaceTotal = r2(marketplacePlatforms.reduce((s, p) => s + p.revenue, 0));
  const marketplaceOrders = marketplacePlatforms.reduce((s, p) => s + p.orders, 0);

  const wholesaleRev = r2(wholesale?.r || 0);
  const cateringRev = r2(catering?.r || 0);
  // Total = retail (direct) + wholesale + catering. Marketplace is shown
  // separately and NOT added to total because it would double-count with
  // Mercury marketplace clearing inflows.
  const total = r2(retailRev + wholesaleRev + cateringRev);

  const warnings = [];
  const glRev = r2(gl?.gl_revenue || 0);
  if (glRev > 0 && Math.abs(glRev - total) / Math.max(glRev, total, 1) > 0.10) {
    warnings.push({
      severity: 'medium',
      code: 'gl_vs_orders_drift',
      message: `GL revenue ($${glRev}) differs from operational orders ($${total}) by >10% — sweep may be lagging.`,
    });
  }

  // Month-end batch invoicing detector — Drew typically batches QBO invoices
  // and dates them to month-end. Surface this so the "last 7 days" totals
  // are not misread as week-of-actual-activity. Verified Apr 27 2026 against
  // QBO API: invoices dated 2026-04-30 are real Drew-created month-end batch.
  const today = new Date().toISOString().split('T')[0];
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0];
  const monthEndBatch = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(gross_revenue), 2) as r
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice','qbo_estimate')
      AND order_date = ?
      AND order_date > ?
      AND order_date >= date('now', '-' || ? || ' days')
  `).bind(monthEnd, today, daysBack).first();
  if ((monthEndBatch?.n || 0) > 0) {
    warnings.push({
      severity: 'low',
      code: 'month_end_batch_invoicing',
      message: `${monthEndBatch.n} wholesale invoices ($${monthEndBatch.r || 0}) are dated ${monthEnd} (month-end batch). Real-week activity might be smaller — these typically reflect work done earlier in the month, batched + dated forward.`,
    });
  }
  // Genuinely future-dated NON-month-end (this would be a real anomaly)
  const anomalousFuture = await env.DB.prepare(`
    SELECT COUNT(*) as n, ROUND(SUM(gross_revenue), 2) as r
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice','qbo_estimate')
      AND order_date > ?
      AND order_date != ?
      AND order_date >= date('now', '-' || ? || ' days')
  `).bind(today, monthEnd, daysBack).first();
  if ((anomalousFuture?.n || 0) > 0) {
    warnings.push({
      severity: 'high',
      code: 'anomalous_future_dated',
      message: `${anomalousFuture.n} wholesale orders future-dated to neither today nor month-end ($${anomalousFuture.r || 0}) — possible sync bug.`,
    });
  }

  // Unpaid pipeline (informational — NOT counted in total)
  const unpaidRows = unpaid?.results || [];
  const unpaidTotal = r2(unpaidRows.reduce((s, u) => s + (u.r || 0), 0));
  const unpaidByState = {};
  for (const u of unpaidRows) {
    const k = u.state || 'unknown';
    if (!unpaidByState[k]) unpaidByState[k] = { revenue: 0, orders: 0, sources: [] };
    unpaidByState[k].revenue = r2(unpaidByState[k].revenue + (u.r || 0));
    unpaidByState[k].orders += u.n || 0;
    unpaidByState[k].sources.push({ src: u.src_name || '(null)', revenue: u.r || 0, orders: u.n || 0 });
  }

  // Itemize unpaid CATERING orders specifically — these are real money waiting
  // and Drew can chase them (via the bulk-review UI or Gmail draft flow).
  const { results: unpaidCateringRows } = await env.DB.prepare(`
    SELECT id, order_date, gross_revenue,
           json_extract(raw_payload, '$.state') as state,
           json_extract(raw_payload, '$.source.name') as src_name,
           json_extract(raw_payload, '$.line_items[0].name') as item_name,
           customer_name, customer_email, customer_phone
    FROM orders
    WHERE source IN ('square','square_delivery')
      AND order_date >= date('now', '-' || ? || ' days')
      AND json_extract(raw_payload, '$.line_items[0].name') LIKE 'Catering:%'
      AND NOT (${PAID_STATE_CLAUSE})
      AND json_extract(raw_payload, '$.state') != 'CANCELED'
    ORDER BY gross_revenue DESC
  `).bind(daysBack).all();

  if (unpaidTotal > 100) {
    warnings.push({
      severity: 'low',
      code: 'unpaid_square_pipeline',
      message: `$${unpaidTotal} in Square orders are sent-but-unpaid (drafts, open invoices) — NOT counted in retail until tendered.`,
    });
  }
  if ((unpaidCateringRows || []).length > 0) {
    const cateringUnpaidSum = r2((unpaidCateringRows || []).reduce((s, r) => s + (r.gross_revenue || 0), 0));
    warnings.push({
      severity: 'medium',
      code: 'unpaid_catering_invoices',
      message: `${unpaidCateringRows.length} unpaid catering orders totaling $${cateringUnpaidSum} — see unpaid_pipeline.catering_detail for follow-up list.`,
    });
  }

  return {
    period_days: daysBack,
    retail: {
      revenue: retailRev,
      orders: retailOrders,
      breakdown: {
        in_person_square: { revenue: retailSquareRev, orders: retailSquare?.n || 0 },
        direct_delivery: { revenue: retailDeliveryRev, orders: retailDelivery?.n || 0, note: 'Kiosk + Web direct (excludes DoorDash/UberEats/Grubhub via Square)' },
      },
      note: 'Only paid/completed orders — sent-but-unpaid Square Invoices excluded (see unpaid_pipeline).',
    },
    marketplace: {
      revenue: marketplaceTotal,
      orders: marketplaceOrders,
      platforms: marketplacePlatforms,
      note: 'Gross via Square marketplace facilitator. NOT included in `total` because it double-counts with Mercury marketplace deposits.',
    },
    wholesale: { revenue: wholesaleRev, orders: wholesale?.n || 0 },
    catering: { revenue: cateringRev, bookings: catering?.n || 0 },
    unpaid_pipeline: {
      total: unpaidTotal,
      by_state: unpaidByState,
      catering_detail: (unpaidCateringRows || []).map(r => ({
        order_date: (r.order_date || '').slice(0, 10),
        amount: r.gross_revenue,
        state: r.state,
        source: r.src_name || '',
        item: r.item_name || '',
        customer: r.customer_name || '',
        email: r.customer_email || '',
        phone: r.customer_phone || '',
      })),
      note: 'Sent invoices + drafts. Not in revenue until tendered.',
    },
    total,
    gl_revenue_cross_check: glRev,
    warnings,
    source: 'orders + catering_orders (operational); paid-state filtered; cross-checked vs GL revenue accounts',
  };
}

// ── Canonical revenue for an arbitrary date range (RTR-2) ────────────────
//
// Same paid-state + channel-split logic as getCanonicalWeeklyRevenue, but
// takes [start, end] dates instead of a "last N days" window. This is the
// helper monthly-pl, trends, and monthly-close all use AFTER the RTR fix —
// so revenue display reads the SALE EVENT (orders) not the SWEEP JE (GL).
//
// Why this matters (Revenue Truth Reset diagnosis, May 13 2026):
//   The legacy code computed revenue by SUMming JE lines with
//   account_type='revenue'. Those JEs are written by the daily sweep
//   (Clearing → Revenue). Sweep date != sale date. Result: March 2026
//   showed $0 revenue in the closed brief because the sweep hadn't run
//   for March's clearing balance when monthly-close ran on April 1. Late
//   sweeps on April 30 dumped both March's residual AND April's clearing
//   so April showed $79K vs trailing avg $51K. RTR-2 fixes display by
//   reading orders at the sale date.
//
// The GL is NOT canonical for revenue display. It remains correct for
// the books (debits=credits) but its TIMING is determined by sweep.
//
// Inputs:
//   startDate, endDate — 'YYYY-MM-DD' strings; INCLUSIVE on both ends
//
// Output shape: same totals as getCanonicalWeeklyRevenue (retail,
// wholesale, catering, marketplace, unpaid_pipeline, gl_revenue_cross_check)
// but scoped to the period.
// ── Session 20G (May 14 2026) — GL revenue is THE source of truth ────────────
//
// After Session 20 reconstruction, the GL contains:
//   - 2025-02 through 2026-02: QBO P&L bookkeeper truth (cash basis)
//   - 2026-03: Toast Sales Summary (Drew's official Toast export) + QBO Payments
//   - 2026-04-01 to 2026-04-13: Toast Sales Summary + QBO Payments
//   - 2026-04-14+: Square raw_payload (live API) + QBO Payments
//   - Mercury direct (TGTG quarterly): preserved as mercury_txn JEs
//
// Every revenue number in every display surface MUST read from this helper.
// `getOrdersRevenueForPeriod` (above) is now AUDIT ONLY — for drilling into
// the underlying POS data, NOT for revenue display.
export async function getGLRevenueForPeriod(env, startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`getGLRevenueForPeriod: dates must be YYYY-MM-DD (got ${startDate}, ${endDate})`);
  }

  // Session 26-B note: `getGLRevenueForPeriod` returns GROSS revenue —
  // excludes the new contra_revenue_marketplace accounts (Channel Adjustments)
  // so the total matches QBO bookkeeper truth ($522,889.89 for FY2025).
  // Net revenue (after marketplace contra) is computed inside the P&L statement
  // worker (`workers/finance-statements-pnl.js`) which surfaces both gross,
  // channel_adjustments, and net_revenue distinctly.
  // The existing contra_revenue_retail (Discounts/Comps/Refunds) STAYS in this
  // total because QBO bookkeeper treats it the same way.
  const { results } = await env.DB.prepare(`
    SELECT c.account_name,
           c.account_subtype,
           c.revenue_channel,
           ROUND(SUM(l.credit - l.debit), 2) as amount,
           COUNT(DISTINCT l.journal_entry_id) as je_count
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND j.source_type != 'fiscal_year_close'
      AND c.account_type = 'revenue'
      AND (c.revenue_channel IS NULL OR c.revenue_channel != 'contra_revenue_marketplace')
      AND j.entry_date >= ? AND j.entry_date <= ?
    GROUP BY c.id
    HAVING amount != 0
    ORDER BY amount DESC
  `).bind(startDate, endDate).all();

  const lines = results || [];
  const total = r2(lines.reduce((s, r) => s + (r.amount || 0), 0));

  // Categorize by channel for compatibility with old shape
  const findLine = (name) => lines.find(r => r.account_name === name)?.amount || 0;
  const findStartsWith = (prefix) => r2(lines.filter(r => r.account_name?.startsWith(prefix)).reduce((s, r) => s + r.amount, 0));

  const retail = r2(
    findLine('Sales:Food Income:Dine-In / Takeout') +
    findLine('Sales:Food Income:Delivery') +
    findLine('Sales:Food Income') // parent-direct (bookkeeper era)
  );
  const wholesale = findLine('Sales:Food Income:Wholesale');
  const catering = findLine('Sales:Food Income:Catering');
  const beverage = findStartsWith('Sales:Beverage Income');
  const apparel = findLine('Sales:Apparel Retail Sales');
  const tgtg = findLine('Too Good To Go');
  const services = r2(findLine('Services') + findLine('Service Fee Income'));
  const discounts = findLine('Discounts, Comps & Refunds'); // negative

  return {
    period_start: startDate,
    period_end: endDate,
    total,
    breakdown: {
      retail,
      wholesale,
      catering,
      beverage,
      apparel,
      tgtg,
      services,
      discounts,
    },
    lines,  // raw per-account
    source: 'general_ledger (Session 20 reconstruction)',
  };
}

export async function getOrdersRevenueForPeriod(env, startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`getOrdersRevenueForPeriod: dates must be YYYY-MM-DD (got ${startDate}, ${endDate})`);
  }

  // Session 19a REVERTED (May 14 2026) — Drew's directive: no patches, ever.
  // Reverted to the original Square-shaped filter. This helper is now
  // AUDIT-ONLY (Session 20 moves revenue display to GL-as-truth).
  const PAID_STATE_CLAUSE = `
    (json_extract(raw_payload, '$.state') = 'COMPLETED'
     OR (json_extract(raw_payload, '$.state') = 'OPEN'
         AND json_extract(raw_payload, '$.tenders') IS NOT NULL
         AND json_extract(raw_payload, '$.tenders') != '[]'))
  `;
  const NOT_CATERING_ITEM_CLAUSE = `
    (json_extract(raw_payload, '$.line_items[0].name') IS NULL
     OR json_extract(raw_payload, '$.line_items[0].name') NOT LIKE 'Catering:%')
  `;

  const [retailSquare, retailDelivery, marketplaceVia, wholesale, catering, gl] = await Promise.all([
    // In-person retail — Toast + Square POS, only paid + not catering
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 2) as r, COUNT(*) as n
      FROM orders
      WHERE source IN ('toast','toast_live','toast_tsv','toast_csv','square')
        AND order_date >= ? AND order_date <= ?
        AND ${PAID_STATE_CLAUSE}
        AND ${NOT_CATERING_ITEM_CLAUSE}
    `).bind(startDate, endDate).first(),
    // Square direct delivery (Kiosk/Web) — paid + not catering, exclude marketplace facilitator
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 2) as r, COUNT(*) as n
      FROM orders
      WHERE source = 'square_delivery'
        AND order_date >= ? AND order_date <= ?
        AND (json_extract(raw_payload, '$.source.name') IS NULL
             OR json_extract(raw_payload, '$.source.name') NOT IN ('DoorDash','Uber Eats','Grubhub','Postmates'))
        AND ${PAID_STATE_CLAUSE}
        AND ${NOT_CATERING_ITEM_CLAUSE}
    `).bind(startDate, endDate).first(),
    // Marketplace platforms via Square — paid (marketplace always tendered)
    env.DB.prepare(`
      SELECT json_extract(raw_payload, '$.source.name') as platform,
             ROUND(SUM(gross_revenue), 2) as r,
             COUNT(*) as n
      FROM orders
      WHERE source = 'square_delivery'
        AND order_date >= ? AND order_date <= ?
        AND json_extract(raw_payload, '$.source.name') IN ('DoorDash','Uber Eats','Grubhub','Postmates')
        AND ${PAID_STATE_CLAUSE}
      GROUP BY platform
    `).bind(startDate, endDate).all(),
    // Wholesale via QBO
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 2) as r, COUNT(*) as n
      FROM orders
      WHERE source IN ('qbo_wholesale','qbo_invoice','qbo_estimate')
        AND status NOT IN ('voided','estimate')
        AND order_date >= ? AND order_date <= ?
    `).bind(startDate, endDate).first(),
    // Catering = toast_catering + catering_orders (confirmed) + Square "Catering:" line items that are PAID
    env.DB.prepare(`
      SELECT ROUND(
        COALESCE((SELECT SUM(gross_revenue) FROM orders
                   WHERE source='toast_catering'
                     AND order_date >= ?1 AND order_date <= ?2), 0)
      + COALESCE((SELECT SUM(order_value) FROM catering_orders
                   WHERE status='confirmed'
                     AND event_date >= ?1 AND event_date <= ?2), 0)
      + COALESCE((SELECT SUM(gross_revenue) FROM orders
                   WHERE source IN ('square','square_delivery')
                     AND order_date >= ?1 AND order_date <= ?2
                     AND json_extract(raw_payload, '$.line_items[0].name') LIKE 'Catering:%'
                     AND (json_extract(raw_payload, '$.state') = 'COMPLETED'
                          OR (json_extract(raw_payload, '$.state') = 'OPEN'
                              AND json_extract(raw_payload, '$.tenders') IS NOT NULL
                              AND json_extract(raw_payload, '$.tenders') != '[]'))), 0), 2) as r,
        COALESCE((SELECT COUNT(*) FROM orders
                   WHERE source='toast_catering'
                     AND order_date >= ?1 AND order_date <= ?2), 0)
      + COALESCE((SELECT COUNT(*) FROM catering_orders
                   WHERE status='confirmed'
                     AND event_date >= ?1 AND event_date <= ?2), 0)
      + COALESCE((SELECT COUNT(*) FROM orders
                   WHERE source IN ('square','square_delivery')
                     AND order_date >= ?1 AND order_date <= ?2
                     AND json_extract(raw_payload, '$.line_items[0].name') LIKE 'Catering:%'
                     AND (json_extract(raw_payload, '$.state') = 'COMPLETED'
                          OR (json_extract(raw_payload, '$.state') = 'OPEN'
                              AND json_extract(raw_payload, '$.tenders') IS NOT NULL
                              AND json_extract(raw_payload, '$.tenders') != '[]'))), 0) as n
    `).bind(startDate, endDate).first(),
    // GL cross-check (for transparency, NOT for display)
    env.DB.prepare(`
      SELECT ROUND(SUM(l.credit - l.debit), 2) as gl_revenue
      FROM journal_entry_lines l
      JOIN journal_entries j ON j.id = l.journal_entry_id
      JOIN chart_of_accounts c ON c.id = l.account_id
      WHERE j.status = 'posted'
        AND c.account_type = 'revenue'
        AND j.entry_date >= ? AND j.entry_date <= ?
    `).bind(startDate, endDate).first(),
  ]);

  const retailSquareRev = r2(retailSquare?.r || 0);
  const retailDeliveryRev = r2(retailDelivery?.r || 0);
  const retailRev = r2(retailSquareRev + retailDeliveryRev);
  const retailOrders = (retailSquare?.n || 0) + (retailDelivery?.n || 0);

  const marketplacePlatforms = (marketplaceVia?.results || []).map(p => ({
    platform: p.platform || 'unknown',
    revenue: r2(p.r || 0),
    orders: p.n || 0,
  }));
  const marketplaceTotal = r2(marketplacePlatforms.reduce((s, p) => s + p.revenue, 0));

  const wholesaleRev = r2(wholesale?.r || 0);
  const cateringRev = r2(catering?.r || 0);
  const total = r2(retailRev + wholesaleRev + cateringRev);
  const glRev = r2(gl?.gl_revenue || 0);

  return {
    period_start: startDate,
    period_end: endDate,
    total,
    retail: { revenue: retailRev, orders: retailOrders },
    wholesale: { revenue: wholesaleRev, orders: wholesale?.n || 0 },
    catering: { revenue: cateringRev, bookings: catering?.n || 0 },
    marketplace: {
      total: marketplaceTotal,
      platforms: marketplacePlatforms,
      note: 'Excluded from total — Mercury marketplace deposits would double-count.',
    },
    gl_revenue_cross_check: glRev,
    gl_orders_drift: r2(glRev - total),
    gl_orders_drift_pct: total > 0 ? Math.round(((glRev - total) / total) * 1000) / 10 : null,
    source: 'orders + catering_orders (audit-only after Session 20)',
  };
}
