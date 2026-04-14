# Error Category System — Complete Reference

> **Date:** 2026-04-13
> **Based on:** Real-world error patterns from Vast.ai, RunPod, Docker Hub, NVIDIA/CUDA, and LLM deployment

---

## 10 Categories, 60+ Error Codes

| Category | Icon | Code Prefix | Count | Retryable? | Description |
|----------|------|-------------|-------|------------|-------------|
| VALIDATION | ⚠️ | VLD-* | 7 | ❌ No | Input/config/validation errors |
| RESOURCE | 📦 | RES-* | 6 | ❌ No | OOM, disk full, VRAM, swap |
| NETWORK | 🌐 | NET-* | 6 | ✅ Yes | DNS, timeout, rate limit, connection |
| PROVIDER | ☁️ | PRV-* | 7 | ✅ Yes | Provider API, auth, offers |
| CONTAINER | 🐳 | CNT-* | 8 | ❌ No | Docker image, pull, runtime |
| GPU_HARDWARE | 🎮 | GPU-* | 6 | ❌ No | CUDA, driver, ECC, thermal |
| SECURITY | 🔒 | SEC-* | 5 | ❌ No | Auth, credentials, TLS, SSH |
| STATE | 🔄 | ST-* | 6 | ✅ Yes | Race, stuck, orphan, ghost |
| COST | 💰 | CST-* | 4 | ❌ No | Budget, price, runaway |
| INFRASTRUCTURE | 🏗️ | INF-* | 6 | ✅ Yes | Host power, reclaim, zombie |

---

## Complete Error Code Reference

### VALIDATION (7 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| VLD_INVALID_INPUT | 400 | ⚠️ warn | Generic validation failure |
| VLD_MISSING_FIELD | 400 | ⚠️ warn | Missing gpuTypes, dockerImage, apiKey |
| VLD_INVALID_FORMAT | 422 | ⚠️ warn | Bad GPU type name or Docker image format |
| VLD_PREFLIGHT_FAILED | 400 | ❌ error | Image, CUDA, DNS, or cost pre-flight failure |
| VLD_GPU_INCOMPATIBLE | 400 | ❌ error | CUDA version or VRAM mismatch |
| VLD_IMAGE_UNAVAILABLE | 400 | ❌ error | Image does not exist or private without auth |
| VLD_SPEND_RATE_LIMIT | 429 | ⚠️ warn | Vast.ai "spend_rate_limit" on new accounts |

### RESOURCE (6 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| RES_CUDA_OOM | 507 | 🔴 critical | PyTorch "CUDA out of memory" during model load |
| RES_HOST_OOM | 507 | 🔴 critical | Linux OOM killer during model loading |
| RES_DISK_FULL | 507 | 🔴 critical | ENOSPC during model download or Docker pull |
| RES_VRAM_INSUFFICIENT | 400 | ❌ error | 70B model on 24GB GPU without quantization |
| RES_SWAP_THRASHING | 503 | ❌ error | Host using swap during model load |
| RES_CPU_LIMIT | 503 | ⚠️ warn | All CPU cores saturated |

### NETWORK (6 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| NET_DNS_FAILURE | 502 | ❌ error | ENOTFOUND/EAI_AGAIN for provider API |
| NET_TIMEOUT | 504 | ⚠️ warn | ETIMEDOUT or AbortError |
| NET_DOCKER_HUB_RATE_LIMIT | 429 | ❌ error | **Docker Hub 429: 100 pulls/6h anonymous, 200/6h authenticated** |
| NET_PROVIDER_RATE_LIMIT | 429 | ⚠️ warn | Vast.ai/RunPod API 429 |
| NET_CONNECTION_REFUSED | 502 | ❌ error | ECONNREFUSED |
| NET_BANDWIDTH_LOW | 400 | ⚠️ warn | Host internet <500 Mbps |

