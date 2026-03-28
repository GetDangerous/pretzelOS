/**
 * Dangerous Pretzel Co — Catering Agent
 * Cloudflare Worker (cron: Mon + Wed 8am MT)
 *
 * TRUE AGENT LOOP — same architecture as outreach-agent.js but
 * targeting corporate accounts for catering orders.
 *
 * Key differences from Outreach Agent:
 * - Prospects are companies, not venues
 * - ICP: offices with 10+ people (tech, legal, medical, agencies, etc.)
 * - Pitch: "feed your team" not "add revenue to your venue"
 * - Seasonal intelligence: Q4 holiday parties, Q1 kickoffs, etc.
 * - Crossover intake: retail group buyers → catering leads
 * - Re-engagement: past catering clients for repeat business
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   APOLLO_API_KEY
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL
 *   DB, KV
 */

import { getDirectiveFromKV } from './cfo-agent.js';
import { loadBrain } from './brain-loader.js';
import { sendApprovalRequestEmail } from './approval-mailer.js';

const MAX_SENDS_PER_RUN   = 5;      // Catering has larger TAM than wholesale
const APPROVAL_GATE_COUNT = 15;     // First 15 park for Drew approval
const DRAFT_QUALITY_MIN   = 7;      // Min self-score to send
const MAX_AGENT_LOOPS     = 8;
// DEPLOY_DATE read from env.DEPLOY_DATE (wrangler.toml)

// ── CATERING TOOL DEFINITIONS ─────────────────────────────────────────────────
const CATERING_TOOLS = [
  {
    name: 'search_corporate_prospects',
    description: 'Search Apollo.io for corporate accounts in SLC that would book catering. Focus on companies with 10+ employees in industries that do regular team events.',
    input_schema: {
      type: 'object',
      properties: {
        industry: {
          type: 'string',
          description: 'Industry to search: tech | legal | medical | real_estate | agency | finance | events | other',
        },
        min_employees: { type: 'number', description: 'Minimum company headcount (default 10)' },
        city: { type: 'string', description: 'City to search (default: Salt Lake City)' },
      },
      required: ['industry'],
    },
  },
  {
    name: 'check_contact_history',
    description: 'Check D1 for any prior catering outreach or holds on this lead. Always call before deciding to contact.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        phone: { type: 'string', description: 'If lead came from retail crossover, check their retail history too' },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'research_company',
    description: 'Fetch and read the company website and LinkedIn overview to understand their culture, size, recent news, and event habits. Look for: team photos, events, about page headcount, recent hires.',
    input_schema: {
      type: 'object',
      properties: {
        website: { type: 'string' },
        company_name: { type: 'string' },
        linkedin: { type: 'string' },
      },
      required: ['company_name'],
    },
  },
  {
    name: 'assess_seasonal_timing',
    description: 'Assess whether there is a strong seasonal angle for this company right now. Q4 Oct-Dec = holiday party season. Q1 Jan-Feb = kickoffs. March = wrap parties. Tax season = accounting firms. Summer = outdoor events. Back to school = education sector.',
    input_schema: {
      type: 'object',
      properties: {
        industry: { type: 'string' },
        company_name: { type: 'string' },
      },
      required: ['industry'],
    },
  },
  {
    name: 'check_retail_crossover',
    description: 'If this lead came from a retail crossover, get their retail purchase history to personalize the pitch. Someone who already buys 10 pretzels at a time is pre-sold.',
    input_schema: {
      type: 'object',
      properties: {
        source_customer_id: { type: 'string' },
      },
      required: ['source_customer_id'],
    },
  },
  {
    name: 'hold_prospect',
    description: 'Hold this company — do not contact for specified days. Use for: company announced layoffs, too small (<10 employees), remote/no in-office, already has catering contract.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        reason: { type: 'string' },
        hold_days: { type: 'number' },
        resume_note: { type: 'string' },
      },
      required: ['lead_id', 'reason', 'hold_days'],
    },
  },
  {
    name: 'flag_for_drew',
    description: 'Flag this company for Drew to handle personally. Use for: large company (200+ employees), event planner who can refer many bookings, company already in Drew\'s network, past catering client worth a personal call.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        reason: { type: 'string' },
        suggested_approach: { type: 'string' },
      },
      required: ['lead_id', 'reason', 'suggested_approach'],
    },
  },
  {
    name: 'draft_and_evaluate_email',
    description: 'Write a personalized catering outreach email for this company. Self-score 1-10 on: specificity (references real details about THIS company), voice (Dangerous Pretzel energy, not corporate catering speak), hook (would this office manager open it?), CTA (easy to say yes). Rewrite if below 7.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        company_name: { type: 'string' },
        contact_name: { type: 'string' },
        industry: { type: 'string' },
        company_size: { type: 'string' },
        research_summary: { type: 'string' },
        seasonal_angle: { type: 'string' },
        crossover_context: { type: 'string', description: 'If retail crossover, their purchase history' },
      },
      required: ['lead_id', 'company_name', 'industry', 'research_summary'],
    },
  },
  {
    name: 'send_or_park_email',
    description: 'Send the approved email or park for Drew approval. Always call after draft_and_evaluate_email. System auto-parks during approval gate period.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        contact_email: { type: 'string' },
        contact_name: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        self_score: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['lead_id', 'contact_email', 'subject', 'body', 'self_score', 'reasoning'],
    },
  },
];

