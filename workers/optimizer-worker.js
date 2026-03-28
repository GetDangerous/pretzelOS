/**
 * Dangerous Pretzel Co — Optimizer Worker
 * Cloudflare Worker (cron: Sunday 11pm MT — before Monday morning Scout)
 *
 * 1. Reads last 4 weeks of performance_metrics from D1
 * 2. Identifies which agent prompts are underperforming
 * 3. Sends current prompts + performance data to Claude
 * 4. Claude rewrites underperforming prompts
 * 5. Writes new versions back to agent_prompts (increments version)
 * 6. All workers pick up new prompts on next run — zero code changes needed
 *
 * This is the self-improvement loop. Every week the system gets smarter.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   DB
 */

import { getDirectiveFromKV } from './cfo-agent.js';

// Thresholds — if below these, the optimizer rewrites the prompt
const BENCHMARKS = {
  outreach_email:      { metric: 'open_rate',    threshold: 0.35 },
  outreach_followup1:  { metric: 'reply_rate',   threshold: 0.08 },
  outreach_followup2:  { metric: 'reply_rate',   threshold: 0.05 },
  qualifier:           { metric: 'tier1_rate',   threshold: 0.25 }, // 25% of venues should hit tier 1
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOptimizer(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/optimizer/run') {
      const result = await runOptimizer(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.pathname === '/optimizer/history') {
      return getOptimizationHistory(env);
    }
    return new Response('Optimizer Worker', { status: 200 });
  }
};

