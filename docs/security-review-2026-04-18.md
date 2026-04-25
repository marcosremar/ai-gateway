# Security Review - 2026-04-18

## Scope

This review focused on the active HTTP and WebSocket delivery layer in `server/`, plus the Docker image builder and workload orchestration paths registered by the gateway.

Primary trust boundaries reviewed:

- HTTP admin surface on `PORT`
- WebSocket surface on `PORT + 1`
- Docker image builder (`/v1/docker/*`)
- Workload lifecycle (`/v1/workloads*`)
- GPU lifecycle and settings (`/v1/gpu/*`)
- Config mutation (`/v1/config/*`)

## Executive Summary

The gateway currently has a broken HTTP trust boundary.

The main WebSocket paths enforce `GATEWAY_API_KEY` or localhost-only access, but the HTTP server created in `server/ws/http-api-server.ts` does not enforce the same policy before dispatching requests into route handlers. Because many registered routes are administrative, this turns the HTTP surface into a control plane without authentication for any client that can reach the port.

The most serious downstream impacts are:

- remote configuration mutation, including rewriting `.env`
- unauthorized GPU and workload lifecycle actions
- abuse of `/v1/gpu/heartbeat` to keep tiers warm and extend spend
- unauthorized GitHub device-flow and Docker build actions
- local file exfiltration through the Docker image builder
- browser-based abuse via permissive CORS
- memory exhaustion due to eager request buffering before downstream size checks

## Remediation Status

The findings below were reviewed and mitigated in the codebase on 2026-04-18.

- HTTP control-plane auth is now enforced centrally in `server/ws/http-api-server.ts` before workload, Docker, or flat-route dispatch.
- CORS is now allowlist-based instead of reflecting arbitrary origins or defaulting to `*`.
- HTTP request bodies are streamed through the Bun adapter with early size enforcement instead of being fully buffered first.
- Manual body parsing on the main flagged admin endpoints was replaced or wrapped with shared size-limited helpers.
- The Docker image builder now restricts build contexts to approved roots, rejects symlinks, and excludes common secret-bearing files.
- `/recall/audio` now fails closed unless a valid Recall secret or the normal gateway WebSocket auth succeeds.
- SSRF checks now normalize alternate IP notations, stop relying on substring-based localhost exemptions, and resolve meeting URLs to catch DNS-to-private-IP bypasses.
- Regression tests were added for the new auth, CORS, body-limit, builder, and Recall WebSocket behavior.

## Severity Scale

- `P0`: critical compromise of the control plane or direct secret/infrastructure takeover
- `P1`: high-impact data exposure, privilege misuse, or fail-open auth
- `P2`: material weakness that amplifies exploitability or enables denial of service

## Findings

### 1. P0 - Missing authentication boundary on the HTTP control plane

**What happens**

The HTTP server dispatches requests directly to route handlers without enforcing `GATEWAY_API_KEY`, role checks, or the localhost-only fallback used elsewhere.

**Evidence**

- `server/ws/http-api-server.ts:85-139`
  - starts `Bun.serve()` and dispatches all HTTP routes
  - no auth gate is applied before `routeWorkloadRequest`, Docker dynamic routes, or flat handler lookup
- `server/routes/index.ts:46-64`
  - registers the full HTTP surface, including gateway, compute, and diagnostics routes
- `src/gateway/proxy/server.ts:445-465`
  - separate proxy server already implements the expected auth model
- `src/auth-middleware/index.ts:92-118`
  - reusable auth middleware exists, but is not applied by the main HTTP server

**Why this is exploitable**

Any client that can reach the HTTP port can invoke administrative routes directly. The problem is not theoretical: multiple route modules register mutation endpoints without wrapping auth.

Concrete exposed control-plane routes include:

- config mutation in `server/routes/gateway/config.ts:19-28`
- GPU lifecycle and snapshot routes in `server/routes/gateway/gpu.ts:51-126`
- GPU latency settings in `server/routes/gateway/gpu-settings.ts:16-34`
- workload CRUD in `server/ws/http-api-server.ts:104-113` plus `server/workload-handlers.ts:161-193`
- Docker auth/build routes in `server/routes/compute/images.ts:25-42`
- diagnostics and request logs in `server/routes/diagnostics/metrics.ts:17-25`

**Highest-impact examples**

- `.env` rewrite through `POST /v1/config/api-keys`
  - `server/config-handlers.ts:172-233`
  - attacker can set or replace provider keys persisted on disk
- arbitrary GPU control
  - `POST /v1/gpu/deploy`, `POST /v1/gpu/stop`, `POST /v1/gpu/resume`, `POST /v1/gpu/terminate`
- arbitrary workload control
  - `POST /v1/workloads`, `POST /v1/workloads/:id/start`, `POST /v1/workloads/:id/stop`, `DELETE /v1/workloads/:id`
