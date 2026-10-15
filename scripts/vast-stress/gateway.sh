#!/usr/bin/env bash
set -euo pipefail
: "${STRESS_DIR:?set STRESS_DIR to a scratch directory}"
: "${SANDBOX_TOKEN:?set SANDBOX_TOKEN}"
mkdir -p "$STRESS_DIR/state" "$STRESS_DIR/logs"
[ -f "$STRESS_DIR/admin.key" ] || (umask 077; openssl rand -hex 24 > "$STRESS_DIR/admin.key")
cd "$(dirname "$0")/../.."
GATEWAY_API_KEYS="$(cat "$STRESS_DIR/admin.key"):stress" \
DEPLOYMENTS_ADMIN_USERS=stress \
DEPLOYMENTS_NAMESPACE="${DEPLOYMENTS_NAMESPACE:-vast-stress}" \
DEPLOYMENTS_STATE_DIR="$STRESS_DIR/state" \
DEPLOYMENTS_MAX_REPLICAS="${STRESS_MAX_REPLICAS:-3}" \
DEPLOYMENTS_MAX_EUR_PER_HOUR="${STRESS_MAX_EUR_PER_HOUR:-0.7}" \
DECLARED_DEPLOYMENTS=0 \
PORT="${STRESS_PORT:-4200}" \
nohup bun serve.ts >> "$STRESS_DIR/logs/gateway.log" 2>&1 &
echo $! > "$STRESS_DIR/gateway.pid"
echo "gateway pid $(cat "$STRESS_DIR/gateway.pid") on :${STRESS_PORT:-4200}"
