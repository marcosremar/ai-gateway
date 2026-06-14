# Implemented — #05 WebSocket / Streaming / Real-time Transport (WAVE 4)

Wave-4 continuation of `docs/optimizations/05-websocket-realtime.md`. Waves 1–3
(#403, #404, #406, #409, #413, #418, #419, #420, #421, #427, #432, #433, #437,
#438, #441, #442, #443, #444, #445, #446, #447, #448, #452, #455, #456, #469,
#471, #475, #476, #478, #479, #480, #481, #482, #483, #485, #486, #489, #491,
#493, #494, #497, #498) live in `…/implemented/05-websocket.md`,
`…05-websocket-w2.md`, and `…05-websocket-w3.md` — NOT re-done here.

Scope: localized, additive fixes inside the owned files (`server/ws/*` except
`pid-lock.ts`, `server/ws-server.ts`, `server/ws-state.ts`,
`server/http-utils.ts`, `server/routes/`, `server/recall-handlers.ts`,
`server/relay-handlers.ts`, `server/bot-handlers.ts`,
`server/lightning-handlers.ts`, `server/video-handlers.ts`,
`server/avatar-handlers.ts`, `src/webhooks/`). Each fix is a minimal diff backed
by a pure, exported helper so it is unit-testable without booting Bun or opening
a real socket, then wired into the live message/connection paths. Behavioral
changes default to the previous (backward-compatible) behavior and are gated by
env flags where they tighten security or reduce logging.

Tests: `__tests__/opt/05-websocket-w4.test.ts`
(run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/05-websocket-w4.test.ts`).
**38 tests, all passing.** All four #05 suites together: **149 passing** (111
pre-existing + 38 new), no regressions.

| ID | File:area | Change | Test |
|----|-----------|--------|------|
| 401 | server/ws-server.ts (`effectiveBotEventsBudget`, `MAX_WS_CLIENTS`, `open()` bot-events check) | The bot-events `open()` checked `wsClients.size >= 500`, but the global `MAX_WS_TOTAL=200` is enforced first in `fetch`, so the advertised 500-slot budget could never trigger — bot clients were silently starved at 200. The per-type check now uses `effectiveBotEventsBudget()` = `min(global, perType)`, so it reflects the real ceiling (and the helper surfaces that the 500 cap is unreachable while the global cap is lower). | `effectiveBotEventsBudget (#401)` — min of caps, both directions, defaults reconcile to 200 |
| 407 | server/ws/streaming-stt-session.ts (`computeStaleSessionIds`, cleanup `setInterval`) | The 60 s stale-session sweep nested `for (ws of wsClients)` inside `for (id of sessions)` — O(sessions × clients) every tick (wasteful at hundreds of sessions × 200 clients). `computeStaleSessionIds` builds a `Set` of live ids once (O(clients)) then checks membership in O(1) per session → O(sessions + clients). | `computeStaleSessionIds (#407)` — stale detection, none/all stale, iteration-order preservation, large-set behavior |
| 414 | server/ws-server.ts (`open()` frame-inspector branch) | If a frame-inspector socket started closing during `subscribeFrames`, the stored unsubscribe leaked until a `close` that might not re-fire. Open now checks `readyState !== 1` immediately after subscribing and tears the subscription down (swallowing a throwing unsubscribe) instead of storing it. | `frame-inspector subscribe teardown contract (#414)` — store-when-open, teardown-when-closing, throwing-unsub swallowed |
| 417 | server/ws/stt-lifecycle.ts (`STT_NO_BACKEND_CLOSE_CODE`, `connectBackend` close) | The "no STT backend available" close used a hardcoded `4002`; centralized it as a named private-range (4000–4999) application close code so clients can distinguish a config/availability failure from a transport drop, and the value can't drift. | `STT_NO_BACKEND_CLOSE_CODE (#417)` — private-range, distinct from 1000/1006 |
| 451 | server/ws/stt-lifecycle.ts (`shouldResetExclusions`, `STT_EXCLUSION_RESET_MS`, `openSttSession` connect/disconnect) | The `excluded` provider set only ever grew, so a provider that dropped once (e.g. a GPU pod restart) and recovered was never retried — pinning the client to a slower cloud fallback for the session. Now `onConnected` records the connect time and `onDisconnected` clears exclusions when the backend stayed healthy ≥30 s before dropping, so the preferred (faster) provider can be re-selected. | `shouldResetExclusions (#451)` — healthy-window reset, fast-flap no-reset, no connect time, custom window |
| 453 | server/ws-server.ts (`parseWsControlAction`, `WsControlAction`, STT control branch) | The STT message loop acted only on `action: 'clear' \| 'turn_complete'`; any other/malformed action was a silent no-op. `parseWsControlAction` classifies the action (or null), and the loop now nacks an unrecognized control message with `{type:'error', code:'unknown_control'}`. | `parseWsControlAction (#453)` — valid actions, unknown/typo, bogus types, nullish input |
| 458 | server/ws/speech-lifecycle.ts (`isNoSpeechResult`, `onComplete`) | `onComplete` always reported `status:'complete'`, so clients couldn't tell genuine silence from a real translation. Extracted the no-speech test into a pure helper (treats missing/whitespace-only transcription as no-speech) and reused it to set the `noSpeech` flag. | `isNoSpeechResult (#458)` — empty/whitespace/null → true, real text → false |
| 472 | server/ws-server.ts (`shouldLogWsMetadata`, recall-audio metadata log) | Recall handshake logs included `bot_id`/`recording_id` — newline-sanitized but identifier-adjacent. Logging is now gated behind `AIGW_WS_DEBUG_META=1` (default OFF), so PII-adjacent fields stay out of normal logs. | `shouldLogWsMetadata (#472)` — default off, explicit-on values |
| 473 | server/ws-server.ts (`recallRequiresWsSecret`, `/recall/audio` fetch) | When `RECALL_API_KEY` was set but `RECALL_WS_SECRET` was absent, the recall path silently fell back to generic gateway auth — any gateway-key holder could stream into the recall fan-out. The endpoint now **fails closed** (503) in that case unless the operator explicitly opts into the insecure fallback via `AIGW_RECALL_ALLOW_GATEWAY_AUTH=1`. | `recallRequiresWsSecret (#473)` — disabled→false, enabled→true, explicit opt-out, unrelated flag |
| 484 | server/ws/handlers.ts (`makeDubSwitchDebounce`, `DUB_SWITCH_MIN_INTERVAL_MS`, `dub:switch` branch) | Rapid `dub:switch` churn re-created `dubTargetClients` Set entries and thrashed the maps. A per-connection debouncer (default 250 ms) now rejects switches that arrive too fast (nack `switch_debounced`); the initial subscribe is always honored. | `makeDubSwitchDebounce (#484)` — within-interval reject, first-honored, default |
| 487 | server/ws/handlers.ts (`makeCommandRateLimiter`, `WS_COMMAND_RATE_LIMIT/WINDOW_MS`, `handleWsCommand`) | Only recall-audio was rate-limited; a bot-events client could spam `bot:join`/`dub:switch`/`ping` to drive repeated upstream fetches + broadcasts (an O(N) amplifier). Added a per-connection fixed-window limiter (default 30 cmds/s) that nacks `rate_limited` once exceeded. | `makeCommandRateLimiter (#487)` — limit then reject, window rollover reset, defaults |
| 492 | server/ws-server.ts (`WS_PROTOCOL_VERSION`, `withProtocolVersion`, speech `connected` frame) | WS event types were implicit, so clients couldn't negotiate or detect a protocol bump. The connect handshake now carries an additive `protocolVersion` field via a pure stamper (never overwrites caller fields). | `withProtocolVersion (#492)` — stamps version, additive, JSON round-trip |

## Notes / safety

- **Pure helpers, then wired.** Every item is an exported helper covered directly
  by unit tests (set logic, time-injected limiters/debouncers, env-flag
  decisions, frame stamping), and is wired into the live `fetch`/`open`/`message`
  paths in the same files. No real sockets, no `Bun.serve` boot in tests
  (`ws-server.ts` only defines exports at import time).
- **Backward compatible by default.** `shouldLogWsMetadata` defaults OFF
  (log-only change); `recallRequiresWsSecret` only changes behavior when
  `RECALL_API_KEY` is set without `RECALL_WS_SECRET` (a genuine fail-closed
  security fix, escape-hatchable via `AIGW_RECALL_ALLOW_GATEWAY_AUTH=1`); the
  command rate limit (30/s) and dub-switch debounce (250 ms) are generous enough
  not to affect normal clients.
- **No cross-boundary edits.** All changes stay inside the owned file set; no
  edits to `server/ws/pid-lock.ts`, `server/ai-handlers.ts`, `src/modules/**`,
  `src/index.ts`, or build/test config.

## Deferred (out of owned scope or higher-risk this wave)

| ID | Why deferred |
|----|--------------|
| 402 | Increment `wsConnectionCount` atomically at upgrade time — touches the accept/upgrade race; needs care around `open()`/`close()` counting (interacts with the #403 `__counted` gate). Higher-risk than a localized helper. |
| 405 / 488 | Heartbeat-based reaping + server-initiated ping/pong — require a process-lifetime timer and live socket probing; not unit-testable without booting Bun and out of the "pure helper" safe band. |
| 410 / 411 | Per-speech-ws in-flight pipeline cap / queue coalescing — needs stateful concurrency control on the live session; non-trivial behavior change, deferred for a focused wave. |
| 422–425 / 500 | `AsyncQueue`/`mergeStreams`/`mapStream` backpressure + cancellation — live in `src/streaming/index.ts` (NOT in the owned file set). |
| 429–431 / 436 | Bun native pub/sub migration + pre-serialized status snapshot + dedup of the two `gpu:status` builders — larger refactors spanning the broadcast hot path; defer to avoid a big diff. |
| 439 / 440 | Real multipart parser + streaming upload — `server/ai-handlers-stream.ts` (NOT owned). |
| 449 / 450 / 454 | STT reconnect backoff/cap, buffer-across-reconnect, dedicated session object (stop monkey-patching the backend) — stateful session-robustness work; deferred to keep diffs localized. |
| 460–468 | SSE streaming correctness (`stream:true`, orphaned `/v1/speech/stream`, ReadableStream adapter, SSE param validation) — live in `server/ai-handlers.ts` / `server/ai-handlers-stream.ts` (NOT owned). |
| 470 / 495 / 496 / 499 | Upstream STT transport drift/buffering/heartbeat/decoder reuse — live in `src/streaming-stt.ts` / `src/modules/streaming-stt.ts` (NOT owned). |
| 474 / 477 | Dedicated bot-ingress token + per-IP connection-rate limiting at upgrade — auth-model + token-bucket-at-upgrade changes; the per-IP limiter needs request-IP plumbing in `fetch`, deferred for a focused security wave. |
