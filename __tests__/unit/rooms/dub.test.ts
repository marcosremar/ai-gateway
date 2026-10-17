/**
 * Server-side dubbing of live rooms (src/rooms/dub.ts): the gateway voices a line (Kokoro, mocked here) only for the
 * languages someone listens to, never when the presenter sends its own clips, never for languages Kokoro lacks, voices
 * every final line in order (dropping only past a bounded backlog), and is off with ROOM_SERVER_DUB=0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryRoomStore, ROOM_DUB_MAX_SPEED, ROOM_DUB_QUEUE_MAX, RoomService, dubSpeed, kokoroSynthesize, mp3DurationMs, kokoroVoice, maiSynthesize, roomsConfigFromEnv,
  synthesizeWithFallback, type RoomClip, type RoomsConfig,
} from '../../../src/rooms';
import type { LiveRoom, RoomViewer } from '../../../src/rooms/service';
import type { RoomLine, RoomServerMessage } from '../../../src/rooms/types';
import { parseLine } from '../../../src/rooms/validate';

const WAIT = 100;

interface FakeViewer extends RoomViewer { msgs: RoomServerMessage[]; listen: string | null | undefined; view: string | null | undefined }

function viewer(listen: string | null | undefined, view: string | null | undefined = listen): FakeViewer {
  const v: FakeViewer = {
    msgs: [], listen, view,
    send: (t) => { v.msgs.push(JSON.parse(t) as RoomServerMessage); },
    close: () => {},
    wantsAudio: (lang) => v.listen === undefined || v.listen === lang,
    listening: (lang) => v.listen === lang,
    reading: (lang) => v.view === lang,
  };
  return v;
}

const audios = (v: FakeViewer) => v.msgs.filter((m): m is Extract<RoomServerMessage, { type: 'audio' }> => m.type === 'audio');

const line = (id: number, translations: Record<string, string> = { en: `hello ${id}`, fr: `bonjour ${id}` }): RoomLine =>
  ({ id, original: `olá ${id}`, originalLang: 'pt', translations, ts: 1_000 + id });

let synth: ReturnType<typeof vi.fn<(text: string, lang: string, signal?: AbortSignal) => Promise<RoomClip>>>;
let service: RoomService;

function make(env: Record<string, string> = {}, extra: Partial<RoomsConfig> = {}): RoomService {
  const config: RoomsConfig = {
    ...roomsConfigFromEnv(env), dir: null, serverDubWaitMs: WAIT, serverDubPresenterQuietMs: 60_000, ...extra,
  };
  return new RoomService({ config, store: new MemoryRoomStore(), sweepIntervalMs: 0, synthesize: synth });
}

async function room(s: RoomService, languages = ['en', 'fr', 'de'], serverDub = true): Promise<LiveRoom> {
  const { code } = await s.create({ title: 't', originalLang: 'pt', languages, serverDub }, 'u');
  return (await s.get(code))!;
}

beforeEach(() => {
  vi.useFakeTimers();
  synth = vi.fn(async (text: string) => ({ audio: Buffer.from(`mp3:${text}`), format: 'mp3' }));
  service = make();
});
afterEach(() => { service.stop(); vi.useRealTimers(); });

describe('rooms server dubbing', () => {
  it('maps room languages to Kokoro voices by primary subtag', () => {
    expect(kokoroVoice('fr')).toBe('ff_siwis');
    expect(kokoroVoice('pt-BR')).toBe('pf_dora');
    expect(kokoroVoice('en')).toBe('af_heart');
    expect(kokoroVoice('de')).toBeNull();
  });

  it('voices a line only for the language a viewer listens to, as mp3, at once while the presenter sends no clips', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    const silent = viewer(null);
    const legacy = viewer(undefined); // never sent listen: gets presenter clips, never causes server spend
    for (const v of [fr, silent, legacy]) service.addViewer(r, v);
    await service.publishLine(r, line(1));
    expect(synth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(synth).toHaveBeenCalledWith('bonjour 1', 'fr', undefined, 1);
    expect(audios(fr)).toEqual([{ type: 'audio', lineId: 1, lang: 'fr', wav: Buffer.from('mp3:bonjour 1').toString('base64'), format: 'mp3' }]);
    expect(audios(silent)).toEqual([]);
    expect(audios(legacy)).toEqual([]);
    expect(service.publicView(r).dubLangs).toEqual(['en', 'fr']);
  });

  it('spends nothing when nobody listens', async () => {
    const r = await room(service);
    service.addViewer(r, viewer(null));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).not.toHaveBeenCalled();
  });

  it('keeps voicing the other languages while the presenter dubs one (desktop dubs en, the phone listens to fr)', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    service.publishAudio(r, { lineId: 1, lang: 'en', wav: 'AAAA' });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await service.publishLine(r, line(2));
    service.publishAudio(r, { lineId: 2, lang: 'en', wav: 'AAAA' });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => [c[0], c[1]])).toEqual([['bonjour 1', 'fr'], ['bonjour 2', 'fr']]);
    expect(audios(fr).map(a => a.lineId)).toEqual([1, 2]);
  });

  it('skips a line the presenter voiced, and that language while the presenter sends clips in it', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    service.publishAudio(r, { lineId: 1, lang: 'fr', wav: 'AAAA' });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => c[0])).toEqual(['bonjour 1']);
    expect(audios(fr).map(a => a.lineId)).toEqual([1, 1]);
    expect(audios(fr).at(-1)).toEqual({ type: 'audio', lineId: 1, lang: 'fr', wav: 'AAAA' });
    // The presenter went quiet long enough: the server takes over.
    await vi.advanceTimersByTimeAsync(60_000);
    await service.publishLine(r, line(3));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).toHaveBeenCalledWith('bonjour 3', 'fr', undefined, expect.any(Number));
  });

  it('does not deliver a clip the presenter sent while the server was synthesizing', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    let release: (c: RoomClip) => void = () => {};
    synth.mockImplementationOnce(() => new Promise<RoomClip>(res => { release = res; }));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).toHaveBeenCalledTimes(1);
    service.publishAudio(r, { lineId: 1, lang: 'fr', wav: 'AAAA' });
    release({ audio: Buffer.from('late'), format: 'mp3' });
    await vi.advanceTimersByTimeAsync(1);
    expect(audios(fr).map(a => a.wav)).toEqual(['AAAA']);
  });

  it('skips languages Kokoro does not speak', async () => {
    const r = await room(service);
    service.addViewer(r, viewer('de'));
    await service.publishLine(r, line(1, { de: 'hallo', fr: 'bonjour' }));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).not.toHaveBeenCalled();
    expect(service.publicView(r).dubLangs).not.toContain('de');
  });

  it('skips empty translations', async () => {
    const r = await room(service);
    service.addViewer(r, viewer('fr'));
    await service.publishLine(r, line(1, { fr: '   ' }));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).not.toHaveBeenCalled();
  });

  it('voices every line in order, each once, with its latest text', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    let release: (c: RoomClip) => void = () => {};
    synth.mockImplementationOnce(async (text: string) => new Promise<RoomClip>(res => { release = () => res({ audio: Buffer.from(`mp3:${text}`), format: 'mp3' }); }));
    await service.publishLine(r, line(1));
    await service.publishLine(r, line(2));
    await service.publishLine(r, line(3));
    await service.publishLine(r, line(3, { fr: 'bonjour 3 (corrigé)' }));
    release({ audio: Buffer.alloc(0), format: 'mp3' });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => c[0])).toEqual(['bonjour 1', 'bonjour 2', 'bonjour 3 (corrigé)']);
    await service.publishLine(r, line(3, { fr: 'encore' }));
    await service.publishLine(r, line(2, { fr: 'en retard' }));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).toHaveBeenCalledTimes(3);
    expect(audios(fr).map(a => a.lineId)).toEqual([1, 2, 3]);
  });

  it('keeps one call in flight per language and voices the lines that arrived meanwhile, in order', async () => {
    const r = await room(service);
    service.addViewer(r, viewer('fr'));
    let release: (c: RoomClip) => void = () => {};
    synth.mockImplementationOnce(() => new Promise<RoomClip>(res => { release = res; }));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await service.publishLine(r, line(2));
    await service.publishLine(r, line(3));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).toHaveBeenCalledTimes(1);
    release({ audio: Buffer.from('one'), format: 'mp3' });
    await vi.advanceTimersByTimeAsync(0);
    expect(synth.mock.calls.map(c => c[0])).toEqual(['bonjour 1', 'bonjour 2', 'bonjour 3']);
  });

  it('falls behind by at most ROOM_DUB_QUEUE_MAX lines: the oldest waiting one is dropped', async () => {
    const log = vi.fn();
    service.stop();
    service = new RoomService({ config: { ...roomsConfigFromEnv({}), dir: null, serverDubWaitMs: WAIT, serverDubPresenterQuietMs: 60_000 }, store: new MemoryRoomStore(), sweepIntervalMs: 0, log, synthesize: synth });
    const r = await room(service);
    service.addViewer(r, viewer('fr'));
    let release: (c: RoomClip) => void = () => {};
    synth.mockImplementationOnce(() => new Promise<RoomClip>(res => { release = res; }));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    for (let id = 2; id <= ROOM_DUB_QUEUE_MAX + 2; id++) await service.publishLine(r, line(id));
    expect(log).toHaveBeenCalledWith('rooms: server dub dropped stale line', expect.objectContaining({ lang: 'fr', lineId: 2 }));
    release({ audio: Buffer.from('one'), format: 'mp3' });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => c[0])).toEqual(['bonjour 1', ...Array.from({ length: ROOM_DUB_QUEUE_MAX }, (_, i) => `bonjour ${i + 3}`)]);
  });

  it('waits for the final version of a growing line and voices its final text', async () => {
    const r = await room(service);
    const en = viewer('en');
    service.addViewer(r, en);
    await service.publishLine(r, { ...line(1, { en: 'The churn rate remains our main' }), draft: true });
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).not.toHaveBeenCalled();
    await service.publishLine(r, line(1, { en: 'The churn rate remains our main concern' }));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => [c[0], c[1]])).toEqual([['The churn rate remains our main concern', 'en']]);
    expect(audios(en).map(a => a.lineId)).toEqual([1]);
  });

  it('keeps draft only when the presenter sends draft: true', () => {
    const cfg = roomsConfigFromEnv({});
    const body = { id: 1, original: 'olá', translations: { en: 'hi' } };
    expect(parseLine({ ...body, draft: true }, cfg, 0).draft).toBe(true);
    expect(parseLine(body, cfg, 0)).not.toHaveProperty('draft');
    expect(parseLine({ ...body, draft: 'yes' }, cfg, 0)).not.toHaveProperty('draft');
  });

  it('speaks faster the more audio the listeners still have queued, up to ROOM_DUB_MAX_SPEED', async () => {
    expect(dubSpeed(-500)).toBe(1);
    expect(dubSpeed(0)).toBe(1);
    expect(dubSpeed(4_000)).toBe(1.2);
    expect(dubSpeed(60_000)).toBe(ROOM_DUB_MAX_SPEED);
    const frame = Buffer.alloc(192);
    frame.writeUInt32BE((0x7ff << 21 | 2 << 19 | 1 << 17 | 1 << 16 | 8 << 12 | 1 << 10) >>> 0);
    const fourSeconds = Buffer.concat(Array(167).fill(frame));
    synth.mockImplementation(async (text: string) => ({ audio: text === 'bonjour 1' ? fourSeconds : frame, format: 'mp3' }));
    const r = await room(service);
    service.addViewer(r, viewer('fr'));
    await service.publishLine(r, line(1));
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => [c[0], c[3]])).toEqual([['bonjour 1', 1], ['bonjour 2', 1.2]]);
  });

  it('measures an mp3 by its frames (VBR, several pieces glued, ID3 tag)', () => {
    const frame = (kbpsIndex: number, bytes: number) => {
      const f = Buffer.alloc(bytes);
      f.writeUInt32BE((0x7ff << 21 | 2 << 19 | 1 << 17 | 1 << 16 | kbpsIndex << 12 | 1 << 10) >>> 0);
      return f;
    };
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const mp3 = Buffer.concat([id3, ...Array(10).fill(frame(8, 192)), ...Array(10).fill(frame(4, 96))]);
    expect(mp3DurationMs(mp3)).toBeCloseTo(480, 6);
    expect(mp3DurationMs(Buffer.from('not audio'))).toBe(0);
  });

  it('asks Kokoro for the speed, never MAI-Voice', async () => {
    const provider = { synthesize: vi.fn(async () => ({ audio: Buffer.from('mp3') })) };
    await kokoroSynthesize(provider)('hi', 'en', undefined, 1.2);
    await kokoroSynthesize(provider)('hi', 'en', undefined, 1);
    await maiSynthesize(provider)('hi', 'en', undefined, 1.2);
    expect(provider.synthesize.mock.calls.map(c => (c as unknown as [{ speed?: number }])[0].speed)).toEqual([1.2, undefined, undefined]);
  });

  describe('languages the presenter does not publish', () => {
    let translate: ReturnType<typeof vi.fn<(text: string, from: string | null, to: string) => Promise<string>>>;
    beforeEach(() => {
      translate = vi.fn(async (text: string, _from: string | null, to: string) => `${to}:${text}`);
      service.stop();
      service = new RoomService({
        config: { ...roomsConfigFromEnv({}), dir: null, serverDubWaitMs: WAIT, serverDubPresenterQuietMs: 60_000 },
        store: new MemoryRoomStore(), sweepIntervalMs: 0, synthesize: synth, translate,
      });
    });
    const lines = (v: FakeViewer) => v.msgs.filter((m): m is Extract<RoomServerMessage, { type: 'line' }> => m.type === 'line').map(m => m.line);

    it('offers every other Kokoro language and translates then voices one for its listener', async () => {
      const r = await room(service, ['en', 'fr']);
      expect(service.publicView(r).listenLangs).toEqual(['es', 'it', 'ja', 'zh', 'hi']);
      expect(service.publicView(r).dubLangs).toEqual(['en', 'fr', 'es', 'it', 'ja', 'zh', 'hi']);
      const es = viewer('es');
      service.addViewer(r, es);
      await service.publishLine(r, line(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(translate).toHaveBeenCalledWith('olá 1', 'pt', 'es');
      expect(synth).toHaveBeenCalledWith('es:olá 1', 'es', undefined, 1);
      expect(audios(es).map(a => a.lineId)).toEqual([1]);
      expect(lines(es).at(-1)?.translations).toEqual({ en: 'hello 1', fr: 'bonjour 1', es: 'es:olá 1' });
      expect(r.lines[0]!.translations.es).toBe('es:olá 1');
    });

    it('translates for a viewer who only reads the language, without voicing it', async () => {
      const r = await room(service, ['en', 'fr']);
      const es = viewer(null, 'es');
      service.addViewer(r, es);
      await service.publishLine(r, line(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(translate).toHaveBeenCalledTimes(1);
      expect(synth).not.toHaveBeenCalled();
      expect(lines(es).at(-1)?.translations.es).toBe('es:olá 1');
    });

    it('catches up from the latest line when a viewer switches to the language', async () => {
      const r = await room(service, ['en', 'fr']);
      const v = viewer(null, null);
      service.addViewer(r, v);
      await service.publishLine(r, line(1));
      await service.publishLine(r, line(2));
      v.listen = 'it';
      v.view = 'it';
      service.viewerLanguageChanged(r);
      await vi.advanceTimersByTimeAsync(0);
      expect(translate.mock.calls.map(c => [c[0], c[2]])).toEqual([['olá 2', 'it']]);
      expect(audios(v).map(a => a.lineId)).toEqual([2]);
    });

    it('never translates into the spoken language nor without a translator', async () => {
      const r = await room(service, ['en', 'fr']);
      expect(service.publicView(r).listenLangs).not.toContain('pt');
      service.addViewer(r, viewer('pt'));
      await service.publishLine(r, line(1));
      await vi.advanceTimersByTimeAsync(WAIT + 1);
      expect(translate).not.toHaveBeenCalled();
      expect(synth).not.toHaveBeenCalled();
      service.stop();
      service = make();
      expect(service.publicView(await room(service, ['en', 'fr'])).listenLangs).toBeUndefined();
    });
  });

  it('logs synthesis failures without breaking publishing', async () => {
    const r = await room(service);
    service.addViewer(r, viewer('fr'));
    synth.mockRejectedValueOnce(new Error('upstream 500'));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await expect(service.publishLine(r, line(2))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).toHaveBeenCalledTimes(2);
  });

  it('is off with the ROOM_SERVER_DUB=0 kill switch (no dubLangs: the page offers every language)', async () => {
    service.stop();
    service = make({ ROOM_SERVER_DUB: '0' });
    const r = await room(service);
    service.addViewer(r, viewer('fr'));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).not.toHaveBeenCalled();
    expect(service.publicView(r).dubLangs).toBeUndefined();
  });

  it('honours a room created with serverDub: false (only presenter clip languages are dubbable)', async () => {
    const r = await room(service, ['en', 'fr'], false);
    service.addViewer(r, viewer('fr'));
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).not.toHaveBeenCalled();
    expect(r.meta.serverDub).toBe(false);
    expect(service.publicView(r).dubLangs).toEqual([]);
    service.publishAudio(r, { lineId: 1, lang: 'en', wav: 'AAAA' });
    expect(service.publicView(r).dubLangs).toEqual(['en']);
  });

  it('kokoroSynthesize asks the provider for Kokoro 82M in mp3, with the voice of the room language', async () => {
    const provider = { synthesize: vi.fn(async () => ({ audio: Buffer.from([1, 2, 3]) })) };
    await expect(kokoroSynthesize(provider)('Bonjour', 'fr-FR')).resolves.toEqual({ audio: Buffer.from([1, 2, 3]), format: 'mp3' });
    expect(provider.synthesize).toHaveBeenCalledWith({ input: 'Bonjour', model: 'hexgrad/kokoro-82m', voice: 'ff_siwis', responseFormat: 'mp3' });
    await expect(maiSynthesize(provider)('Hola', 'es')).rejects.toThrow(/no voice for es/);
  });

  it('a stuck Kokoro call times out into MAI-Voice and does not hold the next line of that language', async () => {
    const TIMEOUT = 5_000;
    let aborted: AbortSignal | undefined;
    const kokoro = vi.fn((text: string, _lang: string, signal?: AbortSignal) => {
      if (text === 'bonjour 1') { aborted = signal; return new Promise<RoomClip>(() => {}); }
      return Promise.resolve({ audio: Buffer.from(`kokoro:${text}`), format: 'mp3' });
    });
    const mai = vi.fn(async (text: string) => ({ audio: Buffer.from(`mai:${text}`), format: 'mp3' }));
    synth = vi.fn(synthesizeWithFallback([kokoro, mai], TIMEOUT));
    service.stop();
    service = make();
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);

    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(kokoro).toHaveBeenCalledTimes(1);
    expect(mai).not.toHaveBeenCalled();
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(aborted?.aborted).toBe(true);
    expect(mai).toHaveBeenCalledWith('bonjour 1', 'fr', expect.any(AbortSignal), 1);
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(audios(fr).map(a => Buffer.from(a.wav, 'base64').toString())).toEqual(['mai:bonjour 1', 'kokoro:bonjour 2']);
  });

  it('every voice stuck: the line fails after one budget per attempt and the next line is voiced', async () => {
    const hang = vi.fn((text: string) => (text === 'bonjour 1' ? new Promise<RoomClip>(() => {}) : Promise.resolve({ audio: Buffer.from(text), format: 'mp3' })));
    const log = vi.fn();
    const config: RoomsConfig = { ...roomsConfigFromEnv({}), dir: null, serverDubWaitMs: WAIT, serverDubPresenterQuietMs: 60_000 };
    service.stop();
    service = new RoomService({ config, store: new MemoryRoomStore(), sweepIntervalMs: 0, log, synthesize: synthesizeWithFallback([hang, hang], 1_000) });
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(2_000 + WAIT + 1);
    expect(log).toHaveBeenCalledWith('rooms: server dub failed', expect.objectContaining({ lineId: 1, error: 'timed out after 1000 ms; timed out after 1000 ms' }));
    expect(audios(fr).map(a => a.lineId)).toEqual([2]);
  });
});
