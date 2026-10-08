# Realtime voice — control plane and browser SDK

Realtime speech-to-speech between a learner's browser and a GPU replica running the speech stack (Whisper + LLM +
TTS), with a **transport ladder** so every network gets the best path it allows, and a **per-replica session limit**.

```
browser (SDK) ──(1) POST {transports}──▶ app backend ──(2) POST /v1/realtime/sessions (app key)──▶ gateway
                                                                                    │ admission: ready replica with
                                                                                    │ a free rt slot (/__aigw/rt/status)
browser ◀──────────── session descriptor (token, transports, ICE servers) ──────────┘
   │
   ├─ webrtc   : offer ──▶ gateway /v1/realtime/sessions/:id/offer ──▶ replica /__aigw/rt/offer ; media + "events"
   │             data channel browser ⇄ replica DIRECTLY (UDP, or TURN over TCP/443)
   ├─ ws       : wss://gateway/v1/realtime/ws?token= ⇄ (relay) ⇄ ws://replica/__aigw/rt/ws?token=
   ├─ s2s-stream: one HTTP request per turn via the app backend → gateway /v1/s2s (streamed frames)
   └─ post     : the app's own request/response endpoint (caller's `postTurn`)
```

Code: gateway `src/realtime/` (mounted by `serve.ts`), SDK `sdk/browser/realtime/` exported as
`@parle/ai-gateway/realtime`. The replica side (the "edge": WebRTC/WS termination on CPU, local Whisper/LLM/TTS) lives
in `docker/speech-stack` and implements the contract below.

## Contract (shared with the edge — do not change one side alone)

### Session config

The `/v1/s2s` `config` object (`system`, `messages`, `voice`, `fallback_voice`, `language`, `models`, `max_tokens`,
`temperature`, `stt_prompt`, `speak_field`, …) plus `deployment`. It travels inside the token (`cfg`).

### Session token

JWT HS256. Signing key per deployment, derived from the replica token (never leaves the gateway or the replica):

```
key = HMAC-SHA256(key = <deployment replicaToken>, message = "aigw-rt-v1")      # 32 raw bytes
claims = { sid, app, dep, rep, cfg, iat, exp }    # serialized in this order; base64url without padding
  sid  session id (rt_<32 hex>)      app  app account      dep  deployment      rep  replica id
  cfg  base64url(JSON(session config)), ≤ 6 KB (6144 characters)
  iat/exp  unix seconds, exp − iat ≤ 900 (15 min); default TTL 600 s (REALTIME_SESSION_TTL_SECONDS)
```

Verification: header `alg` must be `HS256`; constant-time signature check; `exp > now`; `iat ≤ now + 60`;
`exp − iat ≤ 900`; `cfg` ≤ 6144. Test vectors (valid, expired, tampered, wrong key, TTL too long, future iat, and the
TURN credential): [`docs/realtime-token-vectors.json`](realtime-token-vectors.json) — cross-checked in Python too.

The token is **signed, not encrypted**: the browser can read `cfg`. No secret belongs in the session config.

### Edge routes (on the replica, behind the nginx token gate)

The gateway calls them with `X-Aigw-Token: <replicaToken>` and a `traceparent` header. The browser never calls the
replica's HTTP; only WebRTC media/data go to it directly, and WS goes through the gateway relay.

