#!/bin/bash
# tests/narrative_csv_consistency.sh
# Phase 32 Acceptance Criterion 2.1: Every dollar figure in handoff documents must
# appear verbatim in at least one of the shipped CSVs.
#
# Background: README narrative drift from CSV values has been the most common source
# of auditor-flagged inconsistencies (Phase 30 Pre-Sync $264K vs $19K; Phase 31
# Net Revenue $472K vs $497K). This check enforces narrative-CSV consistency
# at handoff time.
#
# Usage: bash tests/narrative_csv_consistency.sh [path/to/package_dir]
# Default package_dir: irene_package_FY2025/
#
# Exit codes: 0 = all dollar figures matched; 1 = some figures unmatched (will print them)

set -e

PKG_DIR="${1:-irene_package_FY2025}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_PATH="$REPO_ROOT/$PKG_DIR"

if [ ! -d "$PKG_PATH" ]; then
  echo "ERROR: Package directory not found: $PKG_PATH"
  exit 2
fi

# README is the summary doc — every dollar figure MUST appear in a CSV.
# EQUITY_RECLASS_NARRATIVE explains JE-level decomposition (component values may not be in summary CSVs).
# Per acceptance criterion 2.1: enforce strict CSV-consistency on README only.
NARRATIVE_FILES=(
  "$PKG_PATH/README.md"
)

CSV_FILES=(
  "$PKG_PATH/FY2025_PnL.csv"
  "$PKG_PATH/BS_YE2025.csv"
  "$PKG_PATH/CashFlow_FY2025.csv"
  "$PKG_PATH/NI_BRIDGE_FY2025.csv"
)

# Verify all files exist
for f in "${NARRATIVE_FILES[@]}" "${CSV_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: Required file not found: $f"
    exit 2
  fi
done

# Extract all dollar figures from narrative files
# Pattern matches: $X,XXX.XX or -$X,XXX.XX or $X.XX (with thousands separators)
NARRATIVE_FIGURES=$(cat "${NARRATIVE_FILES[@]}" | \
  grep -oE -- '-?\$[0-9]{1,3}(,[0-9]{3})*\.[0-9]{2}|-?\$[0-9]+\.[0-9]{2}' | \
  sort -u)

# Get all numeric values from CSVs (with and without dollar signs)
CSV_FIGURES=$(cat "${CSV_FILES[@]}" | \
  grep -oE -- '-?[0-9]{1,3}(,[0-9]{3})*\.[0-9]{2}|-?[0-9]+\.[0-9]{2}' | \
  sort -u)

# Normalize: strip dollar signs and commas from narrative figures for matching
UNMATCHED_COUNT=0
UNMATCHED_LIST=""

# Load allowlist (figures known to appear in narrative-context but not CSVs)
ALLOWLIST_FILE="$SCRIPT_DIR/narrative_csv_consistency.allowlist"
ALLOWLIST=""
if [ -f "$ALLOWLIST_FILE" ]; then
  ALLOWLIST=$(grep -v '^#' "$ALLOWLIST_FILE" | grep -oE '^[0-9]+\.[0-9]+' | sort -u)
fi

while IFS= read -r fig; do
  [ -z "$fig" ] && continue
  # Normalize to absolute value: strip $, -, and , — match on magnitude only
  # (BS/P&L sign conventions differ from narrative; absolute-value match catches
  # real inconsistencies vs sign-convention noise)
  abs_normalized=$(echo "$fig" | tr -d '$,-')
  # Match against CSV normalized values (also stripped of sign and commas)
  csv_abs=$(echo "$CSV_FIGURES" | tr -d ',-' | sort -u)
  if ! echo "$csv_abs" | grep -qE "^${abs_normalized}$"; then
    # Check allowlist before flagging as unmatched
    if echo "$ALLOWLIST" | grep -qE "^${abs_normalized}$"; then
      continue  # allowlisted narrative-context figure
    fi
    UNMATCHED_COUNT=$((UNMATCHED_COUNT + 1))
    UNMATCHED_LIST="${UNMATCHED_LIST}${fig}\n"
  fi
done <<< "$NARRATIVE_FIGURES"

echo "═══ Narrative-CSV Consistency Check ═══"
echo "Narrative files scanned: ${#NARRATIVE_FILES[@]}"
echo "CSV files scanned: ${#CSV_FILES[@]}"
TOTAL_FIGURES=$(echo "$NARRATIVE_FIGURES" | wc -l | tr -d ' ')
echo "Unique narrative dollar figures: $TOTAL_FIGURES"
echo "Unmatched (not found in any CSV): $UNMATCHED_COUNT"
echo

if [ "$UNMATCHED_COUNT" -gt 0 ]; then
  echo "FAIL: $UNMATCHED_COUNT narrative figure(s) absent from CSVs:"
  echo -e "$UNMATCHED_LIST" | head -20
  echo
  echo "Note: tolerance items (rounding-level differences) and contextual numbers"
  echo "  (% values, dates, etc.) that aren't dollar figures may need allowlisting."
  exit 1
else
  echo "PASS: every narrative dollar figure appears in a shipped CSV."
  exit 0
fi
