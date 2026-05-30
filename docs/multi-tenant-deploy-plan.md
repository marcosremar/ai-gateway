# Multi-Tenant Per-App GPU Deploy Slots — Implementation Plan (Steps 2–7)

> Read-only analysis of the live tree (`server/*.ts` + `src/gateway/*.ts`). Step 1
> (the `DeploySlot` sink indirection) is DONE and committed. This doc drives Steps 2–7.

## 1. Architecture summary + the global-vs-slot principle

Today the entire GPU deploy/serve/monitor subsystem is a **single global singleton**.
There is exactly one `deployState` (a mutable module-level `let` in
`src/gateway/state/deploy-state.ts:95`), one `deployLock`/`deployCancelled`/`deployPromise`,
one `gpuHealthy`/`activeProvider`, one `deploymentSM` (`server/deployment-state-machine.ts`
→ `src/gateway/deploy/state-machine.ts`), one `monitorInterval` (`server/state.ts:75`), one
warmth-monitor timer (`server/gpu-warmth-monitor.ts:14`), one `active_deploy.json`
(`deploy-state.ts:179`), and inference routing reads the single `deployState.endpoint`.
Step 1 already added a `DeploySlot` registry (`createDeploySlot/getDeploySlot/listDeploySlots/
deleteDeploySlot`, `freshDeploymentState()`) and made `setDeployState(patch, slot?)` route to a
slot's `state` when one is passed — byte-identical when omitted (`server/state.ts:85-113`).

**The principle:** the GLOBAL slot is the single production-serving pod that inference routes
to. NAMED per-owner slots are isolated job pods (esp. finetune JOBS) that must NEVER mutate
global health / monitoring / routing / persistence. Every global side-effect in the deploy
path is classified as:

- **SKIP** — global-only, must be guarded with `if (!slot)` so slot deploys don't touch it
  (health flag, monitors, provider-key routing, global persistence, `activeProvider`, SM).
- **PER-SLOT** — must be re-pointed at the slot (state writes, cancel checks, per-slot persist).
- **SHARED** — safe to leave global (metrics, host-reputation, tier-ranking, cooldown,
  budget/runaway detectors, WS broadcasts that already carry an `owner` field).

Jobs are **deployId/podId-addressed**, not endpoint-routed — so Steps 2–6 deliver full job
concurrency WITHOUT touching inference. Per-app *serving* routing (a `Map<userId,endpoint>`)
is the separate Step 7 epic, needed only if app-keyed pods must also *serve inference*.

---

## 2. TABLE — every global effect in the deploy execution path

Files: `gpu-deploy-loop.ts` (`startDeployLoop`), `gpu-deploy-with-tiers.ts`
(`startDeployWithTiers`/`_executeDeploy`), `gpu-deploy-race.ts` (`startDeployRace`),
`gpu-poll-health.ts` (`pollHealthUntilReady`).

