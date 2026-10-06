import type { S2SConfig, SpokenAudio, StageClient } from '../../../src/s2s/composite';
import { encodeAudio, encodeEvent, FrameDecoder, type S2SEvent } from '../../../src/s2s/frames';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 44-byte WAV header (size fields 0xFFFFFFFF like a streamed vLLM-Omni answer) + PCM. */
export function wav(pcm: Uint8Array, rate = 24_000): Uint8Array {
  const head = new Uint8Array(44);
  const v = new DataView(head.buffer);
  head.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
  v.setUint32(4, 0xffffffff, true);
  head.set([...'WAVE'].map(c => c.charCodeAt(0)), 8);
  head.set([...'fmt '].map(c => c.charCodeAt(0)), 12);
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  head.set([...'data'].map(c => c.charCodeAt(0)), 36);
  v.setUint32(40, 0xffffffff, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(head); out.set(pcm, 44);
  return out;
}

async function* chunked(bytes: Uint8Array, size: number, delayMs = 0): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) {
    if (delayMs) await sleep(delayMs);
    yield bytes.slice(i, i + size);
  }
}

export interface FakeStagesOptions {
  heard?: string;
  reply?: string;
  sttMs?: number;
  tokenMs?: number;
  ttsMs?: number;
  failTtsFor?: string;
  failSttWith?: string;
  breakLlmAfter?: number;
}

/** Stage client with call log: STT returns `heard`, the LLM streams `reply` in 3-char tokens, TTS returns WAV whose
 *  PCM is the sentence's UTF-8 bytes (so the test can read back what was voiced). */
export function fakeStages(o: FakeStagesOptions = {}) {
  const calls: Array<{ stage: string; at: number; text?: string; cfg?: S2SConfig }> = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const stages: StageClient = {
    async transcribe(_audio, _ct, cfg) {
      calls.push({ stage: 'stt', at: at(), cfg });
      await sleep(o.sttMs ?? 5);
      if (o.failSttWith) throw new Error(o.failSttWith);
      return { text: o.heard ?? 'Bom dia, eu queria um pão.', provider: 'deployment:parle-speech', fallback: null };
    },
    async chatStream(messages, cfg) {
      calls.push({ stage: 'llm', at: at(), text: messages[messages.length - 1].content, cfg });
      const reply = o.reply ?? 'Bom dia, querida! Aqui está o seu pão.';
      async function* deltas() {
        for (let i = 0, n = 0; i < reply.length; i += 3, n++) {
          if (o.breakLlmAfter !== undefined && n >= o.breakLlmAfter) throw new Error('llm stream broke');
          await sleep(o.tokenMs ?? 2);
          yield reply.slice(i, i + 3);
        }
      }
      return { deltas: deltas(), provider: 'openrouter:qwen/qwen3.5-9b', fallback: 'cold' };
    },
    async speak(text): Promise<SpokenAudio> {
      calls.push({ stage: 'tts', at: at(), text });
      await sleep(o.ttsMs ?? 5);
      if (o.failTtsFor && text.includes(o.failTtsFor)) throw new Error('tts 503');
      return { body: chunked(wav(new TextEncoder().encode(text)), 7, 1), contentType: 'audio/wav', provider: 'deployment:parle-qwen-tts', fallback: null };
    },
  };
  return { stages, calls };
}

/** Frames a fake speech-stack replica sends for one turn. */
export function replicaFrames(heard: string, sentences: string[]): Uint8Array[] {
  const out: Uint8Array[] = [encodeEvent({ type: 'transcript', text: heard, stt_ms: 10, at_ms: 10 }, 'binary')];
  for (const s of sentences) {
    out.push(encodeEvent({ type: 'sentence', text: s, cut_at_ms: 20 }, 'binary'));
    out.push(encodeAudio(new TextEncoder().encode(s), 'binary'));
  }
  out.push(encodeEvent({ type: 'done', reply: sentences.join(' '), transcript: heard, total_ms: 30 }, 'binary'));
  return out;
}

export function decodeAll(bytes: Uint8Array): { events: S2SEvent[]; audio: string } {
  const frames = new FrameDecoder().push(bytes);
  return {
    events: frames.filter(f => f.kind === 'event').map(f => (f as { event: S2SEvent }).event),
    audio: new TextDecoder().decode(Buffer.concat(frames.filter(f => f.kind === 'audio').map(f => Buffer.from((f as { pcm: Uint8Array }).pcm)))),
  };
}
