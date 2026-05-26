// workers/square-labor-sync.js
// Pull Square Labor (shifts + team members) for labor cost forecasting.
//
// Endpoints:
//   POST /finance/square-labor/sync — pull last 30d completed + next 30d scheduled
//   GET  /finance/square-labor/forecast?days=30 — projected payroll over horizon
//   GET  /finance/square-labor/productivity?days=30 — revenue per labor hour

import { heartbeat, heartbeatFailed } from './finance-health.js';

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';
const PAGE_SIZE = 200;

function r2(n) { return Math.round((n || 0) * 100) / 100; }

async function squareRequest(env, path, body, method = 'POST') {
  if (!env.SQUARE_ACCESS_TOKEN) throw new Error('SQUARE_ACCESS_TOKEN not set');
  const url = `${SQUARE_API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-09-19',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok) {
    const errMsg = `Square ${path} ${resp.status}: ${(json.errors?.[0]?.detail || text).slice(0, 300)}`;
    throw new Error(errMsg);
  }
  return json;
}

// ── Sync team members ─────────────────────────────────────────────────────
async function syncTeamMembers(env) {
  const result = await squareRequest(env, '/team-members/search', {
    query: { filter: { status: 'ACTIVE' } },
    limit: PAGE_SIZE,
  });
  const members = result.team_members || [];
  let upserted = 0;
  for (const m of members) {
    await env.DB.prepare(`
      INSERT INTO square_team_members (id, square_member_id, name, email, status, is_owner, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(square_member_id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        status = excluded.status,
        is_owner = excluded.is_owner,
        last_synced_at = datetime('now')
    `).bind(
      crypto.randomUUID(),
      m.id || null,
      `${m.given_name || ''} ${m.family_name || ''}`.trim() || '(unnamed)',
      m.email_address || null,
      m.status || null,
      m.is_owner ? 1 : 0,
    ).run();
    upserted += 1;
  }
  return { upserted, total: members.length };
}

// ── Sync wages (team-member-wages endpoint) ──────────────────────────────
async function syncWages(env) {
  let cursor = null;
  let count = 0;
  do {
    const result = await squareRequest(env, '/labor/team-member-wages/search', {
      limit: PAGE_SIZE,
      cursor,
    }).catch(() => ({ team_member_wages: [], cursor: null }));
    cursor = result.cursor || null;
    for (const w of (result.team_member_wages || [])) {
      const hourlyAmount = w.hourly_rate?.amount;
      if (!hourlyAmount || !w.team_member_id) continue;
      const wageDollars = hourlyAmount / 100;
      await env.DB.prepare(`
        UPDATE square_team_members SET hourly_wage = ? WHERE square_member_id = ?
      `).bind(wageDollars, w.team_member_id).run();
      count += 1;
    }
  } while (cursor);
  return { wages_updated: count };
}

// ── Sync shifts (completed + scheduled) ──────────────────────────────────
async function syncShifts(env, lookbackDays = 30, lookAheadDays = 30) {
  const start = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const end = new Date(Date.now() + lookAheadDays * 86400000).toISOString();

  // Get wage map keyed by Square's member id (includes local id for FK resolution)
  const { results: members } = await env.DB.prepare(
    `SELECT id, square_member_id, name, hourly_wage FROM square_team_members`
  ).all();
  const wageMap = new Map((members || []).map(m => [m.square_member_id, m]));

  let cursor = null;
  let upserted = 0;
  do {
    const result = await squareRequest(env, '/labor/shifts/search', {
      query: {
        filter: {
          start: { start_at: start, end_at: end },
        },
      },
      limit: PAGE_SIZE,
      cursor,
    });
    cursor = result.cursor || null;
    for (const s of (result.shifts || [])) {
      const member = wageMap.get(s.team_member_id) || {};
      const start_at = s.start_at;
      const end_at = s.end_at;
      let hours = 0;
      if (start_at && end_at) {
        hours = r2((new Date(end_at) - new Date(start_at)) / 3600000);
      }
      const wage = member.hourly_wage || 0;
      const cost = r2(hours * wage);
      const isForecast = !end_at || new Date(start_at) > new Date();

      await env.DB.prepare(`
        INSERT INTO square_shifts (id, square_shift_id, team_member_id, team_member_name,
          shift_date, start_at, end_at, hours, hourly_wage, cost, status, is_forecast,
          raw_payload, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(square_shift_id) DO UPDATE SET
          end_at = excluded.end_at,
          hours = excluded.hours,
          hourly_wage = excluded.hourly_wage,
          cost = excluded.cost,
          status = excluded.status,
          is_forecast = excluded.is_forecast,
          raw_payload = excluded.raw_payload,
          last_synced_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        s.id || null,
        member.id || null,                    // local team_member uuid (FK target)
        member.name || '(unknown)',
        start_at ? start_at.slice(0, 10) : null,
        start_at || null,
        end_at || null,
        hours || 0,
        wage || 0,
        cost || 0,
        s.status || 'OPEN',
        isForecast ? 1 : 0,
        JSON.stringify(s),
      ).run();
      upserted += 1;
    }
  } while (cursor);
  return { shifts_upserted: upserted };
}

