# ai-gateway-sdk (Rust)

Typed async Rust client of the ai-gateway HTTP API (`serve.ts`, [docs/api/http.md](../../docs/api/http.md)). It is
the Rust counterpart of the Node SDK's `GatewayClient` (`sdk/node/gateway-client.ts`, [docs/api/client.md](../../docs/api/client.md))
and also covers what the babelcast desktop app's hand-written client (`bc-gateway-client`) uses: STT, chat, TTS
with voice cloning, live rooms, deployments wake/status, activation, desktop-app telemetry and health.

- reqwest 0.12 + tokio, **rustls only** (no OpenSSL), so it builds with the Windows GNU toolchain.
- Crate `ai-gateway-sdk`, lib `ai_gateway_sdk`, standalone (its own `[workspace]`), `publish = false`.

```toml
[dependencies]
ai-gateway-sdk = { path = "../ai-gateway/sdk/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

## Client

```rust
use std::time::Duration;
use ai_gateway_sdk::{BreakerConfig, GatewayClient, RetryPolicy, TimeoutGroup};

// From the environment: AI_GATEWAY_URL, then GATEWAY_URL (default http://localhost:4000, as the CLI);
// AI_GATEWAY_API_KEY, then GATEWAY_API_KEY; X-App from GATEWAY_APP.
let gw = GatewayClient::from_env()?;

// Or explicitly (builder calls override the env when starting from GatewayClientBuilder::from_env()).
let gw = GatewayClient::builder()
    .base_url("https://parle-ai-gateway.up.railway.app")   // no /v1
    .api_key(std::env::var("GATEWAY_API_KEY").unwrap_or_default())
    .app("parle")                                          // optional X-App
    .user_agent("my-app/1.0")
    .timeout(TimeoutGroup::Tts, Duration::from_secs(60))    // stt/chat/tts 15 s, s2s 50 s, admin 30 s, health 10 s, rooms 8 s
    .retry(RetryPolicy::default())                          // see "Retries"
    .breaker(BreakerConfig::default())                      // opt-in, see "Breaker"
    .build()?;
```

`GatewayClient` is `Clone` (shared connection pool). A custom `reqwest::Client` can be injected with
`.http_client(...)`. Cancel any call by dropping its future; drop a stream to close its connection.

When the key changes at runtime (e.g. a desktop app activated after start), `gw.with_api_key(new_key)` (and
`gw.with_app(app)`) returns a client with the new credential that shares the connection pool and the breaker.

Secrets never show up in `Debug` output or error texts: `GatewayClient`, `GatewayClientBuilder`, `Room`
(`publish_token`) and `FallbackCredential` (provider `api_key`) print `<redacted>`, and a decode error of an answer
that carries secrets (room creation, fallback plan) does not keep the body.

## OpenAI-compatible routes

```rust
use ai_gateway_sdk::*;
use futures_util::StreamExt;

// STT: POST /v1/audio/transcriptions (multipart). WAV / Ogg / FLAC / MP3 / WebM detected from the bytes.
let t = gw.transcribe(
    TranscribeRequest::new("babelcast-stt", wav_bytes)
        .language("fr")
        .prompt("vocabulary: Lyon, Rhône")
        .verbose()                          // response_format=verbose_json → t.language, t.duration, t.segments
        .timeout(Duration::from_millis(2500)),
).await?;
println!("{} — provider {:?}, filter {:?}", t.text, t.served.provider, t.stt_filtered);

// Chat: POST /v1/chat/completions
let c = gw.chat(ChatRequest::new("babelcast-llm", vec![ChatMessage::system("Translate to English."), ChatMessage::user("Bonjour")])
    .max_tokens(160)
    .extra("top_k", serde_json::json!(20))).await?;
println!("{:?}", c.content());

// Streamed chat (SSE): returns at the headers (served is final), then yields content deltas
let mut s = gw.chat_stream(ChatRequest::new("parle-llm", messages).include_usage(true)).await?;  // usage() needs it
while let Some(delta) = s.next().await { print!("{}", delta?); }
println!("\n{:?} {:?}", s.finish_reason(), s.usage());

// TTS: POST /v1/audio/speech (buffered), with voice cloning as in bc-gateway-client tts_body
let audio = gw.speech(
    SpeechRequest::new("babelcast-tts", "Bonjour à tous", "Ryan")
        .response_format("wav")
        .language("French")
        .instructions("calm, slower")
        .clone_voice("data:audio/wav;base64,UklGR…", "exact words of the reference"),
).await?;
let wav = fix_streaming_wav(audio.audio.to_vec()); // repairs vLLM-Omni "streaming" WAV headers

