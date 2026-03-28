#!/bin/bash
# Toast Data Backfill — uploads local TSV/CSV files to Pretzel OS
#
# Usage:
#   ./scripts/toast-backfill.sh                          # All TSV files in default dir
#   ./scripts/toast-backfill.sh /path/to/toast/files     # Custom directory
#   ./scripts/toast-backfill.sh /path/to/single-file.tsv # Single file
#
# Supports:
#   - ItemSelectionDetails TSV files (stats-*.tsv)
#   - CheckDetails CSV files (*CheckDetails*.csv)
#   - OrderDetails CSV files (*OrderDetails*.csv)

WORKER_URL="${PRETZEL_OS_URL:-https://pretzel-os.drew-f39.workers.dev}"
DATA_PATH="${1:-/tmp/pos-data/incoming/toast}"

echo "╔══════════════════════════════════════════════════════╗"
echo "║  Dangerous Pretzel Co — Toast Data Backfill         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "Worker: $WORKER_URL"
echo "Source: $DATA_PATH"
echo ""

TOTAL_ORDERS=0
TOTAL_REVENUE=0
FILES_PROCESSED=0

upload_file() {
  local FILE="$1"
  local ENDPOINT="$2"
  local CONTENT_TYPE="$3"
  local BASENAME=$(basename "$FILE")

  echo -n "  ⏳ $BASENAME → $ENDPOINT ... "
  RESULT=$(curl -s -X POST "${WORKER_URL}${ENDPOINT}" \
    -H "Content-Type: ${CONTENT_TYPE}" \
    --data-binary @"$FILE" \
    --max-time 120)

  # Parse result
  INSERTED=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('orders_inserted', d.get('orders_updated', 0)))" 2>/dev/null || echo "?")
  REV=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('total_revenue', 0))" 2>/dev/null || echo "0")

  echo "✅ $INSERTED orders, \$$REV"
  FILES_PROCESSED=$((FILES_PROCESSED + 1))
}

if [ -f "$DATA_PATH" ]; then
  # Single file mode
  case "$DATA_PATH" in
    *CheckDetails*) upload_file "$DATA_PATH" "/account/toast-checks" "text/csv" ;;
    *OrderDetails*) upload_file "$DATA_PATH" "/account/toast-orders" "text/csv" ;;
    *)              upload_file "$DATA_PATH" "/account/toast-upload" "text/tab-separated-values" ;;
  esac
else
  # Directory mode — process all files
  echo "── ItemSelectionDetails (TSV) ──────────────────────────"
  for f in "$DATA_PATH"/stats-*.tsv; do
    [ -f "$f" ] || continue
    upload_file "$f" "/account/toast-upload" "text/tab-separated-values"
  done

  echo ""
  echo "── CheckDetails (CSV) ──────────────────────────────────"
  for f in "$DATA_PATH"/*CheckDetails*.csv; do
    [ -f "$f" ] || continue
    upload_file "$f" "/account/toast-checks" "text/csv"
  done

  echo ""
  echo "── OrderDetails (CSV) ──────────────────────────────────"
  for f in "$DATA_PATH"/*OrderDetails*.csv; do
    [ -f "$f" ] || continue
    upload_file "$f" "/account/toast-orders" "text/csv"
  done
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Files processed: $FILES_PROCESSED"
echo "═══════════════════════════════════════════════════════"
echo ""

# Show final stats
echo "── Current D1 Stats ──"
curl -s "${WORKER_URL}/account/toast-stats" | python3 -m json.tool 2>/dev/null
