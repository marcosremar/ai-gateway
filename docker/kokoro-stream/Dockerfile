FROM python:3.12-slim
COPY requirements.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt
ARG KOKORO_STREAM_REPO=marcosremar2/kokoro-82m-streaming-onnx
ARG KOKORO_STREAM_REVISION=8bc34e57e9aa89edbbc9be2eb9e7ba18caa0ac99
ENV KOKORO_STREAM_DIR=/models/kokoro-stream
RUN hf download "$KOKORO_STREAM_REPO" --revision "$KOKORO_STREAM_REVISION" --local-dir "$KOKORO_STREAM_DIR" \
 && cd "$KOKORO_STREAM_DIR" && sha256sum -c models.sha256 && rm -rf .cache
WORKDIR /app
COPY server.py normalize.py vowels.py pt_vowels.tsv ./
CMD ["sh", "-c", "exec uvicorn server:app --host :: --port ${PORT:-8000}"]
