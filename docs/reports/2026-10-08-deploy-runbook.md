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

`/health` reports no version or commit. What does tell the new code is up:

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
