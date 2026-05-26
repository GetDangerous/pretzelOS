// retail-suggestions-worker.js
// Hourly cron `15 * * * *`. Computes formula-driven candidate actions from live D1
// signals, ranks by projected $ impact, persists top 6 to retail_suggestions table.
// No AI. Cheap.
//
// Closed-loop learning: applies a track-record multiplier when past instances of
// the same suggestion_id have been marked done with measured outcomes.
//
// See plan: /Users/drew/.claude/plans/iterative-frolicking-hollerith.md

// ── Helpers ────────────────────────────────────────────────────────────
async function loadSignals(env) {
  // Pull every signal we need in one parallel batch. Cheap queries only.
  const [
    identifiedPct, monthlyFirstTimers, welcomeStats, avgReturnerLtv,
    loyaltyOrganic, loyaltyAvgLtv, nonLoyaltyAvgLtv,
    emailFunnel, burningCampaigns, atRiskVips,
    cohortRecent, cohortPrior,
  ] = await Promise.all([
    // % of last-30d Square orders with customer_id (identified)
    env.DB.prepare(`
      SELECT
        ROUND(100.0 * COUNT(*) FILTER (WHERE customer_id IS NOT NULL) / COUNT(*), 1) as pct,
        COUNT(*) as total
      FROM orders
      WHERE source IN ('square','square_delivery')
        AND order_date >= datetime('now','-30 days')
    `).first().catch(() => ({ pct: 0, total: 0 })),

    // First-timers per month (April pace ≈ baseline)
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM retail_customers
      WHERE first_visit_date >= datetime('now','-30 days')
    `).first().catch(() => ({ cnt: 0 })),

    // Welcome campaign lifetime conversion
    env.DB.prepare(`
      SELECT lifetime_sent, lifetime_returned,
        CASE WHEN lifetime_sent > 0 THEN ROUND(100.0 * lifetime_returned / lifetime_sent, 1) ELSE 0 END as conv_pct
      FROM retail_campaigns
      WHERE campaign_type = 'welcome_free_pretzel'
      LIMIT 1
    `).first().catch(() => ({ lifetime_sent: 0, lifetime_returned: 0, conv_pct: 0 })),

    // Avg LTV among customers who came back
    env.DB.prepare(`
      SELECT ROUND(AVG(total_lifetime_value), 2) as v FROM retail_customers
      WHERE visit_count >= 2 AND total_lifetime_value > 0
    `).first().catch(() => ({ v: 30 })),

    // Loyalty organic signups per day (last 7d)
    env.DB.prepare(`
      SELECT COUNT(*) / 7.0 as per_day FROM loyalty_accounts
      WHERE enrolled_at >= datetime('now','-7 days')
    `).first().catch(() => ({ per_day: 0 })),

    // Loyalty member avg LTV (those who actually transacted)
    env.DB.prepare(`
      SELECT ROUND(AVG(rc.total_lifetime_value), 2) as v
      FROM loyalty_accounts la
      JOIN retail_customers rc ON rc.normalized_phone = REPLACE(REPLACE(REPLACE(REPLACE((SELECT phone FROM square_customers WHERE square_customer_id = la.square_customer_id), '+1', ''), '-', ''), ' ', ''), '(', '')
      WHERE rc.visit_count > 0
    `).first().catch(() => ({ v: null })),

    // Non-loyalty avg LTV
    env.DB.prepare(`
      SELECT ROUND(AVG(total_lifetime_value), 2) as v FROM retail_customers WHERE visit_count > 0
    `).first().catch(() => ({ v: 30 })),

    // Email funnel last 7d
    env.DB.prepare(`
      SELECT
        COUNT(*) as sent,
        COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
        COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as bounced
      FROM email_sends
      WHERE sent_at >= datetime('now','-7 days')
        AND status IN ('sent','delivered','bounced','complained','unsubscribed')
    `).first().catch(() => ({ sent: 0, opened: 0, bounced: 0 })),

    // Burning-audience campaigns: high send volume + low conversion in last 30d
    env.DB.prepare(`
      SELECT rc.id, rc.name, rc.daily_send_limit,
        SUM(CASE WHEN rcs.sent_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) as sends_30d,
        SUM(CASE WHEN rcs.sent_at >= datetime('now','-30 days') AND rcs.returned_at IS NOT NULL THEN 1 ELSE 0 END) as returns_30d
      FROM retail_campaigns rc
      LEFT JOIN retail_campaign_sends rcs ON rcs.campaign_id = rc.id
      WHERE rc.status = 'active'
      GROUP BY rc.id
      HAVING sends_30d > 200 AND (sends_30d > 0 AND CAST(returns_30d AS REAL) / sends_30d < 0.01)
      ORDER BY sends_30d DESC
    `).all().catch(() => ({ results: [] })),

    // VIPs (10+ visits) who haven't been seen in 21+ days
    env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM retail_customers
      WHERE visit_count >= 10 AND last_visit_date < datetime('now','-21 days')
    `).first().catch(() => ({ cnt: 0 })),

    // Cohort retention: most recent 4 weeks of first-visits
    env.DB.prepare(`
      SELECT COUNT(*) as first_timers,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners
      FROM retail_customers
      WHERE first_visit_date >= datetime('now','-28 days')
    `).first().catch(() => ({ first_timers: 0, returners: 0 })),

    // Cohort retention: prior 4 weeks (28-56 days ago)
    env.DB.prepare(`
      SELECT COUNT(*) as first_timers,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners
      FROM retail_customers
      WHERE first_visit_date >= datetime('now','-56 days')
        AND first_visit_date < datetime('now','-28 days')
    `).first().catch(() => ({ first_timers: 0, returners: 0 })),
  ]);

  return {
    identified_pct: (identifiedPct?.pct || 0) / 100,
    identified_orders_30d: identifiedPct?.total || 0,
    monthly_first_timers: monthlyFirstTimers?.cnt || 0,
    welcome_conv: (welcomeStats?.conv_pct || 0) / 100,
    welcome_lifetime_sent: welcomeStats?.lifetime_sent || 0,
    avg_returner_ltv: avgReturnerLtv?.v || 30,
    loyalty_organic_per_day: loyaltyOrganic?.per_day || 0,
    loyalty_avg_ltv: loyaltyAvgLtv?.v,
    non_loyalty_avg_ltv: nonLoyaltyAvgLtv?.v || 30,
    email_sent_7d: emailFunnel?.sent || 0,
    email_opened_7d: emailFunnel?.opened || 0,
    email_open_rate: emailFunnel?.sent > 0 ? emailFunnel.opened / emailFunnel.sent : null,
    email_bounce_rate: emailFunnel?.sent > 0 ? emailFunnel.bounced / emailFunnel.sent : null,
    burning_campaigns: burningCampaigns?.results || [],
    at_risk_vips: atRiskVips?.cnt || 0,
    cohort_recent_4wk_pct: cohortRecent?.first_timers > 0 ? cohortRecent.returners / cohortRecent.first_timers : null,
    cohort_prior_4wk_pct: cohortPrior?.first_timers > 0 ? cohortPrior.returners / cohortPrior.first_timers : null,
  };
}