| Route | Body → answer |
|---|---|
| `POST /__aigw/rt/offer` | `{sdp, type:"offer", token}` → `{sdp, type:"answer", sessionId}` (409/429/503 = full) |
| `POST /__aigw/rt/ice` | `{sessionId, candidate}` (trickle, optional — the SDK v1 sends a complete SDP) |
| `GET /__aigw/rt/status` | `{active, max, available, transports:["webrtc","ws"], udpPorts:[lo,hi]}` |
| `DELETE /__aigw/rt/session/:id` | ends a session (the `sessionId` the offer answered) |
| `GET /__aigw/rt/ws?token=…` | WebSocket (relayed from the gateway's `/v1/realtime/ws`) |

`max` comes from the spec env `RT_MAX_SESSIONS` (default L40S 8, L4 2 through `envByMachineType`: what one replica
serves within first audio p95 ≤ 2 s — measured on the L40S, docs/reports/2026-10-07-realtime-handoff.md § Live capacity;
the L4 figure is an estimate from its `/v1/s2s` numbers). A replica whose
`/__aigw/rt/status` answers 404 runs no edge and gets no realtime session.

### Events and control messages

Edge → client (data channel "events", JSON, or WS text frames), the s2s vocabulary:
`{type:"ready"}`, `{type:"vad", state:"start"|"end"}`, `{type:"transcript", text, final}`, `{type:"filtered", reasons}`,
`{type:"reply_delta", text}`, `{type:"reply", text}`, `{type:"audio_start"}`, `{type:"audio_end"}`,
`{type:"interrupted"}`, `{type:"done", empty?, filtered?}`, `{type:"error", code, message}`,
`{type:"metrics", ttfa_ms, stt_ms, llm_ttft_ms, tts_ttfb_ms, endpoint_ms, ttfa_from_speech_ms}`.

Client → edge: `{type:"interrupt"}`, `{type:"end_turn"}` (client VAD: the learner stopped), `{type:"config_update",
messages?}` (append to the history), `{type:"ping"}`.

### Audio

WebRTC: Opus mono both ways. WS: binary frames = 1 header byte `0x01` (audio) + PCM16 little-endian mono, 16 kHz
upstream, 24 kHz downstream, 20 ms frames (320 / 480 samples).

## Admission — `POST /v1/realtime/sessions`

Called by the **app's backend** with its app key (the browser never holds a gateway key).

```json
{ "config": { "system": "…", "messages": [], "voice": "lia", "deployment": "parle-speech" },
  "transports": ["webrtc", "ws", "s2s-stream", "post"], "prefer": "webrtc" }
```

1. **Ownership** — same rule as `invoke`: an app key only reaches deployments of its own app (403 otherwise, also for
   a deployment that does not exist, so a key cannot probe others); an admin key reaches any. `config.deployment`
   defaults to `S2S_DEPLOYMENT`.
2. **Placement** — the ready, non-draining replicas of the deployment are asked `/__aigw/rt/status` (cached 2 s, 1.5 s
   timeout). Free slots = `available − pending`, where *pending* are sessions admitted here in the last 20 s that
   have not connected yet (a class of 30 arriving at once must not all land on the same 8 slots). Among the replicas
   with a free slot that speak a wanted transport, the best media path wins (`direct`, then not probed yet, then
   `relay`, then `ws`), then the most free slots.
3. **Refusals answer at once** with `503`, `Retry-After` and `fallback: {transport:"s2s-stream", url:"/v1/s2s"}`, so the
   client goes down the ladder instead of waiting: `cold` (no ready replica: the deployment is **woken** for the next
   sessions — never under no-wake, `X-Gateway-No-Wake: 1` or `GATEWAY_NO_WAKE_USERS`; Retry-After 30), `saturated`
   (every slot taken; 2), `unsupported` (no edge on the replicas; 60), `unreachable` (5), `paused` (60).
4. **Budget** — a session charges the app's daily request budget (`AppLimits`, `APP_DAILY_REQUESTS`) at admission:
   `REALTIME_REQUESTS_PER_MINUTE` (default 4, about one turn every 15 s, each worth one `/v1/s2s`) × ⌈TTL / 60⌉ —
   40 requests for the default 10 min. The gateway cannot count WebRTC turns (audio bypasses it), so it charges the most
   audio the token can carry. Admin keys are not charged. Over budget → 429 + Retry-After.
5. **Answer**:

```json
{ "sessionId": "rt_…", "token": "<jwt>", "expiresAt": "…", "deployment": "parle-speech", "traceId": "…",
  "telemetryUrl": "https://gw/v1/telemetry/events",
  "transports": [
    { "type": "webrtc", "offerUrl": "https://gw/v1/realtime/sessions/rt_…/offer", "iceUrl": "…/ice", "iceServers": [ … ] },
    { "type": "ws", "url": "wss://gw/v1/realtime/ws?token=<jwt>" },
    { "type": "s2s-stream", "url": "/v1/s2s" },
    { "type": "post" } ],
  "iceServers": [ … ],
  "limits": { "maxSessionSeconds": 600, "maxConfigChars": 6144, "requestsCharged": 40, "replica": { "active": 3, "max": 16, "pending": 1 } } }
```

Edge transports the replica does not list are left out. URLs are absolute (`REALTIME_PUBLIC_URL`, else the request's
`X-Forwarded-Proto`/`Host`), since the browser receives them through the app's backend.

## Signaling and WS relay (browser routes)

Authenticated by the **session token** only (`Authorization: Bearer <token>`, or `token` in the JSON body; `?token=`
on the WebSocket), mounted in front of the proxy's API-key check (`createRealtime().mount(server)` — the proxy itself
is unchanged). CORS is open (`*`, no credentials): the bearer is the only authority.

- `POST /v1/realtime/sessions/:id/offer` `{sdp}` → the replica's `/__aigw/rt/offer` → `{sdp, type:"answer", sessionId}`.
  The token's `sid` must equal `:id` (403). Edge 409/429/503 → 503 `saturated`; unreachable → 502.
- `POST /v1/realtime/sessions/:id/ice` `{candidate}` (trickle, optional), `DELETE /v1/realtime/sessions/:id`.
- `GET /v1/realtime/ws?token=…` upgrade: the gateway first opens the replica's `/__aigw/rt/ws` (`ws://`, or `wss://`
  when `replicaBase` turns to https) with `X-Aigw-Token`, and only then answers 101 — a refusal is a plain HTTP error
  (401 bad token, 410 replica gone, 502 replica refused, 504 timeout) the SDK reads as "next rung". Frames pass through
  untouched; close codes and reasons cross both ways; pings every 20 s. Backpressure: the browser socket is paused
  while the replica's buffer is over 1 MiB (resumed under 256 KiB); a browser that stops reading (> 1 MiB queued, ~20 s
  of audio) is closed with 1013. Max message 1 MiB.
- Expired token → 401 `token_expired`; replica gone (`rep` no longer listed) → 410 `replica_gone`: open a new session.

