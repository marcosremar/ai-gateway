# ADR-008: Speech Pipeline Design (STT → LLM → TTS)

**Status:** Accepted
**Date:** 2026-03-01
**Deciders:** Marcos

## Context

The core use case is: **send audio in one language, receive translated audio back**. This requires three sequential steps: STT → LLM translation → TTS.

Clients shouldn't need to orchestrate three separate API calls, handle GPU vs cloud routing, or manage transport protocols.

## Decision

**Single endpoint, three stages, transport-transparent:**

```
POST /v1/speech?source=fr&target=en&speaker=Ryan
Content-Type: audio/wav

→ {
  transcription: "Bonjour le monde",
  response: "Hello world",
  audio_base64: "UklGR...",
  content_type: "audio/wav",
  timing: { total_ms: 1234, used_gpu: true }
}
```

### Design principles

1. **Transport hidden** — Client doesn't know if GPU or cloud was used
2. **GPU first, cloud fallback** — Automatic, no client decision
3. **SSE/WS/WebRTC blocked** — Keep it simple, HTTP only
4. **Stage-level error handling** — If STT succeeds but LLM fails, return partial result

### Stage orchestration

Each stage:
- Validates input from previous stage
- Tries GPU provider first
- Falls back to cloud on failure
- Tracks latency independently
- Does NOT log raw content (privacy)

## Consequences

### Positive
- Trivial client integration (one HTTP call)
- Easy to cache, retry, and monitor
- Gateway can change providers/transport without breaking clients

### Negative
- Synchronous — client waits for full pipeline completion
- Base64 audio in response (~33% overhead vs binary)
- Not suitable for streaming conversations

## Alternatives Considered

1. **Three separate endpoints** — More flexible but client must orchestrate
2. **WebSocket streaming** — Better for conversations but complex client code
3. **SSE for incremental output** — Good for long responses but SSE blocked by policy

## References

- `src/pipeline/` — Pipeline implementation
- `src/proxy/routes/audio-transcriptions.ts` — STT endpoint
- `src/proxy/routes/audio-speech.ts` — TTS endpoint
- README (Speech Pipeline section)
