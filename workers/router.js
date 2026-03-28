/**
 * Dangerous Pretzel Co — Pretzel OS Router
 * Single Cloudflare Worker entry point.
 * Routes cron events + HTTP requests to the right handler.
 *
 * Full cron schedule (all times MT):
 *   Sun 10pm  → CFO agent (financial directive)
 *   Sun 11pm  → Optimizer (reads directive, rewrites prompts)
 *   Mon 6am   → Scout (venue discovery)
 *   Mon 7am   → Qualifier (venue scoring)
 *   Mon 9am   → Account (health check + Drew digest)
 *   Tue+Thu 8am → Outreach (wholesale agent)
 *   Mon+Wed 8am → Catering (corporate agent)
 *   Daily 4am → Toast sync
 *   Daily 2pm → Review SMS
 *   Fri 8am   → Pilot (Twisted Sugar)
 */

import { default as scout }       from './scout-worker.js';
import { default as qualifier }   from './qualifier-worker.js';
import { default as outreach }    from './outreach-agent.js';
import { default as account }     from './account-worker.js';
import { default as optimizer }   from './optimizer-worker.js';
import { default as pilot }       from './pilot-tracker-worker.js';
import { default as repKit }      from './rep-enablement-worker.js';
import { default as cfo }         from './cfo-agent.js';
import { default as retail }      from './retail-agent.js';
import { default as catering }    from './catering-agent.js';
import { default as chat }        from './chat-worker.js';
import { default as qboClient, syncQBOInvoicesToD1 } from './qbo-client.js';
import { default as coach }       from './coach-agent.js';
import { default as qboWebhook } from './qbo-webhook-worker.js';
import { default as cfoPulse }   from './cfo-pulse-worker.js';
import { default as replyHandler } from './reply-handler-worker.js';

