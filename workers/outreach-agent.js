/**
 * Dangerous Pretzel Co — Outreach Agent
 * Replaces outreach-worker.js
 *
 * TRUE AGENT LOOP — Claude drives the entire process:
 *   1. Research the venue (web, Instagram, Google reviews, D1 history)
 *   2. Deliberate — should I contact this venue? What channel? Any hold signals?
 *   3. Draft the email with full context
 *   4. Self-evaluate the draft — score it, rewrite if below threshold
 *   5. Decide — send | hold | park for Drew approval | flag for in-person
 *
 * Claude calls tools in whatever order it decides. We execute them and
 * feed results back. The loop runs until Claude stops calling tools
 * and returns a final decision. This is qualitatively different from
 * a scheduled function — Claude is reasoning, not just executing.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL
 *   DB, KV
 *
 * Key behaviors:
 *   - Sends max 3 emails per run (TAM protection)
 *   - First 3 weeks: Tier 2 only (warmup period)
 *   - First 20 sends: parks for Drew approval before sending
 *   - Hold signals: renovations, bad reviews, already knows brand,
 *     seasonal closure, competitor warmer in place
 *   - Self-scores every draft 1-10 — rewrites if below 7
 *   - Logs full reasoning chain to D1 for optimizer to read
 */

import { getDirectiveFromKV } from './cfo-agent.js';
import { loadBrain } from './brain-loader.js';
import { sendApprovalRequestEmail } from './approval-mailer.js';

const MAX_SENDS_PER_RUN   = 3;      // TAM protection — low and slow
const WARMUP_WEEKS        = 3;      // Tier 2 first, Tier 1 after warmup
const APPROVAL_GATE_COUNT = 20;     // Human review on first N sends
const DRAFT_QUALITY_MIN   = 7;      // Rewrite if self-score below this
const MAX_AGENT_LOOPS     = 8;      // Safety limit on tool call rounds
// DEPLOY_DATE read from env.DEPLOY_DATE (wrangler.toml)

// ── TOOL DEFINITIONS (Claude sees these and decides when to call them) ────────
const AGENT_TOOLS = [
  {
    name: 'fetch_venue_website',
    description: 'Fetch and read the venue\'s website to understand their business, vibe, events, and food situation. Call this first for every venue.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The venue website URL' },
      },
      required: ['url'],
    },
  },
  {
    name: 'check_recent_google_reviews',
    description: 'Check the venue\'s recent Google reviews. Look for: mentions of food/snacks, complaints about no food options, recent events, overall sentiment. Helps calibrate the pitch angle.',
    input_schema: {
      type: 'object',
      properties: {
        venue_name: { type: 'string' },
        city: { type: 'string' },
      },
      required: ['venue_name'],
    },
  },
  {
    name: 'check_instagram',
    description: 'Check the venue\'s recent Instagram posts. Look for: food content, events, brand partnerships, seasonal closures, renovation announcements, whether they already follow or mention Dangerous Pretzel.',
    input_schema: {
      type: 'object',
      properties: {
        instagram_handle: { type: 'string', description: 'Handle without @ symbol' },
      },
      required: ['instagram_handle'],
    },
  },
  {
    name: 'check_contact_history',
    description: 'Check D1 for any prior contact history, notes, or holds on this venue. Always call this before deciding to send.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id: { type: 'string' },
      },
      required: ['venue_id'],
    },
  },
  {
    name: 'hold_venue',
    description: 'Put this venue on hold — do not contact for the specified number of days. Use when: venue is under renovation, seasonal closure, recently had a bad event, just lost key staff, or has a competitor warmer in place. Be specific about the reason.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id:   { type: 'string' },
        reason:     { type: 'string', description: 'Specific reason for hold' },
        hold_days:  { type: 'number', description: 'Days to hold (14, 30, 60, or 90)' },
        resume_note:{ type: 'string', description: 'What to do when hold expires' },
      },
      required: ['venue_id', 'reason', 'hold_days'],
    },
  },
  {
    name: 'flag_for_drew',
    description: 'Flag this venue for Drew to handle personally — NOT via automated email. Use when: venue already knows the brand, venue is very high-value (stadium, major resort), venue GM is active on social and a personal DM would land better, or the situation is nuanced.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id: { type: 'string' },
        reason:   { type: 'string', description: 'Why Drew should handle this personally' },
        suggested_approach: { type: 'string', description: 'What Drew should do — DM, call, drop by, etc.' },
      },
      required: ['venue_id', 'reason', 'suggested_approach'],
    },
  },
  {
    name: 'draft_and_evaluate_email',
    description: 'Draft a personalized cold email for this venue using all research gathered. Then self-evaluate it on a 1-10 scale across: specificity (does it reference real details about THIS venue?), voice (does it sound like Dangerous Pretzel, not a sales rep?), friction (is the CTA easy to say yes to?), and hook (would YOU open this if you ran this venue?). If score is below 7, rewrite before returning.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id:       { type: 'string' },
        venue_name:     { type: 'string' },
        venue_category: { type: 'string' },
        contact_name:   { type: 'string' },
        research_summary: { type: 'string', description: 'Everything learned from research tools — synthesize it here' },
        hook_angle:     { type: 'string', description: 'The specific angle that makes this email right for THIS venue' },
      },
      required: ['venue_id', 'venue_name', 'venue_category', 'research_summary', 'hook_angle'],
    },
  },
  {
    name: 'send_or_park_email',
    description: 'Send the approved email OR park it for Drew\'s approval. System automatically parks during the approval gate period. After gate, sends directly. Always call this last, after draft_and_evaluate_email.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id:      { type: 'string' },
        contact_email: { type: 'string' },
        contact_name:  { type: 'string' },
        subject:       { type: 'string' },
        body:          { type: 'string' },
        self_score:    { type: 'number', description: 'The quality score from draft_and_evaluate_email (1-10)' },
        reasoning:     { type: 'string', description: 'One paragraph explaining why this email, this angle, this timing' },
      },
      required: ['venue_id', 'contact_email', 'subject', 'body', 'self_score', 'reasoning'],
    },
  },
];

