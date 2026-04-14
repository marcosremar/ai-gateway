# Performance Tuning Guide

This document provides actionable guidance for optimizing AI Gateway
performance across latency, throughput, and cost dimensions.

## Quick Reference

| Goal | Action | Expected Impact |
|------|--------|-----------------|
| Reduce p95 latency | Enable GPU predictive warmup | -50-80% cold start |
| Reduce p50 latency | Use connection pooling | -10-20% provider latency |
| Increase throughput | Enable request coalescing | -30% duplicate requests |
| Reduce cost | Use cheaper GPU tiers first | -40-60% GPU cost |
| Reduce memory | Enable GC on idle | -20% heap usage |
| Reduce bundle size | Tree-shake unused providers | -15% bundle size |

---

## 1. Cold Start Optimization

### Problem
GPU cold boots take 30-120 seconds, dominating p95 latency.

### Solutions (in order of impact)

1. **Predictive warmup** — Boot GPU before demand based on usage patterns
   ```bash
   # Enable in config
   PREDICTIVE_WARMUP=true
   WARMUP_LOOKAHEAD_MIN=5
   ```

2. **Standby instances** — Keep a GPU idle and ready
   ```bash
   # Reserve one instance at all times
   MIN_GPU_INSTANCES=1
   ```

3. **Pre-baked Docker images** — Include models in image, not runtime download
   - Current `babelcast-subtitle` image pre-bakes Whisper + GGUF LLM
   - Saves ~15-30s on cold boot

4. **Use faster GPU providers** — RunPod boots faster than Vast.ai
   - RunPod: ~31s average
   - Vast.ai: ~60-120s average
   - Modal: ~5-10s (serverless, different model)

---

## 2. Provider Latency Optimization

### Connection Pooling

Default: Global fetch with no connection reuse.

```typescript
import { getGlobalPool } from '@ai-gateway/connection-pool';

const pool = getGlobalPool({ maxConnections: 10, keepAlive: true });
// Provider HTTP calls now reuse connections
```

Expected impact: -10-20% on provider latency (eliminates TCP/TLS handshake overhead).

### Request Coalescing

Already enabled for deterministic requests (temperature=0).

```typescript
// Two identical requests arrive within 30ms
// → Only one upstream call, both get the same result
```

Expected impact: -30% on duplicate requests (common in retry scenarios).

---

## 3. Throughput Optimization

### Rate Limiting

Set `RATE_LIMIT_RPM` to stay under provider limits:

```bash
# Groq limit: 100 RPM for whisper-large-v3
RATE_LIMIT_RPM=90

# Per-key limits
RATE_LIMIT_KEYS="sk-abc:50,sk-def:30"
```

### Concurrent Request Handling

The proxy handles concurrent requests efficiently:
- Non-blocking I/O for upstream calls
- Connection pooling prevents socket exhaustion
- Request timeout (60s default) prevents stuck connections

### Memory Management

Under high load, monitor memory:

```bash
# Enable memory watcher
PROFILE=1 bun run serve.ts

# Check /v1/status for memory stats
curl http://localhost:4000/v1/status
```

If memory grows unbounded:
1. Enable GC on idle: `GC_ON_IDLE=true`
2. Reduce concurrent requests: `MAX_CONCURRENT=50`
3. Restart periodically: `RESTART_AFTER_REQUESTS=10000`

---

## 4. Cost Optimization

### GPU Tier Ordering

Cheapest tier first, fail over to expensive:

```
Tier 0: Vast.ai ($0.44/hr RTX 4090)
Tier 1: RunPod ($0.74/hr RTX 4090)
Tier 2: Modal ($0.0008/sec serverless)
```

### Idle Timeout

Stop GPU after idle to avoid paying for unused time:

```bash
IDLE_TIMEOUT_MIN=15        # Default: 15 min
IDLE_DESTROY_HOURS=2       # Destroy after 2h stopped
```

### Budget Cap

Set hard budget limits:

```bash
DAILY_BUDGET_USD=50
```

---

## 5. Bundle Size Optimization

### Tree-shaking

Only import what you need:

```typescript
// Good: Only providers
import { groqSTT, groqLLM } from '@ai-gateway/providers';

// Good: Only autoscaler
import { createAutoscaler } from '@ai-gateway/autoscaler';

// Bad: Everything
import { createGateway } from '@ai-gateway';
```

### Production bundle

```bash
bun run build  # Tree-shakes automatically via tsup
```

Current bundle size: ~500KB (main entry point).

---

## 6. Profiling

### CPU Profile

```bash
PROFILE=1 bun run serve.ts
curl http://localhost:4000/debug/profile?duration=10000
```

### Memory Profile

```bash
# Take heap snapshot
curl http://localhost:4000/debug/heap

# Check memory stats
curl http://localhost:4000/v1/services
```

### Request Tracing

```bash
# All requests get X-Request-Id header
curl -v http://localhost:4000/v1/models
# Response: X-Request-Id: abc-123
```

Use this ID to trace across logs, metrics, and spans.

---

## 7. Production Checklist

Before deploying to production:

- [ ] `RATE_LIMIT_RPM` set (don't rely on provider limits)
- [ ] `RATE_LIMIT_KEYS` configured for multi-tenant usage
- [ ] `IDLE_TIMEOUT_MIN` set (avoid paying for idle GPUs)
- [ ] `DAILY_BUDGET_USD` set (cost safety)
- [ ] Memory watcher enabled (`PROFILE=1` or via config)
- [ ] Health check passing (`/health`)
- [ ] Request timeout set (`PROXY_TOTAL_TIMEOUT_MS=60000`)
- [ ] Connection pooling enabled
- [ ] Request coalescing enabled (automatic for temp=0)
- [ ] Logging at `info` level (not `debug` in production)
