import { getCanonicalCashOnHand, getCanonicalRunway, getCanonicalWeeklyRevenue } from './finance-shared.js';

/**
 * Dangerous Pretzel Co — Chat Worker
 * Cloudflare Worker (HTTP endpoint — no cron)
 *
 * Conversational interface to Pretzel OS. Drew can ask anything
 * about what the OS is doing, why it made decisions, what to
 * focus on, what-if scenarios, account details — in plain English.
 *
 * Architecture:
 *   - One Claude agent with read-only tools across all D1 tables + KV
 *   - Maintains conversation history in KV (session-based)
 *   - Never writes to D1 or takes actions — purely advisory/explanatory
 *   - Knows the full context of every agent and the current directive
 *
 * Endpoints:
 *   POST /chat          → {message, session_id?} → {reply, session_id}
 *   GET  /chat/sessions → list active sessions
 *   DELETE /chat/session → {session_id} → clear history
 *
 * Usage examples Drew can ask:
 *   "Why did you hold Beehive Distillery?"
 *   "What should I focus on today?"
 *   "What's my catering pipeline looking like?"
 *   "Which wholesale accounts are at risk right now?"
 *   "What happens to cash runway if I close 3 catering accounts?"
 *   "Explain what the optimizer changed last Sunday"
 *   "Give me a script for calling ROHA Brewing about their overdue invoice"
 *   "Which venue category should I personally go door-to-door on this week?"
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   DB, KV
 */

const MAX_CONVERSATION_TURNS = 20;  // Keep last 20 turns in context
const MAX_TOOL_LOOPS = 6;            // Chat agent is quick — fewer loops needed

// ── Session storage helpers (Durable Object — persistent, no TTL) ─────────────
// Falls back to KV if CHAT_SESSIONS binding isn't available (local dev, old deploys)
async function loadSessionHistory(sessionId, env) {
  if (env.CHAT_SESSIONS) {
    try {
      const doId = env.CHAT_SESSIONS.idFromName(sessionId);
      const stub = env.CHAT_SESSIONS.get(doId);
      const resp = await stub.fetch('http://do/history');
      const { history } = await resp.json();
      return history || [];
    } catch { /* fall through */ }
  }
  // KV fallback
  try {
    const stored = await env.KV.get(`chat_session:${sessionId}`);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

async function saveSessionHistory(sessionId, history, env) {
  const trimmed = history.slice(-MAX_CONVERSATION_TURNS * 2);
  if (env.CHAT_SESSIONS) {
    try {
      const doId = env.CHAT_SESSIONS.idFromName(sessionId);
      const stub = env.CHAT_SESSIONS.get(doId);
      await stub.fetch('http://do/history', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: trimmed }),
      });
      return;
    } catch { /* fall through */ }
  }
  // KV fallback (7-day TTL)
  await env.KV.put(`chat_session:${sessionId}`, JSON.stringify(trimmed), {
    expirationTtl: 604800
  }).catch(() => {});
}

