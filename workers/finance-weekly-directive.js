// workers/finance-weekly-directive.js
// Finance v2 — CFO Agent v2, weekly strategic directive (3.3).
// Per PRETZEL_OS_FINANCE_V2.md section 3.3.
//
// Sunday 10pm MT cron (actually Monday 4am UTC). Sonnet-powered. Consumes the
// prior week's operational data (forecast, AR, bills, recon gaps) and produces
// a structured JSON directive that other agents read.
//
// Output shape (JSON stored in cfo_briefs.content where type='weekly_directive'):
//   { week_of, cash_position, ar_status, spending_directives, wholesale_focus,
//     retail_focus, key_risks, weekly_p_and_l_estimate, top_priority_actions }
//
// Endpoint: POST /finance/cfo/weekly-directive[?ai=1]  (ai=0 returns data-only skeleton)

import { getCanonicalCashOnHand } from './finance-shared.js';

// DIF-3: model id now resolved via ai-budget.js.

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function isoDate(d) { return d.toISOString().slice(0, 10); }

// ── Collect the week's operating data ─────────────────────────────────────
async function collectWeekData(env) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const weekOf = isoDate(weekAgo);
  const now = isoDate(today);

  // Cash position — via canonical helper (refresh-on-read, 5-min TTL).
  // Phase 2 reset Apr 30 2026: was direct mercury_accounts read which let
  // 12-day-stale snapshots through. Canonical now refreshes inline.
  const canonicalCash = await getCanonicalCashOnHand(env);
  const cashNow = canonicalCash.total;
  const accounts = { results: canonicalCash.breakdown.map(b => ({ account_name: b.account_name, current_balance: b.balance })) };

  // 30-day forecast summary
  const forecast = await env.DB.prepare(`
    SELECT MIN(projected_balance) as lowest, MAX(projected_balance) as highest,
           MAX(target_date) as end_date,
           (SELECT projected_balance FROM cash_flow_forecast ORDER BY target_date DESC LIMIT 1) as ending_balance
    FROM cash_flow_forecast
    WHERE forecast_date = (SELECT MAX(forecast_date) FROM cash_flow_forecast)
  `).first();

  // AR status
  const ar = await env.DB.prepare(`
    SELECT COUNT(*) as count,
           ROUND(SUM(amount_total - amount_paid), 2) as outstanding,
           ROUND(SUM(CASE WHEN due_date < date('now') THEN amount_total - amount_paid ELSE 0 END), 2) as past_due
    FROM invoices
    WHERE status IN ('sent','past_due','partially_paid')
  `).first();

  // Pending financial flags
  const critFlags = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM financial_flags WHERE status = 'open' AND severity IN ('critical','high')
  `).first();

  // Weekly P&L estimate from last 7 days of JEs
  const weekPL = await env.DB.prepare(`
    SELECT ROUND(SUM(CASE WHEN c.account_type IN ('revenue','other_income') THEN l.credit - l.debit ELSE 0 END), 2) as revenue,
           ROUND(SUM(CASE WHEN c.account_type = 'cogs' THEN l.debit - l.credit ELSE 0 END), 2) as cogs,
           ROUND(SUM(CASE WHEN c.account_type = 'expense' THEN l.debit - l.credit ELSE 0 END), 2) as expense
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted' AND j.entry_date >= ?
  `).bind(weekOf).first() || {};

  // Categorization queue depth
  const reviewQueue = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM mercury_transactions
    WHERE proposed_account_id IS NULL OR (proposed_confidence < 0.90 AND is_reconciled = 0)
  `).first();

  // Capex candidates pending
  const capex = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM mercury_transactions m
    WHERE amount < -2500 AND is_reconciled = 1
      AND NOT EXISTS (SELECT 1 FROM finance_audit_log WHERE entity_id = m.id AND action_type IN ('capex_capitalized','capex_rejected'))
  `).first();

  return {
    week_of: weekOf,
    as_of: now,
    cash_position: {
      current_balance: round2(cashNow),
      projected_30d_ending: forecast?.ending_balance || null,
      lowest_projected: forecast?.lowest || null,
      highest_projected: forecast?.highest || null,
      weeks_runway: weekPL?.expense > 0 ? round2(cashNow / (weekPL.expense / 7 * 7)) : null,
      trend: weekPL?.revenue > weekPL?.expense ? 'improving' : 'tightening',
    },
    ar_status: {
      outstanding_count: ar?.count || 0,
      total_outstanding: ar?.outstanding || 0,
      past_due: ar?.past_due || 0,
    },
    weekly_p_and_l_estimate: {
      revenue: weekPL?.revenue || 0,
      cogs: weekPL?.cogs || 0,
      expense: weekPL?.expense || 0,
      gross_margin: weekPL?.revenue ? round2(((weekPL.revenue - weekPL.cogs) / weekPL.revenue) * 100) : null,
      net: round2((weekPL?.revenue || 0) - (weekPL?.cogs || 0) - (weekPL?.expense || 0)),
    },
    review_queue: {
      uncategorized_or_low_confidence: reviewQueue?.n || 0,
      capex_pending: capex?.n || 0,
    },
    risks: {
      critical_high_flags_open: critFlags?.n || 0,
      cash_goes_negative: forecast?.lowest < 0,
    },
  };
}

// ── Sonnet wrapper ────────────────────────────────────────────────────────
async function generateDirective(env, data) {
  if (!env.ANTHROPIC_API_KEY) return { note: 'ANTHROPIC_API_KEY not set — skeleton only' };

  const prompt = `You are the CFO of Dangerous Pretzel Company LLC (single-location SLC food service, ~$786K/yr revenue). You have 1 week of operating data. Your job: produce a directive that the other agents (Outreach, Catering, Retail, Optimizer) will follow.

