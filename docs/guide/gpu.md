# GPU Management

The gateway autoscales GPU instances across multiple cloud providers — RunPod, Vast.ai, and Modal — with health checks, idle watchdog, and cost monitoring.

## Deploy a GPU

```typescript
const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });

// Non-blocking — pod is scheduled but not yet running
await gw.deployGpu({
  dockerImage: 'marcosremar/babelcast-subtitle:latest',
  gpuTypes: ['NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 5090'],
});

// Wait until /health 200 (blocks, throws on error/timeout)
await gw.waitForGpu(5000, 20 * 60_000);
```

## Provider Cascade

Providers are tried in order based on available credentials in `.env`:

```
RunPod → Vast.ai → Modal
```

Set at least one API key to enable GPU autoscaling:

```bash
RUNPOD_API_KEY=rpa_...
VAST_API_KEY=...
```

## GPU Types

GPU type names must match the provider allowlist exactly:

**RunPod:**
- `NVIDIA GeForce RTX 5090` — Blackwell (CUDA 12.8), fastest
- `NVIDIA GeForce RTX 4090` — Ada Lovelace
- `NVIDIA RTX A6000`, `NVIDIA L40S`, `NVIDIA RTX A5000`, `NVIDIA A40`

**Vast.ai:**
- `RTX 4090`, `RTX 3090`, `RTX A5000`, `A40`

## Docker Images

| Image | GPU Support | Models |
|---|---|---|
| `marcosremar/babelcast-subtitle:latest` | Universal (CUDA 12.8.1) | Gemma 4B Q8 + Whisper — runs on all GPUs |
| `marcosremar/babelcast-mistral:latest` | Standard | Mistral 7B |
| `marcosremar/babelcast-mistral:blackwell` | Blackwell only | Mistral 7B (CUDA 12.8) |

Universal images (CUDA 12.8.1 base) run on **all** GPUs — no GPU-specific swap needed.

## Pod Lifecycle

```typescript
// Stop (pause — preserves disk, billing stops)
await gw.stopGpu();

// Resume a stopped pod
await gw.resumeGpu();
await gw.resumeGpu('podId');   // specific pod

// Terminate (permanent delete — data lost)
await gw.terminateGpu(process.env.RUNPOD_API_KEY);
```

## Idle Watchdog

Pods auto-stop after 15 minutes of idle (no active sessions). Auto-destroy 2 hours after stop if not resumed. Configure via environment:

```bash
IDLE_TIMEOUT_MIN=15   # minutes before auto-stop (default: 15)
```

The container-level watchdog runs even without the gateway server running.

## Status & Monitoring

```typescript
const status = await gw.gpuStatus();
// {
//   status: 'RUNNING' | 'STOPPED' | 'BOOTING' | 'NONE',
//   podId: 'abc123',
//   endpoint: 'http://104.x.x.x:8000',
//   gpuType: 'NVIDIA GeForce RTX 4090',
//   gpuHealthy: true,
//   idleSec: 42,
//   provider: 'runpod',
// }

const logs      = await gw.gpuLogs();          // container stdout
const events    = await gw.gpuEventLogs(100);  // persistent JSONL event log
const offers    = await gw.gpuOffers();        // available GPUs by price
const instances = await gw.gpuList();          // all active instances
```

## Network Volumes (RunPod)

Network volumes persist across pod terminations — useful for HuggingFace model caches when using runtime model downloads:

```typescript
// Create a volume (one-time, per datacenter)
const vol = await rpClient.createNetworkVolume('parle-models', 100, 'EU-RO-1', { apiKey });

// Deploy with volume — HF cache survives pod death
await gw.deployGpu({
  dockerImage: 'marcosremar/babelcast-subtitle:latest',
  volumeId: vol.id,
});
```

::: warning Network volumes only help with runtime model downloads
Pre-baked images (like `babelcast-subtitle`) have models inside the image at `/app/models`. The image is still pulled on every cold boot — a volume gives **zero benefit** for pre-baked images. Use volumes only when restructuring images to download models lazily at runtime.
:::

## Cost Monitoring

```typescript
const stats = await gw.serviceStats();
// { totalSpendUsd, spendPerHr, activePods, ... }
```

Budget alerts are triggered automatically when spend per hour exceeds the configured threshold.
