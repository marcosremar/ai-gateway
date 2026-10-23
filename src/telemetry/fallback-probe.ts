/**
 * Fallback probe: the gateway checks by itself that every cloud link of the app alias chains answers.
 *
 * At boot (after `FALLBACK_PROBE_DELAY_MS`) and every `FALLBACK_PROBE_MINUTES` (default 15; 0 = off) in a class window, every
 * `FALLBACK_PROBE_IDLE_MINUTES` (default 60) outside it, each distinct
 * cloud link (stage + provider + model + voice; `deployment:` links are never called, so no GPU wakes) gets a minimal
 * request straight on its provider instance: STT a 0.6 s WAV, TTS two words in the link's own voice, chat a few
 * tokens with the link's `extraBody`. Failures go to `onResults` (ops alerts); `/health?details=1` shows `snapshot()`.
 */

import type { LLMProvider, STTProvider, TTSProvider, TTSResponse } from '../gateway/providers/cloud/types';
import { errorText, failureCode, providerHeader, redactSecrets, type RouteTarget } from '../gateway/proxy/provider-routing';
import { withLogContext } from '../logger';

type Stage = 'chat' | 'stt' | 'tts';
type Env = Record<string, string | undefined>;

export const DEFAULT_FALLBACK_PROBE_MINUTES = 15;
export const DEFAULT_FALLBACK_PROBE_IDLE_MINUTES = 60;
export const DEFAULT_FALLBACK_PROBE_DELAY_MS = 30_000;
export const FALLBACK_PROBE_TIMEOUT_MS = 20_000;
export const FALLBACK_PROBE_CALLER = 'teste-das-reservas';

export interface FallbackLink {
  stage: Stage;
  target: string;
  providerId: string;
  model: string;
  voice?: string;
  extraBody?: Record<string, unknown>;
  provider: LLMProvider | STTProvider | TTSProvider;
  aliases: string[];
}

export interface FallbackProbeResult {
  stage: Stage;
  target: string;
  providerId: string;
  voice?: string;
  aliases: string[];
  ok: boolean;
  /** HTTP status of the failure (null: ok, timeout or network). */
  status: number | null;
  /** `failureCode`: credit, auth, timeout, 5xx… */
  code: string | null;
  latencyMs: number;
  checkedAt: string;
  error: string | null;
  content?: ProbeContent;
  contentNote?: string | null;
}

export type ProbeContent = 'ok' | 'mismatch' | null;
type Checked = { content: ProbeContent; note: string | null; audio?: Buffer };

export const SAID = 'Bom dia.';
export const HEARD = /\bbo[mn] ?dia\b/;
export const ANSWERED = /\bok\b/i;
const MIN_COMPRESSED_BYTES = 1_500;
const MIN_PCM_RMS = 200;
const AUDIO_READ_MAX = 512 * 1024;
export const plain = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const quote = (t: string) => `«${t.replace(/\s+/g, ' ').trim().slice(0, 60)}»`;

