# Pretzel OS — Claude Code Handoff Brief
## Dangerous Pretzel Co · dangerouspretzel.com
### Complete context, credentials checklist, deploy instructions, and prompts

---

## 1. Who We Are

**Dangerous Pretzel Co** is a premium Salt Lake City soft pretzel brand.
- Website: dangerouspretzel.com
- Location: 352 W 600 S, Salt Lake City, UT
- Phone: (801) 916-0275
- Founder: Drew
- Email: drew@dangerouspretzel.com
- Brand voice: Bold, irreverent, local. "RUIN DINNER." / "Invented by monks, perfected for punks."
- Press: City Weekly, Salt Lake Magazine, Salt Lake Tribune, Axios

**The business model:** We wholesale premium frozen soft pretzels to venues that have no kitchen. We place a branded pretzel warmer for free — they buy pretzels from us wholesale. Zero kitchen, zero training, near-zero waste. Basically free revenue for the venue. We self-deliver in SLC metro. Now also distributing via US Foods (listing live within days) and PFG Denver (just onboarded).

**Retail price:** $7–8 per pretzel at venues
**Monthly revenue per account:** $1,000–$10,000+
**Close rate:** Extremely high once venues see/taste the product
**Lead time SLC:** 1–2 weeks

---

## 2. Flavors (for outreach copy + rep kits)

| SKU | Name | Description |
|-----|------|-------------|
| SPICY-BEE | Spicy Bee | Chili-cheddar dough, hot honey glaze, candied jalapeños |
| BBK | BBK | Brush Before Kissing — parmesan, garlic, fresh herbs |
| SAINT | Saint | Sweet cinnamon sugar, never done anything wrong |
| SALTY | Salty | Classic. Invented by monks, perfected for punks. |
| KIDS | For The Kids | Sugary glaze topped with fruity pebbles crumbs |
| BOMBS | Salty Bombs | Single-serve salty bombs |

---

## 3. Active Accounts (seed into D1 active_accounts)

These are our current active warmer placements. Seed all of them on deploy.

| Venue | Type | Notes |
|-------|------|-------|
| Delta Center | Stadium/Arena | NBA Jazz arena. Mammoth pretzel program. Our anchor account. |
| SLC Bees Stadium | Stadium | Minor league baseball |
| Powder Mountain Ski Resort | Ski Resort | High volume, seasonal |
| Alta Ski — Goldminer's Daughter | Ski Resort | Alta ski area lodge |
| The Union Event Center | Event Venue | Major SLC events venue |
| Pioneer Theater Company | Theater | Performing arts |
| TF Brewery | Brewery | Taproom account |
| Hopkins Brewery | Brewery | Taproom account |
| ROHA Brewing | Brewery | Taproom account |
| HK Brewing | Brewery | Taproom account |

**For each account set:**
- `fulfilled_by = 'self'`
- `status = 'active'`
- `health_status = 'green'`
- Match `square_location_id` from Square dashboard (see Section 6)
- Match `toast_restaurant_guid` from Toast repo (see Section 7)

---

## 4. Distribution Partners

| Partner | Status | Contact | Notes |
|---------|--------|---------|-------|
| Self-delivery | Active | Drew | SLC metro + surrounds |
| US Foods | Live within days | — | Products approved, being added now |
| PFG Denver | Just onboarded | John Ash (AM), Chad Roberts (VP Procurement), Gary Deaguero | Received onboarding info today |

---

## 5. What Pretzel OS Is

Seven Cloudflare Workers + one D1 database that run autonomously. The Outreach layer is a **true reasoning agent** — not a scheduled function. Claude drives the loop, decides which tools to call, holds venues when timing is wrong, flags high-value targets for Drew, and self-evaluates every draft before sending.

