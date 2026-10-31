#!/bin/bash
# The orchestrator (uvicorn, server.py) starts FIRST: /health answers at once with each stage's status
# (`stages.{stt,llm,tts}`) and stays 503 until the three models are loaded and warm; its boot() loads Whisper and warms
# each stage in background tasks as soon as that stage's engine is up.
# Engine order still matters on one GPU (measured on the parle one-GPU stack, 2026-10-02): the TTS first on an empty card
# (vLLM-Omni sizes its KV cache from the free memory it measures while it starts), then the LLM (fixed size: weights +
# slots); Whisper allocates its memory only once the TTS answers (server.py STT_AFTER_TTS), next to the LLM's load.
# TTS engines (tts_engines.py): ONE of Qwen3-TTS / Kokoro / Pocket is loaded at a time. TTS_ENGINE (default qwen) is the
# one at boot; vLLM-Omni is started here only for qwen. The orchestrator stops it (process group) when another engine
# is chosen and starts it again from /tmp/aigw-tts.sh.
set -u
export HF_HOME=/models/hf HF_HUB_OFFLINE=1
log() { echo "[start] $(date +%T) $*"; }
LOG_MAX_BYTES=${LOG_MAX_BYTES:-32000000}
keep() {
  local n=0 line
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$1"
    (( ++n % 200 )) || { [ "$(stat -c %s "$1")" -gt "$LOG_MAX_BYTES" ] && mv -f "$1" "$1.1"; }
  done
}
wait_http() { for _ in $(seq 1 360); do curl -sf "$1" >/dev/null && return 0; sleep 2; done; log "timeout $1"; return 1; }

# The engines' own processes (vLLM-Omni restarted after a switch, the Pocket sidecar on the base Python's CUDA torch)
# get this environment, not the orchestrator's CUDA 12 libs.
export BASE_LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-} BASE_PYTHON=$(command -v python3)
export TTS_ENGINE=${TTS_ENGINE:-qwen}
CU12=$(/opt/wenv/bin/python -c 'import nvidia.cublas.lib as a, nvidia.cudnn.lib as b, nvidia.cuda_runtime.lib as c; print(":".join(list(m.__path__)[0] for m in (a, b, c)))')
TOTAL_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
if [ "$TOTAL_MB" -lt 16000 ]; then
  export STT_COMPUTE=int8_float16 STT_BATCH=${STT_BATCH:-2}
fi
TTS_UTIL=$(python3 -c "print(round(min(0.35, max(0.1, ${TTS_STAGE0_MB:-7400} / $TOTAL_MB)), 3))")
LLM_PARALLEL=${LLM_PARALLEL:-8}
LLM_SLOT_CTX=${LLM_SLOT_CTX:-2048}
log "gpu ${TOTAL_MB} MiB, tts util ${TTS_UTIL}, llm ${LLM_PARALLEL}x${LLM_SLOT_CTX}"

# The CUDA 12 libs of the venv go to the orchestrator only: vLLM-Omni (CUDA 13) must not load them.
LD_LIBRARY_PATH=$CU12:${LD_LIBRARY_PATH:-} /opt/wenv/bin/uvicorn --app-dir "${S2S_DIR:-/opt/s2s}" server:app --host 0.0.0.0 \
  --port 8000 --timeout-keep-alive 75 > >(tee >(keep /var/log/stt.log)) 2>&1 &
ORCHESTRATOR=$!
trap 'kill "$ORCHESTRATOR" 2>/dev/null; exit 143' TERM INT
fail() { log "$1"; kill "$ORCHESTRATOR" 2>/dev/null; exit 1; }
log "orchestrator pid ${ORCHESTRATOR}"

TTS_ARGS=(--gpu-memory-utilization "$TTS_UTIL")
[ -n "${TTS_STAGE_OVERRIDES:-}" ] && TTS_ARGS=(--stage-overrides "$TTS_STAGE_OVERRIDES")
TTS_DEPLOY_CONFIG=${TTS_DEPLOY_CONFIG:-$(dirname "$0")/qwen3_tts.yaml}
[ -f "$TTS_DEPLOY_CONFIG" ] && TTS_ARGS+=(--deploy-config "$TTS_DEPLOY_CONFIG")
printf 'exec vllm serve %q --omni --host 127.0.0.1 --port 8091 --trust-remote-code' "$TTS_MODEL" > /tmp/aigw-tts.sh
printf ' %q' "${TTS_ARGS[@]}" >> /tmp/aigw-tts.sh
echo >> /tmp/aigw-tts.sh
if [ "$TTS_ENGINE" = qwen ]; then
  # Own process group (setsid): the orchestrator stops vLLM-Omni and its engine workers together.
  setsid bash /tmp/aigw-tts.sh > >(keep /var/log/tts.log) 2>&1 &
  echo $! > /tmp/aigw-tts.pid
  wait_http http://127.0.0.1:8091/health || { tail -50 /var/log/tts.log; fail "tts did not start"; }
  log "tts up, gpu used $(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1) MiB"
else
  log "tts engine at boot: ${TTS_ENGINE} (vLLM-Omni not started; the orchestrator loads the engine)"
fi

if [ "${LLM_ENGINE:-llama}" = off ]; then
  log "llm off (LLM_ENGINE=off): llama.cpp not started"
  wait "$ORCHESTRATOR"
  exit $?
fi

LLAMA_LIBS=/opt/llama:/opt/llama-cu12
devices=$(LD_LIBRARY_PATH=$LLAMA_LIBS /opt/llama/llama-server --list-devices 2>&1)
echo "$devices"
# Never serve the LLM from the CPU by accident: a missing CUDA lib makes llama.cpp fall back silently (7 tokens/s).
echo "$devices" | grep -q "CUDA0" || fail "llama.cpp sees no CUDA device — refusing to start"
LD_LIBRARY_PATH=$LLAMA_LIBS /opt/llama/llama-server -m "/models/llm/$LLM_FILE" --host 127.0.0.1 --port 8092 -ngl 999 \
  -c $((LLM_PARALLEL * LLM_SLOT_CTX)) --parallel "$LLM_PARALLEL" -fa on --jinja --reasoning-budget 0 --alias llm --cache-ram 0 ${LLM_EXTRA_ARGS:-} 2>&1 | keep /var/log/llm.log &
wait_http http://127.0.0.1:8092/health || { tail -50 /var/log/llm.log; fail "llm did not start"; }
log "llm up, gpu used $(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1) MiB"

wait "$ORCHESTRATOR"
