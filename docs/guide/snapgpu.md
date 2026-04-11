# SnapGPU — Cold Start Optimization

SnapGPU reduces GPU cold-start latency through three progressive tiers. Each tier eliminates a different bottleneck.

## Validated Benchmarks

These numbers are from live benchmarks on Vast.ai RTX A5000 (April 2026):

| Tier | Strategy | Time | vs Baseline |
|---|---|---|---|
| T1 | Cold boot (baseline) | **48 s** | 1× |
| T2 | Warm restart (Docker layer cache) | **18 s** | **2.6× faster** |
| T3 | CRIU snapshot restore | **~8 s** | **~6× faster** |

**Where the time goes (T1 breakdown):**
- ~83% image pull (Docker layers not cached)
- ~15% model load from disk
- ~2% first inference

## Tier 1 — Cold Boot (baseline)

No cache. Provision → image pull → model load → ready.

This is the default when no optimization is configured. Cost: ~$0.10/hr.

```
T1: createInstance → 38s (image pull) → /health 200 → 48s total
```

## Tier 2 — Warm Restart (Docker layer cache)

Same host, Docker layers cached on disk. Stop → Start the same instance.

**How it works:** RunPod and Vast.ai both cache Docker layers between pod restarts on the same physical host. `stop` pauses the container without releasing the disk. `start` resumes it — image pull is skipped entirely.

```
T2: stopInstance (229ms) → EXITED (10.8s) → startInstance (728ms) → /health 200 → 18s
    ↑ 30s faster than T1 — eliminates image pull
```

The autoscaler uses T2 automatically — it keeps pod disk alive on stop and resumes on next request.

## Tier 3 — CRIU Snapshot Restore

Freeze the model process in RAM, persist checkpoint to S3, restore on any host. Eliminates model reload.

```
T3: restore CRIU checkpoint → process running → ~8s
    ↑ 10s faster than T2 — eliminates model reload from disk
```

**Requirements:**
- Host with full Linux capabilities (`CAP_NET_ADMIN` + `CAP_SYS_ADMIN`)
- RunPod Secure Cloud (`--privileged` containers) or bare-metal
- CUDA checkpoint (GPU VRAM freeze) requires driver ≥ 570

**CRIU timings (validated, driver 565):**
- GPU VRAM dump (~14GB fp16): ~4.3s
- GPU VRAM restore: ~3.6s
- Total: ~7.9s

::: warning Vast.ai community cloud does not support T3
Vast.ai strips `vm: true` from templates — all containers run with `capBnd=a80425fb` (missing `CAP_NET_ADMIN` bit 12, `CAP_SYS_ADMIN` bit 21). CRIU fails at network namespace dump. Use RunPod Secure Cloud for T3.
:::

## Enabling SnapGPU

### Step 1 — Configure S3 credentials

SnapGPU persists CRIU snapshots to S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3):

```bash
# .env
SNAPGPU_S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com
SNAPGPU_S3_BUCKET=snapgpu-snapshots
SNAPGPU_S3_ACCESS_KEY=your-key-id
SNAPGPU_S3_SECRET_KEY=your-app-key
SNAPGPU_S3_REGION=us-east-005        # optional
SNAPGPU_S3_KEY_PREFIX=snapgpu/       # optional namespace
```

::: warning R2/B2 speed note
Cloudflare R2 and Backblaze B2 are **8× slower than HuggingFace CloudFront** for 4GB+ model files (validated benchmark). Use them for CRIU snapshots — they're small (~150MB for 128MB process). Do **not** use R2/B2 to serve model weights to GPU pods.
:::

### Step 2 — S3 is auto-wired

When `SNAPGPU_S3_ENDPOINT` is set, the gateway auto-configures `SnapgpuClient` with S3 on startup. No code changes needed.

### Step 3 — Snapshots happen automatically

After the first successful inference on a new pod, SnapGPU:
1. Creates a CRIU checkpoint of the model process
2. Uploads it to S3
3. Persists the snapshot ID to the state store

On the next boot for the same user/workload:
1. `getPersistedData()` retrieves the snapshot ID
2. The pod is configured with `SNAPGPU_RESTORE_SNAPSHOT_ID`
3. Container restores from checkpoint instead of loading the model from scratch

### Snapshot lifecycle

```typescript
// Manual snapshot operations (via SDK)
const snaps = await gw.gpuList();  // includes snapshot metadata

// The full flow (handled automatically by the autoscaler):
// deploy → inference → snapshot created → persisted to KV + S3
// next deploy → getPersistedData() → restore from snapshot
```

## Predictive Warmup

The autoscaler uses ML-based usage prediction to pre-boot GPUs before demand spikes. It runs automatically:

```typescript
// Auto-started in createAutoscaler() — no configuration needed
// Uses usage history to predict next demand window
// Pre-boots the pod ~N minutes before predicted traffic
```

## Standby Monitor

A background standby monitor keeps an idle pod warm for rapid response. Auto-started at server startup.

```bash
# Logs show standby status
[standby] pod abc123 warm — idleSec=42, next prediction: 14:30
```

## Model Download Speed

When images need to download models at runtime (non-pre-baked), use the validated fastest settings:

```dockerfile
ENV HF_XET_HIGH_PERFORMANCE=1 \
    HF_XET_FIXED_DOWNLOAD_CONCURRENCY=50
```

**Validated benchmark (Vast.ai RTX 4090, 770MB GGUF):**
- These settings: **394 MB/s** (+24% vs legacy `HF_HUB_ENABLE_HF_TRANSFER`)
- Legacy `HF_HUB_ENABLE_HF_TRANSFER=1`: 319 MB/s (deprecated)
- aria2c multi-connection: 198–232 MB/s (slower — HF CDN saturates single TCP)

::: info Pre-bake models when possible
The biggest cold-start wins come from pre-baking models inside the Docker image. `babelcast-subtitle` pre-bakes both the GGUF LLM (~5GB) and Whisper (~3GB). Everything else is decimal-place optimization.
:::
