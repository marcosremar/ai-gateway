# Implemented — #05 WebSocket / Streaming / Real-time Transport (WAVE 5)

Wave-5 continuation of `docs/optimizations/05-websocket-realtime.md`. Waves 1–4
(#401, #403, #404, #406, #407, #409, #413, #414, #417, #418, #419, #420, #421,
#427, #432, #433, #437, #438, #441, #442, #443, #444, #445, #446, #447, #448,
#451, #452, #453, #455, #456, #458, #469, #471, #472, #473, #475, #476, #478,
#479, #480, #481, #482, #483, #484, #485, #486, #487, #489, #491*, #492, #493,
#494, #497, #498) live in the earlier `…/implemented/05-websocket*.md` files and
are NOT re-done here.

\* #491 had a pure builder (`buildTranscriptReconnectHint`) from an earlier wave
but it was **never sent on the wire** — this wave wires it into the connect
snapshot, completing the optimization.

Scope: localized, additive fixes inside the OWNED file set only — `server/ws/*`
(except `pid-lock.ts`), `server/ws-server.ts`, `server/ws-state.ts`. Each fix is
a minimal diff backed by a pure, exported helper so it is unit-testable without
booting Bun or opening a real socket, then wired into the live
connection/message paths. Every change is backward-compatible (additive field /
additive connect frame / behavior-preserving refactor).

The safe, in-scope pool is now **effectively exhausted** — waves 1–4 already
landed the bulk of the localized items, and the remaining doc items are either in
files outside this wave's ownership (see Deferred) or are stateful/refactor work
that exceeds the "pure helper + minimal wire-in" safe band. This wave therefore
deliberately does **fewer** items, prioritizing quality.

Tests: `__tests__/opt/05-websocket-w5.test.ts`
(run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/05-websocket-w5.test.ts`).
**12 tests, all passing.** All five #05 suites together: **161 passing** (149
pre-existing + 12 new), no regressions.

| ID | File:area | Change | Test |
|----|-----------|--------|------|
| 459 | server/ws/speech-lifecycle.ts (`safeWsSend`, all `handleSpeechMessage` callback sends) | Each speech-ws callback checked `readyState === 1` then called `ws.send`, but the socket can close *between* the check and the send, so a late frame can throw and reject the pipeline promise (the STT path already wraps its sends; the speech path did not). Added a pure `safeWsSend(ws, payload)` that re-checks readyState **and** swallows a send throw, returning whether it actually sent. All five callbacks (`onStageStart`/`onStageDone`/`onAudioChunk`/`onComplete`/`onError`) plus the pipeline `.catch` now route through it. The audio-chunk backpressure skip is preserved. | `safeWsSend (#459)` — OPEN sends/true, CLOSING/CLOSED no-send/false, throw swallowed → false, Buffer payloads |
| 490 | server/ws-state.ts (`getWsBroadcastDropped`) + server/ws-server.ts (`getWsConnectionStats`) | The backpressure-drop counter `wsBroadcastDropped` (bumped whenever a saturated subscriber is skipped in `broadcastWs`/`broadcastDubAudio`) was incremented but never surfaced, so a silent audio/status gap was invisible to operators. Added a `getWsBroadcastDropped()` getter (live read across module boundaries) and extended the `getWsConnectionStats()` snapshot (the #489 gauge bundle) with a `broadcastDropped` field. | `getWsConnectionStats broadcastDropped (#490)` — gauge present + #489 fields intact, 0 after reset == live counter, bumps on a backpressured dub subscriber (skipped + counted), healthy subscriber not counted |
| 491 | server/ws-server.ts (`sendInitialGpuStatus`) — wiring of `buildTranscriptReconnectHint` | The `transcript:reconnect` hint builder existed in `ws-state.ts` but was never sent. A reconnecting bot-events client therefore had no way to learn the server-global transcript cursor and could miss or duplicate transcripts. The connect snapshot now emits `buildTranscriptReconnectHint()` (guarded by try/catch for a socket closing mid-handshake) so clients can resume a delta. | `buildTranscriptReconnectHint (#491)` — typed frame + cursor, floor/clamp negatives, NaN→0, JSON-serializable (it is `ws.send`-ed) |

## Notes / safety

- **Pure helpers, then wired.** `safeWsSend` and `getWsBroadcastDropped` are
  exported and covered directly; the `#490`/`#491` wire-ins are asserted via the
  stats snapshot and the (already-tested) builder. No real sockets, no
  `Bun.serve` boot in tests — `ws-server.ts` only defines exports at import time.
- **Backward compatible.** `#459` is a behavior-preserving refactor (same
  readyState gate, now also throw-safe); `#490` only *adds* a field to the stats
  object; `#491` only *adds* one frame to the connect handshake (clients that
  ignore unknown `type`s are unaffected).
- **No cross-boundary edits.** All changes stay inside `server/ws/speech-lifecycle.ts`,
  `server/ws-server.ts`, and `server/ws-state.ts`. No edits to
  `server/ws/pid-lock.ts`, `server/ai-handlers.ts`, `server/ai-handlers-stream.ts`
  (NOT in this wave's ownership), `src/modules/**`, `src/index.ts`, or build/test config.

## Deferred (out of owned scope or higher-risk this wave)

| ID | Why deferred |
|----|--------------|
| 402 | Increment `wsConnectionCount` atomically at upgrade time — touches the accept/upgrade race and interacts with the #403 `__counted` gate; higher-risk than a localized helper. |
| 405 / 488 | Heartbeat-based ghost reaping + server-initiated ping/pong — need a process-lifetime timer and live socket probing; not unit-testable without booting Bun (outside the pure-helper safe band). |
| 408 | STT cleanup misses real `/v1/stt/stream` sockets (own registry) — stateful registry change spanning open/close + the cleanup sweep; deferred to a focused wave. |
| 410 / 411 | Per-speech-ws in-flight pipeline cap / queued-audio coalescing — stateful concurrency control on the live session; non-trivial behavior change. |
| 415 / 416 / 477 | Per-type quotas for frame-inspector/recall sockets, absolute max session age, per-IP connection-rate limiting at upgrade — need request-IP plumbing / lifetime timers in `fetch`; defer for a focused security wave. |
| 422–425 / 500 | `AsyncQueue`/`mergeStreams`/`mapStream` backpressure + cancellation — live in `src/streaming/index.ts` (NOT in the owned file set). |
| 426 / 429–431 / 434 / 436 | `ws.cork()` batching, Bun native pub/sub migration, pre-serialized status snapshot, language-aware raw-audio routing, dedup of the two `gpu:status` builders — larger refactors across the broadcast hot path; defer to avoid a big diff. |
| 439 / 440 / 460–468 | Real multipart parser, streaming upload, SSE `stream:true`, orphaned `/v1/speech/stream` registration, ReadableStream response adapter, SSE heartbeat/headers/param-validation — live in `server/ai-handlers.ts` / `server/ai-handlers-stream.ts` / `server/ws/http-api-server.ts`, none of which are in **this wave's** ownership list (the prompt scopes editing to `server/ws/*`, `ws-server.ts`, `ws-state.ts`, `http-utils.ts`, `routes/`, and the recall/relay/bot/lightning/video/avatar handlers + `src/webhooks/`). NOTE: a draft of #462/#467/#468 was implemented in `ai-handlers-stream.ts` and then **reverted** to respect strict ownership. |
| 449 / 450 / 454 | STT reconnect backoff/cap, buffer-across-reconnect, dedicated session object (stop monkey-patching the backend) — stateful session-robustness work. |
| 470 / 495 / 496 / 499 | Upstream STT transport drift/buffering/heartbeat/decoder reuse — live in `src/streaming-stt.ts` / `src/modules/streaming-stt.ts` (NOT owned). |
| 474 | Dedicated bot-ingress token for `/ws/bot-audio` — auth-model change; defer for a focused security wave. |

### Safe pool status

**Effectively exhausted for this ownership slice.** After waves 1–4, the only
remaining doc items inside the owned files were the three landed here plus
stateful/refactor work explicitly outside the pure-helper safe band. Most of the
genuinely-localized SSE items (#460–468) sit in `ai-handlers-stream.ts`, which is
not in this wave's edit ownership.
