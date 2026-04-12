/**
 * Dangerous Pretzel Co — Reply Detector
 * Cloudflare Worker (cron: daily 10am + 10pm MT)
 *
 * Scans Drew's Gmail inbox for replies to outreach/catering emails.
 * Matches inbound messages to outreach_logs and catering_outreach_logs via threadId.
 * Updates replied_at, writes inbound log row, notifies Drew.
 *
 * Cron: "0 16,4 * * *" (10am + 10pm MT = 4pm + 4am UTC)
 *
 * Env vars required:
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL, DREW_EMAIL
 *   DB, KV
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReplyDetector(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/replies/run') {
      const result = await runReplyDetector(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/replies/recent') {
      const recent = await env.DB.prepare(`
        SELECT ol.id, ol.venue_id, ol.direction, ol.subject, ol.body,
               ol.replied_at, ol.created_at, v.name as venue_name
        FROM outreach_logs ol
        LEFT JOIN venues v ON v.id = ol.venue_id
        WHERE ol.direction = 'in'
        ORDER BY ol.created_at DESC
        LIMIT 20
      `).all();

      const cateringRecent = await env.DB.prepare(`
        SELECT col.id, col.lead_id, col.direction, col.subject, col.body,
               col.created_at, cl.name as company_name
        FROM catering_outreach_logs col
        LEFT JOIN catering_leads cl ON cl.id = col.lead_id
        WHERE col.direction = 'in'
        ORDER BY col.created_at DESC
        LIMIT 20
      `).all();

      return new Response(JSON.stringify({
        wholesale_replies: recent.results || [],
        catering_replies: cateringRecent.results || [],
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Reply Detector — Pretzel OS', { status: 200 });
  }
};

async function runReplyDetector(env) {
  console.log('[ReplyDetector] Scanning inbox for venue replies...');

  const accessToken = await getGmailToken(env);
  if (!accessToken) {
    console.error('[ReplyDetector] Could not get Gmail token');
    return { error: 'Gmail auth failed' };
  }

  // Fetch recent inbox messages (last 25 hours to overlap between runs)
  const listUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox newer_than:1d&maxResults=50';
  const listResp = await fetch(listUrl, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!listResp.ok) {
    console.error('[ReplyDetector] Gmail list failed:', listResp.status);
    return { error: `Gmail list failed: ${listResp.status}` };
  }

  const listData = await listResp.json();
  const messageRefs = listData.messages || [];
  console.log(`[ReplyDetector] Found ${messageRefs.length} recent inbox messages`);

  let newReplies = [];

  for (const ref of messageRefs) {
    try {
      // Get message details (headers + snippet)
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
      const msgResp = await fetch(msgUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5000),
      });

      if (!msgResp.ok) continue;
      const msg = await msgResp.json();

      const threadId = msg.threadId;
      const fromHeader = msg.payload?.headers?.find(h => h.name === 'From')?.value || '';
      const subjectHeader = msg.payload?.headers?.find(h => h.name === 'Subject')?.value || '';
      const snippet = msg.snippet || '';

      // Skip messages from Drew's own email
      if (fromHeader.includes(env.FROM_EMAIL) || fromHeader.includes(env.DREW_EMAIL)) {
        continue;
      }

      // Check outreach_logs for matching threadId
      const outreachMatch = await env.DB.prepare(
        'SELECT id, venue_id, sequence_step FROM outreach_logs ' +
        "WHERE gmail_thread_id = ? AND direction = 'out' AND replied_at IS NULL"
      ).bind(threadId).first();

      if (outreachMatch) {
        const reply = await processOutreachReply(outreachMatch, threadId, fromHeader, subjectHeader, snippet, env);
        if (reply) newReplies.push(reply);
        continue;
      }

      // Check catering_outreach_logs for matching threadId
      const cateringMatch = await env.DB.prepare(
        'SELECT id, lead_id, sequence_step FROM catering_outreach_logs ' +
        "WHERE gmail_thread_id = ? AND direction = 'out' AND replied_at IS NULL"
      ).bind(threadId).first();

      if (cateringMatch) {
        const reply = await processCateringReply(cateringMatch, threadId, fromHeader, subjectHeader, snippet, env);
        if (reply) newReplies.push(reply);
      }

    } catch (err) {
      console.error(`[ReplyDetector] Error processing message ${ref.id}:`, err.message);
    }
  }

  // Send summary email if any new replies found
  if (newReplies.length > 0) {
    await sendReplySummary(newReplies, env);
  }

  console.log(`[ReplyDetector] Done. New replies: ${newReplies.length}`);
  return { new_replies: newReplies.length, details: newReplies };
}

async function processOutreachReply(match, threadId, fromHeader, subject, snippet, env) {
  // Mark outreach log as replied
  await env.DB.prepare(
    "UPDATE outreach_logs SET replied_at = datetime('now'), outcome = 'replied_interested' WHERE id = ?"
  ).bind(match.id).run();

  // Update venue status
  await env.DB.prepare(
    "UPDATE venues SET status = 'replied', updated_at = datetime('now') WHERE id = ?"
  ).bind(match.venue_id).run();

  // Write inbound log row
  await env.DB.prepare(`
    INSERT INTO outreach_logs (
      id, venue_id, sequence_step, channel, direction,
      subject, body, from_address, gmail_thread_id,
      created_at
    ) VALUES (?, ?, ?, 'email', 'in', ?, ?, ?, ?, datetime('now'))
  `).bind(
    crypto.randomUUID(),
    match.venue_id,
    match.sequence_step,
    subject,
    snippet.slice(0, 500),
    fromHeader,
    threadId
  ).run();

  // Get venue name for the alert
  const venue = await env.DB.prepare('SELECT name FROM venues WHERE id = ?').bind(match.venue_id).first();
  const venueName = venue?.name || match.venue_id;

  // Write to KV for dashboard/chat
  await env.KV.put(
    `reply_alert:${match.venue_id}`,
    JSON.stringify({
      venue_name: venueName,
      snippet: snippet.slice(0, 200),
      from: fromHeader,
      subject,
      at: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 * 24 * 14 } // 14 days
  );

  console.log(`[ReplyDetector] Outreach reply from ${venueName}`);
  return { channel: 'wholesale', venue_name: venueName, subject, snippet: snippet.slice(0, 100) };
}

async function processCateringReply(match, threadId, fromHeader, subject, snippet, env) {
  // Mark catering log as replied
  await env.DB.prepare(
    "UPDATE catering_outreach_logs SET replied_at = datetime('now'), outcome = 'replied_interested' WHERE id = ?"
  ).bind(match.id).run();

  // Update lead status
  await env.DB.prepare(
    "UPDATE catering_leads SET status = 'replied', updated_at = datetime('now') WHERE id = ?"
  ).bind(match.lead_id).run();

  // Write inbound log row
  await env.DB.prepare(`
    INSERT INTO catering_outreach_logs (
      id, lead_id, sequence_step, channel, direction,
      subject, body, from_address, gmail_thread_id,
      created_at
    ) VALUES (?, ?, ?, 'email', 'in', ?, ?, ?, ?, datetime('now'))
  `).bind(
    crypto.randomUUID(),
    match.lead_id,
    match.sequence_step,
    subject,
    snippet.slice(0, 500),
    fromHeader,
    threadId
  ).run();

  // Get company name
  const lead = await env.DB.prepare('SELECT name FROM catering_leads WHERE id = ?').bind(match.lead_id).first();
  const companyName = lead?.name || match.lead_id;

  // Write to KV
  await env.KV.put(
    `reply_alert:catering_${match.lead_id}`,
    JSON.stringify({
      company_name: companyName,
      snippet: snippet.slice(0, 200),
      from: fromHeader,
      subject,
      at: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 * 24 * 14 }
  );

  console.log(`[ReplyDetector] Catering reply from ${companyName}`);
  return { channel: 'catering', company_name: companyName, subject, snippet: snippet.slice(0, 100) };
}

async function sendReplySummary(replies, env) {
  const body = replies.map(r => {
    const name = r.venue_name || r.company_name;
    return `${r.channel.toUpperCase()}: ${name}\n  Subject: ${r.subject}\n  "${r.snippet}"`;
  }).join('\n\n');

  const subject = `📬 ${replies.length} new venue repl${replies.length === 1 ? 'y' : 'ies'} — Pretzel OS`;

  await sendGmail(env, {
    to: env.DREW_EMAIL,
    subject,
    body: `${replies.length} new reply${replies.length === 1 ? '' : 's'} detected:\n\n${body}\n\nView all: https://pretzel-dashboard.pages.dev\n\n— Pretzel OS Reply Detector`,
  });

  console.log(`[ReplyDetector] Summary email sent (${replies.length} replies)`);
}

async function getGmailToken(env) {
  try {
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
    return access_token;
  } catch {
    return null;
  }
}

async function sendGmail(env, { to, subject, body }) {
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
  const message = [`To: ${to}`, `From: Pretzel OS <${env.FROM_EMAIL}>`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const bytes = new TextEncoder().encode(message);
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
}
