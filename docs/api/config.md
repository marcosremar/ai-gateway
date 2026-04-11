# Configuration Reference

## Environment Variables

All configuration is via `.env` at the project root.

### AI Providers

```bash
GROQ_API_KEY=gsk_...
OPENAI_API_KEY=sk-...
FIREWORKS_API_KEY=fw_...
OPENROUTER_API_KEY=sk-or-...
MODAL_API_KEY=...
```

### GPU Providers

```bash
# RunPod (primary)
RUNPOD_API_KEY=rpa_...

# Vast.ai
VAST_API_KEY=...

# TensorDock
TENSORDOCK_API_KEY=...
TENSORDOCK_AUTH_ID=...

# Docker Hub (avoids Vast.ai pull rate limits)
DOCKERHUB_USERNAME=marcosremar
DOCKERHUB_TOKEN=...
```

### SnapGPU (S3-compatible storage for CRIU snapshots)

```bash
SNAPGPU_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
SNAPGPU_S3_BUCKET=snapgpu-snapshots
SNAPGPU_S3_ACCESS_KEY=your-key-id
SNAPGPU_S3_SECRET_KEY=your-app-key
SNAPGPU_S3_REGION=us-east-005     # optional
SNAPGPU_S3_KEY_PREFIX=snapgpu/    # optional
```

### Autoscaler

```bash
IDLE_TIMEOUT_MIN=15       # minutes before auto-stop (default: 15)
```

### Server

```bash
PORT=4000                 # HTTP server port
```

---

## Module Entry Points

12 independent, tree-shakeable entry points:

```typescript
import { createGateway }          from '@parle/ai-gateway';
import { AIProviderRegistry }     from '@parle/ai-gateway/providers';
import { createAutoscaler }       from '@parle/ai-gateway/autoscaler';
import { GpuProviderRegistry }    from '@parle/ai-gateway/gpu-providers';
import { createAIClient }         from '@parle/ai-gateway/client';
import { InMemoryStateAdapter }   from '@parle/ai-gateway/adapters';
import { RedisStateAdapter }      from '@parle/ai-gateway/adapters';
import { signGpuToken }           from '@parle/ai-gateway/auth';
import { verifyGpuToken }         from '@parle/ai-gateway/auth';
// Also: /handlers, /tracking, /infra, /benchmarking,
//       /vault, /observability, /alerting, /caching, /proxy
```

---

## Storage Adapters

The gateway uses dependency injection for storage. Implement these interfaces:

```typescript
interface SettingsStore {
  get(userId: string, key: string): Promise<string | null>;
  set(userId: string, key: string, value: string): Promise<void>;
  delete(userId: string, key: string): Promise<void>;
}

interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  // List, hash, and pub/sub ops for autoscaler coordination
}
```

**Built-in adapters:**

```typescript
import { InMemoryStateAdapter, RedisStateAdapter } from '@parle/ai-gateway/adapters';

// Development / single-instance
const stateStore = new InMemoryStateAdapter();

// Production (Redis or Upstash)
const stateStore = new RedisStateAdapter({ url: process.env.REDIS_URL });
```

---

## Cooldowns

Provider cooldowns persist in `~/.babelcast/cooldowns.json`. Delete this file to clear stuck cooldowns:

```bash
rm ~/.babelcast/cooldowns.json
```

## RunPod Quota Tracking

RunPod quota block events are tracked in `~/.babelcast/runpod-quota.json`. After 3 quota blocks within 24 hours, the benchmark scripts will automatically print support escalation instructions.
