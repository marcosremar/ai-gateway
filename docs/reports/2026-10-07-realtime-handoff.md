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

## Live A/B, night of 2026-10-07

Two replicas, one at a time, both **L40S-1-48G, fr-par-2, €1.4699/h**, image
`rg.fr-par.scw.cloud/aigw/speech-stack:20261006-0107`, edge `ghcr.io/marcosremar/aigw-edge:ea107bd`
(`realtime: { maxSessions: 128, env: { RT_RTC_WORKERS: "6" } }`, as the capacity run), local gateway on :4101, namespace
`marcos-ab`. Machine 1 21:49:32–22:39:18 Europe/Paris (ready after 10 min 13 s; edge default `EDGE_SPECULATE_MS=300`),
machine 2 22:39:26–23:02:30 (ready after 9 min; `EDGE_SPECULATE_MS=0`, this commit's `start.sh`). 73 machine-minutes, about €1.80. A first create at 21:48:49
was deleted 35 s later to change the edge settings. From 20:32 to 21:38 every create was refused, `403 quotas_exceeded`
(L40S 2 of 2 and L4 2 of 2 in use by others). Everything deleted afterwards.

Stack code and flags were switched on the running machine: the deployment's entrypoint was a test supervisor shipped
through `files` that holds the image's code, `7d041e1` (arm A) and this branch (arm B) side by side; a restart of the
orchestrator alone is warm in 6–16 s, of `llama-server` alone in 2.1 s, of the whole stack in 4 min 5 s (the TTS load).
One catalog voice (6.9 s reference, macOS `say`), a 329-word Portuguese shop-clerk system prompt (487 tokens), a 4.5 s
Portuguese utterance (`say`, PCM16 mono 16 kHz).

### The LLM first-token drift is llama.cpp's host-RAM prompt cache

llama.cpp b11382 defaults to `--cache-ram 8192` with `--cache-idle-slots`: on every new task the server saves idle slots
to a prompt cache in host RAM. The cache fills with use; once it is at its limit every task first evicts the oldest
entry (`srv alloc: making room for prompt cache entry, removing oldest entry`) and the task waits for that before its
prompt is evaluated. The state lives in the process, so only a restart clears it.

`bun scripts/realtime-e2e/load.ts --n <N> --clip <wav> --profile clean --duration <120|180>` (`ws` clients from the Mac,
30 s ramp, a turn every 15 ± 5 s), same machine, in this order. Clock: last voiced sample sent → first non-silent
audio received (the edge's 700 ms endpointing is inside). Edge stages are after its endpointing. "Wait" is, per llama
task, launch → timings minus (prompt eval + generation), from `llm.log`.

| llama flags | Phase | Turns ok | First audio p50 / p95 ms | Edge p50: stt · llm first token · tts | llama `prompt_n` p50 | Wait p50 / p90 / max ms | Evictions | `llama-server` RSS after |
|---|---|---|---|---|---|---|---|---|
| default | N = 4, fresh, 120 s | 28 / 28 | 1146 / 1858 | 209 · 144 · 93 | 194 | 0 / 167 / 199 | 0 | 1.1 GB at start |
| default | N = 16, 180 s | 177 / 177 | 2065 / 3408 | 404 · 604 · 147 | 163 | not kept | 119 | 12.7 GB |
| default | N = 4 again, 120 s | 29 / 29 | 1416 / 1819 | 209 · 394 · 96 | 58 | 202 / 590 / 807 | 31 in 29 tasks | 12.4 GB |
| `--cache-ram 0` (LLM restarted, 2.1 s) | N = 4, 120 s | 29 / 29 | 1028 / 1487 | 208 · 138 · 93 | 169 | 0 / 0 / 0 | 0 | |
| `--cache-ram 0` | N = 16, 180 s | 175 / 175 | 1678 / 2646 | 416 · 305 · 114 | 266 | 0 / 0 / 93 | 0 | |
| `--cache-ram 0` | N = 4 again, 120 s | 30 / 30 | 1018 / 1251 | 208 · 136 · 93 | 72 | 0 / 0 / 0 | 0 | 2.9 GB |
| `--cache-ram 0` + one slot per session | N = 4, 120 s | 28 / 28 | 1120 / 1623 | 210 · 128 · 96 | 59 | 0 / 0 / 0 | 0 | |
| `--cache-ram 0` + one slot per session | N = 16, 180 s | 171 / 171 | 1974 / 3312 | 447 · 414 · 124 | 56 | 0 / 38 / 118 | 0 | |

- Reproduced in 3 minutes of N = 16: the same N = 4 went from 144 to 394 ms of LLM first token (first audio p50 1146 →
  1416) with STT and TTS unchanged, and the prompt the LLM had to read got smaller, not larger (194 → 58 tokens): the
  time is the wait before the prompt, not the prompt.
- With `--cache-ram 0` there is no drift (138 → 136 ms) and the loaded run is faster too (N = 16 first audio p50 2065 →
  1678, p95 3408 → 2646). **`start.sh` now passes `--cache-ram 0`.**
- Machine 2 booted with this commit's `start.sh` (`ps`: `--cache-ram 0`): after N = 16 for 180 s (171 / 171 ok, LLM
  first token 314 ms), N = 4 had 135 ms of LLM first token, wait 0 / 0 / 0, RSS 3.9 GB. Its first-audio numbers
  (2064 and 1398 ms p50) are not comparable with the rows above: that edge ran without speculation.
- Restarting only `llama-server` takes 2.1 s and restores the first-token time: an operational mitigation for a
  replica on the old image (its `start.sh` has no `LLM_EXTRA_ARGS`; the flag reaches it through `files` or a rebuild).
- Not the cause: GPU memory (27.9 GB before and after), temperature (41 → 52 °C), throttle reasons (`0x0`), clock
  (2520 MHz), growing context (`n_tokens` ≤ 1101 of 2048, no truncation), leaked generations (below).
- **Slots are shared between sessions.** Every session has the same system prompt, so a new session's first prompt
  matches any used slot better than an empty one (`selected slot by LCP similarity`, `f_sim_best` 1.0): 16 sessions
  ran on 6–8 of the 16 slots, and 62–75 % of turns re-read more than 100 prompt tokens (the other session's history).
  Pinning one slot per session (`id_slot` from the edge's trace id, test shim only) cut `prompt_n` to 56 and used all
  16 slots, but N = 16 was slower (LLM first token 305 → 414 ms, generation 45 → 96 ms per token): not adopted, cause
  not investigated.
- A discarded speculation does not leak: on a clip with a 450 ms pause (6 turns, `ws`) the stack decoded 12 clips
  (the discarded STT runs to its end) and llama.cpp logged `stop: cancel task` for 5 of 11 tasks, all 11 released.

### TTS chunk cadence

Straight at the stack, `/v1/audio/speech` through the gateway invoke route, streamed PCM, one two-sentence line (7.5 s of
audio). Clock: request sent → event, at the Mac. "300 ms continuous" is a player that starts on the first byte and
never stalls more than 60 ms; "voiced onset" is when that player reaches the first 20 ms window with RMS > 200.
Median (min–max).

| Arm | Parallel | n | First byte ms | 300 ms continuous ms | Longest stall in 2 s ms | Voiced onset ms | Total ms | Audio ms |
|---|---|---|---|---|---|---|---|---|
| default (`initial_codec_chunk_frames: 1`) | 1 | 10 | 152 (107–188) | 660 (540–686) | 126 (53–161) | 521 (248–801) | 936 (889–1044) | 7560 (7200–8240) |
| default | 4 | 12 | 224 (221–404) | 802 (747–1043) | 192 (145–259) | 610 (281–841) | 1262 (1128–1365) | 7240 (6880–7840) |
| default | 8 | 16 | 393 (208–444) | 928 (794–984) | 178 (109–252) | 770 (494–1059) | 1486 (1348–2294) | 7560 (7200–15440) |
| default, repeated | 8 | 16 | 350 (342–364) | 931 (807–1050) | 202 (80–317) | 725 (373–1180) | 1404 (1306–1563) | 7280 (7040–8400) |
| per request `initial_codec_chunk_frames: 4` | 1 | 10 | 176 (159–300) | 476 (459–600) | 0 (0–0) | 394 (214–540) | 904 (872–991) | 7400 (7120–7840) |
| per request 4 | 4 | 12 | 348 (335–444) | 654 (635–745) | 0 (0–71) | 540 (482–948) | 1209 (1168–1312) | 7440 (7120–8160) |
| per request 4 | 8 | 16 | 588 (560–618) | 888 (860–918) | 0 (0–0) | 778 (640–1124) | 1518 (1441–1663) | 7560 (6960–8720) |
| per request `initial_codec_chunk_frames: 6` | 1 | 10 | 208 (183–234) | 508 (483–534) | 0 (0–0) | 362 (257–534) | 932 (907–986) | 7520 (7280–7840) |

- The default is an 80 ms first chunk (3840 bytes), then nothing for 125 ms alone and 180–200 ms at 4–8 in parallel,
  then the rest in a burst: the L40S synthesizes 8 × faster than real time, so the gap is far from the 0.4–0.5 s
  guessed. The first 150–240 ms of every answer are silence (20–580), so the stall falls inside it.
- A first chunk of 4 frames removes the stall and brings the voiced onset forward by 127 ms alone and 70 ms at 4 in
  parallel; at 8 in parallel the first byte comes 200 ms later and the onset does not move. Ranges overlap; the
  leading silence varies more than the effect. **No default changed.**
- Joins are clean in every arm: 0 (0–1) sample jumps at chunk boundaries, audio length unchanged. One default
  request at 8 in parallel returned 15.4 s of audio with 64 zero runs; not seen again in 60 more requests.
- `codec_chunk_ramp` / `codec_chunk_adaptive` (`TTS_DEPLOY_CONFIG`): **not run** (a 4-minute TTS reload per arm, and
  the per-request field already leaves no stall).

### Stack arm A (`7d041e1`) vs arm B (this branch), `--cache-ram 0`

`/v1/audio/transcriptions` with the 4.5 s clip: total at the Mac, median (min–max); 8 sequential, then 3 rounds of 8
and of 16 at once.

| Arm | Sequential | 8 at once | 16 at once | queue / decode ms (16 at once) |
|---|---|---|---|---|
| A | 396 (358–477) | 1009 (388–1177) | 1318 (403–1999) | not reported |
| B | 332 (289–434) | 938 (311–1071) | 1258 (369–1936) | 156 (0–517) / 373 (180–515) |
| B, `STT_BATCH_WINDOW_MS=0` | 328 (303–404) | 877 (307–1124) | 1260 (335–1901) | 148 (0–400) / 375 (179–451) |
| B, `CUT_EAGER=1` | 331 (290–370) | 902 (337–1094) | 1083 (305–1866) | 126 (0–599) / 511 (176–649) |

`bench.py --concurrency 1,4,8 --rounds 3` on `/v1/s2s`, server first audio p50 / p95 ms from the moment the server has
the clip (3, 12 and 24 requests, 0 errors in every arm):

| Arm | 1 | 4 at once | 8 at once | Stages at 1: stt queue + decode · llm first token · text wait · tts first chunk |
|---|---|---|---|---|
| A | 453 / 455 | 1264 / 1532 | 2239 / 2455 | stt 265 |
| B | 393 / 398 | 1134 / 1381 | 1609 / 2242 | 25 + 180 · 55 · 40 · 95 |
| B, `STT_BATCH_WINDOW_MS=0` | 370 / 371 | 954 / 1144 | 1885 / 2011 | 0 + 181 · 55 · 40 · 93 |
| B, `CUT_EAGER=1` | 387 / 392 | 1189 / 1257 | 2029 / 2171 | 25 + 182 · 54 · 31 · 92 |

- Arm B is faster at every level (−60 ms alone, −630 ms at 8 at once). The two env arms are inside the run-to-run
  spread of B (better at 1 and 4, worse at 8): no default changed.
- llama.cpp on arm B, same system prompt: turn 1 `cache_n` 483 / `prompt_n` 4 / 51 ms; turn 2 456 / 66 / 126 ms; another
  student with a different history 456 / 60 / 129 ms; back to the first after 8 others 456 / 136 / 129 ms. The system
  prompt is never read again; what is re-read is the history after it.

### Speculative end of turn, `EDGE_SPECULATE_MS` 300 vs 0

`e2e-live.ts turn webrtc|ws`, real Chrome, the clip as the fake microphone, one warm-up discarded then 8 turns each.
Clock: last voiced sample of the clip (the page's meter) → the edge's `audio_start` received ("received") and → first
loud output sample ("audible"); "edge ttfa" is the edge's own time after its end-of-turn decision. 300 ran on
machine 1 and 0 on machine 2 (the edge reads the setting once, at start): same machine type, zone and night, both with
`--cache-ram 0`, not the same machine. Median (min–max).

| Transport | `EDGE_SPECULATE_MS` | Turns complete | Received ms | Audible ms | Edge ttfa ms | Edge stt · llm first token · tts ms |
|---|---|---|---|---|---|---|
| WebRTC | 0 | 8 / 8 | 1259 (1227–1399) | 1627 (1413–1886) | 418 (398–555) | 207 · 76 · 94 |
| WebRTC | 300 | 8 / 8 | 944 (917–986) | 1292 (1116–1796) | 98 (96–156) | 210 · 58 · 96 |
| WS | 0 | 8 / 8 | 1184 (1171–1291) | 1498 (1222–1702) | 400 (395–436) | 208 · 56 · 94 |
| WS | 300 | 7 / 7 (one run's output not parsed) | 884 (849–958) | 1073 (1053–1190) | 99 (94–120) | 208 · 58 · 98 |
| WS, clip with a 450 ms pause | 0 | 5 / 5 | 1190 (1182–1287) | 1463 (1252–1756) | 404 (394–407) | 213 · 56 · 94 |
| WS, clip with a 450 ms pause | 300 | 5 / 5 | 907 (870–916) | 1191 (932–1270) | 96 (94–106) | 215 · 56 · 96 |

- 300 ms brings the first audio 300–315 ms earlier at the edge and 335–425 ms earlier in the ear; the 300 the branch
  already defaults to stays. 200 was not run.
- Discard cost on the paused clip: one extra STT decode per turn (12 clips for 6 turns against 6 for 6), the STT of
  the confirmed turn unchanged (215 vs 213 ms), the LLM task of the discarded attempt cancelled by llama.cpp.
- 150–500 ms pass between `audio_start` and the first loud sample in every row: the leading silence of the TTS.
- `s2s-stream` and the combination table per transport: **not run**.

## New image and class capacity, 2026-10-08

Image **`rg.fr-par.scw.cloud/aigw/speech-stack:20261008-0330`** (digest `sha256:8288cdb46d15c14a26cce5421c954cda7e8e9a1ed08506b0efe7d9f2fb3fd06e`,
59.0 GB), built from `95091e7` with `bun scripts/build-image-on-scaleway.ts docker/speech-stack speech-stack` (no `--app`:
nothing written to an app's image catalog). Build machine POP2-HC-8C-16G fr-par-2, 05:30:28–05:45:21 Europe/Paris, build +
push 828 s, machine and volume deleted by the script. Edge `ghcr.io/marcosremar/aigw-edge:95091e7` (Actions run
37722788671, success).

One replica, **L40S-1-48G, fr-par-2, €1.4699/h**, through a local gateway (`bun serve.ts` on :4103, namespace
`marcos-img`, `DEPLOYMENTS_PROBE_PORT=8080`). Spec: profile `speech-stack`, that image, `placements: []` (no silent
L4), `minReplicas: 1`, `maxHours: 3`, `maxEurPerHour: 1.6`, `realtime: { edgeImage: …:95091e7, maxSessions: 64, env:
{ RT_RTC_WORKERS: "6" } }`, edge defaults otherwise (`EDGE_SPECULATE_MS` 300). Created 05:45:46, `ready` by 05:54:12
(≤ 8 min 26 s), deleted 07:02:47: **77 machine-minutes, about €1.89**. One catalog voice (`voices.json` + a 6.9 s
reference, macOS `say`), a 332-word / 509-token Portuguese shop-clerk system prompt, a 4.1 s Portuguese utterance as
the clip (`say`, PCM16 mono 16 kHz).

Clock of every latency: last voiced sample sent → first non-silent audio received (the edge's 700 ms endpointing is
inside). Target: p50 ≤ 1500, p95 ≤ 2000, failures + truncations ≤ 1 %. No run was marked `SATURATED`. All numbers
below are from this one machine in this one session; last night's rows are another machine and are not compared.

### The new code is what runs

`POST /v1/s2s` through the gateway (`…/invoke/v1/s2s`), one student, the same clip:

| When | `transcript.stt` | `done.stages` |
|---|---|---|
| 05:54, first call | `queue_ms` 25, `decode_ms` 162, `batch` 1 | `llm_first_token_ms` 116, `llm_cache_n` 0, `llm_prompt_n` 509, `tts_first_chunk_ms` 94 |
| 05:54, 2nd / 3rd | 25 / 159–160 | `llm_first_token_ms` 55 / 54, `llm_cache_n` 505, `llm_prompt_n` 4, `tts_first_chunk_ms` 92–94 |
| 06:27, after 6 runs up to N = 16 | — | `llm` `prompt_ms` 52 / 50 (`cache_n` 505) |
| 07:02, after 67 min and 2 492 clips | 25 / 161–162 | `llm_first_token_ms` 57 / 55, `tts_first_chunk_ms` 90–91 |

The fields exist only in this branch's `server.py`; the idle first token is the same after 67 min of load (54 → 55 ms),
where the production image went 260 → 802 ms in 25 min: `--cache-ram 0` is in effect. `/health`: `stt.batches` 2 266,
`clips` 2 492, `largest` 8, `oom_retries` 0, `fallbacks` 0.

### Capacity of one replica, clean network, `ws` clients from the Mac

`GW=http://localhost:4103 DEP=img-speech bun scripts/realtime-e2e/load.ts --n <N> --clip turn.wav --profile clean`
(180 s per student + 30 s ramp, a turn every 15 ± 5 s), in the order they ran:

| Start | N | Turns ok / attempted | First audio p50 / p95 / max ms | ≤ 1.0 / 1.5 / 2.0 s % | Edge after endpointing p50 / p95: ttfa · stt · llm first token · tts | Result |
|---|---|---|---|---|---|---|
| 05:54:45 | 4 | 47 / 47 | 1184 / 1899 / 2119 | 10.6 / 74.5 / 95.7 | 149/723 · 186/426 · 138/341 · 102/152 | PASS |
| 06:09:42 | 8 | 91 / 91 | 1325 / 2014 / 2639 | 9.9 / 69.2 / 93.4 | 271/993 · 267/514 · 194/502 · 105/198 | FAIL (p95 +14 ms) |
| 06:13:15 | 10 | 108 / 108 | 1555 / 2606 / 3048 | 8.3 / 46.3 / 80.6 | 522/1360 · 354/657 · 243/521 · 113/210 | FAIL |
| 06:16:48 | 12 | 129 / 129 | 1748 / 2525 / 2983 | 0.8 / 33.3 / 78.3 | 635/1340 · 388/683 · 306/579 · 127/212 | FAIL |
| 06:20:19 | 16 | 170 / 170 | 2255 / 3316 / 3868 | 3.5 / 16.5 / 37.6 | 1135/2178 · 422/836 · 482/1030 · 150/288 | FAIL |
| 06:23:58 | 8 again | 87 / 87 | 1288 / 2149 / 2828 | 4.6 / 65.5 / 89.7 | 295/1062 · 313/575 · 168/519 · 111/186 | FAIL (p95 +149 ms) |
| 06:27:40 | 6 | 65 / 65 | 1248 / 2094 / 2389 | 4.6 / 78.5 / 92.3 | 150/933 · 188/420 · 156/482 · 102/182 | FAIL (p95 +94 ms) |
| 06:33:27 | 4 again | 46 / 46 | 1071 / 1345 / 1492 | 19.6 / 100 / 100 | 140/459 · 185/335 · 128/182 · 100/153 | PASS |
| 06:55:16 | 16 again | 165 / 165 | 2481 / 3624 / 4444 | 1.8 / 15.2 / 34.5 | 1314/2611 · 421/855 · 525/1234 · 144/285 | FAIL |
| 06:59:00 | 6 again | 69 / 69 | 1160 / 1894 / 2162 | 13 / 82.6 / 95.7 | 144/758 · 189/403 · 152/422 · 97/156 | PASS |

- **N_pass = 4** (2 of 2 runs). N = 6 passed once and failed once (p95 1894 / 2094); N = 8 failed twice on p95 only
  (2014 / 2149; p50 1.29–1.33 s, 90–93 % of turns under 2 s). **p95 crosses 2 s at 6–8 students**; p50 crosses 1.5 s
  between 8 and 10. Two identical runs differ by up to 550 ms on p95 (N = 4: 1899 vs 1345), so 6 and 8 are inside the
  noise of the limit, and 10 and above are not.
- **No drift.** N = 8 at 06:24, after N = 10, 12 and 16, is the N = 8 of 06:10 (p50 1288 vs 1325, LLM first token p50
  168 vs 194 ms); N = 4 and N = 6 were better late than early.
- No failed or truncated turn in 977 turns; no admission refusal (cap 64).
- What grows with N is the wait behind other students' turns: STT p50 186 → 422 ms and LLM first token p50 138 →
  482 ms from N = 4 to 16. At N ≤ 6 the edge's own p50 is 140–150 ms after endpointing (the speculative turn landing);
  its p95 (460–930 ms) is the turns where it did not, and that tail is what sits on the 2 s line.
- **Burst at N_pass** (06:31:18, `--n 4 --burst --jitter 0 --turn-every 20 --ramp 5 --duration 120`; 6 bursts, the 4
  students ending their speech within 6–21 ms): 24 / 24 ok, **p50 1950, p95 2355, max 2436 ms**, 62.5 % under 2 s —
  FAIL by the target, no collapse (STT 373 ms, LLM first token 539 ms p50).

### Degraded network at N_pass, from the 6-vCPU Linux VM behind the Mac's NAT

`bun scripts/realtime-e2e/load.ts --n 2 --rtc 2 --chrome 3 --clip turn.wav --profile <p> --duration 120 --ramp 15`
(2 aiortc + 3 Chrome forced on `webrtc`, `ws`, `s2s-stream` = 5 sessions on the replica). `campus-slow` (2 Mbit/s
down, 512 kbit/s up, 40 ± 10 ms, 1 % loss) and `lossy` (75 ms, 5 %) are assumptions, not measurements of the campus.
PASS/FAIL is on the lightweight clients only: the Chrome `ws` session's `interrupted` turns are the harness's loop (its
fake microphone repeats the clip every 15 s over a reply still playing), as last night.

| Start | Profile | aiortc first audio p50 / p95 ms (n), by transport ended on | Chrome audible p50 / p95 ms (n): webrtc · ws · s2s-stream | Connect ms, transport ended on, time lost in failed rungs | Lightweight result |
|---|---|---|---|---|---|
| 06:37:16 | clean | webrtc 1466 / 2364 (13) | 1834 / 3134 (8) · 1107 / 1947 (9) · 1928 / 2115 (9) | aiortc 2 of 2 webrtc, host/host (441, 1700); Chrome webrtc 544, ws 166; nothing lost | FAIL (p95) |
| 06:40:08 | campus-slow | webrtc 2541 / 3016 (7) · ws 1092 / 1595 (6) | 2355 / 3145 (9) · 2410 / 2760 (9) · 4324 / 6119 (9) | aiortc 1 webrtc (1500), 1 on ws after 4.0 s of failed connect (4420 total); Chrome webrtc 2487, ws 347 | FAIL |
| 06:42:42 | udp-blocked | ws 1097 / 1496 (13) | — · 1239 / 1444 (9) · 1785 / 1974 (9) | aiortc 2 of 2 on ws after 2.0 and 3.0 s of failed gathering (2181, 3143 total); Chrome ws 141; Chrome forced on webrtc never connected | **PASS** |
| 06:45:09 | lossy | ws 1605 / 8796 (12) | — · 1490 / 2450 (9) · 3307 / 5591 (9) | aiortc 2 of 2 on ws after 4.1–4.2 s of failed connect (5858, 6863 total); Chrome ws 1872; Chrome forced on webrtc never connected | FAIL (1 failed, 1 truncated of 12) |

- WebRTC from this network is direct UDP (`host/host`); this gateway has no TURN, so a blocked or lossy UDP path ends
  on the `ws` rung. On `ws` the latency is the clean one (1.1 s p50) even on `campus-slow` and `udp-blocked`.
- The WebRTC rung is the slow one on a bad link: +1.1 s p50 on `campus-slow` against `ws` in the same run.
- `s2s-stream` uploads the whole clip after the speech: 4.3 s p50 on `campus-slow`, 3.3 s on `lossy`.

**Start race of the SDK (edge `95091e7`), Chrome on its own ladder** (`--n 1 --rtc 1 --chrome 3 --chrome-transports ,
--duration 75 --ramp 10`; 3 Chrome sessions per profile):

| Start | Profile | Chrome: first transport usable, ms | Chrome: ended on | aiortc (sequential ladder), same run |
|---|---|---|---|---|
| 06:50:07 | udp-blocked | ws at 192–201 | ws (WebRTC given up at 5.0 s, in the background) | ws at 3172 after 3.1 s of failed gathering |
| 06:51:58 | clean | ws at 421–425 | webrtc, up at 643–728 | webrtc at 2513 |
| 06:53:33 | campus-slow | ws at 374–482 | webrtc, up at 1227–2512 | ws at 4702 after 4.2 s of failed connect |

With the race the learner is connected in 0.2–0.5 s on every profile; without it (aiortc, last night's SDK) a blocked
UDP path costs 2–4 s before the first word.

### The class case: 24 students on two replicas — not run

`PATCH {"minReplicas":2,"maxReplicas":2,"maxEurPerHour":3.2}` at 06:48:05. Every create until 07:02:32 (14 min 27 s)
was refused: `403 quotas_exceeded`, `cp_servers_type_L40S_1_48G` quota 2, current 2 — this session held one, the other
is not ours. No L4 was substituted. In its place, N = 16 on the one replica, twice (table above): p50 2255 / 2481, p95
3316 / 3624 ms, 35–38 % of turns under 2 s, no failure.

### Verdict

| | Largest class inside the target, clean | `udp-blocked` | `campus-slow` | `lossy` | € / h |
|---|---|---|---|---|---|
| 1 × L40S | **4** (6: one run of two; 8: p95 2.01–2.15 s, p50 1.3 s) | passes at 5 sessions (ws) | fails at 5 on the WebRTC rung (2.5 s p50); the ws rung alone would pass (1.1 / 1.6 s, n = 6) | fails at 5 (p95 8.8 s) | 1.47 |
| 2 × L40S | not measured (quota); derived 8, at most 12 with the N = 6 run that passed | not measured | not measured | not measured | 2.94 |

**24 students at once**: not measured on two replicas. Derived from the one-replica rows, assuming admission splits
them 12 / 12: each replica is the N = 12 row, **p50 1.75 s, p95 2.5 s, 78 % of turns under 2 s, no failed turn — FAIL
on both limits**. Inside the target the class needs 24 / 6 = **4 L40S** (€5.88/h) on the borderline run, 24 / 4 = 6
(€8.82/h) on the level that passed twice; the L40S quota is 2. On two L40S the target that 24 students would meet,
by the same derivation, is p50 ≤ 1.8 s and p95 ≤ 2.6 s.

Not run: the two-replica measurement and the admission spread (quota); the L4; `flap`; TURN; a burst above 4.

### Harness

`load-client.ts` records the replica of each student (the `rep` claim of the session token) and `load.ts` reports
`firstAudioMs.byReplica` and one summary line per replica — for the two-replica run that could not happen; with one
replica it only confirms every session was on it.

At 05:59–06:02 this Mac's disk filled (other sessions; 0.8 GB free of 460): the local gateway process died without a
log line; one N = 8 run lost its output and the next two ran against the dead gateway (11 GPU minutes). The gateway was restarted on the same
`DEPLOYMENTS_STATE_DIR` and took the running replica back; nothing was created twice.

## Fallback under load, 2026-10-08

Question: when a GPU replica is full, cold, out of stock or over budget, the excess students are answered by the composed
pipeline of `POST /v1/s2s` (STT → LLM → TTS over OpenRouter). Does it hold a class, and what does it cost? No machine was
created: the test gateway (this branch, port 4104, a Mac) ran with `DEPLOYMENTS_ENABLED=0` (boot log: `Deployments
disabled`, declared `parle-speech` in state `disabled`), every request carried `X-Gateway-No-Wake: 1`, `/health` ended
with `noWake.skips: 0` and the log has no line about a replica.

**Chain** (parle's own routes, `backend/speech/gateway-routes.ts`, set here through `MODEL_ROUTES`; `/health` showed the
same serving links as production with no GPU up): STT `openrouter:openai/whisper-large-v3-turbo` (third link
`groq:whisper-large-v3-turbo` is `no_key`: the dev API serves no `GROQ_API_KEY`, so STT has **no** second cloud link) ·
LLM `openrouter:qwen/qwen3.5-9b` (reasoning off) → `openrouter:google/gemini-2.5-flash-lite` · TTS
`openrouter:microsoft/mai-voice-2.1-flash` (voice `pt-BR-Luana`) → `openrouter:hexgrad/kokoro-82m`.

**Turn**: a 4.0 s Portuguese clip (macOS `say`, PCM16 16 kHz), a 460-token shop-clerk system prompt, 3 messages of
history, `max_tokens` 160. Replies averaged 127 characters in 3 sentences, 10.5 s of audio. Harness: the new `s2s`
lightweight client (`load.ts --s2s N --no-wake`, docs/realtime.md § Clients), default duty cycle (a turn every 15 ± 5 s,
30 s ramp), 120 s per student. **Clock**: from the end of the speech = the request minus 700 ms (`--clip-end-silence`,
the endpointing the page adds before it posts) to the first non-silent audio; "from request" is the same without the
700 ms. Target for comparison (the GPU's): p50 ≤ 1500 ms, p95 ≤ 2000 ms.

| Run | Turns | Failed | First audio from end of speech, ms: p50 / p90 / p95 / p99 / max | Share ≤ 1.0 / 1.5 / 2.0 / 3.0 / 5.0 s, % | From request p50 / p95 | Cost of the run |
|---|---|---|---|---|---|---|
| N = 1, 10 turns | 11 | 0 | 3003 / 4726 / 5472 / 5472 / 5472 | 0 / 0 / 0 / 45.5 / 90.9 | 2303 / 4772 | $0.02 |
| N = 8 | 62 | 0 | 2978 / 3668 / 4005 / 4671 / 4671 | 0 / 0 / 0 / 53.2 / 100 | 2278 / 3305 | $0.12 |
| N = 25 | 191 | 0 | 2989 / 3457 / 3725 / 4267 / 5052 | 0 / 0 / 0 / 52.4 / 99.5 | 2289 / 3025 | $0.38 |
| N = 25, repeated after N = 100 | 194 | 0 | 2987 / 3616 / 4410 / 7597 / 7759 | 0 / 0 / 0 / 52.1 / 98.5 | 2287 / 3710 | $0.39 |
| N = 25 `--burst` | 166 | 0 | 3220 / 4839 / 5496 / 6928 / 7369 | 0 / 0 / 0 / 34.9 / 92.2 | 2520 / 4796 | $0.33 |
| N = 50 | 378 | 0 | 3181 / 4888 / 5485 / 6376 / 7163 | 0 / 0 / 0 / 35.2 / 90.5 | 2481 / 4785 | $0.75 |
| N = 100 | 767 | 0 | 3145 / 4366 / 5193 / 6785 / 7505 | 0 / 0 / 0 / 35.3 / 94.3 | 2445 / 4493 | $1.50 |

Every run is `FAIL` against the GPU target, as expected. 1,769 turns, **0 failed**: no 429, no 5xx, no timeout, no
`sentence_failed`, no `missing_audio`, no stream without `done`. The harness also flagged 0 / 2 / 14 / 9 / 16 / 23 / 61
turns as `truncated:short_audio` (audio per character under 0.75 × the run's p90): none of them has a hard sign of a
cut, the shortest is 0.60 of the reference, and the MAI voice's own rate spreads from 72 to 94 ms per character (p10–p90),
so the 0.75 ratio tuned on the GPU voice gives false positives here; a reply that lost one sentence of three would look
the same, so this check cannot rule it out — the gateway's own signals do.

**Per stage**, ms, p50 / p95 (from the events of the composed pipeline; stages run one after the other):

| Run | STT | LLM first token | first sentence cut after it | TTS first byte | first audio at the gateway | client − gateway |
|---|---|---|---|---|---|---|
| N = 1 | 690 / 1186 | 697 / 1718 | 108 / 1593 | 844 / 1003 | 2279 / 4769 | 3 / 72 |
| N = 8 | 701 / 1399 | 661 / 816 | 96 / 189 | 796 / 954 | 2285 / 3303 | 3 / 18 |
| N = 25 | 670 / 1393 | 671 / 855 | 91 / 187 | 786 / 961 | 2287 / 3024 | 2 / 11 |
| N = 25 burst | 746 / 1858 | 695 / 1236 | 104 / 1818 | 799 / 1075 | 2573 / 4795 | 1 / 8 |
| N = 50 | 794 / 1991 | 675 / 1130 | 97 / 2003 | 791 / 945 | 2479 / 4784 | 1 / 9 |
| N = 100 | 762 / 2310 | 687 / 1123 (p99 4337) | 105 / 246 | 791 / 1037 | 2444 / 4492 | 1 / 5 |

- The median does not move with N (3.0–3.2 s from 1 to 100 students): it is the sum of three sequential cloud calls
  (≈ 0.7 + 0.7 + 0.1 + 0.8 s) plus the 0.7 s endpointing. The fallback is ≈ 1.5 s over the p50 target at any load.
- The tail is the providers': Whisper's p95 grows from 1.4 to 2.3 s, and the Qwen stream sometimes stalls ≈ 2 s between
  its first token and the end of the first sentence (already once in 11 turns with one student). The load generator and
  the gateway add 1–11 ms (last column), although the Mac was busy (load average 20–27 on 10 cores, other sessions).
- **Serving links**: route `composite` 100 %; STT and TTS 100 % on the first cloud link at every N; LLM 100 % on Qwen up
  to N = 50 and 755 / 767 at N = 100 — 12 turns (1.6 %) went to `gemini-2.5-flash-lite` with `fallback: timeout` (the
  gateway log: `Streaming timeout after 4000ms → next provider`, 12 times). Kokoro never served.
- **Limits**: no provider rate limit appeared. Of the gateway's own: `RATE_LIMIT_RPM` is off (unset);
  `MAX_CONCURRENT_PER_USER` (150; the stage sub-requests are exempt) was never reached; the cloud first-byte limit
  (`GATEWAY_CLOUD_HEDGE_MS`, 4000 ms = half the 8 s stage budget) is what moved those 12 LLM turns; `S2S_HEDGE_MS` does
  not apply without a primary. **Not exercised**: the per-app daily budget — the test key is an admin, production's
  `parle` key is not. `checkS2S` charges one request and ≈ 580 tokens (prompt characters / 4 + `max_tokens`) per turn
  against `APP_DAILY_REQUESTS` (default 5000) and `APP_DAILY_TOKENS` (default 2,000,000): at the defaults ≈ 3,400
  turns a day, which 25 students on the fallback use in ≈ 35 minutes and 100 in ≈ 9 — then `429` until 00:00 UTC. What
  production sets was not read (the production gateway was not touched); it is the first limit to check.

**"Usable"** (steady arrivals; failures were 0 % everywhere):

| Definition | Largest N |
|---|---|
| within the GPU target, p95 ≤ 2 s | none — a single student already gets p50 3.0 s (no turn under 2 s in 1,769) |
| p95 ≤ 3 s | none — the best p95 was 3.7 s (N = 25); from the request, without the endpointing, 3.0–3.7 s |
| p95 ≤ 5 s and ≤ 2 % failures | 25 (p95 3.7 and 4.4 s in two runs; N = 8: 4.0 s). N = 50 and 100 miss by 0.2–0.5 s (5.5 and 5.2 s), and so does a class of 25 that speaks at the same instant (5.5 s) |

Counted from the request, every level up to 100 stays under 5 s (p95 4.5–4.8 s). The first limit hit is latency, not a
rate limit and not the gateway: the fallback keeps answering 100 students, about 1.5 s later than the GPU at the median
and 2–3.5 s later at p95.

**Cost.** The composed pipeline returns no usage, so two sources: (a) measured — the OpenRouter key's own counter
(`GET https://openrouter.ai/api/v1/key`, read before and after; the key is shared, other use would be inside): **$3.45**
for the whole session; (b) computed from the harness's counts and the prices of `GET
https://openrouter.ai/api/v1/models?output_modalities=all` on 2026-10-08 — MAI-Voice-2.1-flash $15 per million
characters, Qwen3.5-9B $0.10 / $0.15 per million tokens in / out (475 in, ≈ 35 out per turn, measured through the
gateway), Whisper turbo `0.00000333` per unit (taken as per second of audio): **$3.49**. Per turn **$0.0020**, 97 % of
it the TTS (127 characters); the LLM is $0.00005 and the STT ≈ $0.00001.

| | per student-hour (240 turns) | 8 students (overflow of one class) | 24 students | 100 students |
|---|---|---|---|---|
| Fallback (MAI voice) | $0.47 (≈ €0.40–0.44) | $3.8 / h | $11.3 / h | $47 / h |
| GPU slot (L40S €1.47 / h, 8 students) | €0.18 | €1.47 / h | €4.41 / h | — |

The fallback costs ≈ 2.3 × a GPU slot at this duty cycle, and almost all of it is the voice: with Kokoro ($0.62 per
million characters) in place of MAI the same turn would be ≈ $0.00015 ($0.04 per student-hour) — not measured here.

**Surprises**
- The cloud TTS does not stream and does not answer WAV: `microsoft/mai-voice-2.1-flash` returns each sentence whole
  (time to first byte = total, 0.8–1.1 s) as **MP3** (24 kHz mono, 160 kbit/s) although the stage asks
  `response_format: "wav"`; the `A` frames then carry MP3 and the `audio_format` event says `audio/mpeg`. A client that
  assumes PCM plays noise. The voice is the stock `pt-BR-Luana`, not the cast voice the GPU clones.
- STT has one cloud link only (Groq has no key in the dev API): an OpenRouter Whisper outage fails the turn.
- The STT cache answers a repeated clip (same bytes) without calling the provider: a load test that posts one file
  measures the cache. The `s2s` client changes 16 samples per turn.

**Harness**: `scripts/realtime-e2e/load.ts` / `load-client.ts` — client type `s2s` (`--s2s N`, `--no-wake`), the `s2s`
block of the report (from-request times, stage times, serving provider per stage, errors, refused turns, usage counts),
shares ≤ 3.0 and ≤ 5.0 s in every distribution, `missing_audio` counted as a truncation. Not proven on the local fake
stack: it needs Linux + root and this run stayed on the Mac; the live runs above are the proof.

**Not run**: any GPU or realtime transport; bad-network profiles (Linux only); a non-admin app key (the daily budget
above); a second Portuguese clip or longer histories; a `--burst` above 25; Kokoro as the voice; repeats of N = 50 and
100 (one run each — the p95 of N = 25 moved from 3.7 to 4.4 s between two runs, so read ± 0.7 s on every p95).


## Vast.ai RTX 5090, 2026-10-08

Through a local gateway only (`bun serve.ts` on :4105, namespace `marcos-vast`, worktree at `153fac3` + the fixes
below), from a Mac in France. Three rentals, one at a time: a French host for 1 min (released by the RTT gate), a UK
host for 3 min (released by a `park` sent by mistake), a UK host 05:08:05–05:45:36 UTC that ran everything below.
About 42 machine-minutes, about US$0.55. Everything deleted: `GET /v1/deployments?scope=all` → 0 deployments, 0
replicas; reaper dry run `seen: 0`; the instance's port no longer answers.

### Selection

- New read-only route `GET /v1/deployments/:name/offers` (admin): the ranked offers a create would walk. Before it
  there was no way to see the ranking without renting.
- "Good latency" today is two things. Before renting: great-circle distance between country hubs, in 500-km bands,
  then effective price (`placements.ts` `rankOffers`; `geo.ts`). No measured signal: `inet_down` is only a tie-break
  and `inet_up` is not read. After renting: the RTT gate (`rtt-gate.ts`, `gateDecision`; default `maxRttMs` 35),
  measured once from the gateway to the replica's nginx front as soon as it has an address; above the threshold the
  instance is deleted and the host avoided for 24 h. Nothing measures from the users' side.
- Offers for `RTX 5090`, `minCuda: 13`, cap €0.85/h, near FR (first listing, 21 offers; then the market moved):

| Rank | Location | km | $/h | Reliability | Down / up Mbps |
|---|---|---|---|---|---|
| 1 | United Kingdom | 343 | 0.735 | 0.989 | 2029 / 2151 |
| 2 | United Kingdom | 343 | 0.776 | 0.982 | 1471 / 84 |
| 3 | United Kingdom | 343 | 0.802 | 0.983 | 804 / 778 |
| 4 | Italy | 640 | 0.592 | 0.988 | 728 / 735 |
| 5 | Italy | 640 | 0.660 | 0.998 | 610 / 621 |
| 6–9 | Czechia | 883 | 0.62–0.78 | 0.97–0.99 | 4201–7270 |
| 10– | PL, DK, NO, HU, SK, ES, BG, RO | 1027–1870 | 0.54–0.87 | | |

- What it rented, in order: (1) **France, €0.548/h** (appeared between the listing and the create), address after
  49 s, gate RTT **42 ms > 35 → released as too-far**. At that minute the Mac's own TCP connect to
  `s3.fr-par.scw.cloud` was 45 ms median (25 min): the host was as near as Paris itself. The threshold assumes the
  gateway sits in a datacenter in NL; from any other vantage it rejects good hosts. (2) with `maxRttMs: 120`:
  **UK, gate RTT 55 ms, kept**. (3) after a restart: listing at 05:07:50 ranked Switzerland $0.563 and the
  Netherlands $0.597 first; the create 15 s later rented a **UK host at €0.758/h ($0.796), gate RTT 63 ms** and
  nothing says why the two cheaper ones were passed over (misses were only reported when every offer failed; now
  logged, see fixes — the running process predated that fix).
- Measured from the Mac to the UK instance (TCP connect to the mapped port, median of 7) against Paris S3 in the same
  run: 48.6 vs 33.8, 54.7 vs 40.8, 45.3 vs 33.4 ms. So about **+12–15 ms over a Paris datacenter**. Usable, not the
  best on the market that hour: a French host (same RTT as Paris) and cheaper CH/NL hosts existed.
- Verdict: the distance prior works (no far host was ever tried) and the gate does release-and-retry, but (a) its
  absolute threshold is only right from the production vantage, (b) inside band 0 price alone decides, so FR, UK, CH
  and NL are interchangeable, (c) the choice among them was not explainable after the fact. Smallest correct change,
  not implemented: gate on `rtt − baseline`, the baseline being the same probe against a fixed anchor in the `near`
  country taken in the same tick (default budget ~20 ms over the anchor), and show both numbers in `lastPlacement`.

### Boot

- **Image**: `rg.fr-par.scw.cloud/aigw/speech-stack` answers 401 to an anonymous pull, and the Vast path sent no
  registry credentials (`withRegistryAuth` skips boot-script specs; `registryAuthFor` exists only on the Scaleway
  backend). The backend now sends `image_login` when the spec carries `registryAuth` (unit-tested, **not run live**).
  It is deliberately not filled from the Scaleway API secret: that key would travel to a marketplace host. A private
  image on Vast needs a pull-only credential or a public copy.
- So the stack was built at boot on the public `vllm/vllm-omni:v0.28.0` (9 GB compressed): llama.cpp and its CUDA 12
  libraries extracted from `ghcr.io/ggml-org/llama.cpp:server-cuda-b11382` with `crane export`, the wheels of the
  Dockerfile with `uv`, the three models from Hugging Face (all public), the four code files from this repository at
  `153fac3` (so `--cache-ram 0` is in). 3.4 KB boot script.
- **Voices**: no `files` on Vast. The boot script wrote `/files/voices.json` and a reference clip made on the
  machine (`espeak-ng`). An inline `{audio, text}` voice per request also works, but the warm-up then skips the TTS.
- **Vast refuses an env above 32 KB in total** (`invalid env arguments, total length > 32KB`): a 52 KB boot script
  (code and a voice clip inline) failed every create while the spec accepted it (limit 90 KB). Now refused at PUT.
- **Env**: `STT_BATCH=8`, `LLM_PARALLEL=16`, `TTS_STAGE0_MB=9600` (the L4 values plus the 8 GB the card has over an
  L4: batch and slots as the L40S so 8 at once compares like for like, the TTS stage between the two). Health after
  the runs: largest STT batch 8, `oom_retries` 0. GPU memory in use was not read.
- **Card**: RTX 5090, driver 580.82.09, 32607 MiB. With `minCuda: 13` vLLM-Omni (CUDA 13), llama.cpp (CUDA 12.8,
  `CUDA0` seen) and faster-whisper (CTranslate2, cu12 wheels) all started and served.
- **Cold start 16 min 23 s** (gateway: 983 s): rent → running with an address 4 min 21 s (image pull); boot script
  ~12 min, of which llama.cpp extraction ended at +147 s; wheels, 16 GB of models, TTS load and warm-up were not
  split (the log view stops when the app takes the port). A public baked image would remove most of the 12 min.

### `/v1/s2s` against the L40S

Gateway invoke route, `bench.py --concurrency 1,4,8 --rounds 3`, a 5.7 s Portuguese utterance (`say`), a 307-word
shop-clerk system prompt (451 cached tokens), one catalog voice. L40S row: arm B above (4.5 s clip). p50 / p95 ms.

| | 1 | 4 at once | 8 at once |
|---|---|---|---|
| L40S fr-par-2, server first audio | 393 / 398 | 1134 / 1381 | 1609 / 2242 |
| **RTX 5090 (UK), server first audio** | **414 / 415** | **1154 / 1463** | **1819 / 2160** |
| RTX 5090, client first audio at the Mac | 588 / 717 | 1369 / 1878 | 2147 / 2679 |
| RTX 5090 stt queue + decode | 25 + 213 | 188 + 503 | 199 + 733 |
| RTX 5090 llm first token | 67 | 198 | 299 |
| RTX 5090 text wait | 23 | 99 | 165 |
| RTX 5090 tts first chunk | 85 | 195 | 298 |
| L40S stages at 1 | 25 + 180 · 55 · 40 · 95 | | |

- Same class of card for this stack: equal alone and at 4, ~200 ms slower at 8 (p95 equal). The STT decode carries
  the difference at 1 (213 vs 180 ms, on a clip 1.2 s longer).
- **No first-token drift**: 67 ms before, 69 ms after 222 s of 8 at once (320 turns; thirds 357 / 304 / 390 ms under
  load). 3 of the 320 streams ended early (`peer closed connection`), status 200.
  Read again from the saved records (branch `rt/stream-truncation`): the three were not cut on the way to the client.
  Each ended with the stack's own in-band `error` event, whose message is the stack's httpx error towards the TTS
  server (`/v1/audio/speech` closed mid-body), after a sentence that ran away: 15.3 s of audio for "Bom dia!", turns
  of 20.3 and 21.9 s against a median of 8.1 s. Why vLLM-Omni ended those streams is not known (no replica log).
- Cost at the largest level that keeps server first audio near 1.2 s (4 at once): 5090 at $0.796/h → **$0.20 per
  simultaneous turn-hour** ($0.14–0.15 on the $0.56–0.60 hosts the market also had); L40S €1.4699/h → €0.37.
- One run was lost to the Mac's network: DNS failed for a few seconds, the provider lists failed, 7 of 8 streams of
  that round never ended and one answered 503 after 842 s. Not the replica (its health stayed 200).
  Reproduced locally on that branch: a replica connection that breaks mid-body left the invoke route's client hanging
  under Bun (fixed), and a failed connection to the only replica made the retry wait the bench's whole
  `X-Aigw-Wait: 840` for a second replica (fixed).

### What does not work on Vast (each answer observed)

| Request | Answer |
|---|---|
| spec with `files` | 400 `files are not supported on vast (no user_data service)` |
| spec with `exposure` | 400 `exposure is not supported on vast` |
| spec with `idleAction: "stop"` | 400 `idleAction 'stop' is not supported on vast` |
| spec with `realtime` | 400 `realtime is not supported on vast yet (the edge runs as a sidecar container)` |
| `POST /v1/realtime/sessions` for the running Vast deployment | 503 `its replicas run no realtime edge`, fallback `s2s-stream` |
| replica `/__aigw/rt/health` (with the token) | 404: the Vast nginx front has no `/__aigw/rt/` |
| `POST …/park` | 202, and the instance is **deleted** (no power-off on Vast): the next call pays the full 16 min |
| private Scaleway image | anonymous pull 401; no credential sent before this branch |
| boot log | none through the gateway: a failed boot on Vast is blind unless the script serves its own log |
| `DELETE` | 200; 20 s later 0 replicas, the mapped port closed, reaper dry run `seen: 0` |

Works: `/__aigw/ready` and the health path through the mapped port (200 with the token, 401 without), invoke,
capacity (`boot` measured 983 s).

Also seen: `serve.ts` logs `Deployments enabled (scaleway)` with Vast on; the create log prints the spec's Scaleway
zone for a Vast create; a create refused by Vast with a 400 is retried with the usual back-off, and a corrected PUT
does not reset that back-off (2 min 20 s of waiting on a fixed spec).

### Realtime on Vast — design (not implemented)

Read for this: `spec.ts` `checkVastSpec`, `cloud-init.ts` (`realtimeSection`, `vastReplicaInit`, `nginxConfig`),
`docker/aigw-edge/aigw_edge/config.py` (`port_map` from `VAST_UDP_PORT_<n>`, `RT_PUBLIC_IP` falling back to
`PUBLIC_IPADDR`), `ice.py:33` (the map applied to candidates). The rest of the edge and `src/realtime/net-probe.ts`
were not read: the points marked (?) need checking.

1. **Edge as a process, not a sidecar.** `vastReplicaInit` writes `edge.env` (as `realtimeSection` does, without the
   Scaleway metadata call), sets `AIGW_REPLICA_ID` to the Vast instance id (the id the gateway knows the replica by)
   and starts the edge from the image or from a `pip install` in the boot script; nginx gets
   `nginxConfig(token, 80, appPort, RT_EDGE_PORT)`. With only this, `ws` and TURN sessions work: they ride the
   mapped TCP port that already carries the probe.
2. **UDP media.** `vast-backend.ts` adds one `-p <port>:<port>/udp` env key per port of `RT_UDP_PORTS` (sessions + 1
   for the probe), and searches `direct_port_count ≥` that count + 1 (hosts listed 49–256; a 16-session range fits
   everywhere). Vast publishes each on a random host port; the edge already rewrites its candidates through
   `port_map`. To change: the probe port the edge reports to the gateway must be the mapped one (?), and the range
   must stay small — one mapping per port, no ranges.
3. **Spec.** `checkVastSpec` accepts `realtime` when the range fits `direct_port_count`; `envByMachineType` gets an
   `RTX 5090` entry with `RT_MAX_SESSIONS` (4 from the table above, to be measured as realtime).
4. Files: `src/deployments/spec.ts`, `cloud-init.ts`, `vast-backend.ts`, `profiles.ts`;
   `docker/aigw-edge/aigw_edge/config.py` and its reachability check; `src/realtime/net-probe.ts` (?);
   `docker/speech-stack` (ship the edge in the image); tests `vast-backend.test.ts`, `realtime-edge.test.ts`.
5. A live test has to show: a session admitted on a Vast replica; a `webrtc` session whose answer carries the
   public IP and the mapped UDP port and whose media flows; the `ws` path when UDP is blocked; first audio p95 at 4
   learners from France; seated sessions visible to the controller; a session surviving the replica's replacement
   (RTT gate or host expiry) by reconnecting.

### Fixes on `rt/vast-live`

`521fa39`: `GET /v1/deployments/:name/offers` (`http.ts`, `controller-views.ts`, `vast-backend.ts` `previewOffers`);
`image_login` from `registryAuth` (`vast-backend.ts`); 32 KB env refusal (`spec.ts` `vastEnvBytes`); rented-offer
log (`vast-backend.ts`, wired in `index.ts`). Tests: `__tests__/unit/deployments/vast-backend.test.ts`, `spec.test.ts`.

### Not run

Realtime of any kind on Vast; `image_login` live; the real `speech-stack` image on the 5090 (same base and engine
builds, assembled at boot instead); a second host side by side; GPU memory headroom; the cold-start split after
llama.cpp; the rented-offer log in a live create; anything from a phone or a slow network.

## TTS runaway, 2026-10-08

One L40S-1-48G in fr-par-2 (€1.47/h), image `speech-stack:20261008-0330`, stack files from branch `rt/tts-runaway`
through spec `files`, a local gateway on :4106 (namespace `marcos-run`). Powered on 06:54 UTC, terminated 08:17 UTC:
83 machine-minutes, about €2.05. Deleted; `GET /v1/deployments?scope=all` → 0 replicas, no pending network release.
The create at 06:36 UTC left the server stopped for 17 min (L40S out of stock at power-on, L4 quota exceeded); the
controller logged `Server ready … (€0/hr)` for it and retried the power-on until it took.

### Cause (proven)

The engine's line for every runaway, read through the new `GET /debug/logs`:

```
ERROR [serving_speech.py:2354] [SpeechE2E] request_id=speech-adfe2ecda00ea66a stream=true status=error total_ms=1881.06
error=Qwen3-TTS Base did not emit codec EOS before its token budget (192/192 codec tokens); the generated audio is incomplete.
vllm_omni.entrypoints.openai.tts_adapters.qwen3_tts.Qwen3TTSCodecLimitError
```

- The talker (stage 0) starts a sentence on silence codes and keeps repeating them. Most sentences leave the loop
  after a moment (a silent lead of 1–10 s, then the sentence); some never do. The audio of the runaways is silence
  from the first sample (RMS 0–8 of 32768), sometimes with bursts of speech or noise late in the 15 s.
- vLLM-Omni 0.28.0 knows the state (`tts_adapters/qwen3_tts.py:235-306`, "can rarely enter a repetitive state in which
  codec EOS is no longer reachable through top-k sampling") and bounds a Base request at `max(192, 12 × text tokens)`
  codec frames (`:27-28`, `:273`). At 12.5 frames/s that is 15.36 s: the 15.28 s measured for «Bom dia!» on the 5090
  and here. A request that ends on that budget fails validation (`:308-333`), and a raw-audio stream that fails it is
  ended as an error by design (`serving_speech.py:2306`, `:2354`): no chunked terminator, hence httpx
  `RemoteProtocolError` in the stack and aiohttp `ClientPayloadError` in the edge. The non-streaming path retries once
  with a new seed (`:3621-3636`), the streaming path cannot.
- Not the decoder and not load: 2 runaways and 10 leads over 1 s in 600 requests sent one at a time. No position in
  a burst of 8 stands out. `decode_batch_max_size` (stage 1) was therefore not tested.
- It depends on the reference clip: with a 16.5 s reference instead of 6.8 s, 5× more.
- The engine's `silence_ban_frames` (`qwen3_tts.yaml:90`) does not apply: it only masks x-vector-only requests
  (`qwen3_tts_talker.py:437-440`), and the stack clones with a reference transcript (ICL).

### Reproduction (default engine settings, no cap)

Direct `POST /v1/audio/speech`, streamed PCM, through the gateway invoke route; 18 Portuguese texts of 3–129
characters ("mix") or «Olá, bom dia.» alone ("one text"); reference `ref-a` (6.8 s, macOS `say`) unless noted. Lead =
time before the first 50 ms window with RMS > 300. Runaway = stream ended as an error.

| Load | Requests | Runaways | Lead ≥ 1 s | Lead ≥ 2 s |
|---|---|---|---|---|
| mix, 8 in parallel (3 runs) | 4320 | 4 (15.03–15.28 s of audio) | 6 of 1440 measured | 3 of 1440 |
| one text, 8 in parallel (3 runs) | 2560 | 2 | 12 of 1600 measured | 4 of 1600 |
| one text, 1 at a time | 600 | 2 | 10 (17 ‰) | 3 |
| one text, 8 in parallel, 16.5 s reference | 960 | 6 | 53 (55 ‰) | 19 |
| `/v1/s2s`, 1 / 4 / 8 at once, 40 rounds each | 520 turns, 1506 sentences | 0 | one turn of 10.8 s | |

Runaways with the 6.8 s reference: 6 in 6880 requests, 0.9 per thousand; the texts were «Olá, bom dia.» (5) and
«Obrigado!» (1). Short sentences carry it: of the 6 leads over 1 s in the mix, one was on the 129-character text.

### Settings tried (same machine, same loads, 8 in parallel)

| Change | Requests | Runaways | Lead ≥ 1 s | Lead ≥ 2 s | Speech duration, one text p50 / mix mean |
|---|---|---|---|---|---|
| none (rows above, RMS-measured runs) | 3040 | 4 | 18 (5.9 ‰) | 7 | 1.22 s / 1.61 s |
| request `non_streaming_mode: true` | 2400 | 12 | 36 (15 ‰) | 14 | 1.20 / 1.59 — worse, rejected |
| YAML talker `repetition_penalty` 1.10 | 2400 | 0 | 2 | 0 | 1.22 / 1.60 |
| the same, 16.5 s reference | 960 | 1 | 12 (12 ‰) | 3 | 1.31 |
| **YAML talker `repetition_penalty` 1.15** | 2400 | **0** | **0** (max 0.80 s) | 0 | 1.22 / 1.60 |
| the same, 16.5 s reference | 1680 | 0 | 17 (10 ‰, max 6.05 s) | 2 | 1.32 (was 1.32) |
| stack only: hold + one retry + `max_new_tokens` (default YAML) | 2400 | 0 | 2 (max 1.05 s) | 0 | 1.23 / 1.60 |
| **both** (what is committed), 6.8 s reference | 2400 | 0 | 0 (max 0.75 s) | 0 | 1.22 / 1.60 |
| **both**, 16.5 s reference | 960 | 0 | 5 (max 1.20 s) | 0 | 1.32 |

- The penalty goes at the cause (the loop is one code repeated): 1.05 → 1.10 → 1.15 lowers leads and runaways in
  step. Lead p99 0.70–0.75 s → 0.45–0.50 s. Sentences are not shorter or clipped: speech duration equal within 0.01 s,
  trailing silence p50 0.05 s / p99 0.30 s in every arm. Transcribed back with the replica's own Whisper large-v3
  (`/v1/audio/transcriptions`): 53 of 59 samples exact with the default, 33 of 36 and 30 of 30 with 1.15, 32 of 36
  with 1.10 (the misses are «São 3,50.» and «Custa 12 reais» in every arm). Nobody listened to the audio: prosody
  with 1.15 is not judged.
- The stack part covers what the penalty leaves with a harder reference. Stack only, 2400 requests: 6 sentences
  asked again (2.5 ‰), each decided 0.50–0.53 s after the request at 8 in parallel, with 1.45 s of silence dropped;
  the student hears 80 ms of silence (the first chunk) and the sentence about 0.5 s later than usual. With both, 3360
  requests: 0 asked again.
- A peak detector (|sample| > 328) was fooled by a low noise burst before a 4 s silence (one sentence went to its cap,
  5.52 s); the committed detector is RMS ≤ 300 per chunk.
- The cap stays `3 s + 0.2 s per character`: of 19 226 clean sentences none came within reach of it; `2.5 + 0.12`
  would have cut 2. It is now the engine's stop (`max_new_tokens`, e.g. `70/70 codec tokens` for 13 characters, 5.6 s)
  instead of audio the stack throws away after 15 s.

### `/v1/s2s` before and after (40 rounds per level, same clip, voice and prompt)

| | 1 | 4 at once | 8 at once | Turns failed | GPU memory |
|---|---|---|---|---|---|
| before: server first audio p50 / p95 ms | 390 / 392 | 966 / 1334 | 2046 / 2235 | 0 / 520 | 28 205 MiB |
| stack part only | 392 / 395 | 1150 / 1339 | 2041 / 2211 | 0 / 520 (1 sentence asked again) | 28 173 MiB |
| both | 389 / 393 | 981 / 1334 | 2010 / 2195 | 1 / 520 | 28 203 MiB |
| both: TTS first chunk p50 / p95 ms (before) | 92 / 95 (93 / 95) | 184 / 252 (187 / 257) | 342 / 405 (342 / 406) | | |

The failed turn is the second kind of runaway, which is not fixed: the third sentence (34 characters) spoke, did
not stop, and the engine ended it at its cap (`123/123 codec tokens`, 9.76 s where 2.6 s is usual); the turn ended
with `error` stage `tts`, as before this branch but 5.6 s earlier. With both changes: this 1 in 1506 sentences of
`/v1/s2s`, 0 in 3360 direct requests; with the default YAML, 1 in 2400 through the stack. The stack does not ask such a
sentence again because the student has already heard part of it; it also does not continue the turn. Of 6 non-silent
runaways transcribed, 2 contained the sentence.

### Committed (`rt/tts-runaway`, not pushed)

- `docker/speech-stack/qwen3_tts.yaml`: the engine's v0.28.0 deploy YAML with `repetition_penalty: 1.15` (line 86);
  `start.sh` passes the file next to it as `--deploy-config`; `Dockerfile` copies it (one line).
- `server.py` `tts_stream`: `max_new_tokens`, silent lead held and one retry before any sound, a request id sent as
  `extra_params.request_id` (the engine logs it on the line after its own id), one `tts <id> …` line per request,
  `done.tts_retries`.
- `GET /debug/logs?engine=tts|llm|stt&tail=N&match=text`, `start.sh` bounded logs (32 MB per file, one rotation: the
  TTS writes about 6 KB per request).
- Tests: `test_debug_logs.py`, `test_tts_stream.py`, `test_s2s_turn.py`.

The YAML becomes the default only in an image built from this branch (it has to be in `/opt/s2s`). Until then it
ships like the code: `qwen3_tts.yaml` in the deployment's `files` with `start.sh` (README § shipping without a
rebuild) — that is how it ran here. The profile is untouched.

### Open

- The realtime edge calls `/v1/audio/speech` through the stack's proxy, not `tts_stream`: it gets the penalty, not
  the cap nor the retry. The same three request rules belong in `docker/aigw-edge` (not touched here).
- The non-silent runaway (1 in 4866 sentences with both changes): retrying it would repeat words the student heard. Not decided:
  continue the turn after the capped sentence, with a field in `done`.
- Not tested: `repetition_penalty` above 1.15, sampling temperature / top-k, `decode_batch_max_size: 1`, an L4, real
  catalog voices (both references were `say` clips), a listening check.

## Prova final ao vivo — Vast (2026-10-08)

Through a local gateway only (`bun serve.ts` on :4111, namespace `marcos-proof-vast`, this branch), from a Mac in
France on a mobile-carrier uplink (IPv4 behind carrier NAT). Two sessions: the first was cancelled 45 min in and left
no notes; the second took over its gateway state (stopped the process, started a new one on the same state dir: the
running replica was adopted, not replaced) and rebuilt what the first did from its gateway log. All times UTC.

**Not the final image.** `rg.fr-par.scw.cloud/aigw/speech-stack:20261008-0953` still answers 401 to an anonymous pull
and the gateway sends no registry credential to a Vast host unless the spec carries one (by design: the only
credential is the Scaleway API secret). So the stack was assembled at boot on the public `vllm/vllm-omni:v0.28.0`, as
in the section "Vast.ai RTX 5090" above: the stack's files from this repository at `d4a160e`, the same llama.cpp
build, the same three models, and the edge copied out of the public `ghcr.io/marcosremar/aigw-edge:<tag>` into
`/opt/aigw-edge` (same layout as the final image: edge as a process in the one container). Env `STT_BATCH=8`,
`LLM_PARALLEL=16`, `TTS_STAGE0_MB=9600`, `realtime.maxSessions` 4. One `espeak-ng` reference voice.

### 1. Selection — the relative RTT gate

Spec: `RTX 5090`, `minCuda: 13`, `near: FR`, cap €0.57/h, `maxRttExcessMs` default 20 over `s3.fr-par.scw.cloud`.
Ranking at 10:15 (`GET …/offers`): France $0.576 (2062 / 835 Mbps down / up, reliability 0.993, 256 ports), two UK
hosts $0.509 (929 / 100 and 904 / 97), Slovakia $0.588 (899 / 495), Estonia $0.526.

| Rented (instance, host) | Where, $/h | Gate RTT vs Paris anchor | Verdict |
|---|---|---|---|
| 54825208, host 145971 | Slovakia, 0.588 | no answer in 8 min (first spec had `maxRttMs: 35`) | released, too far |
| 54826445, host 144664 | UK, 0.509 | 136 vs 71 ms, +65 | released, too far |
| 54826885, host 149234 | **France, 0.576** | 70 vs 47 ms, **+23** (one burst of samples) | released, too far — **a false rejection** |
| 54826952, host 144477 | Estonia, 0.526 | — | paused by hand after 79 s |
| 54827739 … 54827869 (six), host 144664 | UK, 0.509 | — | each paused by hand within 2–10 s (see below) |
| 54828002, host 136778 | Poland, 0.509 | 85 vs 59 ms, +26 | released, too far |
| 54828609, host 144664 | UK, 0.509 | 86 vs 52 ms, +34 | released, too far |
| 54828696, host 144163 | Poland, 0.562 | 67 vs 54 ms, +13 | would be kept; paused by hand |
| **54829050, host 149234, offer 53664694** | **France, 0.576 (0.592 with disk)** | **53 vs 47 ms, +6** | **kept** |

- The gate does what it was built for: it kept the French host and released UK (+34, +65), Poland (+26) and a host
  that never answered; a Polish host at +13 passed.
- The French host was first rejected at +23: one burst measured a noisy mobile uplink. Fixed in `9d5b828` (the lowest
  of three rounds); with it the same host measured +6 and was kept.
- Found, not fixed: (a) the "avoid this host for 24 h" memory is lost on a gateway restart (UK host 144664 was rented
  again after two rejections); (b) within the cap the walk takes the cheapest in the distance band, so the UK host
  kept winning the first try while France was on the market: the first session paused and resumed six times to get
  past it. The gate decides only after renting; each wrong try costs 1–5 min of machine.

### 2. Boot (instance 54829050)

- Request 10:42:45 → rented 10:42:46 → running with an address 10:43:20 (34 s) → gate passed 10:43:25 → **ready
  10:49:18: 6 min 33 s** (gateway `bootMs` 392562). Boot script marks: apt +2 s, edge installed +10 s, llama.cpp +76 s,
  wheels +85 s, models +155 s; `start.sh` 10:45:50, TTS up 10:48:39, LLM up 10:48:43 (20.2 GB of 32.6 GB in use).
- The edge starts in the container: `probe responder on udp/50008 (public udp/40234); public=82.65.197.236`,
  `GET /__aigw/rt/status` through the mapped TCP port answers `max: 4`, `workers: 1`, `udpPorts: [50000, 50008]`.
- Open point of `docs/realtime-edge.md` answered: the onstart shell **does** see `PUBLIC_IPADDR`, `VAST_TCP_PORT_80`
  and the nine `VAST_UDP_PORT_500xx` (`/etc/environment` has none of them).
- **The mapped UDP ports are not reachable on this host.** See item 3.

### 3. Realtime, 4 simultaneous learners

**WebRTC: did not connect on host 149234 — inbound UDP never arrives.** Evidence:

- The gateway's echo probe to `82.65.197.236:40234`: blocked, every round. The edge chose `path=ws` by itself and
  stopped listing `webrtc`; admission then offered only the `ws` rung (no doomed ICE attempt).
- From the Mac, by hand: STUN to two public servers answers (outbound UDP works); 4 datagrams to each of four mapped
  ports (40234, 40860, 40385, 40330): no reply; the edge's `probeHits` stayed **0** all along. TCP to 40007 (nginx)
  and 40796 (ssh) opens in 78 ms; TCP 40234 is refused at once (the host is there, the port is UDP-only).
- With the edge forced to `direct` (`POST /__aigw/rt/net`) and an aiortc client offering straight to it: the answer
  advertises exactly one candidate, `82.65.197.236 40860 typ host` (public address, mapped port of container port
  50000) — what it should. The client's pairs `host → 82.65.197.236:40860` stay `IN_PROGRESS` for 12 s; the edge's ICE
  stays `checking`. The client's own candidates: host addresses and one `srflx` behind carrier NAT, so the edge's
  outbound checks cannot open the path from its side either.
- Reading: our code asks Vast for the ports the documented way (`-p 50000:50000/udp` …), Vast publishes them and says
  which (`VAST_UDP_PORT_*`), the edge advertises them. The datagrams die between the host's public address and the
  container. `82.65.x.x` is a residential fibre range: a host behind a home router that forwards the TCP range only
  would look exactly like this. **A host limitation, not our code: on the second host the same spec connects** (below).

**WebRTC on a second host (instance 54838104, host 142399, offer 43624378, Estonia, $0.539/h, 0.563 with disk; 675 /
825 Mbps; rented only to answer the UDP question, with `maxRttExcessMs: 80`: gate RTT 80 vs 49 ms, +31, kept; edge
`04ce8636`).** Rented 11:50:00, address 11:55:50 (image pull 5 min 47 s), ready 12:09:28: **19 min 29 s** (slower host:
llama.cpp +163 s, models +320 s, TTS load 6 min 50 s against 2 min 49 s).

- The same echo by hand, 30 s after the edge started: 6 of 6 answered (67–103 ms), `probeHits` 6. The gateway's probe
  at ready: `inbound udp/17315: ok (68 ms)`, `path=direct`, admission lists `webrtc` and `ws`.
- **4 learners on WebRTC, real ICE: 8 of 8 sessions connected, pair `host/host`, straight to
  `89.221.67.180:<mapped port>`; the edge's ICE went `checking → completed` in 161–243 ms; `byTransport: {webrtc: 4}`.**
  First live WebRTC media on Vast.
- The harness needed a knob first: on this Mac (mobile uplink, a VPN interface, IPv6) aiortc's candidate gathering
  takes ~5 s and every learner failed at `gather` after the fixed 2 s, then rode `ws` (`webrtc:failed:gather 4`).
  `448068c`: `RTC_GATHER_S` / `RTC_CONNECT_S` (defaults unchanged); the runs below used 10 and 6. Connect p50 5.7–5.9 s
  is that gathering, not the replica.

| Run on the Estonian host | Transport | Turns | Failed | p50 | p95 | **max** | > 2.5 s |
|---|---|---|---|---|---|---|---|
| rtc4 (12:10; all four fell to ws at `gather`) | ws | 75 | 0 | 1130 | 1590 | 1841 | 0 |
| rtcB (12:16) | webrtc | 73 | 2 `filtered` | 1762 | 2361 | 3041 | 2 |
| rtcC (12:22) | webrtc | 78 | 15 `filtered` | 2037 | 2783 | 4001 | 9 |
| **WebRTC pooled** | webrtc | **151** | **17 (11 %)** | **1894** | **2678** | **4001** | **11** |

- **WebRTC connects but does not meet the target on this path**: p50 1.9 s, max 4.0 s, and in 17 turns the learner's
  speech reached the STT damaged (the edge's hallucination guard dropped the transcript: `filtered`, no reply). Same
  host, same hour, `ws`: 75 of 75, p50 1130, max 1841. The UDP path here is a mobile uplink to Estonia; the harness
  has shown the same direction on Scaleway (aiortc WebRTC ~0.4 s slower than `ws` from this Mac). Not separated: how
  much is the host's route and how much the Mac's uplink. A French host with open UDP was not on the market to try.
- The Estonian host is also slower per turn than the French one at the same load (stt 311 vs 198 ms, llm first token
  218 vs 77 ms): same card, different machine around it.

**WS (the rung the edge fell back to), 4 learners, clean network, harness `scripts/realtime-e2e/load.ts --n 4
--duration 360 --ramp 8 --turn-every 18 --jitter 3 --clip turn.wav`, audible first-audio meter** (ms from the last
voiced sample sent to the first non-silent audio received at the Mac, through the gateway's ws relay):

| Run | Turns | Failed / truncated | p50 | p90 | p95 | p99 | **max** | ≤ 1.0 s |
|---|---|---|---|---|---|---|---|---|
| ws4b (11:03) | 78 | 0 / 0 | 928 | 1309 | 1659 | 2358 | 2358 | 73 % |
| ws4c (11:34) | 79 | 0 / 0 | 896 | 1236 | 1401 | 1552 | 1552 | 84 % |
| ws4d (11:41) | 78 | 0 / 0 | 881 | 1017 | 1166 | 1593 | 1593 | 89 % |
| **pooled** | **235** | **0 / 0** | **900** | **1134** | **1353** | **1823** | **2358** | **82 %** |

- Target: p50 under 1 s — **met** (900 ms); never above 2500 ms — **met** (max 2358; 2 of 235 turns above 2 s).
- Edge's own numbers (ws4d): time to first audio after its endpointing p50 93, p95 280 ms; stt 198, llm first token
  77, tts first chunk 81 ms; first sound from the end of speech p50 797, max 1115 ms. The rest of the 900 ms is the
  endpointing (~670 ms) and the path Mac → gateway on the Mac → replica and back. Session connect p50 127–186 ms,
  admission 1–52 ms, no rejection, no reconnect.
- Machine during the runs: GPU memory peak 24.97 of 32.6 GB, STT largest batch 8, `oom_retries` 0.
- Run ws4b asked for 2 of the 4 learners on WebRTC (`--rtc 2`): both got the `ws` rung at admission (ICE pairs: none).

### 4. Complete replies

- 235 turns in the three runs: **0 failed, 0 truncated, 0 early endings**; audio length per reply character between
  62 and 81 ms (median 69): no runaway, no short reply. Edge telemetry over the machine's life: 339 `edge.turn.done`
  with `outcome: ok`, **`ttsRetries` 0 in all, no `edge.tts.retry`**; stack health: speech 1225 started / 1225 done,
  0 failed, 0 stalled; chat 433 / 433.
- **One real failure, in the first long run (ws4, 4 sessions of 940 s): 96 of 199 turns failed** (92 `interrupted`,
  4 `timeout`). Cause, from the replica's LLM log: `request (2620 tokens) exceeds the available context size (2048
  tokens)`. The edge sends the system prompt plus the whole history, the stack runs llama.cpp at 2048 tokens per
  slot: with a 451-token system prompt a session dies at its ~26th turn (~7.5 min at this cadence). The edge
  (`666c0327`) then hung the turn — `think()` raised before closing its sentence queue — and every later turn of that
  session ended `interrupted`. Not a Vast matter: the Scaleway proof hit the same on the final image.
- Fixed here, `04ce863`: the turn now ends with `error` + `done{error}` and `edge.upstream.error` (stage `llm`, status
  400) — regression test `llm_failure` in `docker/aigw-edge/tests/test_session.py` (fails on the old code: hangs).
  **Not fixed**: the cause. A session that outgrows the context now fails every turn loudly instead of silently; the
  edge needs a history budget (or the stack a larger `LLM_SLOT_CTX`) before sessions longer than ~7 min.
- To reach a machine the fix needs `EDGE_TAG=04ce8636` in `docker/speech-stack/Dockerfile` (today `666c0327`) and a
  rebuild of the speech-stack image; `ghcr.io/marcosremar/aigw-edge:04ce8636` is already published.
- Second host, edge `04ce8636`: 226 turns ended at the edge, 209 `ok`, 17 `filtered` (the WebRTC uplink above),
  `ttsRetries` 0, no `edge.tts.retry`, no `edge.upstream.error`; speech 738 / 738, chat 209 / 209; audio per reply
  character 57–80 ms. Over both hosts: **461 turns answered, 0 early endings, 0 TTS runaways, 0 TTS retries.**

### 5. Teardown

- French host: `DELETE /v1/deployments/vast-rt` 11:49:10 → 25 s later 0 deployments, 0 replicas, TCP 40007 and 40796
  refused. Estonian host: `DELETE` 12:29:06 → the same (TCP 16868, 16835 refused).
- While the French host was up, the reaper's dry run in `gateway-down` mode (pointed at a dead port) listed exactly
  one instance in the namespace, `vast-rt/54829050`: nothing left over from the 13 earlier rentals. The plain dry run
  against the live gateway says `seen: 0` whatever exists (`skipped: no admin key: cross-check off`): not a proof.
- After the last delete, with the local gateway stopped (12:31:40), the same `gateway-down` dry run:
  `{"provider":"vast","seen":0}`, `{"provider":"scaleway","seen":0}`, `planned: []`. Nothing rented in
  `marcos-proof-vast`. The first session's 15:10 dead-man loop and the watcher were stopped; port 4111 is free.

### Cost

| | Minutes | $/h with disk | $ |
|---|---|---|---|
| 13 rentals released by the gate or paused (10:15–10:41) | ~21 | 0.52–0.60 | ~0.19 |
| France, 54829050 (10:42:46–11:49:10) | 66.4 | 0.592 | 0.66 |
| Estonia, 54838104 (11:50:00–12:29:07) | 39.1 | 0.563 | 0.37 |
| **Total** | **~127 (2 h 14 min of wall clock)** | | **~1.21** |

One machine at a time; never above $0.60/h. Figures from the gateway's rental log and the offers' prices, not from
Vast's invoice.

### What blocks Vast for class overflow

1. **The image.** The final speech-stack image cannot be pulled there (private registry, no pull-only credential).
   Assembled at boot the stack took 6.5 min on one host and 19.5 min on another; a public or pull-only copy is the
   first step, and it is also the only way the proof runs the exact image.
2. **UDP is per host and unknown before renting.** One of two hosts dropped every inbound datagram. The gateway copes
   (probe → `ws`), and `ws` met the target on that host, so this does not block a `ws` overflow; it blocks counting on
   WebRTC. Nothing in the offer says which hosts forward UDP; the reachability result is not fed back into the
   placement (a host could be released, or remembered, when `udpInbound` is blocked and WebRTC is wanted).
3. **Placement is a lottery at this price.** 14 rentals for one kept French host; the gate's memory of bad hosts does
   not survive a restart; under the cap the cheapest host in the band wins the first try even when a nearer one is
   listed. Time from request to a kept host: 27 min in the first session (with a wrong first gate and a restart).
4. **Sessions die at ~26 turns** (context per slot against an unbounded history) — every provider, see item 4.
5. Capacity was measured at 4 learners only; nothing about 8, a degraded network, a phone, or a second replica.

### Not run

The final image itself; WebRTC from a French Vast host; WebRTC from a browser (Chrome) or a phone; TURN (none
configured on this gateway); more than 4 learners; a session surviving the replica's replacement; `image_login`.

## Prova final ao vivo — Scaleway (2026-10-08)

**Side check, 13:28 Europe/Paris — who holds the second L4 of the quota (production `parle-qwen-tts` is `degraded`,
`quotas_exceeded` on `cp_servers_type_L4_1_24G`, 2 of 2).** Read-only list of every server of the project in the nine
zones (running and stopped). The two L4 are:

| Server | Name | Type | State | Created (UTC) | Tags |
|---|---|---|---|---|---|
| `7057e331-d393-4e04-bc33-5373d5eb091a` fr-par-2 | `aigw-parle-qwen-tts-muzfcxpd` | L4-1-24G | running | 2026-10-08 10:59:54 | `aigw-ns-prod`, `aigw-dep-parle-qwen-tts` — production's own replica |
| `54b19a13-36c0-48e9-b665-c81a17b659a8` fr-par-2 | `aigw-parle-speech-muy11qri` | L4-1-24G | **stopped** | 2026-10-07 11:31:31 | `aigw-ns-dev-mrt-e2e`, `aigw-dep-parle-speech` |

The one holding the quota is **`54b19a13…`, stopped since 2026-10-07 11:31 UTC, namespace `dev-mrt-e2e`** (with its
`aigw-turn-muy11qcw` DEV1-S `62ed6752…`, `stopped in place`, same namespace and minute). It is not of this proof
(`marcos-proof-scw`) nor of any `marcos-*` namespace: **not touched**. Also in the project, not L4: two stopped
`aigw-whisper-stt-*` POP2-HC-4C-8G (`aigw-ns-dev-marmos`, 2026-10-07) and this proof's one L40S (`926bec0d…`,
`aigw-ns-marcos-proof-scw`). No L4 is or will be used by this proof.

### What ran

One replica, **L40S-1-48G fr-par-2, `fr-par-2:926bec0d-28d4-4554-8856-681fe1415def`, €1.4699/h**, created 12:47:45
Europe/Paris, `ready` 12:56:07 (501 s), through a local gateway only (`bun serve.ts` on :4110 at this branch, namespace
`marcos-proof-scw`, `DEPLOYMENTS_PROBE_PORT=8080`, `DEPLOYMENTS_MAX_REPLICAS=2`, `DEPLOYMENTS_MAX_EUR_PER_HOUR=3.2`,
`S2S_DEPLOYMENT=proof-speech`, parle's `MODEL_ROUTES`). Spec: image `rg.fr-par.scw.cloud/aigw/speech-stack:20261008-0953`,
edge `ghcr.io/marcosremar/aigw-edge:d4a160e4`, `placements: []`, `envByMachineType` of the profile (`RT_MAX_SESSIONS` 4,
`STT_BATCH` 8, `LLM_PARALLEL` 16), `maxHours` 2.5, one catalog voice, a 509-token Portuguese shop-clerk system prompt,
`opener.lines` (4 lines), a 4.5 s Portuguese clip. Models unchanged (Whisper large-v3, Qwen3.5-9B Q4_K_M, Qwen3-TTS).
A first session was cancelled at 13:20 with the replica up; this one restarted the gateway on the same state dir at
13:23 and took the replica back (nothing created twice). Production was checked read-only before every create: no L40S
in use (one L4, `parle-qwen-tts`).

Clock of every latency: last voiced sample sent → first non-silent audio received (the edge's 700 ms endpointing is
inside). Clients: `ws` (Bun) from the Mac through the gateway's WS relay; `webrtc` = aiortc from a Linux container on
the Mac (6 vCPU, `host/host` UDP straight to the replica; aiortc fails ICE gathering on macOS); Chrome = the real SDK
with the audible meter. Default duty cycle (a turn every 15 ± 5 s) unless said. All numbers are this one replica.

### 1 and 2 — four learners on one replica, first sound and the 2500 ms ceiling

| Start | Client × 4 | Turns ok / attempted | First sound p50 / p95 / max ms | ≤ 1.0 / 1.5 / 2.0 s % | Over 2500 / 3000 ms | Openers, deadline missed | Edge after endpointing p50 / p95: ttfa · stt · llm · tts |
|---|---|---|---|---|---|---|---|
| 12:57 | ws, 210 s | 45 / 45 | 1021 / 1375 / 1632 | 35.6 / 95.6 / 100 | 0 / 0 | 0, 0 | 250/591 · 207/403 · 139/335 · 234/306 |
| 13:44 | ws, 300 s | 69 / 69 | 1083 / 1474 / 1814 | 31.9 / 95.7 / 100 | 0 / 0 | 0, 0 | 280/641 · 207/416 · 170/294 · 241/349 |
| 13:54 | ws, 300 s | 67 / 67 | 1074 / 1564 / 1802 | 22.4 / 86.6 / 100 | 0 / 0 | 0, 0 | 274/698 · 206/405 · 171/308 · 243/359 |
| 14:18 | ws, 300 s | 73 / 73 | 1044 / 1694 / 1794 | 30.1 / 87.7 / 100 | 0 / 0 | 0, 0 | 251/716 · 207/411 · 153/360 · 236/332 |
| 13:39 | webrtc, 300 s | 67 / 68 | 1475 / 1977 / 2185 | 0 / 54.4 / 95.6 | 0 / 0 | 0, 0 | 248/562 · 209/414 · 160/295 · 234/289 |
| 13:49 | webrtc, 300 s | 67 / 67 | 1613 / 2096 / 2222 | 0 / 34.3 / 92.5 | 0 / 0 | 2, 0 | 265/903 · 209/425 · 145/399 · 239/339 |
| 14:23 | webrtc, 300 s | 70 / 70 | 1461 / 2032 / 2351 | 0 / 55.7 / 94.3 | 0 / 0 | 1, 0 | 260/739 · 208/416 · 159/321 · 235/317 |
| 14:00 | webrtc, 1000 s, a turn every 42 ± 8 s (the seated learners of item 3) | 94 / 96 | 1748 / 2216 / 3073 | 0 / 14.6 / 87.5 | 2 / 1 | 0, 0 | 246/456 · 209/386 · 153/207 · 232/292 |
| 13:26 | ws, 630 s | 117 / 146 (see item 5) | 1230 / 2328 / 4423 | 16.4 / 54.8 / 72.6 | 5 / 4 | 7, 0 | 279/875 · 207/410 · 169/383 · 235/336 |
| 14:28 | ws, `--burst --jitter 0 --turn-every 20`, 150 s (the four end their speech together) | 28 / 28 | 1747 / 1983 / **2013** | 0 / 3.6 / 96.4 | 0 / 0 | 6, 0 | 977/1934 · 397/732 · 465/559 · 402/426 |
| 13:00 | Chrome forced on webrtc, audible, 210 s (first session; the four pages start together and speak almost in step) | 55 / 56 | 2125 / 2607 / 2815 | 0 / 0 / 26.8 | 4 / 0 | 13, 0 | 968/2407 · 400/772 · 465/570 · 379/435 |

Pooled, lightweight clients at the default duty cycle:

| | n | p50 | p95 | max | ≤ 1.0 / 1.5 / 2.0 s % | Failures |
|---|---|---|---|---|---|---|
| `ws` × 4, four runs | 254 | 1042 | 1630 | 1814 | 29.9 / 90.9 / 100 | 0 |
| `webrtc` × 4, three runs | 204 | 1509 | 2032 | 2351 | 0 / 48.5 / 94.6 | 1 (a turn before admission: the slot of the previous run was still held) |

- **WS meets the owner's target** (p50 1.0 s, p95 1.6 s, max 1.8 s, nothing above 2 s). **WebRTC is 0.45 s slower at the
  same edge times** (edge `ttfa` after endpointing 248–265 ms p50 on both): the end of speech reaches the edge's VAD
  855 ms after the last voiced sample on the aiortc path (p50; 700 ms of it is the endpointing), and aiortc has no
  adaptive jitter buffer. p50 1.5 s, p95 2.03 s (30 ms over the 2 s line), max 2.35 s. A single learner: ws 832 ms,
  webrtc 1416 ms.
- **The ceiling as a MAX.** On the edge's own clock (speech heard → first sound queued) no turn of any run is late:
  max 1875 ms over the `ws` runs (the aiortc client does not record it), `deadline_missed` 0 in 729 turns, and in the burst — where the reply audio alone would have come at up
  to 3303 ms — the opener kept the first sound at **2013 ms max** (6 openers in 28 turns). On the learner's clock
  **7 of 702 lightweight turns started after 2500 ms** (5 on ws in one run, 2 on webrtc; 5 of them after 3000 ms, max
  4423), all in two windows of about 15 s (13:32:46–13:33:05, four sessions; 14:00:17–18, two sessions) and with
  the same signature: the VAD's end-of-speech event came 2.0–4.4 s after the last voiced sample instead of 0.7–1.0 s,
  and the edge then answered in 100–490 ms (one of the seven had its opener at the deadline and still reached the
  client at 2512 ms). The audio arrived late at the edge (uplink of this Mac or its relay; the
  cause was not isolated); the deadline counts from the speech the edge hears, so an opener cannot cover an uplink
  stall. The four Chrome turns over 2500 ms (max 2815) are audible latency of four headless Chromes on a loaded Mac
  speaking in step; `received` on the same turns is p95 2154, max 2176 ms.

### 5 — complete replies

729 turns of the lightweight clients on the GPU (the ten runs above; 697 `ok`): audio per reply character **63.5–94.4 ms (p1 64.8, p50 72.4, p99 87.9)** — no reply shorter than 0.6 × or
longer than 1.6 × the median, so **0 early endings and 0 runaways** by length. `tts_retries`: 0 in the 171 turns
measured after the harness stopped dropping the field (`36b11b2`; the 526 turns before it carry no count); replica
`/health` at 13:37 after 736 TTS calls: `failed` 0, `stalled` 0. Failures, all explained:

| Count | Outcome | Cause |
|---|---|---|
| 25 + 4 | `failed:interrupted`, `truncated:no_done_after_audio` | **found here**: from its 26th–28th turn every session of the 630 s run died. llama.cpp answers `400 exceed_context_size_error` (2048 tokens per slot, 509-token system prompt, the history grows by ~60 tokens a turn); edge `d4a160e4` then hangs the turn and every later turn ends `interrupted`. Reproduced by hand on the replica's `/v1/chat/completions`: 20 turns of history → 200 (1696 prompt tokens), 26 → 400 (2062). |
| 1 + 1 | `failed:session_lost`, `truncated:lost_after_audio` | the edge's 15 min per session (`RT_MAX_SESSION_SECONDS`) closed the four seated sessions at 900 s; they were back in 2.1–2.5 s (one `503 saturated` each, then admitted). By design. |
| 1 | `failed:admission:saturated` | a run started 7 s after the previous one, whose slot was still counted |

The hang is fixed by `04ce863` (the Vast session saw the same thing) and the cause by **`db8c0f4`**: on that 400 the
edge drops the oldest half of the history and asks once more (`edge.llm.history_trimmed`; regression scenario
`history_overflow` in `docker/aigw-edge/tests/test_session.py`, fails on the parent commit, 82 checks green after).
Edge image `ghcr.io/marcosremar/aigw-edge:db8c0f4d` built (Actions run 37772561492). An edge image reaches a replica only at creation and no second L40S
could be created (item 3), so **no replica ran `db8c0f4d`**. What was run instead, 14:50: the edge's own `Session` and
`Upstream` code on the Mac against this replica's models (through the gateway's `invoke`), one spoken turn on top of a
30-turn history — parent commit: `transcript`, `error` (`llm http 400 … request (2317 tokens) exceeds the available
context size`), `done{error}`; `db8c0f4`: `edge.llm.history_trimmed {dropped: 30, kept: 30}`, the LLM answered and the
reply went to TTS (which fails off the replica: the catalog voice's reference file is local to it). The runs after
13:36 were kept under 24 turns per session. With edge `d4a160e4` a conversation of more than about 25 turns with this
prompt dies.

### 6 — LLM streaming through the deployment

13:25, 20 × `POST /v1/chat/completions` (`parle-llm`, `stream: true`, the 509-token system prompt, `max_tokens` 80), all
served by `deployment:proof-speech`: **first token p50 231, p95 365, max 423 ms** from the request at the local gateway;
18–32 content chunks per answer, spread over 150–285 ms (streamed, not one block).

### 3 — overflow: learners 5..8 while one replica is up

`PATCH {"maxReplicas": 2, "realtime": {"edgeImage": "…:db8c0f4d"}}` at 13:59:59, then four aiortc learners seated on
the replica (1000 s) and the overflow in two forms: four Chrome learners on the SDK's own ladder (14:04:48, 635 s) and
four clip-rung learners of the harness (`--s2s 4`, 14:41, 220 s, with four other aiortc learners seated).

| Phase | Time | What happened |
|---|---|---|
| 4 learners seated | 13:59:59–14:00:10 | `realtime {active: 4, capacity: 4}` |
| Second replica asked | 14:00:38 (28 s after the 4th seat; the rule is 20 s above 75 %) | `autoscale: desired 2, "load … > 75% of 1×6 (2 asked, waiting for 1)"`, `scalingOut: true` |
| Second replica created | **never** | `L40S-1-48G out of stock in fr-par-2` on every create from 14:00:38 to 15:05 (and in pl-waw-2, added as a second placement at 14:11 and retried every 45 s with the back-off cleared): 81 creates failed, each half-created server deleted by the backend (provider list at 14:36 and after the teardown: nothing left). No L4 was substituted. |
| Learners 5..8 refused | 14:04:49 | `POST /v1/realtime/sessions` → `503 saturated` (108 refusals over the run: the SDK asks again in the background, as designed) |
| Learners 5..8 answered | 14:04:51–14:15:23 | **172 turns on `/v1/s2s`, all `provider: composite, fallback: saturated`**, 170 complete, 2 `client went away` (the pages closing); every chat and STT stage call logged `deployment:proof-speech failed (HTTP 503): every ready replica is at capacity → next provider` — the GPU answered none of them. Gateway `s2s.first_audio` 1701–1703 ms from the request in all 172 (the opener at the deadline). |
| New learners on the second replica | not run | no second replica |

The seated learners, same run, before and during the overflow:

| | n | First sound p50 / p95 / max ms | Edge ttfa p50 / p95 · stt · llm first token |
|---|---|---|---|
| 14:00–14:04:48, alone | 28 | 1747 / 2785 / 3073 (the two late-uplink turns of item 2) | 236/456 · 210/386 · 142/190 |
| 14:04:48–14:15, with 4 learners on the fallback | 67 | 1750 / 2166 / 2303 | 250/401 · 208/383 · 173/207 |
| 14:40–14:45, with 4 clip-rung learners on the fallback | 68 | 1585 / 1957 / 2013 | 252/540 · 207/394 · 143/268 |

The overflow turns with the harness's own meter (`--s2s 4`, 53 turns, clock from the request minus the 700 ms a page
waits): route `composite (fallback saturated)` 53 of 53, STT `openrouter:openai/whisper-large-v3-turbo`, LLM
`openrouter:google/gemini-2.5-flash-lite` 51 (qwen3.5-9b 1, llama-3.3-70b 1; the first link timed out), TTS
`openrouter:microsoft/mai-voice-2.1-flash`; 0 failed, 0 refused.

| | n | p50 | p95 | max |
|---|---|---|---|---|
| First sound = the opener, ms from end of speech | 53 | 1703 | 1707 | 1708 |
| **First audio of the reply**, ms from end of speech | 53 | **4927** | **13420** | **18868** (13.2 % ≤ 3 s, 50.9 % ≤ 5 s) |
| Stage: STT · LLM first token · TTS first byte, ms | 53 | 2662 · 479 · 699 | 11529 · 1580 · 1145 | 15515 · 2656 · 1397 |

- **The seated learners are not hurt**: the edge's stage times are the same with and without the overflow, and no
  overflow turn reached the GPU.
- **The overflow learners hear an opener on time (1.7 s) and then wait**: the reply starts at 4.9 s p50 and 13.4 s
  p95 because OpenRouter's Whisper took 2.7 s p50 and up to 15.5 s this afternoon (this morning's run of the same chain,
  § Fallback under load, had the first audio at 3.0 s p50). The fallback has no second STT link (no `GROQ_API_KEY` in the dev API). 28 of the
  53 are flagged `truncated:short_audio` by the harness; as this morning that ratio is tuned on the GPU voice (the
  MAI voice plus a 1.1 s opener gives 160 ms per character) and none has a hard sign of a cut (`done` in all,
  `spoken` = `sentences`).
- The first try of the Chrome overflow (14:00:44) got `503 no stt model for the composed fallback` on `/v1/s2s`: this
  test gateway had no `S2S_*_MODEL` and no app routes, and the harness config carried no `models`; fixed in the test
  config (`models: {stt, chat, tts}` = parle's aliases), not a defect of the branch. The Chrome run's own report is
  empty (`chrome:failed:evaluate` × 4 at collection, Mac load average 8.2), so its numbers above are the gateway's.

### 4 — scale-in with a seated learner

**Not run**: it needs a surplus replica and the second L40S never came.

### Teardown and cost

`DELETE /v1/deployments/proof-speech` at 15:09:26 → `[scaleway] Terminated server 926bec0d…` 15:09:27, its volume
deleted 15:09:39. Provider list of the project (nine zones, running and stopped) at 15:10: no server tagged
`aigw-ns-marcos-proof-scw`. Local gateway stopped; `GATEWAY_URL=http://localhost:4110
DEPLOYMENTS_NAMESPACE=marcos-proof-scw bun scripts/reap-orphans.ts` (dry run, gateway down): `seen: 0` on Scaleway and
on Vast, nothing planned. While the gateway was up the same dry run says nothing (`skipped: no admin key`: the
cross-check needs an admin key that is not the `SANDBOX_TOKEN`), so the provider list is what was used during the run.

One machine: L40S-1-48G, 12:47:45–15:09:27 = **142 machine-minutes, about €3.47**. Fallback turns on OpenRouter: 225,
about $0.45 at this morning's $0.002 per turn. No L4, no second L40S (81 creates refused for stock, none billed past
its cleanup), nothing written to production.

### Verdict

| # | Item | Result | Number |
|---|---|---|---|
| 1 | 4 learners on one replica | **passed on WS; WebRTC on the line** | ws n 254: p50 1042, p95 1630, max 1814 ms · webrtc (aiortc) n 204: p50 1509, p95 2032, max 2351 ms · Chrome audible, 4 in step: p50 2125, p95 2607, max 2815 ms |
| 2 | First-audio deadline + opener | **passed on the edge's clock, not as an absolute maximum for the learner** | `deadline_missed` 0 of 729; burst: first sound max 2013 ms with 6 openers (reply alone up to 3303); 7 of 702 turns over 2500 ms at the client (max 4423), all with the speech arriving 2.0–4.4 s late at the edge |
| 5 | Complete replies | **passed on length, one defect found and fixed** | 729 turns: 0 early endings, 0 runaways (63.5–94.4 ms of audio per character), `tts_retries` 0 of 171; 29 turns lost to the context overflow of edge `d4a160e4` (fixed: `04ce863` + `db8c0f4`, image `db8c0f4d`, not run on a replica) |
| 3 | Overflow | **partly**: fallback and scale-out request proven, second replica **not run** (out of stock 14:00–15:09) | 225 overflow turns, 0 on the GPU, 0 failed; opener at 1.70 s, reply at 4.9 s p50 / 13.4 s p95 (OpenRouter STT); seated learners unchanged (edge ttfa 236–252 ms p50); second replica asked 28 s after the 4th seat |
| 4 | Scale-in with a seated learner | **not run** | needs the second replica |
| 6 | LLM streaming via deployment chat | **passed** | first token p50 231, p95 365, max 423 ms (n 20) |

Open before the merge: (a) no replica has run the edge that survives a long conversation (`db8c0f4d`) — every number
above is edge `d4a160e4`, which is the same code but for the two commits; (b) the two-replica behaviour (new learners
seated on the second replica, upgrade of the fallback learners, scale-in with a seated learner) has only its unit and
simulator coverage; (c) an overflow learner waits 5 s for the reply at this hour, on one STT link.

## Fallback fast: second STT link, hedge and stage budget (2026-10-08, `rt/fallback-fast`)

The overflow learners of the proof above waited 4.9 s p50 / 13.4 s p95 / 18.9 s max for the reply because the composed
fallback had one STT link (`openrouter:openai/whisper-large-v3-turbo`, 2.7 s p50 and up to 15.5 s that afternoon). No
machine, no GPU, production untouched; a local gateway of this branch (`DEPLOYMENTS_ENABLED=0`, `--no-wake`) against the
real OpenRouter, about $0.40.

### Where the time goes (composed path, stages are serial)

| Stage | Morning, healthy (1,769 turns, § Fallback under load) p50 / p95 | Afternoon proof (53 turns) p50 / p95 / max | What it is |
|---|---|---|---|
| Endpointing (client) | 700 | 700 | the page waits 700 ms of silence before it posts the clip |
| STT | 670–790 / 1190–2310 | 2662 / 11529 / 15515 | one upload + one whole-clip transcription; nothing can start before it ends |
| LLM first token | 660–700 / 820–1720 | 479 / 1580 / 2656 | starts when the transcript exists (already immediate) |
| first clause cut | 90–110 / 190–2000 | — | the eager cutter (clause mark after 3 words) is the one in use |
| TTS first byte | 790–840 / 950–1080 | 699 / 1145 / 1397 | MAI voice answers each sentence whole (first byte = whole clause) |
| **First audio of the reply, from end of speech** | **3.0–3.2 s / 3.7–5.5 s** | **4.9 s / 13.4 s / 18.9 s** | sum of the above |

Why 15.5 s on a stage whose budget is 8 s: the stage answered `503` at its 8 s budget and the loopback client
(`retryStage`, meant for a replica that answers 502/503 at once while it boots) ran the whole stage a second time.

Serial by nature: LLM after STT, TTS after the first clause. Already overlapped: the opener at the deadline, TTS of the
next sentences (`ttsParallel` 2). Checked and left alone: the OpenAI SDK clients are cached per base URL + key and the
connection is reused (the gateway adds nothing measurable: the same model through the gateway 534 ms p50, direct
601 ms); the clip is forwarded as received, with no re-encoding (a 4 s turn is 160 kB of 16 kHz PCM WAV).

### What changed

- **STT hedge at 900 ms** (`STT_HEDGE_MS`, `S2S_STT_HEDGE_MS`): the composed turn sends `x-gateway-hedge-ms: 900` on
  its STT sub-request whether or not a first-audio deadline is set (before: `deadline − endpoint`, 1300 ms, and only
  with a deadline or an opener). 900 ms ≈ 1.3 × the healthy p50 of the first cloud link (670–790 ms). It is the
  existing `runTargets` hedge: the next link starts in parallel, the first good answer wins, the loser is aborted;
  `route.hedge` and `route.served {raced: true}` are emitted, the answer says `X-Gateway-Fallback: slow`. A link that
  errors still hands over at once.
- **STT stage budget of 3 s** (`STT_BUDGET_MS`, `S2S_STT_BUDGET_MS`): new sub-request header `x-gateway-budget-ms`
  (same trust rule as the hedge cap: only the gateway's own loopback sub-request), which caps the route's
  `GATEWAY_STT_BUDGET_MS` (8 s). Both links slow → `503 … timed out` at 3 s.
- **No second run of a stage that used its time**: `retryStage` retries only a failure that came within 1 s
  (`STAGE_RETRY_WITHIN_MS`) and inside the stage budget. This is what turned 8 s into 16 s; it applies to the three
  stages.
- App budget: unchanged and counted once per turn (`checkS2S`); stage sub-requests were never charged to the app. A
  hedged turn is two provider calls (both visible in telemetry) and one app request.

### The second link exists today, with the key the gateway already has

No new credential is needed. The dev API serves `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` and `NVIDIA_API_KEY`; it has
no `GROQ_API_KEY`, `DEEPGRAM_API_KEY`, `FIREWORKS_API_KEY` or `OPENAI_API_KEY` (so the `groq` entry of `parle-stt`
is `no_key`, and the gateway has no Mistral or NVIDIA STT provider). OpenRouter itself serves other transcription
models on `/audio/transcriptions`, each with its own upstream and its own breaker (`stt:openrouter:<model>`). Same
4 s Portuguese clip, 20 sequential calls each, 2026-10-08 ≈ 15:35 CEST, direct:

| OpenRouter model | p50 | min – max | Price per second of audio | Transcript |
|---|---|---|---|---|
| `openai/whisper-large-v3-turbo` (today's only link) | 2030 | 334 – 22015 | $0.0000033 | exact |
| `openai/whisper-large-v3` | 760 | 591 – 1575 (1 of 20 failed) | $0.0000075 | exact |
| `deepgram/nova-3` | 601 | 449 – 1097 | $0.0000717 | exact |
| `qwen/qwen3-asr-0.6b` (3 calls) | 1255 | 1035 – 1307 | $0.0000033 | no punctuation |
| `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b` (3 calls) | 1321 | 1226 – 1865 | $0.0000033 | no commas |
| `nvidia/parakeet-tdt-0.6b-v3` (3 calls) | 2328 | 1942 – 2518 | $0.000025 | exact |

`openai/gpt-4o-mini-transcribe`, `mistralai/voxtral-mini-transcribe`, `x-ai/grok-stt-1.0` and
`google/gemini-3.5-transcribe` answer `404 0 endpoints available` for this account. Minutes later the same nova-3 call
measured 1371 ms p50: every number here is one noisy afternoon.

**To do in parle** (`backend/speech/gateway-routes.ts`, `parle-stt`; this branch does not touch the app's routes): put
`{ provider: "openrouter", model: "deepgram/nova-3" }` after the deployment and keep a Whisper behind it, e.g.
deployment → `openrouter:deepgram/nova-3` → `openrouter:openai/whisper-large-v3`. **Order of rollout: the route first.**
With one link and the 3 s budget a slow Whisper becomes a failed turn (first row below) instead of a late one;
`S2S_STT_BUDGET_MS=8000` restores the old wait until the route is in. **Superseded by § Integration (2026-10-08): the
3 s budget now applies only when the route has two usable cloud links, so the order of rollout no longer matters.**

### Measured, three chains at the same time

`load.ts --n 4 --s2s 4 --no-wake`, 110 s, a turn every 8 ± 2 s, the same 4 s clip, a 100-token system prompt, 3
messages of history, opener on (deadline 2000 ms), LLM chain qwen3.5-9b → gemini-2.5-flash-lite (the first link's
breaker was open all afternoon, as in the proof), TTS MAI flash. Clock: from the end of the speech (request − 700 ms).

| STT chain | Turns | Failed (STT `503` at 3 s) | First sound (opener) p50 / max | Reply first audio p50 / p95 / max | ≤ 3 s / ≤ 5 s | STT stage p50 / p95 / max | Served by |
|---|---|---|---|---|---|---|---|
| Scaleway proof (before, old code, one link) | 53 | 0 | 1703 / 1708 | 4927 / 13420 / 18868 | 13 % / 51 % | 2662 / 11529 / 15515 | whisper turbo 53 |
| whisper turbo alone, this branch | 54 | **28** | 1703 / 1724 | 3429 / 4614 / 4762 | — | 1239 / 2460 / 2680 (of the 26 answered) | whisper turbo 26 |
| whisper turbo → nova-3, this branch | 52 | 1 | 1703 / 1722 | 3346 / 5351 / 7518 | 39 % / 90 % | 1114 / 2395 / 2693 | turbo 21, nova-3 30 (13 hedged, 17 with the first link's breaker open or cooling) |
| nova-3 → whisper-large-v3, this branch | 51 | 1 | 1703 / 1712 | **3099 / 4300 / 5481** | 39 % / 96 % | 999 / 1658 / 2093 | nova-3 48, whisper 2 hedged |

Other stages in the three runs: LLM first token 354–400 p50, 990–1603 p95, up to 2821; TTS first byte 853–906 p50,
1027–1176 p95, up to 1776. In the 7.5 s turn the STT took under 2.7 s: what is left of the tail is the LLM first token
and the voice. One run each, about 50 turns: read ± 0.5 s on every p95.

### Verdict on 2500 ms as a maximum

Not attainable on this path, and not as a median either. The first **sound** (the opener) is at 1.70 s in every turn.
The first audio of the **reply** is three serial cloud calls after a 700 ms endpointing: with every link healthy
0.7 + 0.6 + 0.4 + 0.1 + 0.85 ≈ 2.65 s from the end of the speech (reasoned from the per-stage p50s; measured 3.0–3.4 s),
and each stage has a p95 near twice its p50. What this branch buys is the tail: a maximum of 5.5–7.5 s where it was
18.9 s, and a turn that cannot be answered ends at about 3.7 s.

What would meet it (not built, rough numbers):

- **Seats on a GPU instead of the fallback.** The fallback is not cheap: $0.47 per learner-hour (97 % the voice), i.e.
  ≈ $12/h for 26 overflow learners. Eight L40S (4 seats each) are €11.8/h when there is stock; a Vast RTX 5090 is
  $0.55–0.80/h for 4 seats (server first audio 1154 ms p50 at 4, § Vast.ai RTX 5090), ≈ $4.4–6.4/h for the same 30
  learners — blocked today by the image pull and the placement lottery (§ What blocks Vast for class overflow).
- **Streaming STT while the learner speaks** (the clip rung posts a finished clip, so this needs the `ws` rung or a
  streaming upload): the transcript exists at the end of the speech and the 0.6–1.0 s STT stage disappears into the
  endpointing. `nvidia/nemotron-3.5-asr-streaming` and Deepgram's streaming API are candidates; a Deepgram key is not
  in the dev API.
- **A voice that streams**: MAI answers a clause whole in 0.85 s; a first chunk at 0.2–0.3 s (Kokoro or Qwen3-TTS on
  one always-on L4, €0.79/h, shared by every overflow learner) takes 0.5 s off every turn.
- With both, the reasoned budget is 0.7 (endpointing, transcript ready) + 0.4 + 0.1 + 0.3 ≈ 1.5 s p50; unmeasured.

### Tests

`__tests__/unit/s2s/stt-fallback-fast.test.ts` (fake providers through the real STT route and `runTargets`): slow first
link → second link answers right after the hedge, each called once, `route.hedge` + `route.served raced`; first link
answers in time → one call; first link errors → second at once; both slow → `503 … timed out` at the budget, each link
called once, no second run; the budget header ignored from a client; a stage that failed late is not retried; the
composed turn sends hedge 900 and budget 3000 with and without a deadline; a whole turn hedged and a whole turn failed
fast. `first-audio-deadline.test.ts` updated (the STT hedge is now 900 ms, not the time left to the deadline).

## Integration (2026-10-08, `rt/improvements`, PR #56)

PRs #59 (client deadline), #61 (fallback fast) and #57 (multi-provider placements, scaling mode always present) are
squashed into `rt/improvements`. On top of them, unit-tested only — nothing below ran on a machine:

- **STT budget only with a second link.** `handleAudioTranscriptions` applies the sub-request's 3 s budget only when
  two or more **cloud** links of the route are usable at that moment (configured, key present, breaker closed;
  `selectTargets`). A deployment link does not count: it is the GPU the overflow came from. With one cloud link the
  route keeps `GATEWAY_STT_BUDGET_MS` (8 s): a slow Whisper is late, not failed, whatever the order in which the
  gateway and the school's `parle-stt` route are deployed. The 900 ms hedge is unchanged: it only starts the next link
  in parallel and cannot fail a turn. Production today (`GET /health`): `parle-stt` = `deployment:parle-speech` →
  `openrouter:openai/whisper-large-v3-turbo` → `groq` (`no_key`), i.e. one cloud link, so the old patience holds
  until the school adds the second one.
- **Image per placement.** A `placements` entry may carry `image`. `speech-stack` is `rg.fr-par.scw.cloud/aigw/speech-stack:20261008-1317`
  on Scaleway and `ghcr.io/marcosremar/speech-stack:20261008-1317` (public, same digest
  `sha256:3ff347aad2f2b2e91b509837570e659a4c0d027d9fcd46d0c44fa710287bf6de`) on Vast, so the Vast place is no longer
  skipped as "private". The declared `parle-speech` carries the same placements (no L4), `scaling.mode: fast` and the
  new tag. `SPEECH_IMAGE` moves the Scaleway image only: the GHCR tag is pinned in the declaration.
- **Vast and the image's `ENV`.** `start.sh` runs under `set -u` and reads `TTS_MODEL` and `LLM_FILE`, which exist only
  as `ENV` of the image. On Vast the gateway's boot script is started from the onstart shell with `/srv/aigw/app.env`
  (spec env only). The onstart shell did see the container env on the two hosts of § Prova final ao vivo — Vast, but
  that was a base image with a boot script, never this image with its own start command, and `vast-backend.ts` itself
  keeps a `/etc/environment` fallback for the case where it does not. The `RTX 5090` env of the profile and of the
  declaration now names both variables, so the launch does not depend on it. `STT_MODEL`, `STT_COMPUTE` have defaults
  in `server.py`; `HF_HOME` is exported by `start.sh`.
- **Context per slot.** `start.sh` of the image already reads `LLM_SLOT_CTX` (default 2048): no rebuild. The
  `speech-stack` **profile** sets `LLM_SLOT_CTX=4096` on `L40S-1-48G` (16 slots × 4096 = 65 536 tokens of context) and
  leaves the L4 and the RTX 5090 at 2048. **To measure in tonight's proof before production: the VRAM it costs on the
  L40S (estimated +~4.7 GB for the KV cache), with the TTS stage at 12 GB and Whisper loaded, and that `/health` says
  `llm_ctx: 4096`.** The declared `parle-speech` does not carry it, so the production record keeps 2048 until someone
  adds it after the measurement (runbook, `docs/reports/2026-10-08-deploy-runbook.md`).
- **Image workflow.** `speech-stack.yml` builds on dispatch, on `main` and on pull requests of this repository; a fork
  pull request never ran with a write token (GitHub gives forks a read-only `GITHUB_TOKEN` and no secrets), and the job
  is now skipped for forks outright. A new push to a pull request cancels the build of the previous one (four builds
  of the same branch were running at once on 2026-10-08).
- **Bundle baseline.** `realtime` grew 74.1 → 88.8 KB with #59 (the session imports the PCM player and the clip
  decoder to play the opener); accepted in `quality-bundle-baseline.json` with that reason.

## Prova final ao vivo — imagem 1317, duas réplicas (2026-10-08 noite)

Gateway local (`bun serve.ts` em :4150, namespace `marcos-proof-final`, estado próprio), máquinas só pela API dele;
21:48 → 00:08 Europe/Paris (2 h 20 de relógio; aula encerrada; produção só lida por GET). Spec = perfil `speech-stack`
desta branch (`realtime: {}`, modo `fast`, `LLM_SLOT_CTX=4096` no L40S; Vast com teto 0,57 no lugar de 0,85), voz de
referência sintética (espeak-ng) por `fileUrls` (`scripts/realtime-e2e/fixtures/`), prompt de sistema de 509 tokens,
clipe sintético de 4,5 s, 4 falas de abertura. Relógio de toda latência: última amostra com voz enviada → primeiro áudio
não silencioso recebido (os 700 ms de endpointing estão dentro). Clientes: `ws` do Mac pelo relay do gateway; `webrtc` =
aiortc num contêiner Linux no Mac (par `host/host`); Chrome = SDK real com medidor audível. A rede do Mac oscilou na
noite (a âncora `s3.fr-par` mediu 46, 62 e 186 ms em três momentos).

### Veredito

| # | Item | Resultado | Números |
|---|---|---|---|
| 1 | Imagem nova num L40S do perfil, 4 alunos | **passou** | boot 516 / 500 / 508 s; WS n 311: p50 1036, p95 1744, **max 1980**; WebRTC n 321: p50 1415, p95 2165, max 3500 (2 turnos > 2500, ambos com a fala chegando 2,4–3,1 s atrasada ao edge); 0 falhas em 632 turnos |
| 2 | Sessões longas, 4 × ≈ 61 turnos, `LLM_SLOT_CTX` 4096 | **passou no que dá para ver; VRAM não medida** | 243 / 243 turnos, 0 HTTP 400 do LLM (`chat` 243 iniciados / 243 concluídos, nenhum `exceed` no log), 0 sessão morta, 0 corte de histórico (o maior prompt foi 2768 tokens de 4096); `nvidia-smi` sem caminho de acesso no Scaleway |
| 3 | Segunda réplica no Vast pela imagem pública | **passou em parte, com 3 defeitos de operação** | caminhada L40S (cota) → Vast provada; 3 aluguéis para 1 réplica; pull + boot 25 min 39 s; `start.sh` subiu; UDP ok; 4 alunos WS no Vast: n 93, p50 933, p95 1164–1354, max 1570; a conta Vast ficou sem crédito às 00:01 e a réplica caiu com 4 alunos |
| 4 | Transbordo no fallback composto | **passou (a guarda funciona); 2500 ms não é atingível ali** | 1 elo: 43 turnos, 0 falha pelo orçamento de 3 s, 4 falhas `stt_503` aos 8 s (a paciência antiga), resposta p50 5813 / p95 14966 / max 16729 ms; 2 elos: 52 turnos, 0 falha, 42 hedges, resposta p50 3958 / p95 5160 / max 5747 ms; abertura aos 1702 ms nos 95 |
| 5 | Teto no relógio do aluno (#59) | **o teto funciona; o modo tem um defeito aberto** | turnos travados 3 s: antes 3559 / 3699 ms; com `--client-deadline` 2016 / 2036 / 2037 ms, uma abertura só, resposta depois (3492–3994 ms); **3 dos 5 turnos normais da rodada terminaram `interrupted` sem resposta** (0 de 5 sem a opção) |
| 6 | Scale-in | **falhou ao vivo, consertado (`91a5621`) e provado de novo** | antes: réplica em dreno com 2 alunos liberada em 30 s; depois: dreno segurou 138 s até a sessão acabar (11 / 11 turnos, max 1019 ms) e liberou em 5 s como `scale-down`; nada ficou ligado |
| 7 | Modo `fast` e `/capacity` | **passou** | 2ª réplica pedida no 3º assento (`fast: one spare replica at load 4.5`, teto 4 de `/capacity`); `/capacity` em 7 momentos abaixo |

**2500 ms como MÁXIMO:** valeu em 2178 de 2181 turnos realtime (WS e aiortc, todas as rodadas). Os 3 acima (2764, 3500,
9102 ms) têm a mesma assinatura da tarde: o fim da fala chegou ao VAD do edge 2,4–8,7 s depois da última amostra com
voz, e o edge respondeu em 225–447 ms. É atraso de subida do cliente, que só o teto no relógio do aluno (#59) cobre. No
fallback composto o primeiro **som** (abertura) fica em 1,70 s; a **resposta** não cabe em 2500 ms (item 4).

### Defeitos achados ao vivo

| Commit | Defeito | Estado |
|---|---|---|
| `9f8d49c` | **No Scaleway o edge não é o da imagem.** O sidecar sobe de `DEFAULT_EDGE_IMAGE`, que apontava para `aigw-edge:8c774c6e` (sem ajuste de histórico nem os consertos `04ce863` / `db8c0f4` / #58). Só no Vast o edge sai de `/opt/aigw-edge`. Com `realtime: {}` a produção subiria o edge antigo. | consertado: padrão `f66b6b80`, teste prende o padrão ao `EDGE_TAG` do Dockerfile. Tudo abaixo rodou com ele |
| `91a5621` | **Réplica em dreno era liberada com alunos sentados.** 22:32:42, `maxReplicas` 2 → 1 com 2 alunos numa réplica: liberada 30,06 s depois como `scale-down`. O serviço realtime só consultava `/__aigw/rt/status` de réplicas fora de dreno; o relatório vencia em 30 s (`EXTERNAL_LOAD_MAX_AGE_MS`) e `busyOn` lia 0. | consertado e provado de novo (item 6) |
| — | **`bootTimeoutMinutes: 20` do perfil mata o Vast.** O pull da imagem pública levou > 20 min (Estônia, solta sem endereço), 11 min 16 s (Suécia) e 17 min 25 s (Itália); o boot inteiro na Itália, 25 min 39 s. | **aberto**: o lugar Vast precisa de um prazo próprio (≥ 35 min) ou de imagem menor |
| — | **O portão de RTT só decide depois do pull.** A Suécia foi solta por +138 ms depois de 11 min pagos; com o padrão de 20 ms a Itália (+64) também seria. | aberto (já anotado de manhã) |
| — | **Sem crédito no Vast a réplica cai sem aviso.** 00:01:18: `replica unreachable`, depois `insufficient_credit` no aluguel seguinte. Os 4 alunos dela perderam a sessão e levaram `503 saturated` até o fim (o L40S, com 13, recusava). | aberto: recarregar a conta; não há alerta de saldo |
| — | **Modo `--client-deadline`: turno normal termina `interrupted` + `done{empty}`** logo no fim do VAD (o fim de turno da página e o do servidor se atropelam). | **aberto**, não investigado; só alcança alunos quando a escola subir o SDK |
| — | `L40S-1-48G is not sold in fr-par-1`: o segundo lugar do perfil nunca serve. | aberto, inofensivo |
| — | `/capacity` mostra a imagem do Scaleway na linha `RTX 5090` e `confident: false, missing: ["boot"]` com 3 boots medidos. | aberto, cosmético |
| — | Harness: Chrome em `s2s-stream` com `--uplink-stall` não termina (2 rodadas presas na coleta); a configuração de sessão tem teto de 6 kB, então não dá para semear um histórico longo. | aberto |

### 1 — imagem nova num L40S do perfil, 4 alunos

L40S-1-48G fr-par-2, €1,4699/h, criado pelo perfil: `ready` em **516 s** (21:51:45 → 22:00:21), o segundo em **500 s**, o
terceiro em **508 s**. `/health`: `llm_ctx: 4096`, 1 voz (o `fileUrls` funciona no Scaleway). Sonda de rede do edge:
`inbound udp/50100: ok (48 ms)`, `path=direct`.

| Rodada | Turnos ok / tentados | Primeiro som p50 / p95 / max ms | ≤ 1,0 / 1,5 / 2,0 s % | > 2500 ms | Aberturas | Edge p50/p95: ttfa · stt · llm · tts |
|---|---|---|---|---|---|---|
| WS × 4, 840 s, uma sessão por aluno (≈ 61 turnos) | 243 / 243 | 1051 / 1746 / **1915** | 38,7 / 86,8 / 100 | 0 | 14 | 278/1847 · 209/469 · 211/710 · 97/276 |
| WS × 4 na 2ª réplica (alunos 5..8), 230 s | 68 / 68 | 979 / 1498 / **1980** | 52,9 / 95,6 / 100 | 0 | 0 | 210/671 · 210/425 · 172/357 · 95/314 |
| WebRTC × 4, 840 s | 232 / 232 | 1331 / 1907 / **2209** | 0 / 70,7 / 97,4 | 0 | 6 | 280/830 · 210/464 · 224/571 · 95/345 |
| WebRTC × 4 sentados durante o transbordo, 330 s (rede do Mac ruim: fim da fala → VAD 1186 ms p50 contra 848) | 89 / 89 | 1732 / 2363 / 3500 | — | 2 | 0 | — |

0 falhas, 0 truncados, `tts_retries` 0, `deadline_missed` 0 em 632 turnos. Alvo do dono: p50 < 1 s **não** (1036 ms no WS;
a janela de silêncio sozinha são 700 ms); máximo ≤ 2500 ms **sim no WS** (1980), no WebRTC salvo os 2 turnos de subida
atrasada.

### 2 — sessões longas e `LLM_SLOT_CTX` 4096

- A rodada WS de 840 s: 62, 62, 61 e 58 turnos na MESMA sessão, 243 / 243 respondidos. Log do llama.cpp: `n_slots = 16,
  n_ctx_slot = 4096`; nenhuma linha `exceed`; o maior pedido teve 2768 tokens. `/health` ao fim: `chat` 243 / 243,
  `speech` 660 / 660, `stt.oom_retries` 0. Com o edge `d4a160e4` a 2048 a mesma sessão morria no 26º turno.
- **Cortes de histórico: 0, porque a 4096 uma sessão de 15 min (o limite do edge) não chega ao teto.** O corte em si
  não foi exercitado ao vivo: semear histórico esbarra nos 6 kB da configuração, a réplica Vast (2048) caiu aos 2 min da
  rodada longa, e a telemetria do edge não chega a um gateway atrás de NAT. Fica com o teste de unidade de #58.
- **Persona:** não conferida por texto (o harness guarda só a contagem de caracteres; `KEEP_TEXT=1` foi adicionado mas a
  rodada que o usaria foi a recusada pelos 6 kB). Sinal indireto: áudio por caractere e tamanho de resposta estáveis do
  1º ao 61º turno.
- **Custo do histórico longo:** o primeiro token do LLM sobe com o turno — p50 137 ms (turnos 0–9), 236 (20–29), 386
  (40–49) — e as 14 aberturas da rodada estão todas depois do 30º turno (resposta até 3441 ms, primeiro som ≤ 1915).
- **VRAM a 4096: não medida.** Sem SSH (porta 22 fechada), `/health` não traz memória e as linhas `gpu used … MiB` do
  `start.sh` vão para o stdout do contêiner, fora do `/debug/logs`. O que se viu: vLLM-Omni reservou 11,54 GiB (0,26 de
  44,39), o llama.cpp subiu depois com 16 × 4096, o Whisper carregou, e 3160 sínteses + 1292 clipes de STT em lote de 8
  rodaram com `oom_retries` 0 e 1 síntese falha. A conta fica como estava: 28,2 GB medidos a 2048 + ~4,7 GB estimados =
  ~33 de 46 GB. **4096 funciona (3 boots, 2 h de carga, 16 slots usados); a margem em GB segue estimada** — para fechar,
  o `/health` da stack precisa expor `nvidia-smi` (mudança de imagem).

### 3 — segunda réplica no Vast pela imagem pública

- **Caminhada.** Com um L40S meu e um da produção (cota 2), o pedido da 2ª réplica: `quota reached for L40S-1-48G on
  scaleway … skipping the machine type` → `vast RTX 5090 (≤ €0.57/h) … offer 1 of 5: Estonia`. Mais tarde, com estoque e
  cota livres, a mesma caminhada trouxe um 2º L40S (500 s), como previsto. Na terceira tentativa o Vast foi **forçado**:
  `maxEurPerHour: 1` no spec (`L40S-1-48G costs €1.469916/h in fr-par-2, above maxEurPerHour €1; L40S-1-48G is not sold in
  fr-par-1`) e `maxRttExcessMs: 200`, `bootTimeoutMinutes: 35`.

| Aluguel | Onde, US$/h com disco | O que houve |
|---|---|---|
| 54909146, 22:39:50 | Estônia, 0,577 | 20 min em `starting` sem endereço (pull) → `boot-timeout`, solta |
| 54911378, 23:00:04 | Suécia, ~0,53 | endereço aos 11 min 16 s; portão: 200 ms contra 62 da âncora, +138 → `too-far`, solta |
| 54914223, 23:25:24 | Itália, 0,604 | endereço aos 17 min 25 s; portão 110 contra 46, +64 (aceito pelo limite relaxado); **`ready` aos 25 min 39 s** (`bootMs` 1539229) |

- **`start.sh` recebeu `TTS_MODEL` / `LLM_FILE`:** a stack subiu e respondeu (o risco do `set -u` não se confirmou, com
  as duas variáveis no env do tipo `RTX 5090`). Edge de `/opt/aigw-edge` da imagem. Sonda: `udpInbound ok`, 65 ms,
  `path=direct` — este host encaminha UDP.
- **Alunos no Vast** (admissão: 4 dos 13 alunos WS com tempo de pensar caíram nela): rodada 1, 58 turnos, p50 933, p95
  1164, max 1215 ms, 0 falhas; rodada 2, 35 turnos, p50 929, p95 1354, max 1570 até a réplica cair. **WebRTC no Vast não
  foi medido** (os alunos aiortc foram admitidos no L40S). O rótulo «por réplica» do harness é o que vale aqui; a
  telemetria do gateway confirma 4 admissões em `54914223` em cada rodada.
- **Volta ao Scaleway:** enquanto as duas estavam de pé a admissão pôs 13 no L40S e 4 no Vast nas duas rodadas (o L40S
  tinha 16 assentos nesse momento, ver «Capacidade»). Com o teto de produção (4) isso não foi repetido.
- **Fim:** 00:01:18 `replica unreachable`, `unhealthy`, liberada; novo aluguel recusado: `insufficient_credit`.

### 4 — transbordo no fallback composto (enquanto a réplica Vast subia)

4 alunos WebRTC sentados (réplica cheia), 4 alunos no degrau de clipe (`--s2s 4 --no-wake`, 110 s, um turno a cada 8 ± 2
s). Relógio: do fim da fala (pedido − 700 ms).

| Rota STT | Turnos | Falhas | Primeiro som (abertura) p50 / max | Resposta p50 / p95 / max | Estágio STT p50 / p95 / max | Quem serviu |
|---|---|---|---|---|---|---|
| 1 elo: `openrouter:openai/whisper-large-v3-turbo` | 43 | 4 `stt_503` aos 8,0 s do pedido (orçamento da rota, não o de 3 s) | 1702 / 1744 | 5813 / 14966 / 16729 | 2646 / 6894 / 6986 | whisper turbo 39 |
| 2 elos: `deepgram/nova-3` → `openai/whisper-large-v3` | 52 | 0 | 1702 / 1727 | 3958 / 5160 / 5747 | 1385 / 2210 / 2624 | nova-3 50 (41 depois de hedge), whisper 2; 42 `route.hedge` |

A guarda está certa: com um elo ninguém falhou aos 3 s (STT de até 6,9 s foi respondido); com dois, hedge e nenhuma
falha. LLM: primeiro token p50 770–865 ms (p95 até 7004 com um elo); voz: 860–1053 ms.

### 5 — teto no relógio do aluno (#59)

Chrome, WS, um aluno, 110 s, a cada 3ª fala o áudio fica retido 3 s (`--uplink-stall 3000`). As rodadas com
`ws,s2s-stream` do comando do PR não terminaram (harness preso na coleta, duas vezes); estas são só `ws`.

| | Turnos travados, primeiro som audível | Outros turnos |
|---|---|---|
| sem `--client-deadline` | 3559 · 3699 ms | 1073–1407 ms, 5 de 5 respondidos |
| com `--client-deadline` | **2016 · 2036 · 2037 ms** (`turn.first_sound` `client_opener` aos 2004–2014), abertura local até ~3,82 s, resposta recebida aos 3492–3994 ms, nenhuma abertura do servidor no turno | 926 · 1302 ms; **3 de 5 `interrupted`** |

O teto cumpre o que promete. Os 3 turnos perdidos: `vad end` → `interrupted` → `done{interrupted}` → `done{empty}` no
mesmo instante, sem transcrição. Não acontece sem a opção. Não investigado.

### 6 — scale-in

- **Antes do conserto:** ver a tabela de defeitos (30 s, 2 alunos derrubados, 5 turnos perdidos).
- **Depois (`91a5621`), 23:20:56:** um aluno em cada L40S, `maxReplicas` 2 → 1. `draining replica` (d01fc5d1) às
  21:20:57Z; `drain: true` em toda leitura por 138 s; a sessão do aluno acabou às ~21:23:10Z; `releasing replica …
  scale-down` às 21:23:15Z. O aluno dela: 11 / 11 turnos, p50 930, max 1019 ms. A réplica vazia do primeiro caso também
  foi liberada. O timeout de dreno (30 min) e a liberação por ociosidade (≥ tempo de boot) não foram esperados.

### 7 — modo `fast` e `/capacity`

| Momento | `/capacity` | Decisão do autoscaler |
|---|---|---|
| 22:16, 1 réplica ociosa, `maxReplicas` 1 | L40S teto 4 `configured`, boot 516 s `measured` (1) | `desired 1`; com 4 sentados: `fast: one spare replica at load 6 (maxReplicas 1)` — quer a folga, o teto do spec segura |
| 22:18, 4 sentados, `maxReplicas` 2 | idem | pedida no 3º assento: `fast: one spare replica at load 4.5`; criada às 22:17:46, pronta em 500 s |
| 22:26, 8 sentados em 2 | boot 500 s (2) | `desired 2`, `fast: one spare replica at load 12 (maxReplicas 2)` |
| 22:41, 4 sentados + 4 no fallback, Vast subindo | + linha `RTX 5090` teto 4, boot 600 s `default` | `fallback took 0 load-minutes above capacity 12 (fast: any excess) ≥ €0.16 for one replica start`, `scalingOut: true` |
| 23:59, 13 no L40S (16 assentos) + 4 no Vast | L40S teto 16, boot 508 s; RTX 5090 boot **1539 s `measured`** | `fast: one spare replica at load 24.8 (maxReplicas 2)` |

As decisões seguem o teto de sessões que `/capacity` publica (folga pedida a 75 % de uma réplica). O teto continua
`configured` com `samples: 0`: nada do que foi medido esta noite virou teto medido.

### WS × WebRTC: onde fica a diferença

Mesma réplica (L40S), mesmo clipe, mesma hora: 4 alunos WS (Mac) e 4 WebRTC (aiortc) **ao mesmo tempo**, 200 s. Tempos
do harness e do edge já existentes; a única instrumentação nova foi deixar o cliente aiortc guardar
`first_sound_from_speech_ms` do evento `metrics` (`load_rtc.py`). ms, p50 (p95):

| Trecho | WS (n 56) | WebRTC aiortc (n 55) | Diferença p50 |
|---|---|---|---|
| (a) fim da fala do aluno → o edge decide o fim do turno, visto no cliente | 751 (799) | 853 (1059) | **+102** |
| — janela de silêncio no edge (VAD do servidor nos dois, `RT_VAD_SILENCE_MS` 700) | 702 (726) | 700 (716) | 0 |
| — o resto: subida + buffer / decodificação até o VAD ouvir o fim | 48 (114) | 156 (355) | **+108** |
| (b) STT | 333 (478) | 349 (552) | +16 |
| (c) primeiro token do LLM | 185 (500) | 186 (480) | 0 |
| (d) primeiro PCM do TTS | 107 (351) | 119 (283) | +12 |
| (b–d) `ttfa` do edge | 341 (1971) | 395 (948) | +54 |
| (e + f) evento `audio_start` → primeiro áudio não silencioso no cliente | 0 (48) | 167 (410) | **+167** |
| **Total, primeiro som** | **1107 (1742)** | **1462 (1945)** | **+355** |

- A diferença está nas duas pontas do transporte, não na GPU: **~110 ms na subida** (o fim da fala chega mais tarde ao
  VAD) e **~170 ms na descida** (do primeiro PCM no edge ao primeiro quadro audível). Os estágios são iguais.
- (e) e (f) não se separam com o que existe: o edge não carimba «primeiro pacote RTP enviado». No Chrome real, 1 aluno:
  `audio_start` → audível 268 ms p50 (p95 581) no WebRTC contra 24 ms (p95 226) no WS, isto é, o jitter buffer / playout
  do navegador pesa mais que o do aiortc. `getStats` (`jitterBufferDelay`, `totalProcessingDelay`, RTT) não é coletado
  pelo harness: não medido.
- As rodadas de 840 s com 4 alunos, uma depois da outra: WS 1051, WebRTC 1331 (+280: (a) +96, `ttfa` +2, (e + f) +169).
  Com 1 aluno (n 9 e 8, rede do Mac ruim naquele minuto): 1093 contra 1533; a subida somou 188 e 466 ms.

### Capacidade com tempo de pensar

**O que o harness fazia:** a resposta é entregue em tempo real (6,9 s de áudio em 6,9 s), mas o aluno voltava a falar
**1,0 s depois do fim dela** (mediana, rodadas do item 1): 90 % do tempo de sessão com turno em curso. O «4 por L40S»
veio daí. **Opção nova** (`a227dc8`, com teste): `--think 2-6` — ouve a resposta até o fim, espera um tempo uniforme
semeado e então fala.

Um L40S com `RT_MAX_SESSIONS=16` só no spec do teste (o perfil não mudou), WS, `--think 2-6`, 300 s por nível:

| Alunos | Turnos ok / tentados | Primeiro som p50 / p95 / max | **Áudio da resposta** p50 / p95 / max | Turnos com abertura | `deadline_missed` | Respostas em curso ao mesmo tempo (pico) | Tempo com turno em curso | Edge `ttfa` p50 / p95 · stt · llm |
|---|---|---|---|---|---|---|---|---|
| 4, sem pensar (item 1) | 243 / 243 | 1051 / 1746 / 1915 | 1051 / 2794 / 3441 | 14 (6 %) | 0 | 4 | 90 % | 278 / 1847 · 209 · 211 |
| **8** | 140 / 140 | 1131 / 1743 / 2008 | 1130 / **1726** / 3200 | 1 (1 %) | 0 | 7 | 74 % | 251 / 824 · 212 · 177 |
| **12** | 214 / 215 (1 erro de upstream depois do áudio) | 1259 / 1763 / 1846 | 1259 / 2948 / 3495 | 21 (10 %) | 0 | 10 | 74 % | 455 / 1982 · 363 · 251 |
| **16** | 245 / 276 (31 `short_audio`, todos sem abertura) | 1448 / 1774 / 1973 | 1443 / 3477 / 3527 | 85 (31 %) | 0 | 13 | 75 % | 676 / 2524 · 396 · 334 |

- **Primeiro som** (abertura ou resposta): máximo ≤ 2500 ms e p95 ≤ 2000 ms nos três níveis — 16 é o maior N medido
  que cumpre. **p50 < 1000 ms: em nenhum** (nem com 4). É a abertura que segura o teto: a 16, um turno em três começa
  por «Só um instante» e a resposta vem aos 3,5 s; 11 % das respostas saíram curtas.
- **Pela resposta de verdade** (p95 ≤ 2000 ms, quase sem abertura): **8 por L40S**. 12 é o limite defensável se uma
  abertura em cada 10 turnos for aceita.
- Tempo de pensar muda pouco a ocupação: de 90 % para 74 % do tempo com turno em curso (a resposta de ~7 s em tempo
  real e a fala de 4,5 s são o grosso do ciclo de ~17 s). O ganho de 4 para 8–12 vem mais de aceitar que o teto é do
  primeiro som com abertura do que do tempo de pensar.
- GPU e VRAM: sem acesso (item 2). «Em curso ao mesmo tempo» sai dos intervalos fim da fala → fim do áudio no cliente,
  não de métrica do edge.

| | Alunos por máquina | Custo por aluno-hora |
|---|---|---|
| L40S €1,47/h, teto atual | 4 | €0,37 |
| L40S, resposta p95 ≤ 2 s | 8 | **€0,18** |
| L40S, abertura em 10 % dos turnos | 12 | €0,12 |
| L40S, abertura em 31 % e 11 % de respostas curtas | 16 | €0,09 |
| RTX 5090 Vast US$0,55–0,60/h (medido só com 4: p50 933, max 1570) | 4 | US$0,14–0,15 |
| Fallback composto | — | ~US$0,48 |

**Os tempos de pensar são simulados** (uniforme 2–6 s, semente fixa, um clipe só de 4,5 s, resposta sempre ouvida até
o fim). Para calibrar: dos registros por turno da escola, a distribuição real de (fim do áudio da resposta → início da
fala seguinte), a duração das falas e das respostas, e quantos alunos falam no mesmo minuto numa aula.

**`endpoint_ms` 500 em vez de 700: não rodado.** A janela é `RT_VAD_SILENCE_MS` do edge, lida no boot (precisaria de
outra réplica), e o único clipe não tem pausa interna: cortes precoces não poderiam ser julgados.

### Estado das máquinas e custo

`DELETE /v1/deployments/proof-speech` às 00:07:07 → `Terminated server 6c4028ff…`. Gateway local parado 00:07:48. Reaper
em dry run com o gateway fora (`GATEWAY_URL=http://localhost:4150 DEPLOYMENTS_NAMESPACE=marcos-proof-final bun
scripts/reap-orphans.ts`): `scaleway seen: 0`, `vast seen: 0`, `planned: []`. Lista direta do projeto Scaleway (nove
zonas): nenhum servidor `aigw-ns-marcos-proof-final`. O que resta lá não é desta prova: um L40S `aigw-ns-prod`
(`parle-speech`, criado 21:37Z — a produção acordou o `parle-speech` três vezes na noite, 20:35Z, 20:45Z, 21:37Z, e os
dois L4 do `parle-qwen-tts` às 20:38Z) e dois `whisper-stt` parados de `dev-marmos`. Nunca mais de 2 L40S + 1 Vast meus;
nenhum L4; nada escrito em produção. Enquanto a produção tinha um L40S, a cota (2) recusou o meu segundo: a prova e a
produção disputam a mesma cota.

| | Minutos | Preço | Total |
|---|---|---|---|
| 4 L40S (21:51–22:33, 22:17–23:24, 23:11–23:23, 23:24–00:07) | 162 | €1,4699/h | ~€3,98 |
| Vast: Estônia 20 min, Suécia 11 min, Itália 36 min | 67 | US$0,53–0,60/h | ~US$0,66 |
| OpenRouter (95 turnos de fallback, falas do `--client-deadline`) | | | ~US$0,25 |

### GO / NO-GO

**Merge do PR #56: GO**, com os dois consertos desta noite (`9f8d49c`, `91a5621`) já na branch. O caminho de produção —
imagem 1317 no L40S, edge `f66b6b80`, 4 alunos, sessão longa, transbordo com a guarda do STT, scale-in — foi provado.

**Deploy do gateway: GO condicionado**, nesta ordem:

1. O deploy sai do `main` com `9f8d49c` (sem ele o L40S sobe o edge antigo e toda conversa morre no 26º turno) e
   `91a5621`.
2. **Contar só com o Scaleway.** O lugar Vast do `parle-speech` declarado já é pulado em produção (o registro tem
   `files`); deixar assim até: crédito na conta Vast, `bootTimeoutMinutes` ≥ 35 para o lugar Vast (ou imagem menor) e
   uma decisão sobre o portão de RTT depois do pull.
3. **Não ligar o prazo do cliente (#59) na escola** antes de entender os turnos `interrupted` do item 5.
4. `LLM_SLOT_CTX=4096` fica fora do `parle-speech` declarado até haver a leitura de VRAM (funcionou; a margem é
   estimativa).
5. Não mexer no teto de 4 sessões por L40S no deploy. 8 é a proposta para a próxima medição, com tempos reais da turma.

## Fallback em streaming (2026-10-08 evening, `rt/fallback-streaming`)

Goal: overlap the stages of the composed fallback (STT → LLM → TTS over OpenRouter) and say how close it gets to the
2500 ms ceiling. No machine, no GPU, production untouched: two local gateways (base `72552d6` on 4161, this branch on
4162, `DEPLOYMENTS_ENABLED=0`, `--no-wake`) against the real OpenRouter, stopped at the end; $0.83 on the key's counter
for the whole session (the key is shared).

### Research (web and live probes, 2026-10-08)

| Question | Answer | Source |
|---|---|---|
| OpenRouter STT: streaming or partials? | No. `POST /api/v1/audio/transcriptions` answers one JSON; no `stream`, SSE or WebSocket is documented, for any model (`deepgram/nova-3`, the Whispers, `nvidia/nemotron-3.5-asr-streaming…` included: the model streams, the endpoint does not) | openrouter.ai/docs/guides/overview/multimodal/stt · openrouter.ai/blog/tutorials/transcription-on-openrouter (22 Jul 2026, updated 24 Sep 2026) |
| Mistral streaming STT | Yes: `voxtral-mini-transcribe-realtime-2602` on `wss://api.mistral.ai/v1/audio/transcriptions/realtime`, `pcm_s16le` 16 kHz, Portuguese among its 13 languages, $0.006/min, delay configurable (480 ms recommended). Reachable with `MISTRAL_API_KEY`; not probed here | docs.mistral.ai/capabilities/audio/speech_to_text/realtime_transcription · mistral.ai/news/voxtral-transcribe-2 (4 Feb 2026) |
| NVIDIA hosted streaming ASR | Streaming models with pt-BR exist in the NIM support matrix; the hosted protocol (gRPC with a function id), whether the pt-BR profile is hosted, limits and production terms could not be confirmed from a fetched page. The realtime WebSocket is documented for self-hosted NIM only | docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html (updated 7 Oct 2026) |
| OpenRouter TTS: formats, streaming | `response_format` is `mp3` or `pcm` only (a `wav` request is a 400); no `stream` parameter. Probed: `microsoft/mai-voice-2.1-flash` (`pt-BR-Luana:MAI-Voice-2-Flash`) sends the first PCM byte at 580–730 ms whatever the length (one clause or three sentences) and the rest within 120–470 ms; `hexgrad/kokoro-82m` (`pf_dora`) first byte 380–2860 ms, body in one burst | openrouter.ai/docs/guides/overview/multimodal/tts · openrouter.ai/docs/api/api-reference/tts/create-speech · probes |
| Mistral TTS | `voxtral-mini-tts-2603` streams (SSE, PCM), first chunk 505–570 ms (one at 2.6 s) in the probe, but its 30 preset voices are `en_us`, `en_gb`, `fr_fr`: no Portuguese stock voice (`GET /v1/audio/voices`) | docs.mistral.ai/capabilities/audio/text_to_speech (model released 23 Mar 2026) · probe |

So: no STT with partials through OpenRouter (speculation is the only way on this chain), and no stock Portuguese voice
with a first chunk at 200–300 ms on any key we have. The MAI voice does stream; the gateway was not using it.

### Which transport gives the gateway the audio before the end of the turn: none

The brief assumed `ws` and `s2s-stream` do. They do not, for the fallback: the `ws` rung is a relay to the edge sidecar
on a GPU replica (a learner without a seat has no `ws` session: admission answers `503` with
`fallback: {transport: "s2s-stream"}`), and `s2s-stream` posts one finished clip after the client's endpointing. The
composed pipeline only ever sees `POST /v1/s2s`. The speculation is therefore driven by the client on that rung.

### What changed

- **Speculative turn** (`src/s2s/speculation.ts`, `route.ts`, `composite.ts`). `POST /v1/s2s` takes
  `config.speculation`: `{id, turn, action: "start"}` with the clip so far → `202 {"speculative": true}` at once, the
  gateway transcribes it (same 900 ms hedge and 3 s budget as a turn) and, when the transcript exists, opens the LLM
  stream on it; nothing is synthesized and the answer carries no audio. `{id, action: "cancel"}` (no file) aborts both.
  The turn itself names `{id}`: when its clip is the same utterance (WAV, length within `endpoint_ms` + 400 ms of the
  speculative one) the speculative transcript **is** the turn's transcript — no second STT — and the LLM stream already
  running is the one voiced. Otherwise the turn is transcribed again and the speculative LLM is kept only if both
  transcripts have the same words (case and punctuation ignored); else it is aborted and asked again. `transcript`
  carries `speculative` and `lead_ms`, `done` carries `speculation: hit | stt | llm | miss`.
- **Bounds**: WAV only (the length must be known), at least 600 ms of audio (`S2S_SPECULATE_MIN_MS`), at most 2 per
  turn (`S2S_SPECULATE_PER_TURN`, the SDK also stops at 2), 256 alive, 4 s to live (`S2S_SPECULATE_TTL_MS`),
  `S2S_SPECULATE=0` turns it off. A speculative STT that failed after more than 1 s is not run again by the turn.
- **Budget**: the speculative request passes the ownership and alias checks without charging the app
  (`checkS2S(..., charge = false)`); the turn is charged once, as before. Telemetry: `s2s.stt_speculative`,
  `s2s.stt_speculative_discarded {reason: cancelled | expired | mismatch | primary | superseded}`,
  `s2s.stt_speculative_refused {reason}`; counters in `speculationCounts`.
- **A seat on the GPU**: the turn tries the primary first, as always; when it takes the turn the speculation is
  discarded (`primary`). The SDK only speculates after a turn whose `route` was `composite`.
- **SDK** (`sdk/browser`): `voice.speculatePauseMs` adds two VAD effects (`vadPause` after that many ms under
  `vadEnd`, `vadResume` when the voice comes back; absent = no change), the clip recorder gets `snapshot()`
  (`MediaRecorder.requestData`), turn-taking hands the WAV so far to the s2s-stream rung, which posts the speculation,
  cancels it on `vadResume` / `vadStart`, and names it in the turn. PR #59's client deadline is untouched.
- **TTS first chunk**: a WAV asked from OpenRouter used to come back as a whole MP3 (the provider has no WAV and the
  client fell back to MP3, buffered). It is now asked as PCM and streamed behind a WAV header at the rate the provider
  names, so the composed turn passes chunks through as they arrive and its `A` frames are `pcm_s16le` 24 kHz like the
  GPU's. **Behaviour change for any caller of `/v1/audio/speech` that asks `wav` on an OpenRouter link: it now gets a
  WAV (streamed, sizes `0xFFFFFFFF`, as the deployment already answers) instead of an MP3.** No faster voice was
  wired: none exists on these keys.
- Untouched: opener and deadline logic (no double opener: the tests of `first-audio-deadline` pass unchanged), barge-in
  (the turn's abort also aborts the speculative LLM), history fit (#58: `askLlm` is the same code, moved), the STT
  hedge and budget of #61 on the final path.

### Measured (same clip, prompt, chains and harness as § Fallback fast; base and branch at the same time)

`load.ts --n 4 --s2s 4 --no-wake --ramp 10 --duration 110 --turn-every 8 --jitter 2`, the 5.0 s Portuguese clip,
opener on (deadline 2000 ms), STT `deepgram/nova-3` → `openai/whisper-large-v3`, LLM `qwen/qwen3.5-9b` →
`gemini-2.5-flash-lite`, TTS MAI flash → Kokoro. New harness options: `--speculate-lead <ms>` posts the clip that long
before the turn (what the page does `endSilenceMs − speculatePauseMs − snapshot time` before it closes the turn: 500
≈ a 160 ms pause, 350 ≈ Silero's own `vadEnd` at 320 ms), `--speculate-resume <share>` adds an earlier pause whose
speculation (half the clip) is cancelled. Clock: from the end of the speech (request − 700 ms). The three runs of a
round ran together, 12 learners on the Mac (load average up to 18: other sessions).

| Round (CEST) | Run | Turns | Failed | Opener p50 / max | Reply first audio p50 / p95 / max | ≤ 2.0 / 2.5 / 3.0 s | Speculation |
|---|---|---|---|---|---|---|---|
| 1 (22:36) | base | 53 | 0 | 1703 / 1746 | 3548 / 4723 / 6967 | 0 / 0 / 19 % | — |
| 1 | branch, no speculation (PCM stream only) | 54 | 0 | 1702 / 1719 | 3345 / 4376 / 6066 | 0 / 6 / 22 % | — |
| 1 | branch, lead 500 | 51 | 0 | 1703 / 1710 | **2689 / 5179 / 5456** | 2 / 29 / 73 % | 51 sent, 51 hit |
| 2 (22:39) | base | 51 | 2 | 1702 / 1714 | 4488 / 6514 / 7409 | 0 / 0 / 0 % | — |
| 2 | branch, lead 350 | 52 | 1 | 1702 / 1713 | 3789 / 4967 / 5833 | 0 / 4 / 18 % | 52 sent, 51 hit |
| 2 | branch, lead 500, 25 % resumed | 54 | 1 | 1702 / 1705 | 3552 / 5083 / 6297 | 0 / 8 / 17 % | 68 sent, 14 cancelled (21 %), 53 hit |
| 3 (22:42) | base | 52 | 1 | 1702 / 1731 | 4423 / 6548 / 7941 | 0 / 2 / 8 % | — |
| 3 | branch, no speculation | 52 | 0 | 1702 / 1726 | 4127 / 5802 / 9206 | 0 / 0 / 8 % | — |
| 3 | branch, lead 500 | 50 | 1 | 1702 / 1735 | **3304 / 5162 / 5362** | 0 / 6 / 33 % | 50 sent, 49 hit |

Failures are provider `503`s (STT 4, LLM 1), on both sides. The providers were slower in rounds 2 and 3 than in round 1
(base STT 1.08 → 1.54–1.60 s p50), so compare inside a round: speculation with a 500 ms lead took **0.86, 0.94 and
1.12 s** off the median, 0.70 s with a 350 ms lead; the PCM stream alone 0.20–0.30 s. One evening, about 50 turns per
run: read ± 0.5 s on every p95 and max.

Per stage, ms, p50 / p95:

| Run | STT (whole) | Transcript after the request | LLM first token after it | First clause | TTS first byte |
|---|---|---|---|---|---|
| 1 base | 1075 / 1496 | 1075 / 1496 | 710 / 1367 (max 1642) | 87 / 387 | 819 / 1116 (max 2088) |
| 1 PCM only | 994 / 1541 | 994 / 1541 | 714 / 1483 (max 1820) | 89 / 349 | 672 / 854 (max 1023) |
| 1 lead 500 | 936 / 1516 | **435 / 1015** | 695 / 1149 (max 2607) | 103 / 1286 | 677 / 1196 (max 1323) |
| 3 base | 1598 / 2682 | 1598 / 2682 | 840 / 1907 (max 2760) | 70 / 275 | 1079 / 1566 (max 1919) |
| 3 lead 500 | 1295 / 2271 | **794 / 1771** | 817 / 1474 (max 1775) | 102 / 495 | 898 / 1418 (max 1465) |

The speculation hides exactly its lead: the transcript exists `STT − lead` after the request. The speculative LLM
changes nothing while the STT is longer than the lead (the transcript arrives after the turn was committed anyway); it
pays when the STT is shorter, and it is what the next step (a streaming STT) needs.

### Cost

Prices of § Fallback under load and § Fallback fast. A turn here is ≈ $0.0020: voice $0.0016 (108 characters at
$15/M), STT $0.00036 with nova-3 first (5 s at $0.0000717/s; $0.00002 with Whisper turbo), LLM $0.00003; measured on
the key's counter $0.0015–0.0020 per turn. At 240 turns per learner-hour: **$0.48**. A speculation that is committed
costs nothing more (it replaces the turn's STT). A discarded one costs its STT call and, when the STT had finished,
≈ 500 prompt tokens ($0.00005): at the share simulated here (0.26 discarded per turn, half the clip) **+$0.011 per
learner-hour (+2 %)**; at the worst the caps allow (two discarded whole clips every turn) +$0.17 (+36 %) with nova-3,
+$0.01 with Whisper turbo first. The real share of resumed pauses was not measured: it needs learners.

### Verdict against 2500 ms

Not reached, neither as a maximum nor as a median. Reply first audio from the end of the speech: 2.7–3.3 s p50 where
the same evening's base gave 3.5–4.4 s; maximum 5.4–5.5 s (base 7.0–7.9 s); 6–29 % of the turns under 2.5 s (base
0–2 %). The first sound (opener) stays at 1.70 s in every turn.

What holds it, in order (round 1, the healthy one): the **LLM first token**, 0.70 s p50 and up to 2.6 s; the **voice's
first byte**, 0.68 s p50 and up to 1.3 s; the **part of the STT the lead does not hide**, 0.44 s p50 and 1.0 s p95.
Their sum after a 700 ms endpointing is 0.7 + 0.44 + 0.70 + 0.10 + 0.68 ≈ 2.6 s, which is the median measured.

What would remove each (not built):

- STT remainder (−0.4 to −0.8 s, and its tail): a transcript that exists when the speech ends. Mistral's Voxtral
  realtime is reachable with the key we have; it needs the learner's audio to reach the gateway while they speak, i.e.
  a streaming uplink on the fallback (a gateway WebSocket that takes the 16 kHz frames of a learner without a seat),
  and a `mistral` STT provider. The speculative LLM and the commit-by-id of this branch are the other half of it.
- LLM first token (−0.3 to −0.4 s): `google/gemini-2.5-flash-lite` answered its first content token in 390 ms p50
  (341–618, 8 calls, same prompt, same minute) against 800 ms (637–1256) for `qwen/qwen3.5-9b`. That is the order of
  the school's `parle-llm` route, and a different model answering the turn: the school's decision, with the LLM label
  it already records.
- Voice first byte: nothing on these keys is under 0.5 s. A voice on a GPU (the 200–300 ms first chunk of the
  speech-stack) is the only one seen.
- With the first two: 0.7 + 0.2 + 0.4 + 0.1 + 0.68 ≈ 2.1 s p50 (reasoned, not measured). A **maximum** of 2.5 s needs
  every stage's p99 under control, which three cloud calls in a row do not give: seats on a GPU do.

### Limits of this change

- The SDK path is unit-tested only: no browser ran it. `MediaRecorder.requestData` mid-recording, `decodeAudioData` of
  the partial clip (Safari's mp4 fragments may not decode: then `clipToWav` gives nothing and no speculation is sent)
  and the time both take (it comes off the lead) are unmeasured.
- The school's page must turn it on (`voice.speculatePauseMs`, e.g. 160) and its backend relay must forward the
  speculative `POST` (same route, a JSON answer, `config.speculation`) — **to do in parle**.
- The gateway trusts the client's VAD, as it already does for the end of the turn: a turn that names a speculation
  says "nothing was spoken after that clip". The length check is a safety net, not a proof.
- The speculations live in the gateway process: with more than one gateway instance the turn must reach the instance
  that got the speculation, otherwise it is a plain turn (safe, no gain).
- The speculative request cannot know whether a GPU seat will take the turn (no capacity peek without a lease).

### Tests

`__tests__/unit/s2s/speculation.test.ts` (fake stages through the real route): pause → speculative STT → the turn
answers with one STT call and one LLM call; the turn arrives while the STT still runs; pause → speech resumes →
aborted, no LLM, no TTS, nothing but JSON was sent, counted `cancelled`; a longer final clip heard differently → LLM
asked again, only the second reply is voiced; same words → the speculative LLM is kept; caps (`short`, `format`,
`turn_cap`); the primary takes the turn → `primary`; expiry on a fake clock; a speculative STT that failed late is not run again, one that failed at once is; another key cannot commit; the app is
charged once (`admit` called with `charge` false then true). `sdk-realtime-speculate.test.ts` (the rung and the VAD
effects), `sdk-voice-turn.test.ts` (turn-taking), `gateway-routing/tts-pcm-as-wav.test.ts` (streamed WAV header, rate
from the provider, MP3 untouched).

## WebRTC: conserto da descida e prova ao vivo (2026-10-09)

Branch `rt/webrtc-latency` (PR #65). Gateway local em :4170 (`bun serve.ts`, namespace `marcos-webrtc`, estado próprio,
`DEPLOYMENTS_MAX_REPLICAS=1`), um L40S-1-48G fr-par-2 do perfil `speech-stack` por vez (imagem `20261008-1317`,
€1,4699/h, `placements: []`, `realtime.maxSessions` 8 só no spec do teste). Sexta 09/10, 01:26 → 03:27 Europe/Paris;
produção só lida. Mesmo clipe sintético de 4,5 s, prompt de 509 tokens, voz e aberturas da prova da noite anterior.
Relógio: última amostra com voz enviada → primeiro áudio não silencioso recebido (os 700 ms de endpointing estão
dentro). Clientes leves (`ws` em Bun, `webrtc` em aiortc) e Chromium 154 num contêiner Linux no Mac, atrás de um netns
com `tc` (perfis `clean`, `campus-slow`, `lossy`); Chrome real do Mac nas rodadas «Chrome (Mac)».

**Antes e depois não são a mesma máquina.** O sidecar sobe do cloud-init (`docker run` de `realtime.edgeImage`) e não
há SSH: trocar o edge é outra máquina. Foram dois boots em sequência (530 s e 500 s), nunca dois L40S meus ao mesmo
tempo, mesma zona, tipo e imagem de modelos, mesmo harness nas duas pontas. Antes = edge `f66b6b80`; depois = edge
`a5dd777f` (esta branch). O WS, que não mudou, serve de controle: 1305 → 1273 ms entre as duas máquinas.

### Veredito contra o alvo

| Alvo | Resultado |
|---|---|
| Rede limpa: WebRTC a ~100 ms do WS no p50 | **sim nos clientes leves**: +25 ms (1298 contra 1273, n 197 / 199); +41 com tempo de pensar; −25 na rodada limpa do contêiner. **No Chrome real: +100 ms com 1 aluno, +180 com 4** no medidor da página (+32 / +128 no instante em que o áudio sai do jitter buffer) |
| Rede limpa: máximo do WebRTC ≤ 2500 ms | **sim**: 1944 (leves, 197 turnos), 2042 (pensar), 1291 (Chrome, 40 turnos). Antes: 2265 |
| `lossy`: p95 do WebRTC melhor que o do WS | **sim**: 2124 contra 2373 (p50 1270 contra 1487, max 2154 contra 2961) |
| `campus-slow`: p95 do WebRTC melhor que o do WS | **sim**: 1570 contra 1857 (p50 1104 contra 1182); antes era pior (2229 contra 1824) |

### Antes × depois, clientes leves, ms p50 / p95 / max

| Rodada | | WS antes | WebRTC antes | WS depois | WebRTC depois |
|---|---|---|---|---|---|
| Limpa, 4 + 4, 760 s, um turno a cada 15 ± 2 s | primeiro som | 1305 / 1767 / 1888 (n 191) | 1705 / 2177 / 2265 (n 191) | 1273 / 1776 / 1943 (n 199) | **1298 / 1893 / 1944** (n 197) |
| | subida: fim da fala → `vad end` | 747 / 806 / 833 | 944 / 1090 / 1171 | 748 / 819 / 985 | 768 / 845 / 932 |
| | estágios: `ttfa` do edge (stt · llm · tts p50) | 533 / 2311 (344 · 357 · 107) | 624 / 2615 (378 · 364 · 121) | 517 / 2191 (357 · 321 · 116) | 448 / 2583 (313 · 308 · 114) |
| | descida: `audio_start` → primeiro quadro audível | 0 / 154 | 79 / 308 | 0 / 104 | 40 / 233 |
| | diferença WebRTC − WS no p50 | | **+400** | | **+25** |
| `lossy` (75 ms, 5 %), 3 + 3, 180 s | primeiro som | 1827 / 3469 / 3593 (n 32) | 1945 / 2392 / 2397 (n 31) | 1487 / 2373 / 2961 (n 35) | **1270 / 2124 / 2154** (n 32) |
| | subida | 1119 / 3199 | 1414 / 1854 | 985 / 1755 | 917 / 1125 |
| | transcrição idêntica à do clipe | 32 / 32 | 3 / 31 | 35 / 35 | 17 / 32 |
| `campus-slow` (2 Mbit ↓, 512 kbit ↑, 40 ± 10 ms, 1 %), 3 + 3 | primeiro som | 1190 / 1824 / 1837 (n 34) | 1590 / 2229 / 2229 (n 35) | 1182 / 1857 / 1872 (n 27, + 3 `timeout`) | **1104 / 1570 / 1756** (n 31) |
| Limpa, 3 + 3 + 2 Chromium, 180 s | primeiro som | — | — | 1230 / 1746 / 1755 (n 34) | 1205 / 1792 / 1862 (n 33) |
| Limpa, 4 + 4, `--think 2-6`, 300 s | primeiro som | — | — | 1146 / 1771 / 2055 (n 69) | 1187 / 1920 / 2042 (n 67) |

0 falhas e 0 turnos filtrados nos clientes leves, antes e depois, salvo os 3 `timeout` do WS no `campus-slow`. Turnos
`short_audio` na rodada limpa: antes 4 (WS) e 20 (WebRTC), depois 10 e 4. Com 8 sessões no L40S (o perfil serve 4)
cerca de um turno em cinco começa por abertura (87 antes, 70 depois), igual nos dois transportes.

### Chrome real (Mac, Google Chrome, SDK), rede limpa, ms p50 / p95 / max

| | WS antes | WebRTC antes | WS depois | WebRTC depois |
|---|---|---|---|---|
| 4 + 4 alunos: audível no medidor da página | 917 / 1252 / 1285 (n 40) | 1352 / 1660 / 1852 (n 36) | 914 / 1080 / 1095 (n 40) | **1094 / 1279 / 1291** (n 40) |
| subida: fim da fala → `vad end` | 765 / 846 | 1020 / 1054 | 769 / 834 | 754 / 829 |
| estágios: `ttfa` (stt p50) | 100 / 260 (208) | 99 / 247 (208) | 102 / 276 (208) | 104 / 277 (207) |
| descida: `audio_start` → medidor | 37 / 195 | 234 / 430 | 26 / 117 | 185 / 338 |
| — `audio_start` → áudio entregue pelo jitter buffer | | 167 / 374 | | 143 / 286 |
| — jitter buffer (`jitterBufferDelay` / `EmittedCount`) | | 116 / 211 | | 116 / 162 |
| — entrega → medidor (nó WebAudio do harness) | | 56 | | 39 |
| primeiro som no instante da entrega | | 1289 / 1604 / 1790 | | 1042 / 1219 / 1234 |
| 1 + 1 aluno: audível no medidor | 1061 / 1791 (n 10) | 1457 / 1632 (n 9) | 976 / 1086 (n 10) | **1076 / 1241** (n 9) |

`getStats` do WebRTC no Chrome, depois (4 alunos, 150 s cada): jitter buffer 111–123 ms p50, 157–168 p95; alvo e mínimo
do NetEq 100 ms p50, 120–140 p95; jitter entre chegadas 3–4 ms p50, 12–15 p95; RTT 43–52 ms; 0 pacotes perdidos em
~8100 por aluno; 0,1–0,2 % de amostras ocultadas; na subida 1–3 pacotes perdidos e jitter de 8–9 ms. No Chromium do
contêiner: `campus-slow` 92 / 132 ms de buffer, alvo 120, 112 perdidos em 9510, 1 % ocultado; `lossy` (antes) 90 ms,
alvo 120, 514 perdidos em 9083, 4,4 % ocultado. Na pilha local sem rede (modelos falsos) o mesmo Chromium fica em
20–30 ms com alvo 20.

Do lado do edge, por resposta (`metrics`, 197 turnos, 8 sessões): primeiro PCM do TTS → primeiro pacote RTP entregue ao
transporte 12 ms p50 / 20 p95 / 24 max; pacotes dos 2 s seguintes saem 2–3 ms depois da grade de 20 ms no p95, 12 ms
no pior caso (17 no `lossy`). O jitter que o NetEq vê é do caminho (Wi-Fi do Mac → Scaleway), não do edge.

### Onde estava a diferença e o que mudou

| Trecho | Antes | Causa | Conserto | Depois |
|---|---|---|---|---|
| Subida | +197 ms (leves), **+255 ms (Chrome)** | o jitter buffer de áudio do aiortc no edge: 80 ms em todo turno e 280 ms de atraso permanente depois de um pacote perdido | `audio.ArrivalOrder` (primeiro commit do PR): o pacote vira quadro ao chegar | +20 ms (leves, é o Opus do cliente aiortc); **−15 ms no Chrome** |
| Subida com perda | fim de turno esticado, transcrição mutilada (3 de 31 intactas) | pacote perdido sumia do relógio do VAD e do clipe | `audio.GapFill`: o buraco no timestamp RTP entra como silêncio (até 1 s); `metrics.uplink_lost_ms` | `vad end` no harness a 10 % de perda 781–821 → 741–762 ms; 17 de 32 transcrições intactas |
| Estágios | +54 (noite anterior), +91 (antes) | nenhuma no edge: com modelos falsos os estágios são iguais (54 contra 54 ms); a diferença vinha da ordem de chegada na GPU. No Chrome lado a lado os dois alunos falavam em uníssono e o segundo a chegar esperava o STT do primeiro (385 contra 206 ms) | harness: os Chrome entram escalonados | 448 contra 517 (leves), 104 contra 102 (Chrome): sem diferença |
| Descida, edge | 20 ms em toda resposta | o encoder Opus do aiortc recebia 24 kHz e o reamostrador dele segurava cada quadro até o seguinte chegar | o `OutTrack` entrega 48 kHz (`audio.upsample2`) | harness: `audio_start` → primeiro quadro 26–28 → 8–9 ms |
| Descida, primeira frase | até 150–240 ms no p95 | silêncio que o TTS põe antes da frase | corte do silêncio inicial da primeira frase (primeiro commit do PR) | p95 da descida 308 → 233 (leves), 430 → 338 (Chrome) |
| Descida, navegador | 116 ms | jitter buffer do NetEq, alvo 100 ms neste caminho | nenhum: `jitterBufferTarget = 0` já é aplicado no receptor certo antes da mídia (o mínimo medido é o do próprio NetEq), o edge manda silêncio contínuo com timestamps contínuos e no ritmo | 116 ms: **é o que resta** |

O que resta, por medida: nos clientes leves +25 ms no p50 (20 da subida, que é o cliente aiortc reamostrando o
microfone de 16 kHz; a descida de 40 ms é o tique de 20 ms mais o Opus, contra um WS cujo medidor carimba a chegada de
áudio enviado 200 ms adiantado). No Chrome +180 ms no medidor com 4 alunos: 116 do jitter buffer do navegador, ~40 do
nó WebAudio por onde o harness mede o WebRTC, ~15 do tique e do Opus, menos 15 da subida que ficou mais rápida que a do
WS. O jitter buffer depende da rede do aluno (20 ms numa rede sem jitter) e é o que segura o áudio inteiro sob perda.

### Não feito, e por quê

- **FEC / PLC do Opus na subida:** o aiortc 1.15 decodifica pelo wrapper libopus do PyAV, que não tem a flag de FEC e
  não devolve nada para um pacote ausente. Precisaria chamar o libopus direto. Com 5 % de perda metade das
  transcrições sai diferente do clipe (65–66 caracteres em vez de 68); no WS saem todas iguais.
- **Parar o silêncio entre respostas** (para o NetEq começar a fala abaixo do alvo): não testado. O PyAV carimba o
  primeiro pacote depois de um buraco como se não houvesse buraco e o navegador ocultaria em vez de tocar silêncio.
- **Subida atrasada pelo cliente** (os 3500 ms da noite anterior): nesta madrugada o pior fim da fala → `vad end` no
  WebRTC limpo foi 935 ms. Um atraso de segundos na rede do aluno continua sem defesa no edge; é o teto do relógio do
  aluno (#59).
- **Conexão WebRTC sob `lossy`:** o Chromium forçado em `webrtc` não conectou em 3000 ms (`webrtcConnectMs` do SDK) na
  rodada «depois»; os clientes aiortc, com 8 s de prazo, levaram 2000 ms p50 e 3393 p95. Onde o WebRTC mais ajuda é
  onde ele mais demora a subir: o prazo da tentativa em segundo plano merece ser maior. Não mexido.
- **Rodadas perdidas:** a primeira «Chrome 4 + 4» do antes ficou presa ao fechar os navegadores (o harness agora grava
  o resultado antes de fechar e desiste de uma página que não volta); uma «Chrome 1 + 1» do antes perdeu as duas
  sessões aos 55 s (WS e WebRTC juntos, rede do Mac). A «1 + 1» do antes que ficou é a em uníssono.

### Máquinas e custo

| Máquina | De – até (Paris) | Minutos |
|---|---|---|
| `6af8d92e` (antes) | 01:26:12 – 02:19:44 | 53,5 |
| `e9f63425` (depois) | 02:38:58 – 03:26:34 | 47,6 |

101 minutos de L40S, **~€2,48**. Entre as duas a criação foi recusada por cota durante 19 min: a produção
(`aigw-ns-prod`, `parle-speech`) subiu dois L40S às 00:18Z e 00:20Z, o segundo 71 s depois de eu soltar o meu. Nenhum
L4, nenhum Vast, nenhuma outra máquina; nada escrito em produção. `DELETE /v1/deployments/wl-speech` às 03:26:34 →
`Terminated server e9f63425…`, volumes apagados às 03:26:49; gateway local parado. Reaper em dry run com o gateway fora
(`GATEWAY_URL=http://localhost:4170 DEPLOYMENTS_NAMESPACE=marcos-webrtc bun scripts/reap-orphans.ts`): `scaleway seen:
0`, `vast seen: 0`, `planned: []`. Lista direta do projeto (nove zonas) às 01:29Z: nenhum servidor
`aigw-ns-marcos-webrtc`; o que há é da produção (um L40S `parle-speech`, dois L4 `parle-qwen-tts`) e dois
`whisper-stt` parados de `dev-marmos`.

### Imagem do edge

`ghcr.io/marcosremar/aigw-edge:a5dd777f` (workflow `aigw-edge.yml`, disparado pelo push no PR). `DEFAULT_EDGE_IMAGE`
passa a apontar para ela neste PR: é o que o Scaleway sobe. O `EDGE_TAG` da imagem `speech-stack` (o edge que roda no
Vast, de `/opt/aigw-edge`) continua `f66b6b80` até a próxima construção daquela imagem; o teste que prendia os dois ao
mesmo valor agora prende cada um ao seu.

### Transporte padrão

Manter a escada como está (WS em 0,2–0,5 s, WebRTC em segundo plano e troca quando sobe), com o edge novo. Na rede
limpa os dois empatam nos clientes leves e o Chrome paga 100–180 ms pelo jitter buffer; em `campus-slow` e `lossy` o
WebRTC ganha 290 e 250 ms no p95 e 800 ms no máximo, e o WS teve os únicos turnos perdidos. Trocar o padrão para WS só
compensa numa turma em rede boa e estável.

## Prova ao vivo da integração (#70) — 2026-10-09

Branch `rt/integration-2` (PR #70: #67, #68, #63, #62, #64, #66 e agora #65). Gateway local em :4180 a partir do
worktree da integração (`bun serve.ts`, namespace `marcos-proof-70`, estado próprio, `DEPLOYMENTS_MAX_EUR_PER_HOUR=4`),
máquinas só pela API dele. Scaleway L40S-1-48G fr-par-2 do perfil `speech-stack` (€1,4699/h), um por vez. Sexta 09/10,
04:13 → 06:49 Europe/Paris; produção só lida. Mesmo clipe sintético de 4,5 s e voz `abf` do catálogo da réplica.
Relógio dos números de latência: última amostra com voz enviada → primeiro áudio não silencioso recebido (os 700 ms de
endpointing estão dentro).

**Duas máquinas, em sequência.**

| | Imagem | Edge | `LLM_SLOT_CTX` | Quando |
|---|---|---|---|---|
| `p70-a` | `rg.fr-par.scw.cloud/aigw/speech-stack:20261009-0003` | `realtime.edgeImage` = `ghcr.io/marcosremar/aigw-edge:79722253` (o fixado) | 2048 | 04:13 → 05:04 |
| `p70-b` | `rg.fr-par.scw.cloud/aigw/speech-stack:20261009-0213` (a fixada, com `GET /debug/gpu`) | o do perfil, `79722253` | 4096 | 05:04 → 06:49 |

Os itens 4, 5, 6, 7 (reserva, reaper), 10 (2048) e 12a/b rodaram em `p70-a`: o código do edge é o mesmo de `p70-b`
(`79722253`), só a imagem dos modelos é a anterior (sem `/debug/gpu`). Os itens 1, 2, 3, 7 (limites por app,
`tts_overlong`), 10 (4096) e 11 rodaram em `p70-b`, a combinação exata que o branch fixa.

**Interrupção.** O gateway local recebeu SIGTERM às 05:11 (cota da sessão do agente, não falha do código) com `p70-b`
recém-criado. Reiniciado às 05:19 no mesmo diretório de estado: a réplica foi **adotada** (`ready`, `udp: ok` em 15 s),
nenhuma máquina órfã. Durante os 8 min sem gateway nada recolheria a máquina — o «deadman» (DELETE agendado) seguia vivo.

### Veredito por item

| # | Item | Resultado |
|---|---|---|
| 1 | Primeiro boot da imagem nova, um turno por degrau, `done.served` | **passou**: `20261009-0213` sobe no L40S, `/health` `warm`, `llm_ctx` 4096, modelos `large-v3` / `Qwen3.5-9B-Q4_K_M.gguf` / `Qwen/Qwen3-TTS-12Hz-0.6B-Base`. `ws`: primeiro som 822 ms, `served` completo (`voice abf`, `opener false`, `transport ws`). `webrtc` (em `p70-a`, mesmo edge): 1386 ms audível no Chrome, `served` completo. `s2s-stream` (Chrome): 736 ms no relógio do aluno, sem `served`. POST `/v1/s2s`: 200, primeiro byte 690 ms, 5,7 s de áudio, `route` = `deployment:p70-b`, sem `served`. **`served` só existe nas sessões do edge e no caminho composto (fallback)**: no degrau de clipe servido pela GPU quem respondeu sai do `route` / `X-Gateway-Provider`, como a doc diz (`docs/realtime.md` § served) |
| 2 | Regressão de base, 4 WS + 4 WebRTC, 760 s | **passou no teto, pior no p50 do WS**: WS 1278 / 1755 / 1936 (n 198), WebRTC 1319 / 1861 / 2015 (n 196). Ontem WS 1036 / 1744 / 1980 e WebRTC 1298 / 1893 / 1944. Máximo 2015 ≤ 2500. 0 falhas, 0 erros, 47 turnos com abertura (11,9 %). Ver «4096 por slot» abaixo: o LLM foi de 198 a 461 ms ao longo da rodada |
| 3 | Capacidade com tempo de pensar (`--think 2-6`, 300 s, WS) | **passou**: 8 alunos 1013 / 1545 / 1743 (n 150, 0 % aberturas); 12 alunos 1279 / 1750 / 1932 (n 214, 12,1 % aberturas; áudio da resposta 1279 / 2920 / 3345). Ontem com 8: 1131 / 1743 / 2008, 1 %. 0 erros de upstream (ontem 1 a 12) |
| 4 | #67 no edge real | **passou**: `config_update` com `system`/`voice`, com `messages` de papel `system` e com `max_tokens` → `error forbidden` cada um, o turno seguinte responde com a persona assinada; os frames que o SDK manda de verdade (`messages` user / assistant, a chave de abertura) aceitos sem erro e usados (a resposta seguinte chama o aluno pelo nome que veio no histórico) |
| 5 | #68 config por referência, intercepts, say, update assinado, reply_guard | **passou até ~12 KB; 16 KB abre mas não responde (defeito, abaixo)**: 7 KB — admissão 200 em 38 ms (config de 9892 caracteres fora do token de 380), WS 2 turnos e WebRTC 3 turnos (922 / 1043 ms) respondidos; 12 KB (16 732 caracteres) — WS 1381 / 790 ms, WebRTC 3 turnos 915 / 1135 ms; 16 KB (22 204 caracteres) — admissão 200, sessão abre, **cada turno termina em `error upstream` + `done{error}`**: o prompt de sistema sozinho dá 4711 tokens, acima dos 4096 do slot (`exceed_context_size_error`), e o corte do histórico não encolhe o sistema; ~26 KB → 413 `config_too_large` (35 884 > 32 768), como a regra diz. `intercepts`: «mais devagar» → `intercept` + `done{intercepted, tag slower}` sem chamar o LLM (contador de chamadas igual antes/depois), «quais são as opções» → `say` falado em 65 ms sem LLM; turno normal depois sem custo (ttfa 66 ms). Update assinado: `say` (`done{said:true, tag opening}`), `drop_turn`, troca de `system` (a resposta seguinte segue o novo), adulterado → `forbidden bad_signature`. `reply_guard`: abertura negada regenerada uma vez (`reply_retries 1`) |
| 6 | #62 dispositivos | **passou**: dispositivo listado; bloqueio com WS aberta → fechada 1008 `device_blocked` em 12 ms, reabrir 403; com WebRTC → sessão apagada na réplica em 45 ms, nova oferta e nova admissão 403; `requireDevice` → sem id 403 `device_required`, com outro id 200 |
| 7 | #63 | **passou, com uma ressalva**: `reserveQuota` com janela ativa → `wake` de outro deployment do mesmo tipo 409 com o motivo e `Retry-After`, visível em `/capacity` dos dois; limite por app (`dailyRequests 2`) → 3.ª chamada 429 `daily_budget_exhausted`, `appBudgets` mostra 2/2, volta ao padrão com `null`; reaper sem chave de admin → «NOT CHECKED (no admin key: cross-check off) — 1 machine(s) listed, none compared, nothing released» + 4 máquinas alheias de cota listadas; `tts_overlong` 0 em 758 turnos de carga e nenhuma resposta cortada (ms de áudio por caractere p05 64 / p50 71 / p95 79, mín 59, sem cauda baixa). Ressalva: `/health` `commit`/`builtAt` só aparecem quando o processo recebe as variáveis do build (o gateway local de `bun serve.ts` mostrou `null` depois do reinício); conferir no deploy |
| 8 | #66 fallback com especulação | **não rodado: chave da OpenRouter expirada** (`401 API key expired` às 05:28) |
| 9 | #64 | **parcial**: a sonda UDP roda e decide o caminho (`inbound udp/50100: ok`, 46–67 ms, `path direct`) antes de o WebRTC ser oferecido. O resultado mora no edge (o gateway o grava lá), então depois de reiniciar o gateway a primeira admissão ofereceu `webrtc` em 44 ms, 0,16 s depois de a réplica voltar a `ready`, sem sondar de novo — o certo. **A espera de até 2,5 s na primeira admissão de uma réplica nova não foi medida**: `p70-b` ficou pronta com o gateway fora do ar, e uma terceira réplica (`p70-c`) pedida às 06:11 para isso ficou sem estoque de L40S em fr-par-2 por 30 min (4 tentativas do controlador, um servidor criado que não ligou e foi limpo) e foi apagada. Reputação de host, `files` por link assinado e `requireWebrtc`: **não rodado: conta Vast sem crédito** (`insufficient_credit` às 04:48) |
| 10 | Sessão longa, 4 × 60 turnos, prompt da escola (~4,6 KB) | **2048: passou** — 228 turnos, 0 falhas, 949 / 1399 / 1758; o prompt do LLM estaciona em 1100–1324 tokens (corte do histórico agindo), 0 respostas 400, LLM 137 ms do início ao fim. **4096: passou** — 201 turnos (48–56 por aluno), 0 falhas, 0 erros, 983 / 1584 / 2076, 3 % com abertura; o prompt chegou a 2863 tokens em 50 turnos, então **o corte em 4096 não chegou a agir** (precisaria de ~70 turnos com esse prompt); LLM 158 → 259 ms ao longo da rodada |
| 11 | VRAM com 4096 | **passou**: `GET /debug/gpu` (novo nesta imagem) — ociosa 28 891 MiB usados / 17 177 livres de 46 068; com 8 alunos até 29 249 / 16 819; com 12 até 29 217. 16 slots × 4096 cabem com folga |
| 12a | `interrupted` com `--client-deadline` | **consertado e re-medido**: causa — com a página encerrando o turno, o VAD do servidor e o `end_turn` da página disparam com milissegundos de diferença; quando o VAD ganhava, o `end_turn` achava uma resposta em curso e nenhum áudio novo, cancelava a resposta como substituída e respondia `done{empty}`. Não era a abertura do cliente, nem o `config_update {opener:null}` × #67, nem eco no microfone. Conserto `7972225` (um `end_turn` do cliente depois do fim pelo VAD é o mesmo fim), com teste. Ao vivo: 8 / 8 turnos respondidos, 0 `interrupted`, 886 / 1055 / 1055 (Chrome, WS); no `p70-b`, `end_turn` logo depois do `vad end` → uma resposta, nenhum evento a mais. A abertura do próprio cliente não foi re-medida (vem da TTS de nuvem, cuja chave expirou) |
| 12b | harness parado com `s2s-stream` | **não se repetiu**: Chrome em `s2s-stream` com `--uplink-stall 3000 --client-deadline`, 8 turnos, o processo terminou sozinho (os máximos de 3,8–4,4 s dessa rodada são o travamento de 3 s injetado de propósito) |
| 12c | `error upstream` depois de `audio_start` | **não apareceu** em ~1370 turnos de carga desta noite (0 eventos `error` nos relatórios das rodadas de carga). Os únicos `error upstream` da noite são os do prompt de 16 KB (item 5), antes de qualquer áudio, com a causa no texto do erro |

### Descida do WebRTC: a «regressão» de 17–21 ms não se confirma

Suspeita: na integração o primeiro quadro de áudio sairia 17–21 ms depois do `audio_start`, contra 6–8 ms no branch do
#71. O código da descida (`OutTrack`, `AudioOut`, `_first_reply_audio`, o consumidor de `_answer`) é idêntico entre #65 e
a integração. O cenário `webrtc_network` do harness com só 3 turnos por rede é o que deu 21: o quadro às vezes perde uma
volta do relógio de 20 ms, nos três branches. Repetido 8 × 3 turnos (rede limpa, aiortc real, mesmo Mac):

| Branch | Primeiro quadro após `audio_start`, mediana (n) | Voltas perdidas (≥ 14 ms) |
|---|---|---|
| integração `557bed6` | **5 ms** (24) | 2 |
| #65 `cb6466e` | 8 ms (24) | 1 |
| #71 `ca0242a` | 5 ms (48) | 5 |

O harness inteiro da integração passou 133 / 133 na segunda rodada (a primeira caiu nesse cheque com `[5, 21, 21]`; a do
#65 já tinha `[22, 4, 8]`, a do #71 `[5, 21, 6]`). Ao vivo, edge da integração: PCM → primeiro RTP 11 ms p50 / 21 p95
(394 turnos) contra 12 / 20 da prova do #65. **Nenhum conserto**: não há regressão no código; o cheque de 3 turnos é
instável e pode cair em qualquer branch.

### 4096 por slot

VRAM sobra (item 11), mas sem corte de histórico o prompt cresce turno a turno e o LLM fica mais lento: na rodada de 760 s
com 8 alunos o primeiro token foi de 198 ms (primeiros 150 s) a 461 ms (600–750 s) e as aberturas subiram de 4 para
10–14 por janela de 150 s; com 2048 e 4 alunos durante 800 s o LLM ficou em 137 ms do começo ao fim, e com 4096 e 4
alunos foi de 158 a 259 ms. Hipótese, não verificada: o prompt maior é reprocessado a cada turno (llama.cpp com
`--cache-ram 0`, sem garantia de que o mesmo slot atende a mesma conversa).
Produção segue em 2048 (o perfil `speech-stack` tem 4096; o `parle-speech` declarado não): **manter 2048 em produção**.

### Defeitos achados

| Defeito | Estado |
|---|---|
| `end_turn` da página logo depois do fim pelo VAD cancelava a resposta (12a) | **consertado** em `7972225`, com teste, re-medido ao vivo (8 / 8 respondidos) |
| Um prompt de sistema maior que o slot do LLM (16 KB de português ≈ 4,7 mil tokens contra 4096) abre a sessão e falha **todo** turno com `error upstream` | **aberto, não consertado aqui** (mexe no edge: nova imagem, nova cópia, novo boot). Hoje o limite prático é ~12 KB de sistema com 4096 e ~5 KB com 2048; o prompt da escola tem 4,6 KB. Conserto sugerido: recusar na admissão (o gateway sabe o `llmCtx` da réplica) ou no `ready` do edge com um código próprio, em vez de falhar turno a turno |
| `/health` sem `commit`/`builtAt` num gateway iniciado sem as variáveis do build | a conferir no deploy (§ 12.4 do runbook): não é defeito do código, mas a prova do que roda depende disso |
| `short_audio` do harness marca como «truncadas» respostas de 59–62 ms por caractere (5 em 394 na rodada de base) | **falso positivo do harness**: nenhuma tinha `tts_overlong`, todas terminaram com `audio_end` e a distribuição de ms por caractere é contínua (p05 64). Não mexido |
| `exhaustedAt` continua `null` em `appBudgets` depois de um 429 por orçamento | menor, só observação |

### Teto de 2500 ms como máximo

**Segurou** em todas as rodadas sem falha injetada: 2015 (base, 394 turnos), 1743 (8 com pensar), 1932 (12 com pensar),
1758 (longa 2048), 2076 (longa 4096), 1845 (base em `p70-a`), 1055 (Chrome com prazo do cliente). Só passou na rodada com
travamento de subida de 3 s injetado de propósito (4449), que é o caso que a abertura do cliente cobre — e essa abertura
não pôde ser medida (TTS de nuvem sem chave).

### GO / NO-GO

- **Merge do #70: GO.** Tudo o que pôde rodar ao vivo passou; a suspeita de regressão na descida do WebRTC não se
  confirma; nenhum turno perdido nem erro de upstream em ~1370 turnos de carga; CI verde no `557bed6`. O merge sozinho
  não muda produção.
- **Deploy: GO com condições**, fora de seg–qui 17:40–20:15:
  1. `LLM_SLOT_CTX` fica em **2048** no `parle-speech` (não adicionar 4096: a VRAM cabe, mas o LLM fica mais lento com
     o histórico longo e o corte não foi exercitado em 4096).
  2. **Especulação desligada** (`speculatePauseMs` não usado pela escola) e o fallback composto tratado como **não
     provado**: a chave da OpenRouter servida pela API dev está expirada — rotacionar e rodar o item 8 antes de contar
     com o fallback numa aula (hoje ele já não responderia, com ou sem este deploy).
  3. Nada de Vast para a escola (`requireWebrtc`, `files` por link assinado, reputação de host): não provado, conta sem
     crédito.
  4. A escola tira qualquer mudança de campo assinado do lado do cliente antes de o edge novo servir uma turma (§ 12.2),
     e mantém o prompt de sistema bem abaixo do slot (defeito acima).
  5. Ordem do runbook § 12.4 (gateway, reaper com chave de admin); conferir `/health` `commit`/`builtAt` depois.

### O que mudou no código nesta prova

- `7972225` edge: `end_turn` do cliente depois do fim pelo VAD do servidor é o mesmo fim (item 12a), com teste.
- `65df869` speech-stack: `GET /debug/gpu` (item 11), com teste; embarcado em `20261009-0213`.
- `6418318` harness: os clientes leves (`ws` e aiortc) mandam a config por referência (prompt da escola).
- `3275783` / `557bed6`: imagens fixadas (runbook § 12.5).

### Máquinas e custo

| Máquina | Período (Paris) | Horas | € |
|---|---|---|---|
| `p70-a` L40S-1-48G | 04:13:38 → 05:04:23 | 0,85 | 1,24 |
| `p70-b` L40S-1-48G | 05:04:44 → 06:49:00 | 1,74 | 2,55 |
| cópia da imagem para o registro Scaleway, POP2-HC-8C-16G | 04:46 → 05:04 | 0,30 | ~0,09 |
| `p70-c` (sem estoque; um servidor criado e apagado sem ligar) | 06:11 → 06:49 | 0 | ~0 |
| Vast (`insufficient_credit`) | — | 0 | US$ 0 |
| **Total** | | | **≈ €3,9** |

Desmontagem: `p70-b` e `p70-c` apagados às 06:48 (servidor e volume apagados no log), gateway local parado, deadman e
contêiner do gerador encerrados. **Listagem do lado do provedor** com o gateway parado (reaper em modo `gateway-down`,
dry run, namespace `marcos-proof-70`): `scaleway seen 0`, `vast seen 0`, `planned []`. As máquinas alheias que ele
lista são 4 POP2 parados de `dev-marmos/whisper-stt`, não desta prova. Nenhum arquivo com token literal deixado nos
diretórios de rascunho. Produção não foi tocada (só GETs de leitura); a porta 4000 e `~/.ai-gateway` não foram usadas.

## Plano B ao vivo: especulação, cadeias mais rápidas, prazo do cliente (2026-10-10, `feat/faster-fallback`)

Sem máquina, sem GPU, produção só lida (GET). Um gateway local deste worktree (porta 4250, `DEPLOYMENTS_ENABLED=0`,
`--no-wake`, chave nova da OpenRouter vinda da API dev), cadeias postas por `MODEL_ROUTES` com um alias por braço,
para os braços rodarem juntos. Turno: fala gTTS pt-BR de 5,4 s (16 kHz), prompt de padeira de ~90 tokens, 3 mensagens
de histórico, `max_tokens` 160. `load.ts --n 4 --s2s 4 --no-wake --ramp 10 --duration 110 --turn-every 8 --jitter 2`,
quatro braços de cada rodada ao mesmo tempo (16 alunos), 50–55 turnos por braço. Relógio: do fim da fala (pedido − 700 ms)
ao primeiro áudio da resposta. Gasto na OpenRouter na sessão inteira: US$ 1,20 no contador da chave (de 0,001 a 1,198).

Braços (`main` = o que produção tem hoje, conferido por `GET /v1/apps/parle/routes`):

| Braço | STT | LLM | Voz |
|---|---|---|---|
| main | `openai/whisper-large-v3-turbo` (o `groq` seguinte é `no_key`) | `qwen/qwen3.5-9b` → `gemini-2.5-flash-lite` | `mai-voice-2.1-flash` → Kokoro |
| llm | como main | `gemini-2.5-flash-lite` → `qwen3.5-9b` | como main |
| mid | `deepgram/nova-3` → `whisper-large-v3` → turbo | como llm | como main |
| fast | `deepgram/nova-3` → `whisper-large-v3` | como llm | `elevenlabs/eleven-flash-v2.5` → MAI → Kokoro |

### 1. Especulação (#66) com a reserva viva — item 12 do § 12.7 do runbook: passa

| Rodada (CEST) | Braço | lead 0: p50 / p95 / máx | lead 500: p50 / p95 / máx | Especulação |
|---|---|---|---|---|
| 13:26 | main | 3029 / 5478 / 6440 | 2799 / 4591 / 8947 | 51 enviadas, 51 `hit` |
| 13:52 | main | 2853 / 3677 / 3921 | 2462 / 3257 / 3355 | 52 / 52 `hit` |
| 13:52 | llm | 2657 / 3850 / 4897 | 2175 / 3094 / 3929 | 55 / 55 `hit` |
| 13:30 | mid | 2710 / 3286 / 3901 | 2173 / 3603 / 3791 | 54 / 54 `hit` |
| 13:26 | fast | 2431 / 3478 / 4034 | **1966 / 2730 / 2897** | 53 / 53 `hit` |
| 13:30 | fast | — | **1799 / 2532 / 2800** | 52 / 52 `hit` |

A especulação esconde o lead: a transcrição existe 250–420 ms depois do pedido (STT inteiro 750–920 ms p50). Com 30 %
de pausas retomadas (`--speculate-resume 0.3`, braço fast): 67 enviadas, 15 canceladas, 52 `hit`, 104 frases em 52
turnos (nenhum turno falado duas vezes), 1878 / 2578 / 3236 ms. O máximo de 8947 ms da rodada 13:26 é um STT de 5,9 s
do Whisper turbo sozinho (um elo só: o orçamento de 3 s não vale).

**A abertura do servidor esconde o ganho.** Com `first_audio_deadline_ms` 2000 e uma abertura ("Hum, deixa eu ver."),
ela toca aos 1,7 s em quase todo turno e a resposta só começa quando ela acaba: rodada 13:23, fast com especulação
2810 ms p50 (sem abertura, 1966), main 3519 com e sem especulação. Com a reserva rápida a resposta chega aos ~2 s, logo
depois da abertura começar. O parle não manda abertura no `/v1/s2s` hoje (`config.opener` ausente no código dele); quem
mandar perde 0,8 s de mediana nesse caso. Não mudado aqui.

### 2. Cada estágio pela OpenRouter, direto (13:17–13:30, 4–6 chamadas cada)

| Estágio | Modelo | p50 (mín–máx) ms | Nota |
|---|---|---|---|
| STT | `deepgram/nova-3` | 543 (426–960) | transcrição exata; US$ 0,0000717/s |
| STT | `assemblyai/universal-3-5-pro` | 636 (493–821) | exata |
| STT | `fish-audio/transcribe-1` | 706 (668–811) | exata |
| STT | `elevenlabs/scribe-v2` | 877 (770–957) | exata |
| STT | `openai/whisper-large-v3-turbo` (hoje) | 935 (389–1295) | pontuação solta |
| STT | `openai/whisper-large-v3` | 1033 (790–2124) | exata |
| STT | `microsoft/mai-transcribe-2` | 1026 (602–2306) | exata |
| STT | `gpt-4o-mini-transcribe`, `gpt-transcribe`, `voxtral-mini-transcribe`, `gemini-3.5-transcribe`, `grok-stt-1.0` | — | 404 pela privacidade (ZDR) da conta |
| LLM 1º token | `google/gemini-2.5-flash-lite` | 300 (265–498) | |
| LLM 1º token | `mistral-small-3.2-24b` · `gemini-3.1-flash-lite` · `qwen3.5-9b` (hoje) · `gemma-3-27b` | 530 · 550 · 580 · 618 | `gemini-3.5-flash-lite` e `gpt-oss-20b`: raciocínio obrigatório (400) |
| Voz 1º byte | `elevenlabs/eleven-flash-v2.5` / `turbo-v2.5` | 308 / 292 | pt multilíngue com vozes prontas inglesas; US$ 20/M caracteres (MAI: 15) |
| Voz 1º byte | `hexgrad/kokoro-82m` | 508 (390–1285) | |
| Voz 1º byte | `microsoft/mai-voice-2.1-flash` (hoje) / `mai-voice-2-flash` | 684 / 713 | |
| Voz 1º byte | `eleven-v3-conversational`, `eleven-v4-turbo`, `gemini-3.8-flash-lite-tts` | 846, 900, 1799 | `minimax`, `qwen-audio`, `grok-voice`: 404 (ZDR) |

Nenhum STT por streaming pela OpenRouter (§ Fallback em streaming continua valendo). No turno, por estágio (p50, braço
fast com especulação): fim de fala 700 + resto do STT 340–420 + 1º token 345–370 + corte 70 + 1º byte da voz 305–310.

### 3. Prazo no relógio do aluno (#59) com a abertura falada pelo cliente

Chrome real (Mac), degrau `s2s-stream` (sem GPU não há `ws`), 1 aluno, 12 turnos, cada 3ª fala retida 3 s
(`--uplink-stall 3000`), cadeia main, abertura do cliente pela voz de nuvem (`speak` → `/v1/audio/speech`, MAI):

| | Turnos retidos: primeiro som audível | Outros turnos |
|---|---|---|
| sem `--client-deadline` | 4983 · 5236 · 5063 · 5430 ms | 1914–2334 ms |
| com `--client-deadline` | **2020 · 2023 · 2020 · 2030 ms** (abertura local aos 2014–2016 ms, resposta aos 4811–6711 ms) | abertura do servidor aos 1710 ms, resposta 1828–2191 ms |

O teto funciona com a voz de nuvem. Nenhum turno `interrupted` nos 12 (o defeito de 08/10 foi no `ws`, que aqui não
roda). Limite: o Chrome manda o mesmo clipe a cada turno e o gateway devolve a transcrição do cache, então as respostas
desta tabela não medem o STT; só o tempo da abertura é a medida.

### 4. Veredito contra a meta do dono (1–1,5 s, teto 2 s)

- Não alcançada. O melhor braço (fast + especulação) dá 1,8–2,0 s p50 e 2,8–2,9 s de máximo; 15–23 % dos turnos
  ≤ 1,5 s.
- O que está no parle hoje: 2,9–3,1 s p50, até 6,4 s.
- Ordem dos ganhos, todos configuração do parle (`backend/speech/gateway-routes.ts` + `deploy:gateway-routes`) ou da
  página dele:
  1. especulação na página: −0,4 a −0,5 s;
  2. voz ElevenLabs flash: −0,35 a −0,4 s, com a ressalva de sotaque e de duas vozes por gênero no lugar da voz por
     personagem;
  3. Gemini primeiro: −0,2 s e a cauda do Qwen;
  4. nova-3 primeiro: −0,1 s e a cauda.

**Feito nesta rodada:**
- PR do parle com o Gemini primeiro (pedido do dono, 08/10/2026), sem deploy.
- STT e voz ficam para o dono decidir. Mudam o que o estudo transcreve e o que o aluno ouve (regra 28 do parle).
- Amostras das vozes foram guardadas fora do git.

### 5. «error upstream» depois do início do áudio

- Só o edge emite `code: upstream`.
- **TTS de uma frase falhando depois de a resposta já soar:**
  - **antes:** o turno inteiro morria (`audio_start, error, done{error}`), e as frases seguintes, já sintetizadas, eram
    jogadas fora;
  - **agora** (`aigw_edge/session.py` `_answer`): a frase é pulada (`sentence_failed`, telemetria
    `edge.tts.sentence_failed`), o resto toca e o `done` traz `missing_audio`, como o `/v1/s2s` já fazia;
  - antes do primeiro som continua sendo erro;
  - teste: `tests/test_session.py` «break after audible audio», vermelho antes e verde depois.
- Nos logs de produção do gateway de 09–10/10 não há `edge.upstream.error`: a telemetria do edge fica no stdout da
  réplica. O turno do smoke não foi achado.
- **LLM caindo no meio do stream depois do som:** não mudado. Continua `error`. É a outra causa possível.

### 6. Cota de GPU da Scaleway (API IAM `quota`, leitura, 10/10 13:20)

| Tipo | fr-par-2: cota · estoque · €/h | pl-waw-2: cota · estoque · €/h |
|---|---|---|
| H100-1-80G | 2 · available · 2,87 | 2 · shortage · 2,87 |
| L40S-1-48G | 2 · shortage · 1,47 | 2 · scarce · 1,47 |
| L4-1-24G | 2 · available · 0,79 | 2 · available · 0,79 |

- A cota não é 0. O lugar H100 em fr-par-2 serve de fato: cabe no `maxEurPerHour` 3 do `parle-speech`, com só € 0,13
  de folga.
- Em pl-waw-2, o H100 é pulado enquanto houver falta de estoque.
- Nenhum servidor GPU está ligado no projeto.
- Não precisa pedir aumento de cota para 1–2 réplicas. Se a turma pedir 3 ou mais réplicas H100 na mesma zona, aí
  precisa.

## WebRTC: perda na subida, conexão em rede ruim e resgate de subida travada (2026-10-09)

Branch `rt/webrtc-open`, sobre `rt/webrtc-latency` (PR #65) e com `rt/integration-2` (PR #70) mesclada. **Só código e
testes locais**: nenhuma máquina, nenhuma GPU, nada em produção. O que está abaixo vem do harness de loopback do edge
(aiortc real nas duas pontas, modelos falsos), de um banco de perda sem rede com Whisper `small` local, e de um
Chromium real (o do app desktop) contra o edge local. Falta a prova ao vivo de cada item; os comandos estão no fim.

### 1. Fala do aluno mutilada pela perda de pacotes na subida — consertado no edge e no SDK, falta medir ao vivo

Um pacote perdido virava 20 ms de silêncio. Agora o edge reconstrói o trecho, em três camadas (`audio.LossDecoder`,
libopus chamado direto por `ctypes` na biblioteca que o PyAV já traz; conferido na imagem Linux do edge):

| Camada | O que é | Quem liga |
|---|---|---|
| RED (`audio/red`, RFC 2198) | cada pacote traz uma cópia inteira do anterior | o SDK põe `red` primeiro na oferta; o edge aceita com o número e o `fmtp` do navegador |
| FEC do Opus | cópia de baixa taxa do quadro anterior dentro do pacote | a resposta do edge leva `useinbandfec=1`; o Chrome liga quando os relatórios RTCP mostram perda |
| PLC do Opus | o decodificador inventa o trecho a partir do que veio antes | sempre, para o que as duas não cobrem |

Nada espera: o buraco só é conhecido quando o pacote seguinte chega, e é ele que o preenche. O tempo decorrido é o
mesmo de antes (fim de turno no harness 741–762 ms com 0, 2, 5 e 10 % de perda). O edge continua enviando Opus puro.

**Banco de perda** (`tests/loss_bench.py`, `scripts/realtime-e2e/fixtures/voice-pt.wav` de 7,4 s, Opus 32 kbit/s mono
em pacotes de 20 ms, perda independente por pacote, 10 sorteios por taxa, Whisper `small` local; «intacta» = transcrição
idêntica à do clipe sem perda, 18 palavras):

| Perda | Antes (silêncio) | FEC | FEC + PLC | RED + FEC + PLC |
|---|---|---|---|---|
| 0 % | 1 / 1, WER 0 | 1 / 1, 0 | 1 / 1, 0 | 1 / 1, 0 |
| 2 % | 2 / 10, WER 11,7 % | 5 / 10, 6,7 % | 5 / 10, 6,7 % | **10 / 10, 0 %** |
| 5 % | 0 / 10, 21,1 % | 1 / 10, 12,2 % | 2 / 10, 10,6 % | **7 / 10, 3,3 %** |
| 10 % | 0 / 10, 29,4 % | 0 / 10, 17,2 % | 0 / 10, 18,3 % | 0 / 10, 12,8 % |
| áudio perdido reconstruído (2 / 5 / 10 %) | 0 | 93 / 81 / 74 % | idem, o resto ocultado | 99 / 98 / 96 % |
| SNR contra o clipe sem perda, dB (2 / 5 / 10 %) | 12,5 / 9,5 / 6,7 | 24,3 / 19,3 / 13,8 | 24,7 / 20,3 / 15,3 | 92 / 62 / 28 |

Leitura: o FEC sozinho corta o erro pela metade; o PLC quase não muda a transcrição (muda o que se ouve); o RED é o que
traz as transcrições de volta, porque devolve o áudio original e não uma aproximação. A 10 % nenhuma estratégia mantém
a frase idêntica neste clipe (voz sintética, Whisper pequeno, que já erra o clipe limpo): o número serve para comparar
as colunas, não como WER de aula. O WS continua sendo o único transporte em que a fala chega sempre inteira.

**Harness de loopback** (tom sintético, 3 turnos por rede): 0 buracos de silêncio no áudio que o STT recebe em todas as
redes (antes: um por pacote perdido); com RED 260 de 280 ms, 780 de 820 ms e 1360 de 1600 ms reconstruídos a 2, 5 e
10 %; `metrics` novos `uplink_recovered_ms`, `uplink_fec_pct`, `uplink_red_pct`.

**Chromium real contra o edge local, 10 % dos pacotes descartados na entrada do edge:** sem a preferência por RED o
navegador mandou FEC em 56 % dos pacotes e 520 de 960 ms perdidos foram reconstruídos; com a preferência mandou RED em
100 % dos pacotes e 900 de 960 ms foram reconstruídos, com o áudio da resposta tocando normalmente. Esse teste achou
dois defeitos que o aiortc contra aiortc não mostra, ambos consertados: o aiortc respondia o RED com outro número de
payload (o 63 do Chrome está abaixo da faixa que ele trata como dinâmica) e sem o `fmtp:63 111/111`, e nos dois casos
o Chrome não enviava RED.

**NACK / RTX para áudio: não feito, de propósito.** A retransmissão chega uma ida e volta mais o temporizador do
emissor depois (150 ms ou mais no `lossy`); o RED já traz o pacote perdido 20 ms depois, sem pedir.

### 2. WebRTC não conectava em rede ruim dentro dos 3 s do SDK — consertado, falta medir ao vivo

Dois prazos separados. O que decide quem serve o **primeiro** turno não mudou. A tentativa de WebRTC atrás de um WS que
já serve o aluno agora é paciente: 12 s por tentativa (`upgradeConnectMs`), 2 tentativas com espera de 2 s
(`upgradeTries`, `upgradeBackoffMs`), dentro de 40 s (`upgradeMs`); a segunda tentativa é uma oferta nova na mesma
sessão do edge. A troca continua só entre turnos. Uma tentativa que desiste é silenciosa (nenhum erro, nenhum áudio),
fecha todas as conexões e apaga a sessão no edge. WebRTC forçado (sem WS na escada) recebe o mesmo prazo e depois um
erro claro (`no_transport`, «webrtc: not connected within 12000 ms»). Candidatos ICE colhidos depois da oferta vão por
HTTP para `iceUrl`. No edge, o temporizador de retransmissão do canal de dados (SCTP) começa em 0,5 s em vez dos 3 s
do aiortc.

Tempo de conexão no harness, 30 conexões por rede, 75 ms de atraso em cada sentido (cliente com o temporizador SCTP do
Chrome):

| Rede | Edge antes | Edge depois |
|---|---|---|
| sem perda | 31 ms | 31 ms |
| 5 % | mediana 1368 ms, max 5869; **6 de 30 acima de 3 s** | mediana 892, max 2896; **0 de 30** |
| 10 % | mediana 1883 ms, max 7449; **8 de 30 acima de 3 s** | mediana 1371, max 5029; **3 de 30**, todas dentro dos 12 s |

### 3. Subida travada por segundos na rede do aluno — construído, com limite declarado; falta medir ao vivo

O edge responde a todo `end_turn` do cliente com `turn_ack`, na hora. Se 1,2 s depois do fim do turno (`rescueMs`) o
SDK não viu nenhum sinal do turno vindo do edge, manda a fala que acabou de gravar como **um clipe** por HTTP (`s2s`,
o degrau de clipe que já existe). Daí em diante vale quem responder primeiro, e só ele: se o caminho travado dá sinal
antes, o clipe é abortado; se o clipe responde antes, o transporte travado é **fechado** (a sessão dele no edge acaba,
nada do que ele mandar depois é entregue), a resposta toca uma vez, e uma sessão realtime nova assume entre turnos com
a conversa repetida. Se o clipe falha, nada muda e a sessão continua esperando. Nunca mais de um turno de clipe a mais
por turno resgatado. Telemetria `turn.rescued {from, to, stallMs}` e `ackMs` em todo `turn.done`: as aulas reais vão
mostrar quantas vezes a rede da sala faz isso.

A deduplicação fica no cliente, não no servidor: o degrau de clipe pode cair em outra réplica, que não conhece o turno.

Limites: só arma depois de o edge ter mandado um `turn_ack` na sessão (imagem nova do edge); precisa do VAD do cliente
(`voice`) ou de a página passar o clipe em `sendEndTurn(clip)`; o clipe é o WAV de 16 kHz que o degrau de clipe já usa
(um Opus seria uns 8× menor, mas o primeiro STT da cadeia já recusou webm). **Não ajuda** quando a rede inteira cai
por aqueles segundos (o clipe espera junto) nem quando quem trava é a captura ou o processo do cliente: os 3500 e
9102 ms da noite de 08/10 saíram de clientes leves do harness no Mac, e ali não dá para dizer qual foi o caso. Ajuda
quando um fluxo TCP fica preso atrás de uma retransmissão ou de fila enquanto o caminho já voltou.

### 4. Transporte pela rede medida na sessão (`transportPolicy: "auto"`) — construído, opcional, falta medir ao vivo

Sem a opção nada muda (WS no início, WebRTC assim que conecta). Com `"auto"`: começa sempre no WS; o WebRTC sobe em
segundo plano e fica de reserva a sessão inteira, medindo a própria rede (perda e jitter da subida pelos relatórios do
edge, com uma cópia muda da faixa do microfone); uma amostra por turno; a decisão é uma função pura. Perda de 2 % ou
mais, ou travada de 800 ms ou mais, em 3 turnos seguidos → WebRTC. 3 turnos limpos seguidos no WebRTC → volta ao WS.
Só entre turnos, com espera mínima de 60 s depois de uma troca e no máximo 4 trocas por sessão. UDP bloqueado → fica
no WS sem tentar. Turno travado no WS → o resgate do item 3 responde e a sessão vai depois para o WebRTC de reserva.
`fidelity: true` (transcrição é dado): não vai para o WebRTC sob perda sem a recuperação do item 1 negociada, e volta
ao WS se ela não aparecer nos `metrics` dos turnos com perda. `"ws"` nunca tenta WebRTC. Telemetria
`transport.switch {from, to, reason, lossPct, jitterMs, stallMs}` e `rt.network.summary` no fim da sessão. Política,
padrões e a razão de cada limiar: `docs/realtime.md` § Transport by network signal.

Custo do `"auto"`: uma conexão a mais por aluno aberta a aula toda (silêncio nos dois sentidos, ~20 kbit/s de subida)
e o edge decodificando esse silêncio (~2 % de um núcleo por aluno).

### Testes

| O quê | Onde | Resultado |
|---|---|---|
| Edge, unidades | `docker/aigw-edge/tests/run.sh units` | passam (decodificador com FEC, PLC e RED; resposta SDP; `turn_ack`) |
| Edge, harness de loopback antes da mescla | `run.sh harness` | 174 / 174 |
| Edge, harness depois da mescla com `rt/integration-2` | idem | tudo passa menos **uma checagem que já falha na `rt/integration-2` sozinha** (`3275783`): «the first reply frame is heard within one frame of audio_start», 17–21 ms em vez dos 6–8 ms da PR #65. Não é desta branch |
| SDK | `sdk-realtime-*.test.ts`, `__tests__/unit/realtime` | 325 passam (novos: `-upgrade`, `-rescue`, `-policy`); os de regressão falham sem o conserto |
| Typecheck, lint, fitness, bundle | | verdes; o pacote `realtime` cresceu 88,8 → 110,3 KB (4,4 KB são da integração), aceito no baseline com o motivo |

Os scripts de carga (`--profile-then`, `--transport-policy`, `--fidelity`, o clipe em `sendEndTurn`) só rodam em Linux
com root: **não foram executados aqui**.

### Comandos para a prova ao vivo (numa réplica com a imagem nova do edge)

Variáveis de sempre: `GW`, `KEY`, `DEP`, `RT_CONFIG`; Linux com root para os perfis de rede.

```bash
# 1. Perda na subida: WS de controle, WebRTC leve e Chrome, nos três perfis. No report.json: uplinkRecoveredMs,
#    uplinkRedPct (100 no Chrome = RED chegando), uplinkFecPct, e as transcrições idênticas ao clipe por transporte.
for p in clean campus-slow lossy; do
  bun scripts/realtime-e2e/load.ts --n 6 --rtc 3 --chrome 2 --chrome-transports webrtc \
    --clip scripts/realtime-e2e/fixtures/voice-pt.wav --profile $p --duration 180 --out out/loss-$p
done
#    uplink_red_pct e uplink_fec_pct nulos em todo turno WebRTC = o edge não carregou o libopus (imagem errada).
#    No Chrome, com a página aberta (chrome://webrtc-internals ou o console):
#      pc.remoteDescription.sdp.match(/a=(rtpmap|fmtp):\d+ .*(red|opus|useinbandfec).*/g)   → red primeiro, fmtp 111/111
#      [...(await pc.getStats()).values()].filter(s => s.type === 'remote-inbound-rtp' || s.type === 'outbound-rtp')
#        → packetsLost / fractionLost do que o edge recebeu; bytesSent dobra quando o RED está ligado
# O mesmo banco sem rede, para comparar (venv do edge, depois um Python com openai-whisper):
python docker/aigw-edge/tests/loss_bench.py clips scripts/realtime-e2e/fixtures/voice-pt.wav /tmp/loss 10
python3 docker/aigw-edge/tests/loss_bench.py wer /tmp/loss small

# 2. Conexão em rede ruim: Chrome forçado em WebRTC e Chrome na escada, perfil lossy. Esperado: 0 «no_transport»,
#    connectMs até ~5 s no forçado; na escada transport final webrtc; rt.webrtc.retry na telemetria quando repetiu.
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports webrtc --profile lossy --duration 180 --out out/connect-forced
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports '' --profile lossy --duration 180 --out out/connect-ladder
ONLY=scenario_webrtc_connect_loss CONNECT_RUNS=30 EDGE_VENV=<venv> docker/aigw-edge/tests/run.sh harness   # local

# 3. Resgate: a fala de um turno em cada três fica presa 3 s no WS. Antes: 3559 / 3699 ms até a resposta.
#    Esperado: turn.rescued com stallMs ~1200 nos turnos presos, resposta por volta de 1,2 s + um turno de clipe,
#    uma resposta só por turno. O harness também segura um POST de clipe em cada três: o primeiro resgate cai no
#    caso «o clipe demora, o caminho travado volta antes» e termina sem turn.rescued.
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports ws --client-deadline \
  --uplink-stall 3000 --uplink-stall-every 3 --profile clean --duration 240 --out out/rescue

# 4. Política: rede limpa fica no WS; lossy vai para o WebRTC depois de 3 turnos; a rede piora no meio e melhora.
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports '' --transport-policy auto --profile clean --duration 300 --out out/auto-clean
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports '' --transport-policy auto --profile lossy --duration 300 --out out/auto-lossy
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports '' --transport-policy auto --profile campus-slow --duration 300 --out out/auto-campus
bun scripts/realtime-e2e/load.ts --n 4 --chrome 4 --chrome-transports '' --transport-policy auto --fidelity \
  --profile clean --profile-then lossy@90 --duration 420 --out out/auto-change
#    Nos eventos de cada sessão Chrome: transport.switch {from, to, reason, lossPct, jitterMs, stallMs} e
#    rt.network.summary no fim; turn.done traz o transporte de cada turno.
```

### Imagem do edge

Construída e fixada em 10/10: ver § Prova ao vivo da PR #71 abaixo.

## Prova ao vivo da PR #71 — 2026-10-10

Branch `rt/webrtc-open` com o `main` mesclado (#70, #72–#85). Gateway local do worktree em :4241 (`bun serve.ts`,
namespace `marcos-proof-71`, estado próprio, sem `SANDBOX_TOKEN` nem chave Vast no processo, `DEPLOYMENTS_MAX_REPLICAS=1`).
Uma máquina: Scaleway L40S-1-48G do perfil `speech-stack` (imagem `20261009-0213`), `pl-waw-2` (fr-par-2 sem estoque às
14:04), €1,4699/h, sábado 10/10, ligada 14:05:18 → apagada 15:33:25 Paris. Clientes num contêiner Linux do colima
(Chromium 154 com o SDK, `ws` em Bun, `webrtc` em aiortc) atrás do netns com `tc` do harness; perfis novos `loss-2`,
`loss-5`, `loss-10` (20 ms de atraso e a perda em cada sentido) e os de sempre (`lossy` = 75 ms + 5 %). Clipe
`voice-pt.wav` (7,4 s), voz de referência curta assinada na config (o catálogo da réplica estava vazio).

**Três braços, mesma máquina, mesma sessão.** O edge da réplica é um contêiner que só troca com outra máquina, então o
`main` contra a branch na mesma GPU foi feito assim:

| Braço | Edge | SDK / harness | Caminho até a GPU |
|---|---|---|---|
| A | `main` (fonte, no contêiner) | `main` | edge local → proxy que põe o token da réplica → modelos da L40S |
| B | branch (fonte, no contêiner) | branch | idem |
| M | branch (`5540dfa1`, sidecar da réplica) | `main` | gateway → réplica (caminho real) |
| R | branch (`5540dfa1`, sidecar da réplica) | branch | gateway → réplica (caminho real) |

A e B rodaram em sequência, com o gateway, o edge e o Chrome no mesmo contêiner de 6 vCPU: várias rodadas saíram com o
aviso «generator SATURATED» do harness, então a latência desses braços não vale; transcrição, recuperação e eventos
valem. Cadência de 12 ± 2 s com um clipe de 7,4 s: a fala seguinte corta a resposta anterior (os «truncated:interrupted»
dos relatórios), sem efeito nas medidas abaixo.

### 1. Perda na subida

STT real da L40S (Whisper large-v3) sobre os clipes do banco de perda (`loss_bench.py clips`, 10 sorteios por taxa);
«silêncio» é o que o edge do `main` faz, «RED+FEC+PLC» o que a branch faz com o Chrome:

| Perda | silêncio (`main`) | FEC | FEC+PLC | RED+FEC+PLC (branch) |
|---|---|---|---|---|
| 2 % | 8/10 intactas, WER 1,1 % | 10/10, 0 | 10/10, 0 | **10/10, 0** |
| 5 % | 5/10, 5,8 % | 9/10, 0,5 | 8/10, 3,2 | **10/10, 0** |
| 10 % | 3/10, 5,3 % | 8/10, 2,1 | 6/10, 2,1 | **10/10, 0** |

Ao vivo, Chrome em WebRTC (intactas = transcrição igual à do clipe sem perda; WER contra ela):

| Rede | A (`main`) | B (branch) | R (branch, sidecar) |
|---|---|---|---|
| `loss-2` | 12/15, WER 1,4 % | 7/12, 2,6 % (gerador saturado) | — |
| `loss-5` | 8/15, 3,9 % | 9/14, 2,3 %; RED 100 %, 96 % do perdido reconstruído | 13/14, 0,4 % |
| `loss-10` | **1/13, 13,0 %** | **10/12, 1,3 %**; RED 100 %, 94 % reconstruído | — |
| `lossy` (75 ms, 5 %) | 14/26, 5,5 % | 17/23, 1,4 %; 97 % reconstruído | M: 9/21, 3,3 %, 0 reconstruído · **R: 15/26, 2,2 %, RED 100 %, 97 % reconstruído** |

No WS (controle) todas as transcrições saíram intactas em todas as redes. O cliente leve aiortc (sem RED) recupera
35–42 % pelo FEC. Primeiro som no caminho real com perda (R `loss-5`): Chrome 1870 / 3382 ms p50 / max, WS 1544 / 1908.

### 2. Conexão em rede ruim (`lossy`)

| | WebRTC forçado, 3 Chrome | escada com WS primeiro, 2 Chrome |
|---|---|---|
| M (SDK do `main`) | 3/3 conectaram, 3,2–4,4 s (todas acima de 3 s) | **1 de 2 tentativas de WebRTC desistiu** («not connected within 3000 ms»); esse aluno ficou no WS |
| R (branch) | 3/3, 3,6–7,9 s (todas acima de 3 s) | 2/2 conectaram (2,5 e 5,6 s) |
| A / B (local) | 3/3, 2,2–3,9 s (1 acima de 3 s) / 3/3, 2,0–3,0 s (0 acima de 3 s) | — |

Leitura: com o SDK novo nenhuma tentativa desistiu; o tempo de conexão em si não melhorou nesta amostra (n pequeno, a
rede do Mac até a Polônia com 75 ms de cada lado). O harness local de 30 conexões (§ 2 acima) segue sendo a medida do
temporizador SCTP.

### 3. Resgate da subida travada (WS, fala presa 3 s a cada três, `--client-deadline`)

| | Turnos presos | Tempo até o primeiro som nos presos |
|---|---|---|
| M (`main`) | nenhum resgate (não existe) | 4,3–4,6 s (p90 4328, max 4588) |
| R (branch) | `turn.rescued` com `stallMs` 1803–2137 ms; o primeiro resgate de cada aluno cai de propósito no POST de clipe também segurado e termina sem resgate, como previsto | **2,9–3,1 s** (`turn.done` 2855–3140 ms) |

**Defeito achado ao vivo e consertado** (`7486e33`, teste em `sdk-realtime-rescue`): depois do resgate o SDK tenta
uma sessão realtime nova; quando ela não abre (`rt.readmit.gave_up no_transport`, aqui porque o harness segura também
o WS novo enquanto a fala dura), os eventos do degrau de clipe ficavam presos ao turno resgatado e **todo turno seguinte
ficava sem resposta** (0 respostas em ~100 s por aluno, nas duas rodadas antes do conserto: B local e R). Depois do
conserto, mesma máquina: os turnos seguintes são respondidos pelo degrau de clipe (`turn.done` 1,4–2,1 s; ~4,5 s nos
turnos em que o harness segura o POST de clipe de propósito). Junto,
`sendEndTurn(clip)` num degrau de clipe manda o clipe como turno (`148c190`).

### 4. Troca de transporte pelo sinal de rede (`transportPolicy: "auto"`)

| Rodada | Resultado |
|---|---|
| R `clean`, 120 s | ficou no WS a sessão inteira (21 turnos; 1302 / 1455 ms p50 / max) |
| R `lossy`, 150 s | trocou WS → WebRTC aos 44 e 50 s, `reason loss`, `lossPct` 5,6 e 5,3, depois de 3 turnos com perda |
| R `clean` → `lossy` aos 60 s, `--fidelity`, 210 s | trocou aos 106 e 112 s (46–52 s depois da mudança), `lossPct` 4,3, com o RED negociado; nenhuma volta (a rede não melhorou) |
| M `lossy` (escada do `main`) | troca para WebRTC assim que conecta (um aluno); o outro ficou no WS por desistência |

Freios: nenhuma sessão trocou mais de uma vez; a espera de 60 s e o teto de 4 trocas não chegaram a ser exercitados.

### Imagens

| Imagem | Tag | Digest | De onde |
|---|---|---|---|
| `ghcr.io/marcosremar/aigw-edge` | `5540dfa1` | `sha256:f3fb1f953dc88b9d4dcfe92688abbf66cdb8ad216d11a74cd6202bb51d65d975` | workflow `aigw-edge` por `workflow_dispatch` na branch, commit `5540dfa` (a mescla com o `main`) |
| `ghcr.io/marcosremar/speech-stack` | `20261010-1135` | `sha256:fa088ee4bb0c61d19a9df2a1946835073f30c5774aa798c14bab93f728895fb0` | workflow `speech-stack` disparado pela PR no commit `d76e7b8` (`EDGE_TAG=5540dfa1`); **não fixada**: o perfil usa a cópia do registro Scaleway `20261009-0213`, e a cópia nova pede outra máquina |

`DEFAULT_EDGE_IMAGE` e o `EDGE_TAG` do speech-stack apontam para `5540dfa1@sha256:f3fb1f95…`. A imagem do edge leva só
`requirements.txt`, `telemetry.py` e `aigw_edge/`, e nada disso mudou depois de `5540dfa` (os commits seguintes mexem
em testes, harness, SDK e docs). Observação: o `main` fixava `79722253`, anterior a #19, #16 e T3 no código do edge;
a imagem nova é a primeira com esse código.

### Máquinas e custo

| Máquina | Período (Paris) | € |
|---|---|---|
| L40S-1-48G `74560f5a` pl-waw-2 | 14:05:18 → 15:33:25 (88 min) | ~2,16 |
| duas criações em fr-par-2 sem estoque (servidor criado e limpo sem ligar) | 14:04 | ~0 |

Desmontagem: `DELETE /v1/deployments/p71-speech` às 15:33:24; listagem direta das nove zonas da Scaleway depois: nenhum
servidor nem volume desta prova (o que existe é da produção e de `dev-marmos`). Reaper em modo `gateway-down`, dry run,
namespace `marcos-proof-71`, gateway parado: `scaleway seen 0`, `vast seen 0`, `planned []`. Arquivo do token da
réplica apagado. Nenhum Vast, nenhum L4, nada escrito em produção.
