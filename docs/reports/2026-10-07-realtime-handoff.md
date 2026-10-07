# Handoff — realtime (WebRTC → WS → s2s-stream → POST), edge sidecar, telemetry — 2026-10-07

Branch `claude/gallant-keller-54sdt9` (built as `realtime-integration`): the three branches `telemetry`,
`realtime-control` and `realtime-edge` merged on top of `main` (`dead-code` was already in `main`, `f3d774e`), then
fixed and proven end to end on one machine. **Not deployed, not run on a GPU.** The PR still has to be opened.

## What is in it

| Area | Where | State |
|---|---|---|
| Unified telemetry (browser, gateway, edge, model; W3C `traceparent`; scrubber; JSONL store; `/v1/telemetry/*`) | `src/telemetry/`, `sdk/browser/telemetry/`, `docker/aigw-edge/telemetry.py` | merged; realtime events now wired to the store (`serve.ts`) |
| Realtime control plane (admission, session token, signaling relay, WS relay, TURN creds, load report) | `src/realtime/`, `sdk/browser/realtime/` | merged; `maxHeaderSize` 32 KB on the proxy (WS token ~8.3 KB in the URL) |
| Edge sidecar (aiortc + aiohttp, WebRTC + WS, VAD, STT/LLM/TTS streaming, barge-in, limits), cloud-init, coturn profile | `docker/aigw-edge/`, `src/deployments/cloud-init.ts` | merged |
| **Reachability** (new, owner's request): the edge checks its path instead of assuming a public UDP port | `docker/aigw-edge/aigw_edge/netcheck.py`, `src/realtime/net-probe.ts`, `docs/realtime-edge.md` § Reachability | new, proven locally |
| Local end-to-end test | `scripts/realtime-e2e/` | new, 28/28 |

### Reachability — fastest path first, every decision logged

1. **direct** — the gateway sends a UDP echo to the edge's probe port (last port of `RT_UDP_PORTS`); a reply means a
   browser's UDP gets in.
2. **relay** — inbound UDP blocked: the edge allocates on the TURN server **outbound** (UDP, then TCP, then TLS) and
   offers a relay candidate, so WebRTC works with no inbound port open.
3. **ws** — neither: the edge stops listing `webrtc`; admission sends the learner straight to the WebSocket through the
   gateway (the reverse-proxy path, slowest, kept last) — no ~5 s lost on a doomed ICE attempt.

Logs: `rt.net.probe` (gateway, per replica), `edge.net.relay_try`, `edge.net.path` (with the reasons, e.g.
`inbound udp/50140: blocked | relay turn:…?transport=udp: allocated (3 ms)`), and per session `rt.ice.selected` /
`edge.ice.selected` (host or relay on each side, protocol, RTT). Status: `GET /__aigw/rt/status` → `net`.

## Bugs found by the local e2e (unit tests were green on all of them)

1. **WS rung refused after WebRTC** — the SDK tries WebRTC then WS with the one token of its admission; the edge
   treated the second use as a replay (4401). Every learner on a UDP-blocking network would have skipped WS and fallen
   to s2s-stream. Fix: `sid` single use **per transport**; a new session of the same sid supersedes the previous one
   (`token.py`, `server.py`, test in `tests/test_units.py`). Not fixed in the SDK on purpose: a second admission
   would charge the app's budget twice and hold an abandoned slot for 20 s.
2. **Realtime events never reached the telemetry store** — `serve.ts` passed no sink to `createRealtime` (TODO left
   for after both PRs). Now `realtimeSinkToTelemetry` + `sessionResolverFrom`.
3. `realtime-edge.test.ts` assumed the speech-stack default was the L4; `main` moved it to the L40S (16 sessions).

## Proof (this machine, no GPU)

`EDGE_PYTHON=<venv>/bin/python bun scripts/realtime-e2e/e2e.ts` — real gateway (proxy + controller + realtime +
telemetry wired like `serve.ts`), replicas of real nginx front + real edge + fake model, real coturn, iptables for
firewalls, Chromium with the browser SDK. Needs root (iptables), `nginx`, `turnserver`, Bun **≥ 1.4.2** (1.3.x does
not deliver writes on an upgraded `node:http` socket: the WS relay never answers 101 — production pins 1.4.2).

| Check | Result |
|---|---|
| admission: 401 no key, 403 other app, 200 with 4 transports | ok |
| WebRTC turn through gateway signaling, NPC audio measured in the page, one trace browser+gateway+edge | connect 2.2 s, first audio 241 ms (edge) / 333 ms (browser) |
| browser UDP blocked → WS through the gateway relay | ok, full turn |
| edge killed mid-session → s2s-stream, history kept | ok |
| capacity → 503 saturated + Retry-After + fallback; cold + no-wake; wake | ok |
| GPU inbound UDP dropped → relay via TURN | connect 2.3 s, first audio 242 ms, edge pair = relay |
| no UDP and no TURN → ws only | connect **0.13 s** (no WebRTC attempt) |

Also green: edge `tests/test_units.py` (25) and `tests/harness.py`; vitest `__tests__/unit/{realtime,telemetry,stt-filter}`
+ `deployments/realtime-edge` (182); `tsc`. The full suite on the merge had 3 failures before the fixes: 2 were real-API
integration tests that also fail on `main` (`fallback-integration`, `load-balancer-integration`), 1 was item 3 above.

## Not done / next

1. ~~**Build and push the `aigw-edge` image**~~ — **done (2026-10-07, Devin)**. New workflow
   `.github/workflows/aigw-edge.yml` (pinned SHAs, PR + dispatch triggers) built and pushed
   `ghcr.io/marcosremar/aigw-edge:8c774c6e` to GHCR; `DEFAULT_EDGE_IMAGE` points at it and
   `parle-speech.json` now declares `"realtime": {}`. gitleaks allowance added for the e2e's
   hardcoded `TURN_SECRET` test literal.
2. ~~Open the PR~~ — **PR #54** (https://github.com/marcosremar/ai-gateway/pull/54), not merged.
   Full suite on the merge head: only the two known pre-existing failures —
   `fallback-integration` (real API 401) and `load-balancer-integration` (missing GROQ_KEY),
   listed in the PR body. Typecheck clean.
3. GPU test (docs/realtime.md § End-to-end test plan): real models, public IP, Scaleway security group, TURN over
   TLS/443, barge-in, CPU per session at 16 sessions on the L40S. **Partly done — see the GPU test table below.**
4. ~~Admission should refuse a session config without `voice`~~ — **done** (`src/realtime/service.ts`,
   400 `invalid_request`; tests in `admission.test.ts` + e2e check; `relay.test.ts` fixture got a voice).
5. ~~`Request killed by total timeout`~~ — **fixed** (see below).
6. The local e2e is not in CI (needs root, nginx, coturn, Chromium); run it by hand before touching the realtime path.
   Latest local run (Linux VM, Bun 1.4.2): **29/29** — the 28 baseline + the new `config without voice → 400` check.

## Update — 2026-10-07 (Devin)

- Suite/typecheck on the merge head: clean except the two baseline real-API failures (above).
- Local e2e re-run after the `voice` admission change: 29/29. One flake seen once — an edge process bound to
  `127.0.0.1:37988` from a previous run wasn't reaped in time; re-run was green. Also note: `apt install coturn`
  enables a system `coturn.service` that keeps :3478 alive and silently breaks the "TURN unreachable" scenario —
  `systemctl disable --now coturn` before running.
- **`Request killed by total timeout` (task 6): cosmetic, WS relay safe.** `server.setTimeout(60000)`
  (`src/gateway/proxy/server.ts:929`) is a *socket idle* timeout, not a request timeout. When a response finishes on
  a keep-alive connection, Bun replaces the timer with `keepAliveTimeout(5s)+buffer(1s)` = 6 s; the callback then
  logs the env value (60s) and destroys the socket — ordinary keep-alive GC. Verified empirically under Bun 1.4.2:
  fires at finish+6000ms regardless of the configured value. For a stalled in-flight request it still destroys the
  socket as intended. **Upgraded WS sockets are exempt** — `ws-relay.ts:93` calls `socket.setTimeout(0)`, and Bun's
  upgrade path detaches the timeout listener anyway (verified: upgraded socket survived 12 s under a 2 s
  `server.setTimeout`). A 10-minute relay session is not affected. The warning is only misleading: it cannot tell
  keep-alive expiry from a stuck request. **Fixed** (`05eef06`): the callback only warns when
  `socket._httpMessage` is set (a response in flight; verified truthy/falsy under Bun 1.4.2 and Node) and destroys the
  socket in both cases. Regression test: `__tests__/unit/gateway-routing/proxy-keepalive-timeout.test.ts`.
- **Superproject pin caveat**: babylon-cinema's branch `claude/gallant-keller-54sdt9` (commit `ad66409099`) pins
  `vendor/ai-gateway` to `09a879a8`, which is not on the ai-gateway remote. When this PR merges, bump the gitlink to
  the merge commit on `main`, never to a branch SHA.

### GPU test — 2026-10-07 (Scaleway, through the gateway API only; every machine deleted afterwards)

L40S-1-48G was out of stock in fr-par-2 on every create, so all runs are on the **L4-1-24G** fallback
(`RT_MAX_SESSIONS=8`). The declared `ghcr.io/marcosremar/parle-speech` image could not be used (see below); the runs
used the same stack from `rg.fr-par.scw.cloud/aigw/speech-stack:20261004-2240`. TTS used a cloned voice from a remote
reference clip (the catalog voice `default` does not exist on the replica; a base64 clip exceeds the data-channel
message size).

| Scenario | Result | Connect ms | First audio ms | Path seen in telemetry |
|---|---|---|---|---|
| Direct WebRTC | pass | 2383–2642 | 3495 edge / 3603–4004 browser | `rt.net.probe` direct; browser pair host, udp |
| Barge-in | pass | – | `audio_start` → `interrupted` in 50 | – |
| Capacity (L4) | pass | – | – | 8 admitted, 9th → 503 `saturated` + Retry-After |
| Relay, browser relay-only, TURN udp/3478 | pass | 4561 | 1714 browser | browser pair relay, relayProtocol udp |
| Relay, browser relay-only, TURN tcp/443 | pass | 4411 | 1225 edge / 2036 browser | browser pair relay, relayProtocol tcp |
| Relay forced by a real inbound-UDP block on the replica | **not proven** | – | – | with only the gateway probe faked (`REALTIME_PROBE_UDP=blocked`) the edge allocated on TURN but still offered host candidates and ICE went direct; a real block needs a security-group change the gateway API does not expose |
| `edge.net.path` / `edge.ice.selected` from a real GPU | **not proven** | – | – | the replica cannot reach a gateway on localhost and no tunnel could be opened from the test network; proven only in the local e2e |
| 16 sessions + CPU per session on the L40S | **not run** | – | – | L40S out of stock |
| TURN over TLS (`turns:`) on 443 | **not run** | – | – | needs a domain with a trusted certificate on the coturn box |

Findings:

- **The coturn profile boots fine** (ready in 120 s, unmodified). The four boot timeouts were the test network
  dropping outbound TCP to non-standard ports (8089, 3478, 9641), so the local gateway's readiness probe on
  `PROBE_PORT` never got through. `DEPLOYMENTS_PROBE_PORT` now overrides the port (default 8089 unchanged).
- **`parle-speech` image**: the declaration pointed at the private `ghcr.io/marcosremar/parle-speech` with
  `GHCR_READ_TOKEN`, a token that exists nowhere, so it stayed `pending — keeping the registered spec` and nothing it
  declared (`realtime` included) reached production. It now points at what production runs,
  `rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107`, pulled with the gateway's own Scaleway key: no token, no
  `registryAuth`, never pending for a credential. The reconcile patches only the image, `realtime: {}` and
  `RT_MAX_SESSIONS` per machine type (merged into the stored `envByMachineType`) over the registered spec; env, files,
  sizing and limits stay as registered (`docs/deployments.md` § `parle-speech`). Not run against a live gateway.
- **Restarting the gateway parks a `minReplicas: 0` replica** right after "replica ready"; with the GPU out of stock
  the wake then fails and the halted replica blocks a new create.
- `error: upstream` after `audio_start` appeared in two of four live turns while the audio still played. Not
  investigated.
- Local e2e after the timeout fix and the probe-port change: **29/29** (Linux VM, Bun 1.4.2).
- `scripts/realtime-e2e/e2e-live.ts` + `page-live.js` drive a real gateway and real Chrome for the scenarios above;
  `serve.ts` gained two test knobs (`REALTIME_NET_RECHECK_MS`, `REALTIME_PROBE_UDP=blocked`).
- Worth a look in the Scaleway console: reserved IPs and security groups named `aigw-marcos-rt-*` left by the TURN
  boxes; the gateway API cannot list them.

### GPU test, round 2 — 2026-10-07 (L4-1-24G fr-par-2, `speech-stack:20261004-2240`; every machine deleted)

- **Truncated replies, `error: upstream` after `audio_start`: 10 of 18 live turns.** The first sentence plays, the rest
  is lost, the turn ends in error. The edge reports an aiohttp `ClientPayloadError` on the `/v1/audio/speech` stream
  (`docker/aigw-edge/aigw_edge/session.py:250-256`); same on direct WebRTC, relay and WS, so the gateway is not
  involved. Straight at the stack: sequential TTS requests complete, two in parallel leave one stalled, repeated pairs
  wedge the TTS for about 2 minutes. The edge synthesizes the next sentence while the current one streams
  (`EDGE_TTS_PARALLEL` 2). The stack's own `/v1/s2s` also runs 2 in parallel and swallows a failed synth task
  (`docker/speech-stack/server.py:337-341`), so the old path may return shortened audio silently — not verified.
  Open; being investigated on the production image (`20261006-0107`).
- **Relay with a real inbound-UDP block: pass.** Security group without the UDP range, no probe fake:
  `rt.net.probe` blocked → path relay; 3 of 3 browser turns connected on WebRTC without forcing relay (connect
  2611–3933 ms, first audio at the edge 1045–1202 ms warm). The selected pair was the browser's TURN allocation to the
  edge's host candidate, not the edge's own relay candidate.
- **Adding `realtime` to an existing exposed deployment never opens UDP 50000–50100**: the security group is created
  once and reused by id (`src/deployments/scaleway-backend.ts:205-214`).
- **First audio, same replica, one warm-up discarded, 5 turns each** (clock: edge's end-of-speech decision → first
  audio; the 700 ms endpointing silence is not counted):

  | Transport | At the edge, median (min–max) ms | Audible in the browser ms |
  |---|---|---|
  | WebRTC direct | 1015 (810–1195) | 1725 (1242–2198) |
  | WS via gateway | 899 (885–1234) | not measurable by the harness |
  | HTTP `/v1/s2s` (clock starts at the request with the finished clip) | 999 (918–1234) | not measured |

  Stages on completed turns: STT 365–521, LLM first token 72–201, TTS first chunk 210–218. The transport does not move
  the first audio; the models and the endpointing do.
- **L40S**: out of stock again; the L4 quota is 2 per organisation.
- **Network leftovers**: none. `scripts/reap-orphans.ts` (dry run) found nothing for today's deployments. DELETE
  releases the IP and the group, but not awaited (`controller.ts:102-106`): a gateway stopped within ~16 s of a DELETE
  leaks them until the reaper runs.
- Still not proven: `edge.net.path` / `edge.ice.selected` from a real GPU, 16 sessions on the L40S, `turns:` over TLS.
- Local e2e on the PR head after the CodeQL fixes and the declaration change: **29/29**.

## Live capacity, night of 2026-10-07

One replica, **L40S-1-48G, fr-par-2, €1.4699/h** (the first placement had stock), image
`rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107`, edge `ghcr.io/marcosremar/aigw-edge:ea107bd`, through a local
gateway (`bun serve.ts`, namespace `marcos-cap`, `DEPLOYMENTS_PROBE_PORT=8080`). Machine up 20:30:40–21:36:40 and
21:36:55–21:43:50 Europe/Paris: 73 min, about €1.79. Everything deleted afterwards (`health`: running 0, stopped 0, no
`pendingNetworkReleases`).

Spec: profile `speech-stack`, `maxReplicas: 1`, `maxHours: 2`, `maxEurPerHour: 1.6`, placements L4-1-24G fr-par-2 and
fr-par-1, `realtime: { maxSessions: 128, env: { RT_RTC_WORKERS: "6" } }` — **the session cap was raised from the
profile's 16 so the runs find the latency limit, not the admission limit**; the 6 edge workers are what a cap of 32
would give. One catalog voice (`voices.json` + a 7.5 s reference made with macOS `say`), a 278-word Portuguese
shop-clerk system prompt, a 3.3 s voiced Portuguese utterance as the clip (`say`, PCM16 mono 16 kHz).

Clock of every latency: last voiced sample sent → first non-silent audio received (the edge's 700 ms endpointing is
inside). Target: p50 ≤ 1500, p95 ≤ 2000, failures + truncations ≤ 1 %. No run was marked `SATURATED`.

### Capacity of the one replica, clean network, `ws` clients from the Mac

`bun scripts/realtime-e2e/load.ts --n <N> --clip turn.wav --profile clean` (180 s per student + 30 s ramp, a turn every
15 ± 5 s; rows marked 120 s add `--duration 120`), in the order they ran:

| Start | N | Turns ok / attempted | First audio p50 / p95 / max ms | ≤ 1.0 / 1.5 / 2.0 s % | Edge after endpointing p50 / p95: ttfa · stt · llm first token · tts | Result |
|---|---|---|---|---|---|---|
| 20:44:45 | 4 | 43 / 43 | 1305 / 1690 / 1959 | 2.3 / 81.4 / 100 | 319/702 · 265/495 · 260/658 · 92/148 | PASS |
| 20:48:14 | 8 | 82 / 82 | 1440 / 1944 / 2548 | 1.2 / 57.3 / 95.1 | 461/1010 · 270/503 · 310/869 · 94/168 | PASS (4.9 % of turns over 2 s) |
| 20:51:54 | 12 | 120 / 120 | 1911 / 3003 / 4047 | 0 / 12.5 / 55 | 773/1551 · 438/701 · 447/1239 · 116/219 | FAIL |
| 20:55:31 | 16 | 159 / 159 | 2266 / 3597 / 4773 | 0.6 / 6.9 / 30.8 | 1216/2419 · 515/748 · 598/1661 · 152/289 | FAIL |
| 20:59:17 | 24 (120 s) | 143 / 144 | 3560 / 5158 / 8605 | 0.7 / 5.6 / 10.4 | 2485/4093 · 533/908 · 1255/2249 · 193/374 | FAIL, 1 truncated (`error: upstream` after audio) |
| 21:01:46 | 32 (120 s) | 186 / 186 | 4233 / 6350 / 7933 | 0 / 2.7 / 7 | 2968/5274 · 561/1136 · 1441/3387 · 233/618 | FAIL |
| 21:04:28 | 10 | 97 / 97 | 2298 / 6198 / 7374 | 1 / 14.4 / 35.1 | 1331/5171 · 330/578 · 767/4657 · 127/208 | FAIL |
| 21:10:22 | 8 again | 83 / 83 | 1858 / 2973 / 3537 | 0 / 16.9 / 66.3 | 828/1771 · 355/544 · 531/1695 · 96/197 | FAIL |
| 21:14:16 | 4 again (120 s) | 27 / 27 | 1889 / 3578 / 3837 | 0 / 14.8 / 66.7 | 838/2680 · 268/497 · 802/2501 · 94/166 | FAIL |
| 21:40:16 | 4, after park + resume (70 s, ramp 10) | 14 / 14 | 1289 / 1800 / 1800 | 0 / 64.3 / 100 | 285/831 · 283/798 · 223/440 · 96/141 | PASS |

- **N_pass = 8 on a fresh replica**; p95 crosses 2 s between 8 and 12. "Never above 2 s" holds only at N = 4.
- **The replica gets slower with use.** The same N = 8 and N = 4 that passed at 20:44–20:52 failed at 21:10–21:17, after
  25 min of load that included the overloaded runs; the stage that moved is the LLM's first token (N = 4: 260 → 802 ms
  p50) while STT and TTS stayed. A power-off and resume brought N = 4 back (223 ms). Not investigated: whether steady
  N = 8 alone degrades it, or only overload does. Until that is known N_pass = 8 is an upper bound, and the rows from
  N = 12 on carry some of this drift.
