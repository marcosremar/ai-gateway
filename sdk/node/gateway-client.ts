/**
 * GatewayClient — typed client of the CURRENT gateway API (`serve.ts`, docs/api/http.md, docs/client.md):
 * OpenAI-compatible STT / chat / TTS, speech-to-speech frames, deployments, app accounts and health.
 *
 *   const gw = new GatewayClient({ baseUrl: 'https://gateway.example.com', apiKey: process.env.GATEWAY_API_KEY });
 *   const { text, served } = await gw.transcribe({ file, model: 'parle-stt', language: 'pt' });
 *
 * - Talks only to `baseUrl` (plus, with `directFallback`, the providers named by the gateway's fallback plan).
 * - Never reads a provider key from the environment. Injectable `fetch`, per-call `signal` and `timeoutMs`.
 * - Retries only idempotent calls (GET, PUT, PATCH, DELETE, wake, park) on connection errors, at most twice. POSTs
 *   that cost money (transcriptions, chat, speech, s2s) are never retried: the gateway already falls back and hedges.
 * - `GatewayHttpClient` (index.ts) is the legacy client of the old routes (`/v1/transcribe`, `/v1/gpu/*`, …).
 */

import { DirectCaller, FallbackPlanStore } from './direct-fallback';
import { GatewayBreaker } from './gateway-breaker';
import { exchange, GatewayError, servedFrom } from './gateway-http';
import { chatStreamOf, s2sStreamOf } from './gateway-streams';
import {
  GATEWAY_CLIENT_TIMEOUTS,
  type AppImage, type AppView, type CallOptions, type ChatCompletion, type ChatRequest, type ChatStream,
  type DeploymentList, type DeploymentPutBody, type DeploymentView, type FallbackPlan, type FetchLike, type GatewayClientOptions,
  type GatewayState, type HealthReport, type ModelRoutesSpec, type S2SRequest, type S2SStream, type SpeechRequest,
  type SpeechResult, type TimeoutGroup, type Transcription, type TranscribeRequest,
} from './gateway-types';

interface GwSpec {
  method: string;
  path: string;
  group: TimeoutGroup;
  call?: CallOptions;
  json?: unknown;
  form?: FormData;
  idempotent?: boolean;
}

