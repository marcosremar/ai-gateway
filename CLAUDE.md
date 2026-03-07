# AI Gateway — Claude Code Guidelines

## Overview

`@parle/ai-gateway` is a standalone workspace package — the **single source of truth** for all GPU, AI provider, autoscaler, benchmarking, and infrastructure code.

**Import alias:** `@ai-gateway` (root), `@ai-gateway/*` (subpaths)

## Package Manager

**Always use Bun.** Never npm/npx/node.

```bash
bun install          # install deps
bun run build        # build with tsup (ESM + CJS)
```

## Architecture

### Entry Points (12 exports)

| Export             | Purpose                          | Entry                       |
|--------------------|----------------------------------|-----------------------------|
| `.`                | Full gateway API                 | `src/index.ts`              |
| `./browser`        | Browser SDK (SpeechClient)       | `src/browser/index.ts`      |
| `./providers`      | AI provider integrations         | `src/providers/index.ts`    |
| `./autoscaler`     | GPU autoscaling engine           | `src/autoscaler/index.ts`   |
| `./gpu-providers`  | GPU cloud clients                | `src/gpu-providers/index.ts`|
| `./handlers`       | Next.js route handlers           | `src/handlers/index.ts`     |
| `./client`         | AIClient unified API             | `src/client/index.ts`       |
| `./tracking`       | Benchmark & spend tracking       | `src/tracking/index.ts`     |
| `./adapters`       | State persistence (Redis/memory) | `src/adapters/index.ts`     |
| `./auth`           | GPU token signing/verification   | `src/auth/index.ts`         |
| `./infra`          | SkyPilot/SSH/SCP utilities       | `src/infra/index.ts`        |
| `./benchmarking`   | Health checks & perf tests       | `src/benchmarking/index.ts` |

### Directory Structure

```
src/
├── adapters/        # State persistence (InMemory, Redis)
├── auth/            # GPU token HMAC signing/verification
├── autoscaler/      # Multi-tier GPU autoscaling engine (18 files)
│   ├── engine.ts           # Core autoscaling logic
│   ├── config-loader.ts    # Zod-validated config loading
│   ├── health.ts           # HTTP/SSH health probing
│   ├── health-checker.ts   # Parallel multi-tier health checks
│   ├── decision-builder.ts # Build autoscale decisions
│   ├── latency-tracker.ts  # P95 latency, breach detection
│   ├── session-tracker.ts  # Session heartbeat counting
│   ├── load-balancer.ts    # Hash/round-robin distribution
│   ├── watchdog.ts         # Idle timeout enforcement
│   ├── cost-monitor.ts     # Spend tracking, waste detection
│   ├── predictive-warmup.ts# ML-based usage prediction
│   ├── tier-lifecycle.ts   # Boot/ready/idle transitions
│   ├── state-persistence.ts# Redis state save/restore
│   ├── reconcile.ts        # Periodic state reconciliation
│   ├── boot-timeout.ts     # Boot timeout handling
│   ├── cleanup.ts          # Kill orphaned instances
│   └── lifecycle-logger.ts # GPU lifecycle event logging
├── benchmarking/    # Health checks, SSE/WS/WebRTC bench
├── browser/         # Framework-agnostic SpeechClient SDK
│   ├── speech-client.ts    # Main client class
│   ├── transport-ws.ts     # WebSocket transport
│   ├── transport-sse.ts    # SSE transport
│   └── transport-webrtc.ts # WebRTC transport
├── client/          # AIClient unified API with profiles
├── gpu-providers/   # Cloud GPU clients
│   ├── runpod-client.ts    # RunPod (WORKING, primary)
│   ├── tensordock-client.ts# TensorDock
│   ├── vast-client.ts      # Vast.ai (HTTP NOT viable)
│   └── modal-client.ts     # Modal (serverless)
├── handlers/        # Next.js route handler utilities
├── infra/           # SkyPilot CLI, SSH/SCP helpers
├── providers/       # AI provider implementations (30 files)
│   ├── openai/             # Whisper STT, TTS, Realtime, Omni, DALL-E
│   ├── openai-compat/      # Reusable base classes for OpenAI-like APIs
│   ├── groq/               # Fast LLM inference
│   ├── fireworks/           # LLM + image generation
│   ├── openrouter/         # LLM aggregator + image
│   ├── modal/              # MOSS-TTS
│   ├── self-hosted/        # Generic HTTP backend
│   ├── fallback.ts         # Provider failover with cooldown
│   ├── declarative-chain.ts# Config-driven fallback chains
│   ├── chain-builder.ts    # Build chains from user settings
│   ├── voice-catalog.ts    # TTS voice metadata
│   └── credit-block.ts     # Credit exhaustion tracking
├── tracking/        # Benchmark & spend tracking
├── create-gateway.ts # Single-entry-point factory (recommended)
├── factory.ts       # Advanced autoscaler factory
├── gateway.ts       # Singleton gateway pattern
├── gateway-api.ts   # Gateway API types
├── deps.ts          # DI interfaces (framework-agnostic)
├── storage.ts       # GatewayStorage bridge interface
├── hooks.ts         # Observability event hooks
├── types.ts         # Core types (GpuTierConfig, AutoScalerConfig, etc.)
└── index.ts         # Re-exports (~115 public symbols)
```