// ── Public: sync all ──────────────────────────────────────────────────────
export async function syncSquareLabor(env, opts = {}) {
  const started = Date.now();
  try {
    const tm = await syncTeamMembers(env);
    const wages = await syncWages(env);
    const shifts = await syncShifts(env, opts.lookback_days || 30, opts.look_ahead_days || 30);

    await heartbeat(env, 'square_labor_sync', { duration_ms: Date.now() - started });
    return {
      ok: true,
      team_members: tm.upserted,
      wages_updated: wages.wages_updated,
      shifts_upserted: shifts.shifts_upserted,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    await heartbeatFailed(env, 'square_labor_sync', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Labor cost forecast for next N days ──────────────────────────────────
export async function getLaborForecast(env, days = 30) {
  const { results } = await env.DB.prepare(`
    SELECT shift_date,
           ROUND(SUM(hours), 1) as total_hours,
           ROUND(SUM(cost), 2) as total_cost,
           COUNT(*) as shift_count
    FROM square_shifts
    WHERE shift_date >= date('now')
      AND shift_date <= date('now', '+' || ? || ' days')
      AND is_forecast = 1
    GROUP BY shift_date
    ORDER BY shift_date
  `).bind(days).all();

  const total_hours = r2((results || []).reduce((s, r) => s + (r.total_hours || 0), 0));
  const total_cost = r2((results || []).reduce((s, r) => s + (r.total_cost || 0), 0));
  return {
    horizon_days: days,
    total_scheduled_hours: total_hours,
    total_projected_cost: total_cost,
    avg_daily_cost: results.length ? r2(total_cost / results.length) : 0,
    daily_breakdown: results || [],
  };
}

// ── Labor productivity: revenue / labor hours for last N days ────────────
export async function getLaborProductivity(env, days = 30) {
  // Hours worked in last N days
  const { hours_row } = { hours_row: await env.DB.prepare(`
    SELECT ROUND(SUM(hours), 1) as hours, ROUND(SUM(cost), 2) as cost
    FROM square_shifts
    WHERE is_forecast = 0
      AND shift_date >= date('now', '-' || ? || ' days')
  `).bind(days).first() };

  // Revenue same period (canonical from posted JEs)
  const { revenue_row } = { revenue_row: await env.DB.prepare(`
    SELECT ROUND(SUM(l.credit - l.debit), 2) as revenue
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_entry_id
    JOIN chart_of_accounts c ON c.id = l.account_id
    WHERE j.status = 'posted'
      AND c.account_type IN ('revenue', 'other_income')
      AND j.entry_date >= date('now', '-' || ? || ' days')
  `).bind(days).first() };

  const hours = hours_row?.hours || 0;
  const cost = hours_row?.cost || 0;
  const revenue = revenue_row?.revenue || 0;
  const revenue_per_labor_hour = hours > 0 ? r2(revenue / hours) : null;
  const labor_pct_of_revenue = revenue > 0 ? r2((cost / revenue) * 100) : null;
  return {
    period_days: days,
    labor_hours_worked: hours,
    labor_cost: cost,
    revenue,
    revenue_per_labor_hour,
    labor_pct_of_revenue,
    note: hours === 0 ? 'No completed shifts in window — run /finance/square-labor/sync first or verify Square Labor data exists.' : null,
  };
}