The relay has its own RFC 6455 server codec (`ws-frames.ts`) because the gateway runs on Bun: Bun ≥ 1.4.2 delivers
writes on an upgraded `node:http` socket (1.3.x did not — checked 2026-10-07), and the code also runs under Node (tests).

## TURN

```
REALTIME_STUN_URLS    comma list (unset: stun:stun.l.google.com:19302; empty: none)
REALTIME_TURN_URLS    e.g. turn:203.0.113.7:3478?transport=udp,turns:turn.example.com:443?transport=tcp
REALTIME_TURN_SECRET  coturn static-auth-secret (use-auth-secret)
```

Per session (TURN REST API, what coturn implements): `username = "<exp>:<sid>"`, `credential =
base64(HMAC-SHA1(secret, username))`, valid until the token expires. No URLs or no secret → no TURN server offered.
The coturn deployment itself is a builtin deployment profile on the edge side; the gateway only consumes URL + secret.

**Health** (`src/realtime/turn-health.ts`). Every `REALTIME_TURN_CHECK_MS` (default 30 s; `0` turns the check off) the
gateway sends each TURN URL the first message of any TURN client — an Allocate request without credentials, over the
URL's own transport (UDP, TCP, or TLS for `turns:`) — and takes any STUN reply with its transaction id (coturn answers
401) as alive. A URL that answered before and then misses two checks in a row is `dead` and left out of the
`iceServers` a session receives until it answers again; a URL that has never answered this process stays `unknown` and
is still handed out (a gateway whose own egress drops UDP must not take TURN away from every learner). Each change is
logged (`realtime: turn server`, telemetry `rt.turn.health`), and `GET /health?details=1` (admin) lists
`turn: [{url, state, since, checkedAt, rttMs, failures}]`. The check does not prove that an allocation succeeds (the
shared secret, the relay port range) nor that a learner's network reaches the server; the edge's own relay test
(netcheck.py) and its per-offer credentials always get every configured URL.

## Load and the autoscaler

WebRTC audio never crosses the gateway, so the controller's lease counters do not see a talking class. The service
polls `/__aigw/rt/status` of the replicas of every deployment with live sessions (every 5 s) and:

- reports `active`/`max` through `reportExternalLoad(deployment, replicaId, active, max)` (`src/realtime/external-load.ts`);
  `externalInflightEquivalent()` converts it into the autoscaler's unit (a full replica = `targetInflightPerReplica`);
- calls `wake(deployment)` while any session is active, so the idle clock does not scale it to zero under a class.

The pressure decision adds that figure to the load it already reads (`controller-autoscale.ts` `decide`), under the
existing rule: occupancy above `scaleOutAt` (75 %) of the ready + booting replicas' slots for `windowSeconds` (20 s) asks
for one more replica (7 of 8 sessions on one L40S; 6 of 8 is exactly 75 % and asks nothing), a replica that is booting
counts as capacity, `maxReplicas`, the replica cap, the € ceiling and the create back-off apply as for any load, and
when the sessions end the extra replica is released by the scale-in rules. A deployment with no realtime session
reports nothing and is scaled exactly as before.

**Visible state.** `GET /v1/deployments/<name>` carries `realtime: {active, capacity, refusedSessions, scalingOut}`
(sessions on the replicas against their slots, from the edges' status, at most 30 s old; learners refused at admission
as `saturated` in the last 5 min; whether a replica is on its way while sessions are active — `autoscale.reason` and
`autoscale.blockedBy` say why, or what holds it: `maxReplicas`, the replica cap, the € ceiling, `out of stock since …`)
and `sessions`, the distinct sessions seen in the last minute. `GET /health?details=1` (admin) lists the same per
realtime deployment under `realtime`, with the ready and desired replica counts.

**Students, not requests.** A session is one id: the edge counts distinct session ids (a learner on WS and WebRTC at
once holds one slot), and the gateway counts the trace id of the SDK's `traceparent` (one per session) on admissions
and on `/v1/s2s` — the app backend relaying the clip rung must forward the browser's `traceparent` header.
`distinctSessions(deployment, windowMs)` and `refusedSessions(deployment, windowMs)` (`src/realtime/external-load.ts`)
give the counts; a learner retrying admission every few seconds is one refused session. The scale-out rule itself still
counts leases and refused requests per request (two concurrent requests of one learner are two requests on the GPU).

## The ladder (SDK)

```ts
import { createRealtimeSession } from '@parle/ai-gateway/realtime';

const session = createRealtimeSession({
  sessionEndpoint: '/api/lesson/realtime-session',     // the app's backend; it calls POST /v1/realtime/sessions
  getMicStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
  onEvent: (e) => render(e),
  s2s: { url: '/api/lesson/s2s' },                      // app backend relaying to /v1/s2s (s2s-stream rung)
  postTurn: (wav, { messages }) => myPlainEndpoint(wav, messages),   // last rung
  voice: { classifier: () => silero.load(), endSilenceMs: 1200, maxSpeechMs: 15000, echoTailMs: 400 },
});
await session.connect();   // → 'webrtc' | 'ws' | 's2s-stream' | 'post'
```

