# Implemented — #05 WebSocket / Streaming / Real-time Transport

Scope: localized, High/Med-impact + S/M-effort fixes inside the owned files
(`server/ws/*` except `pid-lock.ts`, `server/ws-server.ts`, `server/ws-state.ts`,
`server/http-utils.ts`, `server/routes/`, `src/webhooks/`). Each fix is minimal,
additive, and covered by a unit test (no real sockets — ws objects are vi.fn
mocks). Tests: `__tests__/opt/05-websocket.test.ts`
(run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/05-*.test.ts`).

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| 419 | server/ws-state.ts:31-49 | Added `isBackpressured()` + `WS_BROADCAST_BACKPRESSURE_BYTES` (1 MB). `broadcastWs` now skips clients whose `getBufferedAmount()` is over the ceiling (and counts the drop) before `send`, so one stalled subscriber can't trip the `closeOnBackpressureLimit` close on healthy clients. Still serializes JSON once. | `broadcastWs backpressure (#419)` — skip+count, single-serialize, dead-client reap, empty no-op |
| 420 | server/ws-server.ts:397-399 (bot-audio relay), 418-420 (recall relay) | Relay fan-out loops now `if (isBackpressured(client)) continue;` — drop real-time PCM frames for saturated viewers instead of buffering megabytes / risking a backpressure-close. | `relay backpressure gate (#420/#421)` + `isBackpressured helper` |
| 421 | server/ws/bot-audio.ts:307 | Parec PCM capture relay loop drops frames for backpressured subscribers (same gate). | `relay backpressure gate (#420/#421)` |
| 418 | server/ws/speech-lifecycle.ts:21-35, 80 | Added `isSpeechBackpressured()` + `SPEECH_AUDIO_BACKPRESSURE_BYTES` (2 MB). `onAudioChunk` skips the chunk when the speech ws is saturated rather than `send`-ing into a buffer that will force-disconnect the client mid-stream. | `isSpeechBackpressured (#418)` |
| 432 | server/ws-state.ts:228-260 | `broadcastDubAudio` now applies the backpressure gate per subscriber and keeps the lazy binary/JSON build; saturated subscribers are skipped + counted. | `broadcastDubAudio (#432/#433)` — binary-vs-json partition, skip backpressured |
| 433 | server/ws-state.ts:233, 257-258 | `broadcastDubAudio` collected dead sockets into a `dead[]` array and deletes **after** iterating instead of `clients.delete(ws)` mid-iteration (deleting from a live Set while iterating can skip the next element). | `broadcastDubAudio (#432/#433)` — "delivers to every subscriber even when an earlier one throws" |
| 437 | server/ws-state.ts (decoder contract asserted in test) | No code change to `packBinaryDubFrame`; added a canonical round-trip decoder test asserting the uint32-LE JSON-length header + `jsonLen <= frame.length-4` invariant a receiver must honour. | `packBinaryDubFrame round-trip (#437)` |
| 475 | server/ws/bot-audio.ts:36-58 + server/ws-server.ts:281-288, 463-471 | Added `trySetBotAudioSource(ws)`: claims the single global bot-audio source slot, **rejects** a second concurrent source while the incumbent socket is OPEN (takes over only if the incumbent is no longer OPEN — half-open recovery). `open()` now closes the newcomer with 1013 on reject; `close()` only runs teardown for the socket that actually owns the slot, so a rejected newcomer's close can't flush/clear the active source's buffer. | `trySetBotAudioSource single-source guard (#475)` — claim/reject/take-over/idempotent |
| 406 | server/ws/streaming-stt-session.ts:85 | `sttCleanupTimer.unref()` (guarded `?.unref?.()`) so the 60s process-lifetime sweep doesn't hold the event loop open on an otherwise-idle process. | Verified indirectly: opt suite (with these imports) exits cleanly in ~4s with no hanging-timer warning. |
| 409 | server/ws-state.ts:146 | `botTranscriptPollTimer.unref()` (guarded) so an orphaned 1.5s poll against a dead pod can't block process exit. | Verified indirectly (clean suite exit). |
| 469 | src/webhooks/index.ts:100-109 (confirmed present, not modified) | Confirmed the SSRF guard (`isPrivateUrlResolved` via `../gateway/pipeline/ssrf-protection`) is present in the owned `src/webhooks/index.ts` and short-circuits delivery before `fetch`. Added unit tests proving it refuses loopback / cloud-metadata / `file:` URLs and lets a public URL through. (Did NOT touch the `src/modules/` copy — out of ownership.) | `webhook SSRF guard (#469)` — loopback/metadata/file blocked, public allowed, `signWebhook` deterministic HMAC |

Helper exports added (all backward-compatible, no behavior change to existing callers):
`isBackpressured`, `WS_BROADCAST_BACKPRESSURE_BYTES`, `wsBroadcastDropped`,
`resetWsBroadcastDropped` (ws-state.ts); `isSpeechBackpressured`,
`SPEECH_AUDIO_BACKPRESSURE_BYTES` (speech-lifecycle.ts); `trySetBotAudioSource`
(bot-audio.ts). `wsBroadcastDropped` is a counter that #490 (metrics for dropped
frames) can later surface in `/metrics`.

## Deferred (and why)

| ID(s) | Reason |
|-------|--------|
| 460 | `handleChatCompletions` SSE lives in `server/ai-handlers.ts` — owned by another agent. Out of scope. |
| 461, 462, 463, 464, 465, 466, 467, 468 | SSE / Node→Bun streaming-adapter items. #464 (rewrite buffering adapter to a `ReadableStream`-backed `Response`) is a large, risky rewrite in `server/ws/http-api-server.ts`; the dependent SSE fixes (461-467) only become meaningful after that, and `handlePipelineSSE` lives in `server/ai-handlers-stream.ts` (not owned). Deferred as not safely additive. |
| 401, 402, 403 | `MAX_WS_TOTAL` / `wsConnectionCount` race + underflow: touches the upgrade/`open`/`close` accounting in `ws-server.ts` in ways that change connection-cap behavior and are hard to cover with pure unit tests without booting the server. Deferred as non-localized. |
| 405, 408, 488 | Server-initiated heartbeat / half-open reaping / STT-socket registry require a live timer loop + socket tracking wired into `Bun.serve`; not unit-testable without real sockets and changes broadcast/eviction semantics. Deferred (larger, M effort with integration risk). #406/#409 (the `unref` subset) were done. |
| 410, 411, 428 | In-flight pipeline caps / frame coalescing / speculative-fan debounce change pipeline scheduling semantics (could drop or reorder user audio); needs careful design + integration testing, not a localized minimal diff. |
| 422, 423, 424, 425, 500 | `src/streaming/index.ts` spin-loop → event-driven queue rewrites. Moderate rewrites of shared streaming primitives with broad blast radius; risky to do additively. Deferred. |
| 449, 450, 451, 454 | STT reconnect backoff / buffering / exclusion-reset / session-state refactor in `stt-lifecycle.ts` — behavioral changes to reconnect flow; M effort, needs live-socket coverage. |
| 439, 440 | Multipart parser rewrite in `server/ai-handlers-stream.ts` (not owned) — deferred. |
| 470 | `src/` vs `src/modules/` `streaming-stt.ts` dedupe — touching `src/modules/**` is explicitly out of ownership. |
| 429, 430, 431, 436 | Bun native pub/sub migration (L) + status-payload caching + dedup of the two `gpu:status` builders — larger refactors spanning `ws-server.ts`/`ws-state.ts`; deferred to keep diffs minimal. The cheaper part of the fan-out concern (single-serialize + backpressure skip) is already in `broadcastWs`. |
| 441-448, 452, 453, 455-459, 471-474, 476-487, 489-499 | Lower-impact (Low/Med) hardening/usability items; left for a follow-up pass to stay within the 8-15 target and keep each change reviewable. |