| Effect | file:line (samples) | What it impacts | Slot-mode |
|---|---|---|---|
| `setDeployState({status,...})` | `gpu-deploy-loop.ts:109,152,194,258,320,397,472,485,539,547`; `with-tiers.ts:100,285,302,310,369,385,392`; `race.ts:101,178,277,387,516`; `poll-health.ts:511,519,526,536,658,684,708,755,787,810,860,875,895,913,1002,1029,1082,1127,1165,1200,1216` (~70 calls total) | Writes the global serving state → drives status API, list `isActive`, persistence, WS, monitor gating, orphan-sweep safety. | **PER-SLOT** (thread `slot` to every call) |
| `deployCancelled` read | `gpu-deploy-loop.ts:233,251,311,417`; `with-tiers.ts:224`; `race.ts:317,515`; `poll-health.ts:514,619,628` | Control-flow: aborts the loop / poll on global cancel. | **PER-SLOT** (read `slot.cancelled`) |
| `setDeployCancelled(false/true)` | `gpu-deploy-loop.ts:104` | Resets/sets the global cancel flag. | **PER-SLOT** (`slot.cancelled=false`) |
| `setGpuHealthy(true)` | `gpu-deploy-loop.ts:150,192,358,395`; `race.ts:384` | Flips global `gpuHealthy` → gates `isGpuAvailable()` → **inference routes to this pod**. | **SKIP** for slots (`if(!slot)`) — a job pod must never become the serving target. |
| `setLastRequestTime(Date.now())` | `gpu-deploy-loop.ts:151,193,359,396`; `race.ts:385`; `poll-health.ts:535,880` | Resets global idle clock used by the monitor loop's idle/stop logic. | **SKIP** for slots |
| `deploymentSM.startBooting/markReady/markError/startDeploying/markStopped` | `gpu-deploy-loop.ts:146,154,174,334,370,399,428,473,486,498,540,548`; `with-tiers.ts:353,358,386`; `race.ts:102,120,153,279,292,397,517`; `gpu-handlers.ts:1044`; `gpu-idle-manager.ts:128` | Global deployment state machine: `.isStopped` drives auto-resume (`state.ts:212`), `.endpoint` is a routing fallback, `.isDeploying` gates other deploys. | **SKIP** for slots (slots get their own lightweight phase via `slot.state.status`; don't drive the global SM). |
| `setActiveProvider(name)` | `gpu-deploy-loop.ts:105` | Global `activeProvider` → monitor uses it to pick the client for health/restart/balance + `autoStopGpu` credential dispatch. | **SKIP** for slots (slot watchdog carries its own provider) |
| `setDeployApiKey`/`setDeployVastApiKey`/`setDeployTensordockApiKey`/`AuthId`/`setDeployModalApiKey`/`setDeployHyperstackApiKey` | `with-tiers.ts:227-231`; `race.ts:171-175` | Global provider-credential routing used by monitor + autoStop + terminate fallbacks. | **SKIP** for slots (carry creds on the slot; see §E). |
| `startGpuMonitoring()` | `gpu-deploy-loop.ts:163,204,372,411`; `race.ts:398` | Starts the single global `monitorInterval` (health, budget, P95, idle→stop, crash-recovery). | **SKIP** for slots → replace with per-slot watchdog (§C). |
| `startBackgroundWarmthMonitor(endpoint)` | `gpu-deploy-loop.ts:164,205,373,412`; `race.ts:400-401` | Starts the single global warmth timer; on warm it calls `_startReadinessCheck` which sets `translationDefaults.gpuEndpoint` → inference. | **SKIP** for slots. |
| `startCanaryIfEnabled(...)` | `gpu-deploy-loop.ts:165,206,374,413`; `race.ts:402` | Canary traffic split on the global serving pod. | **SKIP** for slots. |
| `updateGpuModelWarmth(data)` | `race.ts:386`; `poll-health.ts:1114` | Mutates global readiness/warmth state read by router. | **SKIP** for slots (or write to a slot-local warmth blob, not needed for jobs). |
| `persistDeployState()` (inside `setDeployState`) | `state.ts:168` | Writes global `active_deploy.json`. | **PER-SLOT** (write `slot.persistFile`; Step 4). |
| `clearPersistedDeploy()` | `with-tiers.ts:352,368` | Deletes global `active_deploy.json`. | **PER-SLOT** (Step 4). |
| `broadcastWs(...)` / `broadcastProviderStatus(...)` | `gpu-deploy-loop.ts:119,259,276,526`; `with-tiers.ts:126,155`; `race.ts:100,118,396`; `poll-health.ts:651,657,674,683,701,707,741,996,1081,1126,1134,1171,1222` | UI updates. `setDeployState`'s slot branch already broadcasts with `owner` (`state.ts:108`). | **SHARED** (add `owner` field where useful; harmless). |
| `logGpuEvent` / `startDeploySession`/`updateDeploySession` / `upsertHostReputation` / `recordTierLatency` / `cooldownTracker.*` / `recordHostCrash` / `emitGatewayEvent` | `with-tiers.ts:84,118,234,235,248,259,268,316,317,326,339`; `gpu-deploy-loop.ts:133,162,...`; `race.ts:97,117,404-417` | Global telemetry, host reputation, cooldowns, tier-ranking, runaway/budget. | **SHARED** (global aggregates are correct and desirable; jobs feed the same learning). |
| `canAffordDeploy` budget gate + `getGlobalRunawayDetector().recordDeployStart` | `with-tiers.ts:113-135,140-162`; `gpu-deploy-loop.ts:241`; `race.ts:91-104,108-123` | Cost/abuse guards across the whole account. | **SHARED** (must still apply to slot deploys — account-wide caps). |
| `activeRaceInstanceIds.add/delete` | `race.ts:284,492` | Orphan-sweep "don't kill mid-race" set. | **SHARED** (still needed for slot race deploys — the set is keyed by instanceId). |
| `updateActivePipeline({gpuEndpoint})` | `gpu-idle-manager.ts:120`; `gpu-handlers.ts:911,1254` | Points inference pipeline at the global endpoint. | **SKIP** for slots. |
| `setActiveDeploySessionId` | `deploy-state.ts:291` (setter only; not called in this hot path) | Legacy session id. | **SHARED** (untouched). |

**Critical orphan-sweep finding:** `collectTrackedInstanceIds()`
(`gpu-orphan-cleanup.ts:238-255`) builds the "do not kill" set from **only**
`deployState.podId` (global), `standbyDeployState.podId`, `activeRaceInstanceIds`, and a regex
over the last 10 global `transitions`. A slot pod's `podId` lives in `slot.state.podId` and is
**not** in this set → the orphan sweep will terminate live job pods. Also
`getSweepSafetyAbortReason()` (`:257-274`) only reads the global status, so it won't grant the
in-progress grace period to a slot deploy. Both MUST be slot-aware (Step 3).

---

## 3. Step-by-step plan (ordered by dependency)

### Step 2 — Thread an optional `slot` through the deploy execution path
**Scope:** `startDeployLoop`, `startDeployWithTiers`/`_executeDeploy`, `startDeployRace`,
`pollHealthUntilReady` accept an optional `slot?: DeploySlot` and route all PER-SLOT effects to
it, SKIP all global-only effects when a slot is present. **Zero behavior change when `slot` is
undefined** (the only call path today) → independently shippable behind the default.

**Exact edits:**
- `server/gpu-deploy-loop.ts`
  - Add `slot?: DeploySlot` param to `startDeployLoop(...)` (after `extra`).
  - Introduce locals at top: `const ds = slot ? slot.state : deployState;` and a helper
    `const setState = (p: Partial<DeploymentState>) => setDeployState(p, slot);`
    Replace every `setDeployState({...})` with `setState({...})`, every `deployState.X` read
    with `ds.X`, every `deployCancelled` read with `(slot ? slot.cancelled : deployCancelled)`.
  - `setDeployCancelled(false)` (line 104) → `if (slot) slot.cancelled = false; else setDeployCancelled(false);`
  - `setActiveProvider` (105) → guard `if (!slot) setActiveProvider(providerName);`
  - On every `ready` branch (150-165, 192-206, 357-374, 394-413): wrap
    `setGpuHealthy(true); setLastRequestTime(...); deploymentSM.markReady(...);
    startGpuMonitoring(); startBackgroundWarmthMonitor(...); startCanaryIfEnabled(...)` in
    `if (!slot) { ... } else { startSlotWatchdog(slot); }` (watchdog from Step 3).
  - All `deploymentSM.startBooting/markError` → `if (!slot) deploymentSM.X(...)`.
- `server/gpu-deploy-with-tiers.ts`: same `slot?` param on `startDeployWithTiers`/`_executeDeploy`;
  guard the `setDeployApiKey`/`setDeployVast...` block (227-231) with `if (!slot)` and instead
  stash creds on the slot (`slot.creds = {provider: tier.name, apiKey, authId}`); pass `slot`
  into `startDeployLoop` (244); replace `deployState`/`deployCancelled`/`setDeployState` reads;
  guard `deploymentSM.markError` and `clearPersistedDeploy()` (352,368) to per-slot.
- `server/gpu-deploy-race.ts`: same `slot?`; guard cred-setters (171-175), `setGpuHealthy`/
  `setLastRequestTime`/`deploymentSM.*`/`startGpuMonitoring`/`startBackgroundWarmthMonitor`/
  `startCanaryIfEnabled`/`updateGpuModelWarmth` (384-401) behind `if (!slot)`; keep
  `activeRaceInstanceIds` SHARED.
- `server/gpu-poll-health.ts`: add `slot?` param; replace internal `deployState`/`deployCancelled`/
  `setDeployState`/`setLastRequestTime`/`updateGpuModelWarmth` with slot-aware locals. The
  `readinessProbe === 'ssh'` check (562) reads `deployState.readinessProbe` → use `ds.readinessProbe`.

**New code:** `slot.creds?: { provider: ProviderName; apiKey: string; authId?: string }` field
on `DeploySlot` (add to `deploy-state.ts:134-141`).

**Test gate:** `__tests__/gpu-deploy-unit.test.ts`, `__tests__/gpu-deploy-ranking.test.ts`,
`server/gpu-deploy-with-tiers` paths covered by `__tests__/zero-downtime-deploy.test.ts`. Add
`__tests__/deploy-slot-isolation.test.ts`: deploy into a named slot with a mocked provider
client, assert `deployState` (global) stays `idle`, `gpuHealthy===false`, `monitorInterval===null`,
no `active_deploy.json` write, while `slot.state.status` walks `creating→booting→ready`.

**Rollback safety:** Pure additive param. With no caller passing `slot`, the full suite must be
byte-identical (the `slot` branch is dead). Ship behind the unchanged default path.

**Size:** Large mechanical (~70 `setDeployState` rewrites + guards across 4 files), low risk.

---

### Step 3 — Per-owner lightweight watchdog + slot-aware orphan sweep
**Scope:** A job pod needs (a) NOT to be swept as an orphan, (b) a minimal liveness check, and
(c) NO idle-stop (jobs run to completion). It must NOT join the global `monitorInterval` (which
does idle→stop, P95 demotion, crash auto-redeploy, budget hard-terminate — all wrong for jobs).

**Recommendation: a minimal per-slot watchdog, NOT the global monitor.** Reasons:
- The global monitor (`gpu-monitor-loop.ts:105-538`) is a singleton (`scheduleNextMonitorProbe`
  uses the single `monitorInterval` via `setMonitorInterval`) and reads `deployState.endpoint`,
  `activeProvider`, `deployApiKey`, `lastModelRequestTime` — all global. It would idle-stop the
  job at `IDLE_TIMEOUT_MS` (5 min, `:49`) because a job emits no model requests.
- A job only needs: poll `slot.state.endpoint/health` every ~30s, update `slot.state` (temp/util
  for UI), and on terminal detection mark the slot done. NO auto-stop, NO P95, NO crash-redeploy.

**Exact edits / new code:**
- New file `server/gpu-slot-watchdog.ts`:
  ```ts
  const slotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  export function startSlotWatchdog(slot: DeploySlot) { /* poll slot.state.endpoint/health,
     setDeployState({gpuTemp,gpuUtil,...}, slot); stop when slot.state.status !== 'ready'
     or slot.cancelled; no idle-stop */ }
  export function stopSlotWatchdog(ownerKey: string) { clearTimeout + delete }
  ```
- `server/gpu-orphan-cleanup.ts`
  - `collectTrackedInstanceIds()` (`:238`): after the existing adds, append
    `for (const s of listDeploySlots()) if (s.state.podId) tracked.add(s.state.podId);`
  - `getSweepSafetyAbortReason()` (`:257`): also abort if ANY slot is mid-deploy:
    `for (const s of listDeploySlots()) { const st=s.state.status; if (st && !['idle','ready','error','stopped','terminated'].includes(st)) return 'slot deploy in progress'; }`

**Test gate:** new `__tests__/orphan-sweep-slot.test.ts` — register a slot with a `podId`, stub
provider `listInstances` to return that id, assert `sweepOrphanInstances()` does NOT terminate
it. Existing `server/orphan-sweep-vast.test.ts` must still pass. Watchdog: unit test it polls,
updates `slot.state`, and stops on cancel WITHOUT calling `autoStopGpu`.

**Rollback safety:** Sweep change is additive (only ever *adds* protected ids → strictly safer;
worst case it protects a pod it shouldn't, never kills one it should protect). Watchdog only
runs for named slots. Independently shippable.

**Size:** Small-medium.

---

### Step 4 — Per-owner persistence + startup enumerate/reconnect
**Scope:** Persist each slot to `active_deploy.<owner>.json` (`slot.persistFile` already exists,
`deploy-state.ts:165`) and reconnect owner slots on startup.

**Exact edits / new code:**
- `src/gateway/state/deploy-state.ts`
  - Refactor `persistDeployState()` (`:209`) and `clearPersistedDeploy()` (`:253`),
    `loadPersistedDeploy()` (`:264`) into a parameterized core
    `persistDeployStateTo(state, file)` / `clearPersisted(file)` / `loadPersisted(file)`.
    Keep the existing no-arg wrappers delegating to the global file (byte-identical).
  - Add `persistDeploySlot(slot)` / `clearPersistedSlot(slot)` calling the core with
    `slot.persistFile` and `slot.state`. Add `enumeratePersistedSlots(): {ownerKey, file}[]`
    that globs `~/.babelcast/active_deploy.*.json`.
- `server/state.ts` `setDeployState` slot branch (`:90-113`): after the slot mutate/broadcast,
  call `persistDeploySlot(slot)` (mirrors the global `persistDeployState()` at `:168`).
- `server/ws/startup-tasks.ts` (`:141-161`): after `tryRecoverActiveDeploy()` (global), add a
  loop over `enumeratePersistedSlots()` → for each, `createDeploySlot(owner)`, `loadPersisted`,
  health-probe the endpoint, and either restore `slot.state` + `startSlotWatchdog` or
  `clearPersistedSlot`. New helper `tryRecoverSlotDeploys()` in `gpu-auto-recovery.ts`
  (mirror `tryRecoverActiveDeploy` at `:123`, but slot-scoped — does NOT touch `gpuHealthy`/
  `deploymentSM`/monitor).

**Test gate:** `__tests__/deploy-state-persist-id.test.ts` (existing — must still pass for the
global file). New `__tests__/deploy-slot-persist.test.ts`: persist a slot, assert a distinct
file path + JSON shape; assert the global `active_deploy.json` is untouched; assert
`enumeratePersistedSlots()` finds it. Stub `fs` or use a temp `HOME`.

**Rollback safety:** Global persistence path unchanged (delegation). Slot files are new
namespaced paths → no collision with `active_deploy.json`. Independently shippable.

**Size:** Medium.

---

### Step 5 — Router in `handleGpuDeploy`: per-owner slot + per-owner lock (vs 409)
**Scope:** When a caller-owned deploy arrives for a DIFFERENT owner than the current global
serving pod, route it to that owner's slot + per-owner lock instead of the 409 refusal
(`gpu-handlers.ts:1205-1216`). The GLOBAL slot path (loopback/admin, the serving pod) is
unchanged. **This is the first behavior-changing step.**

**Current 409 block (`gpu-handlers.ts:1205-1216`):**
```ts
if (deployState.status !== 'idle' && ... && deployState.userId && callerUserId &&
    deployState.userId !== callerUserId) { res.writeHead(409, ...); return; }
```

**Exact edits / new code:**
- New per-owner lock registry (in `deploy-state.ts` or a small `server/deploy-router.ts`):
  the `DeploySlot` already has `lock`/`promise`; use `getDeploySlot(owner)?.lock`. Add helper
  `withOwnerSlot(callerUserId): { slot, isGlobal }` — returns the global path for
  `null`/loopback and a named slot (`createDeploySlot(callerUserId)`) otherwise.
- In `handleGpuDeploy` (`:1165`): compute `callerUserId` (already at `:1180`). Decide routing:
  - If `callerUserId` is null OR equals the global owner (`deployState.userId`) → **global path,
    unchanged** (existing idempotency `:1195`, cancel-redeploy `:1218`, `deployLock` `:1261`).
  - Else → **slot path**: skip the global 409 / cancel-redeploy / `deployLock` blocks entirely.
    Use `slot.lock` for anti-clobber (return 409 only if THAT owner already has an in-flight
    deploy: `if (slot.lock) 409; slot.lock = true`).
- `_startDeployAndRespond` (`:1024`): add a `slot?: DeploySlot` param. When set, skip
  `setDeployCancelled(false)` global (`:1035`) and `deploymentSM.startDeploying()` (`:1044`);
  write the deployId/initial state via `setDeployState({...}, slot)`; pass `slot` into
  `startDeployRace`/`startDeployWithTiers` (`:1088-1090`); the `.finally()` (`:1104`) releases
  `slot.lock` and clears `slot.promise` instead of `setDeployLock(false)`.
- The `finetuneDeployActive` global guard (`:1191,1221,1246`) becomes per-slot for slot deploys
  (a finetune job in owner A's slot shouldn't block owner B).

**Test gate:** `__tests__/gpu-handlers-unit.test.ts` + new
`__tests__/deploy-router-multitenant.test.ts`: (a) two different `x-aigw-user-id` headers deploy
concurrently → both get 202, two slots, global stays idle; (b) same owner twice in-flight → 409
from `slot.lock`; (c) loopback (no header) still drives the global path; (d) a slot deploy does
NOT cancel an in-progress global deploy and vice-versa.

**Rollback safety:** The global path (null/loopback caller, or matching owner) is byte-identical.
Behavior only changes for cross-owner authenticated callers (previously 409, now isolated slot).
Gate behind an env flag `AIGW_MULTITENANT_DEPLOY=1` for staged rollout; default off → old 409.

**Size:** Medium.

---

### Step 6 — Lifecycle handlers operate on the caller's slot
**Scope:** `handleGpuStatus`/`handleGpuList` (`gpu-handlers-info.ts:261,405`),
`handleGpuStop` (`gpu-handlers.ts:1776`), `handleGpuResume` (`:1916`), `handleGpuTerminate`
(`:1479`) resolve the caller's slot and act on it; loopback/admin still sees/acts on the global.

**Exact edits:**
- Status (`:261-403`): resolve `slot = callerUserId ? getDeploySlot(callerUserId) : undefined;
  const ds = slot ? slot.state : deployState;` and build the response from `ds`. The existing
  owner-hide guard (`:270`) is superseded — a slot owner sees their slot, not the global.
- List (`:405`): merge provider-queried instances with BOTH `deployState` (global, if admin) and
  the caller's slot's tracked pod; `isActive` (`:437,446`) compares against the right `podId`.
- Stop (`:1776`)/Resume (`:1916`): the owner guards (`:1821`, `:1957`) become "operate on
  `getDeploySlot(callerUserId)`"; lock via `slot.lock` instead of global `deployLock`; call
  `autoStopGpu`/`resumeOrDeploy` slot-aware (these read globals today — pass slot creds + state;
  `gpu-idle-manager.ts:50-72` resolves creds from `activeProvider`/`deployApiKey` → must accept a
  slot). Stop must call `stopSlotWatchdog`, not `stopGpuMonitoring`.
- Terminate (`:1479`): the `_resolveInstanceOwner` ownership guard (`:1448-1477,1512`) stays.
  Add: if `callerUserId` has a slot whose `podId` matches, delete that pod + `deleteDeploySlot` +
  `clearPersistedSlot` + `stopSlotWatchdog`, instead of touching global `deployState`.

**Test gate:** `__tests__/gpu-handlers-unit.test.ts` (existing owner-guard tests must still pass
for global). New tests: status with owner header returns slot state; stop/terminate with owner
header acts only on that owner's pod and leaves global ready; cross-owner terminate still 403.

**Rollback safety:** Loopback/admin path unchanged. Same `AIGW_MULTITENANT_DEPLOY` gate.

**Size:** Medium-large (5 handlers + slot-aware `autoStopGpu`/`resumeOrDeploy`).

---

### Step 7 — Per-app SERVING inference routing (separate epic)
**Scope:** ONLY needed if app-keyed slot pods must also *serve inference* (not just run jobs).
**Not required for finetune jobs** — jobs are deployId/podId-addressed and never appear in the
inference path.

**Why it's separate:** Inference finds the GPU endpoint exclusively via the GLOBAL
`deployState.endpoint`:
- `pipeline-runner.ts:95,101,110` (`gpuEp = isGpuAvailable() ? deployState.endpoint : undefined`).
- `ai-handlers.ts:197,291,301,527,598,606,776,810,828,983,1230,1250` (all read
  `deployState.endpoint` + `isGpuAvailable()`/`isGpuReadyForProduction()`).
- `state.ts:224 isGpuAvailable()` = `deployState.status==='ready' && gpuHealthy && deployState.endpoint`.
- `hybrid-router.ts` is pure — it takes injected readers (`isGpuAvailable`, `gpuHealthy`, etc.,
  `:28-48`) but no per-request user identity; it returns `provider:'gpu'` with no endpoint
  (the endpoint is resolved downstream from the global state).

**What it requires:** a `Map<userId,endpoint>` serving router. Thread `userId` from the inference
request through `buildRouting` (`pipeline-runner.ts:90`) → resolve
`endpoint = servingRouter.get(userId) ?? deployState.endpoint`, and make `isGpuAvailable(userId)`
slot-aware. This is invasive across the entire inference hot path and is explicitly **deferred**.

**Confirmation:** Steps 2–6 give full job concurrency with ZERO inference changes. Step 7 is the
serving-routing epic, taken only when per-app pods must serve.

---

## 4. #1 risk per step + how tests catch it

| Step | #1 risk | Caught by |
|---|---|---|
| 2 | A missed `setDeployState`/`deployState` rewrite leaks a slot deploy into global state (flips `gpuHealthy`, starts the global monitor). | Full vitest suite (global path must stay byte-identical) + new `deploy-slot-isolation.test.ts` asserting `deployState`/`gpuHealthy`/`monitorInterval`/`active_deploy.json` all untouched after a slot deploy reaches `ready`. |
| 3 | Orphan sweep terminates a live job pod (slot podId not tracked) OR watchdog idle-stops the job. | `orphan-sweep-slot.test.ts` (slot pod is protected) + watchdog test asserting NO `autoStopGpu` call + existing `orphan-sweep-vast.test.ts`. |
| 4 | A slot persist clobbers `active_deploy.json` → corrupts global recovery. | `deploy-state-persist-id.test.ts` (global file unchanged) + `deploy-slot-persist.test.ts` (distinct paths, no cross-write). |
| 5 | Slot router accidentally cancels the global serving deploy (or vice-versa). | `deploy-router-multitenant.test.ts` cross-cancel cases + `e2e-concurrency.test.ts`/`resilience-concurrency-db.test.ts` regressions. |
| 6 | Stop/terminate on a slot tears down the global serving pod (wrong creds/podId). | Handler tests asserting global stays `ready` after an owner-scoped stop/terminate; cross-owner 403 preserved. |
| — | **New concurrency test** `__tests__/deploy-slot-concurrency.test.ts`: launch a global deploy AND a named-slot deploy with mocked clients, run both to `ready`, assert: global `deployState.status==='ready'` && `gpuHealthy===true` && `monitorInterval!==null`; slot `ready` with its OWN podId/endpoint, `gpuHealthy` unaffected, slot watchdog (not global monitor) running, two distinct persist files. This is the single guard that proves the epic's goal. |

The full suite passing with `slot===undefined` everywhere proves Steps 2–4 are zero-diff for the
default path; the concurrency test proves the isolation invariant.

---

## 5. Minimal path to run the finetune JOB concurrently

To let a moss-tts finetune JOB run alongside the global serving pod, ship the smallest subset —
**Step 2 + Step 3-lite + Step 5** (skip Step 4 persistence and Step 7 serving-routing):

1. **Step 2** — `slot?` threaded through `startDeployLoop`/`startDeployWithTiers`/`startDeployRace`/
   `pollHealthUntilReady`, all global effects SKIP-guarded. (Required: this is what makes a slot
   deploy not clobber global state.)
2. **Step 3-lite** — ONLY the `gpu-orphan-cleanup.ts` change (add slot podIds to
   `collectTrackedInstanceIds` + slot-aware `getSweepSafetyAbortReason`) so the sweep doesn't
   kill the job pod. The watchdog can be a stub (no health polling needed — a finetune job
   self-terminates; you just must NOT run the global monitor against it, which Step 2 already
   ensures by skipping `startGpuMonitoring`). Idle-stop is moot because no global monitor runs.
3. **Step 5** — the `handleGpuDeploy` router: a finetune call carrying `x-aigw-user-id` (the
   moss-tts app key) routes to `createDeploySlot(owner)` with per-slot lock instead of the 409.
   Gate behind `AIGW_MULTITENANT_DEPLOY=1`.

**Skip for the minimal path:** Step 4 (the job is ephemeral — if the gateway restarts mid-job,
the orphan-reconnect/sweep handles cleanup; no per-slot reconnect needed yet) and Step 7 (the
finetune pod is reached by its deployId/SSH/endpoint returned in the deploy 202 + status, never
by the inference router).

**Result:** the finetune job runs in its own slot on its own pod; the global serving pod keeps
its `gpuHealthy`/monitor/routing entirely untouched and continues serving inference. Step 6 (slot
status/stop/terminate) is a fast-follow for operability but is not strictly required to *run* the
job concurrently — admin/loopback can still terminate the job pod by `instanceId` via the
existing targeted-terminate branch (`gpu-handlers.ts:1568-1632`).
