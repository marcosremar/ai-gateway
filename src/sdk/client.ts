/**
 * GatewaySDK — Typed HTTP client for the BabelCast AI Gateway REST API.
 *
 * Usage:
 *   import { GatewaySDK } from '@ai-gateway/sdk';
 *
 *   const gw = new GatewaySDK({ baseUrl: 'http://localhost:4000' });
 *   const { text } = await gw.transcribe(audioBuffer, 'fr');
 *   const { translatedText } = await gw.translate(text, 'fr', 'en');
 *   await gw.close();
 *
 * Mirror SDK: ai-gateway/sdk/python/gateway_sdk/client.py
 */

import type {
  GatewayConfig,
  TranscribeResponse,
  TranscribeOptions,
  TranslateResponse,
  PipelineResponse,
  PipelineOptions,
  GenerateAudioOptions,
  GenerateAudioResponse,
  ListVoicesResponse,
  GpuStatus,
  GpuOffer,
  GpuInstance,
  GpuEventLog,
  StopResumeResponse,
  DeployOptions,
  DeployResponse,
  ProviderConfig,
  ApiKeyInfo,
  BotDeployOptions,
  BotStatus,
  CreateProfileOptions,
  GpuReadinessStatus,
  GpuReadinessHistory,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ChatStreamChunk,
  EnsembleTranscribeResponse,
  EnsembleProviderResult,
  WorkloadInfo,
  WorkloadDeployOptions,
} from './types';
import { GatewayError } from './types';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
/** Groq model IDs used when the gateway is unreachable. */
const GROQ_FALLBACK_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_FALLBACK_LLM_MODEL = 'llama-3.3-70b-versatile';

const DEFAULT_TIMEOUTS = {
  stt: 15_000,
  translate: 15_000,
  pipeline: 30_000,
  tts: 30_000,
  health: 8_000,
  deploy: 30_000,
};

/** Default retry config for connection-level errors (gateway restart tolerance).
 *  Override per-instance via GatewayConfig.maxRetries / retryBackoffMs. */
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_BACKOFF_MS = [500, 1000, 2000, 4000];

/** Check if an error is a connection-level failure (retryable). */
function isRetryableError(err: unknown): boolean {
  // Timeouts (AbortError) are NOT retried — they indicate the server was reached but slow
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  // TypeError = network failure (ECONNREFUSED, DNS, etc.)
  if (err instanceof TypeError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // Match broader set of network error patterns case-insensitively
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network|failed to fetch/i.test(msg);
}

function validatePositiveInt(value: number, name: string, defaultVal: number, max = Infinity): number {
  if (!Number.isFinite(value) || value <= 0 || value > max) return defaultVal;
  return Math.floor(value);
}

/**
 * Extract the structured `{ code, retryable, message }` from a gateway error body
 * (#826). The gateway returns ErrorResponseSchema-shaped JSON; this surfaces the
 * code/retryable so the SDK's GatewayError carries them. Tolerant of non-JSON and
 * of both flat (`{code,...}`) and nested (`{error:{code,...}}`) shapes.
 *
 * Exported for unit testing without instantiating the client.
 */
export function parseGatewayErrorBody(body: string): { message?: string; code?: string; retryable?: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const o = parsed as Record<string, unknown>;
  const inner = (o.error && typeof o.error === 'object') ? (o.error as Record<string, unknown>) : o;
  const code = typeof o.code === 'string' ? o.code
    : typeof inner.code === 'string' ? inner.code
    : undefined;
  const retryable = typeof o.retryable === 'boolean' ? o.retryable
    : typeof inner.retryable === 'boolean' ? inner.retryable
    : undefined;
  const message = typeof inner.message === 'string' ? inner.message
    : typeof o.message === 'string' ? o.message
    : typeof o.error === 'string' ? o.error
    : undefined;
  return { message, code, retryable };
}

/**
 * Public, testable predicate for "is this error a retryable connection-level
 * failure?" (#885). Wraps the internal `isRetryableError` so consumers (and the
 * other SDKs) can align on one policy. ECONNREFUSED/ENOTFOUND/ECONNRESET/network
 * failures are retryable; timeouts and HTTP errors are not.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  return isRetryableError(err);
}

/**
 * Resolve a gateway base URL from the environment (#824), mirroring the CLI's
 * discovery: `AI_GATEWAY_URL` > `GATEWAY_URL` > `http://localhost:<PORT>` >
 * default `http://localhost:4000`. Lets the SDK be constructed zero-config via
 * `GatewaySDK.fromEnv()` instead of forcing every caller to pass `baseUrl`.
 */
export function resolveBaseUrlFromEnv(
  env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {}),
  defaultUrl = 'http://localhost:4000',
): string {
  if (env.AI_GATEWAY_URL?.trim()) return env.AI_GATEWAY_URL.trim();
  if (env.GATEWAY_URL?.trim()) return env.GATEWAY_URL.trim();
  if (env.PORT && /^\d+$/.test(env.PORT)) {
    return env.PORT === '4000' ? defaultUrl : `http://localhost:${env.PORT}`;
  }
  return defaultUrl;
}

