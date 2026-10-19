# Streaming transcription — `GET /v1/audio/transcriptions/stream` (WebSocket)

Live subtitles on an app's own GPU: the audio goes up as it is spoken, the text comes back while the sentence is still
being said, and every decode uses the caller's vocabulary prompt (slide terms, names), as the batch route's `prompt`.
Behind it: the speech-stack replica's `WS /ws/audio-stream` (Whisper large-v3 float16, `docker/speech-stack/stt_stream.py`).
Code: `src/gateway/proxy/routes/transcription-stream.ts`; Rust client: `sdk/rust` `GatewayClient::transcribe_stream`.

It never falls back to a cloud provider by itself: when the GPU cannot stream, the upgrade is **refused before the
handshake** with the batch route's error shape, and the client keeps (or goes back to) `POST /v1/audio/transcriptions`,
whose chain does fall back.

## Connect

```
GET wss://<gateway>/v1/audio/transcriptions/stream?model=babelcast-stt&language=pt
Authorization: Bearer <app key | activation key>
Upgrade: websocket
```

| Query | | |
|---|---|---|
| `model` | required | the app's STT alias (an app key may only use its own aliases, as on the batch route). Admin keys may name `deployment:<name>`. The stream goes to the first `deployment:` link of the alias's chain that has a ready replica |
| `language` | optional | `pt`, `fr`, `en-US`… (Whisper reads the first two letters). Without it Whisper detects per decode |
| `prompt` | optional | Whisper `initial_prompt` for every decode, ≤ 2000 characters in the URL; a longer one (≤ 4000) goes in a `config` frame. faster-whisper keeps its last 223 tokens, as on the batch route |
| `chunk_size` | 1.0 | seconds of new audio between two decodes (0.2–5) |
| `window` | 20 | longest utterance in seconds (5–28): a longer one is cut at its quietest 100 ms in the last 3 s and ends as a `final` with `reason: "max_length"` |
| `silence` | 0.9 | seconds of quiet (RMS < 0.008) that end an utterance (0.3–3) |
| `wait_ms` | 0 | wait for a cold GPU up to this long (≤ 30000) instead of refusing at once |
| `filter_hallucinations` | on | `false` opts out of the hallucination filter (QA), as the batch route's form field |

## Refusals (HTTP, before the handshake)

Every one is `{"error": {"message", "type", "code"}}`, with `Retry-After` when it helps. Fall back to batch on any of them.

| Status | `code` | When |
|---|---|---|
| 400 | `missing_model`, `invalid_language`, `prompt_too_long`, `invalid_parameter` | bad query |
| 401 | | no / unknown key |
| 402 | `quota_exceeded` | activation key: the account's monthly transcription quota is used up |
| 403 | | the model is not an alias of the key's app; a non-admin key naming `deployment:` |
| 404 | `no_streaming_backend` | the alias has no `deployment:` link (e.g. a cloud-only alias) |
| 429 | `daily_budget_exhausted`, `too_many_streams`, … | the app's daily budget, the per-user slots, more than `STT_STREAM_MAX_PER_KEY` (2) streams for one key / account |
| 502 | `stream_unsupported`, `replica_refused`, `replica_unreachable` | the replica runs an image without this protocol, refused or is unreachable |
| 503 | `gpu_not_ready` | no ready replica (cold: woken by the attempt unless no-wake applies; saturated; still loading Whisper) |
| 504 | `gpu_timeout` | the replica did not accept the socket in time |

## Frames

Client → gateway:

| Frame | |
|---|---|
| binary | Int16 little-endian PCM, 16 kHz, mono; any size up to 256 KiB (send 20–100 ms frames) |
| `{"type":"config","prompt":"…"\|null,"language":"fr"}` | new prompt (null = none) and/or language for the next decodes, the open utterance included — e.g. when the slide changes or the speaker switches language. Answered by `{"type":"config","language","prompt_chars"}` |
| `{"type":"flush"}` | decode what is buffered now and end the open utterance (`final` with `reason: "flush"`) |
| `{"type":"ping"}` | answered by `{"type":"pong"}` (WebSocket pings are answered too) |