async function audioOf(res: TTSResponse): Promise<Buffer> {
  if (!res.stream) return res.audio;
  const reader = res.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < AUDIO_READ_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export function audioCheck(audio: Buffer, contentType: string): Checked {
  const pcm = /wav|pcm|l16/i.test(contentType) || audio.subarray(0, 4).toString() === 'RIFF';
  if (!pcm) return audio.length < MIN_COMPRESSED_BYTES ? { content: 'mismatch', note: `áudio curto demais para «${SAID}» (${audio.length} bytes)` } : { content: 'ok', note: null, audio };
  const start = audio.subarray(0, 4).toString() === 'RIFF' ? 44 : 0;
  let sum = 0;
  let n = 0;
  for (let i = start; i + 1 < audio.length; i += 2, n++) sum += audio.readInt16LE(i) ** 2;
  const rms = n ? Math.sqrt(sum / n) : 0;
  return rms < MIN_PCM_RMS ? { content: 'mismatch', note: `áudio em silêncio (RMS ${Math.round(rms)})` } : { content: 'ok', note: null, audio };
}

type Routes = Partial<Record<'chatRoutes' | 'stt' | 'tts', Record<string, unknown>>>;
const ROUTES_KEY: Record<Stage, 'chatRoutes' | 'stt' | 'tts'> = { chat: 'chatRoutes', stt: 'stt', tts: 'tts' };

/** The cloud links of the alias chains (`chains` of `buildServeProviders`), one per stage + provider + model + voice. */
export function fallbackLinks(chains: Partial<Record<Stage, Record<string, unknown>>>, routes: Routes): FallbackLink[] {
  const links = new Map<string, FallbackLink>();
  for (const stage of ['stt', 'chat', 'tts'] as const) {
    for (const alias of Object.keys(chains[stage] ?? {})) {
      const targets = routes[ROUTES_KEY[stage]]?.[alias];
      if (!Array.isArray(targets)) continue;
      for (const t of targets as Array<RouteTarget<FallbackLink['provider']>>) {
        if (t.providerId.startsWith('deployment:')) continue;
        const model = t.model ?? alias;
        const voice = stage === 'tts' ? t.voiceFor?.({ voice: t.voice ?? '' }) ?? t.voice : undefined;
        const key = [stage, t.providerId, model, voice ?? ''].join('|');
        const known = links.get(key);
        if (known) { if (!known.aliases.includes(alias)) known.aliases.push(alias); continue; }
        links.set(key, {
          stage, target: providerHeader({ providerId: t.providerId, model }), providerId: t.providerId, model, provider: t.provider, aliases: [alias],
          ...(voice ? { voice } : {}), ...(stage === 'chat' && t.extraBody ? { extraBody: t.extraBody } : {}),
        });
      }
    }
  }
  return [...links.values()];
}

/** 0.6 s of 16 kHz mono PCM16: a 180 Hz voiced buzz with a syllable-like envelope (pure silence is refused as empty). */
export function probeWav(): Buffer {
  const rate = 16_000;
  const samples = Math.round(rate * 0.6);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const envelope = Math.sin(Math.PI * t / 0.6);
    const voiced = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t) + 0.3 * Math.sin(2 * Math.PI * 1_260 * t);
    wav.writeInt16LE(Math.round(9_000 * envelope * voiced / 1.8), 44 + i * 2);
  }
  return wav;
}

const PROBE_WAV = probeWav();

async function call(link: FallbackLink, signal: AbortSignal, heard?: Buffer): Promise<Checked> {
  if (link.stage === 'stt') {
    const r = await (link.provider as STTProvider).transcribe({ audio: heard ?? PROBE_WAV, model: link.model, signal });
    if (!heard) return { content: null, note: null };
    return HEARD.test(plain(r.text ?? '')) ? { content: 'ok', note: null } : { content: 'mismatch', note: `ouviu ${quote(r.text ?? '')} em vez de «bom dia»` };
  }
  if (link.stage === 'tts') {
    // `extra.language`: the gateway's own speech server picks its voice by language (route-tts.ts); cloud links ignore it.
    const res = await (link.provider as TTSProvider).synthesize({ input: SAID, model: link.model, voice: link.voice ?? '', signal, extra: { language: 'pt' } });
    const audio = await audioOf(res);
    if (!audio.length) throw new Error('empty audio');
    return audioCheck(audio, res.contentType ?? '');
  }
  const r = await (link.provider as LLMProvider).chat({
    messages: [{ role: 'user', content: 'Reply with: ok' }], model: link.model, maxTokens: 16, signal,
    ...(link.extraBody ? { extraBody: link.extraBody } : {}),
  });
  return ANSWERED.test(r.content ?? '') ? { content: 'ok', note: null } : { content: 'mismatch', note: `respondeu ${quote(r.content ?? '')} em vez de «ok»` };
}

