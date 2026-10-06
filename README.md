# AI Gateway

[![GitHub](https://img.shields.io/badge/GitHub-marcosremar/ai--gateway-blue?logo=github)](https://github.com/marcosremar/ai-gateway)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A self-hosted, cost-efficient AI infrastructure platform that provides:

- **Speech-to-Speech Translation** — Real-time multilingual audio translation via STT → LLM → TTS pipeline
- **GPU Deployment & Management** — Multi-provider cascade deploy (RunPod → Vast.ai → TensorDock → Modal) with auto-scaling, idle management, and crash recovery
- **AI Provider Abstraction** — Unified interface over Groq, OpenAI, Fireworks, OpenRouter, Ollama, Deepgram, and self-hosted GPUs
- **Hybrid Routing** — Race GPU vs cloud, auto-select cheapest, latency-based demotion, canary deployments
- **Observability** — Request logging, provider metrics, latency tracking, circuit breakers, Prometheus metrics

Built with TypeScript, providing a unified interface for AI providers and multi-tier GPU autoscaling with automatic failover.

## Features

- **Transparent Speech API** — Single `POST /v1/speech` endpoint handles STT → LLM → TTS. Transport (GPU vs cloud) is hidden from the caller. No SSE/WebSocket/WebRTC in client code.
- **Deployments (Scaleway)** — `PUT /v1/deployments/:name` with any Docker image (or a profile like `qwen3-tts`) → autoscaled replicas, scale to zero, cold-start wait, per-deployment replica bounds via API. See [docs/deployments.md](docs/deployments.md)
- **Multi-tier GPU Autoscaler** — Cascade through GPU providers (RunPod, TensorDock, Modal) with automatic failover, health checking, idle watchdog, and cost monitoring
- **AI Provider Abstraction** — Unified interface for 8+ providers (OpenAI, Groq, Fireworks, OpenRouter, Modal, self-hosted) across STT, TTS, LLM, Image, and Realtime modalities
- **Provider Fallback Chains** — Declarative, config-driven fallback with cooldown and credit exhaustion tracking
- **Predictive Warmup** — ML-based usage prediction to pre-boot GPUs before demand spikes
- **Spend Tracking** — Per-request cost estimation, budget alerts, and provider spend monitoring
- **Infrastructure Utilities** — SkyPilot CLI integration, SSH/SCP helpers

## Installation

```bash
# Workspace dependency (in monorepo)
bun add @parle/ai-gateway@workspace:*
```

## Quick Start

### Pipeline API (Recommended)

Send audio, get back transcription + translation + TTS audio in one JSON response. The gateway handles GPU vs cloud routing transparently.

```bash
# Full pipeline: audio in → JSON out
curl -X POST "http://localhost:4000/v1/speech?source=fr&target=en&speaker=Ryan" \
  --data-binary @audio.wav -H "Content-Type: audio/wav"

# Response:
# {
#   "transcription": "Bonjour le monde",
#   "response": "Hello world",
#   "audio_base64": "UklGR...",
#   "content_type": "audio/wav",
#   "timing": { "total_ms": 1234, "used_gpu": true }
# }
```

### AIClient (TypeScript)

```typescript
import { createAIClient } from '@ai-gateway/client';

const client = createAIClient({ registry, defaultProfile });

// Full pipeline — tries GPU first, falls back to cloud automatically
const result = await client.pipeline(audioBuffer, systemPrompt);
// result.stt.text       → "Bonjour le monde"
// result.chat.content   → "Hello world"
// result.tts.audio      → Buffer (WAV)
// result.usedGpu        → true/false
// result.totalLatencyMs → 1234

// Individual stages (also transport-transparent)
const stt  = await client.transcribe(audioBuffer);   // { text, latencyMs }
const chat = await client.chat(messages);             // { content, latencyMs }
const tts  = await client.synthesize(text);           // { audio, contentType }
```

### Transport Policy

**SSE, WebSocket, and WebRTC are blocked at the proxy level** (return `410 Gone`). All client code uses the JSON pipeline endpoint or the AIClient API. This keeps transport concerns inside the gateway — callers never parse SSE events, manage WebSocket frames, or negotiate WebRTC.

### Gateway Factory (Autoscaler)

```typescript
import { createGateway } from '@ai-gateway';

const gateway = createGateway({
  storage: myStorageAdapter,  // implements GatewayStorage
  stateStore: redisAdapter,   // optional, falls back to in-memory
  hooks: {                    // optional observability
    onScaleUp: (e) => console.log('GPU booting:', e),
    onCostAlert: (e) => console.log('Budget alert:', e),
  },
});

const status = await gateway.handleGet(userId);
const result = await gateway.handleAction(userId, 'boot', { tier: 0 });
```

### AI Providers

```typescript
import { groqLLM, openaiSTT, openaiTTS } from '@ai-gateway/providers';

// Individual providers
const stt = openaiSTT({ apiKey: '...' });
const llm = groqLLM({ apiKey: '...' });
const tts = openaiTTS({ apiKey: '...' });

const transcript = await stt.transcribe({ audio: audioBuffer });
const response = await llm.chat({ messages: [{ role: 'user', content: transcript.text }] });
const audio = await tts.synthesize({ text: response.text, voice: 'alloy' });
```

### Provider Fallback

```typescript
import { withProviderFallback } from '@ai-gateway/providers';

const result = await withProviderFallback(
  [groqLLM({ apiKey: '...' }), openaiLLM({ apiKey: '...' })],
  (provider) => provider.chat({ messages }),
  { maxRetries: 2, cooldownMs: 30_000 }
);
```

### GPU Provider Clients

```typescript
import { RunPodClient, TensorDockClient } from '@ai-gateway/gpu-providers';

const runpod = new RunPodClient({ apiKey: '...' });
const pod = await runpod.boot({
  gpuType: 'RTX A5000',
  dockerImage: 'marcosremar/parle-s2s:latest',
  ports: ['8000/http', '22/tcp'],
});

await runpod.waitForReady(pod.id);
await runpod.terminate(pod.id);
```

## Module Exports

| Import Path            | Description                                    |
|------------------------|------------------------------------------------|
| `@ai-gateway`         | Full API (all modules re-exported)             |
| `@ai-gateway/browser` | Browser SDK — SpeechClient (legacy, see transport policy) |
| `@ai-gateway/providers` | AI providers — OpenAI, Groq, Fireworks, etc. |
| `@ai-gateway/autoscaler` | GPU autoscaling engine                      |
| `@ai-gateway/gpu-providers` | Cloud GPU clients — RunPod, TensorDock, Modal |
| `@ai-gateway/handlers` | Next.js route handler utilities               |
| `@ai-gateway/client`  | AIClient — profile-based unified API           |
| `@ai-gateway/tracking` | Benchmark & spend tracking                    |
| `@ai-gateway/adapters` | State persistence — InMemory, Redis           |
| `@ai-gateway/auth`    | GPU token signing/verification (HMAC)          |
| `@ai-gateway/infra`   | SkyPilot CLI, SSH/SCP utilities                |
| `@ai-gateway/benchmarking` | Health checks, latency benchmarks         |

## Architecture

```
                    ┌─────────────────┐
                    │  createGateway  │  ← Single entry point
                    └────────┬────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
    ┌───────▼──────┐  ┌─────▼─────┐  ┌───────▼──────┐
    │  Autoscaler  │  │ Providers │  │   Handlers   │
    │   Engine     │  │  Registry │  │  (Next.js)   │
    └───────┬──────┘  └─────┬─────┘  └──────────────┘
            │               │
   ┌────────┼────────┐     │
   │        │        │     │
┌──▼──┐ ┌──▼──┐ ┌───▼─┐  ┌▼────────────┐
│RunPod│ │TD   │ │Modal│  │OpenAI, Groq,│
│      │ │     │ │     │  │Fireworks,...│
└──────┘ └─────┘ └─────┘  └─────────────┘
```

### Design Principles

- **Framework-agnostic** — No hard dependencies on Prisma, Redis, or Next.js. All external dependencies injected via interfaces.
- **Modular** — Each subpath is independently importable. Browser SDK has zero Node.js dependencies.
- **Tier cascade** — GPU autoscaler walks through tiers (cheapest first) with automatic failover to the next tier on failure.
- **Provider fallback** — AI providers fail over automatically with cooldown tracking and credit exhaustion detection.

## Supported Providers

### AI Providers

| Provider    | STT | TTS | LLM | Image | Realtime |
|-------------|-----|-----|-----|-------|----------|
| OpenAI      | Whisper | TTS-1/HD | GPT-4o | DALL-E 3 | Realtime API |
| Groq        | Whisper | PlayAI | LLaMA, Mixtral | - | - |
| Fireworks   | Whisper | - | LLaMA, Mixtral | Stable Diffusion | - |
| OpenRouter  | - | - | 200+ models | Flux, DALL-E | - |
| Modal       | - | MOSS-TTS | - | - | - |
| Self-hosted | Generic | Generic | Generic | - | - |

### GPU Cloud Providers

| Provider   | Status   | Notes                                      |
|------------|----------|--------------------------------------------|
| RunPod     | Working  | Primary. ~31s boot. Use HTTP+TCP ports.    |
| TensorDock | Working  | RTX 3090 inference backend.                |
| Modal      | Working  | Serverless, auto-scales to zero.           |
| Hyperstack | Working  | KVM w/ nested virt (`/dev/kvm` confirmed). Custom image build pipeline wired. `offloadOnIdle` = 1.3s wake. |
| Vast.ai    | Improved | Desktop offer policy (reliability ≥0.95, download >1 Gbps, ≤~$0.20/hr) + in-memory hot pool (`claim`/`release`). Direct HTTP still often needs SSH proxy on residential hosts; prefer `offerPolicy: 'desktop'` for quality. |
| SkyPilot   | Working  | Multi-cloud orchestration.                 |

### Providers to explore — Firecracker / gVisor / Kata GPU sandboxing

These offer sandboxed GPU runtimes (sub-second cold start), per-second billing, and fit the Modal-style scale-up model we could adopt instead of rolling our own. Priority in order of fit:

| Provider     | Runtime             | Cheapest GPU      | Cold start (GPU) | Free trial        | Worth testing? |
|--------------|---------------------|-------------------|------------------|-------------------|:--------------:|
| **Koyeb**    | Firecracker + Cloud Hypervisor (GPU) | L4 $0.70/hr, L40S $1.20/hr | seconds (GPU VRAM snapshot is WIP, CPU gets 200ms) | **$10 / 7d Pro trial**, GPU eligible | **Yes — free trial covers PoC** |
| **Northflank** | Firecracker / Kata / gVisor (choose per workload) | L4 $0.80/hr, A100 40G $1.42/hr | 1–2 s end-to-end | Sandbox plan free (CPU only); GPU requires pay-as-you-go | Yes if you need runtime choice |
| **RunPod Serverless** | Proprietary (FlashBoot) | T4 ~$0.20/hr active, L4/L40S ~$0.40–0.70/hr active | **<200ms in 48% of calls** | Community credits occasionally | Yes — currently the best latency/$ in the market |
| **Beam / Beta9** | **runc or gVisor** (runtime configurable) + custom CLIP lazy image + cuda-checkpoint | ~$0.70–1.00/hr | 2–3 s typical, **50ms warm** | $30 credit | **Yes — also open source (AGPL), self-hostable as `beta9`** |
| Inferless    | Container (no microVM, no CRIU) — just `hf-transfer` accelerated weight download | T4 $0.33/hr, A10 $0.61/hr | **Llama-3 8B 13.3s / Phi-3 7.8s** (measured, T4) | **$30 credit + 10h free** | Low priority — weight-loading only |
| Salad.com    | Distributed marketplace (no sandbox) | RTX 4090 $0.204/hr | marketplace (unreliable like Vast) | — | Batch only, not latency-sensitive |
| CoreWeave    | Bare-metal          | L40S $2.25/hr     | ~200ms bare-metal | — | Expensive but reliable |
| Fly.io GPU   | Firecracker + Cloud Hypervisor | L40S $1.25/hr | ~30s / 7B model | — | **❌ Deprecated Aug 2026** |

**Measured comparison baseline (Hyperstack L40 + our `offloadOnIdle`):** 1.3s wake on the same VM. Competitive with Northflank (1–2s). Beaten by RunPod Serverless FlashBoot (<200ms). Koyeb GPU currently does not deliver its 200ms CPU story for GPU workloads (VRAM snapshot limitation).

#### Deeper notes per provider

- **Beam / Beta9** ([GitHub](https://github.com/beam-cloud/beta9)) — the only serverless GPU runtime we've found that is **open source** (AGPL-3.0), supports **runtime choice (runc / gVisor)**, uses cuda-checkpoint for GPU snapshots, and has a **CLIP lazy-loading image format** (weights fault in on-demand from S3/FUSE — no upfront image pull). Self-hostable, so you could run Beta9 directly on Hyperstack L40 VMs and get Modal-class primitives without the Modal bill. Managed SaaS cold starts: 2–3s typical, 50ms warm.
- **Koyeb** — Firecracker + Cloud Hypervisor (for GPU VFIO passthrough). Their "200ms wake via eBPF + Light Sleep snapshots" only applies to **CPU workloads**; for GPU, VRAM snapshot preservation is explicitly still a work-in-progress on their end.
- **Northflank** — unique in letting the caller choose runtime **per workload** (Firecracker / Kata / gVisor). End-to-end sandbox create ~1–2s including image pull. No L40/L40S in catalog; A100 40G at $1.42/hr is the closest sweet-spot.
- **RunPod Serverless FlashBoot** — closest real competitor to Modal on cold start (<200ms in 48% of calls per their data). Proprietary runtime, per-second billing. Best ROI if you don't need sandbox choice.
- **Inferless** — NOT a microVM runtime. Just `hf-transfer` accelerated weight download + container. Measured cold starts: 7.8s (Phi-3, T4), 13.3s (Llama-3 8B). Fine for small models on T4/A10, doesn't replace Hyperstack offload.
- **Salad.com** — distributed-compute marketplace (home PCs), 60k+ GPUs from $0.02/hr. No sandbox isolation, no SLA — batch only.

Sources: [Koyeb pricing](https://www.koyeb.com/pricing), [Koyeb scale-to-zero blog](https://www.koyeb.com/blog/scale-to-zero-wake-vms-in-200-ms-with-light-sleep-ebpf-and-snapshots), [Koyeb GPU scale-to-zero caveats](https://www.koyeb.com/blog/scale-to-zero-optimize-gpu-and-cpu-workloads), [Northflank pricing](https://northflank.com/pricing), [Northflank sandbox runtimes](https://northflank.com/blog/best-code-execution-sandbox-for-ai-agents), [RunPod Serverless](https://www.runpod.io/product/serverless), [Beam Beta9 GitHub](https://github.com/beam-cloud/beta9), [Beam serverless platform guide](https://www.beam.cloud/blog/serverless-platform-guide), [Inferless pricing](https://www.inferless.com/pricing), [Salad pricing](https://salad.com/pricing).


<!-- AI_QUALITY_CONTROLS_START -->
## Automated AI Quality Controls

This section is generated from `docs/quality-controls.json`. Run `bun run quality:readme` after changing the quality gate manifest.

| Control | Automation | Enforcement | Purpose |
|---------|------------|-------------|---------|
| AI quality fitness gate | bun run quality:fitness / bun run quality:fitness:debt | Blocking in quality:ai and CI | Project-specific boundaries: src/server/web isolation, forbidden infra imports, undeclared dependencies and shared UI reuse. Structural debt is visible through the debt/strict modes. |
| Architecture dependency graph | bun run quality:architecture / bun run quality:architecture:strict | Blocking in quality:ai | dependency-cruiser enforces publishable-library boundaries. The strict variant surfaces existing circular dependencies as ratchet warnings. |
| Typecheck, lint and security lint | bun run typecheck && bun run lint / bun run lint:warnings | Blocking in quality:ai and CI | TypeScript strict checks and ESLint errors block merges. lint:warnings exposes legacy style/security warnings as audit debt. |
| Static application security testing | CodeQL workflow and Semgrep project rules | Blocking on security findings in CI | Detects injection, XSS, path traversal, unsafe regex, SSRF-like patterns, weak crypto and other security classes common in AI-generated code. |
| Dependency and vulnerability review | bun audit, GitHub Dependency Review and OSV-Scanner | Blocking for critical/new vulnerable dependencies | Stops hallucinated, vulnerable or license-incompatible dependencies from entering pull requests. |
| Secret scanning | Gitleaks workflow plus GitHub secret scanning when enabled | Blocking in CI | Catches API keys, tokens and provider credentials before merge. |
| Container and Dockerfile scanning | Docker security workflow with Trivy plus supply-chain policy scan | Blocking for high/critical image findings; ratchet warnings for floating tags and curl-pipe-shell | Protects GPU images, Dockerfiles and deployment scripts from vulnerable bases and unsafe install patterns. |
| Dead code and dependency hygiene | bun run quality:deadcode / bun run quality:deadcode:strict | Manual/audit ratchet until current debt is triaged | Knip finds unused files, exports and dependencies so AI-generated scaffolding does not accumulate silently. |
| Property-based tests | bun run test:properties | Available as a focused gate for high-risk pure logic | fast-check generates many edge cases for invariants in routing, compatibility, parsing, cache keys and state machines. |
| Mutation testing | bun run quality:mutation | Deep gate via quality:ai:deep | Stryker verifies whether tests actually fail when behavior changes, instead of trusting coverage alone. |
| Contract/API drift checks | Existing contract unit tests plus planned OpenAPI/Pact gate | Unit gate today; OpenAPI/Pact can become blocking after specs are generated | Prevents SDK, HTTP routes and WebSocket payload expectations from drifting across Gateway clients and server handlers. |
| CI supply-chain policy | bun run quality:supply-chain | Blocking in quality:ai for hard failures; warnings ratcheted with --strict | Audits GitHub Actions permissions, action pinning, floating refs, Docker latest tags and unsafe shell installers. |
| Provenance and SBOM | GitHub artifact attestations and SBOM upload in release workflows | Release hardening target | Creates verifiable build provenance for published artifacts and Docker images. |

### Local Quality Commands

```bash
bun run quality:ai              # typecheck + lint + build + fitness + supply-chain + architecture
bun run quality:ai:test         # quality:ai plus the unit suite
bun run quality:ai:deep         # quality:ai:test plus mutation testing
bun run quality:fitness:debt    # inspect current complexity/module-size structural debt
bun run quality:fitness:strict  # fail on current complexity/module-size ratchet warnings
bun run quality:supply-chain    # audit CI/Docker supply-chain hardening
bun run quality:architecture:strict # include circular dependency warnings
bun run quality:deadcode        # Knip dead-code/dependency audit without failing on existing debt
bun run quality:deadcode:strict # fail on Knip issues after the debt is triaged
bun run test:properties         # property-based invariant tests
```
<!-- AI_QUALITY_CONTROLS_END -->

## Build

```bash
bun run build   # tsup → dist/ (ESM + CJS + declarations + sourcemaps)
```

## Tech Stack

- **TypeScript** — Strict mode, ES2017 target
- **Zod** — Runtime config validation
- **tsup** — Bundler (ESM + CJS dual output)
- **OpenAI SDK** — Base client for OpenAI-compatible APIs

## STT Quality Research — Whisper `initial_prompt`

The gateway's STT pipeline uses Whisper's `initial_prompt` parameter to anchor transcription to domain-specific vocabulary. The following research informs our implementation:

### Key Techniques

| Technique | Effect | Status |
|-----------|--------|--------|
| Rolling prior-segment context (sliding window) | Most effective — conditions each segment on recent transcription | Implemented |
| LLM-expanded domain prompt (title → 2-3 sentences) | ~17% relative WER reduction on domain-specific content | Implemented |
| Glossary term injection | Biases spelling of technical vocabulary | Implemented |
| `condition_on_previous_text=True` | Enables decoder to attend to prior output | Default in pipeline |

### Guidelines

- **224-token limit** (~170 words) — keep prompts compact
- **Language must match audio** — wrong-language prompts degrade WER by ~19% ([arXiv 2406.05806](https://arxiv.org/abs/2406.05806))
- **Sentence-style prompts outperform keyword lists** — use natural flowing prose, not comma-separated terms ([arXiv 2406.05806](https://arxiv.org/abs/2406.05806))
- **Vocabulary-dense prompts** — include speaker name, technical terms, and domain proper nouns; generic/register-only prompts show no gain ([arXiv 2406.05806](https://arxiv.org/abs/2406.05806), confirmed in our benchmarks)
- **Avoid verbatim transcript overlap** — if prompt contains words that appear in the talk, Whisper treats them as "already transcribed" and may miss them in actual audio (observed in our benchmarks)
- **Most recent tokens** get highest attention weight — put the most relevant context last
- **Static prompts plateau quickly** — rolling context + LLM expansion gives the best combined result

### Benchmark Results — TEDx French (4 videos, Groq Whisper-large-v3-turbo)

Ground truth: professional human subtitles (TEDx manual captions). WER-sem = WER after LLM normalization (removes style differences: numbers, abbreviations, punctuation).

| Video | Category | WER-sem (no prompt) | WER-sem (rolling + seed) | Δ |
|-------|----------|--------------------:|-------------------------:|--:|
| Les biais cognitifs | Psychology | 28.5% | 20.1% | **−8.4pp ✅** |
| Le désir, moteur de nos vies | Philosophy | 23.3% | 17.3% | **−6.0pp ✅** |
| Étienne Klein — Contre la montre | Physics/Philosophy | 15.3% | 16.6% | +1.3pp ≈ |
| Pourquoi sommes-nous fascinés par les fictions | Humanities | 13.7% | 19.1% | +5.4pp ⚠️ |
| **Average** | | **20.2%** | **18.3%** | **−1.9pp** |

**Key findings:**

1. **Rolling context alone is the most impactful technique.** Without it, WER is ~5pp higher on average. It resolves cross-boundary phrases and maintains spelling consistency chunk-to-chunk.

2. **Seed context (LLM-expanded title) helps domain-specific talks significantly** — Psychology (−8.4pp) and Philosophy (−6.0pp) benefit because the prompt anchors domain vocabulary (e.g. *biais cognitif*, *heuristique*, *Schopenhauer*).

3. **Seed context does NOT help — or hurts — general-vocabulary talks** (Klein, Fictions). Two mechanisms:
   - **Vocabulary overlap**: if the prompt contains words that appear verbatim in the talk, Whisper treats them as "already transcribed" and may miss or distort them in the actual audio.
   - **Floor effect**: talks already well-transcribed (WER ~15%) have little room to improve; any prompt competes with the rolling context for the 224-token window.

4. **Prompt style matters**: vocabulary-dense prompts outperform register-only prompts for technical content. Register-only prompts ("Conférence TEDx en français...") are neutral at best.

5. **Raw WER increases slightly with seed prompts** (~1-2pp) even when WER-sem improves — the prompt shifts Whisper's output style (more formal, different punctuation), which doesn't match the reference literally but is semantically correct.

**Practical rule for the "Session title" field:**
- Fill it for medical, legal, academic, or technical meetings → significant gains
- Leave it empty for general conversation, casual talks, or pop-culture content → rolling context is sufficient

### References

- **arXiv 2602.18966** — "Improved Domain-Specific ASR via Large Language Model Prompt Engineering" (NBA commentary). LLM-generated compact domain prompts: **17% relative WER reduction** vs no prompt.
- **arXiv 2406.05806** — "Do Prompts Really Prompt? Rethinking the Role of Prompts in Whisper Transcription". Comprehensive study of prompt strategies; sentence-style > keyword lists; language mismatch = catastrophic degradation.
- **arXiv 2502.11572** — "Improving Whisper's Recognition of Rare Words via Initial Prompt Injection". Injection of rare/domain-specific terms in `initial_prompt` significantly improves recognition of OOV vocabulary.
- **OpenAI Cookbook — Whisper Prompting Guide** — Practical guide covering spelling correction, filler word suppression, punctuation style, and fictional context prompts.

## License

Private — Part of the Parle ecosystem.
