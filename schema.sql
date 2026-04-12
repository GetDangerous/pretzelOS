-- ============================================================
-- Dangerous Pretzel Co — Pretzel OS Master Schema
-- Deploy: wrangler d1 execute pretzel-os --file=schema.sql
-- ============================================================

-- ------------------------------------------------------------
-- VENUES — every prospect and account, one record each
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS venues (
  id              TEXT PRIMARY KEY,          -- apollo_id or generated uuid
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,             -- brewery | ski_resort | event_venue | theater | hotel_bar | golf | stadium | retail | other
  tier            INTEGER,                   -- 1=hot 2=warm 3=cold (set by qualifier)
  status          TEXT NOT NULL DEFAULT 'prospect',
  -- prospect → contacted → replied → meeting → active → churned

  -- Contact
  contact_name    TEXT,
  contact_title   TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,

  -- Location
  address         TEXT,
  city            TEXT,
  state           TEXT DEFAULT 'UT',
  zip             TEXT,
  lat             REAL,
  lng             REAL,

  -- Qualifier output
  qual_score      INTEGER,                   -- 0–100
  qual_summary    TEXT,                      -- Claude's one-paragraph rationale
  icp_fit         TEXT,                      -- captive_audience | high_dwell | alcohol_focused | family | other

  -- Intelligence
  website         TEXT,
  instagram       TEXT,
  yelp_url        TEXT,
  google_place_id TEXT,
  avg_rating      REAL,
  review_count    INTEGER,
  notes           TEXT,                      -- anything agent or Drew adds manually

  -- Timestamps
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  last_contacted  TEXT,
  activated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_venues_status   ON venues(status);
CREATE INDEX IF NOT EXISTS idx_venues_tier     ON venues(tier);
CREATE INDEX IF NOT EXISTS idx_venues_category ON venues(category);
CREATE INDEX IF NOT EXISTS idx_venues_city     ON venues(city);

-- ------------------------------------------------------------
-- OUTREACH_LOGS — every touchpoint, every channel
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_logs (
  id              TEXT PRIMARY KEY,
  venue_id        TEXT NOT NULL REFERENCES venues(id),
  sequence_step   INTEGER NOT NULL DEFAULT 1,  -- 1=first contact, 2=follow-up, 3=final
  channel         TEXT NOT NULL,               -- email | sms | linkedin | in_person | phone
  direction       TEXT NOT NULL DEFAULT 'out', -- out | in (reply)

  subject         TEXT,
  body            TEXT,
  from_address    TEXT,
  to_address      TEXT,

  -- Gmail thread tracking
  gmail_thread_id TEXT,
  gmail_message_id TEXT,

  -- Engagement
  sent_at         TEXT,
  opened_at       TEXT,
  clicked_at      TEXT,
  replied_at      TEXT,
  reply_body      TEXT,

  -- Outcome
  outcome         TEXT,  -- no_response | bounced | replied_interested | replied_not_interested | meeting_booked | closed

  -- Agent fields
  approval_status TEXT DEFAULT 'auto_sent', -- pending | approved | rejected | auto_sent
  agent_reasoning TEXT,                     -- why the agent made this decision
  self_score      INTEGER,                  -- Claude's quality score 1-10

  notes           TEXT,

  created_at      TEXT DEFAULT (datetime('now'))
);

-- approval_status: pending | approved | rejected | auto_sent
-- agent_reasoning: why the agent made this decision
-- self_score:      Claude's quality score for the draft (1-10)

CREATE INDEX IF NOT EXISTS idx_outreach_venue    ON outreach_logs(venue_id);
CREATE INDEX IF NOT EXISTS idx_outreach_sent     ON outreach_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_outreach_outcome  ON outreach_logs(outcome);
CREATE INDEX IF NOT EXISTS idx_outreach_approval ON outreach_logs(approval_status);

-- ------------------------------------------------------------
-- OUTREACH_HOLDS — venues the agent has decided to pause on
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_holds (
  id          TEXT PRIMARY KEY,
  venue_id    TEXT NOT NULL REFERENCES venues(id),
  reason      TEXT NOT NULL,
  hold_days   INTEGER NOT NULL,
  expires_at  TEXT NOT NULL,
  resume_note TEXT,
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_holds_venue   ON outreach_holds(venue_id);
CREATE INDEX IF NOT EXISTS idx_holds_expires ON outreach_holds(expires_at);

-- ------------------------------------------------------------
-- ACTIVE_ACCOUNTS — every live warmer placement
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS active_accounts (
  id                TEXT PRIMARY KEY,
  venue_id          TEXT NOT NULL REFERENCES venues(id),

  -- Warmer details
  warmer_model      TEXT,
  warmer_serial     TEXT,
  warmer_placed_at  TEXT,
  warmer_removed_at TEXT,

  -- SKUs they carry (comma-separated or JSON array)
  active_skus       TEXT,

  -- Reorder cadence
  last_order_date   TEXT,
  last_order_units  INTEGER,
  last_order_value  REAL,
  avg_monthly_units INTEGER,
  avg_monthly_rev   REAL,
  total_rev_lifetime REAL DEFAULT 0,

  -- Health
  health_status     TEXT DEFAULT 'green',     -- green | yellow | red
  reorder_due_date  TEXT,                     -- estimated next reorder
  consecutive_missed INTEGER DEFAULT 0,       -- weeks with no reorder
  churn_risk        INTEGER DEFAULT 0,        -- 0–100

  -- Distribution channel
  fulfilled_by      TEXT DEFAULT 'self',      -- self | us_foods | pfg_denver | pfg_slc
  account_rep       TEXT,                     -- their US Foods / PFG rep name

  -- POS integration
  square_location_id  TEXT,                  -- Square location ID for webhook matching
  toast_restaurant_guid TEXT,                -- Toast restaurant GUID for webhook matching

  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_health   ON active_accounts(health_status);
CREATE INDEX IF NOT EXISTS idx_accounts_venue    ON active_accounts(venue_id);

-- ------------------------------------------------------------
-- ORDERS — transaction-level data (Toast now, Square later)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,           -- Toast/Square order ID
  account_id      TEXT REFERENCES active_accounts(id),
  venue_id        TEXT REFERENCES venues(id),
  source          TEXT DEFAULT 'toast',       -- toast | square | manual

  order_date      TEXT NOT NULL,
  units           INTEGER,
  sku_breakdown   TEXT,                       -- JSON: {sku: units}
  gross_revenue   REAL,
  net_revenue     REAL,

  -- Review request tracking
  review_requested_at TEXT,
  review_request_method TEXT,               -- sms | qr | email
  review_outcome  TEXT,                     -- pending | clicked | submitted | skipped

  customer_phone  TEXT,
  customer_name   TEXT,
  customer_email  TEXT,

  raw_payload     TEXT,                     -- full JSON from Toast/Square

  created_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_account    ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_date       ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_source     ON orders(source);

-- ------------------------------------------------------------
-- REVIEWS — inbound reviews from all platforms
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id              TEXT PRIMARY KEY,
  venue_id        TEXT REFERENCES venues(id),
  platform        TEXT NOT NULL,             -- google | yelp | tripadvisor
  rating          INTEGER NOT NULL,          -- 1–5
  author          TEXT,
  body            TEXT,
  review_url      TEXT,
  review_date     TEXT,

  -- Response tracking
  response_drafted  TEXT,                   -- Claude's draft
  response_approved INTEGER DEFAULT 0,      -- 0=pending 1=approved
  response_posted_at TEXT,

  -- Content flywheel
  pull_quote      TEXT,                     -- Claude-extracted highlight
  social_card_url TEXT,                     -- generated graphic
  posted_to_ig    INTEGER DEFAULT 0,
  posted_to_li    INTEGER DEFAULT 0,

  created_at      TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- GUESTBOOK — permanent customer directory (Toast → Square transition)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guestbook (
  id              TEXT PRIMARY KEY,           -- normalized phone or generated key
  first_name      TEXT,
  last_name       TEXT,
  phone           TEXT,                       -- normalized +1XXXXXXXXXX
  phone_raw       TEXT,                       -- original from Toast
  email           TEXT,
  last_visit      TEXT,                       -- ISO date from Toast
  order_count     INTEGER DEFAULT 0,
  source          TEXT DEFAULT 'toast',       -- toast | square
  synced_at       TEXT DEFAULT (datetime('now')),
  matched_square_id TEXT                      -- future: link to Square customer ID
);

CREATE INDEX IF NOT EXISTS idx_guestbook_phone ON guestbook(phone);
CREATE INDEX IF NOT EXISTS idx_guestbook_name  ON guestbook(first_name, last_name);

-- ------------------------------------------------------------
-- AGENT_PROMPTS — live prompt store; optimizer rewrites these
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_prompts (
  id              TEXT PRIMARY KEY,
  agent_name      TEXT NOT NULL UNIQUE,
  -- scout | qualifier | outreach_email | outreach_followup1 | outreach_followup2
  -- review_responder | account_checkin | rep_enablement

  version         INTEGER NOT NULL DEFAULT 1,
  prompt_text     TEXT NOT NULL,
  system_context  TEXT,                     -- persona / brand voice injected

  -- Performance of this version
  uses            INTEGER DEFAULT 0,
  successes       INTEGER DEFAULT 0,        -- replied_interested, meeting_booked, closed
  success_rate    REAL DEFAULT 0.0,

  active          INTEGER DEFAULT 1,        -- 1=current version in use
  notes           TEXT,                     -- optimizer's rationale for this version

  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- PERFORMANCE_METRICS — weekly rollup the optimizer reads
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS performance_metrics (
  id              TEXT PRIMARY KEY,
  week_start      TEXT NOT NULL,            -- ISO date, Monday

  -- Outreach
  emails_sent     INTEGER DEFAULT 0,
  open_rate       REAL DEFAULT 0,
  reply_rate      REAL DEFAULT 0,
  meeting_rate    REAL DEFAULT 0,
  close_rate      REAL DEFAULT 0,

  -- By venue category (JSON)
  conversion_by_category TEXT,             -- {"brewery": 0.32, "hotel_bar": 0.18, ...}

  -- By subject line (JSON top 5)
  top_subjects    TEXT,

  -- By sequence step
  step1_rate      REAL DEFAULT 0,
  step2_rate      REAL DEFAULT 0,
  step3_rate      REAL DEFAULT 0,

  -- Accounts
  new_accounts    INTEGER DEFAULT 0,
  churned_accounts INTEGER DEFAULT 0,
  total_active    INTEGER DEFAULT 0,
  total_rev       REAL DEFAULT 0,

  -- Reviews
  reviews_received INTEGER DEFAULT 0,
  avg_rating      REAL DEFAULT 0,
  reviews_responded INTEGER DEFAULT 0,

  -- Optimizer notes
  optimizer_notes TEXT,                    -- Claude's weekly findings + what it changed

  created_at      TEXT DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- SEED: agent prompts (v1 — optimizer will rewrite over time)
-- ------------------------------------------------------------
INSERT OR IGNORE INTO agent_prompts (id, agent_name, version, prompt_text, system_context) VALUES

('ap_scout', 'scout', 1,
'Search Apollo.io for venues in Salt Lake City, Utah metro area matching these categories: breweries, taprooms, ski lodges, resort bars, event venues, theaters, performing arts centers, hotel bars, golf clubs, country clubs, stadiums, arenas, entertainment venues. For each result extract: company name, contact name, contact title (owner|GM|F&B director|purchasing), email, phone, website, address. Target contacts with titles: Owner, General Manager, Food and Beverage Director, Bar Manager, Purchasing Manager, Operations Manager. Exclude: restaurants with full kitchens as primary business, fast food, chains with centralized purchasing. Return as JSON array.',
'You are the Scout agent for Dangerous Pretzel Co, a premium SLC soft pretzel brand. Your job is to find the highest-potential wholesale accounts in the SLC metro area.'),

('ap_qualifier', 'qualifier', 1,
'Score this venue 0-100 for Dangerous Pretzel warmer program fit. 

Scoring criteria:
- Captive audience / dwell time 60+ min: +25 points
- Serves alcohol: +20 points  
- No or limited existing food program: +20 points
- High foot traffic (events, busy location): +15 points
- Premium / upscale positioning (matches $7-8 price point): +10 points
- Local/independent (faster decisions than chains): +5 points
- Outdoor or seasonal operation only: -15 points
- Already has full kitchen/restaurant: -20 points

Assign tier: 1 (score 70+), 2 (score 45-69), 3 (score below 45).
Return JSON: {score, tier, icp_fit, summary (2 sentences max)}

Venue data: {{venue_data}}',
'You are the Qualifier agent for Dangerous Pretzel Co. Our best accounts are: Delta Center (NBA arena), Powder Mountain ski resort, Alta ski resort, SLC Bees stadium, taprooms, event centers, and theaters. Score against this profile.'),

('ap_outreach_email', 'outreach_email', 1,
'Write a cold outreach email for Dangerous Pretzel Co to this venue: {{venue_name}}, {{venue_category}}, {{venue_city}}.

Research notes about this venue: {{research_notes}}

Rules:
- Subject line: specific, no generic phrases, under 8 words, ideally references their venue
- Opening line: one specific thing about THEIR venue, not about us  
- Paragraph 2: the pitch in 2-3 sentences. Lead with social proof: "We are already the pretzel at Delta Center, Powder Mountain, Alta, and the SLC Bees — " then the core offer: free loaner warmer, local/fresh, unique flavors (Spicy Bee, BBK, Saint), zero kitchen required, zero training, basically free revenue. Most accounts clear $1,000–$10,000/month in pure margin.
- Paragraph 3: one frictionless CTA. Not "schedule a call" — "want me to drop off samples this week?" or "can I bring a warmer by Thursday?"
- Sign off: from Drew, Dangerous Pretzel Co, dangerouspretzel.com
- Tone: confident, direct, a little irreverent. Sound like the brand — "RUIN DINNER" energy. Not a sales rep. Not corporate.
- Length: under 150 words total
- No bullet points. No subject headers. Plain text.

Return JSON: {subject, body}',
'You are writing outreach emails for Drew at Dangerous Pretzel Co. The brand voice is bold, local, a little punk — "Invented by monks, perfected for punks." Never generic. Never corporate. Always specific to the venue.'),

('ap_outreach_followup1', 'outreach_followup1', 1,
'Write a day-3 follow-up email for Dangerous Pretzel Co. 

Original email sent to: {{venue_name}} on {{sent_date}}. No reply received.

Rules:
- 3 sentences max
- Reference the original email without being needy
- Add one new piece of value or urgency: a specific detail about their venue, a new account we just added nearby, or a quick revenue stat
- Same irreverent tone — not "just checking in"
- CTA: one specific ask, make it easy to say yes
- No subject line change needed — reply to original thread

Return JSON: {body}',
'Dangerous Pretzel Co follow-up. Keep it short, keep it sharp. No groveling.'),

('ap_outreach_followup2', 'outreach_followup2', 1,
'Write a day-7 final follow-up email for Dangerous Pretzel Co. 

Context: {{venue_name}}, no reply to 2 previous emails.

Rules:
- This is the last one, say so briefly and without drama
- One sentence on what they are leaving on the table (be specific — "$800/month in zero-overhead revenue")
- Leave the door open, no hard feelings
- 2–3 sentences total
- Optional: offer something that makes it trivially easy to say yes (free sample drop, 5-min call, whatever fits)

Return JSON: {body}',
'Final touch. Make it memorable, not bitter. Leave them thinking about the money they said no to.');

-- Additional prompt seeds (account check-in + rep enablement)
INSERT OR IGNORE INTO agent_prompts (id, agent_name, version, prompt_text, system_context) VALUES

('ap_account_checkin', 'account_checkin', 1,
'Write a short, genuine check-in email from Drew at Dangerous Pretzel Co to {{contact_name}} at {{venue_name}}.

Context: Active wholesale account. No order in {{days_since_order}} days. Goal: stay top of mind and make reordering frictionless — not pushy.

Rules:
- 3 sentences max
- Sound like Drew, not a CRM sequence — genuine, casual, specific
- Reference something real: their venue type, upcoming season, a new flavor, a nearby event
- DO NOT mention that we noticed they have not ordered recently
- One soft CTA: "anything we can do to make restocking easier?" or "need us to swing by this week?"
- No subject line headers, no bullet points

Return JSON: {subject, body}',
'Drew at Dangerous Pretzel Co. Warm, direct, never salesy. This person is already a customer — treat them like one.'),

('ap_rep_enablement', 'rep_enablement', 1,
'Generate a distributor rep enablement brief for {{distributor_name}} account managers pitching Dangerous Pretzel Co.

Brand: Dangerous Pretzel Co — "RUIN DINNER." / "Invented by monks, perfected for punks."
Website: dangerouspretzel.com
Founder: Drew — available for joint sales calls

Current anchor accounts (lead with these):
- Delta Center (NBA Jazz arena)
- Powder Mountain Ski Resort
- Alta Ski — Goldminer''s Daughter
- SLC Bees Stadium
- The Union Event Center, Pioneer Theater
- TF Brewery, Hopkins Brewery, ROHA Brewing, HK Brewing

Product: Premium frozen soft pretzels. Flavors: Spicy Bee (chili-cheddar, hot honey, candied jalapeños), BBK (parmesan, garlic, herbs), Saint (cinnamon sugar), Salty, For The Kids, Salty Bombs.
Program: Free loaner warmer. Zero kitchen. Zero training. Near-zero waste. 1-2 week lead time SLC.
Revenue for venues: $1,000–$10,000+/month. Close rate: extremely high once venues taste the product.
Retail price: $7–8 per pretzel.

Distributor context: {{distributor_context}}
Target account types: {{target_accounts}}

Generate these sections:
1. 30-second pitch (human, not scripted — name-drops Delta Center in sentence 1)
2. Three revenue numbers that close the conversation (specific, not vague)
3. Five best account types to call first, ranked with one-line reason each
4. Four common objections with sharp responses (flip them, do not be defensive)
5. Step-by-step order placement process (dead simple)
6. Drew contact info and joint call offer

Tone: Confident, specific, has the brand edge. Not corporate food-speak.

Return JSON: {pitch_30sec, numbers, best_accounts, objections, how_to_place, contact_info}',
'You are generating a sales enablement tool for distribution reps at {{distributor_name}}. They know food service but do not know Dangerous Pretzel. Make it easy for them to sell without Drew in the room.');
