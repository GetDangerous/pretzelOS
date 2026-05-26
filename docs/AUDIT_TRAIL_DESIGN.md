# audit_trail Schema Design (Phase A Week 1 Task B1 — DRAFT)

**Generated:** 2026-05-27
**Status:** Design + draft migration ready. **NOT applied to production.** Awaiting Drew approval overnight; apply Day 3 morning if approved.
**Draft migration:** `migrations/100_audit_trail_DRAFT.sql`
**Companion:** `docs/JE_POSTING_PATHS_CATALOG.md` (which paths get audit_trail integration)

---

## Purpose

Unified, append-only audit log of every change to financial state — who did what, when, why, and what the system context was at the time. Replaces the existing ad-hoc `finance_audit_log` table (which has varying JSON shapes per action_type) with a single consistent shape.

Drives Phase A Surface 7 (Audit Trail / Activity History).

---

## Design choices + rationale

### Why a new table instead of extending `finance_audit_log`?

`finance_audit_log` was written organically across Sessions 22-33. Inconsistent column population, mixed semantics, retro-fitting it would break existing query patterns + audit history. The new `audit_trail` table runs in parallel; once Phase A surfaces are live, `finance_audit_log` becomes legacy-read-only.

### Schema columns (full)

```sql
CREATE TABLE audit_trail (
  id              TEXT PRIMARY KEY,
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  actor           TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  before_state    TEXT,
  after_state     TEXT,
  reason_note     TEXT,
  source_metadata TEXT,
  commit_hash     TEXT,
  related_je_id   TEXT,
  related_audit_id TEXT,
  immutable       INTEGER NOT NULL DEFAULT 1
);
```

Per-column rationale:

| Column | Why this column |
|---|---|
| `id` | UUID. Lets external systems reference audit entries durably. |
| `occurred_at` | When the action HAPPENED (system time). For events with a business date different from system time, that goes in `source_metadata`. |
| `actor` | Who. Free-form text but follows convention: `'drew'`, `'system:<source>'`, `'agent:<name>'`. e.g., `'system:cron:cfo_daily_close'`, `'agent:capex_reasoner'`. |
| `action_type` | What action. Vocabulary defined below (§4). |
| `entity_type` + `entity_id` | What was affected. Tuple lets Surface 7 query "show me everything that happened to JE X" or "everything that happened to mercury_txn Y" or "every period close". |
| `before_state` (JSON) | Snapshot of the entity pre-action. Null for create. Lets Surface 7 show diff view. |
| `after_state` (JSON) | Snapshot post-action. Null for delete. |
| `reason_note` | Free text. Required for human actions where context isn't obvious (e.g., reopen_period reason). |
| `source_metadata` (JSON) | LLM confidence, rule that matched, parent_je_id, etc. Catch-all for action-specific structured data. |
| `commit_hash` | Worker code version at write time. Helps later forensic: "which deployment posted this?" |
| `related_je_id` | Soft FK to journal_entries.id. Most actions touch a JE; this lets indexed queries be fast. |
| `related_audit_id` | Soft FK to another audit_trail row. Chains actions: reopen → adjust → reclose, each row links to predecessor. |
| `immutable` | Informational flag. Triggers enforce true immutability; this column is documentation. |

### Append-only enforcement

Two SQLite triggers reject UPDATE and DELETE on audit_trail rows:

```sql
CREATE TRIGGER audit_trail_no_update BEFORE UPDATE ON audit_trail
BEGIN
  SELECT RAISE(FAIL, 'audit_trail is append-only; UPDATE blocked');
END;

CREATE TRIGGER audit_trail_no_delete BEFORE DELETE ON audit_trail
BEGIN
  SELECT RAISE(FAIL, 'audit_trail is append-only; DELETE blocked');
END;
```

**D1 compatibility note:** Cloudflare D1 supports SQLite BEFORE triggers per documentation. Verified syntax matches D1's accepted format. If triggers turn out to have D1-specific gotchas during smoke test (Day 3), fallback is a Tier 1 invariant that hashes recent audit_trail rows and detects tampering.

If a migration genuinely needs to fix an audit_trail row (rare), the approved pattern is:
1. DROP both triggers
2. Apply the surgical UPDATE/DELETE
3. RECREATE both triggers
4. Write an audit_trail entry documenting the schema-maintenance event

This makes tampering visible and auditable.

### Indexes (for Surface 7 query patterns)

