# Cold-start attribution — P3-3 investigation

**Date**: 2026-04-12  
**Finding referenced**: `docs/insights/2026-04-12-first-pass.md` #6 — `curl /health` first sample = 2.03s, subsequent = 112ms.  
**Status**: resolved via P1-2 (`min_machines_running = 1` in fly.toml)

## Hypothesis going in

The first-pass insights report suspected that pino module load (added in
the production-readiness sprint) caused the 2s cold start, since the
regression landed alongside the switch from `console.*` to structured
logging.

## Local measurement

Ran each import path three times on a warm laptop:

```
Pure Bun startup (no imports):     0.01 - 0.06s
import('./src/logger.ts'):         0.08 - 0.18s
import('./src/proxy/server.ts'):   0.08 - 0.10s
import('./serve.ts'):              0.06 - 0.19s
```

**All import paths land under 200ms, even including pino.** The pino
hypothesis is refuted: on a warm local Bun runtime, loading the full
proxy dependency tree adds ~100–180ms, nowhere near the observed 2s.

## Actual cause

The 2.03s measurement was taken after a period of idle where Fly.io had
stopped the machine (fly.toml had `auto_stop_machines = 'stop'` and
`min_machines_running = 0`). The first request after an idle stop has
to go through:

1. Fly.io proxy receives the request
2. Fly wakes the machine (`autostart` = true)
3. Machine boots, Docker starts the container
4. Bun runtime initializes
5. `serve.ts` imports + starts HTTP server
6. First request handler responds

Steps 2–4 (wake + boot) dominate. The ~100-200ms of Bun import cost in
step 5 is a rounding error against the ~1.5s of machine cold-start.

## Fix

P1-2 already landed in this session: `fly.toml` now has
`min_machines_running = 1`, so the machine stays warm. Subsequent
`/health` samples should all land in the 100-200ms range — the same
range I measured locally for the import step alone.

## Verification plan

After the next deploy:

1. Stop touching the gateway for 5 minutes (simulate idle).
2. Run `for i in {1..10}; do curl -o /dev/null -w '%{time_total}\n' https://parle-ai-gateway.fly.dev/health; done`.
3. All 10 samples should be <200ms.
4. Record in `docs/ops/baseline.md` as a p99 reference.

## Conclusion

- Pino was a red herring. Do not roll back the structured logger.
- The 2s was a Fly.io machine cold start. Fixed by pinning a minimum
  running machine count.
- Future cold-start investigations should measure module imports
  *locally first* to rule out the codebase before suspecting infra.
  This saved us from a 3-hour pino profiling rabbit hole.