| Worker | File | Cron | What it does |
|--------|------|------|--------------|
| Scout | `scout-worker.js` | Mon 6am MT | Finds SLC venues via Apollo.io |
| Qualifier | `qualifier-worker.js` | Mon 7am MT | Claude scores venues, assigns tier 1/2/3 |
| **Outreach Agent** | `outreach-agent.js` | Tue+Thu 8am MT | **True agentic loop** — researches, deliberates, drafts, self-evaluates, sends or holds |
| Account | `account-worker.js` | Mon 9am MT + webhooks | Square/Toast order ingestion, review SMS, Drew digest |
| Optimizer | `optimizer-worker.js` | Sun 11pm MT | Reads performance data, rewrites underperforming prompts |
| Pilot Tracker | `pilot-tracker-worker.js` | Fri 8am MT | Twisted Sugar 5-store pilot tracking |
| Rep Enablement | `rep-enablement-worker.js` | HTTP only | Generates US Foods + PFG one-pagers on demand |

### How the Outreach Agent works (important — read this)

Unlike the other workers which are single Claude API calls, the Outreach Agent runs a **tool-use loop**:

1. Claude receives a venue and decides which tools to call
2. Tools execute (web fetch, Instagram check, D1 history, etc.)
3. Results feed back to Claude
4. Claude decides next tool or final action
5. Loop repeats until Claude sends, holds, flags, or gives up
6. Full reasoning chain logged to D1 + KV

**Tools available to the agent:**
- `fetch_venue_website` — reads their website for vibe, events, food situation
- `check_recent_google_reviews` — sentiment, complaints about food, recent events
- `check_instagram` — posts, seasonal closure signals, brand awareness
- `check_contact_history` — prior contacts, holds, notes in D1
- `hold_venue` — puts venue on hold (14/30/60/90 days) with reason
- `flag_for_drew` — routes high-value or nuanced venues to Drew directly
- `draft_and_evaluate_email` — writes draft, self-scores 1-10, rewrites if below 7
- `send_or_park_email` — sends or parks for approval depending on gate status

**TAM protection settings (critical for SLC):**
- `MAX_SENDS_PER_RUN = 3` — never more than 3 per run
- `WARMUP_WEEKS = 3` — first 3 weeks Tier 2 only, Tier 1 protected
- `APPROVAL_GATE_COUNT = 20` — first 20 emails park for Drew review
- `DRAFT_QUALITY_MIN = 7` — emails scoring below 7/10 get rewritten

**New endpoints for Drew:**
```
GET  /outreach/pending          → list emails parked for approval
POST /outreach/approve          → {log_id} → approve and send
POST /outreach/reject           → {log_id, note} → reject with note
POST /outreach/preview          → {venue_id} → dry run agent, no send
```

---

## 6. Tech Stack (Already Live)

- **Cloudflare Workers:** Deployed ✓
- **Cloudflare D1:** Created ✓
- **Custom domain:** dangerouspretzel.com on Cloudflare ✓
- **Toast POS:** Data pulled via URL hack (see repo — Section 7)
- **Square:** Switching to Square from Toast soon
- **Swell CX / Swell Reviews:** SMS + review platform
- **n8n + Make:** Connected via MCP (available but not needed for Pretzel OS)
- **Apollo.io:** Lead prospecting API

---

## 7. Credentials Checklist

Work through this list before deploying. Set each as a Wrangler secret.

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APOLLO_API_KEY
wrangler secret put GMAIL_CLIENT_ID
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put GMAIL_REFRESH_TOKEN
wrangler secret put SWELLCX_API_KEY
wrangler secret put SQUARE_WEBHOOK_SECRET
wrangler secret put SQUARE_ACCESS_TOKEN
wrangler secret put TOAST_WEBHOOK_SECRET
```

### Where to find each:

**ANTHROPIC_API_KEY**
→ console.anthropic.com → API Keys

**APOLLO_API_KEY**
→ Apollo.io dashboard → Settings → API Keys → Create new key

**GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN**
→ Requires Google Cloud OAuth flow. Steps:
1. console.cloud.google.com → New project → Enable Gmail API
2. Credentials → Create OAuth 2.0 Client ID (Desktop app type)
3. Download credentials JSON
4. Run OAuth flow to get refresh token for drew@dangerouspretzel.com
5. Claude Code can walk through this entire flow

**SWELLCX_API_KEY**
→ Swell CX dashboard → Settings → API → Create key

**SQUARE_ACCESS_TOKEN + SQUARE_WEBHOOK_SECRET**
→ developer.squareup.com → Applications → Select app → Credentials
→ Webhooks → Create endpoint at `https://api.dangerouspretzel.com/account/square-webhook`

