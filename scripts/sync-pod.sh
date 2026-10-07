#!/usr/bin/env bash
# sync-pod.sh — rsync local serve.ts + src/ + sdk/ (+ server/) to running GPU pod, then restart.
#
# Usage:
#   ./scripts/sync-pod.sh              # sync + restart
#   ./scripts/sync-pod.sh --watch      # watch mode: auto-sync on file change
#   ./scripts/sync-pod.sh --dry-run    # preview without copying
#
# Requires: jq, rsync, ssh in PATH.
# Reads GATEWAY_URL + GATEWAY_API_KEY from .env or environment.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
GATEWAY_URL="${GATEWAY_URL:-http://localhost:4000}"
GATEWAY_API_KEY="${GATEWAY_API_KEY:-}"
REMOTE_DIR="${REMOTE_DIR:-/workspace/ai-gateway}"
WATCH_MODE=false
DRY_RUN=false

for arg in "$@"; do
  case $arg in
    --watch)   WATCH_MODE=true ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

# Load .env if present
if [[ -f .env ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

# ── Helpers ─────────────────────────────────────────────────────────────────
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
dim()  { printf '\033[2m%s\033[0m\n'  "$*"; }
bold() { printf '\033[1m%s\033[0m\n'  "$*"; }

# ── Fetch SSH creds from gateway status ─────────────────────────────────────

# Resolve a usable Bearer token from env.
# Prefers GATEWAY_API_KEY; falls back to first entry in GATEWAY_API_KEYS
# (format: "key1:label1,key2:label2,...").
resolve_api_key() {
  if [[ -n "${GATEWAY_API_KEY:-}" ]]; then
    echo "$GATEWAY_API_KEY"
    return
  fi
  if [[ -n "${GATEWAY_API_KEYS:-}" ]]; then
    # take first "key:label" pair, strip the ":label" suffix
    echo "${GATEWAY_API_KEYS%%,*}" | cut -d: -f1
    return
  fi
  echo ""
}

get_ssh_creds() {
  local api_key
  api_key=$(resolve_api_key)

  local status
  status=$(curl -sf \
    ${api_key:+-H "Authorization: Bearer $api_key"} \
    "${GATEWAY_URL}/v1/gpu/status") || {
    red "ERROR: Could not reach gateway at $GATEWAY_URL"
    exit 1
  }

  SSH_HOST=$(echo "$status" | jq -r '.sshHost // empty')
  SSH_PORT=$(echo "$status" | jq -r '.sshPort // empty')
  POD_STATUS=$(echo "$status" | jq -r '.status // empty')

  if [[ -z "$SSH_HOST" || -z "$SSH_PORT" || "$SSH_HOST" == "null" ]]; then
    red "ERROR: Pod has no SSH endpoint (status=$POD_STATUS). Deploy first: ai-gateway gpu deploy"
    exit 1
  fi

  if [[ "$POD_STATUS" != "ready" ]]; then
    red "WARN: Pod status is '$POD_STATUS' — sync may fail if pod is not ready yet."
  fi
}

# ── Rsync ────────────────────────────────────────────────────────────────────
do_sync() {
  bold "Syncing to root@${SSH_HOST}:${SSH_PORT} → ${REMOTE_DIR}"

  local rsync_opts=(-az --delete --progress
    -e "ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=10"
    --exclude="node_modules/"
    --exclude=".git/"
    --exclude="dist/"
    --exclude=".env"
    --exclude="*.log"
    --exclude=".babelcast/"
    --exclude="__tests__/"
    --exclude=".claude/"
  )

  if $DRY_RUN; then
    rsync_opts+=(--dry-run)
    dim "(dry-run — no files will be written)"
  fi

  rsync "${rsync_opts[@]}" \
    serve.ts src sdk server package.json tsconfig.json \
    "root@${SSH_HOST}:${REMOTE_DIR}/"

  grn "Sync done."

  if ! $DRY_RUN; then
    restart_remote
  fi
}

# ── Restart server on pod ────────────────────────────────────────────────────
restart_remote() {
  dim "Restarting gateway on pod..."
  ssh -p "${SSH_PORT}" \
    -o StrictHostKeyChecking=no \
    -o ConnectTimeout=10 \
    "root@${SSH_HOST}" \
    "cd ${REMOTE_DIR} && pkill -f 'bun.*serve.ts' 2>/dev/null || true && nohup bun serve.ts > /tmp/gw.log 2>&1 &" \
    && grn "Gateway restarted. Logs: ssh -p ${SSH_PORT} root@${SSH_HOST} tail -f /tmp/gw.log"
}

# ── Watch mode ───────────────────────────────────────────────────────────────
watch_and_sync() {
  bold "Watch mode — waiting for changes in server/ and src/"
  dim "Press Ctrl+C to stop."

  # macOS: use fswatch if available; fallback to find-based polling
  if command -v fswatch &>/dev/null; then
    fswatch -o server/ src/ | while read -r _; do
      echo ""
      bold "[$(date '+%H:%M:%S')] Change detected — syncing..."
      do_sync
    done
  else
    dim "fswatch not found — install with: brew install fswatch"
    dim "Falling back to 3-second poll..."
    local last_hash=""
    while true; do
      cur_hash=$(find server/ src/ -name '*.ts' -newer package.json -print0 2>/dev/null | sort -z | md5 2>/dev/null || echo "")
      if [[ "$cur_hash" != "$last_hash" ]]; then
        last_hash="$cur_hash"
        if [[ -n "$cur_hash" ]]; then
          bold "[$(date '+%H:%M:%S')] Change detected — syncing..."
          do_sync
        fi
      fi
      sleep 3
    done
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
get_ssh_creds

if $WATCH_MODE; then
  do_sync   # initial sync
  watch_and_sync
else
  do_sync
fi