// ── CATERING SYSTEM PROMPT ────────────────────────────────────────────────────
const CATERING_SYSTEM_PROMPT = `You are the Catering Agent for Dangerous Pretzel Co — a premium Salt Lake City soft pretzel brand.

YOUR JOB: Find and close corporate catering accounts in SLC. Research each company, spot the right timing, write an email they'll actually open, and protect the brand by knowing when NOT to send.

ABOUT DANGEROUS PRETZEL CO CATERING:
- Premium handcrafted soft pretzels, delivered for corporate events
- Brand: "RUIN DINNER." / "Invented by monks, perfected for punks."
- Flavors: Spicy Bee (chili-cheddar dough, hot honey, candied jalapeños), BBK (parmesan, garlic, herbs), Saint (sweet cinnamon sugar), Salty, For The Kids, Salty Bombs
- Price: ~$7-8 per pretzel, catering volume pricing available
- Minimum: 10+ pretzels practical minimum
- Lead time: 48 hours minimum, 1 week preferred
- Website catering page: dangerouspretzel.com/catering
- As seen in: City Weekly, Salt Lake Magazine, SL Tribune, Axios

SOCIAL PROOF FOR CATERING:
- Pioneer Theater Company (regular event catering)
- The Union Event Center (corporate events)
- "20 pretzels gone in 8 minutes at one office event" — Google review
- Once you have corporate clients, name them here

YOUR ICP (who books catering):
- Tech companies / startups: team lunches, all-hands, investor meetings, demo days
- Law firms: client meetings, attorney appreciation, firm retreats, deal closings
- Medical/dental/vet offices: staff appreciation, patient events, office launches
- Real estate agencies: agent meetings, client appreciation, listing parties
- Marketing/ad agencies: client presentations, creative team events, pitch days
- Financial services: client events, advisor appreciation, year-end parties
- HR departments: new employee onboarding, employee appreciation, anniversary events
- Event planners: highest value — they book multiple events across many clients

MINIMUM VIABLE ACCOUNT: 10+ employees, some in-office days, culture of feeding people.

SEASONAL INTELLIGENCE — these are your strongest hooks:
- Q4 (Oct-Dec): BIGGEST SEASON. Holiday parties, year-end celebrations, client gifts. "Do your holiday party different this year."
- Q1 (Jan-Feb): New year team kickoffs, all-hands, goal-setting retreats. "Start the year with something your team will actually talk about."
- March-April: Spring events, Tax season WRAP parties (accounting/legal firms). "Your team survived tax season. They deserve this."
- Summer: BBQs, outdoor events, end of fiscal year parties.
- Any time: New hire onboarding lunch ("welcome to the team" box), deal closing celebration, client meeting catering.

THE PITCH (completely different from wholesale):
Do NOT mention warmers. Do NOT pitch the wholesale program.
Instead: "Your team has had enough sad Caesar salads and shrink-wrapped sandwiches."
Lead with flavor names — they're memorable and different. Spicy Bee with hot honey and candied jalapeños sounds like nothing else in corporate catering.
The close: "Let me send a free taster box of 6 for your next team meeting. If it doesn't cause a minor incident, you get a full refund." Low friction, memorable, almost impossible to say no to.

RETAIL CROSSOVER LEADS:
If a lead came from retail (someone who already buys pretzels in bulk at the shop), they are pre-sold. The email should reference their existing love of the product: "We noticed you've been grabbing pretzels for your team. What if we made that easier?"

HOLD SIGNALS — actively look for these before drafting:
- Company announced layoffs, hiring freeze, or restructuring (LinkedIn news)
- Very small company (<10 employees) — not worth the volume
- Remote-first with no in-office culture (LinkedIn shows everyone remote)
- Industry in obvious downturn
- Already has an established catering relationship (website mentions catering partner)

FLAG FOR DREW:
- Companies with 200+ employees — bigger deal, personal touch needed
- Event planners who could refer 10+ events per year
- Specific companies in Drew's personal network
- Past catering clients due for re-engagement (personal call, not cold email)

VOICE:
Good: "Your Q4 party doesn't have to be another bad charcuterie board."
Bad: "We are pleased to offer our premium catering services for your corporate events."

Good: "The Spicy Bee with hot honey at your all-hands will get more Slack messages than the CEO's speech."
Bad: "Our products have received outstanding reviews and would be perfect for your team."

Good: "Free taster box. 6 pretzels. Your team decides. dangerouspretzel.com/catering"
Bad: "I'd love to schedule a 30-minute consultation to discuss your catering needs."`;

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCateringAgent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/catering/run') {
      const result = await runCateringAgent(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/catering/preview' && request.method === 'POST') {
      const body = await request.json();
      const lead = await env.DB.prepare(
        'SELECT * FROM catering_leads WHERE id = ?'
      ).bind(body.lead_id).first();
      if (!lead) return new Response('Lead not found', { status: 404 });
      const brainCtx = await loadBrain(env, 'catering');
      const result = await runAgentForLead(lead, env, true, brainCtx);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/catering/pending') {
      return getPendingApprovals(env);
    }
    if (path === '/catering/approve' && request.method === 'POST') {
      const body = await request.json();
      return approveAndSend(body.log_id, env);
    }
    if (path === '/catering/reject' && request.method === 'POST') {
      const body = await request.json();
      return rejectEmail(body.log_id, body.note, env);
    }
    if (path === '/catering/crossovers') {
      return getCrossoverLeads(env);
    }
    if (path === '/catering/stats') {
      return getCateringStats(env);
    }
    return new Response('Catering Agent', { status: 200 });
  }
};

