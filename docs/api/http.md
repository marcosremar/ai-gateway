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
401/402/403/404/429, 5xx, timeout or a dropped connection. A **cold deployment** (no ready replica) is not waited
for: the gateway starts scaling it up and answers from the fallback in the same call; once a replica is ready,
traffic returns to it. A real client error (e.g. `400` invalid request) is returned as is.

### Aliases for the parle client

| Model (alias) | Route | Chain |
|---|---|---|
| `parle-stt` | `/v1/audio/transcriptions` | `deployment:$SPEECH_DEPLOYMENT` (whisper-large-v3-turbo) → `openrouter:openai/whisper-large-v3-turbo` → `groq:whisper-large-v3-turbo` |
| `parle-llm` | `/v1/chat/completions` | `deployment:$SPEECH_DEPLOYMENT` (Qwen3.5-9B) → `openrouter:qwen/qwen3.5-9b` → `openrouter:qwen/qwen3.7-flash` |
| `parle-tts`, `qwen/qwen3-tts` | `/v1/audio/speech` | `deployment:$TTS_DEPLOYMENT` (Qwen3-TTS 1.7B CustomVoice) → `openrouter:hexgrad/kokoro-82m` (voice `pf_dora`) |

`SPEECH_DEPLOYMENT` defaults to `parle-speech` (the image with Whisper + Qwen3.5-9B + Qwen3-TTS on one GPU) and
`TTS_DEPLOYMENT` (or `QWEN_TTS_DEPLOYMENT`) to `parle-qwen-tts`. The replica must expose the OpenAI shapes
(`/v1/audio/transcriptions`, `/v1/chat/completions`, `/v1/audio/speech`).

Voices are provider-specific: on `/v1/audio/speech`, `voice` goes to the first provider and a fallback uses
`fallback_voice` from the request, else its own configured voice.

Built-in cloud models keep their own chains: Groq chat models fall back to the same weights on OpenRouter
(`llama-3.3-70b-versatile` → `meta-llama/llama-3.3-70b-instruct`, `openai/gpt-oss-120b` → same id, …), GLM models
go Z.AI → OpenRouter `z-ai/<id>`, `whisper-large-v3(-turbo)` goes Groq → OpenRouter → OpenAI → Fireworks →
Deepgram, Orpheus TTS is Groq only. Any other `org/model` id goes to OpenRouter as-is (only while its key is valid),
followed by the generic chat fallback. PlayAI TTS was retired by Groq and is no longer offered.

### Changing the map — `MODEL_ROUTES`

A JSON env var adds or replaces chains (same model = replaced). Entries: `"provider"`, `"provider:upstreamModel"`,
`"deployment:<name>[:upstreamModel]"`, or `{"provider", "model", "voice", "deployment"}`. The chat key `"*"`
replaces the generic chat fallback (default: Groq `llama-3.3-70b-versatile`, then OpenRouter
`meta-llama/llama-3.3-70b-instruct`).

```json
{
  "stt":  { "parle-stt": ["deployment:parle-speech:whisper-large-v3-turbo", "openrouter:openai/whisper-large-v3-turbo"] },
  "chat": { "parle-llm": ["deployment:parle-speech", "openrouter:qwen/qwen3.5-9b"] },
  "tts":  { "parle-tts": ["deployment:parle-qwen-tts:Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
                          { "provider": "openrouter", "model": "fish-audio/s2-pro", "voice": "<voice id>" }] }
}
```

### Where an answer came from

Every successful response of the three routes carries (no secrets):

| Header | Example | Meaning |
|---|---|---|
| `X-Gateway-Provider` | `deployment:parle-qwen-tts`, `openrouter:hexgrad/kokoro-82m` | who answered (`deployment:<name>` or `<provider>:<upstream model>`) |
| `X-Gateway-Fallback` | `cold` | only when the first provider of the chain did not answer: `cold`, `paused`, `5xx`, `timeout`, `unreachable`, `auth`, `credit`, `rate_limited`, `not_found`, `not_configured`, `circuit_open`, `cooldown`, `error` |
| `X-Gateway-Fallback-From` | `deployment:parle-speech` | the provider that was left behind |

Streaming chat (`stream: true`) falls back only before the first token, so the headers are final.

### `503 provider_unavailable`

When no provider of the chain can serve the request — keys missing, keys rejected, every provider failing — the
gateway answers `503` and says which key is missing or which provider failed (never a key value):

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
  -d '{"model":"parle-tts","input":"Olá","voice":"vivian","fallback_voice":"pf_dora"}' --output speech.wav
```

### `GET /v1/models`

OpenAI-style model list (see the rules above).

### `POST /v1/images/generate`, `POST /v1/images/inpaint`

Image generation (`dit360` → self-hosted 360° GPU, `fal-ai/*` → fal.ai).

---

## Deployments

Docker image → autoscaled replicas on Scaleway machines. Enabled when `SCW_SECRET_KEY` is set. Mutations need an
admin key.

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
aliases, `PORT`, `NODE_ENV`, `GATEWAY_API_KEYS`, `HOSTNAME`, `RAILWAY_*` and `*_URL`.

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
