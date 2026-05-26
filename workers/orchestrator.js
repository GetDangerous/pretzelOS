/**
 * Dangerous Pretzel Co — Orchestrator
 * Cloudflare Worker (HTTP endpoint — no cron of its own)
 *
 * Coordinates the multi-agent pipeline: Scout → Qualifier → Outreach,
 * Catering, CFO → Optimizer. Replaces the "hope the crons chain correctly"
 * approach with an on-demand, traceable, logged run.
 *
 * Every step is logged to agent_messages in D1 — trace_id = run_id.
 * Dashboard can show real-time (on reload) run status + step detail.
 *
 * Endpoints:
 *   POST /orchestrator/run      → { type } → { run_id, started }
 *   GET  /orchestrator/runs     → last 20 runs
 *   GET  /orchestrator/runs/:id → run detail + all steps
 *   GET  /orchestrator/active   → currently running run (if any)
 *
 * Pipeline types:
 *   outreach_pipeline — scout → qualifier → outreach (wholesale)
 *   catering          — catering agent
 *   cfo_cycle         — cfo → optimizer
 *   full              — all three, in parallel where safe
 *
 * Env vars required: (inherited) DB, KV, ANTHROPIC_API_KEY, all agent secrets
 */

import { default as scout }     from './scout-worker.js';
import { default as qualifier } from './qualifier-worker.js';
import { default as outreach }  from './outreach-agent.js';
import { default as catering }  from './catering-agent.js';
import { default as cfo }       from './cfo-agent.js';
import { default as optimizer } from './optimizer-worker.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fake scheduled event — workers only check env/ctx in scheduled(), not event.cron
const fakeScheduled = () => ({ cron: 'orchestrated', scheduledTime: Date.now() });

// Fake ctx — captures waitUntil promises so runStep can await them
const fakeCtx = () => {
  const promises = [];
  return {
    waitUntil: (p) => { promises.push(p); },
    getPromises: () => promises,
  };
};

// Log a step start and return its id
async function stepStart(env, runId, fromAgent, toAgent, task) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO agent_messages (id, run_id, from_agent, to_agent, task, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))
  `).bind(id, runId, fromAgent, toAgent, task).run()
    .catch(e => console.error('[orchestrator] stepStart INSERT failed:', id, fromAgent, '->', toAgent, e.message));
  return id;
}

// Mark a step completed or failed
async function stepEnd(env, stepId, runId, success, durationMs, error) {
  await env.DB.prepare(`
    UPDATE agent_messages
    SET status = ?, duration_ms = ?, error = ?, completed_at = datetime('now')
    WHERE id = ?
  `).bind(success ? 'completed' : 'failed', durationMs, error || null, stepId).run()
    .catch(e => console.error('[orchestrator] stepEnd UPDATE failed:', stepId, e.message));

  if (success) {
    await env.DB.prepare(
      `UPDATE orchestrator_runs SET steps_completed = steps_completed + 1 WHERE id = ?`
    ).bind(runId).run().catch(e => console.error('[orchestrator] steps_completed++ failed:', runId, e.message));
  } else {
    await env.DB.prepare(
      `UPDATE orchestrator_runs SET steps_failed = steps_failed + 1 WHERE id = ?`
    ).bind(runId).run().catch(e => console.error('[orchestrator] steps_failed++ failed:', runId, e.message));
  }
}

const STEP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per step max

// Run one agent step with full logging + timeout
async function runStep(env, runId, { fromAgent, toAgent, task, fn }) {
  const stepId = await stepStart(env, runId, fromAgent, toAgent, task);
  const t0 = Date.now();
  try {
    const ctx = fakeCtx();
    const execution = (async () => {
      await fn(fakeScheduled(), env, ctx);
      const pending = ctx.getPromises();
      if (pending.length) await Promise.all(pending);
    })();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Step timed out after ${STEP_TIMEOUT_MS / 1000}s`)), STEP_TIMEOUT_MS)
    );
    await Promise.race([execution, timeout]);
    await stepEnd(env, stepId, runId, true, Date.now() - t0, null);
    return true;
  } catch (err) {
    console.error(`[Orchestrator] ${toAgent}/${task} failed:`, err.message);
    await stepEnd(env, stepId, runId, false, Date.now() - t0, err.message);
    return false;
  }
}

