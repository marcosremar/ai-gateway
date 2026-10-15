# vast-stress — repeat the Vast stress test without an agent

A local gateway (this checkout) rents cheap Vast GPUs that serve a public llama.cpp image with a public 0.5B GGUF,
then drives load and faults through it. Report of the first run: `docs/reports/2026-10-09-vast-estresse.md`.

```bash
export SANDBOX_TOKEN=…                      # the only key; the rest comes from the dev API in-process
export STRESS_DIR=/tmp/vast-stress DEPLOYMENTS_NAMESPACE=vast-stress-$USER STRESS_PORT=4200
export GW=http://localhost:$STRESS_PORT
scripts/vast-stress/gateway.sh              # gateway on $STRESS_PORT, state in $STRESS_DIR, cap 3 replicas, €0.7/h
export KEY=$(cat $STRESS_DIR/admin.key)
bun scripts/vast-stress/run.ts              # the whole run (≈ 15 min, ≈ US$0.10), thresholds below, exit 1 on a failure
```

`run.ts` checks the balance, creates `stress-llm` (`llm.json`: RTX 3090/3080/4070/3060 ≤ €0.22/h, `minCuda` 12.8,
model by `fileUrls` with sha256), sends a cold burst of 10, a ramp 1 → 4 → 16 → 64 (90 s each), destroys the replica at
the provider while 8 streams flow, waits for the replacement, deletes the deployment and proves nothing is left
(provider listing of the namespace). Thresholds (env to override):

| Check | Default |
|---|---|
| cold burst: every caller answered, one machine rented | `STRESS_MAX_COLD_S=300` |
| ramp: success rate at concurrency ≤ 16 | `STRESS_MIN_OK_PCT=99` |
| ramp: TTFT p95 at concurrency 1 | `STRESS_MAX_TTFT_MS=500` |
| no request outlives the client timeout (hang) | `STRESS_TIMEOUT_S=90` |
| out-of-band destroy: a ready replacement within | `STRESS_MAX_RECOVERY_S=420` |
| spend of the run (gateway price × time) | `STRESS_MAX_USD=1` |

Pieces, usable alone:

- `vast.ts balance | list | show <id> | stop <id> | destroy <id>` — the repo's Vast backend; `stop`/`destroy` refuse an
  instance that is not labelled with `$DEPLOYMENTS_NAMESPACE`. Never prints a key.
- `load.ts --levels 1,4,16 --seconds 120 --timeout 90 [--interval 3] [--url <direct replica url>] --out x.jsonl` —
  streaming chat load; one JSON line per level (success, TTFT/total p50/p95/max, tokens/s, errors by type, per-replica
  counts from `X-Aigw-Replica`, gateway RSS when `GATEWAY_PID` is set).
- `watch.sh` — one line per deployment every 10 s into `$STRESS_DIR/logs/watch.jsonl`.

Afterwards: `bun scripts/reap-orphans.ts` with `GATEWAY_URL` pointing at a dead port is the gateway-down dry run;
`seen: 0` for the namespace is the proof nothing is rented.
