# ucast.me accounts

People sign up on **ucast.me** with e-mail + password and create **activation keys** for the ucast.me desktop app.
Code: `src/accounts/`. Tests: `__tests__/unit/accounts/`.

## What an activation key is

`ucast_live_<43 base64url chars>` — a normal gateway key of the accounts app (`ACCOUNTS_APP`, default `babelcast`):

- `keyRegistry.resolve(key)` → `{ userId: 'babelcast' }`, so the key reaches exactly what that app's keys reach: its
  model aliases (`PUT /v1/apps/babelcast/routes`), its daily budget (`APP_DAILY_*` / `PUT /v1/apps/babelcast/limits` —
  **shared by every account**), rooms, telemetry, devices.
- Never admin. If `ACCOUNTS_APP` is ever in the admin list, activation keys are refused (fail closed) and the boot log
  says so.
- Stored as `HMAC-SHA256(ACCOUNTS_HASH_PEPPER, key)` only; the full key is shown once, at creation.
- On top of the app limits, each request is metered per user and per key and admitted against the user's quota.

## HTTP

All JSON. Errors: `{ "error": { "message": "<pt-BR>", "type", "code", … } }`. No CORS on these routes.

| Route | Auth | Notes |
|---|---|---|
| `POST /v1/account/signup` `{email, password}` | — | 201 + session cookie. Password ≥ 8 chars. Registered e-mail: login if the password matches, else the generic `signup_refused` (owner warned by e-mail). |
| `POST /v1/account/login` `{email, password}` | — | 200 + cookie, or 401 `invalid_credentials` (same for unknown e-mail and wrong password). |
| `POST /v1/account/logout` | cookie | Clears the session. |
| `POST /v1/account/password/forgot` `{email}` | — | Always `200 {ok:true}`; e-mail only when the account exists. Link: `<ACCOUNTS_PUBLIC_BASE_URL>/reset#token=…` (fragment: never in logs/Referer). |
| `POST /v1/account/password/reset` `{token, password}` | — | One-time token, `ACCOUNTS_RESET_MINUTES` (60). Ends every session of the account. |
| `GET /v1/account/me` | cookie or key | `{email, plan, createdAt, downloadUrl, quota, csrfToken?}` (`csrfToken` only with the cookie). |
| `GET /v1/account/usage?days=30` | cookie or key | `{quota, days:[{day, requests, sttRequests, audioSeconds, llmRequests, llmTokens, ttsRequests, ttsChars, ttsSeconds, rooms}], byKey:[…]}` |
| `GET /v1/account/keys` | cookie | Key views (prefix, device, created/last used/activated, app version, revoked). |
| `POST /v1/account/keys` `{deviceName}` | cookie + CSRF | 201 `{key, …view}` — the only time the full key is returned. Max `ACCOUNTS_MAX_KEYS_PER_USER` active. |
| `DELETE /v1/account/keys/:id` (or `POST …/:id/revoke`) | cookie + CSRF | Revoked at once everywhere. |
| `POST /v1/activate` `{key, deviceName, appVersion}` | key in body | `{ok, email, plan, quota:{limits, month, monthResetsAt}}` or 401 `invalid_key`. |

Cookie: `__Host-ucast_sid` — `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days (`ACCOUNTS_SESSION_DAYS`).
Cookie-authenticated writes need `X-CSRF-Token` (from `/me`) and a same-origin request (`Origin` / `Sec-Fetch-Site`);
the unauthenticated forms need the same-origin check and a JSON body.

Attempt limits (per gateway instance, `TRUST_PROXY=1` so the IP is the caller's): login 10/15 min per e-mail and
50/15 min per IP, sign-up 10/h per IP, reset e-mails 3/h per address (silently) and 20/h per IP, activation 30/10 min
per IP → 429 `too_many_attempts` + `Retry-After`.

## Metering and quota

Metered when the bearer is an activation key: `POST /v1/chat/completions` (LLM tokens — provider `usage.total_tokens`,
else prompt chars/4), `/v1/audio/transcriptions` (audio seconds — WAV header, else bytes/16 000), `/v1/audio/speech`
(input characters, WAV seconds), `/v1/rooms` (rooms created), `/v1/s2s` and `/v1/realtime/sessions` (requests).
Only successful requests count. Counters per UTC day × user × key in `account-usage.json` (debounced atomic writes,
`ACCOUNTS_USAGE_RETENTION_DAYS`, default 400).

Quota (`ACCOUNT_QUOTA_*`, 0 = unlimited — the default): monthly audio minutes, LLM tokens, TTS characters, rooms →
**402** `quota_exceeded` (`metric`, `limit`, `used`, `reset_at`, message in Portuguese); daily request cap → **429**
`daily_quota_exceeded` + `Retry-After`. Admission is on usage so far: the request that crosses a limit is served.
Per-user overrides live in `users[].quota` (plans, later).

## Pages

On `ACCOUNTS_SITE_HOSTS` (default `ucast.me, www.ucast.me, app.ucast.me`): `/`, `/signup`, `/login`, `/forgot`,
`/reset`, `/account`. On any host: `/account`, `/account/signup|login|forgot|reset`. Self-contained pt-BR HTML under a
nonce CSP (`connect-src 'self'`, `frame-ancestors 'none'`).

## State

`<DEPLOYMENTS_STATE_DIR or ACCOUNTS_DIR>/accounts.json` (users with argon2id hashes, session/key/reset-token hashes) and
`account-usage.json`, written with the state-file helper (atomic + `.bak`). Unreadable with no backup → accounts
disabled at boot (nothing overwritten), the rest of the gateway runs. Back the volume up before deploying.

## E-mail

`RESEND_API_KEY` + `EMAIL_FROM` → Resend. Without them nothing is sent; `ACCOUNTS_LOG_EMAIL_LINKS=1` writes the
message (with the link) to the log — local development only.
