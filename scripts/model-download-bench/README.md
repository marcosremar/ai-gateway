# Model Download Optimization for Vast.ai

## Problem

Cold boot times on Vast.ai are dominated by model downloads:

| Model | Size | Current Method | Boot Time Impact |
|-------|------|----------------|-----------------|
| FLUX.1-dev (DiT360) | ~24GB | Runtime HF download | **+10-15 min** |
| Whisper large-v3-turbo | ~3GB | Runtime HF download | **+2-3 min** |
| TranslateGemma GGUF | ~5GB | Pre-baked (build) | 0 (but slow image pull) |
| Ultravox 8B | ~16GB | Pre-baked (build) | 0 (but 17GB image) |

## Optimization Strategies

### 1. aria2c Multi-Connection (FREE, biggest impact)

HuggingFace CDN supports partial content (Range headers). Using aria2c with 16 connections typically gives **3-8x speedup** over single-connection downloads.

```bash
# Instead of:
curl -L -o model.gguf https://huggingface.co/repo/resolve/main/model.gguf
# 5GB @ 100 MB/s = 50s

# Use:
aria2c -x16 -s16 -k10M --file-allocation=none \
  --max-connection-per-server=16 \
  -o model.gguf \
  "https://huggingface.co/repo/resolve/main/model.gguf"
# 5GB @ 400-800 MB/s = 6-12s
```

**Cost: $0** — just install `apt-get install aria2` in Dockerfile.

### 2. Backblaze B2 + Cloudflare CDN ($5/TB/month)

Upload models to B2, front with Cloudflare (free bandwidth alliance = **$0 egress**).

**Setup:**
1. Create B2 bucket → upload models
2. Connect Cloudflare domain → B2 bucket
3. Models served from Cloudflare's global CDN (300+ PoPs)

**Advantages:**
- Cloudflare CDN is often faster than HF CDN for GPU datacenters
- No egress fees (Cloudflare Bandwidth Alliance with B2)
- Supports Range headers → works with aria2c multi-connection
- Storage: $5/TB/month (vs $0 for HF, but gives you control)

### 3. Cloudflare R2 ($15/TB/month, zero egress)

S3-compatible storage with zero egress fees. Higher storage cost than B2 but simpler setup.

**Advantages:**
- Native Cloudflare CDN (no separate setup)
- S3-compatible API
- Zero egress, ever
- Custom domains supported

### 4. Pre-bake ALL models in Docker image

Eliminates runtime downloads entirely. Trade-off: larger image, slower pull.

**When it makes sense:**
- Models < 10GB total: pre-bake always
- Vast.ai image pull is faster than HF download (usually)
- Docker layer caching helps on repeated deployments

**Implemented in:** `Dockerfile.babelcast-optimized` (pre-bakes Whisper too)

### 5. zstd Compression (20-40% size reduction)

GGUF models compress well with zstd:
```bash
# Compress (one-time, during upload)
zstd -19 -T0 model.gguf -o model.gguf.zst
# 5GB → ~3.5GB (30% smaller)

# Download + decompress at boot
aria2c -x16 ... model.gguf.zst && zstd -d model.gguf.zst
```

**Not useful for:** safetensors, already-quantized models (low entropy)

### 6. Vast.ai Network Volumes (persistent cache)

Already partially implemented in `start.sh`. On subsequent boots of the same host, models are served from local disk.

```bash
# Already in ultravox start.sh:
if [ -d "/workspace/models" ]; then
    # Symlink cached models into HF cache
fi
```

## Recommendation Matrix

| Scenario | Best Strategy | Expected Speedup |
|----------|--------------|-----------------|
| **BabelCast (new host)** | aria2c x16 from HF + pre-bake Whisper | 4-8x faster boot |
| **BabelCast (same host)** | Network volume cache (already done) | ~0s (cached) |
| **DiT360 (24GB FLUX)** | B2/R2 CDN + aria2c x16 | 3-5x faster |
| **Ultravox (17GB pre-baked)** | Keep pre-baked, smaller base image | Image pull 20% faster |
| **Budget-conscious** | aria2c only (free) | 3-8x |
| **Maximum speed** | R2 CDN + aria2c x16 + zstd | 5-10x |

## Scripts

| Script | Purpose |
|--------|---------|
| `benchmark.sh` | Run locally or in container — tests all download methods |
| `vast-benchmark.sh` | Auto-deploys to Vast.ai, runs benchmark, reports results |
| `upload-models.sh` | Upload models to B2 or R2 |
| `fast-model-download.sh` | Drop-in download helper with CDN fallback chain |
| `Dockerfile.babelcast-optimized` | BabelCast with aria2c + pre-baked Whisper |

## Quick Start

```bash
# 1. Run benchmark on Vast.ai (uses real GPU host network)
export VAST_API_KEY=<key>
./vast-benchmark.sh

# 2. If B2/R2 is faster, upload models
export B2_APPLICATION_KEY_ID=<id>
export B2_APPLICATION_KEY=<key>
COMPRESS=1 ./upload-models.sh b2

# 3. Re-run benchmark with B2 URLs
B2_URL=https://f005.backblazeb2.com/file/parle-models/babelcast/translategemma-4b-it-Q8_0.gguf \
./vast-benchmark.sh

# 4. Build optimized Docker image
docker build -f Dockerfile.babelcast-optimized \
  --build-arg CDN_BASE_URL=https://f005.backblazeb2.com/file/parle-models \
  -t babelcast-subtitle:fast \
  ../babelcast-subtitle/
```

## Expected Results (typical Vast.ai host with 1Gbps)

| Method | ~5GB GGUF | ~24GB FLUX |
|--------|-----------|-----------|
| HF Hub (no transfer) | ~60s | ~300s |
| HF Hub (hf_transfer) | ~40s | ~200s |
| curl (HF CDN) | ~50s | ~250s |
| aria2c x4 (HF CDN) | ~20s | ~100s |
| aria2c x16 (HF CDN) | ~10s | ~50s |
| aria2c x16 (R2/B2) | ~8s | ~40s |
| aria2c x16 + zstd (R2) | ~6s | ~35s |

*Actual speeds depend on host location and network. Run the benchmark to get real numbers.*
