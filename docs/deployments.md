# Deployments — a Docker image behind an autoscaled endpoint (Scaleway, Vast)

Register a Docker image once; the gateway rents Scaleway machines for it, scales them with traffic (down to zero),
and forwards requests to a ready replica. Other sites only see `https://<gateway>/v1/deployments/<name>/invoke/...`.

Code: `src/deployments/` (pure planner in `planner.ts`, loop in `controller.ts`, HTTP in `http.ts`, boot script in
`cloud-init.ts`, placement in `placements.ts` / `placement-walk.ts`). Mounted by `serve.ts` when `SCW_SECRET_KEY` and/or
`VAST_API_KEY` is set. Providers: **`scaleway`** (datacenter VMs, any image; the default) and **`vast`** (Vast.ai
marketplace GPU hosts, boot-script mode only — see [Vast replicas](#vast-replicas)).

## Quick start

```bash
GW=https://ai-gateway.up.railway.app; KEY=...   # a key from GATEWAY_API_KEYS

# 1. Create from a profile (Qwen3-TTS on an L4, 0..2 replicas, scale to zero after 15 min idle)
curl -X PUT $GW/v1/deployments/tts -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"profile":"qwen3-tts","maxReplicas":2}'

# …or from any image
curl -X PUT $GW/v1/deployments/my-model -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{
  "image": "ghcr.io/me/my-model:1", "port": 8000, "healthPath": "/health",
  "machineType": "L4-1-24G", "zone": "fr-par-2",
  "minReplicas": 0, "maxReplicas": 3, "targetInflightPerReplica": 4, "idleMinutes": 15,
  "env": {"HF_TOKEN": "..."}, "registryAuth": {"server": "ghcr.io", "username": "me", "password": "..."}
}'
# An image in the gateway's own Scaleway registry (rg.<region>.scw.cloud/…) needs no registryAuth: the machine logs in
# with the gateway's Scaleway key, so no registry secret is ever sent or stored in a spec.

# 2. Call it — the path after /invoke/ goes to the container as-is
curl $GW/v1/deployments/tts/invoke/v1/audio/speech -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"input":"Olá!","voice":"vivian"}' -o out.wav

# 3. Change replicas any time (applies on the next loop, ≤ 20 s)
curl -X PATCH $GW/v1/deployments/tts -H "Authorization: Bearer $KEY" -d '{"minReplicas":1,"maxReplicas":3}'

# Pre-warm before a class / launch (boots now instead of on the first request)
curl -X POST $GW/v1/deployments/tts/wake -H "Authorization: Bearer $KEY"
```

## API

| Method | Path | |
|---|---|---|
| GET | `/v1/deployments` | all deployments + `health` (last provider error) + `declared` (see below) |
| PUT | `/v1/deployments/:name` | create or update (fields merge over the current spec; `profile` re-applies a profile) |
| PATCH | `/v1/deployments/:name` | update an existing one |
| GET | `/v1/deployments/:name` | status (`scaled-to-zero` · `warming` · `ready` · `degraded` · `paused`), replicas, `lastError` |
| DELETE | `/v1/deployments/:name` | releases every machine, forgets the spec |
| POST | `/v1/deployments/:name/wake` | start replicas now |
| GET | `/v1/deployments/:name/capacity` | session ceiling in force and measured boot / resume time per machine type + image, mode, budget spent, hold (see Scaling policy) |
| POST | `/v1/deployments/:name/warm` | `{ "replicas": N, "untilMinutes": M }`: keep N replicas up for M minutes (≤ 720) whatever the load — a class about to start; `park` ends it (admin) |
| any | `/v1/deployments/:name/invoke/<path>` | forwarded to a ready replica as `/<path>` |
| GET | `/v1/profiles` | built-in (`qwen3-tts`, `qwen3-tts-clone`, `cpu-echo`) + stored |
| PUT / DELETE | `/v1/profiles/:name` | store / delete your own profile (same fields as a spec) |

Mutations require an admin key: a user in `DEPLOYMENTS_ADMIN_USERS` (empty = no admin at all). A non-admin key invokes only its own app's deployments. `env` values and `registryAuth` are
never returned. Spec fields and defaults: `src/deployments/spec.ts` (`SPEC_DEFAULTS`).

## Declared deployments

Some deployments are declared in the repo and the gateway keeps them registered by itself — nobody has to remember a
`PUT`. Each `src/deployments/declared/<name>.json` (listed in `DECLARED_DEPLOYMENTS`, `src/deployments/declared.ts`)
holds the spec **without secrets**; at boot (before the routes are mounted) and every 5 min the gateway builds the
body, compares it with the stored spec and calls the same idempotent `controller.put` only when something changed
(new image, rotated credential). A deployment that does not exist yet is created from the declaration's `profile`
when it names one; an existing one is never reset to the profile. Registering never starts a machine: declared specs keep `minReplicas: 0` and the
reconciler never wakes them — a replica starts on the first request that needs it, as for any deployment.

Secrets are mounted from the environment (the dev API) at each reconcile:

| Declaration field | Source |
|---|---|
| `image.env` (`SPEECH_IMAGE`) | a full reference, or just a tag of `image.repository`; unset → `image.default` |
| `registryAuth.passwordEnv` (e.g. `GHCR_READ_TOKEN`) | the password of a private registry (a GHCR token with `read:packages`, …); only for a declaration that has `registryAuth` — `parle-speech` has none |
| `generatedSecrets` (e.g. `SPEECH_TOKEN`) | generated once (32 chars `[A-Za-z0-9_-]`), persisted with the spec in the deployment store, reused afterwards; never logged nor returned |

**Pending, never broken:** without the credential a declaration asks for, or an image, the deployment is not
registered and its status is `pending` with the reason (`<passwordEnv> is not set …`) — a replica that cannot pull its private image would be a
billed machine that never serves. A deployment already registered keeps its stored spec while the credential is
missing. The status is in `GET /v1/deployments` (`declared`), `GET /health?deep=1` and, per stage, in `GET /health`.
A key that appears through a key reload registers the deployment at once. `DECLARED_DEPLOYMENTS=0` turns the
reconciler off. Fields the declaration does not hold (`paused`, sizing and limits it does not list, `env` when it
declares neither `env` nor `generatedSecrets`, …) are left as an operator set them; declared fields changed by hand
are put back. `envByMachineType` is merged per key: the declared keys are put back, the stored ones stay.

### `parle-speech` (one GPU for STT + LLM + TTS)

`src/deployments/declared/parle-speech.json`: the `rg.fr-par.scw.cloud/aigw/speech-stack:<tag>` image
(`docker/speech-stack`: Whisper + Qwen LLM + Qwen3-TTS in one container). It lives in the gateway's own Scaleway
registry, which the gateway pulls from with the key it already has: **no registry token, no `registryAuth`, nothing
to set** — it is never `pending` for a credential. The declaration owns five things and patches only them over the
registered spec: the image (`SPEECH_IMAGE` = a tag of that repository or a full reference; default
`20261008-1317`), `placements` (L40S fr-par-1, then one RTX 5090 on Vast from `ghcr.io/marcosremar/speech-stack` at
the same tag: `SPEECH_IMAGE` does not move that copy; no L4), `scaling.mode` `fast`, `realtime: {}` (the edge
sidecar, [realtime-edge.md](realtime-edge.md)) and env per machine type (the edge's `RT_MAX_SESSIONS`: L4 2, L40S 4;
the whole RTX 5090 set; merged into the stored `envByMachineType`). A registered spec with `files` reaches the Vast
place through signed links on the gateway (§ `files` on a Vast placement; it needs the gateway's public URL, else the
place is skipped with the reason in `warnings`). Port,
machine type, zone, replicas, idle and boot times, € and hour limits, volume, `env` and `files` (the voice catalog)
stay exactly as registered. On a gateway where `parle-speech` does not exist it is created from the `speech-stack`
profile with the declared image; that deployment has no `files`, so the voice catalog still has to be sent with a
`PUT`.

One-GPU mode: the parle TTS entry names `parle-qwen-tts` with `"oneGpuDeployment": "parle-speech"` (the app's own
routes, [docs/api/http.md](api/http.md) § App aliases); while `parle-qwen-tts` is not registered
and `parle-speech` is, `parle-tts` goes to `parle-speech` too. To use a separate TTS machine, register
`parle-qwen-tts` (a registered `deployment` always wins); to go back to one GPU, delete it (pausing keeps it
registered, so it would stay the target).

## App accounts — saved image addresses

The gateway serves many apps; each has an **account** with the addresses of its Docker images, so a deploy names an
image instead of carrying a registry address, and the app finds it again later (scale up for a class, roll back).

An app's key is under the daily budget of every non-admin key (`APP_DAILY_REQUESTS`, `APP_DAILY_TOKENS`: one value for
all apps, no per-app override). Before an app serves a class, size both from students × turns (formula and a worked
example in `docs/api/http.md` § App keys) and watch `appBudgets` in `GET /health?details=1` during the lesson.

```bash
# Save (or move) an image address — build-image-on-scaleway.ts --app parle does this after a push
curl -X PUT $GW/v1/apps/parle/images/speech-stack -H "Authorization: Bearer $KEY" -H 'X-App: parle' -d '{
  "image": "rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107", "port": 8000, "healthPath": "/health",
  "defaults": {"machineType": "L40S-1-48G", "volumeGb": 120, "maxReplicas": 2, "bootTimeoutMinutes": 45}
}'
# Deploy it by name (or roll back: "appImageVersion": 1 = the previous address)
curl -X PUT $GW/v1/deployments/parle-speech -H "Authorization: Bearer $KEY" -H 'X-App: parle' -d '{"appImage": "speech-stack"}'
curl $GW/v1/apps/parle -H "Authorization: Bearer $KEY" -H 'X-App: parle'   # images + deployments of the app
```

- **Which app**: the user id of the calling key (`GATEWAY_API_KEYS` `key:app`). An admin key (a user in
  `DEPLOYMENTS_ADMIN_USERS`) acts for any app with `X-App: <app>`; a normal key cannot use `X-App`.
- **Isolation**: a key sees and edits only its own app's images and deployments (`403` otherwise); `GET /v1/deployments`
  lists only its app's. Admins see all (`?app=` filters). Deploys still need an admin key (they spend money).
- **Saved per image**: `image`, `digest`, `port`, `healthPath`, `description`, `defaults` (spec fields: machineType, zone,
  gpu, volumeGb, replicas, timeouts, price cap, args) and the **last 5 previous addresses**. Never secrets: `env`
  values and `registryAuth` are refused (an image in the gateway's own Scaleway registry needs none).
- Stored in `DEPLOYMENTS_STATE_DIR/apps.json` (the Railway volume), next to `deployments.json`.

### Devices of an app

An app may tag each request with the end-user device it serves (`X-Gateway-Device`, or `device` when opening a
realtime session). The account then keeps, per device: first and last seen, request counts, last kind of request and
a block flag — no IP, no user agent. `GET /v1/apps/:app/devices` lists them, `POST …/devices/:device/block` and
`DELETE …/block` block and unblock, `PATCH /v1/apps/:app` `{"requireDevice": true}` refuses requests without an id.
Same callers as the other app paths (the app's key, or an admin). The id is whatever the app says it is: blocking
stops an unmodified client, not a forged id — an app that needs more mints the ids in its backend and sets
`requireDevice`. Routes, timings per transport and a worked example: [docs/api/http.md](api/http.md) § App devices.

## Cold start

- A request that finds no ready replica **waits** (`coldStartWaitSeconds`, default 240 s; per request with header
  `X-Aigw-Wait: <seconds>`) and is served as soon as a replica is ready. If none is ready in time: **503**
  `{"status":"warming"}` + `Retry-After: 30`; the machine keeps booting. 240 s stays under Railway's 5-minute cut-off
  for a request with no bytes flowing.
- The gateway never waits longer than `DEPLOYMENTS_MAX_WAIT_SECONDS` (default 240, at most 840), whatever the spec or
  the header ask: a longer silent wait is cut by the platform in front (Railway: 5 min with no bytes) with an error the
  caller cannot interpret, while the 503 above tells it to retry. 240 leaves a minute for the replica's first byte. A
  spec above the maximum is still accepted (profiles and stored specs carry 600–840) and the view lists it under
  `warnings`; raise the setting only where nothing in front cuts silent requests.
- How long a boot takes is mostly the image + model: a small CPU image is ready in ~1–2 min; Qwen3-TTS on an L4 took
  ~7–8 min in the parle measurement (`babylon-cinema/docs/reports/2026-10-01-tts-l4-ai-gateway`). For those, use
  `minReplicas: 1` while there is traffic, or `POST …/wake` ahead of time, or accept the 503 + retry.
- **No-wake mode**: a request with `X-Gateway-No-Wake: 1`, or from a key user in `GATEWAY_NO_WAKE_USERS` (comma list),
  never wakes a deployment. A ready replica still serves it; with none ready the deployment is skipped as `cold` and
  the route's cloud fallback answers (`/v1/s2s`: composed; `invoke`: 503 `cold` at once), nothing is created and the
  idle clock is not touched. Use it for tests, probes and batch keys (2026-10-07: one STT test request woke a €1.47/h
  L40S through `parle-stt` → `deployment:parle-speech`). `GET /health` → `noWake.skips`. Details: `docs/api/http.md`.
- While a request is being served, extra replicas boot when `inflight > targetInflightPerReplica × ready`; requests go
  to the ready replica with the fewest requests in flight; a connection failure retries once on another replica.

## Scaling rules (`planner.ts`)

`desired = clamp(max(base, ceil(load / targetInflightPerReplica)), minReplicas, maxReplicas)`,
`base = max(minReplicas, 1)` while there was a request in the last `idleMinutes`, else `minReplicas`. `load` is
`inflight + waiting`, or while active the peak of the last 60 s, where a request turned away for lack of a ready replica
(cold, or every replica saturated) counts for 2 s: a burst of 16 hedged or cold requests still asks for a second
replica after it ended (live QA 2026-10-07: under 16–40 concurrent the count stayed at 1).
Surplus replicas go after `scaleDownDelaySeconds` of low load (at once when idle), never one with requests in flight,
and never one still booting: the boot finishes and the idle clock runs from its ready time (only a delete, pause, park
or `bootTimeoutMinutes` end a boot early; live QA 2026-10-07: `idleMinutes: 1` released an L40S at 172 s of a 9 min boot).
A ready replica is never surplus while that would leave fewer ready replicas than desired: one ready and one booting
for a desired count of 1 both stay until the boot finishes, then one of them goes.
Replaced automatically: halted by the provider, not ready after `bootTimeoutMinutes`, `DEPLOYMENTS_UNHEALTHY_STRIKES`
(3) failed health checks in a row with nothing in flight and no answered request in the last
`DEPLOYMENTS_BUSY_GRACE_SECONDS` (120), older than `maxHours` (counted from the last power-on of a parked replica, not
from its creation).

**Busy is not dead.** The probe tells liveness (`/__aigw/ready`, answered by nginx even while the app is saturated) from
readiness (the app's health path, `DEPLOYMENTS_PROBE_TIMEOUT_MS`, 4 s). A replica whose health check times out while it
has work, or that answered a request recently, is `busy` (shown per replica in the view): it keeps what it serves, gets no
new request beyond `targetInflightPerReplica` (the rest falls back and counts as load for scale-out), and is never
replaced for it. A request the caller aborted (a hedged fallback won, the client left) is neutral, a request that hit
its time limit marks the replica busy; only a connection failure is a strike. Live QA 2026-10-07: 16 concurrent chats on
one L40S were 15 hedge losers counted as connection failures, plus health checks queued behind the LLM: the replica was
replaced twice, 9 min of boot each. Safety: price
checked against `maxEurPerHour` before each create, `DEPLOYMENTS_MAX_REPLICAS` across all deployments, back-off after a
failed create (1 → 10 min). More cost guards below.

## Pressure autoscaling (`autoscale.ts`, `controller-autoscale.ts`)

A GPU replica boots in 8–9 min, so the controller scales on pressure, early, and keeps the overflow off the GPU:

- **Signals** per deployment: load (in flight + waiting + requests refused for lack of capacity, peak of the last 60 s),
  p95 latency of the requests the replicas answered, and the share that timed out or got a 429 (last 60 s, ≥ 5 samples).
- **Scale-out** when load passes `autoscale.scaleOutAt` (0.75) of `targetInflightPerReplica` × live replicas, or p95 /
  errors pass `autoscale.latencyP95Ms` (off by default) / `autoscale.errorRate` (0.1), for `autoscale.windowSeconds` (20)
  in a row — one step per window. Booting replicas count as capacity: latency and errors (which measure the ready ones)
  ask nothing more while one boots; only load beyond ready + booting capacity does.
- **Scale-in** only when the load fits one replica fewer at `autoscale.scaleInAt` (0.5) — hysteresis, no flapping —
  then after `scaleDownDelaySeconds`, never below `minActiveReplicas` while active. A surplus replica with requests in
  flight is **drained**: no new request, released once empty or after `autoscale.drainSeconds` (120).
- **Overflow**: a replica takes at most `targetInflightPerReplica` × `autoscale.maxInflightFactor` (1.5); with every ready
  replica full, a request with a fallback spills to it at once (`X-Gateway-Fallback: saturated`, neutral for breakers)
  instead of queueing on the GPU until a timeout; an invoke (no fallback) waits in the gateway for a free slot.
  A replica's realtime sessions (docs/realtime.md § Load and the autoscaler) count in the same unit, full =
  `targetInflightPerReplica`: a replica whose realtime slots are all taken takes no request at all, so the `/v1/s2s`
  turn of a learner refused at realtime admission is answered by the fallback (`route.fallback: "saturated"`) and not
  by the GPU the admitted learners are talking to.
- **Adaptive hedge**: a route's deployment target starts its fallback in parallel after `DeploymentController.hedgeDelayMs`
  — max(`DEPLOYMENT_HEDGE_MS` 1.5 s, the replica's recent p95 × 1.2, scaled by the queue it joins beyond its target),
  at most 3/4 of the attempt timeout — and beyond its target a replica whose answers would be slower than that hedge
  takes nothing more (`saturated`: the request spills at once). Live QA 2026-10-07: at 16–25 concurrent chats on one
  L40S the fixed 1.5 s hedge ran most requests twice (GPU + OpenRouter).
- **Out of stock**: a create that fails for lack of stock in every placement backs off (1, 2, 5, then 10 min) and the
  view says so (`blockedBy: "out of stock since …Z: N creates failed, next try …Z (…)"`); scale-in compares the load with
  one replica fewer than the count *asked* for, so a replica that was never born is dropped once its pressure is gone.
- **Warm-up**: `warmSchedule: [{ "days": [1,2,3,4,5], "start": "08:50", "end": "12:00", "timeZone": "Europe/Paris",
  "minReplicas": 2 }]` keeps replicas up in those windows (days 0 = Sunday, overnight windows allowed), and `POST …/warm`
  does the same for one window on demand. Expired windows fall back to the normal rules.
- **Reserved quota** (class window): `reserveQuota: { "quota": 2, "windows": [{ "days": [1,2,3,4], "start": "17:40",
  "end": "20:15", "timeZone": "Europe/Paris", "minReplicas": 2 }] }` — "of the provider's `quota` machines of my
  `machineType`, I need `minReplicas` during these windows" (the windows have the `warmSchedule` shape). Inside a
  window any OTHER deployment of this gateway is refused a machine of that type once the others hold
  `quota − minReplicas` of them (parked ones count: a stopped server holds quota): the placement is skipped with the
  reason (the next placement, e.g. Vast, is tried), and a deployment with no replica and no other place answers
  `wake` / invoke with **409** `<type> is reserved for deployment '<holder>' until <ISO time> …` + `Retry-After`
  (model routes treat it like a paused deployment: straight to the fallback). `GET …/capacity` lists the reservations
  that touch a deployment's machine types (`reservations[].active.until`). It reserves nothing by itself (pair it with
  `warmSchedule` to have the machines up) and binds only deployments of the same gateway: a machine created by another
  gateway or namespace is outside its reach — that is what the reaper's foreign-leftover alert is for. The match is by
  machine type, not zone (Scaleway counts a GPU type's quota across zones).

- **Caps without starvation**: when the replica cap or the € ceiling blocks a deployment under pressure, the controller
  takes a replica of another deployment that has been idle (no answered request and no request to its deployment) for
  3 min, above its own floor; that deployment then counts as idle until its next request (no ping-pong).
- **Explained**: every view carries `autoscale: { desired, pressureWant, reason, blockedBy, floor, warmFloor, load, p95Ms,
  errorRate }` (`floor` = replicas kept whatever the load: `minReplicas`, `minActiveReplicas` while active, warm windows;
  `warmFloor` = the warm part) (e.g. `reason: "load 16 > 75% of 2×8 (at maxReplicas 2)"`, `blockedBy: "maxReplicas 2"`), logged when it changes.
  A deployment with `realtime` also carries `realtime: { active, capacity, refusedSessions, scalingOut }`, and every
  view `sessions` (distinct learners of the last minute): docs/realtime.md § Load and the autoscaler.

Simulation bench: `bun scripts/autoscale-sim/run.ts [scenario…]` runs the real controller on a virtual clock (9 min boots,
LLM slow-down past 8 parallel, health check timing out at 12, adaptive hedge from 1.5 s → fallback 1.2 s, attempt timeout
4 s, creates failing `out_of_stock` in a window) and prints the timelines, the client p50/p95 and the requests run twice;
`__tests__/unit/deployments/autoscale-sim.test.ts` asserts them (ramp, spike, flapping, drain, crash, contention,
schedule, warm, out of stock rising/falling and recovering, adaptive vs fixed hedge at 16 and 25). The 75 % / 50 % / 20 s / 1.5× defaults are design choices to pilot, not published values.

Class simulator: `bun scripts/scaling-sim.ts [scenario…] [--boot 600] [--resume 180] [--ceiling 8] [--price 1.47]
[--max-replicas 4] [--idle-minutes 2] [--idle-action delete|stop] [--timeline] [--events]` runs the same controller on a
virtual clock against a scripted class instead of a concurrency curve. A student holding a realtime slot is one lease
held for the whole session on a replica that takes `ceiling` of them (the unit `externalInflightEquivalent` gives a full
replica); a student with no free slot is refused by the admission layer as the realtime service does (`wake`, no
request reaches `acquire`), asks again at each turn (every 15 ± 5 s) and that turn goes to the fallback; a student on
HTTP turns and an anonymous request are short leases. It prints one row per scenario: when replicas started, how many
served fewer than `--wasted-below` (20) turns, the replica count per minute, replica-minutes and €, turns on the GPU and
on the fallback, student-minutes on the fallback, when the excess began, what started after it and how long until it was
gone, how long after the last student the bill reached zero, sessions cut by a release, and turns refused with no
fallback (`--no-fallback`). Scenarios (`scripts/scaling-sim/scenarios.ts`): `class-arrival`, `sporadic-blip`,
`sporadic-blip-repeated`, `blip-below-threshold`, `burst`, `slow-growth`, `drop-to-zero`, `quota-full`,
`out-of-stock-then-back`, `two-classes-back-to-back`, `hundred-students`. `__tests__/unit/deployments/scaling-sim.test.ts`
pins the table of today's rule in `fixtures/scaling-sim/today.txt`: a change of rule shows up as a diff of that file.

## Scaling policy: the `scaling` block (`scaling-policy.ts`, `controller-scaling.ts`)

Every deployment runs under one mode (owner, 2026-10-08). A spec sent without the block gets `"scaling": { "mode":
"balanced" }` (`DEFAULT_SCALING_MODE`) at `PUT`/`PATCH`, and a deployment stored without it gets the same when the
gateway starts (log `deployments: no scaling block, running under the default mode`, with the names); the mode is in
`spec.scaling.mode` of `GET /v1/deployments/:name` and in `mode` of the capacity route. The pressure rule of the section
above ("peak of the last 60 s over 75 % for 20 s") is what a deployment without the block did before that date; it
remains in the code for a controller built without `defaultScalingMode` (the unit tests and the simulator's `today`
column). Under a mode the scale-out trigger is how long the excess lasts and where it is going, and the excess that is
not worth a replica is left to the fallback:

```json
"scaling": {
  "target": { "p50Ms": 1500, "p95Ms": 2000 },
  "budget": { "eurPerHour": 6, "eurPerMonth": 150, "maxReplicas": 6 },
  "mode": "economy"
}
```

`mode` is `economy`, `balanced` (default) or `fast`; `"scaling": null` goes back to the default mode. The built-in
voice profiles (`speech-stack`, `qwen3-tts`, `qwen3-tts-clone`) declare `fast`, `whisper-stt` declares `balanced`. Load is counted in the unit of
`targetInflightPerReplica`: requests in flight + waiting, a refused request for the 1.5 s the fallback takes to answer
it, and, when the controller is given session counts (`ControllerOptions.sessions(deployment)`: distinct realtime
sessions wanting a slot, seated or refused; `null` = not available, the default), `sessions × target / ceiling`. Booting
replicas count as capacity. Each tick the policy asks four questions and takes the largest answer:

| Rule | economy | balanced | fast | Asks for |
|---|---|---|---|---|
| **Cost**: the load-minutes the fallback served above capacity in the current episode (excess less than 2 min apart, at most boot + idle back), priced at the mode's rate, reach the price of one start (replica price × (boot + idle time)) | €0.02 per load-minute | €0.10 | any excess | `max(live + 1, ceil(load / target))` |
| **Burst**: the peak of the last 60 s is a full replica or more above capacity | no | yes | yes | `ceil(peak / target)` |
| **Trend**: sessions have been rising for at least half of the last boot/2 seconds, rose in its second half, and at that pace pass capacity before a replica started now is ready (needs session counts) | no | yes | yes | one replica ahead of the sessions seated now |
| **Spare**: sessions fill half a replica or more | no | no | yes | `ceil(sessions / target) + 1` |

With an L40S at €1.47/h, a 10 min boot and `idleAction: "delete"` one start is priced at €0.49: `balanced` starts a
replica after 4.9 load-minutes on the fallback (2 students too many for 2.5 min, 16 for 20 s), `economy` after 24.5
(2 students for 12 min, 16 for 1.5 min). Two extra requests for 5 s are 0.2 load-minutes: they go to the fallback in both.
A burst of 16–40 requests beyond capacity starts replicas at the next tick in `balanced` and `fast`; in `economy` one
burst is 0.5–1.3 load-minutes and is left to the fallback, and the same burst every 20 s pays for a replica after about
15 min. `fast` keeps one replica more than the sessions need, so a late student or a blip lands on the GPU.

The boot time is the median of the last 5 the controller measured for the machine type + image (creation → first ready;
600 s until one was seen), or the resume time (180 s until measured) while a parked replica is available.

**Scale-in.** A start is kept for boot + idle time; after that the count drops to what the peak of the last idle time
needs. Idle time is the break-even between an idle replica and a new cold start: the boot time with `idleAction:
"delete"`, the resume time with `"stop"`, never below `scaleDownDelaySeconds`; `idleMinutes` is raised to it as well.
The surplus replica is drained: no new request, released when empty or after `autoscale.drainSeconds` when set, else
30 min (a class block).

**Budget.** `budget.maxReplicas` and `budget.eurPerHour` (replicas the amount pays for at the replica's price) cap the
count together with `maxReplicas`: the strictest wins, and the gateway-wide guards below still apply.
`budget.eurPerMonth` is a ledger in the deployment store (`spend: { month, eur, at }`, replica-hours × price, added every
tick, saved every minute, reset on the first tick of a UTC month). Once it is spent the log says `deployments: monthly
budget spent, new load goes to the fallback`, no replica starts, the running ones are drained (seated sessions finish)
and released, `autoscale.blockedBy` reads `monthly budget spent: €… of €… in 2026-10, new load goes to the fallback`,
and a request that finds no replica gets that sentence in its 503 at once instead of waiting for a cold start.

**`target`** is stored and returned by the capacity route. Nothing acts on it yet: it is the pass mark of the learned
session ceiling and of `POST …/calibrate`, which are not built.

**Hold** (`PATCH /v1/deployments/:name` with `{ "scaling": { "hold": { "replicas": N, "untilMinutes": M } } }`, M ≤ 720;
`"hold": null` ends it): the replica count is exactly N until the window ends, whatever the load, the floors and the
activity; a paused deployment and a spent budget still win. It works on any deployment, with or without the rest of the
block, and is shown as `hold` in the view. `POST …/warm` is a floor (the load can still add replicas); a hold is a freeze.

**`GET /v1/deployments/:name/capacity`** (same access as `GET /v1/deployments/:name`):

```json
{
  "deployment": "parle-speech", "mode": "balanced", "target": { "p50Ms": 1500, "p95Ms": 2000 },
  "budget": { "eurPerMonth": 150, "month": "2026-10", "spentEur": 41.2, "exhausted": false },
  "hold": null,
  "capacity": [{
    "machineType": "L40S-1-48G", "image": "rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107",
    "ceiling": { "sessions": 16, "source": "configured", "samples": 0 },
    "boot": { "seconds": 612, "source": "measured", "samples": 3 },
    "resume": { "seconds": 180, "source": "default", "samples": 0 },
    "confident": false, "missing": ["resume"]
  }]
}
```

One entry per machine type the spec may land on. `ceiling.source` is `configured` (`realtime.maxSessions` or the machine
type's `RT_MAX_SESSIONS`) or `default` (8); `measured` is reserved for the learned ceiling, with `samples` its count.
`missing` lists what is not known well enough: `ceiling` while it is the default, `boot` / `resume` below 3 samples.

Simulated per mode: `bun scripts/scaling-sim.ts --mode economy|balanced|fast|all [--no-session-signal] [--budget
'{"eurPerMonth":2}']`; the expected tables are `__tests__/unit/deployments/fixtures/scaling-sim/<mode>.txt`
(`scaling-sim.test.ts`), the rules one by one in `scaling-policy.test.ts`. The two rates, the 2 min episode gap and the
trend window are design choices to pilot, not published values.

## Cost guards (gateway-wide)

| Variable | Default | What it limits |
|---|---|---|
| `DEPLOYMENTS_MAX_REPLICAS` | 6 | RUNNING replicas across all deployments. Parked (stopped) replicas do not count: they bill no compute. A `PUT` with `maxReplicas` above it is refused (400) with the cap in the message. |
| `DEPLOYMENTS_MAX_STOPPED` | 8 | Parked replicas (`idleAction: "stop"`, they bill disk). Past it, an idle replica is deleted instead of parked. |
| `DEPLOYMENTS_MAX_EUR_PER_HOUR` | 6 | Sum of `pricePerHour` of all running replicas (+ creates in flight). A create or power-on that would pass it is refused; `lastError` says `spend ceiling reached` (a market-priced Vast offer counts at its `maxEurPerHour` cap). `0` = off. |
| `DEPLOYMENTS_PARKED_MAX_HOURS` | 72 | A parked replica unused this long is deleted (a forgotten park bills its disk forever). `0` = off. |
| `DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES` | 60 | A `minReplicas` pin unused this long goes to zero (running replicas; it does not touch parked ones — that is the line above). |

`GET /v1/deployments` (`health`) and `GET /health?deep=1` show `running`, `maxReplicas`, `stopped`, `maxStopped`,
`eurPerHour` (current burn) and `maxEurPerHour`.

A replica the provider lists as `stopping` (a stop takes ~1 min on Scaleway) is neither halted nor parked: it is left
alone until the list shows `stopped` (10 min at most), never deleted or counted for a plan. When a provider's list fails
(Vast answers 429 under load) the controller still releases what the plan says to release from the last known machines,
but creates and powers on nothing; the Vast backend reuses its last list for 5 s, waits `retry_after` after a 429/5xx and
serves the last good list for up to 90 s meanwhile. A machine whose deployment was deleted while it was being created is
released as soon as the create ends (bounded retries; the orphan sweep stays as the net).

## Placement: `placements`, `candidates`, `near` (reliable, cheap, close to France)

One walk (`placement-walk.ts`) serves two spec fields; a spec may use **one of them, not both** (400 otherwise; send
`"placements": []` to drop a profile's placements). Every place first gets the live price check (not sold or over the
cap → skipped without a create), then the create; an out-of-stock answer (`isOutOfStock`, `placements.ts`: Scaleway's
`412 {"type":"out_of_stock"}`, shortage, capacity wordings) moves to the next place; a quota refusal (Scaleway's
`403 quotas_exceeded`, per machine type and organisation) skips every remaining place of that machine type and goes on
with the other types; any other error (401, a bug) stops the walk and backs off. With no other type listed, a quota
backs off like any failed create, and `lastError` / `autoscale.blockedBy` say `quota reached for <type> on <provider>`.
A `PUT`/`PATCH` that changes the spec clears the create back-off, so a corrected spec is tried at the next tick (an
identical `PUT` does not). `lastPlacement` in `GET /v1/deployments/:name` says where it landed and why the
earlier places were skipped.

- **`placements`** (a Scaleway spec, ≤ 6 entries): the spec's own zone/type first, then each entry **in the given
  order** (never re-ranked). A Scaleway entry is `{ zone?, machineType? }` at the spec's `maxEurPerHour`; a pinned
  `osImageId` only applies in its own zone; an exposed deployment may change only `machineType`.
  An entry on **another provider** is `{ "provider": "vast", "machineType": "RTX 5090", "maxEurPerHour": 0.85,
  "maxReplicas": 1 }`, all four required (400 otherwise; GPU deployments without `exposure` only): the price cap of
  that place and the most replicas of this deployment that provider may hold at once (running or being created). The
  walk reaches it when the Scaleway places before it are not sold, over the cap, out of stock or over quota. Every
  create starts again from the top, so once Scaleway places a replica again the next one goes there; a replica already
  on Vast keeps serving until the usual scale-in, nothing is migrated. A Vast place the spec cannot run on is skipped
  with the reason in `lastPlacement` and in `warnings` of the view, never refused at `PUT`: `files` (use `fileUrls`),
  an image without `bootScript` or `entrypoint`, an image in the gateway's own Scaleway registry without a
  `registryAuth` (a pull-only credential: the gateway's key is never sent to a marketplace host), no `VAST_API_KEY`.
  Any entry may carry its own `image` (the same build in a registry that place can pull from): `speech-stack` pulls
  `rg.fr-par.scw.cloud/aigw/speech-stack:<tag>` on Scaleway and the public copy `ghcr.io/marcosremar/speech-stack:<tag>`
  (same digest) on Vast, where its `RTX 5090` env also names `TTS_MODEL` and `LLM_FILE` (the image's own `ENV`, which
  `start.sh` reads under `set -u`).
  `idleAction: "stop"` is accepted: the Vast replica is deleted where a Scaleway one is parked. `minCuda`, `near`,
  `maxRttMs` and `maxRttExcessMs` of the spec apply to it. The built-in profiles: `speech-stack` L40S fr-par-2 →
  L40S fr-par-1 → one RTX 5090 on Vast (no L4: the account's L4 quota of 2 belongs to the TTS); `qwen3-tts` and
  `qwen3-tts-clone` L4 fr-par-2 → L4 fr-par-1 → up to two RTX 5090 on Vast; `whisper-stt` is a CPU deployment and
  stays on Scaleway (Vast rents GPU hosts only). Not run live under these profiles.
- **`candidates`**: the ranked, multi-provider ladder below, a cap per entry.

Without either, a spec has one place: `provider` + `zone` + `machineType`, refused above `maxEurPerHour` (as before).
With `candidates`, each create walks a **ranked ladder**:

```json
{
  "image": "vllm/vllm-omni:v0.28.0", "bootScript": "…", "port": 8010, "near": "FR",
  "candidates": [
    { "zone": "fr-par-2", "machineType": "L4-1-24G", "maxEurPerHour": 0.9 },
    { "zone": "nl-ams-1", "machineType": "L4-1-24G", "maxEurPerHour": 0.9 },
    { "provider": "vast", "machineType": "RTX 5090", "maxEurPerHour": 0.6 }
  ]
}
```

- `candidates`: 1–20 entries `{ provider?, zone?, machineType, maxEurPerHour }` (`provider` defaults to the spec's,
  `zone` to the spec's; Vast ignores `zone`). `near`: ISO country of the users, default **`FR`** (`DEFAULT_NEAR`, the
  owner's region). `allowFar`: accept hosts/zones beyond 2500 km of `near` when nothing nearer exists (default
  false). `maxRttMs` (Vast): see [RTT gate](#rtt-gate-vast). `minCuda` (Vast, 11–14): lowest CUDA the host driver
  must support, for the image's own CUDA (`cuda_max_good`); never below the GPU's floor (12.8 for Blackwell, else 12.4).
  A driver older than the image fails at the first CUDA call with error 804 ("forward compatibility"): `vllm/vllm-omni`
  v0.28 is CUDA 13.0 (torch 2.13+cu130, driver ≥ 580), and a 5090 host on driver 570 (CUDA 12.8) could not start it —
  such an image needs `minCuda: 13.0`.
  `candidates` cannot be combined with `exposure` (the reserved IP is zonal).
- **How placement decides — distance, not EU membership.** The owner, in France, measured ~60 ms to a Vast host in
  Slovakia: inside the EU, but ~1100 km away. So geography is the great-circle distance (`geo.ts`) between the main
  datacenter hub of the `near` country and that of the host's country (Paris → Amsterdam ≈ 430 km, → Frankfurt
  ≈ 480 km, → Bratislava ≈ 1090 km, → Warsaw ≈ 1370 km), in **500-km bands** (`DISTANCE_BUCKET_KM`: inside a band
  the RTT difference is a few ms and price decides). Beyond **2500 km** (`MAX_NEAR_KM`, ~25 ms of fibre alone, ≥ 40–60 ms
  in practice) a host or zone is "far": excluded unless `allowFar` and nothing nearer exists. Unknown country = far.
- **Order** (`rankCandidates`): distance band first — a Scaleway zone by its country (`fr-par-*` 0 km and `nl-ams-*`
  ~430 km share band 0, `pl-waw-*` ~1370 km is band 2). A Vast candidate is band 1 (`VAST_CANDIDATE_BUCKET`: after a
  zone within 500 km — a datacenter is more reliable than a marketplace host — and the Vast backend picks the host
  near `near` itself, then the RTT gate checks it). Inside a band, cheapest first (catalog price; the cap when
  unknown); ties keep the caller's order. Zones in `shortage` and types the catalog prices above the candidate's cap are
  skipped before trying.
- **Walk**: as above, each candidate against its own cap; the Vast backend reports "no offer under the cap" and
  "every offer taken" as `out_of_stock`, so the walk moves on. Example `lastPlacement`:
  `scaleway L4-1-24G@nl-ams-1 (€0.8/h) near FR; skipped: L4-1-24G out of stock in fr-par-2`.

## Vast replicas

`provider: "vast"` (or a Vast candidate) needs `VAST_API_KEY` (from the dev API, like the Scaleway key). Code:
`src/deployments/vast-backend.ts` (lean, separate from the GPU-pod client in `src/gateway/providers/gpu/`).

- **One container per host.** Vast runs ONE container per host (no systemd, no Docker-in-Docker): `image` is the
  container (a public base image such as `vllm/vllm-omni:v0.28.0`) and `bootScript` runs in it. Without a
  `bootScript` the spec's `entrypoint` + `args` are run there instead (after loading `/srv/aigw/app.env`), so an
  image-mode spec needs its start command declared; the image's own `CMD` is not run.
  `files`, `exposure` and `idleAction: "stop"` are refused for Vast (no user_data service, no reserved IP); on a Vast
  *placement* `files` are served by the gateway through signed links (§ `files` on a Vast placement).
  Vast accepts 32 KB of env per instance and the boot script travels there base64 twice: a `bootScript` above
  ~14 KB is refused at PUT (download large payloads at boot). A private image needs `registryAuth` in the spec
  (sent as Vast `image_login`; never filled from the provider's own key).
- **Supported on Vast**: invoke, capacity, `realtime` (below), `fileUrls` (below), `registryAuth`, `candidates`,
  the RTT gate, host-end handover. **Not supported**: `files`, `exposure`, `idleAction: "stop"` (a `park` deletes the
  instance and the next call pays a full boot), a boot log through the gateway, a reserved address (the replica's
  address changes with every rental).
- **`fileUrls`** — files the replica downloads at boot, for what `files` carries on Scaleway (the speech stack's voice
  catalog): `{"voices.json": {"url": "https://…", "sha256": "<64 hex>"}, "br-f-01.mp3": {…}}`, same keys as `files`
  (≤ 64 entries, `https` only, a key cannot be in both). Before the boot script or the container starts, each file is
  fetched with `curl` (5 tries) into `/srv/aigw/files/<key>` and checked with `sha256sum`; a missing file or a
  mismatch stops the boot with `aigw: BOOT FAILED: …` in `/srv/aigw/boot.log` (the replica never becomes ready and
  is released at `bootTimeoutMinutes`). The directory is `/files` in the app: mounted read-only on Scaleway, a symlink
  in the Vast container. It works on both providers, so one catalog (e.g. the app's content-addressed bucket, whose
  object names are already the sha256) serves both. The view lists the keys in `fileKeys`, never the URLs. On Vast
  every entry costs ~250 bytes of the 32 KB env: about 60 files fit beside a 3.4 KB boot script.
- **`realtime` on Vast** (docs/realtime-edge.md § Vast): the edge runs as a process of the container, started by
  `vastReplicaInit` from `/opt/aigw-edge` (shipped by the image or put there by the boot script), behind the same
  `/__aigw/rt/` nginx location. Vast maps no port ranges, so the backend asks for one `-p <n>:<n>/udp` per UDP port:
  **ports = 2 × workers × ceil(sessions / workers) + 1**, where sessions is `realtime.maxSessions` (else the machine
  type's `RT_MAX_SESSIONS`, else 8) and workers is ceil(sessions / `RT_SESSIONS_PER_WORKER`) (6). The edge binds one
  UDP port per peer connection; the factor 2 covers a re-offer, which binds the new connection before closing the old
  one; the workers split the range evenly; the last port answers the reachability probe. 4 sessions → 9 UDP ports
  (`50000-50008`), 16 → 37. With the two TCP ports (80 and SSH) the total must stay within 64 per instance, so at most
  30 sessions per replica (refused at PUT above that, as is an explicit `realtime.udpPorts` wider than that), and only
  hosts with `direct_port_count` ≥ the total are searched and rented.
- `GET /v1/deployments/:name/offers` (admin, read-only): the ranked offers a create would try, the offers left out
  and why, and what the gateway remembers of each host (§ Host reputation).
- **App port = `port`** (default 8000): nginx proxies to `127.0.0.1:<port>` and the health loop polls
  `http://127.0.0.1:<port><healthPath>`. Everything shares one container, so a stack that already runs a model server
  on 8000 serves its health responder on another port (e.g. `"port": 8010`).
- Boot (`vastReplicaInit`, `cloud-init.ts`): nginx installed if missing and started as a daemon (`nginx`, never
  `systemctl`) with the same token-gated config on container :80; the boot script in the background; `/__aigw/ready`
  once the health path answers; the container stops itself `maxHours + 30 min` after boot as a last resort. The
  script travels base64 in the env var `AIGW_INIT_B64` and the onstart decodes and runs it.
- **Offer search** (`POST /bundles/`): on-demand, rentable, verified, 1 GPU, `gpu_name` = `machineType`
  (e.g. `RTX 5090`), `disk_space ≥ volumeGb` (default 50), `cuda_max_good ≥ 12.8` for Blackwell / 12.4 otherwise,
  `reliability2 ≥ 0.97` (0.95 only when nothing passes), `inet_down ≥ 500`, `direct_port_count ≥ 1` (with `realtime`:
  its UDP ports + 2),
  `dph_total ≤ maxEurPerHour × 1.05` (`EUR_TO_USD`, deliberately below the market rate so the USD cap is never looser
  than the EUR one). Cap and floors are re-checked client side.
- **Ranking** (`rankOffers`): first the hosts that already passed the RTT gate in the last 24 h (the backend remembers
  up to 200 by `machine_id`, on disk; lowest RTT over the anchor first, in 5-ms bands), then the distance band of the
  host's country (from `geolocation`, the country after the last comma) from `near`; hosts beyond 2500 km only when no
  nearer one exists and the spec has `allowFar`. From France, DE/CH/BE/NL (band 0) beat SK/PL (band 2) and RO (band 3)
  even when those are cheaper. Inside a band: a host in the `near` country itself before one across a border (a French
  host before a cheaper British, Swiss or Dutch one), then a host that booted our image before, then effective price
  `dph_total × (1 + 4 × (1 − reliability2))`
  (an unreliable host costs more), then `inet_down` desc. The best 5 are tried (`PUT /asks/{id}/`, label
  `aigw:<namespace>:<deployment>`, env `-p 80:80`); one rented in between goes to the next. `lastPlacement` says which
  offer was rented and which better-ranked ones were passed over and why, e.g.
  `vast RTX 5090 (≤ €0.85/h); offer 3 of 21: London, GB, $0.796/h; better-ranked offers passed over: offer 811 (Zurich, CH, $0.563/h): … not available; offer 902 (Amsterdam, NL, $0.597/h): … not available`.
- The replica's address is `public_ipaddr:<host port of 80/tcp>`, so the probe and the proxy work unchanged. A host
  whose replica hit `bootTimeoutMinutes` is skipped for 1 h (§ Host reputation). States: `running`; `loading`/`created` →
  `starting`; `exited`/`offline` → `exited` (halted: deleted and replaced). `DELETE /instances/{id}/` releases it
  (its disk goes with it).

### RTT gate (Vast)

Distance is only a prior; a fresh Vast replica is **measured**. Once it has an address (its nginx front answers
before the app is ready), the controller asks the backend for the RTT (`measureRtt`: `src/gateway/providers/gpu/rtt-probe.ts`
on the mapped port, 3 rounds of 5 samples × 2 s, the lowest round's median — the samples of a round leave together,
so jitter on the gateway's own link lifts all of them and only the lowest round is the path — counting only real response bytes) and, in the same tick, for a
**baseline**: the same probe against a fixed anchor in the `near` country (`RTT_ANCHORS`: Scaleway's S3 endpoint
there, port 80 — `s3.fr-par.scw.cloud` for FR, `s3.nl-ams.scw.cloud` for NL, `s3.pl-waw.scw.cloud` for PL).

- **Relative rule** (a baseline came back): the replica passes when `rtt − baseline ≤ maxRttExcessMs` (integer 0–500,
  default **20**, `DEFAULT_MAX_RTT_EXCESS_MS`) and, if the spec sets `maxRttMs`, `rtt ≤ maxRttMs` as well. Why 20: on
  2026-10-08, from France, UK hosts measured 12–15 ms over Paris and served the speech stack as fast as an L40S, so
  they stay in with ~5 ms of noise margin; the Slovak host of 2026-10-06 (~60 ms, ≥ 40 over) goes. That day's French
  host (42 ms while Paris measured 45: −3) passes; the absolute 35 ms had released it.
- **Absolute rule** (no anchor for the country, or the baseline probe failed — the gate never opens for lack of a
  baseline): `rtt ≤ maxRttMs`, integer 5–500, default **35** (`DEFAULT_MAX_RTT_MS`), meant for the gateway's vantage
  on Railway europe-west4 (NL), where France → host is typically 10–20 ms more.

Outside the gate the replica is released with reason `too-far`, its host (`machine_id`) is skipped for **24 h**, and
the next create takes the next offer. No answer within 5 min of getting an address (`RTT_GATE_BUDGET_MS`) counts as too
far. Until it passes, a replica is not probed for readiness (it serves nothing). A replica that passed is never
measured again and its host is remembered as known-good for the ranking (on disk, § Host reputation); one adopted after a gateway restart is
measured for the view only, never released by the gate (it may be serving).
`GET /v1/deployments/:name` shows `rttMs` and `rttBaselineMs` per replica, and `lastPlacement` both numbers and the
verdict, e.g.
`vast RTX 5090 (≤ €0.6/h); offer 1 of 12: Paris, FR, $0.548/h; RTT 42 ms, baseline 45 ms (s3.fr-par.scw.cloud): −3 ms ≤ maxRttExcessMs 20: kept`
or `…; earlier: host Bratislava, SK: RTT 61 ms, baseline 14 ms (s3.fr-par.scw.cloud): +47 ms > maxRttExcessMs 20: released (too-far)`.
`GET /v1/deployments/:name/offers` answers `{offers, skipped, hosts, gate}`: `gate` is the rule in force with the baseline measured
at that moment (`{near, rule, anchor, baselineMs, maxRttExcessMs, maxRttMs}`), and each offer carries `knownRttMs`
and `gateVerdict` when its host was measured before.

- **What the difference means:** `rtt − baseline` is a lower bound of the anchor → host round trip, taken from where
  the gateway runs, not the user's own latency. From a vantage near the users it is close to what they add over a
  datacenter of their country; from the Netherlands a host that is as far from the gateway as Paris is (a British
  one) reads ≈ 0 over. The distance ranking, the own-country preference and an explicit `maxRttMs` cover that side.
  Scaleway replicas are not gated.

### Host reputation (Vast) — what each host did, kept across restarts

`src/deployments/host-reputation.ts`. The backend keeps one record per Vast host (`machine_id`) and writes it to
`vast-hosts.json` in `DEPLOYMENTS_STATE_DIR`, next to `deployments.json` (same atomic write; on Railway the mounted
volume), so a gateway restart no longer forgets which hosts were bad (live 2026-10-08: a UK host was rented again
after two `too-far` releases). Up to 200 hosts, the least recently used dropped first.

| Field | Written when |
|---|---|
| `location`, `lastUsedAt` | an offer of the host is rented |
| `rttMs`, `baselineMs`, `rttAt` | the RTT gate passed (`rttAt` set; a pass also clears `lastError` and `avoidUntil`), or released it as too far (`rttAt` untouched: the numbers are kept for the operator, the host is not "known good") |
| `bootsOk`, `bootMs` | its replica answered ready for the first time (create → ready, ms); clears `lastError` |
| `udp`, `udpAt` | the gateway's UDP probe of its replica answered `ok` or `blocked` (§ realtime-edge.md, Reachability) |
| `bootsFailed`, `lastError`, `lastErrorAt`, `avoidUntil` | its replica was released as `too-far` (avoided 24 h), `boot-timeout` (1 h) or `udp-blocked` (see below) |

How the selection uses it (`rankedOffers` in `vast-backend.ts`, `rankOffers` in `placements.ts`):

- **Skipped**: a host whose `avoidUntil` is in the future. The period is bounded, so a host can recover: after it the
  host is ranked like any other. With `realtime.requireWebrtc`, also a host whose last UDP probe was `blocked` less
  than 24 h ago (`UDP_BLOCKED_HOST_MS`); a deployment that can use the WebSocket rung still rents it.
- **First**: hosts that passed the RTT gate in the last 24 h, by **RTT over the anchor** (`rttMs − baselineMs`, in 5-ms
  bands; the raw RTT when no baseline was measured) — not by price.
- Then, as before, the distance band and the users' own country; inside those, a host that **booted our image
  before** (`bootsOk` > 0, no later failure) goes before an unknown one, then the effective price.
- The gate itself is unchanged (`maxRttExcessMs`, `maxRttMs`): reputation only decides which offer is tried first.

What it does not do: measure a host before renting it. A host never rented is still ranked by distance, country and
price, and the gate decides after the rental (1–5 min of machine per wrong try).

`GET /v1/deployments/:name/offers` (admin, read-only) now answers `{offers, skipped, hosts, gate}`: each offer has
`host` (its record, or null), `skipped` lists the market offers left out with the reason
(`{offerId, machineId, location, usdPerHour, reason: "too-far until 2026-10-09T10:41:00.000Z"}` or
`"inbound UDP blocked until … (realtime.requireWebrtc)"`), and `hosts` is every record the gateway holds.

### `files` on a Vast placement — signed links on the gateway

A Vast host has no user_data service, so `files` cannot travel with the create. When the gateway knows its own public
URL (`AIGW_PUBLIC_URL`; on Railway the service's `RAILWAY_PUBLIC_DOMAIN` is used when it is unset), a spec with `files`
is no longer skipped on a Vast **placement**: at the create the walk turns each file into a `fileUrls` entry
(`filesByUrl`, `src/deployments/boot-files.ts`) that points at the gateway itself, with the sha256 of the stored
bytes, and the replica downloads and checks it like any other `fileUrls` entry before the app starts.

- Link: `GET <public URL>/v1/boot-files?d=<deployment>&k=<file key>&exp=<unix seconds>&sig=<HMAC-SHA256>`. The route
  takes no API key (the booting replica has none) and is authenticated by the signature alone. The signing key is
  derived from the deployment's replica token (`HMAC(replicaToken, "aigw-boot-files-v1")`), never an app or admin key;
  the signature covers the deployment, the file key and the expiry, so a link opens one file of one deployment until
  `exp`. `exp` = the create time + `bootTimeoutMinutes`.
- Nothing is listed: a wrong or expired signature, an unknown deployment and an unknown file all answer the same
  `404 {"error":"not found"}`. The links are not in any view (`fileKeys` only) nor in the logs of the gateway's own
  code; they are in the instance's env on Vast (inside the init script) and in `/srv/aigw/boot.log` on the host, which
  receives the files anyway. A reverse proxy in front of the gateway that logs query strings would log them: they
  expire with the boot timeout.
- The host that booted with the links holds the replica token and could sign a link for a file of **its own**
  deployment after `exp`: it already has those files. It cannot sign for another deployment.
- Without a public URL the placement is skipped as before, with `files are not supported on vast (no user_data
  service)` in `warnings` and `lastPlacement`.
- **What remains**: a spec whose *primary* provider is Vast, or with a Vast `candidate`, is still refused at PUT when
  it has `files` (`checkVastSpec` knows nothing of the gateway's URL): use `fileUrls` there. The files are read from
  the stored spec at each request (≤ 8 MB of base64 parsed per download, at boot only).

### A class at a known time: warm capacity on Vast

`warmSchedule` and `minActiveReplicas` are provider-agnostic: the floor is a number of replicas, and every create
walks the placements (Scaleway zones first, then the Vast placement up to its own `maxReplicas`). So a window that
opens before the class pre-warms Vast hosts too, under the same limits as any create — the placement's `maxReplicas`,
the deployment's `maxReplicas`, `DEPLOYMENTS_MAX_REPLICAS` and the € ceiling (a Vast replica is admitted at its cap,
then billed at the rented price) — and after the window the idle rule releases them; the external reaper lists Vast
instances by label like any other. Proven with fakes in
`__tests__/unit/deployments/provider-fallback.test.ts` (§ warm schedule over a vast placement): nothing before the
window; inside it one Scaleway replica (quota) and the rest on Vast up to the ceiling; all released after it.

**30 learners, 18:00–20:00 Europe/Paris, Monday–Thursday, 4 seats per replica** → 8 replicas (32 seats). Scaleway's
L40S quota is 2 and it had no stock on 2026-10-08, so the Vast placement must be able to hold all 8:

```bash
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' $GW/v1/deployments/parle-speech -d '{
  "maxReplicas": 8,
  "placements": [
    { "zone": "fr-par-1" },
    { "provider": "vast", "machineType": "RTX 5090", "maxEurPerHour": 0.62, "maxReplicas": 8,
      "image": "ghcr.io/marcosremar/speech-stack:20261008-1317" }
  ],
  "warmSchedule": [
    { "days": [1, 2, 3, 4], "start": "17:25", "end": "20:05", "timeZone": "Europe/Paris", "minReplicas": 8 }
  ]
}'
```

and on the gateway service `DEPLOYMENTS_MAX_REPLICAS=10` (8 + the two L4 of `parle-qwen-tts`; today 4) and
`DEPLOYMENTS_MAX_EUR_PER_HOUR=10` (today 6: 2 × €1.47 + 6 Vast replicas + the two L4 at €0.79 is ≈ €8/h). `placements`
is declared in `src/deployments/declared/parle-speech.json` and put back by the reconciler: change it there (the
`PATCH` above is for a test gateway). The window opens 35 min before the class because a boot from scratch took
6.5–19.5 min and the pull of the 22 GB image on a Vast host is not measured; shorten it once it is.

| Replicas | Billed per class (window 2 h 40 min + ≈ 10 min idle tail ≈ 2.83 h each) | Per week (4 classes) |
|---|---|---|
| 8 × RTX 5090 on Vast (US$0.55–0.60/h) — Scaleway out of stock | **US$12.5–13.6** | US$50–54 |
| 2 × L40S (€1.47/h) + 6 × RTX 5090 | **€8.3 + US$9.3–10.2** (≈ €17–18) | ≈ €69–72 |
| 2 × L40S only | €8.3 — 8 seats, 22 learners on the cloud fallback | |

About US$0.42–0.45 per learner per class on Vast alone. Each host the RTT gate releases adds 1–5 min of one machine
(US$0.01–0.05). No `realtime.requireWebrtc` for this deployment: on a host without inbound UDP the WebSocket rung met
the target (p50 900 ms, max 2358 ms at 4 learners), so such a host is kept.

### Vast for a class: not proven live, and how to prove each

Unit tests with a fake Vast API cover the code above. Not run against real hosts:

| Unproven | Live test (a test gateway: `DEPLOYMENTS_NAMESPACE=<own>`, `VAST_API_KEY` from the dev API, never production) |
|---|---|
| Pull time of `ghcr.io/marcosremar/speech-stack:20261008-1317` (22 GB) on a Vast host, and the boot of the baked image | 1 below; read `bootMs` |
| The reputation file surviving a real restart | 2 |
| The UDP probe on real hosts feeding `udp` and `requireWebrtc` | 3 |
| `files` through signed links on a real host | 4 |
| More than one Vast replica; a pre-warmed window | 5 |
| 8 learners on one RTX 5090 (measured at 4 only) | 6 |

```bash
export GW=https://<test gateway> KEY=<admin key of that gateway> DEP=vast-class

# 1. One replica from the public image; time from the PUT to ready, and what the host did.
curl -s -X PUT -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' $GW/v1/deployments/$DEP -d '{
  "profile": "speech-stack", "provider": "vast", "machineType": "RTX 5090", "maxEurPerHour": 0.62,
  "image": "ghcr.io/marcosremar/speech-stack:20261008-1317", "placements": [], "idleAction": "delete",
  "minReplicas": 1, "maxReplicas": 1, "realtime": { "maxSessions": 4 },
  "fileUrls": { "voices.json": { "url": "https://<public copy>/voices.json", "sha256": "<64 hex>" },
                "voice-pt.wav": { "url": "https://<public copy>/voice-pt.wav", "sha256": "<64 hex>" } }
}'
watch -n 20 "curl -s -H 'Authorization: Bearer $KEY' $GW/v1/deployments/$DEP | jq '{status, lastPlacement, lastError, replicas: [.replicas[] | {id, phase, zone, ageSeconds, rttMs, rttBaselineMs, udp}]}'"
curl -s -H "Authorization: Bearer $KEY" $GW/v1/deployments/$DEP/offers | jq '{skipped, hosts}'   # bootMs, rttMs, udp of the kept host

# 2. Restart the gateway process, then: the same hosts and reasons are still listed.
curl -s -H "Authorization: Bearer $KEY" $GW/v1/deployments/$DEP/offers | jq '.hosts | map({host, location, bootsOk, bootsFailed, lastError, avoidUntil, udp})'

# 3. UDP: `udp` on the replica is ok or blocked within ~15 s of ready; a session on a blocked replica lists ws first.
curl -s -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' $GW/v1/realtime/sessions \
  -d "{\"config\":{\"deployment\":\"$DEP\",\"voice\":\"<voice id>\",\"messages\":[]}}" | jq '[.transports[].type]'
#    Then PATCH {"realtime":{"maxSessions":4,"requireWebrtc":true}} and delete + recreate until a blocked host is hit:
#    lastPlacement says "inbound UDP blocked and realtime.requireWebrtc: released (udp-blocked)" and /offers skips it.

# 4. files through the gateway: the same deployment as a Scaleway spec with `files` and a vast placement
#    (AIGW_PUBLIC_URL set on the test gateway; a quota or stock refusal on Scaleway, or "paused" zones, sends it to Vast).
curl -s -H "Authorization: Bearer $KEY" $GW/v1/deployments/$DEP | jq '.warnings, .lastPlacement'   # no "files are not supported"
curl -s -o /dev/null -w '%{http_code}\n' "$GW/v1/boot-files?d=$DEP&k=voices.json&exp=1&sig=x"      # 404

# 5. Two replicas, then a window: minReplicas 2 / maxReplicas 2; later a warmSchedule 10 min ahead, 20 min long.
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' $GW/v1/deployments/$DEP \
  -d '{"minReplicas": 2, "maxReplicas": 2}'
curl -s -H "Authorization: Bearer $KEY" $GW/v1/deployments/$DEP | jq '.autoscale.warmFloor, [.replicas[] | {zone, phase, pricePerHour}]'

# 6. Load: 4 then 8 learners on one replica (PATCH realtime.maxSessions and RT_MAX_SESSIONS to 8 first).
GW=$GW KEY=$KEY DEP=$DEP RT_CONFIG='{"system":"…","messages":[],"voice":"<voice id>"}' \
  bun scripts/realtime-e2e/load.ts --n 8 --duration 360 --ramp 8 --turn-every 18 --jitter 3 --clip turn.wav

# Always: delete, then check nothing is left.
curl -s -X DELETE -H "Authorization: Bearer $KEY" $GW/v1/deployments/$DEP
curl -s -H "Authorization: Bearer $KEY" "$GW/v1/deployments" | jq '.health'
```

### Host rental end (Vast) — handover before the host goes

A Vast host is rented until its owner's contract ends (`end_date` on the offer and the instance; `duration` as the
fallback); then the instance is taken away, whatever it is serving. `src/deployments/expiry.ts`:

- **Not rented:** an offer ending in less than **24 h** (`MIN_HOST_LEFT_MS`). An offer with no end date is kept.
- **Handover:** a replica whose host ends within **1 h** (`EXPIRY_HANDOVER_MS`) stops counting as capacity, so its
  replacement is created at once (even at `maxReplicas`). The old one keeps serving while the new one boots; the router
  sends new requests to any other ready replica first; once the others cover `desired` and it has no request in
  flight, it is released with reason `expiring`. A caller of the deployment (SDK, `/v1/...` through the gateway) sees
  no error and no wait.
- `GET /v1/deployments/:name` shows `expiresInMinutes` per replica (null when the provider never takes it back).

## Replica machine

`cloud-init.ts`: nginx on :80 requires `X-Aigw-Token` (a per-deployment secret only the gateway knows) and proxies to
the container on `127.0.0.1:8000`; `/__aigw/ready` appears once the container answered `healthPath`. GPU types use
the Scaleway GPU OS image (Docker + NVIDIA toolkit) with `--gpus all`. The machine shuts itself down `maxHours + 30 min`
after boot as a last resort — a shut-down Scaleway instance is still billed, so the gateway deletes halted replicas.

Hardening (06/10/2026): the token check runs in nginx's access phase (`auth_request`), so requests **without** the
token are rate-limited per IP (5 r/s, burst 10, 5 connections → `429`) while the gateway's own traffic is never
limited; `server_tokens off`. Every Scaleway replica gets a firewall: a gateway-only one joins the namespace's
`aigw-<namespace>-gateway-only` security group (one per zone, inbound DROP except TCP 80, outbound ACCEPT, made once
and kept), never the project's default group (inbound ACCEPT, SSH open). A replica whose firewall cannot be made is not
created. Machines created before keep the default group until they are replaced. Gateway → replica traffic is still
plain HTTP (TLS with a pinned per-deployment certificate is a follow-up).

## Orphan guard

While the gateway runs it never leaves a machine behind (scale to zero, halted replicas deleted, unknown machines of its
namespace released on restart). If the gateway itself is down, or its bookkeeping lost a machine, that machine would keep
billing — powering off from inside does not stop a Scaleway bill (nor an exited Vast instance's disk). So a second
Railway service, **`ai-gateway-reaper`**, runs the same image as a cron job (`*/15 * * * *`, start command
`./reap-compiled --apply`; it is published with `railway.reaper.json` as its `railway.json`, `scripts/reap-orphans.ts` →
`src/deployments/reaper.ts`). It reaps every provider with a key — Scaleway servers tagged `aigw-ns-<namespace>` and Vast
instances labelled `aigw:<namespace>:<deployment>` — each listed on its own, so one provider failing does not spare the
other's machines. It probes `GATEWAY_URL/health` 4 times over ~2 min, then:

| Gateway | What it releases |
|---|---|
| **down** (every probe failed) | every machine of the namespace older than 30 min. A redeploy or a short blip answers one probe and costs nothing. Worst case for a dead gateway: 15 min + 2 min + the machine's remaining minutes to reach 30 min of age. Network resources are left alone (it cannot know which deployments exist). |
| **up**, with `AI_GATEWAY_ADMIN_KEY` | cross-check: `GET /v1/deployments` with that admin key says which deployments exist; a machine whose deployment is not among them and older than `REAPER_GRACE_MINUTES` (default 30) is released (Scaleway: server **and** its SBS volumes, awaited). Scaleway reserved IPs and security groups tagged for a deployment the gateway does not have, used by no server, go too; the namespace's shared `aigw-<ns>-gateway-only` firewall never does. |
| **up**, no admin key (or an answer it cannot trust) | nothing, and the run says so: the machines are still listed (`seen`), the summary line is `reaper: NOT CHECKED (…)` and the process exits **3**, so the cron run shows as failed until `AI_GATEWAY_ADMIN_KEY` is set. It never reads as "nothing found". |

**Other namespaces (foreign leftovers).** A dev or test gateway (`aigw-ns-dev`, `aigw-ns-marcos-…`) shares the provider
account and its quota: on 2026-10-07/08 a stopped test L4 of a dev namespace held production's L4 quota for 28 hours.
Every run also lists the machines of every OTHER namespace (Scaleway tag `aigw-deploy`, Vast label `aigw:<ns>:…`) and
reports those older than the grace in `foreign`. One whose machine type a deployment of this namespace uses (from the
cross-check's `GET /v1/deployments`; unknown without the admin key, then every one counts) is logged as
`ALERT reaper.foreign_quota_held {…}` and posted to `ALERT_WEBHOOK_URL` when set. `--apply` never releases them.
`--apply-foreign` deletes the **stopped** ones (`stopped`, `stopped in place`, `exited`) older than
`REAPER_FOREIGN_MIN_AGE_HOURS` (default 6, never under 1); a running machine of another namespace is never deleted (its
gateway may be a laptop the reaper cannot see, and idleness is not measurable from outside). `REAPER_APPLY=1` is the
same as `--apply`, for a service whose live start command lost the flag.

The cross-check trusts only a full list of its own namespace (`"scope": "all"` and `"namespace"` in the answer): a
non-admin key, another namespace, a non-2xx, or a gateway build from before `scope` skips it (`skipped` in the log)
instead of reading "nothing exists". Run by hand it is a **dry run** (`bun scripts/reap-orphans.ts` lists what it would
release; the summary line starts `reaper: DRY RUN, nothing released`); `--apply` releases. Exit 1 when a list or a
release failed (the next run retries), 3 when the gateway is up and nothing was compared.

Env of the reaper service: `GATEWAY_URL`, `DEPLOYMENTS_NAMESPACE` (same as the gateway), `SANDBOX_TOKEN` (fetches
`SCW_SECRET_KEY` / `VAST_API_KEY` from the dev API — or set those directly), `AI_GATEWAY_ADMIN_KEY` (a gateway key whose
user is in the gateway's `DEPLOYMENTS_ADMIN_USERS`; never the `SANDBOX_TOKEN`, which the script refuses), optional
`SCW_DEFAULT_PROJECT_ID`, `REAPER_GRACE_MINUTES`.

## Running on Railway

`railway.json` builds `Dockerfile.production` (`serve.ts`), health check `/health`, **1 replica** — the controller is
single-process (two gateways would both scale the same deployments; use another `DEPLOYMENTS_NAMESPACE` for a second
gateway). Variables:

**One secret: `SANDBOX_TOKEN`** (same token as the parle repo; aliases `PALCO_PROXY_TOKEN`, `PALCO_PROXY`, `PROXY_TOKEN`).
At boot the gateway calls `GET https://parle-palco.up.railway.app/api/sandbox-env` (fallback `ucast.me`, override
`SANDBOX_ENV_URL`) with it and fills every missing key (`SCW_SECRET_KEY`, `SCW_PROJECT_ID`, `GROQ_API_KEY`, …); a
key set in the environment wins. The same token is accepted as a Bearer (user `sandbox`, always admin), so agents call
the gateway with the credential they already carry. Code: `src/config/sandbox-env.ts`.

| Variable | |
|---|---|
| `SANDBOX_TOKEN` | the only secret to set; everything below that is a key comes from the dev API. Not a client key nor an admin (`401`); `ACCEPT_SANDBOX_TOKEN_AS_KEY=1` re-accepts it during the transition |
| `SCW_SECRET_KEY` (+ optional `SCW_PROJECT_ID`) | enables Scaleway replicas (normally fetched with the token) |
| `VAST_API_KEY` | enables Vast replicas (normally fetched with the token); the controller only touches instances labeled `aigw:<namespace>:` |
| `GATEWAY_API_KEYS` | `key:site-a,key2:site-b,adminkey:owner` — one key per site |
| `DEPLOYMENTS_ADMIN_USERS` | e.g. `owner`; others can only read and invoke their own app's deployments. Empty = no admin at all (boot `WARNING`) |
| `ALERT_WEBHOOK_URL` | optional: a JSON `POST` for `app.budget_warning` (80 %) / `app.budget_exhausted` (gateway) and `reaper.foreign_quota_held` / `reaper.not_checked` (reaper service). Plain JSON (`{event, data}`), not Slack's `text` shape |
| `APP_MAX_TOKENS`, `APP_DAILY_REQUESTS`, `APP_DAILY_TOKENS` | limits of non-admin app keys (1024, 5000, 2 000 000), the default for every app; an admin sets one app's own daily budgets with `PUT /v1/apps/:app/limits {dailyRequests?, dailyTokens?}` (stored in `apps.json`, applied at once, `null` = default, `0` = no budget): size them for a class with the formula in `docs/api/http.md` § App keys, or the fallback answers 429 mid-lesson until 00:00 UTC |
| `DEPLOYMENTS_STATE_DIR=/data` + a Railway volume on `/data` + `RAILWAY_RUN_UID=0` | specs survive deploys (the image runs as a non-root user; the volume is root-owned) |
| `RATE_LIMIT_RPM` | per-key requests/min (0 = off); `MAX_CONCURRENT_PER_USER` (default 150) caps parallel requests per key user, `MAX_CONCURRENT_PER_USER_OVERRIDES` (`user:limit,…`) per user |
| `TRUST_PROXY=1` | rate-limit unauthenticated callers by `X-Real-IP` instead of Railway's proxy address |
| `CORS_ORIGINS` | browser origins allowed to call directly |
| `GROQ_API_KEY` | optional now; only the Groq-backed cloud routes need it |
| `GHCR_READ_TOKEN` | registry credential of a declared deployment whose `registryAuth.passwordEnv` names it (none today: `parle-speech` needs no token) |
| `SPEECH_IMAGE` | image (tag or full ref) of the declared `parle-speech`; default in the declaration |
| `DECLARED_DEPLOYMENTS=0` | turns off the declared-deployments reconciler |
| `DEPLOYMENTS_MAX_WAIT_SECONDS` | longest wait of an invoke through a cold start (240; § Cold start) |

Railway itself allows ~11k req/s per domain, 10k concurrent connections and requests up to 15 min while bytes flow
(5 min with none) — not a constraint for model traffic. Machines are found by tag on Scaleway, so a gateway restart
adopts running replicas instead of creating new ones; machines tagged with the namespace but with no known deployment
(state lost) are released.

## Measured (2026-10-04, local gateway → real Scaleway, fr-par-2)

Gateway run with only `SANDBOX_TOKEN` in its environment (`bun serve.ts`), namespace `local-test`:

| Check | Result |
|---|---|
| `cpu-echo` (DEV1-S, €0.009/h) cold start, first request held until ready | 200 after 109 s (create + boot + nginx + docker) |
| warm request | 0.24 s (sandbox → Paris) |
| `PATCH minReplicas: 2` | 2nd replica ready in ~1 min 50 s; 12 parallel calls split 6/6 |
| one machine powered off from outside (Scaleway API) | seen as halted within 15 s, deleted and replaced; every call during it 200; back to 2 ready in ~1 min 45 s |
| gateway restarted mid-boot | adopted the running machine (no second create) |
| `minReplicas: 0, idleMinutes: 1` | both machines deleted ~80 s later; Scaleway list empty |
| `qwen3-tts` (L4-1-24G, €0.7875/h) after `wake` | ready in ~6 min 50 s |
| `POST …/invoke/v1/audio/speech` `{"input":"Olá! Bom dia, tudo bem com você?","voice":"vivian","language":"Portuguese","task_type":"CustomVoice"}` | 200, WAV 24 kHz mono 3.6 s, −22 dBFS; Voxtral transcription: "Olá! Bom dia! Tudo bem com você?" |
| 5 more warm phrases | first byte 0.67–1.16 s, total 0.77–1.47 s |
| `DELETE` | no server or volume left in any zone |

Found by this run and fixed: under Bun, the proxy's `server.setTimeout` (60 s) is a hard idle cut that
`socket.setTimeout(0)` cannot lift, so a cold-start wait died at 60 s. With deployments on, `serve.ts` raises it to
15 min unless `PROXY_TOTAL_TIMEOUT_MS` is set (`proxyIdleTimeoutMs`).

**Releasing a Scaleway replica.** The GPU OS images boot from SBS volumes, and Scaleway refuses `terminate` for those and
answers DELETE with `400 resource_still_in_use` ("instance should be powered off") until the server is `stopped`. The
release powers it off, polls its state every `SCALEWAY_POWEROFF_POLL_MS` (5 s) for at most `SCALEWAY_POWEROFF_WAIT_MS`
(180 s), then deletes it — retrying while the API still says in use — and its volumes. The gateway does not wait for
that (its loop goes on once the power-off was asked; a second release of the same server joins the first); the reaper
does. Before 2026-10-07 every release logged the 400 and the server went only on a later tick.

## Tests

- `__tests__/unit/deployments/` — planner, spec/cloud-init, Scaleway adapter (fake client), controller + HTTP on the
  real proxy against in-process fake replicas (cold start, load scale-up, scale to zero, failover, unhealthy
  replacement, price cap, list failure, replica cap, orphan sweep, restart adoption, pause); placement ranking
  (`placement-ranking.test.ts`), ordered Scaleway placements (`placements.test.ts`), the RTT gate (fake probe, in `controller-placement.test.ts`), the candidate walk and per-provider list failures (`controller-placement.test.ts`), and the
  Vast backend + `vastReplicaInit` against a fake fetch (`vast-backend.test.ts`). Nothing here calls Vast or Scaleway.
- `scripts/deployments-docker-e2e.ts` — the real cloud-init in a local Docker "machine"
  (`docker build -t aigw-machine -f scripts/deployments-machine.Dockerfile scripts/`), whole HTTP path, no cloud bill.


## Idle and leftovers stop billing on their own

Inside the gateway process, without a cron of its own:

| What | Who turns it off | When |
|---|---|---|
| Replicas of an unused deployment | the controller loop (every 20 s) | `idleMinutes` with no request (scale to `minReplicas`) |
| Replicas kept only by `minReplicas` (a pin left on) | the controller loop | `DEPLOYMENTS_PINNED_IDLE_MAX_MINUTES` (default 60, `0` = off) with no request and no spec change; the next request, `wake` or PATCH brings them back |
| A replica still booting for the current use | nobody: the idle clock starts when it is ready | `bootTimeoutMinutes` replaces a stuck one |
| Orphan replicas of this namespace, failed releases | the controller loop | next tick (retried until gone) |
| Image build machines (`aigw-build`) | the janitor (`src/deployments/janitor.ts`, every 5 min) | older than 3 h |
| SBS volumes Scaleway created with a server (`…_sbs_volume_N`), detached | the janitor | detached for 1 h |

The janitor covers Scaleway only (a deleted Vast instance takes its disk with it; Vast has no build machines).
The janitor is on by default on Railway (`DEPLOYMENTS_JANITOR=0` turns it off; `=1` turns it on elsewhere). When the
gateway itself is down nothing in its process runs: the reaper (`scripts/reap-orphans.ts`, a separate Railway cron
every 15 min) releases the namespace's replicas after the gateway missed its health checks for ~2 min, and while the
gateway is up it releases machines (and Scaleway IPs/firewalls) that no deployment owns (see Orphan guard).


## Exposed deployments (WebRTC, own TLS) and `idleAction: "stop"`

For an app the clients reach directly, not through the gateway (LiveKit: WebRTC over UDP, Caddy with its own
certificate), the spec adds:

```json
{
  "exposure": { "ports": [{ "protocol": "tcp", "port": 443 }, { "protocol": "udp", "port": 7882 }] },
  "idleAction": "stop"
}
```

- **Reserved IP:** reserved with the first replica, kept in the deployment record, and reused by every later replica, so
  DNS keeps pointing at it. It is shown as `publicIp` in `GET /v1/deployments/:name` and released on `DELETE`.
- **Firewall:** the deployment's own security group opens only the listed ports plus `8089/tcp`.
- **Gateway probe:** the token-gated probe moves to 8089, so 80/443 stay with the app. In this mode the app serves
  `healthPath` on its own `port`.
- **`idleAction: "stop"`:** going idle powers the replica off instead of deleting it. Disk, IP and firewall stay, and
  only disk and IP are billed. The next demand (a request or `wake`) powers it back on, which takes about 2 min instead
  of a full boot, and the certificate on disk survives.
- **Traffic that bypasses the gateway:** direct client traffic (LiveKit rooms) does not count as a request. `POST /v1/deployments/:name/park` says the app is done now (powers off at once under `idleAction: "stop"`). The app keeps
  the deployment in use with `POST /v1/deployments/:name/wake` while it needs it. When the wakes stop, `idleMinutes` parks it.
