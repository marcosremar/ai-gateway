# HTTP API Reference

This page documents the production entry point, `bun serve.ts` (the image built by `Dockerfile.production` and
deployed by `railway.json`, default port `4000`). The larger reference server in `server/` mounts more routes
(`/v1/speech`, `/v1/gpu/*`, `/v1/request-log`, …); those are **not** available on `serve.ts`.

::: warning Blocked transports
WebSocket (`/ws/stream`) and WebRTC return `410 Gone`. Streaming is supported via SSE on `POST /v1/chat/completions` with `stream: true`. All other client code must use the JSON endpoints below.
:::

## Authentication

All endpoints (except `GET /health`) require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" ...
```

Set `GATEWAY_API_KEYS` on the server (comma-separated; `key:user` names the user). `SANDBOX_TOKEN` is also
accepted, as the `sandbox` user. When no key is configured, only localhost requests are allowed.

**Admin keys** — the `sandbox` user plus the users in `DEPLOYMENTS_ADMIN_USERS` (when that list is empty, every
key is admin). Admin keys are required for deployment mutations, `GET /health?deep=1` and `/v1/admin/keys*`.

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

### Aliases for the parle client

| Model (alias) | Route | Chain |
|---|---|---|
| `parle-stt` | `/v1/audio/transcriptions` | `deployment:$SPEECH_DEPLOYMENT` (whisper-large-v3-turbo) → `openrouter:openai/whisper-large-v3-turbo` → `groq:whisper-large-v3-turbo` |
| `parle-llm` | `/v1/chat/completions` | `deployment:$SPEECH_DEPLOYMENT` (Qwen3.5-9B) → `openrouter:qwen/qwen3.5-9b` → `openrouter:google/gemini-2.5-flash-lite` (both with `reasoning: {enabled: false}`) |
| `parle-tts`, `qwen/qwen3-tts` | `/v1/audio/speech` | `deployment:$TTS_DEPLOYMENT` (Qwen3-TTS Base, voice cloning; `TTS_DEPLOYMENT_MODEL`, default `Qwen/Qwen3-TTS-12Hz-0.6B-Base`) → `openrouter:hexgrad/kokoro-82m` (voice `pf_dora`) |

`SPEECH_DEPLOYMENT` defaults to `parle-speech` (the image with Whisper + Qwen3.5-9B + Qwen3-TTS on one GPU) and
`TTS_DEPLOYMENT` (or `QWEN_TTS_DEPLOYMENT`) to `parle-qwen-tts`. The replica must expose the OpenAI shapes
(`/v1/audio/transcriptions`, `/v1/chat/completions`, `/v1/audio/speech`).

Voices are provider-specific: on `/v1/audio/speech`, `voice` goes to the first provider and a fallback uses
`fallback_voice` from the request, else its own configured voice.

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

### Changing the map — `MODEL_ROUTES`

A JSON env var adds or replaces chains (same model = replaced). Entries: `"provider"`, `"provider:upstreamModel"`,
`"deployment:<name>[:upstreamModel]"`, or `{"provider", "model", "voice", "deployment", "extraBody"}` (`extraBody`:
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
| `X-Gateway-Provider` | `deployment:parle-qwen-tts`, `openrouter:hexgrad/kokoro-82m` | who answered (`deployment:<name>` or `<provider>:<upstream model>`) |
| `X-Gateway-Fallback` | `cold` | only when the first target of the chain did not answer (two targets of the same provider count as different): `cold`, `paused`, `5xx`, `timeout`, `slow`, `unreachable`, `empty`, `voice_not_found`, `catalog_unavailable`, `auth`, `credit`, `rate_limited`, `not_found`, `not_configured`, `circuit_open`, `cooldown`, `error` |
| `X-Gateway-Fallback-From` | `deployment:parle-speech` | the provider that was left behind |

Streaming chat (`stream: true`) falls back only before the first token, so the headers are final.
An STT answer served from the gateway's 5-minute cache (same audio, model, language and format) carries
`X-Gateway-Provider: cache` and `X-Cache: HIT`; it still wakes a cold primary deployment for the next turn.

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
| speech-stack deployment ready (`S2S_DEPLOYMENT`, default `SPEECH_DEPLOYMENT` / `parle-speech`) | its own `/v1/s2s`: STT + LLM + TTS on one GPU (0.4–0.8 s to first audio measured) | `deployment:parle-speech` |
| deployment cold / paused / absent | woken for the next turns; this turn by the **composed pipeline**: `parle-stt` → streamed `parle-llm` → `parle-tts` per sentence, each stage with its own chain, hedge and breaker (above) | `composite`, `fallback: cold\|paused\|not_found` |
| deployment has not sent the transcript after `S2S_HEDGE_MS` (2.5 s) | composed pipeline in parallel; first to produce audio wins, the other is aborted | `composite`, `fallback: slow` |
| deployment breaks after the transcript, before audio | composed pipeline resumes at the LLM with that transcript (no second STT) | `composite`, `fallback: resumed` |
| deployment breaks after audio started | in-band `error` (`partial: true`) and `done` | — |
| nothing can answer before the first byte | `503 provider_unavailable` (JSON, as the other routes) | — |

Whole turn budget: `S2S_BUDGET_MS` (45 s). The composed pipeline calls this gateway's own routes over loopback with the
caller's key (stage models: `S2S_STT_MODEL` / `S2S_CHAT_MODEL` / `S2S_TTS_MODEL`, default the parle aliases).

## OpenAI-compatible routes

### `POST /v1/audio/transcriptions`

```bash
curl -X POST https://<gateway>/v1/audio/transcriptions -H "Authorization: Bearer $KEY" \
  -F "file=@audio.wav" -F "model=parle-stt" -F "language=pt"
```

```json
{ "text": "Bom dia" }
```

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
| any | `/v1/deployments/:name/invoke/<path>` | forwarded to a ready replica as `/<path>`; waits through a cold start (`X-Aigw-Wait: <seconds>` caps it) |
| `GET` | `/v1/profiles` | built-in + stored profiles (`qwen3-tts`, `qwen3-tts-clone`, `cpu-echo`, …) |
| `PUT` / `DELETE` | `/v1/profiles/:name` | store / delete a profile |

`invoke` is the raw passthrough; the OpenAI routes above use the same replicas with fallback and without waiting
for a cold start.

---

## Keys at runtime

The palco (`SANDBOX_ENV_URL`, default `https://parle-palco.up.railway.app/api/sandbox-env`, Bearer
`SANDBOX_TOKEN`) is the single home of the provider keys. Its values **win** over the service environment
(Railway variables), except for host settings that always stay in the environment: `SANDBOX_TOKEN` and its
aliases, `PORT`, `NODE_ENV`, `GATEWAY_API_KEYS`, `HOSTNAME`, `RAILWAY_*` and `*_URL`. `DEPLOYMENTS_NAMESPACE`,
`DEPLOYMENTS_STATE_DIR`, `DEPLOYMENTS_ENABLED` and `RAILWAY_*` are never read from the palco at all.

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

`400` for protected names (`SANDBOX_TOKEN` and aliases, `PORT`, `*_URL`, …) or malformed input; `502` when the
palco refuses the write.

---

## Diagnostics

### `GET /health`

Cheap liveness check, no auth (used by Railway's healthcheck).

```json
{ "status": "ok", "connections": { "active": 1, "peak": 3 } }
```

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
  "deployments": { "deployments": 2, "replicas": 1, "listError": null,
    "items": [{ "name": "parle-qwen-tts", "status": "ready", "replicas": 1, "ready": 1, "lastError": null }] }
}
```
