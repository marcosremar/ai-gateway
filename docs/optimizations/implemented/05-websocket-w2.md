# Implemented — #05 WebSocket / Streaming / Real-time Transport (WAVE 2)

Wave-2 continuation of `docs/optimizations/05-websocket-realtime.md`. Wave 1
(#418, #419, #420, #421, #432, #433, #437, #469, #475, + #406/#409 unref) is in
`docs/optimizations/implemented/05-websocket.md` — NOT re-done here.

Scope: localized, additive, High/Med-impact + S/M-effort fixes inside the owned
files (`server/ws/*` except `pid-lock.ts`, `server/ws-server.ts`,
`server/ws-state.ts`, `server/http-utils.ts`, `server/routes/`,
`server/recall-handlers.ts`, `server/relay-handlers.ts`,
`server/bot-handlers.ts`, `server/lightning-handlers.ts`,
`server/video-handlers.ts`, `server/avatar-handlers.ts`, `src/webhooks/`). Each
fix is a minimal diff backed by a pure, exported helper so it is unit-testable
without booting Bun or opening a real socket. Tests:
`__tests__/opt/05-websocket-w2.test.ts` (run:
`bunx vitest run --config vitest.opt.config.ts __tests__/opt/05-websocket-w2.test.ts`).
45 tests, all passing.

| ID | File:area | Change | Test |
|----|-----------|--------|------|
| 413 | server/ws-server.ts (`classifyWsPath`, `fetch` upgrade chain) | Added `classifyWsPath(pathname)` mapping known endpoints → `WsData.type`, the bot-events root (`/`, `/ws`, `/v1/events`) → `'bot'`, and **everything else → null**. The `fetch` upgrade now 404s unknown paths instead of silently upgrading a typo (`/v1/speach/ws`) to a bot-events client that wastes a connection slot. Verified the web UI connects to `/` so existing clients are unaffected. | `classifyWsPath (#413)` — known/root/typo |
| 479,481,480 | server/ws-server.ts (`wsMessageByteLength`, `exceedsWsMessageLimit`, `wsTooLargeCloseReason`, `message` guard) | Message-size guard now measures **UTF-8 bytes** for strings (was `.length` = UTF-16 code units, so a multibyte ~5M-char string of ~10 MB bytes slipped past). Binary frames use `byteLength`. The 1009 close reason now carries the byte limit so clients can chunk. Exposed `MAX_WS_MESSAGE_SIZE`. | `ws message size guard — byte accounting (#479/#481/#480)` |
| 455 | server/ws-server.ts (`resolvePauseMs`) + server/ws/stt-lifecycle.ts (`connected` frame) | Extracted `resolvePauseMs(raw)` (clamp [50,30000], default 700) used by the STT upgrade. The STT `connected` event now echoes `pauseMs` so a client sending `pause_ms=0` learns the effective value (700) instead of silently getting it. | `resolvePauseMs (#455)` |
| 403 | server/ws-server.ts (`clampConnCount`, `ws.data.__counted`, `open`/`close`) | `close()` only decrements `wsConnectionCount` for a socket that was actually counted in `open()` (`__counted` flag) and clamps via `clampConnCount = Math.max(0,…)`, so a double-close / un-opened socket can't drive the counter negative and shrink effective capacity. (The 401/402 cap-race work is still deferred — this is only the underflow clamp.) | `clampConnCount (#403)` |
| 438 | server/ws-state.ts (`packBinaryDubFrame`, `MAX_DUB_FRAME_META_BYTES`) | `packBinaryDubFrame` throws `RangeError` when JSON metadata exceeds 64 KB, so an oversized metadata object can't drive a giant `Buffer.allocUnsafe` of uninitialised memory. | `packBinaryDubFrame oversized-metadata guard (#438)` |
| 483 | server/ws-state.ts (`isValidDubTarget`) + server/ws/handlers.ts (`dub:subscribe`/`dub:switch`) | Added `isValidDubTarget` (2–8 char `[A-Za-z0-9-]` language code). `dub:subscribe`/`dub:switch` reject bogus targets with `{code:'invalid_target'}` before they become an unbounded `dubTargetClients` Map key. | `isValidDubTarget (#483)` + `handleWsCommand … dub validation` |
| 482,485 | server/ws/handlers.ts (`isKnownWsCommand`, `KNOWN_WS_COMMANDS`, `handleWsCommand` head) | `handleWsCommand` validates `cmd.type` is a string naming a known command up front; unknown/malformed (`{type:{}}`, arrays) get an explicit `{type:'error', code:'unknown_command'}` nack instead of a silent no-op. | `isKnownWsCommand (#482/#485)` + `handleWsCommand nack …` |
| 441 | server/ws/speech-lifecycle.ts (`validateSpeechAudio`, `handleSpeechMessage`) | Pre-pipeline framing check: rejects empty buffers, RIFF buffers shorter than the 44-byte header, and odd-length raw PCM (split 16-bit sample) before STT burns a full pipeline run. | `validateSpeechAudio (#441)` |
| 458 | server/ws/speech-lifecycle.ts (`onComplete`) | The speech `complete` frame now carries a `noSpeech` boolean so clients can distinguish silence from a real (possibly empty-translation) result. | covered by `validateSpeechAudio` suite + reviewed (pure flag) |
| 442,443 | server/ws/bot-audio.ts (`buildWavHeader`, `processBotAudioBuffer`) | Extracted the 44-byte WAV header into `buildWavHeader(sampleRate, dataSize)` and made `processBotAudioBuffer` use the **handshake-negotiated** sample rate with byte-rate **derived** from it (`rate*1*2`), instead of the field-by-field rebuild that assumed 16 kHz / 32000 B/s. A 48 kHz stream is now labeled correctly. | `buildWavHeader (#442/#443)` |
| 447 | server/ws/bot-audio.ts (`trimChunksToByteBudget`, `appendBotAudioChunk`) | Buffer-overflow trim now drops the **oldest** chunks by byte budget while preserving the newest (chronological order kept), so large chunks can't discard the most recent speech the old count-style shift could. | `trimChunksToByteBudget (#447)` |
| 444 | server/ws/bot-audio.ts (`parseBotAudioHandshake`, `BOT_AUDIO_DEFAULT_SAMPLE_RATE`) + server/ws-server.ts (`bot-audio` message branch, `ws.data.__handshakeSeen`) | Binary PCM arriving before the `{protocol_version, sample_rate}` handshake no longer silently guesses 16 kHz: the server defaults the rate **explicitly to 48 kHz once** (tracked via `__handshakeSeen`) and logs a warning, so the WAV header / STT aren't fed a mislabeled stream. `parseBotAudioHandshake` is the shared pure parser. | `parseBotAudioHandshake (#444)` |
| 452 | server/ws/stt-lifecycle.ts (`shouldForceFlush`, max-accum branch) | Max-accum force-flush now fires on **words OR chars** (`shouldForceFlush(pending, minWords, minChars)`), so a long monologue of short (<3-word) tokens can't grow latency unbounded under the previous word-only threshold. | `shouldForceFlush (#452)` |
| 417 | server/ws/stt-lifecycle.ts (no-backend path) | "No STT backend available" now closes with application code **4002** (+ `{code:'no_backend'}` in the error frame) so clients can tell a config/backend failure from a transport network drop. | covered by review (close-code constant); see Deferred note |
| 497 | src/webhooks/index.ts (`maxDeadLetters`, DLQ push) | Dead-letter queue is now bounded (`maxDeadLetters`, default 1000) and drops the oldest entry at capacity, so sustained delivery failures can't grow it without limit. (Retry-backoff **jitter** is already provided by `withRetry`'s `jitter: 0.5` default — no change needed; noted in code.) | `webhook DLQ bound (#497)` |
| 498 | src/webhooks/index.ts (`signWebhookV2`, `verifyWebhookV2`, `send` headers) | Added a v2 signature over the canonical `timestamp.body` string (`X-Webhook-Signature-V2` + `X-Webhook-Timestamp`), and `verifyWebhookV2` which rejects mismatched signatures and stale timestamps (default 5 min tolerance) — a replay guard. The body is now serialized once so signed bytes == wire bytes. The legacy `signWebhook`/`X-Webhook-Signature` are kept for backward compat. | `webhook v2 signature + replay guard (#498)` |

