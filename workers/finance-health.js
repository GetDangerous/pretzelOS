// workers/finance-health.js
// Heartbeats + trust score for the entire CFO stack.
//
// Every cron/sync that completes successfully MUST call heartbeat(env, component).
// Trust score (0-100) is computed from 6 components, weighted, and rendered
// on the /cfo dashboard + daily morning email.
//
// Trust score components:
//   1. data_freshness    — are syncs current?
//   2. ledger_integrity  — Tier 1 invariants
//   3. categorization    — agent override rate
//   4. sync_health       — consecutive_failures per component
//   5. cost_budget       — AI spend vs target
//   6. decision_quality  — recent autonomous decision Drew didn't revert
//
// If overall < 80, daily email leads with "what's not trustworthy today."

import { getBudgetStatus } from './ai-budget.js';

function r2(n) { return Math.round((n || 0) * 100) / 100; }

// ── Write a heartbeat ─────────────────────────────────────────────────────
// Call this at the END of every successful cron / sync.
//
// Session 15b (May 14 2026): cadence_min now comes from workers/heartbeat-keys.js
// HEARTBEATS registry. Falls back to opts.cadence_min, then 60. ON CONFLICT
// updates expected_max_lag_minutes too — so once a cron is registered, its row
// gets the correct cadence on next write.
export async function heartbeat(env, component, opts = {}) {
  const { duration_ms = null, status = 'green', error = null } = opts;
  const { cadenceForAgent } = await import('./heartbeat-keys.js');
  const cadence = opts.cadence_min || cadenceForAgent(component);
  try {
    await env.DB.prepare(`
      INSERT INTO system_heartbeats (component, last_success_at, last_attempt_at,
        last_duration_ms, status, consecutive_failures, last_error, updated_at,
        expected_max_lag_minutes, notes)
      VALUES (?, datetime('now'), datetime('now'), ?, ?, 0, NULL, datetime('now'), ?, '')
      ON CONFLICT(component) DO UPDATE SET
        last_success_at = datetime('now'),
        last_attempt_at = datetime('now'),
        last_duration_ms = excluded.last_duration_ms,
        status = ?,
        consecutive_failures = 0,
        last_error = NULL,
        expected_max_lag_minutes = excluded.expected_max_lag_minutes,
        updated_at = datetime('now')
    `).bind(component, duration_ms, status, cadence, status).run();
  } catch (e) {
    // Phase 21V-audit-5 F7: surface heartbeat errors instead of swallowing them.
    // Silent .catch() let monthly_close + weekly_directive heartbeats fail silently
    // for weeks. Now: log to console (visible in `wrangler tail`) so future failures
    // are observable. The error doesn't propagate (cron should still complete).
    console.error(`[heartbeat] write failed for ${component}: ${e.message}`);
  }
}

// ── Record an attempt that failed ────────────────────────────────────────
export async function heartbeatFailed(env, component, errorMessage) {
  await env.DB.prepare(`
    UPDATE system_heartbeats
    SET last_attempt_at = datetime('now'),
        consecutive_failures = consecutive_failures + 1,
        last_error = ?,
        status = CASE
          WHEN consecutive_failures + 1 >= 3 THEN 'red'
          WHEN consecutive_failures + 1 >= 1 THEN 'yellow'
          ELSE status
        END,
        updated_at = datetime('now')
    WHERE component = ?
  `).bind((errorMessage || '').slice(0, 500), component).run().catch(() => {});
}

// ── Compute current status by checking lag vs expected_max_lag_minutes ────
async function computeHeartbeatStatus(env) {
  const { results } = await env.DB.prepare(`
    SELECT component,
           last_success_at, last_attempt_at, expected_max_lag_minutes,
           consecutive_failures, last_error, notes,
           (julianday('now') - julianday(last_success_at)) * 24 * 60 as lag_minutes
    FROM system_heartbeats
    ORDER BY component
  `).all();

  return (results || []).map(r => {
    let status;
    const lag = r.lag_minutes;
    const maxLag = r.expected_max_lag_minutes || 60;
    if (lag == null) status = 'unknown';
    else if (lag <= maxLag) status = 'green';
    else if (lag <= maxLag * 2) status = 'yellow';
    else status = 'red';
    if (r.consecutive_failures >= 3) status = 'red';
    return {
      component: r.component,
      status,
      lag_minutes: lag != null ? Math.round(lag) : null,
      max_lag_minutes: maxLag,
      last_success_at: r.last_success_at,
      consecutive_failures: r.consecutive_failures,
      last_error: r.last_error,
      notes: r.notes,
    };
  });
}

