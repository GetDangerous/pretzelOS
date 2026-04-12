/**
 * Dangerous Pretzel Co — CFO Pulse
 * Cloudflare Worker (cron: every hour)
 *
 * Lightweight D1-only analysis. No QBO API calls.
 * Reads what webhooks have written, checks thresholds,
 * updates the dashboard in real time.
 *
 * The full CFO analysis (with QBO API calls) runs daily at 6am MT.
 * The pulse fills the gaps between full runs.
 *
 * What it checks:
 * - New QBO events since last pulse (high-sig ones)
 * - Cash estimate (last known + today's payments - today's bills)
 * - Any account health changes
 * - Threshold breaches (cash below X, overdue above Y)
 * - Updates KV for dashboard real-time display
 *
 * Cron: "0 * * * *"  (every hour, all hours)
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY (only if generating pulse summary)
 *   DB, KV
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPulse(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/cfo/pulse') {
      const result = await runPulse(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.pathname === '/cfo/pulse/history') {
      return getPulseHistory(env);
    }
    if (url.pathname === '/cfo/live') {
      return getLiveDashboard(env);
    }
    return new Response('CFO Pulse', { status: 200 });
  }
};

async function runPulse(env) {
  const pulseStart = new Date().toISOString();
  console.log('[Pulse] Starting hourly pulse...');

  // ── 1. New events since last pulse ─────────────────────────────────────────
  const lastPulse = await env.DB.prepare(
    "SELECT pulse_at FROM cfo_pulse ORDER BY created_at DESC LIMIT 1"
  ).first();
  const sinceTime = lastPulse?.pulse_at || new Date(Date.now() - 3600000).toISOString();

  const newEvents = await env.DB.prepare(`
    SELECT entity_type, event_type, entity_name, amount, significance,
           interpretation, action_required, received_at
    FROM qbo_events
    WHERE received_at > ?
    ORDER BY significance DESC, received_at DESC
  `).bind(sinceTime).all();

  const events = newEvents.results || [];
  const highSigEvents = events.filter(e => e.significance === 'high' || e.significance === 'critical');

  // ── 2. Cash estimate from today's events ───────────────────────────────────
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEvents = await env.DB.prepare(`
    SELECT entity_type, event_type, amount
    FROM qbo_events
    WHERE received_at >= ?
  `).bind(todayStart.toISOString()).all();

  let cashDeltaToday = 0;
  let newInvoicesToday = 0;
  let paymentsToday = 0;
  let newBillsToday = 0;

  for (const event of (todayEvents.results || [])) {
    if (event.entity_type === 'Payment' && event.event_type === 'Create') {
      cashDeltaToday += (event.amount || 0);
      paymentsToday += (event.amount || 0);
    }
    if (event.entity_type === 'Bill' && event.event_type === 'Create') {
      cashDeltaToday -= (event.amount || 0);
      newBillsToday += (event.amount || 0);
    }
    if (event.entity_type === 'Invoice' && event.event_type === 'Create') {
      newInvoicesToday++;
    }
  }

  // Get last known cash from directive
  const lastDirective = await env.DB.prepare(
    "SELECT estimated_weekly_revenue, estimated_weekly_burn, cash_runway_weeks, cash_on_hand FROM financial_directives WHERE active = 1 LIMIT 1"
  ).first();

  // Use stored cash_on_hand if available, otherwise estimate from runway × burn
  const estimatedCash = lastDirective?.cash_on_hand
    ? lastDirective.cash_on_hand + cashDeltaToday
    : (lastDirective
      ? ((lastDirective.cash_runway_weeks || 0) * (lastDirective.estimated_weekly_burn || 0)) + cashDeltaToday
      : null);

  // ── 3. Account health snapshot ─────────────────────────────────────────────
  const accountHealth = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN health_status = 'green' THEN 1 ELSE 0 END) as green,
      SUM(CASE WHEN health_status = 'yellow' THEN 1 ELSE 0 END) as yellow,
      SUM(CASE WHEN health_status = 'red' THEN 1 ELSE 0 END) as red,
      COUNT(*) as total
    FROM active_accounts WHERE warmer_removed_at IS NULL
  `).first();

  // ── 4. New AR overdue from today's events ─────────────────────────────────
  const newOverdue = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM qbo_events
    WHERE received_at >= ?
      AND flag_id IS NOT NULL
      AND entity_type = 'Invoice'
  `).bind(todayStart.toISOString()).first();

  // ── 5. Determine pulse status ─────────────────────────────────────────────
  let status = 'normal';
  let statusReason = null;

  if (highSigEvents.length >= 3) {
    status = 'alert';
    statusReason = `${highSigEvents.length} high-significance events in last hour`;
  } else if (highSigEvents.length >= 1) {
    status = 'watch';
    statusReason = highSigEvents[0].interpretation || `${highSigEvents[0].event_type} ${highSigEvents[0].entity_type}`;
  }
  if (accountHealth?.red > 0) {
    status = status === 'normal' ? 'watch' : status;
    statusReason = statusReason || `${accountHealth.red} accounts in red health`;
  }

  // ── 6. Write pulse to D1 ──────────────────────────────────────────────────
  const pulseId = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO cfo_pulse (
      id, pulse_at,
      new_events_since_last, high_sig_events,
      new_invoices_today, payments_today, new_bills_today,
      estimated_cash, cash_delta_today,
      new_overdue_count,
      status, status_reason, flags_created,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
  `).bind(
    pulseId, pulseStart,
    events.length, highSigEvents.length,
    newInvoicesToday, paymentsToday, newBillsToday,
    estimatedCash, cashDeltaToday,
    newOverdue?.count || 0,
    status, statusReason
  ).run();

  // ── 7. Update KV for real-time dashboard ──────────────────────────────────
  const liveData = {
    pulse_at: pulseStart,
    status,
    status_reason: statusReason,
    events_this_hour: events.length,
    high_sig_this_hour: highSigEvents.length,
    cash_on_hand: estimatedCash,
    cash_delta_today: cashDeltaToday,
    payments_today: paymentsToday,
    new_bills_today: newBillsToday,
    new_invoices_today: newInvoicesToday,
    account_health: accountHealth,
    recent_events: highSigEvents.slice(0, 5).map(e => ({
      type: `${e.event_type} ${e.entity_type}`,
      entity: e.entity_name,
      amount: e.amount,
      interpretation: e.interpretation,
      at: e.received_at,
    })),
  };
  await env.KV.put('cfo_live', JSON.stringify(liveData), { expirationTtl: 3700 });

  // Update config
  await env.DB.prepare(
    "INSERT OR REPLACE INTO cfo_config (key, value, updated_at) VALUES ('last_pulse', ?, datetime('now'))"
  ).bind(pulseStart).run();

  console.log(`[Pulse] Done. Status: ${status}. Events: ${events.length}. High-sig: ${highSigEvents.length}.`);
  return { pulse_id: pulseId, status, events_count: events.length, high_sig: highSigEvents.length };
}

async function getPulseHistory(env) {
  const history = await env.DB.prepare(`
    SELECT * FROM cfo_pulse
    ORDER BY created_at DESC LIMIT 48
  `).all();
  return new Response(JSON.stringify(history.results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getLiveDashboard(env) {
  const [live, recentEvents, openFlags] = await Promise.all([
    env.KV.get('cfo_live').then(v => v ? JSON.parse(v) : null),
    env.DB.prepare(`
      SELECT entity_type, event_type, entity_name, amount,
             significance, interpretation, received_at
      FROM qbo_events
      ORDER BY received_at DESC LIMIT 20
    `).all(),
    env.DB.prepare(`
      SELECT flag_type, severity, title, suggested_action, created_at
      FROM financial_flags WHERE status = 'open'
      ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END
      LIMIT 10
    `).all(),
  ]);

  return new Response(JSON.stringify({
    live,
    recent_events: recentEvents.results,
    open_flags: openFlags.results,
    generated_at: new Date().toISOString(),
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