// ── MAIN RUN LOOP ─────────────────────────────────────────────────────────────
async function runCateringAgent(env) {
  // ── BUSINESS BRAIN ────────────────────────────────────────────────────────
  const brainContext = await loadBrain(env, 'catering');
  console.log('[Catering] Brain loaded:', brainContext ? brainContext.split('\n').length + ' lines' : 'empty');

  // ── CFO DIRECTIVE ──────────────────────────────────────────────────────────
  const directive = await getDirectiveFromKV(env.KV);
  const cateringDirective = directive?.catering_directive || null;
  const cateringPriority = directive?.catering_priority || null;

  if (cateringDirective) {
    console.log(`[Catering] CFO catering_directive: ${cateringDirective}`);
  }
  if (cateringPriority) {
    console.log(`[Catering] CFO catering_priority: ${cateringPriority}`);
  }
  console.log(`[Catering] CFO directive loaded: ${directive ? 'active' : 'none'}`);

  const sendCount = await getTotalSentCount(env);
  const inGate = sendCount < APPROVAL_GATE_COUNT;

  console.log(`[Catering] Starting. Gate: ${inGate}, Sent: ${sendCount}`);

  let processed = 0, sent = 0, held = 0, flagged = 0;

  // Priority 1: Retail crossover leads (pre-qualified, easiest close)
  const crossoverLeads = await env.DB.prepare(`
    SELECT cl.*
    FROM catering_leads cl
    LEFT JOIN catering_outreach_logs o ON o.lead_id = cl.id AND o.direction = 'out'
    LEFT JOIN catering_holds h ON h.lead_id = cl.id AND h.active = 1 AND h.expires_at > datetime('now')
    WHERE cl.source = 'retail_crossover'
      AND cl.status = 'prospect'
      AND cl.contact_phone IS NOT NULL
      AND o.id IS NULL
      AND h.id IS NULL
    ORDER BY cl.created_at ASC
    LIMIT 3
  `).all();

  for (const lead of (crossoverLeads.results || [])) {
    if (sent >= MAX_SENDS_PER_RUN) break;
    const result = await runAgentForLead(lead, env, false, brainContext);
    processed++;
    if (result.action === 'sent' || result.action === 'parked') sent++;
    if (result.action === 'held') held++;
    if (result.action === 'flagged') flagged++;
    await sleep(2000);
  }

  // Priority 2: Fresh Apollo prospects (if we haven't hit limit)
  if (sent < MAX_SENDS_PER_RUN) {
    const apolloLeads = await env.DB.prepare(`
      SELECT cl.*
      FROM catering_leads cl
      LEFT JOIN catering_outreach_logs o ON o.lead_id = cl.id AND o.direction = 'out'
      LEFT JOIN catering_holds h ON h.lead_id = cl.id AND h.active = 1 AND h.expires_at > datetime('now')
      WHERE cl.source = 'apollo'
        AND cl.status = 'prospect'
        AND cl.contact_email IS NOT NULL
        AND (cl.tier IS NULL OR cl.tier <= 2)
        AND o.id IS NULL
        AND h.id IS NULL
      ORDER BY cl.qual_score DESC NULLS LAST, cl.created_at ASC
      LIMIT ?
    `).bind((MAX_SENDS_PER_RUN - sent) * 3).all();

    for (const lead of (apolloLeads.results || [])) {
      if (sent >= MAX_SENDS_PER_RUN) break;
      const result = await runAgentForLead(lead, env, false, brainContext);
      processed++;
      if (result.action === 'sent' || result.action === 'parked') sent++;
      if (result.action === 'held') held++;
      if (result.action === 'flagged') flagged++;
      await sleep(2000);
    }
  }

  // Priority 3: Follow-ups (day 3 + day 7)
  await runFollowUps(env);

  console.log(`[Catering] Done. Processed: ${processed}, Sent/Parked: ${sent}, Held: ${held}, Flagged: ${flagged}`);
  return { processed, sent, held, flagged };
}

