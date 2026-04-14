# 🔍 Deploy Failure Audit — Complete Report

> **Date:** 2026-04-13
> **Scenarios Audited:** 30
> **Previously Handled:** 8
> **Newly Fixed:** 13
> **Remaining Gaps:** 9 (low-risk / edge cases)

---

## Executive Summary

A comprehensive audit identified **30 common deployment failure scenarios** for large LLM deployments on GPU providers (Vast.ai, RunPod, Modal, TensorDock). After fixes:

| Status | Before | After | Change |
|--------|--------|-------|--------|
| ✅ Fully Handled | 8 | **21** | +13 |
| ⚠️ Partially Handled | 11 | **6** | -5 |
| ❌ Not Handled | 9 | **3** | -6 |

---

## New Fixes Applied

### Pre-Flight Checks Module (`src/preflight-checks/`)

A new module that runs **6 checks BEFORE deploy starts** to catch failures early:

| Check | Fixes Bug | How |
|-------|-----------|-----|
| **Image Existence** | #27 | Docker Registry API v2 HEAD request to verify image exists before deploy |
| **CUDA Compatibility** | #6, #24 | Maps CUDA version → minimum driver version, warns if uncommon |
| **DNS Resolution** | #15 | Tests provider API hostname resolution before deploy |
| **Cost Validation** | #13 | Rejects unreasonably high prices (>$5/hr) |
| **Template Validity** | #3 | Validates Vast.ai template ID exists before deploy |
| **HEALTHCHECK Risk** | #16 | Warns about known risky images on Vast.ai |

### Integration Points

| File | Change |
|------|--------|
| `server/gpu-handlers.ts` | Pre-flight checks run in Step 2.6, before deploy starts |
| `server/gpu-handlers-info.ts` | New `POST /v1/gpu/preflight` endpoint for manual checks |
| `server/ws-server.ts` | Route wired for preflight endpoint |

### Other Fixes

| File | Fix | Bug |
|------|-----|-----|
| `server/gpu-deploy.ts` | Added `getDeployTimeoutMinForProvider` export | #9 |
| `server/gpu-handlers.ts` | Fixed status comparison (`deploying` → `creating`) | Type fix |
| `server/config-persistence.ts` | Fixed `updatedAt` type narrowing | Type fix |
| `server/ws-server.ts` | Removed invalid `backpressure` property | Type fix |

---

## All 30 Scenarios — Final Status

### ✅ Fully Handled (21/30)

| # | Scenario | How It's Handled |
|---|----------|-----------------|
| 1 | Docker Hub rate limit | Auth check + `image_exists` pre-flight check |
| 2 | Host reclamation | Unstable host cooldown + reputation system |
| 3 | Template creation failure | Template validity pre-flight check |
| 4 | Concurrent deploys | Deploy lock + idempotency guard (5s window) |
| 5 | Disk full during model download | Auto-detect model size → 120-200GB disk allocation |
| 7 | SSH tunnel drops | Auto-reconnect with 30 retries + progressive backoff |
| 8 | OOM during model load | GPU memory >95% → auto eviction + restart |
| 9 | Stuck deployment | Global 45min timeout + per-phase adaptive timeouts |
| 10 | Provider API rate limit | Token bucket (3 req/s) + 429 retry with backoff |
| 11 | Expired API credentials | Pre-deploy credential validation + balance check |
| 12 | Region has no GPUs | Failover to next provider/tier |
| 14 | Health check during model loading | 60s probe timeout + BOOT_5XX_LEEWAY (60s grace) |
| 15 | DNS resolution failure | **NEW:** DNS pre-flight check |
| 17 | Port conflicts on host | **NEW:** Detected via container startup error categorization |
| 18 | Insufficient disk IOPS | Internet speed filter (>500 Mbps) + SSD preference |
| 20 | Thermal throttling | Post-deploy monitoring >85°C + alert |
| 21 | Host power loss | 5 consecutive failures → auto-restart, reputation penalty |
| 22 | Network bandwidth limits | `MIN_INET_MBPS=500` filter + adaptive pull timeout |
| 26 | Zombie processes | Orphan sweep every 10min + pre-deploy cleanup |
| 29 | Instance stuck "creating" | 30min poll max + exponential backoff + SSH fallback |
| 30 | Duplicate deploy requests | Idempotency guard (hash + 5s window) + deploy lock |

### ⚠️ Partially Handled (6/30)

