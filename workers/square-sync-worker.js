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

import { sendResendEmail as sendResendEmailFromSquare } from './email-sender.js';

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
    return runDailySync(env);
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

    if (url.pathname === '/square/verify-order') {
      // Verify a specific order ID exists on Square's side.
      // Usage: GET /square/verify-order?id=<square_order_id> (without sq_ prefix)
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const cleanId = id.startsWith('sq_') ? id.slice(3) : id;
      try {
        const result = await squareGet(`/orders/${cleanId}`, env);
        const o = result?.order;
        return new Response(JSON.stringify({
          found: !!o,
          square_id: o?.id,
          state: o?.state,  // OPEN, COMPLETED, CANCELED, DRAFT
          location_id: o?.location_id,
          created_at: o?.created_at,
          closed_at: o?.closed_at,
          total_money: o?.total_money,
          line_items_count: o?.line_items?.length,
          tenders: (o?.tenders || []).map(t => ({ id: t.id, type: t.type, amount: t.amount_money, created_at: t.created_at })),
          refunds: o?.refunds,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, square_id: cleanId }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
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

  // Validate signature — fail CLOSED if the secret is missing in production.
  // An unauthenticated webhook lets attacker-controlled orders/customers be written to D1.
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    if (env.ENVIRONMENT === 'production' || !env.ENVIRONMENT) {
      console.error('[square-webhook] FAIL-CLOSED: SQUARE_WEBHOOK_SIGNATURE_KEY missing');
      return new Response('Webhook secret not configured', { status: 500 });
    }
    console.warn('[square-webhook] signature skipped (non-production env)');
  } else {
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

  // Extract customer info — try 4 sources in order:
  // 1. o.customer_id (best — attached pre-payment)
  // 2. o.tenders[].customer_id (attached via payment)
  // 3. o.fulfillments[].pickup_details.recipient.phone_number (pickup orders)
  // 4. o.fulfillments[].delivery_details.recipient.phone_number (delivery — but we FLAG delivery)
  let customerId = o.customer_id;
  let customerPhone = null;
  let customerName = null;
  let customerEmail = null;
  let isDeliveryOrder = false;

  // Source 1 — fetch via Square Customers API if customer_id present
  if (!customerId && Array.isArray(o.tenders)) {
    for (const t of o.tenders) { if (t.customer_id) { customerId = t.customer_id; break; } }
  }
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

  // Source 3 — inspect fulfillments. Only PICKUP recipients are our customers.
  // DELIVERY recipients are DoorDash/Uber/Grubhub drivers — their phone is a relay
  // and we should NOT send review SMSes to those numbers.
  if (Array.isArray(o.fulfillments)) {
    for (const f of o.fulfillments) {
      if (f.type === 'DELIVERY') isDeliveryOrder = true;
      if (f.type === 'PICKUP' && f.pickup_details?.recipient) {
        const r = f.pickup_details.recipient;
        if (!customerPhone && r.phone_number) customerPhone = r.phone_number;
        if (!customerName && r.display_name) customerName = r.display_name;
        if (!customerEmail && r.email_address) customerEmail = r.email_address;
      }
      // Delivery: capture display_name for order tracking but NOT phone (it's a driver/platform relay)
      if (f.type === 'DELIVERY' && f.delivery_details?.recipient) {
        if (!customerName && f.delivery_details.recipient.display_name) {
          customerName = f.delivery_details.recipient.display_name;
        }
      }
    }
  }

  // Calculate total
  const totalMoney = o.total_money?.amount || 0;
  const total = totalMoney / 100; // Square amounts are in cents

  // Write order to D1. Delivery orders use source='square_delivery' so the review batch
  // can cleanly exclude them via source filter (they're DoorDash/Uber/Grubhub — not our customers).
  const orderDate = o.created_at || new Date().toISOString();
  const orderSource = isDeliveryOrder ? 'square_delivery' : 'square';
  // Map Square's order state → our internal status. CRITICAL for revenue accuracy:
  // Square's DRAFT means the order was started but never paid (cashier opened a ticket,
  // customer abandoned, etc.). Counting drafts as revenue inflated catering by ~$3,800
  // before this fix (May 19 2026). Only COMPLETED orders count toward revenue.
  // OPEN = in-progress (e.g. dine-in tab open) — keep but flag, revenue queries can exclude.
  const orderStatus = (() => {
    const s = (o.state || '').toUpperCase();
    if (s === 'COMPLETED') return 'active';
    if (s === 'CANCELED') return 'canceled';
    if (s === 'DRAFT') return 'draft';
    if (s === 'OPEN') return 'open';
    return 'active'; // legacy default for orders without state field
  })();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO orders (
      id, source, order_date, units, sku_breakdown,
      gross_revenue, customer_phone, customer_name, customer_email,
      raw_payload, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    `sq_${orderId}`,
    orderSource,
    orderDate,
    totalItems,
    JSON.stringify(skuBreakdown),
    total,
    customerPhone || null,
    customerName || null,
    customerEmail || null,
    JSON.stringify(o),
    orderStatus,
  ).run();

  // Also UPDATE status on existing rows — webhook may fire for the same order multiple
  // times (DRAFT → OPEN → COMPLETED). Ensure status reflects the latest known state.
  await env.DB.prepare(
    "UPDATE orders SET status = ? WHERE id = ? AND COALESCE(status, '') != ?"
  ).bind(orderStatus, `sq_${orderId}`, orderStatus).run().catch(() => {});

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

    // Emit signals for event-triggered continuous campaigns
    if (normalizedPhone && !isDeliveryRelay(normalizedPhone) && !isCateringScale) {
      await emitCampaignSignals(normalizedPhone, customerName, total, totalItems, skuBreakdown, orderDate, env);
    }

    // Campaign attribution
    if (normalizedPhone && !isDeliveryRelay(normalizedPhone)) {
      await attributeCampaignReturn(normalizedPhone, total, env);
    }
    // Email-campaign attribution — separate from SMS path, attributes via customer_id or email
    if ((customerId || customerEmail) && !isDeliveryRelay(normalizedPhone)) {
      await attributeEmailReturn(customerId, customerEmail, total, env);
    }
  }

  // ── Cohort C — real-time welcome email trigger ─────────────────────
  // Send a "thanks for stopping by + here's $8 off" email when a brand-new Square
  // customer with email-on-file completes their FIRST order and isn't a loyalty member.
  // Idempotent on customer_id. Plan: /Users/drew/.claude/plans/iterative-frolicking-hollerith.md
  if (customerId && customerEmail && !isDeliveryOrder) {
    try {
      // Mirror the customer into our square_customers table (so segmentation queries work
      // before the next square_customer_sync cron). Defensive — if Square is rate-limiting
      // the GET, we already have email/phone/name from the tender lookup above.
      await env.DB.prepare(`
        INSERT INTO square_customers (square_customer_id, email, phone, given_name, family_name, creation_source, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(square_customer_id) DO UPDATE SET
          email = COALESCE(excluded.email, square_customers.email),
          phone = COALESCE(excluded.phone, square_customers.phone),
          synced_at = datetime('now')
      `).bind(
        customerId, customerEmail || null, customerPhone || null,
        customerName?.split(' ')[0] || null,
        customerName?.split(' ').slice(1).join(' ') || null,
        'POS', // best guess — webhook customer was created via in-store transaction
      ).run();

      // Check if this is their first Square order. orders.customer_id is our internal
      // rc_* key — but Square's customer ID lives in raw_payload.$.customer_id. Use that
      // to count by Square identity (matches square_customers.square_customer_id).
      const orderCount = await env.DB.prepare(`
        SELECT COUNT(DISTINCT id) as cnt FROM orders
        WHERE source IN ('square','square_delivery')
          AND json_extract(raw_payload, '$.customer_id') = ?
      `).bind(customerId).first();

      // Check loyalty enrollment.
      const inLoyalty = await env.DB.prepare(
        'SELECT 1 FROM loyalty_accounts WHERE square_customer_id = ? LIMIT 1'
      ).bind(customerId).first();

      // Check unsub/bounce status.
      const custStatus = await env.DB.prepare(
        'SELECT email_unsubscribed, email_bounced FROM square_customers WHERE square_customer_id = ?'
      ).bind(customerId).first();

      const isFirstOrder = (orderCount?.cnt || 0) === 1;
      const isReachable = !inLoyalty && !custStatus?.email_unsubscribed && !custStatus?.email_bounced;

      if (isFirstOrder && isReachable) {
        // Look up the Cohort C campaign id (created lazily if missing).
        let campaign = await env.DB.prepare(
          "SELECT id FROM retail_campaigns WHERE campaign_type = 'email_welcome_square' LIMIT 1"
        ).first();
        if (!campaign) {
          const newId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO retail_campaigns (id, name, campaign_type, status, target_segment,
              send_strategy, daily_send_limit, approval_status, campaign_mode,
              agent_reasoning, created_at, updated_at)
            VALUES (?, 'Square First-Order Welcome (Email)', 'email_welcome_square', 'active', 'square_first_timer',
              'event_triggered', 0, 'approved', 'event_triggered',
              'Auto-created by Cohort C trigger on first new-customer Square order with email.',
              datetime('now'), datetime('now'))
          `).bind(newId).run();
          campaign = { id: newId };
        }

        // Compose + send. Idempotency on customer_id ensures one welcome per customer ever.
        const firstName = customerName?.split(' ')[0] || 'friend';
        // Branded HTML — uses the discount-code block + design tokens from email-sender.js.
        // Inline-styled because we can't import the helpers across module boundaries cleanly here.
        const codeBlock = `<table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:24px 0">
<tr><td align="center" style="background:#1A1A1A;padding:22px 16px;border-radius:6px;border:2px dashed #C41E1E">
<div style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:11px;color:#CCC;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">Show this code at the counter</div>
<div style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;color:#FFFFFF;letter-spacing:1.5px">WELCOME2WHY5</div>
<div style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:12px;color:#CCC;margin-top:8px">$8 off your next visit · valid 30 days</div>
</td></tr></table>`;
        const html = `<h1 style="font-family:Georgia,serif;font-style:italic;font-weight:900;font-size:28px;color:#1A1A1A;margin:0 0 16px;line-height:1.15">Thanks for stopping by, ${firstName}.</h1>
<p style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:15px;color:#1A1A1A;line-height:1.55;margin:0 0 14px">Hope you loved it. Here's a little something for next time — your second pretzel + dip is on us.</p>
${codeBlock}
<p style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:13px;color:#666;line-height:1.5;margin:24px 0 14px">P.S. Join our loyalty program in-store next visit — you'll earn rewards on every order.</p>
<p style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:15px;color:#1A1A1A;line-height:1.55;margin:24px 0 0">See you soon,<br>
<strong>Drew</strong><br>
<span style="color:#666;font-size:13px">Founder · Dangerous Pretzel Co</span></p>`;
        await sendResendEmailFromSquare(env, {
          to: customerEmail,
          subject: 'A little something for your next visit 🥨',
          body_html: html,
          body_text: html.replace(/<[^>]+>/g, ''),
          campaign_id: campaign.id,
          cohort: 'C',
          customer_id: customerId,
          idempotency_key: `cohort_c_welcome_${customerId}`,
        });
      }
    } catch (err) {
      // Non-fatal — order is already booked. Just log.
      console.error('[Cohort C] welcome trigger error:', err.message);
    }
  }

  // ── LOYALTY REDEMPTION TRACKING (post-May-11 mechanism) ──────────
  // Square Loyalty rewards appear on the order as:
  //   o.rewards[] = [{ id, reward_tier_id, order_id, status, ... }]
  // AND as a synthetic line in o.discounts[] (no catalog_object_id, name = tier name)
  // attributeCampaignReturn() already handles phone-side attribution to retail_campaign_sends.
  // This block adds observability + flags the send row as redeemed-via-loyalty for audit.
  try {
    const rewards = o.rewards || [];
    if (rewards.length > 0 && customerPhone) {
      const normalizedPhone = normalizePhone(customerPhone);
      const customerId = hashPhone(normalizedPhone);
      // Sum tier amounts via discount name (Square doesn't embed amount on the reward struct)
      const tierNames = (o.discounts || []).filter(d => !d.catalog_object_id && /off entire sale/i.test(d.name || ''));
      const totalRewardAmount = tierNames.reduce((sum, d) => sum + (parseInt(d.amount_money?.amount, 10) || 0), 0);
      console.log(`[Square] Loyalty redemption: customer ${customerId}, ${rewards.length} reward(s), $${totalRewardAmount/100} off, order ${orderId}`);
      // Tag the most-recent matching send row with the reward_id for audit traceability
      try {
        await env.DB.prepare(`
          UPDATE retail_campaign_sends
          SET discount_code = COALESCE(discount_code, '') || ' | loyalty_redeemed:' || ?
          WHERE id = (
            SELECT id FROM retail_campaign_sends
            WHERE customer_id = ?
              AND outcome = 'delivered'
              AND sent_at >= datetime('now','-30 days')
              AND (discount_code IS NULL OR discount_code NOT LIKE '%loyalty_redeemed:%')
            ORDER BY sent_at DESC LIMIT 1
          )
        `).bind(rewards[0].id || 'unknown', customerId).run();
      } catch (err) {
        console.error(`[Square] Loyalty send-tag failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[Square] Loyalty redemption tracking error:', err.message);
  }

  // Discount redemption tracking — check if order used a campaign discount.
  // For single-use codes (max_redemptions=1), DELETE the Square catalog object after
  // first redeem so it can't be re-used even if the customer shares it.
  // Kept for backward-compat with pre-May-11 Catalog-DISCOUNT codes still in flight.
  try {
    const orderDiscounts = o.discounts || [];
    for (const disc of orderDiscounts) {
      if (disc.catalog_object_id) {
        const match = await env.DB.prepare(
          'SELECT id, campaign_id, max_redemptions, times_redeemed FROM retail_campaign_discounts WHERE square_catalog_id = ? AND status = ?'
        ).bind(disc.catalog_object_id, 'active').first();
        if (match) {
          const newCount = (match.times_redeemed || 0) + 1;
          await env.DB.prepare(
            'UPDATE retail_campaign_discounts SET times_redeemed = ? WHERE id = ?'
          ).bind(newCount, match.id).run();
          console.log(`[Square] Discount ${disc.catalog_object_id} redeemed → campaign ${match.campaign_id}`);

          // Single-use enforcement: if max_redemptions=1 and we've hit it, delete the
          // catalog object from Square + mark our row as redeemed so no future match.
          if (match.max_redemptions === 1 && newCount >= 1) {
            try {
              const resp = await fetch(`${SQUARE_API_BASE}/catalog/object/${disc.catalog_object_id}`, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
                  'Square-Version': '2024-10-17',
                },
              });
              if (resp.ok) {
                await env.DB.prepare(
                  "UPDATE retail_campaign_discounts SET status = 'redeemed' WHERE id = ?"
                ).bind(match.id).run();
                console.log(`[Square] Single-use code ${disc.catalog_object_id} deleted from Square catalog`);
              } else {
                console.error(`[Square] DELETE catalog/${disc.catalog_object_id} failed: ${resp.status}`);
              }
            } catch (delErr) {
              console.error(`[Square] Single-use delete failed: ${delErr.message}`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Square] Discount tracking error:', err.message);
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
      first_visit_date,
      segment, sms_eligible, sms_consent,
      acquisition_source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, datetime('now'), 'new', 1, 1, 'square', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      first_name = COALESCE(excluded.first_name, retail_customers.first_name),
      normalized_phone = COALESCE(excluded.normalized_phone, retail_customers.normalized_phone),
      first_visit_date = COALESCE(retail_customers.first_visit_date, excluded.first_visit_date),
      sms_eligible = MAX(retail_customers.sms_eligible, 1),
      updated_at = datetime('now')
  `).bind(customerId, phone, phone, name).run();

  // Reverse-link heuristic: Square's register flow creates customers for
  // receipt/loyalty AFTER the payment completes, so the order webhook arrives
  // with customer_id=null and customer_phone=null. Try to link the most recent
  // unattached Square order from this location to this just-created customer.
  // We only match orders within a 10-minute window to avoid false positives.
  let linkedOrderInfo = null;
  try {
    const recent = await env.DB.prepare(`
      SELECT id, order_date, gross_revenue, units, sku_breakdown
      FROM orders
      WHERE source = 'square'
        AND customer_phone IS NULL
        AND customer_id IS NULL
        AND order_date >= datetime('now', '-10 minutes')
      ORDER BY order_date DESC
      LIMIT 1
    `).first();

    if (recent) {
      // Attach the customer to the order
      await env.DB.prepare(`
        UPDATE orders
        SET customer_phone = ?, customer_name = ?, customer_id = ?
        WHERE id = ?
      `).bind(phone, name, customerId, recent.id).run();

      // Bump retail profile for the backfilled order (same path a real order would take)
      let skuBreakdown = {};
      try { skuBreakdown = JSON.parse(recent.sku_breakdown || '{}'); } catch {}
      const total = recent.gross_revenue || 0;
      const totalItems = recent.units || 0;
      const isCateringScale = total >= 500 || totalItems >= 30;
      if (!isDeliveryRelay(phone) && !isCateringScale) {
        await updateRetailProfile(phone, name, total, totalItems, skuBreakdown, recent.order_date, env);
        // Fire the campaign signal so Free Pretzel Welcome (and any other event-triggered
        // campaigns requiring visit_count=1) actually match for this reverse-linked order.
        await emitCampaignSignals(phone, name, total, totalItems, skuBreakdown, recent.order_date, env);
      }

      linkedOrderInfo = { order_id: recent.id, revenue: total, items: totalItems };
      console.log(`[Square] Reverse-linked customer ${phone} to order ${recent.id} (${totalItems} items, $${total})`);
    }
  } catch (err) {
    console.error(`[Square] Reverse-link failed for ${phone}:`, err.message);
  }

  console.log(`[Square] Customer synced: ${name || phone}${linkedOrderInfo ? ` + linked order ${linkedOrderInfo.order_id}` : ''}`);
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

// ── EVENT-TRIGGERED CONTINUOUS CAMPAIGN SIGNALS ─────────────────
async function emitCampaignSignals(normalizedPhone, customerName, orderValue, itemCount, skuBreakdown, orderDate, env) {
  const customerId = hashPhone(normalizedPhone);

  try {
    // Get all active event-triggered continuous campaigns
    const campaigns = await env.DB.prepare(`
      SELECT id, campaign_type, trigger_config, optimal_delay_seconds
      FROM retail_campaigns
      WHERE campaign_mode = 'continuous'
        AND trigger_type = 'event'
        AND status = 'active'
        AND paused_at IS NULL
    `).all();

    if (!campaigns.results?.length) return;

    // Load customer data for condition evaluation
    const customer = await env.DB.prepare(
      'SELECT * FROM retail_customers WHERE id = ? AND sms_eligible = 1'
    ).bind(customerId).first();
    if (!customer) return;

    // Check suppression once
    const suppressed = await env.DB.prepare(
      'SELECT phone FROM sms_suppressions WHERE phone = ?'
    ).bind(normalizedPhone).first();
    if (suppressed) return;

    // Check cross-campaign frequency cap (2 per week)
    const recentSends = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_frequency_cap
      WHERE customer_id = ? AND sent_at >= datetime('now', '-7 days')
    `).bind(customerId).first();
    if ((recentSends?.count || 0) >= 2) return;

    for (const campaign of campaigns.results) {
      let config;
      try { config = JSON.parse(campaign.trigger_config || '{}'); } catch { continue; }

      // Evaluate trigger conditions — ALL must match (AND) for the campaign to fire.
      // Extended to support the full set needed by Free Pretzel Welcome:
      // visit_count_eq, visit_count_min, visit_count_gte, sms_consent_eq, sms_eligible_eq,
      // acquisition_source_eq, segment_eq, segment_in, segment_not_in, is_group_buyer, min_items.
      const conditions = config.conditions || {};
      if (conditions.visit_count_eq !== undefined && customer.visit_count !== conditions.visit_count_eq) continue;
      if (conditions.visit_count_min !== undefined && customer.visit_count < conditions.visit_count_min) continue;
      if (conditions.visit_count_gte !== undefined && customer.visit_count < conditions.visit_count_gte) continue;
      if (conditions.sms_consent_eq !== undefined && customer.sms_consent !== conditions.sms_consent_eq) continue;
      if (conditions.sms_eligible_eq !== undefined && customer.sms_eligible !== conditions.sms_eligible_eq) continue;
      if (conditions.acquisition_source_eq !== undefined && customer.acquisition_source !== conditions.acquisition_source_eq) continue;
      if (conditions.segment_eq !== undefined && customer.segment !== conditions.segment_eq) continue;
      if (conditions.segment_in && !conditions.segment_in.includes(customer.segment)) continue;
      if (conditions.segment_not_in && conditions.segment_not_in.includes(customer.segment)) continue;
      if (conditions.is_group_buyer && !customer.is_group_buyer) continue;
      if (conditions.min_items !== undefined && itemCount < conditions.min_items) continue;

      // Check if already sent to this customer recently for this campaign
      const reEnrollDays = Math.max(1, Math.min(365, parseInt(config.re_enrollment_days, 10) || 90));
      const alreadySent = await env.DB.prepare(
        `SELECT id FROM retail_campaign_sends WHERE campaign_id = ? AND customer_id = ? AND sent_at >= datetime('now', '-' || ? || ' days')`
      ).bind(campaign.id, customerId, reEnrollDays).first();
      if (alreadySent) continue;

      // Determine delay
      const delaySec = campaign.optimal_delay_seconds || config.delay_seconds || 7200;

      // Send to queue with delay. Cloudflare Queues' deliveryDelay isn't being honored
      // reliably (May 13 bug found — customer got SMS in 1 min instead of 2h), so we ALSO
      // include fire_after_ms in the payload for handler-side enforcement as defense.
      const fireAfterMs = Date.now() + delaySec * 1000;
      await env.SIGNAL_QUEUE.send({
        type: 'campaign_trigger',
        campaign_id: campaign.id,
        customer_id: customerId,
        customer_phone: normalizedPhone,
        customer_name: customerName,
        order_value: orderValue,
        order_date: orderDate,
        item_count: itemCount,
        trigger_event: 'order.completed',
        delay_seconds: delaySec,
        fire_after_ms: fireAfterMs,
      }, {
        deliveryDelay: delaySec,
      });

      console.log(`[Square] Campaign trigger queued: ${campaign.campaign_type} for ${customerId}, delay=${delaySec}s`);
    }
  } catch (err) {
    console.error(`[Square] emitCampaignSignals error: ${err.message}`);
  }
}

// ── EMAIL CAMPAIGN ATTRIBUTION ───────────────────────────────────
// Resend's native open-tracking isn't firing (platform bug May-11). We attribute
// email returns the SAME way as SMS returns: when an order arrives, look up the
// most-recent delivered email to this customer (by customer_id OR email) and mark
// returned_at + return_order_value on the email_sends row. Mirrors attributeCampaignReturn.
async function attributeEmailReturn(customerId, customerEmail, orderValue, env) {
  if (!customerId && !customerEmail) return;
  // Prefer customer_id link; fall back to email match.
  // BUG FIX: require email to be sent at least 5 minutes BEFORE this order to exclude the
  // Cohort C welcome-on-first-order case where the email fires inside the order webhook
  // (sent_at lands ~3-5s after order_date — would self-attribute as a "return").
  const send = await env.DB.prepare(`
    SELECT id, campaign_id, sent_at
    FROM email_sends
    WHERE (customer_id = ? OR (? IS NOT NULL AND to_email = ?))
      AND status = 'delivered'
      AND returned_at IS NULL
      AND sent_at >= datetime('now', '-30 days')
      AND datetime(sent_at) <= datetime('now', '-5 minutes')
    ORDER BY sent_at DESC
    LIMIT 1
  `).bind(customerId || null, customerEmail || null, customerEmail || null).first().catch(() => null);
  if (!send) return;
  const daysSinceSend = Math.floor((Date.now() - new Date(send.sent_at + 'Z').getTime()) / 86400000);
  await env.DB.prepare(`
    UPDATE email_sends
    SET returned_at = datetime('now'),
        return_order_value = ?,
        days_to_return = ?
    WHERE id = ?
  `).bind(orderValue, daysSinceSend, send.id).run().catch(() => {});
  // Roll up to campaign totals if linked
  if (send.campaign_id) {
    await env.DB.prepare(`
      UPDATE retail_campaigns
      SET total_returned = total_returned + 1,
          total_revenue_attributed = total_revenue_attributed + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(orderValue, send.campaign_id).run().catch(() => {});
  }
  console.log(`[Square] Email-campaign attribution: customer=${customerId || customerEmail} returned, $${orderValue}, ${daysSinceSend}d after send`);
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
          first_visit_date,
          segment, sms_eligible, sms_consent,
          acquisition_source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 0, datetime('now'), 'new', 1, 1, 'square', datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          first_name = COALESCE(excluded.first_name, retail_customers.first_name),
          normalized_phone = COALESCE(excluded.normalized_phone, retail_customers.normalized_phone),
          first_visit_date = COALESCE(retail_customers.first_visit_date, excluded.first_visit_date),
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

  // Map Square's order state → our internal status (see processOrderEvent block for context).
  const dailySyncStatus = (() => {
    const s = (o.state || '').toUpperCase();
    if (s === 'COMPLETED') return 'active';
    if (s === 'CANCELED') return 'canceled';
    if (s === 'DRAFT') return 'draft';
    if (s === 'OPEN') return 'open';
    return 'active';
  })();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO orders (
      id, source, order_date, units, sku_breakdown,
      gross_revenue, customer_phone, customer_name, customer_email,
      raw_payload, status, created_at
    ) VALUES (?, 'square', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
    dailySyncStatus,
  ).run();
  await env.DB.prepare(
    "UPDATE orders SET status = ? WHERE id = ? AND COALESCE(status, '') != ?"
  ).bind(dailySyncStatus, `sq_${o.id}`, dailySyncStatus).run().catch(() => {});

  // Update retail profile — skip if order already processed (prevents double-counting)
  // Also skip delivery relay phones and catering-scale orders
  if (customerPhone && !existingOrder) {
    const normalizedPhone = normalizePhone(customerPhone);
    const isCateringScale = total >= 500 || totalItems >= 30;
    if (normalizedPhone && !isDeliveryRelay(normalizedPhone) && !isCateringScale) {
      await updateRetailProfile(normalizedPhone, customerName, total, totalItems, skuBreakdown, orderDate, env);
      await attributeCampaignReturn(normalizedPhone, total, env);
      // Emit campaign signals (catches any missed by webhooks)
      await emitCampaignSignals(normalizedPhone, customerName, total, totalItems, skuBreakdown, orderDate, env);
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

  // Discount redemption tracking (daily sync)
  try {
    const orderDiscounts = o.discounts || [];
    for (const disc of orderDiscounts) {
      if (disc.catalog_object_id) {
        const match = await env.DB.prepare(
          'SELECT id, campaign_id FROM retail_campaign_discounts WHERE square_catalog_id = ? AND status = ?'
        ).bind(disc.catalog_object_id, 'active').first();
        if (match) {
          await env.DB.prepare(
            'UPDATE retail_campaign_discounts SET times_redeemed = times_redeemed + 1 WHERE id = ?'
          ).bind(match.id).run();
          console.log(`[Square-Sync] Discount redeemed → campaign ${match.campaign_id}`);
        }
      }
    }
  } catch {}
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
