// workers/finance-email-briefs.js
// Finance v2 — Daily + weekly email briefs to Drew.
//
// Simple Gmail send via the existing OAuth refresh token used by the rest of
// Pretzel OS. Renders a compact HTML summary of the latest close/directive.
//
// Called from: router.js cron schedules (after daily close / weekly directive runs).

async function getGmailToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error('Gmail token refresh failed');
  return (await resp.json()).access_token;
}

async function sendEmail(env, { subject, html }) {
  try {
    const token = await getGmailToken(env);
    const toAddr = env.DREW_EMAIL || 'drew@dangerouspretzel.com';
    const fromAddr = env.FROM_EMAIL || toAddr;

    const message = [
      `To: ${toAddr}`,
      `From: Pretzel OS CFO <${fromAddr}>`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
    ].join('\r\n');

    const bytes = new TextEncoder().encode(message);
    const encoded = btoa(Array.from(bytes, b => String.fromCodePoint(b)).join(''))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // Log to audit but don't throw — a failed email should not break daily close.
      try {
        await env.DB.prepare(`
          INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
          VALUES (?, 'email_send_failed', 'cfo_briefs', ?, 'cfo_agent', ?)
        `).bind(crypto.randomUUID(), subject.slice(0, 120), `Gmail send failed ${resp.status}: ${body.slice(0, 300)}`).run();
      } catch {}
      return false;
    }
    return true;
  } catch (err) {
    // Token refresh or network failure — swallow so caller flow continues.
    try {
      await env.DB.prepare(`
        INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
        VALUES (?, 'email_send_failed', 'cfo_briefs', ?, 'cfo_agent', ?)
      `).bind(crypto.randomUUID(), subject.slice(0, 120), `Gmail exception: ${(err.message || '').slice(0, 300)}`).run();
    } catch {}
    return false;
  }
}

