# Improvement Plan — Phase 2

> **Source**: findings from `docs/insights/2026-04-12-first-pass.md`, which
> mined real telemetry (gpu.jsonl + readiness-history + cost_ledger +
> quota + live health samples) to surface 7 concrete issues.
>
> **Sequencing rationale**: priority ≠ effort. A quick win that costs
> money silently (budget cap missing) ranks higher than a quick win that
> costs latency on first request. The priority labels are about
> **consequence of inaction**, not how hard the fix is.
>
> **Ownership**: each item is independently verifiable and can land as a
> separate PR. Items marked with dependencies must wait for the
> blocking item to land first.

---

## P0 — Financial safety (do these first, no exceptions)

These exist because one day on 2026-03-25 burned $130 vs a $6/day average.
The spend path runs autonomously in the background; a silent regression
here costs real dollars before anyone notices.

### [x] P0-1. Prove the daily spend cap actually enforces

**Finding**: #4 — `cost_ledger.json` shows a single-day spike to $130.66
even though `DAILY_BUDGET_USD=50` exists in `server/state.ts`.

**What**: write a vitest test that:
1. Sets `dailyGpuSpendUsd = 49.00` directly.
2. Invokes the deploy path with an expected cost of $2.
3. Asserts the deploy is **refused** with a specific error like
   `BUDGET_EXCEEDED` before reaching the provider client.

Then run the test, watch it fail (almost certainly), fix the enforcement,
re-run, watch it pass. Commit the test so it can never regress.

**Files**: `__tests__/budget-cap-enforcement.test.ts` (new),
`server/gpu-deploy.ts` (likely fix), `server/state.ts` (may need a
check function `canAffordDeploy(estimatedCostUsd)`).

**Acceptance**: the test fails on current HEAD, passes after the fix.
A manual attempt to boot a GPU at 99% of cap is refused with a clear
error message.

**Effort**: M (2–4 hours) — split between writing the test and finding
where the existing cap check silently fails.

### [x] P0-2. Runaway detector for create/destroy loops

**Finding**: #4 — the $130 spike was a rapid create/destroy loop that
also triggered RunPod's abuse flag. The budget cap alone isn't enough
because a loop can burn $100 in 20 minutes, faster than daily-budget
math catches up.

**What**: add a per-provider sliding window in `src/autoscaler/engine.ts`
(or a new `src/autoscaler/runaway-detector.ts`) that counts
`deploy_started` events in the last 2 minutes. If >5 on the same
provider, pause that provider for 15 minutes with a `runaway_pause`
lifecycle event. Manual clear via `POST /v1/autoscaler/unpause`.

**Files**: new `src/autoscaler/runaway-detector.ts`, wiring in
`src/autoscaler/engine.ts`, new lifecycle event type
`runaway_pause` in `src/autoscaler/lifecycle-logger.ts`.

**Acceptance**: unit test that fires 6 deploy_started events in 100ms
on the same provider and asserts the 7th is refused. The existing
`runpod-quota.json` abuse flag would have been prevented by this.

**Effort**: M (3–5 hours).

### [x] P0-3. Wire cost alerts at 50% / 80% of daily cap

**Finding**: #4 — `DiscordAlertChannel` exists in `src/alerting/channels/`
but is never wired against `dailyGpuSpendUsd`. A soft alert at $25
would have given a chance to intervene before the March 25 spike.

**What**: add a background check in `server/gpu-deploy.ts` (or wherever
the spend counter updates) that emits `alert.router.send(...)` at 50%
and 80% crossings. Use the `SLO_TARGETS.dailySpendUsd` from the alerting
barrel — don't hardcode.

**Files**: `server/state.ts` (add "alert thresholds already crossed
today" state so we don't spam), `server/gpu-deploy.ts` (wire the
emitter), new `src/alerting/cost-watcher.ts` (the threshold logic).

**Acceptance**: setting `dailyGpuSpendUsd = 25.01` emits a warning to
the registered alert channel; setting to 40.01 emits a page; setting
back to 0 resets the "already alerted today" flag.

**Depends on**: P0-1 (the fix will also expose the spend counter
boundary cleanly). Can be done in parallel but reviewing both at once
is easier.

**Effort**: M (2–3 hours).

---

## P1 — Quick fixes for known breakages

These are the "why is this broken?" items where the fix is obvious once
you look at the data. All under 1 hour of work each.

### [x] P1-1. `pip3 install modal` + preflight guard