```sql
CREATE INDEX idx_audit_trail_occurred_at  ON audit_trail(occurred_at DESC);  -- timeline view
CREATE INDEX idx_audit_trail_entity       ON audit_trail(entity_type, entity_id);  -- drill into one entity
CREATE INDEX idx_audit_trail_actor        ON audit_trail(actor, occurred_at DESC);  -- "what did drew do" / "what did system do"
CREATE INDEX idx_audit_trail_action_type  ON audit_trail(action_type, occurred_at DESC);  -- filter by action class
CREATE INDEX idx_audit_trail_related_je   ON audit_trail(related_je_id);  -- JE → audit chain
```

Each index targets a specific Surface 7 query:
- `occurred_at DESC`: default timeline view, recent first
- `entity` composite: "show me every action on JE abc123"
- `actor + occurred_at`: "what did drew touch this week" / "what did the categorizer do today"
- `action_type + occurred_at`: "show me every reopen_period"
- `related_je_id`: "what's the audit chain for this specific JE"

---

## §4 — `action_type` vocabulary

Initial set. New types added per surface as needed.

| action_type | When written | Typical actor |
|---|---|---|
| `post_je` | New JE inserted into journal_entries | `system:<source_type>` |
| `reverse_je` | JE marked status='reversed' | `system:<source>` or `drew` |
| `categorize_transaction` | mercury_txn gets `proposed_account_id` set | `system:categorizer` or `agent:llm_categorizer` |
| `override_categorization` | mercury_txn proposed_account_id changed by user | `drew` |
| `mark_reconciled` | mercury_txn.is_reconciled set to 1 | `system:je_poster` |
| `close_period` | accounting_periods.status set to 'closed' | `system:cron:cfo_monthly_close` or `drew` |
| `reopen_period` | accounting_periods.status set to 'reopened' | `drew` (only) — reason_note required |
| `approve_capex` | capex candidate capitalized | `drew` |
| `reject_capex` | capex candidate rejected | `drew` |
| `ai_decision_applied` | Agent recommendation auto-applied (high confidence) | `agent:<name>` |
| `ai_decision_overridden` | Drew rejects an AI recommendation | `drew` (source_metadata: original AI suggestion) |
| `post_manual_je` | Drew manually creates a JE via dashboard | `drew` |
| `manual_reclass` | Drew reclassifies between accounts | `drew` |
| `account_create` | New chart_of_accounts row | `system:migration` or `drew` |
| `account_deactivate` | chart_of_accounts.is_active set to 0 | `drew` or `system:migration` |
| `schema_migration` | Migration applied affecting audit_trail itself | `system:migration` |

---

## §5 — Migration approach

### Step 1: apply schema (Day 3 morning if Drew approves overnight)
```bash
mv migrations/100_audit_trail_DRAFT.sql migrations/100_audit_trail.sql
wrangler d1 execute pretzel-os --remote --file=migrations/100_audit_trail.sql
```

