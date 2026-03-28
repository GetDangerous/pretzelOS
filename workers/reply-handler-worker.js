/**
 * Dangerous Pretzel Co — Reply Handler
 *
 * Entry 1: scheduled (every 15 min) — scan Gmail, push to Queue, no Claude
 * Entry 2: queue consumer — classify, draft, save, alert per message
 * Entry 3: fetch — HTTP endpoints for dashboard
 *
 * Env: ANTHROPIC_API_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 *      GMAIL_REFRESH_TOKEN, FROM_EMAIL, DREW_EMAIL, DB, KV, REPLY_QUEUE
 */

import { loadBrain } from './brain-loader.js';

export default {

  async scheduled(event, env, ctx) {
    ctx.waitUntil(scanAndEnqueue(env));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processReply(message.body, env);
        message.ack();
      } catch (err) {
        console.error('[Reply] Failed:', err.message);
        message.retry();
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    let res;
    if (path === '/replies/inbox')            res = await getInbox(request, env);
    else if (path === '/replies/inbox/count') res = await getInboxCount(env);
    else if (path === '/replies/send' && request.method === 'POST')    res = await sendReply(request, env);
    else if (path === '/replies/dismiss' && request.method === 'POST') res = await dismissReply(request, env);
    else if (path === '/replies/snooze' && request.method === 'POST')  res = await snoozeReply(request, env);
    else if (path === '/replies/history')     res = await getHistory(env);
    else if (path === '/replies/stats')       res = await getReplyStats(env);
    else if (path === '/replies/run')         res = json({ enqueued: await scanAndEnqueue(env) });
    else res = new Response('Reply Handler — Pretzel OS', { status: 200 });

    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SCANNER — every 15 min, no Claude calls
// ══════════════════════════════════════════════════════════════════════════════

async function scanAndEnqueue(env) {
  const token = await getGmailToken(env);

  // Scan inbox for recent messages (last 1 hour)
  const listResp = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox newer_than:1h&maxResults=50',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listResp.ok) { console.error('[Reply Scanner] Gmail failed:', listResp.status); return 0; }

  const { messages = [] } = await listResp.json();
  let enqueued = 0;

  for (const { id } of messages) {
    try {
      // Skip if already processed
      const exists = await env.DB.prepare(
        'SELECT id FROM inbound_replies WHERE gmail_message_id = ?'
      ).bind(id).first();
      if (exists) continue;

      // Fetch full message
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!msgResp.ok) continue;
      const message = await msgResp.json();

      // Skip auto-replies
      if (isAutoReply(message)) continue;

      // Skip messages from ourselves
      const fromHeader = getHeader(message, 'from');
      const fromAddress = extractEmail(fromHeader);
      if (fromAddress === env.FROM_EMAIL || fromAddress === env.DREW_EMAIL) continue;

      // Match to an outreach thread
      const match = await matchThread(message.threadId, env);
      if (!match) continue;

      // Extract body
      const bodyText = extractBody(message.payload);
      if (!bodyText?.trim()) continue;

      // Push to queue for processing
      await env.REPLY_QUEUE.send({
        gmail_message_id: id,
        thread_id: message.threadId,
        from_email: fromAddress,
        from_name: extractName(fromHeader),
        subject: getHeader(message, 'subject'),
        body_text: bodyText.slice(0, 2000),
        received_at: new Date(parseInt(message.internalDate)).toISOString(),
        match,
      });
      enqueued++;
    } catch (err) {
      console.error('[Reply Scanner] Error on', id, ':', err.message);
    }
    await sleep(100);
  }

  console.log(`[Reply Scanner] Enqueued ${enqueued}`);
  return enqueued;
}

// ══════════════════════════════════════════════════════════════════════════════
// PROCESSOR — runs per Queue message
// ══════════════════════════════════════════════════════════════════════════════

async function processReply(payload, env) {
  const { gmail_message_id, thread_id, from_email, from_name,
          subject, body_text, received_at, match } = payload;

  const daysToReply = match.sent_at
    ? Math.floor((new Date(received_at) - new Date(match.sent_at)) / 86400000) : null;

  // Classify
  const classification = await classifyReply(body_text, match, env);
  console.log(`[Reply] ${match.venue_name}: ${classification.classification}`);

  // Auto-handle unsubscribes
  if (classification.classification === 'unsubscribe') {
    await handleUnsubscribe(match, env);
    await saveReply({ id: crypto.randomUUID(), gmail_message_id, thread_id,
      from_email, from_name, subject, body_text, received_at, match,
      classification, daysToReply, status: 'auto_handled',
      handling_note: 'Auto-unsubscribed — no further contact' }, env);
    return;
  }

  // Draft response (skip for complaints)
  let suggested = null;
  if (classification.classification !== 'complaint') {
    suggested = await draftResponse(body_text, match, classification, env);
  }

  // Save
  const replyId = crypto.randomUUID();
  await saveReply({ id: replyId, gmail_message_id, thread_id,
    from_email, from_name, subject, body_text, received_at,
    match, classification, suggested, daysToReply, status: 'open' }, env);

  // Update outreach status
  await updateOutreachStatus(match, classification, env);

  // Alert Drew for hot replies
  const isHot = classification.urgency === 'high'
    || ['meeting_request', 'interested'].includes(classification.classification);
  if (isHot) await sendAlert(replyId, match, classification, body_text, suggested, env);

  // Feed Optimizer
  await captureSignal(match, classification, daysToReply, env);

  // Update live KV state
  await updateLive(env);
}

// ── CLASSIFY ──────────────────────────────────────────────────────────────────

async function classifyReply(bodyText, match, env) {
  const prompt = `Classify this reply to a ${match.channel} outreach email from Dangerous Pretzel Co.

ORIGINAL EMAIL TO ${match.venue_name}:
Subject: ${match.original_subject}
${(match.original_body || '').slice(0, 400)}

THEIR REPLY:
${bodyText}

Categories:
- interested: positive, wants to learn more
- meeting_request: wants to schedule, see a demo, get samples
- price_question: asking about pricing or minimums
- not_now: not ready but not hostile
- wrong_person: not the decision maker
- unsubscribe: wants off the list
- already_has_vendor: has an existing food program
- referral: suggesting someone else
- complaint: upset about contact
- positive_but_no_action: friendly but no next step
- needs_info: asking a specific question

Return JSON only:
{"classification":"...","confidence":0.95,"sentiment":"positive","urgency":"normal","key_point":"One sentence summary","reasoning":"..."}`;

  try {
    const data = await claude(env, 'claude-haiku-4-5-20251001', 250, prompt);
    return JSON.parse(data.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return { classification: 'needs_info', confidence: 0.5, sentiment: 'neutral',
             urgency: 'normal', key_point: 'Could not classify' };
  }
}

// ── DRAFT RESPONSE ────────────────────────────────────────────────────────────

async function draftResponse(bodyText, match, classification, env) {
  const brainCtx = await loadBrain(
    { DB: env.DB, KV: env.KV },
    match.channel === 'wholesale' ? 'outreach' : 'catering'
  );

  const venueNotes = match.venue_id
    ? (await env.DB.prepare('SELECT notes FROM venues WHERE id = ? LIMIT 1')
        .bind(match.venue_id).first())?.notes
    : null;

  const guidance = {
    interested:             'Build momentum. Offer one specific next step — sample tasting or quick call. Under 4 sentences.',
    meeting_request:        'Confirm enthusiasm. Suggest specific time this week or next. Give Drew\'s cell (801) 916-0275.',
    price_question:         'Directional answer: free warmer, pretzels wholesale, most accounts $1k-$10k/month. Offer specifics on a quick call.',
    not_now:                'Acknowledge gracefully. Leave door open. Check back in 60 days. 2 sentences max.',
    already_has_vendor:     'Curious about what they have. Mention what\'s different: local, fresh-frozen, free warmer, zero training. No hard pitch.',
    referral:               'Thank warmly. Ask for specific contact name/email or offer to make intro easy.',
    positive_but_no_action: 'Move it forward. Ask one specific question or suggest one concrete action.',
    needs_info:             'Answer exactly what they asked. Specific and concise. Just answer the question.',
    wrong_person:           'Thank for the redirect. Ask who the right person is.',
  }[classification.classification] || 'Reply helpfully and move the conversation forward.';

  const prompt = `Write a reply email from Drew at Dangerous Pretzel Co.

VENUE: ${match.venue_name} · CHANNEL: ${match.channel}
THEIR REPLY TYPE: ${classification.classification} · KEY POINT: ${classification.key_point}

ORIGINAL EMAIL:
Subject: ${match.original_subject}
${(match.original_body || '').slice(0, 350)}

THEIR FULL REPLY:
${bodyText}

GUIDANCE: ${guidance}
${venueNotes ? `VENUE NOTES: ${venueNotes}` : ''}
${brainCtx ? `DREW'S VOICE:\n${brainCtx.slice(0, 600)}` : ''}

RULES:
- Max 4 sentences. Meeting confirmations can be 2.
- First person, sound like Drew not a company
- Never "I hope this email finds you well"
- Reference something specific from their reply
- One clear next step at the end
- Sign off: Drew

Return JSON only: {"subject":"Re: [original subject]","body":"..."}`;

  try {
    const data = await claude(env, 'claude-sonnet-4-6', 400, prompt);
    return JSON.parse(data.replace(/```json\n?|\n?```/g, '').trim());
  } catch { return null; }
}

// ── AUTO-HANDLE UNSUBSCRIBE ───────────────────────────────────────────────────

async function handleUnsubscribe(match, env) {
  if (match.venue_id) {
    await env.DB.prepare(
      "UPDATE venues SET status='unsubscribed', updated_at=datetime('now') WHERE id=?"
    ).bind(match.venue_id).run();
    await env.DB.prepare(`
      INSERT INTO outreach_holds (id,venue_id,reason,hold_days,expires_at,active,created_at)
      VALUES (?,?,'Unsubscribed — permanent',9999,datetime('now','+9999 days'),1,datetime('now'))
    `).bind(crypto.randomUUID(), match.venue_id).run();
  }
  if (match.lead_id) {
    await env.DB.prepare(
      "UPDATE catering_leads SET status='unsubscribed', updated_at=datetime('now') WHERE id=?"
    ).bind(match.lead_id).run();
  }
}

// ── SAVE ──────────────────────────────────────────────────────────────────────

async function saveReply(p, env) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO inbound_replies (
      id, channel, outreach_log_id, venue_id, lead_id,
      gmail_message_id, gmail_thread_id, from_email, from_name,
      subject, body_text, received_at,
      classification, classification_confidence, classification_reasoning,
      sentiment, urgency,
      suggested_subject, suggested_reply, suggested_reply_generated_at,
      status, handling_note, prompt_version, sequence_step, days_to_reply,
      created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
  `).bind(
    p.id, p.match.channel, p.match.log_id || null,
    p.match.venue_id || null, p.match.lead_id || null,
    p.gmail_message_id, p.thread_id, p.from_email, p.from_name || null,
    p.subject || null, p.body_text, p.received_at,
    p.classification.classification, p.classification.confidence || null,
    p.classification.reasoning || null,
    p.classification.sentiment || null, p.classification.urgency || 'normal',
    p.suggested?.subject || null, p.suggested?.body || null,
    p.suggested ? new Date().toISOString() : null,
    p.status || 'open', p.handling_note || null,
    p.match.prompt_version || null, p.match.sequence_step || null, p.daysToReply || null
  ).run();
}

// ── UPDATE OUTREACH STATUS ────────────────────────────────────────────────────

async function updateOutreachStatus(match, classification, env) {
  const positive = ['interested','meeting_request','price_question','referral'];
  const outcome = positive.includes(classification.classification)
    ? 'replied_interested' : `replied_${classification.classification}`;

  if (match.channel === 'wholesale' && match.log_id) {
    await env.DB.prepare(`
      UPDATE outreach_logs SET replied_at=datetime('now'), outcome=?,
        reply_classification=?, updated_at=datetime('now')
      WHERE id=? AND replied_at IS NULL
    `).bind(outcome, classification.classification, match.log_id).run();
    if (match.venue_id) await env.DB.prepare(
      "UPDATE venues SET status='replied',updated_at=datetime('now') WHERE id=? AND status='contacted'"
    ).bind(match.venue_id).run();
  }
  if (match.channel === 'catering' && match.log_id) {
    await env.DB.prepare(`
      UPDATE catering_outreach_logs SET replied_at=datetime('now'), outcome=?,
        reply_classification=?, updated_at=datetime('now')
      WHERE id=? AND replied_at IS NULL
    `).bind(outcome, classification.classification, match.log_id).run();
    if (match.lead_id) await env.DB.prepare(
      "UPDATE catering_leads SET status='replied',updated_at=datetime('now') WHERE id=? AND status='contacted'"
    ).bind(match.lead_id).run();
  }
}

// ── ALERT DREW ────────────────────────────────────────────────────────────────

async function sendAlert(replyId, match, classification, bodyText, suggested, env) {
  const emoji = classification.classification === 'meeting_request' ? '🔥' : '💬';
  await sendGmail(env, {
    to: env.DREW_EMAIL,
    subject: `${emoji} ${match.venue_name} replied -- ${classification.classification.replace(/_/g,' ').toUpperCase()}`,
    body: [
      `${emoji} ${classification.key_point}`,
      '',
      `"${bodyText.slice(0, 200)}${bodyText.length > 200 ? '...' : ''}"`,
      '',
      '------------------------------------',
      'SUGGESTED REPLY:',
      '',
      suggested?.body || 'See dashboard for suggested response',
      '',
      '------------------------------------',
      'Send or edit: https://pretzel-dashboard.pages.dev',
      '-- Pretzel OS',
    ].join('\n'),
  });
}

// ── FEEDBACK LOOP ─────────────────────────────────────────────────────────────

async function captureSignal(match, classification, daysToReply, env) {
  const isPositive = ['interested','meeting_request','price_question','referral']
    .includes(classification.classification);
  await env.DB.prepare(`
    INSERT OR IGNORE INTO reply_signals
    (id,channel,venue_name,classification,sentiment,prompt_version,sequence_step,days_to_reply,is_positive,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))
  `).bind(
    crypto.randomUUID(), match.channel, match.venue_name,
    classification.classification, classification.sentiment || null,
    match.prompt_version || null, match.sequence_step || null,
    daysToReply || null, isPositive ? 1 : 0
  ).run();
  await env.DB.prepare(`
    UPDATE performance_metrics
    SET reply_count=reply_count+1, positive_reply_count=positive_reply_count+?
    WHERE week_start=date('now','weekday 1','-7 days')
  `).bind(isPositive ? 1 : 0).run();
}

// ── THREAD MATCHING ───────────────────────────────────────────────────────────

async function matchThread(threadId, env) {
  // Check wholesale outreach logs
  const w = await env.DB.prepare(`
    SELECT o.id as log_id, o.venue_id, o.sequence_step, o.sent_at,
           o.subject as original_subject, o.body as original_body,
           v.name as venue_name, v.category, 'wholesale' as channel,
           ap.version as prompt_version
    FROM outreach_logs o JOIN venues v ON v.id=o.venue_id
    LEFT JOIN agent_prompts ap ON ap.agent_name='outreach_email' AND ap.active=1
    WHERE o.gmail_thread_id=? AND o.direction='out'
    ORDER BY o.sent_at DESC LIMIT 1
  `).bind(threadId).first();
  if (w) return w;

  // Check catering outreach logs
  return await env.DB.prepare(`
    SELECT o.id as log_id, o.lead_id, o.sequence_step, o.sent_at,
           o.subject as original_subject, o.body as original_body,
           cl.name as venue_name, cl.industry, 'catering' as channel,
           ap.version as prompt_version
    FROM catering_outreach_logs o JOIN catering_leads cl ON cl.id=o.lead_id
    LEFT JOIN agent_prompts ap ON ap.agent_name='catering_email' AND ap.active=1
    WHERE o.gmail_thread_id=? AND o.direction='out'
    ORDER BY o.sent_at DESC LIMIT 1
  `).bind(threadId).first();
}

// ── UPDATE LIVE KV STATE ──────────────────────────────────────────────────────

async function updateLive(env) {
  const counts = await env.DB.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN urgency='high' OR classification='meeting_request' THEN 1 ELSE 0 END) as urgent,
           SUM(CASE WHEN classification IN ('interested','meeting_request','price_question') THEN 1 ELSE 0 END) as positive
    FROM inbound_replies WHERE status='open'
  `).first();
  const existing = await env.KV.get('cfo_live');
  const live = existing ? JSON.parse(existing) : {};
  live.open_replies = counts?.total || 0;
  live.urgent_replies = counts?.urgent || 0;
  live.positive_replies = counts?.positive || 0;
  await env.KV.put('cfo_live', JSON.stringify(live), { expirationTtl: 3700 });
}

// ── HTTP ENDPOINTS ────────────────────────────────────────────────────────────

async function getInbox(request, env) {
  const channel = new URL(request.url).searchParams.get('channel') || 'all';
  const where = channel !== 'all' ? `AND channel='${channel}'` : '';
  const replies = await env.DB.prepare(`
    SELECT * FROM inbound_replies
    WHERE status='open' AND (snooze_until IS NULL OR snooze_until<=datetime('now'))
    ${where}
    ORDER BY
      CASE urgency WHEN 'high' THEN 0 ELSE 1 END,
      CASE classification WHEN 'meeting_request' THEN 0 WHEN 'interested' THEN 1 ELSE 2 END,
      received_at DESC
    LIMIT 50
  `).all();
  return json({ replies: replies.results || [] });
}

async function getInboxCount(env) {
  const r = await env.DB.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN urgency='high' OR classification='meeting_request' THEN 1 ELSE 0 END) as urgent,
           SUM(CASE WHEN classification IN ('interested','meeting_request','price_question') THEN 1 ELSE 0 END) as positive
    FROM inbound_replies WHERE status='open'
      AND (snooze_until IS NULL OR snooze_until<=datetime('now'))
  `).first();
  return json(r || { total: 0, urgent: 0, positive: 0 });
}

