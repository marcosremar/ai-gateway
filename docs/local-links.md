# Local links — a route to any OpenAI-compatible server

A route link can point to any server that speaks the OpenAI API at its own URL: llama.cpp (`llama-server`), LM Studio,
vLLM, Ollama on another port, MLX (`mlx_lm.server`), or a model on the owner's Mac through a tunnel. The link works for
the stages `chat` (`/chat/completions`, streaming included), `stt` (`/audio/transcriptions`) and `tts` (`/audio/speech`).

```json
{ "provider": "openai-compatible", "baseUrl": "http://localhost:8080/v1", "model": "qwen2.5-7b", "apiKeyEnv": "LOCAL_LLM_KEY" }
```

| Field | Meaning |
|---|---|
| `baseUrl` | `http`/`https` URL ending where the OpenAI paths start (usually `/v1`). No user/password, query or fragment. |
| `model` | Model id sent to the server (default: the alias). |
| `apiKeyEnv` | Optional. **Name** of a gateway env variable whose value goes as `Authorization: Bearer`. Must start with `LOCAL_` (a route never sends `OPENROUTER_API_KEY` or another provider key to its own server). The value is read on every call and never stored in the route. Without `apiKeyEnv` the gateway sends `Bearer local`. |
| `voice` | TTS only: the voice id of that server (sent as is). |
| `equivalent` | Optional. Puts the link in an equivalence group with cloud links (reorder by health, cheaper-model hint). Without it the link is alone in its group. |

## TTS: language and streaming

- **Language.** The OpenAI speech API has no language field. A local link's TTS adds the request's `language` to the
  body it sends, as an extra field, exactly as the client wrote it (`fr`, `pt-BR`, `French`; trimmed, at most 35
  characters; a non-string is dropped):

  ```json
  { "model": "kokoro", "input": "Bonjour.", "voice": "ff_siwis", "response_format": "wav", "language": "fr" }
  ```

  A server that ignores unknown fields is unaffected; a server that speaks more than one language reads it (the parle
  Mac stack: `tools/speech/local-voice/gateway.py`). No other client extra (`ref_audio`, `task_type`, `stream_format`…)
  reaches a local link: those stay with the deployment replicas, and a cloud provider gets none.
- **Streaming.** A `wav` or `pcm` request (with `stream` not `false`) passes the server's answer on as it arrives: the
  gateway holds it only until the first audio past the WAV header (44 bytes), then forwards every chunk. A server that
  synthesizes chunk by chunk (no `content-length`, chunked transfer) gives the client its first byte with its first
  chunk; a server that answers the whole file at once is passed on the same way. The per-attempt timeout and the cloud
  hedge then count the time to the first audio, not the whole sentence. An answer that ends before any audio, or a
  JSON body, fails with code `empty` and the chain moves on (an answer without audio is never a success); an error
  after the first audio chunk is sent can no longer fall back. Other formats (`mp3`, `opus`…) are read whole.

## How the gateway treats it

- **Local, not cloud.** The link id is `local:<host>[/path]/<model>` (`X-Gateway-Provider`, telemetry `provider`,
  `/health` chains, the panel). A chain with only local links still gets the cloud fallback appended (the gateway
  always answers): `PUT` and `/health` show it in `cloudFallbackAdded`.
- **Same routing as any link:** its own circuit breaker (stage + link id, so two servers or two models never share
  one), the cloud hedge, the stage budget, cost zero (label `local`).
- **Probe:** the fallback probe (every 15 min) sends it the same content-checked request as a cloud reserve; `#reservas`
  and «Garantia do serviço» mark it `local` (kind `Servidor local`).
