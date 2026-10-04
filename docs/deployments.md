# Deployments — a Docker image behind an autoscaled endpoint (Scaleway)

Register a Docker image once; the gateway rents Scaleway machines for it, scales them with traffic (down to zero),
and forwards requests to a ready replica. Other sites only see `https://<gateway>/v1/deployments/<name>/invoke/...`.

Code: `src/deployments/` (pure planner in `planner.ts`, loop in `controller.ts`, HTTP in `http.ts`, boot script in
`cloud-init.ts`). Mounted by `serve.ts` when `SCW_SECRET_KEY` is set. **Only Scaleway for now** (`provider: "scaleway"`).

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
| GET | `/v1/deployments` | all deployments + `health` (last provider error) |
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

## Replica machine

`cloud-init.ts`: nginx on :80 requires `X-Aigw-Token` (a per-deployment secret only the gateway knows) and proxies to
the container on `127.0.0.1:8000`; `/__aigw/ready` appears once the container answered `healthPath`. GPU types use
the Scaleway GPU OS image (Docker + NVIDIA toolkit) with `--gpus all`. The machine shuts itself down `maxHours + 30 min`
after boot as a last resort — a shut-down Scaleway instance is still billed, so the gateway deletes halted replicas.

## Orphan guard

While the gateway runs it never leaves a machine behind (scale to zero, halted replicas deleted, unknown machines of its
namespace released on restart). If the gateway itself is down, its machines would keep billing — powering off from
inside does not stop a Scaleway bill. So a second Railway service, **`ai-gateway-reaper`**, runs the same image as a cron
job (`*/15 * * * *`, start command `./reap-compiled`; it is published with `railway.reaper.json` as its `railway.json`, `scripts/reap-orphans.ts` → `src/deployments/reaper.ts`) with
`SANDBOX_TOKEN`, `GATEWAY_URL` and the same `DEPLOYMENTS_NAMESPACE`: it probes `GATEWAY_URL/health` 4 times over ~2 min and,
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
| `SCW_SECRET_KEY` (+ optional `SCW_PROJECT_ID`) | enables deployments (normally fetched with the token) |
| `GATEWAY_API_KEYS` | `key:site-a,key2:site-b,adminkey:owner` — one key per site |
| `DEPLOYMENTS_ADMIN_USERS` | e.g. `owner`; others can only invoke / read |
| `DEPLOYMENTS_STATE_DIR=/data` + a Railway volume on `/data` + `RAILWAY_RUN_UID=0` | specs survive deploys (the image runs as a non-root user; the volume is root-owned) |
| `RATE_LIMIT_RPM` | per-key requests/min (0 = off); `MAX_CONCURRENT_PER_USER` (default 20) caps parallel requests per key |
| `TRUST_PROXY=1` | rate-limit unauthenticated callers by `X-Real-IP` instead of Railway's proxy address |
| `CORS_ORIGINS` | browser origins allowed to call directly |
| `GROQ_API_KEY` | optional now; only the Groq-backed cloud routes need it |

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
  replacement, price cap, list failure, replica cap, orphan sweep, restart adoption, pause).
- `scripts/deployments-docker-e2e.ts` — the real cloud-init in a local Docker "machine"
  (`docker build -t aigw-machine -f scripts/deployments-machine.Dockerfile scripts/`), whole HTTP path, no cloud bill.