// Track-record multiplier: average past `done_outcome_pct` for this suggestion_id.
// First instance returns 1.0 (no track record yet).
async function trackRecordMultiplier(env, suggestionId) {
  const row = await env.DB.prepare(`
    SELECT AVG(done_outcome_pct) as avg_pct, COUNT(*) as n
    FROM retail_suggestions
    WHERE suggestion_id = ? AND done_outcome_pct IS NOT NULL
  `).bind(suggestionId).first().catch(() => ({ avg_pct: null, n: 0 }));
  if (!row || !row.avg_pct || row.n < 1) return { multiplier: 1.0, n: 0 };
  return { multiplier: row.avg_pct / 100, n: row.n };
}

// ── Rules ──────────────────────────────────────────────────────────────
// Each rule returns null if not applicable, or a candidate object.

async function ruleEmailCapture(env, s) {
  if (s.identified_pct >= 0.40) return null;
  // Math: target capture 50% × monthly_first_timers / current_capture, then
  // (target_pool − current_pool) × welcome_conv × avg_returner_ltv × 12.
  const currentPool = s.monthly_first_timers;
  if (currentPool === 0 || s.welcome_conv === 0) return null;
  const targetCapture = 0.50;
  const targetPool = currentPool / Math.max(s.identified_pct, 0.01) * targetCapture;
  const incrementalReturners = (targetPool - currentPool) * s.welcome_conv;
  const annualLift = incrementalReturners * s.avg_returner_ltv * 12;
  const tr = await trackRecordMultiplier(env, 'email_capture');
  return {
    suggestion_id: 'email_capture',
    title: 'Turn on email capture at Square POS checkout',
    annual_lift_low: Math.round(annualLift * 0.7 * tr.multiplier),
    annual_lift_high: Math.round(annualLift * 1.3 * tr.multiplier),
    effort: 'low',
    current_value: `${Math.round(s.identified_pct * 100)}% of orders identified`,
    goal_value: `50% (industry std)`,
    math: `Welcome SMS converts ${(s.welcome_conv * 100).toFixed(1)}% × ${(targetCapture / Math.max(s.identified_pct, 0.01)).toFixed(1)}× the input pool`,
    how_to: 'Square Dashboard > Settings > Receipts > Save customer info to receipt = ON',
    track_record: tr,
  };
}

