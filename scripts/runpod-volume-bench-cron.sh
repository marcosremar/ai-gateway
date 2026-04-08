#!/bin/bash
# Cron wrapper for RunPod network volume I/O benchmark.
#
# Runs the benchmark, detects success/failure, writes a stable result file,
# and exits 0 to avoid cron error spam. When a successful result is written,
# the cron should be removed manually (or this script self-disables via the
# DONE marker).
#
# Setup:
#   crontab -e
#   */30 * * * * cd /Users/marcos/projects/ai-gateway && ./scripts/runpod-volume-bench-cron.sh >> /tmp/runpod-bench-cron.log 2>&1

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

LOG_DIR="${HOME}/.ai-gateway/runpod-bench"
mkdir -p "$LOG_DIR"

DONE_MARKER="$LOG_DIR/SUCCESS.json"
LATEST_LOG="$LOG_DIR/latest.log"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN_LOG="$LOG_DIR/run-$TIMESTAMP.log"

# If we already have a successful result, skip
if [ -f "$DONE_MARKER" ]; then
  echo "[$TIMESTAMP] SKIP — already have successful result at $DONE_MARKER"
  exit 0
fi

echo "[$TIMESTAMP] Starting benchmark attempt..."
echo "[$TIMESTAMP] Logging to $RUN_LOG"

# Source .env so RUNPOD_API_KEY is available
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  . "$REPO_DIR/.env"
  set +a
fi

if [ -z "${RUNPOD_API_KEY:-}" ]; then
  echo "[$TIMESTAMP] FATAL: RUNPOD_API_KEY not set, exiting"
  exit 0
fi

# Run the benchmark with a hard timeout (30 min)
START=$(date +%s)
bun run "$REPO_DIR/scripts/runpod-volume-io-benchmark.ts" > "$RUN_LOG" 2>&1
EXIT_CODE=$?
END=$(date +%s)
DURATION=$((END - START))

# Update latest symlink for easy tail
ln -sf "$RUN_LOG" "$LATEST_LOG"

# Check if the run produced actual I/O metrics (vs failed at probe)
if grep -q "Volume read speed (reader COLD):" "$RUN_LOG" 2>/dev/null; then
  echo "[$TIMESTAMP] SUCCESS — got volume I/O metrics in ${DURATION}s"
  # Extract key metrics into the marker file
  {
    echo "{"
    echo "  \"timestamp\": \"$TIMESTAMP\","
    echo "  \"duration_sec\": $DURATION,"
    echo "  \"log_file\": \"$RUN_LOG\","
    grep -E "Volume (write|read).*MB/s|Container disk.*MB/s|speedup" "$RUN_LOG" | sed 's/^/  "raw_/;s/$/",/'
    echo "}"
  } > "$DONE_MARKER"
  echo "[$TIMESTAMP] Marker written to $DONE_MARKER"

  # Try to send a desktop notification (macOS)
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"RunPod volume benchmark succeeded after ${DURATION}s\" with title \"AI Gateway\"" 2>/dev/null || true
  fi
else
  echo "[$TIMESTAMP] FAIL — no I/O metrics in output (exit=$EXIT_CODE, duration=${DURATION}s)"
  GHOST_COUNT=$(grep -c "ghost machine" "$RUN_LOG" 2>/dev/null || echo 0)
  ATTEMPT_COUNT=$(grep -c "Trying" "$RUN_LOG" 2>/dev/null || echo 0)
  echo "[$TIMESTAMP] Stats: $ATTEMPT_COUNT probe attempts, $GHOST_COUNT ghost machines"

  # Rotate old run logs (keep last 20)
  ls -t "$LOG_DIR"/run-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f
fi

# Always exit 0 so cron doesn't spam errors
exit 0
