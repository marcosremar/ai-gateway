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
- **`parle-speech` image**: the gateway never tried the pull — every boot logs `GHCR_READ_TOKEN is not set`. The image
  exists (`speech-image.yml` green for `9a87056aa1`) but the package is private (manifest 403 anonymously). Needs a
  `read:packages` token stored as `GHCR_READ_TOKEN` in the dev API, or a public package. Until then a production
  replica of `parle-speech` does not boot.
- **Restarting the gateway parks a `minReplicas: 0` replica** right after "replica ready"; with the GPU out of stock
  the wake then fails and the halted replica blocks a new create.
- `error: upstream` after `audio_start` appeared in two of four live turns while the audio still played. Not
  investigated.
- Local e2e after the timeout fix and the probe-port change: **29/29** (Linux VM, Bun 1.4.2).
- `scripts/realtime-e2e/e2e-live.ts` + `page-live.js` drive a real gateway and real Chrome for the scenarios above;
  `serve.ts` gained two test knobs (`REALTIME_NET_RECHECK_MS`, `REALTIME_PROBE_UDP=blocked`).
- Worth a look in the Scaleway console: reserved IPs and security groups named `aigw-marcos-rt-*` left by the TURN
  boxes; the gateway API cannot list them.
