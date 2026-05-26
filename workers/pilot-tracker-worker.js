/**
 * Dangerous Pretzel Co — Twisted Sugar Pilot Tracker
 * Cloudflare Worker
 *
 * Tracks the 5-store Twisted Sugar pilot in real time:
 * 1. Receives order data (Square webhook per store)
 * 2. Calculates sell-through rate, velocity, revenue per store
 * 3. Compares stores against each other
 * 4. Auto-generates a pilot success deck brief when targets are hit
 * 5. Flags anomalies (one store not selling = display issue, bad placement, etc.)
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   DB
 *   KV
 */

import { callAI } from './ai-budget.js';

// Pilot success thresholds (adjust based on deal terms)
const PILOT_TARGETS = {
  min_weekly_units_per_store: 20,      // Minimum units/week to call it a success
  target_weekly_units_per_store: 40,   // Target to pitch chain-wide rollout
  min_stores_hitting_target: 3,        // 3 of 5 stores = expand to full chain
  pilot_duration_weeks: 4,             // Evaluate after 4 weeks
};

const TWISTED_SUGAR_STORES = [
  { id: 'ts_store_1', name: 'Twisted Sugar #1', location: 'SLC', square_location_id: null },
  { id: 'ts_store_2', name: 'Twisted Sugar #2', location: 'SLC', square_location_id: null },
  { id: 'ts_store_3', name: 'Twisted Sugar #3', location: 'SLC', square_location_id: null },
  { id: 'ts_store_4', name: 'Twisted Sugar #4', location: 'SLC', square_location_id: null },
  { id: 'ts_store_5', name: 'Twisted Sugar #5', location: 'SLC', square_location_id: null },
  // Update square_location_ids once stores are onboarded
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Manual order input (for when Square isn't hooked up yet)
    if (path === '/pilot/record-order' && request.method === 'POST') {
      return recordManualOrder(request, env);
    }

    // Live dashboard data
    if (path === '/pilot/dashboard') {
      return getPilotDashboard(env);
    }

    // Generate success deck brief
    if (path === '/pilot/success-brief') {
      return generateSuccessBrief(env);
    }

    // Store-by-store comparison
    if (path === '/pilot/stores') {
      return getStoreComparison(env);
    }

    // Weekly summary for Drew
    if (path === '/pilot/weekly-summary') {
      return getWeeklySummary(env);
    }

    // Pilot alerts from KV (dead stores, anomalies)
    if (path === '/pilot/alerts') {
      const alerts = await env.KV.get('pilot_alerts');
      return new Response(alerts || '[]', {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Twisted Sugar Pilot Tracker', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    // Runs weekly — checks targets and generates brief if ready
    return runWeeklyPilotCheck(env);
  }
};

// ── RECORD ORDER ──────────────────────────────────────────────────────────────
async function recordManualOrder(request, env) {
  const body = await request.json();
  const { store_id, units, sku_breakdown, date, gross_revenue } = body;

  if (!store_id || !units) {
    return new Response(JSON.stringify({ error: 'store_id and units required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const orderId = `ts_${store_id}_${Date.now()}`;

  await env.DB.prepare(`
    INSERT INTO orders (
      id, account_id, venue_id, source, order_date,
      units, sku_breakdown, gross_revenue, created_at
    ) VALUES (?, ?, ?, 'twisted_sugar_pilot', ?, ?, ?, ?, datetime('now'))
  `).bind(
    orderId,
    store_id,
    store_id,
    date || new Date().toISOString(),
    units,
    sku_breakdown ? JSON.stringify(sku_breakdown) : null,
    gross_revenue || units * 4.50  // ~$4.50 wholesale per unit estimate
  ).run();

  // Check if we've hit a milestone
  await checkMilestones(env);

  return new Response(JSON.stringify({ id: orderId, status: 'recorded' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── PILOT DASHBOARD ───────────────────────────────────────────────────────────
async function getPilotDashboard(env) {
  const storeData = await Promise.all(
    TWISTED_SUGAR_STORES.map(async store => {
      const stats = await env.DB.prepare(`
        SELECT
          COUNT(*) as order_count,
          SUM(units) as total_units,
          SUM(gross_revenue) as total_revenue,
          MIN(order_date) as first_order,
          MAX(order_date) as last_order
        FROM orders
        WHERE account_id = ? OR venue_id = ?
      `).bind(store.id, store.id).first();

      // Weekly velocity (last 7 days)
      const weekStats = await env.DB.prepare(`
        SELECT SUM(units) as week_units, SUM(gross_revenue) as week_revenue
        FROM orders
        WHERE (account_id = ? OR venue_id = ?)
          AND order_date >= date('now', '-7 days')
      `).bind(store.id, store.id).first();

      const weekUnits = weekStats?.week_units || 0;
      const status = weekUnits >= PILOT_TARGETS.target_weekly_units_per_store ? 'crushing'
        : weekUnits >= PILOT_TARGETS.min_weekly_units_per_store ? 'on_track'
        : weekUnits > 0 ? 'below_target'
        : 'no_data';

      return {
        ...store,
        total_units: stats?.total_units || 0,
        total_revenue: stats?.total_revenue || 0,
        order_count: stats?.order_count || 0,
        week_units: weekUnits,
        week_revenue: weekStats?.week_revenue || 0,
        status,
      };
    })
  );

  const totalUnits = storeData.reduce((s, d) => s + d.total_units, 0);
  const storesOnTrack = storeData.filter(d => d.status === 'on_track' || d.status === 'crushing').length;
  const pilotSuccess = storesOnTrack >= PILOT_TARGETS.min_stores_hitting_target;

  return new Response(JSON.stringify({
    pilot_week: getPilotWeek(),
    total_units_sold: totalUnits,
    stores_on_track: storesOnTrack,
    pilot_success_threshold: PILOT_TARGETS.min_stores_hitting_target,
    pilot_success: pilotSuccess,
    stores: storeData,
    targets: PILOT_TARGETS,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── SUCCESS BRIEF GENERATOR ───────────────────────────────────────────────────
async function generateSuccessBrief(env) {
  const dashData = await (await getPilotDashboard(env)).json();

  const prompt = `Write a Twisted Sugar pilot success brief for Dangerous Pretzel Co.

Pilot data:
${JSON.stringify(dashData, null, 2)}

About Dangerous Pretzel Co:
- Premium SLC soft pretzel brand, "RUIN DINNER" energy
- Accounts: Delta Center (NBA Jazz), SLC Bees stadium, Powder Mountain ski resort, Alta ski, multiple top SLC breweries
- Free loaner warmer program — zero kitchen, zero training needed
- Monthly revenue per account: $1,000–$10,000+

Write a compelling one-page brief that:
1. Opens with the strongest number (total units sold, revenue generated, or stores exceeding targets)
2. Store-by-store performance breakdown — highlight top performers
3. Consumer response signals (sell-through rate, reorder velocity)
4. Comparison to Dangerous Pretzel's other venue types — Twisted Sugar fits alongside Delta Center
5. Recommendation: expand to full Twisted Sugar chain (50+ Utah locations)
6. Revenue projection for full chain rollout — conservative and optimistic scenarios
7. Proposed next steps and timeline

Tone: confident, data-driven, but still has the brand energy. This goes to Twisted Sugar HQ.

Return JSON: {title, executive_summary, store_performance, recommendation, projections, next_steps}`;

  // DIF-3 (May 13 2026): wired through ai-budget
  const result = await callAI(env, {
    use_case: 'pilot_status_tracking',
    model: 'sonnet',
    caller: 'pilot-tracker-worker.js',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  if (!result.ok) {
    return new Response('Claude API error', { status: 500 });
  }

  const text = result.content || '';

  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    const brief = JSON.parse(clean);
    return new Response(JSON.stringify(brief, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch {
    return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
  }
}

// ── WEEKLY PILOT CHECK ────────────────────────────────────────────────────────
async function runWeeklyPilotCheck(env) {
  const dashData = await (await getPilotDashboard(env)).json();

  // Auto-generate success brief if pilot is succeeding in week 3+
  if (getPilotWeek() >= 3 && dashData.pilot_success) {
    const brief = await (await generateSuccessBrief(env)).json();
    await env.KV.put('twisted_sugar_success_brief', JSON.stringify(brief));
    console.log('[Pilot] Pilot success brief auto-generated and saved to KV');
  }

  // Flag stores with zero orders in last 7 days
  const deadStores = dashData.stores.filter(s => s.week_units === 0 && getPilotWeek() > 1);
  if (deadStores.length > 0) {
    console.log(`[Pilot] ⚠ Stores with no orders this week: ${deadStores.map(s => s.name).join(', ')}`);
    // Store in KV for Drew's digest
    await env.KV.put('pilot_alerts', JSON.stringify({
      dead_stores: deadStores,
      week: getPilotWeek(),
      timestamp: new Date().toISOString(),
    }));
  }
}

// ── STORE COMPARISON ──────────────────────────────────────────────────────────
async function getStoreComparison(env) {
  const dashboard = await (await getPilotDashboard(env)).json();
  const sorted = [...dashboard.stores].sort((a, b) => b.week_units - a.week_units);

  return new Response(JSON.stringify({
    ranking: sorted.map((s, i) => ({
      rank: i + 1,
      name: s.name,
      week_units: s.week_units,
      total_units: s.total_units,
      status: s.status,
      vs_target: `${Math.round((s.week_units / PILOT_TARGETS.target_weekly_units_per_store) * 100)}%`,
    })),
    pilot_week: dashboard.pilot_week,
    success_projection: dashboard.pilot_success ? 'EXPAND NOW' : `Need ${PILOT_TARGETS.min_stores_hitting_target - dashboard.stores_on_track} more stores on target`,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function getWeeklySummary(env) {
  const dashboard = await (await getPilotDashboard(env)).json();

  return new Response(JSON.stringify({
    week: dashboard.pilot_week,
    headline: getHeadline(dashboard),
    total_units: dashboard.total_units_sold,
    stores_on_track: `${dashboard.stores_on_track}/${TWISTED_SUGAR_STORES.length}`,
    recommendation: dashboard.pilot_success
      ? 'Begin expansion conversation with Twisted Sugar HQ'
      : `${PILOT_TARGETS.min_stores_hitting_target - dashboard.stores_on_track} more stores needed before expansion pitch`,
    stores: dashboard.stores.map(s => ({
      name: s.name,
      units_this_week: s.week_units,
      status: s.status,
    })),
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function checkMilestones(env) {
  const dashboard = await (await getPilotDashboard(env)).json();
  const milestones = [];

  if (dashboard.total_units_sold === 100) milestones.push('100 units sold in pilot!');
  if (dashboard.total_units_sold === 500) milestones.push('500 units sold — pilot crushing it');
  if (dashboard.pilot_success) milestones.push('Pilot success threshold hit — ready to expand');

  if (milestones.length > 0) {
    await env.KV.put('pilot_milestones', JSON.stringify({ milestones, timestamp: new Date().toISOString() }));
  }
}

function getPilotWeek() {
  // Calculate based on pilot start date stored in KV
  // For now, return a placeholder — Claude Code can wire in the actual start date
  const PILOT_START = new Date('2025-04-01'); // Update when pilot starts
  const now = new Date();
  return Math.max(1, Math.ceil((now - PILOT_START) / (7 * 24 * 60 * 60 * 1000)));
}

function getHeadline(dashboard) {
  if (dashboard.pilot_success) return `🚀 PILOT SUCCESS — ${dashboard.stores_on_track}/5 stores hitting target`;
  if (dashboard.stores_on_track >= 2) return `💪 Strong start — ${dashboard.stores_on_track}/5 stores on track`;
  if (dashboard.total_units_sold > 0) return `📊 Week ${dashboard.pilot_week} underway — ${dashboard.total_units_sold} total units sold`;
  return '📦 Pilot launched — collecting first week data';
}
