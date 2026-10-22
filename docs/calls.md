# Calls — the parle LiveKit, owned by the gateway (`src/calls`)

Owner decision (21/10/2026): the gateway owns parle's own LiveKit (services `livekit` and `livekit-egress` of the
Railway project `parle-game`, environment `production`, EU) and hands out room tokens. With nobody in a room for 15
minutes it stops both services; the first request redeploys them. This replaces the 14/10/2026 decision to keep them
always on. `livekit-redis` stays on (cheap, no state worth losing). The old `parle-livekit` declared deployment (a
Scaleway VPS, retired) is gone; the calls configuration is `src/calls/parle.json`.

## Routes (gateway key, Bearer, like every `/v1/*` route)

| Route | Answer |
|---|---|
| `GET /v1/calls/health` | `200 {"own":{"phase","url","checkedAt","rooms","participants","idleSince"},"cloud":{"configured","minutesLeft"}}` — probes the own server (`listRooms`, 2.5 s), never wakes anything |
| `POST /v1/calls/wake` `{"app":"parle"}` | `202 {"phase"}` — renews the idle clock and redeploys the stopped services; idempotent; a dev key (`countsAsUse: false`) only reads the phase (rule 7) |
| `POST /v1/calls/park` `{"app":"parle"}` | `202 {"phase":"parked","services"}` — stops now; `409 in_use` with a participant or an active egress, `409 class_window` for the app key inside the class window (an admin key parks anyway), `403` for any other key |
| `POST /v1/calls/token` | `200 {"url","token","server":"own"\|"cloud","room","expiresAt"}` or `503 call_starting` (below) |

`phase`: `ready` (the own server answers), `waking` (a redeploy was asked, up to 8 min), `parked` (the gateway stopped
it), `down` (it does not answer and nobody parked it).

Token body: `{"app":"parle","room","identity","name"?,"metadata"?,"canPublish"?:true,"canSubscribe"?:true,"ttlSeconds"?:1800,"reserve"?:"allow"|"deny"}`
(`room`/`identity` 1–128 chars of `[A-Za-z0-9_.:@-]`, `ttlSeconds` 60–14400, `metadata` ≤ 4096 chars). Who may ask:
an admin key, the `parle` app key, or a dev key. The LiveKit keys never leave the gateway.

1. Own server answers → token of the own server (the idle clock is renewed).
2. Otherwise the gateway asks for a wake and, when `reserve` is `allow` (default, «always answers»), the Cloud is
   configured and its monthly ceiling is not reached, answers with a Cloud token (`server: "cloud"`).
3. Otherwise `503 {"error":{"type":"call_starting","message","retryAfterMs":5000,"phase"}}` with `Retry-After`.

A dev key never wakes the servers and never gets the Cloud (tests, palco and tools never use the paid Cloud).

## Idle, class window, who switches

- Every minute the gateway lists the own rooms and active egress. Participants or an active egress renew the clock.
  After `idleMinutes` (15) with nobody, outside the class window, it stops both services. A restart of the gateway
  gives the clock a full period again.
- The class window is the `warmSchedule` of the parle declared deployments (`parle-speech`: Mon–Thu 16:40–20:30
  Europe/Paris): inside it the servers are never parked and, when they do not answer, they are redeployed.
- Only the production gateway switches (rule 6: on Railway, or `AIGW_REAL_MACHINES=1`), with `RAILWAY_API_TOKEN`.
  Elsewhere the routes work (probe and tokens) and `park` answers `409 no_power`.
- Every transition goes to the deployments log (`calls.wake`, `calls.ready` with `wakeMs`, `calls.park` with the reason,
  `calls.cloud`, `calls.wake_failed`, `calls.railway.stop`/`.redeploy`), the same sink as the deployment events.

## Railway: how it stops and starts

- **Stop:** `deploymentStop(id)` on each running deployment of `livekit-egress`, then `livekit`. The image stays in the
  deployment history.
- **Start:** for a service whose newest deployment is not running, `deploymentRedeploy(id, usePreviousImageTag: true)`
  on the newest deployment that has an `imageDigest` (the last built image): no rebuild, and the container runs the
  entrypoint again, so the TCP proxy port and IP are read again (`deploy/livekit-railway/server/entrypoint.sh` in the
  parle repo). A service already running is never redeployed (a redeploy would drop the calls in it).
- Ids: the project is `LIVEKIT_RAILWAY_PROJECT_ID`, else the gateway's own `RAILWAY_PROJECT_ID` (the gateway runs in
  `parle-game`); environment and services are found by name (`src/calls/parle.json`).
- While Railway refuses deploys (incident of 21/10/2026: «deploys have been paused»), a wake fails (`calls.wake_failed`)
  and the Cloud reserve answers; parking in that state leaves calls on the Cloud until Railway deploys again.

## Configuration (gateway variables, never code)

`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (own; without them the module is off) ·
`LIVEKIT_RESERVE_URL/API_KEY/API_SECRET` (Cloud, optional) · `LIVEKIT_CLOUD_BUDGET_MINUTES` (default 420
participant-minutes a month, counted from the Cloud rooms while Cloud tokens are live; state in `calls.json` next to the
other state files) · `RAILWAY_API_TOKEN` (+ optional `LIVEKIT_RAILWAY_PROJECT_ID`).

## SDK

```ts
import { GatewayClient } from '@parle/ai-gateway/client';
const gw = new GatewayClient({ baseUrl, apiKey });       // server side: the app backend
await gw.calls.health();
await gw.calls.wake({ app: 'parle' });
const join = await gw.calls.token({ app: 'parle', room: 'pair-12', identity: 'student-3' });

import { joinCall } from '@parle/ai-gateway/calls';      // browser: gets only { url, token } from the app backend
const room = await joinCall(join, { microphone: true, camera: true });
```

## Load tool

`bun --env-file=<.env with LIVEKIT_*> scripts/calls-load.ts --steps 5,10,20,40 --hold 30 --procs 4 [--out r.json]`:
N pairs per step, each in a room `load-<run>-<N>-<i>`, both publishing 48 kHz audio and 320×240 I420 video at 15 fps
(`@livekit/rtc-node`), spread over `--procs` processes. Per step: peers connected, connect p50/p95/max, video fps
received in each direction, audio frames/s, the most participants the server listed at once, and the rooms removed.
Every connect/publish/disconnect has a timeout and the `load-<run>-*` rooms are deleted at the end (and on Ctrl-C).
Inside a class window run it with at most 10 pairs against production.

## Tests

`__tests__/unit/calls/calls.test.ts`: token own / Cloud / 503, Cloud ceiling, dev key, 15-min idle park, egress keeps
it up, class window, wake idempotence, park refusals, Railway stop/redeploy selection.
