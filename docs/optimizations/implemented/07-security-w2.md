# Implemented — Security, Auth & Input Validation (pass 07, wave 2)

Continuation of [`07-security.md`](07-security.md). A second batch of localized,
low-risk hardening of security **primitives** only. As in wave 1, **no
previously-dead middleware (RBAC, CSRF, per-key limiter, DLP, guardrails) was
wired into the live server request path** — that is behavior-changing and needs
server-owner coordination (handlers live in `server/ws-server.ts` /
`server/ws/http-api-server.ts`, not owned here). All edits stay inside the owned
file set: `src/auth/`, `src/vault/`, `src/input-validator/`, `src/middleware/`,
`src/null-safety/`, `src/gateway/guardrails/`, `src/auth-middleware/`.

Tests: `__tests__/opt/07-security-w2.test.ts` (29 tests, all pass). Wave-1
suite (`07-security.test.ts`, 38 tests) re-run and still green — no regressions.

Run:
```
bunx vitest run --config vitest.opt.config.ts __tests__/opt/07-security-w2.test.ts
```

## Changes

| ID | File:line | Change | Test |
|----|-----------|--------|------|
| 623 | src/auth/gpu-token.ts:51-56 | `verifyGpuToken` now wraps the payload `JSON.parse` in try/catch and throws the intended `Invalid token payload` instead of leaking a raw `SyntaxError` when the (signed) base64url decodes to non-JSON. Also rejects signed-but-primitive payloads (`5`, `null`, `"x"`). | `#623/#624 GPU token robustness` (non-JSON, primitive payloads) |
| 624 | src/auth/gpu-token.ts:9-18,74-77 | Added a 5s `CLOCK_SKEW_SECONDS` grace on the `exp` check so a pod whose clock runs a few seconds ahead of the issuer doesn't reject a token still within its 60s TTL. Tokens well past the window still rejected. | `#624 tolerates ... skew`, `still rejects ... well past the skew window` |
| 646 | src/vault/vault.ts:82-95 | `Vault.retrieve` guards the blob `JSON.parse`; a truncated/corrupt entry now throws a distinct `Secret "<name>" is corrupt (invalid JSON blob)` rather than a raw `SyntaxError` indistinguishable from a wrong-key GCM auth failure. | `#646 vault corrupt-blob error` |
| 644 | src/vault/file-store.ts:60-65 | `FileVaultStore.save()` serializes the live `this.cache` directly instead of routing through `this.load()`, so a future change to `load` (e.g. re-reading disk) can't silently persist stale data over fresh mutations. | `#644 persists the live cache` (on-disk JSON matches set/delete sequence) |
| 645 | src/vault/file-store.ts:1,46-55 | `save()` now `chmodSync(dir, 0o700)` when the vault dir already exists (best-effort, ignores failure). `mkdirSync(...0o700)` only applies on creation; a pre-existing world-readable dir previously left the encrypted vault exposed. | `#645 re-asserts 0o700 on a pre-existing world-readable vault dir` |
| 679 | src/gateway/guardrails/types.ts:110-130 ; engine.ts:6,78-82,118-137,174-247 | Added opt-in `failClosed` to `GuardrailEngineConfig`. Default unchanged (fail-OPEN: a throwing rule is logged + skipped). When `failClosed: true` **and** `action: 'block'`, a rule that *throws* is treated as a block (`pass:false`) — "couldn't evaluate" denies. Threaded through all 4 `runRules` call sites; has no effect under `audit`. | `#679 guardrail fail-closed` (throwing rule fails open by default, closed when flagged; normal verdicts unaffected) |
| 669 | src/input-validator/index.ts:26-58 | `validateInput` gains an optional `{ exposeDetails }` (and `VALIDATOR_HIDE_DETAILS=1` env). When off, `details` collapses to a single `['Invalid request body']` instead of echoing Zod issue paths (schema fingerprinting). Default behavior (echo paths) unchanged. | `#669 validateInput detail suppression` (default echoes; option + env suppress) |
| 668 | src/input-validator/index.ts:141-165 | Added `Schemas.ConstrainedFilter(allowedKeys)` — a `.strict()` Zod object that rejects unknown keys (closes the mass-assignment gap in the open `Schemas.Filter` record, incl. literal `__proto__` keys in a JSON body). Legacy open `Filter` left untouched for back-compat. | `#668 ConstrainedFilter` (rejects unknown/proto keys; open Filter unchanged) |
| 692 | src/middleware/per-key-rate-limit.ts:65-90 | `parseKeyQuotas` now skips entries with an empty key (`:100` → quota for `""`, matched by unauth/empty-key callers) and rejects non-finite / non-positive `maxRequests` (a `key:0` typo previously built a bucket that blocks **every** request — a silent self-DoS). | `#692 parseKeyQuotas hardening` (empty/0/neg/NaN skipped; zero-quota key falls back to wildcard, first request allowed) |
| 696 | src/middleware/per-key-rate-limit.ts:27,138-145 | Rate-limit-exceeded log line now masks the key via the shared `maskApiKey` (short keys → `***`) instead of a hand-rolled 4-char prefix, standardizing the masking policy across the codebase. | covered indirectly (limiter behavior tests; masking is log-only) |
| 612 | src/auth-middleware/index.ts:98-110 | `requireAuth` emits a loud `console.warn('[auth] DEV BYPASS ACTIVE ...')` whenever the dev bypass activates, so an image accidentally shipped with `NODE_ENV=development` + `allowDevBypass` can't skip auth silently. | covered indirectly (module compiles/imports in suite) |
| 673/675 | src/middleware/sanitization.ts:71-99 | Added `stripControlChars(input, { keepNewlines?, maxLength? })` — removes control chars (and CR/LF by default) from user-influenced values bound for downstream services / headers / logs (header- and log-injection defense). Reusable primitive; wiring deferred. | `#673/#675 stripControlChars` |
| 671 | src/middleware/sanitization.ts:101-127 | Added `sanitizeFilename(input, maxLength=255)` — drops directory components (`../`, `/`, `\`), strips control chars/separators, collapses empty/dot-only names to `file`, caps length. Reusable primitive; wiring deferred. | `#671 sanitizeFilename` (traversal, control chars, dot-only/empty, length) |
| (regex ReDoS) | src/gateway/guardrails/rules/regex-match.ts:3-23 | `runRegexMatch` caps the text it tests an operator-supplied pattern against to 100k chars (`MAX_REGEX_INPUT_CHARS`), bounding any single catastrophic-backtracking match so a huge request body can't stall the event loop. Related to audit #683 (ReDoS) on the rule surface. | `regex-match rule input bound (ReDoS mitigation)` (returns fast on `(a+)+$` vs 500k input) |
| (proto-read) | src/null-safety/index.ts:24-46 | `safeGet` returns the default for path segments `__proto__` / `prototype` / `constructor` instead of walking into the prototype chain — prevents a user-controlled `path`/`field` from reading engine internals (read half of a prototype-pollution probe). | `safeGet prototype-key guard` |

## Notes on scope decisions

- **DLP/guardrail keyword logic (#680, #681 Luhn, #683 ReDoS-in-DLP, #685
  Zod-validate config):** the real implementations live in
  `src/gateway/providers/cloud/dlp.ts` / `cloud/guardrails.ts`. Only the
  re-export shims `src/providers/dlp.ts` / `src/providers/guardrails.ts` are in
  the owned set, so the cloud DLP/guardrail bodies were **not** edited. The
  regex-rule ReDoS bound above lands in the in-scope `src/gateway/guardrails/`
  rule engine instead.
- All new APIs are **additive and default to prior behavior** (`failClosed`
  defaults off, `exposeDetails` defaults on, `ConstrainedFilter` is a new
  export, sanitizer primitives are new functions). No existing call site changes
  semantics.

## Deferred (and why)

**Wiring dead middleware into the live request path — out of scope (behavior-changing).**
Same as wave 1: #601 per-route RBAC, #611 `requireAuth`/`requireRole`,
#686/#688/#693 per-key/cost-weighted limiting on HTTP + speech endpoints,
#676/#677/#678 enable/wire DLP + guardrails, #639 shared WS limiter, #630
register `handleRecallWebhook`, #689 spend-based circuit. These require editing
`server/ws-server.ts` / `server/ws/http-api-server.ts` (not owned) and change
runtime behavior; need server-owner coordination. The new `stripControlChars` /
`sanitizeFilename` / `ConstrainedFilter` / `failClosed` / `exposeDetails`
primitives are the building blocks those wiring passes can adopt.

**GPU-token wire-format changes — compatibility risk.** #620 (`kid`), #621
(`aud` endpoint binding), #622 (`jti` replay), #619 (`GPU_ACCESS_SECRET_PREVIOUS`
rotation): all change the signed payload / verification contract shared with the
GPU pod image; one-sided changes break auth. #623/#624 here are
backward-compatible (parse-robustness + a 5s read-side grace) and need no pod
change.

