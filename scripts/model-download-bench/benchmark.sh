#!/usr/bin/env bash
# ── Model Download Benchmark ─────────────────────────────────────────────────
# Tests multiple download methods to find the fastest for GPU deployments.
#
# Usage:
#   # Run all benchmarks with a test file (~5GB GGUF)
#   ./benchmark.sh
#
#   # Test with a specific file size (MB)
#   FILE_SIZE_MB=1000 ./benchmark.sh
#
#   # Test with a specific HuggingFace model file
#   HF_REPO=bullerwins/translategemma-4b-it-GGUF HF_FILE=translategemma-4b-it-Q8_0.gguf ./benchmark.sh
#
#   # Include B2/R2 tests (requires URLs set)
#   B2_URL=https://f005.backblazeb2.com/file/my-bucket/model.gguf \
#   R2_URL=https://my-r2.r2.dev/model.gguf \
#   ./benchmark.sh
#
# Environment:
#   HF_REPO          — HuggingFace repo (default: bullerwins/translategemma-4b-it-GGUF)
#   HF_FILE          — File within repo (default: translategemma-4b-it-Q8_0.gguf)
#   B2_URL           — Backblaze B2 direct URL for the same model
#   R2_URL           — Cloudflare R2 direct URL for the same model
#   S3_URL           — AWS S3 direct URL for the same model
#   CUSTOM_URL       — Any other URL to test
#   FILE_SIZE_MB     — Generate a test file of this size instead (for synthetic tests)
#   DOWNLOAD_DIR     — Where to download (default: /tmp/bench-downloads)
#   CONNECTIONS       — aria2c connections (default: 16)
#   RUNS             — Number of runs per method (default: 3)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────

HF_REPO="${HF_REPO:-bullerwins/translategemma-4b-it-GGUF}"
HF_FILE="${HF_FILE:-translategemma-4b-it-Q8_0.gguf}"
DOWNLOAD_DIR="${DOWNLOAD_DIR:-/tmp/bench-downloads}"
CONNECTIONS="${CONNECTIONS:-16}"
RUNS="${RUNS:-3}"
RESULTS_FILE="${DOWNLOAD_DIR}/results.csv"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

mkdir -p "$DOWNLOAD_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo -e "${CYAN}[bench]${NC} $*"; }
ok()   { echo -e "${GREEN}[bench]${NC} $*"; }
warn() { echo -e "${YELLOW}[bench]${NC} $*"; }
err()  { echo -e "${RED}[bench]${NC} $*"; }

# Returns elapsed seconds (with decimals) for a command
bench_cmd() {
    local label="$1"
    shift
    local start end elapsed
    start=$(date +%s.%N 2>/dev/null || python3 -c "import time; print(f'{time.time():.3f}')")
    "$@" 2>/dev/null
    local exit_code=$?
    end=$(date +%s.%N 2>/dev/null || python3 -c "import time; print(f'{time.time():.3f}')")
    elapsed=$(python3 -c "print(f'{$end - $start:.2f}')")
    if [ $exit_code -eq 0 ]; then
        ok "$label: ${elapsed}s"
    else
        err "$label: FAILED (exit $exit_code)"
        elapsed="FAILED"
    fi
    echo "$elapsed"
}

# Get file size in bytes
file_size() {
    local f="$1"
    if [ -f "$f" ]; then
        stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0
    else
        echo 0
    fi
}

# Calculate speed in MB/s
calc_speed() {
    local bytes="$1" seconds="$2"
    python3 -c "
b, s = $bytes, float('$seconds')
if s > 0 and b > 0:
    mbps = b / 1024 / 1024 / s
    print(f'{mbps:.1f}')
else:
    print('N/A')
"
}

# Clean download target
clean() {
    rm -f "$DOWNLOAD_DIR/test_model"* 2>/dev/null || true
}

# ── Install deps ─────────────────────────────────────────────────────────────

