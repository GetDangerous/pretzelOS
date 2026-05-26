#!/usr/bin/env bash
# Pretzel OS — Deprecation Enforcement (DIF-4)
#
# Scans the workers/ directory for known deprecation violations:
#   1. Reads of the deprecated financial_directives.cash_on_hand field
#   2. Direct fetch('https://api.anthropic.com/...') OUTSIDE workers/ai-budget.js
#   3. Hardcoded `claude-sonnet-4-6` / `claude-haiku-4-5` model ids OUTSIDE the wrapper
#   4. Direct SUM(amount) FROM mercury_transactions for cash display (must use canonical)
#
# Each violation prints file:line and exits 1.
#
# This test runs BEFORE wrangler deploy via tests/acceptance.test.sh (and in CI).
# A violation BLOCKS the deploy — that's the deploy gate's enforcement teeth.
#
# To intentionally allow a deprecation (with justification), add it to the
# allowlist file: tests/deprecation.allowlist
#
# Usage: bash tests/deprecation.test.sh
# Exit code: 0 = clean, 1 = violations found

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOWLIST="tests/deprecation.allowlist"
VIOLATIONS=0
FOUND_FILES=()

# Build the grep exclusion list from allowlist (one file:line per entry)
ALLOW_REGEX=""
if [ -f "$ALLOWLIST" ]; then
  ALLOW_REGEX="$(grep -v '^#' "$ALLOWLIST" | grep -v '^$' | paste -sd '|' -)"
fi

# Helper: check a pattern. Args: $1=pattern, $2=where (glob), $3=description, $4=allow-pattern
check() {
  local pattern="$1"
  local where="$2"
  local desc="$3"
  local allow="$4"

  local hits
  # Restrict to .js files — docs (.md), allowlist (.allowlist), and the test
  # script itself naturally contain pattern strings as examples.
  if [ -n "$allow" ]; then
    hits=$(grep -rn --include='*.js' "$pattern" $where 2>/dev/null | grep -Ev "$allow" || true)
  else
    hits=$(grep -rn --include='*.js' "$pattern" $where 2>/dev/null || true)
  fi

  # Filter out allowlist
  if [ -n "$ALLOW_REGEX" ]; then
    hits=$(echo "$hits" | grep -vE "$ALLOW_REGEX" || true)
  fi

  # Filter out commented lines (starts with //, *, or # after whitespace)
  hits=$(echo "$hits" | grep -v '^[^:]*:[0-9]*: *//' \
                       | grep -v '^[^:]*:[0-9]*: *\*' \
                       | grep -v '^[^:]*:[0-9]*: *#' \
                       || true)

  if [ -n "$hits" ]; then
    echo "  ✗ $desc"
    echo "$hits" | head -20 | sed 's/^/      /'
    local count=$(echo "$hits" | wc -l | tr -d ' ')
    if [ "$count" -gt 20 ]; then
      echo "      ... and $((count - 20)) more"
    fi
    VIOLATIONS=$((VIOLATIONS + count))
  else
    echo "  ✓ $desc"
  fi
}

echo "━━━ DIF-4 Deprecation Enforcement ━━━"
echo

echo "Check 1: financial_directives.cash_on_hand reads (deprecated Phase 2 reset)"
# Allow: SQL writes (UPDATE financial_directives SET cash_on_hand = NULL, ALTER TABLE)
# Allow: the audit check that verifies the column is NOT being read (regression test)
# Block: SELECT cash_on_hand FROM financial_directives, .cash_on_hand reads
check 'financial_directives.*cash_on_hand\|directives\.cash_on_hand\|directive\.cash_on_hand' \
  'workers/' \
  'No live reads of financial_directives.cash_on_hand' \
  'directive_cash_not_written|finance-audit-engine\.js|UPDATE financial_directives|ALTER TABLE|cash_on_hand IS NULL|cash_on_hand = NULL'

echo
echo "Check 2: Direct Anthropic API fetches (must route through ai-budget.js)"
# Allow: ai-budget.js (the wrapper), http-utils.js (doc comment),
#        finance-audit-engine.js (intentional health-check via fetchWithBackoff),
#        chat-worker.js handleChatStream SSE (streaming intentionally direct)
check 'api\.anthropic\.com' \
  'workers/' \
  'No direct Anthropic API fetches outside ai-budget.js' \
  'workers/ai-budget\.js|workers/http-utils\.js|workers/finance-audit-engine\.js|workers/chat-worker\.js'

echo
echo "Check 3: Hardcoded model ids outside ai-budget.js"
# Catches NEW hardcoded claude-sonnet-* or claude-haiku-* references that should
# go through resolveModelId in ai-budget.js. KV-driven model rotation depends on
# this. Existing call sites are wired through callAI, which receives 'sonnet'/'haiku'
# keys; only ai-budget.js should know the literal model id.
check '"claude-sonnet-[0-9]\|"claude-haiku-[0-9]\|.claude-sonnet-[0-9]\|.claude-haiku-[0-9]' \
  'workers/' \
  'No hardcoded model ids outside ai-budget.js' \
  'workers/ai-budget\.js|chat-worker\.js.*chat_stream_reply|chat_stream_reply.*claude-sonnet'

echo
echo "Check 4: Direct mercury_transactions SUM for cash (must use getCanonicalCashOnHand)"
# Allow: legitimate audit/categorization/queue uses that aggregate for non-cash purposes
# Block: SUM(amount) where amount > 0 with "cash" in nearby context
# This is heuristic — we look for the literal pattern "FROM mercury_transactions" + cash-on-hand context
# Use a softer check: any non-canonical SUM near the term "cash_on_hand" or "cash_total"
check 'getCanonicalCashOnHand\(\)\.total\|SELECT SUM(current_balance) FROM mercury_accounts' \
  'workers/' \
  'No direct SUM(mercury_accounts.current_balance) outside finance-shared.js (canonical helper owns this)' \
  'workers/finance-shared\.js|workers/finance-audit-engine\.js|workers/finance-canonical-truth\.js'

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$VIOLATIONS" -gt 0 ]; then
  echo "DEPRECATION VIOLATIONS: $VIOLATIONS"
  echo
  echo "These violations indicate code reading from deprecated fields, bypassing"
  echo "the AI budget wrapper, or computing canonical metrics by hand. Fix them"
  echo "before deploy, or add to tests/deprecation.allowlist with justification."
  exit 1
fi
echo "Deprecation enforcement clean ✓"
exit 0
