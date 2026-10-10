#!/usr/bin/env bash
set -u
: "${GW:?}" "${KEY:?}" "${STRESS_DIR:?}"
while true; do
  for d in $(curl -s -m 10 -H "Authorization: Bearer $KEY" "$GW/v1/deployments" | jq -r '.deployments[]?.name' 2>/dev/null); do
    curl -s -m 10 -H "Authorization: Bearer $KEY" "$GW/v1/deployments/$d" \
      | jq -c --arg at "$(date -u +%FT%TZ)" '{at: $at, name, status, desiredReplicas, inflight, waiting, lastError, lastPlacement,
          replicas: [.replicas[]? | {id, phase, zone, ageSeconds, rttMs, rttBaselineMs, inflight, pricePerHour, address}]}' \
      >> "$STRESS_DIR/logs/watch.jsonl" 2>/dev/null
  done
  sleep "${WATCH_EVERY:-10}"
done