- No admission refusal in any run (cap 128). At the profile's cap of 16 the replica would admit twice what it serves
  inside the target: the cap is not what protects latency on the L40S.
- **Burst** (21:07:55, `--n 8 --burst --jitter 0 --turn-every 20 --ramp 5 --duration 120`, 8 students ending their
  speech within 21 ms): the first burst waited 16.7–17.5 s for all 8 (LLM first token ~15 s); the four later bursts
  (spread 5–7 s by then) p50 2649, p95 3374 ms. 39 / 40 ok, 1 truncated. Run on the already degraded replica.
- **100 students, beyond capacity** (21:31:40, `--n 100 --duration 90`): all 100 admitted, no refusal; 17 / 415 turns
  ok, p50 24.5 s, p95 28.0 s; 295 turns `failed:interrupted` (the student's next utterance cancels a reply that has not
  started) and 99 `truncated:no_done_after_audio`. The failure shape is latency collapse, not refusals; the replica
  stayed `ready` and was not replaced.

### Degraded network, 8 sessions, from a 6-vCPU Linux VM behind the Mac's NAT

`bun scripts/realtime-e2e/load.ts --n 5 --rtc 3 --chrome 3 --clip turn.wav --profile <p> --duration 120 --ramp 15`
(2 `ws`, 3 aiortc, 3 Chrome forced on `webrtc`, `ws`, `s2s-stream`). All four ran on the degraded replica (edge LLM
first token p50 558–1236 ms), so every row FAILs the target and only the differences between rows of this table mean
anything. `campus-slow` (2 Mbit/s down, 512 kbit/s up, 40 ± 10 ms, 1 % loss) and `lossy` (75 ms, 5 %) are assumptions.

