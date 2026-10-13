# Telemetry — one correlated log for browser, gateway, edge and model

The gateway is the single place that receives events from every part of a voice session — the browser SDK, the
gateway itself, the edge agent inside each GPU replica (and the model it relays for) — correlated by shared ids, so one
student's session can be rebuilt end to end and fleet-wide problems can be counted.

Code: `src/telemetry/` (server), `sdk/browser/telemetry/` (browser emitter), `sdk/node/telemetry.ts` (server apps),
`docker/aigw-edge/telemetry.py` (edge, stdlib only).

## Correlation

| id | who sets it | where it travels |
|---|---|---|
| `traceId` (32 hex, W3C) | the browser SDK, one per realtime/voice session; the gateway creates one when a request has none | `traceparent: 00-<traceId>-<spanId>-01` on every call (WebSocket: `?traceparent=`). The gateway keeps it for the whole request, sends a child `traceparent` (same trace, new span) to replicas (inference, `/invoke`, `/v1/s2s`, streaming STT) and echoes `X-Aigw-Trace-Id` (exposed to CORS) |
| `sessionId` | realtime session (`sid` claim of the session token) | stamped by the gateway for session-token callers |
| `turnId` | the browser SDK, one per student turn | sent by the browser and the edge (the edge learns it from the session protocol) |
| `replicaId`, `deployment` | the gateway | stamped from the edge credential / the session token |
| `app` | the gateway, from the credential (app key user, token `app`, deployment owner) | never trusted from the body |

## Event

```json
{ "ts": 1759831200123, "source": "browser", "level": "warn", "event": "rt.ladder.fallback",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736", "sessionId": "s_…", "turnId": "turn_…",
  "replicaId": "…", "deployment": "parle-speech", "durMs": 840, "attrs": { "from": "webrtc", "to": "ws", "reason": "ice_failed" } }
```

- `ts` ms epoch by the source's clock; the gateway also stores `rxTs` (its receive time) and a `seq` (cursor).
- `source`: `browser` | `gateway` | `edge` | `model` | `app` (a server app such as the parle backend, reporting with
  its app key). `level`: `debug` | `info` | `warn` | `error`.
- `event`: lowercase, dot-separated (`^[a-z0-9_]+(\.[a-z0-9_-]+)*$`, ≤ 64 chars; `error` alone is valid). Names
  outside the catalogue below are accepted: the catalogue is documentation, not validation.
- `attrs`: ≤ 32 scalar values (`string` ≤ 200 chars, finite number, boolean, null).
- Zod schema: `src/telemetry/schema.ts` (`TelemetryEventSchema`); the dependency-free type and limits:
  `src/telemetry/contract.ts` (what the emitters import).

## Privacy (research instrument with student data)

Telemetry holds **lengths, counts, durations and codes only**: no audio, no transcript or LLM text, no keys or tokens,
no raw IP. The emitters drop the obvious cases client side; the server scrubber (`src/telemetry/scrub.ts`) runs on every
stored event, the gateway's own included:

1. a key matching `text|transcript|prompt|content|audio|token|key|secret|authorization` (any case) with a **string**
   value is dropped; with a number/boolean/null it is kept (`textLen`, `promptTokens`, `audioMs` are counts);
2. strings longer than 200 chars are dropped;
3. credential-looking strings are dropped (JWT, `Bearer …`, `sk-…`, ≥ 32 hex chars, ≥ 40 base64url chars);
4. IP addresses (with or without port) become `ip:<12 hex of HMAC-SHA256(TELEMETRY_IP_SALT, ip)>` (random salt per
   process when unset: hashes then correlate within one run only);
5. bad keys, keys beyond 32, nested values are dropped.

Every removal is counted (`redactedAttrs` in the ingest answer and `/v1/telemetry/stats`): a source that leaks shows up.
The client IP of the ingest request itself is never stored. Browser error capture is opt-in and sends the error
`name` and file/line only, never the message.

## Ingest — `POST /v1/telemetry/events`

Body `{"events":[…]}` (beacons may add `"token"`). ≤ 100 events and ≤ 64 KB per batch (413 otherwise); a body that is
not `{events:[…]}` is 400. Invalid events are counted and dropped, never a 500:

```json
{ "accepted": 48, "dropped": { "invalid": 1, "sampled": 1 }, "redactedAttrs": 0, "errors": [{ "index": 7, "issue": "traceId: Invalid string" }] }
```

The route authenticates itself (mounted ahead of the proxy key check, `publicRoutes`). Three credentials:

