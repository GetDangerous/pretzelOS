/**
 * Dangerous Pretzel Co — Retail Agent
 * Cloudflare Worker (cron: daily 8am MT, weekly insight Monday)
 *
 * Reads daily Toast POS data from D1, builds customer profiles,
 * re-engages lapsed customers via Swell SMS, surfaces retail
 * intelligence to Drew, and flags group buyers for catering pipeline.
 *
 * This is NOT a full tool-use loop — it's an analytical pipeline
 * with Claude for personalization. The catering crossover flagging
 * is the key cross-line intelligence piece.
 *
 * IMPORTANT: Only SMS customers who have opted in (sms_consent=1).
 * Configure consent source based on how Toast captures opt-in.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   SWELLCX_API_KEY
 *   DREW_EMAIL
 *   DB, KV
 */

import { getDirectiveFromKV } from './cfo-agent.js';
import { loadBrain } from './brain-loader.js';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const LAPSE_DAYS           = 14;    // Days before customer is considered lapsed
const CHURN_DAYS           = 60;    // Days before customer is considered churned
const REENGAGEMENT_COOLDOWN = 21;   // Min days between re-engagement attempts
const GROUP_ORDER_THRESHOLD = 5;    // Orders with 5+ items → potential catering lead
const VIP_VISIT_COUNT      = 6;     // 6+ visits = VIP segment
const REGULAR_VISIT_COUNT  = 2;     // 2+ visits = regular

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRetailAgent(env));
  },

  // Cross-channel signal queue consumer (real-time retail → catering)
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.type === 'retail_group_order') {
          await processCrossoverSignal(message.body, env);
          message.ack();
        } else {
          message.ack(); // Unknown type — ack and move on
        }
      } catch (err) {
        console.error('[Retail Queue] Error:', err.message);
        message.retry();
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/retail/run') {
      const result = await runRetailAgent(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/retail/insight') {
      // Try KV first (cached weekly insight), fall back to generating fresh
      const cached = await env.KV.get('retail_weekly_insight');
      if (cached) {
        return new Response(cached, {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const insight = await generateWeeklyInsight(env);
      return new Response(JSON.stringify(insight || {}), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/retail/crossovers') {
      return getCateringCrossovers(env);
    }
    if (path === '/retail/customers') {
      return getCustomerSegments(env);
    }
    return new Response('Retail Agent', { status: 200 });
  }
};

// ── MAIN RUN ──────────────────────────────────────────────────────────────────
async function runRetailAgent(env) {
  // ── BUSINESS BRAIN ────────────────────────────────────────────────────────
  const brainContext = await loadBrain(env, 'retail');
  console.log('[Retail] Brain loaded:', brainContext ? brainContext.split('\n').length + ' lines' : 'empty');

  // ── CFO DIRECTIVE ──────────────────────────────────────────────────────────
  const directive = await getDirectiveFromKV(env.KV);
  const retailDirective = directive?.retail_directive || null;
  const cashAlert = directive?.cash_alert === 1;

  if (retailDirective) {
    console.log(`[Retail] CFO retail_directive: ${retailDirective}`);
  }
  if (cashAlert) {
    console.log('[Retail] CFO cash_alert=1 — prioritizing revenue activities (crossovers, re-engagement)');
  }
  console.log(`[Retail] CFO directive loaded: ${directive ? 'active' : 'none'}`);

  console.log('[Retail] Starting daily run...');

  const results = {
    customers_updated: 0,
    lapsed_found: 0,
    reengagements_sent: 0,
    crossovers_flagged: 0,
    weekly_insight: false,
  };

  // Step 1: Ingest yesterday's Toast orders → update customer profiles
  results.customers_updated = await ingestAndUpdateProfiles(env);

  if (cashAlert) {
    // Cash alert: prioritize revenue — crossovers first, then re-engagement
    results.crossovers_flagged = await flagCateringCrossovers(env);
    const { lapsed, sent } = await reengageLapsedCustomers(env, brainContext);
    results.lapsed_found = lapsed;
    results.reengagements_sent = sent;
  } else {
    // Normal order: re-engagement first, then crossovers
    const { lapsed, sent } = await reengageLapsedCustomers(env, brainContext);
    results.lapsed_found = lapsed;
    results.reengagements_sent = sent;
    results.crossovers_flagged = await flagCateringCrossovers(env);
  }

  // Step 4: Monday only — generate weekly retail insight
  const today = new Date();
  if (today.getDay() === 1) { // Monday
    await generateWeeklyInsight(env, brainContext);
    results.weekly_insight = true;
  }

  // Update metrics
  await env.DB.prepare(`
    UPDATE performance_metrics
    SET retail_reengagements_sent = retail_reengagements_sent + ?,
        retail_crossovers_found = retail_crossovers_found + ?
    WHERE week_start = date('now', 'weekday 1', '-7 days')
  `).bind(results.reengagements_sent, results.crossovers_flagged).run();

  console.log(`[Retail] Done:`, results);
  return results;
}

// ── STEP 1: INGEST + UPDATE PROFILES ─────────────────────────────────────────
async function ingestAndUpdateProfiles(env) {
  // Read yesterday's Toast orders from D1
  const orders = await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE source = 'toast'
      AND date(order_date) = date('now', '-1 day')
      AND customer_phone IS NOT NULL
  `).all();

  const records = orders.results || [];
  let updated = 0;

  for (const order of records) {
    if (!order.customer_phone) continue;

    const customerId = hashPhone(order.customer_phone);
    const existing = await env.DB.prepare(
      'SELECT * FROM retail_customers WHERE id = ?'
    ).bind(customerId).first();

    // Parse SKU breakdown if available
    let skuData = {};
    try { skuData = JSON.parse(order.sku_breakdown || '{}'); } catch {}
    const topSku = Object.entries(skuData).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const itemCount = order.units || Object.values(skuData).reduce((s, v) => s + v, 0) || 1;

    if (!existing) {
      // New customer
      await env.DB.prepare(`
        INSERT INTO retail_customers (
          id, phone, visit_count, total_lifetime_value,
          avg_order_value, avg_items_per_order, favorite_sku,
          largest_single_order, first_visit_date, last_visit_date,
          segment, is_group_buyer, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'new', ?, datetime('now'), datetime('now'))
      `).bind(
        customerId,
        order.customer_phone,
        order.gross_revenue || 0,
        order.gross_revenue || 0,
        itemCount,
        topSku,
        itemCount,
        itemCount >= GROUP_ORDER_THRESHOLD ? 1 : 0
      ).run();
    } else {
      // Returning customer — update stats
      const newVisitCount = existing.visit_count + 1;
      const newLTV = existing.total_lifetime_value + (order.gross_revenue || 0);
      const newAvgOrder = newLTV / newVisitCount;
      const newAvgItems = (existing.avg_items_per_order * existing.visit_count + itemCount) / newVisitCount;
      const newLargest = Math.max(existing.largest_single_order || 0, itemCount);
      const segment = calcSegment(newVisitCount, existing.first_visit_date);
      const isGroupBuyer = existing.is_group_buyer || (itemCount >= GROUP_ORDER_THRESHOLD ? 1 : 0);

      await env.DB.prepare(`
        UPDATE retail_customers
        SET visit_count = ?,
            total_lifetime_value = ?,
            avg_order_value = ?,
            avg_items_per_order = ?,
            largest_single_order = ?,
            last_visit_date = datetime('now'),
            segment = ?,
            is_group_buyer = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        newVisitCount, newLTV, newAvgOrder, newAvgItems,
        newLargest, segment, isGroupBuyer, customerId
      ).run();
    }
    updated++;
  }

  // Mark customers who haven't visited recently as lapsed/churned
  await env.DB.prepare(`
    UPDATE retail_customers
    SET segment = CASE
      WHEN julianday('now') - julianday(last_visit_date) >= ? THEN 'churned'
      WHEN julianday('now') - julianday(last_visit_date) >= ? THEN 'lapsed'
      ELSE segment
    END,
    updated_at = datetime('now')
    WHERE segment NOT IN ('churned')
      AND last_visit_date IS NOT NULL
  `).bind(CHURN_DAYS, LAPSE_DAYS).run();

  console.log(`[Retail] Updated ${updated} customer profiles`);
  return updated;
}

