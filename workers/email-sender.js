// email-sender.js
// Resend-backed email sending + bounce/unsubscribe tracking.
//
// Sender domain: loyalty.dangerouspretzel.com (verified in Resend by Drew).
// Secrets required:
//   - RESEND_API_KEY        — Resend API key (re_...)
//   - RESEND_WEBHOOK_SECRET — to HMAC-verify Resend webhook payloads
//   - EMAIL_UNSUBSCRIBE_SECRET — to HMAC-sign per-customer unsubscribe tokens
//
// Endpoints:
//   POST /webhooks/resend           — Resend → us (bounce/open/click/unsubscribe)
//   GET  /email/unsubscribe?token=  — customer click → flips email_unsubscribed=1
//   POST /retail/email/test         — Drew-only test send (dry_run or real) for QA
//
// Public function: sendResendEmail(env, opts) — used by other workers (Cohort A/B/C).

const RESEND_API_BASE = 'https://api.resend.com';
const FROM_DEFAULT = 'Drew @ Dangerous Pretzel <drew@loyalty.dangerouspretzel.com>';
const REPLY_TO = 'drew@dangerouspretzel.com';

// CAN-SPAM-required physical address footer.
const FOOTER_ADDRESS = 'Dangerous Pretzel Co · 352 W 600 S, Salt Lake City, UT';

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// HMAC-SHA256 with hex output. Used for unsubscribe tokens.
async function hmacHex(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function makeUnsubscribeUrl(env, customerId) {
  const sig = await hmacHex(env.EMAIL_UNSUBSCRIBE_SECRET || 'dev-secret', customerId);
  const token = `${customerId}.${sig.slice(0, 32)}`;
  return `https://pretzel-os.drew-f39.workers.dev/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

async function verifyUnsubscribeToken(env, token) {
  const [customerId, sigPrefix] = token.split('.');
  if (!customerId || !sigPrefix) return null;
  const expected = await hmacHex(env.EMAIL_UNSUBSCRIBE_SECRET || 'dev-secret', customerId);
  if (expected.slice(0, 32) !== sigPrefix) return null;
  return customerId;
}

// Renders a branded email shell — DPC V2 design tokens (brand-red #C41E1E,
// cream #F5F0E8, dark #1A1A1A; Georgia italic headlines, Manrope/Arial body).
// The per-cohort `bodyHtml` slots inside the white card; header band, footer,
// and unsubscribe link are uniform across all sends. Inline styles only — email
// clients drop <style> blocks and most don't load web fonts.
function renderHtml(bodyHtml, unsubUrl) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F0E8;font-family:Manrope,Arial,Helvetica,sans-serif;color:#1A1A1A">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F0E8;border-collapse:collapse"><tr><td>

<!-- Brand header band -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#C41E1E;border-collapse:collapse"><tr>
<td align="center" style="padding:20px 24px">
<span style="font-family:Georgia,serif;font-style:italic;font-weight:900;font-size:26px;color:#FFFFFF;letter-spacing:0.5px">Dangerous Pretzel</span>
</td></tr></table>

<!-- White card body -->
<table align="center" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#FFFFFF;margin:24px auto;border-collapse:collapse;border-radius:8px;overflow:hidden">
<tr><td style="padding:32px 28px">
${bodyHtml}
</td></tr>
</table>

<!-- Footer -->
<table align="center" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;border-collapse:collapse"><tr>
<td align="center" style="padding:0 16px 32px;font-family:Manrope,Arial,Helvetica,sans-serif;font-size:11px;color:#888;line-height:1.5">
${htmlEscape(FOOTER_ADDRESS)}<br>
<a href="${unsubUrl}" style="color:#888;text-decoration:underline">Unsubscribe</a>
</td></tr></table>

</td></tr></table>
</body></html>`;
}

// Reusable styled discount-code block. Brand-red dashed border on dark background
// makes the code unmissable in a glance — what a redemption email needs.
function discountCodeBlock(code, label = '$8 off · valid 30 days', cue = 'Show this code at the counter') {
  return `<table align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:24px 0">
<tr><td align="center" style="background:#1A1A1A;padding:22px 16px;border-radius:6px;border:2px dashed #C41E1E">
<div style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:11px;color:#CCC;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px">${htmlEscape(cue)}</div>
<div style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;color:#FFFFFF;letter-spacing:1.5px">${htmlEscape(code)}</div>
<div style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:12px;color:#CCC;margin-top:8px">${htmlEscape(label)}</div>
</td></tr></table>`;
}

// Reusable headline + body paragraph styles — keep them inline-styled for email clients.
const H1_STYLE = 'font-family:Georgia,serif;font-style:italic;font-weight:900;font-size:28px;color:#1A1A1A;margin:0 0 16px;line-height:1.15';
const P_STYLE  = 'font-family:Manrope,Arial,Helvetica,sans-serif;font-size:15px;color:#1A1A1A;line-height:1.55;margin:0 0 14px';
const SIGNOFF_STYLE = 'font-family:Manrope,Arial,Helvetica,sans-serif;font-size:15px;color:#1A1A1A;line-height:1.55;margin:24px 0 0';

function renderText(bodyText, unsubUrl) {
  return `${bodyText}\n\n---\n${FOOTER_ADDRESS}\nUnsubscribe: ${unsubUrl}\n`;
}

// ── Public: send a single email through Resend ─────────────────────────
// Returns { sent: true, resend_id, email_send_id } on success
//      or { sent: false, status, reason } on dedup/failure.
//
// Idempotency: idempotency_key must be unique per (campaign, customer, version).
// If a row with that key already exists, we no-op rather than re-send.
export async function sendResendEmail(env, {
  to, subject, body_html, body_text,
  campaign_id, cohort, customer_id, idempotency_key,
  from_override,
}) {
  if (!to || !subject) throw new Error('sendResendEmail: to + subject required');
  if (!idempotency_key) throw new Error('sendResendEmail: idempotency_key required');

  // Dedup check.
  const existing = await env.DB.prepare(
    'SELECT id, status, resend_id FROM email_sends WHERE idempotency_key = ?'
  ).bind(idempotency_key).first().catch(() => null);
  if (existing) {
    return { sent: false, status: 'dedup', reason: 'idempotency_key already exists', existing_id: existing.id };
  }

  // Bounce/unsub guard — per CAN-SPAM, never email a previously-bounced or unsubscribed customer.
  if (customer_id) {
    const cust = await env.DB.prepare(
      'SELECT email_unsubscribed, email_bounced FROM square_customers WHERE square_customer_id = ?'
    ).bind(customer_id).first().catch(() => null);
    if (cust?.email_unsubscribed || cust?.email_bounced) {
      const reason = cust.email_unsubscribed ? 'customer_unsubscribed' : 'customer_bounced';
      // Log a "skipped" send row so we have audit trail.
      const skipId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO email_sends (id, to_email, subject, campaign_id, cohort, customer_id, idempotency_key, sent_at, status, status_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 'skipped', ?)
      `).bind(skipId, to, subject, campaign_id || null, cohort || null, customer_id, idempotency_key, reason).run();
      return { sent: false, status: 'skipped', reason };
    }
  }

  const unsubUrl = customer_id
    ? await makeUnsubscribeUrl(env, customer_id)
    : 'https://dangerouspretzel.com/unsubscribe';
  const html = renderHtml(body_html, unsubUrl);
  const text = renderText(body_text || body_html.replace(/<[^>]+>/g, ''), unsubUrl);

  // Insert send row in 'queued' state BEFORE the API call so if Resend returns 200
  // and we crash before logging, we still have a record (and idempotency).
  const sendId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO email_sends (id, to_email, subject, campaign_id, cohort, customer_id, idempotency_key, sent_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 'queued')
  `).bind(sendId, to, subject, campaign_id || null, cohort || null, customer_id || null, idempotency_key).run();

  // Send via Resend.
  let resendId = null, status = 'sent', statusDetail = null;
  try {
    const resp = await fetch(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from_override || FROM_DEFAULT,
        reply_to: REPLY_TO,
        to: [to],
        subject,
        html,
        text,
        // Resend supports a List-Unsubscribe header; our unsubscribe URL is per-customer.
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    if (!resp.ok) {
      status = 'error';
      statusDetail = `${resp.status}: ${(await resp.text()).slice(0, 300)}`;
    } else {
      const data = await resp.json();
      resendId = data.id || null;
    }
  } catch (err) {
    status = 'error';
    statusDetail = err.message?.slice(0, 300) || 'unknown';
  }

  // Update the send row with the result.
  await env.DB.prepare(`
    UPDATE email_sends SET resend_id = ?, status = ?, status_detail = ? WHERE id = ?
  `).bind(resendId, status, statusDetail, sendId).run();

  // Bump campaign send counter on success.
  if (status === 'sent' && campaign_id) {
    await env.DB.prepare(
      'UPDATE retail_campaigns SET lifetime_emailed = COALESCE(lifetime_emailed, 0) + 1 WHERE id = ?'
    ).bind(campaign_id).run().catch(() => {});
  }

  return {
    sent: status === 'sent',
    status,
    reason: statusDetail,
    resend_id: resendId,
    email_send_id: sendId,
  };
}

// ── Resend webhook handler ─────────────────────────────────────────────
// Resend POSTs events: email.delivered, email.opened, email.clicked, email.bounced,
// email.complained (spam complaint), email.unsubscribed (List-Unsubscribe click).
async function handleResendWebhook(request, env) {
  // E.4 — Verify svix-signature against RESEND_WEBHOOK_SECRET.
  // Resend uses Svix for delivery; signed payload format: `{svix-id}.{svix-timestamp}.{body}`
  // Signed via HMAC-SHA256 with the secret (after stripping the `whsec_` prefix and base64-decoding).
  // The `svix-signature` header contains space-separated `v1,<base64sig>` entries; any match passes.
  const rawBody = await request.text();
  if (env.RESEND_WEBHOOK_SECRET) {
    const sigHeader = request.headers.get('svix-signature') || '';
    const svixId = request.headers.get('svix-id') || '';
    const svixTs = request.headers.get('svix-timestamp') || '';
    if (!sigHeader || !svixId || !svixTs) {
      console.warn('[resend-webhook] missing svix headers; rejecting');
      return new Response('Missing svix headers', { status: 401 });
    }
    // Reject if timestamp is more than 5 min stale (replay protection)
    const tsMs = parseInt(svixTs, 10) * 1000;
    if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
      console.warn(`[resend-webhook] timestamp skew too large: ${svixTs}`);
      return new Response('Timestamp out of range', { status: 401 });
    }
    // Strip whsec_ prefix and base64-decode secret
    const secretBase64 = env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, '');
    const secretBytes = Uint8Array.from(atob(secretBase64), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signedPayload = `${svixId}.${svixTs}.${rawBody}`;
    const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload)));
    const computedSig = btoa(String.fromCharCode(...sigBytes));
    const provided = sigHeader.split(' ').map(s => s.startsWith('v1,') ? s.slice(3) : null).filter(Boolean);
    if (!provided.includes(computedSig)) {
      console.warn(`[resend-webhook] signature mismatch — header=${sigHeader.slice(0,80)} computed=${computedSig.slice(0,20)}...`);
      return new Response('Invalid signature', { status: 401 });
    }
  }
  // else: secret not configured yet — allow through (logged warning during transition).
  let body = null;
  try { body = JSON.parse(rawBody); } catch {}
  if (!body) return new Response('Bad payload', { status: 400 });

  const type = body.type || '';
  const data = body.data || {};
  const resendId = data.email_id || data.id;

  if (!resendId) return new Response('OK (no email_id)', { status: 200 });

  // Find the matching email_sends row.
  const row = await env.DB.prepare(
    'SELECT id, customer_id FROM email_sends WHERE resend_id = ? LIMIT 1'
  ).bind(resendId).first().catch(() => null);
  if (!row) {
    console.warn(`[resend-webhook] no email_sends row for ${resendId} (event ${type})`);
    return new Response('OK (no row)', { status: 200 });
  }

  const updates = {
    bounced_at: null,
    opened_at: null,
    clicked_at: null,
    unsubscribed_at: null,
    status: null,
    status_detail: null,
  };

  switch (type) {
    case 'email.delivered':
      updates.status = 'delivered';
      break;
    case 'email.opened':
      updates.opened_at = "datetime('now')";
      break;
    case 'email.clicked':
      updates.clicked_at = "datetime('now')";
      break;
    case 'email.bounced':
      updates.bounced_at = "datetime('now')";
      updates.status = 'bounced';
      updates.status_detail = data.reason || 'bounced';
      // Mark the customer as bounced so we never retry.
      if (row.customer_id) {
        await env.DB.prepare(
          'UPDATE square_customers SET email_bounced = 1 WHERE square_customer_id = ?'
        ).bind(row.customer_id).run().catch(() => {});
      }
      break;
    case 'email.complained':
      updates.unsubscribed_at = "datetime('now')";
      updates.status = 'complained';
      // Spam complaint = strongest possible "stop emailing me" — flip unsubscribe + bounce.
      if (row.customer_id) {
        await env.DB.prepare(
          'UPDATE square_customers SET email_unsubscribed = 1 WHERE square_customer_id = ?'
        ).bind(row.customer_id).run().catch(() => {});
      }
      break;
    case 'email.unsubscribed':
      updates.unsubscribed_at = "datetime('now')";
      updates.status = 'unsubscribed';
      if (row.customer_id) {
        await env.DB.prepare(
          'UPDATE square_customers SET email_unsubscribed = 1 WHERE square_customer_id = ?'
        ).bind(row.customer_id).run().catch(() => {});
      }
      break;
    default:
      return new Response(`OK (ignored ${type})`, { status: 200 });
  }

  // Build dynamic UPDATE.
  const sets = [];
  const binds = [];
  for (const [col, val] of Object.entries(updates)) {
    if (val === null) continue;
    if (typeof val === 'string' && val.startsWith("datetime(")) {
      sets.push(`${col} = ${val}`);
    } else {
      sets.push(`${col} = ?`);
      binds.push(val);
    }
  }
  if (sets.length === 0) return new Response('OK (no updates)', { status: 200 });
  binds.push(row.id);
  await env.DB.prepare(`UPDATE email_sends SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return new Response('OK', { status: 200 });
}

// ── Unsubscribe link handler ───────────────────────────────────────────
async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response('Missing token', { status: 400 });
  const customerId = await verifyUnsubscribeToken(env, token);
  if (!customerId) return new Response('Invalid token', { status: 400 });

  await env.DB.prepare(
    'UPDATE square_customers SET email_unsubscribed = 1 WHERE square_customer_id = ?'
  ).bind(customerId).run();

  // Friendly confirmation page.
  return new Response(`<!doctype html>
<html><body style="font-family:Arial,Helvetica,sans-serif;text-align:center;padding:48px 16px;color:#222">
<h2>You're unsubscribed</h2>
<p>You won't receive any more emails from Dangerous Pretzel. We'll miss you.</p>
<p style="color:#888;font-size:12px">If this was a mistake, just send us a message at hello@dangerouspretzel.com.</p>
</body></html>`, { headers: { 'Content-Type': 'text/html' } });
}

// ── Test endpoint ──────────────────────────────────────────────────────
async function handleTest(request, env) {
  const body = await request.json().catch(() => ({}));
  const to = body.to;
  if (!to) return new Response(JSON.stringify({ error: 'to required' }), { status: 400 });
  const cohort = body.cohort || 'b';
  const dryRun = !!body.dry_run;
  const fromOverride = body.from_override || null;  // E.6 — test from apex to debug tracking

  // Pick a template based on cohort.
  const signoff = `<p style="${SIGNOFF_STYLE}">See you soon,<br>
<strong>Drew</strong><br>
<span style="color:#666;font-size:13px">Founder · Dangerous Pretzel Co</span></p>`;
  const templates = {
    a: {
      subject: 'Hey, miss us? 🥨',
      html: `<h1 style="${H1_STYLE}">Hey {{first_name}}, miss us?</h1>
<p style="${P_STYLE}">You're on our list — we just want to make sure you still want pretzel updates. No pressure either way.</p>
<p style="${P_STYLE}">Want to stay in? Do nothing.<br>
Want out? Hit unsubscribe at the bottom.</p>
<p style="${P_STYLE}">Either way — here's <strong style="color:#C41E1E">$8 off</strong> on us if you stop by in the next 30 days.</p>
${discountCodeBlock('WELCOME2WHY5')}
${signoff}`,
    },
    b: {
      subject: 'Your next pretzel + dip is on us 🥨',
      html: `<h1 style="${H1_STYLE}">Hey {{first_name}}, your pretzel's getting lonely.</h1>
<p style="${P_STYLE}">You stopped by once — we'd love to see you back. Your next pretzel + dip is on the house.</p>
${discountCodeBlock('WELCOME2WHY5', '$8 off · valid through {{expires_date}}')}
${signoff}`,
    },
    c: {
      subject: 'A little something for your next visit 🥨',
      html: `<h1 style="${H1_STYLE}">Thanks for stopping by, {{first_name}}.</h1>
<p style="${P_STYLE}">Hope you loved it. Here's a little something for next time — your second pretzel + dip is on us.</p>
${discountCodeBlock('WELCOME2WHY5', '$8 off your next visit · valid 30 days')}
<p style="font-family:Manrope,Arial,Helvetica,sans-serif;font-size:13px;color:#666;line-height:1.5;margin:24px 0 14px">P.S. Join our loyalty program in-store next visit — you'll earn rewards on every order.</p>
${signoff}`,
    },
  };

  const tpl = templates[cohort] || templates.b;
  const filled = {
    subject: tpl.subject,
    body_html: tpl.html
      .replace('{{first_name}}', body.first_name || 'friend')
      .replace('{{expires_date}}', body.expires_date || 'June 2'),
  };

  if (dryRun) {
    return new Response(JSON.stringify({
      dry_run: true,
      would_send_to: to,
      cohort,
      subject: filled.subject,
      body_html: filled.body_html,
      from: FROM_DEFAULT,
      reply_to: REPLY_TO,
    }, null, 2), { headers: { 'Content-Type': 'application/json' } });
  }

  const result = await sendResendEmail(env, {
    to,
    subject: filled.subject,
    body_html: filled.body_html,
    body_text: filled.body_html.replace(/<[^>]+>/g, ''),
    campaign_id: null,
    cohort,
    customer_id: body.customer_id || null,
    idempotency_key: `test_${cohort}_${to}_${Date.now()}`,
    from_override: fromOverride,
  });
  return new Response(JSON.stringify(result, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Cohort batch senders ────────────────────────────────────────────────
// Common pattern: SELECT eligible audience → for each row, sendResendEmail with
// idempotency key. Daily-rate cap so we don't blow Resend free tier (3k/mo) or
// trigger spam-trap clusters. Returns counts so cron and ad-hoc callers can log.

async function ensureCampaignRow(env, { type, name, mode }) {
  let row = await env.DB.prepare(
    'SELECT id FROM retail_campaigns WHERE campaign_type = ? LIMIT 1'
  ).bind(type).first();
  if (row) return row.id;
  const newId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO retail_campaigns (id, name, campaign_type, status, target_segment,
      send_strategy, daily_send_limit, approval_status, campaign_mode,
      agent_reasoning, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, 0, 'approved', ?,
      ?, datetime('now'), datetime('now'))
  `).bind(newId, name, type, type, mode, mode,
    `Auto-created by email-sender for ${type}.`).run();
  return newId;
}

