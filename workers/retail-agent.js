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
import { callAI } from './ai-budget.js';

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
    return runRetailAgent(env);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (message.body.type === 'retail_group_order') {
          await processCrossoverSignal(message.body, env);
          message.ack();
        } else if (message.body.type === 'campaign_trigger') {
          await processCampaignTrigger(message.body, env);
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
      const step = url.searchParams.get('step');
      const dryRun = url.searchParams.get('dry_run') === 'true';
      // Signal dry-run to downstream functions via env._dryRunConditionCampaigns
      if (dryRun) env._dryRunConditionCampaigns = true;
      if (step) {
        const result = await runRetailStep(step, env);
        return jsonResponse({ ...result, dry_run: dryRun });
      }
      const result = await runRetailAgent(env);
      return jsonResponse({ ...result, dry_run: dryRun });
    }
    if (path === '/retail/insight') {
      const cached = await env.KV.get('retail_weekly_insight');
      if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json' } });
      const insight = await generateWeeklyInsight(env);
      return jsonResponse(insight || {});
    }
    if (path === '/retail/crossovers') return getCateringCrossovers(env);
    if (path === '/retail/customers') return getCustomerSegments(env);

    // Send-paths observability — audit where SMS is going (and being blocked from going).
    // Returns sends-by-campaign + blocks-by-reason over last 30 days, plus collision count
    // (should be 0 now that the 48h guard is live). Use this to verify the daily cron is
    // only firing through approved paths.
    if (path === '/retail/send-paths') return getSendPaths(env);

    // Template linter — POST {template_text} or {campaign_id, message_template, message_variants}
    // Returns { ok, issues } for each string checked. Use this BEFORE writing a new template
    // to the DB so bad copy never lands in a campaign row.
    if (path === '/retail/campaigns/validate-template' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const results = {};
      if (body.template_text) {
        results.template_text = validateCampaignTemplate(body.template_text);
      }
      if (body.message_template) {
        results.message_template = validateCampaignTemplate(body.message_template);
      }
      if (body.message_variants && typeof body.message_variants === 'object') {
        results.message_variants = {};
        for (const [key, text] of Object.entries(body.message_variants)) {
          results.message_variants[key] = validateCampaignTemplate(text);
        }
      }
      // Convenience: pass a campaign_id to auto-pull + validate the entire campaign
      if (body.campaign_id) {
        const c = await env.DB.prepare('SELECT message_template, message_variants FROM retail_campaigns WHERE id = ?').bind(body.campaign_id).first();
        if (c) {
          if (c.message_template) results.campaign_message_template = validateCampaignTemplate(c.message_template);
          if (c.message_variants) {
            try {
              const vObj = JSON.parse(c.message_variants);
              results.campaign_message_variants = {};
              for (const [key, text] of Object.entries(vObj)) {
                results.campaign_message_variants[key] = validateCampaignTemplate(text);
              }
            } catch (e) {
              results.campaign_message_variants = { error: 'parse failed: ' + e.message };
            }
          }
        } else {
          results.campaign_message_template = { error: 'campaign not found' };
        }
      }
      // Roll up: overall ok = every leaf validation's ok=true
      const allChecks = Object.values(results).flatMap(v => (v && typeof v === 'object' && 'ok' in v) ? [v] : (v && typeof v === 'object' ? Object.values(v) : []));
      const overall = allChecks.every(v => v && v.ok);
      return jsonResponse({ ok: overall, checks: results });
    }

    // Emergency cleanup: delete orphaned Square catalog DISCOUNT objects whose codes match
    // our code prefixes but are not tracked in retail_campaign_discounts. Used after accidental
    // mass-creates during dry-runs or testing. Requires { confirm: true } in POST body.
    if (path === '/retail/cleanup-square-orphans' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.confirm) return jsonResponse({ error: 'Send {"confirm": true} to proceed' }, 400);
      return await cleanupSquareCatalogOrphans(env);
    }

    // Platinum dossier — returns per-customer brief + proposed copy slot for the 13
    // lapsed VIPs. Drew reviews, tweaks copy inline, posts back to /dossier/send.
    if (path.match(/^\/retail\/campaigns\/[^/]+\/dossier$/) && request.method === 'GET') {
      const campaignId = path.split('/')[3];
      return await runPlatinumDossier(campaignId, env);
    }
    if (path.match(/^\/retail\/campaigns\/[^/]+\/dossier\/send$/) && request.method === 'POST') {
      const campaignId = path.split('/')[3];
      const body = await request.json().catch(() => ({}));
      return await runPlatinumDossierSend(campaignId, body, env);
    }

    // Graduate controls — at Day 14 per cohort, moves held-out control customers
    // into the winning variant (or kills them if they already returned naturally).
    // POST body: { campaign_id, winning_variant_key }
    if (path === '/retail/campaigns/graduate-controls' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { campaign_id, winning_variant_key } = body;
      if (!campaign_id || !winning_variant_key) {
        return jsonResponse({ error: 'campaign_id + winning_variant_key required' }, 400);
      }
      return await graduateControls(campaign_id, winning_variant_key, env);
    }

    // Auto-graduate ALL eligible controls across every active continuous campaign.
    // No body needed. Used for catching up when cron hasn't run, or sanity-testing
    // the per-variant winner-picking logic.
    if (path === '/retail/controls/graduate-all' && request.method === 'POST') {
      const summary = await autoGraduateControls(env);
      return jsonResponse(summary);
    }

    // Manual enrollment — force-enroll a specific list of customer_ids into a campaign,
    // bypassing trigger conditions. Used for one-shot backfills when the cron was down
    // or the trigger rules were too strict for a cohort we want to welcome anyway.
    // POST body: { campaign_id, customer_ids: [...], dry_run?: true }
    if (path === '/retail/enroll-manual' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { campaign_id, customer_ids, dry_run } = body;
      if (!campaign_id || !Array.isArray(customer_ids) || !customer_ids.length) {
        return jsonResponse({ error: 'campaign_id + customer_ids[] required' }, 400);
      }
      return await runManualEnrollment({ campaign_id, customer_ids, dryRun: !!dry_run }, env);
    }

    // Holiday promo fire — one-shot event campaign with cohort-SQL built in. Currently
    // scoped to the National Pretzel Day 2026 campaign (holiday_npd_2026). Chunked at 300
    // sends per call to stay under Worker CPU limits; caller re-invokes until remaining=0.
    // POST body: { wave: 1|2, dry_run?: boolean, batch_size?: number }
    if (path === '/retail/campaigns/holiday-promo-fire' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return await fireHolidayPromo(body, env);
    }

    // ── Emergency SMS kill-switch ────────────────────────────
    // One-click pause for every active campaign. Use when a misfire is in
    // progress or Drew wants to halt all SMS during a store closure/outage.
    // Returns count of campaigns flipped so the UI can confirm scope.
    if (path === '/retail/emergency-pause' && request.method === 'POST') {
      return await emergencyPauseAllSMS(env);
    }
    // Lightweight status probe the UI polls to render the kill-switch pill
    // (green "All systems live" vs red "⚠ 5 campaigns paused"). Cheap COUNT.
    if (path === '/retail/kill-switch-status' && request.method === 'GET') {
      return await getKillSwitchStatus(env);
    }

    // ── Dashboard (aggregated single call) ───────────────────
    if (path === '/retail/dashboard') return getDashboardData(env);

    // ── Retail Results — redesigned tab data feed (60s polling) ──
    if (path === '/retail/results') return getRetailResults(env, url.searchParams.get('period'));

    // ── V2 endpoints — Verdict + Suggestions + Deliverability ─
    if (path === '/retail/verdict' && request.method === 'GET') return getVerdict(env, url);
    if (path === '/retail/suggestions' && request.method === 'GET') return getSuggestions(env);
    if (path.startsWith('/retail/suggestions/') && path.endsWith('/done') && request.method === 'POST') {
      const id = path.split('/')[3];
      return markSuggestionDone(env, id);
    }
    if (path.startsWith('/retail/suggestions/') && path.endsWith('/snooze') && request.method === 'POST') {
      const id = path.split('/')[3];
      const body = await request.json().catch(() => ({}));
      return snoozeSuggestion(env, id, body.days || 7);
    }
    if (path === '/retail/deliverability/health' && request.method === 'GET') return getDeliverabilityHealth(env);
    if (path === '/retail/deliverability/test-email' && request.method === 'POST') return testDeliverability(env);
    // B.0 — typeable code spike: tests Square API mechanisms for customer-typeable per-customer codes.
    if (path === '/retail/typeable-code-spike' && request.method === 'POST') return typeableCodeSpike(env, url);
    if (path === '/retail/typeable-code-spike/cleanup' && request.method === 'POST') return cleanupSpikeObjects(env, url);
    if (path === '/retail/code-pool/import' && request.method === 'POST') return importCodePool(request, env);
    if (path === '/retail/code-pool/status' && request.method === 'GET') return getCodePoolStatus(env);
    if (path === '/retail/loyalty-spike' && request.method === 'POST') return loyaltyMechanismSpike(env, url);
    if (path === '/retail/loyalty-tier-add' && request.method === 'POST') return tryAddLoyaltyTier(env, url);
    if (path === '/retail/loyalty/issue-test' && request.method === 'POST') return issueTestLoyaltyReward(request, env);
    if (path === '/retail/loyalty/tiers' && request.method === 'GET') return listLoyaltyTiers(env);
    if (path === '/retail/loyalty/tiers/diag' && request.method === 'GET') return diagLoyaltyTiers(env);
    if (path === '/retail/loyalty/account-rewards' && request.method === 'GET') return inspectLoyaltyAccount(request, env, url);
    if (path === '/retail/repair-resend' && request.method === 'POST') return runRepairResend(request, env, url);
    if (path === '/retail/repair-resend/reminder' && request.method === 'POST') return runRepairResendReminder(request, env, url);
    if (path === '/retail/wave/backfill-reward-ids' && request.method === 'POST') return backfillWaveRewardIds(request, env, url);
    if (path === '/retail/wave/reissue-unmatched' && request.method === 'POST') return reissueUnmatchedWaveRewards(request, env, url);
    if (path === '/retail/catering-reactivation/fire' && request.method === 'POST') return fireCateringReactivation(request, env, url);
    if (path === '/retail/catering-reactivation/redeem-token' && request.method === 'POST') return redeemCateringToken(request, env);
    if (path === '/retail/catering-reactivation/status' && request.method === 'GET') return cateringReactivationStatus(env);
    if (path === '/retail/catering-reactivation/mint-test-token' && request.method === 'POST') {
      // Dev-only: mint a test token for end-to-end checkout verification.
      // Sends NO SMS — just creates a token Drew can paste into the catering URL.
      const body = await request.json().catch(() => ({}));
      const t = await mintCateringPromoToken(env, {
        customer_id: body.customer_id || 'test_' + Date.now(),
        customer_phone: body.customer_phone || null,
        customer_email: body.customer_email || null,
      });
      return jsonResponse({
        token: t.token,
        expires_at: t.expires_at,
        magic_url: `https://www.dangerouspretzel.com/v2/catering.html?promo=${t.token}`,
      });
    }
    if (path === '/retail/email/webhooks' && request.method === 'GET') return listResendWebhooks(env);
    if (path === '/retail/email/webhooks/fix-opens' && request.method === 'POST') return fixResendWebhookOpens(env);
    if (path === '/retail/cohort-comparison' && request.method === 'GET') return getCohortComparison(env);
    if (path === '/retail/customer-funnel' && request.method === 'GET') return getCustomerFunnel(env);
    if (path === '/retail/campaigns/performance' && request.method === 'GET') return getCampaignsPerformance(env);
    if (path === '/retail/forecast' && request.method === 'GET') return getRetailForecast(env);
    if (path === '/retail/cron-queue/forecast' && request.method === 'GET') return getCronQueueForecast(env);

    // ── Campaigns ────────────────────────────────────────────
    if (path === '/retail/campaigns' && request.method === 'GET') return getCampaigns(env);
    if (path === '/retail/campaigns' && request.method === 'POST') return createCampaign(request, env);
    if (path === '/retail/campaigns/external/setup' && request.method === 'POST') return createExternalCampaign(request, env);
    if (path === '/retail/square-marketing/probe' && request.method === 'GET') return probeSquareMarketing(env);
    if (path === '/retail/square-labor/probe' && request.method === 'GET') return probeSquareLabor(env);
    if (path === '/retail/square-labor/daily-summary' && request.method === 'GET') return squareLaborDailySummary(env, url);
    // Drilldown — last 20 email sends for a given campaign (Tier 3 modal).
    if (path.startsWith('/retail/campaigns/') && path.endsWith('/emails') && request.method === 'GET') {
      const campaignId = path.split('/')[3];
      const emails = await env.DB.prepare(`
        SELECT id, to_email, subject, status, status_detail,
               sent_at, opened_at, clicked_at, bounced_at, unsubscribed_at, cohort
        FROM email_sends
        WHERE campaign_id = ?
        ORDER BY sent_at DESC LIMIT 20
      `).bind(campaignId).all().catch(() => ({ results: [] }));
      return jsonResponse({ campaign_id: campaignId, emails: emails.results || [] });
    }
    if (path === '/retail/square-marketing/customer-reach' && request.method === 'GET') return probeSquareCustomerReach(env);
    // Enriched campaign list for the merged CAMPAIGNS UI (all statuses + rolling stats + cohort_count + counts summary)
    if (path === '/retail/campaigns/enriched' && request.method === 'GET') return getCampaignsEnriched(env);
    // Next Cron Queue — what tomorrow's 2pm MT cron will enroll per campaign
    if (path === '/retail/next-cron-queue' && request.method === 'GET') return getNextCronQueue(env);
    // Regenerate weekly insight on demand (background task via ctx.waitUntil, polls /retail/insight)
    if (path === '/retail/insight/regenerate' && request.method === 'POST') return regenerateWeeklyInsight(env, ctx);
    if (path === '/retail/campaigns/approve' && request.method === 'POST') return approveCampaign(request, env);
    if (path === '/retail/campaigns/reject' && request.method === 'POST') return rejectCampaign(request, env);
    if (path === '/retail/campaigns/regenerate' && request.method === 'POST') return regenerateCampaignPreviews(request, env);
    if (path === '/retail/campaigns/update-text' && request.method === 'POST') return updateCampaignText(request, env);
    if (path === '/retail/campaigns/toggle-discount' && request.method === 'POST') return toggleCampaignDiscount(request, env);
    if (path === '/retail/campaigns/refresh-discounts' && request.method === 'POST') return refreshDiscountCodes(request, env);
    if (path === '/retail/campaigns/continuous' && request.method === 'POST') return createContinuousCampaign(request, env);
    if (path === '/retail/campaigns/continuous' && request.method === 'GET') return getContinuousCampaigns(env);
    if (path === '/retail/campaigns/pause' && request.method === 'POST') return pauseCampaign(request, env);
    if (path === '/retail/campaigns/resume' && request.method === 'POST') return resumeCampaign(request, env);
    if (path === '/retail/campaigns/edit' && request.method === 'POST') return editCampaignWithAgent(request, env);
    if (path.startsWith('/retail/campaigns/') && path.endsWith('/detail') && request.method === 'GET') {
      const campaignId = path.split('/')[3]; // /retail/campaigns/{id}/detail
      return getCampaignDetail(campaignId, env);
    }
    // Activate a draft campaign — flips status='draft' → 'active'. Idempotent-safe.
    if (path.startsWith('/retail/campaigns/') && path.endsWith('/activate') && request.method === 'POST') {
      const campaignId = path.split('/')[3];
      return activateDraftCampaign(campaignId, env);
    }
    // Preview cohort — run the same eligibility SQL as processConditionCampaigns would, return COUNT + 5 samples.
    if (path.startsWith('/retail/campaigns/') && path.endsWith('/preview-cohort') && request.method === 'POST') {
      const campaignId = path.split('/')[3];
      return previewCampaignCohort(campaignId, env);
    }

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

    // ── Brain management ──────────────────────────────────────
    if (path === '/retail/brain/seed' && request.method === 'POST') return seedBusinessBrain(env);

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
    onboarding_enrolled: 0,  // legacy field — no longer populated; see removal note near line 1029
    controls_graduated: null,
    vip_milestones: 0,
    campaigns_proposed: 0,
    weekly_insight: false,
    monthly_analysis: false,
  };

  // Isolated step runner — each retail step runs inside its own try/catch so one
  // failure doesn't abort the rest. Errors are logged + surface in results.errors[].
  results.errors = [];
  const step = async (name, fn, setter) => {
    try {
      const r = await fn();
      if (setter) setter(r);
    } catch (e) {
      const msg = `[retail] step ${name} failed: ${e.message}`;
      console.error(msg, e.stack?.slice(0, 400));
      results.errors.push({ step: name, error: e.message });
    }
  };

  // Step 1: Ingest + update profiles (now from Square via square-sync-worker)
  await step('ingestAndUpdateProfiles', () => ingestAndUpdateProfiles(env), r => results.customers_updated = r);

  // Step 2: Churn risk scoring + CLV prediction
  await step('updateChurnScoresAndCLV', () => updateChurnScoresAndCLV(env), r => results.churn_scores_updated = r);

  // Step 2.5: Momentum scoring + behavior type classification
  await step('updateMomentumAndBehavior', () => updateMomentumAndBehavior(env), r => results.momentum_updated = r);

  // Step 2.6: Predictive churn — 7-day churn probability for at-risk customers
  await step('updateChurnPredictions', () => updateChurnPredictions(env), r => results.churn_predictions = r);

  // Step 2.7: Win-back intelligence — track re-churns after successful win-backs
  await step('trackWinbackRechurns', () => trackWinbackRechurns(env), r => results.rechurns_flagged = r);

  // Step 3: SKU analytics rollup
  await step('rollupDailySkuAnalytics', () => rollupDailySkuAnalytics(env));

  // Step 4: Continuous enrollment only.
  // - triggerOnboardingCampaigns REMOVED 2026-04-22 — zombie path that auto-resurrected
  //   "New Customer Onboarding" campaign (99 sends, 0 returns, 0 discounts). Duplicated
  //   "Free Pretzel Welcome" (event-triggered via processConditionCampaigns).
  // - triggerVIPMilestones removed 2026-04-18 — same pattern (auto-created zombie VIP Thank You).
  // New-customer onboarding is now owned by the Free Pretzel Welcome event-triggered drip.
  if (!cashAlert) {
    await step('processConditionCampaigns', () => processConditionCampaigns(env, brainContext), r => results.continuous_enrolled = r);
  }

  // Step 5: Process drip sequences (send next message in multi-step campaigns)
  if (!cashAlert) {
    await step('processDripSequences', () => processDripSequences(env, brainContext), r => results.drip_sends = r);
  }

  // Step 6: Campaign sends for immediate campaigns
  if (!cashAlert) {
    await step('processCampaignSends', () => processCampaignSends(env, brainContext), r => results.campaigns_processed = r);
  }

  // Step 7: Catering crossovers.
  // Legacy reengageLapsedCustomers removed 2026-04-18 — lapsed customers now route through
  // the condition-triggered continuous campaigns (Gold/Silver/Singles/Momentum) + Platinum
  // dossier. See removal comment above the former function's location for full rationale.
  await step('flagCateringCrossovers', () => flagCateringCrossovers(env), r => results.crossovers_flagged = r);

  // Step 8: Autonomous campaign proposals (agent identifies opportunities)
  if (!cashAlert) {
    await step('proposeCampaigns', () => proposeCampaigns(env), r => results.campaigns_proposed = r);
  }

  // Step 9: Goal progress check
  await step('updateGoalProgress', () => updateGoalProgress(env));

  // Step 10: Segment migration (update lapsed/churned)
  await step('updateSegments', () => updateSegments(env));

  // Step 10.5: Monitor continuous campaign health
  await step('monitorCampaignHealth', () => monitorCampaignHealth(env), r => results.health_checks = r);

  // Step 10.6: Auto-graduate expired A/B control tombstones. For each continuous campaign
  // with controls whose 14-day holdout has expired, picks the winning variant and sends
  // the held-out customers the treatment SMS (unless they already returned naturally).
  // Gated by cashAlert so CFO can freeze marketing sends during cash crunches.
  if (!cashAlert) {
    await step('autoGraduateControls', () => autoGraduateControls(env), r => results.controls_graduated = r);
  }

  // Step 11: Monday — weekly insight + campaign learnings + self-reflection + pattern discovery
  const today = new Date();
  if (today.getDay() === 1) {
    await step('updateCampaignLearnings', () => updateCampaignLearnings(env));
    await step('weeklyReflection', () => weeklyReflection(env), r => { if (r) results.self_reflection = r; });
    await step('generateWeeklyInsight', () => generateWeeklyInsight(env, brainContext), () => results.weekly_insight = true);
    await step('writeCFOReport', () => writeCFOReport(env));
  }

  // Step 12: 1st of month — monthly analysis
  if (today.getDate() === 1) {
    await step('generateMonthlyAnalysis', () => generateMonthlyAnalysis(env, brainContext), () => results.monthly_analysis = true);
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

// ── RUN INDIVIDUAL STEPS (to avoid CPU timeout) ─────────────────
async function runRetailStep(step, env) {
  const brainContext = await loadBrain(env, 'retail');
  switch (step) {
    case 'profiles': return { customers_updated: await ingestAndUpdateProfiles(env) };
    case 'churn': return { churn_scores: await updateChurnScoresAndCLV(env) };
    case 'momentum': return { momentum: await updateMomentumAndBehavior(env) };
    case 'predictions': return { predictions: await updateChurnPredictions(env) };
    case 'segments': { await updateSegments(env); return { segments: 'updated' }; }
    case 'campaigns': return { proposed: await proposeCampaigns(env) };
    case 'sends': return { sends: await processCampaignSends(env, brainContext) };
    case 'drips': return { drips: await processDripSequences(env, brainContext) };
    case 'reengage': {
      // Removed 2026-04-18 — function deleted. Lapsed customers route through
      // /retail/run?step=continuous (Gold/Silver/Momentum/Singles) or the Platinum
      // dossier flow at /retail/campaigns/platinum_winback_2026/dossier.
      return { error: 'reengage step removed — use /retail/run?step=continuous or the Platinum dossier.' };
    }
    case 'insight': {
      const insight = await generateWeeklyInsight(env, brainContext);
      return { insight: insight ? 'generated' : 'failed' };
    }
    case 'goals': { await updateGoalProgress(env); return { goals: 'updated' }; }
    case 'learnings': { const l = await updateCampaignLearnings(env); return { learnings: l }; }
    case 'reflection': { const r = await weeklyReflection(env); return { reflection: r }; }
    case 'continuous': { const c = await processConditionCampaigns(env, brainContext); return { continuous_enrolled: c }; }
    case 'health': { const h = await monitorCampaignHealth(env); return { health_checks: h }; }
    default: return { error: 'Unknown step. Options: profiles, churn, momentum, predictions, segments, campaigns, sends, drips, reengage, insight, goals, learnings, reflection, continuous, health' };
  }
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

  // Get active BATCH campaigns (continuous campaigns handled separately)
  const campaigns = await env.DB.prepare(`
    SELECT * FROM retail_campaigns
    WHERE status = 'active'
      AND (completed_at IS NULL)
      AND (campaign_mode IS NULL OR campaign_mode = 'batch')
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

    // Pre-fetch discount for this campaign (avoid N+1 queries)
    let campaignDiscount = null;
    try {
      campaignDiscount = await env.DB.prepare(
        'SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = ? LIMIT 1'
      ).bind(campaign.id, 'active').first();
    } catch {}

    for (const customer of customers) {
      // SUPPRESSION CHECK — non-negotiable
      const suppressed = await env.DB.prepare(
        'SELECT phone FROM sms_suppressions WHERE phone = ?'
      ).bind(customer.normalized_phone).first();
      if (suppressed) continue;

      try {
        // Generate personalized SMS (pass pre-fetched discount)
        let sms = await generateCampaignSMS(customer, campaign, env, brainContext, campaignDiscount);

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

        // Pre-flight validation — check before sending
        let validationLog = null;
        const validation = await validateSMS(sms, customer, campaign, env);
        if (!validation.pass) {
          const originalSms = sms;
          // Try the reviewer's suggestion first
          if (validation.suggestion) {
            sms = validation.suggestion;
            const recheck = await validateSMS(sms, customer, campaign, env);
            if (!recheck.pass) {
              sms = getFallbackSMS(customer);
              validationLog = JSON.stringify({ original: originalSms, suggestion_tried: validation.suggestion, issues: validation.issues, final: sms, fallback_used: true });
            } else {
              validationLog = JSON.stringify({ original: originalSms, issues: validation.issues, revised_to: sms, fallback_used: false });
            }
          } else {
            sms = getFallbackSMS(customer);
            validationLog = JSON.stringify({ original: originalSms, issues: validation.issues, final: sms, fallback_used: true });
          }
          console.log(`[Retail] SMS validation failed for ${customer.first_name}: ${validation.issues.join(', ')}`);
        }

        // Send via Swell CX
        const swellResult = await sendSwellSMS(customer.phone, sms, env);
        if (!swellResult.success) continue;

        // Record send (with validation log if applicable)
        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (
            id, campaign_id, customer_id, variant_id,
            message_text, sent_at, outcome, created_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'))
        `).bind(
          crypto.randomUUID(), campaign.id, customer.id,
          variantId, sms,
        ).run();

        // Record to frequency cap (cross-campaign rate limiting)
        await env.DB.prepare(`
          INSERT INTO retail_frequency_cap (customer_id, sent_at, campaign_id, campaign_type)
          VALUES (?, datetime('now'), ?, ?)
        `).bind(customer.id, campaign.id, campaign.campaign_type || 'batch').run();

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

async function generateCampaignSMS(customer, campaign, env, brainContext = '', prefetchedDiscount = undefined) {
  const skuNames = {
    'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK (Brush Before Kissing)', 'SAINT': 'The Saint',
    'SALTY': 'The Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
  };
  const favoriteName = customer.favorite_sku
    ? (skuNames[customer.favorite_sku] || customer.favorite_sku)
    : null;

  const daysSince = customer.last_visit_date
    ? Math.floor((Date.now() - new Date(customer.last_visit_date)) / 86400000)
    : null;

  // Load Drew's feedback/learnings for this campaign type
  let drewFeedback = '';
  try {
    const feedback = await env.KV.get(`campaign_feedback_${campaign.campaign_type}`);
    if (feedback) drewFeedback = `\nDrew's feedback on ${campaign.campaign_type} messages:\n${feedback}`;
  } catch {}

  // Load campaign learnings
  let learningsContext = '';
  try {
    const learnings = await env.KV.get('retail_campaign_learnings');
    if (learnings) {
      const l = JSON.parse(learnings);
      if (l.best_performing_messages?.length) {
        learningsContext = `\nPast successful messages (highest return rate):\n${l.best_performing_messages.slice(0, 3).map(m => `- "${m.text}"`).join('\n')}`;
      }
    }
  } catch {}

  // Check for linked discount code (use pre-fetched if available)
  let discountLine = '';
  try {
    const discount = prefetchedDiscount !== undefined ? prefetchedDiscount : await env.DB.prepare(
      'SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = ? LIMIT 1'
    ).bind(campaign.id, 'active').first();
    if (discount) {
      const desc = discount.discount_type === 'FIXED_AMOUNT'
        ? `$${(discount.amount / 100).toFixed(0)} off`
        : `${discount.amount}% off`;
      discountLine = `Mention "${discount.code}" at checkout for ${desc}.`;
    }
  } catch {}

  // Build customer context — only include REAL data
  const custName = customer.first_name && customer.first_name !== 'unknown' ? customer.first_name : null;
  const custLines = [];
  if (custName) custLines.push(`Name: ${custName}`);
  if (customer.visit_count > 0) custLines.push(`Visits: ${customer.visit_count}`);
  if (daysSince && daysSince > 0 && daysSince < 365) custLines.push(`Last visit: ${daysSince} days ago`);
  if (favoriteName) custLines.push(`Favorite item: ${favoriteName}`);

  const prompt = `Write ONE SMS message (max 130 characters) for Dangerous Pretzel Co.

ABOUT THE BUSINESS (use ONLY these facts):
- Name: Dangerous Pretzel Co (NEVER call it "Ruin Dinner" — that's just a tagline)
- What we sell: Gourmet soft pretzels. Menu items: Spicy Bee, BBK (Brush Before Kissing), The Saint, The Salty, For The Kids, Salty Bombs
- Location: 352 W 600 S, Salt Lake City
- Order online: dangerouspretzel.com
- Tone: Friendly, casual, a little bold. Like texting a friend.

CAMPAIGN: ${campaign.campaign_type}
${campaign.message_template ? `Guidance: ${campaign.message_template}` : ''}

CUSTOMER:
${custLines.length ? custLines.join('\n') : 'No specific customer data available'}

${discountLine ? `DISCOUNT OFFER: ${discountLine}` : ''}
${drewFeedback}${learningsContext}

HARD RULES — violating ANY of these means the message gets rejected:
1. MAX 130 characters (the system adds "Reply STOP to opt out" after your message)
2. NEVER invent offers, promotions, events, upgrades, or specials that aren't listed above
3. NEVER make up menu items — ONLY reference: Spicy Bee, BBK, The Saint, The Salty, For The Kids, Salty Bombs
4. NEVER promise free items, upgrades, or rewards unless a specific discount code is provided above
5. NEVER reference events, festivals, games, or seasons unless specifically told to
6. If you don't know the customer's name, don't use a name — just start the message naturally
7. If you don't know their favorite item, mention the brand or a real menu item
8. Keep it simple. One clear thought. No filler.

Return ONLY valid JSON: {"sms": "your message here"}`;

  // Use Claude (not Workers AI — Llama hallucinates too much for customer-facing copy)
  // DIF-3 (May 13 2026): wired through ai-budget
  let text = null;
  try {
    const result = await callAI(env, {
      use_case: 'retail_winback_sms',
      model: 'haiku',
      caller: 'retail-agent.js',
      max_tokens: 200,
      system: brainContext || 'You write SMS messages for a pretzel restaurant. Return valid JSON only. Never invent facts.',
      messages: [{ role: 'user', content: prompt }],
    });
    if (!result.ok) throw new Error(`Claude error ${result.error || result.blocked_reason || 'unknown'}`);
    text = result.content || '';
  } catch (err) {
    console.error(`[Retail] SMS generation error: ${err.message}`);
  }

  // Fallback to Workers AI only if Claude fails
  if (!text && env.AI) {
    try {
      const aiResp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'Return valid JSON only. Never invent facts.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
      });
      text = aiResp?.response || null;
    } catch { text = null; }
  }

  // Parse and validate
  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);
    let sms = parsed.sms || '';

    // Validate: reject hallucinated content
    const hallucinations = ['free upgrade', 'free drink', 'buy one get one', 'bogo', 'happy hour',
      'grand opening', 'new location', 'new menu', 'new flavor', 'limited time', 'exclusive offer',
      'loyalty reward', 'vip access', 'secret menu', 'secret sauce', 'loaded pretzel'];
    const lower = sms.toLowerCase();
    for (const h of hallucinations) {
      if (lower.includes(h) && !campaign.message_template?.toLowerCase().includes(h)) {
        console.warn(`[Retail] Rejected hallucinated SMS containing "${h}": ${sms}`);
        sms = ''; // force fallback
        break;
      }
    }

    if (!sms) {
      // Fallback: simple, honest, no-BS message
      if (custName && favoriteName) {
        sms = `${custName}, your ${favoriteName} is waiting. dangerouspretzel.com`;
      } else if (favoriteName) {
        sms = `Your ${favoriteName} is waiting at Dangerous Pretzel. dangerouspretzel.com`;
      } else {
        sms = `We miss you at Dangerous Pretzel Co. dangerouspretzel.com`;
      }
      if (discountLine) sms = sms.replace('dangerouspretzel.com', discountLine.split('.')[0] + '. dangerouspretzel.com');
    }

    // Remove any markdown formatting the AI might add
    sms = sms.replace(/\*\*/g, '').replace(/\*/g, '');

    // Ensure it ends with STOP opt-out
    if (!sms.includes('STOP')) {
      // Trim to make room for opt-out suffix
      const maxLen = 160 - ' Reply STOP to opt out'.length;
      if (sms.length > maxLen) sms = sms.slice(0, maxLen - 1).replace(/\s+\S*$/, '');
      sms = sms + ' Reply STOP to opt out';
    }

    return sms.slice(0, 160);
  } catch {
    // Ultra-safe fallback
    const name = custName ? `${custName}, w` : 'W';
    return `${name}e miss you at Dangerous Pretzel Co. dangerouspretzel.com Reply STOP to opt out`.slice(0, 160);
  }
}

// Check if campaign type should be auto-approved going forward
async function checkCampaignRules(campaign, env) {
  const rule = await env.DB.prepare(
    'SELECT * FROM retail_campaign_rules WHERE campaign_type = ?'
  ).bind(campaign.campaign_type).first();

  if (!rule) {
    // New campaign type without a rules entry — insert default (requires 3 runs to auto-approve)
    await env.DB.prepare(`
      INSERT OR IGNORE INTO retail_campaign_rules (campaign_type, min_runs_required, min_return_rate, max_opt_out_rate, auto_approve, runs_completed)
      VALUES (?, 3, 0.05, 0.05, 0, 0)
    `).bind(campaign.campaign_type).run();
    return;
  }
  if (rule.auto_approve) return;

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
// REMOVED 2026-04-22 — triggerOnboardingCampaigns auto-created & resurrected a zombie
// "New Customer Onboarding" campaign (99 sends Apr 18-20, 0 returns, 0 discounts
// redeemed). It duplicated Free Pretzel Welcome (event-triggered with real $8-off code
// via DPE4YMX) — both targeted new-customer visit_count=1 cohort. Same auto-INSERT-from-code
// pattern that VIP Thank You had.
//
// New-customer onboarding is now owned by the Free Pretzel Welcome campaign
// (campaign_id='9143a900-ba1c-48b5-9a15-06db2e7bd095') — event-triggered on order.completed
// with visit_count=1 + sms_consent=1, renders a real discount, runs through processConditionCampaigns.
// If you need to change new-customer messaging, edit that campaign row (migration 024).

// ── VIP MILESTONE TRIGGER ────────────────────────────────────────
// REMOVED 2026-04-18 — triggerVIPMilestones auto-created "VIP Thank You" campaign rows
// outside the 5-tier consolidated model (migration 025). Collided with Gold Win-Back sends
// (same customer got two SMS 60 seconds apart). VIPs should route through Platinum dossier
// (visit_count >= 10 + 30d+ lapsed) or Gold Win-Back (4-9 visits + 30d+ lapsed) instead.
//
// If you need to reintroduce VIP recognition, do it as a proper continuous campaign via
// migration 025's consolidated schema — NOT by auto-INSERTing campaign rows from code.

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
    let messageVariants = {};
    try { messageVariants = campaign.message_variants ? JSON.parse(campaign.message_variants) : {}; } catch {}

    // Drip processing starts at step 1 (step 0 is created by the initial enrollment —
    // either processCampaignTrigger for event-type, or the onboarding/condition path).
    // For step 1+, we:
    //   (a) find customers whose step_0 send is ≥ step[N].day days old, haven't got step N yet
    //   (b) early-exit if they've redeemed (visit_count increased since enrollment)
    //   (c) pull expires_at + discount_code from their step_0 row and reuse them
    //   (d) render step N's variant from campaign.message_variants
    for (let stepIdx = 1; stepIdx < schedule.length; stepIdx++) {
      const step = schedule[stepIdx];
      const daysAfterEnroll = step.day || 0;

      const dueRows = await env.DB.prepare(`
        SELECT cs.customer_id, cs.expires_at, cs.discount_code, cs.loyalty_reward_id, cs.loyalty_account_id, cs.created_at as enrolled_at,
               rc.phone, rc.normalized_phone, rc.first_name, rc.favorite_sku,
               rc.visit_count, rc.avg_order_value, rc.sku_diversity_score
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

      const customers = dueRows.results || [];

      for (const customer of customers) {
        // Suppression check
        const suppressed = await env.DB.prepare(
          'SELECT phone FROM sms_suppressions WHERE phone = ?'
        ).bind(customer.normalized_phone).first();
        if (suppressed) continue;

        // Early-exit: did they redeem / return since enrollment? Check visit_count delta +
        // discount redemption. If yes, stop the drip — they're back, we don't need to nag.
        const enrollment = await env.DB.prepare(
          `SELECT visit_count_at_enroll FROM (
             SELECT rc.visit_count as visit_count_at_enroll FROM retail_customers rc WHERE rc.id = ?
           )`
        ).bind(customer.customer_id).first();
        // NOTE: we don't store visit_count at enrollment explicitly — infer from returned_at
        // and times_redeemed. If customer.visit_count > what we'd expect for a drip cohort,
        // assume they redeemed.
        const stepZeroSend = await env.DB.prepare(
          `SELECT returned_at, return_order_value FROM retail_campaign_sends
           WHERE campaign_id = ? AND customer_id = ? AND variant_id = 'drip_step_0'`
        ).bind(campaign.id, customer.customer_id).first();
        if (stepZeroSend?.returned_at) {
          // Already redeemed — mark enrollment outcome + skip remaining drip
          await env.DB.prepare(
            `UPDATE retail_campaign_sends SET outcome = 'redeemed' WHERE campaign_id = ? AND customer_id = ? AND variant_id = 'drip_step_0'`
          ).bind(campaign.id, customer.customer_id).run().catch(() => {});
          continue;
        }

        // Build per-customer campaign context with the enrollment's expires_at + code
        const campaignCtx = {
          ...campaign,
          _discount_code: customer.discount_code || campaign._discount_code || '',
          _expires_at: customer.expires_at,
        };

        // Resolve step template: message_variants[step.variant] → fallback to generateDripSMS
        let sms;
        const variantKey = step.variant;
        if (variantKey && messageVariants[variantKey]) {
          sms = renderTemplate(messageVariants[variantKey], customer, campaignCtx);
        } else {
          sms = await generateDripSMS(customer, campaign, step, stepIdx, env, brainContext);
        }

        // Validate drip SMS (same pipeline as campaign sends)
        const dripValidation = await validateSMS(sms, customer, campaign, env, brainContext);
        if (!dripValidation.pass) {
          if (dripValidation.suggestion) {
            sms = dripValidation.suggestion;
            const recheck = await validateSMS(sms, customer, campaign, env, brainContext);
            if (!recheck.pass) sms = getFallbackSMS(customer);
          } else {
            sms = getFallbackSMS(customer);
          }
        }

        const swellResult = await sendSwellSMS(customer.phone, sms, env);
        if (!swellResult.success) continue;

        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (
            id, campaign_id, customer_id, variant_id,
            message_text, sent_at, outcome, created_at,
            discount_code, expires_at, loyalty_reward_id, loyalty_account_id
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'), ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(), campaign.id, customer.customer_id,
          `drip_step_${stepIdx}`, sms,
          customer.discount_code || null,
          customer.expires_at || null,
          customer.loyalty_reward_id || null,
          customer.loyalty_account_id || null,
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

  // Part 6: win-back sweep — mark enrollments that completed all drip steps WITHOUT
  // redemption + are past expires_at so a future campaign can target them.
  try { await sweepWinbackFlags(env); } catch (e) { console.error('[retail] winback sweep failed:', e.message); }

  if (totalSent > 0) {
    console.log(`[Retail] Drip sequences: ${totalSent} messages sent`);
  }
  return totalSent;
}

// Part 6: Flag enrollments that completed the drip + never redeemed + are past expiry.
// Sets retail_customers.welcomed_not_redeemed = 1 so a future win-back campaign can target them.
async function sweepWinbackFlags(env) {
  // Find drip campaigns' step-0 enrollments where: (a) all drip steps have been sent,
  // (b) now > expires_at, (c) not yet flagged, (d) no returned_at on any send.
  const expired = await env.DB.prepare(`
    SELECT s.customer_id, s.campaign_id, s.expires_at
    FROM retail_campaign_sends s
    JOIN retail_customers rc ON rc.id = s.customer_id
    WHERE s.variant_id = 'drip_step_0'
      AND s.expires_at IS NOT NULL
      AND datetime('now') > s.expires_at
      AND rc.welcomed_not_redeemed = 0
      AND NOT EXISTS (
        SELECT 1 FROM retail_campaign_sends s2
        WHERE s2.campaign_id = s.campaign_id
          AND s2.customer_id = s.customer_id
          AND s2.returned_at IS NOT NULL
      )
    LIMIT 200
  `).all().catch(e => { console.error('[retail] winback query failed:', e.message); return { results: [] }; });

  let flagged = 0;
  for (const row of (expired.results || [])) {
    await env.DB.prepare(
      `UPDATE retail_customers SET welcomed_not_redeemed = 1, updated_at = datetime('now') WHERE id = ? AND welcomed_not_redeemed = 0`
    ).bind(row.customer_id).run();
    await env.DB.prepare(
      `UPDATE retail_campaign_sends SET outcome = 'expired' WHERE campaign_id = ? AND customer_id = ? AND outcome != 'redeemed'`
    ).bind(row.campaign_id, row.customer_id).run();
    flagged++;
  }
  if (flagged > 0) console.log(`[Retail] Win-back: flagged ${flagged} unredeemed welcome enrollments`);
  return flagged;
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

  // For winback drips, use Claude Haiku for personalization (Llama 3.1 8b removed —
  // hallucinated "new beer taps" / "new flavors" into reengagement copy in prior runs).
  if (campaign.campaign_type === 'winback') {
    const daysSince = customer.last_visit_date
      ? Math.floor((Date.now() - new Date(customer.last_visit_date)) / 86400000)
      : 14;

    const stepDescriptions = ['gentle reminder', 'urgency — it has been a while', 'final — door is always open'];
    const prompt = `Write a ${stepDescriptions[stepIdx] || 'follow-up'} SMS for a Dangerous Pretzel Co win-back campaign.

ABOUT THE BUSINESS (use ONLY these facts):
- Name: Dangerous Pretzel Co (NEVER call it "Ruin Dinner" — that's just a tagline)
- Menu items (complete list — nothing else exists): Spicy Bee, BBK (Brush Before Kissing), The Saint, The Salty, For The Kids, Salty Bombs
- Location: 352 W 600 S, Salt Lake City
- Order online: dangerouspretzel.com

CUSTOMER: ${customer.first_name || 'unknown name'}, ${daysSince} days since last visit, favorite: ${fav || 'unknown'}.
STEP: ${stepIdx + 1} of 3 (${stepDescriptions[stepIdx] || 'follow-up'}).

HARD RULES — violating ANY of these means the message gets rejected:
1. MAX 160 characters including "Reply STOP to opt out" at the end
2. MUST include "Dangerous Pretzel" somewhere in the message (brand identification)
3. NEVER invent new flavors, new beer taps, new menu items, events, or features
4. NEVER reference anything not in the menu list above
5. NEVER promise free items, upgrades, or rewards — there is NO discount code attached
6. End with: Reply STOP to opt out

Return ONLY valid JSON: {"sms": "..."}`;

    // DIF-3 (May 13 2026): wired through ai-budget
    let text = null;
    try {
      const result = await callAI(env, {
        use_case: 'retail_drip_sms',
        model: 'haiku',
        caller: 'retail-agent.js',
        max_tokens: 200,
        system: brainContext || 'You write SMS messages for a pretzel restaurant. Return valid JSON only. Never invent facts.',
        messages: [{ role: 'user', content: prompt }],
      });
      if (result.ok) {
        text = result.content || '';
      }
    } catch (err) {
      console.error('[generateDripSMS] Haiku error:', err.message);
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

// ── STRATEGIC CAMPAIGN ENGINE ────────────────────────────────────
// 3-phase pipeline: Identify opportunities → Score by impact → Propose best campaigns
// Replaces the old 5-template checklist with data-driven strategic decision-making

async function proposeCampaigns(env) {
  // Phase 1: Load performance data for scoring
  const pastPerformance = await env.DB.prepare(`
    SELECT campaign_type,
           COUNT(*) as campaigns_run,
           AVG(CASE WHEN total_sent > 0 THEN CAST(total_returned AS REAL) / total_sent ELSE 0 END) as avg_return_rate,
           SUM(total_revenue_attributed) as total_revenue,
           AVG(roi_estimate) as avg_roi
    FROM retail_campaigns WHERE status = 'completed'
    GROUP BY campaign_type
  `).all();
  const perf = {};
  (pastPerformance.results || []).forEach(p => { perf[p.campaign_type] = p; });

  // Phase 2: Identify all opportunities
  const opportunities = await identifyOpportunities(env);
  console.log(`[Retail] Identified ${opportunities.length} opportunities`);

  if (opportunities.length === 0) {
    console.log('[Retail] No campaign opportunities found');
    return 0;
  }

  // Phase 3: Score and rank
  const scored = scorePipeline(opportunities, perf);
  console.log(`[Retail] Scored pipeline: ${scored.map(o => `${o.type}=${o.impact_score}`).join(', ')}`);

  // Phase 4: Propose the best campaigns
  const proposed = await proposeBestCampaigns(scored, perf, env);
  return proposed;
}

// ── Phase A: Scan data for every potential play ──────────────────
async function identifyOpportunities(env) {
  const opportunities = [];

  // Shared: recent send exclusion (don't re-target people messaged in last 14 days)
  const RECENT_SEND_EXCLUSION = `AND id NOT IN (SELECT customer_id FROM retail_campaign_sends WHERE sent_at >= date('now', '-14 days'))`;

  // 1. URGENT SAVE: High-value customers about to churn THIS WEEK
  try {
    const urgentChurn = await env.DB.prepare(`
      SELECT id, first_name, predicted_clv, churn_probability_7d,
             visit_count, favorite_sku, segment, behavior_type,
             CAST(julianday('now') - julianday(last_visit_date) AS INTEGER) as days_since,
             total_lifetime_value, avg_order_value
      FROM retail_customers
      WHERE churn_probability_7d > 0.7
        AND predicted_clv > 50
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        AND visit_count > 0
        AND segment NOT IN ('churned')
        ${RECENT_SEND_EXCLUSION}
      ORDER BY predicted_clv DESC
      LIMIT 25
    `).all();

    if ((urgentChurn.results?.length || 0) >= 2) {
      opportunities.push({
        type: 'urgent_save',
        objective: `Prevent ${urgentChurn.results.length} high-value customer churns this week`,
        targets: urgentChurn.results,
        estimated_revenue_at_risk: urgentChurn.results.reduce((s, c) => s + (c.predicted_clv || 0), 0),
        urgency: 'high',
        recommended_discount: true,
        discount_amount: 500,
        send_strategy: 'immediate',
        target_segment: 'all',
        target_criteria: { churn_probability_min: 0.7, min_predicted_clv: 50 },
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (urgent_save):', e.message); }

  // 2. FIRST-TIMER CONVERSION: Day 3-7 window (highest ROI)
  try {
    const conversionWindow = await env.DB.prepare(`
      SELECT id, first_name, favorite_sku, avg_order_value, behavior_type,
             CAST(julianday('now') - julianday(first_visit_date) AS INTEGER) as days_since_first
      FROM retail_customers
      WHERE visit_count = 1
        AND first_visit_date BETWEEN date('now', '-7 days') AND date('now', '-3 days')
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        ${RECENT_SEND_EXCLUSION}
      ORDER BY avg_order_value DESC
    `).all();

    if ((conversionWindow.results?.length || 0) >= 1) {
      opportunities.push({
        type: 'day3_followup',
        objective: `Convert ${conversionWindow.results.length} first-timers to second visit (day 3-7 window)`,
        targets: conversionWindow.results,
        estimated_revenue: conversionWindow.results.reduce((s, c) => s + (c.avg_order_value || 15), 0),
        urgency: 'medium',
        recommended_discount: false,
        send_strategy: 'immediate',
        target_segment: 'new',
        target_criteria: { visit_count: 1, days_since_first: '3-7' },
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (day3):', e.message); }

  // 3. MAGIC NUMBER PUSH: 1 visit from retention lock-in
  try {
    const magicNum = await calculateMagicNumber(env);
    const magicTargets = await env.DB.prepare(`
      SELECT id, first_name, favorite_sku, avg_order_value, momentum_score,
             predicted_clv, behavior_type, visit_count,
             CAST(julianday('now') - julianday(last_visit_date) AS INTEGER) as days_since
      FROM retail_customers
      WHERE visit_count = ?
        AND segment NOT IN ('churned', 'lapsed')
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        ${RECENT_SEND_EXCLUSION}
      ORDER BY predicted_clv DESC
      LIMIT 40
    `).bind(magicNum.number - 1).all();

    if ((magicTargets.results?.length || 0) >= 3) {
      opportunities.push({
        type: 'magic_number_push',
        objective: `Push ${magicTargets.results.length} visit-${magicNum.number - 1} customers to visit ${magicNum.number} (churn drops ${magicNum.drop_pct}% at this point)`,
        targets: magicTargets.results,
        estimated_revenue: magicTargets.results.reduce((s, c) => s + (c.avg_order_value || 15), 0),
        urgency: 'medium',
        recommended_discount: true,
        discount_amount: 300,
        send_strategy: 'immediate',
        target_segment: 'all',
        target_criteria: { visit_count: magicNum.number - 1, magic_number: magicNum.number },
        magic_number_data: magicNum,
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (magic_number):', e.message); }

  // 4. WIN-BACK: Lapsed VIPs (sorted by LTV, capped)
  try {
    const lapsedVIPs = await env.DB.prepare(`
      SELECT id, first_name, total_lifetime_value, visit_count, favorite_sku,
             predicted_clv, behavior_type, segment,
             CAST(julianday('now') - julianday(last_visit_date) AS INTEGER) as days_lapsed,
             avg_order_value
      FROM retail_customers
      WHERE segment = 'lapsed'
        AND visit_count >= 4
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        AND id NOT IN (SELECT customer_id FROM retail_campaign_sends
                       WHERE campaign_id IN (SELECT id FROM retail_campaigns WHERE campaign_type = 'winback' AND status IN ('active','pending_approval')))
      ORDER BY total_lifetime_value DESC
      LIMIT 30
    `).all();

    if ((lapsedVIPs.results?.length || 0) >= 3) {
      const totalLTV = lapsedVIPs.results.reduce((s, c) => s + (c.total_lifetime_value || 0), 0);
      opportunities.push({
        type: 'winback',
        objective: `Recover ${lapsedVIPs.results.length} lapsed VIPs ($${Math.round(totalLTV)} lifetime value at risk)`,
        targets: lapsedVIPs.results,
        estimated_revenue_at_risk: lapsedVIPs.results.reduce((s, c) => s + (c.predicted_clv || 0), 0),
        urgency: 'medium',
        recommended_discount: true,
        discount_amount: 500,
        send_strategy: 'drip',
        target_segment: 'lapsed',
        target_criteria: { min_visit_count: 4 },
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (winback):', e.message); }

  // 5. GROUP REACTIVATION: Group buyers who haven't been in
  try {
    const groupBuyers = await env.DB.prepare(`
      SELECT id, first_name, avg_order_value, visit_count, largest_single_order,
             behavior_type, favorite_sku, predicted_clv,
             CAST(julianday('now') - julianday(last_visit_date) AS INTEGER) as days_since
      FROM retail_customers
      WHERE is_group_buyer = 1
        AND visit_count >= 2
        AND last_visit_date < date('now', '-10 days')
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        ${RECENT_SEND_EXCLUSION}
      ORDER BY largest_single_order DESC
      LIMIT 20
    `).all();

    if ((groupBuyers.results?.length || 0) >= 3) {
      const avgTicket = groupBuyers.results.reduce((s, c) => s + (c.avg_order_value || 0), 0) / groupBuyers.results.length;
      opportunities.push({
        type: 'group_reactivation',
        objective: `Reactivate ${groupBuyers.results.length} group buyers (avg $${Math.round(avgTicket)}/visit — they bring friends)`,
        targets: groupBuyers.results,
        estimated_revenue: groupBuyers.results.reduce((s, c) => s + (c.avg_order_value || 20), 0),
        urgency: 'low',
        recommended_discount: false,
        send_strategy: 'immediate',
        target_segment: 'all',
        target_criteria: { is_group_buyer: 1, min_visit_count: 2 },
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (group):', e.message); }

  // 6. CADENCE NUDGE: Pre-churn intervention (momentum decelerating)
  try {
    const decelerating = await env.DB.prepare(`
      SELECT id, first_name, momentum_score, visit_count, order_frequency_days,
             favorite_sku, predicted_clv, behavior_type, avg_order_value,
             CAST(julianday('now') - julianday(last_visit_date) AS INTEGER) as days_since
      FROM retail_customers
      WHERE visit_count >= 3
        AND segment NOT IN ('churned', 'lapsed')
        AND momentum_score < -30
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        AND last_visit_date < date('now', '-7 days')
        ${RECENT_SEND_EXCLUSION}
      ORDER BY predicted_clv DESC
      LIMIT 20
    `).all();

    if ((decelerating.results?.length || 0) >= 2) {
      opportunities.push({
        type: 'cadence_nudge',
        objective: `Intervene before ${decelerating.results.length} regulars fully lapse (cheaper than win-back)`,
        targets: decelerating.results,
        estimated_revenue: decelerating.results.reduce((s, c) => s + (c.avg_order_value || 15), 0),
        urgency: 'medium',
        recommended_discount: false,
        send_strategy: 'immediate',
        target_segment: 'regular',
        target_criteria: { min_visits: 3, momentum_below: -30 },
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (cadence):', e.message); }

  // 7. CROSS-SELL: Loyalists stuck on one item
  try {
    const stuckLoyalists = await env.DB.prepare(`
      SELECT id, first_name, favorite_sku, visit_count, sku_diversity_score,
             avg_order_value, predicted_clv, behavior_type,
             CAST(julianday('now') - julianday(last_visit_date) AS INTEGER) as days_since
      FROM retail_customers
      WHERE sku_diversity_score <= 1
        AND visit_count >= 4
        AND segment NOT IN ('churned', 'lapsed')
        AND sms_eligible = 1
        AND first_name IS NOT NULL AND first_name != ''
        AND id NOT IN (SELECT customer_id FROM retail_campaign_sends
                       WHERE campaign_id IN (SELECT id FROM retail_campaigns WHERE campaign_type = 'upsell' AND status IN ('active','pending_approval')))
      ORDER BY visit_count DESC
      LIMIT 20
    `).all();

    if ((stuckLoyalists.results?.length || 0) >= 3) {
      opportunities.push({
        type: 'upsell',
        objective: `Expand menu exploration for ${stuckLoyalists.results.length} loyalists stuck on one item`,
        targets: stuckLoyalists.results,
        estimated_revenue: stuckLoyalists.results.reduce((s, c) => s + (c.avg_order_value || 15), 0),
        urgency: 'low',
        recommended_discount: false,
        send_strategy: 'immediate',
        target_segment: 'regular',
        target_criteria: { min_visit_count: 4, max_sku_diversity: 1 },
      });
    }
  } catch (e) { console.error('[Retail] Opportunity scan error (upsell):', e.message); }

  return opportunities;
}

// ── Calculate magic number dynamically ───────────────────────────
async function calculateMagicNumber(env) {
  const magicData = await env.DB.prepare(`
    SELECT visit_count, COUNT(*) as total,
           SUM(CASE WHEN segment IN ('churned', 'lapsed') THEN 1 ELSE 0 END) as churned
    FROM retail_customers WHERE visit_count BETWEEN 1 AND 6
    GROUP BY visit_count ORDER BY visit_count
  `).all();
  const rates = (magicData.results || []).map(r => ({
    v: r.visit_count, churn: r.total > 0 ? r.churned / r.total : 0
  }));
  let magicNum = 3, bigDrop = 0;
  for (let i = 1; i < rates.length; i++) {
    const drop = rates[i - 1].churn - rates[i].churn;
    if (drop > bigDrop) { bigDrop = drop; magicNum = rates[i].v; }
  }
  return { number: magicNum, drop_pct: Math.round(bigDrop * 100) };
}

// ── Phase B: Score and rank opportunities by expected impact ─────
function scorePipeline(opportunities, perf) {
  return opportunities.map(opp => {
    let score = 0;
    const targetCount = opp.targets.length;

    // 1. Revenue potential (0-40 points)
    const revPotential = opp.estimated_revenue || opp.estimated_revenue_at_risk || 0;
    score += Math.min(revPotential / 50, 40);

    // 2. Urgency multiplier
    if (opp.urgency === 'high') score *= 1.5;
    else if (opp.urgency === 'medium') score *= 1.0;
    else score *= 0.7;

    // 3. Historical effectiveness (0-30 points)
    const pastData = perf[opp.type];
    if (pastData && pastData.campaigns_run >= 3) {
      score += pastData.avg_return_rate * 100;
      // Performance gate: kill proven-ineffective types
      if (pastData.campaigns_run >= 5 && pastData.avg_return_rate < 0.05) {
        console.log(`[Retail] Performance gate: killing ${opp.type} (${pastData.campaigns_run} runs, ${Math.round(pastData.avg_return_rate * 100)}% return)`);
        score = 0;
      }
    } else {
      score += 15; // Unknown = moderate optimism (worth testing)
    }

    // 4. Target quality — average predicted CLV (0-20 points)
    const avgCLV = opp.targets.reduce((s, t) => s + (t.predicted_clv || 0), 0) / (targetCount || 1);
    score += Math.min(avgCLV / 10, 20);

    // 5. Efficiency: revenue per SMS (0-10 points)
    const revenuePerSMS = targetCount > 0 ? revPotential / targetCount : 0;
    score += Math.min(revenuePerSMS, 10);

    return {
      ...opp,
      impact_score: Math.round(score),
      revenue_per_sms: revenuePerSMS.toFixed(2),
      avg_target_clv: avgCLV.toFixed(0),
    };
  })
  .filter(o => o.impact_score > 0)
  .sort((a, b) => b.impact_score - a.impact_score);
}

// ── Phase C: Create the best campaigns (max 3 concurrent) ───────
async function proposeBestCampaigns(scored, perf, env) {
  let proposed = 0;
  const MAX_CONCURRENT = 3;

  const activeCampaigns = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM retail_campaigns WHERE status IN ('active', 'pending_approval')`
  ).first();

  const slotsAvailable = MAX_CONCURRENT - (activeCampaigns?.count || 0);
  if (slotsAvailable <= 0) {
    console.log(`[Retail] ${activeCampaigns.count} campaigns already active/pending — no slots available`);
    return 0;
  }

  const topOpps = scored.slice(0, slotsAvailable);

  for (const opp of topOpps) {
    try {
      // Smart sizing: cap at 40, sorted by CLV (already sorted)
      const campaignSize = Math.min(opp.targets.length, 40);

      const rule = await env.DB.prepare(
        'SELECT auto_approve FROM retail_campaign_rules WHERE campaign_type = ?'
      ).bind(opp.type).first();

      const id = crypto.randomUUID();
      const status = rule?.auto_approve ? 'active' : 'pending_approval';

      // Build objective-driven name
      const name = buildCampaignName(opp);

      // Build reasoning that explains WHY
      const reasoning = [
        `OBJECTIVE: ${opp.objective}`,
        `IMPACT SCORE: ${opp.impact_score} (ranked #${scored.indexOf(opp) + 1} of ${scored.length} opportunities)`,
        `TARGET: ${campaignSize} customers, sorted by predicted lifetime value (avg CLV: $${opp.avg_target_clv})`,
        `REVENUE POTENTIAL: $${Math.round(opp.estimated_revenue || opp.estimated_revenue_at_risk || 0)}`,
        `REVENUE/SMS: $${opp.revenue_per_sms}`,
        perf[opp.type]
          ? `HISTORICAL: ${perf[opp.type].campaigns_run} past campaigns, ${Math.round(perf[opp.type].avg_return_rate * 100)}% avg return rate, $${Math.round(perf[opp.type].total_revenue || 0)} total revenue`
          : 'FIRST RUN: No historical data — testing this approach',
      ].join('\n');

      const dailyLimit = opp.urgency === 'high' ? 10 : 5;
      const dripSchedule = opp.send_strategy === 'drip'
        ? JSON.stringify([
            { day: 0, type: 'gentle', template: 'Warm reminder — reference their favorite item naturally' },
            { day: 7, type: 'urgency', template: 'Acknowledge time passed, keep it real, no guilt' },
            { day: 14, type: 'final', template: 'Last gentle nudge — door is always open' },
          ])
        : null;

      await env.DB.prepare(`
        INSERT INTO retail_campaigns (
          id, name, campaign_type, status, target_segment,
          target_criteria, estimated_reach,
          send_strategy, drip_schedule, daily_send_limit,
          approval_status, agent_reasoning,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        id, name, opp.type, status, opp.target_segment || 'all',
        JSON.stringify(opp.target_criteria),
        campaignSize,
        opp.send_strategy || 'immediate',
        dripSchedule,
        dailyLimit,
        status === 'active' ? 'approved' : 'pending',
        reasoning,
      ).run();

      // Attach discount if data supports it
      if (opp.recommended_discount) {
        const amount = opp.discount_amount || 500;
        try {
          const disc = await createSquareDiscount(env, {
            campaignId: id,
            discountType: 'FIXED_AMOUNT',
            amount,
            maxRedemptions: campaignSize,
          });
          await env.DB.prepare(
            "UPDATE retail_campaigns SET name = name || ?, message_template = ? WHERE id = ?"
          ).bind(
            ` · $${amount / 100} OFF`,
            `Include discount code ${disc.code} for $${amount / 100} off — mention naturally. The pretzel is the draw, the code is the cherry on top.`,
            id
          ).run();
          console.log(`[Retail] Created $${amount / 100} OFF discount ${disc.code} for ${opp.type}`);
        } catch (err) {
          console.error(`[Retail] Discount creation failed for ${opp.type}: ${err.message}`);
        }
      }

      proposed++;
      console.log(`[Retail] ✅ Proposed ${opp.type}: "${name}" (score: ${opp.impact_score}, ${campaignSize} targets, $${opp.revenue_per_sms}/SMS)`);
    } catch (err) {
      console.error(`[Retail] Failed to create ${opp.type} campaign: ${err.message}`);
    }
  }

  return proposed;
}

// ── Campaign name builder — objective-driven, accurate ──────────
function buildCampaignName(opp) {
  const count = Math.min(opp.targets.length, 40);
  switch (opp.type) {
    case 'urgent_save':
      return `Save ${count} High-Value Customers (churn risk >70%)`;
    case 'day3_followup':
      return `Day 3-7 Follow-up: ${count} New Customers`;
    case 'magic_number_push':
      return `Push ${count} to Visit ${opp.magic_number_data?.number || 3} (retention lock-in)`;
    case 'winback':
      return `Win-back: ${count} Lapsed VIPs`;
    case 'group_reactivation':
      return `Group Buyers: ${count} to Reactivate`;
    case 'cadence_nudge':
      return `Pre-Churn Nudge: ${count} Slowing Regulars`;
    case 'upsell':
      return `Cross-sell: ${count} One-Item Loyalists`;
    default:
      return `Campaign: ${count} ${opp.type} Targets`;
  }
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
      WHERE rc.campaign_type = 'winback' AND rcs.returned_at IS NOT NULL
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
// REMOVED 2026-04-18 — reengageLapsedCustomers + generateReengagementSMS were legacy
// autopilot re-engagement using Llama 3.1 8b (Haiku fallback) to draft free-form SMS.
// Problems that shipped to real customers:
//   1. bypassed validateSMS() — banned phrases ("new flavor", "new beer taps") shipped
//   2. hallucinated features (customer 9622 got "New beer taps and pretzels waiting" —
//      false), dropped brand identification (customer 9622 never saw "Dangerous Pretzel")
//   3. no frequency cap (Nick Tripp got Gold Win-Back + reengagement 26h apart)
//   4. no tier routing (17-visit Maddie treated identically to 1-visit customer)
//   5. didn't write to retail_campaign_sends — invisible to analytics + the new 48h guard
//
// Lapsed customers now route through the 5-tier consolidated model:
//   - visit_count >= 10, 30d+ lapsed → Platinum dossier (manual per-customer)
//   - visit_count 4-9, 30d+ lapsed → Gold Win-Back (condition-triggered continuous)
//   - visit_count 1, 30-180d lapsed → Singles (condition-triggered continuous)
//   - churn_prob > 0.7 + CLV $50-100 → Silver Save (condition-triggered continuous)
//   - visit_count 4+, momentum < -30, 7-29d since visit → Momentum Save

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
    // Supply NOT NULL `name` column — fall back through company → full name → phone → 'Unknown'.
    // Prior omission crashed every retail cron run since Apr 15 with NOT NULL constraint failure.
    const fullName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim();
    const leadName = buyer.company || fullName || buyer.phone || 'Retail Group Buyer';
    await env.DB.prepare(`
      INSERT INTO catering_leads (
        id, name, contact_name, contact_email, contact_phone,
        source, source_customer_id, status, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'retail_crossover', ?, 'prospect', ?, datetime('now'), datetime('now'))
    `).bind(
      leadId, leadName, buyer.first_name || null, buyer.email || null,
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
    SELECT rcs.message_text, rcs.sent_at,
           CASE WHEN rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END AS returned,
           rcs.returned_at,
           rcs.return_order_value AS revenue_attributed,
           rc.campaign_type,
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

  // Per-message effectiveness: which specific messages drove returns
  const msgPerf = {};
  for (const s of results) {
    const msg = (s.message_text || '').substring(0, 120);
    if (!msg || msg === '[holdout - no message sent]') continue;
    if (!msgPerf[msg]) msgPerf[msg] = { sent: 0, returned: 0, opt_outs: 0, revenue: 0 };
    msgPerf[msg].sent++;
    if (s.returned === 1) { msgPerf[msg].returned++; msgPerf[msg].revenue += s.revenue_attributed || 0; }
    if (s.outcome === 'unsubscribed') msgPerf[msg].opt_outs++;
  }

  const winningMessages = Object.entries(msgPerf)
    .filter(([_, d]) => d.returned > 0 && d.sent >= 3)
    .map(([text, d]) => ({ text, return_rate: Math.round(d.returned / d.sent * 100), avg_value: d.revenue / d.returned, sent: d.sent }))
    .sort((a, b) => b.return_rate - a.return_rate)
    .slice(0, 8);

  const losingMessages = Object.entries(msgPerf)
    .filter(([_, d]) => d.opt_outs > 0)
    .map(([text, d]) => ({ text, opt_out_rate: Math.round(d.opt_outs / d.sent * 100), sent: d.sent }))
    .sort((a, b) => b.opt_out_rate - a.opt_out_rate)
    .slice(0, 5);

  // Discount effectiveness isolation
  let discountLift = null;
  try {
    const discountData = await env.DB.prepare(`
      SELECT
        CASE WHEN d.id IS NOT NULL THEN 'with_discount' ELSE 'no_discount' END as has_discount,
        COUNT(DISTINCT s.id) as sends,
        SUM(CASE WHEN s.returned_at IS NOT NULL THEN 1 ELSE 0 END) as returns,
        ROUND(AVG(s.revenue_attributed), 2) as avg_return_value
      FROM retail_campaign_sends s
      JOIN retail_campaigns c ON s.campaign_id = c.id
      LEFT JOIN retail_campaign_discounts d ON c.id = d.campaign_id AND d.status = 'active'
      WHERE s.sent_at >= datetime('now', '-60 days')
        AND s.variant_id != 'holdout'
      GROUP BY has_discount
    `).all();
    if (discountData.results?.length > 0) {
      discountLift = {};
      for (const row of discountData.results) {
        discountLift[row.has_discount] = {
          sends: row.sends,
          returns: row.returns || 0,
          return_rate: row.sends > 0 ? Math.round((row.returns || 0) / row.sends * 100) : 0,
          avg_value: row.avg_return_value || 0,
        };
      }
    }
  } catch (e) { console.error('[Retail] Discount lift calc error:', e.message); }

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
    winning_messages: winningMessages,
    losing_messages: losingMessages,
    discount_lift: discountLift,
  };

  await env.KV.put('retail_campaign_learnings', JSON.stringify(learnings));
  console.log(`[Retail] Campaign learnings updated: ${totalSent} sends, ${totalReturned} returns (${learnings.overall_return_rate}%), ${winningMessages.length} winning msgs, ${losingMessages.length} losing msgs`);
  return learnings;
}

// ── WEEKLY SELF-REFLECTION — Agent reviews its own performance ──
async function weeklyReflection(env) {
  // Load this week's data
  const learnings = JSON.parse(await env.KV.get('retail_campaign_learnings') || '{}');
  if (!learnings.sample_size || learnings.sample_size < 10) {
    console.log('[Retail] Not enough data for self-reflection (<10 sends)');
    return null;
  }

  // Load existing brain rules so we don't duplicate
  const existingBrain = await env.DB.prepare(
    `SELECT instruction FROM business_brain WHERE active = 1 AND (scope = 'retail' OR scope = 'all')`
  ).all();
  const existingRules = (existingBrain.results || []).map(r => r.instruction).join('\n');

  const prompt = `You are the Dangerous Pretzel Co retail intelligence agent reviewing your own performance.

Last 30 days of campaign data:
- Total sends: ${learnings.sample_size}
- Overall return rate: ${learnings.overall_return_rate}%
- By campaign type: ${JSON.stringify(learnings.by_campaign_type || [])}
- By behavior type: ${JSON.stringify(learnings.by_behavior_type || [])}
- Best days: ${JSON.stringify(learnings.best_days || [])}
- Winning messages (drove returns): ${JSON.stringify(learnings.winning_messages || [])}
- Messages that caused opt-outs: ${JSON.stringify(learnings.losing_messages || [])}
- Discount lift: ${JSON.stringify(learnings.discount_lift || 'no data yet')}

Current brain rules (DO NOT duplicate these):
${existingRules.substring(0, 2000)}

Based ONLY on the data above, identify 1-3 concrete, actionable learnings. Requirements:
- Each learning must be backed by specific data (cite the numbers)
- Minimum sample size: 10 sends for any pattern to be significant
- Do NOT repeat any existing brain rule
- Focus on patterns that will improve future campaign performance

Examples of good learnings:
- "Messages referencing specific menu items have 24% return rate vs 8% for generic — always reference the customer's favorite item"
- "Tuesday sends have 40% higher return than Monday — avoid Monday sends"
- "Win-back with discount: 22% return vs 9% without — always attach discount to win-backs"

Reply ONLY valid JSON:
{
  "learnings": [
    {
      "category": "timing|voice|product|nuance|avoid",
      "instruction": "The concrete rule to follow, with data cited",
      "confidence": 0.0-1.0,
      "evidence": "Brief explanation of the data pattern"
    }
  ]
}`;

  try {
    // DIF-3 (May 13 2026): wired through ai-budget
    const aiResult = await callAI(env, {
      use_case: 'retail_self_reflection',
      model: 'sonnet',
      caller: 'retail-agent.js',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    if (!aiResult.ok) {
      console.error(`[Retail] Self-reflection Claude error: ${aiResult.error || aiResult.blocked_reason || 'unknown'}`);
      return null;
    }

    const text = aiResult.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);
    const learningsSaved = [];

    for (const learning of (result.learnings || [])) {
      if (learning.confidence >= 0.7) {
        // High confidence — auto-insert into brain
        const id = `reflection_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await env.DB.prepare(
          `INSERT INTO business_brain (id, scope, category, instruction, entity_name, source, active, use_count, created_at, updated_at)
           VALUES (?, 'retail', ?, ?, 'self_reflection', 'agent_weekly_review', 1, 0, datetime('now'), datetime('now'))`
        ).bind(id, learning.category || 'nuance', learning.instruction).run();
        learningsSaved.push({ ...learning, auto_saved: true });
        console.log(`[Retail] 🧠 Self-reflection learned (auto): ${learning.instruction.substring(0, 80)}...`);
      } else {
        // Low confidence — flag for Drew to review
        const qId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await env.KV.put(`pending_question:${qId}`, JSON.stringify({
          id: qId,
          question: `The agent identified a possible pattern: "${learning.instruction}" (confidence: ${learning.confidence}). Evidence: ${learning.evidence}. Should this become a rule?`,
          context: 'weekly_self_reflection',
          applies_to: 'retail',
          asked_at: new Date().toISOString(),
          answered: false,
        }), { expirationTtl: 30 * 86400 });
        learningsSaved.push({ ...learning, flagged_for_review: true });
        console.log(`[Retail] 🤔 Self-reflection flagged (low confidence): ${learning.instruction.substring(0, 80)}...`);
      }
    }

    console.log(`[Retail] Self-reflection complete: ${learningsSaved.length} learnings (${learningsSaved.filter(l => l.auto_saved).length} auto-saved, ${learningsSaved.filter(l => l.flagged_for_review).length} flagged)`);
    return learningsSaved;
  } catch (err) {
    console.error(`[Retail] Self-reflection error: ${err.message}`);
    return null;
  }
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

  // DIF-3 (May 13 2026): wired through ai-budget
  // Preserves prior fetchWithBackoff semantics (retries: 2, baseDelayMs: 2000) at the
  // call site since callAI does not have a built-in retry. 3 attempts total, only
  // retrying on 429/5xx errors. 8000 tokens — the insight JSON has 8 verbose sections
  // and Claude Sonnet 4.6 writes long, considered responses. Previous limits of 1000
  // and 3000 both caused mid-JSON truncation and silent parse failures (last successful
  // write 2026-03-30). Sonnet 4.6 supports up to 64k output tokens; 8000 gives
  // comfortable headroom for the full analysis + campaign recommendations + discoveries
  // + proposed goals.
  let result = null;
  let attempts = 0;
  while (attempts < 3) {
    attempts++;
    result = await callAI(env, {
      use_case: 'retail_weekly_insight',
      model: 'sonnet',
      caller: 'retail-agent.js',
      max_tokens: 8000,
      ...(brainContext ? { system: brainContext } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    if (result.ok) break;
    if (!result.error || (!result.error.startsWith('429') && !result.error.startsWith('5'))) break;
    await new Promise(r => setTimeout(r, [2000, 5000, 10000][attempts - 1] || 10000));
  }

  if (!result || !result.ok) {
    console.error(`[Retail] generateWeeklyInsight Claude API non-ok: ${(result && (result.error || result.blocked_reason)) || 'unknown'}`);
    return null;
  }
  const text = result.content || '';

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    let insight;
    try {
      insight = JSON.parse(clean);
    } catch (parseErr) {
      console.error(`[Retail] generateWeeklyInsight JSON parse failed: ${parseErr.message} — first 400 chars of response: ${clean.slice(0, 400)}`);
      throw parseErr;
    }

    try {
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
    } catch (dbErr) {
      console.error(`[Retail] generateWeeklyInsight D1 insert failed: ${dbErr.message}`);
      throw dbErr;
    }

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

    // DIF-3 (May 13 2026): wired through ai-budget
    const result = await callAI(env, {
      use_case: 'retail_monthly_strategy',
      model: 'sonnet',
      caller: 'retail-agent.js',
      max_tokens: 2000,
      ...(brainContext ? { system: brainContext } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    if (result.ok) {
      const text = result.content || '';
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

// ── BUSINESS BRAIN SEEDER ────────────────────────────────────────
// Idempotent — safe to re-run. Seeds ground truth the agent validates against.
async function seedBusinessBrain(env) {
  const entries = [
    // ── PRODUCT KNOWLEDGE ──────────────────────────────────
    { id: 'brain_product_menu', scope: 'retail', category: 'product', entity_name: 'menu_overview',
      instruction: 'Dangerous Pretzel Co menu: Spicy Bee (jalapeño, white cheddar, hot honey — our spiciest, fan favorite), BBK / Brush Before Kissing (parmesan, garlic — savory classic), The Saint (cinnamon sugar — sweet option), The Salty (classic salted pretzel — simple, clean), For The Kids (smaller plain pretzel), Salty Bombs (pretzel bites, ~8 count). We also serve rotating craft beer taps and soft drinks. That is the COMPLETE menu — nothing else exists.' },
    { id: 'brain_product_spicybee', scope: 'retail', category: 'product', entity_name: 'sku_SPICY-BEE',
      instruction: 'Spicy Bee: jalapeño, white cheddar, drizzled with hot honey. Our signature heat pretzel. Popular with adventurous eaters and regulars. Pairs well with beer. Individual ~$7.' },
    { id: 'brain_product_bbk', scope: 'retail', category: 'product', entity_name: 'sku_BBK',
      instruction: 'BBK (Brush Before Kissing): loaded with parmesan and roasted garlic. Savory, rich, a little indulgent. Our most paired item — often ordered alongside The Salty. Individual ~$7.' },
    { id: 'brain_product_saint', scope: 'retail', category: 'product', entity_name: 'sku_SAINT',
      instruction: 'The Saint: cinnamon sugar sweet pretzel. The dessert play. Families and sweet-tooth customers love it. Often paired with The Salty for a sweet/salty combo. Individual ~$6.' },
    { id: 'brain_product_salty', scope: 'retail', category: 'product', entity_name: 'sku_SALTY',
      instruction: 'The Salty: classic salted pretzel. Simple, clean, no frills. Our foundation item. Most commonly paired with BBK or Saint. Individual ~$6.' },
    { id: 'brain_product_kids', scope: 'retail', category: 'product', entity_name: 'sku_KIDS',
      instruction: 'For The Kids: smaller, simpler pretzel for children. Lower price point. Signals family-friendly dining.' },
    { id: 'brain_product_bombs', scope: 'retail', category: 'product', entity_name: 'sku_BOMBS',
      instruction: 'Salty Bombs: pretzel bites (~8 count). Shareable, snackable. Great for groups and beer pairing. Available in Salty, Saint (cinnamon sugar), BBK (parmesan garlic), and Spicy Bee (hot pepper) varieties. ~$6.' },
    { id: 'brain_product_notexist', scope: 'retail', category: 'product', entity_name: 'nonexistent_items',
      instruction: 'We do NOT have and have NEVER had: loyalty cards, punch cards, free upgrades, happy hour, secret menu, loaded pretzels, nachos, sandwiches, pizza, burgers, salads, soup, wraps, bowls, or any menu item not explicitly listed. We do not run seasonal specials, limited-time offers, or promotional events unless Drew specifically creates one.' },

    // ── BRAND & VOICE ──────────────────────────────────────
    { id: 'brain_voice_brand', scope: 'retail', category: 'voice', entity_name: 'brand_identity',
      instruction: 'Business name: "Dangerous Pretzel Co" — always use this. "Ruin Dinner" is ONLY a tagline/slogan, NEVER the business name. Never call the restaurant "Ruin Dinner" or "Dangerous Pretzel Ruin Dinner." Just "Dangerous Pretzel Co" or "Dangerous Pretzel."' },
    { id: 'brain_voice_tone', scope: 'retail', category: 'voice', entity_name: 'sms_tone',
      instruction: 'SMS tone: confident, a little edgy, not corporate. Like texting a friend who owns a pretzel shop. No exclamation spam (max 1 per message). No "Hey there!" opener. No emoji overload (0-1 emoji max). No "We miss you!" desperation. No corporate phrases like "valued customer" or "exclusive offer." Keep it real, keep it short.' },

    // ── HARD RULES (AVOID) ─────────────────────────────────
    { id: 'brain_avoid_invent', scope: 'retail', category: 'avoid', entity_name: 'no_invention',
      instruction: 'NEVER invent menu items, specials, events, promotions, or offers that do not exist. NEVER promise free items, upgrades, or rewards unless a specific discount code is attached to the campaign. NEVER reference "limited time" — nothing at DPC is limited time. NEVER say "exclusive offer" or "VIP access" — we do not have customer-facing tiers.' },
    { id: 'brain_avoid_events', scope: 'retail', category: 'avoid', entity_name: 'no_events',
      instruction: 'NEVER reference holidays, seasons, local events, grand openings, or new locations unless the campaign template explicitly says to. Do not assume what is happening in SLC. Do not make up "Pretzel Week" or "National Pretzel Day" events.' },
    { id: 'brain_avoid_competitors', scope: 'retail', category: 'avoid', entity_name: 'no_competitor_mention',
      instruction: 'NEVER mention competitors by name. NEVER compare us to other restaurants. NEVER disparage other food options. Our pretzels speak for themselves.' },
    { id: 'brain_avoid_overclaim', scope: 'retail', category: 'avoid', entity_name: 'no_overclaiming',
      instruction: 'NEVER claim "best in SLC" or "best pretzel ever" or superlatives we cannot back up. NEVER say "award-winning" unless we have actually won an award. NEVER reference press coverage unless it actually happened.' },

    // ── TIMING ─────────────────────────────────────────────
    { id: 'brain_timing_send', scope: 'retail', category: 'timing', entity_name: 'send_windows',
      instruction: 'Best SMS send windows: 10am-1pm (pre-lunch decision making) or 4pm-6pm (dinner planning). Never send before 9am or after 8pm. These are real people — respect their time.' },

    // ── BUSINESS CONTEXT ───────────────────────────────────
    { id: 'brain_nuance_location', scope: 'retail', category: 'nuance', entity_name: 'location_info',
      instruction: 'Dangerous Pretzel Co is located in Salt Lake City, UT. Fast-casual format: dine-in, takeout, delivery. We serve beer on rotating craft taps. Family-friendly during day, more of a beer-and-pretzel vibe at night. Website: dangerouspretzel.com' },
    { id: 'brain_nuance_discount', scope: 'retail', category: 'nuance', entity_name: 'discount_philosophy',
      instruction: 'Discounts are a tool, not a crutch. Use them strategically for win-backs and conversion pushes. Never train customers to expect deals. If a customer is coming back anyway (cadence nudge, day-3 followup), do NOT offer a discount — it just erodes margin for behavior that would have happened organically.' },
  ];

  let seeded = 0, skipped = 0;
  for (const entry of entries) {
    const exists = await env.DB.prepare('SELECT id FROM business_brain WHERE id = ?').bind(entry.id).first();
    if (exists) {
      // Update existing entry (in case wording improved)
      await env.DB.prepare(
        'UPDATE business_brain SET instruction = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).bind(entry.instruction, entry.id).run();
      skipped++;
    } else {
      await env.DB.prepare(
        `INSERT INTO business_brain (id, scope, category, instruction, entity_name, source, active, use_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'system_seed', 1, 0, datetime('now'), datetime('now'))`
      ).bind(entry.id, entry.scope, entry.category, entry.instruction, entry.entity_name).run();
      seeded++;
    }
  }

  return jsonResponse({ success: true, seeded, updated: skipped, total: entries.length });
}

// Known menu items — used by SMS validation to catch hallucinated items
// Banned phrases for campaign copy — the hallucination blocklist (duplicated here as
// a constant so the template validator can run without needing a customer/campaign context).
const BANNED_PHRASES = [
  'free upgrade', 'free drink', 'buy one get one', 'bogo', 'happy hour',
  'grand opening', 'new location', 'new menu', 'new flavor', 'limited time',
  'exclusive offer', 'loyalty reward', 'vip access', 'secret menu', 'secret sauce',
  'loaded pretzel', 'pretzel week', 'national pretzel', 'new upcoming', 'special event',
  'award winning', 'best in', '#1', 'voted best', 'featured on',
];

// Validate a campaign template AT AUTHOR TIME. Returns { ok, issues }. Called by the
// template-save endpoint before writing to the DB, so bad templates never make it
// to a customer send.
// Returns { ok: true, skipped: true } for null/empty/placeholder templates — those don't
// render at send time so they don't need TCPA/brand guards.
function validateCampaignTemplate(templateText) {
  const issues = [];
  if (!templateText || typeof templateText !== 'string' || !templateText.trim()) {
    return { ok: true, skipped: true, reason: 'empty or null — not used at send time' };
  }
  // Placeholder tokens used to document intentional no-render slots
  if (/^\[(personal|unused|placeholder)/i.test(templateText.trim())) {
    return { ok: true, skipped: true, reason: 'marker placeholder — not rendered' };
  }
  const lower = templateText.toLowerCase();

  // Estimate rendered length — strip placeholders to 12-char max guess + account for "Reply STOP to opt out"
  const estimatedLength = templateText.replace(/\{[a-z_]+\}/g, 'xxxxxxxxxxxx').length;
  if (estimatedLength > 160) {
    issues.push(`estimated rendered length ${estimatedLength} exceeds 160-char single-SMS limit`);
  }

  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) issues.push(`contains banned phrase: "${phrase}"`);
  }

  if (lower.includes('ruin dinner') && !lower.includes('dangerous pretzel')) {
    issues.push('uses "Ruin Dinner" without also naming "Dangerous Pretzel"');
  }

  if (!lower.includes('reply stop')) {
    issues.push('missing "Reply STOP" opt-out language (TCPA requirement)');
  }

  // Must identify brand somewhere (covers the sender-identification concern)
  if (!lower.includes('dangerous pretzel') && !lower.includes('dangerouspretzel.com')) {
    issues.push('message does not identify "Dangerous Pretzel" in any form');
  }

  return { ok: issues.length === 0, issues };
}

const KNOWN_MENU_ITEMS = new Set([
  'spicy bee', 'bbk', 'brush before kissing', 'the saint', 'saint',
  'the salty', 'salty', 'for the kids', 'salty bombs', 'bombs',
  'pretzel', 'pretzels', 'pretzel bites', 'beer', 'craft beer',
]);

// ── SMS PRE-FLIGHT VALIDATION ──────────────────────────────────────
async function validateSMS(sms, customer, campaign, env, brainContext = '') {
  const issues = [];
  let pass = true;

  // Campaign author trust flag: if the campaign has pre-approved message_variants or a
  // drip_schedule (i.e., the copy is explicitly authored and in the migration file),
  // skip Layer B (semantic Claude rewrite). That AI-rewrite was silently dropping discount
  // codes and re-inserting phone numbers as names. Rule-based checks still run.
  const isAuthoredCopy = !!(campaign.message_variants || campaign.drip_schedule);

  // ── Layer A: Rule-based checks (fast, no API call) ──
  // 1. Length check
  if (!sms || sms.length === 0) {
    return { pass: false, issues: ['Empty SMS'], suggestion: null };
  }
  if (sms.length > 160) {  // raised from 140 — "Reply STOP to opt out" suffix needs the room
    issues.push(`Too long: ${sms.length} chars (max 160)`);
    pass = false;
  }
  // Phone-as-name defense: any SMS containing a literal "+1XXXXXXXXXX" (10+ digits with + prefix)
  // in the greeting is a phone-used-as-first-name rendering bug. Reject hard, no fallback.
  if (/(?:^|\s)\+?1?\d{10,11}(?:,|\s|!|\?|$)/.test(sms.slice(0, 40))) {
    return { pass: false, issues: ['Phone-number-as-name rendered in greeting'], suggestion: null };
  }

  // 2. Brand name check
  const lowerSms = sms.toLowerCase();
  if (lowerSms.includes('ruin dinner') && !lowerSms.includes('dangerous pretzel')) {
    issues.push('Uses "Ruin Dinner" as business name instead of "Dangerous Pretzel Co"');
    pass = false;
  }

  // 3. Hallucination blocklist — ALWAYS runs. Templates containing these phrases are
  // bugs to fix at author time, not runtime-waivered. If a legitimate phrase lands here,
  // update the blocklist or rewrite the template.
  const hallucinations = [
    'free upgrade', 'free drink', 'buy one get one', 'bogo', 'happy hour',
    'grand opening', 'new location', 'new menu', 'new flavor', 'limited time',
    'exclusive offer', 'loyalty reward', 'vip access', 'secret menu', 'secret sauce',
    'loaded pretzel', 'pretzel week', 'national pretzel', 'new upcoming', 'special event',
    'award winning', 'best in', '#1', 'voted best', 'featured on',
  ];
  // Check against the resolved template text (after variable substitution) — include
  // campaign.message_variants so authored variants are treated the same as message_template.
  let templateLower = (campaign.message_template || '').toLowerCase();
  try {
    if (campaign.message_variants) {
      const vObj = JSON.parse(campaign.message_variants);
      for (const v of Object.values(vObj || {})) templateLower += ' ' + String(v || '').toLowerCase();
    }
  } catch {}
  for (const phrase of hallucinations) {
    if (lowerSms.includes(phrase) && !templateLower.includes(phrase)) {
      issues.push(`Hallucinated content: "${phrase}"`);
      pass = false;
    }
  }

  // 4. Promise check — "free", "complimentary", "on us" without discount code
  const promiseWords = ['free ', 'complimentary', 'on us', 'on the house', 'no charge'];
  const hasDiscount = (campaign.message_template || '').includes('discount code')
    || templateLower.includes('{code}')
    || !!campaign._discount_code;
  for (const word of promiseWords) {
    if (lowerSms.includes(word) && !hasDiscount) {
      issues.push(`Promises "${word.trim()}" but no discount code attached`);
      pass = false;
    }
  }

  // 5. Food item check
  const foodMentionRegex = /\b(?:pretzel|pretzels|bombs?|bbk|spicy bee|saint|salty|brush before|kids|beer|craft beer|lager|ipa|ale|stout|pilsner)\b/gi;
  const mentions = sms.match(foodMentionRegex) || [];
  for (const mention of mentions) {
    if (!KNOWN_MENU_ITEMS.has(mention.toLowerCase()) &&
        !['lager', 'ipa', 'ale', 'stout', 'pilsner'].includes(mention.toLowerCase())) {
      if (lowerSms.includes(mention.toLowerCase() + ' pretzel') ||
          lowerSms.includes('new ' + mention.toLowerCase())) {
        issues.push(`Unknown menu item reference: "${mention}"`);
        pass = false;
      }
    }
  }

  // 6. URL check
  if (lowerSms.includes('.com') && !lowerSms.includes('dangerouspretzel.com')) {
    issues.push('Contains non-DPC URL');
    pass = false;
  }

  // If rule-based checks failed, skip the expensive API call
  if (!pass) {
    return { pass: false, issues, suggestion: null };
  }

  // If this is author-approved campaign copy (message_variants or drip_schedule), the
  // semantic reviewer is more harmful than helpful — it rewrote clean templates and
  // dropped discount codes in prior runs. Trust the template; ship it.
  if (isAuthoredCopy) {
    return { pass: true, issues: [], suggestion: null, skipped_semantic_review: true };
  }

  // ── Layer B: Semantic self-review (Claude call) ──
  // Only for messages that passed rule checks — catches subtler issues
  try {
    const reviewPrompt = `You are a quality reviewer for Dangerous Pretzel Co SMS messages.
You are NOT the writer. You are the editor checking the writer's work.

REAL MENU (complete list): Spicy Bee, BBK (Brush Before Kissing), The Saint, The Salty, For The Kids, Salty Bombs. Rotating craft beer taps. NOTHING ELSE EXISTS.
Brand name: "Dangerous Pretzel Co" (never "Ruin Dinner" — that's just a tagline)
Location: Salt Lake City, UT. Fast-casual: dine-in, takeout, delivery, beer.

Review this SMS:
"${sms}"

Customer: ${customer.first_name || 'Unknown'}, ${customer.visit_count || 0} visits, favorite: ${customer.favorite_sku || 'unknown'}, last visit: ${customer.days_since || '?'} days ago
Campaign type: ${campaign.campaign_type || 'unknown'}

Check:
1. Does it reference ONLY real menu items from the list above?
2. Does it make any promises, claims, or offers we can't back up?
3. Is the tone right — confident, not desperate or corporate?
4. Would a real person want to receive this, or would they roll their eyes?
5. Is personalization meaningful, or is the name just jammed in?

Reply ONLY valid JSON: { "pass": true or false, "issues": ["issue1", "issue2"], "suggestion": "improved SMS if not passing, or null" }`;

    // DIF-3 (May 13 2026): wired through ai-budget
    const reviewResult = await callAI(env, {
      use_case: 'retail_sms_review',
      model: 'haiku',
      caller: 'retail-agent.js',
      max_tokens: 300,
      messages: [{ role: 'user', content: reviewPrompt }],
    });

    if (reviewResult.ok) {
      const reviewText = reviewResult.content || '';
      const jsonMatch = reviewText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const review = JSON.parse(jsonMatch[0]);
        if (!review.pass) {
          return {
            pass: false,
            issues: review.issues || ['Failed semantic review'],
            suggestion: review.suggestion || null,
            semantic_review: true,
          };
        }
      }
    }
  } catch (err) {
    // Semantic review failed — don't block the send, rule-based passed
    console.log(`[Retail] Semantic review error (non-blocking): ${err.message}`);
  }

  return { pass: true, issues: [], suggestion: null };
}

// Safe fallback SMS messages — guaranteed accurate, no AI
function getFallbackSMS(customer) {
  const name = customer.first_name || '';
  const sku = customer.favorite_sku || '';
  const skuNames = { 'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'Saint', 'SALTY': 'Salty', 'BOMBS': 'Salty Bombs', 'KIDS': 'pretzel' };
  const skuName = skuNames[sku] || 'pretzel';

  if (name && sku) return `${name}, your ${skuName} is waiting. dangerouspretzel.com`;
  if (name) return `${name}, we saved your spot. dangerouspretzel.com`;
  return `Your pretzel is waiting at Dangerous Pretzel Co. dangerouspretzel.com`;
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

// ── RETAIL RESULTS — single endpoint for redesigned Retail tab ──
// Returns business pulse (Square + catering + invoices), campaign attribution,
// action queue, scoreboard, and LTV signal in one call. Polled every 60s by the
// dashboard for near-real-time refresh.
// Resolve a period key (today / wkd / last7 / mtd / last30 / ytd) into MT datetime bounds.
// Returns ISO-like 'YYYY-MM-DD HH:MM:SS' strings to compare directly against
// `datetime(order_date, '-6 hours')` etc. in SQL. Comparisons are MT wall-clock.
function windowsFor(period, mtNowMs) {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const startOfDay = (ms) => { const d = new Date(ms); d.setUTCHours(0,0,0,0); return d.getTime(); };
  const startOfMonth = (ms) => { const d = new Date(ms); d.setUTCDate(1); d.setUTCHours(0,0,0,0); return d.getTime(); };
  const startOfYear = (ms) => { const d = new Date(ms); d.setUTCMonth(0,1); d.setUTCHours(0,0,0,0); return d.getTime(); };
  const startOfWeek = (ms) => { // Monday
    const d = new Date(ms);
    const dow = d.getUTCDay();
    const offset = dow === 0 ? 6 : dow - 1;
    d.setUTCDate(d.getUTCDate() - offset);
    d.setUTCHours(0,0,0,0);
    return d.getTime();
  };
  const subMonth = (ms) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() - 1); return d.getTime(); };
  const subYear = (ms) => { const d = new Date(ms); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.getTime(); };

  const end = mtNowMs;
  let start, priorStart, priorEnd, label, priorLabel;
  switch (period) {
    case 'today': {
      start = startOfDay(end);
      priorStart = start - 86400000;
      priorEnd = priorStart + (end - start);
      label = 'Today'; priorLabel = 'same point yesterday';
      break;
    }
    case 'last7': {
      start = end - 7 * 86400000;
      priorStart = end - 14 * 86400000;
      priorEnd = end - 7 * 86400000;
      label = 'Last 7 days'; priorLabel = 'prior 7 days';
      break;
    }
    case 'mtd': {
      start = startOfMonth(end);
      priorStart = subMonth(start);
      priorEnd = priorStart + (end - start);
      label = 'Month-to-date'; priorLabel = 'same point last month';
      break;
    }
    case 'last30': {
      start = end - 30 * 86400000;
      priorStart = end - 60 * 86400000;
      priorEnd = end - 30 * 86400000;
      label = 'Last 30 days'; priorLabel = 'prior 30 days';
      break;
    }
    case 'ytd': {
      start = startOfYear(end);
      priorStart = subYear(start);
      priorEnd = priorStart + (end - start);
      label = 'Year-to-date'; priorLabel = 'same point last yr';
      break;
    }
    case 'wkd':
    default: {
      start = startOfWeek(end);
      priorStart = start - 7 * 86400000;
      priorEnd = priorStart + (end - start);
      label = 'Wk-to-date'; priorLabel = 'same point last wk';
      period = 'wkd';
      break;
    }
  }
  return {
    period, label, priorLabel,
    start: fmt(start), end: fmt(end),
    priorStart: fmt(priorStart), priorEnd: fmt(priorEnd),
    fourteenDaysAgo: fmt(end - 13 * 86400000),
  };
}

// ── V2 endpoint handlers ─────────────────────────────────────────────

// GET /retail/verdict — read from cache; if stale, regenerate in background.
// ?force=1 forces immediate regeneration (the refresh button).
async function getVerdict(env, url) {
  const period = url.searchParams.get('period') || 'last_7_days';
  const force = url.searchParams.get('force') === '1';

  if (force) {
    // Block on regen so the user sees fresh data after clicking refresh.
    const { generateVerdict } = await import('./retail-verdict-generator.js');
    const verdict = await generateVerdict(env, period, { force: true });
    return jsonResponse(verdict);
  }

  // Try cache first.
  const cached = await env.DB.prepare(
    `SELECT period, state, headline, body, confidence, basis, generated_at, expires_at FROM verdict_cache WHERE period = ?`
  ).bind(period).first().catch(() => null);

  if (cached) {
    const now = Date.now();
    const expires = new Date(cached.expires_at).getTime();
    if (expires > now) return jsonResponse(cached);
    // Stale — return cached value AND trigger background regen.
    // (Caller's ctx isn't here, so we can't waitUntil. Best effort: regen synchronously
    //  but capped — if Sonnet is slow, fall back to cached.)
    try {
      const { generateVerdict } = await import('./retail-verdict-generator.js');
      const fresh = await Promise.race([
        generateVerdict(env, period, { force: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('verdict regen timeout')), 8000)),
      ]);
      return jsonResponse(fresh);
    } catch (err) {
      // Stale cache better than no verdict.
      return jsonResponse({ ...cached, stale: true, regen_error: err.message });
    }
  }

  // No cache row. Synchronous generation.
  const { generateVerdict } = await import('./retail-verdict-generator.js');
  const verdict = await generateVerdict(env, period, { force: true });
  return jsonResponse(verdict);
}

// GET /retail/suggestions — top 3 open, exclude snoozed.
async function getSuggestions(env) {
  const rows = await env.DB.prepare(`
    SELECT s.id, s.suggestion_id, s.rank, s.title, s.math, s.how_to,
           s.annual_lift_low, s.annual_lift_high, s.effort,
           s.current_value, s.goal_value, s.generated_at,
           (SELECT AVG(done_outcome_pct) FROM retail_suggestions
              WHERE suggestion_id = s.suggestion_id AND done_outcome_pct IS NOT NULL) as track_record_avg,
           (SELECT COUNT(*) FROM retail_suggestions
              WHERE suggestion_id = s.suggestion_id AND done_outcome_pct IS NOT NULL) as track_record_n
    FROM retail_suggestions s
    WHERE s.state = 'open'
      AND s.suggestion_id NOT IN (
        SELECT suggestion_id FROM snoozed_suggestions WHERE snooze_until > datetime('now')
      )
    ORDER BY
      CASE WHEN s.effort = 'urgent' THEN 0 ELSE 1 END,
      s.rank ASC
    LIMIT 3
  `).all().catch(() => ({ results: [] }));

  return jsonResponse({
    suggestions: (rows.results || []).map(r => ({
      ...r,
      track_record: r.track_record_n > 0
        ? { multiplier: Math.round(r.track_record_avg) / 100, n: r.track_record_n }
        : null,
    })),
    last_refresh: rows.results?.[0]?.generated_at || null,
  });
}

// POST /retail/suggestions/:id/done — flip state, schedule 30d follow-up.
async function markSuggestionDone(env, id) {
  await env.DB.prepare(`
    UPDATE retail_suggestions
    SET state = 'done',
        done_at = datetime('now'),
        followup_due_at = datetime('now', '+30 days')
    WHERE id = ?
  `).bind(id).run().catch(() => {});
  return jsonResponse({ ok: true, id, status: 'done', followup_in_days: 30 });
}

// POST /retail/suggestions/:id/snooze — write snoozed_suggestions row.
async function snoozeSuggestion(env, id, days) {
  // Get the suggestion_id from the row (snooze list keys on suggestion_id, not row id,
  // so future regenerations of the same type also stay snoozed).
  const row = await env.DB.prepare(
    `SELECT suggestion_id FROM retail_suggestions WHERE id = ?`
  ).bind(id).first().catch(() => null);
  if (!row) return jsonResponse({ error: 'suggestion not found' }, 404);

  const dur = Math.max(1, Math.min(90, parseInt(days) || 7));
  await env.DB.prepare(`
    INSERT INTO snoozed_suggestions (suggestion_id, snoozed_at, snooze_until)
    VALUES (?, datetime('now'), datetime('now', '+' || ? || ' days'))
    ON CONFLICT(suggestion_id) DO UPDATE SET
      snoozed_at = datetime('now'),
      snooze_until = datetime('now', '+' || ? || ' days')
  `).bind(row.suggestion_id, dur, dur).run();

  // Also flip the row state so it disappears from /retail/suggestions immediately.
  await env.DB.prepare(`UPDATE retail_suggestions SET state = 'snoozed' WHERE id = ?`).bind(id).run();
  return jsonResponse({ ok: true, suggestion_id: row.suggestion_id, snoozed_for_days: dur });
}

// GET /retail/deliverability/health — live classification of email_sends 7d.
async function getDeliverabilityHealth(env) {
  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) as sent,
      COUNT(*) FILTER (WHERE status = 'delivered' OR opened_at IS NOT NULL OR clicked_at IS NOT NULL) as delivered,
      COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as bounced,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as clicked,
      COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL OR status = 'complained') as unsubscribed
    FROM email_sends WHERE sent_at >= datetime('now','-7 days')
      AND status IN ('sent','delivered','bounced','complained','unsubscribed')
  `).first().catch(() => null);

  if (!stats || stats.sent === 0) {
    return jsonResponse({
      state: 'too_few_to_judge',
      message: 'Less than 10 emails sent in last 7 days. Send more to gauge deliverability.',
      sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0,
      open_rate_pct: null, bounce_rate_pct: null,
    });
  }

  const openRate = stats.delivered > 0 ? stats.opened / stats.delivered : 0;
  const bounceRate = stats.sent > 0 ? stats.bounced / stats.sent : 0;

  let state = 'healthy';
  let message = 'All campaigns delivering normally';
  const causes = [];

  if (stats.sent < 10) {
    state = 'too_few_to_judge';
    message = 'Less than 10 emails sent in last 7 days.';
  } else if (openRate === 0) {
    state = 'broken';
    message = 'Email open rate is 0% — tracking is likely broken';
    causes.push({ rank: 1, text: 'Open tracking pixel not firing', flag: 'most likely' });
    causes.push({ rank: 2, text: 'Emails landing in spam folder' });
    causes.push({ rank: 3, text: 'Click wrappers not in place' });
  } else if (openRate < 0.05) {
    state = 'critical';
    message = `Open rate critically low (${(openRate * 100).toFixed(1)}%)`;
    causes.push({ rank: 1, text: 'Sender reputation may be damaged' });
    causes.push({ rank: 2, text: 'Email content possibly flagged as spam' });
  } else if (openRate < 0.15) {
    state = 'warning';
    message = `Open rate below benchmark (${(openRate * 100).toFixed(1)}%)`;
  } else if (bounceRate > 0.05) {
    state = 'warning';
    message = `Bounce rate elevated (${(bounceRate * 100).toFixed(1)}%)`;
    causes.push({ rank: 1, text: 'List has stale addresses' });
  }

  return jsonResponse({
    state, message,
    sent: stats.sent, delivered: stats.delivered,
    opened: stats.opened, clicked: stats.clicked,
    bounced: stats.bounced, unsubscribed: stats.unsubscribed,
    open_rate_pct: stats.delivered > 0 ? Math.round(openRate * 1000) / 10 : null,
    click_rate_pct: stats.opened > 0 ? Math.round((stats.clicked / stats.opened) * 1000) / 10 : null,
    bounce_rate_pct: stats.sent > 0 ? Math.round(bounceRate * 1000) / 10 : null,
    causes,
  });
}

// POST /retail/deliverability/test-email — send a test to drew@ via existing email-sender.
async function testDeliverability(env) {
  // Reuse existing /retail/email/test endpoint via internal fetch.
  const resp = await fetch('https://pretzel-os.drew-f39.workers.dev/retail/email/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: 'drew@dangerouspretzel.com',
      cohort: 'b',
      first_name: 'Drew',
    }),
  });
  const result = await resp.json().catch(() => ({ error: 'failed to parse' }));
  return jsonResponse({ ok: resp.ok, ...result });
}

// Diagnose 0% email open rate — check Resend webhook subscriptions.
async function listResendWebhooks(env) {
  const resp = await fetch('https://api.resend.com/webhooks', {
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
  });
  const data = await resp.json().catch(() => null);
  return jsonResponse({ status: resp.status, ok: resp.ok, webhooks: data });
}

// Fix the missing 'email.opened' event subscription. Adds it to whatever webhook
// is configured for our endpoint URL.
async function fixResendWebhookOpens(env) {
  const listResp = await fetch('https://api.resend.com/webhooks', {
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
  });
  const listData = await listResp.json();
  if (!listResp.ok) return jsonResponse({ error: 'cant list webhooks', detail: listData }, 500);

  const webhooks = listData.data || listData.webhooks || [];
  const ourWebhook = webhooks.find(w => (w.endpoint || '').includes('pretzel-os.drew-f39.workers.dev'));
  if (!ourWebhook) return jsonResponse({
    error: 'No webhook found pointing to pretzel-os worker',
    webhooks_seen: webhooks.map(w => ({ id: w.id, endpoint: w.endpoint })),
  }, 404);

  const wantedEvents = [
    'email.sent', 'email.delivered', 'email.delivery_delayed',
    'email.bounced', 'email.complained',
    'email.opened', 'email.clicked',
  ];
  const currentEvents = ourWebhook.events || [];
  const missing = wantedEvents.filter(e => !currentEvents.includes(e));

  if (missing.length === 0) {
    return jsonResponse({
      ok: true, status: 'already_subscribed',
      webhook_id: ourWebhook.id,
      events: currentEvents,
    });
  }

  const updateResp = await fetch(`https://api.resend.com/webhooks/${ourWebhook.id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ events: wantedEvents }),
  });
  const updateData = await updateResp.json();
  return jsonResponse({
    ok: updateResp.ok,
    status: updateResp.status,
    was_missing: missing,
    result: updateData,
  });
}

// Inspect a customer's loyalty account + all rewards (diagnostic for back-fill misses).
// Usage: GET /retail/loyalty/account-rewards?phone=8015551234
async function inspectLoyaltyAccount(request, env, url) {
  const phone = url.searchParams.get('phone');
  if (!phone) return jsonResponse({ error: 'phone required' }, 400);
  const cleaned = String(phone).replace(/[^\d+]/g, '');
  const e164 = cleaned.startsWith('+') ? cleaned : (cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`);
  const accResp = await fetch('https://connect.squareup.com/v2/loyalty/accounts/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { mappings: [{ phone_number: e164 }] } }),
  });
  const accData = await accResp.json().catch(() => ({}));
  const account = accData.loyalty_accounts?.[0];
  if (!account) return jsonResponse({ phone: e164, no_account: true, raw: accData });
  const rwResp = await fetch('https://connect.squareup.com/v2/loyalty/rewards/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { loyalty_account_id: account.id } }),
  });
  const rwData = await rwResp.json().catch(() => ({}));
  return jsonResponse({
    phone: e164,
    account_id: account.id,
    balance: account.balance,
    lifetime_points: account.lifetime_points,
    rewards: (rwData.rewards || []).map(r => ({
      id: r.id, status: r.status, reward_tier_id: r.reward_tier_id,
      points: r.points, created_at: r.created_at, redeemed_at: r.redeemed_at,
    })),
    reward_count: (rwData.rewards || []).length,
  });
}

// GET /retail/loyalty/tiers — list the loyalty program's reward tiers (id + points + $-amount).
// Used to map campaign amounts → tier IDs for the recovery wave + future mints.
async function listLoyaltyTiers(env) {
  const progResp = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': '2024-10-17',
    },
  });
  const progData = await progResp.json().catch(() => ({}));
  const program = progData.program;
  if (!program) return jsonResponse({ error: 'no_program', raw: progData }, 500);
  const tiers = (program.reward_tiers || []).map(t => ({
    id: t.id,
    points: t.points,
    name: t.name,
    definition: t.definition,
    amount_cents: t.definition?.fixed_discount_money?.amount || null,
    created_at: t.created_at,
  }));
  return jsonResponse({
    program_id: program.id,
    program_status: program.status,
    accrual_rules: program.accrual_rules,
    tiers,
    tier_count: tiers.length,
  });
}

// GET /retail/loyalty/tiers/diag — diagnostic: probe Square's loyalty program endpoint
// across multiple API versions + specific-program-id path. Used when a tier added in
// the Dashboard isn't surfacing via /v2/loyalty/programs/main (suspected caching issue).
async function diagLoyaltyTiers(env) {
  const versions = ['2024-10-17', '2025-01-23', '2025-03-19', '2025-05-21', '2025-07-16'];
  const PROGRAM_ID = 'bb5743bb-8dcc-44cc-be6f-7739f9bb357e'; // known from earlier probes
  const out = [];
  for (const v of versions) {
    for (const pathSuffix of ['main', PROGRAM_ID]) {
      try {
        const resp = await fetch(`https://connect.squareup.com/v2/loyalty/programs/${pathSuffix}`, {
          headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': v, 'Cache-Control': 'no-cache' },
        });
        const data = await resp.json().catch(() => ({}));
        const tiers = data.program?.reward_tiers || [];
        out.push({
          version: v,
          path: pathSuffix,
          status: resp.status,
          tier_count: tiers.length,
          tiers_summary: tiers.map(t => `${t.points}pt/$${(t.definition?.fixed_discount_money?.amount||0)/100}`).join(','),
        });
      } catch (err) {
        out.push({ version: v, path: pathSuffix, error: err.message });
      }
    }
  }
  // Also try the list endpoint
  try {
    const resp = await fetch('https://connect.squareup.com/v2/loyalty/programs', {
      headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2025-07-16' },
    });
    const data = await resp.json().catch(() => ({}));
    out.push({
      version: '2025-07-16',
      path: 'list_all',
      status: resp.status,
      programs_returned: (data.programs || []).map(p => ({ id: p.id, status: p.status, tier_count: (p.reward_tiers || []).length })),
    });
  } catch (err) {
    out.push({ path: 'list_all', error: err.message });
  }
  return jsonResponse({ probes: out });
}

// POST /retail/loyalty/issue-test — issues a $5 reward to a single phone for QA.
// Body: { "phone": "+18015551234" }
// Returns: { reward_id, loyalty_account_id, ... }
async function issueTestLoyaltyReward(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.phone) return jsonResponse({ error: 'phone required' }, 400);
  const result = await issueLoyaltyReward(env, {
    phone: body.phone,
    idempotencySuffix: `test_${Date.now()}`,
  });
  return jsonResponse(result);
}

// POST /retail/repair-resend?dry_run=1 — issues loyalty rewards + sends apology SMS
// to the 304 stranded customers (288 Bucket 1 + 16 Bucket 3) across 5 campaigns.
// Campaign → loyalty reward tier ID. Each campaign originally promised a different
// $-amount; we mint at the matching tier so customers get the amount they were promised.
// Fetched 2026-05-11 via GET /retail/loyalty/tiers after Drew added $8 + $10 tiers.
// Single source of truth for per-campaign loyalty mint config. Used by:
// 1. runRepairResend (the recovery wave) for tier + apology copy
// 2. processConditionCampaigns (cron-fired regular sends) for amountCents lookup
// Replaces the broken `retail_campaign_discounts WHERE code IN ('DPGOLD',...)` template
// lookup that returned NULL for Welcome + Bronze (no rows matched the prefix filter),
// causing both to fall back to a $10 default — over-paying Welcome by $2 and Bronze by $5.
const REPAIR_TIER_BY_CAMPAIGN = {
  '9143a900-ba1c-48b5-9a15-06db2e7bd095': { tierId: '5860bbba-6cc7-4565-8e77-f11d38e1fbab', amountStr: '$8',  amountCents: 800 },  // Welcome
  '9ec6f467-0134-445f-b265-5951b0a0a9db': { tierId: '6ca7d894-7438-45a9-8b23-6ae33663a626', amountStr: '$15', amountCents: 1500 }, // Gold Win-Back (corrected May-11 — $15 tier added)
  'daa07670-fd60-434e-83ca-df37d21db7b8': { tierId: '7d665b73-e1ea-46f8-9d30-7a77dae72426', amountStr: '$10', amountCents: 1000 }, // Silver Save (corrected May-11 — was $8 in error)
  'bronze_save_2026':                     { tierId: '5174d22d-304c-4b4e-b4ab-124a92644989', amountStr: '$5',  amountCents: 500 },  // Bronze Save
  'f20398ce-9192-4bc1-8438-0466dbdb95ae': { tierId: '7d665b73-e1ea-46f8-9d30-7a77dae72426', amountStr: '$10', amountCents: 1000 }, // Momentum Save (corrected May-11 — was $8 in error)
};
const REPAIR_TIER_DEFAULT = { tierId: '5174d22d-304c-4b4e-b4ab-124a92644989', amountStr: '$5' };

async function runRepairResend(request, env, url) {
  const dryRun = url.searchParams.get('dry_run') === '1';
  const limitOverride = parseInt(url.searchParams.get('limit') || '0');

  // Pull recovery cohort
  const recipients = await env.DB.prepare(`
    WITH bucket_1 AS (
      SELECT DISTINCT rcs.customer_id, rcs.campaign_id, 'didnt_come_back' as bucket
      FROM retail_campaign_sends rcs
      WHERE rcs.returned_at IS NULL
        AND rcs.discount_code IS NOT NULL
        AND rcs.sent_at >= datetime('now','-30 days')
        AND rcs.campaign_id IN (
          '9143a900-ba1c-48b5-9a15-06db2e7bd095',
          '9ec6f467-0134-445f-b265-5951b0a0a9db',
          'daa07670-fd60-434e-83ca-df37d21db7b8',
          'bronze_save_2026',
          'f20398ce-9192-4bc1-8438-0466dbdb95ae'
        )
    ),
    bucket_3 AS (
      SELECT DISTINCT rcs.customer_id, rcs.campaign_id, 'came_back_no_redeem' as bucket
      FROM retail_campaign_sends rcs
      WHERE rcs.returned_at IS NOT NULL
        AND rcs.discount_code IS NOT NULL
        AND rcs.sent_at >= datetime('now','-30 days')
        AND rcs.return_order_value > 0
        AND NOT EXISTS (
          SELECT 1 FROM retail_campaign_discounts rcd
          WHERE rcd.code = rcs.discount_code
            AND rcd.campaign_id = rcs.campaign_id
            AND rcd.times_redeemed > 0
        )
    )
    SELECT u.customer_id, u.campaign_id, u.bucket,
      cu.first_name, cu.normalized_phone, cu.phone
    FROM (SELECT * FROM bucket_1 UNION SELECT * FROM bucket_3) u
    JOIN retail_customers cu ON cu.id = u.customer_id
    LEFT JOIN sms_suppressions ss ON ss.phone = cu.normalized_phone
    WHERE cu.sms_eligible = 1
      AND ss.phone IS NULL
      AND (cu.normalized_phone IS NOT NULL OR cu.phone IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM retail_campaign_sends rcs2
        WHERE rcs2.customer_id = u.customer_id
          AND rcs2.campaign_id = u.campaign_id
          AND rcs2.variant_id = 'repair_resend_v1'
      )
    ORDER BY u.bucket, u.customer_id
  `).all().catch(() => ({ results: [] }));

  const all = recipients.results || [];
  const targeted = limitOverride > 0 ? all.slice(0, limitOverride) : all;

  if (dryRun) {
    // Show 1 sample per campaign so Drew can verify the $-amount per cohort
    const byCampaign = {};
    for (const r of targeted) {
      if (!byCampaign[r.campaign_id]) byCampaign[r.campaign_id] = r;
    }
    const sample = Object.values(byCampaign).map(r => {
      const tm = REPAIR_TIER_BY_CAMPAIGN[r.campaign_id] || REPAIR_TIER_DEFAULT;
      return {
        customer_id: r.customer_id,
        first_name: r.first_name,
        campaign_id: r.campaign_id,
        bucket: r.bucket,
        amount: tm.amountStr,
        tier_id: tm.tierId,
        sms_preview: renderRepairSms(r, tm.amountStr),
        sms_length: renderRepairSms(r, tm.amountStr).length,
      };
    });
    // Per-campaign cohort counts
    const byCampaignCount = {};
    for (const r of targeted) {
      byCampaignCount[r.campaign_id] = (byCampaignCount[r.campaign_id] || 0) + 1;
    }
    return jsonResponse({
      mode: 'dry_run',
      total_targeted: targeted.length,
      buckets: {
        didnt_come_back: targeted.filter(r => r.bucket === 'didnt_come_back').length,
        came_back_no_redeem: targeted.filter(r => r.bucket === 'came_back_no_redeem').length,
      },
      by_campaign_count: byCampaignCount,
      sample,
    });
  }

  // Live send — process up to 12 minutes (under Cloudflare's 15-min limit). Idempotent
  // on variant_id, so re-firing this endpoint resumes from where it stopped.
  // Square Loyalty has tight rate limits, so we throttle differently for new vs existing accounts.
  const TIME_BUDGET_MS = 12 * 60 * 1000;
  const t0 = Date.now();
  const result = {
    sent: 0, errors: 0, skipped_fatigue: 0, rate_limited: 0,
    errors_detail: [], time_budget_remaining_at_exit: null,
  };
  for (const r of targeted) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      result.time_budget_exhausted = true;
      result.processed_so_far = result.sent + result.errors + result.skipped_fatigue;
      result.remaining = targeted.length - result.processed_so_far;
      break;
    }
    try {
      // Brand fatigue check
      const recent = await env.DB.prepare(`
        SELECT 1 FROM retail_campaign_sends WHERE customer_id = ?
          AND sent_at >= datetime('now','-24 hours') AND outcome IN ('delivered','sent') LIMIT 1
      `).bind(r.customer_id).first().catch(() => null);
      if (recent) { result.skipped_fatigue++; continue; }

      // Issue loyalty reward at the campaign's original promised amount
      const tierMap = REPAIR_TIER_BY_CAMPAIGN[r.campaign_id] || REPAIR_TIER_DEFAULT;
      const reward = await issueLoyaltyReward(env, {
        phone: r.normalized_phone || r.phone,
        tierId: tierMap.tierId,
        idempotencySuffix: `repair_${r.customer_id}`,
      });
      if (reward.error) {
        if (reward.error.includes('RATE_LIMIT')) {
          result.rate_limited++;
          // Wait 30s and try again next loop iteration via continue (won't retry this customer; they'll be picked up on re-fire)
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        result.errors++;
        result.errors_detail.push({ customer_id: r.customer_id, error: reward.error.slice(0, 200) });
        continue;
      }

      // Render + send SMS (brand-fatigue 48h guard bypassed: recovery is intentional)
      const sms = renderRepairSms(r, tierMap.amountStr);
      const sendResult = await sendSwellSMS(r.normalized_phone || r.phone, sms, env, {
        bypassFatigueGuard: true,
        caller: 'repair_resend_v1',
      });

      // Insert send row for tracking + reward audit (C.2: includes loyalty_reward_id + account)
      const sendId = crypto.randomUUID();
      const ok = sendResult?.success === true;
      await env.DB.prepare(`
        INSERT INTO retail_campaign_sends (
          id, campaign_id, customer_id, variant_id, message_text,
          sent_at, outcome, expires_at, loyalty_reward_id, loyalty_account_id
        ) VALUES (?, ?, ?, 'repair_resend_v1', ?, datetime('now'), ?, date('now','+30 days'), ?, ?)
      `).bind(
        sendId, r.campaign_id, r.customer_id, sms,
        ok ? 'sent' : 'failed',
        ok ? (reward.reward_id || null) : null,
        ok ? (reward.loyalty_account_id || null) : null,
      ).run().catch(() => {});

      if (ok) {
        result.sent++;
      } else {
        result.errors++;
        result.errors_detail.push({
          customer_id: r.customer_id,
          error: `sms_${sendResult?.error || 'unknown'}`,
        });
      }

      // Throttle: shorter for existing-loyalty (just adjust+reward), longer for new enrollments
      const throttle = reward.created_new_account ? 6000 : 2000;
      await new Promise(r => setTimeout(r, throttle));
    } catch (err) {
      result.errors++;
      result.errors_detail.push({ customer_id: r.customer_id, error: (err.message || '').slice(0, 200) });
    }
  }
  result.time_budget_remaining_at_exit = Math.max(0, TIME_BUDGET_MS - (Date.now() - t0));
  return jsonResponse({ mode: 'live', total_targeted: targeted.length, ...result });
}

// C.7 — Back-fill loyalty_reward_id + loyalty_account_id for wave sends that fired
// BEFORE the C.1 schema landed. Matches send rows to Square loyalty rewards by:
// (1) customer phone → loyalty account, (2) reward_tier_id matching campaign expected tier,
// (3) reward.created_at within ±15min of send.sent_at. Idempotent — only updates rows
// where loyalty_reward_id IS NULL.
async function backfillWaveRewardIds(request, env, url) {
  const dryRun = url.searchParams.get('dry_run') === '1';
  const limit = parseInt(url.searchParams.get('limit') || '500');
  // RELAXED mode: drop the tier filter (round-1 Gold/Silver were issued at the lower amounts
  // before tier-correction; their rewards have a different reward_tier_id than the campaign's
  // current canonical tier). Match by timestamp + customer account only. Expands window to ±60min.
  const relaxed = url.searchParams.get('relaxed') === '1';
  const windowMinutes = parseInt(url.searchParams.get('window_min') || (relaxed ? '240' : '15'));
  const timeWindowMs = windowMinutes * 60 * 1000;
  const rows = await env.DB.prepare(`
    SELECT rcs.id, rcs.campaign_id, rcs.customer_id, rcs.sent_at,
           rc.normalized_phone, rc.phone,
           rcg.loyalty_tier_id, rcg.loyalty_amount_cents
    FROM retail_campaign_sends rcs
    JOIN retail_customers rc ON rc.id = rcs.customer_id
    LEFT JOIN retail_campaigns rcg ON rcg.id = rcs.campaign_id
    WHERE rcs.variant_id = 'repair_resend_v1'
      AND rcs.outcome = 'sent'
      AND rcs.loyalty_reward_id IS NULL
    ORDER BY rcs.sent_at
    LIMIT ?
  `).bind(limit).all().catch(() => ({ results: [] }));
  const targets = rows.results || [];
  if (dryRun) return jsonResponse({ mode: 'dry_run', total_to_backfill: targets.length, sample: targets.slice(0, 3) });

  const result = { matched: 0, no_account: 0, no_reward_match: 0, errors: 0, error_detail: [] };
  for (const r of targets) {
    try {
      const cleaned = String(r.normalized_phone || r.phone || '').replace(/[^\d+]/g, '');
      const e164 = cleaned.startsWith('+') ? cleaned : (cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`);
      // 1. Find loyalty account
      const accResp = await fetch('https://connect.squareup.com/v2/loyalty/accounts/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { mappings: [{ phone_number: e164 }] } }),
      });
      const accData = await accResp.json().catch(() => ({}));
      const accountId = accData.loyalty_accounts?.[0]?.id;
      if (!accountId) { result.no_account++; continue; }
      // 2. Search rewards on that account
      const rwResp = await fetch('https://connect.squareup.com/v2/loyalty/rewards/search', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { loyalty_account_id: accountId } }),
      });
      const rwData = await rwResp.json().catch(() => ({}));
      const rewards = rwData.rewards || [];
      // 3. Match by created_at within ±timeWindowMs of sent_at; tier_id check only in strict mode.
      const sentMs = new Date(r.sent_at + 'Z').getTime();
      const match = rewards.find(rw => {
        if (!relaxed && rw.reward_tier_id !== r.loyalty_tier_id) return false;
        const created = new Date(rw.created_at).getTime();
        return Math.abs(created - sentMs) <= timeWindowMs;
      });
      if (!match) { result.no_reward_match++; continue; }
      // 4. Persist
      await env.DB.prepare(
        "UPDATE retail_campaign_sends SET loyalty_reward_id = ?, loyalty_account_id = ? WHERE id = ?"
      ).bind(match.id, accountId, r.id).run();
      result.matched++;
      // Throttle to respect Square rate-limits
      await new Promise(res => setTimeout(res, 200));
    } catch (err) {
      result.errors++;
      result.error_detail.push({ send_id: r.id, error: err.message?.slice(0, 200) });
    }
  }
  return jsonResponse({ mode: 'live', total_targeted: targets.length, ...result });
}

// C.6 — Reminder SMS endpoint for wave customers approaching expiration.
// Fires only for rows where reward is still issued (not redeemed, not expired, not deleted).
// Uses a stronger 7-day fatigue guard (vs the default 48h in sendSwellSMS) because reminder
// is non-urgent: better to lose a few to fatigue than over-message customers who just got SMS.
// Re-issue Square loyalty rewards for wave customers whose initial mint silently failed.
// Phase D.6 — May 11 audit found 129/271 wave customers have no Square reward despite
// the SMS being sent. This endpoint:
//   1. SELECT wave-sent rows where loyalty_reward_id IS NULL
//   2. For each: call issueLoyaltyReward with a FRESH idempotency key (timestamped) to
//      bypass Square's idempotency cache (which would return a non-existent or wrong reward)
//   3. Update the row with new reward_id + account_id
//   NO new SMS is sent — these customers already got their apology.
// Throttled at 2s/customer to respect Square loyalty rate limits.
// ═══════════════════════════════════════════════════════════════════
// CATERING REACTIVATION 2026 — campaign for past catering customers
// ═══════════════════════════════════════════════════════════════════
//
// Mechanism: send SMS with magic link `dangerouspretzel.com/v2/catering?promo=<token>`.
// Customer clicks → catering page → catering-checkout worker validates token via
// /retail/catering-reactivation/redeem-token → if valid, $25 discount line attached
// to Square Payment Link order. Single-use enforced by used_at column.
//
// Token format: <random16>.<hmac_sha256(random + customer_id + expires_at, secret)>
// The secret lives in env.CATERING_PROMO_SECRET (worker var). HMAC verification
// happens server-side at redeem time. Tokens are also persisted in
// catering_promo_tokens for replay protection + audit.

const CATERING_CAMPAIGN_ID = 'catering_reactivation_2026';
const CATERING_DISCOUNT_CENTS = 2500;
const CATERING_EXPIRY_DAYS = 30;

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function mintCateringPromoToken(env, { customer_id, customer_phone, customer_email }) {
  const secret = env.CATERING_PROMO_SECRET || 'fallback-dev-only';
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const expires_at = new Date(Date.now() + CATERING_EXPIRY_DAYS * 86400000).toISOString();
  const payload = `${random}.${customer_id}.${expires_at}`;
  const sig = await hmacSha256Hex(secret, payload);
  const token = `${random}.${sig.slice(0, 24)}`;
  await env.DB.prepare(`
    INSERT INTO catering_promo_tokens (token, campaign_id, customer_id, customer_phone, customer_email, discount_cents, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(token, CATERING_CAMPAIGN_ID, customer_id, customer_phone || null, customer_email || null, CATERING_DISCOUNT_CENTS, expires_at).run();
  return { token, expires_at };
}

// Called by the dpc-catering-checkout worker before generating a Payment Link.
// Returns { valid, discount_cents, discount_name, customer_id, reason } so the
// catering worker can decide whether to attach the discount.
async function redeemCateringToken(request, env) {
  const body = await request.json().catch(() => ({}));
  const { token, customer_phone, customer_email } = body;
  if (!token) return jsonResponse({ valid: false, reason: 'no_token' });
  const row = await env.DB.prepare(`
    SELECT * FROM catering_promo_tokens WHERE token = ?
  `).bind(token).first();
  if (!row) return jsonResponse({ valid: false, reason: 'token_not_found' });
  if (row.used_at) return jsonResponse({ valid: false, reason: 'already_redeemed', used_at: row.used_at });
  if (new Date(row.expires_at) < new Date()) return jsonResponse({ valid: false, reason: 'expired', expires_at: row.expires_at });
  // HMAC re-verify
  const secret = env.CATERING_PROMO_SECRET || 'fallback-dev-only';
  const [random, providedSig] = token.split('.');
  if (!random || !providedSig) return jsonResponse({ valid: false, reason: 'malformed_token' });
  const expectedSig = (await hmacSha256Hex(secret, `${random}.${row.customer_id}.${row.expires_at}`)).slice(0, 24);
  if (expectedSig !== providedSig) return jsonResponse({ valid: false, reason: 'invalid_signature' });
  // Mark used. Best-effort — the catering worker will eventually attach the discount
  // to a Payment Link order. We don't have the order_id at this moment but we'll
  // backfill via the order webhook (square-sync-worker) when the order completes.
  await env.DB.prepare(`UPDATE catering_promo_tokens SET used_at = datetime('now') WHERE token = ?`).bind(token).run();
  return jsonResponse({
    valid: true,
    discount_cents: row.discount_cents,
    discount_name: 'Catering Reactivation',
    customer_id: row.customer_id,
  });
}

// Daily fire / on-demand fire. Pulls cohort, dedups, mints tokens, sends SMS.
async function fireCateringReactivation(request, env, url) {
  const dryRun = url.searchParams.get('dry_run') === '1';
  const limitOverride = parseInt(url.searchParams.get('limit') || '0');
  const dailyLimit = limitOverride > 0 ? limitOverride : 18;

  // Pull dedup'd cohort minus already-sent (idempotent on customer_id + campaign_id)
  const cohort = await env.DB.prepare(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(phone, 'e:'||email)
        ORDER BY CASE cohort_source
          WHEN 'retail_signal' THEN 1
          WHEN 'abandoned_draft' THEN 2
          WHEN 'crossover_lead' THEN 3
        END, ltv DESC NULLS LAST
      ) as rn
      FROM catering_reactivation_cohort_v1
    )
    SELECT customer_id, name, phone, email, cohort_source, ltv, avg_order_value
    FROM ranked
    WHERE rn = 1
      AND NOT EXISTS (
        SELECT 1 FROM retail_campaign_sends rcs
        WHERE rcs.campaign_id = ?
          AND rcs.customer_id = ranked.customer_id
          AND rcs.variant_id = 'catering_reactivation_v1'
      )
    ORDER BY
      CASE cohort_source
        WHEN 'abandoned_draft' THEN 1
        WHEN 'retail_signal' THEN 2
        WHEN 'crossover_lead' THEN 3
      END,
      ltv DESC NULLS LAST
    LIMIT ?
  `).bind(CATERING_CAMPAIGN_ID, dailyLimit).all().catch(() => ({ results: [] }));

  const targets = cohort.results || [];

  if (dryRun) {
    return jsonResponse({
      mode: 'dry_run',
      total_targeted: targets.length,
      by_cohort: targets.reduce((acc, r) => { acc[r.cohort_source] = (acc[r.cohort_source] || 0) + 1; return acc; }, {}),
      sample: targets.slice(0, 5).map(r => ({
        customer_id: r.customer_id,
        name: r.name,
        phone: r.phone ? r.phone.slice(0, 3) + '*****' + r.phone.slice(-4) : null,
        email: r.email,
        cohort_source: r.cohort_source,
        ltv: r.ltv,
      })),
    });
  }

  const TIME_BUDGET_MS = 10 * 60 * 1000;
  const t0 = Date.now();
  const result = { sent: 0, errors: 0, skipped_no_contact: 0, errors_detail: [] };

  for (const r of targets) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      result.time_budget_exhausted = true;
      break;
    }
    if (!r.phone) { result.skipped_no_contact++; continue; }

    try {
      // Mint signed token
      const { token, expires_at } = await mintCateringPromoToken(env, {
        customer_id: r.customer_id,
        customer_phone: r.phone,
        customer_email: r.email,
      });

      // Render SMS (variant by cohort source)
      const firstName = ((r.name || 'friend').trim().split(/\s+/)[0] || 'friend');
      const fn = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
      const expDate = new Date(expires_at);
      const expShort = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][expDate.getDay()]} ${expDate.getMonth()+1}/${expDate.getDate()}`;
      const magicLink = `dangerouspretzel.com/v2/catering.html?promo=${token}`;

      let sms;
      if (r.cohort_source === 'abandoned_draft') {
        sms = `${fn}, Dangerous Pretzel — noticed you started a catering order. $25 off when you finish it thru ${expShort}: ${magicLink}. Reply STOP.`;
      } else if (r.cohort_source === 'retail_signal') {
        sms = `Hey ${fn}, Dangerous Pretzel — self-serve catering ordering is live (pickup or delivery). $25 off your first online order thru ${expShort}: ${magicLink}. Reply STOP.`;
      } else {
        sms = `${fn} — Drew at Dangerous Pretzel. Catering is now self-serve online. $25 off your first order thru ${expShort}: ${magicLink}. Reply STOP.`;
      }

      // Length guardrail
      if (sms.length > 160) {
        // Fallback shorter copy
        sms = `${fn}, Dangerous Pretzel — $25 off catering thru ${expShort}: ${magicLink}. Reply STOP.`;
      }

      const sendResult = await sendSwellSMS(r.phone, sms, env, { caller: 'catering_reactivation_v1' });
      const ok = sendResult?.success === true;
      const sendId = crypto.randomUUID();

      await env.DB.prepare(`
        INSERT INTO retail_campaign_sends (
          id, campaign_id, customer_id, variant_id, message_text,
          sent_at, outcome, expires_at
        ) VALUES (?, ?, ?, 'catering_reactivation_v1', ?, datetime('now'), ?, ?)
      `).bind(
        sendId, CATERING_CAMPAIGN_ID, r.customer_id, sms,
        ok ? 'sent' : 'failed', expires_at.slice(0, 10),
      ).run().catch(() => {});

      if (ok) result.sent++;
      else {
        result.errors++;
        result.errors_detail.push({ customer_id: r.customer_id, error: `sms_${sendResult?.error || 'unknown'}` });
      }

      // Throttle: 3s between sends to avoid Swell rate-limit + 30d cap dangers
      await new Promise(res => setTimeout(res, 3000));
    } catch (err) {
      result.errors++;
      result.errors_detail.push({ customer_id: r.customer_id, error: (err.message || '').slice(0, 200) });
    }
  }

  return jsonResponse({ mode: 'live', total_targeted: targets.length, ...result });
}

async function cateringReactivationStatus(env) {
  const sent = await env.DB.prepare(`
    SELECT outcome, COUNT(*) cnt FROM retail_campaign_sends
    WHERE campaign_id = ? AND variant_id = 'catering_reactivation_v1'
    GROUP BY outcome
  `).bind(CATERING_CAMPAIGN_ID).all().catch(() => ({ results: [] }));
  const tokens = await env.DB.prepare(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) redeemed,
      SUM(CASE WHEN used_at IS NULL AND expires_at < datetime('now') THEN 1 ELSE 0 END) expired_unused
    FROM catering_promo_tokens
    WHERE campaign_id = ?
  `).bind(CATERING_CAMPAIGN_ID).first().catch(() => ({}));
  const remaining = await env.DB.prepare(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(phone, 'e:'||email)
        ORDER BY CASE cohort_source WHEN 'retail_signal' THEN 1 WHEN 'abandoned_draft' THEN 2 ELSE 3 END
      ) as rn FROM catering_reactivation_cohort_v1
    )
    SELECT COUNT(*) cnt FROM ranked
    WHERE rn = 1
      AND NOT EXISTS (
        SELECT 1 FROM retail_campaign_sends rcs
        WHERE rcs.campaign_id = ? AND rcs.customer_id = ranked.customer_id AND rcs.variant_id = 'catering_reactivation_v1'
      )
  `).bind(CATERING_CAMPAIGN_ID).first().catch(() => ({ cnt: 0 }));
  return jsonResponse({
    sent_breakdown: sent.results,
    tokens,
    remaining_to_send: remaining.cnt,
  });
}

async function reissueUnmatchedWaveRewards(request, env, url) {
  const dryRun = url.searchParams.get('dry_run') === '1';
  const limit = parseInt(url.searchParams.get('limit') || '200');
  // Variant filter: 'repair_resend_v1' (default — original wave) OR 'any' to catch all
  // unmatched sends regardless of variant. Used for the 2026-05-13 Welcome-trigger bug
  // where drip_step_0 enrollments via the queue path silently skipped the loyalty mint.
  const variantFilter = url.searchParams.get('variant') || 'repair_resend_v1';
  const variantClause = variantFilter === 'any' ? "rcs.variant_id IS NOT NULL" : "rcs.variant_id = ?";
  const binds = variantFilter === 'any' ? [limit] : [variantFilter, limit];

  const rows = await env.DB.prepare(`
    SELECT rcs.id, rcs.campaign_id, rcs.customer_id, rcs.sent_at, rcs.variant_id,
           rc.normalized_phone, rc.phone,
           rcg.loyalty_tier_id, rcg.loyalty_amount_cents, rcg.name as campaign_name
    FROM retail_campaign_sends rcs
    JOIN retail_customers rc ON rc.id = rcs.customer_id
    LEFT JOIN retail_campaigns rcg ON rcg.id = rcs.campaign_id
    WHERE ${variantClause}
      AND rcs.outcome IN ('sent','delivered')
      AND rcs.loyalty_reward_id IS NULL
      AND (rc.normalized_phone IS NOT NULL OR rc.phone IS NOT NULL)
      AND rcg.loyalty_tier_id IS NOT NULL
    ORDER BY rcs.sent_at
    LIMIT ?
  `).bind(...binds).all().catch(() => ({ results: [] }));
  const targets = rows.results || [];

  if (dryRun) {
    return jsonResponse({
      mode: 'dry_run',
      total_to_reissue: targets.length,
      sample: targets.slice(0, 5).map(r => ({ customer_id: r.customer_id, campaign: r.campaign_name, amount_cents: r.loyalty_amount_cents })),
    });
  }

  const TIME_BUDGET_MS = 12 * 60 * 1000;
  const t0 = Date.now();
  const result = { reissued: 0, errors: 0, no_tier: 0, no_phone: 0, errors_detail: [] };
  for (const r of targets) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      result.time_budget_exhausted = true;
      result.processed = result.reissued + result.errors + result.no_tier + result.no_phone;
      result.remaining = targets.length - result.processed;
      break;
    }
    const phone = r.normalized_phone || r.phone;
    if (!phone) { result.no_phone++; continue; }
    if (!r.loyalty_tier_id) { result.no_tier++; continue; }
    try {
      // Fresh idempotency key (epoch ms) so Square doesn't return a stale/missing reward
      const reward = await issueLoyaltyReward(env, {
        phone,
        tierId: r.loyalty_tier_id,
        idempotencySuffix: `reissue_${r.customer_id}_${Date.now()}`,
      });
      if (reward.error) {
        result.errors++;
        result.errors_detail.push({ customer_id: r.customer_id, error: reward.error.slice(0, 200) });
        continue;
      }
      await env.DB.prepare(
        "UPDATE retail_campaign_sends SET loyalty_reward_id = ?, loyalty_account_id = ? WHERE id = ?"
      ).bind(reward.reward_id, reward.loyalty_account_id, r.id).run();
      result.reissued++;
      // Throttle 2s — Square Loyalty rate limit + give existing account search ample budget
      await new Promise(res => setTimeout(res, 2000));
    } catch (err) {
      result.errors++;
      result.errors_detail.push({ customer_id: r.customer_id, error: (err.message || '').slice(0, 200) });
    }
  }
  return jsonResponse({ mode: 'live', total_targeted: targets.length, ...result });
}

async function runRepairResendReminder(request, env, url) {
  const dryRun = url.searchParams.get('dry_run') === '1';
  const minDaysSinceSend = parseInt(url.searchParams.get('min_days') || '20');
  const recipients = await env.DB.prepare(`
    SELECT rcs.id as send_id, rcs.campaign_id, rcs.customer_id, rcs.expires_at,
           rc.first_name, rc.normalized_phone, rc.phone,
           rcg.loyalty_amount_cents, rcg.name as campaign_name
    FROM retail_campaign_sends rcs
    JOIN retail_customers rc ON rc.id = rcs.customer_id
    LEFT JOIN retail_campaigns rcg ON rcg.id = rcs.campaign_id
    LEFT JOIN sms_suppressions ss ON ss.phone = rc.normalized_phone
    WHERE rcs.variant_id = 'repair_resend_v1'
      AND rcs.outcome = 'sent'
      AND rcs.returned_at IS NULL
      AND rcs.loyalty_reward_id IS NOT NULL
      AND rcs.expires_at > date('now')
      AND julianday('now') - julianday(rcs.sent_at) >= ?
      AND rc.sms_eligible = 1
      AND ss.phone IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM retail_campaign_sends rcs2
        WHERE rcs2.customer_id = rcs.customer_id
          AND rcs2.campaign_id = rcs.campaign_id
          AND rcs2.variant_id = 'repair_resend_reminder_v1'
      )
    ORDER BY rcs.expires_at, rcs.customer_id
  `).bind(minDaysSinceSend).all().catch(() => ({ results: [] }));
  const targeted = recipients.results || [];

  const renderReminder = (r) => {
    const rawFirst = (r.first_name || 'friend').trim().split(/\s+/)[0];
    const firstName = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase();
    const amount = '$' + Math.round((r.loyalty_amount_cents || 500) / 100);
    // Format expires_at "Mon 6/10"
    const exp = new Date((r.expires_at || '') + 'T00:00:00Z');
    const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][exp.getUTCDay()];
    const expShort = `${dayName} ${exp.getUTCMonth()+1}/${exp.getUTCDate()}`;
    return `Hey ${firstName}, Dangerous Pretzel — your ${amount} is still loaded, expires ${expShort}. Phone at checkout. Reply STOP.`;
  };

  if (dryRun) {
    const sample = targeted.slice(0, 3).map(r => ({ first_name: r.first_name, expires_at: r.expires_at, sms: renderReminder(r), len: renderReminder(r).length }));
    return jsonResponse({ mode: 'dry_run', total_targeted: targeted.length, sample });
  }

  const TIME_BUDGET_MS = 12 * 60 * 1000;
  const t0 = Date.now();
  const result = { sent: 0, errors: 0, skipped_fatigue: 0, errors_detail: [] };
  for (const r of targeted) {
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      result.time_budget_exhausted = true;
      result.processed = result.sent + result.errors + result.skipped_fatigue;
      result.remaining = targeted.length - result.processed;
      break;
    }
    // 7d fatigue guard for reminder — non-urgent, OK to lose a few
    const recentAny = await env.DB.prepare(`
      SELECT 1 FROM retail_campaign_sends rcs
      JOIN retail_customers rc ON rc.id = rcs.customer_id
      WHERE rc.normalized_phone = ?
        AND rcs.sent_at >= datetime('now','-7 days')
        AND rcs.outcome IN ('delivered','sent')
      LIMIT 1
    `).bind(r.normalized_phone).first().catch(() => null);
    if (recentAny) { result.skipped_fatigue++; continue; }
    const sms = renderReminder(r);
    const sendResult = await sendSwellSMS(r.normalized_phone || r.phone, sms, env, { caller: 'repair_resend_reminder_v1' });
    const ok = sendResult?.success === true;
    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, message_text, sent_at, outcome, expires_at)
      VALUES (?, ?, ?, 'repair_resend_reminder_v1', ?, datetime('now'), ?, ?)
    `).bind(crypto.randomUUID(), r.campaign_id, r.customer_id, sms, ok ? 'sent' : 'failed', r.expires_at).run().catch(() => {});
    if (ok) result.sent++;
    else { result.errors++; result.errors_detail.push({ customer_id: r.customer_id, error: (sendResult?.error || 'unknown').slice(0, 200) }); }
    await new Promise(res => setTimeout(res, 1500)); // throttle
  }
  return jsonResponse({ mode: 'live', total_targeted: targeted.length, ...result });
}

function renderRepairSms(recipient, amountStr = '$5') {
  // Some customer rows have full names in first_name (e.g. "Eric Smith"). Split + capitalize.
  const rawFirst = (recipient.first_name || 'friend').trim().split(/\s+/)[0];
  const firstName = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase();
  // Brand identification ("Dangerous Pretzel") is REQUIRED — sendSwellSMS rejects messages
  // without it. Sub-160 chars worst case (Welcome=$8, Gold=$10).
  if (recipient.bucket === 'came_back_no_redeem') {
    return `Hey ${firstName}, Dangerous Pretzel here — you came in but our code didn't apply, sorry. ` +
      `${amountStr} now on your phone for next visit. Enter # at checkout. Reply STOP.`;
  }
  return `Hey ${firstName}, Dangerous Pretzel here — that last code didn't work online, sorry. ` +
    `${amountStr} now on your phone for next visit. Enter # at checkout. Reply STOP.`;
}

// Cache the Square Loyalty program's reward tiers in KV for 5 minutes. Avoids hammering
// Square's /loyalty/programs/main on every cron-fired send (would burn rate-limit and
// add ~150ms per customer). Cache key: 'loyalty_tiers_v1'. Invalidate by deleting KV.
async function getCachedLoyaltyTiers(env) {
  if (env.KV) {
    try {
      const cached = await env.KV.get('loyalty_tiers_v1', { type: 'json' });
      if (cached && cached._cached_at && (Date.now() - cached._cached_at) < 300000) {
        return cached.tiers;
      }
    } catch {}
  }
  const progResp = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
    headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17' },
  });
  const progData = await progResp.json().catch(() => ({}));
  const tiers = (progData.program?.reward_tiers || []).map(t => ({
    id: t.id,
    points: t.points,
    name: t.name,
    amount_cents: t.definition?.fixed_discount_money?.amount || null,
  }));
  if (env.KV && tiers.length) {
    try { await env.KV.put('loyalty_tiers_v1', JSON.stringify({ _cached_at: Date.now(), tiers }), { expirationTtl: 600 }); } catch {}
  }
  return tiers;
}

// Map an amount in cents to the loyalty tier ID that matches. Returns null if no
// exact match exists (caller decides whether to skip the customer or downgrade).
// Used by processConditionCampaigns + future per-campaign mint paths to replace
// createSquareDiscount() (the old Catalog-DISCOUNT mechanism that wasn't customer-typeable).
async function tierIdForAmount(env, amountCents) {
  const tiers = await getCachedLoyaltyTiers(env);
  const exact = tiers.find(t => t.amount_cents === amountCents);
  return exact ? exact.id : null;
}

// Migration constant — referenced by agent_notes + dashboard pre/post split.
// Date of the Catalog DISCOUNT → Square Loyalty Rewards mechanism switchover.
const LOYALTY_MIGRATION_DATE = '2026-05-11';

// Issue a Square Loyalty reward to a customer. Auto-enrolls if no loyalty account
// exists for their phone. Adds points and creates the reward in one shot.
//
// Returns: { reward_id, loyalty_account_id, points_added, tier_name } or { error }
//
// Mechanism: customer enters their phone at Square Online or Register checkout →
// reward auto-applies. No code typing required.
async function issueLoyaltyReward(env, { phone, tierId = null, idempotencySuffix = '' }) {
  if (!phone) return { error: 'phone required' };
  // Normalize to E.164
  const cleaned = String(phone).replace(/[^\d+]/g, '');
  const e164 = cleaned.startsWith('+') ? cleaned : (cleaned.length === 10 ? `+1${cleaned}` : `+${cleaned}`);

  try {
    // Look up program to get default tier id if not specified
    if (!tierId) {
      const progResp = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
        headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17' },
      });
      const progData = await progResp.json();
      tierId = progData.program?.reward_tiers?.[0]?.id;
      if (!tierId) return { error: 'no reward tier available' };
    }

    // Find or create loyalty account for the phone
    const searchResp = await fetch('https://connect.squareup.com/v2/loyalty/accounts/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { mappings: [{ phone_number: e164 }] } }),
    });
    const searchData = await searchResp.json();
    let loyaltyAccountId = searchData.loyalty_accounts?.[0]?.id;
    let createdNew = false;

    if (!loyaltyAccountId) {
      // Auto-enroll
      const programResp = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
        headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17' },
      });
      const programData = await programResp.json();
      const programId = programData.program?.id;
      if (!programId) return { error: 'no loyalty program' };

      const createResp = await fetch('https://connect.squareup.com/v2/loyalty/accounts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-10-17',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: `loyalty_enroll_${e164}_${idempotencySuffix || ''}`,
          loyalty_account: { program_id: programId, mapping: { phone_number: e164 } },
        }),
      });
      const createData = await createResp.json();
      loyaltyAccountId = createData.loyalty_account?.id;
      createdNew = true;
      if (!loyaltyAccountId) return { error: `could not create loyalty account: ${JSON.stringify(createData.errors || createData)}` };
    }

    // Add the points needed for the tier (uses points = tier.points)
    // First get the tier's required points
    const programResp2 = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
      headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17' },
    });
    const programData2 = await programResp2.json();
    const tier = (programData2.program?.reward_tiers || []).find(t => t.id === tierId);
    if (!tier) return { error: `tier ${tierId} not found` };

    const adjustResp = await fetch(`https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}/adjust`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `loyalty_adjust_${loyaltyAccountId}_${idempotencySuffix || Date.now()}`,
        adjust_points: { points: tier.points, reason: 'Pretzel OS campaign reward' },
      }),
    });
    const adjustData = await adjustResp.json();
    if (!adjustResp.ok) return { error: `adjust failed: ${JSON.stringify(adjustData.errors)}` };

    // Create the reward (spends the points)
    const rewardResp = await fetch('https://connect.squareup.com/v2/loyalty/rewards', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `loyalty_reward_${loyaltyAccountId}_${idempotencySuffix || Date.now()}`,
        reward: { loyalty_account_id: loyaltyAccountId, reward_tier_id: tierId },
      }),
    });
    const rewardData = await rewardResp.json();
    if (!rewardResp.ok) return { error: `reward failed: ${JSON.stringify(rewardData.errors)}` };

    return {
      reward_id: rewardData.reward?.id,
      loyalty_account_id: loyaltyAccountId,
      created_new_account: createdNew,
      points_added: tier.points,
      tier_name: tier.name,
      reward_status: rewardData.reward?.status,
      phone_e164: e164,
    };
  } catch (err) {
    return { error: err.message };
  }
}

// Try adding an $8/80pt reward tier to the existing loyalty program.
// Square's loyalty program object supports tier addition via UpdateLoyaltyProgram.
async function tryAddLoyaltyTier(env, url) {
  const amountCents = parseInt(url.searchParams.get('amount_cents') || '800');
  const points = parseInt(url.searchParams.get('points') || '80');
  const name = url.searchParams.get('name') || `$${(amountCents / 100).toFixed(2)} off entire sale`;

  try {
    // Get current program first
    const progResp = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
      headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Square-Version': '2024-10-17' },
    });
    const progData = await progResp.json();
    const program = progData.program;
    if (!program) return jsonResponse({ error: 'no program', body: progData });

    // Build updated tiers list (existing + new). Square requires the full list on update.
    const existingTiers = program.reward_tiers || [];
    if (existingTiers.find(t => t.points === points && t.definition?.fixed_discount_money?.amount === amountCents)) {
      return jsonResponse({ ok: true, message: 'Tier already exists', existing: existingTiers });
    }
    const newTiers = [
      ...existingTiers.map(t => ({
        // Strip server-only fields when echoing back
        id: t.id, name: t.name, points: t.points,
        definition: t.definition,
      })),
      {
        name,
        points,
        definition: {
          scope: 'ORDER',
          discount_type: 'FIXED_AMOUNT',
          fixed_discount_money: { amount: amountCents, currency: 'USD' },
        },
      },
    ];

    const updateResp = await fetch(`https://connect.squareup.com/v2/loyalty/programs/${program.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ program: { reward_tiers: newTiers } }),
    });
    const updateData = await updateResp.json();
    return jsonResponse({
      ok: updateResp.ok,
      status: updateResp.status,
      result: updateData,
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Loyalty Rewards spike — probes Square Loyalty API for programmatic per-customer
// reward issuance that auto-applies at checkout (no code typing required by customer).
//
// Flow being tested:
// 1. List existing loyalty programs + reward tiers
// 2. Try creating a loyalty account for a test customer
// 3. Try adding points to the account so they unlock a reward
// 4. Try creating a reward tied to that account directly
// 5. Return results so we can pick the working path
async function loyaltyMechanismSpike(env, url) {
  const result = { steps: [] };
  try {
    // Step 1: Get loyalty program details + tiers
    const programResp = await fetch('https://connect.squareup.com/v2/loyalty/programs/main', {
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
      },
    });
    const programData = await programResp.json();
    const program = programData.program;
    result.steps.push({
      step: '1_list_program',
      ok: programResp.ok,
      program_id: program?.id,
      reward_tiers: (program?.reward_tiers || []).map(t => ({
        id: t.id, name: t.name, points: t.points,
        discount: t.definition?.fixed_discount_money?.amount || t.definition?.percentage_discount,
      })),
    });
    if (!program?.id) {
      result.error = 'No loyalty program found';
      return jsonResponse(result);
    }

    // Step 2: Find or create a loyalty account for a test phone (Drew's phone).
    // Use test phone from query param or fall back to a known DPC test number.
    const testPhone = url.searchParams.get('phone') || '+18015551212';
    // First search if it already exists
    const searchResp = await fetch('https://connect.squareup.com/v2/loyalty/accounts/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Square-Version': '2024-10-17',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: { mappings: [{ phone_number: testPhone }] } }),
    });
    const searchData = await searchResp.json();
    let loyaltyAccountId = searchData.loyalty_accounts?.[0]?.id;
    result.steps.push({
      step: '2_search_account',
      ok: searchResp.ok,
      found_existing: !!loyaltyAccountId,
      existing_id: loyaltyAccountId,
    });

    // If not found, create it.
    if (!loyaltyAccountId) {
      const createResp = await fetch('https://connect.squareup.com/v2/loyalty/accounts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-10-17',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: `loyalty_spike_${testPhone}`,
          loyalty_account: {
            program_id: program.id,
            mapping: { phone_number: testPhone },
          },
        }),
      });
      const createData = await createResp.json();
      loyaltyAccountId = createData.loyalty_account?.id;
      result.steps.push({
        step: '3_create_account',
        ok: createResp.ok,
        new_id: loyaltyAccountId,
        error: !createResp.ok ? createData : null,
      });
    }

    // Step 4: Try adjusting points (give them enough to unlock a reward).
    if (loyaltyAccountId && program.reward_tiers?.length > 0) {
      const tier = program.reward_tiers[0]; // first tier ($5 off / 50 pts in our case)
      const adjustResp = await fetch(`https://connect.squareup.com/v2/loyalty/accounts/${loyaltyAccountId}/adjust`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-10-17',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: `loyalty_adjust_spike_${Date.now()}`,
          adjust_points: {
            points: tier.points,
            reason: 'Pretzel OS test reward issuance',
          },
        }),
      });
      const adjustData = await adjustResp.json();
      result.steps.push({
        step: '4_adjust_points',
        ok: adjustResp.ok,
        added_points: tier.points,
        for_tier: tier.name,
        error: !adjustResp.ok ? adjustData : null,
      });

      // Step 5: Try creating a reward directly (spends the points → reward redeemable at checkout)
      const rewardResp = await fetch('https://connect.squareup.com/v2/loyalty/rewards', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Square-Version': '2024-10-17',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: `loyalty_reward_spike_${Date.now()}`,
          reward: {
            loyalty_account_id: loyaltyAccountId,
            reward_tier_id: tier.id,
          },
        }),
      });
      const rewardData = await rewardResp.json();
      result.steps.push({
        step: '5_create_reward',
        ok: rewardResp.ok,
        reward_id: rewardData.reward?.id,
        reward_status: rewardData.reward?.status,
        error: !rewardResp.ok ? rewardData : null,
      });

      result.summary = rewardResp.ok
        ? `SUCCESS — Reward issued to ${testPhone}. Customer enters ${testPhone} at Square Online or Register checkout → ${tier.name} auto-applies. Mechanism viable for programmatic issuance.`
        : `BLOCKED at step 5 — ${rewardData.errors?.[0]?.detail || 'unknown'}`;
    }
  } catch (err) {
    result.error = err.message;
  }
  return jsonResponse(result);
}

// ── Code-pool management (3b-rotation mechanism) ──────────────────────
// Drew creates customer-typeable Discount Codes in Square Dashboard, then imports
// them here. Send path draws from the pool, marks assigned/redeemed.
//
// Import format: POST /retail/code-pool/import with JSON body:
// {
//   "campaign_id": "9143a900-...",
//   "amount_cents": 800,
//   "valid_days": 7,
//   "codes": ["WEL001", "WEL002", "WEL003", ...]
// }
async function importCodePool(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !body.campaign_id || !body.codes || !Array.isArray(body.codes)) {
    return jsonResponse({ error: 'Required: { campaign_id, amount_cents, valid_days, codes: [] }' }, 400);
  }
  const amount = body.amount_cents || 800;
  const validDays = body.valid_days || 7;
  const validUntil = new Date(Date.now() + validDays * 86400000).toISOString().slice(0, 10);

  // Verify the campaign exists
  const camp = await env.DB.prepare('SELECT id, name FROM retail_campaigns WHERE id = ?').bind(body.campaign_id).first();
  if (!camp) return jsonResponse({ error: 'Campaign not found' }, 404);

  let inserted = 0, duplicates = 0, errors = [];
  for (const codeRaw of body.codes) {
    const code = String(codeRaw).trim().toUpperCase();
    if (!code || code.length < 3) { errors.push({ code: codeRaw, reason: 'empty or too short' }); continue; }
    try {
      const id = crypto.randomUUID();
      const r = await env.DB.prepare(`
        INSERT INTO discount_code_pool (id, campaign_id, code, amount_cents, status, valid_until)
        VALUES (?, ?, ?, ?, 'available', ?)
        ON CONFLICT(code) DO NOTHING
      `).bind(id, body.campaign_id, code, amount, validUntil).run();
      if (r.meta?.changes > 0) inserted++;
      else duplicates++;
    } catch (e) {
      errors.push({ code, reason: e.message });
    }
  }
  return jsonResponse({
    campaign_id: body.campaign_id,
    campaign_name: camp.name,
    inserted, duplicates, errors,
    valid_until: validUntil,
  });
}

// GET /retail/code-pool/status — pool levels + low-pool warnings
async function getCodePoolStatus(env) {
  const rows = await env.DB.prepare(`
    SELECT rc.id, rc.name, rc.status as campaign_status,
      COUNT(dcp.id) FILTER (WHERE dcp.status = 'available') as available,
      COUNT(dcp.id) FILTER (WHERE dcp.status = 'assigned') as assigned,
      COUNT(dcp.id) FILTER (WHERE dcp.status = 'redeemed') as redeemed,
      COUNT(dcp.id) FILTER (WHERE dcp.status = 'expired') as expired,
      COUNT(dcp.id) as total
    FROM retail_campaigns rc
    LEFT JOIN discount_code_pool dcp ON dcp.campaign_id = rc.id
    WHERE rc.status IN ('active','paused')
    GROUP BY rc.id
    ORDER BY available ASC
  `).all().catch(() => ({ results: [] }));

  const pools = (rows.results || []).map(r => ({
    ...r,
    low_pool: r.campaign_status === 'active' && r.available < 10,
  }));
  const lowCount = pools.filter(p => p.low_pool).length;

  return jsonResponse({
    pools,
    low_pool_alert: lowCount > 0
      ? `${lowCount} active campaign(s) have <10 available codes. Drew should top up the pool.`
      : null,
  });
}

// Draw the next available code for a customer. Atomic — marks assigned in one UPDATE.
// Returns null if pool is empty.
async function drawCodeFromPool(env, campaignId, customerId, sendId) {
  // Find the oldest available code (FIFO-ish; stable across re-runs).
  const next = await env.DB.prepare(`
    SELECT id, code, amount_cents, valid_until FROM discount_code_pool
    WHERE campaign_id = ? AND status = 'available'
    ORDER BY created_at ASC LIMIT 1
  `).bind(campaignId).first();
  if (!next) return null;

  // Atomic claim — only assign if still available.
  const claim = await env.DB.prepare(`
    UPDATE discount_code_pool
    SET status='assigned', assigned_to_customer_id=?, assigned_to_send_id=?, assigned_at=datetime('now')
    WHERE id=? AND status='available'
  `).bind(customerId, sendId || null, next.id).run();
  if (!claim.meta?.changes) return null; // raced; caller can retry

  return { id: next.id, code: next.code, amount_cents: next.amount_cents, valid_until: next.valid_until };
}

// Cleanup all SPIKE* test objects to prevent any auto-applying rules from leaking revenue.
async function cleanupSpikeObjects(env, url) {
  const results = { deleted: [], errors: [] };
  try {
    // Search for all DISCOUNT, PRICING_RULE, PRODUCT_SET objects whose name starts with SPIKE.
    for (const objectType of ['PRICING_RULE', 'DISCOUNT', 'PRODUCT_SET']) {
      let cursor = null;
      do {
        const body = { object_types: [objectType], limit: 100 };
        if (cursor) body.cursor = cursor;
        const resp = await squareApiPost('/catalog/search', body, env);
        cursor = resp.cursor || null;
        for (const obj of (resp.objects || [])) {
          const name = obj.discount_data?.name || obj.pricing_rule_data?.name || obj.product_set_data?.name || '';
          if (!name.startsWith('SPIKE')) continue;
          try {
            await squareApiDelete(`/catalog/object/${obj.id}`, env);
            results.deleted.push({ type: objectType, id: obj.id, name });
          } catch (e) {
            results.errors.push({ id: obj.id, error: e.message });
          }
        }
      } while (cursor);
    }
  } catch (err) {
    results.errors.push({ phase: 'search', error: err.message });
  }
  return jsonResponse(results);
}

// ── B.0 Phase: Customer-typeable-code mechanism spike ──────────────
// Tests 3 candidates for an API mechanism that gives us per-customer-unique
// codes typeable by customers in Square Online + Register.
//
// Usage: POST /retail/typeable-code-spike?try=pricing_rule|discount_flags|coupons_api&suffix=TEST1
// Returns: { code, square_response, instructions_for_drew }
//
// Drew tests each returned code in BOTH Square Online (web cart) and Square Register
// (cashier types it). Locks the winner in the plan file.
async function typeableCodeSpike(env, url) {
  const tryWhich = url.searchParams.get('try') || 'pricing_rule';
  const suffix = (url.searchParams.get('suffix') || 'TEST1').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const codePrefix = `SPIKE${suffix}`;
  const code = `${codePrefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  const result = {
    candidate: tryWhich,
    code,
    timestamp: new Date().toISOString(),
    square_response: null,
    error: null,
    instructions_for_drew:
      `Test the code "${code}" in BOTH:\n` +
      `  1. Square Online: add an item to cart, paste "${code}" into the "Redeem a coupon" field, hit Redeem.\n` +
      `  2. Square Register POS app: at checkout, type "${code}" in the discount/coupon field.\n` +
      `Both must apply $8 off. Report results.`,
  };

  try {
    if (tryWhich === 'pricing_rule') {
      // Candidate 1 — DISCOUNT + PRODUCT_SET (all items) + PRICING_RULE.
      // PRICING_RULE requires `pricing_match_product` (a PRODUCT_SET ID), so we create
      // an all-items product set first.
      const batchBody = {
        idempotency_key: `spike_pr_${code}`,
        batches: [{
          objects: [
            {
              type: 'DISCOUNT',
              id: `#${code}_DISC`,
              discount_data: {
                name: code,
                discount_type: 'FIXED_AMOUNT',
                amount_money: { amount: 800, currency: 'USD' },
              },
            },
            {
              type: 'PRODUCT_SET',
              id: `#${code}_PSET`,
              product_set_data: {
                name: `${code} all items`,
                all_products: true,
              },
            },
            {
              type: 'PRICING_RULE',
              id: `#${code}_RULE`,
              pricing_rule_data: {
                name: code,
                discount_id: `#${code}_DISC`,
                match_products_id: `#${code}_PSET`,
              },
            },
          ],
        }],
      };
      result.square_response = await squareApiPost('/catalog/batch-upsert', batchBody, env);
    } else if (tryWhich === 'discount_flags') {
      // Candidate 2 — DISCOUNT with all customer-redemption flags set true.
      const body = {
        idempotency_key: `spike_df_${code}`,
        object: {
          type: 'DISCOUNT',
          id: `#${code}`,
          present_at_all_locations: true,
          discount_data: {
            name: code,
            discount_type: 'FIXED_AMOUNT',
            amount_money: { amount: 800, currency: 'USD' },
            label_color: '4ade80',
            modify_tax_basis: 'MODIFY_TAX_BASIS',
            // Speculative — not all of these may be valid fields, Square will tell us.
            maximum_amount_money: { amount: 800, currency: 'USD' },
          },
        },
      };
      result.square_response = await squareApiPost('/catalog/object', body, env);
    } else if (tryWhich === 'coupons_api') {
      // Candidate 3 — probe undocumented or differently-namespaced endpoints.
      // First try a likely path; if 404 the response will tell us.
      try {
        const resp = await fetch('https://connect.squareup.com/v2/online-checkout/coupons', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'Square-Version': '2024-10-17',
          },
          body: JSON.stringify({
            idempotency_key: `spike_ca_${code}`,
            coupon: { code, discount_money: { amount: 800, currency: 'USD' } },
          }),
        });
        result.square_response = { status: resp.status, body: await resp.text() };
      } catch (e) {
        result.error = `coupons_api probe error: ${e.message}`;
      }
    } else {
      result.error = `Unknown candidate: ${tryWhich}. Use pricing_rule | discount_flags | coupons_api`;
    }
  } catch (err) {
    result.error = err.message;
  }

  return jsonResponse(result);
}

// ── V2 Phase 2 endpoints ─────────────────────────────────────────────

// GET /retail/cohort-comparison — last 6 months of first-timer cohorts.
// Each cohort shows retention at 30/60/90/180-day windows, but only if the window
// has elapsed (otherwise null/—). Drew's V2 spec called out that the existing table
// shows stub values for windows that haven't matured.
async function getCohortComparison(env) {
  // For each of the last 6 months of acquisitions, compute returners at each window.
  const months = await env.DB.prepare(`
    SELECT date(first_visit_date, '-6 hours', 'start of month') as month_start,
           COUNT(*) as first_timers,
           SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners_anytime,
           ROUND(AVG(total_lifetime_value), 0) as avg_ltv
    FROM retail_customers
    WHERE first_visit_date IS NOT NULL
      AND first_visit_date >= date('now', '-6 hours', '-6 months', 'start of month')
    GROUP BY month_start
    ORDER BY month_start DESC
  `).all().catch(() => ({ results: [] }));

  const today = Date.now();
  const cohorts = (months.results || []).map(m => {
    const monthStart = new Date(m.month_start + 'T00:00:00Z').getTime();
    const ageDays = Math.floor((today - monthStart) / 86400000);
    return {
      month: m.month_start,
      first_timers: m.first_timers,
      returners_anytime: m.returners_anytime,
      retention_anytime_pct: m.first_timers > 0 ? Math.round((m.returners_anytime / m.first_timers) * 1000) / 10 : null,
      avg_ltv: m.avg_ltv || 0,
      age_days: ageDays,
      // Window labels — we only show these for windows that have FULLY elapsed.
      window_30d_measurable: ageDays >= 30,
      window_60d_measurable: ageDays >= 60,
      window_90d_measurable: ageDays >= 90,
      window_180d_measurable: ageDays >= 180,
    };
  });

  return jsonResponse({
    cohorts,
    note: 'Retention windows show null for cohorts that have not aged enough. April first-timers are only measurable at 30d.',
  });
}

// GET /retail/customer-funnel — visit-count distribution + active/at-risk/churned.
async function getCustomerFunnel(env) {
  const r = await env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE visit_count = 1) as one_visit,
      COUNT(*) FILTER (WHERE visit_count BETWEEN 2 AND 3) as two_three,
      COUNT(*) FILTER (WHERE visit_count BETWEEN 4 AND 9) as four_nine,
      COUNT(*) FILTER (WHERE visit_count >= 10) as ten_plus,
      COUNT(*) FILTER (WHERE last_visit_date >= datetime('now','-30 days')) as active_30d,
      COUNT(*) FILTER (WHERE last_visit_date < datetime('now','-30 days') AND last_visit_date >= datetime('now','-90 days')) as at_risk,
      COUNT(*) FILTER (WHERE last_visit_date < datetime('now','-90 days')) as churned
    FROM retail_customers
  `).first().catch(() => null);
  if (!r) return jsonResponse({ error: 'no data' }, 500);
  return jsonResponse({
    total: r.total,
    by_visit_count: {
      one_visit: { count: r.one_visit, pct: pctOf(r.one_visit, r.total) },
      two_three: { count: r.two_three, pct: pctOf(r.two_three, r.total) },
      four_nine: { count: r.four_nine, pct: pctOf(r.four_nine, r.total) },
      ten_plus: { count: r.ten_plus, pct: pctOf(r.ten_plus, r.total) },
    },
    by_recency: { active_30d: r.active_30d, at_risk: r.at_risk, churned: r.churned },
  });
}

function pctOf(num, den) {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
}

// GET /retail/campaigns/performance — ranked working/underperforming/too_new buckets.
async function getCampaignsPerformance(env) {
  const BENCHMARKS = {
    welcome_free_pretzel: { good: 0.15, top: 0.20, poor: 0.05 },
    winback_gold:         { good: 0.06, top: 0.10, poor: 0.02 },
    winback_silver:       { good: 0.04, top: 0.08, poor: 0.015 },
    winback_bronze:       { good: 0.04, top: 0.08, poor: 0.015 },
    winback_platinum:     { good: 0.10, top: 0.15, poor: 0.03 },
    winback_singles:      { good: 0.03, top: 0.06, poor: 0.01 },
    winback_recovery:     { good: 0.02, top: 0.04, poor: 0.005 },
    winback_lastcall:     { good: 0.02, top: 0.04, poor: 0.005 },
    momentum_save:        { good: 0.05, top: 0.08, poor: 0.02 },
    holiday_promo:        { good: 0.03, top: 0.06, poor: 0.005 },
    email_welcome_square: { good: 0.10, top: 0.15, poor: 0.03 },
    email_reactivation_toast: { good: 0.02, top: 0.04, poor: 0.005 },
    email_winback_square: { good: 0.04, top: 0.08, poor: 0.01 },
  };
  const DEFAULT_BENCHMARK = { good: 0.05, top: 0.10, poor: 0.015 };

  // Pre/post-May-11-2026 rate split:
  // - Pre-May-11 sends used Catalog DISCOUNT codes that were NOT customer-typeable online
  //   (silent failures in Square Online's coupon field, codes worked only at FOH counter).
  // - Post-May-11 sends use Loyalty Rewards (phone-at-checkout, works in both flows).
  // Lifetime rate undercounts pre-fix campaigns. UI renders both with a "post-fix" badge.
  // Metrics drift fix (May 19): the cached aggregate fields rc.total_sent / .total_returned
  // / .total_revenue_attributed stopped updating reliably (last full update mid-April per
  // Drew's report — various write paths missed bumping the counter). Switch to LIVE counts
  // from retail_campaign_sends on every fetch. ~50 campaigns × few hundred rows = fast.
  const rows = await env.DB.prepare(`
    SELECT rc.id, rc.name, rc.status, rc.campaign_type, rc.campaign_mode,
      rc.daily_send_limit, rc.created_at, rc.updated_at,
      rc.lifetime_emailed, rc.agent_notes,
      SUM(CASE WHEN rcs.outcome IN ('sent','delivered','returned','expired','redeemed') THEN 1 ELSE 0 END) as lifetime_sent,
      SUM(CASE WHEN rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) as lifetime_returned,
      SUM(CASE WHEN rcs.returned_at IS NOT NULL THEN COALESCE(rcs.return_order_value, 0) ELSE 0 END) as lifetime_revenue,
      SUM(CASE WHEN rcs.sent_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) as sends_30d,
      SUM(CASE WHEN rcs.returned_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) as returners_30d,
      SUM(CASE WHEN rcs.returned_at >= datetime('now','-30 days') THEN COALESCE(rcs.return_order_value, 0) ELSE 0 END) as revenue_30d,
      SUM(CASE WHEN rcs.sent_at < '2026-05-11' AND rcs.outcome IN ('sent','delivered','returned','expired') THEN 1 ELSE 0 END) as sends_pre_may11,
      SUM(CASE WHEN rcs.sent_at < '2026-05-11' AND rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) as returners_pre_may11,
      SUM(CASE WHEN rcs.sent_at >= '2026-05-11' AND rcs.outcome IN ('sent','delivered','returned','expired') THEN 1 ELSE 0 END) as sends_post_may11,
      SUM(CASE WHEN rcs.sent_at >= '2026-05-11' AND rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) as returners_post_may11,
      MAX(rcs.sent_at) as most_recent_send_at
    FROM retail_campaigns rc
    LEFT JOIN retail_campaign_sends rcs ON rcs.campaign_id = rc.id
    WHERE rc.status IN ('active', 'paused', 'draft')
      AND rc.campaign_type NOT IN ('vip_thank_you', 'onboarding')
    GROUP BY rc.id
  `).all().catch(() => ({ results: [] }));

  const now = Date.now();
  const ranked = (rows.results || []).map(c => {
    const totalSent = (c.lifetime_sent || 0) + (c.lifetime_emailed || 0);
    const lifetimeConv = totalSent > 0 ? c.lifetime_returned / totalSent : null;
    const sends30d = c.sends_30d || 0;
    const conv30d = sends30d > 0 ? c.returners_30d / sends30d : null;
    // Use lifetime conv as the bench comparison when 30d is too small to judge.
    const judgeConv = sends30d >= 50 ? conv30d : lifetimeConv;
    const daysActive = c.created_at ? Math.floor((now - new Date(c.created_at + 'Z').getTime()) / 86400000) : 0;

    const bench = BENCHMARKS[c.campaign_type] || DEFAULT_BENCHMARK;
    let bucket;
    let benchLabel;
    if (daysActive < 7 || (totalSent < 20 && sends30d < 20)) {
      bucket = 'too_new';
      benchLabel = 'Too new';
    } else if (judgeConv === null) {
      bucket = 'too_new';
      benchLabel = 'No data';
    } else if (judgeConv >= bench.top) {
      bucket = 'working';
      benchLabel = 'Top quartile';
    } else if (judgeConv >= bench.good) {
      bucket = 'working';
      benchLabel = 'Above benchmark';
    } else if (judgeConv >= bench.poor) {
      bucket = 'normal';
      benchLabel = 'On benchmark';
    } else {
      bucket = 'underperforming';
      benchLabel = 'Below benchmark';
    }
    // Burning audience flag: high send pace + low conversion
    const dailySendPace = c.daily_send_limit || (sends30d / Math.max(daysActive, 1));
    const burning = dailySendPace > 30 && (judgeConv === null || judgeConv < 0.01) && c.status === 'active';
    // Pre/post-May-11 rate split — exposes the silent online-failure undercounting in
    // pre-fix metrics. Renderer shows post_may11 with a "post-fix" badge when both exist.
    const ratePreMay11 = (c.sends_pre_may11 || 0) > 0 ? c.returners_pre_may11 / c.sends_pre_may11 : null;
    const ratePostMay11 = (c.sends_post_may11 || 0) > 0 ? c.returners_post_may11 / c.sends_post_may11 : null;
    const hasMigrationNote = !!c.agent_notes && /MIGRATION 2026-05-11/.test(c.agent_notes);

    return {
      id: c.id, name: c.name, status: c.status, campaign_type: c.campaign_type,
      campaign_mode: c.campaign_mode, daily_send_limit: c.daily_send_limit,
      lifetime_sent: c.lifetime_sent, lifetime_returned: c.lifetime_returned, lifetime_emailed: c.lifetime_emailed,
      lifetime_revenue: Math.round(c.lifetime_revenue || 0),
      most_recent_send_at: c.most_recent_send_at,
      sends_30d: sends30d, returners_30d: c.returners_30d, revenue_30d: Math.round(c.revenue_30d || 0),
      lifetime_conversion_pct: lifetimeConv !== null ? Math.round(lifetimeConv * 1000) / 10 : null,
      conversion_30d_pct: conv30d !== null ? Math.round(conv30d * 1000) / 10 : null,
      // Pre/post-May-11 (loyalty migration) split — both null = no data either side
      sends_pre_may11: c.sends_pre_may11 || 0,
      returners_pre_may11: c.returners_pre_may11 || 0,
      sends_post_may11: c.sends_post_may11 || 0,
      returners_post_may11: c.returners_post_may11 || 0,
      lifetime_rate_pre_may11: ratePreMay11 !== null ? Math.round(ratePreMay11 * 1000) / 10 : null,
      lifetime_rate_post_may11: ratePostMay11 !== null ? Math.round(ratePostMay11 * 1000) / 10 : null,
      has_loyalty_migration_note: hasMigrationNote,
      agent_notes: c.agent_notes || null,
      bucket, bench_label: benchLabel, days_active: daysActive,
      burning_audience: burning,
    };
  });

  // Sort within bucket by revenue_30d desc
  const order = { working: 0, normal: 1, underperforming: 2, too_new: 3 };
  ranked.sort((a, b) => {
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    return (b.revenue_30d || 0) - (a.revenue_30d || 0);
  });
  return jsonResponse({ campaigns: ranked });
}

// GET /retail/forecast — base + suggestion-impacted scenarios over 30/60/90 days.
async function getRetailForecast(env) {
  const [revRecent, suggestions, monthlyAcq, welcomeStats] = await Promise.all([
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 0) as total FROM orders
      WHERE source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30
        AND order_date >= datetime('now','-28 days')
    `).first().catch(() => null),
    env.DB.prepare(`
      SELECT id, suggestion_id, title, annual_lift_low, annual_lift_high, effort
      FROM retail_suggestions WHERE state = 'open'
        AND annual_lift_high IS NOT NULL
      ORDER BY rank ASC LIMIT 3
    `).all().catch(() => ({ results: [] })),
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM retail_customers
      WHERE first_visit_date >= datetime('now','-30 days')
    `).first().catch(() => ({ cnt: 0 })),
    env.DB.prepare(`
      SELECT lifetime_returned, lifetime_sent FROM retail_campaigns
      WHERE campaign_type = 'welcome_free_pretzel' LIMIT 1
    `).first().catch(() => ({ lifetime_returned: 0, lifetime_sent: 0 })),
  ]);

  const weeklyRunRate = (revRecent?.total || 0) / 4; // 28d / 4 weeks
  const horizons = [30, 60, 90];
  const baseScenarios = horizons.map(h => ({
    horizon_days: h,
    conservative: Math.round(weeklyRunRate * 0.92 * (h / 7)),
    likely: Math.round(weeklyRunRate * 1.0 * (h / 7)),
    optimistic: Math.round(weeklyRunRate * 1.12 * (h / 7)),
  }));

  // Suggestion-impacted rows: baseline + each suggestion's lift × (h/365)
  const sugList = (suggestions.results || []);
  const suggestionImpacts = sugList.map(s => ({
    suggestion_id: s.suggestion_id,
    title: s.title,
    annual_lift_high: s.annual_lift_high,
    horizons: horizons.map(h => ({
      horizon_days: h,
      revenue: Math.round(weeklyRunRate * (h / 7) + (s.annual_lift_high || 0) * (h / 365)),
      delta: Math.round((s.annual_lift_high || 0) * (h / 365)),
    })),
  }));

  // "Both" / combined row if 2+ suggestions present
  let combined = null;
  if (sugList.length >= 2) {
    const combinedLift = sugList.reduce((sum, s) => sum + (s.annual_lift_high || 0), 0);
    combined = {
      label: `All ${sugList.length} suggestions`,
      horizons: horizons.map(h => ({
        horizon_days: h,
        revenue: Math.round(weeklyRunRate * (h / 7) + combinedLift * (h / 365)),
        delta: Math.round(combinedLift * (h / 365)),
      })),
    };
  }

  return jsonResponse({
    weekly_run_rate: Math.round(weeklyRunRate),
    assumptions: [
      'Current campaigns continue at present send pace',
      `New customer acquisition stays at ~${monthlyAcq?.cnt || 0}/month (last 30d pace)`,
      welcomeStats?.lifetime_sent > 0
        ? `Welcome campaign continues at ${Math.round((welcomeStats.lifetime_returned / welcomeStats.lifetime_sent) * 1000) / 10}% lifetime conversion`
        : 'Welcome campaign data still maturing',
      'No new product launches or price changes',
    ],
    base_scenarios: baseScenarios,
    suggestion_impacts: suggestionImpacts,
    combined,
  });
}

// GET /retail/cron-queue/forecast — tomorrow's queued sends with $ projection.
async function getCronQueueForecast(env) {
  // Find active campaigns + their daily_send_limit. Filter to event_triggered/manual=false.
  const campaigns = await env.DB.prepare(`
    SELECT id, name, daily_send_limit, campaign_type, campaign_mode,
      total_sent as lifetime_sent, total_returned as lifetime_returned,
      (SELECT COUNT(*) FROM retail_campaign_sends WHERE campaign_id = retail_campaigns.id AND sent_at >= datetime('now','-30 days')) as sends_30d,
      (SELECT COUNT(*) FROM retail_campaign_sends WHERE campaign_id = retail_campaigns.id AND returned_at >= datetime('now','-30 days')) as returners_30d,
      (SELECT AVG(return_order_value) FROM retail_campaign_sends WHERE campaign_id = retail_campaigns.id AND returned_at IS NOT NULL AND return_order_value IS NOT NULL) as avg_returner_ticket
    FROM retail_campaigns
    WHERE status = 'active'
      AND daily_send_limit IS NOT NULL AND daily_send_limit > 0
      AND campaign_mode NOT IN ('manual', 'event_triggered', 'external')
  `).all().catch(() => ({ results: [] }));

  const items = (campaigns.results || []).map(c => {
    const conv = c.sends_30d > 0 ? c.returners_30d / c.sends_30d
      : (c.lifetime_sent > 0 ? c.lifetime_returned / c.lifetime_sent : 0);
    const avgTicket = c.avg_returner_ticket || 18;
    const expected_revenue = Math.round(c.daily_send_limit * conv * avgTicket);
    const burning = c.daily_send_limit >= 30 && conv < 0.01;
    return {
      campaign_id: c.id,
      campaign_name: c.name,
      sends: c.daily_send_limit,
      conv_30d_pct: c.sends_30d > 0 ? Math.round(conv * 1000) / 10 : null,
      avg_ticket: Math.round(avgTicket),
      expected_revenue,
      flag: burning ? 'burning_audience' : null,
    };
  }).sort((a, b) => b.expected_revenue - a.expected_revenue);

  const total = items.reduce((s, i) => ({
    sends: s.sends + i.sends,
    revenue: s.revenue + i.expected_revenue,
  }), { sends: 0, revenue: 0 });

  return jsonResponse({
    fires_at: 'Daily 2pm MT (20:00 UTC)',
    items,
    totals: total,
  });
}

async function getRetailResults(env, periodParam) {
  // ── Time-zone handling ───────────────────────────────────────────
  // The business runs on America/Denver time (MT). Database timestamps are UTC.
  // We shift UTC → MT by '-6 hours' (MDT, currently in effect Mar 8 → Nov 1, 2026).
  // For the half-year MST window the offset is '-7 hours' — when DST ends, switch
  // the constant below. For the 1-hour DST transition windows the offset is briefly
  // off by one — acceptable since the dashboard is operator-facing not invoice-grade.
  // Work week is Monday–Sunday. SQLite trick: `date(X,'weekday 0','-6 days')` gives
  // the Monday of X's week (today if today is Monday, else the previous Monday).
  // NOTE: legacy getDashboardData (Pulse / cohort matrix in the accordion) still uses
  // UTC weeks anchored to Sunday — its numbers can disagree with the hero by up to
  // ~6h of orders on either side of midnight. Separate cleanup pass to align it.
  const TZ = "'-6 hours'";
  const TODAY = `date('now', ${TZ})`;
  const MT_DAY = `date(order_date, ${TZ})`;
  // Bucketing by effective business event:
  //   - Square retail/catering → order_date (when the customer ordered, real-time)
  //   - QBO wholesale invoices → created_at (when our sync first saw it = roughly when sent)
  // Without this distinction, future-dated wholesale invoices (e.g. dated Apr 30 but sent Apr 3)
  // would show up as "this week" because order_date is the billing/fulfillment date.
  const MT_DAY_BIZ = `date(CASE WHEN source='qbo_wholesale' THEN created_at ELSE order_date END, ${TZ})`;
  const MT_DAY_RETURN = `date(returned_at, ${TZ})`;
  const MT_DAY_SENT = `date(sent_at, ${TZ})`;

  const now = new Date();
  // Mirror the SQL `date(col, '-6 hours')` shift in JS so chart day-keys match SQL day-keys exactly.
  const mtNow = new Date(now.getTime() - 6 * 3600 * 1000);

  // Resolve period (defaults to 'wkd' = Mon-to-date MT, our prior baseline).
  const W = windowsFor(periodParam, mtNow.getTime());
  // SQL fragment: a row's MT-business-event datetime (Square=order_date, QBO=created_at).
  const BIZ_DT = `datetime(CASE WHEN source='qbo_wholesale' THEN created_at ELSE order_date END, ${TZ})`;

  // Pickup/deliver scheduled-time extracted from Square raw_payload — used to surface
  // "catering scheduled today" (placed earlier, fulfilled today) which is what an operator
  // actually cares about. The fallback handles delivery as well as pickup orders.
  const SCHED_AT = `COALESCE(json_extract(raw_payload, '$.fulfillments[0].pickup_details.pickup_at'), json_extract(raw_payload, '$.fulfillments[0].delivery_details.deliver_at'))`;
  const SCHED_DAY = `date(${SCHED_AT}, ${TZ})`;

  const [
    bizToday, bizWeek, bizPriorWeek, biz14d, lastOrder,
    campaignWeek, campaignPriorWeek, campaign14d, discountCost,
    campaignsList, ltvReturners, ltvTopRepeats,
    pendingApprovals, recentBlocks, collisions, cronRuns,
    cateringScheduledToday, cateringScheduledNext7,
    emailFunnel7d, email14d, campaignEmail7d,
    cohortAAudience, cohortASent, cohortABounce24h,
    cohortBLastBatch, cohortBAudience,
    cohortCTriggers7d, cohortCLastFired,
  ] = await Promise.all([
    // Business pulse — TODAY (MT)
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30 THEN gross_revenue ELSE 0 END) as retail_revenue,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30 THEN 1 ELSE 0 END) as retail_orders,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30) THEN gross_revenue ELSE 0 END) as catering_revenue,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30) THEN 1 ELSE 0 END) as catering_orders,
        SUM(CASE WHEN source = 'qbo_wholesale' THEN gross_revenue ELSE 0 END) as invoices_sent_amount,
        SUM(CASE WHEN source = 'qbo_wholesale' THEN 1 ELSE 0 END) as invoices_sent_count
      FROM orders
      WHERE ${MT_DAY_BIZ} = ${TODAY}
    `).first(),

    // Business pulse — selected period (default wkd). Uses effective-event date.
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30 THEN gross_revenue ELSE 0 END) as retail_revenue,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30 THEN 1 ELSE 0 END) as retail_orders,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30) THEN gross_revenue ELSE 0 END) as catering_revenue,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30) THEN 1 ELSE 0 END) as catering_orders,
        SUM(CASE WHEN source = 'qbo_wholesale' THEN gross_revenue ELSE 0 END) as invoices_sent_amount,
        SUM(CASE WHEN source = 'qbo_wholesale' THEN 1 ELSE 0 END) as invoices_sent_count
      FROM orders
      WHERE ${BIZ_DT} >= ? AND ${BIZ_DT} < ?
    `).bind(W.start, W.end).first(),

    // Business pulse — prior period, elapsed-matched.
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30 THEN gross_revenue ELSE 0 END) as retail_revenue,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30) THEN gross_revenue ELSE 0 END) as catering_revenue,
        SUM(CASE WHEN source = 'qbo_wholesale' THEN gross_revenue ELSE 0 END) as invoices_sent_amount
      FROM orders
      WHERE ${BIZ_DT} >= ? AND ${BIZ_DT} < ?
    `).bind(W.priorStart, W.priorEnd).first(),

    // 14-day daily revenue (always rolling 14d MT, regardless of period selector — operator wants chart context)
    env.DB.prepare(`
      SELECT date(CASE WHEN source='qbo_wholesale' THEN created_at ELSE order_date END, ${TZ}) as day,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30 THEN gross_revenue ELSE 0 END) as retail,
        SUM(CASE WHEN source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30) THEN gross_revenue ELSE 0 END) as catering,
        SUM(CASE WHEN source = 'qbo_wholesale' THEN gross_revenue ELSE 0 END) as invoices
      FROM orders
      WHERE ${BIZ_DT} >= ?
      GROUP BY day ORDER BY day
    `).bind(W.fourteenDaysAgo).all(),

    // Most recent Square order (real-time freshness signal)
    env.DB.prepare(`
      SELECT MAX(order_date) as last_at, MAX(created_at) as last_logged
      FROM orders WHERE source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled')
    `).first(),

    // Campaign attribution — rolling last 7 days.
    // ATTRIBUTION SEMANTICS: sends are counted by sent_at (SMS we sent this week);
    // returns + revenue are counted by returned_at (money that came in this week, regardless
    // of when the SMS was sent). The earlier "returns where sent_at within 7d" filter hid
    // late returns from sends >7d ago — e.g. NPD sent Apr 24 had 3 returns ($4,022) trickle
    // in over the following week that were invisible.
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM retail_campaign_sends
          WHERE sent_at >= datetime('now', '-7 days')
            AND outcome IN ('delivered', 'returned')
            AND (ab_arm IS NULL OR ab_arm != 'control')
            AND (variant_id IS NULL OR variant_id != 'holdout')) as sends,
        (SELECT COUNT(*) FROM retail_campaign_sends
          WHERE returned_at >= datetime('now', '-7 days')
            AND (ab_arm IS NULL OR ab_arm != 'control')
            AND (variant_id IS NULL OR variant_id != 'holdout')) as returns,
        (SELECT COALESCE(SUM(return_order_value), 0) FROM retail_campaign_sends
          WHERE returned_at >= datetime('now', '-7 days')
            AND (ab_arm IS NULL OR ab_arm != 'control')
            AND (variant_id IS NULL OR variant_id != 'holdout')) as revenue
    `).first(),

    // Campaign attribution — prior 7d window (days 7-14 ago), same return-based attribution.
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM retail_campaign_sends
          WHERE sent_at >= datetime('now', '-14 days') AND sent_at < datetime('now', '-7 days')
            AND outcome IN ('delivered', 'returned')
            AND (ab_arm IS NULL OR ab_arm != 'control')
            AND (variant_id IS NULL OR variant_id != 'holdout')) as sends,
        (SELECT COUNT(*) FROM retail_campaign_sends
          WHERE returned_at >= datetime('now', '-14 days') AND returned_at < datetime('now', '-7 days')
            AND (ab_arm IS NULL OR ab_arm != 'control')
            AND (variant_id IS NULL OR variant_id != 'holdout')) as returns,
        (SELECT COALESCE(SUM(return_order_value), 0) FROM retail_campaign_sends
          WHERE returned_at >= datetime('now', '-14 days') AND returned_at < datetime('now', '-7 days')
            AND (ab_arm IS NULL OR ab_arm != 'control')
            AND (variant_id IS NULL OR variant_id != 'holdout')) as revenue
    `).first(),

    // 14d campaign-attributed revenue (for sparkline) — MT-day buckets, rolling 14d.
    env.DB.prepare(`
      SELECT ${MT_DAY_RETURN} as day, SUM(COALESCE(return_order_value, 0)) as revenue
      FROM retail_campaign_sends
      WHERE datetime(returned_at, ${TZ}) >= ? AND returned_at IS NOT NULL
      GROUP BY day ORDER BY day
    `).bind(W.fourteenDaysAgo).all(),

    // Discount POS-redemption cost — rolling 7d to match campaign_week.
    env.DB.prepare(`
      SELECT COALESCE(SUM(times_redeemed * amount / 100.0), 0) as cost
      FROM retail_campaign_discounts
      WHERE created_at >= datetime('now', '-7 days')
    `).first(),

    // Per-campaign scoreboard — rolling last 7 days, with control comparison for lift.
    // sends_7d: SMS sent in last 7d. returns_7d/revenue_7d: customer returns in last 7d
    // attributable to ANY of this campaign's sends (including older sends that matured).
    // This avoids hiding late returns where the SMS went out >7d ago.
    env.DB.prepare(`
      SELECT rc.id, rc.name, rc.status, rc.campaign_type, rc.campaign_mode,
        rc.daily_send_limit, rc.paused_at, rc.pause_reason,
        rc.total_sent as lifetime_sent, rc.total_returned as lifetime_returned,
        rc.lifetime_emailed,
        SUM(CASE WHEN rcs.sent_at >= datetime('now','-7 days')
                  AND (rcs.ab_arm IS NULL OR rcs.ab_arm != 'control') AND (rcs.variant_id IS NULL OR rcs.variant_id != 'holdout')
                THEN 1 ELSE 0 END) as sends_7d,
        SUM(CASE WHEN rcs.returned_at >= datetime('now','-7 days')
                  AND (rcs.ab_arm IS NULL OR rcs.ab_arm != 'control') AND (rcs.variant_id IS NULL OR rcs.variant_id != 'holdout')
                THEN 1 ELSE 0 END) as returns_7d,
        SUM(CASE WHEN rcs.returned_at >= datetime('now','-7 days')
                  AND (rcs.ab_arm IS NULL OR rcs.ab_arm != 'control') AND (rcs.variant_id IS NULL OR rcs.variant_id != 'holdout')
                THEN COALESCE(rcs.return_order_value,0) ELSE 0 END) as revenue_7d,
        SUM(CASE WHEN rcs.ab_arm = 'control' THEN 1 ELSE 0 END) as control_held,
        SUM(CASE WHEN rcs.ab_arm = 'control' AND rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) as control_returned
      FROM retail_campaigns rc
      LEFT JOIN retail_campaign_sends rcs ON rcs.campaign_id = rc.id
      WHERE rc.status IN ('active', 'paused', 'draft')
        AND rc.campaign_type NOT IN ('vip_thank_you', 'onboarding')
      GROUP BY rc.id
      ORDER BY revenue_7d DESC, sends_7d DESC
    `).all(),

    // LTV — total + repeat returners last 30 MT-days
    env.DB.prepare(`
      SELECT COUNT(*) as total_returners,
        SUM(CASE WHEN repeat_visits > 0 THEN 1 ELSE 0 END) as repeat_returners,
        SUM(repeat_revenue) as repeat_revenue
      FROM (
        SELECT rcs.id,
          (SELECT COUNT(*) FROM orders o
            WHERE (o.customer_phone = rc.normalized_phone OR o.customer_phone = '+1' || rc.normalized_phone)
              AND o.order_date > rcs.returned_at) as repeat_visits,
          (SELECT COALESCE(SUM(o.gross_revenue),0) FROM orders o
            WHERE (o.customer_phone = rc.normalized_phone OR o.customer_phone = '+1' || rc.normalized_phone)
              AND o.order_date > rcs.returned_at) as repeat_revenue
        FROM retail_campaign_sends rcs
        JOIN retail_customers rc ON rc.id = rcs.customer_id
        WHERE rcs.returned_at IS NOT NULL
          AND ${MT_DAY_RETURN} >= date('now', ${TZ}, '-30 days')
          AND rcs.return_order_value > 0
          AND LOWER(rc.first_name) NOT LIKE '%test%'
          AND LOWER(rc.first_name) NOT LIKE '%ignore%'
      )
    `).first(),

    // LTV top repeat-returner examples (top 5 by additional revenue, excluding test customers)
    env.DB.prepare(`
      SELECT rcs.customer_id,
        SUBSTR(COALESCE(rc.first_name, 'Unknown'), 1, 20) as first_name,
        camp.name as campaign_name,
        rcs.return_order_value as first_return,
        (SELECT COUNT(*) FROM orders o
          WHERE (o.customer_phone = rc.normalized_phone OR o.customer_phone = '+1' || rc.normalized_phone)
            AND o.order_date > rcs.returned_at) as subsequent_visits,
        (SELECT COALESCE(SUM(o.gross_revenue),0) FROM orders o
          WHERE (o.customer_phone = rc.normalized_phone OR o.customer_phone = '+1' || rc.normalized_phone)
            AND o.order_date > rcs.returned_at) as additional_revenue
      FROM retail_campaign_sends rcs
      JOIN retail_customers rc ON rc.id = rcs.customer_id
      JOIN retail_campaigns camp ON camp.id = rcs.campaign_id
      WHERE rcs.returned_at IS NOT NULL
        AND ${MT_DAY_RETURN} >= date('now', ${TZ}, '-30 days')
        AND rcs.return_order_value > 0
        AND LOWER(rc.first_name) NOT LIKE '%test%'
        AND LOWER(rc.first_name) NOT LIKE '%ignore%'
      ORDER BY additional_revenue DESC
      LIMIT 5
    `).all(),

    // Pending campaign approvals
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM retail_campaigns WHERE approval_status = 'pending' AND status = 'pending_approval'`).first(),

    // Today's blocks count + collision count
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM sms_send_blocks WHERE date(created_at, ${TZ}) = ${TODAY}`).first(),
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM (
        SELECT customer_id FROM retail_campaign_sends
        WHERE outcome = 'delivered' AND sent_at >= datetime('now','-48 hours')
        GROUP BY customer_id HAVING COUNT(*) > 1
      )
    `).first(),

    // Recent retail cron runs (last 24h) — surface failures
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM cron_runs
      WHERE agent LIKE '%retail%' AND status = 'failed' AND started_at >= datetime('now','-24 hours')
    `).first().catch(() => ({ cnt: 0 })),

    // Catering scheduled for today (MT) — uses Square fulfillment pickup/deliver time, not order_date.
    env.DB.prepare(`
      SELECT COUNT(*) as cnt, COALESCE(SUM(gross_revenue), 0) as revenue
      FROM orders
      WHERE source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled')
        AND (gross_revenue >= 100 OR units >= 30)
        AND ${SCHED_DAY} = ${TODAY}
    `).first().catch(() => ({ cnt: 0, revenue: 0 })),

    // Catering scheduled in the next 7 days (MT) — forward-looking pipeline.
    env.DB.prepare(`
      SELECT ${SCHED_DAY} as day, COUNT(*) as cnt, COALESCE(SUM(gross_revenue), 0) as revenue
      FROM orders
      WHERE source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled')
        AND (gross_revenue >= 100 OR units >= 30)
        AND ${SCHED_DAY} >= ${TODAY}
        AND ${SCHED_DAY} < date('now', ${TZ}, '+7 days')
      GROUP BY day ORDER BY day
    `).all().catch(() => ({ results: [] })),

    // ── Email program queries (Tier 1+2 dashboard) ─────────────────────────

    // Email funnel — last 7d totals across all cohorts. Redemption count joins to
    // retail_campaign_discounts (WELCOME2WHY5 is the only code in flight); revenue
    // approximated as redemption_count × $8 until per-redemption order linkage exists.
    env.DB.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained','unsubscribed')) as sent,
        COUNT(*) FILTER (WHERE status = 'delivered' OR opened_at IS NOT NULL OR clicked_at IS NOT NULL) as delivered,
        COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as clicked,
        COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as bounced,
        COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL OR status = 'complained') as unsubscribed,
        (SELECT COALESCE(SUM(times_redeemed), 0) FROM retail_campaign_discounts
          WHERE created_at >= datetime('now','-7 days') AND code = 'WELCOME2WHY5') as redeemed
      FROM email_sends
      WHERE sent_at >= datetime('now','-7 days')
    `).first().catch(() => null),

    // 14-day email send series (MT-day buckets, by cohort for stacked rendering)
    env.DB.prepare(`
      SELECT date(sent_at, ${TZ}) as day,
             COALESCE(cohort, '?') as cohort,
             COUNT(*) as cnt
      FROM email_sends
      WHERE sent_at >= datetime('now','-13 days')
        AND status IN ('sent','delivered','bounced','complained','unsubscribed','queued')
      GROUP BY day, cohort
      ORDER BY day
    `).all().catch(() => ({ results: [] })),

    // Per-campaign email aggregates (last 7d). Merged into the scoreboard rows in JS.
    // returned_30d/revenue_30d use 30-day window since email return cycles are longer than 7d.
    env.DB.prepare(`
      SELECT campaign_id,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-7 days')) as sent_7d,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-7 days') AND opened_at IS NOT NULL) as opened_7d,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-7 days') AND clicked_at IS NOT NULL) as clicked_7d,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-7 days') AND bounced_at IS NOT NULL) as bounced_7d,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-7 days') AND unsubscribed_at IS NOT NULL) as unsubscribed_7d,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-30 days')) as sent_30d,
        COUNT(*) FILTER (WHERE sent_at >= datetime('now','-30 days') AND returned_at IS NOT NULL) as returned_30d,
        COALESCE(SUM(CASE WHEN sent_at >= datetime('now','-30 days') AND returned_at IS NOT NULL THEN return_order_value ELSE 0 END), 0) as revenue_30d
      FROM email_sends
      WHERE campaign_id IS NOT NULL
      GROUP BY campaign_id
    `).all().catch(() => ({ results: [] })),

    // Cohort A audience (Toast-imported, no Square order, has email, opt-in)
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM square_customers
      WHERE creation_source='IMPORT'
        AND COALESCE(square_order_count, 0) = 0
        AND email IS NOT NULL
        AND email_unsubscribed = 0
        AND email_bounced = 0
    `).first().catch(() => ({ cnt: 0 })),

    // Cohort A sent count (lifetime)
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM email_sends WHERE cohort='A' AND status IN ('sent','delivered','bounced','complained','unsubscribed','opened','clicked')`).first().catch(() => ({ cnt: 0 })),

    // Cohort A bounce rate over the LAST 24H of sends — used to disable fire buttons.
    // If denominator < 50, returns null (too small to be meaningful).
    env.DB.prepare(`
      SELECT
        COUNT(*) as recent_total,
        COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as recent_bounced
      FROM email_sends
      WHERE cohort='A' AND sent_at >= datetime('now','-24 hours')
    `).first().catch(() => ({ recent_total: 0, recent_bounced: 0 })),

    // Cohort B last batch
    env.DB.prepare(`SELECT MAX(sent_at) as last_sent_at, COUNT(*) FILTER (WHERE sent_at >= datetime('now','-7 days')) as sent_last_7d FROM email_sends WHERE cohort='B'`).first().catch(() => null),

    // Cohort B current audience
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM square_customers
      WHERE COALESCE(square_order_count, 0) >= 1
        AND last_square_order_date < datetime('now', '-30 days')
        AND last_square_order_date >= datetime('now', '-180 days')
        AND email IS NOT NULL
        AND email_unsubscribed = 0
        AND email_bounced = 0
        AND square_customer_id NOT IN (
          SELECT customer_id FROM email_sends WHERE cohort = 'B' AND customer_id IS NOT NULL
            AND sent_at >= datetime('now', '-60 days')
        )
    `).first().catch(() => ({ cnt: 0 })),

    // Cohort C — count this week + last fired
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM email_sends WHERE cohort='C' AND sent_at >= datetime('now','-7 days')`).first().catch(() => ({ cnt: 0 })),
    env.DB.prepare(`SELECT MAX(sent_at) as last_sent_at FROM email_sends WHERE cohort='C'`).first().catch(() => null),
  ]);

  // ── Compose business pulse ──
  const business_today = {
    retail_revenue: Math.round((bizToday?.retail_revenue || 0) * 100) / 100,
    retail_orders: bizToday?.retail_orders || 0,
    catering_revenue: Math.round((bizToday?.catering_revenue || 0) * 100) / 100,
    catering_orders: bizToday?.catering_orders || 0,
    catering_scheduled_today: cateringScheduledToday?.cnt || 0,
    catering_scheduled_revenue: Math.round((cateringScheduledToday?.revenue || 0) * 100) / 100,
    invoices_sent_amount: Math.round((bizToday?.invoices_sent_amount || 0) * 100) / 100,
    invoices_sent_count: bizToday?.invoices_sent_count || 0,
    last_order_at: lastOrder?.last_at || null,
    last_logged_at: lastOrder?.last_logged || null,
  };
  business_today.total = Math.round((business_today.retail_revenue + business_today.catering_revenue + business_today.invoices_sent_amount) * 100) / 100;

  const catering_pipeline_7d = (cateringScheduledNext7?.results || []).map(r => ({
    date: r.day,
    count: r.cnt || 0,
    revenue: Math.round((r.revenue || 0) * 100) / 100,
  }));

  // Cap pct deltas: when prior denominator is below a meaningful threshold ($25 for the
  // retail/catering buckets, $100 for totals), the % delta gets too noisy to be useful —
  // a $5 prior + $500 current returns +9900% which scares the operator without informing.
  // Return null and the dashboard renders "—".
  const pct = (cur, prior, minPrior = 25) => prior >= minPrior ? Math.round(((cur - prior) / prior) * 100) : null;
  const business_week = {
    retail_revenue: Math.round((bizWeek?.retail_revenue || 0) * 100) / 100,
    retail_orders: bizWeek?.retail_orders || 0,
    catering_revenue: Math.round((bizWeek?.catering_revenue || 0) * 100) / 100,
    catering_orders: bizWeek?.catering_orders || 0,
    invoices_sent_amount: Math.round((bizWeek?.invoices_sent_amount || 0) * 100) / 100,
    invoices_sent_count: bizWeek?.invoices_sent_count || 0,
  };
  business_week.total = Math.round((business_week.retail_revenue + business_week.catering_revenue + business_week.invoices_sent_amount) * 100) / 100;
  // Per-bucket deltas (null when prior denominator too small to be meaningful)
  const retail_pct = pct(business_week.retail_revenue, bizPriorWeek?.retail_revenue || 0);
  const catering_pct = pct(business_week.catering_revenue, bizPriorWeek?.catering_revenue || 0, 100);
  const invoices_pct = pct(business_week.invoices_sent_amount, bizPriorWeek?.invoices_sent_amount || 0, 100);
  // Total delta is suppressed if any component is null OR if any current bucket exists
  // without a prior counterpart (prevents the "$14k invoices vs $0 prior = +∞%" flash).
  const allComponentsValid = retail_pct !== null
    && (business_week.catering_revenue === 0 || catering_pct !== null)
    && (business_week.invoices_sent_amount === 0 || invoices_pct !== null);
  business_week.vs_prior_7d = {
    retail_pct,
    catering_pct,
    invoices_pct,
    total_pct: allComponentsValid
      ? pct(business_week.total, (bizPriorWeek?.retail_revenue || 0) + (bizPriorWeek?.catering_revenue || 0) + (bizPriorWeek?.invoices_sent_amount || 0), 100)
      : null,
    prior_retail_revenue: Math.round((bizPriorWeek?.retail_revenue || 0) * 100) / 100,
    prior_catering_revenue: Math.round((bizPriorWeek?.catering_revenue || 0) * 100) / 100,
    prior_invoices_sent_amount: Math.round((bizPriorWeek?.invoices_sent_amount || 0) * 100) / 100,
    note: 'Elapsed-matched: same time-into-week as now, last week. Null = prior denom too small to be meaningful.',
  };

  // 14-day chart fill (ensure all 14 days present, even if zero)
  const dayMap = new Map((biz14d.results || []).map(r => [r.day, r]));
  const business_14d = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(mtNow.getTime() - i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    const row = dayMap.get(dayKey);
    business_14d.push({
      date: dayKey,
      retail: Math.round((row?.retail || 0) * 100) / 100,
      catering: Math.round((row?.catering || 0) * 100) / 100,
      invoices: Math.round((row?.invoices || 0) * 100) / 100,
      total: Math.round(((row?.retail || 0) + (row?.catering || 0) + (row?.invoices || 0)) * 100) / 100,
    });
  }

  // ── V2 scorecard: per-channel 7d sparkline arrays + outlier detection ─
  // Sliced from the 14d series. Outlier = single-day value > 2× the 4-week median
  // of NON-zero days for that channel. Generates a narrative callout with a real $ figure.
  const last7 = business_14d.slice(-7);
  const sparklines_7d = {
    retail: last7.map(d => Math.round(d.retail)),
    catering: last7.map(d => Math.round(d.catering)),
    invoices: last7.map(d => Math.round(d.invoices)),
  };
  // Outlier detection — find any day where a channel's $ > 2× median of last 28d non-zero
  const outliers = [];
  const allBuckets = (biz14d.results || []);
  for (const channel of ['retail', 'catering', 'invoices']) {
    const vals = allBuckets.map(r => r[channel] || 0).filter(v => v > 0).sort((a, b) => a - b);
    if (vals.length < 4) continue;
    const median = vals[Math.floor(vals.length / 2)];
    const threshold = median * 2.5;
    const recentSpike = allBuckets.find(r => (r[channel] || 0) >= threshold && r.day >= business_14d[0].date);
    if (recentSpike) {
      // Find the dominant order on that day
      let lookupSql;
      if (channel === 'invoices') {
        lookupSql = `SELECT customer_name, ROUND(gross_revenue, 0) as rev FROM orders
                     WHERE source = 'qbo_wholesale' AND date(created_at, ${TZ}) = ?
                     ORDER BY gross_revenue DESC LIMIT 1`;
      } else if (channel === 'catering') {
        lookupSql = `SELECT customer_name, ROUND(gross_revenue, 0) as rev FROM orders
                     WHERE source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND (gross_revenue >= 100 OR units >= 30)
                       AND ${MT_DAY} = ?
                     ORDER BY gross_revenue DESC LIMIT 1`;
      } else {
        lookupSql = `SELECT customer_name, ROUND(gross_revenue, 0) as rev FROM orders
                     WHERE source IN ('square','square_delivery') AND COALESCE(status,'active') NOT IN ('draft','canceled') AND gross_revenue < 100 AND units < 30
                       AND ${MT_DAY} = ?
                     ORDER BY gross_revenue DESC LIMIT 1`;
      }
      const top = await env.DB.prepare(lookupSql).bind(recentSpike.day).first().catch(() => null);
      const channelLabel = channel === 'invoices' ? 'Invoices' : channel === 'catering' ? 'Catering' : 'Retail';
      outliers.push({
        channel,
        date: recentSpike.day,
        amount: Math.round(recentSpike[channel]),
        median,
        narrative: top?.customer_name
          ? `${channelLabel} spike on ${recentSpike.day} driven by ${top.customer_name} ($${top.rev}). Strip that and ${channel} pace is normal at $${Math.round(median)}/day median.`
          : `${channelLabel} spike on ${recentSpike.day} ($${Math.round(recentSpike[channel])}) — ${(recentSpike[channel] / median).toFixed(1)}× median. Investigate.`,
      });
    }
  }

  // ── Compose campaign attribution ──
  const campaign_week = {
    sends: campaignWeek?.sends || 0,
    returns: campaignWeek?.returns || 0,
    // Note: not a same-cohort rate — returns_7d are matured customers from older sends.
    // Computing returns_7d / sends_7d would be cohort-mismatched (can exceed 100%).
    // We hide it; the scoreboard shows per-campaign LIFETIME rate which is the meaningful signal.
    return_rate: null,
    attributed_revenue: Math.round((campaignWeek?.revenue || 0) * 100) / 100,
    discount_cost: Math.round((discountCost?.cost || 0) * 100) / 100,
    net: Math.round(((campaignWeek?.revenue || 0) - (discountCost?.cost || 0)) * 100) / 100,
    vs_prior_7d: {
      sends_delta: (campaignWeek?.sends || 0) - (campaignPriorWeek?.sends || 0),
      returns_delta: (campaignWeek?.returns || 0) - (campaignPriorWeek?.returns || 0),
      revenue_delta: Math.round(((campaignWeek?.revenue || 0) - (campaignPriorWeek?.revenue || 0)) * 100) / 100,
    },
  };

  const campaign14dMap = new Map((campaign14d.results || []).map(r => [r.day, r.revenue]));
  const campaign_14d_revenue = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(mtNow.getTime() - i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    campaign_14d_revenue.push({ date: dayKey, revenue: Math.round((campaign14dMap.get(dayKey) || 0) * 100) / 100 });
  }

  // ── Compose campaign scoreboard with lift ──
  const campaigns = (campaignsList.results || []).map(c => {
    const treatRate = c.sends_7d > 0 ? c.returns_7d / c.sends_7d : null;
    const ctrlRate = c.control_held > 0 ? c.control_returned / c.control_held : null;
    const lift_pp = (treatRate !== null && ctrlRate !== null && c.sends_7d >= 5 && c.control_held >= 5)
      ? Math.round((treatRate - ctrlRate) * 1000) / 10 : null;
    let badge = '✓';
    if (c.status === 'paused') badge = '⏸';
    else if (c.status === 'draft') badge = '🆕';
    else if (c.sends_7d === 0 && c.lifetime_sent > 0) badge = '⏳';
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      campaign_type: c.campaign_type,
      campaign_mode: c.campaign_mode,
      daily_send_limit: c.daily_send_limit,
      badge,
      sends_7d: c.sends_7d || 0,
      returns_7d: c.returns_7d || 0,
      revenue_7d: Math.round((c.revenue_7d || 0) * 100) / 100,
      // Rate uses lifetime totals across BOTH SMS sends and emails (lifetime_emailed
      // tracked since email infrastructure shipped). For email-only campaigns
      // (campaign_mode='external'/'event_triggered'), denominator falls back to
      // lifetime_emailed. Avoids divide-by-zero noise.
      rate_pct: (() => {
        const totalReached = (c.lifetime_sent || 0) + (c.lifetime_emailed || 0);
        return totalReached > 0
          ? Math.round((c.lifetime_returned / totalReached) * 1000) / 10
          : null;
      })(),
      lift_pp,
      lifetime_sent: c.lifetime_sent || 0,
      lifetime_returned: c.lifetime_returned || 0,
      lifetime_emailed: c.lifetime_emailed || 0,
      control_held: c.control_held || 0,
      paused_at: c.paused_at,
      pause_reason: c.pause_reason,
    };
  });

  // ── Action queue (auto-derived) ──
  const actions = [];

  // Abnormal first (red)
  const collisionCount = collisions?.cnt || 0;
  const blocksTodayCount = recentBlocks?.cnt || 0;
  const cronFailures = cronRuns?.cnt || 0;
  if (collisionCount > 0) {
    actions.push({
      type: 'abnormal', urgency: 'critical', icon: '🚨',
      title: `${collisionCount} customer${collisionCount > 1 ? 's' : ''} got 2+ SMS within 48h`,
      subtitle: 'Brand-fatigue guard missed a path — check block drawer + worker logs',
    });
  }
  if (blocksTodayCount > 50) {
    actions.push({
      type: 'abnormal', urgency: 'high', icon: '⚠️',
      title: `${blocksTodayCount} sends blocked today`,
      subtitle: 'Unusually high block volume — check guard reasons',
    });
  }
  if (cronFailures > 0) {
    actions.push({
      type: 'abnormal', urgency: 'high', icon: '⚠️',
      title: `${cronFailures} retail cron run${cronFailures > 1 ? 's' : ''} failed in last 24h`,
      subtitle: 'Check System tab → Cron runs',
    });
  }

  // Pending approvals
  const pendingCnt = pendingApprovals?.cnt || 0;
  if (pendingCnt > 0) {
    actions.push({
      type: 'pending_approval', urgency: 'high', icon: '📋',
      title: `${pendingCnt} campaign${pendingCnt > 1 ? 's' : ''} waiting for approval`,
      subtitle: 'Review and approve before next 2pm cron',
    });
  }

  // Manual-fire ready (NPD-style)
  for (const c of campaigns) {
    if (c.campaign_mode === 'manual' && c.status === 'active' && c.sends_7d === 0 && c.lifetime_sent < 100) {
      actions.push({
        type: 'fire_ready', urgency: 'high', icon: '🔥',
        title: `${c.name} ready to fire`,
        subtitle: `Manual campaign — preview cohort + fire from panel below`,
        campaign_id: c.id,
      });
    }
  }

  // Just-activated (status=active in last 24h with low total_sent)
  for (const c of campaigns) {
    if (c.status === 'active' && c.lifetime_sent < 5 && c.campaign_mode !== 'manual') {
      actions.push({
        type: 'just_activated', urgency: 'medium', icon: '📨',
        title: `${c.name} just activated`,
        subtitle: `${c.daily_send_limit || '?'}/day starting next 2pm MT cron`,
        campaign_id: c.id,
      });
    }
  }

  // Paused review
  for (const c of campaigns) {
    if (c.status === 'paused') {
      const days = c.paused_at ? Math.floor((Date.now() - new Date(c.paused_at.replace(' ','T')+'Z').getTime()) / 86400000) : '?';
      actions.push({
        type: 'paused_review', urgency: 'low', icon: '⏸',
        title: `${c.name} paused${days !== '?' ? ` ${days}d ago` : ''}`,
        subtitle: c.pause_reason ? `Reason: ${c.pause_reason}` : 'Review when ready to resume',
        campaign_id: c.id,
      });
    }
  }

  // Cohort maturing (Day 7 specifically — most actionable)
  // Find campaigns whose earliest send is between 5 and 7 days old AND have sends>5.
  const day7Soon = campaigns.filter(c =>
    c.sends_7d >= 5 && c.lifetime_returned > 0 && c.campaign_mode === 'continuous'
  );
  if (day7Soon.length > 0) {
    actions.push({
      type: 'cohort_maturing', urgency: 'low', icon: '⏳',
      title: `${day7Soon.length} campaign${day7Soon.length > 1 ? 's' : ''} approaching Day-7 cohort maturity`,
      subtitle: `First real Day-7 conversion read available soon`,
    });
  }

  // ── LTV signal ──
  const ltv = {
    total_returners_30d: ltvReturners?.total_returners || 0,
    repeat_returners: ltvReturners?.repeat_returners || 0,
    repeat_pct: ltvReturners?.total_returners > 0
      ? Math.round((ltvReturners.repeat_returners / ltvReturners.total_returners) * 100) : 0,
    repeat_revenue: Math.round((ltvReturners?.repeat_revenue || 0) * 100) / 100,
    top_examples: (ltvTopRepeats.results || []).map(r => ({
      customer_id: r.customer_id,
      first_name: r.first_name,
      campaign_name: r.campaign_name,
      first_return: Math.round(r.first_return * 100) / 100,
      subsequent_visits: r.subsequent_visits || 0,
      additional_revenue: Math.round((r.additional_revenue || 0) * 100) / 100,
    })),
  };

  // ── _health: server-side metric sanity checks ──
  // Each entry surfaces an internal anomaly the operator should know about.
  // Cheap to compute, render as amber pills in dashboard or pipe into alerts.
  const anomalies = [];

  // System-wide check: if CFO is in read-only mode, every dashboard should know about it.
  let financeReadOnly = false;
  try {
    const flag = await env.KV.get('FINANCE_READ_ONLY');
    financeReadOnly = flag === '1' || flag === 'true';
  } catch (_) { /* non-fatal */ }
  if (financeReadOnly) {
    anomalies.push({
      severity: 'high',
      metric: 'finance.read_only',
      message: 'CFO daily-close is in READ-ONLY mode (Mercury vs books variance >$50). No JEs being posted. Set opening balances or manually clear the flag.',
    });
  }
  const lastOrderMs = lastOrder?.last_at ? new Date(lastOrder.last_at).getTime() : null;
  if (lastOrderMs && lastOrderMs > now.getTime() + 5 * 60 * 1000) {
    anomalies.push({ severity: 'high', metric: 'last_order_at', message: 'Latest Square order timestamp is in the future — clock skew or bad webhook payload.' });
  }
  if (lastOrderMs && now.getTime() - lastOrderMs > 24 * 3600 * 1000) {
    const hrs = Math.round((now.getTime() - lastOrderMs) / 3600000);
    anomalies.push({ severity: 'medium', metric: 'last_order_at', message: `No Square order seen in ${hrs}h — webhook may be stalled.` });
  }
  const todaySum = business_today.retail_revenue + business_today.catering_revenue + business_today.invoices_sent_amount;
  if (Math.abs(business_today.total - todaySum) > 0.01) {
    anomalies.push({ severity: 'high', metric: 'business_today.total', message: `total ${business_today.total} != sum-of-parts ${todaySum.toFixed(2)} — rollup bug.` });
  }
  if (campaign_week.attributed_revenue < 0) {
    anomalies.push({ severity: 'high', metric: 'campaign_week.attributed_revenue', message: 'Negative attributed revenue — bad return_order_value rows.' });
  }
  if (campaign_week.discount_cost > 0 && campaign_week.sends === 0) {
    anomalies.push({ severity: 'medium', metric: 'campaign_week.discount_cost', message: 'Discount redemptions exist this week but no sends — discount-code leak or pre-existing redemptions.' });
  }
  if (ltv.repeat_pct > 100) {
    anomalies.push({ severity: 'high', metric: 'ltv.repeat_pct', message: 'Repeat % > 100 — denominator/numerator mismatch.' });
  }
  // returns > sends in same 7d window is EXPECTED under returned_at attribution
  // (late-maturing returns from sends >7d ago). Only flag if lifetime returns > lifetime sends.
  for (const c of campaigns) {
    if (c.lifetime_returned > c.lifetime_sent && c.lifetime_sent > 0) {
      anomalies.push({ severity: 'high', metric: `campaign:${c.id}`, message: `${c.name}: lifetime returns (${c.lifetime_returned}) > sends (${c.lifetime_sent}) — duplicate attribution.` });
    }
    if (c.revenue_7d < 0) {
      anomalies.push({ severity: 'high', metric: `campaign:${c.id}`, message: `${c.name}: negative weekly revenue.` });
    }
  }
  if ((cronRuns?.cnt || 0) > 0) {
    anomalies.push({ severity: 'medium', metric: 'cron_runs', message: `${cronRuns.cnt} retail cron run(s) failed in last 24h.` });
  }

  // Email send health — bounce / complaint / unsub rates over last 7d.
  // Sender reputation degrades fast on cold lists; flagging early lets us pause
  // Cohort A before reputation tank prevents Cohort B/C from delivering.
  try {
    const emailStats = await env.DB.prepare(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as bounced,
             COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL OR status = 'complained') as opted_out,
             COUNT(*) FILTER (WHERE status = 'error') as errored
      FROM email_sends
      WHERE sent_at >= datetime('now', '-7 days')
        AND status IN ('sent', 'delivered', 'bounced', 'complained', 'unsubscribed', 'error')
    `).first().catch(() => null);
    if (emailStats && emailStats.total >= 50) {
      const bounceRate = emailStats.bounced / emailStats.total;
      const optoutRate = emailStats.opted_out / emailStats.total;
      const errorRate = emailStats.errored / emailStats.total;
      if (bounceRate > 0.05) {
        anomalies.push({
          severity: 'high', metric: 'email.bounce_rate',
          message: `Email bounce rate ${(bounceRate * 100).toFixed(1)}% over last 7d (${emailStats.bounced}/${emailStats.total}). Pause cohorts; clean list.`,
        });
      }
      if (optoutRate > 0.02) {
        anomalies.push({
          severity: 'high', metric: 'email.optout_rate',
          message: `Email opt-out + spam-complaint rate ${(optoutRate * 100).toFixed(1)}% over last 7d. Copy or audience problem.`,
        });
      }
      if (errorRate > 0.10) {
        anomalies.push({
          severity: 'medium', metric: 'email.error_rate',
          message: `Resend API error rate ${(errorRate * 100).toFixed(1)}% over last 7d (${emailStats.errored}/${emailStats.total}).`,
        });
      }
    }
  } catch (_) { /* email_sends table may not exist yet during migration window */ }

  // Persist anomalies to system_alerts for any caller (CFO, alert email, dashboard
  // history). De-duped: an identical (source,severity,subject) within the last 6h is
  // suppressed so the 60s polling doesn't spam the table.
  // tab_scope keeps cross-tab pollution out — finance issues stay on Money tab, etc.
  const tabScopeFor = (metric) => {
    if (!metric) return 'all';
    if (metric.startsWith('finance.') || metric.startsWith('mercury.') || metric.startsWith('je.')) return 'money';
    if (metric.startsWith('email.') || metric.startsWith('campaign') || metric.startsWith('retail.')) return 'retail';
    if (metric.startsWith('cron') || metric === 'cron_runs' || metric.startsWith('system.')) return 'system';
    if (metric === 'last_order_at') return 'retail';
    if (metric === 'ltv.repeat_pct' || metric.startsWith('business_today') || metric.startsWith('campaign_week')) return 'retail';
    return 'all';
  };
  // Only show anomalies on the retail tab whose tab_scope is 'retail' or 'all'.
  // Other anomalies still get persisted to system_alerts so the system tab can show them.
  const retailScopedAnomalies = anomalies.filter(a => {
    const scope = tabScopeFor(a.metric);
    return scope === 'retail' || scope === 'all';
  });
  if (anomalies.length > 0) {
    try {
      for (const a of anomalies) {
        const subject = (a.message || '').slice(0, 200);
        const source = `retail_results:${a.metric || 'unknown'}`;
        const scope = tabScopeFor(a.metric);
        const dup = await env.DB.prepare(
          `SELECT id FROM system_alerts WHERE source = ? AND subject = ? AND created_at > datetime('now','-6 hours') LIMIT 1`
        ).bind(source, subject).first().catch(() => null);
        if (!dup) {
          await env.DB.prepare(
            `INSERT INTO system_alerts (id, created_at, severity, source, subject, body, email_status, tab_scope)
             VALUES (?, datetime('now'), ?, ?, ?, ?, 'skipped', ?)`
          ).bind(crypto.randomUUID(), a.severity || 'medium', source, subject, a.message || '', scope).run().catch(() => {});
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  const _health = {
    ok: retailScopedAnomalies.length === 0,
    checked_at: new Date().toISOString(),
    anomalies: retailScopedAnomalies,
    anomalies_other_tabs: anomalies.length - retailScopedAnomalies.length,
    // Window labels — useful for display / debugging.
    windows: {
      period: W.period,
      period_label: W.label,
      prior_label: W.priorLabel,
      start: W.start,
      end: W.end,
      prior_start: W.priorStart,
      prior_end: W.priorEnd,
      today: TODAY,
      tz_offset: TZ,
      ltv_window_days: 30,
      campaign_window: 'rolling_7d',
      campaign_prior_window: 'rolling_7_to_14d',
      discount_cost_window: 'rolling_7d',
      business_week_window: 'mon_to_now_mt',
      business_prior_week_window: 'elapsed_matched_prior_mon',
      business_event_date: 'square=order_date, qbo_wholesale=created_at (when sync first saw invoice)',
      sources: 'retail+catering=Square only; invoices=QBO only',
    },
  };

  // ── Email funnel + 14d series + cohort pacing ────────────────────────
  const f = emailFunnel7d || {};
  const email_funnel = {
    sent: f.sent || 0,
    delivered: f.delivered || 0,
    opened: f.opened || 0,
    clicked: f.clicked || 0,
    bounced: f.bounced || 0,
    unsubscribed: f.unsubscribed || 0,
    redeemed: f.redeemed || 0,
    revenue: Math.round((f.redeemed || 0) * 8 * 100) / 100, // $8 per redemption (WELCOME2WHY5)
    open_rate_pct: f.delivered > 0 ? Math.round((f.opened / f.delivered) * 1000) / 10 : null,
    click_rate_pct: f.opened > 0 ? Math.round((f.clicked / f.opened) * 1000) / 10 : null,
    bounce_rate_pct: f.sent > 0 ? Math.round((f.bounced / f.sent) * 1000) / 10 : null,
    unsubscribe_rate_pct: f.sent > 0 ? Math.round((f.unsubscribed / f.sent) * 1000) / 10 : null,
  };

  // 14d email-sends series — fill missing days, zero out empty cohorts
  const emailDayMap = new Map();
  for (const r of (email14d?.results || [])) {
    if (!emailDayMap.has(r.day)) emailDayMap.set(r.day, { date: r.day, A: 0, B: 0, C: 0, total: 0 });
    const bucket = emailDayMap.get(r.day);
    if (r.cohort && bucket[r.cohort] !== undefined) bucket[r.cohort] = r.cnt || 0;
    bucket.total += r.cnt || 0;
  }
  const email_14d_series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(mtNow.getTime() - i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    email_14d_series.push(emailDayMap.get(dayKey) || { date: dayKey, A: 0, B: 0, C: 0, total: 0 });
  }

  // Per-campaign email merge — fold into existing campaigns array.
  const campaignEmailMap = new Map();
  for (const r of (campaignEmail7d?.results || [])) {
    campaignEmailMap.set(r.campaign_id, r);
  }
  for (const c of campaigns) {
    const e = campaignEmailMap.get(c.id) || {};
    c.emails_7d_sent = e.sent_7d || 0;
    c.emails_7d_opened = e.opened_7d || 0;
    c.emails_7d_clicked = e.clicked_7d || 0;
    c.emails_7d_bounced = e.bounced_7d || 0;
    c.emails_7d_unsubscribed = e.unsubscribed_7d || 0;
    // Lifetime open/click/bounce % — uses lifetime_emailed denominator (delivered ≈ emailed for our scope).
    // 7d rates would be cohort-mismatched (open lags send by hours/days).
    c.email_open_rate_pct = (c.emails_7d_sent > 0)
      ? Math.round((c.emails_7d_opened / c.emails_7d_sent) * 1000) / 10
      : null;
    c.email_click_rate_pct = (c.emails_7d_sent > 0)
      ? Math.round((c.emails_7d_clicked / c.emails_7d_sent) * 1000) / 10
      : null;
    c.email_bounce_rate_pct = (c.emails_7d_sent > 0)
      ? Math.round((c.emails_7d_bounced / c.emails_7d_sent) * 1000) / 10
      : null;
    // Email return-rate (the metric that actually matters since Resend's open-tracking
    // pipeline is broken — accepted as platform bug May 11). 30-day window because email
    // return cycles are longer than SMS. Populated by attributeEmailReturn() in webhook.
    c.emails_30d_sent = e.sent_30d || 0;
    c.emails_30d_returned = e.returned_30d || 0;
    c.email_30d_revenue = Math.round(e.revenue_30d || 0);
    c.email_return_rate_pct = (c.emails_30d_sent > 0)
      ? Math.round((c.emails_30d_returned / c.emails_30d_sent) * 1000) / 10
      : null;
  }

  // Cohort pacing — drives the operator widget
  const cohortBouncePct = (cohortABounce24h?.recent_total || 0) >= 50
    ? Math.round((cohortABounce24h.recent_bounced / cohortABounce24h.recent_total) * 1000) / 10
    : null;
  // Compute next Tuesday 10am MT in JS (cron is "0 16 * * 2" = 16:00 UTC = 10am MDT).
  const nextTuesday = (() => {
    const d = new Date();
    const dow = d.getUTCDay();
    let daysUntil = (2 - dow + 7) % 7;
    if (daysUntil === 0 && d.getUTCHours() >= 16) daysUntil = 7;
    const next = new Date(d.getTime() + daysUntil * 86400000);
    next.setUTCHours(16, 0, 0, 0);
    return next.toISOString();
  })();
  // Note: cohortAAudience counts ALL Toast-imported, opt-in, no-Square-order customers
  // (the universe). cohortASent is how many we've actually emailed. Remaining = audience - sent.
  // The fire endpoint excludes prior sends server-side, so this match is correct.
  const cohortAAudienceCnt = cohortAAudience?.cnt || 0;
  const cohortASentCnt = cohortASent?.cnt || 0;
  const cohort_pacing = {
    a: {
      audience: cohortAAudienceCnt,
      sent: cohortASentCnt,
      remaining: Math.max(0, cohortAAudienceCnt - cohortASentCnt),
      recent_24h_bounce_rate_pct: cohortBouncePct,
      auto_paused: cohortBouncePct !== null && cohortBouncePct > 5,
    },
    b: {
      audience: cohortBAudience?.cnt || 0,
      last_batch_sent_at: cohortBLastBatch?.last_sent_at || null,
      sent_last_7d: cohortBLastBatch?.sent_last_7d || 0,
      next_batch_at: nextTuesday,
    },
    c: {
      triggered_7d: cohortCTriggers7d?.cnt || 0,
      last_fired_at: cohortCLastFired?.last_sent_at || null,
    },
  };

  return jsonResponse({
    generated_at: new Date().toISOString(),
    period: { key: W.period, label: W.label, prior_label: W.priorLabel },
    business_today,
    business_week,        // legacy name; actually reflects selected period
    business_14d,
    catering_pipeline_7d,
    sparklines_7d,
    outliers,
    campaign_week,
    campaign_14d_revenue,
    actions,
    campaigns,
    ltv,
    email_funnel,
    email_14d_series,
    cohort_pacing,
    _health,
  });
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

    // This week's metrics — Mon-Sun MT (matches new hero)
    env.DB.prepare(`
      SELECT
        SUM(gross_revenue) as weekly_revenue,
        COUNT(*) as transaction_count,
        AVG(gross_revenue) as avg_ticket
      FROM orders WHERE date(order_date, '-6 hours') >= date('now', '-6 hours', 'weekday 0', '-6 days')
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

    // High churn risk customers — ACTIONABLE only. Previously the panel showed 10 random
    // high-churn-score customers including "Guest checkout" entries the system literally
    // cannot SMS. Now filtered to customers with a real first name AND sms_eligible, so
    // every row is something Drew can actually route into a campaign. Also prefers
    // high-LTV customers over random lapsed ones — the panel becomes a triage queue.
    env.DB.prepare(`
      SELECT id, first_name, phone, visit_count, total_lifetime_value,
             last_visit_date, churn_risk_score, favorite_sku, segment
      FROM retail_customers
      WHERE churn_risk_score >= 75
        AND sms_eligible = 1
        AND first_name IS NOT NULL
        AND LENGTH(TRIM(first_name)) >= 2
        AND LOWER(first_name) NOT IN ('guest checkout','visa cardholder','mastercard','cardholder','card holder','test','guest','customer','unknown','n/a','none','online order','valued customer')
        AND first_name NOT GLOB '+*'
        AND first_name NOT GLOB '1[0-9]*'
      ORDER BY total_lifetime_value DESC LIMIT 10
    `).all(),

    // Cached weekly insight
    env.KV.get('retail_weekly_insight'),

    // Top 10 customers by lifetime value — actionable names only. Same filter logic as
    // churn watch so the panel becomes a triage queue (suggested_action computed below).
    env.DB.prepare(`
      SELECT id, first_name, visit_count, total_lifetime_value,
             last_visit_date, segment, favorite_sku, churn_risk_score,
             predicted_clv, churn_probability_7d
      FROM retail_customers
      WHERE first_name IS NOT NULL
        AND LENGTH(TRIM(first_name)) >= 2
        AND LOWER(first_name) NOT IN ('guest checkout','visa cardholder','mastercard','cardholder','card holder','test','guest','customer','unknown','n/a','none','online order','valued customer')
        AND first_name NOT GLOB '+*'
        AND first_name NOT GLOB '1[0-9]*'
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

  // Last week metrics for delta — full prior Mon-Sun MT (matches new hero's prior_week)
  const lastWeek = await env.DB.prepare(`
    SELECT SUM(gross_revenue) as revenue, AVG(gross_revenue) as avg_ticket
    FROM orders WHERE date(order_date, '-6 hours') >= date('now', '-6 hours', 'weekday 0', '-13 days')
      AND date(order_date, '-6 hours') < date('now', '-6 hours', 'weekday 0', '-6 days')
  `).first();

  // Annotate each top-customer / churn-watch row with a suggested_action so the dashboard
  // surfaces WHAT TO DO with each name instead of being a passive leaderboard. The action
  // maps to the 5-tier consolidated model (migration 025):
  //   visit_count >= 10 + churned/lapsed → Platinum dossier (manual per-customer)
  //   visit_count 4-9 + churned/lapsed → Gold Win-Back (auto-enrolled by cron)
  //   visit_count = 1 + churned/lapsed → Singles Lapsed (auto-enrolled)
  //   high churn_probability + CLV in range → Silver Save (auto-enrolled)
  //   active VIP (visit >= 6, not lapsed) → "keep warm — no action needed"
  // For auto-enrolled paths we also surface whether they're already in the campaign via
  // `campaign_status` so Drew knows if he needs to do anything or if the system's on it.
  const customerIds = [
    ...(churnWatch.results || []).map(c => c.id),
    ...(topCustomers.results || []).map(c => c.id),
  ];
  const uniqueIds = [...new Set(customerIds)];
  let enrollmentMap = {};
  if (uniqueIds.length > 0) {
    const placeholders = uniqueIds.map(() => '?').join(',');
    const enrollRows = await env.DB.prepare(`
      SELECT rcs.customer_id, rc.campaign_type, rc.name as campaign_name, rcs.sent_at, rcs.outcome
      FROM retail_campaign_sends rcs
      JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      WHERE rcs.customer_id IN (${placeholders})
        AND rcs.sent_at >= datetime('now','-180 days')
      ORDER BY rcs.sent_at DESC
    `).bind(...uniqueIds).all().catch(() => ({ results: [] }));
    for (const r of (enrollRows.results || [])) {
      if (!enrollmentMap[r.customer_id]) enrollmentMap[r.customer_id] = [];
      enrollmentMap[r.customer_id].push(r);
    }
  }
  const annotate = (c) => {
    const isLapsedOrChurned = c.segment === 'lapsed' || c.segment === 'churned';
    const enrollments = enrollmentMap[c.id] || [];
    const inGold = enrollments.some(e => e.campaign_type === 'winback_gold');
    const inSilver = enrollments.some(e => e.campaign_type === 'winback_silver');
    const inSingles = enrollments.some(e => e.campaign_type === 'winback_singles');
    const inPlatinum = enrollments.some(e => e.campaign_type === 'winback_platinum');
    const inBronze = enrollments.some(e => e.campaign_type === 'winback_bronze');
    const inRecovery = enrollments.some(e => e.campaign_type === 'winback_recovery');
    const inLastCall = enrollments.some(e => e.campaign_type === 'winback_lastcall');
    const mostRecentCampaign = enrollments[0]?.campaign_name || null;
    const daysSinceVisit = c.last_visit_date
      ? Math.floor((Date.now() - new Date(c.last_visit_date).getTime()) / 86400000)
      : null;
    let suggested_action = null;
    let action_campaign = null;
    let campaign_status = null;
    if (isLapsedOrChurned) {
      if (c.visit_count >= 10) {
        suggested_action = inPlatinum ? 'In Platinum dossier' : 'Platinum candidate — send dossier';
        action_campaign = 'platinum_winback_2026';
        campaign_status = inPlatinum ? 'enrolled' : 'not_enrolled';
      } else if (c.visit_count >= 4 && c.visit_count <= 9) {
        suggested_action = inGold ? 'In Gold Win-Back' : 'Gold candidate — next cron run';
        action_campaign = 'winback_gold';
        campaign_status = inGold ? 'enrolled' : 'not_enrolled';
      } else if (c.visit_count >= 2 && c.visit_count <= 3) {
        // Bronze covers 2-3 visit lapsed 30-180d
        if (daysSinceVisit !== null && daysSinceVisit >= 30 && daysSinceVisit <= 180) {
          suggested_action = inBronze ? 'In Bronze Save' : 'Bronze candidate — next cron run';
          action_campaign = 'winback_bronze';
          campaign_status = inBronze ? 'enrolled' : 'not_enrolled';
        }
      } else if (c.visit_count === 1) {
        if (daysSinceVisit !== null && daysSinceVisit >= 30 && daysSinceVisit <= 180) {
          suggested_action = inSingles ? 'In Singles Lapsed' : 'Singles candidate — next cron run';
          action_campaign = 'winback_singles';
          campaign_status = inSingles ? 'enrolled' : 'not_enrolled';
        }
      }
      // Recovery covers 2+ visits 61-180d — only applies if Gold/Bronze hasn't claimed them
      if (!suggested_action && c.visit_count >= 2 && daysSinceVisit !== null && daysSinceVisit >= 61 && daysSinceVisit <= 180) {
        suggested_action = inRecovery ? 'In Churn Recovery' : 'Recovery candidate — next cron run';
        action_campaign = 'winback_recovery';
        campaign_status = inRecovery ? 'enrolled' : 'not_enrolled';
      }
      // Last Call covers 1+ visits 181-365d (cold)
      if (!suggested_action && c.visit_count >= 1 && daysSinceVisit !== null && daysSinceVisit >= 181 && daysSinceVisit <= 365) {
        suggested_action = inLastCall ? 'In Last Call' : 'Last Call candidate (campaign is draft)';
        action_campaign = 'winback_lastcall';
        campaign_status = inLastCall ? 'enrolled' : 'not_enrolled';
      }
      // Silver: churn_prob + CLV band — last resort if no other tier matched
      if (!suggested_action && c.churn_probability_7d >= 0.7 && c.predicted_clv >= 50 && c.predicted_clv <= 100) {
        suggested_action = inSilver ? 'In Silver Save' : 'Silver candidate — next cron run';
        action_campaign = 'winback_silver';
        campaign_status = inSilver ? 'enrolled' : 'not_enrolled';
      }
      // Terminal: 365d+ or doesn't match any criteria
      if (!suggested_action) {
        if (daysSinceVisit !== null && daysSinceVisit > 365) {
          suggested_action = 'Cold (365d+) — outside all campaigns';
        } else {
          suggested_action = 'No campaign match — check criteria';
        }
        campaign_status = 'no_campaign';
      }
    } else if (c.segment === 'vip' || c.visit_count >= 6) {
      suggested_action = 'Keep warm — no action';
      campaign_status = 'healthy';
    } else if (c.segment === 'new' || c.visit_count === 1) {
      suggested_action = 'New — in Welcome drip if eligible';
      campaign_status = 'onboarding';
    }
    return { ...c, suggested_action, action_campaign, campaign_status, most_recent_campaign: mostRecentCampaign };
  };

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
    churn_watch: (churnWatch.results || []).map(annotate),
    top_customers: (topCustomers.results || []).map(annotate),
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

// Enriched campaign list for the merged CAMPAIGNS UI section. Returns every campaign
// (all statuses, all modes) with rolling stats + variants + discount + cohort_count
// pre-computed. Also returns counts summary so the frontend can render status filter
// tabs without a separate query.
//
// cohort_count is expensive-ish (one COUNT per active+draft condition campaign), so it
// only runs for campaigns where it's meaningful. Non-condition campaigns get null.
async function getCampaignsEnriched(env) {
  const campaigns = await env.DB.prepare(
    'SELECT * FROM retail_campaigns ORDER BY created_at DESC'
  ).all();

  const results = [];
  const counts = { all: 0, active: 0, draft: 0, paused: 0, archived: 0, pending_approval: 0, completed: 0 };

  for (const c of (campaigns.results || [])) {
    counts.all++;
    counts[c.status] = (counts[c.status] || 0) + 1;

    // Variants (if A/B configured)
    const variants = await env.DB.prepare(
      'SELECT id, variant_label, total_sent, total_returned, total_optouts, total_revenue, weight, active FROM retail_campaign_variants WHERE campaign_id = ?'
    ).bind(c.id).all().catch(() => ({ results: [] }));

    // Discount (most recent active template row)
    const discount = await env.DB.prepare(
      "SELECT code, discount_type, amount, times_redeemed FROM retail_campaign_discounts WHERE campaign_id = ? AND status = 'active' LIMIT 1"
    ).bind(c.id).first().catch(() => null);

    // Cost / ROI (only meaningful if we have a redeemed discount)
    const discountCost = discount ? (discount.times_redeemed || 0) * (discount.discount_type === 'FIXED_AMOUNT' ? discount.amount / 100 : 0) : 0;

    // Cohort count — only for active/draft condition campaigns (where criteria are well-defined)
    let cohort_count = null;
    if ((c.status === 'active' || c.status === 'draft') && c.trigger_type === 'condition') {
      try {
        const { where, binds } = buildEligibilityQuery(c);
        const cohort = await env.DB.prepare(`
          SELECT COUNT(*) as cnt FROM retail_customers WHERE ${where}
        `).bind(...binds).first();
        cohort_count = cohort?.cnt || 0;
      } catch (err) {
        console.error(`[getCampaignsEnriched] cohort count failed for ${c.id}:`, err.message);
      }
    }

    results.push({
      ...c,
      variants: variants.results || [],
      discount,
      cohort_count,
      cost: {
        discount_cost: Math.round(discountCost * 100) / 100,
        revenue_attributed: c.rolling_30d_revenue || 0,
        roi: discountCost > 0 ? Math.round(((c.rolling_30d_revenue || 0) / discountCost) * 100) / 100 : null,
      },
      rolling_7d: {
        sent: c.rolling_7d_sent || 0,
        returned: c.rolling_7d_returned || 0,
        optouts: c.rolling_7d_optouts || 0,
        return_rate: (c.rolling_7d_sent || 0) > 0 ? Math.round((c.rolling_7d_returned / c.rolling_7d_sent) * 100) : null,
      },
      rolling_30d: {
        sent: c.rolling_30d_sent || 0,
        returned: c.rolling_30d_returned || 0,
        revenue: c.rolling_30d_revenue || 0,
        return_rate: (c.rolling_30d_sent || 0) > 0 ? Math.round((c.rolling_30d_returned / c.rolling_30d_sent) * 100) : null,
      },
    });
  }

  return jsonResponse({ campaigns: results, counts });
}

// Activate a draft campaign. Flips status='active' only if currently 'draft' — race-safe.
// Returns 404 if not found, 409 if not draft (so double-click doesn't re-trigger).
async function activateDraftCampaign(campaignId, env) {
  const existing = await env.DB.prepare('SELECT id, name, status FROM retail_campaigns WHERE id = ?').bind(campaignId).first();
  if (!existing) return jsonResponse({ error: 'Campaign not found' }, 404);
  if (existing.status !== 'draft') return jsonResponse({ error: `Campaign is ${existing.status}, cannot activate`, current_status: existing.status }, 409);

  await env.DB.prepare(`
    UPDATE retail_campaigns
    SET status = 'active', paused_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND status = 'draft'
  `).bind(campaignId).run();

  const updated = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaignId).first();
  console.log(`[retail] Activated campaign '${existing.name}' (${campaignId})`);
  return jsonResponse({ campaign: updated, note: `Activated '${existing.name}'. Next cron run will enroll the cohort.` });
}

// Preview cohort for a campaign — runs the same eligibility SQL that processConditionCampaigns
// would use, but returns only COUNT + 5 samples. Non-destructive. Works for both active and
// draft campaigns.
async function previewCampaignCohort(campaignId, env) {
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);
  if (campaign.trigger_type !== 'condition') {
    return jsonResponse({
      error: 'Preview only works for condition-triggered campaigns',
      trigger_type: campaign.trigger_type,
    }, 400);
  }

  const { where, binds } = buildEligibilityQuery(campaign);

  // Count + sample in parallel
  const [count, sample] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM retail_customers WHERE ${where}`).bind(...binds).first(),
    env.DB.prepare(`
      SELECT id, first_name, visit_count, last_visit_date, favorite_sku, predicted_clv, segment, churn_probability_7d
      FROM retail_customers
      WHERE ${where}
      ORDER BY predicted_clv DESC
      LIMIT 5
    `).bind(...binds).all(),
  ]);

  // Build a human-readable criteria summary from trigger_config
  let config = {};
  try { config = JSON.parse(campaign.trigger_config || '{}'); } catch {}
  const conditions = config.conditions || {};
  const summaryParts = [];
  if (conditions.visit_count_eq !== undefined) summaryParts.push(`${conditions.visit_count_eq} visit${conditions.visit_count_eq === 1 ? '' : 's'}`);
  else if (conditions.visit_count_min !== undefined && conditions.visit_count_max !== undefined) summaryParts.push(`${conditions.visit_count_min}-${conditions.visit_count_max} visits`);
  else if (conditions.visit_count_min !== undefined) summaryParts.push(`${conditions.visit_count_min}+ visits`);
  if (conditions.days_since_last_visit_min !== undefined && conditions.days_since_last_visit_max !== undefined) {
    summaryParts.push(`${conditions.days_since_last_visit_min}-${conditions.days_since_last_visit_max}d since visit`);
  } else if (conditions.days_since_last_visit_min !== undefined) {
    summaryParts.push(`${conditions.days_since_last_visit_min}d+ lapsed`);
  }
  if (conditions.momentum_below !== undefined) summaryParts.push(`momentum <${conditions.momentum_below}`);
  const churnMinVal = conditions.churn_probability_min ?? conditions.churn_probability_7d_min;
  if (churnMinVal !== undefined) summaryParts.push(`churn ≥${Math.round(churnMinVal * 100)}%`);
  const clvMinVal = conditions.predicted_clv_min ?? conditions.min_predicted_clv;
  if (clvMinVal !== undefined && conditions.predicted_clv_max !== undefined) summaryParts.push(`CLV $${clvMinVal}-${conditions.predicted_clv_max}`);

  return jsonResponse({
    campaign_id: campaignId,
    campaign_name: campaign.name,
    status: campaign.status,
    eligible_count: count?.cnt || 0,
    daily_send_limit: campaign.daily_send_limit,
    criteria_summary: summaryParts.join(' · ') || 'No criteria set',
    sample: (sample.results || []).map(c => ({
      first_name: c.first_name,
      visit_count: c.visit_count,
      favorite_sku: c.favorite_sku,
      segment: c.segment,
      days_since_visit: c.last_visit_date ? Math.floor((Date.now() - new Date(c.last_visit_date).getTime()) / 86400000) : null,
      predicted_clv: c.predicted_clv,
    })),
  });
}

// Next Cron Queue — preview what the 2pm MT daily cron will enroll tomorrow. Replaces
// the old Churn Watch panel (which showed customers no campaign actually targeted).
// Returns per-campaign eligible_count + expected_sends_tomorrow (min of eligible vs
// daily_send_limit). Honors the weekend-skip rule from processConditionCampaigns.
async function getNextCronQueue(env) {
  const campaigns = await env.DB.prepare(`
    SELECT * FROM retail_campaigns
    WHERE trigger_type = 'condition'
      AND status IN ('active', 'draft')
    ORDER BY created_at DESC
  `).all();

  // Weekend-skip mirror: processConditionCampaigns bails on Sat/Sun MT.
  const mtDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'short' });
  const weekendPause = (mtDay === 'Sat' || mtDay === 'Sun');

  const queues = [];
  for (const c of (campaigns.results || [])) {
    let eligibleCount = 0;
    try {
      const { where, binds } = buildEligibilityQuery(c);
      const r = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM retail_customers WHERE ${where}`).bind(...binds).first();
      eligibleCount = r?.cnt || 0;
    } catch (err) {
      console.error(`[next-cron-queue] query failed for ${c.id}:`, err.message);
    }

    // Criteria summary (same helper logic as preview-cohort)
    let config = {};
    try { config = JSON.parse(c.trigger_config || '{}'); } catch {}
    const conds = config.conditions || {};
    const sumParts = [];
    if (conds.visit_count_eq !== undefined) sumParts.push(`${conds.visit_count_eq}v`);
    else if (conds.visit_count_min !== undefined && conds.visit_count_max !== undefined) sumParts.push(`${conds.visit_count_min}-${conds.visit_count_max}v`);
    else if (conds.visit_count_min !== undefined) sumParts.push(`${conds.visit_count_min}+v`);
    if (conds.days_since_last_visit_min !== undefined && conds.days_since_last_visit_max !== undefined) {
      sumParts.push(`${conds.days_since_last_visit_min}-${conds.days_since_last_visit_max}d lapsed`);
    } else if (conds.days_since_last_visit_min !== undefined) {
      sumParts.push(`${conds.days_since_last_visit_min}d+ lapsed`);
    }
    if (conds.momentum_below !== undefined) sumParts.push(`momentum<${conds.momentum_below}`);
    const chMin = conds.churn_probability_min ?? conds.churn_probability_7d_min;
    if (chMin !== undefined) sumParts.push(`churn≥${Math.round(chMin * 100)}%`);

    const limit = c.daily_send_limit || 10;
    queues.push({
      campaign_id: c.id,
      campaign_name: c.name,
      campaign_type: c.campaign_type,
      status: c.status,
      is_draft: c.status === 'draft',
      daily_send_limit: limit,
      eligible_count: eligibleCount,
      expected_sends_tomorrow: weekendPause ? 0 : Math.min(eligibleCount, limit),
      criteria_summary: sumParts.join(' · ') || '—',
    });
  }

  // Sort: active first then draft, each group by eligible_count desc
  queues.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return (b.eligible_count || 0) - (a.eligible_count || 0);
  });

  return jsonResponse({
    scheduled_for: 'Daily 2pm MT',
    weekend_pause: weekendPause,
    total_expected_sends_tomorrow: queues.reduce((s, q) => s + (q.expected_sends_tomorrow || 0), 0),
    queues,
  });
}

// Regenerate the Weekly Insight on demand. Background-launches generateWeeklyInsight via
// ctx.waitUntil (it takes 20-40s — exceeds the 30s request budget). Frontend polls
// /retail/insight to detect the new generated_at and re-render.
async function regenerateWeeklyInsight(env, ctx) {
  const brainContext = await loadBrain(env, 'retail');
  // Fire-and-forget — generate runs in background, writes to KV + retail_insights when done.
  ctx.waitUntil(
    generateWeeklyInsight(env, brainContext).catch(err =>
      console.error('[retail] regenerate weekly insight failed:', err.message)
    )
  );
  return jsonResponse({
    status: 'regenerating',
    note: 'Weekly insight regeneration started. Poll /retail/insight in 10-30s for result.',
  });
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

// External campaign — Square Marketing or any other third-party email/SMS service handles
// the send; we only mint the discount code and track redemptions. The scheduler skips
// these (campaign_mode='external') since send orchestration lives outside our system.
//
// Body: { name, amount?, valid_days?, code_prefix?, max_redemptions?, agent_reasoning? }
//   amount in cents (default 800 = $8); discountType is always FIXED_AMOUNT for now.
//   code_prefix defaults to 'WELCOME' so customers see clean WELCOME8XXXX codes.
//
// Response: { campaign_id, code, square_catalog_id, valid_until, instructions }
async function createExternalCampaign(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.name) {
    return jsonResponse({ error: 'name is required' }, 400);
  }

  const campaignId = crypto.randomUUID();
  const amountCents = Number.isFinite(body.amount) ? body.amount : 800;
  const validDays = Number.isFinite(body.valid_days) ? body.valid_days : 30;
  const codePrefix = body.code_prefix || 'WELCOME';
  const maxRedemptions = body.max_redemptions || null;

  // 1. Insert the campaign row. campaign_mode='external' tells the scheduler to skip it.
  await env.DB.prepare(`
    INSERT INTO retail_campaigns (
      id, name, campaign_type, status, target_segment,
      send_strategy, daily_send_limit, approval_status,
      campaign_mode, agent_reasoning, code_prefix,
      created_at, updated_at
    ) VALUES (?, ?, 'email_winback_square', 'active', 'square_marketing_audience',
      'external', 0, 'approved',
      'external', ?, ?,
      datetime('now'), datetime('now'))
  `).bind(
    campaignId,
    body.name,
    body.agent_reasoning || 'Square Marketing handles audience + send. We mint code + track redemption.',
    codePrefix,
  ).run();

  // 2. Mint the Square discount code via existing helper. Reuses createSquareDiscount() so
  //    Square gets a real DISCOUNT catalog object and our DB tracks redemptions.
  const discount = await createSquareDiscount(env, {
    campaignId,
    discountType: 'FIXED_AMOUNT',
    amount: amountCents,
    validDays,
    maxRedemptions,
    codePrefix,
  });

  return jsonResponse({
    campaign_id: campaignId,
    code: discount.code,
    square_catalog_id: discount.squareCatalogId,
    valid_until: discount.validUntil,
    discount_amount_dollars: amountCents / 100,
    instructions: [
      '1. Open Square Dashboard → Marketing → Create Campaign → Email.',
      '2. Audience: choose "Lapsed Customers" or build a custom segment for first-time customers (1 visit) who have not returned in 30+ days.',
      `3. Promo: paste the code "${discount.code}" into the email body. Example: "Your free pretzel + dip ($${amountCents / 100} off) is waiting — show code ${discount.code} at the counter."`,
      '4. Send/schedule the campaign. Square handles every send.',
      '5. Redemptions auto-tracked: when a customer uses the code at POS, our Square webhook flows it into retail_campaign_discounts.times_redeemed and the dashboard scoreboard.',
      `6. Code expires ${discount.validUntil}. Re-run this endpoint to mint a fresh code with the same campaign_id (or a new one) when the campaign refreshes.`,
    ],
    square_error: discount.squareError || null,
  });
}

// Probes Square's API surface for marketing-adjacent capabilities. Square's public Marketing
// API for email campaigns is undocumented / merchant-specific — we don't know until we hit
// the endpoints with this account's token whether they return 200, 401, 403, or 404. Returns
// a status-code map so we know which integration path is viable.
// Count Square customers reachable via email vs. our D1 (which only syncs customers
// referenced on orders). Helps decide whether Path A (build our own email pipeline using
// Square's full customer DB) is worth the effort vs. SMS-only.
async function probeSquareCustomerReach(env) {
  let cursor = null;
  let total = 0, with_email = 0, email_subscribed = 0, with_phone = 0;
  let pages = 0;
  // No cap — count every customer in Square. ~30s for 5k customers; D1 D1 is read-only here.
  while (true) {
    const body = { limit: 100 };
    if (cursor) body.cursor = cursor;
    const resp = await fetch(`${SQUARE_API_BASE}/customers/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2024-10-17',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text();
      return jsonResponse({ error: `Square /customers/search ${resp.status}`, body: err.slice(0, 500) }, 500);
    }
    const data = await resp.json();
    const customers = data.customers || [];
    for (const c of customers) {
      total++;
      if (c.email_address) {
        with_email++;
        if (c.preferences?.email_unsubscribed === false) email_subscribed++;
      }
      if (c.phone_number) with_phone++;
    }
    cursor = data.cursor || null;
    pages++;
    if (!cursor) break;
  }
  return jsonResponse({
    pages_probed: pages,
    total_seen: total,
    with_email,
    email_subscribed,
    with_phone,
    note: 'Capped at 500 customers for probe; cursor was ' + (cursor ? 'NOT yet exhausted (more customers exist)' : 'exhausted (this is your full count)'),
    cursor_remaining: cursor !== null,
  });
}

// Probe Square Labor API to see if our access token has scope for shifts + wages.
// Used to determine if we can auto-pull daily payroll for the Mon-Thu close analysis.
async function probeSquareLabor(env) {
  const probes = [
    { name: 'team_members_search', method: 'POST', path: '/v2/team-members/search', body: { query: { filter: { status: 'ACTIVE' } } }, version: '2025-05-21' },
    { name: 'shifts_search_one_with_full_payload', method: 'POST', path: '/v2/labor/shifts/search', body: { query: { filter: { start: { start_at: new Date(Date.now() - 28*86400000).toISOString() } } }, limit: 1 }, version: '2025-05-21', dump_full: true },
    { name: 'jobs_list_v2', method: 'GET', path: '/v2/team-members/jobs', version: '2025-05-21' },
  ];
  const results = [];
  for (const probe of probes) {
    try {
      const init = {
        method: probe.method,
        headers: {
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': probe.version || '2024-10-17',
        },
      };
      if (probe.body) init.body = JSON.stringify(probe.body);
      const resp = await fetch(`https://connect.squareup.com${probe.path}`, init);
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 300) }; }
      results.push({
        name: probe.name,
        status: resp.status,
        ok: resp.ok,
        sample: probe.dump_full ? JSON.stringify(data).slice(0, 1500) :
                resp.ok ? (Array.isArray(data.team_members) ? `${data.team_members.length} team members, first: ${data.team_members[0]?.given_name}` :
                          Array.isArray(data.shifts) ? `${data.shifts.length} shifts` :
                          Array.isArray(data.jobs) ? `${data.jobs.length} jobs: ${data.jobs.map(j=>j.title).join(', ')}` :
                          JSON.stringify(data).slice(0, 200)) : (data.errors ? JSON.stringify(data.errors).slice(0, 200) : text.slice(0, 200)),
      });
    } catch (err) {
      results.push({ name: probe.name, error: err.message });
    }
  }
  return jsonResponse({ probes: results });
}

// Daily Square payroll summary by role for the Mon-Thu close analysis.
// Requires the labor probe to confirm scope first. Aggregates: total hours, total $ cost
// (hours × hourly_rate) per role (FOH/BOH/manager) per day, last N days.
// Drew's roles map: derive from team_member.assigned_jobs OR from a manual override.
async function squareLaborDailySummary(env, url) {
  const days = parseInt(url.searchParams.get('days') || '28');
  const startISO = new Date(Date.now() - days * 86400000).toISOString();

  // Pull shifts in window. Each shift carries wage.title + wage.hourly_rate inline, so we
  // don't need a separate team-member lookup. Paginate via cursor.
  let shifts = [];
  let cursor;
  let pages = 0;
  do {
    const body = { query: { filter: { start: { start_at: startISO } } }, limit: 200 };
    if (cursor) body.cursor = cursor;
    const shResp = await fetch('https://connect.squareup.com/v2/labor/shifts/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-05-21' },
      body: JSON.stringify(body),
    });
    const shData = await shResp.json();
    if (!shResp.ok) return jsonResponse({ error: 'shifts fetch failed', detail: shData }, 500);
    shifts = shifts.concat(shData.shifts || []);
    cursor = shData.cursor;
    pages++;
    if (pages > 50) break; // safety cap
  } while (cursor);

  // Map wage.title → role bucket
  function roleForTitle(title) {
    const t = (title || '').toLowerCase();
    if (/manager|owner/.test(t)) return 'manager';
    if (/back of house|boh|kitchen|prep|cook/.test(t)) return 'boh';
    return 'foh'; // FOH / Server / default
  }

  // Aggregate by MT-day + role
  const byDayRole = {};
  const dowAgg = {};
  for (const s of shifts) {
    if (!s.start_at) continue;
    const startMs = new Date(s.start_at).getTime();
    const endMs = s.end_at ? new Date(s.end_at).getTime() : Date.now();
    const hours = Math.max(0, (endMs - startMs) / 3600000);
    if (hours <= 0) continue;
    const wage = parseFloat(s.wage?.hourly_rate?.amount || 0) / 100;
    const cost = hours * wage;
    const role = roleForTitle(s.wage?.title);

    // MT day key — shift's start_at is already in local TZ ('America/Denver' isoformat)
    const day = s.start_at.slice(0, 10);
    const dow = new Date(s.start_at).getUTCDay(); // 0=Sun
    const dowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];

    if (!byDayRole[day]) byDayRole[day] = { dow: dowName };
    if (!byDayRole[day][role]) byDayRole[day][role] = { hours: 0, cost: 0, shifts: 0 };
    byDayRole[day][role].hours += hours;
    byDayRole[day][role].cost += cost;
    byDayRole[day][role].shifts += 1;

    if (!dowAgg[dowName]) dowAgg[dowName] = { hours_total: 0, cost_total: 0, foh_cost: 0, boh_cost: 0, mgr_cost: 0, days_observed: new Set() };
    dowAgg[dowName].hours_total += hours;
    dowAgg[dowName].cost_total += cost;
    dowAgg[dowName][role === 'manager' ? 'mgr_cost' : (role === 'boh' ? 'boh_cost' : 'foh_cost')] += cost;
    dowAgg[dowName].days_observed.add(day);
  }

  // Format daily output
  const days_sorted = Object.keys(byDayRole).sort();
  const daily = days_sorted.map(d => ({
    day: d,
    dow: byDayRole[d].dow,
    foh: byDayRole[d].foh || { hours: 0, cost: 0, shifts: 0 },
    boh: byDayRole[d].boh || { hours: 0, cost: 0, shifts: 0 },
    manager: byDayRole[d].manager || { hours: 0, cost: 0, shifts: 0 },
    total_hours: ((byDayRole[d].foh?.hours||0) + (byDayRole[d].boh?.hours||0) + (byDayRole[d].manager?.hours||0)),
    total_cost: ((byDayRole[d].foh?.cost||0) + (byDayRole[d].boh?.cost||0) + (byDayRole[d].manager?.cost||0)),
  }));

  // DOW averages (the key for Mon-Thu close analysis)
  const dow_avg = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(dn => {
    const a = dowAgg[dn];
    if (!a) return { dow: dn, days_observed: 0 };
    const dc = a.days_observed.size;
    return {
      dow: dn,
      days_observed: dc,
      avg_total_cost: dc ? Math.round(a.cost_total / dc) : 0,
      avg_total_hours: dc ? Math.round(a.hours_total / dc * 10) / 10 : 0,
      avg_foh_cost: dc ? Math.round(a.foh_cost / dc) : 0,
      avg_boh_cost: dc ? Math.round(a.boh_cost / dc) : 0,
      avg_mgr_cost: dc ? Math.round(a.mgr_cost / dc) : 0,
    };
  });

  return jsonResponse({
    days_returned: daily.length,
    shifts_total: shifts.length,
    daily,
    dow_avg,
  });
}

async function probeSquareMarketing(env) {
  const probes = [
    // Marketing campaigns API (most common naming)
    { name: 'marketing_campaigns_list', method: 'GET', path: '/marketing/campaigns' },
    // Customer segments — publicly documented; useful for audience definition
    { name: 'customer_segments_list', method: 'GET', path: '/customers/segments' },
    // Loyalty programs — adjacent feature, may be enabled
    { name: 'loyalty_programs_list', method: 'GET', path: '/loyalty/programs/main' },
    // Customer search — confirms baseline auth works
    { name: 'customers_count', method: 'POST', path: '/customers/search', body: { limit: 1 } },
  ];

  const results = [];
  for (const probe of probes) {
    try {
      const url = `${SQUARE_API_BASE}${probe.path}`;
      const init = {
        method: probe.method,
        headers: {
          'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-10-17',
        },
      };
      if (probe.body) init.body = JSON.stringify(probe.body);
      const resp = await fetch(url, init);
      let text = await resp.text();
      // Truncate body — we just need the error shape, not full payload
      const bodyPreview = text.slice(0, 400);
      results.push({
        name: probe.name,
        status: resp.status,
        ok: resp.ok,
        body_preview: bodyPreview,
      });
    } catch (err) {
      results.push({ name: probe.name, error: err.message });
    }
  }
  return jsonResponse({ probes: results, square_version: '2024-10-17' });
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

// ── SEND PATHS OBSERVABILITY ─────────────────────────────────────
// Returns sends-by-campaign + blocks-by-reason over last 30 days, plus collision
// detection (phones that received >1 SMS within 48h — should be 0 with guards on).
// Use to verify the daily cron is only firing through approved paths.
async function getSendPaths(env) {
  const [sendsByDay, sendsByCampaign, blocksByReason, blocksByDay, collisions, todayBlocks, cohortRaw, firstReturnsToday, returnsByDay, unredeemedReturns, redemptionSummary] = await Promise.all([
    env.DB.prepare(`
      SELECT date(sent_at) AS day, COUNT(*) AS cnt
      FROM retail_campaign_sends
      WHERE sent_at >= date('now', '-30 days') AND outcome IN ('delivered','returned')
      GROUP BY day ORDER BY day DESC
    `).all(),

    env.DB.prepare(`
      SELECT COALESCE(rc.name, 'unknown') AS campaign_name,
             rc.campaign_type,
             rc.status,
             COUNT(*) AS sends_30d,
             SUM(CASE WHEN rcs.sent_at >= date('now') THEN 1 ELSE 0 END) AS sends_today,
             SUM(CASE WHEN rcs.sent_at >= date('now', '-7 days') THEN 1 ELSE 0 END) AS sends_7d
      FROM retail_campaign_sends rcs
      LEFT JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      WHERE rcs.sent_at >= date('now', '-30 days') AND rcs.outcome = 'delivered'
      GROUP BY rc.id
      ORDER BY sends_30d DESC
    `).all(),

    env.DB.prepare(`
      SELECT reason, COUNT(*) AS cnt,
             SUM(CASE WHEN created_at >= date('now') THEN 1 ELSE 0 END) AS today,
             SUM(CASE WHEN created_at >= date('now', '-7 days') THEN 1 ELSE 0 END) AS last_7d
      FROM sms_send_blocks
      WHERE created_at >= date('now', '-30 days')
      GROUP BY reason ORDER BY cnt DESC
    `).all(),

    env.DB.prepare(`
      SELECT date(created_at) AS day, reason, COUNT(*) AS cnt
      FROM sms_send_blocks
      WHERE created_at >= date('now', '-30 days')
      GROUP BY day, reason ORDER BY day DESC, cnt DESC
    `).all(),

    // Collision detection: same customer receiving 2+ delivered sends within 48h.
    // This SHOULD be zero after the guards went live. If non-zero, investigate immediately.
    env.DB.prepare(`
      SELECT rcs.customer_id, COUNT(*) AS collision_count,
             GROUP_CONCAT(DISTINCT COALESCE(rc.name, 'unknown')) AS campaigns
      FROM retail_campaign_sends rcs
      LEFT JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      WHERE rcs.outcome = 'delivered'
        AND rcs.sent_at >= datetime('now', '-48 hours')
      GROUP BY rcs.customer_id
      HAVING collision_count > 1
      ORDER BY collision_count DESC
      LIMIT 20
    `).all(),

    env.DB.prepare(`
      SELECT id, phone_last4, reason, blocked_by, blocked_at_note, caller, message_preview, created_at
      FROM sms_send_blocks
      WHERE created_at >= date('now')
      ORDER BY created_at DESC
      LIMIT 50
    `).all(),

    // Cohort return-rate matrix: for each campaign with sends in last 30 days, compute
    // Day 1 / 3 / 7 / 14 return rate. Excludes A/B control arms + holdouts (they're
    // no-send tombstones).
    //
    // Eligibility rule: a send counts toward Day N cohort if EITHER (a) its sent_at is
    // >= N days ago (matured naturally) OR (b) it has already returned (an observed
    // return within N days is evidence, regardless of how fresh the send is). Without
    // (b), a fast-redemption welcome gets dropped from the numerator — which was the
    // Free Pretzel Welcome bug where 1 return in <24h showed as "0.0% day 1".
    // Returned = "sent_at + at most N days → returned_at exists" regardless of age.
    env.DB.prepare(`
      SELECT rc.id AS campaign_id,
             COALESCE(rc.name, 'unknown') AS campaign_name,
             rc.campaign_type,
             rc.status,
             MIN(rcs.sent_at) AS earliest_send,
             MAX(rcs.sent_at) AS latest_send,
             COUNT(*) AS total_sent,
             SUM(CASE WHEN julianday('now') - julianday(rcs.sent_at) >= 1 OR rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS eligible_day1,
             SUM(CASE WHEN rcs.returned_at IS NOT NULL AND julianday(rcs.returned_at) - julianday(rcs.sent_at) <= 1 THEN 1 ELSE 0 END) AS returned_day1,
             SUM(CASE WHEN julianday('now') - julianday(rcs.sent_at) >= 3 OR rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS eligible_day3,
             SUM(CASE WHEN rcs.returned_at IS NOT NULL AND julianday(rcs.returned_at) - julianday(rcs.sent_at) <= 3 THEN 1 ELSE 0 END) AS returned_day3,
             SUM(CASE WHEN julianday('now') - julianday(rcs.sent_at) >= 7 OR rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS eligible_day7,
             SUM(CASE WHEN rcs.returned_at IS NOT NULL AND julianday(rcs.returned_at) - julianday(rcs.sent_at) <= 7 THEN 1 ELSE 0 END) AS returned_day7,
             SUM(CASE WHEN julianday('now') - julianday(rcs.sent_at) >= 14 OR rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS eligible_day14,
             SUM(CASE WHEN rcs.returned_at IS NOT NULL AND julianday(rcs.returned_at) - julianday(rcs.sent_at) <= 14 THEN 1 ELSE 0 END) AS returned_day14,
             SUM(CASE WHEN rcs.ab_arm = 'control' THEN 1 ELSE 0 END) AS controls_held,
             SUM(CASE WHEN rcs.ab_arm = 'control' AND rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS controls_returned
      FROM retail_campaign_sends rcs
      JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      WHERE rcs.sent_at >= date('now', '-30 days')
        AND rcs.outcome IN ('delivered', 'returned')
        AND (rcs.ab_arm IS NULL OR rcs.ab_arm != 'control')
        AND rcs.variant_id != 'holdout'
      GROUP BY rc.id
      ORDER BY total_sent DESC
    `).all(),

    // First-returns today: count of campaign sends that were attributed a return today.
    // Powers the "First-returns today" pulse tile — the only healthy proof-of-life metric
    // when campaigns are young (< day 7).
    env.DB.prepare(`
      SELECT COUNT(*) AS cnt
      FROM retail_campaign_sends
      WHERE returned_at >= date('now')
        AND returned_at < date('now', '+1 day')
    `).first(),

    // Returns attributed per day (last 30d) — powers the green-dot overlay on the send chart.
    env.DB.prepare(`
      SELECT date(returned_at) AS day, COUNT(*) AS cnt
      FROM retail_campaign_sends
      WHERE returned_at >= date('now', '-30 days')
      GROUP BY day ORDER BY day DESC
    `).all(),

    // Discount-redemption gap: customers who came back (attributed return) but didn't
    // apply the discount code at POS. For each returned send with a tracked code, join
    // to retail_campaign_discounts.times_redeemed. A per-customer single-use code with
    // times_redeemed=0 AND status='active' means they came in WITHOUT applying it.
    // For shared codes (like DPE4YMX welcome), times_redeemed reflects total POS uses —
    // if 0, nobody in the welcome cohort applied it despite attributed returns.
    env.DB.prepare(`
      SELECT
        rcs.id AS send_id,
        rcs.customer_id,
        rcs.campaign_id,
        COALESCE(rc.name, 'unknown') AS campaign_name,
        rcs.sent_at,
        rcs.returned_at,
        rcs.return_order_value,
        rcs.discount_code,
        rcd.times_redeemed,
        rcd.max_redemptions,
        cust.first_name,
        cust.visit_count,
        cust.phone
      FROM retail_campaign_sends rcs
      LEFT JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
      LEFT JOIN retail_customers cust ON cust.id = rcs.customer_id
      LEFT JOIN retail_campaign_discounts rcd
        ON rcd.code = rcs.discount_code AND rcd.campaign_id = rcs.campaign_id
      WHERE rcs.returned_at IS NOT NULL
        AND rcs.returned_at >= date('now', '-30 days')
        AND rcs.discount_code IS NOT NULL
        AND (rcd.times_redeemed IS NULL OR rcd.times_redeemed = 0)
      ORDER BY rcs.returned_at DESC
      LIMIT 20
    `).all(),

    // Total attributed returns + total code redemptions in last 30d (for summary metric).
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM retail_campaign_sends
          WHERE returned_at >= date('now','-30 days') AND returned_at IS NOT NULL) AS returns_attributed,
        (SELECT COALESCE(SUM(return_order_value),0) FROM retail_campaign_sends
          WHERE returned_at >= date('now','-30 days') AND returned_at IS NOT NULL) AS revenue_attributed,
        (SELECT COALESCE(SUM(times_redeemed),0) FROM retail_campaign_discounts
          WHERE created_at >= date('now','-60 days')) AS codes_redeemed
    `).first(),
  ]);

  // Compute cohort return-rate cells with null sentinel for immature cohorts.
  // rate = returned / eligible; if eligible = 0, cohort hasn't matured yet → null.
  // Also require MIN_ELIGIBLE so a 1/1 observation doesn't display as "100%" — we
  // need enough mature sends for the rate to be informative. Early observed returns
  // are surfaced via the `returned` count; the rate stays null until the denominator
  // is meaningful.
  const MIN_ELIGIBLE = 5;
  const now = Date.now();
  const cohortRates = (cohortRaw.results || []).map(r => {
    const earliestMs = r.earliest_send ? new Date(r.earliest_send + 'Z').getTime() : now;
    const ageHours = Math.max(0, Math.round((now - earliestMs) / 3600000));
    const rate = (returned, eligible) =>
      eligible >= MIN_ELIGIBLE ? Math.round((returned / eligible) * 1000) / 10 : null;
    // Control-vs-treatment lift: only meaningful once both arms have >= 10 delivered.
    // Treatment rate uses the already-eligible day 1 numbers. Report as percentage-points.
    const treatmentRate = r.eligible_day1 > 0 ? r.returned_day1 / r.eligible_day1 : null;
    const controlRate = r.controls_held > 0 ? r.controls_returned / r.controls_held : null;
    const liftPp = (treatmentRate !== null && controlRate !== null)
      ? Math.round((treatmentRate - controlRate) * 1000) / 10
      : null;
    return {
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      campaign_type: r.campaign_type,
      status: r.status,
      age_hours: ageHours,
      total_sent: r.total_sent,
      day_1: { rate: rate(r.returned_day1, r.eligible_day1), returned: r.returned_day1, eligible: r.eligible_day1 },
      day_3: { rate: rate(r.returned_day3, r.eligible_day3), returned: r.returned_day3, eligible: r.eligible_day3 },
      day_7: { rate: rate(r.returned_day7, r.eligible_day7), returned: r.returned_day7, eligible: r.eligible_day7 },
      day_14: { rate: rate(r.returned_day14, r.eligible_day14), returned: r.returned_day14, eligible: r.eligible_day14 },
      treatment: { rate: treatmentRate !== null ? Math.round(treatmentRate * 1000) / 10 : null, eligible: r.eligible_day1 },
      control: { rate: controlRate !== null ? Math.round(controlRate * 1000) / 10 : null, eligible: r.controls_held },
      lift_pp: liftPp,
    };
  });

  return jsonResponse({
    generated_at: new Date().toISOString(),
    window: 'last 30 days',
    sends_by_day: sendsByDay.results || [],
    returns_by_day: returnsByDay.results || [],
    sends_by_campaign: sendsByCampaign.results || [],
    blocks_by_reason: blocksByReason.results || [],
    blocks_by_day: blocksByDay.results || [],
    collisions_48h: {
      count: (collisions.results || []).length,
      note: 'Should be 0. Any value > 0 means the 48h brand-fatigue guard missed a path.',
      offenders: collisions.results || [],
    },
    todays_blocks: todayBlocks.results || [],
    cohort_return_rates: cohortRates,
    first_returns_today: firstReturnsToday?.cnt || 0,
    redemption_gap: {
      returns_attributed: redemptionSummary?.returns_attributed || 0,
      codes_redeemed: redemptionSummary?.codes_redeemed || 0,
      revenue_attributed: redemptionSummary?.revenue_attributed || 0,
      unredeemed_count: (unredeemedReturns.results || []).length,
      note: 'Attributed returns = customers we messaged who came back within 14 days. Codes redeemed = discount actually applied at POS. The gap = customers who came back but paid full price.',
      unredeemed: (unredeemedReturns.results || []).map(r => ({
        send_id: r.send_id,
        campaign_name: r.campaign_name,
        first_name: r.first_name,
        visit_count: r.visit_count,
        sent_at: r.sent_at,
        returned_at: r.returned_at,
        return_order_value: r.return_order_value,
        discount_code: r.discount_code,
        times_redeemed: r.times_redeemed || 0,
      })),
    },
  });
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
// Swell SMS — uses the platform.swellcx.com /api/v1 flow: find/create contact by phone,
// then POST message to that contact. Matches the working pattern in outreach-agent.js.
// (The old api.swellcx.com endpoint returned 404 for every call and nothing ever sent.)
async function sendSwellSMS(phone, message, env, opts = {}) {
  const token = env.SWELLCX_API_KEY;
  if (!token) {
    console.error('[Retail] SWELLCX_API_KEY missing — cannot send SMS');
    return { success: false, error: 'missing_api_key' };
  }
  const SWELL_LOCATION_ID = 17640;
  try {
    // Normalize: strip non-digits + leading 1
    const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').replace(/^1/, '');
    if (cleanPhone.length !== 10) {
      return { success: false, error: `invalid_phone: ${phone}` };
    }

    // Observability helper — records the block to sms_send_blocks for dashboard visibility.
    // Best-effort: any DB error is swallowed so logging never prevents a legitimate block.
    const logBlock = async (reason, blockedBy, blockedAtNote) => {
      try {
        await env.DB.prepare(`
          INSERT INTO sms_send_blocks (id, phone_last4, reason, blocked_by, blocked_at_note, message_preview, caller, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          crypto.randomUUID(),
          cleanPhone.slice(-4),
          reason,
          blockedBy || null,
          blockedAtNote || null,
          String(message || '').slice(0, 120),
          opts.caller || null,
        ).run();
      } catch {}
    };

    // ── DEFENSIVE GUARD: suppression list ──
    // Defense-in-depth: callers should already check, but enforce here so NO path can
    // accidentally message a customer who replied STOP.
    if (!opts.bypassSuppression) {
      const sup = await env.DB.prepare(
        'SELECT phone FROM sms_suppressions WHERE phone = ?'
      ).bind(cleanPhone).first().catch(() => null);
      if (sup) {
        console.log(`[sendSwellSMS] Blocked — phone ${cleanPhone.slice(0, 6)}*** on suppression list`);
        await logBlock('suppressed', null, null);
        return { success: false, error: 'suppressed' };
      }
    }

    // ── DEFENSIVE GUARD: 48h brand-fatigue cross-campaign ──
    // Prevents collisions across independent send paths (Gold Win-Back yesterday +
    // Welcome today, etc.). If ANY retail_campaign_sends delivered row exists for this
    // phone in the last 48h, refuse. Platinum dossier can override via opts.bypassFatigueGuard.
    if (!opts.bypassFatigueGuard) {
      const recent = await env.DB.prepare(`
        SELECT rcs.sent_at, COALESCE(rc.name, 'unknown') AS campaign_name
        FROM retail_campaign_sends rcs
        LEFT JOIN retail_campaigns rc ON rc.id = rcs.campaign_id
        JOIN retail_customers rc2 ON rc2.id = rcs.customer_id
        WHERE rc2.normalized_phone = ?
          AND rcs.sent_at >= datetime('now', '-48 hours')
          AND rcs.outcome = 'delivered'
        ORDER BY rcs.sent_at DESC
        LIMIT 1
      `).bind(cleanPhone).first().catch(() => null);
      if (recent) {
        console.log(`[sendSwellSMS] Blocked — phone ${cleanPhone.slice(0, 6)}*** got "${recent.campaign_name}" at ${recent.sent_at} (<48h brand-fatigue)`);
        await logBlock('brand_fatigue_48h', recent.campaign_name, recent.sent_at);
        return { success: false, error: 'brand_fatigue_48h', blocked_by: recent.campaign_name, blocked_at: recent.sent_at };
      }
    }

    // ── DEFENSIVE GUARD: 30-day SMS hard cap (C.5b) ──
    // Protects against fatigue compounding across multiple campaigns: wave + Gold cron-fire
    // + Welcome reminder + another cron-fire = 4 SMS in 30d would hammer the relationship.
    // Configurable via env.SMS_30D_MAX_SENDS (default 3). Override via opts.bypass30dCap=true
    // for high-priority send paths (STOP confirmations, customer-service replies).
    if (!opts.bypass30dCap) {
      const maxIn30d = parseInt(env.SMS_30D_MAX_SENDS || '3', 10);
      const recent30d = await env.DB.prepare(`
        SELECT COUNT(*) as cnt FROM retail_campaign_sends rcs
        JOIN retail_customers rc2 ON rc2.id = rcs.customer_id
        WHERE rc2.normalized_phone = ?
          AND rcs.sent_at >= datetime('now', '-30 days')
          AND rcs.outcome IN ('delivered', 'sent')
      `).bind(cleanPhone).first().catch(() => ({ cnt: 0 }));
      const count = recent30d?.cnt || 0;
      if (count >= maxIn30d) {
        console.log(`[sendSwellSMS] Blocked — phone ${cleanPhone.slice(0, 6)}*** hit 30d cap (${count}/${maxIn30d})`);
        await logBlock('sms_30d_cap_hit', null, String(count));
        return { success: false, error: 'sms_30d_cap_hit', count, cap: maxIn30d };
      }
    }

    // ── DEFENSIVE GUARD: brand identification required ──
    // Every retail marketing SMS must identify the brand. Catches any new code path that
    // forgets to run validateSMS first (which was exactly the reengagement-path failure mode).
    const msgLower = String(message || '').toLowerCase();
    if (!msgLower.includes('dangerous pretzel') && !msgLower.includes('dangerouspretzel.com')) {
      console.error(`[sendSwellSMS] Blocked — SMS missing brand identification: ${String(message).slice(0, 80)}`);
      await logBlock('missing_brand_identification', null, null);
      return { success: false, error: 'missing_brand_identification' };
    }

    // ── DEFENSIVE GUARD: length ──
    if (String(message || '').length > 160) {
      console.error(`[sendSwellSMS] Blocked — SMS exceeds 160 chars: ${String(message).length}`);
      await logBlock('sms_too_long', null, String(String(message || '').length));
      return { success: false, error: 'sms_too_long', length: String(message).length };
    }

    // 1. Find existing Swell contact
    const searchResp = await fetch(
      `https://platform.swellcx.com/api/v1/contacts?token=${token}&phone=${cleanPhone}`,
      { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
    );
    const searchData = await searchResp.json().catch(() => ({}));
    let contactId = searchData.data?.[0]?.id;

    // 2. Create contact if missing
    if (!contactId) {
      const createResp = await fetch('https://platform.swellcx.com/api/v1/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          token,
          name: `Contact ${cleanPhone.slice(-4)}`,
          phone: cleanPhone,
          locations: [SWELL_LOCATION_ID],
          country_code: 'US',
        }),
      });
      const createData = await createResp.json().catch(() => ({}));
      contactId = createData.data?.id || createData.id;
      if (!contactId) {
        console.error('[Retail] Swell contact create failed:', JSON.stringify(createData).slice(0, 200));
        return { success: false, error: 'contact_create_failed' };
      }
    }

    // 3. Send message — Swell expects field name `message` (not `body`) and direction `outbound`.
    // (Outreach worker's legacy payload got a schema update on Swell's side — replicate the
    // corrected shape here.)
    const msgResp = await fetch('https://platform.swellcx.com/api/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        token,
        location_id: SWELL_LOCATION_ID,
        contact_id: contactId,
        message,
        direction: 'outbound',
      }),
    });

    if (!msgResp.ok) {
      const errText = await msgResp.text();
      const shortErr = `${msgResp.status} ${errText.slice(0, 200)}`;
      console.error('[Retail] Swell message error:', shortErr);
      return { success: false, status: msgResp.status, error: shortErr };
    }

    const result = await msgResp.json().catch(() => ({}));
    const messageId = result.data?.id || result.id;
    console.log(`[Retail] SMS sent to ${cleanPhone.slice(0, 6)}*** (Swell contact ${contactId}, msg ${messageId})`);
    return { success: true, contact_id: contactId, message_id: messageId };
  } catch (err) {
    console.error('[Retail] SMS error:', err.message);
    return { success: false, error: err.message };
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
  // Audit fix — prefer retail_customers.last_visit_date/first_visit_date for
  // customer counts. Square orders often lack customer_id (webhook fulfillment
  // phone attachment is only ~4%), so COUNT(DISTINCT customer_id) under-counts.
  // Fallback path: COALESCE(customer_id count, phone-keyed count).
  const [currentMonth, previousMonth, newThisMonth, newLastMonth, activeThisMonth, activeLastMonth] = await Promise.all([
    env.DB.prepare(`
      SELECT SUM(gross_revenue) as revenue, COUNT(*) as transactions,
             AVG(gross_revenue) as avg_ticket,
             COUNT(DISTINCT COALESCE(customer_id, customer_phone)) as unique_customers
      FROM orders WHERE order_date >= date('now', 'start of month')
    `).first(),
    env.DB.prepare(`
      SELECT SUM(gross_revenue) as revenue, COUNT(*) as transactions,
             AVG(gross_revenue) as avg_ticket,
             COUNT(DISTINCT COALESCE(customer_id, customer_phone)) as unique_customers
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
    // Active this month = customers whose last_visit_date falls in this month.
    env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_customers
      WHERE last_visit_date >= date('now', 'start of month')
    `).first(),
    env.DB.prepare(`
      SELECT COUNT(*) as count FROM retail_customers
      WHERE last_visit_date >= date('now', 'start of month', '-1 month')
        AND last_visit_date < date('now', 'start of month')
    `).first(),
  ]);
  // If retail_customers has real active counts, prefer them over order-derived.
  if (activeThisMonth?.count) currentMonth.unique_customers = activeThisMonth.count;
  if (activeLastMonth?.count) previousMonth.unique_customers = activeLastMonth.count;

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

// ══════════════════════════════════════════════════════════
// ── Square API helpers ───────────────────────────────────
// ══════════════════════════════════════════════════════════

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

async function squareApiPost(path, body, env) {
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

async function squareApiDelete(path, env) {
  const resp = await fetch(`${SQUARE_API_BASE}${path}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Square DELETE ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json().catch(() => ({}));
}

async function squareApiGet(path, env) {
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

// Generate a short random code like "A7X2"
function shortCode(len = 5) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Create a discount in Square Catalog and store in our DB.
// codePrefix lets us brand per-tier codes (DPG for Gold, DPS for Silver, DPF for Singles, etc.)
// so the cashier at the register sees a recognizable pattern and codes don't collide across tiers.
async function createSquareDiscount(env, { campaignId, discountType = 'FIXED_AMOUNT', amount = 500, validDays = 14, maxRedemptions = null, codePrefix = 'DP' }) {
  const code = `${codePrefix}${shortCode()}`; // e.g. DPG4K7NR or DPS9XP2M
  const id = crypto.randomUUID();
  const validUntil = new Date(Date.now() + validDays * 86400000).toISOString().split('T')[0];

  // Build discount_data based on type
  const discountData = {
    name: code,
    discount_type: discountType,
  };
  if (discountType === 'FIXED_AMOUNT') {
    discountData.amount_money = { amount, currency: 'USD' };
  } else {
    discountData.percentage = String(amount); // e.g. "50" for 50%
  }

  let squareCatalogId = null;
  let squareError = null;
  try {
    const result = await squareApiPost('/catalog/object', {
      idempotency_key: `discount_${campaignId}_${code}`, // stable key: if retried, same object returned
      object: {
        type: 'DISCOUNT',
        id: `#${code}`,
        discount_data: discountData,
      },
    }, env);
    squareCatalogId = result.catalog_object?.id || null;
    console.log(`[Retail] Created Square discount ${code} → ${squareCatalogId}`);
  } catch (err) {
    squareError = err.message;
    console.error(`[Retail] Square discount creation failed (${code}): ${err.message}`);
  }

  // Store in our DB regardless (so we know the code existed and can retry Square sync later).
  await env.DB.prepare(`
    INSERT INTO retail_campaign_discounts (id, campaign_id, square_catalog_id, code, discount_type, amount, max_redemptions, valid_until, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, campaignId, squareCatalogId, code, discountType, amount, maxRedemptions, validUntil,
    squareCatalogId ? 'active' : 'pending_square_sync'
  ).run();

  return { id, code, squareCatalogId, discountType, amount, validUntil, squareError };
}

// Emergency cleanup: delete Square catalog DISCOUNTs whose codes match our per-customer
// prefixes (DPG_, DPS_, DPF_, DPM_, DPPLT_) but are not tracked in our retail_campaign_discounts.
// These get orphaned if code generation races ahead of D1 inserts or if D1 rows are manually
// deleted. Safe to call repeatedly — no-op if there's nothing to clean.
async function cleanupSquareCatalogOrphans(env) {
  const TARGET_PREFIXES = ['DPG', 'DPS', 'DPF', 'DPM', 'DPPLT'];
  const results = { searched: 0, deleted: 0, kept_tracked: 0, errors: [] };
  try {
    // Search Square catalog for discount objects. Square's search-catalog-objects is paginated.
    let cursor = null;
    do {
      const body = {
        object_types: ['DISCOUNT'],
        include_deleted_objects: false,
        include_related_objects: false,
        limit: 100,
      };
      if (cursor) body.cursor = cursor;
      const resp = await squareApiPost('/catalog/search', body, env);
      const objs = resp.objects || [];
      results.searched += objs.length;
      for (const obj of objs) {
        const name = obj.discount_data?.name || '';
        const hasPrefix = TARGET_PREFIXES.some(p => name.startsWith(p));
        if (!hasPrefix) continue;
        // Is this code tracked in our DB?
        const tracked = await env.DB.prepare(
          'SELECT id FROM retail_campaign_discounts WHERE square_catalog_id = ?'
        ).bind(obj.id).first();
        if (tracked) { results.kept_tracked++; continue; }
        // Orphan — delete from Square
        try {
          await squareApiDelete(`/catalog/object/${obj.id}`, env);
          results.deleted++;
        } catch (e) {
          results.errors.push({ id: obj.id, name, error: e.message });
        }
        await sleep(100); // Square rate-limit courtesy
      }
      cursor = resp.cursor || null;
    } while (cursor);
  } catch (e) {
    results.errors.push({ phase: 'search', error: e.message });
  }
  console.log('[Retail] Square orphan cleanup:', JSON.stringify(results));
  return jsonResponse(results);
}

// Disable a Square catalog discount on redemption (single-use enforcement).
// Single-use means we DELETE the catalog object from Square after first redeem,
// so the same code can't be applied to a second order even if the customer shares it.
async function disableSquareDiscount(env, squareCatalogId) {
  if (!squareCatalogId) return { ok: false, reason: 'no_catalog_id' };
  try {
    await squareApiDelete(`/catalog/object/${squareCatalogId}`, env);
    console.log(`[Retail] Square discount ${squareCatalogId} disabled after redemption`);
    return { ok: true };
  } catch (err) {
    console.error(`[Retail] Failed to disable Square discount ${squareCatalogId}: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

// ══════════════════════════════════════════════════════════
// ── Campaign Detail + Quick Actions ──────────────────────
// ══════════════════════════════════════════════════════════

// Names that are clearly not real people — filter these out of campaign sends
const FAKE_NAMES = new Set([
  'visa cardholder', 'mastercard', 'amex', 'card holder', 'cardholder',
  'test', 'guest', 'customer', 'unknown', 'n/a', 'na', 'none', 'null',
  'doordash', 'uber eats', 'grubhub', 'postmates', 'online order',
]);

// Build SQL WHERE clause from campaign target criteria (shared across all queries)
function buildCriteriaWhere(campaign) {
  const criteria = campaign.target_criteria ? JSON.parse(campaign.target_criteria) : {};
  let where = "sms_eligible = 1";
  if (campaign.target_segment && campaign.target_segment !== 'all') {
    where += ` AND segment = '${campaign.target_segment}'`;
  }
  // Visit count filters
  if (criteria.min_visit_count) where += ` AND visit_count >= ${parseInt(criteria.min_visit_count)}`;
  if (criteria.visit_count) where += ` AND visit_count = ${parseInt(criteria.visit_count)}`;
  // Value filters
  if (criteria.min_ltv) where += ` AND total_lifetime_value >= ${parseFloat(criteria.min_ltv)}`;
  if (criteria.min_predicted_clv) where += ` AND predicted_clv >= ${parseFloat(criteria.min_predicted_clv)}`;
  // Churn/risk filters
  if (criteria.max_churn_score) where += ` AND churn_risk_score <= ${parseInt(criteria.max_churn_score)}`;
  if (criteria.churn_probability_min) where += ` AND churn_probability_7d >= ${parseFloat(criteria.churn_probability_min)}`;
  // Behavior filters
  if (criteria.max_sku_diversity) where += ` AND sku_diversity_score <= ${parseInt(criteria.max_sku_diversity)}`;
  if (criteria.momentum_below) where += ` AND momentum_score < ${parseInt(criteria.momentum_below)}`;
  if (criteria.is_group_buyer) where += ` AND is_group_buyer = 1`;
  // SKU-based targeting: match favorite_sku
  if (criteria.ordered_sku) {
    const skuMap = { 'Spicy Bee': 'SPICY-BEE', 'BBK': 'BBK', 'Saint': 'SAINT', 'Salty': 'SALTY', 'For The Kids': 'KIDS', 'Salty Bombs': 'BOMBS' };
    const dbSku = skuMap[criteria.ordered_sku] || criteria.ordered_sku;
    where += ` AND favorite_sku = '${dbSku}'`;
  }
  // Require real first_name for campaign sends (no nameless, no fake names)
  where += " AND first_name IS NOT NULL AND first_name != ''";
  where += " AND LOWER(first_name) NOT IN ('visa cardholder','mastercard','cardholder','card holder','test','guest','customer','unknown','n/a','none','online order')";
  // Minimum 1 visit for any campaign (never target 0-visit ghost records)
  if (!criteria.min_visit_count && !criteria.visit_count) {
    where += " AND visit_count > 0";
  }
  return where;
}

async function getCampaignDetail(campaignId, env) {
  // 1. Full campaign
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

  // 2. Recent sends joined with customer names
  const sends = await env.DB.prepare(`
    SELECT cs.id, cs.customer_id, cs.variant_id, cs.message_text, cs.sent_at,
           cs.outcome, cs.return_order_value, cs.days_to_return,
           rc.first_name, rc.visit_count, rc.favorite_sku, rc.behavior_type
    FROM retail_campaign_sends cs
    LEFT JOIN retail_customers rc ON rc.id = cs.customer_id
    WHERE cs.campaign_id = ?
    ORDER BY cs.sent_at DESC
    LIMIT 15
  `).bind(campaignId).all();

  // 3. Linked discount
  const discount = await env.DB.prepare(
    'SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(campaignId, 'active').first();

  // 4. Performance breakdown (if has sends)
  let performance = null;
  const totalSends = campaign.total_sent || 0;
  if (totalSends > 0) {
    // Return rate by drip step
    const byStep = await env.DB.prepare(`
      SELECT variant_id,
             COUNT(*) as sent,
             SUM(CASE WHEN outcome = 'returned' THEN 1 ELSE 0 END) as returned,
             AVG(CASE WHEN days_to_return IS NOT NULL THEN days_to_return ELSE NULL END) as avg_days
      FROM retail_campaign_sends
      WHERE campaign_id = ? AND variant_id != 'holdout'
      GROUP BY variant_id
    `).bind(campaignId).all();

    // Return rate by behavior type
    const byBehavior = await env.DB.prepare(`
      SELECT rc.behavior_type,
             COUNT(*) as sent,
             SUM(CASE WHEN cs.outcome = 'returned' THEN 1 ELSE 0 END) as returned
      FROM retail_campaign_sends cs
      JOIN retail_customers rc ON rc.id = cs.customer_id
      WHERE cs.campaign_id = ? AND cs.variant_id != 'holdout' AND rc.behavior_type IS NOT NULL
      GROUP BY rc.behavior_type
    `).bind(campaignId).all();

    // Best performing message
    const bestMsg = await env.DB.prepare(`
      SELECT message_text, COUNT(*) as sent,
             SUM(CASE WHEN outcome = 'returned' THEN 1 ELSE 0 END) as returned
      FROM retail_campaign_sends
      WHERE campaign_id = ? AND outcome IN ('delivered', 'returned') AND variant_id != 'holdout'
      GROUP BY message_text
      HAVING sent >= 3
      ORDER BY (CAST(returned AS REAL) / sent) DESC
      LIMIT 1
    `).bind(campaignId).first();

    performance = {
      by_step: (byStep.results || []).map(s => ({
        step: s.variant_id,
        sent: s.sent,
        returned: s.returned,
        return_rate: s.sent > 0 ? Math.round(s.returned / s.sent * 100) : 0,
        avg_days_to_return: s.avg_days ? Math.round(s.avg_days * 10) / 10 : null,
      })),
      by_behavior: (byBehavior.results || []).map(b => ({
        behavior: b.behavior_type,
        sent: b.sent,
        returned: b.returned,
        return_rate: b.sent > 0 ? Math.round(b.returned / b.sent * 100) : 0,
      })),
      best_message: bestMsg ? { text: bestMsg.message_text, return_rate: bestMsg.sent > 0 ? Math.round(bestMsg.returned / bestMsg.sent * 100) : 0 } : null,
    };
  }

  // 5. SMS previews — generate for 3 target customers (cached)
  let previews = [];
  try {
    const cached = await env.KV.get(`campaign_previews_${campaignId}`);
    if (cached) {
      previews = JSON.parse(cached);
    } else {
      // Find 3 target customers using consistent criteria
      const whereClause = buildCriteriaWhere(campaign);
      const targets = await env.DB.prepare(`
        SELECT * FROM retail_customers WHERE ${whereClause} ORDER BY RANDOM() LIMIT 3
      `).all();

      // Check for discount
      const discountForPreview = discount;
      for (const customer of (targets.results || [])) {
        try {
          let campaignForPreview = { ...campaign };
          if (discountForPreview) {
            // Add discount context to message_template
            const desc = discountForPreview.discount_type === 'FIXED_AMOUNT'
              ? `$${(discountForPreview.amount / 100).toFixed(0)} off`
              : `${discountForPreview.amount}% off`;
            campaignForPreview.message_template = (campaign.message_template || '') + ` Include discount code ${discountForPreview.code} for ${desc}.`;
          }
          const sms = await generateCampaignSMS(customer, campaignForPreview, env);
          previews.push({
            customer_name: customer.first_name || 'Customer',
            customer_id: customer.id,
            visits: customer.visit_count,
            favorite_sku: customer.favorite_sku,
            message: sms,
            char_count: sms.length,
          });
        } catch { /* skip on error */ }
      }
      // Cache for 1 hour
      if (previews.length > 0) {
        await env.KV.put(`campaign_previews_${campaignId}`, JSON.stringify(previews), { expirationTtl: 3600 });
      }
    }
  } catch (err) {
    console.error(`[Retail] Preview generation error: ${err.message}`);
  }

  // 6. Target customer list — the source of truth depends on trigger_type.
  //   - Event-triggered campaigns (Free Pretzel Welcome): show (a) real enrollees from
  //     retail_campaign_sends step-0, and (b) live-match count using the actual trigger_config
  //     conditions over the last 30 days. No more LTV-sorted lookalikes masquerading as targets.
  //   - Condition-triggered: show customers matching buildCriteriaWhere.
  //   - Untyped (legacy): show criteria-based preview with a disclaimer label.
  let targetCustomers = [];
  let targetingMeta = {
    mode: 'criteria',            // 'enrollees' | 'live_match' | 'criteria'
    label: 'Target customers',
    live_match_count: null,
    no_targets_message: null,
  };
  try {
    if (campaign.trigger_type === 'event') {
      // (a) Real enrollees — last 20 step-0 sends, newest first
      const enrollees = await env.DB.prepare(`
        SELECT rc.id, rc.first_name, rc.visit_count, rc.favorite_sku, rc.last_visit_date, rc.behavior_type,
               cs.sent_at as enrolled_at, cs.discount_code, cs.expires_at, cs.outcome
        FROM retail_campaign_sends cs
        JOIN retail_customers rc ON rc.id = cs.customer_id
        WHERE cs.campaign_id = ? AND cs.variant_id = 'drip_step_0'
        ORDER BY cs.sent_at DESC LIMIT 20
      `).bind(campaignId).all().catch(() => ({ results: [] }));
      targetCustomers = enrollees.results || [];
      targetingMeta.mode = 'enrollees';
      targetingMeta.label = 'Recent enrollees (real sends)';

      // (b) Live-match count — for wire-ops visibility: "N customers would trigger right now"
      let config = {};
      try { config = JSON.parse(campaign.trigger_config || '{}'); } catch {}
      const c = config.conditions || {};
      const whereParts = ['sms_eligible = 1'];
      if (c.visit_count_eq !== undefined) whereParts.push(`visit_count = ${Number(c.visit_count_eq)}`);
      if (c.visit_count_gte !== undefined) whereParts.push(`visit_count >= ${Number(c.visit_count_gte)}`);
      if (c.sms_consent_eq !== undefined) whereParts.push(`sms_consent = ${Number(c.sms_consent_eq)}`);
      if (c.sms_eligible_eq !== undefined) whereParts.push(`sms_eligible = ${Number(c.sms_eligible_eq)}`);
      if (c.acquisition_source_eq !== undefined) whereParts.push(`acquisition_source = '${String(c.acquisition_source_eq).replace(/'/g, "''")}'`);
      if (c.segment_eq !== undefined) whereParts.push(`segment = '${String(c.segment_eq).replace(/'/g, "''")}'`);
      if (c.is_group_buyer) whereParts.push('is_group_buyer = 1');
      whereParts.push(`created_at >= datetime('now', '-30 days')`);
      const lm = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM retail_customers WHERE ${whereParts.join(' AND ')}`
      ).first().catch(() => null);
      targetingMeta.live_match_count = lm?.c ?? null;

      if (targetCustomers.length === 0) {
        targetingMeta.no_targets_message = campaign.trigger_config
          ? `No one enrolled yet. Fires when a customer matches: ${Object.entries(c).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ') || 'any match on ' + (config.event || 'event')}`
          : 'No enrollees yet.';
      }
    } else {
      // Condition / legacy path — preserve existing behavior, but label it honestly
      const tcWhere = buildCriteriaWhere(campaign);
      const tc = await env.DB.prepare(`
        SELECT id, first_name, visit_count, favorite_sku, last_visit_date, behavior_type
        FROM retail_customers WHERE ${tcWhere}
        ORDER BY total_lifetime_value DESC LIMIT 20
      `).all();
      targetCustomers = tc.results || [];
      targetingMeta.mode = 'criteria';
      targetingMeta.label = campaign.trigger_type === 'condition'
        ? 'Matching criteria (live)'
        : 'Matching criteria';
    }
  } catch (e) {
    console.error('[retail] target_customers build failed:', e.message);
  }

  return jsonResponse({
    campaign,
    sends: sends.results || [],
    discount,
    performance,
    previews,
    target_customers: targetCustomers,
    targeting: targetingMeta,
  });
}

async function regenerateCampaignPreviews(request, env) {
  const { campaign_id, tone } = await request.json();
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

  // Update message_template with tone if provided
  if (tone) {
    const toneGuide = {
      bolder: 'Make the message bold, urgent, direct. Use the "RUIN DINNER" energy.',
      softer: 'Make the message warm, gentle, friendly. Like a friend checking in.',
      urgent: 'Create urgency — limited time, this week only, don\'t miss out.',
      casual: 'Super casual, conversational, like a text from a buddy.',
    };
    const guidance = toneGuide[tone] || tone;
    await env.DB.prepare(
      'UPDATE retail_campaigns SET message_template = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(`${guidance} ${campaign.message_template || ''}`.trim(), campaign_id).run();
    campaign.message_template = `${guidance} ${campaign.message_template || ''}`.trim();
  }

  // Clear cached previews
  await env.KV.delete(`campaign_previews_${campaign_id}`);

  // Generate fresh previews
  const criteria = campaign.target_criteria ? JSON.parse(campaign.target_criteria) : {};
  let whereClause = "sms_eligible = 1";
  if (campaign.target_segment && campaign.target_segment !== 'all') whereClause += ` AND segment = '${campaign.target_segment}'`;
  if (criteria.min_visit_count) whereClause += ` AND visit_count >= ${criteria.min_visit_count}`;

  const targets = await env.DB.prepare(
    `SELECT * FROM retail_customers WHERE ${whereClause} ORDER BY RANDOM() LIMIT 3`
  ).all();

  // Check for discount
  const discount = await env.DB.prepare(
    'SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = ? LIMIT 1'
  ).bind(campaign_id, 'active').first();

  const previews = [];
  for (const customer of (targets.results || [])) {
    try {
      let campaignForPreview = { ...campaign };
      if (discount) {
        const desc = discount.discount_type === 'FIXED_AMOUNT'
          ? `$${(discount.amount / 100).toFixed(0)} off`
          : `${discount.amount}% off`;
        campaignForPreview.message_template = (campaign.message_template || '') + ` Include discount code ${discount.code} for ${desc}.`;
      }
      const sms = await generateCampaignSMS(customer, campaignForPreview, env);
      previews.push({
        customer_name: customer.first_name || 'Customer',
        customer_id: customer.id,
        visits: customer.visit_count,
        favorite_sku: customer.favorite_sku,
        message: sms,
        char_count: sms.length,
      });
    } catch {}
  }

  if (previews.length > 0) {
    await env.KV.put(`campaign_previews_${campaign_id}`, JSON.stringify(previews), { expirationTtl: 3600 });
  }

  return jsonResponse({ previews, tone: tone || null });
}

async function updateCampaignText(request, env) {
  const { campaign_id, message_template, drip_schedule } = await request.json();
  const updates = [];
  const binds = [];

  if (message_template !== undefined) {
    updates.push('message_template = ?');
    binds.push(message_template);
  }
  if (drip_schedule !== undefined) {
    updates.push('drip_schedule = ?');
    binds.push(typeof drip_schedule === 'string' ? drip_schedule : JSON.stringify(drip_schedule));
  }
  if (updates.length === 0) return jsonResponse({ error: 'Nothing to update' }, 400);

  updates.push("updated_at = datetime('now')");
  binds.push(campaign_id);

  await env.DB.prepare(
    `UPDATE retail_campaigns SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...binds).run();

  // Clear preview cache
  await env.KV.delete(`campaign_previews_${campaign_id}`);

  return jsonResponse({ updated: true });
}

async function toggleCampaignDiscount(request, env) {
  const { campaign_id, action, discount_type, amount } = await request.json();
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

  if (action === 'add') {
    // Check if already has active discount
    const existing = await env.DB.prepare(
      'SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = ?'
    ).bind(campaign_id, 'active').first();
    if (existing) return jsonResponse({ error: 'Campaign already has a discount', discount: existing }, 400);

    const disc = await createSquareDiscount(env, {
      campaignId: campaign_id,
      discountType: discount_type || 'FIXED_AMOUNT',
      amount: amount || 500,
      maxRedemptions: campaign.estimated_reach || null,
    });

    // Update message template to mention the code
    const desc = disc.discountType === 'FIXED_AMOUNT'
      ? `$${(disc.amount / 100).toFixed(0)} off`
      : `${disc.amount}% off`;
    const templateAddition = `Include discount code ${disc.code} for ${desc} — work it in naturally.`;
    await env.DB.prepare(
      "UPDATE retail_campaigns SET message_template = COALESCE(message_template, '') || ' ' || ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(templateAddition, campaign_id).run();

    await env.KV.delete(`campaign_previews_${campaign_id}`);
    return jsonResponse({ added: true, discount: disc });

  } else if (action === 'remove') {
    await env.DB.prepare(
      "UPDATE retail_campaign_discounts SET status = 'disabled' WHERE campaign_id = ? AND status = 'active'"
    ).bind(campaign_id).run();

    // Remove discount mention from template (best effort)
    const template = campaign.message_template || '';
    const cleaned = template.replace(/Include discount code \S+ for [^.]+\./g, '').trim();
    await env.DB.prepare(
      "UPDATE retail_campaigns SET message_template = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(cleaned, campaign_id).run();

    await env.KV.delete(`campaign_previews_${campaign_id}`);
    return jsonResponse({ removed: true });
  }

  return jsonResponse({ error: 'Invalid action — use add or remove' }, 400);
}

// Migrate all active discounts to shorter DP code format
async function refreshDiscountCodes(request, env) {
  const activeDiscounts = await env.DB.prepare(
    "SELECT d.*, c.message_template FROM retail_campaign_discounts d JOIN retail_campaigns c ON c.id = d.campaign_id WHERE d.status = 'active'"
  ).all();

  const results = [];
  for (const old of (activeDiscounts.results || [])) {
    // Skip if already in new format
    if (old.code && old.code.startsWith('DP') && !old.code.includes('-')) {
      results.push({ campaign_id: old.campaign_id, code: old.code, action: 'already_short' });
      continue;
    }

    try {
      // Create new discount with same params but short code
      const disc = await createSquareDiscount(env, {
        campaignId: old.campaign_id,
        discountType: old.discount_type || 'FIXED_AMOUNT',
        amount: old.amount,
        maxRedemptions: old.max_redemptions,
      });

      // Disable old discount
      await env.DB.prepare(
        "UPDATE retail_campaign_discounts SET status = 'disabled' WHERE id = ?"
      ).bind(old.id).run();

      // Update campaign message template — swap old code for new
      if (old.message_template) {
        const updated = old.message_template.replace(
          new RegExp(`discount code ${old.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'),
          `discount code ${disc.code}`
        );
        if (updated !== old.message_template) {
          await env.DB.prepare(
            "UPDATE retail_campaigns SET message_template = ?, updated_at = datetime('now') WHERE id = ?"
          ).bind(updated, old.campaign_id).run();
        }
      }

      // Clear preview cache
      await env.KV.delete(`campaign_previews_${old.campaign_id}`);

      results.push({ campaign_id: old.campaign_id, old_code: old.code, new_code: disc.code, action: 'migrated' });
    } catch (err) {
      results.push({ campaign_id: old.campaign_id, old_code: old.code, error: err.message, action: 'failed' });
    }
  }

  return jsonResponse({ refreshed: results.length, results });
}

async function editCampaignWithAgent(request, env) {
  const { campaign_id, instruction } = await request.json();
  if (!instruction) return jsonResponse({ error: 'instruction required' }, 400);

  // Load full campaign context
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

  // Load conversation history for this campaign (multi-turn)
  let conversationHistory = [];
  try {
    const cached = await env.KV.get(`campaign_chat_${campaign_id}`);
    if (cached) conversationHistory = JSON.parse(cached);
  } catch {}

  // Load recent sends with outcomes
  const recentSends = await env.DB.prepare(`
    SELECT cs.message_text, cs.outcome, cs.variant_id, rc.first_name, rc.behavior_type
    FROM retail_campaign_sends cs
    LEFT JOIN retail_customers rc ON rc.id = cs.customer_id
    WHERE cs.campaign_id = ?
    ORDER BY cs.sent_at DESC LIMIT 5
  `).bind(campaign_id).all();

  // Load discount
  const discount = await env.DB.prepare(
    'SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = ? LIMIT 1'
  ).bind(campaign_id, 'active').first();

  // Load past performance
  const typePerf = await env.DB.prepare(`
    SELECT COUNT(*) as runs, AVG(CASE WHEN total_sent > 0 THEN CAST(total_returned AS REAL) / total_sent ELSE 0 END) as avg_return_rate,
           SUM(total_revenue_attributed) as total_revenue
    FROM retail_campaigns WHERE campaign_type = ? AND status = 'completed'
  `).bind(campaign.campaign_type).first();

  // Count target segment using shared helper
  const segWhere = buildCriteriaWhere(campaign);
  const segmentInfo = await env.DB.prepare(`
    SELECT COUNT(*) as total,
           AVG(visit_count) as avg_visits,
           GROUP_CONCAT(DISTINCT behavior_type) as behaviors
    FROM retail_customers WHERE ${segWhere}
  `).first();

  // Load brain context
  const brainContext = await loadBrain(env, 'retail');

  const systemPrompt = `You are the campaign strategist for Dangerous Pretzel Co, a fast-casual gourmet soft pretzel restaurant in Salt Lake City.

ABOUT THE BUSINESS:
- Name: Dangerous Pretzel Co (tagline: "RUIN DINNER" — never use this as the restaurant name)
- Menu: Spicy Bee, BBK (Brush Before Kissing), The Saint, The Salty, For The Kids, Salty Bombs
- Location: 352 W 600 S, SLC. Open daily 11am-8pm.
- Order online: dangerouspretzel.com
- POS: Square (handles all in-store and online orders)

Drew (the owner) is talking to you about a campaign. He's sophisticated — give him real data, honest assessments, and strategic recommendations. Don't sugarcoat.

CURRENT CAMPAIGN STATE:
- Name: ${campaign.name}
- Type: ${campaign.campaign_type}
- Mode: ${campaign.campaign_mode || 'batch'}${campaign.campaign_mode === 'continuous' ? ' (ALWAYS-ON — never completes)' : ''}
- Status: ${campaign.status}${campaign.paused_at ? ' [PAUSED: ' + (campaign.pause_reason || 'manual') + ']' : ''}
${campaign.campaign_mode === 'continuous' ? `- Health: ${campaign.health_status || 'healthy'}
- Trigger: ${campaign.trigger_type || 'manual'} | Config: ${campaign.trigger_config || 'none'}
- Delay: ${campaign.optimal_delay_seconds || 'default'}s
- 7d: ${campaign.rolling_7d_sent || 0} sent, ${campaign.rolling_7d_returned || 0} returned, ${campaign.rolling_7d_optouts || 0} optouts
- 30d: ${campaign.rolling_30d_sent || 0} sent, ${campaign.rolling_30d_returned || 0} returned, $${Math.round(campaign.rolling_30d_revenue || 0)} revenue
- Lifetime enrolled: ${campaign.lifetime_enrolled || 0}` : `- Target: ${campaign.target_segment} | Criteria: ${campaign.target_criteria || 'none'}
- Reach: ${campaign.estimated_reach} customers`}
- Message guidance: ${campaign.message_template || 'none'}
- Strategy: ${campaign.send_strategy} | Drip: ${campaign.drip_schedule || 'none'}
- Limits: ${campaign.daily_send_limit}/day, budget ${campaign.total_budget_sms || 'unlimited'}
${discount ? `- Discount: ${discount.code} (${discount.discount_type === 'FIXED_AMOUNT' ? '$' + (discount.amount / 100).toFixed(0) + ' off' : discount.amount + '% off'}, ${discount.times_redeemed} redeemed)` : '- No discount'}

AUDIENCE: ${segmentInfo?.total || 0} matching | Avg ${segmentInfo?.avg_visits ? Math.round(segmentInfo.avg_visits * 10) / 10 : '?'} visits | Types: ${segmentInfo?.behaviors || '?'}

RECENT SENDS:
${(recentSends.results || []).map(s => `- ${s.first_name || '?'} (${s.behavior_type || '?'}): "${s.message_text}" → ${s.outcome}`).join('\n') || 'None yet'}

PERFORMANCE (${campaign.campaign_type}): ${typePerf?.runs || 0} campaigns, ${typePerf?.avg_return_rate ? Math.round(typePerf.avg_return_rate * 100) : '?'}% return rate, $${typePerf?.total_revenue ? Math.round(typePerf.total_revenue) : 0} revenue

${brainContext}

RESPONSE FORMAT — return JSON:
{
  "response": "Your conversational reply to Drew (be direct, use data)",
  "changes": { "field": "new_value" },  // ONLY if Drew asked to change something. Valid fields: name, message_template, drip_schedule, target_criteria, daily_send_limit, total_budget_sms, trigger_config, optimal_delay_seconds
  "discount_change": { "action": "update|add|remove", "amount": 1000, "type": "FIXED_AMOUNT" },  // ONLY if Drew asks to change, add, or remove a discount. Omit if no discount changes.
  "pause_action": "pause|resume",  // ONLY if Drew asks to pause or resume a continuous campaign.
  "brain_learning": "..." // If Drew gave feedback about messaging quality, tone, things to avoid, or business rules — extract a concise instruction to remember for ALL future campaigns. null if no learnable feedback.
}

RULES:
- NEVER make up data, events, or offers
- If Drew asks a question, answer it from the data above — don't guess
- If Drew gives feedback about message quality ("don't say X", "never promise Y"), extract it as brain_learning
- If no changes needed (just a question), set changes to {} and omit discount_change
- Keep responses concise and direct
- If Drew asks to change the discount amount (e.g. "bump to $10", "make it 15% off"), use discount_change with action "update". This disables the old code and creates a new one automatically.
- discount_change amount: use CENTS for FIXED_AMOUNT ($5 = 500, $10 = 1000). Use whole number for FIXED_PERCENTAGE (15% = 15).
- If Drew asks to add a discount and one already exists, use action "update" not "add"
- For continuous campaigns: trigger_config and optimal_delay_seconds are editable. Drew can say "change the delay to 4 hours" (set optimal_delay_seconds to 14400) or "only target VIPs" (update trigger_config conditions)
- If Drew says "pause this" or "turn this off", use pause_action: "pause". If "resume" or "turn back on", use pause_action: "resume"`;

  // Build messages array with conversation history
  const messages = [];
  for (const turn of conversationHistory.slice(-8)) { // Keep last 8 turns for context
    messages.push({ role: 'user', content: turn.user });
    messages.push({ role: 'assistant', content: turn.assistant });
  }
  messages.push({ role: 'user', content: instruction });

  // Call Claude
  // DIF-3 (May 13 2026): wired through ai-budget
  // Multi-turn chat — use campaign-scoped conversation_id so the per-conversation
  // token cap applies across turns. campaign_id is the natural identifier here.
  const aiResult = await callAI(env, {
    use_case: 'retail_campaign_chat',
    model: 'haiku',
    caller: 'retail-agent.js',
    conversation_id: 'retail-campaign-' + campaign_id,
    max_tokens: 1500,
    system: systemPrompt,
    messages,
  });

  if (!aiResult.ok) return jsonResponse({ error: `Claude error ${aiResult.error || aiResult.blocked_reason || 'unknown'}` }, 500);
  const text = aiResult.content || '';

  let result;
  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    result = JSON.parse(clean);
  } catch {
    // If Claude responds conversationally without JSON, wrap it
    result = { response: text, changes: {}, brain_learning: null };
  }

  // Save conversation turn to history
  conversationHistory.push({
    user: instruction,
    assistant: typeof result.response === 'string' ? result.response : JSON.stringify(result),
    timestamp: new Date().toISOString(),
  });
  // Keep last 20 turns, expire after 24 hours
  await env.KV.put(
    `campaign_chat_${campaign_id}`,
    JSON.stringify(conversationHistory.slice(-20)),
    { expirationTtl: 86400 }
  );

  // Extract learnings into business_brain (persistent memory)
  if (result.brain_learning) {
    try {
      const brainId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO business_brain (id, scope, category, instruction, entity_name, active, use_count, created_at)
        VALUES (?, 'retail', 'avoid', ?, 'campaign_feedback', 1, 0, datetime('now'))
      `).bind(brainId, result.brain_learning).run();
      console.log(`[Retail] Brain learning saved: ${result.brain_learning.slice(0, 80)}`);

      // Also save to campaign-type-specific KV for immediate use in SMS generation
      let existing = '';
      try { existing = await env.KV.get(`campaign_feedback_${campaign.campaign_type}`) || ''; } catch {}
      await env.KV.put(
        `campaign_feedback_${campaign.campaign_type}`,
        (existing + '\n- ' + result.brain_learning).trim(),
        { expirationTtl: 86400 * 90 } // 90 days
      );
    } catch (err) {
      console.error(`[Retail] Brain learning save failed: ${err.message}`);
    }
  }

  // Apply changes
  const changes = result.changes || {};
  const appliedChanges = {};

  for (const [field, value] of Object.entries(changes)) {
    const allowed = ['name', 'message_template', 'drip_schedule', 'target_criteria', 'daily_send_limit', 'total_budget_sms', 'estimated_reach', 'trigger_config', 'optimal_delay_seconds'];
    if (!allowed.includes(field)) continue;

    const dbValue = typeof value === 'object' ? JSON.stringify(value) : value;
    const oldValue = campaign[field];

    await env.DB.prepare(
      `UPDATE retail_campaigns SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(dbValue, campaign_id).run();

    appliedChanges[field] = {
      from: typeof oldValue === 'string' && (oldValue.startsWith('[') || oldValue.startsWith('{')) ? JSON.parse(oldValue) : oldValue,
      to: value,
    };
  }

  // Handle discount changes (add/update/remove via chat)
  if (result.discount_change) {
    const dc = result.discount_change;
    try {
      if (dc.action === 'update' || dc.action === 'add') {
        const oldDiscount = discount; // captured earlier in the function
        // Disable existing discount if any
        await env.DB.prepare(
          "UPDATE retail_campaign_discounts SET status = 'disabled' WHERE campaign_id = ? AND status = 'active'"
        ).bind(campaign_id).run();

        // Create new discount with requested amount
        const disc = await createSquareDiscount(env, {
          campaignId: campaign_id,
          discountType: dc.type || 'FIXED_AMOUNT',
          amount: dc.amount,
          maxRedemptions: campaign.estimated_reach || null,
        });

        // Update message template — replace old code reference or append
        const desc = disc.discountType === 'FIXED_AMOUNT'
          ? `$${(disc.amount / 100).toFixed(0)} off` : `${disc.amount}% off`;
        let template = campaign.message_template || '';
        template = template.replace(/Include discount code \S+ for [^.]+\./g, '').trim();
        template = (template + ` Include discount code ${disc.code} for ${desc} — work it in naturally.`).trim();
        await env.DB.prepare(
          "UPDATE retail_campaigns SET message_template = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(template, campaign_id).run();

        const oldDesc = oldDiscount
          ? (oldDiscount.discount_type === 'FIXED_AMOUNT' ? `${oldDiscount.code} ($${(oldDiscount.amount / 100).toFixed(0)} off)` : `${oldDiscount.code} (${oldDiscount.amount}% off)`)
          : 'none';
        appliedChanges.discount = { from: oldDesc, to: `${disc.code} (${desc})` };
        appliedChanges.message_template = { from: campaign.message_template, to: template };
      } else if (dc.action === 'remove') {
        await env.DB.prepare(
          "UPDATE retail_campaign_discounts SET status = 'disabled' WHERE campaign_id = ? AND status = 'active'"
        ).bind(campaign_id).run();
        let template = campaign.message_template || '';
        template = template.replace(/Include discount code \S+ for [^.]+\./g, '').trim();
        await env.DB.prepare(
          "UPDATE retail_campaigns SET message_template = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(template, campaign_id).run();
        appliedChanges.discount = { from: discount ? discount.code : 'none', to: 'removed' };
        appliedChanges.message_template = { from: campaign.message_template, to: template };
      }
    } catch (err) {
      console.error(`[Retail] Chat discount change failed: ${err.message}`);
    }
  }

  // Handle pause/resume action
  if (result.pause_action) {
    if (result.pause_action === 'pause' && !campaign.paused_at) {
      await env.DB.prepare(`
        UPDATE retail_campaigns SET paused_at = datetime('now'), pause_reason = 'manual', health_status = 'auto_paused', updated_at = datetime('now') WHERE id = ?
      `).bind(campaign_id).run();
      appliedChanges.status = { from: 'active', to: 'paused' };
    } else if (result.pause_action === 'resume' && campaign.paused_at) {
      await env.DB.prepare(`
        UPDATE retail_campaigns SET paused_at = NULL, pause_reason = NULL, health_status = 'healthy', updated_at = datetime('now') WHERE id = ?
      `).bind(campaign_id).run();
      appliedChanges.status = { from: 'paused', to: 'active' };
    }
  }

  // If target_criteria changed, recalculate estimated_reach using shared helper
  if (changes.target_criteria && !changes.estimated_reach) {
    const updatedCamp = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();
    const newWhere = buildCriteriaWhere(updatedCamp);
    const newCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM retail_customers WHERE ${newWhere}`).first();
    if (newCount) {
      await env.DB.prepare("UPDATE retail_campaigns SET estimated_reach = ?, updated_at = datetime('now') WHERE id = ?").bind(newCount.count, campaign_id).run();
      appliedChanges.estimated_reach = { from: campaign.estimated_reach, to: newCount.count };
    }
  }

  // Clear preview cache
  await env.KV.delete(`campaign_previews_${campaign_id}`);

  // Reload updated campaign
  const updated = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();

  return jsonResponse({
    response: result.response || '',
    changes: appliedChanges,
    brain_learning: result.brain_learning || null,
    updated_campaign: updated,
  });
}

// ══════════════════════════════════════════════════════════════════
// ── CONTINUOUS CAMPAIGNS ENGINE ─────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// ── Frequency cap check (cross-campaign) ─────────────────────────
async function checkFrequencyCap(customerId, env) {
  const caps = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN sent_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as week_count,
      SUM(CASE WHEN sent_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as month_count
    FROM retail_frequency_cap WHERE customer_id = ?
  `).bind(customerId).first();

  if ((caps?.week_count || 0) >= 2) return false; // Max 2 per week
  if ((caps?.month_count || 0) >= 5) return false; // Max 5 per month
  return true;
}

// ── Record to frequency cap ──────────────────────────────────────
async function recordFrequencyCap(customerId, campaignId, campaignType, env) {
  await env.DB.prepare(`
    INSERT INTO retail_frequency_cap (customer_id, sent_at, campaign_id, campaign_type)
    VALUES (?, datetime('now'), ?, ?)
  `).bind(customerId, campaignId, campaignType).run();
}

// ── Thompson Sampling variant selection ──────────────────────────
function selectWeightedVariant(variants) {
  if (!variants || !variants.length) return null;
  if (variants.length === 1) return variants[0];

  // Thompson Sampling: sample from Beta(successes+1, failures+1)
  function betaSample(alpha, beta) {
    // Box-Muller approximation for Beta distribution
    // For small counts, use simple approximation
    const x = gammaApprox(alpha);
    const y = gammaApprox(beta);
    return x / (x + y);
  }

  function gammaApprox(shape) {
    // Marsaglia and Tsang's method simplified for integer-ish shapes
    if (shape < 1) {
      return gammaApprox(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = normalRandom();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function normalRandom() {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  return variants
    .map(v => {
      const successes = v.total_returned || 0;
      const failures = Math.max(0, (v.total_sent || 0) - successes);
      const sample = betaSample(successes + 1, failures + 1);
      return { variant: v, sample };
    })
    .sort((a, b) => b.sample - a.sample)[0].variant;
}

// ── Render template with customer data ───────────────────────────
function renderTemplate(template, customer, campaign) {
  if (!template) return getFallbackSMS(customer);
  const skuNames = {
    'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'The Saint',
    'SALTY': 'The Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
  };
  const fav = customer.favorite_sku ? (skuNames[customer.favorite_sku] || customer.favorite_sku) : 'pretzel';

  // Expiry formatting — uses campaign._expires_at if set (per-send), else campaign.expiry_days
  // projected from now. `expires_short` = "Tue 4/23", `expires_date` = "Apr 23".
  let expiresShort = '', expiresDate = '';
  try {
    const ts = campaign._expires_at
      ? new Date(campaign._expires_at)
      : (campaign.expiry_days ? new Date(Date.now() + Number(campaign.expiry_days) * 86400000) : null);
    if (ts && !isNaN(ts)) {
      const opts = { timeZone: 'America/Denver' };
      const dayName = ts.toLocaleDateString('en-US', { ...opts, weekday: 'short' });
      const month = ts.getMonth() + 1;
      const day = ts.getDate();
      expiresShort = `${dayName} ${month}/${day}`;
      expiresDate = ts.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' });
    }
  } catch {}

  // first_name may arrive from Square as a full "Given Family" string, sometimes with
  // junk suffixes like "SF 650b7799 Laurie E" or all-lowercase. Take first token + title-case,
  // and if the result is 2-chars-or-less or hex-ish, drop it to 'there' (greeting fallback).
  const rawFirstName = (customer.first_name || '').trim();
  let firstNameOnly = rawFirstName ? rawFirstName.split(/\s+/)[0] : '';
  if (firstNameOnly.length <= 2 || /^[0-9a-f]{6,}$/i.test(firstNameOnly)) firstNameOnly = '';
  // Title-case: first letter uppercase, rest lowercase (doesn't handle "McDonald" but good enough)
  if (firstNameOnly) firstNameOnly = firstNameOnly.charAt(0).toUpperCase() + firstNameOnly.slice(1).toLowerCase();

  // weeks_since_last — rendered from last_visit_date, integer count.
  // Falls back to blank string if no visit on file (template should handle gracefully).
  let weeksSinceLast = '';
  if (customer.last_visit_date) {
    const daysSince = (Date.now() - new Date(customer.last_visit_date).getTime()) / 86400000;
    if (daysSince > 0 && isFinite(daysSince)) weeksSinceLast = String(Math.floor(daysSince / 7));
  }

  // favorite_sku_or_default — SKU name if present, else generic 'pretzel'
  const favoriteSkuOrDefault = customer.favorite_sku ? (skuNames[customer.favorite_sku] || customer.favorite_sku) : 'pretzel';

  const vars = {
    name: firstNameOnly,
    first_name: firstNameOnly || 'there',
    favorite: fav,
    favorite_sku: favoriteSkuOrDefault,
    favorite_sku_or_default: favoriteSkuOrDefault,
    weeks_since_last: weeksSinceLast,
    visits: String(customer.visit_count || 0),
    code: campaign._discount_code || '',
    expires_short: expiresShort,
    expires_date: expiresDate,
    expiry_days: String(campaign.expiry_days || ''),
  };

  // Accept both {{var}} (legacy) and {var} (simpler). Process {{var}} FIRST so we don't
  // accidentally strip the outer braces.
  let rendered = template
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : ''))
    .replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : ''));

  // Clean up artifacts from empty replacements (double spaces, leading commas, orphan punctuation)
  rendered = rendered.replace(/\s{2,}/g, ' ').replace(/^[,\s]+/, '').trim();

  return rendered.slice(0, 160);
}

// Deterministic A/B arm assignment. Hash customer_id into 0-99 bucket and apply
// weights from campaign's ab_config. Stable across reruns — the same customer always
// lands in the same arm for the same campaign config. If abConfig.control_pct is set,
// customers landing in the last `control_pct` of the bucket range become control.
function assignArm(customerId, abConfig) {
  if (!abConfig || !Array.isArray(abConfig.arms) || !abConfig.arms.length) return null;
  // Hash customer_id → 0..99 using last 4 chars interpreted as base-36
  const suffix = String(customerId).slice(-4);
  const bucket = Math.abs(parseInt(suffix, 36) || 0) % 100;
  const controlPct = Math.max(0, Math.min(100, parseInt(abConfig.control_pct, 10) || 0));
  const treatmentCap = 100 - controlPct;
  if (bucket >= treatmentCap) return 'control';
  // Within treatment range, proportion arms by weight
  const totalWeight = abConfig.arms.reduce((s, a) => s + (a.weight || 0), 0);
  if (totalWeight <= 0) return abConfig.arms[0].name;
  // Scale bucket to 0..totalWeight within treatment range
  const scaled = (bucket / treatmentCap) * totalWeight;
  let cumulative = 0;
  for (const arm of abConfig.arms) {
    cumulative += (arm.weight || 0);
    if (scaled < cumulative) return arm.name;
  }
  return abConfig.arms[abConfig.arms.length - 1].name;
}

// ── Evaluate trigger conditions against customer ─────────────────
// Kept in sync with the matching block in square-sync-worker.js emitCampaignSignals.
function evaluateTriggerConditions(conditions, customer) {
  if (!conditions) return true;
  if (conditions.visit_count_eq !== undefined && customer.visit_count !== conditions.visit_count_eq) return false;
  if (conditions.visit_count_min !== undefined && customer.visit_count < conditions.visit_count_min) return false;
  if (conditions.visit_count_max !== undefined && customer.visit_count > conditions.visit_count_max) return false;
  if (conditions.visit_count_gte !== undefined && customer.visit_count < conditions.visit_count_gte) return false;
  if (conditions.sms_consent_eq !== undefined && customer.sms_consent !== conditions.sms_consent_eq) return false;
  if (conditions.sms_eligible_eq !== undefined && customer.sms_eligible !== conditions.sms_eligible_eq) return false;
  if (conditions.acquisition_source_eq !== undefined && customer.acquisition_source !== conditions.acquisition_source_eq) return false;
  if (conditions.segment_eq !== undefined && customer.segment !== conditions.segment_eq) return false;
  if (conditions.segment_in && !conditions.segment_in.includes(customer.segment)) return false;
  if (conditions.segment_not_in && conditions.segment_not_in.includes(customer.segment)) return false;
  if (conditions.is_group_buyer && !customer.is_group_buyer) return false;
  if (conditions.min_items !== undefined) {
    // This is checked at signal emission time with order data, not customer data
    return true;
  }
  return true;
}

// ── Queue consumer: process delayed campaign trigger ─────────────
// Platinum dossier — pulls the N customers matching the campaign's target_criteria
// (visit_count_min=10, days_since_last_visit_min=30 for our setup) and returns a brief
// per customer: name, phone, last visit, favorite SKU, largest order, total spend, visits.
// Also includes a proposed SMS draft per customer that Drew can tweak before sending.
async function runPlatinumDossier(campaignId, env) {
  const campaign = await env.DB.prepare(
    "SELECT * FROM retail_campaigns WHERE id = ?"
  ).bind(campaignId).first();
  if (!campaign) return jsonResponse({ error: 'campaign not found' }, 404);

  let config = {};
  try { config = JSON.parse(campaign.trigger_config || '{}'); } catch {}
  const conditions = config.conditions || {};
  const minVisits = conditions.visit_count_min ?? 10;
  const minDaysLapsed = conditions.days_since_last_visit_min ?? 30;

  const { results: customers } = await env.DB.prepare(`
    SELECT id, phone, first_name, favorite_sku, visit_count,
           total_lifetime_value, largest_single_order, last_visit_date, first_visit_date,
           avg_order_value
    FROM retail_customers
    WHERE sms_eligible = 1
      AND visit_count >= ?
      AND last_visit_date IS NOT NULL
      AND julianday('now') - julianday(last_visit_date) >= ?
      AND first_name IS NOT NULL
      AND id NOT IN (SELECT customer_id FROM retail_campaign_sends WHERE campaign_id = ?)
    ORDER BY total_lifetime_value DESC
  `).bind(minVisits, minDaysLapsed, campaignId).all().catch(() => ({ results: [] }));

  const skuNames = {
    'SPICY-BEE': 'Spicy Bee', 'BBK': 'BBK', 'SAINT': 'The Saint',
    'SALTY': 'The Salty', 'KIDS': 'For The Kids', 'BOMBS': 'Salty Bombs',
  };

  // Dossier shows a PROPOSED code per customer (the actual Square catalog code is generated
   // at send time, not at dossier time — don't burn codes on customers Drew skips).
  const codePrefix = campaign.code_prefix || 'DPPLAT';
  const dossiers = (customers || []).map(c => {
    const fav = c.favorite_sku ? (skuNames[c.favorite_sku] || c.favorite_sku) : 'pretzel';
    let firstName = (c.first_name || '').split(/\s+/)[0];
    if (firstName.length <= 2 || /^[0-9a-f]{6,}$/i.test(firstName)) firstName = 'there';
    else firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
    const daysAgo = c.last_visit_date
      ? Math.floor((Date.now() - new Date(c.last_visit_date).getTime()) / 86400000)
      : null;
    // Proposed SMS — Drew rewrites freely; this is a starting point, not a requirement.
    // Leads with "Drew at Dangerous Pretzel" so the first line identifies brand + sender.
    // {code} placeholder is swapped for the real single-use code at send time.
    const proposed = `Hey ${firstName}, it's Drew at Dangerous Pretzel — been a minute, missing you. Come grab a ${fav} on us. Code {code}. Reply STOP`;
    return {
      customer_id: c.id,
      first_name: firstName,
      full_name: c.first_name,
      phone: c.phone,
      visit_count: c.visit_count,
      total_lifetime_value: Math.round(c.total_lifetime_value || 0),
      largest_single_order: c.largest_single_order || 0,
      favorite_sku: fav,
      last_visit_date: c.last_visit_date,
      days_since_last_visit: daysAgo,
      first_visit_date: c.first_visit_date,
      avg_order_value: Math.round((c.avg_order_value || 0) * 100) / 100,
      proposed_sms: proposed,
      proposed_sms_length: proposed.length,
    };
  });

  return jsonResponse({
    campaign_id: campaignId,
    campaign_name: campaign.name,
    code_prefix: codePrefix,
    note: 'Per-customer single-use codes generated at send time. The {code} placeholder is swapped for the real Square catalog code when you click Send.',
    total: dossiers.length,
    dossiers,
  });
}

// Fires Drew-approved custom copy through the send pipeline for each customer in the
// dossier. Body: { sends: [{customer_id, sms, skip?}] }. Returns the same shape as
// runManualEnrollment (stats + per-customer results).
async function runPlatinumDossierSend(campaignId, body, env) {
  const { sends } = body || {};
  if (!Array.isArray(sends) || !sends.length) {
    return jsonResponse({ error: 'sends[] required' }, 400);
  }
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return jsonResponse({ error: 'campaign not found' }, 404);

  const expiryDays = parseInt(campaign.expiry_days, 10) || 60;
  const expiresAt = new Date(Date.now() + expiryDays * 86400000).toISOString();
  const codePrefix = campaign.code_prefix || 'DPPLAT';
  // Load one template discount to get the amount; fallback to $20 ceiling for Platinum.
  const template = await env.DB.prepare(
    "SELECT amount FROM retail_campaign_discounts WHERE campaign_id = ? AND code = 'DPPLAT' LIMIT 1"
  ).bind(campaignId).first();
  const amountCents = template?.amount || 2000;

  const results = [];
  for (const s of sends) {
    if (s.skip) { results.push({ customer_id: s.customer_id, status: 'skipped' }); continue; }
    if (!s.sms || s.sms.length === 0) { results.push({ customer_id: s.customer_id, status: 'empty_sms' }); continue; }

    const customer = await env.DB.prepare('SELECT * FROM retail_customers WHERE id = ?').bind(s.customer_id).first();
    if (!customer) { results.push({ customer_id: s.customer_id, status: 'not_found' }); continue; }

    const already = await env.DB.prepare(
      `SELECT id FROM retail_campaign_sends WHERE campaign_id = ? AND customer_id = ? AND variant_id = 'drip_step_0'`
    ).bind(campaignId, s.customer_id).first();
    if (already) { results.push({ customer_id: s.customer_id, status: 'already_enrolled' }); continue; }

    // Generate unique single-use Square discount for this customer
    let perCustomerCode = null;
    try {
      const disc = await createSquareDiscount(env, {
        campaignId, discountType: 'FIXED_AMOUNT',
        amount: amountCents, validDays: expiryDays,
        maxRedemptions: 1, codePrefix,
      });
      perCustomerCode = disc?.code;
      if (!perCustomerCode || disc.squareError) {
        results.push({ customer_id: s.customer_id, status: 'square_code_failed', error: disc.squareError });
        continue;
      }
    } catch (e) {
      results.push({ customer_id: s.customer_id, status: 'square_code_failed', error: e.message });
      continue;
    }

    // Swap {code} placeholder in Drew's copy with the real per-customer code
    const finalSms = s.sms.replace(/\{code\}/g, perCustomerCode);
    if (finalSms.length > 160) {
      results.push({ customer_id: s.customer_id, status: 'sms_too_long', length: finalSms.length, code_used: perCustomerCode });
      continue;
    }

    const send = await sendSwellSMS(customer.phone, finalSms, env);
    if (!send.success) {
      results.push({ customer_id: s.customer_id, status: 'send_failed', error: send.error });
      continue;
    }

    const sendId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (
        id, campaign_id, customer_id, variant_id, ab_arm,
        message_text, sent_at, delay_seconds_actual, trigger_event_id,
        outcome, enrolled_at, created_at,
        discount_code, expires_at
      ) VALUES (?, ?, ?, 'drip_step_0', 'platinum_personal', ?, datetime('now'), 0, 'platinum_dossier', 'delivered', datetime('now'), datetime('now'), ?, ?)
    `).bind(sendId, campaignId, s.customer_id, finalSms, perCustomerCode, expiresAt).run();

    await env.DB.prepare(
      `UPDATE retail_customers SET welcomed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND welcomed_at IS NULL`
    ).bind(s.customer_id).run().catch(() => {});

    await env.DB.prepare(
      `UPDATE retail_campaigns SET total_sent = total_sent + 1, lifetime_enrolled = lifetime_enrolled + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(campaignId).run();

    await recordFrequencyCap(s.customer_id, campaignId, campaign.campaign_type, env).catch(() => {});

    results.push({
      customer_id: s.customer_id,
      status: 'sent',
      send_id: sendId,
      sms: finalSms,
      discount_code: perCustomerCode,
      expires_at: expiresAt,
    });
    await sleep(500);
  }

  const stats = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  return jsonResponse({ campaign_id: campaignId, total: sends.length, stats, results });
}

// Graduate controls for ONE campaign — moves expired control tombstones into the winning
// variant if they haven't already returned naturally. Returns a plain object so it can
// be called from either the HTTP handler OR the daily cron.
async function graduateControlsForCampaign(campaignId, winningVariantKey, env) {
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaignId).first();
  if (!campaign) return { error: 'campaign not found', campaign_id: campaignId };

  // Find all expired control tombstones
  const { results: controls } = await env.DB.prepare(`
    SELECT cs.id as tombstone_id, cs.customer_id, cs.created_at as held_since
    FROM retail_campaign_sends cs
    WHERE cs.campaign_id = ? AND cs.ab_arm = 'control'
      AND cs.control_holdout_until IS NOT NULL
      AND datetime('now') >= cs.control_holdout_until
      AND cs.sent_at IS NULL
  `).bind(campaignId).all().catch(() => ({ results: [] }));

  if (!controls?.length) return { campaign_id: campaignId, total: 0, note: 'no controls ready to graduate' };

  let messageVariants = {};
  try { messageVariants = campaign.message_variants ? JSON.parse(campaign.message_variants) : {}; } catch {}
  const template = messageVariants[winningVariantKey] || campaign.message_template;
  if (!template) return { error: `no template for variant_key '${winningVariantKey}'`, campaign_id: campaignId };

  const discount = await env.DB.prepare(
    "SELECT code FROM retail_campaign_discounts WHERE campaign_id = ? AND status = 'active' LIMIT 1"
  ).bind(campaignId).first();
  const code = discount?.code || '';
  const expiryDays = parseInt(campaign.expiry_days, 10) || 14;
  const expiresAt = new Date(Date.now() + expiryDays * 86400000).toISOString();

  const results = [];
  for (const c of controls) {
    // Did they already return naturally during the hold?
    const ret = await env.DB.prepare(`
      SELECT id FROM orders WHERE customer_id = ? AND order_date >= ? LIMIT 1
    `).bind(c.customer_id, c.held_since).first();

    if (ret) {
      // Natural return — mark tombstone outcome + skip send (they're back already)
      await env.DB.prepare(
        `UPDATE retail_campaign_sends SET outcome = 'natural_return' WHERE id = ?`
      ).bind(c.tombstone_id).run();
      results.push({ customer_id: c.customer_id, status: 'natural_return' });
      continue;
    }

    // Send the winning variant
    const customer = await env.DB.prepare('SELECT * FROM retail_customers WHERE id = ?').bind(c.customer_id).first();
    if (!customer) { results.push({ customer_id: c.customer_id, status: 'not_found' }); continue; }
    const renderedCampaign = { ...campaign, _discount_code: code, _expires_at: expiresAt };
    const sms = renderTemplate(template, customer, renderedCampaign);

    const send = await sendSwellSMS(customer.phone, sms, env);
    if (!send.success) {
      results.push({ customer_id: c.customer_id, status: 'send_failed', error: send.error });
      continue;
    }

    // Delete the tombstone + insert a real send row under the winning variant
    await env.DB.prepare(`DELETE FROM retail_campaign_sends WHERE id = ?`).bind(c.tombstone_id).run();
    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (
        id, campaign_id, customer_id, variant_id, ab_arm, message_text,
        sent_at, outcome, enrolled_at, created_at, discount_code, expires_at, trigger_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'), datetime('now'), ?, ?, 'control_graduation')
    `).bind(
      crypto.randomUUID(), campaignId, c.customer_id, winningVariantKey, winningVariantKey, sms,
      code || null, expiresAt
    ).run();

    await recordFrequencyCap(c.customer_id, campaignId, campaign.campaign_type, env).catch(() => {});
    results.push({ customer_id: c.customer_id, status: 'graduated', sms });
    await sleep(500);
  }

  const stats = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  await env.DB.prepare(
    `UPDATE retail_campaigns SET total_sent = total_sent + ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(stats.graduated || 0, campaignId).run();

  return { campaign_id: campaignId, total: controls.length, winning_variant_key: winningVariantKey, stats, results };
}

// HTTP-wrapper for graduateControlsForCampaign — preserves the existing endpoint contract.
// Body: { campaign_id, winning_variant_key }
async function graduateControls(campaignId, winningVariantKey, env) {
  const result = await graduateControlsForCampaign(campaignId, winningVariantKey, env);
  if (result.error) {
    const status = result.error === 'campaign not found' ? 404 : 400;
    return jsonResponse(result, status);
  }
  return jsonResponse(result);
}

// Auto-graduate all eligible cohorts across every continuous campaign. For each active
// campaign with expired control tombstones, picks the winning variant (highest return
// rate among variants with >=3 sends — conservative threshold since cohorts are small),
// then calls graduateControlsForCampaign to do the send work.
// Returns per-campaign stats so the caller can log or surface them.
async function autoGraduateControls(env) {
  // 1. Find campaigns that have at least one expired control tombstone waiting.
  const { results: campaigns } = await env.DB.prepare(`
    SELECT DISTINCT rc.id, rc.name, rc.campaign_type
    FROM retail_campaigns rc
    JOIN retail_campaign_sends cs ON cs.campaign_id = rc.id
    WHERE rc.status = 'active'
      AND rc.campaign_mode = 'continuous'
      AND cs.ab_arm = 'control'
      AND cs.control_holdout_until IS NOT NULL
      AND datetime('now') >= cs.control_holdout_until
      AND cs.sent_at IS NULL
  `).all().catch(() => ({ results: [] }));

  if (!campaigns?.length) {
    return { campaigns_processed: 0, note: 'no expired control tombstones across any active campaign' };
  }

  const summary = { campaigns_processed: 0, per_campaign: [] };

  for (const c of campaigns) {
    // 2. Compute return rate per variant_id (excluding holdouts, drip_step_0 tombstones,
    //    controls — we only care about real treatment sends).
    const { results: perVariant } = await env.DB.prepare(`
      SELECT variant_id,
             COUNT(*) as sent,
             SUM(CASE WHEN returned_at IS NOT NULL THEN 1 ELSE 0 END) as returned
      FROM retail_campaign_sends
      WHERE campaign_id = ?
        AND sent_at IS NOT NULL
        AND outcome IN ('delivered', 'returned')
        AND variant_id NOT IN ('holdout', 'drip_step_0')
        AND (ab_arm IS NULL OR ab_arm != 'control')
      GROUP BY variant_id
    `).bind(c.id).all().catch(() => ({ results: [] }));

    // 3. Pick winning variant: must have >=3 sends to be eligible. Among those, highest
    //    return rate wins. Ties broken by raw send count (more data = more confidence).
    const MIN_SENDS_FOR_WINNER = 3;
    const eligible = (perVariant || []).filter(v => v.sent >= MIN_SENDS_FOR_WINNER);
    if (!eligible.length) {
      summary.per_campaign.push({
        campaign_id: c.id,
        campaign_name: c.name,
        status: 'skipped',
        reason: `no variant has >=${MIN_SENDS_FOR_WINNER} sends yet — retry tomorrow`,
        variants_considered: perVariant || [],
      });
      continue;
    }
    eligible.sort((a, b) => {
      const rateA = a.returned / a.sent;
      const rateB = b.returned / b.sent;
      if (rateA !== rateB) return rateB - rateA;
      return b.sent - a.sent;
    });
    const winner = eligible[0];
    const winnerVariantKey = winner.variant_id;

    // 4. Call the per-campaign graduator
    const graduation = await graduateControlsForCampaign(c.id, winnerVariantKey, env);

    summary.campaigns_processed += 1;
    summary.per_campaign.push({
      campaign_id: c.id,
      campaign_name: c.name,
      status: 'graduated',
      winning_variant: winnerVariantKey,
      winner_stats: { sent: winner.sent, returned: winner.returned, rate_pct: winner.sent > 0 ? Math.round((winner.returned / winner.sent) * 1000) / 10 : 0 },
      graduation_stats: graduation.stats || {},
      graduation_total: graduation.total || 0,
    });

    console.log(`[Retail] auto-graduate controls: ${c.name} — winner='${winnerVariantKey}' (${winner.returned}/${winner.sent}), result=${JSON.stringify(graduation.stats)}`);
  }

  return summary;
}

// Holiday promo fire — dedicated one-shot event campaign handler. Different from the
// A/B-controlled continuous campaigns: no variants, no control holdouts, no discount codes
// (holiday-priced at the register, not via code). Just render + send + log.
//
// Chunked by batch_size (default 300) per call to stay under Worker CPU limits. Caller
// invokes repeatedly until `remaining` returns 0. The exclusion `id NOT IN (already sent
// to this campaign)` makes each call idempotent — double-clicking is safe.
//
// Currently hardcoded to the National Pretzel Day 2026 campaign (holiday_npd_2026) with
// Wave 1 = high-intent (SALTY fans + recent regulars + group buyers) and Wave 2 = warm
// lapsed 61-180d. If another holiday ships later, generalize the cohort SQL lookup.
async function fireHolidayPromo({ wave, dry_run, batch_size }, env) {
  const CAMPAIGN_ID = 'holiday_npd_2026';
  const BATCH = Math.min(Math.max(parseInt(batch_size, 10) || 300, 10), 500);

  if (![1, 2].includes(Number(wave))) {
    return jsonResponse({ error: 'wave must be 1 or 2' }, 400);
  }

  // Wave 1 copy — high-intent, social, "bring the crew". 139 + name ≈ 146 chars for a 7-char
  // name. Safe under 160 cap even for long names like "Christopher" (11 chars = 150).
  const WAVE_1_COPY = 'Hey {first_name} — Sunday is National Pretzel Day. $1 Salty all day at Dangerous Pretzel until we sell out. Bring the crew. Reply STOP';
  // Wave 2 copy — warm lapsed reactivation. Trimmed from initial version that hit 159 chars
  // with "Harper" — a 9-char name like "Stephanie" would have pushed it over 160.
  const WAVE_2_COPY = "Hey {first_name} — been a minute. Sunday is National Pretzel Day and we're doing $1 Salty all day at Dangerous Pretzel. Bring a friend. Reply STOP";

  const template = Number(wave) === 1 ? WAVE_1_COPY : WAVE_2_COPY;
  const variantId = `wave${wave}`;

  // Build cohort WHERE clause per wave. Both waves enforce: reachable (first_name present +
  // not a generic label + not phone-as-name), sms_eligible, not on suppression list.
  // Both also exclude customers already sent this campaign (makes the endpoint resumable).
  // Pre-filter at cohort SQL level to avoid wasteful "fetch → block → repeat" loops.
  // Without the 48h-fatigue pre-filter here, sendSwellSMS would still block those customers
  // but they'd keep getting pulled into each batch, wasting query time + blocking log rows.
  // This mirrors the sendSwellSMS guard — just applied upstream so the batch is all-sendable.
  const REACHABILITY = `
    sms_eligible = 1
    AND first_name IS NOT NULL
    AND LENGTH(TRIM(first_name)) >= 2
    AND LOWER(first_name) NOT IN ('guest checkout','valued customer','customer','guest','unknown','cardholder','visa cardholder','mastercard','amex','discover','na','n/a','none')
    AND first_name NOT GLOB '+*'
    AND first_name NOT GLOB '1[0-9]*'
    AND last_visit_date IS NOT NULL
    AND normalized_phone NOT IN (SELECT phone FROM sms_suppressions)
    AND id NOT IN (SELECT customer_id FROM retail_campaign_sends WHERE campaign_id = '${CAMPAIGN_ID}' AND sent_at IS NOT NULL)
    AND normalized_phone NOT IN (
      SELECT rc.normalized_phone FROM retail_customers rc
      JOIN retail_campaign_sends rcs ON rcs.customer_id = rc.id
      WHERE rcs.sent_at >= datetime('now', '-48 hours')
        AND rcs.outcome = 'delivered'
        AND rc.normalized_phone IS NOT NULL
    )`;

  const WAVE_1_CRITERIA = `AND (
    favorite_sku = 'SALTY'
    OR (visit_count >= 2 AND julianday('now') - julianday(last_visit_date) <= 45)
    OR (is_group_buyer = 1 AND julianday('now') - julianday(last_visit_date) <= 180)
  )`;

  const WAVE_2_CRITERIA = `AND julianday('now') - julianday(last_visit_date) BETWEEN 61 AND 180
    AND id NOT IN (SELECT customer_id FROM retail_campaign_sends WHERE campaign_id = '${CAMPAIGN_ID}' AND variant_id = 'wave1')`;

  const criteria = Number(wave) === 1 ? WAVE_1_CRITERIA : WAVE_2_CRITERIA;

  // Total remaining (all eligible not-yet-sent) — for progress reporting
  const remainingResult = await env.DB.prepare(`
    SELECT COUNT(*) as cnt FROM retail_customers WHERE ${REACHABILITY} ${criteria}
  `).first().catch(e => { console.error('[fireHolidayPromo] count query failed:', e.message); return null; });

  if (!remainingResult) return jsonResponse({ error: 'cohort query failed' }, 500);
  const totalRemaining = remainingResult.cnt || 0;

  if (totalRemaining === 0) {
    return jsonResponse({
      campaign_id: CAMPAIGN_ID, wave, dry_run: !!dry_run,
      sent: 0, blocked: 0, remaining: 0, done: true,
      note: 'No eligible customers remaining in cohort. Wave complete or cohort empty.',
    });
  }

  // Pull the next batch
  const batch = await env.DB.prepare(`
    SELECT id, phone, normalized_phone, first_name, favorite_sku, last_visit_date, visit_count
    FROM retail_customers
    WHERE ${REACHABILITY} ${criteria}
    ORDER BY
      CASE WHEN favorite_sku = 'SALTY' THEN 0 ELSE 1 END,
      julianday('now') - julianday(last_visit_date) ASC
    LIMIT ${BATCH}
  `).all().catch(e => { console.error('[fireHolidayPromo] batch query failed:', e.message); return { results: [] }; });

  const customers = batch.results || [];
  const dryRunSamples = [];
  let sent = 0;
  let blocked = 0;
  const blockReasons = {};

  for (const customer of customers) {
    // Render copy using existing renderTemplate (fills {first_name} + any other tokens)
    const fakeCampaign = { _discount_code: '', _expires_at: null };
    const sms = renderTemplate(template, customer, fakeCampaign);

    // Dry-run: log tombstone, don't actually send
    if (dry_run) {
      dryRunSamples.push({
        customer_id: customer.id,
        first_name: customer.first_name,
        favorite_sku: customer.favorite_sku,
        visit_count: customer.visit_count,
        last_visit_date: customer.last_visit_date,
        sms_preview: sms,
        length: sms.length,
      });
      if (dryRunSamples.length >= 5) break; // only need 5 samples for dry-run
      continue;
    }

    // Real fire — sendSwellSMS enforces all guards (suppression, 48h fatigue, brand ID, 160 char).
    // Passes caller tag so blocks log with a useful identifier.
    const result = await sendSwellSMS(customer.phone, sms, env, { caller: `holiday_npd_wave${wave}` });
    if (!result.success) {
      blocked++;
      blockReasons[result.error || 'unknown'] = (blockReasons[result.error || 'unknown'] || 0) + 1;
      continue;
    }

    // Log the send — no discount_code (holiday-priced at register)
    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (
        id, campaign_id, customer_id, variant_id,
        message_text, sent_at, outcome, enrolled_at, created_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'), datetime('now'))
    `).bind(
      crypto.randomUUID(), CAMPAIGN_ID, customer.id, variantId, sms,
    ).run().catch(e => console.error('[fireHolidayPromo] send log failed:', e.message));

    // Record to frequency cap so other campaigns respect this customer's recent contact
    await recordFrequencyCap(customer.id, CAMPAIGN_ID, 'holiday_promo', env).catch(() => {});

    sent++;
    await sleep(200); // 5 sends/sec — safe under Swell rate limits, batch of 300 finishes in ~60s
  }

  // Update campaign totals (real sends only).
  // Tier 4e — was `.catch(() => {})` silent swallow. NPD Wave 1 fired 277 SMS
  // on Apr 24 but the dashboard counter stayed at 0 because this UPDATE failed
  // silently — likely a NULL-arithmetic issue on first run with NULL total_sent.
  // Now: COALESCE the existing values to 0 before adding, and log any failure
  // visibly so we'd see it in `wrangler tail` next time.
  if (sent > 0) {
    try {
      await env.DB.prepare(`
        UPDATE retail_campaigns
        SET total_sent = COALESCE(total_sent, 0) + ?,
            lifetime_enrolled = COALESCE(lifetime_enrolled, 0) + ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(sent, sent, CAMPAIGN_ID).run();
    } catch (err) {
      console.error('[fireHolidayPromo] counter UPDATE failed for ' + CAMPAIGN_ID + ':', err.message);
    }
  }

  const remaining = Math.max(0, totalRemaining - sent - blocked);

  return jsonResponse({
    campaign_id: CAMPAIGN_ID,
    wave: Number(wave),
    dry_run: !!dry_run,
    batch_size: BATCH,
    total_remaining_before: totalRemaining,
    sent,
    blocked,
    block_reasons: blockReasons,
    remaining,
    done: remaining === 0,
    sample_copy: dry_run ? dryRunSamples : undefined,
    note: dry_run
      ? `DRY RUN — no sends. ${totalRemaining} customers would receive the Wave ${wave} message. Sample renders above.`
      : (remaining > 0
          ? `Sent ${sent} / ${totalRemaining}. Call again to continue.`
          : `Wave ${wave} complete. Sent ${sent} (${blocked} blocked by guards).`),
  });
}

// Manual enrollment: force-enroll a specific customer list into a campaign, bypassing
// trigger conditions. Renders step-0 using the campaign's drip_schedule + message_variants,
// persists discount_code + expires_at, stamps welcomed_at, actually sends the SMS.
// dryRun skips the Swell send and the DB writes — returns what WOULD be sent.
async function runManualEnrollment({ campaign_id, customer_ids, dryRun }, env) {
  const campaign = await env.DB.prepare(
    "SELECT * FROM retail_campaigns WHERE id = ?"
  ).bind(campaign_id).first();
  if (!campaign) return jsonResponse({ error: 'campaign not found' }, 404);

  // Resolve drip schedule + message variants
  let schedule = null, variants = {};
  try { schedule = campaign.drip_schedule ? JSON.parse(campaign.drip_schedule) : null; } catch {}
  try { variants = campaign.message_variants ? JSON.parse(campaign.message_variants) : {}; } catch {}

  const discount = await env.DB.prepare(
    "SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = 'active' LIMIT 1"
  ).bind(campaign_id).first();
  campaign._discount_code = discount?.code || '';

  const expiryDays = parseInt(campaign.expiry_days, 10) || 14;
  const expiresAt = new Date(Date.now() + expiryDays * 86400000).toISOString();
  campaign._expires_at = expiresAt;

  const isDrip = Array.isArray(schedule) && schedule.length > 0;
  const variantKey = isDrip ? (schedule[0]?.variant || 'welcome') : null;
  const template = variantKey ? (variants[variantKey] || campaign.message_template) : campaign.message_template;

  const results = [];
  for (const customerId of customer_ids) {
    const customer = await env.DB.prepare(
      'SELECT * FROM retail_customers WHERE id = ?'
    ).bind(customerId).first();
    if (!customer) { results.push({ customer_id: customerId, status: 'not_found' }); continue; }

    // Skip if already enrolled (anti-double-send safety)
    const already = await env.DB.prepare(
      `SELECT id FROM retail_campaign_sends WHERE campaign_id = ? AND customer_id = ? AND variant_id = 'drip_step_0'`
    ).bind(campaign_id, customerId).first();
    if (already) { results.push({ customer_id: customerId, status: 'already_enrolled' }); continue; }

    // Suppression + phone check
    if (!customer.normalized_phone && !customer.phone) {
      results.push({ customer_id: customerId, status: 'no_phone' }); continue;
    }
    const suppressed = await env.DB.prepare(
      'SELECT phone FROM sms_suppressions WHERE phone = ?'
    ).bind(customer.normalized_phone || customer.phone).first();
    if (suppressed) { results.push({ customer_id: customerId, status: 'suppressed' }); continue; }

    // Render the welcome copy
    const sms = renderTemplate(template, customer, campaign);

    if (dryRun) {
      results.push({ customer_id: customerId, status: 'dry_run', first_name: customer.first_name, phone: customer.phone, sms });
      continue;
    }

    // Fire Swell SMS
    const send = await sendSwellSMS(customer.phone, sms, env);
    if (!send.success) {
      console.error(`[manual-enroll] Swell send failed for ${customerId}: ${send.error || 'unknown'}`);
      results.push({ customer_id: customerId, status: 'send_failed', error: send.error });
      continue;
    }

    // Record step-0 send with discount + expiry
    const sendId = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (
        id, campaign_id, customer_id, variant_id,
        message_text, sent_at, delay_seconds_actual,
        trigger_event_id, outcome, enrolled_at, created_at,
        discount_code, expires_at
      ) VALUES (?, ?, ?, 'drip_step_0', ?, datetime('now'), 0, 'manual_backfill', 'delivered', datetime('now'), datetime('now'), ?, ?)
    `).bind(sendId, campaign_id, customerId, sms, campaign._discount_code || null, expiresAt).run();

    // Stamp welcomed_at on customer
    await env.DB.prepare(
      `UPDATE retail_customers SET welcomed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND welcomed_at IS NULL`
    ).bind(customerId).run().catch(() => {});

    // Update campaign counters + frequency cap
    await env.DB.prepare(
      `UPDATE retail_campaigns SET total_sent = total_sent + 1, lifetime_enrolled = lifetime_enrolled + 1, updated_at = datetime('now') WHERE id = ?`
    ).bind(campaign_id).run();
    await recordFrequencyCap(customerId, campaign_id, campaign.campaign_type, env).catch(() => {});

    results.push({
      customer_id: customerId, status: 'sent',
      send_id: sendId, first_name: customer.first_name, phone: customer.phone,
      sms, discount_code: campaign._discount_code, expires_at: expiresAt,
    });
    await sleep(500); // rate limit between Swell sends
  }

  const stats = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  return jsonResponse({
    campaign_id,
    campaign_name: campaign.name,
    dry_run: !!dryRun,
    total: customer_ids.length,
    stats,
    expires_at: expiresAt,
    results,
  });
}

async function processCampaignTrigger(signal, env) {
  const { campaign_id, customer_id, delay_seconds, fire_after_ms } = signal;

  // HANDLER-SIDE DELAY ENFORCEMENT (May 13 2026 fix):
  // Cloudflare Queues' deliveryDelay isn't being reliably honored. Re-queue with shorter
  // delay if we fire before the intended fire_after_ms. Defensive — guarantees customer
  // doesn't get an "immediate" Welcome SMS when the campaign config says 2h.
  if (fire_after_ms && Date.now() < fire_after_ms) {
    const remainMs = fire_after_ms - Date.now();
    const remainSec = Math.min(43200, Math.ceil(remainMs / 1000)); // 12h max per Cloudflare
    console.log(`[Continuous] Signal fired ${Math.round(remainMs/1000)}s too early — re-queuing campaign ${campaign_id} for ${customer_id}`);
    await env.SIGNAL_QUEUE.send(signal, { deliveryDelay: remainSec });
    return;
  }

  // Re-validate everything (state may have changed during delay)
  const campaign = await env.DB.prepare(
    "SELECT * FROM retail_campaigns WHERE id = ? AND status = 'active' AND paused_at IS NULL"
  ).bind(campaign_id).first();
  if (!campaign) { console.log(`[Continuous] Campaign ${campaign_id} no longer active, skipping trigger`); return; }

  const customer = await env.DB.prepare(
    'SELECT * FROM retail_customers WHERE id = ? AND sms_eligible = 1'
  ).bind(customer_id).first();
  if (!customer) return;

  // Re-check suppression (customer may have opted out during delay)
  const suppressed = await env.DB.prepare(
    'SELECT phone FROM sms_suppressions WHERE phone = ?'
  ).bind(customer.normalized_phone).first();
  if (suppressed) return;

  // Re-check frequency cap
  if (!await checkFrequencyCap(customer_id, env)) {
    console.log(`[Continuous] Frequency cap hit for ${customer_id}, skipping`);
    return;
  }

  // Already sent in this campaign recently?
  let config;
  try { config = JSON.parse(campaign.trigger_config || '{}'); } catch { config = {}; }
  const reEnrollDays = Math.max(1, Math.min(365, parseInt(config.re_enrollment_days, 10) || 90));
  const alreadySent = await env.DB.prepare(
    `SELECT id FROM retail_campaign_sends WHERE campaign_id = ? AND customer_id = ? AND sent_at >= datetime('now', '-' || ? || ' days')`
  ).bind(campaign_id, customer_id, reEnrollDays).first();
  if (alreadySent) return;

  // Load discount for this campaign (legacy; loyalty mint below is the canonical mechanism)
  const discount = await env.DB.prepare(
    "SELECT * FROM retail_campaign_discounts WHERE campaign_id = ? AND status = 'active' LIMIT 1"
  ).bind(campaign_id).first();

  // POST-MAY-11 (Phase C extension to event-trigger path): mint a Square Loyalty reward
  // via the same path processConditionCampaigns uses. Pre-fix, this function loaded
  // discount code from retail_campaign_discounts but NEVER minted a loyalty reward —
  // so Welcome customers via the queue got an SMS with NO reward in their account.
  // Bug surfaced 2026-05-13 when a customer showed Drew the text but their reward was missing.
  let triggerRewardId = null, triggerAccountId = null;
  const amountCents = campaign.loyalty_amount_cents || (discount?.amount) || 800;
  const preTierId = campaign.loyalty_tier_id || null;
  if (customer.normalized_phone || customer.phone) {
    try {
      const tierId = preTierId || await tierIdForAmount(env, amountCents);
      if (!tierId) {
        console.warn(`[processCampaignTrigger] No loyalty tier for ${amountCents}c — campaign ${campaign_id}, customer ${customer_id} will get SMS without reward. Add tier in Square Dashboard or set retail_campaigns.loyalty_tier_id.`);
      } else {
        const reward = await issueLoyaltyReward(env, {
          phone: customer.normalized_phone || customer.phone,
          tierId,
          idempotencySuffix: `trigger_${campaign_id}_${customer_id}_${new Date().toISOString().slice(0,10)}`,
        });
        if (reward.error) {
          console.warn(`[processCampaignTrigger] issueLoyaltyReward failed: ${reward.error} — proceeding with SMS only`);
        } else {
          triggerRewardId = reward.reward_id;
          triggerAccountId = reward.loyalty_account_id;
          console.log(`[processCampaignTrigger] Minted loyalty reward ${triggerRewardId} for ${customer_id}`);
        }
      }
    } catch (e) {
      console.error(`[processCampaignTrigger] issueLoyaltyReward threw: ${e.message}`);
    }
  }

  // Attach discount code to campaign object for template rendering
  campaign._discount_code = discount?.code || '';
  campaign._loyalty_reward_id = triggerRewardId;
  campaign._loyalty_account_id = triggerAccountId;

  // If campaign has a drip_schedule, this enrollment is step 0. Compute per-enrollee
  // expires_at = now + expiry_days so the drip copy renders a correct concrete date
  // and the win-back sweep has a real timestamp to compare against.
  let dripSchedule = null;
  try { dripSchedule = campaign.drip_schedule ? JSON.parse(campaign.drip_schedule) : null; } catch {}
  const isDrip = Array.isArray(dripSchedule) && dripSchedule.length > 0 && campaign.send_strategy === 'drip';
  const expiryDays = parseInt(campaign.expiry_days, 10) || 14;
  const expiresAt = isDrip ? new Date(Date.now() + expiryDays * 86400000).toISOString() : null;
  campaign._expires_at = expiresAt;

  // Select variant (Thompson Sampling) — or, if this is a drip campaign, use the step-0
  // variant from message_variants.
  const variants = await env.DB.prepare(
    'SELECT * FROM retail_campaign_variants WHERE campaign_id = ? AND active = 1'
  ).bind(campaign_id).all();

  let sms;
  let variantId = 'default';

  if (isDrip) {
    // Drip campaigns: step 0 copy comes from campaign.message_variants[schedule[0].variant]
    variantId = 'drip_step_0';
    let msgVariants = {};
    try { msgVariants = campaign.message_variants ? JSON.parse(campaign.message_variants) : {}; } catch {}
    const variantKey = dripSchedule[0]?.variant || 'welcome';
    const templ = msgVariants[variantKey] || campaign.message_template;
    sms = renderTemplate(templ, customer, campaign);
  } else if (variants.results?.length) {
    const variant = selectWeightedVariant(variants.results);
    sms = renderTemplate(variant.message_template, customer, campaign);
    variantId = variant.id;
  } else if (campaign.message_template) {
    sms = renderTemplate(campaign.message_template, customer, campaign);
  } else {
    sms = getFallbackSMS(customer);
  }

  // Validate
  const validation = await validateSMS(sms, customer, campaign, env);
  if (!validation.pass) {
    if (validation.suggestion) {
      sms = validation.suggestion;
      const recheck = await validateSMS(sms, customer, campaign, env);
      if (!recheck.pass) sms = getFallbackSMS(customer);
    } else {
      sms = getFallbackSMS(customer);
    }
  }

  // 10% holdout
  if (Math.random() < 0.1) {
    await env.DB.prepare(`
      INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, message_text, sent_at, delay_seconds_actual, outcome, created_at)
      VALUES (?, ?, ?, 'holdout', ?, datetime('now'), ?, 'delivered', datetime('now'))
    `).bind(crypto.randomUUID(), campaign_id, customer_id, '[holdout — no SMS sent]', delay_seconds || 0).run();
    return;
  }

  // Send
  const result = await sendSwellSMS(customer.phone, sms, env);
  if (!result.success) {
    console.error(`[Continuous] Swell send failed for ${customer_id}`);
    return;
  }

  // Record send — for drip campaigns, persist discount_code + expires_at so the later
  // drip steps can reuse them verbatim instead of recomputing. Also persist loyalty_reward_id
  // + loyalty_account_id so the cleaner cron can DELETE on expiration + audit traceability.
  await env.DB.prepare(`
    INSERT INTO retail_campaign_sends (
      id, campaign_id, customer_id, variant_id,
      message_text, sent_at, delay_seconds_actual,
      trigger_event_id, outcome, enrolled_at, created_at,
      discount_code, expires_at, loyalty_reward_id, loyalty_account_id
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, 'delivered', datetime('now'), datetime('now'), ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(), campaign_id, customer_id, variantId,
    sms, delay_seconds || 0, signal.trigger_event || null,
    campaign._discount_code || null,
    expiresAt,
    campaign._loyalty_reward_id || null,
    campaign._loyalty_account_id || null,
  ).run();

  // Stamp welcomed_at on drip-campaign enrollments so the win-back sweep has a
  // reliable anchor. welcomed_not_redeemed stays 0 until the sweep actually fires.
  if (isDrip) {
    await env.DB.prepare(
      `UPDATE retail_customers SET welcomed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND welcomed_at IS NULL`
    ).bind(customer_id).run().catch(e => console.error('[retail] welcomed_at stamp failed:', e.message));
  }

  // Update frequency cap
  await recordFrequencyCap(customer_id, campaign_id, campaign.campaign_type, env);

  // Update variant stats
  if (variants.results?.length) {
    await env.DB.prepare(
      'UPDATE retail_campaign_variants SET total_sent = total_sent + 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(variantId).run();
  }

  // Update campaign stats
  await env.DB.prepare(`
    UPDATE retail_campaigns
    SET total_sent = total_sent + 1, lifetime_enrolled = lifetime_enrolled + 1, updated_at = datetime('now')
    WHERE id = ?
  `).bind(campaign_id).run();

  console.log(`[Continuous] Sent ${campaign.campaign_type} to ${customer.first_name || customer_id} (delay: ${delay_seconds}s, variant: ${variantId})`);
}

// ── Condition-monitored continuous campaigns (daily scan) ─────────
// Extract the eligibility-SQL builder used by processConditionCampaigns so we can reuse
// it for dry-run endpoints (preview-cohort, next-cron-queue) without duplicating 100+
// lines of WHERE-clause construction. Returns { where, binds } — caller appends ORDER BY
// and LIMIT plus their own selected columns.
//
// Crucial: the binds array ordering mirrors the old inline builder exactly:
//   1. conditions.* values in declaration order
//   2. campaign.id + reEnrollDays (for own-campaign recent-send exclusion)
//   3. excludeCampaigns spread (for cross-campaign exclusion)
// Do not reorder without verifying against processConditionCampaigns.
function buildEligibilityQuery(campaign) {
  let config = {};
  try { config = JSON.parse(campaign.trigger_config || '{}'); } catch {}
  const conditions = config.conditions || {};
  const reEnrollDays = Math.max(1, Math.min(365, parseInt(config.re_enrollment_days, 10) || 90));

  let excludeCampaigns = [];
  try { excludeCampaigns = campaign.exclude_campaigns ? JSON.parse(campaign.exclude_campaigns) : []; } catch {}

  let where = 'sms_eligible = 1';
  const binds = [];

  if (conditions.visit_count_eq !== undefined) {
    where += ' AND visit_count = ?'; binds.push(conditions.visit_count_eq);
  }
  if (conditions.visit_count_min !== undefined) {
    where += ' AND visit_count >= ?'; binds.push(conditions.visit_count_min);
  }
  if (conditions.visit_count_max !== undefined) {
    where += ' AND visit_count <= ?'; binds.push(conditions.visit_count_max);
  }
  if (conditions.segment_eq !== undefined) {
    where += ' AND segment = ?'; binds.push(conditions.segment_eq);
  }
  if (conditions.segment_in) {
    where += ` AND segment IN (${conditions.segment_in.map(() => '?').join(',')})`;
    binds.push(...conditions.segment_in);
  }
  if (conditions.segment_not_in) {
    where += ` AND segment NOT IN (${conditions.segment_not_in.map(() => '?').join(',')})`;
    binds.push(...conditions.segment_not_in);
  }
  if (conditions.sms_consent_eq !== undefined) {
    where += ' AND sms_consent = ?'; binds.push(conditions.sms_consent_eq);
  }
  if (conditions.sms_eligible_eq !== undefined) {
    where += ' AND sms_eligible = ?'; binds.push(conditions.sms_eligible_eq);
  }
  if (conditions.acquisition_source_eq !== undefined) {
    where += ' AND acquisition_source = ?'; binds.push(conditions.acquisition_source_eq);
  }
  if (Array.isArray(conditions.acquisition_source_in) && conditions.acquisition_source_in.length) {
    where += ` AND acquisition_source IN (${conditions.acquisition_source_in.map(() => '?').join(',')})`;
    binds.push(...conditions.acquisition_source_in);
  }
  if (conditions.days_since_first_visit_min) {
    where += " AND julianday('now') - julianday(first_visit_date) >= ?";
    binds.push(conditions.days_since_first_visit_min);
  }
  if (conditions.days_since_first_visit_max) {
    where += " AND julianday('now') - julianday(first_visit_date) <= ?";
    binds.push(conditions.days_since_first_visit_max);
  }
  if (conditions.days_since_last_visit_min) {
    where += " AND last_visit_date IS NOT NULL AND julianday('now') - julianday(last_visit_date) >= ?";
    binds.push(conditions.days_since_last_visit_min);
  }
  if (conditions.days_since_last_visit_max) {
    where += " AND last_visit_date IS NOT NULL AND julianday('now') - julianday(last_visit_date) <= ?";
    binds.push(conditions.days_since_last_visit_max);
  }
  if (conditions.momentum_below !== undefined) {
    where += ' AND momentum_score < ?'; binds.push(conditions.momentum_below);
  }
  const churnMin = conditions.churn_probability_min ?? conditions.churn_probability_7d_min;
  if (churnMin !== undefined) {
    where += ' AND churn_probability_7d >= ?'; binds.push(churnMin);
  }
  const clvMin = conditions.predicted_clv_min ?? conditions.min_predicted_clv;
  if (clvMin !== undefined) {
    where += ' AND predicted_clv >= ?'; binds.push(clvMin);
  }
  if (conditions.predicted_clv_max !== undefined) {
    where += ' AND predicted_clv <= ?'; binds.push(conditions.predicted_clv_max);
  }
  if (conditions.is_group_buyer) {
    where += ' AND is_group_buyer = 1';
  }

  // Exclude recently sent OR currently held as control in THIS campaign
  where += ` AND id NOT IN (
    SELECT customer_id FROM retail_campaign_sends
    WHERE campaign_id = ?
      AND (
        sent_at >= datetime('now', '-' || ? || ' days')
        OR (ab_arm = 'control' AND control_holdout_until IS NOT NULL AND datetime('now') < control_holdout_until)
      )
  )`;
  binds.push(campaign.id, reEnrollDays);

  // Cross-campaign exclusion
  if (excludeCampaigns.length > 0) {
    where += ` AND id NOT IN (
      SELECT customer_id FROM retail_campaign_sends
      WHERE campaign_id IN (${excludeCampaigns.map(() => '?').join(',')})
        AND (sent_at >= datetime('now', '-180 days')
             OR (ab_arm = 'control' AND control_holdout_until IS NOT NULL AND datetime('now') < control_holdout_until))
    )`;
    binds.push(...excludeCampaigns);
  }

  // Frequency cap (2+ sends in 7 days)
  where += " AND id NOT IN (SELECT customer_id FROM retail_frequency_cap WHERE sent_at >= datetime('now', '-7 days') GROUP BY customer_id HAVING COUNT(*) >= 2)";

  // Suppressions
  where += ' AND normalized_phone NOT IN (SELECT phone FROM sms_suppressions)';

  // Fake/junk first_name filtering
  where += " AND LOWER(first_name) NOT IN ('visa cardholder','mastercard','cardholder','card holder','test','guest','customer','unknown','n/a','none','online order')";
  where += " AND first_name NOT GLOB '+*'";
  where += " AND first_name NOT GLOB '1[0-9]*'";
  where += " AND LENGTH(TRIM(first_name)) >= 2";
  where += ' AND first_name IS NOT NULL';

  return { where, binds };
}

async function processConditionCampaigns(env, brainContext = '') {
  const campaigns = await env.DB.prepare(`
    SELECT * FROM retail_campaigns
    WHERE campaign_mode = 'continuous'
      AND trigger_type = 'condition'
      AND status = 'active'
      AND paused_at IS NULL
  `).all();

  // Weekend skip — condition-campaign enrollments pause Sat/Sun. Welcome drip continues.
  // Uses MT (America/Denver). 0=Sun, 6=Sat.
  const mtDay = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'short' });
  if (mtDay === 'Sat' || mtDay === 'Sun') {
    console.log(`[Continuous] Skipping condition-campaign enrollments on ${mtDay} (weekend hold)`);
    return 0;
  }

  let totalEnrolled = 0;

  for (const campaign of (campaigns.results || [])) {
    // Parse ab_config for A/B testing (separate from eligibility — only used for arm assignment)
    let abConfig = null;
    try { abConfig = campaign.ab_config ? JSON.parse(campaign.ab_config) : null; } catch {}

    // Build WHERE + binds using the shared helper (same logic is reused by preview-cohort
    // and next-cron-queue endpoints). Append our LIMIT bind for this run.
    const { where, binds } = buildEligibilityQuery(campaign);
    const limit = campaign.daily_send_limit || 10;
    binds.push(limit);

    const eligible = await env.DB.prepare(`
      SELECT id, phone, normalized_phone, first_name, favorite_sku, visit_count,
             avg_order_value, churn_risk_score, predicted_clv, behavior_type,
             momentum_score, last_visit_date, first_visit_date, segment
      FROM retail_customers
      WHERE ${where}
      ORDER BY predicted_clv DESC
      LIMIT ?
    `).bind(...binds).all();

    const customers = eligible.results || [];
    if (!customers.length) continue;

    // C.10 — Resolve mint amount + tier from DB columns (single source of truth).
    // Priority: (1) campaign.loyalty_amount_cents + loyalty_tier_id → (2) REPAIR_TIER_BY_CAMPAIGN
    // JS fallback → (3) legacy retail_campaign_discounts template → (4) $10 default.
    // New campaigns just set the two DB columns and inherit full pipeline — no code deploy needed.
    let perCustomerDiscountAmount = campaign.loyalty_amount_cents;
    let preResolvedTierId = campaign.loyalty_tier_id || null;
    if (!perCustomerDiscountAmount) {
      const cfg = REPAIR_TIER_BY_CAMPAIGN[campaign.id];
      perCustomerDiscountAmount = cfg?.amountCents;
      preResolvedTierId = preResolvedTierId || cfg?.tierId;
    }
    if (!perCustomerDiscountAmount) {
      const discountTemplate = await env.DB.prepare(
        "SELECT amount FROM retail_campaign_discounts WHERE campaign_id = ? AND status = 'active' AND code IN ('DPGOLD','DPSLVR','DPFIRST','DPMOMX','DPPLAT') LIMIT 1"
      ).bind(campaign.id).first();
      perCustomerDiscountAmount = discountTemplate?.amount || 1000;
    }
    const perCustomerValidDays = parseInt(campaign.expiry_days, 10) || 14;
    const codePrefix = campaign.code_prefix || 'DP';

    // Load variants
    const variants = await env.DB.prepare(
      'SELECT * FROM retail_campaign_variants WHERE campaign_id = ? AND active = 1'
    ).bind(campaign.id).all();

    let campaignEnrolled = 0;     // Per-campaign enrollment counter (tombstones + controls + holdouts + sends)
    let campaignActualSends = 0;  // Real SMS deliveries only — drives total_sent for accurate ROI math

    for (const customer of customers) {
      // For drip campaigns, enroll AND mint the loyalty reward at step_0 so steps 1+
      // reference a real reward. Pre-May-11 the mint was skipped and downstream steps
      // referenced NULL discount_code/expires_at — broken silently for Welcome's whole drip.
      // C.0 May-11 fix: mint at enrollment time, store loyalty_reward_id + expires_at for the
      // drip stepper (processDripSequences) to pick up from the step_0 row.
      if (campaign.send_strategy === 'drip') {
        let dripRewardId = null, dripAccountId = null, dripExpiresAt = null;
        if (env._dryRunConditionCampaigns !== true) {
          const phone = customer.normalized_phone || customer.phone;
          const tierId = preResolvedTierId || await tierIdForAmount(env, perCustomerDiscountAmount);
          if (!phone || !tierId) {
            console.warn(`[drip-enroll] Skip ${customer.id} — phone=${!!phone} tier=${tierId} (amount ${perCustomerDiscountAmount}c)`);
            continue;
          }
          try {
            const reward = await issueLoyaltyReward(env, {
              phone, tierId,
              idempotencySuffix: `drip_${campaign.id}_${customer.id}_${new Date().toISOString().slice(0,10)}`,
            });
            if (reward.error) {
              console.warn(`[drip-enroll] Skip ${customer.id} — issueLoyaltyReward: ${reward.error}`);
              continue;
            }
            dripRewardId = reward.reward_id;
            dripAccountId = reward.loyalty_account_id;
            dripExpiresAt = new Date(Date.now() + perCustomerValidDays * 86400000).toISOString().slice(0,10);
          } catch (e) {
            console.error(`[drip-enroll] issueLoyaltyReward threw for ${customer.id}:`, e.message);
            continue;
          }
        }
        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, message_text, outcome, enrolled_at, created_at, loyalty_reward_id, loyalty_account_id, expires_at)
          VALUES (?, ?, ?, 'drip_step_0', '[enrolled in continuous drip]', 'pending', datetime('now'), datetime('now'), ?, ?, ?)
        `).bind(crypto.randomUUID(), campaign.id, customer.id, dripRewardId, dripAccountId, dripExpiresAt).run();

        await env.DB.prepare("UPDATE retail_customers SET active_campaign_id = ? WHERE id = ?").bind(campaign.id, customer.id).run();
        campaignEnrolled++;
        totalEnrolled++;
        continue;
      }

      // For immediate: select variant, render, validate, send
      let sms;
      let variantId = 'default';
      let abArm = null;
      let perCustomerCode = null;
      let perCustomerDiscountRow = null;

      // A/B assignment FIRST — determines if this customer needs a code at all.
      // Controls are tombstoned (no send, no code generated).
      let messageVariants = {};
      try { messageVariants = campaign.message_variants ? JSON.parse(campaign.message_variants) : {}; } catch {}

      if (abConfig && Array.isArray(abConfig.arms) && abConfig.arms.length > 0) {
        abArm = assignArm(customer.id, abConfig);
        if (abArm === 'control') {
          // Insert tombstone row — don't send, hold out for 14 days, pick up in graduate-controls
          await env.DB.prepare(`
            INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, ab_arm, message_text, sent_at, outcome, enrolled_at, control_holdout_until, created_at)
            VALUES (?, ?, ?, 'drip_step_0', 'control', '[control — no send]', NULL, 'control_hold', datetime('now'), datetime('now','+14 days'), datetime('now'))
          `).bind(crypto.randomUUID(), campaign.id, customer.id).run();
          campaignEnrolled++;
          totalEnrolled++;
          continue;
        }
      }

      // POST-MAY-11 MIGRATION: mint via Square Loyalty Rewards instead of Catalog DISCOUNT.
      // The old createSquareDiscount() path produced codes that were NOT customer-typeable
      // in Square Online or Register — only cashiers could apply them via FOH search.
      // Loyalty rewards are bound to the customer's phone → they enter their phone at
      // checkout and the reward auto-applies in BOTH flows. Per-customer unique by mechanism.
      //
      // Dry-run mode: skip the mint to avoid burning real Square API calls during audits.
      let perCustomerLoyaltyAccountId = null;
      let perCustomerRewardId = null;
      let perCustomerTierId = null;

      if (env._dryRunConditionCampaigns === true) {
        perCustomerCode = `LOYALTY_DRYRUN`;
      } else {
        const phone = customer.normalized_phone || customer.phone;
        if (!phone) {
          console.warn(`[retail] Skipping ${customer.id} — no phone for loyalty enrollment`);
          continue;
        }
        const tierId = preResolvedTierId || await tierIdForAmount(env, perCustomerDiscountAmount);
        if (!tierId) {
          console.warn(`[retail] Skipping ${customer.id} — no loyalty tier exists for amount ${perCustomerDiscountAmount}c (campaign ${campaign.id}). Add tier in Square Dashboard.`);
          continue;
        }
        try {
          const reward = await issueLoyaltyReward(env, {
            phone,
            tierId,
            idempotencySuffix: `${campaign.id}_${customer.id}_${new Date().toISOString().slice(0,10)}`,
          });
          if (reward.error) {
            console.warn(`[retail] Skipping ${customer.id} — issueLoyaltyReward failed: ${reward.error}`);
            continue;
          }
          perCustomerLoyaltyAccountId = reward.loyalty_account_id;
          perCustomerRewardId = reward.reward_id;
          perCustomerTierId = tierId;
          // Stub for any legacy {code} placeholder in transitional templates. New templates
          // (post-B.8 migration) use "Enter your phone at checkout" and don't reference {code}.
          perCustomerCode = '';
        } catch (e) {
          console.error(`[retail] issueLoyaltyReward threw for ${customer.id}:`, e.message);
          continue;
        }
      }

      campaign._discount_code = perCustomerCode;
      campaign._loyalty_account_id = perCustomerLoyaltyAccountId;
      campaign._loyalty_reward_id = perCustomerRewardId;
      campaign._loyalty_tier_id = perCustomerTierId;
      campaign._expires_at = new Date(Date.now() + perCustomerValidDays * 86400000).toISOString();

      if (abConfig && Array.isArray(abConfig.arms) && abConfig.arms.length > 0) {
        // Find the arm spec to pick variant_key
        const arm = abConfig.arms.find(a => a.name === abArm);
        const variantKey = arm?.variant_key;
        if (variantKey && messageVariants[variantKey]) {
          sms = renderTemplate(messageVariants[variantKey], customer, campaign);
          variantId = variantKey;
        } else if (campaign.message_template) {
          sms = renderTemplate(campaign.message_template, customer, campaign);
          variantId = abArm || 'default';
        } else {
          sms = getFallbackSMS(customer);
        }
      } else if (variants.results?.length) {
        const variant = selectWeightedVariant(variants.results);
        sms = renderTemplate(variant.message_template, customer, campaign);
        variantId = variant.id;
      } else if (campaign.message_template) {
        sms = renderTemplate(campaign.message_template, customer, campaign);
      } else {
        sms = getFallbackSMS(customer);
      }

      // Validate. If validation fails, SKIP this customer — do NOT fall back to
      // getFallbackSMS (which is a code-less generic message that defeats the campaign's
      // entire purpose). Log a tombstone so we can see what was rejected.
      const validation = await validateSMS(sms, customer, campaign, env);
      if (!validation.pass) {
        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, ab_arm, message_text, sent_at, outcome, enrolled_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 'validation_rejected', datetime('now'), datetime('now'))
        `).bind(
          crypto.randomUUID(), campaign.id, customer.id, variantId, abArm,
          `[validation rejected: ${(validation.issues || []).join('; ').slice(0, 200)}] ${sms.slice(0, 80)}`
        ).run().catch(e => console.error('[retail] validation tombstone insert failed:', e.message));
        console.warn(`[retail] Skipped ${customer.id} (${customer.first_name || 'no-name'}) — ${validation.issues?.join('; ')}`);
        continue;
      }

      // Dry-run short-circuit: if the cohort runner requested dry_run, we log the would-be
      // send as a tombstone but skip the Swell call + stats update. Useful for auditing the
      // next cohort before firing real messages.
      if (env._dryRunConditionCampaigns === true) {
        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, ab_arm, message_text, sent_at, outcome, enrolled_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, 'dry_run', datetime('now'), datetime('now'))
        `).bind(crypto.randomUUID(), campaign.id, customer.id, variantId, abArm, '[DRY-RUN] ' + sms).run();
        campaignEnrolled++;
        totalEnrolled++;
        continue;
      }

      // 10% holdout
      if (Math.random() < 0.1) {
        await env.DB.prepare(`
          INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, message_text, sent_at, outcome, enrolled_at, created_at)
          VALUES (?, ?, ?, 'holdout', '[holdout]', datetime('now'), 'delivered', datetime('now'), datetime('now'))
        `).bind(crypto.randomUUID(), campaign.id, customer.id).run();
        campaignEnrolled++;
        totalEnrolled++;
        continue;
      }

      const result = await sendSwellSMS(customer.phone, sms, env);
      if (!result.success) continue;

      await env.DB.prepare(`
        INSERT INTO retail_campaign_sends (id, campaign_id, customer_id, variant_id, ab_arm, message_text, sent_at, outcome, enrolled_at, created_at, discount_code, expires_at, loyalty_reward_id, loyalty_account_id)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'delivered', datetime('now'), datetime('now'), ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(), campaign.id, customer.id, variantId, abArm, sms,
        perCustomerCode,
        campaign._expires_at,
        campaign._loyalty_reward_id || null,
        campaign._loyalty_account_id || null
      ).run();

      await recordFrequencyCap(customer.id, campaign.id, campaign.campaign_type, env);

      if (variants.results?.length) {
        await env.DB.prepare('UPDATE retail_campaign_variants SET total_sent = total_sent + 1 WHERE id = ?').bind(variantId).run();
      }

      campaignEnrolled++;
      campaignActualSends++;  // Real send — only counted here, NOT on control/holdout/validation_rejected paths
      totalEnrolled++;
      await sleep(500);
    }

    // Update campaign stats. total_sent counts REAL SMS deliveries only (so return rate math
    // has the correct denominator). lifetime_enrolled counts every tombstone + control +
    // holdout + send for cohort bookkeeping.
    if (campaignEnrolled > 0) {
      await env.DB.prepare(`
        UPDATE retail_campaigns
        SET total_sent = total_sent + ?, lifetime_enrolled = lifetime_enrolled + ?,
            last_enrollment_scan = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).bind(campaignActualSends, campaignEnrolled, campaign.id).run();
    }
  }

  if (totalEnrolled > 0) {
    console.log(`[Continuous] Enrolled ${totalEnrolled} customers across condition-monitored campaigns`);
  }
  return totalEnrolled;
}

// ── Health monitoring for continuous campaigns ───────────────────
async function monitorCampaignHealth(env) {
  const campaigns = await env.DB.prepare(`
    SELECT * FROM retail_campaigns
    WHERE campaign_mode = 'continuous' AND status = 'active'
  `).all();

  let checks = 0;
  for (const campaign of (campaigns.results || [])) {
    const metrics = await env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN sent_at >= datetime('now', '-7 days') THEN 1 END) as sent_7d,
        COUNT(CASE WHEN sent_at >= datetime('now', '-7 days') AND outcome = 'returned' THEN 1 END) as returned_7d,
        COUNT(CASE WHEN sent_at >= datetime('now', '-7 days') AND outcome = 'unsubscribed' THEN 1 END) as optouts_7d,
        COUNT(CASE WHEN sent_at >= datetime('now', '-30 days') THEN 1 END) as sent_30d,
        COUNT(CASE WHEN sent_at >= datetime('now', '-30 days') AND outcome = 'returned' THEN 1 END) as returned_30d,
        COALESCE(SUM(CASE WHEN sent_at >= datetime('now', '-30 days') THEN return_order_value ELSE 0 END), 0) as revenue_30d
      FROM retail_campaign_sends WHERE campaign_id = ?
    `).bind(campaign.id).first();

    // Update rolling metrics
    await env.DB.prepare(`
      UPDATE retail_campaigns SET
        rolling_7d_sent = ?, rolling_7d_returned = ?, rolling_7d_optouts = ?,
        rolling_30d_sent = ?, rolling_30d_returned = ?, rolling_30d_revenue = ?,
        last_health_check = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      metrics?.sent_7d || 0, metrics?.returned_7d || 0, metrics?.optouts_7d || 0,
      metrics?.sent_30d || 0, metrics?.returned_30d || 0, metrics?.revenue_30d || 0,
      campaign.id,
    ).run();

    // Determine health status
    let healthStatus = 'healthy';
    let pauseReason = null;

    const sent7d = metrics?.sent_7d || 0;
    const optoutRate7d = sent7d > 10 ? (metrics?.optouts_7d || 0) / sent7d : 0;
    const returnRate7d = sent7d > 10 ? (metrics?.returned_7d || 0) / sent7d : null;

    if (optoutRate7d > 0.05) {
      healthStatus = 'critical';
      pauseReason = 'auto_optout_spike';
    } else if (optoutRate7d > 0.03) {
      healthStatus = 'warning';
    }

    if (returnRate7d !== null && returnRate7d < 0.01 && (metrics?.sent_30d || 0) > 30) {
      healthStatus = 'critical';
      pauseReason = pauseReason || 'auto_conversion_drop';
    } else if (returnRate7d !== null && returnRate7d < 0.03 && (metrics?.sent_30d || 0) > 30) {
      healthStatus = healthStatus === 'critical' ? 'critical' : 'warning';
    }

    // Auto-pause if critical and not already paused
    if (healthStatus === 'critical' && !campaign.paused_at) {
      await env.DB.prepare(`
        UPDATE retail_campaigns SET
          paused_at = datetime('now'), pause_reason = ?,
          health_status = 'auto_paused', updated_at = datetime('now')
        WHERE id = ?
      `).bind(pauseReason, campaign.id).run();

      await env.DB.prepare(`
        INSERT INTO retail_campaign_health_log (id, campaign_id, event_type, old_status, new_status, metrics_snapshot, reason, created_at)
        VALUES (?, ?, 'auto_pause', 'active', 'auto_paused', ?, ?, datetime('now'))
      `).bind(
        crypto.randomUUID(), campaign.id,
        JSON.stringify({ optout_rate_7d: Math.round(optoutRate7d * 100) / 100, return_rate_7d: returnRate7d ? Math.round(returnRate7d * 100) / 100 : null, sent_30d: metrics?.sent_30d }),
        pauseReason,
      ).run();

      console.log(`[Continuous] AUTO-PAUSED: ${campaign.name} — ${pauseReason}`);
    } else if (healthStatus !== campaign.health_status) {
      await env.DB.prepare('UPDATE retail_campaigns SET health_status = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(healthStatus, campaign.id).run();
    }

    checks++;
  }

  return checks;
}

// ── Pause/Resume endpoints ───────────────────────────────────────
async function pauseCampaign(request, env) {
  const { campaign_id } = await request.json();
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

  await env.DB.prepare(`
    UPDATE retail_campaigns SET paused_at = datetime('now'), pause_reason = 'manual', health_status = 'auto_paused', updated_at = datetime('now') WHERE id = ?
  `).bind(campaign_id).run();

  await env.DB.prepare(`
    INSERT INTO retail_campaign_health_log (id, campaign_id, event_type, old_status, new_status, reason, created_at)
    VALUES (?, ?, 'manual_pause', ?, 'paused', 'manual', datetime('now'))
  `).bind(crypto.randomUUID(), campaign_id, campaign.health_status || 'healthy').run();

  return jsonResponse({ paused: true, campaign_id });
}

async function resumeCampaign(request, env) {
  const { campaign_id } = await request.json();
  const campaign = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(campaign_id).first();
  if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

  await env.DB.prepare(`
    UPDATE retail_campaigns SET paused_at = NULL, pause_reason = NULL, health_status = 'healthy', updated_at = datetime('now') WHERE id = ?
  `).bind(campaign_id).run();

  await env.DB.prepare(`
    INSERT INTO retail_campaign_health_log (id, campaign_id, event_type, old_status, new_status, reason, created_at)
    VALUES (?, ?, 'resume', 'paused', 'healthy', 'manual_resume', datetime('now'))
  `).bind(crypto.randomUUID(), campaign_id).run();

  return jsonResponse({ resumed: true, campaign_id });
}

// ── Emergency kill-switch (Tier 1a) ───────────────────────────────
// One-click "halt all SMS now." Flips paused_at on every currently-sending
// campaign so processConditionCampaigns (line ~7645) skips them on its next
// cron tick. We do NOT change `status` — Drew can resume individually from
// the CAMPAIGNS tab later. Each flip writes a health_log row tagged
// 'emergency_pause' so there's a trail of what was paused and when.
//
// Scope: campaigns with paused_at IS NULL AND status IN ('active', 'pending_approval').
// Excludes 'draft' (not sending anyway) and 'archived'/'completed' (already dead).
async function emergencyPauseAllSMS(env) {
  // Snapshot the set we're about to pause — need IDs for health_log rows.
  const target = await env.DB.prepare(`
    SELECT id, health_status FROM retail_campaigns
    WHERE paused_at IS NULL AND status IN ('active', 'pending_approval')
  `).all();
  const rows = target.results || [];

  if (rows.length === 0) {
    return jsonResponse({
      paused_count: 0,
      note: 'No campaigns were in a sending state — nothing to pause.',
    });
  }

  // Bulk flip
  await env.DB.prepare(`
    UPDATE retail_campaigns
    SET paused_at = datetime('now'), pause_reason = 'emergency_kill_switch',
        health_status = 'auto_paused', updated_at = datetime('now')
    WHERE paused_at IS NULL AND status IN ('active', 'pending_approval')
  `).run();

  // One health_log row per campaign so /retail/campaigns/:id/detail shows the event.
  // Not batched via UNION — the health_log id is a UUID per row.
  for (const c of rows) {
    await env.DB.prepare(`
      INSERT INTO retail_campaign_health_log
        (id, campaign_id, event_type, old_status, new_status, reason, created_at)
      VALUES (?, ?, 'emergency_pause', ?, 'paused', 'emergency_kill_switch', datetime('now'))
    `).bind(crypto.randomUUID(), c.id, c.health_status || 'healthy').run().catch(err => {
      console.error('[emergencyPause] health_log insert failed for', c.id, err.message);
    });
  }

  return jsonResponse({
    paused_count: rows.length,
    paused_campaign_ids: rows.map(r => r.id),
    paused_at: new Date().toISOString(),
    note: 'All active SMS sending halted. Resume individual campaigns from the CAMPAIGNS tab.',
  });
}

// Quick status probe for the kill-switch pill on the Retail header.
// Returns how many campaigns are paused-by-kill-switch vs paused-manually vs active.
async function getKillSwitchStatus(env) {
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN paused_at IS NULL AND status = 'active' THEN 1 ELSE 0 END) as active_sending,
      SUM(CASE WHEN paused_at IS NOT NULL AND pause_reason = 'emergency_kill_switch' THEN 1 ELSE 0 END) as emergency_paused,
      SUM(CASE WHEN paused_at IS NOT NULL AND pause_reason != 'emergency_kill_switch' THEN 1 ELSE 0 END) as other_paused,
      MAX(CASE WHEN pause_reason = 'emergency_kill_switch' THEN paused_at ELSE NULL END) as last_kill_switch_at
    FROM retail_campaigns
    WHERE status IN ('active', 'pending_approval', 'paused')
  `).first();

  return jsonResponse({
    active_sending: counts?.active_sending || 0,
    emergency_paused: counts?.emergency_paused || 0,
    other_paused: counts?.other_paused || 0,
    last_kill_switch_at: counts?.last_kill_switch_at || null,
    all_halted: (counts?.active_sending || 0) === 0 && (counts?.emergency_paused || 0) > 0,
  });
}

// ── Create continuous campaign ───────────────────────────────────
async function createContinuousCampaign(request, env) {
  const body = await request.json();
  const {
    name, campaign_type, trigger_type, trigger_config,
    message_variants, message_template,
    send_strategy = 'immediate', drip_schedule,
    daily_send_limit = 10,
    discount_type, discount_amount,
  } = body;

  if (!name || !campaign_type || !trigger_type) {
    return jsonResponse({ error: 'name, campaign_type, and trigger_type required' }, 400);
  }

  const id = crypto.randomUUID();

  // Create the campaign
  await env.DB.prepare(`
    INSERT INTO retail_campaigns (
      id, name, campaign_type, campaign_mode, trigger_type, trigger_config,
      status, target_segment, send_strategy, drip_schedule,
      daily_send_limit, message_template,
      approval_status, health_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'continuous', ?, ?, 'active', 'all', ?, ?, ?, ?, 'approved', 'healthy', datetime('now'), datetime('now'))
  `).bind(
    id, name, campaign_type, trigger_type,
    JSON.stringify(trigger_config || {}),
    send_strategy, drip_schedule ? JSON.stringify(drip_schedule) : null,
    daily_send_limit, message_template || null,
  ).run();

  // Create message variants if provided
  if (message_variants?.length) {
    for (const v of message_variants) {
      await env.DB.prepare(`
        INSERT INTO retail_campaign_variants (id, campaign_id, variant_label, message_template, weight, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(crypto.randomUUID(), id, v.label || 'A', v.template, v.weight || (1 / message_variants.length)).run();
    }
  } else if (message_template) {
    // Create single default variant
    await env.DB.prepare(`
      INSERT INTO retail_campaign_variants (id, campaign_id, variant_label, message_template, weight, created_at, updated_at)
      VALUES (?, ?, 'A', ?, 1.0, datetime('now'), datetime('now'))
    `).bind(crypto.randomUUID(), id, message_template).run();
  }

  // Create discount if requested
  let disc = null;
  if (discount_amount) {
    try {
      disc = await createSquareDiscount(env, {
        campaignId: id,
        discountType: discount_type || 'FIXED_AMOUNT',
        amount: discount_amount,
        validDays: 30, // Longer for continuous campaigns
        maxRedemptions: null, // No cap for continuous
      });
    } catch (err) {
      console.error(`[Continuous] Discount creation failed: ${err.message}`);
    }
  }

  // Auto-create campaign rules entry
  await env.DB.prepare(`
    INSERT OR IGNORE INTO retail_campaign_rules (campaign_type, auto_approve, min_runs_required, min_return_rate, max_opt_out_rate, runs_completed)
    VALUES (?, 1, 0, 0, 0.05, 0)
  `).bind(campaign_type).run();

  const created = await env.DB.prepare('SELECT * FROM retail_campaigns WHERE id = ?').bind(id).first();

  return jsonResponse({
    created: true,
    campaign: created,
    discount: disc,
    variants: message_variants?.length || 1,
  });
}

// ── Get continuous campaigns with health data ────────────────────
async function getContinuousCampaigns(env) {
  // Filter out archived/draft campaigns — the dashboard renders every row as LIVE or
  // PAUSED (via paused_at), but has no rendering for archived. Without this filter,
  // archived campaigns like First-Timer Day 7 Nudge (consolidated away in migration 025)
  // kept showing up in the Always-On list with a misleading LIVE badge.
  const campaigns = await env.DB.prepare(`
    SELECT rc.*,
      (SELECT COUNT(*) FROM retail_campaign_variants WHERE campaign_id = rc.id AND active = 1) as variant_count
    FROM retail_campaigns rc
    WHERE rc.campaign_mode = 'continuous'
      AND rc.status = 'active'
    ORDER BY rc.created_at DESC
  `).all();

  const results = [];
  for (const c of (campaigns.results || [])) {
    // Get variants
    const variants = await env.DB.prepare(
      'SELECT id, variant_label, total_sent, total_returned, total_optouts, total_revenue, weight, active FROM retail_campaign_variants WHERE campaign_id = ?'
    ).bind(c.id).all();

    // Get discount
    const discount = await env.DB.prepare(
      "SELECT code, discount_type, amount, times_redeemed FROM retail_campaign_discounts WHERE campaign_id = ? AND status = 'active' LIMIT 1"
    ).bind(c.id).first();

    // Cost calculation
    const discountCost = discount ? (discount.times_redeemed || 0) * (discount.discount_type === 'FIXED_AMOUNT' ? discount.amount / 100 : 0) : 0;

    results.push({
      ...c,
      variants: variants.results || [],
      discount,
      cost: {
        discount_cost: Math.round(discountCost * 100) / 100,
        revenue_attributed: c.rolling_30d_revenue || 0,
        roi: discountCost > 0 ? Math.round(((c.rolling_30d_revenue || 0) / discountCost) * 100) / 100 : null,
      },
      rolling_7d: {
        sent: c.rolling_7d_sent || 0,
        returned: c.rolling_7d_returned || 0,
        optouts: c.rolling_7d_optouts || 0,
        return_rate: (c.rolling_7d_sent || 0) > 0 ? Math.round((c.rolling_7d_returned / c.rolling_7d_sent) * 100) : null,
      },
      rolling_30d: {
        sent: c.rolling_30d_sent || 0,
        returned: c.rolling_30d_returned || 0,
        revenue: c.rolling_30d_revenue || 0,
        return_rate: (c.rolling_30d_sent || 0) > 0 ? Math.round((c.rolling_30d_returned / c.rolling_30d_sent) * 100) : null,
      },
    });
  }

  return jsonResponse({ campaigns: results });
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
