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
