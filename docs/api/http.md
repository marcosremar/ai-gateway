# HTTP API Reference

This page documents the production entry point, `bun serve.ts` (the image built by `Dockerfile.production` and
deployed by `railway.json`, default port `4000`). The larger reference server in `server/` mounts more routes
(`/v1/speech`, `/v1/gpu/*`, `/v1/request-log`, …); those are **not** available on `serve.ts`.

::: warning Blocked transports
WebSocket (`/ws/stream`) and WebRTC return `410 Gone`. Streaming is supported via SSE on `POST /v1/chat/completions` with `stream: true`. All other client code must use the JSON endpoints below.
:::

::: tip Client
Apps call these routes through `GatewayClient` (`@parle/ai-gateway/client`): see [Gateway client](./client.md).
`GatewayHttpClient` is the legacy client of the old `server/` routes.
:::

## Authentication

All endpoints (except `GET /health`) require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" ...
```

Set `GATEWAY_API_KEYS` on the server (comma-separated; `key:user` names the user). When no key is configured, only
localhost requests are allowed. The `SANDBOX_TOKEN` (and its aliases) is **not** a client key: it is the dev API's
master key, which the gateway uses only to fetch its own provider keys from the palco, and it gets `401` here (owner
decision 06/10/2026). `ACCEPT_SANDBOX_TOKEN_AS_KEY=1` (transition only, default off, logs a `WARNING`) accepts it
again as the admin user `sandbox`, until every client sends its own key.

**Admin keys** — the users in `DEPLOYMENTS_ADMIN_USERS`. When that list is empty, no key is admin (fail closed since 06/10/2026; the boot logs a `WARNING`). Admin keys are required for deployment
mutations, `X-App`, `GET /health?deep=1` and `/v1/admin/keys*`.

**App keys** (any non-admin key; its user id is its app) are limited so a leaked one costs little:

- **Models**: only the aliases of its own app (`PUT /v1/apps/:app/routes`), per stage — no `org/model` passthrough,
  no embeddings or images. Anything else → `403 permission_error`, before any provider is called.
- **`max_tokens`** (chat): clamped to `APP_MAX_TOKENS` (default `1024`); a request without one gets the cap.
- **Daily budget** per app (UTC day, in memory): `APP_DAILY_REQUESTS` (default `5000`) requests and
  `APP_DAILY_TOKENS` (default `2000000`) estimated tokens (prompt characters / 4 + `max_tokens` for chat, input
  characters / 4 for TTS). Over → `429 budget_exceeded` with `Retry-After` until 00:00 UTC. `0` turns one off.
- **Routes**: `PUT /v1/apps/:app/routes` with the app's own key may reorder, drop or re-alias the targets its routes
  already have (set by an admin) and add the app's own deployments; any new target → `403`.
- **Deployments**: `…/invoke` only on its own app's deployments (`403` otherwise).

## Rate Limiting

Optional per-user token bucket (`RATE_LIMIT_RPM`, off when unset or `0`). When on, responses carry
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; a limited request gets `429` with
`Retry-After`.

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
| Whole stage (deployment + fallbacks + hedge) | 8 s | `GATEWAY_STT_BUDGET_MS`, `GATEWAY_CHAT_BUDGET_MS`, `GATEWAY_TTS_BUDGET_MS` |

Every attempt is aborted when its time is up (a replica lease is released at once), and no attempt outlives the
stage budget: the answer — or the `503` — arrives within **8 s** per stage. Set the client deadlines above that
with margin (parle: TTS 15 s, chat 12 s are fine; ≥ 10 s recommended). With hedging, a slow or recovering
deployment costs at most ~1.5 s before the fallback is on its way; the first answer wins and the other call is
aborted (`X-Gateway-Fallback: slow`). Hedging can bill the fallback for requests the deployment would have served a
bit later — raise `DEPLOYMENT_HEDGE_MS` to trade latency for cost. For TTS, "first byte" of a non-streamed format
(`mp3`) is the whole synthesis on vLLM-Omni; ask for `wav` to get the audio streamed.

Circuit breaker: 5 consecutive real failures open the circuit for 30 s; the next request then probes the deployment,
with the fallback hedged in, so the probe never makes the client wait the full timeout. `cold` / `paused` /
`voice_not_found` / `catalog_unavailable` never count: as soon as the replica is ready, traffic goes back to it. A **cold deployment** (no ready replica) is not waited
for: the gateway starts scaling it up and answers from the fallback in the same call; once a replica is ready,
traffic returns to it. A real client error (e.g. `400` invalid request) is returned as is.

### No-wake mode — `X-Gateway-No-Wake: 1` / `GATEWAY_NO_WAKE_USERS`

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
idles out on its own schedule. `GET /health` counts the skips: `"noWake": {"skips": N}`.

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
  (boot, routes PUT, key reload, a declared deployment registered); `/health` shows the effective target and the
  boot log lists it under `oneGpu`.
- `voices: {feminine, masculine}` (TTS; capability, not in the parle's chain, which is MAI-Voice → Kokoro): a fallback that cannot clone speaks a stock voice of the **gender** of the
  requested voice (`src/config/tts-fallback-voices.ts`). The gender comes from the entry's `voiceGenders`
  (`{"pt-PT-1baab6": "masculine", …}`, the app's cast), the `xx-f-`/`xx-m-` slug, or the gender letter of a Kokoro
  `fallback_voice` (`pf_…`/`pm_…`); default feminine. With `preferFallbackVoice: true` the request's `fallback_voice`
  wins over the table. Known stock voices: Qwen-Audio `Cherry`/`Ethan`, Kokoro `pf_dora`/`pm_alex`.
- `accountPolicyGuard: true` (TTS): **account data policy**. With Zero Data Retention on the OpenRouter account,
  some models (e.g. Qwen-Audio, a DashScope endpoint) are refused (`404 … data policy / ZDR violation`). The first refusal takes that link
  out of the chain for 30 min (code `policy`, `X-Gateway-Fallback: policy`): later requests go to the next link without
  calling it, the refusal does not open the OpenRouter breaker that the next link may share, and `/health` shows the
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
- Any other body field (`task_type`, `ref_audio`, `ref_text`, `language` — ISO codes become `Portuguese`/`French`/… —,
  `stream_format`, …) is forwarded intact. The OpenRouter fallback never receives these fields.
- With `response_format` `wav` or `pcm` the audio is **streamed** from the replica to the client
  (`stream: true, stream_format: "audio"`; send `"stream": false` to turn it off). Other formats come whole.

```json
{ "model": "parle-tts", "input": "Bom dia!", "voice": "br-f-01", "fallback_voice": "pf_dora", "response_format": "wav" }
```

Built-in cloud models keep their own chains: Groq chat models fall back to the same weights on OpenRouter
(`llama-3.3-70b-versatile` → `meta-llama/llama-3.3-70b-instruct`, `openai/gpt-oss-120b` → same id, …), GLM models
go Z.AI → OpenRouter `z-ai/<id>`, `whisper-large-v3(-turbo)` goes Groq → OpenRouter → OpenAI → Fireworks →
Deepgram, Orpheus TTS is Groq only. Any other `org/model` id goes to OpenRouter as-is,
followed by the generic chat fallback; without a usable OpenRouter key it answers `503 provider_unavailable`
naming the key (not `404`). PlayAI TTS was retired by Groq and is no longer offered.

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

**Which deployment and models** (the gateway names no app's): `"deployment": "parle-speech"` is the speech-stack
primary (default `S2S_DEPLOYMENT`; none = composed pipeline only) and `"models": {"stt": "parle-stt", "chat":
"parle-llm", "tts": "parle-tts"}` the stage models of the composed pipeline. Without `config.models` the gateway uses `S2S_STT_MODEL` /
`S2S_CHAT_MODEL` / `S2S_TTS_MODEL` when set (no default value), else the calling app's own route aliases
(`PUT /v1/apps/:app/routes`: the app that owns `config.deployment`, else the caller's app; per stage the alias whose
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
`sentence` {text} then its audio · `audio_format` {encoding, sample_rate} when it changes · `first_audio` {at_ms} ·
`done` {reply, transcript, first_audio_ms, total_ms, missing_audio?, partial?}. `sentence_failed` = that sentence has no
audio (the rest continues); `error` {stage?, partial?} = the turn stopped (`partial: true` → what was sent is valid).

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
| response header `X-STT-Filtered` | reason codes, comma separated (`no_speech_prob`, `compression_ratio`, `avg_logprob`, `blocklist`, `blocklist_corroborated`); never transcript text. Also set when only some segments were trimmed |
| response header `X-STT-Raw-Length` | length in characters of what the provider returned |
| multipart field `filter_hallucinations=false` | per-request opt-out (QA); `0`/`off` also accepted. Such answers are cached apart from filtered ones |
| `language` | `pt`, `pt-BR` or `Portuguese` (codes and English/native names). Without it only the high-confidence phrases apply |
| `response_format=verbose_json` | `language`, `duration` and the kept `segments` are returned next to `text` |
| env `STT_HALLUCINATION_FILTER=0` | turns the filter off for the whole gateway |
| env `STT_FILTER_NO_SPEECH_PROB` (0.6), `STT_FILTER_AVG_LOGPROB` (-1.0), `STT_FILTER_COMPRESSION_RATIO` (2.4), `STT_FILTER_AMBIGUOUS_NO_SPEECH_PROB` (0.4) | thresholds, no deploy of code needed (design choices to pilot) |

A filtered (empty) answer is never cached. `GET /health` carries `sttFilter` (`answered`, `filtered`, `partial`,
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

Docker image → autoscaled replicas on Scaleway machines. Enabled when `SCW_SECRET_KEY` is set. Mutations need an
admin key.

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
| `POST` | `/v1/deployments/:name/wake` | start replicas now (pre-warm) |
| any | `/v1/deployments/:name/invoke/<path>` | forwarded to a ready replica as `/<path>`; waits through a cold start (`X-Aigw-Wait: <seconds>` caps it; `X-Gateway-No-Wake: 1` → 503 `cold` at once instead). Raw passthrough: the STT hallucination filter does NOT apply here (use `/v1/audio/transcriptions` or `/v1/s2s`) |
| `GET` | `/v1/profiles` | built-in + stored profiles (`qwen3-tts`, `qwen3-tts-clone`, `cpu-echo`, …) |
| `PUT` / `DELETE` | `/v1/profiles/:name` | store / delete a profile |

`invoke` is the raw passthrough; the OpenAI routes above use the same replicas with fallback and without waiting
for a cold start.

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

---

## Diagnostics

### `GET /health`

Cheap liveness check, no auth (used by Railway's healthcheck; always `200` while the process is up). It also shows
the **effective chain of every parle stage** and the state of each link, so a primary that never serves is visible
(no upstream call, no secret):

```json
{
  "status": "ok", "connections": { "active": 1, "peak": 3 }, "noWake": { "skips": 0 },
  "stages": {
    "stt": { "parle-stt": { "serving": "openrouter:openai/whisper-large-v3-turbo", "onFallback": true, "links": [
      { "target": "deployment:parle-speech", "state": "pending", "reason": "GHCR_READ_TOKEN is not set (registry credential for ghcr.io)" },
      { "target": "openrouter:openai/whisper-large-v3-turbo", "state": "ready" },
      { "target": "groq:whisper-large-v3-turbo", "state": "no_key", "reason": "groq: GROQ_API_KEY is not set" } ] } },
    "tts": { "parle-tts": { "serving": "openrouter:hexgrad/kokoro-82m", "onFallback": true, "links": [
      { "target": "deployment:parle-speech", "state": "cold", "reason": "scaled to zero (starts on the next request)" },
      { "target": "openrouter:qwen/qwen-audio-3.0-tts-flash", "state": "blocked", "reason": "openrouter:qwen/qwen-audio-3.0-tts-flash: refused by the provider account's data policy (ZDR) — skipped until …" },
      { "target": "openrouter:hexgrad/kokoro-82m", "state": "ready" } ] } }
  },
  "warnings": ["stt parle-stt: primary deployment:parle-speech is pending (GHCR_READ_TOKEN is not set …) — serving from openrouter:openai/whisper-large-v3-turbo"]
}
```

Link states: `ready`, `cold` (deployment scaled to zero / starting — requests fall back at once and wake it), `paused`,
`pending` (declared deployment not registered yet, with the missing credential/image), `missing` (deployment does not
exist: every request falls back with `not_configured`), `disabled` (no `SCW_SECRET_KEY`), `no_key`, `blocked`
(account data policy), `circuit_open`. `warnings` has one line per chain whose first link is neither `ready` nor
`cold`.
`noWake.skips`: deployment targets skipped (and invokes refused) by no-wake requests since the process started.

### `GET /health?deep=1` (admin)

Live probe of every provider key (no credits used: OpenRouter is checked through `/api/v1/key`, which rejects a
revoked key), circuit-breaker states, mounted models and deployments. Never contains a key value. `401` without an
admin key.

```json
{
  "status": "degraded",
  "providers": [
    { "provider": "groq", "configured": false, "ok": false, "error": "GROQ_API_KEY is not set" },
    { "provider": "openrouter", "configured": true, "ok": true, "latencyMs": 120 }
  ],
  "circuits": { "deployment:parle-speech": { "state": "closed", "failures": 0 } },
  "models": { "chat": ["parle-llm"], "stt": ["parle-stt"], "tts": ["parle-tts"], "unavailable": {} },
  "stages": { "…": "same as GET /health" }, "warnings": [],
  "declared": [{ "name": "parle-speech", "state": "in_sync", "reason": null, "image": "ghcr.io/marcosremar/parle-speech:<sha>" }],
  "deployments": { "deployments": 2, "replicas": 1, "listError": null,
    "items": [{ "name": "parle-qwen-tts", "status": "ready", "replicas": 1, "ready": 1, "lastError": null }] }
}
```
