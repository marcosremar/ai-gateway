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

`WS /ws/audio-stream?language=pt&chunk_size=1.0` is the real-time STT the gateway's streaming router rides: binary
Int16 PCM 16 kHz frames in, `{"text": "<full running transcript>"}` out on every decode (`stt_stream.py` — windowed
decode on the same `SttBatcher`, commits on silence; `test_stt_stream.py`). A `{"type":"flush"}` text frame forces the
open buffer through the decoder. Until `/health` is warm the socket closes with 1013 so the client can hedge.

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

## Tunables added 2026-10-07 (same models, same decoding)

| Env | Default | Effect |
|---|---|---|
| `STT_BATCH_WINDOW_MS` | `25` (unchanged) | `0` now means: take what is already queued, never wait for more (before, `0` turned batching off). |
| `CUT_EAGER` | `0` | `1`: a `!` or `?` at the end of the text so far cuts at once instead of waiting one more LLM token. A `.` still waits (`3.` may become `3.50`). |
| `TTS_STAGE_OVERRIDES` | unset | JSON for `vllm serve --stage-overrides` (vLLM-Omni 0.28.0, `docs/serving/speech_api.md`); replaces `--gpu-memory-utilization`, so it must carry `gpu_memory_utilization` per stage. |
| `TTS_DEPLOY_CONFIG` | `qwen3_tts.yaml` next to `start.sh` | Path of a deploy YAML for `vllm serve --deploy-config` (connector fields such as `ref_code_context_frames` are not reachable through stage overrides). A path that does not exist means the engine's bundled YAML. |
| `TTS_MAX_LEAD_SECONDS` | `1` | A sentence whose audio is still silent after this long is asked again once (see § TTS runaway). |
| `LLM_EXTRA_ARGS` | unset | Extra `llama-server` flags, e.g. `-b 4096 -ub 2048` (prompt-eval batch; b11382 defaults are 2048 / 512). |
| `S2S_DIR` | `/opt/s2s` | Directory uvicorn loads `server.py` from. |

`start.sh` starts llama.cpp with `--cache-ram 0` (b11382 default: 8192 MiB, with `--cache-idle-slots`). With the default,
the server saves idle slots to a host-RAM prompt cache on every new task; once the cache is full (about 3 min at 16
sessions, `llama-server` RSS 1.1 → 12.4 GB) every task first evicts an entry, 200 ms p50 / 800 ms max before prompt
evaluation, until the process restarts. Measured 2026-10-07, `docs/reports/2026-10-07-realtime-handoff.md` § Live A/B.
`LLM_EXTRA_ARGS="--cache-ram 8192"` restores the old behaviour.

Always on: a WAV that is already PCM16 mono 16 kHz skips the ffmpeg subprocess; final transcriptions are taken before the
partial decodes of `/ws/audio-stream`; closing that socket no longer decodes the buffer (a `flush` frame still does); the
warm-up speaks one line with every catalog voice.

llama.cpp b11382 already reuses the prompt prefix: `cache_prompt` defaults to `true` and an idle slot is chosen by
prompt similarity (`--slot-prompt-similarity`, default 0.10), so the stack sends neither. What it reused is now visible.

`/v1/s2s` metrics: `transcript.stt` = `{audio_ms, queue_ms, decode_ms, batch}`; `llm_first_token.llm` = llama.cpp
`{cache_n, prompt_n, prompt_ms, …}`; `done.stages` = `stt_audio_ms`, `stt_queue_ms`, `stt_decode_ms`, `stt_batch`,
`llm_first_token_ms` (from the transcript to the first token), `llm_cache_n`, `llm_prompt_n`, `llm_prompt_ms`,
`llm_predicted_n`, `llm_predicted_ms`, `text_wait_ms` (first token → first sentence cut), `tts_first_chunk_ms` (cut → first
PCM). Numbers only. `/v1/audio/transcriptions` returns the same four STT fields. `bench.py` prints p50/p95 of each stage.

