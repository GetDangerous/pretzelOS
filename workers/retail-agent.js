/**
 * Dangerous Pretzel Co — Retail Agent
 * Cloudflare Worker (cron: daily 8am MT, weekly insight Monday)
 *
 * Full autonomous retail business unit:
 *   1. Daily profile updates from Square orders (via square-sync-worker)
 *   2. Churn risk scoring + CLV prediction (daily)
 *   3. SKU analytics rollup (daily)
 *   4. Campaign engine (onboarding, win-back, VIP, upsell)
 *   5. Re-engagement of lapsed customers via Swell SMS
 *   6. Catering crossover detection
 *   7. Weekly structured intelligence (Monday, Claude Sonnet)
 *   8. Monthly deep analysis (1st of month)
 *   9. Goal tracking + CFO data reporting
 *
 * TCPA: Only SMS customers with sms_eligible=1 AND not in sms_suppressions.
 * Every send loop checks suppressions first — non-negotiable.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY, SWELLCX_API_KEY, DREW_EMAIL
 *   DB, KV, SIGNAL_QUEUE, RETAIL_BACKFILL (Workflow binding)
 */

import { getDirectiveFromKV } from './cfo-agent.js';
import { loadBrain } from './brain-loader.js';

// ── CONFIG ────────────────────────────────────────────────────────
const LAPSE_DAYS            = 14;
const CHURN_DAYS            = 60;
const REENGAGEMENT_COOLDOWN = 21;
const GROUP_ORDER_THRESHOLD = 5;
const VIP_VISIT_COUNT       = 4;
const REGULAR_VISIT_COUNT   = 2;

// Delivery platform relay phones — these are shared across hundreds/thousands
// of different customers and must never create or update a retail_customer profile.
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
    ctx.waitUntil(runRetailAgent(env));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.type === 'retail_group_order') {
          await processCrossoverSignal(message.body, env);
          message.ack();
        } else {
          message.ack();
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

    // ── Core endpoints ──────────────────────────────────────
    if (path === '/retail/run') {
      const result = await runRetailAgent(env);
      return jsonResponse(result);
    }
    if (path === '/retail/insight') {
      const cached = await env.KV.get('retail_weekly_insight');
      if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json' } });
      const insight = await generateWeeklyInsight(env);
      return jsonResponse(insight || {});
    }
    if (path === '/retail/crossovers') return getCateringCrossovers(env);
    if (path === '/retail/customers') return getCustomerSegments(env);

    // ── Dashboard (aggregated single call) ───────────────────
    if (path === '/retail/dashboard') return getDashboardData(env);

    // ── Campaigns ────────────────────────────────────────────
    if (path === '/retail/campaigns' && request.method === 'GET') return getCampaigns(env);
    if (path === '/retail/campaigns' && request.method === 'POST') return createCampaign(request, env);
    if (path === '/retail/campaigns/approve' && request.method === 'POST') return approveCampaign(request, env);
    if (path === '/retail/campaigns/reject' && request.method === 'POST') return rejectCampaign(request, env);

    // ── Goals ────────────────────────────────────────────────
    if (path === '/retail/goals' && request.method === 'GET') return getGoals(env);
    if (path === '/retail/goals' && request.method === 'POST') return createOrUpdateGoal(request, env);

    // ── Intelligence ─────────────────────────────────────────
    if (path === '/retail/menu-analytics') return getMenuAnalytics(env);
    if (path === '/retail/churn-watch') return getChurnWatch(env);
    if (path === '/retail/health') return getCustomerHealth(env);
    if (path === '/retail/top-customers') return getTopCustomers(env);

    // ── Backfill trigger ─────────────────────────────────────
    if (path === '/retail/backfill/start' && request.method === 'POST') return startBackfill(env);
    if (path.startsWith('/retail/backfill/status/')) {
      const workflowId = path.split('/').pop();
      return getBackfillStatus(workflowId, env);
    }

    // ── Order backfill (Phase 1 — writes Toast orders to orders table) ──
    if (path === '/retail/backfill/orders' && request.method === 'POST') return backfillOrderRows(env);

    // ── Profile rebuild (data integrity fix) ──────────────────
    if (path === '/retail/rebuild-profiles') {
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const limit = parseInt(url.searchParams.get('limit') || '500');
      return rebuildProfilesFromOrders(env, offset, limit);
    }

    // ── Proactive alerts (Phase 4 — Today page integration) ──
    if (path === '/retail/alerts') return getRetailAlerts(env);

    // ── Analytics endpoints (Phase 2) ───────────────────────
    if (path === '/retail/monthly-trends') return getMonthlyTrends(env);
    if (path === '/retail/loyalty-funnel') return getLoyaltyFunnel(env);
    if (path === '/retail/magic-number') return getMagicNumber(env);
    if (path === '/retail/time-to-return') return getTimeToReturn(env);
    if (path === '/retail/cohort-retention') return getCohortRetention(env);
    if (path === '/retail/revenue-health') return getRevenueHealth(env);
    if (path === '/retail/menu-loyalty') return getMenuLoyalty(env);
    if (path === '/retail/ticket-drivers') return getTicketDrivers(env);

    // ── Swell opt-out webhook ────────────────────────────────
    if (path === '/swell/webhook' && request.method === 'POST') return handleSwellWebhook(request, env);

    return new Response('Retail Agent', { status: 200 });
  }
};

// ── MAIN RUN ──────────────────────────────────────────────────────
async function runRetailAgent(env) {
  const brainContext = await loadBrain(env, 'retail');
  console.log('[Retail] Brain loaded:', brainContext ? brainContext.split('\n').length + ' lines' : 'empty');

  const directive = await getDirectiveFromKV(env.KV);
  const retailDirective = directive?.retail_directive || null;
  const cashAlert = directive?.cash_alert === 1;
  const growthBrake = directive?.growth_brake === 1;
  const retailPriority = directive?.retail_priority || 3;

  if (retailDirective) console.log(`[Retail] CFO retail_directive: ${retailDirective}`);
  if (cashAlert) console.log('[Retail] CFO cash_alert=1 — retention only');
  if (growthBrake) console.log('[Retail] CFO growth_brake=1 — reducing send limits');
  console.log(`[Retail] CFO retail_priority: ${retailPriority}`);

  console.log('[Retail] Starting daily run...');

  const results = {
    customers_updated: 0,
    churn_scores_updated: 0,
    lapsed_found: 0,
    reengagements_sent: 0,
    crossovers_flagged: 0,
    campaigns_processed: 0,
    drip_sends: 0,
    onboarding_enrolled: 0,
    vip_milestones: 0,
    campaigns_proposed: 0,
    weekly_insight: false,
    monthly_analysis: false,
  };

  // Step 1: Ingest + update profiles (now from Square via square-sync-worker)
  results.customers_updated = await ingestAndUpdateProfiles(env);

  // Step 2: Churn risk scoring + CLV prediction
  results.churn_scores_updated = await updateChurnScoresAndCLV(env);

  // Step 2.5: Momentum scoring + behavior type classification
  results.momentum_updated = await updateMomentumAndBehavior(env);

  // Step 2.6: Predictive churn — 7-day churn probability for at-risk customers
  results.churn_predictions = await updateChurnPredictions(env);

  // Step 2.7: Win-back intelligence — track re-churns after successful win-backs
  results.rechurns_flagged = await trackWinbackRechurns(env);

  // Step 3: SKU analytics rollup
  await rollupDailySkuAnalytics(env);

  // Step 4: Trigger-based campaigns (onboarding, VIP milestones)
  if (!cashAlert) {
    results.onboarding_enrolled = await triggerOnboardingCampaigns(env);
    results.vip_milestones = await triggerVIPMilestones(env, brainContext);
  }

  // Step 5: Process drip sequences (send next message in multi-step campaigns)
  if (!cashAlert) {
    results.drip_sends = await processDripSequences(env, brainContext);
  }

  // Step 6: Campaign sends for immediate campaigns
  if (!cashAlert) {
    results.campaigns_processed = await processCampaignSends(env, brainContext);
  }

  // Step 7: Re-engagement
  if (cashAlert) {
    results.crossovers_flagged = await flagCateringCrossovers(env);
    const { lapsed, sent } = await reengageLapsedCustomers(env, brainContext);
    results.lapsed_found = lapsed;
    results.reengagements_sent = sent;
  } else {
    const { lapsed, sent } = await reengageLapsedCustomers(env, brainContext);
    results.lapsed_found = lapsed;
    results.reengagements_sent = sent;
    results.crossovers_flagged = await flagCateringCrossovers(env);
  }

  // Step 8: Autonomous campaign proposals (agent identifies opportunities)
  if (!cashAlert) {
    results.campaigns_proposed = await proposeCampaigns(env);
  }

  // Step 9: Goal progress check
  await updateGoalProgress(env);

  // Step 10: Segment migration (update lapsed/churned)
  await updateSegments(env);

  // Step 11: Monday — weekly insight + campaign learnings + pattern discovery
  const today = new Date();
  if (today.getDay() === 1) {
    await updateCampaignLearnings(env);
    await generateWeeklyInsight(env, brainContext);
    results.weekly_insight = true;
    await writeCFOReport(env);
  }

  // Step 12: 1st of month — monthly analysis
  if (today.getDate() === 1) {
    await generateMonthlyAnalysis(env, brainContext);
    results.monthly_analysis = true;
  }

  // Update metrics
  try {
    await env.DB.prepare(`
      UPDATE performance_metrics
      SET retail_reengagements_sent = retail_reengagements_sent + ?,
          retail_crossovers_found = retail_crossovers_found + ?
      WHERE week_start = date('now', 'weekday 1', '-7 days')
    `).bind(results.reengagements_sent, results.crossovers_flagged).run();
  } catch {}

  console.log('[Retail] Done:', results);
  return results;
}

// ── CHURN SCORING + CLV ──────────────────────────────────────────
async function updateChurnScoresAndCLV(env) {
  const customers = await env.DB.prepare(`
    SELECT id, visit_count, last_visit_date, order_frequency_days,
           last_order_skus, visits_by_quarter, total_lifetime_value,
           avg_order_value, churn_risk_score
    FROM retail_customers
    WHERE visit_count >= 1
  `).all();

  const records = customers.results || [];
  const now = Date.now();
  const stmts = [];

  for (const c of records) {
    const score = calculateChurnScore(c, now);
    const clv = calculateCLV(c, score);

    stmts.push(
      env.DB.prepare(`
        UPDATE retail_customers
        SET churn_risk_score = ?, predicted_clv = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(score, clv, c.id)
    );

    if (stmts.length >= 100) {
      await env.DB.batch(stmts.splice(0));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  console.log(`[Retail] Updated churn scores for ${records.length} customers`);
  return records.length;
}

function calculateChurnScore(customer, nowMs = Date.now()) {
  if (!customer.order_frequency_days || customer.visit_count < 2) {
    return 30; // Not enough history
  }

  const daysSinceLastVisit = customer.last_visit_date
    ? Math.floor((nowMs - new Date(customer.last_visit_date)) / 86400000)
    : 999;

  const overdueFactor = daysSinceLastVisit / customer.order_frequency_days;
  const baseScore = Math.min(overdueFactor * 50, 50);

  // Value decay
  let valueDecay = 0;
  try {
    const recentOrders = JSON.parse(customer.last_order_skus || '[]');
    if (recentOrders.length >= 3) {
      const values = recentOrders.map(o => o.value || 0);
      const trend = (values[0] - values[values.length - 1]) / (values[values.length - 1] || 1);
      if (trend < -0.1) valueDecay = Math.min(Math.abs(trend) * 100, 20);
    }
  } catch {}

  const rawScore = baseScore + valueDecay;

  // Hard rules
  if (daysSinceLastVisit > 90) return Math.max(rawScore, 90);
  if (daysSinceLastVisit > 60) return Math.max(rawScore, 70);

  // Seasonal check
  try {
    const quarters = JSON.parse(customer.visits_by_quarter || '{}');
    const currentQuarter = `Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
    const totalVisits = Object.values(quarters).reduce((a, b) => a + b, 0);
    const quarterVisits = quarters[currentQuarter] || 0;
    if (totalVisits > 0 && quarterVisits === 0 && customer.visit_count >= 3) {
      return Math.min(Math.round(rawScore), 40); // Seasonal — cap
    }
  } catch {}

  return Math.round(Math.min(rawScore, 100));
}

function calculateCLV(customer, churnScore = 0) {
  if (!customer.visit_count || customer.visit_count < 1) return 0;

  const avgOrderValue = customer.avg_order_value ||
    (customer.total_lifetime_value ? customer.total_lifetime_value / customer.visit_count : 0);

  let predictedVisits90d;
  try {
    const quarters = JSON.parse(customer.visits_by_quarter || '{}');
    const currentQuarter = `Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
    const historicalQuarterVisits = quarters[currentQuarter] || 0;

    const avgVisitsPer90d = customer.order_frequency_days && customer.order_frequency_days > 0
      ? 90 / customer.order_frequency_days
      : customer.visit_count / 6;

    predictedVisits90d = (historicalQuarterVisits * 0.5) + (avgVisitsPer90d * 0.5);
  } catch {
    predictedVisits90d = customer.order_frequency_days && customer.order_frequency_days > 0
      ? 90 / customer.order_frequency_days
      : 1;
  }

  const churnMultiplier = 1 - (churnScore / 150);
  return Math.round(avgOrderValue * predictedVisits90d * churnMultiplier * 100) / 100;
}

// ── SKU ANALYTICS DAILY ROLLUP ───────────────────────────────────
async function rollupDailySkuAnalytics(env) {
  // Get yesterday's orders and roll up by SKU into current week
  const weekStart = getWeekStart(new Date().toISOString());

  const orders = await env.DB.prepare(`
    SELECT sku_breakdown, gross_revenue, units, customer_phone, order_date
    FROM orders
    WHERE date(order_date) = date('now', '-1 day')
      AND sku_breakdown IS NOT NULL
  `).all();

  const records = orders.results || [];
  if (records.length === 0) return;

  const skuStats = {};

  for (const order of records) {
    let skus;
    try { skus = JSON.parse(order.sku_breakdown); } catch { continue; }

    const hour = new Date(order.order_date).getUTCHours();
    const dow = new Date(order.order_date).getUTCDay();
    const orderSkus = Object.keys(skus);

    for (const [sku, qty] of Object.entries(skus)) {
      if (!skuStats[sku]) {
        skuStats[sku] = {
          units: 0, revenue: 0, buyers: new Set(),
          hours: [], days: [], pairedSkus: {},
        };
      }
      const s = skuStats[sku];
      s.units += qty;
      if (order.units > 0) {
        s.revenue += (order.gross_revenue / order.units) * qty;
      }
      if (order.customer_phone) s.buyers.add(order.customer_phone);
      s.hours.push(hour);
      s.days.push(dow);

      // Combo tracking
      for (const otherSku of orderSkus) {
        if (otherSku !== sku) {
          s.pairedSkus[otherSku] = (s.pairedSkus[otherSku] || 0) + 1;
        }
      }
    }
  }

  // Upsert into retail_menu_analytics for this week
  for (const [sku, stats] of Object.entries(skuStats)) {
    const id = `rma_${weekStart}_${sku}`;
    const peakHour = mode(stats.hours);
    const peakDay = mode(stats.days);
    const morningPct = stats.hours.filter(h => h < 12).length / (stats.hours.length || 1);
    const weekendPct = stats.days.filter(d => d === 0 || d === 5 || d === 6).length / (stats.days.length || 1);
    const topPair = Object.entries(stats.pairedSkus).sort((a, b) => b[1] - a[1])[0];

    await env.DB.prepare(`
      INSERT INTO retail_menu_analytics (
        id, week_start, sku, units_sold, revenue, unique_buyers,
        peak_hour, peak_day_of_week, morning_pct, weekend_pct,
        most_paired_sku, pair_frequency, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        units_sold = retail_menu_analytics.units_sold + excluded.units_sold,
        revenue = retail_menu_analytics.revenue + excluded.revenue,
        unique_buyers = MAX(retail_menu_analytics.unique_buyers, excluded.unique_buyers),
        peak_hour = excluded.peak_hour,
        peak_day_of_week = excluded.peak_day_of_week,
        morning_pct = excluded.morning_pct,
        weekend_pct = excluded.weekend_pct,
        most_paired_sku = excluded.most_paired_sku,
        pair_frequency = excluded.pair_frequency
    `).bind(
      id, weekStart, sku,
      stats.units,
      Math.round(stats.revenue * 100) / 100,
      stats.buyers.size,
      peakHour, peakDay,
      Math.round(morningPct * 100) / 100,
      Math.round(weekendPct * 100) / 100,
      topPair ? topPair[0] : null,
      topPair ? topPair[1] : 0,
    ).run();
  }

  console.log(`[Retail] SKU rollup: ${Object.keys(skuStats).length} SKUs from ${records.length} orders`);
}

// ── CAMPAIGN ENGINE ──────────────────────────────────────────────
async function processCampaignSends(env, brainContext) {
  // Check CFO directives for send limit adjustments
  const directive = await getDirectiveFromKV(env.KV);
  const growthBrake = directive?.growth_brake === 1;
  const sendLimitMultiplier = growthBrake ? 0.5 : 1.0; // halve sends when brake is on

  // Get active campaigns
  const campaigns = await env.DB.prepare(`
    SELECT * FROM retail_campaigns
    WHERE status = 'active'
      AND (completed_at IS NULL)
    ORDER BY created_at ASC
  `).all();

  const activeCampaigns = campaigns.results || [];
  let processed = 0;

  for (const campaign of activeCampaigns) {
    // Check if campaign is exhausted
    if (campaign.total_budget_sms && campaign.total_sent >= campaign.total_budget_sms) {
      await env.DB.prepare(`
        UPDATE retail_campaigns SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).bind(campaign.id).run();
      await checkCampaignRules(campaign, env);
      continue;
    }

    // Get eligible customers not yet sent
    let targetQuery = `
      SELECT rc.id, rc.phone, rc.normalized_phone, rc.first_name,
             rc.visit_count, rc.favorite_sku, rc.avg_order_value,
             rc.last_visit_date, rc.churn_risk_score, rc.sku_diversity_score
      FROM retail_customers rc
      WHERE rc.sms_eligible = 1
        AND rc.id NOT IN (
          SELECT customer_id FROM retail_campaign_sends WHERE campaign_id = ?
        )
    `;
    const extraBinds = [];

    // Segment filter
    if (campaign.target_segment && campaign.target_segment !== 'all') {
      targetQuery += ` AND rc.segment = ?`;
      extraBinds.push(campaign.target_segment);
    }

    // Additional criteria
    if (campaign.target_criteria) {
      try {
        const criteria = JSON.parse(campaign.target_criteria);
        if (criteria.min_visit_count) { targetQuery += ` AND rc.visit_count >= ?`; extraBinds.push(criteria.min_visit_count); }
        if (criteria.min_ltv) { targetQuery += ` AND rc.total_lifetime_value >= ?`; extraBinds.push(criteria.min_ltv); }
        if (criteria.max_churn_score) { targetQuery += ` AND rc.churn_risk_score <= ?`; extraBinds.push(criteria.max_churn_score); }
      } catch {}
    }

    targetQuery += ` ORDER BY rc.total_lifetime_value DESC LIMIT ?`;

    const effectiveLimit = Math.max(1, Math.floor((campaign.daily_send_limit || 10) * sendLimitMultiplier));
    const targets = await env.DB.prepare(targetQuery)
      .bind(campaign.id, ...extraBinds, effectiveLimit)
      .all();

    const customers = targets.results || [];
    let sent = 0;

    for (const customer of customers) {
      // SUPPRESSION CHECK — non-negotiable
      const suppressed = await env.DB.prepare(
        'SELECT phone FROM sms_suppressions WHERE phone = ?'
      ).bind(customer.normalized_phone).first();
      if (suppressed) continue;

      try {
        // Generate personalized SMS
        const sms = await generateCampaignSMS(customer, campaign, env, brainContext);

        // Determine variant for A/B tests
        let variantId = null;
        if (campaign.message_variants) {
          try {
            const variants = JSON.parse(campaign.message_variants);
            // Random assignment based on weights
            const rand = Math.random();
            let cumWeight = 0;
            for (const v of variants) {
              cumWeight += v.weight;
              if (rand <= cumWeight) { variantId = v.variant_id; break; }
            }
          } catch {}
        }

        // 10% holdout for incrementality measurement
        if (Math.random() < 0.1) {
          // Record as holdout — no SMS sent
          await env.DB.prepare(`
            INSERT INTO retail_campaign_sends (
              id, campaign_id, customer_id, variant_id,
              message_text, outcome, created_at
            ) VALUES (?, ?, ?, 'holdout', '[holdout - no message sent]', 'delivered', datetime('now'))
          `).bind(crypto.randomUUID(), campaign.id, customer.id).run();
          continue;
        }

        // Send via Swell CX
        const swellResult = await sendSwellSMS(customer.phone, sms, env);
        if (!swellResult.success) continue;

        // Record send
        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (
            id, campaign_id, customer_id, variant_id,
            message_text, sent_at, outcome, created_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'))
        `).bind(
          crypto.randomUUID(), campaign.id, customer.id,
          variantId, sms,
        ).run();

        sent++;
        await sleep(500);
      } catch (err) {
        console.error(`[Retail] Campaign send error for ${customer.id}:`, err.message);
      }
    }

    // Update campaign totals
    if (sent > 0) {
      await env.DB.prepare(`
        UPDATE retail_campaigns
        SET total_sent = total_sent + ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(sent, campaign.id).run();
    }

    processed += sent;
    console.log(`[Retail] Campaign "${campaign.name}": ${sent}/${customers.length} sent`);
  }

  return processed;
}

async function generateCampaignSMS(customer, campaign, env, brainContext = '') {
  const skuNames = {
    'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'Saint',
    'SALTY': 'Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
  };
  const favoriteName = customer.favorite_sku
    ? (skuNames[customer.favorite_sku] || customer.favorite_sku)
    : null;

  const daysSince = customer.last_visit_date
    ? Math.floor((Date.now() - new Date(customer.last_visit_date)) / 86400000)
    : null;

  // Load campaign learnings for self-learning message generation
  let learningsContext = '';
  try {
    const learnings = await env.KV.get('retail_campaign_learnings');
    if (learnings) {
      const l = JSON.parse(learnings);
      if (l.best_performing_messages?.length) {
        learningsContext = `\nPast successful messages (learn from these patterns):\n${l.best_performing_messages.slice(0, 3).map(m => `- "${m.text}" (${m.type})`).join('\n')}`;
      }
      if (l.by_behavior_type?.length) {
        const custBehavior = l.by_behavior_type.find(b => b.type === customer.behavior_type);
        if (custBehavior) {
          learningsContext += `\nThis customer type (${customer.behavior_type}) has ${custBehavior.return_rate}% return rate from past campaigns.`;
        }
      }
    }
  } catch {}

  // Behavior-specific messaging guidance
  const behaviorGuide = {
    explorer: 'This customer tries different items — highlight new/rotating items.',
    loyalist: 'This customer orders the same thing — validate their choice, mention their favorite.',
    social: 'This customer orders for groups — use "bring the crew" messaging.',
    opportunist: 'This customer visits during events — mention upcoming events if any.',
    emerging: 'This customer is visiting more often — encourage the trajectory, make them feel like an insider.',
  };
  const behaviorTip = customer.behavior_type && behaviorGuide[customer.behavior_type]
    ? `\nBehavior type: ${customer.behavior_type} — ${behaviorGuide[customer.behavior_type]}`
    : '';

  const prompt = `Write a short SMS for a Dangerous Pretzel Co ${campaign.campaign_type} campaign.

Campaign: "${campaign.name}"
Type: ${campaign.campaign_type}
${campaign.message_template ? `Template guidance: ${campaign.message_template}` : ''}

Customer:
- Name: ${customer.first_name || 'unknown'}
- Visits: ${customer.visit_count}
- Days since last visit: ${daysSince || 'unknown'}
- Favorite: ${favoriteName || 'unknown'}
- Avg order: $${customer.avg_order_value?.toFixed(2) || '?'}${behaviorTip}${learningsContext}

Brand: "RUIN DINNER." — bold, irreverent, local SLC brand
Location: 352 W 600 S, SLC · Open Daily 11am-8pm
Order: dangerouspretzel.com

Rules:
- MAX 160 characters (hard SMS limit)
- Sound like a friend, not marketing
- Reference their favorite if known
- No discount codes, no exclamation spam
- End with: Reply STOP to opt out

Return JSON: {"sms": "..."}`;

  // Try Workers AI first, fall back to Haiku
  let text = null;
  if (env.AI) {
    try {
      const aiResp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: brainContext || 'Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
      });
      text = aiResp?.response || null;
    } catch { text = null; }
  }
  if (!text) {
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
    text = data.content?.[0]?.text || '';
  }

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);
    let sms = parsed.sms || 'The Spicy Bee is waiting. dangerouspretzel.com';
    // Ensure STOP opt-out
    if (!sms.includes('STOP')) {
      sms = sms.slice(0, 130) + ' Reply STOP to opt out';
    }
    return sms.slice(0, 160);
  } catch {
    return 'It\'s been a while. Come back. dangerouspretzel.com Reply STOP to opt out';
  }
}

