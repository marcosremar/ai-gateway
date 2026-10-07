# Rollback Runbook

::: warning Not implemented on `serve.ts`
The production gateway (`serve.ts`) exposes **no** `GET /metrics` endpoint (API audit 2026-10-07). The references to
`/metrics` below describe a planned setup; until it exists use the request logs, `GET /health?details=1` (admin key:
connections, stage chains, STT filter and no-wake counters) and `GET /health?deep=1` (admin).
:::

> **When in doubt, roll back.** Rolling back is never the wrong first move
> during an incident — you can always forward-fix after the fire is out.

---

## When to roll back vs forward-fix

| Situation | Action |
|---|---|
| SEV-1 within 30 min of a deploy | Roll back immediately. |
| SEV-2 within 30 min of a deploy | Roll back immediately. |
| SLO breach >30 min after a deploy | Investigate first — it's probably upstream. |
| Deploy visibly broken in smoke checks | Roll back before any user sees it. |
| Data migration already applied | **Do not roll back**. Forward-fix only. |
| Secret rotation change | **Do not roll back**. Redeploy with corrected secret. |

The red line: **never roll back through a schema change or a secret
rotation**. The old code won't speak the new schema or the new key.

---

## Rollback path A — Fly.io service (most common)

Fly.io keeps every release image. Roll back by redeploying a prior release.

```bash
# 1. List recent releases. Each has a numeric version and a status.
flyctl releases --app parle-ai-gateway | head -10

# 2. Identify the last known-good release (usually N-1 if the current is bad).
#    Sample output:
#    VERSION  STATUS    DESCRIPTION                          USER      DATE
#    v42      failed    Deploy image registry.fly.io/...     marcos    15m ago
#    v41      complete  Deploy image registry.fly.io/...     marcos    2h ago   ← good
#    v40      complete  Deploy image registry.fly.io/...     marcos    1d ago

# 3. Roll back to a specific release.
flyctl releases rollback v41 --app parle-ai-gateway

# 4. Watch the rolling update (same output pattern as a normal deploy).
#    Fly will redeploy v41's image without rebuilding — ~20 seconds typical.
```

Then re-run the smoke checks from `docs/ops/deploy.md`. All four must pass
against the rolled-back version.

---

## Rollback path B — library release (rare)

If a bad `@parle/ai-gateway` package was published to npm and downstream
consumers have pulled it:

```bash
# 1. Deprecate the bad version so future installs get a warning.
npm deprecate '@parle/ai-gateway@0.1.3' 'Contains a critical bug in chat fallback — use 0.1.2 or 0.1.4'

# 2. Publish a fixed version (NEVER unpublish — breaks downstream lockfiles).
#    Create a changeset → version bump → publish as usual.

# 3. Notify all known consumers in `#gateway-consumers` to upgrade.
```

npm does not support "un-publishing" a version older than 72 hours, and
even within 72 hours un-publishing is disruptive. Always forward-fix via
a new version.

---

## Rollback path C — commit revert (local / CI)

If the bad change is still only in `main` and has not deployed:

```bash
# Revert the bad commit with a new commit (do NOT git push -f).
git revert <bad-sha>
git push origin main

# CI will re-run. If green, deploy using docs/ops/deploy.md.
```

---

## After the rollback

1. **Confirm SLOs recover** — wait 5 minutes, then check `/metrics` p95
   values. They should be back to baseline.
2. **Open a follow-up issue** titled "post-rollback: <what broke>".
   Include the commit SHA that was reverted.
3. **Diagnose at leisure** — the production fire is out. The forward-fix
   doesn't need to ship in the next hour.
4. **Update the deploy runbook** if pre-flight checks should have caught
   this earlier.

---

## What NOT to do during a rollback

- **Do not** `git push --force` anything. Use `git revert`.
- **Do not** delete the bad release image on Fly.io — you may need to
  rollforward if the rollback itself turns out to be bad.
- **Do not** silently fix the same code in a new commit and deploy; that
  loses the forensic trail. Revert first, then fix.
- **Do not** skip the smoke checks on the rolled-back version. "Rolled
  back to a known-good release" is an assumption, not a verification.