Tests without a GPU: `for t in cut json_field wav_fast_path stt_queue stage_times tts_stream s2s_turn debug_logs; do python3 docker/speech-stack/test_$t.py; done`
(numpy only; `git add -f` a new one, the repo's `TEST_*` ignore rule matches them on macOS).

## Single-stage proxies never end a broken stream cleanly (2026-10-08)

`/v1/chat/completions` and `/v1/audio/speech` are proxies to llama.cpp and vLLM-Omni; a healthy stream is forwarded
byte for byte. `PROXY_MAX_GAP_S` (8, as `S2S_MAX_GAP_S`: the engines' first chunk comes in 55–300 ms and stalls inside a
stream stay under 200 ms, `docs/reports/2026-10-07-realtime-handoff.md`) bounds the wait for each chunk — and for the
response headers of a `stream: true` request; `PROXY_DEADLINE_S` (120, the gateway's own cap on a replica call) bounds
the whole request. An engine that breaks the body, stalls or runs past the deadline:

| When | Chat (SSE) | Speech (audio), non-SSE bodies |
|---|---|---|
| before the response started | `502` (broke) / `504` (stalled) with `{"error": {message, type: "upstream_error", code}}` | the same |
| after | a last `data: {"error": {…, code: "stage_failed" \| "upstream_stalled"}}` event, then the stream ends | the connection is aborted (no chunked terminator): the client gets a transport error |

One log line each (`proxy failed|stalled chat|speech <ms> <error>`), counted in `GET /health` →
`proxy: {chat: {started, done, failed, stalled}, speech: {…}}` (`started` − the rest = in flight or left by the
client). `test_stage_proxy.py` runs the real uvicorn + FastAPI + httpx stack against a fake engine (needs `fastapi`,
`httpx`, `uvicorn`).
## TTS runaway and silent leads (2026-10-08)

Qwen3-TTS Base sometimes opens a sentence by repeating silence codes: 0.3–1.7 % of sentences started with more than
1 s of silence (5.5 % with a 16 s reference clip), and about 1 in 1000 never left the loop. vLLM-Omni 0.28.0 then stops at
its own budget of `max(192, 12 × text tokens)` codec frames (15.4 s for a short sentence) and ends the stream as an error
(`Qwen3TTSCodecLimitError`, "did not emit codec EOS before its token budget (192/192 codec tokens)"). Three settings,
measured in `docs/reports/2026-10-07-realtime-handoff.md` § TTS runaway:

- `qwen3_tts.yaml` is vLLM-Omni 0.28.0's `vllm_omni/deploy/qwen3_tts.yaml` with one value changed: the talker's
  `repetition_penalty` 1.05 → 1.15. `start.sh` passes it as `--deploy-config`. Keep the rest equal to the engine's file
  when the base image changes.
- `tts_stream` sends `max_new_tokens` = the sentence's limit (`TTS_MAX_SECONDS` 3 + `TTS_MAX_SECONDS_PER_CHAR` 0.2 per
  character) in codec frames (12.5 per second), so the engine stops there instead of at 15.4 s.
- After its first chunk, a sentence's silent chunks (RMS ≤ 300) are held until sound arrives. Still silent after
  `TTS_MAX_LEAD_SECONDS`, or failed before any sound: the request is dropped and sent again once (new random seed),
  about 0.5 s later at 8 in parallel; the held silence is not played. `done.tts_retries` counts them. A sentence that
  fails after sound still ends the turn with `error` (stage `tts`).

## Engine logs: `GET /debug/logs`

`start.sh` writes each engine's stdout and stderr to `/var/log/{tts,llm,stt}.log` (`stt` is the orchestrator process:
Whisper runs inside it, so its log is also where every `/v1/s2s` failure is printed). A file is renamed to `.1` when it
passes `LOG_MAX_BYTES` (32 MB: vLLM-Omni writes about 6 KB per request), so the three logs hold at most 192 MB.

`GET /debug/logs?engine=tts|llm|stt&tail=200&match=<text>` returns the last `tail` lines (at most 2000, each cut at
2000 characters) that contain `match`, as plain text, read from the rotated file and the current one. Through the
gateway: `GET /v1/deployments/<name>/invoke/debug/logs?engine=tts&match=status=error`. The replica's front proxy asks
for the replica token on this route as on every other one, and the route itself answers 403 to a client that is not on
a private address (a container port published by mistake). Values of environment variables named like a secret, bearer
tokens, `token=`/`key=`/`password=` values and `hf_…`/`sk-…` keys come out as `[redacted]`.

Following one sentence into the TTS engine: for every TTS request the orchestrator prints
`tts <request_id> <UTC start> chars=… max_new_tokens=… audio_s=… ms=… outcome=ok|<error>` (in `stt`), and sends the id
as `extra_params.request_id`. vLLM-Omni 0.28.0 logs `Applied extra_params: {'request_id': '<id>'}` on the line after
`TTS speech request speech-<uuid>: model=Base`; that `speech-<uuid>` is the id of its `[SpeechE2E] … status=…` line.
No text, transcript or audio is written by the orchestrator.

## Shipping server code without rebuilding the image

The image keeps the models; the five files of `/opt/s2s` can come from the deployment's `files` (mounted read-only at
`/files`, next to `voices.json`). `PUT /v1/deployments/parle-speech`:

```json
{
  "entrypoint": "bash",
  "args": ["/files/start.sh"],
  "env": { "S2S_DIR": "/files" },
  "files": {
    "start.sh": "<base64>", "server.py": "<base64>", "stt_batch.py": "<base64>", "stt_stream.py": "<base64>",
    "qwen3_tts.yaml": "<base64>",
    "voices.json": "<base64>", "<every voice clip>": "<base64>"
  }
}
```

- `files` and `env` replace the stored ones as a whole (`buildSpec`): send the voice catalog and the current env again.
- Budget: all files together ≤ 1 680 000 bytes (`MAX_FILES_BYTES`, 14 user_data keys of 120 000); the four code files are
  about 45 KB. The cloud-init itself must stay under 127 998 bytes and is 3.5 KB with this spec.
- It reaches machines created after the PUT. A running or parked replica keeps the boot it was created with.
- Back to the image's own code: `"entrypoint": ""` is not accepted; PUT `"entrypoint": "bash", "args": ["/opt/s2s/start.sh"]`
  and drop `S2S_DIR`.
