# One image, three models, streamed speech-to-speech (see server.py). Models are baked in: a cold start pulls from the
# registry next to the GPU instead of downloading from Hugging Face at boot (a boot-time HF download failed on a real
# L4 on 2026-10-04).
ARG LLAMA_TAG=server-cuda-b11382
ARG LLAMA_DIGEST=sha256:ef08b5a98b1170f2b62177be0a4027c88a84043c55afbf190dd18b9e7cdcfebf
ARG EDGE_TAG=59e5d605
ARG EDGE_DIGEST=sha256:89b17f14d70494723cae0b891d968c5d19afada4c4d478b2d8a46a664e012786
FROM ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG}@${LLAMA_DIGEST} AS llama
FROM ghcr.io/marcosremar/aigw-edge:${EDGE_TAG}@${EDGE_DIGEST} AS edge

FROM vllm/vllm-omni:v0.28.0@sha256:6f8be103eaf0055448cf7578cfd621405fd669079d4361bd58896326b2bf722a
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl libgomp1 && rm -rf /var/lib/apt/lists/*
# llama.cpp is built on CUDA 12.8; this base is CUDA 13: llama-server runs with its own CUDA 12 libs (below)…
COPY --from=llama /app /opt/llama
# …and the exact CUDA 12 libs it was built against, NCCL included: without libnccl.so.2 its CUDA backend does not load
# and llama-server silently falls back to the CPU (2026-10-04 on an L4: 7 tokens/s). start.sh refuses to start without CUDA0.
COPY --from=llama /usr/local/cuda/lib64/libcudart.so.12.8.90 /usr/local/cuda/lib64/libcublas.so.12.8.4.1 \
     /usr/local/cuda/lib64/libcublasLt.so.12.8.4.1 /lib/x86_64-linux-gnu/libnccl.so.2.25.1 /opt/llama-cu12/
RUN cd /opt/llama-cu12 && ln -s libcudart.so.12.8.90 libcudart.so.12 && ln -s libcublas.so.12.8.4.1 libcublas.so.12 \
 && ln -s libcublasLt.so.12.8.4.1 libcublasLt.so.12 && ln -s libnccl.so.2.25.1 libnccl.so.2
# Python 3.12 venv via uv (in the base), wheels only. huggingface_hub 2.x pulled `tokenizers` back to 0.13.3, which has no
# wheel for 3.12 and needs Rust to build (both 2026-10-04 builds failed there): pin the pair that resolves to wheels.
RUN uv venv --python 3.12 /opt/wenv && uv pip install --python /opt/wenv/bin/python --no-cache --only-binary :all: \
    'faster-whisper==1.2.1' 'tokenizers>=0.21' 'huggingface_hub[hf_xet]<1' fastapi 'uvicorn[standard]' python-multipart httpx \
    numpy nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*' nvidia-cuda-runtime-cu12

ARG LLM_REPO=unsloth/Qwen3.5-9B-GGUF
ARG LLM_FILE=Qwen3.5-9B-Q4_K_M.gguf
ARG LLM_REVISION=3885219b6810b007914f3a7950a8d1b469d598a5
ARG LLM_SHA256=03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8
ARG TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base
ARG TTS_REVISION=5d83992436eae1d760afd27aff78a71d676296fc
ARG STT_REVISION=edaa852ec7e145841d8ffdb056a99866b5f0a478
ENV HF_HOME=/models/hf LLM_FILE=${LLM_FILE} TTS_MODEL=${TTS_MODEL} STT_MODEL=large-v3 STT_COMPUTE=float16
RUN /opt/wenv/bin/hf download "$LLM_REPO" "$LLM_FILE" --revision "$LLM_REVISION" --local-dir /models/llm \
 && echo "$LLM_SHA256  /models/llm/$LLM_FILE" | sha256sum -c - \
 && /opt/wenv/bin/hf download "$TTS_MODEL" \
 && /opt/wenv/bin/hf download Systran/faster-whisper-large-v3 \
 && test "$(cat /models/hf/hub/models--${TTS_MODEL%%/*}--${TTS_MODEL#*/}/refs/main)" = "$TTS_REVISION" \
 && test "$(cat /models/hf/hub/models--Systran--faster-whisper-large-v3/refs/main)" = "$STT_REVISION" \
 && rm -rf /models/hf/xet

COPY --from=edge /app /opt/aigw-edge
RUN uv venv --python 3.12 /opt/aigw-edge/venv && uv pip install --python /opt/aigw-edge/venv/bin/python --no-cache \
    --only-binary :all: aiortc==1.15.0 aiohttp==3.14.4 'numpy>=1.26,<3'
COPY start.sh server.py stt_batch.py stt_stream.py qwen3_tts.yaml /opt/s2s/
RUN cd /opt/aigw-edge && venv/bin/python -c 'import aigw_edge.server' && ls -l /opt/aigw-edge /opt/aigw-edge/aigw_edge \
 && grep -n repetition_penalty /opt/s2s/qwen3_tts.yaml && sha256sum /opt/s2s/*
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=900s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["bash", "/opt/s2s/start.sh"]
