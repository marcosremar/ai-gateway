/**
 * The two clip rungs, used when no realtime transport connects: one learner turn = one recorded clip (16 kHz WAV from
 * `@parle/ai-gateway/voice`), sent over HTTP.
 *
 * - `s2s-stream`: POST multipart `file` + `config` to the app's backend, which forwards it to the gateway's `/v1/s2s`
 *   with its key (the browser never holds the gateway key). The answer is read as it streams — binary frames
 *   (src/s2s/frames.ts) or NDJSON — and its audio plays as it arrives.
 * - `post`: the caller's own `postTurn` (a plain request/response endpoint), the last rung.
 *
 * Both map their answers onto the realtime event vocabulary, so the page sees one protocol whatever the rung.
 */
import { FrameDecoder, type S2SEvent } from '../../../../src/s2s/frames';
import { createPcmPlayer, type PcmPlayer } from '../audio-io';
import type { ChatMessage, ClientMessage, RealtimeEvent, RealtimeTransport, TransportContext } from '../types';

export interface S2SEndpoint {
  /** The app backend route that relays to the gateway's `/v1/s2s`. */
  url: string;
  /** Extra request options for the app's backend (credentials, headers). */
  init?: RequestInit;
  format?: 'binary' | 'ndjson';
}

export interface PostTurnResult {
  transcript?: string;
  reply?: string;
  /** Encoded audio (wav, mp3, ogg…) of the reply. */
  audio?: Blob | ArrayBuffer | null;
}

export type PostTurn = (wav: Blob, ctx: { config: Record<string, unknown>; messages: ChatMessage[]; traceparent: string; signal: AbortSignal }) => Promise<PostTurnResult>;

type PlayerFactory = (opts: { rate: number }) => Promise<PcmPlayer>;

/** Maps one s2s event onto the realtime vocabulary (null = nothing to show). */
export function mapS2SEvent(e: S2SEvent): RealtimeEvent[] {
  switch (e.type) {
    case 'route': return [{ type: 'route', provider: String(e.provider ?? ''), ...(e.fallback ? { fallback: String(e.fallback) } : {}) }];
    case 'transcript': return [{ type: 'transcript', text: String(e.text ?? ''), final: true }];
    case 'filtered': return [{ type: 'filtered', reasons: Array.isArray(e.reasons) ? e.reasons.map(String) : [] }];
    case 'sentence': return [{ type: 'reply_delta', text: String(e.text ?? '') }];
    case 'first_audio': return [{ type: 'audio_start' }];
    case 'opener': return [{
      type: 'opener', state: e.state === 'end' ? 'end' : 'start', ...(typeof e.text === 'string' ? { text: e.text } : {}),
      ...(typeof e.index === 'number' ? { index: e.index } : {}), ...(typeof e.audio_ms === 'number' ? { audio_ms: e.audio_ms } : {}),
    }];
    case 'deadline_missed': return [{ type: 'deadline_missed', deadline_ms: Number(e.deadline_ms) }];
    case 'error': return [{
      type: 'error', code: String(e.stage ?? e.code ?? 's2s'), message: String(e.message ?? 'error'),
      ...(typeof e.unspoken === 'string' && e.unspoken ? { unspoken: e.unspoken } : {}),
    }];
    case 'done': {
      const out: RealtimeEvent[] = [];
      if (typeof e.reply === 'string' && e.reply) out.push({ type: 'reply', text: e.reply });
      out.push({
        type: 'metrics', ttfa_ms: typeof e.first_audio_ms === 'number' ? e.first_audio_ms : null,
        ...(typeof e.first_sound_ms === 'number' ? { first_sound_ms: e.first_sound_ms } : {}),
        ...(typeof e.opener === 'string' ? { opener: e.opener } : {}),
        ...(typeof e.deadline_missed === 'boolean' ? { deadline_missed: e.deadline_missed } : {}),
      });
      out.push({ type: 'done', ...(e.empty ? { empty: true } : {}), ...(e.filtered ? { filtered: true } : {}), ...(e.partial ? { error: true } : {}) });
      return out;
    }
    default: return [];
  }
}