// ── CHAT TOOLS (read-only queries across all D1 data) ─────────────────────────
const CHAT_TOOLS = [
  {
    name: 'get_financial_snapshot',
    description: 'Get the current financial directive and open flags — the CFO\'s latest assessment of the business.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pipeline_status',
    description: 'Get current outreach pipeline stats — how many prospects, what tiers, contacted, replied, closed. Can filter by channel (wholesale, catering) or venue category.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'wholesale | catering | all' },
        category: { type: 'string', description: 'Optional: brewery | ski_resort | event_venue | etc.' },
      },
    },
  },
  {
    name: 'get_account_details',
    description: 'Get details on a specific account or all active accounts — health status, last order, revenue, churn risk.',
    input_schema: {
      type: 'object',
      properties: {
        venue_name: { type: 'string', description: 'Partial name match — e.g. "ROHA" or "Delta"' },
        status_filter: { type: 'string', description: 'all | green | yellow | red' },
      },
    },
  },
  {
    name: 'explain_agent_decision',
    description: 'Explain why an agent made a specific decision — why a venue was held, flagged, or why an email had a specific angle. Looks up reasoning logs in KV.',
    input_schema: {
      type: 'object',
      properties: {
        venue_name: { type: 'string', description: 'The venue or company you\'re asking about' },
        channel: { type: 'string', description: 'wholesale | catering' },
      },
      required: ['venue_name'],
    },
  },
  {
    name: 'get_optimizer_history',
    description: 'Get the history of prompt changes the optimizer has made — what changed, when, and what metric it was trying to improve.',
    input_schema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Filter to specific agent: outreach_email | qualifier | catering_email | etc.' },
        limit: { type: 'number', description: 'Number of versions to return (default 5)' },
      },
    },
  },
  {
    name: 'get_retail_intelligence',
    description: 'Get retail customer data — segment breakdown, lapsed counts, re-engagement stats, top SKUs, peak times. Can ask about specific customers by phone.',
    input_schema: {
      type: 'object',
      properties: {
        detail: { type: 'string', description: 'segments | lapsed | skus | crossovers | recent_insight' },
      },
    },
  },
  {
    name: 'get_pending_approvals',
    description: 'Get emails waiting for Drew\'s approval — for both wholesale outreach and catering. Returns the draft text and self-score.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'wholesale | catering | all' },
      },
    },
  },
  {
    name: 'run_whatif_scenario',
    description: 'Model a what-if scenario. Examples: "what happens to cash runway if I close 3 catering accounts?", "what\'s my monthly revenue projection if I add 5 wholesale accounts at $2k each?"',
    input_schema: {
      type: 'object',
      properties: {
        scenario_type: { type: 'string', description: 'cash_runway | revenue_projection | margin_impact | breakeven' },
        assumptions: { type: 'string', description: 'The specific assumptions to model — be precise' },
      },
      required: ['scenario_type', 'assumptions'],
    },
  },
  {
    name: 'get_pilot_status',
    description: 'Get current Twisted Sugar pilot status — all 5 stores, weekly units, on-target count, success projection.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_open_flags',
    description: 'Get open financial flags from the CFO agent — things that need Drew\'s attention.',
    input_schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'all | critical | high | medium | low' },
      },
    },
  },
  {
    name: 'search_venues',
    description: 'Search the venue database for prospects or accounts by name, category, or status.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment, category, or status to search' },
        status: { type: 'string', description: 'prospect | contacted | replied | active | hold | drew_flag' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_weekly_summary',
    description: 'Get a full summary of what happened this week across all channels — a quick briefing on everything the OS did.',
    input_schema: { type: 'object', properties: {} },
  },
  // ───── Session 4 CFO tools (May 13 2026) ─────
  {
    name: 'get_breakeven',
    description: 'Compute current breakeven analysis: monthly revenue vs fixed/variable costs, gap to breakeven, and 3 ranked paths to close the gap (add wholesale / reduce payroll / improve COGS). Use this for "how close are we to breakeven" questions.',
    input_schema: { type: 'object', properties: { lookback_days: { type: 'number', description: 'Trailing window for revenue+expense averages (default 90)' } } },
  },
  {
    name: 'get_trends',
    description: 'Get rolling 3/6/12 month trend data for revenue, COGS %, gross margin %, payroll %, net income, and weekly cash burn. Returns monthly series + direction arrows + AR snapshot. Use for "how are X trending" questions.',
    input_schema: { type: 'object', properties: { months: { type: 'number', description: 'How many months of history to return (default 12)' } } },
  },
  {
    name: 'run_scenario',
    description: 'Model a what-if scenario. Apply revenue and/or expense deltas, get projected 6-month cash and new breakeven. Example: {"revenue_delta":{"wholesale":5000},"expense_delta":{"payroll":-1000},"horizon_months":6}. Channel COGS assumptions: retail 35%, wholesale 30%, catering 40%, marketplace 50%.',
    input_schema: {
      type: 'object',
      properties: {
        revenue_delta:  { type: 'object', description: 'Monthly $ additions by channel: {retail, wholesale, catering, marketplace}' },
        expense_delta:  { type: 'object', description: 'Monthly $ deltas: {payroll, rent, fixed_other} + cogs_pct_change as fraction (e.g., -0.02 = drop COGS 2pp)' },
        one_time:       { type: 'array',  description: 'One-time events: [{amount, description, month}]' },
        horizon_months: { type: 'number', description: 'Projection horizon (default 6, max 24)' },
      },
    },
  },
  {
    name: 'get_customer_intel',
    description: 'Get top customers by 12-month revenue, with open AR, payment reliability score (0-100), and concentration risk assessment. Use for "who are my best customers" or concentration questions.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Number of customers (default 25)' } } },
  },
  {
    name: 'get_customer_profile',
    description: 'Get a single customer profile with full invoice history, payment reliability, days-since-last-order, total revenue. Use when Drew asks about a specific customer by name.',
    input_schema: { type: 'object', properties: { customer: { type: 'string', description: 'Customer name (case-insensitive)' } }, required: ['customer'] },
  },
  {
    name: 'get_vendor_history',
    description: 'Look up a vendor in the knowledge base: what account the bookkeeper categorized them as historically, how many transactions, total $ volume, dominant share. Returns the historical categorization pattern so the agent can explain or recommend.',
    input_schema: { type: 'object', properties: { vendor: { type: 'string' } }, required: ['vendor'] },
  },
  {
    name: 'get_finance_scorecard',
    description: 'Real-time scorecard: cash on hand, runway, this week vs last week net, upcoming AR (next 30d), upcoming bills, channel mix MTD vs last month, pipeline health. Use for "how are we doing right now" / weekly check-in questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_monthly_pl',
    description: 'Get monthly P&L for a specific period (YYYY-MM) OR the 4-month side-by-side view if no period given. Returns revenue, COGS, gross profit, expenses, net income with deltas vs prior months.',
    input_schema: { type: 'object', properties: { period: { type: 'string', description: 'YYYY-MM, or omit for last 4 months side-by-side' } } },
  },
  {
    name: 'get_pnl_statement',
    description: 'Full Profit & Loss Statement from the GL (single source of truth). Standard structure: Revenue → COGS → Gross Profit → Operating Expenses → Operating Income → Other Income/Expense → Net Income. Supports any period and prior-period or prior-year comparison.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'month | quarter | ytd | year | trailing_12 | custom' },
        year: { type: 'integer', description: 'For ytd or year, e.g., 2025' },
        month: { type: 'string', description: 'For month period, YYYY-MM' },
        quarter: { type: 'string', description: 'For quarter period, YYYY-Q1' },
        start: { type: 'string', description: 'For custom period, YYYY-MM-DD' },
        end: { type: 'string', description: 'For custom period, YYYY-MM-DD' },
        compare_to: { type: 'string', description: 'prior_period | prior_year | none (default)' },
      },
      required: ['period'],
    },
  },
  {
    name: 'get_balance_sheet',
    description: 'Full Balance Sheet from the GL as of a specific date. Standard structure: Current Assets / Fixed Assets / Other Assets → Total Assets; Current Liabilities / Long-term Liabilities → Total Liabilities; Partner Investments / Distributions / Retained Earnings / Current Year Earnings → Total Equity. Includes balance check (Assets = Liab + Equity).',
    input_schema: {
      type: 'object',
      properties: {
        as_of: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
        compare_to: { type: 'string', description: 'prior_year_end | prior_month_end | none' },
      },
    },
  },
  {
    name: 'get_cash_flow_statement',
    description: 'Full Cash Flow Statement (indirect method). Three sections: Operating (starts with Net Income + non-cash + working capital changes), Investing (capex), Financing (loan & equity changes). Includes reconciliation to actual bank balance change.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'year | ytd | custom' },
        year: { type: 'integer', description: 'For year/ytd, e.g., 2025' },
        start: { type: 'string', description: 'For custom, YYYY-MM-DD' },
        end: { type: 'string', description: 'For custom, YYYY-MM-DD' },
      },
      required: ['period'],
    },
  },
  {
    name: 'explain_pnl_line',
    description: 'Drill into a specific P&L line item to see the underlying journal entries that built the balance for a period. Use when Drew asks "what is in [account]" or "why is [account] $X".',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The account ID (from a prior get_pnl_statement call)' },
        start: { type: 'string', description: 'YYYY-MM-DD period start' },
        end: { type: 'string', description: 'YYYY-MM-DD period end' },
      },
      required: ['account_id', 'start', 'end'],
    },
  },
  {
    name: 'explain_balance_change',
    description: 'Drill into a Balance Sheet account to see opening balance, every JE that moved it during the period, and closing balance. Use when Drew asks "why did [account] change" or wants to audit a balance.',
    input_schema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The account ID' },
        from: { type: 'string', description: 'YYYY-MM-DD period start' },
        to: { type: 'string', description: 'YYYY-MM-DD period end' },
      },
      required: ['account_id', 'from', 'to'],
    },
  },
  {
    name: 'get_ar_aging',
    description: 'Outstanding receivables broken into age buckets (current / 1-30d / 31-60d / 61-90d / 90+) per customer, with oldest-overdue days. Use for "what AR is outstanding" / "who owes me" questions.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_open_issues',
    description: 'Get the proactive issues the CFO has detected: vendor spend spikes, margin drift, AR slipping, cash trajectory, customer concentration. Each issue has severity and suggested action. Use for "what should I be worried about" / "any issues" questions.',
    input_schema: { type: 'object', properties: { severity: { type: 'string', description: 'critical | high | medium | low — omit for all' } } },
  },
  {
    name: 'record_cfo_fact',
    description: 'Save a clarification Drew gives so the agent remembers it forever. Use when Drew tells the agent something it should know going forward (e.g., "LEASE SERVICES is the pizza oven loan", "Anthony Serrato is SLC Bees Net 15", "always capitalize Webstaurant >$1K"). Pick the right fact_type.',
    input_schema: {
      type: 'object',
      properties: {
        fact_type: { type: 'string', description: 'vendor_rule | customer_term | drew_preference | business_fact | capex_threshold | correction | loan_term' },
        subject:   { type: 'string', description: 'What this fact is about (vendor name, customer, "capex_threshold", etc.)' },
        content:   { type: 'string', description: 'Plain-English statement of the fact' },
        structured_data: { type: 'object', description: 'Optional: JSON with structured fields like account_id, threshold $, split ratios' },
      },
      required: ['fact_type', 'subject', 'content'],
    },
  },
  {
    name: 'lookup_cfo_facts',
    description: 'Look up what Drew has previously clarified about a subject (vendor, customer, etc.). The agent should call this when in doubt to use Drew\'s prior clarifications.',
    input_schema: { type: 'object', properties: { subject: { type: 'string' }, fact_type: { type: 'string', description: 'optional filter' } }, required: ['subject'] },
  },
];