DATA (last 7 days + 30-day forecast):
${JSON.stringify(data, null, 2)}

Return STRICT JSON with exactly this shape:
{
  "executive_summary": "<2-3 sentence state of the business this week>",
  "spending_directives": {
    "discretionary_budget_remaining": <dollar number>,
    "approval_threshold": 250,
    "approved_categories": ["<short list>"],
    "blocked_categories": ["<short list if any>"]
  },
  "channel_focus": {
    "wholesale": "<1 sentence directive>",
    "retail": "<1 sentence directive>",
    "catering": "<1 sentence directive>"
  },
  "key_risks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "top_priority_actions": ["<action 1>", "<action 2>", "<action 3>"]
}

No markdown fences, no prose outside the JSON.`;

  // Session 6 (May 13 2026): route through ai-budget.js for cost tracking
  const { callAI } = await import('./ai-budget.js');
  const result = await callAI(env, {
    use_case: 'weekly_directive',
    model: 'sonnet',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
    caller: 'finance-weekly-directive.js:generateDirective',
    allow_haiku_downgrade: true,
  });
  if (!result.ok) return { error: result.error || result.blocked_reason || 'AI call failed' };
  const text = result.content || '';
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    return { error: 'could not parse Sonnet JSON', raw: text };
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────
export async function runWeeklyDirective(env, opts = {}) {
  const started = Date.now();
  const data = await collectWeekData(env);
  const directive = opts.ai === false ? { note: 'skeleton only (ai=0)' } : await generateDirective(env, data);

  const payload = { ...data, directive, duration_ms: Date.now() - started };

  await env.DB.prepare(`
    INSERT INTO cfo_briefs (id, brief_date, type, content)
    VALUES (?, date('now'), 'weekly_directive', ?)
    ON CONFLICT(brief_date, type) DO UPDATE SET content = excluded.content
  `).bind(crypto.randomUUID(), JSON.stringify(payload)).run().catch(() => {});

  // Also write to KV for fast read by other agents
  await env.KV.put('active_financial_directive', JSON.stringify({
    week_of: data.week_of,
    as_of: data.as_of,
    directive: directive.executive_summary ? directive : null,
    cash_alert: (data.cash_position?.weeks_runway != null && data.cash_position.weeks_runway < 8),
    growth_brake: (data.risks?.cash_goes_negative === true),
    generated_at: new Date().toISOString(),
  })).catch(() => {});

  await env.DB.prepare(`
    INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description, after_json)
    VALUES (?, 'cfo_weekly_directive', 'cfo_briefs', ?, 'cfo_agent', ?, ?)
  `).bind(
    crypto.randomUUID(), data.week_of,
    `Weekly directive ${data.week_of}: cash $${data.cash_position?.current_balance}, weekly revenue $${data.weekly_p_and_l_estimate?.revenue}`,
    JSON.stringify({ week_of: data.week_of, has_ai: !!directive.executive_summary })
  ).run().catch(() => {});

  return payload;
}

export async function getWeeklyDirective(env) {
  const row = await env.DB.prepare(
    `SELECT content, brief_date FROM cfo_briefs WHERE type = 'weekly_directive' ORDER BY brief_date DESC LIMIT 1`
  ).first();
  if (!row) return { error: 'no directive yet' };
  try {
    return { brief_date: row.brief_date, payload: JSON.parse(row.content) };
  } catch {
    return { error: 'could not parse stored directive' };
  }
}
