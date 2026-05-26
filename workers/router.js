/**
 * Dangerous Pretzel Co — Pretzel OS Router
 * Single Cloudflare Worker entry point.
 * Routes cron events + HTTP requests to the right handler.
 *
 * Full cron schedule (all times MT):
 *   Sun 10pm  → CFO agent (financial directive)
 *   Sun 11pm  → Optimizer (reads directive, rewrites prompts)
 *   Mon 6am   → Scout (venue discovery)
 *   Mon+Thu 7am → Qualifier (venue scoring, 2x/week)
 *   Mon 9am   → Account (health check + Drew digest)
 *   Mon–Fri 8am → Outreach (wholesale agent, daily for follow-up cadence)
 *   Mon+Wed+Fri 8am → Catering (corporate agent)
 *   Daily 4am → Toast/Square sync + QBO invoice sync
 *   Daily 2pm → Review SMS + Retail agent
 *   Fri 8am   → Pilot (Twisted Sugar)
 *   Fri 5pm   → Weekly pipeline digest email
 */

import { default as scout }       from './scout-worker.js';
export { OutreachApprovalWorkflow, CateringApprovalWorkflow } from './outreach-workflow.js';
export { ChatSessionDO } from './chat-session-do.js';
import { default as qualifier }   from './qualifier-worker.js';
import { default as outreach, runSignalScanner }    from './outreach-agent.js';
import { default as account }     from './account-worker.js';
import { default as optimizer }   from './optimizer-worker.js';
import { default as pilot }       from './pilot-tracker-worker.js';
import { default as repKit }      from './rep-enablement-worker.js';
import { default as cfo }         from './cfo-agent.js';
import { default as retail }      from './retail-agent.js';
import { default as catering }    from './catering-agent.js';
import { default as cateringScout } from './catering-scout.js';
import { default as cateringCrossover } from './catering-crossover-scout.js';
import { default as chat }        from './chat-worker.js';
import { default as qboClient, syncQBOInvoicesToD1 } from './qbo-client.js';
import { default as coach }       from './coach-agent.js';
import { default as qboWebhook } from './qbo-webhook-worker.js';
import { default as cfoPulse }   from './cfo-pulse-worker.js';
import { default as replyHandler } from './reply-handler-worker.js';
import { default as orchestrator } from './orchestrator.js';
import { default as squareSync } from './square-sync-worker.js';
import { default as squareCustomerSync, syncSquareCustomers } from './square-customer-sync.js';
import { default as emailSender, sendResendEmail } from './email-sender.js';
import { default as retailSuggestionsWorker } from './retail-suggestions-worker.js';
import { default as retailVerdictGenerator } from './retail-verdict-generator.js';
import { default as codeExpirationCleaner } from './code-expiration-cleaner.js';
import { default as finance, runDailyClose as financeDailyClose, runFinanceMonthlyClose, runFinanceWeeklyDirective, runFinanceDailyRecon } from './finance-worker.js';
import { runTier1 as financeAuditTier1, runTier2 as financeAuditTier2 } from './finance-audit-engine.js';
import { sendDailyMorningBrief as financeDailyPulse } from './finance-email-briefs.js';
import { runD1Backup, handleD1BackupRequest } from './d1-backup.js';
export { RetailBackfillWorkflow } from './retail-backfill-workflow.js';

// ── Tracked cron wrapper — logs every run to cron_runs table ─────────
async function trackedRun(env, agentName, cronExpr, fn) {
  const runId = crypto.randomUUID();
  const t0 = Date.now();
  // Defensive outer try — if env.DB is missing or .prepare() throws synchronously
  // (e.g. binding config issue), we still want a console.error so the failure is
  // visible in `wrangler tail`, rather than the whole cron dying silently.
  try {
    try {
      await env.DB.prepare(
        `INSERT INTO cron_runs (id, agent, cron, status, started_at) VALUES (?, ?, ?, 'running', datetime('now'))`
      ).bind(runId, agentName, cronExpr).run();
    } catch (insertErr) {
      console.error(`[Router] cron_runs INSERT failed for ${agentName} (${runId}):`, insertErr.message);
      // Keep going — a missing log row shouldn't stop the actual agent from running
    }
    const result = await fn();
    const durationMs = Date.now() - t0;
    await env.DB.prepare(
      `UPDATE cron_runs SET status = 'completed', completed_at = datetime('now'), duration_ms = ?, summary = ? WHERE id = ?`
    ).bind(durationMs, JSON.stringify(result || {}).slice(0, 2000), runId).run().catch(e => console.error(`[Router] cron_runs completed UPDATE failed for ${agentName} (${runId}):`, e.message));
    // Session 0: heartbeat the component so trust score reflects this run.
    // Best-effort; failure doesn't break the cron flow.
    try {
      const { heartbeat: writeHb } = await import('./finance-health.js');
      await writeHb(env, agentName, { duration_ms: durationMs, status: 'green' });
    } catch (hbErr) {
      console.warn(`[Router] heartbeat write failed for ${agentName}: ${hbErr.message}`);
    }
    return result;
  } catch (err) {
    console.error(`[Router] ${agentName} failed:`, err.message, err.stack?.slice(0, 400));
    try {
      await env.DB.prepare(
        `UPDATE cron_runs SET status = 'failed', completed_at = datetime('now'), duration_ms = ?, error = ? WHERE id = ?`
      ).bind(Date.now() - t0, err.message?.slice(0, 500), runId).run();
    } catch (updErr) {
      console.error(`[Router] cron_runs failed UPDATE failed for ${agentName} (${runId}):`, updErr.message);
    }
    // Session 0: write a failed heartbeat so trust score reflects the failure.
    try {
      const { heartbeatFailed: writeFail } = await import('./finance-health.js');
      await writeFail(env, agentName, err.message?.slice(0, 300));
    } catch {}
    // Alert Drew on critical agent failures.
    // Bug 1.3 follow-up — add cfo + optimizer + retail + reviews. These are money-
    // adjacent agents whose silent failure caused April 14's "Cash: --" dashboard
    // gap; we want loud failures instead.
    const CRITICAL_AGENTS = new Set([
      'outreach', 'scout', 'qualifier', 'catering',
      'cfo', 'optimizer', 'retail', 'reviews',
      'qbo_sync', 'square_sync',
      'cfo_daily_close', 'cfo_daily_recon', 'cfo_monthly_close',
      'cfo_audit_tier1', 'cfo_daily_pulse', 'cfo_audit_tier2',
    ]);
    if (CRITICAL_AGENTS.has(agentName)) {
      // Tier 1b — tag with source + severity so system_alerts row + Twilio fallback
      // can route this correctly. No .catch() swallow any more; sendAlertEmail
      // catches internally and writes to system_alerts even when all channels fail.
      sendAlertEmail(
        env,
        `⚠️ ${agentName} agent failed`,
        `The ${agentName} agent crashed during its scheduled run.\n\nError: ${err.message}\n\nCron: ${cronExpr}\nDuration: ${Date.now() - t0}ms\n\nCheck dashboard: https://pretzel-dashboard.pages.dev`,
        { severity: 'critical', source: agentName }
      );
    }
  }
}

// Tier 1c — constant-time string compare so a token-mismatch can't be brute-
// forced by timing the response. Both inputs must be strings; returns false
// on any length mismatch and otherwise XORs every char.
function timingSafeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// ── Lightweight Gmail send for alerts + digests ─────────────────
// Tier 1b hardening: every call now creates a `system_alerts` row FIRST so
// the dashboard can surface the alert even when every downstream send fails.
// If Gmail fails (expired refresh token, 5xx, etc.) we fall back to Swell SMS
// to DREW_PHONE when configured, and record which channel succeeded.
async function sendAlertEmail(env, subject, body, opts = {}) {
  const severity = opts.severity || 'high';
  const source = opts.source || 'router';
  const alertId = crypto.randomUUID();

  // 1) Persist the alert — this is the durable record.
  //    If DB insert throws, we still attempt the email (visibility is valuable
  //    even without the DB row), but we log the insert failure to console.
  try {
    await env.DB.prepare(
      `INSERT INTO system_alerts (id, severity, source, subject, body, email_status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(alertId, severity, source, subject, (body || '').slice(0, 4000)).run();
  } catch (err) {
    console.error('[Router] system_alerts insert failed:', err.message);
  }

  // 2) Attempt Gmail send.
  let emailErr = null;
  try {
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
        refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token',
      }),
    });
    if (!tokenResp.ok) throw new Error(`gmail token ${tokenResp.status}: ${(await tokenResp.text()).slice(0, 120)}`);
    const { access_token } = await tokenResp.json();
    if (!access_token) throw new Error('gmail: no access_token in refresh response');
    const message = [`To: ${env.DREW_EMAIL}`, `From: Pretzel OS <${env.FROM_EMAIL}>`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
    const bytes = new TextEncoder().encode(message);
    const encoded = btoa(Array.from(bytes, b => String.fromCodePoint(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sendResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });
    if (!sendResp.ok) throw new Error(`gmail send ${sendResp.status}: ${(await sendResp.text()).slice(0, 120)}`);
    // Success — mark the alert row sent.
    await env.DB.prepare(
      `UPDATE system_alerts SET email_status='sent' WHERE id=?`
    ).bind(alertId).run().catch(() => {});
    return { sent: true, channel: 'email', alertId };
  } catch (err) {
    emailErr = err.message || String(err);
    console.error('[Router] sendAlertEmail Gmail path failed:', emailErr);
  }

  // 3) Gmail failed — record it and attempt the fallback.
  await env.DB.prepare(
    `UPDATE system_alerts SET email_status='failed', email_error=? WHERE id=?`
  ).bind(emailErr.slice(0, 500), alertId).run().catch(() => {});

  // 3a) Swell SMS fallback to DREW_PHONE (same provider we use for customer SMS,
  //     so no new vendor). Gracefully no-op when DREW_PHONE or SWELLCX_API_KEY absent.
  if (env.DREW_PHONE && env.SWELLCX_API_KEY) {
    try {
      // Trim the body for SMS — just the subject + first line of body.
      const smsText = `⚠ Pretzel OS alert: ${subject}\n${(body || '').split('\n')[0].slice(0, 100)}`.slice(0, 300);
      const resp = await fetch('https://api.swellcx.com/v1/sms/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.SWELLCX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: env.DREW_PHONE, message: smsText }),
      });
      if (!resp.ok) throw new Error(`swell ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      await env.DB.prepare(
        `UPDATE system_alerts SET fallback_status='sms_sent' WHERE id=?`
      ).bind(alertId).run().catch(() => {});
      return { sent: true, channel: 'sms_fallback', alertId };
    } catch (smsErr) {
      console.error('[Router] sendAlertEmail SMS fallback failed:', smsErr.message);
      await env.DB.prepare(
        `UPDATE system_alerts SET fallback_status='sms_failed', fallback_error=? WHERE id=?`
      ).bind((smsErr.message || String(smsErr)).slice(0, 500), alertId).run().catch(() => {});
    }
  } else {
    await env.DB.prepare(
      `UPDATE system_alerts SET fallback_status='none', fallback_error=? WHERE id=?`
    ).bind('DREW_PHONE or SWELLCX_API_KEY missing', alertId).run().catch(() => {});
  }

  // 3b) All channels exhausted — the system_alerts row is still there for the
  //     dashboard to surface. Return false so caller knows nothing reached Drew.
  return { sent: false, channel: null, alertId, error: emailErr };
}