// ── SYSTEM PROMPT — the agent's identity and operating principles ──────────────
const AGENT_SYSTEM_PROMPT = `You are the Outreach Agent for Dangerous Pretzel Co — a premium Salt Lake City soft pretzel brand.

YOUR JOB: Decide whether and how to contact each venue, research them thoroughly, write a genuinely great email, and protect the brand's reputation in a small market.

ABOUT DANGEROUS PRETZEL CO:
- Brand: "RUIN DINNER." / "Invented by monks, perfected for punks."
- Product: Hand-crafted soft pretzels, unique flavors: Spicy Bee (chili-cheddar, hot honey, candied jalapeños), BBK (parmesan, garlic, herbs), Saint (cinnamon sugar), Salty, For The Kids, Salty Bombs
- Program: Free loaner warmer, venue pays wholesale for pretzels only. Zero kitchen, zero training, near-zero waste.
- Lead time: 1-2 weeks in SLC
- Revenue for venues: $1,000–$10,000+/month depending on traffic
- Close rate: Extremely high once venues see/taste the product

SOCIAL PROOF (lead with these):
- Delta Center (NBA Jazz arena)
- Powder Mountain Ski Resort
- Alta Ski — Goldminer's Daughter
- SLC Bees Stadium
- The Union Event Center, Pioneer Theater
- TF Brewery, Hopkins Brewery, ROHA Brewing, HK Brewing

THE ONE RULE THAT OVERRIDES EVERYTHING:
Salt Lake City is a small, connected market. A bad email to the wrong person at the wrong time doesn't just lose one account — it damages our reputation across the network that account belongs to. When in doubt, hold or flag for Drew. We have plenty of time. We do not have unlimited goodwill.

OPERATING PRINCIPLES:

1. RESEARCH FIRST, ALWAYS. Never draft before you understand the venue. What events do they run? What's their vibe? Do they already mention food? Have they had any problems recently? Is there a hook specific to them?

2. LOOK FOR HOLD SIGNALS ACTIVELY. Before drafting, scan for: renovation or closure announcements, very recent bad reviews, seasonal businesses that are off-season, venues that already have a pretzel or snack program, venues that already know the Dangerous Pretzel brand (they follow us, they've been tagged in our posts — these get flagged for Drew, not an automated email).

3. WRITE FOR THE PERSON, NOT THE CATEGORY. A brewery taproom email and a ski lodge email should sound completely different. What does the GM at THIS venue actually care about on a Tuesday morning?

4. THE OPENING LINE IS EVERYTHING. It must reference something real and specific about their venue. Not "I noticed you're a great brewery" — that's nothing. "Saw your Hazy IPA collab with Epic last month — that's exactly the kind of pairing our Spicy Bee was made for." That's something.

5. SELF-EVALUATE RUTHLESSLY. Before sending, score your draft honestly. A 6 gets rewritten. We send 3 emails a day — they should all be 8s or better.

6. ONE CTA, FRICTIONLESS. Never "schedule a call." Always offer to do the work: bring samples, drop by Thursday, send a warmer on approval. Make yes the path of least resistance.

VOICE EXAMPLES:
Good: "Saw you host late-night shows on weekends — a pretzel warmer on your merch table sells itself at midnight."
Bad: "I wanted to reach out about an exciting partnership opportunity for your establishment."

Good: "We're already the pretzel at Delta Center and Powder Mountain. One warmer left for Sugar House."
Bad: "We work with many venues across Salt Lake City."

Good: "Want me to drop samples by this week? Takes 10 minutes and either you love it or you don't."
Bad: "I'd love to schedule a 30-minute discovery call to discuss synergies."

CHANNEL DECISIONS:
- Email: Default for most venues
- Flag for Drew (in-person / DM): High-value targets, venues that already know the brand, venues where GM is active on social
- Hold: Any signal of bad timing — renovations, closures, staff turnover, recent bad press`;

