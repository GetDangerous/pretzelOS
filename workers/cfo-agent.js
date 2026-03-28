/**
 * Dangerous Pretzel Co — CFO Agent
 * Cloudflare Worker (cron: Sunday 10pm MT — before Optimizer at 11pm)
 *
 * SUPERVISOR AGENT — reads outputs of all other agents + QBO financials.
 * Writes a financial_directive that every agent reads before Monday runs.
 * Strictly advisory — generates actions for Drew, never executes them.
 *
 * Architecture:
 *   1. Pull QBO data DIRECTLY via Intuit REST API (no Make, no middleware)
 *   2. Pull D1 operational data (all three revenue channels)
 *   3. Agent reasoning loop — Claude calls tools, builds analysis
 *   4. Write financial_directive to D1 (inter-agent coordination)
 *   5. Create financial_flags for Drew (escalations)
 *   6. Send CFO brief via Gmail (first section of Monday digest)
 *
 * QBO data quality note:
 *   COGS is currently a single expense line — margin analysis uses
 *   revenue-share allocation as proxy. Will improve as QBO data matures.
 *   Payroll is external (Toast/Square Payroll) — excluded from analysis.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   QBO_CLIENT_ID          — from developer.intuit.com
 *   QBO_CLIENT_SECRET      — from developer.intuit.com
 *   QBO_REFRESH_TOKEN      — from OAuth flow (see qbo-client.js setup notes)
 *   QBO_REALM_ID           — QBO company ID (in your QBO URL)
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL
 *   DREW_EMAIL
 *   DB, KV
 */

import {
  getProfitAndLoss,
  getCashFlow,
  getARaging,
  getExpenses,
  getBalanceSheet,
  getTransactions,
  getEstimates,
  getInvoices,
  getCustomerBalances,
  extractPLNumbers,
  extractCashPosition,
  extractAROverdue,
} from './qbo-client.js';
import { loadBrain } from './brain-loader.js';

const MAX_AGENT_LOOPS = 10;  // CFO needs more rounds — it's thorough
const CASH_RUNWAY_ALERT_WEEKS = 8;
const AR_OVERDUE_DAYS = 30;
const EXPENSE_SPIKE_PCT = 0.15;  // 15% above 4-week avg = flag
const REVENUE_VARIANCE_THRESHOLD = 0.05;  // 5% QBO vs Toast mismatch = flag