| caller | header | stamped by the gateway |
|---|---|---|
| server app (e.g. parle backend) | `Authorization: Bearer <app key>`; refused when `Origin` or `Sec-Fetch-Site` is present (a key never sits in a page) and for the SANDBOX_TOKEN family | `app`; `source` as sent (`app`/`browser`/`edge`/`model`; `gateway` is reserved) |
| browser | `Authorization: Bearer <realtime session token>`, or `"token"` in the body for `navigator.sendBeacon` (sent as `text/plain`, no preflight). Accepted up to 120 s after `exp` so the `pagehide` flush lands | `source:"browser"`, `sessionId`, `app`, `deployment`, `replicaId` from the token |
| edge | `Authorization: Bearer <hex HMAC-SHA256(key=replicaToken, msg="aigw-telemetry-v1")>` + `X-Aigw-Replica: <replicaId>` | `source:"edge"` (or `"model"`), `deployment`, `replicaId`, `app` |

Session tokens: HS256, key = HMAC-SHA256(deployment replicaToken, `"aigw-rt-v1"`) — the realtime contract. The route
can take an injected `resolveSessionToken(token) → {sid, app, dep, rep} | null` (adapter over
`RealtimeService.resolveToken`: `sessionResolverFrom` in `src/telemetry/adapters.ts`); null falls back to the built-in
verifier so a session whose replica is gone still flushes. Edge signature test vector:
`replicaToken = "replica-secret"` → `523cc3e7d85def44143d386ac5a1c35acceb7ba3c83e09680cb6f1ada19967ad`.
The replica token is per deployment, so a replica could sign for a sibling of the same deployment; it cannot for
another deployment.

Rate limit: token bucket per credential (app / session / replica), `TELEMETRY_RATE_PER_MIN` events per minute (default
1200); exhausted → 429 + `Retry-After`. Debug events are kept for `TELEMETRY_DEBUG_SAMPLE` of traces (default 0 = none),
decided per trace so a sampled trace is complete.

## Contract rules (accepted 2026-10-07)

1. **Session-token grace:** a realtime session token is accepted until 120 s after `exp`, so the `pagehide` flush
   lands; older → 401 `session_expired`.
2. **Beacon:** `navigator.sendBeacon` cannot set headers, so the session token may ride in the body
   (`{"token":"…","events":[…]}`), sent as `text/plain` (no CORS preflight).
3. **App keys are server-to-server:** refused (403 `browser_app_key`) when the request has `Origin` or
   `Sec-Fetch-Site` (Node and Bun `fetch` send neither); the SANDBOX_TOKEN family is always refused, with the same `401 invalid_key` as a wrong key. An address with 20 failed credentials in a minute gets `429` for the rest of that minute.
4. **Source per credential:** session token → always `browser`; edge → `edge` or `model`; app key → `app`, `browser`,
   `edge` or `model` as sent; `gateway` only from the gateway itself.
5. **Clock sanity:** a source `ts` more than 24 h from the receive time is replaced by it and flagged
   `attrs.clockReplaced = true`.
6. **Debug sampling** (`TELEMETRY_DEBUG_SAMPLE`) is decided per trace (from the trace id), so a sampled trace is complete.
7. **Scrubber details:** a sensitive key with a number/boolean/null value is kept (only string values are dropped);
   credential-looking strings are dropped, including any run of 40+ `[A-Za-z0-9_-]` characters without spaces; IPs
   are kept only as a salted hash (`TELEMETRY_IP_SALT`, random per process when unset).

## Event catalogue (canonical names)

Unknown names are still accepted; these are the names the components emit.

**Browser** (source `browser`, realtime SDK):