New exported helpers (all additive, backward-compatible):
- `ws-server.ts`: `classifyWsPath`, `wsMessageByteLength`, `exceedsWsMessageLimit`, `wsTooLargeCloseReason`, `resolvePauseMs`, `clampConnCount`, `MAX_WS_MESSAGE_SIZE`
- `ws-state.ts`: `MAX_DUB_FRAME_META_BYTES`, `isValidDubTarget`
- `ws/speech-lifecycle.ts`: `validateSpeechAudio`
- `ws/bot-audio.ts`: `buildWavHeader`, `trimChunksToByteBudget`, `parseBotAudioHandshake`, `BOT_AUDIO_DEFAULT_SAMPLE_RATE`
- `ws/stt-lifecycle.ts`: `shouldForceFlush`
- `ws/handlers.ts`: `isKnownWsCommand`, `KNOWN_WS_COMMANDS`
- `src/webhooks/index.ts`: `signWebhookV2`, `verifyWebhookV2`

## Deferred (and why)

| ID(s) | Reason |
|-------|--------|
| 401, 402 | `MAX_WS_TOTAL` / bot-client-budget reconciliation + increment-at-upgrade race: changes connection-cap semantics across `fetch`/`open`, hard to unit-test without booting Bun. Only the underflow clamp (#403) was done. |
| 404, 415, 416, 477, 478, 487, 488 | Per-IP / per-type connection-rate limiting, absolute max-lifetime, server-initiated heartbeat, Origin allowlist, generic command rate limiter: all require live timer loops / per-socket tracking wired into `Bun.serve`; not unit-testable without real sockets and they change accept/eviction semantics. |
| 405, 407, 408 | Half-open reaping + STT-socket registry + O(n) cleanup sweep: the cleanup loop in `streaming-stt-session.ts` scans bot-events `wsClients` (not STT sockets); fixing correctly needs a new STT ws registry + sweep redesign (M, integration risk). |
| 410, 411, 428 | In-flight pipeline cap / queued-audio pacing / speculative-fan debounce — change pipeline scheduling and could drop/reorder user audio; needs design + integration coverage. |
| 422–425, 500 | `src/streaming/index.ts` spin-loop → event-driven queue rewrites: shared streaming primitives with broad blast radius, risky additively. |
| 426, 427, 429–431, 434–436 | Bun native pub/sub migration (L), `ws.cork()` batching, status-payload caching, dedup of the two `gpu:status` builders, language-routed raw audio: larger fan-out refactors spanning `ws-server.ts`/`ws-state.ts`. |
| 439, 440, 460–468 | SSE / multipart-parser / Node→Bun streaming-adapter items live in `server/ai-handlers.ts` (other owner) and `server/ai-handlers-stream.ts` / `server/ws/http-api-server.ts` (large risky `ReadableStream` adapter rewrite). Out of scope / not safely additive. |
| 445, 446 | Relay-path `Buffer.from` double-copy + held-PCM trim: lower-impact (Cost/Low) micro-opts on hot relay paths; left for a follow-up. |
| 448, 449, 450, 451, 453, 454, 456, 457, 459 | STT reconnect backoff/buffering/exclusion-reset/session-state refactor, final-flush-on-close, keepalive, send-after-close races: behavioral changes to the reconnect/close flow needing live-socket coverage. |
| 470, 499 | `src/streaming-stt.ts` + `src/modules/streaming-stt.ts` drift/dedupe and the upstream STT `TextDecoder`/parse short-circuit live in `src/streaming-stt.ts` / `src/modules/**` — out of ownership. |
| 471, 472, 473, 474, 476 | WS auth header-first / log-redaction / fail-closed Recall secret / privileged bot-audio ingress token / `safeCompare` reuse: auth-on-the-wire semantics in `ws-server.ts` `fetch`; safer in a dedicated security pass with the other auth owner. |
| 484, 486, 489–496 | dub-switch debounce, nack-text-on-binary-socket, metrics gauges, dropped-frame counters, reconnect cursor hints, protocol versioning/doc, legacy `provider:status` flag, close-code logging, upstream STT connect-buffer/stall-detector: Low/Med usability + observability items; batched out to keep this pass reviewable and within target. #417's typed close code (the cheap part of that cluster) was done. |

Note: this pass intentionally did NOT touch `server/ai-handlers.ts`,
`server/ws/pid-lock.ts`, `src/modules/**`, `src/streaming/**`,
`src/streaming-stt.ts`, or the wave-1 test file.
