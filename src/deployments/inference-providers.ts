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
async function callReplica(
  controller: Leaser, name: string, path: string, init: RequestInit, opts: DeploymentProviderOptions, signal?: AbortSignal,
): Promise<Response> {
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
      // The gateway aborts through `signal` when it gives up on this replica (route/target timeout): the request is
      // cancelled at once and the lease released, instead of hanging until the provider's own 120 s cap.
      signal: AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 120_000), ...(signal ? [signal] : [])]),
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
  /** Starts scaling up a cold deployment without sending a request (e.g. when an answer came from the cache). */
  prewarm(): void {
    const status = (this.controller.get(this.deployment) as { status?: string } | null)?.status;
    if (status === 'scaled-to-zero' || status === 'warming') this.controller.wake?.(this.deployment);
  }
  protected call(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    return callReplica(this.controller, this.deployment, path, init, this.opts, signal);
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
        ...request.extraBody,
      }),
    }, request.signal);
    const payload = await res.json() as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = payload.usage;
    return {
      content: payload.choices?.[0]?.message?.content ?? '',
      model: payload.model ?? request.model,
      ...(payload.choices?.[0]?.finish_reason ? { finishReason: payload.choices[0].finish_reason } : {}),
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
    const res = await this.call('/v1/audio/transcriptions', { method: 'POST', body: form }, request.signal);
    const payload = await res.json() as { text?: string };
    return { text: payload.text ?? '', raw: payload, timing: { total_ms: Date.now() - t0 } };
  }
}

/** A voice of the replica's own catalog (`GET /refs/voices.json`, the parle Qwen3-TTS Base image). */
export interface ReplicaVoice { id: string; lang?: string; audio: string; text: string }
interface ReplicaCatalog { model?: string; format?: string; voices: ReplicaVoice[] }

const CATALOG_TTL_MS = 5 * 60_000;

/** Qwen3-TTS takes the language by name; clients may send an ISO code ("pt", "pt-BR") instead. */
const LANGUAGE_NAMES: Record<string, string> = {
  pt: 'Portuguese', fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', ru: 'Russian',
};

function languageName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const code = value.trim().slice(0, 2).toLowerCase();
  return /^[a-z]{2}(-[a-z]{2})?$/i.test(value.trim()) ? LANGUAGE_NAMES[code] ?? value : value;
}

function catalogOf(raw: unknown): ReplicaCatalog | null {
  const input = raw as { model?: unknown; format?: unknown; voices?: unknown } | null;
  if (!input || !Array.isArray(input.voices)) return null;
  const voices = input.voices.filter((v): v is ReplicaVoice =>
    !!v && typeof v.id === 'string' && typeof v.audio === 'string' && typeof v.text === 'string');
  return { model: typeof input.model === 'string' ? input.model : undefined, format: typeof input.format === 'string' ? input.format : undefined, voices };
}

/**
 * TTS on a self-hosted replica.
 *
 * - Client extra fields (`task_type`, `ref_audio`, `ref_text`, `language`, `stream_format`, …) are forwarded intact.
 * - Voice cloning (Qwen3-TTS **Base**, the parle `parle-qwen-tts` image): when the client sends a cast voice id and no
 *   `ref_audio`, the voice is looked up in the replica's catalog (`/refs/voices.json`, cached 5 min) and the request
 *   becomes `task_type: "Base"` + `ref_audio` + `ref_text` (+ `language` from the voice, + the catalog's model) — the
 *   same request parle's qwen-speech.ts builds. A replica without catalog (CustomVoice / OpenAI-shaped) gets the
 *   request as sent.
 * - Streaming: with `stream` and wav/pcm, asks for `stream: true, stream_format: "audio"` and returns the body as it
 *   arrives (first bytes before the whole sentence is synthesized).
 */
export class DeploymentTTSProvider extends DeploymentProviderBase implements TTSProvider {
  private catalog: { at: number; value: ReplicaCatalog | null } | null = null;

  getVoices(): VoiceInfo[] { return (this.catalog?.value?.voices ?? []).map(v => ({ id: v.id, name: v.id })); }

  /** The replica's voice catalog, or null when it has none (404 / not JSON). Errors of the call itself propagate. */
  private async voiceCatalog(signal?: AbortSignal): Promise<ReplicaCatalog | null> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    let value: ReplicaCatalog | null = null;
    try {
      const res = await this.call('/refs/voices.json', { method: 'GET' }, signal);
      value = (res.headers.get('content-type') ?? '').includes('json') ? catalogOf(await res.json().catch(() => null)) : null;
    } catch (err) {
      // No catalog on this replica (HTTP 404 → status 502 'error' from callReplica): plain OpenAI-shaped TTS.
      if (!(err instanceof DeploymentCallError) || err.gatewayCode !== 'error') throw err;
    }
    this.catalog = { at: Date.now(), value };
    return value;
  }

  private async body(request: TTSRequest): Promise<Record<string, unknown>> {
    const extra = request.extra ?? {};
    const format = request.responseFormat ?? 'wav';
    const body: Record<string, unknown> = {
      model: request.model,
      input: request.input,
      voice: request.voice,
      response_format: format,
      ...(request.speed !== undefined ? { speed: request.speed } : {}),
      ...(request.instructions ? { instructions: request.instructions } : {}),
    };
    if (extra.ref_audio === undefined && request.voice) {
      const catalog = await this.voiceCatalog(request.signal);
      const voice = catalog?.voices.find(v => v.id === request.voice);
      if (voice) {
        Object.assign(body, {
          task_type: 'Base', ref_audio: voice.audio, ref_text: voice.text,
          ...(catalog?.model ? { model: catalog.model } : {}),
          ...(voice.lang && languageName(voice.lang) ? { language: languageName(voice.lang) } : {}),
        });
      }
    }
    Object.assign(body, extra);
    if (extra.language !== undefined) body.language = languageName(extra.language);
    if (request.stream && (format === 'wav' || format === 'pcm') && extra.stream === undefined) {
      Object.assign(body, { stream: true, stream_format: 'audio' });
    }
    return body;
  }

  private async request(request: TTSRequest): Promise<Response> {
    const res = await this.call('/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await this.body(request)),
    }, request.signal);
    // vLLM-Omni answers some errors (and SSE events without stream_format) as JSON: that is not audio.
    if ((res.headers.get('content-type') ?? '').includes('json') || !res.body) {
      const text = await res.text().catch(() => '');
      throw new DeploymentCallError(502, `deployment '${this.deployment}' sent no audio: ${text.slice(0, 200)}`, 'error');
    }
    return res;
  }

  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const res = await this.request(request);
    const contentType = res.headers.get('content-type') ?? 'audio/wav';
    if (request.stream) return { audio: Buffer.alloc(0), stream: res.body!, contentType };
    return { audio: Buffer.from(await res.arrayBuffer()), contentType };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    return (await this.request({ ...request, stream: true })).body!;
  }
}