// TTS streamed (wav/pcm arrive as chunks)
let mut pcm = gw.speech_stream(SpeechRequest::new("parle-tts", "Olá", "br-f-01").response_format("pcm")).await?;
while let Some(chunk) = pcm.next().await { player.push(&chunk?); }
```

`served` (`Served { provider, fallback, fallback_from, request_id, status }`) comes from `X-Gateway-Provider`,
`X-Gateway-Fallback`, `X-Gateway-Fallback-From`, `X-Request-Id` and `X-Gateway-Status` on every answer (and on `Status`
errors). `served.is_degraded()` is `X-Gateway-Status: degraded`: an app whose profile requires its GPU was answered by
the cloud reserve.

## Streaming transcription — `GET /v1/audio/transcriptions/stream` (WebSocket)

Whisper large-v3 on the app's own GPU, the vocabulary prompt on every decode ([docs/api/stt-stream.md](../../docs/api/stt-stream.md)).
Every refusal comes before the handshake as a normal `Status` error with the batch route's codes: fall back to
`gw.transcribe(..)` on any of them.

```rust
let stream = match gw.transcribe_stream(
    TranscribeStreamRequest::new("babelcast-stt").language("pt").prompt(slide_terms).chunk_size(1.0).window(8.0),
).await {
    Ok(s) => s,                                  // s.ready().provider == Some("deployment:babelcast-gpu")
    Err(e) => return batch_fallback(e),          // e.code(): gpu_not_ready (503, Retry-After), no_streaming_backend, …
};
let (tx, mut rx) = stream.split();
tx.send_samples(&pcm_16k).await?;                // or send_pcm(&le_bytes); frames of 20–100 ms
tx.set_prompt(Some(&new_slide_terms)).await?;    // the slide changed (takes effect on the next decode)
tx.set_language("fr").await?;                    // the speaker switched language
tx.flush().await?;                               // end the open utterance now
while let Some(event) = rx.next_event().await {  // cancel-safe (select! is fine)
    match event? {
        SttStreamEvent::Partial(p) => show(&p.stable, p.provisional()),   // stable words never change
        SttStreamEvent::Final(f) => commit(f.utterance, &f.text),         // decoded fresh; "" + f.filtered = hallucination
        SttStreamEvent::Closed { code, reason } => { /* 1013 gpu_lost → reconnect or batch; 1008 → stop */ break }
        _ => {}
    }
}
```

The WebSocket client is in the crate (reqwest's HTTP/1.1 upgrade + an RFC 6455 client codec): no extra dependency. The
upgrade goes through an HTTP/1.1-only reqwest client (an HTTP/2 connection cannot be upgraded); with a custom
`http_client(..)`, that client must be able to speak HTTP/1.1.

## Speech detection on the device — feature `audio`

```toml
ai-gateway-sdk = { git = "https://github.com/marcosremar/ai-gateway", rev = "…", features = ["audio"] }
```

The ucast.me desktop app's front end for any Rust app (crate `ai-gateway-audio`, `sdk/rust-audio`): a level for
what the VAD hears, Silero VAD and the speech segmenter. Without the feature nothing of it is compiled and ONNX
Runtime is never linked; with it, the VAD is created on the first audio frame (ONNX Runtime from `ORT_DYLIB_PATH`
or `use_onnx_runtime_at`).

```rust
use ai_gateway_sdk::SpeechDetector;

