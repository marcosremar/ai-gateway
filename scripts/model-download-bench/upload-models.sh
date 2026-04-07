#!/usr/bin/env bash
# ── Upload models to Backblaze B2 / Cloudflare R2 for fast download ──────────
#
# Pre-requisites:
#   pip install b2sdk        # Backblaze B2 CLI
#   # or: brew install b2-tools
#
#   # For Cloudflare R2 (uses S3-compatible API):
#   pip install awscli
#   aws configure --profile r2  # use R2 credentials
#
# Environment:
#   B2_APPLICATION_KEY_ID     — Backblaze B2 key ID
#   B2_APPLICATION_KEY        — Backblaze B2 application key
#   B2_BUCKET                 — B2 bucket name (default: parle-models)
#
#   R2_ACCOUNT_ID             — Cloudflare account ID
#   R2_ACCESS_KEY_ID          — R2 access key
#   R2_SECRET_ACCESS_KEY      — R2 secret key
#   R2_BUCKET                 — R2 bucket name (default: parle-models)
#
# Usage:
#   # Upload all models to B2
#   ./upload-models.sh b2
#
#   # Upload all models to R2
#   ./upload-models.sh r2
#
#   # Upload specific model file
#   ./upload-models.sh b2 /path/to/model.gguf models/translategemma.gguf
#
#   # Upload + create zstd compressed version
#   COMPRESS=1 ./upload-models.sh b2
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

B2_BUCKET="${B2_BUCKET:-parle-models}"
R2_BUCKET="${R2_BUCKET:-parle-models}"
R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
COMPRESS="${COMPRESS:-0}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${CYAN}[upload]${NC} $*"; }
ok()   { echo -e "${GREEN}[upload]${NC} $*"; }
warn() { echo -e "${YELLOW}[upload]${NC} $*"; }

# ── Model definitions ────────────────────────────────────────────────────────
# Each model: HF_REPO HF_FILE DEST_PATH

MODELS=(
    "bullerwins/translategemma-4b-it-GGUF|translategemma-4b-it-Q8_0.gguf|babelcast/translategemma-4b-it-Q8_0.gguf"
    "Systran/faster-whisper-large-v3-turbo|model.bin|babelcast/faster-whisper-large-v3-turbo/model.bin"
    "Systran/faster-whisper-large-v3-turbo|config.json|babelcast/faster-whisper-large-v3-turbo/config.json"
    "Systran/faster-whisper-large-v3-turbo|tokenizer.json|babelcast/faster-whisper-large-v3-turbo/tokenizer.json"
    "Systran/faster-whisper-large-v3-turbo|vocabulary.json|babelcast/faster-whisper-large-v3-turbo/vocabulary.json"
    "Systran/faster-whisper-large-v3-turbo|preprocessor_config.json|babelcast/faster-whisper-large-v3-turbo/preprocessor_config.json"
)

# ── Download from HuggingFace ────────────────────────────────────────────────

download_hf() {
    local repo="$1" file="$2" dest="$3"
    log "Downloading $repo/$file from HuggingFace..."
    python3 -c "
from huggingface_hub import hf_hub_download
import shutil, os
path = hf_hub_download('$repo', '$file')
os.makedirs(os.path.dirname('$dest') or '.', exist_ok=True)
shutil.copy2(path, '$dest')
print(f'Downloaded: {path} -> $dest')
"
}

# ── Upload to Backblaze B2 ───────────────────────────────────────────────────

upload_b2() {
    local local_path="$1" remote_path="$2"

    if ! command -v b2 &>/dev/null; then
        warn "Installing b2 CLI..."
        pip install -q b2sdk b2 2>/dev/null
    fi

    # Authorize if not already
    b2 authorize-account "${B2_APPLICATION_KEY_ID}" "${B2_APPLICATION_KEY}" 2>/dev/null || true

    log "Uploading to B2: $remote_path"
    b2 upload-file "$B2_BUCKET" "$local_path" "$remote_path"
    ok "B2 upload complete: $remote_path"

    # Get friendly URL
    local bucket_info
    bucket_info=$(b2 get-bucket "$B2_BUCKET" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('bucketId',''))" 2>/dev/null || echo "")
    echo "  URL: https://f005.backblazeb2.com/file/${B2_BUCKET}/${remote_path}"

    if [ "$COMPRESS" = "1" ]; then
        log "Creating zstd compressed version..."
        zstd -19 -T0 "$local_path" -o "${local_path}.zst"
        b2 upload-file "$B2_BUCKET" "${local_path}.zst" "${remote_path}.zst"
        ok "B2 compressed upload: ${remote_path}.zst"
        rm -f "${local_path}.zst"
    fi
}

