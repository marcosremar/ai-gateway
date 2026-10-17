import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import {
  QWEN_CLONE_MODEL, TTS_CALL_TIMEOUT_MS, TTS_MAX_SPEED, catchUpSpeed, deploymentClone, kokoroTts, kokoroVoice, mp3DurationMs, qwenCloneTts, qwenSpeaks, wavDurationMs,
} from '../../../src/tts';
import { DeploymentError } from '../../../src/deployments/controller-state';

type Synth = (req: { input: string; model: string; voice: string; responseFormat?: string; speed?: number; signal?: AbortSignal; extra?: Record<string, unknown> }) => Promise<{ audio: Buffer; contentType: string }>;

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

  it("asks the clone deployment for one WAV per sentence with the speaker's reference and the target language", async () => {
    const l = link(async () => ({ audio: Buffer.from('RIFF'), contentType: 'audio/wav' }));
    const other = link(mp3);
    const tts = qwenCloneTts(() => [{ ...l, model: QWEN_CLONE_MODEL } as never, other as never], breakers());
    const voice = { refAudio: 'data:audio/ogg;base64,T2dnUw==', refText: 'olá a todos' };
    await expect(tts('Hallo zusammen', 'de-DE', voice)).resolves.toEqual({ audio: Buffer.from('RIFF'), format: 'wav' });
    expect(l.provider.synthesize.mock.calls[0]![0]).toMatchObject({
      input: 'Hallo zusammen', model: QWEN_CLONE_MODEL, responseFormat: 'wav',
      extra: { task_type: 'Base', ref_audio: voice.refAudio, ref_text: voice.refText, language: 'de' },
    });
    expect(other.provider.synthesize).not.toHaveBeenCalled();
    await expect(tts('नमस्ते', 'hi', voice)).rejects.toThrow(/does not speak hi/);
    expect(['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt-BR', 'es', 'it'].every(qwenSpeaks)).toBe(true);
    expect(qwenSpeaks('hi')).toBe(false);
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

  it('measures a WAV by its header byte rate', () => {
    const wav = Buffer.alloc(44 + 48_000);
    wav.write('RIFF', 0, 'latin1');
    wav.writeUInt32LE(48_000, 28);
    expect(wavDurationMs(wav)).toBe(1000);
    expect(wavDurationMs(Buffer.from('not audio'))).toBe(0);
  });
});
