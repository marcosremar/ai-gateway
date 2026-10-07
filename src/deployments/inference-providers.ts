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
import { DeploymentError, type DeploymentController, type Lease, type LeaseOutcome } from './controller';
import { replicaBase } from './http';
import { applyWhisperSegments } from '../gateway/providers/cloud/stt-segments';
import { noWakeActive, recordNoWakeSkip } from '../gateway/proxy/no-wake';
import { outgoingTraceHeaders } from '../telemetry/trace-context';

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
    this.skipRetry = ['cold', 'paused', 'not_found', 'unreachable', 'timeout', 'voice_not_found', 'catalog_unavailable', 'saturated', 'circuit_open']
      .includes(gatewayCode);
  }
}

/** Calls `path` on a ready replica of `name`; throws an Error with `.status` the fallback chain understands. */
async function callReplica(
  controller: Leaser, name: string, path: string, init: RequestInit, opts: DeploymentProviderOptions, signal?: AbortSignal, stage?: string,
): Promise<Response> {
  let lease;
  // No-wake mode (gateway/proxy/no-wake.ts): a ready replica serves, a cold one is skipped as `cold` and never woken.
  const noWake = noWakeActive();
  try {
    lease = await controller.acquire(name, { ...(noWake ? { waitMs: 0, noWake: true } : { waitMs: opts.waitMs ?? 0 }), ...(stage ? { stage } : {}) });
  } catch (err) {
    if (!(err instanceof DeploymentError)) throw err;
    if (err.status === 404) throw new DeploymentCallError(404, err.message, 'not_found');
    if (err.status === 409) throw new DeploymentCallError(503, err.message, 'paused');
    if (err.code === 'stage_out') throw new DeploymentCallError(503, err.message, 'circuit_open');
    // Every ready replica at capacity: spill this request to the fallback now (the replicas keep what they serve).
    if (err.code === 'saturated') throw new DeploymentCallError(503, err.message, 'saturated');
    // No ready replica (scaled to zero / booting): make sure it is scaling up, and let the chain fall back now.
    if (noWake) recordNoWakeSkip();
    else try { controller.wake?.(name); } catch { /* deployment vanished meanwhile */ }
    throw new DeploymentCallError(503, err.message, 'cold');
  }
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${replicaBase(lease.machine, lease.exposed)}${path}`, {
      ...init,
      // Child `traceparent` of the request being served: the replica (and its edge) log under the same trace.
      headers: { ...(init.headers as Record<string, string> | undefined), ...outgoingTraceHeaders(), 'X-Aigw-Token': lease.token },
      // The gateway aborts through `signal` when it gives up on this replica (route/target timeout): the request is
      // cancelled at once and the lease released, instead of hanging until the provider's own 120 s cap.
      signal: AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 120_000), ...(signal ? [signal] : [])]),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    // The caller aborting (a hedged fallback won, the client left, the stage budget ran out) says nothing about the
    // replica; a timeout means busy; only a connection failure makes it suspect (live QA 2026-10-07: 15 hedge losers
    // counted as failures marked a working L40S unhealthy and it was replaced).
    const callerTimedOut = (signal?.reason as { name?: string } | undefined)?.name === 'TimeoutError';
    lease.done(signal?.aborted && !callerTimedOut ? 'abandoned' : timedOut ? 'timeout' : true);
    throw new DeploymentCallError(timedOut ? 504 : 502, `deployment '${name}': replica ${timedOut ? 'timed out' : 'unreachable'}`,
      timedOut ? 'timeout' : 'unreachable');
  }
  if (!res.ok) {
    // A 429 is the replica's own queue full: pressure for the autoscaler and a busy mark, never a strike.
    lease.done(res.status === 429 ? 'overloaded' : res.status >= 500 ? 'errored' : false);
    const text = await res.text().catch(() => '');
    // Any replica error moves on to the fallback (a 4xx from our own server is a deployment problem, not the
    // client's: the gateway already validated the request).
    throw new DeploymentCallError(res.status >= 500 ? res.status : 502, `deployment '${name}' answered HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status >= 500 ? '5xx' : 'error');
  }
  return leasedBody(res, lease, opts.timeoutMs ?? 120_000, signal);
}

/**
 * The lease covers the whole answer, body included (fault bench 2026-10-07, S1): it used to be released as healthy at
 * the response headers, so a replica that died mid-body was handed the very next request, and a streamed TTS answer
 * counted 0 in flight while it played. Outcomes follow `Lease.done`: `ok` when the body ends; `failed` when it breaks
 * (connection-level); `timeout` when our own or the caller's time limit cut it (busy, not dead); `cancelled` when the
 * caller cancels or aborts (hedge lost, client gone) or nobody read it within `maxMs` (it must not hold the lease, and
 * the deployment's demand, forever).
 */