# ── Upload to Cloudflare R2 ──────────────────────────────────────────────────

upload_r2() {
    local local_path="$1" remote_path="$2"

    if ! command -v aws &>/dev/null; then
        warn "Installing awscli..."
        pip install -q awscli 2>/dev/null
    fi

    log "Uploading to R2: $remote_path"
    AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
    AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
    aws s3 cp "$local_path" "s3://${R2_BUCKET}/${remote_path}" \
        --endpoint-url "$R2_ENDPOINT" \
        --no-sign-request=false

    ok "R2 upload complete: $remote_path"

    if [ "$COMPRESS" = "1" ]; then
        log "Creating zstd compressed version..."
        zstd -19 -T0 "$local_path" -o "${local_path}.zst"
        AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" \
        AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
        aws s3 cp "${local_path}.zst" "s3://${R2_BUCKET}/${remote_path}.zst" \
            --endpoint-url "$R2_ENDPOINT"
        ok "R2 compressed upload: ${remote_path}.zst"
        rm -f "${local_path}.zst"
    fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

TARGET="${1:-}"
CUSTOM_FILE="${2:-}"
CUSTOM_DEST="${3:-}"

if [ -z "$TARGET" ]; then
    echo "Usage: $0 <b2|r2> [local_file] [remote_path]"
    echo ""
    echo "Upload all models:     $0 b2"
    echo "Upload specific file:  $0 r2 /path/to/model.gguf models/model.gguf"
    exit 1
fi

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

if [ -n "$CUSTOM_FILE" ] && [ -n "$CUSTOM_DEST" ]; then
    # Upload a specific file
    case "$TARGET" in
        b2) upload_b2 "$CUSTOM_FILE" "$CUSTOM_DEST" ;;
        r2) upload_r2 "$CUSTOM_FILE" "$CUSTOM_DEST" ;;
        *) echo "Unknown target: $TARGET"; exit 1 ;;
    esac
else
    # Upload all models
    log "Uploading all models to $TARGET..."
    echo ""

    for entry in "${MODELS[@]}"; do
        IFS='|' read -r repo file dest <<< "$entry"
        local_path="$TMPDIR/$file"

        download_hf "$repo" "$file" "$local_path"

        case "$TARGET" in
            b2) upload_b2 "$local_path" "$dest" ;;
            r2) upload_r2 "$local_path" "$dest" ;;
            *) echo "Unknown target: $TARGET"; exit 1 ;;
        esac

        rm -f "$local_path"
        echo ""
    done

    ok "All models uploaded to $TARGET!"
    echo ""
    echo "Next steps:"
    echo "  1. Make the bucket public (or create access rules)"
    echo "  2. Set the URLs in your .env:"
    case "$TARGET" in
        b2)
            echo "     B2_URL=https://f005.backblazeb2.com/file/${B2_BUCKET}/babelcast/translategemma-4b-it-Q8_0.gguf"
            echo "     B2_WHISPER_URL=https://f005.backblazeb2.com/file/${B2_BUCKET}/babelcast/faster-whisper-large-v3-turbo/"
            if [ "$COMPRESS" = "1" ]; then
                echo "     B2_URL_ZST=https://f005.backblazeb2.com/file/${B2_BUCKET}/babelcast/translategemma-4b-it-Q8_0.gguf.zst"
            fi
            ;;
        r2)
            echo "     R2_URL=https://<your-r2-domain>/babelcast/translategemma-4b-it-Q8_0.gguf"
            echo "     R2_WHISPER_URL=https://<your-r2-domain>/babelcast/faster-whisper-large-v3-turbo/"
            ;;
    esac
    echo "  3. Run the benchmark: ./benchmark.sh"
fi
