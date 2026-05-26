// workers/d1-backup.js
// Daily D1 → R2 backup worker (Foundation Safety Workstream 1, Task 3b)
//
// Architecture:
//   1. Cron at 05:00 UTC (~10pm MT in standard time / 11pm MT in DST) — after the day's activity
//   2. Calls Cloudflare D1 REST API: POST /accounts/{account_id}/d1/database/{db_id}/export
//      → returns a signed_url for the SQL dump
//   3. Fetches the signed_url, streams the body into R2 at d1-backups/pretzel-os-YYYY-MM-DD.sql
//   4. Logs to backup_runs table (status, size, duration, errors)
//   5. Retention policy enforced by R2 lifecycle rules (set separately — see RECOVERY_PROCEDURES.md):
//        - Daily: 90 days
//        - Weekly: 6 months (Mon backups retained longer via prefix d1-backups/weekly/...)
//        - Monthly: indefinite (1st of month under d1-backups/monthly/...)
//
// Required secrets (Drew sets via `wrangler secret put`):
//   CLOUDFLARE_API_TOKEN — token with `D1:Edit` permission for this account
//
// Required wrangler.toml bindings:
//   [[r2_buckets]]                       (added in wrangler.toml)
//   binding = "BACKUPS"
//   bucket_name = "pretzel-pos-data"
//
// Required env vars:
//   CLOUDFLARE_ACCOUNT_ID  (already in wrangler.toml as account_id = "f399e3...")
//   D1_DATABASE_ID         = "950cc9e0-9dd2-4f78-af55-de6385ab293b"  (pretzel-os)

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function logBackupStart(env, runDate, key) {
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`
      INSERT INTO backup_runs (id, run_date, r2_key, status, started_at)
      VALUES (?, ?, ?, 'in_progress', datetime('now'))
    `).bind(id, runDate, key).run();
  } catch (e) {
    // Table may not exist yet on first deploy; surface but don't fail the backup
    console.error('backup_runs insert failed (table missing?):', e.message);
  }
  return id;
}

async function logBackupResult(env, runId, status, sizeBytes, durationMs, errorMessage) {
  try {
    await env.DB.prepare(`
      UPDATE backup_runs
      SET status = ?, size_bytes = ?, duration_ms = ?, error_message = ?, completed_at = datetime('now')
      WHERE id = ?
    `).bind(status, sizeBytes, durationMs, errorMessage, runId).run();
  } catch (e) {
    console.error('backup_runs update failed:', e.message);
  }
}

// Trigger D1 export via Cloudflare REST API. Returns the signed_url for the SQL dump.
async function requestD1Export(env) {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN secret not set — run `wrangler secret put CLOUDFLARE_API_TOKEN`');
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || 'f399e3bcd5ea1501830d0ad1d35d9da3';
  const dbId = env.D1_DATABASE_ID || '950cc9e0-9dd2-4f78-af55-de6385ab293b';

  const url = `${CF_API_BASE}/accounts/${accountId}/d1/database/${dbId}/export`;

  // Cloudflare's D1 export is async — first call kicks off the job + may return immediately
  // with a polling-style response. We use output_format=sql for restorable dumps.
  const initResp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      output_format: 'polling',
      dump_options: {
        no_schema: false,
        no_data: false,
      },
    }),
  });

  if (!initResp.ok) {
    const text = await initResp.text();
    throw new Error(`D1 export init failed ${initResp.status}: ${text.slice(0, 300)}`);
  }

  const initJson = await initResp.json();
  if (!initJson.success) {
    throw new Error(`D1 export init returned success=false: ${JSON.stringify(initJson.errors || initJson).slice(0, 300)}`);
  }

  // Poll for the signed_url. Cloudflare returns either:
  //   { result: { at_bookmark, signed_url, status: 'complete' } }  — immediate
  //   { result: { at_bookmark, status: 'active', messages: [...] } }  — still running
  let signedUrl = initJson.result?.signed_url;
  let bookmark = initJson.result?.at_bookmark;
  let pollCount = 0;
  const maxPolls = 60;  // 60 × 5s = 5 min max
  while (!signedUrl && pollCount < maxPolls) {
    await new Promise(r => setTimeout(r, 5000));
    pollCount += 1;
    const pollResp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        output_format: 'polling',
        current_bookmark: bookmark,
      }),
    });
    const pollJson = await pollResp.json();
    if (pollJson.result?.signed_url) {
      signedUrl = pollJson.result.signed_url;
      break;
    }
    bookmark = pollJson.result?.at_bookmark || bookmark;
  }

  if (!signedUrl) {
    throw new Error(`D1 export did not complete within ${maxPolls * 5}s`);
  }

  return signedUrl;
}

async function streamExportToR2(env, signedUrl, r2Key) {
  const resp = await fetch(signedUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch signed_url: ${resp.status}`);
  }
  if (!env.BACKUPS) {
    throw new Error('R2 binding BACKUPS not configured — check wrangler.toml');
  }
  await env.BACKUPS.put(r2Key, resp.body, {
    httpMetadata: { contentType: 'application/sql' },
    customMetadata: {
      source_db: 'pretzel-os',
      generated_at: new Date().toISOString(),
      backup_type: 'd1_export_sql',
    },
  });

  // Verify via HEAD
  const head = await env.BACKUPS.head(r2Key);
  return head?.size || 0;
}

// Determine R2 key with retention-aware prefix
function backupKeyForDate(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const dayOfWeek = date.getUTCDay();   // 0 = Sunday, 1 = Monday
  const dayOfMonth = date.getUTCDate();

  // Monthly (1st of month): never expires
  if (dayOfMonth === 1) return `d1-backups/monthly/pretzel-os-${yyyy}-${mm}-${dd}.sql`;
  // Weekly (Mondays): 6-month retention
  if (dayOfWeek === 1) return `d1-backups/weekly/pretzel-os-${yyyy}-${mm}-${dd}.sql`;
  // Daily: 90-day retention
  return `d1-backups/daily/pretzel-os-${yyyy}-${mm}-${dd}.sql`;
}

// ── Public entrypoints ────────────────────────────────────────────────────

export async function runD1Backup(env, { triggeredBy = 'cron' } = {}) {
  const start = Date.now();
  const runDate = new Date().toISOString().slice(0, 10);
  const key = backupKeyForDate();
  const runId = await logBackupStart(env, runDate, key);

  try {
    const signedUrl = await requestD1Export(env);
    const sizeBytes = await streamExportToR2(env, signedUrl, key);
    const durationMs = Date.now() - start;
    await logBackupResult(env, runId, 'success', sizeBytes, durationMs, null);
    return {
      ok: true,
      run_id: runId,
      r2_key: key,
      size_bytes: sizeBytes,
      duration_ms: durationMs,
      triggered_by: triggeredBy,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    await logBackupResult(env, runId, 'failed', null, durationMs, String(err.message || err).slice(0, 500));
    throw err;
  }
}

// Optional HTTP endpoint for manual runs / health checks (wire in router.js)
export async function handleD1BackupRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/finance/backup/run' && request.method === 'POST') {
    try {
      const result = await runD1Backup(env, { triggeredBy: 'manual' });
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  if (url.pathname === '/finance/backup/status') {
    const recent = await env.DB.prepare(`
      SELECT id, run_date, r2_key, status, size_bytes, duration_ms, error_message,
             started_at, completed_at
      FROM backup_runs
      ORDER BY started_at DESC
      LIMIT 20
    `).all();
    return new Response(JSON.stringify({ ok: true, recent: recent.results || [] }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response('Not found', { status: 404 });
}