// ── Trust score components ───────────────────────────────────────────────

// CRITICAL_HEARTBEATS — single source of truth for which crons MUST be fresh
// for the books to be trustworthy. Drew approved this exact list May 14 2026.
//   cfo_daily_close — books current (Mercury sync embedded in this)
//   cfo_audit_tier1 — ledger integrity checked hourly
//   chase_sync_plaid — Drew's primary spend account (Chase business CC) flowing
// All other heartbeats are "secondary" and feed sync_health, not data_freshness.
const CRITICAL_HEARTBEATS = ['cfo_daily_close', 'cfo_audit_tier1', 'chase_sync_plaid'];

async function scoreDataFreshness(env, heartbeats) {
  const criticalRows = heartbeats.filter(h => CRITICAL_HEARTBEATS.includes(h.component));
  if (criticalRows.length === 0) return { score: 50, detail: 'No critical heartbeats found' };
  const greens = criticalRows.filter(h => h.status === 'green').length;
  const score = Math.round((greens / criticalRows.length) * 100);
  return {
    score,
    detail: criticalRows.map(r => `${r.component}: ${r.status} (${r.lag_minutes}m ago)`).join(' · '),
  };
}

async function scoreLedgerIntegrity(env) {
  // Read latest Tier 1 audit run
  const row = await env.DB.prepare(`
    SELECT passed, failed, warnings FROM finance_audit_runs
    WHERE tier = 1 ORDER BY ran_at DESC LIMIT 1
  `).first();
  if (!row) return { score: 50, detail: 'No Tier 1 run found' };
  const total = (row.passed || 0) + (row.failed || 0) + (row.warnings || 0);
  if (total === 0) return { score: 50, detail: 'No checks recorded' };
  const score = Math.round(((row.passed || 0) / total) * 100);
  return {
    score,
    detail: `${row.passed} pass · ${row.failed} fail · ${row.warnings} warn (Tier 1)`,
  };
}

async function scoreCategorization(env) {
  // Lower override rate = higher score. Over last 30d.
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN drew_action IN ('overridden','reverted') THEN 1 ELSE 0 END) as overrides
    FROM agent_decisions
    WHERE decision_at >= datetime('now', '-30 days')
      AND decision_type = 'categorize'
  `).first().catch(() => null);

  if (!row || row.total === 0) {
    return { score: 90, detail: 'No autonomous categorizations yet (agent_decisions empty)' };
  }
  const overrideRate = (row.overrides || 0) / row.total;
  const score = Math.max(50, Math.round((1 - overrideRate) * 100));
  return {
    score,
    detail: `${row.total} decisions · ${row.overrides} overridden (${Math.round(overrideRate * 100)}%)`,
  };
}

async function scoreSyncHealth(env, heartbeats) {
  // Penalty for each red component, smaller penalty for yellow
  let score = 100;
  const reds = heartbeats.filter(h => h.status === 'red').map(h => h.component);
  const yellows = heartbeats.filter(h => h.status === 'yellow').map(h => h.component);
  score -= reds.length * 15;
  score -= yellows.length * 5;
  score = Math.max(0, score);
  return {
    score,
    detail: reds.length || yellows.length
      ? `${reds.length} red: ${reds.join(', ')} · ${yellows.length} yellow: ${yellows.join(', ')}`
      : 'All components green',
  };
}

async function scoreCostBudget(env) {
  const status = await getBudgetStatus(env).catch(() => null);
  if (!status) return { score: 100, detail: 'No budget data yet' };
  const monthPct = status.month.cost_usd / status.month.soft_cap;
  let score;
  if (monthPct < 0.5) score = 100;
  else if (monthPct < 0.8) score = 90;
  else if (monthPct < 1.0) score = 75;
  else if (monthPct < 1.2) score = 50;
  else score = 20;
  return {
    score,
    detail: `today $${status.today.cost_usd} / $${status.today.soft_cap} · month $${status.month.cost_usd} / $${status.month.soft_cap}`,
  };
}

async function scoreDecisionQuality(env) {
  // Of recent autonomous decisions, how many did Drew NOT revert?
  // Higher = better.
  const row = await env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN drew_action = 'reverted' THEN 1 ELSE 0 END) as reverted
    FROM agent_decisions
    WHERE decision_at >= datetime('now', '-7 days')
  `).first().catch(() => null);

  if (!row || row.total === 0) {
    return { score: 90, detail: 'No recent autonomous decisions to evaluate' };
  }
  const revertRate = (row.reverted || 0) / row.total;
  const score = Math.max(50, Math.round((1 - revertRate * 2) * 100));  // double-weight reverts
  return {
    score,
    detail: `${row.total} decisions in 7d · ${row.reverted} reverted (${Math.round(revertRate * 100)}%)`,
  };
}

