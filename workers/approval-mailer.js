/**
 * Dangerous Pretzel Co — Approval Mailer
 * Shared module imported by outreach-agent.js and catering-agent.js.
 *
 * Sends Drew an approval email with one-tap approve/reject links
 * when an email is parked during the approval gate period.
 *
 * Drew taps approve from his phone → email sends immediately.
 *
 * Env vars required:
 *   APPROVAL_SECRET — HMAC key for token generation (wrangler secret put APPROVAL_SECRET)
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL, DREW_EMAIL
 */

export async function sendApprovalRequestEmail(params, env) {
  // params: {logId, venueName, contactEmail, subject, body, selfScore, reasoning, channel}
  const token = await generateToken(params.logId, env);
  const base = 'https://pretzel-os.drew-f39.workers.dev';
  const approveUrl = `${base}/${params.channel}/approve?log_id=${params.logId}&token=${token}`;
  const rejectUrl  = `${base}/${params.channel}/reject?log_id=${params.logId}&token=${token}`;

  await sendGmail(env, {
    to: env.DREW_EMAIL,
    subject: `[${params.selfScore}/10] Approve email to ${params.venueName}?`,
    body: [
      `Score: ${params.selfScore}/10`,
      `To: ${params.contactEmail}`,
      `Subject: ${params.subject}`,
      '',
      '─────────────────────────',
      params.body,
      '─────────────────────────',
      '',
      `Why this angle:`,
      params.reasoning,
      '',
      `✓ APPROVE: ${approveUrl}`,
      '',
      `✗ REJECT: ${rejectUrl}`,
      '',
      `Review all: https://pretzel-dashboard.pages.dev`,
      '— Pretzel OS',
    ].join('\n'),
  });
}

export async function generateToken(logId, env) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(env.APPROVAL_SECRET || 'pretzel'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(logId)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
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