**TOAST_WEBHOOK_SECRET**
→ See Toast repo (Section 8) — may not apply if using URL hack only

**GOOGLE_PLACE_ID** (goes in `[vars]`, not a secret)
→ developers.google.com/maps/documentation/places/web-service/place-id
→ Search: "Dangerous Pretzel Co Salt Lake City"
→ Copy the Place ID (starts with ChIJ...)
→ Update `wrangler.toml` GOOGLE_PLACE_ID value

---

## 8. Toast Repo Instructions

The existing Toast integration uses a URL hack (not the official Toast API).

**Tell Claude Code:**
> "Read the Toast repo at [INSERT REPO LINK]. Understand the URL hack structure and the response format it returns. Then update the `handleToastWebhook` and `processToastOrder` functions in `account-worker.js` to correctly map the actual Toast response fields to our D1 orders schema. Pay attention to: order ID field name, restaurant/location identifier, check totals, and customer phone number location in the response."

**Key fields to map into D1 `orders` table:**
- `orders.id` ← Toast order GUID
- `orders.gross_revenue` ← check total (watch for cents vs dollars)
- `orders.customer_phone` ← customer phone if available
- `active_accounts.toast_restaurant_guid` ← restaurant identifier for matching

---

## 9. Wrangler.toml Updates Needed

Open `wrangler.toml` and replace these placeholders before deploying:

```toml
database_id = "REPLACE_WITH_YOUR_D1_ID"
# Run: wrangler d1 list → copy the id for your existing D1 database

id = "REPLACE_WITH_YOUR_KV_ID"  
# Run: wrangler kv:namespace list → copy or create pretzel-kv

GOOGLE_PLACE_ID = "REPLACE_WITH_YOUR_PLACE_ID"
# From Google Places API (see Section 7)
```

**Check for existing Workers conflicts:**
```bash
wrangler deployments list
```
Make sure no existing Worker is bound to `api.dangerouspretzel.com/*` before deploying.

---

## 10. D1 Schema Notes

The schema creates these tables:
- `venues` — every prospect + active account
- `outreach_logs` — every email sent, opened, replied
- `active_accounts` — every live warmer placement with health tracking
- `orders` — transaction-level data from Toast + Square
- `reviews` — inbound reviews from Google/Yelp/TripAdvisor
- `agent_prompts` — live prompt store (optimizer rewrites these)
- `performance_metrics` — weekly rollup for optimizer

**The schema also seeds `agent_prompts`** with v1 prompts for all agents. These are production-ready but will improve automatically via the Optimizer each Sunday night.

---

## 11. Active Account Seeding SQL

After schema migration, run this to seed existing accounts. Claude Code should fill in actual IDs after checking Square/Toast:

```sql
-- Run after schema.sql migration
-- Update square_location_id and toast_restaurant_guid from actual accounts

INSERT INTO venues (id, name, category, status, city, state, activated_at, created_at, updated_at)
VALUES 
  ('v_delta_center',    'Delta Center',                'stadium',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_slc_bees',        'SLC Bees Stadium',            'stadium',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_powder_mtn',      'Powder Mountain Ski Resort',  'ski_resort',   'active', 'Eden',           'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_alta_gmd',        'Alta Ski - Goldminers Daughter', 'ski_resort','active', 'Alta',           'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_union_event',     'The Union Event Center',      'event_venue',  'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_pioneer_theater', 'Pioneer Theater Company',     'theater',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_tf_brewery',      'TF Brewery',                  'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_hopkins',         'Hopkins Brewery',             'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_roha',            'ROHA Brewing',                'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now')),
  ('v_hk_brewing',      'HK Brewing',                  'brewery',      'active', 'Salt Lake City', 'UT', datetime('now'), datetime('now'), datetime('now'));

INSERT INTO active_accounts (id, venue_id, fulfilled_by, health_status, churn_risk, created_at, updated_at)
VALUES
  ('aa_delta_center',    'v_delta_center',    'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_slc_bees',        'v_slc_bees',        'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_powder_mtn',      'v_powder_mtn',      'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_alta_gmd',        'v_alta_gmd',        'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_union_event',     'v_union_event',     'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_pioneer_theater', 'v_pioneer_theater', 'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_tf_brewery',      'v_tf_brewery',      'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_hopkins',         'v_hopkins',         'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_roha',            'v_roha',            'self', 'green', 0, datetime('now'), datetime('now')),
  ('aa_hk_brewing',      'v_hk_brewing',      'self', 'green', 0, datetime('now'), datetime('now'));
```