function leasedBody(res: Response, lease: Lease, maxMs: number, signal?: AbortSignal): Response {
  if (!res.body) { lease.done(false); return res; }
  const reader = res.body.getReader();
  const safety = setTimeout(() => release('cancelled'), maxMs);
  (safety as { unref?: () => void }).unref?.();
  const callerOutcome = (): LeaseOutcome => ((signal?.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
  const onAbort = () => { release(callerOutcome()); reader.cancel().catch(() => {}); };
  let released = false;
  function release(outcome: boolean | LeaseOutcome) {
    if (released) return;
    released = true;
    clearTimeout(safety);
    signal?.removeEventListener('abort', onAbort);
    lease.done(outcome);
  }
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { release(false); controller.close(); } else controller.enqueue(value);
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        release(signal?.aborted ? callerOutcome() : timedOut ? 'timeout' : true);
        controller.error(err);
      }
    },
    cancel(reason) { release('cancelled'); return reader.cancel(reason); },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

abstract class DeploymentProviderBase {
  readonly providerId = 'self-hosted' as const;
  constructor(protected readonly controller: Leaser, readonly deployment: string, protected readonly opts: DeploymentProviderOptions = {}) {}
  /** "Configured" = the deployment exists on this gateway (its replicas may still be scaled to zero). */
  isConfigured(): boolean { return this.controller.get(this.deployment) !== null; }
  getModels(): ModelInfo[] { return []; }
  /** Starts scaling up a cold deployment without sending a request (e.g. when an answer came from the cache). */
  prewarm(): void {
    if (noWakeActive()) return;
    const status = (this.controller.get(this.deployment) as { status?: string } | null)?.status;
    if (status === 'scaled-to-zero' || status === 'warming') this.controller.wake?.(this.deployment);
  }
  protected call(path: string, init: RequestInit, signal?: AbortSignal, stage?: string): Promise<Response> {
    return callReplica(this.controller, this.deployment, path, init, this.opts, signal, stage);
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
    }, request.signal, 'chat');
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
  /** Set once a replica refused `verbose_json` (HTTP 4xx): the next calls go straight to plain json (text only). */
  private verboseRefused = false;

  private async send(request: STTRequest, format: 'json' | 'verbose_json'): Promise<Response> {
    const form = new FormData();
    const audio = Buffer.isBuffer(request.audio) ? new Blob([new Uint8Array(request.audio)]) : request.audio as Blob;
    form.append('file', audio, 'audio.wav');
    form.append('model', request.model);
    if (request.language) form.append('language', request.language);
    if (request.prompt) form.append('prompt', request.prompt);
    form.append('response_format', format);
    return this.call('/v1/audio/transcriptions', { method: 'POST', body: form }, request.signal, 'stt');
  }

  async transcribe(request: STTRequest): Promise<STTResponse> {
    const t0 = Date.now();
    let res: Response;
    if (request.wantSegments && !this.verboseRefused) {
      try { res = await this.send(request, 'verbose_json'); } catch (err) {
        // The replica's own server may only speak plain json: remember it and ask again without metadata.
        if (!(err instanceof DeploymentCallError) || err.gatewayCode !== 'error') throw err;
        this.verboseRefused = true;
        res = await this.send(request, 'json');
      }
    } else res = await this.send(request, 'json');
    const payload = await res.json() as { text?: string };
    const response: STTResponse = { text: payload.text ?? '', raw: payload, timing: { total_ms: Date.now() - t0 } };
    applyWhisperSegments(response, payload);
    return response;
  }
}

/** A voice of the replica's own catalog (`GET /refs/voices.json`, the parle Qwen3-TTS Base image). */
export interface ReplicaVoice { id: string; lang?: string; audio: string; text: string }
interface ReplicaCatalog { model?: string; format?: string; voices: ReplicaVoice[] }

const CATALOG_TTL_MS = 5 * 60_000;
const NO_CATALOG_TTL_MS = 15_000;

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
 *   same request parle's qwen-speech.ts builds, WITHOUT `voice` (vLLM-Omni would read it as a precomputed speaker).
 *   A voice missing from the catalog is never sent (code `voice_not_found` → fallback): it kills the vLLM-Omni engine.
 *   A replica without catalog (CustomVoice / OpenAI-shaped) gets the request as sent.
 * - Streaming: with `stream` and wav/pcm, asks for `stream: true, stream_format: "audio"` and returns the body as it
 *   arrives (first bytes before the whole sentence is synthesized).
 */