// ── Weekly Pipeline Digest (Friday 5pm MT) ──────────────────────
async function sendWeeklyDigest(env) {
  const weekAgo = "datetime('now', '-7 days')";

  // Scouted this week
  const scouted = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM venues WHERE created_at > datetime('now', '-7 days')`
  ).first();

  // Qualified this week
  const qualified = await env.DB.prepare(
    `SELECT COUNT(*) as c, SUM(CASE WHEN tier = 1 THEN 1 ELSE 0 END) as t1, SUM(CASE WHEN tier = 2 THEN 1 ELSE 0 END) as t2 FROM venues WHERE tier IS NOT NULL AND updated_at > datetime('now', '-7 days') AND status != 'archived'`
  ).first();

  // Emails sent this week
  const emails = await env.DB.prepare(
    `SELECT COUNT(*) as c, SUM(CASE WHEN sequence_step = 1 THEN 1 ELSE 0 END) as fresh, SUM(CASE WHEN sequence_step > 1 THEN 1 ELSE 0 END) as followups FROM outreach_logs WHERE direction = 'out' AND sent_at > datetime('now', '-7 days')`
  ).first();

  // Replies received
  const replies = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM inbound_replies WHERE received_at > datetime('now', '-7 days')`
  ).first();

  // Pipeline wins (venues that moved to 'active' this week)
  const wins = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM venues WHERE status = 'active' AND updated_at > datetime('now', '-7 days')`
  ).first();

  // Flagged for Drew
  const flagged = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM venues WHERE status = 'flagged' AND updated_at > datetime('now', '-7 days')`
  ).first();

  // Follow-ups due next week
  const fu3 = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM outreach_logs ol JOIN venues v ON v.id = ol.venue_id WHERE ol.direction = 'out' AND ol.sequence_step = 1 AND ol.replied_at IS NULL AND datetime(ol.sent_at) < datetime('now', '-3 days') AND datetime(ol.sent_at) > datetime('now', '-14 days') AND v.status = 'contacted' AND NOT EXISTS (SELECT 1 FROM outreach_logs ol2 WHERE ol2.venue_id = ol.venue_id AND ol2.sequence_step >= 2 AND ol2.direction = 'out')`
  ).first();
  const fu7 = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM outreach_logs ol JOIN venues v ON v.id = ol.venue_id WHERE ol.direction = 'out' AND ol.sequence_step = 2 AND ol.replied_at IS NULL AND datetime(ol.sent_at) < datetime('now', '-7 days') AND datetime(ol.sent_at) > datetime('now', '-21 days') AND v.status = 'contacted'`
  ).first();

  // Cron failures this week
  const cronFails = await env.DB.prepare(
    `SELECT agent, error, started_at FROM cron_runs WHERE status = 'failed' AND started_at > datetime('now', '-7 days') ORDER BY started_at DESC LIMIT 10`
  ).all();

  const failSection = (cronFails.results || []).length > 0
    ? (cronFails.results || []).map(f => `  • ${f.agent} failed at ${f.started_at}: ${f.error}`).join('\n')
    : '  • 0 failures — all cron runs completed successfully';

  const today = new Date();
  const weekStart = new Date(today.getTime() - 7 * 86400000);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const body = `Pipeline Week in Review — ${fmt(weekStart)}–${fmt(today)}

📊 This Week:
  • Scouted: ${scouted?.c || 0} new venues
  • Qualified: ${qualified?.c || 0} (tier 1: ${qualified?.t1 || 0}, tier 2: ${qualified?.t2 || 0})
  • Emails sent: ${emails?.c || 0} (${emails?.fresh || 0} fresh, ${emails?.followups || 0} follow-ups)
  • Replies received: ${replies?.c || 0}
  • Pipeline wins: ${wins?.c || 0}
  • Flagged for you: ${flagged?.c || 0}

📬 Follow-ups currently due:
  • Day-3: ${fu3?.c || 0} venues
  • Day-7: ${fu7?.c || 0} venues

⚠️ Cron Health:
${failSection}

— Pretzel OS
https://pretzel-dashboard.pages.dev`;

  await sendAlertEmail(env, `📊 Pipeline Week in Review — ${fmt(weekStart)}–${fmt(today)}`, body);
  return { digest_sent: true };
}