| Start | Profile | Lightweight first audio p50 / p95 ms (n): ws · webrtc | Chrome audible p50 / p95 ms: webrtc · ws · s2s-stream | Transport each client ended on, connect ms, time lost in failed rungs |
|---|---|---|---|---|
| 21:20:17 | clean | 2013 / 2672 (13) · 2407 / 3474 (20) | 2353 / 4383 · 2499 / 4545 · 2495 / 2741 | aiortc 3 of 3 webrtc (host/host, UDP direct; 755–987); ws 117–135; Chrome webrtc 461, ws 146; nothing lost |
| 21:23:11 | campus-slow | 2193 / 4136 (26) · 2777 / 3821 (7) | 2563 / 3543 · 2659 / 3679 · 5168 / 6277 | aiortc 1 webrtc (2256), 2 fell to ws after 3.5 and 3.9 s of failed connect (3921, 4483 total); ws 465–515; Chrome webrtc 1517, ws 483 |
| 21:26:00 | udp-blocked | 1900 / 3733 (30) · — | — · 2033 / 2752 · 2227 / 3842 | aiortc 3 of 3 on ws after 2.0–2.3 s of failed gathering (2246–2413 total); ws 173–345; Chrome forced on webrtc never connected (4960 ms, no fallback when forced) |
| 21:28:58 | lossy | 3313 / 7952 (19) · 3887 / 8089 (13) | 3727 / 7237 · 3736 / 7225 · 4872 / 7763 | aiortc 2 webrtc (3211, 4715), 1 on ws after 4.2 s (6454 total); ws 666–1623; Chrome webrtc 5811, ws 4305 |

