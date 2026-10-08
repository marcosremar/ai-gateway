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
`temperature`, `stt_prompt`, `speak_field`, `first_audio_deadline_ms`, `opener`, …) plus `deployment`. It travels
inside the token (`cfg`).

### Session token

JWT HS256. Signing key per deployment, derived from the replica token (never leaves the gateway or the replica):

```
key = HMAC-SHA256(key = <deployment replicaToken>, message = "aigw-rt-v1")      # 32 raw bytes
claims = { sid, app, dep, rep, cfg, [dev], iat, exp, [cfd] }    # serialized in this order; base64url without padding
  sid  session id (rt_<32 hex>)      app  app account      dep  deployment      rep  replica id
  cfg  base64url(JSON(session config)), ≤ 6 KB (6144 characters); "" with `cfd` when the config goes by reference (below)
  dev  optional: the app's device id for this session (`device` at admission); absent when none was sent.
       The edge ignores it; the gateway refuses the token of a blocked device (docs/api/http.md § App devices)
  iat/exp  unix seconds, exp − iat ≤ 900 (15 min); default TTL 600 s (REALTIME_SESSION_TTL_SECONDS)
```

Verification: header `alg` must be `HS256`; constant-time signature check; `exp > now`; `iat ≤ now + 60`;
`exp − iat ≤ 900`; `cfg` ≤ 6144. Test vectors (valid, expired, tampered, wrong key, TTL too long, future iat, and the
TURN credential): [`docs/realtime-token-vectors.json`](realtime-token-vectors.json) — cross-checked in Python too.

The token is **signed, not encrypted**: the browser can read `cfg`. No secret belongs in the session config.

