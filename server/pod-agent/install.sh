#!/usr/bin/env bash
# ai-gateway pod agent installer.
# Roda dentro do pod via SSH (push do gateway). Idempotente — pode rodar de novo.
#
# Pré-requisito: arquivos já dropados em /usr/local/bin pelo provisioner:
#   /usr/local/bin/aigw-backup       (backup_workspace.sh)
#   /usr/local/bin/aigw-restore      (restore_workspace.sh)
#   /usr/local/bin/aigw-agent        (aigw_agent.py)
#
# Variáveis injetadas no /etc/aigw-agent.env pelo provisioner:
#   AIGW_URL, AIGW_POD_ID, AIGW_TOKEN, AIGW_INTERVAL
#   B2_ACCOUNT_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT, B2_REGION, B2_PREFIX
#     (STORAGE_* são aliases aceitos — ver backup_workspace.sh)
#   WORKSPACE_RESTORE_FROM (prefix de onde restaurar — migrar de pod morto)
#   BACKUP_INTERVAL_HOURS (default 6 — teto de fallback; backup real é por checkpoint)
#   BACKUP_CHECK_SECS (default 120 — frequência de checagem do dir de ckpt)
#   BACKUP_WATCH_DIR (default /workspace/checkpoints)

set -e

LOG="/var/log/aigw-agent/install.log"
mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1

echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] aigw-agent installer starting"

ENV_FILE="/etc/aigw-agent.env"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — provisioner must drop it first"; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# ── 1. rclone (idempotente) ──────────────────────────────────────────────────
if ! command -v rclone >/dev/null 2>&1; then
    echo "[install] rclone not found — installing"
    if command -v apt-get >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone
    else
        curl -fsSL https://rclone.org/install.sh | bash
    fi
fi
rclone version | head -1

# ── 2. perms ─────────────────────────────────────────────────────────────────
chmod +x /usr/local/bin/aigw-backup /usr/local/bin/aigw-restore /usr/local/bin/aigw-agent

# ── 3. restore inicial (best-effort, no-op se já tem dados) ──────────────────
echo "[install] running initial restore (no-op se /workspace tem dados)"
/usr/local/bin/aigw-restore || echo "[install] restore skipped/failed (continuing)"

# ── 4. backup loop em background (checkpoint-driven) ─────────────────────────
# Em vez de backup por tempo fixo (perdia até 24h de ckpt num crash), observamos
# o dir de checkpoints: assim que um novo step-*.safetensors aparece (mtime/size
# muda), dispara backup. INTERVAL_H vira só um teto de segurança (fallback).
INTERVAL_H="${BACKUP_INTERVAL_HOURS:-6}"
CHECK_SECS="${BACKUP_CHECK_SECS:-120}"
WATCH_DIR="${BACKUP_WATCH_DIR:-/workspace/checkpoints}"
MAX_GAP=$(( INTERVAL_H * 3600 ))
BACKUP_PIDFILE="/var/run/aigw-backup-loop.pid"

# Mata loop antigo se existir (idempotência)
if [ -f "$BACKUP_PIDFILE" ] && kill -0 "$(cat "$BACKUP_PIDFILE")" 2>/dev/null; then
    echo "[install] killing existing backup loop pid=$(cat "$BACKUP_PIDFILE")"
    kill "$(cat "$BACKUP_PIDFILE")" || true
fi

nohup bash -c "
    sleep 60  # bootstrap delay
    last_sig=''
    last_backup=0
    while true; do
        now=\$(date +%s)
        # Assinatura barata do dir de ckpt: lista mtime+size+path -> hash.
        sig=''
        if [ -d '$WATCH_DIR' ]; then
            sig=\$(find '$WATCH_DIR' -type f -printf '%T@ %s %p\n' 2>/dev/null | sort | md5sum | cut -d' ' -f1)
        fi
        elapsed=\$(( now - last_backup ))
        if [ \"\$sig\" != \"\$last_sig\" ] || [ \$elapsed -ge $MAX_GAP ]; then
            if /usr/local/bin/aigw-backup; then
                last_sig=\"\$sig\"
                last_backup=\$now
            fi
        fi
        sleep $CHECK_SECS
    done
" >> /var/log/aigw-agent/backup-loop.log 2>&1 &
echo $! > "$BACKUP_PIDFILE"
echo "[install] backup loop started pid=$(cat "$BACKUP_PIDFILE") (checkpoint-driven, check=${CHECK_SECS}s, max_gap=${INTERVAL_H}h, watch=${WATCH_DIR})"

# ── 5. heartbeat agent em background ─────────────────────────────────────────
AGENT_PIDFILE="/var/run/aigw-agent.pid"

if [ -f "$AGENT_PIDFILE" ] && kill -0 "$(cat "$AGENT_PIDFILE")" 2>/dev/null; then
    echo "[install] killing existing agent pid=$(cat "$AGENT_PIDFILE")"
    kill "$(cat "$AGENT_PIDFILE")" || true
    sleep 1
fi

if [ -n "${AIGW_URL:-}" ]; then
    nohup python3 /usr/local/bin/aigw-agent >> /var/log/aigw-agent/agent.log 2>&1 &
    echo $! > "$AGENT_PIDFILE"
    echo "[install] heartbeat agent started pid=$(cat "$AGENT_PIDFILE") → $AIGW_URL"
else
    echo "[install] AIGW_URL not set — heartbeat agent skipped"
fi

echo "[install] aigw-agent install complete"