// Check if campaign type should be auto-approved going forward
async function checkCampaignRules(campaign, env) {
  const rule = await env.DB.prepare(
    'SELECT * FROM retail_campaign_rules WHERE campaign_type = ?'
  ).bind(campaign.campaign_type).first();

  if (!rule || rule.auto_approve) return;

  const newRunsCompleted = rule.runs_completed + 1;

  // Calculate return rate for this campaign
  const returnRate = campaign.total_sent > 0
    ? campaign.total_returned / campaign.total_sent
    : 0;

  // Check opt-out rate (from campaign sends that resulted in unsubscribe)
  const optOuts = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM retail_campaign_sends
    WHERE campaign_id = ? AND outcome = 'unsubscribed'
  `).bind(campaign.id).first();
  const optOutRate = campaign.total_sent > 0
    ? (optOuts?.count || 0) / campaign.total_sent
    : 0;

  const shouldAutoApprove = newRunsCompleted >= rule.min_runs_required
    && returnRate >= rule.min_return_rate
    && optOutRate <= rule.max_opt_out_rate;

  await env.DB.prepare(`
    UPDATE retail_campaign_rules
    SET runs_completed = ?,
        auto_approve = ?,
        proven_at = ?
    WHERE campaign_type = ?
  `).bind(
    newRunsCompleted,
    shouldAutoApprove ? 1 : 0,
    shouldAutoApprove ? new Date().toISOString() : null,
    campaign.campaign_type,
  ).run();

  if (shouldAutoApprove) {
    console.log(`[Retail] Campaign type "${campaign.campaign_type}" proven — auto-approve enabled`);
  }
}

// ── ONBOARDING TRIGGER ───────────────────────────────────────────
// New customers (created in last 24h) with sms_eligible get auto-enrolled
async function triggerOnboardingCampaigns(env) {
  const newCustomers = await env.DB.prepare(`
    SELECT id, phone, normalized_phone, first_name, favorite_sku
    FROM retail_customers
    WHERE sms_eligible = 1
      AND onboarding_complete = 0
      AND created_at >= datetime('now', '-24 hours')
      AND visit_count <= 1
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE campaign_id IN (
          SELECT id FROM retail_campaigns WHERE campaign_type = 'onboarding'
        )
      )
  `).all();

  const customers = newCustomers.results || [];
  if (customers.length === 0) return 0;

  // Find or create the active onboarding campaign
  let campaign = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'onboarding' AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).first();

  if (!campaign) {
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        send_strategy, drip_schedule, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, 'New Customer Onboarding', 'onboarding', 'active', 'new',
        'drip', ?, 50, 'approved',
        'Auto-created onboarding drip for new customers. 3-message sequence: welcome (day 0), menu discovery (day 7), frequency nudge (day 14).',
        datetime('now'), datetime('now'))
    `).bind(id, JSON.stringify([
      { day: 0, type: 'welcome', template: 'Welcome + acknowledge their order' },
      { day: 7, type: 'discovery', template: 'Menu discovery — suggest a different flavor' },
      { day: 14, type: 'frequency', template: 'Frequency nudge — we are here daily' },
    ])).run();
    campaign = { id };
  }

  // Enroll each new customer (create step 0 send placeholder)
  let enrolled = 0;
  for (const customer of customers) {
    // Suppression check
    const suppressed = await env.DB.prepare(
      'SELECT phone FROM sms_suppressions WHERE phone = ?'
    ).bind(customer.normalized_phone).first();
    if (suppressed) continue;

    await env.DB.prepare(`
      INSERT OR IGNORE INTO retail_campaign_sends (
        id, campaign_id, customer_id, variant_id,
        message_text, outcome, created_at
      ) VALUES (?, ?, ?, 'drip_step_0', '[enrolled - pending first send]', 'pending', datetime('now'))
    `).bind(crypto.randomUUID(), campaign.id, customer.id).run();

    await env.DB.prepare(`
      UPDATE retail_customers SET active_campaign_id = ?, updated_at = datetime('now') WHERE id = ?
    `).bind(campaign.id, customer.id).run();

    enrolled++;
  }

  if (enrolled > 0) {
    console.log(`[Retail] Onboarding: enrolled ${enrolled} new customers`);
  }
  return enrolled;
}

// ── VIP MILESTONE TRIGGER ────────────────────────────────────────
// Customers hitting 6th visit get a one-time VIP thank-you SMS
async function triggerVIPMilestones(env, brainContext = '') {
  const newVIPs = await env.DB.prepare(`
    SELECT id, phone, normalized_phone, first_name, favorite_sku, visit_count
    FROM retail_customers
    WHERE segment = 'vip'
      AND sms_eligible = 1
      AND visit_count >= 6
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE campaign_id IN (
          SELECT id FROM retail_campaigns WHERE campaign_type = 'vip_thank_you'
        )
      )
    ORDER BY updated_at DESC
    LIMIT 5
  `).all();

  const customers = newVIPs.results || [];
  if (customers.length === 0) return 0;

  // Find or create VIP campaign
  let campaign = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'vip_thank_you' AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).first();

  if (!campaign) {
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        send_strategy, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, 'VIP Thank You', 'vip_thank_you', 'active', 'vip',
        'immediate', 10, 'approved',
        'Auto-send when customer hits 6th visit. One-time recognition.',
        datetime('now'), datetime('now'))
    `).bind(id).run();
    campaign = { id };
  }

  let sent = 0;
  for (const customer of customers) {
    const suppressed = await env.DB.prepare(
      'SELECT phone FROM sms_suppressions WHERE phone = ?'
    ).bind(customer.normalized_phone).first();
    if (suppressed) continue;

    const skuNames = {
      'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'Saint',
      'SALTY': 'Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
    };
    const fav = customer.favorite_sku ? (skuNames[customer.favorite_sku] || customer.favorite_sku) : null;

    // Simple, genuine VIP message — no Claude needed
    let sms;
    if (fav) {
      sms = `You're a regular now — ${customer.visit_count} visits deep. The ${fav} is always ready for you. Thanks for coming back. Reply STOP to opt out`;
    } else {
      sms = `You're a regular now — ${customer.visit_count} visits deep. That means something to us. Thanks for coming back. Reply STOP to opt out`;
    }
    sms = sms.slice(0, 160);

    const swellResult = await sendSwellSMS(customer.phone, sms, env);
    if (!swellResult.success) continue;

    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (
        id, campaign_id, customer_id, message_text, sent_at, outcome, created_at
      ) VALUES (?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'))
    `).bind(crypto.randomUUID(), campaign.id, customer.id, sms).run();

    sent++;
    await sleep(500);
  }

  if (sent > 0) {
    await env.DB.prepare(`
      UPDATE retail_campaigns SET total_sent = total_sent + ?, updated_at = datetime('now') WHERE id = ?
    `).bind(sent, campaign.id).run();
    console.log(`[Retail] VIP milestones: ${sent} thank-you messages sent`);
  }
  return sent;
}

// ── DRIP SEQUENCE PROCESSOR ──────────────────────────────────────
// For multi-step campaigns (onboarding, winback), send next message at right time
async function processDripSequences(env, brainContext = '') {
  // Get all active drip campaigns
  const dripCampaigns = await env.DB.prepare(`
    SELECT * FROM retail_campaigns
    WHERE status = 'active' AND send_strategy = 'drip' AND drip_schedule IS NOT NULL
  `).all();

  let totalSent = 0;

  for (const campaign of (dripCampaigns.results || [])) {
    let schedule;
    try { schedule = JSON.parse(campaign.drip_schedule); } catch { continue; }

    // For each step in the drip, find customers due for that step
    for (let stepIdx = 0; stepIdx < schedule.length; stepIdx++) {
      const step = schedule[stepIdx];
      const daysAfterEnroll = step.day || 0;

      // Find customers who:
      // - Are enrolled (have step_0 record)
      // - Haven't received this step yet
      // - Were enrolled >= daysAfterEnroll days ago
      const dueCustomers = await env.DB.prepare(`
        SELECT DISTINCT cs.customer_id, rc.phone, rc.normalized_phone, rc.first_name,
               rc.favorite_sku, rc.visit_count, rc.avg_order_value, rc.sku_diversity_score
        FROM retail_campaign_sends cs
        JOIN retail_customers rc ON rc.id = cs.customer_id
        WHERE cs.campaign_id = ?
          AND cs.variant_id = 'drip_step_0'
          AND julianday('now') - julianday(cs.created_at) >= ?
          AND rc.sms_eligible = 1
          AND cs.customer_id NOT IN (
            SELECT customer_id FROM retail_campaign_sends
            WHERE campaign_id = ? AND variant_id = ?
          )
        LIMIT ?
      `).bind(
        campaign.id,
        daysAfterEnroll,
        campaign.id,
        `drip_step_${stepIdx}`,
        campaign.daily_send_limit || 10,
      ).all();

      const customers = dueCustomers.results || [];

      for (const customer of customers) {
        // Suppression check
        const suppressed = await env.DB.prepare(
          'SELECT phone FROM sms_suppressions WHERE phone = ?'
        ).bind(customer.normalized_phone).first();
        if (suppressed) continue;

        // Generate SMS for this drip step
        const sms = await generateDripSMS(customer, campaign, step, stepIdx, env, brainContext);

        const swellResult = await sendSwellSMS(customer.phone, sms, env);
        if (!swellResult.success) continue;

        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (
            id, campaign_id, customer_id, variant_id,
            message_text, sent_at, outcome, created_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'))
        `).bind(
          crypto.randomUUID(), campaign.id, customer.customer_id,
          `drip_step_${stepIdx}`, sms,
        ).run();

        totalSent++;
        await sleep(500);

        // If this was the last step, mark onboarding complete
        if (stepIdx === schedule.length - 1) {
          await env.DB.prepare(`
            UPDATE retail_customers
            SET onboarding_complete = 1, active_campaign_id = NULL, updated_at = datetime('now')
            WHERE id = ?
          `).bind(customer.customer_id).run();
        }
      }
    }

    // Update campaign send count
    if (totalSent > 0) {
      await env.DB.prepare(`
        UPDATE retail_campaigns SET total_sent = total_sent + ?, updated_at = datetime('now') WHERE id = ?
      `).bind(totalSent, campaign.id).run();
    }
  }

  if (totalSent > 0) {
    console.log(`[Retail] Drip sequences: ${totalSent} messages sent`);
  }
  return totalSent;
}