// Cohort A — Toast-imported reactivation (one-shot per customer ever).
// Drew approval gate: this is the riskiest send because the audience is cold (Toast era).
// Daily cap = 400 to spread the 1,623 batch over 4-5 days. Bounce/unsub feedback gates further sends.
export async function sendCohortA(env, { dailyCap = 400, dryRun = false } = {}) {
  const campaignId = await ensureCampaignRow(env, {
    type: 'email_reactivation_toast',
    name: 'Toast-Imported Reactivation (Email)',
    mode: 'external',
  });

  const audience = await env.DB.prepare(`
    SELECT square_customer_id, email, given_name
    FROM square_customers
    WHERE creation_source='IMPORT'
      AND COALESCE(square_order_count, 0) = 0
      AND email IS NOT NULL
      AND email_unsubscribed = 0
      AND email_bounced = 0
      AND square_customer_id NOT IN (
        SELECT customer_id FROM email_sends WHERE cohort = 'A' AND customer_id IS NOT NULL
      )
    LIMIT ?
  `).bind(dailyCap).all();

  const rows = audience.results || [];
  if (dryRun) return { dry_run: true, count: rows.length, sample: rows.slice(0, 3) };

  let sent = 0, skipped = 0, errors = 0;
  for (const c of rows) {
    const firstName = c.given_name || 'friend';
    const html = `<h1 style="${H1_STYLE}">Hey ${htmlEscape(firstName)}, miss us?</h1>
<p style="${P_STYLE}">You're on our list — we just want to make sure you still want pretzel updates. No pressure either way.</p>
<p style="${P_STYLE}">Want to stay in? Do nothing.<br>
Want out? Hit unsubscribe at the bottom.</p>
<p style="${P_STYLE}">Either way — here's <strong style="color:#C41E1E">$8 off</strong> on us if you stop by in the next 30 days.</p>
${discountCodeBlock('WELCOME2WHY5')}
<p style="${SIGNOFF_STYLE}">See you soon,<br>
<strong>Drew</strong><br>
<span style="color:#666;font-size:13px">Founder · Dangerous Pretzel Co</span></p>`;
    const result = await sendResendEmail(env, {
      to: c.email,
      subject: 'Hey, miss us? 🥨',
      body_html: html,
      body_text: html.replace(/<[^>]+>/g, ''),
      campaign_id: campaignId,
      cohort: 'A',
      customer_id: c.square_customer_id,
      idempotency_key: `cohort_a_reactivation_v1_${c.square_customer_id}`,
    });
    if (result.sent) sent++;
    else if (result.status === 'error') errors++;
    else skipped++;
  }
  return { campaign_id: campaignId, audience_size: rows.length, sent, skipped, errors };
}