async function ruleLoyaltySignups(env, s) {
  if (s.loyalty_organic_per_day >= 3) return null;
  const incrementalSignups = (5 - s.loyalty_organic_per_day) * 365;
  const liftPer = (s.loyalty_avg_ltv ?? s.non_loyalty_avg_ltv * 1.7) - s.non_loyalty_avg_ltv;
  if (liftPer <= 0) return null;
  const annualLift = incrementalSignups * liftPer;
  const tr = await trackRecordMultiplier(env, 'loyalty_signups');
  return {
    suggestion_id: 'loyalty_signups',
    title: '5 more loyalty signups per day',
    annual_lift_low: Math.round(annualLift * 0.7 * tr.multiplier),
    annual_lift_high: Math.round(annualLift * 1.3 * tr.multiplier),
    effort: 'medium',
    current_value: `${s.loyalty_organic_per_day.toFixed(1)}/day organic`,
    goal_value: '5/day',
    math: `Loyalty members visit 3-5× more · LTV $${Math.round(s.loyalty_avg_ltv ?? s.non_loyalty_avg_ltv * 1.7)} vs $${Math.round(s.non_loyalty_avg_ltv)}`,
    how_to: 'Counter script for staff + receipt nudge + $5 first-visit incentive',
    track_record: tr,
  };
}

async function ruleEmailTracking(env, s) {
  if (s.email_sent_7d < 10) return null;
  if (s.email_open_rate === null || s.email_open_rate >= 0.05) return null;
  return {
    suggestion_id: 'fix_email_tracking',
    title: 'Email open rate is 0% — tracking is likely broken',
    annual_lift_low: null,
    annual_lift_high: null,
    effort: 'urgent',
    current_value: `${s.email_sent_7d} sent · ${s.email_opened_7d} opened (${(s.email_open_rate * 100).toFixed(1)}%)`,
    goal_value: '15%+ open rate (healthy)',
    math: `Either tracking pixel isn't firing or emails are landing in spam`,
    how_to: 'Send test to drew@dangerouspretzel.com, inspect pixel + verify SPF/DKIM',
    track_record: { multiplier: 1.0, n: 0 },
  };
}

async function ruleBurningAudience(env, s) {
  if (s.burning_campaigns.length === 0) return null;
  // Sum waste across all burning campaigns. Each send burns ~$0.01 SMS cost +
  // audience-fatigue cost (priced as $1/send because the address goes cold).
  const c = s.burning_campaigns[0]; // pick top burner
  const wasteAnnual = c.sends_30d * 12 * 1.0;
  const tr = await trackRecordMultiplier(env, 'burning_audience');
  return {
    suggestion_id: `burning_audience:${c.id}`,
    title: `${c.name} — burning audience for low return`,
    annual_lift_low: Math.round(wasteAnnual * 0.5 * tr.multiplier),
    annual_lift_high: Math.round(wasteAnnual * tr.multiplier),
    effort: 'low',
    current_value: `${c.sends_30d} sends/30d · ${c.returns_30d} returns`,
    goal_value: 'Pause or reduce to 10/day',
    math: `Send pace burning ~${Math.round(c.sends_30d / 30)}/day for ${c.returns_30d} return(s) — list fatigue cost compounds`,
    how_to: 'Open Campaign Performance card → Pause or Reduce to 10/day',
    track_record: tr,
  };
}

