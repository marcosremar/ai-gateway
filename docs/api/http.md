# HTTP API Reference

This page documents the production entry point, `bun serve.ts` (the image built by `Dockerfile.production` and
deployed by `railway.json`, default port `4000`). The larger reference server in `server/` mounts more routes
(`/v1/speech`, `/v1/gpu/*`, `/v1/request-log`, …); those are **not** available on `serve.ts`.

::: warning Blocked transports
WebSocket (`/ws/stream`, `/api/stream-audio`) and WebRTC return `410 Gone`, except the realtime voice routes
(`/v1/realtime/*`, below). A spoken turn is `POST /v1/s2s` (one
streamed request); text streaming is SSE on `POST /v1/chat/completions` with `stream: true`. `/v1/speech` and
`/v1/workloads` are **not** mounted on `serve.ts` (`404`).
:::

::: tip Client
Apps call these routes through `GatewayClient` (`@parle/ai-gateway/client`): see [Gateway client](./client.md).
`GatewayHttpClient` is the legacy client of the old `server/` routes.
:::

## Authentication

All endpoints except the minimal `GET /health` require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" ...
```

Set `GATEWAY_API_KEYS` on the server (comma-separated; `key:user` names the user). When no key is configured, only
localhost requests are allowed. Keys are also issued, rotated and revoked at runtime (§ Access at runtime), and the
admin list replaced, without a deploy. The `SANDBOX_TOKEN` (and its aliases) is **not** a client key: it is the dev API's
master key, which the gateway uses only to fetch its own provider keys from the palco, and it gets `401` here (owner
decision 06/10/2026). `ACCEPT_SANDBOX_TOKEN_AS_KEY=1` (transition only, default off, logs a `WARNING`) accepts it
again as the user `sandbox`, until every client sends its own key. That user is **not an admin** (even if
`DEPLOYMENTS_ADMIN_USERS` lists it) and runs in **no-wake** mode; it may call the aliases of the app named by
`SANDBOX_TOKEN_APP` (e.g. `parle`), under the app-key limits. `SANDBOX_TOKEN_ADMIN` is no longer read (10/10/2026): the
dev token is a client, never an admin; a boot `WARNING` asks to remove the variable. These flags come from the host
only, never from the dev API.
Keys travel only as `Authorization: Bearer <key>`: a bare key without the scheme gets `401`.

**Two roles only** (owner, 10/10/2026): an **admin** manages the gateway (machines, keys, config); a **client** calls
the APIs (STT, chat, TTS, realtime, s2s). A developer is a client — testing never needs an admin key. Every key is one
or the other: `GET /v1/admin/access/keys` lists each with `role: "admin" | "client"`. The dev token (`sandbox`) is
always a client, even if the admin list names it.

**Admin keys** — the users in `DEPLOYMENTS_ADMIN_USERS`. When that list is empty, no key is admin (fail closed since 06/10/2026; the boot logs a `WARNING`). Admin keys are required for deployment
mutations, `X-App` naming **another** app, `GET /health?deep=1`, the full view of `GET /health?details=1` and
`/v1/admin/keys*`. A non-admin key may send `X-App` equal to its own app (what `GatewayClient({ app })` sends); any
other value → `403`. The same rule holds for every app-scoped route added later (e.g. a machines API).

**Client keys** (any non-admin key; its user id is its app) are limited so a leaked one costs little:

- **Models**: only the aliases of its own app (`PUT /v1/apps/:app/routes`), per stage — no `org/model` passthrough,
  no embeddings or images. Anything else → `403 permission_error`, before any provider is called.
- **`max_tokens`** (chat): clamped to `APP_MAX_TOKENS` (default `1024`); a request without one gets the cap.
- **Daily budget** per app (UTC day, in memory): `APP_DAILY_REQUESTS` (default `5000`) requests and
  `APP_DAILY_TOKENS` (default `2000000`) estimated tokens (prompt characters / 4 + `max_tokens` for chat, input
  characters / 4 for TTS). Over → `429` with `Retry-After` until 00:00 UTC and
  `{"error": {"type": "budget_exceeded", "code": "daily_budget_exhausted", "budget": "tokens" | "requests", "reset_at":
  "<ISO time>"}}` (a realtime session: `error.code: "budget_exceeded"` plus top-level `reason`, `budget`, `reset_at`).
  It is not the per-minute rate limit (`rate_limit_error`): retrying before `reset_at` cannot succeed, so a client
  shows "limit reached" and stops. `0` turns one off.
- **Sizing the budget for a class.** Both limits are gateway-wide defaults, meant for a leaked key; an admin gives an
  app its own daily budgets with `PUT /v1/apps/:app/limits {"dailyRequests": n, "dailyTokens": n}` (`null` = the
  default, `0` = no budget; `GET` shows them, also to the app's own key, which cannot change them). The budget is
  charged at admission only — an HTTP request, a `/v1/s2s` turn, a realtime session for its whole token — so a reply
  already admitted is never cut: the learner's NEXT turn (or session) gets the 429 above. Use and projected exhaustion
  are in `GET /health?details=1` → `appBudgets`; the 80 % and exhaustion events go to the log, to telemetry
  (`app.budget_warning`, `app.budget_exhausted`) and to `ALERT_WEBHOOK_URL` when set. A realtime session is charged
  in requests only (its turns run on the app's own GPU replica, not on cloud credit); a session that drops to its
  `s2s-stream` / `post` transport pays each `/v1/s2s` turn on top of the session charge. A `/v1/s2s` turn costs one request and `prompt characters / 4 + max_tokens`
  tokens, where the prompt is `system` + `messages` + `user_template` and an omitted `max_tokens` counts as
  `APP_MAX_TOKENS` (1024); a realtime session costs `4 × minutes of its token` requests at admission and no tokens.
  `APP_DAILY_TOKENS ≥ students × turns per student per day × tokens per turn` and `APP_DAILY_REQUESTS ≥ students ×
  (turns per day + 4 × realtime minutes per day)`, with a margin (× 1.5). Example: 25 students, 4 turns/min, 580
  tokens/turn (420 of prompt + `max_tokens: 160`) is 58 000 tokens and 100 requests per minute: the defaults last
  34 min (tokens) and 50 min (requests); a 90-minute lesson needs `APP_DAILY_TOKENS=8000000` and
  `APP_DAILY_REQUESTS=14000`. A student whose realtime session falls back to `/v1/s2s` is charged the session's
  requests and one request per turn: count both.
- **Watching it.** `GET /health?details=1` lists `appBudgets` (an admin: every app used today; an app key: its own):
  `used`, `limit`, `perMinute` (last 5–10 min) and `exhaustedAt` (projected at that rate, null when it would not run
  out before the reset) for requests and tokens. The gateway logs and emits the telemetry events
  `app.budget_warning` at 80 % and `app.budget_exhausted` at the first refusal, once per app, budget and UTC day.
- **Routes**: `PUT /v1/apps/:app/routes` with the app's own key may reorder, drop or re-alias the targets its routes
  already have (set by an admin) and add the app's own deployments; any new target → `403`.
- **Deployments**: `…/invoke` only on its own app's deployments (`403` otherwise).
- **`POST /v1/s2s`**: `config.deployment` only when the deployment is its own app's, or its app's routes (set by an
  admin) already target it — e.g. the operator's declared `parle-speech` reached by parle's aliases. Any other named
  deployment → `403 permission_error` before the audio is read, nothing acquired or woken. The gateway default
  (`S2S_DEPLOYMENT`) that is not the caller's goes to the composed pipeline and is never woken for it. The turn is
  under the limits above: `config.models` must be the app's own aliases (`403`), `config.max_tokens` is clamped (the
  replica gets the clamped config), and the turn is charged once to the daily budget (`429 budget_exceeded` +
  `Retry-After`); its composed-fallback stages are checked but not charged again.

### Errors and request ids

Errors of the proxy and of the OpenAI routes are `{"error": {"message", "type"}}`; `type` follows the status:
`400` `invalid_request_error` · `401` `authentication_error` · `403` `permission_error` · `404` `not_found_error` ·
`413` `request_too_large` · `429` `rate_limit_error` (or `budget_exceeded` for an app's daily budget) · `5xx`
`server_error` / `provider_unavailable`. A device refusal adds `code`: `403` `device_blocked` or `device_required`, `400`
`invalid_device` (see *App devices*). A malformed multipart body (truncated, oversized field name) is a `400`, an
oversized file a `413`. A `429` always carries `Retry-After` (seconds).

The **management routes** (`/v1/deployments*`, `/v1/profiles*`, `/v1/apps*`) answer errors as
`{"error": "<message>"}` (a string, no `type`; a 503 while warming adds `"status": "warming"`), and a 500 carries
`requestId` only.

`X-Request-Id`: send one (≤ 128 characters of `[A-Za-z0-9_.-]`) to correlate a call with the gateway log; anything
else is replaced by a fresh UUID. Every response echoes the effective id — OpenAI routes, `/v1/s2s`, deployments,
apps, profiles and admin keys alike.

### CORS

Origins: `CORS_ORIGINS` (comma separated, `*` = any; localhost always). Preflight allows `GET, POST, PUT, PATCH,
DELETE, OPTIONS` and the headers `Content-Type, Authorization, X-API-Key, X-App, X-Request-Id, X-Aigw-Wait,
X-Gateway-No-Wake, X-Gateway-Device`. Responses expose `X-Gateway-Provider, X-Gateway-Fallback, X-Gateway-Fallback-From,
X-Gateway-Model-Catalog-Warnings, X-STT-Filtered, X-STT-Raw-Length, Retry-After, X-Request-Id` to browser code.

## Rate Limiting

Optional per-user token bucket (`RATE_LIMIT_RPM`, off when unset or `0`). When on, responses carry
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a limited request gets `429` with
`Retry-After`. Requests in flight per key user are capped (`MAX_CONCURRENT_PER_USER`, default 150;
`MAX_CONCURRENT_PER_USER_OVERRIDES=user:n,…`): over it → `429 rate_limit_error` with `Retry-After: 1`.

## Request Size Limit

Maximum request body: **100 MB** (for audio file uploads). Requests exceeding this limit receive `413 Payload Too Large` before the body is read.

---

## Routing: self-hosted first, OpenRouter as fallback

The client calls only the gateway, on the OpenAI routes below. For every model the gateway holds an ordered chain
of providers and tries them in order:

1. a **self-hosted deployment** on Scaleway (see [Deployments](#deployments)) when the model is routed to one;
2. **OpenRouter** — the fallback of every stage;
3. Groq / OpenAI / Fireworks / Deepgram / Z.AI — extra fallbacks, only when their key is set.

A provider is skipped without being called when it has no key or its circuit breaker is open (5 consecutive
failures → skipped for 30 s, then one probe request). A provider that fails moves the request to the next one on
401/402/403/404/429 (a 404 from a data/privacy policy — e.g. OpenRouter ZDR — counts as a provider failure), 5xx,
timeout, a dropped connection, or an **empty chat answer** (e.g. a reasoning model that spent `max_tokens`
thinking). `finish_reason` is passed through as the provider sent it.

### Time budget (numbers for the client's deadlines)

| Knob | Default | Env |
|---|---|---|
| Deployment, time to **first byte** — STT / chat / TTS | 4 s / 4 s / 3 s | `DEPLOYMENT_STT_TIMEOUT_MS`, `DEPLOYMENT_CHAT_TIMEOUT_MS`, `DEPLOYMENT_TTS_TIMEOUT_MS` (or `DEPLOYMENT_TIMEOUT_MS` for all) |
| Hedge: fallback starts in parallel when the deployment has not answered | 1.5 s | `DEPLOYMENT_HEDGE_MS` (`0` = off) |
| Cloud link (OpenRouter, Groq…) with a target behind it: the next one starts in parallel (non-stream, STT, TTS) or takes over (chat stream, no first token) when it has not answered | min(4 s, half of the budget left) | `GATEWAY_CLOUD_HEDGE_MS` (`0` = off) |
| A composed `/v1/s2s` turn with `first_audio_deadline_ms` or `opener`: no link of a stage waits longer than this before the next one starts (hedge) or takes over (chat stream), deployment links included | the time left to the turn's deadline, at least 1 s | — (sent by the gateway to its own stage sub-requests as `x-gateway-hedge-ms`; ignored from any other caller) |
| Whole stage (deployment + fallbacks + hedge) | 8 s | `GATEWAY_STT_BUDGET_MS`, `GATEWAY_CHAT_BUDGET_MS`, `GATEWAY_TTS_BUDGET_MS` |
| Chat, **non-stream** only: extra budget per requested `max_tokens` above the free ones, and its ceiling | 20 ms/token above 256, max 45 s | `GATEWAY_CHAT_BUDGET_PER_TOKEN_MS` (`0` = flat), `GATEWAY_CHAT_BUDGET_FREE_TOKENS`, `GATEWAY_CHAT_BUDGET_MAX_MS` |

Every attempt is aborted when its time is up (a replica lease is released at once), and no attempt outlives the
stage budget: the answer — or the `503` — arrives within **8 s** per stage. One exception: a non-stream chat with a
large `max_tokens` arrives all at once, so its budget (and each attempt's time) grows by 20 ms per token above 256 —
`max_tokens: 1024` gets ~23 s — capped at 45 s (QA 2026-10-07: a long answer with the GPU cold was a `503` at 8 s).
A real-time turn (`max_tokens` ≤ 256) and every streamed answer keep the 8 s. Set the client deadlines above that
with margin (parle: TTS 15 s, chat 12 s are fine; ≥ 10 s recommended). With hedging, a slow or recovering
deployment costs at most ~1.5 s before the fallback is on its way; the first answer wins and the other call is
aborted (`X-Gateway-Fallback: slow`). Hedging can bill the fallback for requests the deployment would have served a
bit later — raise `DEPLOYMENT_HEDGE_MS` to trade latency for cost. For TTS, "first byte" of a non-streamed format
(`mp3`) is the whole synthesis on vLLM-Omni; ask for `wav` to get the audio streamed. A **hung cloud link** no longer
eats the whole stage budget: after min(4 s, half of the budget left) without an answer the next target runs too (the
first answer wins, the other is aborted); a chat stream with no first token moves on to the next target. So in
`deployment (4 s) → slow cloud link → last cloud link` the last link always gets a real share (prod 2026-10-07: 25/4710
`503`s at ~8.1 s where the 3rd link was never tried; fault bench S5: ~2 % `503`s with 2 % of calls hanging). A non-stream chat that legitimately takes longer
than 4 s (large `max_tokens`) may start the next target too — set `GATEWAY_CLOUD_HEDGE_MS` higher to trade latency
for cost.

Circuit breaker: 5 consecutive real failures open the circuit for 30 s; the next request then probes the deployment,
with the fallback hedged in, so the probe never makes the client wait the full timeout. `cold` / `paused` /
`voice_not_found` / `catalog_unavailable` never count: as soon as the replica is ready, traffic goes back to it. A **cold deployment** (no ready replica) is not waited
for: the gateway starts scaling it up and answers from the fallback in the same call; once a replica is ready,
traffic returns to it. A real client error (e.g. `400` invalid request) is returned as is.

### No-wake mode — `X-Gateway-No-Wake: 1` / `GATEWAY_NO_WAKE_USERS` / key policy `autoWake`

**Since 10/10/2026 every client key is no-wake unless its policy says `autoWake: true`** (`PUT
/v1/admin/access/keys/policy`, below). A Saturday with no class still saw 27 GPU starts from test calls; a test now
gets the cloud answer, and turns a GPU on on purpose with `POST /v1/deployments/:name/start` (§ Deployments). The
class client keeps waking its GPUs: the first boot of this build gives every `parle` key `autoWake: true`,
`canStartGpu: true` and no daily cap (`access.json`, once). Local open mode (no keys) keeps waking.

A request that must never start a rented machine (a test, a probe, a batch job, a dev box) sends
`X-Gateway-No-Wake: 1` (`true`/`yes` too); a key user listed in `GATEWAY_NO_WAKE_USERS` (comma list of the user names
of `API_KEYS="key:user"`, read per request) is always in this mode. Found 2026-10-07: one STT request to `parle-stt`
woke a €1.47/h L40S, because its primary is `deployment:parle-speech` and a cold primary is woken for the next turns.

| Route | Deployment with a **ready** replica | Deployment cold / stopped / booting / absent |
|---|---|---|
| `/v1/audio/transcriptions`, `/v1/chat/completions`, `/v1/audio/speech` | served by it | skipped with `X-Gateway-Fallback: cold` (neutral: no circuit, no cooldown); the cloud fallback answers; nothing woken |
| cached STT answer | — | served from the cache; the primary is **not** prewarmed |
| `/v1/s2s` | its own `/v1/s2s` | composed pipeline (`route` event `fallback: cold`); its stage sub-requests stay no-wake |
| `/v1/deployments/:name/invoke/…` | forwarded | `503 {"status":"cold","code":"cold","noWake":true}` + `Retry-After: 30` at once (no wait) |

Nothing is created, and the deployment's idle clock (`lastRequestAt`) is not touched, so a replica already running
idles out on its own schedule. `GET /health?details=1` (admin key) counts the skips: `"noWake": {"skips": N}`.

### App aliases — `PUT /v1/apps/:app/routes`

The gateway's code names no app model. An app that wants its own model names (`parle-stt`, `parle-llm`,
`parle-tts`…) routed to its deployment first and to cloud fallbacks after puts them on its account, in the
`MODEL_ROUTES` shape below. The change is live (the providers are re-mounted, no restart) and stored in the account
(`DEPLOYMENTS_STATE_DIR/apps.json`).

```bash
curl -X PUT $GW/v1/apps/parle/routes -H "Authorization: Bearer $KEY" -H 'X-App: parle' -d '{
  "stt":  { "parle-stt": ["deployment:parle-speech:whisper-large-v3-turbo", "openrouter:openai/whisper-large-v3-turbo"] },
  "tts":  { "parle-tts": [{ "provider": "deployment", "deployment": "parle-qwen-tts", "oneGpuDeployment": "parle-speech",
                            "model": "Qwen/Qwen3-TTS-12Hz-0.6B-Base" },
                          { "provider": "openrouter", "model": "microsoft/mai-voice-2.1-flash", "voice": "pt-BR-Luana:MAI-Voice-2-Flash" },
                          { "provider": "openrouter", "model": "hexgrad/kokoro-82m", "voice": "pf_dora", "fixedVoice": true }] }
}'
curl $GW/v1/apps/parle/routes -H "Authorization: Bearer $KEY" -H 'X-App: parle'
```

- A PUT replaces all of the app's routes. Invalid entries → `400`; an alias another app already routes → `409`
  (an app cannot take over another app's model names); another app's routes → `403`.
- `MODEL_ROUTES` (below) wins over every app's routes for the same model.
- `fixedVoice: true` (TTS): the entry keeps its own `voice` even when the request sends `fallback_voice`.
- `oneGpuDeployment` (deployment entries) — **one-GPU mode**: while `deployment` is not registered on this gateway
  and `oneGpuDeployment` is, the entry goes to `oneGpuDeployment` (e.g. TTS on the `parle-speech` machine that already
  runs Whisper + Qwen3.5 + Qwen3-TTS). A registered `deployment` always wins. Resolved when the providers are mounted
  (boot, routes PUT, key reload, a declared deployment registered); `/health?details=1` shows the effective target and the
  boot log lists it under `oneGpu`.
- `order: "benchmark"` + `benchmarkDataset` (first entry only): the entries after the first are ordered by the model
  benchmark ranking of that dataset (`POST /v1/admin/benchmarks`, admin); unranked entries keep their order after the
  ranked ones and the first entry never moves. Formula, weights and routes: [`docs/model-benchmarks.md`](../model-benchmarks.md).
- `voices: {feminine, masculine}` (TTS; capability, not in the parle's chain, which is MAI-Voice → Kokoro): a fallback that cannot clone speaks a stock voice of the **gender** of the
  requested voice (`src/config/tts-fallback-voices.ts`). The gender comes from the entry's `voiceGenders`
  (`{"pt-PT-1baab6": "masculine", …}`, the app's cast), the `xx-f-`/`xx-m-` slug, or the gender letter of a Kokoro
  `fallback_voice` (`pf_…`/`pm_…`); default feminine. With `preferFallbackVoice: true` the request's `fallback_voice`
  wins over the table. Known stock voices: Qwen-Audio `Cherry`/`Ethan`, Kokoro `pf_dora`/`pm_alex`.
- `accountPolicyGuard: true` (TTS): **account data policy**. With Zero Data Retention on the OpenRouter account,
  some models (e.g. Qwen-Audio, a DashScope endpoint) are refused (`404 … data policy / ZDR violation`). The first refusal takes that link
  out of the chain for 30 min (code `policy`, `X-Gateway-Fallback: policy`): later requests go to the next link without
  calling it, the refusal does not open the OpenRouter breaker that the next link may share, and `/health?details=1` shows the
  link as `blocked` with the reason. A key reload lifts the block. The gateway never changes the account's privacy
  setting.

Voices are provider-specific: on `/v1/audio/speech`, `voice` goes to the first provider; a fallback with `voices`
picks its stock voice as above, any other fallback uses `fallback_voice` from the request (unless `fixedVoice`),
else its own configured voice. The replica must expose the OpenAI shapes (`/v1/audio/transcriptions`,
`/v1/chat/completions`, `/v1/audio/speech`).

**Self-hosted TTS (Qwen3-TTS Base).** For a deployment target:

- `voice` may be a **cast voice id** of the replica's catalog (`GET /refs/voices.json` on the replica, cached 5 min).
  When the client sends no `ref_audio`, the gateway turns it into `task_type: "Base"`, `ref_audio`, `ref_text`,
  `language` (from the voice) and the catalog's `model` — the request parle's `qwen-speech.ts` builds, without
  `voice` (vLLM-Omni would read it as a precomputed speaker). A voice that is not in the catalog is **never sent**
  to the replica (vLLM-Omni's engine dies on it): the request falls back with `X-Gateway-Fallback: voice_not_found`.
  A Base deployment (model name ending in `-Base`, or a replica that ever showed a catalog) whose catalog is
  unavailable (404 while its refs server starts, error) is not sent `voice` either: the request falls back with
  `X-Gateway-Fallback: catalog_unavailable`. A missing catalog is trusted for 15 s only; a catalog for 5 min.
  A CustomVoice / OpenAI-shaped replica without catalog gets the request as sent.
- Only these extra body fields are forwarded: `task_type`, `ref_audio`, `ref_text`, `language` (ISO codes become
  `Portuguese`/`French`/…), `stream_format`, `instructions`, and `max_new_tokens` when it is a positive integer no
  larger than the gateway's own cap for the input (it may lower the cap, never raise it); any other field is dropped.
  `ref_audio` must be inline (`data:audio/...;base64,…`): a URL gets `400`, since the replica would fetch it. The
  OpenRouter fallback never receives these fields.
- With `response_format` `wav` or `pcm` the audio is **streamed** from the replica to the client
  (`stream: true, stream_format: "audio"`; send `"stream": false` to turn it off). Other formats come whole.
  A streamed body that breaks upstream reaches the client as a cut connection (a transport error), never as a
  complete answer.

```json
{ "model": "parle-tts", "input": "Bom dia!", "voice": "br-f-01", "fallback_voice": "pf_dora", "response_format": "wav" }
```

Built-in cloud models keep their own chains: Groq chat models fall back to the same weights on OpenRouter
(`llama-3.3-70b-versatile` → `meta-llama/llama-3.3-70b-instruct`, `openai/gpt-oss-120b` → same id, …), GLM models
go Z.AI → OpenRouter `z-ai/<id>`, `whisper-large-v3(-turbo)` goes Groq → OpenRouter → OpenAI → Fireworks →
Deepgram, Orpheus TTS is Groq only. Any other `org/model` id goes to OpenRouter as-is,
followed by the generic chat fallback; without a usable OpenRouter key it answers `503 provider_unavailable`
naming the key (not `404`). PlayAI TTS was retired by Groq and is no longer offered.

### App devices — `/v1/apps/:app/devices`

An app may name the end-user device behind each request with an opaque id, then list the devices it has seen and
block one. Off unless the app sends ids: an app that sends none works exactly as before.

**Sending the id**

| Path | How |
|---|---|
| `POST /v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/embeddings`, `/v1/images/*`, `/v1/s2s` | header `X-Gateway-Device: <id>` |
| `POST /v1/realtime/sessions` | body field `"device": "<id>"` — signed into the session token (claim `dev`), so the WebSocket, WebRTC signaling and telemetry of that session carry it without trusting the browser again |
| Node SDK (`GatewayClient`) | `device` on any call: `gw.chat({ model, messages, device })` |
| Browser SDK (`createRealtimeSession`) | option `device`: posted to the app's `sessionEndpoint` as `{transports, prefer, device}`; the app's backend passes it on (or, better, replaces it with an id it trusts) |

The id is 8–64 characters of `[A-Za-z0-9_:-]`, starting with a letter or digit (a UUID fits). Anything else, and
anything shaped like a key or token (`sk-…`, a JWT, `token_…`), is refused with `400 invalid_device` and never
stored or logged. With an admin key the device is recorded for the app named by `X-App` (none: not recorded).

**Routes** — the app's own key, or an admin key (same rule as every `/v1/apps/:app/*` path; another app's key: `403`).

| Method | Path | |
|---|---|---|
| `GET` | `/v1/apps/:app/devices` | `{ app, requireDevice, total, blocked, max, devices: [{ id, firstSeen, lastSeen, requestsToday, requests, lastKind, blocked?: { reason, by, at } }] }`. Query: `sort` = `lastSeen` (default) \| `firstSeen` \| `requestsToday` \| `requests`, `order` = `desc` (default) \| `asc`, `limit` (default 500), `blocked=1` (only blocked ones). Times are ms since the epoch; `requestsToday` is per UTC day; `lastKind` is `chat` / `stt` / `tts` / `s2s` / `realtime` / … |
| `POST` | `/v1/apps/:app/devices/:device/block` | optional body `{ "reason": "…" }` (≤ 200 chars). Works for a device never seen (pre-block). Answers the device record |
| `DELETE` | `/v1/apps/:app/devices/:device/block` | unblock; `404` for an unknown device |
| `PATCH` | `/v1/apps/:app` | `{ "requireDevice": true \| false }` — refuse this app's requests that carry no device id |

**What a blocked device gets**

| Path | Effect | How fast |
|---|---|---|
| HTTP inference routes, `/v1/s2s` | `403` `{"error": {"type": "permission_error", "code": "device_blocked"}}`, before the daily budget is charged | the next request |
| `POST /v1/realtime/sessions` | `403` `{"error": {"type": "realtime_error", "code": "device_blocked"}}`, nothing charged | the next admission |
| open WebSocket session (relayed by the gateway) | closed with code `1008`, reason `device_blocked`; reconnecting answers `403` | the next frame the browser sends (audio frames flow continuously: milliseconds) |
| open WebRTC session (audio goes browser ↔ replica, not through the gateway) | the gateway deletes the session on the replica (`DELETE /__aigw/rt/session/:id`); every later signaling call of its token answers `403 device_blocked` | at once while the gateway process that admitted it still knows the session (its token lifetime, default 10 min). Otherwise — gateway restarted, replica unreachable for the delete — the session ends at the edge's own session cap, 15 min after it started. It can never be re-opened |

With `requireDevice`, a request without an id answers `403` `code: device_required`.

**Storage and privacy.** The registry lives in the app account (`DEPLOYMENTS_STATE_DIR/apps.json`), written at most
every 30 s and on every block/unblock, never on the request path (a map lookup per request). Per device: the id,
first/last seen, request counts, last kind, and the block (reason, the key user who set it, when). **No IP address,
no user agent, no content**: students share a university NAT, an IP is personal data and identifies nobody. At most
`APP_MAX_DEVICES` (default 2000) devices per app: over it the least recently seen unblocked one is dropped; a
blocked device is never dropped (when all 2000 are blocked ones, new devices are served but not listed, and a
further block answers `409`). The app chooses the id: prefer a random per-install id over anything that names a
person.

**The limit.** The id is asserted by the app or its client. A block stops an unmodified client and everything the
app's backend identifies; it does not stop someone who forges a new id. For that the app must mint the ids server
side (e.g. a signed per-install id checked by its backend before it calls the gateway) and set `requireDevice`.
The SDK's direct fallback (the app's backend calling providers while the gateway is unreachable) does not pass
through the gateway, so the app must enforce its own blocks there.

**Example — `babelcast`**

```bash
# who is using babelcast, most recent first
curl "$GW/v1/apps/babelcast/devices?limit=50" -H "Authorization: Bearer $ADMIN_KEY"
# block one, then check
curl -X POST $GW/v1/apps/babelcast/devices/install-7f3a9c21/block -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"reason": "account shared outside the class"}'
curl "$GW/v1/apps/babelcast/devices?blocked=1" -H "Authorization: Bearer $ADMIN_KEY"
# unblock
curl -X DELETE $GW/v1/apps/babelcast/devices/install-7f3a9c21/block -H "Authorization: Bearer $ADMIN_KEY"
# make ids mandatory for this app
curl -X PATCH $GW/v1/apps/babelcast -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"requireDevice": true}'
```

An app exists once a key names it: add `<new key>:babelcast` to `GATEWAY_API_KEYS` (a host setting of the gateway
service, read at start) and give it its model aliases with an admin key:

```bash
curl -X PUT $GW/v1/apps/babelcast/routes -H "Authorization: Bearer $ADMIN_KEY" -H 'X-App: babelcast' \
  -H 'Content-Type: application/json' -d '{ "chat": { "babelcast-llm": ["openrouter:<org/model>"] } }'
```

Devices show up in the list only when babelcast's backend sends `X-Gateway-Device` (or `device` for a realtime
session).

### Direct-fallback plan — `GET /v1/apps/:app/fallback`

What an app's server-side client needs to call the **same aliases directly** on the cloud providers while the
gateway itself is unreachable ([client § Direct fallback](./client.md)). Allowed for the app's own key, or
an admin key with `X-App: <app>`; anything else → `403` (an admin key without `X-App` too). `Cache-Control: no-store`.

```json
{ "app": "parle", "issuedAt": "2026-10-06T10:00:00.000Z", "ttlSeconds": 3600,
  "providers": { "openrouter": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "sk-or-v1-…", "keyKind": "provisioned",
                                 "expiresAt": "2026-10-14T10:00:00.000Z", "limitUsd": 5 } },
  "openrouter": { "…": "same as providers.openrouter, or null" },
  "routes": { "stt": { "parle-stt": [{ "provider": "openrouter", "model": "openai/whisper-large-v3-turbo" }] },
              "chat": { "parle-llm": [{ "provider": "openrouter", "model": "qwen/qwen3.5-9b", "extraBody": { "reasoning": { "enabled": false } } }] },
              "tts": { "parle-tts": [{ "provider": "openrouter", "model": "hexgrad/kokoro-82m", "voice": "pf_dora", "fixedVoice": true }] } } }
```

- **Routes**: the app's aliases (`PUT /v1/apps/:app/routes`), keeping per alias the entries of a direct-callable
  provider (OpenRouter, Groq), in chain order, with `voice` / `fixedVoice` / `extraBody`. Deployments and other
  providers are dropped: the client cannot reach them without the gateway. An entry without `model` calls the alias
  itself. The client only calls entries whose provider has a credential in `providers`.
- **Keys**: a per-app minted key when `OPENROUTER_PROVISIONING_KEY` is set; otherwise **none** — `providers: {}`,
  `openrouter: null`, and the client's direct fallback stays off (it rethrows the gateway's error).

| Env | Default | |
|---|---|---|
| `OPENROUTER_PROVISIONING_KEY` | unset | mint a per-app OpenRouter key (`aigw-<app>`) through OpenRouter's provisioning API (`POST /api/v1/keys`, `DELETE /api/v1/keys/:hash`) instead of sharing the gateway's; only its hash is stored in the app account, the key lives in memory (a restart mints a new one) |
| `APP_FALLBACK_KEY_LIMIT_USD` | `5` | USD limit of a minted key |
| `APP_FALLBACK_KEY_ROTATE_DAYS` | `7` | a minted key is replaced after this; the old one keeps working one more day, then is deleted (each key also expires on its own at rotation + 1 day) |
| `APP_FALLBACK_PLAN_TTL_SECONDS` | `3600` | `ttlSeconds` of the plan (shorter when a rotation is closer) |
| `APP_FALLBACK_SHARE_KEY` | off | `1` = when no key can be minted, hand out the gateway's own `OPENROUTER_API_KEY` / `GROQ_API_KEY` (`keyKind: "shared"`: the whole account, no limit, no expiry). Any other value, or unset, never does |

Since 06/10/2026 the gateway's own master keys are **not** shared by default (a security test found the master
OpenRouter key handed out to any admin key with `X-App`). Without provisioning and without `APP_FALLBACK_SHARE_KEY=1`,
the plan carries routes and no key. A failed provisioning falls back to the shared key only when that opt-in is set. Keys are never logged and appear in no other response. Security: the
plan goes only over HTTPS, only to authenticated app keys, and only to **server-side** clients — never to a browser
bundle; a minted key's limit bounds what a leak can cost. Needs app accounts (deployments enabled).

### Instability reports — `POST /v1/apps/:app/stability-report`

The SDK client ([client § Instability report](./client.md)) buffers what it saw while the gateway was unreachable or
slow — `unreachable`, `direct`, `slow`, `direct_failed`, `recovered` events — and posts the batch here once the
gateway answers again. The caller rules of the app's other paths apply (the app's own key, or an admin key; `X-App`
for another app).

```json
{ "client": "parle-backend", "sentAt": 1750000000000,
  "events": [{ "at": 1750000000000, "kind": "unreachable", "path": "/v1/chat/completions", "code": "network", "latencyMs": 40 },
             { "at": 1750000000100, "kind": "direct", "route": "direct", "detail": "network" }] }
```

→ `200 { ok: true, accepted: <n> }`. Malformed events are dropped (`accepted` counts the kept ones — `at` + `kind`
required, string fields capped); an eventless report stores nothing. Reports land in an in-memory ring (last 200) and,
best-effort, `client-stability.jsonl` under `DEPLOYMENTS_STATE_DIR`.

`GET /v1/apps/:app/stability-report?limit=50` → `{ app, reports: [{ app, client, receivedAt, events }] }` (newest
last) — the app's own outages, readable by the same callers.

### Changing the map — `MODEL_ROUTES`

A JSON env var adds or replaces chains (same model = replaced). Entries: `"provider"`, `"provider:upstreamModel"`,
`"deployment:<name>[:upstreamModel]"`, or `{"provider", "model", "voice", "fixedVoice", "deployment", "extraBody"}` (`extraBody`:
provider-specific chat body fields, e.g. `{"reasoning": {"enabled": false}}`). The chat key `"*"`
replaces the generic chat fallback (default: Groq `llama-3.3-70b-versatile`, then OpenRouter
`meta-llama/llama-3.3-70b-instruct`).

```json
{
  "stt":  { "parle-stt": ["deployment:parle-speech:whisper-large-v3-turbo", "openrouter:openai/whisper-large-v3-turbo"] },
  "chat": { "parle-llm": ["deployment:parle-speech", "openrouter:qwen/qwen3.5-9b"] },
  "tts":  { "parle-tts": ["deployment:parle-qwen-tts:Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                          { "provider": "openrouter", "model": "fish-audio/s2-pro", "voice": "<voice id>" }] }
}
```

### Where an answer came from

Every successful response of the three routes carries (no secrets):

| Header | Example | Meaning |
|---|---|---|
| `X-Gateway-Provider` | `deployment:parle-qwen-tts`, `openrouter:microsoft/mai-voice-2.1-flash` | who answered (`deployment:<name>` or `<provider>:<upstream model>`) |
| `X-Gateway-Fallback` | `cold` | only when the first target of the chain did not answer (two targets of the same provider count as different): `cold`, `paused`, `5xx`, `timeout`, `slow`, `unreachable`, `empty`, `voice_not_found`, `catalog_unavailable`, `auth`, `credit`, `rate_limited`, `not_found`, `not_configured`, `policy`, `circuit_open`, `cooldown`, `error` |
| `X-Gateway-Fallback-From` | `deployment:parle-speech` | the provider that was left behind |

Streaming chat (`stream: true`) falls back only before the first token, so the headers are final.
A deployment target streams too: the gateway asks the replica for `stream: true` and relays each delta as it arrives
(until 2026-10-08 it asked for the whole answer and sent it as one SSE chunk).
An SSE `{"error": …}` event inside a deployment's chat stream (the speech stack sends one when its LLM breaks or
stalls) is a failure of that target, never content: before the first token the next target answers
(`X-Gateway-Fallback: error`); after it the stream ends with the gateway's own `data: {"error": …}` event and no
`[DONE]`. Either way the replica's `chat` stage gets a strike and the breaker a failure.
An STT answer served from the gateway's 5-minute cache (same audio, model, language and format) carries
`X-Gateway-Provider: cache` and `X-Cache: HIT`; it still wakes a cold primary deployment for the next turn (not in
no-wake mode).

### `503 provider_unavailable`

When no provider of the chain can serve the request — keys missing, keys rejected, every provider failing — the
gateway answers `503` and says which key is missing or which provider failed (never a key value). Entries that
were never mounted (e.g. the OpenRouter fallback without key) are listed too, even when the deployment was tried:

```json
{
  "error": {
    "message": "No provider available for chat model \"parle-llm\": deployment:parle-speech failed (HTTP 503): deployment 'parle-speech': replicas are starting; openrouter: OPENROUTER_API_KEY is not set",
    "type": "provider_unavailable",
    "code": "provider_unavailable",
    "providers": [
      "deployment:parle-speech failed (HTTP 503): deployment 'parle-speech': replicas are starting",
      "openrouter: OPENROUTER_API_KEY is not set"
    ]
  }
}
```

A model the gateway does not know answers `404`. `GET /v1/models` lists only models with at least one configured
provider (and the OpenRouter catalog only while `OPENROUTER_API_KEY` is accepted by OpenRouter's `/api/v1/key`).

---

## Speech-to-speech — `POST /v1/s2s`

One streamed request for a whole spoken turn: the student's audio in, the character's voice out, sentence by sentence.
Built for low latency: no round trip between stages, the first sentence is voiced while the LLM is still writing.

**Request** — multipart: `file` (the utterance: webm/ogg/wav/mp3/m4a) and `config` (JSON):

```json
{ "system": "Você é o Seu Jorge, padeiro…", "messages": [{"role": "assistant", "content": "Bom dia!"}],
  "language": "pt", "voice": "br-m-08", "fallback_voice": "pf_dora", "max_tokens": 160, "temperature": 0.6 }
```

**First-audio deadline and opener** (optional; contract and limits in [realtime.md](../realtime.md) § First-audio
deadline and opener): `"first_audio_deadline_ms": 2000` (default `FIRST_AUDIO_DEADLINE_MS`, at most 2500),
`"endpoint_ms": 700` (the silence the client waited after the speech before posting: the deadline then starts at the
end of the speech, not at the request) and `"opener": {"lines": ["Hum, deixa eu ver.", "Só um instante."]}`. With
lines, a turn with no audio at deadline − 300 ms gets `opener {state:"start", text, index, audio_ms, at_ms}`, the
line's audio, `opener {state:"end"}`, then the reply; without, `deadline_missed {deadline_ms, at_ms}` at the deadline.
`done` adds `first_sound_ms`, `opener`, `deadline_ms`, `deadline_missed`, `endpoint_ms` (`first_audio_ms` stays the first
reply audio). On the composed path an opener may be MP3: its `audio_format` event precedes it and the reply announces
its format again. A turn that sends none of the three fields behaves as before, with the new `done` fields only.

**Which deployment and models** (the gateway names no app's): `"deployment": "parle-speech"` is the speech-stack
primary (default `S2S_DEPLOYMENT`; none = composed pipeline only; an app key may name only a deployment of its own
app, see [Authentication](#authentication)) and `"models": {"stt": "parle-stt", "chat":
"parle-llm", "tts": "parle-tts"}` the stage models of the composed pipeline. Without `config.models` the gateway uses `S2S_STT_MODEL` /
`S2S_CHAT_MODEL` / `S2S_TTS_MODEL` when set (no default value), else the calling app's own route aliases
(`PUT /v1/apps/:app/routes`: for an app key always its own app; for an admin key the app that owns `config.deployment`, else its own; per stage the alias whose
chain reaches that deployment, else the first), so a cold GPU still has the composed reserve. A stage with no model
anywhere fails that turn with `503`, never a model called "undefined".

**Prompt built before the transcript exists**: `"user_template": "…The player says: \"{{transcript}}\"…"` — the user
turn becomes the template with `{{transcript}}` replaced by what was heard (default: the transcript alone). A client
that must look at the transcript before committing to the reply (commands, low confidence) reads the `transcript`
event and cancels the request if the turn is not for the character.

**JSON answers** (a character that also decides something): send `"response_format": {"type": "json_object"}` and
`"speak_field": "utterance"`. Only that field is voiced, as it streams; `done.reply_raw` carries the whole JSON. The
speech-stack primary takes JSON turns only with `S2S_PRIMARY_SPEAK_FIELD=1` (image from 2026-10-06 on); until then
they go to the composed pipeline (`route.fallback: "unsupported"`).

**Response** — `application/x-aigw-s2s` frames `[1 byte kind][4 bytes BE length][payload]`: `E` = one JSON event,
`A` = raw PCM s16le mono (24 kHz unless an `audio_format` event says otherwise). `?format=ndjson` gives one JSON per
line with audio as `{"type":"audio","pcm":"<base64>"}` (debugging, browsers without a frame parser).

Events, in order: `route` {provider, fallback?, from?} · `transcript` {text, stt_ms} · `llm_first_token` · per sentence
`sentence` {text}, its audio, then `sentence_end` · `audio_format` {encoding, sample_rate} when it changes · `first_audio` {at_ms} ·
`opener` {state, text, index} around an opener's audio · `deadline_missed` {deadline_ms} ·
`done` {reply, transcript, first_audio_ms, first_sound_ms, opener, deadline_ms, deadline_missed, total_ms, sentences, spoken, skipped, audio_ms, missing_audio?, partial?}.
`sentence_failed` = that sentence has no audio (the rest continues); `error` {stage?, code?, unspoken?, partial?} = the
turn stopped (`partial: true` → what was sent is valid).

**How a turn ends.** With `done`, or with an `error` (followed by `done {partial: true}` when audio had started);
a stream that closes any other way was cut and is a failed turn. `done` is complete only when `spoken` = `sentences`
and `skipped` = 0. `error.code`: `upstream_truncated` (the replica's stream broke or closed without `done`),
`upstream_stalled` (nothing for `S2S_MAX_GAP_MS`, 10 s, or the whole-turn budget ran out), `stage_failed` (the
speech stack named its failing `stage`: `stt`, `llm`, `tts`). `error.unspoken` = reply text known and not voiced:
a client speaks it once (the SDK's `speak`) and never replays what was heard. Each cut is counted per deployment,
replica and stage in `GET /health?details=1` → `streams` and sent as a `stream.cut` telemetry event; a cut or a stall
is a failure of the replica's `s2s` stage (three in a row take it out for 30 s), a client that leaves is not.

**Routing**

| Situation | What answers | `route` event |
|---|---|---|
| speech-stack deployment ready (`config.deployment`, else `S2S_DEPLOYMENT`) | its own `/v1/s2s`: STT + LLM + TTS on one GPU (0.4–0.8 s to first audio measured) | `deployment:parle-speech` |
| deployment cold / paused / absent | woken for the next turns (not in no-wake mode); this turn by the **composed pipeline**: `models.stt` → streamed `models.chat` → `models.tts` per sentence, each stage with its own chain, hedge and breaker (above) | `composite`, `fallback: cold\|paused\|not_found` |
| deployment has not sent the transcript after `S2S_HEDGE_MS` (2.5 s) | composed pipeline in parallel; first to produce audio wins, the other is aborted | `composite`, `fallback: slow` |
| deployment breaks after the transcript, before audio | composed pipeline resumes at the LLM with that transcript (no second STT) | `composite`, `fallback: resumed` |
| deployment breaks after audio started | in-band `error` (`partial: true`) and `done` | — |
| nothing can answer before the first byte | `503 provider_unavailable` (JSON, as the other routes) | — |

**STT filter in `/v1/s2s`.** The composed path inherits the filter of `/v1/audio/transcriptions` (loopback; `config.language`
and `config.filter_hallucinations: false` are forwarded). The primary path filters the replica's `transcript` event here
(blocklist always; metadata when the event carries `no_speech_prob`, `avg_logprob`, `compression_ratio`). A filtered turn is
a valid answer, not a failure (no fallback, lease released healthy, replica stream cancelled, no LLM/TTS spend):

```
route → transcript {text:""} → filtered {stage:"stt", reasons:["blocklist"], raw_length:5} → done {empty:true, filtered:true, reply:""}
```

Clients must treat `done.empty` / empty `transcript.text` as "nothing heard"; `filtered` is informational.

Whole turn budget: `S2S_BUDGET_MS` (45 s). The composed pipeline calls this gateway's own routes over loopback with the
caller's key (stage models: `config.models`, else `S2S_STT_MODEL` / `S2S_CHAT_MODEL` / `S2S_TTS_MODEL`, else the app's route aliases).

## Realtime voice — `/v1/realtime/*`

Architecture, the contract shared with the replica (token, edge routes, events, audio) and the browser SDK
(`@parle/ai-gateway/realtime`): [`docs/realtime.md`](../realtime.md).

### `POST /v1/realtime/sessions`

Auth: app or admin API key. Called by the app's backend, never by the browser.

| Field | Type | |
|---|---|---|
| `config` | object | the `/v1/s2s` session config (`system`, `messages`, `voice`, `language`, `models`, `max_tokens`, …, `deployment`; default `S2S_DEPLOYMENT`), plus the realtime-only `intercepts` and `reply_guard` ([realtime.md](../realtime.md) § App hooks) |
| `transports` | string[] | optional ordered preference among `webrtc`, `ws`, `s2s-stream`, `post` (must include `webrtc` or `ws`) |
| `prefer` | string | optional: moved first |
| `device` | string | optional: the end-user device this session is for (see *App devices*); signed into the token |

Headers: `traceparent` (optional, W3C), `X-Gateway-No-Wake: 1` (a cold deployment is not woken).

| Status | Meaning |
|---|---|
| 200 | `{sessionId, token, cfg?, expiresAt, deployment, traceId, telemetryUrl, transports[], iceServers[], limits}` |
| 400 | bad body, unknown transport, malformed `intercepts` / `reply_guard` |
| 401 | no / unknown key |
| 403 | the key's app does not own the deployment (also when it does not exist); `device_blocked` / `device_required` (see *App devices*) |
| 404 | (admin) deployment not found — with `fallback` |
| 413 | `config` over 32768 base64url characters (~24 KB of JSON) — send the long history with `config_update` once connected. Up to 6144 the config rides in the token; above, the answer also carries `cfg` (the config's base64url text, which the SDK hands to the edge) and the token only its digest: [realtime.md](../realtime.md) § Token, with the prompt sizes that fit each LLM context |
| 429 | app daily budget exhausted (`Retry-After`); a session costs `REALTIME_REQUESTS_PER_MINUTE` × ⌈TTL/60⌉ requests |
| 503 | `cold` (woken unless no-wake) / `saturated` / `unsupported` / `unreachable` / `paused`, with `Retry-After` and `fallback: {transport:"s2s-stream", url:"/v1/s2s"}` |

Every answer carries `X-Aigw-Trace-Id`.

### `POST /v1/realtime/updates`

Auth: the app's API key (server side). Signs a change to a live session of the app for the page to hand to the edge.

| Field | Type | |
|---|---|---|
| `token` | string | the session token of `POST /v1/realtime/sessions` |
| `update` | object | `drop_turn`, `messages` (replaces the history), `system`, `voice`, `fallback_voice`, `user_template`, `max_tokens`, `temperature`, `stt_prompt`, `opener`, `first_audio_deadline_ms`, `intercepts`, `reply_guard`, `say {text, voice?, fallback_voice?, history?, tag?}` — [realtime.md](../realtime.md) § App hooks |

| Status | Meaning |
|---|---|
| 200 | `{sessionId, signed, n}`: send `{type:"config_update", signed}` on the session (SDK `applyUpdate`); the edge answers `config_applied{n}` and refuses an older `n` |
| 400 | bad body, malformed `intercepts` / `say` / `reply_guard` |
| 401 | no / unknown key, or a token that does not verify (`token_expired` when expired) |
| 403 | the session is another app's |
| 410 | `replica_gone` |
| 413 | `update` over 32768 base64url characters |

No call to the replica and no gateway state: the answer is a signature.

### Browser routes (session token, not an API key)

Auth: `Authorization: Bearer <session token>` (or `token` in the JSON body; on the WebSocket, the subprotocol `aigw.token.<token>` next to `aigw.rt`, or `?token=` for older clients). CORS `*`.

| Route | |
|---|---|
| `POST /v1/realtime/sessions/:id/offer` | `{sdp, cfg?}` (`cfg`: the descriptor's, for a config by reference) → `{sdp, type:"answer", sessionId}`. 401 bad / expired (`token_expired`), 403 token of another session, 410 `replica_gone`, 502 `edge_error` / `edge_unreachable`, 503 `saturated` |
| `POST /v1/realtime/sessions/:id/ice` | `{candidate}` (trickle, optional) → 204 |
| `DELETE /v1/realtime/sessions/:id` | ends the session on the replica (frees its slot) → 204 |
| `GET /v1/realtime/ws[?traceparent=…]` (token as subprotocol, or `?token=`) | WebSocket relayed to the replica. Text: JSON events / control; binary: `0x01` + PCM16 LE mono (16 kHz up, 24 kHz down, 20 ms). Refused before the handshake with 400 / 401 / 410 / 502 / 504; close codes cross both ways; 1013 when the browser stops reading; 1009 over 1 MiB |

Control messages from the browser (WS text frames, WebRTC data channel): `interrupt`, `end_turn`, `ping` and
`config_update {messages?, opener?}` or `config_update {signed}`. The session config signed in the token is authoritative: a `config_update` with
any other field (`system`, `voice`, `user_template`, …) or a `system` message is refused whole with
`{type:"error", code:"forbidden"}` ([realtime.md](../realtime.md) § Events and control messages).

### Environment

| Variable | Default | |
|---|---|---|
| `REALTIME_PUBLIC_URL` | from the request | public base of the gateway for the descriptor's URLs |
| `REALTIME_SESSION_TTL_SECONDS` | 600 | 60–900 |
| `REALTIME_REQUESTS_PER_MINUTE` | 4 | budget charge per minute of session |
| `REALTIME_STUN_URLS` | `stun:stun.l.google.com:19302` | empty = none |
| `REALTIME_TURN_URLS` | — | `turn:` / `turns:` URLs |
| `REALTIME_TURN_SECRET` | — | coturn static-auth-secret (per-session TURN REST credentials) |

## OpenAI-compatible routes

### `POST /v1/audio/transcriptions`

```bash
curl -X POST https://<gateway>/v1/audio/transcriptions -H "Authorization: Bearer $KEY" \
  -F "file=@audio.wav" -F "model=parle-stt" -F "language=pt"
```

```json
{ "text": "Bom dia" }
```

**Hallucination filter (on by default, every provider, every client).** Whisper and other STT models invent text on
silence and noise ("E aí", "Obrigado por assistir", "Legendas pela comunidade Amara.org"). The gateway asks the provider
for segment metadata when it can (`no_speech_prob`, `avg_logprob`, `compression_ratio`), drops what the metadata or the
blocklist marks as invented, and answers `{"text":""}` (still `200`; the client treats it as "nothing heard"):

| | |
|---|---|
| response header `X-STT-Filtered` | on every `200`: reason codes, comma separated (`no_speech_prob`, `compression_ratio`, `avg_logprob`, `blocklist`, `blocklist_corroborated`, `pattern_credits`, `music`, `repetition`), `none` when the answer was kept, `off` when the filter did not run; never transcript text. Also set when only some segments were trimmed |
| response header `X-STT-Raw-Length` | length in characters of what the provider returned (on every `200`) |
| multipart field `filter_hallucinations=false` | per-request opt-out (QA); `0`/`off` also accepted. Such answers are cached apart from filtered ones |
| `language` | `pt`, `pt-BR` or `Portuguese` (codes and English/native names). Without it only the high-confidence phrases apply |
| `response_format=verbose_json` | `language`, `duration` and the kept `segments` are returned next to `text` |
| env `STT_HALLUCINATION_FILTER=0` | turns the filter off for the whole gateway |
| env `STT_FILTER_NO_SPEECH_PROB` (0.6), `STT_FILTER_AVG_LOGPROB` (-1.0), `STT_FILTER_COMPRESSION_RATIO` (2.4), `STT_FILTER_AMBIGUOUS_NO_SPEECH_PROB` (0.4) | thresholds, no deploy of code needed (design choices to pilot) |

A filtered (empty) answer is never cached. `GET /health?details=1` (admin key) carries `sttFilter` (`answered`, `filtered`, `partial`,
`withMetadata`, `byReason`, `filteredRate`); filtered answers log reasons and lengths only, never the text.
Entry points, what each filters and how: [docs/stt-hallucination-filter.md](../stt-hallucination-filter.md).

### `POST /v1/chat/completions`

```bash
curl -X POST https://<gateway>/v1/chat/completions -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"parle-llm","messages":[{"role":"user","content":"Olá"}]}'
```

### `POST /v1/audio/speech`

```bash
curl -X POST https://<gateway>/v1/audio/speech -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"parle-tts","input":"Olá","voice":"br-f-01","fallback_voice":"pf_dora","response_format":"wav"}' --output speech.wav
```

### `GET /v1/models`

OpenAI-style model list (see the rules above).

### `POST /v1/images/generate`, `POST /v1/images/inpaint`

Image generation (`dit360` → self-hosted 360° GPU, `fal-ai/*` → fal.ai).

---

## Deployments

Docker image → autoscaled replicas on Scaleway and/or Vast machines. Enabled when `SCW_SECRET_KEY` (Scaleway) or
`VAST_API_KEY` (Vast) is set. Mutations need an admin key.

::: danger Namespace = ownership
A gateway releases, as orphans, every machine tagged with its `DEPLOYMENTS_NAMESPACE` that belongs to no deployment
it knows. A local or test gateway holding the real `SCW_SECRET_KEY` with the production namespace would therefore
release the production replicas. Rules: outside Railway the namespace is **required** (deployments stay off without
it) — use your own (`dev-<name>`, `gwtest`); the namespace (and `DEPLOYMENTS_STATE_DIR`, `DEPLOYMENTS_ENABLED`,
`RAILWAY_*`) is never taken from the palco, only from the host environment. Only the production service uses the
production namespace (`default` on Railway).
:::

| Method | Path | |
|---|---|---|
| `GET` | `/v1/deployments` | list, with controller health |
| `PUT` | `/v1/deployments/:name` | create or update (spec fields and/or `{ "profile": "<name>" }`) |
| `PATCH` | `/v1/deployments/:name` | update an existing one (e.g. `{ "minReplicas": 1 }`) |
| `GET` | `/v1/deployments/:name` | status + replicas |
| `DELETE` | `/v1/deployments/:name` | release every replica and forget the spec |
| `POST` | `/v1/deployments/:name/wake` | start replicas now (pre-warm) (admin, or a client key with `canStartGpu` and no daily cap — a capped key gets `403` pointing to `start`) |
| `POST` | `/v1/deployments/:name/warm` | body `{ "replicas": n, "untilMinutes": m }`: keep `n` replicas up (0…`maxReplicas`) for `m` minutes (≤ 720) whatever the load; a later call replaces the window, `park` ends it; counts as a request (admin) |
| `POST` | `/v1/deployments/:name/park` | done for now: forget the last use, scale to `minReplicas` at the next tick (powers off under `idleAction: "stop"`); in-flight requests are never cut (admin, or a client key with `canStartGpu` on its app's deployment) |
| `POST` | `/v1/deployments/:name/start` | **client key with `canStartGpu`**, its app's deployment only: body `{ "minutes": 1–240 }` keeps one GPU up for that long (never fewer than a warm window already there). At the end it is parked once nobody used it for the key's `startIdleMinutes` (default 10) — unless a warm schedule, a realtime session, another warm window or another key's start needs it. `202 { deployment, until, idleMinutes, spentTodayEur, capEur }`. Over the key's daily cap → `402` saying what was spent and what to do |
| | | A capped key that names a deployment with a **test copy** (another deployment whose spec has `testFor: "<name>"`, same app) starts the copy instead — `parle-speech` → `parle-speech-test`, one L4 (docs/deployments.md). While the copy is ready and the original is not, alias requests for the original are served by the copy |
| `POST` | `/v1/deployments/:name/extend` | the same key: `{ "minutes": n }` more on the GPU it started (at most 240 min ahead); `404` without a start |
| any | `/v1/deployments/:name/invoke/<path>` | forwarded to a ready replica as `/<path>`; waits through a cold start (`X-Aigw-Wait: <seconds>` caps it; `X-Gateway-No-Wake: 1` → 503 `cold` at once instead). Raw passthrough: the STT hallucination filter does NOT apply here (use `/v1/audio/transcriptions` or `/v1/s2s`) |
| `GET` | `/v1/profiles` | built-in + stored profiles (`qwen3-tts`, `qwen3-tts-clone`, `cpu-echo`, …) |
| `PUT` / `DELETE` | `/v1/profiles/:name` | store / delete a profile |

`invoke` is the raw passthrough; the OpenAI routes above use the same replicas with fallback and without waiting
for a cold start.

### App accounts — `/v1/apps`

| Method | Path | |
|---|---|---|
| `GET` | `/v1/apps` | admin (no `X-App`): every app; an app key (or `X-App`): `{ "apps": [<its own>] }` |
| `GET` | `/v1/apps/:app` | `{ id, createdAt, requireDevice, images, deployments: [{ name, status, appImage }] }` |
| `GET` / `PUT` | `/v1/apps/:app/routes` | the app's aliases (see *App aliases* above) |
| `GET` | `/v1/apps/:app/images` | the app's saved images |
| `GET` / `PUT` / `DELETE` | `/v1/apps/:app/images/:name` | one image: `{ image, digest?, port?, healthPath?, description?, defaults? }`; `PUT` answers `201` when new. `PUT`/`DELETE` need an admin key (the image runs with the deployment's secrets); the app key only reads. A deployment then uses it with `PUT /v1/deployments/:name` `{ "appImage": "<name>" }` (admin, `X-App` naming the app) |
| `GET` | `/v1/apps/:app/fallback` | direct-fallback plan (below) |
| `POST` / `GET` | `/v1/apps/:app/stability-report` | SDK instability reports (below) |
| `PATCH` | `/v1/apps/:app` | `{ "requireDevice": boolean }` (see *App devices*) |
| `GET` / `POST` / `DELETE` | `/v1/apps/:app/devices`, `…/devices/:device/block` | the app's end-user devices: list, block, unblock (see *App devices*) |

Every `/v1/apps/:app/*` path needs that app's own key or an admin key (`403` otherwise).

## Machines and jobs

Single rented hosts with an owner and a lease, for work that is not an HTTP service behind `invoke` (a test desktop, a
GPU job, a stream). Enabled when a provider key is set (`SCW_SECRET_KEY`, `VAST_API_KEY`, `RUNPOD_API_KEY`) and
`MACHINES_ENABLED` is not `0`; same `DEPLOYMENTS_NAMESPACE` rule as deployments. Only an admin key or a user listed in
`MACHINES_USERS` may call these routes (`403` otherwise). The **owner** is the key's user, or `X-App` (an admin may name
any app, another key only its own). An admin without `X-App` sees every owner (`"scope": "all"`); anyone else sees only
their own (`404` for the rest). Prices are in USD per hour (Scaleway's EUR price × 1.2, a conservative rate).

| Method | Path | |
|---|---|---|
| `POST` | `/v1/machines` | rent one machine (body below); `201` with the machine |
| `GET` | `/v1/machines` | `{ namespace, scope, providers, machines: [...] }` |
| `GET` | `/v1/machines/costs` | spend per owner (24 h, month, committed), per holder, per machine; global for an admin |
| `GET` | `/v1/machines/:id` | one machine: `status` (`creating`, `running`, `released`, `failed`), `ip`, `ports` (`"22/tcp"` → public port), `usdPerHour`, `costUsd`, `deadlineAt`, `endReason` |
| `DELETE` | `/v1/machines/:id` | release now (`endReason: "deleted"`) |
| `POST` | `/v1/machines/:id/extend` | `{ "hours"?: n }`: keepalive (resets idle), and with `hours` pushes the deadline (checked against the caps) |
| `POST` | `/v1/jobs` | machine body + `command`, `inputs`, `output`; `201` with the job |
| `GET` | `/v1/jobs`, `/v1/jobs/:id` | job `status` (`starting`, `running`, `succeeded`, `failed`, `timeout`), `exitCode`, `result`, its machine |
| `GET` | `/v1/jobs/:id/logs` | last 64 KB of the job's output (`text/plain`) |
| `DELETE` | `/v1/jobs/:id` | cancel: the job fails and its machine is released |

Machine body:

| Field | |
|---|---|
| `provider` | `scaleway`, `vast`, `runpod` or `cheapest` (default): the configured backend with the lowest quote under the cap, then the next one on a failure |
| `machineType` | Scaleway commercial type (`L4-1-24G`, `DEV1-S`), Vast GPU name (`RTX 4090`), RunPod GPU type id |
| `maxUsdPerHour` | required, ≤ `MACHINES_MAX_USD_PER_HOUR` |
| `maxHours` | **required**: the hard deadline, ≤ `MACHINES_MAX_HOURS` |
| `idleMinutes` | released when no `extend` came for this long (default `MACHINES_IDLE_MINUTES`, ≥ 5); jobs have none |
| `image` | Docker image (required on Vast/RunPod: the container itself; on Scaleway run with `--network host` after boot) |
| `diskGb` | default 40 |
| `ports` | `[{ "protocol": "tcp", "port": n, "to"?: m }]` (`tcp` or `udp`), at most 64 ports in all |
| `sshPublicKey` | the caller's public key, written to `/root/.ssh/authorized_keys`; opens 22/tcp |
| `onstart` | bash run as root once the host is up (machines only) |
| `env` | container environment; values never come back (only `envKeys`) |
| `zone` / `near` | Scaleway zone (default `fr-par-2`) / Vast country preference |
| `holder` | the agent inside the owner (its own 24 h cap) |

Job body adds `command` (bash), `inputs` (`[{ "url": "https://…signed", "path": "in/x" }]`, downloaded under `/job`)
and `output` (`{ "url": "https://…signed PUT", "path": "out" }`: `out` is tarred and PUT there). The machine reports
to `POST /v1/job-report` (public route, authenticated by a per-job token only the machine has) every 60 s and at the
end; success, failure or the deadline release the machine. Jobs need `AIGW_PUBLIC_URL` (or Railway's domain).

Limits, all refused before anything is rented:

| Limit | Env (default) | Answer |
|---|---|---|
| lease | `MACHINES_MAX_HOURS` (24), `MACHINES_MAX_LIFETIME_HOURS` (72, extends included) | `400` |
| price | `MACHINES_MAX_USD_PER_HOUR` (2) | `400` |
| machines running | `MACHINES_MAX_RUNNING` (20) | `429` |
| owner per 24 h / per month | `MACHINES_OWNER_USD_PER_DAY` (10) / `MACHINES_OWNER_USD_PER_MONTH` (150) | `402` |
| holder per 24 h | `MACHINES_HOLDER_USD_PER_DAY` (6) | `402` |
| gateway per 24 h | `MACHINES_USD_PER_DAY` (20) | `402` |

A cap counts what was spent in the window, plus what running leases would cost until their deadline, plus the new
request at its `maxUsdPerHour × maxHours`, so a cap cannot be passed later by machines already running. `0` turns a cap
off. The `402` message says which cap, the numbers, and what to do (release, fewer hours, lower price, or which env to
raise). Never in an answer: `env` values, `onstart`, the SSH key, signed input/output URLs (only the output host), the
job token.

---

## Keys at runtime

The palco (`SANDBOX_ENV_URL`, default `https://parle-palco.up.railway.app/api/sandbox-env`, Bearer
`SANDBOX_TOKEN`) is the single home of the provider keys. Its values **win** over the service environment
(Railway variables), except for host settings that always stay in the environment: `SANDBOX_TOKEN` and its
aliases, `PORT`, `NODE_ENV`, `GATEWAY_API_KEYS`, `HOSTNAME`, `RAILWAY_*` and every endpoint override (`*_URL`,
`*_BASE`, `*_HOST`, `*_HOSTNAME`, `*_ENDPOINT`). `DEPLOYMENTS_NAMESPACE`, `DEPLOYMENTS_STATE_DIR`,
`DEPLOYMENTS_ENABLED`, `RAILWAY_*` and the provider API bases (`*_BASE`, `*_BASE_URL`, e.g. `OPENROUTER_API_BASE`)
are never read from the palco at all: a remote value there would send every request, with the provider key and the
users' audio and text, to another host.

The gateway re-reads the palco every 5 minutes. Providers read their key on every request, and a reload that
changes a key re-mounts the providers in place: a provider that gained a key starts serving (and appears in
`/v1/models`), one that lost it leaves the chains. A failed reload keeps the current keys.

### `POST /v1/admin/keys/reload` (admin)

Re-reads the palco now.

```json
{ "ok": true, "changed": ["OPENROUTER_API_KEY"], "removed": [], "errors": [] }
```

`502` with `ok: false` when the palco did not answer (current keys kept).

### `PUT /v1/admin/keys` (admin)

Stores keys on the palco (`PUT <palco>/api/sandbox-env`), then reloads. Body `{ "NAME": "value", … }`; responses
contain names only.

```json
{ "written": ["OPENROUTER_API_KEY"], "reloaded": true, "changed": ["OPENROUTER_API_KEY"], "removed": [] }
```

`400` for protected names (`SANDBOX_TOKEN` and aliases, `PORT`, `*_URL`, `*_BASE`, `*_HOST`, `*_ENDPOINT`, …) or
malformed input; `502` when the
palco refuses the write.

Machine credentials (`SCW_SECRET_KEY`, `SCW_PROJECT_ID`, `SCW_REGISTRY_SECRET_KEY`, `VAST_API_KEY`) follow the same
path: a reload that changes one validates it with a read-only call to the provider (Scaleway: list the deployment
tags; Vast: `GET /users/current/`) and swaps it inside the running backend — replicas, host reputation and creates in
flight are untouched. A refused key is put back to the previous value in the environment (the backend keeps working
with it), logged as an error and in the audit (`deployment-credentials.rotate`, `ok: false`), and retried at the next
reload. A provider that had no key at boot (no backend yet) still needs a restart to be enabled.

## Access at runtime — `/v1/admin/access/*`

Client keys, admin users, the `SANDBOX_TOKEN` and the replica secrets change without a deploy. All these routes
(and `/v1/admin/keys*`) need an admin key, are rate-limited to 30 requests per minute per key (`429` with
`Retry-After`), answer `Cache-Control: no-store`, errors as `{"error": {"message", "type"}}`, and every change goes to the audit (who, when, which names —
never a value). State lives in `DEPLOYMENTS_STATE_DIR/access.json` (atomic write, last good copy in `.bak`, mode
0600; keys stored as HMAC-SHA256 only) and `key-audit.jsonl`.

The keys of `GATEWAY_API_KEYS` keep working until revoked through the API; an admin is a user of
`DEPLOYMENTS_ADMIN_USERS` until the list is replaced through the API.

### `GET /v1/admin/access/keys` (admin)

```json
{ "keys": [
  { "id": "env-parle", "source": "env", "user": "parle", "admin": false, "prefix": "pk_1", "label": null,
    "createdAt": null, "lastUsedAt": "2026-10-10T09:00:00.000Z", "expiresAt": null, "revokedAt": null, "active": true },
  { "id": "key-9b1c…", "source": "issued", "user": "site", "admin": false, "prefix": "aigw_Xy3k", "label": "site prod",
    "createdAt": "2026-10-10T09:01:00.000Z", "lastUsedAt": null, "expiresAt": null, "revokedAt": null, "active": true }
] }
```

Never the value: only the id (`env-<user>` for `GATEWAY_API_KEYS` entries, numbered `-2`, `-3`… when a user has
several, in their order; `key-…` derived from the HMAC for issued keys), a short prefix, owner and dates. `lastUsedAt` has minute
resolution.

### `POST /v1/admin/access/keys` (admin)

Issues a key. Body `{ "user": "site", "label"?: "…", "admin"?: true, "replaces"?: "<id>", "overlapMinutes"?: 30 }`.
`201` with `{ "key": "aigw_…", …the listing fields…, "replaced": {…} | null }` — **the only response that carries a
secret**, once, at creation; it is never stored in clear (HMAC-SHA256 only). `admin: true` adds `user` to the admin list. `replaces`
rotates a key (env or issued): the new key takes that key's user unless `user` is given, and the old key stops
working at once (`overlapMinutes` 0 or absent) or after the overlap (max 10080 min = 7 days).

### `PUT /v1/admin/access/keys/policy` (admin)

GPU policy of one client key (two roles, 10/10/2026: only an admin changes it). Body `{ "id": "<key id>",
"autoWake"?: bool, "canStartGpu"?: bool, "gpuDailyEur"?: number | null, "startIdleMinutes"?: 1–240 }`; omitted
fields keep their value. Defaults: `autoWake: false` (a call never turns a GPU on), `canStartGpu: false`,
`gpuDailyEur: 5` (EUR per UTC day spent by GPUs this key started; `null` = no cap), `startIdleMinutes: 10`. The
dev token's id is `sandbox`. `GET /v1/admin/access/keys` shows each key's `policy`; a rotation (`replaces`) carries
it to the new key. Spend and running starts: `clientGpu` in `GET /health?details=1` (admin: every key; a client
key: its own).

### `POST /v1/admin/access/keys/revoke` (admin)

Body `{ "id": "<id>" }`. Effective on the next request; persisted. `404` for an unknown id.

### `GET` / `PUT /v1/admin/access/admins` (admin)

`GET` → `{ "users": ["ops", …] }`. `PUT { "users": [...] }` replaces the admin list (it then wins over
`DEPLOYMENTS_ADMIN_USERS`). The caller must stay in the list (`400` otherwise: no locking yourself out).

### `PUT /v1/admin/access/sandbox-token` (admin)

Body `{ "token": "<new SANDBOX_TOKEN>", "overlapMinutes"?: 60 }`. The gateway first fetches the palco with the new
token; if the palco refuses it, `400` and nothing changes (the gateway never locks itself out). Then it uses the new
token for every palco call, accepts the previous one as a master token during the overlap, and stores the new one in
`access.json` so a restart keeps it (if the palco refuses the stored token at boot, the environment token is used).
Response `{ "rotated": true, "overlapUntil": "…" | null }`.

### `POST /v1/admin/access/replica-secrets/rotate` (admin)

Body `{ "deployment"?: "<name>" }` (absent = every deployment). Issues a new deployment secret: replicas created from
now on get tokens (`X-Aigw-Token`, realtime session signing key, boot-file signatures, edge telemetry HMAC) derived
from it. Live replicas keep the secret their token came from until they are released, so open realtime sessions and
boots in progress are not cut. Response `{ "rotated": [{ "deployment": "speech", "pinnedReplicas": 2 }] }`. The edge
reads its token once at boot, so a live replica cannot take a new token: to move it, let it be replaced
(scale-down / park).

### `GET /v1/admin/access/audit?limit=100` (admin)

Last changes, newest first (≤ 500 kept in memory, all in `key-audit.jsonl`):

```json
{ "entries": [{ "at": "2026-10-10T09:02:00.000Z", "actor": "ops", "action": "access.keys.revoke", "names": ["key-9b1c…"], "ok": true }] }
```

`actor` is the admin user, or `palco-reload` for keys applied by the periodic reload.

---

## Diagnostics

### `GET /health`

Cheap liveness check, **no auth**, and nothing else (used by Railway's healthcheck, the external reaper and the SDK
breaker; always `200` while the process is up):

```json
{ "status": "ok", "version": "bf909f7a1b2c", "uptimeSeconds": 5321 }
```

`version` is `GATEWAY_VERSION`, else the first 12 characters of `RAILWAY_GIT_COMMIT_SHA`, else `null`. Since
2026-10-07 the public answer no longer carries the stage chains, deployment names, missing variable names or
counters: those moved to `?details=1` (API audit).

### `GET /health?details=1` (any key)

The **effective chain of every stage** and the state of each link, so a primary that never serves is visible (no
upstream call). An app key sees only the chains of its own aliases (and the warnings about them); an admin key sees
every chain plus the gateway-wide counters (`connections`, `sttFilter`, `noWake`). No key → `401`.

```json
{
  "status": "ok", "version": "bf909f7a1b2c", "uptimeSeconds": 5321,
  "connections": { "active": 1, "peak": 3 }, "noWake": { "skips": 0 },
  "stages": {
    "stt": { "parle-stt": { "serving": "openrouter:openai/whisper-large-v3-turbo", "onFallback": true, "links": [
      { "target": "deployment:parle-speech", "state": "pending", "reason": "SPEECH_IMAGE is not set and the declaration has no default image" },
      { "target": "openrouter:openai/whisper-large-v3-turbo", "state": "ready" },
      { "target": "groq:whisper-large-v3-turbo", "state": "no_key", "reason": "groq: GROQ_API_KEY is not set" } ] } },
    "tts": { "parle-tts": { "serving": "openrouter:hexgrad/kokoro-82m", "onFallback": true, "links": [
      { "target": "deployment:parle-speech", "state": "cold", "reason": "scaled to zero (starts on the next request)" },
      { "target": "openrouter:qwen/qwen-audio-3.0-tts-flash", "state": "blocked", "reason": "openrouter:qwen/qwen-audio-3.0-tts-flash: refused by the provider account's data policy (ZDR) — skipped until …" },
      { "target": "openrouter:hexgrad/kokoro-82m", "state": "ready" } ] } }
  },
  "warnings": ["stt parle-stt: primary deployment:parle-speech is pending (SPEECH_IMAGE is not set …) — serving from openrouter:openai/whisper-large-v3-turbo"]
}
```

Link states: `ready`, `cold` (deployment scaled to zero / starting — requests fall back at once and wake it), `paused`,
`pending` (declared deployment not registered yet, with the missing credential/image), `missing` (deployment does not
exist: every request falls back with `not_configured`), `disabled` (no `SCW_SECRET_KEY`), `no_key`, `blocked`
(account data policy), `circuit_open`. `warnings` has one line per chain whose first link is neither `ready` nor
`cold`.
`noWake.skips`: deployment targets skipped (and invokes refused) by no-wake requests since the process started.

#### `balances` (admin only) — provider balances and email alerts

An admin also gets `balances` (`src/telemetry/balance-watch.ts`): every `BALANCE_CHECK_MINUTES` (default 15; `0`
turns it off) the gateway reads, with the keys it already has and only GET-style calls, the Vast credit
(`/users/current/`) and the hourly price of **every running instance of the account** (`/instances/`, so machines
started outside the gateway count too), the OpenRouter credit left (`/api/v1/credits`, else the key's
`limit_remaining`) and the key's `expires_at` (`/api/v1/key`), the RunPod `clientBalance` and `currentSpendPerHr`,
and for Scaleway the gateway's own estimate (EUR/h of its running Scaleway replicas, month spend against the summed
`scaling.budget.eurPerMonth` of the deployments): the restricted key `aigw-machines` gets `403` from the billing API.
No secret is in the block; a provider without a key is absent.

```json
"balances": { "intervalMinutes": 15, "thresholds": { "warnUsd": { "vast": 5, "openrouter": 5, "runpod": 0 }, "…": "…" },
  "readings": [ { "provider": "vast", "level": "warn", "balanceUsd": 9.92, "burnPerHour": 1.1, "currency": "USD",
    "hoursLeft": 9, "keyExpiresAt": null, "reasons": ["com o gasto atual de US$ 1.10/h o saldo acaba em ~9.0 h"],
    "error": null, "checkedAt": "2026-10-10T13:00:00.000Z" } ] }
```

`level`: `ok`, `warn`, `urgent`, or `error` (provider unreachable: shown, no email). Thresholds (env, defaults):

| Variable | Default | Level |
|---|---|---|
| `BALANCE_VAST_WARN_USD` / `BALANCE_VAST_URGENT_USD` | 5 / 2 | Vast credit below → warn / urgent |
| `BALANCE_OPENROUTER_WARN_USD` / `BALANCE_OPENROUTER_URGENT_USD` | 5 / 1 | OpenRouter credit below |
| `BALANCE_RUNPOD_WARN_USD` / `BALANCE_RUNPOD_URGENT_USD` | 0 / 0 (off: account unused) | RunPod balance below |
| `BALANCE_HOURS_LEFT_WARN` / `BALANCE_HOURS_LEFT_URGENT` | 12 / 3 | balance ÷ current burn below N hours |
| `BALANCE_KEY_EXPIRY_DAYS` | 7 | key expires within N days → warn (≤ 1 day or expired → urgent) |
| `BALANCE_MONTH_WARN_RATIO` | 0.8 | Scaleway month spend ≥ 80 % of the ceiling → warn, ≥ 100 % → urgent |

A `401`/`403` from a provider is **urgent** (“recusou a chave”).

**Email.** With `RESEND_API_KEY` and `ALERT_EMAIL_TO` (comma-separated list; `MAIL_FROM` optional, all three from the
dev API) the gateway emails, through Resend, in Portuguese with the number and what to do: every `warn`/`urgent`
balance reading above, and the ops alerts also sent to `ALERT_WEBHOOK_URL` — `provider.credit_exhausted`,
`replica.lost_with_sessions`, `stage.no_link` (urgent), `deployment.create_failed`, `deployment.out_of_stock`,
`stage.reserve_down` (warn). Dedup per kind: a warn at most once per 6 h, an urgent once per hour, and a warn that
becomes urgent goes out at once. `ALERT_DAILY_DIGEST=<UTC hour 0–23>` adds one summary of every reading per day, at
the first check after that hour. Subject and body pass a redaction of every `*KEY*`/`*TOKEN*`/`*SECRET*` value of the
environment; a failing email provider is logged (`alert email failed`) and changes nothing else. Balance alerts also
go to `ALERT_WEBHOOK_URL` as `balance.warn` / `balance.urgent`. Test send: `bun scripts/alert-email-test.ts`.

### `GET /health?deep=1` (admin)

Live probe of every provider key (no credits used: OpenRouter is checked through `/api/v1/key`, which rejects a
revoked key), circuit-breaker states, mounted models and deployments. Never contains a key value. `401` without a
key, `403` with a valid non-admin key.

```json
{
  "status": "degraded",
  "providers": [
    { "provider": "groq", "configured": false, "ok": false, "error": "GROQ_API_KEY is not set" },
    { "provider": "openrouter", "configured": true, "ok": true, "latencyMs": 120 }
  ],
  "circuits": { "deployment:parle-speech": { "state": "closed", "failures": 0 } },
  "models": { "chat": ["parle-llm"], "stt": ["parle-stt"], "tts": ["parle-tts"], "unavailable": {} },
  "stages": { "…": "same as GET /health?details=1" }, "warnings": [],
  "declared": [{ "name": "parle-speech", "state": "in_sync", "reason": null, "image": "ghcr.io/marcosremar/parle-speech:<sha>" }],
  "deployments": { "deployments": 2, "replicas": 1, "listError": null,
    "items": [{ "name": "parle-qwen-tts", "status": "ready", "replicas": 1, "ready": 1, "lastError": null }] }
}
```
