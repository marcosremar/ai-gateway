# 07 — Security, Auth & Input Validation — Wave 3 (implemented)

Continuation of waves 1–2 (`07-security.test.ts`, `07-security-w2.test.ts`).
All items are **localized primitives** — no previously-dead middleware
(RBAC / CSRF / rate-limiter / DLP) was wired into the live server path, and no
GPU-token wire format or vault on-disk blob format was changed (both deferred
as migration risk). Tests: `__tests__/opt/07-security-w3.test.ts` (42 tests,
all passing, unit-only, no network).

## Implemented

| ID / area | Item | File(s) | What changed |
|-----------|------|---------|--------------|
| #640 | Vault passphrase KDF (opt-in) | `src/vault/vault.ts` | Added pure `deriveVaultKeyFromPassphrase(passphrase, salt)` (scrypt N=16384,r=8,p=1 → 64-hex key). The `Vault` ctor still requires a raw 32-byte key; this is the explicit opt-in path so operators can key from a passphrase without the ctor silently hashing a typo. No blob-format change. |
| #643 | `rotateKey` atomic rollback | `src/vault/vault.ts` | Snapshot every original serialized blob up front; on any mid-rotation failure, restore the captured **original bytes verbatim** (no decrypt/re-encrypt) and leave `this.key` untouched. Closes the "rollback itself throws → mixed-version, undecryptable" gap. |
| #647 | Scrub master key from env | `src/vault/vault-singleton.ts` | Added `clearVaultMasterKeyFromEnv()` — deletes `VAULT_MASTER_KEY` from `process.env` **only after** the vault is initialized (no-op + returns false otherwise, so a later lazy init isn't broken). Shrinks the `/proc/self/environ` / child-process exposure window. |
| #625 | GPU token uid non-confidential | `src/auth/gpu-token.ts` | Added `readGpuTokenClaimsUnverified(token)` for logging/diagnostics — decodes claims **without** authenticating, with a doc note that `uid` is plaintext (callers must not put PII in `userId`). Wire format unchanged. |
| #649 | `maskApiKey` reveal cap | `src/middleware/sanitization.ts` | Now caps total revealed chars to ≤25% of key length (`each = min(4, floor(len*0.25/2))`) instead of a flat 8-char reveal. Keys <12 still collapse to `***`. |
| #666 / #680 | Obfuscation-resistant injection detection | `src/middleware/sanitization.ts` | Added `normalizeForKeywordMatch()` (lowercase → leetspeak→letters → strip non-letters) and a second pass in `detectInjection()` over a short high-signal phrase allowlist (`ignorepreviousinstructions`, `developermode`, …). Catches `i g n o r e`, `1gn0r3`, `d3v3l0p3r m0d3`. Documented best-effort. |
| #681 | Luhn check primitive | `src/input-validator/index.ts` | Added `luhnCheck(candidate)` (mod-10, ignores spaces/dashes). Standalone primitive to gate DLP card-regex matches and cut false positives on order ids/timestamps. |
| #665 | Model allowlist primitive | `src/input-validator/index.ts` | Added `isAllowedModel(model, allowlist)` — exact match, **fail-closed** (empty model or empty allowlist → false). |
| #684-sym | `extractRequestText` size bound | `src/gateway/guardrails/engine.ts` | Symmetric to the existing response-side bound: caps concatenated request text at 1M chars (per-message accumulation + final slice) so a 10k-message / giant-message body can't drive guardrail CPU. |
| — | json-schema rule input bound | `src/gateway/guardrails/rules/json-schema.ts` | Oversized text (>1M chars) short-circuits to the not-valid-JSON branch instead of `JSON.parse`-ing a multi-MB body (CPU amplification). |
| — | contains-code rule input bound | `src/gateway/guardrails/rules/contains-code.ts` | Heuristic regexes now run against `text.slice(0, 100_000)` (ReDoS / event-loop-stall mitigation). |
| #685 | Guardrail engine config Zod validation | `src/gateway/guardrails/config-validation.ts` (new), `index.ts` | Added `validateGuardrailEngineConfig()` + schemas. A bad `action` (e.g. `"allow"`) or an unknown rule `type` / empty `hooks` now **fails loud** instead of silently degrading to allow / never-runs. Pure validator; not auto-wired. |
| — | CSRF token length guard | `src/middleware/csrf.ts` | `verifyCsrfToken` rejects tokens >1024 chars before the Buffer alloc + constant-time compare (unauthenticated DoS amplifier). |
| — | ws-rate-limit `getStatus` clamp | `src/middleware/ws-rate-limit.ts` | `windowMs` in the status is clamped to `max(0, …)` — the strict `>` rollover check could momentarily yield a negative window, corrupting caller backoff math. (Same bug class already fixed in per-key limiter.) |
| — | `safeJsonParse` / `safeParseInt` hardening | `src/null-safety/index.ts` | `safeJsonParse(value, { maxLength })` short-circuits oversized input before parse; `safeParseInt(value, radix, { strict })` requires the whole string be a valid integer (rejects `'12px'`, `0x` prefixes). Both default to existing behavior. |
| — | model-whitelist empty-model fix | `src/gateway/guardrails/rules/model-whitelist.ts` | An absent/empty model can no longer satisfy allowlist mode even if `""` is accidentally in `rule.models` (prevents unidentified requests slipping through). |

## Deferred (intentionally out of scope this wave)

| ID | Item | Why deferred |
|----|------|--------------|
| #618, #630, #639, #666, #676, #686–#696 | Wire dead middleware/handlers (GPU-token verify, Recall webhook, WS rate limiter, per-key limiter, DLP) into the live server path | Task constraint: keep primitives correct + tested; **do not** wire dead middleware into the live server. Recorded as deferred. |
| #619, #620, #621, #622 | GPU-token rotation `kid` / `aud` / `jti` / `GPU_ACCESS_SECRET_PREVIOUS` | Change the signed token **wire format** → migration risk. Deferred. |
| #641, #642 | Vault AAD binding / version-keyed decrypt | Change the on-disk **blob format** → migration risk. Deferred. |
| #650 | Vault secret-access audit log | Needs an event-bus/sink decision (cross-module wiring); not a self-contained primitive. |
| #652–#661 | SSRF hardening (DNS-rebinding, IPv6 allowlist, scheme allowlist, fail-closed on lookup error) | Lives in `src/gateway/pipeline/ssrf-protection.ts` — **outside the ownership scope** for this wave. |
| #662–#664, #672, #674 | Zod bounds on `ChatMessageSchema` / `messages` / `max_tokens` / content-type / avatar audio | Live in `src/contracts/index.ts` and `src/gateway/proxy/server.ts` — **outside ownership scope**. |
| #677, #678, #681 (in-place), #682, #683 | DLP defaults / redaction mode / Luhn-in-DLP / ReDoS-safe custom-pattern engine | The real DLP/guardrail-cloud logic is in `src/gateway/providers/cloud/dlp.ts` (re-exported by `src/providers/dlp.ts`) — **outside ownership scope**. A standalone `luhnCheck` primitive was added in `src/input-validator` instead. |
| #697, #700 | CORS local-origin regex / 404 endpoint enumeration | Live in `server/ws/http-api-server.ts` — **outside ownership scope**. |
| #698 | CSP `'unsafe-inline'` styles → nonce/hash | Requires coordinated admin-UI template changes (nonce plumbing) beyond a localized header edit; deferred. |
