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
import { callAI } from './ai-budget.js';

export default {

  async scheduled(event, env, ctx) {
    return Promise.all([
      scanAndEnqueue(env, '2h'),
      // Process any auto-send replies whose 2h delay has elapsed
      processAutoSends(env),
    ]);
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
    else if (path === '/replies/auto-pending') {
      const pending = await env.DB.prepare(`
        SELECT id, from_email, venue_id, classification, suggested_reply,
               auto_send_at, handling_note, received_at
        FROM inbound_replies
        WHERE status = 'auto_send_scheduled'
        ORDER BY auto_send_at ASC
      `).all();
      res = json({ pending: pending.results || [] });
    }
    else if (path === '/replies/cancel-auto-send' && request.method === 'POST') {
      const { reply_id } = await request.json();
      await env.DB.prepare(
        "UPDATE inbound_replies SET status='open', auto_send_at=NULL, handling_note='Auto-send cancelled by Drew', updated_at=datetime('now') WHERE id=? AND status='auto_send_scheduled'"
      ).bind(reply_id).run();
      res = json({ cancelled: true });
    }
    else if (path === '/replies/run') {
      const window = url.searchParams.get('window') || '2h';
      const debug = url.searchParams.has('debug');
      if (debug) {
        const token = await getGmailToken(env);
        const listResp = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox newer_than:${window}&maxResults=10`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const body = await listResp.json();
        res = json({ gmail_status: listResp.status, messages_found: body.messages?.length || 0, raw: body });
      } else {
        res = json({ enqueued: await scanAndEnqueue(env, window) });
      }
    }
    // SMS reply webhook — Swell CX sends inbound SMS here
    else if (path === '/sms/webhook' && request.method === 'POST') {
      try {
        const payload = await request.json();
        // Swell webhook payload: { contact_id, phone, body, direction: 'in', ... }
        const phone = (payload.phone || payload.from || '').replace(/[^0-9]/g, '').replace(/^1/, '');
        const body = payload.body || payload.message || payload.text || '';
        if (!phone || !body) {
          res = json({ error: 'Missing phone or body' }, 400);
        } else if (isTestSmsPayload(phone, body)) {
          // Staff-testing pings and fake numbers — don't store as a real reply.
          console.log(`[SMS Webhook] Test marker dropped: phone=${phone.slice(0,6)}*** body="${body.slice(0, 40)}"`);
          res = json({ received: true, dropped: 'test_marker' });
        } else {
          // Find the venue by phone number
          const venue = await env.DB.prepare(
            `SELECT id, name FROM venues WHERE REPLACE(REPLACE(REPLACE(contact_phone, '-', ''), '(', ''), ')', '') LIKE '%' || ? || '%' LIMIT 1`
          ).bind(phone.slice(-10)).first();
          // Find the most recent outreach log for this venue
          const lastLog = venue ? await env.DB.prepare(
            `SELECT id, gmail_thread_id FROM outreach_logs WHERE venue_id = ? AND direction = 'out' ORDER BY sent_at DESC LIMIT 1`
          ).bind(venue.id).first() : null;

          const replyId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO inbound_replies (
              id, channel, venue_id, outreach_log_id,
              gmail_message_id, gmail_thread_id,
              from_email, from_name, subject, body_text,
              received_at, status, created_at
            ) VALUES (?, 'sms', ?, ?, ?, ?, ?, ?, 'SMS Reply', ?, datetime('now'), 'open', datetime('now'))
          `).bind(
            replyId, venue?.id || null, lastLog?.id || null,
            'sms_' + replyId, lastLog?.gmail_thread_id || 'sms_thread_' + replyId,
            phone, venue?.name || phone, body
          ).run();

          // Update venue replied_at if found
          if (venue && lastLog) {
            await env.DB.prepare(
              `UPDATE outreach_logs SET replied_at = COALESCE(replied_at, datetime('now')) WHERE id = ?`
            ).bind(lastLog.id).run();
            await env.DB.prepare(
              `UPDATE venues SET status = 'replied', updated_at = datetime('now') WHERE id = ? AND status = 'contacted'`
            ).bind(venue.id).run();
          }

          // Enqueue for classification (same pipeline as email replies)
          if (env.REPLY_QUEUE) {
            await env.REPLY_QUEUE.send({
              reply_id: replyId,
              channel: 'sms',
              from: phone,
              body_text: body,
              venue_id: venue?.id || null,
              venue_name: venue?.name || null,
            });
          }

          console.log(`[SMS Webhook] Inbound from ${phone.slice(0,6)}*** — venue: ${venue?.name || 'unknown'}`);
          res = json({ received: true, reply_id: replyId, venue: venue?.name || null });
        }
      } catch (err) {
        console.error('[SMS Webhook] Error:', err.message);
        res = json({ error: err.message }, 500);
      }
    }
    else res = new Response('Reply Handler — Pretzel OS', { status: 200 });

    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }
};