const IDEMPOTENT_RETRIES = 2;
const PROBE_TIMEOUT_MS = 3_000;
const enc = encodeURIComponent;
const toBlob = (file: Blob | Uint8Array) => (file instanceof Blob ? file : new Blob([new Uint8Array(file)]));
/** The request body: the request without the client-side call options. */
function bodyOf<T extends CallOptions>(req: T): Omit<T, 'signal' | 'timeoutMs'> {
  const out = { ...req } as Record<string, unknown>;
  delete out.signal;
  delete out.timeoutMs;
  return out as Omit<T, 'signal' | 'timeoutMs'>;
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly app: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeouts: Record<TimeoutGroup, number>;
  private readonly breaker: GatewayBreaker | null = null;
  private readonly plans: FallbackPlanStore | null = null;
  private readonly direct: DirectCaller | null = null;

  constructor(opts: GatewayClientOptions) {
    if (!opts.baseUrl) throw new Error('GatewayClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.app = opts.app;
    // A bare reference to window.fetch throws "Illegal invocation" when called unbound in browsers.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.timeouts = { ...GATEWAY_CLIENT_TIMEOUTS, ...opts.timeoutMs };
    const df = opts.directFallback;
    if (df && df.enabled !== false) {
      const now = opts.now ?? Date.now;
      this.plans = new FallbackPlanStore(() => this.apps.fallbackPlan(df.app, { timeoutMs: this.timeouts.health }), now);
      this.direct = new DirectCaller(this.plans, this.fetchImpl, this.timeouts);
      this.breaker = new GatewayBreaker({
        threshold: df.failureThreshold ?? 3, cooldownMs: df.cooldownMs ?? 30_000, now,
        probe: () => this.probe(), onRouteChange: opts.onRouteChange,
      });
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  private headers(json: boolean): Record<string, string> {
    return {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.app ? { 'X-App': this.app } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private gw<R>(spec: GwSpec, read: (res: Response) => Promise<R>): Promise<R> {
    const json = spec.json !== undefined;
    return exchange({
      fetch: this.fetchImpl, url: `${this.baseUrl}${spec.path}`, path: spec.path, method: spec.method,
      headers: this.headers(json), body: json ? JSON.stringify(spec.json) : spec.form,
      signal: spec.call?.signal, timeoutMs: spec.call?.timeoutMs ?? this.timeouts[spec.group],
      retries: spec.idempotent ? IDEMPOTENT_RETRIES : 0,
    }, read);
  }

  private getJson<T>(path: string, group: TimeoutGroup, call?: CallOptions): Promise<T> {
    return this.gw({ method: 'GET', path, group, call, idempotent: true }, r => r.json() as Promise<T>);
  }

  private async probe(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Gateway first; the direct fallback when the gateway itself is unreachable (see docs/client.md). */
  private async routed<R>(viaGateway: () => Promise<R>, viaDirect: (cause: GatewayError) => Promise<R>): Promise<R> {
    const breaker = this.breaker;
    if (!breaker) return viaGateway();
    if (breaker.skipGateway()) {
      breaker.used('direct', 'breaker_open');
      return viaDirect(new GatewayError({ message: 'gateway skipped: unreachable recently (breaker open)', code: 'gateway_unreachable', path: '', unreachable: true }));
    }
    this.plans!.refreshIfStale();
    try {
      const out = await viaGateway();
      breaker.success();
      breaker.used('gateway', 'recovered');
      return out;
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err; // includes the caller's own abort
      if (!err.unreachable) { breaker.success(); throw err; } // the gateway answered: its errors are final
      breaker.failure(err.code);
      breaker.used('direct', err.code);
      return viaDirect(err);
    }
  }

  // ── OpenAI-compatible ─────────────────────────────────────────────────────

  /** `POST /v1/audio/transcriptions` (multipart). */
  transcribe(req: TranscribeRequest): Promise<Transcription> {
    return this.routed(() => {
      const form = new FormData();
      form.set('file', toBlob(req.file), req.filename ?? 'audio');
      form.set('model', req.model);
      if (req.language) form.set('language', req.language);
      if (req.prompt) form.set('prompt', req.prompt);
      if (req.responseFormat) form.set('response_format', req.responseFormat);
      return this.gw({ method: 'POST', path: '/v1/audio/transcriptions', group: 'stt', call: req, form }, async (res) => {
        const raw = await res.text();
        let body: Record<string, unknown>;
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { text: raw }; }
        return { ...body, text: String(body.text ?? ''), served: servedFrom(res.headers) };
      });
    }, cause => this.direct!.transcribe(req, cause));
  }

  private chatJson(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const { extraBody, ...fields } = bodyOf(req);
    return { ...fields, ...extraBody, stream };
  }

  /** `POST /v1/chat/completions` (non-streamed). */
  chat(req: ChatRequest): Promise<ChatCompletion> {
    return this.routed(
      () => this.gw({ method: 'POST', path: '/v1/chat/completions', group: 'chat', call: req, json: this.chatJson(req, false) },
        async res => ({ ...(await res.json() as Omit<ChatCompletion, 'served'>), served: servedFrom(res.headers) })),
      cause => this.direct!.chat(req, cause),
    );
  }

  /** `POST /v1/chat/completions` with `stream: true`: resolves once the headers arrived; iterate for deltas. */
  chatStream(req: ChatRequest): Promise<ChatStream> {
    return this.routed(
      () => this.gw({ method: 'POST', path: '/v1/chat/completions', group: 'chat', call: req, json: this.chatJson(req, true) },
        async res => chatStreamOf(res, servedFrom(res.headers), { path: '/v1/chat/completions', signal: req.signal })),
      cause => this.direct!.chatStream(req, cause),
    );
  }

  /** `POST /v1/audio/speech`: the body is returned as a stream, never buffered. */
  speech(req: SpeechRequest): Promise<SpeechResult> {
    const json = bodyOf(req);
    return this.routed(
      () => this.gw({ method: 'POST', path: '/v1/audio/speech', group: 'tts', call: req, json }, async (res) => {
        if (!res.body) throw new GatewayError({ message: 'empty speech body', code: 'bad_response', path: '/v1/audio/speech' });
        return { body: res.body, contentType: res.headers.get('content-type') ?? 'application/octet-stream', served: servedFrom(res.headers) };
      }),
      cause => this.direct!.speech(req, cause),
    );
  }

  // ── Speech-to-speech ──────────────────────────────────────────────────────

  /**
   * `POST /v1/s2s`: resolves at the first frame (a failure before it rejects, e.g. `503 provider_unavailable`).
   * No direct fallback: when the gateway is unreachable it rejects with code `gateway_unreachable`, and the app
   * falls back to its separate transcribe / chatStream / speech calls (which do go direct).
   */
  async s2s(req: S2SRequest): Promise<S2SStream> {
    const unreachable = (cause?: GatewayError) => new GatewayError({
      message: cause ? `gateway unreachable for s2s: ${cause.message}` : 'gateway skipped for s2s: unreachable recently (breaker open)',
      code: 'gateway_unreachable', status: cause?.status, path: '/v1/s2s', unreachable: true, cause,
    });
    if (this.breaker?.skipGateway()) throw unreachable();
    const form = new FormData();
    form.set('file', toBlob(req.file), req.filename ?? 'turn');
    form.set('config', JSON.stringify(req.config));
    try {
      const stream = await this.gw({ method: 'POST', path: '/v1/s2s', group: 's2s', call: req, form },
        async res => s2sStreamOf(res, { path: '/v1/s2s', signal: req.signal }));
      this.breaker?.success();
      return stream;
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      if (!err.unreachable) { this.breaker?.success(); throw err; }
      this.breaker?.failure(err.code);
      throw unreachable(err);
    }
  }

  // ── Deployments (never direct) ────────────────────────────────────────────

  readonly deployments = {
    list: (opts: CallOptions & { app?: string } = {}): Promise<DeploymentList> =>
      this.getJson(`/v1/deployments${opts.app ? `?app=${enc(opts.app)}` : ''}`, 'admin', opts),
    /** null when the deployment does not exist. */
    get: async (name: string, call?: CallOptions): Promise<DeploymentView | null> => {
      try { return await this.getJson<DeploymentView>(`/v1/deployments/${enc(name)}`, 'admin', call); } catch (err) {
        if (err instanceof GatewayError && err.status === 404) return null;
        throw err;
      }
    },
    /** Create or update (merge); idempotent. */
    put: (name: string, spec: DeploymentPutBody, call?: CallOptions): Promise<DeploymentView> =>
      this.gw({ method: 'PUT', path: `/v1/deployments/${enc(name)}`, group: 'admin', call, json: spec, idempotent: true }, r => r.json()),
    patch: (name: string, fields: DeploymentPutBody, call?: CallOptions): Promise<DeploymentView> =>
      this.gw({ method: 'PATCH', path: `/v1/deployments/${enc(name)}`, group: 'admin', call, json: fields, idempotent: true }, r => r.json()),
    pause: (name: string, call?: CallOptions) => this.deployments.patch(name, { paused: true }, call),
    resume: (name: string, call?: CallOptions) => this.deployments.patch(name, { paused: false }, call),
    /** Start replicas now (pre-warm). */
    wake: (name: string, call?: CallOptions): Promise<DeploymentView> =>
      this.gw({ method: 'POST', path: `/v1/deployments/${enc(name)}/wake`, group: 'admin', call, idempotent: true }, r => r.json()),
    /** Done for now: scale to minReplicas at once. */
    park: (name: string, call?: CallOptions): Promise<DeploymentView> =>
      this.gw({ method: 'POST', path: `/v1/deployments/${enc(name)}/park`, group: 'admin', call, idempotent: true }, r => r.json()),
    /** false when it did not exist. */
    delete: async (name: string, call?: CallOptions): Promise<boolean> => {
      try {
        await this.gw({ method: 'DELETE', path: `/v1/deployments/${enc(name)}`, group: 'admin', call, idempotent: true }, r => r.json());
        return true;
      } catch (err) {
        if (err instanceof GatewayError && err.status === 404) return false;
        throw err;
      }
    },
    /** URL apps call the replica through, with the gateway key (`<invokeUrl>/<path>` → the container's `/<path>`). */
    invokeUrl: (name: string): string => `${this.baseUrl}/v1/deployments/${enc(name)}/invoke`,
  };

  invokeUrl(name: string): string { return this.deployments.invokeUrl(name); }

  // ── App accounts (never direct) ───────────────────────────────────────────

  readonly appRoutes = {
    get: async (app: string, call?: CallOptions): Promise<ModelRoutesSpec> =>
      (await this.getJson<{ routes: ModelRoutesSpec }>(`/v1/apps/${enc(app)}/routes`, 'admin', call)).routes,
    /** Replaces all of the app's aliases. */
    put: async (app: string, routes: ModelRoutesSpec, call?: CallOptions): Promise<ModelRoutesSpec> =>
      (await this.gw<{ routes: ModelRoutesSpec }>({ method: 'PUT', path: `/v1/apps/${enc(app)}/routes`, group: 'admin', call, json: routes, idempotent: true }, r => r.json())).routes,
  };

  readonly apps = {
    get: (app: string, call?: CallOptions): Promise<AppView> => this.getJson(`/v1/apps/${enc(app)}`, 'admin', call),
    getImage: async (app: string, name: string, call?: CallOptions): Promise<AppImage | null> => {
      try { return await this.getJson<AppImage>(`/v1/apps/${enc(app)}/images/${enc(name)}`, 'admin', call); } catch (err) {
        if (err instanceof GatewayError && err.status === 404) return null;
        throw err;
      }
    },
    putImage: (app: string, name: string, image: Partial<Pick<AppImage, 'image' | 'digest' | 'port' | 'healthPath' | 'description' | 'defaults'>>,
      call?: CallOptions): Promise<AppImage> =>
      this.gw({ method: 'PUT', path: `/v1/apps/${enc(app)}/images/${enc(name)}`, group: 'admin', call, json: image, idempotent: true }, r => r.json()),
    /** The direct-fallback plan (carries provider keys: keep it in memory, server-side). */
    fallbackPlan: (app: string, call?: CallOptions): Promise<FallbackPlan> => this.getJson(`/v1/apps/${enc(app)}/fallback`, 'admin', call),
  };

  // ── Health and fallback state ─────────────────────────────────────────────

  /** `GET /health`; `deep: true` → `?deep=1` (admin key). */
  async health(opts: CallOptions & { deep?: boolean } = {}): Promise<HealthReport> {
    const report = await this.getJson<HealthReport>(opts.deep ? '/health?deep=1' : '/health', 'health', opts);
    this.breaker?.success();
    return report;
  }

  /** Fetches the fallback plan now (call at boot so a plan exists before the gateway ever goes down). */
  refreshFallbackPlan(): Promise<FallbackPlan | null> {
    return this.plans ? this.plans.refresh() : Promise.resolve(null);
  }

  gatewayState(): GatewayState {
    return this.breaker?.state(Boolean(this.plans?.current())) ?? {
      breaker: 'closed', route: 'gateway', consecutiveFailures: 0, openUntil: null, lastError: null, planLoaded: false,
    };
  }
}
