FROM python:3.12-slim
RUN pip install --no-cache-dir onnxruntime==1.24.4 numpy==2.4.4 fastapi==0.135.3 'uvicorn[standard]==0.44.0' \
      misaki==0.7.4 phonemizer-fork==3.3.2 espeakng-loader==0.2.4 'huggingface_hub>=0.34'
ARG KOKORO_STREAM_REPO=marcosremar2/kokoro-82m-streaming-onnx
ARG KOKORO_STREAM_REVISION=a786a228fcb236f54cbd9cf7ea4a3fff3c2614c2
ENV KOKORO_STREAM_DIR=/models/kokoro-stream
RUN hf download "$KOKORO_STREAM_REPO" --revision "$KOKORO_STREAM_REVISION" --local-dir "$KOKORO_STREAM_DIR" \
 && cd "$KOKORO_STREAM_DIR" && sha256sum -c models.sha256 && rm -rf .cache
WORKDIR /app
COPY server.py .
CMD ["sh", "-c", "exec uvicorn server:app --host :: --port ${PORT:-8000}"]
