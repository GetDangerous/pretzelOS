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
import { callAI } from './ai-budget.js';

// These defaults are overridden by wrangler.toml env vars at runtime
const MAX_SENDS_PER_RUN   = 3;      // env.OUTREACH_DAILY_LIMIT
const WARMUP_WEEKS        = 3;      // env.OUTREACH_WARMUP_WEEKS
const APPROVAL_GATE_COUNT = 20;     // env.OUTREACH_APPROVAL_GATE — human review until N sends
const DRAFT_QUALITY_MIN   = 8;      // env.OUTREACH_QUALITY_MIN — raised from 7 on 2026-04-22: min-of-four-dimensions, reply-likelihood focus
const MAX_AGENT_LOOPS     = 8;      // Safety limit on tool call rounds

// ── BANNED PHRASE GATE (programmatic, free, instant) ─────────────────────────
const BANNED_PATTERNS = [
  /I hope this finds you well/i,
  /I wanted to reach out/i,
  /I am writing to/i,
  /exciting opportunity/i,
  /exciting partnership/i,
  /touch base/i,
  /synergies?/i,
  /value proposition/i,
  /please don't hesitate/i,
  /please don.t hesitate/i,
  /looking forward to hearing from you/i,
  /warmer model/i,
  /one warmer,? one night/i,
  /trial run/i,
  /if your guests don.t love it/i,
  /we pick up the warmer/i,
  /in today.s competitive/i,
  /as a \w+ you understand/i,
  /innovative\s+(solution|approach|partnership)/i,
  /leverage\s+(our|this|the)/i,
];

function checkBannedPhrases(subject, body) {
  const text = `${subject}\n${body}`;
  const found = [];
  for (const p of BANNED_PATTERNS) {
    const match = text.match(p);
    if (match) found.push(match[0]);
  }
  return found;
}

// Max 25 words per sentence — enforced programmatically
function checkSentenceLength(body) {
  // Split on sentence endings, filter out signature block
  const sigIdx = body.indexOf('--\n');
  const mainBody = sigIdx > -1 ? body.slice(0, sigIdx) : body;
  const sentences = mainBody.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
  return sentences.filter(s => s.split(/\s+/).length > 25);
}

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

THE THREE HARD HOLDS — NO EXCEPTIONS:
Before you draft, check each. If ANY is true, you do NOT draft. You hold or flag.

(a) NO NAMED CONTACT. If research does not surface a real first name + last name for a specific human at this venue, you do not send. A generic info@ or contact@ with no name is a flag for Drew to do manual contact research — NOT an automated "Hi there,". Nameless greetings land in spam and train the recipient that we are a bot.

(b) NO SPECIFIC HOOK. Every email must open with one concrete, dated, venue-unique detail from the last 90 days — a show announcement, a new hire, a menu change, a renovation, an award, a social post, a press mention. "Your crowd loves pretzels" is not a hook. "Summer is peak season" is not a hook. "Saw your Plazapalooza lineup dropped last week" is a hook. If your research produced no such detail, hold — do not fabricate.

(c) ALREADY HAS A PROGRAM. If the venue already sells pretzels, has a branded snack/food program, or follows Dangerous Pretzel on social, flag for Drew. Do not cold-email a venue that is already in the neighborhood — it reads as a lack of homework.

OPERATING PRINCIPLES:

1. RESEARCH FIRST, ALWAYS. Never draft before you understand the venue. What events do they run THIS MONTH? Who is the F&B or GM by name? Do they already mention food? Have they had any problems recently? Is there a hook specific to them?

