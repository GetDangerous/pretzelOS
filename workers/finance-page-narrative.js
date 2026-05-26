// workers/finance-page-narrative.js
// Session 17c (May 14, 2026) — page-top Sonnet narrative + page-mode signal.
//
// Drew's design directive: when he opens the page at 7am with coffee, in 30s
// the page should either CALM him (95% of days) or SHARPLY focus him (5%).
// Two pieces:
//
//   1. PAGE MODE — auto-detect calm vs sharp based on Drew's approved logic:
//        sharp if (critical issues > 0) OR (overdue AR > $1K) OR (3+ items pending)
//        otherwise calm
//      Endpoint: GET /finance/page-mode
//
//   2. SONNET NARRATIVE — single sentence answering "How are we?" with concrete
//      data citations. Cached daily at 7am MT in KV. Drew can hit a regenerate
//      button. Same engine as daily email so both surfaces tell the same story.
//      Endpoints: GET /finance/page-narrative · POST /finance/page-narrative/regenerate
//
// The Sonnet prompt is the most important piece per Session 18 audit (W7).
// It explicitly references Drew's situation, his channels, and instructs
// plain-English output with citations.

import { callAI } from './ai-budget.js';
import { getCanonicalCashOnHand, getCanonicalRecurringBurn, getGLRevenueForPeriod } from './finance-shared.js';
import { getScorecard } from './finance-scorecard.js';
import { getBreakeven } from './finance-breakeven.js';
import { getCanonicalForecast } from './finance-forecast.js';
import { listIssues } from './finance-issue-surfacer.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Page mode detection (calm vs sharp) ──────────────────────────────────
export async function getPageMode(env) {
  // Approved by Drew (May 14): sharp if any of:
  //  - critical issue count > 0
  //  - overdue AR > $1,000
  //  - receipts pending + capex pending > 2
  let critical = 0;
  let overdueAr = 0;
  let pending = 0;
  const triggers = [];

  try {
    const issues = await listIssues(env).catch(() => ({ issues: [] }));
    critical = (issues.issues || []).filter(i => i.severity === 'critical').length;
    if (critical > 0) triggers.push(`${critical} critical issue${critical > 1 ? 's' : ''}`);
  } catch {}

  try {
    const aging = await env.DB.prepare(`
      SELECT ROUND(SUM(CAST(json_extract(raw_payload, '$.balance') AS REAL)), 2) as overdue
      FROM orders
      WHERE source IN ('qbo_wholesale','qbo_invoice')
        AND status NOT IN ('voided','paid','estimate')
        AND CAST(json_extract(raw_payload, '$.balance') AS REAL) > 0
        AND json_extract(raw_payload, '$.due_date') < date('now')
    `).first().catch(() => null);
    overdueAr = aging?.overdue || 0;
    if (overdueAr > 1000) triggers.push(`$${Math.round(overdueAr).toLocaleString()} AR overdue`);
  } catch {}

  try {
    const receipts = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM receipts WHERE status = 'pending'`
    ).first().catch(() => null);
    const capex = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM agent_decisions WHERE decision_type = 'capex_proposal' AND drew_action IS NULL`
    ).first().catch(() => null);
    pending = (receipts?.n || 0) + (capex?.n || 0);
    if (pending > 2) triggers.push(`${pending} decisions pending`);
  } catch {}

  const mode = triggers.length > 0 ? 'sharp' : 'calm';
  return {
    ok: true,
    mode,
    triggers,
    signals: { critical_issues: critical, overdue_ar_dollars: overdueAr, items_pending: pending },
    thresholds: { critical_issues: '> 0', overdue_ar_dollars: '> $1,000', items_pending: '> 2' },
    note: mode === 'sharp'
      ? `Page in SHARP mode — something needs your attention now.`
      : `Page in CALM mode — nothing requires immediate action.`,
    computed_at: new Date().toISOString(),
  };
}