// ── Main: compute trust score ─────────────────────────────────────────────
export async function getTrustScore(env) {
  const heartbeats = await computeHeartbeatStatus(env);

  const [dataFreshness, ledgerIntegrity, categorization, syncHealth, costBudget, decisionQuality] = await Promise.all([
    scoreDataFreshness(env, heartbeats),
    scoreLedgerIntegrity(env),
    scoreCategorization(env),
    scoreSyncHealth(env, heartbeats),
    scoreCostBudget(env),
    scoreDecisionQuality(env),
  ]);

  // Weighted average
  const weights = {
    data_freshness: 0.20,
    ledger_integrity: 0.25,
    categorization: 0.15,
    sync_health: 0.15,
    cost_budget: 0.10,
    decision_quality: 0.15,
  };
  const overall = Math.round(
    dataFreshness.score * weights.data_freshness +
    ledgerIntegrity.score * weights.ledger_integrity +
    categorization.score * weights.categorization +
    syncHealth.score * weights.sync_health +
    costBudget.score * weights.cost_budget +
    decisionQuality.score * weights.decision_quality
  );

  // Session 15d: critical/secondary trust panel framing.
  // Replaces "7 of 20 components green" (misleading — counts orphan rows) with
  // "X of N critical · Y of M secondary" — honest about what matters.
  const criticalRows = heartbeats.filter(h => CRITICAL_HEARTBEATS.includes(h.component));
  const secondaryRows = heartbeats.filter(h => !CRITICAL_HEARTBEATS.includes(h.component));
  const greenCount = arr => arr.filter(h => h.status === 'green').length;
  const tier_summary = {
    critical_green: greenCount(criticalRows),
    critical_total: criticalRows.length,
    secondary_green: greenCount(secondaryRows),
    secondary_total: secondaryRows.length,
    critical_components: CRITICAL_HEARTBEATS,
  };

  return {
    overall,
    label: overall >= 90 ? 'excellent' : overall >= 80 ? 'good' : overall >= 70 ? 'fair' : overall >= 60 ? 'concerning' : 'critical',
    components: {
      data_freshness: dataFreshness,
      ledger_integrity: ledgerIntegrity,
      categorization,
      sync_health: syncHealth,
      cost_budget: costBudget,
      decision_quality: decisionQuality,
    },
    tier_summary,
    heartbeats,
    computed_at: new Date().toISOString(),
  };
}

// ── Snapshot for trending ────────────────────────────────────────────────
export async function snapshotTrustScore(env) {
  const t = await getTrustScore(env);
  await env.DB.prepare(`
    INSERT INTO trust_score_snapshots (id, overall_score, data_freshness_score,
      ledger_integrity_score, categorization_score, sync_health_score,
      cost_budget_score, decision_quality_score, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    t.overall,
    t.components.data_freshness.score,
    t.components.ledger_integrity.score,
    t.components.categorization.score,
    t.components.sync_health.score,
    t.components.cost_budget.score,
    t.components.decision_quality.score,
    JSON.stringify(t.components),
  ).run().catch(() => {});
  return t;
}

export async function getTrustHistory(env, days = 30) {
  const { results } = await env.DB.prepare(`
    SELECT snapshot_at, overall_score, data_freshness_score, ledger_integrity_score,
           categorization_score, sync_health_score, cost_budget_score, decision_quality_score
    FROM trust_score_snapshots
    WHERE snapshot_at >= datetime('now', '-' || ? || ' days')
    ORDER BY snapshot_at
  `).bind(days).all();
  return { days, snapshots: results || [] };
}
