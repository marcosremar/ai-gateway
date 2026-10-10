# Deploy runbook — ai-gateway to production after PR #56 (written 2026-10-08, not executed)

Read-only findings of 2026-10-08 ≈ 16:30–17:00 Europe/Paris (Railway API reads, `GET /health`, `GET /v1/deployments`).
Nothing here was run against production.

## 1. How production is deployed today

- Railway project `parle-game` (`2213991a-748b-4576-8bd1-f45232f722e3`), environment `production`
  (`1a47de30-6f84-4127-bf17-1ad99375f6d1`).
- Service `ai-gateway` (`345e6aed-be5d-474f-bf4e-0d3466a4b0c0`): **no repository connected**. Every deployment is a
  CLI upload (`railway up`) by the owner's account; Railway keeps no commit for it. Build: `railway.json` →
  `Dockerfile.production` (`./serve-compiled`), health check `/health` (60 s), 1 replica in `europe-west4`, volume
  `ai-gateway-volume` on `/data` (`DEPLOYMENTS_STATE_DIR`: `deployments.json`, `apps.json`). Domain
  `parle-ai-gateway.up.railway.app`. Variables on the service (names only): `ACCEPT_SANDBOX_TOKEN_AS_KEY`,
  `APP_DAILY_REQUESTS`, `APP_DAILY_TOKENS`, `DEPLOYMENTS_ADMIN_USERS`, `DEPLOYMENTS_MAX_REPLICAS`,
  `DEPLOYMENTS_NAMESPACE`, `DEPLOYMENTS_STATE_DIR`, `GATEWAY_API_KEYS`, `NODE_ENV`, `RAILWAY_RUN_UID`,
  `RATE_LIMIT_RPM`, `S2S_PRIMARY_SPEAK_FIELD`, `SANDBOX_TOKEN`, `TRUST_PROXY`. No `SPEECH_IMAGE`, no
  `GHCR_READ_TOKEN`, no `S2S_STT_*`.
- Service `ai-gateway-reaper` (`68853513-0840-4820-964f-68c0efd315c1`): same Dockerfile, cron `*/15 * * * *`, region
  `sfo`, last deployed **2026-10-05 00:19 UTC**. Its live start command is `./reap-compiled` — **without `--apply`** —
  and it has no `AI_GATEWAY_ADMIN_KEY` (variables: `DEPLOYMENTS_NAMESPACE`, `GATEWAY_URL`, `SANDBOX_TOKEN`). The
  repository's `railway.reaper.json` says `./reap-compiled --apply` since #45 (2026-10-07). In the current code a run
  without `--apply` is a dry run: check the reaper's log before relying on it (§ 7).
- `.github/workflows/deploy.yml` is **stale**: it deploys to Fly.io (`parle-ai-gateway.fly.dev`,
  `ai-gateway-staging.fly.dev`), neither host resolves, and the workflow has no run on record. `fly.toml` is the same
  leftover. Do not use it.
- An environment patch has been staged on Railway since 2026-10-02 (1 change, not applied). `railway up` does not
  apply it; do not press "Deploy" on it in the dashboard without reading what it is.

## 2. What production runs now

- Railway deployment `b7f62dea-a18e-4f94-aa55-de781ab21457`, created **2026-10-07 05:29:14 UTC**, `SUCCESS`,
  rollback available.
- Commit: **`bf909f7`** (`main` at 2026-10-07 05:28:43 UTC, "deployments: busy is not dead, pressure autoscaler …").
  This is inferred, not reported by the service: `/health` has no version or commit; the commit is the tip of `main`
  31 s before the upload, and production's declared `parle-speech` is still `pending: GHCR_READ_TOKEN is not set`
  with the `ghcr.io/marcosremar/parle-speech` image, which is the code before `8477fce` (2026-10-07, later).
- So production is **84 commits behind `main`** (`d43f108`, #54) and PR #56 adds 95 more: this deploy ships #47–#54
  (realtime routes and edge, declared `parle-speech` on the Scaleway registry, …) together with #56.

Stored deployments (`GET /v1/deployments`, namespace `prod`, gateway cap 4 replicas / €6/h):

| Deployment | Machine | Replicas min / active / max | Idle | Mode, placements | Notes |
|---|---|---|---|---|---|
| `parle-qwen-tts` | L4-1-24G fr-par-2, boot script, 20 files | 0 / 2 / 2 | 15 min, delete | none, none | 1 replica running, status `degraded`, €0.788/h; created by the school's backend |
| `parle-speech` | L40S-1-48G fr-par-2, image `…/speech-stack:20261006-0107`, 9 files | 0 / 1 / 2 | 1 min, delete | none, none | target 8 in flight, cap €1.6/h, explicit `env` (`STT_BATCH`, `LLM_PARALLEL`, `TTS_STAGE0_MB`, `TTS_PARALLEL`), no `realtime` |
| `parle-speech-s2s` | L4-1-24G fr-par-2, boot script, 1 file | 0 / 1 / 1 | 20 min, delete | none, none | scaled to zero |
| `parle-livekit` | POP2-HC-48C-96G fr-par-1, boot script, exposed | 0 / 1 / 1 | 20 min, stop | none, none | scaled to zero |

Routes of the app `parle` (`/health`): `parle-stt` = `deployment:parle-speech` → `openrouter:openai/whisper-large-v3-turbo`
→ `groq` (`no_key`): **one cloud STT link**.

## 3. Before deploying

1. PR #56 merged into `main` after the live proof; `main` green.
2. Not during a class (Monday–Thursday 17:40–20:15 Paris) and not in the hour before one: § 6.
3. In the Railway dashboard: volume `ai-gateway-volume` → Backups → create one (it holds `deployments.json` and
   `apps.json`; the new code rewrites both at boot and the API never returns `env`, `files` or secrets, so a spec
   cannot be rebuilt from `GET`).
4. Save the public view for comparison: `curl -s -H "Authorization: Bearer $KEY" $GW/v1/deployments > before.json`
   (`GW=https://parle-ai-gateway.up.railway.app`, `KEY` an admin key of `GATEWAY_API_KEYS`).
5. Check that `ghcr.io/marcosremar/speech-stack:20261008-1317` and `rg.fr-par.scw.cloud/aigw/speech-stack:20261008-1317`
   still have digest `sha256:3ff347aad2f2b2e91b509837570e659a4c0d027d9fcd46d0c44fa710287bf6de`.

## 4. Deploy

From a clean worktree of `origin/main` (never the working checkout: `railway up` uploads the directory as it is), with
the Railway CLI logged in as the owner (the workspace token of the dev API does not work in the CLI):

```bash
git fetch origin main
git worktree add --detach /tmp/aigw-deploy origin/main
cd /tmp/aigw-deploy && git rev-parse HEAD            # write this commit down: it is the only record of what runs

bun run stamp:build                                 # writes commit + build time into src/build-info.json (→ /health)
railway up --detach --service ai-gateway \
  --project 2213991a-748b-4576-8bd1-f45232f722e3 --environment production
```

Reaper (same image, its own config file; only when its code or config changed — it did, since 2026-10-05):

```bash
cp railway.reaper.json railway.json                  # in the throwaway worktree only
railway up --detach --service ai-gateway-reaper \
  --project 2213991a-748b-4576-8bd1-f45232f722e3 --environment production
cd - && git worktree remove --force /tmp/aigw-deploy # the worktree has the copied railway.json
```

Deploy the gateway first and verify it before the reaper: the new reaper with `--apply` releases every machine of the
namespace older than 30 min when four `/health` probes over 2 min fail, so it must never run against a gateway that is
down for a failed deploy.

## 5. Verify

From the production-guard PR on, `curl -s $GW/health | jq '{commit, builtAt}'` answers which code runs (`null` = the
upload was not stamped: § 4), and `GET /health?details=1` with an admin key adds `images` (edge sidecar, profiles,
declared deployments). Before that build `/health` reports no version or commit. What also tells the new code is up:

```bash
curl -s $GW/health | jq '.status, .stages.stt'                       # ok; chains unchanged
curl -s -H "Authorization: Bearer $KEY" $GW/v1/deployments | jq '
  .declared, (.deployments[] | {name: .spec.name, image: .spec.image, mode: .spec.scaling.mode,
  placements: .spec.placements, realtime: .spec.realtime, status, warnings, lastError})'
```

Expected: `declared[0]` = `parle-speech` `applied` or `in_sync` (was `pending`), image
`rg.fr-par.scw.cloud/aigw/speech-stack:20261008-1317`; every deployment has `scaling.mode`; `parle-speech` has
`mode: "fast"`, the two placements and `realtime: {}`; its `warnings` say the Vast place is skipped because of `files`
(§ 8). Railway log line at boot: `deployments: no scaling block, running under the default mode` with the four names.
`GET $GW/v1/deployments/parle-speech/capacity` answers with `mode` and the per-machine ceilings. The replica of
`parle-qwen-tts` that was running is adopted (same id in `replicas`), not recreated.

Then one real turn through the app's routes (`POST /v1/audio/transcriptions`, `/v1/chat/completions`,
`/v1/audio/speech` with the `parle` key) and, outside a class, one cold start of `parle-speech`
(`POST /v1/deployments/parle-speech/wake`): it is the first boot of the new image under the production spec (its
`files`, its `env`), with the edge sidecar.