**Vault rotation / crypto-contract re-architecture — too large / stateful.**
#640 (KDF for passphrases), #641 (AAD bound to ciphertext — would make existing
blobs undecryptable without migration), #642 (decrypt-by-version), #643 (atomic
rotation snapshot), #650 (access audit log), #647 (key zeroization): each is M+
effort touching `EncryptedBlob` / the store contract; out of "localized S/M"
scope.

**`src/modules/` drift consolidation (#614/#615/#627/#658).** Collapsing the
`src/modules/` mirror or `src/index.ts` re-exports touches files outside the
owned set (and `src/index.ts` is forbidden).

**#649 maskApiKey threshold (cap revealed to ≤25%).** Skipped deliberately: the
wave-1 test pins `maskApiKey('sk-1234567890abcdef') === 'sk-1***cdef'`; tightening
the algorithm would break that asserted contract. Left as-is to avoid a wave-1
regression; revisit alongside a coordinated masking-policy change.

**Not owned (other domain files referenced by the audit):** `server/ws/*`,
`server/recall-handlers.ts` (#628-638 ingress auth, #673 botName at the call
site, #675 errorMsg broadcast), `src/contracts/index.ts` (#662-665, #674 schema
caps, #633 passthrough), `src/gateway/proxy/*` (#608-610, #671 multipart at the
call site, #690-691 concurrency/IP buckets), `src/gateway/pipeline/ssrf-protection.ts`
(#653-660 — **imported** by the webhook rule in wave 1, not edited),
`src/gateway/providers/cloud/*` (#676-685 DLP/guardrail bodies), `src/alerting/*`
(#661). Skipped per ownership.
