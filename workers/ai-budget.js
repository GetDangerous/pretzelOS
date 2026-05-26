// workers/ai-budget.js
// Single chokepoint for every Anthropic API call. Logs every call, enforces
// daily + monthly budget caps, routes between Haiku and Sonnet, and provides
// a clean callable API for the rest of Pretzel OS.
//
// USAGE:
//   import { callAI } from './ai-budget.js';
//   const result = await callAI(env, {
//     use_case: 'daily_brief',
//     model: 'sonnet',                    // or 'haiku' | explicit model id
//     messages: [{ role: 'user', content: '...' }],
//     system: '...',
//     tools: [...],
//     max_tokens: 1024,
//     caller: 'finance-email-briefs.js',
//   });
//
// Returns: { ok, content, tool_use, stop_reason, cost_usd, tokens, blocked_reason }
//
// If budget is exceeded, returns { ok: false, blocked_reason: 'daily_cap' | 'monthly_cap' }
// and DOES NOT call the API.
//
// EVERY Anthropic call in Pretzel OS goes through this. No exceptions.

// ── Configuration ─────────────────────────────────────────────────────────
// Tweak via env vars in wrangler.toml or KV; defaults here are the design caps.

const DEFAULTS = {
  DAILY_SOFT_CAP_USD:   1.50,    // = ~$45/mo target — degrade features above this
  DAILY_HARD_CAP_USD:   2.50,    // = ~$75/mo absolute ceiling — refuse Sonnet calls above
  MONTHLY_SOFT_CAP_USD: 35.00,
  MONTHLY_HARD_CAP_USD: 50.00,
  MAX_TOKENS_PER_CALL:  4096,    // hard ceiling per individual call
  MAX_TOKENS_PER_CONV:  100000,  // hard ceiling per conversation_id total
  MAX_TOOLS_PER_TURN:   64,      // ceiling on tools[] array length per API call.
                                  // Originally 8 to prevent tool-call loops — but that
                                  // truncated the AVAILABLE tools list (not the call
                                  // count). Real tool-loop control is loops count in
                                  // chat-worker.js. Raised May 14 2026 to support the
                                  // full CFO toolset (38+ tools incl. statements).
};

// Model registry — single source for model ids + prices. Rotate model id here
// (or via KV ACTIVE_SONNET_MODEL / ACTIVE_HAIKU_MODEL) if Anthropic deprecates.
// Prices in USD per million tokens. Source: docs.anthropic.com/api/pricing.
const MODELS = {
  sonnet: {
    id_default: 'claude-sonnet-4-6',
    input_per_m: 3.00,
    output_per_m: 15.00,
  },
  haiku: {
    id_default: 'claude-haiku-4-5',
    input_per_m: 0.80,
    output_per_m: 4.00,
  },
};

// ── Cost computation ─────────────────────────────────────────────────────
function computeCost(modelKey, inputTokens, outputTokens) {
  const m = MODELS[modelKey];
  if (!m) return 0;
  return (
    (inputTokens / 1_000_000) * m.input_per_m +
    (outputTokens / 1_000_000) * m.output_per_m
  );
}

function resolveModelId(env, key) {
  // Allow KV override so model id can rotate without code change
  if (key === 'sonnet') return env.ACTIVE_SONNET_MODEL || MODELS.sonnet.id_default;
  if (key === 'haiku')  return env.ACTIVE_HAIKU_MODEL  || MODELS.haiku.id_default;
  // explicit model id passed through (e.g., for special cases)
  return key;
}

function resolveModelKey(modelInput) {
  if (modelInput === 'sonnet' || modelInput === 'haiku') return modelInput;
  // Try to detect from explicit id
  if (typeof modelInput === 'string') {
    if (/sonnet/i.test(modelInput)) return 'sonnet';
    if (/haiku/i.test(modelInput))  return 'haiku';
    if (/opus/i.test(modelInput))   return 'sonnet'; // treat as expensive
  }
  return 'haiku';  // default to cheap
}

