# Implemented — Security, Auth & Input Validation (pass 07)

Localized, low-risk hardening of security **primitives** only. No previously-dead
middleware (RBAC, CSRF, per-key limiter, DLP) was wired into the live server
request path in this pass — that changes runtime behavior and is deferred to a
server-owner coordination pass (see "Deferred"). All edits stay inside the owned
file set.

Tests: `__tests__/opt/07-security.test.ts` (38 tests, all pass).
Run: `bunx vitest run --config vitest.opt.config.ts __tests__/opt/07-*.test.ts`

## Changes

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| 651 | src/gateway/guardrails/rules/webhook.ts:2,33-58 | Webhook rule now validates `rule.url` before `fetch`: http(s) scheme allowlist + `validateEndpointUrlResolved` (DNS-resolving SSRF blocklist). Fails **closed** (blocks) on private/metadata/loopback or non-http(s) targets — a moderation webhook pointed at `169.254.169.254`/`10.x`/`localhost` is never legitimate. | `#651 webhook rule SSRF guard` (blocks 11 private/metadata/loopback URLs + 4 bad schemes + invalid URL **without** calling fetch; allows public https via mocked fetch) |
| 651b | src/gateway/guardrails/rules/webhook.ts:14,~95-110 | Bound the webhook response body (`content-length` + post-read length, 64 KB cap) before `JSON.parse` to stop CPU/memory amplification from a hostile/slow-loris endpoint; oversized → fail-open. Switched `res.json()` → size-checked `res.text()`+`JSON.parse`. | `treats an oversized webhook response as fail-open`, `fails open on a non-2xx response` |
| 684 | src/gateway/guardrails/engine.ts:37-58 | `extractResponseText` no longer `JSON.parse`s string bodies larger than 1 M chars — returns them opaquely to avoid a parse CPU spike on huge non-JSON responses. | `#684 extractResponseText size guard` |
| 670 | src/input-validator/index.ts:74-89 | `validateNumber` now rejects non-finite via `Number.isFinite` instead of bare `isNaN` (`isNaN(Infinity)===false` previously let `Infinity`/`-Infinity` through with no min/max). | `#670 validateNumber rejects non-finite` |
| 667 | src/input-validator/index.ts:51-76 | `sanitizeString` gains opt-in `rejectOverLength` so security-relevant fields can return `null` on over-length instead of silently truncating (mangling meaning). Default behavior unchanged (still truncates). | `#667 sanitizeString rejectOverLength` |
| 613 | src/auth-middleware/index.ts:21 | Removed dead `import { safeGet, requireDefined }` (never referenced). | covered indirectly — module imports/compiles in suite |
| 648 | src/vault/vault-singleton.ts:5-37 | Added `isValidVaultMasterKey` and a fail-loud check in `initVaultFromEnv`: a malformed `VAULT_MASTER_KEY` now throws a clear startup error (64 hex / 44 base64 = 32 bytes) instead of a deferred throw on first encrypt. | `#648 isValidVaultMasterKey` |
| 699 | src/middleware/security-headers.ts:15-26 ; server/middleware/security-headers.ts:15-29 | Added `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Resource-Policy: same-origin` to **both** header copies (kept byte-identical to avoid drift). Additive only. | `#699 security headers` (asserts both headers present + `applySecurityHeaders` doesn't overwrite caller-set headers) |

## Primitives verified correct + tested (no code change needed)

These were already hardened by a prior pass; this pass adds the missing unit
coverage requested in the task (pure functions, no network):

- `detectInjection` / `sanitizePrompt` / `maskApiKey` / `sanitizeModelName` /
  `sanitizeLanguageCode` (src/middleware/sanitization.ts) — injection patterns,
  no false-positive on JSON braces, HTML escaping, control-char stripping,
  short-key collapse to `***`.
- `detectPII` (src/providers/dlp.ts → cloud/dlp.ts) — disabled-by-default,
  credit-card/ssn/email detection, masked values, `minMatches` against total
  count, ReDoS-guarded custom pattern doesn't hang.
- `checkContent` (src/providers/guardrails.ts → cloud/guardrails.ts) —
  disabled-by-default, word-boundary stem match, no "skillet"→"kill" false
  positive.
- `createPerKeyRateLimiter` / `parseKeyQuotas` (src/middleware/per-key-rate-limit.ts)
  — quota enforcement, per-key isolation, override of `*` default, `reset()`,
  non-negative retry/reset, wildcard default present.
- SSRF primitives (`isPrivateUrl`, `validateEndpointUrl`) — metadata host +
  decimal-encoded loopback (`2130706433`) blocked; public host allowed.
- CSRF (`generateCsrfToken`/`verifyCsrfToken`) — round-trip + tamper/wrong-secret
  rejection (timing-safe compare).

## Deferred (and why)

**Wiring dead middleware into the live request path — explicitly out of scope.**
Behavior-changing; needs server-owner coordination (handlers live in
`server/ws-server.ts` / `server/ws/http-api-server.ts`, which are not owned here).
- #611 wire `requireAuth`/`requireRole`; #601 per-route RBAC; #686/#688/#693 wire
  per-key/cost-weighted rate limiting onto HTTP + speech endpoints; #676/#677/#678
  wire/enable DLP + guardrails; #639 wire shared WS rate limiter; #630 register
  `handleRecallWebhook`; #689 spend-based circuit on chat/speech path.

**GPU-token format changes — compatibility risk.** #621 (`aud` binding), #620
(`kid`), #622 (`jti` replay), #619 (`GPU_ACCESS_SECRET_PREVIOUS` rotation): all
change the signed payload / verification contract shared with the GPU pod image.
Changing one side without the other breaks auth; needs coordinated rollout.

**Vault rotation re-architecture — too large / stateful.** #642 (decrypt-by-version),
#643 (atomic rotation snapshot), #650 (audit log): each is M+ effort touching the
store contract and `EncryptedBlob` shape; out of "localized S/M" scope.

**Cross-module / `src/modules/` drift consolidation.** #614/#627/#658/#615: collapsing
the `src/modules/` mirror or `src/index.ts` re-exports touches files outside the
owned set and/or `src/index.ts` (forbidden).

**Owned but lower-value / behavior-shifting, skipped to keep diffs minimal:**
- #668 (`Schemas.Filter` arbitrary record), #669 (Zod path echo in errors): would
  alter validation surface/error contract used by callers; defer with the broader
  validation pass.
- #612 (dev-bypass logging), #640/#641 (vault KDF / AAD): #640/#641 change the
  crypto contract (AAD bound to ciphertext would make existing blobs undecryptable
  without a migration) — defer to a vault migration pass.
- #679 (guardrail fail-closed flag), #685 (Zod-validate DLP config): engine/config
  behavior changes; defer with the guardrail-wiring pass so fail-open/closed is
  decided alongside activation.

**Not owned (other domain files referenced by the audit):** all `server/ws/*`,
`server/recall-handlers.ts`, `src/contracts/index.ts` (#662-665, #674 schema
caps), `src/gateway/proxy/*`, `src/gateway/pipeline/ssrf-protection.ts` edits
(#653-660), `src/alerting/*` (#661) — skipped per ownership; SSRF module was
**imported** (not edited) by the webhook fix.
