# Performance Baseline

> **Purpose**: reference p50/p95/p99 numbers for each endpoint. Re-run
> after infra changes (deploy target, machine size, region, dependency
> upgrade) and compare against the previous line to detect regression.
>
> **Source of truth**: `load-testing/k6/baseline.js`. If that script and
> this doc disagree, the script is current.

---

## How to run

```bash
# Prereq: k6 installed locally (brew install k6 or download from grafana.com/k6)

# Target the deployed gateway with the API key you use in prod
export GATEWAY_URL=https://parle-ai-gateway.fly.dev
export GATEWAY_API_KEY=<your-key>

# Run the script. Takes ~3 minutes end-to-end.
k6 run load-testing/k6/baseline.js
```

**Budget warning**: This test hits real provider APIs (Groq chat/STT/TTS,
fal.ai image). A single run consumes roughly:

| Provider | Estimated usage per run |
|---|---|
| Groq (chat) | ~750 requests × 5 output tokens ≈ negligible |
| Groq (STT whisper) | ~750 × 1s silence file ≈ negligible |
| Groq (Orpheus TTS) | ~750 × 1 word ≈ negligible |
| fal.ai FLUX Schnell | ~750 × 1 image ≈ $0.75 |

Total per run: **under $1**. Safe to run daily for regression checks.

---

## Reading the output

k6 prints trend metrics per endpoint. The lines you care about:

```
endpoint_chat_ms............: avg=820  min=412 med=780 max=2100 p(90)=1450 p(95)=1780 p(99)=2020
endpoint_stt_ms.............: avg=630  min=380 med=600 max=1800 p(90)=1100 p(95)=1320 p(99)=1650
endpoint_tts_ms.............: avg=920  min=540 med=880 max=2400 p(90)=1700 p(95)=2100 p(99)=2350
endpoint_image_ms...........: avg=5400 min=3200 med=5200 max=9800 p(90)=7500 p(95)=8900 p(99)=9700
```

Compare `p(95)` against the SLO in `docs/slo.md`. Any breach triggers
investigation, not just "rerun the test".

---

## Baseline record

Record the numbers here each time the script is run against a stable
infrastructure snapshot. Include the full context so you can reproduce.

### Template

```markdown
### YYYY-MM-DD — <git sha> — <infra note>

- k6 version: X.Y.Z
- Target: GATEWAY_URL=...
- Fly.io machine: shared-cpu-2x, 1024MB, region cdg
- Duration: 30s ramp → 90s hold → 30s ramp down, peak 50 VUs

| Endpoint | p50 | p95 | p99 | Error rate |
|---|---|---|---|---|
| chat_completions | Nms | Nms | Nms | N% |
| audio_transcriptions | Nms | Nms | Nms | N% |
| audio_speech | Nms | Nms | Nms | N% |
| images_generate | Nms | Nms | Nms | N% |

Notes: <anything unusual in the run>
```

---

## Baselines (history)

### 2026-04-12 — planned, not yet run

The production-readiness plan created the script and this doc. An actual
baseline run against `parle-ai-gateway.fly.dev` is **deferred** until a
scheduled load window is available — running it during active use could
trip the daily spend budget and/or raise false alerts in the gateway
itself.

**To run the first baseline**:

1. Schedule a 5-minute window during off-peak (check `#gateway-deploys`
   and confirm nobody else is deploying/testing).
2. Raise `DAILY_BUDGET_USD` temporarily via `POST /v1/config/apply` if the
   budget is tight for the day.
3. Execute `k6 run load-testing/k6/baseline.js` with `GATEWAY_URL` and
   `GATEWAY_API_KEY` set.
4. Record the results in the template above, commit as a new entry in
   this file.
5. Restore the budget cap.

Subsequent runs can be automated via a scheduled GitHub Action once we
have a stable baseline to diff against.