abstract class ClipTransport implements RealtimeTransport {
  abstract readonly type: 's2s-stream' | 'post';
  readonly clipBased = true;
  protected player: PcmPlayer | null = null;
  protected turn: AbortController | null = null;

  constructor(protected readonly ctx: TransportContext, private readonly makePlayer: PlayerFactory) {}

  async connect(): Promise<void> {
    // Nothing to open: the first turn proves the rung (a failing turn fails over and is re-sent below).
  }

  protected async getPlayer(rate: number): Promise<PcmPlayer> {
    if (!this.player) this.player = await this.makePlayer({ rate });
    return this.player;
  }

  send(message: ClientMessage): void {
    if (message.type !== 'interrupt') return; // history lives in the session; end_turn comes as the clip itself
    const playing = this.player?.playing || this.turn;
    this.turn?.abort(new Error('interrupted'));
    this.turn = null;
    this.player?.flush();
    if (playing) this.ctx.emit({ type: 'interrupted' });
  }

  protected begin(): AbortSignal {
    this.turn?.abort(new Error('superseded'));
    this.turn = new AbortController();
    return AbortSignal.any ? AbortSignal.any([this.turn.signal, AbortSignal.timeout(this.ctx.timeouts.turnMs)]) : this.turn.signal;
  }

  protected async endAudio(sawAudio: boolean): Promise<void> {
    if (!sawAudio) return;
    await this.player?.idle();
    this.ctx.emit({ type: 'audio_end' });
  }

  abstract sendTurn(wav: Blob): Promise<void>;

  close(): void {
    this.turn?.abort(new Error('closed'));
    this.turn = null;
    this.player?.close();
    this.player = null;
  }
}

class S2SStreamTransport extends ClipTransport {
  readonly type = 's2s-stream' as const;

  constructor(ctx: TransportContext, private readonly endpoint: S2SEndpoint, makePlayer: PlayerFactory) { super(ctx, makePlayer); }

