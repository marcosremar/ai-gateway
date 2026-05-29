#!/usr/bin/env bash
# Restaura /workspace de um backup S3/R2/B2.
# Provisionado pelo ai-gateway via SSH (pod-provisioner.ts).
#
# Estratégias:
#   1. WORKSPACE_RESTORE_FROM env: restaura desse prefix (migrar de pod morto).
#   2. Mesmo prefix do pod atual (B2_PREFIX ou pods/<hostname>).
#
# Pulado quando:
#   - Sem credenciais (mesmo set do backup_workspace.sh)
#   - /workspace já tem >50MB E FORCE_RESTORE != 1

set -e

LOG="${BACKUP_LOG:-/var/log/aigw-agent/backup.log}"
mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] [restore] $*" | tee -a "$LOG"; }

# Aliases STORAGE_* → B2_* (mesmo esquema do backup_workspace.sh).
: "${B2_ACCOUNT_ID:=${STORAGE_ACCESS_KEY:-}}"
: "${B2_APPLICATION_KEY:=${STORAGE_SECRET_KEY:-}}"
: "${B2_BUCKET:=${STORAGE_BUCKET:-}}"
: "${B2_ENDPOINT:=${STORAGE_ENDPOINT:-}}"
: "${B2_REGION:=${STORAGE_REGION:-}}"
: "${B2_PREFIX:=${STORAGE_PREFIX:-}}"

if [ -z "${B2_ACCOUNT_ID:-}" ] || [ -z "${B2_APPLICATION_KEY:-}" ] || [ -z "${B2_BUCKET:-}" ]; then
    log "B2/R2/S3 credentials not set — restore skipped"
    exit 0
fi

ENDPOINT="${B2_ENDPOINT:-}"
if [ -z "$ENDPOINT" ]; then
    log "B2_ENDPOINT/STORAGE_ENDPOINT not set — restore skipped"
    exit 0
fi
REGION="${B2_REGION:-auto}"
DEFAULT_PREFIX="pods/${VAST_CONTAINERLABEL:-${HOSTNAME:-unknown}}"
SELF_PREFIX="${B2_PREFIX:-$DEFAULT_PREFIX}"
SRC_PREFIX="${WORKSPACE_RESTORE_FROM:-$SELF_PREFIX}"
DST="${BACKUP_PATH:-/workspace}"

mkdir -p "$DST"

EXISTING_SIZE=$(du -sm "$DST" 2>/dev/null | cut -f1 || echo 0)
if [ "${FORCE_RESTORE:-0}" != "1" ] && [ "$EXISTING_SIZE" -gt 50 ]; then
    log "/workspace already has ${EXISTING_SIZE}MB — restore skipped (set FORCE_RESTORE=1 to override)"
    exit 0
fi

export RCLONE_CONFIG_B2_TYPE=s3
export RCLONE_CONFIG_B2_PROVIDER=Other
export RCLONE_CONFIG_B2_ENDPOINT="$ENDPOINT"
export RCLONE_CONFIG_B2_ACCESS_KEY_ID="$B2_ACCOUNT_ID"
export RCLONE_CONFIG_B2_SECRET_ACCESS_KEY="$B2_APPLICATION_KEY"
export RCLONE_CONFIG_B2_REGION="$REGION"
export RCLONE_CONFIG_B2_NO_CHECK_BUCKET=true

N_OBJECTS=$(rclone lsf "b2:${B2_BUCKET}/${SRC_PREFIX}" --recursive 2>/dev/null | wc -l)
if [ "$N_OBJECTS" -eq 0 ]; then
    log "No objects in s3://${B2_BUCKET}/${SRC_PREFIX} — restore skipped (fresh start)"
    exit 0
fi

log "═══ Workspace restore ← s3://${B2_BUCKET}/${SRC_PREFIX}/ ═══"
log "  destination: $DST"
log "  remote objects: $N_OBJECTS"

START=$(date +%s)
if rclone copy "b2:${B2_BUCKET}/${SRC_PREFIX}" "$DST" \
    --transfers 8 \
    --checksum \
    --stats=30s --stats-one-line --log-file="$LOG" --log-level INFO; then
    DURATION=$(( $(date +%s) - START ))
    NEW_SIZE=$(du -sh "$DST" 2>/dev/null | cut -f1 || echo "?")
    log "✓ Restore completed in ${DURATION}s (now ${NEW_SIZE})"
    exit 0
else
    log "✗ Restore FAILED with rc=$?"
    exit 1
fi
