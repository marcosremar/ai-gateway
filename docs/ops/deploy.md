# Deploy Runbook — `parle-ai-gateway`

> **Audience**: anyone pushing a new version of the gateway service to
> Fly.io. Library-only releases (npm publish) have a separate flow in
> `CHANGELOG.md → Release process`.
>
> **Authoritative target**: `parle-ai-gateway.fly.dev`, Fly.io app
> `parle-ai-gateway` in region `cdg`, config in `fly.toml`.

---

## Pre-flight checklist

Never skip these. The 90 seconds you save will cost hours if any fail in prod.

- [ ] `git status` is clean (no uncommitted changes).
- [ ] `main` branch is what you intend to deploy — `git log -1 --oneline`.
- [ ] Local `bunx tsc --noEmit` is clean.
- [ ] Local `bun run test:unit` passes.
- [ ] `bun.lock` is committed and current (`bun install --frozen-lockfile` is silent).
- [ ] Relevant secrets exist on the target app:
      `flyctl secrets list --app parle-ai-gateway` includes at minimum
      `GROQ_API_KEY`, `GATEWAY_API_KEYS`, `FAL_KEY`.
- [ ] CI on GitHub for the commit you're about to deploy is **green**.

If any item is red, stop. Fix it first. A broken deploy is cheaper than a
broken rollback.

---

## Deploy

```bash
# 1. From repo root, push the image and trigger Fly machine rolling update.
flyctl deploy --remote-only --app parle-ai-gateway

# 2. Watch the rollout. Status prints every ~5 seconds.
#    Expect to see "Machine <id> is now in a good state" within ~90s.
#    If health check fails twice, Fly.io auto-rolls back.
```

**Expected output tail:**
```
✔ Machine <hex> is now in a good state
> Clearing lease for <hex>
✔ Cleared lease for <hex>
Checking DNS configuration for parle-ai-gateway.fly.dev
✓ DNS configuration verified
```

If you see `Health check failed` or `deployment failed`, stop and jump to
`docs/ops/rollback.md`.

---

## Post-deploy smoke checks

Run all four — takes ~20 seconds. Any failure → rollback.

```bash
KEY="$(flyctl ssh console --app parle-ai-gateway -C 'printenv GATEWAY_API_KEYS' 2>/dev/null | tail -1)"
BASE="https://parle-ai-gateway.fly.dev"

# 1. Health — must return {"status":"ok"}
curl -sf "$BASE/health" | grep -q '"status":"ok"' && echo "health OK"

# 2. Chat — must return 200 with content
curl -sf -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  | grep -q '"content"' && echo "chat OK"

# 3. TTS — must return ≥1KB of audio
SIZE=$(curl -sf -X POST "$BASE/v1/audio/speech" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"canopylabs/orpheus-v1-english","input":"ok","voice":"autumn"}' \
  -o /tmp/tts.wav -w '%{size_download}')
[ "$SIZE" -gt 1000 ] && echo "tts OK ($SIZE bytes)"

# 4. Auth rejection — wrong key must return 401
curl -sf -o /dev/null -w '%{http_code}' "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer wrong" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"hi"}]}' \
  | grep -q '401' && echo "auth OK"
```

All four must print OK. If any fail, rollback before investigating — you
can replay the same test against the old revision to confirm the regression.

---

## What to deploy when

| Trigger | Deploy? |
|---|---|
| Hotfix for a bug that breaks an SLO | yes, immediately |
| New feature behind a flag | yes, during business hours |
| New feature user-visible | yes, during business hours + announce in `#launches` |
| Dependency upgrade | yes, with extra smoke-check attention |
| Code style / refactor | batch into weekly deploys |
| Docs-only change | never needs a service deploy (GitHub Pages handles docs) |

---

## Common failures

**"Name has already been taken"** — you're creating an app. We already have one. Use `flyctl deploy`, not `flyctl launch`.

**Health check timeout, no obvious cause** — usually a missing secret. Run
`flyctl secrets list --app parle-ai-gateway` and compare against `serve.ts`
expected env vars. `GROQ_API_KEY` and `GATEWAY_API_KEYS` are the two most
commonly forgotten.

**Build succeeds, deploy times out mid-rollout** — Fly health check grace
period is 15s. If first-request latency exceeds that (usually pino cold
start), bump `grace_period` in `fly.toml`.

**Smoke check 4 (auth) returns 500 instead of 401** — a middleware threw
before auth ran. Check Fly logs: `flyctl logs --app parle-ai-gateway`.

---

## Who to notify

- Before deploy: drop a message in `#gateway-deploys` with the git SHA.
- After successful deploy: thumbs-up reaction.
- After failed deploy or rollback: drop a message with what broke.
