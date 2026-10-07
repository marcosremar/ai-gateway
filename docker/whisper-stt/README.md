# whisper-stt — Whisper large-v3 STT + Qwen3.5-9B LLM (translation) in one container

The "hear + think" stages of `docker/speech-stack` as a standalone image: faster-whisper
large-v3 (STT) + Qwen3.5-9B Q4_K_M on llama.cpp (chat/translation). **No TTS** — dubbing
stays on the gateway (cloud or local-say), keeping this image small and CPU-friendly.

Runs on **CPU** out of the box (`int8` — local dev machines, cheap cloud VMs) and on
**CUDA** when the device libraries are present (`STT_DEVICE=cuda`, `STT_COMPUTE=float16`).

## Build & run

Build context is the `docker/whisper-stt/` directory itself (self-contained: the
batching/streaming modules are copied alongside the server, so the remote build script
works):

```bash
docker build -f docker/whisper-stt/Dockerfile -t whisper-stt docker/whisper-stt/
docker run -p 8000:8000 whisper-stt
```

Or publish to the gateway's Scaleway registry (builds on a short-lived Scaleway machine):

```bash
bun scripts/build-image-on-scaleway.ts docker/whisper-stt whisper-stt
```

Models are baked at build time (whisper ~3 GB + Qwen GGUF ~5.3 GB) — cold start serves
immediately, nothing is downloaded at boot.

## Endpoints

| Route | What |
|---|---|
| `POST /v1/audio/transcriptions` | OpenAI-compatible batch STT (multipart `file`, `language`, `prompt`) → `{text, language, duration, ms}` |
| `POST /v1/chat/completions` | OpenAI-compatible chat — proxied to llama.cpp (Qwen3.5-9B Q4_K_M). Use it for translation. Streaming passes through. |
| `WS /ws/audio-stream` | Binary Int16 PCM 16 kHz frames in → `{"text": <full transcript>}` out; text control frame `{"type":"flush"}` forces a final decode. Query: `language`, `chunk_size` |
| `GET /health` | `503 {"stt":"loading","llm":"loading"}` while warming → `200 {"stt":"loaded","llm":"loaded"}`. Compatible with the gateway's stage-aware replica probe. |

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
| `LLM_FILE` | `Qwen3.5-9B-Q4_K_M.gguf` | GGUF file (baked) |
| `LLM_THREADS` | `4` | llama.cpp threads |
| `LLM_CTX` | `2048` | llama.cpp context |
| `LLM_PORT` | `8092` | internal llama.cpp port (proxied at `/v1/chat/completions`) |

## Gateway wiring

Point the streaming STT router at it with `STT_DEPLOYMENT` (deployed via the
`DeploymentController`) or run it next to the gateway locally:

```bash
curl -F file=@clip.wav -F language=pt http://localhost:8000/v1/audio/transcriptions
curl http://localhost:8000/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"llm","messages":[{"role":"user","content":"Traduza: bom dia"}]}'
```

The gateway can use the local LLM as the translation fallback (`LLM_URL` pointing at
`http://<whisper-stt>:8000/v1`) so STT + translation work fully offline.