**Finding**: #1 — all 35 Modal deploys failed with "No module named
modal". 100% failure, 10.15s wasted per retry, 355s total.

**What**:
1. On this machine: `pip3 install modal` (or `uv pip install modal`).
2. In `src/gpu-providers/modal-client.ts` or the factory: add a
   preflight that runs `python3 -m modal --version` once at startup.
   If it errors, call `registry.disableProvider('modal', reason)` so
   subsequent deploys skip Modal silently with a single warning.
3. Register a lifecycle event `provider_disabled` with the reason.

**Files**: `src/gpu-providers/modal-client.ts` (preflight method or
extend existing `preflight()`), `src/factory.ts` (wire disable on
failed preflight), `src/autoscaler/lifecycle-logger.ts` (new event).

**Acceptance**: on a machine without `modal` CLI, the autoscaler logs
`provider_disabled provider=modal reason=...` once and then never
attempts Modal deploys for the process lifetime.

**Effort**: S (30–60 min).

### [x] P1-2. `min_machines_running = 1` in fly.toml

**Finding**: #6 — live `/health` first-request was 2.03s (warm was
112ms). Breaches the `healthP99Ms=100ms` SLO by 20× on cold start.

**What**: change `fly.toml` from `min_machines_running = 0` to
`min_machines_running = 1`. Deploy. Measure the new cold vs warm p99
via a simple loop.

**Caveat**: cost goes up by ~$2–3/month for a shared-cpu-2x kept warm.
Negligible against the observability benefit.

**Files**: `fly.toml`.

**Acceptance**: 10 consecutive `curl /health` samples from a cold laptop
all return in <200ms. Previously the first was >1s.

**Effort**: S (5 min edit + 10 min deploy + smoke).

### [x] P1-3. Cap `BOOT_COOLDOWN_MAX_MS` at 15 minutes

**Finding**: #5 — RunPod cooldowns reached 57 minutes, blocking the
autoscaler from using capacity that returned in 10 minutes.

**What**: in `src/autoscaler/boot-orchestrator.ts`, change
`BOOT_COOLDOWN_MAX_MS = 30 * 60_000` → `15 * 60_000`. Update the
existing boot-orchestrator test that checks the exponential backoff
cap so the new 15-minute ceiling is enforced.

**Files**: `src/autoscaler/boot-orchestrator.ts`,
`__tests__/autoscaler-boot-orchestrator.test.ts`.

**Acceptance**: unit test asserts `cooldownUntil - Date.now() <= 15 * 60_000`
even after 10 consecutive failures.

**Effort**: S (15 min).

### [x] P1-4. Pin `babelcast-subtitle:latest` to RTX 4090

**Finding**: #3 — same image on RTX 5090 has STT p95=8030ms (breaches
SLO 5.4×); on RTX 4090 has STT p95=1024ms (within SLO).

**What**: update `PREFERRED_GPU_TYPES` in `server/config.ts` so the
`babelcast-subtitle` profile no longer includes `NVIDIA GeForce RTX 5090`
in its allowlist. Other profiles that benefit from 5090 (e.g.,
`babelcast-blackwell-mistral`) stay as they are.

**Files**: `server/config.ts`, possibly a profile registry file if
profiles are keyed per-image.

**Acceptance**: a deploy of `babelcast-subtitle:latest` with no GPU
preference lands on a 4090, not a 5090. The decision is visible in
the `deploy_started` event metadata.

**Effort**: S (15–30 min) — requires finding where profiles are
actually mapped to GPU preferences.

### [ ] P1-5. Create TensorDock SSH key in the account

**Finding**: #2 — one of the 2 TensorDock failures was "No SSH key
found in TensorDock account. Create one at dashboard.tensordock.com".

**What**: manual one-time action at `dashboard.tensordock.com > Security
> SSH Keys`. Add the same public key we register with Vast.ai (`~/.ssh/
id_ed25519.pub`). Note the key ID.

**Files**: none (dashboard action). Update `.env.example` if we want to
document a required `TENSORDOCK_SSH_KEY_ID` env var.

**Acceptance**: a TensorDock deploy attempt no longer fails with
"No SSH key found".

**Effort**: S (5 min, requires dashboard access).

---

## P2 — Reliability and tail latency

These matter because they directly shape what users experience, but
they're less urgent than the financial safety layer.

### [x] P2-1. Investigate Vast.ai SSH tunnel failures (capture full error)