// ── Budget queries ───────────────────────────────────────────────────────
async function getTodayCost(env) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT total_cost_usd, total_calls FROM ai_cost_daily WHERE date_utc = ?`
  ).bind(today).first();
  return { cost: row?.total_cost_usd || 0, calls: row?.total_calls || 0 };
}

async function getMonthCost(env) {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const row = await env.DB.prepare(
    `SELECT ROUND(SUM(total_cost_usd), 4) as cost, SUM(total_calls) as calls
     FROM ai_cost_daily WHERE date_utc >= ?`
  ).bind(monthStart).first();
  return { cost: row?.cost || 0, calls: row?.calls || 0 };
}

async function getConversationCost(env, conversationId) {
  if (!conversationId) return 0;
  const row = await env.DB.prepare(
    `SELECT ROUND(SUM(input_tokens + output_tokens), 0) as total_tokens, COUNT(*) as turns
     FROM ai_calls WHERE conversation_id = ?`
  ).bind(conversationId).first();
  return { tokens: row?.total_tokens || 0, turns: row?.turns || 0 };
}

// ── Budget enforcement ───────────────────────────────────────────────────
// Returns { allowed, model_key, reason }
// model_key may be downgraded from 'sonnet' → 'haiku' if soft cap hit.
async function checkBudget(env, { model, use_case, conversation_id }) {
  const reqModelKey = resolveModelKey(model);
  const dailyHard = parseFloat(env.AI_DAILY_HARD_CAP_USD || DEFAULTS.DAILY_HARD_CAP_USD);
  const dailySoft = parseFloat(env.AI_DAILY_SOFT_CAP_USD || DEFAULTS.DAILY_SOFT_CAP_USD);
  const monthlyHard = parseFloat(env.AI_MONTHLY_HARD_CAP_USD || DEFAULTS.MONTHLY_HARD_CAP_USD);
  const monthlySoft = parseFloat(env.AI_MONTHLY_SOFT_CAP_USD || DEFAULTS.MONTHLY_SOFT_CAP_USD);

  const today = await getTodayCost(env);
  const month = await getMonthCost(env);

  // HARD CAPS — refuse Sonnet calls (Haiku still allowed if under monthly hard).
  if (month.cost >= monthlyHard) {
    return { allowed: false, model_key: reqModelKey, reason: 'monthly_hard_cap',
             today: today.cost, month: month.cost };
  }
  if (today.cost >= dailyHard && reqModelKey === 'sonnet') {
    return { allowed: false, model_key: 'sonnet', reason: 'daily_hard_cap_sonnet',
             today: today.cost, month: month.cost };
  }

  // SOFT CAP — downgrade Sonnet → Haiku.
  if ((today.cost >= dailySoft || month.cost >= monthlySoft) && reqModelKey === 'sonnet') {
    return { allowed: true, model_key: 'haiku', reason: 'soft_cap_downgraded_to_haiku',
             today: today.cost, month: month.cost };
  }

  // CONVERSATION TOKEN BUDGET — prevent runaway chats.
  if (conversation_id) {
    const conv = await getConversationCost(env, conversation_id);
    const maxConv = parseInt(env.AI_MAX_TOKENS_PER_CONV || DEFAULTS.MAX_TOKENS_PER_CONV, 10);
    if (conv.tokens > maxConv) {
      return { allowed: false, model_key: reqModelKey, reason: 'conversation_token_cap',
               conversation_tokens: conv.tokens, cap: maxConv };
    }
  }

  return { allowed: true, model_key: reqModelKey, reason: 'within_budget',
           today: today.cost, month: month.cost };
}

// ── Log the call (UPSERT daily rollup too) ───────────────────────────────
async function logCall(env, {
  use_case, model, input_tokens, output_tokens, cost_usd,
  duration_ms, conversation_id, caller, outcome, error_message,
  request_summary, response_summary,
}) {
  const id = crypto.randomUUID();
  const date = new Date().toISOString().slice(0, 10);

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO ai_calls (id, use_case, model, input_tokens, output_tokens, cost_usd,
        duration_ms, conversation_id, caller, outcome, error_message,
        request_summary, response_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      use_case || 'unknown',
      model || 'unknown',
      input_tokens || 0,
      output_tokens || 0,
      cost_usd || 0,
      duration_ms ?? null,
      conversation_id ?? null,
      caller ?? null,
      outcome || 'unknown',
      (error_message || '').slice(0, 500),
      (request_summary || '').slice(0, 200),
      (response_summary || '').slice(0, 200),
    ),
    env.DB.prepare(`
      INSERT INTO ai_cost_daily (date_utc, total_calls, total_input_tokens,
        total_output_tokens, total_cost_usd, last_updated)
      VALUES (?, 1, ?, ?, ?, datetime('now'))
      ON CONFLICT(date_utc) DO UPDATE SET
        total_calls = total_calls + 1,
        total_input_tokens = total_input_tokens + excluded.total_input_tokens,
        total_output_tokens = total_output_tokens + excluded.total_output_tokens,
        total_cost_usd = ROUND(total_cost_usd + excluded.total_cost_usd, 6),
        last_updated = datetime('now')
    `).bind(date, input_tokens, output_tokens, cost_usd),
  ]);

  return id;
}

// ── Main entrypoint ──────────────────────────────────────────────────────
/**
 * Call Anthropic with budget enforcement, cost logging, and model routing.
 *
 * @param {object} env  — Cloudflare Workers env (must have ANTHROPIC_API_KEY)
 * @param {object} opts
 * @param {string} opts.use_case  — e.g., 'daily_brief' | 'chat_turn' | 'categorizer_fallback'
 * @param {string} opts.model     — 'sonnet' | 'haiku' | explicit id
 * @param {array}  opts.messages
 * @param {string} [opts.system]
 * @param {array}  [opts.tools]
 * @param {number} [opts.max_tokens]
 * @param {string} [opts.conversation_id]
 * @param {string} [opts.caller]
 * @param {boolean} [opts.allow_haiku_downgrade] — defaults to true; set false to fail-loud on soft cap
 *
 * @returns {object} { ok, content, tool_use, stop_reason, cost_usd, tokens, blocked_reason, model_used }
 */
export async function callAI(env, opts = {}) {
  const started = Date.now();
  const use_case = opts.use_case || 'unknown';
  const caller = opts.caller || 'unknown';
  const allowDowngrade = opts.allow_haiku_downgrade !== false;

  // Budget check
  const budget = await checkBudget(env, {
    model: opts.model,
    use_case,
    conversation_id: opts.conversation_id,
  });

  if (!budget.allowed) {
    await logCall(env, {
      use_case, model: resolveModelId(env, resolveModelKey(opts.model)),
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      duration_ms: Date.now() - started,
      conversation_id: opts.conversation_id, caller,
      outcome: 'budget_blocked', error_message: budget.reason,
    });
    return {
      ok: false,
      blocked_reason: budget.reason,
      budget_state: budget,
      content: null,
    };
  }

  // If soft cap downgraded us and caller said no, refuse.
  if (budget.reason === 'soft_cap_downgraded_to_haiku' && !allowDowngrade) {
    await logCall(env, {
      use_case, model: 'sonnet',
      input_tokens: 0, output_tokens: 0, cost_usd: 0,
      duration_ms: Date.now() - started,
      conversation_id: opts.conversation_id, caller,
      outcome: 'budget_blocked', error_message: 'sonnet_required_but_soft_cap_hit',
    });
    return { ok: false, blocked_reason: 'sonnet_required_but_soft_cap_hit', content: null };
  }

  const modelKey = budget.model_key;
  const modelId = resolveModelId(env, modelKey);
  const maxTokens = Math.min(opts.max_tokens || 1024, DEFAULTS.MAX_TOKENS_PER_CALL);

  // Truncate tools list if too long (prevent tool-call loops)
  let tools = opts.tools;
  if (tools && tools.length > DEFAULTS.MAX_TOOLS_PER_TURN) {
    tools = tools.slice(0, DEFAULTS.MAX_TOOLS_PER_TURN);
  }

  // Build request
  const body = {
    model: modelId,
    max_tokens: maxTokens,
    messages: opts.messages || [],
  };
  if (opts.system) body.system = opts.system;
  if (tools && tools.length) body.tools = tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;

  // Call Anthropic
  let resp, json, errMsg = null, inputTokens = 0, outputTokens = 0, content = null, toolUse = null, stopReason = null;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      errMsg = `${resp.status}: ${errBody.slice(0, 300)}`;
    } else {
      json = await resp.json();
      inputTokens = json.usage?.input_tokens || 0;
      outputTokens = json.usage?.output_tokens || 0;
      stopReason = json.stop_reason;
      // Extract content blocks
      const blocks = json.content || [];
      content = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      toolUse = blocks.filter(b => b.type === 'tool_use');
    }
  } catch (err) {
    errMsg = `exception: ${(err.message || String(err)).slice(0, 300)}`;
  }

  const costUsd = computeCost(modelKey, inputTokens, outputTokens);
  const outcome = errMsg ? (errMsg.startsWith('429') ? 'rate_limit' : 'error') : 'success';

  // Log + roll-up
  await logCall(env, {
    use_case, model: modelId,
    input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd,
    duration_ms: Date.now() - started,
    conversation_id: opts.conversation_id, caller,
    outcome, error_message: errMsg,
    request_summary: JSON.stringify(opts.messages?.[0]?.content || '').slice(0, 200),
    response_summary: (content || '').slice(0, 200),
  });

  if (errMsg) {
    return {
      ok: false,
      error: errMsg,
      cost_usd: costUsd,
      model_used: modelId,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };
  }

  return {
    ok: true,
    content,
    tool_use: toolUse,
    stop_reason: stopReason,
    model_used: modelId,
    model_key: modelKey,
    cost_usd: costUsd,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    downgraded: budget.reason === 'soft_cap_downgraded_to_haiku',
    raw: json,
  };
}

// ── Helpers for callers + dashboard ──────────────────────────────────────

export async function getBudgetStatus(env) {
  const today = await getTodayCost(env);
  const month = await getMonthCost(env);
  return {
    today: {
      cost_usd: Math.round(today.cost * 10000) / 10000,
      calls: today.calls,
      soft_cap: parseFloat(env.AI_DAILY_SOFT_CAP_USD || DEFAULTS.DAILY_SOFT_CAP_USD),
      hard_cap: parseFloat(env.AI_DAILY_HARD_CAP_USD || DEFAULTS.DAILY_HARD_CAP_USD),
      pct_of_soft: today.cost / DEFAULTS.DAILY_SOFT_CAP_USD,
    },
    month: {
      cost_usd: Math.round(month.cost * 10000) / 10000,
      calls: month.calls,
      soft_cap: parseFloat(env.AI_MONTHLY_SOFT_CAP_USD || DEFAULTS.MONTHLY_SOFT_CAP_USD),
      hard_cap: parseFloat(env.AI_MONTHLY_HARD_CAP_USD || DEFAULTS.MONTHLY_HARD_CAP_USD),
      pct_of_soft: month.cost / DEFAULTS.MONTHLY_SOFT_CAP_USD,
    },
    sonnet_allowed: today.cost < DEFAULTS.DAILY_HARD_CAP_USD && month.cost < DEFAULTS.MONTHLY_HARD_CAP_USD,
    sonnet_will_downgrade: today.cost >= DEFAULTS.DAILY_SOFT_CAP_USD || month.cost >= DEFAULTS.MONTHLY_SOFT_CAP_USD,
  };
}

export async function getCostBreakdown(env, days = 7) {
  const { results } = await env.DB.prepare(`
    SELECT use_case,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           ROUND(SUM(cost_usd), 4) as cost_usd,
           COUNT(*) as calls
    FROM ai_calls
    WHERE call_at >= datetime('now', '-' || ? || ' days')
    GROUP BY use_case
    ORDER BY cost_usd DESC
  `).bind(days).all();
  return { days, by_use_case: results || [] };
}