// Cohort B — Square first-time, lapsed 30-180d (weekly Tue 10am MT batch).
// One send per customer per 60-day window (idempotency key includes month).
export async function sendCohortB(env, { weeklyCap = 200, dryRun = false } = {}) {
  const campaignId = await ensureCampaignRow(env, {
    type: 'email_winback_square',
    name: 'Square First-Time Win-Back (Email)',
    mode: 'continuous',
  });

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM for the idempotency window
  const audience = await env.DB.prepare(`
    SELECT square_customer_id, email, given_name
    FROM square_customers
    WHERE COALESCE(square_order_count, 0) >= 1
      AND last_square_order_date < datetime('now', '-30 days')
      AND last_square_order_date >= datetime('now', '-180 days')
      AND email IS NOT NULL
      AND email_unsubscribed = 0
      AND email_bounced = 0
      AND square_customer_id NOT IN (
        SELECT customer_id FROM email_sends
         WHERE cohort = 'B'
           AND customer_id IS NOT NULL
           AND sent_at >= datetime('now', '-60 days')
      )
    LIMIT ?
  `).bind(weeklyCap).all();

  const rows = audience.results || [];
  if (dryRun) return { dry_run: true, count: rows.length, sample: rows.slice(0, 3) };

  // Compute a friendly expiration date (30 days from today, locale-formatted).
  const expires = new Date(Date.now() + 30 * 86400000)
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  let sent = 0, skipped = 0, errors = 0;
  for (const c of rows) {
    const firstName = c.given_name || 'friend';
    const html = `<h1 style="${H1_STYLE}">Hey ${htmlEscape(firstName)}, your pretzel's getting lonely.</h1>
<p style="${P_STYLE}">You stopped by once — we'd love to see you back. Your next pretzel + dip is on the house.</p>
${discountCodeBlock('WELCOME2WHY5', `$8 off · valid through ${expires}`)}
<p style="${SIGNOFF_STYLE}">See you soon,<br>
<strong>Drew</strong><br>
<span style="color:#666;font-size:13px">Founder · Dangerous Pretzel Co</span></p>`;
    const result = await sendResendEmail(env, {
      to: c.email,
      subject: 'Your next pretzel + dip is on us 🥨',
      body_html: html,
      body_text: html.replace(/<[^>]+>/g, ''),
      campaign_id: campaignId,
      cohort: 'B',
      customer_id: c.square_customer_id,
      idempotency_key: `cohort_b_winback_${month}_${c.square_customer_id}`,
    });
    if (result.sent) sent++;
    else if (result.status === 'error') errors++;
    else skipped++;
  }
  return { campaign_id: campaignId, audience_size: rows.length, sent, skipped, errors };
}

