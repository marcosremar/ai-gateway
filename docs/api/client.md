# Gateway client (`GatewayClient`)

`@parle/ai-gateway/client` exports `GatewayClient`, the typed client of the current API ([HTTP API](./http.md)):
one interface for an app (first: the parle game) instead of hand-written `fetch`.

::: info Legacy client
`GatewayHttpClient` (same package) is the **legacy** client of the old routes (`/v1/transcribe`, `/v1/speech`,
`/v1/gpu/*`, `/v1/bot/*`), which `serve.ts` does not mount. It is kept unchanged for the code that still uses it; new
code uses `GatewayClient`.
:::

```ts
import { GatewayClient, GatewayError } from '@parle/ai-gateway/client';

const gw = new GatewayClient({
  baseUrl: 'https://gateway.example.com',   // no /v1
  apiKey: process.env.GATEWAY_API_KEY,      // the gateway key — the only key the app holds
  app: 'parle',                              // optional: sends X-App (an admin key acting for the app)
  timeoutMs: { tts: 15_000 },                // per group: stt, chat, tts (15 s), s2s (50 s), admin (30 s), health (10 s)
  // fetch: myFetch,                         // injectable (tests, custom agents)
});
```

Works in Node, Bun and browsers (no Node-only API on the request path). It calls nothing but `baseUrl` — and, with
[`directFallback`](#direct-fallback-gateway-down), the providers named by the gateway's plan. It never reads a
provider key from the environment.

## OpenAI-compatible routes

```ts
// STT — POST /v1/audio/transcriptions (multipart)
const { text, served } = await gw.transcribe({ file: blobOrBytes, model: 'parle-stt', language: 'pt' });

// Chat — POST /v1/chat/completions
const completion = await gw.chat({ model: 'parle-llm', messages, max_tokens: 160, extraBody: { top_k: 20 } });

// Streamed chat: resolves when the headers arrived (served is final), then iterate the content deltas
const stream = await gw.chatStream({ model: 'parle-llm', messages });
console.log(stream.served.provider);
for await (const delta of stream) speakLater(delta);
console.log(stream.finishReason, stream.usage);

// TTS — POST /v1/audio/speech; the body is a ReadableStream, never buffered (wav/pcm stream end to end)
const { body, contentType, served } = await gw.speech({
  model: 'parle-tts', input: 'Bom dia!', voice: 'br-f-01', fallback_voice: 'pf_dora', response_format: 'wav',
  language: 'pt',  // any other field goes to self-hosted targets as-is
});
```

`served` is `{ provider, fallback, fallbackFrom }` from `X-Gateway-Provider` / `X-Gateway-Fallback` /
`X-Gateway-Fallback-From` (`null` when absent). A browser on another origin can read them only if the gateway lists
them in `Access-Control-Expose-Headers`.

## Speech-to-speech — `POST /v1/s2s`

```ts
const turn = await gw.s2s({ file: utterance, config: {
  system, messages, user_template: 'O jogador diz: "{{transcript}}"', language: 'pt', voice: 'br-m-08',
  fallback_voice: 'pf_dora', deployment: 'parle-speech', models: { stt: 'parle-stt', chat: 'parle-llm', tts: 'parle-tts' },
} });
for await (const frame of turn) {
  if (frame.kind === 'audio') player.push(frame.pcm);               // PCM s16le mono, 24 kHz unless audio_format says otherwise
  else if (frame.event.type === 'transcript' && notForTheCharacter(frame.event.text)) { await turn.cancel(); break; }
  else if (frame.event.type === 'done') log(frame.event.first_audio_ms);
}
```

The promise resolves at the first frame; anything that fails before it (e.g. `503 provider_unavailable`) rejects
with a `GatewayError`. Events are typed (`route`, `transcript`, `llm_first_token`, `sentence`, `audio_format`,
`first_audio`, `sentence_failed`, `error`, `done`); an in-band `error` is yielded, not thrown (with `partial: true`
what was sent is valid). Breaking out of the loop or `cancel()` closes the connection and the gateway aborts the turn.
`S2SFrameDecoder` is exported for apps that read the frames themselves.

## Deployments, app accounts, health

```ts
await gw.deployments.put('parle-speech', { appImage: 'speech-stack', minReplicas: 0 }); // idempotent create/update
const view = await gw.deployments.get('parle-speech');      // null on 404
await gw.deployments.wake('parle-speech');                 // pre-warm before a class
await gw.deployments.park('parle-speech');                 // done for now
await gw.deployments.pause('parle-speech'); await gw.deployments.resume('parle-speech');
await gw.deployments.delete('parle-speech');               // false when it did not exist
const { deployments } = await gw.deployments.list();
const url = gw.invokeUrl('parle-speech');                   // `${baseUrl}/v1/deployments/parle-speech/invoke`

await gw.appRoutes.put('parle', { stt: { 'parle-stt': ['deployment:parle-speech', 'openrouter:openai/whisper-large-v3-turbo'] } });
const routes = await gw.appRoutes.get('parle');
await gw.apps.putImage('parle', 'speech-stack', { image: 'rg.fr-par.scw.cloud/aigw/speech-stack:20261006', port: 8000 });

await gw.health();                 // GET /health
await gw.health({ deep: true });   // GET /health?deep=1 (admin key)
```

## Errors, timeouts, retries

- Every failure is a `GatewayError` with `status`, `code` (the gateway's `error.code` / `error.type`, e.g.
  `provider_unavailable`; else `not_found`, `forbidden`, `http_502`…), `path`, `served`, `retryAfterSec`, `details`
  (parsed body), `origin` (`gateway` or the provider called directly) and `unreachable` (below).
- **Timeout** (per call `timeoutMs`, else the group default) → `GatewayError` code `timeout`. For streamed results
  (`chatStream`, `speech`, `s2s`) it bounds the wait for the response headers; the body is bounded by your signal and
  the gateway's own budgets.
- **Your own signal aborted** → the call rejects with `signal.reason` (an `AbortError` by default), never a
  `GatewayError`, never retried, never sent to a fallback.
- **Retries**: only idempotent calls (GET, PUT, PATCH, DELETE, `wake`, `park`), only on connection errors, at most
  2 (200 ms, 600 ms). Transcriptions, chat, speech and s2s are never retried: the gateway already falls back and
  hedges between providers, and a client retry would double the cost.

## Direct fallback (gateway down)

For **server-side** clients only (the app's backend). When the gateway *itself* is unreachable, `transcribe`,
`chat`, `chatStream` and `speech` call the same aliases directly on the providers the gateway would have used as
fallback, with the keys the gateway handed out in the app's fallback plan
([`GET /v1/apps/:app/fallback`](./http.md) (§ Direct-fallback plan)).

```ts
const gw = new GatewayClient({
  baseUrl, apiKey: process.env.GATEWAY_API_KEY,
  directFallback: { app: 'parle', failureThreshold: 3, cooldownMs: 30_000 },
  onRouteChange: ({ route, reason }) => log.warn({ route, reason }, 'gateway route changed'),
});
await gw.refreshFallbackPlan();   // at boot: a plan must exist before the gateway ever goes down
gw.gatewayState();                // { breaker: 'closed'|'open'|'probing', route, consecutiveFailures, openUntil, lastError, planLoaded }
```

**When it goes direct** — the gateway is unreachable (`GatewayError.unreachable`):

| Goes direct | Does not |
|---|---|
| connection / DNS error | the gateway's own `503 provider_unavailable` (it is alive and already tried the fallbacks) |
| timeout before the first byte from the gateway | any 4xx, or any error with the gateway's JSON body |
| 502 / 503 / 504 whose body is **not** the gateway's JSON error (edge/proxy failure, restart) | your own abort |

**How** — the alias (`model`) is looked up in the plan; its entries are tried in chain order with the same OpenAI
body shapes, the entry's `model`, the request's `extraBody` then the entry's `extraBody` merged, and the next entry
on 5xx / 429 / timeout / connection error. TTS uses the entry's `voice` when `fixedVoice`, else the request's
`fallback_voice`, else the entry's `voice`; OpenRouter speech gets `mp3` unless `pcm` was asked (as the gateway does).
`served` then reads `{ provider: 'openrouter-direct:<model>', fallback: 'gateway_unreachable', fallbackFrom: 'gateway' }`.
An alias without entries (or no plan) rethrows the gateway's error, with `; no direct fallback: <why>` appended (a
keyless plan — no `OPENROUTER_PROVISIONING_KEY` on the gateway — or no plan fetched).

**Breaker** — after `failureThreshold` consecutive unreachable failures the gateway is skipped for `cooldownMs`
(calls go straight to the providers). The first call after the cooldown starts a background `GET /health` probe; as
soon as it answers, the breaker closes and the next call uses the gateway again (`onRouteChange({route: 'gateway',
reason: 'recovered'})`). The gateway still owns the provider breakers; this one only decides the switch.
A call whose alias has no direct entry (keyless plan; `s2s` when the plan has no entry at all) is never just skipped:
it probes `GET /health` first (at most once a second) and goes to the gateway as soon as it answers — so a restarted
gateway serves the next call, not the one after the cooldown (fault bench 2026-10-07, S3).

**Slow counts too** — `directFallback.slowMs` (default `0` = off): a gateway call that takes longer counts as a
failure toward the breaker (the answer is still used) — so a gateway that stays slow opens the breaker and the next
calls go direct even though it answers. To abandon a slow call mid-flight instead, set a tighter `timeoutMs`: a
timeout already counts as unreachable.

## Instability report

The client keeps a ring buffer (default 500, `instability.bufferSize`) of what it saw of the gateway's health —
`unreachable` (with the code: `network`, `timeout`, `breaker_open`), `slow` (with `latencyMs`), `direct`,
`direct_failed`, `recovered` — and, once the gateway answers again, posts it to
[`POST /v1/apps/:app/stability-report`](./http.md) (the app of `directFallback.app`, else `app`).

```ts
const gw = new GatewayClient({
  baseUrl, apiKey: process.env.GATEWAY_API_KEY,
  directFallback: { app: 'parle', slowMs: 8_000 },
  instability: { client: 'parle-backend' },   // report: false to flush by hand
});
gw.instabilityEvents();          // buffered events (copy)
await gw.reportInstabilities();  // { sent } — posts and clears what the gateway accepted
```

The report is fire-and-forget: a failed POST keeps the buffer for the next recovery. With no app known
(`directFallback.app`/`app` unset) or `instability.report: false`, events stay in memory for `instabilityEvents()`.

**Plan** — kept in memory only (never on disk, never logged), refreshed in the background once 80 % of its
`ttlSeconds` passed, and again when a provider answers 401 (then the same entry is retried once with the new key).
The last good plan stays usable while the gateway is down.

**`s2s` has no direct fallback**: when the gateway is unreachable (or the breaker is open) it rejects with code
`gateway_unreachable`; the app then plays the turn with its separate `transcribe` → `chatStream` → `speech` calls,
which do go direct. Deployments, app routes and health never go direct.

::: danger Security model
The plan carries provider keys. The gateway delivers it only over HTTPS, only to an authenticated **app key** (or an
admin key that names the app with `X-App`), and the client keeps it in memory. Use `directFallback` only in a
**server-side** client (the app's backend): never in a browser bundle, where any player could read the key. With
`OPENROUTER_PROVISIONING_KEY` on the gateway, each app gets its own OpenRouter key with a USD limit
(`APP_FALLBACK_KEY_LIMIT_USD`), rotated weekly: the limit bounds what a leak can cost, and a leaked key dies on its own.
:::
