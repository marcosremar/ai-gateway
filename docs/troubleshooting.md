# Troubleshooting FAQ

Common issues and their solutions in AI Gateway.

---

## Quick Diagnostics

```bash
# Is the gateway healthy?
curl http://localhost:4000/health

# Get detailed health info
curl http://localhost:4000/health/detail

# Check request logs
curl http://localhost:4000/v1/logs?limit=50

# View Prometheus metrics
curl http://localhost:4000/metrics
```

---

## GPU Issues

### GPU won't boot

**Symptoms:** `GPU_BOOT_ERROR`, `GPU_NOT_READY`

**Causes and fixes:**

1. **Insufficient credits** — Check provider billing dashboard
2. **Wrong GPU type name** — Must match exactly (see `GPU_TYPES` in `src/constants/`)
3. **Docker image pull failed** — Check Docker Hub rate limits; set `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`
4. **SSH tunnel timeout** — Vast.ai requires SSH proxy; check `VAST_API_KEY`

**Diagnostic steps:**
```bash
ai-gateway gpu status
ai-gateway gpu logs
ai-gateway gpu offers  # Check available GPU types
```

### Ghost GPU (charged but not usable)

**Symptoms:** GPU shows as running but health check fails

**Fix:**
```bash
# Sweep detects and terminates ghosts
ai-gateway gpu sweep
# Or manually
ai-gateway gpu terminate
ai-gateway gpu deploy
```

### Idle watchdog not stopping GPU

**Symptoms:** GPU running past `IDLE_TIMEOUT_MIN`

**Causes:**
- Container doesn't have the watchdog script (check Docker image)
- Gateway server is down (watchdog runs in-container as fallback)

---

## Provider Issues

### 429 Rate Limited

**Symptoms:** `PROVIDER_RATE_LIMITED` errors

**Fixes:**
1. Set `RATE_LIMIT_RPM` to stay under provider limits
2. Add more providers to fallback chain
3. Wait for cooldown to expire (default 30s)

### Provider auth failed

**Symptoms:** `PROVIDER_AUTH_FAILED`

**Check:**
```bash
# Verify API key is set
echo $GROQ_API_KEY
echo $OPENAI_API_KEY

# Check vault (if used)
ai-gateway config keys
```

### Credits exhausted

**Symptoms:** `CREDIT_EXHAUSTED` — provider is permanently blocked until manual reset

**Fix:**
```bash
# Clear cooldown file
rm -f ~/.babelcast/cooldowns.json
# Restart gateway
```

---

## Speech Pipeline Issues

### STT transcription is wrong

**Common causes:**
1. **Wrong language audio** — Whisper degrades ~19% WER on language mismatch
2. **Noisy audio** — Try `initial_prompt` with domain vocabulary
3. **Audio format** — Must be WAV, 16kHz, 16-bit mono for best results

**Improve quality:**
- Set `source` parameter correctly
- Use `whisper-large-v3` (better than turbo for quality)
- Add domain-specific terms to session title

### TTS audio is garbled

**Causes:**
1. **Wrong voice name** — Voice must exist on the provider
2. **Encoding mismatch** — Check `content_type` in response
3. **Provider limitation** — Some TTS providers have character limits

---

## Deployment Issues

### Fly.io deploy fails

**Common causes:**
1. **Missing env vars** — Check `fly secrets list`
2. **Health check timeout** — GPU boot takes 30-60s; increase `start_period`
3. **Port mismatch** — Ensure `PORT` env matches `fly.toml`

**Fix:**
```bash
fly secrets set GROQ_API_KEY=your_key
fly secrets set GATEWAY_API_KEYS=key1,key2
fly deploy
```

### Local development won't start

**Check:**
```bash
# Do you have bun?
bun --version

# Do you have GROQ_API_KEY?
cat .env | grep GROQ_API_KEY

# Is port 4000 free?
lsof -i :4000
```

**Fix:**
```bash
cp .env.example .env
# Edit .env and add your GROQ_API_KEY
bun install
bun run serve.ts
```

---

## Test Issues

### Tests fail with "GROQ_API_KEY required"

**Fix:** Skip GPU/live tests
```bash
SKIP_GPU_TESTS=1 bun run test:unit
```

### Tests are slow

**Cause:** 283 test files running sequentially

**Fix:** Run specific test file
```bash
bun run vitest run __tests__/specific-test.test.ts
```

### Tests pass locally but fail in CI

**Common causes:**
1. **Race condition** — Tests are `concurrent: false` but some still share state
2. **Rate limit** — CI runs many tests; Groq rate limit hits
3. **Missing mock** — Test depends on external service

**Fix:** The test has `retry: 1` to handle transient failures. If it still fails, check the test for unmocked external calls.

---

## Performance Issues

### High latency

**Diagnose:**
```bash
# Check which provider is slow
curl http://localhost:4000/health/detail

# Check recent request latencies
curl http://localhost:4000/v1/logs?limit=20
```

**Fixes:**
1. **GPU cold start** — Normal for first request (30-60s). Subsequent requests are <2s
2. **Provider fallback** — If primary provider is slow, fallback adds latency
3. **Network issues** — Check Fly.io region vs provider region

### High memory usage

**Diagnose:**
```bash
# Check Node.js heap
curl http://localhost:4000/v1/services
```

**Fixes:**
1. **Restart gateway** — `fly machines restart <id>`
2. **Reduce concurrency** — Lower `MAX_CONCURRENT_REQUESTS`
3. **Check for memory leaks** — Monitor over time

---

## Getting More Help

- **Architecture questions** → `docs/decisions/` (ADRs)
- **API reference** → `README.md`
- **Security issues** → `SECURITY.md`
- **Contributing** → `CONTRIBUTING.md`
- **Onboarding** → `docs/onboarding.md`
- **Open an issue** → Use the bug report template