// ── Generate the Sonnet narrative ────────────────────────────────────────
const NARRATIVE_SYSTEM_PROMPT = `You are Drew's CFO. Drew runs Dangerous Pretzel Company — a small food business in Salt Lake City with three channels:
- Retail: Square POS at the store, plus marketplace orders via DoorDash/UberEats
- Wholesale: B2B accounts (Compass Group, TF Brewing, SLC Bees / Anthony Serrato, Twisted Sugar, etc.) — top 5 customers are ~80% of wholesale revenue (concentration risk)
- Catering: high-margin, irregular pipeline

Context Drew won't give you but matters: cash is tight (~$74K cash, ~$50K/mo outflow, ~$51K/mo revenue, basically breakeven). He fired his bookkeeper to save money — this dashboard replaces a human CFO. He opens it at 7am with coffee. You have 30 seconds of his attention before he starts his day.

YOUR JOB IS NARROW: produce a single short narrative (60-90 words) that answers "how are we?" in plain English. Cite specific numbers from the data given. NO corporate-speak. Don't summarize the inputs — interpret them. If things are calm, calm him with concrete facts. If things need attention, point sharply at the ONE thing that matters most.

Always end with one specific thing he can act on today (or "nothing today — keep operating" if truly calm).

Return JSON:
{
  "narrative": "...",
  "overall_tone": "calm" | "attention" | "urgent",
  "single_thing_to_watch": "...",
  "highlights": ["...", "...", "..."]  // up to 3 supporting bullets
}`;

export async function generatePageNarrative(env, opts = {}) {
  // Gather inputs in parallel
  const [forecast, scorecard, breakeven, issues, ordersWk] = await Promise.all([
    getCanonicalForecast(env, 90).catch(() => null),
    getScorecard(env).catch(() => null),
    getBreakeven(env).catch(() => null),
    listIssues(env).catch(() => ({ issues: [] })),
    (async () => {
      const today = new Date();
      const start = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const end = today.toISOString().slice(0, 10);
      return getGLRevenueForPeriod(env, start, end).catch(() => null);
    })(),
  ]);

  // Build a compact input payload for Sonnet
  const input = {
    today: new Date().toISOString().slice(0, 10),
    cash: scorecard?.cash?.current?.total,
    runway_forecast: forecast?.ok ? {
      lowest_projected: forecast.lowest_projected?.balance,
      lowest_date: forecast.lowest_projected?.date,
      projected_90d: forecast.projected_90d,
      trend: forecast.trend,
      goes_negative: forecast.goes_negative,
      confidence: forecast.confidence,
      caveats: forecast.confidence_caveats,
    } : null,
    breakeven: breakeven ? {
      monthly_revenue: breakeven.monthly_revenue,
      gap_low: breakeven.gap_low_estimate,
      gap_high: breakeven.gap_high_estimate,
      confidence: breakeven.confidence,
      cogs_volatility_pp: breakeven.cogs_volatility_pp,
    } : null,
    this_week_revenue: ordersWk?.total,
    issues_top: (issues.issues || []).slice(0, 5).map(i => ({
      severity: i.severity,
      headline: i.headline,
      action: i.suggested_action,
    })),
    ar_overdue: scorecard?.ar_30d?.buckets?.overdue?.total,
    ar_total_open: scorecard?.ar_30d?.total_open,
    review_queue_depth: (scorecard?.pipeline?.review_queue?.low_confidence || 0)
                       + (scorecard?.pipeline?.review_queue?.uncategorized || 0),
  };

  const userPrompt = `Today's data:\n\n${JSON.stringify(input, null, 2)}\n\nProduce the narrative JSON described in the system prompt.`;

  const result = await callAI(env, {
    use_case: 'page_narrative',
    model: 'sonnet',
    caller: 'finance-page-narrative.js',
    max_tokens: 600,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (!result.ok) {
    return { ok: false, error: result.error || result.blocked_reason, fallback_inputs: input };
  }

  let parsed = null;
  try {
    const clean = (result.content || '').replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    parsed = { narrative: result.content, parse_error: e.message };
  }

  const payload = {
    ok: true,
    ...parsed,
    inputs_summary: {
      cash: input.cash,
      runway_lowest: input.runway_forecast?.lowest_projected,
      runway_90d: input.runway_forecast?.projected_90d,
      gap_low: input.breakeven?.gap_low,
      gap_high: input.breakeven?.gap_high,
      issue_count: input.issues_top.length,
    },
    generated_at: new Date().toISOString(),
    cost_usd: result.cost_usd,
    model_used: result.model_used,
  };

  // Cache to KV (1 day TTL)
  try {
    await env.KV.put('page_narrative_v1', JSON.stringify(payload), { expirationTtl: 86400 });
  } catch {}

  return payload;
}

// Read cached narrative; regenerate if missing
export async function getPageNarrative(env) {
  try {
    const cached = await env.KV.get('page_narrative_v1');
    if (cached) {
      const p = JSON.parse(cached);
      return { ...p, cached: true };
    }
  } catch {}
  // No cache — generate fresh
  return await generatePageNarrative(env);
}
