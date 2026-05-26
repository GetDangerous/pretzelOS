-- Migration 006: Summer Campaign 2026
-- Adds campaign tracking columns to venues, seeds summer venues + prompts + brain entries

-- ── Schema ────────────────────────────────────────────────────────────────────

ALTER TABLE venues ADD COLUMN campaign TEXT;
ALTER TABLE venues ADD COLUMN contact_instagram TEXT;
ALTER TABLE venues ADD COLUMN contact_method_note TEXT;
CREATE INDEX IF NOT EXISTS idx_venues_campaign ON venues(campaign);

-- ── Seed: 14 Summer 2026 Venues ───────────────────────────────────────────────
-- 12 Tier 1 prospects + Sandy Amphitheater + Union Event Center (active proof points)

INSERT INTO venues (id, name, category, city, tier, status, campaign, notes, created_at, updated_at) VALUES
  (lower(hex(randomblob(16))), 'Sandy Amphitheater', 'summer_venue', 'Sandy', 1, 'active', 'summer_2026', 'Active proof point. Already running warmers. Use as reference in every summer email.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'The Union Event Center', 'summer_venue', 'Salt Lake City', 1, 'active', 'summer_2026', 'Active proof point. Already running warmers. Use as reference in every summer email.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'USANA Amphitheater', 'summer_venue', 'West Valley City', 1, 'prospect', 'summer_2026', 'Live Nation operated. 20k cap. Target F&B Director. May need Live Nation corporate contact.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Red Butte Garden Concerts', 'summer_venue', 'Salt Lake City', 1, 'prospect', 'summer_2026', 'Nonprofit. Target Executive Director + F&B. 4000 cap. Upscale crowd. Staff directory on website.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Deer Valley Concert Series', 'summer_venue', 'Park City', 1, 'prospect', 'summer_2026', 'Resort operated. Target F&B Manager. Alta/Powder Mountain is warm intro opportunity.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Ogden Amphitheater', 'summer_venue', 'Ogden', 1, 'prospect', 'summer_2026', 'City of Ogden. Ogden Twilight series. Target city events staff.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'This Is The Place Heritage Park', 'summer_venue', 'Salt Lake City', 1, 'prospect', 'summer_2026', 'State-operated. Seasonal festivals. Target Operations Manager.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Gallivan Center', 'summer_venue', 'Salt Lake City', 1, 'prospect', 'summer_2026', 'Downtown SLC. City-operated. Summer concert series. Target events coordinator.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Snowbird Summer Concerts', 'summer_venue', 'Snowbird', 1, 'prospect', 'summer_2026', 'Resort summer program. Target F&B Director. Alta connection is warm intro.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Sundance Resort Sunday Concerts', 'summer_venue', 'Sundance', 1, 'prospect', 'summer_2026', 'Resort-operated. Target F&B Manager.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Utah State Fairgrounds', 'summer_venue', 'Salt Lake City', 1, 'prospect', 'summer_2026', 'State fair + year-round events. Target Operations Director. Very high volume potential.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Utah Arts Festival', 'summer_venue', 'Salt Lake City', 1, 'prospect', 'summer_2026', 'Annual outdoor festival. Target Executive Director. Nonprofit. June event — reach out now.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Provo Rooftop Concert Series', 'summer_venue', 'Provo', 1, 'prospect', 'summer_2026', 'Utah County outdoor series. Find organizer via website or Instagram.', datetime('now'), datetime('now')),
  (lower(hex(randomblob(16))), 'Weber County Fairgrounds', 'summer_venue', 'Ogden', 1, 'prospect', 'summer_2026', 'County fair + events. Target Operations/Events Manager.', datetime('now'), datetime('now'));

-- ── Seed: 3 Agent Prompts ─────────────────────────────────────────────────────

INSERT OR IGNORE INTO agent_prompts (id, agent_name, version, prompt_text, system_context) VALUES

('ap_summer_v2', 'summer_venue_email', 1,
'Write a cold outreach email to an outdoor summer venue.

Venue: {{venue_name}} · {{city}}
Contact: {{contact_name}}, {{contact_title}}
Research: {{research_notes}}

MUST INCLUDE:
- Sandy Amphitheater named specifically (starting May 2026)
- The Union Event Center named (already active)
- Branded warmer + serving materials at no cost
- Pretzels reheat in minutes, stay warm for hours
- Trial run: one warmer, one event, zero commitment
- Phone: 801.916.9122
- May season deadline creates urgency

THE TRIAL CLOSER (use this exactly):
"One warmer, one night. If your guests do not love it, we pick up the warmer and you owe us nothing. We have never had to do that."

RULES:
- Under 130 words total
- No "I hope this finds you well" or any filler opener
- One clear ask at the end: call or visit with samples
- Subject line should be specific to the venue

Self-score the email before returning:
+2 if Sandy Amphitheater named
+2 if trial run offer included
+2 if May referenced
+1 if phone 801.916.9122 present
+1 if under 130 words
+1 if subject is venue-specific (not generic)

Return JSON only: {"subject": "...", "body": "...", "self_score": N, "score_breakdown": "..."}',

'Summer venue outreach 2026. Phone 801.916.9122. Sandy Amphitheater and Union Event Center are the proof points — name them. Trial run is the closer: one warmer, one night, zero commitment. Warmer and serving materials free. Pretzels warm for hours. May deadline is the urgency. Under 130 words. No filler openers.'),

('ap_summer_fu1_v2', 'summer_venue_followup1', 1,
'Day-4 follow-up to a summer venue with no reply.

Venue: {{venue_name}} · {{city}}

Focus: one event trial, zero risk. Offer to connect them with Sandy Amphitheater team if they want a peer reference.

RULES:
- Under 90 words
- Phone 801.916.9122 must appear
- Restate the zero-risk offer clearly
- Do not re-explain the whole product

Return JSON: {"subject": "...", "body": "..."}',
'Zero risk trial is the entire message. Keep it short. Sandy Amphitheater as peer reference offer.'),

('ap_summer_fu2_v2', 'summer_venue_followup2', 1,
'Final day-8 follow-up to a summer venue. This is the last note before their season.

Venue: {{venue_name}} · {{city}}

Name Red Butte Gardens, Sandy Amphitheater, and The Union Event Center as venues running this summer.
Trial run still available.
Leave door open for fall if timing does not work.

RULES:
- Under 70 words
- Short and respectful — they may just be busy
- Phone 801.916.9122

Return JSON: {"subject": "...", "body": "..."}',
'Short final note. Three proof points named. Leave door open for fall.');

-- ── Seed: 7 Business Brain Entries ───────────────────────────────────────────

INSERT INTO business_brain (id, scope, category, instruction, active, created_at, updated_at) VALUES
  (lower(hex(randomblob(16))), 'outreach', 'nuance',
   'Summer venues need urgency + the trial run offer. Always name Sandy Amphitheater (starting May 2026) and The Union Event Center (already active). The trial closer to use verbatim: "One warmer, one night. If your guests do not love it, we pick up the warmer. We have never had to do that." This closes hesitant venues.',
   1, datetime('now'), datetime('now')),

  (lower(hex(randomblob(16))), 'outreach', 'product',
   'Pretzels reheat in a few minutes and stay warm and fresh for several hours after reheating. Zero waste risk, zero timing stress for event staff. This is a key operational advantage for outdoor venues — mention it explicitly.',
   1, datetime('now'), datetime('now')),

  (lower(hex(randomblob(16))), 'outreach', 'product',
   'For summer venues we provide branded warmer(s) AND all serving materials (napkins, bags, tongs) at no cost. Venue owns nothing. Zero upfront investment. Remove every objection by stating this clearly in the first email.',
   1, datetime('now'), datetime('now')),

  (lower(hex(randomblob(16))), 'outreach', 'voice',
   'Drew phone for summer 2026 campaign: 801.916.9122. Include in every summer venue email. Summer decisions move fast — venue ops managers often call directly rather than reply by email.',
   1, datetime('now'), datetime('now')),

  (lower(hex(randomblob(16))), 'outreach', 'market',
   'Summer contact finding order: (1) venue website staff directory — look for F&B Manager, Operations Manager, Events Director, Concessions Manager; (2) general contact email on website; (3) LinkedIn company page — filter for F&B/events/operations titles; (4) Google search "[venue] food beverage manager"; (5) Instagram DM as last resort — flag for Drew only, never automate the DM.',
   1, datetime('now'), datetime('now')),

  (lower(hex(randomblob(16))), 'outreach', 'market',
   'Pioneer Day (July 24) is Utah''s biggest outdoor holiday — bigger than July 4th for many communities. Every city has celebrations. Target parks and recreation departments in all SLC, Utah County, and Weber County cities. These are perfect high-volume single-day accounts.',
   1, datetime('now'), datetime('now')),

  (lower(hex(randomblob(16))), 'outreach', 'market',
   'Cast wide net for summer venues: beer festivals, farmers markets with evening programming, university outdoor events, city park concert series, county fairs, sports tournaments, cultural festivals, resort summer programs, golf tournament hospitality. Any outdoor gathering of 200+ people is a pretzel account.',
   1, datetime('now'), datetime('now'));