Then update `square_location_id` and `toast_restaurant_guid` for each account:
```sql
UPDATE active_accounts SET square_location_id = 'ACTUAL_SQUARE_ID' WHERE id = 'aa_delta_center';
-- repeat for each account
```

---

## 12. Twisted Sugar Pilot Setup

The 5-store pilot starts next month. Before it launches:

1. Get the Square Location ID for each Twisted Sugar store
2. Update `TWISTED_SUGAR_STORES` array in `pilot-tracker-worker.js` with real IDs
3. Update `PILOT_START` date in `getPilotWeek()` function to the actual launch date
4. Confirm wholesale price per case and units per case — update `gross_revenue` default calculation in `recordManualOrder()`

**Pilot dashboard endpoint** (once deployed):
```
GET https://api.dangerouspretzel.com/pilot/dashboard
GET https://api.dangerouspretzel.com/pilot/stores
GET https://api.dangerouspretzel.com/pilot/weekly-summary
GET https://api.dangerouspretzel.com/pilot/success-brief  ← generates expansion deck when ready
```

---

## 13. Rep Enablement Kit Endpoints

Once deployed, these URLs generate live rep one-pagers:

```
# US Foods rep kit (HTML — printable)
https://api.dangerouspretzel.com/rep-kit/html?distributor=us_foods

# PFG Denver rep kit (HTML — printable)  
https://api.dangerouspretzel.com/rep-kit/html?distributor=pfg_denver

# JSON output (for programmatic use)
https://api.dangerouspretzel.com/rep-kit?distributor=us_foods
https://api.dangerouspretzel.com/rep-kit?distributor=pfg_denver
```

Send the HTML URL to John Ash at PFG Denver. It generates fresh on every request — always current.

---

## 14. System Health Endpoints

After deployment, verify with:

```bash
# Health check
curl https://api.dangerouspretzel.com/health

# Live pipeline stats
curl https://api.dangerouspretzel.com/stats

# Account health
curl https://api.dangerouspretzel.com/account/health

# Scout + qualifier
curl https://api.dangerouspretzel.com/scout/run
curl https://api.dangerouspretzel.com/qualifier/run

# ── OUTREACH AGENT — test sequence ────────────────────────────

# 1. Dry run on a specific venue — full reasoning, no email sent
curl -X POST https://api.dangerouspretzel.com/outreach/preview \
  -H "Content-Type: application/json" \
  -d '{"venue_id": "VENUE_ID_FROM_D1"}'

# 2. View emails parked for Drew's approval
curl https://api.dangerouspretzel.com/outreach/pending

# 3. Approve a parked email
curl -X POST https://api.dangerouspretzel.com/outreach/approve \
  -H "Content-Type: application/json" \
  -d '{"log_id": "LOG_ID_FROM_PENDING"}'

# 4. Reject a parked email
curl -X POST https://api.dangerouspretzel.com/outreach/reject \
  -H "Content-Type: application/json" \
  -d '{"log_id": "LOG_ID", "note": "Too generic"}'

# 5. Live agent run (sends 3 max, parks for approval during gate)
curl https://api.dangerouspretzel.com/outreach/run

# ── Everything else ────────────────────────────────────────────
curl https://api.dangerouspretzel.com/account/digest
curl https://api.dangerouspretzel.com/optimizer/history
curl "https://api.dangerouspretzel.com/rep-kit/html?distributor=pfg_denver"
curl "https://api.dangerouspretzel.com/rep-kit/html?distributor=us_foods"
```

