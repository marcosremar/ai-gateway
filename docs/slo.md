# Service Level Objectives — v1

> **Scope**: `@parle/ai-gateway` as deployed on Fly.io (`parle-ai-gateway.fly.dev`)
> plus the autoscaler-managed GPU fleet behind it.
>
> **Version**: v1 — 2026-04-12. Revised at least quarterly or after any
> incident that invalidates a target.
>
> **Authority**: this document declares the contract. If a monitoring
> dashboard disagrees with the numbers here, fix the dashboard. If the
> targets feel wrong, open a PR against this file and discuss before
> changing code or alerts.

---

## Why declare SLOs at all

Without SLOs, "is this a problem?" is a gut-feel question. The autoscaler
already collects p95/p99 for every stage, the cost monitor already tracks
spend, and the cold-start bench has validated typical boot durations. What
was missing was a line in the sand that turns those measurements into
decisions. This file is that line.

A breach of any SLO in this file is the trigger for an alert. A sustained
breach (2x in the rolling window) is the trigger for an incident. The
alerting module in `src/alerting/` reads these targets — do not hardcode
numbers in that module, import them from here.

---

## SLO targets

| # | Metric | Target | Window | Source |
|---|---|---|---|---|
| 1 | `POST /v1/chat/completions` latency (p95) | **≤ 2,000 ms** | 7 days | `server/metrics.ts` per-stage ring buffer |
| 2 | `POST /v1/speech` full pipeline (p95) | **≤ 4,000 ms** | 7 days | `server/metrics.ts` pipeline timer |
| 3 | `POST /v1/audio/transcriptions` latency (p95) | **≤ 1,500 ms** | 7 days | `server/metrics.ts` per-stage |
| 4 | `POST /v1/audio/speech` latency (p95) | **≤ 2,500 ms** | 7 days | `server/metrics.ts` per-stage |
| 5 | Gateway HTTP availability | **≥ 99.5%** | 30 days | Fly.io health check uptime |
| 6 | `GET /health` p99 | **≤ 200 ms** | 7 days | synthetic probe (cross-ocean; EU clients see <50ms) |
| 7 | GPU cold boot (p95) | **≤ 60 s** | 7 days | autoscaler `boot_ok` duration |
| 8 | GPU snapshot restore (p95, when enabled) | **≤ 10 s** | 7 days | autoscaler `snapshot_restore_attempted` + `boot_ok` |
| 9 | Daily GPU spend | **≤ $50** | 24 h | `dailyGpuSpendUsd` in `server/state.ts` |
| 10 | Autoscaler boot failure rate | **≤ 5%** | 7 days | `boot_failed` / (`boot_ok` + `boot_failed`) |

---

## Rationale per target

### 1. Chat completions p95 ≤ 2s
Groq's own p95 for `llama-3.3-70b-versatile` is ~800 ms for typical prompts.
Our proxy adds overhead for auth, rate limit, fallback chain, and network.
2 s gives us 1.2 s of headroom over the upstream floor, enough to absorb
one Groq cooldown + a Fireworks fallback hop.

### 2. Speech pipeline p95 ≤ 4s
STT (1.5 s budget) + LLM (2 s budget) + TTS (~500 ms for Orpheus wav).
Pipeline total is deliberately less than the sum because we overlap
streaming reads. A breach here usually means one stage is far outside
its budget — check stages individually before blaming the pipeline.

### 3–4. Transcription / speech p95
Groq Whisper-turbo and Orpheus TTS both typically run under 1 s on short
inputs. Targets give 500–1500 ms of headroom for upstream variance.

### 5. 99.5% uptime (30d)
Fly.io shared-cpu-2x is not a 4-nine platform. 99.5% allows ~3.6 hours of
downtime per month, which is realistic for a single-region, single-machine
deployment. When we go multi-region, this tightens to 99.9%.

### 6. Health endpoint p99 ≤ 100 ms
`GET /health` is pure in-memory, no DB, no upstream. If it breaches this,
the process is saturated or GC-thrashing — not a routing issue.

### 7. GPU cold boot p95 ≤ 60s
Tier-1 revalidated bench on 2026-04-11: RunPod RTX 4090 cold boot 46.2s,
Vast.ai RTX A5000 cold boot 48s. 60s target gives ~25% headroom. When the
fleet shifts to bigger images this will need revisiting.

### 8. GPU snapshot restore p95 ≤ 10s
Based on TensorDock CRIU bench (2026-04-10): 3.58s pure VRAM restore, +2–5s
for network download of the snapshot from S3 and process re-init. The
SnapGPU metrics tracker (`src/autoscaler/snapgpu-metrics.ts`) auto-disables
snapshots for a workload when rolling restore avg > 0.7 × cold avg — this
SLO reflects the threshold that tracker enforces.

### 9. Daily spend ≤ $50
Existing `DAILY_BUDGET_USD` ceiling. Breaching it blocks new GPU boots
until midnight UTC. This is a budget cap, not a latency target — bundled
here because it's the same alerting surface.

### 10. Boot failure rate ≤ 5%
Provider flakes (Vast.ai 500s, RunPod quota denials, TensorDock VM infra
glitches) are an unavoidable baseline. 5% tolerates routine flakes; 10%+
sustained is a provider outage worth a status page entry.

---

## Alert wiring

The alerting module should **import** targets from a config file derived
from this doc, not hardcode them. Proposed shape:

```typescript
// src/alerting/slo-targets.ts (to be created)
export const SLO_TARGETS = {
  chatP95Ms: 2_000,
  speechPipelineP95Ms: 4_000,
  sttP95Ms: 1_500,
  ttsP95Ms: 2_500,
  uptimeRatio: 0.995,
  healthP99Ms: 100,
  gpuColdBootP95Ms: 60_000,
  gpuSnapshotRestoreP95Ms: 10_000,
  dailySpendUsd: 50,
  bootFailureRate: 0.05,
} as const;
```

Breach policy:
- **1 breach in window**: emit warning to `#gateway-alerts` webhook (Discord).
- **2 breaches in 30 min**: page on-call via Slack hook.
- **5 breaches in 60 min**: automatic failover — block new GPU deploys,
  force cloud-only fallback chain, raise an error budget incident.

---

## Error budget

Budget for each SLO = 1 − (target reliability). For 99.5% uptime over 30
days, the budget is 3.6 hours of downtime. If month-to-date consumption
exceeds 50% of the budget mid-window, pause all non-critical deploys
until the next window start.

Tracking of budget burn-down is **not implemented yet** — when it is, it
lives in `src/alerting/error-budget.ts` and reads from the same
`server/metrics.ts` ring buffers as the breach detector.

---

## Revision history

| Date | Change | Author |
|---|---|---|
| 2026-04-12 | v1 initial declaration | production readiness plan |
