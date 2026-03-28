# Pretzel OS — Dangerous Pretzel Co
## Cloudflare-native AI growth machine

---

## What this is
Three Cloudflare Workers + one D1 database that run autonomously to find, 
qualify, and contact every viable venue in SLC for the warmer program.
No n8n. No Airtable. Zero monthly SaaS fees beyond Claude + Apollo API calls.

---

## Files
```
schema.sql                  → D1 database schema + seed data (run once)
wrangler.toml               → Deployment config (edit your IDs first)
workers/
  router.js                 → Single entry point, routes all cron + HTTP
  scout-worker.js           → Finds SLC venues via Apollo.io
  qualifier-worker.js       → Scores venues via Claude, assigns tier 1/2/3
  outreach-worker.js        → Writes + sends personalized emails via Gmail
```

---

## Deploy in 6 steps

### 1. Prerequisites
- Wrangler CLI installed: `npm install -g wrangler`
- Logged in: `wrangler login`
- Cloudflare account with Workers + D1 access

### 2. Create D1 database
```bash
wrangler d1 create pretzel-os
# Copy the database_id it returns
```

### 3. Create KV namespace
```bash
wrangler kv:namespace create pretzel-kv
# Copy the id it returns
```

### 4. Update wrangler.toml
Replace these placeholders:
- `REPLACE_WITH_YOUR_D1_ID` → your D1 database_id
- `REPLACE_WITH_YOUR_KV_ID` → your KV namespace id  
- `REPLACE_WITH_YOUR_PLACE_ID` → your Google Business Place ID
  (Find it at: https://developers.google.com/maps/documentation/places/web-service/place-id)

### 5. Set secrets (never committed to git)
```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APOLLO_API_KEY
wrangler secret put GMAIL_CLIENT_ID
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put GMAIL_REFRESH_TOKEN
wrangler secret put SWELLCX_API_KEY
wrangler secret put TOAST_WEBHOOK_SECRET
```

### 6. Run schema migration + deploy
```bash
wrangler d1 execute pretzel-os --file=schema.sql
wrangler deploy
```

---

## Gmail OAuth setup
You need a refresh token for Drew's Gmail. Quickest path:
1. Go to https://console.cloud.google.com
2. Create a project → Enable Gmail API
3. Create OAuth credentials (Desktop app type)
4. Run the OAuth flow once to get a refresh token
5. Store as GMAIL_REFRESH_TOKEN secret above

OR: pass this to Claude Code — it can walk through the full OAuth flow.

---

## Manual trigger (test without waiting for cron)
```bash
# Trigger scout
curl https://api.dangerouspretzel.com/scout/run

# Trigger qualifier  
curl https://api.dangerouspretzel.com/qualifier/run

# Trigger outreach (preview mode — no emails sent)
curl -X POST https://api.dangerouspretzel.com/outreach/preview \
  -H "Content-Type: application/json" \
  -d '{"venue_id": "your-venue-id"}'

# Check stats
curl https://api.dangerouspretzel.com/stats
```

---

## Cron schedule (all times MT)
| Worker     | Schedule         | What it does                              |
|------------|------------------|-------------------------------------------|
| Scout      | Monday 6am       | Finds new SLC venues via Apollo.io        |
| Qualifier  | Monday 7am       | Scores new venues, assigns tier 1/2/3     |
| Outreach   | Tue + Thu 8am    | Sends personalized emails (15/day max)    |

---

## What to hand to Claude Code
Claude Code needs access to:
1. This repo
2. Your Cloudflare account (wrangler login)
3. The Apollo.io API key (from your Apollo dashboard)
4. Drew's Gmail OAuth credentials

Tell Claude Code:
"I have a Cloudflare Workers project at [path]. The D1 ID and KV ID 
are in wrangler.toml as placeholders. Please find the real IDs from 
my Cloudflare account and update them, then run the schema migration 
and deploy."

---

## Extending the system
Next workers to add (all read from same D1):
- `account-worker.js`    — monitors reorder gaps via Square webhooks
- `optimizer-worker.js`  — weekly prompt rewriting based on performance
- `review-worker.js`     — Toast/Square → Swell review request pipeline
- `content-worker.js`    — 5-star reviews → social cards → Webflow publish
