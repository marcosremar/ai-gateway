# Realtime edge — the ai-gateway server inside each GPU replica

The **edge** (`docker/aigw-edge`, image `ghcr.io/marcosremar/aigw-edge:<tag>`) is one generic sidecar for every
replica, whatever the GPU (L4, L40S…) or the model image: it terminates the learner's **WebRTC** (media straight from
the browser over UDP, signaling through the gateway) and the gateway-relayed **WebSocket**, and talks to the model
container over HTTP on `127.0.0.1`. It never imports a model. The gateway side (admission, signaling, TURN credentials,
browser SDK) is [`docs/realtime.md`](realtime.md); the token contract and its test vectors are shared
(`docker/aigw-edge/tests/realtime-token-vectors.json` is a copy of the gateway's `docs/realtime-token-vectors.json`).

```
browser ──WebRTC (Opus, UDP RT_UDP_PORTS, or via TURN)─────────────────────────┐
browser ──WS──► gateway /v1/realtime/ws ──relay, X-Aigw-Token──┐                │
gateway ──offer/ice/status/delete, X-Aigw-Token, traceparent───┤                │
                                                               ▼                ▼
replica  :80 nginx (token gate) ── /__aigw/rt/* ──► 127.0.0.1:8020 aigw-edge (front) ──► rtc worker processes
                                └─ /*            ──► 127.0.0.1:8000 model container         │
                                                                    ▲                       │
          aigw-edge ── /v1/audio/transcriptions, /v1/chat/completions (SSE), /v1/audio/speech,
                       /ws/audio-stream (partials), /v1/s2s, /v1/voices ─── EDGE_UPSTREAM ──┘
```

## Turning it on

Any deployment gets the edge by setting `realtime` in its spec — nothing manual on the GPU, nothing baked into the
model image:

```json
{ "profile": "speech-stack", "realtime": {} }
{ "realtime": { "maxSessions": 12, "udpPorts": [50000, 50100], "edgeImage": "ghcr.io/marcosremar/aigw-edge:0.1.1" } }
```

| Field | Default | Effect |
|---|---|---|
| `maxSessions` | the machine type's `RT_MAX_SESSIONS` env (speech-stack: L4 2, L40S 4), else 8 | `RT_MAX_SESSIONS`: admission refuses beyond it with code `capacity` |
| `udpPorts` | `[50000, 50100]` (Vast: sized from the session cap) | WebRTC media range, opened in the replica's firewall (≤ 1000 ports, ≥ 10000) |
| `edgeImage` | `DEFAULT_EDGE_IMAGE` (`src/deployments/cloud-init.ts`) | the sidecar image |

What the first-boot script (`replicaCloudInit`) then adds (`__tests__/unit/deployments/realtime-edge.test.ts`):

- nginx `location ^~ /__aigw/rt/` → `127.0.0.1:8020`, with the WebSocket upgrade, behind the same server-wide
  `auth_request` token gate as everything else (`X-Aigw-Token`), and `large_client_header_buffers 4 16k`: the WS URL
  carries the session token, and a token with the contract's largest `cfg` (6144 base64url chars, base64url-encoded
  again inside the claims) is **~8.3 KB**, above nginx's and aiohttp's 8 KB request-line defaults.
