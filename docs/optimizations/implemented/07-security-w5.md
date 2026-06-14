# 07 — Security, Auth & Input Validation — Wave 5 (implemented)

Continuation of waves 1–4. Wave 5 is intentionally small: the previous waves
already landed the bulk of the safe, localized primitives in the owned surface
(auth / auth-middleware / vault / input-validator / middleware / null-safety /
guardrails / dlp re-exports / server middleware). What remained in-scope was a
handful of genuinely new, self-contained primitives.

**Invariants preserved (same as prior waves):**
- Primitives ONLY — no previously-dead middleware (RBAC / CSRF / per-key &
  WS rate limiters / DLP engine) was wired into the live server path.
- GPU-token **wire format unchanged** — `signGpuToken` is untouched (no `kid`
  claim, byte-identical tokens); only verification gained the ability to try an
  explicit list of secrets.
- Vault on-disk blob format unchanged.
- All wave 1–4 assertions still pass (159 prior tests green).

## Implemented

| ID | Item | File | What |
|----|------|------|------|
| #620 | Multi-key GPU-token rotation verify | `src/auth/gpu-token.ts` (+ barrel `src/auth/index.ts`) | `verifyGpuTokenWithSecrets(token, secrets[])` — verify a token against an arbitrary list of candidate secrets (constant-time, every candidate evaluated, short/garbage secrets skipped). Wire-compatible generalization of the #619 two-secret overlap to N-key rotations. Refactored the shared claim-decode/expiry logic into `decodeVerifiedPayload` so both verify entrypoints behave identically. |
| #657 | http/https scheme allowlist | `src/input-validator/index.ts` | `isHttpUrl(urlStr)` — pure positive allowlist predicate (only `http:`/`https:`); rejects `file:`/`ftp:`/`gopher:`/`data:` and fails closed on non-strings/unparseable input. Edge-applied; does NOT touch the SSRF module (out of ownership). |
| #674 | Bounded base64 field schema | `src/input-validator/index.ts` (`Schemas.BoundedBase64`) | Zod schema that validates the base64 charset (standard + URL-safe, optional padding) AND caps the **decoded byte size** (not raw char count). Closes the per-field amplification on unbounded `audio`/base64 blobs. Rejects (does not truncate) over-limit input. |
| #682 | DLP redaction mode | `src/input-validator/index.ts` | `redactPII(text, { placeholder })` — masks email / US-SSN / **Luhn-gated** credit-card spans in place so a request can PROCEED without leaking PII, returning `{ redacted, found, types }`. Dependency-free, stateless (resets regex `lastIndex` per call). The block-only DLP engine had no redaction path. |
| #677 | Secure-default DLP config | `src/providers/dlp.ts` (owned re-export) | `secureDefaultDlpConfig(opts?)` — returns an `enabled: true`, `action: 'block'` config with the high-confidence detectors (card/SSN/email) on and the noisy ones (phone/IP/DOB) off. Opt-out baseline vs the library `DEFAULT_DLP_CONFIG` (`enabled:false`/`action:'flag'`). Does not mutate the default; not wired anywhere. |
| #605 | Single-shared-key advisory predicate | `src/auth-middleware/index.ts` | `isSingleSharedKeyMode(validKeys)` — pure predicate (true only for a 1-element `Set`; false for multi-key, empty set, or an opaque function validator) so a startup self-check / `/health` can flag the "all callers share one identity" state. No wiring. |

**Tests:** `__tests__/opt/07-security-w5.test.ts` — 25 unit tests, all passing.
Unit-only; no `fetch`/network is invoked. Run:

```
bunx vitest run --config vitest.opt.config.ts __tests__/opt/07-security-w5.test.ts
```

## Deferred (with reasons)

| ID | Item | Why deferred |
|----|------|--------------|
| #620 (full) | `kid`/version CLAIM in the GPU token | The full design adds a `kid` claim to the signed payload — that **changes the on-the-wire token format**, which the wave constraints forbid. The wire-compatible subset (multi-secret verify) was implemented instead. |
| #621 | GPU-token `aud`/endpoint binding | Requires adding an `aud` claim to the signed payload → **wire-format change**. Deferred for the same reason. |
| #622 | `jti` nonce replay protection | Needs a payload claim (wire change) AND a stateful seen-set on the pod (not a localized primitive). Out of scope. |
| #618, #626 | GPU pod-side verify enforcement / health-degraded signal | Live wiring in `src/handlers/` & `server/` (not owned; wiring, not a primitive). |
| #653, #655, #656, #657-core, #659 | SSRF sync-vs-resolved, single-label DNS, IPv6 allowlist posture, scheme allowlist in the validator, fail-closed on DNS error | All live in `src/gateway/pipeline/ssrf-protection.ts`, which is **outside the strict ownership list**. The `isHttpUrl` primitive (#657) was added in the owned input-validator as the edge-applicable piece; the in-module changes are deferred. |
| #608, #609, #610, #660, #671, #672, #690, #691 | Proxy-server localhost forms, auth-order comment, `onAuth` await, dev-proxy SSRF assert, multipart filename, Content-Type 415, anonymous concurrency bucket, NAT IP bucket | All in `src/gateway/proxy/**` — **outside ownership**. |
| #616, #617, #628–#639 (server) | WS broadcast auth, endpoint masking, Recall webhook register/fail-closed, WS/recall rate caps, query-param token warnings | All in `server/ws-server.ts` / `server/recall-handlers.ts` — **outside ownership** (and several would be wiring, not primitives). |
| #676, #682-engine, #683 | Wire DLP into the live pipeline, in-engine redaction, re2/worker ReDoS engine | `#676` is live wiring; `#683` needs a new linear-time regex engine dependency (not localized, and the cloud `dlp.ts` is outside ownership). The redaction *primitive* (#682) was delivered in the owned input-validator. |
| #686–#695 (wiring) | Wire per-key / global / control-plane / spend-circuit rate limits into the live servers | All require editing `server/ws-server.ts` / `server/ws/http-api-server.ts` / proxy — **outside ownership** and explicitly disallowed (wiring dead middleware). The cost-weighted `check({ cost })` primitive itself was already landed in wave 4. |
| #700, #697 | 404 endpoint-list leak, CORS local-origin regex | `server/ws/http-api-server.ts` & proxy — **outside ownership**. |

## Note on the safe pool

The owned-surface safe-primitive pool is now **effectively exhausted**. Every
remaining `07-security-auth.md` item not yet implemented is one of:
(a) a change to a file **outside the strict ownership list** (predominantly
`src/gateway/pipeline/ssrf-protection.ts`, `src/gateway/proxy/**`,
`server/ws-server.ts`, `server/recall-handlers.ts`, `server/ws/*`, and the cloud
`dlp.ts`/`guardrails.ts` sources); (b) **live wiring** of existing middleware
into the server path (explicitly disallowed); or (c) a **wire-format / blob-format
change** (GPU-token `kid`/`aud`/`jti`, vault versioning). Future waves on this
audit will need either an ownership expansion or an explicit allowance to wire
the already-built primitives.
