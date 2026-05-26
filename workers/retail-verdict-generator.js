// retail-verdict-generator.js
// Daily cron `0 5 * * *` (11pm MT). Reads live signals from D1, calls Claude Sonnet
// to produce a one-paragraph verdict on retail health, caches in verdict_cache.
//
// The verdict answers Drew's #1 question on the Retail tab in 30 seconds:
// are we trending in the right direction, with specific numbers.
//
// See plan: /Users/drew/.claude/plans/iterative-frolicking-hollerith.md

// DIF-3: model id now resolved via ai-budget.js (callAI(env, { model: 'sonnet' })).

// ── Signal collection ─────────────────────────────────────────────────
async function collectVerdictSignals(env) {
  const [
    rev7d, rev28d, revPrior28d,
    cohortRecent, cohortPrior, cohortApril, cohortMarch,
    emailFunnel, customers,
    campaignsActive, openSuggestions, deliverabilityState,
  ] = await Promise.all([
    // Revenue last 7d (retail only)
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 0) as total, COUNT(*) as orders
      FROM orders WHERE source IN ('square','square_delivery')
        AND gross_revenue < 100 AND units < 30
        AND order_date >= datetime('now','-7 days')
    `).first().catch(() => null),

    // Revenue rolling 28d
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 0) as total
      FROM orders WHERE source IN ('square','square_delivery')
        AND gross_revenue < 100 AND units < 30
        AND order_date >= datetime('now','-28 days')
    `).first().catch(() => null),

    // Revenue prior 28d (28-56 days ago)
    env.DB.prepare(`
      SELECT ROUND(SUM(gross_revenue), 0) as total
      FROM orders WHERE source IN ('square','square_delivery')
        AND gross_revenue < 100 AND units < 30
        AND order_date >= datetime('now','-56 days') AND order_date < datetime('now','-28 days')
    `).first().catch(() => null),

    // Cohort recent 4-week
    env.DB.prepare(`
      SELECT COUNT(*) as first_timers,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners
      FROM retail_customers WHERE first_visit_date >= datetime('now','-28 days')
    `).first().catch(() => null),

    // Cohort prior 4-week
    env.DB.prepare(`
      SELECT COUNT(*) as first_timers,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners
      FROM retail_customers
      WHERE first_visit_date >= datetime('now','-56 days')
        AND first_visit_date < datetime('now','-28 days')
    `).first().catch(() => null),

    // Cohort April 2026
    env.DB.prepare(`
      SELECT COUNT(*) as first_timers,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners
      FROM retail_customers
      WHERE first_visit_date >= '2026-04-01' AND first_visit_date < '2026-05-01'
    `).first().catch(() => null),

    // Cohort March 2026
    env.DB.prepare(`
      SELECT COUNT(*) as first_timers,
        SUM(CASE WHEN visit_count >= 2 THEN 1 ELSE 0 END) as returners
      FROM retail_customers
      WHERE first_visit_date >= '2026-03-01' AND first_visit_date < '2026-04-01'
    `).first().catch(() => null),

    // Email funnel last 7d
    env.DB.prepare(`
      SELECT COUNT(*) as sent, COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as opened,
        COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) as bounced
      FROM email_sends
      WHERE sent_at >= datetime('now','-7 days')
        AND status IN ('sent','delivered','bounced','complained','unsubscribed')
    `).first().catch(() => null),

    // Customer base
    env.DB.prepare(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE last_visit_date >= datetime('now','-30 days')) as active_30d,
        COUNT(*) FILTER (WHERE visit_count = 1) as one_and_done
      FROM retail_customers
    `).first().catch(() => null),

    // Active campaigns
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM retail_campaigns WHERE status = 'active'`).first().catch(() => ({ cnt: 0 })),

    // Top open suggestions (the formula engine's recent output)
    env.DB.prepare(`
      SELECT suggestion_id, title, annual_lift_high, effort
      FROM retail_suggestions WHERE state = 'open'
      ORDER BY rank ASC LIMIT 3
    `).all().catch(() => ({ results: [] })),

    // Recent deliverability state
    env.DB.prepare(`
      SELECT
        COUNT(*) as sent_7d,
        ROUND(100.0 * COUNT(*) FILTER (WHERE opened_at IS NOT NULL) / COUNT(*), 1) as open_rate_pct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE bounced_at IS NOT NULL) / COUNT(*), 1) as bounce_rate_pct
      FROM email_sends WHERE sent_at >= datetime('now','-7 days')
    `).first().catch(() => null),
  ]);

  // Compute revenue trend slope (28d vs prior 28d)
  const rev28 = rev28d?.total || 0;
  const revPrior = revPrior28d?.total || 0;
  const trendPct = revPrior > 0 ? Math.round(((rev28 - revPrior) / revPrior) * 100) : null;

  // Cohort retention pcts
  const cohortRecentPct = cohortRecent?.first_timers > 0
    ? Math.round((cohortRecent.returners / cohortRecent.first_timers) * 1000) / 10
    : null;
  const cohortPriorPct = cohortPrior?.first_timers > 0
    ? Math.round((cohortPrior.returners / cohortPrior.first_timers) * 1000) / 10
    : null;
  const aprilPct = cohortApril?.first_timers > 0
    ? Math.round((cohortApril.returners / cohortApril.first_timers) * 1000) / 10
    : null;
  const marchPct = cohortMarch?.first_timers > 0
    ? Math.round((cohortMarch.returners / cohortMarch.first_timers) * 1000) / 10
    : null;

  return {
    revenue: {
      last_7d: rev7d?.total || 0,
      orders_7d: rev7d?.orders || 0,
      last_28d: rev28,
      prior_28d: revPrior,
      trend_pct_28d_vs_prior: trendPct,
    },
    cohorts: {
      recent_4wk: { first_timers: cohortRecent?.first_timers || 0, returners: cohortRecent?.returners || 0, retention_pct: cohortRecentPct },
      prior_4wk: { first_timers: cohortPrior?.first_timers || 0, returners: cohortPrior?.returners || 0, retention_pct: cohortPriorPct },
      april_2026: { first_timers: cohortApril?.first_timers || 0, retention_pct: aprilPct },
      march_2026: { first_timers: cohortMarch?.first_timers || 0, retention_pct: marchPct },
    },
    email_deliverability: {
      sent_7d: deliverabilityState?.sent_7d || 0,
      open_rate_pct: deliverabilityState?.open_rate_pct ?? null,
      bounce_rate_pct: deliverabilityState?.bounce_rate_pct ?? null,
      tracking_likely_broken: emailFunnel?.sent >= 10 && emailFunnel?.opened === 0,
    },
    customer_base: {
      total: customers?.total || 0,
      active_30d: customers?.active_30d || 0,
      one_visit_only: customers?.one_and_done || 0,
      one_visit_pct: customers?.total > 0 ? Math.round((customers.one_and_done / customers.total) * 100) : 0,
    },
    campaigns_active: campaignsActive?.cnt || 0,
    top_open_suggestions: (openSuggestions?.results || []).map(s => ({
      id: s.suggestion_id, title: s.title, lift_high: s.annual_lift_high, effort: s.effort,
    })),
  };
}