async function runOptimizer(env) {
  // ── CFO DIRECTIVE ──────────────────────────────────────────────────────────
  const directive = await getDirectiveFromKV(env.KV);
  const optimizerDirective = directive?.optimizer_directive || null;

  if (optimizerDirective) {
    console.log(`[Optimizer] CFO optimizer_directive: ${optimizerDirective}`);
  }
  console.log(`[Optimizer] CFO directive loaded: ${directive ? 'active' : 'none'}`);

  console.log('[Optimizer] Starting weekly optimization...');

  // ── 1. Collect performance data ──────────────────────────────────────────
  const [recentMetrics, outreachStats, qualifierStats, subjectStats, closedDealData] = await Promise.all([
    // Last 4 weeks of weekly metrics
    env.DB.prepare(`
      SELECT * FROM performance_metrics
      ORDER BY week_start DESC LIMIT 4
    `).all(),

    // Email performance by sequence step, last 30 days
    env.DB.prepare(`
      SELECT
        sequence_step,
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) as replied,
        SUM(CASE WHEN outcome = 'meeting_booked' THEN 1 ELSE 0 END) as meetings,
        SUM(CASE WHEN outcome = 'closed' THEN 1 ELSE 0 END) as closed
      FROM outreach_logs
      WHERE direction = 'out'
        AND sent_at >= date('now', '-30 days')
        AND sent_at IS NOT NULL
      GROUP BY sequence_step
    `).all(),

    // Qualifier tier distribution, last 30 days
    env.DB.prepare(`
      SELECT tier, COUNT(*) as count
      FROM venues
      WHERE created_at >= date('now', '-30 days')
        AND tier IS NOT NULL
      GROUP BY tier
    `).all(),

    // Subject line performance (top and bottom)
    env.DB.prepare(`
      SELECT
        subject,
        COUNT(*) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        ROUND(CAST(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 3) as open_rate
      FROM outreach_logs
      WHERE sequence_step = 1
        AND direction = 'out'
        AND sent_at >= date('now', '-30 days')
      GROUP BY subject
      HAVING COUNT(*) >= 3
      ORDER BY open_rate DESC
      LIMIT 10
    `).all(),

    // Closed deal signals — warmer placements = highest weight signal
    env.DB.prepare(`
      SELECT prompt_version, venue_category, COUNT(*) as deals_closed,
             AVG(days_to_close) as avg_days, AVG(self_score) as avg_score
      FROM closed_deal_signals
      WHERE created_at >= date('now', '-30 days')
      GROUP BY prompt_version, venue_category
      ORDER BY deals_closed DESC
    `).all().catch(() => ({ results: [] })),
  ]);

  // ── 2. Calculate what's underperforming ──────────────────────────────────
  // Need at least some outreach data to optimize
  const hasOutreachData = (outreachStats.results || []).length > 0;
  const hasQualifierData = (qualifierStats.results || []).length > 0;

  if (!hasOutreachData && !hasQualifierData) {
    console.log('[Optimizer] Insufficient data — no outreach or qualifier metrics yet. Skipping.');
    await logOptimizerRun(env, [], 'Skipped — insufficient data for optimization');
    return { rewrites: 0, message: 'Insufficient data — system needs outreach runs first' };
  }

  const emailSteps = outreachStats.results || [];
  const step1 = emailSteps.find(s => s.sequence_step === 1) || {};
  const step2 = emailSteps.find(s => s.sequence_step === 2) || {};
  const step3 = emailSteps.find(s => s.sequence_step === 3) || {};

  const openRate1   = step1.sent > 0 ? step1.opened / step1.sent : null;
  const replyRate2  = step2.sent > 0 ? step2.replied / step2.sent : null;
  const replyRate3  = step3.sent > 0 ? step3.replied / step3.sent : null;

  const tierCounts = (qualifierStats.results || []).reduce((acc, r) => {
    acc[r.tier] = r.count; return acc;
  }, {});
  const totalQualified = Object.values(tierCounts).reduce((a, b) => a + b, 0);
  const tier1Rate = totalQualified > 0 ? (tierCounts[1] || 0) / totalQualified : null;

  const underperforming = [];

  if (openRate1 !== null && openRate1 < BENCHMARKS.outreach_email.threshold) {
    underperforming.push({ agent: 'outreach_email', metric: 'open_rate', actual: openRate1, target: BENCHMARKS.outreach_email.threshold });
  }
  if (replyRate2 !== null && replyRate2 < BENCHMARKS.outreach_followup1.threshold) {
    underperforming.push({ agent: 'outreach_followup1', metric: 'reply_rate', actual: replyRate2, target: BENCHMARKS.outreach_followup1.threshold });
  }
  if (replyRate3 !== null && replyRate3 < BENCHMARKS.outreach_followup2.threshold) {
    underperforming.push({ agent: 'outreach_followup2', metric: 'reply_rate', actual: replyRate3, target: BENCHMARKS.outreach_followup2.threshold });
  }
  if (tier1Rate !== null && tier1Rate < BENCHMARKS.qualifier.threshold) {
    underperforming.push({ agent: 'qualifier', metric: 'tier1_rate', actual: tier1Rate, target: BENCHMARKS.qualifier.threshold });
  }

  if (underperforming.length === 0) {
    console.log('[Optimizer] All prompts meeting benchmarks — no rewrites needed');
    await logOptimizerRun(env, [], 'All prompts meeting benchmarks');
    return { rewrites: 0, message: 'All benchmarks met' };
  }

  console.log(`[Optimizer] ${underperforming.length} underperforming agents: ${underperforming.map(u => u.agent).join(', ')}`);

  // ── 3. Rewrite underperforming prompts ───────────────────────────────────
  let rewrites = 0;
  const notes = [];

  for (const issue of underperforming) {
    const currentPrompt = await env.DB.prepare(`
      SELECT id, prompt_text, system_context, version, uses, successes, success_rate
      FROM agent_prompts
      WHERE agent_name = ? AND active = 1
    `).bind(issue.agent).first();

    if (!currentPrompt) continue;

    const rewritePrompt = buildRewritePrompt(issue, currentPrompt, {
      openRate1, replyRate2, replyRate3, tier1Rate,
      subjects: outreachStats.results,
      metrics: recentMetrics.results,
      optimizerDirective,
      closedDeals: closedDealData?.results || [],
    });

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          messages: [{ role: 'user', content: rewritePrompt }],
        }),
      });

      if (!response.ok) continue;
      const data = await response.json();
      const text = data.content?.[0]?.text || '';

      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      const result = JSON.parse(clean);

      if (!result.new_prompt_text) continue;

      // Deactivate current version
      await env.DB.prepare(`
        UPDATE agent_prompts SET active = 0 WHERE agent_name = ? AND active = 1
      `).bind(issue.agent).run();

      // Insert new version
      await env.DB.prepare(`
        INSERT INTO agent_prompts (
          id, agent_name, version, prompt_text, system_context,
          active, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'))
      `).bind(
        crypto.randomUUID(),
        issue.agent,
        (currentPrompt.version || 1) + 1,
        result.new_prompt_text,
        result.new_system_context || currentPrompt.system_context,
        result.rationale || `Rewritten by optimizer. ${issue.metric}: ${(issue.actual * 100).toFixed(1)}% → target ${(issue.target * 100).toFixed(1)}%`
      ).run();

      rewrites++;
      notes.push(`${issue.agent}: v${currentPrompt.version} → v${currentPrompt.version + 1}. ${result.rationale || ''}`);
      console.log(`[Optimizer] Rewrote ${issue.agent} (v${currentPrompt.version} → v${currentPrompt.version + 1})`);

      await sleep(1000);

    } catch (err) {
      console.error(`[Optimizer] Rewrite failed for ${issue.agent}:`, err.message);
    }
  }

  // ── 4. Log the run ───────────────────────────────────────────────────────
  await logOptimizerRun(env, underperforming, notes.join(' | '));

  console.log(`[Optimizer] Done. Rewrites: ${rewrites}`);
  return { rewrites, underperforming: underperforming.length };
}