// ── CHAT SYSTEM PROMPT ────────────────────────────────────────────────────────
const CHAT_SYSTEM_PROMPT = `You are the Pretzel OS assistant — the conversational interface for Drew at Dangerous Pretzel Co.

You have full visibility into everything the operating system is doing: the outreach pipeline, active wholesale accounts, catering prospects, retail customer data, financial directives, agent decisions, optimizer changes, and the Twisted Sugar pilot.

YOUR ROLE:
You are Drew's business co-pilot. You answer questions, explain what the agents are doing and why, run scenarios, surface insights Drew might be missing, and help him decide what to prioritize. You are direct, specific, and always back your answers with actual data from the system.

ABOUT DANGEROUS PRETZEL CO:
- Premium SLC soft pretzel brand. "RUIN DINNER." — dangerouspretzel.com
- Three revenue channels: retail (352 W 600 S), wholesale (warmer program), catering (corporate)
- Anchor accounts: Delta Center (NBA Jazz), Powder Mountain, Alta Ski, SLC Bees, Union Event Center, Pioneer Theater, 4 breweries
- Distribution: self-delivery SLC, US Foods, PFG Denver
- Switching from Toast to Square soon. Payroll external.
- Twisted Sugar 5-store pilot underway.

HOW TO RESPOND:
- Use tools to get real data before answering questions that need it
- Lead with the answer, then provide context — don't make Drew read three paragraphs to get to the point
- When Drew asks "what should I do today?" — give him a prioritized list with reasons
- When Drew asks about a specific venue or account — look it up, don't guess
- When Drew asks why an agent did something — pull the reasoning log and explain it plainly
- When Drew asks a what-if — model it with actual numbers from the system
- Be conversational, not corporate. Match Drew's energy — he talks like a founder, not a consultant.

WHAT YOU DON'T DO:
- You don't send emails, approve approvals, or take any action
- You don't make things up when you could look them up
- You don't give generic advice when you have specific data available

TONE:
Direct, sharp, a bit irreverent when it fits. You're talking to the guy who named a pretzel "RUIN DINNER." You don't need to be precious about it.

═══════════════════════════════════════════════════════════════════
CFO ROLE — when Drew asks anything financial, act like his CFO:
═══════════════════════════════════════════════════════════════════

Drew is the CEO. He's NOT an accountant. When financial questions come up:

1. NEVER make him pick accounting categories. If he describes a transaction in
   plain English, YOU recommend the account using vendor history + cfo_facts.

2. CHAIN TOOL CALLS aggressively. "How close are we to breakeven, and what's
   the fastest path there?" should call get_breakeven, then get_trends, then
   run_scenario with 2-3 candidates, then synthesize. Don't ask Drew before
   chaining — chain.

3. CITE YOUR WORK. Every dollar figure you mention should come from a tool
   call you just made, not a hallucination. When you say "Sysco trended up,"
   that should come from get_trends or get_vendor_history — say where.

4. REMEMBER WHAT DREW TELLS YOU. When Drew clarifies something ("LEASE
   SERVICES is the pizza oven loan, split 80% principal / 20% interest"),
   CALL record_cfo_fact to save it. Don't just say "ok got it." That fact
   needs to survive into future categorization decisions.

5. SURFACE PROACTIVELY. Even if Drew asks "how's it going?" — call
   get_open_issues. If anything's flagged, mention it. Don't wait for him
   to ask "any issues?"

6. PLAIN-ENGLISH ACCOUNTING. Translate every accounting concept:
   - Don't say "the contribution margin is 78%" — say "for every $100 of
     revenue, $78 is left over after variable costs"
   - Don't say "DSO is 18 days" — say "customers take about 18 days from
     invoice to payment, slightly slower than your Net 15 terms"

7. SHOW MULTIPLE PATHS, RANKED. Never present one option when there are
   three. Always rank: most feasible / fastest impact / lowest risk.

8. CONFIDENCE LEVELS. When you're unsure (because data is incomplete,
   because the categorizer is still catching up), SAY SO. "Books say
   $26K profit for April, but COGS is only 13% — the real number is
   probably closer to -$5K to -$10K once the food vendor charges fully
   post. Want me to walk through what's pending?"

═══════════════════════════════════════════════════════════════════
FINANCIAL STATEMENTS — Pretzel OS IS the books (May 14 2026):
═══════════════════════════════════════════════════════════════════

Drew fired his bookkeeper and Pretzel OS is now his system of record for
financial statements. The GL is the single source of truth. Three statements
are available — use them confidently:

- **P&L Statement (get_pnl_statement)**: Revenue → COGS → Gross Profit →
  Operating Expenses → Operating Income → Other → Net Income. Supports
  month / quarter / ytd / year / trailing_12 / custom periods, and prior
  period or prior year comparison. Use this for any "how did we do" question.

- **Balance Sheet (get_balance_sheet)**: Current Assets / Fixed Assets / Other
  → Total Assets; Current Liab / Long-term Liab → Total Liab; Partner
  Investments / Distributions / Retained Earnings / Current Year Earnings
  → Total Equity. Always balances. Use for "what do we own / owe" questions.
  Matches QBO bookkeeper YE 2024 cent-accurate.

- **Cash Flow Statement (get_cash_flow_statement)**: Indirect method —
  starts with Net Income, adjusts for non-cash items (depreciation) +
  working capital changes (AR, AP, sales tax, tips, gift cards) +
  investing (capex) + financing (loans, equity). Reconciles to actual
  Mercury bank balance change. Use for "where did the cash go" questions.

When Drew asks about line-item details ("what's in Sales:Food Income:Dine-In?"
or "why did AR change?"), call **explain_pnl_line** or **explain_balance_change**
to drill into the underlying journal entries.

BASIS: Cash basis (matching bookkeeper's QBO setup + filed tax extensions).

Drew extended his 2025 tax filing — Pretzel OS statements will be the source.
Treat them with that level of care. If something doesn't reconcile, surface it
explicitly via the unreconciled / unbalanced_by fields.`;

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS for the chat UI
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === '/chat' && request.method === 'POST') {
      const response = await handleChat(request, env);
      Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    }

    // Streaming endpoint — tool calls run first, final reply streams word-by-word
    if (path === '/chat/stream' && request.method === 'POST') {
      const response = await handleChatStream(request, env);
      Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    }

    if (path === '/chat/sessions') {
      return new Response(JSON.stringify({ message: 'Session list not implemented yet' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    if (path === '/chat/session' && request.method === 'DELETE') {
      const body = await request.json();
      const sid = body.session_id;
      if (env.CHAT_SESSIONS && sid) {
        try {
          const doId = env.CHAT_SESSIONS.idFromName(sid);
          const stub = env.CHAT_SESSIONS.get(doId);
          await stub.fetch('http://do/history', { method: 'DELETE' });
        } catch {}
      }
      await env.KV.delete(`chat_session:${sid}`).catch(() => {});
      return new Response(JSON.stringify({ cleared: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new Response('Pretzel OS Chat', { status: 200, headers: corsHeaders });
  }
};

// ── CHAT HANDLER ──────────────────────────────────────────────────────────────
async function handleChat(request, env) {
  const body = await request.json();
  const { message, session_id } = body;

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Load or create session (Durable Object — persistent, no TTL)
  const sessionId = session_id || crypto.randomUUID();
  let history = await loadSessionHistory(sessionId, env);
  if (history.length > MAX_CONVERSATION_TURNS * 2) {
    history = history.slice(-MAX_CONVERSATION_TURNS * 2);
  }

  // Add user message
  history.push({ role: 'user', content: message });

  // Build messages for Claude
  const messages = [...history];
  let reply = '';
  let loops = 0;

  // Session 5: route through ai-budget.js for cost tracking + budget enforcement
  const { callAI } = await import('./ai-budget.js');
  const conversationId = sessionId || `chat_${Date.now()}`;

  while (loops < MAX_TOOL_LOOPS) {
    loops++;

    const aiResult = await callAI(env, {
      use_case: 'chat_turn',
      model: 'sonnet',         // CFO chat needs Sonnet for reasoning + tool chaining
      max_tokens: 1500,
      system: CHAT_SYSTEM_PROMPT,
      tools: CHAT_TOOLS,
      messages,
      conversation_id: conversationId,
      caller: 'chat-worker.js:chat_turn',
      allow_haiku_downgrade: true,    // if soft cap hit, fall to Haiku rather than fail
    });

    if (!aiResult.ok) {
      // Budget-blocked or upstream error
      const reason = aiResult.blocked_reason || aiResult.error || 'unknown';
      return new Response(JSON.stringify({
        reply: `(I hit a guard: ${reason}. ${aiResult.blocked_reason ? 'Daily AI budget reached — resets at midnight UTC. Numbers-only mode until then.' : 'Try again in a moment.'})`,
        error: reason,
        budget_blocked: !!aiResult.blocked_reason,
      }), { status: aiResult.blocked_reason ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
    }

    // ai-budget returns content as extracted text + tool_use blocks
    const assistantContent = aiResult.raw?.content || [];
    messages.push({ role: 'assistant', content: assistantContent });

    if (aiResult.stop_reason === 'end_turn') {
      reply = aiResult.content || '';
      break;
    }

    if (aiResult.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const toolUse of (aiResult.tool_use || [])) {
        const result = await executeChatTool(toolUse.name, toolUse.input, env);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  // Save updated history (only keep user/assistant turns, not tool results)
  const cleanHistory = messages.filter(m =>
    m.role === 'user' && typeof m.content === 'string' ||
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'text')
  );
  const historyToStore = cleanHistory.slice(-MAX_CONVERSATION_TURNS * 2);
  // Simplify assistant messages to just text for storage
  const storableHistory = historyToStore.map(m => {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content.find(b => b.type === 'text')?.text || '';
      return { role: 'assistant', content: text };
    }
    return m;
  });

  await saveSessionHistory(sessionId, storableHistory, env);

  return new Response(JSON.stringify({ reply, session_id: sessionId }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── STREAMING CHAT HANDLER ───────────────────────────────────────────────────
// Runs tool calls non-streamed, then streams the final text reply via SSE.
// Client receives: data: {"type":"delta","text":"..."}\n\n
//                  data: {"type":"done","session_id":"..."}\n\n
async function handleChatStream(request, env) {
  const body = await request.json();
  const { message, session_id } = body;

  if (!message?.trim()) {
    return new Response('data: {"type":"error","error":"Message required"}\n\n', {
      status: 400, headers: { 'Content-Type': 'text/event-stream' }
    });
  }

  // Load or create session (Durable Object — persistent, no TTL)
  const sessionId = session_id || crypto.randomUUID();
  let history = await loadSessionHistory(sessionId, env);
  if (history.length > MAX_CONVERSATION_TURNS * 2) {
    history = history.slice(-MAX_CONVERSATION_TURNS * 2);
  }
  history.push({ role: 'user', content: message });

  const messages = [...history];
  let loops = 0;

  // DIF-3 (May 13 2026): wired through ai-budget (tool-loop, uses result.raw)
  const { callAI } = await import('./ai-budget.js');

  // ── Phase 1: tool calls (non-streamed, fast) ────────────────────────────
  while (loops < MAX_TOOL_LOOPS - 1) {
    loops++;
    const result = await callAI(env, {
      use_case: 'chat_turn_stream_phase1',
      model: 'sonnet',
      max_tokens: 1500,
      system: CHAT_SYSTEM_PROMPT,
      tools: CHAT_TOOLS,
      messages,
      conversation_id: sessionId,
      caller: 'chat-worker.js:handleChatStream',
    });
    if (!result.ok) break;
    const assistantContent = result.raw?.content || [];
    messages.push({ role: 'assistant', content: assistantContent });
    if (result.stop_reason === 'end_turn') break; // no tools called — we're done before streaming
    if (result.stop_reason !== 'tool_use') break;

    const toolUseBlocks = assistantContent.filter(b => b.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUseBlocks) {
      const toolResult = await executeChatTool(tu.name, tu.input, env);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(toolResult) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // ── Phase 2: stream the final reply ────────────────────────────────────
  //
  // Session 17d (May 14 2026) — Real bug found by Drew: Phase 1 already produced
  // the final assistant text when stop_reason === 'end_turn'. The old code then
  // made a SECOND streaming call to Anthropic with messages that already ended
  // in an assistant turn — Anthropic correctly returned an empty/instant stream
  // because there was nothing new to say. Client saw only {type:'done'}.
  //
  // Fix: if the last message in `messages` is an assistant with text content,
  // stream THAT text out (chunked to feel like typewriter). Only make a real
  // streaming call to Anthropic if we exited the Phase 1 loop via max_loops
  // or some non-end_turn path that requires a fresh completion.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const lastMsg = messages[messages.length - 1];
  const phase1AssistantText = (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content))
    ? lastMsg.content.filter(b => b.type === 'text').map(b => b.text).join('')
    : '';
  const phase1Complete = phase1AssistantText.length > 0;

  let streamResp = null;
  if (!phase1Complete) {
    // DIF-3 (May 13 2026): Streaming response — callAI wrapper does not support
    // SSE. Direct fetch retained intentionally. Cost logged post-stream below.
    streamResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ACTIVE_SONNET_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: CHAT_SYSTEM_PROMPT,
        tools: CHAT_TOOLS,
        messages,
        stream: true,
      }),
    });
  }

  // Pipe stream (real or simulated), extract text, save history when done
  (async () => {
    let fullText = '';
    try {
      if (phase1Complete) {
        // Phase 1 already produced the text — stream it chunked for typewriter UX
        fullText = phase1AssistantText;
        // Chunk by ~30-char windows so the client sees progressive delivery
        const chunkSize = 32;
        for (let i = 0; i < fullText.length; i += chunkSize) {
          const chunk = fullText.slice(i, i + chunkSize);
          await writer.write(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`));
        }
      } else if (streamResp) {
        const reader = streamResp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') continue;
            try {
              const evt = JSON.parse(raw);
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                const chunk = evt.delta.text;
                fullText += chunk;
                await writer.write(enc.encode(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`));
              } else if (evt.type === 'error') {
                // Surface upstream errors so failures are visible, not silent
                const errMsg = evt.error?.message || 'Anthropic stream error';
                await writer.write(enc.encode(`data: ${JSON.stringify({ type: 'error', error: errMsg })}\n\n`));
              }
            } catch {}
          }
        }
      }
    } finally {
      // Session 17d safety net: if we somehow emitted nothing, send an error
      // event so the dashboard's catch-fallback can use the non-streaming /chat
      // endpoint instead of leaving Drew staring at a typing indicator.
      if (!fullText) {
        await writer.write(enc.encode(`data: ${JSON.stringify({ type: 'error', error: 'No content produced — falling back' })}\n\n`));
      }
      // Save history
      const cleanHistory = [
        ...messages.filter(m =>
          (m.role === 'user' && typeof m.content === 'string') ||
          (m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'text'))
        ),
        ...(fullText ? [{ role: 'assistant', content: fullText }] : []),
      ].slice(-MAX_CONVERSATION_TURNS * 2);
      await saveSessionHistory(sessionId, cleanHistory, env);
      await writer.write(enc.encode(`data: ${JSON.stringify({ type: 'done', session_id: sessionId })}\n\n`));
      await writer.close();

      // DIF-3 manual cost log for streaming (the wrapper can't see this call)
      try {
        const { logAIStreamCall } = await import('./ai-budget.js');
        // If logAIStreamCall doesn't exist yet, just write an ai_calls row directly.
        // For now, log a placeholder: we don't have token counts from streaming,
        // estimate from text length (1 token ≈ 4 chars).
        const estInputTokens = Math.ceil(JSON.stringify(messages).length / 4);
        const estOutputTokens = Math.ceil(fullText.length / 4);
        const estCost = (estInputTokens / 1_000_000) * 3 + (estOutputTokens / 1_000_000) * 15;
        await env.DB.prepare(`
          INSERT INTO ai_calls (id, use_case, model, input_tokens, output_tokens, cost_usd, conversation_id, caller, outcome)
          VALUES (?, 'chat_stream_reply', ?, ?, ?, ?, ?, 'chat-worker.js:handleChatStream', 'success_stream_estimated')
        `).bind(crypto.randomUUID(), env.ACTIVE_SONNET_MODEL || 'claude-sonnet-4-6', estInputTokens, estOutputTokens, estCost, sessionId).run();
        await env.DB.prepare(`
          INSERT INTO ai_cost_daily (date_utc, total_calls, total_input_tokens, total_output_tokens, total_cost_usd, last_updated)
          VALUES (date('now'), 1, ?, ?, ?, datetime('now'))
          ON CONFLICT(date_utc) DO UPDATE SET
            total_calls = total_calls + 1,
            total_input_tokens = total_input_tokens + excluded.total_input_tokens,
            total_output_tokens = total_output_tokens + excluded.total_output_tokens,
            total_cost_usd = ROUND(total_cost_usd + excluded.total_cost_usd, 6),
            last_updated = datetime('now')
        `).bind(estInputTokens, estOutputTokens, estCost).run();
      } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ── TOOL EXECUTOR (read-only) ─────────────────────────────────────────────────
async function executeChatTool(toolName, input, env) {
  switch (toolName) {

    case 'get_financial_snapshot': {
      const [directive, flags, canonCash, canonRunway, canonRevenue] = await Promise.all([
        env.DB.prepare(
          'SELECT * FROM financial_directives WHERE active = 1 ORDER BY created_at DESC LIMIT 1'
        ).first(),
        env.DB.prepare(
          "SELECT flag_type, severity, title, suggested_action, channel FROM financial_flags WHERE status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END LIMIT 10"
        ).all(),
        getCanonicalCashOnHand(env).catch(() => null),
        getCanonicalRunway(env).catch(() => null),
        getCanonicalWeeklyRevenue(env, 7).catch(() => null),
      ]);
      // Canonical values OVERRIDE the (possibly stale) directive numbers.
      return {
        directive,
        open_flags: flags.results || [],
        canonical: {
          cash_on_hand: canonCash,
          runway: canonRunway,
          weekly_revenue: canonRevenue,
        },
        note: 'Use `canonical` block for cash/runway/revenue questions — `directive` is narrative-only and may be stale.',
      };
    }

    case 'get_pipeline_status': {
      const channel = input.channel || 'all';

      if (channel === 'catering') {
        const stats = await env.DB.prepare(`
          SELECT status, COUNT(*) as count
          FROM catering_leads
          GROUP BY status ORDER BY count DESC
        `).all();
        const recent = await env.DB.prepare(`
          SELECT cl.name, cl.industry, cl.status, cl.last_contacted,
                 o.sent_at, o.self_score, o.agent_reasoning
          FROM catering_leads cl
          LEFT JOIN catering_outreach_logs o ON o.lead_id = cl.id AND o.sequence_step = 1
          ORDER BY cl.created_at DESC LIMIT 5
        `).all();
        return { channel: 'catering', stats: stats.results, recent: recent.results };
      }

      const venueQuery = input.category
        ? `SELECT status, tier, category, COUNT(*) as count FROM venues WHERE category = ? GROUP BY status, tier`
        : `SELECT status, tier, COUNT(*) as count FROM venues GROUP BY status, tier ORDER BY count DESC`;

      const stats = input.category
        ? await env.DB.prepare(venueQuery).bind(input.category).all()
        : await env.DB.prepare(venueQuery).all();

      const holds = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM outreach_holds WHERE active = 1 AND expires_at > datetime('now')"
      ).first();

      const drewFlags = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM venues WHERE status = 'drew_flag'"
      ).first();

      return {
        channel: 'wholesale',
        by_status: stats.results,
        active_holds: holds?.count || 0,
        drew_flags: drewFlags?.count || 0,
      };
    }

    case 'get_account_details': {
      let query = `
        SELECT v.name, v.category, v.city,
               aa.health_status, aa.churn_risk, aa.last_order_date,
               aa.avg_monthly_rev, aa.total_rev_lifetime,
               aa.consecutive_missed, aa.fulfilled_by,
               julianday('now') - julianday(aa.last_order_date) as days_since_order
        FROM active_accounts aa
        JOIN venues v ON v.id = aa.venue_id
        WHERE aa.warmer_removed_at IS NULL
      `;
      const params = [];

      if (input.venue_name) {
        query += ` AND v.name LIKE ?`;
        params.push(`%${input.venue_name}%`);
      }
      if (input.status_filter && input.status_filter !== 'all') {
        query += ` AND aa.health_status = ?`;
        params.push(input.status_filter);
      }
      query += ` ORDER BY aa.health_status ASC, days_since_order DESC LIMIT 20`;

      const accounts = params.length > 0
        ? await env.DB.prepare(query).bind(...params).all()
        : await env.DB.prepare(query).all();

      return { accounts: accounts.results || [] };
    }

    case 'explain_agent_decision': {
      // Look up venue in D1 for notes + status
      const venue = await env.DB.prepare(`
        SELECT v.name, v.status, v.notes, v.qual_summary, v.tier,
               o.reason as hold_reason, o.expires_at, o.resume_note
        FROM venues v
        LEFT JOIN outreach_holds o ON o.venue_id = v.id AND o.active = 1
        WHERE v.name LIKE ?
        LIMIT 1
      `).bind(`%${input.venue_name}%`).first();

      // Check outreach logs
      const logs = venue ? await env.DB.prepare(`
        SELECT sequence_step, channel, sent_at, opened_at, replied_at,
               outcome, agent_reasoning, self_score
        FROM outreach_logs
        WHERE venue_id = (SELECT id FROM venues WHERE name LIKE ? LIMIT 1)
        ORDER BY created_at DESC LIMIT 5
      `).bind(`%${input.venue_name}%`).all() : { results: [] };

      // Check KV for reasoning log
      let reasoning = null;
      if (venue) {
        try {
          const venueId = await env.DB.prepare(
            'SELECT id FROM venues WHERE name LIKE ? LIMIT 1'
          ).bind(`%${input.venue_name}%`).first();
          if (venueId?.id) {
            const keys = await env.KV.list({ prefix: `reasoning:${venueId.id}:` });
            if (keys.keys.length > 0) {
              const latest = await env.KV.get(keys.keys[keys.keys.length - 1].name);
              if (latest) reasoning = JSON.parse(latest);
            }
          }
        } catch {}
      }

      return {
        venue: venue || null,
        outreach_history: logs.results || [],
        agent_reasoning: reasoning,
        not_found: !venue,
      };
    }

    case 'get_optimizer_history': {
      const agent = input.agent_name;
      const limit = input.limit || 5;

      const query = agent
        ? 'SELECT * FROM agent_prompts WHERE agent_name = ? ORDER BY version DESC LIMIT ?'
        : 'SELECT * FROM agent_prompts ORDER BY updated_at DESC LIMIT ?';

      const prompts = agent
        ? await env.DB.prepare(query).bind(agent, limit).all()
        : await env.DB.prepare(query).bind(limit).all();

      const metrics = await env.DB.prepare(`
        SELECT week_start, open_rate, reply_rate, close_rate,
               catering_reply_rate, optimizer_notes
        FROM performance_metrics
        ORDER BY week_start DESC LIMIT 4
      `).all();

      return {
        prompt_versions: prompts.results || [],
        performance_trend: metrics.results || [],
      };
    }

    case 'get_retail_intelligence': {
      const detail = input.detail || 'segments';

      if (detail === 'segments') {
        const segments = await env.DB.prepare(`
          SELECT segment, COUNT(*) as count,
                 AVG(total_lifetime_value) as avg_ltv,
                 AVG(visit_count) as avg_visits,
                 AVG(avg_items_per_order) as avg_items
          FROM retail_customers
          GROUP BY segment ORDER BY count DESC
        `).all();
        return { segments: segments.results };
      }

      if (detail === 'lapsed') {
        const lapsed = await env.DB.prepare(`
          SELECT first_name, visit_count, last_visit_date,
                 total_lifetime_value, favorite_sku, reengagement_sent_at
          FROM retail_customers
          WHERE segment = 'lapsed'
          ORDER BY total_lifetime_value DESC LIMIT 20
        `).all();
        return { lapsed_customers: lapsed.results };
      }

      if (detail === 'crossovers') {
        const crossovers = await env.DB.prepare(`
          SELECT rc.first_name, rc.visit_count, rc.largest_single_order,
                 rc.total_lifetime_value, cl.status as catering_status
          FROM retail_customers rc
          LEFT JOIN catering_leads cl ON cl.id = rc.catering_lead_id
          WHERE rc.catering_flagged = 1
          ORDER BY rc.largest_single_order DESC
        `).all();
        return { crossover_leads: crossovers.results };
      }

      if (detail === 'recent_insight') {
        const insight = await env.KV.get('retail_weekly_insight');
        return { insight: insight ? JSON.parse(insight) : null };
      }

      // SKUs / orders summary
      const orders = await env.DB.prepare(`
        SELECT
          SUM(gross_revenue) as total_revenue,
          COUNT(*) as order_count,
          AVG(gross_revenue) as avg_order,
          AVG(units) as avg_units,
          MIN(order_date) as first_order,
          MAX(order_date) as last_order
        FROM orders
        WHERE source IN ('toast', 'square')
          AND order_date >= date('now', '-30 days')
      `).first();
      return { last_30_days: orders };
    }

    case 'get_pending_approvals': {
      const channel = input.channel || 'all';
      const results = {};

      if (channel === 'all' || channel === 'wholesale') {
        const wholesale = await env.DB.prepare(`
          SELECT o.id, o.subject, o.body, o.self_score, o.agent_reasoning,
                 o.created_at, v.name as venue_name, v.category
          FROM outreach_logs o
          JOIN venues v ON v.id = o.venue_id
          WHERE o.approval_status = 'pending'
          ORDER BY o.self_score DESC LIMIT 5
        `).all();
        results.wholesale = wholesale.results || [];
      }

      if (channel === 'all' || channel === 'catering') {
        const catering = await env.DB.prepare(`
          SELECT o.id, o.subject, o.body, o.self_score, o.agent_reasoning,
                 o.created_at, cl.name as company_name, cl.industry
          FROM catering_outreach_logs o
          JOIN catering_leads cl ON cl.id = o.lead_id
          WHERE o.approval_status = 'pending'
          ORDER BY o.self_score DESC LIMIT 5
        `).all();
        results.catering = catering.results || [];
      }

      return results;
    }

    case 'run_whatif_scenario': {
      const { scenario_type, assumptions } = input;

      // Pull current financial state for context
      const directive = await env.DB.prepare(
        'SELECT * FROM financial_directives WHERE active = 1 LIMIT 1'
      ).first();

      const accountStats = await env.DB.prepare(`
        SELECT COUNT(*) as count, SUM(avg_monthly_rev) as monthly_rev
        FROM active_accounts WHERE warmer_removed_at IS NULL
      `).first();

      // Canonical numbers override stale directive values
      const [canonRunway, canonRevenue] = await Promise.all([
        getCanonicalRunway(env).catch(() => null),
        getCanonicalWeeklyRevenue(env, 7).catch(() => null),
      ]);

      const context = {
        current_weekly_revenue: canonRevenue?.total ?? directive?.total_revenue_week ?? 0,
        current_cash_runway: canonRunway?.weeks ?? directive?.cash_runway_weeks ?? null,
        current_cash_on_hand: canonRunway?.cash ?? directive?.cash_on_hand ?? null,
        active_accounts: accountStats?.count || 0,
        current_monthly_wholesale: accountStats?.monthly_rev || 0,
        catering_margin_pct: directive?.catering_margin_pct || null,
        wholesale_margin_pct: directive?.wholesale_margin_pct || null,
        retail_margin_pct: directive?.retail_margin_pct || null,
      };

      return {
        scenario_type,
        assumptions,
        current_state: context,
        note: 'Use this data to model the scenario accurately. Show current vs projected numbers clearly.',
      };
    }

    case 'get_pilot_status': {
      const pilot = await env.KV.get('pilot_milestones');
      const alerts = await env.KV.get('pilot_alerts');

      const storeOrders = await env.DB.prepare(`
        SELECT account_id, SUM(units) as total_units, SUM(gross_revenue) as revenue,
               COUNT(*) as orders, MAX(order_date) as last_order
        FROM orders
        WHERE source = 'twisted_sugar_pilot'
          AND order_date >= date('now', '-7 days')
        GROUP BY account_id
      `).all();

      return {
        store_data: storeOrders.results || [],
        milestones: pilot ? JSON.parse(pilot) : null,
        alerts: alerts ? JSON.parse(alerts) : null,
      };
    }

    case 'get_open_flags': {
      const severity = input.severity || 'all';
      const query = severity === 'all'
        ? "SELECT * FROM financial_flags WHERE status = 'open' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC"
        : "SELECT * FROM financial_flags WHERE status = 'open' AND severity = ? ORDER BY created_at DESC";

      const flags = severity === 'all'
        ? await env.DB.prepare(query).all()
        : await env.DB.prepare(query).bind(severity).all();

      return { flags: flags.results || [] };
    }

    case 'search_venues': {
      const { query, status, limit = 10 } = input;

      let sql = 'SELECT name, category, status, tier, city, last_contacted FROM venues WHERE 1=1';
      const params = [];

      if (query) {
        sql += ' AND (name LIKE ? OR category LIKE ?)';
        params.push(`%${query}%`, `%${query}%`);
      }
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }
      sql += ` ORDER BY created_at DESC LIMIT ${Math.min(limit, 50)}`;

      const venues = params.length > 0
        ? await env.DB.prepare(sql).bind(...params).all()
        : await env.DB.prepare(sql).all();

      return { venues: venues.results || [], count: venues.results?.length || 0 };
    }

    case 'get_weekly_summary': {
      const [metrics, directive, accounts, retail, canonCash, canonRunway, canonRevenue] = await Promise.all([
        env.DB.prepare(
          'SELECT * FROM performance_metrics ORDER BY week_start DESC LIMIT 1'
        ).first(),
        env.DB.prepare(
          'SELECT executive_summary, priority_actions, wholesale_revenue_week, retail_revenue_week, catering_revenue_week, total_revenue_week FROM financial_directives WHERE active = 1 LIMIT 1'
        ).first(),
        env.DB.prepare(
          "SELECT COUNT(*) as total, SUM(CASE WHEN health_status = 'green' THEN 1 ELSE 0 END) as green, SUM(CASE WHEN health_status != 'green' THEN 1 ELSE 0 END) as at_risk FROM active_accounts WHERE warmer_removed_at IS NULL"
        ).first(),
        env.DB.prepare(
          "SELECT COUNT(*) as count, SUM(CASE WHEN segment = 'lapsed' THEN 1 ELSE 0 END) as lapsed FROM retail_customers"
        ).first(),
        getCanonicalCashOnHand(env).catch(() => null),
        getCanonicalRunway(env).catch(() => null),
        getCanonicalWeeklyRevenue(env, 7).catch(() => null),
      ]);

      // Override directive numbers with canonical (live) values
      const financialOverride = directive ? { ...directive } : {};
      if (canonRevenue) {
        financialOverride.wholesale_revenue_week = canonRevenue.wholesale?.revenue ?? financialOverride.wholesale_revenue_week;
        financialOverride.retail_revenue_week = canonRevenue.retail?.revenue ?? financialOverride.retail_revenue_week;
        financialOverride.catering_revenue_week = canonRevenue.catering?.revenue ?? financialOverride.catering_revenue_week;
        financialOverride.total_revenue_week = canonRevenue.total ?? financialOverride.total_revenue_week;
      }
      if (canonCash) financialOverride.cash_on_hand = canonCash.total;
      if (canonRunway) financialOverride.cash_runway_weeks = canonRunway.weeks;
      financialOverride._numbers_source = 'canonical (live), narrative from directive';

      return {
        financial: financialOverride,
        canonical: { cash: canonCash, runway: canonRunway, revenue: canonRevenue },
        performance: metrics,
        accounts: accounts,
        retail: retail,
      };
    }

    // ───── Session 4 CFO tools ─────
    case 'get_breakeven': {
      const { getBreakeven } = await import('./finance-breakeven.js');
      return getBreakeven(env, { lookback_days: input.lookback_days || 90 });
    }

    case 'get_trends': {
      const { getTrends } = await import('./finance-trends.js');
      return getTrends(env, { months: input.months || 12 });
    }

    case 'run_scenario': {
      const { runScenario } = await import('./finance-scenario.js');
      return runScenario(env, input);
    }

    case 'get_customer_intel': {
      const { getCustomerIntel } = await import('./finance-customer-intel.js');
      return getCustomerIntel(env, { limit: input.limit || 25 });
    }

    case 'get_customer_profile': {
      if (!input.customer) return { error: 'customer name required' };
      const { getCustomerProfile } = await import('./finance-customer-intel.js');
      return getCustomerProfile(env, input.customer);
    }

    case 'get_vendor_history': {
      if (!input.vendor) return { error: 'vendor name required' };
      const { lookupVendor } = await import('./finance-vendor-kb.js');
      return lookupVendor(env, input.vendor);
    }

    case 'get_finance_scorecard': {
      const { getScorecard } = await import('./finance-scorecard.js');
      return getScorecard(env);
    }

    case 'get_monthly_pl': {
      const { getMonthlyPL, getMonthlyPLQuad } = await import('./finance-monthly-pl.js');
      if (input.period) return getMonthlyPL(env, input.period);
      return getMonthlyPLQuad(env);
    }

    case 'get_pnl_statement': {
      const { getPnLStatement } = await import('./finance-statements-pnl.js');
      const period = input.period || 'ytd';
      return getPnLStatement(env, period, {
        year: input.year,
        month: input.month,
        quarter: input.quarter,
        start: input.start,
        end: input.end,
        compare_to: input.compare_to || 'none',
      });
    }

    case 'get_balance_sheet': {
      const { getBalanceSheet } = await import('./finance-statements-balance-sheet.js');
      const asOf = input.as_of || new Date().toISOString().slice(0, 10);
      return getBalanceSheet(env, asOf, input.compare_to || 'none');
    }

    case 'get_cash_flow_statement': {
      const { getCashFlowStatement } = await import('./finance-statements-cash-flow.js');
      let start = input.start;
      let end = input.end;
      if (input.period === 'year' && input.year) {
        start = `${input.year}-01-01`;
        end = `${input.year}-12-31`;
      } else if (input.period === 'ytd') {
        const y = input.year || new Date().getUTCFullYear();
        start = `${y}-01-01`;
        end = new Date().toISOString().slice(0, 10);
      }
      if (!start || !end) return { error: 'start + end required (or period=year&year= or period=ytd)' };
      return getCashFlowStatement(env, start, end);
    }

    case 'explain_pnl_line': {
      const { explainPnLLine } = await import('./finance-statements-pnl.js');
      if (!input.account_id || !input.start || !input.end) return { error: 'account_id, start, end required' };
      return explainPnLLine(env, input.account_id, input.start, input.end);
    }

    case 'explain_balance_change': {
      const { explainBalanceChange } = await import('./finance-statements-balance-sheet.js');
      if (!input.account_id || !input.from || !input.to) return { error: 'account_id, from, to required' };
      return explainBalanceChange(env, input.account_id, input.from, input.to);
    }

    case 'get_ar_aging': {
      const { getArAging } = await import('./finance-ar-aging.js');
      return getArAging(env);
    }

    case 'get_open_issues': {
      const { listIssues } = await import('./finance-issue-surfacer.js');
      return listIssues(env, { severity: input.severity });
    }

    case 'record_cfo_fact': {
      if (!input.fact_type || !input.subject || !input.content) {
        return { error: 'fact_type, subject, content all required' };
      }
      const { recordFact } = await import('./finance-cfo-facts.js');
      return recordFact(env, {
        fact_type: input.fact_type,
        subject: input.subject,
        content: input.content,
        structured_data: input.structured_data || null,
        source: 'drew_chat',
        confidence: 1.0,
      });
    }

    case 'lookup_cfo_facts': {
      if (!input.subject) return { error: 'subject required' };
      const { lookupFacts } = await import('./finance-cfo-facts.js');
      return lookupFacts(env, input.subject, input.fact_type || null);
    }

    default:
      return { error: `Unknown chat tool: ${toolName}` };
  }
}