### Recommended first-run sequence:
1. `/scout/run` → venues in D1
2. `/qualifier/run` → tiers assigned
3. `/outreach/preview` on 3-4 venues → read agent reasoning + email quality
4. If good: `/outreach/run` → first emails park for Drew approval
5. `/outreach/pending` → review drafts
6. Approve 2-3 → verify in Gmail sent folder
7. After 20 approvals the gate opens — agent sends autonomously

---

## 15. Full Deploy Sequence (Step by Step)

Run these commands in order. Do not skip steps.

```bash
# 1. Install Wrangler if needed
npm install -g wrangler

# 2. Login to Cloudflare
wrangler login

# 3. Check existing D1 databases
wrangler d1 list
# → Copy the ID of your existing D1 database (or create new: wrangler d1 create pretzel-os)

# 4. Check existing KV namespaces
wrangler kv:namespace list
# → Copy the ID or create: wrangler kv:namespace create pretzel-kv

# 5. Update wrangler.toml with real IDs
# Edit: database_id, kv id, GOOGLE_PLACE_ID

# 6. Run schema migration
wrangler d1 execute pretzel-os --file=schema.sql
# → Should see: "Executed X queries"

# 7. Seed active accounts
wrangler d1 execute pretzel-os --file=seed-accounts.sql
# → (Claude Code generates this file from Section 11 above)

# 8. Set all secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APOLLO_API_KEY
wrangler secret put GMAIL_CLIENT_ID
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put GMAIL_REFRESH_TOKEN
wrangler secret put SWELLCX_API_KEY
wrangler secret put SQUARE_WEBHOOK_SECRET
wrangler secret put SQUARE_ACCESS_TOKEN
wrangler secret put TOAST_WEBHOOK_SECRET

# 9. Deploy
wrangler deploy

# 10. Verify
curl https://api.dangerouspretzel.com/health
curl https://api.dangerouspretzel.com/stats
```

---

## 16. The Master Prompt for Claude Code

Copy and paste this entire block to kick off the session:

---

