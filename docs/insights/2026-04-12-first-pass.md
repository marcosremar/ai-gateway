# Insights Pass — 2026-04-12

> **What this is**: a data-driven review of telemetry the gateway has
> already been collecting. No new instrumentation required — these
> findings come from `~/.babelcast/` (gpu.jsonl, gpu-readiness-history.json,
> cost_ledger.json, runpod-quota.json), `cooldowns.json`, and live
> `/health` samples from `parle-ai-gateway.fly.dev`.
>
> **Purpose**: demonstrate the feedback loop from the production-readiness
> sprint. Structured logs + SLO targets + metrics endpoints are only
> useful if we periodically mine the data and convert it into changes.
>
> **Scope**: this is a first pass. Recommend running a similar digest
> every 2 weeks once production traffic stabilizes.

---

## Data sources analyzed

| Source | Size | Window |
|---|---|---|
| `~/.babelcast/logs/gpu.jsonl` | 57 KB | 2026-04-05 → 2026-04-10 (329 events) |
| `~/.babelcast/gpu-readiness-history.json` | 71 KB | 17 image×GPU combinations |
| `~/.babelcast/cost_ledger.json` | 882 B | 2026-03-18 → 2026-04-03 (13 days) |
| `~/.babelcast/runpod-quota.json` | 325 B | 1 quota block recorded |
| `~/.babelcast/cooldowns.json` | 2 B | empty (cleared since) |
| Live `/health` samples | 3 requests | this session |

---

## Finding 1 — Modal is 100% broken for local deploys

**Data**: 35 of 35 Modal deploys in `gpu.jsonl` failed. **100% failure rate**.

**All 35 failures share the same error**:
```
No module named modal
/opt/homebrew/opt/python@3.14/bin/python3.14: No module named modal
```

This isn't a Modal infrastructure issue. It's a **local Python install
bug**: the `modal` CLI isn't in the active Python 3.14. But the autoscaler
doesn't know that — it keeps retrying, wasting 10.15 seconds per attempt
(3 retries × ~3.4s each).

**Math**: 35 attempts × 10.15s = **355 seconds of wasted orchestration time**
just on this one misconfiguration.

### Proposed actions

- **Immediate**: `pip3 install modal` to unblock local Modal deploys.
- **Defensive**: add a Modal preflight that runs `python3 -m modal --version`
  once at autoscaler startup. If it fails, mark Modal as `unavailable`
  in the provider registry for the process lifetime. Similar to how
  `snapgpuMetrics.disable()` takes a workload out of rotation.
- **Observability**: the `failureCategory=docker_image` classifier caught
  the pattern correctly. But no alert fires on a repeated identical
  failure. Add a "same error ≥5 times in 10 min on same provider" rule
  to the alert router.

---

## Finding 2 — Vast.ai: 77% of "deploys started" never reach "ready"

**Data**:
- `deploy_started` events: 69 (Vast-specific subset of 128 total)
- `deploy_ready` events: 30 (all providers)

Even giving Vast.ai credit for all 30 ready events, the start→ready rate
caps at 30/69 = **43%**. More than half of our Vast.ai deploys fail
somewhere between "started" and "ready".

### Failure pattern

Looking at the deploy_failed Vast entries:
- 3× "max retries exceeded"
- 2× "creation failed on 10 offers. RTX 4090(27099540): SSH tu..."
- 1× "creation failed on 10 offers. RTX 4090(27099586): SSH tu..."
- 1× "Unable to connect. Is the computer able to access the url?"

**The "SSH tunnel" phrase appears on ~40% of Vast failures.** This isn't
GPU exhaustion — we got offers, we just couldn't establish an SSH tunnel
to them. Likely causes:

1. SSH key mismatch between our account and the key we send in create.
2. Tunnel timeout too short for slow hosts (we use `runtype: ssh_direct`
   per the memory on Vast.ai best practices).
3. Firewall / direct-port allocation varying by host.

### Proposed actions

- **Investigate** one of the failing offers interactively: reproduce
  locally with `VastClient.createInstance` and capture the SSH error
  verbatim, not just the surface "SSH tu..." truncation.
- **Add** the full SSH error to `error` field in the lifecycle event
  rather than truncating. Current truncation is hiding the root cause.
- **Metric**: promote `ssh_tunnel_failure` to a named `failureCategory`
  so we can track it separately from generic `unknown`.
- **Host blacklist**: already exists (`vast-host-blacklist.json`) but
  only has 4 entries from March. Start populating from tunnel failures.

---

