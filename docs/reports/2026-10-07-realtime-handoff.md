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