### PROVIDER (7 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| PRV_API_ERROR | 502 | ❌ error | Generic 5xx from provider API |
| PRV_AUTH_FAILED | 401 | 🔴 critical | Invalid API key, 401/403 |
| PRV_OFFER_UNAVAILABLE | 404 | ⚠️ warn | Offer disappeared between list and create |
| PRV_TEMPLATE_FAILED | 502 | ❌ error | Vast.ai template list/create failure |
| PRV_NO_GPUS | 404 | ⚠️ warn | 0 offers matched after filters |
| PRV_API_KEY_EXPIRED | 401 | 🔴 critical | Key expired mid-deploy |
| PRV_SCHEDULING_STUCK | 504 | ⚠️ warn | **Vast.ai stuck in "scheduling"** — conflicting jobs |

### CONTAINER (8 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| CNT_IMAGE_NOT_FOUND | 404 | ❌ error | "manifest unknown" or "pull access denied" |
| CNT_PORT_CONFLICT | 409 | ❌ error | EADDRINUSE |
| CNT_RUNTIME_CRASH | 500 | 🔴 critical | Docker daemon/containerd crash |
| CNT_HEALTHCHECK_FAIL | 503 | ❌ error | **HEALTHCHECK fail → Vast.ai auto-destroy** |
| CNT_PULL_FAILED | 502 | ❌ error | Pull timeout, auth, or manifest error |
| CNT_START_FAILED | 500 | ❌ error | Container exits immediately |
| CNT_PULL_BACKOFF | 502 | ❌ error | Kubernetes-style ImagePullBackOff |
| CNT_GPU_DRIVER_MISSING | 400 | ❌ error | **"could not select device driver"** — nvidia-container-toolkit missing |

### GPU_HARDWARE (6 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| GPU_CUDA_MISMATCH | 400 | ❌ error | Container CUDA 12.8, host driver 12.4 |
| GPU_DRIVER_MISMATCH | 400 | ❌ error | **"Failed to initialize NVML: Driver/library version mismatch"** |
| GPU_ECC_ERROR | 500 | 🔴 critical | Xid errors (31, 43, 48, 79) |
| GPU_THERMAL_THROTTLE | 503 | ⚠️ warn | GPU >85°C on consumer hosts |
| GPU_HARDWARE_FAULT | 500 | 🔴 critical | PCIe error, device vanished |
| GPU_NVML_FAILURE | 500 | ❌ error | **"NVIDIA-SMI has failed"** |

### SECURITY (5 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| SEC_AUTH_BYPASS | 403 | 🔴 critical | Deploy without valid auth |
| SEC_CREDENTIAL_LEAK | 500 | 🔴 critical | API key in error output |
| SEC_TLS_FAILURE | 502 | 🔴 critical | Certificate expired or wrong hostname |
| SEC_UNAUTHORIZED | 401 | ❌ error | 401/403 |
| SEC_SSH_KEY_DENIED | 403 | ❌ error | **"Permission denied (publickey)"** |

### STATE (6 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| ST_RACE_CONDITION | 409 | ⚠️ warn | Two concurrent deploys |
| ST_STUCK_DEPLOY | 504 | ❌ error | No status change in 15+ min |
| ST_ORPHANED_INSTANCE | 409 | ⚠️ warn | Instance exists but no deploy record |
| ST_DUPLICATE_REQUEST | 200 | ℹ️ info | User double-clicks deploy |
| ST_GHOST_MACHINE | 500 | ❌ error | No container started after timeout |
| ST_INSTANCE_EXITED | 500 | ❌ error | Container exited with non-zero code |

### COST (4 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| CST_BUDGET_EXCEEDED | 429 | ❌ error | Total spend > budget |
| CST_PRICE_CHANGE | 400 | ⚠️ warn | Price changed between quote and create |
| CST_RUNAWAY_SPENDING | 429 | 🔴 critical | Spend rate 3x higher than normal |
| CST_UNREASONABLE_PRICE | 400 | ⚠️ warn | Price > $5/hr |

