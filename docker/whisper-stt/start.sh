#!/bin/bash
# whisper-stt start order: LLM (llama.cpp, CPU) first — it is the long pole (5.3 GB
# GGUF load) — then the orchestrator, which loads Whisper in a background thread.
# No TTS in this image by design: dubbing happens on the gateway.
set -u
export HF_HOME=/models/hf HF_HUB_OFFLINE=1
log() { echo "[start] $(date +%T) $*"; }
wait_http() { for _ in $(seq 1 360); do curl -sf "$1" >/dev/null && return 0; sleep 2; done; log "timeout $1"; return 1; }

LLM_THREADS=${LLM_THREADS:-4}
LLM_CTX=${LLM_CTX:-2048}
LLM_PORT=${LLM_PORT:-8092}

/opt/llama/llama-server -m "/models/llm/$LLM_FILE" --host 127.0.0.1 --port "$LLM_PORT" \
  -t "$LLM_THREADS" -c "$LLM_CTX" --jinja --alias llm --reasoning-budget 0 \
  > /var/log/llm.log 2>&1 &
wait_http "http://127.0.0.1:$LLM_PORT/health" || { tail -50 /var/log/llm.log; exit 1; }
log "llm up ($LLM_FILE, ${LLM_THREADS} threads)"

exec uvicorn server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75