let mut speech = SpeechDetector::new();                 // the app's settings, nothing loaded yet
for chunk in mic_chunks {                               // 16 kHz mono f32, any size
    for segment in speech.push(&chunk)? {               // a whole sentence, cut at a pause
        let t = gw.transcribe_speech("parle-stt", &segment, Some("pt")).await?;
        println!("{}", t.text);
    }
}
```

`speech.mic_report()` says what is wrong with the microphone (far/echo, noisy, too quiet, clipping, hum; only
`MicIssue::hurts_transcription()` ones made transcripts worse on the ucast.me benchmark — see `sdk/rust-audio/README.md`).
The report also says what the room sounds like **while nobody talks** (`report.floor`: `DigitalSilence`,
`StudioQuiet`, `RoomAmbient`, `LoudFloor`, `MeetingFloor`, from the benchmark's measured pause floors): show
`report.advice_issues()` instead of `report.issues` — on a quiet floor "noisy" is the floor itself, not the voice.
The Node SDK (`AudioSegmenter.micReport()`, `adviceIssues`) and the Python SDK (`AudioSegmenter.mic_report()`,
`MicReport.advice_issues()`) carry the same rule.
`SpeechDetector::with_config(SegmenterConfig { .. })` changes the segmentation, `.without_level()` turns the level
off, `.segmenter()` reaches drafts at pauses (`take_peek`). The browser SDK has the same level in
`sdk/browser/voice` (`createVoiceLevel`, on by default in `createVoiceActivityPipeline`).

## TTS engine of the GPU — `POST /v1/audio/speech/engine`

The speech-stack GPU keeps ONE of Qwen3-TTS / Kokoro / Pocket loaded. When a session starts with its TTS alias, tell it:

```rust
match gw.select_tts_engine("babelcast-tts-pocket", false).await {
    Ok(c) => println!("{:?} on {:?}", c.engine, c.deployment),   // selected, or nothing to choose (c.reason)
    Err(e) if e.code() == "engine_in_use" => { /* another engine in use there: lines fall back; or force: true */ }
    Err(e) => eprintln!("{e}"),                                  // gpu_not_ready (503): requests fall back meanwhile
}
```

## Speech-to-speech — `POST /v1/s2s`

```rust
let cfg = S2SConfig { language: Some("pt".into()), voice: Some("br-m-08".into()),
    models: Some(S2SModels { stt: Some("parle-stt".into()), chat: Some("parle-llm".into()), tts: Some("parle-tts".into()) }),
    ..Default::default() };
let mut turn = gw.s2s(S2SRequest::new(utterance_wav, cfg)).await?;
while let Some(frame) = turn.next().await {
    match frame? {
        S2SFrame::Audio(pcm) => player.push(&pcm),                 // PCM s16le mono, 24 kHz unless audio_format says otherwise
        S2SFrame::Event(S2SEvent::Done { first_audio_ms, .. }) => println!("{first_audio_ms:?}"),
        S2SFrame::Event(S2SEvent::Error { code, message, partial, .. }) => eprintln!("{code:?}: {message} (partial {partial:?})"),
        S2SFrame::Event(ev) => println!("{ev:?}"),                  // route, transcript, sentence…
        S2SFrame::UnknownEvent(raw) => println!("newer event {raw}"),
    }
}
```

A frame longer than `S2S_MAX_FRAME_BYTES` (16 MiB; real frames are one JSON event or one PCM chunk) ends the stream
with a `stream_error` instead of buffering a corrupt length prefix (`S2SFrameDecoder::with_max_frame` to change it).

## Live rooms, deployments, apps, activation, health

```rust
// Rooms (docs/rooms.md): create with the gateway key, publish with the room's token
let rooms = gw.rooms().with(CallOptions::timeout(Duration::from_secs(5)));
let room = rooms.create(&CreateRoom::new(["en", "es"]).title("Aula").original_lang("pt")).await?;
rooms.publish_line(&room, &RoomLine { id: 1, original: "Olá".into(), original_lang: Some("pt".into()),
    translations: [("en".to_string(), "Hello".to_string())].into(), ts_ms: Some(now_ms), delay_ms: Some(1800), draft: false }).await?;
rooms.publish_audio(&room, 1, "en", &wav_base64).await?;
// PUT /v1/rooms/:code/voice: the speaker's voice for server dubbing in that voice (memory only, never served)
rooms.publish_voice(&room, "pt", "data:audio/ogg;base64,…", "what the reference says").await?;
// PATCH /v1/rooms/:code {"youtubeUrl"} → 200 {code, youtubeUrl} (the stored, normalized link; None = cleared)
let upd = rooms.update_youtube(&room, Some("https://youtu.be/…")).await?;
rooms.end(&room).await?;
let snapshot = gw.rooms().get(&room.code).await?;                    // public GET

// Deployments (admin key, or a client key with canStartGpu for wake/park)
gw.deployments().wake("parle-speech").await?;
let view = gw.deployments().get("parle-speech").await?;              // None on 404
if let Some(v) = view { println!("{} ready={} last_error={:?}", v.status, v.is_ready(), v.last_error); }
gw.deployments().put("parle-speech", &serde_json::json!({ "appImage": "speech-stack", "minReplicas": 0 })).await?;
gw.deployments().park("parle-speech").await?;