## Key Patterns

### Dependency Injection

The package is framework-agnostic. Host apps provide implementations via `AutoscalerDeps`:

```typescript
interface AutoscalerDeps {
  settingsStore: SettingsStore;      // User AI settings (Prisma adapter)
  stateStore: StateStore;            // KV + list + hash ops (Redis adapter)
  sessionResolver: SessionResolver;  // Count active DB sessions
  logger?: Logger;
  credentialStore?: CredentialStore;
  lifecycleLogStore?: LifecycleLogStore;
  benchmarkStore?: BenchmarkStore;
}
```

### Gateway Factory (Recommended)

```typescript
const gateway = createGateway({ storage, stateStore?, hooks? });
gateway.handleGet(userId);
gateway.handleAction(userId, action, body);
```

### Core Types

```typescript
type AutoScaleRoute = 'llm' | 's2s';
type GpuBootState = 'idle' | 'booting' | 'ready';
type GpuProvider = 'tensordock' | 'runpod' | 'vast' | 'modal' | 'skypilot';
type GpuTierState = IdleTierState | BootingTierState | ReadyTierState; // discriminated union
```

## Rules

1. **All GPU, AI provider, autoscaler, benchmarking, and infra code MUST live here** — never in `src/lib/`
2. The autoscaler is part of `@ai-gateway` — never create autoscaler logic outside this package
3. App-specific wiring (Prisma adapters, Next.js routes) stays in `web/src/lib/` as thin shims
4. New AI/GPU features go here first, then get wired into the app via shims
5. No hard dependencies on Prisma, Redis, or Next.js — use DI interfaces

## Known Issues

- **Vast.ai**: Use `VastClient` with `runtype: 'args'` and port mapping via env dict (`'-p 8000:8000': '1'`). Tested & working (commit 6e656ee3). Do NOT use SkyPilot for Vast.ai — its static catalog is incompatible with the dynamic marketplace.
- **RunPod ports**: Never expose same port as both HTTP and TCP (`ports: ['8000/http', '8000/tcp']` → 404). Use `['8000/http', '22/tcp']`.
- **RunPod storage**: `storageGb: 0` = no volume/no dockerStartCmd override; `containerDiskInGb` minimum 10GB.

## Build

```bash
bun run build   # tsup → dist/ (ESM + CJS + .d.ts + sourcemaps)
```

Output: `dist/{module}.{js,cjs,d.ts,d.cts}` for each of the 12 entry points.