// ── MAIN EXPORT ───────────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOutreachAgent(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/outreach/run') {
      const result = await runOutreachAgent(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Preview: run agent for one venue without sending
    if (path === '/outreach/preview' && request.method === 'POST') {
      const body = await request.json();
      const venue = await env.DB.prepare(
        'SELECT * FROM venues WHERE id = ?'
      ).bind(body.venue_id).first();
      if (!venue) return new Response('Venue not found', { status: 404 });
      const brainCtx = await loadBrain(env, 'outreach');
      const result = await runAgentForVenue(venue, env, true, brainCtx); // dryRun=true
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Approval queue — list emails parked for Drew
    if (path === '/outreach/pending') {
      return getPendingApprovals(env);
    }

    // Drew approves a parked email
    if (path === '/outreach/approve' && request.method === 'POST') {
      const body = await request.json();
      return approveAndSend(body.log_id, env);
    }

    // Drew rejects / edits a parked email
    if (path === '/outreach/reject' && request.method === 'POST') {
      const body = await request.json();
      return rejectEmail(body.log_id, body.note, env);
    }

    // Pipeline: active outreach holds with venue names + reasons
    if (path === '/pipeline/holds') {
      const holds = await env.DB.prepare(`
        SELECT oh.*, v.name
        FROM outreach_holds oh
        JOIN venues v ON v.id = oh.venue_id
        WHERE oh.active = 1
        ORDER BY oh.expires_at
      `).all();
      return new Response(JSON.stringify(holds.results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Pipeline: venues flagged for Drew
    if (path === '/pipeline/flags') {
      const flags = await env.DB.prepare(`
        SELECT v.*, ol.notes as suggested_approach
        FROM venues v
        LEFT JOIN outreach_logs ol ON ol.venue_id = v.id
        WHERE v.status = 'drew_flag'
        ORDER BY v.tier
      `).all();
      return new Response(JSON.stringify(flags.results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Upcoming queue — preview what the agent will email next run
    if (path === '/outreach/queue') {
      try {
      const deployDate = new Date(env.DEPLOY_DATE || '2026-03-20');
      const weeksSinceDeploy = Math.floor((Date.now() - deployDate.getTime()) / (7 * 86400000));
      const inWarmup = weeksSinceDeploy < WARMUP_WEEKS;

      // Fresh leads (never contacted)
      const fresh = await env.DB.prepare(`
        SELECT v.id, v.name, v.category, v.tier, v.qual_score,
               v.contact_name, v.contact_title, v.website, v.notes
        FROM venues v
        WHERE v.status IN ('prospect', 'qualified')
          AND v.tier ${inWarmup ? '= 2' : 'IN (1, 2)'}
          AND v.id NOT IN (
            SELECT venue_id FROM outreach_holds WHERE active = 1
          )
        ORDER BY v.tier ASC, CASE WHEN v.qual_score IS NULL THEN 0 ELSE v.qual_score END DESC
        LIMIT 10
      `).all();

      // Day-3 follow-ups (step 1 sent 3+ days ago, no reply)
      const followUp3 = await env.DB.prepare(`
        SELECT v.id, v.name, v.category, v.tier,
               ol.subject, ol.sent_at, ol.self_score,
               'day3_followup' as queue_type
        FROM outreach_logs ol
        JOIN venues v ON v.id = ol.venue_id
        WHERE ol.direction = 'out'
          AND ol.sequence_step = 1
          AND ol.replied_at IS NULL
          AND datetime(ol.sent_at) < datetime('now', '-3 days')
          AND datetime(ol.sent_at) > datetime('now', '-14 days')
          AND v.status = 'contacted'
          AND NOT EXISTS (
            SELECT 1 FROM outreach_logs ol2
            WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step = 2
          )
        ORDER BY ol.sent_at ASC
        LIMIT 5
      `).all();

      // Day-7 follow-ups (step 2 sent 7+ days ago, no reply)
      const followUp7 = await env.DB.prepare(`
        SELECT v.id, v.name, v.category, v.tier,
               ol.subject, ol.sent_at, ol.self_score,
               'day7_followup' as queue_type
        FROM outreach_logs ol
        JOIN venues v ON v.id = ol.venue_id
        WHERE ol.direction = 'out'
          AND ol.sequence_step = 2
          AND ol.replied_at IS NULL
          AND datetime(ol.sent_at) < datetime('now', '-7 days')
          AND datetime(ol.sent_at) > datetime('now', '-21 days')
          AND v.status = 'contacted'
        ORDER BY ol.sent_at ASC
        LIMIT 5
      `).all();

      return new Response(JSON.stringify({
        next_run: 'Tuesday 8am MT',
        warmup: inWarmup,
        max_sends: MAX_SENDS_PER_RUN,
        fresh_leads: (fresh.results || []).map(v => ({
          ...v, queue_type: 'first_contact'
        })),
        day3_followups: followUp3.results || [],
        day7_followups: followUp7.results || [],
        total_queued: (fresh.results?.length || 0) + (followUp3.results?.length || 0) + (followUp7.results?.length || 0),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Add context note to a prospect
    if (path === '/outreach/queue/note' && request.method === 'POST') {
      const { venue_id, note } = await request.json();
      await env.DB.prepare('UPDATE venues SET notes = ? WHERE id = ?').bind(note, venue_id).run();
      return new Response(JSON.stringify({ saved: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Remove prospect from queue (30-day hold)
    if (path === '/outreach/queue/remove' && request.method === 'POST') {
      const { venue_id, reason } = await request.json();
      const holdId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO outreach_holds (id, venue_id, reason, hold_days, expires_at, created_at)
        VALUES (?, ?, ?, 30, datetime('now', '+30 days'), datetime('now'))
      `).bind(holdId, venue_id, reason || 'Removed from queue by Drew').run();
      return new Response(JSON.stringify({ hold_id: holdId }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Outreach Agent', { status: 200 });
  }
};

// ── MAIN RUN LOOP ─────────────────────────────────────────────────────────────
async function runOutreachAgent(env) {
  // ── BUSINESS BRAIN ────────────────────────────────────────────────────────
  const brainContext = await loadBrain(env, 'outreach');
  console.log('[Outreach] Brain loaded:', brainContext ? brainContext.split('\n').length + ' lines' : 'empty');

  // ── CFO DIRECTIVE ──────────────────────────────────────────────────────────
  const directive = await getDirectiveFromKV(env.KV);
  const outreachDirective = directive?.outreach_directive || null;
  const growthBrake = directive?.growth_brake === 1;
  let effectiveMaxSends = MAX_SENDS_PER_RUN;

  if (growthBrake) {
    effectiveMaxSends = Math.max(1, Math.floor(MAX_SENDS_PER_RUN / 2));
    console.log(`[Agent] CFO growth_brake=1 — reducing MAX_SENDS from ${MAX_SENDS_PER_RUN} to ${effectiveMaxSends}`);
  }
  if (outreachDirective) {
    console.log(`[Agent] CFO outreach_directive: ${outreachDirective}`);
  }
  console.log(`[Agent] CFO directive loaded: ${directive ? 'active' : 'none'}`);

  const inWarmup  = isWarmupPeriod(env);
  const sendCount = await getTotalSentCount(env);
  const inGate    = sendCount < APPROVAL_GATE_COUNT;

  console.log(`[Agent] Starting. Warmup: ${inWarmup}, Gate: ${inGate}, Sent total: ${sendCount}`);

  // Pick venues: Tier 2 during warmup, Tier 1 after
  const tierTarget = inWarmup ? 2 : 1;
  const venues = await env.DB.prepare(`
    SELECT v.*
    FROM venues v
    LEFT JOIN outreach_logs o ON o.venue_id = v.id AND o.direction = 'out'
    LEFT JOIN outreach_holds h ON h.venue_id = v.id AND h.expires_at > datetime('now') AND h.active = 1
    WHERE v.tier = ?
      AND v.status = 'prospect'
      AND v.contact_email IS NOT NULL
      AND o.id IS NULL
      AND h.id IS NULL
    ORDER BY v.qual_score DESC
    LIMIT ?
  `).bind(tierTarget, effectiveMaxSends * 3).all(); // fetch 3x to account for holds/skips

  const candidates = venues.results || [];
  console.log(`[Agent] ${candidates.length} candidates (Tier ${tierTarget})`);

  let processed = 0;
  let sent      = 0;
  let held      = 0;
  let flagged   = 0;

  for (const venue of candidates) {
    if (sent >= effectiveMaxSends) break;

    console.log(`[Agent] Processing: ${venue.name}`);
    const result = await runAgentForVenue(venue, env, false, brainContext);

    processed++;
    if (result.action === 'sent' || result.action === 'parked') sent++;
    if (result.action === 'held')    held++;
    if (result.action === 'flagged') flagged++;

    await sleep(2000); // breathing room between venues
  }

  // Update weekly metrics
  await updateWeeklyMetrics(env, { sent, held, flagged });

  console.log(`[Agent] Done. Processed: ${processed}, Sent/Parked: ${sent}, Held: ${held}, Flagged for Drew: ${flagged}`);
  return { processed, sent, held, flagged, warmup: inWarmup, gate: inGate };
}

// ── AGENT LOOP FOR ONE VENUE ──────────────────────────────────────────────────
async function runAgentForVenue(venue, env, dryRun = false, brainContext = '') {
  const messages = [
    {
      role: 'user',
      content: `Research and decide how to handle outreach for this venue.

Venue details:
${JSON.stringify({
  id:             venue.id,
  name:           venue.name,
  category:       venue.category,
  city:           venue.city,
  address:        venue.address,
  contact_name:   venue.contact_name,
  contact_title:  venue.contact_title,
  contact_email:  venue.contact_email,
  website:        venue.website,
  instagram:      venue.instagram,
  avg_rating:     venue.avg_rating,
  review_count:   venue.review_count,
  qual_summary:   venue.qual_summary,
  notes:          venue.notes,
}, null, 2)}

Use your tools to research this venue, check for hold signals, and make a decision.
Start with check_contact_history, then fetch_venue_website if URL is available,
then any other research you think is warranted. Only draft and send if you're
confident the timing and angle are right.`
    }
  ];

  const toolResults = [];
  let finalDecision = null;
  let loops = 0;

  // ── THE AGENTIC LOOP ───────────────────────────────────────────────────────
  while (loops < MAX_AGENT_LOOPS) {
    loops++;

    const response = await callClaudeWithTools(
      env.ANTHROPIC_API_KEY,
      AGENT_SYSTEM_PROMPT + '\n\n' + brainContext,
      messages
    );

    // Append assistant response to message history
    messages.push({ role: 'assistant', content: response.content });

    // If Claude is done deliberating
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      finalDecision = { action: 'skipped', reasoning: textBlock?.text || 'Agent ended without decision' };
      break;
    }

    // Claude wants to use tools
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResultContents = [];

      for (const toolUse of toolUseBlocks) {
        const result = await executeTool(toolUse.name, toolUse.input, venue, env, dryRun);
        toolResults.push({ tool: toolUse.name, input: toolUse.input, result });

        // Capture final action decisions from send/hold/flag tools
        if (toolUse.name === 'send_or_park_email' && result.action) {
          finalDecision = result;
        }
        if (toolUse.name === 'hold_venue') {
          finalDecision = { action: 'held', ...result };
        }
        if (toolUse.name === 'flag_for_drew') {
          finalDecision = { action: 'flagged', ...result };
        }

        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // Feed tool results back to Claude
      messages.push({ role: 'user', content: toolResultContents });
    }

    // If we have a final decision, stop the loop
    if (finalDecision && ['sent', 'parked', 'held', 'flagged'].includes(finalDecision.action)) {
      break;
    }
  }

  // Log the full reasoning chain to D1
  if (!dryRun && finalDecision) {
    await logAgentReasoning(venue.id, finalDecision, toolResults, messages, env);
  }

  console.log(`[Agent] ${venue.name} → ${finalDecision?.action || 'no decision'}`);
  return finalDecision || { action: 'skipped', reasoning: 'Max loops reached' };
}

// ── TOOL EXECUTOR ─────────────────────────────────────────────────────────────
async function executeTool(toolName, input, venue, env, dryRun) {
  switch (toolName) {

    case 'fetch_venue_website': {
      if (!input.url) return { error: 'No URL provided' };
      try {
        const response = await fetch(input.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        const html = await response.text();
        // Strip HTML tags, return first 3000 chars of readable text
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);
        return { content: text, url: input.url };
      } catch (err) {
        return { error: `Could not fetch: ${err.message}` };
      }
    }

    case 'check_recent_google_reviews': {
      // Search Google for recent reviews via web fetch
      // Note: For full Google Reviews API, wire up Places API in Phase 2
      try {
        const query = encodeURIComponent(`${input.venue_name} ${input.city || 'Salt Lake City'} reviews site:google.com OR site:yelp.com`);
        const searchUrl = `https://www.google.com/search?q=${query}&num=5`;
        const response = await fetch(searchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(6000),
        });
        const html = await response.text();
        const text = html
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 2000);
        return { review_snippet: text };
      } catch (err) {
        return {
          note: 'Could not fetch live reviews — use venue website and Instagram for research',
          avg_rating: venue.avg_rating,
          review_count: venue.review_count,
        };
      }
    }

    case 'check_instagram': {
      if (!input.instagram_handle) return { error: 'No Instagram handle' };
      try {
        const url = `https://www.instagram.com/${input.instagram_handle}/`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(6000),
        });
        const html = await response.text();
        // Extract meta description and visible text
        const metaMatch = html.match(/<meta property="og:description" content="([^"]+)"/);
        const text = html
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 1500);
        return {
          meta_description: metaMatch?.[1] || '',
          page_text: text,
          url,
        };
      } catch (err) {
        return { error: `Instagram fetch failed: ${err.message}` };
      }
    }

    case 'check_contact_history': {
      const history = await env.DB.prepare(`
        SELECT sequence_step, channel, sent_at, opened_at, replied_at, outcome, notes
        FROM outreach_logs
        WHERE venue_id = ?
        ORDER BY created_at DESC LIMIT 10
      `).bind(input.venue_id).all();

      const holds = await env.DB.prepare(`
        SELECT reason, hold_days, expires_at, resume_note
        FROM outreach_holds
        WHERE venue_id = ? AND active = 1
        ORDER BY created_at DESC LIMIT 3
      `).bind(input.venue_id).all();

      const venue_notes = await env.DB.prepare(
        'SELECT notes, qual_summary FROM venues WHERE id = ?'
      ).bind(input.venue_id).first();

      return {
        prior_contacts: history.results || [],
        active_holds: holds.results || [],
        notes: venue_notes?.notes || '',
        qual_summary: venue_notes?.qual_summary || '',
      };
    }

    case 'hold_venue': {
      if (dryRun) return { dry_run: true, would_hold: input };

      const expiresAt = new Date(
        Date.now() + (input.hold_days * 24 * 60 * 60 * 1000)
      ).toISOString();

      await env.DB.prepare(`
        INSERT INTO outreach_holds (
          id, venue_id, reason, hold_days, expires_at, resume_note, active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
      `).bind(
        crypto.randomUUID(),
        input.venue_id,
        input.reason,
        input.hold_days,
        expiresAt,
        input.resume_note || null
      ).run();

      await env.DB.prepare(`
        UPDATE venues SET status = 'hold', updated_at = datetime('now') WHERE id = ?
      `).bind(input.venue_id).run();

      return { held: true, expires_at: expiresAt, reason: input.reason };
    }

    case 'flag_for_drew': {
      if (dryRun) return { dry_run: true, would_flag: input };

      await env.KV.put(
        `drew_flag:${input.venue_id}`,
        JSON.stringify({
          venue_id: input.venue_id,
          venue_name: venue.name,
          reason: input.reason,
          suggested_approach: input.suggested_approach,
          flagged_at: new Date().toISOString(),
        }),
        { expirationTtl: 60 * 60 * 24 * 14 } // 14 days
      );

      await env.DB.prepare(`
        UPDATE venues SET status = 'drew_flag', notes = ?, updated_at = datetime('now') WHERE id = ?
      `).bind(`FLAGGED FOR DREW: ${input.reason} | ${input.suggested_approach}`, input.venue_id).run();

      return { flagged: true, reason: input.reason, approach: input.suggested_approach };
    }

    case 'draft_and_evaluate_email': {
      // Claude generates the draft internally via this tool call
      // The agent has already decided to write — now it writes and scores
      // We call Claude again here with a focused drafting prompt
      const draftPrompt = `Write and self-evaluate a cold email for Dangerous Pretzel Co.

Venue: ${input.venue_name} (${input.venue_category})
Contact: ${input.contact_name || 'the team'}
Hook angle: ${input.hook_angle}
Research: ${input.research_summary}

Write the email. Then score it 1-10 on:
- Specificity: does it reference real details about THIS venue? (not generic)
- Voice: does it sound like Dangerous Pretzel, not a sales rep?
- Friction: is the CTA easy to say yes to?
- Hook: would YOU open this if you ran this venue?

If total score is below 7, rewrite it once before returning.

Return JSON:
{
  "subject": "...",
  "body": "...",
  "self_score": 8,
  "score_breakdown": {"specificity": 8, "voice": 9, "friction": 8, "hook": 7},
  "rewritten": false
}`;

      const draftResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          system: AGENT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: draftPrompt }],
        }),
      });

      const draftData = await draftResponse.json();
      const draftText = draftData.content?.[0]?.text || '';
      try {
        const clean = draftText.replace(/```json\n?|\n?```/g, '').trim();
        return JSON.parse(clean);
      } catch {
        return { error: 'Draft parse failed', raw: draftText.slice(0, 500) };
      }
    }

    case 'send_or_park_email': {
      if (dryRun) {
        return {
          dry_run: true,
          action: 'would_send',
          subject: input.subject,
          body: input.body,
          self_score: input.self_score,
          reasoning: input.reasoning,
        };
      }

      if (input.self_score < DRAFT_QUALITY_MIN) {
        return {
          action: 'held',
          reason: `Draft quality score ${input.self_score} below minimum ${DRAFT_QUALITY_MIN}`,
        };
      }

      const totalSent = await getTotalSentCount(env);
      const inGate    = totalSent < APPROVAL_GATE_COUNT;
      const logId     = crypto.randomUUID();

      if (inGate) {
        // Park for Drew's approval
        await env.DB.prepare(`
          INSERT INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, agent_reasoning, self_score,
            created_at
          ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
        `).bind(
          logId, input.venue_id, input.subject, input.body,
          env.FROM_EMAIL, venue.contact_email,
          input.reasoning, input.self_score
        ).run();

        // Send Drew an approval email with one-tap links
        try {
          await sendApprovalRequestEmail({
            logId,
            venueName: venue.name || input.venue_id,
            contactEmail: venue.contact_email || input.contact_email,
            subject: input.subject,
            body: input.body,
            selfScore: input.self_score,
            reasoning: input.reasoning,
            channel: 'outreach',
          }, env);
        } catch (err) {
          console.error('[Outreach] Approval email failed:', err.message);
        }

        return { action: 'parked', log_id: logId, reason: 'Human approval gate active' };

      } else {
        // Send directly
        const gmailResult = await sendGmail(env, {
          to:      venue.contact_email,
          subject: input.subject,
          body:    input.body,
        });

        await env.DB.prepare(`
          INSERT INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            gmail_thread_id, gmail_message_id,
            approval_status, agent_reasoning, self_score,
            sent_at, created_at
          ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, ?, ?, 'auto_sent', ?, ?, datetime('now'), datetime('now'))
        `).bind(
          logId, input.venue_id, input.subject, input.body,
          env.FROM_EMAIL, venue.contact_email,
          gmailResult.threadId || null, gmailResult.id || null,
          input.reasoning, input.self_score
        ).run();

        await env.DB.prepare(`
          UPDATE venues
          SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).bind(input.venue_id).run();

        return { action: 'sent', log_id: logId, gmail_id: gmailResult.id };
      }
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── CLAUDE API CALL WITH TOOL USE ─────────────────────────────────────────────
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
      tools: AGENT_TOOLS,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ── APPROVAL QUEUE ────────────────────────────────────────────────────────────
async function getPendingApprovals(env) {
  const pending = await env.DB.prepare(`
    SELECT o.id, o.venue_id, o.subject, o.body, o.self_score,
           o.agent_reasoning, o.created_at,
           v.name as venue_name, v.category, v.contact_email, v.contact_name
    FROM outreach_logs o
    JOIN venues v ON v.id = o.venue_id
    WHERE o.approval_status = 'pending'
    ORDER BY o.self_score DESC, o.created_at ASC
  `).all();

  return new Response(JSON.stringify(pending.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function approveAndSend(logId, env) {
  const log = await env.DB.prepare(`
    SELECT o.*, v.contact_email, v.name as venue_name, v.id as venue_id
    FROM outreach_logs o
    JOIN venues v ON v.id = o.venue_id
    WHERE o.id = ? AND o.approval_status = 'pending'
  `).bind(logId).first();

  if (!log) return new Response('Log not found or already processed', { status: 404 });

  const gmailResult = await sendGmail(env, {
    to:      log.contact_email,
    subject: log.subject,
    body:    log.body,
  });

  await env.DB.prepare(`
    UPDATE outreach_logs
    SET approval_status = 'approved', sent_at = datetime('now'),
        gmail_thread_id = ?, gmail_message_id = ?
    WHERE id = ?
  `).bind(gmailResult.threadId || null, gmailResult.id || null, logId).run();

  await env.DB.prepare(`
    UPDATE venues
    SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(log.venue_id).run();

  return new Response(JSON.stringify({ sent: true, gmail_id: gmailResult.id }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function rejectEmail(logId, note, env) {
  await env.DB.prepare(`
    UPDATE outreach_logs
    SET approval_status = 'rejected', notes = ?
    WHERE id = ?
  `).bind(note || 'Rejected by Drew', logId).run();

  return new Response(JSON.stringify({ rejected: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── REASONING LOG ─────────────────────────────────────────────────────────────
async function logAgentReasoning(venueId, decision, toolResults, messages, env) {
  const reasoningLog = {
    decision: decision.action,
    tools_used: toolResults.map(t => t.tool),
    tool_count: toolResults.length,
    final_reasoning: decision.reasoning || '',
    self_score: decision.self_score || null,
    timestamp: new Date().toISOString(),
  };

  await env.DB.prepare(`
    UPDATE venues
    SET notes = COALESCE(notes || ' | ', '') || ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    `[Agent ${new Date().toLocaleDateString()}]: ${decision.action}${decision.reason ? ' — ' + decision.reason : ''}`,
    venueId
  ).run();

  // Store full reasoning in KV (D1 has row size limits)
  await env.KV.put(
    `reasoning:${venueId}:${Date.now()}`,
    JSON.stringify({ venueId, ...reasoningLog, toolResults }),
    { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
  );
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function isWarmupPeriod(env) {
  const deployDate  = new Date(env?.DEPLOY_DATE || '2026-03-20');
  const weeksSince  = (Date.now() - deployDate.getTime()) / (7 * 24 * 60 * 60 * 1000);
  return weeksSince < WARMUP_WEEKS;
}

async function getTotalSentCount(env) {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM outreach_logs
    WHERE direction = 'out' AND (sent_at IS NOT NULL OR approval_status = 'approved')
  `).first();
  return result?.count || 0;
}

async function updateWeeklyMetrics(env, { sent, held, flagged }) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO performance_metrics (id, week_start, created_at)
    VALUES (?, date('now', 'weekday 1', '-7 days'), datetime('now'))
  `).bind(crypto.randomUUID()).run();

  await env.DB.prepare(`
    UPDATE performance_metrics
    SET emails_sent = emails_sent + ?
    WHERE week_start = date('now', 'weekday 1', '-7 days')
  `).bind(sent).run();
}

async function sendGmail(env, { to, subject, body, threadId }) {
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  const { access_token } = await tokenResp.json();

  const message = [
    `To: ${to}`,
    `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const encoded = btoa(unescape(encodeURIComponent(message)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;

  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail error ${resp.status}: ${err}`);
  }
  return resp.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
