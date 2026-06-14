# Implemented — #05 WebSocket / Streaming / Real-time Transport (WAVE 3)

Wave-3 continuation of `docs/optimizations/05-websocket-realtime.md`. Waves 1+2
(#403, #406, #409, #413, #417, #418, #419, #420, #421, #432, #433, #437, #438,
#441, #442, #443, #444, #447, #452, #455, #458, #469, #475, #479, #480, #481,
#482, #483, #485, #497, #498) are in
`docs/optimizations/implemented/05-websocket.md` and `…05-websocket-w2.md` — NOT
re-done here.

Scope: localized, additive fixes inside the owned files (`server/ws/*` except
`pid-lock.ts`, `server/ws-server.ts`, `server/ws-state.ts`,
`server/http-utils.ts`, `server/routes/`, `server/recall-handlers.ts`,
`server/relay-handlers.ts`, `server/bot-handlers.ts`,
`server/lightning-handlers.ts`, `server/video-handlers.ts`,
`server/avatar-handlers.ts`, `src/webhooks/`). Each fix is a minimal diff backed
by a pure, exported helper so it is unit-testable without booting Bun or opening
a real socket. Tests: `__tests__/opt/05-websocket-w3.test.ts`
(run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/05-websocket-w3.test.ts`).
**43 tests, all passing.** All three #05 suites together: **111 passing** (no
regressions).

| ID | File:area | Change | Test |
|----|-----------|--------|------|
| 404 | server/ws-server.ts (`buildConnCapRejection`, `WS_CONN_CAP_RETRY_AFTER_SEC`, `fetch` cap check) | The global-connection-cap 429 was a bare `"Too many connections"` body with no backoff hint, inviting a tight reconnect storm against a full pool. Now returns a `Retry-After` header + a JSON body `{error:'too_many_connections', limit, retryAfter}` via a pure `Response` builder. | `buildConnCapRejection (#404)` — status/headers + body shape |
| 427 | server/ws-server.ts (n/a) → server/ws/stt-lifecycle.ts (`makePartialThrottle`, `STT_PARTIAL_MIN_INTERVAL_MS`, `onResult`) | Under fast ASR every upstream result emitted a client `partial` frame **and** an `emitFrame` observer event (two allocs/sends per token). Added a per-session, time-injected throttle limiting intermediate partials to ≤10/s; `evt.isFinal` always forces the frame through so the last partial of an utterance is never swallowed. | `makePartialThrottle (#427)` — throttle window, forced final, ~10/s cap |
| 445 | server/ws-server.ts (`toFrameBuffer`, recall-audio + bot-audio relay) | Relay paths did `Buffer.isBuffer(msg) ? msg : Buffer.from(msg)` and then re-handled the bytes, risking a double-copy for `Uint8Array`/`ArrayBuffer` payloads. `toFrameBuffer` normalizes to a Buffer **exactly once** — returns an existing Buffer untouched and wraps a typed-array view (offset/length-aware) without an extra copy. | `toFrameBuffer (#445)` — same-instance, view offset/length, string, ArrayBuffer |
| 446 | server/ws/bot-audio.ts (`trimHeldPcm`, `processBotAudioBuffer` held-PCM assignment) | Held audio from a short/meaningless segment was re-prepended to the next chunk every cycle, so the same leading audio was re-transcribed (re-paying STT) and the held buffer grew up to ~15 s. `trimHeldPcm` caps held PCM to the trailing window on a 16-bit-sample boundary, bounding growth and stopping re-billing of already-tried audio. | `trimHeldPcm (#446)` — null/empty, within-budget, trailing-keep, even-length alignment |
| 448 | server/ws-server.ts (`close()` stt branch) | On STT-socket close the accum timer was cleared and the backend closed, but any pending un-flushed text in `shortBuf`/the accumulator was lost. Close now calls `(backend)._flushAccum?.()` (guarded, never throws out of the handler) **before** clearing the timer + closing, so the last utterance still reaches the client. | `flush-on-close contract (#448)` — flush-before-teardown order, absent hook, throwing hook swallowed |
| 456 | server/ws/stt-lifecycle.ts (`capSeedChars`, `STT_SEED_MAX_CHARS`, `emitText`) | Each final pushed text into the rolling 5-segment context whose joined string was re-uploaded upstream as the prior-segment seed on every final; long segments bloated that re-sent seed. `capSeedChars` keeps only the trailing `maxChars` (most recent context, on a word boundary). | `capSeedChars (#456)` — under-cap passthrough, cap enforced, trailing-keep, default |
| 471 | server/ws-server.ts (`extractWsAuthToken`, `fetch` auth) | WS auth read `?token=` **first**, then the header — but a query token lands in proxy/access logs + browser history. Now prefers the `Authorization: Bearer` header (still accepting the query param for browser clients that can't set headers) and logs a one-line warning when the token came from the query. | `extractWsAuthToken (#471)` — header-preferred, query fallback, bare header, none |
| 476 | server/ws-server.ts (`safeCompare` exported) | The recall-token path already used the **padded** constant-time `safeCompare` (which compares against a length-padded copy so the empty/short case doesn't return fast). Exported it (was module-private) and documented the reuse so the constant-time guarantee is the single shared implementation. | `safeCompare (#476)` — equal/unequal/length-mismatch/empty (no throw) |
| 478 | server/ws-server.ts (`isAllowedWsOrigin`, `fetch` upgrade) | The WS upgrade never validated `Origin`, so any web page holding a token could open an authenticated socket (HTTP had CORS, WS didn't). `isAllowedWsOrigin` enforces a comma-separated `AIGW_WS_ALLOWED_ORIGINS` allowlist — **fail-open when unset** (dev/non-browser unaffected) and always allows a missing `Origin` (non-browser clients). 403 on a disallowed browser origin. | `isAllowedWsOrigin (#478)` — fail-open, missing-Origin, allowlist match/deny |
| 486 | server/ws-server.ts (bot-audio message branch) | Non-handshake **text** on the binary `/ws/bot-audio` socket was silently swallowed (`return`), giving a misbehaving client no feedback. Now nacks with `{type:'error', code:'unexpected_text'}` when the string isn't a valid handshake. Discriminator is the existing pure `parseBotAudioHandshake`. | `bot-audio text nack discriminator (#486)` — plain/invalid text → null, real handshake → parsed |
| 489 | server/ws-server.ts (`getWsConnectionStats`) | `wsConnectionCount`, `wsClients.size`, `sttSessions.size` weren't exported anywhere, so operators couldn't observe leaks/backpressure. Added a pure `getWsConnectionStats()` snapshot (`{total, max, botEvents, sttSessions}`) a `/metrics` handler can surface (pairs with `wsBroadcastDropped` from wave-1). | `getWsConnectionStats (#489)` — gauge shape + zero baseline |
| 491 | server/ws-state.ts (`buildTranscriptReconnectHint`) | `botTranscriptCursor` is process-global, so a reconnecting client couldn't resume and could miss/duplicate transcripts. Added a pure `buildTranscriptReconnectHint(cursor)` → `{type:'transcript:reconnect', cursor}` (clamped to a non-negative integer) clients can use to request a delta. | `buildTranscriptReconnectHint (#491)` — cursor carry, clamp, JSON round-trip |
| 493 | server/ws-state.ts (`shouldEmitLegacyProviderStatus`, `broadcastProviderStatus`) + server/ws-server.ts (`sendInitialGpuStatus`) | Every status change sent **both** the legacy `provider:status` and the richer `gpu:status` (double broadcast volume for old-Python-app compat). Gated the legacy frame behind `AIGW_DISABLE_LEGACY_PROVIDER_STATUS` (default **ON/emit** for compat) — both the broadcast path and the connect-snapshot path — so newer fleets can halve status traffic. | `shouldEmitLegacyProviderStatus (#493)` — default-on, disable flags, unrelated value |
| 494 | server/ws-server.ts (`formatWsCloseLog`, `close(ws, code, reason)`) | `close()` logged only the id, so idle-timeout vs backpressure-close vs client-leave were indistinguishable. The handler now takes Bun's `code`/`reason` and logs a structured line (id, type, numeric code, sanitized + 120-char-capped reason). | `formatWsCloseLog (#494)` — id/type/code, code=n/a + empty-reason omit, sanitize+cap |

New exported helpers (all additive, backward-compatible):
- `ws-server.ts`: `buildConnCapRejection`, `WS_CONN_CAP_RETRY_AFTER_SEC`, `toFrameBuffer`, `formatWsCloseLog`, `getWsConnectionStats`, `extractWsAuthToken`, `isAllowedWsOrigin`, `safeCompare`
- `ws-state.ts`: `shouldEmitLegacyProviderStatus`, `buildTranscriptReconnectHint`
- `ws/stt-lifecycle.ts`: `capSeedChars`, `STT_SEED_MAX_CHARS`, `makePartialThrottle`, `STT_PARTIAL_MIN_INTERVAL_MS`
- `ws/bot-audio.ts`: `trimHeldPcm`

New env flags (both default to prior behavior so nothing changes unless set):
- `AIGW_DISABLE_LEGACY_PROVIDER_STATUS=1` — drop the duplicate `provider:status` frame (#493)
- `AIGW_WS_ALLOWED_ORIGINS=https://a,https://b` — restrict browser WS upgrades by Origin (#478)

## Deferred (and why)

| ID(s) | Reason |
|-------|--------|
| 401, 402 | `MAX_WS_TOTAL` / bot-client-budget reconciliation + increment-at-upgrade race: changes connection-cap semantics across `fetch`/`open`; not unit-testable without booting Bun. (Only the #403 underflow clamp + #404 Retry-After body were done.) |
| 405, 407, 408 | Half-open reaping + STT-socket registry + O(n) cleanup sweep redesign — needs a new STT ws registry and live timer loop (M, integration risk). |
| 410, 411, 428 | In-flight pipeline cap / queued-audio pacing / speculative-fan debounce — change pipeline scheduling and could drop/reorder user audio; need design + integration coverage. |
| 412, 414, 415, 416, 477, 487, 488 | Per-IP / per-type connection-rate limiting, absolute max-lifetime, server-initiated heartbeat, generic command rate limiter, subscribe try/finally: all require live timer loops / per-socket tracking wired into `Bun.serve`; not unit-testable and change accept/eviction semantics. (#404's Retry-After — the cheap part of the cap-rejection cluster — was done.) |
| 422–425, 500 | `src/streaming/index.ts` spin-loop → event-driven queue rewrites: shared streaming primitives, broad blast radius, risky additively. |
| 426, 429, 430, 431, 434, 435, 436 | `ws.cork()` batching, Bun native pub/sub migration (L), status-payload caching, dedup of the two `gpu:status` builders, language-routed raw audio: larger fan-out refactors spanning `ws-server.ts`/`ws-state.ts`. |
| 439, 440, 460–468 | SSE / multipart-parser / Node→Bun streaming-adapter items live in `server/ai-handlers.ts` (other owner) and `server/ai-handlers-stream.ts` / `server/ws/http-api-server.ts` (large risky `ReadableStream` adapter rewrite). Per task note, the streaming-adapter/chat-SSE rewrites #460-468 live in unowned files — deferred. |
| 449, 450, 451, 453, 454, 457, 459 | STT reconnect backoff/buffering/exclusion-reset/session-state refactor, control-message ack/nack, keepalive, send-after-close races: behavioral changes to the reconnect/close flow needing live-socket coverage. (#448 final-flush-on-close — the localized cheap part — was done.) |
| 470, 496, 499 | `src/streaming-stt.ts` + `src/modules/streaming-stt.ts` drift/dedupe, upstream STT connect-buffer/stall-detector + `TextDecoder`/parse short-circuit — live in `src/streaming-stt.ts` / `src/modules/**`, out of ownership. |
| 472, 473, 474 | Recall/bot metadata log gating, fail-closed Recall secret, privileged bot-audio ingress token: auth-on-the-wire semantics in `ws-server.ts` `fetch`; safer in a dedicated security pass. (#471 header-first + #476 `safeCompare` reuse + #478 Origin allowlist — the additive, fail-open pieces — were done.) |
| 484, 490, 492, 495 | dub-switch debounce, dropped-frame metrics surfacing (counter exists), protocol versioning/doc, upstream STT connect-buffer: Low/Med usability/observability batched out to keep this pass reviewable. (#489 connection-stats snapshot + #491 reconnect cursor + #493 legacy-flag + #494 close-code log — the cheap localized observability items — were done.) |

Note: this pass did NOT touch `server/ai-handlers.ts`, `server/ai-handlers-stream.ts`,
`server/ws/pid-lock.ts`, `server/ws/http-api-server.ts`, `src/modules/**`,
`src/streaming/**`, `src/streaming-stt.ts`, or the wave-1/wave-2 test files.
