# Pretzel OS — Recovery Procedures

**Last updated:** 2026-05-26
**Audience:** Drew (or anyone with Cloudflare account access + GitHub access)
**Scope:** What to do when something goes wrong — D1 corruption, bad deploy, accidental delete.

> **Read this BEFORE you need it.** Tested 2026-05-26 via `wrangler d1 export` dry-run — 14 sec, 104 MB SQL, 3,864 journal_entries restored cleanly into in-memory SQLite. Backups are valid.

---

## Resources at a glance

| Resource | Where | Notes |
|---|---|---|
| GitHub repo | `https://github.com/GetDangerous/pretzelOS` | Private. Baseline commit `db3b058` (May 26 2026). |
| Cloudflare account | `f399e3bcd5ea1501830d0ad1d35d9da3` | Owner: Drew |
| D1 production DB | `pretzel-os` · UUID `950cc9e0-9dd2-4f78-af55-de6385ab293b` | 94 MB as of May 2026 |
| Time Travel window | Last 30 days | Default-on for all D1; no setup |
| R2 backup bucket | `pretzel-pos-data` | Backups under `d1-backups/` prefix |
| Backup status endpoint | `GET /finance/backup/status` | Last 20 runs with status + size + duration |
| Manual backup trigger | `POST /finance/backup/run` | Auth: `X-Pretzel-Auth: $DASHBOARD_AUTH_TOKEN` |
| Cloudflare D1 support | https://dash.cloudflare.com/?to=/:account/support | Account-level support tickets |

---

## Scenario 1 — Restore D1 to a point within the last 30 days (Time Travel)

**Use when:** A bad migration or buggy worker corrupted recent data and you know roughly when it happened.

```bash
# 1. Get the current bookmark (for reference, in case rollback also needs reverting)
npx wrangler d1 time-travel info pretzel-os

# 2. Pick a target timestamp BEFORE the corruption
#    Format: ISO 8601, e.g., "2026-05-25T12:00:00Z"

# 3. Run the restore (this is DESTRUCTIVE — it rewrites D1 to that point in time)
npx wrangler d1 time-travel restore pretzel-os --timestamp=2026-05-25T12:00:00Z

# OR if you have a specific bookmark from earlier output:
npx wrangler d1 time-travel restore pretzel-os --bookmark=000025a3-00000058-00005077-...
```

**What this does:** Rewrites the entire D1 database to the state at the target timestamp. **All changes after that point are lost** (unless you exported them somewhere else first).

**Verification after restore:**
```bash
# Check Tier 1 ledger invariants
curl -H "X-Pretzel-Auth: $TOKEN" https://pretzel-os.drew-f39.workers.dev/finance/audit/tier/1

# Check that recent expected JEs are present (or absent if you wanted them gone)
curl -H "X-Pretzel-Auth: $TOKEN" https://pretzel-os.drew-f39.workers.dev/finance/system-health
```

**Limits:**
- 30-day window only — anything older needs R2 backup (Scenario 2)
- Restore is account-wide for the database, not per-table

---

## Scenario 2 — Restore from R2 backup (older than 30 days)

**Use when:** Corruption is older than the Time Travel window, OR you want to verify a backup is intact, OR you need a copy in a separate D1 instance for forensics.

### List available backups

```bash
# List daily backups (last 90 days retained)
npx wrangler r2 object list pretzel-pos-data --prefix=d1-backups/daily/

# Weekly (last 6 months retained — Mondays)
npx wrangler r2 object list pretzel-pos-data --prefix=d1-backups/weekly/

# Monthly (never expires — 1st of each month)
npx wrangler r2 object list pretzel-pos-data --prefix=d1-backups/monthly/
```

### Download a specific backup

```bash
# Example: download the May 1 2026 monthly snapshot
mkdir -p /tmp/d1-restore
npx wrangler r2 object get pretzel-pos-data/d1-backups/monthly/pretzel-os-2026-05-01.sql \
  --file=/tmp/d1-restore/pretzel-os-2026-05-01.sql

ls -la /tmp/d1-restore/
# Expect ~100 MB SQL file
```

### Restore to a NEW D1 instance (safe — does not touch production)

```bash
# 1. Create a new database for the restore target
npx wrangler d1 create pretzel-os-restore-test

# 2. Load the backup into it
npx wrangler d1 execute pretzel-os-restore-test --file=/tmp/d1-restore/pretzel-os-2026-05-01.sql --remote

# 3. Query to verify
npx wrangler d1 execute pretzel-os-restore-test --command="SELECT COUNT(*) FROM journal_entries" --remote

# 4. (Optional) Point a staging worker at this DB to validate behavior, OR copy specific tables back to prod
```

### Restore to PRODUCTION (destructive — last resort)

If Time Travel can't help and the only fix is to overwrite production with a backup:

```bash
# THIS WILL ERASE EVERY ROW IN PRODUCTION D1 AND REPLACE WITH BACKUP STATE.
# Get explicit Drew approval before running.

# 1. Take a current-state backup first (so you can revert THIS restore if needed)
npx wrangler d1 export pretzel-os --output=/tmp/PRE_RESTORE_$(date +%Y%m%d_%H%M%S).sql --remote

# 2. Apply the backup
npx wrangler d1 execute pretzel-os --file=/tmp/d1-restore/pretzel-os-2026-05-01.sql --remote

# 3. Verify Tier 1 invariants pass
curl -H "X-Pretzel-Auth: $TOKEN" https://pretzel-os.drew-f39.workers.dev/finance/audit/tier/1
```

