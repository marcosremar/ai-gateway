#!/usr/bin/env bash
# ── Vast.ai Model Download Benchmark Runner ──────────────────────────────────
# Deploys a lightweight container to Vast.ai, runs the download benchmark,
# and reports results.
#
# Pre-requisites:
#   pip install vastai
#   export VAST_API_KEY=<your-key>
#
# Usage:
#   ./vast-benchmark.sh                    # Auto-pick cheapest GPU
#   ./vast-benchmark.sh --gpu "RTX 4090"   # Specific GPU type
#   ./vast-benchmark.sh --region EU        # Prefer EU datacenter
#
# Environment:
#   VAST_API_KEY       — Vast.ai API key
#   B2_URL             — Backblaze B2 model URL (optional)
#   R2_URL             — Cloudflare R2 model URL (optional)
#   CUSTOM_URL         — Custom URL to benchmark (optional)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

GPU_TYPE="${GPU_TYPE:-}"
REGION="${REGION:-}"
MAX_PRICE="${MAX_PRICE:-0.30}"  # $/hr max

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${CYAN}[vast-bench]${NC} $*"; }
ok()   { echo -e "${GREEN}[vast-bench]${NC} $*"; }
warn() { echo -e "${YELLOW}[vast-bench]${NC} $*"; }
err()  { echo -e "${RED}[vast-bench]${NC} $*" >&2; }

# Parse args
while [[ $# -gt 0 ]]; do
    case $1 in
        --gpu)    GPU_TYPE="$2"; shift 2 ;;
        --region) REGION="$2"; shift 2 ;;
        --price)  MAX_PRICE="$2"; shift 2 ;;
        *) err "Unknown arg: $1"; exit 1 ;;
    esac
done

# Check vastai CLI
if ! command -v vastai &>/dev/null; then
    warn "Installing vastai CLI..."
    pip install -q vastai
fi

# ── Create the benchmark script to run inside the container ──────────────────