### INFRASTRUCTURE (6 codes)

| Code | HTTP | Severity | Real-World Pattern |
|------|------|----------|-------------------|
| INF_HOST_POWER_LOSS | 502 | 🔴 critical | Consumer GPU host lost power |
| INF_HOST_RECLAIM | 502 | ❌ error | Vast.ai host reclaimed instance |
| INF_INSTANCE_STUCK | 504 | ❌ error | **Instance stuck in "creating"** — never gets IP |
| INF_CONTAINER_RUNTIME_CRASH | 500 | 🔴 critical | Docker daemon crash on host |
| INF_ZOMBIE_PROCESS | 409 | ⚠️ warn | Previous deploy left defunct processes |
| INF_CREDIT_ZERO | 402 | ❌ error | **Vast.ai auto-stops when credit = 0** |

---

## Usage

### Basic Usage

```typescript
import { categorizeDeployError } from '@ai-gateway/errors/deploy-errors';

try {
  await deployGpu(config);
} catch (err) {
  const deployErr = categorizeDeployError(err);

  // Category
  console.log(deployErr.category); // 'CONTAINER'

  // Specific error code
  console.log(deployErr.code); // 'CNT_IMAGE_NOT_FOUND'

  // Should we retry?
  console.log(deployErr.retryable); // false

  // HTTP status for API response
  console.log(deployErr.httpStatus); // 404

  // User-friendly message with action
  console.log(deployErr.userMessage);
  // "🐳 Container Error: Docker image not found: my-llm:latest
  //  → Verify Docker image exists, nvidia-container-toolkit is installed..."

  // JSON for API
  res.status(deployErr.httpStatus).json(deployErr.toJSON());
}
```

### Factory Functions

```typescript
import { validationError, resourceError, networkError, containerError, gpuError } from '@ai-gateway/errors/deploy-errors';

// Quick error creation
throw validationError('VLD_MISSING_FIELD', { field: 'gpuTypes' });
throw resourceError('RES_CUDA_OOM', { used: 22, total: 24, model: '70B' });
throw networkError('NET_DOCKER_HUB_RATE_LIMIT', {});
throw containerError('CNT_IMAGE_NOT_FOUND', { image: 'my-llm:latest' });
throw gpuError('GPU_DRIVER_MISMATCH', {});
```

### Error Summary

```typescript
import { summarizeErrors } from '@ai-gateway/errors/deploy-errors';

const errors = deployErrors.map(categorizeDeployError);
const summary = summarizeErrors(errors);

console.log(summary.byCategory); // { RESOURCE: 5, NETWORK: 2, ... }
console.log(summary.bySeverity); // { critical: 3, error: 8, ... }
console.log(summary.retryableCount); // 3
console.log(summary.topErrors); // Top 10 most frequent errors
```

---

## Category Metadata Reference

| Category | Icon | Retryable? | Suggested Action |
|----------|------|------------|-----------------|
| VALIDATION | ⚠️ | ❌ No | Fix the input/configuration and retry. |
| RESOURCE | 📦 | ❌ No | Use a larger GPU, reduce model size, or add quantization. |
| NETWORK | 🌐 | ✅ Yes | Check network connection, authenticate for Docker Hub, and retry. |
| PROVIDER | ☁️ | ✅ Yes | Check provider status, credentials, and GPU availability. |
| CONTAINER | 🐳 | ❌ No | Verify Docker image, nvidia-container-toolkit, and configuration. |
| GPU_HARDWARE | 🎮 | ❌ No | Try a different GPU or host. Check driver compatibility. |
| SECURITY | 🔒 | ❌ No | Check API credentials, SSH keys, and TLS configuration. |
| STATE | 🔄 | ✅ Yes | Clean up orphaned resources and retry. |
| COST | 💰 | ❌ No | Review budget settings, pricing, and spending limits. |
| INFRASTRUCTURE | 🏗️ | ✅ Yes | Try a different host or provider. Check account credits. |