// ── Business context — passed to Sonnet on every call so the verdict is
// grounded in DPC's specific situation, not generic small-business advice.
// Updates to this block immediately change tomorrow's verdict.
const BUSINESS_CONTEXT = `
ABOUT DANGEROUS PRETZEL CO (DPC)
- Single retail location in Salt Lake City, UT (352 W 600 S)
- Switched from Toast POS to Square POS on Apr 14, 2026 (~3 weeks of clean data)
- Founder: Drew. Single operator running the whole show.
- Product: pretzels + dips. Avg ticket ~$18 retail. Catering ($100+) and wholesale (QBO invoices) are separate channels with different dynamics.
- ~7,250 retail customers in DB; ~1,720 are Square-Loyalty enrolled (mostly Toast import zombies)

SUCCESS LOOKS LIKE
- More first-time visitors becoming loyal (current 1-and-done rate is 61% — too high)
- Email/SMS win-back campaigns paying for themselves (Welcome currently runs at 17.5%, top-quartile)
- Predictable daily revenue ($500-1k/day baseline, grow steadily)

CURRENT BIGGEST LEVERS (per repeated analysis)
1. Email capture at Square POS checkout — currently 16% of orders identified, 50% is industry standard
2. Loyalty signups — 0.6/day organic, target 5/day
3. Stop burning cold lists with low-converting campaigns

WHAT TO AVOID IN THE VERDICT
- Generic platitudes ("focus on customer experience")
- Hedging ("seems like, possibly, maybe")
- Restating raw numbers without judgment ("revenue was $5,023")
- Mentioning levers Drew already actioned (track open suggestions list — if "email_capture" already done, skip it)

WHAT TO INCLUDE
- One specific positive signal with a number
- One specific concern or watchpoint with a number
- The single most-impactful action Drew should take this week
- A confidence calibration: low if <3 weeks data, medium normally, high only if 30+ days post-Square trend is decisive
`;