export class DeploymentTTSProvider extends DeploymentProviderBase implements TTSProvider {
  /** Last catalog seen (positive results only are kept for CATALOG_TTL_MS). */
  private catalog: { at: number; value: ReplicaCatalog } | null = null;
  /** A missing catalog is only trusted briefly: a 404 may just mean the replica's refs server is still starting. */
  private noCatalogUntil = 0;
  /** Set once this deployment showed a voice catalog: it is a Base (cloning) server for good. */
  private cloning = false;

  getVoices(): VoiceInfo[] { return (this.catalog?.value.voices ?? []).map(v => ({ id: v.id, name: v.id })); }

  /** True when the target model is a Qwen3-TTS Base (cloning) model, or the replica already showed a catalog. */
  private isCloningModel(model: string): boolean {
    return this.cloning || /(^|[-_/])base($|[-_.])/i.test(model);
  }

  /**
   * The replica's voice catalog, or null when the replica answered that it has none (404 / not JSON). A positive
   * answer is cached for CATALOG_TTL_MS; a negative one only for NO_CATALOG_TTL_MS, never as a long-lived fact.
   * Errors of the call itself (cold, unreachable, timeout) propagate and are not cached at all.
   */
  private async voiceCatalog(signal?: AbortSignal): Promise<ReplicaCatalog | null> {
    if (this.catalog && Date.now() - this.catalog.at < CATALOG_TTL_MS) return this.catalog.value;
    if (Date.now() < this.noCatalogUntil) return null;
    let value: ReplicaCatalog | null = null;
    try {
      const res = await this.call('/refs/voices.json', { method: 'GET' }, signal);
      // A body left unread would hold the replica's lease until its safety timeout (leasedBody): read or cancel it.
      if ((res.headers.get('content-type') ?? '').includes('json')) value = catalogOf(await res.json().catch(() => null));
      else await res.body?.cancel().catch(() => {});
    } catch (err) {
      // The replica answered an HTTP error for the catalog (callReplica code 'error'): treated as "no catalog" below.
      if (!(err instanceof DeploymentCallError) || err.gatewayCode !== 'error') throw err;
    }
    if (value) {
      this.catalog = { at: Date.now(), value };
      this.cloning = true;
    } else {
      this.noCatalogUntil = Date.now() + NO_CATALOG_TTL_MS;
    }
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
      if (!catalog && this.isCloningModel(request.model)) {
        // A Base server must never get `voice` without `ref_audio` (its engine dies on it): no catalog → fall back.
        throw new DeploymentCallError(503, `deployment '${this.deployment}': voice catalog unavailable, cannot clone '${request.voice}'`, 'catalog_unavailable');
      }
      const voice = catalog?.voices.find(v => v.id === request.voice);
      if (catalog && !voice) {
        // A Base replica with a voice it cannot clone: vLLM-Omni treats the id as a precomputed speaker and its engine
        // dies on the missing cache entry (measured 2026-10-05: "speaker 'x' was requested without ref_audio" took
        // stage-0 down for every later request). Never send it — fall back instead.
        throw new DeploymentCallError(404, `deployment '${this.deployment}': voice '${request.voice}' is not in the replica catalog`, 'voice_not_found');
      }
      if (voice) {
        // Cloning request exactly as parle's qwen-speech.ts sends it: no `voice` (it would be read as a speaker name).
        delete body.voice;
        Object.assign(body, {
          task_type: 'Base', ref_audio: voice.audio, ref_text: voice.text,
          ...(catalog?.model ? { model: catalog.model } : {}),
          ...(voice.lang && languageName(voice.lang) ? { language: languageName(voice.lang) } : {}),
        });
      }
    }
    // Explicit references from the client: same rule, `voice` would be read as a speaker name.
    if (extra.ref_audio !== undefined) delete body.voice;
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
    }, request.signal, 'tts');
    // vLLM-Omni answers some errors (and SSE events without stream_format) as JSON: that is not audio.
    if ((res.headers.get('content-type') ?? '').includes('json') || !res.body) {
      const text = await res.text().catch(() => '');
      throw new DeploymentCallError(502, `deployment '${this.deployment}' sent no audio: ${text.slice(0, 200)}`, 'error');
    }
    return res;
  }

  /**
   * Resolves as soon as the replica sends its response headers (= first byte), returning the body as a stream: the
   * gateway's per-attempt timeout then measures time-to-first-byte, not the whole synthesis.
   */
  async synthesize(request: TTSRequest): Promise<TTSResponse> {
    const res = await this.request(request);
    return { audio: Buffer.alloc(0), stream: res.body!, contentType: res.headers.get('content-type') ?? 'audio/wav' };
  }

  async synthesizeStream(request: TTSRequest): Promise<ReadableStream<Uint8Array>> {
    return (await this.request({ ...request, stream: true })).body!;
  }
}