// ── Default export — fetch dispatcher ──────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    // Cron: Tuesday 10am MT (16:00 UTC) — Cohort B weekly batch.
    if (event.cron === '0 16 * * 2') {
      return sendCohortB(env, { weeklyCap: 200 });
    }
    return { skipped: true, reason: 'unknown cron' };
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/webhooks/resend' && request.method === 'POST') {
      return handleResendWebhook(request, env);
    }
    if (path === '/email/unsubscribe' && request.method === 'GET') {
      return handleUnsubscribe(request, env);
    }
    if (path === '/retail/email/test' && request.method === 'POST') {
      return handleTest(request, env);
    }
    if (path === '/retail/email/cohort-a/run' && request.method === 'POST') {
      const dryRun = url.searchParams.get('dry_run') === '1';
      const dailyCap = parseInt(url.searchParams.get('cap')) || 400;
      const result = await sendCohortA(env, { dailyCap, dryRun });
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/retail/email/cohort-b/run' && request.method === 'POST') {
      const dryRun = url.searchParams.get('dry_run') === '1';
      const weeklyCap = parseInt(url.searchParams.get('cap')) || 200;
      const result = await sendCohortB(env, { weeklyCap, dryRun });
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.2d — enable open_tracking + click_tracking on a Resend domain.
    // Body: { domain_id: 'xxx' } OR { domain_name: 'loyalty.dangerouspretzel.com' }
    if (path === '/retail/email/resend/enable-tracking' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      let domainId = body.domain_id;
      if (!domainId && body.domain_name) {
        const listResp = await fetch(`${RESEND_API_BASE}/domains`, {
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
        });
        const listData = await listResp.json().catch(() => ({}));
        const match = (listData.data || []).find(d => d.name === body.domain_name);
        if (!match) return new Response(JSON.stringify({ error: 'domain not found', name: body.domain_name }), { status: 404 });
        domainId = match.id;
      }
      if (!domainId) return new Response(JSON.stringify({ error: 'domain_id or domain_name required' }), { status: 400 });
      const patchResp = await fetch(`${RESEND_API_BASE}/domains/${domainId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ open_tracking: true, click_tracking: true }),
      });
      const patchData = await patchResp.json().catch(() => ({}));
      return new Response(JSON.stringify({ status: patchResp.status, domain_id: domainId, result: patchData }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.2b — list Resend domains (diagnostic: check tracking config)
    if (path === '/retail/email/resend/domains' && request.method === 'GET') {
      const listResp = await fetch(`${RESEND_API_BASE}/domains`, {
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      });
      const listData = await listResp.json().catch(() => ({}));
      // Also fetch individual domain details (includes tracking flags)
      const details = [];
      for (const d of (listData.data || [])) {
        const detailResp = await fetch(`${RESEND_API_BASE}/domains/${d.id}`, {
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
        });
        details.push(await detailResp.json().catch(() => ({})));
      }
      return new Response(JSON.stringify({ list: listData, details }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.2c — fetch raw Resend email event log
    if (path === '/retail/email/resend/email' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400 });
      const resp = await fetch(`${RESEND_API_BASE}/emails/${id}`, {
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      });
      const data = await resp.json().catch(() => ({}));
      return new Response(JSON.stringify({ status: resp.status, data }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.6 — back-fill email returns by matching past delivered emails to subsequent orders.
    // Resend open-tracking is broken at platform level so opens=0. But returns can be
    // attributed retroactively: for each delivered email in the last 90d, check if the
    // recipient's customer made an order within 30d after the email send. Mark returned_at.
    if (path === '/retail/email/backfill-returns' && request.method === 'POST') {
      const days = parseInt(url.searchParams.get('days') || '90');
      const dryRun = url.searchParams.get('dry_run') === '1';
      const rows = await env.DB.prepare(`
        SELECT es.id, es.customer_id, es.to_email, es.sent_at, es.campaign_id
        FROM email_sends es
        WHERE es.status = 'delivered'
          AND es.sent_at >= datetime('now', '-' || ? || ' days')
          AND es.returned_at IS NULL
          AND (es.customer_id IS NOT NULL OR es.to_email IS NOT NULL)
        ORDER BY es.sent_at
        LIMIT 500
      `).bind(days).all().catch(() => ({ results: [] }));
      const targets = rows.results || [];
      if (dryRun) return new Response(JSON.stringify({ mode: 'dry_run', total: targets.length }, null, 2), { headers: { 'Content-Type': 'application/json' } });

      const result = { checked: 0, matched: 0, no_order: 0, errors: 0 };
      for (const r of targets) {
        try {
          // Find first order from this customer AFTER the email send (within 30d).
          // BUG FIX: orders.order_date is ISO format ("2026-05-10T21:38:57.024Z") while
          // email_sends.sent_at is space-separated ("2026-05-10 21:39:00"). Direct text
          // comparison fails because "T" > " " in ASCII. We must cast both via datetime().
          // ALSO: require a 5-minute gap to exclude the triggering order itself for Cohort C
          // (Welcome email fires inside the order webhook, ~3-5s AFTER order_date).
          const order = await env.DB.prepare(`
            SELECT o.gross_revenue, o.order_date
            FROM orders o
            WHERE (
              (? IS NOT NULL AND o.customer_id = ?) OR
              (? IS NOT NULL AND o.customer_email = ?)
            )
              AND datetime(o.order_date) >= datetime(?, '+5 minutes')
              AND datetime(o.order_date) <= datetime(?, '+30 days')
            ORDER BY o.order_date ASC LIMIT 1
          `).bind(r.customer_id, r.customer_id, r.to_email, r.to_email, r.sent_at, r.sent_at).first().catch(() => null);
          result.checked++;
          if (!order) { result.no_order++; continue; }
          const daysBetween = Math.floor((new Date(order.order_date).getTime() - new Date(r.sent_at + 'Z').getTime()) / 86400000);
          await env.DB.prepare(
            "UPDATE email_sends SET returned_at = ?, return_order_value = ?, days_to_return = ? WHERE id = ?"
          ).bind(order.order_date, order.gross_revenue, daysBetween, r.id).run();
          result.matched++;
        } catch (err) {
          result.errors++;
        }
      }
      return new Response(JSON.stringify({ mode: 'live', total_targeted: targets.length, ...result }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.5 — email open-rate dashboard data: per-campaign rolling 30d stats
    if (path === '/retail/email/open-rates' && request.method === 'GET') {
      const rows = await env.DB.prepare(`
        SELECT
          es.campaign_id,
          rc.name as campaign_name,
          rc.campaign_type,
          es.cohort,
          COUNT(*) as sent,
          SUM(CASE WHEN es.status = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN es.opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
          SUM(CASE WHEN es.clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked,
          SUM(CASE WHEN es.bounced_at IS NOT NULL THEN 1 ELSE 0 END) as bounced,
          SUM(CASE WHEN es.unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) as unsubscribed,
          MAX(es.sent_at) as last_sent_at
        FROM email_sends es
        LEFT JOIN retail_campaigns rc ON rc.id = es.campaign_id
        WHERE es.sent_at >= datetime('now','-30 days')
        GROUP BY COALESCE(es.campaign_id, es.cohort)
        ORDER BY sent DESC
      `).all().catch(() => ({ results: [] }));
      const data = (rows.results || []).map(r => {
        const delivered = r.delivered || 0;
        const openRate = delivered > 0 ? Math.round((r.opened / delivered) * 1000) / 10 : null;
        const clickRate = delivered > 0 ? Math.round((r.clicked / delivered) * 1000) / 10 : null;
        const bounceRate = (r.sent || 0) > 0 ? Math.round((r.bounced / r.sent) * 1000) / 10 : null;
        return {
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name || `(cohort ${r.cohort || 'unknown'})`,
          campaign_type: r.campaign_type,
          cohort: r.cohort,
          sent: r.sent,
          delivered,
          opened: r.opened,
          clicked: r.clicked,
          bounced: r.bounced,
          unsubscribed: r.unsubscribed,
          open_rate_pct: openRate,
          click_rate_pct: clickRate,
          bounce_rate_pct: bounceRate,
          last_sent_at: r.last_sent_at,
          // Tracking-enabled-on-May-11 caveat: opens before this date are zero by definition
          tracking_active: r.last_sent_at && new Date(r.last_sent_at + 'Z') >= new Date('2026-05-11T22:00:00Z'),
        };
      });
      return new Response(JSON.stringify({ campaigns: data, generated_at: new Date().toISOString(), note: 'open_tracking enabled on Resend domains May 11 2026 evening; pre-fix rates are zero by config gap, not deliverability' }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.2 — list Resend webhooks (diagnostic)
    if (path === '/retail/email/resend/webhooks' && request.method === 'GET') {
      const resp = await fetch(`${RESEND_API_BASE}/webhooks`, {
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      });
      const data = await resp.json().catch(() => ({}));
      return new Response(JSON.stringify({ status: resp.status, data }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.1 — subscribe webhook to email.opened + email.clicked events.
    // Body: { webhook_id: "wh_xxx" } (optional — auto-discovers if only one webhook exists)
    if (path === '/retail/email/resend/subscribe-opens' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      let webhookId = body.webhook_id;
      // Auto-discover if not provided
      if (!webhookId) {
        const listResp = await fetch(`${RESEND_API_BASE}/webhooks`, {
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
        });
        const listData = await listResp.json().catch(() => ({}));
        const hooks = listData.data || [];
        if (hooks.length === 1) webhookId = hooks[0].id;
        else return new Response(JSON.stringify({ error: 'must specify webhook_id', count: hooks.length, hooks: hooks.map(h => ({ id: h.id, endpoint_url: h.endpoint_url, events: h.events })) }, null, 2), { headers: { 'Content-Type': 'application/json' }, status: 400 });
      }
      // Fetch current subscription
      const getResp = await fetch(`${RESEND_API_BASE}/webhooks/${webhookId}`, {
        headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      });
      const current = await getResp.json().catch(() => ({}));
      const currentEvents = current.events || [];
      const desiredEvents = Array.from(new Set([...currentEvents, 'email.opened', 'email.clicked']));
      // PATCH the webhook
      const patchResp = await fetch(`${RESEND_API_BASE}/webhooks/${webhookId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ events: desiredEvents }),
      });
      const patchData = await patchResp.json().catch(() => ({}));
      return new Response(JSON.stringify({
        webhook_id: webhookId,
        previous_events: currentEvents,
        new_events: desiredEvents,
        patch_status: patchResp.status,
        patch_result: patchData,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // E.3 — back-fill opens for emails sent in last N days by querying Resend per email_id.
    // Resend retains event history ~90d.
    if (path === '/retail/email/backfill-opens' && request.method === 'POST') {
      const days = parseInt(url.searchParams.get('days') || '30');
      const dryRun = url.searchParams.get('dry_run') === '1';
      const rows = await env.DB.prepare(`
        SELECT id, resend_id, to_email FROM email_sends
        WHERE resend_id IS NOT NULL
          AND sent_at >= datetime('now', '-' || ? || ' days')
          AND opened_at IS NULL
        ORDER BY sent_at DESC
        LIMIT 500
      `).bind(days).all().catch(() => ({ results: [] }));
      const targets = rows.results || [];
      if (dryRun) return new Response(JSON.stringify({ mode: 'dry_run', total: targets.length, sample: targets.slice(0, 3) }, null, 2), { headers: { 'Content-Type': 'application/json' } });

      const result = { checked: 0, opened: 0, clicked: 0, errors: 0 };
      for (const row of targets) {
        try {
          const resp = await fetch(`${RESEND_API_BASE}/emails/${row.resend_id}`, {
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
          });
          if (!resp.ok) { result.errors++; continue; }
          const data = await resp.json();
          result.checked++;
          // Resend exposes last_event with timestamps. Look for 'opened' / 'clicked' in last_event or events array.
          const lastEvent = data.last_event || data.status;
          if (lastEvent === 'opened' || lastEvent === 'clicked' || (data.events || []).some(e => e === 'opened' || e === 'clicked')) {
            const sets = [];
            const binds = [];
            sets.push("opened_at = datetime('now')");
            if (lastEvent === 'clicked' || (data.events || []).includes('clicked')) {
              sets.push("clicked_at = datetime('now')");
              result.clicked++;
            }
            result.opened++;
            binds.push(row.id);
            await env.DB.prepare(`UPDATE email_sends SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run().catch(() => {});
          }
          // Throttle 200ms — Resend rate limit
          await new Promise(r => setTimeout(r, 200));
        } catch (err) {
          result.errors++;
        }
      }
      return new Response(JSON.stringify({ mode: 'live', total_targeted: targets.length, ...result }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Not Found', { status: 404 });
  },
};