**Finding**: #2 — 43% start→ready failure on Vast.ai; truncated
"SSH tu..." errors hide the root cause.

**What**:
1. First step is **not** a fix — it's a fix to the logging. In
   `src/gpu-providers/vast-client.ts`, find where the SSH tunnel error
   gets truncated and change the call to emit the full error message
   to the lifecycle event (currently 80 chars → 400 chars).
2. Deploy the fix. Wait for the next run of Vast failures to capture
   the full error. **Do not guess at the fix until we see the full
   text.**
3. Once the full error is captured for 2–3 distinct offers, identify
   the pattern: SSH key path, tunnel timeout, port allocation, etc.
4. File a follow-up PR with the actual fix.

**Files**: `src/gpu-providers/vast-client.ts`, possibly
`src/autoscaler/lifecycle-logger.ts` for a dedicated `ssh_tunnel_failure`
event type.

**Acceptance**: a Vast deploy failure emits the full SSH stderr in the
lifecycle event, not a 80-char truncation.

**Depends on**: none, but the **followup fix** depends on having real
data from this capture.

**Effort**: S for the capture fix (30 min). M for the root-cause fix
(TBD, likely 2–4 hours once data is in).

### [ ] P2-2. Add warmup phase to `babelcast-subtitle` container

**Finding**: #3 — first-request CUDA kernel compilation on Blackwell
causes the 16× p95 spike. Warmup would also help the 4090.

**What**: in the container startup script (`dockers/babelcast-subtitle/
start.sh`), after model load but before marking `/health` as ready,
run 3 dummy STT requests against the loaded model. Discard results.
This primes CUDA kernels so the first user request lands warm.

**Files**: `dockers/babelcast-subtitle/start.sh` (in the dockers
submodule). A new "warmup" flag or unconditional — unconditional is
safer.

**Acceptance**: re-running the readiness benchmark against
`babelcast-subtitle:latest` on RTX 5090 shows STT p95 under 2000ms
(10× improvement from 8030ms). On RTX 4090, p95 improves from
1024ms toward the p50 of 517ms.

**Effort**: M (2–3 hours) — includes a dockers submodule commit and a
rebuild, plus a re-run of the benchmark.

### [x] P2-3. Split cooldown by failure category

**Finding**: #5 — a single exponential cooldown treats every failure
the same. Billing errors don't self-heal; capacity errors do.

**What**: in `src/autoscaler/boot-orchestrator.ts`, change the
cooldown calculation to take the failure category into account:

```typescript
const COOLDOWN_BY_CATEGORY = {
  billing: 24 * 60 * 60_000,     // 24h — won't self-heal
  quota: 24 * 60 * 60_000,       // 24h — same
  no_capacity: 5 * 60_000,       // 5m — capacity churn is fast
  ssh_tunnel: 2 * 60_000,        // 2m — transient transport
  api_error: 2 * 60_000,         // 2m — transient
  unknown: 10 * 60_000,          // 10m default
} as const;
```

This requires the cooldown setter to know the category. Currently
it only knows success/fail. Enrich the boot failure path to pass the
category through.

**Files**: `src/autoscaler/boot-orchestrator.ts`, lifecycle logger
to surface the category, tests in `autoscaler-boot-orchestrator.test.ts`.

**Acceptance**: firing a billing-category failure sets cooldown to 24h;
firing a no-capacity failure sets it to 5 min. Both verified in unit
tests.

**Depends on**: none, but pairs well with P1-3 (the max cap and the
category split both live in the same file).

**Effort**: M (3–4 hours).

---

## P3 — Observability hardening

These make future digests (see `docs/insights/`) cheaper and more
reliable. They pay off over time, not immediately.

### [x] P3-1. Declare a schema for lifecycle events

**Finding**: #7 — `metadata` in `gpu.jsonl` is free-form. Different
events use different keys. Aggregation is painful.

**What**: in `src/autoscaler/lifecycle-logger.ts`, declare required and
optional fields per event type. Use a discriminated union:

```typescript
type LifecycleEvent =
  | { event: 'deploy_started'; provider: string; tierIndex: number; dockerImage: string; gpuTypes: string[]; attempt: number }
  | { event: 'deploy_failed'; provider: string; durationMs: number; error: string; failureCategory: string }
  | { event: 'deploy_ready'; provider: string; durationMs: number; instanceId: string; endpoint: string }
  // etc.
;
```

Then refactor the writer so TypeScript enforces the shape at the call
site. Existing free-form `metadata` becomes a typed object.