  async sendTurn(wav: Blob): Promise<void> {
    const signal = this.begin();
    const form = new FormData();
    form.set('file', wav, 'turn.wav');
    form.set('config', JSON.stringify(this.ctx.config()));
    const format = this.endpoint.format ?? 'binary';
    const url = format === 'ndjson' ? `${this.endpoint.url}${this.endpoint.url.includes('?') ? '&' : '?'}format=ndjson` : this.endpoint.url;
    const headers = new Headers(this.endpoint.init?.headers);
    headers.set('traceparent', this.ctx.traceparent);
    const res = await this.ctx.fetchImpl(url, { ...this.endpoint.init, method: 'POST', body: form, headers, signal });
    if (!res.ok || !res.body) throw new Error(`s2s answered HTTP ${res.status}`);
    let rate = 24_000;
    let encoded: string | null = null; // a non-PCM audio_format: chunks are a container, decoded per sentence
    let pending: Uint8Array[] = [];
    let sawAudio = false;
    let inOpener = false;
    let played = false;
    const end = { done: false, error: false, sentence: '', skipped: [] as string[] };
    const flushEncoded = async () => {
      if (!pending.length) return;
      const size = pending.reduce((n, c) => n + c.length, 0);
      const all = new Uint8Array(size);
      let at = 0;
      for (const c of pending) { all.set(c, at); at += c.length; }
      pending = [];
      await (await this.getPlayer(rate)).pushEncoded(all.buffer);
    };
    const onEvent = async (e: S2SEvent) => {
      if (e.type === 'audio_format') {
        await flushEncoded();
        encoded = e.encoding === 'pcm_s16le' || e.encoding === undefined ? null : String(e.encoding);
        if (typeof e.sample_rate === 'number') rate = e.sample_rate;
        return;
      }
      if (e.type === 'sentence') end.sentence = String(e.text ?? '');
      if (e.type === 'sentence_failed') end.skipped.push(String(e.text ?? ''));
      if (e.type === 'error') end.error = true;
      if (e.type === 'done') {
        await flushEncoded();
        end.done = true;
        const unspoken = end.skipped.join(' ').trim();
        const incomplete = !e.partial && !end.error && (unspoken || Number(e.skipped) > 0 || Number(e.spoken) < Number(e.sentences));
        if (incomplete) {
          this.ctx.emit({ type: 'error', code: 'truncated', message: 'the reply ended with sentences not voiced', ...(unspoken ? { unspoken } : {}) });
        }
        if (incomplete || e.partial || end.error) {
          await this.player?.idle();
          for (const out of mapS2SEvent({ ...e, partial: true })) this.ctx.emit(out);
          return;
        }
      }
      if (e.type === 'sentence_end') await flushEncoded();
      if (e.type === 'opener') {
        inOpener = e.state === 'start';
        if (!inOpener) await flushEncoded();
      }
      if (e.type === 'first_audio') {
        if (sawAudio) return; // the audio itself came first and already announced it
        sawAudio = true;
      }
      for (const out of mapS2SEvent(e)) this.ctx.emit(out);
    };
    const onAudio = async (pcm: Uint8Array) => {
      played = true;
      if (!sawAudio && !inOpener) { sawAudio = true; this.ctx.emit({ type: 'audio_start' }); }
      end.sentence = '';
      if (encoded) { pending.push(pcm.slice()); return; }
      const even = pcm.length - (pcm.length % 2);
      const view = new DataView(pcm.buffer, pcm.byteOffset, even);
      const samples = new Int16Array(even / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
      (await this.getPlayer(rate)).pushPcm16(samples, rate);
    };

    const reader = res.body.getReader();
    const decoder = new FrameDecoder();
    const text = new TextDecoder();
    let lineBuf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (format === 'ndjson') {
        lineBuf += text.decode(value, { stream: true });
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as S2SEvent;
          if (e.type === 'audio' && typeof e.pcm === 'string') await onAudio(Uint8Array.from(atob(e.pcm), c => c.charCodeAt(0)));
          else await onEvent(e);
        }
      } else {
        for (const frame of decoder.push(value)) {
          if (frame.kind === 'audio') await onAudio(frame.pcm);
          else await onEvent(frame.event);
        }
      }
    }
    if (!end.done && !signal.aborted) {
      if (!end.error) {
        this.ctx.emit({ type: 'error', code: 'truncated', message: 's2s stream ended without done', ...(end.sentence ? { unspoken: end.sentence } : {}) });
      }
      await this.player?.idle();
      this.ctx.emit({ type: 'done', error: true });
    }
    this.turn = null;
    await this.endAudio(played);
  }
}

class PostTransport extends ClipTransport {
  readonly type = 'post' as const;

  constructor(ctx: TransportContext, private readonly postTurn: PostTurn, makePlayer: PlayerFactory) { super(ctx, makePlayer); }

  async sendTurn(wav: Blob): Promise<void> {
    const signal = this.begin();
    const config = this.ctx.config();
    const messages = Array.isArray(config.messages) ? config.messages as ChatMessage[] : [];
    const out = await this.postTurn(wav, { config, messages, traceparent: this.ctx.traceparent, signal });
    if (signal.aborted) return;
    if (typeof out.transcript === 'string') this.ctx.emit({ type: 'transcript', text: out.transcript, final: true });
    if (typeof out.reply === 'string') this.ctx.emit({ type: 'reply', text: out.reply });
    let sawAudio = false;
    if (out.audio) {
      const data = out.audio instanceof Blob ? await out.audio.arrayBuffer() : out.audio;
      sawAudio = true;
      this.ctx.emit({ type: 'audio_start' });
      await (await this.getPlayer(24_000)).pushEncoded(data);
    }
    this.ctx.emit({ type: 'done', ...(out.transcript === '' ? { empty: true } : {}) });
    this.turn = null;
    await this.endAudio(sawAudio);
  }
}

export function createS2SStreamTransport(ctx: TransportContext, endpoint: S2SEndpoint, makePlayer: PlayerFactory = createPcmPlayer): RealtimeTransport {
  return new S2SStreamTransport(ctx, endpoint, makePlayer);
}

export function createPostTransport(ctx: TransportContext, postTurn: PostTurn, makePlayer: PlayerFactory = createPcmPlayer): RealtimeTransport {
  return new PostTransport(ctx, postTurn, makePlayer);
}
