/**
 * The composed speech-to-speech pipeline: the gateway's own stage routes chained in one streamed answer.
 *
 *   audio ─► STT (models.stt chain) ─► LLM tokens (models.chat chain, streamed) ─► SentenceCutter
 *         ─► TTS per sentence (models.tts chain, up to `ttsParallel` ahead) ─► events + audio, in speaking order
 *
 * Every stage keeps its own fallback chain, hedge, circuit breaker and time budget (provider-routing.ts): this module
 * only orders them and streams. It is the fallback of a speech-stack deployment and can also resume one that broke
 * after the transcript (`transcript` option: skip STT, start at the LLM).
 */

import { createHash } from 'crypto';
import type { S2SEvent } from './frames';
import { DEFAULT_SLOT_CTX, fitHistory } from './history';
import { createJsonFieldExtractor } from './json-field';
import { SentenceCutter } from './sentence-cutter';

export interface ChatMessage { role: string; content: string }

export interface S2SConfig {
  system?: string;
  messages?: ChatMessage[];
  language?: string;
  /** Cast voice id (Qwen3-TTS catalog of the TTS deployment). */
  voice?: string;
  /** Voice for a TTS fallback provider that does not know the cast voice (e.g. Kokoro `pf_dora`). */
  fallback_voice?: string;
  max_tokens?: number;
  temperature?: number;
  stt_prompt?: string;
  /** `false` skips the STT hallucination filter for this turn (QA only; default on, `STT_HALLUCINATION_FILTER=0` turns it off). */
  filter_hallucinations?: boolean;
  /** Ask the LLM for JSON (`{"type":"json_object"}`): only `speak_field` is voiced, the whole JSON comes in `done`. */
  response_format?: { type: string };
  /** Field of the JSON answer that is spoken (e.g. "utterance"). Without it the whole answer is spoken. */
  speak_field?: string;
  /**
   * The user turn as a template: `{{transcript}}` is replaced by what was heard. Lets a client build its prompt (game
   * context around the student's words) before the transcript exists. Default: the transcript alone.
   */
  user_template?: string;
  /** The speech-stack deployment that answers the whole turn on one GPU (the app's own; default `S2S_DEPLOYMENT`). */
  deployment?: string;
  /** The app's stage aliases for the composed fallback (`PUT /v1/apps/:app/routes`); default `S2S_<STAGE>_MODEL`. */
  models?: { stt?: string; chat?: string; tts?: string };
  first_audio_deadline_ms?: number;
  endpoint_ms?: number;
  opener?: { lines?: string[] };
}

export const TRANSCRIPT_SLOT = '{{transcript}}';
const CONTEXT_OVERFLOW = /context (size|length|window)/i;

export function userTurn(cfg: S2SConfig, transcript: string): string {
  return cfg.user_template?.includes(TRANSCRIPT_SLOT) ? cfg.user_template.split(TRANSCRIPT_SLOT).join(transcript) : transcript;
}

export interface StageAnswer {
  provider: string | null;
  fallback: string | null;
  /** STT only: reason codes when the gateway's hallucination filter emptied or trimmed the transcript. */
  filtered?: string[];
}

export interface SpokenAudio extends StageAnswer {
  /** Audio bytes as they arrive: WAV (header parsed here), raw PCM, or an encoded format reported as such. */
  body: AsyncIterable<Uint8Array>;
  contentType: string;
}

/** The three stages, behind the gateway's routing. Implemented over loopback HTTP in production, faked in tests. */
export interface StageClient {
  transcribe(audio: Uint8Array, contentType: string, cfg: S2SConfig, signal: AbortSignal, hedgeMs?: number): Promise<StageAnswer & { text: string }>;
  chatStream(messages: ChatMessage[], cfg: S2SConfig, signal: AbortSignal, hedgeMs?: number): Promise<StageAnswer & { deltas: AsyncIterable<string> }>;
  speak(text: string, cfg: S2SConfig, signal: AbortSignal, hedgeMs?: number): Promise<SpokenAudio>;
}

export interface CompositeOptions {
  stages: StageClient;
  audio: Uint8Array;
  contentType: string;
  config: S2SConfig;
  signal: AbortSignal;
  emitEvent: (event: S2SEvent) => void;
  emitAudio: (pcm: Uint8Array) => void;
  /** Already heard (a primary that broke after its transcript): skip STT. */
  transcript?: { text: string; sttMs?: number };
  /** Sentences whose audio may be synthesized ahead of the one playing. Default 2. */
  ttsParallel?: number;
  now?: () => number;
  deadlineMs?: number;
  marginMs?: number;
  skipDeadline?: boolean;
}

