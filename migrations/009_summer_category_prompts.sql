-- Migration 009: Summer campaign category-specific email prompts
-- These fill the gaps referenced in outreach-agent.js:
--   ap_summer_golf_v1     → golf clubs / country clubs
--   ap_summer_brewery_v1  → breweries / taprooms
--   ap_summer_fair_v1     → fairgrounds / festivals / other events
-- Run: npx wrangler d1 execute pretzel-os --remote --file=migrations/009_summer_category_prompts.sql

INSERT OR IGNORE INTO agent_prompts (id, agent_name, version, prompt_text, system_context) VALUES

-- ── GOLF / COUNTRY CLUB ───────────────────────────────────────────────────────
('ap_summer_golf_v1', 'summer_golf_email', 1,
'Write a cold outreach email to a golf club or country club.

Venue: {{venue_name}} · {{city}}
Contact: {{contact_name}}, {{contact_title}}
Research: {{research_notes}}

MUST INCLUDE:
- 19th-hole framing — pretzels are a natural F&B add at the turn or in the clubhouse bar
- Members spend freely — pretzels at $7-8 are an easy impulse buy for a golfer ordering drinks
- Zero kitchen needed: warmer sits on the counter, takes 4 minutes, stays warm all day
- Free warmer trial — no capital required, no commitment
- Phone: 801.916.9122

OPTIONAL (include if contact is F&B Director or GM):
- Mention Delta Center keeps warmers on year-round — members know the product
- "Trial for one weekend to see how members respond"

RULES:
- Under 120 words total
- Do not open with "I hope this finds you well" or any filler
- One clear ask: trial at no cost
- Subject line should be club-specific

Self-score the email:
+2 if 19th hole or clubhouse F&B angle present
+2 if trial run offer included
+2 if free warmer stated
+1 if phone 801.916.9122 present
+1 if under 120 words
+1 if subject is club-specific

Return JSON only: {"subject": "...", "body": "...", "self_score": N, "score_breakdown": "..."}',

'Golf club outreach 2026. Phone 801.916.9122. 19th-hole angle — pretzels fit naturally with post-round drinks. Members pay up. Zero kitchen, free warmer trial. Delta Center as brand recognition ref. Under 120 words. No filler openers.'),

-- ── BREWERY / TAPROOM ─────────────────────────────────────────────────────────
('ap_summer_brewery_v1', 'summer_brewery_email', 1,
'Write a cold outreach email to a brewery or taproom.

Venue: {{venue_name}} · {{city}}
Contact: {{contact_name}}, {{contact_title}}
Research: {{research_notes}}

MUST INCLUDE:
- Pretzels + beer is a proven pairing — pretzels drive additional drink orders (guests buy another round when eating)
- Existing SLC brewery customers: TF Brewery, Hopkins Brewing, ROHA Brewing, HK Brewing
- Zero kitchen needed — warmer on the bar, no cook time, no mess
- Free loaner warmer — they keep 100% of pretzel margin
- Trial framing: one week, see how guests respond, no commitment
- Phone: 801.916.9122

RULES:
- Under 120 words
- Peer social proof (other SLC breweries) is the main hook
- No filler openers
- One clear ask at the end

Self-score:
+2 if SLC brewery peer names included
+2 if trial run offer included
+2 if free warmer + zero kitchen stated
+1 if phone 801.916.9122 present
+1 if under 120 words

Return JSON only: {"subject": "...", "body": "...", "self_score": N, "score_breakdown": "..."}',

'Brewery/taproom outreach 2026. Phone 801.916.9122. Peer proof: TF Brewery, Hopkins, ROHA, HK Brewing already running pretzels in SLC. Pretzels drive drink orders — natural pairing angle. Free warmer, zero kitchen, trial one week. Under 120 words. No filler.'),

-- ── FAIRGROUNDS / FESTIVALS / OTHER EVENTS ────────────────────────────────────
('ap_summer_fair_v1', 'summer_fair_email', 1,
'Write a cold outreach email to a fairgrounds, festival, or outdoor events venue.

Venue: {{venue_name}} · {{city}}
Contact: {{contact_name}}, {{contact_title}}
Research: {{research_notes}}

MUST INCLUDE:
- High-volume framing — fairgrounds/festivals move volume; pretzels scale to any crowd size
- Sandy Amphitheater (starting May 2026) and Delta Center as proof of scale
- Pretzels reheat in 4 minutes, stay warm for hours — zero waste risk, no timing stress for event staff
- Free warmer + all serving materials (napkins, bags, tongs) — venue owns nothing
- Trial run: one event, zero commitment
- Phone: 801.916.9122

RULES:
- Under 130 words
- Emphasize operational simplicity — fair/festival ops managers hate complexity
- One clear ask at the end
- Subject line specific to the event or venue

Self-score:
+2 if volume/scale angle present
+2 if trial run offer included
+2 if free warmer + serving materials stated
+1 if Sandy Amphitheater or Delta Center named
+1 if phone 801.916.9122 present
+1 if under 130 words

Return JSON only: {"subject": "...", "body": "...", "self_score": N, "score_breakdown": "..."}',

'Fairgrounds/festival outreach 2026. Phone 801.916.9122. Scale and simplicity are the hooks — fairs move volume, ops managers want zero complexity. Sandy Amphitheater + Delta Center as scale proof. Free warmer + ALL serving materials included. Trial run: one event. Under 130 words. No filler.');