> I'm handing you a complete Cloudflare Workers project called **Pretzel OS** for **Dangerous Pretzel Co** (dangerouspretzel.com). This is an autonomous AI growth machine built on Cloudflare Workers + D1. Here's what I need you to do, in order:
>
> **Step 1 — Environment setup**
> I already have Cloudflare Workers deployed at dangerouspretzel.com with a D1 database and KV namespace. Find the existing D1 database ID and KV namespace ID from my Cloudflare account. Update `wrangler.toml` with the real IDs. Check for any existing Worker routes at `api.dangerouspretzel.com` that would conflict.
>
> **Step 2 — Gmail OAuth**
> Set up Gmail OAuth for drew@dangerouspretzel.com so the outreach worker can send emails programmatically. Walk me through Google Cloud Console: create a project, enable Gmail API, create OAuth 2.0 credentials (Desktop app type), and run the OAuth flow to get a refresh token. Store client ID, client secret, and refresh token as Wrangler secrets.
>
> **Step 3 — Toast integration**
> Read my Toast repo at [INSERT REPO LINK]. Understand the URL hack structure and actual response format. Update `handleToastWebhook` and `processToastOrder` in `account-worker.js` to correctly map real Toast fields to our D1 schema. Map: order ID, restaurant identifier (for account matching), check totals (confirm cents vs dollars), and customer phone number.
>
> **Step 4 — Google Place ID**
> Find the Google Place ID for "Dangerous Pretzel Co, 352 W 600 S, Salt Lake City, UT". Update `GOOGLE_PLACE_ID` in `wrangler.toml`.
>
> **Step 5 — Schema migration**
> Run `wrangler d1 execute pretzel-os --file=schema.sql`. Confirm it executes cleanly.
>
> **Step 6 — Seed active accounts**
> Using the account list from the handoff doc, generate and run a seed SQL file that inserts all 10 active accounts into `venues` and `active_accounts`. Then find the Square Location IDs for each account from my Square dashboard and update `square_location_id` on each row.
>
> **Step 7 — Set all secrets**
> Walk me through getting each API key (Apollo.io, Swell CX, Square) and set them all via `wrangler secret put`. I'll provide values as we go.
>
> **Step 8 — Deploy and verify**
> Run `wrangler deploy`. Then hit `/health` and `/stats` and confirm both return valid responses. Run `/scout/run` manually and confirm it writes at least one venue to D1. Run `/qualifier/run` and confirm it scores it. Then run `/outreach/preview` with one of the new venue IDs — this does a full agent dry run: shows which tools Claude called, any hold signals found, the draft email with self-score, and the final decision. Show me this output before we enable live sending. The quality of the preview email and the agent's reasoning chain tells us whether the system is ready.
>
> **Step 9 — Square webhook**
> Set up the Square webhook endpoint in the Square Developer dashboard pointing to `https://api.dangerouspretzel.com/account/square-webhook`. Subscribe to `payment.completed` events.
>
> **Step 10 — Rep kit test**
> Hit `https://api.dangerouspretzel.com/rep-kit/html?distributor=pfg_denver` and show me the output. This should be a formatted HTML one-pager ready to send to John Ash at PFG Denver.
>
> Everything you need is in the PRETZEL_OS_HANDOFF.md file. Don't skip steps or ask unnecessary questions — work through it sequentially and flag only when you genuinely need input from me.

---

## 17. Phase 2 (Build After Phase 1 Is Live)

Don't build these yet — get Phase 1 deployed and running for 2 weeks first. Then come back.

| Worker | What it does |
|--------|-------------|
| `review-responder-worker.js` | Monitors Google/Yelp daily, Claude drafts responses, one-tap approval for Drew |
| `content-worker.js` | 5-star reviews → pull quote → social card → Webflow publish → Instagram schedule |
| `warmer-qr-worker.js` | QR landing page on each warmer, sentiment gate (good → Google, bad → private form) |
| `influencer-worker.js` | Scrapes SLC TikTok/Instagram food creators, matches to your venue accounts, DM generation |
| `seo-worker.js` | 2x/week Claude-written blog posts auto-published to Webflow, targeting "no kitchen food program" keywords |
| `venue-calculator-worker.js` | Public-facing "Is your venue leaving money on the table?" tool on dangerouspretzel.com |

---

## 18. Key Business Context for Agent Prompts

This context lives in `agent_prompts.system_context` and is injected into every Claude call. If you ever need to update the brand brief, update it in D1 — not in code.

**Core pitch:** "We are already the pretzel at Delta Center, Powder Mountain, Alta, and the SLC Bees. Free loaner warmer, local/fresh, unique flavors, zero kitchen required, zero training, near-zero waste. Most accounts clear $1,000–$10,000/month in pure margin."

**Brand voice:** Bold, local, a little punk. "RUIN DINNER." Direct and specific. Never corporate. Never generic. Always references real venue names and real numbers.

**ICP (Ideal Customer Profile):** Captive audience venues — people stuck somewhere for 60+ minutes who want food and a drink. Alcohol helps. No kitchen required. Best categories: breweries/taprooms, ski lodges/resorts, event venues, theaters/performing arts, hotel bars, golf clubs, stadiums/arenas.

**Social proof hierarchy:** Always lead with Delta Center (NBA arena), then Powder Mountain or Alta (ski resorts), then SLC Bees (stadium). These three close conversations that would otherwise take 3 follow-ups.

**The close:** "Free warmer, one to two week turnaround, and most venues make back their first order cost in the first weekend."

---

*Generated by Claude for Dangerous Pretzel Co · Last updated: March 2026*
*All code files in the same directory as this document.*
