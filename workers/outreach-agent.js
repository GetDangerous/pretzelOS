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

// These defaults are overridden by wrangler.toml env vars at runtime
const MAX_SENDS_PER_RUN   = 3;      // env.OUTREACH_DAILY_LIMIT
const WARMUP_WEEKS        = 3;      // env.OUTREACH_WARMUP_WEEKS
const APPROVAL_GATE_COUNT = 20;     // env.OUTREACH_APPROVAL_GATE — human review until N sends
const DRAFT_QUALITY_MIN   = 7;      // env.OUTREACH_QUALITY_MIN
const MAX_AGENT_LOOPS     = 8;      // Safety limit on tool call rounds

// ── A/B SUBJECT LINE VARIANTS ────────────────────────────────────────────────
// Deterministic assignment: hash venue_id → A or B (consistent per venue)
const AB_VARIANTS = {
  A: { key: 'question', hint: 'Subject line MUST be a casual question. Examples: "Quick question about [Venue]\'s food setup?", "Ever thought about adding pretzels at [Venue]?", "Food question for [Venue]". Keep it under 8 words, conversational, ends with "?".' },
  B: { key: 'hook', hint: 'Subject line MUST be a short hook statement. Examples: "[Venue] + pretzels", "Pretzels at [Venue]", "Something for [Venue]\'s crowd". Keep it under 6 words, no question mark, punchy.' },
};
function getABVariant(venueId) {
  // Simple hash: sum char codes, mod 2
  const hash = (venueId || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return hash % 2 === 0 ? 'A' : 'B';
}
// All numeric config reads env var first, falls back to constant above
const cfg = env => ({
  maxSends:     parseInt(env.OUTREACH_DAILY_LIMIT    || MAX_SENDS_PER_RUN,   10),
  warmupWeeks:  parseInt(env.OUTREACH_WARMUP_WEEKS   || WARMUP_WEEKS,        10),
  approvalGate: parseInt(env.OUTREACH_APPROVAL_GATE  || APPROVAL_GATE_COUNT, 10),
  qualityMin:   parseInt(env.OUTREACH_QUALITY_MIN    || DRAFT_QUALITY_MIN,   10),
});

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
  {
    name: 'find_venue_contact',
    description: 'Find a contact email AND phone number for ANY venue via website scraping and web search. Call this whenever contact_email is missing or null — works for all categories. Saves email + phone to D1 if found. Phone numbers enable SMS nudges after email. Falls back to flagging for Drew Instagram/LinkedIn DM if no email found.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id:      { type: 'string' },
        venue_name:    { type: 'string' },
        venue_category:{ type: 'string', description: 'Category of venue (brewery, summer_venue, stadium, golf, etc.)' },
        venue_website: { type: 'string', description: 'Full URL of venue website if known' },
      },
      required: ['venue_id', 'venue_name'],
    },
  },
  // Legacy alias — kept so any in-flight agent calls still work
  {
    name: 'find_summer_venue_contact',
    description: 'DEPRECATED — use find_venue_contact instead. Kept for backward compatibility.',
    input_schema: {
      type: 'object',
      properties: {
        venue_id:      { type: 'string' },
        venue_name:    { type: 'string' },
        venue_website: { type: 'string' },
      },
      required: ['venue_id', 'venue_name'],
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

THE VOICE — READ THIS BEFORE WRITING ANYTHING:

We're a local SLC company. We make genuinely great, unique soft pretzels — flavors people haven't had before, that they talk about and come back for. We have a simple program that makes it super easy for venues to offer them to their patrons. That's it.

The ask is always the same: can I bring some pretzels by for your team to try?

Not "let's do a trial run." Not "here's our warmer model." Just: we make great pretzels, your crowd would love them, we've made it easy, can I drop some off?

THE EMAIL TEMPLATE THAT GETS RESPONSES:

Here is a real email Drew sent to Quarters (an arcade bar) that got a reply within 1 hour. Notice the tone: casual, local, no pitch deck energy.

---
Subject: Quarters + pretzels?

Hi Michael and Katy,

I'm the owner of Dangerous Pretzel Co. and a fan of what you guys have built at Quarters.

We just launched a "warmer model" with TF Brewing that's been a perfect fit for high-traffic bars. We provide a small 2'x2' warmer; your staff just warms, salts, and serves.

Why it fits Quarters:
• Gamer Friendly: It's the ultimate one-handed snack (no messy fingers on joysticks).
• No Kitchen Needed: Pretzels store in your walk-in fridge and take 5 mins to warm.
• High Margin: At $10 retail, it's $6 profit per pretzel. For a high-volume spot, it's a realistic five-to-six-figure annual profit stream.

I'd love to drop off samples for the team and show you how small the warmer is. Any interest in a 2-week trial run at one of the locations?

Best,

--
Drew Sparks
Owner
Dangerous Pretzel Co
c: 801.916.9122
---

SUBJECT LINE RULES:
- "[Venue name] + pretzels?" — works almost everywhere, use this as the default
- "quick question about [venue]" — use when you have a very specific hook
- "[Specific hook]?" — e.g., "pretzels at the 19th hole?" for golf
- NEVER: "An exciting opportunity for [venue]", "Partnership proposal", "Following up", anything with "innovative" or "synergy"

EMAIL STRUCTURE (always follow this):
1. Greeting: Use real names if found in research. "Hi [Name]," — first name only, casual.
2. Fan opener (1 sentence): "I'm the owner of Dangerous Pretzel Co. — [something genuine about their venue]." Keep it real, don't be sycophantic.
3. Why their crowd would love it (1-2 sentences): Make it about the guest experience. "Our pretzels are unlike anything most people have had — [Spicy Bee / BBK / flavor detail]. The kind of thing people mention to their friends and come back for." Connect it to THEIR specific crowd (concert-goers, beer drinkers, golfers, etc.).
4. Why it's easy for them (1-2 sentences): "We've made it really simple to offer on your end — we supply everything, no kitchen needed, your staff just serves." Optionally: "We're already doing this at [anchor account like Sandy Amphitheater / Delta Center] and it's been a great fit."
5. CTA (1 sentence): Ask to bring some by. "Could I bring some pretzels by for the team to try?" OR "Mind if I drop some off before your next event?" Simple, low-friction, casual. Add phone number directly in body if no contact name: "801.916.9122"
6. Sign-off: "— Drew" then newline "--\nDrew Sparks\nOwner\nDangerous Pretzel Co\nc: 801.916.9122"

BANNED PHRASES — INSTANT REWRITE IF ANY OF THESE APPEAR:
- "I hope this finds you well"
- "I wanted to reach out"
- "I am writing to"
- "exciting opportunity" / "exciting partnership"
- "touch base" / "connect" (without a specific ask)
- "synergies" / "value proposition" / "leverage"
- "Please don't hesitate to"
- "Looking forward to hearing from you" (too passive — replace with a specific question)
- "As a [business type], you understand..."
- "In today's competitive market"
- "warmer model" — say "simple program" or just describe it naturally
- "one warmer, one night" — sounds like a project, not a partnership
- "trial run" — say "bring some by" or "drop some off"
- "if your guests don't love it" — defensive; skip this entirely
- "we pick up the warmer" — sounds like a burden, not a benefit
- Any sentence longer than 25 words
- Any paragraph longer than 3 lines

VOICE EXAMPLES:
Good: "Your crowd at Gallivan is exactly who loves these — outdoor summer events, people already in a good mood. The kind of snack that becomes the thing people tell their friends about."
Bad: "We provide a small 2'x2' warmer; your staff just warms, salts, and serves. One warmer, one night — if your guests don't love it, we pick up the warmer."

Good: "We're local, we make really unique pretzels, and we've made it super easy to offer them. Could I just bring some by for the team to try?"
Bad: "I wanted to reach out about an exciting partnership opportunity that could add a five-to-six-figure revenue stream to your venue."

Good: "Already doing this at Sandy Amphitheater and Delta Center — it's been a great fit. Same idea would work really well at [venue]."
Bad: "We work with many venues across Salt Lake City and would love to add your venue to our roster."

EMAIL SIGNATURE: Always sign emails as "Drew" — never make up a name. You are writing on behalf of Drew Craker, the founder. Sign off with the full signature block shown in the template above.

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
      // Use ctx.waitUntil so the run continues even if client disconnects
      ctx.waitUntil(runOutreachAgent(env));
      return new Response(JSON.stringify({ started: true, message: 'Outreach run started. Check /outreach/queue in ~2 min for new drafts.' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Preview: run agent for one venue without sending (dry run)
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

    // Draft and park: run agent for one venue for real — parks email for approval
    if (path === '/outreach/draft-and-park' && request.method === 'POST') {
      const body = await request.json();
      const venue = await env.DB.prepare(
        'SELECT * FROM venues WHERE id = ?'
      ).bind(body.venue_id).first();
      if (!venue) return new Response(JSON.stringify({ error: 'Venue not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const brainCtx = await loadBrain(env, 'outreach');
      const result = await runAgentForVenue(venue, env, false, brainCtx); // dryRun=false — actually parks
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Approval queue — list emails parked for Drew
    if (path === '/outreach/pending') {
      return getPendingApprovals(env);
    }

    // DM flags — venues where find_summer_venue_contact returned instagram_only
    if (path === '/outreach/dm-flags') {
      return getDmFlags(env);
    }

    // Dismiss a DM flag after Drew has sent the DM
    if (path === '/outreach/dm-flags/dismiss' && request.method === 'POST') {
      const body = await request.json();
      await env.KV.delete(`drew_flag:instagram_${body.venue_id}`);
      await env.DB.prepare(
        `UPDATE venues SET status = 'drew_flag', notes = COALESCE(notes || ' | ', '') || 'Drew DM sent via Instagram' WHERE id = ?`
      ).bind(body.venue_id).run();
      return new Response(JSON.stringify({ dismissed: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // A/B subject line test results — grouped by variant and category
    if (path === '/outreach/ab-stats') {
      const stats = await env.DB.prepare(`
        SELECT
          subject_variant,
          v.category,
          COUNT(*) as total_sent,
          SUM(CASE WHEN o.replied_at IS NOT NULL THEN 1 ELSE 0 END) as replies,
          SUM(CASE WHEN o.opened_at IS NOT NULL THEN 1 ELSE 0 END) as opens,
          SUM(CASE WHEN o.outcome LIKE 'replied_interested%' OR o.outcome = 'replied_meeting_request' THEN 1 ELSE 0 END) as positive_replies,
          ROUND(AVG(o.self_score), 1) as avg_score
        FROM outreach_logs o
        JOIN venues v ON v.id = o.venue_id
        WHERE o.direction = 'out' AND o.sent_at IS NOT NULL
          AND o.subject_variant IS NOT NULL AND o.sequence_step = 1
        GROUP BY o.subject_variant, v.category
        ORDER BY v.category, o.subject_variant
      `).all();
      const summary = await env.DB.prepare(`
        SELECT
          subject_variant,
          COUNT(*) as total,
          SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) as replies,
          ROUND(100.0 * SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) as reply_rate_pct
        FROM outreach_logs
        WHERE direction = 'out' AND sent_at IS NOT NULL
          AND subject_variant IS NOT NULL AND sequence_step = 1
        GROUP BY subject_variant
      `).all();
      return new Response(JSON.stringify({
        by_category: stats.results || [],
        overall: summary.results || [],
        variants: { A: 'question', B: 'hook' },
        note: 'Need 20+ sends per variant for statistical significance',
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Signal Scanner — view recent timing signals + manual trigger
    if (path === '/outreach/signals') {
      const signals = await env.DB.prepare(`
        SELECT ts.*, v.name as venue_name, v.category, v.tier
        FROM timing_signals ts
        JOIN venues v ON v.id = ts.venue_id
        WHERE ts.expires_at > datetime('now')
        ORDER BY ts.signal_score DESC, ts.created_at DESC
        LIMIT 50
      `).all();
      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) as consumed,
          SUM(CASE WHEN signal_score >= 7 THEN 1 ELSE 0 END) as high_signal,
          ROUND(AVG(signal_score), 1) as avg_score
        FROM timing_signals
        WHERE created_at > datetime('now', '-7 days')
      `).first();
      return new Response(JSON.stringify({
        signals: signals.results || [],
        stats_7d: stats || {},
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    if (path === '/outreach/signals/scan' && request.method === 'POST') {
      ctx.waitUntil(runSignalScanner(env));
      return new Response(JSON.stringify({ started: true, message: 'Signal scanner started. Check /outreach/signals in ~5 min.' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Open tracking pixel — 1x1 transparent GIF that sets opened_at
    if (path.startsWith('/outreach/pixel/')) {
      const logId = path.split('/outreach/pixel/')[1];
      if (logId) {
        ctx.waitUntil(
          env.DB.prepare(
            `UPDATE outreach_logs SET opened_at = COALESCE(opened_at, datetime('now')) WHERE id = ?`
          ).bind(logId).run().catch(() => {})
        );
      }
      // 1x1 transparent GIF
      const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
      return new Response(gif, {
        headers: {
          'Content-Type': 'image/gif',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    // SMS stats — channel breakdown
    if (path === '/outreach/sms-stats') {
      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) as total_sms,
          SUM(CASE WHEN ol.replied_at IS NOT NULL THEN 1 ELSE 0 END) as sms_replies,
          MIN(ol.sent_at) as first_sent,
          MAX(ol.sent_at) as last_sent
        FROM outreach_logs ol
        WHERE ol.channel = 'sms' AND ol.direction = 'out'
      `).first();
      const perVenue = await env.DB.prepare(`
        SELECT v.name, ol.body, ol.sent_at, ol.replied_at
        FROM outreach_logs ol
        JOIN venues v ON v.id = ol.venue_id
        WHERE ol.channel = 'sms' AND ol.direction = 'out'
        ORDER BY ol.sent_at DESC
        LIMIT 50
      `).all();
      return new Response(JSON.stringify({ stats, messages: perVenue.results || [] }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Instagram DM queue — pending DMs for Drew to send manually
    if (path === '/outreach/dm-queue') {
      const pending = await env.DB.prepare(`
        SELECT * FROM instagram_dm_queue
        WHERE status = 'pending'
        ORDER BY created_at DESC
      `).all();
      const sent = await env.DB.prepare(`
        SELECT * FROM instagram_dm_queue
        WHERE status = 'sent'
        ORDER BY sent_at DESC
        LIMIT 20
      `).all();
      return new Response(JSON.stringify({
        pending: pending.results || [],
        sent: sent.results || [],
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Mark an Instagram DM as sent (Drew copy-pasted and sent it)
    if (path === '/outreach/dm-queue/mark-sent' && request.method === 'POST') {
      const { id } = await request.json();
      await env.DB.prepare(`
        UPDATE instagram_dm_queue SET status = 'sent', sent_at = datetime('now') WHERE id = ?
      `).bind(id).run();
      // Also log it in outreach_logs for funnel tracking
      const dm = await env.DB.prepare(`SELECT * FROM instagram_dm_queue WHERE id = ?`).bind(id).first();
      if (dm) {
        await env.DB.prepare(`
          INSERT INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, sent_at, created_at
          ) VALUES (?, ?, 4, 'instagram_dm', 'out', 'Instagram DM', ?, ?, ?, 'approved', datetime('now'), datetime('now'))
        `).bind(crypto.randomUUID(), dm.venue_id, dm.message, env.FROM_EMAIL, dm.instagram_handle).run();
      }
      return new Response(JSON.stringify({ marked: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Skip/dismiss an Instagram DM
    if (path === '/outreach/dm-queue/skip' && request.method === 'POST') {
      const { id } = await request.json();
      await env.DB.prepare(`
        UPDATE instagram_dm_queue SET status = 'skipped' WHERE id = ?
      `).bind(id).run();
      return new Response(JSON.stringify({ skipped: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Bulk verify phones — scans all venues with contact_phone, applies heuristic, sets verified flag
    if (path === '/outreach/verify-phones' && request.method === 'POST') {
      const unverified = await env.DB.prepare(`
        SELECT id, name, contact_phone FROM venues
        WHERE contact_phone IS NOT NULL AND contact_phone != ''
          AND contact_phone_verified = 0 AND sms_opt_out = 0
      `).all();
      let verified = 0, skipped = 0;
      for (const v of (unverified.results || [])) {
        const clean = (v.contact_phone || '').replace(/[^0-9]/g, '').replace(/^1/, '');
        // Heuristic: must be 10 digits, not toll-free, not PBX-like endings
        const isMobile = clean.length === 10
          && !['800','888','877','866','855','844'].includes(clean.slice(0,3))
          && !clean.endsWith('0000') && !clean.endsWith('00');
        if (isMobile) {
          await env.DB.prepare(
            `UPDATE venues SET contact_phone_verified = 1, updated_at = datetime('now') WHERE id = ?`
          ).bind(v.id).run();
          verified++;
        } else {
          skipped++;
        }
      }
      return new Response(JSON.stringify({ verified, skipped, total: (unverified.results || []).length }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Performance funnel — full pipeline metrics (sent → opened → replied → meeting → account)
    if (path === '/outreach/funnel') {
      const period = url.searchParams.get('period') || '30'; // days
      const [funnel, weekly, topCategories, saturation, channelBreakdown] = await Promise.all([
        env.DB.prepare(`
          SELECT
            COUNT(DISTINCT CASE WHEN v.status != 'prospect' OR o.id IS NOT NULL THEN v.id END) as total_reached,
            COUNT(DISTINCT CASE WHEN o.sent_at IS NOT NULL THEN o.venue_id END) as sent,
            COUNT(DISTINCT CASE WHEN o.opened_at IS NOT NULL THEN o.venue_id END) as opened,
            COUNT(DISTINCT CASE WHEN o.replied_at IS NOT NULL THEN o.venue_id END) as replied,
            COUNT(DISTINCT CASE WHEN o.outcome LIKE '%meeting%' OR o.outcome LIKE '%interested%' THEN o.venue_id END) as positive,
            COUNT(DISTINCT CASE WHEN v.status = 'active' THEN v.id END) as active_accounts,
            ROUND(100.0 * COUNT(DISTINCT CASE WHEN o.replied_at IS NOT NULL THEN o.venue_id END) /
              NULLIF(COUNT(DISTINCT CASE WHEN o.sent_at IS NOT NULL THEN o.venue_id END), 0), 1) as reply_rate_pct,
            ROUND(AVG(CASE WHEN o.self_score IS NOT NULL THEN o.self_score END), 1) as avg_score
          FROM venues v
          LEFT JOIN outreach_logs o ON o.venue_id = v.id AND o.direction = 'out'
            AND o.sent_at >= date('now', '-' || ? || ' days')
          WHERE v.tier <= 2
        `).bind(period).first(),
        env.DB.prepare(`
          SELECT
            strftime('%Y-W%W', o.sent_at) as week,
            COUNT(*) as sent,
            SUM(CASE WHEN o.replied_at IS NOT NULL THEN 1 ELSE 0 END) as replies,
            SUM(CASE WHEN o.sequence_step = 1 THEN 1 ELSE 0 END) as first_touch,
            SUM(CASE WHEN o.sequence_step > 1 THEN 1 ELSE 0 END) as followups,
            ROUND(AVG(o.self_score), 1) as avg_score
          FROM outreach_logs o
          WHERE o.direction = 'out' AND o.sent_at IS NOT NULL
            AND o.sent_at >= date('now', '-90 days')
          GROUP BY week ORDER BY week DESC LIMIT 12
        `).all(),
        env.DB.prepare(`
          SELECT v.category, COUNT(DISTINCT o.venue_id) as sent,
            SUM(CASE WHEN o.replied_at IS NOT NULL THEN 1 ELSE 0 END) as replies,
            ROUND(100.0 * SUM(CASE WHEN o.replied_at IS NOT NULL THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) as reply_rate
          FROM outreach_logs o JOIN venues v ON v.id = o.venue_id
          WHERE o.direction = 'out' AND o.sent_at IS NOT NULL AND o.sequence_step = 1
          GROUP BY v.category ORDER BY replies DESC
        `).all(),
        env.DB.prepare(`
          SELECT
            COUNT(*) as total_venues,
            SUM(CASE WHEN tier <= 2 THEN 1 ELSE 0 END) as tier_1_2,
            SUM(CASE WHEN status = 'contacted' OR status = 'replied' OR status = 'active' THEN 1 ELSE 0 END) as reached,
            SUM(CASE WHEN status = 'prospect' AND tier <= 2 THEN 1 ELSE 0 END) as remaining_prospects,
            ROUND(100.0 * SUM(CASE WHEN status IN ('contacted','replied','active') THEN 1 ELSE 0 END) /
              NULLIF(SUM(CASE WHEN tier <= 2 THEN 1 ELSE 0 END), 0), 1) as penetration_pct
          FROM venues
        `).first(),
        env.DB.prepare(`
          SELECT
            COALESCE(channel, 'email') as channel,
            COUNT(*) as total,
            SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) as replies,
            SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opens
          FROM outreach_logs
          WHERE direction = 'out' AND sent_at IS NOT NULL
            AND sent_at >= date('now', '-' || ? || ' days')
          GROUP BY COALESCE(channel, 'email')
        `).bind(period).all(),
      ]);
      return new Response(JSON.stringify({
        funnel: funnel || {},
        weekly_trend: weekly.results || [],
        by_category: topCategories.results || [],
        saturation: saturation || {},
        by_channel: channelBreakdown.results || [],
        period_days: parseInt(period),
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Drew approves a parked email
    if (path === '/outreach/approve' && request.method === 'POST') {
      const body = await request.json();
      return approveAndSend(body.log_id, env);
    }

    // Approve all pending emails at once (bulk send)
    if (path === '/outreach/approve-all' && request.method === 'POST') {
      const pending = await env.DB.prepare(`
        SELECT id FROM outreach_logs WHERE approval_status = 'pending' AND direction = 'out'
      `).all();
      const results = [];
      for (const row of (pending.results || [])) {
        try {
          const r = await approveAndSend(row.id, env);
          const j = await r.json();
          results.push({ id: row.id, ...j });
        } catch (e) {
          results.push({ id: row.id, error: e.message });
        }
      }
      return new Response(JSON.stringify({ sent: results.filter(r => r.sent).length, results }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Approve with edits — captures voice corrections for optimizer
    if (path === '/outreach/approve-edit' && request.method === 'POST') {
      const body = await request.json();
      const { log_id, subject, body: newBody } = body;
      if (!log_id) return new Response(JSON.stringify({ error: 'log_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

      // Fetch original to diff
      const original = await env.DB.prepare(
        `SELECT subject, body, venue_id, self_score FROM outreach_logs WHERE id = ?`
      ).bind(log_id).first();
      if (!original) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

      const subjectChanged = subject && subject !== original.subject;
      const bodyChanged = newBody && newBody !== original.body;

      // Update the email with Drew's edits
      if (subjectChanged || bodyChanged) {
        await env.DB.prepare(`
          UPDATE outreach_logs SET
            subject = COALESCE(?, subject),
            body = COALESCE(?, body)
          WHERE id = ?
        `).bind(subject || null, newBody || null, log_id).run();

        // Capture voice correction for optimizer
        await env.DB.prepare(`
          INSERT INTO voice_corrections (id, log_id, venue_id, original_subject, edited_subject, original_body, edited_body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          crypto.randomUUID(), log_id, original.venue_id,
          subjectChanged ? original.subject : null, subjectChanged ? subject : null,
          bodyChanged ? original.body : null, bodyChanged ? newBody : null
        ).run().catch(err => {
          // Table might not exist yet — log but don't block the send
          console.error('[Outreach] voice_corrections insert failed (table may need migration):', err.message);
        });
      }

      // Now approve and send the edited version
      return approveAndSend(log_id, env);
    }

    // Redraft an email with Drew's feedback
    if (path === '/outreach/redraft' && request.method === 'POST') {
      const body = await request.json();
      return redraftEmail(body.log_id, body.feedback, env);
    }

    // Sent email history with reply counts
    if (path === '/outreach/sent') {
      const sent = await env.DB.prepare(`
        SELECT o.id, o.subject, o.body, o.sent_at, o.self_score, o.agent_reasoning,
               o.gmail_thread_id, o.to_address,
               v.name as venue_name, v.category, v.campaign,
               (SELECT COUNT(*) FROM inbound_replies ir
                WHERE ir.gmail_thread_id = o.gmail_thread_id) as reply_count,
               (SELECT MAX(ir.received_at) FROM inbound_replies ir
                WHERE ir.gmail_thread_id = o.gmail_thread_id) as last_reply_at,
               (SELECT ir.classification FROM inbound_replies ir
                WHERE ir.gmail_thread_id = o.gmail_thread_id
                ORDER BY ir.received_at DESC LIMIT 1) as reply_classification
        FROM outreach_logs o
        JOIN venues v ON v.id = o.venue_id
        WHERE o.approval_status = 'approved' AND o.direction = 'out' AND o.sent_at IS NOT NULL
        ORDER BY
          CASE WHEN EXISTS(SELECT 1 FROM inbound_replies ir WHERE ir.gmail_thread_id = o.gmail_thread_id) THEN 0 ELSE 1 END,
          o.sent_at DESC
        LIMIT 50
      `).all();
      return new Response(JSON.stringify(sent.results || []), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Open inbound replies — for dashboard inbox section
    if (path === '/outreach/replies') {
      const replies = await env.DB.prepare(`
        SELECT ir.id, ir.from_email, ir.from_name, ir.subject, ir.body_text,
               ir.received_at, ir.classification, ir.sentiment, ir.urgency,
               ir.suggested_subject, ir.suggested_reply, ir.status,
               v.name as venue_name, v.category
        FROM inbound_replies ir
        LEFT JOIN venues v ON v.id = ir.venue_id
        WHERE ir.status = 'open'
        ORDER BY ir.urgency DESC, ir.received_at DESC
        LIMIT 30
      `).all();
      return new Response(JSON.stringify(replies.results || []), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Drew rejects / edits a parked email
    if (path === '/outreach/reject' && request.method === 'POST') {
      const body = await request.json();
      return rejectEmail(body.log_id, body.note, env);
    }

    // Natural language lead search — stub (Phase B)
    if (path === '/outreach/find-leads' && request.method === 'POST') {
      return new Response(JSON.stringify({ leads: [], message: 'Natural language search coming soon' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Kanban status update — move venue between pipeline stages
    if (path === '/pipeline/status' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { venue_id, status } = body;
      const validStatuses = ['prospect', 'researching', 'qualified', 'contacted', 'replied', 'trial', 'active', 'inactive'];
      if (!venue_id || !validStatuses.includes(status)) {
        return new Response(JSON.stringify({ error: 'venue_id and valid status required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }
      await env.DB.prepare(
        `UPDATE venues SET status = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(status, venue_id).run();
      return new Response(JSON.stringify({ ok: true, venue_id, status }), {
        headers: { 'Content-Type': 'application/json' }
      });
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
      const inWarmup = weeksSinceDeploy < cfg(env).warmupWeeks;

      // Fresh leads (never contacted)
      // Summer_2026 campaign venues bypass warmup tier restriction — time-critical, all go through approval gate
      const fresh = await env.DB.prepare(`
        SELECT v.id, v.name, v.category, v.campaign, v.tier, v.qual_score,
               v.contact_name, v.contact_email, v.contact_title, v.website, v.notes, v.status
        FROM venues v
        WHERE (
          (v.status IN ('prospect', 'qualified') AND v.tier ${inWarmup ? '= 2' : 'IN (1, 2)'})
          OR
          (v.campaign = 'summer_2026' AND v.status = 'prospect')
        )
          AND v.id NOT IN (
            SELECT venue_id FROM outreach_holds WHERE active = 1
          )
        ORDER BY
          CASE WHEN v.campaign = 'summer_2026' THEN 0 ELSE 1 END,
          v.tier ASC,
          CASE WHEN v.qual_score IS NULL THEN 0 ELSE v.qual_score END DESC
        LIMIT 15
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
        max_sends: cfg(env).maxSends,
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

    // Remove prospect from queue (14-day cooldown)
    if (path === '/outreach/queue/remove' && request.method === 'POST') {
      const { venue_id, reason } = await request.json();
      const holdId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO outreach_holds (id, venue_id, reason, hold_days, expires_at, created_at)
        VALUES (?, ?, ?, 14, datetime('now', '+14 days'), datetime('now'))
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
  const { maxSends, approvalGate, qualityMin } = cfg(env);
  let effectiveMaxSends = maxSends;

  if (growthBrake) {
    effectiveMaxSends = Math.max(1, Math.floor(maxSends / 2));
    console.log(`[Agent] CFO growth_brake=1 — reducing MAX_SENDS from ${maxSends} to ${effectiveMaxSends}`);
  }
  if (outreachDirective) {
    console.log(`[Agent] CFO outreach_directive: ${outreachDirective}`);
  }
  console.log(`[Agent] CFO directive loaded: ${directive ? 'active' : 'none'}`);

  const inWarmup  = isWarmupPeriod(env);
  const sendCount = await getTotalSentCount(env);
  const inGate    = sendCount < approvalGate;

  console.log(`[Agent] Starting. Warmup: ${inWarmup}, Gate: ${inGate}, Sent total: ${sendCount}`);

  // ── SEASONAL AUTO-HOLDS ────────────────────────────────────────────────────
  // Check for out-of-season venues and auto-hold them with resume dates
  const seasonalHolds = await applySeasonalHolds(env);
  if (seasonalHolds > 0) console.log(`[Agent] Applied ${seasonalHolds} seasonal holds`);

  // ── FOLLOW-UPS FIRST (higher ROI than cold outreach) ─────────────────────
  // Day-3 follow-ups: first email sent 3-14 days ago, no reply, no step-2 yet
  const fu3 = await env.DB.prepare(`
    SELECT v.*, ol.subject AS _prior_subject, ol.body AS _prior_body,
           ol.sent_at AS _prior_sent_at, ol.id AS _prior_log_id,
           2 AS _followup_step
    FROM outreach_logs ol
    JOIN venues v ON v.id = ol.venue_id
    LEFT JOIN outreach_holds h ON h.venue_id = v.id AND h.expires_at > datetime('now') AND h.active = 1
    WHERE ol.direction = 'out'
      AND ol.sequence_step = 1
      AND ol.replied_at IS NULL
      AND datetime(ol.sent_at) < datetime('now', '-3 days')
      AND datetime(ol.sent_at) > datetime('now', '-14 days')
      AND v.status = 'contacted'
      AND h.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM outreach_logs ol2
        WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step >= 2 AND ol2.direction = 'out'
      )
    ORDER BY ol.sent_at ASC
    LIMIT ?
  `).bind(Math.max(2, Math.floor(effectiveMaxSends / 2))).all();

  // Day-7 follow-ups: step-2 sent 7-21 days ago, no reply, no step-3 yet
  const fu7 = await env.DB.prepare(`
    SELECT v.*, ol.subject AS _prior_subject, ol.body AS _prior_body,
           ol.sent_at AS _prior_sent_at, ol.id AS _prior_log_id,
           3 AS _followup_step
    FROM outreach_logs ol
    JOIN venues v ON v.id = ol.venue_id
    LEFT JOIN outreach_holds h ON h.venue_id = v.id AND h.expires_at > datetime('now') AND h.active = 1
    WHERE ol.direction = 'out'
      AND ol.sequence_step = 2
      AND ol.replied_at IS NULL
      AND datetime(ol.sent_at) < datetime('now', '-7 days')
      AND datetime(ol.sent_at) > datetime('now', '-21 days')
      AND v.status = 'contacted'
      AND h.id IS NULL
    ORDER BY ol.sent_at ASC
    LIMIT ?
  `).bind(Math.max(1, Math.floor(effectiveMaxSends / 4))).all();

  // Day-14 break-up email: step-3 sent 14-30 days ago, no reply, no step-4 yet
  const fu14 = await env.DB.prepare(`
    SELECT v.*, ol.subject AS _prior_subject, ol.body AS _prior_body,
           ol.sent_at AS _prior_sent_at, ol.id AS _prior_log_id,
           4 AS _followup_step
    FROM outreach_logs ol
    JOIN venues v ON v.id = ol.venue_id
    LEFT JOIN outreach_holds h ON h.venue_id = v.id AND h.expires_at > datetime('now') AND h.active = 1
    WHERE ol.direction = 'out'
      AND ol.sequence_step = 3
      AND ol.replied_at IS NULL
      AND datetime(ol.sent_at) < datetime('now', '-14 days')
      AND datetime(ol.sent_at) > datetime('now', '-30 days')
      AND v.status = 'contacted'
      AND h.id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM outreach_logs ol2
        WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step >= 4 AND ol2.direction = 'out'
      )
    ORDER BY ol.sent_at ASC
    LIMIT ?
  `).bind(Math.max(1, Math.floor(effectiveMaxSends / 4))).all();

  const followups = [...(fu3.results || []), ...(fu7.results || []), ...(fu14.results || [])];
  console.log(`[Agent] Follow-ups ready: ${fu3.results?.length || 0} day-3, ${fu7.results?.length || 0} day-7, ${fu14.results?.length || 0} day-14`);

  // ── FRESH LEADS ────────────────────────────────────────────────────────────
  // Target Tier 1+2 prospects + summer_2026 campaign venues
  // Timing signals from signal scanner get priority (venues with hooks)
  const freshLimit = Math.max(1, effectiveMaxSends - followups.length) * 4; // 4x to account for failures
  const venues = await env.DB.prepare(`
    SELECT v.*, 1 AS _followup_step,
           ts.signal_score AS _signal_score,
           ts.signal_summary AS _signal_summary,
           ts.signal_type AS _signal_type
    FROM venues v
    LEFT JOIN outreach_logs o ON o.venue_id = v.id AND o.direction = 'out'
    LEFT JOIN outreach_holds h ON h.venue_id = v.id AND h.expires_at > datetime('now') AND h.active = 1
    LEFT JOIN timing_signals ts ON ts.venue_id = v.id
      AND ts.consumed_at IS NULL
      AND ts.expires_at > datetime('now')
      AND ts.signal_score >= 6
    WHERE v.status = 'prospect'
      AND v.tier <= 2
      AND o.id IS NULL
      AND h.id IS NULL
    ORDER BY
      CASE WHEN ts.signal_score >= 7 THEN 0 ELSE 1 END,
      CASE WHEN v.campaign = 'summer_2026' THEN 0 ELSE 1 END,
      CASE WHEN v.contact_email IS NOT NULL THEN 0 ELSE 1 END,
      COALESCE(ts.signal_score, 0) DESC,
      v.tier ASC,
      v.qual_score DESC
    LIMIT ?
  `).bind(freshLimit).all();

  // Follow-ups first (higher conversion), then fresh leads
  const candidates = [...followups, ...(venues.results || [])];
  console.log(`[Agent] ${candidates.length} total candidates (${followups.length} follow-ups + ${(venues.results || []).length} fresh)`);

  let processed = 0;
  let sent      = 0;
  let held      = 0;
  let flagged   = 0;
  let followupsSent = 0;
  let freshSent     = 0;

  for (const venue of candidates) {
    if (sent >= effectiveMaxSends) break;

    const isFollowUp = (venue._followup_step || 1) > 1;
    console.log(`[Agent] Processing: ${venue.name} (${venue.campaign || venue.category})${isFollowUp ? ` [follow-up step ${venue._followup_step}]` : ''}`);

    // Load summer-specific prompt from DB — category-aware
    let summerPromptRow = null;
    if (venue.campaign === 'summer_2026') {
      // Follow-up cadence takes priority; first contact uses category-specific prompt
      let promptId;
      if (venue.last_contacted) {
        const daysSince = (Date.now() - new Date(venue.last_contacted).getTime()) / 86400000;
        if (daysSince >= 8) promptId = 'ap_summer_fu2_v2';
        else if (daysSince >= 4) promptId = 'ap_summer_fu1_v2';
      }
      if (!promptId) {
        // First-contact: pick the right angle for this category
        const cat = venue.category || '';
        if (cat === 'golf')                            promptId = 'ap_summer_golf_v1';
        else if (cat === 'brewery')                    promptId = 'ap_summer_brewery_v1';
        else if (cat === 'fairgrounds' || cat === 'other') promptId = 'ap_summer_fair_v1';
        else                                           promptId = 'ap_summer_v2'; // outdoor/summer_venue
      }
      summerPromptRow = await env.DB.prepare(
        `SELECT prompt_text, system_context FROM agent_prompts WHERE id = ? LIMIT 1`
      ).bind(promptId).first();
    }

    const result = await runAgentForVenue(venue, env, false, brainContext, summerPromptRow);

    processed++;
    if (result.action === 'sent' || result.action === 'parked') {
      sent++;
      if (isFollowUp) followupsSent++; else freshSent++;
      // Mark timing signal as consumed so it's not re-used
      if (venue._signal_score >= 6) {
        await env.DB.prepare(
          `UPDATE timing_signals SET consumed_at = datetime('now') WHERE venue_id = ? AND consumed_at IS NULL`
        ).bind(venue.id).run().catch(() => {});
      }
    }
    if (result.action === 'held')    held++;
    if (result.action === 'flagged') flagged++;

    await sleep(2000); // breathing room between venues
  }

  // Update weekly metrics
  await updateWeeklyMetrics(env, { sent, held, flagged });

  // ── SMS NUDGES — venues emailed 24h+ ago, no open, have verified phone ────
  let smsSent = 0;
  const smsLimit = parseInt(env.SMS_DAILY_LIMIT || '5');
  try {
    const smsQueue = await env.DB.prepare(`
      SELECT v.id, v.name, v.contact_phone, v.contact_name,
             ol.id as log_id, ol.subject, ol.sequence_step
      FROM venues v
      JOIN outreach_logs ol ON ol.venue_id = v.id
      WHERE ol.direction = 'out' AND ol.channel = 'email'
        AND ol.sequence_step >= 1
        AND ol.sent_at < datetime('now', '-24 hours')
        AND ol.opened_at IS NULL
        AND ol.replied_at IS NULL
        AND v.contact_phone IS NOT NULL
        AND v.contact_phone_verified = 1
        AND v.sms_opt_out = 0
        AND NOT EXISTS (
          SELECT 1 FROM outreach_logs ol2
          WHERE ol2.venue_id = v.id AND ol2.channel = 'sms'
            AND ol2.sequence_step = ol.sequence_step
        )
      ORDER BY ol.sent_at ASC
      LIMIT ?
    `).bind(smsLimit).all();

    for (const row of (smsQueue.results || [])) {
      try {
        const firstName = (row.contact_name || '').split(' ')[0] || 'there';
        const isFollowupNudge = row.sequence_step >= 2;
        const template = isFollowupNudge
          ? SMS_TEMPLATES.nudge_after_followup
          : SMS_TEMPLATES.nudge_after_email;
        const smsBody = template
          .replace('{first_name}', firstName)
          .replace('{venue}', row.name || 'your venue');

        const smsLogId = crypto.randomUUID();
        await sendSMS(env, { to: row.contact_phone, body: smsBody, venueId: row.id, logId: smsLogId });

        // Log the SMS in outreach_logs with channel='sms'
        await env.DB.prepare(`
          INSERT INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, sent_at, created_at
          ) VALUES (?, ?, ?, 'sms', 'out', 'SMS nudge', ?, ?, ?, 'approved', datetime('now'), datetime('now'))
        `).bind(
          smsLogId, row.id, row.sequence_step,
          smsBody, env.FROM_EMAIL, row.contact_phone
        ).run();

        smsSent++;
        console.log(`[SMS] Nudge sent to ${row.name}`);
        await sleep(1000);
      } catch (err) {
        console.error(`[SMS] Failed for ${row.name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[SMS] Nudge query error: ${err.message}`);
  }

  // ── INSTAGRAM DM DRAFTS — venues at day 7+, no reply, have IG handle ──────
  let dmsDrafted = 0;
  const dmLimit = parseInt(env.IG_DM_DAILY_LIMIT || '3');
  try {
    const dmQueue = await env.DB.prepare(`
      SELECT v.id, v.name, v.instagram, v.category, v.contact_name,
             ol.subject, ol.body, ol.sequence_step,
             MAX(ol.sent_at) as last_sent_at
      FROM venues v
      JOIN outreach_logs ol ON ol.venue_id = v.id
      WHERE ol.direction = 'out' AND ol.channel = 'email'
        AND ol.sequence_step >= 2
        AND ol.sent_at < datetime('now', '-7 days')
        AND ol.replied_at IS NULL
        AND v.instagram IS NOT NULL AND v.instagram != ''
        AND v.status = 'contacted'
        AND NOT EXISTS (
          SELECT 1 FROM instagram_dm_queue dq
          WHERE dq.venue_id = v.id
        )
      GROUP BY v.id
      ORDER BY ol.sent_at ASC
      LIMIT ?
    `).bind(dmLimit).all();

    for (const row of (dmQueue.results || [])) {
      const firstName = (row.contact_name || '').split(' ')[0] || '';
      const greeting = firstName ? `Hey ${firstName}!` : 'Hey!';
      const dmMessage = `${greeting} Drew from Dangerous Pretzel here — we make soft pretzels for places like yours. Curious if you'd be down to try some at ${row.name}? Happy to drop off a free sample box 🥨`;

      await env.DB.prepare(`
        INSERT INTO instagram_dm_queue (id, venue_id, venue_name, instagram_handle, message, sequence_context, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).bind(
        crypto.randomUUID(),
        row.id,
        row.name,
        row.instagram,
        dmMessage,
        `After ${row.sequence_step} emails over ${Math.round((Date.now() - new Date(row.last_sent_at).getTime()) / 86400000)}d, no reply`
      ).run();

      dmsDrafted++;
      console.log(`[DM] Drafted IG message for ${row.name} (@${row.instagram})`);
    }
  } catch (err) {
    console.error(`[DM] Draft query error: ${err.message}`);
  }

  console.log(`[Agent] Done. Processed: ${processed}, Sent/Parked: ${sent} (${freshSent} fresh, ${followupsSent} follow-ups), Held: ${held}, Flagged: ${flagged}, SMS: ${smsSent}, DM drafts: ${dmsDrafted}`);
  return { processed, sent, held, flagged, followups_sent: followupsSent, fresh_sent: freshSent, sms_sent: smsSent, dms_drafted: dmsDrafted, warmup: inWarmup, gate: inGate };
}

// ── AGENT LOOP FOR ONE VENUE ──────────────────────────────────────────────────
async function runAgentForVenue(venue, env, dryRun = false, brainContext = '', summerPromptRow = null) {
  const isSummerVenue = venue.campaign === 'summer_2026';

  // Build summer-specific instructions — category-aware so golf/brewery/fairground
  // get the RIGHT social proof and CTA, not a mismatched Sandy Amphitheater drop
  const venueCat = venue.category || '';
  const summerContext = isSummerVenue
    ? `\n\nSUMMER 2026 CAMPAIGN RULES:
- This is a summer 2026 campaign venue. Use the summer pitch, not the standard one.
- If contact_email is missing, call find_venue_contact FIRST before anything else.
- If find_venue_contact returns found=false (Instagram only), DO NOT draft an email. Return hold_venue with reason "needs_instagram_dm".
- Email MUST be under 130 words. Always include 801.916.9122.

CATEGORY-SPECIFIC GUIDANCE (category: ${venueCat}):
${venueCat === 'golf'
  ? `- Golf club pitch: "19th hole" angle. Free warmer, pretzels wholesale, no kitchen needed. Social proof: Delta Center (NBA arena), SLC Bees stadium. CTA: drop samples by, or send a warmer to try for a weekend. Never mention Sandy Amphitheater.`
  : venueCat === 'brewery'
  ? `- Brewery pitch: We already do this with TF Brewery, Hopkins Brewery, ROHA Brewing, HK Brewing in SLC. Beer + pretzel is a natural pairing — their patrons loved them and keep coming back. Super easy to offer. CTA: "could I just drop some off for the team to try?" Never mention Sandy Amphitheater for breweries.`
  : venueCat === 'fairgrounds' || venueCat === 'other'
  ? `- Fairgrounds/events pitch: We're already at high-volume venues like Delta Center and Sandy Amphitheater — pretzels are exactly the kind of food that works at outdoor events. People love them, they're easy to serve, and we handle everything. CTA: "could I bring some by before your next event?"`
  : `- Outdoor venue pitch: We're already at Sandy Amphitheater and Delta Center. Concert crowds love them — something unique, people talk about it, come back for it. We supply everything, super easy to add. CTA: "could I bring some by for the team to try?"`}

- Use the summer email template: ${summerPromptRow?.system_context || 'trial run closer, May urgency, free warmer'}
- Draft prompt to use: ${summerPromptRow?.prompt_text ? '(loaded from DB — see draft_and_evaluate_email)' : 'standard summer pitch'}`
    : '';

  // Build follow-up context if this is a Day-3 or Day-7 follow-up
  const isFollowUp = (venue._followup_step || 1) > 1;
  const followUpContext = isFollowUp ? `

FOLLOW-UP EMAIL (sequence step ${venue._followup_step}):
This venue was already contacted. You are writing a ${venue._followup_step === 2 ? 'Day-3' : venue._followup_step === 3 ? 'Day-7' : 'Day-14 break-up'} follow-up.

Prior email sent on ${venue._prior_sent_at}:
Subject: ${venue._prior_subject}
Body: ${venue._prior_body}

FOLLOW-UP RULES:
- Keep it SHORT (2-4 sentences max). This is a bump, not a new pitch.
- Reference the prior email casually ("Just bumping this up" / "Wanted to circle back")
- ${venue._followup_step === 2
    ? 'Day-3 tone: Light, casual, add one new detail or angle. "Hey, quick follow-up — [new hook]. Would love to drop some by."'
    : venue._followup_step === 3
    ? 'Day-7 tone: Final touch, no pressure. "Totally get it if the timing\'s off — just wanted to make sure this didn\'t get buried. Happy to chat whenever."'
    : 'Day-14 BREAK-UP tone: This is the LAST email. Gracious, zero pressure, leave the door open. "Hey — not trying to fill your inbox. Just wanted to say the offer stands whenever timing works. No hard feelings either way. Happy to chat anytime." Sign off warm. This email should make them WANT to reply because you\'re NOT pushing.'}
- Do NOT re-pitch everything. The first email did that.
- Use the SAME contact_email as the prior email.
- Skip fetch_venue_website — you already researched this venue.
- Start with check_contact_history, then draft_and_evaluate_email, then send_or_park_email.` : '';

  // Build timing signal context if signal scanner found a hook for this venue
  const signalContext = venue._signal_score >= 6
    ? `\n\nTIMING SIGNAL (score ${venue._signal_score}/10, source: ${venue._signal_type}):
${venue._signal_summary}

USE THIS SIGNAL as the hook angle for your email. This is a real, recent insight about this venue — reference it specifically in the opening line. This is what makes the email land right now instead of next month.`
    : '';

  const messages = [
    {
      role: 'user',
      content: `${isFollowUp ? 'Write a follow-up email' : 'Research and decide how to handle outreach'} for this venue.

Venue details:
${JSON.stringify({
  id:             venue.id,
  name:           venue.name,
  category:       venue.category,
  campaign:       venue.campaign,
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
}, null, 2)}${summerContext}${followUpContext}${signalContext}

${isFollowUp
  ? 'Check contact history, then draft and send the follow-up. Keep it brief and natural.'
  : `Use your tools to research this venue, check for hold signals, and make a decision.
Start with check_contact_history${!venue.contact_email ? ', then find_venue_contact (contact email is missing — find it before drafting)' : venue.website ? ', then fetch_venue_website' : ''}.
Only draft and send if you're confident the timing and angle are right.`}`
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
        const result = await executeTool(toolUse.name, toolUse.input, venue, env, dryRun, summerPromptRow);
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
async function executeTool(toolName, input, venue, env, dryRun, summerPromptRow = null) {
  switch (toolName) {

    case 'fetch_venue_website': {
      if (!input.url) return { error: 'No URL provided' };

      // Try Cloudflare Browser Rendering first — handles React SPAs and bot-protected sites
      if (env.CF_API_TOKEN) {
        try {
          const crawlResp = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/f399e3bcd5ea1501830d0ad1d35d9da3/browser-rendering/content`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: input.url }),
              signal: AbortSignal.timeout(20000),
            }
          );
          if (crawlResp.ok) {
            const data = await crawlResp.json();
            const text = (typeof data.result === 'string' ? data.result : data.result?.content || data.content || '')
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
            if (text.length > 100) return { content: text, url: input.url, via: 'browser_rendering' };
          }
        } catch { /* fall through to raw fetch */ }
      }

      // Fallback: raw fetch (works for static/SSR sites)
      try {
        const response = await fetch(input.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        const html = await response.text();
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);
        return { content: text, url: input.url, via: 'raw_fetch' };
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
      // Summer venues use a DB-loaded prompt with strict requirements
      const isSummerDraft = input.venue_category === 'summer_venue';

      // ── Pull similar sent emails from Vectorize for voice matching ──
      let voiceExamples = '';
      if (env.VECTORIZE && env.AI) {
        try {
          const queryText = `${input.venue_category || ''} ${input.hook_angle || ''} ${input.venue_name || ''}`.trim();
          const embResult = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [queryText] });
          const vector = embResult?.data?.[0];
          if (vector) {
            const results = await env.VECTORIZE.query(vector, { topK: 3, returnMetadata: true });
            const matches = (results?.matches || []).filter(m => m.score > 0.7);
            if (matches.length > 0) {
              voiceExamples = '\n\nHere are ' + matches.length + ' real emails Drew sent that scored well — match this voice exactly:\n\n' +
                matches.map((m, i) => `--- Example ${i + 1} (score ${m.metadata?.self_score}/10 to ${m.metadata?.venue_name || 'venue'}) ---\nSubject: ${m.metadata?.subject || ''}\n${m.metadata?.body_preview || ''}`).join('\n\n');
            }
          }
        } catch { /* Vectorize unavailable — skip examples */ }
      }

      const BANNED_PHRASES_REMINDER = '\n\nCRITICAL: Do NOT use any of these phrases: "I hope this finds you well", "I wanted to reach out", "exciting opportunity", "touch base", "synergies", "value proposition", "Please don\'t hesitate", "Looking forward to hearing from you". Any of these = rewrite. Use the Quarters email template structure: fan opener → social proof → 3 labeled bullets → samples + trial CTA → Drew signature.';

      const draftPrompt = isSummerDraft && summerPromptRow?.prompt_text
        ? summerPromptRow.prompt_text
            .replace('{{venue_name}}', input.venue_name)
            .replace('{{city}}', input.city || '')
            .replace('{{contact_name}}', input.contact_name || 'the team')
            .replace('{{contact_title}}', input.contact_title || '')
            .replace('{{research_notes}}', input.research_summary) + BANNED_PHRASES_REMINDER + voiceExamples
        : (() => {
          // A/B subject line variant — deterministic per venue
          const variant = getABVariant(input.venue_id);
          const variantHint = AB_VARIANTS[variant]?.hint || '';
          // Stash variant on the venue object so send_or_park can log it
          venue._ab_variant = variant;
          return `Write a cold email for Dangerous Pretzel Co using the EXACT template structure from your instructions.

Venue: ${input.venue_name} (${input.venue_category})
Contact: ${input.contact_name || null}
Hook angle: ${input.hook_angle}
Research: ${input.research_summary}${voiceExamples}

SUBJECT LINE A/B TEST — you MUST follow this variant:
${variantHint}

REQUIRED STRUCTURE — follow this precisely:
1. Subject: Follow the A/B variant instruction above. NEVER salesy.
2. Greeting: "Hi [Name]," (use contact name if known, "Hi there," if not)
3. Fan opener: 1 sentence. Genuine, specific to this venue.
4. Social proof + product: 1-2 sentences. Weave in one anchor account naturally. "2'x2' warmer; your staff just warms, salts, and serves."
5. "Why it fits [Venue]:" header + 3 bullets. Each bullet labeled (e.g. "Late-Night Crowd:", "No Kitchen Needed:", "High Margin:"). One bullet must include real numbers ($10 retail / $6 profit).
6. CTA: Offer to drop samples + 2-week trial. One specific question.
7. Sign-off: "Best,\\n\\n--\\nDrew Sparks\\nOwner\\nDangerous Pretzel Co\\nc: 801.916.9122"

BANNED (instant rewrite): "I hope this finds you well", "I wanted to reach out", "exciting opportunity", "touch base", "synergies", "value proposition", "Please don't hesitate", "Looking forward to hearing from you", any sentence over 25 words.

After writing, score it 1-10 on:
- Specificity (1-10): Does every sentence reference THIS venue specifically? Are the 3 bullets tailored to their exact venue type?
- Voice (1-10): Does it sound like Drew texting a friend, not a sales rep? Any banned phrases = instant 4 or below.
- Friction (1-10): Is the CTA a yes/no question with no homework required for the recipient?
- Hook (1-10): Would YOU open this email if you ran this venue? Is the subject line human, not spammy?

If any score is below 7, rewrite the email once.

Return JSON:
{
  "subject": "...",
  "body": "...",
  "self_score": 8,
  "score_breakdown": {"specificity": 8, "voice": 9, "friction": 8, "hook": 7},
  "rewritten": false
}`; })()

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

      if (input.self_score < cfg(env).qualityMin) {
        return {
          action: 'held',
          reason: `Draft quality score ${input.self_score} below minimum ${cfg(env).qualityMin}`,
        };
      }

      // Summer venue quality gate — category-aware checks
      if (venue.campaign === 'summer_2026') {
        const bodyLower = (input.body || '').toLowerCase();
        const cat = venue.category || '';

        // All summer emails: must have phone or frictionless CTA
        const hasCTA = bodyLower.includes('801') || bodyLower.includes('samples') ||
                       bodyLower.includes('drop by') || bodyLower.includes('trial') ||
                       bodyLower.includes('warmer') || bodyLower.includes('swing by');
        if (!hasCTA) {
          return { action: 'held', reason: 'Summer email missing CTA — must include phone, samples offer, trial, or drop-by. Re-draft.' };
        }

        // Golf clubs: must NOT mention Sandy (wrong social proof)
        if (cat === 'golf' && bodyLower.includes('sandy amphitheater')) {
          return { action: 'held', reason: 'Golf email incorrectly mentions Sandy Amphitheater — use Delta Center or SLC Bees as social proof instead.' };
        }

        // Outdoor/amphitheater venues: must mention Sandy OR a known anchor account
        if (cat === 'summer_venue' || cat === 'stadium') {
          const hasAnchor = bodyLower.includes('sandy') || bodyLower.includes('delta center') ||
                            bodyLower.includes('powder mountain') || bodyLower.includes('bees');
          if (!hasAnchor) {
            return { action: 'held', reason: 'Summer venue email missing social proof anchor — mention Sandy Amphitheater, Delta Center, or Powder Mountain.' };
          }
        }

        // Breweries: must mention a brewery account or beer pairing angle
        if (cat === 'brewery') {
          const hasBrewRef = bodyLower.includes('brewery') || bodyLower.includes('brewing') ||
                             bodyLower.includes('taproom') || bodyLower.includes('beer') ||
                             bodyLower.includes('tf ') || bodyLower.includes('hopkins') ||
                             bodyLower.includes('roha') || bodyLower.includes('hk ');
          if (!hasBrewRef) {
            return { action: 'held', reason: 'Brewery email missing brewery-specific angle — mention taproom, beer pairing, or existing brewery accounts.' };
          }
        }
      }

      // Append P.S. link to pretzel-program page for summer venues
      if (venue.campaign === 'summer_2026' && input.body && !input.body.includes('pretzel-program')) {
        input.body = input.body.trimEnd() + '\n\nP.S. See how other venues are doing it: program.dangerouspretzel.com/pretzel-program';
      }

      // Deduplicate: skip if venue already has a pending email in the queue
      const existingPending = await env.DB.prepare(`
        SELECT id FROM outreach_logs
        WHERE venue_id = ? AND approval_status = 'pending' AND direction = 'out'
        LIMIT 1
      `).bind(input.venue_id).first();
      if (existingPending) {
        return { action: 'skipped', reason: 'Venue already has a pending email awaiting approval', existing_id: existingPending.id };
      }

      const totalSent = await getTotalSentCount(env);
      const inGate    = totalSent < cfg(env).approvalGate;
      const logId     = crypto.randomUUID();
      const seqStep   = venue._followup_step || 1;
      const abVariant = venue._ab_variant || null; // A/B subject line variant

      if (inGate) {
        // Spawn durable Workflow — handles D1 write + approval email + send atomically
        // No duplicate sends: waitForEvent is atomic, step.do() is idempotent on retry
        if (env.OUTREACH_WORKFLOW) {
          try {
            await env.OUTREACH_WORKFLOW.create({
              id: logId,
              params: {
                logId,
                venueId: input.venue_id,
                venueName: venue.name || input.venue_id,
                contactEmail: venue.contact_email || input.contact_email,
                subject: input.subject,
                body: input.body,
                selfScore: input.self_score,
                reasoning: input.reasoning,
                channel: 'outreach',
                sequenceStep: seqStep,
                subjectVariant: abVariant,
              },
            });
          } catch (err) {
            // Workflow not available — fall back to legacy D1 park
            console.error('[Outreach] Workflow spawn failed, falling back to D1 park:', err.message);
            await env.DB.prepare(`
              INSERT INTO outreach_logs (
                id, venue_id, sequence_step, channel, direction,
                subject, body, from_address, to_address,
                approval_status, agent_reasoning, self_score,
                subject_variant, created_at
              ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
            `).bind(
              logId, input.venue_id, seqStep, input.subject, input.body,
              env.FROM_EMAIL, venue.contact_email,
              input.reasoning, input.self_score, abVariant
            ).run();
            await sendApprovalRequestEmail({
              logId,
              venueName: venue.name || input.venue_id,
              contactEmail: venue.contact_email || input.contact_email,
              subject: input.subject, body: input.body,
              selfScore: input.self_score, reasoning: input.reasoning,
              channel: 'outreach',
            }, env).catch(e => console.error('[Outreach] Fallback approval email failed:', e.message));
          }
        } else {
          // Legacy path (no Workflow binding)
          await env.DB.prepare(`
            INSERT INTO outreach_logs (
              id, venue_id, sequence_step, channel, direction,
              subject, body, from_address, to_address,
              approval_status, agent_reasoning, self_score,
              subject_variant, created_at
            ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
          `).bind(
            logId, input.venue_id, seqStep, input.subject, input.body,
            env.FROM_EMAIL, venue.contact_email,
            input.reasoning, input.self_score, abVariant
          ).run();
          await sendApprovalRequestEmail({
            logId,
            venueName: venue.name || input.venue_id,
            contactEmail: venue.contact_email || input.contact_email,
            subject: input.subject, body: input.body,
            selfScore: input.self_score, reasoning: input.reasoning,
            channel: 'outreach',
          }, env).catch(e => console.error('[Outreach] Approval email failed:', e.message));
        }

        return { action: 'parked', log_id: logId, reason: 'Human approval gate active' };

      } else {
        // Send directly
        const gmailResult = await sendGmail(env, {
          to:      venue.contact_email,
          subject: input.subject,
          body:    input.body,
          logId,
        });

        await env.DB.prepare(`
          INSERT INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            gmail_thread_id, gmail_message_id,
            approval_status, agent_reasoning, self_score,
            subject_variant, sent_at, created_at
          ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, ?, ?, 'auto_sent', ?, ?, ?, datetime('now'), datetime('now'))
        `).bind(
          logId, input.venue_id, seqStep, input.subject, input.body,
          env.FROM_EMAIL, venue.contact_email,
          gmailResult.threadId || null, gmailResult.id || null,
          input.reasoning, input.self_score, abVariant
        ).run();

        await env.DB.prepare(`
          UPDATE venues
          SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).bind(input.venue_id).run();

        // Auto-embed into Vectorize for future voice matching (fire-and-forget)
        if (env.VECTORIZE && env.AI && input.self_score >= 7) {
          fetch(`${env.WORKER_URL || 'https://pretzel-os.drew-f39.workers.dev'}/account/voice-embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ log_id: logId }),
          }).catch(() => {});
        }

        return { action: 'sent', log_id: logId, gmail_id: gmailResult.id };
      }
    }

    case 'find_venue_contact':       // new universal tool
    case 'find_summer_venue_contact': { // legacy alias
      const { venue_id, venue_name, venue_website } = input;
      let foundPhone = null; // collect phone across all pages

      // Step 1: Try website pages for email + phone
      const pagesToTry = [
        venue_website,
        venue_website ? `${venue_website.replace(/\/$/, '')}/about` : null,
        venue_website ? `${venue_website.replace(/\/$/, '')}/staff` : null,
        venue_website ? `${venue_website.replace(/\/$/, '')}/team` : null,
        venue_website ? `${venue_website.replace(/\/$/, '')}/contact` : null,
      ].filter(Boolean);

      for (const url of pagesToTry) {
        try {
          let text = null;

          // Try Browser Rendering first (handles React SPAs + bot protection)
          if (env.CF_API_TOKEN) {
            try {
              const crawlResp = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/f399e3bcd5ea1501830d0ad1d35d9da3/browser-rendering/content`,
                {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url }),
                  signal: AbortSignal.timeout(20000),
                }
              );
              if (crawlResp.ok) {
                const data = await crawlResp.json();
                text = (typeof data.result === 'string' ? data.result : data.result?.content || data.content || '')
                  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              }
            } catch { /* fall through to raw fetch */ }
          }

          // Fallback: raw fetch
          if (!text) {
            const r = await fetch(url, {
              signal: AbortSignal.timeout(6000),
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DangerousPretzel/1.0)' },
            });
            if (!r.ok) continue;
            const html = await r.text();
            text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          }

          // Extract phone number if we haven't found one yet
          if (!foundPhone) {
            const phoneMatch = text.match(/(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
            if (phoneMatch) {
              const raw = phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
              // Verify it looks like a real mobile/local number (not toll-free, not PBX-like)
              if (!raw.startsWith('800') && !raw.startsWith('888') && !raw.startsWith('877') &&
                  !raw.startsWith('866') && !raw.startsWith('855') && !raw.startsWith('844') &&
                  !raw.endsWith('0000') && !raw.endsWith('00')) {
                foundPhone = raw;
              }
            }
          }

          const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/);
          if (emailMatch && !emailMatch[1].includes('example.') && !emailMatch[1].includes('sentry.') && !emailMatch[1].includes('@2x')) {
            // Save email + phone if found
            if (foundPhone) {
              await env.DB.prepare(
                `UPDATE venues SET contact_email=?, contact_phone=?, contact_phone_verified=1, contact_method_note=?, updated_at=datetime('now') WHERE id=?`
              ).bind(emailMatch[1], foundPhone, 'website_scrape', venue_id).run();
              console.log(`[Agent] find_venue_contact: found email + phone for ${venue_name}: ${emailMatch[1]}, ${foundPhone}`);
              return { found: true, method: 'website', email: emailMatch[1], phone: foundPhone };
            }
            await env.DB.prepare(
              `UPDATE venues SET contact_email=?, contact_method_note=?, updated_at=datetime('now') WHERE id=?`
            ).bind(emailMatch[1], 'website_scrape', venue_id).run();
            console.log(`[Agent] find_venue_contact: found email via website for ${venue_name}: ${emailMatch[1]}`);
            return { found: true, method: 'website', email: emailMatch[1] };
          }
        } catch { /* try next */ }
      }

      // If we found a phone but no email from website, save it anyway
      if (foundPhone) {
        await env.DB.prepare(
          `UPDATE venues SET contact_phone=?, contact_phone_verified=1, updated_at=datetime('now') WHERE id=?`
        ).bind(foundPhone, venue_id).run();
        console.log(`[Agent] find_venue_contact: found phone (no email) for ${venue_name}: ${foundPhone}`);
      }

      // Step 2: Try Google search for staff email
      try {
        const query = encodeURIComponent(`${venue_name} food beverage manager OR events director Utah email`);
        const r = await fetch(`https://www.google.com/search?q=${query}`, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DangerousPretzel/1.0)' },
        });
        if (r.ok) {
          const html = await r.text();
          const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,})/);
          if (emailMatch && !emailMatch[1].includes('google') && !emailMatch[1].includes('example.')) {
            await env.DB.prepare(
              `UPDATE venues SET contact_email=?, contact_method_note=?, updated_at=datetime('now') WHERE id=?`
            ).bind(emailMatch[1], 'google_search', venue_id).run();
            console.log(`[Agent] find_summer_venue_contact: found email via Google for ${venue_name}: ${emailMatch[1]}`);
            return { found: true, method: 'google', email: emailMatch[1] };
          }
        }
      } catch { /* fall through to Instagram */ }

      // Step 3: Instagram fallback — flag for Drew, do NOT automate
      const handle = venue_name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const instagramHandle = `@${handle}`;
      await env.DB.prepare(
        `UPDATE venues SET contact_instagram=?, contact_method_note=?, updated_at=datetime('now') WHERE id=?`
      ).bind(instagramHandle, 'Instagram DM only — no email found', venue_id).run();

      // Category-aware DM template
      const cat = (venue?.category || '').toLowerCase();
      const dmTemplate = cat === 'brewery'
        ? `Hey ${venue_name} — we supply pretzel warmers to TF Brewing, Hopkins, ROHA, and HK Brewing in SLC. Thinking it could be a good fit for your taproom too. Who handles decisions like that?\n\nDrew @ Dangerous Pretzel\n801.916.9122`
        : cat === 'golf'
        ? `Hey ${venue_name} — quick question: who handles food/snack decisions at the club? We're at Delta Center and a few SLC breweries with a pretzel warmer setup — thinking the 19th hole angle could work well.\n\nDrew @ Dangerous Pretzel\n801.916.9122`
        : cat === 'stadium' || cat === 'entertainment'
        ? `Hey ${venue_name} — we supply pretzels to Delta Center and Sandy Amphitheater. Who handles concessions or F&B partnerships at your venue? We have a free warmer trial that's been a great fit for high-traffic spots.\n\nDrew @ Dangerous Pretzel\n801.916.9122`
        : `Hey ${venue_name} — love what you've built here.\n\nQuick question: who handles food vendor decisions for your events? We're working with Sandy Amphitheater and The Union Event Center this summer — thinking there might be a fit.\n\nWe make pretzels. Free warmer, no kitchen needed. Happy to share more if there's interest.\n\nDrew @ Dangerous Pretzel\n801.916.9122`;

      await env.KV.put(`drew_flag:instagram_${venue_id}`, JSON.stringify({
        venue_id,
        venue_name,
        reason: 'No email found — Instagram DM is best path',
        instagram: instagramHandle,
        dm_template: dmTemplate,
        flagged_at: new Date().toISOString(),
      }), { expirationTtl: 60 * 60 * 24 * 30 });

      console.log(`[Agent] find_summer_venue_contact: no email found for ${venue_name}, flagged for Drew Instagram DM`);
      return { found: false, method: 'instagram_only', instagram: instagramHandle, flag_created: true, dm_template: dmTemplate };
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
async function getDmFlags(env) {
  // List KV keys with drew_flag:instagram_ prefix
  const list = await env.KV.list({ prefix: 'drew_flag:instagram_' });
  const flags = await Promise.all(
    (list.keys || []).map(async (key) => {
      const val = await env.KV.get(key.name, 'json');
      return val;
    })
  );
  const valid = flags.filter(Boolean).sort((a, b) =>
    new Date(b.flagged_at) - new Date(a.flagged_at)
  );
  return new Response(JSON.stringify(valid, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getPendingApprovals(env) {
  const [pending, agentStats] = await Promise.all([
    env.DB.prepare(`
      SELECT o.id, o.venue_id, o.subject, o.body, o.self_score,
             o.agent_reasoning, o.created_at, o.sequence_step,
             v.name as venue_name, v.category, v.campaign,
             v.contact_email, v.contact_name
      FROM outreach_logs o
      JOIN venues v ON v.id = o.venue_id
      WHERE o.approval_status = 'pending'
      ORDER BY o.self_score DESC, o.created_at ASC
    `).all(),
    env.DB.prepare(`
      SELECT
        COUNT(*) as total_all_time,
        SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as total_sent,
        SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN approval_status = 'held' THEN 1 ELSE 0 END) as held_count,
        ROUND(AVG(CASE WHEN self_score IS NOT NULL THEN self_score END), 1) as avg_score,
        SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) as total_replies,
        SUM(CASE WHEN sent_at >= date('now', '-30 days') THEN 1 ELSE 0 END) as sent_30d
      FROM outreach_logs
      WHERE direction = 'out'
    `).first(),
  ]);

  return new Response(JSON.stringify({
    items: pending.results || [],
    stats: agentStats || {},
  }, null, 2), {
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

  if (!log) return new Response(JSON.stringify({ error: 'Not found or already processed' }), {
    status: 404, headers: { 'Content-Type': 'application/json' }
  });

  // Primary path: signal the Workflow — it handles the send atomically in step.do()
  // This prevents duplicate sends and gives us retry semantics for free.
  if (env.OUTREACH_WORKFLOW) {
    try {
      const instance = await env.OUTREACH_WORKFLOW.get(logId);
      await instance.sendEvent({ type: 'decision', payload: { approved: true } });
      // Workflow will update D1 + venue status in its own steps — return optimistically
      return new Response(JSON.stringify({
        sent: true,
        via: 'workflow',
        to: log.to_address || log.contact_email,
        subject: log.subject,
      }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      // Instance not found (email was parked via legacy path) — fall through to direct send
      console.log(`[Outreach] Workflow instance not found for ${logId}, using direct send:`, err.message);
    }
  }

  // Fallback: direct Gmail (legacy-parked emails or Workflow unavailable)
  const gmailResult = await sendGmail(env, {
    to:      log.to_address || log.contact_email,
    subject: log.subject,
    body:    log.body,
    logId,
  });

  if (gmailResult?.error) {
    console.error('[Outreach] Gmail send failed:', JSON.stringify(gmailResult.error));
    return new Response(JSON.stringify({ error: 'Gmail send failed', detail: gmailResult.error }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  await env.DB.prepare(`
    UPDATE outreach_logs
    SET approval_status = 'approved', sent_at = datetime('now'),
        gmail_thread_id = ?, gmail_message_id = ?
    WHERE id = ?
  `).bind(gmailResult?.threadId || null, gmailResult?.id || null, logId).run();

  await env.DB.prepare(`
    UPDATE venues
    SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(log.venue_id).run();

  console.log(`[Outreach] Sent email (direct) to ${log.to_address || log.contact_email} — ${log.subject}`);
  return new Response(JSON.stringify({
    sent: true,
    via: 'direct',
    gmail_id: gmailResult?.id,
    to: log.to_address || log.contact_email,
    subject: log.subject,
  }), { headers: { 'Content-Type': 'application/json' } });
}

// ── REDRAFT WITH FEEDBACK ─────────────────────────────────────────────────────
async function redraftEmail(logId, feedback, env) {
  if (!feedback || feedback.trim().length < 5) {
    return new Response(JSON.stringify({ error: 'Feedback required (at least 5 chars)' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const log = await env.DB.prepare(`
    SELECT o.*, v.name as venue_name, v.category, v.campaign, v.city,
           v.contact_name, v.contact_email
    FROM outreach_logs o
    JOIN venues v ON v.id = o.venue_id
    WHERE o.id = ? AND o.approval_status = 'pending'
  `).bind(logId).first();

  if (!log) return new Response(JSON.stringify({ error: 'Email not found or already sent' }), {
    status: 404, headers: { 'Content-Type': 'application/json' }
  });

  let brainCtx = '';
  try { brainCtx = await loadBrain(env, 'outreach'); }
  catch (err) {
    console.error('[Redraft] Brain load failed:', err.message);
    return new Response(JSON.stringify({ error: 'Brain load failed: ' + err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const redraftPrompt = `You are rewriting a cold outreach email for Dangerous Pretzel Co.

Business context:
${brainCtx}

Original email to ${log.venue_name}:
Subject: ${log.subject}
Body:
${log.body}

Drew's specific feedback: "${feedback}"

Rewrite the email incorporating this feedback exactly. Keep the same core offer and tone. Rules:
- Under 130 words
- No filler openers ("I hope this finds you well" etc.)
- One clear CTA at the end
- Include phone 801.916.9122 if the original had it

Return JSON only: {"subject": "...", "body": "...", "self_score": N, "score_breakdown": "..."}`;

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{ role: 'user', content: redraftPrompt }],
      }),
    });
  } catch (err) {
    console.error('[Redraft] Claude API unreachable:', err.message);
    return new Response(JSON.stringify({ error: 'Claude API unreachable: ' + err.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown');
    console.error('[Redraft] Claude API error:', response.status, errText.slice(0, 200));
    return new Response(JSON.stringify({ error: 'Claude API error ' + response.status, detail: errText.slice(0, 300) }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  let draft;
  try {
    draft = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return new Response(JSON.stringify({ error: 'Redraft parse failed', raw: text.slice(0, 300) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Preserve the pretzel-program P.S. if original had it
  if ((log.body.includes('pretzel-website-31s.pages.dev/pretzel-program') || log.body.includes('program.dangerouspretzel.com/pretzel-program')) &&
      !draft.body.includes('pretzel-program')) {
    draft.body = draft.body.trimEnd() + '\n\nP.S. See how other venues are doing it: program.dangerouspretzel.com/pretzel-program';
  }

  await env.DB.prepare(`
    UPDATE outreach_logs
    SET subject = ?, body = ?, self_score = ?,
        notes = COALESCE(notes || ' | ', '') || ?
    WHERE id = ?
  `).bind(
    draft.subject, draft.body, draft.self_score || log.self_score,
    `Redrafted per feedback: "${feedback.slice(0, 100)}"`, logId
  ).run();

  return new Response(JSON.stringify({
    redrafted: true,
    subject: draft.subject,
    body: draft.body,
    self_score: draft.self_score,
    score_breakdown: draft.score_breakdown,
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function rejectEmail(logId, note, env) {
  // Signal the Workflow first so it doesn't sit idle for 48h
  if (env.OUTREACH_WORKFLOW) {
    try {
      const instance = await env.OUTREACH_WORKFLOW.get(logId);
      await instance.sendEvent({ type: 'decision', payload: { approved: false, note: note || 'Rejected by Drew' } });
      return new Response(JSON.stringify({ rejected: true, via: 'workflow' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch { /* instance not found — fall through to direct D1 update */ }
  }

  await env.DB.prepare(`
    UPDATE outreach_logs
    SET approval_status = 'rejected', notes = ?
    WHERE id = ?
  `).bind(note || 'Rejected by Drew', logId).run();

  return new Response(JSON.stringify({ rejected: true, via: 'legacy' }), {
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
  return weeksSince < cfg(env).warmupWeeks;
}

async function getTotalSentCount(env) {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM outreach_logs
    WHERE direction = 'out' AND sent_at IS NOT NULL
    AND created_at > datetime('now', '-30 days')
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

async function sendGmail(env, { to, subject, body, threadId, logId }) {
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

  // Convert plain text body to HTML with tracking pixel
  const pixelUrl = logId
    ? `https://pretzel-os.drew-f39.workers.dev/outreach/pixel/${logId}`
    : null;
  const htmlBody = body.replace(/\n/g, '<br>') +
    (pixelUrl ? `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">` : '');

  const message = [
    `To: ${to}`,
    `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
  ].join('\r\n');

  // Proper UTF-8 → base64url encoding (btoa is Latin-1 only)
  const bytes = new TextEncoder().encode(message);
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString)
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

// ── SMS NUDGE via Swell CX ───────────────────────────────────────────────────
// Sends a short SMS to venues that were emailed 24h+ ago but didn't open.
// Reuses Swell CX platform API (same as review invites in account-worker.js).
// Uses the /messages endpoint for custom text (not campaign invite).
async function sendSMS(env, { to, body, venueId, logId }) {
  const token = env.SWELLCX_API_KEY;
  if (!token) throw new Error('SWELLCX_API_KEY not set');
  const SWELL_LOCATION_ID = 17640;

  // Normalize phone: strip non-digits and leading 1
  const cleanPhone = to.replace(/[^0-9]/g, '').replace(/^1/, '');
  if (cleanPhone.length !== 10) throw new Error(`Invalid phone: ${to}`);

  // Find or create contact in Swell
  const searchResp = await fetch(
    `https://platform.swellcx.com/api/v1/contacts?token=${token}&phone=${cleanPhone}`,
    { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
  );
  const searchData = await searchResp.json();
  let contactId = searchData.data?.[0]?.id;

  if (!contactId) {
    const createResp = await fetch('https://platform.swellcx.com/api/v1/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ token, name: `Contact ${cleanPhone.slice(-4)}`, phone: cleanPhone, locations: [SWELL_LOCATION_ID], country_code: 'US' }),
    });
    const createData = await createResp.json();
    contactId = createData.data?.id || createData.id;
    if (!contactId) throw new Error('Failed to create Swell contact: ' + JSON.stringify(createData));
  }

  // Send custom SMS via Swell messages endpoint
  const msgResp = await fetch('https://platform.swellcx.com/api/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      token,
      location_id: SWELL_LOCATION_ID,
      contact_id: contactId,
      body,
      direction: 'out',
    }),
  });

  if (!msgResp.ok) {
    const err = await msgResp.text();
    throw new Error(`Swell SMS error: ${err}`);
  }

  const result = await msgResp.json();
  console.log(`[SMS] Sent to ${cleanPhone.slice(0, 6)}*** (contact ${contactId})`);
  return { contactId, messageId: result.data?.id || result.id };
}

// ── SMS NUDGE TEMPLATES ──────────────────────────────────────────────────────
// Under 160 chars (1 SMS segment). {venue} and {first_name} get replaced.
const SMS_TEMPLATES = {
  nudge_after_email: "Hey {first_name}! Drew from Dangerous Pretzel — shot you a quick email about {venue}. Worth a peek when you have a sec 🥨",
  nudge_after_followup: "Last one from me — just wanted to make sure my email didn't get buried. Happy to bring samples by anytime 🥨",
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── SEASONAL AUTO-HOLD ────────────────────────────────────────────────────────
// Venues that are out-of-season get auto-held until their peak season approaches.
// Runs once per outreach cycle. Only holds venues that don't already have an active hold.
const SEASONAL_RULES = [
  // Ski resorts: best to contact Sept-Oct (pre-season planning)
  { categories: ['ski_resort', 'ski'], offMonths: [4,5,6,7,8], resumeMonth: 9, reason: 'Seasonal: ski resort off-season. Resume September for pre-season outreach.' },
  // Golf clubs: best to contact Feb-Mar (season opening)
  { categories: ['golf', 'golf_club'], offMonths: [11,12,1], resumeMonth: 2, reason: 'Seasonal: golf club off-season. Resume February for spring opening.' },
  // Pools/water parks: best to contact Mar-Apr
  { categories: ['pool', 'water_park', 'aquatic'], offMonths: [10,11,12,1,2], resumeMonth: 3, reason: 'Seasonal: pool/water venue closed. Resume March for summer prep.' },
  // Summer outdoor venues: best to contact Mar-Apr
  { categories: ['summer_venue', 'outdoor_amphitheater', 'amphitheater'], offMonths: [10,11,12,1,2], resumeMonth: 3, reason: 'Seasonal: outdoor venue off-season. Resume March for summer booking.' },
];

async function applySeasonalHolds(env) {
  const currentMonth = new Date().getMonth() + 1; // 1-12
  let holdsApplied = 0;

  for (const rule of SEASONAL_RULES) {
    if (!rule.offMonths.includes(currentMonth)) continue;

    // Calculate resume date: next occurrence of resumeMonth, 1st of month
    const now = new Date();
    let resumeYear = now.getFullYear();
    if (rule.resumeMonth <= currentMonth) resumeYear++; // next year
    const resumeDate = `${resumeYear}-${String(rule.resumeMonth).padStart(2, '0')}-01`;
    const holdDays = Math.ceil((new Date(resumeDate) - now) / 86400000);

    const catPlaceholders = rule.categories.map(() => '?').join(',');
    const venues = await env.DB.prepare(`
      SELECT v.id, v.name, v.category FROM venues v
      LEFT JOIN outreach_holds h ON h.venue_id = v.id AND h.active = 1 AND h.expires_at > datetime('now')
      WHERE v.status = 'prospect'
        AND v.tier <= 2
        AND v.category IN (${catPlaceholders})
        AND h.id IS NULL
    `).bind(...rule.categories).all();

    for (const venue of (venues.results || [])) {
      await env.DB.prepare(`
        INSERT INTO outreach_holds (id, venue_id, reason, hold_days, expires_at, created_at, active)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 1)
      `).bind(
        crypto.randomUUID(), venue.id, rule.reason, holdDays, resumeDate
      ).run();
      holdsApplied++;
      console.log(`[Agent] Seasonal hold: ${venue.name} (${venue.category}) until ${resumeDate}`);
    }
  }

  return holdsApplied;
}

// ══════════════════════════════════════════════════════════════════════════════
// SIGNAL SCANNER — Daily cron that finds timing hooks for outreach
// Uses Workers AI (free) for classification, not Claude
// ══════════════════════════════════════════════════════════════════════════════

export async function runSignalScanner(env) {
  console.log('[Signal Scanner] Starting daily scan...');

  // Get Tier 1+2 venues that are prospects or contacted-but-no-reply
  // Skip venues with recent signals (last 7 days) to avoid duplicate scanning
  const venues = await env.DB.prepare(`
    SELECT v.id, v.name, v.category, v.website, v.instagram,
           v.city, v.avg_rating, v.review_count, v.contact_name,
           v.status, v.tier
    FROM venues v
    LEFT JOIN timing_signals ts ON ts.venue_id = v.id
      AND ts.created_at > datetime('now', '-7 days')
    WHERE v.tier <= 2
      AND v.status IN ('prospect', 'contacted')
      AND ts.id IS NULL
    ORDER BY v.tier ASC, v.qual_score DESC
    LIMIT 30
  `).all();

  const candidates = venues.results || [];
  console.log(`[Signal Scanner] ${candidates.length} venues to scan`);

  let signalsFound = 0;
  let scanned = 0;

  for (const venue of candidates) {
    try {
      const signals = [];

      // ── Instagram scan ──────────────────────────────────────────
      if (venue.instagram) {
        try {
          const handle = venue.instagram.replace(/^@/, '');
          const igResp = await fetch(`https://www.instagram.com/${handle}/`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
            signal: AbortSignal.timeout(6000),
          });
          if (igResp.ok) {
            const html = await igResp.text();
            const meta = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] || '';
            const pageText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500);

            // Use Workers AI to classify the Instagram content for timing signals
            if (env.AI) {
              const igClassification = await classifySignal(env, venue.name, 'instagram', `${meta}\n${pageText.slice(0, 800)}`);
              if (igClassification && igClassification.score >= 6) {
                signals.push({
                  type: 'instagram',
                  score: igClassification.score,
                  summary: igClassification.summary,
                  source: `instagram.com/${handle}`,
                  raw: meta.slice(0, 500),
                });
              }
            }
          }
        } catch { /* Instagram fetch failed — skip */ }
      }

      // ── Google Reviews scan ─────────────────────────────────────
      try {
        const query = encodeURIComponent(`${venue.name} ${venue.city || 'Salt Lake City'} reviews`);
        const reviewResp = await fetch(
          `https://www.google.com/search?q=${query}&num=5`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
            signal: AbortSignal.timeout(6000),
          }
        );
        if (reviewResp.ok) {
          const html = await reviewResp.text();
          const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500);

          if (env.AI) {
            const reviewClassification = await classifySignal(env, venue.name, 'reviews', text);
            if (reviewClassification && reviewClassification.score >= 6) {
              signals.push({
                type: 'google_reviews',
                score: reviewClassification.score,
                summary: reviewClassification.summary,
                source: 'google.com/search',
                raw: text.slice(0, 500),
              });
            }
          }
        }
      } catch { /* Google search failed — skip */ }

      // ── Website scan (look for events, new menus, renovations) ──
      if (venue.website && !venue.instagram) {
        try {
          let text = '';
          // Try Browser Rendering first for JS-heavy sites
          if (env.CF_API_TOKEN) {
            try {
              const brResp = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/f399e3bcd5ea1501830d0ad1d35d9da3/browser-rendering/content`,
                { method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url: venue.website }), signal: AbortSignal.timeout(15000) }
              );
              if (brResp.ok) {
                const brData = await brResp.json();
                text = (typeof brData.result === 'string' ? brData.result : brData.result?.content || brData.content || '')
                  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
              }
            } catch { /* fall through to raw fetch */ }
          }
          // Fallback: raw fetch
          if (!text) {
            const webResp = await fetch(venue.website, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
              signal: AbortSignal.timeout(6000),
            });
            if (webResp.ok) {
              const html = await webResp.text();
              text = html
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 1500);
            }
          }

          if (text && env.AI) {
            const webClassification = await classifySignal(env, venue.name, 'website', text);
            if (webClassification && webClassification.score >= 6) {
              signals.push({
                type: 'website',
                score: webClassification.score,
                summary: webClassification.summary,
                source: venue.website,
                raw: text.slice(0, 500),
              });
            }
          }
        } catch { /* Website fetch failed — skip */ }
      }

      // ── Save signals to D1 ─────────────────────────────────────
      for (const sig of signals) {
        await env.DB.prepare(`
          INSERT INTO timing_signals (id, venue_id, signal_type, signal_score, signal_summary, source, raw_data, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+14 days'), datetime('now'))
        `).bind(
          crypto.randomUUID(), venue.id, sig.type, sig.score,
          sig.summary, sig.source, sig.raw
        ).run();
        signalsFound++;
      }

      scanned++;

      // Best signal for this venue — update notes for outreach context
      if (signals.length > 0) {
        const best = signals.sort((a, b) => b.score - a.score)[0];
        if (best.score >= 7) {
          // Append signal to venue notes so outreach agent sees it immediately
          await env.DB.prepare(`
            UPDATE venues SET notes = COALESCE(notes || ' | ', '') || ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).bind(`TIMING SIGNAL (${best.type}, score ${best.score}): ${best.summary}`, venue.id).run();
          console.log(`[Signal Scanner] HIGH signal for ${venue.name}: ${best.summary} (${best.score}/10)`);
        }
      }

      await sleep(1000); // Rate limit between venues
    } catch (err) {
      console.error(`[Signal Scanner] Error scanning ${venue.name}:`, err.message);
    }
  }

  console.log(`[Signal Scanner] Done. Scanned ${scanned}, found ${signalsFound} signals`);
  return { scanned, signals_found: signalsFound };
}

// ── Workers AI signal classifier (free, no Claude cost) ────────────────────
async function classifySignal(env, venueName, source, content) {
  if (!env.AI) return null;
  try {
    const prompt = `You are analyzing ${source} content for "${venueName}" to find timing signals for a food vendor outreach.

CONTENT:
${content.slice(0, 800)}

Look for these HIGH-VALUE timing signals (score 7-10):
- New event announced (concert, festival, grand opening, seasonal opening)
- Renovation or expansion completed
- New food menu or "wish we had food" reviews
- New GM, F&B director, or events manager hired
- Seasonal opening (patio season, ski season, summer events)
- "No food options" complaints in reviews

MODERATE signals (score 5-6):
- General positive momentum (good reviews, growing)
- Active social media posting about events
- Mentions of snacks, appetizers, or food vendors

LOW/NO signal (score 1-4):
- No relevant content found
- Off-season or closing
- Recent negative events
- Already has food vendor/program

Return JSON only:
{"score":7,"summary":"One sentence describing the timing signal and why now is a good time to reach out","signal_type":"event|renovation|food_gap|new_hire|seasonal|general"}`;

    const resp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You classify timing signals for sales outreach. Return valid JSON only, no markdown.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 200,
    });

    const text = resp?.response || '';
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}
