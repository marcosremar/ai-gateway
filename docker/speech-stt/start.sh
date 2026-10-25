#!/bin/bash
# Whisper large-v3 only. The LLM and the TTS stay out of this image so the GPU is free for streaming STT.
set -u
export HF_HOME=/models/hf HF_HUB_OFFLINE=1
CU12=$(python3 -c 'import nvidia.cublas.lib as a, nvidia.cudnn.lib as b, nvidia.cuda_runtime.lib as c; print(":".join(list(m.__path__)[0] for m in (a, b, c)))')
export LD_LIBRARY_PATH="$CU12${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec python3 -m uvicorn --app-dir /opt/s2s server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75
