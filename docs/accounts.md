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
- May wake (`POST /v1/deployments/:name/wake`) only the deployments in `ACCOUNTS_WAKE_DEPLOYMENTS` (comma-separated,
  default `babelcast-tts-clone`): the app keeps the voice-clone GPU up while subtitles run with "Clonar a voz" on. Park,
  start and every other deployment stay admin-only.
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

Quota (`ACCOUNT_QUOTA_*`): monthly audio minutes, LLM tokens, TTS characters, rooms (0 = unlimited, the default) →
**402** `quota_exceeded` (`metric`, `limit`, `used`, `reset_at`, message in Portuguese). Per account, so one account
cannot spend the others' share of the app (all activation keys are the same app): a daily request budget
(`ACCOUNT_QUOTA_REQUESTS_DAY`, default **0 = off** since 2026-10-15 — live subtitles cost ~40 requests a minute, so the old 2000 stopped a talk after ~50 min; when set, a realtime session counts its whole app charge, `perMinute × ⌈ttl/60⌉` = 40
by default, a `/v1/s2s` turn 1) → **429** `daily_quota_exceeded` + `scope: "account"` + `Retry-After`; and requests in
flight (`ACCOUNT_QUOTA_CONCURRENT`, default 20) → **429** `account_concurrency_exceeded` + `Retry-After: 1`. `0` turns
either off. The app's own daily budget (`APP_DAILY_*`, 429 `daily_budget_exhausted`) and in-flight limit
(`MAX_CONCURRENT_PER_USER`) still cap the sum of all accounts. Admission is on usage so far: the request that crosses a
monthly limit is served.
Per-user overrides live in `users[].quota` (plans, later).

## Pages

On `ACCOUNTS_SITE_HOSTS` (default `ucast.me, www.ucast.me, app.ucast.me`): `/`, `/signup`, `/login`, `/forgot`,
`/reset`, `/verify`, `/desktop`, `/account`. On any host: `/account`, `/account/signup|login|forgot|reset|verify|desktop`.
Self-contained HTML (pt/en/fr) under a nonce CSP (`connect-src 'self'`, `frame-ancestors 'none'`).

### Desktop handoff (`/account/desktop`)

The ucast.me app’s “Entrar na conta” opens `/account/desktop?port=&state=&device=`. If the person is not signed in,
the page sends them to `/login?next=/account/desktop?…`. Once signed in (and e-mail verified), it creates an activation
key for `device` and redirects to `http://127.0.0.1:<port>/?key=…&state=…`. The app listens on that loopback port
(same idea as the YouTube OAuth return) and stores the key in the system vault. Pasting a key by hand stays as an
advanced option in the app.

## State

`<DEPLOYMENTS_STATE_DIR or ACCOUNTS_DIR>/accounts.json` (users with argon2id hashes, session/key/reset-token hashes) and
`account-usage.json`, written with the state-file helper (atomic + `.bak`). Unreadable with no backup → accounts
disabled at boot (nothing overwritten), the rest of the gateway runs. Back the volume up before deploying.

## E-mail

`RESEND_API_KEY` + `EMAIL_FROM` → Resend. Without them nothing is sent; `ACCOUNTS_LOG_EMAIL_LINKS=1` writes the
message (with the link) to the log — local development only.

## Coupons

A coupon gives a paid plan for a few months with no card and no Stripe subscription. The person signs up on the free
plan, types the code on the account page (`/account?code=UCAST-XXXX-XXXX` fills the field) and the plan becomes
`user.grant` = `{ plan, endsAt, code }`. The effective plan is the higher of the Stripe plan and the active grant, so a
real subscription is never lowered; when `endsAt` passes the account is back on its own plan with nothing to cancel.

- `POST /v1/account/coupon/redeem` `{ code }` (session + CSRF, 20 attempts per IP per hour): one code per account;
  errors `invalid_coupon` (404), `coupon_expired` (410), `coupon_used` (409), `coupon_already_redeemed` (409).
  The answer is `/me` with the new `quota.grantEndsAt` and `quota.viaCoupon`.
- `POST /v1/admin/coupons` (admin key) `{ plan = "pro", months = 3, count = 1, maxUses = 1, expiresAt?, note? }` →
  `{ coupons: [{ code, … }] }`; `GET /v1/admin/coupons` lists them with `uses`. Codes look like `UCAST-K7Q2-XM4P` and are
  compared ignoring case, spaces and dashes. `maxUses > 1` makes a shared code (a class); `expiresAt` is the last day
  the code can be redeemed, not the end of the plan.
- State: `coupons` in `accounts.json` (`usedBy` holds the account ids). Quotas follow the effective plan only when
  billing is configured, like the plan limits.