// ── CFO TOOL DEFINITIONS ──────────────────────────────────────────────────────
const CFO_TOOLS = [
  {
    name: 'fetch_qbo_profit_loss',
    description: 'Fetch the Profit & Loss statement from QuickBooks Online (direct API). Get current week and prior 4 weeks for trend analysis. Returns revenue, COGS, gross profit, operating expenses, and net income.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        compare_periods: { type: 'number', description: 'Number of prior periods to compare (default 4)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'fetch_qbo_cash_flow',
    description: 'Fetch current cash position and cash flow statement from QBO. Returns bank account balances, cash in/out for the period.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
        end_date:   { type: 'string' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'fetch_qbo_ar_aging',
    description: 'Fetch Accounts Receivable aging report from QBO. Returns all outstanding invoices grouped by age bucket: current, 1-30 days, 31-60 days, 60+ days. Use to identify overdue wholesale accounts.',
    input_schema: {
      type: 'object',
      properties: {
        as_of_date: { type: 'string', description: 'As-of date for aging YYYY-MM-DD' },
      },
      required: ['as_of_date'],
    },
  },
  {
    name: 'fetch_qbo_expenses',
    description: 'Fetch expense breakdown from QBO by category. Returns each expense category with current week amount and prior 4-week average. Use to detect anomalies.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
        end_date:   { type: 'string' },
        prior_weeks: { type: 'number', description: 'Prior weeks to average for comparison (default 4)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'fetch_qbo_transactions',
    description: 'Fetch raw transaction data from QBO for a period. Useful for spotting uncategorized items, unusual vendors, or validating revenue entries.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string' },
        end_date:   { type: 'string' },
        account_type: { type: 'string', description: 'Optional: income | expense | asset | liability' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'get_d1_channel_revenue',
    description: 'Get revenue breakdown from D1 for all three channels (retail/wholesale/catering) for the current week. This is the operational source — reconcile against QBO.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Days to look back (default 7)' },
      },
    },
  },
  {
    name: 'get_d1_account_health',
    description: 'Get health status of all active wholesale accounts from D1. Returns account name, last order date, estimated monthly revenue, and any overdue flags.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_agent_performance_summary',
    description: 'Get last week\'s performance metrics from D1 — what did each agent accomplish, what are the trends, where is the pipeline.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'calculate_channel_margins',
    description: 'Given revenue and COGS data from QBO and D1, calculate estimated gross margin % for each channel. Uses revenue-share allocation for COGS since QBO tracks COGS as single line. Note: pre-payroll margins only.',
    input_schema: {
      type: 'object',
      properties: {
        total_revenue: { type: 'number' },
        retail_revenue: { type: 'number' },
        wholesale_revenue: { type: 'number' },
        catering_revenue: { type: 'number' },
        total_cogs: { type: 'number' },
        other_context: { type: 'string', description: 'Any additional context affecting margin estimates' },
      },
      required: ['total_revenue', 'total_cogs'],
    },
  },
  {
    name: 'assess_cash_runway',
    description: 'Calculate cash runway given current cash position, weekly burn rate, and revenue run rate. Model three scenarios: flat, 10% growth, 10% decline.',
    input_schema: {
      type: 'object',
      properties: {
        current_cash: { type: 'number' },
        weekly_burn:  { type: 'number' },
        weekly_revenue: { type: 'number' },
      },
      required: ['current_cash', 'weekly_burn', 'weekly_revenue'],
    },
  },
  {
    name: 'fetch_qbo_estimates',
    description: 'Fetch estimates (quotes) from QBO. Pending estimates = upcoming revenue not yet invoiced. Converted = already on an invoice. Use to forecast near-term wholesale revenue.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: pending | accepted | converted | null for all' },
        max_results: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'fetch_qbo_invoices',
    description: 'Fetch invoices from QBO. Shows unpaid balances, due dates, payment methods, and which accounts can auto-pay (CC/ACH enabled). Critical for cash flow forecasting.',
    input_schema: {
      type: 'object',
      properties: {
        unpaid_only: { type: 'boolean', description: 'Only show invoices with balance > 0' },
        recent_days: { type: 'number', description: 'Only invoices updated in last N days (default 30)' },
        max_results: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'fetch_qbo_customer_balances',
    description: 'Fetch all customers with outstanding balances from QBO. Shows who owes money, contact info, and payment method on file. Use alongside AR aging for collections prioritization.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'write_financial_directive',
    description: 'Write the weekly financial directive to D1. This is the inter-agent coordination output — every other agent reads this before their Monday run. Be specific and actionable in each directive.',
    input_schema: {
      type: 'object',
      properties: {
        wholesale_priority:   { type: 'number', description: '1=highest, 3=lowest priority this week' },
        retail_priority:      { type: 'number' },
        catering_priority:    { type: 'number' },
        outreach_directive:   { type: 'string', description: 'Specific guidance for outreach/wholesale agent' },
        retail_directive:     { type: 'string', description: 'Specific guidance for retail agent' },
        catering_directive:   { type: 'string', description: 'Specific guidance for catering agent' },
        optimizer_directive:  { type: 'string', description: 'Which channel optimizer should prioritize' },
        overdue_accounts:     { type: 'string', description: 'JSON array of overdue accounts for account agent' },
        cash_runway_weeks:    { type: 'number' },
        cash_alert:           { type: 'number', description: '1 if runway < 8 weeks' },
        cogs_alert:           { type: 'number', description: '1 if COGS spike detected' },
        growth_brake:         { type: 'number', description: '1 if CFO recommends slowing expansion' },
        wholesale_margin_pct: { type: 'number' },
        retail_margin_pct:    { type: 'number' },
        catering_margin_pct:  { type: 'number' },
        wholesale_revenue_week: { type: 'number' },
        retail_revenue_week:    { type: 'number' },
        catering_revenue_week:  { type: 'number' },
        executive_summary:    { type: 'string', description: '3-4 sentences: state of the business in plain English' },
        priority_actions:     { type: 'string', description: 'JSON array of priority actions for Drew' },
        opportunities:        { type: 'string', description: 'JSON array of opportunities spotted in the data' },
      },
      required: ['executive_summary', 'priority_actions'],
    },
  },
  {
    name: 'create_financial_flag',
    description: 'Create a specific financial flag for Drew to act on. Each flag = one discrete action item. Use for: overdue AR, COGS spike, cash concern, expense anomaly, growth opportunity.',
    input_schema: {
      type: 'object',
      properties: {
        flag_type: {
          type: 'string',
          description: 'overdue_ar | cogs_spike | cash_low | revenue_variance | margin_decline | expense_anomaly | growth_opportunity | channel_insight',
        },
        severity: { type: 'string', description: 'critical | high | medium | low' },
        channel:  { type: 'string', description: 'wholesale | retail | catering | all' },
        entity_name: { type: 'string', description: 'Account/venue name if applicable' },
        title:    { type: 'string', description: 'One-line summary — what Drew sees first' },
        detail:   { type: 'string', description: 'Full explanation with the specific number' },
        data_point: { type: 'string', description: 'The specific number or stat that triggered this flag' },
        suggested_action: { type: 'string', description: 'Exactly what Drew should do — specific and actionable' },
      },
      required: ['flag_type', 'severity', 'title', 'detail', 'suggested_action'],
    },
  },
];

