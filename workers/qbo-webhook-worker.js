/**
 * Dangerous Pretzel Co — QBO Webhook Receiver
 * Cloudflare Worker (HTTP endpoint — receives push from QBO)
 *
 * QBO fires webhooks instantly when financial events occur:
 * - Invoice created/updated/paid/voided
 * - Payment received
 * - Estimate created/converted
 * - Bill/purchase recorded (COGS, expenses)
 * - Customer created/updated
 *
 * This worker:
 *   1. Validates the QBO webhook signature
 *   2. Parses the event payload
 *   3. Writes to qbo_events in D1
 *   4. Fuzzy-matches to venues/accounts
 *   5. Runs a quick Claude interpretation (is this significant?)
 *   6. Creates a financial_flag if action is needed
 *   7. Notifies Drew immediately for critical events
 *
 * Endpoint: POST /qbo/webhook
 *
 * QBO Webhook Setup:
 *   developer.intuit.com → Your App → Webhooks
 *   → Add endpoint: https://api.dangerouspretzel.com/qbo/webhook
 *   → Subscribe to: Invoice, Payment, Estimate, Bill, PurchaseOrder, Customer
 *   → Copy the verifier token → store as QBO_WEBHOOK_TOKEN secret
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   QBO_WEBHOOK_TOKEN   — from Intuit webhook setup (verifier token)
 *   GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN
 *   FROM_EMAIL, DREW_EMAIL
 *   DB, KV
 */

import { getQBOToken } from './qbo-client.js';
import { callAI } from './ai-budget.js';

// Thresholds for significance flagging
const LARGE_INVOICE_THRESHOLD = 1000;   // Invoice > $1k = high significance
const LARGE_BILL_THRESHOLD    = 500;    // Bill/expense > $500 = medium significance
const LARGE_PAYMENT_THRESHOLD = 1000;   // Payment > $1k = notify Drew