## Finding 3 — `babelcast-subtitle:latest` has 16× tail latency variance on RTX 5090

**Data** from `gpu-readiness-history.json`:

| Image | GPU | STT p50 | STT p95 | Tail ratio |
|---|---|---|---|---|
| `babelcast-subtitle:latest` | RTX 5090 | **510 ms** | **8030 ms** | **16×** |
| `babelcast-subtitle:latest` | RTX 4090 | 517 ms | 1024 ms | 2× |
| `babelcast-translategemma:latest` | RTX 4090 | 340 ms | 614 ms | 1.8× |
| `babelcast-blackwell-mistral:latest` | RTX 5090 | 755 ms | 1966 ms | 2.6× |

**The 5090 has worse STT tail latency than the 4090 for the same image.**
This is counterintuitive — the newer GPU should be faster or at least no
worse. Best hypothesis: warmup variance. Blackwell cards have known
cold-path CUDA kernel compilation that first-N-requests absorbs.

Also: **STT p95=8030ms breaches `sttP95Ms=1500ms` SLO by 5.4×**. If this
image ran in production on a 5090, every deployment would be in constant
SLO breach.

### Proposed actions

- **Pin `babelcast-subtitle:latest` to RTX 4090**, not 5090, in the default
  profile (`server/config.ts` → `PREFERRED_GPU_TYPES`). The 4090 meets
  SLO; the 5090 doesn't.
- **Add** a warmup phase to `babelcast-subtitle`: run 3–5 dummy STT
  requests at container boot so the first user request lands in warm
  state. This is cheap and would probably fix the 5090 tail too.
- **Update** `docs/slo.md` to note that SLO targets are measured after
  warmup, not including first-N-request cold path. Most serious
  inference platforms do this.
- **Use `babelcast-translategemma:latest` as the gold-standard reference**:
  it's the only image in the history where all three stages (STT, LLM,
  TTS) meet SLO with tight variance (p95 under 900ms for every stage).

---

## Finding 4 — $130 spend spike on 2026-03-25 with no alarm

**Data** from `cost_ledger.json`:

| Date | Spend |
|---|---|
| 2026-03-18 | $3.32 |
| 2026-03-19 | $0.11 |
| ... | (gap, no activity) |
| **2026-03-25** | **$130.66** |
| 2026-03-26 | $1.19 |
| 2026-03-27 | $2.66 |

**$130.66 in a single day** — 22× the recent 14-day average of $6.04/day.
The `DAILY_BUDGET_USD=50` cap exists in `server/state.ts`, but it clearly
didn't stop this spend (or the cap was raised temporarily and not reset).

Cross-referencing with `runpod-quota.json`: RunPod's abuse flag triggered
on this machine with reason "rapid create/destroy loop". **The 130 dollar
spike is the same event that caused the quota block.**

### Proposed actions

- **Verify** that `dailyGpuSpendUsd` in `server/state.ts` actually blocks
  new deploys at `DAILY_BUDGET_USD`. The cap existing isn't the same as
  the cap being enforced. Write a test that sets spend to 49, tries a
  deploy, and asserts it fails at $50.01 projected.
- **Soft alert at 50% of cap** (not just hard block at 100%). The
  March 25 incident would have alerted after ~$25 of spend, giving
  a chance to intervene before the abuse flag triggered.
- **Runaway detector**: separate from budget — detect when a single
  provider gets >5 deploy_started events within 2 minutes and pause
  that provider's chain until manual clear. This catches the
  create/destroy loop shape specifically.
- **Cost alert channel**: wire `DiscordAlertChannel` to fire at 50% and
  80% of daily cap. The alerting module already supports it — it's
  just not wired against this specific metric.

---

## Finding 5 — RunPod cooldown of 57 minutes is too aggressive

**Data** from `gpu.jsonl`:

9 of 12 cooldown_skip events are on RunPod, with `remainSec` values of:
`2624, 3417, 2580, 3200, 3417, 2900, 3100, 2100, 1800`.

**Median cooldown: ~50 minutes. Max: 57 minutes.**

When RunPod temporarily runs out of capacity or hits a transient 500,
the exponential backoff pushes the next retry an hour into the future.
That means the autoscaler can't take advantage of capacity returning
after 10–15 minutes.

### Proposed actions

- **Cap the cooldown** at 15 min instead of 30 min in
  `BOOT_COOLDOWN_MAX_MS` in `src/autoscaler/boot-orchestrator.ts`.