BENCH_SCRIPT=$(cat << 'INNEREOF'
#!/bin/bash
set -e

echo "============================================================"
echo "  Vast.ai Model Download Benchmark"
echo "============================================================"
echo ""
echo "Host: $(hostname)"
echo "GPU:  $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'N/A')"
echo "CPU:  $(nproc) cores"
echo "RAM:  $(free -h | awk '/^Mem:/{print $2}')"
echo "Disk: $(df -h / | awk 'NR==2{print $2, "total,", $4, "free"}')"
echo ""

# Install deps
apt-get update -qq && apt-get install -y -qq aria2 axel zstd python3-pip curl wget >/dev/null 2>&1
pip install -q huggingface-hub hf_transfer 2>/dev/null

HF_REPO="bullerwins/translategemma-4b-it-GGUF"
HF_FILE="translategemma-4b-it-Q8_0.gguf"
DL_DIR="/tmp/bench"
RESULTS="/tmp/results.csv"

mkdir -p "$DL_DIR"
echo "method,seconds,mb_per_sec,file_bytes" > "$RESULTS"

# Resolve HF URL
HF_URL=$(curl -sIL -o /dev/null -w '%{url_effective}' "https://huggingface.co/${HF_REPO}/resolve/main/${HF_FILE}")
echo "HF CDN URL: $HF_URL"
echo ""

bench() {
    local method="$1"
    shift
    echo -n "  $method ... "
    local start end elapsed
    start=$(date +%s.%N)
    "$@" >/dev/null 2>&1
    local rc=$?
    end=$(date +%s.%N)
    elapsed=$(python3 -c "print(f'{$end - $start:.2f}')")

    if [ $rc -eq 0 ]; then
        local size=$(stat -c%s "$DL_DIR/model" 2>/dev/null || echo 0)
        local speed=$(python3 -c "print(f'{$size / 1024 / 1024 / float($elapsed):.1f}')")
        echo "${elapsed}s (${speed} MB/s)"
        echo "$method,$elapsed,$speed,$size" >> "$RESULTS"
    else
        echo "FAILED"
        echo "$method,FAILED,0,0" >> "$RESULTS"
    fi
    rm -f "$DL_DIR/model"* 2>/dev/null
}

echo "── Test 1: HuggingFace Hub (no hf_transfer) ──"
bench "hf_hub_no_transfer" python3 -c "
import os; os.environ['HF_HUB_ENABLE_HF_TRANSFER']='0'; os.environ['HF_HOME']='$DL_DIR/hf'
from huggingface_hub import hf_hub_download
import shutil
p = hf_hub_download('$HF_REPO', '$HF_FILE', cache_dir='$DL_DIR/hf')
shutil.copy2(p, '$DL_DIR/model')
"
rm -rf "$DL_DIR/hf" 2>/dev/null

echo "── Test 2: HuggingFace Hub (hf_transfer=1) ──"
bench "hf_hub_hf_transfer" python3 -c "
import os; os.environ['HF_HUB_ENABLE_HF_TRANSFER']='1'; os.environ['HF_HOME']='$DL_DIR/hf'
from huggingface_hub import hf_hub_download
import shutil
p = hf_hub_download('$HF_REPO', '$HF_FILE', cache_dir='$DL_DIR/hf')
shutil.copy2(p, '$DL_DIR/model')
"
rm -rf "$DL_DIR/hf" 2>/dev/null

echo "── Test 3: curl (single connection, HF CDN) ──"
bench "curl_hf" curl -L -o "$DL_DIR/model" "$HF_URL"

echo "── Test 4: wget (single connection, HF CDN) ──"
bench "wget_hf" wget -q -O "$DL_DIR/model" "$HF_URL"

echo "── Test 5: aria2c x4 (HF CDN) ──"
bench "aria2c_x4_hf" aria2c -x4 -s4 -k10M --file-allocation=none -d "$DL_DIR" -o model "$HF_URL"

echo "── Test 6: aria2c x8 (HF CDN) ──"
bench "aria2c_x8_hf" aria2c -x8 -s8 -k10M --file-allocation=none -d "$DL_DIR" -o model "$HF_URL"

echo "── Test 7: aria2c x16 (HF CDN) ──"
bench "aria2c_x16_hf" aria2c -x16 -s16 -k10M --file-allocation=none --max-connection-per-server=16 -d "$DL_DIR" -o model "$HF_URL"

echo "── Test 8: aria2c x32 (HF CDN) ──"
bench "aria2c_x32_hf" aria2c -x16 -s16 -k5M --file-allocation=none --max-connection-per-server=16 --split=32 -d "$DL_DIR" -o model "$HF_URL"

echo "── Test 9: axel x16 (HF CDN) ──"
bench "axel_x16_hf" axel -n 16 -o "$DL_DIR/model" "$HF_URL"

# B2 tests
if [ -n "${B2_URL:-}" ]; then
    echo ""
    echo "── Backblaze B2 Tests ──"
    bench "curl_b2" curl -L -o "$DL_DIR/model" "$B2_URL"
    bench "aria2c_x16_b2" aria2c -x16 -s16 -k10M --file-allocation=none --max-connection-per-server=16 -d "$DL_DIR" -o model "$B2_URL"
fi

# R2 tests
if [ -n "${R2_URL:-}" ]; then
    echo ""
    echo "── Cloudflare R2 Tests ──"
    bench "curl_r2" curl -L -o "$DL_DIR/model" "$R2_URL"
    bench "aria2c_x16_r2" aria2c -x16 -s16 -k10M --file-allocation=none --max-connection-per-server=16 -d "$DL_DIR" -o model "$R2_URL"
fi

# Custom URL tests
if [ -n "${CUSTOM_URL:-}" ]; then
    echo ""
    echo "── Custom URL Tests ──"
    bench "curl_custom" curl -L -o "$DL_DIR/model" "$CUSTOM_URL"
    bench "aria2c_x16_custom" aria2c -x16 -s16 -k10M --file-allocation=none --max-connection-per-server=16 -d "$DL_DIR" -o model "$CUSTOM_URL"
fi

# Network speed baseline
echo ""
echo "── Network Speed Baseline ──"
echo -n "  Cloudflare 25MB test: "
start=$(date +%s.%N)
curl -sL -o /dev/null 'https://speed.cloudflare.com/__down?bytes=25000000'
end=$(date +%s.%N)
speed=$(python3 -c "print(f'{25 / ($end - $start):.1f}')")
echo "${speed} MB/s"

echo -n "  Cloudflare 100MB test: "
start=$(date +%s.%N)
curl -sL -o /dev/null 'https://speed.cloudflare.com/__down?bytes=100000000'
end=$(date +%s.%N)
speed=$(python3 -c "print(f'{100 / ($end - $start):.1f}')")
echo "${speed} MB/s"

# Summary
echo ""
echo "============================================================"
echo "  RESULTS"
echo "============================================================"
echo ""
python3 << 'PYEOF'
import csv

with open("/tmp/results.csv") as f:
    rows = list(csv.DictReader(f))

valid = [r for r in rows if r["seconds"] != "FAILED"]
valid.sort(key=lambda r: float(r["seconds"]))

print(f"{'Rank':<5} {'Method':<30} {'Time':>10} {'Speed':>12}")
print("─" * 60)
for i, r in enumerate(valid, 1):
    print(f"{i:<5} {r['method']:<30} {float(r['seconds']):>9.1f}s {float(r['mb_per_sec']):>10.1f} MB/s")

if valid:
    best = valid[0]
    worst = valid[-1]
    speedup = float(worst["seconds"]) / float(best["seconds"])
    print()
    print(f"Winner: {best['method']} ({float(best['mb_per_sec']):.0f} MB/s)")
    print(f"Speedup vs worst: {speedup:.1f}x faster")
PYEOF

echo ""
echo "Raw CSV: /tmp/results.csv"
INNEREOF

# ── Find a cheap GPU instance ────────────────────────────────────────────────

log "Searching for available Vast.ai instances..."

SEARCH_ARGS="rentable=true disk_space>=20 dph<=${MAX_PRICE} reliability>0.95 inet_down>200"
[ -n "$GPU_TYPE" ] && SEARCH_ARGS="$SEARCH_ARGS gpu_name=\"$GPU_TYPE\""

# Get the cheapest matching offer
OFFER_JSON=$(vastai search offers "$SEARCH_ARGS" --order dph --limit 5 --raw 2>/dev/null || echo "[]")

if [ "$OFFER_JSON" = "[]" ] || [ -z "$OFFER_JSON" ]; then
    err "No matching Vast.ai instances found"
    err "Try: --price 0.50 or different --gpu type"
    exit 1
fi

OFFER_ID=$(echo "$OFFER_JSON" | python3 -c "import json,sys; data=json.load(sys.stdin); print(data[0]['id'])")
OFFER_GPU=$(echo "$OFFER_JSON" | python3 -c "import json,sys; data=json.load(sys.stdin); print(data[0].get('gpu_name','unknown'))")
OFFER_PRICE=$(echo "$OFFER_JSON" | python3 -c "import json,sys; data=json.load(sys.stdin); print(f\"{data[0].get('dph_total',0):.3f}\")")
OFFER_INET=$(echo "$OFFER_JSON" | python3 -c "import json,sys; data=json.load(sys.stdin); print(f\"{data[0].get('inet_down',0):.0f}\")")
OFFER_LOC=$(echo "$OFFER_JSON" | python3 -c "import json,sys; data=json.load(sys.stdin); d=data[0]; print(f\"{d.get('geolocation','unknown')}\")")

log "Selected: $OFFER_GPU @ \$${OFFER_PRICE}/hr (${OFFER_INET} Mbps, $OFFER_LOC)"

# ── Deploy the benchmark ─────────────────────────────────────────────────────

log "Deploying benchmark container..."

# Create a minimal container with the benchmark script
ENV_ARGS=""
[ -n "${B2_URL:-}" ] && ENV_ARGS="$ENV_ARGS -e B2_URL=$B2_URL"
[ -n "${R2_URL:-}" ] && ENV_ARGS="$ENV_ARGS -e R2_URL=$R2_URL"
[ -n "${CUSTOM_URL:-}" ] && ENV_ARGS="$ENV_ARGS -e CUSTOM_URL=$CUSTOM_URL"

INSTANCE_ID=$(vastai create instance "$OFFER_ID" \
    --image nvidia/cuda:12.8.1-runtime-ubuntu22.04 \
    --disk 20 \
    --onstart-cmd "bash -c 'echo READY'" \
    $ENV_ARGS \
    --raw 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('new_contract',''))")

if [ -z "$INSTANCE_ID" ]; then
    err "Failed to create Vast.ai instance"
    exit 1
fi

ok "Instance created: $INSTANCE_ID"
log "Waiting for instance to be ready..."

# Wait for instance to start
for i in $(seq 1 60); do
    STATUS=$(vastai show instance "$INSTANCE_ID" --raw 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('actual_status','unknown'))" 2>/dev/null || echo "unknown")
    if [ "$STATUS" = "running" ]; then
        ok "Instance running!"
        break
    fi
    echo -n "."
    sleep 5
done
echo ""

if [ "$STATUS" != "running" ]; then
    err "Instance failed to start (status: $STATUS)"
    vastai destroy instance "$INSTANCE_ID" 2>/dev/null || true
    exit 1
fi

# Get SSH details
SSH_INFO=$(vastai show instance "$INSTANCE_ID" --raw 2>/dev/null)
SSH_HOST=$(echo "$SSH_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ssh_host',''))")
SSH_PORT=$(echo "$SSH_INFO" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ssh_port',''))")

log "SSH: ssh -p $SSH_PORT root@$SSH_HOST"

# Upload and run benchmark
log "Uploading benchmark script..."
echo "$BENCH_SCRIPT" | ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "root@$SSH_HOST" "cat > /tmp/bench.sh && chmod +x /tmp/bench.sh"

log "Running benchmark (this will take 5-15 minutes)..."
echo ""
ssh -o StrictHostKeyChecking=no -p "$SSH_PORT" "root@$SSH_HOST" \
    "B2_URL='${B2_URL:-}' R2_URL='${R2_URL:-}' CUSTOM_URL='${CUSTOM_URL:-}' bash /tmp/bench.sh"

# Download results
log "Downloading raw results..."
scp -o StrictHostKeyChecking=no -P "$SSH_PORT" "root@$SSH_HOST:/tmp/results.csv" "/tmp/vast-bench-results-$(date +%Y%m%d-%H%M%S).csv" 2>/dev/null || true

# Cleanup
echo ""
log "Destroying instance $INSTANCE_ID..."
vastai destroy instance "$INSTANCE_ID" 2>/dev/null || true
ok "Instance destroyed. Benchmark complete!"
echo ""
echo "Results saved to: /tmp/vast-bench-results-*.csv"