install_deps() {
    log "Checking/installing benchmark dependencies..."

    # aria2c
    if ! command -v aria2c &>/dev/null; then
        warn "Installing aria2c..."
        if command -v apt-get &>/dev/null; then
            apt-get update -qq && apt-get install -y -qq aria2 2>/dev/null
        elif command -v brew &>/dev/null; then
            brew install aria2 2>/dev/null
        else
            err "Cannot install aria2c — please install manually"
        fi
    fi

    # axel
    if ! command -v axel &>/dev/null; then
        warn "Installing axel..."
        if command -v apt-get &>/dev/null; then
            apt-get install -y -qq axel 2>/dev/null
        elif command -v brew &>/dev/null; then
            brew install axel 2>/dev/null
        fi
    fi

    # hf_xet (Python)
    if ! python3 -c "import hf_xet" &>/dev/null; then
        warn "Installing hf_xet..."
        pip install -q hf_xet huggingface-hub 2>/dev/null
    fi

    # zstd
    if ! command -v zstd &>/dev/null; then
        warn "Installing zstd..."
        if command -v apt-get &>/dev/null; then
            apt-get install -y -qq zstd 2>/dev/null
        elif command -v brew &>/dev/null; then
            brew install zstd 2>/dev/null
        fi
    fi

    ok "Dependencies ready"
}

# ── Resolve HuggingFace URL ──────────────────────────────────────────────────

resolve_hf_url() {
    # Get the CDN URL for the HuggingFace file
    local url="https://huggingface.co/${HF_REPO}/resolve/main/${HF_FILE}"
    # Follow redirects to get the actual CDN URL
    local resolved
    resolved=$(curl -sIL -o /dev/null -w '%{url_effective}' "$url" 2>/dev/null)
    if [ -n "$resolved" ]; then
        echo "$resolved"
    else
        echo "$url"
    fi
}

# ── Benchmark Methods ────────────────────────────────────────────────────────

