# Performance Tuning Guide — Quick Reference

## Latency Optimization

| Goal | Action | Impact |
|------|--------|--------|
| Reduce p95 | Enable GPU predictive warmup | -50-80% cold start |
| Reduce p50 | Connection pooling | -10-20% provider latency |
| Reduce duplicates | Request coalescing | -30% duplicate requests |
| Reduce errors | Provider fallback chains | Auto-failover |

## Throughput Optimization

| Goal | Action | Impact |
|------|--------|--------|
| More req/s | Rate limiting per key | Prevent abuse |
| Handle bursts | Async processing | Non-blocking I/O |
| Reduce load | Response caching | -40% repeated queries |
| Scale out | Connection pool sizing | Prevent bottlenecks |

## Cost Optimization

| Goal | Action | Impact |
|------|--------|--------|
| Reduce GPU cost | Cheapest tier first | -40-60% GPU cost |
| Reduce idle cost | Auto-stop after 15min | Save on unused GPUs |
| Reduce provider cost | Fallback to cheaper | Auto-select cheapest |
| Prevent runaway | Budget caps | Hard limits |

## Memory Optimization

| Goal | Action | Impact |
|------|--------|--------|
| Reduce heap | GC on idle | -20% memory |
| Prevent leaks | Ring buffers | Fixed memory |
| Reduce allocs | Object pools | Reuse objects |
| Monitor | Memory watcher | Early detection |

## Profiling

```bash
# Start with profiling
PROFILE=1 bun run serve.ts

# Check memory stats
curl http://localhost:4000/v1/services

# Take heap snapshot
curl http://localhost:4000/debug/heap
```

## Production Checklist

- [ ] `RATE_LIMIT_RPM` set
- [ ] `RATE_LIMIT_KEYS` configured
- [ ] `IDLE_TIMEOUT_MIN=15`
- [ ] `DAILY_BUDGET_USD` set
- [ ] Memory watcher enabled
- [ ] Health check passing
- [ ] Connection pooling enabled
- [ ] Request coalescing enabled
- [ ] Logging at `info` level