2. LOOK FOR HOLD SIGNALS ACTIVELY. Before drafting, scan for: renovation or closure announcements, very recent bad reviews, seasonal businesses that are off-season, venues that already have a pretzel or snack program (flag for Drew, do not auto-email), venues that already know the Dangerous Pretzel brand (they follow us, they've been tagged in our posts — flag for Drew).

3. WRITE FOR THE PERSON, NOT THE CATEGORY. A brewery taproom email and a ski lodge email should sound completely different. What does the GM at THIS venue actually care about on a Tuesday morning?

4. THE OPENING LINE IS EVERYTHING. It must reference something real and specific about their venue. Not "I noticed you're a great brewery" — that's nothing. "Saw your Hazy IPA collab with Epic last month — that's exactly the kind of pairing our Spicy Bee was made for." That's something.

5. SELF-EVALUATE RUTHLESSLY — AGAINST REPLY-LIKELIHOOD, NOT TEMPLATE ADHERENCE. Before sending, ask ONE question: "If I were this specific named person, on a busy Tuesday, would I hit reply and type a response to this email? Not open it — REPLY to it." If the answer is not an unambiguous yes, the score is 6 or below. The template is a floor, not a ceiling. Following the template perfectly while being boring and generic is a 5. We are in the SLC market — low volume, high-quality only. A draft scored 8+ must name the ONE concrete reason this venue, today, would say yes. If you cannot name that reason in one sentence, it is not an 8.

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
    return runOutreachAgent(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/outreach/run' && request.method === 'POST') {
      const runId = crypto.randomUUID();
      ctx.waitUntil((async () => {
        const t0 = Date.now();
        try {
          await env.KV.put('outreach_last_run', JSON.stringify({ run_id: runId, status: 'running', started: new Date().toISOString() }));
          const result = await runOutreachAgent(env);
          await env.KV.put('outreach_last_run', JSON.stringify({
            run_id: runId, status: 'completed', result: result || {},
            started: new Date(t0).toISOString(), completed: new Date().toISOString(),
            duration_ms: Date.now() - t0,
          }));
        } catch (err) {
          await env.KV.put('outreach_last_run', JSON.stringify({
            run_id: runId, status: 'failed', error: err.message, stack: (err.stack || '').slice(0, 1000),
            started: new Date(t0).toISOString(), failed: new Date().toISOString(),
            duration_ms: Date.now() - t0,
          })).catch(() => {});
        }
      })());
      return new Response(JSON.stringify({ started: true, run_id: runId, timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check last outreach run result
    if (path === '/outreach/last-run' && request.method === 'GET') {
      const data = await env.KV.get('outreach_last_run');
      return new Response(data || '{"status":"no runs yet"}', {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Preview (sync) and draft-and-park (sync) endpoints REMOVED — they routinely
    // exceeded the 60s fetch timeout on complex venues. Use the -async variants below
    // with /outreach/single-run/{job_id} polling.
    if (path === '/outreach/preview' && request.method === 'POST') {
      return new Response(JSON.stringify({
        error: 'removed',
        message: 'Use POST /outreach/preview-async → then GET /outreach/single-run/{job_id}',
      }), { status: 410, headers: { 'Content-Type': 'application/json' } });
    }

    // Async single-venue agent run — launches in background, returns immediately.
    // mode = 'preview' (dryRun) | 'park' (actually park for approval)
    if ((path === '/outreach/preview-async' || path === '/outreach/draft-and-park-async') && request.method === 'POST') {
      const body = await request.json();
      const mode = path.includes('draft-and-park') ? 'park' : 'preview';
      const venue = await env.DB.prepare('SELECT * FROM venues WHERE id = ?').bind(body.venue_id).first();
      if (!venue) return new Response(JSON.stringify({ error: 'Venue not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const jobId = crypto.randomUUID();
      const kvKey = `single_run:${jobId}`;
      await env.KV.put(kvKey, JSON.stringify({ status: 'running', venue_id: venue.id, mode, started: new Date().toISOString() }), { expirationTtl: 3600 });
      const forcedStep = body.step ? parseInt(body.step) : null;
      if (forcedStep) {
        venue._forced_step = forcedStep;
        // Also set the real sequence_step so the agent's draft logic emits the right copy
        // (follow-up 1 vs 2 vs break-up). Pull prior send so the follow-up context is built.
        venue._followup_step = forcedStep;
        if (forcedStep > 1) {
          const prior = await env.DB.prepare(
            `SELECT subject, body, sent_at, sequence_step FROM outreach_logs
             WHERE venue_id = ? AND direction = 'out' AND sent_at IS NOT NULL
             ORDER BY sequence_step DESC, sent_at DESC LIMIT 1`
          ).bind(venue.id).first().catch(() => null);
          if (prior) {
            venue._prior_subject = prior.subject;
            venue._prior_body = prior.body;
            venue._prior_sent_at = prior.sent_at;
          }
        }
      }
      ctx.waitUntil((async () => {
        const t0 = Date.now();
        try {
          const brainCtx = await loadBrain(env, 'outreach');
          const result = await runAgentForVenue(venue, env, mode === 'preview', brainCtx);
          await env.KV.put(kvKey, JSON.stringify({ status: 'done', venue_id: venue.id, mode, result, duration_ms: Date.now() - t0 }), { expirationTtl: 3600 });
        } catch (err) {
          await env.KV.put(kvKey, JSON.stringify({ status: 'failed', venue_id: venue.id, mode, error: err.message, duration_ms: Date.now() - t0 }), { expirationTtl: 3600 });
        }
      })());
      return new Response(JSON.stringify({ job_id: jobId, status: 'running' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Poll a background single-venue run
    if (path.startsWith('/outreach/single-run/') && request.method === 'GET') {
      const jobId = path.split('/outreach/single-run/')[1];
      const data = await env.KV.get(`single_run:${jobId}`);
      return new Response(data || '{"status":"unknown"}', { headers: { 'Content-Type': 'application/json' } });
    }

    // Draft-and-park (sync) REMOVED — see preview note above. Returns 410 for any
    // stale caller so the failure is loud, not silent.
    if (path === '/outreach/draft-and-park' && request.method === 'POST') {
      return new Response(JSON.stringify({
        error: 'removed',
        message: 'Use POST /outreach/draft-and-park-async → then GET /outreach/single-run/{job_id}',
      }), { status: 410, headers: { 'Content-Type': 'application/json' } });
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

    // Click-tracking redirect — V3 Bug 1.5. Rewritten URLs in outgoing emails
    // point here; we log the click and 302 to the real destination.
    // Format: /track/click/:log_id?u=<base64url-encoded URL>
    if (path.startsWith('/track/click/')) {
      const logId = path.slice('/track/click/'.length).split('?')[0];
      const u = url.searchParams.get('u') || '';
      let dest = '';
      try {
        // base64url decode
        const padded = u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((u.length + 3) % 4);
        dest = atob(padded);
      } catch {
        dest = '';
      }
      // Only follow http(s) destinations — block javascript:, data:, etc.
      if (!/^https?:\/\//i.test(dest)) {
        return new Response('Invalid tracked link', { status: 400 });
      }
      ctx.waitUntil((async () => {
        try {
          await env.DB.prepare(
            `INSERT INTO email_clicks (id, log_id, clicked_at, url, user_agent, ip)
             VALUES (?, ?, datetime('now'), ?, ?, ?)`
          ).bind(
            crypto.randomUUID(),
            logId || '',
            dest.slice(0, 500),
            (request.headers.get('User-Agent') || '').slice(0, 250),
            request.headers.get('CF-Connecting-IP') || null
          ).run();
          // Also stamp outreach_logs.clicked_at on first click
          if (logId) {
            await env.DB.prepare(
              `UPDATE outreach_logs SET clicked_at = COALESCE(clicked_at, datetime('now')) WHERE id = ?`
            ).bind(logId).run();
          }
        } catch (e) {
          console.error('[Track] click insert failed:', e.message);
        }
      })());
      return Response.redirect(dest, 302);
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
    // Capped per invocation to prevent CPU timeout mid-loop that would leave
    // half-sent state. If more pending rows exist, caller can invoke again.
    if (path === '/outreach/approve-all' && request.method === 'POST') {
      const BULK_CAP = 10;
      const pending = await env.DB.prepare(`
        SELECT id FROM outreach_logs WHERE approval_status = 'pending' AND direction = 'out'
        ORDER BY created_at ASC LIMIT ?
      `).bind(BULK_CAP).all();
      const totalRemaining = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM outreach_logs WHERE approval_status = 'pending' AND direction = 'out'`
      ).first().catch(() => ({ c: 0 }));
      const results = [];
      for (const row of (pending.results || [])) {
        try {
          const r = await approveAndSend(row.id, env);
          const j = await r.json();
          results.push({ id: row.id, ...j });
        } catch (e) {
          console.error('[approve-all] send failed for', row.id, e.message);
          results.push({ id: row.id, error: e.message });
        }
      }
      const sent = results.filter(r => r.sent).length;
      const remaining = Math.max(0, (totalRemaining?.c || 0) - sent);
      return new Response(JSON.stringify({
        sent, cap: BULK_CAP, remaining, results,
        note: remaining > 0 ? `${remaining} more pending — call again to continue.` : 'queue empty',
      }), { headers: { 'Content-Type': 'application/json' } });
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
        WHERE o.approval_status IN ('approved', 'auto_sent') AND o.direction = 'out' AND o.sent_at IS NOT NULL
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

    // Natural language lead search — Apollo-backed
    if (path === '/outreach/find-leads' && request.method === 'POST') {
      try {
        const body = await request.json();
        const query = body.query?.trim();
        if (!query) return new Response(JSON.stringify({ leads: [], message: 'Query required' }), { headers: { 'Content-Type': 'application/json' } });
        const resp = await fetch('https://api.apollo.io/v1/organizations/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': env.APOLLO_API_KEY },
          body: JSON.stringify({ q_organization_name: query, organization_locations: ['Utah, United States'], per_page: 10 }),
        });
        if (!resp.ok) return new Response(JSON.stringify({ leads: [], message: 'Apollo search failed' }), { headers: { 'Content-Type': 'application/json' } });
        const data = await resp.json();
        const existing = await env.DB.prepare('SELECT name FROM venues').all();
        const existingNames = new Set((existing.results || []).map(v => v.name?.toLowerCase()));
        const leads = (data.organizations || []).map(o => ({
          name: o.name, city: o.city, website: o.website_url, phone: o.phone,
          address: o.street_address, category: o.industry || 'unknown',
          already_in_pipeline: existingNames.has(o.name?.toLowerCase()),
        }));
        return new Response(JSON.stringify({ leads }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ leads: [], message: 'Search error: ' + e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Add a new venue to D1 → ready for enrichment + qualification
    if (path === '/outreach/add-venue' && request.method === 'POST') {
      const body = await request.json();
      if (!body.name) return new Response(JSON.stringify({ error: 'name required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO venues (id, name, city, category, status, contact_email, website, campaign, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'prospect', ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        id, body.name, body.city || 'Salt Lake City', body.category || 'brewery',
        body.contact_email || null, body.website || null,
        body.category === 'summer_venue' ? 'summer_2026' : null
      ).run();
      return new Response(JSON.stringify({ venue_id: id, status: 'created' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Enrich a single venue — Apollo People Search for contacts
    if (path === '/outreach/enrich-single' && request.method === 'POST') {
      const body = await request.json();
      if (!body.venue_id) return new Response(JSON.stringify({ error: 'venue_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const venue = await env.DB.prepare('SELECT id, name, category, website FROM venues WHERE id = ?').bind(body.venue_id).first();
      if (!venue) return new Response(JSON.stringify({ error: 'Venue not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      try {
        let domain = null;
        if (venue.website) { try { domain = new URL(venue.website).hostname.replace('www.', ''); } catch {} }
        const targetTitles = ['General Manager', 'Owner', 'Manager', 'Director of Operations', 'Event Manager', 'Events Director', 'Taproom Manager', 'Bar Manager', 'Food and Beverage Manager', 'F&B Director'];
        const searchBody = { person_titles: targetTitles, include_similar_titles: true, person_locations: ['Utah, United States'], per_page: 5 };
        if (domain) { searchBody.q_organization_domains_list = [domain]; } else { searchBody.q_organization_name = venue.name; searchBody.organization_locations = ['Salt Lake City, Utah']; }
        const resp = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': env.APOLLO_API_KEY },
          body: JSON.stringify(searchBody),
        });
        if (!resp.ok) return new Response(JSON.stringify({ enriched: false, reason: 'Apollo error ' + resp.status }), { headers: { 'Content-Type': 'application/json' } });
        const data = await resp.json();
        const people = data.people || [];
        if (people.length === 0) return new Response(JSON.stringify({ enriched: false, reason: 'No contacts found' }), { headers: { 'Content-Type': 'application/json' } });
        const best = people.find(p => p.has_email || p.email) || people[0];
        let email = best.email || null;
        let contactName = [best.first_name, best.last_name].filter(Boolean).join(' ');
        let title = best.title || null;
        if (!email && best.id) {
          try {
            const enrichResp = await fetch('https://api.apollo.io/v1/people/match', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': env.APOLLO_API_KEY }, body: JSON.stringify({ id: best.id }) });
            if (enrichResp.ok) { const ed = await enrichResp.json(); if (ed.person?.email) { email = ed.person.email; contactName = ed.person.name || contactName; title = ed.person.title || title; } }
          } catch {}
        }
        if (email) {
          await env.DB.prepare('UPDATE venues SET contact_email = ?, contact_name = ?, contact_title = ? WHERE id = ?').bind(email, contactName, title, venue.id).run();
        }
        return new Response(JSON.stringify({ enriched: !!email, contact_email: email, contact_name: contactName, contact_title: title }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ enriched: false, reason: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Qualify a single venue — Claude Haiku scoring
    if (path === '/outreach/qualify-single' && request.method === 'POST') {
      const body = await request.json();
      if (!body.venue_id) return new Response(JSON.stringify({ error: 'venue_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const venue = await env.DB.prepare(`
        SELECT id, name, category, city, address, website, instagram, contact_title, notes,
               apollo_industry, apollo_description, apollo_employees, apollo_revenue,
               avg_rating, review_count
        FROM venues WHERE id = ?
      `).bind(body.venue_id).first();
      if (!venue) return new Response(JSON.stringify({ error: 'Venue not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      try {
        const promptRow = await env.DB.prepare("SELECT prompt_text, system_context FROM agent_prompts WHERE agent_name = 'qualifier' AND active = 1").first();
        if (!promptRow) return new Response(JSON.stringify({ error: 'Qualifier prompt not found' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        const venueData = JSON.stringify({
          name: venue.name, category: venue.category, city: venue.city,
          address: venue.address, website: venue.website,
          contact_title: venue.contact_title, notes: venue.notes,
          industry: venue.apollo_industry || null,
          description: venue.apollo_description || null,
          employee_count: venue.apollo_employees || null,
          revenue: venue.apollo_revenue || null,
          avg_rating: venue.avg_rating || null,
          review_count: venue.review_count || null,
          instagram: venue.instagram || null,
        });
        const prompt = promptRow.prompt_text.replace('{{venue_data}}', venueData);
        // DIF-3 (May 13 2026): wired through ai-budget
        const result = await callAI(env, {
          use_case: 'outreach_venue_generation',
          model: 'haiku',
          caller: 'outreach-agent.js',
          max_tokens: 300,
          system: promptRow.system_context,
          messages: [{ role: 'user', content: prompt }],
        });
        if (!result.ok) return new Response(JSON.stringify({ error: 'Claude API error ' + (result.blocked_reason || result.error || 'unknown') }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        const resultText = result.content || '';
        const clean = resultText.replace(/```json\n?|\n?```/g, '').trim();
        const parsed = JSON.parse(clean);
        const resolvedTier = parsed.tier === 'reject' ? 0 : (parsed.tier || (parsed.score >= 70 ? 1 : parsed.score >= 45 ? 2 : 3));
        const resolvedScore = parsed.score || 0;

        // NOTE: No auto-archive here. This endpoint is called from the Add Venue
        // modal — a manual add is a high-intent signal, so we always keep the
        // venue visible regardless of score. The bulk qualifier cron
        // (qualifier-worker.js) still auto-archives Apollo-scouted tier-3s.
        await env.DB.prepare('UPDATE venues SET tier = ?, qual_score = ?, icp_fit = ?, qual_summary = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .bind(resolvedTier, resolvedScore, parsed.icp_fit || 'unknown', parsed.summary || '', venue.id).run();
        return new Response(JSON.stringify({ qualified: true, tier: resolvedTier, score: resolvedScore, icp_fit: parsed.icp_fit, summary: parsed.summary }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ qualified: false, reason: e.message }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Venue detail — full venue + outreach history + holds
    if (path.match(/^\/outreach\/venue-detail\//) && request.method === 'GET') {
      const venueId = path.split('/outreach/venue-detail/')[1];
      const [venue, { results: logs }, { results: holds }] = await Promise.all([
        env.DB.prepare('SELECT * FROM venues WHERE id = ?').bind(venueId).first(),
        env.DB.prepare('SELECT * FROM outreach_logs WHERE venue_id = ? ORDER BY created_at DESC').bind(venueId).all(),
        env.DB.prepare('SELECT * FROM outreach_holds WHERE venue_id = ? AND active = 1').bind(venueId).all(),
      ]);
      if (!venue) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ venue, outreach_logs: logs || [], holds: holds || [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Save venue notes
    if (path === '/outreach/save-notes' && request.method === 'POST') {
      const body = await request.json();
      if (!body.venue_id) return new Response(JSON.stringify({ error: 'venue_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      await env.DB.prepare('UPDATE venues SET notes = ?, updated_at = datetime(\'now\') WHERE id = ?').bind(body.notes || '', body.venue_id).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Log pipeline feedback (archive reasons, junk flags, etc.) for feedback loop
    if (path === '/outreach/log-feedback' && request.method === 'POST') {
      const body = await request.json();
      if (!body.venue_id) return new Response(JSON.stringify({ error: 'venue_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      try {
        // Get venue's Apollo data for the feedback snapshot
        const venue = await env.DB.prepare('SELECT apollo_industry, apollo_description FROM venues WHERE id = ?').bind(body.venue_id).first();
        await env.DB.prepare(`
          INSERT INTO pipeline_feedback (id, venue_id, venue_name, category, action, reason, apollo_industry, apollo_description)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(), body.venue_id, body.venue_name || '', body.category || '',
          body.action || 'archived', body.reason || '',
          venue?.apollo_industry || null, venue?.apollo_description || null
        ).run();
        // Also log to scout_rejections if flagged as junk
        if (body.action === 'flagged_junk' || body.reason?.includes('Not a real venue')) {
          await env.DB.prepare(`
            INSERT INTO scout_rejections (id, apollo_id, name, city, category, industry, description, rejection_source, rejection_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'drew', ?)
          `).bind(
            crypto.randomUUID(), body.venue_id, body.venue_name || '', '', body.category || '',
            venue?.apollo_industry || null, (venue?.apollo_description || '').slice(0, 500),
            body.reason || 'Flagged by Drew'
          ).run();
        }
      } catch (e) {
        console.error('[Outreach] Feedback log error:', e.message);
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // All pipeline venues — feeds the kanban board with ALL venues, not just summer
    if (path === '/pipeline/venues' && request.method === 'GET') {
      const rows = await env.DB.prepare(`
        SELECT id, name, city, tier, category, status, campaign,
               contact_name, contact_email, contact_title, contact_instagram,
               qual_score, icp_fit, notes,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days_in_stage
        FROM venues
        WHERE status NOT IN ('inactive')
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'replied' THEN 1 WHEN 'trial' THEN 2 WHEN 'contacted' THEN 3 ELSE 4 END,
          tier ASC, name ASC
      `).all();
      return new Response(JSON.stringify(rows.results || []), { headers: { 'Content-Type': 'application/json' } });
    }

    // Follow-up status — how many follow-ups are due at each cadence step
    if (path === '/outreach/followup-status' && request.method === 'GET') {
      const [fu3, fu7, fu14] = await Promise.all([
        env.DB.prepare(`
          SELECT COUNT(*) as c FROM outreach_logs ol
          JOIN venues v ON v.id = ol.venue_id
          WHERE ol.direction = 'out' AND ol.sequence_step = 1
            AND ol.replied_at IS NULL AND ol.sent_at IS NOT NULL
            AND v.status = 'contacted'
            AND datetime(ol.sent_at) < datetime('now', '-3 days')
            AND datetime(ol.sent_at) > datetime('now', '-14 days')
            AND NOT EXISTS (SELECT 1 FROM outreach_logs ol2 WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step >= 2 AND ol2.direction = 'out')
        `).first(),
        env.DB.prepare(`
          SELECT COUNT(*) as c FROM outreach_logs ol
          JOIN venues v ON v.id = ol.venue_id
          WHERE ol.direction = 'out' AND ol.sequence_step = 2
            AND ol.replied_at IS NULL AND ol.sent_at IS NOT NULL
            AND v.status = 'contacted'
            AND datetime(ol.sent_at) < datetime('now', '-7 days')
            AND datetime(ol.sent_at) > datetime('now', '-21 days')
            AND NOT EXISTS (SELECT 1 FROM outreach_logs ol2 WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step >= 3 AND ol2.direction = 'out')
        `).first(),
        env.DB.prepare(`
          SELECT COUNT(*) as c FROM outreach_logs ol
          JOIN venues v ON v.id = ol.venue_id
          WHERE ol.direction = 'out' AND ol.sequence_step = 3
            AND ol.replied_at IS NULL AND ol.sent_at IS NOT NULL
            AND v.status = 'contacted'
            AND datetime(ol.sent_at) < datetime('now', '-14 days')
            AND datetime(ol.sent_at) > datetime('now', '-30 days')
            AND NOT EXISTS (SELECT 1 FROM outreach_logs ol2 WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step >= 4 AND ol2.direction = 'out')
        `).first(),
      ]);
      return new Response(JSON.stringify({
        day3_due: fu3?.c || 0,
        day7_due: fu7?.c || 0,
        day14_due: fu14?.c || 0,
        total_due: (fu3?.c || 0) + (fu7?.c || 0) + (fu14?.c || 0),
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Pipeline metrics — stage counts, avg days, conversion rates
    if (path === '/outreach/pipeline-metrics' && request.method === 'GET') {
      const [{ results: stages }, { results: conversions }, totalSent] = await Promise.all([
        env.DB.prepare(`
          SELECT status, COUNT(*) as count,
            CAST(AVG(julianday('now') - julianday(updated_at)) AS INTEGER) as avg_days
          FROM venues WHERE status NOT IN ('inactive')
          GROUP BY status ORDER BY CASE status WHEN 'prospect' THEN 0 WHEN 'contacted' THEN 1 WHEN 'replied' THEN 2 WHEN 'trial' THEN 3 WHEN 'active' THEN 4 ELSE 5 END
        `).all(),
        env.DB.prepare(`
          SELECT
            COUNT(DISTINCT CASE WHEN ol.sent_at IS NOT NULL THEN ol.venue_id END) as sent,
            COUNT(DISTINCT CASE WHEN ol.opened_at IS NOT NULL THEN ol.venue_id END) as opened,
            COUNT(DISTINCT CASE WHEN ol.replied_at IS NOT NULL THEN ol.venue_id END) as replied
          FROM outreach_logs ol WHERE ol.direction = 'out'
        `).all(),
        env.DB.prepare("SELECT COUNT(*) as c FROM venues WHERE status = 'active'").first(),
      ]);
      const conv = conversions?.[0] || {};
      const [staleCount, pipelineWins] = await Promise.all([
        env.DB.prepare(`
          SELECT COUNT(*) as c FROM venues
          WHERE status IN ('prospect', 'contacted')
            AND julianday('now') - julianday(updated_at) > 14
        `).first(),
        env.DB.prepare(`
          SELECT COUNT(DISTINCT v.id) as c FROM venues v
          INNER JOIN outreach_logs ol ON ol.venue_id = v.id
          WHERE v.status = 'active' AND ol.direction = 'out'
        `).first(),
      ]);
      return new Response(JSON.stringify({
        stages: stages || [],
        sent: conv.sent || 0, opened: conv.opened || 0, replied: conv.replied || 0,
        active: totalSent?.c || 0,
        pipeline_wins: pipelineWins?.c || 0,
        stale_count: staleCount?.c || 0,
        open_rate: conv.sent ? Math.round((conv.opened / conv.sent) * 100) : 0,
        reply_rate: conv.sent ? Math.round((conv.replied / conv.sent) * 100) : 0,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Kanban status update — agent-reactive transitions with side effects
    if ((path === '/pipeline/status' || path === '/outreach/transition') && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const venue_id = body.venue_id;
      const newStatus = body.status;
      const notes = body.notes || '';
      const validStatuses = ['prospect', 'researching', 'qualified', 'contacted', 'replied', 'trial', 'active', 'inactive'];
      if (!venue_id || !validStatuses.includes(newStatus)) {
        return new Response(JSON.stringify({ error: 'venue_id and valid status required' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get current venue state
      const venue = await env.DB.prepare('SELECT * FROM venues WHERE id = ?').bind(venue_id).first();
      if (!venue) return new Response(JSON.stringify({ error: 'Venue not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const oldStatus = venue.status;

      // Update status
      const extraFields = newStatus === 'contacted' ? ', last_contacted = datetime(\'now\')' :
                           newStatus === 'active' ? ', activated_at = datetime(\'now\')' : '';
      await env.DB.prepare(
        `UPDATE venues SET status = ?${extraFields}, updated_at = datetime('now') WHERE id = ?`
      ).bind(newStatus, venue_id).run();

      // Log to status history
      await env.DB.prepare(
        `INSERT INTO venue_status_history (id, venue_id, old_status, new_status, changed_by, notes, created_at) VALUES (?, ?, ?, ?, 'drew', ?, datetime('now'))`
      ).bind(crypto.randomUUID(), venue_id, oldStatus, newStatus, notes).run().catch(() => {});

      // Side effects by transition
      const sideEffects = [];

      if (newStatus === 'contacted' && oldStatus !== 'contacted') {
        // Create synthetic outreach_log so agent's follow-up system picks this up
        const contactEmail = venue.contact_email || 'manual';
        await env.DB.prepare(`
          INSERT OR IGNORE INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, agent_reasoning, self_score,
            sent_at, created_at
          ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, 'approved', ?, 10, datetime('now'), datetime('now'))
        `).bind(
          crypto.randomUUID(), venue_id,
          '[Drew handled personally]', '[Manual outreach — ' + (notes || 'contacted via pipeline') + ']',
          env.FROM_EMAIL, contactEmail,
          notes || 'Drew contacted this venue directly'
        ).run();
        sideEffects.push('outreach_log_created');
      }

      if (newStatus === 'replied' && oldStatus !== 'replied') {
        // Create inbound log entry
        await env.DB.prepare(`
          INSERT OR IGNORE INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, agent_reasoning, self_score, replied_at, created_at
          ) VALUES (?, ?, 0, 'email', 'in', ?, ?, ?, ?, 'approved', ?, 10, datetime('now'), datetime('now'))
        `).bind(
          crypto.randomUUID(), venue_id,
          '[Reply recorded by Drew]', notes || '[Manual reply log]',
          venue.contact_email || 'unknown', env.FROM_EMAIL,
          notes || 'Drew recorded a reply from this venue'
        ).run().catch(() => {});
        sideEffects.push('reply_logged');
      }

      if (newStatus === 'active' && oldStatus !== 'active') {
        // Create active_accounts row
        await env.DB.prepare(`
          INSERT OR IGNORE INTO active_accounts (
            id, venue_id, venue_name, fulfilled_by, health_status, churn_risk, created_at, updated_at
          ) VALUES (?, ?, ?, 'self', 'green', 0, datetime('now'), datetime('now'))
        `).bind(crypto.randomUUID(), venue_id, venue.name).run().catch(() => {});
        sideEffects.push('account_created');
      }

      return new Response(JSON.stringify({ ok: true, venue_id, old_status: oldStatus, status: newStatus, side_effects: sideEffects }), {
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
        SELECT v.id, v.name, v.city, v.tier, v.category, v.campaign, v.notes,
               v.contact_name, v.contact_email, v.contact_instagram, v.updated_at
        FROM venues v
        WHERE v.status = 'drew_flag'
        ORDER BY v.tier, v.updated_at DESC
      `).all();
      // Parse reason + suggested_approach out of v.notes (format: "FLAGGED FOR DREW: reason | approach")
      const parsed = (flags.results || []).map(f => {
        let reason = '', suggested_approach = '';
        if (f.notes?.startsWith('FLAGGED FOR DREW:')) {
          const parts = f.notes.replace('FLAGGED FOR DREW: ', '').split(' | ');
          reason = parts[0] || '';
          suggested_approach = parts.slice(1).join(' | ') || '';
        } else if (f.notes) {
          reason = f.notes;
        }
        return { ...f, reason, suggested_approach };
      });
      return new Response(JSON.stringify(parsed, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Dismiss a flagged venue — return to prospect pool
    if (path === '/pipeline/flags/dismiss' && request.method === 'POST') {
      const body = await request.json();
      const venueId = body.venue_id;
      if (!venueId) return new Response(JSON.stringify({ error: 'venue_id required' }), { status: 400 });
      await env.DB.prepare(
        `UPDATE venues SET status = 'prospect', notes = '[Reviewed by Drew] ' || COALESCE(REPLACE(notes, 'FLAGGED FOR DREW: ', ''), ''), updated_at = datetime('now') WHERE id = ? AND status = 'drew_flag'`
      ).bind(venueId).run();
      await env.KV.delete(`drew_flag:${venueId}`);
      return new Response(JSON.stringify({ dismissed: true, venue_id: venueId }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Convert a flagged venue — mark as contacted (Drew handled it)
    if (path === '/pipeline/flags/convert' && request.method === 'POST') {
      const body = await request.json();
      const venueId = body.venue_id;
      const newStatus = body.status || 'contacted';
      const validStatuses = ['prospect', 'researching', 'qualified', 'contacted', 'replied', 'trial', 'active', 'inactive'];
      if (!venueId) return new Response(JSON.stringify({ error: 'venue_id required' }), { status: 400 });
      if (!validStatuses.includes(newStatus)) return new Response(JSON.stringify({ error: 'Invalid status' }), { status: 400 });
      await env.DB.prepare(
        `UPDATE venues SET status = ?, notes = REPLACE(COALESCE(notes,''), 'FLAGGED FOR DREW: ', '[Resolved] '), updated_at = datetime('now') WHERE id = ?`
      ).bind(newStatus, venueId).run();
      await env.KV.delete(`drew_flag:${venueId}`);

      // If marking as contacted, create synthetic outreach_log so day-3/day-7 follow-ups fire
      if (newStatus === 'contacted') {
        const venue = await env.DB.prepare('SELECT name, contact_email FROM venues WHERE id = ?').bind(venueId).first();
        const contactEmail = body.contact_email || venue?.contact_email || 'manual';
        const notes = body.notes || 'Drew contacted this venue directly (flagged lead)';
        await env.DB.prepare(`
          INSERT OR IGNORE INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, agent_reasoning, self_score,
            sent_at, created_at
          ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, 'approved', ?, 10, datetime('now'), datetime('now'))
        `).bind(
          crypto.randomUUID(), venueId,
          '[Drew handled personally]', '[Manual outreach — ' + notes + ']',
          env.FROM_EMAIL, contactEmail,
          notes
        ).run();
      }

      return new Response(JSON.stringify({ converted: true, venue_id: venueId, status: newStatus }), {
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
  // ── BUSINESS BRAIN (resilient — continue without if it fails) ──────────
  let brainContext = '';
  try {
    brainContext = await loadBrain(env, 'outreach') || '';
  } catch (err) {
    console.error('[Outreach] Brain load failed, continuing without:', err.message);
  }
  console.log('[Outreach] Brain loaded:', brainContext ? brainContext.split('\n').length + ' lines' : 'empty');

  // ── CFO DIRECTIVE (resilient — continue without if it fails) ───────────
  let outreachDirective = null, growthBrake = false;
  try {
    const directive = await getDirectiveFromKV(env.KV);
    outreachDirective = directive?.outreach_directive || null;
    growthBrake = directive?.growth_brake === 1;
  } catch (err) {
    console.error('[Outreach] Directive load failed, continuing without:', err.message);
  }
  const { maxSends, approvalGate, qualityMin } = cfg(env);
  let effectiveMaxSends = maxSends;

  if (growthBrake) {
    effectiveMaxSends = Math.max(1, Math.floor(maxSends / 2));
    console.log(`[Agent] CFO growth_brake=1 — reducing MAX_SENDS from ${maxSends} to ${effectiveMaxSends}`);
  }
  if (outreachDirective) {
    console.log(`[Agent] CFO outreach_directive: ${outreachDirective}`);
  }
  console.log(`[Agent] CFO directive loaded: ${outreachDirective ? 'active' : 'none'}`);

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
  // HARD CAP: never process more than 2x max sends per run to bound CPU time
  const PROCESS_CAP = Math.max(4, effectiveMaxSends * 2);
  // Hard wall-clock budget (Cloudflare scheduled handlers cap at ~15min; janitor flags
  // anything stuck in 'running' for 15min as failed). Stop processing candidates if we
  // approach the limit so the run completes cleanly and writes its summary.
  const TIME_BUDGET_MS = 12 * 60 * 1000;
  const candidates = [...followups, ...(venues.results || [])].slice(0, PROCESS_CAP);
  console.log(`[Agent] ${candidates.length} total candidates (${followups.length} follow-ups + ${(venues.results || []).length} fresh) [cap=${PROCESS_CAP}]`);

  const PER_CANDIDATE_TIMEOUT_MS = 60_000; // 60s per candidate max

  let processed = 0;
  let sent      = 0;
  let held      = 0;
  let flagged   = 0;
  let followupsSent = 0;
  let freshSent     = 0;
  const runStart = Date.now();

  for (const venue of candidates) {
    if (sent >= effectiveMaxSends) break;
    if (Date.now() - runStart > TIME_BUDGET_MS) {
      console.log(`[Agent] Time budget (${TIME_BUDGET_MS}ms) reached at processed=${processed} sent=${sent}; stopping early to avoid janitor timeout.`);
      break;
    }

    const isFollowUp = (venue._followup_step || 1) > 1;
    console.log(`[Agent] Processing: ${venue.name} (${venue.campaign || venue.category})${isFollowUp ? ` [follow-up step ${venue._followup_step}]` : ''}`);
    const candT0 = Date.now();

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

    let result;
    try {
      result = await Promise.race([
        runAgentForVenue(venue, env, false, brainContext, summerPromptRow),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`candidate timeout ${PER_CANDIDATE_TIMEOUT_MS}ms`)), PER_CANDIDATE_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error(`[Agent] Candidate ${venue.name} failed after ${Date.now() - candT0}ms:`, err.message);
      result = { action: 'error', error: err.message };
    }
    console.log(`[Agent] Candidate ${venue.name} done in ${Date.now() - candT0}ms → ${result.action}`);

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

    // Jitter between venues — avoid the 14:02-14:05 UTC batch signature.
    // 15s to 75s, randomized. Tightened from 30s-4min: the wider range was blowing
    // the 15min Cloudflare scheduled-handler budget on multi-send runs and the
    // janitor was flagging completed runs as failed. ~45s avg still gives email
    // providers a non-burst signature.
    const jitterMs = 15_000 + Math.floor(Math.random() * 60_000);
    await sleep(jitterMs);
  }
  console.log(`[Agent] Candidate loop finished in ${Date.now() - runStart}ms — processed=${processed} sent=${sent} held=${held} flagged=${flagged}`);

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

  // Stall alert: outreach ran with candidates but sent nothing
  if (sent === 0 && candidates.length > 0) {
    try {
      await sendGmail(env, {
        to: env.DREW_EMAIL,
        subject: '⚠️ Outreach ran but sent 0 emails',
        body: `The outreach agent processed ${candidates.length} candidates but sent nothing.\n\nBreakdown:\n- Follow-ups queued: ${followups.length} (day-3: ${fu3.results?.length || 0}, day-7: ${fu7.results?.length || 0}, day-14: ${fu14.results?.length || 0})\n- Fresh leads queued: ${(venues.results||[]).length}\n- Held: ${held}\n- Flagged: ${flagged}\n\nCheck dashboard: https://pretzel-dashboard.pages.dev`,
      });
    } catch (e) { console.error('[Agent] Stall alert email failed:', e.message); }
  }

  return { processed, sent, held, flagged, followups_sent: followupsSent, fresh_sent: freshSent, sms_sent: smsSent, dms_drafted: dmsDrafted, warmup: inWarmup, gate: inGate };
}

// ── AGENT LOOP FOR ONE VENUE ──────────────────────────────────────────────────
// Phase D helper: park an operator-authored draft verbatim (bypass LLM).
async function _persistOperatorDraft(venue, env, { subject, body, step_n }) {
  const logId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO outreach_logs (
      id, venue_id, direction, sequence_step, subject, body,
      approval_status, self_score, created_at
    ) VALUES (?, ?, 'out', ?, ?, ?, 'pending', 10, datetime('now'))
  `).bind(logId, venue.id, step_n, subject, body).run();
  return {
    action: 'parked',
    parked: true,
    log_id: logId,
    subject,
    body,
    selfScore: 10,
    reasoning: `Operator-authored draft for step ${step_n} parked for approval (bypassed LLM).`,
  };
}
// Bug 1.1 — canContactAddress: pre-flight check before spending compute on a draft,
// parking a draft, or firing a Gmail send. Defense-in-depth: called at 3 sites.
// Returns { ok: true } or { ok: false, reason: <code>, detail: <string> }.
// Reasons: no_address | placeholder_address | recent_send_exists | previously_declined
async function canContactAddress(toAddress, env, opts = {}) {
  if (!toAddress || typeof toAddress !== 'string') return { ok: false, reason: 'no_address' };
  const addr = toAddress.trim().toLowerCase();

  // Block obvious placeholders (test emails, docs/example domains, role aliases that bounce)
  const INVALID_PATTERNS = [
    /@domain\.(com|org|net)$/i,
    /@example\./i,
    /^test@/i,
    /^user@/i,
    /^noreply@/i,
    /^no-reply@/i,
    /^donotreply@/i,
    /^info@info\./i,
    /@localhost/i,
    /^[^@]*@$/,   // missing domain
    /@[^.]+$/,    // missing TLD
  ];
  if (INVALID_PATTERNS.some(p => p.test(addr))) {
    return { ok: false, reason: 'placeholder_address', detail: `Pattern-matched invalid address: ${addr}` };
  }

  // Block if we already sent to this address within the last 90 days.
  // Prevents Red Butte 5× / This Is The Place 3× style pile-ons.
  // Follow-ups intentionally re-send within the window — opts.isFollowUp skips this check.
  if (!opts.isFollowUp) {
    const recentSend = await env.DB.prepare(`
      SELECT id, sent_at, subject, venue_id
      FROM outreach_logs
      WHERE LOWER(to_address) = ?
        AND sent_at IS NOT NULL
        AND sent_at >= datetime('now', '-90 days')
      ORDER BY sent_at DESC
      LIMIT 1
    `).bind(addr).first().catch(() => null);
    if (recentSend) {
      return {
        ok: false,
        reason: 'recent_send_exists',
        detail: `Last sent ${recentSend.sent_at?.slice(0, 10)} for ${recentSend.venue_id} — subject: ${(recentSend.subject || '').slice(0, 60)}`,
      };
    }
  }

  // Block if a prior reply classified as closed — never re-pitch someone who said
  // "already has vendor" / "not interested" / unsubscribed.
  const declined = await env.DB.prepare(`
    SELECT classification, received_at
    FROM inbound_replies
    WHERE LOWER(from_email) = ?
      AND classification IN ('already_has_vendor', 'not_interested', 'unsubscribe', 'negative')
    ORDER BY received_at DESC
    LIMIT 1
  `).bind(addr).first().catch(() => null);
  if (declined) {
    return {
      ok: false,
      reason: 'previously_declined',
      detail: `Classified as ${declined.classification} on ${declined.received_at?.slice(0, 10)}`,
    };
  }

  // Audit Gap 7 — domain-level declined check. If ANY contact in this org has
  // previously said "already has vendor" / "not interested" / unsubscribed,
  // block new outreach to a different mailbox at the same domain. This catches
  // the thisistheplace.org case where tkramer@ replied but the venue
  // contact_email was CustomerService@ — exact-email match would miss it.
  // Skip common free-mail providers (gmail/yahoo/outlook) — different
  // personal addresses are not "same org".
  const at = addr.indexOf('@');
  if (at > 0) {
    const domain = addr.slice(at + 1);
    const FREE_MAIL = new Set([
      'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
      'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
      'msn.com', 'live.com', 'ymail.com',
    ]);
    if (!FREE_MAIL.has(domain)) {
      const domainDeclined = await env.DB.prepare(`
        SELECT from_email, classification, received_at
        FROM inbound_replies
        WHERE LOWER(from_email) LIKE ?
          AND classification IN ('already_has_vendor', 'not_interested', 'unsubscribe', 'negative')
        ORDER BY received_at DESC
        LIMIT 1
      `).bind('%@' + domain).first().catch(() => null);
      if (domainDeclined) {
        return {
          ok: false,
          reason: 'previously_declined',
          detail: `Domain ${domain} declined via ${domainDeclined.from_email} (${domainDeclined.classification}) on ${domainDeclined.received_at?.slice(0, 10)}`,
        };
      }
    }
  }

  return { ok: true };
}

async function runAgentForVenue(venue, env, dryRun = false, brainContext = '', summerPromptRow = null) {
  // Bug 1.1 Site (a): pre-draft dedup gate. If the venue's contact email is blocked,
  // skip the entire drafting step — don't waste Claude compute generating copy we
  // can't send. Mark the venue as lead_closed so the agent never retries.
  //
  // Follow-ups (sequence_step > 1) intentionally go to the same address as the
  // prior send within the 90-day window — that IS the follow-up. For those,
  // bypass the recent_send_exists reason but still enforce placeholder_address
  // and previously_declined (hard blocks regardless of sequence).
  const _isFollowUpForGate = (venue._followup_step || 1) > 1;
  if (!dryRun && venue.contact_email) {
    const gate = await canContactAddress(venue.contact_email, env, { isFollowUp: _isFollowUpForGate });
    if (!gate.ok) {
      console.log(`[Outreach] Contact gate blocked ${venue.contact_email} for ${venue.id}: ${gate.reason} — ${gate.detail}`);
      if (gate.reason === 'placeholder_address' || gate.reason === 'previously_declined') {
        await env.DB.prepare(`
          UPDATE venues SET status = 'lead_closed',
            notes = COALESCE(notes || char(10), '') || ?,
            updated_at = datetime('now')
          WHERE id = ? AND status != 'lead_closed'
        `).bind(`[auto ${new Date().toISOString().slice(0, 10)} gate:${gate.reason}] ${gate.detail || ''}`, venue.id).run().catch(e => console.error('[Outreach] lead_closed mark failed:', e.message));
      }
      return { action: 'skipped', reasoning: `Contact gate: ${gate.reason}. ${gate.detail || ''}` };
    }
  }

  // Phase D: check for per-step override BEFORE drafting
  const stepForOverride = venue._followup_step || venue._forced_step || 1;
  const override = await env.DB.prepare(
    `SELECT skip, custom_subject, custom_body, custom_send_at FROM lead_overrides
     WHERE lead_id = ? AND funnel = 'wholesale' AND step_n = ?`
  ).bind(venue.id, stepForOverride).first().catch(() => null);
  if (override?.skip) {
    return { action: 'skipped', reasoning: `Step ${stepForOverride} explicitly skipped by operator override.` };
  }
  if (override?.custom_send_at) {
    const target = new Date(override.custom_send_at);
    if (target > new Date()) {
      return { action: 'skipped', reasoning: `Step ${stepForOverride} rescheduled by operator to ${override.custom_send_at}. Not yet due.` };
    }
  }
  if (override?.custom_body && !dryRun) {
    // Operator-authored body: use verbatim, bypass LLM draft, still respect approval gate.
    const subject = override.custom_subject || `Re: ${venue.name}`;
    const body = override.custom_body;
    // Route through existing send-or-park with the gated=true path:
    try {
      const result = await _persistOperatorDraft(venue, env, { subject, body, step_n: stepForOverride });
      return result;
    } catch (e) {
      console.error('[overrides] operator-draft persist failed:', e.message);
      // Fall through to normal agent path as a safety net
    }
  }

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
- Reference the prior email casually ("Just following up" / "Wanted to circle back")
- ${venue._followup_step === 2
    ? 'Day-3 tone: Light, casual, add one new detail or angle. "Hey, quick follow-up — [new hook]. Would love to drop some by."'
    : venue._followup_step === 3
    ? 'Day-7 tone: Final touch, no pressure. "Totally get it if the timing\'s off — just wanted to make sure this didn\'t get buried. Happy to chat whenever."'
    : 'Day-14 BREAK-UP tone: This is the LAST email. Gracious, zero pressure, leave the door open. "Hey — not trying to fill your inbox. Just wanted to say the offer stands whenever timing works. No hard feelings either way. Happy to chat anytime." Sign off warm. This email should make them WANT to reply because you\'re NOT pushing.'}
- Do NOT re-pitch everything. The first email did that.
- Use the SAME contact_email as the prior email.
- SUBJECT LINE: Use "Re: [original subject]" exactly. Do NOT write a new creative subject. The system will enforce this.
- NO HALLUCINATED EVENTS: Do NOT reference upcoming events, seasons, or dates unless you have confirmed evidence with a specific date. If venue notes mention a timing signal, do NOT assume it is current — it may be stale or evergreen website content. Stick to the offer and the ask.
- Do NOT use em dashes (—) in subject lines. Use a regular dash (-) or rephrase.
- Skip fetch_venue_website — you already researched this venue.
- Start with check_contact_history, then draft_and_evaluate_email, then send_or_park_email.` : '';

  // Build timing signal context if signal scanner found a hook for this venue
  const today = new Date().toISOString().split('T')[0];
  const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
  const signalContext = venue._signal_score >= 6
    ? `\n\nTIMING SIGNAL (score ${venue._signal_score}/10, source: ${venue._signal_type}):
${venue._signal_summary}

Today is ${today} (${currentMonth}). BEFORE using this signal:
- Verify the event/season is actually upcoming or current. "Oktoberfest" in April is NOT upcoming.
- If the signal mentions an event with no specific date, treat it as UNVERIFIED — do not reference it in the email.
- If the signal IS temporally valid, use it as the hook angle. If NOT, ignore it and find a different angle from your research.
- NEVER fabricate or assume event dates. If you're not sure, skip the signal entirely.`
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
      env,
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

      // Don't re-flag venues Drew already reviewed
      if (venue.notes?.includes('[Reviewed by Drew]')) {
        return { skipped: true, reason: 'Venue was already reviewed by Drew — do not re-flag' };
      }

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

HARD PRECONDITIONS — check before drafting:
- contact_name has a real first name (not null, not "the team", not "there"). If missing → return {"self_score": 0, "subject": "HOLD", "body": "HOLD:needs_contact_name", "score_breakdown": {}, "rewritten": false}
- research_summary contains at least one dated, venue-unique detail from the last 90 days (specific show, event, person, news, award, menu change, social post). Category-level framing does not count. If missing → return {"self_score": 0, "subject": "HOLD", "body": "HOLD:no_specific_hook", "score_breakdown": {}, "rewritten": false}
- research_summary does NOT indicate the venue already sells pretzels, has a branded snack program, or follows Dangerous Pretzel. If it does → return {"self_score": 0, "subject": "HOLD", "body": "HOLD:already_has_program", "score_breakdown": {}, "rewritten": false}

SUBJECT LINE: Follow the A/B variant instruction above. Never salesy.

PICK ONE EMAIL SHAPE — the one that fits this venue's hook best. Do not default to the same shape every time.

SHAPE A — "Short & direct" (use when the hook is strong and recent, e.g. a just-announced show or new hire).
  Format: 4-6 sentences total, flowing prose, no bullets, no headers.
  Structure: Named greeting → specific hook sentence → one-line offer → one-line social proof → one-line CTA → signoff.
  Example voice: "Hi Ember, saw the Lyle Lovett date dropped for July 12 — that's the exact summer-evening crowd our pretzels hit for. We're the pretzel at Sandy Amphitheater and Delta Center; your staff just warms and serves. Mind if I drop some by for your team before the season kicks off? — Drew"

SHAPE B — "Quarters-style with labeled bullets" (use when the hook is operational — a new F&B setup, a renovation, a high-traffic event series).
  Format: Named greeting → 1-sentence fan opener tied to the hook → 1-sentence product/proof → "Why it fits [Venue]:" header + 3 labeled bullets (one must include real numbers: $10 retail / $6 profit) → 1-sentence CTA → signoff.

SHAPE C — "Question-led" (use when the hook is a visible gap — reviews mentioning no food, an IG post asking for vendor recs, a new opening with no snack menu).
  Format: Named greeting → open with a direct question tying to the gap ("Are you set on food vendors for the summer series yet?") → 1-sentence of what we'd do → one anchor account name-drop → one-line CTA → signoff.

SIGNOFF (all shapes): "— Drew\\n\\n--\\nDrew Sparks\\nOwner\\nDangerous Pretzel Co\\nc: 801.916.9122"

RULES THAT APPLY TO ALL SHAPES:
- First non-greeting sentence MUST cite the specific dated hook from research. If you can't, you failed the precondition — return HOLD.
- No sentence over 25 words. No paragraph over 3 lines.
- Named greeting ONLY. "Hi there," / "Hi team," / "Hello all," are an automatic HOLD.
- Vary word choice across shapes — do not recycle "exactly who loves these" or "genuinely great" or "the kind of thing people talk about" in every email.
- No claims about accounts we don't have. Valid proof: Delta Center, SLC Bees, Sandy Amphitheater, Union Event Center, Pioneer Theater, Powder Mountain, Alta (Goldminer's Daughter), TF Brewery, Hopkins, ROHA, HK Brewing. Everything else = do not cite.

BANNED (instant rewrite): "I hope this finds you well", "I wanted to reach out", "exciting opportunity", "touch base", "synergies", "value proposition", "Please don't hesitate", "Looking forward to hearing from you", any sentence over 25 words.

SCORE AGAINST REPLY-LIKELIHOOD, NOT TEMPLATE ADHERENCE. The only question is: would this specific named person, on a busy Tuesday, hit reply and type a response? Not open — REPLY.

Score these four dimensions 1-10:
- Hook (1-10): The opening sentence cites a specific, dated, venue-unique detail from the last 90 days. Generic category framing ("your crowd loves these", "peak season") = 4. A concrete recent reference = 8+. A reference that proves you did more than 30 seconds of research = 10.
- Reply likelihood (1-10): Imagine you are ${input.contact_name || 'this person'} reading this in an inbox of 40 unread emails. What's the honest probability you type a reply today? 20% = 5. 50% = 8. Don't be optimistic — most cold emails score 3-5 here and that is fine; hold the draft instead of sending a 5.
- Voice (1-10): Sounds like Drew texting a peer, not a vendor pitching. Any banned phrase or corporate-y hedge = 4 or below.
- Friction (1-10): One clear yes/no question, no homework required, no scheduling link. Can the recipient answer in under 10 seconds?

self_score = min of the four. Not the average. A draft with 9/9/9/3 is a 3 — not an 8. If any dimension is below 8, REWRITE ONCE. If still below 8 after rewrite, return it anyway — the send_or_park gate will hold it and we'll learn from the pattern.

If you preconditioned-held (contact_name missing, no specific hook, or already_has_program), ignore all of the above and return the HOLD JSON from the precondition section.

Return JSON:
{
  "subject": "...",
  "body": "...",
  "self_score": 8,
  "score_breakdown": {"hook": 8, "reply_likelihood": 8, "voice": 9, "friction": 9},
  "rewritten": false
}`; })()

      // DIF-3 (May 13 2026): wired through ai-budget
      const draftResult = await callAI(env, {
        use_case: 'outreach_email_draft',
        model: 'sonnet',
        caller: 'outreach-agent.js',
        max_tokens: 800,
        system: AGENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: draftPrompt }],
      });

      const draftText = draftResult.ok ? (draftResult.content || '') : '';
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

      // ── PROGRAMMATIC QUALITY GATES (cannot be bypassed by self-scoring) ──

      // Banned phrase check
      const bannedFound = checkBannedPhrases(input.subject || '', input.body || '');
      if (bannedFound.length > 0) {
        return {
          action: 'held',
          reason: `Draft contains banned phrases: ${bannedFound.join(', ')}. Must rewrite.`,
          banned_phrases: bannedFound,
        };
      }

      // Sentence length check (max 25 words)
      const longSentences = checkSentenceLength(input.body || '');
      if (longSentences.length > 0) {
        return {
          action: 'held',
          reason: `Draft has ${longSentences.length} sentence(s) over 25 words. Shorten and rewrite.`,
          long_sentences: longSentences.map(s => s.slice(0, 80) + '...'),
        };
      }

      // Agent-signalled HOLD (needs_contact_name, no_specific_hook)
      if ((input.subject || '').trim() === 'HOLD' || (input.body || '').startsWith('HOLD:')) {
        const holdReason = (input.body || '').slice(5) || 'agent_hold';
        // Flag for Drew so a human can find the right contact or hook
        await env.KV.put(
          `drew_flag:${input.venue_id}`,
          JSON.stringify({
            venue_id: input.venue_id,
            venue_name: venue.name,
            reason: `Agent held: ${holdReason}`,
            suggested_approach: holdReason === 'needs_contact_name'
              ? 'Find a named contact (LinkedIn, venue staff page, IG DM) before automated outreach'
              : 'Research a specific hook (recent event, show, news item) before drafting',
            flagged_at: new Date().toISOString(),
          }),
          { expirationTtl: 60 * 60 * 24 * 14 }
        ).catch(() => {});
        return { action: 'flagged', reason: holdReason, flagged_for: 'drew' };
      }

      // Belt-and-braces: block any draft with a nameless greeting.
      // Matches "Hi there,", "Hi team,", "Hello there,", "Hey there,", "Hi all,", "Hey team,"
      // at the very start of the body (case-insensitive). Named greetings (Hi Ember,) pass.
      const firstLine = (input.body || '').trim().split('\n')[0];
      if (/^(hi|hello|hey|dear)\s+(there|team|all|folks|everyone|y'?all)\b/i.test(firstLine)) {
        return {
          action: 'flagged',
          reason: 'nameless_greeting',
          flagged_for: 'drew',
          detail: 'Draft starts with a generic greeting — no named contact. Research a specific person before sending.',
        };
      }

      // ── INDEPENDENT VALIDATION (Claude Haiku review — catches hallucinations) ──
      const validation = await validateOutreachEmail(
        input.subject, input.body, venue,
        input.reasoning || '', // agent's research synthesis
        env
      );
      if (!validation.pass) {
        console.log(`[Outreach] Validation failed for ${venue.name}: ${validation.issues.join(', ')}`);
        return {
          action: 'held',
          reason: `Validation failed: ${validation.issues.join('; ')}`,
          validation_issues: validation.issues,
          suggestion: validation.suggestion,
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

      // ── Follow-up threading: look up prior email's Gmail thread ID ──
      let priorThreadId = null;
      if (seqStep > 1 && venue._prior_log_id) {
        const priorLog = await env.DB.prepare(
          'SELECT gmail_thread_id, subject FROM outreach_logs WHERE id = ?'
        ).bind(venue._prior_log_id).first();
        priorThreadId = priorLog?.gmail_thread_id || null;

        // Enforce Re: subject for follow-ups (thread consistency)
        if (priorLog?.subject && !input.subject.startsWith('Re:')) {
          input.subject = `Re: ${priorLog.subject}`;
        }
      }

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
                threadId: priorThreadId,
              },
            });
          } catch (err) {
            // Workflow not available — fall back to legacy D1 park
            console.error('[Outreach] Workflow spawn failed, falling back to D1 park:', err.message);
            await env.DB.prepare(`
              INSERT INTO outreach_logs (
                id, venue_id, sequence_step, channel, direction,
                subject, body, from_address, to_address,
                gmail_thread_id,
                approval_status, agent_reasoning, self_score,
                subject_variant, created_at
              ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
            `).bind(
              logId, input.venue_id, seqStep, input.subject, input.body,
              env.FROM_EMAIL, venue.contact_email,
              priorThreadId,
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
              gmail_thread_id,
              approval_status, agent_reasoning, self_score,
              subject_variant, created_at
            ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
          `).bind(
            logId, input.venue_id, seqStep, input.subject, input.body,
            env.FROM_EMAIL, venue.contact_email,
            priorThreadId,
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
        // Send directly (with threading for follow-ups)
        const gmailResult = await sendGmail(env, {
          to:      venue.contact_email,
          subject: input.subject,
          body:    input.body,
          threadId: priorThreadId,
          logId,
          isFollowUp: seqStep > 1,
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
async function callClaudeWithTools(env, systemPrompt, messages) {
  // DIF-3 (May 13 2026): wired through ai-budget
  // Tool-loop pattern: callers expect `response.content` (raw blocks array)
  // and `response.stop_reason`. We reconstruct that shape from callAI's
  // result.raw so the agentic loop's behavior is preserved exactly.
  const result = await callAI(env, {
    use_case: 'outreach_copy_review',
    model: 'sonnet',
    caller: 'outreach-agent.js',
    max_tokens: 2000,
    system: systemPrompt,
    tools: AGENT_TOOLS,
    messages,
  });

  if (!result.ok) {
    throw new Error(`Claude API error: ${result.blocked_reason || result.error || 'unknown'}`);
  }

  // Preserve the raw response shape consumed by the agentic loop.
  return result.raw;
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
    isFollowUp: (log.sequence_step || 1) > 1,
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

  // DIF-3 (May 13 2026): wired through ai-budget
  const result = await callAI(env, {
    use_case: 'outreach_response_generation',
    model: 'sonnet',
    caller: 'outreach-agent.js',
    max_tokens: 800,
    messages: [{ role: 'user', content: redraftPrompt }],
  });

  if (!result.ok) {
    // callAI prefixes exceptions with "exception:" — map to the original
    // "unreachable" 502; everything else (non-ok HTTP, budget block) maps
    // to the original "API error" 502.
    const errStr = result.error || result.blocked_reason || 'unknown';
    if (errStr.startsWith('exception:')) {
      console.error('[Redraft] Claude API unreachable:', errStr);
      return new Response(JSON.stringify({ error: 'Claude API unreachable: ' + errStr }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    console.error('[Redraft] Claude API error:', errStr.slice(0, 200));
    return new Response(JSON.stringify({ error: 'Claude API error', detail: errStr.slice(0, 300) }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  const text = result.content || '';
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

// ── EMAIL VALIDATION (independent Claude review — catches hallucinations) ─────
// Mirrors retail validateSMS() pattern: separate LLM call reviews the draft
// against research data, venue context, and current date.
async function validateOutreachEmail(subject, body, venue, researchData, env) {
  const issues = [];

  // Layer 1: Programmatic checks (free, instant)
  const banned = checkBannedPhrases(subject, body);
  if (banned.length > 0) issues.push(`Banned phrases: ${banned.join(', ')}`);

  const longSentences = checkSentenceLength(body);
  if (longSentences.length > 0) issues.push(`${longSentences.length} sentence(s) over 25 words`);

  // Check signature block
  if (!body.includes('Drew Sparks') || !body.includes('801.916.9122')) {
    issues.push('Missing or incomplete signature block');
  }
  if (body.includes('Drew Craker')) {
    issues.push('Wrong name in signature — should be Drew Sparks, not Drew Craker');
  }

  // Layer 2: Claude Haiku review (cheap, catches hallucinations + voice)
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });

    const reviewPrompt = `You are a quality reviewer for cold outreach emails sent by Dangerous Pretzel Co (a Salt Lake City soft pretzel brand).

Today's date: ${today} (${currentMonth})

VENUE CONTEXT:
Name: ${venue.name}
Category: ${venue.category || 'unknown'}
Notes: ${(venue.notes || '').slice(0, 500)}
Qualifier summary: ${(venue.qual_summary || '').slice(0, 300)}

RESEARCH DATA AVAILABLE TO THE DRAFTER:
${(researchData || 'No research data recorded').slice(0, 800)}

DRAFT EMAIL:
Subject: ${subject}
Body:
${body}

Review this email for these specific issues. Return JSON only:

1. HALLUCINATION CHECK: Does the email reference any facts, events, dates, or details NOT present in the venue context or research data? Examples:
   - Mentioning an event (Oktoberfest, summer concert, etc.) with no evidence it's upcoming
   - Claiming the venue doesn't have food when research doesn't confirm this
   - Referencing specific menu items, staff names, or details not in the research

2. TEMPORAL CHECK: Are seasonal/event references actually current for ${currentMonth}?
   - "Oktoberfest coming up" in April = FAIL
   - "Summer season" in April = OK (upcoming)
   - "Patio season" in April in Salt Lake City = OK

3. VOICE CHECK: Does it sound like a local business owner texting a peer, or a sales rep?
   - Corporate energy, buzzwords, or pitch-deck language = FAIL
   - Overly formal or stiff = FAIL

4. VENUE FIT: Does the pitch match the venue type?
   - Telling a full-service restaurant "no kitchen needed" = awkward
   - Brewery pitch should reference beer/taproom context

5. EXISTING PROGRAM CHECK: Do the venue notes, qualifier summary, or research data indicate the venue ALREADY sells pretzels, already has a branded snack/food partner, or already follows Dangerous Pretzel on social? Look for: "pretzel", "already have vendor", "already have snack", "food partner", "branded concession", "@dangerouspretzelco" in followers/mentions. If yes = FAIL with issue "already_has_program" — this should have been held, not drafted.

6. SPECIFIC HOOK CHECK: Does the opening sentence (first non-greeting sentence) reference a specific, dated, venue-unique detail? Not "your crowd", not "peak season", not "concert-goers love pretzels" — an actual show, event, person, news item, or social post that could only apply to THIS venue. If the opener is generic category framing = FAIL with issue "generic_opener".

7. NAMELESS GREETING: If the email opens with "Hi there,", "Hi team,", "Hello all,", "Dear team," or any variant without a named human = FAIL with issue "nameless_greeting".

Return ONLY this JSON:
{"pass": true/false, "issues": ["issue1", "issue2"], "suggestion": "one-line fix if minor, null if major rewrite needed"}`;

    // DIF-3 (May 13 2026): wired through ai-budget
    const reviewResult = await callAI(env, {
      use_case: 'outreach_evaluation',
      model: 'haiku',
      caller: 'outreach-agent.js',
      max_tokens: 300,
      messages: [{ role: 'user', content: reviewPrompt }],
    });

    if (!reviewResult.ok) {
      // Mirror the original catch-block behavior: surface "haiku review failed".
      throw new Error(reviewResult.blocked_reason || reviewResult.error || 'review_failed');
    }

    const reviewText = reviewResult.content || '';
    const clean = reviewText.replace(/```json\n?|\n?```/g, '').trim();
    const review = JSON.parse(clean);

    if (!review.pass && review.issues) {
      issues.push(...review.issues);
    }

    return {
      pass: issues.length === 0,
      issues,
      suggestion: review.suggestion || null,
      review_source: 'haiku',
    };
  } catch (err) {
    // If Haiku review fails, still return programmatic issues
    console.error(`[Outreach] Validation review error: ${err.message}`);
    return {
      pass: issues.length === 0,
      issues,
      suggestion: null,
      review_source: 'programmatic_only',
    };
  }
}

// RFC 2047 encode subject line when it contains non-ASCII characters
function encodeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  const bytes = new TextEncoder().encode(subject);
  const b64 = btoa(String.fromCharCode(...bytes));
  return `=?UTF-8?B?${b64}?=`;
}

// ── CLICK TRACKING REWRITE ───────────────────────────────────────────────────
// V3 Bug 1.5 — wrap every http(s) link in the email body with a tracked
// redirect. Skips `mailto:`, `tel:`, and the tracking pixel itself.
function rewriteLinksForTracking(body, logId) {
  if (!body || !logId) return body;
  const base = 'https://pretzel-os.drew-f39.workers.dev/track/click/';
  // b64url-safe encoder
  const encode = (s) => {
    const bytes = new TextEncoder().encode(s);
    const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
    return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  // Match bare URLs (not inside <a href=...>, not the tracking pixel URL itself).
  // We rewrite http/https URLs, one replacement per match.
  return body.replace(/(https?:\/\/[^\s<>"')]+)/g, (match) => {
    if (match.startsWith('https://pretzel-os.drew-f39.workers.dev/outreach/pixel/')) return match;
    if (match.startsWith('https://pretzel-os.drew-f39.workers.dev/track/click/')) return match;
    return `${base}${logId}?u=${encode(match)}`;
  });
}

async function sendGmail(env, { to, subject, body, threadId, logId, isFollowUp = false }) {
  // Bug 1.1 Site (c): final send-time gate. Belt-and-braces defense in case a draft
  // slipped past the pre-draft + approval-queue gates. Abort loudly if blocked.
  // Follow-ups (isFollowUp=true) intentionally bypass recent_send_exists.
  const gate = await canContactAddress(to, env, { isFollowUp });
  if (!gate.ok) {
    console.error(`[Outreach] sendGmail ABORTED — ${gate.reason}: ${gate.detail || ''} (to=${to}, logId=${logId})`);
    throw new Error(`contact_gate_blocked: ${gate.reason}`);
  }

  // V3 Bug 1.5 — rewrite http(s) URLs in the body for click tracking before HTML-ify.
  body = rewriteLinksForTracking(body, logId);

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
    `Subject: ${encodeSubject(subject)}`,
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
  // Hard cap and per-venue timeout so the scheduled handler never blows its CPU
  // budget and leaves cron_runs with a zombie 'running' row. 30s per venue × 15 = 7.5min
  // worst-case which is under the typical 15-min scheduled-handler wall.
  const SCAN_CAP = 15;
  const PER_VENUE_TIMEOUT_MS = 30_000;
  const scanStart = Date.now();
  const loopCandidates = candidates.slice(0, SCAN_CAP);

  for (const venue of loopCandidates) {
    // Global budget check — if we're already at 10min across the whole loop, stop.
    if (Date.now() - scanStart > 10 * 60 * 1000) {
      console.warn('[Signal Scanner] 10min budget exhausted — stopping early at', scanned, 'scanned');
      break;
    }
    const vStart = Date.now();
    try {
      // Per-venue timeout wrapper — if any one venue's combined fetches/AI calls exceed 30s, abort it.
      const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('venue-scan timeout')), PER_VENUE_TIMEOUT_MS));
      await Promise.race([
        (async () => {
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
                  type: igClassification.signal_type || 'instagram',
                  score: igClassification.score,
                  summary: igClassification.summary,
                  has_specific_date: igClassification.has_specific_date || false,
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
                type: reviewClassification.signal_type || 'google_reviews',
                score: reviewClassification.score,
                summary: reviewClassification.summary,
                has_specific_date: reviewClassification.has_specific_date || false,
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
                type: webClassification.signal_type || 'website',
                score: webClassification.score,
                summary: webClassification.summary,
                has_specific_date: webClassification.has_specific_date || false,
                source: venue.website,
                raw: text.slice(0, 500),
              });
            }
          }
        } catch { /* Website fetch failed — skip */ }
      }

      // ── Quality gate: cap scores for undated event/seasonal signals ──
      for (const sig of signals) {
        if ((sig.type === 'event' || sig.type === 'seasonal') && !sig.has_specific_date) {
          const originalScore = sig.score;
          sig.score = Math.min(sig.score, 5); // cap at moderate
          if (originalScore !== sig.score) {
            console.log(`[Signal Scanner] Capped ${venue.name} ${sig.type} signal from ${originalScore} to ${sig.score} (no specific date)`);
          }
        }
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
        })(),
        timeoutP,
      ]);
    } catch (err) {
      const elapsed = Date.now() - vStart;
      console.error(`[Signal Scanner] Error scanning ${venue.name} after ${elapsed}ms:`, err.message);
    }
  }

  console.log(`[Signal Scanner] Done. Scanned ${scanned}/${loopCandidates.length} (cap=${SCAN_CAP}, total_ms=${Date.now() - scanStart}), found ${signalsFound} signals`);
  return { scanned, signals_found: signalsFound, cap: SCAN_CAP, budget_ms: Date.now() - scanStart };
}

// ── Workers AI signal classifier (free, no Claude cost) ────────────────────
async function classifySignal(env, venueName, source, content) {
  if (!env.AI) return null;
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

    const prompt = `You are analyzing ${source} content for "${venueName}" to find timing signals for a food vendor outreach.

TODAY'S DATE: ${today} (${currentMonth})

CONTENT:
${content.slice(0, 800)}

CRITICAL TEMPORAL RULES:
- Only score events as HIGH-VALUE (7+) if they are UPCOMING (within the next 60 days) or CURRENTLY HAPPENING
- Past events = score 3 max. "Oktoberfest" in April is NOT a timing signal — it's 6 months away
- Annual events mentioned generically without a specific upcoming date = score 4 max (could be evergreen website copy)
- Permanent website content (about page, general menus, location info) = score 3 max
- A summer concert series mentioned in April/May = valid upcoming signal
- If NO specific dates are in the content, assume it is evergreen/permanent = score 4 max
- "Already has food vendor/program" or "already serves pretzels/snacks" = score 1 (NOT a prospect)

HIGH-VALUE timing signals (score 7-10) — ONLY if temporally valid:
- New UPCOMING event announced (with date within 60 days)
- Renovation or expansion just completed
- New food menu launched or "wish we had food" reviews
- New GM, F&B director, or events manager recently hired
- Seasonal opening about to happen (patio season starting, summer events)
- "No food options" complaints in recent reviews

MODERATE signals (score 5-6):
- General positive momentum (good reviews, growing)
- Active social media posting about upcoming events (but no specific dates)
- Mentions of snacks, appetizers, or food vendors

LOW/NO signal (score 1-4):
- No relevant content found
- Off-season or closing
- Recent negative events
- Already has a food vendor or food program
- Evergreen website content with no temporal hook

Return JSON only:
{"score":7,"summary":"One sentence — what the signal is and why NOW is the right time","signal_type":"event|renovation|food_gap|new_hire|seasonal|general","has_specific_date":true}`;

    const resp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: `You classify timing signals for sales outreach. Today is ${today}. Return valid JSON only, no markdown. Be skeptical — most website content is evergreen and NOT a timing signal.` },
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