// ── AGENT LOOP FOR ONE LEAD ───────────────────────────────────────────────────
async function runAgentForLead(lead, env, dryRun = false, brainContext = '') {
  const messages = [
    {
      role: 'user',
      content: `Research and decide how to approach catering outreach for this company.

Lead details:
${JSON.stringify({
  id: lead.id,
  name: lead.name,
  contact_name: lead.contact_name,
  contact_title: lead.contact_title,
  contact_email: lead.contact_email,
  contact_phone: lead.contact_phone,
  company_size: lead.company_size,
  headcount: lead.headcount,
  industry: lead.industry,
  address: lead.address,
  city: lead.city,
  website: lead.website,
  linkedin: lead.linkedin,
  source: lead.source,
  source_customer_id: lead.source_customer_id,
  notes: lead.notes,
  seasonal_flags: lead.seasonal_flags,
}, null, 2)}

Start with check_contact_history, then assess_seasonal_timing, then research_company if website is available. If this is a retail crossover (source = 'retail_crossover'), call check_retail_crossover first — it's your best opening line.`
    }
  ];

  let toolResults = [];
  let finalDecision = null;
  let loops = 0;

  while (loops < MAX_AGENT_LOOPS) {
    loops++;

    const response = await callClaudeWithTools(
      env.ANTHROPIC_API_KEY,
      CATERING_SYSTEM_PROMPT + '\n\n' + brainContext,
      messages
    );

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      finalDecision = { action: 'skipped', reasoning: textBlock?.text || 'Agent ended without decision' };
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResultContents = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input, lead, env, dryRun);
        toolResults.push({ tool: toolUse.name, input: toolUse.input, result });

        if (toolUse.name === 'send_or_park_email' && result.action) finalDecision = result;
        if (toolUse.name === 'hold_prospect') finalDecision = { action: 'held', ...result };
        if (toolUse.name === 'flag_for_drew') finalDecision = { action: 'flagged', ...result };

        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResultContents });
    }

    if (finalDecision && ['sent', 'parked', 'held', 'flagged'].includes(finalDecision.action)) break;
  }

  if (!dryRun && finalDecision) {
    await logAgentReasoning(lead.id, finalDecision, toolResults, env);
  }

  console.log(`[Catering] ${lead.name} → ${finalDecision?.action || 'no decision'}`);
  return finalDecision || { action: 'skipped', reasoning: 'Max loops reached' };
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(toolName, input, lead, env, dryRun) {
  switch (toolName) {

    case 'search_corporate_prospects': {
      try {
        const payload = {
          api_key: env.APOLLO_API_KEY,
          q_organization_name: input.industry,
          organization_locations: [`${input.city || 'Salt Lake City'}, Utah`],
          organization_num_employees_ranges: [`${input.min_employees || 10},500`],
          contact_titles: [
            'Office Manager', 'Executive Assistant', 'HR Director', 'HR Manager',
            'Marketing Manager', 'Operations Manager', 'Chief of Staff',
            'Administrative Manager', 'Events Manager', 'Facilities Manager',
          ],
          per_page: 10,
        };

        const response = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) return { error: `Apollo error ${response.status}` };
        const data = await response.json();
        const orgs = data.organizations || [];

        // Insert new leads into D1
        let added = 0;
        for (const org of orgs) {
          const existing = await env.DB.prepare(
            'SELECT id FROM catering_leads WHERE id = ? OR (name = ? AND city = ?)'
          ).bind(`apollo_c_${org.id}`, org.name, input.city || 'Salt Lake City').first();

          if (existing) continue;

          const contact = (org.contacts || [])[0] || {};
          await env.DB.prepare(`
            INSERT INTO catering_leads (
              id, name, contact_name, contact_title, contact_email, contact_phone,
              company_size, headcount, industry, address, city, website, linkedin,
              source, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'apollo', 'prospect', datetime('now'), datetime('now'))
          `).bind(
            `apollo_c_${org.id}`, org.name,
            contact.name || null, contact.title || null,
            contact.email || null, contact.phone_numbers?.[0]?.sanitized_number || null,
            categorizeSizeByHeadcount(org.estimated_num_employees),
            org.estimated_num_employees || null,
            input.industry,
            org.street_address || null,
            input.city || 'Salt Lake City',
            org.website_url || null,
            null
          ).run();
          added++;
        }

        return { found: orgs.length, added, industry: input.industry };
      } catch (err) {
        return { error: err.message };
      }
    }

    case 'check_contact_history': {
      const history = await env.DB.prepare(`
        SELECT sequence_step, channel, sent_at, replied_at, outcome
        FROM catering_outreach_logs
        WHERE lead_id = ?
        ORDER BY created_at DESC LIMIT 5
      `).bind(input.lead_id).all();

      const holds = await env.DB.prepare(`
        SELECT reason, expires_at, resume_note
        FROM catering_holds
        WHERE lead_id = ? AND active = 1
        LIMIT 2
      `).bind(input.lead_id).all();

      return {
        prior_contacts: history.results || [],
        active_holds: holds.results || [],
      };
    }

    case 'research_company': {
      const results = {};

      if (input.website) {
        try {
          const r = await fetch(input.website, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(7000),
          });
          const html = await r.text();
          const text = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 2500);
          results.website_content = text;
        } catch (err) {
          results.website_error = err.message;
        }
      }

      if (input.linkedin) {
        try {
          const r = await fetch(input.linkedin, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(6000),
          });
          const html = await r.text();
          const meta = html.match(/<meta[^>]*og:description[^>]*content="([^"]+)"/)?.[1] || '';
          results.linkedin_description = meta;
        } catch {}
      }

      return results;
    }

    case 'assess_seasonal_timing': {
      const month = new Date().getMonth() + 1; // 1-12
      const angles = [];

      if (month >= 10 && month <= 12) {
        angles.push('Q4 PEAK: Holiday party season. Strongest catering hook of the year. "Do your holiday party different."');
      }
      if (month === 1 || month === 2) {
        angles.push('Q1 kickoff season. Team all-hands, goal-setting retreats. "Start the year with something your team will talk about."');
      }
      if (month === 3 || month === 4) {
        if (input.industry === 'legal' || input.industry === 'finance') {
          angles.push('Tax season wrap party hook. "Your team survived tax season. They deserve this."');
        } else {
          angles.push('Spring event season. End-of-Q1 celebrations.');
        }
      }
      if (month >= 6 && month <= 8) {
        angles.push('Summer event season. Outdoor team events, end-of-fiscal celebrations.');
      }

      // Universal angles
      angles.push('Onboarding lunch: great for new hires — "welcome to the team" box.');
      angles.push('Deal close celebration: "just closed a big deal? pretzels are the move."');

      return {
        current_month: month,
        seasonal_angles: angles,
        best_angle: angles[0] || 'Universal: team lunch, onboarding, deal close',
      };
    }

    case 'check_retail_crossover': {
      if (!input.source_customer_id) return { no_crossover: true };

      const customer = await env.DB.prepare(`
        SELECT visit_count, largest_single_order, avg_items_per_order,
               total_lifetime_value, favorite_sku, last_visit_date
        FROM retail_customers
        WHERE id = ?
      `).bind(input.source_customer_id).first();

      if (!customer) return { not_found: true };

      return {
        visit_count: customer.visit_count,
        largest_order: customer.largest_single_order,
        avg_items: customer.avg_items_per_order,
        ltv: customer.total_lifetime_value,
        favorite_sku: customer.favorite_sku,
        last_visit: customer.last_visit_date,
        note: `This person already loves Dangerous Pretzel — they've visited ${customer.visit_count} times and once ordered ${customer.largest_single_order} pretzels at once. They're pre-sold.`,
      };
    }

    case 'hold_prospect': {
      if (dryRun) return { dry_run: true, would_hold: input };

      const expiresAt = new Date(
        Date.now() + (input.hold_days * 24 * 60 * 60 * 1000)
      ).toISOString();

      await env.DB.prepare(`
        INSERT INTO catering_holds (id, lead_id, reason, hold_days, expires_at, resume_note, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `).bind(
        crypto.randomUUID(), input.lead_id, input.reason,
        input.hold_days, expiresAt, input.resume_note || null
      ).run();

      await env.DB.prepare(
        "UPDATE catering_leads SET status = 'hold', updated_at = datetime('now') WHERE id = ?"
      ).bind(input.lead_id).run();

      return { held: true, expires_at: expiresAt, reason: input.reason };
    }

    case 'flag_for_drew': {
      if (dryRun) return { dry_run: true, would_flag: input };

      await env.KV.put(
        `drew_catering_flag:${input.lead_id}`,
        JSON.stringify({
          lead_id: input.lead_id,
          company_name: lead.name,
          reason: input.reason,
          suggested_approach: input.suggested_approach,
          flagged_at: new Date().toISOString(),
        }),
        { expirationTtl: 60 * 60 * 24 * 14 }
      );

      await env.DB.prepare(
        "UPDATE catering_leads SET status = 'drew_flag', notes = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(`FLAGGED FOR DREW: ${input.reason} | ${input.suggested_approach}`, input.lead_id).run();

      return { flagged: true, reason: input.reason, approach: input.suggested_approach };
    }

    case 'draft_and_evaluate_email': {
      const prompt = `Write and self-evaluate a catering outreach email for Dangerous Pretzel Co.

Company: ${input.company_name} (${input.industry}, ${input.company_size || 'unknown size'})
Contact: ${input.contact_name || 'the team'} — ${lead.contact_title || 'unknown role'}
Seasonal angle: ${input.seasonal_angle || 'none specific'}
Research: ${input.research_summary}
Retail crossover context: ${input.crossover_context || 'none — cold prospect'}

Write the email. Then score 1-10 on:
- Specificity: does it reference real things about THIS company?
- Voice: Dangerous Pretzel energy (not corporate catering speak)
- Hook: would THIS office manager open it on a Tuesday morning?
- CTA: easy to say yes — free sample box offer whenever possible

If total score below 7, rewrite once before returning.

Return JSON:
{
  "subject": "...",
  "body": "...",
  "self_score": 8,
  "score_breakdown": {"specificity": 8, "voice": 8, "hook": 8, "cta": 9},
  "rewritten": false
}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          system: CATERING_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const data = await r.json();
      const text = data.content?.[0]?.text || '';
      try {
        return JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
      } catch {
        return { error: 'Draft parse failed', raw: text.slice(0, 300) };
      }
    }

    case 'send_or_park_email': {
      if (dryRun) return { dry_run: true, action: 'would_send', ...input };

      if (input.self_score < DRAFT_QUALITY_MIN) {
        return { action: 'held', reason: `Score ${input.self_score} below minimum ${DRAFT_QUALITY_MIN}` };
      }

      const totalSent = await getTotalSentCount(env);
      const inGate = totalSent < APPROVAL_GATE_COUNT;
      const logId = crypto.randomUUID();

      if (inGate) {
        await env.DB.prepare(`
          INSERT INTO catering_outreach_logs (
            id, lead_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, agent_reasoning, self_score, created_at
          ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
        `).bind(
          logId, input.lead_id, input.subject, input.body,
          env.FROM_EMAIL, lead.contact_email || input.contact_email,
          input.reasoning, input.self_score
        ).run();
        // Send Drew an approval email with one-tap links
        try {
          await sendApprovalRequestEmail({
            logId,
            venueName: lead.name || input.lead_id,
            contactEmail: lead.contact_email || input.contact_email,
            subject: input.subject,
            body: input.body,
            selfScore: input.self_score,
            reasoning: input.reasoning,
            channel: 'catering',
          }, env);
        } catch (err) {
          console.error('[Catering] Approval email failed:', err.message);
        }

        return { action: 'parked', log_id: logId };
      } else {
        const gmailResult = await sendGmail(env, {
          to: lead.contact_email || input.contact_email,
          subject: input.subject,
          body: input.body,
        });

        await env.DB.prepare(`
          INSERT INTO catering_outreach_logs (
            id, lead_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            gmail_thread_id, gmail_message_id,
            approval_status, agent_reasoning, self_score,
            sent_at, created_at
          ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, ?, ?, 'auto_sent', ?, ?, datetime('now'), datetime('now'))
        `).bind(
          logId, input.lead_id, input.subject, input.body,
          env.FROM_EMAIL, lead.contact_email || input.contact_email,
          gmailResult.threadId || null, gmailResult.id || null,
          input.reasoning, input.self_score
        ).run();

        await env.DB.prepare(
          "UPDATE catering_leads SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).bind(input.lead_id).run();

        return { action: 'sent', log_id: logId };
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── FOLLOW-UP SEQUENCES ───────────────────────────────────────────────────────
async function runFollowUps(env) {
  const FOLLOWUP1_DAYS = 3;
  const FOLLOWUP2_DAYS = 7;

  // Day 3 follow-ups
  const followup1 = await env.DB.prepare(`
    SELECT cl.*, o.sent_at as first_sent, o.gmail_thread_id, o.subject as orig_subject
    FROM catering_leads cl
    JOIN catering_outreach_logs o ON o.lead_id = cl.id
    WHERE o.sequence_step = 1 AND o.direction = 'out'
      AND o.replied_at IS NULL AND o.outcome IS NULL
      AND datetime(o.sent_at) <= datetime('now', '-${FOLLOWUP1_DAYS} days')
      AND NOT EXISTS (
        SELECT 1 FROM catering_outreach_logs o2
        WHERE o2.lead_id = cl.id AND o2.sequence_step = 2
      )
    LIMIT 5
  `).all();

  for (const lead of (followup1.results || [])) {
    await sendFollowUp(lead, 2, env);
    await sleep(1500);
  }

  // Day 7 follow-ups
  const followup2 = await env.DB.prepare(`
    SELECT cl.*, o.sent_at as first_sent, o.gmail_thread_id
    FROM catering_leads cl
    JOIN catering_outreach_logs o ON o.lead_id = cl.id
    WHERE o.sequence_step = 2 AND o.direction = 'out'
      AND o.replied_at IS NULL AND o.outcome IS NULL
      AND datetime(o.sent_at) <= datetime('now', '-${FOLLOWUP2_DAYS} days')
      AND NOT EXISTS (
        SELECT 1 FROM catering_outreach_logs o2
        WHERE o2.lead_id = cl.id AND o2.sequence_step = 3
      )
    LIMIT 5
  `).all();

  for (const lead of (followup2.results || [])) {
    await sendFollowUp(lead, 3, env);
    await sleep(1500);
  }
}

async function sendFollowUp(lead, step, env) {
  const prompt = step === 2
    ? `Write a 3-sentence day-3 catering follow-up for ${lead.name}. Reference original email without being needy. Add one new angle: a seasonal hook, a nearby company that booked us, or the free sample offer if not already made. Same voice: irreverent, specific. Return JSON: {body}`
    : `Write a final 2-sentence day-7 catering follow-up for ${lead.name}. Last one, say so briefly. Leave the door open — "the free sample offer stands whenever you're ready." Return JSON: {body}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: CATERING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!r.ok) return;
  const data = await r.json();
  const text = data.content?.[0]?.text || '';

  try {
    const { body } = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    if (!body || !lead.contact_email) return;

    const gmailResult = await sendGmail(env, {
      to: lead.contact_email,
      subject: `Re: Your earlier email`,
      body,
      threadId: lead.gmail_thread_id || null,
    });

    await env.DB.prepare(`
      INSERT INTO catering_outreach_logs (
        id, lead_id, sequence_step, channel, direction,
        body, from_address, to_address,
        gmail_thread_id, approval_status, sent_at, created_at
      ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, 'auto_sent', datetime('now'), datetime('now'))
    `).bind(
      crypto.randomUUID(), lead.id, step, body,
      env.FROM_EMAIL, lead.contact_email,
      gmailResult.threadId || null
    ).run();

  } catch (err) {
    console.error(`[Catering] Follow-up error:`, err.message);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
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
      max_tokens: 2000,
      system: systemPrompt,
      tools: CATERING_TOOLS,
      messages,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function getPendingApprovals(env) {
  const pending = await env.DB.prepare(`
    SELECT o.id, o.lead_id, o.subject, o.body, o.self_score, o.agent_reasoning, o.created_at,
           cl.name as company_name, cl.industry, cl.contact_email, cl.contact_name, cl.source
    FROM catering_outreach_logs o
    JOIN catering_leads cl ON cl.id = o.lead_id
    WHERE o.approval_status = 'pending'
    ORDER BY o.self_score DESC, o.created_at ASC
  `).all();
  return new Response(JSON.stringify(pending.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function approveAndSend(logId, env) {
  const log = await env.DB.prepare(`
    SELECT o.*, cl.contact_email, cl.name, cl.id as lead_id
    FROM catering_outreach_logs o
    JOIN catering_leads cl ON cl.id = o.lead_id
    WHERE o.id = ? AND o.approval_status = 'pending'
  `).bind(logId).first();
  if (!log) return new Response('Not found', { status: 404 });

  const gmailResult = await sendGmail(env, {
    to: log.contact_email,
    subject: log.subject,
    body: log.body,
  });

  await env.DB.prepare(
    "UPDATE catering_outreach_logs SET approval_status = 'approved', sent_at = datetime('now'), gmail_thread_id = ?, gmail_message_id = ? WHERE id = ?"
  ).bind(gmailResult.threadId || null, gmailResult.id || null, logId).run();

  await env.DB.prepare(
    "UPDATE catering_leads SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).bind(log.lead_id).run();

  return new Response(JSON.stringify({ sent: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function rejectEmail(logId, note, env) {
  await env.DB.prepare(
    "UPDATE catering_outreach_logs SET approval_status = 'rejected', notes = ? WHERE id = ?"
  ).bind(note || 'Rejected', logId).run();
  return new Response(JSON.stringify({ rejected: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getCrossoverLeads(env) {
  const leads = await env.DB.prepare(`
    SELECT cl.*, rc.visit_count, rc.largest_single_order, rc.total_lifetime_value
    FROM catering_leads cl
    LEFT JOIN retail_customers rc ON rc.id = cl.source_customer_id
    WHERE cl.source = 'retail_crossover'
    ORDER BY cl.created_at DESC
    LIMIT 50
  `).all();
  return new Response(JSON.stringify(leads.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getCateringStats(env) {
  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) as total_leads,
      SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as tier1,
      SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
      SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
      SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked,
      SUM(CASE WHEN status = 'recurring' THEN 1 ELSE 0 END) as recurring,
      SUM(CASE WHEN source = 'retail_crossover' THEN 1 ELSE 0 END) as crossover_leads
    FROM catering_leads
  `).first();

  const revenue = await env.DB.prepare(`
    SELECT SUM(order_value) as total_revenue, COUNT(*) as order_count
    FROM catering_orders
    WHERE status = 'completed'
  `).first();

  return new Response(JSON.stringify({ leads: stats, revenue }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function logAgentReasoning(leadId, decision, toolResults, env) {
  await env.DB.prepare(`
    UPDATE catering_leads
    SET notes = COALESCE(notes || ' | ', '') || ?, updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    `[Agent ${new Date().toLocaleDateString()}]: ${decision.action}`,
    leadId
  ).run();
  await env.KV.put(
    `catering_reasoning:${leadId}:${Date.now()}`,
    JSON.stringify({ leadId, decision, tools_used: toolResults.map(t => t.tool) }),
    { expirationTtl: 60 * 60 * 24 * 90 }
  );
}

async function getTotalSentCount(env) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM catering_outreach_logs WHERE direction = 'out' AND (sent_at IS NOT NULL OR approval_status = 'approved')"
  ).first();
  return r?.count || 0;
}

function categorizeSizeByHeadcount(n) {
  if (!n) return 'unknown';
  if (n < 10) return 'micro';
  if (n < 51) return 'small';
  if (n < 201) return 'medium';
  return 'large';
}

async function sendGmail(env, { to, subject, body, threadId }) {
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
  const message = [`To: ${to}`, `From: Drew <${env.FROM_EMAIL}>`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const encoded = btoa(unescape(encodeURIComponent(message))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Gmail error ${resp.status}`);
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
