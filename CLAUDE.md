# AI Gateway (`@parle/ai-gateway`) — Claude Code Guidelines

## Purpose

Standalone workspace package — the **single source of truth** for all GPU, AI provider, autoscaler, benchmarking, and infra code. Do not put AI/GPU logic in `gateway-server.ts` directly.

## Commands

```bash
bun install
bun run build   # tsup → dist/ (ESM + CJS + .d.ts for 12 entry points)
bun run test    # Vitest
```

## API — How to call it

### HTTP (from Python or any client)

```bash
# Full STT → LLM → TTS pipeline (only supported audio endpoint)
POST /v1/speech?source=fr&target=en&speaker=Ryan  Content-Type: audio/wav
# → { transcription, response, audio_base64, content_type, timing: { total_ms, used_gpu } }

# OpenAI-compatible individual stages
POST /v1/audio/transcriptions   # STT (multipart/form-data)
POST /v1/chat/completions       # LLM (application/json)
POST /v1/audio/speech           # TTS (application/json)
```

SSE, WebSocket (`/ws/stream`), and WebRTC are **blocked** — return 410 Gone. Never write client code for them.

### TypeScript (programmatic)

```typescript
import { createAIClient } from '@ai-gateway/client';

const client = createAIClient({ registry, gpuRegistry, defaultProfile });

// Transport-transparent: tries GPU first, falls back to cloud
const result = await client.pipeline(audioBuffer, systemPrompt);
// { stt: { text }, chat: { content }, tts: { audio, contentType }, totalLatencyMs, usedGpu }

const stt = await client.transcribe(audioBuffer);
const chat = await client.chat(messages);
const tts = await client.synthesize(text);
```

## Architecture Rules

1. All GPU/AI/autoscaler/benchmarking code lives **here** — never in `src/lib/` or host app
2. No hard dependencies on Prisma, Redis, or Next.js — use DI interfaces (`AutoscalerDeps`)
3. App-specific wiring (Prisma adapters, Next.js routes) stays in host app as thin shims
4. New AI/GPU features go here first, then get wired via shims

## Dependency Injection Pattern

```typescript
interface AutoscalerDeps {
  settingsStore: SettingsStore;
  stateStore: StateStore;           // KV + list + hash ops
  sessionResolver: SessionResolver; // count active sessions
  logger?: Logger;
  credentialStore?: CredentialStore;
}

// Recommended factory
const gateway = createGateway({ storage, stateStore?, hooks? });
gateway.handleGet(userId);
gateway.handleAction(userId, action, body);
```

## GPU Machine Deployment

**Always use the ai-gateway to deploy/start GPU machines** — never provision raw cloud VMs manually. The ai-gateway handles port mapping, health checks, Docker image selection, and provider failover automatically. This also serves as an integration test for the ai-gateway package itself.

```bash
# Deploy via gateway (requires gateway running: bun run gateway-server.ts)
POST http://localhost:4000/v1/gpu/deploy
Body: {"dockerImage": "marcosremar/babelcast-mistral:latest", "gpuTypes": ["NVIDIA GeForce RTX 4090"]}

# For Blackwell GPUs (RTX 5090/5080):
Body: {"dockerImage": "marcosremar/babelcast-blackwell-mistral:latest", "gpuTypes": ["NVIDIA GeForce RTX 5090"]}

# Check status
GET http://localhost:4000/v1/gpu/status
```

- Provider order: TensorDock → Vast.ai → Modal (based on available credentials in `.env`)
- GPU type names must match allowlist exactly (see `PREFERRED_GPU_TYPES` in `gateway-server.ts`)
- Vast.ai key: `VAST_API_KEY` in `.env`
- TensorDock keys: `TENSORDOCK_API_KEY` + `TENSORDOCK_AUTH_ID` in `.env`
- Cooldowns persist in `~/.babelcast/cooldowns.json` — delete to clear stuck cooldowns

## Web UI Component Library (`web/src/components/ui/`)

**All new UI code MUST use these components.** Do not re-implement inline.

| Component | Import | Usage |
|-----------|--------|-------|
| `IconBox` | `import { IconBox } from '@/components/ui'` | Colored icon in rounded box. Props: `icon`, `color`, `size` (xs/sm/md/lg). **Never** write inline `div` with `color-mix` + icon — use this. |
| `DropdownList` | `import { DropdownList } from '@/components/ui'` | Custom dropdown with icons, groups, portal rendering. Replace all native `<select>` with this for styled dropdowns. Props: `options`, `value`, `onChange`, `accent`, `onClose`, `autoOpen`. |
| `KV` | `import { KV } from '@/components/ui'` | Key-value display row. Props: `label`, `value`, `mono?`. **Never** write inline flex label+value pairs — use this. |
| `StatusDot` | `import { StatusDot } from '@/components/ui'` | Colored status indicator. Props: `status` (ready/online/booting/warning/error/offline/idle), `size`, `label?`. **Never** write inline colored dots — use this. |
| `Button` | `import { Button } from '@/components/ui'` | Styled button with variants (primary/outline/danger) and loading state. |
| `Toggle` | `import { Toggle } from '@/components/ui'` | On/off switch. Props: `checked`, `onChange`, `size`. |
| `FormInput` | `import { FormInput } from '@/components/ui'` | Labeled text input. |
| `FormSelect` | `import { FormSelect } from '@/components/ui'` | Labeled native select (use `DropdownList` for rich dropdowns). |
| `Card` / `CardHeader` / `CardBody` | `import { Card, CardHeader, CardBody } from '@/components/ui'` | Content containers. |
| `SectionHeader` | `import { SectionHeader } from '@/components/ui'` | Page section title + subtitle. |
| `SaveBar` | `import { SaveBar } from '@/components/ui'` | Sticky bottom save/discard bar. |
| `ConfirmModal` | `import { ConfirmModal } from '@/components/ui'` | Confirmation dialog. |
| `Spinner` | `import { Spinner } from '@/components/ui'` | Loading indicator. |
| `StatusBadge` | `import { StatusBadge } from '@/components/ui'` | Success/Pending/Error badge pill. |
| `TabNav` | `import { TabNav } from '@/components/ui'` | Tab switcher. |
| `AlertBanner` | `import { AlertBanner } from '@/components/ui'` | Alert messages. |

### Provider icon registry (for pipeline/service UIs)

```typescript
import { PROVIDER_ICON } from '@/sections/FallbackChainList';
// { gpu: { icon: Cpu, color: '#f59e0b' }, groq: { icon: Zap, color: '#7ba896' }, ... }
```

## Key Gotchas

- **RunPod ports**: never expose same port as both HTTP and TCP — use `['8000/http', '22/tcp']`
- **RunPod storage**: `storageGb: 0` = no volume; `containerDiskInGb` minimum 10GB
- **Vast.ai**: use `VastClient` with `runtype: 'args'` and port env dict. Do NOT use SkyPilot for Vast.ai
- GPU type names in deploy requests must match allowlist exactly (e.g. `"NVIDIA GeForce RTX 5090"`)