async function generateDripSMS(customer, campaign, step, stepIdx, env, brainContext = '') {
  const skuNames = {
    'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'Saint',
    'SALTY': 'Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
  };
  const fav = customer.favorite_sku ? (skuNames[customer.favorite_sku] || customer.favorite_sku) : null;

  // For onboarding, use tight pre-defined templates to save API calls
  if (campaign.campaign_type === 'onboarding') {
    if (stepIdx === 0) {
      // Welcome — acknowledge their order
      if (fav) {
        return `Good call on the ${fav}. We're Dangerous Pretzel — 352 W 600 S, SLC. Open daily 11-8. See you again. Reply STOP to opt out`.slice(0, 160);
      }
      return `Welcome to Dangerous Pretzel. 352 W 600 S, SLC — open daily 11-8. Order anytime at dangerouspretzel.com. Reply STOP to opt out`.slice(0, 160);
    }
    if (stepIdx === 1) {
      // Menu discovery — suggest different flavor
      const suggestions = {
        'SPICY-BEE': 'The BBK is the quiet legend — parmesan, garlic, herbs. Try it next.',
        'BBK': 'If you liked BBK, the Spicy Bee is the bold one — chili-cheddar + hot honey.',
        'SAINT': 'You went sweet. The Spicy Bee is the opposite — chili-cheddar, hot honey, jalapeños.',
        'SALTY': 'Classic choice. The Saint is cinnamon sugar — dangerously good with coffee.',
        'KIDS': 'Next time, grab a Spicy Bee for yourself. You earned it.',
        'BOMBS': 'Bombs fan? The Spicy Bee pretzel is the full-size version of bold.',
      };
      const suggestion = fav && suggestions[customer.favorite_sku]
        ? suggestions[customer.favorite_sku]
        : 'We have 6 flavors — Spicy Bee is the crowd favorite. dangerouspretzel.com';
      return `${suggestion} Reply STOP to opt out`.slice(0, 160);
    }
    if (stepIdx === 2) {
      // Frequency nudge
      return `We're here every day 11-8 (Fri-Sat til 9). 352 W 600 S, SLC. Order ahead: dangerouspretzel.com. Reply STOP to opt out`.slice(0, 160);
    }
  }

  // For winback drips, use Claude for personalization
  if (campaign.campaign_type === 'winback') {
    const daysSince = customer.last_visit_date
      ? Math.floor((Date.now() - new Date(customer.last_visit_date)) / 86400000)
      : 14;

    const stepDescriptions = ['gentle reminder', 'urgency — it has been a while', 'final — door is always open'];
    const prompt = `Write a ${stepDescriptions[stepIdx] || 'follow-up'} SMS for a Dangerous Pretzel Co win-back campaign.

Step ${stepIdx + 1} of 3. Customer: ${customer.first_name || 'unknown'}, ${daysSince} days since last visit, favorite: ${fav || 'unknown'}.
Brand: "RUIN DINNER." 352 W 600 S, SLC. dangerouspretzel.com
MAX 160 chars. End with: Reply STOP to opt out
Return JSON: {"sms": "..."}`;

    let text = null;
    if (env.AI) {
      try {
        const aiResp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [{ role: 'system', content: 'Return valid JSON only.' }, { role: 'user', content: prompt }],
          max_tokens: 200,
        });
        text = aiResp?.response || null;
      } catch { text = null; }
    }
    if (!text) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (response.ok) {
        const data = await response.json();
        text = data.content?.[0]?.text || '';
      }
    }

    try {
      const clean = (text || '').replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(clean);
      let sms = parsed.sms || '';
      if (!sms.includes('STOP')) sms = sms.slice(0, 130) + ' Reply STOP to opt out';
      return sms.slice(0, 160);
    } catch {}
  }

  // Fallback
  return `Dangerous Pretzel Co — 352 W 600 S, SLC. Open daily 11-8. dangerouspretzel.com Reply STOP to opt out`.slice(0, 160);
}

// ── AUTONOMOUS CAMPAIGN PROPOSALS ────────────────────────────────
// Agent analyzes data and proposes campaigns that need Drew's approval
async function proposeCampaigns(env) {
  let proposed = 0;

  // Load past campaign performance for learning loop
  const pastPerformance = await env.DB.prepare(`
    SELECT campaign_type,
           COUNT(*) as campaigns_run,
           AVG(CASE WHEN total_sent > 0 THEN CAST(total_returned AS REAL) / total_sent ELSE 0 END) as avg_return_rate,
           SUM(total_revenue_attributed) as total_revenue,
           AVG(roi_estimate) as avg_roi
    FROM retail_campaigns
    WHERE status = 'completed'
    GROUP BY campaign_type
  `).all();
  const perf = {};
  (pastPerformance.results || []).forEach(p => { perf[p.campaign_type] = p; });

  // 1. Win-back: If lapsed VIPs exist and no active winback campaign
  const lapsedVIPs = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM retail_customers
    WHERE segment = 'lapsed'
      AND visit_count >= 6
      AND sms_eligible = 1
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE campaign_id IN (SELECT id FROM retail_campaigns WHERE campaign_type = 'winback' AND status IN ('active', 'pending_approval'))
      )
  `).first();

  const activeWinback = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'winback' AND status IN ('active', 'pending_approval')
  `).first();

  if ((lapsedVIPs?.count || 0) >= 3 && !activeWinback) {
    // Check if auto-approve is enabled
    const rule = await env.DB.prepare(
      'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
    ).bind('winback').first();

    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        target_criteria, estimated_reach,
        send_strategy, drip_schedule, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, ?, 'winback', ?, 'lapsed', ?, ?, 'drip', ?, 5, ?, ?,
        datetime('now'), datetime('now'))
    `).bind(
      id,
      `Win-back: ${lapsedVIPs.count} Lapsed VIPs`,
      rule?.auto_approve ? 'active' : 'pending_approval',
      JSON.stringify({ min_visit_count: 6 }),
      lapsedVIPs.count,
      JSON.stringify([
        { day: 0, type: 'gentle', template: 'Gentle reminder — reference favorite SKU' },
        { day: 7, type: 'urgency', template: 'It has been X weeks' },
        { day: 14, type: 'final', template: 'Door is always open' },
      ]),
      rule?.auto_approve ? 'approved' : 'pending',
      `${lapsedVIPs.count} VIP customers (6+ visits) have lapsed 14+ days.${perf.winback ? ` Past winback campaigns: ${perf.winback.campaigns_run} run, ${Math.round(perf.winback.avg_return_rate * 100)}% return rate, ${perf.winback.avg_roi ? perf.winback.avg_roi.toFixed(1) + 'x ROI' : 'ROI pending'}.` : ' First winback — high-LTV customers respond best to personalized re-engagement.'}`,
    ).run();

    proposed++;
    console.log(`[Retail] Proposed winback campaign for ${lapsedVIPs.count} lapsed VIPs`);
  }

  // 2. Upsell: Regulars with low SKU diversity (only buy one thing)
  const lowDiversity = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM retail_customers
    WHERE segment IN ('regular', 'vip')
      AND sku_diversity_score <= 1
      AND visit_count >= 3
      AND sms_eligible = 1
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE campaign_id IN (SELECT id FROM retail_campaigns WHERE campaign_type = 'upsell' AND status IN ('active', 'pending_approval'))
      )
  `).first();

  const activeUpsell = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'upsell' AND status IN ('active', 'pending_approval')
  `).first();

  if ((lowDiversity?.count || 0) >= 5 && !activeUpsell) {
    const rule = await env.DB.prepare(
      'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
    ).bind('upsell').first();

    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        target_criteria, estimated_reach,
        send_strategy, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, ?, 'upsell', ?, 'regular', ?, ?, 'immediate', 5, ?, ?,
        datetime('now'), datetime('now'))
    `).bind(
      id,
      `Cross-sell: ${lowDiversity.count} One-SKU Regulars`,
      rule?.auto_approve ? 'active' : 'pending_approval',
      JSON.stringify({ min_visit_count: 3, max_sku_diversity: 1 }),
      lowDiversity.count,
      rule?.auto_approve ? 'approved' : 'pending',
      `${lowDiversity.count} regular customers only ever buy one SKU. They visit 3+ times but haven't explored the menu.${perf.upsell ? ` Past upsell campaigns: ${perf.upsell.campaigns_run} run, ${Math.round(perf.upsell.avg_return_rate * 100)}% conversion.` : ' First upsell — complementary SKU suggestions typically increase basket size 15-25%.'}`,
    ).run();

    proposed++;
    console.log(`[Retail] Proposed upsell campaign for ${lowDiversity.count} low-diversity regulars`);
  }

  // 3. Day 3 Follow-up: New customers 3-5 days after first visit — THE highest ROI campaign
  const day3Candidates = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM retail_customers
    WHERE visit_count = 1
      AND first_visit_date BETWEEN date('now', '-5 days') AND date('now', '-3 days')
      AND sms_eligible = 1
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE campaign_id IN (SELECT id FROM retail_campaigns WHERE campaign_type = 'day3_followup' AND status IN ('active', 'pending_approval'))
      )
  `).first();

  const activeDay3 = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'day3_followup' AND status IN ('active', 'pending_approval')
  `).first();

  if ((day3Candidates?.count || 0) >= 1 && !activeDay3) {
    const rule = await env.DB.prepare(
      'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
    ).bind('day3_followup').first();

    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        target_criteria, estimated_reach,
        send_strategy, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, ?, 'day3_followup', ?, 'new', ?, ?, 'immediate', 10, ?, ?,
        datetime('now'), datetime('now'))
    `).bind(
      crypto.randomUUID(),
      `Day 3 Follow-up: ${day3Candidates.count} New Customers`,
      rule?.auto_approve ? 'active' : 'pending_approval',
      JSON.stringify({ visit_count: 1, days_since_first: '3-5' }),
      day3Candidates.count,
      rule?.auto_approve ? 'approved' : 'pending',
      `${day3Candidates.count} new customers visited 3-5 days ago but haven't returned. This is the #1 highest-ROI campaign — the window to convert first-timers closes fast.${perf.day3_followup ? ` Past day3 campaigns: ${Math.round(perf.day3_followup.avg_return_rate * 100)}% return rate.` : ''}`,
    ).run();
    proposed++;
    console.log(`[Retail] Proposed Day 3 follow-up for ${day3Candidates.count} new customers`);
  }

  // 4. Magic Number Push: Customers 1 visit away from the magic number
  const magicData = await env.DB.prepare(`
    SELECT visit_count, COUNT(*) as total,
           SUM(CASE WHEN segment IN ('churned', 'lapsed') THEN 1 ELSE 0 END) as churned
    FROM retail_customers WHERE visit_count BETWEEN 1 AND 6
    GROUP BY visit_count ORDER BY visit_count
  `).all();
  const rates = (magicData.results || []).map(r => ({
    v: r.visit_count, churn: r.total > 0 ? r.churned / r.total : 0
  }));
  let magicNum = 3;
  let bigDrop = 0;
  for (let i = 1; i < rates.length; i++) {
    const drop = rates[i - 1].churn - rates[i].churn;
    if (drop > bigDrop) { bigDrop = drop; magicNum = rates[i].v; }
  }

  const magicCandidates = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM retail_customers
    WHERE visit_count = ?
      AND segment NOT IN ('churned', 'lapsed')
      AND sms_eligible = 1
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE campaign_id IN (SELECT id FROM retail_campaigns WHERE campaign_type = 'magic_number_push' AND status IN ('active', 'pending_approval'))
      )
  `).bind(magicNum - 1).first();

  const activeMagic = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'magic_number_push' AND status IN ('active', 'pending_approval')
  `).first();

  if ((magicCandidates?.count || 0) >= 3 && !activeMagic) {
    const rule = await env.DB.prepare(
      'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
    ).bind('magic_number_push').first();

    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        target_criteria, estimated_reach,
        send_strategy, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, ?, 'magic_number_push', ?, 'new', ?, ?, 'immediate', 8, ?, ?,
        datetime('now'), datetime('now'))
    `).bind(
      crypto.randomUUID(),
      `Magic Number Push: ${magicCandidates.count} at Visit ${magicNum - 1}`,
      rule?.auto_approve ? 'active' : 'pending_approval',
      JSON.stringify({ visit_count: magicNum - 1, magic_number: magicNum }),
      magicCandidates.count,
      rule?.auto_approve ? 'approved' : 'pending',
      `${magicCandidates.count} customers are at ${magicNum - 1} visits. The magic number is ${magicNum} — after ${magicNum} visits, churn drops ${Math.round(bigDrop * 100)}%. One more visit converts these customers to significantly more loyal.`,
    ).run();
    proposed++;
    console.log(`[Retail] Proposed magic number push for ${magicCandidates.count} customers at visit ${magicNum - 1}`);
  }

  // 5. Cadence Nudge: Regulars who are 1.3x overdue vs their personal pattern (pre-churn intervention)
  const cadenceCandidates = await env.DB.prepare(`
    SELECT COUNT(*) as count
    FROM retail_customers
    WHERE visit_count >= 3
      AND segment NOT IN ('churned', 'lapsed')
      AND momentum_score < -30
      AND sms_eligible = 1
      AND last_visit_date < date('now', '-7 days')
      AND id NOT IN (
        SELECT customer_id FROM retail_campaign_sends
        WHERE sent_at >= date('now', '-14 days')
      )
  `).first();

  const activeCadence = await env.DB.prepare(`
    SELECT id FROM retail_campaigns
    WHERE campaign_type = 'cadence_nudge' AND status IN ('active', 'pending_approval')
  `).first();

  if ((cadenceCandidates?.count || 0) >= 2 && !activeCadence) {
    const rule = await env.DB.prepare(
      'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
    ).bind('cadence_nudge').first();

    await env.DB.prepare(`
      INSERT INTO retail_campaigns (
        id, name, campaign_type, status, target_segment,
        target_criteria, estimated_reach,
        send_strategy, daily_send_limit,
        approval_status, agent_reasoning,
        created_at, updated_at
      ) VALUES (?, ?, 'cadence_nudge', ?, 'regular', ?, ?, 'immediate', 5, ?, ?,
        datetime('now'), datetime('now'))
    `).bind(
      crypto.randomUUID(),
      `Cadence Nudge: ${cadenceCandidates.count} Slowing Regulars`,
      rule?.auto_approve ? 'active' : 'pending_approval',
      JSON.stringify({ min_visits: 3, momentum_below: -30 }),
      cadenceCandidates.count,
      rule?.auto_approve ? 'approved' : 'pending',
      `${cadenceCandidates.count} regulars have negative momentum — their visit gaps are growing. Intervening now before they fully lapse. This is cheaper than win-back.`,
    ).run();
    proposed++;
    console.log(`[Retail] Proposed cadence nudge for ${cadenceCandidates.count} decelerating regulars`);
  }

  return proposed;
}

// ── STEP: INGEST + UPDATE PROFILES ───────────────────────────────
async function ingestAndUpdateProfiles(env) {
  // Square orders now handled by square-sync-worker.js in real-time.
  // This step catches any orders that came in via other sources (manual, etc.)
  const orders = await env.DB.prepare(`
    SELECT *
    FROM orders
    WHERE date(order_date) = date('now', '-1 day')
      AND customer_phone IS NOT NULL
      AND id NOT LIKE 'sq_%'
  `).all();

  const records = orders.results || [];
  let updated = 0;

  for (const order of records) {
    if (!order.customer_phone) continue;

    const normalizedPhone = normalizePhone(order.customer_phone);
    if (!normalizedPhone) continue;
    if (isDeliveryRelay(normalizedPhone)) continue; // Skip delivery platform relay phones
    const customerId = hashPhone(normalizedPhone);

    const existing = await env.DB.prepare(
      'SELECT * FROM retail_customers WHERE id = ?'
    ).bind(customerId).first();

    let skuData = {};
    try { skuData = JSON.parse(order.sku_breakdown || '{}'); } catch {}
    const topSku = Object.entries(skuData).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const itemCount = order.units || Object.values(skuData).reduce((s, v) => s + v, 0) || 1;

    if (!existing) {
      await env.DB.prepare(`
        INSERT INTO retail_customers (
          id, phone, normalized_phone, visit_count, total_lifetime_value,
          avg_order_value, avg_items_per_order, favorite_sku,
          largest_single_order, first_visit_date, last_visit_date,
          segment, is_group_buyer, sms_eligible, sms_consent,
          created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'new', ?, 1, 1, datetime('now'), datetime('now'))
      `).bind(
        customerId, order.customer_phone, normalizedPhone,
        order.gross_revenue || 0, order.gross_revenue || 0,
        itemCount, topSku, itemCount,
        itemCount >= GROUP_ORDER_THRESHOLD ? 1 : 0,
      ).run();
    } else {
      const newVisitCount = existing.visit_count + 1;
      const newLTV = existing.total_lifetime_value + (order.gross_revenue || 0);
      const segment = calcSegment(newVisitCount);

      await env.DB.prepare(`
        UPDATE retail_customers
        SET visit_count = ?, total_lifetime_value = ?,
            avg_order_value = ?, last_visit_date = datetime('now'),
            segment = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        newVisitCount, newLTV, newLTV / newVisitCount,
        segment, customerId,
      ).run();
    }
    updated++;
  }

  console.log(`[Retail] Updated ${updated} non-Square profiles`);
  return updated;
}