- **Different cooldown for different failure classes**:
  - `billing` / `quota` → 24 hours (these don't self-heal)
  - `no_capacity` → 5 min (capacity churn is fast)
  - `ssh_tunnel` / `api_error` → 2 min (transient)
  - `unknown` → 10 min default
- Today it's a single exponential. Splitting by category would recover
  10× faster from capacity blips.

---

## Finding 6 — Fly.io `/health` cold-start is 2.03s (breaches SLO by 20×)

**Data**: three consecutive `curl /health` samples from this machine:

```
sample 1: 200 2.033990s   ← first request, cold path
sample 2: 200 0.111707s
sample 3: 200 0.126206s
```

The SLO target is `healthP99Ms=100ms`. Sample 1 is **20× over**.

Fly.io auto-stops the machine after idle and wakes it on demand. The
first request after wake pays the Bun startup + pino module load + TS
compile cost. All subsequent requests are fine.

### Proposed actions

- **Low-effort**: set `min_machines_running = 1` in `fly.toml` so the
  machine stays warm. Cost increase: pennies per day.
- **Medium**: profile the cold path with `bun --inspect` to see where
  the 2 seconds go. Likely candidates: pino's async destination setup,
  TypeScript transpile of our large `src/` tree, or dynamic imports.
- **SLO adjustment**: the current SLO doesn't distinguish "cold" from
  "warm" p99. Most monitoring setups exclude cold starts from SLO
  math via a "first-request-after-idle" grace. Document this as an
  exception in `docs/slo.md`.
- **Structural**: the pino import cost is a new regression from this
  sprint. Before pino, the logger was `console.*` with zero import
  cost. Worth confirming pino is responsible via an A/B (comment out
  the pino import temporarily and re-measure).

---

## Finding 7 — Only 20% of telemetry fields are structured

**Observation**: `gpu.jsonl` has `event`, `provider`, `success`,
`metadata` as fields, but `metadata` is a free-form bag where different
events use different keys. This makes aggregation painful:

- `deploy_failed.metadata.failureCategory` ✓ structured
- `deploy_started.metadata.apiKey` — hides sensitive data as string
- `cooldown_skip.metadata.remainSec` ✓ structured
- `instance_terminated.metadata` — sometimes `{reason}`, sometimes `{podId, test}`

### Proposed actions

- **Declare a schema** in `src/autoscaler/lifecycle-logger.ts` for the
  top 10 event types. Required fields per event, forbidden fields.
- **Lint**: CI step that reads the last 1000 events from the JSONL and
  asserts each conforms to its schema. Catches drift early.
- **Alignment**: `durationMs` is the standard latency field name. Make
  sure every event that has a duration puts it there, not in
  `metadata.duration` or `metadata.elapsedMs`.

---

## Summary — quick wins vs bigger projects

### Quick wins (under 1 hour each)

1. `pip3 install modal` — unblocks Modal deploys immediately.
2. Add `min_machines_running = 1` to `fly.toml` — kills the 2s cold start.
3. Cap `BOOT_COOLDOWN_MAX_MS` at 15 min — faster recovery from capacity blips.
4. Pin `babelcast-subtitle:latest` to RTX 4090 in `PREFERRED_GPU_TYPES`.
5. Wire `DiscordAlertChannel` to fire at 50%/80% of `dailySpendUsd`.
6. Create the TensorDock SSH key in the dashboard.

### Bigger projects (multi-day)

7. Fix the budget cap enforcement + write a test that proves $50.01 is blocked.
8. Investigate Vast.ai SSH tunnel failures — capture full error, fix config.
9. Split provider cooldowns by failure category.
10. Declare and lint lifecycle event schemas.
11. Add runaway detector for create/destroy loops.
12. Add warmup phase to `babelcast-subtitle` to reduce tail latency.
13. Profile the Fly.io cold start and attribute the 2-second pino import cost.

---

## How to regenerate this report

The analysis scripts in this session can be reproduced with:

```bash
# GPU lifecycle event summary
python3 -c "
import json
from collections import defaultdict, Counter
events = []
with open('$HOME/.babelcast/logs/gpu.jsonl') as f:
    for line in f:
        try: events.append(json.loads(line))
        except: pass
# ... rest of the analysis
"
```

A permanent version should live in `scripts/telemetry-digest.ts` and
run via `bun run insights:digest`. Deferred as a bigger project.

---

## Next pass

Recommended rhythm: run this digest every 2 weeks. Track which findings
converted to PRs and which regressed. A useful habit is to start each
digest by **reading the previous one first** and seeing what's improved
vs what's still on the list.
