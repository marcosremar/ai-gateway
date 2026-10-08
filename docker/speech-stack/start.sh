#!/bin/bash
# Start order matters on one GPU (measured on the parle one-GPU stack, 2026-10-02): the TTS first on an empty card (vLLM-Omni
# checks the free fraction at start), then the LLM (fixed size: weights + slots), then the STT inside the orchestrator.
set -u
export HF_HOME=/models/hf HF_HUB_OFFLINE=1
log() { echo "[start] $(date +%T) $*"; }
LOG_MAX_BYTES=${LOG_MAX_BYTES:-8000000}
keep() {
  local n=0 line
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$1"
    (( ++n % 200 )) || { [ "$(stat -c %s "$1")" -gt "$LOG_MAX_BYTES" ] && mv -f "$1" "$1.1"; }
  done
}
wait_http() { for _ in $(seq 1 360); do curl -sf "$1" >/dev/null && return 0; sleep 2; done; log "timeout $1"; return 1; }

CU12=$(/opt/wenv/bin/python -c 'import nvidia.cublas.lib as a, nvidia.cudnn.lib as b, nvidia.cuda_runtime.lib as c; print(":".join(list(m.__path__)[0] for m in (a, b, c)))')
TOTAL_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
TTS_UTIL=$(python3 -c "print(round(min(0.35, max(0.1, ${TTS_STAGE0_MB:-7400} / $TOTAL_MB)), 3))")
LLM_PARALLEL=${LLM_PARALLEL:-8}
LLM_SLOT_CTX=${LLM_SLOT_CTX:-2048}
log "gpu ${TOTAL_MB} MiB, tts util ${TTS_UTIL}, llm ${LLM_PARALLEL}x${LLM_SLOT_CTX}"

TTS_ARGS=(--gpu-memory-utilization "$TTS_UTIL")
[ -n "${TTS_STAGE_OVERRIDES:-}" ] && TTS_ARGS=(--stage-overrides "$TTS_STAGE_OVERRIDES")
[ -n "${TTS_DEPLOY_CONFIG:-}" ] && TTS_ARGS+=(--deploy-config "$TTS_DEPLOY_CONFIG")
vllm serve "$TTS_MODEL" --omni --host 127.0.0.1 --port 8091 --trust-remote-code "${TTS_ARGS[@]}" 2>&1 | keep /var/log/tts.log &
wait_http http://127.0.0.1:8091/health || { tail -50 /var/log/tts.log; exit 1; }
log "tts up, gpu used $(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1) MiB"

LLAMA_LIBS=/opt/llama:/opt/llama-cu12
devices=$(LD_LIBRARY_PATH=$LLAMA_LIBS /opt/llama/llama-server --list-devices 2>&1)
echo "$devices"
# Never serve the LLM from the CPU by accident: a missing CUDA lib makes llama.cpp fall back silently (7 tokens/s).
echo "$devices" | grep -q "CUDA0" || { log "llama.cpp sees no CUDA device — refusing to start"; exit 1; }
LD_LIBRARY_PATH=$LLAMA_LIBS /opt/llama/llama-server -m "/models/llm/$LLM_FILE" --host 127.0.0.1 --port 8092 -ngl 999 \
  -c $((LLM_PARALLEL * LLM_SLOT_CTX)) --parallel "$LLM_PARALLEL" -fa on --jinja --reasoning-budget 0 --alias llm --cache-ram 0 ${LLM_EXTRA_ARGS:-} 2>&1 | keep /var/log/llm.log &
wait_http http://127.0.0.1:8092/health || { tail -50 /var/log/llm.log; exit 1; }
log "llm up, gpu used $(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1) MiB"

export LD_LIBRARY_PATH=$CU12:${LD_LIBRARY_PATH:-}
exec /opt/wenv/bin/uvicorn --app-dir "${S2S_DIR:-/opt/s2s}" server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75 \
  > >(tee >(keep /var/log/stt.log)) 2>&1
