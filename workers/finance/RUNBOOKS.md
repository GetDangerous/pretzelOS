# Pretzel OS Finance — Runbooks

Last reviewed: Apr 30, 2026.

## "Read-only is on, what do I do?"

```bash
# 1. Why is it on?
curl https://pretzel-os.drew-f39.workers.dev/finance/cfo/read-only

# 2. Check the latest Tier 1 — find the failing check
curl https://pretzel-os.drew-f39.workers.dev/finance/audit/latest

# 3. If failure is genuine corruption, investigate. If structural state
#    (e.g. mercury_live_vs_book — that's Tier 2 now, but legacy trips may exist):
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/cfo/read-only \
  -H 'Content-Type: application/json' \
  -d '{"active": false, "reason": "<documented reason>"}'

# 4. Verify daily close runs cleanly:
curl -X POST https://pretzel-os.drew-f39.workers.dev/finance/cfo/daily-close
```

## "Daily close email said 0 JEs posted, what went wrong?"

The new outcome banner tells you. Possibilities:
- **"Pipeline blocked (read-only)"** → see runbook above
- **"0 JEs posted, N in queue"** → review queue isn't being cleared automatically. Walk it on the Money page (Bulk approve by counterparty).
- **"No new activity"** → Mercury sync didn't pull anything new. Check `/finance/mercury/status` — last_synced_at should be < 1h.

## "Monday Digest cash number looks wrong"

Should never happen post-reset. If it does:
1. Compare to live: `curl /finance/canonical/cash-on-hand` — that's the truth.
2. If digest cash differs: account-worker.js still has stale read path. Check line 1493 reads `canon.cash_on_hand`, NOT `cfo_data.cash_on_hand`.
3. If canonical itself is wrong: Mercury API is down OR mercury_accounts wasn't refreshed. Force sync: `curl -X POST /finance/mercury/sync-accounts`.

## "Pipeline stalled" alert email arrived

Last JE posted > 26h ago. Check:
1. `/finance/system-health` — what's red?
2. Read-only state — if on, follow runbook 1.
3. If read-only OFF and still no posts: `/finance/cfo/categorize-stats` — is the queue full of low-confidence items?
4. Run `/finance/cfo/daily-close` manually to confirm.

## "Tier 1 audit failed"

This means data corruption. **Don't try to keep posting.** Investigate first:
```bash
# Find the run id
curl /finance/audit/latest

# Pull full detail
curl /finance/audit/<run_id>

# The check_id tells you which invariant broke. Common ones:
# - dr_eq_cr_per_je: a JE has unbalanced lines (impossible via app, schema CHECK should prevent — DB-level corruption)
# - no_orphan_je_lines: lines pointing at deleted JE headers (shouldn't happen — schema FK cascade)
# - no_invalid_account_id: account was deleted while JE references it (don't delete COA rows)
# - reconciled_has_matched_je: txn marked reconciled but matched JE was reversed
# - no_duplicate_mercury_txns: Mercury sync regression (UNIQUE constraint should prevent)
# - directive_cash_not_written: cfo-agent is regressing — check the bind position is NULL
```

## "Drew approved a bunch of txns but they didn't post"

Check:
1. `bulkApproveCounterparty` returned `posted: 0, failed: N` — look at the `errors` field.
2. Common cause (fixed Apr 30): missing `account_name` in the SELECT — JE poster couldn't resolve Mercury bank account. Verify the SQL in `workers/finance-review-queue.js` includes `account_name`.
3. Read-only mode (shouldn't apply — review-queue paths bypass — but verify anyway).

## "The 12-month Tier 5 acceptance replay shows expense gap"

Expected until the review queue is processed:
- Each unposted Mercury outflow = expense not in P&L
- 130 in queue × ~$200 average = ~$26K untapped expense per month
- Walk Money page → Bulk Approve by Counterparty → safe groups (Amazon, Sysco, etc.)
- Re-run replay after each session: `POST /finance/audit/acceptance/year?year=2025`

## "Mercury balance is wrong / stale"

Should never happen post-reset (refresh-on-read with 5-min TTL):
1. Force inline refresh: `curl /finance/canonical/cash-on-hand` returns `refreshed_inline: true` if cache was stale.
2. If still wrong: Mercury API token may be revoked. Check `/finance/mercury/status` — error field surfaces token issues.
3. Last resort: `npx wrangler secret put MERCURY_API_TOKEN` with a new token.

## "Catering / CFO directive cron failed"

Common cause: Anthropic credit balance too low. Check `/cron/health` for the error message. Top up at console.anthropic.com.

## Opening balance commit

DO NOT do this without Irene's signoff. When she signs:
1. Identify the override account names she specifies.
2. Preview: `GET /finance/cfo/opening-balance/preview?cutover=YYYY-MM-DD`
3. Verify it balances (preview returns `balanced: true`).
4. Commit: `POST /finance/cfo/opening-balance/commit?cutover=...&acknowledge=1 -d {irene_signoff_note: "..."}`
5. After commit: `mercury_live_vs_book` should drop to <$50 in next Tier 2 run. Tier 5 acceptance gaps shrink.