// ── STEP: MOMENTUM SCORING + BEHAVIOR TYPE ──────────────────────
async function updateMomentumAndBehavior(env) {
  // Get customers with 3+ visits for momentum analysis
  const customers = await env.DB.prepare(`
    SELECT id, visit_count, order_frequency_days, last_visit_date,
           sku_diversity_score, is_group_buyer, last_order_skus,
           day_of_week_pattern, segment
    FROM retail_customers
    WHERE visit_count >= 2 AND last_visit_date IS NOT NULL
  `).all();

  let updated = 0;
  const stmts = [];

  for (const c of (customers.results || [])) {
    // ── Momentum: are visit gaps shrinking (positive) or growing (negative)?
    let momentum = 0;
    if (c.visit_count >= 3 && c.order_frequency_days > 0) {
      const daysSinceLastVisit = (Date.now() - new Date(c.last_visit_date).getTime()) / 86400000;
      const ratio = daysSinceLastVisit / c.order_frequency_days;
      // ratio < 1 = ahead of schedule (positive), ratio > 1 = overdue (negative)
      momentum = Math.round(Math.max(-100, Math.min(100, (1 - ratio) * 50)));
    } else if (c.visit_count === 2) {
      // For 2-visit customers, just check if they're overdue
      const daysSince = (Date.now() - new Date(c.last_visit_date).getTime()) / 86400000;
      momentum = daysSince < 14 ? 30 : daysSince < 30 ? 0 : -30;
    }

    // ── Behavior type classification
    let behaviorType = 'new';
    const diversity = c.sku_diversity_score || 0;
    const isGroup = c.is_group_buyer === 1;

    if (isGroup && c.visit_count >= 2) {
      behaviorType = 'social';
    } else if (diversity >= 4 && c.visit_count >= 3) {
      behaviorType = 'explorer';
    } else if (diversity <= 2 && c.visit_count >= 3) {
      behaviorType = 'loyalist';
    } else if (momentum > 20 && c.visit_count >= 2) {
      behaviorType = 'emerging';
    } else if (c.visit_count >= 3) {
      behaviorType = c.segment === 'lapsed' || c.segment === 'churned' ? 'opportunist' : 'emerging';
    }

    stmts.push(
      env.DB.prepare(`
        UPDATE retail_customers SET momentum_score = ?, behavior_type = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(momentum, behaviorType, c.id)
    );
    updated++;

    // Batch every 100
    if (stmts.length >= 100) {
      await env.DB.batch(stmts.splice(0));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  console.log(`[Retail] Updated momentum + behavior for ${updated} customers`);
  return updated;
}

// ── STEP 2.6: PREDICTIVE CHURN — 7-day churn probability ────────
async function updateChurnPredictions(env) {
  // Get active customers with enough data to predict
  const customers = await env.DB.prepare(`
    SELECT id, visit_count, order_frequency_days, last_visit_date,
           momentum_score, behavior_type, churn_risk_score
    FROM retail_customers
    WHERE visit_count >= 2
      AND last_visit_date IS NOT NULL
      AND segment NOT IN ('churned')
  `).all();

  const stmts = [];
  let updated = 0;

  for (const c of (customers.results || [])) {
    const daysSince = Math.max(0, (Date.now() - new Date(c.last_visit_date).getTime()) / 86400000);
    const freq = c.order_frequency_days || 30;
    const overdueRatio = daysSince / freq;

    // Compute churn probability based on multiple signals:
    // 1. How overdue they are vs their personal frequency (strongest signal)
    // 2. Momentum trend (negative = decelerating)
    // 3. Visit count (pre-magic-number = fragile)
    // 4. Current churn risk score
    let prob = 0;

    // Overdue ratio: exponential increase
    if (overdueRatio <= 0.5) prob += 0.05;
    else if (overdueRatio <= 1.0) prob += 0.15;
    else if (overdueRatio <= 1.3) prob += 0.35;
    else if (overdueRatio <= 1.6) prob += 0.55;
    else if (overdueRatio <= 2.0) prob += 0.70;
    else prob += 0.85;

    // Momentum penalty: negative momentum increases probability
    const momentum = c.momentum_score || 0;
    if (momentum < -50) prob += 0.15;
    else if (momentum < -20) prob += 0.08;
    else if (momentum > 30) prob -= 0.10;

    // Low visit count = fragile
    if (c.visit_count <= 2) prob += 0.10;
    else if (c.visit_count >= 6) prob -= 0.05;

    // Clamp to 0-1
    prob = Math.max(0, Math.min(1, prob));
    prob = Math.round(prob * 1000) / 1000;

    stmts.push(
      env.DB.prepare(`
        UPDATE retail_customers SET churn_probability_7d = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(prob, c.id)
    );
    updated++;

    if (stmts.length >= 100) {
      await env.DB.batch(stmts.splice(0));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  console.log(`[Retail] Updated churn predictions for ${updated} customers`);
  return updated;
}

// ── WIN-BACK INTELLIGENCE: RECHURN TRACKING ─────────────────────
// For every win-back campaign send that resulted in a return visit,
// check if the customer has subsequently churned again. This tells us
// which win-backs are "sticky" vs "bounce" — critical for improving messaging.
async function trackWinbackRechurns(env) {
  // Find successful winback sends (customer returned) that haven't been checked for re-churn
  const sends = await env.DB.prepare(`
    SELECT rcs.id, rcs.customer_id, rcs.returned_at
    FROM retail_campaign_sends rcs
    JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
    WHERE rc.campaign_type = 'winback'
      AND rcs.returned = 1
      AND rcs.returned_at IS NOT NULL
      AND rcs.rechurn_at IS NULL
      AND julianday('now') - julianday(rcs.returned_at) >= 30
  `).all();

  const results = sends.results || [];
  if (!results.length) return 0;

  const stmts = [];
  let rechurned = 0;

  for (const send of results) {
    // Check if customer has ordered in the 30 days since their return
    const recentOrder = await env.DB.prepare(`
      SELECT id FROM orders
      WHERE customer_id = ?
        AND order_date > ?
        AND order_date <= date(?, '+30 days')
      LIMIT 1
    `).bind(send.customer_id, send.returned_at, send.returned_at).first();

    if (!recentOrder) {
      // Customer returned once but didn't come back again — a "bounce" win-back
      stmts.push(
        env.DB.prepare(`
          UPDATE retail_campaign_sends SET rechurn_at = datetime('now')
          WHERE id = ?
        `).bind(send.id)
      );
      rechurned++;
    }

    if (stmts.length >= 100) {
      await env.DB.batch(stmts.splice(0));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  console.log(`[Retail] Win-back rechurn: checked ${results.length}, ${rechurned} bounced`);
  return rechurned;
}

// ── PROACTIVE ALERTS (for Today page) ────────────────────────────
// Returns actionable retail alerts sorted by priority.
// These appear on the Today page so Drew sees them without opening the Retail tab.
async function getRetailAlerts(env) {
  const alerts = [];

  try {
    // 1. VIP churn risk — highest priority
    const vipAtRisk = await env.DB.prepare(`
      SELECT id, first_name, visit_count, total_lifetime_value, last_visit_date, churn_risk_score
      FROM retail_customers
      WHERE segment = 'vip' AND churn_risk_score >= 60
      ORDER BY total_lifetime_value DESC LIMIT 5
    `).all();
    const vips = vipAtRisk.results || [];
    if (vips.length > 0) {
      const totalLTV = vips.reduce((s, v) => s + (v.total_lifetime_value || 0), 0);
      const names = vips.slice(0, 3).map(v => v.first_name).join(', ');
      alerts.push({
        level: 'critical',
        icon: '🔴',
        text: `${vips.length} VIP${vips.length > 1 ? 's' : ''} at churn risk (${names}). $${Math.round(totalLTV).toLocaleString()} lifetime value at stake.`,
        action: 'retail',
        action_label: 'View Churn Watch',
        priority: 1,
      });
    }

    // 2. Magic number approaching — customers close to the loyalty threshold
    const magicRow = await env.DB.prepare(`
      SELECT visit_count, COUNT(*) as cnt,
        SUM(CASE WHEN segment IN ('churned','lapsed') THEN 1 ELSE 0 END) as churned
      FROM retail_customers WHERE visit_count >= 1 GROUP BY visit_count ORDER BY visit_count
    `).all();
    const rates = (magicRow.results || []).map(r => ({
      visit: r.visit_count,
      churn_rate: r.cnt > 0 ? r.churned / r.cnt : 0,
    }));
    let magicNum = 3;
    let biggestDrop = 0;
    for (let i = 1; i < rates.length && i < 8; i++) {
      const drop = rates[i - 1].churn_rate - rates[i].churn_rate;
      if (drop > biggestDrop) { biggestDrop = drop; magicNum = rates[i].visit; }
    }

    const approaching = await env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM retail_customers
      WHERE visit_count = ? AND segment NOT IN ('churned','lapsed')
    `).bind(Math.max(1, magicNum - 1)).first();
    if (approaching?.cnt > 0) {
      const campaignActive = await env.DB.prepare(`
        SELECT id FROM retail_campaigns
        WHERE campaign_type = 'magic_number_push' AND status IN ('active','pending_approval')
        LIMIT 1
      `).first();
      alerts.push({
        level: 'action',
        icon: '🟡',
        text: `${approaching.cnt} customers at visit ${magicNum - 1} — one more visit to cross the magic number (${magicNum}).${campaignActive ? ' Nudge campaign active.' : ' No campaign running.'}`,
        action: 'retail',
        action_label: campaignActive ? 'View Campaign' : 'Create Campaign',
        priority: 2,
      });
    }

    // 3. Cohort retention trend — are we getting better or worse?
    const recentCohorts = await env.DB.prepare(`
      SELECT
        strftime('%Y-%m', first_visit_date) as cohort_month,
        COUNT(*) as acquired,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as retained
      FROM retail_customers
      WHERE first_visit_date >= date('now', '-90 days')
      GROUP BY cohort_month ORDER BY cohort_month
    `).all();
    const cohorts = recentCohorts.results || [];
    if (cohorts.length >= 2) {
      const rates2 = cohorts.map(c => ({ month: c.cohort_month, rate: c.acquired > 0 ? c.retained / c.acquired : 0 }));
      const latest = rates2[rates2.length - 1];
      const prev = rates2[rates2.length - 2];
      const improving = latest.rate > prev.rate;
      const pctPt = Math.round((latest.rate - prev.rate) * 100);
      alerts.push({
        level: improving ? 'positive' : 'warning',
        icon: improving ? '🟢' : '🟡',
        text: `${latest.month} cohort retaining at ${Math.round(latest.rate * 100)}% — ${improving ? 'up' : 'down'} ${Math.abs(pctPt)}pp vs ${prev.month}.${improving ? ' Keep it up!' : ' Investigate what changed.'}`,
        action: 'retail',
        action_label: 'View Cohorts',
        priority: improving ? 4 : 2,
      });
    }

    // 4. Revenue at risk from lapsed customers
    const revenueAtRisk = await env.DB.prepare(`
      SELECT SUM(predicted_clv) as at_risk, COUNT(*) as count
      FROM retail_customers WHERE segment = 'lapsed'
    `).first();
    if (revenueAtRisk?.at_risk > 100) {
      alerts.push({
        level: 'warning',
        icon: '🟡',
        text: `$${Math.round(revenueAtRisk.at_risk).toLocaleString()} revenue at risk from ${revenueAtRisk.count} lapsed customers.`,
        action: 'retail',
        action_label: 'View Lapsed',
        priority: 3,
      });
    }

    // 5. Win-back bounce rate alert — if bounce rate is high
    const winbackStats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total_returned,
        SUM(CASE WHEN rechurn_at IS NOT NULL THEN 1 ELSE 0 END) as bounced
      FROM retail_campaign_sends rcs
      JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      WHERE rc.campaign_type = 'winback' AND rcs.returned = 1
    `).first();
    if (winbackStats?.total_returned >= 5) {
      const bounceRate = winbackStats.bounced / winbackStats.total_returned;
      if (bounceRate > 0.5) {
        alerts.push({
          level: 'warning',
          icon: '🟡',
          text: `Win-back bounce rate: ${Math.round(bounceRate * 100)}% — ${winbackStats.bounced} of ${winbackStats.total_returned} won-back customers churned again. Messages may need rethinking.`,
          action: 'retail',
          action_label: 'Review Campaigns',
          priority: 3,
        });
      }
    }

    // 6. Weekly insight ready notification
    const insightRaw = await env.KV.get('retail_weekly_insight');
    if (insightRaw) {
      const insight = JSON.parse(insightRaw);
      const insightAge = insight?.generated_at
        ? (Date.now() - new Date(insight.generated_at).getTime()) / 86400000
        : 99;
      if (insightAge < 2) {
        alerts.push({
          level: 'info',
          icon: '📊',
          text: `Weekly retail insight ready.${insight.discoveries?.length ? ` ${insight.discoveries.length} new pattern${insight.discoveries.length > 1 ? 's' : ''} discovered.` : ''}`,
          action: 'retail',
          action_label: 'Read Insight',
          priority: 5,
        });
      }
    }

    // 7. Pending campaign approvals
    const pending = await env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM retail_campaigns WHERE status = 'pending_approval'
    `).first();
    if (pending?.cnt > 0) {
      alerts.push({
        level: 'action',
        icon: '📱',
        text: `${pending.cnt} retail campaign${pending.cnt > 1 ? 's' : ''} waiting for your approval.`,
        action: 'retail',
        action_label: 'Review',
        priority: 1,
      });
    }

  } catch (err) {
    console.error('[Retail] Alert generation error:', err.message);
  }

  alerts.sort((a, b) => a.priority - b.priority);
  return jsonResponse({ alerts });
}

// ── STEP: SEGMENT UPDATE ─────────────────────────────────────────
async function updateSegments(env) {
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
}

// ── STEP: RE-ENGAGEMENT ──────────────────────────────────────────
async function reengageLapsedCustomers(env, brainContext = '') {
  const lapsedCustomers = await env.DB.prepare(`
    SELECT *
    FROM retail_customers
    WHERE segment = 'lapsed'
      AND sms_eligible = 1
      AND (
        reengagement_sent_at IS NULL
        OR julianday('now') - julianday(reengagement_sent_at) >= ?
      )
      AND COALESCE(reengagement_outcome, '') != 'unsubscribed'
    ORDER BY total_lifetime_value DESC
    LIMIT 10
  `).bind(REENGAGEMENT_COOLDOWN).all();

  const customers = lapsedCustomers.results || [];
  let sent = 0;

  for (const customer of customers) {
    // SUPPRESSION CHECK
    const suppressed = await env.DB.prepare(
      'SELECT phone FROM sms_suppressions WHERE phone = ?'
    ).bind(customer.normalized_phone || normalizePhone(customer.phone)).first();
    if (suppressed) continue;

    // ACTIVE CAMPAIGN CHECK — skip if already in a winback campaign send within 14 days
    const activeCampaignSend = await env.DB.prepare(`
      SELECT rcs.id FROM retail_campaign_sends rcs
      JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      WHERE rcs.customer_id = ?
        AND rc.campaign_type = 'winback'
        AND rcs.sent_at >= datetime('now', '-14 days')
      LIMIT 1
    `).bind(customer.id).first();
    if (activeCampaignSend) continue;

    try {
      const daysSince = customer.last_visit_date
        ? Math.floor((Date.now() - new Date(customer.last_visit_date)) / 86400000)
        : LAPSE_DAYS;

      const sms = await generateReengagementSMS(customer, daysSince, env, brainContext);
      const swellResult = await sendSwellSMS(customer.phone, sms, env);
      if (!swellResult.success) continue;

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
    'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'Saint',
    'SALTY': 'Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
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

Rules:
- MAX 160 characters (SMS limit — hard limit)
- Sound like a friend who makes great pretzels
- Reference their favorite flavor if known
- No "click here", no discount codes, no exclamation spam
- End with: Reply STOP to opt out

Return JSON: {"sms": "..."}`;

  let text = null;
  if (env.AI) {
    try {
      const aiResp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: brainContext || 'Return valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
      });
      text = aiResp?.response || null;
    } catch { text = null; }
  }
  if (!text) {
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
    text = data.content?.[0]?.text || '';
  }

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);
    let sms = parsed.sms || 'The Spicy Bee is waiting. dangerouspretzel.com';
    if (!sms.includes('STOP')) {
      sms = sms.slice(0, 130) + ' Reply STOP to opt out';
    }
    return sms.slice(0, 160);
  } catch {
    return 'It\'s been a while. Come back. dangerouspretzel.com Reply STOP to opt out';
  }
}

// ── STEP: CATERING CROSSOVERS ────────────────────────────────────
async function flagCateringCrossovers(env) {
  const groupBuyers = await env.DB.prepare(`
    SELECT rc.*
    FROM retail_customers rc
    WHERE rc.is_group_buyer = 1
      AND rc.catering_flagged = 0
      AND rc.sms_eligible = 1
    ORDER BY rc.largest_single_order DESC, rc.total_lifetime_value DESC
    LIMIT 20
  `).all();

  const buyers = groupBuyers.results || [];
  let flagged = 0;

  for (const buyer of buyers) {
    const leadId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO catering_leads (
        id, contact_name, contact_email, contact_phone,
        source, source_customer_id, status, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'retail_crossover', ?, 'prospect', ?, datetime('now'), datetime('now'))
    `).bind(
      leadId, buyer.first_name || null, buyer.email || null,
      buyer.phone, buyer.id,
      `Retail crossover: ${buyer.visit_count} visits, largest order ${buyer.largest_single_order} items, LTV $${buyer.total_lifetime_value?.toFixed(0)}`,
    ).run();

    await env.DB.prepare(`
      UPDATE retail_customers SET catering_flagged = 1, catering_lead_id = ?, updated_at = datetime('now') WHERE id = ?
    `).bind(leadId, buyer.id).run();

    flagged++;
  }

  if (flagged > 0) {
    console.log(`[Retail] Flagged ${flagged} group buyers for catering`);
    await env.KV.put('retail_crossover_alert', JSON.stringify({
      count: flagged, timestamp: new Date().toISOString(),
      message: `${flagged} retail customers flagged as catering leads`,
    }));
  }
  return flagged;
}

// ── GOAL TRACKING ────────────────────────────────────────────────
async function updateGoalProgress(env) {
  const goals = await env.DB.prepare(`
    SELECT * FROM retail_goals WHERE status = 'active'
  `).all();

  for (const goal of (goals.results || [])) {
    let currentValue = 0;

    if (goal.goal_type === 'weekly_revenue') {
      const rev = await env.DB.prepare(`
        SELECT SUM(gross_revenue) as total FROM orders
        WHERE order_date >= ? AND order_date < ?
      `).bind(goal.period_start, goal.period_end).first();
      currentValue = rev?.total || 0;
    } else if (goal.goal_type === 'monthly_revenue') {
      const rev = await env.DB.prepare(`
        SELECT SUM(gross_revenue) as total FROM orders
        WHERE order_date >= ? AND order_date < ?
      `).bind(goal.period_start, goal.period_end).first();
      currentValue = rev?.total || 0;
    } else if (goal.goal_type === 'new_customers') {
      const count = await env.DB.prepare(`
        SELECT COUNT(*) as total FROM retail_customers
        WHERE created_at >= ? AND created_at < ?
      `).bind(goal.period_start, goal.period_end).first();
      currentValue = count?.total || 0;
    } else if (goal.goal_type === 'avg_order_value') {
      const avg = await env.DB.prepare(`
        SELECT AVG(gross_revenue) as avg_val FROM orders
        WHERE order_date >= ? AND order_date < ?
      `).bind(goal.period_start, goal.period_end).first();
      currentValue = avg?.avg_val || 0;
    } else if (goal.goal_type === 'churn_rate') {
      const churnData = await env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN churn_risk_score >= 75 THEN 1 ELSE 0 END) as high_risk
        FROM retail_customers
      `).first();
      const total = churnData?.total || 0;
      currentValue = total > 0 ? Math.round((churnData.high_risk / total) * 10000) / 100 : 0;
    } else if (goal.goal_type === 'visit_frequency') {
      const freq = await env.DB.prepare(`
        SELECT AVG(order_frequency_days) as avg_freq FROM retail_customers
        WHERE order_frequency_days IS NOT NULL
      `).first();
      currentValue = freq?.avg_freq || 0;
    } else if (goal.goal_type === 'campaign_roi') {
      const roiData = await env.DB.prepare(`
        SELECT SUM(total_revenue_attributed) as rev, SUM(total_sent) as sent
        FROM retail_campaigns WHERE status IN ('active', 'completed')
      `).first();
      currentValue = roiData?.sent > 0
        ? Math.round((roiData.rev || 0) / (roiData.sent * 0.01) * 10) / 10
        : 0;
    }

    const status = currentValue >= goal.target_value ? 'met' : 'active';

    await env.DB.prepare(`
      UPDATE retail_goals SET current_value = ?, status = ?, updated_at = datetime('now') WHERE id = ?
    `).bind(Math.round(currentValue * 100) / 100, status, goal.id).run();
  }
}