// ── TEST-PAYLOAD FILTER ──────────────────────────────────────────────────────
// Staff sometimes fires curl tests at /sms/webhook with fake numbers + bodies
// like "test sms webhook" / "test123" / "test msg". Those used to land in the
// action queue and pollute Drew's review. This guard drops them at ingest.
const TEST_SMS_NUMBERS = new Set([
  '8019169999',  // historical staff test number
  '5555555555',
  '1234567890',
  '0000000000',
]);
function isTestSmsPayload(phone, body) {
  const p = (phone || '').replace(/^1/, '');
  if (TEST_SMS_NUMBERS.has(p)) return true;
  const b = (body || '').trim().toLowerCase();
  if (!b) return false;
  if (b === 'test' || b === 'test123' || b === 'testing') return true;
  if (b.startsWith('test sms')) return true;
  if (b.startsWith('test msg')) return true;
  if (b.startsWith('test webhook')) return true;
  // A body that is literally only "test" plus digits/spaces
  if (/^test[\s\d]*$/i.test(b)) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCANNER — every 15 min, no Claude calls
// ══════════════════════════════════════════════════════════════════════════════

async function scanAndEnqueue(env, window = '2h') {
  const token = await getGmailToken(env);

  // Scan inbox for recent messages (configurable window, default 2h for overlap safety)
  const listResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox newer_than:${window}&maxResults=50`,
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

      // Match to an outreach thread (fallback: match by sender email/domain
      // so replies from a different address than the one we emailed still link)
      const match = await matchThread(message.threadId, env, fromAddress);
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

  // ── SMART AUTO-SEND: safe categories get auto-replied after 2h delay ──
  // price_question and needs_info are low-risk, formulaic responses
  const AUTO_SEND_CATEGORIES = ['price_question', 'needs_info'];
  const isAutoSendCandidate = AUTO_SEND_CATEGORIES.includes(classification.classification)
    && classification.confidence >= 0.85
    && suggested?.body;
  const autoSendAt = isAutoSendCandidate
    ? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()  // 2 hours from now
    : null;

  // Save
  const replyId = crypto.randomUUID();
  await saveReply({ id: replyId, gmail_message_id, thread_id,
    from_email, from_name, subject, body_text, received_at,
    match, classification, suggested, daysToReply,
    status: isAutoSendCandidate ? 'auto_send_scheduled' : 'open',
    handling_note: isAutoSendCandidate ? `Auto-send scheduled for ${autoSendAt} (${classification.classification}, confidence ${classification.confidence})` : null,
    autoSendAt }, env);

  // Update outreach status
  await updateOutreachStatus(match, classification, env);

  // Alert Drew for any actionable reply (not just hot ones)
  // Auto-send candidates still get alerts so Drew can intervene before the 2h window
  const isActionable = classification.urgency === 'high'
    || ['meeting_request', 'interested', 'more_info', 'price_question', 'referral'].includes(classification.classification);
  if (isActionable) {
    const autoNote = isAutoSendCandidate ? `\n⏱️ AUTO-SEND SCHEDULED: This reply will be auto-sent in ~2h. Edit or dismiss on dashboard to cancel.` : '';
    await sendAlert(replyId, match, classification, body_text, suggested, env, autoNote);
  }

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
    let data = await workerAI(env, prompt);
    if (!data) data = await claude(env, 'haiku', 250, prompt);  // DIF-3: model key not literal id
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
    meeting_request:        'Confirm enthusiasm. Suggest specific time this week or next. Give Drew\'s cell 801.916.9122.',
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
    const data = await claude(env, 'sonnet', 400, prompt);  // DIF-3: model key not literal id
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
      auto_send_at, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
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
    p.match.prompt_version || null, p.match.sequence_step || null, p.daysToReply || null,
    p.autoSendAt || null
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

async function sendAlert(replyId, match, classification, bodyText, suggested, env, extraNote = '') {
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
      extraNote,
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

async function matchThread(threadId, env, fromEmail) {
  // 1) Primary: match by Gmail thread id (wholesale)
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

  // 2) Primary: match by Gmail thread id (catering)
  const c = await env.DB.prepare(`
    SELECT o.id as log_id, o.lead_id, o.sequence_step, o.sent_at,
           o.subject as original_subject, o.body as original_body,
           cl.name as venue_name, cl.industry, 'catering' as channel,
           ap.version as prompt_version
    FROM catering_outreach_logs o JOIN catering_leads cl ON cl.id=o.lead_id
    LEFT JOIN agent_prompts ap ON ap.agent_name='catering_email' AND ap.active=1
    WHERE o.gmail_thread_id=? AND o.direction='out'
    ORDER BY o.sent_at DESC LIMIT 1
  `).bind(threadId).first();
  if (c) return c;

  // 3) Fallback: thread id didn't match. Try to link by sender.
  //    This catches replies that come from a different address than we emailed
  //    (e.g. we wrote to CustomerService@x.org, a human replied from jane@x.org).
  if (!fromEmail) return null;
  const email = String(fromEmail).toLowerCase();
  const domain = email.includes('@') ? email.split('@')[1] : null;
  if (!domain) return null;

  // Guard: skip generic mail providers where domain match is meaningless
  const GENERIC = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
    'icloud.com','me.com','aol.com','proton.me','protonmail.com','msn.com',
    'live.com','comcast.net','verizon.net','mail.com']);
  const domainMatchAllowed = !GENERIC.has(domain);

  // 3a) Wholesale: exact email match on to_address, then domain match
  const wExact = await env.DB.prepare(`
    SELECT o.id as log_id, o.venue_id, o.sequence_step, o.sent_at,
           o.subject as original_subject, o.body as original_body,
           v.name as venue_name, v.category, 'wholesale' as channel,
           ap.version as prompt_version
    FROM outreach_logs o JOIN venues v ON v.id=o.venue_id
    LEFT JOIN agent_prompts ap ON ap.agent_name='outreach_email' AND ap.active=1
    WHERE LOWER(o.to_address)=? AND o.direction='out'
      AND o.sent_at > datetime('now','-60 days')
    ORDER BY o.sent_at DESC LIMIT 1
  `).bind(email).first();
  if (wExact) {
    console.log(`[Reply Scanner] Matched wholesale by exact from_email: ${email}`);
    return wExact;
  }

  if (domainMatchAllowed) {
    const wDomain = await env.DB.prepare(`
      SELECT o.id as log_id, o.venue_id, o.sequence_step, o.sent_at,
             o.subject as original_subject, o.body as original_body,
             v.name as venue_name, v.category, 'wholesale' as channel,
             ap.version as prompt_version
      FROM outreach_logs o JOIN venues v ON v.id=o.venue_id
      LEFT JOIN agent_prompts ap ON ap.agent_name='outreach_email' AND ap.active=1
      WHERE LOWER(o.to_address) LIKE ? AND o.direction='out'
        AND o.sent_at > datetime('now','-60 days')
      ORDER BY o.sent_at DESC LIMIT 1
    `).bind('%@' + domain).first();
    if (wDomain) {
      console.log(`[Reply Scanner] Matched wholesale by domain: ${domain} (from ${email})`);
      return wDomain;
    }
  }

  // 3b) Catering: exact email match on to_address, then domain match
  const cExact = await env.DB.prepare(`
    SELECT o.id as log_id, o.lead_id, o.sequence_step, o.sent_at,
           o.subject as original_subject, o.body as original_body,
           cl.name as venue_name, cl.industry, 'catering' as channel,
           ap.version as prompt_version
    FROM catering_outreach_logs o JOIN catering_leads cl ON cl.id=o.lead_id
    LEFT JOIN agent_prompts ap ON ap.agent_name='catering_email' AND ap.active=1
    WHERE LOWER(o.to_address)=? AND o.direction='out'
      AND o.sent_at > datetime('now','-60 days')
    ORDER BY o.sent_at DESC LIMIT 1
  `).bind(email).first();
  if (cExact) {
    console.log(`[Reply Scanner] Matched catering by exact from_email: ${email}`);
    return cExact;
  }

  if (domainMatchAllowed) {
    const cDomain = await env.DB.prepare(`
      SELECT o.id as log_id, o.lead_id, o.sequence_step, o.sent_at,
             o.subject as original_subject, o.body as original_body,
             cl.name as venue_name, cl.industry, 'catering' as channel,
             ap.version as prompt_version
      FROM catering_outreach_logs o JOIN catering_leads cl ON cl.id=o.lead_id
      LEFT JOIN agent_prompts ap ON ap.agent_name='catering_email' AND ap.active=1
      WHERE LOWER(o.to_address) LIKE ? AND o.direction='out'
        AND o.sent_at > datetime('now','-60 days')
      ORDER BY o.sent_at DESC LIMIT 1
    `).bind('%@' + domain).first();
    if (cDomain) {
      console.log(`[Reply Scanner] Matched catering by domain: ${domain} (from ${email})`);
      return cDomain;
    }
  }

  return null;
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

// ── AUTO-SEND PROCESSOR ──────────────────────────────────────────────────────
// Runs every 15min via scheduled. Sends replies that were auto-scheduled
// and whose 2h delay has elapsed. Drew can cancel by changing status to 'open'
// or 'dismissed' on dashboard before the window expires.

async function processAutoSends(env) {
  const ready = await env.DB.prepare(`
    SELECT id, from_email, gmail_thread_id, subject, suggested_subject, suggested_reply,
           venue_id, classification
    FROM inbound_replies
    WHERE status = 'auto_send_scheduled'
      AND auto_send_at IS NOT NULL
      AND auto_send_at <= datetime('now')
    ORDER BY auto_send_at ASC
    LIMIT 5
  `).all();

  let sent = 0;
  for (const reply of (ready.results || [])) {
    if (!reply.suggested_reply) {
      await env.DB.prepare(
        "UPDATE inbound_replies SET status='open', handling_note='Auto-send skipped: no draft', updated_at=datetime('now') WHERE id=?"
      ).bind(reply.id).run();
      continue;
    }

    try {
      await sendGmailReply(env, {
        to: reply.from_email,
        subject: reply.suggested_subject || `Re: ${reply.subject || ''}`,
        body: reply.suggested_reply,
        threadId: reply.gmail_thread_id,
      });

      await env.DB.prepare(`
        UPDATE inbound_replies SET status='auto_sent', drew_sent_reply=?,
          handled_at=datetime('now'), handling_note='Auto-sent (safe category)',
          updated_at=datetime('now')
        WHERE id=?
      `).bind(reply.suggested_reply, reply.id).run();

      sent++;
      console.log(`[Reply Auto-Send] Sent auto-reply for ${reply.classification} to ${reply.from_email}`);
    } catch (err) {
      console.error(`[Reply Auto-Send] Failed for ${reply.id}:`, err.message);
      await env.DB.prepare(
        "UPDATE inbound_replies SET status='open', handling_note=?, updated_at=datetime('now') WHERE id=?"
      ).bind(`Auto-send failed: ${err.message}`, reply.id).run();
    }
  }

  if (sent > 0) console.log(`[Reply Auto-Send] Sent ${sent} auto-replies`);
  return sent;
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

// RFC 2047 encode subject when it contains non-ASCII
function encodeSubj(s) { return /^[\x00-\x7F]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`; }

async function sendGmail(env, { to, subject, body }) {
  const token = await getGmailToken(env);
  const raw = [`To: ${to}`, `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${encodeSubj(subject)}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  const bytes1 = new TextEncoder().encode(raw);
  const binString1 = Array.from(bytes1, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString1).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
}

async function sendGmailReply(env, { to, subject, body, threadId }) {
  const token = await getGmailToken(env);
  const raw = [`To: ${to}`, `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${encodeSubj(subject)}`, 'Content-Type: text/plain; charset=utf-8',
    `In-Reply-To: ${threadId}`, `References: ${threadId}`, '', body].join('\r\n');
  const bytes2 = new TextEncoder().encode(raw);
  const binString2 = Array.from(bytes2, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString2).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded, threadId }),
  });
}

// ── AI HELPERS ────────────────────────────────────────────────────────────────

// Workers AI — free tier, no API key, native Cloudflare binding
// Used for cheap classification tasks (reply classifier)
async function workerAI(env, prompt) {
  if (!env.AI) return null;
  try {
    const resp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are a JSON classification assistant. Respond with valid JSON only, no markdown.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
    });
    return resp?.response || null;
  } catch { return null; }
}

async function claude(env, model, maxTokens, prompt) {
  // DIF-3 (May 13 2026): wired through ai-budget
  // Use case derived from model so haiku vs sonnet calls are tracked separately.
  const isHaiku = /haiku/i.test(model);
  const result = await callAI(env, {
    use_case: isHaiku ? 'reply_handler_haiku_categorize' : 'reply_handler_sonnet_draft',
    model,
    caller: 'reply-handler-worker.js',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  if (!result.ok) return '';
  return result.content || '';
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
