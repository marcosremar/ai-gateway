#!/usr/bin/env bash
# ── Fast Model Download ──────────────────────────────────────────────────────
# Drop-in replacement for HuggingFace Hub downloads.
# Tries multiple sources in order: B2/R2 CDN → aria2c from HF → hf_xet.
#
# Usage:
#   # Download a GGUF model
#   ./fast-model-download.sh \
#     --repo bullerwins/translategemma-4b-it-GGUF \
#     --file translategemma-4b-it-Q8_0.gguf \
#     --dest /app/models/translategemma.gguf
#
#   # Download with B2 as primary source
#   B2_BASE_URL=https://f005.backblazeb2.com/file/parle-models \
#   ./fast-model-download.sh \
#     --repo bullerwins/translategemma-4b-it-GGUF \
#     --file translategemma-4b-it-Q8_0.gguf \
#     --dest /app/models/translategemma.gguf
#
#   # Download a full HF model directory
#   ./fast-model-download.sh \
#     --repo Systran/faster-whisper-large-v3-turbo \
#     --snapshot \
#     --dest /app/models/whisper-turbo
#
# Environment:
#   B2_BASE_URL       — Backblaze B2 base URL (e.g. https://f005.backblazeb2.com/file/parle-models)
#   R2_BASE_URL       — Cloudflare R2 base URL
#   CDN_BASE_URL      — Any CDN base URL (highest priority)
#   MODEL_CACHE_DIR   — Cache directory (default: /app/.cache/models)
#   CONNECTIONS        — aria2c connections (default: 16)
#   PREFER_COMPRESSED — Set to 1 to try .zst first (default: 0)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

CONNECTIONS="${CONNECTIONS:-16}"
MODEL_CACHE_DIR="${MODEL_CACHE_DIR:-/app/.cache/models}"
PREFER_COMPRESSED="${PREFER_COMPRESSED:-0}"

# Parse args
REPO="" FILE="" DEST="" SNAPSHOT=0
while [[ $# -gt 0 ]]; do
    case $1 in
        --repo)     REPO="$2"; shift 2 ;;
        --file)     FILE="$2"; shift 2 ;;
        --dest)     DEST="$2"; shift 2 ;;
        --snapshot) SNAPSHOT=1; shift ;;
        --connections) CONNECTIONS="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

[ -z "$REPO" ] && { echo "Error: --repo required"; exit 1; }
[ -z "$DEST" ] && { echo "Error: --dest required"; exit 1; }
[ "$SNAPSHOT" = "0" ] && [ -z "$FILE" ] && { echo "Error: --file required (or use --snapshot)"; exit 1; }

log()  { echo "[fast-dl] $*"; }
ok()   { echo "[fast-dl] OK: $*"; }
err()  { echo "[fast-dl] ERROR: $*" >&2; }

mkdir -p "$(dirname "$DEST")"

# ── Method 1: CDN / B2 / R2 with aria2c ─────────────────────────────────────

try_cdn_download() {
    local url="$1" dest="$2"

    # Try compressed version first
    if [ "$PREFER_COMPRESSED" = "1" ] && command -v zstd &>/dev/null; then
        local zst_url="${url}.zst"
        log "Trying compressed: $zst_url"
        if command -v aria2c &>/dev/null; then
            if aria2c -x "$CONNECTIONS" -s "$CONNECTIONS" -k 10M \
                --file-allocation=none \
                --max-connection-per-server="$CONNECTIONS" \
                --min-split-size=5M \
                --connect-timeout=5 --timeout=10 --max-tries=1 \
                -d "$(dirname "$dest")" -o "$(basename "$dest").zst" \
                -q "$zst_url" 2>/dev/null; then
                zstd -d -f "${dest}.zst" -o "$dest" && rm -f "${dest}.zst"
                return 0
            fi
        fi
    fi

    # Try uncompressed
    log "Trying: $url"
    if command -v aria2c &>/dev/null; then
        aria2c -x "$CONNECTIONS" -s "$CONNECTIONS" -k 10M \
            --file-allocation=none \
            --max-connection-per-server="$CONNECTIONS" \
            --min-split-size=5M \
            --connect-timeout=5 --timeout=30 --max-tries=2 \
            -d "$(dirname "$dest")" -o "$(basename "$dest")" \
            -q "$url" 2>/dev/null && return 0
    else
        curl -sL -o "$dest" --connect-timeout 5 --max-time 300 "$url" 2>/dev/null && return 0
    fi
    return 1
}

