# Whisper large-v3 streaming on an otherwise empty GPU.
# The speech-stack image also loads Qwen and llama.cpp, and on a 24 GB card that left Whisper at ~3 s for 5 s of
# Portuguese. This image is only faster-whisper, so one RTX 3090 can spend the whole card on the decode.
FROM python:3.12-slim-bookworm
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl libgomp1 \
 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir \
    'faster-whisper==1.2.1' 'nvidia-cublas-cu12' 'nvidia-cudnn-cu12==9.*' 'nvidia-cuda-runtime-cu12' \
    fastapi 'uvicorn[standard]' python-multipart
ARG STT_REVISION=edaa852ec7e145841d8ffdb056a99866b5f0a478
ENV HF_HOME=/models/hf STT_MODEL=large-v3 STT_COMPUTE=float16 STT_BEAM=1 STT_BATCH=4 STT_REVISION=${STT_REVISION}
RUN python -c "import os; from huggingface_hub import snapshot_download; print(snapshot_download('Systran/faster-whisper-large-v3', revision=os.environ['STT_REVISION']))" \
 && find /models/hf/hub/models--Systran--faster-whisper-large-v3 -name model.bin | grep -q . \
 && rm -rf /models/hf/xet
COPY speech-stack/stt_batch.py speech-stack/stt_stream.py /opt/s2s/
COPY speech-stt/server.py speech-stt/start.sh /opt/s2s/
RUN chmod +x /opt/s2s/start.sh && sed -i 's/\r$//' /opt/s2s/start.sh
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s CMD curl -sf http://127.0.0.1:8000/health || exit 1
CMD ["bash", "/opt/s2s/start.sh"]
