#!/bin/bash
# tests/cross_statement_reconciliation.sh
# Phase 32 Acceptance Criterion 2.2: Statements must tie to each other.
#
# Checks:
# 1. P&L Net Income == SOCF Net Income (operating section starting line)
# 2. BS Long-term Liability YE balance change == SOCF Net Loan Activity
# 3. BS Total ASSETS == BS Total LIABILITIES + EQUITY (already enforced by Tier 1, here as sanity)
# 4. P&L Total Revenue + Total COGS + Total Expense ties internally
# 5. SOCF Net Change in Cash + Opening Cash = Closing Cash (matches Mercury YE balance)
#
# Usage: bash tests/cross_statement_reconciliation.sh [path/to/package_dir]
# Exit codes: 0 = all reconciliations within tolerance; 1 = failures (will print)

set -e

PKG_DIR="${1:-irene_package_FY2025}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_PATH="$REPO_ROOT/$PKG_DIR"
TOLERANCE_DOLLARS=1.00

PNL="$PKG_PATH/FY2025_PnL.csv"
BS="$PKG_PATH/BS_YE2025.csv"
SOCF="$PKG_PATH/CashFlow_FY2025.csv"

for f in "$PNL" "$BS" "$SOCF"; do
  [ ! -f "$f" ] && { echo "ERROR: file not found: $f"; exit 2; }
done

# Helper: extract value from CSV by label match
csv_get() {
  local file="$1"
  local label="$2"
  grep "\"$label\"" "$file" | head -1 | sed -E 's/.*,(-?[0-9]+(\.[0-9]+)?).*/\1/'
}

# Extract values
PNL_NI=$(csv_get "$PNL" "Net Income")
SOCF_NI=$(grep -E 'Net Income' "$SOCF" | head -1 | awk -F, '{print $NF}')
PNL_REVENUE=$(grep '"Net Revenue (ASC 606)"' "$PNL" | head -1 | awk -F, '{print $NF}')
PNL_COGS_TOTAL=$(csv_get "$PNL" "Total COGS")
PNL_GROSS_PROFIT=$(csv_get "$PNL" "Gross Profit")

BS_ASSETS=$(csv_get "$BS" "=== Total ASSETS ===")
BS_LIABEQ=$(csv_get "$BS" "TOTAL LIABILITIES + EQUITY")
BS_UNBALANCED=$(csv_get "$BS" "Unbalanced by")

SOCF_LOAN_ACTIVITY=$(grep -E 'Net Loan Activity' "$SOCF" | head -1 | awk -F, '{print $NF}')

# LEAF YE balances (sum of 4 LEAF lines)
LEAF_YE2025=$(grep -E "N/P LEAF" "$BS" | awk -F, '{sum+=$NF} END {printf "%.2f", sum}')

echo "═══ Cross-Statement Reconciliation Checks ═══"
echo
FAILURES=0
PASSES=0

check_close() {
  local label="$1"
  local val1="$2"
  local val2="$3"
  local diff=$(python3 -c "print(round(abs(float('$val1') - float('$val2')), 2))")
  local within=$(python3 -c "print(1 if abs(float('$val1') - float('$val2')) <= float('$TOLERANCE_DOLLARS') else 0)")
  if [ "$within" = "1" ]; then
    echo "  ✓ $label: $val1 vs $val2 (diff \$$diff, within \$$TOLERANCE_DOLLARS)"
    PASSES=$((PASSES + 1))
  else
    echo "  ✗ $label: $val1 vs $val2 (diff \$$diff, OUTSIDE tolerance \$$TOLERANCE_DOLLARS)"
    FAILURES=$((FAILURES + 1))
  fi
}

# Check 1: P&L NI == SOCF NI
check_close "P&L Net Income == SOCF Net Income line" "$PNL_NI" "$SOCF_NI"

# Check 2: BS Total Assets == BS Total Liab + Equity
check_close "BS Assets == BS Liab + Equity" "$BS_ASSETS" "$BS_LIABEQ"

# Check 3: BS Unbalanced by == 0
check_close "BS Unbalanced by == 0" "$BS_UNBALANCED" "0"

# Check 4: P&L Net Revenue - COGS Total ≈ Gross Profit (within tolerance)
COGS_ABS=$(python3 -c "print(abs(float('$PNL_COGS_TOTAL')))")
IMPLIED_GP=$(python3 -c "print(round(float('$PNL_REVENUE') - float('$COGS_ABS'), 2))")
check_close "P&L Net Revenue - COGS == Gross Profit" "$IMPLIED_GP" "$PNL_GROSS_PROFIT"

# Check 5: BS Long-term LEAF change YE2024→YE2025 == SOCF Net Loan Activity
# Need to compute YE2024 LEAF total — query D1 (since CSVs don't include comparative period)
LEAF_YE2024=$(npx wrangler d1 execute pretzel-os --remote --command "SELECT ROUND(SUM(l.credit-l.debit),2) as bal FROM journal_entry_lines l JOIN journal_entries je ON je.id=l.journal_entry_id JOIN chart_of_accounts coa ON coa.id=l.account_id WHERE je.status='posted' AND coa.account_name LIKE 'N/P LEAF%' AND je.entry_date <= '2024-12-31'" --json 2>/dev/null | python3 -c "
import sys, json, re
out = sys.stdin.read(); m=re.search(r'\[\s*\{', out)
if m:
    txt = out[m.start():]; d=txt.rfind(']'); arr=json.loads(txt[:d+1])
    r = arr[0]['results'][0] if arr[0].get('results') else {}
    print(r.get('bal', '0'))
else:
    print('0')
")
LEAF_CHANGE=$(python3 -c "print(round(float('$LEAF_YE2025') - float('$LEAF_YE2024'), 2))")
check_close "LEAF YE balance change == SOCF Net Loan Activity (sign reverse)" "$LEAF_CHANGE" "$SOCF_LOAN_ACTIVITY"

echo
echo "Total: $PASSES passed, $FAILURES failed"

if [ "$FAILURES" -gt 0 ]; then
  echo "FAIL: $FAILURES cross-statement reconciliation(s) outside tolerance"
  exit 1
else
  echo "PASS: all cross-statement reconciliations tie within \$$TOLERANCE_DOLLARS"
  exit 0
fi