export interface CompositeResult { transcript: string; reply: string; replyRaw: string; firstAudioMs: number | null; missingAudio: number }

/** Strips a (possibly streamed, size-less) WAV header; reports the sample rate. Non-RIFF input passes through. */
export class WavStripper {
  private head = new Uint8Array(0);
  private done = false;
  sampleRate: number | null = null;

  push(chunk: Uint8Array): Uint8Array {
    if (this.done) return chunk;
    const merged = new Uint8Array(this.head.length + chunk.length);
    merged.set(this.head);
    merged.set(chunk, this.head.length);
    this.head = merged;
    if (this.head.length < 12) return new Uint8Array(0);
    const ascii = (at: number) => String.fromCharCode(...this.head.subarray(at, at + 4));
    if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') {
      this.done = true;
      return this.head;
    }
    const view = new DataView(this.head.buffer, this.head.byteOffset, this.head.byteLength);
    let at = 12;
    while (at + 8 <= this.head.length) {
      const id = ascii(at);
      const size = view.getUint32(at + 4, true);
      if (id === 'fmt ' && at + 16 <= this.head.length) this.sampleRate = view.getUint32(at + 12, true);
      if (id === 'data') {
        this.done = true;
        return this.head.subarray(at + 8);
      }
      if (at + 8 + size > this.head.length) return new Uint8Array(0);
      at += 8 + size + (size % 2);
    }
    return new Uint8Array(0);
  }
}

const isWavOrPcm = (contentType: string) => /wav|pcm|x-raw|octet-stream/i.test(contentType) || contentType === '';

export const MAX_FIRST_AUDIO_DEADLINE_MS = 2_500;
export const STAGE_HEDGE_MIN_MS = 1_000;
const MAX_OPENER_LINES = 8;
const MAX_OPENERS = 256;
const OPENER_SYNTH_MS = 15_000;

interface Opener { audio: Uint8Array; encoding: string; sampleRate: number | null; provider: string | null }
const openers = new Map<string, { ready: Opener | null }>();

export function openerLines(cfg: S2SConfig): string[] {
  const lines = cfg.opener?.lines;
  if (!Array.isArray(lines)) return [];
  return lines.filter((l): l is string => typeof l === 'string').map(l => l.trim()).filter(Boolean).slice(0, MAX_OPENER_LINES);
}

const openerKey = (cfg: S2SConfig, line: string) => createHash('sha256')
  .update(JSON.stringify([cfg.voice, cfg.fallback_voice, cfg.language?.slice(0, 2), cfg.models?.tts, line])).digest('hex');

function trimLead(pcm: Uint8Array, rate: number): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  for (let at = 0; at < view.byteLength; at += 2) {
    if (Math.abs(view.getInt16(at, true)) > 328) return pcm.subarray(Math.max(0, at - Math.floor(rate / 100) * 2));
  }
  return pcm;
}

async function synthOpener(stages: StageClient, cfg: S2SConfig, line: string): Promise<Opener> {
  const spoken = await stages.speak(line, cfg, AbortSignal.timeout(OPENER_SYNTH_MS));
  const stripper = isWavOrPcm(spoken.contentType) ? new WavStripper() : null;
  const parts: Uint8Array[] = [];
  for await (const chunk of spoken.body) parts.push(stripper ? stripper.push(chunk) : chunk);
  const audio = new Uint8Array(Buffer.concat(parts));
  if (!audio.length) throw new Error('empty opener audio');
  if (!stripper) return { audio, encoding: spoken.contentType, sampleRate: null, provider: spoken.provider };
  const sampleRate = stripper.sampleRate ?? 24_000;
  return { audio: trimLead(audio, sampleRate), encoding: 'pcm_s16le', sampleRate, provider: spoken.provider };
}

export function warmOpeners(stages: StageClient, cfg: S2SConfig): void {
  for (const line of openerLines(cfg)) {
    const key = openerKey(cfg, line);
    if (openers.has(key)) continue;
    while (openers.size >= MAX_OPENERS) openers.delete(openers.keys().next().value as string);
    const entry: { ready: Opener | null } = { ready: null };
    openers.set(key, entry);
    synthOpener(stages, cfg, line).then((ready) => { entry.ready = ready; }, () => { if (openers.get(key) === entry) openers.delete(key); });
  }
}

function pickOpener(cfg: S2SConfig): (Opener & { index: number; text: string }) | null {
  const lines = openerLines(cfg);
  const start = Math.floor((cfg.messages?.length ?? 0) / 2);
  for (let step = 0; step < lines.length; step++) {
    const index = (start + step) % lines.length;
    const ready = openers.get(openerKey(cfg, lines[index]))?.ready;
    if (ready) return { ...ready, index, text: lines[index] };
  }
  return null;
}

