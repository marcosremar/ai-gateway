# Observability Strategy

This document describes how AI Gateway achieves production observability through
metrics, logs, traces, and alerts — the "four golden signals."

## Overview

```
Request → [Proxy] → Logs (pino) → Aggregator (Loki/Datadog)
               ↓
           Traces (OTel) → Jaeger/Zipkin
               ↓
           Metrics (Prometheus) → Grafana → Alerts
```

## 1. Logging (Structured JSON)

**Tool:** Pino
**Location:** `src/logger.ts`
**Format:** JSON in production, pretty in development

### Log levels

| Level | Use case | Example |
|-------|----------|---------|
| `fatal` | Process-crashing errors | Uncaught exception, config validation failure |
| `error` | Request failures, provider errors | Provider timeout, auth failure |
| `warn` | Degraded but functional | Fallback triggered, rate limit approaching |
| `info` | Normal operational info | Server started, config loaded, request complete |
| `debug` | Detailed debugging info | Individual provider call details |
| `trace` | Every single step | Span enter/exit, cache hit/miss |

### Structured fields

Every log line includes:
- `method`, `path` — HTTP method and path
- `userId` — Associated user (if known)
- `requestId` — Unique request ID (`X-Request-Id`)
- `durationMs` — Total request duration
- `upstreamMs` — Time spent waiting for upstream provider
- `proxyMs` — Time spent in gateway processing

### Best practices

- **Never log secrets** — API keys are masked (`gsk_***`)
- **Never log raw audio** — Binary data is never in logs
- **Use child loggers** — `createLogger('proxy')` for module context
- **Include context** — Every error log should have `{ providerId, model, userId }`

## 2. Distributed Tracing

**Tool:** OpenTelemetry (in-memory fallback)
**Location:** `src/observability/otel.ts`

### Span hierarchy

```
proxy.request (root span)
├── auth.validate
├── provider.chat
│   ├── provider.fallback (if triggered)
│   └── provider.fallback
├── pipeline.stt
├── pipeline.llm
└── pipeline.tts
```

### Span attributes

- `provider` — Provider ID (groq, openai, etc.)
- `model` — Model name
- `status` — started, success, error
- `durationMs` — Span duration
- `retryable` — Whether the error is retryable

### Export

Traces export to any OTLP-compatible endpoint:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318 bun run serve.ts
```

## 3. Metrics

**Tool:** Prometheus (exposed at `/metrics`)
**Location:** `server/metrics.ts`

### Key metrics

| Metric | Type | Description |
|--------|------|-------------|
| `http_requests_total` | Counter | Total HTTP requests by method/path/status |
| `http_request_duration_ms` | Histogram | Request latency distribution |
| `provider_calls_total` | Counter | Provider API calls by provider/status |
| `provider_latency_ms` | Histogram | Provider response latency |
| `gpu_instances_active` | Gauge | Number of active GPU instances |
| `gpu_boot_duration_ms` | Histogram | GPU boot time distribution |
| `budget_spent_total` | Counter | Total budget spent |
| `fallback_triggers_total` | Counter | Number of fallback activations |

### Grafana dashboards

See `docs/ops/grafana.md` for dashboard setup.

## 4. Alerts

**Tool:** Alert manager (Slack/Discord/Webhook)
**Location:** `src/alerting/`

### Alert rules

| Alert | Condition | Channel |
|-------|-----------|---------|
| GPU boot failure | 3 consecutive failures | Slack #infra |
| Budget exceeded | Spend > 80% of limit | Slack #costs |
| Provider down | 5 consecutive errors | Slack #infra |
| High error rate | Error rate > 5% for 5min | PagerDuty |
| Memory leak | Heap > 512MB for 10min | Slack #infra |
| Latency SLO breach | p95 > 5s for 5min | Slack #infra |

## 5. Health Checks

| Endpoint | Purpose | Auth Required |
|----------|---------|---------------|
| `GET /health` | Basic health (for load balancer) | No |
| `GET /health/detail` | Detailed provider health | Yes |
| `GET /status` | Human-readable status page | No |
| `GET /v1/status` | JSON status for API consumers | No |
| `GET /metrics` | Prometheus metrics | No |

## 6. Request Tracking

Every request gets:
1. **Unique ID** (`X-Request-Id`) — correlates logs, traces, metrics
2. **Duration tracking** — total, upstream, proxy time
3. **Status tracking** — for error rate calculation
4. **User attribution** — userId from auth

The status page (`/status`) aggregates the last 1000 requests into:
- Total request count
- Requests per minute
- Average latency
- Error rate

## 7. Audit Trail

**Tool:** Tamper-evident JSONL log
**Location:** `src/audit/`

Audit events (security-relevant):
- Authentication success/failure
- GPU deploy/stop/terminate
- Configuration changes
- API key rotation
- Budget alerts
- Rate limit hits

Each entry has a SHA-256 checksum to detect tampering.

## 8. Monitoring Checklist

### Daily
- [ ] Check Grafana dashboard for error rate spikes
- [ ] Review GPU instance costs
- [ ] Check provider cooldown status

### Weekly
- [ ] Review budget utilization
- [ ] Check latency SLO compliance (p95 < 5s)
- [ ] Review provider success rates

### Monthly
- [ ] Review total costs vs budget
- [ ] Analyze usage patterns for optimization opportunities
- [ ] Update alert thresholds based on actual traffic patterns
