# Multi-Region Deployment

> **Status**: documented, not yet activated. Activate when Americas traffic
> justifies the extra ~$3/month for a second machine.

## Current state

The gateway runs in a single region:

```
primary_region = 'cdg'   # Paris, France
```

Cross-ocean latency from the Americas to CDG is ~120-150ms for the proxy
hop alone (measured 2026-04-12). Total request latency for chat completions
is ~220ms, of which ~70ms is the CDG round-trip.

## Why multi-region

Adding `iad` (Ashburn, Virginia) would:

- Reduce proxy hop for Americas from ~120ms to ~15ms
- Total chat latency: ~220ms → ~160ms (~27% improvement)
- TTS latency: ~700ms → ~640ms
- For real-time translation, every 60ms matters

## How to activate

### Step 1: Add secondary region

```bash
# Scale to 2 machines across 2 regions
fly scale count 2 --app parle-ai-gateway
fly machine clone --region iad --app parle-ai-gateway
```

Or update `fly.toml`:

```toml
primary_region = 'cdg'

# Fly.io automatically routes requests to the nearest region.
# Both machines share the same secrets and environment.
```

### Step 2: Verify

```bash
# From Americas
curl -w "total: %{time_total}s\n" https://parle-ai-gateway.fly.dev/health

# Check which region served
curl -sI https://parle-ai-gateway.fly.dev/health | grep fly-region
```

The `fly-region` header shows which datacenter handled the request.

### Step 3: Cost

| Config | Monthly cost |
|---|---|
| 1 machine CDG (current) | ~$3 |
| 2 machines CDG + IAD | ~$6 |
| Scale-to-zero both | ~$0 (only pay when running) |

With `auto_stop_machines = 'stop'` and `min_machines_running = 0`, both
machines stop when idle. Cost is only incurred during active use.

### Regions to consider

| Region | Code | Serves | Proxy latency from target |
|---|---|---|---|
| Paris | `cdg` | Europe, Africa, Middle East | <30ms |
| Ashburn | `iad` | East Americas | <20ms |
| São Paulo | `gru` | South America | <30ms |
| Tokyo | `nrt` | Asia-Pacific | <30ms |

Start with CDG + IAD. Add GRU/NRT only with measurable demand.

## Caveats

- **State is per-machine**: the in-memory rate limiter, connection counter,
  and request cache are NOT shared. Each machine has its own. This means a
  client could get 2× the rate limit by alternating between regions. For
  our current 6000 RPM cap this is acceptable.

- **Secrets are shared**: `fly secrets set` applies to all machines. API
  keys don't need per-region configuration.

- **Logs are per-machine**: `fly logs` shows all regions interleaved. Use
  `fly logs --region cdg` to filter.