## 6. What changes at boot

Gateway-wide:

- **Every stored deployment gets `scaling: { mode: "balanced" }`** (none has the block today). Under a mode the
  replica count is no longer `ceil((in flight + waiting) / target)` at once: scale-out comes from the policy (cost of
  the load the fallback took, a burst of a full replica above capacity, a rising session trend), `minActiveReplicas`
  / `minReplicas` / warm floors still apply, and the effective idle time is at least the measured boot time (600 s
  until one boot is measured for the machine type + image; the resume time, 180 s, with `idleAction: "stop"`).
- `APP_DAILY_REQUESTS=20000` and `APP_DAILY_TOKENS=12000000` are already on the service: they are read at start and
  apply to the non-admin app keys from this restart (counters reset at 00:00 UTC).
- The declared-deployments reconciler runs at boot and every 5 min and stops being `pending`.
- The restart drops requests in flight and, because the service has a volume (one container at a time), the gateway
  is down between the stop of the old container and the first `/health` of the new one. The school's SDK falls back
  directly for those turns. The reaper tolerates it (one answered probe in four is enough).

Per deployment:

| Deployment | Mode after boot | What actually changes |
|---|---|---|
| `parle-qwen-tts` | `balanced` | Nothing while it is used: `minActiveReplicas` 2 = `maxReplicas` 2, so both L4 start on the first request as today. Idle stays 15 min unless a measured boot is longer (boot timeout is 45 min): then a replica is kept for that long. No placements: still fr-par-2 only. |
| `parle-speech` | `fast` (declared) | Image `20261006-0107` → **`20261008-1317`** (next cold start pulls ~57 GB anew; first boot under this spec). `realtime: {}`: the edge sidecar runs on the replica, `RT_MAX_SESSIONS` 4 on the L40S. Placements: L40S fr-par-2 → L40S fr-par-1 → RTX 5090 on Vast (skipped while the spec has `files`). **Idle goes from 1 min to ≈ 10 min** (boot time; about €0.23 more per wake at €1.4/h). The second replica no longer starts at 9 requests in flight but when the policy asks: any excess the fallback took, a burst, or — with session counts — half a replica of sessions (`fast` keeps one spare): a class can hold 2 × L40S (≈ €2.9/h) earlier and longer than today. The explicit `env` still wins over `envByMachineType` on every machine type. |
| `parle-speech-s2s` | `balanced` | `maxReplicas` 1: no scale-out either way. Idle stays 20 min unless its measured boot is longer (boot timeout 60 min). |
| `parle-livekit` | `balanced` | `maxReplicas` 1, parked on idle: idle stays 20 min (resume time 3 min is below it). No change expected. |

Composed fallback (`/v1/s2s` without a GPU seat): the STT hedge is 900 ms; the 3 s STT budget applies **only** while
two cloud STT links are usable. With today's route (one cloud link) the stage keeps its 8 s; a stage that fails after
more than 1 s is no longer run a second time (a slow failure costs 8 s, not 16 s).

## 7. Dangers

- **Before a class.** The deploy changes the image of `parle-speech` and turns the edge sidecar on: the first cold
  start after it is an unproven combination in production (new 57 GB pull, new start under the stored `files` and
  `env`). If it fails to become ready the class runs on the cloud fallback (measured 3–5 s to the first audio of the
  reply) and each attempt bills an L40S for up to the 45 min boot timeout. Deploy with enough time to wake
  `parle-speech` once and see it `ready`, or after the class.
- **Gateway replica cap of 4** (`DEPLOYMENTS_MAX_REPLICAS`): 2 × L4 (`parle-qwen-tts`) + 2 × L40S (`parle-speech`,
  now reached sooner under `fast`) is the whole cap; `parle-livekit` and `parle-speech-s2s` are then refused a replica.
- **Reaper.** Live config runs without `--apply` and without `AI_GATEWAY_ADMIN_KEY`, and its code is of 2026-10-05.
  After the reaper deploy of § 4 it releases machines when the gateway is down (30 min of age); the cross-check while
  the gateway is up stays off until `AI_GATEWAY_ADMIN_KEY` (a key of a user in `DEPLOYMENTS_ADMIN_USERS`, never the
  `SANDBOX_TOKEN`) is set on that service.
