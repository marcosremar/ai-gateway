#!/usr/bin/env bash
export DISPLAY=:0
IDLE_STOP_MS=${IDLE_STOP_MS:-600000}

while sleep 30; do
  idle=$(xprintidle 2>/dev/null || echo 0)
  viewers=$(ss -tnH state established '( sport = :5900 )' 2>/dev/null | wc -l)
  if [ "$idle" -ge "$IDLE_STOP_MS" ] && [ "$viewers" -eq 0 ]; then
    curl -s -m 10 -X POST -H "Authorization: Bearer $FLY_STOP_TOKEN" \
      "https://api.machines.dev/v1/apps/$FLY_APP_NAME/machines/$FLY_MACHINE_ID/stop" >/dev/null 2>&1
    exit 0
  fi
done
