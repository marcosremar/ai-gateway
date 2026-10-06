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
| any | `/v1/deployments/:name/invoke/<path>` | forwarded to a ready replica as `/<path>` |
| GET | `/v1/profiles` | built-in (`qwen3-tts`, `qwen3-tts-clone`, `cpu-echo`) + stored |
| PUT / DELETE | `/v1/profiles/:name` | store / delete your own profile (same fields as a spec) |

Mutations require a key whose user is in `DEPLOYMENTS_ADMIN_USERS` (when set). `env` values and `registryAuth` are
never returned. Spec fields and defaults: `src/deployments/spec.ts` (`SPEC_DEFAULTS`).

## Declared deployments

Some deployments are declared in the repo and the gateway keeps them registered by itself — nobody has to remember a
`PUT`. Each `src/deployments/declared/<name>.json` (listed in `DECLARED_DEPLOYMENTS`, `src/deployments/declared.ts`)
holds the spec **without secrets**; at boot (before the routes are mounted) and every 5 min the gateway builds the
body, compares it with the stored spec and calls the same idempotent `controller.put` only when something changed
(new image, rotated credential). Registering never starts a machine: declared specs keep `minReplicas: 0` and the
reconciler never wakes them — a replica starts on the first request that needs it, as for any deployment.

Secrets are mounted from the environment (the dev API) at each reconcile:

| Declaration field | Source |
|---|---|
| `image.env` (`SPEECH_IMAGE`) | a full reference, or just a tag of `image.repository`; unset → `image.default` |
| `registryAuth.passwordEnv` (`GHCR_READ_TOKEN`) | a GHCR token with `read:packages` (server `ghcr.io`, user `marcosremar`) |
| `generatedSecrets` (`SPEECH_TOKEN`) | generated once (32 chars `[A-Za-z0-9_-]`), persisted with the spec in the deployment store, reused afterwards; never logged nor returned |

**Pending, never broken:** without the credential or an image the deployment is not registered and its status is
`pending` with the reason (`GHCR_READ_TOKEN is not set …`) — a replica that cannot pull its private image would be a
billed machine that never serves. A deployment already registered keeps its stored spec while the credential is
missing. The status is in `GET /v1/deployments` (`declared`), `GET /health?deep=1` and, per stage, in `GET /health`.
A key that appears through a key reload registers the deployment at once. `DECLARED_DEPLOYMENTS=0` turns the
reconciler off. Fields the declaration does not hold (`paused`, …) are left as an operator set them; declared fields
changed by hand are put back.

### `parle-speech` (one GPU for STT + LLM + TTS)

`src/deployments/declared/parle-speech.json`: the `ghcr.io/marcosremar/parle-speech:<commit sha>` image (Whisper
large-v3-turbo + Qwen3.5-9B + Qwen3-TTS 0.6B Base; built by the babylon-cinema workflow
`.github/workflows/speech-image.yml`, commit tags only, no `latest`), port 80, `/health` (answers only when the
models are loaded), L4-1-24G in fr-par-2, 0..1 replica, 15 min idle, 45 min boot timeout (models download at
boot; cold start ≈ 8 min), 100 GB volume, 2 h max lifetime. `TRUST_UPSTREAM_AUTH=1`: behind the gateway the host
nginx forwards only `X-Aigw-Token`, so the image's own nginx sets the Bearer for its servers (babylon-cinema PR #1508).
The default image is the first build with that change (`9a87056…`); set `SPEECH_IMAGE` to a newer commit tag.

One-GPU mode: the parle TTS entry names `parle-qwen-tts` with `"oneGpuDeployment": "parle-speech"` (the app's own
routes, [docs/api/http.md](api/http.md) § App aliases); while `parle-qwen-tts` is not registered
and `parle-speech` is, `parle-tts` goes to `parle-speech` too. To use a separate TTS machine, register
`parle-qwen-tts` (a registered `deployment` always wins); to go back to one GPU, delete it (pausing keeps it
registered, so it would stay the target).

## App accounts — saved image addresses

The gateway serves many apps; each has an **account** with the addresses of its Docker images, so a deploy names an
image instead of carrying a registry address, and the app finds it again later (scale up for a class, roll back).

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

- **Which app**: the user id of the calling key (`GATEWAY_API_KEYS` `key:app`). An admin key (the `SANDBOX_TOKEN` user,
  `DEPLOYMENTS_ADMIN_USERS`) acts for any app with `X-App: <app>`; a normal key cannot use `X-App`.
- **Isolation**: a key sees and edits only its own app's images and deployments (`403` otherwise); `GET /v1/deployments`
  lists only its app's. Admins see all (`?app=` filters). Deploys still need an admin key (they spend money).