- `/srv/aigw/edge.env` (mode 600): `RT_MAX_SESSIONS`, `RT_UDP_PORTS`, `RT_PORT=8020`, `RT_BIND=127.0.0.1`,
  `EDGE_UPSTREAM` (`http://127.0.0.1:8000`, or `spec.port` in boot-script mode), `AIGW_DEPLOYMENT`,
  `AIGW_REPLICA_TOKEN`, `GATEWAY_URL` (the `gatewayUrl` option of `replicaCloudInit`, else env `AIGW_PUBLIC_URL`), and,
  read at boot from the Scaleway metadata service, `AIGW_REPLICA_ID` (`<zone>:<server id>`, the gateway's replica id —
  the token's `rep` and the telemetry `X-Aigw-Replica`) and `RT_PUBLIC_IP` (announced in the SDP answer; fallback: the
  routed interface's address).
- `docker run -d --name aigw-edge --restart unless-stopped --network host --env-file /srv/aigw/edge.env <edgeImage>`,
  after the model container and before the readiness loop. The edge answers `warming` until the model's `/health` is 200.

The replica token never leaves root-only files on the machine; the edge derives from it the session key
(HMAC-SHA256(key=replicaToken, msg="aigw-rt-v1"), 32 raw bytes) and the telemetry credential.

### Vast: no sidecar, mapped ports

A Vast replica is one container: no Docker inside, no host network, and every port is published on a random host
port. `realtime` works there as follows (`vastReplicaInit`, `realtime-ports.ts`, `__tests__/unit/deployments/vast-backend.test.ts`):

- **The edge is a process of the container.** The boot writes `/srv/aigw/edge.env` (the same settings as above, as
  shell `export` lines, mode 600; `AIGW_REPLICA_ID` is the Vast instance id, from `CONTAINER_ID`), waits for
  `/opt/aigw-edge/aigw_edge` to exist (up to the boot timeout) and runs `python -m aigw_edge` there in a restart
  loop, with `/opt/aigw-edge/venv/bin/python` when that venv exists, else `python3`; its output is
  `/srv/aigw/edge.log`. So the image, or the boot script, must provide **`/opt/aigw-edge/` = the content of
  `docker/aigw-edge` (`aigw_edge/`, `telemetry.py`) plus a Python ≥ 3.11 with `requirements.txt` installed**. In an
  image: `COPY --from=ghcr.io/marcosremar/aigw-edge:<tag> /app /opt/aigw-edge` and
  `uv venv --python 3.12 /opt/aigw-edge/venv && uv pip install --python /opt/aigw-edge/venv/bin/python --only-binary :all: aiortc==1.15.0 aiohttp==3.14.4 'numpy>=1.26,<3'`.
  From a boot script on a public base image: `crane export ghcr.io/marcosremar/aigw-edge:<tag> - | tar -x -C /opt/aigw-edge --strip-components=1 app/`
  then the same `uv` lines. The tag must be one built from a commit that reports the mapped probe port (below).
- **Signalling** rides the TCP port Vast already maps for the nginx front (`/__aigw/rt/*`, same location and token
  gate): with this alone the `ws` path and TURN-relayed WebRTC work.
- **Media**: one `-p <n>:<n>/udp` per port of `RT_UDP_PORTS`, which the gateway sizes from the session cap
  (2 × workers × ceil(sessions / workers) + 1; docs/deployments.md § Vast replicas). `RT_UDP_BIND=0.0.0.0` makes a
  session take exactly one port. The edge announces `PUBLIC_IPADDR` and, through `VAST_UDP_PORT_<n>`, the mapped
  port of each candidate, and reports the **mapped** probe port in `/__aigw/rt/status` (`probePort`,
  `net.probePort`) while its responder binds the container port — so the gateway's probe and the
  `direct` / `relay` / `ws` decision work unchanged. `udpPorts` in the status stays the container range.
- Proven on macOS only (`tests/run.sh harness`, scenario `vast`: candidates carry `PUBLIC_IPADDR` and mapped ports,
  one port per session, mapped probe port, responder on the container port) and on two Vast hosts (2026-10-08,
  `docs/reports/2026-10-07-realtime-handoff.md` § Prova final ao vivo — Vast): the onstart shell sees
  `VAST_UDP_PORT_<n>` (`/etc/environment` has none); on one host WebRTC media flowed `host/host` over the mapped
  ports, on the other no inbound UDP arrived at all and the edge fell back to `ws`. UDP reachability is per host.

## Firewall and public addresses of scaled replicas

`exposure` (a reserved IP per deployment) fits one LiveKit server, not N autoscaled media servers. Realtime replicas
instead use **their own public IP** each: the gateway's signaling hands the browser the answer of the replica that
admitted it, so a session's media goes to that replica's address. The Scaleway backend gives a realtime replica the
namespace's shared group `aigw-<ns>-gateway-only-rt-<lo>-<hi>` (stateful, inbound DROP, accepts TCP 80 and UDP
`lo`–`hi` — one rule with `dest_port_to`) instead of the gateway-only group (TCP 80 only). An exposed deployment that
also sets `realtime` gets the UDP range added to its own group. Tested against a fake Scaleway client.

The edge accepts media only for sessions it answered: aioice drops STUN without the ICE credentials of its own SDP, and
DTLS/SRTP keys are per session. Ports are bound per session from the range (randomized), released on close.

## Reachability — checked, not assumed (`aigw_edge/netcheck.py`, `src/realtime/net-probe.ts`)

