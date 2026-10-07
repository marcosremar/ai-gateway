# Whisper large-v3 STT + Qwen3.5-9B LLM (translation) — CPU-friendly image for local/dev use.
# "Hear + think": transcribe with faster-whisper, translate with Qwen3.5-9B Q4_K_M on
# llama.cpp. No TTS — dubbing stays on the gateway (cloud or local-say). For the full
# GPU speech-to-speech container see docker/speech-stack.
#
# Build context is docker/ so this image reuses speech-stack's batching and
# streaming code instead of duplicating it:
#
#   docker build -f docker/whisper-stt/Dockerfile -t whisper-stt docker/
#
# Models are baked into the image (~3 GB whisper + ~5.3 GB Qwen): a cold start serves
# immediately instead of downloading from Hugging Face at boot.
ARG LLAMA_TAG=server-b11382
FROM ghcr.io/ggml-org/llama.cpp:${LLAMA_TAG} AS llama

FROM python:3.12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl libgomp1 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir 'faster-whisper==1.2.1' fastapi 'uvicorn[standard]' python-multipart numpy httpx 'huggingface_hub[hf_xet]<1'
# llama.cpp CPU build (with its runtime deps: gomp + the bundled libs).
COPY --from=llama /app /opt/llama
ENV LD_LIBRARY_PATH=/opt/llama

ARG STT_MODEL=large-v3
ARG LLM_REPO=unsloth/Qwen3.5-9B-GGUF
ARG LLM_FILE=Qwen3.5-9B-Q4_K_M.gguf
ENV HF_HOME=/models/hf STT_MODEL=${STT_MODEL} STT_DEVICE=auto STT_COMPUTE=auto LLM_FILE=${LLM_FILE}
# Bake both models: whisper weights into HF_HOME, the GGUF next to the server.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('$STT_MODEL', device='cpu', compute_type='int8')" \
 && python -c "import huggingface_hub; huggingface_hub.hf_hub_download('$LLM_REPO', '$LLM_FILE', local_dir='/models/llm')" \
 && rm -rf /models/hf/xet

COPY stt_batch.py stt_stream.py server.py start.sh /opt/stt/
WORKDIR /opt/stt
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=600s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["bash", "/opt/stt/start.sh"]
