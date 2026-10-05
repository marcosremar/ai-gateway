/**
 * Deployments as chat / STT / TTS providers, so `/v1/chat/completions`, `/v1/audio/transcriptions` and
 * `/v1/audio/speech` can route a model to a self-hosted replica first and fall back to a cloud provider.
 *
 * The replica must speak the OpenAI shapes (`POST /v1/chat/completions`, `/v1/audio/transcriptions`,
 * `/v1/audio/speech`) — vLLM, vLLM-Omni (Qwen3-TTS) and the parle-speech image do.
 *
 * Cold start: a request does NOT wait for a replica by default (`waitMs` 0). A deployment scaled to zero answers
 * 503 at once (and starts scaling up), so the chain moves to the fallback provider instead of making the user wait
 * minutes; once the replica is ready, traffic returns to it.
 */

import type {
  ChatRequest, ChatResponse, LLMProvider, ModelInfo, STTProvider, STTRequest, STTResponse, TTSProvider, TTSRequest,
  TTSResponse, VoiceInfo,
} from '../gateway/providers/cloud/types';
import { DeploymentError, type DeploymentController } from './controller';
import { replicaBase } from './http';

type Leaser = Pick<DeploymentController, 'acquire' | 'get'> & Partial<Pick<DeploymentController, 'wake'>>;

export interface DeploymentProviderOptions {
  /** How long a request may wait for a replica to become ready (ms). Default 0 — fall back right away. */
  waitMs?: number;
  /** Per-request timeout once a replica was found (ms). Default 120 s (the route's own, shorter timeout applies too). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * `status` drives the fallback chain (every value used here moves on to the next provider); `gatewayCode` is the
 * reason reported in `X-Gateway-Fallback` (cold | paused | not_found | unreachable | 5xx | error).
 */
class DeploymentCallError extends Error {
  /** No point retrying the same deployment within one request: fall back at once. */
  readonly skipRetry: boolean;
  constructor(readonly status: number, message: string, readonly gatewayCode: string) {
    super(message);
    this.skipRetry = ['cold', 'paused', 'not_found', 'unreachable', 'timeout'].includes(gatewayCode);
  }
}

/** Calls `path` on a ready replica of `name`; throws an Error with `.status` the fallback chain understands. */
async function callReplica(controller: Leaser, name: string, path: string, init: RequestInit, opts: DeploymentProviderOptions): Promise<Response> {
  let lease;
  try {
    lease = await controller.acquire(name, { waitMs: opts.waitMs ?? 0 });
  } catch (err) {
    if (!(err instanceof DeploymentError)) throw err;
    if (err.status === 404) throw new DeploymentCallError(404, err.message, 'not_found');
    if (err.status === 409) throw new DeploymentCallError(503, err.message, 'paused');
    // No ready replica (scaled to zero / booting): make sure it is scaling up, and let the chain fall back now.
    try { controller.wake?.(name); } catch { /* deployment vanished meanwhile */ }
    throw new DeploymentCallError(503, err.message, 'cold');
  }
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${replicaBase(lease.machine)}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'X-Aigw-Token': lease.token },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (err) {
    lease.done(true);
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new DeploymentCallError(timedOut ? 504 : 502, `deployment '${name}': replica ${timedOut ? 'timed out' : 'unreachable'}`,
      timedOut ? 'timeout' : 'unreachable');
  }
  lease.done(false);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Any replica error moves on to the fallback (a 4xx from our own server is a deployment problem, not the
    // client's: the gateway already validated the request).
    throw new DeploymentCallError(res.status >= 500 ? res.status : 502, `deployment '${name}' answered HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status >= 500 ? '5xx' : 'error');
  }
  return res;
}

abstract class DeploymentProviderBase {
  readonly providerId = 'self-hosted' as const;
  constructor(protected readonly controller: Leaser, readonly deployment: string, protected readonly opts: DeploymentProviderOptions = {}) {}
  /** "Configured" = the deployment exists on this gateway (its replicas may still be scaled to zero). */
  isConfigured(): boolean { return this.controller.get(this.deployment) !== null; }
  getModels(): ModelInfo[] { return []; }
  protected call(path: string, init: RequestInit): Promise<Response> {
    return callReplica(this.controller, this.deployment, path, init, this.opts);
  }
}

export class DeploymentLLMProvider extends DeploymentProviderBase implements LLMProvider {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await this.call('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      }),
    });
    const payload = await res.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = payload.usage;
    return {
      content: payload.choices?.[0]?.message?.content ?? '',
      model: payload.model ?? request.model,
      ...(u ? { usage: { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } } : {}),
      raw: payload,
    };
  }
}

export class DeploymentSTTProvider extends DeploymentProviderBase implements STTProvider {
  async transcribe(request: STTRequest): Promise<STTResponse> {
    const t0 = Date.now();
    const form = new FormData();
    const audio = Buffer.isBuffer(request.audio) ? new Blob([new Uint8Array(request.audio)]) : request.audio as Blob;
    form.append('file', audio, 'audio.wav');
    form.append('model', request.model);
    if (request.language) form.append('language', request.language);
    if (request.prompt) form.append('prompt', request.prompt);
    form.append('response_format', 'json');
    const res = await this.call('/v1/audio/transcriptions', { method: 'POST', body: form });
    const payload = await res.json() as { text?: string };
    return { text: payload.text ?? '', raw: payload, timing: { total_ms: Date.now() - t0 } };
  }
}

export class DeploymentTTSProvider extends DeploymentProviderBase implements TTSProvider {
  getVoices(): VoiceInfo[] { return []; }

  private request(request: TTSRequest): Promise<Response> {
    return this.call('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        input: request.input,
        voice: request.voice,
        response_format: request.responseFormat ?? 'wav',
        ...(request.speed !== undefined ? { speed: request.speed } : {}),
        ...(request.instructions ? { instructions: request.instructions } : {}),
      }),
    });
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const res = await this.request(request);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'audio/wav' };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request(request);
    if (!res.body) throw new DeploymentCallError(502, `deployment '${this.deployment}' sent no audio`, 'error');
    return res.body;
  }
}