export async function probeLink(
  link: FallbackLink, opts: { timeoutMs?: number; env?: Env; now?: () => number; heard?: Buffer; enforce?: boolean } = {},
): Promise<FallbackProbeResult & { audio?: Buffer }> {
  const now = opts.now ?? Date.now;
  const started = now();
  const base = { stage: link.stage, target: link.target, providerId: link.providerId, ...(link.voice ? { voice: link.voice } : {}), aliases: link.aliases };
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FALLBACK_PROBE_TIMEOUT_MS);
  try {
    const checked = await call(link, signal, opts.heard);
    const failed = opts.enforce && checked.content === 'mismatch';
    return {
      ...base, ok: !failed, status: null, code: failed ? 'content' : null, latencyMs: now() - started, checkedAt: new Date(now()).toISOString(),
      error: failed ? checked.note : null, content: checked.content, contentNote: checked.note, ...(checked.audio ? { audio: checked.audio } : {}),
    };
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    const message = errorText(err);
    return {
      ...base, ok: false, status: typeof status === 'number' ? status : null, code: signal.aborted ? 'timeout' : failureCode(err), latencyMs: now() - started,
      checkedAt: new Date(now()).toISOString(), error: redactSecrets(message, opts.env).slice(0, 300),
    };
  }
}

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function createFallbackProbe(opts: {
  env: Env; links: () => FallbackLink[]; onResults: (results: FallbackProbeResult[]) => unknown;
  now?: () => number; log?: (msg: string, data?: Record<string, unknown>) => void; inClass?: () => boolean;
}) {
  const minutes = num(opts.env.FALLBACK_PROBE_MINUTES, DEFAULT_FALLBACK_PROBE_MINUTES);
  const idleMinutes = num(opts.env.FALLBACK_PROBE_IDLE_MINUTES, DEFAULT_FALLBACK_PROBE_IDLE_MINUTES);
  const clock = opts.now ?? Date.now;
  let lastRunAt = -Infinity;
  const delayMs = num(opts.env.FALLBACK_PROBE_DELAY_MS, DEFAULT_FALLBACK_PROBE_DELAY_MS);
  const timeoutMs = num(opts.env.FALLBACK_PROBE_TIMEOUT_MS, FALLBACK_PROBE_TIMEOUT_MS);
  const enforce = opts.env.FALLBACK_PROBE_CONTENT?.trim() === 'enforce';
  let results: FallbackProbeResult[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  async function check(): Promise<FallbackProbeResult[]> {
    lastRunAt = clock();
    const before = new Map(results.map(r => [`${r.stage}|${r.target}|${r.voice ?? ''}`, r.ok]));
    const links = opts.links();
    const probe = (link: FallbackLink, heard?: Buffer) => probeLink(link, { timeoutMs, env: opts.env, enforce, ...(heard ? { heard } : {}), ...(opts.now ? { now: opts.now } : {}) });
    results = await withLogContext({ userId: FALLBACK_PROBE_CALLER }, async () => {
      const spoken = await Promise.all(links.filter(l => l.stage === 'tts').map(l => probe(l)));
      const heard = spoken.find(r => r.content === 'ok' && r.audio)?.audio;
      const rest = await Promise.all(links.filter(l => l.stage !== 'tts').map(l => probe(l, l.stage === 'stt' ? heard : undefined)));
      return [...rest, ...spoken].map(({ audio: _audio, ...r }) => r);
    });
    for (const r of results) {
      if (r.ok && before.get(`${r.stage}|${r.target}|${r.voice ?? ''}`) === false) opts.log?.('fallback probe recovered', { stage: r.stage, target: r.target });
    }
    await Promise.resolve().then(() => opts.onResults(results)).catch(() => {});
    return results;
  }

  /** Outside a class nobody waits on the reserve minute by minute: each probe calls paid models (owner, 23/10/2026). */
  const dueNow = () => (opts.inClass?.() ?? true) || clock() - lastRunAt >= idleMinutes * 60_000 - 1_000;

  return {
    check,
    dueNow,
    snapshot: () => ({
      intervalMinutes: minutes,
      idleIntervalMinutes: idleMinutes,
      ok: results.filter(r => r.ok).length,
      failing: results.filter(r => !r.ok).map(r => r.target),
      links: results,
    }),
    start(): void {
      if (minutes <= 0) return;
      const run = () => void check().catch(err => opts.log?.('fallback probe failed', { error: err instanceof Error ? err.message : String(err) }));
      const tick = () => { if (dueNow()) run(); };
      timers.push(setTimeout(run, delayMs), setInterval(tick, minutes * 60_000));
      for (const t of timers) t.unref?.();
    },
    stop(): void { for (const t of timers.splice(0)) clearTimeout(t); },
  };
}