**Files**: `src/autoscaler/lifecycle-logger.ts`, all call sites that
emit events (~30 files).

**Acceptance**: `bunx tsc --noEmit` fails if a call site omits a
required field. The CI step reads the last 1000 entries of the JSONL
and asserts each conforms to its variant.

**Effort**: L (1–2 days) — large call-site count. Can be staged: land
the schema first, migrate call sites opportunistically.

### [x] P3-2. `bun run insights:digest` script

**Finding**: meta — the insights report took 15 minutes of grep and
Python. If it stays ad-hoc, it won't happen on a schedule.

**What**: create `scripts/telemetry-digest.ts` that:
1. Reads `~/.babelcast/logs/gpu.jsonl`, `readiness-history.json`,
   `cost_ledger.json`, `runpod-quota.json`.
2. Computes the same aggregations manually done today (provider
   success rate, top failure categories, per-image tail latency,
   spend anomalies).
3. Writes a markdown report to `docs/insights/YYYY-MM-DD.md`.
4. Prints a short executive summary to stdout.

Wire it to a new `package.json` script `insights:digest`.

**Files**: `scripts/telemetry-digest.ts` (new), `package.json` (script
entry).

**Acceptance**: running `bun run insights:digest` today produces a
doc that contains the same findings 1–7 as the first-pass report
(within reason — numbers may differ as new data accumulates).

**Effort**: M (3–5 hours). Clean TS code that replicates the Python
analysis in this session.

### [x] P3-3. Profile Fly.io cold start and attribute the 2s

**Finding**: #6 — cold start is 2.03s. Suspected cause: pino module
load. But "suspected" ≠ "known".

**What**: attach `bun --inspect` to a Fly.io machine in dev mode,
capture a cold start trace, attribute the time:

- Bun runtime init
- `serve.ts` + deps import (pino, tsup output, etc.)
- First HTTP bind
- First health response

If pino is <300ms of the 2000ms total, it's a red herring. If it's
>1000ms, confirm and explore alternatives (`pino/destination` async
mode, lazy logger init).

**Files**: none (investigation), possibly `docs/ops/baseline.md` to
record findings.

**Acceptance**: a dated entry in `docs/insights/` or `docs/ops/baseline.md`
attributing the cold-start 2s to specific modules with millisecond
breakdowns.

**Effort**: M (2–4 hours) — can run in parallel with anything else.

---

## Deferred (acknowledged but not in this plan)

- **Full OpenTelemetry rollout**. Every finding here can be solved with
  the existing logger + SLO + lifecycle pipeline. OTel is the right
  step *after* this plan lands.
- **Migrate the remaining ~25 files from `console.*` to `createLogger()`**.
  The sprint migrated the 3 hottest paths. The rest migrate
  opportunistically when touched for a feature.
- **Break up god files** (`gpu-deploy.ts` 2924 LOC, `vast-client.ts`
  2675 LOC). Not urgent.
- **SLO dashboards** — a Grafana Cloud or similar that reads
  `/metrics?format=prometheus`. Waiting until we know what's worth
  dashboarding (this plan tells us).

---

## Recommended execution order

```
Week 1
  Day 1   P0-1  (budget cap test + fix)               [M]
  Day 1   P1-1  (modal install + preflight)           [S]
  Day 1   P1-2  (fly min_machines_running)            [S]
  Day 2   P0-2  (runaway detector)                    [M]
  Day 2   P1-3  (cooldown max cap)                    [S]
  Day 3   P0-3  (50/80% cost alerts)                  [M]
  Day 3   P1-4  (pin subtitle to 4090)                [S]
  Day 4   P2-1a (capture full SSH error, deploy)      [S]
  Day 5   P3-3  (profile cold start)                  [M]

Week 2
  Day 6   P2-3  (split cooldown by category)          [M]
  Day 7   P2-2  (babelcast-subtitle warmup)           [M]
  Day 8   P3-2  (insights:digest script)              [M]
  Day 9   P2-1b (fix Vast SSH tunnel based on data)   [M]
  Day 10  P3-1  (lifecycle event schema)              [L, partial]
```

P1-5 (TensorDock SSH key) is a dashboard action — do whenever you're
logged into the TensorDock console.

---

## Progress log

| Date | Item | Notes |
|---|---|---|
| 2026-04-12 | Plan created | Derived from docs/insights/2026-04-12-first-pass.md |
