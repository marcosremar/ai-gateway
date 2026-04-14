# ADR-003: Transport Policy — No SSE/WebSocket/WebRTC for Client Code

**Status:** Accepted
**Date:** 2026-02-01
**Deciders:** Marcos

## Context

Modern AI APIs often use streaming transports (SSE, WebSocket, WebRTC) for real-time output. However, requiring clients to parse SSE events, manage WebSocket frames, or negotiate WebRTC connections adds significant complexity to client code.

## Decision

**SSE, WebSocket, and WebRTC are blocked at the proxy level (return `410 Gone`).**

All client code uses the JSON pipeline endpoint or the AIClient API. Transport concerns (streaming, chunking, frame negotiation) live **inside** the gateway — callers never see them.

### The only supported audio endpoint

```
POST /v1/speech?source=fr&target=en&speaker=Ryan
Content-Type: audio/wav

→ { transcription, response, audio_base64, content_type, timing }
```

Transport-transparent: client sends audio, gets JSON back. Gateway handles GPU vs cloud, streaming vs batched, internally.

## Consequences

### Positive
- Client code is trivial (single HTTP call)
- No SSE/WebSocket/WebRTC in client SDKs
- Gateway can change transport without breaking clients
- Easier to cache, retry, and monitor

### Negative
- No streaming output for long LLM responses (client waits for full response)
- Audio responses are base64-encoded (larger payload)
- Less suitable for real-time chat (future work: separate endpoint)

## Alternatives Considered

1. **SSE for streaming** — Standard but requires client-side event parser
2. **WebSocket for bidirectional** — Good for conversation but adds connection management
3. **WebRTC for ultra-low-latency** — Best for lipsync but complex negotiation

All three are blocked at proxy. If needed in future, they would be **separate endpoints** (not the pipeline endpoint).

## References

- `src/proxy/server.ts` (410 handler for blocked transports)
- README.md (Transport Policy section)
