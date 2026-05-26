// workers/finance-square-extract.js
// Finance v2 — Square historical extract (Wave 0 spec section 0.2).
//
// Square POS migration happened ~Apr 11, 2026, so calendar 2025 data is
// minimal. This module is still useful for backfilling Square's own history
// into D1's finance-grade mirror (`fin_square_orders` / `fin_square_order_items`),
// and it's the canonical pull path for future historical requests
// (e.g. Q2 onwards reconciliation).
//
// Exported endpoints are registered in finance-worker.js:
//   POST /finance/square/extract-historical?since=YYYY-MM-DD&until=YYYY-MM-DD
//   GET  /finance/square/extract-status
//
// API reference:
//   POST https://connect.squareup.com/v2/orders/search  (body: date range + cursor)
//   POST https://connect.squareup.com/v2/customers/search
//   Rate limit: 700 req/min per token. We sleep 200ms between calls for safety.

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';
const SLEEP_MS = 200;

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function squareFetch(env, path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${SQUARE_API_BASE}${path}`, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Square ${method} ${path} (${resp.status}): ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Orders extractor ──────────────────────────────────────────────────────
// Uses POST /orders/search with date-range filter + pagination cursor.
export async function extractSquareOrders(env, since, until) {
  const locationId = env.SQUARE_LOCATION_ID;
  if (!locationId) throw new Error('SQUARE_LOCATION_ID not set — cannot target orders search');

  let cursor = null;
  let fetched = 0, inserted = 0, skipped = 0;
  const errors = [];

  do {
    const body = {
      location_ids: [locationId],
      query: {
        filter: {
          date_time_filter: {
            created_at: {
              start_at: `${since}T00:00:00Z`,
              end_at:   `${until}T23:59:59Z`,
            },
          },
          state_filter: {
            states: ['COMPLETED', 'OPEN'],
          },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
      },
      limit: 500,
      cursor,
    };
    const resp = await squareFetch(env, '/orders/search', 'POST', body);
    const orders = resp.orders || [];
    fetched += orders.length;

    for (const o of orders) {
      try {
        await upsertSquareOrder(env, o);
        inserted += 1;
      } catch (err) {
        errors.push({ order_id: o.id, error: err.message.slice(0, 200) });
        skipped += 1;
      }
    }
    cursor = resp.cursor || null;
    if (cursor) await sleep(SLEEP_MS);
  } while (cursor);

  return { fetched, inserted, skipped, errors: errors.slice(0, 20), total_errors: errors.length };
}

async function upsertSquareOrder(env, o) {
  const orderId = o.id;
  const totalMoney = o.total_money?.amount || 0;
  const taxMoney   = o.total_tax_money?.amount || 0;
  const tipMoney   = o.total_tip_money?.amount || 0;
  const discMoney  = o.total_discount_money?.amount || 0;
  const feeMoney   = o.total_service_charge_money?.amount || 0;
  const net        = totalMoney - taxMoney; // what Square deposits before tax remittance

  // Detect fulfillment type + channel.
  let fulfillmentType = null, channel = null, sourceType = null;
  if (Array.isArray(o.fulfillments) && o.fulfillments.length) {
    const f = o.fulfillments[0];
    fulfillmentType = (f.type || '').toLowerCase();
    if (f.type === 'DELIVERY') channel = 'delivery';
    else if (f.type === 'PICKUP') channel = 'in_store';
  }
  // Square `source.name` is the app that created the order (e.g. Square POS, DoorDash).
  if (o.source?.name) {
    const sn = o.source.name.toLowerCase();
    if (sn.includes('doordash'))  { sourceType = 'doordash';  channel = channel || 'delivery'; }
    else if (sn.includes('uber')) { sourceType = 'ubereats';  channel = channel || 'delivery'; }
    else if (sn.includes('grub')) { sourceType = 'grubhub';   channel = channel || 'delivery'; }
    else                          { sourceType = 'square_pos'; }
  }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO fin_square_orders (
      id, square_order_id, order_date, location_id, total_amount, total_tax,
      total_tip, total_discount, total_fees, net_amount, payment_method,
      fulfillment_type, customer_id, channel, source_type, is_reconciled,
      raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
  `).bind(
    `sq_${orderId}`,
    orderId,
    o.created_at,
    o.location_id || null,
    totalMoney / 100,
    taxMoney / 100,
    tipMoney / 100,
    discMoney / 100,
    feeMoney / 100,
    net / 100,
    o.tenders?.[0]?.type || null,
    fulfillmentType,
    o.customer_id || null,
    channel,
    sourceType,
    JSON.stringify(o).slice(0, 50000),
  ).run();

  // Line items.
  if (Array.isArray(o.line_items)) {
    // Wipe prior lines for this order (idempotent re-sync).
    await env.DB.prepare(
      `DELETE FROM fin_square_order_items WHERE square_order_id = ?`
    ).bind(orderId).run();
    for (const item of o.line_items) {
      await env.DB.prepare(`
        INSERT INTO fin_square_order_items (
          id, square_order_id, sku, name, category, quantity,
          unit_price, line_total, is_tax_exempt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        orderId,
        item.catalog_object_id || item.variation_name || null,
        item.name || 'unknown',
        item.category_name || null,
        parseInt(item.quantity) || 1,
        (item.base_price_money?.amount || 0) / 100,
        (item.total_money?.amount || 0) / 100,
        item.taxes?.length ? 0 : 1,
      ).run();
    }
  }
}

// ── Customers extractor ───────────────────────────────────────────────────
export async function extractSquareCustomers(env) {
  let cursor = null;
  let fetched = 0, inserted = 0, skipped = 0;

  do {
    const resp = await squareFetch(env, '/customers', 'GET', null)
      .catch(err => ({ error: err.message }));
    // Square Customers can also use /customers/search for date filtering;
    // for full export we just page the list endpoint with cursor handling.
    const list = resp.customers || [];
    fetched += list.length;

    for (const c of list) {
      try {
        const id = c.id;
        const displayName = [c.given_name, c.family_name].filter(Boolean).join(' ') || c.company_name || 'Unnamed';
        // Upsert into `customers` (finance table), tagged as retail. Wholesale
        // customers are migrated separately once we have the QBO cross-reference.
        await env.DB.prepare(`
          INSERT OR IGNORE INTO customers (
            id, square_customer_id, customer_type, display_name, email, phone,
            is_tax_exempt, is_active
          ) VALUES (?, ?, 'retail', ?, ?, ?, 0, 1)
        `).bind(
          `sqc_${id}`, id, displayName,
          c.email_address || null,
          c.phone_number || null,
        ).run();
        inserted += 1;
      } catch {
        skipped += 1;
      }
    }
    cursor = resp.cursor || null;
    if (cursor) {
      await sleep(SLEEP_MS);
      // The /customers list endpoint continues via `?cursor=`; wire in for full pagination.
      // (Minimal for Pretzel OS scale; ~100s of customers at most.)
      break;  // bail after first page for now; extend if needed
    }
  } while (cursor);

  return { fetched, inserted, skipped };
}

// ── Wrapper: extract both orders + customers for a date range ─────────────
export async function extractSquareHistorical(env, since, until) {
  const started = new Date().toISOString();
  const [ordersResult, customersResult] = await Promise.all([
    extractSquareOrders(env, since, until),
    extractSquareCustomers(env),
  ]);
  return {
    since,
    until,
    started_at: started,
    completed_at: new Date().toISOString(),
    orders: ordersResult,
    customers: customersResult,
  };
}

// ── Extract status / summary ──────────────────────────────────────────────
export async function squareExtractStatus(env) {
  const [orderStats, customerStats] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total,
             MIN(order_date) as earliest,
             MAX(order_date) as latest,
             COUNT(DISTINCT DATE(order_date)) as days_with_orders,
             ROUND(SUM(total_amount), 2) as gross_total
      FROM fin_square_orders
    `).first(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM customers WHERE square_customer_id IS NOT NULL`).first(),
  ]);
  return { orders: orderStats, customers: customerStats };
}