- WebRTC from this network went direct over UDP (`host/host`); this gateway had no TURN server, so `udp-blocked`
  means the WS rung, never TURN over TCP.
- `s2s-stream` suffers most on the slow uplink (the whole clip is uploaded after the speech): +2.7 s on `campus-slow`.
- The lightweight clients had no failed or truncated turn in these four runs. The Chrome `ws` / `webrtc` sessions show
  5–8 `interrupted` turns each: Chrome's fake microphone repeats the clip every 15 s whatever the reply does, and with
  first audio at 2.5 s plus a reply of several seconds the next utterance barges in. It is the harness's loop, not a
  network effect; the lightweight clients wait for `done`.

### Lifecycle (L40S-1-48G fr-par-2, €1.4699/h)

| Phase | Clock | Duration | € |
|---|---|---|---|
| Cold: first admission (`503 cold`, `Retry-After: 30`, fallback `s2s-stream` → `/v1/s2s`) wakes the deployment → machine listed | 20:30:37 → 20:30:47 | ≤ 10 s | |
| → provider `running` | 20:31:03 | 26 s | |
| → front answering | not measured (the watcher polled :8080; the front of a realtime replica is on :80); ≤ 20:42:30 | | |
| → `ready` (image pulled + models warm) | 20:44:14 | 13 min 37 s from the first admission | 0.33 |
| First session admitted (admission retried every 10 s, 82 × `503 cold`) | 20:44:23 | 13 min 46 s | |
| `idleAction: "stop"`, `idleMinutes: 2`: last session ended → parking | 21:33:40 → 21:35:50 | 130 s | 0.05 |
| → `stopping` listed → `stopped` (`eurPerHour` 0) | 21:36:16 → 21:36:40 | 50 s after parking, 180 s after the last session | 0.02 |
| `POST …/wake` (202) → provider `running` → front answering → `ready` | 21:36:52 → 21:37:20 → 21:37:34 → 21:39:55 | 28 s · 42 s · **183 s** | 0.07 |
| First session admitted after the wake (`503 cold` meanwhile) | 21:40:03 | 191 s | |
| `idleAction: "delete"`: last session ended → released, server and SBS volume deleted | 21:41:39 → 21:43:50 → 21:44:03 | 131 s · 144 s | 0.05 |

