#!/usr/bin/env bash
#
# start-ws-server.sh — start the ai-gateway (serve.ts; the legacy server/ws-server.ts is gone) with persistent
# log capture. Forensic incident 2026-04-26: previous sessions were spawned
# bare (`bun run server/ws-server.ts &`) and their stdout/stderr was
# attached to whatever shell launched them. When the shell exited or the
# process was SIGTERMed for restart, all log history was lost — making it
# impossible to reconstruct who terminated which GPU instance.
#
# This wrapper:
#   - Writes stdout+stderr to ~/.ai-gateway/ws-server.<UTC-date>.log
#   - Symlinks ~/.ai-gateway/ws-server.current.log → today's file
#   - Records pid in ~/.ai-gateway/ws-server.pid for `make stop`
#   - Refuses to start if a healthy server is already listening on $PORT
#
# Usage:
#   scripts/start-ws-server.sh             # foreground, log + tee to terminal
#   scripts/start-ws-server.sh --detach    # background, log only
#   PORT=4001 scripts/start-ws-server.sh   # override default port 4000
#
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${AI_GATEWAY_CONFIG_DIR:-$HOME/.ai-gateway}"
PORT="${PORT:-4000}"
DETACH=0

mkdir -p "$LOG_DIR"

for arg in "$@"; do
  case "$arg" in
    --detach|-d) DETACH=1 ;;
    -h|--help)
      sed -n '3,22p' "$0"
      exit 0
      ;;
  esac
done

# Refuse to start if a previous run of THIS wrapper is still alive (pid file
# exists and the recorded pid is a live bun serve.ts).
PID_FILE="$LOG_DIR/ws-server.pid"
if [ -s "$PID_FILE" ]; then
  prev_pid=$(cat "$PID_FILE")
  if kill -0 "$prev_pid" 2>/dev/null && ps -p "$prev_pid" -o command= 2>/dev/null | grep -q 'serve.ts'; then
    echo "[start-ws-server] Refusing to start: PID $prev_pid is the previous ws-server from this wrapper" >&2
    echo "[start-ws-server] Stop it first:  kill $prev_pid && rm $PID_FILE" >&2
    exit 2
  fi
  rm -f "$PID_FILE"
fi

# Load .env so AIGW_ORPHAN_SWEEP_DISABLED, VAST_API_KEY, etc. apply. Bun
# auto-loads .env from cwd, but we set the vars explicitly so a `ps eww`
# audit can confirm what the server was given.
ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

stamp() { date -u +%Y-%m-%dT%H-%M-%SZ; }
LOG_FILE="$LOG_DIR/ws-server.$(stamp).log"
ln -sf "$LOG_FILE" "$LOG_DIR/ws-server.current.log"

cd "$PROJECT_DIR"

if [ "$DETACH" = 1 ]; then
  nohup bun run serve.ts >"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$LOG_DIR/ws-server.pid"
  disown "$pid" 2>/dev/null || true
  echo "[start-ws-server] Started PID=$pid PORT=$PORT log=$LOG_FILE"
  exit 0
fi

# Foreground: tee to terminal AND log file so an interactive session is
# debuggable yet still forensically recoverable.
echo "[start-ws-server] PID=$$  PORT=$PORT  log=$LOG_FILE"
echo "$$" > "$LOG_DIR/ws-server.pid"
exec bun run serve.ts 2>&1 | tee -a "$LOG_FILE"
