#!/usr/bin/env bash
# ── Quick Model Download Benchmark ───────────────────────────────────────────
# Tests download methods with the actual GGUF model (~5GB) or a smaller test.
# Runs locally (macOS/Linux) — no GPU needed.
#
# Usage:
#   ./quick-bench.sh              # Full 5GB GGUF benchmark
#   ./quick-bench.sh --small      # Quick test with ~100MB file
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SMALL_MODE=0
[[ "${1:-}" == "--small" ]] && SMALL_MODE=1

# Config
if [ "$SMALL_MODE" = "1" ]; then
    HF_REPO="Systran/faster-whisper-large-v3-turbo"
    HF_FILE="model.bin"
    LABEL="Whisper model.bin (~1.5GB)"
else
    HF_REPO="bullerwins/translategemma-4b-it-GGUF"
    HF_FILE="translategemma-4b-it-Q8_0.gguf"
    LABEL="TranslateGemma Q8 GGUF (~5GB)"
fi

DL_DIR="/tmp/model-bench-$$"
RESULTS=()
mkdir -p "$DL_DIR"
trap "rm -rf $DL_DIR" EXIT

# Colors
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' C='\033[0;36m' B='\033[1m' N='\033[0m'

echo ""
echo -e "${B}════════════════════════════════════════════════════════════${N}"
echo -e "${B}  Model Download Benchmark${N}"
echo -e "${B}════════════════════════════════════════════════════════════${N}"
echo ""
echo -e "  Model:    ${C}$LABEL${N}"
echo -e "  Host:     $(hostname)"
echo -e "  Date:     $(date -u '+%Y-%m-%d %H:%M UTC')"
echo ""

# Network baseline
echo -ne "  Network:  "
SPEED=$(curl -sL -o /dev/null -w '%{speed_download}' 'https://speed.cloudflare.com/__down?bytes=25000000' 2>/dev/null || echo "0")
NET_MBPS=$(python3 -c "print(f'{float($SPEED)/1024/1024:.1f}')")
echo -e "${C}${NET_MBPS} MB/s${N} (Cloudflare 25MB test)"
echo ""

# Resolve HF CDN URL
echo -ne "  Resolving HuggingFace CDN URL... "
HF_URL=$(curl -sIL -o /dev/null -w '%{url_effective}' "https://huggingface.co/${HF_REPO}/resolve/main/${HF_FILE}" 2>/dev/null)
echo -e "${G}OK${N}"
echo -e "  CDN: ${HF_URL:0:80}..."
echo ""

# ── Benchmark function ───────────────────────────────────────────────────────

bench() {
    local method="$1" desc="$2"
    shift 2

    echo -e "${C}━━━ $method${N} — $desc"
    echo -ne "  Running... "

    local outfile="$DL_DIR/model_$$"
    rm -f "$outfile"* 2>/dev/null

    local start end elapsed size speed
    start=$(python3 -c "import time; print(f'{time.time():.6f}')")

    if "$@" >/dev/null 2>&1; then
        end=$(python3 -c "import time; print(f'{time.time():.6f}')")
        elapsed=$(python3 -c "print(f'{$end - $start:.2f}')")

        # Find the downloaded file
        size=0
        for f in "$outfile" "$DL_DIR/model_$$" "$DL_DIR/$HF_FILE" "$DL_DIR/hf_cache"; do
            if [ -f "$f" ]; then
                size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)
                break
            fi
        done
        # Check HF cache
        if [ "$size" = "0" ] && [ -d "$DL_DIR/hf_cache" ]; then
            size=$(find "$DL_DIR/hf_cache" -name "$HF_FILE" -exec stat -f%z {} \; 2>/dev/null | head -1 || echo 0)
        fi

        speed=$(python3 -c "
s=$size; t=float($elapsed)
print(f'{s/1024/1024/t:.1f}' if t > 0 and s > 0 else 'N/A')
")
        local size_mb=$(python3 -c "print(f'{$size/1024/1024:.0f}')")

        echo -e "${G}${elapsed}s${N} — ${B}${speed} MB/s${N} (${size_mb} MB)"
        RESULTS+=("$method|$elapsed|$speed|$size")
    else
        end=$(python3 -c "import time; print(f'{time.time():.6f}')")
        elapsed=$(python3 -c "print(f'{$end - $start:.2f}')")
        echo -e "${R}FAILED${N} (${elapsed}s)"
        RESULTS+=("$method|FAILED|0|0")
    fi

    # Cleanup
    rm -f "$outfile"* 2>/dev/null
    rm -rf "$DL_DIR/hf_cache" 2>/dev/null
    echo ""
}

# ── Run Tests ────────────────────────────────────────────────────────────────

echo -e "${B}── Starting benchmarks ──${N}"
echo ""

# Test 1: HuggingFace Hub (no hf_xet)
bench "hf_hub_plain" "HuggingFace Hub SDK (requests, single stream)" \
    python3 -c "
import os; os.environ['HF_XET_HIGH_PERFORMANCE']='0'; os.environ['HF_HOME']='$DL_DIR/hf_cache'
from huggingface_hub import hf_hub_download
hf_hub_download('$HF_REPO', '$HF_FILE', cache_dir='$DL_DIR/hf_cache')
"

# Test 2: HuggingFace Hub (hf_xet)
bench "hf_hub_transfer" "HuggingFace Hub SDK (hf_xet, Rust multi-stream)" \
    python3 -c "
import os; os.environ['HF_XET_HIGH_PERFORMANCE']='1'; os.environ['HF_HOME']='$DL_DIR/hf_cache'
from huggingface_hub import hf_hub_download
hf_hub_download('$HF_REPO', '$HF_FILE', cache_dir='$DL_DIR/hf_cache')
"

# Test 3: curl (single connection)
bench "curl_single" "curl (single TCP connection)" \
    curl -L -o "$DL_DIR/model_$$" -s "$HF_URL"

# Test 4: aria2c x1 (baseline)
if command -v aria2c &>/dev/null; then
    bench "aria2c_x1" "aria2c (1 connection — same as curl)" \
        aria2c -x1 -s1 --file-allocation=none \
            -d "$DL_DIR" -o "model_$$" -q "$HF_URL"

    # Test 5: aria2c x4
    bench "aria2c_x4" "aria2c (4 connections)" \
        aria2c -x4 -s4 -k10M --file-allocation=none \
            --max-connection-per-server=4 \
            -d "$DL_DIR" -o "model_$$" -q "$HF_URL"

    # Test 6: aria2c x8
    bench "aria2c_x8" "aria2c (8 connections)" \
        aria2c -x8 -s8 -k10M --file-allocation=none \
            --max-connection-per-server=8 \
            -d "$DL_DIR" -o "model_$$" -q "$HF_URL"

    # Test 7: aria2c x16
    bench "aria2c_x16" "aria2c (16 connections)" \
        aria2c -x16 -s16 -k10M --file-allocation=none \
            --max-connection-per-server=16 --min-split-size=5M \
            -d "$DL_DIR" -o "model_$$" -q "$HF_URL"

    # Test 8: aria2c x16 + split 32
    bench "aria2c_x16_s32" "aria2c (16 conn, 32 splits, 1M chunks)" \
        aria2c -x16 -s32 -k1M --file-allocation=none \
            --max-connection-per-server=16 --min-split-size=1M \
            -d "$DL_DIR" -o "model_$$" -q "$HF_URL"
fi

# Test 9: B2 (if URL provided)
if [ -n "${B2_URL:-}" ]; then
    bench "curl_b2" "curl from Backblaze B2" \
        curl -L -o "$DL_DIR/model_$$" -s "$B2_URL"

    if command -v aria2c &>/dev/null; then
        bench "aria2c_x16_b2" "aria2c x16 from Backblaze B2" \
            aria2c -x16 -s16 -k10M --file-allocation=none \
                --max-connection-per-server=16 \
                -d "$DL_DIR" -o "model_$$" -q "$B2_URL"
    fi
fi

# Test 10: R2 (if URL provided)
if [ -n "${R2_URL:-}" ]; then
    bench "curl_r2" "curl from Cloudflare R2" \
        curl -L -o "$DL_DIR/model_$$" -s "$R2_URL"

    if command -v aria2c &>/dev/null; then
        bench "aria2c_x16_r2" "aria2c x16 from Cloudflare R2" \
            aria2c -x16 -s16 -k10M --file-allocation=none \
                --max-connection-per-server=16 \
                -d "$DL_DIR" -o "model_$$" -q "$R2_URL"
    fi
fi

# ── Results ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${B}════════════════════════════════════════════════════════════${N}"
echo -e "${B}  RESULTS${N}"
echo -e "${B}════════════════════════════════════════════════════════════${N}"
echo ""

# Sort by speed and display
python3 << PYEOF
results = [
$(for r in "${RESULTS[@]}"; do
    IFS='|' read -r method secs speed size <<< "$r"
    echo "    ('$method', '$secs', '$speed', '$size'),"
done)
]

valid = [(m, float(s), float(sp), int(sz)) for m, s, sp, sz in results if s != 'FAILED']
valid.sort(key=lambda x: x[1])

print(f"{'Rank':<5} {'Method':<25} {'Time':>10} {'Speed':>12} {'vs Best':>10}")
print("─" * 65)

best_time = valid[0][1] if valid else 1
for i, (method, secs, speed, size) in enumerate(valid, 1):
    ratio = secs / best_time
    marker = " ← WINNER" if i == 1 else ""
    bar = "█" * max(1, int(30 * best_time / secs))
    print(f"{i:<5} {method:<25} {secs:>9.1f}s {speed:>10.1f} MB/s {ratio:>8.1f}x  {bar}{marker}")

failed = [(m, s) for m, s, sp, sz in results if s == 'FAILED']
if failed:
    print()
    for m, _ in failed:
        print(f"  ✗ {m}: FAILED")

if valid:
    best = valid[0]
    worst = valid[-1]
    speedup = worst[1] / best[1]
    print()
    print(f"Winner:  {best[0]} ({best[2]:.0f} MB/s)")
    print(f"Speedup: {speedup:.1f}x faster than slowest ({worst[0]})")

    # Estimate boot time savings for real models
    print()
    print("── Estimated boot time impact ──")
    models = [
        ("Whisper large-v3-turbo", 3 * 1024),
        ("TranslateGemma Q8 GGUF", 5 * 1024),
        ("Ultravox 8B", 16 * 1024),
        ("FLUX.1-dev fp16", 24 * 1024),
    ]
    slow_speed = valid[-1][2]  # worst MB/s
    fast_speed = valid[0][2]   # best MB/s
    print(f"{'Model':<30} {'Slow ({valid[-1][0]})':>20} {'Fast ({valid[0][0]})':>20} {'Saved':>10}")
    print("─" * 85)
    for name, size_mb in models:
        slow_time = size_mb / slow_speed if slow_speed > 0 else 999
        fast_time = size_mb / fast_speed if fast_speed > 0 else 999
        saved = slow_time - fast_time
        print(f"{name:<30} {slow_time:>18.0f}s {fast_time:>18.0f}s {saved:>8.0f}s")
PYEOF

echo ""
