import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import {
  PCM_CHUNK_MIN_BYTES, QWEN_CLONE_MODEL, TTS_CALL_TIMEOUT_MS, TTS_MAX_SPEED, TtsStream, catchUpSpeed, deploymentClone, kokoroTts, kokoroVoice, mp3DurationMs,
  pcmOfWavStream, pcmToWav, qwenCloneTts, qwenSpeaks, trimSilence, trimStreamSilence, wavDurationMs, type TtsClip,
} from '../../../src/tts';
import { DeploymentError } from '../../../src/deployments/controller-state';

type Synth = (req: { input: string; model: string; voice: string; responseFormat?: string; speed?: number; stream?: boolean; signal?: AbortSignal; extra?: Record<string, unknown> }) => Promise<{ audio: Buffer; contentType: string; stream?: ReadableStream<Uint8Array> }>;

let n = 0;
const link = (synthesize: Synth) => {
  const provider = { providerId: `kokoro-test-${++n}`, getModels: () => [], getVoices: () => [], isConfigured: () => true, synthesizeStream: () => Promise.reject(new Error('no stream')), synthesize: vi.fn(synthesize) };
  return { providerId: provider.providerId, provider, model: 'hexgrad/kokoro-82m' };
};
const breakers = () => new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
const mp3 = async () => ({ audio: Buffer.from([1, 2, 3]), contentType: 'audio/mpeg' });
const wav = (pcm: Buffer) => async () => ({ audio: pcmToWav(pcm), contentType: 'audio/wav' });
const streamOf = (pieces: Buffer[]) => new ReadableStream<Uint8Array>({ start(c) { for (const p of pieces) c.enqueue(new Uint8Array(p)); c.close(); } });
const collect = async (pcm: AsyncIterable<Buffer>) => { const out: Buffer[] = []; for await (const p of pcm) out.push(p); return Buffer.concat(out); };
const s16 = (samples: number[]) => { const b = Buffer.alloc(samples.length * 2); samples.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
const tone = (n: number) => Array.from({ length: n }, (_, i) => Math.round(8000 * Math.sin(i / 5)) || 2000);
const quiet = (n: number) => Array(n).fill(3);
async function* pieces(buf: Buffer, size: number) { for (let at = 0; at < buf.length; at += size) yield buf.subarray(at, at + size); }

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('gateway TTS module', () => {
  it('maps languages to Kokoro voices by primary subtag', () => {
    expect(kokoroVoice('fr')).toBe('ff_siwis');
    expect(kokoroVoice('pt-BR')).toBe('pf_dora');
    expect(kokoroVoice('en')).toBe('af_heart');
    expect(kokoroVoice('de')).toBeNull();
  });

  it('asks the link for Kokoro as a WAV stream with the language voice, and the speed only when it is not 1', async () => {
    const pcm = Buffer.alloc(200, 1);
    const l = link(wav(pcm));
    const tts = kokoroTts(() => [l as never], breakers());
    await expect(tts('Bonjour', 'fr-FR')).resolves.toEqual({ audio: pcmToWav(pcm), format: 'wav' });
    await tts('hi', 'en', 1.2);
    await tts('hi', 'en', 1);
    const calls = l.provider.synthesize.mock.calls.map(c => c[0]);
    expect(calls[0]).toMatchObject({ input: 'Bonjour', model: 'hexgrad/kokoro-82m', voice: 'ff_siwis', responseFormat: 'wav', stream: true });
    expect(calls.map(c => c.speed)).toEqual([undefined, 1.2, undefined]);
    await expect(tts('Hallo', 'de')).rejects.toThrow(/no voice for de/);
  });

  it('never sends a sentence twice: a slow link is waited for, the next one is not called', async () => {
    const slow = link(() => new Promise(res => setTimeout(() => res({ audio: pcmToWav(Buffer.from('slow')), contentType: 'audio/wav' }), 10_000)));
    const other = link(mp3);
    const tts = kokoroTts(() => [slow as never, other as never], breakers());
    const clip = tts('Bonjour', 'fr');
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(clip).resolves.toEqual({ audio: pcmToWav(Buffer.from('slow')), format: 'wav' });
    expect(other.provider.synthesize).not.toHaveBeenCalled();
  });

  it('turns a streamed WAV into aligned PCM pieces, header stripped, odd bytes carried over', async () => {
    const pcm = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
    const whole = pcmToWav(pcm);
    const pieces = [whole.subarray(0, 10), whole.subarray(10, 47), whole.subarray(47, 101), whole.subarray(101)];
    const l = link(async () => ({ audio: Buffer.alloc(0), contentType: 'audio/wav', stream: streamOf(pieces) }));
    const clip = await kokoroTts(() => [l as never], breakers())('Bonjour', 'fr');
    expect(clip.format).toBe('pcm');
    const out: Buffer[] = [];
    for await (const p of clip.pcm!) out.push(p);
    expect(out.every(p => p.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(out)).toEqual(pcm);
  });

  it('gives up on a PCM stream that stops sending', async () => {
    const stuck = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(pcmToWav(Buffer.alloc(100)))); } });
    const read = collect(pcmOfWavStream(stuck, 1_000));
    const failed = expect(read).rejects.toThrow(/no audio for 1000 ms/);
    await vi.advanceTimersByTimeAsync(1_001);
    await failed;
  });

  it('streams the head sentence as its pieces arrive and holds the next one until the head ends', async () => {
    const gates: Array<{ push: (b: Buffer) => void; end: () => void }> = [];
    const streamed = (): TtsClip => {
      const queue: Buffer[] = [];
      let wake: (() => void) | null = null;
      let ended = false;
      gates.push({ push: b => { queue.push(b); wake?.(); }, end: () => { ended = true; wake?.(); } });
      return {
        audio: Buffer.alloc(0), format: 'pcm',
        pcm: (async function* () {
          for (;;) {
            if (queue.length) { yield queue.shift()!; continue; }
            if (ended) return;
            await new Promise<void>(r => { wake = r; });
          }
        })(),
      };
    };
    const events: string[] = [];
    const stream = new TtsStream({
      now: () => Date.now(),
      synthesize: async () => streamed(),
      deliver: (id, clip, isStreamed) => { events.push(`clip ${id} ${clip.format} ${isStreamed} ${clip.audio.length - 44}`); return true; },
      deliverChunk: (id, pcm, seq) => { events.push(`chunk ${id}.${seq} ${pcm.length}`); return true; },
      dropped: () => {},
    });
    const piece = Buffer.alloc(PCM_CHUNK_MIN_BYTES, 1);
    stream.push(1, 0);
    stream.push(2, 0);
    await vi.advanceTimersByTimeAsync(0);
    gates[1]!.push(piece);
    gates[0]!.push(piece);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([`chunk 1.0 ${piece.length}`]);
    gates[0]!.push(Buffer.alloc(10, 1));
    gates[0]!.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([`chunk 1.0 ${piece.length}`, 'chunk 1.1 10', `clip 1 wav true ${piece.length + 10}`, `chunk 2.0 ${piece.length}`]);
    gates[1]!.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toBe(`clip 2 wav true ${piece.length}`);
  });

  it('delivers nothing for a stream that ends without audio and moves on to the next sentence', async () => {
    const events: string[] = [];
    const clips = [streamOf([]), streamOf([pcmToWav(Buffer.alloc(PCM_CHUNK_MIN_BYTES, 1))])];
    const stream = new TtsStream({
      now: () => Date.now(),
      synthesize: async () => ({ audio: Buffer.alloc(0), format: 'pcm', pcm: pcmOfWavStream(clips.shift()!) }),
      deliver: (id) => { events.push(`clip ${id}`); return true; },
      deliverChunk: (id, _pcm, seq) => { events.push(`chunk ${id}.${seq}`); return true; },
      dropped: () => {},
    });
    stream.push(1, 0);
    stream.push(2, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['chunk 2.0', 'clip 2']);
  });

  it('aborts a stuck call after TTS_CALL_TIMEOUT_MS', async () => {
    let aborted: AbortSignal | undefined;
    const stuck = link(({ signal }) => { aborted = signal; return new Promise(() => {}); });
    const clip = kokoroTts(() => [stuck as never], breakers())('Bonjour', 'fr');
    const failed = expect(clip).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(TTS_CALL_TIMEOUT_MS + 1);
    await failed;
    expect(aborted?.aborted).toBe(true);
  });

  it('speaks faster the more audio is queued, up to TTS_MAX_SPEED', () => {
    expect(catchUpSpeed(-500)).toBe(1);
    expect(catchUpSpeed(0)).toBe(1);
    expect(catchUpSpeed(4_000)).toBe(1.2);
    expect(catchUpSpeed(60_000)).toBe(TTS_MAX_SPEED);
  });

  it('measures an mp3 by its frames (VBR, several pieces glued, ID3 tag)', () => {
    const frame = (kbpsIndex: number, bytes: number) => {
      const f = Buffer.alloc(bytes);
      f.writeUInt32BE((0x7ff << 21 | 2 << 19 | 1 << 17 | 1 << 16 | kbpsIndex << 12 | 1 << 10) >>> 0);
      return f;
    };
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const audio = Buffer.concat([id3, ...Array(10).fill(frame(8, 192)), ...Array(10).fill(frame(4, 96))]);
    expect(mp3DurationMs(audio)).toBeCloseTo(480, 6);
    expect(mp3DurationMs(Buffer.from('not audio'))).toBe(0);
  });

  it("asks the clone deployment for one WAV per sentence in the speaker's timbre only (no accent, no reference text) and the target language", async () => {
    const l = link(async () => ({ audio: Buffer.from('RIFF'), contentType: 'audio/wav' }));
    const other = link(mp3);
    const tts = qwenCloneTts(() => [{ ...l, model: QWEN_CLONE_MODEL } as never, other as never], breakers());
    const voice = { refAudio: 'data:audio/ogg;base64,T2dnUw==', refText: 'olá a todos' };
    await expect(tts('Hallo zusammen', 'de-DE', voice)).resolves.toEqual({ audio: Buffer.from('RIFF'), format: 'wav' });
    expect(l.provider.synthesize.mock.calls[0]![0]).toMatchObject({
      input: 'Hallo zusammen', model: QWEN_CLONE_MODEL, responseFormat: 'wav',
      extra: { task_type: 'Base', ref_audio: voice.refAudio, x_vector_only_mode: true, language: 'de' },
    });
    expect(l.provider.synthesize.mock.calls[0]![0].extra).not.toHaveProperty('ref_text');
    expect(other.provider.synthesize).not.toHaveBeenCalled();
    await expect(tts('नमस्ते', 'hi', voice)).rejects.toThrow(/does not speak hi/);
    expect(l.provider.synthesize.mock.calls[0]![0]).toMatchObject({ stream: true });
    const speech = s16([...quiet(24_000), ...tone(4_800), ...quiet(24_000)]);
    const streamed = link(async () => ({ audio: Buffer.alloc(0), stream: new Response(Buffer.concat([Buffer.alloc(44), speech])).body!, contentType: 'audio/wav' }) as never);
    const clip = await qwenCloneTts(() => [streamed as never], breakers())('Hallo', 'de', voice);
    expect(clip.format).toBe('pcm');
    expect((await collect(clip.pcm!)).length).toBe((4_800 + 4_800 + 4_800) * 2);
    expect(['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt-BR', 'es', 'it'].every(qwenSpeaks)).toBe(true);
    expect(qwenSpeaks('hi')).toBe(false);
  });

  it('retries a clone the model did not finish (HTTP 500) once on the same deployment', async () => {
    const runaway = Object.assign(new Error('Qwen3-TTS Base did not emit codec EOS before its token budget'), { status: 500 });
    let calls = 0;
    const l = { ...link(async () => { calls++; if (calls === 1) throw runaway; return { audio: Buffer.from('RIFF'), contentType: 'audio/wav' }; }), providerId: 'deployment:clone-test' };
    const clip = qwenCloneTts(() => [l as never], breakers())('Hallo', 'de', { refAudio: 'data:audio/wav;base64,UklGRg==', refText: 'olá' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(clip).resolves.toEqual({ audio: Buffer.from('RIFF'), format: 'wav' });
    expect(calls).toBe(2);
  });

  it('never wakes the clone deployment: no ready replica = not ready, and a call fails at once without waking it', async () => {
    const wake = vi.fn();
    const acquire = vi.fn(async () => { throw new DeploymentError(503, 'no ready replica (no-wake: not woken)', 30); });
    let replicas: Array<{ phase: string }> = [];
    const controller = { acquire, wake, get: () => ({ replicas }) };
    const clone = deploymentClone(controller as never, 'babelcast-tts-clone', breakers());
    expect(clone.ready()).toBe(false);
    replicas = [{ phase: 'booting' }];
    expect(clone.ready()).toBe(false);
    replicas = [{ phase: 'ready' }];
    expect(clone.ready()).toBe(true);
    await expect(clone.synthesize('Bonjour', 'fr', { refAudio: 'data:audio/wav;base64,UklGRg==', refText: 'olá' })).rejects.toThrow();
    expect(acquire).toHaveBeenCalledWith('babelcast-tts-clone', expect.objectContaining({ noWake: true, waitMs: 0 }));
    expect(wake).not.toHaveBeenCalled();
  });

  it('a streamed clone voice loses its silence at both ends as it arrives, keeping 200 ms, and keeps pauses inside', async () => {
    const audio = s16([...quiet(24_000), ...tone(2_400), ...quiet(12_000), ...tone(2_400), ...quiet(36_000)]);
    const out = await collect(trimStreamSilence(pieces(audio, 2_002)));
    expect(out.length).toBe((4_800 + 2_400 + 12_000 + 2_400 + 4_800) * 2);
    expect(await collect(trimStreamSilence(pieces(s16(quiet(48_000)), 4_000)))).toEqual(Buffer.alloc(0));
  });

  it('trims the silence a clone starts and ends with, keeping 200 ms around the speech', () => {
    const rate = 24_000;
    const samples = [...Array(rate).fill(0), ...Array.from({ length: rate }, (_, i) => Math.round(8000 * Math.sin(i / 5))), ...Array(2 * rate).fill(3)];
    const wav = Buffer.alloc(44 + samples.length * 2);
    wav.write('RIFF', 0, 'latin1'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8, 'latin1');
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36, 'latin1');
    wav.writeUInt32LE(samples.length * 2, 40);
    samples.forEach((s, i) => wav.writeInt16LE(s, 44 + i * 2));
    const trimmed = trimSilence(wav);
    expect(wavDurationMs(wav)).toBe(4000);
    expect(wavDurationMs(trimmed)).toBe(1400);
    expect(trimmed.readUInt32LE(40)).toBe(trimmed.length - 44);
    expect(trimmed.readUInt32LE(4)).toBe(trimmed.length - 8);
    expect(trimSilence(Buffer.from('not audio'))).toEqual(Buffer.from('not audio'));
  });

  it('measures a WAV by its header byte rate', () => {
    const wav = Buffer.alloc(44 + 48_000);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(48_000, 28);
    expect(wavDurationMs(wav)).toBe(1000);
    expect(wavDurationMs(Buffer.from('not audio'))).toBe(0);
  });
});