- **Limits:** answer capped at 50 MB, SDK timeout 60 s (the route's own timeouts and budget still apply first), redirects
  refused.

## Security (SSRF)

- **Only an admin key** writes a route with a `baseUrl` (`PUT /v1/apps/:app/routes`, or `MODEL_ROUTES`). An app's own
  key gets 403.
- **On the published gateway** (Railway, `RAILWAY_ENVIRONMENT`/`RAILWAY_PROJECT_ID` set) a link to a private, loopback,
  link-local, CGNAT or metadata address (`10/8`, `172.16/12`, `192.168/16`, `127/8`, `100.64/10`, `::1`, `169.254/16`,
  `fc00::/7`, `fe80::/10`, `localhost`, `metadata.google.internal`…) is refused. An address written in the URL is refused
  at mount (not mounted, reason in `/health`). On every call the host is resolved and every address checked before the
  request (so `*.railway.internal`, or a name that rebinds to `169.254.169.254`, is refused), and a plain-`http` request
  goes to the address that was checked, so a DNS rebinding cannot swap it in between. A host listed in
  `LOCAL_LINK_ALLOW` (comma-separated host names or IPs) skips the check.
- **A gateway off Railway** (your Mac, a dev box) reaches anything, `localhost` included.
- **Where the gateway listens.** Off Railway `serve.ts` listens on `127.0.0.1` (`src/config/listen-host.ts`): with no
  client key (open mode) only this machine reaches it, and its local links with it. `GATEWAY_HOST=0.0.0.0` opens it to
  the network (do it only with `GATEWAY_API_KEYS` set); both Dockerfiles set it, since a container is reached through
  its port mapping. On Railway it listens on `0.0.0.0` whatever `GATEWAY_HOST` says.

## Local gateway → llama.cpp or LM Studio

```bash
llama-server -m qwen2.5-7b-instruct-q4_k_m.gguf --port 8080      # or LM Studio: Developer → Start server (port 1234)
MODEL_ROUTES='{"chat":{"mac-llm":[{"provider":"openai-compatible","baseUrl":"http://localhost:8080/v1","model":"qwen2.5-7b"}]}}' \
  bun run dev                                                     # the gateway on this Mac (port 4000)
curl localhost:4000/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"mac-llm","messages":[{"role":"user","content":"oi"}]}'
```

The answer carries `X-Gateway-Provider: local:localhost:8080/qwen2.5-7b`; with the server off it comes from the cloud
fallback (`X-Gateway-Fallback: unreachable`). Same shape for STT (`"stt": {"mac-stt": [{… "model": "whisper-1"}]}`,
e.g. `whisper.cpp` server or `speaches`) and TTS (`"tts": {"mac-tts": [{… "model": "kokoro", "voice": "af_heart"}]}`,
e.g. Kokoro-FastAPI).

## Published gateway → the owner's Mac through a tunnel

```bash
# on the Mac: a tunnel with a stable https name, and a key the tunnel cannot leak
cloudflared tunnel --url http://localhost:8080        # → https://<name>.trycloudflare.com (or a named tunnel)
# or: tailscale funnel 8080                            # → https://mac.<tailnet>.ts.net
llama-server -m model.gguf --port 8080 --api-key "$LOCAL_LLM_KEY"
```

On Railway (service `ai-gateway`): set `LOCAL_LLM_KEY` to the same value. A public tunnel name (`*.trycloudflare.com`,
a Tailscale funnel) passes as is; a host that resolves to a private or tailnet address (the gateway container joined the
tailnet, a LAN) needs `LOCAL_LINK_ALLOW=mac.<tailnet>.ts.net`. Then, with the admin key:

```bash
curl -X PUT https://<gateway>/v1/apps/myapp/routes -H "Authorization: Bearer $AI_GATEWAY_ADMIN_KEY" -H 'content-type: application/json' -d '{
  "chat": { "mac-llm": [{ "provider": "openai-compatible", "baseUrl": "https://mac.example.ts.net/v1", "model": "qwen2.5-7b", "apiKeyEnv": "LOCAL_LLM_KEY" }] }
}'
```

With the Mac asleep the link fails, its breaker opens for 30 s and the cloud fallback answers; the next probe shows it red
in `#reservas` until the Mac is back.
