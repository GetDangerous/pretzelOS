/**
 * Dangerous Pretzel Co — Account Worker
 * Cloudflare Worker (cron: Monday 9am MT + webhook endpoint)
 *
 * 1. Receives Square webhooks on order completion → writes to D1
 * 2. Cron: calculates reorder health for every active account
 * 3. Flags churn risks + drafts check-in emails for Drew to approve
 * 4. Generates Drew's Monday morning digest
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY      — Claude API key
 *   SQUARE_WEBHOOK_SECRET  — Square webhook signature key
 *   SQUARE_ACCESS_TOKEN    — Square API token
 *   SWELLCX_API_KEY        — Swell Reviews API key
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL
 *   DREW_EMAIL             — drew@dangerouspretzel.com (digest recipient)
 *   TOAST_COOKIE           — Toast admin session cookie (refresh when expired)
 *   DB                     — D1 binding
 *   KV                     — KV binding (token cache)
 *   GOOGLE_PLACE_ID
 */

import { loadBrain } from './brain-loader.js';
import { getCanonicalCashOnHand, getCanonicalRunway, getCanonicalWeeklyRevenue } from './finance-shared.js';
import { callAI } from './ai-budget.js';
// Brain loaded by other agents that import from this worker

const REORDER_WINDOW_DAYS = 21;     // Flag if no order in 21 days
const CHURN_RISK_DAYS = 35;         // Red alert if no order in 35 days
const REVIEW_COOLDOWN_DAYS = 30;    // One SMS per customer per 30 days
const REVIEW_DELAY_MINUTES = 20;    // Send review request 20min after order

