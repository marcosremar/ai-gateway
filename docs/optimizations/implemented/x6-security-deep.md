# x6 — Security Deep (cross-ownership harvest)

Cluster: `src/gateway/pipeline/ssrf-protection.ts`, `src/gateway/providers/cloud/dlp.ts`,
`src/gateway/providers/cloud/guardrails.ts`, `src/contracts/`.

These are the **cluster-file siblings** of audit items from `docs/optimizations/07-security-auth.md`
whose `Location` points into this cluster but were implemented out-of-cluster by domain-7 agents
(in `src/input-validator/`, `src/gateway/guardrails/`), leaving the named files themselves
without the documented protection. All changes are **defensive only** and either **additive** or
**opt-in**, so every existing back-compat test in these files still passes. No wire-format or
live-server wiring was changed (deferred as out-of-scope).

Test: `__tests__/opt/x6-security-deep.test.ts` (35 tests, unit-only, DNS mocked, fetch never called).

## Implemented

| ID | File | Change | Back-compat note |
|----|------|--------|------------------|
| #657 | ssrf-protection.ts | Positive http(s)-only scheme allowlist: `ALLOWED_URL_SCHEMES`, `isAllowedScheme()`; wired into `isPrivateUrl`, `isPrivateUrlResolved`, `validateEndpointUrl`. Previously only `file:` was blocked — `ftp://`/`gopher://`/`data:` to a *public* host passed (`isPrivateUrl('ftp://internal/secret')===false`). | Strengthen-only; `file:` was already blocked. |
| #659 | ssrf-protection.ts | New `validateEndpointUrlResolvedStrict()` fails **closed** on DNS lookup error / empty record set (vs. existing fail-open `validateEndpointUrlResolved`). | Existing fail-open variant unchanged. |
| #655 | ssrf-protection.ts | Strict variant also resolves **dot-less** single-label hosts (`etcd`), closing the search-domain→private bypass; `shouldSkipDnsResolution(host, resolveDotless)`. | Non-strict path still skips dot-less hosts. |
| #652 | contracts/index.ts | `isSsrfSafeUrl()` + `SsrfSafeUrlSchema` (pure, sync, dependency-free host check); applied to `BotJoinRequestSchema.meetingUrl` and `RecallJoinRequestSchema.meetingUrl`. Rejects private/metadata/loopback/decimal-IP/non-http targets. | Public meeting URLs (the only valid ones) still parse. |
| #674 | contracts/index.ts | `AvatarSpeakRequestSchema.audio` bounded by `MAX_AVATAR_AUDIO_CHARS` (12M chars ≈ 9 MB decoded). | Field still optional; generous cap. |
| #681 | dlp.ts | `luhnCheck()` + opt-in `DLPOptions.luhnValidate` to gate credit-card matches behind a mod-10 checksum. | Opt-in (default off) — existing `minMatches` test with non-Luhn cards unaffected. |
| #682 | dlp.ts | `redactPII()` — masks detected PII in place (right-to-left, offset-safe) so a request can proceed instead of being hard-blocked. | New function; nothing changed in `detectPII`. |
| #685 | dlp.ts | `DLPConfigSchema` + `validateDLPConfig()` + `coerceDLPAction()` — Zod validation of operator config; unknown/typo action → safe fallback. | Pure validator; opt-in. |
| #680 | guardrails.ts | `normalizeForMatching()` (leetspeak map + separator strip) + opt-in `GuardrailOptions.deobfuscate` extra matching pass catching `k i l l` / `h4te`. | Opt-in (default off) — plain-text confidence math byte-identical; existing tests asserting `confidence===20` unaffected. |
| #685 (sibling) | guardrails.ts | `GuardrailConfigSchema` + `validateGuardrailConfig()` + `coerceGuardrailAction()`. | Pure validator; opt-in. |

## Verification

- `bunx vitest run --config vitest.opt.config.ts __tests__/opt/x6-security-deep.test.ts` → **35 passed**.
- Back-compat (run via throwaway config to avoid the base-config `.env` setup hang):
  `__tests__/unit/bug-dlp-minmatches-counts-types.test.ts` + `__tests__/providers-guardrails.test.ts` → **18 passed**.
- Dependent opt suites importing the cluster files
  (`07-security`, `01-core-pipeline-w4/w5`, `09-cli-sdk`) → **117 passed**.

## Deferred (out of scope / out of cluster)

| ID | Reason |
|----|--------|
| #653, #654 | TOCTOU / DNS-rebinding hardening of the *call sites* (pin resolved IP, custom agent `lookup`) is behavioral wiring across fetch paths — out of cluster, deferred. The strict resolved validator (#655/#659) is the localized prerequisite. |
| #656 | IPv6 allowlist-posture (public-only) is a larger policy change to `isBlockedIpv6` with broad blast radius; deferred to avoid blocking legitimate IPv6. |
| #658 | `src/modules/` SSRF duplicate — `src/modules/**` is explicitly off-limits for this cluster. |
| #660, #661 | `src/gateway/proxy/server.ts`, `src/alerting/channels/webhook.ts` — outside cluster. |
| #672 | Content-Type 415 on chat path — `src/gateway/proxy/server.ts`, outside cluster. |
| #676 | Wiring `detectPII` into the live chat pipeline — behavioral wiring, deferred. |
| #677, #678 | Secure-default `enabled:true` / `/health` surfacing — changing defaults is a behavioral/UX change with deployment impact; deferred (kept opt-in). |
| #683 | Replacing the ReDoS heuristic with a re2/worker timeout engine — needs a new dependency / worker; deferred (existing heuristic + iter/length caps retained). |
| #662–#665, #667–#671, #673, #679, #684 | Already covered by prior waves (`__tests__/opt/*` cite these IDs); chat bounds (#662–#664) were already implemented in `src/contracts/index.ts`. |