async function sendReply(request, env) {
  const { reply_id, body, use_suggestion } = await request.json();
  const reply = await env.DB.prepare('SELECT * FROM inbound_replies WHERE id=?').bind(reply_id).first();
  if (!reply) return json({ error: 'Not found' }, 404);
  const sendBody = use_suggestion ? reply.suggested_reply : body;
  if (!sendBody) return json({ error: 'No body' }, 400);
  await sendGmailReply(env, {
    to: reply.from_email,
    subject: reply.suggested_subject || `Re: ${reply.subject || ''}`,
    body: sendBody,
    threadId: reply.gmail_thread_id,
  });
  await env.DB.prepare(`
    UPDATE inbound_replies SET status='sent', drew_sent_reply=?,
      handled_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).bind(sendBody, reply_id).run();
  return json({ sent: true });
}

async function dismissReply(request, env) {
  const { reply_id, note } = await request.json();
  await env.DB.prepare(
    "UPDATE inbound_replies SET status='dismissed',handling_note=?,handled_at=datetime('now'),updated_at=datetime('now') WHERE id=?"
  ).bind(note || null, reply_id).run();
  return json({ dismissed: true });
}

async function snoozeReply(request, env) {
  const { reply_id, snooze_until } = await request.json();
  await env.DB.prepare(
    "UPDATE inbound_replies SET status='snoozed',snooze_until=?,updated_at=datetime('now') WHERE id=?"
  ).bind(snooze_until, reply_id).run();
  return json({ snoozed: true });
}

async function getHistory(env) {
  const h = await env.DB.prepare(
    "SELECT * FROM inbound_replies WHERE status!='open' ORDER BY handled_at DESC LIMIT 50"
  ).all();
  return json({ history: h.results || [] });
}

async function getReplyStats(env) {
  const s = await env.DB.prepare(`
    SELECT channel, classification, COUNT(*) as count,
           AVG(days_to_reply) as avg_days,
           SUM(is_positive) as positive
    FROM reply_signals WHERE created_at>=date('now','-30 days')
    GROUP BY channel, classification ORDER BY count DESC
  `).all();
  return json({ stats: s.results || [] });
}

// ── GMAIL ─────────────────────────────────────────────────────────────────────

async function getGmailToken(env) {
  try {
    const cached = await env.KV.get('gmail_access_token');
    if (cached) {
      const { token, expires_at } = JSON.parse(cached);
      if (Date.now() < expires_at - 60000) return token;
    }
  } catch {}
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  });
  const { access_token, expires_in } = await resp.json();
  await env.KV.put('gmail_access_token',
    JSON.stringify({ token: access_token, expires_at: Date.now() + expires_in * 1000 }),
    { expirationTtl: expires_in - 60 }
  );
  return access_token;
}

async function sendGmail(env, { to, subject, body }) {
  const token = await getGmailToken(env);
  const raw = [`To: ${to}`, `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
}

async function sendGmailReply(env, { to, subject, body, threadId }) {
  const token = await getGmailToken(env);
  const raw = [`To: ${to}`, `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8',
    `In-Reply-To: ${threadId}`, `References: ${threadId}`, '', body].join('\r\n');
  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId }),
  });
}

// ── CLAUDE HELPER ─────────────────────────────────────────────────────────────

async function claude(env, model, maxTokens, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

// ── UTILS ─────────────────────────────────────────────────────────────────────

function isAutoReply(message) {
  const headers = message.payload?.headers || [];
  const autoSubmitted = headers.find(h => h.name.toLowerCase() === 'auto-submitted');
  if (autoSubmitted?.value && autoSubmitted.value !== 'no') return true;
  const subject = (getHeader(message, 'subject') || '').toLowerCase();
  return ['out of office','automatic reply','auto-reply','vacation',
          'delivery failed','mailer-daemon','undeliverable'].some(k => subject.includes(k));
}

function getHeader(message, name) {
  return message.payload?.headers?.find(
    h => h.name.toLowerCase() === name.toLowerCase()
  )?.value || '';
}

function extractEmail(str) {
  const m = str.match(/<([^>]+)>/) || str.match(/([^\s@]+@[^\s@]+\.[^\s@]+)/);
  return m?.[1] || str.trim();
}

function extractName(str) {
  return str.match(/^"?([^"<]+)"?\s*<[^>]+>/)?.[1]?.trim() || null;
}

function extractBody(payload) {
  if (!payload) return '';
  const decode = (d) => {
    try { return decodeURIComponent(escape(atob(d.replace(/-/g,'+').replace(/_/g,'/')))); }
    catch { return ''; }
  };
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data);
  for (const part of (payload.parts || [])) {
    if (part.mimeType === 'text/plain' && part.body?.data) return decode(part.body.data);
    const nested = extractBody(part);
    if (nested) return nested;
  }
  return '';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
