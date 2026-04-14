# Security Architecture

This document describes the security model of AI Gateway.

## Threat Model

### What we protect

1. **API Keys** — Provider credentials (Groq, OpenAI, RunPod, etc.)
2. **User Data** — Audio content, transcriptions, translations
3. **GPU Resources** — Expensive cloud GPU instances (cost: $0.44-2.00/hr)
4. **Service Availability** — Rate limiting, budget enforcement

### Attack Surface

```
Internet → [Proxy Server:4000]
                      │
                      ├── /v1/speech          ← Audio input (injection risk)
                      ├── /v1/chat/completions ← LLM proxy (prompt injection)
                      ├── /v1/audio/transcriptions ← STT
                      ├── /v1/audio/speech     ← TTS
                      ├── /v1/gpu/*            ← GPU management (auth required)
                      ├── /health              ← Public health check
                      └── /metrics             ← Prometheus metrics
```

## Security Layers

### 1. Authentication

- **API Key validation** — All non-health endpoints require valid API key
- **HMAC GPU tokens** — GPU instances authenticate via signed tokens
- **No default access** — No endpoints are public without auth (except `/health`)

### 2. Input Validation

- **Zod schemas** — All incoming payloads validated against schemas
- **Size limits** — Max body size: 100MB (enforced at HTTP level)
- **Content-Type enforcement** — Each endpoint validates expected content type

### 3. Rate Limiting

- **Global RPM** — `RATE_LIMIT_RPM` env var (disabled by default)
- **Token bucket** — Per-client rate limiting in load balancer
- **Cooldown tracking** — Failed providers are cooled down, not retried immediately

### 4. Secrets Management

- **No secrets in code** — All credentials via environment variables
- **No secrets in logs** — API keys are masked (`gsk_***`)
- **Vault storage** — API keys stored in file-based vault with file permissions

### 5. Network Security

- **Security headers** — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`
- **HTTPS in production** — Fly.io handles TLS termination
- **Internal GPU endpoints** — GPU pods not exposed to public internet

### 6. Dependency Security

- **Dependency audit** — CI runs `bun audit` on every PR
- **Dependabot** — Weekly automated dependency updates
- **Pinned lockfile** — `--frozen-lockfile` ensures reproducible installs

## Data Flow Security

### Speech Pipeline

```
Client ──audio──→ [POST /v1/speech]
                         │
                    Validate API key ✓
                    Validate Content-Type ✓
                    Check body size ✓
                         │
                    [STT Provider] ──transcription──→
                         │
                    [LLM Provider]  ──response──→
                         │
                    [TTS Provider]  ──audio──→
                         │
                    Return JSON (base64 audio)
```

Each stage:
- Validates input from previous stage
- Logs latency (not content)
- Falls back to next provider on failure
- Does not log raw audio or transcription content

### GPU Autoscaler

```
[Request for GPU]
       │
  Validate credentials ✓
  Check budget limits ✓
       │
  [Select tier] → RunPod → Vast.ai → Modal
       │
  [Boot instance]
       │
  Sign HMAC token → Send to instance
       │
  Track idle time → Auto-stop after timeout
```

## Security Checklist for Contributors

When adding new features, ask:

- [ ] Does this expose any new endpoint? Does it need auth?
- [ ] Does this log any sensitive data? (API keys, audio content, tokens)
- [ ] Does this accept user input? Is it validated with Zod?
- [ ] Does this make external calls? Are credentials handled safely?
- [ ] Does this affect rate limiting or budget enforcement?
- [ ] Are there new dependencies? Have they been audited?

## Incident Response

### If a secret is leaked

1. **Rotate immediately** — Invalidate the exposed key
2. **Check logs** — Determine who had access
3. **Audit usage** — Check provider billing for unauthorized usage
4. **Update** — Remove the secret from git history (`git filter-branch`)

### If GPU is compromised

1. **Terminate instance** — `gw.terminateGpu()`
2. **Revoke HMAC key** — Rotate the signing secret
3. **Audit logs** — Check `~/.babelcast/event-log.jsonl`
4. **Re-deploy** — Boot new instance with clean image

### If rate limit is bypassed

1. **Check config** — Verify `RATE_LIMIT_RPM` is set
2. **Check logs** — Identify bypass pattern
3. **Tighten limits** — Lower RPM, enable per-key limits

## References

- `SECURITY.md` — Vulnerability disclosure policy
- `src/auth/` — HMAC token implementation
- `src/proxy/middleware/auth.ts` — API key validation
- `src/proxy/middleware/rate-limit.ts` — Rate limiting
- `docs/decisions/` — Architecture decisions affecting security