The image pull and the model load are not split: nothing in the deployment view tells them apart (`stagesOut` stayed
empty for the whole boot). The resume is 3 min, not 2: 42 s to the front, then 141 s of model load.

### What 100 students need

From N_pass = 8 per L40S (fresh replica, default duty cycle): `ceil(100 / 8)` = **13 replicas, €19.1/h**; holding
"never above 2 s" (N = 4) it is 25 replicas, €36.7/h. A 100-student burst is not derivable: 8 simultaneous turns
already took 17 s on this replica. The L4 was not measured (the L40S had stock). What blocks it today: the per-replica
cap of 16 admits twice N_pass; `maxReplicas` 2 in the profile and the declaration; `DEPLOYMENTS_MAX_REPLICAS` 6 and
`DEPLOYMENTS_MAX_EUR_PER_HOUR` 6 (four L40S); L40S stock (none this morning) and the L4 quota of 2; a 13 min 37 s cold
boot during which every student gets `503 cold`; and the slowdown above, which a restart clears.

### Harness fixes

- `page-load.js`: with real speech the page counted every loud span of the microphone as a turn (51 "turns" for 9
  utterances, 75 false timeouts in the discarded first VM run); spans closer than the endpointing silence are now one
  turn.
- `load.ts`, `load-client.ts`: `--burst` (every student speaks at the same instants, first at ramp + 10 s; use with
  `--jitter 0`).

Proven against the real gateway without change: the NAT path under load, the `GET /v1/deployments/<name>` parsing and
the cost line.

Not run: the L4; `flap`; a second cold boot; the admission limit at the profile's cap; TURN.