### Step 2: write helper function `writeAuditEntry`
New worker module `workers/audit-trail.js` exports:
- `writeAuditEntry(env, entry)` — single insert with sensible defaults
- Helper sets `commit_hash` from env var `DEPLOY_COMMIT_HASH` (we'll inject via wrangler.toml [vars])
- Returns the new audit_trail.id for chaining

### Step 3: integrate into the 9 active JE-posting paths (per JE_POSTING_PATHS_CATALOG.md)
Pattern: after each `INSERT INTO journal_entries`, call `writeAuditEntry(env, { actor, action_type: 'post_je', entity_type: 'journal_entry', entity_id: jeData.id, after_state: jeSnapshot, related_je_id: jeData.id, ... })`.

**Awaits Drew's choice on catalog options (a/b/c)** before this step proceeds.

### Step 4: smoke test
- Post a test JE through each of the 9 active paths
- Verify each writes an audit_trail entry
- Attempt UPDATE / DELETE on a test row, confirm triggers block

### Step 5: backfill (optional — depends on catalog Option C)
If Drew picks Option (c): write a one-time migration that creates `actor='pre_phase_a_legacy'` entries for every existing posted JE (~2,632 rows). Lets Surface 7 timeline show "this is when we deployed audit_trail" as the start of explicit-actor tracking.

---

## §6 — Sample audit_trail entries (what they look like)

### Example 1: System auto-posts categorized JE

```json
{
  "id": "audit-uuid-1",
  "occurred_at": "2026-05-28 07:00:34",
  "actor": "system:mercury_txn",
  "action_type": "post_je",
  "entity_type": "journal_entry",
  "entity_id": "je-abc-123",
  "before_state": null,
  "after_state": {
    "id": "je-abc-123",
    "entry_date": "2026-05-28",
    "source_type": "mercury_txn",
    "total_debit": 487.39,
    "total_credit": 487.39,
    "description": "Sysco Corporation"
  },
  "reason_note": null,
  "source_metadata": {
    "categorizer_rule": "sysco_food",
    "confidence": 0.98,
    "mercury_txn_id": "mt-xyz-789"
  },
  "commit_hash": "abc123def",
  "related_je_id": "je-abc-123",
  "related_audit_id": null,
  "immutable": 1
}
```

### Example 2: Drew overrides categorization

```json
{
  "id": "audit-uuid-2",
  "occurred_at": "2026-05-28 09:14:02",
  "actor": "drew",
  "action_type": "override_categorization",
  "entity_type": "mercury_txn",
  "entity_id": "mt-uvw-456",
  "before_state": {
    "proposed_account_id": "acct-supplies",
    "proposed_confidence": 0.85
  },
  "after_state": {
    "proposed_account_id": "acct-food-purchases",
    "drew_confirmed": true
  },
  "reason_note": "Instacart Business is always food, not supplies",
  "source_metadata": {
    "ai_suggestion_overridden": "instacart_supplies",
    "ai_confidence": 0.85
  },
  "commit_hash": "abc123def",
  "related_je_id": null,
  "related_audit_id": null,
  "immutable": 1
}
```

### Example 3: Reopen period (chain)

```json
{
  "id": "audit-uuid-3",
  "occurred_at": "2026-05-28 10:30:00",
  "actor": "drew",
  "action_type": "reopen_period",
  "entity_type": "accounting_period",
  "entity_id": "2026-04",
  "before_state": {
    "status": "closed",
    "closed_at": "2026-05-01 06:00:00"
  },
  "after_state": {
    "status": "reopened",
    "reopen_reason": "Bank confirmed $500 wire didn't actually settle"
  },
  "reason_note": "Bank confirmed $500 wire didn't actually settle",
  "source_metadata": null,
  "commit_hash": "abc123def",
  "related_je_id": null,
  "related_audit_id": null,
  "immutable": 1
}
```

Later, when Drew posts an adjusting JE:
```json
{
  "id": "audit-uuid-4",
  "action_type": "post_manual_je",
  "entity_id": "je-adj-001",
  "related_audit_id": "audit-uuid-3",     // ← chains back to the reopen
  ...
}
```

And finally the reclose:
```json
{
  "id": "audit-uuid-5",
  "action_type": "close_period",
  "entity_id": "2026-04",
  "related_audit_id": "audit-uuid-4",     // ← chains to the adjust which chains to the reopen
  ...
}
```

Surface 7 can walk this chain to show "this period was reopened on May 28 because of X, adjusted with JE Y, and reclosed."

---

## §7 — Open questions for Drew

1. **`commit_hash` source** — where does it come from at write time?
   - Option (a): Inject via `wrangler.toml [vars] DEPLOY_COMMIT_HASH = "..."` at deploy time. Requires deploy script update.
   - Option (b): Store in a `system_state` KV key after each deploy.
   - Option (c): Leave null for now; backfill mechanism later.
   - **Recommendation: (a)** — clean integration with existing deploy flow.

2. **`source_metadata` JSON schema** — should be free-form per `action_type` or formalized per type?
   - Free-form gives flexibility for new action_types; structured gives Surface 7 better filtering.
   - **Recommendation: free-form** for now; if Surface 7 needs specific filters later, we can add typed columns.

3. **Drew preference on `actor` format**
   - `drew` (lowercase) vs `Drew` vs full email `drew@dangerouspretzel.com`?
   - **Recommendation: `drew`** (lowercase, single user — matches existing convention in cron_runs.actor).

4. **Test row strategy** — should the smoke-test entries stay in audit_trail (as part of the audit history) or be allowed to delete (triggers say no)?
   - **Recommendation: stay.** They're legitimate "schema deploy" events.

---

## §8 — Acceptance criteria (Day 3 deliverable)

When Drew approves schema, Day 3 execution:

- [ ] Rename `100_audit_trail_DRAFT.sql` → `100_audit_trail.sql`
- [ ] Apply migration via `wrangler d1 execute --remote --file=`
- [ ] Verify table exists + indexes created
- [ ] Verify both triggers reject UPDATE + DELETE on smoke-test row
- [ ] Create `workers/audit-trail.js` with `writeAuditEntry()` helper
- [ ] Smoke-test the helper by writing one entry per active path (after catalog decision lands)
- [ ] Tier 1 invariant `audit_trail_covers_active_writers` added (if catalog Option B)

---

## §9 — What this design does NOT include (intentional)

- No archival / retention (forever-grow per prompt)
- No row-level encryption (D1 is internal-only, behind Cloudflare Access path)
- No external sync (no S3 mirror, no BigQuery export) — D1 is the system of record
- No automatic before_state computation (caller must provide; not all actions have a meaningful "before")
- No real-time alerting on audit events (Phase A Week 6+ may add)

End of design doc. Awaiting Drew approval to apply migration Day 3 morning.
