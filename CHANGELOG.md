# Changelog

All notable changes to `@parle/ai-gateway` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

Per-PR changesets live in `.changeset/` and are consolidated into this file
on release via `bunx changeset version`.

## [Unreleased]

### Added

- **Bundle size ratchet** (`bun run quality:bundle`, CI "Bundle Size Budget") — every tsup entry in `dist/`, raw and
  gzip -9, against `quality-bundle-baseline.json`; fails when an entry grows more than 2 % and 8 KB, or a new entry has
  no baseline. `quality:bundle:update` only tightens; deliberate growth needs `-- --accept-growth "<why>"`, recorded in
  the baseline. Replaces the fixed 512 KB cap on `dist/index.js`, which the library entry (1.4 MB: it re-exports the
  gateway, the autoscaler and every provider) had long outgrown, so the job was red on every PR and caught nothing.
- **Declared deployments** (`src/deployments/declared/*.json`) — the gateway registers them itself at boot and every
  5 min through the idempotent `controller.put`; secrets mounted from the environment (`GHCR_READ_TOKEN` →
  `registryAuth`, `SPEECH_IMAGE`), `SPEECH_TOKEN` generated once and persisted in the store; `pending` with the reason
  when the credential/image is missing; never starts a machine. First one: `parle-speech` (one L4 for STT+LLM+TTS).
- **One-GPU mode** — a deployment route entry may name `oneGpuDeployment`: while its own `deployment` is not
  registered and that one is, the entry goes there (the parle sends `parle-qwen-tts` + `oneGpuDeployment: parle-speech`
  for `parle-tts` in its app routes).
- **TTS stock voices by gender and the account-policy guard, as route-entry fields** (`PUT /v1/apps/:app/routes`,
  `MODEL_ROUTES`): `voices: {feminine, masculine}` (+ `voiceGenders`, `preferFallbackVoice`) gives a fallback that
  cannot clone a stock voice of the requested voice's gender (Qwen-Audio Cherry/Ethan; Kokoro pf_dora/pm_alex);
  `accountPolicyGuard: true` takes a link refused by the account's data policy (ZDR) out of the chain for 30 min (code
  `policy`, neutral for the shared OpenRouter breaker). The chain itself is the app's (the parle's is
  deployment → `openrouter:microsoft/mai-voice-2.1-flash` → Kokoro with `fixedVoice`); these fields are optional.
- **`GET /health` shows the effective chain per stage** and the state of every link (ready, cold, pending, missing,
  disabled, no_key, blocked, circuit_open) plus warnings — `not_configured` no longer passes unnoticed.

- **Honest providers + cross-provider fallback on `serve.ts`** — only providers with a key are mounted and listed
  in `/v1/models`; each model has an ordered chain across different providers (self-hosted deployment → OpenRouter
  → Groq/others), with circuit breakers; nothing available → `503 provider_unavailable` naming the missing key or
  the failed provider. `parle-stt` / `parle-llm` / `parle-tts` aliases route to the Scaleway deployments first,
  with `X-Gateway-Provider` / `X-Gateway-Fallback` origin headers. `MODEL_ROUTES` changes the map.
- **Runtime keys** — palco keys win over the environment, are re-read every 5 min and on
  `POST /v1/admin/keys/reload`; `PUT /v1/admin/keys` writes them to the palco. Providers read keys per request.
- **`GET /health?deep=1`** (admin) — live per-provider probes (OpenRouter via `/api/v1/key`), circuits, deployments.

### Removed

- `playai-tts` / `playai-tts-arabic` from `serve.ts` (retired by Groq).

- **Z.AI (Zhipu) cloud provider** (`src/gateway/providers/cloud/zai/`) — registers
  the OpenAI-compatible `https://api.z.ai/api/paas/v4` endpoint as provider id
  `zai`, exposing `glm-4.6` (200K-context text + tools), `glm-4.5`, `glm-4.5-air`,
  and the vision-capable `glm-4.5v` (accepts standard OpenAI multimodal
  `image_url` content parts) directly through `POST /v1/chat/completions`.
  Wires the `ZAI_API_KEY` env var into config, classification, error labels,
  cloud health probes, the chain-builder env-key map, and the default pricing
  table; mirrors the OpenRouter wiring in `server/providers.ts` so callers can
  hit GLM models with the same flow they already use for OpenRouter today.