- **Saved per image**: `image`, `digest`, `port`, `healthPath`, `description`, `defaults` (spec fields: machineType, zone,
  gpu, volumeGb, replicas, timeouts, price cap, args) and the **last 5 previous addresses**. Never secrets: `env`
  values and `registryAuth` are refused (an image in the gateway's own Scaleway registry needs none).
- Stored in `DEPLOYMENTS_STATE_DIR/apps.json` (the Railway volume), next to `deployments.json`.

## Cold start

- A request that finds no ready replica **waits** (`coldStartWaitSeconds`, default 240 s; per request with header
  `X-Aigw-Wait: <seconds>`) and is served as soon as a replica is ready. If none is ready in time: **503**
  `{"status":"warming"}` + `Retry-After: 30`; the machine keeps booting. 240 s stays under Railway's 5-minute cut-off
  for a request with no bytes flowing.
- How long a boot takes is mostly the image + model: a small CPU image is ready in ~1–2 min; Qwen3-TTS on an L4 took
  ~7–8 min in the parle measurement (`babylon-cinema/docs/reports/2026-10-01-tts-l4-ai-gateway`). For those, use
  `minReplicas: 1` while there is traffic, or `POST …/wake` ahead of time, or accept the 503 + retry.
- While a request is being served, extra replicas boot when `inflight > targetInflightPerReplica × ready`; requests go
  to the ready replica with the fewest requests in flight; a connection failure retries once on another replica.

## Scaling rules (`planner.ts`)

`desired = clamp(max(base, ceil((inflight + waiting) / targetInflightPerReplica)), minReplicas, maxReplicas)`,
`base = max(minReplicas, 1)` while there was a request in the last `idleMinutes`, else `minReplicas`.
Surplus replicas go after `scaleDownDelaySeconds` of low load (at once when idle), never one with requests in flight.
Replaced automatically: halted by the provider, not ready after `bootTimeoutMinutes`, 3 failed health checks in a row,
older than `maxHours`. Safety: price checked against `maxEurPerHour` before each create, `DEPLOYMENTS_MAX_REPLICAS`
across all deployments, back-off after a failed create (1 → 10 min).

## Placement: `placements`, `candidates`, `near` (reliable, cheap, close to France)

One walk (`placement-walk.ts`) serves two spec fields; a spec may use **one of them, not both** (400 otherwise; send
`"placements": []` to drop a profile's placements). Every place first gets the live price check (not sold or over the
cap → skipped without a create), then the create; an out-of-stock answer (`isOutOfStock`, `placements.ts`: Scaleway's
`412 {"type":"out_of_stock"}`, shortage, capacity wordings) moves to the next place, any other error (quota, 401, a
bug) stops the walk and backs off. `lastPlacement` in `GET /v1/deployments/:name` says where it landed and why the
earlier places were skipped.

- **`placements`** (Scaleway only, ≤ 6 `{ zone?, machineType? }`): the spec's own zone/type first, then each entry
  **in the given order** (never re-ranked), all at the spec's `maxEurPerHour`. A pinned `osImageId` only applies in
  its own zone; an exposed deployment may change only `machineType`. The `speech-stack` profile carries some.
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

- **Boot-script mode only.** Vast runs ONE container per host (no systemd, no Docker-in-Docker): `image` is the
  container (a public base image such as `vllm/vllm-omni:v0.28.0`) and `bootScript` runs in it. Both are required.
  `files`, `exposure` and `idleAction: "stop"` are refused for Vast (no user_data service, no reserved IP).
- **App port = `port`** (default 8000): nginx proxies to `127.0.0.1:<port>` and the health loop polls
  `http://127.0.0.1:<port><healthPath>`. Everything shares one container, so a stack that already runs a model server
  on 8000 serves its health responder on another port (e.g. `"port": 8010`).
- Boot (`vastReplicaInit`, `cloud-init.ts`): nginx installed if missing and started as a daemon (`nginx`, never
  `systemctl`) with the same token-gated config on container :80; the boot script in the background; `/__aigw/ready`
  once the health path answers; the container stops itself `maxHours + 30 min` after boot as a last resort. The
  script travels base64 in the env var `AIGW_INIT_B64` and the onstart decodes and runs it.
- **Offer search** (`POST /bundles/`): on-demand, rentable, verified, 1 GPU, `gpu_name` = `machineType`
  (e.g. `RTX 5090`), `disk_space ≥ volumeGb` (default 50), `cuda_max_good ≥ 12.8` for Blackwell / 12.4 otherwise,
  `reliability2 ≥ 0.97` (0.95 only when nothing passes), `inet_down ≥ 500`, `direct_port_count ≥ 1`,
  `dph_total ≤ maxEurPerHour × 1.05` (`EUR_TO_USD`, deliberately below the market rate so the USD cap is never looser
  than the EUR one). Cap and floors are re-checked client side.
- **Ranking** (`rankOffers`): distance band of the host's country (from `geolocation`, the country after the last
  comma) from `near`; hosts beyond 2500 km only when no nearer one exists and the spec has `allowFar`. From France,
  DE/CH/BE/NL (band 0) beat SK/PL (band 2) and RO (band 3) even when those are cheaper. Inside a band: effective price `dph_total × (1 + 4 × (1 − reliability2))` (an unreliable host costs more), then
  `inet_down` desc. The best 5 are tried (`PUT /asks/{id}/`, label `aigw:<namespace>:<deployment>`, env `-p 80:80`);
  one rented in between goes to the next.
