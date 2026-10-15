import type { ChatCompletion, ChatRequest, ChatStream, Served } from '../../node/gateway-types';
import { STT_RATE, encodeWav } from '../voice/turn-clip';
import { LOCAL_STAGES, admitStages, defaultBudgetMb, probeDevice } from './capabilities';
import type {
  FallbackReason, Local, LocalAdmission, LocalModel, LocalStage, LocalTier, LocalTierOptions, LlmEngine, LlmOptions,
  ServedBy, SttEngine, TtsEngine,
} from './types';

export const DEFAULT_DEADLINE_MS: Record<LocalStage, number> = { stt: 8_000, tts: 8_000, llm: 15_000 };
export const DEFAULT_MIN_AVG_LOGPROB = -1;
const SILENT_PEAK = 1e-3;

interface Engines { stt: SttEngine; tts: TtsEngine; llm: LlmEngine }
interface Slot<E> { promise: Promise<E>; engine?: E; failed?: boolean; slow?: boolean }
type Attempt<T> = { ok: T } | { reason: FallbackReason };

class LowConfidence extends Error {}
class DeadlineExceeded extends Error {}

const peak = (samples: Float32Array) => samples.reduce((max, x) => Math.max(max, Math.abs(x)), 0);

async function decodeAt16k(file: Blob | Uint8Array): Promise<Float32Array> {
  const bytes = file instanceof Uint8Array ? file.slice().buffer : await file.arrayBuffer();
  return (await new OfflineAudioContext(1, 1, STT_RATE).decodeAudioData(bytes)).getChannelData(0);
}

function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DeadlineExceeded()); }, ms);
  });
  return Promise.race([run(controller.signal), expired]).finally(() => clearTimeout(timer));
}

const llmOptions = (req: ChatRequest): LlmOptions => Object.fromEntries(Object.entries({
  temperature: req.temperature, max_tokens: req.max_tokens, top_p: req.top_p, stop: req.stop, seed: req.seed, response_format: req.response_format,
}).filter(([, v]) => v !== undefined));

function localStream(first: string, rest: AsyncIterator<string>, served: Served): ChatStream {
  let finishReason: string | null = null;
  return {
    served,
    usage: null,
    get finishReason() { return finishReason; },
    async *[Symbol.asyncIterator]() {
      yield first;
      for (let next = await rest.next(); !next.done; next = await rest.next()) yield next.value;
      finishReason = 'stop';
    },
    async cancel() { await rest.return?.(); },
  };
}

