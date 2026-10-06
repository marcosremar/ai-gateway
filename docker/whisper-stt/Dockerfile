# Whisper large-v3 STT only — CPU-friendly image for local/dev use. For the full
# GPU speech-to-speech container see docker/speech-stack.
#
# Build context is docker/ so this image reuses speech-stack's batching and
# streaming code instead of duplicating it:
#
#   docker build -f docker/whisper-stt/Dockerfile -t whisper-stt docker/
#
# The model is baked into the image (~3 GB): a cold start serves immediately
# instead of downloading from Hugging Face at boot.
FROM python:3.12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir 'faster-whisper==1.2.1' fastapi 'uvicorn[standard]' python-multipart numpy

ARG STT_MODEL=large-v3
ENV HF_HOME=/models/hf STT_MODEL=${STT_MODEL} STT_DEVICE=auto STT_COMPUTE=auto
# Bake the model: instantiate once on CPU so the weights land in HF_HOME.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('$STT_MODEL', device='cpu', compute_type='int8')"

COPY speech-stack/stt_batch.py speech-stack/stt_stream.py whisper-stt/server.py /opt/stt/
WORKDIR /opt/stt
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=300s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
