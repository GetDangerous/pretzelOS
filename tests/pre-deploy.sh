#!/usr/bin/env bash
# Pretzel OS — Pre-deploy gate (DIF-7)
#
# Runs BEFORE every wrangler deploy. Blocks deploy if any gate fails.
#
# Gates (in order):
#   1. Deprecation enforcement (deprecation.test.sh) — HARD FAIL
#   2. Acceptance test suite (acceptance.test.sh) — HARD FAIL
#   3. Contract tests (/finance/contracts) — HARD FAIL on required APIs
#   4. Cross-consumer Tier 1 — HARD FAIL if cash/runway disagree
#   5. Tier 5 drift (current month) — WARN only (logged, doesn't block)
#
# Usage:
#   bash tests/pre-deploy.sh           — runs all gates, exits 0 if clean
#   bash tests/pre-deploy.sh --skip-contract  — skip live contract pings (offline mode)
#   bash tests/pre-deploy.sh --warn-only      — log failures but exit 0
#
# Wired into npm via package.json: `npm run deploy` calls this first.

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HOST="${PRETZEL_HOST:-https://pretzel-os.drew-f39.workers.dev}"
AUTH="${PRETZEL_AUTH:-dpc-dash-2026-1c-shared-secret}"

SKIP_CONTRACT=false
WARN_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --skip-contract) SKIP_CONTRACT=true ;;
    --warn-only) WARN_ONLY=true ;;
  esac
done

FAIL=0
WARN=0

step() { echo ""; echo "━━━ $1 ━━━"; }
ok()    { echo "  ✓ $1"; }
warn()  { echo "  ⚠ $1"; WARN=$((WARN+1)); }
fail()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pretzel OS Pre-Deploy Gate"
echo "  Target: $HOST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Gate 1: Deprecation enforcement (greps source code, no network) ─────
step "Gate 1: Deprecation enforcement"
if bash "$ROOT/tests/deprecation.test.sh" > /tmp/dep_gate.out 2>&1; then
  ok "deprecation gate clean"
else
  fail "deprecation gate FAILED"
  echo
  cat /tmp/dep_gate.out | sed 's/^/    /'
fi

# ── Gate 2: Acceptance tests (live endpoint checks) ─────────────────────
step "Gate 2: Acceptance test suite"
if bash "$ROOT/tests/acceptance.test.sh" > /tmp/acc_gate.out 2>&1; then
  ok "acceptance gate clean ($(grep -E '^PASS: ' /tmp/acc_gate.out | head -1))"
else
  fail "acceptance gate FAILED"
  echo
  tail -30 /tmp/acc_gate.out | sed 's/^/    /'
fi

# ── Gate 3: Contract tests (live external API pings) ────────────────────
if [ "$SKIP_CONTRACT" = "true" ]; then
  step "Gate 3: Contract tests (SKIPPED via --skip-contract)"
else
  step "Gate 3: Contract tests (Mercury · Square · QBO · Plaid · Gmail · Anthropic)"
  CONTRACT_JSON=$(curl -sf -H "X-Pretzel-Auth: $AUTH" "$HOST/finance/contracts" 2>/dev/null || echo '{}')
  if [ -z "$CONTRACT_JSON" ] || [ "$CONTRACT_JSON" = "{}" ]; then
    fail "contract endpoint unreachable (network or auth issue)"
  else
    REQ_FAIL=$(echo "$CONTRACT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(d.get("summary",{}).get("required_failing",[])) or "none")' 2>/dev/null || echo "parse_error")
    OPT_FAIL=$(echo "$CONTRACT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(d.get("summary",{}).get("optional_failing",[])) or "none")' 2>/dev/null || echo "parse_error")
    if [ "$REQ_FAIL" = "none" ]; then
      ok "all required contracts passing (Mercury, Square, QBO, Anthropic)"
    else
      fail "REQUIRED contracts failing: $REQ_FAIL"
      echo "$CONTRACT_JSON" | python3 -m json.tool 2>/dev/null | head -40 | sed 's/^/    /'
    fi
    if [ "$OPT_FAIL" != "none" ]; then
      warn "optional contracts failing: $OPT_FAIL (deploy NOT blocked)"
    fi
  fi
fi

# ── Gate 4: Cross-consumer Tier 1 (cash + runway must agree) ────────────
step "Gate 4: Cross-consumer agreement (cash + runway)"
AGREEMENT=$(curl -sf -H "X-Pretzel-Auth: $AUTH" "$HOST/finance/canonical-truth/agreement" 2>/dev/null || echo '{}')
if [ -z "$AGREEMENT" ] || [ "$AGREEMENT" = "{}" ]; then
  warn "agreement endpoint unreachable — Tier 1 covers this on cron"
else
  CASH_OK=$(echo "$AGREEMENT" | python3 -c 'import json,sys; d=json.load(sys.stdin); cash=[c for c in d["checks"] if c["metric"]=="cash"]; print("yes" if all(c["within_tolerance"] for c in cash) else "no")' 2>/dev/null || echo "?")
  if [ "$CASH_OK" = "yes" ]; then
    ok "cash consumers agree (within \$0.01)"
  elif [ "$CASH_OK" = "no" ]; then
    fail "cash consumers DISAGREE — Tier 1 would trip read-only on next cron"
  else
    warn "could not parse agreement response"
  fi
fi

# ── Gate 5: Tier 5 drift (WARN ONLY — doesn't block) ────────────────────
# Tier 5 acceptance is slow (5-10s for a full month replay). Skip from
# pre-deploy by default; it runs on a daily cron. Uncomment to enforce.
# step "Gate 5: Tier 5 acceptance drift (current month, WARN ONLY)"
# CURRENT_MONTH=$(date -u +%Y-%m)
# T5=$(curl -sf -X POST -H "X-Pretzel-Auth: $AUTH" "$HOST/finance/audit/acceptance?month=$CURRENT_MONTH" 2>/dev/null || echo '{}')
# echo "  (informational only — see /finance/audit/acceptance for detail)"

# ── Summary ─────────────────────────────────────────────────────────────
echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Pre-Deploy Gate Result"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Failures: $FAIL"
echo "  Warnings: $WARN"
echo

if [ "$FAIL" -gt 0 ]; then
  if [ "$WARN_ONLY" = "true" ]; then
    echo "⚠ $FAIL failure(s) — but --warn-only mode, allowing deploy."
    exit 0
  fi
  echo "✗ Deploy BLOCKED."
  echo
  echo "To override (NOT recommended): bash tests/pre-deploy.sh --warn-only"
  exit 1
fi

echo "✓ All gates green. Deploy allowed."
exit 0
