# speech-stack — STT + LLM + TTS in one image, streamed

One container on one GPU: hear → think → speak, with the answer cut into sentences while the LLM streams and each sentence
sent to the TTS at once, so the student hears the first words before the reply is finished.

| Stage | Model | Engine |
|---|---|---|
| STT | Whisper large-v3, **float16** (full precision) | faster-whisper 1.2.1, in the orchestrator process |
| LLM | Qwen3.5-9B Q4_K_M (GGUF, 5.7 GB) | llama.cpp b11382, CUDA, 8 slots × 2048 tokens |
| TTS | Qwen3-TTS 12Hz 0.6B Base (voice cloning) | vLLM-Omni 0.28.0, streaming PCM |

`/v1/s2s` config may carry `response_format` (passed to llama.cpp) and `speak_field`: then only that field of the JSON
answer is voiced, as it streams, and `done.reply_raw` has the whole JSON (`JsonField`, tests in `test_json_field.py`).

Files: `Dockerfile`, `start.sh` (start order TTS → LLM → STT; refuses to start if llama.cpp sees no `CUDA0`),
`server.py` (orchestrator + API, see its docstring), `test_cut.py` (sentence cutter), `bench.py` (latency bench).
Build: `bun scripts/build-image-on-scaleway.ts docker/speech-stack speech-stack` → `rg.fr-par.scw.cloud/aigw/speech-stack:<tag>`.
Deploy: `PUT /v1/deployments/<name>` with that `image`, `port: 8000`, `healthPath: /health`, `machineType: L4-1-24G`,
`registryAuth` for the Scaleway registry, and the reference voices as `files` (`voices.json` + audio; see `load_voices`).

## Measured (2026-10-04, L4-1-24G fr-par-2, image `speech-stack:20261004-2129`, `STT_WORKERS=2`)

Student clip: gTTS pt-BR «Bom dia! Eu queria um pão francês, por favor.» (5.3 s). Voice: Seu Jorge (`br-m-08`). Times from the
moment the server has the audio; "client" adds the path from the test sandbox through a local gateway to Paris and the upload.
3 rounds per level, every student sending at the same instant (worst case).

| Students at once | STT | LLM 1st token | 1st sentence cut | **1st audio (server)** | 1st audio (client) | errors |
|---|---|---|---|---|---|---|
| 1 | 375 ms | 443 ms | 538 ms | **753 ms** | 1 198 ms | 0 / 3 |
| 4 | 1 392 ms | 1 708 ms | 2 015 ms | **2 434 ms** (p95 2 878) | 2 901 ms | 0 / 12 |
| 8 | 2 530 ms | 2 935 ms | 3 440 ms | **4 791 ms** (p95 6 487) | 5 247 ms | 0 / 24 |

- One student: STT 375 ms, then 68 ms to the LLM's first token, 95 ms to the first sentence («Bom dia!»), 215 ms to the TTS's
  first PCM byte. LLM alone: 43 tokens/s generation.
- Under load the STT is the queue: two float16 decodes at a time (four did not fit next to the TTS and the LLM — CUDA out of
  memory on 5/12 and 18/24 requests with `STT_WORKERS=4`). The measured STT time includes that wait.
- Cold start (create the L4, pull ~57 GB from the registry next door, load, warm): 8–8.6 min.

## Measured on L40S (2026-10-04, L40S-1-48G fr-par-2, image `speech-stack:20261004-2240`, STT batching on)

Same clip, voice and method as the L4 table above. `STT_BATCH=8`, `LLM_PARALLEL=16`, `TTS_STAGE0_MB=12000`.
Times from the moment the server has the audio. Every student sends at the same instant.

| GPUs | Students at once | STT | LLM 1st token | **1st audio (server)** p50 / p95 | 1st audio (client) | errors |
|---|---|---|---|---|---|---|
| 1× L40S | 1 | 230 ms | 284 ms | **417 / 420 ms** | 860 ms | 0 / 3 |
| 1× L40S | 8 | 707 ms | 1 747 ms | **2 327 / 2 380 ms** | 2 771 ms | 0 / 24 |
| 1× L40S | 16 | 1 114 ms | 2 690 ms | **3 539 / 3 580 ms** | 3 996 ms | 0 / 48 |
| 2× L40S | 8 | 417 ms | 1 055 ms | **1 401 / 2 135 ms** | 1 851 ms | 0 / 24 |
| 2× L40S | 16 | 626 ms | 1 481 ms | **1 939 / 2 391 ms** | 2 407 ms | 0 / 48 |

- With batching, the STT stops being the line. On one L40S, Whisper takes 0.7 s for 8 simultaneous clips, against 2.5 s
  on the L4 without batching. The wait moves to the LLM's prompt reading: STT → first token takes 1.0–1.6 s with 8–16
  prompts at once on one card.
- Cold start of an L40S: 8.6–8.8 min. The two replicas split the students through the gateway (in-flight routing).
- Price (Scaleway, 2026-10-04): L40S-1-48G €1.47/h, L4-1-24G €0.79/h.
- In the first run on one L40S, one stream ended mid-body: "incomplete chunked read" between client, local gateway
  and replica. It aborted the bench before the summary. `bench.py` now records such a failure as an error instead of
  stopping. The next 75 + 72 requests had none.

### Found and fixed on the way

- llama.cpp silently fell back to the CPU (7 tokens/s): its CUDA backend needs `libnccl.so.2`. The image carries the exact CUDA 12
  libs it was built with; `start.sh` exits without `CUDA0`.
- faster-whisper 1.2.1 + PyAV 19: `open(metadata_errors=…)` TypeError on every request; audio is decoded with ffmpeg instead.
- `huggingface_hub` 2.x pulled `tokenizers` back to a source-only release; the venv is wheels-only with `huggingface_hub<1`.

### STT batching (`stt_batch.py`)

Utterances that arrive within `STT_BATCH_WINDOW_MS` (25 ms) of each other go through Whisper in one encoder + decoder pass,
up to `STT_BATCH` clips (L4: 4, L40S: 8). Same features and decoding options as faster-whisper's own batched pipeline,
float16, language given; a batched transcript that looks like a repetition loop (compression ratio > 2.4, Whisper's own
test) is decoded again alone with the temperature fallback, and clips over 30 s or without a language go alone. CUDA out
of memory splits the batch in halves (a single clip retries 3×). `GET /health` reports `stt: {batches, clips, largest,
oom_retries, fallbacks}`. Checked on CPU with Whisper tiny (`test_stt_batch.py`): four clips decoded together give the
same text as one at a time, and silence comes back empty.
