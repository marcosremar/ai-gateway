#!/bin/bash
# Raw I/O benchmark for RunPod network volume.
# Runs inside a pod with /workspace mounted from the volume.
# Writes results to /workspace/bench/results.json AND stdout, then serves
# them via python3 -m http.server :8000 so the orchestrator can fetch them.
#
# Env vars:
#   BENCH_ROLE — "writer" (creates the test file) or "reader" (expects existing file)
#   BENCH_SIZE_GB — file size in GB (default 10)

set -e

mkdir -p /workspace/bench
RESULTS=/workspace/bench/results.json
ROLE="${BENCH_ROLE:-writer}"
SIZE_GB="${BENCH_SIZE_GB:-10}"
SIZE_MB=$((SIZE_GB * 1024))
TEST_FILE=/workspace/bench/test${SIZE_GB}gb.bin

echo "==> Bench role: $ROLE, file size: ${SIZE_GB}GB"
echo "==> uname: $(uname -a)"
echo "==> df -h /workspace:"
df -h /workspace || true

WRITE_MBPS=null
WRITE_SEC=null

# ── Phase 1: Write (only if file doesn't exist) ──────────────────────────
if [ -f "$TEST_FILE" ]; then
  EXISTING_SIZE=$(stat -c%s "$TEST_FILE" 2>/dev/null || echo 0)
  echo "==> Existing test file: $EXISTING_SIZE bytes"
else
  if [ "$ROLE" = "reader" ]; then
    echo "ERROR: reader role but $TEST_FILE does not exist"
    exit 1
  fi
  echo "==> Phase 1: write ${SIZE_GB}GB to volume..."
  WRITE_START=$(date +%s.%N)
  dd if=/dev/urandom of=$TEST_FILE bs=1M count=$SIZE_MB conv=fdatasync status=progress 2>&1 | tail -3
  WRITE_END=$(date +%s.%N)
  WRITE_SEC=$(awk "BEGIN {printf \"%.2f\", $WRITE_END - $WRITE_START}")
  WRITE_MBPS=$(awk "BEGIN {printf \"%.0f\", $SIZE_MB / $WRITE_SEC}")
  echo "WRITE: ${WRITE_MBPS} MB/s (${WRITE_SEC} sec)"
fi

# ── Drop page cache so the read is from disk, not RAM ───────────────────
sync
if echo 3 > /proc/sys/vm/drop_caches 2>/dev/null; then
  echo "==> page cache dropped"
else
  echo "==> WARN: could not drop caches (need root)"
fi

# ── Phase 2: Read 10GB from volume ──────────────────────────────────────
echo "==> Phase 2: read ${SIZE_GB}GB from volume..."
READ_START=$(date +%s.%N)
dd if=$TEST_FILE of=/dev/null bs=1M status=progress 2>&1 | tail -3
READ_END=$(date +%s.%N)
READ_SEC=$(awk "BEGIN {printf \"%.2f\", $READ_END - $READ_START}")
READ_MBPS=$(awk "BEGIN {printf \"%.0f\", $SIZE_MB / $READ_SEC}")
echo "READ:  ${READ_MBPS} MB/s (${READ_SEC} sec)"

# ── Phase 3: Container disk for comparison ──────────────────────────────
echo "==> Phase 3: container disk write+read for comparison..."
CW_START=$(date +%s.%N)
dd if=/dev/zero of=/tmp/test${SIZE_GB}gb.bin bs=1M count=$SIZE_MB conv=fdatasync 2>&1 | tail -1
CW_END=$(date +%s.%N)
CW_SEC=$(awk "BEGIN {printf \"%.2f\", $CW_END - $CW_START}")
CW_MBPS=$(awk "BEGIN {printf \"%.0f\", $SIZE_MB / $CW_SEC}")

sync
echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true

CR_START=$(date +%s.%N)
dd if=/tmp/test${SIZE_GB}gb.bin of=/dev/null bs=1M 2>&1 | tail -1
CR_END=$(date +%s.%N)
CR_SEC=$(awk "BEGIN {printf \"%.2f\", $CR_END - $CR_START}")
CR_MBPS=$(awk "BEGIN {printf \"%.0f\", $SIZE_MB / $CR_SEC}")
rm -f /tmp/test${SIZE_GB}gb.bin
echo "CONTAINER WRITE: ${CW_MBPS} MB/s, READ: ${CR_MBPS} MB/s"

# ── Write results JSON ──────────────────────────────────────────────────
cat > $RESULTS <<EOF
{
  "role": "$ROLE",
  "size_gb": $SIZE_GB,
  "volume_write_mbps": $WRITE_MBPS,
  "volume_write_sec": $WRITE_SEC,
  "volume_read_mbps": $READ_MBPS,
  "volume_read_sec": $READ_SEC,
  "container_write_mbps": $CW_MBPS,
  "container_write_sec": $CW_SEC,
  "container_read_mbps": $CR_MBPS,
  "container_read_sec": $CR_SEC,
  "timestamp": "$(date -Iseconds 2>/dev/null || date)"
}
EOF

echo "=== RESULTS ==="
cat $RESULTS
echo ""
echo "==> Serving results on :8000..."
cd /workspace/bench
exec python3 -m http.server 8000
