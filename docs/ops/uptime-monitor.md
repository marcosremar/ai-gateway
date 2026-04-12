# External Uptime Monitor

> **Why external**: Fly.io's built-in health checks run inside their
> infrastructure. If Fly itself has a regional outage, those checks stop
> running and no alert fires. An external monitor catches that scenario.

## Setup (UptimeRobot — free tier)

1. Create account at https://uptimerobot.com (free for up to 50 monitors)

2. Add HTTP(s) monitor:
   - **URL**: `https://parle-ai-gateway.fly.dev/health`
   - **Monitoring interval**: 60 seconds (free tier minimum)
   - **Keyword**: `"ok"` (expects `{"status":"ok"}` in response)
   - **Timeout**: 30 seconds

3. Configure alert contacts:
   - **Email**: your ops email
   - **Webhook** (optional): Discord or Slack webhook URL
     - Discord: create webhook in `#gateway-alerts`, paste URL
     - Slack: create incoming webhook, paste URL

4. Thresholds:
   - Alert after **2 consecutive failures** (avoids transient flaps)
   - Re-check every **60s** once alerted

## What the monitor checks

The `/health` endpoint returns `{"status":"ok"}` with HTTP 200 when the
gateway process is alive and can serve requests. It does NOT check:

- Provider health (Groq, fal.ai may be down)
- GPU tier state
- Database connectivity

Those are internal health dimensions covered by the autoscaler's own
health checks and lifecycle events. The external monitor answers one
question: **"can a client reach the gateway at all?"**

## Alternatives

| Service | Free tier | Check interval |
|---|---|---|
| UptimeRobot | 50 monitors, 60s | 60s |
| Better Uptime | 10 monitors, 3min | 180s |
| Checkly | 5 monitors, 10min | 600s |
| Cronitor | 5 monitors, 60s | 60s |

UptimeRobot is the best free-tier option for this use case.

## Status page (optional)

UptimeRobot can host a free public status page at
`stats.uptimerobot.com/your-id`. Useful for external consumers who
want to check if the gateway is up before filing a bug report.