| event | when / useful fields |
|---|---|
| `rt.session.admitted` / `rt.session.rejected` | admission answered (`durMs`; rejected: `code`) |
| `rt.ladder.try` / `rt.ladder.ok` / `rt.ladder.fallback` | transport ladder step tried / connected / given up for the next (`from`, `to`, `reason`) |
| `rt.ice.state` / `rt.ice.failed` | ICE state changes / failure (`state`, `candidateType`) |
| `rt.turn.used` | TURN relay in use |
| `vad.segment` | the browser VAD closed a segment (`durMs`, `speechMs`) |
| `turn.first_audio` | first reply audio of a turn (`durMs` from the end of the turn, `fromSpeechMs` from the learner's end of speech; `turnId`) |
| `turn.first_sound` | first sound of a turn at the page, opener or reply (`durMs` from the learner's end of speech, `source`, `uplinkBufferedBytes`) |
| `rt.opener.cached` | opener clips the SDK holds for its own deadline (`clips`, `lines`) |
| `turn.done` | turn finished (`durMs`, outcome code, `firstSoundMs`, `networkDelayMs`, `clientOpener`) |
| `ws.close` | WebSocket closed (`code`) |
| `error` | client error (name/code only; the emitter's opt-in `captureErrors` reports window errors as `browser.error`) |

**Edge** (source `edge`, aigw-edge sidecar in each replica):

| event | when / useful fields |
|---|---|
| `edge.session.open` / `edge.session.close` | session lifecycle on the replica |
| `edge.capacity.reject` | session refused: replica full |
| `edge.ice.state` | ICE state on the replica side |
| `edge.ws.close` | relay WebSocket closed (`code`) |
| `edge.stt.done` (attr `filtered` when the STT filter hit) | transcription of a turn (`durMs`, `textLen`) |
| `edge.llm.first_token` | first LLM token (`durMs`) |
| `edge.tts.first_audio` | first TTS audio (`durMs`) |
| `edge.turn.done` | end-to-end turn on the replica (`durMs`) |
| `edge.upstream.error` | model server error (`code`, `status`) |
| `edge.load` | every 30 s: sessions, inflight, GPU utilisation |

**Gateway** (source `gateway`): the table below.

## Gateway events (source `gateway`)

Same sink, same scrubber (`emitGatewayEvent`, `src/telemetry/emit.ts`); inside a request they carry its trace id:

| event | when |
|---|---|
| `route.served` | a stage answered (`attrs.stage/provider/model/attempt/failedBefore/raced`, `durMs` of the whole chain) |
| `route.fallback` (warn) | a link failed and the next one is tried (`code`, `status`) |
| `route.hedge` | a slow link's successor started in parallel (`afterMs`) |
| `route.unavailable` (error) | no link could serve (`codes`) |
| `breaker.open` (warn) | a link's circuit just opened |
| `stt.filtered` | hallucination filter hit (`codes`, `rawLength`, `emptied`, `language` — never the text) |
| `app.budget_warning` / `app.budget_exhausted` | an app's daily budget reached 80 % / refused its first request (`app`, `budget`, `used`, `limit`, `resetAt`); once per app, budget and UTC day |
| `autoscale.decision` / `autoscale.warm` / `autoscale.reclaim` | the controller changed its plan (`desired`, `reason`, `blockedBy`, `load`, `p95Ms`) |
| `replica.creating` / `.ready` (`durMs` = boot) / `.unhealthy` / `.draining` / `.released` / `.parked` / `.power_on` / `.too_far` / `.create_failed` | replica lifecycle |
| `provider.list_failed` | the provider list call failed |
| `replica.stage_out` (warn) / `replica.stage_back` | one stage (`stage`: stt, chat, tts, s2s) of one replica left / rejoined the rotation after repeated failures |
| `stage.on_fallback` (warn) / `stage.on_primary` (`durMs` = time on fallback) | a stage chain started / stopped being served by a link that is not its first (`stage`, `model`, `primary`, `serving`) |
| `s2s.first_audio` | first audio of a `/v1/s2s` turn written to the client (`durMs` from the request) |

Realtime control-plane events (`src/realtime/trace.ts`) plug in with `realtimeSinkToTelemetry(telemetry.ingest)`.

## Queries (admin key: `DEPLOYMENTS_ADMIN_USERS`)

- `GET /v1/telemetry/timeline?sessionId=…` or `?traceId=…` — every event of every source, ordered by `ts` (ties:
  arrival). One hop of expansion: a session pulls in its traces (gateway routing events carry the trace only), a trace
  pulls in its sessions. `clocks.<source>` = `rxTs - ts` (median/min/max): transit + batching + clock skew. When a
  source's median lag is far from its transit time, read its events by `rxTs`.
- `GET /v1/telemetry/summary?since=1h&groupBy=event|source|deployment|replicaId|app` (+ the filters below) — per group:
  count, counts by level, `durMs` p50/p95 (nearest rank). `since` defaults to 1 h.
- `GET /v1/telemetry/events?…` — filters `traceId, sessionId, turnId, replicaId, deployment, app, source, level`
  (minimum), `event` (exact or `prefix.*`), `since`/`until` (ms, ISO, or `15m`/`1h`/`7d`); `limit` ≤ 1000; newest first,
  `order=asc` for oldest first; next page with `cursor=<nextCursor>`.
- `GET /v1/telemetry/stats` — rows, cap, evictions, ingest counters.

## Storage, retention, export

Same choice as the rest of the gateway's state: files under `DEPLOYMENTS_STATE_DIR` (`telemetry/YYYY-MM-DD.jsonl`, one
file per UTC day of receive time, contract fields only), re-read at boot; queries read memory.

| env | default | |
|---|---|---|
| `TELEMETRY` | on | `0` turns ingest, queries and gateway events off |
| `TELEMETRY_DIR` | `<state dir>/telemetry` | |
| `TELEMETRY_RETENTION_DAYS` | 14 | rows and day files older are removed (hourly + at boot) |
| `TELEMETRY_MAX_ROWS` | 200 000 | rows in memory (oldest out, counted as `evictedByCap`) |
| `TELEMETRY_MAX_DISK_MB` | 256 | oldest day files deleted beyond it |
| `TELEMETRY_DEBUG_SAMPLE` | 0 | fraction of traces whose `debug` events are kept |
| `TELEMETRY_RATE_PER_MIN` | 1200 | events per minute per credential |
| `TELEMETRY_IP_SALT` | random | salt of IP hashes |

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, every stored event is also forwarded to the existing OTLP exporter
(`src/platform/observability/otlp-exporter.ts`) as a span of its `durMs`. Not required.

## Emitters

Browser (and the realtime SDK — `TelemetryEmitter` satisfies its `RealtimeTelemetry` interface: `traceId`,
`traceparent`, `emit`, `bind(sessionId, token, ingestUrl)`, `flush`, `close`):

```ts
import { createTelemetry } from '@parle/ai-gateway/telemetry';
const telemetry = createTelemetry({ captureErrors: true });          // queues until bound
telemetry.bind(session.id, session.token, `${gateway}/v1/telemetry/events`);
fetch(url, { headers: { traceparent: telemetry.traceparent } });
telemetry.emit('rt.ladder.fallback', { level: 'warn', turnId, attrs: { from: 'webrtc', to: 'ws', reason: 'ice_failed' } });
```

Flush every 5 s or at 50 events; on `pagehide`/hidden: `sendBeacon` (token in the body), else `fetch` keepalive.
Queue bounded (500, oldest dropped, reported as one `telemetry.dropped` event). 429/5xx/network keep the batch; other
4xx drop it. Never throws.

Server app: `createServerTelemetry({ endpoint, apiKey })` (`sdk/node`); `source` defaults to `app`, and may be
`browser` / `edge` / `model` when the app relays what it observed.

Edge (Python): `TelemetryEmitter(gateway_url, replica_id, replica_token)`; `trace_id_from_traceparent(header)` reads
the trace the gateway propagated.

## How to cross-reference a bad student session

1. Get an id. From the student's report: the session id the app shows/logs, or the `X-Aigw-Trace-Id` of any gateway
   response in the app's logs. From the fleet: `GET /v1/telemetry/events?level=error&since=2h` → `sessionId` /
   `traceId` of the failing events.
2. Rebuild it: `GET /v1/telemetry/timeline?sessionId=<sid>`. Read top to bottom: browser `rt.session.admitted` →
   `rt.ladder.try/ok/fallback`, `rt.ice.state` → edge `edge.session.open` → per `turnId`: browser `vad.segment` →
   edge `edge.stt.done` → `edge.llm.first_token` → `edge.tts.first_audio` → browser `turn.first_audio` →
   `edge.turn.done` / `turn.done`; gateway `route.*` and `stt.filtered` for HTTP fallbacks in the same trace.
3. Check `clocks` before trusting order across sources: a browser with a median lag of 40 s has a wrong clock (or a
   tab that slept) — order its events by `rxTs`.
4. Locate the hop: the last `info` before the first `warn`/`error`, and the `durMs` that is out of line (compare with
   `GET /v1/telemetry/summary?since=24h&groupBy=event&event=edge.*`).
5. Is it this student or the fleet? Same event grouped by replica / deployment / app:
   `GET /v1/telemetry/summary?since=24h&groupBy=replicaId&event=rt.ice.failed` (plus `edge.load` /
   `edge.capacity.reject` of that replica). One replica concentrating failures →
   look at its `replica.*` lifecycle events (`?replicaId=…&event=replica.*`) and its autoscale decisions; spread over
   every replica → client network / TURN; one app → that app's integration.
6. Compare with the gateway's own decisions in the same trace (`route.fallback`, `route.hedge`, `breaker.open`): a
   student turn that went to the cloud fallback because the replica was saturated shows `route.fallback` with
   `code: saturated` right before the slow `turn.done`.