function fmtMoney(n) { return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// ── Gather latest reconciliation snapshot for email body ─────────────────
async function getReconSnapshot(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT content FROM cfo_briefs WHERE type = 'daily_recon' ORDER BY brief_date DESC LIMIT 1`
    ).first();
    if (!row) return null;
    return JSON.parse(row.content);
  } catch { return null; }
}

// Pull the last 5 unreconciled (categorized but not yet reconciled) Mercury txns for context.
async function getUnreconciledTxns(env, limit = 5) {
  const { results } = await env.DB.prepare(`
    SELECT txn_date, counterparty_name, amount, proposed_confidence
    FROM mercury_transactions
    WHERE is_reconciled = 0 AND proposed_account_id IS NOT NULL
    ORDER BY ABS(amount) DESC
    LIMIT ?
  `).bind(limit).all();
  return results || [];
}

// ── Daily close email (fires after runDailyClose) ─────────────────────────
export async function sendDailyCloseEmail(env, closeResult) {
  if (!closeResult) return { sent: false, reason: 'no close result' };
  const s = closeResult.steps || {};
  const f = s.forecast || {};

  // M4: Reconciliation section
  const recon = await getReconSnapshot(env);
  const unreconSample = await getUnreconciledTxns(env);

  const reconHtml = recon ? `
  <h3 style="font-size:14px;margin:24px 0 8px 0">Reconciliation</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td style="padding:4px 0;color:#666">Max Mercury-vs-books variance</td><td style="text-align:right;font-family:monospace;color:${(recon.max_variance || 0) > 50 ? '#ef4444' : (recon.max_variance || 0) > 1 ? '#f59e0b' : '#22c55e'}">${fmtMoney(recon.max_variance)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Read-only mode</td><td style="text-align:right;color:${recon.read_only_mode_active ? '#ef4444' : '#22c55e'}">${recon.read_only_mode_active ? '⚠ TRIPPED — posting blocked' : 'Off'}</td></tr>
  </table>
  ${recon.accounts && recon.accounts.length ? `
  <table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;background:#fafafa">
    <tr><th style="padding:4px 8px;text-align:left;font-size:11px;color:#666">Account</th><th style="padding:4px 8px;text-align:right;font-size:11px;color:#666">Live</th><th style="padding:4px 8px;text-align:right;font-size:11px;color:#666">Book</th><th style="padding:4px 8px;text-align:right;font-size:11px;color:#666">Variance</th></tr>
    ${recon.accounts.map(a => `<tr><td style="padding:4px 8px">${String(a.account).replace(/</g, '&lt;')}</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(a.live_balance)}</td><td style="padding:4px 8px;text-align:right;font-family:monospace">${fmtMoney(a.book_balance)}</td><td style="padding:4px 8px;text-align:right;font-family:monospace;color:${Math.abs(a.variance || 0) > 1 ? '#ef4444' : '#888'}">${fmtMoney(a.variance)}</td></tr>`).join('')}
  </table>` : ''}
  ${unreconSample.length ? `
  <p style="margin:12px 0 4px 0;font-size:12px;color:#666"><b>Top 5 unreconciled txns (by $ magnitude):</b></p>
  <ul style="margin:0 0 0 20px;padding:0;font-size:11px;color:#555">
    ${unreconSample.map(t => `<li style="margin:2px 0">${t.txn_date.slice(0, 10)} · ${String(t.counterparty_name || '').slice(0, 40).replace(/</g, '&lt;')} · ${fmtMoney(t.amount)} · conf ${(t.proposed_confidence || 0).toFixed(2)}</li>`).join('')}
  </ul>` : ''}
  ` : '';

  // Phase 5: outcome banner at the top of the email so a stuck pipeline
  // can't hide behind clean-looking forecast numbers.
  const o = closeResult.outcome || {};
  let outcomeBanner = '';
  if (o.blocked_by_read_only) {
    outcomeBanner = `
  <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:14px 18px;margin:0 0 18px 0;color:#7f1d1d">
    <div style="font-weight:700;font-size:14px;margin-bottom:4px">⚠ Pipeline blocked — read-only mode active</div>
    <div style="font-size:12px;line-height:1.4">Daily close ran but post-jes + sweep were skipped because <code>FINANCE_READ_ONLY</code> is on.<br>
    Reason: <em>${(o.read_only_reason || 'no reason recorded').replace(/</g, '&lt;')}</em><br>
    <b>Action:</b> Investigate via /finance/audit/latest, then either resolve the corruption check OR clear read-only manually.</div>
  </div>`;
  } else if (!o.did_useful_work && (o.new_txns_synced > 0 || o.txns_categorized > 0)) {
    outcomeBanner = `
  <div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:14px 18px;margin:0 0 18px 0;color:#78350f">
    <div style="font-weight:700;font-size:14px;margin-bottom:4px">⚠ 0 JEs posted</div>
    <div style="font-size:12px;line-height:1.4">${o.txns_categorized} txns processed by categorizer but none crossed the 0.90 confidence threshold for auto-posting.<br>
    <b>Action:</b> Walk the review queue at <a href="https://pretzel-dashboard.pages.dev/#money">Money page</a> — bulk-approve repeat counterparties.</div>
  </div>`;
  } else if (o.did_useful_work) {
    outcomeBanner = `
  <div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:10px 14px;margin:0 0 18px 0;color:#14532d;font-size:12px">
    <b>✓</b> ${o.jes_posted} JEs posted (${fmtMoney(o.jes_posted_debit)})${o.sweep_count > 0 ? ` · ${fmtMoney(o.sweep_total)} swept across ${o.sweep_count} channels` : ''}
  </div>`;
  }

  const html = `
<div style="font-family:Georgia,serif;max-width:600px;padding:20px;color:#222">
  <h2 style="margin:0 0 8px 0;border-bottom:2px solid #c41e1e;padding-bottom:8px">Daily Close — ${closeResult.close_date}</h2>
  <p style="color:#666;font-size:12px;margin:0 0 20px 0">${closeResult.ok ? '✓ Clean run' : '⚠ Partial step failure'} in ${closeResult.duration_ms}ms</p>
  ${outcomeBanner}

  <h3 style="font-size:14px;margin:16px 0 8px 0">Cash position</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td style="padding:4px 0;color:#666">Projected ending (30d)</td><td style="text-align:right;font-family:monospace">${fmtMoney(f.ending_balance)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Lowest forecast day</td><td style="text-align:right;font-family:monospace">${f.lowest_day?.date || '—'} at ${fmtMoney(f.lowest_day?.balance)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Net change projected</td><td style="text-align:right;font-family:monospace;color:${(f.projected_net_change || 0) >= 0 ? '#22c55e' : '#ef4444'}">${(f.projected_net_change || 0) >= 0 ? '+' : ''}${fmtMoney(f.projected_net_change)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Goes negative?</td><td style="text-align:right;color:${f.goes_negative ? '#ef4444' : '#22c55e'}">${f.goes_negative ? 'YES — action required' : 'No'}</td></tr>
  </table>

  <h3 style="font-size:14px;margin:24px 0 8px 0">Pipeline activity</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td style="padding:4px 0;color:#666">Mercury txns synced</td><td style="text-align:right;font-family:monospace">${s.mercury_sync?.inserted || 0}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Categorized today</td><td style="text-align:right;font-family:monospace">${s.categorize?.categorized_by_rule || 0} by rule · ${s.categorize?.queued_for_review || 0} needing review</td></tr>
    <tr><td style="padding:4px 0;color:#666">Journal entries posted</td><td style="text-align:right;font-family:monospace">${s.post_jes?.posted || 0} · ${fmtMoney(s.post_jes?.total_debit)}</td></tr>
  </table>

  ${reconHtml}

  ${(s.categorize?.queued_for_review || 0) > 0 ? `<p style="background:#fff9e6;border-left:3px solid #f59e0b;padding:10px 14px;margin:16px 0;font-size:13px"><b>${s.categorize.queued_for_review} txns queued for your review</b> — <a href="https://pretzel-dashboard.pages.dev/#money">open Money page</a> to categorize.</p>` : ''}

  <p style="margin:24px 0 0 0;font-size:11px;color:#888">
    Details: <a href="https://pretzel-os.drew-f39.workers.dev/finance/cfo/posted-stats">posted-stats</a> ·
    <a href="https://pretzel-os.drew-f39.workers.dev/finance/cfo/forecast">forecast</a> ·
    <a href="https://pretzel-os.drew-f39.workers.dev/finance/cfo/categorize-stats">review queue</a>
  </p>
</div>`.trim();

  // Phase 5 reset Apr 30 2026: outcome-based subject. The previous "✓"
  // showed up even when 0 JEs were posted because read-only blocked the work.
  // Now the subject reflects what actually happened, so a stuck pipeline is
  // visible at a glance without opening the email. (Reuses `o` declared above.)
  let subject;
  if (o.blocked_by_read_only) {
    subject = `Pretzel CFO · ⚠ Pipeline blocked (read-only) · ${closeResult.close_date}`;
  } else if (!o.did_useful_work) {
    if (o.new_txns_synced === 0 && o.txns_categorized === 0) {
      subject = `Pretzel CFO · ⚠ No new activity · ${closeResult.close_date}`;
    } else {
      subject = `Pretzel CFO · ⚠ 0 JEs posted, ${o.txns_categorized} in queue · ${closeResult.close_date}`;
    }
  } else {
    const sweepLabel = (o.sweep_count > 0) ? `, ${fmtMoney(o.sweep_total)} swept` : '';
    subject = `Pretzel CFO · ${o.jes_posted} JEs posted${sweepLabel} · ${closeResult.close_date}`;
  }
  if (!closeResult.ok) subject = subject.replace('Pretzel CFO · ', 'Pretzel CFO · ⚠ Step error · ');

  const ok = await sendEmail(env, { subject, html });
  return { sent: ok, subject };
}

// ── Weekly directive email (fires after runWeeklyDirective) ──────────────
export async function sendWeeklyDirectiveEmail(env, payload) {
  if (!payload?.directive) return { sent: false, reason: 'no directive' };
  const d = payload.directive;
  const c = payload.cash_position || {};
  const pl = payload.weekly_p_and_l_estimate || {};

  const actionsHtml = Array.isArray(d.top_priority_actions) ? d.top_priority_actions.map((a, i) => `<li style="margin:4px 0">${String(a).replace(/</g, '&lt;')}</li>`).join('') : '';
  const risksHtml = Array.isArray(d.key_risks) ? d.key_risks.map(r => `<li style="margin:4px 0;color:#b45309">${String(r).replace(/</g, '&lt;')}</li>`).join('') : '';

  const html = `
<div style="font-family:Georgia,serif;max-width:700px;padding:20px;color:#222">
  <h2 style="margin:0 0 8px 0;border-bottom:2px solid #c41e1e;padding-bottom:8px">Weekly Directive — ${payload.week_of}</h2>

  ${d.executive_summary ? `<p style="font-size:15px;line-height:1.6;background:#f5f5f5;padding:12px 16px;border-left:3px solid #c41e1e;margin:16px 0">${String(d.executive_summary).replace(/</g, '&lt;')}</p>` : ''}

  <h3 style="font-size:14px;margin:20px 0 8px 0">Top priority actions</h3>
  <ol style="margin:0 0 0 20px;font-size:13px">${actionsHtml}</ol>

  <h3 style="font-size:14px;margin:20px 0 8px 0">Risks to watch</h3>
  <ul style="margin:0 0 0 20px;font-size:13px">${risksHtml}</ul>

  <h3 style="font-size:14px;margin:20px 0 8px 0">Cash + P&L snapshot</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td style="padding:4px 0;color:#666">Cash now</td><td style="text-align:right;font-family:monospace">${fmtMoney(c.current_balance)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Projected 30d end</td><td style="text-align:right;font-family:monospace">${fmtMoney(c.projected_30d_ending)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Weeks runway</td><td style="text-align:right;font-family:monospace">${c.weeks_runway ?? '—'}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Weekly revenue</td><td style="text-align:right;font-family:monospace">${fmtMoney(pl.revenue)}</td></tr>
    <tr><td style="padding:4px 0;color:#666">Weekly net</td><td style="text-align:right;font-family:monospace;color:${(pl.net || 0) >= 0 ? '#22c55e' : '#ef4444'}">${(pl.net || 0) >= 0 ? '+' : ''}${fmtMoney(pl.net)}</td></tr>
  </table>

  ${d.channel_focus ? `
  <h3 style="font-size:14px;margin:20px 0 8px 0">Channel focus this week</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td style="padding:6px 0;color:#666;width:100px">Wholesale:</td><td>${String(d.channel_focus.wholesale || '').replace(/</g, '&lt;')}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Retail:</td><td>${String(d.channel_focus.retail || '').replace(/</g, '&lt;')}</td></tr>
    <tr><td style="padding:6px 0;color:#666">Catering:</td><td>${String(d.channel_focus.catering || '').replace(/</g, '&lt;')}</td></tr>
  </table>` : ''}

  <p style="margin:28px 0 0 0;font-size:11px;color:#888">
    Full directive: <a href="https://pretzel-os.drew-f39.workers.dev/finance/cfo/weekly-directive">weekly-directive endpoint</a>
  </p>
</div>`.trim();

  const ok = await sendEmail(env, {
    subject: `Pretzel CFO · Weekly directive — week of ${payload.week_of}`,
    html,
  });
  return { sent: ok };
}

// ── Daily morning brief (7am MT every day) ────────────────────────────────
// Three-line pulse Drew should read in 5 seconds. Loads the canonical
// scorecard and renders the headline numbers + alerts.
import { getScorecard } from './finance-scorecard.js';
import { listIssues } from './finance-issue-surfacer.js';
import { callAI } from './ai-budget.js';

// Session 5 (May 13 2026): generate a Sonnet-rendered CFO-style narrative
// paragraph for the daily email. Falls back to data-only if budget is hit.
async function buildSonnetNarrative(env, scorecard, issues) {
  const cash = scorecard.cash?.current?.total ?? 0;
  const runway = scorecard.cash?.runway;
  const tw = scorecard.this_week?.this_week || {};
  const lw = scorecard.this_week?.last_week || {};
  const wow = (tw.net || 0) - (lw.net || 0);
  const issuesTop3 = (issues.issues || []).slice(0, 3);

  const ctx = `
Today's snapshot:
- Cash: $${cash.toFixed(0)} (${runway?.display || '?'} runway, ${runway?.weekly_burn ? '$' + runway.weekly_burn.toFixed(0) + '/wk burn' : 'burn unknown'})
- This week net: ${tw.net >= 0 ? '+' : ''}$${(tw.net || 0).toFixed(0)} (last week ${lw.net >= 0 ? '+' : ''}$${(lw.net || 0).toFixed(0)}, WoW ${wow >= 0 ? '+' : ''}$${wow.toFixed(0)})
- Inflows last 7d: $${(tw.inflow || 0).toFixed(0)} · Outflows: $${(tw.outflow || 0).toFixed(0)}
- AR open: $${(scorecard.ar_30d?.total_open || 0).toFixed(0)} (${scorecard.ar_30d?.buckets?.overdue?.total > 0 ? '$' + scorecard.ar_30d.buckets.overdue.total.toFixed(0) + ' overdue' : 'none overdue'})
- Pipeline: ${scorecard.pipeline?.posted_last_24h || 0} JEs posted 24h, ${(scorecard.pipeline?.review_queue?.uncategorized || 0) + (scorecard.pipeline?.review_queue?.low_confidence || 0)} in review queue
- Top issues:${issuesTop3.length ? '\n' + issuesTop3.map(i => `  - [${i.severity}] ${i.headline}`).join('\n') : ' none'}

Channel mix MTD vs last month:
- Retail: $${(scorecard.channel?.this_month_mtd?.retail || 0).toFixed(0)} (was $${(scorecard.channel?.last_month_full?.retail || 0).toFixed(0)})
- Wholesale: $${(scorecard.channel?.this_month_mtd?.wholesale || 0).toFixed(0)} (was $${(scorecard.channel?.last_month_full?.wholesale || 0).toFixed(0)})
- Catering: $${(scorecard.channel?.this_month_mtd?.catering || 0).toFixed(0)} (was $${(scorecard.channel?.last_month_full?.catering || 0).toFixed(0)})`.trim();

  const prompt = `You are Drew's CFO. Write a 100-130 word morning brief for him in plain English. He's the CEO, not an accountant. Tone: like a smart business partner at coffee — direct, sharp, slightly informal.

Lead with the most important thing today. Cover: cash position + trajectory, anything urgent, one thing to watch. Don't repeat the numbers in the bullet list — interpret them. If there's a critical issue, lead with it.

End with: "One thing to think about today:" + a single concrete action or question.

Don't say "Hi Drew" or "Good morning" — just dive in.

${ctx}

Return ONLY the narrative paragraph + the final "One thing to think about today:" line. No headers, no markdown, no preamble.`;

  const result = await callAI(env, {
    use_case: 'daily_brief',
    model: 'sonnet',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
    caller: 'finance-email-briefs.js:buildSonnetNarrative',
    allow_haiku_downgrade: true,
  });

  if (!result.ok) return null;
  return result.content;
}

export async function sendDailyMorningBrief(env) {
  const s = await getScorecard(env).catch(() => null);
  if (!s) return { sent: false, reason: 'scorecard fetch failed' };

  // Pull open issues for proactive surfacing
  const issues = await listIssues(env, { limit: 10 }).catch(() => ({ issues: [], counts: {} }));

  // Generate Sonnet narrative (with cost tracking + degradation)
  let narrative = null;
  try {
    narrative = await buildSonnetNarrative(env, s, issues);
  } catch (err) {
    console.error('[daily-brief] narrative generation failed:', err.message, err.stack?.slice(0, 200));
    await env.DB.prepare(`
      INSERT INTO finance_audit_log (id, action_type, entity_type, entity_id, actor, description)
      VALUES (?, 'daily_brief_narrative_failed', 'cfo_briefs', ?, 'cfo_agent', ?)
    `).bind(crypto.randomUUID(), 'narrative_fail_' + Date.now(), err.message?.slice(0, 400)).run().catch(() => {});
  }

  const cash = s.cash?.current?.total ?? 0;
  const runway = s.cash?.runway;
  const tw = s.this_week?.this_week || {};
  const lw = s.this_week?.last_week || {};
  const wowNet = (tw.net || 0) - (lw.net || 0);
  const wowArrow = wowNet >= 0 ? '▲' : '▼';

  const reviewQ = (s.pipeline?.review_queue?.uncategorized || 0) + (s.pipeline?.review_queue?.low_confidence || 0);
  const criticalFlags = s.pipeline?.critical_flags || 0;

  // Headline
  const subj = `Pretzel · Cash ${fmtMoney(cash)} · Week net ${tw.net >= 0 ? '+' : ''}${fmtMoney(tw.net)} · ${runway?.display || '—'}`;

  // Color helpers
  const greenAmberRed = (v, gThresh, aThresh, invert) => {
    const x = invert ? -v : v;
    return x >= gThresh ? '#22c55e' : x >= aThresh ? '#f59e0b' : '#ef4444';
  };

  // Top AR coming this week
  const arWeek = (s.ar_30d?.buckets?.next_week?.total || 0);
  const arOverdue = (s.ar_30d?.buckets?.overdue?.total || 0);

  // Bills this week
  const billsWeek = (s.bills_30d?.buckets?.next_week || []);
  const billsTotal = billsWeek.reduce((sum, b) => sum + (b.amount || 0), 0);

  // Channel mix delta
  const channelDeltas = s.channel?.deltas_pct || {};
  const totalDelta = channelDeltas.total;

  // Build top movers row
  const topAR = (s.ar_30d?.top_5_expected || []).slice(0, 3);
  const topARHtml = topAR.length
    ? `<table style="width:100%;font-size:12px;margin-top:4px;border-collapse:collapse">
       ${topAR.map(a => `<tr>
         <td style="padding:3px 0;color:#555">${a.customer}</td>
         <td style="text-align:right;color:${a.days_out < 0 ? '#ef4444' : '#444'};font-family:monospace">${fmtMoney(a.amount)}</td>
         <td style="text-align:right;color:#888;width:80px">${a.days_out < 0 ? `${-a.days_out}d late` : `due in ${a.days_out}d`}</td>
       </tr>`).join('')}
       </table>`
    : '<div style="font-size:12px;color:#888">No AR due in next 30d</div>';

  // Channel mix mini
  const tm = s.channel?.this_month_mtd || {};
  const lm = s.channel?.last_month_full || {};
  const channelHtml = `<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:4px">
    <tr style="color:#888;font-size:10px">
      <td>channel</td><td style="text-align:right">MTD</td><td style="text-align:right">last mo</td><td style="text-align:right;width:60px">Δ</td>
    </tr>
    ${['retail','wholesale','catering','marketplace'].map(k => `<tr>
      <td style="padding:2px 0">${k}</td>
      <td style="text-align:right;font-family:monospace">${fmtMoney(tm[k] || 0)}</td>
      <td style="text-align:right;color:#888;font-family:monospace">${fmtMoney(lm[k] || 0)}</td>
      <td style="text-align:right;font-size:11px;color:${(channelDeltas[k] || 0) >= 0 ? '#22c55e' : '#ef4444'}">${channelDeltas[k] != null ? (channelDeltas[k] >= 0 ? '+' : '') + channelDeltas[k] + '%' : '—'}</td>
    </tr>`).join('')}
  </table>`;

  // Issues block — top 3 by severity
  const issuesTop = (issues.issues || []).slice(0, 3);
  const issuesHtml = issuesTop.length ? `
  <div style="margin-bottom:18px;padding:14px;background:#fff8e1;border-left:3px solid #f59e0b;font-size:13px">
    <div style="font-size:11px;color:#666;text-transform:uppercase;margin-bottom:6px">Issues to watch</div>
    ${issuesTop.map(i => `<div style="padding:4px 0">
      <span style="font-size:10px;color:${i.severity === 'critical' ? '#ef4444' : i.severity === 'high' ? '#ff6633' : '#f59e0b'};font-weight:700;text-transform:uppercase">${i.severity}</span>
      &nbsp;<b>${String(i.headline || '').replace(/</g, '&lt;')}</b>
      ${i.suggested_action ? `<div style="font-size:11px;color:#555;margin-top:2px">→ ${String(i.suggested_action).replace(/</g, '&lt;')}</div>` : ''}
    </div>`).join('')}
  </div>` : '';

  const html = `
<div style="font-family:Georgia,serif;max-width:600px;padding:20px;color:#222">
  <div style="border-bottom:2px solid #c41e1e;padding-bottom:6px;margin-bottom:14px">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px">Pretzel OS · Daily Pulse</div>
    <div style="font-size:14px;color:#444">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
  </div>

  ${narrative ? `<div style="margin-bottom:18px;padding:14px;background:#f8f8f8;border-left:3px solid #c41e1e;font-size:14px;line-height:1.6;font-family:Georgia,serif">${String(narrative).replace(/\n\n/g, '</p><p style="margin:8px 0">').replace(/\n/g, '<br>')}</div>` : ''}

  ${issuesHtml}

  <table style="width:100%;border-collapse:collapse">
    <tr>
      <td style="padding:6px 0">
        <div style="font-size:11px;color:#888;text-transform:uppercase">Cash on hand</div>
        <div style="font-size:24px;font-weight:600;font-family:Georgia,serif">${fmtMoney(cash)}</div>
        <div style="font-size:11px;color:#666">${runway?.display || '—'} runway · burn ${fmtMoney(runway?.weekly_burn || 0)}/wk</div>
      </td>
      <td style="text-align:right;vertical-align:top;padding:6px 0">
        <div style="font-size:11px;color:#888;text-transform:uppercase">Week net</div>
        <div style="font-size:24px;font-weight:600;color:${(tw.net || 0) >= 0 ? '#22c55e' : '#ef4444'}">${(tw.net || 0) >= 0 ? '+' : ''}${fmtMoney(tw.net || 0)}</div>
        <div style="font-size:11px;color:${wowNet >= 0 ? '#22c55e' : '#ef4444'}">${wowArrow} ${(wowNet >= 0 ? '+' : '')}${fmtMoney(wowNet)} vs last week</div>
      </td>
    </tr>
  </table>

  <h3 style="font-size:13px;margin:18px 0 4px 0;color:#444">Money coming in (next 30d)</h3>
  <div style="font-size:12px;color:#555">
    <b>${fmtMoney(s.ar_30d?.total_open || 0)}</b> open AR ·
    <span style="color:#ef4444">${fmtMoney(arOverdue)} overdue</span> ·
    ${fmtMoney(arWeek)} due this week
  </div>
  ${topARHtml}

  <h3 style="font-size:13px;margin:18px 0 4px 0;color:#444">Bills due this week</h3>
  ${billsWeek.length ? `<table style="width:100%;font-size:12px;border-collapse:collapse">
    ${billsWeek.map(b => `<tr>
      <td style="padding:3px 0">${b.vendor}</td>
      <td style="text-align:right;font-family:monospace">${fmtMoney(b.amount)}</td>
      <td style="text-align:right;color:#888;width:80px">${b.due_date}</td>
    </tr>`).join('')}
    <tr style="border-top:1px solid #ddd">
      <td style="padding:4px 0;font-weight:600">Total recurring</td>
      <td style="text-align:right;font-family:monospace;font-weight:600">${fmtMoney(billsTotal)}</td>
      <td></td>
    </tr>
  </table>` : '<div style="font-size:12px;color:#888">No recurring bills scheduled this week</div>'}

  <h3 style="font-size:13px;margin:18px 0 4px 0;color:#444">Channel mix</h3>
  ${channelHtml}

  ${reviewQ > 0 || criticalFlags > 0 ? `
  <div style="margin-top:18px;padding:10px;background:#fff8e1;border-left:3px solid #f59e0b;font-size:12px">
    ${reviewQ > 0 ? `<div><b>${reviewQ}</b> Mercury txns in review queue — categorize at <a href="https://pretzel-dashboard.pages.dev/#money">Money page</a></div>` : ''}
    ${criticalFlags > 0 ? `<div><b>${criticalFlags}</b> critical/high financial flags open</div>` : ''}
  </div>` : ''}

  <p style="margin:24px 0 0 0;font-size:11px;color:#888">
    <a href="https://pretzel-os.drew-f39.workers.dev/finance/scorecard" style="color:#888">full scorecard JSON</a> ·
    <a href="https://pretzel-os.drew-f39.workers.dev/finance/monthly-pl/quad" style="color:#888">monthly P&amp;L</a> ·
    <a href="https://pretzel-os.drew-f39.workers.dev/finance/ar-aging" style="color:#888">AR aging</a>
  </p>
</div>`.trim();

  const ok = await sendEmail(env, { subject: subj, html });
  return { sent: ok, scorecard: s };
}