| Rung | Budget to connect | Notes |
|---|---|---|
| webrtc | ICE gathering ≤ 2 s + offer ≤ 3 s + connected ≤ 3 s | non-trickle offer sent at the first srflx or relay candidate (2 s is the ceiling, reached only on a host-only network); TURN from the session |
| ws | open ≤ 3 s + edge `ready` ≤ 3 s | AudioWorklet capture 16 kHz / 20 ms; ring-buffer playback 24 kHz |
| s2s-stream | immediate | the first turn proves it; frames/NDJSON decoded incrementally, audio played as it arrives |
| post | immediate | caller's `postTurn` |

- **Offer timing** — the SDK does not wait out `iceGatherMs`: the offer leaves at the first server-reflexive or relay
  candidate, when gathering completes, or at the ceiling. A webrtc transport offer with `iceTransportPolicy: "relay"`
  is passed to the peer connection and then only a relay candidate releases the offer. Candidates gathered later are
  not signalled (non-trickle): the browser still checks from them, and the edge learns them as peer-reflexive.
- **Playout delay** — `playoutDelayMs` (session option, default 0) is written to the receiver's `jitterBufferTarget`
  (milliseconds, 0–4000 in the W3C spec), or to `playoutDelayHint` (seconds) where only that exists; a browser with
  neither is left alone. 0 is the lowest value the spec allows and asks for no added delay: the browser still buffers
  what the jitter it measures needs. Raise it (40–80 ms) if a network produces audible gaps.
- **Start: WS and WebRTC raced** (`raceTransports`, default on; `false` = one rung after the other, as in the table).
  When the session offers both and WebRTC is the first rung, the two are started together with the one token and the
  session is usable on whichever is ready first — the WS, almost always (~0.1–0.3 s against 2.4–4.6 s). WebRTC goes
  on connecting on standby: no microphone track on it, its events and audio held back. Once it is connected the SDK
  switches **between turns** — nobody speaking, no reply pending or playing, 300 ms after the last audio —: it closes
  the WS (capture and player stop), puts the microphone track on the peer connection (`replaceTrack`), replays the
  conversation with one `config_update`, and emits `transport {transport:"webrtc", reason:"upgrade", from:"ws"}`.
  WebRTC not connected `upgradeMs` (5 s) after the start on WS is given up without any error and the session stays
  on WS. WebRTC ready first: the WS attempt is cancelled. Both failing: the clip rungs, in order. A WS that breaks
  while WebRTC is still connecting waits for it instead of dropping to a clip rung. The edge runs the two sessions of
  one `sid` side by side and counts the learner once (docs/realtime-edge.md); the standby one hears nothing, so a
  turn is never run twice.
- A refused admission (503 + fallback) skips the realtime rungs at once.
- The winner is remembered per network (`localStorage` key `aigw-rt:winner:<network>`, TTL 6 h, every access guarded);
  the next session starts there, the others stay as fallbacks. After a race it is the transport the session settled
  on: `webrtc` once it took over, `ws` only when the WebRTC attempt failed or ran out of `upgradeMs` — never because
  the WS merely won the start. A remembered `ws` starts the next session on WS alone, with no WebRTC attempt.
- **Network change on WebRTC** (Wi-Fi → mobile data): on ICE `failed`, or `disconnected` for more than
  `disconnectGraceMs` (3 s), the SDK opens a **fresh peer connection** and sends its offer to the same `offerUrl` with
  the same token (non-trickle, sent at the first srflx/relay candidate), waiting up to `iceRestartMs` (5 s) for a
  path. The edge recognises the re-offer of a live session (same `sid`, the token that opened it, its WebRTC session
  still running on that replica) and attaches the new peer connection to the same session: history and a turn in
  flight are untouched (the edge keeps running the turn; events it emits meanwhile are queued and arrive on the new
  data channel), the old peer connection is closed on both sides, and the page sees nothing (telemetry
  `rt.ice.restart` `{ok}`, edge `edge.session.reoffer`). It is a new peer connection rather than an ICE restart
  because aiortc cannot restart ICE on a live one. The edge gives up a peer connection ~30 s after its path died, so
  a re-offer later than that — or one refused, or with no path in time — is a mid-session failure, below.