// ── WEEKLY INSIGHT (Monday) ──────────────────────────────────────
// ── SELF-LEARNING CAMPAIGN ENGINE ───────────────────────────────
async function updateCampaignLearnings(env) {
  // Analyze all campaign sends from past 30 days with outcomes
  const sends = await env.DB.prepare(`
    SELECT rcs.message_text, rcs.sent_at, rcs.returned, rcs.returned_at,
           rcs.revenue_attributed, rc.campaign_type,
           cust.behavior_type, cust.visit_count, cust.favorite_sku
    FROM retail_campaign_sends rcs
    JOIN retail_campaigns rc ON rcs.campaign_id = rc.id
    LEFT JOIN retail_customers cust ON rcs.customer_id = cust.id
    WHERE rcs.sent_at >= date('now', '-30 days')
  `).all();

  const results = sends.results || [];
  if (results.length < 5) {
    console.log('[Retail] Not enough campaign sends for learnings (<5)');
    return;
  }

  // Aggregate patterns
  const byType = {};
  const byBehavior = {};
  const byDay = {};
  let totalSent = 0, totalReturned = 0;
  const successMsgs = [];

  for (const s of results) {
    totalSent++;
    const returned = s.returned === 1;
    if (returned) totalReturned++;

    // By campaign type
    const t = s.campaign_type || 'unknown';
    if (!byType[t]) byType[t] = { sent: 0, returned: 0, revenue: 0 };
    byType[t].sent++;
    if (returned) byType[t].returned++;
    byType[t].revenue += s.revenue_attributed || 0;

    // By behavior type
    const b = s.behavior_type || 'unknown';
    if (!byBehavior[b]) byBehavior[b] = { sent: 0, returned: 0 };
    byBehavior[b].sent++;
    if (returned) byBehavior[b].returned++;

    // By day of week
    try {
      const day = new Date(s.sent_at).toLocaleDateString('en-US', { weekday: 'short' });
      if (!byDay[day]) byDay[day] = { sent: 0, returned: 0 };
      byDay[day].sent++;
      if (returned) byDay[day].returned++;
    } catch {}

    // Collect successful messages
    if (returned && s.message_text) {
      successMsgs.push({
        text: s.message_text.substring(0, 100),
        type: t,
        return_days: s.returned_at && s.sent_at
          ? Math.round((new Date(s.returned_at) - new Date(s.sent_at)) / 86400000)
          : null,
      });
    }
  }

  // Build learnings object
  const learnings = {
    updated: new Date().toISOString().split('T')[0],
    sample_size: totalSent,
    overall_return_rate: totalSent > 0 ? Math.round(totalReturned / totalSent * 100) : 0,
    by_campaign_type: Object.entries(byType).map(([type, d]) => ({
      type,
      sent: d.sent,
      return_rate: d.sent > 0 ? Math.round(d.returned / d.sent * 100) : 0,
      revenue: Math.round(d.revenue),
    })).sort((a, b) => b.return_rate - a.return_rate),
    by_behavior_type: Object.entries(byBehavior).map(([type, d]) => ({
      type,
      sent: d.sent,
      return_rate: d.sent > 0 ? Math.round(d.returned / d.sent * 100) : 0,
    })).sort((a, b) => b.return_rate - a.return_rate),
    best_days: Object.entries(byDay).map(([day, d]) => ({
      day,
      return_rate: d.sent > 0 ? Math.round(d.returned / d.sent * 100) : 0,
    })).sort((a, b) => b.return_rate - a.return_rate),
    best_performing_messages: successMsgs.slice(0, 5),
  };

  await env.KV.put('retail_campaign_learnings', JSON.stringify(learnings));
  console.log(`[Retail] Campaign learnings updated: ${totalSent} sends, ${totalReturned} returns (${learnings.overall_return_rate}%)`);
  return learnings;
}

// ── WEEKLY INSIGHT ─────────────────────────────────────────────
async function generateWeeklyInsight(env, brainContext = '') {
  const [skuStats, timeStats, customerStats, campaignStats, goalStats] = await Promise.all([
    env.DB.prepare(`
      SELECT SUM(gross_revenue) as revenue, COUNT(*) as orders, AVG(units) as avg_units
      FROM orders WHERE order_date >= date('now', '-7 days')
    `).first(),

    env.DB.prepare(`
      SELECT strftime('%w', order_date) as dow, strftime('%H', order_date) as hour,
             COUNT(*) as orders, SUM(gross_revenue) as revenue
      FROM orders WHERE order_date >= date('now', '-7 days')
      GROUP BY dow, hour ORDER BY orders DESC LIMIT 5
    `).all(),

    env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN segment = 'new' THEN 1 ELSE 0 END) as new_customers,
        SUM(CASE WHEN segment = 'regular' THEN 1 ELSE 0 END) as regular,
        SUM(CASE WHEN segment = 'vip' THEN 1 ELSE 0 END) as vip,
        SUM(CASE WHEN segment = 'lapsed' THEN 1 ELSE 0 END) as lapsed,
        SUM(CASE WHEN segment = 'churned' THEN 1 ELSE 0 END) as churned,
        SUM(CASE WHEN churn_risk_score >= 75 THEN 1 ELSE 0 END) as high_churn_risk,
        AVG(churn_risk_score) as avg_churn_score
      FROM retail_customers
    `).first(),

    env.DB.prepare(`
      SELECT name, campaign_type, total_sent, total_returned, total_revenue_attributed, roi_estimate
      FROM retail_campaigns
      WHERE status = 'active' OR (status = 'completed' AND completed_at >= date('now', '-7 days'))
    `).all(),

    env.DB.prepare(`SELECT * FROM retail_goals WHERE status = 'active'`).all(),
  ]);

  const menuData = await env.DB.prepare(`
    SELECT sku, units_sold, revenue, units_trend_pct, most_paired_sku, peak_hour, morning_pct, weekend_pct
    FROM retail_menu_analytics
    WHERE week_start = date('now', 'weekday 1', '-7 days')
    ORDER BY revenue DESC
  `).all();

  // Fetch additional AI-advantage data: cohort, magic number, campaign learnings, momentum
  const [cohortRecent, magicData, momentumStats, churnPredictions] = await Promise.all([
    // Recent cohort retention (last 3 months)
    env.DB.prepare(`
      SELECT strftime('%Y-%m', first_visit_date) as cohort_month, COUNT(*) as acquired,
             SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returned
      FROM retail_customers
      WHERE first_visit_date >= date('now', '-90 days')
      GROUP BY cohort_month ORDER BY cohort_month
    `).all(),

    // Magic number computation
    env.DB.prepare(`
      SELECT visit_count, COUNT(*) as total,
             SUM(CASE WHEN segment IN ('churned','lapsed') THEN 1 ELSE 0 END) as churned
      FROM retail_customers WHERE visit_count BETWEEN 1 AND 6
      GROUP BY visit_count ORDER BY visit_count
    `).all(),

    // Momentum distribution
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN momentum_score > 20 THEN 1 ELSE 0 END) as accelerating,
        SUM(CASE WHEN momentum_score < -20 THEN 1 ELSE 0 END) as decelerating,
        SUM(CASE WHEN momentum_score BETWEEN -20 AND 20 THEN 1 ELSE 0 END) as stable
      FROM retail_customers WHERE visit_count >= 2
    `).first(),

    // High churn probability customers
    env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_customers
      WHERE churn_probability_7d > 0.6 AND segment NOT IN ('churned','lapsed') AND sms_eligible = 1
    `).first(),
  ]);

  const campaignLearnings = await env.KV.get('retail_campaign_learnings');

  const insightData = {
    week: new Date().toISOString().split('T')[0],
    revenue: skuStats?.revenue || 0,
    orders: skuStats?.orders || 0,
    avg_items: skuStats?.avg_units || 0,
    peak_times: (timeStats.results || []).slice(0, 3),
    customers: customerStats,
    menu: (menuData.results || []),
    campaigns: (campaignStats.results || []),
    goals: (goalStats.results || []),
    // AI-advantage data
    recent_cohort_retention: (cohortRecent.results || []).map(r => ({
      month: r.cohort_month,
      acquired: r.acquired,
      return_rate: r.acquired > 0 ? Math.round(r.returned / r.acquired * 100) : 0,
    })),
    magic_number_data: (magicData.results || []).map(r => ({
      visits: r.visit_count,
      churn_pct: r.total > 0 ? Math.round(r.churned / r.total * 100) : 0,
      sample: r.total,
    })),
    momentum: momentumStats || {},
    high_churn_probability_count: churnPredictions?.count || 0,
    campaign_learnings: campaignLearnings ? JSON.parse(campaignLearnings) : null,
  };

  const prompt = `Generate a structured weekly retail intelligence brief for Dangerous Pretzel Co — a food truck in Salt Lake City.

Data from the past 7 days + AI analytics:
${JSON.stringify(insightData, null, 2)}

You are the AI co-pilot for this business. Your job is not just to report — it's to FIND PATTERNS and RECOMMEND SPECIFIC ACTIONS. Look at the cohort retention, magic number data, momentum scores, and campaign learnings to discover things Drew would never think to look for.

KEY CONTEXT: The realistic retention target for a food truck is visit 3. Getting a one-time customer to come back at all (1→2 visits) is the hardest part — 82% never return. Focus campaign recommendations on getting one-timers back within 14 days. Do NOT recommend targeting visit 10+ as a magic number — sample sizes above visit 5 are too small to be meaningful. The goal is: convert 5% of one-timers to 2+ visits per month. Orders above $500 or 30+ items are catering/wholesale and should not be treated as retail visits in your analysis.

Return JSON with these exact keys:
{
  "executive_summary": "3-4 sentences. Lead with the single most important insight. Be direct about whether the business is improving or declining and why.",
  "menu_insights": {
    "trending_up": [{"sku": "...", "change_pct": 0, "why": "..."}],
    "trending_down": [{"sku": "...", "change_pct": 0, "concern": "..."}],
    "combo_opportunity": "string or null",
    "loyalty_finding": "Which items correlate with repeat visits based on the data?"
  },
  "customer_health": {
    "new_this_week": 0,
    "high_churn_risk": 0,
    "net_health_score": 0,
    "cohort_trend": "improving|declining|flat — based on recent cohort return rates",
    "magic_number_insight": "What does the magic number data tell us this week?"
  },
  "campaign_recommendations": [
    {"type": "day3_followup|magic_number_push|cadence_nudge|winback|upsell", "target": "...", "reasoning": "...", "estimated_impact": "...", "priority": "high|medium|low"}
  ],
  "discoveries": [
    {"finding": "A surprising pattern you found in the data", "evidence": "What data supports this", "suggested_action": "What Drew should do about it", "confidence": "high|medium|low"}
  ],
  "goals_assessment": [{"goal_type": "...", "on_track": true, "note": "..."}],
  "proposed_goals": [{"goal_type": "weekly_revenue|monthly_revenue|new_customers|churn_rate|avg_order_value|visit_frequency|campaign_roi", "target_value": 0, "reasoning": "..."}],
  "action_this_week": "THE one specific, data-backed thing Drew should do this week to grow the business"
}

Tone: Direct, specific, no fluff. Like a brilliant COO who lives and breathes the data. Every insight should connect to an action.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
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

    await env.DB.prepare(`
      INSERT OR REPLACE INTO retail_insights (
        id, week_start, new_customers, lapsed_count, catering_crossovers,
        total_revenue, insight_summary, created_at
      ) VALUES (?, date('now', 'weekday 1', '-7 days'), ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      customerStats?.new_customers || 0,
      customerStats?.lapsed || 0,
      0,
      skuStats?.revenue || 0,
      JSON.stringify(insight),
    ).run();

    await env.KV.put('retail_weekly_insight', JSON.stringify(insight));

    // Auto-create proposed goals (agent-suggested, pending review)
    if (insight.proposed_goals && Array.isArray(insight.proposed_goals)) {
      for (const goal of insight.proposed_goals) {
        if (!goal.goal_type || !goal.target_value) continue;
        // Don't create if same type goal already active
        const existing = await env.DB.prepare(
          'SELECT id FROM retail_goals WHERE goal_type = ? AND status = ?'
        ).bind(goal.goal_type, 'active').first();
        if (existing) continue;

        const now = new Date();
        const periodEnd = new Date(now);
        if (goal.goal_type.includes('weekly')) periodEnd.setDate(periodEnd.getDate() + 7);
        else periodEnd.setDate(periodEnd.getDate() + 30);

        await env.DB.prepare(`
          INSERT INTO retail_goals (id, goal_type, target_value, current_value, period_start, period_end, set_by, reasoning, created_at)
          VALUES (?, ?, ?, 0, ?, ?, 'agent', ?, datetime('now'))
        `).bind(
          crypto.randomUUID(), goal.goal_type, goal.target_value,
          now.toISOString(), periodEnd.toISOString(),
          goal.reasoning || 'Agent-proposed based on trend data',
        ).run();
        console.log(`[Retail] Auto-created goal: ${goal.goal_type} → ${goal.target_value}`);
      }
    }

    return insight;
  } catch (err) {
    console.error('[Retail] Insight parse error:', err.message);
    return null;
  }
}

// ── MONTHLY STRATEGY REPORT (1st of month) ───────────────────────
// Full strategic analysis — not just metrics, a strategic document that
// connects insight → goal → action → measurement.
async function generateMonthlyAnalysis(env, brainContext = '') {
  try {
    // Gather comprehensive data for the past month
    const lastMonth = new Date();
    lastMonth.setDate(1);
    lastMonth.setDate(lastMonth.getDate() - 1);
    const lmStr = lastMonth.toISOString().slice(0, 7); // e.g. "2026-03"
    const twoMonthsAgo = new Date(lastMonth);
    twoMonthsAgo.setDate(1);
    twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 1);
    const tmStr = twoMonthsAgo.toISOString().slice(0, 7);

    const [revenue, prevRevenue, customers, cohorts, campaigns, topSKUs, winbackStats, funnel, learningsRaw] = await Promise.all([
      // Last month revenue
      env.DB.prepare(`
        SELECT SUM(gross_revenue) as total, COUNT(*) as txns, AVG(gross_revenue) as avg_ticket,
               COUNT(DISTINCT customer_id) as unique_customers
        FROM orders WHERE strftime('%Y-%m', order_date) = ?
      `).bind(lmStr).first(),

      // Previous month revenue (for comparison)
      env.DB.prepare(`
        SELECT SUM(gross_revenue) as total, COUNT(*) as txns, AVG(gross_revenue) as avg_ticket,
               COUNT(DISTINCT customer_id) as unique_customers
        FROM orders WHERE strftime('%Y-%m', order_date) = ?
      `).bind(tmStr).first(),

      // Customer segments snapshot
      env.DB.prepare(`
        SELECT segment, COUNT(*) as cnt,
               SUM(total_lifetime_value) as total_ltv,
               AVG(visit_count) as avg_visits
        FROM retail_customers GROUP BY segment
      `).all(),

      // Cohort retention for last 3 months
      env.DB.prepare(`
        SELECT strftime('%Y-%m', first_visit_date) as cohort,
               COUNT(*) as acquired,
               SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as retained_1,
               SUM(CASE WHEN visit_count >= 3 THEN 1 ELSE 0 END) as retained_2,
               SUM(CASE WHEN visit_count >= 5 THEN 1 ELSE 0 END) as retained_4
        FROM retail_customers
        WHERE first_visit_date >= date('now', '-120 days')
        GROUP BY cohort ORDER BY cohort
      `).all(),

      // Campaign performance last month
      env.DB.prepare(`
        SELECT rc.campaign_type, rc.name,
               rc.total_sent, rc.total_returned, rc.total_revenue_attributed, rc.roi_estimate
        FROM retail_campaigns rc
        WHERE rc.completed_at >= date('now', '-35 days') OR rc.status = 'active'
        ORDER BY rc.total_revenue_attributed DESC
      `).all(),

      // Top SKUs by revenue last month
      env.DB.prepare(`
        SELECT sku, SUM(revenue) as rev, SUM(quantity) as qty, AVG(revenue/NULLIF(quantity,0)) as avg_price
        FROM retail_menu_analytics
        WHERE week_start >= date('now', '-35 days')
        GROUP BY sku ORDER BY rev DESC LIMIT 10
      `).all(),

      // Win-back effectiveness
      env.DB.prepare(`
        SELECT
          COUNT(*) as total_sends,
          SUM(CASE WHEN returned = 1 THEN 1 ELSE 0 END) as returned,
          SUM(CASE WHEN rechurn_at IS NOT NULL THEN 1 ELSE 0 END) as bounced,
          SUM(revenue_attributed) as revenue
        FROM retail_campaign_sends rcs
        JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
        WHERE rc.campaign_type = 'winback'
      `).first(),

      // Loyalty funnel
      env.DB.prepare(`
        SELECT
          SUM(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END) as v1,
          SUM(CASE WHEN visit_count BETWEEN 2 AND 3 THEN 1 ELSE 0 END) as v2_3,
          SUM(CASE WHEN visit_count BETWEEN 4 AND 5 THEN 1 ELSE 0 END) as v4_5,
          SUM(CASE WHEN visit_count >= 6 THEN 1 ELSE 0 END) as vip,
          COUNT(*) as total
        FROM retail_customers
      `).first(),

      // Campaign learnings
      env.KV.get('retail_campaign_learnings'),
    ]);

    const learnings = learningsRaw ? JSON.parse(learningsRaw) : null;
    const segMap = {};
    for (const s of (customers.results || [])) segMap[s.segment] = s;

    const dataContext = {
      month: lmStr,
      revenue: {
        total: revenue?.total || 0,
        transactions: revenue?.txns || 0,
        avg_ticket: Math.round((revenue?.avg_ticket || 0) * 100) / 100,
        unique_customers: revenue?.unique_customers || 0,
        vs_previous: {
          revenue_pct: prevRevenue?.total > 0 ? Math.round(((revenue?.total || 0) / prevRevenue.total - 1) * 100) : null,
          txn_pct: prevRevenue?.txns > 0 ? Math.round(((revenue?.txns || 0) / prevRevenue.txns - 1) * 100) : null,
          ticket_pct: prevRevenue?.avg_ticket > 0 ? Math.round(((revenue?.avg_ticket || 0) / prevRevenue.avg_ticket - 1) * 100) : null,
        },
      },
      segments: segMap,
      cohort_retention: (cohorts.results || []).map(c => ({
        month: c.cohort,
        acquired: c.acquired,
        first_to_second: c.acquired > 0 ? Math.round(c.retained_1 / c.acquired * 100) : 0,
        to_third: c.acquired > 0 ? Math.round(c.retained_2 / c.acquired * 100) : 0,
        to_fifth: c.acquired > 0 ? Math.round(c.retained_4 / c.acquired * 100) : 0,
      })),
      loyalty_funnel: {
        one_visit: funnel?.v1 || 0,
        two_three: funnel?.v2_3 || 0,
        four_five: funnel?.v4_5 || 0,
        vip: funnel?.vip || 0,
        total: funnel?.total || 0,
        first_to_second_rate: funnel?.total > 0 ? Math.round((funnel.total - (funnel?.v1 || 0)) / funnel.total * 100) : 0,
      },
      campaign_performance: (campaigns.results || []).map(c => ({
        type: c.campaign_type, name: c.name,
        sent: c.total_sent, returned: c.total_returned,
        revenue: c.total_revenue_attributed, roi: c.roi_estimate,
      })),
      winback_intelligence: {
        total_sends: winbackStats?.total_sends || 0,
        returned: winbackStats?.returned || 0,
        bounced: winbackStats?.bounced || 0,
        sticky: (winbackStats?.returned || 0) - (winbackStats?.bounced || 0),
        revenue: winbackStats?.revenue || 0,
        bounce_rate: winbackStats?.returned > 0 ? Math.round(winbackStats.bounced / winbackStats.returned * 100) : 0,
      },
      top_skus: (topSKUs.results || []).slice(0, 8).map(s => ({ sku: s.sku, revenue: s.rev, qty: s.qty })),
      campaign_learnings: learnings?.effective_patterns || [],
    };

    const prompt = `You are the strategic AI co-pilot for Dangerous Pretzel Co, a food truck in Salt Lake City.
Generate the MONTHLY STRATEGY REPORT for ${lmStr}. This is the most important document Drew reads each month.

DATA:
${JSON.stringify(dataContext, null, 2)}

Return JSON with this EXACT structure:
{
  "executive_summary": "2-3 sentences. The brutal truth about this month. No sugar-coating.",
  "what_worked": ["Specific thing 1 with numbers", "Specific thing 2"],
  "what_didnt": ["Specific thing 1 with numbers", "Specific thing 2"],
  "retention_trend": "improving|declining|flat",
  "retention_analysis": "1-2 sentences on cohort trends and what's driving them",
  "winback_analysis": "1-2 sentences on win-back bounce rate and what it means",
  "recommended_experiments": [
    {"experiment": "What to test", "target_group": "Who", "expected_outcome": "What you expect", "effort": "low|medium|high"}
  ],
  "goals_for_next_month": [
    {"type": "first_to_second_conversion|magic_number_conversions|avg_ticket|monthly_revenue|churn_reduction", "target": 0, "baseline": 0, "reasoning": "Why this target"}
  ],
  "biggest_risk": "The one thing that could hurt the business most next month",
  "biggest_opportunity": "The one thing with highest ROI potential next month",
  "cfo_summary": {
    "total_revenue": 0,
    "campaign_spend_sms": 0,
    "campaign_attributed_revenue": 0,
    "roi": 0,
    "revenue_concentration_risk": "low|medium|high"
  }
}

Be specific with numbers. Reference actual data. Every insight must connect to an action.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        ...(brainContext ? { system: brainContext } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const text = data.content?.[0]?.text || '';
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      const analysis = JSON.parse(clean);
      analysis.generated_at = new Date().toISOString();
      analysis.month = lmStr;
      await env.KV.put('retail_monthly_analysis', JSON.stringify(analysis));
      console.log('[Retail] Monthly strategy report generated for', lmStr);
    }
  } catch (err) {
    console.error('[Retail] Monthly analysis error:', err.message);
  }
}