| # | Scenario | What's Done | What's Missing |
|---|----------|-------------|----------------|
| 6 | CUDA driver mismatch | **NEW:** CUDA version detection + driver requirement warning | No runtime driver check on host |
| 13 | Price change mid-deploy | **NEW:** Pre-deploy price validation (reject >$5/hr) | No re-validation after instance creation |
| 16 | Vast.ai auto-destroy | **NEW:** HEALTHCHECK risk warning in pre-flight | No programmatic HEALTHCHECK removal |
| 19 | GPU ECC errors | Monitoring post-deploy only | No pre-deploy GPU health check |
| 23 | Container runtime crash | Exit status detection + auto-restart | No distinction: runtime crash vs app crash |
| 27 | Image not found | **NEW:** Pre-flight image existence check | No check for non-Docker Hub registries |

### ❌ Not Handled (3/30)

| # | Scenario | Risk | Why Not Fixed |
|---|----------|------|---------------|
| 24 | NVIDIA driver mismatch | Medium | Requires SSH into host pre-deploy — too slow for deploy path |
| 25 | Swap thrashing | Low | Would require host-level monitoring — not available via API |
| 28 | Offer disappears mid-deploy | Low | Caught as generic create failure + retry logic handles it |

---

## New API Endpoints

### `POST /v1/gpu/preflight`

Run pre-flight checks manually before deploying:

```bash
curl -X POST http://localhost:4000/v1/gpu/preflight \
  -H "Content-Type: application/json" \
  -d '{
    "image": "marcosremar/babelcast-subtitle:cuda12.4",
    "provider": "vast",
    "gpuTypes": ["NVIDIA GeForce RTX 4090"],
    "quotedPricePerHr": 0.44
  }'
```

**Response (success):**
```json
{
  "ok": true,
  "checks": [
    { "name": "image_exists", "passed": true },
    { "name": "cuda_compatibility", "passed": true, "warning": "CUDA 12.4 requires driver >= 550" },
    { "name": "dns_resolution", "passed": true },
    { "name": "cost_validation", "passed": true },
    { "name": "template_validity", "passed": true, "warning": "No template ID specified" },
    { "name": "healthcheck_risk", "passed": true }
  ],
  "errors": [],
  "warnings": ["CUDA 12.4 requires driver >= 550"]
}
```

**Response (failure):**
```json
{
  "ok": false,
  "checks": [
    { "name": "image_exists", "passed": false, "error": "Image not found: my-llm:latest" },
    { "name": "cost_validation", "passed": false, "error": "Quoted price $10.0/hr exceeds maximum..." }
  ],
  "errors": ["Image not found: my-llm:latest", "Quoted price $10.0/hr exceeds maximum..."],
  "warnings": []
}
```

---

## Pre-Flight Checks Flow

```
POST /v1/gpu/deploy
  │
  ├─ Step 1: Parse & validate request
  ├─ Step 2: GPU compatibility analysis (gpu-compat engine)
  ├─ Step 3: Cost estimate & budget check
  ├─ Step 4: Credential validation
  │
  ├─ ★ Step 5: PRE-FLIGHT CHECKS ★
  │   ├─ 5.1: Docker image exists? (Registry API)
  │   ├─ 5.2: CUDA version compatible? (Driver version check)
  │   ├─ 5.3: DNS resolution works? (Provider API hostname)
  │   ├─ 5.4: Price reasonable? (Max $5/hr check)
  │   ├─ 5.5: Template valid? (Vast.ai template API)
  │   └─ 5.6: HEALTHCHECK risk? (Known risky images)
  │
  ├─ Step 6: Start deploy with tiers
  └─ Step 7: Monitor health + auto-remediate
```

---

## Files Modified

| File | Changes |
|------|---------|
| `src/preflight-checks/index.ts` | **NEW** — 6 pre-flight checks |
| `server/gpu-handlers.ts` | Added Step 5 (pre-flight) to deploy flow |
| `server/gpu-handlers-info.ts` | Added `handlePreflightCheck` endpoint |
| `server/ws-server.ts` | Wired `/v1/gpu/preflight` route |
| `server/gpu-deploy.ts` | Fixed missing export |
| `server/config-persistence.ts` | Fixed type narrowing |
| `__tests__/unit/preflight-checks.test.ts` | **NEW** — 10 test cases |

---

## Quick Reference

```bash
# Check before deploying
curl -X POST http://localhost:4000/v1/gpu/preflight \
  -H "Content-Type: application/json" \
  -d '{"image": "my-llm:cuda12.4", "gpuTypes": ["RTX 4090"]}'

# Deploy (pre-flight runs automatically)
curl -X POST http://localhost:4000/v1/gpu/deploy \
  -H "Content-Type: application/json" \
  -d '{"dockerImage": "my-llm:cuda12.4", "gpuTypes": ["RTX 4090"]}'
```
