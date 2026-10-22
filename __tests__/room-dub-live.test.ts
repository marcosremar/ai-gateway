import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const BASE = (process.env.ROOMS_LIVE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.GATEWAY_API_KEY ?? '';
const STT_MODEL = process.env.ROOM_DUB_STT_MODEL ?? '';
const EXPECT_ENGINE = process.env.ROOM_DUB_EXPECT_ENGINE ?? '';
const CLONE = process.env.ROOM_DUB_CLONE === '1';

const LINES = [
  { fr: 'Bonjour à tous.', en: 'Good morning, everyone.' },
  { fr: 'Commençons par les chiffres du trimestre.', en: "Let's start with the quarter's figures." },
  { fr: "Le chiffre d'affaires a augmenté de onze pour cent sur un an.", en: 'Revenue grew eleven percent year on year.' },
  { fr: 'Le taux de résiliation reste notre principale préoccupation.', en: 'The churn rate remains our main concern.' },
];
const SPEAKER_WAV = readFileSync(path.join(__dirname, 'fixtures', 'room-dub-speaker-fr-16k.wav'));
const SPEAKER_TEXT = LINES.map(l => l.fr).join(' ');

interface Clip { lineId: number; engine: string; seconds: number; rms: number; afterMs: number; wav: Buffer }
interface Room { code: string; publishToken: string }

const opened: Room[] = [];

async function call(method: string, route: string, token: string, body?: unknown): Promise<Response> {
  return fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createRoom(): Promise<Room> {
  const res = await call('POST', '/v1/rooms', KEY, { title: 'Teste automático de dublagem', originalLang: 'fr', languages: ['en'] });
  expect(res.status).toBe(201);
  const room = await res.json() as Room;
  opened.push(room);
  return room;
}

function wavStats(wav: Buffer): { seconds: number; rms: number } {
  const dataAt = wav.indexOf('data') + 8;
  const rate = wav.readUInt32LE(24);
  const samples = Math.floor((wav.length - dataAt) / 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += wav.readInt16LE(dataAt + i * 2) ** 2;
  return { seconds: samples / rate, rms: Math.sqrt(sum / Math.max(1, samples)) / 32768 };
}

function listen(room: Room, lang: string, expected: number): { ready: Promise<void>; clips: Promise<Clip[]>; sentAt: Map<number, number> } {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/v1/rooms/${room.code}/ws`);
  const sentAt = new Map<number, number>();
  const clips: Clip[] = [];
  let markReady = () => {};
  const ready = new Promise<void>(resolve => { markReady = resolve; });
  const done = new Promise<Clip[]>(resolve => {
    const finish = () => { ws.close(); resolve(clips); };
    const timer = setTimeout(finish, 20_000 * expected);
    ws.onmessage = ev => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'snapshot') { ws.send(JSON.stringify({ type: 'listen', lang })); setTimeout(markReady, 500); return; }
      if (msg.type !== 'audio') return;
      const wav = Buffer.from(msg.wav, 'base64');
      clips.push({ lineId: msg.lineId, engine: msg.engine ?? 'unknown', ...wavStats(wav), afterMs: Date.now() - (sentAt.get(msg.lineId) ?? Date.now()), wav });
      if (clips.length === expected) { clearTimeout(timer); finish(); }
    };
  });
  return { ready, clips: done, sentAt };
}

async function publishLines(room: Room, sentAt: Map<number, number>): Promise<void> {
  for (const [i, line] of LINES.entries()) {
    const id = i + 1;
    sentAt.set(id, Date.now());
    const res = await call('POST', `/v1/rooms/${room.code}/lines`, room.publishToken, {
      id, original: line.fr, originalLang: 'fr', translations: { en: line.en }, speechMs: line.fr.length * 70,
    });
    expect(res.status).toBe(204);
    await new Promise(r => setTimeout(r, 2_500));
  }
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);

async function heardWords(wav: Buffer): Promise<string[]> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dub.wav');
  form.append('model', STT_MODEL);
  form.append('language', 'en');
  const res = await fetch(`${BASE}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form });
  expect(res.status, await res.clone().text()).toBe(200);
  return words(((await res.json()) as { text: string }).text);
}

async function expectSpokenEnglish(clips: Clip[], engines: string[]): Promise<void> {
  console.table(clips.map(c => ({ line: c.lineId, engine: c.engine, seconds: c.seconds.toFixed(2), rms: c.rms.toFixed(3), afterMs: c.afterMs })));
  expect(clips.map(c => c.lineId).sort()).toEqual(LINES.map((_, i) => i + 1));
  for (const clip of clips) {
    const letters = LINES[clip.lineId - 1].en.length;
    expect(engines, `line ${clip.lineId}`).toContain(clip.engine);
    expect(clip.seconds, `line ${clip.lineId} length`).toBeGreaterThan(letters / 30);
    expect(clip.seconds, `line ${clip.lineId} length`).toBeLessThan(letters / 5 + 1.5);
    expect(clip.rms, `line ${clip.lineId} loudness`).toBeGreaterThan(0.01);
    if (!STT_MODEL) continue;
    const said = words(LINES[clip.lineId - 1].en);
    const heard = await heardWords(clip.wav);
    expect(said.filter(w => heard.includes(w)).length / said.length, `line ${clip.lineId}: ${heard.join(' ')}`).toBeGreaterThanOrEqual(0.7);
  }
}

afterEach(async () => {
  for (const room of opened.splice(0)) await call('POST', `/v1/rooms/${room.code}/end`, room.publishToken, {});
});

describe.skipIf(!BASE || !KEY)('live room dubbing: French speaker, English listener', { timeout: 180_000 }, () => {
  it('voices every French line in English with the stock voice (Pocket TTS, Kokoro if Pocket cannot)', async () => {
    const room = await createRoom();
    const viewer = listen(room, 'en', LINES.length);
    await viewer.ready;
    await publishLines(room, viewer.sentAt);
    await expectSpokenEnglish(await viewer.clips, EXPECT_ENGINE ? [EXPECT_ENGINE] : ['pocket', 'kokoro']);
  });

  it.skipIf(!CLONE)("voices them in the speaker's own voice with Qwen3-TTS while the clone GPU serves", async () => {
    const room = await createRoom();
    const voice = await call('PUT', `/v1/rooms/${room.code}/voice`, room.publishToken, {
      lang: 'fr', ref_audio: `data:audio/wav;base64,${SPEAKER_WAV.toString('base64')}`, ref_text: SPEAKER_TEXT,
    });
    expect(voice.status).toBeLessThan(300);
    const viewer = listen(room, 'en', LINES.length);
    await viewer.ready;
    await publishLines(room, viewer.sentAt);
    await expectSpokenEnglish(await viewer.clips, ['clone']);
  });
});