/** A single parsed Prometheus sample. */
export interface PrometheusSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse Prometheus exposition text into structured samples (#838) so SDK callers
 * don't have to regex the raw metrics string. Skips `#` comment/HELP/TYPE lines
 * and blank lines; tolerates label sets and bare metrics. Unparseable lines are
 * skipped rather than throwing.
 */
export function parseMetrics(text: string): PrometheusSample[] {
  const out: PrometheusSample[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // name{label="v",...} value   |   name value
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+]+|[+-]?Inf|NaN)\s*$/);
    if (!m) continue;
    const [, name, labelBlock, rawValue] = m;
    const labels: Record<string, string> = {};
    if (labelBlock) {
      const inner = labelBlock.slice(1, -1);
      for (const pair of inner.match(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g) ?? []) {
        const lm = pair.match(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/);
        if (lm) labels[lm[1]] = lm[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    const value = rawValue === 'NaN' ? NaN
      : rawValue === '+Inf' || rawValue === 'Inf' ? Infinity
      : rawValue === '-Inf' ? -Infinity
      : Number(rawValue);
    out.push({ name, labels, value });
  }
  return out;
}

/**
 * Parse a single SSE `data:` line from a chat-completions stream into a
 * normalised chunk (#831). Returns `{ done: true }` for the `[DONE]` sentinel,
 * `null` for a non-`data:`/blank/malformed line (caller skips it), or a
 * `{ content?, usage? }` delta. Pure — no I/O — so the streaming logic is
 * unit-testable without a live SSE connection.
 */
export function parseSSEChunk(line: string): ChatStreamChunk | null {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(trimmed.indexOf(':') + 1).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { done: true };
  let obj: unknown;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const choices = Array.isArray(o.choices) ? (o.choices as Array<Record<string, unknown>>) : [];
  const delta = choices[0]?.delta as Record<string, unknown> | undefined;
  const content = typeof delta?.content === 'string' ? delta.content : undefined;
  const usageRaw = o.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
  const usage = usageRaw
    ? {
        promptTokens: usageRaw.prompt_tokens ?? 0,
        completionTokens: usageRaw.completion_tokens ?? 0,
        totalTokens: usageRaw.total_tokens ?? 0,
      }
    : undefined;
  if (content === undefined && usage === undefined) return null;
  return { content, usage };
}

/** A normalised SDK error shape (#825) that any of the divergent error classes
 *  (`errors/index.ts` GatewayError, `src/sdk` GatewayError, `sdk/node`
 *  GatewayHttpError) can be reduced to, so a consumer catching one can branch the
 *  same way regardless of which SDK threw. */
export interface NormalizedGatewayError {
  message: string;
  statusCode: number;
  endpoint?: string;
  code?: string;
  retryable?: boolean;
  isNetworkError: boolean;
}

/**
 * Normalise any of the three incompatible gateway error classes into one shape
 * (#825). Reads whichever of `statusCode`, `code`, `retryable`, `endpoint`,
 * `isNetworkError` the error happens to expose; falls back to sane defaults for a
 * plain `Error`. Pure — useful in catch blocks for cross-SDK error handling.
 */
export function normalizeGatewayError(err: unknown): NormalizedGatewayError {
  const e = (err && typeof err === 'object' ? (err as Record<string, unknown>) : {}) as Record<string, unknown>;
  const message = err instanceof Error ? err.message : typeof e.message === 'string' ? e.message : String(err);
  const statusCode = typeof e.statusCode === 'number' ? e.statusCode : 0;
  const endpoint = typeof e.endpoint === 'string' ? e.endpoint : undefined;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const retryable = typeof e.retryable === 'boolean' ? e.retryable : undefined;
  const isNetworkError = e.isNetworkError === true || statusCode === 0;
  return { message, statusCode, endpoint, code, retryable, isNetworkError };
}

/** Generate a short, collision-resistant request id (#837) for X-Request-ID. */
export function generateRequestId(): string {
  // Prefer crypto.randomUUID when available; fall back to time+random.
  const c = (typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto : undefined);
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** GPU statuses that are transient/in-progress and must NOT abort `waitForGpu`. */
const GPU_TRANSIENT_STATUSES: ReadonlySet<string> = new Set([
  'idle', 'creating', 'booting', 'installing', 'searching', 'queued',
]);

/** Validated `waitForGpu` polling parameters. */
export interface PollOptions {
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Validate/normalise `waitForGpu` polling params (#836) so a `0` interval can't
 * busy-loop and a non-finite timeout can't run forever. Clamps to sane defaults.
 */
export function validatePollOptions(
  pollIntervalMs: number | undefined,
  timeoutMs: number | undefined,
  defaults: PollOptions = { pollIntervalMs: 5_000, timeoutMs: 20 * 60_000 },
): PollOptions {
  return {
    pollIntervalMs: validatePositiveInt(pollIntervalMs ?? defaults.pollIntervalMs, 'pollIntervalMs', defaults.pollIntervalMs),
    timeoutMs: validatePositiveInt(timeoutMs ?? defaults.timeoutMs, 'timeoutMs', defaults.timeoutMs),
  };
}

/**
 * Decide what `waitForGpu` should do for a given status + how many polls have
 * elapsed (#829). Early `idle` (before the deploy state machine has flipped to a
 * boot phase) is treated as transient for the first few polls — mirrors the CLI's
 * `i > 2` grace window — so a deploy that briefly reports `idle` isn't reported as
 * "cancelled" spuriously.
 *
 * @returns `'ready'` | `'error'` | `'cancelled'` | `'wait'`
 */
export function classifyGpuPollState(status: string, pollCount: number, graceWindow = 2): 'ready' | 'error' | 'cancelled' | 'wait' {
  if (status === 'ready') return 'ready';
  if (status === 'error') return 'error';
  if (status === 'idle') {
    // Within the grace window an early idle is just "not started yet".
    return pollCount <= graceWindow ? 'wait' : 'cancelled';
  }
  if (GPU_TRANSIENT_STATUSES.has(status)) return 'wait';
  // Unknown status — keep waiting rather than aborting.
  return 'wait';
}

export class GatewaySDK {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeouts: Required<NonNullable<GatewayConfig['timeouts']>>;
  private readonly groqApiKey: string;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number[];
  private readonly emitRequestId: boolean;
  private _lastRequestId: string | undefined;
  private _closed = false;

  /**
   * Construct an SDK from the environment (#824), mirroring the CLI's discovery
   * (`AI_GATEWAY_URL`/`GATEWAY_URL`/`PORT`). Zero-config parity with the CLI:
   *   const gw = GatewaySDK.fromEnv();
   * Any explicit field in `overrides` wins over the env-derived baseUrl.
   */
  static fromEnv(overrides: Partial<GatewayConfig> = {}): GatewaySDK {
    const env = typeof process !== 'undefined' ? process.env : {};
    return new GatewaySDK({
      baseUrl: overrides.baseUrl ?? resolveBaseUrlFromEnv(env),
      apiKey: overrides.apiKey ?? env.AIGW_APP_KEY ?? env.AI_GATEWAY_KEY ?? env.GATEWAY_API_KEY,
      ...overrides,
    });
  }

  constructor(config: GatewayConfig) {
    if (!config.baseUrl) {
      throw new TypeError('GatewaySDK: baseUrl is required');
    }
    let baseUrl = config.baseUrl.trim();
    if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) {
      throw new TypeError(`GatewaySDK: invalid baseUrl "${baseUrl}" - must be a valid HTTP(S) URL`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.headers = config.apiKey
      ? { Authorization: `Bearer ${config.apiKey}` }
      : {};
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
    this.groqApiKey = config.groqApiKey ?? (typeof process !== 'undefined' ? (process.env.GROQ_API_KEY ?? '') : '');
    // Retry tuning — clamp to non-negative integer; fall back to defaults on bad input.
    this.maxRetries = Number.isFinite(config.maxRetries) && (config.maxRetries as number) >= 0
      ? Math.floor(config.maxRetries as number)
      : DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = Array.isArray(config.retryBackoffMs) && config.retryBackoffMs.length > 0
      ? config.retryBackoffMs
      : DEFAULT_RETRY_BACKOFF_MS;
    // #837 — emit X-Request-ID by default for log cross-correlation.
    this.emitRequestId = config.requestId !== false;
  }

  /** The X-Request-ID of the most recent request (#837), or undefined if none
   *  has been sent / request-id emission is disabled. */
  lastRequestId(): string | undefined {
    return this._lastRequestId;
  }

  // ── Inference ───────────────────────────────────────────────────────────

  /** Transcribe audio to text (GPU-aware: gateway routes to GPU or cloud).
   *  Falls back to Groq Whisper directly when the gateway is unreachable.
   *  @param options.ensemble — race multiple STT providers, return best result */
  async transcribe(audio: Uint8Array, languageOrOpts: string | TranscribeOptions = 'fr', prompt = ''): Promise<TranscribeResponse> {
    const opts: TranscribeOptions = typeof languageOrOpts === 'string'
      ? { language: languageOrOpts, prompt }
      : languageOrOpts;
    const language = opts.language ?? 'fr';
    const params = new URLSearchParams({ language });
    if (opts.prompt) params.set('prompt', opts.prompt);
    const endpoint = opts.ensemble ? '/v1/transcribe/ensemble' : '/v1/transcribe';
    try {
      const res = await this.fetch(`${endpoint}?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: audio,
        timeout: this.timeouts.stt,
      });
      const data = await this.parseJson(res, endpoint);
      return { text: (data.text as string) ?? '', usedGpu: (data.used_gpu as boolean) ?? false };
    } catch (err) {
      if (err instanceof GatewayError && err.isNetworkError && this.groqApiKey) {
        return this.groqTranscribeFallback(audio, language, opts.prompt ?? '');
      }
      throw err;
    }
  }

  /** Send a chat completion request through the gateway.
   *  Falls back to Groq directly when the gateway is unreachable.
   *  Pass `options.signal` to cancel a long-running call (#840). */
  async chat(messages: ChatMessage[], options: ChatCompletionOptions & { signal?: AbortSignal } = {}): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: options.model ?? GROQ_FALLBACK_LLM_MODEL,
      messages,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    try {
      const res = await this.fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: this.timeouts.translate,
        signal: options.signal,
      });
      const data = await this.parseJson(res, '/v1/chat/completions');
      const choices = (data.choices as Array<{ message: { content: string } }>) ?? [];
      const content = choices[0]?.message?.content ?? '';
      const usage = data.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
      return {
        content,
        model: (data.model as string) ?? (options.model ?? GROQ_FALLBACK_LLM_MODEL),
        usage: usage ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        } : undefined,
      };
    } catch (err) {
      if (err instanceof GatewayError && err.isNetworkError && this.groqApiKey) {
        return this.groqChatFallback(messages, options);
      }
      throw err;
    }
  }

  /**
   * Stream a chat completion token-by-token (#831) — an async-iterator so SDK
   * consumers get the same streaming UX as the CLI. Yields `ChatStreamChunk`s
   * with incremental `content` (and a final `usage`/`done` chunk). Pass
   * `options.signal` to cancel mid-stream (#840).
   *
   * @example
   * for await (const c of gw.chatStream(msgs)) process.stdout.write(c.content ?? '');
   */
  async *chatStream(
    messages: ChatMessage[],
    options: ChatCompletionOptions & { signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const body: Record<string, unknown> = {
      model: options.model ?? GROQ_FALLBACK_LLM_MODEL,
      messages,
      stream: true,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    const res = await this.fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.translate,
      signal: options.signal,
    });
    // Some gateways ignore `stream:true` and return a buffered JSON response —
    // surface it as a single chunk so callers don't silently get nothing.
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const data = await this.parseJson(res, '/v1/chat/completions');
      const choices = (data.choices as Array<{ message?: { content?: string } }>) ?? [];
      const content = choices[0]?.message?.content;
      if (content) yield { content };
      yield { done: true };
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) { yield { done: true }; return; }
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const chunk = parseSSEChunk(line);
        if (chunk) yield chunk;
      }
    }
    const tail = parseSSEChunk(buf);
    if (tail) yield tail;
  }

  /**
   * Ensemble transcription (#877) — race multiple STT providers and return the
   * consensus plus per-provider results (and optional LLM correction). Richer
   * than `transcribe(audio,{ensemble:true})`, which only returns flat text;
   * mirrors the Python SDK's `transcribe_ensemble`.
   *
   * @param options.llmCorrect run an LLM pass to fix names/obvious errors (~+300ms)
   */
  async transcribeEnsemble(
    audio: Uint8Array,
    options: { language?: string; prompt?: string; llmCorrect?: boolean; signal?: AbortSignal } = {},
  ): Promise<EnsembleTranscribeResponse> {
    const params = new URLSearchParams({ language: options.language ?? 'fr' });
    if (options.prompt) params.set('prompt', options.prompt);
    if (options.llmCorrect) params.set('llm_correct', 'true');
    const endpoint = '/v1/transcribe/ensemble';
    const res = await this.fetch(`${endpoint}?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audio,
      timeout: this.timeouts.stt,
      signal: options.signal,
    });
    const data = await this.parseJson(res, endpoint);
    // Normalise the provider map (object keyed by provider) into our typed shape.
    const providers: Record<string, EnsembleProviderResult> = {};
    const rawProviders = data.providers;
    if (rawProviders && typeof rawProviders === 'object' && !Array.isArray(rawProviders)) {
      for (const [name, v] of Object.entries(rawProviders as Record<string, unknown>)) {
        const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
        providers[name] = {
          provider: name,
          text: typeof o.text === 'string' ? o.text : '',
          latencyMs: typeof o.latencyMs === 'number' ? o.latencyMs
            : typeof o.latency_ms === 'number' ? o.latency_ms : undefined,
        };
      }
    }
    return {
      consensus: (data.consensus as string) ?? (data.text as string) ?? '',
      providers,
      usedProviders: (data.used_providers as number) ?? Object.keys(providers).length,
      latencyMs: (data.latency_ms as number) ?? 0,
      corrected: typeof data.corrected === 'string' && data.corrected ? data.corrected : undefined,
      correctionApplied: (data.correction_applied as boolean) ?? false,
    };
  }

  /** Translate text (GPU-aware: gateway routes to GPU or cloud LLM). */
  async translate(text: string, sourceLang: string, targetLang: string, glossary = ''): Promise<TranslateResponse> {
    if (!text.trim()) return { translatedText: '', usedGpu: false };
    const body: Record<string, string> = { text, source_lang: sourceLang, target_lang: targetLang };
    if (glossary) body.glossary = glossary;
    const res = await this.fetch('/v1/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.translate,
    });
    const data = await this.parseJson(res, '/v1/translate');
    return { translatedText: (data.translated_text as string) ?? '', usedGpu: (data.used_gpu as boolean) ?? false };
  }

  /** Full pipeline: audio → STT → LLM → TTS (GPU-aware routing).
   *  Pass `options.signal` to cancel a long-running call (#840). */
  async pipeline(audio: Uint8Array, options: PipelineOptions & { signal?: AbortSignal } = {}): Promise<PipelineResponse> {
    const params = new URLSearchParams();
    params.set('source', options.source ?? 'fr');
    params.set('target', options.target ?? 'en');
    if (options.speaker) params.set('speaker', options.speaker);
    const qs = params.toString();

    const res = await this.fetch(`/v1/speech${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: audio,
      timeout: this.timeouts.pipeline,
      signal: options.signal,
    });
    const data = await this.parseJson(res, '/v1/speech');
    const timing = data.timing as Record<string, unknown> | undefined;
    // #828 — surface per-stage timings (stt_ms/llm_ms/tts_ms) when present so
    // latency debugging works from this client, not just totalMs.
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    return {
      transcription: (data.transcription as string) ?? '',
      response: (data.response as string) ?? '',
      audioBase64: (data.audio_base64 as string) ?? '',
      contentType: (data.content_type as string) ?? '',
      timing: {
        totalMs: (timing?.total_ms as number) ?? 0,
        usedGpu: (timing?.used_gpu as boolean) ?? false,
        sttMs: num(timing?.stt_ms),
        llmMs: num(timing?.llm_ms),
        ttsMs: num(timing?.tts_ms),
      },
    };
  }

  /** Generate speech from text via the GPU pod's TTS engine. Returns WAV bytes.
   *
   * @example
   * const { audio } = await gw.generateAudio('Hello world', { speaker: 'Ryan', speed: 0.9 });
   * await Bun.write('out.wav', audio);
   */
  async generateAudio(text: string, options: GenerateAudioOptions = {}): Promise<GenerateAudioResponse> {
    const body: Record<string, unknown> = {
      text,
      speaker: options.speaker ?? 'Ryan',
      language: options.language ?? 'English',
    };
    if (options.speed !== undefined && options.speed !== 1.0) body.speed = options.speed;
    const res = await this.fetch('/v1/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.tts,
    });
    let audio: Uint8Array;
    try {
      const buf = await res.arrayBuffer();
      audio = new Uint8Array(buf);
    } catch (err) {
      throw new GatewayError(
        `Failed to read audio response: ${err instanceof Error ? err.message : String(err)}`,
        res.status,
        '/v1/tts/preview',
      );
    }
    return { audio, contentType: 'audio/wav', usedGpu: true };
  }

  /** List available preset TTS voices. */
  async listVoices(): Promise<ListVoicesResponse> {
    const res = await this.fetch('/v1/tts/voices', {
      method: 'GET',
      timeout: this.timeouts.health,
    });
    const data = await this.parseJson(res, '/v1/tts/voices');
    return { voices: (data.voices as ListVoicesResponse['voices']) ?? [] };
  }

  // ── GPU management ──────────────────────────────────────────────────────

  /** Deploy a GPU pod (non-blocking — returns immediately, poll gpuStatus()).
   *  Pass `maxCostUsd` to cap the hourly spend — the gateway rejects the deploy
   *  if the cheapest matching offer exceeds it. */
  async deployGpu(options: DeployOptions): Promise<DeployResponse> {
    if (!options.apiKey?.trim()) {
      throw new TypeError('deployGpu: options.apiKey is required');
    }
    if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)) {
      throw new TypeError('deployGpu: maxCostUsd must be a positive number');
    }
    const body: Record<string, unknown> = {
      apiKey: options.apiKey,
      dockerImage: options.dockerImage,
      gpuTypes: options.gpuTypes,
    };
    if (options.region !== undefined) body.region = options.region;
    if (options.maxCostUsd !== undefined) body.maxCostUsd = options.maxCostUsd;
    if (options.containerDiskInGb !== undefined) body.containerDiskInGb = options.containerDiskInGb;
    if (options.interruptible !== undefined) body.interruptible = options.interruptible;
    const res = await this.fetch('/v1/gpu/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.deploy,
      allowedStatuses: [202, 409], // 409 = deploy already in progress
    });
    const data = await this.parseJson(res, '/v1/gpu/deploy');
    return { deployId: (data.deployId as string) ?? '', status: (data.status as string) ?? '', message: (data.message as string) ?? '' };
  }

  /** Get current GPU deployment status, health, and active tier. */
  async gpuStatus(): Promise<GpuStatus> {
    const res = await this.fetch('/v1/gpu/status', {
      method: 'GET',
      timeout: this.timeouts.health,
    });
    const d = await this.parseJson(res, '/v1/gpu/status');
    return {
      status: (d.status as GpuStatus['status']) ?? 'idle',
      deployId: (d.deployId as string) ?? '',
      podId: (d.podId as string) ?? '',
      endpoint: (d.endpoint as string) ?? '',
      gpuType: (d.gpuType as string) ?? '',
      message: (d.message as string) ?? '',
      step: (d.step as string) ?? '',
      stepDetail: (d.stepDetail as string) ?? '',
      gpuHealthy: (d.gpuHealthy as boolean) ?? false,
      activeTier: (d.activeTier as GpuStatus['activeTier']) ?? 'cloud',
      idleSec: (d.idleSec as number) ?? 0,
      idleTimeoutSec: (d.idleTimeoutSec as number) ?? 0,
      elapsedSec: (d.elapsedSec as number) ?? 0,
      startedAt: (d.startedAt as number) ?? 0,
      retryCount: (d.retryCount as number) ?? 0,
    };
  }

  /** Terminate the GPU pod. */
  async terminateGpu(apiKey: string): Promise<void> {
    await this.fetch('/v1/gpu/terminate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
      timeout: this.timeouts.deploy,
    });
  }

  /** Wait for GPU to reach 'ready' status (polls gpuStatus).
   *  Validates poll params (#836) and applies a grace window for an early `idle`
   *  status (#829) so a just-started deploy isn't reported as cancelled. */
  async waitForGpu(pollIntervalMs = 5_000, timeoutMs = 20 * 60_000): Promise<GpuStatus> {
    const poll = validatePollOptions(pollIntervalMs, timeoutMs);
    const start = Date.now();
    let pollCount = 0;
    while (Date.now() - start < poll.timeoutMs) {
      const status = await this.gpuStatus();
      pollCount++;
      const decision = classifyGpuPollState(status.status, pollCount);
      if (decision === 'ready') return status;
      if (decision === 'error') throw new GatewayError(status.message, 0, '/v1/gpu/status');
      if (decision === 'cancelled') throw new GatewayError('Deploy cancelled', 0, '/v1/gpu/status');
      await new Promise(r => setTimeout(r, poll.pollIntervalMs));
    }
    throw new GatewayError(`GPU deploy timed out after ${Math.round(poll.timeoutMs / 60_000)} min`, 0, '/v1/gpu/status');
  }

  // ── GPU extended ────────────────────────────────────────────────────────

  /** Stop (pause) the GPU pod — preserves disk, no charges. */
  async stopGpu(): Promise<StopResumeResponse> {
    const res = await this.fetch('/v1/gpu/stop', { method: 'POST', timeout: this.timeouts.deploy });
    return await this.parseJson(res, '/v1/gpu/stop') as unknown as StopResumeResponse;
  }

  /** Resume a previously stopped GPU pod. */
  async resumeGpu(podId?: string, provider?: string): Promise<StopResumeResponse> {
    const body: Record<string, string> = {};
    if (podId) body.podId = podId;
    if (provider) body.provider = provider;
    const res = await this.fetch('/v1/gpu/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.deploy,
    });
    return await this.parseJson(res, '/v1/gpu/resume') as unknown as StopResumeResponse;
  }

  /** List available GPU offers from providers (sorted by price). */
  async gpuOffers(): Promise<GpuOffer[]> {
    const res = await this.fetch('/v1/gpu/offers', { method: 'GET', timeout: this.timeouts.deploy });
    const data = await this.parseJson(res, '/v1/gpu/offers');
    return (data.offers as GpuOffer[]) ?? [];
  }

  /** List verified GPU types. */
  async gpuTypes(): Promise<Record<string, unknown>[]> {
    const res = await this.fetch('/v1/gpu/types', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/types');
    return (data.types ?? data) as Record<string, unknown>[];
  }

  /** List all active GPU instances across providers. */
  async gpuList(): Promise<GpuInstance[]> {
    const res = await this.fetch('/v1/gpu/list', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/list');
    return (data.instances ?? data) as GpuInstance[];
  }

  /** Fetch GPU deployment logs (container stdout from running pod). Pass `filter` to grep-filter lines. Default max 512KB response. */
  async gpuLogs(filter?: string, maxBytes = 512 * 1024): Promise<string> {
    const qs = filter ? `?filter=${encodeURIComponent(filter)}` : '';
    const res = await this.fetch(`/v1/gpu/logs${qs}`, { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/logs');
    const logs = (data.logs as string) ?? '';
    return logs.slice(0, maxBytes);
  }

  /** Fetch persistent GPU event logs (JSONL file-based). */
  async gpuEventLogs(lines = 100): Promise<GpuEventLog> {
    const res = await this.fetch(`/v1/gpu/logs/events?lines=${lines}`, { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/logs/events') as unknown as GpuEventLog;
  }

  /** Get GPU catalog (available Docker images). */
  async gpuCatalog(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/gpu/catalog', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/catalog') as Record<string, unknown>;
  }

  /** Get gateway's geographic location. */
  async gpuMyLocation(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/gpu/my-location', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/my-location') as Record<string, unknown>;
  }

  /** Get GPU host reputation scores. */
  async gpuReputation(): Promise<Record<string, unknown>[]> {
    const res = await this.fetch('/v1/gpu/reputation', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/reputation');
    return (data.reputations ?? data) as Record<string, unknown>[];
  }

  // ── Vast.ai Templates ──────────────────────────────────────────────────

  /** List all Vast.ai templates on the account. */
  async vastListTemplates(): Promise<Array<{ hashId: string; id: number; name: string; image: string; tag?: string }>> {
    const res = await this.fetch('/v1/gpu/vast/templates', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/vast/templates');
    return (data.templates ?? []) as Array<{ hashId: string; id: number; name: string; image: string; tag?: string }>;
  }

  /** Create a Vast.ai template. Returns the template's hash_id for use in deployments. */
  async vastCreateTemplate(spec: {
    name: string;
    image: string;
    tag?: string;
    envVars?: Record<string, string>;
    exposePorts?: number[];
    onstartCmd?: string;
    diskSpaceGb?: number;
  }): Promise<{ hashId: string; id: number }> {
    const res = await this.fetch('/v1/gpu/vast/templates', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/templates') as { hashId: string; id: number };
  }

  /** Update an existing Vast.ai template. */
  async vastUpdateTemplate(hashId: string, updates: { name?: string; image?: string; tag?: string; diskSpaceGb?: number; desc?: string }): Promise<{ hashId: string; id: number }> {
    const res = await this.fetch('/v1/gpu/vast/templates', {
      method: 'PUT', timeout: this.timeouts.deploy,
      body: JSON.stringify({ hashId, ...updates }),
    });
    return await this.parseJson(res, '/v1/gpu/vast/templates') as { hashId: string; id: number };
  }

  /** Delete a Vast.ai template by numeric ID. */
  async vastDeleteTemplate(templateId: number): Promise<void> {
    await this.fetch(`/v1/gpu/vast/templates?id=${templateId}`, { method: 'DELETE', timeout: this.timeouts.deploy });
  }

  /** Idempotent: find existing template by name+image or create one. */
  async vastFindOrCreateTemplate(spec: {
    name: string;
    image: string;
    tag?: string;
    envVars?: Record<string, string>;
    exposePorts?: number[];
    onstartCmd?: string;
    diskSpaceGb?: number;
  }): Promise<{ hashId: string; id: number; created: boolean }> {
    const res = await this.fetch('/v1/gpu/vast/templates/find-or-create', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/templates/find-or-create') as { hashId: string; id: number; created: boolean };
  }

  // ── Vast.ai Serverless Endpoints ────────────────────────────────────────

  /** List all serverless endpoints on the Vast.ai account. */
  async vastListEndpoints(): Promise<Array<{ id: number; name: string; apiKey: string; state: string; minLoad: number; targetUtil: number; coldWorkers: number; maxWorkers: number; createdAt: string }>> {
    const res = await this.fetch('/v1/gpu/vast/endpoints', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/vast/endpoints');
    return (data.endpoints ?? []) as Array<{ id: number; name: string; apiKey: string; state: string; minLoad: number; targetUtil: number; coldWorkers: number; maxWorkers: number; createdAt: string }>;
  }

  /** Create a Vast.ai serverless endpoint. Add worker groups via vastCreateWorkerGroup(). */
  async vastCreateEndpoint(spec: { name: string; minLoad?: number; targetUtil?: number; coldMult?: number; coldWorkers?: number; maxWorkers?: number }): Promise<{ id: number; name: string }> {
    const res = await this.fetch('/v1/gpu/vast/endpoints', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/endpoints') as { id: number; name: string };
  }

  /** Delete a Vast.ai serverless endpoint and all its workers. */
  async vastDeleteEndpoint(endpointId: number): Promise<{ deletedWorkers: number[]; failedWorkers: number[] }> {
    const res = await this.fetch(`/v1/gpu/vast/endpoints?id=${endpointId}`, { method: 'DELETE', timeout: this.timeouts.deploy });
    return await this.parseJson(res, '/v1/gpu/vast/endpoints') as { deletedWorkers: number[]; failedWorkers: number[] };
  }

  /** Get logs from a Vast.ai serverless endpoint. Requires endpoint's own API key. */
  async vastGetEndpointLogs(endpointName: string, endpointApiKey: string, lines = 100): Promise<string> {
    const res = await this.fetch('/v1/gpu/vast/endpoints/logs', {
      method: 'POST', timeout: this.timeouts.health,
      body: JSON.stringify({ endpointName, endpointApiKey, lines }),
    });
    const data = await this.parseJson(res, '/v1/gpu/vast/endpoints/logs');
    return (data.logs as string) ?? '';
  }

  /**
   * Route an inference request to the least-loaded worker in a Vast.ai serverless endpoint.
   * Returns the worker URL, or null if no worker is available (cold start in progress).
   * Requires endpoint's own API key (from vastListEndpoints()).
   */
  async vastRouteRequest(endpointName: string, endpointApiKey: string, cost = 100): Promise<{ url: string; reqnum: number; signature: string; requestId: string } | null> {
    const validatedCost = validatePositiveInt(cost, 'cost', 100, 100000);
    const res = await this.fetch('/v1/gpu/vast/endpoints/route', {
      method: 'POST', timeout: 10_000,
      body: JSON.stringify({ endpointName, endpointApiKey, cost: validatedCost }),
    });
    const data = await this.parseJson(res, '/v1/gpu/vast/endpoints/route') as { available: boolean; url?: string; reqnum?: number; signature?: string; requestId?: string };
    if (!data.available || !data.url) return null;
    return { url: data.url, reqnum: data.reqnum ?? 0, signature: data.signature ?? '', requestId: data.requestId ?? '' };
  }

  // ── Vast.ai Worker Groups ───────────────────────────────────────────────

  /** List all worker groups on the Vast.ai account. */
  async vastListWorkerGroups(): Promise<Array<{ id: number; endpointId: number; endpointName: string; templateHash: string; gpuRamGb: number; maxWorkers: number; createdAt: string }>> {
    const res = await this.fetch('/v1/gpu/vast/workergroups', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/gpu/vast/workergroups');
    return (data.workerGroups ?? []) as Array<{ id: number; endpointId: number; endpointName: string; templateHash: string; gpuRamGb: number; maxWorkers: number; createdAt: string }>;
  }

  /** Create a worker group for a serverless endpoint. */
  async vastCreateWorkerGroup(spec: { endpointId?: number; endpointName?: string; templateHash?: string; searchParams?: string; gpuRamGb?: number; maxWorkers?: number; coldWorkers?: number }): Promise<{ id: number }> {
    const res = await this.fetch('/v1/gpu/vast/workergroups', {
      method: 'POST', timeout: this.timeouts.deploy,
      body: JSON.stringify(spec),
    });
    return await this.parseJson(res, '/v1/gpu/vast/workergroups') as { id: number };
  }

  /** Update a worker group's scaling params or GPU filter. */
  async vastUpdateWorkerGroup(id: number, updates: { minLoad?: number; targetUtil?: number; templateHash?: string; searchParams?: string; gpuRamGb?: number; maxWorkers?: number }): Promise<void> {
    await this.fetch('/v1/gpu/vast/workergroups', {
      method: 'PUT', timeout: this.timeouts.deploy,
      body: JSON.stringify({ id, ...updates }),
    });
  }

  /** Delete a worker group and stop its workers. */
  async vastDeleteWorkerGroup(id: number): Promise<{ deletedWorkers: number[]; failedWorkers: number[] }> {
    const res = await this.fetch(`/v1/gpu/vast/workergroups?id=${id}`, { method: 'DELETE', timeout: this.timeouts.deploy });
    return await this.parseJson(res, '/v1/gpu/vast/workergroups') as { deletedWorkers: number[]; failedWorkers: number[] };
  }

  // ── Config ─────────────────────────────────────────────────────────────

  /** Get provider configuration (STT/LLM/TTS chains). */
  async getProviderConfig(): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/providers', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/config/providers') as ProviderConfig;
  }

  /** Update provider configuration. */
  async setProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
    await this.fetch('/v1/config/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
      timeout: this.timeouts.health,
    });
  }

  /** Get configured API keys (masked). */
  async getApiKeys(): Promise<ApiKeyInfo[]> {
    const res = await this.fetch('/v1/config/api-keys', { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/config/api-keys');
    return (data.keys ?? data) as ApiKeyInfo[];
  }

  /** Update API keys. */
  async setApiKeys(keys: Record<string, string>): Promise<void> {
    await this.fetch('/v1/config/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys),
      timeout: this.timeouts.health,
    });
  }

  /** Get labs feature flags. */
  async getLabsFlags(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/config/labs', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/config/labs') as Record<string, unknown>;
  }

  /** Update labs feature flags. */
  async setLabsFlags(flags: Record<string, unknown>): Promise<void> {
    await this.fetch('/v1/config/labs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flags),
      timeout: this.timeouts.health,
    });
  }

  // ── Profiles ───────────────────────────────────────────────────────────

  /** Create or update a provider profile. */
  async createProfile(profile: CreateProfileOptions): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/config/profiles') as ProviderConfig;
  }

  /** Delete a provider profile. */
  async deleteProfile(id: string): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/profiles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/config/profiles') as ProviderConfig;
  }

  /** Activate a profile (copy its chains to top-level config). Pass null to deactivate. */
  async activateProfile(id: string | null): Promise<ProviderConfig> {
    const res = await this.fetch('/v1/config/profiles/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/config/profiles/activate') as ProviderConfig;
  }

  // ── GPU Readiness ──────────────────────────────────────────────────────

  /** Get GPU readiness status (benchmark state, P95 latencies, production flag). */
  async gpuReadinessStatus(): Promise<GpuReadinessStatus> {
    const res = await this.fetch('/v1/gpu/readiness/status', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/readiness/status') as GpuReadinessStatus;
  }

  /** Get GPU readiness history (state transitions over time). */
  async gpuReadinessHistory(): Promise<GpuReadinessHistory> {
    const res = await this.fetch('/v1/gpu/readiness/history', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/readiness/history') as unknown as GpuReadinessHistory;
  }

  /** Reset GPU readiness tracking (clears benchmarks, restarts readiness check). */
  async resetGpuReadiness(): Promise<{ ok: boolean; message: string }> {
    const res = await this.fetch('/v1/gpu/readiness/reset', { method: 'POST', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/gpu/readiness/reset') as { ok: boolean; message: string };
  }

  // ── Inference extended ─────────────────────────────────────────────────

  /** Preview TTS with specific voice and speed. Returns WAV audio. */
  async ttsPreview(text: string, options: GenerateAudioOptions = {}): Promise<GenerateAudioResponse> {
    const body: Record<string, unknown> = { text, ...options };
    const res = await this.fetch('/v1/tts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: this.timeouts.tts,
    });
    let audio: Uint8Array;
    try {
      const buf = await res.arrayBuffer();
      audio = new Uint8Array(buf);
    } catch (err) {
      throw new GatewayError(
        `Failed to read audio response: ${err instanceof Error ? err.message : String(err)}`,
        res.status,
        '/v1/tts/preview',
      );
    }
    return { audio, contentType: 'audio/wav', usedGpu: true };
  }

  /** Auto-detect input language. */
  async detectLanguage(text: string): Promise<{ language: string; confidence: number }> {
    const res = await this.fetch('/v1/detect-language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/detect-language') as { language: string; confidence: number };
  }

  // ── Bot ────────────────────────────────────────────────────────────────

  /** Deploy a meeting bot instance. */
  async deployBot(options: BotDeployOptions): Promise<BotStatus> {
    const res = await this.fetch('/v1/bot/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      timeout: this.timeouts.deploy,
    });
    return await this.parseJson(res, '/v1/bot/deploy') as BotStatus;
  }

  /** Get bot deployment status. */
  async botStatus(): Promise<BotStatus> {
    const res = await this.fetch('/v1/bot/status', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/bot/status') as BotStatus;
  }

  /** Bot joins meeting. */
  async botJoin(meetingUrl: string): Promise<void> {
    await this.fetch('/v1/bot/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingUrl }),
      timeout: this.timeouts.deploy,
    });
  }

  /** Bot leaves meeting. */
  async botLeave(): Promise<void> {
    await this.fetch('/v1/bot/leave', { method: 'POST', timeout: this.timeouts.health });
  }

  /** Terminate bot pod. */
  async botTerminate(): Promise<void> {
    await this.fetch('/v1/bot/terminate', { method: 'POST', timeout: this.timeouts.deploy });
  }

  // ── Workloads ──────────────────────────────────────────────────────────

  /** List all workloads, optionally filtered by type and paginated. */
  async listWorkloads(options?: { type?: WorkloadInfo['type']; limit?: number; offset?: number }): Promise<{ workloads: WorkloadInfo[]; total: number; limit: number; offset: number }> {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const qs = params.toString();
    const res = await this.fetch(`/v1/workloads${qs ? `?${qs}` : ''}`, { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/workloads');
    return {
      workloads: (data.workloads ?? []) as WorkloadInfo[],
      total: (data.total as number) ?? 0,
      limit: (data.limit as number) ?? 100,
      offset: (data.offset as number) ?? 0,
    };
  }

  /**
   * Auto-iterate every workload across pages (#832) so callers don't have to
   * manage `limit`/`offset` themselves. Walks pages until `offset + returned >=
   * total` (or a short page is returned), guarding against an infinite loop when
   * the server reports an inconsistent `total`.
   *
   * @example for await (const w of gw.listAllWorkloads()) console.log(w.id);
   */
  async *listAllWorkloads(
    options?: { type?: WorkloadInfo['type']; pageSize?: number },
  ): AsyncGenerator<WorkloadInfo, void, unknown> {
    const pageSize = validatePositiveInt(options?.pageSize ?? 100, 'pageSize', 100);
    let offset = 0;
    // Hard cap on iterations as a belt-and-braces guard against a bad `total`.
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await this.listWorkloads({ type: options?.type, limit: pageSize, offset });
      for (const w of page.workloads) yield w;
      offset += page.workloads.length;
      // Stop on a short/empty page or once we've covered the reported total.
      if (page.workloads.length === 0 || page.workloads.length < pageSize) return;
      if (page.total > 0 && offset >= page.total) return;
    }
  }

  /** Deploy a new workload (GPU, bot, or database). */
  async deployWorkload(options: WorkloadDeployOptions): Promise<WorkloadInfo> {
    const res = await this.fetch('/v1/workloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      timeout: this.timeouts.deploy,
      allowedStatuses: [201],
    });
    return await this.parseJson(res, '/v1/workloads') as unknown as WorkloadInfo;
  }

  /** Get status of a specific workload. */
  async workloadStatus(id: string): Promise<WorkloadInfo> {
    const res = await this.fetch(`/v1/workloads/${id}`, { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, `/v1/workloads/${id}`) as unknown as WorkloadInfo;
  }

  /** Stop (pause) a workload. */
  async stopWorkload(id: string): Promise<WorkloadInfo> {
    const res = await this.fetch(`/v1/workloads/${id}/stop`, { method: 'POST', timeout: this.timeouts.deploy });
    return await this.parseJson(res, `/v1/workloads/${id}/stop`) as unknown as WorkloadInfo;
  }

  /** Start / resume a stopped workload. */
  async startWorkload(id: string): Promise<WorkloadInfo> {
    const res = await this.fetch(`/v1/workloads/${id}/start`, { method: 'POST', timeout: this.timeouts.deploy });
    return await this.parseJson(res, `/v1/workloads/${id}/start`) as unknown as WorkloadInfo;
  }

  /** Terminate (destroy) a workload permanently. */
  async terminateWorkload(id: string): Promise<void> {
    await this.fetch(`/v1/workloads/${id}`, { method: 'DELETE', timeout: this.timeouts.deploy });
  }

  // ── Diagnostics ────────────────────────────────────────────────────────

  /** Get request history/log. */
  async requestLog(limit = 50): Promise<Record<string, unknown>[]> {
    const res = await this.fetch(`/v1/requests/log?limit=${limit}`, { method: 'GET', timeout: this.timeouts.health });
    const data = await this.parseJson(res, '/v1/requests/log');
    return (data.requests ?? data) as Record<string, unknown>[];
  }

  /** Get Prometheus-style metrics. Default max 1MB response. */
  async metrics(maxBytes = 1024 * 1024): Promise<string> {
    const res = await this.fetch('/metrics', { method: 'GET', timeout: this.timeouts.health });
    const text = await res.text();
    return text.slice(0, maxBytes);
  }

  /** Get metrics parsed into structured samples (#838) so callers don't have to
   *  regex the Prometheus text themselves. */
  async metricsJson(maxBytes = 1024 * 1024): Promise<PrometheusSample[]> {
    return parseMetrics(await this.metrics(maxBytes));
  }

  /** Get service statistics. */
  async serviceStats(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/service-stats', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/v1/service-stats') as Record<string, unknown>;
  }

  /** Inspect Docker image metadata from Docker Hub. */
  async dockerInspect(imageName: string): Promise<Record<string, unknown>> {
    const res = await this.fetch('/v1/docker/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageName }),
      timeout: this.timeouts.health,
    });
    return await this.parseJson(res, '/v1/docker/inspect') as Record<string, unknown>;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  /** Check if the gateway is reachable. */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetch('/health', { method: 'GET', timeout: this.timeouts.health });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** Get detailed health info (providers, GPU state, uptime). */
  async healthDetail(): Promise<Record<string, unknown>> {
    const res = await this.fetch('/health', { method: 'GET', timeout: this.timeouts.health });
    return await this.parseJson(res, '/health') as Record<string, unknown>;
  }

  // ── Groq direct fallback (gateway offline) ────────────────────────────

  /** Call Groq Whisper directly — used when the gateway is unreachable. */
  private async groqTranscribeFallback(audio: Uint8Array, language: string, prompt: string): Promise<TranscribeResponse> {
    const form = new FormData();
    // Cast to BlobPart[] — audio is always ArrayBuffer-backed (never
    // SharedArrayBuffer) but TS 5.7+ defaults Uint8Array to generic
    // ArrayBufferLike, which Blob rejects.
    form.append('file', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', GROQ_FALLBACK_STT_MODEL);
    form.append('language', language);
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(`${GROQ_API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.groqApiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.timeouts.stt),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(`Groq STT fallback failed (${res.status}): ${text.slice(0, 200)}`, res.status, '/groq/audio/transcriptions');
    }
    const data = await res.json() as { text?: string };
    return { text: data.text ?? '', usedGpu: false };
  }

  /** Call Groq chat completions directly — used when the gateway is unreachable. */
  private async groqChatFallback(messages: ChatMessage[], options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: options.model ?? GROQ_FALLBACK_LLM_MODEL,
      messages,
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeouts.translate),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(`Groq LLM fallback failed (${res.status}): ${text.slice(0, 200)}`, res.status, '/groq/chat/completions');
    }
    const data = await res.json() as {
      model?: string;
      choices?: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: data.model ?? (options.model ?? GROQ_FALLBACK_LLM_MODEL),
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Clean up resources (#830). `await`-able so the contract matches the Python /
   * `sdk/node` clients (which close httpx/mark-closed). Idempotent; after close,
   * `isClosed()` is true. No persistent connections today, so this is a marker.
   */
  async close(): Promise<void> {
    this._closed = true;
  }

  /** Whether `close()` has been called (#830). */
  isClosed(): boolean {
    return this._closed;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Internal fetch with retry on connection-level errors.
   * Retries ECONNREFUSED, network failures with exponential backoff
   * so that gateway restarts don't cause permanent failures.
   * HTTP 4xx/5xx errors are NOT retried.
   */
  private async fetch(
    path: string,
    options: {
      method: string;
      headers?: Record<string, string>;
      body?: BodyInit | Uint8Array;
      timeout: number;
      allowedStatuses?: number[];
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    const maxRetries = this.maxRetries;
    const backoff = this.retryBackoffMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      }

      const controller = new AbortController();
      const timeoutSignal = AbortSignal.timeout(options.timeout);

      const combinedSignal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;

      // #837 — generate a fresh request id per logical request (first attempt)
      // and reuse it across retries so the gateway can correlate the retries.
      const reqIdHeader: Record<string, string> = {};
      if (this.emitRequestId) {
        if (attempt === 0 || !this._lastRequestId) this._lastRequestId = generateRequestId();
        reqIdHeader['X-Request-ID'] = this._lastRequestId;
      }

      try {
        const res = await fetch(url, {
          method: options.method,
          headers: { ...this.headers, ...reqIdHeader, ...options.headers },
          body: options.body as BodyInit,
          signal: combinedSignal,
        });

        controller.abort();

        const allowed = options.allowedStatuses ?? [];
        if (!res.ok && !allowed.includes(res.status)) {
          const text = await res.text().catch(() => '');
          // Surface the gateway's structured { code, retryable } on the error (#826).
          const structured = parseGatewayErrorBody(text);
          throw new GatewayError(
            `${options.method} ${path} failed (${res.status}): ${text.slice(0, 200)}`,
            res.status,
            path,
            false,
            structured.code,
            structured.retryable,
          );
        }
        return res;
      } catch (err: unknown) {
        controller.abort();
        // HTTP errors (GatewayError with status code) are NOT retried
        if (err instanceof GatewayError && err.statusCode > 0) throw err;

        // Timeout errors are NOT retried
        if (err instanceof Error && err.name === 'AbortError') {
          const reason = (err as Error & { cause?: unknown }).cause;
          if (reason instanceof Error && reason.name === 'AbortError') {
            throw err;
          }
          throw new GatewayError(
            `${options.method} ${path} timed out (${options.timeout}ms)`,
            0,
            path,
          );
        }

        lastError = err;

        // Only retry connection-level errors
        if (!isRetryableError(err) || attempt >= maxRetries) {
          if (err instanceof TypeError) {
            throw new GatewayError(
              `${options.method} ${path} network error: ${err.message}`,
              0,
              path,
              true, // isNetworkError — triggers Groq fallback
            );
          }
          throw err;
        }
        // Connection error — retry
      }
    }

    // Unreachable, but satisfies TS
    if (lastError instanceof TypeError) {
      throw new GatewayError(
        `${options.method} ${path} network error after ${maxRetries + 1} attempts: ${(lastError as Error).message}`,
        0,
        path,
        true, // isNetworkError
      );
    }
    throw lastError;
  }

  /** Parse JSON from response, throwing GatewayError on invalid JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async parseJson(res: Response, path: string): Promise<Record<string, unknown>> {
    try {
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GatewayError(
          `${path}: invalid JSON: "${text.slice(0, 100)}"`,
          res.status,
          path,
        );
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GatewayError(
          `${path}: invalid JSON response: expected object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
          res.status,
          path,
        );
      }
      return parsed as Record<string, unknown>;
    } catch (err: unknown) {
      if (err instanceof GatewayError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new GatewayError(
        `${path}: invalid JSON response: ${msg}`,
        res.status,
        path,
      );
    }
  }
}