function buildRewritePrompt(issue, currentPrompt, stats) {
  return `You are the Optimizer agent for Dangerous Pretzel Co's outreach system.

The "${issue.agent}" prompt is underperforming:
- Current ${issue.metric}: ${(issue.actual * 100).toFixed(1)}%
- Target: ${(issue.target * 100).toFixed(1)}%

Current prompt:
---
${currentPrompt.prompt_text}
---

Current system context:
---
${currentPrompt.system_context}
---

Performance context:
- Email step 1 open rate: ${stats.openRate1 !== null ? (stats.openRate1 * 100).toFixed(1) + '%' : 'insufficient data'}
- Email step 2 reply rate: ${stats.replyRate2 !== null ? (stats.replyRate2 * 100).toFixed(1) + '%' : 'insufficient data'}
- Email step 3 reply rate: ${stats.replyRate3 !== null ? (stats.replyRate3 * 100).toFixed(1) + '%' : 'insufficient data'}
- Qualifier tier 1 rate: ${stats.tier1Rate !== null ? (stats.tier1Rate * 100).toFixed(1) + '%' : 'insufficient data'}

About Dangerous Pretzel Co:
- Premium SLC soft pretzel brand, "RUIN DINNER" / "invented by monks, perfected for punks"
- Accounts: Delta Center (NBA Jazz), SLC Bees, Powder Mountain, Alta ski, multiple breweries/theaters
- Free loaner warmer program — zero kitchen, zero training, zero waste needed
- Revenue per account: $1,000–$10,000+/month
- Unique flavors: Spicy Bee (chili-cheddar, hot honey, candied jalapeños), BBK (parm, garlic, herbs), Saint (cinnamon sugar), For The Kids, Salty Bombs
- Close rate is extremely high — just need to get in front of people

${stats.optimizerDirective ? `CFO FINANCIAL DIRECTIVE FOR OPTIMIZER:\n${stats.optimizerDirective}\n\nIncorporate this financial context into your rewrite decisions.\n\n` : ''}${stats.closedDeals && stats.closedDeals.length > 0 ? `HIGHEST PRIORITY SIGNAL (weight 5x over open rates):
closed_deal_signals shows which prompts actually placed warmers.
Optimize for warmer placements, not email opens.

Recent closed deals by prompt version:
${stats.closedDeals.map(d => `- Version ${d.prompt_version || '?'}, ${d.venue_category || 'mixed'}: ${d.deals_closed} deals, avg ${Math.round(d.avg_days || 0)} days to close, avg self-score ${(d.avg_score || 0).toFixed(1)}`).join('\n')}

` : ''}Rewrite instructions:
- Keep what works — only change what's likely causing underperformance
- For outreach emails: if open rate is low, the subject line instructions need work. If reply rate is low, the CTA or pitch needs work.
- Maintain brand voice — bold, irreverent, specific, never corporate
- Make subject lines more specific and curiosity-driven
- Make CTAs more frictionless (offer to bring samples, drop by, text back)
- For qualifier: if tier1 rate is too low, loosen the criteria or improve ICP description

Return JSON:
{
  "new_prompt_text": "...",
  "new_system_context": "...",  
  "rationale": "One sentence explaining the key change and why"
}`;
}

async function logOptimizerRun(env, underperforming, notes) {
  await env.DB.prepare(`
    UPDATE performance_metrics
    SET optimizer_notes = ?
    WHERE week_start = date('now', 'weekday 1', '-7 days')
  `).bind(notes).run();
}

async function getOptimizationHistory(env) {
  const history = await env.DB.prepare(`
    SELECT agent_name, version, notes, uses, successes, success_rate, created_at
    FROM agent_prompts
    ORDER BY agent_name, version DESC
  `).all();

  return new Response(JSON.stringify(history.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
