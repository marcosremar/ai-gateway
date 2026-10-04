# One image, three models, streamed speech-to-speech (see server.py). Models are baked in: a cold start pulls from the
# registry next to the GPU instead of downloading from Hugging Face at boot (a boot-time HF download failed on a real
# L4 on 2026-10-04).
ARG LLAMA_TAG=server-cuda-b11382
FROM ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG} AS llama

FROM vllm/vllm-omni:v0.28.0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
# llama.cpp is built on CUDA 12.8; this base is CUDA 13: its CUDA 12 runtime libs come from pip (start.sh sets the path).
COPY --from=llama /app /opt/llama
RUN python3 -m venv /opt/wenv && /opt/wenv/bin/pip install --no-cache-dir 'faster-whisper==1.2.1' fastapi 'uvicorn[standard]' \
    python-multipart httpx numpy 'huggingface_hub[hf_xet]' nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*' nvidia-cuda-runtime-cu12

ARG LLM_REPO=unsloth/Qwen3.5-9B-GGUF
ARG LLM_FILE=Qwen3.5-9B-Q4_K_M.gguf
ARG TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base
ENV HF_HOME=/models/hf LLM_FILE=${LLM_FILE} TTS_MODEL=${TTS_MODEL} STT_MODEL=large-v3
RUN /opt/wenv/bin/hf download "$LLM_REPO" "$LLM_FILE" --local-dir /models/llm \
 && /opt/wenv/bin/hf download "$TTS_MODEL" \
 && /opt/wenv/bin/hf download Systran/faster-whisper-large-v3 \
 && rm -rf /models/hf/xet

COPY start.sh server.py /opt/s2s/
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=900s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["bash", "/opt/s2s/start.sh"]
