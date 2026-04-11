# HTTP API Reference

All endpoints are served by the gateway server (`bun serve.ts`, default port `4000`).

::: warning Blocked transports
SSE (`text/event-stream`), WebSocket (`/ws/stream`), and WebRTC return `410 Gone`. All client code must use the JSON endpoints below.
:::

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