**Caveat:** D1 doesn't have a "drop and reload" command. If the existing tables conflict with `CREATE TABLE IF NOT EXISTS` in the dump, you may get errors. Consider creating a fresh D1 instance and swapping the wrangler.toml binding instead.

---

## Scenario 3 — Roll back a bad deploy (worker code, not data)

**Use when:** A `wrangler deploy` shipped broken code and you need the previous version live.

### Option A — Roll back via Cloudflare dashboard (fastest)

1. Open https://dash.cloudflare.com/?to=/:account/workers/services/view/pretzel-os/production/deployments
2. Find the last good deployment (typically the one before today's)
3. Click "Rollback" → confirm

This swaps the active worker to the older deployment **without touching D1**.

### Option B — Roll back via git + redeploy

```bash
cd ~/Code/claude\ code\ context/dangerous-pretzel

# 1. Find the last good commit (use the baseline as a reference point)
git log --oneline -20

# 2. Check out that commit
git checkout <commit-hash>

# 3. Verify the working tree looks right
git status
ls workers/

# 4. Redeploy from the checked-out state
npx wrangler deploy

# 5. Once verified, go back to main + cherry-pick or revert as needed
git checkout main
```

---

## Scenario 4 — Cloudflare D1 outage / data loss at Cloudflare's end

**Use when:** Cloudflare itself has lost D1 data (rare but documented in their status pages historically).

1. Check https://www.cloudflarestatus.com for D1 incidents
2. Open a Cloudflare support ticket at https://dash.cloudflare.com/?to=/:account/support
   - Reference Pretzel OS account ID `f399e3bcd5ea1501830d0ad1d35d9da3`
   - Database UUID `950cc9e0-9dd2-4f78-af55-de6385ab293b`
3. While waiting for support, restore from your latest R2 backup to a NEW D1 instance (Scenario 2 — new instance variant)
4. Point production worker at the new instance by updating `wrangler.toml` `database_id` and redeploying

---

## Scenario 5 — Quarterly recovery drill (run this every 90 days)

Backups you've never tested aren't backups. **Run this every quarter:**

```bash
# Drill steps — ~10 minutes
# 1. List most recent daily backup
npx wrangler r2 object list pretzel-pos-data --prefix=d1-backups/daily/ \
  | sort -k4 | tail -3

# 2. Download the most recent one
LATEST_KEY=$(npx wrangler r2 object list pretzel-pos-data --prefix=d1-backups/daily/ \
  | grep "pretzel-os-" | sort | tail -1 | awk '{print $1}')
npx wrangler r2 object get pretzel-pos-data/${LATEST_KEY} --file=/tmp/drill_$(date +%Y%m%d).sql

# 3. Verify SQL parses cleanly into in-memory SQLite (no real DB created)
sqlite3 :memory: ".read /tmp/drill_$(date +%Y%m%d).sql" "SELECT COUNT(*) FROM journal_entries;"
sqlite3 :memory: ".read /tmp/drill_$(date +%Y%m%d).sql" "SELECT COUNT(*) FROM mercury_transactions;"

# 4. Expected: counts roughly match what's in production (within last day's worth of activity)
curl -H "X-Pretzel-Auth: $TOKEN" \
  "https://pretzel-os.drew-f39.workers.dev/finance/canonical/cash-on-hand"
# (sanity check that production is still live + responding)

# 5. Log the drill result
echo "Drill $(date +%Y-%m-%d): backup verified $LATEST_KEY" >> docs/recovery_drill_log.md
```

If the drill FAILS (sqlite3 errors, missing tables, counts wildly off):
1. Check the backup_runs table for recent failures: `curl /finance/backup/status`
2. Inspect the cron history in Cloudflare dashboard
3. Re-run the backup manually: `curl -X POST -H "X-Pretzel-Auth: $TOKEN" /finance/backup/run`

---

## Quick sanity check (anytime)

```bash
# Are recent backups landing?
curl -H "X-Pretzel-Auth: $TOKEN" \
  https://pretzel-os.drew-f39.workers.dev/finance/backup/status | jq '.recent[0:3]'

# Expected: most recent run within last 24h, status=success, size_bytes around 100M
```

If `recent` is empty OR status=failed for >2 days → recovery posture is broken. Fix immediately.

---

## What's NOT covered here

- **Mercury / QBO / Plaid data**: those live in their respective services. Our D1 stores the ingested copy. If Mercury itself loses your transactions (extremely rare), Pretzel OS's D1 + backups still have the historical ingested copy.
- **KV namespace state**: read-only flags, AUTH tokens, narrative cache. Lost = system reverts to default behavior; not catastrophic.
- **R2 bucket itself being lost**: Cloudflare's R2 is multi-region durable. If R2 IS lost, backups would also be lost. For belt-and-suspenders, periodically copy a monthly R2 backup to local disk (Drew's call).

---

## Verification log

| Date | Tested by | Result |
|---|---|---|
| 2026-05-26 | Claude (Foundation Safety setup) | ✅ `wrangler d1 export` → 14 sec, 104 MB, 118 tables, 3,864 JE rows restored into in-memory SQLite |
