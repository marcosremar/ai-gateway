/**
 * Server-side dubbing of live rooms with Pocket TTS (src/rooms/dub.ts, src/tts `pocketTts`): the speaker's cloned voice
 * first while the clone GPU serves, then Pocket for the languages it speaks (en fr de pt es it nl, one native voice
 * each), Kokoro for the others and whenever Pocket answers 503 loading/busy or fails; Kokoro alone without the key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRoomStore, RoomService, roomsConfigFromEnv } from '../../../src/rooms';
import { CircuitBreakerRegistry } from '../../../src/gateway/providers/cloud/circuit-breaker';
import { POCKET_VOICES } from '../../../src/gateway/providers/cloud/kokoro-stream/route-tts';
import { pcmToWav, pocketTts, wavDurationMs, type TtsClip, type VoiceRef } from '../../../src/tts';
import type { LiveRoom, RoomViewer } from '../../../src/rooms/service';
import type { RoomLine, RoomServerMessage } from '../../../src/rooms/types';

const WAIT = 100;

interface FakeViewer extends RoomViewer { msgs: RoomServerMessage[] }

function viewer(listen: string): FakeViewer {
  const v: FakeViewer = {
    msgs: [],
    send: (t) => { v.msgs.push(JSON.parse(t) as RoomServerMessage); },
    close: () => {},
    wantsAudio: (lang) => lang === listen,
    listening: (lang) => lang === listen,
    reading: (lang) => lang === listen,
  };
  return v;
}

const audios = (v: FakeViewer) => v.msgs.filter((m): m is Extract<RoomServerMessage, { type: 'audio' }> => m.type === 'audio');
const said = (v: FakeViewer) => audios(v).map(a => Buffer.from(a.wav, 'base64').toString());

const line = (id: number, translations: Record<string, string> = { fr: `bonjour ${id}.` }): RoomLine =>
  ({ id, original: `olá ${id}`, originalLang: 'pt', translations, ts: 1_000 + id });

const loading = () => Object.assign(new Error('503 pocket fr is loading'), { status: 503, code: 'loading' });

type Tts = (text: string, lang: string, speed?: number) => Promise<TtsClip>;

let kokoro: ReturnType<typeof vi.fn<Tts>>;
let pocket: ReturnType<typeof vi.fn<Tts>>;
let clone: ReturnType<typeof vi.fn<(text: string, lang: string, voice: VoiceRef) => Promise<TtsClip>>>;
let pocketOn: boolean;
let cloneReady: boolean;
let log: ReturnType<typeof vi.fn<(msg: string, data?: Record<string, unknown>) => void>>;
let service: RoomService;
const voice: VoiceRef = { refAudio: 'data:audio/ogg;base64,T2dnUw==', refText: 'olá a todos' };

async function room(languages: string[]): Promise<LiveRoom> {
  const { code } = await service.create({ title: 't', originalLang: 'pt', languages, serverDub: true, youtubeUrl: null }, 'u');
  return (await service.get(code))!;
}

beforeEach(() => {
  vi.useFakeTimers();
  pocketOn = true;
  cloneReady = false;
  log = vi.fn<(msg: string, data?: Record<string, unknown>) => void>();
  kokoro = vi.fn(async (text: string) => ({ audio: Buffer.from(`kokoro:${text}`), format: 'mp3' }));
  pocket = vi.fn(async (text: string) => ({ audio: Buffer.from(`pocket:${text}`), format: 'wav' }));
  clone = vi.fn(async (text: string) => ({ audio: Buffer.from(`clone:${text}`), format: 'wav' }));
  service = new RoomService({
    config: { ...roomsConfigFromEnv({}), dir: null, serverDubWaitMs: WAIT, serverDubPresenterQuietMs: 60_000 },
    store: new MemoryRoomStore(), sweepIntervalMs: 0, log, synthesize: kokoro,
    translate: async (text, _from, to) => `${to}:${text}`,
    pocket: { synthesize: pocket, available: () => pocketOn },
    clone: { synthesize: clone, ready: () => cloneReady },
  });
});
afterEach(() => { service.stop(); vi.useRealTimers(); });

describe('rooms server dubbing with Pocket TTS', () => {
  it('voices pt, fr and en with Pocket, with no speed (Pocket has none); Kokoro is not called', async () => {
    const r = await room(['en', 'fr', 'pt']);
    const listeners = ['en', 'fr', 'pt'].map(viewer);
    for (const v of listeners) service.addViewer(r, v);
    await service.publishLine(r, { ...line(1, { en: 'hello 1.', fr: 'bonjour 1.', pt: 'olá 1.' }), original: 'hola a todos', originalLang: 'es', speechMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pocket.mock.calls).toEqual([['hello 1.', 'en'], ['bonjour 1.', 'fr'], ['olá 1.', 'pt']]);
    expect(kokoro).not.toHaveBeenCalled();
    expect(listeners.map(said)).toEqual([['pocket:hello 1.'], ['pocket:bonjour 1.'], ['pocket:olá 1.']]);
  });

  it('offers the Pocket languages Kokoro lacks (de, nl) and voices German with Pocket', async () => {
    const r = await room(['en', 'de']);
    expect(service.publicView(r).dubLangs).toEqual(['en', 'de', 'fr', 'es', 'it', 'ja', 'zh', 'hi', 'nl']);
    expect(service.publicView(r).listenLangs).toEqual(['fr', 'es', 'it', 'ja', 'zh', 'hi', 'nl']);
    const de = viewer('de');
    service.addViewer(r, de);
    await service.publishLine(r, line(1, { en: 'hello 1.', de: 'hallo 1.' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pocket).toHaveBeenCalledWith('hallo 1.', 'de');
    expect(said(de)).toEqual(['pocket:hallo 1.']);
  });

  it("falls back to Kokoro, at the speaker's pace, when Pocket answers 503 loading or fails", async () => {
    pocket.mockRejectedValueOnce(loading()).mockRejectedValueOnce(new Error('pocket: empty audio'));
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, { ...line(1), original: 'a nossa principal preocupação', speechMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(pocket).toHaveBeenCalledTimes(3);
    expect(kokoro.mock.calls).toEqual([['bonjour 1.', 'fr', 1.2], ['bonjour 2.', 'fr', 1]]);
    expect(said(fr)).toEqual(['kokoro:bonjour 1.', 'kokoro:bonjour 2.', 'pocket:bonjour 3.']);
    expect(audios(fr).map(a => a.engine)).toEqual(['kokoro', 'kokoro', 'pocket']);
    expect(log).toHaveBeenCalledWith('rooms: Pocket failed, Kokoro instead', expect.objectContaining({ lang: 'fr', lineId: 1, error: '503 pocket fr is loading' }));
  });

  it('a language only Pocket speaks loses the voice of a line Pocket cannot answer (no Kokoro voice for it)', async () => {
    pocket.mockRejectedValueOnce(loading());
    const r = await room(['de']);
    const de = viewer('de');
    service.addViewer(r, de);
    await service.publishLine(r, line(1, { de: 'hallo 1.' }));
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(2, { de: 'hallo 2.' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(kokoro).not.toHaveBeenCalled();
    expect(said(de)).toEqual(['pocket:hallo 2.']);
  });

  it('voices a language Pocket does not speak (ja) with Kokoro', async () => {
    const r = await room(['ja', 'fr']);
    const ja = viewer('ja');
    service.addViewer(r, ja);
    await service.publishLine(r, line(1, { ja: 'こんにちは。', fr: 'bonjour 1.' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pocket).not.toHaveBeenCalled();
    expect(kokoro).toHaveBeenCalledWith('こんにちは。', 'ja', 1);
    expect(said(ja)).toEqual(['kokoro:こんにちは。']);
  });

  it('without the Pocket key: Kokoro alone, with its languages only (as before)', async () => {
    pocketOn = false;
    const r = await room(['fr', 'de']);
    expect(service.publicView(r).dubLangs).toEqual(['fr', 'en', 'es', 'it', 'ja', 'zh', 'hi']);
    service.addViewer(r, viewer('fr'));
    service.addViewer(r, viewer('de'));
    await service.publishLine(r, line(1, { fr: 'bonjour 1.', de: 'hallo 1.' }));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(pocket).not.toHaveBeenCalled();
    expect(kokoro.mock.calls.map(c => [c[0], c[1]])).toEqual([['bonjour 1.', 'fr']]);
  });

  it("the speaker's cloned voice comes first while the clone GPU serves; Pocket when the clone fails", async () => {
    cloneReady = true;
    clone.mockImplementation(async (text: string, lang: string) => {
      if (lang === 'de') throw new Error('did not emit codec EOS');
      return { audio: Buffer.from(`clone:${text}`), format: 'wav' };
    });
    const r = await room(['fr', 'de']);
    const fr = viewer('fr');
    const de = viewer('de');
    service.addViewer(r, fr);
    service.addViewer(r, de);
    service.setVoice(r, { lang: 'pt', ...voice });
    await service.publishLine(r, line(1, { fr: 'bonjour 1.', de: 'hallo 1.' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(clone.mock.calls.map(c => [c[0], c[1]])).toEqual([['bonjour 1.', 'fr'], ['hallo 1.', 'de']]);
    expect(pocket.mock.calls).toEqual([['hallo 1.', 'de']]);
    expect(kokoro).not.toHaveBeenCalled();
    expect(said(fr)).toEqual(['clone:bonjour 1.']);
    expect(said(de)).toEqual(['pocket:hallo 1.']);
    expect([...audios(fr), ...audios(de)].map(a => a.engine)).toEqual(['clone', 'pocket']);
  });

  it('a reference with the clone GPU parked: Pocket, not the clone', async () => {
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    service.setVoice(r, { lang: 'pt', ...voice });
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(clone).not.toHaveBeenCalled();
    expect(said(fr)).toEqual(['pocket:bonjour 1.']);
  });

  it('asks Pocket for one line at a time per language (it speaks one sentence at a time); Kokoro stays parallel', async () => {
    const r = await room(['fr', 'ja']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    service.addViewer(r, viewer('ja'));
    const releases: (() => void)[] = [];
    pocket.mockImplementation(async (text: string) => new Promise<TtsClip>(res => releases.push(() => res({ audio: Buffer.from(`pocket:${text}`), format: 'wav' }))));
    kokoro.mockImplementation(() => new Promise<TtsClip>(() => {}));
    for (let id = 1; id <= 3; id++) await service.publishLine(r, line(id, { fr: `bonjour ${id}.`, ja: `こんにちは ${id}。` }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pocket.mock.calls.map(c => c[0])).toEqual(['bonjour 1.']);
    expect(kokoro).toHaveBeenCalledTimes(3);
    for (let n = 2; n <= 3; n++) {
      releases.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(pocket.mock.calls.map(c => c[0])).toEqual(Array.from({ length: n }, (_, i) => `bonjour ${i + 1}.`));
    }
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(said(fr)).toEqual(['pocket:bonjour 1.', 'pocket:bonjour 2.', 'pocket:bonjour 3.']);
  });
});

describe('pocketTts', () => {
  const provider = (impl: (req: Record<string, unknown>) => Promise<unknown>) => ({
    providerId: 'pocket', getModels: () => [], getVoices: () => [], isConfigured: () => true,
    synthesizeStream: () => Promise.reject(new Error('no stream')),
    synthesize: vi.fn(impl),
  });

  it("asks the speech server for the language's own Pocket voice, as streamed WAV, with no speed", async () => {
    const p = provider(async () => ({ audio: pcmToWav(Buffer.from('pcm!')), contentType: 'audio/wav' }));
    const tts = pocketTts(() => [{ providerId: 'pocket', provider: p as never, model: 'pocket' }], new CircuitBreakerRegistry({ failureThreshold: 5, resetTimeoutMs: 30_000 }));
    const voices = [['pt-BR', 'rafael'], ['fr', 'estelle'], ['en', 'alba'], ['de', 'juergen'], ['es', 'lola'], ['it', 'giovanni'], ['nl', 'daan']] as const;
    for (const [lang, name] of voices) {
      expect((await tts('Olá.', lang, 1.2)).format).toBe('wav');
      expect(p.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({
        input: 'Olá.', voice: name, model: 'pocket', responseFormat: 'wav', stream: true, extra: { language: lang.slice(0, 2) },
      }));
      expect(p.synthesize.mock.lastCall![0]).not.toHaveProperty('speed');
      // The voice was recorded in that language (en: Pocket's default English voice).
      expect(POCKET_VOICES[name]).toBe(lang.slice(0, 2));
    }
    await expect(tts('こんにちは', 'ja')).rejects.toThrow(/does not speak ja/);
  });

  it('a 503 loading or busy never opens the breaker (the server is fine, the language is not ready); a 500 does', async () => {
    const breakers = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeoutMs: 30_000 });
    let code = 'loading';
    const p = provider(async () => { throw Object.assign(new Error(`503 ${code}`), { status: 503, code }); });
    const tts = pocketTts(() => [{ providerId: 'pocket', provider: p as never, model: 'pocket' }], breakers);
    for (let i = 0; i < 3; i++) await expect(tts('Hallo.', 'de')).rejects.toThrow();
    code = 'busy';
    for (let i = 0; i < 3; i++) await expect(tts('Hallo.', 'de')).rejects.toThrow();
    expect(p.synthesize).toHaveBeenCalledTimes(6);
    const broken = provider(async () => { throw Object.assign(new Error('500 boom'), { status: 500 }); });
    const failing = pocketTts(() => [{ providerId: 'pocket', provider: broken as never, model: 'pocket' }], breakers);
    for (let i = 0; i < 4; i++) await expect(failing('Hallo.', 'de')).rejects.toThrow();
    expect(broken.synthesize).toHaveBeenCalledTimes(2);
  });
});

describe('ROOM_DUB_STEADY: every voice keeps up with the speaker without skipping lines', () => {
  const RATE = 24_000;
  const loud = (seconds: number) => {
    const pcm = Buffer.alloc(RATE * seconds * 2);
    for (let i = 0; i < RATE * seconds; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
    return pcmToWav(pcm, RATE);
  };
  const withSilence = (seconds: number) => {
    const pcm = Buffer.alloc(RATE * (seconds + 2) * 2);
    for (let i = RATE; i < RATE * (seconds + 1); i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
    return pcmToWav(pcm, RATE);
  };
  const durations = (v: FakeViewer) => audios(v).map(a => Math.round(wavDurationMs(Buffer.from(a.wav, 'base64'))));
  const long = 'nous allons maintenant parler des chiffres du trimestre et de la croissance';
  let condense: ReturnType<typeof vi.fn<(text: string, lang: string) => Promise<string>>>;

  function steadyService(steady: boolean): RoomService {
    service.stop();
    condense = vi.fn(async () => 'chiffres du trimestre et croissance');
    return new RoomService({
      config: { ...roomsConfigFromEnv({ ROOM_DUB_STEADY: steady ? '1' : '' }), dir: null, serverDubWaitMs: WAIT, serverDubPresenterQuietMs: 60_000 },
      store: new MemoryRoomStore(), sweepIntervalMs: 0, log, synthesize: kokoro,
      pocket: { synthesize: pocket, available: () => true }, condense,
    });
  }

  it('is off unless ROOM_DUB_STEADY is set', () => {
    expect(roomsConfigFromEnv({}).serverDubSteady).toBe(false);
    expect(roomsConfigFromEnv({ ROOM_DUB_STEADY: '1' }).serverDubSteady).toBe(true);
  });

  it('lets the page queue 10 s of voice only with the flag', async () => {
    service = steadyService(true);
    expect(service.publicView(await room(['fr'])).dubBacklogS).toBe(10);
    service = steadyService(false);
    expect(service.publicView(await room(['fr'])).dubBacklogS).toBeUndefined();
  });

  it('trims the silence around a Pocket clip', async () => {
    service = steadyService(true);
    pocket.mockResolvedValue({ audio: withSilence(3), format: 'wav' });
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(durations(fr)).toEqual([3400]);
  });

  it('behind but under 30 s of queue: Pocket is sped up and the sentence stays whole', async () => {
    service = steadyService(true);
    pocket.mockResolvedValue({ audio: loud(10), format: 'wav' });
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(2, { fr: long }));
    await vi.advanceTimersByTimeAsync(0);
    expect(condense).not.toHaveBeenCalled();
    expect(pocket.mock.calls.map(c => c[0])).toEqual(['bonjour 1.', `${long}.`]);
    expect(durations(fr)[1]).toBeLessThan(8_000);
  });

  it('30 s or more behind: only the voice is shortened, the subtitle stays whole', async () => {
    service = steadyService(true);
    pocket.mockResolvedValue({ audio: loud(31), format: 'wav' });
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(2, { fr: long }));
    await vi.advanceTimersByTimeAsync(0);
    expect(condense).toHaveBeenCalledTimes(1);
    expect(condense).toHaveBeenCalledWith(long, 'fr');
    expect(pocket.mock.calls.map(c => c[0])).toEqual(['bonjour 1.', 'chiffres du trimestre et croissance.']);
    const [first, second] = durations(fr);
    expect(first).toBe(31_000);
    expect(second).toBeLessThan(25_000);
    expect(r.lines.find(l => l.id === 2)?.translations.fr).toBe(long);
  });

  it('a short line is never shortened, and a failed shortening voices the full text', async () => {
    service = steadyService(true);
    pocket.mockResolvedValue({ audio: loud(31), format: 'wav' });
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(0);
    condense.mockRejectedValueOnce(new Error('timeout'));
    await service.publishLine(r, line(3, { fr: long }));
    await vi.advanceTimersByTimeAsync(0);
    expect(pocket.mock.calls.map(c => c[0])).toEqual(['bonjour 1.', 'bonjour 2.', `${long}.`]);
  });

  it('without the flag: same audio as before, nothing shortened', async () => {
    service = steadyService(false);
    pocket.mockResolvedValue({ audio: loud(10), format: 'wav' });
    const r = await room(['fr']);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(0);
    await service.publishLine(r, line(2, { fr: long }));
    await vi.advanceTimersByTimeAsync(0);
    expect(condense).not.toHaveBeenCalled();
    expect(durations(fr)).toEqual([10_000, 10_000]);
  });
});
