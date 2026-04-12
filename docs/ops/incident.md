# Incident Runbook

> **Audience**: first-responder when an alert fires or a user reports an
> outage. The goal of this document is to reduce time-to-decision, not to
> teach the system.

---

## Severity levels

| Sev | Definition | Response time | Who responds |
|---|---|---|---|
| **SEV-1** | Gateway returns 5xx for >5 min OR full provider fallback exhausted | Immediate (≤5 min) | On-call + a second engineer |
| **SEV-2** | An SLO breach sustained ≥15 min (see `docs/slo.md`) | ≤15 min | On-call |
| **SEV-3** | Degraded but workable — one provider down, fallback holding | ≤1 hour | On-call, business hours |
| **SEV-4** | Cost alert (daily budget breach), orphaned GPU, reputation cliff | Same day | Whoever sees the alert |

When in doubt, treat as one severity higher. De-escalation is cheap.

---

## First 5 minutes (every incident)

1. **Acknowledge the alert** in the channel it came from. Stops duplicate
   responders.
2. **Check `GET /health`** on `parle-ai-gateway.fly.dev`. If 200, the
   process is alive. If 5xx or timeout, jump to "Gateway unreachable".
3. **Check the last deploy**:
   ```bash
   flyctl releases --app parle-ai-gateway | head -5
   ```
   If the incident started within 15 minutes of the most recent release,
   **rollback first**, investigate second. See `docs/ops/rollback.md`.
4. **Pull live logs** to a scratch window:
   ```bash
   flyctl logs --app parle-ai-gateway
   ```
   Look for: `error`, `timeout`, `rate_limit`, `EADDRINUSE`, `OOM`.
5. **Post in `#incidents`**: "Investigating SEV-X: <one-line summary>. Acting
   on <hypothesis>. ETA to update: 10 min."

---

## Decision tree by SLO

### `/v1/chat/completions` p95 > 2s

Most likely cause order:
1. **Groq rate limit** — `grep "429" logs`. Fallback chain should have
   kicked in; if it didn't, the chain config is broken. Check
   `src/proxy/routes/chat-completions.ts`.
2. **Groq upstream slowdown** — check status.groq.com. Nothing to do but
   wait or switch providers (edit proxy chain, redeploy).
3. **Our box is saturated** — `flyctl status` shows machine CPU. Scale up
   `shared-cpu-2x` → `shared-cpu-4x` in `fly.toml`, redeploy.
4. **Our logger is blocking** — rare, but pino sync mode on stdout can
   stall under heavy load. Restart machine: `flyctl machine restart <id>`.

### `/v1/speech` pipeline p95 > 4s

1. **One stage breached** — look at per-stage p95 in `/metrics`
   (JSON format on `?format=json`). Fix that stage specifically.
2. **GPU pipeline lost health** — check `GET /v1/gpu/status`. If GPU is
   down, the pipeline falls back to cloud providers which are slower.
   Redeploy GPU tier: `POST /v1/gpu/deploy`.

### GPU boot failures > 5%

1. **Provider outage** — look at `boot_failed` events by provider in
   the lifecycle log. If one provider is 100% failing, disable it via
   `POST /v1/config/providers` to take it out of the chain temporarily.
2. **Quota/credit exhausted** — error message says "quota" or "credit".
   Contact provider support. Track in `~/.babelcast/runpod-quota.json`
   or equivalent.
3. **Image pull failing** — check Docker Hub, Vast.ai image-login env
   vars, SnapGPU S3 credentials.

### Daily spend > $50

1. **Runaway auto-boot loop** — a tier is boot-failing and retrying
   every few seconds. Check `boot_failed` count per tier. Use the
   manual-stop flag to quarantine the tier.
2. **Orphaned instances** — `GET /v1/gpu/sweep` lists every running
   instance across all providers. Cross-reference with active tier
   states; delete anything orphaned.
3. **Unexpected price spike** — some Vast.ai hosts raise their rate
   mid-session. Check `pricePerHr` in recent `boot_ok` events.

### Gateway unreachable (SEV-1)

1. **Fly.io status**: https://status.fly.io
2. **Machine check**: `flyctl status --app parle-ai-gateway`. Is the
   machine `started`?
3. **Force restart**: `flyctl machine restart <id> --app parle-ai-gateway`.
4. **If that fails**: `flyctl scale count 0 && flyctl scale count 1` to
   force re-provision.
5. **If Fly.io itself is down**: there's nothing to do except status-page
   users. We run single-region.

---

## During the incident

- **Communicate every 10 minutes**, even if there's nothing new.
- **Don't try fixes you haven't done before** — rollback first, experiment later.
- **Keep a running timeline** in the incident channel. Paste command output.
- **Don't merge anything to main** until the incident is resolved.

---

## After the incident

1. Open a **postmortem doc** within 24 hours for any SEV-1 or SEV-2.
2. Template: `## What happened / ## Why / ## What we did / ## What we'll change`.
3. Land any follow-up work as PRs referencing the postmortem.
4. Update this runbook if the decision tree was wrong or missing a branch.

---

## Tools

- Fly dashboard: https://fly.io/apps/parle-ai-gateway
- Logs: `flyctl logs --app parle-ai-gateway`
- SSH into machine: `flyctl ssh console --app parle-ai-gateway`
- Metrics: `GET /metrics` on the gateway
- Lifecycle events: `GET /v1/gpu/logs/events?limit=100`
