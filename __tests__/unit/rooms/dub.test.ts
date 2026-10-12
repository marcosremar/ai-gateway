/**
 * Server-side dubbing of live rooms (src/rooms/dub.ts): the gateway voices a line (Kokoro, mocked here) only for the
 * languages someone listens to, never when the presenter sends its own clips, never for languages Kokoro lacks, drops
 * stale pending lines, and is off with ROOM_SERVER_DUB=0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryRoomStore, RoomService, kokoroSynthesize, kokoroVoice, maiSynthesize, roomsConfigFromEnv,
  synthesizeWithFallback, type RoomClip, type RoomsConfig,
} from '../../../src/rooms';
import type { LiveRoom, RoomViewer } from '../../../src/rooms/service';
import type { RoomLine, RoomServerMessage } from '../../../src/rooms/types';

const WAIT = 100;

interface FakeViewer extends RoomViewer { msgs: RoomServerMessage[]; listen: string | null | undefined }

function viewer(listen: string | null | undefined): FakeViewer {
  const v: FakeViewer = {
    msgs: [], listen,
    send: (t) => { v.msgs.push(JSON.parse(t) as RoomServerMessage); },
    close: () => {},
    wantsAudio: (lang) => v.listen === undefined || v.listen === lang,
    listening: (lang) => v.listen === lang,
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

  it('voices a line only for the language a viewer listens to, as mp3, after the wait', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    const silent = viewer(null);
    const legacy = viewer(undefined); // never sent listen: gets presenter clips, never causes server spend
    for (const v of [fr, silent, legacy]) service.addViewer(r, v);
    await service.publishLine(r, line(1));
    expect(synth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth).toHaveBeenCalledWith('bonjour 1', 'fr');
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

  it('skips a line the presenter voiced, and the whole room while the presenter sends clips', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    service.publishAudio(r, { lineId: 1, lang: 'fr', wav: 'AAAA' });
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    await service.publishLine(r, line(2));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).not.toHaveBeenCalled();
    expect(audios(fr)).toEqual([{ type: 'audio', lineId: 1, lang: 'fr', wav: 'AAAA' }]);
    // The presenter went quiet long enough: the server takes over.
    await vi.advanceTimersByTimeAsync(60_000);
    await service.publishLine(r, line(3));
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).toHaveBeenCalledWith('bonjour 3', 'fr');
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

  it('drops stale pending lines: only the newest is voiced, and a line is voiced once', async () => {
    const r = await room(service);
    const fr = viewer('fr');
    service.addViewer(r, fr);
    await service.publishLine(r, line(1));
    await service.publishLine(r, line(2));
    await service.publishLine(r, line(3));
    await service.publishLine(r, line(3, { fr: 'bonjour 3 (corrigé)' })); // same id replaced while pending
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth).toHaveBeenCalledWith('bonjour 3 (corrigé)', 'fr');
    await service.publishLine(r, line(3, { fr: 'encore' }));
    await vi.advanceTimersByTimeAsync(WAIT * 3);
    expect(synth).toHaveBeenCalledTimes(1);
    expect(audios(fr).map(a => a.lineId)).toEqual([3]);
  });

  it('keeps one call in flight per language: lines arriving meanwhile collapse to the newest', async () => {
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
    await vi.advanceTimersByTimeAsync(WAIT + 1);
    expect(synth.mock.calls.map(c => c[0])).toEqual(['bonjour 1', 'bonjour 3']);
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
    expect(mai).toHaveBeenCalledWith('bonjour 1', 'fr', expect.any(AbortSignal));
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
