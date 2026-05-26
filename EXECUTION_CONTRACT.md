# Pretzel OS Finance — Execution Contract

This document is the rulebook for executing the CFO Agent v3.x plan
(`/Users/drew/.claude/plans/delightful-marinating-puzzle.md`).

It exists to prevent execution drift — the pattern of "we plan, we build,
it works at deploy time, then breaks within weeks." Every session reads this
contract before starting work.

## Rules

### 1. The plan is source of truth
- The plan file IS the spec.
- No work is started that isn't in the plan.
- Plan changes require explicit Drew agreement, captured in chat.

### 2. Phase = atomic unit
- A phase is started, completed end-to-end, and verified before the next.
- No half-finished phases left dangling between sessions.
- One commit per phase (clean revert history).

### 3. No scope creep mid-phase
- New ideas surfaced during build go to a "future ideas" section, NOT silently
  added to current work.
- If a tangent looks essential, STOP and discuss with Drew.

### 4. Verification gate per phase
- Each phase ships with at least one acceptance test in `tests/acceptance.test.js`.
- Phase is not "done" until acceptance test passes against deployed state.
- If a phase's acceptance test breaks a prior phase's test, that's a blocker.

### 5. Session retrospective
- End of every session: update plan file with a "what shipped today" block.
- Include: phase name, status, hours estimated, hours actual, acceptance result,
  worker version, commit hash, any notes/observations.

### 6. Hour tracking is honest
- If a phase estimated at 3hr is taking 6hr, STOP and discuss why before
  continuing. Likely a hidden complexity that needs design, not more hours.

### 7. Drift Check at session start
Before any new work, verify:
- [ ] Acceptance tests passing on production
- [ ] Read-only mode is off (or has a known reason)
- [ ] All critical crons heartbeating green
- [ ] Trust score >= 80
- [ ] No open Drew clarifications blocking

If any fail → FIX FIRST. Don't build new on a shaky base.

### 8. Cost discipline
- Every Anthropic call goes through `workers/ai-budget.js` callAI().
- No direct fetch to `api.anthropic.com` anywhere.
- Default to Haiku; Sonnet requires `{ model: 'sonnet' }` and a justification
  in a comment.

### 9. Reuse first
- Before building anything new, check existing helpers:
  - Canonical helpers in `workers/finance-shared.js`
  - Categorizer in `workers/finance-cfo-categorizer.js`
  - JE poster in `workers/finance-je-poster.js`
  - Review queue ops in `workers/finance-review-queue.js`
  - Audit engine in `workers/finance-audit-engine.js`
  - Scorecard / Monthly P&L / AR Aging — see V3.1+ plan section

### 10. Idempotent everything
- Any operation can be safely re-run.
- INSERT statements use ON CONFLICT semantics where re-execution is possible.
- Mutations check current state before writing.

### 11. No silent failures
- Every cron writes a heartbeat on success (or heartbeatFailed on error).
- Every sync logs to `cron_runs`.
- Every AI call logs to `ai_calls`.
- If a thing didn't happen, the daily morning email mentions it.

### 12. Drew sees the math
- Every dashboard number must be clickable for drill-down.
- Every chat agent claim cites the underlying data ("`[show transactions]`").
- Trust score is visible always — drops > 5 points in a day trigger an alert.

## Anti-patterns explicitly prohibited

- ❌ Building outside the plan
- ❌ Skipping the acceptance test
- ❌ Direct `fetch()` to Anthropic API
- ❌ Reading `financial_directives.cash_on_hand` (use canonical helpers)
- ❌ Writing `financial_directives.cash_on_hand` (canonical override path only)
- ❌ Hardcoded model id (use `resolveModelId` via ai-budget.js)
- ❌ Cron without heartbeat
- ❌ Mutation without idempotency
- ❌ Dashboard tile without auth header
- ❌ Stale cache with no `as_of` timestamp visible

## Session flow

1. **Read this contract** (`cat EXECUTION_CONTRACT.md`)
2. **Run drift check** — `curl /finance/trust-score` + check `/finance/audit/latest`
3. **Identify the phase from the plan**
4. **Build the phase** following the rules above
5. **Add acceptance test(s)** for the phase
6. **Deploy + verify**
7. **Update plan file** with retrospective
8. **Commit** (one commit per phase)

## Acceptance test contract

Every test in `tests/acceptance.test.js` is:
- A real HTTP call to production (or a deployed preview)
- Asserts a specific, measurable thing
- Fast (<5s)
- Idempotent (safe to re-run)
- Tagged with the phase that added it

Test naming: `phase_<id>_<short_description>`. Example:
- `phase_v3_s0_trust_score_endpoint_returns_valid_shape`
- `phase_v3_a_vendor_kb_sysco_returns_dominant_account`

## When something breaks in production

1. **Don't panic. Don't patch silently.**
2. Run drift check first — what's the trust score? Which component dropped?
3. Read the audit log: `SELECT * FROM finance_audit_runs WHERE failed > 0 ORDER BY ran_at DESC LIMIT 5`
4. Identify which phase introduced the breaking change.
5. If rollback is safe: roll back to last green deploy.
6. Diagnose in a branch; fix; re-deploy with acceptance tests passing.
7. Add a regression test that catches THIS specific failure pattern.

## Plan version history

The plan file is append-only:
- v3.0 (May 13) — initial CFO Agent vision
- v3.1 (May 13) — clarifications + analysis engine + presentation layer
- v3.2 (May 13) — Chase CC + Square Labor data sources
- v3.3 (May 13) — deeper gap closure (recipe, goals, audit trail, etc.)
- v3.4 (May 13) — durability + cost engineering
- v3.5 (May 13) — final technical pass + Plaid + execution discipline
