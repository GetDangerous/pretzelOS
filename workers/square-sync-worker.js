/**
 * Dangerous Pretzel Co — Square Sync Worker
 * Replaces Toast POS integration starting April 14, 2026.
 *
 * Two modes:
 *   1. Real-time webhooks (POST /square/webhook)
 *      - order.completed → write order + update profile
 *      - 5+ items → push to SIGNAL_QUEUE for catering crossover
 *      - New customer with phone → trigger onboarding drip
 *
 *   2. Daily sync cron (2am MT via scheduled())
 *      - Catches anything webhooks missed
 *      - Syncs new/updated customers from Square Customers API
 *
 * Env vars required:
 *   SQUARE_ACCESS_TOKEN
 *   SQUARE_LOCATION_ID
 *   SQUARE_WEBHOOK_SIGNATURE_KEY
 *   DB, KV, SIGNAL_QUEUE
 */

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';
const GROUP_ORDER_THRESHOLD = 5;

// ── DELIVERY RELAY BLOCKLIST ────────────────────────────────────
const DELIVERY_RELAY_PHONES = new Set([
  '8552228111',   // DoorDash relay
  '2678912738',   // Uber Eats relay
  '8332753287',   // Uber Eats relay
  '8775851085',   // Grubhub relay
]);
function isDeliveryRelay(phone) {
  return phone && DELIVERY_RELAY_PHONES.has(phone);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailySync(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/square/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    if (url.pathname === '/square/sync' && request.method === 'POST') {
      const result = await runDailySync(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/square/status') {
      const lastSync = await env.KV.get('square_last_sync');
      return new Response(JSON.stringify({
        status: 'ok',
        last_sync: lastSync ? JSON.parse(lastSync) : null,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Square Sync Worker', { status: 200 });
  },
};

// ── WEBHOOK HANDLER ──────────────────────────────────────────────
async function handleWebhook(request, env) {
  const body = await request.text();

  // Validate signature
  if (env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    const signature = request.headers.get('x-square-hmacsha256-signature');
    if (!signature) {
      return new Response('Missing signature', { status: 401 });
    }
    const isValid = await verifySquareSignature(body, signature, env.SQUARE_WEBHOOK_SIGNATURE_KEY, request.url);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const eventType = event.type;
  console.log(`[Square] Webhook: ${eventType}`);

  try {
    if (eventType === 'order.completed' || eventType === 'order.updated') {
      await processOrderEvent(event, env);
    } else if (eventType === 'customer.created' || eventType === 'customer.updated') {
      await processCustomerEvent(event, env);
    }
  } catch (err) {
    console.error(`[Square] Webhook error:`, err.message);
    // Still return 200 to prevent retries for processing errors
  }

  return new Response('OK', { status: 200 });
}

// ── PROCESS ORDER WEBHOOK ────────────────────────────────────────
async function processOrderEvent(event, env) {
  const orderId = event.data?.id || event.data?.object?.order?.id;
  if (!orderId) return;

  // Fetch full order details from Square
  const order = await squareGet(`/orders/${orderId}`, env);
  if (!order?.order) return;

  const o = order.order;
  const locationId = o.location_id;

  // Only process orders from our location
  if (env.SQUARE_LOCATION_ID && locationId !== env.SQUARE_LOCATION_ID) return;

  // Extract line items
  const items = o.line_items || [];
  let totalItems = 0;
  const skuBreakdown = {};

  for (const item of items) {
    const qty = parseInt(item.quantity) || 1;
    const name = item.name || item.catalog_object_id || 'unknown';
    const sku = mapSquareItemToSku(name);
    if (sku) {
      skuBreakdown[sku] = (skuBreakdown[sku] || 0) + qty;
    }
    totalItems += qty;
  }

  // Extract customer info
  const customerId = o.customer_id;
  let customerPhone = null;
  let customerName = null;
  let customerEmail = null;

  if (customerId) {
    try {
      const customer = await squareGet(`/customers/${customerId}`, env);
      if (customer?.customer) {
        customerPhone = customer.customer.phone_number;
        customerName = [customer.customer.given_name, customer.customer.family_name]
          .filter(Boolean).join(' ') || null;
        customerEmail = customer.customer.email_address;
      }
    } catch (err) {
      console.log(`[Square] Could not fetch customer ${customerId}:`, err.message);
    }
  }

  // Calculate total
  const totalMoney = o.total_money?.amount || 0;
  const total = totalMoney / 100; // Square amounts are in cents

  // Write order to D1
  const orderDate = o.created_at || new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO orders (
      id, source, order_date, units, sku_breakdown,
      gross_revenue, customer_phone, customer_name, customer_email,
      raw_payload, created_at
    ) VALUES (?, 'square', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    `sq_${orderId}`,
    orderDate,
    totalItems,
    JSON.stringify(skuBreakdown),
    total,
    customerPhone || null,
    customerName || null,
    customerEmail || null,
    JSON.stringify(o),
  ).run();

  // Update retail customer profile (skip delivery relay phones and catering-scale orders)
  if (customerPhone) {
    const normalizedPhone = normalizePhone(customerPhone);
    const isCateringScale = total >= 500 || totalItems >= 30;
    if (normalizedPhone && !isDeliveryRelay(normalizedPhone) && !isCateringScale) {
      await updateRetailProfile(normalizedPhone, customerName, total, totalItems, skuBreakdown, orderDate, env);
    }

    // Flag catering crossover for large orders (5+ items) regardless
    if (normalizedPhone && totalItems >= GROUP_ORDER_THRESHOLD) {
      try {
        await env.SIGNAL_QUEUE.send({
          type: 'retail_group_order',
          customer_phone: customerPhone,
          customer_email: customerEmail,
          customer_name: customerName,
          item_count: totalItems,
          order_value: total,
          order_date: orderDate,
        });
        console.log(`[Square] Group order (${totalItems} items) → catering crossover signal`);
      } catch (err) {
        console.error('[Square] Failed to send crossover signal:', err.message);
      }
    }

    // Campaign attribution
    if (normalizedPhone && !isDeliveryRelay(normalizedPhone)) {
      await attributeCampaignReturn(normalizedPhone, total, env);
    }
  }

  console.log(`[Square] Order ${orderId}: ${totalItems} items, $${total}, phone=${customerPhone ? 'yes' : 'no'}`);
}

// ── PROCESS CUSTOMER WEBHOOK ─────────────────────────────────────
async function processCustomerEvent(event, env) {
  const customer = event.data?.object?.customer;
  if (!customer) return;

  const phone = normalizePhone(customer.phone_number);
  if (!phone) return;

  const name = [customer.given_name, customer.family_name].filter(Boolean).join(' ') || null;
  const customerId = hashPhone(phone);

  await env.DB.prepare(`
    INSERT INTO retail_customers (
      id, phone, normalized_phone, first_name,
      visit_count, total_lifetime_value,
      segment, sms_eligible, sms_consent,
      acquisition_source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, 'new', 1, 1, 'square', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      first_name = COALESCE(excluded.first_name, retail_customers.first_name),
      normalized_phone = COALESCE(excluded.normalized_phone, retail_customers.normalized_phone),
      sms_eligible = MAX(retail_customers.sms_eligible, 1),
      updated_at = datetime('now')
  `).bind(customerId, phone, phone, name).run();

  console.log(`[Square] Customer synced: ${name || phone}`);
}

// ── UPDATE RETAIL PROFILE ────────────────────────────────────────
async function updateRetailProfile(normalizedPhone, name, total, itemCount, skuBreakdown, orderDate, env) {
  const customerId = hashPhone(normalizedPhone);

  const existing = await env.DB.prepare(
    'SELECT * FROM retail_customers WHERE id = ?'
  ).bind(customerId).first();

  if (!existing) {
    // New customer
    const topSku = Object.entries(skuBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    await env.DB.prepare(`
      INSERT INTO retail_customers (
        id, phone, normalized_phone, first_name,
        visit_count, total_lifetime_value,
        avg_order_value, avg_items_per_order,
        largest_single_order, favorite_sku,
        sku_diversity_score,
        first_visit_date, last_visit_date,
        segment, is_group_buyer,
        sms_eligible, sms_consent,
        last_order_skus,
        acquisition_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'new', ?, 1, 1, ?, 'square', datetime('now'), datetime('now'))
    `).bind(
      customerId,
      normalizedPhone,
      normalizedPhone,
      name || null,
      total,
      total,
      itemCount,
      itemCount,
      topSku,
      Object.keys(skuBreakdown).length,
      itemCount >= GROUP_ORDER_THRESHOLD ? 1 : 0,
      JSON.stringify([{ skus: skuBreakdown, value: total }]),
    ).run();
    return;
  }

  // Returning customer — update
  const newVisitCount = existing.visit_count + 1;
  const newLTV = existing.total_lifetime_value + total;
  const newAvgOrder = newLTV / newVisitCount;
  const newAvgItems = (existing.avg_items_per_order * existing.visit_count + itemCount) / newVisitCount;
  const newLargest = Math.max(existing.largest_single_order || 0, itemCount);

  // Update last_order_skus (keep last 3)
  let lastOrderSkus;
  try {
    lastOrderSkus = JSON.parse(existing.last_order_skus || '[]');
  } catch { lastOrderSkus = []; }
  lastOrderSkus.unshift({ skus: skuBreakdown, value: total });
  lastOrderSkus = lastOrderSkus.slice(0, 3);

  // Update SKU diversity (merge old favorite with new)
  const allSkus = new Set();
  try {
    for (const o of lastOrderSkus) {
      for (const s of Object.keys(o.skus || {})) allSkus.add(s);
    }
  } catch {}
  if (existing.favorite_sku) allSkus.add(existing.favorite_sku);

  // Calculate new favorite SKU
  const skuTotals = {};
  for (const o of lastOrderSkus) {
    for (const [s, q] of Object.entries(o.skus || {})) {
      skuTotals[s] = (skuTotals[s] || 0) + q;
    }
  }
  const newFavSku = Object.entries(skuTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || existing.favorite_sku;

  // Segment
  let segment;
  if (newVisitCount >= 6) segment = 'vip';
  else if (newVisitCount >= 2) segment = 'regular';
  else segment = 'new';

  // Day of week pattern
  let dowPattern;
  try {
    dowPattern = JSON.parse(existing.day_of_week_pattern || '{}');
  } catch { dowPattern = {}; }
  const dow = new Date(orderDate).getUTCDay();
  dowPattern[dow] = (dowPattern[dow] || 0) + 1;

  // Visits by quarter
  let quarterPattern;
  try {
    quarterPattern = JSON.parse(existing.visits_by_quarter || '{}');
  } catch { quarterPattern = {}; }
  const quarter = `Q${Math.floor(new Date(orderDate).getUTCMonth() / 3) + 1}`;
  quarterPattern[quarter] = (quarterPattern[quarter] || 0) + 1;

  // Order frequency
  let frequencyDays = existing.order_frequency_days;
  if (existing.last_visit_date) {
    const gap = (new Date(orderDate) - new Date(existing.last_visit_date)) / 86400000;
    if (gap > 0) {
      frequencyDays = frequencyDays
        ? (frequencyDays * 0.7 + gap * 0.3) // exponential moving average
        : gap;
      frequencyDays = Math.round(frequencyDays * 10) / 10;
    }
  }

  // Peak send hour
  const hour = new Date(orderDate).getUTCHours();
  let hourPattern;
  try {
    // We don't store hour pattern, approximate from peak_send_hour
    hourPattern = existing.peak_send_hour;
  } catch { hourPattern = null; }
  // Simple: keep existing or use this order's hour
  const peakHour = hourPattern || hour;

  await env.DB.prepare(`
    UPDATE retail_customers
    SET visit_count = ?,
        total_lifetime_value = ?,
        avg_order_value = ?,
        avg_items_per_order = ?,
        largest_single_order = ?,
        favorite_sku = ?,
        sku_diversity_score = ?,
        last_visit_date = ?,
        segment = ?,
        is_group_buyer = ?,
        order_frequency_days = ?,
        last_order_skus = ?,
        day_of_week_pattern = ?,
        visits_by_quarter = ?,
        peak_send_hour = ?,
        first_name = COALESCE(first_name, ?),
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    newVisitCount,
    Math.round(newLTV * 100) / 100,
    Math.round(newAvgOrder * 100) / 100,
    Math.round(newAvgItems * 10) / 10,
    newLargest,
    newFavSku,
    Math.min(allSkus.size, 10),
    orderDate,
    segment,
    existing.is_group_buyer || (itemCount >= GROUP_ORDER_THRESHOLD ? 1 : 0),
    frequencyDays,
    JSON.stringify(lastOrderSkus),
    JSON.stringify(dowPattern),
    JSON.stringify(quarterPattern),
    peakHour,
    name || null,
    customerId,
  ).run();
}

// ── CAMPAIGN ATTRIBUTION ─────────────────────────────────────────
async function attributeCampaignReturn(normalizedPhone, orderValue, env) {
  const customerId = hashPhone(normalizedPhone);

  // Find most recent unsettled campaign send within 14 days
  const send = await env.DB.prepare(`
    SELECT id, campaign_id, sent_at
    FROM retail_campaign_sends
    WHERE customer_id = ?
      AND outcome = 'delivered'
      AND returned_at IS NULL
      AND sent_at >= datetime('now', '-14 days')
    ORDER BY sent_at DESC
    LIMIT 1
  `).bind(customerId).first();

  if (!send) return;

  const daysSinceSend = Math.floor(
    (Date.now() - new Date(send.sent_at)) / 86400000
  );

  // Update the send record
  await env.DB.prepare(`
    UPDATE retail_campaign_sends
    SET returned_at = datetime('now'),
        return_order_value = ?,
        days_to_return = ?,
        outcome = 'returned'
    WHERE id = ?
  `).bind(orderValue, daysSinceSend, send.id).run();

  // Update campaign totals
  await env.DB.prepare(`
    UPDATE retail_campaigns
    SET total_returned = total_returned + 1,
        total_revenue_attributed = total_revenue_attributed + ?,
        roi_estimate = CASE
          WHEN total_sent > 0 THEN ROUND((total_revenue_attributed + ?) / (total_sent * 0.01), 1)
          ELSE 0
        END,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(orderValue, orderValue, send.campaign_id).run();

  console.log(`[Square] Campaign attribution: customer ${customerId} returned, $${orderValue}`);
}

// ── DAILY SYNC (catches missed webhooks) ─────────────────────────
async function runDailySync(env) {
  console.log('[Square] Starting daily sync...');
  const results = { orders_synced: 0, customers_synced: 0 };

  try {
    // Sync yesterday's orders
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const orderResp = await squarePost('/orders/search', {
      location_ids: [env.SQUARE_LOCATION_ID],
      query: {
        filter: {
          date_time_filter: {
            created_at: {
              start_at: yesterday.toISOString(),
              end_at: today.toISOString(),
            },
          },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      limit: 500,
    }, env);

    const orders = orderResp?.orders || [];
    for (const o of orders) {
      const orderId = o.id;
      // Check if already exists
      const existing = await env.DB.prepare(
        'SELECT id FROM orders WHERE id = ?'
      ).bind(`sq_${orderId}`).first();

      if (existing) continue;

      // Process same as webhook
      await processOrderFromData(o, env);
      results.orders_synced++;
    }

    // Sync recent customers
    const custResp = await squareGet(
      `/customers?sort_field=CREATED_AT&sort_order=DESC&limit=100`,
      env,
    );
    const customers = custResp?.customers || [];
    for (const c of customers) {
      const phone = normalizePhone(c.phone_number);
      if (!phone) continue;

      const customerId = hashPhone(phone);
      const name = [c.given_name, c.family_name].filter(Boolean).join(' ') || null;

      await env.DB.prepare(`
        INSERT INTO retail_customers (
          id, phone, normalized_phone, first_name,
          visit_count, total_lifetime_value,
          segment, sms_eligible, sms_consent,
          acquisition_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, 'new', 1, 1, 'square', datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          first_name = COALESCE(excluded.first_name, retail_customers.first_name),
          normalized_phone = COALESCE(excluded.normalized_phone, retail_customers.normalized_phone),
          updated_at = datetime('now')
      `).bind(customerId, phone, phone, name).run();

      results.customers_synced++;
    }
  } catch (err) {
    console.error('[Square] Daily sync error:', err.message);
    results.error = err.message;
  }

  // Record last sync
  await env.KV.put('square_last_sync', JSON.stringify({
    ...results,
    completed_at: new Date().toISOString(),
  }));

  console.log('[Square] Daily sync done:', results);
  return results;
}

// Process order data directly (used by daily sync)
async function processOrderFromData(o, env) {
  const items = o.line_items || [];
  let totalItems = 0;
  const skuBreakdown = {};

  for (const item of items) {
    const qty = parseInt(item.quantity) || 1;
    const sku = mapSquareItemToSku(item.name || '');
    if (sku) skuBreakdown[sku] = (skuBreakdown[sku] || 0) + qty;
    totalItems += qty;
  }

  const totalMoney = o.total_money?.amount || 0;
  const total = totalMoney / 100;
  const orderDate = o.created_at || new Date().toISOString();

  // Get customer info
  let customerPhone = null;
  let customerName = null;
  let customerEmail = null;

  if (o.customer_id) {
    try {
      const customer = await squareGet(`/customers/${o.customer_id}`, env);
      if (customer?.customer) {
        customerPhone = customer.customer.phone_number;
        customerName = [customer.customer.given_name, customer.customer.family_name]
          .filter(Boolean).join(' ') || null;
        customerEmail = customer.customer.email_address;
      }
    } catch {}
  }

  // Check if order already exists (webhook may have already processed it)
  const existingOrder = await env.DB.prepare(
    'SELECT id FROM orders WHERE id = ?'
  ).bind(`sq_${o.id}`).first();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO orders (
      id, source, order_date, units, sku_breakdown,
      gross_revenue, customer_phone, customer_name, customer_email,
      raw_payload, created_at
    ) VALUES (?, 'square', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    `sq_${o.id}`,
    orderDate,
    totalItems,
    JSON.stringify(skuBreakdown),
    total,
    customerPhone || null,
    customerName || null,
    customerEmail || null,
    JSON.stringify(o),
  ).run();

  // Update retail profile — skip if order already processed (prevents double-counting)
  // Also skip delivery relay phones and catering-scale orders
  if (customerPhone && !existingOrder) {
    const normalizedPhone = normalizePhone(customerPhone);
    const isCateringScale = total >= 500 || totalItems >= 30;
    if (normalizedPhone && !isDeliveryRelay(normalizedPhone) && !isCateringScale) {
      await updateRetailProfile(normalizedPhone, customerName, total, totalItems, skuBreakdown, orderDate, env);
      await attributeCampaignReturn(normalizedPhone, total, env);
    }

    // Catering crossover signal for large orders
    if (normalizedPhone && totalItems >= GROUP_ORDER_THRESHOLD) {
        try {
          await env.SIGNAL_QUEUE.send({
            type: 'retail_group_order',
            customer_phone: customerPhone,
            customer_email: customerEmail,
            customer_name: customerName,
            item_count: totalItems,
            order_value: total,
            order_date: orderDate,
          });
        } catch {}
    }
  }
}

// ── SQUARE API HELPERS ───────────────────────────────────────────
async function squareGet(path, env) {
  const resp = await fetch(`${SQUARE_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Square GET ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function squarePost(path, body, env) {
  const resp = await fetch(`${SQUARE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Square POST ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function verifySquareSignature(body, signature, sigKey, webhookUrl) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(sigKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = webhookUrl + body;
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const computed = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return computed === signature;
}

// ── SKU MAPPING ──────────────────────────────────────────────────
function mapSquareItemToSku(itemName) {
  if (!itemName) return null;
  const lower = itemName.toLowerCase().trim();
  const map = {
    'spicy bee': 'SPICY-BEE', 'spicy': 'SPICY-BEE',
    'bbk': 'BBK', 'brush before kissing': 'BBK',
    'saint': 'SAINT',
    'salty': 'SALTY',
    'for the kids': 'KIDS', 'kids': 'KIDS',
    'salty bombs': 'BOMBS', 'bombs': 'BOMBS', 'pretzel bombs': 'BOMBS',
  };
  for (const [key, sku] of Object.entries(map)) {
    if (lower.includes(key)) return sku;
  }
  return null;
}

// ── PHONE HELPERS ────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function hashPhone(normalizedPhone) {
  return `rc_${normalizedPhone}`;
}
