#!/usr/bin/env bun
import { parseArgs } from 'util';
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, TrackKind, TrackPublishOptions,
  TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream, dispose, type RemoteTrack,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const USAGE = `bun scripts/calls-load.ts [--steps 5,10,20,40] [--hold 30] [--procs 4] [--out file.json]
N pairs per step, each in its own room load-<run>-<N>-<i>: both publish 48 kHz mono audio and 320x240 I420 video at 15 fps
and count what they receive from the other. Needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (bun --env-file=...).`;

const WIDTH = 320, HEIGHT = 240, FPS = 15, RATE = 48_000, AUDIO_MS = 20;
const CONNECT_MS = 20_000, PUBLISH_MS = 10_000, DISCONNECT_MS = 5_000, SERVER_MS = 8_000;

interface Peer { pair: number; side: 'a' | 'b'; connectMs: number | null; published: boolean; audioRx: number; videoRx: number; videoFirst: number; videoLast: number; error: string | null }

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timeout ${ms} ms`)), ms); })])
    .finally(() => clearTimeout(timer));
}

function creds() {
  const url = process.env.LIVEKIT_URL, key = process.env.LIVEKIT_API_KEY, secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required');
  return { url, key, secret, http: url.replace(/^ws(s?):\/\//, 'http$1://') };
}

async function tokenFor(room: string, identity: string): Promise<string> {
  const { key, secret } = creds();
  const t = new AccessToken(key, secret, { identity, ttl: 900 });
  t.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return t.toJwt();
}

async function count(track: RemoteTrack, peer: Peer, stop: { done: boolean }) {
  const video = track.kind === TrackKind.KIND_VIDEO;
  const reader = (video ? new VideoStream(track) : new AudioStream(track)).getReader();
  while (!stop.done) {
    const next = await reader.read().catch(() => ({ done: true as const }));
    if (next.done) break;
    if (!video) { peer.audioRx++; continue; }
    peer.videoLast = performance.now();
    if (!peer.videoRx++) peer.videoFirst = peer.videoLast;
  }
  await reader.cancel().catch(() => {});
}

async function runPeer(roomName: string, peer: Peer, holdMs: number, url: string): Promise<void> {
  const room = new Room();
  const stop = { done: false };
  const readers: Promise<void>[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => { readers.push(count(track, peer, stop)); });
  try {
    const started = performance.now();
    await within(room.connect(url, await tokenFor(roomName, `${roomName}-${peer.side}`), { autoSubscribe: true, dynacast: false }), CONNECT_MS, 'connect');
    peer.connectMs = Math.round(performance.now() - started);
    const audio = new AudioSource(RATE, 1);
    const video = new VideoSource(WIDTH, HEIGHT);
    await within(Promise.all([
      room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('mic', audio), new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })),
      room.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('cam', video), new TrackPublishOptions({ source: TrackSource.SOURCE_CAMERA })),
    ]), PUBLISH_MS, 'publish');
    peer.published = true;
    const samples = RATE * AUDIO_MS / 1000;
    let phase = 0;
    timers.push(setInterval(() => {
      const data = new Int16Array(samples);
      for (let i = 0; i < samples; i++) data[i] = Math.round(3000 * Math.sin((phase++ * 2 * Math.PI * 440) / RATE));
      void audio.captureFrame(new AudioFrame(data, RATE, 1, samples)).catch(() => {});
    }, AUDIO_MS));
    let n = 0;
    timers.push(setInterval(() => {
      const buf = new Uint8Array(WIDTH * HEIGHT * 1.5);
      buf.fill((n++ * 8) % 256, 0, WIDTH * HEIGHT);
      buf.fill(128, WIDTH * HEIGHT);
      video.captureFrame(new VideoFrame(buf, WIDTH, HEIGHT, VideoBufferType.I420));
    }, 1000 / FPS));
    await new Promise(r => setTimeout(r, holdMs));
  } catch (err) {
    peer.error = (err as Error).message;
  } finally {
    stop.done = true;
    for (const t of timers) clearInterval(t);
    await within(Promise.allSettled(readers), DISCONNECT_MS, 'readers').catch(() => {});
    await within(room.disconnect(), DISCONNECT_MS, 'disconnect').catch((err: Error) => { peer.error ??= err.message; });
  }
}

async function worker(run: string, step: number, pairs: number[], holdMs: number) {
  const { url } = creds();
  const peers: Peer[] = pairs.flatMap(pair => (['a', 'b'] as const).map(side => ({ pair, side, connectMs: null, published: false, audioRx: 0, videoRx: 0, videoFirst: 0, videoLast: 0, error: null })));
  await Promise.all(peers.map(p => runPeer(`load-${run}-${step}-${p.pair}`, p, holdMs, url)));
  process.stdout.write(`${JSON.stringify(peers)}\n`);
  await within(dispose(), DISCONNECT_MS, 'dispose').catch(() => {});
  process.exit(0);
}

async function serverSeen(svc: RoomServiceClient, prefix: string) {
  const rooms = await within(svc.listRooms(), SERVER_MS, 'listRooms');
  const mine = rooms.filter(r => r.name.startsWith(prefix));
  return { rooms: mine.length, participants: mine.reduce((n, r) => n + r.numParticipants, 0) };
}

async function cleanup(svc: RoomServiceClient, prefix: string) {
  const rooms = await within(svc.listRooms(), SERVER_MS, 'listRooms').catch(() => []);
  const mine = rooms.filter(r => r.name.startsWith(prefix));
  await Promise.allSettled(mine.map(r => within(svc.deleteRoom(r.name), SERVER_MS, 'deleteRoom')));
  return mine.length;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]!;
};

async function runStep(run: string, step: number, procs: number, holdMs: number, svc: RoomServiceClient) {
  const groups = Array.from({ length: Math.min(procs, step) }, (_, w) => Array.from({ length: step }, (_, i) => i).filter(i => i % procs === w));
  const children = groups.map(g => Bun.spawn(['bun', import.meta.path, '--worker', '--run', run, '--step', String(step), '--pairs', g.join(','), '--hold', String(holdMs / 1000)], {
    stdout: 'pipe', stderr: 'pipe', env: process.env,
  }));
  const kill = setTimeout(() => { for (const c of children) c.kill(); }, holdMs + CONNECT_MS + PUBLISH_MS + 30_000);
  const seen = { rooms: 0, participants: 0, polls: 0 };
  const poll = setInterval(() => {
    serverSeen(svc, `load-${run}-${step}-`).then(r => { seen.polls++; seen.rooms = Math.max(seen.rooms, r.rooms); seen.participants = Math.max(seen.participants, r.participants); }, () => {});
  }, 2_000);
  const outputs = await Promise.all(children.map(async c => {
    const [out] = await Promise.all([new Response(c.stdout).text(), new Response(c.stderr).text(), c.exited]);
    try { return JSON.parse(out.trim().split('\n').pop() ?? '[]') as Peer[]; } catch { return [] as Peer[]; }
  }));
  clearTimeout(kill);
  clearInterval(poll);
  const peers = outputs.flat();
  const server = seen;
  const removed = await cleanup(svc, `load-${run}-${step}-`);
  const holdS = holdMs / 1000;
  const connected = peers.filter(p => p.connectMs !== null);
  const pairOk = Array.from({ length: step }, (_, i) => peers.filter(p => p.pair === i && p.videoRx > 0 && p.audioRx > 0).length === 2).filter(Boolean).length;
  const fps = (side: 'a' | 'b') => peers.filter(p => p.side === side)
    .map(p => (p.videoRx > 1 ? ((p.videoRx - 1) * 1000) / (p.videoLast - p.videoFirst) : 0));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  return {
    pairs: step, procs: groups.length, peersExpected: step * 2, peersReported: peers.length, connected: connected.length,
    published: peers.filter(p => p.published).length, pairsBothWays: pairOk,
    connectMs: { p50: pct(connected.map(p => p.connectMs!), 0.5), p95: pct(connected.map(p => p.connectMs!), 0.95), max: pct(connected.map(p => p.connectMs!), 1) },
    videoFpsRx: { aFromB: avg(fps('a')), bFromA: avg(fps('b')), min: Math.round(Math.min(...fps('a'), ...fps('b'), Infinity) * 10) / 10 },
    audioFramesPerSecRx: avg(peers.map(p => p.audioRx / holdS)),
    server, roomsRemoved: removed,
    errors: [...new Set(peers.flatMap(p => (p.error ? [p.error] : [])))].slice(0, 5),
  };
}

const { values } = parseArgs({
  options: {
    steps: { type: 'string', default: '5,10,20,40' }, hold: { type: 'string', default: '30' }, procs: { type: 'string', default: '4' },
    out: { type: 'string' }, worker: { type: 'boolean' }, run: { type: 'string' }, step: { type: 'string' }, pairs: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) { console.log(USAGE); process.exit(0); }
const holdMs = Number(values.hold) * 1000;
if (values.worker) {
  await worker(values.run!, Number(values.step), values.pairs!.split(',').map(Number), holdMs);
} else {
  const { http, key, secret } = creds();
  const svc = new RoomServiceClient(http, key, secret);
  const run = Date.now().toString(36);
  const results = [];
  const interrupted = () => { void cleanup(svc, `load-${run}-`).finally(() => process.exit(130)); };
  process.on('SIGINT', interrupted);
  for (const step of values.steps!.split(',').map(Number).filter(n => n > 0)) {
    const r = await runStep(run, step, Math.max(1, Number(values.procs)), holdMs, svc);
    results.push(r);
    console.log(JSON.stringify(r));
    await new Promise(res => setTimeout(res, 5_000));
  }
  await cleanup(svc, `load-${run}-`);
  if (values.out) await Bun.write(values.out, JSON.stringify({ run, at: new Date().toISOString(), width: WIDTH, height: HEIGHT, fps: FPS, holdMs, results }, null, 2));
}