- spend amplification
  - `POST /v1/gpu/heartbeat` in `server/routes/gateway/gpu.ts:72`
  - handler resets idle timers in `server/gpu-handlers.ts:1685-1714`

**Impact**

- full administrative control over the Gateway delivery layer
- mutation of provider secrets and runtime settings
- unauthorized tier deploy, stop, resume, terminate, sweep, and snapshot actions
- ability to keep GPU tiers warm and defeat idle stop behavior
- access to request logs and service diagnostics

**Recommended remediation**

1. Add a single auth gate in `server/ws/http-api-server.ts` before any route dispatch.
2. Reuse the same model already implemented in `src/gateway/proxy/server.ts`.
3. Keep only explicit public routes unauthenticated:
   - `GET /health`
   - optionally `GET /metrics` if intentionally exposed behind network controls
4. Apply auth before:
   - dynamic workload routing
   - Docker dynamic routes
   - flat handler dispatch
5. Add regression tests proving all admin routes fail closed without a valid token.

### 2. P1 - Arbitrary local directory exfiltration through the Docker image builder

**What happens**

`/v1/docker/build` accepts an arbitrary `dirPath`, resolves it on the server, recursively reads files, and pushes them into a GitHub repository for build execution.

**Evidence**

- `server/image-build-handlers.ts:184-217`
  - accepts `dirPath` from the request body
- `src/compute/image-builder/image-build-service.ts:35-49`
  - resolves any supplied path and only checks that the directory exists and contains a `Dockerfile`
- `src/compute/image-builder/github-repo.ts:86-113`
  - recursively collects files
  - excludes only `.git`, `node_modules`, and `.DS_Store`
- `src/compute/image-builder/github-repo.ts:281-310`
  - pushes the collected files into a GitHub repo and triggers a workflow

**Why this is exploitable**

The server does not restrict `dirPath` to a safe workspace root, a configured allowlist, or an operator-approved build directory. In this repository specifically, the project root already contains a `Dockerfile`, so the root can be submitted as-is.

That means the builder can upload:

- repository source
- `.env` if present in the build directory
- local config files
- other secrets accidentally stored alongside Docker build contexts

**Symlink traversal makes this worse**

`collectFiles()` uses `statSync(abs)` and `readFileSync(abs)` rather than `lstatSync()` and explicit root containment checks:

- `src/compute/image-builder/github-repo.ts:87-110`

Because `statSync()` follows symlinks, a symlink inside the build directory can point outside the intended tree and still be read and uploaded. Even if `dirPath` is later restricted to the workspace, symlinks can still punch through that boundary unless they are explicitly blocked.

**Impact**

- exfiltration of local source and secrets to GitHub/GHCR
- accidental or malicious publication to public repositories when `isPublic` is set
- expansion of compromise from "admin API misuse" to "host file disclosure"

**Recommended remediation**

1. Restrict `dirPath` to a configured allowlist of build roots.
2. Resolve the canonical real path and enforce that every traversed file stays under that root.
3. Switch from `statSync()` to `lstatSync()` and reject symlinks by default.
4. Add a denylist for sensitive files:
   - `.env`
   - `.npmrc`
   - `.pypirc`
   - `*.pem`
   - `*.key`
   - `.ssh/`
   - any AI Gateway state or vault files
5. Consider requiring explicit operator confirmation for new build roots.

### 3. P1 - `/recall/audio` fails open when `RECALL_WS_SECRET` is unset

**What happens**

The Recall WebSocket path is handled before general WebSocket auth. If `RECALL_WS_SECRET` is missing, the route upgrades without requiring either a Recall secret or `GATEWAY_API_KEY`.

**Evidence**

- `server/ws-server.ts:174-185`
  - special-cases `/recall/audio`
  - only validates a token if `RECALL_WS_SECRET` exists
  - otherwise upgrades immediately
- general WebSocket auth starts later at `server/ws-server.ts:188-202`
  - it is never reached for `/recall/audio`

**Why this is exploitable**

An attacker can connect to `/recall/audio` and send fake audio or metadata whenever the deployment forgets to set `RECALL_WS_SECRET`. This is a classic fail-open path on an integration-specific trust boundary.

**Impact**

- unauthorized Recall audio injection
- bogus status transitions and noisy downstream processing
- bypass of the otherwise stronger WebSocket auth model

**Recommended remediation**

1. Make `/recall/audio` fail closed.
2. Require one of:
   - valid `RECALL_WS_SECRET`, or
   - successful general `GATEWAY_API_KEY` auth
3. Refuse startup, or emit a hard error, when Recall integration is enabled without a secret.

### 4. P1 - HTTP body limits are bypassed by eager buffering in the Bun adapter

**What happens**

The Bun-to-Node adapter reads the entire request body into memory with `req.arrayBuffer()` before route-specific parsing or size enforcement runs.

**Evidence**

- `server/ws/http-api-server.ts:106-107`
  - buffers workload route bodies before dispatch
- `server/ws/http-api-server.ts:121-123`
  - buffers Docker dynamic route bodies before dispatch
