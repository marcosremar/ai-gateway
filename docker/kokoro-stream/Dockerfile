FROM python:3.12-slim
# WITH_POCKET=1: Pocket TTS (pocket.py) in the image too — still off at run time until POCKET_TTS=1.
# POCKET_BAKE: languages whose Pocket weights and default voices are downloaded at build (none at start).
ARG WITH_POCKET=1
ARG POCKET_BAKE=pt,en,fr,es,it,de
ENV HF_HOME=/models/hf
COPY requirements.txt requirements-pocket.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && if [ "$WITH_POCKET" = 1 ]; then pip install --no-cache-dir -r /tmp/requirements-pocket.txt; fi
ARG KOKORO_STREAM_REPO=marcosremar2/kokoro-82m-streaming-onnx
ARG KOKORO_STREAM_REVISION=8bc34e57e9aa89edbbc9be2eb9e7ba18caa0ac99
ENV KOKORO_STREAM_DIR=/models/kokoro-stream KOKORO_STREAM_REVISION=$KOKORO_STREAM_REVISION
RUN hf download "$KOKORO_STREAM_REPO" --revision "$KOKORO_STREAM_REVISION" --local-dir "$KOKORO_STREAM_DIR" \
 && cd "$KOKORO_STREAM_DIR" && sha256sum -c models.sha256 && rm -rf .cache
WORKDIR /app
COPY server.py normalize.py vowels.py pt_vowels.tsv pocket.py ./
ARG POCKET_CUSTOM="pt erinome hf://marcosremar2/pocket-tts-erinome-pt/erinome_6l.yaml@84dc5f224359dcb5ab0a862688cabe54a4f40389 hf://marcosremar2/pocket-tts-erinome-pt/erinome_6l_voice.safetensors@84dc5f224359dcb5ab0a862688cabe54a4f40389"
RUN if [ "$WITH_POCKET" = 1 ]; then python -X utf8 pocket.py bake "$POCKET_BAKE" && rm -rf "$HF_HOME/xet"; fi
CMD ["sh", "-c", "exec uvicorn server:app --host :: --port ${PORT:-8000}"]
