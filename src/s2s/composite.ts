/**
 * The composed speech-to-speech pipeline: the gateway's own stage routes chained in one streamed answer.
 *
 *   audio ─► STT (parle-stt chain) ─► LLM tokens (parle-llm chain, streamed) ─► SentenceCutter
 *         ─► TTS per sentence (parle-tts chain, up to `ttsParallel` ahead) ─► events + audio, in speaking order
 *
 * Every stage keeps its own fallback chain, hedge, circuit breaker and time budget (provider-routing.ts): this module
 * only orders them and streams. It is the fallback of a speech-stack deployment and can also resume one that broke
 * after the transcript (`transcript` option: skip STT, start at the LLM).
 */

import type { S2SEvent } from './frames';
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
  /** Ask the LLM for JSON (`{"type":"json_object"}`): only `speak_field` is voiced, the whole JSON comes in `done`. */
  response_format?: { type: string };
  /** Field of the JSON answer that is spoken (e.g. "utterance"). Without it the whole answer is spoken. */
  speak_field?: string;
}

export interface StageAnswer { provider: string | null; fallback: string | null }

export interface SpokenAudio extends StageAnswer {
  /** Audio bytes as they arrive: WAV (header parsed here), raw PCM, or an encoded format reported as such. */
  body: AsyncIterable<Uint8Array>;
  contentType: string;
}

/** The three stages, behind the gateway's routing. Implemented over loopback HTTP in production, faked in tests. */
export interface StageClient {
  transcribe(audio: Uint8Array, contentType: string, cfg: S2SConfig, signal: AbortSignal): Promise<StageAnswer & { text: string }>;
  chatStream(messages: ChatMessage[], cfg: S2SConfig, signal: AbortSignal): Promise<StageAnswer & { deltas: AsyncIterable<string> }>;
  speak(text: string, cfg: S2SConfig, signal: AbortSignal): Promise<SpokenAudio>;
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

export async function runComposite(opts: CompositeOptions): Promise<CompositeResult> {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const ms = () => Math.round(now() - t0);
  const { stages, config, signal } = opts;

  let transcript = opts.transcript?.text ?? '';
  if (!opts.transcript) {
    const heard = await stages.transcribe(opts.audio, opts.contentType, config, signal);
    transcript = heard.text.trim();
    opts.emitEvent({ type: 'transcript', text: transcript, stt_ms: ms(), at_ms: ms(), provider: heard.provider, fallback: heard.fallback });
  }
  if (!transcript) {
    opts.emitEvent({ type: 'done', reply: '', transcript: '', first_audio_ms: null, total_ms: ms(), empty: true });
    return { transcript: '', reply: '', replyRaw: '', firstAudioMs: null, missingAudio: 0 };
  }

  const messages: ChatMessage[] = [
    ...(config.system ? [{ role: 'system', content: config.system }] : []),
    ...(config.messages ?? []),
    { role: 'user', content: transcript },
  ];
  const chat = await stages.chatStream(messages, config, signal);

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
        return await stages.speak(text, config, signal);
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
        if (stripper && rate !== sentRate) {
          sentRate = rate;
          opts.emitEvent({ type: 'audio_format', encoding: 'pcm_s16le', sample_rate: rate, provider: spoken.provider });
        } else if (!stripper && sentRate !== -1) {
          sentRate = -1;
          opts.emitEvent({ type: 'audio_format', encoding: spoken.contentType, provider: spoken.provider });
        }
        if (firstAudio === null) {
          firstAudio = ms();
          opts.emitEvent({ type: 'first_audio', at_ms: firstAudio, provider: spoken.provider, fallback: spoken.fallback });
        }
        opts.emitAudio(pcm);
      }
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
    type: 'done', reply: reply.join(' '), transcript, first_audio_ms: firstAudio, total_ms: ms(),
    ...(config.speak_field ? { reply_raw: raw } : {}),
    ...(missingAudio ? { missing_audio: missingAudio } : {}),
  });
  return { transcript, reply: reply.join(' '), replyRaw: raw, firstAudioMs: firstAudio, missingAudio };
}