async function ruleAtRiskVips(env, s) {
  if (s.at_risk_vips === 0) return null;
  const liftPer = 200; // protected LTV per saved VIP
  const annualLift = s.at_risk_vips * liftPer * 0.3; // 30% conversion on personal outreach
  const tr = await trackRecordMultiplier(env, 'at_risk_vips');
  return {
    suggestion_id: 'at_risk_vips',
    title: `${s.at_risk_vips} VIP customer${s.at_risk_vips > 1 ? 's' : ''} haven't visited in 21+ days`,
    annual_lift_low: Math.round(annualLift * 0.7 * tr.multiplier),
    annual_lift_high: Math.round(annualLift * 1.3 * tr.multiplier),
    effort: 'medium',
    current_value: `${s.at_risk_vips} at-risk VIPs (10+ visits)`,
    goal_value: 'Personal outreach + $5 win-back',
    math: `Each saved VIP protects ~$${liftPer} LTV · 30% conversion on direct contact`,
    how_to: 'Watchlists → Top customers → reach out to each, $5 off code',
    track_record: tr,
  };
}

async function ruleCohortDecline(env, s) {
  if (s.cohort_recent_4wk_pct === null || s.cohort_prior_4wk_pct === null) return null;
  if (s.cohort_recent_4wk_pct >= s.cohort_prior_4wk_pct) return null;
  const drop = s.cohort_prior_4wk_pct - s.cohort_recent_4wk_pct;
  if (drop < 0.02) return null; // ignore small noise
  return {
    suggestion_id: 'cohort_decline',
    title: 'New customer retention is dropping',
    annual_lift_low: null,
    annual_lift_high: null,
    effort: 'high',
    current_value: `${(s.cohort_recent_4wk_pct * 100).toFixed(1)}% recent vs ${(s.cohort_prior_4wk_pct * 100).toFixed(1)}% prior`,
    goal_value: 'Investigate root cause',
    math: `Last 4-week cohort returning ${(drop * 100).toFixed(1)}pp less than prior 4-week`,
    how_to: 'Check Welcome campaign send health + recent product/price changes',
    track_record: { multiplier: 1.0, n: 0 },
  };
}

// ── Main entry ─────────────────────────────────────────────────────────
export async function regenerateSuggestions(env) {
  const t0 = Date.now();
  const signals = await loadSignals(env);

  // Run all rules. Each returns null or a candidate.
  const rawCandidates = await Promise.all([
    ruleEmailCapture(env, signals),
    ruleLoyaltySignups(env, signals),
    ruleEmailTracking(env, signals),
    ruleBurningAudience(env, signals),
    ruleAtRiskVips(env, signals),
    ruleCohortDecline(env, signals),
  ]);
  const candidates = rawCandidates.filter(Boolean);

  // Rank: urgent items first, then by projected high lift descending.
  const rankOrder = c => c.effort === 'urgent' ? -1e12 : -(c.annual_lift_high || 0);
  candidates.sort((a, b) => rankOrder(a) - rankOrder(b));

  // Mark older 'open' rows as superseded so they don't double-show.
  await env.DB.prepare(`
    UPDATE retail_suggestions SET state='superseded'
    WHERE state='open' AND generated_at < datetime('now','-90 minutes')
  `).run().catch(() => {});

  // Persist top 6.
  const persisted = [];
  for (let i = 0; i < Math.min(candidates.length, 6); i++) {
    const c = candidates[i];
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO retail_suggestions (
        id, generated_at, suggestion_id, rank, title, math, how_to,
        annual_lift_low, annual_lift_high, effort, state,
        current_value, goal_value, metric_signal
      ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).bind(
      id, c.suggestion_id, i + 1, c.title, c.math, c.how_to,
      c.annual_lift_low, c.annual_lift_high, c.effort,
      c.current_value, c.goal_value, JSON.stringify({ track_record: c.track_record, signals_snapshot: { identified_pct: signals.identified_pct, monthly_first_timers: signals.monthly_first_timers, welcome_conv: signals.welcome_conv, loyalty_per_day: signals.loyalty_organic_per_day, email_open_rate: signals.email_open_rate } }),
    ).run();
    persisted.push({ ...c, db_id: id, rank: i + 1 });
  }

  return {
    generated_count: persisted.length,
    candidates_evaluated: rawCandidates.length,
    duration_ms: Date.now() - t0,
    top_3: persisted.slice(0, 3).map(p => ({ suggestion_id: p.suggestion_id, title: p.title, lift_high: p.annual_lift_high })),
  };
}