// App accounts. PUT replaces every alias of the app: RouteEntrySpec types every field of the gateway's entry and
// keeps unknown ones in `extra`, so routes() → edit → put_routes() loses nothing.
let mut routes = gw.apps().routes("parle").await?;
gw.apps().put_routes("parle", &routes).await?;
let plan = gw.apps().fallback_plan("parle").await?;                  // carries provider keys: keep in memory

// Activation (key in the body, no Bearer)
let account = gw.activate("ucast_live_…", "My PC", "1.2.3").await?;

// Desktop-app telemetry (docs/app-telemetry.md): never retried; 429/503/507 carry Retry-After
let batch = AppEventsBatch { install_id, app_version: "1.2.3".into(), os: "windows".into(),
    events: vec![serde_json::json!({ "ts": now_ms, "kind": "app_start", "fields": {} })] };
let stored = gw.upload_app_events(&batch, &CallOptions::timeout(Duration::from_secs(30))).await?;

// Health
let h = gw.health().await?;          // GET /health
let ok = gw.is_healthy().await;      // never fails
let deep = gw.health_deep().await?;  // ?deep=1 (admin)
```

Rooms notes:
- `publish_line` is idempotent: the gateway adds **or replaces** the line with the same `id`, so it is retried like
  the other idempotent calls (a corrected line can be re-sent with the same `id`). `publish_audio` (broadcast once)
  and `end` are not retried. `publish_voice` replaces the room's reference for that language, so it is retried too.
- `update_youtube` and `CreateRoom::youtube_url` need a gateway that serves `PATCH /v1/rooms/:code` and stores
  `youtubeUrl` (ai-gateway `main` ≥ 0f6ac49). Older gateways answer **405** to the PATCH and ignore `youtubeUrl` on
  create. A body-less 2xx is accepted too (the result then echoes the requested link).

## Errors

Every failure is a `GatewayError`:

| Variant | When | `code()` | `is_unreachable()` |
|---|---|---|---|
| `Http { path, unreachable, source }` | transport error before the headers: connection refused, DNS, TLS, connect timeout (`unreachable`), or a reset after the request went out (not unreachable) | `network` | true only for connect / connect-timeout failures |
| `Timeout { path, after, headers_received }` | the call's deadline fired | `timeout` | `!headers_received` |
| `Status(Box<StatusError>)` | non-2xx answer — `status`, `code` (gateway `error.code`/`error.type`, else `not_found`, `rate_limited`, `http_502`, `warming`…), `message`, `body`, `details` (JSON), `retry_after`, `served` | the code | 502/503/504 **without** the gateway's own JSON error |
| `Stream { path, code, message, served, details }` | a buffered body cut after the headers (code `bad_response`, as the Node SDK); an SSE / s2s stream broke (`stream_error`); an in-band `{"error": …}` chat event (its code, raw object in `details`) | the code | false |
| `Decode { path, body, source }` | 2xx body that is not the expected JSON (`body` withheld for answers that carry secrets) | `bad_response` | false |
| `BreakerOpen { path }` | the opt-in breaker is open and `/health` still fails | `breaker_open` | true |
| `Config(String)` | bad base URL, bad MIME type, a request reqwest cannot build (e.g. a header value with a newline), unexpected answer shape | `config` | false |

Only unreachable errors are retried as connection errors and counted by the breaker: a request that could not be
built, or a body cut after the gateway answered, is neither.

Helpers: `status()`, `body()`, `details()`, `retry_after()` (seconds or HTTP date), `served()`, `path()`,
`as_status()`.

```rust
match gw.speech(req).await {
    Err(e) if e.status() == Some(503) => retry_later(e.retry_after()),  // replica starting
    Err(e) if matches!(e.status(), Some(400 | 404 | 415 | 422)) => fall_back_to_preset_voice(),
    other => other?,
}
```

## Retries

Same rule as the Node SDK: **only idempotent calls** are retried (GET, PUT, PATCH, DELETE, deployment `wake` /
`park`, room `publish_line`), at most 2 times (200 ms, 600 ms). On top of the Node SDK's connection-error retries,
they are also retried on 408 / 429 / 500 / 502 / 503 / 504, honouring `Retry-After` up to `max_retry_after` (5 s)
within a total `budget` (10 s); a longer `Retry-After` returns the error at once (read `e.retry_after()`), and a
`429` for an exhausted daily budget is never retried. **Paid or act-once calls** (transcriptions, chat, speech, s2s,
room `publish_audio` / `end`, activation) are not retried — the gateway already falls back and hedges between
providers — unless `RetryPolicy { retry_non_idempotent: true, .. }`. Timeouts are never retried.
`RetryPolicy::none()` turns retries off.

## Breaker

Opt-in (`.breaker(BreakerConfig { threshold: 3, recheck_interval: 1 s, probe_timeout: 3 s })`). After `threshold`
consecutive *unreachable* failures of an inference call (transcribe, chat, chat_stream, speech, speech_stream, s2s),
each call first probes `GET /health` (shared, at most once per `recheck_interval`): the breaker closes as soon as the
gateway answers, otherwise the call fails fast with `BreakerOpen`. Errors the gateway answered itself never count.
`gateway_state()` returns `{ breaker: Closed|Open|Probing, consecutive_failures, opened_at_ms, last_error }`. This is
the Node `GatewayBreaker` behaviour for calls without a direct route (the Rust SDK has no direct fallback, below).

## Parity

`GatewayClient` = Node `sdk/node/gateway-client.ts`. Python = `sdk/python/gateway_sdk` (`GatewaySDK`, the client of
the **legacy** routes: `/v1/transcribe`, `/v1/translate`, `/v1/gpu/*`…). babelcast = `bc-gateway-client` (what it uses
of the current API).

| Feature | Node `GatewayClient` | Python `GatewaySDK` | Rust |
|---|---|---|---|
| Base URL / key / `X-App` / injectable HTTP client | yes | URL + key | yes (`builder`, `http_client`) |
| URL / key from env | no | no | yes (`AI_GATEWAY_URL`/`GATEWAY_URL`, `AI_GATEWAY_API_KEY`/`GATEWAY_API_KEY`, `GATEWAY_APP`) |
| Per-group timeouts + per-call override | yes | per stage | yes (+ `rooms` group) |
| `X-Gateway-Device`, `X-Request-Id` per call | device | — | both (`CallOptions`) |
| Typed error (status, code, body, Retry-After, served, unreachable) | `GatewayError` | `GatewayError` | `GatewayError` enum |
| `served` from `X-Gateway-Provider` / `-Fallback` / `-Fallback-From` | yes | — | yes (+ `X-Request-Id`, `X-Gateway-Status`) |
| Retry idempotent calls on connection errors | yes (2×) | yes | yes (2×) |
| Retry on 408/429/5xx with `Retry-After` within a budget | no | — | yes (idempotent; opt-in for paid calls) |
| `transcribe` (multipart file, model, language, prompt, response_format) | yes | legacy `/v1/transcribe` | yes (+ container detection, `X-STT-Filtered`) |
| `filter_hallucinations=false` (QA opt-out of the gateway's filter) | **not sent**: `TranscribeRequest.filterHallucinations` exists but `transcribe` never adds it to the form; only its direct fallback's local filter reads it | — | sent as a multipart field |
| `chat` / `chatStream` (SSE, finish_reason, usage, in-band error) | yes | `chat` | `chat` / `chat_stream` (+ `include_usage` setter, raw in-band error in `details()`) |
| `speech` (streamed body) | yes | — | `speech` (buffered) + `speech_stream` |
| TTS voice cloning fields (`task_type`, `ref_audio`, `ref_text`) | free-form fields | — | typed `clone_voice` (+ `extra`) |
| `s2s` frames (`S2SFrameDecoder`, typed events) | yes | — | yes |
| `deployments` list/get/put/patch/pause/resume/wake/park/delete, `invokeUrl` | yes | legacy `/v1/gpu/*` | yes |
| `appRoutes` get/put, `apps` get/getImage/putImage/fallbackPlan | yes | — | yes (`apps()`) |
| `health` / `health({deep})` | yes | `health`, `health_detail` | `health`, `health_deep`, `health_details`, `is_healthy` |
| `GET /v1/models` | — | — | `models()` |
| On-device speech detection (Silero VAD + level + segmenter) | — (browser: `sdk/browser/voice`, `createVoiceLevel`) | — | feature `audio`: `SpeechDetector`, `transcribe_speech` (crate `ai-gateway-audio`) |
| Microphone advice (far/echo, noisy, quiet, clipping, hum) + the room's floor | — (browser: `createMicCheck`) | `AudioSegmenter.micReport()` + `adviceIssues` (`sdk/node/audio`) |  `AudioSegmenter.mic_report()` + `MicReport.advice_issues()` (`sdk/python`) | feature `audio`: `SpeechDetector::mic_report`, `MicCheck`, `Floor`, `MicReport::advice_issues` |
| Rooms create / lines / audio / end / GET | — | — | yes (babelcast parity) |
| Rooms `PATCH /v1/rooms/:code` `{youtubeUrl}` | — | — | yes (`update_youtube`; ai-gateway `main` ≥ 0f6ac49, older gateways 405) |
| Rooms `PATCH /v1/rooms/:code` `{serverDub}` | — | — | yes (`update_server_dub`; older gateways 400) |
| Rooms `PUT /v1/rooms/:code/voice` `{lang, ref_audio, ref_text}` | — | — | yes (`publish_voice`; older gateways 404) |
| Swap the API key at runtime, sharing the pool | — | — | `with_api_key`, `with_app` |
| `POST /v1/activate` | — | — | yes (babelcast parity) |
| `POST /v1/telemetry/app/events` (desktop-app telemetry) | — | — | `upload_app_events` (babelcast parity) |
| `fix_streaming_wav` | — | — | yes (from babelcast) |
| Client breaker on the gateway (`gatewayState`) | with `directFallback` | — | opt-in, probe-before-call |
| **Direct fallback** (call providers with the fallback plan when the gateway is down) | yes | own provider race | **not ported** |
| **Instability log / `reportInstabilities`** (`POST /v1/apps/:app/stability-report`) | yes | — | **not ported** |
| `AudioSegmenter` (client VAD segmentation, `audio.ts` / `audio.py`) | yes | yes | **not ported** |
| Server telemetry emitter (`telemetry.ts`) | yes | — | **not ported** |
| Legacy `GatewayHttpClient` (`index.ts`): `/v1/transcribe`, `/v1/gpu/*`, `/v1/bot/*`… | yes | that is the Python SDK | **not ported** (routes not mounted by `serve.ts`) |
| Browser SDK (realtime WebRTC/WS, voice, telemetry) | — (browser package) | — | **not ported** (browser-only) |

Why not ported:
- **Direct fallback + instability reports**: server-side only, large (`direct-fallback.ts`, plan store with TTL,
  provider-specific request shapes, local hallucination filter), and they hand provider keys to the client. The Rust
  callers today (desktop app) must never hold provider keys. The `FallbackPlan` type and `apps().fallback_plan()` are
  there for a future port.
- **AudioSegmenter / telemetry**: not part of the HTTP client; a Rust app has its own VAD (babelcast uses Silero).
- **Legacy routes** (`/v1/transcribe`, `/v1/translate`, `/v1/gpu/*`, `/v1/bot/*`, `/v1/config/*`, `/v1/playground/*`,
  `/v1/speech`): `serve.ts` does not mount them (docs/api/sdk.md marks them legacy).
- **babelcast-specific policy** (STT model fallback list, "API only" mode, retry of TTS without `language` on
  400/422, activation-key storage, its own `/ws` client for its Rust gateway): app policy, kept in the app on top of this
  crate.

## Building and testing

The tests run against a local mock gateway (axum on `127.0.0.1:0`); no network. On the Windows dev machine (GNU
toolchain, no MSVC linker):

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;" + ((@("$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin","$env:LOCALAPPDATA\winlibs\mingw64\bin") | Where-Object { Test-Path $_ } | Select-Object -First 1)) + ";$env:PATH"
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:CARGO_TARGET_DIR = "$env:USERPROFILE\.aigw-rust-sdk-target"
cmd /c "cargo test > test.log 2>&1"
cmd /c "cargo clippy --all-targets -- -D warnings > clippy.log 2>&1"
```

Live (ignored by default; free calls only, unless `AIGW_LIVE_PAID=1` + `AIGW_LIVE_CHAT_MODEL`):

```powershell
$env:AI_GATEWAY_URL = 'https://parle-ai-gateway.up.railway.app'; $env:GATEWAY_API_KEY = '…'
cmd /c "cargo test --test live -- --ignored --nocapture > live.log 2>&1"
```
