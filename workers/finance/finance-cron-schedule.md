# Pretzel OS Finance — Cron Schedule

Last reviewed: Apr 30, 2026 (post-reset).

All times shown in UTC; MT equivalent in parens.

| Cron | Agent | Frequency | What it does |
|---|---|---|---|
| `5 * * * *` | `cfo_audit_tier1` | Hourly at :05 | Tier 1 ledger invariants. ANY fail trips `FINANCE_READ_ONLY`. |
| `13 * * * *` (TODO) | n/a | n/a | (Slot reserved — currently unused) |
| `0 13 * * *` (7am MT) | `cfo_daily_close` | Daily | Mercury sync (accounts + txns) → categorize → post-jes → revenue-sweep → forecast. Sends daily email. |
| `0 14 * * *` (8am MT) | `cfo_daily_recon` | Daily | Compares Mercury live cash to book balance. Logs variance. (Legacy — auto-trip disabled in Phase 3 reset.) |
| `30 14 * * *` (8:30am MT) | `cfo_audit_tier2` | Daily | Tier 2 state/drift checks. Informational only — never trips read-only. |
| `0 */6 * * *` | `cfo_pipeline_stalled_check` | Every 6h | If last JE > 26h, sends stalled alert email (24h cooldown). |
| `0 12 1 * *` (6am MT 1st) | `cfo_monthly_close` | Monthly | Final P&L/BS/CF + period lock + depreciation. |
| `0 4 * * 1` (10pm MT Sun) | `cfo_weekly_directive` | Weekly | Sonnet generates weekly directive. Stores in cfo_briefs + KV. Sends email. |
| `0 4 * * 0` (10pm MT Sat) | `cfo` | Weekly | Original cfo-agent (legacy weekly brief). |
| `0 * * * *` | `cfo_pulse` | Hourly | Real-time hourly delta tracking. Updates `cfo_live` KV. |

## Critical agents (alert on failure)

These send email alerts via `sendAlertEmail` if they fail:

- `outreach`, `scout`, `qualifier`, `catering` (sales pipeline)
- `cfo`, `optimizer`, `retail`, `reviews` (operational)
- `qbo_sync`, `square_sync` (data ingestion)
- `cfo_daily_close`, `cfo_daily_recon`, `cfo_monthly_close` (finance pipeline)
- `cfo_audit_tier1`, `cfo_audit_tier2` (audit framework)

## When to manually run

```bash
# Force a fresh daily close (e.g., after fixing a blocker)
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/cfo/daily-close

# Force Tier 1 (corruption check) — should always pass
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/audit/tier/1

# Force Tier 2 (state) — informational
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/audit/tier/2

# Force Mercury balance refresh (also triggered automatically by canonical helper)
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/mercury/sync-accounts

# Tier 5 acceptance for a single month (compare ledger to QBO archive)
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/audit/acceptance?month=2025-06

# Full year acceptance replay (auto-seeds QBO refs for missing months)
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/audit/acceptance/year?year=2025
```

## Where cron runs are logged

Table `cron_runs` (every cron firing inserts a row). Check with:
```bash
curl https://pretzel-os.drew-f39.workers.dev/cron/health
```

Or directly via D1:
```sql
SELECT agent, started_at, completed_at, status, error
FROM cron_runs
WHERE started_at > datetime('now', '-7 days')
ORDER BY started_at DESC;
```