// ── CFO SYSTEM PROMPT ─────────────────────────────────────────────────────────
const CFO_SYSTEM_PROMPT = `You are the CFO agent for Dangerous Pretzel Co — a premium Salt Lake City soft pretzel brand.

YOUR MANDATE: You are the only agent in this system with visibility across all financial data. You are a supervisor, not a peer. Your weekly analysis shapes what every other agent does on Monday morning. Take this seriously.

ABOUT THE BUSINESS:
- Three revenue channels: retail (shop at 352 W 600 S), wholesale (warmer program), catering (corporate events)
- Wholesale anchor accounts: Delta Center (NBA Jazz), Powder Mountain, Alta Ski, SLC Bees, Union Event Center, Pioneer Theater, 4 breweries
- Retail: daily Toast POS feed, switching to Square soon
- Catering: growing, highest margin channel
- Distribution: self-delivery SLC, US Foods listing live, PFG Denver onboarded
- Twisted Sugar: 5-store pilot underway
- Payroll: external via Toast/Square Payroll — NOT available in your analysis. Pre-payroll gross margins only.

DATA SOURCES YOU CAN ACCESS:
- QuickBooks Online: P&L, cash flow, AR aging, expenses, transactions, estimates (pending revenue), invoices (with payment method + auto-pay status), customer balances
- D1 database: all three channels of operational revenue + account health
- Performance metrics: what each agent accomplished this week

HOW TO APPROACH THE ANALYSIS:
1. Always start with fetch_qbo_profit_loss and get_d1_channel_revenue — these are your foundation
2. Reconcile QBO vs D1 revenue. A variance >5% means something isn't categorized correctly in QBO or there's a data gap
3. COGS is a single line in QBO right now — allocate by revenue share as proxy. Note this limitation explicitly.
4. Use fetch_qbo_ar_aging to find overdue wholesale accounts. These are operational risks, not just accounting issues.
5. Use fetch_qbo_invoices (unpaid_only=true) to see exactly who owes what and when it's due. Note which accounts have CC/ACH auto-pay enabled vs those that need chasing.
6. Use fetch_qbo_estimates to see pending wholesale orders not yet invoiced — this is your near-term revenue forecast.
7. Use fetch_qbo_customer_balances for a full picture of outstanding receivables with contact info.
8. Use fetch_qbo_expenses to find anomalies — anything 15%+ above 4-week average deserves a flag
9. Use assess_cash_runway to model three scenarios. This is Drew's most important number.
10. calculate_channel_margins gives you the strategic insight: which channel deserves more investment?
11. Write the directive LAST — after you understand the full picture

WHAT YOU DON'T DO:
- You do not send emails to customers or vendors
- You do not modify any financial records
- You do not make payments or initiate transfers
- You do not directly instruct agents to contact specific people
- You advise Drew and write directives. Drew and the agents execute.

WHAT GOOD ANALYSIS LOOKS LIKE:
Bad: "Revenue was $12,400 this week."
Good: "Revenue was $12,400 — up 18% WoW driven by a Delta Center event on Saturday. Catering contributed $2,800 (22.6% of total) at an estimated 68% gross margin vs wholesale at ~41%. If catering maintains this pace, it becomes the highest-revenue channel by Q3."

Bad: "ROHA Brewing is 32 days overdue."
Good: "ROHA Brewing: $840 outstanding, 32 days overdue. This account placed no new orders in 28 days either — possible churn risk. Recommend Drew call before sending account agent check-in. A collections conversation and a retention conversation should happen simultaneously."

TONE: You are a sharp CFO who has advised many small businesses. You see patterns in numbers that others miss. You are specific, direct, and occasionally blunt. You never pad your analysis with vague observations. Every sentence either reports a specific number, explains what it means, or recommends a specific action.`;

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCFOAgent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/cfo/run') {
      try {
        const result = await runCFOAgent(env);
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        await env.KV.put('cfo_last_error', JSON.stringify({
          error: err.message,
          stack: err.stack,
          at: new Date().toISOString(),
        }));
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    if (path === '/cfo/debug') {
      const lastError = await env.KV.get('cfo_last_error');
      const hasKey = !!env.ANTHROPIC_API_KEY;
      const hasQBO = !!env.QBO_CLIENT_ID;
      return new Response(JSON.stringify({
        anthropic_key_set: hasKey,
        anthropic_key_preview: hasKey ? env.ANTHROPIC_API_KEY.slice(0, 10) + '...' : null,
        qbo_client_id_set: hasQBO,
        last_error: lastError ? JSON.parse(lastError) : null,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    // Synchronous test — single Claude call to verify API works
    if (path === '/cfo/test-claude') {
      try {
        const resp = await callClaudeWithTools(env.ANTHROPIC_API_KEY, 'You are a test.', [
          { role: 'user', content: 'Say "CFO online" in exactly two words.' }
        ]);
        return new Response(JSON.stringify({
          status: 'ok',
          stop_reason: resp.stop_reason,
          content: resp.content,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    // Instant revenue refresh — updates the directive's revenue numbers from D1 without a full CFO run
    if (path === '/cfo/refresh') {
      try {
        const days = 7;
        const [retail, wholesale, catering] = await Promise.all([
          env.DB.prepare(`
            SELECT COALESCE(SUM(gross_revenue), 0) as revenue, COUNT(*) as cnt
            FROM orders
            WHERE (source LIKE 'toast%' AND source != 'toast_catering')
              AND order_date >= date('now', '-${days} days')
          `).first(),
          env.DB.prepare(`
            SELECT COALESCE(SUM(gross_revenue), 0) as revenue, COUNT(*) as cnt
            FROM orders
            WHERE source IN ('qbo_wholesale', 'qbo_invoice', 'qbo_estimate')
              AND order_date >= date('now', '-${days} days')
          `).first(),
          env.DB.prepare(`
            SELECT COALESCE(SUM(gross_revenue), 0) as rev1 FROM orders
            WHERE source = 'toast_catering' AND order_date >= date('now', '-${days} days')
          `).first(),
        ]);

        const retailRev = retail?.revenue || 0;
        const wholesaleRev = wholesale?.revenue || 0;
        const cateringRev = catering?.rev1 || 0;
        const total = retailRev + wholesaleRev + cateringRev;

        // Update the active directive with fresh numbers
        await env.DB.prepare(`
          UPDATE financial_directives
          SET retail_revenue_week = ?, wholesale_revenue_week = ?, catering_revenue_week = ?,
              total_revenue_week = ?
          WHERE active = 1
        `).bind(retailRev, wholesaleRev, cateringRev, total).run();

        return new Response(JSON.stringify({
          refreshed: true,
          retail: retailRev,
          wholesale: wholesaleRev,
          catering: cateringRev,
          total,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }
    if (path === '/cfo/directive') {
      return getActiveDirective(env);
    }
    if (path === '/cfo/flags') {
      return getOpenFlags(env);
    }
    if (path === '/cfo/flags/resolve' && request.method === 'POST') {
      const body = await request.json();
      return resolveFlag(body.flag_id, body.note, env);
    }
    if (path === '/cfo/reports') {
      return getReportHistory(env);
    }
    if (path === '/cfo/brief') {
      return getLatestBrief(env);
    }
    if (path === '/cfo/sync-accounts') {
      try {
        await syncQBOAccountData(env);
        const accts = await env.DB.prepare(`
          SELECT aa.id, v.name, aa.last_order_date, aa.avg_monthly_rev, aa.total_rev_lifetime
          FROM active_accounts aa JOIN venues v ON v.id = aa.venue_id
          ORDER BY aa.total_rev_lifetime DESC
        `).all();
        return new Response(JSON.stringify(accts.results, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return new Response('CFO Agent — Pretzel OS', { status: 200 });
  }
};

// ── MAIN RUN ──────────────────────────────────────────────────────────────────
async function runCFOAgent(env) {
  // ── BUSINESS BRAIN ────────────────────────────────────────────────────────
  const brainContext = await loadBrain(env, 'cfo');
  console.log('[CFO] Brain loaded:', brainContext ? brainContext.split('\n').length + ' lines' : 'empty');

  console.log('[CFO] Starting weekly analysis...');

  const today = new Date();
  const weekStart = getMonday(today);
  const weekEnd   = today.toISOString().split('T')[0];

  // Build initial context message
  const messages = [
    {
      role: 'user',
      content: `Run the weekly financial analysis for Dangerous Pretzel Co.

Week: ${weekStart} to ${weekEnd}
Today: ${today.toISOString()}

Start with fetch_qbo_profit_loss for this week, then get_d1_channel_revenue, then work through the full analysis. Be thorough — this analysis shapes what every other agent does on Monday morning.

When you have a complete picture, use write_financial_directive to save it, create_financial_flag for each specific escalation, then finish.`
    }
  ];

  let reportId = crypto.randomUUID();
  let toolResults = [];
  let directiveWritten = false;
  let flagsCreated = 0;
  let loops = 0;

  // ── AGENT LOOP ─────────────────────────────────────────────────────────────
  while (loops < MAX_AGENT_LOOPS) {
    loops++;

    const response = await callClaudeWithTools(env.ANTHROPIC_API_KEY, CFO_SYSTEM_PROMPT + '\n\n' + brainContext, messages);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      console.log('[CFO] Agent completed analysis');
      break;
    }

    // Handle any response that contains tool_use blocks (regardless of stop_reason)
    const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      const toolResultContents = [];

      for (const toolUse of toolUseBlocks) {
        let result;
        try {
          result = await executeTool(toolUse.name, toolUse.input, reportId, weekStart, env);
        } catch (err) {
          result = { error: `Tool ${toolUse.name} failed: ${err.message}` };
          console.error(`[CFO] Tool error (${toolUse.name}):`, err.message);
        }
        toolResults.push({ tool: toolUse.name, result });

        if (toolUse.name === 'write_financial_directive') directiveWritten = true;
        if (toolUse.name === 'create_financial_flag') flagsCreated++;

        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResultContents });
    } else {
      // No tool_use blocks and not end_turn — stop_reason is max_tokens or unknown
      console.log(`[CFO] Unexpected stop_reason: ${response.stop_reason}, breaking loop`);
      break;
    }
  }

  // Save full report to D1
  const agentText = messages
    .filter(m => m.role === 'assistant')
    .flatMap(m => (Array.isArray(m.content) ? m.content : [m.content]))
    .filter(b => b?.type === 'text')
    .map(b => b.text)
    .join('\n\n');

  await env.DB.prepare(`
    INSERT OR REPLACE INTO cfo_reports (
      id, week_start,
      strategic_assessment,
      recommended_actions,
      notes,
      created_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    reportId,
    weekStart,
    agentText.slice(0, 5000),
    JSON.stringify(toolResults.filter(t => t.tool === 'create_financial_flag')),
    `Tools used: ${toolResults.map(t => t.tool).join(', ')}`
  ).run();

  // Sync QBO invoice data → D1 active_accounts (backfill order history)
  try {
    await syncQBOAccountData(env);
    console.log('[CFO] QBO → D1 account sync complete');
  } catch (err) {
    console.error('[CFO] Account sync failed:', err.message);
  }

  // Send CFO brief to Drew
  await sendCFOBrief(weekStart, env);

  console.log(`[CFO] Complete. Directive: ${directiveWritten}, Flags: ${flagsCreated}`);
  return { directive_written: directiveWritten, flags_created: flagsCreated, report_id: reportId };
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(toolName, input, reportId, weekStart, env) {
  switch (toolName) {

    // ── QBO TOOLS (via Make MCP) ─────────────────────────────────────────────
    case 'fetch_qbo_profit_loss': {
      const raw = await getProfitAndLoss(env, input.start_date, input.end_date);
      const parsed = extractPLNumbers(raw);
      return { raw_report: raw, parsed, week: `${input.start_date} to ${input.end_date}` };
    }

    case 'fetch_qbo_cash_flow': {
      const raw = await getCashFlow(env, input.start_date, input.end_date);
      const cash = extractCashPosition(raw);
      return { cash_position: cash, raw_report: raw };
    }

    case 'fetch_qbo_ar_aging': {
      const raw = await getARaging(env, input.as_of_date);
      const overdue = extractAROverdue(raw);
      return { overdue_accounts: overdue, total_overdue: overdue.reduce((s, a) => s + a.total_overdue, 0) };
    }

    case 'fetch_qbo_expenses': {
      const raw = await getExpenses(env, input.start_date, input.end_date);
      const parsed = extractPLNumbers(raw);
      return { expenses_by_category: parsed.expense_by_category, total_expenses: parsed.total_expenses };
    }

    case 'fetch_qbo_transactions': {
      return await getTransactions(env, input.start_date, input.end_date, input.account_type);
    }

    case 'fetch_qbo_estimates': {
      return await getEstimates(env, input.status || null, input.max_results || 20);
    }

    case 'fetch_qbo_invoices': {
      return await getInvoices(env, {
        unpaidOnly: input.unpaid_only || false,
        recentDays: input.recent_days || 30,
        maxResults: input.max_results || 20,
      });
    }

    case 'fetch_qbo_customer_balances': {
      return await getCustomerBalances(env);
    }

    // ── D1 OPERATIONAL DATA ──────────────────────────────────────────────────
    case 'get_d1_channel_revenue': {
      const days = input.days_back || 7;
      const [retail, wholesale, catering] = await Promise.all([
        // Retail = Toast/Square POS orders (exclude wholesale + catering)
        env.DB.prepare(`
          SELECT
            SUM(gross_revenue) as revenue,
            COUNT(*) as order_count,
            AVG(gross_revenue) as avg_order
          FROM orders
          WHERE source IN ('toast', 'toast_live', 'toast_tsv', 'square')
            AND source NOT IN ('toast_catering', 'qbo_wholesale')
            AND order_date >= date('now', '-${days} days')
        `).first(),

        // Wholesale = QBO invoices + estimates (confirmed + pipeline)
        env.DB.prepare(`
          SELECT
            SUM(CASE WHEN status = 'paid' THEN gross_revenue ELSE 0 END) as confirmed_revenue,
            SUM(CASE WHEN status = 'invoiced' THEN gross_revenue ELSE 0 END) as pipeline_revenue,
            SUM(CASE WHEN status NOT IN ('voided','estimate') THEN gross_revenue ELSE 0 END) as revenue,
            COUNT(CASE WHEN status = 'paid' THEN 1 END) as paid_orders,
            COUNT(CASE WHEN status = 'invoiced' THEN 1 END) as pending_payment,
            COUNT(CASE WHEN status = 'estimate' THEN 1 END) as pending_delivery,
            COUNT(*) as order_count
          FROM orders
          WHERE source IN ('qbo_wholesale', 'qbo_invoice', 'qbo_estimate')
            AND order_date >= date('now', '-${days} days')
        `).first(),

        // Catering = Toast invoices tagged as catering (>=$200) + catering_orders table
        env.DB.prepare(`
          SELECT
            COALESCE(SUM(rev), 0) as revenue,
            SUM(cnt) as bookings
          FROM (
            SELECT SUM(gross_revenue) as rev, COUNT(*) as cnt
            FROM orders WHERE source = 'toast_catering'
              AND order_date >= date('now', '-${days} days')
            UNION ALL
            SELECT SUM(order_value) as rev, COUNT(*) as cnt
            FROM catering_orders WHERE status = 'confirmed'
              AND event_date >= date('now', '-${days} days')
          )
        `).first(),
      ]);

      return {
        period_days: days,
        retail:    { revenue: retail?.revenue || 0,    orders: retail?.order_count || 0 },
        wholesale: {
          revenue: wholesale?.revenue || 0,
          confirmed_revenue: wholesale?.confirmed_revenue || 0,
          pipeline_revenue: wholesale?.pipeline_revenue || 0,
          paid_orders: wholesale?.paid_orders || 0,
          pending_payment: wholesale?.pending_payment || 0,
          pending_delivery: wholesale?.pending_delivery || 0,
          orders: wholesale?.order_count || 0,
        },
        catering:  { revenue: catering?.revenue || 0,  bookings: catering?.bookings || 0 },
        total:     (retail?.revenue || 0) + (wholesale?.revenue || 0) + (catering?.revenue || 0),
        note: 'Retail from Toast/Square POS. Wholesale from QBO invoices. Catering from catering_orders table.',
      };
    }

    case 'get_d1_account_health': {
      const accounts = await env.DB.prepare(`
        SELECT v.name, aa.health_status, aa.churn_risk,
               aa.last_order_date, aa.avg_monthly_rev,
               aa.total_rev_lifetime, aa.consecutive_missed,
               aa.fulfilled_by,
               julianday('now') - julianday(aa.last_order_date) as days_since_order
        FROM active_accounts aa
        JOIN venues v ON v.id = aa.venue_id
        WHERE aa.warmer_removed_at IS NULL
        ORDER BY aa.health_status DESC, days_since_order DESC
      `).all();

      const pipeline = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_prospects,
          SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as tier1,
          SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
          SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied
        FROM venues WHERE status NOT IN ('active', 'churned')
      `).first();

      return {
        active_accounts: accounts.results || [],
        pipeline: pipeline,
        at_risk: (accounts.results || []).filter(a => a.health_status !== 'green'),
      };
    }

    case 'get_agent_performance_summary': {
      const metrics = await env.DB.prepare(`
        SELECT * FROM performance_metrics
        ORDER BY week_start DESC LIMIT 4
      `).all();

      const prompts = await env.DB.prepare(`
        SELECT agent_name, version, success_rate, uses, notes
        FROM agent_prompts
        WHERE active = 1
        ORDER BY agent_name
      `).all();

      const flags = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM financial_flags
        WHERE status = 'open'
      `).first();

      return {
        metrics_last_4_weeks: metrics.results || [],
        active_prompts: prompts.results || [],
        open_flags: flags?.count || 0,
      };
    }

    // ── CALCULATION TOOLS (Claude does the math, we just store) ─────────────
    case 'calculate_channel_margins': {
      const { total_revenue, retail_revenue, wholesale_revenue, catering_revenue, total_cogs } = input;

      if (!total_revenue || total_revenue === 0) {
        return { error: 'No revenue data to calculate margins' };
      }

      // Revenue-share COGS allocation (proxy until per-SKU COGS available)
      const retailShare    = (retail_revenue    || 0) / total_revenue;
      const wholesaleShare = (wholesale_revenue || 0) / total_revenue;
      const cateringShare  = (catering_revenue  || 0) / total_revenue;

      const retailCOGS    = total_cogs * retailShare;
      const wholesaleCOGS = total_cogs * wholesaleShare;
      const cateringCOGS  = total_cogs * cateringShare;

      const retailMargin    = retail_revenue    > 0 ? (retail_revenue    - retailCOGS)    / retail_revenue    : null;
      const wholesaleMargin = wholesale_revenue > 0 ? (wholesale_revenue - wholesaleCOGS) / wholesale_revenue : null;
      const cateringMargin  = catering_revenue  > 0 ? (catering_revenue  - cateringCOGS)  / catering_revenue  : null;

      return {
        method: 'revenue_share_allocation',
        caveat: 'COGS allocated by revenue share — proxy only. Pre-payroll gross margins.',
        retail: {
          revenue: retail_revenue || 0,
          allocated_cogs: Math.round(retailCOGS * 100) / 100,
          gross_margin_pct: retailMargin !== null ? Math.round(retailMargin * 1000) / 10 : null,
        },
        wholesale: {
          revenue: wholesale_revenue || 0,
          allocated_cogs: Math.round(wholesaleCOGS * 100) / 100,
          gross_margin_pct: wholesaleMargin !== null ? Math.round(wholesaleMargin * 1000) / 10 : null,
        },
        catering: {
          revenue: catering_revenue || 0,
          allocated_cogs: Math.round(cateringCOGS * 100) / 100,
          gross_margin_pct: cateringMargin !== null ? Math.round(cateringMargin * 1000) / 10 : null,
        },
        total_gross_margin_pct: Math.round(((total_revenue - total_cogs) / total_revenue) * 1000) / 10,
      };
    }

    case 'assess_cash_runway': {
      const { current_cash, weekly_burn, weekly_revenue } = input;
      const weekly_net = weekly_revenue - weekly_burn;

      const flatRunway     = weekly_net >= 0 ? 999 : Math.abs(current_cash / weekly_net);
      const growthRunway   = weekly_net * 1.10 >= 0 ? 999 : Math.abs(current_cash / (weekly_burn - weekly_revenue * 1.10));
      const declineRunway  = weekly_net * 0.90 >= 0 ? 999 : Math.abs(current_cash / (weekly_burn - weekly_revenue * 0.90));

      return {
        current_cash,
        weekly_burn,
        weekly_revenue,
        weekly_net,
        scenarios: {
          flat:    { runway_weeks: Math.round(flatRunway    * 10) / 10, label: 'Current pace' },
          growth:  { runway_weeks: Math.round(growthRunway  * 10) / 10, label: '+10% revenue growth' },
          decline: { runway_weeks: Math.round(declineRunway * 10) / 10, label: '-10% revenue decline' },
        },
        alert: flatRunway < CASH_RUNWAY_ALERT_WEEKS,
        alert_message: flatRunway < CASH_RUNWAY_ALERT_WEEKS
          ? `CASH ALERT: ${Math.round(flatRunway * 10) / 10} weeks runway at current pace`
          : null,
      };
    }

    // ── DIRECTIVE + FLAG WRITERS ─────────────────────────────────────────────
    case 'write_financial_directive': {
      const id = crypto.randomUUID();

      // Deactivate prior directives
      await env.DB.prepare(
        'UPDATE financial_directives SET active = 0'
      ).run();

      await env.DB.prepare(`
        INSERT INTO financial_directives (
          id, week_start, generated_at,
          wholesale_priority, retail_priority, catering_priority,
          outreach_directive, retail_directive, catering_directive, optimizer_directive,
          overdue_accounts,
          cash_runway_weeks, cash_alert, cogs_alert, growth_brake,
          wholesale_margin_pct, retail_margin_pct, catering_margin_pct,
          wholesale_revenue_week, retail_revenue_week, catering_revenue_week,
          total_revenue_week,
          executive_summary, priority_actions, opportunities,
          active, created_at
        ) VALUES (
          ?, ?, datetime('now'),
          ?, ?, ?,
          ?, ?, ?, ?,
          ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?,
          ?, ?, ?,
          1, datetime('now')
        )
      `).bind(
        id, weekStart,
        input.wholesale_priority || 2, input.retail_priority || 3, input.catering_priority || 1,
        input.outreach_directive || null,
        input.retail_directive || null,
        input.catering_directive || null,
        input.optimizer_directive || null,
        input.overdue_accounts || '[]',
        input.cash_runway_weeks || null,
        input.cash_alert || 0,
        input.cogs_alert || 0,
        input.growth_brake || 0,
        input.wholesale_margin_pct || null,
        input.retail_margin_pct || null,
        input.catering_margin_pct || null,
        input.wholesale_revenue_week || 0,
        input.retail_revenue_week || 0,
        input.catering_revenue_week || 0,
        (input.wholesale_revenue_week || 0) + (input.retail_revenue_week || 0) + (input.catering_revenue_week || 0),
        input.executive_summary || '',
        input.priority_actions || '[]',
        input.opportunities || '[]'
      ).run();

      // Store in KV for fast access by other agents
      await env.KV.put('active_financial_directive', JSON.stringify({
        id,
        week_start: weekStart,
        wholesale_priority: input.wholesale_priority || 2,
        retail_priority: input.retail_priority || 3,
        catering_priority: input.catering_priority || 1,
        outreach_directive: input.outreach_directive,
        retail_directive: input.retail_directive,
        catering_directive: input.catering_directive,
        optimizer_directive: input.optimizer_directive,
        cash_alert: input.cash_alert || 0,
        growth_brake: input.growth_brake || 0,
        executive_summary: input.executive_summary,
        generated_at: new Date().toISOString(),
      }));

      console.log(`[CFO] Financial directive written: ${id}`);
      return { success: true, directive_id: id };
    }

    case 'create_financial_flag': {
      const flagId = crypto.randomUUID();

      await env.DB.prepare(`
        INSERT INTO financial_flags (
          id, report_id, week_start,
          flag_type, severity, channel, entity_name,
          title, detail, data_point, suggested_action,
          status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))
      `).bind(
        flagId, reportId, weekStart,
        input.flag_type, input.severity,
        input.channel || 'all',
        input.entity_name || null,
        input.title, input.detail,
        input.data_point || null,
        input.suggested_action
      ).run();

      console.log(`[CFO] Flag created: ${input.severity} — ${input.title}`);
      return { success: true, flag_id: flagId };
    }

    default:
      return { error: `Unknown CFO tool: ${toolName}` };
  }
}

// ── QBO → D1 ACCOUNT SYNC ────────────────────────────────────────────────────
// Backfills active_accounts with invoice history from QBO.
// Matches QBO customer names to D1 venue names (fuzzy).
async function syncQBOAccountData(env) {
  // Get all invoices from last 90 days (returns parsed array from getInvoices)
  const invoices = await getInvoices(env, { unpaidOnly: false, recentDays: 90 });
  if (!Array.isArray(invoices) || !invoices.length) return;

  // Get all active accounts with venue names
  const accounts = await env.DB.prepare(`
    SELECT aa.id, v.name as venue_name, aa.last_order_date, aa.total_rev_lifetime
    FROM active_accounts aa
    JOIN venues v ON v.id = aa.venue_id
    WHERE aa.warmer_removed_at IS NULL
  `).all();

  if (!accounts.results?.length) return;

  // Also pull estimates (for accounts like SLC Bees that only have estimates)
  let estimates = [];
  try {
    estimates = await getEstimates(env, null);
    if (!Array.isArray(estimates)) estimates = [];
  } catch {}

  // Merge estimates into invoices array with same shape
  for (const est of estimates) {
    invoices.push({
      customer: est.customer || '',
      total: parseFloat(est.total || 0),
      date: est.date || '',
      line_items: est.line_items || [],
    });
  }

  // Build name → account mapping (fuzzy: lowercase, strip common suffixes)
  const normalize = s => (s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(brewing|brewery|co|company|inc|llc|restaurant|pub|bar)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const accountMap = {};
  for (const a of accounts.results) {
    accountMap[normalize(a.venue_name)] = a;
  }

  // Manual QBO customer → D1 account mappings (person names, DBA names, etc.)
  const manualMap = {
    'anthony serrato': 'aa_slc_bees',
    'connor pelletier': 'aa_alta_gmd',
    'dawn farrell': 'aa_union_event',
    'walter lopez': null,             // Handlebar — not yet in active_accounts
    'colbilyn wyman': 'aa_hk_brewing',
  };
  for (const [qboName, accountId] of Object.entries(manualMap)) {
    if (accountId) {
      const acc = accounts.results.find(a => a.id === accountId);
      if (acc) accountMap[qboName] = acc;
    }
  }

  // Aggregate invoice data per customer
  const customerData = {};
  for (const inv of invoices) {
    const name = inv.customer || '';
    const normName = normalize(name);
    const amount = parseFloat(inv.total || 0);
    const date = inv.date || '';

    if (!customerData[normName]) {
      customerData[normName] = { name, totalRev: 0, lastDate: '', invoiceCount: 0 };
    }
    customerData[normName].totalRev += amount;
    customerData[normName].invoiceCount++;
    if (date > customerData[normName].lastDate) customerData[normName].lastDate = date;
  }

  // Match and update
  // Also extract venue names from line_item descriptions (e.g., "Pretzels - Wholesale:The Union - 7oz")
  // and associate them with customer invoices
  for (const inv of invoices) {
    const normCust = normalize(inv.customer || '');
    for (const li of (inv.line_items || [])) {
      const itemName = normalize(li.item || li.description || '');
      // QBO items are like "pretzels  wholesalethe union  7oz bbk pretzel"
      for (const [accNorm, acc] of Object.entries(accountMap)) {
        // Extract key words from account name
        const accWords = accNorm.split(' ').filter(w => w.length > 2);
        const matchCount = accWords.filter(w => itemName.includes(w)).length;
        if (matchCount >= 2 || (accWords.length === 1 && matchCount === 1)) {
          // Found venue in line item — associate this customer with this account
          if (!customerData[normCust]) continue;
          customerData[normCust]._matchedAccountId = acc.id;
        }
      }
    }
  }

  let updated = 0;
  for (const [normName, data] of Object.entries(customerData)) {
    // Try exact match first, then partial name, then line_item match
    let account = accountMap[normName];
    if (!account) {
      for (const [accNorm, acc] of Object.entries(accountMap)) {
        if (normName.includes(accNorm) || accNorm.includes(normName)) {
          account = acc;
          break;
        }
      }
    }
    if (!account && data._matchedAccountId) {
      account = accounts.results.find(a => a.id === data._matchedAccountId);
    }

    if (account) {
      const monthsSpan = Math.max(1, 3); // 90 days = ~3 months
      const avgMonthly = Math.round(data.totalRev / monthsSpan * 100) / 100;

      await env.DB.prepare(`
        UPDATE active_accounts
        SET last_order_date = ?,
            avg_monthly_rev = ?,
            total_rev_lifetime = COALESCE(total_rev_lifetime, 0) + ?
        WHERE id = ? AND (last_order_date IS NULL OR last_order_date < ?)
      `).bind(
        data.lastDate,
        avgMonthly,
        data.totalRev,
        account.id,
        data.lastDate
      ).run();
      updated++;
    }
  }

  console.log(`[CFO] Synced ${updated} accounts from ${Object.keys(customerData).length} QBO customers`);
}

// ── CFO BRIEF EMAIL ───────────────────────────────────────────────────────────
async function sendCFOBrief(weekStart, env) {
  const directive = await env.DB.prepare(
    'SELECT * FROM financial_directives WHERE week_start = ? AND active = 1'
  ).bind(weekStart).first();

  if (!directive) return;

  const flags = await env.DB.prepare(`
    SELECT flag_type, severity, title, suggested_action
    FROM financial_flags
    WHERE week_start = ? AND status = 'open'
    ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
  `).bind(weekStart).all();

  const flagList = (flags.results || []).map(f =>
    `${f.severity.toUpperCase()}: ${f.title}\n→ ${f.suggested_action}`
  ).join('\n\n');

  const actions = (() => {
    try { return JSON.parse(directive.priority_actions || '[]'); } catch { return []; }
  })();

  const emailBody = `PRETZEL OS — CFO WEEKLY BRIEF
Week of ${weekStart}

${directive.executive_summary}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CHANNEL PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Retail:    $${(directive.retail_revenue_week || 0).toFixed(0)}  (est. ${directive.retail_margin_pct || '?'}% margin)
Wholesale: $${(directive.wholesale_revenue_week || 0).toFixed(0)}  (est. ${directive.wholesale_margin_pct || '?'}% margin)
Catering:  $${(directive.catering_revenue_week || 0).toFixed(0)}  (est. ${directive.catering_margin_pct || '?'}% margin)
────────────────
Total:     $${(directive.total_revenue_week || 0).toFixed(0)}

Cash runway: ${directive.cash_runway_weeks ? directive.cash_runway_weeks + ' weeks' : 'See QBO'}${directive.cash_alert ? ' ⚠ BELOW THRESHOLD' : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR PRIORITY ACTIONS THIS WEEK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${actions.map((a, i) => `${i + 1}. ${a.action || a}\n   Why: ${a.why || ''}\n   Urgency: ${a.urgency || ''}`).join('\n\n')}

${flagList ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFINANCIAL FLAGS REQUIRING ATTENTION\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${flagList}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AGENT DIRECTIVES (what the OS is doing Monday)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Outreach:  ${directive.outreach_directive || 'Standard run'}
Catering:  ${directive.catering_directive || 'Standard run'}
Retail:    ${directive.retail_directive || 'Standard run'}
Optimizer: ${directive.optimizer_directive || 'Standard optimization'}

Note: Margins are pre-payroll gross margins. Payroll tracked externally.
Full report: https://pretzel-dashboard.pages.dev/cfo

— Pretzel OS CFO Agent`;

  await sendGmail(env, {
    to: env.DREW_EMAIL,
    subject: `CFO Brief — Week of ${weekStart}${directive.cash_alert ? ' ⚠ CASH ALERT' : directive.growth_brake ? ' ⚠ REVIEW NEEDED' : ''}`,
    body: emailBody,
  });

  console.log('[CFO] Brief sent to Drew');
}

// ── HELPER: read directive from KV (for other agents to call) ─────────────────
export async function getDirectiveFromKV(kv) {
  try {
    const raw = await kv.get('active_financial_directive');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── ENDPOINTS ─────────────────────────────────────────────────────────────────
async function getActiveDirective(env) {
  const directive = await env.DB.prepare(
    'SELECT * FROM financial_directives WHERE active = 1 ORDER BY created_at DESC LIMIT 1'
  ).first();
  return new Response(JSON.stringify(directive, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getOpenFlags(env) {
  const flags = await env.DB.prepare(`
    SELECT * FROM financial_flags
    WHERE status = 'open'
    ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
             created_at DESC
  `).all();
  return new Response(JSON.stringify(flags.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function resolveFlag(flagId, note, env) {
  await env.DB.prepare(`
    UPDATE financial_flags
    SET status = 'resolved', drew_note = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).bind(note || 'Resolved', flagId).run();
  return new Response(JSON.stringify({ resolved: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getReportHistory(env) {
  const reports = await env.DB.prepare(`
    SELECT id, week_start, qbo_data_quality, analysis_confidence,
           created_at, notes
    FROM cfo_reports
    ORDER BY created_at DESC LIMIT 12
  `).all();
  return new Response(JSON.stringify(reports.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getLatestBrief(env) {
  const directive = await env.DB.prepare(
    'SELECT * FROM financial_directives WHERE active = 1'
  ).first();
  const flags = await env.DB.prepare(
    "SELECT * FROM financial_flags WHERE status = 'open' ORDER BY created_at DESC"
  ).all();
  return new Response(JSON.stringify({ directive, flags: flags.results }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── CLAUDE API ────────────────────────────────────────────────────────────────
async function callClaudeWithTools(apiKey, systemPrompt, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,   // CFO needs room to think
      system: systemPrompt,
      tools: CFO_TOOLS,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function sendGmail(env, { to, subject, body }) {
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const { access_token } = await tokenResp.json();
  const message = [`To: ${to}`, `From: Pretzel OS <${env.FROM_EMAIL}>`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const encoded = btoa(unescape(encodeURIComponent(message))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}