**Config by reference** (configs over 6144 characters, up to `RT_MAX_CFG_REF_CHARS` = 32768 base64url characters,
~24 KB of JSON; above that admission answers 413). The 6144 cap exists because the token rides in the WebSocket URL
and is base64url-encoded twice (an 8.3 KB request line, at nginx's and aiohttp's limits). A larger config leaves the
token: `cfg` is `""` and one more claim, `cfd` = base64url(SHA-256(the config's base64url text)), is appended after
`exp` (tokens without it are byte-for-byte what they were; the vectors are unchanged). The descriptor then carries
the text itself in `cfg`, and the client hands it to the edge at session start: the first WS text frame
`{type:"session_config", cfg}`, or `cfg` next to `sdp` in the offer body (also on a re-offer). The edge accepts the
session only when the text hashes to the signed `cfd` (reason `cfg` otherwise, before the token is consumed; a WS
waits 5 s for the frame), so authenticity is still checked offline, with no call to the gateway and no state in it:
a gateway restart between admission and connect changes nothing. An SDK older than this change cannot open a
by-reference session (it never sends the config); configs that fit keep riding in the token, as before.

**What fits the LLM.** The bound is on the whole config; what limits the *prompt* is the LLM's context per slot
(`LLM_SLOT_CTX`, read by the edge from `/health` `llm_ctx`). The history fit keeps the system prompt and every
`system` message whole and estimates 3 bytes per token + 8 per message, so of `ctx − max_tokens (160) − 64` tokens:

| System prompt (UTF-8) | est. tokens | slot 2048 (L4): 1824 usable | slot 4096 (L40S): 3872 usable | slot 8192: 7968 usable |
|---|---|---|---|---|
| 3 KB | ~1030 | ~790 left: about 11 short exchanges of history | ~2840 left | fits |
| 4.6 KB (the school's largest) | ~1580 | ~240 left: 3 exchanges, then the oldest go | ~2290 left: about 30 exchanges | fits |
| 5.4 KB | ~1850 | nothing left: the turn itself does not fit | ~2020 left | fits |
| 7 KB | ~2400 | **cannot work** (LLM answers 400 on every turn) | ~1470 left: about 20 exchanges | fits |
| 11.5 KB | ~3930 | cannot work | nothing left | ~4000 left |
| 16 KB | ~5470 | cannot work | **cannot work** | ~2500 left |

The estimate is deliberately high (llama.cpp counts ~3.6 bytes per token for Portuguese), so the real room is a
little larger; the LLM's own count decides. A prompt over the slot is not refused at admission (the gateway does not
know the replica's slot): every turn ends with `error{code:"upstream"}`, stage `llm`, HTTP 400 "context size".

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

`max` comes from the spec env `RT_MAX_SESSIONS` (default L40S 4, L4 2 through `envByMachineType`: what one replica
serves with the **maximum** first audio under 2.5 s — measured on the L40S, docs/reports/2026-10-07-realtime-handoff.md
§ New image and class capacity: max 1.49–2.12 s at 4, 2.16–2.39 s at 6, 2.64–2.83 s at 8; the L4 figure is an estimate
from its `/v1/s2s` numbers). `available` is 0 while the replica sheds load: a learner is seated and the worst first
reply audio of its last `RT_SHED_WINDOW_S` (30 s) is over the deployment's deadline (`firstAudioMaxMs`, `shedding` in
the status); admission then places new sessions on another replica or sends them down the ladder (`saturated`). A replica whose
`/__aigw/rt/status` answers 404 runs no edge and gets no realtime session.

### Events and control messages

Edge → client (data channel "events", JSON, or WS text frames), the s2s vocabulary:
`{type:"ready"}`, `{type:"vad", state:"start"|"end"}`, `{type:"transcript", text, final}`, `{type:"filtered", reasons}`,
`{type:"reply_delta", text}`, `{type:"reply", text}`, `{type:"audio_start"}`, `{type:"audio_end"}`,
`{type:"interrupted"}`, `{type:"done", empty?, filtered?, intercepted?, said?, tag?, served?}`, `{type:"intercept", tag, action}`,
`{type:"say", text, tag}`, `{type:"config_applied", n}`, `{type:"error", code, message}`,
`{type:"metrics", ttfa_ms, stt_ms, llm_ttft_ms, tts_ttfb_ms, endpoint_ms, ttfa_from_speech_ms, first_sound_ms,
first_sound_from_speech_ms, opener, deadline_ms, deadline_missed}`, `{type:"opener", state:"start"|"end", text, index,
audio_ms}`, `{type:"deadline_missed", deadline_ms}` (next section).

Client → edge: `{type:"interrupt"}`, `{type:"end_turn"}` (client VAD: the learner stopped), `{type:"config_update",
messages?, opener?}`, `{type:"ping"}`.

**The signed session config is authoritative.** A client `config_update` may carry only `signed` (an update the
gateway signed for the app, § App hooks), or `messages` (appended to the
history; `user` and `assistant` roles with string content — the SDK replays the turns of a broken session into the new
one) and `opener` (`null` switches the signed opener off, anything else switches the signed one back on: the value is
never used). Any other field, a `system` message or a malformed `messages` refuses the whole update: nothing changes,
the client gets `{type:"error", code:"forbidden"}` and the edge emits `edge.config.refused {keys, count}` (field names
only). `system`, `voice`, `fallback_voice`, `user_template`, `max_tokens`, `temperature`, `stt_prompt`, `language`,
`vad` and `first_audio_deadline_ms` change only with a config signed by the gateway for the app.

### App hooks: intercepts, say, signed updates, reply guard, served ids

All optional; a session without these fields behaves exactly as before. They are part of the signed session config
(checked at admission, 400 `invalid_request` when malformed), so the browser cannot change them.

**`intercepts`** — the app sees the learner's final transcript before the reply is voiced, with no network hop: a rule
set evaluated on the edge, between the hallucination guard and the LLM.

```json
"intercepts": [
  { "tag": "slower",  "action": "drop", "contains": ["mais devagar", "fala devagar"] },
  { "tag": "repeat",  "action": "drop", "contains": ["pode repetir", "não entendi"], "whole": ["desculpa", "como"] },
  { "tag": "repeat",  "action": "drop", "whole": ["hã", "hum"], "question": true },
  { "tag": "options", "action": "say",  "contains": ["opções"], "text": "Você pode pedir um pão.", "voice": "rafa" }
]
```

- Matching is a plain normalised-phrase test, no patterns: transcript and phrases are lowercased, stripped of accents
  (NFD) and of `- , ! ? . ; : ' " ( ) « »`, spaces collapsed — the school's own `normalizeSemanticText`
  (`core/text/semantic-text.ts`, used by `learnerRequestOf` in `backend/fast-version-routes.ts`). `contains`: the
  phrase appears as whole words anywhere; `whole`: the phrase is the entire utterance; `question: true`: only when the
  raw transcript has a `?`. The first matching rule wins. Linear in the text: nothing to backtrack.
- Bounds: 32 rules, 64 phrases per list, 80 characters per phrase, `tag` `[a-z][a-z0-9_.-]{0,39}`, `text` ≤ 400.
- A matched turn is **not sent to the LLM** (a speculative turn does not start it either) and **never enters the
  history**. Events: `transcript{final}` → `intercept{tag, action, turnId}` → (`action:"say"`: `say{text, tag}` →
  `audio_start` → the line's audio, synthesized with the rule's `voice` / `fallback_voice` or the session's, in the
  session's audio queue → `audio_end`) → `metrics` → `done{intercepted:true, tag, served?}`. No opener plays for it.
  The page runs its own behaviour on `intercept` (repeat the last audio, slower, show the transcript).
- Cost on a turn no rule matches: one in-process string test (0.3 ms for 32 × 64 phrases, measured in
  `tests/test_session.py`), no await, no upstream call: first audio is unchanged.
- Not evaluated on the clip rungs (`/v1/s2s`, the composed fallback): there the app's own backend sees the transcript.
  The fields are carried in the config and ignored, so a session with rules still falls back; a command spoken on a
  clip rung goes to the LLM like any other utterance and enters the history, speculated or not (a speculative start
  voices nothing: the answer is only streamed for the final clip). `reply_guard` is not applied there either. An app
  that needs the command on the fallback matches the `transcript` event in its own backend, as before these rules.

**Signed update** — the app changes a live session through the gateway, never through the browser's own word:
`POST /v1/realtime/updates {token, update}` (app API key; the session must be the app's) → `{sessionId, signed, n}`.
`signed` is a JWT (HS256, the session's key, claims `sid, upd, n, iat, exp` with `exp` = the session token's) that
the page forwards as `{type:"config_update", signed}` (SDK: `session.applyUpdate(signed, history?)`). The edge
verifies it offline, for this `sid`, with `n` (the gateway's clock, ms) greater than the last applied one, then:

| `update` field | Effect |
|---|---|
| `drop_turn: "<turnId>"` | removes that turn's user and assistant messages from the history (an interrupted turn) |
| `messages: [...]` | **replaces** the history (the client's own `config_update{messages}` only appends) |
| `system`, `voice`, `fallback_voice`, `user_template`, `max_tokens`, `temperature`, `stt_prompt`, `opener`, `first_audio_deadline_ms`, `intercepts`, `reply_guard` | replace that field of the session config |
| `say: {text, voice?, fallback_voice?, history?, tag?}` | voices the line in the session's audio queue, after the turn in progress; `history: true` appends it as an assistant message; ends with `done{said:true, tag, served}` |

It answers `config_applied{n}`; a bad signature, another session's update, an expired or replayed one is refused like
any forbidden `config_update`. Withholding an update only leaves the page with its previous signed state. `language`
and `vad` are fixed for the session.

**`reply_guard: {deny: [phrases], note?}`** — the gateway never decides what language a reply is in; the app names
phrases a reply of its character must not open with (function words of the wrong language: `sure`, `of course`,
`bien sûr`…; same matcher, up to 256). The first sentence is checked when the cutter closes it, which is when its TTS
would start anyway, so a passing reply costs no first audio (the first sentence's `reply_delta` arrives in one piece).
A denied first sentence is never voiced: the LLM is asked once more with `note` appended to the user turn, and that
second answer is voiced unchecked (`metrics.reply_retries: 1`, `edge.llm.reply_guard`). The retry costs one more LLM
time-to-first-token plus the first sentence's generation on that turn only. Not applied with `speak_field`, in
`s2s` upstream mode or on the clip rungs.

**`served`** — `done` of a voiced turn carries what answered it:
`{stt, llm, tts, voice, opener, transport}`. On the edge the three ids are the replica's own (`/health` → `models`;
without it `stt` is `null`, `llm` / `tts` are `EDGE_LLM_MODEL` / `EDGE_TTS_MODEL`), `voice` the id sent to the TTS
(the catalog voice, the `fallback_voice` when the catalog does not know it, `"custom"` for `{audio, text}`), `opener`
whether an opener line played, `transport` `webrtc` / `ws`. On the composed path (`/v1/s2s` fallback) the ids are
each stage's `X-Gateway-Provider` (`deployment:<name>` or `<provider>:<upstream model>`), `transport` is `s2s`, and
`voice` is the cast voice when the first TTS target served, `null` when a fallback target chose its own. The SDK
copies it to `metrics.lastTurn.served`.

### First-audio deadline and opener

Requirement (owner, 2026-10-08): the time from the end of the learner's speech to the first sound must never exceed
2500 ms. Every component that produces a turn's audio enforces it with the same rule, fields and events: the edge
session (WebRTC / WS), the speech-stack's `/v1/s2s` and the gateway's composed fallback.

**Config** (session config / `/v1/s2s` `config`, all optional):

| Field | Default | Meaning |
|---|---|---|
| `first_audio_deadline_ms` | deployment's (2000) | deadline of the first sound, ms after the end of the speech; capped at 2500 |
| `opener` | none | `{"lines": ["…", "…"]}`: up to 8 short lines the app authored for the character, in the session's language |
| `endpoint_ms` | 0 | `/v1/s2s` only: the silence the client waited after the speech before posting the clip. The server only knows when the request arrived; with this the deadline starts at the end of the speech (the edge needs none: its VAD knows the last speech frame) |

**Speculative turn** (`/v1/s2s`, composed fallback only): `config.speculation = {id, turn, action: "start"}` with the
clip so far (WAV) starts the STT, then the LLM, on what was heard up to a pause and answers `202 {"speculative": true}`
(or `false` with a `reason`: `short`, `format`, `turn_cap`, `busy`, `off`); `{id, action: "cancel"}` drops it when the
speech resumes; the turn names `{id}` and starts from that transcript without a second STT. Nothing speculative is
voiced, the app is charged once per turn. The SDK does it on the s2s-stream rung when `voice.speculatePauseMs` is set.
It travels by HTTP to the gateway only: nothing about it is sent to the edge, whose `config_update` allow-list it does
not touch (`docker/aigw-edge/tests/sdk-client-updates.json` lists every frame the SDK sends there on its own).
Bounds and measurements: docs/reports/2026-10-07-realtime-handoff.md § Fallback em streaming.

Deployment defaults: `RT_FIRST_AUDIO_DEADLINE_MS` / `RT_FIRST_AUDIO_MARGIN_MS` on the edge (`realtime.env`),
`FIRST_AUDIO_DEADLINE_MS` / `FIRST_AUDIO_MARGIN_MS` on the speech-stack and the gateway: 2000 and 300 ms.

**Rule.** If no audio of the turn has been queued at deadline − margin (1700 ms after the speech by default; the margin
is the time the audio needs to reach the ear), the component plays one opener line, then the reply when it arrives:

```
… opener{state:"start", text, index, audio_ms} → [the line's audio] → opener{state:"end", index} → … reply audio …
```

- Never two openers in a turn, never an opener once reply audio is queued; the reply is queued behind the opener in
  the same audio stream, so nothing overlaps and nothing is said twice.
- The line rotates: on the edge the next one after the session's last, on `/v1/s2s` by the turn number of the
  conversation (`messages.length / 2`), so two turns in a row never get the same line (with ≥ 2 lines).
- A cancelled turn (barge-in, `interrupt`, speech that resumes, a client that leaves) drops the opener with the rest of
  the queued audio.
- The gateway never writes a character's words: no `opener` → none is played, and a turn with no sound at the deadline
  reports `deadline_missed{deadline_ms}` (in-band, plus `edge.turn.deadline_missed` / the SDK's `turn.deadline_missed`).
  The same happens when the lines are configured but not synthesized yet (first turn of a new voice) or failed to.
- **Where the audio comes from.** Each line is synthesized once per voice + language + text with the session's own
  voice and kept in the process (256 entries, oldest dropped; a failed synthesis is retried by the next session or
  turn): on the edge at session start and at a `config_update` that changes it (one cache per edge process: the front
  and each WebRTC worker), on `/v1/s2s` at the first turn that names the lines. Leading silence is trimmed to 10 ms.
  The composed fallback keeps the bytes in the format its TTS chain answered: a PCM/WAV answer is stored as PCM, an MP3
  answer (the cloud TTS) stays MP3 — an `audio_format` event precedes the opener and the reply announces its own format
  again, which is the per-format path the SDK's clip rung already has (no transcoding in the gateway).
- `/v1/s2s` through the gateway: opener audio does not count as the primary's first audio in the hedge race, and a
  hedged or resumed composed turn plays no opener of its own (one per turn across both lanes).

**What the app records.** An opener is speech of the character: the `opener{state:"start"}` event (page) and the
turn's `metrics` / `done` carry which line was played. Fields added to `metrics` (edge) and `done` (`/v1/s2s`):
`first_sound_ms` (opener or reply), `opener` (the line, or null), `deadline_ms`, `deadline_missed`; the edge adds
`first_sound_from_speech_ms` next to `ttfa_from_speech_ms`, `/v1/s2s` adds `endpoint_ms`. `ttfa_ms` / `first_audio_ms`
stay the first **reply** audio (on the edge it now includes the opener audio still queued ahead of it). SDK:
`{type:"opener", state, text, index, audio_ms}` and `{type:"deadline_missed", deadline_ms}` events,
`session.metrics.lastTurn.{first_sound_ms, opener, deadline_missed}`, telemetry `turn.opener` (durMs from the end of
the turn, `index`) and `turn.deadline_missed`; `audio_start` remains the first reply audio.

**The learner's clock (browser SDK).** The server's deadline starts at the speech the server heard, so it cannot see an
uplink that stalls (2026-10-08, live: 7 of 702 turns over 2500 ms at the learner, the speech reaching the edge 2.0–4.4 s
late, the edge answering in 100–490 ms). The SDK therefore keeps the same deadline on its own clock, from its own end
of speech (`voice.endSilenceMs` before `end_turn` / the clip, or the config's `endpoint_ms` when the page ends turns
itself with `sendEndTurn()` / `sendTurn()`):

- At `connect()` the SDK asks the app's `speak` for the first two `opener.lines` (one after the other, the session's
  config and voice — the same call that voices a cut reply), decodes them and trims the leading silence to 10 ms. No
  `speak`, no lines or a failed synthesis: no client opener (`rt.opener.cached` says how many clips it has).
- If neither a server opener nor reply audio has reached the page at the deadline (`first_audio_deadline_ms`, default
  2000; never later than 2400 on this clock), it plays the next line itself: `opener{state:"start", local:true, text,
  index, audio_ms}` … `opener{state:"end", local:true}`, telemetry `turn.opener` with `source: "client"`.
- One opener per turn, whoever starts first. The server's opener or reply arrives first: the timer is dropped (the fast
  path sends and plays nothing new). The client plays first: on webrtc / ws it sends `config_update {opener: null}`
  behind the turn (the edge then plays none and reports `deadline_missed`, which the SDK does not pass on) and restores
  the lines at `done`; a server opener already on its way is dropped — on ws the next `audio_ms` of PCM after its
  `opener start`, on s2s-stream the audio between its `opener` events.
- No overlap: on ws and the clip rungs the line goes into the transport's own player, so the reply queues behind it. On
  webrtc the reply is a live track that cannot be queued: the line plays on the SDK's player and is cut when the
  reply's `audio_start` (or a server opener) arrives.
- Barge-in, `interrupt()`, speech that resumes (the SDK's VAD) and a transport that breaks drop the pending or playing
  line; a turn lost with its transport still ends in one `done{error}` and is not sent again on a realtime rung.
- Metering: `turn.first_sound` (`durMs` from the learner's end of speech to the first sound at the page, `source`
  `reply` / `opener` / `client_opener`, `uplinkBufferedBytes` on ws), `fromSpeechMs` on `turn.first_audio` and
  `turn.opener`, and on `turn.done` `firstSoundMs`, `clientOpener` and `networkDelayMs` = the page's time to the first
  server sound minus the edge's `first_sound_from_speech_ms` (uplink + downlink of the turn, no clock compared; also
  `session.metrics.lastTurn.{learner_first_sound_ms, network_delay_ms}`). With `voice` the SDK also sends `endpoint_ms`
  in the clip rungs' config.

**Limits — what can still exceed the ceiling.** The server's deadline is enforced where the audio leaves the server, the
SDK's where the audio enters its player (a session with server VAD only and no `sendEndTurn()` has no client clock; a
page without `speak` has no client opener; the times are of arrival at the page, not of the loudspeaker). Not covered:
a network stall after that (the margin is 300 ms; a WS relay or TURN path that freezes longer delays the opener too), a
device that is not playing (suspended `AudioContext`, autoplay blocked, a Bluetooth sink waking up), the upload of a
clip on `/v1/s2s` (the server's clock starts when the request has arrived, `endpoint_ms` earlier), a WebRTC jitter
buffer under loss, a session with no opener (telemetry only), an opener not cached yet, and an MP3 opener on a client
that decodes it late. The **reply** behind an opener is as late as it was: the opener bounds the silence, not the
answer.

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
  "limits": { "maxSessionSeconds": 600, "maxConfigChars": 32768, "requestsCharged": 40, "replica": { "active": 3, "max": 16, "pending": 1 } } }
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
for one more replica (4 of 4 sessions on one L40S; 3 of 4 is exactly 75 % and asks nothing), a replica that is booting
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

**Who served a turn** (for the study's records). On `webrtc` / `ws` the session's GPU replica serves every turn (the
SDK's `transport` event and the `transport` attribute of `turn.first_audio` / `turn.done`). On the clip rung each
`/v1/s2s` answer says it three times: the `X-Gateway-Provider` / `X-Gateway-Fallback` / `X-Gateway-Fallback-From`
response headers (for the app backend that relays it), the first `route` event of the stream (`{provider:
"deployment:<name>"}` = the GPU; `{provider: "composite", fallback, from}` = the fallback, with `fallback` =
`saturated` | `cold` | `circuit_open` | `paused` | `slow` | `error` | `resumed` | …), which the SDK hands to the page as
`{type: "route", provider, fallback?}`, and the `provider` / `fallback` attributes of the SDK's `turn.done` telemetry.
Why a learner is on the clip rung at all is the `reason` of the SDK's `rt.session.rejected` (`saturated`, `cold`, …).

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
- A refused admission (503 + fallback) skips the realtime rungs at once, and the clip rung it lands on is not
  remembered as the network's winner (the network was not the reason).
- **Refused as `saturated` or `cold`: the session moves to the GPU when it is admitted.** On its clip rung it asks for
  a session again in the background — after `Retry-After` (else `readmitMs`, 2 s), then ×1.5 up to `readmitMaxMs`
  (30 s), for at most `readmitForMs` (20 min; then telemetry `rt.readmit.gave_up`), never after `close()`. Once
  admitted it connects the realtime rung on standby (WebRTC, then WS; no microphone on either until live) and
  switches **between turns** by the same move as the start race: one `config_update` with the conversation,
  `transport {transport, reason:"upgrade", from:"s2s-stream"}`, telemetry `rt.ladder.upgrade {from, to}`. A clip turn
  that breaks while the standby rung is ready moves at once (`reason:"failover"`, `turn_lost` for that turn). Any other
  refusal code stops the asking. `readmit: false` turns it off.
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

- Browser: `rt.ladder.try|ok|fallback` (from, to, reason; `ok` = the session started: transport, durMs, `upgrading` when WebRTC is still connecting), `rt.ladder.upgrade` (from, to, durMs since the start), `rt.readmit.gave_up` (reason: `deadline`, `no_transport` or the refusal code), `rt.ice.state`, `rt.ice.failed`, `rt.ice.restart` (ok), `rt.turn.used`,
  `rt.session.admitted|rejected|closed`, `vad.segment` (durMs), `turn.first_audio` (durMs from the end of the turn, `fromSpeechMs`),
  `turn.first_sound` (durMs on the learner's clock, source), `rt.opener.cached` (clips, lines), `turn.done` (firstSoundMs, networkDelayMs, clientOpener), `turn.recovered`, `ws.close` (code), `error`. Batches of ≤ 100 to `POST /v1/telemetry/events` with the session token.
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
p95 ≤ 2000 ms, failures + truncations ≤ 1 %, and **no turn whose first sound is over `--ceiling-ms`**, 2500); exit code
0 / 1, 2 when the harness itself broke. That number is the first **sound** (an opener or the reply). The report also
has `ceiling` (`max`, the share of turns over 2000 / 2500 / 3000 ms, how many turns played an opener, how many missed
the deadline with none) and `firstReplyAudioMs`: the reply alone, which behind an opener is heard when it arrived and
the opener is over (`scripts/realtime-e2e/ceiling.ts`). To exercise the opener, put `opener.lines` in `RT_CONFIG`; the
`/v1/s2s` client sends `endpoint_ms` = `--clip-end-silence`. `--uplink-stall 3000` holds the audio of every third
utterance of the Chrome sessions on ws / s2s-stream for 3 s after the speech (the 2026-10-08 failure), and
`--client-deadline` turns on the SDK's own deadline in those pages (the page ends the turn, `speak` = the gateway's
`/v1/audio/speech` with `--tts-model`); `audible.<transport>.sdkFirstSoundMs` / `networkDelayMs` put the SDK's numbers
next to the meter's.

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
| `s2s` (Bun, in `load-client.ts`) | `--s2s N` students | no session: each turn is one `POST /v1/s2s` with the clip (16 samples changed per turn, so the STT cache never answers), the framed answer read to the end; the `route` event and the provider of every stage, per-stage times, in-band errors and refused turns (`http_<status>:<stage>_<status>`); encoded audio (a cloud TTS that answers MP3) is decoded with `ffmpeg` for its length and first loud sample. The clock starts at the request **minus `--clip-end-silence`** (the endpointing the page adds); the `s2s` block of the report gives the same numbers from the request. `--no-wake` sends `X-Gateway-No-Wake: 1` | the page's own VAD and playback |
| `chrome` (`page-load.js`, the real SDK) | `--chrome K` sessions, each forced on one rung (`--chrome-transports webrtc,ws,s2s-stream`, round robin) | everything a learner's browser does on that rung, and the **audible** latency (next section) | load: one Chromium each (~1 vCPU headless) |

The lightweight clients do not speak the `s2s-stream` rung (Chrome does); `--s2s` is the `post` rung. A student refused at admission (`503 saturated`/`cold`) retries after
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