interface TurnReport { first_sound_ms: number | null; opener: string | null; deadline_ms: number; deadline_missed: boolean; endpoint_ms: number }

const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

export async function runComposite(opts: CompositeOptions): Promise<CompositeResult> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const { config } = opts;
  const deadlineMs = Math.min(MAX_FIRST_AUDIO_DEADLINE_MS,
    positive(config.first_audio_deadline_ms) ?? opts.deadlineMs ?? positive(Number(process.env.FIRST_AUDIO_DEADLINE_MS)) ?? 2_000);
  const marginMs = opts.marginMs ?? positive(Number(process.env.FIRST_AUDIO_MARGIN_MS)) ?? 300;
  const endpointMs = Math.round(positive(config.endpoint_ms) ?? 0);
  const report: TurnReport = { first_sound_ms: null, opener: null, deadline_ms: deadlineMs, deadline_missed: false, endpoint_ms: endpointMs };
  const enforced = config.first_audio_deadline_ms !== undefined || openerLines(config).length > 0;
  const hedgeMs = () => (enforced ? Math.max(STAGE_HEDGE_MIN_MS, deadlineMs - endpointMs - ms()) : undefined);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const due = (at: number, last: boolean) => { timer = setTimeout(() => onDue(last), Math.max(0, at - endpointMs - ms())); };
  const onDue = (last: boolean) => {
    timer = null;
    if (report.first_sound_ms !== null || opts.signal.aborted) return;
    const picked = last ? null : pickOpener(config);
    if (picked) {
      report.opener = picked.text;
      report.first_sound_ms = ms();
      opts.emitEvent({ type: 'audio_format', encoding: picked.encoding, ...(picked.sampleRate ? { sample_rate: picked.sampleRate } : {}), provider: picked.provider });
      opts.emitEvent({
        type: 'opener', state: 'start', text: picked.text, index: picked.index, at_ms: report.first_sound_ms,
        audio_ms: picked.sampleRate ? Math.round((picked.audio.length / 2 / picked.sampleRate) * 1000) : null,
      });
      opts.emitAudio(picked.audio);
      opts.emitEvent({ type: 'opener', state: 'end', index: picked.index });
    } else if (last) {
      report.deadline_missed = true;
      opts.emitEvent({ type: 'deadline_missed', deadline_ms: deadlineMs, at_ms: ms() });
    } else {
      due(deadlineMs, true);
    }
  };
  if (!opts.skipDeadline) {
    warmOpeners(opts.stages, config);
    due(deadlineMs - marginMs, false);
  }
  try {
    return await compose(opts, ms, report, hedgeMs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function compose(opts: CompositeOptions, ms: () => number, report: TurnReport, hedgeMs: () => number | undefined): Promise<CompositeResult> {
  const { stages, config, signal } = opts;

  let transcript = opts.transcript?.text ?? '';
  if (!opts.transcript) {
    const heard = await stages.transcribe(opts.audio, opts.contentType, config, signal, hedgeMs());
    transcript = heard.text.trim();
    opts.emitEvent({ type: 'transcript', text: transcript, stt_ms: ms(), at_ms: ms(), provider: heard.provider, fallback: heard.fallback });
    if (heard.filtered?.length) opts.emitEvent({ type: 'filtered', stage: 'stt', reasons: heard.filtered });
  }
  if (!transcript) {
    opts.emitEvent({ type: 'done', reply: '', transcript: '', first_audio_ms: null, total_ms: ms(), empty: true, ...report });
    return { transcript: '', reply: '', replyRaw: '', firstAudioMs: null, missingAudio: 0 };
  }

  const user = userTurn(config, transcript);
  const ctx = positive(Number(process.env.S2S_CHAT_CONTEXT)) ?? DEFAULT_SLOT_CTX;
  const fitted = (harder: boolean) => fitHistory(config.system, config.messages ?? [], user, config.max_tokens ?? 160, ctx, harder);
  const ask = (history: ChatMessage[]) => stages.chatStream([
    ...(config.system ? [{ role: 'system', content: config.system }] : []),
    ...history,
    { role: 'user', content: user },
  ], config, signal, hedgeMs());
  const history = fitted(false);
  const chat = await ask(history).catch((err: unknown) => {
    const fewer = fitted(true);
    if (!CONTEXT_OVERFLOW.test(String((err as Error)?.message)) || fewer.length === history.length) throw err;
    return ask(fewer);
  });

  // Sentences in speaking order; each one's audio is synthesized as soon as a slot is free (ttsParallel ahead).
  type Spoken = { text: string; cutAt: number; audio: Promise<SpokenAudio | Error> };
  const queue: Spoken[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const parallel = Math.max(1, opts.ttsParallel ?? 2);
  let running = 0;
  const waiters: Array<() => void> = [];
  const slot = async () => {
    while (running >= parallel) await new Promise<void>(r => waiters.push(r));
    running++;
  };
  const release = () => { running--; waiters.shift()?.(); };
  const reply: string[] = [];
  let raw = '';

  const speakLater = (text: string): Spoken => {
    const audio = (async () => {
      await slot();
      try {
        return await stages.speak(text, config, signal, hedgeMs());
      } catch (err) {
        release();
        return err instanceof Error ? err : new Error(String(err));
      }
    })();
    return { text, cutAt: ms(), audio };
  };

  let thinkError: Error | null = null;
  const think = (async () => {
    const cutter = new SentenceCutter();
    const field = config.speak_field ? createJsonFieldExtractor(config.speak_field) : null;
    let fieldClosed = false;
    let firstToken = true;
    const say = (texts: string[]) => { for (const text of texts) { reply.push(text); queue.push(speakLater(text)); notify(); } };
    try {
      for await (const delta of chat.deltas) {
        raw += delta;
        if (firstToken) {
          firstToken = false;
          opts.emitEvent({ type: 'llm_first_token', at_ms: ms(), provider: chat.provider, fallback: chat.fallback });
        }
        if (!field) { say(cutter.push(delta)); continue; }
        if (fieldClosed) continue;
        const part = field.push(delta);
        say(cutter.push(part.text));
        if (part.closed) { fieldClosed = true; say(cutter.end()); }
      }
      if (!fieldClosed) say(cutter.end());
    } catch (err) {
      thinkError = err instanceof Error ? err : new Error(String(err));
    } finally {
      finished = true;
      notify();
    }
  })();

  let firstAudio: number | null = null;
  let missingAudio = 0;
  let sentRate: number | null = null;
  let audioMs = 0;
  let index = 0;
  for (;;) {
    if (index >= queue.length) {
      if (finished) break;
      await new Promise<void>(r => { wake = r; });
      continue;
    }
    const item = queue[index++];
    opts.emitEvent({ type: 'sentence', text: item.text, cut_at_ms: item.cutAt });
    const spoken = await item.audio;
    if (spoken instanceof Error) {
      missingAudio++;
      opts.emitEvent({ type: 'sentence_failed', text: item.text, message: spoken.message.slice(0, 200) });
      continue;
    }
    try {
      const stripper = isWavOrPcm(spoken.contentType) ? new WavStripper() : null;
      for await (const chunk of spoken.body) {
        const pcm = stripper ? stripper.push(chunk) : chunk;
        if (!pcm.length) continue;
        const rate = stripper?.sampleRate ?? 24_000;
        const afterOpener = firstAudio === null && report.opener !== null;
        if (stripper && (rate !== sentRate || afterOpener)) {
          sentRate = rate;
          opts.emitEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: rate, provider: spoken.provider });
        } else if (!stripper && (sentRate !== -1 || afterOpener)) {
          sentRate = -1;
          opts.emitEvent({ type: 'audio_format', encoding: spoken.contentType, provider: spoken.provider });
        }
        if (firstAudio === null) {
          firstAudio = ms();
          report.first_sound_ms ??= firstAudio;
          opts.emitEvent({ type: 'first_audio', at_ms: firstAudio, provider: spoken.provider, fallback: spoken.fallback });
        }
        if (stripper) audioMs += (pcm.length / 2 / rate) * 1000;
        opts.emitAudio(pcm);
      }
      opts.emitEvent({ type: 'sentence_end' });
    } catch (err) {
      missingAudio++;
      opts.emitEvent({ type: 'sentence_failed', text: item.text, message: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    } finally {
      release();
    }
  }
  await think;
  if (thinkError && reply.length === 0) throw thinkError;
  if (thinkError) opts.emitEvent({ type: 'error', stage: 'llm', message: (thinkError as Error).message.slice(0, 300), partial: true, at_ms: ms() });
  opts.emitEvent({
    type: 'done', reply: reply.join(' '), transcript, first_audio_ms: firstAudio, total_ms: ms(), ...report,
    ...(config.speak_field ? { reply_raw: raw } : {}),
    ...(missingAudio ? { missing_audio: missingAudio } : {}),
    sentences: index, spoken: index - missingAudio, skipped: missingAudio, audio_ms: Math.round(audioMs),
  });
  return { transcript, reply: reply.join(' '), replyRaw: raw, firstAudioMs: firstAudio, missingAudio };
}