// ── CFO REPORT ───────────────────────────────────────────────────
async function writeCFOReport(env) {
  const [revenue, customers, campaigns, goals, churnCount] = await Promise.all([
    env.DB.prepare(`
      SELECT SUM(gross_revenue) as total, COUNT(*) as count, AVG(gross_revenue) as avg_ticket
      FROM orders WHERE order_date >= date('now', '-7 days')
    `).first(),

    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as new_customers,
        SUM(CASE WHEN segment = 'lapsed' AND updated_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as newly_lapsed,
        COUNT(*) as total_customers,
        SUM(CASE WHEN segment = 'vip' THEN 1 ELSE 0 END) as vip_count,
        SUM(CASE WHEN segment = 'regular' THEN 1 ELSE 0 END) as regular_count
      FROM retail_customers
    `).first(),

    env.DB.prepare(`
      SELECT SUM(total_sent) as spend, SUM(total_revenue_attributed) as revenue_attr,
             COUNT(*) as active_campaigns
      FROM retail_campaigns
      WHERE status = 'active' OR (completed_at >= date('now', '-7 days'))
    `).first(),

    env.DB.prepare(`
      SELECT goal_type, target_value, current_value, status
      FROM retail_goals WHERE status = 'active'
    `).all(),

    env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_customers WHERE churn_risk_score >= 75
    `).first(),
  ]);

  const goalsList = (goals?.results || []).map(g => ({
    type: g.goal_type,
    target: g.target_value,
    current: g.current_value,
    pct: g.target_value > 0 ? Math.round(g.current_value / g.target_value * 100) : 0,
  }));

  const report = {
    week_start: getWeekStart(new Date().toISOString()),
    revenue: revenue?.total || 0,
    transaction_count: revenue?.count || 0,
    avg_ticket: Math.round((revenue?.avg_ticket || 0) * 100) / 100,
    new_customers: customers?.new_customers || 0,
    lapsed_customers: customers?.newly_lapsed || 0,
    total_customers: customers?.total_customers || 0,
    vip_count: customers?.vip_count || 0,
    regular_count: customers?.regular_count || 0,
    churn_risk_count: churnCount?.count || 0,
    campaign_spend_sms: campaigns?.spend || 0,
    campaign_revenue_attributed: campaigns?.revenue_attr || 0,
    active_campaigns: campaigns?.active_campaigns || 0,
    campaign_roi: (campaigns?.spend && campaigns.spend > 0)
      ? Math.round((campaigns.revenue_attr || 0) / (campaigns.spend * 0.01) * 10) / 10
      : 0,
    goals: goalsList,
    generated_at: new Date().toISOString(),
  };

  await env.KV.put('retail_cfo_report', JSON.stringify(report));
  console.log('[Retail] CFO report written to KV');
}

// ── SWELL OPT-OUT WEBHOOK ────────────────────────────────────────
async function handleSwellWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Handle STOP replies / opt-outs
  if (body.type === 'sms.opt_out' || body.event === 'sms.opt_out' ||
      (body.message && body.message.toLowerCase().includes('stop'))) {
    const phone = normalizePhone(body.customer_phone || body.phone || body.from);
    if (!phone) return new Response('No phone', { status: 400 });

    // Write to suppressions table immediately
    await env.DB.prepare(`
      INSERT OR REPLACE INTO sms_suppressions (phone, opted_out_at, source)
      VALUES (?, datetime('now'), 'customer_request')
    `).bind(phone).run();

    // Update retail_customers
    await env.DB.prepare(`
      UPDATE retail_customers
      SET sms_consent = 0, sms_eligible = 0, sms_opted_out_at = datetime('now'), updated_at = datetime('now')
      WHERE normalized_phone = ?
    `).bind(phone).run();

    console.log(`[Retail] SMS opt-out processed: ${phone}`);
    return new Response('OK', { status: 200 });
  }

  return new Response('OK', { status: 200 });
}