// Toast admin reporting — direct session cookie auth (no external worker dependency)
const TOAST_RESTAURANT_GUID = '6ddb1ae7-a325-4f9d-87d4-445951a97e37';
const TOAST_REPORT_BASE = 'https://www.toasttab.com/restaurants/admin/reports';

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+1' + digits.slice(1);
  if (digits.length === 10) return '+1' + digits;
  return null;
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 10 * * *') {
      // Daily 4am MT — Toast POS data sync (orders + customer names)
      return syncToastData(env, 1);
    } else if (event.cron === '0 20 * * *') {
      // Daily 2pm MT — Send review request SMS to yesterday's customers
      // First re-enrich any new orders with guestbook data, then send reviews
      return enrichAndSendReviews(env);
    } else {
      // Monday 9am MT — Account health + Drew digest
      return runAccountHealth(env);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Square webhook receiver
    if (path === '/account/square-webhook' && request.method === 'POST') {
      return handleSquareWebhook(request, env, ctx);
    }

    // Toast webhook receiver (URL hack → structured)
    if (path === '/account/toast-webhook' && request.method === 'POST') {
      return handleToastWebhook(request, env, ctx);
    }

    // Toast daily sync — pulls from toast-report worker and ingests
    if (path === '/account/toast-sync') {
      const days = parseInt(url.searchParams.get('days') || '1');
      ctx.waitUntil(syncToastData(env, days));
      return new Response(JSON.stringify({ status: 'syncing', days }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Toast TSV upload — accepts the TSV format from Toast data exports
    if (path === '/account/toast-upload' && request.method === 'POST') {
      return handleToastTSVUpload(request, env);
    }

    // Toast CheckDetails CSV upload — has customer name/phone/email
    if (path === '/account/toast-checks' && request.method === 'POST') {
      return handleToastCheckDetails(request, env);
    }

    // Toast OrderDetails CSV upload — has real revenue totals
    if (path === '/account/toast-orders' && request.method === 'POST') {
      return handleToastOrderDetails(request, env);
    }

    // Toast Guestbook CSV upload — enriches orders with phone/email from guest data
    if (path === '/account/toast-guestbook' && request.method === 'POST') {
      return handleGuestbookUpload(request, env);
    }

    // System notifications (cookie expired, sync failures, etc.)
    if (path === '/account/notifications') {
      return getNotifications(env);
    }

    // Inbound lead capture from pretzel-program.html website form
    if (path === '/account/lead-capture' && request.method === 'POST') {
      return handleLeadCapture(request, env);
    }

    // Check-in draft for yellow-health accounts (dashboard modal)
    if (path === '/account/checkin-draft') {
      const accountId = new URL(request.url).searchParams.get('account_id');
      if (!accountId) return new Response(JSON.stringify({ error: 'account_id required' }), { status: 400 });
      // Check KV for a pre-drafted check-in, or generate a default
      const draft = await env.KV.get(`checkin_draft:${accountId}`);
      if (draft) return new Response(draft, { headers: { 'Content-Type': 'application/json' } });
      // Generate a default draft from account data
      const acct = await env.DB.prepare(`
        SELECT v.name, v.category, aa.last_order_date, aa.health_status,
               julianday('now') - julianday(aa.last_order_date) as days_since
        FROM active_accounts aa JOIN venues v ON v.id = aa.venue_id
        WHERE aa.id = ?
      `).bind(accountId).first();
      if (!acct) return new Response(JSON.stringify({ error: 'Account not found' }), { status: 404 });
      const defaultDraft = {
        to: '',
        subject: `Checking in from Dangerous Pretzel Co`,
        body: `Hey!\n\nJust wanted to check in — it's been about ${Math.round(acct.days_since || 0)} days since your last order. Everything going well with the warmer?\n\nIf you need a restock or want to try any new flavors, just let me know. Happy to swing by this week.\n\nCheers,\nDrew`,
        account_id: accountId,
        venue_name: acct.name,
        days_since: Math.round(acct.days_since || 0),
      };
      return new Response(JSON.stringify(defaultDraft), { headers: { 'Content-Type': 'application/json' } });
    }

    // Approve and send check-in email
    if (path === '/account/approve-checkin' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.to || !body.subject || !body.body) {
          return new Response(JSON.stringify({ error: 'to, subject, and body required' }), { status: 400 });
        }
        await sendGmail(env, { to: body.to, subject: body.subject, body: body.body });
        // Log the check-in
        if (body.account_id) {
          await env.DB.prepare(`
            UPDATE active_accounts SET health_status = 'green', consecutive_missed = 0 WHERE id = ?
          `).bind(body.account_id).run();
        }
        return new Response(JSON.stringify({ sent: true }), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // Cookie refresh page — visual step-by-step guide
    if (path === '/account/update-cookie' && request.method === 'GET') {
      return new Response(`<!DOCTYPE html>
<html><head><title>Pretzel OS - Refresh Toast Cookie</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0d0d0d; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
  .card { background: #1a1a1a; border-radius: 16px; padding: 40px; max-width: 560px; width: 100%; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  h1 span { color: #f5c842; }
  .sub { color: #888; margin-bottom: 28px; font-size: 14px; }
  .step { display: flex; gap: 12px; margin-bottom: 20px; align-items: flex-start; }
  .num { background: #f5c842; color: #000; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex-shrink: 0; margin-top: 2px; }
  .step-text { font-size: 15px; line-height: 1.5; }
  .step-text a { color: #f5c842; }
  .step-text .detail { color: #888; font-size: 13px; margin-top: 4px; }
  .mock { background: #111; border-radius: 8px; padding: 12px; margin: 8px 0; font-family: monospace; font-size: 12px; color: #aaa; border: 1px solid #333; line-height: 1.6; }
  .mock .hl { color: #f5c842; }
  textarea { width: 100%; height: 80px; background: #111; border: 1px solid #333; border-radius: 8px; color: #e0e0e0; padding: 12px; font-family: monospace; font-size: 12px; resize: vertical; margin: 20px 0 16px; }
  textarea:focus { outline: none; border-color: #f5c842; }
  button { width: 100%; padding: 14px; background: #f5c842; color: #000; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
  button:hover { background: #e0b635; }
  button:disabled { background: #555; color: #999; cursor: not-allowed; }
  .result { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
  .result.ok { background: #1a3a1a; color: #4ade80; display: block; }
  .result.err { background: #3a1a1a; color: #f87171; display: block; }
</style></head>
<body>
<div class="card">
  <h1><span>Pretzel OS</span> Cookie Refresh</h1>
  <p class="sub">30 seconds, Chrome desktop only.</p>

  <div class="step">
    <div class="num">1</div>
    <div class="step-text">
      Open <a href="https://www.toasttab.com/restaurants/admin/home" target="_blank">Toast admin</a> and make sure you're logged in
    </div>
  </div>

  <div class="step">
    <div class="num">2</div>
    <div class="step-text">
      Right-click anywhere, click <b>Inspect</b>
      <div class="detail">A panel opens at the bottom or side</div>
    </div>
  </div>

  <div class="step">
    <div class="num">3</div>
    <div class="step-text">
      Click the <b>Network</b> tab, then reload the page (<b>Cmd+R</b>)
      <div class="detail">Requests will start appearing in the list</div>
    </div>
  </div>

  <div class="step">
    <div class="num">4</div>
    <div class="step-text">
      Click the <b>first request</b> in the list, scroll down to <b>Request Headers</b>, find <b>Cookie</b>, right-click the value and <b>Copy value</b>
      <div class="mock">
        Request Headers<br>
        accept: text/html...<br>
        <span class="hl">cookie: _dd_s=...; userToken=...; _ga=...</span><br>
        <span style="color:#666">^ right-click this value, Copy value</span>
      </div>
    </div>
  </div>

  <div class="step">
    <div class="num">5</div>
    <div class="step-text">Paste below and hit <b>Save</b></div>
  </div>

  <textarea id="cookie" placeholder="Paste the Cookie value here..."></textarea>
  <button id="btn" onclick="saveCookie()">Save Cookie</button>
  <div id="result" class="result"></div>
</div>
<script>
async function saveCookie() {
  const btn = document.getElementById('btn');
  const result = document.getElementById('result');
  const cookie = document.getElementById('cookie').value.trim();
  if (!cookie || cookie.length < 50) { result.className = 'result err'; result.textContent = 'Too short - make sure you right-clicked the Cookie value and chose Copy value.'; return; }
  btn.disabled = true; btn.textContent = 'Validating with Toast...';
  try {
    const res = await fetch('/account/update-cookie', { method: 'POST', body: cookie });
    const data = await res.json();
    if (res.ok) { result.className = 'result ok'; result.textContent = 'Cookie saved! Daily syncs will resume automatically.'; }
    else { result.className = 'result err'; result.textContent = data.error || 'Validation failed. Make sure you copied the full Cookie value from Request Headers.'; }
  } catch (e) { result.className = 'result err'; result.textContent = 'Network error: ' + e.message; }
  btn.disabled = false; btn.textContent = 'Save Cookie';
}
</script>
</body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    // Update Toast cookie via POST (no wrangler needed)
    if (path === '/account/update-cookie' && request.method === 'POST') {
      const body = await request.text();
      const newCookie = body.trim();
      if (!newCookie || newCookie.length < 100) {
        return new Response(JSON.stringify({ error: 'Cookie too short — paste the full cookie string' }), { status: 400 });
      }
      // Test the cookie first
      const testDate = toToastDateFormat(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`);
      const testUrl = `${TOAST_REPORT_BASE}/menu/toplevelitemselections?sEcho=1&iColumns=31&iDisplayStart=0&iDisplayLength=1&reportDateRange=custom&reportDateStart=${testDate}&reportDateEnd=${testDate}&reportTimeRange=-2&numberOfRestaurants=1`;
      const testResp = await fetch(testUrl, { headers: { cookie: newCookie }, redirect: 'manual' });
      if (testResp.status !== 202) {
        return new Response(JSON.stringify({ error: 'Cookie test failed — Toast returned ' + testResp.status }), { status: 400 });
      }
      // Cookie works — can't update wrangler secrets at runtime, but store in KV as fallback
      await env.KV.put('toast_cookie_override', newCookie, { expirationTtl: 604800 }); // 7 days
      // Clear the notification
      await env.KV.delete('notification:cookie_expired');
      return new Response(JSON.stringify({ status: 'ok', message: 'Cookie validated and stored. Will be used for syncs until it expires or wrangler secret is updated.' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // DB migration — run once to create guestbook table
    if (path === '/account/migrate') {
      const results = [];
      const migrations = [
        `CREATE TABLE IF NOT EXISTS guestbook (
          id TEXT PRIMARY KEY,
          first_name TEXT,
          last_name TEXT,
          phone TEXT,
          phone_raw TEXT,
          email TEXT,
          last_visit TEXT,
          order_count INTEGER DEFAULT 0,
          total_spend REAL DEFAULT 0,
          source TEXT DEFAULT 'toast',
          synced_at TEXT DEFAULT (datetime('now')),
          matched_square_id TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_guestbook_phone ON guestbook(phone)`,
        `CREATE INDEX IF NOT EXISTS idx_guestbook_name ON guestbook(first_name, last_name)`,
        `ALTER TABLE guestbook ADD COLUMN total_spend REAL DEFAULT 0`,
        `CREATE TABLE IF NOT EXISTS voice_corrections (
          id TEXT PRIMARY KEY,
          log_id TEXT,
          venue_id TEXT,
          original_subject TEXT,
          edited_subject TEXT,
          original_body TEXT,
          edited_body TEXT,
          optimizer_consumed_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_voice_corrections_unconsumed ON voice_corrections(optimizer_consumed_at) WHERE optimizer_consumed_at IS NULL`,
        // Sprint 3-4: A/B subject variant tracking
        `ALTER TABLE outreach_logs ADD COLUMN subject_variant TEXT`,
        // Sprint 4: Auto-send reply scheduling
        `ALTER TABLE inbound_replies ADD COLUMN auto_send_at TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_replies_auto_send ON inbound_replies(status, auto_send_at) WHERE status = 'auto_send_scheduled'`,
        // Sprint 3: Signal Scanner — timing hooks for outreach
        `CREATE TABLE IF NOT EXISTS timing_signals (
          id TEXT PRIMARY KEY,
          venue_id TEXT NOT NULL,
          signal_type TEXT NOT NULL,
          signal_score INTEGER DEFAULT 0,
          signal_summary TEXT,
          source TEXT,
          raw_data TEXT,
          consumed_at TEXT,
          expires_at TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
        `CREATE INDEX IF NOT EXISTS idx_signals_venue ON timing_signals(venue_id)`,
        `CREATE INDEX IF NOT EXISTS idx_signals_unconsumed ON timing_signals(consumed_at) WHERE consumed_at IS NULL`,
        // Multi-channel outreach: SMS + Instagram DM
        `ALTER TABLE venues ADD COLUMN contact_phone_verified INTEGER DEFAULT 0`,
        `ALTER TABLE venues ADD COLUMN sms_opt_out INTEGER DEFAULT 0`,
        `ALTER TABLE outreach_logs ADD COLUMN channel TEXT DEFAULT 'email'`,
        `CREATE INDEX IF NOT EXISTS idx_outreach_channel ON outreach_logs(channel, venue_id)`,
        `CREATE TABLE IF NOT EXISTS instagram_dm_queue (
          id TEXT PRIMARY KEY,
          venue_id TEXT NOT NULL,
          venue_name TEXT,
          instagram_handle TEXT NOT NULL,
          message TEXT NOT NULL,
          sequence_context TEXT,
          status TEXT DEFAULT 'pending',
          created_at TEXT DEFAULT (datetime('now')),
          sent_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_dm_queue_status ON instagram_dm_queue(status)`,
      ];
      for (const sql of migrations) {
        try { await env.DB.prepare(sql).run(); results.push({ sql: sql.slice(0, 60), ok: true }); }
        catch (e) { results.push({ sql: sql.slice(0, 60), ok: false, error: e.message }); }
      }
      return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Manual trigger for daily review requests (uses guestbook pipeline)
    // ?window=7d widens to 7-day lookback for one-time blasts
    if (path === '/account/review-batch') {
      const windowParam = url.searchParams.get('window');
      const windowHours = windowParam === '7d' ? 168 : 72;
      const dryRun = url.searchParams.get('dry') === '1';
      const clearCooldowns = url.searchParams.get('clear_cooldowns') === '1';

      if (clearCooldowns && !dryRun) {
        // Wipe review_cooldown KV keys from failed prior runs
        const kvList = await env.KV.list({ prefix: 'review_cooldown:' });
        let cleared = 0;
        for (const key of kvList.keys) {
          await env.KV.delete(key.name);
          cleared++;
        }
        console.log(`[Account] Cleared ${cleared} review cooldown keys`);
      }

      const result = await enrichAndSendReviews(env, { windowHours, dryRun });
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Null out corrupted last_visit dates where last_visit ≈ synced_at (the old fallback bug)
    if (path === '/account/guestbook-cleanup') {
      // Corrupted records have last_visit within 2 seconds of synced_at (both set during the same push)
      const result = await env.DB.prepare(`
        UPDATE guestbook SET last_visit = NULL
        WHERE last_visit IS NOT NULL AND synced_at IS NOT NULL
          AND abs(strftime('%s', last_visit) - strftime('%s', synced_at)) < 2
      `).run();
      const remaining = await env.DB.prepare('SELECT COUNT(*) as total FROM guestbook WHERE last_visit IS NOT NULL').first();
      return new Response(JSON.stringify({
        cleaned: result.meta?.changes || 0,
        remaining_with_last_visit: remaining?.total || 0,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Re-sync D1 guestbook from cached KV CSV (fixes corrupted last_visit dates)
    if (path === '/account/guestbook-resync') {
      const csv = await env.KV.get('guestbook_csv');
      if (!csv) return new Response(JSON.stringify({ error: 'No guestbook CSV in KV' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const lines = csv.split('\n');
      const headers = parseCSVLine(lines[0]).map(h => h.trim());
      const col = {};
      for (const name of ['firstName', 'lastName', 'phone1', 'email', 'lastVisitDate', 'totalOrders', 'lifetimeSpend']) {
        col[name] = headers.indexOf(name);
      }
      const stmts = [];
      let count = 0;
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const f = parseCSVLine(line);
        const firstName = col.firstName >= 0 ? (f[col.firstName] || '').trim() : '';
        const lastName = col.lastName >= 0 ? (f[col.lastName] || '').trim() : '';
        const rawPhone = col.phone1 >= 0 ? (f[col.phone1] || '').trim() : '';
        const phone = normalizePhone(rawPhone);
        const email = col.email >= 0 ? (f[col.email] || '').trim().toLowerCase() || null : null;
        const lastVisit = col.lastVisitDate >= 0 ? (f[col.lastVisitDate] || '').trim() || null : null;
        const orderCount = col.totalOrders >= 0 ? parseInt(f[col.totalOrders]) || 0 : 0;
        const totalSpend = col.lifetimeSpend >= 0 ? parseFloat(f[col.lifetimeSpend]) || 0 : 0;
        const id = phone || `nophone_${firstName}_${lastName}_${i}`.toLowerCase().replace(/\s+/g, '_');
        stmts.push(
          env.DB.prepare(`INSERT OR REPLACE INTO guestbook (id, first_name, last_name, phone, phone_raw, email, last_visit, order_count, total_spend, source, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'toast_resync', datetime('now'))`)
            .bind(id, firstName, lastName, phone, rawPhone, email, lastVisit, orderCount, totalSpend)
        );
        count++;
        // D1 batch limit is 128 statements
        if (stmts.length >= 120) {
          await env.DB.batch(stmts);
          stmts.length = 0;
        }
      }
      if (stmts.length > 0) await env.DB.batch(stmts);
      return new Response(JSON.stringify({ success: true, resynced: count }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Manual guestbook refresh — pulls fresh CSV from Toast using stored cookie
    if (path === '/account/guestbook-refresh') {
      const cookie = await env.KV.get('toast_cookie_override') || env.TOAST_COOKIE;
      if (!cookie) return new Response(JSON.stringify({ error: 'No Toast cookie configured' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const result = await refreshGuestbook(cookie, env);
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Guestbook JSON push — accepts scraped guest data from browser/bookmarklet
    // Format: POST [{name, phone, email, lastVisitDate, orders}]
    // Writes to D1 guestbook table (permanent archive) using batch inserts for speed
    if (path === '/account/guestbook-push' && request.method === 'POST') {
      try {
        const guests = await request.json();
        if (!Array.isArray(guests)) return new Response(JSON.stringify({ error: 'Expected JSON array' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

        // Prepare all inserts as batch statements for speed
        const stmts = [];
        let withPhone = 0;
        const phoneLookup = []; // {phone, name, firstName, lastName} for enrichment

        for (const guest of guests) {
          const parts = (guest.name || '').trim().split(/\s+/);
          const firstName = (parts[0] || '').trim();
          const lastName = (parts.slice(1).join(' ') || '').trim();
          const phone = normalizePhone(guest.phone);
          const phoneRaw = (guest.phone || '').trim();
          const email = (guest.email || '').trim().toLowerCase() || null;
          const lastVisit = guest.lastVisitDate || null;
          const orderCount = parseInt(guest.orders) || 0;
          const totalSpend = parseFloat(guest.totalSpend) || 0;
          const id = phone || `nophone_${firstName}_${lastName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`.toLowerCase().replace(/\s+/g, '_');

          stmts.push(
            env.DB.prepare(`INSERT OR REPLACE INTO guestbook (id, first_name, last_name, phone, phone_raw, email, last_visit, order_count, total_spend, source, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'toast', datetime('now'))`)
              .bind(id, firstName, lastName, phone, phoneRaw, email, lastVisit, orderCount, totalSpend)
          );
          if (phone) {
            withPhone++;
            if (guest.name) phoneLookup.push({ phone, name: guest.name.trim(), firstName, lastName });
          }
        }

        // Execute all inserts in one D1 batch (much faster than sequential)
        await env.DB.batch(stmts);

        // Bulk enrichment: update recent orders that match guestbook names
        let enriched = 0;
        for (const { phone, name, firstName, lastName } of phoneLookup) {
          const exactResult = await env.DB.prepare(`
            UPDATE orders SET customer_phone = ?
            WHERE customer_name = ? AND customer_phone IS NULL
            AND order_date >= datetime('now', '-7 days')
          `).bind(phone, name).run();
          if (exactResult.meta?.changes > 0) { enriched += exactResult.meta.changes; continue; }
          // Fuzzy: first name + last initial
          if (firstName && lastName) {
            const fuzzy = await env.DB.prepare(`
              UPDATE orders SET customer_phone = ?
              WHERE customer_phone IS NULL AND order_date >= datetime('now', '-7 days')
              AND customer_name LIKE ? || '%' AND customer_name LIKE '% ' || ? || '%'
            `).bind(phone, firstName, lastName.charAt(0)).run();
            if (fuzzy.meta?.changes > 0) enriched += fuzzy.meta.changes;
          }
        }

        return new Response(JSON.stringify({
          success: true,
          guests_stored: guests.length,
          guests_with_phone: withPhone,
          orders_enriched: enriched,
          message: `Archived ${guests.length} guests (${withPhone} with phone), enriched ${enriched} recent orders`,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // SLICC uploads guestbook CSV directly (browser-side download → push to Worker)
    // SLICC navigates to /crm/guestbook in Chrome, clicks Export, reads the file, POSTs here
    if (path === '/account/guestbook-upload' && request.method === 'POST') {
      const csv = await request.text();
      if (!csv || csv.length < 100) {
        return new Response(JSON.stringify({ error: 'CSV too short or empty' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      // Accept guestbook CSV (has firstName column) or loyalty CSV (has first_name)
      const hasGuestbookHeaders = csv.includes('firstName') || csv.includes('first_name') || csv.includes('phone') || csv.includes('Phone');
      if (!hasGuestbookHeaders) {
        return new Response(JSON.stringify({ error: 'CSV does not look like a guestbook file', preview: csv.slice(0, 200) }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      await env.KV.put('guestbook_csv', csv, { expirationTtl: 7776000 }); // 90 days
      const lineCount = csv.split('\n').filter(l => l.trim()).length - 1;
      console.log(`[Account] Guestbook uploaded by SLICC: ${lineCount} guests`);
      return new Response(JSON.stringify({ success: true, guests: lineCount }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Debug: check guestbook freshness
    if (path === '/account/guestbook-status') {
      const csv = await env.KV.get('guestbook_csv');
      if (!csv) return new Response(JSON.stringify({ status: 'missing', message: 'No guestbook in KV. Upload via POST /account/toast-guestbook or wait for 4am sync.' }), { headers: { 'Content-Type': 'application/json' } });
      const lines = csv.split('\n');
      const headers = parseCSVLine(lines[0]).map(h => h.trim());
      const lastVisitCol = headers.indexOf('lastVisitDate');
      let recentCount = 0;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      if (lastVisitCol >= 0) {
        for (let i = 1; i < lines.length; i++) {
          const f = parseCSVLine(lines[i].trim());
          if (!f[lastVisitCol]) continue;
          const d = new Date(f[lastVisitCol]);
          if (!isNaN(d.getTime()) && d.getTime() >= cutoff) recentCount++;
        }
      }
      // Also query D1 for actual guestbook table stats
      const d1Total = await env.DB.prepare('SELECT COUNT(*) as total FROM guestbook').first();
      const d1WithPhone = await env.DB.prepare('SELECT COUNT(*) as total FROM guestbook WHERE phone IS NOT NULL AND phone != ""').first();
      const d1WithVisit = await env.DB.prepare('SELECT COUNT(*) as total FROM guestbook WHERE last_visit IS NOT NULL').first();
      const d1WithSpend = await env.DB.prepare('SELECT COUNT(*) as total FROM guestbook WHERE total_spend > 0').first();
      const d1Recent7d = await env.DB.prepare("SELECT COUNT(*) as total FROM guestbook WHERE last_visit IS NOT NULL AND last_visit >= datetime('now', '-7 days')").first();

      return new Response(JSON.stringify({
        kv_csv: {
          total_guests: lines.length - 1,
          columns: headers,
          visitors_last_24h: recentCount,
          has_lastVisitDate: lastVisitCol >= 0,
        },
        d1_guestbook: {
          total: d1Total?.total || 0,
          with_phone: d1WithPhone?.total || 0,
          with_last_visit: d1WithVisit?.total || 0,
          with_total_spend: d1WithSpend?.total || 0,
          visited_last_7d: d1Recent7d?.total || 0,
        },
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // Summer 2026 campaign stats — used by dashboard
    if (path === '/outreach/summer-stats') {
      const row = await env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
          SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN contact_email IS NULL AND status = 'prospect' THEN 1 ELSE 0 END) as needs_instagram
        FROM venues
        WHERE campaign = 'summer_2026'
      `).first();
      return new Response(JSON.stringify(row || { total: 0, contacted: 0, replied: 0, active: 0, needs_instagram: 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Summer venues list — all summer_2026 campaign venues with status + contacts
    if (path === '/outreach/summer-venues') {
      const rows = await env.DB.prepare(`
        SELECT id, name, city, tier, category, status, campaign,
               contact_name, contact_email, contact_title, contact_instagram,
               contact_method_note, notes,
               CAST(julianday('now') - julianday(updated_at) AS INTEGER) as days_since_update
        FROM venues
        WHERE campaign = 'summer_2026'
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'replied' THEN 1 WHEN 'contacted' THEN 2 ELSE 3 END,
          tier ASC, name ASC
      `).all();
      return new Response(JSON.stringify(rows.results || []), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Summer Instagram DM queue — venues where no email found, Drew sends manually
    if (path === '/outreach/summer-instagram-queue') {
      const rows = await env.DB.prepare(`
        SELECT id, name, city, tier, category, contact_instagram, notes
        FROM venues
        WHERE campaign = 'summer_2026'
          AND contact_instagram IS NOT NULL
          AND status = 'prospect'
        ORDER BY tier ASC, created_at ASC
      `).all();

      const DM_TEMPLATE = (name, category) => {
        if (category === 'golf') {
          return `Hey ${name} — quick question: who handles F&B or concessions at the club?\n\nWe supply the pretzel warmer at Delta Center and SLC Bees — thinking the 19th hole angle could work well for you. Free warmer, pretzels wholesale, zero kitchen needed.\n\nWorth a quick chat? Happy to drop samples.\n\nDrew @ Dangerous Pretzel\n801.916.9122`;
        }
        if (category === 'brewery') {
          return `Hey ${name} — we already supply TF Brewery, Hopkins, ROHA, and HK Brewing in SLC.\n\nJust wondering if you've ever looked at adding pretzels to the taproom? We do a free warmer trial — zero commitment, see if it moves.\n\nDrew @ Dangerous Pretzel\n801.916.9122`;
        }
        if (category === 'fairgrounds' || category === 'other') {
          return `Hey ${name} — we're doing pretzel programs at Sandy Amphitheater and Delta Center this summer. Looking for a couple more event venues.\n\nFree warmer, pretzels wholesale — we could do a trial run at one of your summer events if the timing works.\n\nDrew @ Dangerous Pretzel\n801.916.9122`;
        }
        // Default: outdoor/summer venue
        return `Hey ${name} — love what you do with your summer programming.\n\nQuick question: who handles your concession/food vendors for events? We're working with Sandy Amphitheater and The Union Event Center this summer and wondering if you'd be open to a conversation.\n\nWe make pretzels. Sounds simple — it's a little more interesting than that. Happy to share details if there's a fit.\n\nDrew @ Dangerous Pretzel\n801.916.9122`;
      };

      const result = (rows.results || []).map(v => ({
        ...v,
        dm_template: DM_TEMPLATE(v.name, v.category),
        instagram_url: v.contact_instagram ? `https://instagram.com/${v.contact_instagram.replace('@', '')}` : null,
      }));

      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }

    // Coach voice — redraft all pending outreach emails with Drew's feedback
    if (path === '/outreach/coach-voice' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.feedback) {
          return new Response(JSON.stringify({ error: 'feedback required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        const result = await redraftPendingEmails(env, body.feedback);
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // Redraft all — same logic with default feedback message
    if (path === '/outreach/redraft-all' && request.method === 'POST') {
      try {
        const defaultFeedback = 'Rewrite to be friendly, casual, and local. We make really great unique pretzels people at this venue would love and talk about. We have made it super easy to offer. The only ask is: can I bring some by for the team to try? Remove all mechanical language (warmer model, trial run, one night, pick up the warmer). Add a P.S. line at the end: "P.S. See how other venues are running it: https://program.dangerouspretzel.com/pretzel-program" — keep the body itself under 130 words, P.S. is separate.';
        const result = await redraftPendingEmails(env, defaultFeedback);
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ── Voice Embedding (Vectorize) ──────────────────────────────────────
    // Embed + upsert a single sent email into Vectorize
    if (path === '/account/voice-embed' && request.method === 'POST') {
      return handleVoiceEmbed(request, env);
    }

    // Batch embed the last N approved sent emails from outreach_logs
    if (path === '/account/voice-scan') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      return handleVoiceScan(env, limit);
    }

    // Retrieve N similar emails given venue_category + hook_angle text
    if (path === '/account/voice-similar') {
      const query = url.searchParams.get('q') || '';
      const k = parseInt(url.searchParams.get('k') || '3');
      return handleVoiceSimilar(env, query, k);
    }

    // Customer list from D1
    if (path === '/account/customers') {
      return getCustomerList(env);
    }

    // Recent reviews from D1
    if (path === '/reviews/recent') {
      const reviews = await env.DB.prepare(
        'SELECT * FROM reviews ORDER BY created_at DESC LIMIT 20'
      ).all();
      return new Response(JSON.stringify(reviews.results, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Toast debug — test the cookie/fetch synchronously
    if (path === '/account/toast-debug') {
      const cookie = env.TOAST_COOKIE;
      if (!cookie) return new Response(JSON.stringify({ error: 'No TOAST_COOKIE' }), { status: 500 });

      const date = new Date();
      date.setDate(date.getDate() - 1);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const toastDate = toToastDateFormat(dateStr);

      try {
        // Try multiple order-related endpoints to find one that returns customer data
        // Call the GraphQL API directly to get guest data with phone/email
        const gqlUrl = 'https://www.toasttab.com/api/service/restaurant-admin-graphql/v1/graphql';

        // Try the guests list query
        const queries = [
          { name: 'getGuests', query: `query getGuests { guests(first: 5, sortBy: LAST_ORDER_DATE) { edges { node { id firstName lastName email phone loyaltyStatus totalOrders totalSpent lastOrderDate } } totalCount } }` },
          { name: 'getGuestProfile', query: `query getGuestProfile($guestId: ID!) { guest(id: $guestId) { id firstName lastName email phone } }`, variables: { guestId: '45bd6fb0-54df-4450-96c1-900be20ab71f' } },
        ];

        const results = {};
        for (const q of queries) {
          try {
            const resp = await fetch(gqlUrl, {
              method: 'POST',
              headers: {
                cookie,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify({
                operationName: q.name,
                query: q.query,
                variables: q.variables || {},
              }),
            });
            const body = await resp.text();
            results[q.name] = { status: resp.status, body: body.substring(0, 500) };
          } catch (err) {
            results[q.name] = { error: err.message };
          }
        }

        // Also try the GET-style query that the browser uses
        try {
          const getUrl = `${gqlUrl}?operationName=getGuestProfile&variables=${encodeURIComponent(JSON.stringify({guestId: '45bd6fb0-54df-4450-96c1-900be20ab71f'}))}`;
          const getResp = await fetch(getUrl, {
            headers: { cookie, 'Accept': 'application/json' },
          });
          const getBody = await getResp.text();
          results['getGuestProfile_GET'] = { status: getResp.status, body: getBody.substring(0, 500) };
        } catch (err) {
          results['getGuestProfile_GET'] = { error: err.message };
        }

        return new Response(JSON.stringify({ results }, null, 2),
          { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { status: 500 });
      }
    }

    // Toast upload stats — see what's been ingested
    if (path === '/account/toast-stats') {
      return getToastStats(env);
    }

    // Manual digest trigger
    if (path === '/account/digest') {
      const digest = await buildDigest(env);
      return new Response(JSON.stringify(digest), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Account health overview
    if (path === '/account/health') {
      return getAccountHealth(env);
    }

    return new Response('Account Worker', { status: 200 });
  }
};

// ── SQUARE WEBHOOK ────────────────────────────────────────────────────────────
async function handleSquareWebhook(request, env, ctx) {
  const body = await request.text();

  // Verify Square signature
  const signature = request.headers.get('x-square-hmacsha256-signature');
  if (!await verifySquareSignature(body, signature, env.SQUARE_WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const payload = JSON.parse(body);
  const eventType = payload.type;

  // We care about completed payments
  if (eventType !== 'payment.completed' && eventType !== 'order.fulfillment.updated') {
    return new Response('OK', { status: 200 });
  }

  ctx.waitUntil(processSquareOrder(payload, env));
  return new Response('OK', { status: 200 });
}

async function processSquareOrder(payload, env) {
  try {
    const payment = payload.data?.object?.payment || payload.data?.object;
    if (!payment) return;

    const orderId = payment.order_id || payment.id;
    const locationId = payment.location_id;
    const amountCents = payment.amount_money?.amount || 0;
    const customerPhone = payment.buyer_phone_number ||
      payment.shipping_address?.phone ||
      await getCustomerPhone(payment.customer_id, env);

    // Find matching active account by Square location ID
    const account = await env.DB.prepare(`
      SELECT aa.*, v.name as venue_name, v.id as venue_id
      FROM active_accounts aa
      JOIN venues v ON v.id = aa.venue_id
      WHERE aa.square_location_id = ?
    `).bind(locationId).first();

    // Write order to D1
    const orderRecord = {
      id: `square_${orderId}`,
      account_id: account?.id || null,
      venue_id: account?.venue_id || null,
      source: 'square',
      order_date: new Date().toISOString(),
      gross_revenue: amountCents / 100,
      customer_phone: customerPhone || null,
      raw_payload: JSON.stringify(payload),
    };

    await env.DB.prepare(`
      INSERT OR IGNORE INTO orders (
        id, account_id, venue_id, source, order_date,
        gross_revenue, customer_phone, raw_payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      orderRecord.id, orderRecord.account_id, orderRecord.venue_id,
      orderRecord.source, orderRecord.order_date,
      orderRecord.gross_revenue, orderRecord.customer_phone,
      orderRecord.raw_payload
    ).run();

    // Update account last_order stats
    if (account) {
      await env.DB.prepare(`
        UPDATE active_accounts
        SET last_order_date = datetime('now'),
            last_order_value = ?,
            total_rev_lifetime = total_rev_lifetime + ?,
            health_status = 'green',
            consecutive_missed = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(amountCents / 100, amountCents / 100, account.id).run();
    }

    // Schedule review request SMS (if phone available)
    if (customerPhone && amountCents > 0) {
      await scheduleReviewRequest(customerPhone, account?.venue_name, orderRecord.id, env);
    }

  } catch (err) {
    console.error('[Account] Square order processing error:', err.message);
  }
}

// ── TOAST WEBHOOK (URL hack → structured ingestion) ───────────────────────────
async function handleToastWebhook(request, env, ctx) {
  const body = await request.text();
  let payload;
  try { payload = JSON.parse(body); } catch { return new Response('Bad Request', { status: 400 }); }

  ctx.waitUntil(processToastOrder(payload, env));
  return new Response('OK', { status: 200 });
}

async function processToastOrder(payload, env) {
  try {
    // Toast order structure varies — handle both webhook and URL-hack formats
    const order = payload.order || payload;
    const orderId = order.guid || order.id || crypto.randomUUID();
    const restaurantGuid = order.restaurantGuid || order.restaurant_guid;
    const checks = order.checks || [];
    const totalAmount = checks.reduce((sum, c) =>
      sum + (c.totalAmount || c.total_amount || 0), 0);

    const customerPhone = checks[0]?.customer?.phone ||
      order.deliveryInfo?.deliveryEmployee?.phone || null;

    const account = await env.DB.prepare(`
      SELECT aa.*, v.name as venue_name, v.id as venue_id
      FROM active_accounts aa
      JOIN venues v ON v.id = aa.venue_id
      WHERE aa.toast_restaurant_guid = ?
    `).bind(restaurantGuid).first();

    await env.DB.prepare(`
      INSERT OR IGNORE INTO orders (
        id, account_id, venue_id, source, order_date,
        gross_revenue, customer_phone, raw_payload, created_at
      ) VALUES (?, ?, ?, 'toast', datetime('now'), ?, ?, ?, datetime('now'))
    `).bind(
      `toast_${orderId}`,
      account?.id || null,
      account?.venue_id || null,
      totalAmount / 100,
      customerPhone,
      JSON.stringify(payload)
    ).run();

    if (account && totalAmount > 0) {
      await env.DB.prepare(`
        UPDATE active_accounts
        SET last_order_date = datetime('now'),
            last_order_value = ?,
            total_rev_lifetime = total_rev_lifetime + ?,
            health_status = 'green',
            updated_at = datetime('now')
        WHERE id = ?
      `).bind(totalAmount / 100, totalAmount / 100, account.id).run();
    }

    if (customerPhone) {
      await scheduleReviewRequest(customerPhone, account?.venue_name, `toast_${orderId}`, env);
    }

  } catch (err) {
    console.error('[Account] Toast processing error:', err.message);
  }
}

// ── REVIEW REQUEST (Swell CX) ─────────────────────────────────────────────────
async function scheduleReviewRequest(phone, venueName, orderId, env) {
  // Check cooldown — one SMS per number per 30 days
  const recent = await env.DB.prepare(`
    SELECT id FROM orders
    WHERE customer_phone = ?
      AND review_requested_at IS NOT NULL
      AND datetime(review_requested_at) > datetime('now', '-${REVIEW_COOLDOWN_DAYS} days')
    LIMIT 1
  `).bind(phone).first();

  if (recent) {
    console.log(`[Account] Review cooldown active for ${phone}`);
    return;
  }

  // Wait 20 minutes then send (use a KV-based delay queue)
  const sendAt = Date.now() + (REVIEW_DELAY_MINUTES * 60 * 1000);
  await env.KV.put(
    `review_pending:${orderId}`,
    JSON.stringify({ phone, venueName, orderId, sendAt }),
    { expirationTtl: 3600 }  // clean up after 1hr
  );

  // The cron (every 5 min) picks these up — for simplicity, send directly
  await sendReviewSMS(phone, venueName, orderId, env);
}

async function sendReviewSMS(phone, customerName, orderId, env) {
  const token = env.SWELLCX_API_KEY;
  const SWELL_LOCATION_ID = 17640;
  const SWELL_CAMPAIGN_ID = 32823; // "Review Invite" campaign

  // Step 1: Find or create the contact in Swell by phone
  const cleanPhone = phone.replace(/[^0-9]/g, '').replace(/^1/, ''); // strip +1 and non-digits

  // NOTE: no cross-channel 48h brand-fatigue guard here (was added 2026-04-18, removed same day).
  // Review invites are POST-VISIT by definition — runDailyReviewRequests only fires for orders
  // in the last 24h. Both intended flows are healthy:
  //   Welcome SMS → visit → review invite (welcome-redemption flow)
  //   Win-back SMS → visit → review invite (win-back redemption flow, e.g. Kurt Apr 17)
  // The 30-day review cooldown in runDailyReviewRequests prevents review-spam. The 48h guard
  // on sendSwellSMS (retail marketing → marketing) still prevents back-to-back offers.
  const searchResp = await fetch(
    `https://platform.swellcx.com/api/v1/contacts?token=${token}&phone=${cleanPhone}`,
    { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' } }
  );
  if (!searchResp.ok) {
    const err = await searchResp.text();
    throw new Error(`Swell contact search failed (${searchResp.status}): ${err}`);
  }
  const searchData = await searchResp.json();
  let contactId = searchData.data?.[0]?.id;

  if (!contactId) {
    // Create the contact — Swell requires a name field
    const contactName = (customerName && customerName !== 'Guest') ? customerName : `Customer ${cleanPhone.slice(-4)}`;
    const createResp = await fetch('https://platform.swellcx.com/api/v1/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        token,
        name: contactName,
        phone: cleanPhone,
        locations: [SWELL_LOCATION_ID],
        country_code: 'US',
      }),
    });
    if (!createResp.ok) {
      const err = await createResp.text();
      throw new Error(`Swell contact create failed (${createResp.status}): ${err}`);
    }
    const createData = await createResp.json();
    contactId = createData.data?.id || createData.id;
    if (!contactId) throw new Error('Failed to create Swell contact: ' + JSON.stringify(createData));
  }

  // Step 2: Send the review invite via the campaign
  const inviteResp = await fetch('https://platform.swellcx.com/api/v1/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      token,
      location_id: SWELL_LOCATION_ID,
      campaign_id: SWELL_CAMPAIGN_ID,
      contact_id: contactId,
      override: true, // bypass Swell's cooldown — we manage our own 30-day cooldown in D1
    }),
  });

  if (!inviteResp.ok) {
    const err = await inviteResp.text();
    throw new Error(`Swell invite API error (${inviteResp.status}): ${err}`);
  }

  // Stamp review_requested_at on ALL orders for this phone in the last 24h that aren't
  // already stamped. Previously only the one orderId passed in got stamped — but
  // runDailyReviewRequests dedups by phone before calling, so multi-order visits (e.g.
  // Kurt Schaefer's 2 Square orders 7 minutes apart on Apr 17) left the second order as
  // review_requested_at=NULL. Also covers the guestbook-only path (orderId=null).
  //
  // Match against three phone formats to handle Toast/Square/raw variants in historical
  // data: the normalized 10-digit phone, the raw input, and the original orderId.
  try {
    await env.DB.prepare(`
      UPDATE orders
      SET review_requested_at = datetime('now'),
          review_request_method = 'sms'
      WHERE (id = ?
             OR customer_phone = ?
             OR customer_phone = ?
             OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(customer_phone,''), '+1', ''), '-', ''), ' ', ''), '(', ''), ')', '') = ?)
        AND review_requested_at IS NULL
        AND order_date >= datetime('now', '-24 hours')
    `).bind(orderId || '', phone, cleanPhone, cleanPhone).run();
  } catch (err) {
    console.error(`[sendReviewSMS] review_requested_at stamp failed for ${cleanPhone.slice(0, 6)}***:`, err.message);
  }

  console.log(`[Account] Swell review invite sent to ${phone.slice(0, 6)}*** (contact ${contactId})`);
}

async function generateReviewMessage(venueName, env) {
  const venuePhrase = venueName ? `at ${venueName}` : '';
  const prompts = [
    `Hey! Hope you loved your Dangerous Pretzel ${venuePhrase} 🥨 Would mean the world if you left us a quick Google review:`,
    `Thanks for grabbing a pretzel${venuePhrase ? ` ${venuePhrase}` : ''}! If it hit the spot, we'd love a quick review:`,
    `Dangerous Pretzel here — hope you ruined your dinner in the best way possible${venuePhrase ? ` ${venuePhrase}` : ''}. Drop us a review?`,
  ];
  // Rotate through messages to avoid SMS spam filters
  return prompts[Math.floor(Date.now() / 1000) % prompts.length];
}

// ── DAILY REVIEW PIPELINE (2pm MT) ───────────────────────────────────────────

async function enrichAndSendReviews(env, opts = {}) {
  const windowHours = opts.windowHours || 72;
  const dryRun = opts.dryRun || false;
  console.log(`[Account] Running review pipeline (window: ${windowHours}h, dry: ${dryRun})...`);

  // STRATEGY: D1 orders table is the sole source of review-eligible customers.
  // The check details report (pulled daily at 4am) captures customer_phone for every
  // loyalty member who orders. Only verified buyers get review requests.

  const eligible = [];

  // PRIMARY: D1 orders with phones in the lookback window.
  // POS switched to Square on April 14 — Toast orders are historical-only now.
  // Excludes Toast, wholesale/catering sources, and delivery-platform orders (phones
  // there are DoorDash/Uber/Grubhub driver relays, not our customers).
  const recentWithPhone = await env.DB.prepare(`
    SELECT customer_phone, customer_name FROM orders
    WHERE customer_phone IS NOT NULL AND customer_phone != ''
      AND order_date >= datetime('now', '-${windowHours} hours')
      AND source = 'square'
      AND (customer_name IS NULL
        OR (customer_name NOT LIKE 'DD %'
        AND customer_name NOT LIKE 'UBER%'
        AND customer_name NOT LIKE '%Grubhub%'
        AND customer_name NOT LIKE '%DoorDash%'))
    GROUP BY customer_phone
  `).all();

  for (const row of (recentWithPhone.results || [])) {
    eligible.push({ phone: row.customer_phone, name: row.customer_name || 'Guest', source: 'orders' });
  }
  const fromOrders = eligible.length;
  console.log(`[Account] ${fromOrders} D1 orders with phones in last ${windowHours}h`);

  // SUPPLEMENTARY: guestbook contacts with a verified last_visit in the window
  // Catches customers whose order in D1 didn't have a phone attached
  const d1Phones = new Set(eligible.map(e => {
    const n = normalizePhone(e.phone);
    return n ? n.replace(/\D/g, '') : e.phone.replace(/\D/g, '');
  }));
  // Guestbook sync lags up to 24h — use 7 days for the supplementary source so we catch
  // customers who signed up earlier in the week and haven't been reviewed yet. 30-day
  // cooldown downstream still prevents re-sends.
  // Also filter out phone-as-name records (fake/junk first_name = their own phone).
  const guestbookRecent = await env.DB.prepare(`
    SELECT phone, first_name, last_name FROM guestbook
    WHERE phone IS NOT NULL AND phone != ''
      AND last_visit IS NOT NULL
      AND last_visit >= datetime('now', '-7 days')
      AND first_name NOT GLOB '+*'
      AND first_name NOT GLOB '1[0-9]*'
      AND LOWER(first_name) NOT IN ('visa cardholder','mastercard','cardholder','card holder','test','guest','customer','unknown','n/a','none','online order')
  `).all();
  let guestbookHits = 0;
  for (const row of (guestbookRecent.results || [])) {
    const norm = normalizePhone(row.phone);
    const digits = norm ? norm.replace(/\D/g, '') : row.phone.replace(/\D/g, '');
    if (d1Phones.has(digits)) continue; // already covered by orders
    d1Phones.add(digits);
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Guest';
    eligible.push({ phone: row.phone, name, source: 'guestbook' });
    guestbookHits++;
  }
  console.log(`[Account] ${guestbookHits} additional from guestbook table`);

  if (eligible.length === 0) {
    return dryRun
      ? { dry_run: true, window_hours: windowHours, from_orders: fromOrders, from_guestbook: guestbookHits, total_eligible: 0, would_send: 0, blocked_by_cooldown: 0, skipped: 0, contacts: [] }
      : { sent: 0, skipped: 0, cooldown: 0, eligible: 0 };
  }

  // Send (or dry-run) with dedup + cooldown
  let sent = 0, skipped = 0, cooldown = 0;
  const processedPhones = new Set();
  const dryContacts = [];
  const errors = [];

  for (const { phone: rawPhone, name, source } of eligible) {
    const phone = normalizePhone(rawPhone);
    if (!phone) { skipped++; continue; }
    const digits = phone.replace(/\D/g, '');

    if (processedPhones.has(digits)) { skipped++; continue; }
    processedPhones.add(digits);

    // KV cooldown check (30 days)
    const kvCooldown = await env.KV.get(`review_cooldown:${digits}`);
    if (kvCooldown) { cooldown++; continue; }

    // D1 cooldown check
    const recent = await env.DB.prepare(`
      SELECT id FROM orders
      WHERE customer_phone IN (?, ?)
        AND review_requested_at IS NOT NULL
        AND datetime(review_requested_at) > datetime('now', '-${REVIEW_COOLDOWN_DAYS} days')
      LIMIT 1
    `).bind(phone, rawPhone).first();
    if (recent) { cooldown++; continue; }

    if (dryRun) {
      dryContacts.push({ phone: phone.slice(0, 6) + '****', name, source });
      sent++;
      continue;
    }

    try {
      await sendReviewSMS(phone, name, null, env);
      await env.KV.put(`review_cooldown:${digits}`, new Date().toISOString(), {
        expirationTtl: REVIEW_COOLDOWN_DAYS * 86400,
      });
      // Stamp review_requested_at on every order matching this phone in the lookback window.
      // Without this, dashboard/reports that count reviews via orders.review_requested_at
      // show 0 sent even when the cron is firing reviews successfully.
      await env.DB.prepare(`
        UPDATE orders SET review_requested_at = datetime('now'), review_request_method = 'sms'
        WHERE customer_phone IN (?, ?)
          AND review_requested_at IS NULL
          AND order_date >= datetime('now', '-${windowHours} hours')
      `).bind(phone, rawPhone).run().catch(e => console.error('[Account] review_requested_at stamp failed:', e.message));
      sent++;
      console.log(`[Account] Review invite sent to ${name} (${phone.slice(0, 6)}***)`);
    } catch (err) {
      console.error(`[Account] Review SMS failed for ${phone.slice(0, 6)}***: ${err.message}`);
      if (errors.length < 5) errors.push({ phone: phone.slice(0, 6) + '****', error: err.message });
      skipped++;
    }
  }

  if (dryRun) {
    return {
      dry_run: true,
      window_hours: windowHours,
      from_orders: fromOrders,
      from_guestbook: guestbookHits,
      total_eligible: eligible.length,
      after_dedup: processedPhones.size + skipped,
      blocked_by_cooldown: cooldown,
      skipped,
      would_send: sent,
      contacts: dryContacts,
    };
  }

  console.log(`[Account] Review batch: ${sent} sent, ${skipped} skipped, ${cooldown} on cooldown`);
  return { sent, skipped, cooldown, eligible: eligible.length, errors };
}

async function runDailyReviewRequests(env) {
  console.log('[Account] Running daily review request batch...');

  // Find orders from the last 24 hours with a phone number but no review request sent
  const eligibleOrders = await env.DB.prepare(`
    SELECT id, customer_name, customer_phone, customer_email, order_date, gross_revenue
    FROM orders
    WHERE customer_phone IS NOT NULL
      AND customer_phone != ''
      AND review_requested_at IS NULL
      AND order_date >= datetime('now', '-24 hours')
    ORDER BY order_date DESC
  `).all();

  const orders = eligibleOrders.results || [];
  console.log(`[Account] Found ${orders.length} orders eligible for review requests`);

  if (orders.length === 0) return { sent: 0, skipped: 0, cooldown: 0 };

  let sent = 0;
  let skipped = 0;
  let cooldown = 0;
  const processedPhones = new Set(); // dedupe within this batch

  for (const order of orders) {
    const phone = order.customer_phone;
    if (!phone || phone.length < 10) { skipped++; continue; }

    // Skip if we already processed this phone in this batch
    if (processedPhones.has(phone)) { skipped++; continue; }
    processedPhones.add(phone);

    // Skip DoorDash/delivery driver numbers (DD orders have customer name like "DD ecf5dae2 ...")
    if (order.customer_name && order.customer_name.startsWith('DD ')) { skipped++; continue; }

    // Check 30-day cooldown
    const recent = await env.DB.prepare(`
      SELECT id FROM orders
      WHERE customer_phone = ?
        AND review_requested_at IS NOT NULL
        AND datetime(review_requested_at) > datetime('now', '-30 days')
      LIMIT 1
    `).bind(phone).first();

    if (recent) { cooldown++; continue; }

    // Send the review request SMS
    try {
      await sendReviewSMS(phone, null, order.id, env);
      sent++;
    } catch (err) {
      console.error(`[Account] Review SMS failed for ${phone.slice(0, 6)}***: ${err.message}`);
      skipped++;
    }
  }

  console.log(`[Account] Review batch complete: ${sent} sent, ${skipped} skipped, ${cooldown} on cooldown`);
  return { sent, skipped, cooldown };
}

// ── ACCOUNT HEALTH CRON ───────────────────────────────────────────────────────
async function runAccountHealth(env) {
  console.log('[Account] Running weekly health check...');

  const accounts = await env.DB.prepare(`
    SELECT aa.*, v.name as venue_name, v.contact_email, v.contact_name
    FROM active_accounts aa
    JOIN venues v ON v.id = aa.venue_id
    WHERE aa.warmer_removed_at IS NULL
  `).all();

  const issues = [];

  for (const account of accounts.results || []) {
    const daysSinceOrder = account.last_order_date
      ? Math.floor((Date.now() - new Date(account.last_order_date)) / 86400000)
      : 999;

    let newHealth = 'green';
    let churnRisk = 0;

    if (daysSinceOrder >= CHURN_RISK_DAYS) {
      newHealth = 'red';
      churnRisk = 85;
      issues.push({ account, daysSinceOrder, severity: 'red' });
    } else if (daysSinceOrder >= REORDER_WINDOW_DAYS) {
      newHealth = 'yellow';
      churnRisk = 40;
      issues.push({ account, daysSinceOrder, severity: 'yellow' });
    }

    await env.DB.prepare(`
      UPDATE active_accounts
      SET health_status = ?, churn_risk = ?,
          consecutive_missed = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      newHealth,
      churnRisk,
      daysSinceOrder >= REORDER_WINDOW_DAYS ? Math.floor(daysSinceOrder / 7) : 0,
      account.id
    ).run();
  }

  // Draft check-in emails for at-risk accounts
  for (const issue of issues) {
    if (issue.account.contact_email) {
      await draftCheckIn(issue, env);
    }
  }

  // Build and send Drew's Monday digest
  await sendDigest(env, accounts.results || [], issues);

  console.log(`[Account] Health check complete. Issues: ${issues.length}`);
}

async function draftCheckIn(issue, env) {
  const { account, daysSinceOrder } = issue;

  const prompt = `Write a short, genuine check-in email from Drew at Dangerous Pretzel Co to ${account.contact_name || 'the team'} at ${account.venue_name}.

Context: They've been an active account for a while. No order in ${daysSinceOrder} days. We want to check in — not be pushy.

Rules:
- 3 sentences max
- Sound like Drew, not a sales email — genuine, casual
- Mention something specific if possible (their venue type, a new flavor, upcoming season)  
- One soft CTA: "anything we can do to make restocking easier?" or "need us to swing by?"
- Do NOT mention that we noticed they haven't ordered

Return JSON: {subject, body}`;

  // Try Workers AI first (free, no egress) — fall back to claude-haiku
  let text = null;
  if (env.AI) {
    try {
      const aiResp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: 'You are a JSON email writer. Return valid JSON only, no markdown.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
      });
      text = aiResp?.response || null;
    } catch { text = null; }
  }

  if (!text) {
    // DIF-3 (May 13 2026): wired through ai-budget
    const result = await callAI(env, {
      use_case: 'account_checkin_email',
      model: 'haiku',
      caller: 'account-worker.js',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    if (!result.ok) return;
    text = result.content || '';
  }

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const email = JSON.parse(clean);

    // Store draft in KV for Drew to approve (don't auto-send check-ins)
    await env.KV.put(
      `checkin_draft:${account.id}`,
      JSON.stringify({ ...email, venue_name: account.venue_name, contact_email: account.contact_email }),
      { expirationTtl: 604800 } // 7 days
    );
  } catch (err) {
    console.error('[Account] Check-in draft parse error:', err.message);
  }
}

// ── MONDAY DIGEST ─────────────────────────────────────────────────────────────
async function buildDigest(env) {
  const [accountStats, pipelineStats, weekOrders, topAccounts, cfoDirective, openFlags] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) as total_active,
        SUM(CASE WHEN health_status = 'green' THEN 1 ELSE 0 END) as green,
        SUM(CASE WHEN health_status = 'yellow' THEN 1 ELSE 0 END) as yellow,
        SUM(CASE WHEN health_status = 'red' THEN 1 ELSE 0 END) as red,
        SUM(avg_monthly_rev) as total_monthly_rev,
        SUM(total_rev_lifetime) as total_lifetime_rev
      FROM active_accounts WHERE warmer_removed_at IS NULL
    `).first(),

    env.DB.prepare(`
      SELECT
        COUNT(*) as total_prospects,
        SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as tier1,
        SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
        SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied
      FROM venues WHERE status != 'active'
    `).first(),

    env.DB.prepare(`
      SELECT SUM(gross_revenue) as weekly_rev, COUNT(*) as order_count
      FROM orders
      WHERE order_date >= date('now', '-7 days')
    `).first(),

    env.DB.prepare(`
      SELECT v.name, aa.avg_monthly_rev, aa.health_status, aa.last_order_date
      FROM active_accounts aa
      JOIN venues v ON v.id = aa.venue_id
      WHERE aa.warmer_removed_at IS NULL
      ORDER BY aa.avg_monthly_rev DESC
      LIMIT 5
    `).all(),

    // CFO financial directive
    env.DB.prepare(
      'SELECT executive_summary, priority_actions, total_revenue_week, ' +
      'wholesale_revenue_week, retail_revenue_week, catering_revenue_week, ' +
      'cash_runway_weeks, cash_alert, growth_brake, week_start ' +
      'FROM financial_directives WHERE active = 1 LIMIT 1'
    ).first(),

    // Open financial flags
    env.DB.prepare(
      "SELECT flag_type, severity, title, suggested_action " +
      "FROM financial_flags WHERE status = 'open' " +
      "ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END LIMIT 5"
    ).all(),
  ]);

  // Pull canonical financial numbers — these override any stale values in
  // the cfo_directive. The Mercury feed disconnected from QBO ~60 days ago,
  // so QBO-derived cash is wrong; canonical reads live from mercury_accounts.
  const [canonCash, canonRunway, canonRevenue] = await Promise.all([
    getCanonicalCashOnHand(env).catch(() => null),
    getCanonicalRunway(env).catch(() => null),
    getCanonicalWeeklyRevenue(env, 7).catch(() => null),
  ]);

  return {
    week_of: new Date().toISOString().split('T')[0],
    accounts: accountStats,
    pipeline: pipelineStats,
    week_orders: weekOrders,
    top_accounts: topAccounts.results,
    cfo_data: cfoDirective || null,
    open_flags: openFlags.results || [],
    canonical: {
      cash_on_hand: canonCash,
      runway: canonRunway,
      weekly_revenue: canonRevenue,
    },
  };
}

async function sendDigest(env, accounts, issues) {
  const data = await buildDigest(env);
  const cfoData = data.cfo_data;
  const openFlags = data.open_flags;
  const canon = data.canonical || {};

  // ─── CANONICAL NUMBERS (override any stale directive values) ──────────
  const canonCash = canon.cash_on_hand?.total ?? null;
  const canonRunwayWeeks = canon.runway?.weeks ?? null;
  const canonRunwayDisplay = canon.runway?.display ?? null;
  const canonRev = canon.weekly_revenue || {};
  const canonRetail = canonRev.retail?.revenue ?? 0;
  const canonRetailBreakdown = canonRev.retail?.breakdown || {};
  const canonMarketplace = canonRev.marketplace?.revenue ?? 0;
  const canonMarketplacePlatforms = canonRev.marketplace?.platforms || [];
  const canonWholesale = canonRev.wholesale?.revenue ?? 0;
  const canonCatering = canonRev.catering?.revenue ?? 0;
  const canonTotalRev = canonRev.total ?? 0;
  const canonWarnings = canonRev.warnings || [];

  // Drift detection vs stored directive removed (Reset plan Phase 2, Apr 30 2026):
  // cfo-agent no longer writes cash_on_hand to financial_directives. Runway
  // drift is still informational; check it but only the runway, not cash.
  const driftNotes = [];
  if (cfoData) {
    if (canonRunwayWeeks != null && cfoData.cash_runway_weeks) {
      const diff = Math.abs((cfoData.cash_runway_weeks || 0) - canonRunwayWeeks);
      if (diff > 4) driftNotes.push(`Stored runway ${cfoData.cash_runway_weeks}w differs from canonical ${canonRunwayWeeks}w — using canonical.`);
    }
  }

  // Cash signal off canonical runway, not directive
  let cashSignal = '';
  if (canonRunwayWeeks != null) {
    cashSignal = canonRunwayWeeks > 12 ? 'green (>12 weeks)' : canonRunwayWeeks >= 8 ? 'amber (8-12 weeks)' : canonRunwayWeeks >= 4 ? 'RED (<8 weeks)' : 'CRITICAL (<4 weeks)';
  }

  const warningsBlock = canonWarnings.length
    ? '\n⚠ DATA WARNINGS (look into these — may indicate broken data flow):\n' + canonWarnings.map(w => `  · [${w.severity.toUpperCase()}] ${w.message}`).join('\n')
    : '';
  const driftBlock = driftNotes.length
    ? '\n📊 STALE-DATA NOTES:\n' + driftNotes.map(n => '  · ' + n).join('\n')
    : '';

  // Format retail breakdown with sub-channels
  const retailIn = canonRetailBreakdown.in_person_square || {};
  const retailDel = canonRetailBreakdown.direct_delivery || {};
  const retailSubLine = `(In-person Square $${(retailIn.revenue || 0).toFixed(0)} · Direct delivery Kiosk/Web $${(retailDel.revenue || 0).toFixed(0)})`;

  // Marketplace platforms one-liner
  const marketplaceLine = canonMarketplace > 0
    ? `\n- Marketplace (gross via Square; not in total — would double-count Mercury settlement): $${canonMarketplace.toFixed(0)} (${canonMarketplacePlatforms.map(p => p.platform + ' $' + p.revenue.toFixed(0)).join(' · ')})`
    : '';

  const cfoSection = `CASH POSITION (live, from Mercury — overrides any stale Sunday directive):
- Cash on hand: ${canonCash != null ? '$' + canonCash.toLocaleString('en-US', {minimumFractionDigits: 2}) : 'unknown'} ${canon.cash_on_hand?.breakdown ? '(' + canon.cash_on_hand.breakdown.map(b => b.account_name + ': $' + b.balance.toFixed(0)).join(', ') + ')' : ''}
- Runway: ${canonRunwayDisplay || 'unknown'}${cashSignal ? ' — ' + cashSignal : ''}
- Weekly burn (30d avg): ${canon.runway?.weekly_burn ? '$' + canon.runway.weekly_burn.toLocaleString('en-US', {maximumFractionDigits: 0}) : 'unknown'} (source: ${canon.runway?.burn_source || '?'})

REVENUE LAST 7 DAYS (live, from orders + catering tables):
- Wholesale: $${canonWholesale.toFixed(0)} (${canonRev.wholesale?.orders || 0} orders / invoices)
- Retail: $${canonRetail.toFixed(0)} (${canonRev.retail?.orders || 0} orders) ${retailSubLine}
- Catering: $${canonCatering.toFixed(0)} (${canonRev.catering?.bookings || 0} bookings)
- Total: $${canonTotalRev.toFixed(0)}${marketplaceLine}
- GL cross-check: $${(canonRev.gl_revenue_cross_check || 0).toFixed(0)}${warningsBlock}${driftBlock}

${cfoData ? `CFO EXECUTIVE SUMMARY (from Sunday analysis — narrative only, NOT a source of truth for numbers):
${cfoData.executive_summary || 'No summary available.'}

CFO Priority Actions:
${(() => { try { return JSON.parse(cfoData.priority_actions || '[]').map((a, i) => `${i+1}. ${a.action || a}`).join('\n'); } catch { return cfoData.priority_actions || 'None'; } })()}` : 'CFO analysis runs Sunday 10pm — narrative will resume next week.'}`;

  const flagSection = openFlags.length > 0
    ? `OPEN FINANCIAL FLAGS:
${openFlags.map(f => `[${f.severity.toUpperCase()}] ${f.title}\n   → ${f.suggested_action}`).join('\n')}`
    : '';

  const prompt = `Write Drew's Monday morning Dangerous Pretzel business digest email.

CRITICAL DATA RULES (NEVER VIOLATE):
- The "CASH POSITION" and "REVENUE LAST 7 DAYS" numbers below are LIVE — use these EXACTLY as shown. Do not round to "close" numbers, do not approximate.
- The CFO executive summary is NARRATIVE only — never quote dollar figures from it. If it conflicts with the live numbers, the live numbers win.
- If "DATA WARNINGS" appear, surface them prominently in the body — they indicate real operational issues Drew needs to act on.
- If "STALE-DATA NOTES" appear, briefly mention that the prior week's directive had stale numbers (helps Drew understand why this week's numbers may differ from his last digest).

CFO SECTION (PUT THIS FIRST — most important):
${cfoSection}

${flagSection}

Operational Data:
${JSON.stringify({ accounts: data.accounts, pipeline: data.pipeline, week_orders: data.week_orders, top_accounts: data.top_accounts }, null, 2)}

At-risk accounts needing attention: ${issues.length}
${issues.map(i => `- ${i.account.venue_name}: ${i.daysSinceOrder} days since last order (${i.severity})`).join('\n')}

Format:
- FIRST section: cash position + runway + channel revenue (USE THE EXACT NUMBERS ABOVE)
- SECOND section: CFO narrative summary + priority actions (text only, no $ figures from the directive)
- THIRD section: Data warnings (if any) — call out what's broken
- FOURTH section: Ops — account health, pipeline, agent activity
- FIFTH section: Open financial flags if any
- Flag any at-risk accounts by name with suggested action
- Close with something energizing — this is a momentum builder, not a report
- Tone: like a smart business partner talking to Drew, not a dashboard

Keep it under 500 words. Return JSON: {subject, body}`;

  // DIF-3 (May 13 2026): wired through ai-budget
  const result = await callAI(env, {
    use_case: 'account_churn_risk',
    model: 'sonnet',
    caller: 'account-worker.js',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  if (!result.ok) return;
  const text = result.content || '';

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const email = JSON.parse(clean);

    // Enhanced subject line with CFO signals
    const subject = email.subject ||
      `Pretzel OS — Week of ${data.week_of}` +
      (cfoData?.cash_alert ? ' ⚠ CASH ALERT' : '') +
      (openFlags.some(f => f.severity === 'critical') ? ' 🚨 ACTION REQUIRED' : '');

    await sendGmail(env, {
      to: env.DREW_EMAIL,
      subject,
      body: email.body,
    });
    console.log('[Account] Monday digest sent to Drew (with CFO data)');
  } catch (err) {
    console.error('[Account] Digest send error:', err.message);
  }
}

// ── TOAST DAILY SYNC (direct — pulls from Toast admin reporting) ──────────────

async function syncToastData(env, days = 1) {
  console.log(`[Account] Toast sync: pulling ${days} day(s) directly from Toast...`);
  // Check KV override first (set via /account/update-cookie), then fall back to wrangler secret
  const cookie = await env.KV.get('toast_cookie_override') || env.TOAST_COOKIE;
  if (!cookie) {
    console.error('[Account] TOAST_COOKIE secret not set — cannot sync');
    return { error: 'TOAST_COOKIE not configured', inserted: 0 };
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalRevenue = 0;
  let totalCustomers = 0;

  for (let d = 0; d < days; d++) {
    const date = new Date();
    date.setDate(date.getDate() - 1 - d);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const toastDate = toToastDateFormat(dateStr);

    try {
      // 1. Fetch item-level data (what we had before)
      const itemData = await fetchToastReport(cookie, 'item', toastDate);
      const modData = await fetchToastReport(cookie, 'modifier', toastDate);

      if (!itemData && !modData) {
        console.log(`[Account] Toast sync: cookie may be expired for ${dateStr}`);
        continue;
      }

      const allItems = [...(itemData || []), ...(modData || [])];
      if (allItems.length === 0) {
        console.log(`[Account] Toast sync: no items for ${dateStr}`);
        continue;
      }

      // Group items by order number
      const orderMap = new Map();
      for (const item of allItems) {
        const orderNum = item.order;
        const itemName = item.name?.trim();
        const category = item.category?.trim();
        const quantity = parseInt(item.quantity) || 0;
        const itemDate = item.date;

        if (!orderNum || !itemName || quantity <= 0) continue;
        if (itemName === 'Gift Card' || itemName === 'eGift Card') continue;
        if (itemName === 'Add Value ($)') continue;

        if (!orderMap.has(orderNum)) {
          orderMap.set(orderNum, { items: [], date: itemDate, service: item.service || '' });
        }
        orderMap.get(orderNum).items.push({ name: itemName, category, quantity });
      }

      // Write item orders to D1
      for (const [orderNum, order] of orderMap) {
        const dt = parseToastDate(order.date);
        if (!dt) continue;
        const isoDate = dt.toISOString();

        let orderRevenue = 0;
        for (const item of order.items) {
          const price = TOAST_PRICES[item.name] ?? TOAST_PRICES[item.name.trim()];
          if (price !== undefined) {
            orderRevenue += price * item.quantity;
          } else {
            if (item.category?.includes('Pretzel')) orderRevenue += 7 * item.quantity;
            else if (item.category?.includes('Bomb')) orderRevenue += 6 * item.quantity;
            else if (item.category?.includes('Dip')) orderRevenue += 2 * item.quantity;
          }
        }

        const dateKey = isoDate.slice(0, 10).replace(/-/g, '');
        // All Toast POS orders are 'toast_live' — catering is only identified via Toast invoicing
        // (which we don't have API access to). Catering tagging happens manually or via QBO.
        const orderSource = 'toast_live';
        const orderId = `${orderSource}_${dateKey}_${orderNum}`;

        try {
          await env.DB.prepare(`
            INSERT OR IGNORE INTO orders (
              id, account_id, venue_id, source, order_date,
              gross_revenue, customer_phone, raw_payload, created_at
            ) VALUES (?, NULL, NULL, ?, ?, ?, NULL, ?, datetime('now'))
          `).bind(
            orderId, orderSource, isoDate, orderRevenue,
            JSON.stringify({ order_num: orderNum, items: order.items, service: order.service })
          ).run();
          totalInserted++;
          totalRevenue += orderRevenue;

          // Cross-channel signal: push large orders to queue for instant catering lead creation
          const totalItems = order.items.reduce((s, i) => s + (i.quantity || 0), 0);
          if (totalItems >= 5 && env.SIGNAL_QUEUE) {
            try {
              await env.SIGNAL_QUEUE.send({
                type: 'retail_group_order',
                customer_phone: null, // will be enriched by guestbook later
                customer_email: null,
                customer_name: null,
                item_count: totalItems,
                order_value: orderRevenue,
                order_date: isoDate,
                source: 'toast',
              });
              console.log(`[Account] Cross-channel signal queued: ${totalItems} items, $${orderRevenue}`);
            } catch (err) {
              // Non-fatal — don't break the sync
              console.error('[Account] Signal queue error:', err.message);
            }
          }
        } catch {
          totalSkipped++;
        }
      }

      // 2. Fetch check details for customer data (name, phone, email)
      const checkData = await fetchToastCheckReport(cookie, toastDate);
      if (checkData && checkData.length > 0) {
        for (const check of checkData) {
          if (!check.customerName && !check.customerPhone && !check.customerEmail) continue;
          totalCustomers++;

          // Match to existing order by check/order number + date
          const checkDate = parseToastDate(check.date);
          if (!checkDate || !check.orderNum) continue;
          const dateKey = checkDate.toISOString().slice(0, 10).replace(/-/g, '');

          for (const prefix of ['toast_live_', 'toast_tsv_']) {
            try {
              const result = await env.DB.prepare(`
                UPDATE orders
                SET customer_name = COALESCE(?, customer_name),
                    customer_phone = COALESCE(?, customer_phone),
                    customer_email = COALESCE(?, customer_email)
                WHERE id = ?
              `).bind(
                check.customerName, check.customerPhone, check.customerEmail,
                `${prefix}${dateKey}_${check.orderNum}`
              ).run();
              if (result.meta?.changes > 0) break;
            } catch { /* skip */ }
          }
        }
      }

      console.log(`[Account] Toast sync ${dateStr}: ${orderMap.size} orders, ${totalCustomers} customers`);
    } catch (err) {
      console.error(`[Account] Toast sync error for ${dateStr}:`, err.message);
    }
  }

  console.log(`[Account] Toast sync complete: ${totalInserted} inserted, ${totalSkipped} skipped, $${totalRevenue} rev, ${totalCustomers} customers`);

  // Refresh guestbook (source of truth for review requests)
  try {
    await refreshGuestbook(cookie, env);
  } catch (err) {
    console.error('[Account] Guestbook refresh failed:', err.message);
  }

  // Alert Drew if sync produced zero results (cookie likely expired)
  if (totalInserted === 0 && days <= 2) {
    // Set a persistent notification in KV
    await env.KV.put('notification:cookie_expired', JSON.stringify({
      type: 'cookie_expired',
      title: 'Toast cookie expired',
      message: 'Daily sync failed — no orders pulled. Update your Toast cookie.',
      action: 'POST /account/update-cookie with your fresh cookie string',
      created_at: new Date().toISOString(),
    }), { expirationTtl: 604800 }); // auto-clears after 7 days

    try {
      await sendGmail(env, {
        to: env.DREW_EMAIL,
        subject: 'Pretzel OS - Toast cookie needs refresh',
        body: `Hey Drew,\n\nToday's Toast sync came back empty -- the session cookie has expired.\n\nFix it here (takes 30 seconds):\nhttps://pretzel-os.drew-f39.workers.dev/account/update-cookie\n\nSyncs will resume automatically once the cookie is updated.\n\n-- Pretzel OS`,
      });
    } catch { /* email sending is best-effort */ }
  } else if (totalInserted > 0) {
    // Clear the notification if sync succeeded
    await env.KV.delete('notification:cookie_expired');
  }

  return { inserted: totalInserted, skipped: totalSkipped, revenue: totalRevenue, customers: totalCustomers };
}

// ── TOAST GUESTBOOK AUTO-REFRESH ────────────────────────────────────────────
// Pulls the full guestbook CSV from Toast admin and caches it in KV.
// This runs daily as part of syncToastData so review requests always have fresh data.

async function refreshGuestbook(cookie, env) {
  console.log('[Account] Refreshing guestbook from Toast...');
  try {
    // Try multiple known URL patterns (Toast moved guestbook from /loyalty/guests to /crm/guestbook)
    // The export may redirect to S3 (202) or return CSV directly
    const exportCandidates = [
      'https://www.toasttab.com/restaurants/admin/crm/guestbook/export',
      'https://www.toasttab.com/restaurants/admin/loyalty/guests/export',
    ];

    let exportUrl = exportCandidates[0];
    let resp = null;

    for (const url of exportCandidates) {
      resp = await fetch(url, {
        headers: { cookie, 'Accept': 'text/csv,*/*', 'Referer': 'https://www.toasttab.com/restaurants/admin/crm/guestbook' },
        redirect: 'manual',
      });
      exportUrl = url;
      // If we get a redirect or non-HTML response, this is the right URL
      const ct = resp.headers.get('content-type') || '';
      if (resp.status === 302 || resp.status === 301 || resp.status === 303 || resp.status === 307 || ct.includes('csv') || ct.includes('octet')) break;
      // 200 text/html = admin SPA page, not CSV — try next URL
      if (resp.ok && ct.includes('html')) continue;
      break;
    }

    // Toast may redirect to S3 (same pattern as reports) or return CSV directly
    const exportStatus = resp.status;
    const exportLocation = resp.headers.get('location');
    const exportContentType = resp.headers.get('content-type') || '';

    if (resp.status === 302 || resp.status === 301 || resp.status === 303 || resp.status === 307) {
      if (exportLocation) {
        const csvResp = await fetch(exportLocation);
        if (csvResp.ok) {
          const csv = await csvResp.text();
          if (csv && csv.includes('firstName') && csv.length > 100) {
            await env.KV.put('guestbook_csv', csv, { expirationTtl: 7776000 });
            const lineCount = csv.split('\n').length - 1;
            console.log(`[Account] Guestbook refreshed: ${lineCount} guests`);
            return { success: true, guests: lineCount };
          }
          return { success: false, error: 'redirect_csv_invalid', redirect_status: csvResp.status, preview: csv.slice(0, 200) };
        }
        return { success: false, error: 'redirect_fetch_failed', redirect_url: exportLocation, redirect_status: csvResp?.status };
      }
    } else if (resp.ok) {
      const csv = await resp.text();
      if (csv && csv.includes('firstName') && csv.length > 100) {
        await env.KV.put('guestbook_csv', csv, { expirationTtl: 7776000 });
        const lineCount = csv.split('\n').length - 1;
        console.log(`[Account] Guestbook refreshed: ${lineCount} guests`);
        return { success: true, guests: lineCount };
      }
      return { success: false, error: 'export_200_not_csv', content_type: exportContentType, preview: csv.slice(0, 200) };
    }

    // If export didn't work, try the guestbook page and parse for a download link
    const pageUrl = 'https://www.toasttab.com/restaurants/admin/loyalty/guests';
    const pageResp = await fetch(pageUrl, {
      headers: { cookie, 'Accept': 'text/html' },
    });
    if (pageResp.ok) {
      const html = await pageResp.text();
      // Look for CSV download link in the page
      const csvMatch = html.match(/href="([^"]*export[^"]*csv[^"]*)"/i) ||
                       html.match(/href="([^"]*download[^"]*guest[^"]*)"/i);
      if (csvMatch) {
        const csvUrl = csvMatch[1].startsWith('http') ? csvMatch[1] : 'https://www.toasttab.com' + csvMatch[1];
        const csvResp = await fetch(csvUrl, { headers: { cookie } });
        if (csvResp.ok) {
          const csv = await csvResp.text();
          if (csv && csv.includes('firstName') && csv.length > 100) {
            await env.KV.put('guestbook_csv', csv, { expirationTtl: 7776000 });
            const lineCount = csv.split('\n').length - 1;
            console.log(`[Account] Guestbook refreshed via page link: ${lineCount} guests`);
            return { success: true, guests: lineCount };
          }
        }
      }
    }

    console.log('[Account] Guestbook refresh: could not download CSV (cookie may lack access or export is client-side only)');
    return { success: false, error: 'download_failed', tried_url: exportUrl, export_status: exportStatus, export_location: exportLocation, content_type: exportContentType, note: 'Export may be client-side. Use SLICC to POST CSV to /account/guestbook-upload instead.' };
  } catch (err) {
    console.error('[Account] Guestbook refresh error:', err.message);
    return { success: false, error: err.message };
  }
}

// ── TOAST INTERNAL REPORTING API ─────────────────────────────────────────────

function toToastDateFormat(isoDate) {
  // Convert "2026-03-19" → "03-19-2026"
  const [yyyy, mm, dd] = isoDate.split('-');
  return `${mm}-${dd}-${yyyy}`;
}

async function fetchToastReportRaw(reportURL, cookie) {
  // Must use redirect: 'manual' — Toast returns 202 with a Location header
  // pointing to an S3 URL where the report data will appear
  const resp = await fetch(reportURL, {
    headers: { cookie },
    redirect: 'manual',
  });

  // Some endpoints return data directly (200)
  if (resp.status === 200) {
    const body = await resp.text();
    if (body && body.length > 2) return body;
  }

  const location = resp.headers.get('location');
  if (!location) return null;

  // Toast generates the report async — poll the S3 URL until it's ready
  for (let i = 0; i < 5; i++) {
    const r2 = await fetch(location);
    if (r2.status === 200) {
      const body = await r2.text();
      if (body && body.length > 2) return body;
    }
    await sleep(1500);
  }
  return null;
}

async function fetchToastReport(cookie, reportType, toastDate) {
  const isItem = reportType === 'item';
  const endpoint = isItem ? 'menu/toplevelitemselections' : 'menu/modifieritemselections';
  const iColumns = isItem ? 31 : 28;

  // Build the DataTables-style URL — request ALL columns visible so indices stay stable
  let params = `sEcho=1&iColumns=${iColumns}&sColumns=&iDisplayStart=0&iDisplayLength=1000`;
  for (let i = 0; i < iColumns; i++) params += `&mDataProp_${i}=${i}`;
  for (let i = 0; i < iColumns; i++) params += `&sSearch_${i}=`;
  params += '&sSearch=&iSortingCols=1&iSortCol_0=2&sSortDir_0=desc';
  // Set ALL columns visible so returned indices match the original toast-report worker
  for (let i = 0; i < iColumns; i++) params += `&bVisible_${i}=true`;
  params += `&reportDateRange=custom&reportDateStart=${toastDate}&reportDateEnd=${toastDate}`;
  params += '&reportShard=&reportEmployeeId=&rewardsCardsFilter=&reportTimeRange=-2';
  params += '&numberOfRestaurants=1&reportGroupIds=&reportScheduled=&reportSource=';
  params += '&reportServiceArea=&reportService=&reportRevenueCenter=&reportVoided=';
  params += '&reportDiscount=&reportState=&reportDiningOption=&reportTaxExempt=&reportItemTags=';

  const url = `${TOAST_REPORT_BASE}/${endpoint}?${params}`;
  const body = await fetchToastReportRaw(url, cookie);
  if (!body) return null;

  try {
    const json = JSON.parse(body);
    const data = json.aaData;
    // All columns visible, 32 cols per row (item report):
    // [0]=location [1]=orderGUID [2]=orderNum [3]=date [6]=server
    // [10]=service [16]=itemName [18]=category [19]=diningOption
    // [21]=price [23]=totalPrice [24]=quantity
    return data.map((row) => ({
      report: reportType,
      order: row[2],            // order number (e.g. "64")
      date: row[3],             // "3/20/26 8:31 PM"
      id: row[1],               // order GUID
      name: row[16],            // item name
      category: row[18],        // category
      service: row[10] || '',   // service type
      quantity: +row[24],       // quantity
    }));
  } catch {
    return null;
  }
}

async function fetchToastCheckReport(cookie, toastDate) {
  // Order Details report — has tab name (customer name) for online/curbside orders
  // Correct path: /reports/orderdetails (24 columns)
  const iColumns = 24;
  let params = `sEcho=1&iColumns=${iColumns}&sColumns=&iDisplayStart=0&iDisplayLength=1000`;
  for (let i = 0; i < iColumns; i++) params += `&mDataProp_${i}=${i}`;
  for (let i = 0; i < iColumns; i++) params += `&sSearch_${i}=`;
  params += '&sSearch=&iSortingCols=1&iSortCol_0=2&sSortDir_0=desc';
  for (let i = 0; i < iColumns; i++) params += `&bVisible_${i}=true`;
  params += `&reportDateRange=custom&reportDateStart=${toastDate}&reportDateEnd=${toastDate}`;
  params += '&reportShard=&reportEmployeeId=&rewardsCardsFilter=&reportTimeRange=-2';
  params += '&numberOfRestaurants=1&reportGroupIds=&reportScheduled=&reportSource=';
  params += '&reportServiceArea=&reportService=&reportRevenueCenter=&reportVoided=';
  params += '&reportDiscount=&reportState=&reportDiningOption=&reportTaxExempt=&reportItemTags=';

  // Correct path: /reports/orderdetails (NOT /reports/orders/checkdetails)
  const url = `${TOAST_REPORT_BASE}/orderdetails?${params}`;
  const body = await fetchToastReportRaw(url, cookie);
  if (!body) return null;

  try {
    const json = JSON.parse(body);
    const data = json.aaData;
    // Order Details columns (24 cols, all visible):
    // [0]=location [1]=orderGUID [2]=orderNum [3]=checks [4]=date
    // [5]=guests [6]=tabName(customer) [7]=server [8-11]=empty
    // [12]=diningOption [13]=discount [14]=amount [15]=tax [16]=tip
    // [17]=gratuity [18]=total [19]=voided [20]=paid [21]=closed
    // [22]=duration [23]=orderSource
    return data.map((row) => ({
      orderNum: row[2],
      date: row[4],
      customerName: row[6]?.trim() || null,
      diningOption: row[12]?.trim() || null,
      orderSource: row[23]?.trim() || null,
      total: row[18],
      // Customer phone/email not in this report — comes from order detail popup
      customerPhone: null,
      customerEmail: null,
    })).filter(c => c.customerName && c.customerName.length > 1);
  } catch {
    return null;
  }
}

// ── TOAST TSV UPLOAD (nightly SFTP export ingestion) ─────────────────────────

// Price lookup — matches prices.tsv; used to calculate revenue from quantity
const TOAST_PRICES = {
  // Single Pretzels
  'Salty': 6, 'Saint': 6, 'Saint (Cinnamon, Sugar)': 6,
  'BBK - Brush Before Kissing': 7, 'BBK - Brush Before Kissing (Garlic, Parmesan)': 7,
  'BBK (Parmesan, Garlic)': 7,
  'Spicy Bee': 7, 'Spicy Bee (Jalepeno, White Cheddar)': 7,
  'Spicy Bee (Peppers, Cheddar, Hot Honey)': 7,
  "Devil's Delight": 7, "Devil's Delight (Pepperoni, Pepperjack)": 7,
  'Bootlegger': 7, 'Bootlegger (Bourbon Maple Bacon)': 7, 'Bootlegger (Maple Bacon)': 7,
  'Sweet Talker': 7, 'Sweet Talker (Blueberry Basil)': 7,
  'Pumpkin Smash': 7, 'Diabla Fresa': 7,
  'Diabla Fresa (Mango, Tajin, Strawberry-Lime)': 7,
  'Slay Me Sweetly': 7, 'Slay Me Sweetly (Choc, Chips, Oreo, Glitter Topping)': 7,
  'San Diablo': 7,
  // Group Options
  'Half Dozen Pretzels - Assorted': 29, 'Mammoth Pretzel': 29, 'Mammoth Pretzel Bakery Bag': 29,
  // Bombs
  'Salty Bombs': 6, 'Salty Bombs ': 6, 'Salty Bombs - Individual': 6,
  'Salty Bombs (~8 count)': 6, 'Salty Bombs (~7 count)': 6,
  'Saint Bombs': 6, 'Saint Bombs ': 6, 'Saint (cinnamon sugar) Bombs': 6,
  'Saint Bombs (~8 count)': 6, 'Saint Bombs (~7 count)': 6,
  'For the Kids': 7,
  'BBK (Parm) Bombs - Individual': 7,
  'Sweet Talker (Blueberry Basil) Bombs': 7,
  'Spicy Bee (hot pepper) Bombs - Individual': 7,
  "Devil's Delight (pizza) Bombs - Individual": 7,
  'Party Bomb (Serves 3)': 16, 'Party Pretzel Bombs': 16,
  // Dips
  'Dangerous Dip': 2, 'Dangerous Dip (House Cheese)': 2, 'Dangerous Dip (Single)': 2,
  'Dangerous Dip (small 10 count)': 2,
  'House Mustard': 2, 'House Mustard (Single)': 2,
  'Honey Mustard': 2, 'Honey Mustard (Single)': 2,
  'Hot Ranch': 2, 'Hot Ranch (Buffalo Ranch)': 2, 'Hot Ranch (Single)': 2,
  'Sweet Cream': 2, 'Sweet Cream (Single)': 2,
  'Marinara': 2, 'Marinara (Single)': 2,
  // Combos
  'Pretzel Combo - Pretzel, Dip & Drink': 10, 'Bombs Combo - Bombs, Dips, Drink': 10,
  // Drinks — Non-Alcoholic
  '16oz Fountain Drink': 2, '24oz Fountain Drink': 3,
  'Canned Soda': 2, '12oz Canned Soda': 2,
  'Coke': 2, 'Diet Coke': 2, 'Coke Zero': 2, 'Sprite': 2,
  'Dr. Pepper': 2, 'Diet Dr. Pepper': 2, 'Minute Maid Lemonade': 2, 'Fresca': 2,
  'Bottled Soda': 3, '16.9oz Bottled Soda': 3,
  'Bottled Water': 2, 'Smart Water (20oz bottle)': 3,
  "Brigham's Brew Root Beer": 3, 'Brighams Brew Root Beer': 3,
  "Han's Kombucha - Ginger Hibiscus": 6,
  'Athletic Hazy IPA': 5, 'Athletic Golden Dawn Ale': 5,
  // Drinks — Beer & Cider
  'Kiitos Amber Ale': 7, 'Kiitos Amber Ale Draft (16 oz pint)': 7,
  'Offset Dopo IPA': 8, 'Offset Dopo IPA Draft (16 oz pint)': 8,
  'Uinta Was Angeles': 7, 'Templin Family Helles': 7,
  'Bohemian Sir-Veza': 7, 'Bohemian Sir-Veza Mexican Lager Draft (16 oz pint)': 7,
  'Second Summit Spiced Peach Cider': 9,
  'Sierra Nevada Pale Ale Draft (16oz pint)': 7,
  'UTOG Son of a Peach Draft (16oz pint)': 7,
  'Pacifico Draft (16oz pint)': 7,
  'Fisher Beer Pilsner': 8, 'Fisher Beer Cerveza': 8,
  'Templin Wicked Sea Party Hazy': 9, 'Templin Lingonberry Sour': 9,
  'Second Summit Cider': 10, 'Second Summit Cider (16oz can)': 10,
  'House Wine Rose Bubbles': 10,
  "Not Your Father's Root Beer": 8, "Not Your Father's Root Beer (12 oz bottle)": 8,
  "Not Your Father's Root Beer (12oz bottle)": 8,
  // Drink name variants found in historical TSVs
  'Soda': 2, 'Coca-Cola (12 oz can)': 2, 'Coca-Cola (16.9oz bottle)': 3,
  'Coca-Cola Zero (12 oz can)': 2, 'Coke (20 oz bottle)': 3, 'Coke (20oz bottle)': 3,
  'Coke Zero (16.9oz bottle)': 3, 'Coke Zero (20oz bottle)': 3,
  'Diet Coke (12 oz can)': 2, 'Diet Coke (16.9oz bottle)': 3,
  'Sprite (12 oz can)': 2, 'Sprite (16.9oz bottle)': 3, 'Sprite (20oz bottle)': 3,
  'Dr. Pepper (12 oz can)': 2,
  '12oz Fountain Drink': 2,
  'Kiitos Amber Ale Draft (16oz pint)': 7,
  'Bohemian Sir-Veza Mexican Lager Draft (16 oz pint)': 7,
  'Bohemian Sir-Veza Mexican Lager Draft (16oz pint)': 7,
  'Templin Family Helles Draft (16 oz pint)': 7, 'Templin Family Helles Draft (16oz pint)': 7,
  'Offset Dopo IPA Draft (16 oz pint)': 8,
  'Uinta Was Angeles American Lager Draft (16oz pint)': 7,
  'Fisher Brewing Cerveza (16oz can)': 8, 'Fisher Brewing Pilsner (16oz can)': 8,
  'Second Summit Spiced Peach Cider (14 oz draft)': 9,
  'Second Summit Spiced Peach Cider (14oz draft)': 9,
  'Second Summit Spiced Peach Cider Draft (14oz)': 9,
  'Second Summit Off-Dry Cider': 10,
  'Second Summit Oktoberfest Cider Draft (14oz Draft)': 9,
  'T.F. Wicked Sea Party Hazy IPA (16 oz can)': 9, 'T.F. Wicked Sea Party Hazy IPA (16oz can)': 9,
  'T.F. Lingonberry Sour (16 oz can)': 9, 'T.F. Lingonberry Sour (16oz can)': 9,
  'T.F. Watermelon Gose Sour (16 oz can)': 9,
  'UTOG Son of a Peach (16oz pint)': 7, 'UTOG Son of a Peach Draft (16oz pint)': 7,
  'Pacifico': 7, 'Pacifico Draft (16oz pint)': 7,
  'Uinta Golden Spike': 7,
  'Shades Foggy Goggle Winter Lager (16 oz pint)': 7,
  'Shades Foggy Goggle Winter Lager Draft (16 oz pint)': 7,
  'Violet Fire New Style Lager Draft (16 oz pint)': 7,
  'Yacht Rock Juicy IPA': 8, 'Yacht Rock Juicy IPA Draft (16oz pint)': 8,
  'Roadhouse Plasma Hazy IPA': 8, 'Roadhouse Plasma Hazy IPA (16oz can)': 8,
  '2 Row Farmhouse Ale (16 oz can)': 8, '2 Row Farmhouse Ale (16oz can)': 8,
  'Canned Beer': 8,
  'Athletic Free Wave IPA NA': 5, 'Athletic Upside Dawn Golden Ale NA': 5,
  'RoHa Hop Drop Sparkling Water': 3,
  'smartwater, 20oz Bottle': 3, 'Smart Water (20 oz Bottle)': 3,
  // Seasonal pretzels
  'Winter Wonderland': 7, 'Winter Wonderland (Hot Cocoa)': 7,
  'Pump That Spice': 7, 'Pump that Spice (pumpkin)': 7,
  'Pumpkin Smash (Pumpkin, Chocolate Chip, Spiced Brown Butter Glaze)': 7,
  'Sweet Talker (Blueberry, Basil)': 7, 'Sweet Talker Not Saint': 7,
  'Chocolate Cream': 7,
  "Devil's Delight (Pepperoni, Mozzarella)": 7,
  'Saint (Cinnamon Sugar)': 6,
  'For the Kids (Fruity Pebbles)': 7, 'All For the Kids (Fruity Pebbles)': 7,
  'All Saint (Cinnamon, Sugar)': 6, 'All Salty': 6,
  'SALTY': 6, 'Salty (~8 count)': 6,
  // Catering / bulk items
  'BBK (6 count)': 29, 'BBK (Parmesan Garlic,6 count)': 29,
  'BBK Tray (Parmesan Garlic, Serves 10)': 50, 'BBK - 10oz': 7,
  'Salt (6 count)': 29, 'Salt Tray (Serves 10)': 50, 'Saint (6 count)': 29,
  'Saint (Cinnamon Sugar, 6 count)': 29, 'Saint Tray (Cinnamon Sugar, Serves 10)': 50,
  'Spicy Bee (6 count)': 29, 'Spicy Bee (Pepper and Cheddar) 6 count)': 29,
  'Spicy Bee Tray (Pepper and Cheddar, Serves 10)': 50,
  'Bootlegger (6 count)': 29, 'Bootlegger (Maple Bacon, 6 count)': 29,
  'Bootlegger Tray (Maple Bacon, Serves 10)': 50,
  'Sweet Talker (Blueberry Basil, 6 count)': 29,
  'Winter Wonderland (6 count)': 29,
  "Devils Delight (Salami and Cheese, 6 count)": 29,
  'Danger by the 1/2 Dozen': 29,
  'Party Bomb (Serves 5 - 7)': 29,
  // Bomb trays / bulk
  'Saint Bombs (Cinnamon Sugar, serves 6)': 16,
  'Salty Bombs (serves 6)': 16,
  'Saint (cinnamon) Bombs: 108 count (18-27 servings)': 90,
  'Salty Bombs: 108 count (18-27 servings)': 90,
  'BBK (parmesan) Bombs: 108 count (18-27 servings)': 90,
  'Spicy Bee (hot pepper) Bombs: 108 count (18-27 servings)': 90,
  'Sweet Talker (blueberry) Bombs: 108 count (18-27 servings)': 90,
  'Salty Bombs Tray (serves 10))': 50, 'Saint Bombs Tray (Cinnamon Sugar, serves 10)': 50,
  'BBK Bombs Tray (Parmesan Garlic, serves 10)': 50,
  'Spicy Bee Bombs Tray (Hot Pepper + Cheddar, serves 10)': 50,
  'Bootlegger Bombs Tray (Maple Bacon, serves 10)': 50,
  'Sweet Talker Bombs Tray (Blueberry Basil, serves 10)': 50,
  '3 Sheets of BBK Bombs': 48, '3 Sheets of Salty Bombs': 48,
  '3 Sheets of Spicy Bee Bombs': 48,
  'Pretzel Minis Box (10 pretzels, 4 dips)': 40,
  'Pretzel Minis - Box of 10': 40,
  // Dip variants
  'DANGEROUS DIP': 2, 'DANGEROUSBDIP': 2,
  'Dangerous Dip (10 count)': 16, 'Dangerous Dip (6 count)': 10,
  'Dangerous Dip - Mammoth Pretzel': 2,
  'Sweet Cream (10 count)': 16, 'Sweet Cream (6 count)': 10,
  'Sweet Cream (small 10 count)': 2, 'Sweet Cream - Mammoth Pretzel': 2,
  '100 Mini Dangerous Dips': 50,
  'Hot Ranch (Single)': 2,
  // Merch
  'DPC Hat': 25, 'Dangerous Glass': 10, 'Dangerous Shirt': 25,
  'Shirt': 25, 'Shirtt': 25, 'Sticker': 2,
  // Combos (HTML entity variant)
  'Pretzel Combo - Pretzel, Dip &amp; Drink': 10,
};

// Categories that represent actual pretzel/food revenue (not gift cards)
const PRETZEL_CATEGORIES = new Set([
  'Single Pretzels', 'Group Options', 'Bombs', 'Dips', 'Combos',
  'Drinks - Non-Alcoholic', 'Drinks - Beer & Cider',
  // Catering categories from the SKU averages script
  'Flavors (1/2 Dozen)', 'Flavors (Party Bomb)', 'Pretzel Boxes',
  'Bombs (Single Serving)',
]);

function parseToastDate(dateStr) {
  // Toast format: "2/1/26 6:12 PM" or "2/1/26 6:12:30 PM"
  if (!dateStr) return null;
  const s = dateStr.trim();
  // Try MM/DD/YY h:mm AM/PM
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return null;
  let [, month, day, year, hour, min, sec, ampm] = m;
  hour = parseInt(hour);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
  const fullYear = 2000 + parseInt(year);
  return new Date(fullYear, parseInt(month) - 1, parseInt(day), hour, parseInt(min), parseInt(sec || 0));
}

async function handleToastTSVUpload(request, env) {
  try {
    const tsv = await request.text();
    if (!tsv || tsv.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Empty body' }), { status: 400 });
    }
    const result = await parseAndIngestToastTSV(tsv, env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

async function parseAndIngestToastTSV(tsv, env) {
  const lines = tsv.split('\n');
  if (lines.length < 2) return { error: 'No data rows', orders: 0 };

  // Parse header
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const idx = {};
  for (const col of ['date', 'category', 'id', 'name', 'order', 'quantity', 'service']) {
    idx[col] = headers.indexOf(col);
    if (idx[col] === -1 && col === 'order') idx[col] = headers.indexOf('order #');
  }

  // Group line items by order number
  const orderMap = new Map();  // order# → { items[], date, service }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split('\t');

    const orderNum = cols[idx.order]?.trim();
    const itemName = cols[idx.name]?.trim();
    const category = cols[idx.category]?.trim();
    const quantity = parseInt(cols[idx.quantity]?.trim()) || 0;
    const dateStr = cols[idx.date]?.trim();
    const service = cols[idx.service]?.trim() || '';

    if (!orderNum || !itemName || quantity <= 0) continue;

    // Skip gift cards, non-product items (names, notes, labels)
    if (category === 'Other' || itemName === 'Gift Card' || itemName === 'eGift Card') continue;
    if (itemName === 'Add Value ($)') continue;
    if (itemName.startsWith('(Please label')) continue;
    if (!category || category === 'report') continue;

    if (!orderMap.has(orderNum)) {
      orderMap.set(orderNum, { items: [], date: dateStr, service });
    }
    orderMap.get(orderNum).items.push({ name: itemName, category, quantity });
  }

  // Write orders to D1
  let inserted = 0;
  let skipped = 0;
  let totalRevenue = 0;
  let unmatchedItems = new Set();

  for (const [orderNum, order] of orderMap) {
    const dt = parseToastDate(order.date);
    if (!dt) { skipped++; continue; }
    const isoDate = dt.toISOString();

    // Calculate revenue from line items
    let orderRevenue = 0;
    for (const item of order.items) {
      const price = TOAST_PRICES[item.name] ?? TOAST_PRICES[item.name.trim()];
      if (price !== undefined) {
        orderRevenue += price * item.quantity;
      } else {
        unmatchedItems.add(item.name);
        // Fallback: estimate from category
        if (item.category === 'Single Pretzels') orderRevenue += 7 * item.quantity;
        else if (item.category === 'Bombs') orderRevenue += 6 * item.quantity;
        else if (item.category === 'Dips') orderRevenue += 2 * item.quantity;
      }
    }

    // Include date in ID to avoid collisions across months (order #55 in Jan vs Feb)
    const dateKey = isoDate.slice(0, 10).replace(/-/g, '');
    const orderId = `toast_tsv_${dateKey}_${orderNum}`;

    try {
      await env.DB.prepare(`
        INSERT OR IGNORE INTO orders (
          id, account_id, venue_id, source, order_date,
          gross_revenue, customer_phone, raw_payload, created_at
        ) VALUES (?, NULL, NULL, 'toast_tsv', ?, ?, NULL, ?, datetime('now'))
      `).bind(
        orderId,
        isoDate,
        orderRevenue,
        JSON.stringify({ order_num: orderNum, items: order.items, service: order.service })
      ).run();
      inserted++;
      totalRevenue += orderRevenue;
    } catch (err) {
      // Duplicate or DB error — skip
      skipped++;
    }
  }

  return {
    orders_parsed: orderMap.size,
    orders_inserted: inserted,
    orders_skipped: skipped,
    total_revenue: Math.round(totalRevenue * 100) / 100,
    unmatched_items: [...unmatchedItems].slice(0, 20),
    date_range: orderMap.size > 0
      ? `${[...orderMap.values()][0].date} – ${[...orderMap.values()].pop().date}`
      : null,
  };
}

async function getToastStats(env) {
  const [totals, byMonth, recent] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) as total_orders,
             SUM(gross_revenue) as total_revenue,
             MIN(order_date) as earliest,
             MAX(order_date) as latest
      FROM orders WHERE source IN ('toast_tsv', 'toast_live')
    `).first(),
    env.DB.prepare(`
      SELECT strftime('%Y-%m', order_date) as month,
             COUNT(*) as orders,
             ROUND(SUM(gross_revenue), 2) as revenue
      FROM orders WHERE source IN ('toast_tsv', 'toast_live')
      GROUP BY month ORDER BY month DESC LIMIT 6
    `).all(),
    env.DB.prepare(`
      SELECT id, order_date, gross_revenue
      FROM orders WHERE source IN ('toast_tsv', 'toast_live')
      ORDER BY order_date DESC LIMIT 5
    `).all(),
  ]);

  return new Response(JSON.stringify({
    totals,
    by_month: byMonth.results,
    recent_orders: recent.results,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

// ── TOAST CHECK DETAILS CSV (customer name/phone/email) ──────────────────────

async function handleToastCheckDetails(request, env) {
  try {
    const csv = await request.text();
    if (!csv || csv.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Empty body' }), { status: 400 });
    }
    const result = await parseAndIngestCheckDetails(csv, env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

async function parseAndIngestCheckDetails(csv, env) {
  const lines = csv.split('\n');
  if (lines.length < 2) return { error: 'No data rows', updated: 0 };

  // Parse CSV header — Toast uses comma-separated with possible quoted fields
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const col = {};
  for (const name of ['customer id', 'customer', 'customer phone', 'customer email',
                       'check id', 'check #', 'opened date', 'opened time', 'total']) {
    col[name] = headers.indexOf(name);
  }

  let updated = 0;
  let skipped = 0;
  let customersFound = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);

    const customerName = fields[col['customer']]?.trim() || null;
    const customerPhone = fields[col['customer phone']]?.trim() || null;
    const customerEmail = fields[col['customer email']]?.trim() || null;
    const checkNum = fields[col['check #']]?.trim();
    const openedDate = fields[col['opened date']]?.trim();
    const total = parseFloat(fields[col['total']]?.replace(/[$,]/g, '') || '0');

    // Skip rows with no customer info
    if (!customerName && !customerPhone && !customerEmail) {
      skipped++;
      continue;
    }
    customersFound++;

    // Try to match this check to an existing order by check/order number + date
    if (checkNum && openedDate) {
      // Parse date to match our order ID format
      const dt = parseCheckDate(openedDate);
      if (dt) {
        const dateKey = dt.toISOString().slice(0, 10).replace(/-/g, '');
        // Try both TSV and live order ID patterns
        const patterns = [
          `toast_tsv_${dateKey}_${checkNum}`,
          `toast_live_${dateKey}_${checkNum}`,
        ];

        for (const orderId of patterns) {
          try {
            const result = await env.DB.prepare(`
              UPDATE orders
              SET customer_name = COALESCE(?, customer_name),
                  customer_phone = COALESCE(?, customer_phone),
                  customer_email = COALESCE(?, customer_email)
              WHERE id = ?
            `).bind(customerName, customerPhone, customerEmail, orderId).run();

            if (result.meta?.changes > 0) {
              updated++;
              break;
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  return {
    rows_parsed: lines.length - 1,
    customers_found: customersFound,
    orders_updated: updated,
    rows_skipped: skipped,
  };
}

function parseCheckDate(dateStr) {
  // Toast CheckDetails date format: "MM/DD/YYYY" or "M/D/YYYY"
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const [month, day, year] = parts.map(Number);
  const fullYear = year < 100 ? 2000 + year : year;
  return new Date(fullYear, month - 1, day);
}

function parseCSVLine(line) {
  // Simple CSV parser that handles quoted fields with commas
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── TOAST ORDER DETAILS CSV (real revenue totals) ────────────────────────────

async function handleToastOrderDetails(request, env) {
  try {
    const csv = await request.text();
    if (!csv || csv.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Empty body' }), { status: 400 });
    }
    const result = await parseAndIngestOrderDetails(csv, env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

async function parseAndIngestOrderDetails(csv, env) {
  const lines = csv.split('\n');
  if (lines.length < 2) return { error: 'No data rows', updated: 0 };

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const col = {};
  for (const name of ['order id', 'order #', 'opened', 'amount', 'tax', 'tip',
                       'total', '# of guests', 'tab names', 'service',
                       'dining options', 'server']) {
    col[name] = headers.indexOf(name);
  }

  let updated = 0;
  let inserted = 0;
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = parseCSVLine(line);

    const orderNum = fields[col['order #']]?.trim();
    const opened = fields[col['opened']]?.trim();
    const amount = parseFloat(fields[col['amount']]?.replace(/[$,]/g, '') || '0');
    const tax = parseFloat(fields[col['tax']]?.replace(/[$,]/g, '') || '0');
    const tip = parseFloat(fields[col['tip']]?.replace(/[$,]/g, '') || '0');
    const total = parseFloat(fields[col['total']]?.replace(/[$,]/g, '') || '0');
    const guests = parseInt(fields[col['# of guests']]?.trim() || '0');
    const tabNames = fields[col['tab names']]?.trim() || null;
    const service = fields[col['service']]?.trim() || '';
    const diningOptions = fields[col['dining options']]?.trim() || '';
    const server = fields[col['server']]?.trim() || '';

    if (!orderNum || !opened) { skipped++; continue; }

    const dt = parseToastDate(opened) || parseCheckDate(opened);
    if (!dt) { skipped++; continue; }

    const isoDate = dt.toISOString();
    const dateKey = isoDate.slice(0, 10).replace(/-/g, '');

    // Try to update existing order with real revenue data
    const tsvId = `toast_tsv_${dateKey}_${orderNum}`;
    const liveId = `toast_live_${dateKey}_${orderNum}`;

    let matched = false;
    for (const orderId of [tsvId, liveId]) {
      try {
        const result = await env.DB.prepare(`
          UPDATE orders
          SET gross_revenue = ?,
              net_revenue = ?,
              units = ?,
              customer_name = COALESCE(?, customer_name),
              raw_payload = json_patch(COALESCE(raw_payload, '{}'), ?)
          WHERE id = ?
        `).bind(
          amount,              // gross_revenue = pre-tax amount
          amount - tax,        // net_revenue = after tax
          guests,              // units = guest count
          tabNames,            // customer_name from tab
          JSON.stringify({
            toast_total: total, toast_tip: tip, toast_tax: tax,
            service, dining_options: diningOptions, server,
          }),
          orderId
        ).run();

        if (result.meta?.changes > 0) {
          updated++;
          matched = true;
          break;
        }
      } catch { /* skip */ }
    }

    // If no existing order found, insert a new one
    if (!matched) {
      const orderId = `toast_order_${dateKey}_${orderNum}`;
      try {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO orders (
            id, account_id, venue_id, source, order_date,
            gross_revenue, net_revenue, units, customer_name,
            raw_payload, created_at
          ) VALUES (?, NULL, NULL, 'toast_order', ?, ?, ?, ?, ?, ?, datetime('now'))
        `).bind(
          orderId, isoDate, amount, amount - tax, guests, tabNames,
          JSON.stringify({
            order_num: orderNum, toast_total: total, toast_tip: tip, toast_tax: tax,
            service, dining_options: diningOptions, server,
          })
        ).run();
        inserted++;
      } catch { skipped++; }
    }
  }

  return {
    rows_parsed: lines.length - 1,
    orders_updated: updated,
    orders_inserted: inserted,
    rows_skipped: skipped,
  };
}

// ── CUSTOMER LIST ────────────────────────────────────────────────────────────

async function getCustomerList(env) {
  const customers = await env.DB.prepare(`
    SELECT
      customer_name, customer_phone, customer_email,
      COUNT(*) as order_count,
      ROUND(SUM(gross_revenue), 2) as total_spent,
      MAX(order_date) as last_order,
      MIN(order_date) as first_order
    FROM orders
    WHERE customer_name IS NOT NULL
       OR customer_phone IS NOT NULL
       OR customer_email IS NOT NULL
    GROUP BY COALESCE(customer_email, customer_phone, customer_name)
    ORDER BY total_spent DESC
    LIMIT 200
  `).all();

  return new Response(JSON.stringify({
    total_customers: customers.results?.length || 0,
    customers: customers.results || [],
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

// ── TOAST GUESTBOOK CSV (enriches orders with phone/email) ──────────────────

async function handleGuestbookUpload(request, env) {
  try {
    const csv = await request.text();
    if (!csv || csv.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Empty body' }), { status: 400 });
    }

    // Cache the guestbook CSV in KV for daily re-enrichment (90 day TTL)
    await env.KV.put('guestbook_csv', csv, { expirationTtl: 7776000 });

    const lines = csv.split('\n');
    if (lines.length < 2) return new Response(JSON.stringify({ error: 'No data' }), { status: 400 });

    const headers = parseCSVLine(lines[0]).map(h => h.trim());
    const col = {};
    for (const name of ['email1', 'phone1', 'firstName', 'lastName', 'guestGuid',
                         'totalVisits', 'lifetimeSpend', 'lastVisitDate', 'firstVisitDate']) {
      col[name] = headers.indexOf(name);
    }

    // Build a lookup of guests by name (for matching to order tab names)
    let enriched = 0;
    let guestsWithContact = 0;
    let guestsParsed = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = parseCSVLine(line);
      guestsParsed++;

      const email = col.email1 >= 0 ? fields[col.email1]?.trim() : null;
      const phone = col.phone1 >= 0 ? fields[col.phone1]?.trim() : null;
      const firstName = col.firstName >= 0 ? fields[col.firstName]?.trim() : null;
      const lastName = col.lastName >= 0 ? fields[col.lastName]?.trim() : null;

      if (!email && !phone) continue;
      guestsWithContact++;

      // Build full name for matching
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
      if (!fullName) continue;

      // Match orders by full name only — no first-name matching (causes false positives)
      // The guestbook is the source of truth for review requests (via lastVisitDate),
      // so order enrichment is secondary — only enrich when we have a confident full-name match
      try {
        if (!firstName || !lastName) continue; // Skip guests without full names
        const result = await env.DB.prepare(`
          UPDATE orders
          SET customer_phone = COALESCE(?, customer_phone),
              customer_email = COALESCE(?, customer_email)
          WHERE customer_name = ? AND (customer_phone IS NULL OR customer_email IS NULL)
        `).bind(phone || null, email || null, fullName).run();

        // DO NOT try first-name-only matching — causes wrong phone numbers
        if (false) {
          const r2 = await env.DB.prepare(`
            UPDATE orders
            SET customer_phone = COALESCE(?, customer_phone),
                customer_email = COALESCE(?, customer_email)
            WHERE customer_name = ? AND (customer_phone IS NULL OR customer_email IS NULL)
          `).bind(phone || null, email || null, firstName).run();
          if (r2.meta?.changes > 0) enriched += r2.meta.changes;
        } else if (result.meta?.changes > 0) {
          enriched += result.meta.changes;
        }
      } catch { /* skip */ }
    }

    return new Response(JSON.stringify({
      guests_parsed: guestsParsed,
      guests_with_contact: guestsWithContact,
      orders_enriched: enriched,
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// ── NOTIFICATIONS ────────────────────────────────────────────────────────────

async function getNotifications(env) {
  // Check all notification keys in KV
  const notifications = [];
  const keys = ['notification:cookie_expired', 'notification:sync_error', 'notification:review_error', 'notification:inbound_lead'];
  for (const key of keys) {
    const val = await env.KV.get(key);
    if (val) {
      try { notifications.push(JSON.parse(val)); } catch { /* skip */ }
    }
  }

  return new Response(JSON.stringify({
    count: notifications.length,
    notifications,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } });
}

async function handleLeadCapture(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { venue_name, contact_name, email, phone, venue_type, city, notes } = body;
  if (!venue_name || !email) {
    return new Response(JSON.stringify({ error: 'venue_name and email required' }), { status: 400 });
  }

  // Map form venue_type to venues.category
  const categoryMap = {
    'Amphitheater / Outdoor Concert': 'other',
    'Ski Resort / Mountain Resort': 'ski_resort',
    'Brewery / Taproom': 'brewery',
    'Stadium / Arena': 'stadium',
    'Event Venue / Banquet Hall': 'event_venue',
    'Hotel / Bar': 'hotel_bar',
    'Golf Club / Country Club': 'golf',
    'Festival / Fairgrounds': 'other',
    'Other Venue': 'other',
  };
  const category = categoryMap[venue_type] || 'other';

  const id = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await env.DB.prepare(`
    INSERT INTO venues (id, name, category, contact_name, contact_email, contact_phone, city, notes, status, campaign, tier, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'inbound', 'website', 1, datetime('now'))
  `).bind(id, venue_name, category, contact_name || null, email, phone || null, city || null, notes || null).run();

  // KV notification for Drew dashboard
  await env.KV.put('notification:inbound_lead', JSON.stringify({
    type: 'inbound_lead',
    title: `New inbound lead: ${venue_name}`,
    message: `${contact_name || 'Unknown'} from ${venue_name} (${city || 'Unknown location'}) submitted the pretzel program form. Email: ${email}`,
    created_at: new Date().toISOString(),
  }), { expirationTtl: 604800 }); // 7 days

  // Alert Drew immediately via email
  const drewAlertBody = [
    `🥨 New inbound lead from the pretzel program page!`,
    '',
    `Venue: ${venue_name}`,
    `Contact: ${contact_name || '(no name)'}`,
    `Email: ${email}`,
    `Phone: ${phone || '(none)'}`,
    `Type: ${venue_type || '(not specified)'}`,
    `City: ${city || '(not specified)'}`,
    `Notes: ${notes || '(none)'}`,
    '',
    'They came to you — reply fast.',
    '',
    `Drew's cell: 801.916.9122`,
  ].join('\n');

  await sendGmailFromDrew(env, {
    to: env.DREW_EMAIL,
    subject: `🥨 New lead: ${venue_name} (${city || venue_type || 'website form'})`,
    body: drewAlertBody,
  }).catch(e => console.error('[LeadCapture] Alert email failed:', e.message));

  // Auto-respond to the lead immediately
  const firstName = (contact_name || '').split(' ')[0] || 'there';
  const autoReplyBody = [
    `${firstName} —`,
    '',
    `Thanks for reaching out about the Dangerous Pretzel program. Got your info.`,
    '',
    `I'll follow up personally within 24 hours — or feel free to call or text me directly at 801.916.9122.`,
    '',
    `— Drew`,
    `Dangerous Pretzel Co`,
    `dangerouspretzel.com`,
  ].join('\n');

  await sendGmailFromDrew(env, {
    to: email,
    subject: `Re: Pretzel program for ${venue_name}`,
    body: autoReplyBody,
  }).catch(e => console.error('[LeadCapture] Auto-reply failed:', e.message));

  return new Response(JSON.stringify({ ok: true, id }), { headers: { 'Content-Type': 'application/json' } });
}

// ── GMAIL SENDER (for account-worker alerts) ─────────────────────────────────
async function sendGmailFromDrew(env, { to, subject, body }) {
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
  // RFC 2047 encode subject when it contains non-ASCII
  const encSubj = /^[\x00-\x7F]*$/.test(subject) ? subject : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`;
  const message = [
    `To: ${to}`,
    `From: Drew @ Dangerous Pretzel <${env.FROM_EMAIL}>`,
    `Subject: ${encSubj}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  const bytes = new TextEncoder().encode(message);
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  return resp.json();
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
async function getAccountHealth(env) {
  const accounts = await env.DB.prepare(`
    SELECT v.name, v.category, aa.health_status, aa.churn_risk,
           aa.last_order_date, aa.avg_monthly_rev, aa.total_rev_lifetime,
           aa.fulfilled_by, aa.account_rep,
           CAST(julianday('now') - julianday(aa.last_order_date) AS INTEGER) as days_since_order
    FROM active_accounts aa
    JOIN venues v ON v.id = aa.venue_id
    WHERE aa.warmer_removed_at IS NULL
    ORDER BY aa.health_status ASC, aa.churn_risk DESC
  `).all();

  return new Response(JSON.stringify(accounts.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getCustomerPhone(customerId, env) {
  if (!customerId) return null;
  try {
    const response = await fetch(
      `https://connect.squareup.com/v2/customers/${customerId}`,
      { headers: { 'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}` } }
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data.customer?.phone_number || null;
  } catch { return null; }
}

async function verifySquareSignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return signature === expected;
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

  // RFC 2047 encode subject when it contains non-ASCII
  const encSubj2 = /^[\x00-\x7F]*$/.test(subject) ? subject : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`;
  const message = [
    `To: ${to}`,
    `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${encSubj2}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const bytes = new TextEncoder().encode(message);
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const payload = { raw: encoded };
  if (threadId) payload.threadId = threadId;

  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Coach Voice / Redraft ─────────────────────────────────────────────────────

/**
 * Load all pending outreach emails, redraft each with Claude using Drew's feedback,
 * and persist the updated subject, body, and self_score back to outreach_logs.
 *
 * @param {object} env  - Cloudflare Worker env bindings
 * @param {string} feedback - Drew's coaching note
 * @returns {{ redrafted: number, emails: Array }}
 */
async function redraftPendingEmails(env, feedback) {
  // Load pending emails joined with venue info
  const { results: pending } = await env.DB.prepare(`
    SELECT o.id, o.subject, o.body, v.name AS venue_name, v.category
    FROM outreach_logs o
    JOIN venues v ON v.id = o.venue_id
    WHERE o.approval_status = 'pending'
    ORDER BY o.created_at DESC
  `).all();

  if (!pending || pending.length === 0) {
    return { redrafted: 0, emails: [] };
  }

  const summaries = [];

  for (const email of pending) {
    const prompt = `You are redrafting a venue outreach email for Dangerous Pretzel Co based on Drew's coaching feedback.

DREW'S FEEDBACK: ${feedback}

ORIGINAL EMAIL:
Subject: ${email.subject}
Body: ${email.body}

VENUE: ${email.venue_name} (${email.category || 'venue'})

VOICE RULES (non-negotiable):
- Tone: friendly, casual, local. We're a local SLC company talking to someone at a nearby venue.
- The whole pitch in one sentence: we make really great unique pretzels that people at this type of venue would absolutely love — talk about and come back for — and we've made it super easy to offer them.
- The ASK is simply: "could I bring some pretzels by for the team to try?" Nothing more formal than that.
- Lead with what their crowd/guests would experience, not what we supply operationally
- Social proof: already at Sandy Amphitheater, Delta Center, Powder Mountain — weave in naturally, don't list
- DO NOT say "warmer model", "one warmer, one night", "trial run" — too transactional/mechanical
- DO NOT say "if they don't love it we pick up the warmer" — defensive
- DO NOT describe mechanics (warmer size, fridge storage) — second conversation
- Subject line: "[Venue] + pretzels?" is the default. Use it unless you have a sharper specific hook.
- End with a P.S. line AFTER the sign-off: "P.S. See how other venues are running it: https://program.dangerouspretzel.com/pretzel-program"
- Keep the main body under 130 words (P.S. is separate). Sign off: "— Drew"

Return JSON: {"subject": "...", "body": "...", "self_score": 8, "reasoning": "..."}`;

    try {
      // DIF-3 (May 13 2026): wired through ai-budget
      const result = await callAI(env, {
        use_case: 'monday_digest_curation',
        model: 'sonnet',
        caller: 'account-worker.js',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });

      if (!result.ok) {
        console.error(`[CoachVoice] Claude error for log ${email.id}: ${result.blocked_reason || result.error}`);
        continue;
      }

      const text = result.content || '';
      const clean = text.replace(/```json\n?|\n?```/g, '').trim();
      const redraft = JSON.parse(clean);

      // Persist updated fields to outreach_logs
      await env.DB.prepare(`
        UPDATE outreach_logs
        SET subject = ?, body = ?, self_score = ?, notes = 'voice-coached'
        WHERE id = ?
      `).bind(redraft.subject, redraft.body, redraft.self_score ?? null, email.id).run();

      summaries.push({
        id: email.id,
        venue: email.venue_name,
        old_subject: email.subject,
        new_subject: redraft.subject,
      });
    } catch (err) {
      console.error(`[CoachVoice] Failed to redraft log ${email.id}:`, err.message);
    }
  }

  return { redrafted: summaries.length, emails: summaries };
}

// ── Voice Embedding Handlers (Vectorize + Workers AI bge-large-en-v1.5) ───────

/**
 * Embed a single outreach_log entry and upsert into Vectorize.
 * POST /account/voice-embed
 * Body: { log_id } or { subject, body, venue_name, category, self_score }
 */
async function handleVoiceEmbed(request, env) {
  if (!env.VECTORIZE || !env.AI) {
    return new Response(JSON.stringify({ error: 'VECTORIZE or AI binding missing' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const input = await request.json();
    let subject, body, venueName, category, selfScore, logId;

    // If body+subject provided directly → use them (manual embed, e.g. gold standard emails)
    // If only log_id provided → look up from D1
    if (input.log_id && !input.body) {
      const row = await env.DB.prepare(`
        SELECT o.id, o.subject, o.body, o.self_score, v.name as venue_name, v.category
        FROM outreach_logs o JOIN venues v ON v.id = o.venue_id
        WHERE o.id = ? AND o.approval_status = 'approved'
      `).bind(input.log_id).first();
      if (!row) return new Response(JSON.stringify({ error: 'Log not found or not approved' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      ({ id: logId, subject, body, self_score: selfScore, venue_name: venueName, category } = row);
    } else {
      ({ subject, body, venue_name: venueName, category, self_score: selfScore } = input);
      logId = input.log_id || `manual_${Date.now()}`;
    }

    const textToEmbed = `Subject: ${subject}\n\nVenue type: ${category || 'unknown'}\n\n${body}`;
    const embResult = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [textToEmbed] });
    const vector = embResult?.data?.[0];
    if (!vector || !Array.isArray(vector)) {
      return new Response(JSON.stringify({ error: 'Embedding failed', raw: embResult }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    await env.VECTORIZE.upsert([{
      id: String(logId),
      values: vector,
      metadata: {
        subject: (subject || '').slice(0, 200),
        body_preview: (body || '').slice(0, 500),
        venue_name: venueName || '',
        category: category || '',
        self_score: selfScore || 0,
      },
    }]);

    return new Response(JSON.stringify({ embedded: true, log_id: logId, dims: vector.length }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

/**
 * Batch embed recent approved emails from outreach_logs.
 * GET /account/voice-scan?limit=50
 * Skips ones already in Vectorize (by checking if upsert is safe — just re-upserts, idempotent).
 */
async function handleVoiceScan(env, limit = 50) {
  if (!env.VECTORIZE || !env.AI) {
    return new Response(JSON.stringify({ error: 'VECTORIZE or AI binding missing' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const rows = await env.DB.prepare(`
      SELECT o.id, o.subject, o.body, o.self_score, v.name as venue_name, v.category
      FROM outreach_logs o
      JOIN venues v ON v.id = o.venue_id
      WHERE o.approval_status = 'approved'
        AND o.body IS NOT NULL AND length(o.body) > 50
        AND o.self_score >= 7
      ORDER BY o.sent_at DESC
      LIMIT ?
    `).bind(limit).all();

    const logs = rows.results || [];
    let embedded = 0, failed = 0;

    // Process in batches of 5 to avoid rate limits
    for (let i = 0; i < logs.length; i += 5) {
      const batch = logs.slice(i, i + 5);
      const texts = batch.map(r => `Subject: ${r.subject}\n\nVenue type: ${r.category || 'unknown'}\n\n${r.body}`);
      try {
        const embResult = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: texts });
        const vectors = embResult?.data || [];
        const toUpsert = batch.map((r, idx) => vectors[idx] ? {
          id: String(r.id),
          values: vectors[idx],
          metadata: {
            subject: (r.subject || '').slice(0, 200),
            body_preview: (r.body || '').slice(0, 500),
            venue_name: r.venue_name || '',
            category: r.category || '',
            self_score: r.self_score || 0,
          },
        } : null).filter(Boolean);
        if (toUpsert.length > 0) {
          await env.VECTORIZE.upsert(toUpsert);
          embedded += toUpsert.length;
        }
        failed += batch.length - toUpsert.length;
      } catch {
        failed += batch.length;
      }
    }

    return new Response(JSON.stringify({ scanned: logs.length, embedded, failed }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

/**
 * Find N most similar sent emails given a query string.
 * GET /account/voice-similar?q=outdoor+amphitheater+summer+trial&k=3
 * Used by outreach-agent before drafting.
 */
async function handleVoiceSimilar(env, query, k = 3) {
  if (!env.VECTORIZE || !env.AI) {
    return new Response(JSON.stringify({ error: 'VECTORIZE or AI binding missing' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    if (!query) return new Response(JSON.stringify({ error: 'q required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const embResult = await env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [query] });
    const vector = embResult?.data?.[0];
    if (!vector) return new Response(JSON.stringify({ error: 'Embedding failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    const results = await env.VECTORIZE.query(vector, { topK: k, returnMetadata: true });
    const matches = (results?.matches || []).map(m => ({
      id: m.id,
      score: m.score,
      subject: m.metadata?.subject || '',
      body_preview: m.metadata?.body_preview || '',
      venue_name: m.metadata?.venue_name || '',
      category: m.metadata?.category || '',
      self_score: m.metadata?.self_score || 0,
    }));

    return new Response(JSON.stringify({ matches }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