// ── Sonnet call ───────────────────────────────────────────────────────
async function generateVerdictWithSonnet(env, signals) {
  const prompt = `You are the retail intelligence layer of Pretzel OS. Read the signals below and produce ONE paragraph that tells the operator (Drew) whether the business is trending in the right direction. Use the actual numbers from the data — no platitudes, no generalities, no hedging.

${BUSINESS_CONTEXT}

Output STRICT JSON only (no markdown fences, no prose outside the JSON):
{
  "state": "green" | "yellow" | "orange" | "red",
  "headline": "3-5 word phrase summarizing direction",
  "body": "2-3 sentence paragraph with specific numbers from the data",
  "confidence": "high" | "medium" | "low",
  "basis": "1 phrase about the data window e.g. 'Based on last 28 days post-Square'"
}

State logic:
- green: cohort retention improving + revenue stable/up + no urgent alerts
- yellow: mixed signals — one improving, one declining, no urgent alerts
- orange: declining trend OR a fixable urgent alert (e.g. 0% email open rate, broken tracking)
- red: material decline (>20% revenue drop) OR multiple urgent alerts
- confidence is "low" when fewer than 3 weeks of post-Square data is available

Body should:
- Lead with the strongest signal (positive or negative)
- Cite at least 2 specific numbers
- Mention the top open action if any exists, with its dollar projection
- Be specific to Dangerous Pretzel (Salt Lake City pretzel shop, Square POS since Apr 14 2026)

Signals:
${JSON.stringify(signals, null, 2)}`;

  // DIF-3 (May 13 2026): wired through ai-budget
  const { callAI } = await import('./ai-budget.js');
  const result = await callAI(env, {
    use_case: 'retail_verdict_narrative',
    model: 'sonnet',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
    caller: 'retail-verdict-generator.js',
  });
  if (!result.ok) {
    throw new Error(result.blocked_reason || result.error || 'Anthropic call failed');
  }
  const text = result.content || '';
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(stripped);
}

// ── Generate + cache ───────────────────────────────────────────────────
export async function generateVerdict(env, period = 'last_7_days', { force = false } = {}) {
  // Check cache first unless forced.
  if (!force) {
    const cached = await env.DB.prepare(
      `SELECT * FROM verdict_cache WHERE period = ? AND expires_at > datetime('now')`
    ).bind(period).first().catch(() => null);
    if (cached) return { ...cached, cache_hit: true };
  }

  const signals = await collectVerdictSignals(env);
  let verdict;
  try {
    verdict = await generateVerdictWithSonnet(env, signals);
  } catch (err) {
    // Fallback: deterministic verdict from signals if Sonnet fails.
    verdict = fallbackVerdict(signals, err.message);
  }

  // Validate shape
  if (!verdict || !verdict.state || !verdict.headline || !verdict.body) {
    verdict = fallbackVerdict(signals, 'Sonnet returned malformed response');
  }

  // Store in cache (24h TTL).
  await env.DB.prepare(`
    INSERT INTO verdict_cache (period, state, headline, body, confidence, basis, generated_at, expires_at, signals_used)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now','+24 hours'), ?)
    ON CONFLICT(period) DO UPDATE SET
      state = excluded.state,
      headline = excluded.headline,
      body = excluded.body,
      confidence = excluded.confidence,
      basis = excluded.basis,
      generated_at = excluded.generated_at,
      expires_at = excluded.expires_at,
      signals_used = excluded.signals_used
  `).bind(
    period,
    verdict.state, verdict.headline, verdict.body,
    verdict.confidence || 'medium', verdict.basis || '',
    JSON.stringify(signals),
  ).run();

  return { ...verdict, cache_hit: false, generated_at: new Date().toISOString() };
}

// Deterministic fallback if Sonnet fails — keeps the page from breaking.
function fallbackVerdict(s, errMsg) {
  const trend = s.revenue.trend_pct_28d_vs_prior;
  const recentCohort = s.cohorts.recent_4wk.retention_pct;
  const priorCohort = s.cohorts.prior_4wk.retention_pct;
  const trackingBroken = s.email_deliverability.tracking_likely_broken;

  let state = 'yellow';
  if (trackingBroken) state = 'orange';
  if (trend !== null && trend < -20) state = 'red';
  if (trend !== null && trend > 5 && recentCohort > priorCohort) state = 'green';

  return {
    state,
    headline: state === 'green' ? 'Trending up' : state === 'orange' ? 'Watching closely' : state === 'red' ? 'Action needed' : 'Mixed signals',
    body: `Revenue last 28d: $${s.revenue.last_28d.toLocaleString()} (${trend !== null ? (trend > 0 ? '+' : '') + trend + '%' : 'no prior comparison'} vs prior). Recent 4-week cohort returning at ${recentCohort ?? '—'}% vs ${priorCohort ?? '—'}% prior period. ${trackingBroken ? 'Email tracking appears broken (0% open rate on ' + s.email_deliverability.sent_7d + ' sends).' : ''}`.trim(),
    confidence: 'low',
    basis: `Auto-generated fallback (Sonnet failed: ${errMsg.slice(0, 80)})`,
  };
}

// ── Default export — cron + fetch dispatcher ───────────────────────────
export default {
  async scheduled(event, env, ctx) {
    // Daily 11pm MT regen of the default 'last_7_days' verdict.
    return generateVerdict(env, 'last_7_days');
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/retail/verdict/regenerate' && request.method === 'POST') {
      const period = url.searchParams.get('period') || 'last_7_days';
      const result = await generateVerdict(env, period, { force: true });
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  },
};