// ── Pipeline definitions ─────────────────────────────────────────────────────

const PIPELINES = {
  outreach_pipeline: [
    { fromAgent: 'orchestrator', toAgent: 'scout',     task: 'discover_venues', fn: scout.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'qualifier', task: 'score_venues',    fn: qualifier.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'outreach',  task: 'draft_and_park',  fn: outreach.scheduled },
  ],
  catering: [
    { fromAgent: 'orchestrator', toAgent: 'catering',  task: 'catering_outreach', fn: catering.scheduled },
  ],
  cfo_cycle: [
    { fromAgent: 'orchestrator', toAgent: 'cfo',       task: 'financial_analysis',  fn: cfo.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'optimizer', task: 'prompt_optimization', fn: optimizer.scheduled },
  ],
  full: [
    { fromAgent: 'orchestrator', toAgent: 'scout',     task: 'discover_venues',     fn: scout.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'qualifier', task: 'score_venues',         fn: qualifier.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'outreach',  task: 'draft_and_park',       fn: outreach.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'catering',  task: 'catering_outreach',    fn: catering.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'cfo',       task: 'financial_analysis',   fn: cfo.scheduled },
    { fromAgent: 'orchestrator', toAgent: 'optimizer', task: 'prompt_optimization',  fn: optimizer.scheduled },
  ],
};

// ── Main pipeline runner ─────────────────────────────────────────────────────