- **Mid-session failure** (ICE restart failed, data channel or WS closed) → the next rung *down*, with
  a new session when that rung is realtime; the client keeps the conversation (`transcript` final → user message,
  `reply` → assistant) and replays it with `config_update`; a clip turn that failed is re-sent on the next rung.
  A realtime turn in flight cannot be re-sent (the learner's audio was live, the SDK holds no copy): it ends once
  with `error{code:"turn_lost"}` + `done{error:true}`, its transcript stays once in the history, and the page asks
  the learner to repeat.
- Voice (`@parle/ai-gateway/voice`): Silero `vadEnd` + the rest of `endSilenceMs` → `end_turn`; `vadStart` while the NPC
  speaks → `interrupt` (barge-in); on the clip rungs the voice SDK's turn-taking records the clip.
- Without `voice`, the page calls `sendEndTurn()`, `interrupt()`, `sendTurn(wav)` itself.

### A reply cut by an upstream error

When the edge fails after part of the reply was voiced (`error{code:"upstream"}` then `done{error:true}`), the SDK can
voice the rest instead of failing the turn. It needs two things and falls back to handing the error to the page when
either is missing:

- **the cut point, from the edge**: `unspoken` on the `error` event — the text of the reply no audio was sent for,
  cut on a sentence boundary — and `done{error:true}` sent only once the audio already queued has been played out.
  The SDK cannot work the cut out by itself (`reply_delta` is LLM text, not what was voiced). **The edge does not send
  `unspoken` yet**: until it does, behaviour is unchanged.
- **a way to voice text, from the app**: `speak(text, {config, traceparent, signal})` → encoded audio, the app's
  backend relaying to the gateway's `/v1/audio/speech` with the session's voice (like `s2s` and `postTurn`; the
  s2s-stream and post rungs answer a recorded turn and cannot voice a given text).

With both, the `error` is held, `speak(unspoken)` starts at once, and at `done{error:true}` its audio plays after what
was already heard. The page sees `recovered` (telemetry `turn.recovered`), `audio_end`, then a plain `done`: no
`error`. If `speak` or the playback fails, or takes longer than `turnMs`, the held `error` and `done{error:true}` are
delivered once; there is no second attempt. `interrupt()` during the recovered audio stops it (`interrupted`,
`done{interrupted:true}`).

### Pre-connect

`connect()` does the admission, the transport and the microphone, and sends nothing else: no `end_turn`, no turn, no
history. Call it while the page loads so the 2–5 s of connecting are not paid on the learner's first turn:

```ts
const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
mic.getAudioTracks()[0].enabled = false;                 // silence goes up: nothing can open a turn yet
const session = createRealtimeSession({ getMicStream: async () => mic, /* … */ });
const ready = session.connect();                         // not awaited: the page keeps loading
// … when the scene starts:
await ready;
mic.getAudioTracks()[0].enabled = true;
```

- The microphone permission prompt and `getUserMedia` must come from a user gesture on iOS; ask for it on the tap that
  opens the lesson and hand the stream to the session.
- A disabled track still sends silence, which keeps the edge's idle clock (`RT_IDLE_SECONDS`, 120 s without input)
  from closing the session; with the track enabled and server VAD, room noise before the scene would open a turn.
- The limits that bound the wait are the edge's: 15 min per session (`RT_MAX_SESSION_SECONDS`), counted from the
  connect, and the token's 10 min to connect at all. The token is single use per transport (only a WebRTC session
  still alive on the edge accepts its re-offer), so a pre-connected session cannot be re-opened: one that the edge
  ended fails over like any mid-session failure.
- The admission charges the app's budget once, at `connect()`, whether or not a turn follows.

## Telemetry

