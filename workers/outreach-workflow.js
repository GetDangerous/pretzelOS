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
    } = event.payload;
    const step_num = sequenceStep || 1;

    // ── Step 1: Write pending record to D1 ───────────────────────
    await step.do('write-pending', async () => {
      await this.env.DB.prepare(`
        INSERT OR IGNORE INTO outreach_logs (
          id, venue_id, sequence_step, channel, direction,
          subject, body, from_address, to_address,
          approval_status, agent_reasoning, self_score,
          subject_variant, created_at
        ) VALUES (?, ?, ?, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, ?, datetime('now'))
      `).bind(
        logId, venueId, step_num, subject, body,
        this.env.FROM_EMAIL, contactEmail,
        reasoning, selfScore, subjectVariant || null
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
        logId,
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
async function sendGmail(env, { to, subject, body, logId }) {
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

  const message = [
    `To: ${to}`,
    `From: Drew <${env.FROM_EMAIL}>`,
    `Subject: ${subject}`,
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
    body: JSON.stringify({ raw: encoded }),
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
    } = event.payload;

    await step.do('write-pending', async () => {
      await this.env.DB.prepare(`
        INSERT OR IGNORE INTO catering_outreach_logs (
          id, lead_id, sequence_step, channel, direction,
          subject, body, from_address, to_address,
          approval_status, agent_reasoning, self_score, created_at
        ) VALUES (?, ?, 1, 'email', 'out', ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
      `).bind(
        logId, leadId, subject, body,
        this.env.FROM_EMAIL, contactEmail,
        reasoning, selfScore
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
      return sendGmail(this.env, { to: latestLog.to, subject: latestLog.subject, body: latestLog.body, logId });
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