async function runPipeline(runId, type, env) {
  // Auto-cleanup: mark any runs stuck in "running" for 30+ min as timed_out
  await env.DB.prepare(
    `UPDATE orchestrator_runs SET status = 'timed_out', completed_at = datetime('now') WHERE status = 'running' AND created_at < datetime('now', '-30 minutes') AND id != ?`
  ).bind(runId).run().catch(e => console.error('[orchestrator] timed_out cleanup failed:', e.message));

  const steps = PIPELINES[type] || PIPELINES.outreach_pipeline;

  await env.DB.prepare(
    `UPDATE orchestrator_runs SET steps_total = ? WHERE id = ?`
  ).bind(steps.length, runId).run().catch(e => console.error('[orchestrator] steps_total UPDATE failed:', runId, e.message));

  let failures = 0;
  for (const step of steps) {
    const ok = await runStep(env, runId, step);
    if (!ok) failures++;
    // Continue on failure — partial completion beats full abort
  }

  const finalStatus = failures === 0 ? 'completed' : failures === steps.length ? 'failed' : 'partial';
  await env.DB.prepare(`
    UPDATE orchestrator_runs
    SET status = ?, completed_at = datetime('now')
    WHERE id = ?
  `).bind(finalStatus, runId).run().catch(e => console.error(`[Orchestrator] Failed to update run status: ${e.message}`));

  console.log(`[Orchestrator] Run ${runId} (${type}) finished: ${finalStatus} — ${steps.length - failures}/${steps.length} steps ok`);
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // POST /orchestrator/run — kick off a pipeline
    if (path === '/orchestrator/run' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const type        = PIPELINES[body.type] ? body.type : 'outreach_pipeline';
      const triggeredBy = body.triggered_by || 'manual';
      const runId       = crypto.randomUUID();

      await env.DB.prepare(`
        INSERT INTO orchestrator_runs (id, type, triggered_by, steps_total, steps_completed, steps_failed, created_at)
        VALUES (?, ?, ?, 0, 0, 0, datetime('now'))
      `).bind(runId, type, triggeredBy).run();

      ctx.waitUntil(runPipeline(runId, type, env));

      return new Response(JSON.stringify({ run_id: runId, type, started: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /orchestrator/runs — last 20 runs
    if (path === '/orchestrator/runs' && request.method === 'GET') {
      const { results } = await env.DB.prepare(`
        SELECT * FROM orchestrator_runs ORDER BY created_at DESC LIMIT 20
      `).all();
      return new Response(JSON.stringify({ runs: results || [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /orchestrator/runs/:id — run detail + steps
    const runMatch = path.match(/^\/orchestrator\/runs\/([^/]+)$/);
    if (runMatch && request.method === 'GET') {
      const runId = runMatch[1];
      const [run, { results: steps }] = await Promise.all([
        env.DB.prepare('SELECT * FROM orchestrator_runs WHERE id = ?').bind(runId).first(),
        env.DB.prepare('SELECT * FROM agent_messages WHERE run_id = ? ORDER BY created_at ASC').bind(runId).all(),
      ]);
      return new Response(JSON.stringify({ run, steps: steps || [] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /orchestrator/cleanup — force-clean stuck runs + stuck steps
    if (path === '/orchestrator/cleanup' && request.method === 'POST') {
      // Mark any run stuck "running" for 10+ min as failed
      const runsRes = await env.DB.prepare(
        `UPDATE orchestrator_runs SET status = 'failed', completed_at = datetime('now') WHERE status = 'running' AND created_at < datetime('now', '-10 minutes')`
      ).run();
      // Mark any step still "running" as failed (no completed_at yet)
      const stepsRes = await env.DB.prepare(
        `UPDATE agent_messages SET status = 'failed', completed_at = datetime('now'), error = COALESCE(error, 'Force-cleaned: run was stuck') WHERE status = 'running' AND created_at < datetime('now', '-10 minutes')`
      ).run();
      return new Response(JSON.stringify({
        runs_cleaned: runsRes.meta?.changes || 0,
        steps_cleaned: stepsRes.meta?.changes || 0,
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // GET /orchestrator/active — currently running run (if any)
    if (path === '/orchestrator/active' && request.method === 'GET') {
      const run = await env.DB.prepare(
        `SELECT * FROM orchestrator_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1`
      ).first();
      return new Response(JSON.stringify({ run: run || null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /agent/activity — combined activity feed for Today page dashboard
    if (path === '/agent/activity' && request.method === 'GET') {
      const [{ results: runs }, { results: steps }, { results: recentSends }] = await Promise.all([
        env.DB.prepare(`
          SELECT id, type, status, triggered_by, steps_completed, steps_total, created_at, completed_at
          FROM orchestrator_runs ORDER BY created_at DESC LIMIT 15
        `).all(),
        env.DB.prepare(`
          SELECT from_agent, to_agent, task, status, duration_ms, error, created_at
          FROM agent_messages ORDER BY created_at DESC LIMIT 20
        `).all(),
        env.DB.prepare(`
          SELECT venue_name, subject, category, campaign, sent_at, direction
          FROM outreach_logs
          WHERE direction = 'out' AND sent_at IS NOT NULL
          AND sent_at > datetime('now', '-48 hours')
          ORDER BY sent_at DESC LIMIT 10
        `).all().catch(() => ({ results: [] })),
      ]);

      // Merge into unified activity items sorted by time
      const items = [];

      for (const run of (runs || [])) {
        const agentMap = { outreach_pipeline: 'outreach', catering: 'catering', cfo_cycle: 'cfo', full: 'all agents' };
        const agent = agentMap[run.type] || run.type;
        items.push({
          agent,
          action: run.status === 'running' ? `${run.type.replace(/_/g,' ')} running…` :
                  `${run.type.replace(/_/g,' ')} ${run.status} (${run.steps_completed}/${run.steps_total} steps)`,
          detail: run.triggered_by === 'dashboard' ? 'Triggered manually' : 'Cron scheduled',
          ts: run.completed_at || run.created_at,
          link_page: agent === 'cfo' ? 'money' : 'outreach',
          status: run.status,
        });
      }

      for (const send of (recentSends || [])) {
        items.push({
          agent: 'outreach',
          action: `Email sent to ${send.venue_name || 'venue'}`,
          detail: send.subject || '',
          ts: send.sent_at,
          link_page: 'outreach',
          status: 'sent',
        });
      }

      items.sort((a, b) => new Date(b.ts) - new Date(a.ts));

      return new Response(JSON.stringify({ items: items.slice(0, 30) }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Orchestrator', { status: 200 });
  },
};