Anything else gets `{"type":"error","code":"bad_frame"}` and the stream goes on.

Gateway → client (text, JSON):

```json
{"type":"ready","model":"babelcast-stt","provider":"deployment:babelcast-3090","engine":"large-v3","language":"pt","prompt_chars":312}
{"type":"partial","utterance":0,"text":"Bom dia a todos, vamos","stable":"Bom dia a todos,","end_ms":2100}
{"type":"final","utterance":0,"text":"Bom dia a todos, vamos começar.","reason":"silence","start_ms":0,"end_ms":3400,
 "audio_ms":3400,"language":"pt","language_probability":0.99,"avg_logprob":-0.21,"no_speech_prob":0.01,
 "compression_ratio":1.2,"speech_ms":2900,"decode_ms":180}
{"type":"error","code":"gpu_lost","message":"…"}
```

- **One utterance at a time.** `partial.text` is the open utterance so far; it always starts with `stable`, and a
  stable word never changes in a later partial of the same utterance (LocalAgreement-2: the words two decodes in a row
  agree on). Show `stable` as settled and the rest as provisional.
- **`final`** ends the utterance (`silence`, `max_length` or `flush`) and is decoded fresh over its whole audio, exactly
  like the batch route would — it may still differ from the last partial; replace the partial with it. The next
  utterance has `utterance + 1`. No audio is decoded into two finals.
- **Hallucination filter**: the batch route's, on every final (metadata from the replica). An invented one arrives with
  `"text": ""` and `"filtered": [reason codes]` — never shown text.
- `*_ms` are on the stream's audio clock (bytes received ÷ 32).
- A window with no 100 ms frame above the silence threshold is dropped without a decode (Whisper invents words over
  silence).

## Close codes

| Code | `error.code` | Meaning — what the client does |
|---|---|---|
| 1000 | `idle`, `session_limit` | no frame for `STT_STREAM_IDLE_MS` (60 s); the stream reached `STT_STREAM_MAX_MINUTES` (240): reconnect |
| 1001 | | the client went away |
| 1008 | `quota_exceeded`, `daily_budget_exhausted` | quota or budget crossed mid-stream: stop (the batch route refuses too) |
| 1009 | `frame_too_large` | a frame over 256 KiB |
| 1013 | `gpu_lost` | the replica closed, failed or was released: reconnect, or fall back to batch |
| 1002 | `protocol_error` | not a valid WebSocket frame |

## Metering and limits

- **App budget** (`AppLimits`, non-admin keys): one request at admission, one more per started minute of audio.
- **Activation keys** (`src/accounts`): admitted against the account's `audioSeconds` quota and daily request cap; the
  audio seconds are added every 15 s while it streams, the stream counts as one request and one STT request at the end.
- **Device gate** (`X-Gateway-Device`) as on the batch route.
- The stream holds one lease of the replica for its whole life (the autoscaler sees it as in flight) and one of the
  proxy's per-user slots.
- Telemetry: one `stt.stream` event per stream (app, model, deployment, audio seconds, duration, finals, close code).
- Env: `STT_STREAM_MAX_PER_KEY` (2), `STT_STREAM_MAX_MINUTES` (240), `STT_STREAM_IDLE_MS` (60000),
  `STT_STREAM_ACQUIRE_WAIT_MS` (0).

## Replica side (speech-stack image)

`WS /ws/audio-stream?segments=1&language=&chunk_size=&window=&silence=` with the replica token; the gateway sends the
prompt as the first `config` frame and waits for the replica's `{"type":"ready"}` before answering the client's
handshake. Without `segments=1` the replica keeps the legacy protocol of `StreamingSTTRouter` (`{"text": <whole stream>}`).
A replica still loading Whisper accepts and closes with 1013. Images built before this protocol never send `ready`:
the gateway refuses with 502 `stream_unsupported`.
