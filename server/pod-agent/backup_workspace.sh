#!/usr/bin/env bash
# Sincroniza /workspace pro B2/R2/S3 via rclone.
# Provisionado pelo ai-gateway via SSH (pod-provisioner.ts).
#
# Env vars (passadas pelo gateway via deployEnv):
#   B2_ACCOUNT_ID, B2_APPLICATION_KEY, B2_BUCKET   — credenciais (R2 ou B2 ou S3)
#     aliases aceitos: STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY / STORAGE_BUCKET
#   B2_ENDPOINT     (sem default — R2: https://<acct>.r2.cloudflarestorage.com)
#                   alias: STORAGE_ENDPOINT
#   B2_REGION       (default: auto — correto p/ Cloudflare R2)  alias: STORAGE_REGION
#   B2_PREFIX       (default: pods/<HOSTNAME>)  alias: STORAGE_PREFIX
#   BACKUP_PATH     (default: /workspace)
#   BACKUP_LOG      (default: /var/log/aigw-agent/backup.log)
#
# Sem credenciais → no-op silencioso.

set -e

LOG="${BACKUP_LOG:-/var/log/aigw-agent/backup.log}"
mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] $*" | tee -a "$LOG"; }

# Aliases STORAGE_* → B2_* (nome legado). B2_* tem precedência se ambos setados.
: "${B2_ACCOUNT_ID:=${STORAGE_ACCESS_KEY:-}}"
: "${B2_APPLICATION_KEY:=${STORAGE_SECRET_KEY:-}}"
: "${B2_BUCKET:=${STORAGE_BUCKET:-}}"
: "${B2_ENDPOINT:=${STORAGE_ENDPOINT:-}}"
: "${B2_REGION:=${STORAGE_REGION:-}}"
: "${B2_PREFIX:=${STORAGE_PREFIX:-}}"

if [ -z "${B2_ACCOUNT_ID:-}" ] || [ -z "${B2_APPLICATION_KEY:-}" ] || [ -z "${B2_BUCKET:-}" ]; then
    log "B2/R2/S3 credentials not set — backup skipped"
    exit 0
fi

ENDPOINT="${B2_ENDPOINT:-}"
if [ -z "$ENDPOINT" ]; then
    log "✗ B2_ENDPOINT/STORAGE_ENDPOINT not set — refusing (no Backblaze fallback). For R2 use https://<acct>.r2.cloudflarestorage.com"
    exit 1
fi
REGION="${B2_REGION:-auto}"
DEFAULT_PREFIX="pods/${VAST_CONTAINERLABEL:-${HOSTNAME:-unknown}}"
PREFIX="${B2_PREFIX:-$DEFAULT_PREFIX}"
SRC="${BACKUP_PATH:-/workspace}"

if [ ! -d "$SRC" ]; then
    log "BACKUP_PATH '$SRC' does not exist — nothing to back up"
    exit 0
fi

log "═══ Workspace backup → s3://${B2_BUCKET}/${PREFIX}/ ═══"
log "  source: $SRC ($(du -sh "$SRC" 2>/dev/null | cut -f1))"

export RCLONE_CONFIG_B2_TYPE=s3
export RCLONE_CONFIG_B2_PROVIDER=Other
export RCLONE_CONFIG_B2_ENDPOINT="$ENDPOINT"
export RCLONE_CONFIG_B2_ACCESS_KEY_ID="$B2_ACCOUNT_ID"
export RCLONE_CONFIG_B2_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY"
export RCLONE_CONFIG_B2_REGION="$REGION"
export RCLONE_CONFIG_B2_NO_CHECK_BUCKET=true

START=$(date +%s)
# Checkpoints primeiro (best-effort): garante que o dado mais crítico sobe
# mesmo se o sync completo for interrompido por morte do pod.
CKPT_DIR="${BACKUP_WATCH_DIR:-/workspace/checkpoints}"
if [ -d "$CKPT_DIR" ] && [ -n "$(ls -A "$CKPT_DIR" 2>/dev/null)" ]; then
    CKPT_REL="${CKPT_DIR#"$SRC"/}"
    log "  ↑ checkpoints-first: $CKPT_DIR → ${PREFIX}/${CKPT_REL}"
    rclone copy "$CKPT_DIR" "b2:${B2_BUCKET}/${PREFIX}/${CKPT_REL}" \
        --transfers 8 --checksum \
        --stats=30s --stats-one-line --log-file="$LOG" --log-level INFO || \
        log "  ⚠ checkpoints-first copy failed (continuing to full sync)"
fi
if rclone sync "$SRC" "b2:${B2_BUCKET}/${PREFIX}" \
    --transfers 8 \
    --checksum \
    --exclude "**/_refined_frames/**" \
    --exclude "**/_prewarped/**" \
    --exclude "**/_blend/**" \
    --exclude "**/__pycache__/**" \
    --exclude "**/.cache/**" \
    --stats=30s --stats-one-line --log-file="$LOG" --log-level INFO; then
    DURATION=$(( $(date +%s) - START ))
    log "✓ Backup completed in ${DURATION}s"
    exit 0
else
    log "✗ Backup FAILED with rc=$?"
    exit 1
fi
