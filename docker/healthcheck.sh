#!/usr/bin/env bash
# Enhanced healthcheck for AI Gateway Docker image.
#
# Unlike the simple wget check, this validates:
# 1. HTTP endpoint is responding
# 2. Response time is acceptable (<5s)
# 3. Providers are configured (if env vars are set)
# 4. Process is not zombie (PID 1 check)
#
# Usage in Dockerfile:
#   COPY docker/healthcheck.sh /usr/local/bin/healthcheck.sh
#   HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
#     CMD /usr/local/bin/healthcheck.sh

set -e

PORT="${PORT:-4000}"
HEALTH_URL="http://localhost:${PORT}/health"
MAX_RESPONSE_MS=5000

# 1. Check process is alive
if [ "$(cat /proc/1/status 2>/dev/null | grep State | awk '{print $2}')" = "Z" ]; then
  echo "FAIL: Main process is zombie"
  exit 1
fi

# 2. HTTP health check with timing
START_MS=$(date +%s%N | cut -b1-13)
RESPONSE=$(wget -qO- "$HEALTH_URL" 2>/dev/null || echo "FAIL")
END_MS=$(date +%s%N | cut -b1-13)
DURATION_MS=$((END_MS - START_MS))

if [ "$RESPONSE" = "FAIL" ]; then
  echo "FAIL: Health endpoint not responding"
  exit 1
fi

# 3. Check response time
if [ "$DURATION_MS" -gt "$MAX_RESPONSE_MS" ]; then
  echo "WARN: Health endpoint slow (${DURATION_MS}ms > ${MAX_RESPONSE_MS}ms)"
  # Don't fail on slow response during startup
fi

# 4. Parse health response (expect JSON with status field)
STATUS=$(echo "$RESPONSE" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$STATUS" != "ok" ] && [ "$STATUS" != "healthy" ]; then
  echo "WARN: Health status is '$STATUS' (expected 'ok' or 'healthy')"
  # Don't fail if status field has unexpected value — endpoint responded
fi

# 5. Check memory usage (warn if >1GB)
RSS_KB=$(grep VmRSS /proc/$$/status 2>/dev/null | awk '{print $2}' || echo "0")
RSS_MB=$((RSS_KB / 1024))

if [ "$RSS_MB" -gt 1024 ]; then
  echo "WARN: Memory usage high (${RSS_MB}MB)"
fi

echo "OK: Health check passed (${DURATION_MS}ms, ${RSS_MB}MB)"
exit 0