export function createLocalTier(opts: LocalTierOptions): LocalTier {
  const policyOf = (stage: LocalStage) => opts.policy?.[stage] ?? 'gateway-only';
  const now = opts.now ?? (() => performance.now());
  const minAvgLogprob = opts.minAvgLogprob ?? DEFAULT_MIN_AVG_LOGPROB;
  const slots: { [S in LocalStage]?: Slot<Engines[S]> } = {};
  let admitted: LocalAdmission | null = null;
  let admitting: Promise<LocalAdmission> | null = null;

  const admission = () => admitting ??= (async () => {
    const caps = await (opts.probe ?? probeDevice)();
    const budgetMb = opts.budgetMb ?? defaultBudgetMb(caps);
    admitted = { caps, budgetMb, stages: admitStages(opts.policy ?? {}, opts.models ?? {}, caps, budgetMb) };
    return admitted;
  })();

  const servedLocally = (stage: LocalStage): Served => ({ provider: `local:${opts.models![stage]!.id}`, fallback: null, fallbackFrom: null });

  function load<S extends LocalStage>(stage: S, device: 'webgpu' | 'wasm'): Slot<Engines[S]> {
    const existing = slots[stage];
    if (existing) return existing;
    const model = opts.models![stage] as LocalModel<Engines[S]>;
    const started = now();
    const report = (status: 'loading' | 'ready' | 'error', progress: number, loadMs?: number) =>
      opts.onProgress?.({ stage, model: model.id, device, status, progress, ...(loadMs === undefined ? {} : { loadMs }) });
    const emitLoad = (ok: boolean, durMs: number) =>
      opts.telemetry?.emit('local.load', { level: ok ? 'info' : 'warn', durMs, attrs: { stage, model: model.id, device, ok } });
    report('loading', 0);
    const slot: Slot<Engines[S]> = {
      promise: model.load({ device, caps: admitted!.caps, onProgress: p => report('loading', p) }).then(
        (engine) => { const ms = now() - started; slot.engine = engine; report('ready', 1, ms); emitLoad(true, ms); return engine; },
        (err: unknown) => { slot.failed = true; report('error', 0); emitLoad(false, now() - started); throw err; },
      ),
    };
    slot.promise.catch(() => {});
    slots[stage] = slot as (typeof slots)[S];
    return slot;
  }

  async function tryLocal<S extends LocalStage, T>(stage: S, run: (engine: Engines[S], signal: AbortSignal) => Promise<T>, waitForLoad: boolean): Promise<Attempt<T>> {
    const stageAdmission = (await admission()).stages[stage];
    if (!stageAdmission.local) return { reason: 'refused' };
    const slot = load(stage, stageAdmission.device);
    if (slot.failed) return { reason: 'error' };
    if (slot.slow) return { reason: 'timeout' };
    if (!slot.engine && !waitForLoad) return { reason: 'loading' };
    const deadline = opts.deadlineMs?.[stage] ?? DEFAULT_DEADLINE_MS[stage];
    const warm = !!slot.engine;
    const started = now();
    try {
      const ok = await withDeadline(signal => slot.promise.then(engine => run(engine, signal)), deadline);
      if (warm && now() - started > deadline) slot.slow = true;
      return { ok };
    } catch (err) {
      if (warm && err instanceof DeadlineExceeded) slot.slow = true;
      return { reason: err instanceof DeadlineExceeded ? 'timeout' : err instanceof LowConfidence ? 'low_confidence' : 'error' };
    }
  }

  async function route<S extends LocalStage, T extends object>(
    stage: S, signal: AbortSignal | undefined, viaGateway: () => Promise<T>, viaLocal: (engine: Engines[S], signal: AbortSignal) => Promise<T>,
  ): Promise<T & Local> {
    const policy = policyOf(stage);
    const started = now();
    const finish = (result: T, servedBy: ServedBy, reason: FallbackReason | null): T & Local => {
      const local = admitted?.stages[stage];
      opts.telemetry?.emit('local.call', { durMs: now() - started, attrs: {
        stage, policy, served_by: servedBy, reason, device: servedBy === 'local' && local?.local ? local.device : null,
      } });
      return Object.assign(result, { servedBy, reason });
    };
    if (policy === 'gateway-only') return finish(await viaGateway(), 'gateway', null);
    if (policy === 'local-first') {
      const attempt = await tryLocal(stage, viaLocal, false);
      signal?.throwIfAborted();
      if ('ok' in attempt) return finish(attempt.ok, 'local', null);
      return finish(await viaGateway(), 'gateway', attempt.reason);
    }
    try {
      return finish(await viaGateway(), 'gateway', null);
    } catch (err) {
      if (signal?.aborted) throw err;
      const attempt = await tryLocal(stage, viaLocal, true);
      if ('ok' in attempt) return finish(attempt.ok, 'local', 'gateway_error');
      throw err;
    }
  }

  return {
    admission,

    async prefetch(stages = [...LOCAL_STAGES]) {
      const { stages: admissions } = await admission();
      await Promise.allSettled(stages.map((s) => {
        const a = admissions[s];
        return a.local ? load(s, a.device).promise : null;
      }));
    },

    transcribe: req => route('stt', req.signal, () => opts.gateway.transcribe(req), async (engine) => {
      const audio = await (opts.decodeAudio ?? decodeAt16k)(req.file);
      const { text, avgLogprob } = await engine.transcribe(audio, { language: req.language, prompt: req.prompt });
      if (!text.trim() || (avgLogprob !== undefined && avgLogprob < minAvgLogprob)) throw new LowConfidence();
      return { text: text.trim(), served: servedLocally('stt'), ...(avgLogprob === undefined ? {} : { avg_logprob: avgLogprob }) };
    }),

    speak: req => route('tts', req.signal, () => opts.gateway.speech(req), async (engine) => {
      const { samples, rate } = await engine.speak(req.input, { voice: req.voice, fallbackVoice: req.fallback_voice, speed: req.speed });
      if (peak(samples) < SILENT_PEAK) throw new LowConfidence();
      return { body: new Blob([encodeWav(samples, rate)]).stream(), contentType: 'audio/wav', served: servedLocally('tts') };
    }),

    chat: req => route('llm', req.signal, () => opts.gateway.chat(req), async (engine, signal): Promise<ChatCompletion> => {
      let content = '';
      for await (const delta of engine.stream(req.messages, llmOptions(req), signal)) content += delta;
      if (!content.trim()) throw new LowConfidence();
      return {
        id: `local-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: opts.models!.llm!.id,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], served: servedLocally('llm'),
      };
    }),

    chatStream: req => route('llm', req.signal, () => opts.gateway.chatStream(req), async (engine, signal) => {
      const deltas = engine.stream(req.messages, llmOptions(req), signal)[Symbol.asyncIterator]();
      let first = await deltas.next();
      while (!first.done && !first.value.trim()) first = await deltas.next();
      if (first.done) throw new LowConfidence();
      if (signal.aborted) { await deltas.return?.(); throw new DeadlineExceeded(); }
      return localStream(first.value, deltas, servedLocally('llm'));
    }),
  };
}