// ── Outcome measurement (called by 30d follow-up) ──────────────────────
// Compares projected lift to actual. Stores in done_outcome_pct.
// For now we approximate "actual lift" as the relevant metric improvement.
// Refines over time as we calibrate per suggestion type.
export async function measureSuggestionOutcomes(env) {
  const due = await env.DB.prepare(`
    SELECT * FROM retail_suggestions
    WHERE state='done' AND followup_due_at <= datetime('now')
      AND done_outcome_pct IS NULL
  `).all().catch(() => ({ results: [] }));

  for (const row of (due.results || [])) {
    let outcomePct = null;
    try {
      // Per-suggestion measurement strategy
      if (row.suggestion_id === 'email_capture') {
        // Did identified_pct improve since done?
        const before = JSON.parse(row.metric_signal || '{}')?.signals_snapshot?.identified_pct || 0;
        const cur = await env.DB.prepare(`
          SELECT 1.0 * COUNT(*) FILTER (WHERE customer_id IS NOT NULL) / COUNT(*) as pct
          FROM orders WHERE source IN ('square','square_delivery')
            AND order_date >= datetime('now','-30 days')
        `).first();
        const after = cur?.pct || 0;
        // Outcome% = improvement realized / improvement projected
        const projected_delta = 0.50 - before;
        const actual_delta = Math.max(0, after - before);
        outcomePct = projected_delta > 0 ? Math.min(200, (actual_delta / projected_delta) * 100) : null;
      } else if (row.suggestion_id === 'loyalty_signups') {
        const before = JSON.parse(row.metric_signal || '{}')?.signals_snapshot?.loyalty_per_day || 0;
        const cur = await env.DB.prepare(`
          SELECT COUNT(*) / 7.0 as per_day FROM loyalty_accounts
          WHERE enrolled_at >= datetime('now','-7 days')
        `).first();
        const after = cur?.per_day || 0;
        const projected_delta = 5 - before;
        const actual_delta = Math.max(0, after - before);
        outcomePct = projected_delta > 0 ? Math.min(200, (actual_delta / projected_delta) * 100) : null;
      } else if (row.suggestion_id === 'fix_email_tracking') {
        const cur = await env.DB.prepare(`
          SELECT 1.0 * COUNT(*) FILTER (WHERE opened_at IS NOT NULL) / COUNT(*) as rate
          FROM email_sends WHERE sent_at >= datetime('now','-7 days') AND status IN ('sent','delivered')
        `).first();
        outcomePct = cur?.rate >= 0.05 ? 100 : (cur?.rate || 0) * 1000; // 5% target = 100% outcome
      }
    } catch (_) { outcomePct = null; }

    if (outcomePct !== null) {
      await env.DB.prepare(
        `UPDATE retail_suggestions SET done_outcome_pct = ? WHERE id = ?`
      ).bind(Math.round(outcomePct), row.id).run().catch(() => {});
    }
  }
  return { measured: due.results?.length || 0 };
}

// ── Default export — cron + fetch dispatcher ───────────────────────────
export default {
  async scheduled(event, env, ctx) {
    // Cron `15 * * * *` — regenerate suggestions every hour.
    // Cron also covers outcome measurement at the same tick (cheap, idempotent).
    const result = await regenerateSuggestions(env);
    await measureSuggestionOutcomes(env).catch(() => {});
    return result;
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/retail/suggestions/regenerate' && request.method === 'POST') {
      const result = await regenerateSuggestions(env);
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  },
};