- The replica's address is `public_ipaddr:<host port of 80/tcp>`, so the probe and the proxy work unchanged. A host
  whose replica hit `bootTimeoutMinutes` is skipped for 1 h (in memory). States: `running`; `loading`/`created` →
  `starting`; `exited`/`offline` → `exited` (halted: deleted and replaced). `DELETE /instances/{id}/` releases it
  (its disk goes with it).

### RTT gate (Vast)

Distance is only a prior; a fresh Vast replica is **measured**. Once it has an address (its nginx front answers
before the app is ready), the controller asks the backend for the RTT (`measureRtt`: `src/gateway/providers/gpu/rtt-probe.ts`
on the mapped port, 5 samples × 2 s, median, counting only real response bytes). Median above `maxRttMs` → the
replica is released with reason `too-far`, its host (`machine_id`) is skipped for **24 h**, and the next create
takes the next offer. No answer within 5 min of getting an address (`RTT_GATE_BUDGET_MS`) counts as too far. Until
it passes, a replica is not probed for readiness (it serves nothing). A replica that passed is never measured again;
one adopted after a gateway restart is measured for the view only, never released by the gate (it may be serving).
`GET /v1/deployments/:name` shows `rttMs` per replica, and `lastPlacement` the decisions, e.g.
`vast RTX 5090 (≤ €0.6/h) near FR; earlier: host Bratislava, SK: RTT 52 ms > maxRttMs 35: released (too-far); RTT 18 ms ≤ maxRttMs 35: kept`.

- `maxRttMs`: integer 5–500, default **35** (`DEFAULT_MAX_RTT_MS`, `src/deployments/rtt-gate.ts`).
- **Vantage-point caveat:** the gateway runs on Railway europe-west4 (Netherlands), so it measures **NL → host**, not
  user → host. France → host is typically 10–20 ms more; 35 ms from NL keeps a French user near ~50 ms. A host east
  of the Netherlands can pass from NL and still be slower for France than the number suggests — the distance ranking
  (from `near`) is what keeps those behind closer hosts. Scaleway replicas are not gated.

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

## Orphan guard

While the gateway runs it never leaves a machine behind (scale to zero, halted replicas deleted, unknown machines of its
namespace released on restart). If the gateway itself is down, its machines would keep billing — powering off from
inside does not stop a Scaleway bill (nor an exited Vast instance's disk). So a second Railway service, **`ai-gateway-reaper`**, runs the same image as a cron
job (`*/15 * * * *`, start command `./reap-compiled`; it is published with `railway.reaper.json` as its `railway.json`, `scripts/reap-orphans.ts` → `src/deployments/reaper.ts`) with
`SANDBOX_TOKEN`, `GATEWAY_URL` and the same `DEPLOYMENTS_NAMESPACE` (it reaps every provider with a key — Scaleway
and Vast — each listed on its own, so one provider failing does not spare the other's machines): it probes `GATEWAY_URL/health` 4 times over ~2 min and,
only if every probe failed, deletes that namespace's machines older than 30 min. A redeploy or a short blip answers
one of the probes and costs nothing. Worst case for a dead gateway: 15 min + 2 min + the machine's remaining minutes to
reach 30 min of age.

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
| `SANDBOX_TOKEN` | the only secret to set; everything below that is a key comes from the dev API |
| `SCW_SECRET_KEY` (+ optional `SCW_PROJECT_ID`) | enables Scaleway replicas (normally fetched with the token) |
| `VAST_API_KEY` | enables Vast replicas (normally fetched with the token); the controller only touches instances labeled `aigw:<namespace>:` |
| `GATEWAY_API_KEYS` | `key:site-a,key2:site-b,adminkey:owner` — one key per site |
| `DEPLOYMENTS_ADMIN_USERS` | e.g. `owner`; others can only invoke / read |
| `DEPLOYMENTS_STATE_DIR=/data` + a Railway volume on `/data` + `RAILWAY_RUN_UID=0` | specs survive deploys (the image runs as a non-root user; the volume is root-owned) |
| `RATE_LIMIT_RPM` | per-key requests/min (0 = off); `MAX_CONCURRENT_PER_USER` (default 150) caps parallel requests per key user, `MAX_CONCURRENT_PER_USER_OVERRIDES` (`user:limit,…`) per user |
| `TRUST_PROXY=1` | rate-limit unauthenticated callers by `X-Real-IP` instead of Railway's proxy address |
| `CORS_ORIGINS` | browser origins allowed to call directly |
| `GROQ_API_KEY` | optional now; only the Groq-backed cloud routes need it |
| `GHCR_READ_TOKEN` | registry credential of the declared `parle-speech` (GHCR `read:packages`); from the dev API |
| `SPEECH_IMAGE` | image (tag or full ref) of the declared `parle-speech`; default in the declaration |
| `DECLARED_DEPLOYMENTS=0` | turns off the declared-deployments reconciler |

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
every 15 min) releases the namespace's replicas after the gateway missed its health checks for ~2 min.


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
