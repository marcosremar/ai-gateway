# ── BabelCast Subtitle — Universal GPU Image ────────────────────────────────
# Single image for ALL GPU architectures: Blackwell (sm_120), Ada (sm_89),
# Ampere (sm_80/86), Hopper (sm_90). No separate Blackwell variant needed.
#
# Build:
#   docker build -t marcosremar/babelcast-subtitle:latest .
#   docker build --build-arg BASE_IMAGE=nvidia/cuda:13.0.2-cudnn-runtime-ubuntu22.04 -t ... .
#
# CUDA 12.8.1 is the minimum for RTX 5090/5080 (sm_120) and includes kernels
# for all older architectures. One image runs everywhere.
# ─────────────────────────────────────────────────────────────────────────────

ARG BASE_IMAGE=nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    # Default to float16 — safe on all GPUs including Blackwell.
    # INT8 tensor cores have issues on sm_120; float16 is universally reliable.
    COMPUTE_TYPE=float16 \
    # hf-xet fast downloader (CLAUDE.md: use hf_xet, NOT the deprecated
    # HF_HUB_ENABLE_HF_TRANSFER). Drives the build-time pre-bake below.
    HF_XET_HIGH_PERFORMANCE=1 \
    HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50

# System deps — minimal for inference only
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3.11-dev python3-pip \
    ffmpeg libsndfile1 curl && \
    ln -sf /usr/bin/python3.11 /usr/bin/python3 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps in a single layer (#978). Exact pins for reproducible,
# cacheable builds (#979). CTranslate2 4.7.1 has Blackwell sm_120 fixes; the
# cu128 torch wheel runs on CUDA 12.8+ (Blackwell + older GPUs). hf_xet is the
# project-mandated fast HF downloader (#977).
ARG CUDA_INDEX=https://download.pytorch.org/whl/cu128
RUN pip install --no-cache-dir torch==2.11.0 --index-url ${CUDA_INDEX} && \
    pip install --no-cache-dir \
    faster-whisper==1.2.1 \
    ctranslate2==4.7.1 \
    transformers==4.48.0 \
    accelerate==1.4.0 \
    sentencepiece==0.2.0 \
    protobuf==5.29.3 \
    "huggingface-hub>=1.0.0" \
    "hf_xet>=1.4.0" \
    "uvicorn[standard]==0.34.0" \
    fastapi==0.115.8

COPY server.py .
COPY start.sh .
COPY prebake.py .
RUN chmod +x start.sh

# Pre-bake STT + LLM weights into the image at BUILD time (#976). Models load
# from the local HF cache on boot instead of downloading on first request,
# which CLAUDE.md validates as +24% faster on NVMe hosts.
ENV STT_MODEL=large-v3-turbo \
    LLM_MODEL=google/translate-gemma-12b-it
RUN python3 /app/prebake.py

EXPOSE 8000

# Health check — models are pre-baked so boot is fast; the 30s grace detects
# real startup failures quickly (#987) instead of masking a slow download.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:8000/health || exit 1

CMD ["/app/start.sh"]