download_single_file() {
    local repo="$1" file="$2" dest="$3"

    # Check cache first
    if [ -f "$dest" ]; then
        log "Already cached: $dest"
        return 0
    fi

    local cache_path="${MODEL_CACHE_DIR}/${repo}/${file}"
    if [ -f "$cache_path" ]; then
        log "Found in cache: $cache_path"
        mkdir -p "$(dirname "$dest")"
        cp "$cache_path" "$dest"
        return 0
    fi

    # Build URL path from repo/file
    local url_path
    url_path=$(echo "$repo" | tr '/' '_')  # e.g. bullerwins_translategemma-4b-it-GGUF
    # Or use a structured path
    local cdn_path="models/${repo}/${file}"

    # Try CDN sources in priority order
    local sources=()
    [ -n "${CDN_BASE_URL:-}" ] && sources+=("${CDN_BASE_URL}/${cdn_path}")
    [ -n "${R2_BASE_URL:-}" ]  && sources+=("${R2_BASE_URL}/${cdn_path}")
    [ -n "${B2_BASE_URL:-}" ]  && sources+=("${B2_BASE_URL}/${cdn_path}")

    for url in "${sources[@]}"; do
        if try_cdn_download "$url" "$dest"; then
            ok "Downloaded from CDN: $file ($(du -h "$dest" | cut -f1))"
            # Cache it
            mkdir -p "$(dirname "$cache_path")"
            cp "$dest" "$cache_path" 2>/dev/null || true
            return 0
        fi
        log "CDN failed, trying next source..."
    done

    # Fallback: aria2c from HuggingFace CDN
    local hf_url="https://huggingface.co/${repo}/resolve/main/${file}"
    log "Trying HuggingFace CDN with aria2c..."
    if command -v aria2c &>/dev/null; then
        if aria2c -x "$CONNECTIONS" -s "$CONNECTIONS" -k 10M \
            --file-allocation=none \
            --max-connection-per-server="$CONNECTIONS" \
            --min-split-size=5M \
            --connect-timeout=10 --max-tries=3 \
            -d "$(dirname "$dest")" -o "$(basename "$dest")" \
            "$hf_url" 2>/dev/null; then
            ok "Downloaded from HF (aria2c x${CONNECTIONS}): $file ($(du -h "$dest" | cut -f1))"
            mkdir -p "$(dirname "$cache_path")"
            cp "$dest" "$cache_path" 2>/dev/null || true
            return 0
        fi
    fi

    # Final fallback: HuggingFace Hub Python SDK
    log "Falling back to HuggingFace Hub SDK..."
    python3 -c "
import os, shutil
os.environ['HF_XET_HIGH_PERFORMANCE'] = '1'
from huggingface_hub import hf_hub_download
path = hf_hub_download('$repo', '$file')
shutil.copy2(path, '$dest')
print(f'Downloaded via HF Hub: {path}')
" && {
        ok "Downloaded from HF Hub SDK: $file ($(du -h "$dest" | cut -f1))"
        return 0
    }

    err "All download methods failed for $repo/$file"
    return 1
}

download_snapshot() {
    local repo="$1" dest="$2"

    # Check cache
    if [ -d "$dest" ] && [ -f "$dest/config.json" ]; then
        log "Already cached: $dest"
        return 0
    fi

    local cache_dir="${MODEL_CACHE_DIR}/${repo}"

    # For snapshots, HuggingFace Hub with hf_xet is usually the best option
    # because it handles multiple files, versioning, and symlinks correctly.
    # But we can try a tar.zst bundle from CDN first.

    local cdn_path="snapshots/${repo}.tar.zst"
    local sources=()
    [ -n "${CDN_BASE_URL:-}" ] && sources+=("${CDN_BASE_URL}/${cdn_path}")
    [ -n "${R2_BASE_URL:-}" ]  && sources+=("${R2_BASE_URL}/${cdn_path}")
    [ -n "${B2_BASE_URL:-}" ]  && sources+=("${B2_BASE_URL}/${cdn_path}")

    for url in "${sources[@]}"; do
        log "Trying snapshot bundle: $url"
        local tmptar="/tmp/$(basename "$cdn_path")"
        if command -v aria2c &>/dev/null; then
            if aria2c -x "$CONNECTIONS" -s "$CONNECTIONS" -k 10M \
                --file-allocation=none -q \
                -d /tmp -o "$(basename "$cdn_path")" \
                --connect-timeout=5 --timeout=10 --max-tries=1 \
                "$url" 2>/dev/null; then
                mkdir -p "$dest"
                zstd -d "$tmptar" --stdout | tar -xf - -C "$dest"
                rm -f "$tmptar"
                ok "Downloaded snapshot bundle: $repo"
                return 0
            fi
        fi
    done

    # Fallback: HuggingFace Hub snapshot_download
    log "Using HuggingFace Hub snapshot_download..."
    python3 -c "
import os
os.environ['HF_XET_HIGH_PERFORMANCE'] = '1'
from huggingface_hub import snapshot_download
path = snapshot_download('$repo', local_dir='$dest')
print(f'Downloaded snapshot: {path}')
" && {
        ok "Downloaded snapshot via HF Hub: $repo"
        return 0
    }

    err "All download methods failed for snapshot $repo"
    return 1
}

# ── Main ─────────────────────────────────────────────────────────────────────

START=$(date +%s.%N 2>/dev/null || python3 -c "import time; print(f'{time.time():.3f}')")

if [ "$SNAPSHOT" = "1" ]; then
    download_snapshot "$REPO" "$DEST"
else
    download_single_file "$REPO" "$FILE" "$DEST"
fi

END=$(date +%s.%N 2>/dev/null || python3 -c "import time; print(f'{time.time():.3f}')")
ELAPSED=$(python3 -c "print(f'{$END - $START:.1f}')")
log "Total time: ${ELAPSED}s"
