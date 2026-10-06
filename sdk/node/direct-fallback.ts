/**
 * Direct fallback of GatewayClient: while the gateway itself is unreachable, the same aliases are served by the
 * providers of the app's fallback plan (`GET /v1/apps/:app/fallback`), called directly with the OpenAI shapes.
 *
 * Keys come ONLY from the plan (the gateway hands them out; nothing is read from the environment), live in memory
 * only and are sent only to their own provider's `baseUrl`. Server-side clients only: never ship a plan to a browser.
 */

import { exchange, GatewayError } from './gateway-http';
import { chatStreamOf } from './gateway-streams';
import type {
  CallOptions, ChatCompletion, FetchLike, ChatRequest, ChatStream, FallbackCredential, FallbackEntry, FallbackPlan, Served,
  SpeechRequest, SpeechResult, TimeoutGroup, Transcription, TranscribeRequest,
} from './gateway-types';

/** Plan cache: refreshed before `ttlSeconds` runs out; the last good plan stays usable while the gateway is down. */
export class FallbackPlanStore {
  private plan: FallbackPlan | null = null;
  private fetchedAt = 0;
  private inflight: Promise<FallbackPlan | null> | null = null;

  constructor(private readonly load: () => Promise<FallbackPlan>, private readonly now: () => number) {}

  current(): FallbackPlan | null { return this.plan; }

  /** Older than 80 % of its TTL (or none yet). */
  stale(): boolean {
    return !this.plan || this.now() - this.fetchedAt >= this.plan.ttlSeconds * 800;
  }

  /** Fetches a new plan (deduplicated). On failure the previous plan is kept and returned. */
  refresh(): Promise<FallbackPlan | null> {
    this.inflight ??= this.load().then(
      (plan) => { this.plan = plan; this.fetchedAt = this.now(); return plan; },
      () => this.plan,
    ).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  refreshIfStale(): void { if (this.stale()) void this.refresh(); }
}

const OPENAI_CHAT_FIELDS = ['messages', 'temperature', 'max_tokens', 'top_p', 'stop', 'seed', 'response_format', 'stream_options'] as const;
/** OpenRouter's speech endpoint takes mp3 or pcm (the gateway's own OpenRouter TTS maps any other format to mp3). */
const OPENROUTER_TTS_FORMATS = new Set(['mp3', 'pcm']);

type Stage = 'stt' | 'chat' | 'tts';

function directServed(entry: FallbackEntry): Served {
  return { provider: `${entry.provider}-direct:${entry.model}`, fallback: 'gateway_unreachable', fallbackFrom: 'gateway' };
}

/** TTS voice of a direct entry: its own when fixed, else the request's `fallback_voice`, else its own, else `voice`. */
function directVoice(entry: FallbackEntry, req: Pick<SpeechRequest, 'voice' | 'fallback_voice'>): string {
  if (entry.fixedVoice && entry.voice) return entry.voice;
  return req.fallback_voice || entry.voice || req.voice;
}

function moveOn(err: unknown): boolean {
  if (!(err instanceof GatewayError)) return false;
  return err.code === 'timeout' || err.code === 'network' || err.status === 429 || err.status >= 500;
}

export class DirectCaller {
  constructor(
    private readonly plans: FallbackPlanStore,
    private readonly fetchImpl: FetchLike,
    private readonly timeouts: Record<TimeoutGroup, number>,
  ) {}

  /**
   * Tries the alias's entries in chain order (next one on 5xx / 429 / timeout / connection error; a 401 asks the
   * gateway for a new plan once). No usable entry → rethrows `cause` (the gateway's own failure).
   */
  private async run<R>(
    stage: Stage, alias: string, call: CallOptions, cause: GatewayError,
    attempt: (entry: FallbackEntry, cred: FallbackCredential, timeoutMs: number) => Promise<R>,
  ): Promise<R> {
    let plan = this.plans.current() ?? await this.plans.refresh();
    const usable = (p: FallbackPlan | null) => (p?.routes[stage]?.[alias] ?? []).filter(e => p!.providers[e.provider]);
    let entries = usable(plan);
    if (!entries.length) throw cause;
    const timeoutMs = call.timeoutMs ?? this.timeouts[stage];
    let refreshed = false;
    let last: unknown = cause;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      try {
        return await attempt(entry, plan!.providers[entry.provider]!, timeoutMs);
      } catch (err) {
        if (call.signal?.aborted) throw err;
        if (err instanceof GatewayError && err.status === 401 && !refreshed) {
          refreshed = true;
          const fresh = await this.plans.refresh();
          const freshEntries = usable(fresh);
          const key = fresh?.providers[entry.provider]?.apiKey;
          if (fresh && key && key !== plan!.providers[entry.provider]!.apiKey) {
            plan = fresh;
            entries = freshEntries;
            i = entries.findIndex(e => e.provider === entry.provider && e.model === entry.model) - 1;
            if (i < -1) i = -1;
            continue;
          }
        }
        if (!moveOn(err) && !(err instanceof GatewayError && err.status === 401)) throw err;
        last = err;
      }
    }
    throw last;
  }

