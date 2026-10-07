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

`max` comes from the spec env `RT_MAX_SESSIONS` (default L40S 16, L4 8 through `envByMachineType`). A replica whose
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
   have not connected yet (a class of 30 arriving at once must not all land on the same 8 slots). The replica with the
   most free slots that speaks a wanted transport wins.
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

## Load and the autoscaler

WebRTC audio never crosses the gateway, so the controller's lease counters do not see a talking class. The service
polls `/__aigw/rt/status` of the replicas of every deployment with live sessions (every 5 s) and:

- reports `active`/`max` through `reportExternalLoad(deployment, replicaId, active, max)` (`src/realtime/external-load.ts`);
  `externalInflightEquivalent()` converts it into the autoscaler's unit (a full replica = `targetInflightPerReplica`);
- calls `wake(deployment)` while any session is active, so the idle clock does not scale it to zero under a class.

**Wiring pending** (the autoscale files are being changed by another PR): in `src/deployments/controller-autoscale.ts`,
where the pressure decision reads `const load = this.demandOf(rt);`:

```ts
// TODO(realtime): count realtime sessions as load (src/realtime/external-load.ts)
const load = this.demandOf(rt) + externalInflightEquivalent(rt.record.spec.name, rt.record.spec.targetInflightPerReplica);
```

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
- A refused admission (503 + fallback) skips the realtime rungs at once.
- The winner is remembered per network (`localStorage` key `aigw-rt:winner:<network>`, TTL 6 h, every access guarded);
  the next session starts there, the others stay as fallbacks.
- **Mid-session failure** (ICE failed, connection lost > 3 s, data channel or WS closed) → the next rung *down*, with
  a new session when that rung is realtime; the client keeps the conversation (`transcript` final → user message,
  `reply` → assistant) and replays it with `config_update`; a clip turn that failed is re-sent on the next rung.
- Voice (`@parle/ai-gateway/voice`): Silero `vadEnd` + the rest of `endSilenceMs` → `end_turn`; `vadStart` while the NPC
  speaks → `interrupt` (barge-in); on the clip rungs the voice SDK's turn-taking records the clip.
- Without `voice`, the page calls `sendEndTurn()`, `interrupt()`, `sendTurn(wav)` itself.

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
  connect, and the token's 10 min to connect at all. The token is single use per transport, so a pre-connected
  session cannot be re-opened: one that the edge ended fails over like any mid-session failure.
- The admission charges the app's budget once, at `connect()`, whether or not a turn follows.

## Telemetry

One W3C trace per session: the SDK creates `traceparent` (`00-<traceId>-<span>-01`) and sends it on every gateway call
(session request, signaling, WS as `?traceparent=`, `/v1/s2s`, the POST fallback via `postTurn`'s `traceparent`). The
gateway keeps it, forwards it to the edge on each call (new span id, same trace) and echoes `X-Aigw-Trace-Id`.

Event shape: `{ts, source:"browser"|"gateway", level, event, traceId, sessionId?, turnId?, durMs?, attrs?}`.

- Browser: `rt.ladder.try|ok|fallback` (from, to, reason), `rt.ice.state`, `rt.ice.failed`, `rt.turn.used`,
  `rt.session.admitted|rejected|closed`, `vad.segment` (durMs), `turn.first_audio` (durMs from end of speech),
  `turn.done`, `ws.close` (code), `error`. Batches of ≤ 100 to `POST /v1/telemetry/events` with the session token.
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