## [0.1.0] — 2026-04-12

Initial tagged release. Captures the full set of features landed on `main`
during the project's pre-release development. Everything below is considered
stable enough to be consumed internally; the `0.x` line reserves the right
to change public API with only a minor bump until `1.0.0`.

### Added

- **OpenAI-compatible HTTP proxy** (`src/proxy/`) — chat completions, embeddings,
  audio transcription/speech, image generation, with Bearer-token auth, token-bucket
  rate limiting, CORS, security headers, and cacheable deterministic responses.
- **Server-Sent Events (SSE) streaming** for `POST /v1/chat/completions` with
  OpenAI-compatible chunk format, 30-second per-token timeout, and transparent
  fallback to the non-streaming path when a provider omits `chatStream()`.
- **Transparent model fallback** — when a client requests an unconfigured model,
  the proxy routes the call through the declared fallback chain using each
  entry's own model name.
- **GPU autoscaler** (`src/autoscaler/`) — tier-based boot orchestrator with
  discover/create/start lifecycle, health polling with exponential backoff,
  stage-level timeouts, idle watchdog, cost monitor, predictive warmup, and
  load balancer across ready tiers.
- **Multi-provider GPU clients** (`src/gpu-providers/`) — RunPod, Vast.ai,
  TensorDock, Modal, SnapGPU wrapper. Each implements discover/create/start/
  stop/delete/listOffers with provider-specific quirks abstracted via
  `AbstractGpuProvider`.
- **SnapGPU CRIU snapshots** — policy-gated restore-vs-cold boot decision,
  rolling metrics tracker with auto-disable when restore is slower than
  cold, image-ref drift detection, and 7-day snapshot TTL.
- **AI provider registry** (`src/providers/`) — unified STT/LLM/TTS/Image/
  Embedding interfaces with OpenAI-compatible base classes and declarative
  fallback chains.
- **Realtime / Omni providers** — OpenAI Realtime WebSocket client for
  speech-to-speech and generic speech pipeline orchestration.
- **Structured vault** (`src/vault/`) — AES-256-GCM encrypted credential
  store with key rotation, file-backed singleton.
- **State persistence adapters** (`src/adapters/`) — in-memory and Redis
  implementations of the `StateStore` interface with user-keyed isolation.
- **Cost tracking** — spend tracker, daily budget enforcement, GPU cost
  estimator, alerting via Discord / Slack / webhook channels.
- **Observability hooks** — Langfuse, webhook, distributed tracer, and
  console-based hook registry with lifecycle event fan-out.
- **Benchmark tooling** (`src/benchmarking/`) — CLI runner, WebSocket bench
  client, latency histogram, throughput reporter.
- **Gateway SDK** (`src/sdk/`) — typed client wrapping the HTTP surface for
  programmatic access from TypeScript callers.
- **Structured logger** (`src/logger.ts`) — pino-backed JSON output with
  `AsyncLocalStorage` correlation IDs and `createLogger(module)` API;
  forwards to `console` in test mode so existing vitest spies keep working.
- **Test suite** — 277 test files, 5,077 passing tests as of this release;
  unit tier runs in under 90 seconds.
- **VitePress documentation site** (`docs/`) with integration guide, API
  reference, and SnapGPU cold-start optimization guide.

### Known limitations

- **E2E Playwright suite** has 140+ failures deferred for separate triage;
  not gated in CI.
- **`/v1/embeddings` endpoint** is implemented but no provider is wired in
  `serve.ts`; returns 404 until one is configured.
- **CRIU snapshots on Vast.ai community cloud are not viable** — the platform
  strips `--privileged` and `vm:true` flags. Use RunPod Secure Cloud for
  SnapGPU-backed workloads.

---

## Release process

1. Each PR that touches the library surface must include a changeset:
   ```bash
   bunx changeset
   ```
   Follow the prompts to declare the bump level (patch / minor / major) and a
   short summary. The changeset becomes a new markdown file in `.changeset/`.

2. On release, run:
   ```bash
   bunx changeset version   # consumes pending changesets → bumps package.json + CHANGELOG
   git add . && git commit -m "release: v$(node -p 'require(\"./package.json\").version')"
   git tag "v$(node -p 'require(\"./package.json\").version')"
   git push --follow-tags
   ```

3. For the rare case where the release is a Fly.io service deploy (not a
   library cut), see `docs/ops/deploy.md`.