# 1. HuggingFace Hub (Python, baseline)
bench_hf_hub() {
    log "Testing: HuggingFace Hub (Python, hf_xet=$1)..."
    clean
    local enable_hf="$1"
    local elapsed
    elapsed=$(bench_cmd "HF Hub (hf_xet=$enable_hf)" python3 -c "
import os
os.environ['HF_XET_HIGH_PERFORMANCE'] = '$enable_hf'
os.environ['HF_HOME'] = '$DOWNLOAD_DIR/hf_cache'
from huggingface_hub import hf_hub_download
path = hf_hub_download('$HF_REPO', '$HF_FILE', cache_dir='$DOWNLOAD_DIR/hf_cache')
print(f'Downloaded to: {path}')
")
    # Get size from cache
    local size
    size=$(find "$DOWNLOAD_DIR/hf_cache" -name "$HF_FILE" -exec stat -c%s {} \; 2>/dev/null || \
           find "$DOWNLOAD_DIR/hf_cache" -name "$HF_FILE" -exec stat -f%z {} \; 2>/dev/null || echo 0)
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "hf_hub_transfer_$enable_hf,$elapsed,$speed,$size" >> "$RESULTS_FILE"
    rm -rf "$DOWNLOAD_DIR/hf_cache" 2>/dev/null || true
}

# 2. curl (single connection, baseline HTTP)
bench_curl() {
    local label="$1" url="$2"
    log "Testing: curl — $label..."
    clean
    local outfile="$DOWNLOAD_DIR/test_model"
    local elapsed
    elapsed=$(bench_cmd "curl ($label)" curl -L -o "$outfile" --connect-timeout 10 -# "$url")
    local size
    size=$(file_size "$outfile")
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "curl_${label},$elapsed,$speed,$size" >> "$RESULTS_FILE"
    clean
}

# 3. wget (single connection)
bench_wget() {
    local label="$1" url="$2"
    if ! command -v wget &>/dev/null; then
        warn "wget not available, skipping"
        return
    fi
    log "Testing: wget — $label..."
    clean
    local outfile="$DOWNLOAD_DIR/test_model"
    local elapsed
    elapsed=$(bench_cmd "wget ($label)" wget -q -O "$outfile" --timeout=10 "$url")
    local size
    size=$(file_size "$outfile")
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "wget_${label},$elapsed,$speed,$size" >> "$RESULTS_FILE"
    clean
}

# 4. aria2c (multi-connection)
bench_aria2c() {
    local label="$1" url="$2" conns="${3:-$CONNECTIONS}"
    if ! command -v aria2c &>/dev/null; then
        warn "aria2c not available, skipping"
        return
    fi
    log "Testing: aria2c (${conns} connections) — $label..."
    clean
    local outfile="$DOWNLOAD_DIR/test_model"
    local elapsed
    elapsed=$(bench_cmd "aria2c x${conns} ($label)" aria2c \
        -x "$conns" -s "$conns" -k 10M \
        --file-allocation=none \
        --max-connection-per-server="$conns" \
        --min-split-size=5M \
        -d "$DOWNLOAD_DIR" -o "test_model" \
        --connect-timeout=10 \
        "$url")
    local size
    size=$(file_size "$outfile")
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "aria2c_x${conns}_${label},$elapsed,$speed,$size" >> "$RESULTS_FILE"
    clean
}

# 5. axel (multi-connection alternative)
bench_axel() {
    local label="$1" url="$2" conns="${3:-$CONNECTIONS}"
    if ! command -v axel &>/dev/null; then
        warn "axel not available, skipping"
        return
    fi
    log "Testing: axel (${conns} connections) — $label..."
    clean
    local outfile="$DOWNLOAD_DIR/test_model"
    local elapsed
    elapsed=$(bench_cmd "axel x${conns} ($label)" axel -n "$conns" -o "$outfile" -q "$url")
    local size
    size=$(file_size "$outfile")
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "axel_x${conns}_${label},$elapsed,$speed,$size" >> "$RESULTS_FILE"
    clean
}

# 6. curl + zstd decompression (requires pre-compressed file at URL)
bench_curl_zstd() {
    local label="$1" url="$2"
    log "Testing: curl + zstd decompress — $label..."
    clean
    local outfile="$DOWNLOAD_DIR/test_model"
    local elapsed
    elapsed=$(bench_cmd "curl+zstd ($label)" bash -c "curl -sL '$url' | zstd -d -o '$outfile'")
    local size
    size=$(file_size "$outfile")
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "curl_zstd_${label},$elapsed,$speed,$size" >> "$RESULTS_FILE"
    clean
}

# 7. aria2c + zstd (multi-conn download of compressed file, then decompress)
bench_aria2c_zstd() {
    local label="$1" url="$2" conns="${3:-$CONNECTIONS}"
    if ! command -v aria2c &>/dev/null || ! command -v zstd &>/dev/null; then
        warn "aria2c or zstd not available, skipping"
        return
    fi
    log "Testing: aria2c + zstd — $label..."
    clean
    local compressed="$DOWNLOAD_DIR/test_model.zst"
    local outfile="$DOWNLOAD_DIR/test_model"
    local elapsed
    elapsed=$(bench_cmd "aria2c+zstd x${conns} ($label)" bash -c "
        aria2c -x $conns -s $conns -k 10M \
            --file-allocation=none \
            --max-connection-per-server=$conns \
            -d '$DOWNLOAD_DIR' -o 'test_model.zst' \
            --connect-timeout=10 -q \
            '$url' && \
        zstd -d -o '$outfile' '$compressed' && \
        rm -f '$compressed'
    ")
    local size
    size=$(file_size "$outfile")
    local speed
    speed=$(calc_speed "$size" "$elapsed")
    echo "aria2c_zstd_x${conns}_${label},$elapsed,$speed,$size" >> "$RESULTS_FILE"
    clean
}

# ── System Info ──────────────────────────────────────────────────────────────

print_system_info() {
    echo ""
    echo "============================================================"
    echo "  Model Download Benchmark"
    echo "============================================================"
    echo ""
    echo "Date:     $(date -u '+%Y-%m-%d %H:%M UTC')"
    echo "Host:     $(hostname)"
    echo "OS:       $(uname -s -r)"
    echo "CPU:      $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) cores"
    echo "RAM:      $(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0fGB", $1/1024/1024/1024}')"

    # Network speed test (quick)
    echo -n "Network:  "
    local speed
    speed=$(curl -sL -o /dev/null -w '%{speed_download}' 'https://speed.cloudflare.com/__down?bytes=10000000' 2>/dev/null)
    if [ -n "$speed" ]; then
        python3 -c "print(f'{float($speed)/1024/1024:.1f} MB/s (Cloudflare 10MB test)')"
    else
        echo "unknown"
    fi

    if command -v nvidia-smi &>/dev/null; then
        echo "GPU:      $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
    fi

    echo "Model:    ${HF_REPO}/${HF_FILE}"
    echo "Conns:    ${CONNECTIONS}"
    echo "Runs:     ${RUNS}"
    echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
    print_system_info
    install_deps

    # CSV header
    echo "method,seconds,mb_per_sec,bytes" > "$RESULTS_FILE"

    # Resolve HuggingFace CDN URL
    log "Resolving HuggingFace CDN URL..."
    HF_URL=$(resolve_hf_url)
    log "HF CDN URL: $HF_URL"
    echo ""

    # ── Run benchmarks ───────────────────────────────────────────────────

    for run in $(seq 1 "$RUNS"); do
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  Run $run of $RUNS"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        # --- HuggingFace Hub (Python SDK) ---
        bench_hf_hub "0"     # Without hf_xet
        bench_hf_hub "1"     # With hf_xet

        # --- Direct HTTP from HuggingFace CDN ---
        bench_curl "hf_cdn" "$HF_URL"
        bench_aria2c "hf_cdn" "$HF_URL" 4
        bench_aria2c "hf_cdn" "$HF_URL" 8
        bench_aria2c "hf_cdn" "$HF_URL" 16

        # --- Backblaze B2 ---
        if [ -n "${B2_URL:-}" ]; then
            bench_curl "b2" "$B2_URL"
            bench_aria2c "b2" "$B2_URL" 4
            bench_aria2c "b2" "$B2_URL" 16

            # Compressed version (append .zst)
            if [ -n "${B2_URL_ZST:-}" ]; then
                bench_curl_zstd "b2" "$B2_URL_ZST"
                bench_aria2c_zstd "b2" "$B2_URL_ZST" 16
            fi
        fi

        # --- Cloudflare R2 ---
        if [ -n "${R2_URL:-}" ]; then
            bench_curl "r2" "$R2_URL"
            bench_aria2c "r2" "$R2_URL" 4
            bench_aria2c "r2" "$R2_URL" 16

            if [ -n "${R2_URL_ZST:-}" ]; then
                bench_curl_zstd "r2" "$R2_URL_ZST"
                bench_aria2c_zstd "r2" "$R2_URL_ZST" 16
            fi
        fi

        # --- AWS S3 ---
        if [ -n "${S3_URL:-}" ]; then
            bench_curl "s3" "$S3_URL"
            bench_aria2c "s3" "$S3_URL" 16
        fi

        # --- Custom URL ---
        if [ -n "${CUSTOM_URL:-}" ]; then
            bench_curl "custom" "$CUSTOM_URL"
            bench_aria2c "custom" "$CUSTOM_URL" 16
        fi

        # --- axel comparison (HF CDN) ---
        bench_axel "hf_cdn" "$HF_URL" 16
    done

    # ── Results Summary ──────────────────────────────────────────────────

    echo ""
    echo "============================================================"
    echo "  RESULTS SUMMARY"
    echo "============================================================"
    echo ""

    python3 << 'PYEOF'
import csv
from collections import defaultdict

results = defaultdict(list)

with open("RESULTS_FILE_PLACEHOLDER", "r") as f:
    reader = csv.DictReader(f)
    for row in reader:
        method = row["method"]
        try:
            secs = float(row["seconds"])
            mbps = float(row["mb_per_sec"])
            results[method].append((secs, mbps))
        except (ValueError, KeyError):
            results[method].append((None, None))

print(f"{'Method':<40} {'Avg Time':>10} {'Avg MB/s':>10} {'Best MB/s':>10} {'Runs':>5}")
print("─" * 80)

sorted_methods = sorted(results.items(), key=lambda x: (
    min(s for s, _ in x[1] if s is not None) if any(s for s, _ in x[1] if s is not None) else 99999
))

for method, runs in sorted_methods:
    valid = [(s, m) for s, m in runs if s is not None]
    if not valid:
        print(f"{method:<40} {'FAILED':>10}")
        continue
    avg_secs = sum(s for s, _ in valid) / len(valid)
    avg_mbps = sum(m for _, m in valid) / len(valid)
    best_mbps = max(m for _, m in valid)
    print(f"{method:<40} {avg_secs:>9.1f}s {avg_mbps:>9.1f} {best_mbps:>9.1f} {len(valid):>5}")

print()
best = sorted_methods[0] if sorted_methods else None
if best:
    avg = sum(s for s, _ in best[1] if s is not None) / len([s for s, _ in best[1] if s is not None])
    print(f"🏆 Fastest: {best[0]} ({avg:.1f}s avg)")
PYEOF

    echo ""
    echo "Raw results: $RESULTS_FILE"
    echo ""
}

# Replace placeholder in Python script
export RESULTS_FILE
sed_safe_results=$(echo "$RESULTS_FILE" | sed 's/[&/\]/\\&/g')
# Actually, just use env var in Python
main 2>&1 | sed "s|RESULTS_FILE_PLACEHOLDER|$RESULTS_FILE|g"
