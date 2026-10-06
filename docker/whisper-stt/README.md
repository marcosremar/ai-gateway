# whisper-stt — Whisper large-v3 STT in one small container

The "hear" stage of `docker/speech-stack` as a standalone image: faster-whisper
large-v3 + the same `SttBatcher` (cross-request batching) and `SttStream`
(rolling-window realtime decode). No LLM, no TTS.

Runs on **CPU** out of the box (`int8`) — local dev machines, cheap cloud VMs —
and on **CUDA** when the device libraries are present (`STT_DEVICE=cuda`,
`STT_COMPUTE=float16`).

## Build & run

Build context is `docker/` (the image reuses `speech-stack/stt_batch.py` and
`speech-stack/stt_stream.py`):

```bash
docker build -f docker/whisper-stt/Dockerfile -t whisper-stt docker/
docker run -p 8000:8000 whisper-stt
```

The model (~3 GB) is baked at build time — cold start serves immediately,
nothing is downloaded at boot.

## Endpoints

| Route | What |
|---|---|
| `POST /v1/audio/transcriptions` | OpenAI-compatible batch STT (multipart `file`, `language`, `prompt`) → `{text, language, duration, ms}` |
| `WS /ws/audio-stream` | Binary Int16 PCM 16 kHz frames in → `{"text": <full transcript>}` out; text control frame `{"type":"flush"}` forces a final decode. Query: `language`, `chunk_size` |
| `GET /health` | `503 {"stt":"loading"}` while the model loads → `200 {"stt":"loaded"}`. Compatible with the gateway's stage-aware replica probe. |

## Env

| Var | Default | Notes |
|---|---|---|
| `STT_MODEL` | `large-v3` | any faster-whisper id (`distil-large-v3`, `medium`, …) — also a build arg |
| `STT_DEVICE` | `auto` | `cpu`/`cuda`; auto = cuda if ctranslate2 sees a device |
| `STT_COMPUTE` | `auto` | auto = `float16` on cuda, `int8` on cpu |
| `STT_BATCH` | `4` | max clips sharing one decode pass |
| `STT_BATCH_WINDOW_MS` | `25` | batching window |
| `STT_BEAM` | `1` | beam size |
| `STT_CPU_THREADS` | `0` | 0 = ctranslate2 picks (physical cores) |

## Gateway wiring

Point the streaming STT router at it with `STT_DEPLOYMENT` (deployed via the
`DeploymentController`) or run it next to the gateway locally:

```bash
curl -F file=@clip.wav -F language=pt http://localhost:8000/v1/audio/transcriptions
```