export default {

  // ── Cron dispatcher ──────────────────────────────────────────
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    console.log(`[Router] Cron fired: ${cron}`);

    // Passive janitor — every tick, sweep cron_runs rows stuck in 'running' for
    // more than 15 minutes and mark them failed. Cheap (one UPDATE) and prevents
    // zombie rows from corrupting /cron/health when a Worker dies mid-flight.
    ctx.waitUntil(
      env.DB.prepare(
        `UPDATE cron_runs
         SET status='failed', completed_at=datetime('now'),
             error=COALESCE(error,'Auto-cleaned: stuck in running >15min')
         WHERE status='running' AND started_at < datetime('now','-15 minutes')`
      ).run().catch(() => {})
    );

    // Sunday 10pm MT — CFO Agent (before Optimizer)
    if (cron === '0 4 * * 7') {
      ctx.waitUntil(trackedRun(env, 'cfo', cron, () => cfo.scheduled(event, env, ctx)));
    }

    // Sunday 11pm MT — Optimizer (reads CFO directive, rewrites prompts)
    if (cron === '0 5 * * 7') {
      ctx.waitUntil(trackedRun(env, 'optimizer', cron, () => optimizer.scheduled(event, env, ctx)));
    }

    // Monday 6am MT — Scout
    if (cron === '0 12 * * 1') {
      ctx.waitUntil(trackedRun(env, 'scout', cron, () => scout.scheduled(event, env, ctx)));
    }

    // Mon + Thu 7am MT — Qualifier (twice/week to clear scout backlog)
    if (cron === '0 13 * * 1' || cron === '0 13 * * 4') {
      ctx.waitUntil(trackedRun(env, 'qualifier', cron, () => qualifier.scheduled(event, env, ctx)));
    }

    // Mon–Fri 8am MT — Outreach (wholesale) — Mon added so Friday follow-ups fire on time
    if (cron === '0 14 * * 1' || cron === '0 14 * * 2' || cron === '0 14 * * 3' || cron === '0 14 * * 4' || cron === '0 14 * * 5') {
      ctx.waitUntil(trackedRun(env, 'outreach', cron, () => outreach.scheduled(event, env, ctx)));
    }

    // Mon + Wed + Fri 8:05am MT — Catering Agent (offset +5min from outreach to avoid CPU collision)
    if (cron === '5 14 * * 1' || cron === '5 14 * * 3' || cron === '5 14 * * 5') {
      ctx.waitUntil(trackedRun(env, 'catering', cron, () => catering.scheduled(event, env, ctx)));
    }

    // Daily 5am MT — Catering Crossover Scout (retail → catering lead seeding)
    if (cron === '0 11 * * *') {
      ctx.waitUntil(trackedRun(env, 'catering_crossover', cron, () => cateringCrossover.scheduled(event, env, ctx)));
    }

    // Monday 7:30am MT — Catering Apollo Scout (weekly ICP pull)
    if (cron === '30 13 * * 1') {
      ctx.waitUntil(trackedRun(env, 'catering_scout', cron, () => cateringScout.scheduled(event, env, ctx)));
    }

    // Monday 9am MT — Account health + Drew digest
    if (cron === '0 15 * * 1') {
      ctx.waitUntil(trackedRun(env, 'account', cron, () => account.scheduled(event, env, ctx)));
    }

    // Friday 8am MT — Pilot weekly check (runs alongside outreach+catering)
    if (cron === '0 14 * * 5') {
      ctx.waitUntil(trackedRun(env, 'pilot', cron, () => pilot.scheduled(event, env, ctx)));
    }

    // Daily 6:30am MT — Signal Scanner (timing hooks for outreach)
    if (cron === '30 12 * * *') {
      ctx.waitUntil(trackedRun(env, 'signal_scanner', cron, () => runSignalScanner(env)));
    }

    // 1st of month 3am MT — Monthly depreciation auto-post (forward automation, no more annual rebuilds)
    if (cron === '0 9 1 * *') {
      ctx.waitUntil(trackedRun(env, 'monthly_depreciation', cron, async () => {
        const { postMonthlyDepreciation } = await import('./finance-monthly-depreciation-cron.js');
        return postMonthlyDepreciation(env);
      }));
    }

    // 1st of month 9am MT — Tier 5 monthly acceptance (drift detection vs QBO truth)
    if (cron === '0 15 1 * *') {
      ctx.waitUntil(trackedRun(env, 'tier5_monthly', cron, async () => {
        const { runTier5Acceptance } = await import('./finance-audit-engine.js');
        return runTier5Acceptance(env, { period_year: new Date().getUTCFullYear() });
      }));
    }

    // 28th of month 8am MT — Mercury IO statement upload reminder (logged as financial_flag for dashboard visibility)
    if (cron === '0 14 28 * *') {
      ctx.waitUntil(trackedRun(env, 'mercury_io_reminder', cron, async () => {
        const period = new Date().toISOString().slice(0, 7);
        await env.DB.prepare(`
          INSERT INTO financial_flags (id, flag_type, severity, message, status, created_at)
          VALUES (?, 'mercury_io_upload_due', 'medium', ?, 'open', datetime('now'))
        `).bind(
          crypto.randomUUID(),
          `Monthly Mercury IO statement upload due for ${period}. Download from Mercury Credit dashboard and ingest via POST /finance/gl/ingest-mercury-credit until Plaid live sync is wired.`
        ).run().catch(() => {});
        return { ok: true, period };
      }));
    }

    // Daily 4am MT — POS data sync + QBO wholesale invoice sync
    if (cron === '0 10 * * *') {
      ctx.waitUntil(trackedRun(env, 'account_sync', cron, () => account.scheduled(event, env, ctx)));
      // qbo_sync moved to hourly (0 * * * *) so new invoices show up within the hour;
      // running it here too would be a wasted parallel API hit at 10:00 UTC.
      ctx.waitUntil(trackedRun(env, 'square_sync', cron, () => squareSync.scheduled(event, env, ctx)));
    }

    // Daily 2pm MT — Review request SMS + Retail agent
    if (cron === '0 20 * * *') {
      ctx.waitUntil(trackedRun(env, 'reviews', cron, () => account.scheduled(event, env, ctx)));
      ctx.waitUntil(trackedRun(env, 'retail', cron, () => retail.scheduled(event, env, ctx)));
    }

    // Hourly — CFO Pulse + QBO invoice sync (so new invoices show up within the hour, not next day)
    if (cron === '0 * * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_pulse', cron, () => cfoPulse.scheduled(event, env, ctx)));
      ctx.waitUntil(trackedRun(env, 'qbo_sync', cron, () => syncQBOInvoicesToD1(env)));
    }

    // Every 6h — Square customer sync (incremental, last 7h window).
    // Drives the email-segmentation cohorts. Read-only against Square.
    if (cron === '0 */6 * * *') {
      ctx.waitUntil(trackedRun(env, 'square_customer_sync', cron, () => squareCustomerSync.scheduled(event, env, ctx)));
    }

    // Tuesday 10am MT (16:00 UTC) — Cohort B weekly Square first-time win-back email batch.
    if (cron === '0 16 * * 2') {
      ctx.waitUntil(trackedRun(env, 'email_cohort_b', cron, () => emailSender.scheduled(event, env, ctx)));
    }

    // Hourly :15 — Retail V2 suggestions engine (formula-driven, no AI).
    if (cron === '15 * * * *') {
      ctx.waitUntil(trackedRun(env, 'retail_suggestions', cron, () => retailSuggestionsWorker.scheduled(event, env, ctx)));
    }

    // Daily 11pm MT (5:00 UTC) — Retail V2 verdict (Sonnet pass).
    if (cron === '0 5 * * *') {
      ctx.waitUntil(trackedRun(env, 'retail_verdict', cron, () => retailVerdictGenerator.scheduled(event, env, ctx)));
    }

    // Daily 11:30pm MT (5:30 UTC) — Code-expiration cleaner (post-May-11 loyalty migration).
    // Expires retail_campaign_sends rows whose expires_at has passed; deletes orphan
    // pre-May-11 Catalog DISCOUNT objects from Square. Loyalty rewards are server-side
    // expired by Square and not touched here.
    if (cron === '30 5 * * *') {
      ctx.waitUntil(trackedRun(env, 'code_expiration_cleaner', cron, () => codeExpirationCleaner.scheduled(event, env, ctx)));
    }

    // Daily 10am MT (16:00 UTC) — Catering Reactivation 2026 daily fire.
    // Sends up to 18 SMS to past catering customers / leads with magic discount link.
    // Self-cancels when cohort is cleared (endpoint returns 0 targets).
    if (cron === '0 16 * * *') {
      ctx.waitUntil(trackedRun(env, 'catering_reactivation_daily', cron, async () => {
        const r = await retail.fetch(new Request('https://internal/retail/catering-reactivation/fire', { method: 'POST' }), env, ctx);
        return r.ok ? { ok: true } : { ok: false, status: r.status };
      }));
    }

    // Every 15 min — Reply scanner (Gmail → Queue, no Claude calls)
    if (cron === '*/15 * * * *') {
      ctx.waitUntil(trackedRun(env, 'reply_scanner', cron, () => replyHandler.scheduled(event, env, ctx)));
    }

    // Friday 5pm MT — Weekly Pipeline Digest email to Drew
    if (cron === '0 23 * * 5') {
      ctx.waitUntil(trackedRun(env, 'weekly_digest', cron, () => sendWeeklyDigest(env)));
    }

    // Daily 7am MT (13:00 UTC) — CFO Agent v2 daily close (C-6)
    if (cron === '0 13 * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_daily_close', cron, () => financeDailyClose(env)));
      // Session 17c (May 14 2026): also refresh the page-narrative at 7am MT
      // so Drew sees a fresh narrative when he opens the dashboard.
      ctx.waitUntil(trackedRun(env, 'page_narrative_refresh', cron, async () => {
        const { generatePageNarrative } = await import('./finance-page-narrative.js');
        return generatePageNarrative(env);
      }));
    }

    // Daily 7:30am MT (13:30 UTC) — Daily Pulse email to Drew (post-daily-close)
    if (cron === '30 13 * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_daily_pulse', cron, () => financeDailyPulse(env)));
    }

    // Daily 8am MT (14:00 UTC) — Daily reconciliation (Mercury vs books) (3.11)
    if (cron === '0 14 * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_daily_recon', cron, () => runFinanceDailyRecon(env)));
    }

    // 1st of month 6am MT (12:00 UTC) — Monthly close (3.4)
    if (cron === '0 12 1 * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_monthly_close', cron, () => runFinanceMonthlyClose(env)));
    }

    // Monday 10pm Sunday MT (4:00 UTC Mon) — Weekly directive (3.3, Sonnet)
    if (cron === '0 4 * * 1') {
      ctx.waitUntil(trackedRun(env, 'cfo_weekly_directive', cron, () => runFinanceWeeklyDirective(env)));
    }

    // Every hour at :05 — Audit Tier 1 (ledger invariants). Any failure trips
    // FINANCE_READ_ONLY and files a financial_flag.
    if (cron === '5 * * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_audit_tier1', cron, () => financeAuditTier1(env, 'cron')));
    }

    // Every 4h at :20 — Plaid Chase CC sync (transactions/sync)
    if (cron === '20 */4 * * *') {
      ctx.waitUntil(trackedRun(env, 'chase_sync_plaid', cron, async () => {
        const { syncAllItems } = await import('./plaid-client.js');
        return syncAllItems(env);
      }));
    }

    // Daily 8:15am MT — Issue surfacer scan
    if (cron === '15 14 * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_issue_surfacer', cron, async () => {
        const { scanIssues } = await import('./finance-issue-surfacer.js');
        return scanIssues(env);
      }));
    }

    // Daily 11:45pm MT — Square Labor sync (after day's shifts close)
    if (cron === '45 5 * * *') {
      ctx.waitUntil(trackedRun(env, 'square_labor_sync', cron, async () => {
        const { syncSquareLabor } = await import('./square-labor-sync.js');
        return syncSquareLabor(env);
      }));
    }

    // Daily 8:30am MT (14:30 UTC) — Audit Tier 2 (state/drift/operational).
    // Informational only — never trips read-only. Surfaces in daily close email.
    if (cron === '30 14 * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_audit_tier2', cron, () => financeAuditTier2(env, 'cron')));
    }

    // Every 6h — pipeline-stalled alarm. If no JE has been posted in 26h, fire
    // an email so Drew knows even if the daily-close email looks clean.
    if (cron === '0 */6 * * *') {
      ctx.waitUntil(trackedRun(env, 'cfo_pipeline_stalled_check', cron, async () => {
        // Session 15b (May 14 2026): WATCHER/METRIC DECOUPLE.
        // This watcher's job is to: (a) update the je_posting_freshness signal,
        // (b) email Drew if stalled. Its OWN heartbeat stays GREEN regardless
        // of what it finds — trackedRun handles that on return-without-throw.
        const row = await env.DB.prepare(
          `SELECT MAX(created_at) as last_je FROM journal_entries WHERE status = 'posted'`
        ).first();

        // Write the separate je_posting_freshness signal — this is the heartbeat
        // that goes red when posting actually stalls. It's a SEPARATE component
        // from this watcher's own heartbeat.
        try {
          const { heartbeat: writeHb } = await import('./finance-health.js');
          if (row?.last_je) {
            // Backdate the heartbeat's "last_success_at" to the actual last-JE
            // time so lag correctly reflects how long ago posting last happened.
            // We use a direct SQL write instead of the helper (which uses datetime('now')).
            await env.DB.prepare(`
              INSERT INTO system_heartbeats (component, last_success_at, last_attempt_at,
                last_duration_ms, status, consecutive_failures, last_error, updated_at,
                expected_max_lag_minutes, notes)
              VALUES ('je_posting_freshness', ?, datetime('now'), 0, 'green', 0, NULL,
                datetime('now'), 1560, 'Updated by cfo_pipeline_stalled_check watcher; reflects MAX(journal_entries.created_at)')
              ON CONFLICT(component) DO UPDATE SET
                last_success_at = ?,
                last_attempt_at = datetime('now'),
                status = 'green',
                consecutive_failures = 0,
                last_error = NULL,
                expected_max_lag_minutes = 1560,
                updated_at = datetime('now')
            `).bind(row.last_je, row.last_je).run().catch(() => {});
          }
        } catch (e) { /* freshness write failure is non-fatal */ }

        if (!row?.last_je) return { alerted: false, reason: 'no JEs ever posted', freshness_updated: false };
        const lastJe = new Date(row.last_je.replace(' ', 'T') + 'Z');
        const ageHrs = (Date.now() - lastJe) / 3600000;
        if (ageHrs < 26) return { alerted: false, age_hours: ageHrs.toFixed(1), freshness_updated: true };

        // Stall detected: alert Drew. Watcher heartbeat still green (this is success).
        const alertedRecently = await env.KV.get('PIPELINE_STALL_ALERT_SENT');
        if (alertedRecently) return { alerted: false, reason: 'already alerted', cooldown_until: alertedRecently };

        const readOnly = (await env.KV.get('FINANCE_READ_ONLY')) === '1';
        const reason = (await env.KV.get('FINANCE_READ_ONLY_REASON')) || 'unknown';
        const subject = `Pretzel CFO · ⚠ Pipeline stalled — no JEs posted in ${ageHrs.toFixed(0)}h`;
        const body = `Last JE posted: ${row.last_je} UTC (${ageHrs.toFixed(1)}h ago).\n\n` +
                     `Read-only mode: ${readOnly ? 'ON — ' + reason : 'OFF'}\n\n` +
                     `Possible causes:\n` +
                     `  • Daily close cron failed silently (check /cron/health)\n` +
                     `  • Read-only is on and bulk approvals haven't unblocked it\n` +
                     `  • All categorized txns are below 0.90 confidence (review queue)\n\n` +
                     `Investigate: https://pretzel-os.drew-f39.workers.dev/finance/system-health\n` +
                     `Money page: https://pretzel-dashboard.pages.dev/#money`;
        await sendAlertEmail(env, subject, body, { severity: 'high', source: 'pipeline_stalled' });

        await env.KV.put('PIPELINE_STALL_ALERT_SENT', new Date(Date.now() + 86400000).toISOString(), { expirationTtl: 86400 });
        return { alerted: true, age_hours: ageHrs.toFixed(1), read_only: readOnly, freshness_updated: true };
      }));
    }

    // Daily 3am UTC — D1 full SQL export to R2 (Foundation Safety Workstream 1, Task 3b)
    // Backup file lands at pretzel-pos-data/d1-backups/{daily|weekly|monthly}/pretzel-os-YYYY-MM-DD.sql
    // Status visible at GET /finance/backup/status; manual trigger at POST /finance/backup/run.
    if (cron === '0 3 * * *') {
      ctx.waitUntil(trackedRun(env, 'd1_backup', cron, () => runD1Backup(env, { triggeredBy: 'cron' })));
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

    // CORS — allowlist of origins that may call the API.
    // Dashboard Pages domain (*.pretzel-dashboard.pages.dev) + custom domain + localhost for dev.
    // Square / QBO / Gmail webhooks don't send Origin headers, so they aren't affected by this.
    const ALLOWED_ORIGIN_PATTERNS = [
      /^https:\/\/([a-z0-9-]+\.)?pretzel-dashboard\.pages\.dev$/, // Pages + preview deploys
      /^https:\/\/dangerouspretzel\.com$/,
      /^https:\/\/(www\.|api\.)?dangerouspretzel\.com$/,
      /^http:\/\/localhost(:\d+)?$/,
    ];
    const origin = request.headers.get('Origin') || '';
    const originAllowed = origin && ALLOWED_ORIGIN_PATTERNS.some(re => re.test(origin));
    const corsHeaders = {
      'Access-Control-Allow-Origin': originAllowed ? origin : '*', // fall back to * for non-browser (curl, webhooks) callers
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...corsHeaders, 'Access-Control-Allow-Headers': 'Content-Type, X-Pretzel-Auth' } });
    }

    const withCors = (response) => {
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders)) newHeaders.set(k, v);
      // Tier 1c — let browsers preflight the auth header.
      newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, X-Pretzel-Auth');
      return new Response(response.body, { status: response.status, headers: newHeaders });
    };

    // ── Tier 1c — endpoint auth (shared-secret header) ─────────────────────
    // Behavior depends on env.AUTH_ENFORCE:
    //   - 'true'       → return 401 when header missing/wrong (except allowlisted paths)
    //   - 'warn'/unset → log a warning to console but pass through (rollout safety)
    //
    // Allowlisted paths bypass auth entirely:
    //   - All webhooks (Square/QBO/Gmail/Swell/Toast push to us, can't send our header)
    //   - OAuth callbacks for QBO + Gmail
    //   - Email-link approvals (URL token already authenticates)
    //   - Email open-tracking pixels
    //   - Public landing page redirects + root health check
    //   - Pretzel Program landing page
    const isWebhook = path === '/qbo/webhook' || path === '/qbo/events'
      || path === '/square/webhook' || path === '/swell/webhook'
      || path === '/finance/plaid/webhook'
      || path === '/sms/webhook' || path === '/account/lead-capture';
    const isOAuthCallback = path.startsWith('/qbo/oauth') || path.startsWith('/gmail/oauth');
    const isEmailApproval = path.startsWith('/outreach/approve') || path.startsWith('/track/');
    const isPublic = path === '/' || path === '/pretzel-program' || path === '/pretzel-program.html';
    const requiresAuth = !(isWebhook || isOAuthCallback || isEmailApproval || isPublic);

    if (requiresAuth && env.DASHBOARD_AUTH_TOKEN) {
      const token = request.headers.get('X-Pretzel-Auth') || '';
      const ok = token && timingSafeEquals(token, env.DASHBOARD_AUTH_TOKEN);
      if (!ok) {
        const enforce = env.AUTH_ENFORCE === 'true';
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const ua = (request.headers.get('user-agent') || '').slice(0, 80);
        if (enforce) {
          console.warn(`[Auth] BLOCKED ${request.method} ${path} from ${ip} (ua="${ua}") — missing/bad X-Pretzel-Auth`);
          return withCors(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
        }
        console.warn(`[Auth] WARN ${request.method} ${path} from ${ip} (ua="${ua}") — would block when AUTH_ENFORCE=true`);
        // fall through — warn-only mode passes the request to the rest of the handler.
      }
    }

    // Cron cleanup — mark any cron_runs stuck "running" for >15 min as failed.
    // Workers die silently sometimes (CPU cap, unhandled reject) and leave
    // cron_runs rows in 'running' forever, which corrupts /cron/health.
    if (path === '/cron/cleanup' && request.method === 'POST') {
      const r = await env.DB.prepare(
        `UPDATE cron_runs
         SET status='failed', completed_at=datetime('now'),
             error=COALESCE(error,'Force-cleaned: stuck in running state')
         WHERE status='running' AND started_at < datetime('now','-15 minutes')`
      ).run();
      return withCors(new Response(JSON.stringify({
        runs_cleaned: r.meta?.changes || 0,
      }), { headers: { 'Content-Type': 'application/json' } }));
    }

    // Cron health — last run status for each agent + recent runs (V3 Add-on b).
    if (path === '/cron/health') {
      const [latest, recent] = await Promise.all([
        env.DB.prepare(`
          SELECT cr.agent, cr.status, cr.started_at, cr.completed_at, cr.duration_ms, cr.error,
                 cr.summary
          FROM cron_runs cr
          INNER JOIN (SELECT agent, MAX(started_at) as max_started FROM cron_runs GROUP BY agent) latest
            ON cr.agent = latest.agent AND cr.started_at = latest.max_started
          ORDER BY cr.started_at DESC
        `).all(),
        env.DB.prepare(`
          SELECT id, agent, cron, status, started_at, completed_at, duration_ms,
                 SUBSTR(COALESCE(error,''), 1, 200) as error_preview,
                 SUBSTR(COALESCE(summary,''), 1, 120) as summary_preview
          FROM cron_runs
          WHERE started_at >= datetime('now', '-48 hours')
          ORDER BY started_at DESC
          LIMIT 100
        `).all(),
      ]);
      return withCors(new Response(JSON.stringify({
        agents: latest.results || [],
        runs: recent.results || [],
      }), { headers: { 'Content-Type': 'application/json' } }));
    }

    // "Today" — prioritized, dual-funnel operator worklist.
    // Ordering (highest priority first):
    //   1. Reply needs you (question/objection/unclear)
    //   2. Drew-flagged (drew_flag status)
    //   3. Parked draft awaiting approval (outreach_logs.approval_status='pending')
    //   4. Prospect missing contact (scored/tiered but no email)
    //   5. Stuck >14d in contacted
    if (path === '/queue/today' || path === '/queue/for-you') {
      // Action verbs per bucket (default when no specific reason detected).
      const ACTION = {
        reply: 'Draft a reply',
        flagged: 'Decide',
        pending_approval: 'Review & send',
        needs_contact: 'Find contact',
        stuck: 'Nudge or hold',
      };
      // V3 Item 2.7 — flagActionLabel(reason): specific verb per flag cause.
      // Mapped from venue state. Preference: most-specific first.
      const flagActionLabel = (reasonCode) => ({
        missing_contact:   'Find contact',
        no_linkedin:       'Try LinkedIn',
        pick_contact:      'Pick contact',
        low_score:         'Override score',
        no_category:       'Re-categorize',
        no_pricing:        'Set pricing',
        vendor_conflict:   'Research vendor',
        seasonality_off:   'Skip for season',
        research_owner:    'Research owner',
        duplicate_check:   'Merge or keep',
        ambiguous_entity:  'Disambiguate',
      }[reasonCode] || 'Decide');
      // Given a venue/lead row, derive the most actionable reason.
      const deriveFlagReason = (r) => {
        if (r.status === 'hold') return 'research_owner';
        if (!r.contact_email) return 'missing_contact';
        if (r.category == null || r.category === '') return 'no_category';
        if (r.tier == null) return 'low_score';
        return 'pick_contact';
      };
      const items = [];
      // Bucket 1: replies needing action
      const replyRows = await env.DB.prepare(`
        SELECT ir.id, ir.venue_id, ir.from_email, ir.subject, ir.classification, ir.status,
               v.name as venue_name, v.category,
               CAST(julianday('now') - julianday(ir.received_at) AS INTEGER) as days
        FROM inbound_replies ir
        LEFT JOIN venues v ON v.id = ir.venue_id
        WHERE ir.status IN ('open','auto_send_scheduled')
        ORDER BY ir.received_at DESC LIMIT 50
      `).all().catch(() => ({ results: [] }));
      (replyRows.results || []).forEach(r => items.push({
        funnel: 'wholesale', priority: 1, bucket: 'reply',
        id: r.venue_id || r.id, reply_id: r.id,
        name: r.venue_name || r.from_email || '(unknown)',
        meta: { classification: r.classification, from_email: r.from_email, subject: r.subject, category: r.category, days: r.days },
      }));
      // Bucket 2: drew_flag in both funnels
      const flagW = await env.DB.prepare(`
        SELECT id, name, city, category, contact_email, status,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days
        FROM venues WHERE status IN ('drew_flag','hold') ORDER BY updated_at DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (flagW.results || []).forEach(r => {
        const reason = deriveFlagReason(r);
        items.push({
          funnel: 'wholesale', priority: 2, bucket: 'flagged',
          id: r.id, name: r.name,
          flag_reason: reason,
          meta: { city: r.city, category: r.category, contact_email: r.contact_email, status: r.status, days: r.days, flag_reason: reason },
        });
      });
      const flagC = await env.DB.prepare(`
        SELECT id, name, city, contact_email, status,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days
        FROM catering_leads WHERE status IN ('drew_flag','hold') ORDER BY updated_at DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (flagC.results || []).forEach(r => {
        const reason = deriveFlagReason({ ...r, category: null, tier: null });
        items.push({
          funnel: 'catering', priority: 2, bucket: 'flagged',
          id: r.id, name: r.name,
          flag_reason: reason,
          meta: { city: r.city, contact_email: r.contact_email, status: r.status, days: r.days, flag_reason: reason },
        });
      });
      // Bucket 3: parked approvals from both funnels
      const pendW = await env.DB.prepare(`
        SELECT ol.id as log_id, ol.venue_id as id, ol.subject, ol.self_score, ol.created_at,
               v.name, v.contact_email, v.category,
               CAST(julianday('now') - julianday(ol.created_at) AS INTEGER) as days
        FROM outreach_logs ol JOIN venues v ON v.id = ol.venue_id
        WHERE ol.approval_status = 'pending' AND (ol.direction IS NULL OR ol.direction = 'out')
        ORDER BY ol.created_at DESC LIMIT 50
      `).all().catch(() => ({ results: [] }));
      (pendW.results || []).forEach(r => items.push({
        funnel: 'wholesale', priority: 3, bucket: 'pending_approval',
        id: r.id, log_id: r.log_id, name: r.name,
        meta: { subject: r.subject, self_score: r.self_score, contact_email: r.contact_email, category: r.category, days: r.days },
      }));
      const pendC = await env.DB.prepare(`
        SELECT ol.id as log_id, ol.venue_id as id, ol.subject, ol.self_score, ol.created_at,
               cl.name, cl.contact_email,
               CAST(julianday('now') - julianday(ol.created_at) AS INTEGER) as days
        FROM outreach_logs ol JOIN catering_leads cl ON cl.id = ol.venue_id
        WHERE ol.approval_status = 'pending' AND (ol.direction IS NULL OR ol.direction = 'out')
        ORDER BY ol.created_at DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (pendC.results || []).forEach(r => items.push({
        funnel: 'catering', priority: 3, bucket: 'pending_approval',
        id: r.id, log_id: r.log_id, name: r.name,
        meta: { subject: r.subject, self_score: r.self_score, contact_email: r.contact_email, days: r.days },
      }));
      // Bucket 4: prospects scored+ready but no contact email
      const ncW = await env.DB.prepare(`
        SELECT id, name, city, category, status, tier, qual_score,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days
        FROM venues
        WHERE status = 'prospect' AND tier IS NOT NULL AND tier > 0
              AND (contact_email IS NULL OR contact_email = '')
        ORDER BY tier ASC, qual_score DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (ncW.results || []).forEach(r => items.push({
        funnel: 'wholesale', priority: 4, bucket: 'needs_contact',
        id: r.id, name: r.name,
        meta: { city: r.city, category: r.category, tier: r.tier, qual_score: r.qual_score, days: r.days },
      }));
      const ncC = await env.DB.prepare(`
        SELECT id, name, city, status,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days
        FROM catering_leads
        WHERE status = 'prospect' AND (contact_email IS NULL OR contact_email = '')
        ORDER BY updated_at DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (ncC.results || []).forEach(r => items.push({
        funnel: 'catering', priority: 4, bucket: 'needs_contact',
        id: r.id, name: r.name,
        meta: { city: r.city, days: r.days },
      }));
      // Bucket 5: stuck >14d in contacted
      const stW = await env.DB.prepare(`
        SELECT id, name, city, category, status, contact_email,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days
        FROM venues
        WHERE status IN ('contacted','sent')
              AND julianday('now') - julianday(COALESCE(updated_at, created_at)) > 14
        ORDER BY days DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (stW.results || []).forEach(r => items.push({
        funnel: 'wholesale', priority: 5, bucket: 'stuck',
        id: r.id, name: r.name,
        meta: { city: r.city, category: r.category, contact_email: r.contact_email, status: r.status, days: r.days },
      }));
      const stC = await env.DB.prepare(`
        SELECT id, name, city, status, contact_email,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days
        FROM catering_leads
        WHERE status = 'contacted'
              AND julianday('now') - julianday(COALESCE(updated_at, created_at)) > 14
        ORDER BY days DESC LIMIT 30
      `).all().catch(() => ({ results: [] }));
      (stC.results || []).forEach(r => items.push({
        funnel: 'catering', priority: 5, bucket: 'stuck',
        id: r.id, name: r.name,
        meta: { city: r.city, contact_email: r.contact_email, status: r.status, days: r.days },
      }));
      items.sort((a, b) => (a.priority - b.priority) || ((b.meta?.days || 0) - (a.meta?.days || 0)));
      // Enrich each item: attach the per-bucket action label, flatten meta fields that
      // the dashboard expects at the top level (city, contact_email, status, days, category),
      // and mirror pipeline for legacy code paths.
      items.forEach(i => {
        // V3 2.7 — flagged items get a specific label based on their derived reason.
        if (i.bucket === 'flagged' && i.flag_reason) {
          i.action = flagActionLabel(i.flag_reason);
        } else {
          i.action = ACTION[i.bucket] || 'Open';
        }
        i.pipeline = i.funnel === 'catering' ? 'catering' : 'outreach';
        if (i.meta) {
          if (i.city === undefined) i.city = i.meta.city;
          if (i.contact_email === undefined) i.contact_email = i.meta.contact_email;
          if (i.status === undefined) i.status = i.meta.status;
          if (i.category === undefined) i.category = i.meta.category;
          if (i.days === undefined) i.days = i.meta.days;
        }
      });
      const counts = {
        total: items.length,
        wholesale: items.filter(i => i.funnel === 'wholesale').length,
        catering: items.filter(i => i.funnel === 'catering').length,
        by_bucket: items.reduce((m, i) => (m[i.bucket] = (m[i.bucket] || 0) + 1, m), {}),
      };
      return withCors(new Response(JSON.stringify({
        items,
        count: items.length,              // flat count for easy UI consumption
        by_funnel: { wholesale: counts.wholesale, catering: counts.catering },
        counts,                            // detailed breakdown retained for compat
      }), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    // (duplicate /queue handler removed — the first handler above is canonical)
    // Phase D — per-step overrides (dual-funnel)
    if (path === '/overrides/save' && request.method === 'POST') {
      const b = await request.json();
      if (!b.lead_id || !b.funnel || b.step_n == null) {
        return withCors(new Response(JSON.stringify({ error: 'lead_id, funnel, step_n required' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
      }
      const id = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO lead_overrides (id, lead_id, funnel, step_n, custom_subject, custom_body, custom_send_at, skip, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(lead_id, funnel, step_n) DO UPDATE SET
          custom_subject = COALESCE(excluded.custom_subject, lead_overrides.custom_subject),
          custom_body = COALESCE(excluded.custom_body, lead_overrides.custom_body),
          custom_send_at = COALESCE(excluded.custom_send_at, lead_overrides.custom_send_at),
          skip = excluded.skip,
          updated_at = datetime('now')
      `).bind(
        id, b.lead_id, b.funnel, b.step_n,
        b.custom_subject || null, b.custom_body || null, b.custom_send_at || null,
        b.skip ? 1 : 0
      ).run();
      return withCors(new Response(JSON.stringify({ saved: true }), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (path.match(/^\/overrides\/get\//) && request.method === 'GET') {
      const parts = path.split('/');
      const funnel = parts[3]; const leadId = parts[4];
      const { results } = await env.DB.prepare(
        'SELECT * FROM lead_overrides WHERE funnel = ? AND lead_id = ? ORDER BY step_n ASC'
      ).bind(funnel, leadId).all().catch(() => ({ results: [] }));
      return withCors(new Response(JSON.stringify({ overrides: results || [] }), { headers: { 'Content-Type': 'application/json' } }));
    }
    // (legacy /queue/for-you-legacy-never-used handler removed — the canonical
    //  /queue/today handler above serves both paths via the OR condition.)

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

    // Direct outreach trigger + last run status (bypasses orchestrator scout→qualifier pipeline)
    if (path === '/outreach/run' && request.method === 'POST') return withCors(await outreach.fetch(request, env, ctx));
    if (path === '/outreach/last-run') return withCors(await outreach.fetch(request, env, ctx));

    // Pipeline routes (outreach holds + flags — dashboard views)
    if (path.startsWith('/pipeline/')) return withCors(await outreach.fetch(request, env, ctx));

    // SMS reply webhook (Swell CX inbound) — route to reply handler
    if (path === '/sms/webhook') return withCors(await replyHandler.fetch(request, env, ctx));

    // Reply inbox (before outreach catch-all)
    if (path.startsWith('/replies/')) return withCors(await replyHandler.fetch(request, env, ctx));

    // Account-worker endpoints under /outreach — must be before outreach catch-all
    if (path === '/outreach/summer-stats' || path === '/outreach/summer-instagram-queue' || path === '/outreach/summer-venues'
        || path === '/outreach/coach-voice' || path === '/outreach/redraft-all'
        || path === '/outreach/voice-embed' || path === '/outreach/voice-scan' || path === '/outreach/voice-similar') {
      return withCors(await account.fetch(request, env, ctx));
    }

    // Audit Gap 2 — router-owned outreach endpoints (must come BEFORE the catch-all below).
    if (path === '/outreach/kanban' || (path === '/outreach/move-stage' && request.method === 'POST')) {
      // Fall through to the router-level handler defined later in this file.
      // We duplicate-check here because `if (path.startsWith('/outreach/'))` below
      // would otherwise delegate to outreach-agent.js which doesn't implement these.
    } else if (path.startsWith('/outreach/')) {
      return withCors(await outreach.fetch(request, env, ctx));
    }

    // V3 Bug 1.5 — click tracking redirect endpoints live in outreach-agent.js
    if (path.startsWith('/track/')) return withCors(await outreach.fetch(request, env, ctx));

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

    // D1 backup endpoints (Foundation Safety Workstream 1, Task 3b)
    // Intercept BEFORE the /finance/ catch-all so backup routes don't fall through to finance-worker.
    if (path === '/finance/backup/run' || path === '/finance/backup/status') {
      return withCors(await handleD1BackupRequest(request, env));
    }

    // Finance v2 (Wave 1+ native bookkeeping endpoints)
    if (path.startsWith('/finance/')) return withCors(await finance.fetch(request, env, ctx));

    // QBO webhook (must come before /qbo/ catch-all)
    if (path === '/qbo/webhook' || path === '/qbo/events') return withCors(await qboWebhook.fetch(request, env, ctx));
    if (path === '/finance/plaid/webhook') {
      try {
        const payload = await request.json().catch(() => ({}));
        const { handleWebhook: plaidWebhook } = await import('./plaid-client.js');
        const result = await plaidWebhook(env, payload);
        return withCors(new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }));
      } catch (err) {
        return withCors(new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
      }
    }

    // QBO direct (test + debug + OAuth)
    if (path.startsWith('/qbo/')) return withCors(await qboClient.fetch(request, env, ctx));

    // Square webhook (real-time order + customer events)
    if (path === '/square/webhook' || path.startsWith('/square/')) return withCors(await squareSync.fetch(request, env, ctx));

    // Swell opt-out webhook (STOP replies → sms_suppressions)
    if (path === '/swell/webhook') return withCors(await retail.fetch(request, env, ctx));

    // Retail Agent (includes backfill trigger)
    if (path === '/retail/square-customers/sync' && request.method === 'POST') return withCors(await squareCustomerSync.fetch(request, env, ctx));
    if (path === '/retail/square-customers/denorm' && request.method === 'POST') return withCors(await squareCustomerSync.fetch(request, env, ctx));
    if (path === '/webhooks/resend' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/email/unsubscribe' && request.method === 'GET') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/test' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/cohort-a/run' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/suggestions/regenerate' && request.method === 'POST') return withCors(await retailSuggestionsWorker.fetch(request, env, ctx));
    if (path === '/retail/verdict/regenerate' && request.method === 'POST') return withCors(await retailVerdictGenerator.fetch(request, env, ctx));
    if (path === '/retail/code-expiration-cleaner/run' && (request.method === 'GET' || request.method === 'POST')) return withCors(await codeExpirationCleaner.fetch(request, env, ctx));
    if (path === '/retail/email/cohort-b/run' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/resend/webhooks' && request.method === 'GET') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/resend/domains' && request.method === 'GET') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/resend/enable-tracking' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/resend/email' && request.method === 'GET') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/open-rates' && request.method === 'GET') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/resend/subscribe-opens' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/backfill-opens' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path === '/retail/email/backfill-returns' && request.method === 'POST') return withCors(await emailSender.fetch(request, env, ctx));
    if (path.startsWith('/retail/')) return withCors(await retail.fetch(request, env, ctx));

    // Catering Agent
    if (path.startsWith('/catering-crossover/')) return withCors(await cateringCrossover.fetch(request, env, ctx));
    if (path.startsWith('/catering-scout/')) return withCors(await cateringScout.fetch(request, env, ctx));
    if (path.startsWith('/catering/')) return withCors(await catering.fetch(request, env, ctx));

    // Coach Agent
    if (path.startsWith('/coach/')) return withCors(await coach.fetch(request, env, ctx));

    // Agent activity feed (for Today dashboard page)
    if (path === '/agent/activity') return withCors(await orchestrator.fetch(request, env, ctx));

    // Orchestrator — pipeline coordination + agent activity log
    if (path.startsWith('/orchestrator/')) return withCors(await orchestrator.fetch(request, env, ctx));

    // Chat
    if (path.startsWith('/chat')) return withCors(await chat.fetch(request, env, ctx));

    // Dashboard: quick D1 stats
    if (path === '/stats') {
      return withCors(await getStats(env));
    }

    // Audit Gap 2 — endpoints specified in V3 plan Section E that weren't implemented first pass.

    // GET /outreach/kanban — returns venues grouped into spec's 7-column kanban.
    if (path === '/outreach/kanban') {
      const venues = await env.DB.prepare(`
        SELECT id, name, city, category, contact_email, status, tier, qual_score,
               CAST(julianday('now') - julianday(COALESCE(updated_at, created_at)) AS INTEGER) as days_in_stage
        FROM venues
        WHERE status NOT IN ('archived', 'lead_closed')
        ORDER BY tier ASC, qual_score DESC
        LIMIT 500
      `).all().catch(() => ({ results: [] }));
      // Map internal statuses → spec's 7-column scheme.
      const COL_MAP = {
        prospect: 'Prospect',
        researching: 'Researching',
        qualified: 'Researching',
        ready: 'Researching',
        draft_ready: 'Draft',
        drew_flag: 'Draft',
        hold: 'Draft',
        contacted: 'Sent',
        sent: 'Sent',
        replied: 'Replied',
        inbound: 'Replied',
        meeting: 'Meeting',
        trial: 'Meeting',
        active: 'Won',
      };
      const columns = { Prospect: [], Researching: [], Draft: [], Sent: [], Replied: [], Meeting: [], Won: [] };
      for (const v of (venues.results || [])) {
        const col = COL_MAP[v.status] || 'Prospect';
        columns[col].push(v);
      }
      return withCors(new Response(
        JSON.stringify({ columns, total: (venues.results || []).length, generated_at: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json' } }
      ));
    }

    // POST /outreach/move-stage — move a venue to a new status column.
    if (path === '/outreach/move-stage' && request.method === 'POST') {
      try {
        const { venue_id, status } = await request.json();
        if (!venue_id || !status) return withCors(new Response(JSON.stringify({ error: 'venue_id + status required' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
        const ALLOWED = new Set(['prospect', 'researching', 'qualified', 'ready', 'draft_ready', 'drew_flag', 'hold', 'contacted', 'sent', 'replied', 'inbound', 'meeting', 'trial', 'active', 'archived', 'lead_closed']);
        if (!ALLOWED.has(status)) return withCors(new Response(JSON.stringify({ error: 'invalid status: ' + status }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
        await env.DB.prepare(`UPDATE venues SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(status, venue_id).run();
        return withCors(new Response(JSON.stringify({ ok: true, venue_id, status }), { headers: { 'Content-Type': 'application/json' } }));
      } catch (err) {
        return withCors(new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
      }
    }

    // GET /money/ar-breakdown — past-due AR grouped by age bucket.
    if (path === '/money/ar-breakdown') {
      const flags = await env.DB.prepare(`
        SELECT id, entity_name, title, detail, data_point, suggested_action, severity, created_at
        FROM financial_flags
        WHERE status = 'open'
          AND (snooze_until IS NULL OR snooze_until <= datetime('now'))
          AND (flag_type = 'overdue_ar' OR flag_type LIKE '%ar%')
        ORDER BY created_at DESC
      `).all().catch(() => ({ results: [] }));
      // Dedup by entity, parse dollars, bucket by age.
      const parseDollars = (t) => { if (!t) return 0; const m = String(t).match(/\$([\d,]+(?:\.\d+)?)/); return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) || 0) : 0; };
      const byEntity = {};
      for (const f of (flags.results || [])) {
        const e = (f.entity_name || 'Unknown').replace('(global)', 'Unknown');
        if (!byEntity[e] || new Date(f.created_at || 0) > new Date(byEntity[e].created_at || 0)) byEntity[e] = f;
      }
      const rows = Object.entries(byEntity).map(([entity, f]) => {
        const dollars = parseDollars(f.data_point) || parseDollars(f.title) || parseDollars(f.detail);
        const ageDays = f.created_at ? Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000) : 0;
        const bucket = ageDays <= 30 ? '0-30' : ageDays <= 60 ? '31-60' : ageDays <= 90 ? '61-90' : '90+';
        return { entity, dollars, age_days: ageDays, bucket, flag_id: f.id, title: f.title, severity: f.severity, suggested_action: f.suggested_action };
      }).sort((a, b) => b.dollars - a.dollars);
      const totals = rows.reduce((acc, r) => { acc.total += r.dollars; acc.by_bucket[r.bucket] = (acc.by_bucket[r.bucket] || 0) + r.dollars; return acc; }, { total: 0, by_bucket: {} });
      return withCors(new Response(
        JSON.stringify({ rows, totals, count: rows.length, generated_at: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json' } }
      ));
    }

    // GET /agent/:name/last-failure — most recent failed run for this agent.
    if (path.startsWith('/agent/') && path.endsWith('/last-failure')) {
      const agentName = path.slice('/agent/'.length, -'/last-failure'.length);
      const row = await env.DB.prepare(
        `SELECT id, agent, cron, status, started_at, completed_at, duration_ms, error, summary
         FROM cron_runs WHERE agent = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 1`
      ).bind(agentName).first().catch(() => null);
      return withCors(new Response(
        JSON.stringify({ agent: agentName, last_failure: row || null }),
        { headers: { 'Content-Type': 'application/json' } }
      ));
    }

    // POST /agent/:name/retry — manually re-trigger an agent run.
    // Maps common agent names to their existing trigger endpoints.
    if (path.startsWith('/agent/') && path.endsWith('/retry') && request.method === 'POST') {
      const agentName = path.slice('/agent/'.length, -'/retry'.length);
      const TRIGGERS = {
        cfo: async () => { const r = await cfo.fetch(new Request(new URL('/cfo/run', request.url)), env, ctx); return { ok: r.ok, status: r.status }; },
        outreach: async () => { const r = await outreach.fetch(new Request(new URL('/outreach/run', request.url), { method: 'POST' }), env, ctx); return { ok: r.ok, status: r.status }; },
        retail: async () => { const r = await retail.fetch(new Request(new URL('/retail/run', request.url)), env, ctx); return { ok: r.ok, status: r.status }; },
        catering: async () => { const r = await catering.fetch(new Request(new URL('/catering/run', request.url), { method: 'POST' }), env, ctx); return { ok: r.ok, status: r.status }; },
        reviews: async () => { const r = await account.fetch(new Request(new URL('/reviews/run-cron', request.url), { method: 'POST' }), env, ctx); return { ok: r.ok, status: r.status }; },
      };
      const trigger = TRIGGERS[agentName];
      if (!trigger) return withCors(new Response(JSON.stringify({ error: 'no retry handler for agent: ' + agentName, available: Object.keys(TRIGGERS) }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
      try {
        const result = await trigger();
        return withCors(new Response(JSON.stringify({ retried: agentName, ...result }), { headers: { 'Content-Type': 'application/json' } }));
      } catch (err) {
        return withCors(new Response(JSON.stringify({ error: err.message, agent: agentName }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
      }
    }

    // Tier 2a — consolidated system health. One call the System tab uses to
    // paint a big green/amber/red grid: every critical agent's last run + age
    // vs expected cadence, count of unacked alerts, count of active SMS
    // campaigns, plus overall "all systems normal" / "needs attention" flag.
    // Expected cadence is hardcoded here; adjust when wrangler.toml crons change.
    if (path === '/system/status') {
      // Expected-interval (hours) per agent. If last-run is older than 2x this, amber;
      // if older than 3x or status='failed', red.
      const EXPECTED_CADENCE_HOURS = {
        cfo: 24 * 7,                    // Sun 10pm weekly
        optimizer: 24 * 7,              // Sun 11pm weekly
        scout: 24 * 7,                  // Mon 6am weekly
        qualifier: 24 * 3.5,            // Mon + Thu — avg ~3.5d
        outreach: 24,                   // Mon-Fri daily
        catering: 24 * 2.5,             // Mon/Wed/Fri
        account: 24 * 7,                // Mon 9am weekly
        pilot: 24 * 7,                  // Fri 8am weekly
        signal_scanner: 24,             // Daily 6:30am
        account_sync: 24,               // Daily 4am
        qbo_sync: 24,
        square_sync: 24,
        reviews: 24,                    // Daily 2pm
        retail: 24,                     // Daily 2pm
        cfo_pulse: 1,                   // Hourly
        reply_scanner: 0.5,             // Every 15 min
        weekly_digest: 24 * 7,          // Fri 5pm weekly
        cfo_daily_close: 24,
        cfo_daily_recon: 24,
        cfo_monthly_close: 24 * 32,     // 1st of month
        cfo_weekly_directive: 24 * 7,
        cfo_audit_tier1: 1,             // Hourly :05
        catering_scout: 24 * 7,
        catering_crossover: 24,
      };
      const now = Date.now();
      const agents = await env.DB.prepare(`
        SELECT cr.agent, cr.status, cr.started_at, cr.completed_at, cr.duration_ms, cr.error
        FROM cron_runs cr
        INNER JOIN (SELECT agent, MAX(started_at) as max_started FROM cron_runs GROUP BY agent) latest
          ON cr.agent = latest.agent AND cr.started_at = latest.max_started
        ORDER BY cr.agent
      `).all();

      const rows = [];
      let worstLevel = 'green';  // 'green' | 'amber' | 'red'
      const bumpWorst = (l) => {
        if (l === 'red' || worstLevel === 'red') worstLevel = 'red';
        else if (l === 'amber' || worstLevel === 'amber') worstLevel = 'amber';
      };
      for (const a of (agents.results || [])) {
        const expectedH = EXPECTED_CADENCE_HOURS[a.agent] || 24;
        const ageH = a.started_at ? (now - new Date(a.started_at + 'Z').getTime()) / 3600000 : Infinity;
        let level = 'green';
        let reason = null;
        if (a.status === 'failed') { level = 'red'; reason = 'last run failed'; }
        else if (a.status === 'running' && ageH > 1) { level = 'amber'; reason = 'stuck running'; }
        else if (ageH > expectedH * 3) { level = 'red'; reason = `no run in ${Math.round(ageH)}h (expected every ${expectedH}h)`; }
        else if (ageH > expectedH * 2) { level = 'amber'; reason = `stale: ${Math.round(ageH)}h ago (expected every ${expectedH}h)`; }
        bumpWorst(level);
        rows.push({
          agent: a.agent,
          status: a.status,
          started_at: a.started_at,
          completed_at: a.completed_at,
          duration_ms: a.duration_ms,
          expected_cadence_hours: expectedH,
          age_hours: Math.round(ageH * 10) / 10,
          level,
          reason,
          error: a.error ? a.error.slice(0, 200) : null,
        });
      }

      // Add "never ran" rows for expected agents that have no cron_runs history yet.
      const seenAgents = new Set(rows.map(r => r.agent));
      for (const [agent, expectedH] of Object.entries(EXPECTED_CADENCE_HOURS)) {
        if (!seenAgents.has(agent)) {
          rows.push({
            agent, status: 'never_ran', started_at: null, expected_cadence_hours: expectedH,
            age_hours: null, level: 'amber', reason: 'never ran', error: null,
          });
          bumpWorst('amber');
        }
      }

      // Unacked alerts
      const alertSummary = await env.DB.prepare(`
        SELECT COUNT(*) as unacked,
               SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) as critical_unacked
        FROM system_alerts WHERE acked_at IS NULL
      `).first();
      if ((alertSummary?.critical_unacked || 0) > 0) bumpWorst('red');
      else if ((alertSummary?.unacked || 0) > 0) bumpWorst('amber');

      // Active SMS campaigns (Tier 1a integration)
      const smsSummary = await env.DB.prepare(`
        SELECT
          SUM(CASE WHEN paused_at IS NULL AND status='active' THEN 1 ELSE 0 END) as active_sending,
          SUM(CASE WHEN paused_at IS NOT NULL AND pause_reason='emergency_kill_switch' THEN 1 ELSE 0 END) as emergency_paused
        FROM retail_campaigns
      `).first();
      if ((smsSummary?.emergency_paused || 0) > 0) bumpWorst('amber');

      return withCors(new Response(JSON.stringify({
        overall_level: worstLevel,
        agents: rows.sort((a, b) => {
          const prio = { red: 0, amber: 1, green: 2 };
          return (prio[a.level] ?? 3) - (prio[b.level] ?? 3) || a.agent.localeCompare(b.agent);
        }),
        alerts: {
          unacked: alertSummary?.unacked || 0,
          critical_unacked: alertSummary?.critical_unacked || 0,
        },
        sms: {
          active_sending: smsSummary?.active_sending || 0,
          emergency_paused: smsSummary?.emergency_paused || 0,
        },
        generated_at: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json' } }));
    }

    // Tier 1b — System alerts API.
    //   GET  /system/alerts          → unacked alerts (last 50, newest first) + counts
    //   POST /system/alerts/:id/ack  → mark one alert acked
    //   POST /system/alerts/ack-all  → nuke all unacked
    if (path === '/system/alerts' && request.method === 'GET') {
      const [unacked, summary] = await Promise.all([
        env.DB.prepare(`
          SELECT id, created_at, severity, source, subject, body,
                 email_status, email_error, fallback_status, fallback_error
          FROM system_alerts
          WHERE acked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 50
        `).all(),
        env.DB.prepare(`
          SELECT
            SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END) as unacked,
            SUM(CASE WHEN email_status='failed' AND acked_at IS NULL THEN 1 ELSE 0 END) as email_failures,
            SUM(CASE WHEN fallback_status='sms_failed' AND acked_at IS NULL THEN 1 ELSE 0 END) as sms_failures,
            MAX(created_at) as last_alert_at
          FROM system_alerts
        `).first(),
      ]);
      return withCors(new Response(JSON.stringify({
        alerts: unacked.results || [],
        summary: summary || {},
      }), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (path === '/system/alerts/ack-all' && request.method === 'POST') {
      const r = await env.DB.prepare(
        `UPDATE system_alerts SET acked_at=datetime('now'), acked_by='drew' WHERE acked_at IS NULL`
      ).run();
      return withCors(new Response(JSON.stringify({ acked: r.meta?.changes || 0 }), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (path.startsWith('/system/alerts/') && path.endsWith('/ack') && request.method === 'POST') {
      const alertId = path.slice('/system/alerts/'.length, -'/ack'.length);
      const r = await env.DB.prepare(
        `UPDATE system_alerts SET acked_at=datetime('now'), acked_by='drew' WHERE id=? AND acked_at IS NULL`
      ).bind(alertId).run();
      if ((r.meta?.changes || 0) === 0) {
        return withCors(new Response(JSON.stringify({ error: 'Alert not found or already acked' }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      return withCors(new Response(JSON.stringify({ acked: true, id: alertId }), { headers: { 'Content-Type': 'application/json' } }));
    }

    // V3 Item 2.27 + Add-on (a) — real connection-status tiles with signal quality.
    // QBO token age, Gmail token presence, Square webhook recency + phone attachment %,
    // Swell SMS last-success, Toast deprecation note.
    if (path === '/system/connections') {
      const tiles = [];
      const now = Date.now();
      // Helper: "N min ago" style
      const ago = (iso) => {
        if (!iso) return null;
        const ms = now - new Date(iso.includes('T') ? iso : iso + 'Z').getTime();
        if (ms < 60000) return Math.floor(ms / 1000) + 's ago';
        if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
        if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
        return Math.floor(ms / 86400000) + 'd ago';
      };
      // QBO — refresh token in KV (qbo_refresh_token), access token in KV (qbo_access_token as JSON).
      // Tier 2c — surface refresh-token age so Drew can re-auth before the 101d
      // expiry silently kills QBO sync. Tracked via qbo_refresh_token_rotated_at.
      try {
        const refreshToken = await env.KV.get('qbo_refresh_token');
        const rotatedAt = await env.KV.get('qbo_refresh_token_rotated_at');
        const accessRaw = await env.KV.get('qbo_access_token');
        let accessInfo = null;
        try { accessInfo = accessRaw ? JSON.parse(accessRaw) : null; } catch {}
        if (refreshToken) {
          const accessMs = accessInfo?.expires_at ? accessInfo.expires_at - now : null;
          const mins = accessMs != null ? Math.floor(accessMs / 60000) : null;
          // 101-day QBO refresh token lifetime. Warn at ≤14d remaining, fail at expired.
          let refreshDaysLeft = null;
          if (rotatedAt) {
            const ageDays = (now - new Date(rotatedAt).getTime()) / 86400000;
            refreshDaysLeft = Math.max(0, Math.round(101 - ageDays));
          }
          let status = 'ok';
          let detail;
          if (refreshDaysLeft != null && refreshDaysLeft <= 0) {
            status = 'fail';
            detail = 'Refresh token EXPIRED — re-auth at /qbo/oauth now';
          } else if (refreshDaysLeft != null && refreshDaysLeft <= 14) {
            status = 'warn';
            detail = `Refresh token expires in ${refreshDaysLeft}d — re-auth at /qbo/oauth soon`;
          } else if (mins == null) {
            detail = 'Refresh token present' + (refreshDaysLeft != null ? ` · ${refreshDaysLeft}d until expiry` : '');
          } else if (mins > 0) {
            detail = 'Access token valid ' + mins + 'm' + (refreshDaysLeft != null ? ` · ${refreshDaysLeft}d until refresh expiry` : '');
          } else {
            detail = 'Access token expired — auto-refresh on next call' + (refreshDaysLeft != null ? ` · ${refreshDaysLeft}d until refresh expiry` : '');
          }
          tiles.push({
            name: 'QuickBooks Online',
            key: 'qbo',
            status,
            detail,
            signal: { refresh_days_remaining: refreshDaysLeft },
          });
        } else {
          tiles.push({ name: 'QuickBooks Online', key: 'qbo', status: 'fail', detail: 'Not connected — visit /qbo/oauth' });
        }
      } catch (e) {
        tiles.push({ name: 'QuickBooks Online', key: 'qbo', status: 'warn', detail: 'Lookup error: ' + e.message.slice(0, 60) });
      }
      // Gmail — refresh token presence + last send age
      try {
        const lastSend = await env.DB.prepare(
          `SELECT MAX(sent_at) as last_sent FROM outreach_logs WHERE direction='out' AND sent_at IS NOT NULL`
        ).first();
        const has = !!env.GMAIL_REFRESH_TOKEN;
        tiles.push({
          name: 'Gmail',
          key: 'gmail',
          status: has ? (lastSend?.last_sent ? 'ok' : 'warn') : 'fail',
          detail: has ? (lastSend?.last_sent ? 'Last send ' + ago(lastSend.last_sent) : 'Token present, no sends yet')
                      : 'GMAIL_REFRESH_TOKEN missing',
        });
      } catch (e) {
        tiles.push({ name: 'Gmail', key: 'gmail', status: 'warn', detail: 'Lookup error' });
      }
      // Square — last webhook hit + phone attachment % (Add-on a).
      // Note: 4-10% phone attach is the realistic baseline for a walk-in retail
      // shop where most transactions don't go through Square's loyalty flow.
      // Only flag fail if webhook is silent; warn when attach rate is <2% or
      // when we're unusually below the 7-day trailing rate.
      try {
        const last24 = await env.DB.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN customer_phone IS NOT NULL AND customer_phone != '' THEN 1 ELSE 0 END) as with_phone,
                 MAX(order_date) as last_order
          FROM orders
          WHERE source='square' AND order_date >= datetime('now','-24 hours')
        `).first();
        const last7d = await env.DB.prepare(`
          SELECT COUNT(*) as total,
                 SUM(CASE WHEN customer_phone IS NOT NULL AND customer_phone != '' THEN 1 ELSE 0 END) as with_phone
          FROM orders
          WHERE source='square' AND order_date >= datetime('now','-7 days')
        `).first();
        const pct24 = last24?.total ? Math.round((last24.with_phone / last24.total) * 100) : null;
        const pct7d = last7d?.total ? Math.round((last7d.with_phone / last7d.total) * 100) : null;
        const lastHit = last24?.last_order;
        let status = 'ok', detail;
        if (!lastHit) {
          status = 'warn';
          detail = 'No Square orders in last 24h';
        } else if (pct24 != null && pct24 < 2) {
          status = 'warn';
          detail = last24.total + ' orders (24h) · ' + pct24 + '% phone (unusual — check POS capture) · last ' + ago(lastHit);
        } else {
          detail = last24.total + ' orders (24h) · ' + (pct24 != null ? pct24 + '% phone' : 'phone attach unknown') + ' (7d avg ' + (pct7d != null ? pct7d + '%' : '—') + ') · last ' + ago(lastHit);
        }
        tiles.push({ name: 'Square POS', key: 'square', status, detail, signal: { orders_24h: last24?.total || 0, phone_pct_24h: pct24, phone_pct_7d: pct7d } });
      } catch (e) {
        tiles.push({ name: 'Square POS', key: 'square', status: 'warn', detail: 'Lookup error: ' + e.message.slice(0, 60) });
      }
      // Swell CX — last successful campaign send
      try {
        const lastSms = await env.DB.prepare(
          `SELECT MAX(sent_at) as last_sent FROM retail_campaign_sends WHERE sent_at IS NOT NULL`
        ).first();
        const has = !!env.SWELLCX_API_KEY;
        tiles.push({
          name: 'Swell CX (SMS)',
          key: 'swell',
          status: has ? (lastSms?.last_sent ? 'ok' : 'warn') : 'fail',
          detail: has ? (lastSms?.last_sent ? 'Last SMS ' + ago(lastSms.last_sent) : 'Token present, no SMS yet')
                      : 'SWELLCX_API_KEY missing',
        });
      } catch (e) {
        tiles.push({ name: 'Swell CX (SMS)', key: 'swell', status: 'warn', detail: 'Lookup error' });
      }
      // Toast — explicitly deprecated
      tiles.push({
        name: 'Toast POS',
        key: 'toast',
        status: 'deprecated',
        detail: 'Toast POS deprecated — migrated to Square April 2026',
      });
      // Vectorize — KV presence check
      try {
        const hasVec = !!env.VECTORIZE || !!env.VECTORIZE_OUTREACH;
        tiles.push({
          name: 'Vectorize',
          key: 'vectorize',
          status: hasVec ? 'ok' : 'warn',
          detail: hasVec ? 'Binding present' : 'Binding missing',
        });
      } catch {
        tiles.push({ name: 'Vectorize', key: 'vectorize', status: 'warn', detail: 'Unknown' });
      }
      return withCors(new Response(
        JSON.stringify({ tiles, generated_at: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json' } }
      ));
    }

    // V3 Item 2.3 — Today page decision cards, server-synthesized.
    // Up to 5 cards ranked by priority then $ impact.
    if (path === '/today/decisions') {
      const cards = await getTodayDecisions(env);
      return withCors(new Response(
        JSON.stringify({ cards, generated_at: new Date().toISOString() }),
        { headers: { 'Content-Type': 'application/json' } }
      ));
    }

    // Note: /cron/health handled earlier in this file (line ~356).

    // Pretzel Program landing page — redirect to Pages deployment
    if (path === '/pretzel-program' || path === '/pretzel-program.html') {
      return Response.redirect('https://pretzel-website-31s.pages.dev/pretzel-program.html', 302);
    }

    return new Response('Pretzel OS — dangerouspretzel.com', { status: 200, headers: corsHeaders });
  }
};

// ── V3 Item 2.3 — TODAY DECISION SYNTHESIZER ─────────────────────────────────
// Pulls the highest-priority things Drew should address today, across:
//   1. Open critical/high financial flags (with $ impact)
//   2. Unreplied inbound replies (age-weighted urgency)
//   3. At-risk accounts (silent >30d with meaningful revenue history)
//   4. Pending outreach approvals (surface if nothing else is urgent)
// Returns up to 5 cards ranked by priority desc, then $ impact desc.
async function getTodayDecisions(env) {
  const cards = [];

  // 1. Financial flags
  try {
    const flags = await env.DB.prepare(`
      SELECT id, severity, entity_name, title, detail, suggested_action,
             data_point, created_at
      FROM financial_flags
      WHERE status = 'open' AND severity IN ('critical','high')
      ORDER BY created_at DESC
      LIMIT 20
    `).all();
    for (const f of (flags.results || [])) {
      const dollars = parseDollarsFromText(f.data_point) || parseDollarsFromText(f.title) || parseDollarsFromText(f.detail);
      cards.push({
        type: 'financial_flag',
        priority: f.severity === 'critical' ? 100 : 80,
        dollars,
        title: f.title || 'Financial flag',
        subtitle: f.entity_name && f.entity_name !== '(global)' ? f.entity_name : null,
        action: f.suggested_action || 'Review',
        meta: { flag_id: f.id, severity: f.severity, created_at: f.created_at },
        cta: { label: 'Address now', href: `/money#flag-${f.id}` },
      });
    }
  } catch (e) { console.error('[today/decisions] flags failed:', e.message); }

  // 2. Unreplied inbound replies
  try {
    const replies = await env.DB.prepare(`
      SELECT id, from_email, from_name, subject, received_at, urgency
      FROM inbound_replies
      WHERE status = 'open'
        AND received_at >= datetime('now','-7 days')
      ORDER BY received_at DESC
      LIMIT 10
    `).all();
    for (const r of (replies.results || [])) {
      const ageHrs = Math.max(0, (Date.now() - new Date(r.received_at).getTime()) / 3600000);
      const priority = r.urgency === 'high' ? 90 : ageHrs > 24 ? 75 : 60;
      cards.push({
        type: 'reply',
        priority,
        dollars: 0,
        title: `Reply from ${r.from_name || r.from_email}`,
        subtitle: r.subject || '(no subject)',
        action: ageHrs > 24 ? 'Reply (over 1 day old)' : 'Reply',
        meta: { reply_id: r.id, age_hours: Math.round(ageHrs) },
        cta: { label: 'Open reply', href: `/outreach#reply-${r.id}` },
      });
    }
  } catch (e) { console.error('[today/decisions] replies failed:', e.message); }

  // 3. At-risk accounts
  try {
    const atRisk = await env.DB.prepare(`
      SELECT aa.id, v.name, aa.last_order_date, aa.avg_monthly_rev,
             CAST(julianday('now') - julianday(aa.last_order_date) AS INTEGER) as days_silent
      FROM active_accounts aa
      JOIN venues v ON v.id = aa.venue_id
      WHERE aa.warmer_removed_at IS NULL
        AND aa.last_order_date IS NOT NULL
        AND julianday('now') - julianday(aa.last_order_date) > 30
        AND aa.avg_monthly_rev > 100
      ORDER BY aa.avg_monthly_rev DESC
      LIMIT 10
    `).all();
    for (const a of (atRisk.results || [])) {
      const dollars = Math.round(a.avg_monthly_rev || 0);
      cards.push({
        type: 'at_risk_account',
        priority: a.days_silent > 60 ? 85 : 70,
        dollars,
        title: `${a.name} — ${a.days_silent}d silent`,
        subtitle: `$${dollars}/mo avg · last order ${a.last_order_date}`,
        action: 'Call or re-engage',
        meta: { account_id: a.id, days_silent: a.days_silent },
        cta: { label: 'Open account', href: `/accounts#${a.id}` },
      });
    }
  } catch (e) { console.error('[today/decisions] at_risk failed:', e.message); }

  // 4. Pending outreach approvals
  try {
    const pending = await env.DB.prepare(`
      SELECT ol.id, v.name, ol.subject, ol.created_at
      FROM outreach_logs ol
      JOIN venues v ON v.id = ol.venue_id
      WHERE ol.approval_status = 'pending' AND ol.sent_at IS NULL
      ORDER BY ol.created_at DESC
      LIMIT 5
    `).all();
    for (const p of (pending.results || [])) {
      cards.push({
        type: 'pending_approval',
        priority: 50,
        dollars: 0,
        title: `Approve email to ${p.name}`,
        subtitle: p.subject || '(no subject)',
        action: 'Review draft',
        meta: { log_id: p.id },
        cta: { label: 'Review & send', href: `/outreach#approval-${p.id}` },
      });
    }
  } catch (e) { console.error('[today/decisions] pending failed:', e.message); }

  // Sort: priority desc, then $ desc, then newest first
  cards.sort((a, b) =>
    (b.priority - a.priority) ||
    (b.dollars - a.dollars)
  );
  return cards.slice(0, 5);
}

function parseDollarsFromText(text) {
  if (!text) return 0;
  const m = String(text).match(/\$([\d,]+(?:\.\d+)?)/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) || 0);
}

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