export default {

  // ── Cron dispatcher ──────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`[Router] Cron fired: ${cron}`);

    // Sunday 10pm MT — CFO Agent (before Optimizer)
    if (cron === '0 4 * * 7') {
      ctx.waitUntil(cfo.scheduled(event, env, ctx));
    }

    // Sunday 11pm MT — Optimizer (reads CFO directive, rewrites prompts)
    if (cron === '0 5 * * 7') {
      ctx.waitUntil(optimizer.scheduled(event, env, ctx));
    }

    // Monday 6am MT — Scout
    if (cron === '0 12 * * 1') {
      ctx.waitUntil(scout.scheduled(event, env, ctx));
    }

    // Monday 7am MT — Qualifier
    if (cron === '0 13 * * 1') {
      ctx.waitUntil(qualifier.scheduled(event, env, ctx));
    }

    // Tue + Thu 8am MT — Outreach (wholesale)
    if (cron === '0 14 * * 2' || cron === '0 14 * * 4') {
      ctx.waitUntil(outreach.scheduled(event, env, ctx));
    }

    // Mon + Wed 8am MT — Catering Agent
    if (cron === '0 14 * * 1' || cron === '0 14 * * 3') {
      ctx.waitUntil(catering.scheduled(event, env, ctx));
    }

    // Monday 9am MT — Account health + Drew digest
    if (cron === '0 15 * * 1') {
      ctx.waitUntil(account.scheduled(event, env, ctx));
    }

    // Friday 8am MT — Pilot weekly check
    if (cron === '0 14 * * 5') {
      ctx.waitUntil(pilot.scheduled(event, env, ctx));
    }

    // Daily 4am MT — Toast POS data sync + QBO wholesale invoice sync
    if (cron === '0 10 * * *') {
      ctx.waitUntil(account.scheduled(event, env, ctx));
      ctx.waitUntil(syncQBOInvoicesToD1(env).catch(err =>
        console.error('[Router] QBO invoice sync failed:', err.message)
      ));
    }

    // Daily 2pm MT — Review request SMS + Retail agent
    if (cron === '0 20 * * *') {
      ctx.waitUntil(account.scheduled(event, env, ctx));
      ctx.waitUntil(retail.scheduled(event, env, ctx));
    }

    // Hourly — CFO Pulse (D1 only, no QBO API calls, free)
    if (cron === '0 * * * *') {
      ctx.waitUntil(cfoPulse.scheduled(event, env, ctx));
    }

    // Every 15 min — Reply scanner (Gmail → Queue, no Claude calls)
    if (cron === '*/15 * * * *') {
      ctx.waitUntil(
        replyHandler.scheduled(event, env, ctx).catch(err =>
          console.error('[Router] Reply scanner failed:', err.message)
        )
      );
    }
  },

  // ── Queue consumer (reply + cross-channel signals) ─────────
  async queue(batch, env) {
    if (batch.queue === 'pretzel-signal-queue') {
      return retail.queue(batch, env);
    }
    if (batch.queue === 'pretzel-reply-queue') {
      return replyHandler.queue(batch, env);
    }
    // Unknown queue — ack all
    for (const msg of batch.messages) {
      console.error('[Router] Unknown queue:', batch.queue);
      msg.ack();
    }
  },

  // ── HTTP router ───────────────────────────────────────────────
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS: allow dashboard (Pages) to call the API
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const withCors = (response) => {
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders)) newHeaders.set(k, v);
      return new Response(response.body, { status: response.status, headers: newHeaders });
    };

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        name: 'Pretzel OS',
        version: '2.0.0',
        workers: ['scout', 'qualifier', 'outreach', 'account', 'optimizer', 'pilot', 'repKit', 'cfo', 'retail', 'catering', 'chat', 'qbo', 'coach', 'qboWebhook', 'cfoPulse', 'replyHandler'],
        timestamp: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Scout routes
    if (path.startsWith('/scout/')) return withCors(await scout.fetch(request, env, ctx));

    // Qualifier routes
    if (path.startsWith('/qualifier/')) return withCors(await qualifier.fetch(request, env, ctx));

    // Pipeline routes (outreach holds + flags — dashboard views)
    if (path.startsWith('/pipeline/')) return withCors(await outreach.fetch(request, env, ctx));

    // Reply inbox (before outreach catch-all)
    if (path.startsWith('/replies/')) return withCors(await replyHandler.fetch(request, env, ctx));

    // Outreach routes
    if (path.startsWith('/outreach/')) return withCors(await outreach.fetch(request, env, ctx));

    // Review routes
    if (path.startsWith('/reviews/')) return withCors(await account.fetch(request, env, ctx));

    // Account + webhook routes
    if (path.startsWith('/account/')) return withCors(await account.fetch(request, env, ctx));

    // Optimizer routes
    if (path.startsWith('/optimizer/')) return withCors(await optimizer.fetch(request, env, ctx));

    // Twisted Sugar pilot routes
    if (path.startsWith('/pilot/')) return withCors(await pilot.fetch(request, env, ctx));

    // Rep enablement kit
    if (path.startsWith('/rep-kit')) return withCors(await repKit.fetch(request, env, ctx));

    // CFO Agent + CFO Pulse live endpoint
    if (path === '/cfo/live' || path === '/cfo/pulse') return withCors(await cfoPulse.fetch(request, env, ctx));
    if (path.startsWith('/cfo/')) return withCors(await cfo.fetch(request, env, ctx));

    // QBO webhook (must come before /qbo/ catch-all)
    if (path === '/qbo/webhook' || path === '/qbo/events') return withCors(await qboWebhook.fetch(request, env, ctx));

    // QBO direct (test + debug + OAuth)
    if (path.startsWith('/qbo/')) return withCors(await qboClient.fetch(request, env, ctx));

    // Retail Agent
    if (path.startsWith('/retail/')) return withCors(await retail.fetch(request, env, ctx));

    // Catering Agent
    if (path.startsWith('/catering/')) return withCors(await catering.fetch(request, env, ctx));

    // Coach Agent
    if (path.startsWith('/coach/')) return withCors(await coach.fetch(request, env, ctx));

    // Chat
    if (path.startsWith('/chat')) return withCors(await chat.fetch(request, env, ctx));

    // Dashboard: quick D1 stats
    if (path === '/stats') {
      return withCors(await getStats(env));
    }

    return new Response('Pretzel OS — dangerouspretzel.com', { status: 200, headers: corsHeaders });
  }
};

async function getStats(env) {
  const [venues, outreach, accounts] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as tier1,
        SUM(CASE WHEN tier = 2 THEN 1 ELSE 0 END) as tier2,
        SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM venues
    `).first(),

    env.DB.prepare(`
      SELECT
        COUNT(*) as total_sent,
        SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) as replies,
        SUM(CASE WHEN outcome = 'meeting_booked' THEN 1 ELSE 0 END) as meetings,
        SUM(CASE WHEN outcome = 'closed' THEN 1 ELSE 0 END) as closed
      FROM outreach_logs
      WHERE direction = 'out' AND sent_at >= date('now', '-30 days')
    `).first(),

    env.DB.prepare(`
      SELECT COUNT(*) as total, SUM(avg_monthly_rev) as monthly_rev
      FROM active_accounts
      WHERE warmer_removed_at IS NULL
    `).first(),
  ]);

  return new Response(JSON.stringify({
    venues,
    outreach_last_30d: outreach,
    active_accounts: accounts,
    generated_at: new Date().toISOString(),
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