// ── STEP 2: RE-ENGAGEMENT ─────────────────────────────────────────────────────
async function reengageLapsedCustomers(env, brainContext = '') {
  // Find lapsed customers who haven't been re-engaged recently
  const lapsedCustomers = await env.DB.prepare(`
    SELECT *
    FROM retail_customers
    WHERE segment = 'lapsed'
      AND sms_consent = 1
      AND (
        reengagement_sent_at IS NULL
        OR julianday('now') - julianday(reengagement_sent_at) >= ?
      )
      AND reengagement_outcome != 'unsubscribed'
    ORDER BY total_lifetime_value DESC
    LIMIT 10
  `).bind(REENGAGEMENT_COOLDOWN).all();

  const customers = lapsedCustomers.results || [];
  let sent = 0;

  for (const customer of customers) {
    try {
      const daysSince = customer.last_visit_date
        ? Math.floor((Date.now() - new Date(customer.last_visit_date)) / 86400000)
        : LAPSE_DAYS;

      // Generate personalized SMS via Claude
      const sms = await generateReengagementSMS(customer, daysSince, env, brainContext);

      // Send via Swell CX
      const swellResult = await sendSwellSMS(customer.phone, sms, env);
      if (!swellResult.success) continue;

      // Update record
      await env.DB.prepare(`
        UPDATE retail_customers
        SET reengagement_sent_at = datetime('now'),
            reengagement_count = reengagement_count + 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(customer.id).run();

      sent++;
      await sleep(500);

    } catch (err) {
      console.error(`[Retail] Re-engagement error for ${customer.id}:`, err.message);
    }
  }

  console.log(`[Retail] Re-engagement: ${customers.length} lapsed, ${sent} SMS sent`);
  return { lapsed: customers.length, sent };
}

async function generateReengagementSMS(customer, daysSince, env, brainContext = '') {
  const skuNames = {
    'SPICY-BEE': 'Spicy Bee',
    'BBK': 'BBK',
    'SAINT': 'Saint',
    'SALTY': 'Salty',
    'KIDS': 'For The Kids',
    'BOMBS': 'Salty Bombs',
  };
  const favoriteName = customer.favorite_sku
    ? (skuNames[customer.favorite_sku] || customer.favorite_sku)
    : null;

  const prompt = `Write a short, genuine SMS re-engagement message for a Dangerous Pretzel Co customer.

Customer profile:
- Visits: ${customer.visit_count}
- Days since last visit: ${daysSince}
- Favorite SKU: ${favoriteName || 'unknown'}
- Avg order: ${customer.avg_items_per_order?.toFixed(1) || '?'} pretzels

About Dangerous Pretzel Co:
- Brand: "RUIN DINNER." — bold, irreverent, local SLC brand
- Location: 352 W 600 S, Salt Lake City · Open Daily 11am-8pm (Fri-Sat til 9)
- Order online: dangerouspretzel.com
- Flavors: Spicy Bee (chili-cheddar, hot honey, jalapeños), BBK (parmesan, garlic, herbs), Saint (cinnamon sugar), Salty, For The Kids

Rules:
- MAX 160 characters (SMS limit — hard limit, count every character)
- Sound like a friend who makes great pretzels, not a marketing bot
- Reference their favorite flavor if known — makes it feel personal
- No "click here", no discount codes, no exclamation spam
- One clear path back: either visit us or order at dangerouspretzel.com
- Dangerous Pretzel voice: direct, a little cheeky, never corporate

Examples of good SMS:
- "Hey — the Spicy Bee misses you. 352 W 600 S, open now."
- "It's been a while. BBK's waiting. dangerouspretzel.com"
- "Fair warning: Saint just came back. dangerouspretzel.com"

Return JSON: {"sms": "..."}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      ...(brainContext ? { system: brainContext } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Claude error ${response.status}`);
  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);
    // Enforce 160 char limit
    return parsed.sms?.slice(0, 160) || 'The Spicy Bee is waiting. dangerouspretzel.com';
  } catch {
    return 'It\'s been a while. Come back. dangerouspretzel.com';
  }
}

// ── STEP 3: CATERING CROSSOVERS ───────────────────────────────────────────────
async function flagCateringCrossovers(env) {
  // Find group buyers not yet flagged for catering
  const groupBuyers = await env.DB.prepare(`
    SELECT rc.*
    FROM retail_customers rc
    WHERE rc.is_group_buyer = 1
      AND rc.catering_flagged = 0
      AND rc.sms_consent = 1  -- we need contact info to do outreach
    ORDER BY rc.largest_single_order DESC, rc.total_lifetime_value DESC
    LIMIT 20
  `).all();

  const buyers = groupBuyers.results || [];
  let flagged = 0;

  for (const buyer of buyers) {
    // Create a catering lead from the retail customer
    const leadId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO catering_leads (
        id, contact_name, contact_email, contact_phone,
        source, source_customer_id,
        status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'retail_crossover', ?, 'prospect',
        ?, datetime('now'), datetime('now'))
    `).bind(
      leadId,
      buyer.first_name || null,
      buyer.email || null,
      buyer.phone,
      buyer.id,
      `Retail crossover: ${buyer.visit_count} visits, largest order ${buyer.largest_single_order} pretzels, LTV $${buyer.total_lifetime_value?.toFixed(0)}`
    ).run();

    // Mark as flagged
    await env.DB.prepare(`
      UPDATE retail_customers
      SET catering_flagged = 1, catering_lead_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(leadId, buyer.id).run();

    flagged++;
  }

  if (flagged > 0) {
    console.log(`[Retail] Flagged ${flagged} group buyers for catering pipeline`);
    await env.KV.put('retail_crossover_alert', JSON.stringify({
      count: flagged,
      timestamp: new Date().toISOString(),
      message: `${flagged} retail customers flagged as catering leads based on group order history`,
    }));
  }

  return flagged;
}

// ── STEP 4: WEEKLY INSIGHT (MONDAY) ──────────────────────────────────────────
async function generateWeeklyInsight(env, brainContext = '') {
  const [skuStats, timeStats, customerStats] = await Promise.all([
    env.DB.prepare(`
      SELECT
        json_extract(sku_breakdown, '$') as sku_data,
        SUM(gross_revenue) as revenue,
        COUNT(*) as orders,
        AVG(units) as avg_units
      FROM orders
      WHERE source = 'toast'
        AND order_date >= date('now', '-7 days')
    `).first(),

    env.DB.prepare(`
      SELECT
        strftime('%w', order_date) as day_of_week,
        strftime('%H', order_date) as hour,
        COUNT(*) as orders,
        SUM(gross_revenue) as revenue
      FROM orders
      WHERE source = 'toast'
        AND order_date >= date('now', '-7 days')
      GROUP BY day_of_week, hour
      ORDER BY orders DESC
      LIMIT 5
    `).all(),

    env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN segment = 'new' THEN 1 ELSE 0 END) as new_customers,
        SUM(CASE WHEN segment = 'regular' THEN 1 ELSE 0 END) as regular,
        SUM(CASE WHEN segment = 'vip' THEN 1 ELSE 0 END) as vip,
        SUM(CASE WHEN segment = 'lapsed' THEN 1 ELSE 0 END) as lapsed,
        SUM(CASE WHEN is_group_buyer = 1 THEN 1 ELSE 0 END) as group_buyers,
        SUM(CASE WHEN catering_flagged = 1 THEN 1 ELSE 0 END) as catering_crossovers
      FROM retail_customers
    `).first(),
  ]);

  const insightData = {
    week: new Date().toISOString().split('T')[0],
    orders: skuStats?.orders || 0,
    revenue: skuStats?.revenue || 0,
    avg_items: skuStats?.avg_units || 0,
    peak_times: (timeStats.results || []).slice(0, 3),
    customers: customerStats,
  };

  // Claude generates the insight
  const prompt = `Generate a weekly retail intelligence brief for Dangerous Pretzel Co.

Data from the past 7 days:
${JSON.stringify(insightData, null, 2)}

Dangerous Pretzel is a premium SLC soft pretzel shop at 352 W 600 S.
Flavors: Spicy Bee, BBK, Saint, Salty, For The Kids, Salty Bombs.
Also does catering. Growing wholesale program (Delta Center, ski resorts, breweries).

Write a sharp, useful weekly brief for Drew covering:
1. One headline number (the most significant data point)
2. Peak time insight — when is the shop busiest and what does that mean?
3. Customer base health — new vs lapsed ratio, any concern?
4. Cross-sell opportunity — any patterns that suggest catering or wholesale angles?
5. One specific action Drew should take THIS WEEK based on the data

Tone: Direct, specific, no fluff. Like a smart business partner.
Length: 150-200 words max.

Return JSON: {headline, peak_insight, customer_health, crosssell_opportunity, action_this_week}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      ...(brainContext ? { system: brainContext } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const insight = JSON.parse(clean);

    // Save to D1
    await env.DB.prepare(`
      INSERT OR REPLACE INTO retail_insights (
        id, week_start, new_customers, lapsed_count, catering_crossovers,
        total_revenue, insight_summary, created_at
      ) VALUES (?, date('now', 'weekday 1', '-7 days'), ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      customerStats?.new_customers || 0,
      customerStats?.lapsed || 0,
      customerStats?.catering_crossovers || 0,
      skuStats?.revenue || 0,
      JSON.stringify(insight)
    ).run();

    // Store for digest
    await env.KV.put('retail_weekly_insight', JSON.stringify(insight));
    return insight;

  } catch (err) {
    console.error('[Retail] Insight parse error:', err.message);
    return null;
  }
}

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────
async function getCateringCrossovers(env) {
  const crossovers = await env.DB.prepare(`
    SELECT rc.first_name, rc.phone, rc.visit_count, rc.largest_single_order,
           rc.total_lifetime_value, rc.last_visit_date, cl.id as catering_lead_id, cl.status
    FROM retail_customers rc
    LEFT JOIN catering_leads cl ON cl.id = rc.catering_lead_id
    WHERE rc.catering_flagged = 1
    ORDER BY rc.largest_single_order DESC
  `).all();

  return new Response(JSON.stringify(crossovers.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getCustomerSegments(env) {
  const segments = await env.DB.prepare(`
    SELECT segment, COUNT(*) as count,
           AVG(total_lifetime_value) as avg_ltv,
           AVG(visit_count) as avg_visits
    FROM retail_customers
    GROUP BY segment
    ORDER BY count DESC
  `).all();

  return new Response(JSON.stringify(segments.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── SWELL SMS ─────────────────────────────────────────────────────────────────
async function sendSwellSMS(phone, message, env) {
  try {
    const response = await fetch('https://api.swellcx.com/v1/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SWELLCX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phone,
        message,
        from: 'Dangerous Pretzel',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[Retail] Swell error:', err);
      return { success: false };
    }
    return { success: true };
  } catch (err) {
    console.error('[Retail] SMS error:', err.message);
    return { success: false };
  }
}

// ── CROSS-CHANNEL SIGNAL PROCESSOR (Queue consumer) ──────────────────────────
async function processCrossoverSignal(signal, env) {
  const { customer_phone, customer_email, customer_name,
          item_count, order_value, order_date } = signal;

  if (!customer_phone && !customer_email) {
    console.log('[Retail Queue] No contact info — cannot create catering lead');
    return;
  }

  const customerId = customer_phone
    ? hashPhone(customer_phone)
    : `email_${customer_email?.replace(/[^a-z0-9]/gi, '_')}`;

  const existing = await env.DB.prepare(
    'SELECT * FROM retail_customers WHERE id = ?'
  ).bind(customerId).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE retail_customers
      SET is_group_buyer = 1,
          largest_single_order = MAX(COALESCE(largest_single_order, 0), ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(item_count, customerId).run();
  } else {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO retail_customers
      (id, phone, email, first_name, visit_count, total_lifetime_value,
       avg_items_per_order, largest_single_order, is_group_buyer,
       first_visit_date, last_visit_date, segment, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, datetime('now'), datetime('now'), 'new', datetime('now'), datetime('now'))
    `).bind(
      customerId, customer_phone || null, customer_email || null,
      customer_name || null, order_value || 0, item_count, item_count
    ).run();
  }

  // Check if already flagged for catering
  const alreadyFlagged = await env.DB.prepare(
    'SELECT id FROM retail_customers WHERE id = ? AND catering_flagged = 1'
  ).bind(customerId).first();
  if (alreadyFlagged) return;

  // Create catering lead
  const leadId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO catering_leads (
      id, contact_name, contact_email, contact_phone,
      source, source_customer_id, status, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'retail_crossover', ?, 'prospect', ?, datetime('now'), datetime('now'))
  `).bind(
    leadId,
    customer_name || null,
    customer_email || null,
    customer_phone || null,
    customerId,
    `Real-time crossover: bought ${item_count} pretzels ($${order_value?.toFixed(0) || '?'}) on ${new Date(order_date).toLocaleDateString()}`
  ).run();

  // Mark customer as flagged
  await env.DB.prepare(`
    UPDATE retail_customers
    SET catering_flagged = 1, catering_lead_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(leadId, customerId).run();

  // Alert to KV for dashboard
  const alertRaw = await env.KV.get('retail_crossover_alert');
  const alerts = alertRaw ? JSON.parse(alertRaw) : { count: 0, leads: [] };
  alerts.count += 1;
  alerts.leads.push({
    lead_id: leadId,
    name: customer_name || 'Unknown',
    item_count,
    order_value,
    flagged_at: new Date().toISOString(),
  });
  alerts.leads = alerts.leads.slice(-10);
  await env.KV.put('retail_crossover_alert', JSON.stringify(alerts), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  console.log(`[Retail Queue] Crossover lead created: ${customer_name || customer_phone} (${item_count} items)`);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function calcSegment(visitCount, firstVisitDate) {
  const daysSinceFirst = firstVisitDate
    ? Math.floor((Date.now() - new Date(firstVisitDate)) / 86400000)
    : 0;

  if (visitCount >= VIP_VISIT_COUNT) return 'vip';
  if (visitCount >= REGULAR_VISIT_COUNT) return 'regular';
  return 'new';
}

function hashPhone(phone) {
  // Simple normalization — strip everything except digits
  const normalized = phone.replace(/\D/g, '');
  return `rc_${normalized}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
