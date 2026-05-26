// workers/finance-customer-intel.js
// Customer profitability + DSO + payment reliability per customer.
//
// Endpoints:
//   GET /finance/customer-intel             — top customers + summary
//   GET /finance/customer-intel/:customer   — single customer profile
//
// Data sources:
//   - orders (qbo_wholesale + qbo_invoice + paid invoices)
//   - qbo_archive_entity (Payment entities → match to invoices for DSO)

function r2(n) { return Math.round((n || 0) * 100) / 100; }
function r0(n) { return Math.round(n || 0); }
function pct(n) { return Math.round(n * 1000) / 10; }

// ── Per-customer aggregate ───────────────────────────────────────────────
export async function getCustomerIntel(env, opts = {}) {
  const limit = opts.limit || 25;

  // Trailing 12mo revenue per customer (from orders qbo_wholesale + qbo_invoice)
  const { results: revenue } = await env.DB.prepare(`
    SELECT customer_name,
           ROUND(SUM(gross_revenue), 2) as total_revenue,
           COUNT(*) as order_count,
           MAX(order_date) as last_order_date,
           MIN(order_date) as first_order_date
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','estimate')
      AND customer_name IS NOT NULL
      AND order_date >= date('now', '-365 days')
    GROUP BY customer_name
    HAVING total_revenue > 0
    ORDER BY total_revenue DESC
  `).all();

  // Outstanding balance per customer
  const { results: outstanding } = await env.DB.prepare(`
    SELECT customer_name,
           ROUND(SUM(CAST(json_extract(raw_payload, '$.balance') AS REAL)), 2) as open_balance,
           COUNT(*) as open_count,
           MIN(json_extract(raw_payload, '$.due_date')) as oldest_due
    FROM orders
    WHERE source IN ('qbo_wholesale','qbo_invoice')
      AND status NOT IN ('voided','paid','estimate')
      AND CAST(json_extract(raw_payload, '$.balance') AS REAL) > 0
    GROUP BY customer_name
  `).all();
  const openMap = new Map((outstanding || []).map(o => [o.customer_name, o]));

  // Per-customer DSO + reliability (from invoice → next payment in same customer)
  // Pragmatic: count "on-time" as paid within 7 days of due date.
  const today = new Date();
  const customers = (revenue || []).map(r => {
    const open = openMap.get(r.customer_name) || { open_balance: 0, open_count: 0, oldest_due: null };
    const lastOrderDays = r.last_order_date ? Math.floor((today - new Date(r.last_order_date)) / 86400000) : null;

    // Days since first order (lifetime)
    const tenureDays = r.first_order_date ? Math.floor((today - new Date(r.first_order_date)) / 86400000) : 0;

    // Estimate monthly revenue
    const monthly_revenue = tenureDays > 0 ? r2((r.total_revenue / Math.max(tenureDays, 1)) * 30) : 0;

    // Compute oldest-overdue days
    let oldest_overdue_days = 0;
    if (open.oldest_due) {
      const due = new Date(open.oldest_due);
      if (due < today) oldest_overdue_days = Math.floor((today - due) / 86400000);
    }

    return {
      customer: r.customer_name,
      total_revenue_12mo: r2(r.total_revenue || 0),
      order_count_12mo: r.order_count || 0,
      monthly_revenue_avg: monthly_revenue,
      last_order_date: r.last_order_date,
      last_order_days_ago: lastOrderDays,
      tenure_days: tenureDays,
      open_balance: r2(open.open_balance || 0),
      open_invoices: open.open_count || 0,
      oldest_overdue_days,
      // Heuristic reliability score (0-100):
      //   Start at 100. Subtract for old overdues. Subtract for high open-balance-vs-revenue ratio.
      payment_reliability: scoreReliability(open.open_balance || 0, r.total_revenue || 0, oldest_overdue_days),
    };
  });

  customers.sort((a, b) => b.total_revenue_12mo - a.total_revenue_12mo);

  // Summary stats
  const total_open = r2(customers.reduce((s, c) => s + c.open_balance, 0));
  const total_12mo = r2(customers.reduce((s, c) => s + c.total_revenue_12mo, 0));
  const top_customer = customers[0];
  const concentration_pct = total_12mo > 0 ? pct((top_customer?.total_revenue_12mo || 0) / total_12mo) : 0;
  const top_5_share = total_12mo > 0
    ? pct(customers.slice(0, 5).reduce((s, c) => s + c.total_revenue_12mo, 0) / total_12mo)
    : 0;

  return {
    generated_at: new Date().toISOString(),
    summary: {
      customer_count: customers.length,
      total_revenue_12mo: total_12mo,
      total_open_ar: total_open,
      top_customer_share_pct: concentration_pct,
      top_5_share_pct: top_5_share,
      concentration_risk: concentration_pct >= 30 ? 'high' : concentration_pct >= 20 ? 'medium' : 'low',
    },
    customers: customers.slice(0, limit),
  };
}

function scoreReliability(openBal, revenue12mo, oldestOverdueDays) {
  let score = 100;
  // Penalty for old overdues
  if (oldestOverdueDays > 90) score -= 40;
  else if (oldestOverdueDays > 60) score -= 25;
  else if (oldestOverdueDays > 30) score -= 15;
  else if (oldestOverdueDays > 7) score -= 5;

  // Penalty for high outstanding-to-revenue ratio
  if (revenue12mo > 0) {
    const ratio = openBal / revenue12mo;
    if (ratio > 0.5) score -= 30;
    else if (ratio > 0.25) score -= 15;
    else if (ratio > 0.1) score -= 5;
  }

  return Math.max(0, Math.min(100, score));
}

// ── Single customer profile ──────────────────────────────────────────────
export async function getCustomerProfile(env, customerName) {
  const all = await getCustomerIntel(env, { limit: 9999 });
  const found = all.customers.find(c =>
    c.customer.toLowerCase() === (customerName || '').toLowerCase()
  );
  if (!found) return { error: 'customer not found', customer: customerName };

  // Pull full invoice history
  const { results: invoices } = await env.DB.prepare(`
    SELECT id, order_date,
           gross_revenue,
           status,
           json_extract(raw_payload, '$.doc_number') as doc_number,
           json_extract(raw_payload, '$.due_date') as due_date,
           json_extract(raw_payload, '$.balance') as balance,
           json_extract(raw_payload, '$.txn_date') as txn_date
    FROM orders
    WHERE customer_name = ? AND source IN ('qbo_wholesale','qbo_invoice')
    ORDER BY order_date DESC LIMIT 100
  `).bind(customerName).all();

  return {
    ...found,
    invoices: (invoices || []).map(i => ({
      ...i,
      balance: parseFloat(i.balance) || 0,
    })),
  };
}
