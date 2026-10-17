import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { TTS_CALL_TIMEOUT_MS, TTS_MAX_SPEED, catchUpSpeed, kokoroTts, kokoroVoice, mp3DurationMs } from '../../../src/tts';

type Synth = (req: { input: string; model: string; voice: string; responseFormat?: string; speed?: number; signal?: AbortSignal }) => Promise<{ audio: Buffer; contentType: string }>;

let n = 0;
const link = (synthesize: Synth) => {
  const provider = { providerId: `kokoro-test-${++n}`, getModels: () => [], getVoices: () => [], isConfigured: () => true, synthesizeStream: () => Promise.reject(new Error('no stream')), synthesize: vi.fn(synthesize) };
  return { providerId: provider.providerId, provider, model: 'hexgrad/kokoro-82m' };
};
const breakers = () => new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 });
const mp3 = async () => ({ audio: Buffer.from([1, 2, 3]), contentType: 'audio/mpeg' });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('gateway TTS module', () => {
  it('maps languages to Kokoro voices by primary subtag', () => {
    expect(kokoroVoice('fr')).toBe('ff_siwis');
    expect(kokoroVoice('pt-BR')).toBe('pf_dora');
    expect(kokoroVoice('en')).toBe('af_heart');
    expect(kokoroVoice('de')).toBeNull();
  });

  it('asks the link for Kokoro in mp3 with the language voice, and the speed only when it is not 1', async () => {
    const l = link(mp3);
    const tts = kokoroTts(() => [l as never], breakers());
    await expect(tts('Bonjour', 'fr-FR')).resolves.toEqual({ audio: Buffer.from([1, 2, 3]), format: 'mp3' });
    await tts('hi', 'en', 1.2);
    await tts('hi', 'en', 1);
    const calls = l.provider.synthesize.mock.calls.map(c => c[0]);
    expect(calls[0]).toMatchObject({ input: 'Bonjour', model: 'hexgrad/kokoro-82m', voice: 'ff_siwis', responseFormat: 'mp3' });
    expect(calls.map(c => c.speed)).toEqual([undefined, 1.2, undefined]);
    await expect(tts('Hallo', 'de')).rejects.toThrow(/no voice for de/);
  });

  it('never sends a sentence twice: a slow link is waited for, the next one is not called', async () => {
    const slow = link(() => new Promise(res => setTimeout(() => res({ audio: Buffer.from('slow'), contentType: 'audio/mpeg' }), 10_000)));
    const other = link(mp3);
    const tts = kokoroTts(() => [slow as never, other as never], breakers());
    const clip = tts('Bonjour', 'fr');
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(clip).resolves.toEqual({ audio: Buffer.from('slow'), format: 'mp3' });
    expect(other.provider.synthesize).not.toHaveBeenCalled();
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
});