// ── BACKFILL TRIGGER ─────────────────────────────────────────────
async function startBackfill(env) {
  if (!env.RETAIL_BACKFILL) {
    return jsonResponse({ error: 'RETAIL_BACKFILL workflow binding not configured' }, 500);
  }

  try {
    const instance = await env.RETAIL_BACKFILL.create();
    return jsonResponse({
      started: true,
      workflow_id: instance.id,
      message: 'Backfill workflow started. Check status at /retail/backfill/status/' + instance.id,
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function getBackfillStatus(workflowId, env) {
  if (!env.RETAIL_BACKFILL) {
    return jsonResponse({ error: 'RETAIL_BACKFILL workflow binding not configured' }, 500);
  }

  try {
    const instance = await env.RETAIL_BACKFILL.get(workflowId);
    const status = await instance.status();
    return jsonResponse(status);
  } catch (err) {
    return jsonResponse({ error: err.message }, 404);
  }
}

// ── DASHBOARD ENDPOINT ───────────────────────────────────────────
async function getDashboardData(env) {
  const [segments, weeklyMetrics, campaigns, goals, menuTrends, churnWatch, insight, topCustomers] = await Promise.all([
    // Customer segments
    env.DB.prepare(`
      SELECT segment, COUNT(*) as count,
             AVG(total_lifetime_value) as avg_ltv,
             AVG(visit_count) as avg_visits
      FROM retail_customers GROUP BY segment ORDER BY count DESC
    `).all(),

    // This week's metrics
    env.DB.prepare(`
      SELECT
        SUM(gross_revenue) as weekly_revenue,
        COUNT(*) as transaction_count,
        AVG(gross_revenue) as avg_ticket
      FROM orders WHERE order_date >= date('now', 'weekday 1', '-7 days')
    `).first(),

    // Pending + active campaigns
    env.DB.prepare(`
      SELECT * FROM retail_campaigns
      WHERE status IN ('pending_approval', 'active')
      ORDER BY created_at DESC
    `).all(),

    // Active goals
    env.DB.prepare(`SELECT * FROM retail_goals WHERE status = 'active' ORDER BY period_end ASC`).all(),

    // Most recent week's menu analytics (falls back to latest available)
    env.DB.prepare(`
      SELECT * FROM retail_menu_analytics
      WHERE week_start = (SELECT MAX(week_start) FROM retail_menu_analytics)
      ORDER BY revenue DESC
    `).all(),

    // High churn risk customers
    env.DB.prepare(`
      SELECT id, first_name, phone, visit_count, total_lifetime_value,
             last_visit_date, churn_risk_score, favorite_sku
      FROM retail_customers
      WHERE churn_risk_score >= 75 AND sms_eligible = 1
      ORDER BY churn_risk_score DESC LIMIT 10
    `).all(),

    // Cached weekly insight
    env.KV.get('retail_weekly_insight'),

    // Top 10 customers by lifetime value
    env.DB.prepare(`
      SELECT id, first_name, visit_count, total_lifetime_value,
             last_visit_date, segment, favorite_sku
      FROM retail_customers
      ORDER BY total_lifetime_value DESC LIMIT 10
    `).all(),
  ]);

  // Metric cards
  const totalActive = (segments.results || [])
    .filter(s => ['new', 'regular', 'vip'].includes(s.segment))
    .reduce((sum, s) => sum + s.count, 0);

  const highChurnCount = (churnWatch.results || []).length;

  // Campaign ROI aggregate
  const campaignROI = await env.DB.prepare(`
    SELECT SUM(total_revenue_attributed) as rev, SUM(total_sent) as sent
    FROM retail_campaigns WHERE status IN ('active', 'completed')
  `).first();

  // Goal progress
  const goalsOnTrack = (goals.results || []).filter(g =>
    g.current_value >= g.target_value * 0.8
  ).length;

  // Last week metrics for delta
  const lastWeek = await env.DB.prepare(`
    SELECT SUM(gross_revenue) as revenue, AVG(gross_revenue) as avg_ticket
    FROM orders WHERE order_date >= date('now', 'weekday 1', '-14 days')
      AND order_date < date('now', 'weekday 1', '-7 days')
  `).first();

  return jsonResponse({
    metric_cards: {
      weekly_revenue: {
        value: weeklyMetrics?.weekly_revenue || 0,
        delta: lastWeek?.revenue
          ? Math.round(((weeklyMetrics?.weekly_revenue || 0) / lastWeek.revenue - 1) * 100)
          : null,
      },
      active_customers: totalActive,
      churn_risk_count: highChurnCount,
      campaign_roi: campaignROI?.sent > 0
        ? Math.round((campaignROI.rev || 0) / (campaignROI.sent * 0.01) * 10) / 10
        : 0,
      avg_ticket: {
        value: Math.round((weeklyMetrics?.avg_ticket || 0) * 100) / 100,
        delta: lastWeek?.avg_ticket
          ? Math.round(((weeklyMetrics?.avg_ticket || 0) / lastWeek.avg_ticket - 1) * 100)
          : null,
      },
      goals_on_track: `${goalsOnTrack}/${(goals.results || []).length}`,
    },
    segments: segments.results || [],
    campaigns: campaigns.results || [],
    goals: goals.results || [],
    menu_trends: menuTrends.results || [],
    churn_watch: churnWatch.results || [],
    top_customers: topCustomers.results || [],
    weekly_insight: insight ? JSON.parse(insight) : null,
  });
}

// ── API ENDPOINTS ────────────────────────────────────────────────
async function getCampaigns(env) {
  const campaigns = await env.DB.prepare(
    'SELECT * FROM retail_campaigns ORDER BY created_at DESC'
  ).all();
  return jsonResponse(campaigns.results || []);
}

async function createCampaign(request, env) {
  const body = await request.json();

  // Check auto-approve rules
  const rule = await env.DB.prepare(
    'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
  ).bind(body.campaign_type).first();

  const autoApprove = rule?.auto_approve === 1;

  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO retail_campaigns (
      id, name, campaign_type, status, target_segment, target_criteria,
      estimated_reach, message_template, message_variants,
      send_strategy, drip_schedule, daily_send_limit, total_budget_sms,
      approval_status, agent_reasoning, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).bind(
    id,
    body.name,
    body.campaign_type,
    autoApprove ? 'active' : 'pending_approval',
    body.target_segment || 'all',
    body.target_criteria ? JSON.stringify(body.target_criteria) : null,
    body.estimated_reach || 0,
    body.message_template || null,
    body.message_variants ? JSON.stringify(body.message_variants) : null,
    body.send_strategy || 'immediate',
    body.drip_schedule ? JSON.stringify(body.drip_schedule) : null,
    body.daily_send_limit || 10,
    body.total_budget_sms || null,
    autoApprove ? 'approved' : 'pending',
    body.agent_reasoning || null,
  ).run();

  return jsonResponse({ id, status: autoApprove ? 'active' : 'pending_approval', auto_approved: autoApprove });
}

async function approveCampaign(request, env) {
  const { campaign_id, note } = await request.json();
  await env.DB.prepare(`
    UPDATE retail_campaigns
    SET status = 'active', approval_status = 'approved',
        drew_note = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending_approval'
  `).bind(note || null, campaign_id).run();
  return jsonResponse({ approved: true });
}

async function rejectCampaign(request, env) {
  const { campaign_id, note } = await request.json();
  await env.DB.prepare(`
    UPDATE retail_campaigns
    SET status = 'draft', approval_status = 'rejected',
        drew_note = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending_approval'
  `).bind(note || null, campaign_id).run();
  return jsonResponse({ rejected: true });
}

async function getGoals(env) {
  const goals = await env.DB.prepare(
    'SELECT * FROM retail_goals ORDER BY period_end ASC'
  ).all();
  return jsonResponse(goals.results || []);
}

async function createOrUpdateGoal(request, env) {
  const body = await request.json();
  const id = body.id || crypto.randomUUID();

  await env.DB.prepare(`
    INSERT OR REPLACE INTO retail_goals (
      id, goal_type, target_value, current_value,
      period_start, period_end, status, set_by, reasoning,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, COALESCE((SELECT created_at FROM retail_goals WHERE id = ?), datetime('now')), datetime('now'))
  `).bind(
    id, body.goal_type, body.target_value, body.current_value || 0,
    body.period_start, body.period_end,
    body.set_by || 'drew', body.reasoning || null, id,
  ).run();

  return jsonResponse({ id, created: true });
}

async function getMenuAnalytics(env) {
  const data = await env.DB.prepare(`
    SELECT * FROM retail_menu_analytics
    WHERE week_start >= date('now', '-28 days')
    ORDER BY week_start DESC, revenue DESC
  `).all();
  return jsonResponse(data.results || []);
}

async function getChurnWatch(env) {
  const data = await env.DB.prepare(`
    SELECT id, first_name, phone, visit_count, total_lifetime_value,
           last_visit_date, churn_risk_score, favorite_sku, predicted_clv
    FROM retail_customers
    WHERE churn_risk_score >= 75 AND sms_eligible = 1
    ORDER BY churn_risk_score DESC, total_lifetime_value DESC
    LIMIT 20
  `).all();
  return jsonResponse(data.results || []);
}

async function getCustomerHealth(env) {
  // Segment waterfall with migration data
  const [current, lastWeek] = await Promise.all([
    env.DB.prepare(`
      SELECT segment, COUNT(*) as count FROM retail_customers GROUP BY segment
    `).all(),
    // Approximate last week's segments by looking at updated_at
    env.DB.prepare(`
      SELECT segment, COUNT(*) as count FROM retail_customers
      WHERE updated_at < date('now', '-7 days')
      GROUP BY segment
    `).all(),
  ]);

  return jsonResponse({
    current: current.results || [],
    last_week: lastWeek.results || [],
  });
}

async function getTopCustomers(env) {
  const data = await env.DB.prepare(`
    SELECT id, first_name, visit_count, total_lifetime_value,
           avg_order_value, favorite_sku, segment, churn_risk_score, predicted_clv
    FROM retail_customers
    ORDER BY total_lifetime_value DESC
    LIMIT 10
  `).all();
  return jsonResponse(data.results || []);
}

async function getCateringCrossovers(env) {
  const crossovers = await env.DB.prepare(`
    SELECT rc.first_name, rc.phone, rc.visit_count, rc.largest_single_order,
           rc.total_lifetime_value, rc.last_visit_date, cl.id as catering_lead_id, cl.status
    FROM retail_customers rc
    LEFT JOIN catering_leads cl ON cl.id = rc.catering_lead_id
    WHERE rc.catering_flagged = 1
    ORDER BY rc.largest_single_order DESC
  `).all();
  return jsonResponse(crossovers.results || []);
}

async function getCustomerSegments(env) {
  const segments = await env.DB.prepare(`
    SELECT segment, COUNT(*) as count,
           AVG(total_lifetime_value) as avg_ltv,
           AVG(visit_count) as avg_visits
    FROM retail_customers GROUP BY segment ORDER BY count DESC
  `).all();
  return jsonResponse(segments.results || []);
}

// ── CROSS-CHANNEL SIGNAL PROCESSOR ──────────────────────────────
async function processCrossoverSignal(signal, env) {
  const { customer_phone, customer_email, customer_name,
          item_count, order_value, order_date } = signal;

  if (!customer_phone && !customer_email) {
    console.log('[Retail Queue] No contact info — cannot create catering lead');
    return;
  }

  const normalizedPhone = customer_phone ? normalizePhone(customer_phone) : null;
  const customerId = normalizedPhone
    ? hashPhone(normalizedPhone)
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
      (id, phone, normalized_phone, first_name, visit_count, total_lifetime_value,
       avg_items_per_order, largest_single_order, is_group_buyer,
       sms_eligible, sms_consent,
       first_visit_date, last_visit_date, segment, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'), 'new', datetime('now'), datetime('now'))
    `).bind(
      customerId, customer_phone || null, normalizedPhone,
      customer_name || null, order_value || 0, item_count, item_count,
      normalizedPhone ? 1 : 0, normalizedPhone ? 1 : 0,
    ).run();
  }

  const alreadyFlagged = await env.DB.prepare(
    'SELECT id FROM retail_customers WHERE id = ? AND catering_flagged = 1'
  ).bind(customerId).first();
  if (alreadyFlagged) return;

  const leadId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO catering_leads (
      id, contact_name, contact_email, contact_phone,
      source, source_customer_id, status, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'retail_crossover', ?, 'prospect', ?, datetime('now'), datetime('now'))
  `).bind(
    leadId, customer_name || null, customer_email || null,
    customer_phone || null, customerId,
    `Real-time crossover: ${item_count} items ($${order_value?.toFixed(0) || '?'}) on ${new Date(order_date).toLocaleDateString()}`,
  ).run();

  await env.DB.prepare(`
    UPDATE retail_customers SET catering_flagged = 1, catering_lead_id = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(leadId, customerId).run();

  const alertRaw = await env.KV.get('retail_crossover_alert');
  const alerts = alertRaw ? JSON.parse(alertRaw) : { count: 0, leads: [] };
  alerts.count += 1;
  alerts.leads.push({
    lead_id: leadId, name: customer_name || 'Unknown',
    item_count, order_value, flagged_at: new Date().toISOString(),
  });
  alerts.leads = alerts.leads.slice(-10);
  await env.KV.put('retail_crossover_alert', JSON.stringify(alerts), { expirationTtl: 604800 });

  console.log(`[Retail Queue] Crossover lead: ${customer_name || customer_phone} (${item_count} items)`);
}

// ── SWELL SMS ────────────────────────────────────────────────────
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

// ── HELPERS ──────────────────────────────────────────────────────
function calcSegment(visitCount) {
  if (visitCount >= VIP_VISIT_COUNT) return 'vip';
  if (visitCount >= REGULAR_VISIT_COUNT) return 'regular';
  return 'new';
}

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

function getWeekStart(isoDate) {
  const d = new Date(isoDate);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setUTCDate(diff);
  return monday.toISOString().split('T')[0];
}

function mode(arr) {
  if (!arr || arr.length === 0) return null;
  const counts = {};
  for (const v of arr) counts[v] = (counts[v] || 0) + 1;
  return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

// ══════════════════════════════════════════════════════════════════
// PHASE 1: ORDER BACKFILL — Write individual Toast orders to D1
// ══════════════════════════════════════════════════════════════════

function parseToastDate(dateStr) {
  if (!dateStr) return null;
  try {
    const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2}),?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    let [, month, day, year, hour, min, ampm] = match;
    year = parseInt(year) + 2000;
    hour = parseInt(hour);
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(year, parseInt(month) - 1, parseInt(day), hour, parseInt(min)).toISOString();
  } catch { return null; }
}

function parseMoney(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[$,]/g, '')) || 0;
}

function normalizePhoneForBackfill(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function extractNameFromTab(tabName) {
  if (!tabName) return null;
  const parts = tabName.split(/\n/).map(s => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last || last.includes('Server') || last.includes('Kiosk') || /^\d/.test(last)) return null;
  if (last.startsWith('DD ') || last.startsWith('UE ') || last.startsWith('GH ')) {
    const match = last.match(/^(?:DD|UE|GH)\s+\S+\s+(.+)/);
    return match ? match[1].trim() : null;
  }
  return last;
}

const ITEM_TO_SKU_BACKFILL = {
  'spicy bee': 'SPICY-BEE', 'spicy': 'SPICY-BEE',
  'bbk': 'BBK', 'brush before kissing': 'BBK', 'bbk - brush before kissing': 'BBK',
  'saint': 'SAINT', 'salty': 'SALTY',
  'for the kids': 'KIDS', 'kids': 'KIDS',
  'salty bombs': 'BOMBS', 'bombs': 'BOMBS', 'pretzel bombs': 'BOMBS',
};

function mapItemToSkuBackfill(itemName) {
  if (!itemName) return null;
  const lower = itemName.toLowerCase().trim();
  if (ITEM_TO_SKU_BACKFILL[lower]) return ITEM_TO_SKU_BACKFILL[lower];
  for (const [key, sku] of Object.entries(ITEM_TO_SKU_BACKFILL)) {
    if (lower.includes(key)) return sku;
  }
  return null;
}

// ── REBUILD PROFILES FROM ORDERS (data integrity fix) ────────────
// Recomputes visit_count, total_lifetime_value, first/last visit dates,
// avg_order_value, and order_frequency from the actual orders table.
// This is the source of truth since orders use INSERT OR IGNORE (idempotent).
async function rebuildProfilesFromOrders(env, offset = 0, limit = 500) {
  // Step 0: Link orphaned orders and reset profiles before rebuild
  if (offset === 0) {
    // Link orders with phone but no customer_id
    await env.DB.prepare(`
      UPDATE orders SET customer_id = 'rc_' || customer_phone
      WHERE customer_id IS NULL
        AND customer_phone IS NOT NULL AND customer_phone != ''
        AND LENGTH(customer_phone) = 10
    `).run();
    // Zero out all profiles so customers with only catering orders get reset
    await env.DB.prepare(`
      UPDATE retail_customers SET visit_count = 0, total_lifetime_value = 0,
        avg_order_value = 0, segment = 'new'
      WHERE id LIKE 'rc_%'
    `).run();
  }

  // Single aggregation query — no per-customer round trips
  // Paginated to avoid Worker CPU timeout
  // Excludes catering-scale orders (>$500 or >30 items)
  const allStats = await env.DB.prepare(`
    SELECT customer_id,
           COUNT(*) as cnt,
           SUM(gross_revenue) as rev,
           MIN(order_date) as first_date,
           MAX(order_date) as last_date,
           AVG(gross_revenue) as avg_rev
    FROM orders
    WHERE customer_id IS NOT NULL AND customer_id != ''
      AND customer_id LIKE 'rc_%'
      AND gross_revenue < 500
      AND (units < 30 OR units IS NULL)
    GROUP BY customer_id
    ORDER BY customer_id
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  const statsRows = allStats.results || [];
  let updated = 0;
  const stmts = [];

  for (const stats of statsRows) {
    if (!stats.cnt || stats.cnt === 0) continue;

    // Compute frequency: days between first and last visit / visit count
    let freqDays = 30;
    if (stats.cnt > 1 && stats.first_date && stats.last_date) {
      const span = (new Date(stats.last_date) - new Date(stats.first_date)) / 86400000;
      freqDays = Math.max(1, Math.round(span / (stats.cnt - 1)));
    }

    // Determine segment
    let segment = 'new';
    if (stats.cnt >= VIP_VISIT_COUNT) segment = 'vip';
    else if (stats.cnt >= REGULAR_VISIT_COUNT) segment = 'regular';

    // Check if lapsed/churned
    if (stats.last_date) {
      const daysSince = (Date.now() - new Date(stats.last_date).getTime()) / 86400000;
      if (daysSince >= CHURN_DAYS) segment = 'churned';
      else if (daysSince >= LAPSE_DAYS) segment = 'lapsed';
    }

    stmts.push(
      env.DB.prepare(`
        UPDATE retail_customers SET
          visit_count = ?,
          total_lifetime_value = ?,
          first_visit_date = ?,
          last_visit_date = ?,
          avg_order_value = ?,
          order_frequency_days = ?,
          segment = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        stats.cnt,
        Math.round(stats.rev * 100) / 100,
        stats.first_date,
        stats.last_date,
        Math.round((stats.avg_rev || 0) * 100) / 100,
        freqDays,
        segment,
        stats.customer_id,
      )
    );
    updated++;

    if (stmts.length >= 100) {
      await env.DB.batch(stmts.splice(0));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);

  console.log(`[Retail] Rebuilt ${updated} customer profiles from orders (offset=${offset})`);
  return jsonResponse({
    rebuilt: updated,
    total_checked: statsRows.length,
    offset,
    limit,
    has_more: statsRows.length === limit,
    next_offset: offset + limit,
  });
}

async function backfillOrderRows(env) {
  if (!env.POS_DATA_BUCKET) {
    return jsonResponse({ error: 'POS_DATA_BUCKET R2 binding not configured' }, 500);
  }

  try {
    // List all order files
    const list = await env.POS_DATA_BUCKET.list({ prefix: 'incoming/toast-orders/' });
    const fileKeys = list.objects.map(o => o.key).sort();
    let totalInserted = 0;
    let totalSkipped = 0;

    for (const key of fileKeys) {
      const obj = await env.POS_DATA_BUCKET.get(key);
      if (!obj) continue;

      const rawOrders = await obj.json();
      // Extract month from filename: orders-2024-10.json → 2024-10
      const monthMatch = key.match(/orders-(\d{4}-\d{2})/);
      const monthKey = monthMatch ? monthMatch[1] : 'unknown';

      const batch = [];

      for (let oi = 0; oi < rawOrders.length; oi++) {
        const order = rawOrders[oi];
        for (let ci = 0; ci < (order.checks || []).length; ci++) {
          const check = order.checks[ci];
          if (check.status === 'Voided') continue;

          const checkGuid = check.guid || `${oi}_${ci}`;
          const orderId = `toast_${monthKey}_${checkGuid}`;
          const orderDate = parseToastDate(check.timeOpened);
          if (!orderDate) continue;

          const grossRevenue = parseMoney(check.total);
          if (grossRevenue <= 0) continue;

          const phone = normalizePhoneForBackfill(check.phone);
          const name = extractNameFromTab(check.tabName);
          const customerId = phone ? `rc_${phone}` : null;

          // Parse items into SKU breakdown
          const items = (check.items || []).filter(i => !i.voided);
          const skuBreakdown = {};
          let unitCount = 0;
          for (const item of items) {
            const sku = mapItemToSkuBackfill(item.name);
            if (sku) {
              skuBreakdown[sku] = (skuBreakdown[sku] || 0) + (item.qty || 1);
              unitCount += (item.qty || 1);
            }
          }

          // Parse tips from payments
          let tipAmount = 0;
          for (const payment of (check.payments || [])) {
            tipAmount += parseMoney(payment.tip) + parseMoney(payment.gratuity);
          }

          // Dining option
          const diningOption = check.diningOption || order.source || null;

          // Discount
          const discountAmount = parseMoney(check.discounts);

          batch.push({
            id: orderId,
            source: 'toast',
            order_date: orderDate,
            units: unitCount || items.length,
            sku_breakdown: JSON.stringify(skuBreakdown),
            gross_revenue: grossRevenue,
            customer_phone: phone,
            customer_name: name,
            customer_id: customerId,
            tip_amount: tipAmount,
            dining_option: diningOption,
            discount_amount: discountAmount,
          });
        }
      }

      // Batch insert — 100 at a time
      for (let i = 0; i < batch.length; i += 100) {
        const chunk = batch.slice(i, i + 100);
        const stmts = chunk.map(o =>
          env.DB.prepare(`
            INSERT OR IGNORE INTO orders
            (id, source, order_date, units, sku_breakdown, gross_revenue,
             customer_phone, customer_name, customer_id, tip_amount, dining_option, discount_amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            o.id, o.source, o.order_date, o.units, o.sku_breakdown, o.gross_revenue,
            o.customer_phone, o.customer_name, o.customer_id, o.tip_amount, o.dining_option, o.discount_amount
          )
        );
        const results = await env.DB.batch(stmts);
        const inserted = results.filter(r => r.meta.changes > 0).length;
        totalInserted += inserted;
        totalSkipped += chunk.length - inserted;
      }

      console.log(`[OrderBackfill] ${key}: ${batch.length} orders processed`);
    }

    return jsonResponse({
      success: true,
      total_inserted: totalInserted,
      total_skipped: totalSkipped,
      message: `Backfilled ${totalInserted} order rows (${totalSkipped} already existed)`
    });
  } catch (err) {
    console.error('[OrderBackfill] Error:', err);
    return jsonResponse({ error: err.message }, 500);
  }
}

// ══════════════════════════════════════════════════════════════════
// PHASE 2: ANALYTICS ENDPOINTS
// ══════════════════════════════════════════════════════════════════

// ── 2.1 Monthly Trends ──────────────────────────────────────────
async function getMonthlyTrends(env) {
  const [currentMonth, previousMonth, newThisMonth, newLastMonth] = await Promise.all([
    env.DB.prepare(`
      SELECT SUM(gross_revenue) as revenue, COUNT(*) as transactions,
             AVG(gross_revenue) as avg_ticket, COUNT(DISTINCT customer_id) as unique_customers
      FROM orders WHERE order_date >= date('now', 'start of month')
    `).first(),
    env.DB.prepare(`
      SELECT SUM(gross_revenue) as revenue, COUNT(*) as transactions,
             AVG(gross_revenue) as avg_ticket, COUNT(DISTINCT customer_id) as unique_customers
      FROM orders WHERE order_date >= date('now', 'start of month', '-1 month')
        AND order_date < date('now', 'start of month')
    `).first(),
    env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_customers
      WHERE first_visit_date >= date('now', 'start of month')
    `).first(),
    env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_customers
      WHERE first_visit_date >= date('now', 'start of month', '-1 month')
        AND first_visit_date < date('now', 'start of month')
    `).first(),
  ]);

  const now = new Date();
  const daysElapsed = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const returningThisMonth = (currentMonth?.unique_customers || 0) - (newThisMonth?.count || 0);
  const returningLastMonth = (previousMonth?.unique_customers || 0) - (newLastMonth?.count || 0);

  const pctElapsed = daysElapsed / daysInMonth;
  const projectedRevenue = pctElapsed > 0 ? (currentMonth?.revenue || 0) / pctElapsed : 0;

  const delta = (curr, prev) => prev > 0 ? Math.round(((curr || 0) / prev - 1) * 100) : null;

  return jsonResponse({
    current_month: {
      revenue: currentMonth?.revenue || 0,
      transactions: currentMonth?.transactions || 0,
      avg_ticket: Math.round((currentMonth?.avg_ticket || 0) * 100) / 100,
      unique_customers: currentMonth?.unique_customers || 0,
      new_customers: newThisMonth?.count || 0,
      returning_customers: Math.max(0, returningThisMonth),
      days_elapsed: daysElapsed,
      days_in_month: daysInMonth,
    },
    previous_month: {
      revenue: previousMonth?.revenue || 0,
      transactions: previousMonth?.transactions || 0,
      avg_ticket: Math.round((previousMonth?.avg_ticket || 0) * 100) / 100,
      unique_customers: previousMonth?.unique_customers || 0,
      new_customers: newLastMonth?.count || 0,
      returning_customers: Math.max(0, returningLastMonth),
    },
    deltas: {
      revenue_pct: delta(currentMonth?.revenue, previousMonth?.revenue),
      transactions_pct: delta(currentMonth?.transactions, previousMonth?.transactions),
      avg_ticket_pct: delta(currentMonth?.avg_ticket, previousMonth?.avg_ticket),
      new_customers_pct: delta(newThisMonth?.count, newLastMonth?.count),
      returning_pct: delta(Math.max(0, returningThisMonth), Math.max(1, returningLastMonth)),
    },
    pace: {
      pct_elapsed: Math.round(pctElapsed * 100),
      pct_of_last_month: previousMonth?.revenue > 0
        ? Math.round(((currentMonth?.revenue || 0) / previousMonth.revenue) * 100) : null,
      projected_revenue: Math.round(projectedRevenue),
      on_track: previousMonth?.revenue > 0
        ? (currentMonth?.revenue || 0) / previousMonth.revenue >= pctElapsed : null,
    },
  });
}

// ── 2.2 Loyalty Funnel ──────────────────────────────────────────
async function getLoyaltyFunnel(env) {
  const [funnel, total, almostMagic] = await Promise.all([
    env.DB.prepare(`
      SELECT
        CASE
          WHEN visit_count = 1 THEN '1 visit'
          WHEN visit_count BETWEEN 2 AND 3 THEN '2-3 visits'
          WHEN visit_count BETWEEN 4 AND 5 THEN '4-5 visits'
          WHEN visit_count >= 6 THEN '6+ (VIP)'
        END as stage,
        COUNT(*) as count,
        MIN(visit_count) as min_visits
      FROM retail_customers
      GROUP BY stage
      ORDER BY min_visits
    `).all(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM retail_customers`).first(),
    env.DB.prepare(`
      SELECT id, first_name, phone, visit_count, total_lifetime_value,
             last_visit_date, favorite_sku, segment
      FROM retail_customers
      WHERE visit_count BETWEEN 4 AND 5 AND segment NOT IN ('churned', 'lapsed')
      ORDER BY total_lifetime_value DESC LIMIT 20
    `).all(),
  ]);

  const totalCount = total?.total || 1;
  const stages = (funnel.results || []).map(s => ({
    stage: s.stage,
    count: s.count,
    pct: Math.round(s.count / totalCount * 1000) / 10,
  }));

  // Conversion rates
  const oneVisit = stages.find(s => s.stage === '1 visit')?.count || 0;
  const twoThree = stages.find(s => s.stage === '2-3 visits')?.count || 0;
  const fourFive = stages.find(s => s.stage === '4-5 visits')?.count || 0;
  const vip = stages.find(s => s.stage === '6+ (VIP)')?.count || 0;
  const multiVisit = twoThree + fourFive + vip;

  return jsonResponse({
    funnel: stages,
    total_customers: totalCount,
    conversion_rates: {
      first_to_second: oneVisit > 0 ? Math.round(multiVisit / (oneVisit + multiVisit) * 1000) / 1000 : 0,
      to_regular: totalCount > 0 ? Math.round((fourFive + vip) / totalCount * 1000) / 1000 : 0,
      to_vip: totalCount > 0 ? Math.round(vip / totalCount * 10000) / 10000 : 0,
    },
    almost_vips: almostMagic.results || [],
  });
}

// ── 2.3 Magic Number ────────────────────────────────────────────
async function getMagicNumber(env) {
  // Measure DROP-OFF rate: what % of people who reached visit N never made it to N+1
  // This is independent of current segment status (churned/lapsed) and works during POS transitions
  const data = await env.DB.prepare(`
    SELECT visit_count, COUNT(*) as total
    FROM retail_customers
    WHERE visit_count BETWEEN 1 AND 10
    GROUP BY visit_count
    ORDER BY visit_count
  `).all();

  const counts = (data.results || []);
  // Build cumulative: how many people reached AT LEAST visit N
  // People with visit_count=5 also "reached" visits 1,2,3,4
  const reachedAtLeast = {};
  for (let n = 1; n <= 10; n++) {
    reachedAtLeast[n] = counts.filter(r => r.visit_count >= n).reduce((s, r) => s + r.total, 0);
  }

  const rates = [];
  for (let n = 1; n <= 10; n++) {
    const reached = reachedAtLeast[n] || 0;
    const reachedNext = reachedAtLeast[n + 1] || 0;
    const dropoffRate = reached > 0 ? Math.round((1 - reachedNext / reached) * 1000) / 1000 : 1;
    rates.push({
      after_visit: n,
      churn_rate: dropoffRate, // "drop-off rate" — % who stopped after this visit
      sample_size: reached,
    });
  }

  // Find magic number: biggest drop-off DECREASE between consecutive visits
  // i.e., the visit where people suddenly become much more likely to return
  // Require minimum sample size of 30 for statistical relevance
  let magicNumber = 3; // default — realistic for food truck retention
  let biggestDrop = 0;
  for (let i = 1; i < rates.length; i++) {
    if (rates[i].sample_size < 30) continue; // skip tiny cohorts
    const drop = rates[i - 1].churn_rate - rates[i].churn_rate;
    if (drop > biggestDrop) {
      biggestDrop = drop;
      magicNumber = rates[i].after_visit;
    }
  }

  // Count customers approaching magic number
  const approaching = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM retail_customers
    WHERE visit_count = ? AND segment NOT IN ('churned', 'lapsed')
  `).bind(magicNumber - 1).first();

  const atMagic = rates.find(r => r.after_visit === magicNumber);
  const beforeMagic = rates.find(r => r.after_visit === magicNumber - 1);

  return jsonResponse({
    visit_churn_rates: rates,
    magic_number: magicNumber,
    approaching_count: approaching?.count || 0,
    insight: beforeMagic && atMagic
      ? `After visit ${magicNumber - 1}, ${Math.round(beforeMagic.churn_rate * 100)}% drop off. After visit ${magicNumber}, only ${Math.round(atMagic.churn_rate * 100)}% drop off. Getting to ${magicNumber} visits is the retention unlock.`
      : `Target: ${magicNumber} visits. Once customers hit this milestone, they're far more likely to keep coming back.`,
  });
}

// ── 2.4 Time to Return ─────────────────────────────────────────
async function getTimeToReturn(env) {
  // Get customers with 2+ visits and their first two order dates
  const data = await env.DB.prepare(`
    SELECT rc.id, rc.visit_count, rc.first_visit_date,
      (SELECT MIN(o.order_date) FROM orders o
       WHERE o.customer_id = rc.id AND o.order_date > rc.first_visit_date) as second_visit_date
    FROM retail_customers rc
    WHERE rc.visit_count >= 2 AND rc.first_visit_date IS NOT NULL
  `).all();

  const gaps = [];
  for (const row of (data.results || [])) {
    if (row.first_visit_date && row.second_visit_date) {
      const days = Math.round((new Date(row.second_visit_date) - new Date(row.first_visit_date)) / 86400000);
      if (days > 0 && days < 365) gaps.push(days);
    }
  }

  if (gaps.length === 0) {
    return jsonResponse({ median_days: null, message: 'No return visit data available yet' });
  }

  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  const p25 = gaps[Math.floor(gaps.length * 0.25)];
  const p75 = gaps[Math.floor(gaps.length * 0.75)];

  const totalWithPhone = await env.DB.prepare(`
    SELECT COUNT(*) as c FROM retail_customers WHERE visit_count = 1 AND phone IS NOT NULL
  `).first();

  const totalOneVisit = await env.DB.prepare(`
    SELECT COUNT(*) as c FROM retail_customers WHERE visit_count = 1
  `).first();

  const neverCameBack = totalOneVisit?.c > 0
    ? Math.round(totalOneVisit.c / (totalOneVisit.c + gaps.length) * 100) / 100 : 0;

  // Optimal SMS window: send at p25 (catches early returners with nudge)
  const optimalDay = Math.max(3, Math.min(p25, 7));

  return jsonResponse({
    median_days_to_second_visit: median,
    p25,
    p75,
    sample_size: gaps.length,
    came_back_within_7d: Math.round(gaps.filter(g => g <= 7).length / gaps.length * 100) / 100,
    came_back_within_14d: Math.round(gaps.filter(g => g <= 14).length / gaps.length * 100) / 100,
    came_back_within_30d: Math.round(gaps.filter(g => g <= 30).length / gaps.length * 100) / 100,
    never_came_back: neverCameBack,
    optimal_sms_window: {
      day: optimalDay,
      reasoning: `${Math.round((1 - neverCameBack) * 100)}% of returners come back within ${p75} days. Day ${optimalDay} catches early returners with a nudge before they forget.`,
    },
  });
}

// ── 2.5 Cohort Retention ────────────────────────────────────────
async function getCohortRetention(env) {
  // Get all customers with first_visit_date, grouped by acquisition month
  const cohorts = await env.DB.prepare(`
    SELECT strftime('%Y-%m', first_visit_date) as cohort_month,
           COUNT(*) as acquired
    FROM retail_customers
    WHERE first_visit_date IS NOT NULL
    GROUP BY cohort_month
    ORDER BY cohort_month
  `).all();

  const results = [];

  for (const cohort of (cohorts.results || [])) {
    const month = cohort.cohort_month;
    if (!month) continue;

    // For each retention window, count customers who ordered again
    const [r30, r60, r90, r180] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(DISTINCT o.customer_id) as retained
        FROM orders o
        JOIN retail_customers rc ON o.customer_id = rc.id
        WHERE strftime('%Y-%m', rc.first_visit_date) = ?
          AND o.order_date > date(rc.first_visit_date, '+1 day')
          AND o.order_date <= date(rc.first_visit_date, '+30 days')
      `).bind(month).first(),
      env.DB.prepare(`
        SELECT COUNT(DISTINCT o.customer_id) as retained
        FROM orders o
        JOIN retail_customers rc ON o.customer_id = rc.id
        WHERE strftime('%Y-%m', rc.first_visit_date) = ?
          AND o.order_date > date(rc.first_visit_date, '+1 day')
          AND o.order_date <= date(rc.first_visit_date, '+60 days')
      `).bind(month).first(),
      env.DB.prepare(`
        SELECT COUNT(DISTINCT o.customer_id) as retained
        FROM orders o
        JOIN retail_customers rc ON o.customer_id = rc.id
        WHERE strftime('%Y-%m', rc.first_visit_date) = ?
          AND o.order_date > date(rc.first_visit_date, '+1 day')
          AND o.order_date <= date(rc.first_visit_date, '+90 days')
      `).bind(month).first(),
      env.DB.prepare(`
        SELECT COUNT(DISTINCT o.customer_id) as retained
        FROM orders o
        JOIN retail_customers rc ON o.customer_id = rc.id
        WHERE strftime('%Y-%m', rc.first_visit_date) = ?
          AND o.order_date > date(rc.first_visit_date, '+1 day')
          AND o.order_date <= date(rc.first_visit_date, '+180 days')
      `).bind(month).first(),
    ]);

    const acq = cohort.acquired;
    results.push({
      month,
      acquired: acq,
      retained_30d: acq > 0 ? Math.round((r30?.retained || 0) / acq * 1000) / 1000 : 0,
      retained_60d: acq > 0 ? Math.round((r60?.retained || 0) / acq * 1000) / 1000 : 0,
      retained_90d: acq > 0 ? Math.round((r90?.retained || 0) / acq * 1000) / 1000 : 0,
      retained_180d: acq > 0 ? Math.round((r180?.retained || 0) / acq * 1000) / 1000 : 0,
    });
  }

  // Determine trend (compare last 3 months' 30d retention)
  const recent = results.filter(r => r.acquired >= 10).slice(-6);
  let trend = 'flat';
  if (recent.length >= 3) {
    const first3 = recent.slice(0, 3).reduce((s, r) => s + r.retained_30d, 0) / 3;
    const last3 = recent.slice(-3).reduce((s, r) => s + r.retained_30d, 0) / 3;
    if (last3 > first3 * 1.1) trend = 'improving';
    else if (last3 < first3 * 0.9) trend = 'declining';
  }

  const best = results.filter(r => r.acquired >= 10).sort((a, b) => b.retained_30d - a.retained_30d)[0];
  const worst = results.filter(r => r.acquired >= 10).sort((a, b) => a.retained_30d - b.retained_30d)[0];

  return jsonResponse({
    cohorts: results,
    trend,
    best_cohort: best?.month || null,
    worst_cohort: worst?.month || null,
  });
}

// ── 2.6 Revenue Health ──────────────────────────────────────────
async function getRevenueHealth(env) {
  const [concentration, newVsReturning, atRisk, vipData] = await Promise.all([
    // Revenue concentration: what % comes from top 10% / 25%
    env.DB.prepare(`
      SELECT total_lifetime_value FROM retail_customers
      WHERE total_lifetime_value > 0
      ORDER BY total_lifetime_value DESC
    `).all(),
    // New vs returning revenue this month
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN rc.first_visit_date >= date('now', 'start of month') THEN o.gross_revenue ELSE 0 END) as new_revenue,
        SUM(CASE WHEN rc.first_visit_date < date('now', 'start of month') THEN o.gross_revenue ELSE 0 END) as returning_revenue
      FROM orders o
      LEFT JOIN retail_customers rc ON o.customer_id = rc.id
      WHERE o.order_date >= date('now', 'start of month')
    `).first(),
    // Revenue at risk (predicted CLV of lapsed customers)
    env.DB.prepare(`
      SELECT COUNT(*) as count, SUM(predicted_clv) as clv_sum, SUM(total_lifetime_value) as ltv_sum
      FROM retail_customers WHERE segment = 'lapsed'
    `).first(),
    // VIP dependency
    env.DB.prepare(`
      SELECT COUNT(*) as count, SUM(total_lifetime_value) as total_ltv, AVG(total_lifetime_value) as avg_ltv
      FROM retail_customers WHERE segment = 'vip'
    `).first(),
  ]);

  const customers = concentration.results || [];
  const totalLTV = customers.reduce((s, c) => s + c.total_lifetime_value, 0);
  const top10pct = customers.slice(0, Math.ceil(customers.length * 0.1)).reduce((s, c) => s + c.total_lifetime_value, 0);
  const top25pct = customers.slice(0, Math.ceil(customers.length * 0.25)).reduce((s, c) => s + c.total_lifetime_value, 0);

  const totalMonthRevenue = (newVsReturning?.new_revenue || 0) + (newVsReturning?.returning_revenue || 0);

  return jsonResponse({
    top_10pct_revenue_share: totalLTV > 0 ? Math.round(top10pct / totalLTV * 100) / 100 : 0,
    top_25pct_revenue_share: totalLTV > 0 ? Math.round(top25pct / totalLTV * 100) / 100 : 0,
    new_vs_returning: {
      new_revenue_pct: totalMonthRevenue > 0 ? Math.round((newVsReturning?.new_revenue || 0) / totalMonthRevenue * 100) / 100 : 0,
      returning_revenue_pct: totalMonthRevenue > 0 ? Math.round((newVsReturning?.returning_revenue || 0) / totalMonthRevenue * 100) / 100 : 0,
    },
    revenue_at_risk: Math.round(atRisk?.ltv_sum || 0),
    at_risk_customers: atRisk?.count || 0,
    vip_dependency: {
      vip_count: vipData?.count || 0,
      vip_revenue_share: totalLTV > 0 ? Math.round((vipData?.total_ltv || 0) / totalLTV * 100) / 100 : 0,
      if_1_vip_churns: -Math.round(vipData?.avg_ltv || 0),
    },
  });
}

// ── 2.7 Menu Loyalty ────────────────────────────────────────────
async function getMenuLoyalty(env) {
  // Get all first-visit orders with SKU breakdowns
  const firstVisitOrders = await env.DB.prepare(`
    SELECT o.sku_breakdown, o.gross_revenue, rc.visit_count, rc.id as customer_id
    FROM orders o
    JOIN retail_customers rc ON o.customer_id = rc.id
    WHERE o.order_date = rc.first_visit_date
      AND o.sku_breakdown IS NOT NULL
      AND o.sku_breakdown != '{}'
  `).all();

  // Get all orders for avg ticket analysis
  const allOrders = await env.DB.prepare(`
    SELECT sku_breakdown, gross_revenue FROM orders
    WHERE sku_breakdown IS NOT NULL AND sku_breakdown != '{}'
  `).all();

  // Analyze per-SKU
  const skuStats = {};
  const baselineReturn = { total: 0, returned: 0 };

  for (const row of (firstVisitOrders.results || [])) {
    try {
      const skus = JSON.parse(row.sku_breakdown);
      baselineReturn.total++;
      if (row.visit_count >= 2) baselineReturn.returned++;

      for (const sku of Object.keys(skus)) {
        if (!skuStats[sku]) skuStats[sku] = { first_visit_orders: 0, came_back: 0, total_orders: 0, total_revenue: 0 };
        skuStats[sku].first_visit_orders++;
        if (row.visit_count >= 2) skuStats[sku].came_back++;
      }
    } catch {}
  }

  // Avg ticket with/without each SKU
  const ticketWith = {};
  const ticketWithout = {};
  for (const row of (allOrders.results || [])) {
    try {
      const skus = JSON.parse(row.sku_breakdown);
      const skuKeys = Object.keys(skus);
      for (const sku of Object.keys(skuStats)) {
        if (skuKeys.includes(sku)) {
          if (!ticketWith[sku]) ticketWith[sku] = [];
          ticketWith[sku].push(row.gross_revenue);
        } else {
          if (!ticketWithout[sku]) ticketWithout[sku] = [];
          ticketWithout[sku].push(row.gross_revenue);
        }
      }
    } catch {}
  }

  const baselineReturnRate = baselineReturn.total > 0
    ? Math.round(baselineReturn.returned / baselineReturn.total * 1000) / 1000 : 0;

  const results = Object.entries(skuStats).map(([sku, stats]) => {
    const comeBackRate = stats.first_visit_orders > 0
      ? Math.round(stats.came_back / stats.first_visit_orders * 1000) / 1000 : 0;
    const avgWith = ticketWith[sku]?.length > 0
      ? Math.round(ticketWith[sku].reduce((s, v) => s + v, 0) / ticketWith[sku].length * 100) / 100 : 0;
    const avgWithout = ticketWithout[sku]?.length > 0
      ? Math.round(ticketWithout[sku].reduce((s, v) => s + v, 0) / ticketWithout[sku].length * 100) / 100 : 0;

    return {
      sku,
      first_visit_orders: stats.first_visit_orders,
      came_back_rate: comeBackRate,
      baseline_return_rate: baselineReturnRate,
      loyalty_lift: Math.round((comeBackRate - baselineReturnRate) * 1000) / 10, // percentage points
      avg_ticket_with: avgWith,
      avg_ticket_without: avgWithout,
      ticket_lift: Math.round((avgWith - avgWithout) * 100) / 100,
    };
  }).sort((a, b) => b.loyalty_lift - a.loyalty_lift);

  return jsonResponse({
    baseline_return_rate: baselineReturnRate,
    items: results,
  });
}

// ── 2.8 Ticket Drivers ──────────────────────────────────────────
async function getTicketDrivers(env) {
  const [bySegment, byItemCount, byDining, monthlyTrend] = await Promise.all([
    // Avg ticket by segment (exclude catering-scale orders)
    env.DB.prepare(`
      SELECT rc.segment, AVG(o.gross_revenue) as avg_ticket, COUNT(*) as orders
      FROM orders o
      JOIN retail_customers rc ON o.customer_id = rc.id
      WHERE rc.segment IS NOT NULL
        AND o.gross_revenue < 500 AND (o.units < 30 OR o.units IS NULL)
      GROUP BY rc.segment
      ORDER BY avg_ticket DESC
    `).all(),
    // Single vs multi-item (exclude catering-scale)
    env.DB.prepare(`
      SELECT
        CASE WHEN units > 1 THEN 'multi_item' ELSE 'single_item' END as order_type,
        AVG(gross_revenue) as avg_ticket, COUNT(*) as orders
      FROM orders WHERE units > 0
        AND gross_revenue < 500 AND (units < 30 OR units IS NULL)
      GROUP BY order_type
    `).all(),
    // By dining option
    env.DB.prepare(`
      SELECT dining_option, AVG(gross_revenue) as avg_ticket, COUNT(*) as orders
      FROM orders WHERE dining_option IS NOT NULL
      GROUP BY dining_option
      ORDER BY avg_ticket DESC LIMIT 10
    `).all(),
    // Monthly trend (exclude catering-scale)
    env.DB.prepare(`
      SELECT strftime('%Y-%m', order_date) as month,
             AVG(gross_revenue) as avg_ticket, COUNT(*) as transactions,
             SUM(gross_revenue) as revenue
      FROM orders
      WHERE gross_revenue < 500 AND (units < 30 OR units IS NULL)
      GROUP BY month ORDER BY month
    `).all(),
  ]);

  return jsonResponse({
    by_segment: (bySegment.results || []).map(r => ({
      segment: r.segment,
      avg_ticket: Math.round(r.avg_ticket * 100) / 100,
      orders: r.orders,
    })),
    by_item_count: (byItemCount.results || []).map(r => ({
      type: r.order_type,
      avg_ticket: Math.round(r.avg_ticket * 100) / 100,
      orders: r.orders,
    })),
    by_dining_option: (byDining.results || []).map(r => ({
      option: r.dining_option,
      avg_ticket: Math.round(r.avg_ticket * 100) / 100,
      orders: r.orders,
    })),
    monthly_trend: (monthlyTrend.results || []).map(r => ({
      month: r.month,
      avg_ticket: Math.round(r.avg_ticket * 100) / 100,
      transactions: r.transactions,
      revenue: Math.round(r.revenue),
    })),
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
