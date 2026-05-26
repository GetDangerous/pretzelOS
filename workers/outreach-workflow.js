/**
 * Dangerous Pretzel Co — Outreach + Catering Approval Workflows
 *
 * Durable Cloudflare Workflows that handle the approval gate for each outreach/catering email.
 * Replaces the cron-based park-and-poll pattern that could cause duplicate sends.
 *
 * Flow:
 *   1. Outreach agent drafts an email → spawns this Workflow (logId as instance ID)
 *   2. Workflow writes to D1 as pending + sends Drew an approval email
 *   3. Workflow pauses — waitForEvent('decision', { timeout: '48h' })
 *   4. Drew taps Approve → approve endpoint sends Workflow event → resumes
 *   5. Workflow sends the email in a retryable step → updates D1 + venue status
 *
 * No race conditions: waitForEvent is atomic — only one resolution possible.
 * No duplicate sends: step.do() is idempotent on retry.
 * Reliable: Gmail send failure retries automatically without re-prompting Claude.
 *
 * Env vars required: (inherited from main Worker)
 *   ANTHROPIC_API_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *   FROM_EMAIL, DREW_EMAIL, APPROVAL_SECRET, DB, KV
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { sendApprovalRequestEmail, generateToken } from './approval-mailer.js';

export class OutreachApprovalWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const {
      logId,
      venueId,
      venueName,
      contactEmail,
      subject,
      body,
      selfScore,
      reasoning,
      channel,        // 'outreach' | 'catering'
      sequenceStep,   // 1=first touch, 2=day-3 follow-up, 3=day-7 follow-up
      subjectVariant, // A/B test: 'A' (question) or 'B' (hook)
      threadId,       // Gmail thread ID for follow-up threading
    } = event.payload;
    const step_num = sequenceStep || 1;

    // Bug 1.1 Site (b): pre-park gate. Block a draft from hitting the approval queue
    // if the recipient already received a recent send / previously declined / is placeholder.
    // Drop the enrollment with outcome='gate_blocked' so analytics show the reason.
    await step.do('contact-gate', async () => {
      const blocked = await checkContactGate(contactEmail, this.env, { isFollowUp: step_num > 1 });
      if (blocked) {
        await this.env.DB.prepare(`
          INSERT OR IGNORE INTO outreach_logs (
            id, venue_id, sequence_step, channel, direction,
            subject, body, from_address, to_address,
            approval_status, agent_reasoning, created_at
          ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, 'gate_blocked', ?, datetime('now'))
        `).bind(
          logId, venueId, step_num, subject, body,
          this.env.FROM_EMAIL, contactEmail,
          `Contact gate: ${blocked.reason} — ${blocked.detail || ''}`
        ).run();
        throw new Error(`contact_gate_blocked: ${blocked.reason}`);
      }
    });

    // ── Step 1: Write pending record to D1 ───────────────────────
    await step.do('write-pending', async () => {
      await this.env.DB.prepare(`
        INSERT OR IGNORE INTO outreach_logs (
          id, venue_id, sequence_step, channel, direction,
          subject, body, from_address, to_address,
          approval_status, agent_reasoning, self_score,
          subject_variant, gmail_thread_id, created_at
        ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, datetime('now'))
      `).bind(
        logId, venueId, step_num, subject, body,
        this.env.FROM_EMAIL, contactEmail,
        reasoning, selfScore, subjectVariant || null, threadId || null
      ).run();
    });

    // ── Step 2: Send approval email to Drew ──────────────────────
    await step.do('send-approval-email', async () => {
      await sendApprovalRequestEmail({
        logId,
        venueName,
        contactEmail,
        subject,
        body,
        selfScore,
        reasoning,
        channel: channel || 'outreach',
      }, this.env);
    });

    // ── Step 3: Wait for Drew's decision (48h timeout) ───────────
    let decision;
    try {
      decision = await step.waitForEvent('waiting for Drew approval', { type: 'decision', timeout: '48 hours' });
    } catch {
      // Timeout — mark as expired
      await step.do('mark-expired', async () => {
        await this.env.DB.prepare(`
          UPDATE outreach_logs
          SET approval_status = 'expired', notes = 'No response within 48h'
          WHERE id = ? AND approval_status = 'pending'
        `).bind(logId).run();
      });
      return { outcome: 'expired', logId };
    }

    const approved = decision?.payload?.approved ?? decision?.approved ?? false;

    if (!approved) {
      // ── Step 4a: Rejected ────────────────────────────────────────
      await step.do('mark-rejected', async () => {
        const note = decision?.payload?.note || decision?.note || 'Rejected by Drew';
        await this.env.DB.prepare(`
          UPDATE outreach_logs
          SET approval_status = 'rejected', notes = ?
          WHERE id = ? AND approval_status = 'pending'
        `).bind(note, logId).run();
      });
      return { outcome: 'rejected', logId };
    }

    // ── Step 4b: Approved — send the email ───────────────────────
    // Read the LATEST body/subject from D1 in case Drew redrafted while it was pending
    const latestLog = await step.do('read-latest-draft', async () => {
      const row = await this.env.DB.prepare(
        `SELECT subject, body, to_address FROM outreach_logs WHERE id = ?`
      ).bind(logId).first();
      return { subject: row?.subject || subject, body: row?.body || body, to: row?.to_address || contactEmail };
    });

    const gmailResult = await step.do('send-email', async () => {
      const result = await sendGmail(this.env, {
        to: latestLog.to,
        subject: latestLog.subject,
        body: latestLog.body,
        threadId: threadId || null,
        logId,
        isFollowUp: step_num > 1,
      });
      // Return serializable result — never throw so step.do doesn't infinite-retry
      if (!result || result.error) {
        return { error: true, detail: typeof result?.error === 'string' ? result.error : 'Gmail error' };
      }
      return { id: result.id || null, threadId: result.threadId || null };
    });

    if (gmailResult?.error) {
      await step.do('mark-send-failed', async () => {
        await this.env.DB.prepare(
          `UPDATE outreach_logs SET notes = 'Gmail send failed — retry manually' WHERE id = ?`
        ).bind(logId).run();
      });
      return { outcome: 'send_failed', logId };
    }

    // ── Step 5: Update D1 + venue status ─────────────────────────
    await step.do('update-records', async () => {
      await this.env.DB.prepare(`
        UPDATE outreach_logs
        SET approval_status = 'approved', sent_at = datetime('now'),
            gmail_thread_id = ?, gmail_message_id = ?
        WHERE id = ?
      `).bind(gmailResult?.threadId || null, gmailResult?.id || null, logId).run();

      await this.env.DB.prepare(`
        UPDATE venues
        SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).bind(venueId).run();
    });

    // ── Step 6: Auto-embed into Vectorize for voice matching ────────────
    // Fire-and-forget — don't block return on embedding success
    await step.do('embed-voice', async () => {
      if (!this.env.VECTORIZE || !this.env.AI) return { skipped: true };
      try {
        const row = await this.env.DB.prepare(
          `SELECT o.subject, o.body, o.self_score, v.name as venue_name, v.category
           FROM outreach_logs o JOIN venues v ON v.id = o.venue_id WHERE o.id = ?`
        ).bind(logId).first();
        if (!row || (row.self_score || 0) < 7) return { skipped: true, reason: 'low score' };
        const textToEmbed = `Subject: ${row.subject}\n\nVenue type: ${row.category || 'unknown'}\n\n${row.body}`;
        const embResult = await this.env.AI.run('@cf/baai/bge-large-en-v1.5', { text: [textToEmbed] });
        const vector = embResult?.data?.[0];
        if (!vector) return { skipped: true, reason: 'embed failed' };
        await this.env.VECTORIZE.upsert([{
          id: String(logId),
          values: vector,
          metadata: {
            subject: (row.subject || '').slice(0, 200),
            body_preview: (row.body || '').slice(0, 500),
            venue_name: row.venue_name || '',
            category: row.category || '',
            self_score: row.self_score || 0,
          },
        }]);
        return { embedded: true };
      } catch (err) {
        return { error: err.message };
      }
    });

    return { outcome: 'sent', logId, gmailId: gmailResult?.id };
  }
}

// ── Gmail helper (same as approval-mailer.js but local copy for the Workflow) ─
// Bug 1.1 — contact-gate check. Lightweight variant of canContactAddress in outreach-agent.js.
// Duplicated here instead of imported to keep the workflow entry-point self-contained.
async function checkContactGate(toAddress, env, opts = {}) {
  if (!toAddress || typeof toAddress !== 'string') return { reason: 'no_address' };
  const addr = toAddress.trim().toLowerCase();
  const INVALID = [/@domain\.(com|org|net)$/i, /@example\./i, /^test@/i, /^user@/i, /^noreply@/i, /^no-reply@/i, /^donotreply@/i, /^info@info\./i, /@localhost/i];
  if (INVALID.some(p => p.test(addr))) return { reason: 'placeholder_address', detail: addr };

  // Follow-ups intentionally re-send to the same address within the 90d window — that IS the follow-up.
  if (!opts.isFollowUp) {
    const recent = await env.DB.prepare(
      `SELECT id, sent_at, venue_id FROM outreach_logs WHERE LOWER(to_address) = ? AND sent_at IS NOT NULL AND sent_at >= datetime('now','-90 days') ORDER BY sent_at DESC LIMIT 1`
    ).bind(addr).first().catch(() => null);
    if (recent) return { reason: 'recent_send_exists', detail: `Last sent ${recent.sent_at?.slice(0, 10)} for ${recent.venue_id}` };
  }

  const declined = await env.DB.prepare(
    `SELECT classification FROM inbound_replies WHERE LOWER(from_email) = ? AND classification IN ('already_has_vendor','not_interested','unsubscribe','negative') ORDER BY received_at DESC LIMIT 1`
  ).bind(addr).first().catch(() => null);
  if (declined) return { reason: 'previously_declined', detail: declined.classification };

  // Audit Gap 7 — domain-level check, same as canContactAddress in outreach-agent.js.
  const at = addr.indexOf('@');
  if (at > 0) {
    const domain = addr.slice(at + 1);
    const FREE_MAIL = new Set(['gmail.com','googlemail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','me.com','aol.com','proton.me','protonmail.com','msn.com','live.com','ymail.com']);
    if (!FREE_MAIL.has(domain)) {
      const domainDeclined = await env.DB.prepare(
        `SELECT from_email, classification FROM inbound_replies WHERE LOWER(from_email) LIKE ? AND classification IN ('already_has_vendor','not_interested','unsubscribe','negative') ORDER BY received_at DESC LIMIT 1`
      ).bind('%@' + domain).first().catch(() => null);
      if (domainDeclined) return { reason: 'previously_declined', detail: `Domain declined via ${domainDeclined.from_email}` };
    }
  }

  return null;
}

// V3 Bug 1.5 — click tracking link rewrite. Duplicated from outreach-agent.js
// on purpose: workflow is a separate module and we avoid cross-worker imports.
function rewriteLinksForTracking(body, logId) {
  if (!body || !logId) return body;
  const base = 'https://pretzel-os.drew-f39.workers.dev/track/click/';
  const encode = (s) => {
    const bytes = new TextEncoder().encode(s);
    const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
    return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return body.replace(/(https?:\/\/[^\s<>"')]+)/g, (match) => {
    if (match.startsWith('https://pretzel-os.drew-f39.workers.dev/outreach/pixel/')) return match;
    if (match.startsWith('https://pretzel-os.drew-f39.workers.dev/track/click/')) return match;
    return `${base}${logId}?u=${encode(match)}`;
  });
}

async function sendGmail(env, { to, subject, body, threadId, logId, isFollowUp = false }) {
  // Bug 1.1 Site (c) for workflow path: final send-time gate.
  const blocked = await checkContactGate(to, env, { isFollowUp });
  if (blocked) {
    console.error(`[OutreachWorkflow] sendGmail ABORTED — ${blocked.reason}: ${blocked.detail || ''} (to=${to}, logId=${logId})`);
    throw new Error(`contact_gate_blocked: ${blocked.reason}`);
  }

  // V3 Bug 1.5 — rewrite http(s) URLs in the body for click tracking.
  body = rewriteLinksForTracking(body, logId);

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

  // Convert plain text body to HTML with tracking pixel
  const pixelUrl = logId
    ? `https://pretzel-os.drew-f39.workers.dev/outreach/pixel/${logId}`
    : null;
  const htmlBody = body.replace(/\n/g, '<br>') +
    (pixelUrl ? `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="">` : '');

  // RFC 2047 encode subject when it contains non-ASCII (em dashes, etc.)
  const encodedSubject = /^[\x00-\x7F]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(subject)))}?=`;

  const message = [
    `To: ${to}`,
    `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
  ].join('\r\n');
  const bytes = new TextEncoder().encode(message);
  const binString = Array.from(bytes, b => String.fromCodePoint(b)).join('');
  const encoded = btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(threadId ? { raw: encoded, threadId } : { raw: encoded }),
  });
  const result = await resp.json();
  return result; // { id, threadId, labelIds }
}

// ── CATERING APPROVAL WORKFLOW ────────────────────────────────────────────────
// Same pattern as OutreachApprovalWorkflow but uses catering_outreach_logs +
// catering_leads tables. Separate binding so Workflow state is isolated.

export class CateringApprovalWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const {
      logId,
      leadId,
      leadName,
      contactEmail,
      subject,
      body,
      selfScore,
      reasoning,
      threadId,
    } = event.payload;

    await step.do('write-pending', async () => {
      await this.env.DB.prepare(`
        INSERT OR IGNORE INTO catering_outreach_logs (
          id, lead_id, sequence_step, channel, direction,
          subject, body, from_address, to_address,
          approval_status, agent_reasoning, self_score, gmail_thread_id, created_at
        ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
      `).bind(
        logId, leadId, subject, body,
        this.env.FROM_EMAIL, contactEmail,
        reasoning, selfScore, threadId || null
      ).run();
    });

    await step.do('send-approval-email', async () => {
      await sendApprovalRequestEmail({
        logId,
        venueName: leadName,
        contactEmail,
        subject,
        body,
        selfScore,
        reasoning,
        channel: 'catering',
      }, this.env);
    });

    let decision;
    try {
      decision = await step.waitForEvent('waiting for Drew approval', { type: 'decision', timeout: '48 hours' });
    } catch {
      await step.do('mark-expired', async () => {
        await this.env.DB.prepare(`
          UPDATE catering_outreach_logs
          SET approval_status = 'expired', notes = 'No response within 48h'
          WHERE id = ? AND approval_status = 'pending'
        `).bind(logId).run();
      });
      return { outcome: 'expired', logId };
    }

    const approved = decision?.payload?.approved ?? decision?.approved ?? false;

    if (!approved) {
      await step.do('mark-rejected', async () => {
        const note = decision?.payload?.note || decision?.note || 'Rejected by Drew';
        await this.env.DB.prepare(`
          UPDATE catering_outreach_logs
          SET approval_status = 'rejected', notes = ?
          WHERE id = ? AND approval_status = 'pending'
        `).bind(note, logId).run();
      });
      return { outcome: 'rejected', logId };
    }

    // Re-read latest draft in case Drew voice-coached it while it was pending
    const latestLog = await step.do('read-latest-draft', async () => {
      const row = await this.env.DB.prepare(
        `SELECT subject, body, to_address FROM catering_outreach_logs WHERE id = ?`
      ).bind(logId).first();
      return { subject: row?.subject || subject, body: row?.body || body, to: row?.to_address || contactEmail };
    });

    const gmailResult = await step.do('send-email', async () => {
      return sendGmail(this.env, { to: latestLog.to, subject: latestLog.subject, body: latestLog.body, threadId: threadId || null, logId });
    });

    await step.do('update-records', async () => {
      await this.env.DB.prepare(`
        UPDATE catering_outreach_logs
        SET approval_status = 'approved', sent_at = datetime('now'),
            gmail_thread_id = ?, gmail_message_id = ?
        WHERE id = ?
      `).bind(gmailResult?.threadId || null, gmailResult?.id || null, logId).run();

      await this.env.DB.prepare(`
        UPDATE catering_leads
        SET status = 'contacted', last_contacted = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).bind(leadId).run();
    });

    return { outcome: 'sent', logId, gmailId: gmailResult?.id };
  }
}