- `server/ws/http-api-server.ts:137-138`
  - buffers all other non-GET/HEAD bodies before dispatch
- downstream size limits live in:
  - `server/http-utils.ts:35-67` for JSON bodies
  - `server/http-utils.ts:70-115` for raw bodies

**Why this matters**

The size checks in `readJsonBody()` and `readRawBody()` happen after the request has already been fully materialized into memory by the adapter. This means the protective limits are too late to prevent memory pressure from oversized requests.

This is especially important because the HTTP control plane is currently unauthenticated, so a client does not need valid credentials to send oversized requests.

**Impact**

- memory exhaustion
- OOM kills or severe latency spikes
- route-specific body limits provide less protection than they appear to

**Recommended remediation**

1. Stop using `await req.arrayBuffer()` as the generic adapter strategy.
2. Stream the Bun request body into the fake Node request in chunks.
3. Enforce a top-level max body size before buffering.
4. Keep route-specific limits, but apply them before full materialization.

### 5. P2 - Several active endpoints parse request bodies without any explicit size cap

**What happens**

Some handlers bypass shared body helpers and manually accumulate request chunks into memory.

**Evidence**

- `server/image-build-handlers.ts:189-194`
- `server/gpu-handlers-info.ts:754-767`
- `server/gpu-handlers-info.ts:823-825`
- `server/gpu-handlers.ts:1695-1700`

Examples:

- `POST /v1/docker/build`
- `POST /v1/gpu/preflight`
- `POST /v1/errors/alerts/acknowledge`
- `POST /v1/gpu/heartbeat`

**Why this matters**

Even after fixing the adapter-level eager buffering, these handlers still need their own size limits. Right now they assume trusted callers and small payloads, which is unsafe for network-facing routes.

**Impact**

- easy memory-amplification DoS on admin paths
- inconsistent request-hardening across the HTTP surface

**Recommended remediation**

1. Replace manual parsing with `readJsonBody()` where possible.
2. Add route-specific body caps for these endpoints.
3. Treat all control-plane bodies as hostile unless proven otherwise.

### 6. P2 - Permissive CORS makes the local control plane browser-reachable

**What happens**

The HTTP server reflects any incoming `Origin` and otherwise falls back to `*`.

**Evidence**

- `server/ws/http-api-server.ts:42-45`
  - every response inherits `Access-Control-Allow-Origin: <origin> || *`
- `server/ws/http-api-server.ts:95-101`
  - preflight reflects the incoming origin

**Why this matters**

With the current missing HTTP auth boundary, a malicious website can call the gateway running on localhost or a reachable host and read the responses directly from browser JavaScript. This turns what might otherwise be "network-adjacent" exposure into a drive-by browser exploit against operators.

Even after auth is fixed, permissive CORS should still be restricted to an allowlist because the gateway serves sensitive administrative data and mutation endpoints.

**Impact**

- browser-based abuse of the HTTP control plane
- easier exploitation from phishing or malicious docs/pages opened by an operator
- direct cross-origin reading of responses from admin endpoints

**Recommended remediation**

1. Replace origin reflection with an explicit allowlist.
2. Default to no CORS header for unknown origins.
3. Add `Vary: Origin` when dynamic allowlisting is used.
4. Treat the admin UI origin separately from public API consumers.

## Additional Notes From The Review

These were checked and intentionally not reported as active vulnerabilities:

- The general WebSocket paths do enforce auth or localhost-only access:
  - `server/ws-server.ts:188-202`
- The bot debug proxy code exists, but the active route registration in `server/routes/compute/bots.ts:17-23` only exposes:
  - `/v1/bot/deploy`
  - `/v1/bot/status`
  - `/v1/bot/join`
  - `/v1/bot/leave`
  - `/v1/bot/terminate`
- A Recall webhook handler exists in `server/recall-handlers.ts:211-255`, but I did not find it registered in the active HTTP route table, so I did not count it as an exposed webhook vulnerability in this pass.
- SSRF protection does exist for some remote endpoint flows via `src/gateway/pipeline/ssrf-protection.ts`.

## Suggested Fix Order

1. Fix the HTTP auth boundary in `server/ws/http-api-server.ts`.
2. Lock down the Docker image builder path handling and symlink behavior.
3. Make `/recall/audio` fail closed.
4. Replace eager request buffering with streaming plus hard caps.
5. Tighten CORS to an explicit allowlist.

## Short-Term Validation Checklist

- Unauthenticated `POST /v1/config/api-keys` returns `401`
- Unauthenticated `POST /v1/gpu/deploy` returns `401`
- Unauthenticated `POST /v1/workloads` returns `401`
- Unauthenticated `POST /v1/docker/build` returns `401`
- Oversized HTTP requests are rejected before full buffering
- `/recall/audio` rejects connections when `RECALL_WS_SECRET` is absent
- Browser requests from non-allowlisted origins do not receive readable CORS responses
