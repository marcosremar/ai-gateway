# Grafana Cloud Setup

::: warning Not implemented on `serve.ts`
The production gateway (`serve.ts`) exposes **no** `GET /metrics` endpoint (API audit 2026-10-07). The references to
`/metrics` below describe a planned setup; until it exists use the request logs, `GET /health?details=1` (admin key:
connections, stage chains, STT filter and no-wake counters) and `GET /health?deep=1` (admin).
:::

> **Goal**: real-time dashboards for gateway latency, provider health,
> GPU status, and cost tracking. Uses the Prometheus endpoint already
> exposed at `GET /metrics`.

## Quick setup (15 minutes)

### 1. Create Grafana Cloud account (free tier)

Go to https://grafana.com/products/cloud/ → Start free.

Free tier includes:
- 10,000 metrics series
- 14-day retention
- 3 users
- Unlimited dashboards

### 2. Set up Prometheus data source

In Grafana Cloud, go to **Connections → Add data source → Prometheus**.

The gateway exposes metrics at:
```
https://parle-ai-gateway.fly.dev/metrics
```

However, Grafana Cloud can't scrape this directly (it needs a pull-based
agent or push from the app). Two options:

#### Option A: Grafana Alloy agent (recommended)

Install the Grafana Alloy agent on a machine that can reach the gateway:

```bash
# On your dev machine or a lightweight VM
brew install grafana/grafana/alloy  # macOS
# or: docker run grafana/alloy

# Configure alloy to scrape our gateway
cat > alloy-config.river <<EOF
prometheus.scrape "gateway" {
  targets = [{
    __address__ = "parle-ai-gateway.fly.dev",
    __scheme__  = "https",
  }]
  metrics_path = "/metrics"
  scrape_interval = "30s"
  forward_to = [prometheus.remote_write.grafana_cloud.receiver]
}

prometheus.remote_write "grafana_cloud" {
  endpoint {
    url = "https://prometheus-prod-XX-prod-XX.grafana.net/api/prom/push"
    basic_auth {
      username = "YOUR_GRAFANA_CLOUD_USER_ID"
      password = "YOUR_GRAFANA_CLOUD_API_KEY"
    }
  }
}
EOF

alloy run alloy-config.river
```

Replace the endpoint URL and credentials from your Grafana Cloud instance
(found at **Grafana Cloud Portal → Prometheus → Remote Write**).

#### Option B: Push from the gateway (future)

Add a background timer to `serve.ts` that pushes metrics to Grafana Cloud
every 30s via remote_write. More self-contained but requires code changes.

### 3. Import the dashboard

Go to **Dashboards → Import** and upload the JSON from:
```
monitoring/grafana/gateway-dashboard.json
```

Or paste the dashboard ID if we publish it to the Grafana marketplace.

## Dashboard panels

The provisioned dashboard (`monitoring/grafana/gateway-dashboard.json`)
includes these panels:

### Row 1: Overview
- **Requests/min** — `rate(gateway_requests_total[5m]) * 60`
- **Error rate** — `rate(gateway_errors_total[5m]) / rate(gateway_requests_total[5m])`
- **Uptime** — `gateway_uptime_seconds`
- **Active connections** — from `/health` endpoint

### Row 2: Latency
- **P50 / P95 / P99** — `gateway_latency_p50_ms`, `_p95_ms`, `_p99_ms`
- **By endpoint** — if per-endpoint metrics are added later

### Row 3: Providers
- **Requests by provider** — `gateway_requests_by_provider{provider="groq"}`
- **Requests by stage** — `gateway_requests_by_stage{stage="stt"}`

### Row 4: Cost & GPU
- **Daily spend** — `gateway_daily_spend_usd` with budget line at $50
- **GPU ready** — `gateway_gpu_ready` (1=up, 0=down)
- **Cost/hour** — `gateway_cost_per_hour_usd`

### Row 5: Tokens
- **Input tokens** — `rate(gateway_tokens_input_total[5m])`
- **Output tokens** — `rate(gateway_tokens_output_total[5m])`

## Alerting

Grafana Cloud supports alerting on any metric. Recommended alerts:

| Alert | Condition | Channel |
|---|---|---|
| High P95 | `gateway_latency_p95_ms > 2000` for 5min | Discord |
| Error spike | `rate(gateway_errors_total[5m]) > 0.1` | Discord |
| GPU down | `gateway_gpu_ready == 0` for 2min | Slack |
| Spend approaching cap | `gateway_daily_spend_usd > 40` | Email |

These complement (not replace) the in-app `CostWatcher` and `SLO_TARGETS`
alerting. Grafana provides visualization; the in-app alerts provide
immediate webhook delivery.