- **`LLM_SLOT_CTX=4096`** is in the `speech-stack` profile for the L40S, not in the declared `parle-speech`: production
  keeps 2048 (the history is trimmed after ≈ 16 pairs with the school's prompt). Do not add it before the VRAM of an
  L40S with 16 slots × 4096 is measured (§ 8).
- **`SPEECH_IMAGE`**, if someone sets it, moves the Scaleway image only; the Vast placement stays on the GHCR tag of
  the declaration.
- **No commit in `/health`**: the only record of what runs is the commit written down at § 4.

## 8. Stored records after the deploy

- `parle-speech`: **no PUT needed.** The reconciler patches image, placements, mode, `realtime` and the env per
  machine type at boot. Two follow-ups, both optional and neither done by this PR:
  - Vast fallback: the record has 9 `files` (the voice catalog), which a Vast host cannot receive; the place is
    skipped with the reason in `warnings`. To use it the files must be published at public https URLs and the spec
    moved to `fileUrls` (`{ "<key>": { "url": "https://…", "sha256": "<64 hex>" } }`) with `"files": {}`.
  - 4096 tokens per slot, after the measurement — add `"LLM_SLOT_CTX": "4096"` under `"L40S-1-48G"` in
    `src/deployments/declared/parle-speech.json` (merged per key over the stored values) and deploy: the preferred
    way. By hand it is a PATCH that **replaces the whole `envByMachineType`**, and the API does not return the stored
    one, so any key stored there today and missing below is lost (the record's explicit `env` is untouched):

    ```bash
    curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      $GW/v1/deployments/parle-speech -d '{"envByMachineType":{
        "L4-1-24G":{"RT_MAX_SESSIONS":"2"},
        "L40S-1-48G":{"RT_MAX_SESSIONS":"4","LLM_SLOT_CTX":"4096"},
        "RTX 5090":{"STT_BATCH":"8","LLM_PARALLEL":"16","TTS_STAGE0_MB":"9600","RT_MAX_SESSIONS":"4",
                    "TTS_MODEL":"Qwen/Qwen3-TTS-12Hz-0.6B-Base","LLM_FILE":"Qwen3.5-9B-Q4_K_M.gguf"}}}'
    ```

- `parle-qwen-tts`: **no PUT needed** to keep today's behaviour. It is owned by the school's backend
  (`backend/speech/qwen-gateway-host.ts` re-PUTs it, with `candidates` when the gateway accepts them), so do not add
  `placements` by hand: `placements` and `candidates` cannot be combined and the school's next PUT would be refused.
  Only the mode may be set here, if the voice should scale like the profile's (`fast`); fields a PUT does not send are
  kept:

  ```bash
  curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    $GW/v1/deployments/parle-qwen-tts -d '{"scaling":{"mode":"fast"}}'
  ```

- `parle-speech-s2s`, `parle-livekit`: nothing.

## 9. Order with the school's backend (babylon-cinema)

1. **Gateway first.** It is safe alone: with the one-link `parle-stt` route the fallback keeps the old 8 s patience.
2. **Routes** (`backend/speech/gateway-routes.ts`, `bun run deploy:gateway-routes` → `PUT /v1/apps/parle/routes`,
   applied at once, no restart): add the second cloud STT link (handoff § Fallback fast:
   deployment → `openrouter:deepgram/nova-3` → `openrouter:openai/whisper-large-v3`). From that moment the 3 s STT
   budget is active. Reverting the route reverts the budget.
3. **School backend / SDK.** The client first-sound deadline (#59) is in the browser SDK: it reaches learners only
   when babylon-cinema moves its `vendor/ai-gateway` pointer and deploys. The backend's PUT of `parle-qwen-tts` keeps
   working unchanged (it gets `balanced` when it sends no `scaling`).

## 10. Rollback

Code: Railway dashboard → `ai-gateway` → Deployments → `b7f62dea-a18e-4f94-aa55-de781ab21457` (2026-10-07 05:29 UTC)
→ Rollback; or the upload again from the old commit:

```bash
git worktree add --detach /tmp/aigw-rollback bf909f7 && cd /tmp/aigw-rollback
railway up --detach --service ai-gateway --project 2213991a-748b-4576-8bd1-f45232f722e3 --environment production
```

State is **not** rolled back by that: `/data/deployments.json` keeps what the new code wrote. The old code loads it
without validation and ignores `scaling` and `realtime`; it reads the Vast placement as a Scaleway type that is not
sold (skipped, harmless); its own reconciler is `pending` and leaves the record alone, so **the new image tag stays**.
Either restore the volume backup of § 3 before the rollback deploy, or put the image and placements back by hand:

```bash
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  $GW/v1/deployments/parle-speech \
  -d '{"image":"rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107","placements":[]}'
```

A replica already running the new image keeps serving until it idles out (there is no per-replica delete route);
the next one boots the old image. Routes: `bun run deploy:gateway-routes` from the school's previous commit.

## 11. Production guards (PR `rt/prod-guard`, 2026-10-08): what each needs at deploy time

Code and unit tests only; nothing below was run against production.

| Item | Takes effect with | Railway setting (names only) |
|---|---|---|
| Reaper applies, is loud, sees other namespaces | **redeploy of `ai-gateway-reaper`** (§ 4, the `cp railway.reaper.json railway.json` upload). Read on 2026-10-08: the service has no repository and no config path, its live start command is `./reap-compiled` (from the upload of 2026-10-05, before `--apply` entered `railway.reaper.json`), so only a new upload with that file changes it | `AI_GATEWAY_ADMIN_KEY` on the reaper (a key of a user in `DEPLOYMENTS_ADMIN_USERS`): without it every run now ends `NOT CHECKED` with exit 3 (the cron shows failed runs — intended). Optional: `ALERT_WEBHOOK_URL`, `REAPER_FOREIGN_MIN_AGE_HOURS`; `REAPER_APPLY=1` if the start command is ever edited by hand |
| `/health` commit, build time, image tags | gateway redeploy, with `bun run stamp:build` in the throwaway worktree before `railway up` (§ 4) | none |
| `reserveQuota` (class window) | gateway redeploy, then one PATCH per holder (below) | none |
| Replica cap message names the holders | gateway redeploy | none (the value is a proposal below) |
| Per-app daily budgets, budget webhook | gateway redeploy, then `PUT /v1/apps/parle/limits` | optional `ALERT_WEBHOOK_URL` on `ai-gateway` |
| TTS over-long sentence cut (`tts_overlong`) | a **new `speech-stack` image** (or `server.py` in the deployment's `files`) and a **new `aigw-edge` image** + its tag in `DEFAULT_EDGE_IMAGE` / `realtime.edgeImage`; the `max_new_tokens` of the gateway's TTS proxy (cloning requests to `parle-qwen-tts`) with the gateway redeploy | none |

**Reaper, first run after the redeploy.** With `--apply` and no admin key it still releases nothing while the gateway
is up (exit 3); with the key it releases machines of deployments the gateway does not have (30 min grace). Foreign
leftovers are only reported. To clear the stopped ones by hand, once, from the reaper's shell or a one-off run:
`./reap-compiled --apply-foreign` (stopped machines of other namespaces older than 6 h; running ones are never touched).
Do not put `--apply-foreign` in the cron start command while dev namespaces park replicas on purpose (`idleAction:
"stop"` leaves them stopped for hours).

**Class window** (binds only deployments of this gateway and namespace; a dev gateway is outside it — the reaper alert
covers that case). Fields a PATCH does not send are kept:

```bash
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' $GW/v1/deployments/parle-qwen-tts \
  -d '{"reserveQuota":{"quota":2,"windows":[{"days":[1,2,3,4],"start":"17:40","end":"20:15","timeZone":"Europe/Paris","minReplicas":2}]}}'
```

`quota` is the provider's quota for the machine type (L4: 2 on 2026-10-08; check the Scaleway console) and
`minReplicas` what the class needs of it. The same on `parle-speech` for the L40S if its quota is shared.
`parle-qwen-tts` is re-PUT by the school's backend: a PUT that omits `reserveQuota` keeps it (it is cleared only by
`"reserveQuota": null`). Check: `GET $GW/v1/deployments/parle-speech-s2s/capacity | jq .reservations`.

**Replica cap (proposal, not applied).** `DEPLOYMENTS_MAX_REPLICAS=4` is full with 2 × L4 (`parle-qwen-tts`) + 2 × L40S
(`parle-speech`): `parle-livekit` and `parle-speech-s2s` are refused (the refusal now says
`held by parle-qwen-tts 2, parle-speech 2`). For a class of 30 with the Vast overflow: 2 L4 (voice) + 2 L40S + 2 RTX
5090 on Vast (the declared placement allows 1 today: `placements[].maxReplicas`) + 1 `parle-livekit` + 1 spare for a
replacement that overlaps the machine it replaces (boot timeout, Vast expiry handover) = **`DEPLOYMENTS_MAX_REPLICAS=8`**.
The € ceiling has to follow or it becomes the limit: 2 × 0.79 + 2 × 1.47 + 2 × ≈ 0.6 (Vast cap) + the POP2-HC-48C of
`parle-livekit` ≈ €7–8/h against `DEPLOYMENTS_MAX_EUR_PER_HOUR` 6 → **10**. Seats: 4 realtime sessions per L40S / 5090
(`RT_MAX_SESSIONS`; 8 measured at 2.6–2.8 s worst first audio) gives 16 seats at 4 or 32 at 8 with four speech replicas;
30 simultaneous learners at 4 per replica would need 8 speech replicas, which neither quota provides — the rest runs
on the cloud fallback. Not measured: four speech replicas at once, and two Vast hosts in one class.

**App budget for the class.** `APP_DAILY_REQUESTS=20000` / `APP_DAILY_TOKENS=12000000` stay the default for every key.
A realtime session costs 4 requests per minute of its 10 min token (40) at admission; 30 learners × 3 sessions = 3600
requests per class day plus the `/v1/s2s` and stage requests of the fallback. To take the class out of the default:

```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'X-App: parle' \
  $GW/v1/apps/parle/limits -d '{"dailyRequests":60000,"dailyTokens":40000000}'
curl -s -H "Authorization: Bearer $KEY" "$GW/health?details=1" | jq .appBudgets   # use, rate, projected exhaustion
```

The counters are in memory: a gateway restart during a class starts the day's count again. A budget that ends
mid-class refuses the next turn or session with 429 `daily_budget_exhausted` and `reset_at`; replies in flight finish.

**TTS.** Until the two images are rebuilt, production keeps today's behaviour (an audible sentence that reaches its cap
ends the turn with the `tts` error). No retry was added for the non-silent runaway: it cannot be told from speech
before the learner has heard it without holding back every first audio.

## 12. Integration build (PR `rt/integration-2`, 2026-10-09): #67, #68, #63, #62, #64, #66, #65 on `main`

Nothing below was run against production. § 11 (production guards, #63) is part of this build and stays as written.
#65 (WebRTC uplink as it arrives, loss as elapsed time, 48 kHz downlink, lead trim) joined on 2026-10-09 (merge
`624bced`). The build was proven live on an L40S the same morning, from a local gateway: results, what stays
unit-only and the GO / NO-GO are in `2026-10-07-realtime-handoff.md` § Prova ao vivo da integração (#70).

### 12.1 What it adds

| Area | New at deploy time | Needs |
|---|---|---|
| Routes (gateway) | `POST /v1/realtime/updates` (app key: signs a change to a live session, #68); `GET /v1/apps/:app/devices`, `POST` / `DELETE /v1/apps/:app/devices/:device/block`, `PATCH /v1/apps/:app {requireDevice}` (#62); `GET` / `PUT /v1/apps/:app/limits` (#63); `GET /v1/boot-files?d&k&exp&sig` (public, signed link a Vast replica downloads its `files` from, #64); `/health` → `commit`, `builtAt` (#63); `/v1/s2s` accepts `config.speculation` (#66) | gateway redeploy |
| Request fields | `POST /v1/realtime/sessions`: `device`, `config.intercepts`, `config.reply_guard`, config up to 32768 base64url characters (answer carries `cfg` above 6144); header `X-Gateway-Device` on the inference routes and `/v1/s2s` | gateway redeploy; `intercepts`, `reply_guard`, config by reference, signed updates, `say`, `done.served` also need the **new edge image** |
| Edge (replica) | signed config authoritative (#67), config by reference, intercepts, `say`, signed updates, reply guard, served ids (#68), over-long TTS cut (#63) | **new `aigw-edge` image** inside a **new `speech-stack` image** (§ 12.5) |
| Speech stack | `/health` → `models` (ids for `done.served`), over-long TTS sentence cut, `max_new_tokens` | **new `speech-stack` image** |
| Deployment spec | `reserveQuota` (#63), `realtime.requireWebrtc`, `files` on a Vast placement (#64) | gateway redeploy; PATCH per deployment |
| Browser SDK | `applyUpdate`, events `intercept` / `say` / `config_applied`, `metrics.lastTurn.served`, option `device`, `voice.speculatePauseMs`, PCM voice streamed on the clip rung | the school moving its `vendor/ai-gateway` pointer and deploying |
| State on the volume | `vast-hosts.json` (host reputation) next to `deployments.json`; `apps.json` gains `devices`, `requireDevice`, `limits` | none (written on first use; the old code ignores them) |

Settings (names only; all optional, nothing is required for today's behaviour):

| Setting | Where | Effect when unset |
|---|---|---|
| `AIGW_PUBLIC_URL` | `ai-gateway` | Railway's `RAILWAY_PUBLIC_DOMAIN` is used; without either, a spec with `files` is still skipped on a Vast placement |
| `ALERT_WEBHOOK_URL` | `ai-gateway` | no webhook on `app.budget_warning` / `app.budget_exhausted` (telemetry only) |
| `AI_GATEWAY_ADMIN_KEY` | `ai-gateway-reaper` | the reaper's cross-check while the gateway is up stays off (§ 11) |
| `PUT /v1/apps/parle/limits` | API, after the deploy | the gateway-wide `APP_DAILY_REQUESTS` / `APP_DAILY_TOKENS` apply (§ 11) |
| `PATCH … {"reserveQuota": …}` | API, per holder, after the deploy | no class-window reservation (§ 11 has the command) |
| `PATCH /v1/apps/parle {"requireDevice": true}` | API | requests without a device id are accepted, as today. Do **not** set it before every caller of the app sends ids |
| `S2S_SPECULATE=0`, `S2S_SPECULATE_MIN_MS`, `S2S_SPECULATE_PER_TURN`, `S2S_SPECULATE_TTL_MS` | `ai-gateway` | speculation on, 600 ms of audio at least, 2 per turn, kept 4 s. Only clients that ask for it (`voice.speculatePauseMs`) cause any |

### 12.2 What tightens (#67): the browser can no longer change the session

On a replica with the new edge image, a `config_update` from the client is refused whole (`error{code:"forbidden"}`,
`edge.config.refused` with the field names) when it carries anything but:

- `messages` of role `user` / `assistant` with string content (appended to the history);
- `opener: null` (switches the signed opener off) or any other `opener` value (switches the **signed** one back on,
  never a new one);
- `signed` (an update the gateway signed: `POST /v1/realtime/updates`).

No longer possible from the page: `system`, `voice`, `fallback_voice`, `max_tokens`, `temperature`, `stt_prompt`,
`user_template`, `first_audio_deadline_ms`, a new `opener`, `language`, `vad`, a `system` message in `messages`. Who is
affected:

- **The SDK itself: nothing.** Every frame it sends on its own is on the list
  (`docker/aigw-edge/tests/sdk-client-updates.json`, enforced in the SDK tests and in the edge tests). `updateHistory`
  drops `system` messages before sending.
- **The school's backend / page (babylon-cinema).** Anything it changed mid-session through the raw transport or a
  patched `config_update` (prompt per scene, voice per character, opener lines) must move to the session config sent
  at admission (`POST /v1/realtime/sessions`, now up to ~24 KB) or to a signed update from its backend
  (`POST /v1/realtime/updates` → `session.applyUpdate(signed)`). Grep the school for `config_update` and for
  `updateHistory` calls with a `system` role before this edge image reaches a class.
- **The live harness.** `LIVE_VOICE_B64` / `LIVE_VOICE_TEXT` (`scripts/realtime-e2e/e2e-live.ts`) now put the cloned
  voice in the signed session config; a sample over the 32768-character bound is refused up front (use a catalog
  voice of the replica: `scripts/realtime-e2e/fixtures/voices.json` through the deployment's `fileUrls`).

Old SDK × new edge: works, except a page that sent the fields above. New SDK × old edge (image `f66b6b80`): works for
configs up to 6144 characters; a config by reference, `applyUpdate`, intercepts, `say` and `served` need the new edge
(an old edge cannot open a by-reference session: it falls to the clip rungs).

### 12.3 Where features meet (each has a unit test)

| Meeting | Behaviour |
|---|---|
| Hooks (#68) on the clip rungs / composed fallback, with or without speculation (#66) | `intercepts` and `reply_guard` are carried and **not evaluated**: a command spoken there goes to the LLM and enters the history; a speculative start voices nothing. The app's backend matches the `transcript` event itself, as before |
| Device (#62) and config digest (#68) | both optional claims in one token (`sid, app, dep, rep, cfg, [dev], iat, exp, [cfd]`); a token with neither is byte for byte the old one. A blocked device gets no session, no signaling, no signed update |
| UDP probe (#64) | a session admitted on a replica not probed yet waits ≤ 2.5 s inside `POST /v1/realtime/sessions` (SDK timeout 5 s); it is not part of a turn and does not touch the first-audio deadline. A blocked device is refused before it |
| `reserveQuota` (#63) and a Vast placement (#64) | inside the window another deployment's walk skips the reserved Scaleway type with the reason and continues to Vast; without a Vast placement it answers 409 `reserved` |
| TTS cap (#63) and app lines (#68) | `say` lines, intercept `text` and openers share the cap of `3 s + 0.2 s per character`; a line read normally is never cut; one that runs away is cut and counted (`edge.tts.overlong`) |
| History fit (#58) and signed `messages` / `drop_turn` (#68) | a replaced history is cut to the slot like any other; a dropped turn leaves whole pairs |

### 12.4 Order of operations

1. This PR merged into `main` after its live proof (§ 12.7); `main` green. Not during a class, not in the hour before.
2. Volume backup and `before.json` (§ 3).
3. **Images first, without touching production**: the `speech-stack` tag of § 12.5 exists on GHCR and on the Scaleway
   registry with the same digest (check as § 3.5).
4. **Gateway** (§ 4, with `bun run stamp:build`). Alone it is safe for learners on the old replica image: the routes
   above appear, the declared `parle-speech` is patched to the new image tag, and the next cold start pulls it.
   Verify § 5 plus `curl -s $GW/health | jq '{commit, builtAt}'`.
5. **Reaper** redeploy (§ 4), then `AI_GATEWAY_ADMIN_KEY` on it (§ 11).
6. One cold start of `parle-speech` outside a class (`POST /v1/deployments/parle-speech/wake`): first boot of the new
   image; check `GET /v1/deployments/parle-speech` → replica `ready`, `udp`, and the replica's edge accepts a session
   (`e2e-live.ts admit`, `turn ws`, `turn webrtc`).
7. API settings: `reserveQuota` on the class-window holders, `PUT /v1/apps/parle/limits` (§ 11); optional
   `ALERT_WEBHOOK_URL`, `AIGW_PUBLIC_URL`.
8. **School**: move `vendor/ai-gateway`, remove any client-side change of signed fields (§ 12.2), deploy. Only then
   may it use `intercepts`, `say`, signed updates, `device`, `speculatePauseMs`.

Rollback: § 10. The old gateway ignores `devices`, `limits`, `reserveQuota`, `requireWebrtc` in the stored state and
does not know `vast-hosts.json`; put the image tag of `parle-speech` back by hand as § 10 shows.

### 12.5 Images of this build

Built by CI from this branch on 2026-10-09 (UTC); nothing in production points at them until the gateway deploy.

| Image | Tag | Digest | Built from |
|---|---|---|---|
| `ghcr.io/marcosremar/aigw-edge` | `79722253` | `sha256:2b0ba945e5505b8ef6dd56dc439807917bf0e3956f514878bbdb93338103fb17` | commit `7972225` (workflow `aigw-edge`): #67, #68, the TTS cut of #63, #65, and the client `end_turn` fix. No file under `docker/aigw-edge/` changed after it |
| `ghcr.io/marcosremar/speech-stack` (public, Vast) | `20261009-0213` | `sha256:210f98859fed816642c96a6554f032d9865025f870f859c21eb9a9b7a26f4d31` | commit `3275783` (workflow `speech-stack`), `EDGE_TAG=79722253`, with `GET /debug/gpu`. No file under `docker/speech-stack/` changed after it |
| `rg.fr-par.scw.cloud/aigw/speech-stack` (Scaleway) | `20261009-0213` | the same digest | `bun scripts/build-image-on-scaleway.ts --from ghcr.io/marcosremar/speech-stack:20261009-0213 speech-stack` (994 s, one blob upload retried after `RANGE_INVALID`; the build machine and its volume were deleted by the script) |

In the branch: `DEFAULT_EDGE_IMAGE` and the speech-stack `EDGE_TAG` are `79722253`; `SPEECH_STACK_TAG` (the profile) and
`src/deployments/declared/parle-speech.json` (Scaleway default and the Vast placement) are `20261009-0213`. Before the
deploy, check both registries still answer that digest (as § 3.5, with this tag). First boot on an L40S: 2026-10-09
(handoff, item 1). To go back, restore the two tags `f66b6b80` / `20261008-1317` in those four places (what
production ran before this build).

Later pushes to the PR rebuild both images under other tags (the workflows run on every push that has `docker/` in
the PR's diff); only the tags above are pinned. The earlier pair of this branch (`48db2e5f` / `20261009-0003`, without
#65 and the `end_turn` fix) is superseded and was never deployed.

### 12.6 Not in this build

- Open after the live proof of 2026-10-09 (handoff § Prova ao vivo da integração (#70) has the detail):
  - the first-sound deadline on the learner's clock (#59) with the client's own opener was not re-measured (the
    opener is voiced through the cloud TTS, whose key had expired); the turns ending `interrupted` in that mode are
    fixed in the edge of this build and re-measured without the opener;
  - everything on the composed fallback, speculation included (#66): the OpenRouter key served by the dev API is
    expired;
  - everything on Vast (#64 host reputation, `files` through signed links, `requireWebrtc`): the account has no credit;
  - L40S not sold in fr-par-1 (the second placement of `parle-speech` is skipped);
  - the Vast boot timeout (20 min) is shorter than the first pull of the 57 GB image on a slow host;
  - the RTT gate decides after the paid pull (a far host is released only once it has booted);
  - a system prompt larger than the LLM slot (16 KB of Portuguese ≈ 4.7 k tokens against 4096) opens the session and
    fails every turn with `error upstream`: keep the school's prompt well below the slot (≈ 5 KB with 2048);
  - `LLM_SLOT_CTX` 4096 fits the L40S VRAM (29.2 of 46 GB with 12 learners) but the LLM slows as the history grows
    (198 → 461 ms over 760 s with 8 learners): production stays on 2048;
  - the up-to-2.5 s UDP-probe wait on the first admission of a fresh replica was not measured live.

### 12.7 Live proof checklist for this build

On a dev gateway (`GW`, admin `KEY`, deployment `DEP` from the `speech-stack` profile with the tag of § 12.5), never
production. `MIC` is a 16 kHz speech WAV; `RT_CONFIG` names a catalog voice.

```bash
export GW=… KEY=… DEP=parle-speech MIC=/tmp/aigw-rt-e2e/mic.wav
export RT_CONFIG='{"system":"Você é a padeira da esquina. Responda curto, uma frase.","messages":[],"voice":"<catalog id>","fallback_voice":"default","language":"pt"}'
curl -s $GW/health | jq '{commit, builtAt}'
curl -s -H "Authorization: Bearer $KEY" "$GW/health?details=1" | jq .images
bun scripts/realtime-e2e/e2e-live.ts admit
bun scripts/realtime-e2e/e2e-live.ts turn ws
bun scripts/realtime-e2e/e2e-live.ts turn webrtc
LIVE_FORCE_RELAY=1 bun scripts/realtime-e2e/e2e-live.ts turn webrtc
bun scripts/realtime-e2e/e2e-live.ts barge
bun scripts/realtime-e2e/load.ts --n 4 --clip $MIC --profile clean --duration 300
bun scripts/realtime-e2e/load.ts --n 4 --rtc 4 --clip $MIC --profile clean --duration 300
bun scripts/realtime-e2e/load.ts --n 8 --s2s 8 --no-wake --speculate-lead 400 --speculate-resume 0.3 --clip $MIC --duration 180
```

| # | Item | How | Pass |
|---|---|---|---|
| 1 | The build is the one deployed | `/health` `commit` = the PR head; `images` shows the edge and speech-stack tags of § 12.5 | both match |
| 2 | Turn on each rung with the new edge | `turn ws`, `turn webrtc`, relay | `done` not `interrupted`, `metrics.lastTurn.served` has `stt` / `llm` / `tts` ids and `transport` |
| 3 | #67 | with any WebSocket client on the `ws` url of a `POST /v1/realtime/sessions` answer, send `{"type":"config_update","system":"x"}` after `ready` | `error forbidden`, next turn still the signed persona; `edge.config.refused` in telemetry |
| 4 | Config by reference | `RT_CONFIG` with a 7 KB and a 16 KB `system` (on the L40S slot of 2048 the 7 KB one must fail every turn with `upstream` / context size: realtime.md § What fits the LLM) | session opens (`cfg` in the descriptor); 413 at 25 KB |
| 5 | Intercepts, `say`, signed update | `RT_CONFIG` with `intercepts` (`drop` on "mais devagar", `say` on "opções"); `curl -X POST $GW/v1/realtime/updates -d '{"token":…,"update":{"say":{"text":"Bem-vinda!","history":true}}}'` and `session.applyUpdate(signed)` in the page | `intercept{tag}` then `done{intercepted}` with no LLM call; the line is heard, `config_applied{n}`, `done{said:true, served}` |
| 6 | Reply guard | `reply_guard: {deny:["sure","of course"], note:"Responda em português."}` and an English prompt | `metrics.reply_retries: 1`, the denied sentence is not heard |
| 7 | Devices | `POST /v1/realtime/sessions` with `device`; block it during a ws and a webrtc session | ws closes 1008 `device_blocked`; the webrtc session is deleted at the edge; new admission 403 |
| 8 | UDP probe | first session on a fresh replica | admission ≤ ~3 s, `udp` on the replica view; on a UDP-blocked Vast host the descriptor has no `webrtc` |
| 9 | Vast `files` | the spec with `files` and a Vast placement, `AIGW_PUBLIC_URL` set, Scaleway zones paused | `lastPlacement` on Vast, no "files are not supported" warning, the replica becomes `ready` |
| 10 | `reserveQuota` | PATCH a window that is active now on one deployment, wake another of the same type | 409 `reserved` with the end time; with a Vast placement it lands on Vast |
| 11 | Over-long TTS | a sentence the engine runs away with (rare: watch `edge.tts.overlong` / `tts_overlong` over the load runs) | the turn continues; no `tts` error for an audible sentence |
| 12 | Speculation on the fallback | the `--s2s --speculate-lead` run | `s2s.stt_speculative` events, `done.speculation` `hit` on most turns, first audio earlier than the same run with `--speculate-lead 0`; no turn voiced twice **passed 2026-10-10** on a local gateway with the live cloud fallback: 100 % `hit`, −0.4 to −0.5 s p50 (handoff § Plano B ao vivo) |
| 13 | Reaper | dry run against the dev gateway, with the reaper's own variables: `bun scripts/reap-orphans.ts` (no `--apply`) | lists foreign leftovers, releases nothing |
| 14 | History | 20 turns in one session (`load.ts --n 1 --duration 400 --think 2-4`) | no `upstream` context error; `edge.llm.history_trimmed` appears |

### 12.8 Deploy conditions (live proof of #70, 2026-10-09; merged to `main` with the audit fixes #72, #73, #74)

Merging changed nothing in production. The deploy of this `main` is GO under these conditions:

1. Outside Mon–Thu 17:40–20:15 Europe/Paris (class time), and not in the hour before.
2. `LLM_SLOT_CTX` stays **2048** on `parle-speech` (4096 fits the L40S VRAM but the LLM slows as the history grows,
   and the history trim was not exercised at 4096).
3. Speculation off (the school does not use `speculatePauseMs`) and the composed cloud fallback not relied on until the
   OpenRouter key served by the dev API is rotated and item 12 of § 12.7 has passed (today it would not answer, with or
   without this deploy).
4. No Vast for the school (`requireWebrtc`, `files` through signed links, host reputation): not proven, the account has
   no credit.
5. The school removes every client-side change of signed fields (§ 12.2) before the new edge serves a class, and keeps
   its system prompt well below the LLM slot (§ 12.6).
6. Behaviour change from #74: a `warmSchedule` or `reserveQuota` window without `timeZone` now reads as Europe/Paris
   (stored explicitly) instead of UTC. Production has no such window today; check `GET /v1/deployments` before the
   deploy and give any window an explicit `timeZone` if one appeared.
7. Order of § 12.4; check `/health` `commit` / `builtAt` afterwards.

Also in this build: #76 (Vast stress fixes) and #75 (the audit's security fixes: dev token not admin, Bearer-only
keys, per-replica tokens, Scaleway registry pull with a read-only key).

### 12.9 Pre-deploy checklist for #75

- [x] `SCW_REGISTRY_SECRET_KEY` exists (created 2026-10-09): IAM application `aigw-registry-readonly`, its only policy
  `ContainerRegistryReadOnly` on the project; secret and access key in the dev API (palco), served by
  `GET /api/sandbox-env`. Checked: the registry grants `pull` on `aigw/speech-stack` and nothing for `pull,push`; it
  lists no Instance server. Creation steps (for a rotation): IAM → Applications → Create (no group) → Policies →
  Create policy → scope: project → `ContainerRegistryReadOnly` → attach → API keys → Generate.
- [ ] Until the hot key rotation build (PR `feat/hot-key-rotation`) is deployed, the gateway reads the key at boot only.
  From that build on it is picked up by the palco reload (≤ 5 min, or `POST /v1/admin/keys/reload` at once) —
  steps in § 12.9.1. Either way, afterwards `/health?details=1` (admin key) must have no
  `SCW_REGISTRY_SECRET_KEY is missing` warning; with the warning, every create of an `rg.*.scw.cloud` image
  (`parle-speech`) fails at once with an error naming the variable, and the boot log has the same line as `ERROR:`.
- [x] The school's `AI_GATEWAY_KEY` is an admin key (checked 2026-10-09: distinct from `SANDBOX_TOKEN`,
  `/health?details=1` → 200 with admin fields), so the dev token losing admin does not touch the school.
- [ ] Optional: `SANDBOX_TOKEN_APP=parle` on the gateway if dev sessions should keep calling the parle aliases with the
  dev token (no-wake, app-key limits); unset, they get 403 on those aliases.
- [ ] Afterwards consider rotating `SCW_SECRET_KEY`: it sat in the user_data and `boot.log` of every past replica. With the
  hot key rotation build this is § 12.9.1 step 2, no deploy.

#### 12.9.1 Change each key without a deploy (from the `feat/hot-key-rotation` build on)

Only the first deploy of that build is needed; after it none of these steps restarts the gateway. Provider keys
(OpenRouter, Groq, …) already rotate this way in production today (`PUT /v1/admin/keys`, live since 10/10/2026).
`$GW` = `https://parle-ai-gateway.up.railway.app`, `$ADMIN` = an admin key. Every call below is audited: check with
`curl -H "Authorization: Bearer $ADMIN" $GW/v1/admin/access/audit`.

1. **Provider keys** (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, …): `PUT $GW/v1/admin/keys` with `{"NAME": "value"}` — writes
   the palco and reloads. Or change it on the palco (`bun run sandbox:set` in babylon-cinema) and
   `POST $GW/v1/admin/keys/reload`.
2. **Machine credentials** (`SCW_SECRET_KEY`, `SCW_PROJECT_ID`, `SCW_REGISTRY_SECRET_KEY`, `VAST_API_KEY`): create the new
   key at the provider (keep the old one alive), write it as in step 1, then check the audit entry
   `deployment-credentials.rotate` is `ok: true`. `ok: false` means the provider refused the new key: the gateway kept
   the old one, nothing stopped; fix the key and write it again. Once `ok: true`, delete the old key at the provider.
   A provider that had no key when the gateway booted still needs a restart.
3. **A client key** (the school's `AI_GATEWAY_KEY`, a site's key): `GET $GW/v1/admin/access/keys` to find its id, then
   `POST $GW/v1/admin/access/keys` with `{"replaces": "<id>", "overlapMinutes": 60}` → the answer carries the new key
   (only time it is shown). Put it in the client (palco `AI_GATEWAY_KEY` for the school), confirm the client works and
   that `lastUsedAt` of the new id moves; the old key stops by itself after 60 min (or revoke it at once:
   `POST $GW/v1/admin/access/keys/revoke {"id": "<old id>"}`). The `GATEWAY_API_KEYS` Railway variable may keep the old
   value: a revoked env key stays refused (state in `access.json` on the volume).
4. **A leaked key**: `POST $GW/v1/admin/access/keys/revoke {"id": "<id>"}` — refused from the next request on.
5. **Admins**: `PUT $GW/v1/admin/access/admins {"users": ["parle", "ops"]}` (you must stay in the list); a new admin
   key: `POST $GW/v1/admin/access/keys {"user": "ops2", "admin": true}`.
6. **`SANDBOX_TOKEN`**: first make the palco accept the new token next to the old one; then
   `PUT $GW/v1/admin/access/sandbox-token {"token": "<new>", "overlapMinutes": 60}`. A `400` means the palco refused it and
   nothing changed. After `200` the gateway uses the new token and accepts the old one for 60 min; then retire the old
   token on the palco and update the Railway variable when convenient (the stored token wins at boot while the palco
   accepts it).
7. **Replica tokens / realtime signing key**: `POST $GW/v1/admin/access/replica-secrets/rotate` (`{"deployment": "<name>"}`
   for one). New replicas get the new secret; live replicas and their open sessions keep theirs until replaced (the
   edge cannot take a new token while running). To finish a rotation, let the old replicas be replaced (park/scale
   down outside class hours).

#### 12.9.2 Rotations after the deploy (D4, S15, D6) — not done yet

Do them only once #75 and the hot key rotation build (#81, § 12.9.1) are live (`/health` `commit` at or after both
merges), outside class hours (no class
Mon–Thu 17:40–20:15 Paris), one at a time, and check each before the next. Every value goes through the dev API
(`PUT https://parle-palco.up.railway.app/api/sandbox-env`, Bearer `SANDBOX_TOKEN`, body `{"NAME":"value"}`); never paste
a value in a chat, a log, a commit or a shell history (load it into the process and send it from there).

**`SCW_SECRET_KEY` (D4).** Today it is a *user* key of the organization owner (full access to everything), one of the
three user keys listed by `GET /iam/v1alpha1/api-keys` (descriptions `teste` 2026-03-16, `testeste` 2026-09-25,
`fdfdfdfd` 2026-10-02; the API does not say which one is the gateway's). It sat in the user_data and `boot.log` of every
replica before #75. Replace it with an IAM application key that can only do what the gateway does:

1. Scaleway IAM (API with the current key loaded in the process, or console): create the application
   `aigw-gateway`; one policy, scope = the project `SCW_PROJECT_ID` only, permission sets `InstancesFullAccess` and
   `BlockStorageFullAccess` (the gateway calls `instance/v1`, `block/v1alpha1` and the public `marketplace/v2`;
   `SCW_PROJECT_ID` is set, so it never needs `iam/v1alpha1`). Generate its API key with `default_project_id` = the project.
2. Before switching, prove it with the new key alone: `GET /instance/v1/zones/fr-par-2/servers` lists the same number
   of servers as the old key (an under-privileged key gets 200 with an empty list, not 403); same for `fr-par-1`,
   `nl-ams-1`, `pl-waw-2`.
3. `PUT /api/sandbox-env {"SCW_SECRET_KEY": <new>, "SCW_ACCESS_KEY": <new access key>}`; check
   `GET /api/sandbox-env` returns the new value (compare a hash, do not print it).
4. Gateway: `POST $GW/v1/admin/keys/reload` (or `PUT $GW/v1/admin/keys` in step 3 instead of the palco `PUT`) and
   check the audit entry `deployment-credentials.rotate` is `ok: true` (§ 12.9.1 step 2; `ok: false` = the gateway
   kept the old key). Then trigger one `ai-gateway-reaper` run (it fetches at every run). `GET /v1/deployments` must
   list the existing replicas (listing them proves the key sees the project). The first real create after the
   switch: watch for `create failed` with `403`/`permission`; if it appears, write the old key back the same way.
5. Other holders to refresh: the `parle` service (`ucast.me`, reserve copy of the dev API — update it there too, or
   remove the variable), every `.env` written by `bun run sandbox:fetch` (babylon-cinema checkout and its worktrees:
   run `sandbox:fetch` again), and the local backup `/Users/marcos/aigw-state-backup-20261009/` (does not hold it).
6. Only after a day without `403`: delete the old user key(s) in IAM (all three if none is used elsewhere — they are
   owner keys with no scope). Deleting is the step that actually ends the exposure.

**`SANDBOX_TOKEN` and its aliases (S15/D6).** It appeared in orchestration transcripts. On the gateway side § 12.9.1
step 6 swaps it with an overlap, but it starts with «make the palco accept the new token next to the old one», and the
palco hub accepts exactly one token today (`hubConfig().token`, `palco/hub/http.ts` in babylon-cinema). Until the palco
takes two, every holder breaks until it gets the new value — do it in one sitting:

1. Generate a new value (`openssl rand -base64 48 | tr -d '/+=\n'`, ≥ 40 chars) in a shell variable.
2. Palco (`palco` service on Railway, project of the hub): set `SANDBOX_TOKEN` and every alias that holds the same value
   (`PALCO_PROXY`, `PALCO_PROXY_TOKEN`, `PROXY_TOKEN`, and the legacy `VMOS_PROXY*` / `GPU_POOL_TOKEN` if present) in
   the Railway variables of the service (the dev API refuses to write these names: `SANDBOX_FETCH_DENY`), then restart
   it. Check: `GET /api/sandbox-env` with the old token → 401, with the new → 200.
3. Immediately, the services that fetch with it (each: Railway variable `SANDBOX_TOKEN` → new value, then restart):
   `ai-gateway` (with the hot rotation build: `PUT $GW/v1/admin/access/sandbox-token {"token": "<new>"}` right after
   the palco switch, then the Railway variable for the next boot; a running gateway keeps its keys when a reload
   fails, but would boot without them on the old token), `ai-gateway-reaper` (fetches SCW/VAST keys
   at each run; a run in between fails `NOT CHECKED`, harmless), `parle` prod (`parle-prod`) and `parle-stage`
   (`backend/boot-env.ts`; a failed fetch does not stop the boot, but keys missing from the service are then absent).
4. CI and runners: GitHub secret `SANDBOX_TOKEN` of `marcosremar/babylon-cinema` (workflows `ci`, `tests-full`,
   `nightly`, `study-e2e`, `ci-contabo`), and the environment of the Contabo runners (`bun run ci:contabo status`).
5. Agents and machines: `.env` of the babylon-cinema checkout (worktrees inherit it through `.worktreeinclude` — refresh
   the existing ones), the ai-gateway checkouts that have one, Cursor / Kimi / Claude Code Web secrets, `PALCO_PROXY`
   in the Cloud Agent, and any `.mcp.json` that carries it in `env`.
6. Verify: `/health` of the gateway after its restart has its provider keys (`/health?details=1` with an admin key),
   `bun run sandbox:check` passes from the Mac, the next nightly run of babylon-cinema passes the hub steps.

#### 12.9.3 Replica TLS and SSH (S11) and the push key (S12) — `fix/security-remaining`

- Vast replicas now serve their nginx front over TLS on the same mapped port: the gateway derives a private CA per
  replica token, the boot script issues the leaf for `IP:$PUBLIC_IPADDR`, and every gateway → replica call (probe,
  invoke, inference, s2s, streaming STT, realtime signaling/status/WS relay) trusts only that CA. The boot script also
  deletes `/root/.ssh/authorized_keys` and stops `sshd`. A Vast replica that booted before this build speaks plain HTTP:
  after the deploy the gateway cannot reach it and replaces it — deploy with no Vast replica serving (the school does not
  use Vast today, § 12.8 item 4). Scaleway replicas are unchanged (still HTTP to their public IP: not covered here).
- Proven only with fakes and a local nginx/Bun: on a real Vast host it remains to see that `PUBLIC_IPADDR` inside the
  container equals the `public_ipaddr` the API reports (else the TLS check fails and the host is released as
  `boot-timeout`), that `openssl` installs from the base image, that killing `sshd` sticks under `ssh_direct`, and
  that the mapped SSH port then refuses connections.
- `scripts/build-image-on-scaleway.ts` logs the build machine in with `SCW_REGISTRY_PUSH_SECRET_KEY` (IAM application
  `aigw-registry-push`, created 2026-10-10, one policy `ContainerRegistryFullAccess` on the project only; key in the dev
  API with `SCW_REGISTRY_PUSH_ACCESS_KEY`). Checked on 2026-10-10: the registry grants it `pull,push` and accepts a blob
  upload; `GET /instance/v1/zones/fr-par-2/servers` returns 0 servers with it (4 with the master key). The master key
  stays on the laptop side only (creates and deletes the machine). Rotation: same IAM steps, `PUT` the new secret.

### 12.10 Balance watch and email alerts (`feat/balance-watch-email`, 2026-10-10)

Why: on 2026-10-10 the Vast account reached zero with no warning (two RTX 5090 of another project left running), the
palco lost its GPU and the school deploy stopped on `402 insufficient credit`; the day before the OpenRouter key
expired with no warning. The gateway now reads the provider balances every 15 min and emails the owner
(`docs/api/http.md` § `balances`).

- Nothing to set on Railway: `RESEND_API_KEY`, `MAIL_FROM` and `ALERT_EMAIL_TO` (`vovoafiliado@gmail.com`) were written
  to the dev API on 2026-10-10 and reach the gateway at boot with the other keys. The next deploy (or restart) turns
  the watch and the emails on; `BALANCE_CHECK_MINUTES=0` turns the watch off, an empty `ALERT_EMAIL_TO` the emails.
- Verify after the deploy: `GET /health?details=1` (admin key) has `balances.readings` with `vast`, `openrouter`,
  `runpod` and, with deployments, `scaleway`; the log has no `alert email failed`.
- Test send from a checkout: `SANDBOX_TOKEN=… bun scripts/alert-email-test.ts` (prints the balances, sends
  «[ai-gateway] teste de alerta», prints the Resend id). Sent on 2026-10-10, Resend id
  `01a125ed-c1ce-7d30-9cce-177335a201bc`.
- Scaleway: the restricted key `aigw-machines` gets `403` from the billing API, so the Scaleway reading is the
  gateway's own estimate (its running replicas and the month spend against the summed `scaling.budget.eurPerMonth`).
  A real invoice figure needs a key with `BillingReadOnly` on the organization.
