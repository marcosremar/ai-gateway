# HTTP API Reference

All endpoints are served by the gateway server (`bun serve.ts`, default port `4000`).

::: warning Blocked transports
WebSocket (`/ws/stream`) and WebRTC return `410 Gone`. Streaming is supported via SSE on `POST /v1/chat/completions` with `stream: true`. All other client code must use the JSON endpoints below.
:::

## Authentication

All endpoints (except `GET /health`) require a Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_API_KEY" ...
```

Set `GATEWAY_API_KEYS` on the server (comma-separated for multiple keys). When unset, only localhost requests are allowed.

## Rate Limiting

The gateway enforces a per-client token-bucket rate limit (default: **6000 RPM**, configurable via `RATE_LIMIT_RPM` env var).

Every response includes standard rate-limit headers:

```
X-RateLimit-Limit: 6000          # Total capacity (requests per minute)
X-RateLimit-Remaining: 5847      # Tokens left in your bucket
X-RateLimit-Reset: 1775960500    # Unix epoch second when bucket is full
```

When rate-limited, the response is `429 Too Many Requests` with a `Retry-After` header:

```
HTTP/1.1 429 Too Many Requests
Retry-After: 3
X-RateLimit-Remaining: 0
```

**Client best practice**: read `X-RateLimit-Remaining` and back off when it drops below 10% of `X-RateLimit-Limit`. The `Retry-After` header gives the exact number of seconds to wait before retrying.

## Request Size Limit

Maximum request body: **100 MB** (for audio file uploads). Requests exceeding this limit receive `413 Payload Too Large` before the body is read.

## Speech Pipeline

### `POST /v1/speech`

Full STT → LLM → TTS in one HTTP call. The gateway handles GPU vs cloud routing transparently.

**Query params:**
| Param | Required | Example | Description |
|---|---|---|---|
| `source` | Yes | `fr` | Source language (BCP-47) |
| `target` | Yes | `en` | Target language |
| `speaker` | No | `Ryan` | TTS voice name |

**Request:**
```bash
curl -X POST "http://localhost:4000/v1/speech?source=fr&target=en&speaker=Ryan" \
  --data-binary @audio.wav \
  -H "Content-Type: audio/wav"
```

**Response:**
```json
{
  "transcription": "Bonjour le monde",
  "response": "Hello world",
  "audio_base64": "UklGR...",
  "content_type": "audio/wav",
  "timing": {
    "total_ms": 1234,
    "stt_ms": 210,
    "llm_ms": 380,
    "tts_ms": 640,
    "used_gpu": true
  }
}
```

---

## Individual Stages

### `POST /v1/audio/transcriptions`

STT only — OpenAI-compatible.

```bash
curl -X POST http://localhost:4000/v1/audio/transcriptions \
  -F "file=@audio.wav" \
  -F "model=whisper-large-v3" \
  -F "language=fr"
```

```json
{ "text": "Bonjour le monde" }
```

### `POST /v1/chat/completions`

LLM only — OpenAI-compatible.

```bash
curl -X POST http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"Hello"}]}'
```

### `POST /v1/audio/speech`

TTS only — OpenAI-compatible.

```bash
curl -X POST http://localhost:4000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello world","voice":"Ryan","model":"tts-1"}' \
  --output speech.wav
```

---

## GPU Management

### `GET /v1/gpu/status`

```json
{
  "status": "RUNNING",
  "podId": "abc123",
  "endpoint": "http://104.x.x.x:8000",
  "gpuType": "NVIDIA GeForce RTX 4090",
  "gpuHealthy": true,
  "idleSec": 42,
  "provider": "runpod"
}
```

### `POST /v1/gpu/deploy`

```json
{
  "dockerImage": "marcosremar/babelcast-subtitle:latest",
  "gpuTypes": ["NVIDIA GeForce RTX 4090"]
}
```

### `POST /v1/gpu/stop`

No body. Pauses the current instance.

### `POST /v1/gpu/resume`

```json
{ "podId": "abc123" }   // optional — omit to resume last stopped
```

### `POST /v1/gpu/terminate`

```json
{ "apiKey": "rpa_..." }
```

### `GET /v1/gpu/offers`

Returns available GPU instances sorted by price.

### `GET /v1/gpu/logs`

Returns last N lines of container stdout.

---

## Diagnostics

### `GET /health`

```json
{
  "status": "ok",
  "providers": {
    "groq": "ok",
    "openai": "ok",
    "gpu": "running"
  }
}
```

### `GET /metrics`

Prometheus metrics in text format.

### `GET /v1/request-log`

Last N requests with timing breakdown.

---

## Python Example (full pipeline)

```python
import httpx, base64, wave, io

client = httpx.Client(base_url="http://localhost:4000")

with open("input.wav", "rb") as f:
    resp = client.post(
        "/v1/speech",
        params={"source": "fr", "target": "en", "speaker": "Ryan"},
        content=f.read(),
        headers={"Content-Type": "audio/wav"},
        timeout=60,
    )

data = resp.json()
print("Transcription:", data["transcription"])
print("Translation:", data["response"])
print(f"Latency: {data['timing']['total_ms']}ms (GPU: {data['timing']['used_gpu']})")

# Save audio
audio_bytes = base64.b64decode(data["audio_base64"])
with open("output.wav", "wb") as f:
    f.write(audio_bytes)
```