A replica's firewall or NAT may not let a browser's UDP in. The edge finds out and picks the fastest path that works,
and every step is logged:

| Path | When | Media | Log |
|---|---|---|---|
| `direct` | the gateway's UDP echo to the probe port came back | browser ↔ edge host candidate (or hole punching through a stateful firewall) | `rt.net.probe` (gateway), `edge.net.path` |
| `relay` | inbound UDP blocked, the edge's OUTBOUND TURN allocation works (UDP, then TCP, then TLS) | the edge also offers a relay candidate on the TURN server, so no inbound port is needed | `edge.net.relay_try` per URL, `edge.net.path` |
| `ws` | neither | WebRTC is not listed in `transports`: admission offers the WebSocket rung through the gateway (reverse proxy, slowest) at once, no ~5 s doomed ICE attempt | `edge.net.path` level warn |

- The **last port** of `RT_UDP_PORTS` answers `AIGWP1<nonce>` with `AIGWR1<nonce>` (same size, ≤ 64 bytes); media uses
  the rest of the range. Same firewall rule, so the echo tests what a browser would hit.
- The gateway probes every ready replica of a realtime deployment whose path is `unknown` (a fresh edge) or older than
  30 min, from a 15 s loop and on admission; at most once a minute per replica. A verdict that is not `direct` (a TURN
  blip at probe time would otherwise pin the replica to `relay` or `ws`) is re-probed after 1 min, then 2, 4, 8, 16,
  up to the 30 min. It posts the result to
  `POST /__aigw/rt/net` `{udpInbound, rttMs, iceServers}` with TURN credentials valid 1 h for the relay test; the
  answer is the decision (`path`, `relay`, `reasons`). Each offer then carries the session's own TURN credentials, used
  on the URL that worked. On `relay` the edge allocates on that URL for every offer and waits at most
  `RT_TURN_ALLOCATE_MS` (default 1500, below the SDK's 3 s signalling budget); past it the answer goes out with the
  host candidates only.
- Per session: `edge.ice.selected` and `rt.ice.selected` (browser) say which pair carries the media (`host`/`relay` on
  each side, protocol, RTT), in the session's trace.
- `GET /__aigw/rt/status` → `net: {path, udpInbound, probePort, publicIp, probeHits, relay, reasons, checkedAt}`.

Proven locally with real coturn, iptables and Chromium (`scripts/realtime-e2e`, 2026-10-07): direct 2.2 s to connect;
inbound UDP dropped → relay, 2.3 s; no UDP and no TURN → ws in 0.13 s; first audio ~240 ms on all three.

## Routes (behind the token gate)

| Route | Body → answer |
|---|---|
| `POST /__aigw/rt/offer` | `{sdp, type:"offer", token, traceparent?}` → `{sdp, type:"answer", sessionId}`; 401 `unauthorized`, 503 `capacity` / `warming`, 400 `bad_request`. Again with the same token while the session lives: a new peer connection for it (re-offer) |
| `POST /__aigw/rt/ice` | `{sessionId, candidate}` (string or `{candidate, sdpMid, sdpMLineIndex}`; empty = end) — optional, the answer carries all candidates |
| `GET /__aigw/rt/status` | `{active, max, available, transports:["webrtc","ws"], udpPorts:[lo,hi], probePort, net, ready, byTransport, workers, firstAudioMaxMs, shedding}` (`transports` is `["ws"]` on path `ws`; `available` is 0 while `shedding`) |
| `POST /__aigw/rt/net` | `{udpInbound:"ok"\|"blocked", rttMs, iceServers}` from the gateway's probe → the decision (see *Reachability*) |
| `DELETE /__aigw/rt/session/:id` | ends the WebRTC session (`sessionId` of the offer, = the token's `sid`); a WS session of the same `sid` ends when its socket closes |
| `GET /__aigw/rt/ws?token=…&traceparent=…` | WebSocket. A refusal still upgrades, sends `{type:"error", code}` and closes 4401 (`unauthorized`) or 1013 (`capacity`/`warming`), so the code survives the relay |

Token checks (the gateway's vectors, `tests/test_units.py`): HS256 only, constant-time signature, `exp > now`,
`iat ≤ now + 60`, `exp − iat ≤ 900`, `cfg` ≤ 6144 chars and a JSON object, `rep` = this replica (`zone:uuid` also
matches a bare `uuid`), `dep` = this deployment, `sid` single use **per transport** (remembered until `exp`): the SDK's ladder tries WebRTC
and WS with the one token of its admission — raced at the start, or one after the other — so a `sid` may have one session of each
transport at the same time, until the SDK closes one (the WS once WebRTC took over; the WebRTC attempt it gave up, by `DELETE`). The
learner holds **one slot** whichever it is: `active` counts distinct `sid`s, `byTransport` counts sessions. The one exception to
single use: an offer carrying the very token that opened a WebRTC session **still alive on this edge** is a re-offer (the browser
changed network) — it gets a fresh peer connection under the same session object (history, turn in progress and queued events kept; the
previous peer connection closed; `edge.session.reoffer`), on the worker that owns the session. A token of an ended session, another
token of the same `sid`, or a `sid` that only lives on WS is still `replayed` (401). Capacity is checked before
the token is consumed. Session limits: 15 min (`RT_MAX_SESSION_SECONDS`), 60 s of audio per turn
(`RT_MAX_TURN_SECONDS`, the turn is cut there), `RT_IDLE_SECONDS` (120) without input.

Events and audio are exactly the contract of `docs/realtime.md`. Additions, all optional for a client: `ready` carries
`sessionId`, `transport`, `traceId`; `transcript{final:true}`, `metrics` and `done` carry `turnId`; `reply` carries
`raw` (the whole JSON) when `speak_field` is set; `pong{t}` answers `ping{t}`; after `interrupted` comes
`done{interrupted:true}`… — see *Deviations* below for the exact list.

## One turn

```
PCM16 16 kHz ─► VAD ─► turn audio ─► STT ─► hallucination guard ─► LLM (SSE) ─► sentence cutter ─► TTS per sentence
                 │       (+ partials over /ws/audio-stream)          │ reply_delta        (≤ EDGE_TTS_PARALLEL ahead, in order)
                 └ barge-in: speech while thinking/speaking ─► cancel LLM+TTS, drop queued audio, `interrupted`
```

- **End of turn**: server VAD by default (energy gate with adaptive floor, 60 ms to open, `RT_VAD_SILENCE_MS` = 700 ms
  to close, 300 ms pre-roll; optional Silero ONNX gate with `RT_SILERO_ONNX` + onnxruntime) **and** the client's
  `end_turn` always works. `cfg.vad = "client"` leaves turn-taking to the client (parle's Silero in the browser):
  the edge then answers only `end_turn`, and barge-in is the client's `interrupt`.
- **History**: before each LLM call the session cuts its history to the LLM's context per slot (the upstream's
  `/health` → `llm_ctx`, default 2048): system prompt, system messages and the newest turns stay, the oldest whole
  user/assistant turns go, 8 at a time (`edge.llm.history_trimmed {dropped, kept, harder}`). A `400 … context size`
  is asked once more with half the room. Rule and numbers: `docker/speech-stack/README.md` § Conversation history.
- **Speculative turn** (`EDGE_SPECULATE_MS` = 300, `0` = off; server VAD in `stages` mode only): after that much
  silence the edge already sends the turn to STT and, once the transcript passes the guard, opens the LLM stream, but
  holds everything (events, TTS, audio, history, a failed STT's error) until the VAD closes the turn at
  `RT_VAD_SILENCE_MS`. Then the turn continues from that work (one STT call, one LLM call; `ttfa_ms` shrinks,
  `stt_ms` / `llm_ttft_ms` stay the upstream's own times, `edge.turn.done` has `speculated: true`). A speech frame
  before that (or a `config_update`) cancels the two upstream calls and drops their output: the learner sees and hears
  nothing of it, and `edge.turn.done` reports `outcome: "discarded"` under the turn id the real turn then reuses. The
  cost is one wasted STT decode (and often the start of an LLM answer) per pause longer than `EDGE_SPECULATE_MS`
  inside a sentence.
- **STT**: the whole turn to `/v1/audio/transcriptions` (WAV 16 kHz, `language`, `prompt` = `stt_prompt`) — it returns
  Whisper's `no_speech_prob` / `avg_logprob` / `compression_ratio`, which the guard needs. **Partials** while the learner
  speaks (`transcript{final:false}`) are off by default: `EDGE_STT_PARTIALS=1` relays them from the replica's
  `/ws/audio-stream` (speech-stack), at the cost of one extra GPU decode per second of speech per session, on the
  same STT worker the final (and the speculative) transcription waits for.
- **Hallucination guard**: a Python port of `src/stt-hallucination-filter.ts` + `src/stt-hallucination-patterns.ts`
  (same thresholds, same core blocklist, same reason codes). Verdict parity is enforced on > 1000 cases by
  `__tests__/unit/stt-filter/edge-parity.test.ts`. A drop emits `filtered{reasons}` then `done{filtered:true}`;
  `cfg.filter_hallucinations: false` skips it.
- **LLM**: `/v1/chat/completions`, `stream: true`, model `EDGE_LLM_MODEL` (`llm`), `system` + history + the user turn
  (`user_template` with `{{transcript}}`), `max_tokens`, `temperature`, `response_format`, `speak_field` (only that JSON
  field is voiced; same extractor as `/v1/s2s`).
- **Cutter + TTS**: the speech-stack's own `cut()` and `JsonField` (`aigw_edge/text.py`, a verbatim copy checked by
  `tests/test_units.py`), each sentence to `/v1/audio/speech` (`stream: true`, `response_format: pcm`; a WAV answer's
  header is parsed and its rate resampled to 24 kHz). Voice semantics as the gateway's TTS: `voice` a catalog id (the
  replica's `/v1/voices`; a cloning TTS gets `ref_audio` = `EDGE_REF_BASE/refs/<id>.wav` + `ref_text`) or
  `{audio, text}`; an id the catalog does not know falls back to `fallback_voice` as a named voice.
- **Stage failures**: an LLM or TTS stream that breaks mid-body, sends nothing for `EDGE_UPSTREAM_GAP_S` (10, just
  above the stack's own 8 s so its in-band error arrives first) or, for the LLM, carries an SSE `{"error": …}` event
  ends the turn with `error` and `stage: llm | tts` (`UpstreamError`, `tests/test_units.py`).
- **TTS runaway guard** (the speech-stack's `tts_stream` rules, `upstream.py` `speak`): every sentence carries
  `max_new_tokens` = (`EDGE_TTS_MAX_SECONDS` 3 + `EDGE_TTS_MAX_SECONDS_PER_CHAR` 0.2 × characters) × 12.5 codec
  frames/s and its own `extra_params.request_id`. Chunks with RMS ≤ 300 before the first audible one are held, not
  played: no `audio_start`, and the first-audio deadline still sees no reply audio, so an opener may play meanwhile.
  A sentence still silent after `EDGE_TTS_MAX_LEAD_SECONDS` (1), or whose stream fails before any sound, is dropped
  and requested again once, in its place in the order (`metrics.tts_retries`, `edge.tts.retry` with the request id,
  `ttsRetries` on `edge.turn.done`). The second attempt drops its silent lead, and so does the first sentence of every
  reply (it starts 10 ms before its first sample over −40 dBFS: the 150–240 ms of silence Qwen3-TTS puts before a
  sentence were played after `audio_start`, on both transports); when it stays silent or fails, or when
  any stream fails after sound, the turn ends with the `tts` error (no retry: it would repeat words already heard).
  The three settings are tunable through `realtime.env`.
- **First-audio deadline** (`RT_FIRST_AUDIO_DEADLINE_MS` = 2000, at most 2500; `cfg.first_audio_deadline_ms` per
  session; `RT_FIRST_AUDIO_MARGIN_MS` = 300): counted from the VAD's last speech frame (from the end of the turn when
  the VAD heard none). A turn — speculated ones only once confirmed — with no audio queued at deadline − margin plays
  the next cached line of `cfg.opener.lines` (`opener` events, the PCM into the same output queue the reply uses), or,
  with none ready, reports `deadline_missed` at the deadline. The lines are synthesized at session start through the
  same `/v1/audio/speech` call and voice fields as a sentence (`aigw_edge/opener.py`: per process, per voice + language
  + text, 256 entries). When the opener has played out before any reply audio the edge emits `audio_end`; the reply
  then opens with `audio_start` as usual. In `s2s` mode the edge owns the deadline (the replica's `/v1/s2s` gets no
  `opener`). Contract, events and limits: [realtime.md](realtime.md) § First-audio deadline and opener.
- **Shedding** (`RT_SHED_WINDOW_S` = 30, `0` = off): each finished turn's first reply audio from the speech (a turn
  that ended with an opener or a missed deadline and no reply audio counts as just over the deadline) is kept for the
  window, in the front and in every
  WebRTC worker (the front reads the workers' maximum every second). While a learner is seated and the maximum is over
  `RT_FIRST_AUDIO_DEADLINE_MS`, new sessions are refused with `capacity` and the status reports `available: 0`,
  `shedding: true`; a seated learner (re-offer, WS next to WebRTC) is never refused by it, and an empty replica never
  sheds.
- `EDGE_UPSTREAM_MODE=s2s` instead sends the turn to the replica's `/v1/s2s` and re-emits its frames as realtime events
  (guard applied on its transcript, the call abandoned when it trips).
- **Metrics** per turn: `ttfa_ms` (end of the learner's speech → first NPC audio out of the edge), `stt_ms`,
  `llm_ttft_ms`, `tts_ttfb_ms` (first sentence). `ttfa_ms` starts when the turn is closed, so it leaves out the
  endpointing wait: `endpoint_ms` is that wait (the VAD's last speech frame → the end of the turn, ≈ `RT_VAD_SILENCE_MS`
  on a server-VAD turn) and `ttfa_from_speech_ms` = `endpoint_ms` + `ttfa_ms` is first audio counted from the moment
  the learner stopped (both `null` when the VAD never heard speech). `edge.turn.done` carries them as `endpointMs`
  and `ttfaFromSpeechMs`. `first_sound_ms` / `first_sound_from_speech_ms` are the same two clocks for the first sound
  of any kind (the opener when one played), next to `opener` (the line or null), `deadline_ms` and `deadline_missed`
  (`firstSoundMs`, `firstSoundFromSpeechMs`, `opener`, `deadlineMs`, `deadlineMissed` in `edge.turn.done`). `ttfa_ms`
  counts the opener audio still queued ahead of the reply.

## Process model and CPU budget

The learner's audio is decoded as it arrives (`audio.ArrivalOrder`, installed in place of aiortc's audio jitter buffer; a
late or repeated packet is dropped). aiortc's buffer (`capacity=16, prefetch=4`) holds 4 packets before it gives a
frame — 80 ms on every turn before the VAD sees the end of speech — and after one lost packet it stays 14 packets
(280 ms) behind for the rest of the call (`tests/test_units.py`): it exists to smooth playout, and the VAD and Whisper
need none. Measured on the loopback harness: end of speech → `vad end` 821 → 741 ms (700 of them are the endpointing).

A lost packet is elapsed time: `read_track` compares each decoded frame's RTP timestamp with the one expected
(`audio.GapFill`) and feeds the missing span as silence (at most 1 s per gap), so the VAD's 700 ms window is 700 ms of
the learner's clock under loss (harness, 10 % loss: `vad end` 781–821 ms without it, 741–762 with) and the clip the STT
gets keeps its length. The turn's `metrics` carries `uplink_lost_ms`. No Opus FEC or concealment: aiortc 1.15 decodes
through PyAV's libopus wrapper, which has no FEC flag and returns nothing for a missing packet; decoding the in-band
FEC would need libopus called directly. A packet that arrives after a later one is dropped, as before.

Downlink: `OutTrack` sends one 20 ms frame per tick of a wall-clock grid, silence included, with continuous RTP
timestamps, so the browser's jitter buffer stays at its floor between replies (Chromium: target and minimum 20 ms on a
clean path). Per reply the edge measures its own part and puts it in `metrics`: `out_first_pull_ms` (first TTS PCM →
the tick that takes it, 0–20 ms), `rtp_first_sent_ms` (→ that packet handed to the transport, encode included) and
`rtp_late_p50_ms` / `rtp_late_p95_ms` / `rtp_late_max_ms` (how late after its tick each of the next 100 packets left).
Loopback: first packet 2–19 ms after the first PCM, packets 2–5 ms late at p95.

aiortc (BSD-3) does the whole RTP/SRTP/RTCP path in Python on one asyncio loop; Opus encode/decode run in threads
(libopus via PyAV). Profiling showed two avoidable hot spots, both replaced by numpy (`aigw_edge/audio.py`): PyAV's
resampler for 48 kHz → 16 kHz (~0.35 ms per 20 ms frame) and aiortc's pure-Python RFC 6465 audio level (~0.16 ms per
outgoing frame). What remains is per-packet Python work in the main loop, so **WebRTC sessions run in worker processes**:
`RT_RTC_WORKERS` (default ⌈`RT_MAX_SESSIONS` / `RT_SESSIONS_PER_WORKER`⌉, 6 per worker), each with its slice of the UDP
range, behind the front process, which does admission, the WebSocket sessions, routing of offer/ice/delete to the
owning worker (internal routes on `127.0.0.1:8021+`, shared random secret) and restarts a dead worker.
`RT_RTC_WORKERS=0` keeps everything in one process.

Measured with the harness (`tests/run.sh bench`), fakes for the models, **on this dev box: 4 vCPU, 2.8 GHz, shared
with the test learners' own aiortc processes** (so the numbers include contention, and the 16-session point is limited
by the learners, not the edge). Every learner speaks 1.2 s every 5 s and the NPC answers ~3 s each time.

| Transport | Sessions | Edge CPU (all processes) | per session | busiest process | ttfa p50 / max (fakes ≈ 230 ms) |
|---|---|---|---|---|---|
| WebRTC, 3 workers | 1 | 15.5 % | 15.5 % | 15 % | 236 / 247 ms |
| WebRTC, 3 workers | 4 | 56 % | 14.1 % | 27 % | 244 / 289 ms |
| WebRTC, 3 workers | 8 | 91 % | 11.3 % | 33 % | 315 / 722 ms |
| WebRTC, 3 workers | 16 | 122 % | 7.6 % ¹ | 43 % | 591 / 974 ms ¹ |
| WebRTC, 1 process | 8 | 80 % | 10.0 % | 80 % | 398 / 458 ms |
| WebRTC, 1 process | 16 | — | — | 64 % ² | no turn completed ² |
| WS, 1 process | 1 | 5.8 % | 5.8 % | — | 236 / 246 ms |
| WS, 1 process | 8 | 20 % | 2.5 % | — | 236 / 275 ms |
| WS, 1 process | 16 | 32 % | 2.0 % | — | 241 / 309 ms |

¹ the box was saturated (edge + 16 learner peers on 4 vCPU): only 7 turns completed in the window. ² one process
cannot carry 16 WebRTC sessions: the loop falls behind real time — the reason for the workers. Edge memory: ~100 MB
(one process) to ~430 MB (front + 3 workers).

**Budget**: plan **~0.12 vCPU per WebRTC session** and **~0.03 per WS session**, at most ~6 WebRTC sessions per
process. An 8-vCPU L40S host carrying 16 WebRTC learners therefore needs ~2 vCPU for the edge (3 workers) next to the
model stack (llama.cpp, vLLM-Omni and the Whisper orchestrator, which also use CPU): **`RT_MAX_SESSIONS=16` on L40S and
8 on L4 are safe on CPU** as long as ~2.5 vCPU stay free; the GPU is the tighter limit: the live capacity runs of 2026-10-07
(docs/reports/2026-10-07-realtime-handoff.md) kept first audio p95 ≤ 2 s up to 8 learners on the L40S, so the
speech-stack profile admits 8 there and 2 on the L4 (an estimate), half and a quarter of `LLM_PARALLEL`. To confirm on the real host: the edge's `edge.load` telemetry (CPU %, RSS, active
sessions per process, every 30 s) during the first live class.

## Telemetry

Correlated events (contract: the gateway's `src/telemetry/contract.ts`) through the shared stdlib emitter
`docker/aigw-edge/telemetry.py` (`TelemetryEmitter`, copied unchanged from the telemetry work), also printed as JSON
lines on stdout. `traceparent` is read from the offer request header (or the offer body) and from the WS
`?traceparent=` query, kept per session, and forwarded (same trace, new span) on every model call. Events:
`edge.session.open` / `edge.session.close` (durMs, reason, turns), `edge.capacity.reject` (active, max; `reason:warming`
when the model is not ready), `edge.token.reject` (reason), `edge.ice.state` (state), `edge.ws.close` (code),
`edge.stt.done` (durMs, filtered, audioMs, chars), `edge.stt.filtered` (codes), `edge.llm.first_token`,
`edge.tts.first_audio`, `edge.turn.opener` (index, chars, durMs from the speech), `edge.turn.deadline_missed`
(deadlineMs), `edge.turn.done` (durMs from end of speech, outcome, stage times), `edge.upstream.error`
(stage, status), `edge.worker.restart`, `edge.load` (every 30 s per process). Never audio, transcript, LLM text or
tokens — lengths, codes and durations only (checked by the harness on every batch).

## TURN — the `coturn` profile

`PUT /v1/deployments/turn {"profile": "coturn", "env": {"REALTIME_TURN_SECRET": "<same as the gateway's>"}}`: coturn
(`coturn/coturn:4.6.3`, host network) on a DEV1-S with a reserved IP (`exposure`): 3478 UDP+TCP, 443 TCP, relay range
49152–49351 UDP (one firewall rule), `use-auth-secret` (credentials = TURN REST: `"<exp>:<sid>"`,
base64(HMAC-SHA1(secret, username)), minted by the gateway per session; the edge checks the gateway's TURN vector),
peers on private ranges denied, Prometheus on 9641 as the gateway's health probe. **443 is plain TURN over TCP**
(iptables redirect to 3478): `turns:` with a self-signed certificate is rejected by browsers, so the gateway should
offer `turn:<ip>:443?transport=tcp`. For real `turns:` (TLS on 443, which passes TLS-inspecting firewalls), give the
TURN IP a DNS name and a CA certificate (e.g. certbot on the box) and add `--cert/--pkey --tls-listening-port=443`
instead of the redirect. `REALTIME_TURN_URLS` example:
`turn:<ip>:3478?transport=udp,turn:<ip>:3478?transport=tcp,turn:<ip>:443?transport=tcp`.

## Tests

- `docker/aigw-edge/tests/run.sh units` — token (and the gateway's vectors: key, every case, TURN credential), cutter
  copy, VAD, 48→16 kHz filter, telemetry emitter, and `tests/test_session.py`: a session on in-process fakes (endpoint
  metrics, the speculative turn confirmed / discarded / interrupted / closed, partials on and off, the first-audio
  deadline: reply in time, late, opener still playing, barge-in, rotation, cache reuse, no opener; admission shedding).
- `docker/aigw-edge/tests/run.sh harness` — fake models + the real edge (one with workers, one single-process in s2s
  mode) + learners over WS and WebRTC (aiortc), and, when nginx and bun exist, the real nginx front generated by
  `nginxConfig`: offer/answer, candidate ports in range, audio in → transcript → reply_delta → audio out (Opus heard by
  the learner), partials, history, catalog-voice fields, client VAD, barge-in and `interrupt`, capacity refusal (WS and
  offer), every token rejection, filtered hallucinations (blocklist and pattern rules), s2s mode, DELETE, trace
  propagation, telemetry to a fake ingest, the token gate (401 without `X-Aigw-Token`, WS upgrade with it, an 8.3 KB
  token). 62 checks.
- `bun x vitest run __tests__/unit/deployments/realtime-edge.test.ts __tests__/unit/stt-filter/edge-parity.test.ts` —
  cloud-init with and without `realtime` (+ `bash -n`, `nginx -t`), spec validation, firewall groups (fake Scaleway),
  coturn profile, filter parity.
- Bench: `tests/run.sh bench webrtc 1,4,8,16` / `bench ws …`.

## Deviations from the shared contract (to settle with the gateway side)

- `vad.state` is `"start" | "end"` (as `docs/realtime.md`), not free text.
- After `interrupted` the edge also sends `done{interrupted: true}` so a client waiting for `done` is released.
- `config_update{messages}` **appends** to the history (as `docs/realtime.md`); it may also carry `system`, `voice`,
  `fallback_voice`, `max_tokens`, `temperature`, `stt_prompt`, `user_template`.
- Extra events: `pong{t}`; `filtered` is followed by `done{filtered:true}`; errors use codes `unauthorized`,
  `capacity`, `warming`, `bad_request`, `bad_message`, `upstream`, `session_limit`, `idle`, `not_found`.
- Token size: the realtime doc says ~6.5 KB; a 6144-char `cfg` makes an ~8.3 KB token (it is base64url-encoded twice),
  so the gateway's WS relay must accept request lines of ≥ 9 KB too.
- `rep` is the gateway's replica id (`fr-par-2:<uuid>` on Scaleway); the edge learns its own from the metadata service
  at boot. If that lookup fails, `rep` is not checked (signature, expiry, deployment and single use still are) and the
  edge logs it.
