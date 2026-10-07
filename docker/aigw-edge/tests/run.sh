#!/usr/bin/env bash
# Runs the edge's tests in a throwaway venv (deleted afterwards — the dev box disk is small):
#   tests/run.sh units            pure parts + the gateway's token/TURN vectors + session turns on fakes + telemetry emitter
#   tests/run.sh harness          fake models + the real edge (+ the real nginx front when nginx and bun exist)
#   tests/run.sh bench [webrtc|ws] [1,4,8,16]   CPU per concurrent session (RT_RTC_WORKERS=0 for one process)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
EDGE=$(dirname "$HERE")
VENV=${EDGE_VENV:-$(mktemp -d)/venv}
KEEP=${EDGE_VENV:+1}
cleanup() { [ -n "${KEEP:-}" ] || rm -rf "$(dirname "$VENV")"; }
trap cleanup EXIT
if [ ! -x "$VENV/bin/python" ]; then
  if command -v uv >/dev/null; then
    uv venv -q "$VENV" && UV_NO_CACHE=1 uv pip install -q --python "$VENV/bin/python" --only-binary :all: -r "$EDGE/requirements.txt" psutil
  else
    python3 -m venv "$VENV" && "$VENV/bin/pip" install -q --no-cache-dir --only-binary :all: -r "$EDGE/requirements.txt" psutil
  fi
fi
cmd=${1:-harness}; shift || true
case "$cmd" in
  units) "$VENV/bin/python" "$HERE/test_units.py" && "$VENV/bin/python" "$HERE/test_session.py" \
    && (cd "$EDGE" && "$VENV/bin/python" -m unittest test_telemetry) ;;
  harness) cd "$HERE" && "$VENV/bin/python" harness.py ;;
  bench) cd "$HERE" && "$VENV/bin/python" bench.py "$@" ;;
  *) echo "usage: $0 units|harness|bench" >&2; exit 2 ;;
esac