  private send<R>(cred: FallbackCredential, entry: FallbackEntry, path: string, init: { body: BodyInit; json: boolean },
    call: CallOptions, timeoutMs: number, read: (res: Response) => Promise<R>): Promise<R> {
    return exchange({
      fetch: this.fetchImpl,
      url: `${cred.baseUrl.replace(/\/+$/, '')}${path}`,
      path, method: 'POST',
      headers: { Authorization: `Bearer ${cred.apiKey}`, ...(init.json ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body, signal: call.signal, timeoutMs, retries: 0, origin: entry.provider,
    }, read);
  }

  transcribe(req: TranscribeRequest, cause: GatewayError): Promise<Transcription> {
    return this.run('stt', req.model, req, cause, (entry, cred, timeoutMs) => {
      const form = new FormData();
      form.set('file', req.file instanceof Blob ? req.file : new Blob([new Uint8Array(req.file)]), req.filename ?? 'audio');
      form.set('model', entry.model);
      if (req.language) form.set('language', req.language);
      if (req.prompt) form.set('prompt', req.prompt);
      form.set('response_format', req.responseFormat ?? 'json');
      return this.send(cred, entry, '/audio/transcriptions', { body: form, json: false }, req, timeoutMs, async (res) => {
        const raw = await res.text();
        let body: Record<string, unknown>;
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { text: raw }; }
        return { ...body, text: String(body.text ?? ''), served: directServed(entry) };
      });
    });
  }

  private chatBody(req: ChatRequest, entry: FallbackEntry, stream: boolean): string {
    const fields: Record<string, unknown> = {};
    for (const k of OPENAI_CHAT_FIELDS) if (req[k] !== undefined) fields[k] = req[k];
    return JSON.stringify({ ...fields, ...req.extraBody, ...entry.extraBody, model: entry.model, stream });
  }

  chat(req: ChatRequest, cause: GatewayError): Promise<ChatCompletion> {
    return this.run('chat', req.model, req, cause, (entry, cred, timeoutMs) =>
      this.send(cred, entry, '/chat/completions', { body: this.chatBody(req, entry, false), json: true }, req, timeoutMs,
        async (res) => ({ ...(await res.json() as Omit<ChatCompletion, 'served'>), served: directServed(entry) })));
  }

  chatStream(req: ChatRequest, cause: GatewayError): Promise<ChatStream> {
    return this.run('chat', req.model, req, cause, (entry, cred, timeoutMs) =>
      this.send(cred, entry, '/chat/completions', { body: this.chatBody(req, entry, true), json: true }, req, timeoutMs,
        async (res) => chatStreamOf(res, directServed(entry), { path: '/chat/completions', signal: req.signal, origin: entry.provider })));
  }

  speech(req: SpeechRequest, cause: GatewayError): Promise<SpeechResult> {
    return this.run('tts', req.model, req, cause, (entry, cred, timeoutMs) => {
      const wanted = req.response_format ?? 'mp3';
      const format = entry.provider === 'openrouter' && !OPENROUTER_TTS_FORMATS.has(wanted) ? 'mp3' : wanted;
      // Only the OpenAI fields: provider-specific extras (ref_audio, task_type, …) are for self-hosted targets.
      const body = JSON.stringify({
        model: entry.model, input: req.input, voice: directVoice(entry, req), response_format: format,
        ...(req.speed !== undefined ? { speed: req.speed } : {}),
      });
      return this.send(cred, entry, '/audio/speech', { body, json: true }, req, timeoutMs, async (res) => {
        if (!res.body) throw new GatewayError({ message: 'empty speech body', code: 'bad_response', path: '/audio/speech', origin: entry.provider });
        return { body: res.body, contentType: res.headers.get('content-type') ?? 'application/octet-stream', served: directServed(entry) };
      });
    });
  }
}