One W3C trace per session: the SDK creates `traceparent` (`00-<traceId>-<span>-01`) and sends it on every gateway call
(session request, signaling, WS as `?traceparent=`, `/v1/s2s`, the POST fallback via `postTurn`'s `traceparent`). The
gateway keeps it, forwards it to the edge on each call (new span id, same trace) and echoes `X-Aigw-Trace-Id`.

Event shape: `{ts, source:"browser"|"gateway", level, event, traceId, sessionId?, turnId?, durMs?, attrs?}`.

- Browser: `rt.ladder.try|ok|fallback` (from, to, reason; `ok` = the session started: transport, durMs, `upgrading` when WebRTC is still connecting), `rt.ladder.upgrade` (from, to, durMs since the start), `rt.ice.state`, `rt.ice.failed`, `rt.ice.restart` (ok), `rt.turn.used`,
  `rt.session.admitted|rejected|closed`, `vad.segment` (durMs), `turn.first_audio` (durMs from end of speech),
  `turn.done`, `turn.recovered`, `ws.close` (code), `error`. Batches of ≤ 100 to `POST /v1/telemetry/events` with the session token.
- Gateway: `rt.session.admitted|rejected|deleted`, `rt.signal.offer|refused`, `ws.open|close|refused`, `error` (sink
  pluggable, default the log).
- **Never** audio, transcript, LLM text, SDP or tokens: codes, counts, durations (the SDK's `safeAttrs` drops content keys).

The ingest route is built separately; it must be mounted like the signaling routes (session-token auth, in front of the
key check) — `RealtimeService.resolveToken(token)` verifies a token for it.

## Security

- **No key in the browser**: the app key stays on the app's backend; the browser holds a 10-minute token bound to one
  session, one deployment and one replica.
- **Ownership**: app keys open sessions only on their own app's deployments; `cfg` is signed, so the browser cannot
  change the system prompt, the deployment or the replica.
- **Replica token**: never sent to the browser; the edge derives the signing key from it, so a token for one deployment
  is useless on another.
- **Tokens in URLs** (WS): short-lived; the gateway logs never print them. Telemetry never carries them.
- **UDP exposure**: WebRTC needs the replica's UDP port range (`udpPorts` in the status) open to the internet. The edge
  must accept media only for sessions it has an answered offer for (ICE credentials from its own SDP) and drop the rest;
  TURN covers networks that block UDP (TCP/443 via `turns:`).
- **TURN**: credentials are per session and expire with the token; the shared secret stays in the gateway's env.
- **Budget**: sessions count against the app's daily request budget; a leaked app key cannot open unbounded sessions.

## End-to-end test plan with the edge

1. Contract vectors: the edge verifies `docs/realtime-token-vectors.json` (key derivation, every case, TURN credential).
2. Local stack: speech-stack image with the edge on a GPU (or CPU stubs for STT/LLM/TTS), gateway `bun run serve.ts`
   with the deployment registered against it; `GET /__aigw/rt/status` through the token gate.
3. Admission: `POST /v1/realtime/sessions` → 200 with webrtc+ws; fill `RT_MAX_SESSIONS` and check `saturated`; stop the
   replica and check `cold` + wake; `X-Gateway-No-Wake: 1` → not woken.
4. WebRTC in a real browser (palco desktop GPU session): SDK `connect()` → `webrtc`; speak a gTTS clip through the fake
   microphone; check `transcript`, `reply_delta`, `audio_start`, `metrics`, `done`, and the NPC audio actually played.
5. Block UDP to the replica (firewall) with coturn configured → `rt.turn.used` with `relayProtocol: tls|tcp`.
6. Block UDP and TURN → `ws` rung; same turn; check `ws.close` codes when the replica restarts mid-session (failover to
   `s2s-stream`, history kept).
7. Kill the edge → s2s-stream / post; check the remembered winner on the next session.
8. Barge-in: speak during NPC audio → `interrupted` within one frame; `end_turn` cuts the edge's silence wait.
9. Telemetry: every event of steps 3–8 shares the session's `traceId` across browser, gateway and edge logs.

## Load and bad-network harness (`scripts/realtime-e2e/load.ts`)

Measures what a class gets: N students, each holding one realtime session and speaking a clip on a duty cycle (default
3 minutes, one turn every 15 ± 5 s, arrivals spread over 30 s), under a named network profile, against the local fake
stack or a real gateway. The clock of every turn starts at the **last voiced sample of the clip the client sent** — so
the edge's endpointing silence (`RT_VAD_SILENCE_MS`, 700 ms) is inside the number — and stops at the first non-silent
audio received. Output: `<out>/report.json`, a text summary and one `PASS`/`FAIL` line (default target: p50 ≤ 1500 ms,
p95 ≤ 2000 ms, failures + truncations ≤ 1 %); exit code 0 / 1, 2 when the harness itself broke.

```bash
# local fake stack (Linux + root; same needs as e2e.ts)
EDGE_PYTHON=/root/rt-venv/bin/python CHROME_PATH=/path/to/chrome \
  bun scripts/realtime-e2e/load.ts --n 20 --rtc 8 --chrome 1 --profile campus-slow --replicas 2 --cap 16

# real gateway + deployment (profile clean runs anywhere; the others need Linux + root for netns/tc)
GW=https://gw.example KEY=<app key of the deployment's app> DEP=parle-speech \
RT_CONFIG='{"system":"…","messages":[],"voice":"<catalog voice>","language":"pt"}' \
  bun scripts/realtime-e2e/load.ts --n 100 --rtc 30 --chrome 2 --clip turn.wav --profile campus-slow --out /tmp/run1
```

Every option is in the header of `load.ts`. Against a real stack `--clip` must be real speech (PCM16 mono WAV, any
rate; e.g. gTTS + `ffmpeg -ac 1 -c:a pcm_s16le`): the default tone is what the fake stack's energy VAD hears as speech,
and a real Whisper filters it. Leading and trailing silence of the clip are cut, so the clip's end is the last voiced
sample. Each session charges the app's daily request budget at admission (40 requests per 10-minute token); an admin
key is not charged. The `generator` line of the summary says whether the machine running the clients kept up (simulated
microphone frames sent late): a run marked `SATURATED` measured the load generator, not the service.

### Clients — what each one exercises

| Client | Runs | Exercises | Does not exercise |
|---|---|---|---|
| `ws` (Bun, in `load-client.ts`) | every student that is not `--rtc` | admission, the gateway's WS relay, the edge's WS session: PCM16 16 kHz 20 ms frames up in real time (silence between turns, as a live microphone), events and 24 kHz audio down; the SDK's 64 KiB uplink-backlog drop | the browser's AudioWorklet capture and playback buffer, the SDK's own state machine, telemetry upload |
| `rtc` (aiortc, `load_rtc.py`, 8 peers per process) | `--rtc N` students | admission, signaling through the gateway, ICE (host, TURN), DTLS/SRTP, Opus both ways straight to the edge, the `events` data channel; the ladder: gather ≤ 2 s, offer ≤ 3 s, connected ≤ 3 s, else the `ws` client with the same token | a browser's ICE agent: aiortc uses **one** TURN server per connection (the harness picks the `transport=udp` URL, or `tcp` under `udp-blocked` / `--turn tcp`), gathers completely before the offer, and has no packet-loss concealment or adaptive jitter buffer |
| `chrome` (`page-load.js`, the real SDK) | `--chrome K` sessions, each forced on one rung (`--chrome-transports webrtc,ws,s2s-stream`, round robin) | everything a learner's browser does on that rung, and the **audible** latency (next section) | load: one Chromium each (~1 vCPU headless) |

The lightweight clients do not speak the `s2s-stream` and `post` rungs (Chrome does `s2s-stream`). A student refused at admission (`503 saturated`/`cold`) retries after
`Retry-After` and each turn they could not speak counts as a failed turn (`failed:admission:saturated`), so saturation
shows in the failure rate; the latency a real learner would then get on `/v1/s2s` is not measured.

### What a turn is counted as

- **ok**: `done` without error, audio heard, `audio_end` seen.
- **failed**: no session at the turn's time (admission refused, connect failed, session lost), no `done` within
  `--turn-timeout`, `error` before any audio, `empty`/`filtered` transcript, no audio.
- **truncated**: `error` (or a lost session, or no `done`) *after* audio started — the GPU round-2 case — or a clean
  `done` whose audio is too short for its reply: audio ms per reply character under `--trunc-ratio` (0.75) of the run's
  90th-percentile rate for that client (`--ms-per-char` fixes the reference instead; fewer than 5 clean turns: not judged). The realtime events do not
  announce sentences, so a missing sentence can only be seen as missing duration: one that is under 25 % of the reply
  passes at the default ratio (with the fake model's fixed-rate audio use `--trunc-ratio 0.9`).

Latency shares (≤ 1.0 / 1.5 / 2.0 s) are over **all attempted turns**: a failed turn counts as over 2 s.

### Audible latency in Chrome — one meter for every rung (`page-meter.js`)

`page-load.js` and `page-live.js` import `/meter.js` before the SDK. It measures at the page's audio **output**, without
touching `sdk/`: `AudioNode.prototype.connect` is wrapped, and every node connected to an `AudioDestinationNode` (the
SDK's player worklet on the `ws`, `s2s-stream` and `post` rungs) is mirrored into an `AnalyserNode`; the WebRTC remote
track goes into the same meter through a `MediaStreamSource`. One definition for all rungs: a ~20 ms window (`fftSize`
= the power of two nearest 20 ms at the context's rate: 21.3 ms at 24/48 kHz) polled every 5 ms, loud when its RMS is
over 0.02. The microphone is metered the same way on its own analyser, which is connected to nothing: its samples never
reach the output meter.

- **Reference instant** = the last voiced sample of the clip. Chrome does not say when its fake capture device starts
  feeding the file, so it is not derived from the file's timing: the page meters the microphone track itself, and the
  end of a loud span is `last loud poll − window + poll/2`. On the clip rung there is no live microphone: the page
  takes "now" as the end of the speech, waits `--clip-end-silence` (700 ms, the edge's `RT_VAD_SILENCE_MS`, standing for
  the client VAD's `endSilenceMs`) and posts the voiced clip — the same as posting a recording whose voiced range ended
  that long ago.
- **Per turn**: `receivedMs` (reference → the `audio_start` event: first audio from the server), `audibleMs` (reference
  → first loud window at the output), `heardAfterReceivedMs` (the playout path), `audibleFromVadEndMs` (the old figure,
  from the edge's `vad end` event; none on the clip rung) and `meterErrorMs`.
- **Error bound**: a loud onset is seen at the next poll, so each edge is known to ±2.5 ms on time and the latency to
  ±5 ms; when the page's timer runs late the bound of that turn is the real gap between polls, recorded as
  `meterErrorMs` (5 ms on almost every turn of an unloaded machine; the maximum is in the report). Not included: the
  device output latency after the Web Audio graph, and Chrome's `MediaStreamSource` input buffering, which delays the
  microphone reference and the WebRTC output alike.
- **What is not counted**: the microphone (never connected to a destination); a silent reply (`audio_start` arrives,
  no loud window: the turn is `failed:no_audio`, reported as *no audible audio*, never as a latency); the tail of the
  previous reply (output loud at the reference or 100 ms before it → the turn is `overlapped` and gets no figure).
- The report's `audible` block gives, per rung, audible p50/p95 next to the lightweight clients' p50 and their
  difference (`offsetMs`), so the lightweight numbers read as *audible ≈ protocol + offset*.
- **Why the live harness never drove a clip turn on `s2s-stream`** (both in the harness, fixed there): `page-live.js`
  only waited for `done` and never called `session.sendTurn()` — without the `voice` option nothing records a clip —
  and it passed no `config`: a session forced to a clip rung asks for no admission (`sdk/browser/realtime/session.ts`
  `admit()`, no realtime rung wanted), so there is no token and `config()` falls back to `opts.config ?? {}`; the turn
  would have reached `/v1/s2s` with no system prompt and no voice. The pages now fetch `/config.json` from the app
  backend and post `/clip.wav`. `e2e-live.ts turn webrtc|ws|s2s-stream` forces each rung.

### Network profiles

On Linux as root the clients always run in a network namespace (`aigwload`, veth `aigwl0` ↔ `aigwl1`, 10.77.0.0/24) and
the profile is applied to the veth pair only: `netem` on both ends, with an `fq maxrate` child for the rates — per flow,
so each student has its own slow link instead of the class sharing one. **Shaped**: student ↔ gateway (admission,
signaling, the whole WS relay path with its audio), student ↔ edge (WebRTC media over UDP), student ↔ TURN.
**Not shaped**: gateway ↔ edge, edge ↔ model, TURN ↔ edge (loopback / host-local). Against a real gateway the
namespace is NATed out (MASQUERADE + two FORWARD rules) and the real path to the gateway comes on top of the profile.
`netDown()` runs in a `finally` and on SIGINT/SIGTERM, and first thing on the next run: it deletes the namespace (the
veth pair and its qdiscs go with it), the NAT rules and `/etc/netns/aigwload`; the run prints whether `tc qdisc`,
`iptables -S`, `iptables -t nat -S` and `ip netns` are identical to before (`net-before.txt` / `net-after.txt`).

| Profile | Applied (each direction unless said) | Where the numbers come from |
|---|---|---|
| `clean` | namespace only, no qdisc | — |
| `campus-slow` | down 2 Mbit/s, up 512 kbit/s per flow; 40 ± 10 ms delay (80 ± 20 ms round trip); 1 % loss | **assumption**, not a measurement: a crowded classroom access point. Replace with a measurement in the room (speed test, `ping` to the gateway and `mtr` loss over a class hour) |
| `udp-blocked` | `iptables` in the namespace: outbound UDP dropped except port 53 | the firewall case of `docs/realtime-edge.md`: TURN over TCP or the WS rung |
| `lossy` | 75 ms delay (150 ms round trip), 5 % loss | assumption: the bad end of Wi-Fi |
| `flap` | the link drops (100 % loss) for 3 s every 30 s | assumption: roaming between access points |

netem's jitter reorders packets (each packet draws its own delay), which a real Wi-Fi link does less: `campus-slow`
is harsher on TCP than its numbers suggest.

### Cost

Against a real gateway the harness reads `GET /v1/deployments/<name>` every 2 s (replica count, phase, machine type,
catalog `pricePerHour`) and prints machine-hours per type and the € of the run window (replicas not `stopped` × their
price × time). Warm-up before the first student and the idle minutes after the last are outside the window. Against
the fake stack: `n/a`.

### Local proof (2026-10-07, fake stack in a 6-vCPU / 8 GB Linux VM, tone clip of 1.4 s)

The fake model answers in ~230 ms after the edge's 700 ms endpointing (STT 80, LLM first token 60, first sentence, TTS
50), so ~930 ms is the floor; every row is 180 s per student + 30 s ramp unless said.

| Run | Turns ok / attempted | First audio p50 / p95 ms: ws · webrtc (aiortc) | Notes |
|---|---|---|---|
| `clean`, N=20 (8 webrtc), 3 Chrome, 2 × 16 | 281 / 281 | 940 / 1005 · 1174 / 1668 | PASS. Chrome audible p50: ws 949, s2s-stream 944, webrtc 1149 |
| `clean`, N=100 (6 webrtc), 6 × 16 = 96 slots | 1146 / 1186 | 929 / 935 · 1161 / 1164 | 4 students refused 304 times (`503 saturated`, Retry-After 2 s) until slots freed: 40 turns `failed:admission:saturated`, FAIL on 3.37 % |
| `campus-slow`, N=20, 1 Chrome | 250 / 250 | 1018 / 1083 · 1657 / 1964 | 3 of 9 WebRTC connects missed the 3 s budget and fell to ws; Chrome webrtc p50 1390 |
| `udp-blocked`, N=20, 1 Chrome | 253 / 253 | 928 / 941 · 1162 / 1165 | every aiortc pair `relay/host` (TURN over TCP), none `host/host` |
| `flap`, N=20, 1 Chrome | 246 / 248 | 931 / 3097 · 1161 / 3703 | turns that meet the 3 s outage wait for it; 2 timeouts; FAIL on p95 |
| `lossy`, N=20, 3 Chrome, 90 s | 137 / 139 | 1274 / 2552 · 1952 / 2376 | FAIL; Chrome audible p50: ws 1279, webrtc 1704, s2s-stream 2125 |
| `FAKE_TTS_DROP_EVERY=4` (empty body), N=10, `--trunc-ratio 0.9` | 24 / 89 | — | 65 `truncated:short_audio` = all 65 turns whose audio was shorter than the full reply |
| `FAKE_TTS_DROP_EVERY=4 FAKE_TTS_DROP_MODE=abort`, N=10 | 40 / 86 | — | 46 `truncated:error_after_audio:upstream` |
| `FAKE_TTS_SILENT=1`, N=4, 3 Chrome | 0 / 41 | — | all `failed:no_audio`; Chrome received `audio_start` on the three rungs and reports no audible audio |

Audible vs protocol (clean): ws +9 to +15 ms in four runs (the player worklet); webrtc −63 to −25 ms (Chrome's jitter
buffer is shorter than aiortc's fixed one, and the spread is ~250 ms, so the aiortc figure is an upper estimate, not an
offset to add); `s2s-stream` has no lightweight client, its audible p50 equals ws within 20 ms, and its first turn pays
~120 ms more because the SDK creates its player on the first audio. Limits of this VM: 100 `ws` students run at load
average 2.3; 24 aiortc students saturate it (the run is marked `SATURATED`); 8 aiortc + 3 Chrome is the most it carried.