// Entity types we care about and their significance rules
const SIGNIFICANCE_RULES = {
  Invoice: {
    Create: (amount) => amount > LARGE_INVOICE_THRESHOLD ? 'high' : 'medium',
    Update: () => 'low',
    Void:   () => 'high',   // Voided invoice = always worth knowing
    Delete: () => 'high',
  },
  Payment: {
    Create: (amount) => amount > LARGE_PAYMENT_THRESHOLD ? 'high' : 'medium',
    Delete: () => 'high',   // Deleted payment = potential problem
    Void:   () => 'high',
  },
  Estimate: {
    Create: (amount) => amount > 0 ? 'medium' : 'low',  // New wholesale order
    Update: () => 'low',
    Delete: () => 'medium',
  },
  Bill: {
    Create: (amount) => amount > LARGE_BILL_THRESHOLD ? 'high' : 'medium',
    Update: () => 'low',
    Delete: () => 'medium',
  },
  PurchaseOrder: {
    Create: (amount) => amount > LARGE_BILL_THRESHOLD ? 'high' : 'low',
    Update: () => 'low',
  },
  Customer: {
    Create: () => 'low',   // New QBO customer = new account potentially
    Update: () => 'low',
    Merge:  () => 'medium',
  },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // QBO webhook challenge (GET) — Intuit verifies the endpoint on setup
    if (request.method === 'GET' && url.pathname === '/qbo/webhook') {
      const challenge = url.searchParams.get('challenge');
      if (challenge) {
        return new Response(challenge, {
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    }

    // QBO webhook payload (POST)
    if (request.method === 'POST' && url.pathname === '/qbo/webhook') {
      return handleWebhook(request, env, ctx);
    }

    // Test endpoint — show recent events
    if (url.pathname === '/qbo/events') {
      return getRecentEvents(env);
    }

    return new Response('QBO Webhook', { status: 200 });
  }
};

// ── WEBHOOK HANDLER ───────────────────────────────────────────────────────────
async function handleWebhook(request, env, ctx) {
  const body = await request.text();

  // Validate Intuit signature
  const signature = request.headers.get('intuit-signature');
  if (!await verifyQBOSignature(body, signature, env.QBO_WEBHOOK_TOKEN)) {
    console.error('[Webhook] Invalid QBO signature');
    return new Response('Unauthorized', { status: 401 });
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // QBO sends batched events
  const eventNotifications = payload.eventNotifications || [];

  // Process all events in background — return 200 immediately to QBO
  ctx.waitUntil(processEvents(eventNotifications, env));

  return new Response('OK', { status: 200 });
}

// ── EVENT PROCESSOR ───────────────────────────────────────────────────────────
async function processEvents(notifications, env) {
  for (const notification of notifications) {
    const realmId = notification.realmId;
    const dataChangeEvent = notification.dataChangeEvent;

    if (!dataChangeEvent?.entities) continue;

    for (const entity of dataChangeEvent.entities) {
      try {
        await processEntity(entity, realmId, env);
      } catch (err) {
        console.error(`[Webhook] Error processing entity ${entity.name}:`, err.message);
      }
    }
  }
}

async function processEntity(entity, realmId, env) {
  const entityType = entity.name;      // Invoice, Payment, etc.
  const eventType  = entity.operation; // Create, Update, Delete, Void
  const entityId   = entity.id;
  const entityTime = entity.lastUpdated;

  console.log(`[Webhook] ${eventType} ${entityType} ${entityId}`);

  // Check if we've already processed this event
  const existing = await env.DB.prepare(
    'SELECT id FROM qbo_events WHERE qbo_entity_id = ? AND entity_type = ? AND event_type = ?'
  ).bind(entityId, entityType, eventType).first();
  if (existing) return;

  // Fetch the actual entity details from QBO to get amounts + names
  let entityDetails = {};
  try {
    entityDetails = await fetchEntityDetails(entityType, entityId, env);
  } catch (err) {
    console.error(`[Webhook] Could not fetch entity details:`, err.message);
    // Continue with what we have — still log the event
  }

  const amount     = extractAmount(entityDetails, entityType);
  const entityName = extractName(entityDetails, entityType);
  const status     = extractStatus(entityDetails, entityType);
  const dueDate    = extractDueDate(entityDetails, entityType);
  const docNumber  = entityDetails.DocNumber || null;

  // Determine significance
  const sigRule = SIGNIFICANCE_RULES[entityType]?.[eventType];
  const significance = sigRule ? sigRule(amount) : 'low';

  // Fuzzy-match to D1 venue/account
  const { venueId, accountId } = await fuzzyMatchEntity(entityName, env);

  // Quick Claude interpretation for medium+ significance events
  let interpretation = null;
  if (significance !== 'low' && entityName) {
    interpretation = await interpretEvent(
      entityType, eventType, entityName, amount, status, significance, env
    );
  }

  // Determine if action is required
  const actionRequired = significance === 'high' || significance === 'critical' ? 1 : 0;

  // Write event to D1
  const eventId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO qbo_events (
      id, qbo_entity_id, entity_type, event_type,
      entity_name, amount, status, due_date, doc_number,
      matched_venue_id, matched_account_id,
      significance, interpretation, action_required,
      raw_payload, qbo_event_time, processed, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  `).bind(
    eventId, entityId, entityType, eventType,
    entityName, amount, status, dueDate, docNumber,
    venueId, accountId,
    significance, interpretation, actionRequired,
    JSON.stringify(entityDetails),
    entityTime
  ).run();

  // Create a financial flag for high-significance events
  let flagId = null;
  if (actionRequired) {
    flagId = await createEventFlag(
      eventId, entityType, eventType, entityName,
      amount, status, interpretation, env
    );
  }

  // Immediate Drew notification for critical events
  if (significance === 'critical' || isCriticalEvent(entityType, eventType, amount)) {
    await sendImmediateAlert(entityType, eventType, entityName, amount, interpretation, env);
  }

  // Update account health if this is a payment for a matched account
  if (entityType === 'Payment' && eventType === 'Create' && accountId) {
    await env.DB.prepare(`
      UPDATE active_accounts
      SET last_order_date = datetime('now'),
          health_status = 'green',
          consecutive_missed = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(accountId).run();
  }

  // Store in KV for real-time dashboard display
  const recentEvents = JSON.parse(await env.KV.get('recent_qbo_events') || '[]');
  recentEvents.unshift({
    id: eventId,
    type: `${eventType} ${entityType}`,
    entity: entityName,
    amount,
    significance,
    interpretation,
    at: new Date().toISOString(),
  });
  await env.KV.put(
    'recent_qbo_events',
    JSON.stringify(recentEvents.slice(0, 50)), // keep last 50
    { expirationTtl: 60 * 60 * 24 * 7 }
  );

  // ── WHOLESALE LIFECYCLE ──────────────────────────────────────────────────────
  if (['Customer', 'Invoice', 'Estimate', 'Payment'].includes(entityType)) {
    try {
      await processWholesaleLifecycle(
        entityType, eventType, entityDetails, entityId,
        entityName, amount, venueId, accountId, eventId, env
      );
    } catch (err) {
      console.error(`[Webhook] Lifecycle error: ${err.message}`);
    }
  }

  console.log(`[Webhook] Processed: ${eventType} ${entityType} "${entityName}" $${amount} (${significance})`);
}

// ══════════════════════════════════════════════════════════════════════════════
// WHOLESALE LIFECYCLE — QBO is source of truth for account status
// ══════════════════════════════════════════════════════════════════════════════

async function processWholesaleLifecycle(
  entityType, eventType, entityDetails, qboEntityId,
  entityName, amount, venueId, accountId, eventId, env
) {
  // ── NEW CUSTOMER CREATED ──────────────────────────────────────────────────
  if (entityType === 'Customer' && eventType === 'Create') {
    console.log(`[QBO Lifecycle] New customer: ${entityName}`);

    if (!venueId) {
      // No D1 match — create venue entry for new account
      const newVenueId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR IGNORE INTO venues (
          id, name, status, source, notes, created_at, updated_at
        ) VALUES (?, ?, 'active', 'qbo_direct', 'Created from QBO customer — not in outreach pipeline', datetime('now'), datetime('now'))
      `).bind(newVenueId, entityName).run();
      venueId = newVenueId;

      await env.KV.put(`drew_flag:new_qbo_customer:${newVenueId}`, JSON.stringify({
        venue_id: newVenueId, name: entityName,
        reason: 'New QBO customer with no D1 match — add details to complete profile',
        flagged_at: new Date().toISOString(),
      }), { expirationTtl: 60 * 60 * 24 * 14 });

      console.log(`[QBO Lifecycle] Created new venue for unmatched QBO customer: ${entityName}`);
    }

    // Mark venue as active — stop outreach
    await env.DB.prepare(`
      UPDATE venues SET status = 'active', updated_at = datetime('now')
      WHERE id = ? AND status != 'active'
    `).bind(venueId).run();

    // Remove active outreach holds
    await env.DB.prepare(`
      UPDATE outreach_holds SET active = 0, updated_at = datetime('now')
      WHERE venue_id = ? AND active = 1
    `).bind(venueId).run();

    // Create active_accounts row if needed
    const existingAccount = await env.DB.prepare(
      'SELECT id FROM active_accounts WHERE venue_id = ?'
    ).bind(venueId).first();

    if (!existingAccount) {
      await env.DB.prepare(`
        INSERT INTO active_accounts (
          id, venue_id, health_status, activated_at,
          fulfilled_by, created_at, updated_at
        ) VALUES (?, ?, 'green', datetime('now'), 'self', datetime('now'), datetime('now'))
      `).bind(crypto.randomUUID(), venueId).run();
      console.log(`[QBO Lifecycle] Active account created for: ${entityName}`);
    }

    // Store QBO→venue mapping for future matching
    await env.DB.prepare(`
      INSERT OR IGNORE INTO qbo_venue_mapping (id, qbo_name, venue_id, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).bind(`qbo_${entityName.replace(/\s+/g,'_').toLowerCase()}`, entityName, venueId).run();

    await env.KV.put('new_account_alert', JSON.stringify({
      venue_name: entityName, activated_at: new Date().toISOString(), source: 'qbo_customer_create',
    }), { expirationTtl: 60 * 60 * 24 });
    return;
  }

  // ── ESTIMATE CREATED (packing slip / order in progress) ───────────────────
  if (entityType === 'Estimate' && eventType === 'Create') {
    if (!venueId && !accountId) {
      console.log(`[QBO Lifecycle] Estimate for unmatched customer: ${entityName} — skipping`);
      return;
    }
    // Use the actual QBO TxnDate (the date Drew dated the estimate in QBO),
    // not the webhook delivery time. Falls back to today only if missing.
    const estTxnDate = entityDetails?.TxnDate || new Date().toISOString().split('T')[0];
    await env.DB.prepare(`
      INSERT OR IGNORE INTO orders (
        id, account_id, source, order_date,
        gross_revenue, status, doc_number, notes, created_at
      ) VALUES (?, ?, 'qbo_estimate', ?, ?, 'estimate', ?, ?, datetime('now'))
    `).bind(
      `qbo_est_${qboEntityId}`, accountId || null,
      estTxnDate,
      amount || 0,
      entityDetails?.DocNumber || null,
      `QBO Estimate ${entityDetails?.DocNumber || qboEntityId} — packing slip, not yet delivered`
    ).run();
    console.log(`[QBO Lifecycle] Estimate logged for ${entityName}: $${amount} (TxnDate ${estTxnDate})`);
    return;
  }

  // ── INVOICE CREATED (delivered) ───────────────────────────────────────────
  if (entityType === 'Invoice' && eventType === 'Create') {
    const linkedEstimate = entityDetails?.LinkedTxn?.find(t => t.TxnType === 'Estimate');
    if (linkedEstimate) {
      // Update estimate status
      await env.DB.prepare(`
        UPDATE orders SET status = 'invoiced', updated_at = datetime('now')
        WHERE id = ?
      `).bind(`qbo_est_${linkedEstimate.TxnId}`).run();
    }

    // Use actual TxnDate, not webhook delivery time
    const invTxnDate = entityDetails?.TxnDate || new Date().toISOString().split('T')[0];
    // Write invoice as order record
    await env.DB.prepare(`
      INSERT OR IGNORE INTO orders (
        id, account_id, source, order_date,
        gross_revenue, status, doc_number, notes, created_at
      ) VALUES (?, ?, 'qbo_invoice', ?, ?, 'invoiced', ?, ?, datetime('now'))
    `).bind(
      `qbo_inv_${qboEntityId}`, accountId || null,
      invTxnDate,
      amount || 0,
      entityDetails?.DocNumber || null,
      `QBO Invoice ${entityDetails?.DocNumber || ''} — delivered ${invTxnDate}, awaiting payment`
    ).run();

    // Update account health
    if (accountId) {
      await env.DB.prepare(`
        UPDATE active_accounts
        SET last_order_date = datetime('now'), health_status = 'green',
            consecutive_missed = 0, updated_at = datetime('now')
        WHERE id = ?
      `).bind(accountId).run();
    }
    console.log(`[QBO Lifecycle] Delivery recorded for ${entityName}: $${amount}`);
    return;
  }

  // ── PAYMENT RECEIVED ──────────────────────────────────────────────────────
  if (entityType === 'Payment' && eventType === 'Create') {
    console.log(`[QBO Lifecycle] Payment received: ${entityName} $${amount}`);

    // Mark related invoice as paid
    const linkedInvoice = entityDetails?.Line?.find(l => l.LinkedTxn?.[0]?.TxnType === 'Invoice');
    if (linkedInvoice) {
      await env.DB.prepare(`
        UPDATE orders SET status = 'paid', updated_at = datetime('now')
        WHERE id = ?
      `).bind(`qbo_inv_${linkedInvoice.LinkedTxn[0].TxnId}`).run();
    }

    // Update account LTV
    if (accountId) {
      await env.DB.prepare(`
        UPDATE active_accounts
        SET total_rev_lifetime = total_rev_lifetime + ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(amount, accountId).run();
    }

    // Check for first-ever payment → fire closed deal signal
    if (accountId) {
      const prev = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM orders
        WHERE account_id = ? AND status = 'paid' AND id != ?
      `).bind(accountId, `qbo_pay_${qboEntityId}`).first();

      if (prev?.count === 0 && venueId) {
        // Find the outreach email that led to this close
        const closingEmail = await env.DB.prepare(`
          SELECT o.id, o.sequence_step, o.subject, o.self_score, o.sent_at,
                 ap.version as prompt_version, v.category as venue_category
          FROM outreach_logs o
          JOIN venues v ON v.id = o.venue_id
          LEFT JOIN agent_prompts ap ON ap.agent_name = 'outreach_email' AND ap.active = 1
          WHERE o.venue_id = ? AND o.direction = 'out'
          ORDER BY o.sent_at DESC LIMIT 1
        `).bind(venueId).first();

        if (closingEmail) {
          const daysToClose = Math.floor(
            (Date.now() - new Date(closingEmail.sent_at).getTime()) / 86400000
          );
          await env.DB.prepare(`
            INSERT OR IGNORE INTO closed_deal_signals (
              id, venue_id, activated_at, outreach_log_id,
              prompt_version, sequence_step, subject_line,
              self_score, days_to_close, venue_category, created_at
            ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).bind(
            crypto.randomUUID(), venueId,
            closingEmail.id, closingEmail.prompt_version || null,
            closingEmail.sequence_step, closingEmail.subject,
            closingEmail.self_score, daysToClose,
            closingEmail.venue_category
          ).run();
          console.log(`[QBO Lifecycle] Closed deal signal: ${daysToClose} days to close`);
        }
      }
    }

    // Detect card on file
    const hasCard = entityDetails?.CreditCardPayment ||
      entityDetails?.PaymentMethodRef?.name?.toLowerCase().includes('card');
    if (hasCard && accountId) {
      await env.DB.prepare(
        "UPDATE active_accounts SET has_card_on_file = 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(accountId).run();
    }
    return;
  }

  // ── INVOICE VOIDED ────────────────────────────────────────────────────────
  if (entityType === 'Invoice' && (eventType === 'Void' || eventType === 'Delete')) {
    await env.DB.prepare(`
      UPDATE orders SET status = 'voided', updated_at = datetime('now')
      WHERE id = ?
    `).bind(`qbo_inv_${qboEntityId}`).run();
    console.log(`[QBO Lifecycle] Invoice voided: ${qboEntityId}`);
    return;
  }
}

// ── QBO ENTITY FETCHER ────────────────────────────────────────────────────────
async function fetchEntityDetails(entityType, entityId, env) {
  // Import token getter from qbo-client
  // In production, Claude Code should wire this to the bookkeeper auth
  const token = await getQBOToken(env);
  const kvRealmId = await env.KV.get('qbo_realm_id');
  const realmId = kvRealmId || env.QBO_REALM_ID;

  const endpointMap = {
    Invoice: 'invoice',
    Payment: 'payment',
    Estimate: 'estimate',
    Bill: 'bill',
    PurchaseOrder: 'purchaseorder',
    Customer: 'customer',
  };

  const endpoint = endpointMap[entityType];
  if (!endpoint) return {};

  const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/${endpoint}/${entityId}?minorversion=65`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) throw new Error(`QBO fetch ${response.status}`);

  const data = await response.json();
  // QBO wraps response in entity name: { Invoice: {...} } or { QueryResponse: { Invoice: [...] } }
  return data[entityType] || data.QueryResponse?.[entityType]?.[0] || data;
}

// ── CLAUDE INTERPRETATION ─────────────────────────────────────────────────────
async function interpretEvent(entityType, eventType, entityName, amount, status, significance, env) {
  const prompt = `You are the CFO agent for Dangerous Pretzel Co. A real-time QBO event just fired.

Event: ${eventType} ${entityType}
Entity: ${entityName}
Amount: ${amount ? '$' + amount.toFixed(2) : 'N/A'}
Status: ${status || 'N/A'}
Significance: ${significance}

Known accounts: Delta Center (NBA arena), SLC Bees, Powder Mountain, Alta Ski, Union Event Center, Pioneer Theater, TF/Hopkins/ROHA/HK Brewing.

Write ONE sentence (max 20 words) that tells Drew exactly what this means in plain English.
No jargon. Be specific. If it's good news, say so. If action is needed, say so.

Examples:
- "Delta Center paid their $1,240 invoice — cash up, account healthy."
- "New $680 ingredient bill recorded — COGS up this week, review margins."
- "Hopkins Brewery invoice voided — check with Drew if this was intentional."
- "New wholesale estimate for $420 — order in pipeline, not yet invoiced."

Return just the sentence, nothing else.`;

  // Try Workers AI first (free, no egress) — fall back to claude-haiku
  try {
    if (env.AI) {
      const aiResp = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 60,
      });
      const result = aiResp?.response?.trim();
      if (result) return result;
    }
  } catch { /* fall through */ }

  try {
    // DIF-3 (May 13 2026): wired through ai-budget
    const result = await callAI(env, {
      use_case: 'qbo_txn_notes',
      model: 'haiku',
      caller: 'qbo-webhook-worker.js',
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    });

    if (!result.ok) return null;
    return result.content?.trim() || null;
  } catch {
    return null;
  }
}

// ── FLAG CREATOR ──────────────────────────────────────────────────────────────
async function createEventFlag(eventId, entityType, eventType, entityName, amount, status, interpretation, env) {
  const flagId = crypto.randomUUID();
  const weekStart = getMonday(new Date());

  const flagTypeMap = {
    Invoice_Void: 'revenue_variance',
    Invoice_Delete: 'revenue_variance',
    Payment_Delete: 'revenue_variance',
    Payment_Void: 'revenue_variance',
    Bill_Create: 'expense_anomaly',
    PurchaseOrder_Create: 'expense_anomaly',
  };

  const flagType = flagTypeMap[`${entityType}_${eventType}`] || 'channel_insight';

  const severity = amount > 2000 ? 'high'
    : amount > 500  ? 'medium'
    : 'low';

  const suggestedAction = buildSuggestedAction(entityType, eventType, entityName, amount, status);

  // Normalize null entity_name for the unique-index dedup (migration 026).
  const normEntity = entityName || '(global)';

  await env.DB.prepare(`
    INSERT INTO financial_flags (
      id, week_start, flag_type, severity, channel,
      entity_name, title, detail, data_point,
      suggested_action, triggered_by_event, status, created_at, dedupe_count
    ) VALUES (?, ?, ?, ?, 'all', ?, ?, ?, ?, ?, ?, 'open', datetime('now'), 1)
    ON CONFLICT(entity_name, flag_type, week_start) DO UPDATE SET
      dedupe_count        = dedupe_count + 1,
      severity            = excluded.severity,
      title               = excluded.title,
      detail              = excluded.detail,
      data_point          = excluded.data_point,
      suggested_action    = excluded.suggested_action,
      triggered_by_event  = excluded.triggered_by_event,
      status              = CASE WHEN financial_flags.status = 'resolved' THEN 'resolved' ELSE 'open' END
  `).bind(
    flagId, weekStart, flagType, severity,
    normEntity,
    `${eventType}: ${entityType} — ${entityName}`,
    interpretation || `${eventType} ${entityType} for ${entityName}${amount ? ' ($' + amount.toFixed(0) + ')' : ''}`,
    amount ? `$${amount.toFixed(2)}` : null,
    suggestedAction,
    eventId
  ).run();

  return flagId;
}

// ── IMMEDIATE ALERT ───────────────────────────────────────────────────────────
async function sendImmediateAlert(entityType, eventType, entityName, amount, interpretation, env) {
  const subject = `⚡ QBO Alert: ${eventType} ${entityType}${entityName ? ` — ${entityName}` : ''}`;
  const body = `Real-time QBO event:

${interpretation || `${eventType} ${entityType} for ${entityName}${amount ? ' ($' + amount.toFixed(2) + ')' : ''}`}

View in dashboard: https://pretzel-dashboard.pages.dev

— Pretzel OS CFO (real-time alert)`;

  try {
    await sendGmail(env, { to: env.DREW_EMAIL, subject, body });
    console.log(`[Webhook] Critical alert sent to Drew`);
  } catch (err) {
    console.error(`[Webhook] Alert email failed:`, err.message);
  }
}

// ── FUZZY MATCH ───────────────────────────────────────────────────────────────
async function fuzzyMatchEntity(entityName, env) {
  if (!entityName) return { venueId: null, accountId: null };

  // Normalize: lowercase, strip punctuation, split to words
  const normalize = str => str.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const nameWords = normalize(entityName);

  const venues = await env.DB.prepare(`
    SELECT v.id as venue_id, aa.id as account_id, v.name
    FROM venues v
    LEFT JOIN active_accounts aa ON aa.venue_id = v.id
    WHERE v.status = 'active' OR aa.id IS NOT NULL
  `).all();

  let bestMatch = null;
  let bestScore = 0;

  for (const venue of (venues.results || [])) {
    const venueWords = normalize(venue.name);
    const overlap = nameWords.filter(w => venueWords.includes(w)).length;
    const score = overlap / Math.max(nameWords.length, venueWords.length);

    if (score > bestScore && score >= 0.4) {  // 40% word overlap threshold
      bestScore = score;
      bestMatch = venue;
    }
  }

  return {
    venueId: bestMatch?.venue_id || null,
    accountId: bestMatch?.account_id || null,
  };
}

// ── ENDPOINT: Recent events ───────────────────────────────────────────────────
async function getRecentEvents(env) {
  const events = await env.DB.prepare(`
    SELECT entity_type, event_type, entity_name, amount, status,
           significance, interpretation, action_required, received_at
    FROM qbo_events
    ORDER BY received_at DESC
    LIMIT 50
  `).all();

  return new Response(JSON.stringify(events.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function extractAmount(entity, entityType) {
  if (!entity) return 0;
  const amountFields = ['TotalAmt', 'Amount', 'TxnAmount', 'Balance', 'TotalPrice'];
  for (const field of amountFields) {
    if (entity[field] !== undefined) return parseFloat(entity[field]) || 0;
  }
  return 0;
}

function extractName(entity, entityType) {
  if (!entity) return null;
  if (entityType === 'Customer') return entity.DisplayName || entity.CompanyName;
  if (entityType === 'Invoice' || entityType === 'Estimate') {
    return entity.CustomerRef?.name || entity.BillEmail?.Address || null;
  }
  if (entityType === 'Payment') return entity.CustomerRef?.name || null;
  if (entityType === 'Bill' || entityType === 'PurchaseOrder') {
    return entity.VendorRef?.name || null;
  }
  return null;
}

function extractStatus(entity, entityType) {
  if (!entity) return null;
  return entity.Balance !== undefined && entity.Balance === 0 ? 'Paid'
    : entity.status || entity.PaymentStatus || null;
}

function extractDueDate(entity, entityType) {
  if (!entity) return null;
  return entity.DueDate || entity.TxnDate || null;
}

function isCriticalEvent(entityType, eventType, amount) {
  if (entityType === 'Invoice' && eventType === 'Void') return true;
  if (entityType === 'Payment' && eventType === 'Delete') return true;
  if (amount > 5000) return true;  // Any event > $5k is critical
  return false;
}

function buildSuggestedAction(entityType, eventType, entityName, amount, status) {
  const actions = {
    'Invoice_Void': `Verify with Drew if the ${entityName} invoice void was intentional. If not, re-create in QBO immediately.`,
    'Invoice_Delete': `Check why the ${entityName} invoice was deleted. May need to be re-created.`,
    'Payment_Delete': `Payment from ${entityName} was deleted in QBO. Verify with bank whether payment actually cleared.`,
    'Bill_Create': `New bill from ${entityName} for $${amount?.toFixed(0)}. Verify this matches an expected order. Check COGS budget.`,
    'PurchaseOrder_Create': `New PO to ${entityName} for $${amount?.toFixed(0)}. Confirm this is an authorized purchase.`,
  };
  return actions[`${entityType}_${eventType}`] ||
    `Review the ${eventType.toLowerCase()} ${entityType.toLowerCase()} for ${entityName} in QBO.`;
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

// getQBOToken imported from ./qbo-client.js

async function verifyQBOSignature(body, signature, webhookToken) {
  if (!signature || !webhookToken) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(webhookToken),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return signature === expected;
  } catch {
    return false;
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
