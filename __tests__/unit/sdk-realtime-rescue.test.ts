import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, createWsTransport, type PcmPlayer, type RealtimeEvent, type RealtimeSessionOptions, type RealtimeTransport,
  type SessionDescriptor, type TelemetryEvent, type TransportContext,
} from '../../sdk/browser/realtime/index';

const RESCUE_MS = 80;
const TIMEOUTS = { ...DEFAULT_TIMEOUTS, rescueMs: RESCUE_MS, readmitMs: 20, wsOpenMs: 200, wsReadyMs: 200 };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const clipOf = (name: string) => new Blob([name], { type: 'audio/wav' });

interface FakeWs { ctx: TransportContext; sent: Array<{ type: string; messages?: unknown }>; closed: boolean; live: boolean; say(...events: RealtimeEvent[]): void }
interface FakeClip { wavs: Blob[]; closed: boolean; interrupts: number; say(...events: RealtimeEvent[]): void; finish(): void; fail(message: string): void }

function rig(extra: Partial<RealtimeSessionOptions> = {}, wsThatConnect = Infinity) {
  const wss: FakeWs[] = [];
  const clips: FakeClip[] = [];
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const counts = { admissions: 0 };
  const descriptor = (): SessionDescriptor => ({
    sessionId: `rt_${++counts.admissions}`, expiresAt: '', token: 'tok',
    transports: [{ type: 'ws', url: 'wss://gw/v1/realtime/ws?token=tok' }, { type: 's2s-stream', url: '/v1/s2s' }],
  });
  const ws = (ctx: TransportContext): RealtimeTransport => {
    const fake: FakeWs = { ctx, sent: [], closed: false, live: !ctx.standby, say: (...all) => { if (!fake.closed) all.forEach(e => ctx.emit(e)); } };
    wss.push(fake);
    return {
      type: 'ws', clipBased: false, connect: async () => { if (wss.length > wsThatConnect) throw new Error('ws: not ready'); },
      send: (m) => { fake.sent.push(m as never); }, goLive: () => { fake.live = true; },
      close: () => { fake.closed = true; },
    };
  };
  const clip = (ctx: TransportContext): RealtimeTransport => {
    let settle: { resolve(): void; reject(e: Error): void } | null = null;
    const fake: FakeClip = {
      wavs: [], closed: false, interrupts: 0, say: (...all) => all.forEach(e => ctx.emit(e)),
      finish: () => settle?.resolve(), fail: message => settle?.reject(new Error(message)),
    };
    clips.push(fake);
    return {
      type: 's2s-stream', clipBased: true, connect: async () => {},
      send: (m) => { if (m.type === 'interrupt') { fake.interrupts++; ctx.emit({ type: 'interrupted' }); settle?.reject(new Error('interrupted')); } },
      sendTurn: wav => new Promise<void>((resolve, reject) => { fake.wavs.push(wav); settle = { resolve, reject }; }),
      close: () => { fake.closed = true; },
    };
  };
  const s = createRealtimeSession({
    sessionEndpoint: async () => descriptor(), getMicStream: async () => ({}) as MediaStream, onEvent: e => events.push(e),
    storage: null, timeouts: TIMEOUTS, preferredTransports: ['ws', 's2s-stream'], s2s: { url: '/app/s2s' },
    transports: { ws, 's2s-stream': clip }, telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  const answered = async (edgeAcks = true) => {
    s.sendEndTurn(clipOf('first'));
    wss[0]!.say(...(edgeAcks ? [{ type: 'turn_ack' } as RealtimeEvent] : []), { type: 'transcript', text: 'Um pão', final: true }, { type: 'audio_start' },
      { type: 'reply', text: 'Claro!' }, { type: 'audio_end' }, { type: 'done' });
  };
  const of = (event: string) => telemetry.filter(e => e.event === event);
  const count = (type: string) => events.filter(e => e.type === type).length;
  return { s, wss, clips, events, counts, answered, of, count };
}

const FIRST = [{ role: 'user', content: 'Um pão' }, { role: 'assistant', content: 'Claro!' }];
const SECOND = [{ role: 'user', content: 'E um café' }, { role: 'assistant', content: 'Saindo!' }];

describe('uplink stalled: the finished utterance goes as one clip over HTTP', () => {
  it('no end-of-turn ack in time: the clip answers the turn, once; the stalled transport is closed and a fresh one takes over between turns with the whole history', async () => {
    const r = rig();
    expect(await r.s.connect()).toBe('ws');
    await r.answered();
    const stalled = r.wss[0]!;
    const spoke = performance.now();
    const second = clipOf('second');
    r.s.sendEndTurn(second);
    await vi.waitFor(() => expect(r.clips).toHaveLength(1));
    expect(performance.now() - spoke).toBeGreaterThanOrEqual(RESCUE_MS - 5);
    expect([r.clips[0]!.wavs, r.s.transport, stalled.closed]).toEqual([[second], 'ws', false]);

    r.clips[0]!.say({ type: 'transcript', text: 'E um café', final: true });
    expect([r.s.transport, stalled.closed]).toEqual(['s2s-stream', true]);
    r.clips[0]!.say({ type: 'audio_start' });
    expect(performance.now() - spoke).toBeLessThan(RESCUE_MS + 200);
    stalled.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'audio_start' }, { type: 'reply', text: 'Saindo!' }, { type: 'done' });
    r.clips[0]!.say({ type: 'reply', text: 'Saindo!' }, { type: 'audio_end' }, { type: 'done' });
    r.clips[0]!.finish();

    expect([r.count('transcript'), r.count('audio_start'), r.count('done'), r.count('error')]).toEqual([2, 2, 2, 0]);
    expect(r.s.history).toEqual([...FIRST, ...SECOND]);
    expect(r.events.filter(e => e.type === 'transport').at(-1)).toEqual({ type: 'transport', transport: 's2s-stream', reason: 'rescue', from: 'ws' });
    const rescued = r.of('turn.rescued');
    expect(rescued).toHaveLength(1);
    expect(rescued[0]!.attrs).toMatchObject({ from: 'ws', to: 's2s-stream' });
    expect((rescued[0]!.attrs as { stallMs: number }).stallMs).toBeGreaterThanOrEqual(RESCUE_MS - 5);
    expect(rescued[0]!.turnId).toBe(r.of('turn.done').at(-1)!.turnId);
    expect((r.of('turn.done').at(-1)!.attrs as { rescuedMs: number | null }).rescuedMs).toBeGreaterThanOrEqual(RESCUE_MS - 5);
    expect(r.s.metrics.rescues).toBe(1);

    await vi.waitFor(() => expect(r.s.transport).toBe('ws'), { timeout: 3000 });
    expect([r.counts.admissions, r.wss.length, r.wss[1]!.live, r.clips.length, r.clips[0]!.closed]).toEqual([2, 2, true, 1, true]);
    expect(r.wss[1]!.sent).toEqual([{ type: 'config_update', messages: [...FIRST, ...SECOND] }]);
    r.s.close();
  });

  it('no fresh realtime transport after the rescue: the next sendEndTurn(clip) is answered by the clip rung, not dropped', async () => {
    const r = rig({}, 1);
    await r.s.connect();
    await r.answered();
    r.s.sendEndTurn(clipOf('second'));
    await vi.waitFor(() => expect(r.clips).toHaveLength(1));
    r.clips[0]!.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'reply', text: 'Saindo!' }, { type: 'done' });
    r.clips[0]!.finish();
    await vi.waitFor(() => expect(r.of('rt.readmit.gave_up')).toHaveLength(1), { timeout: 3000 });
    expect(r.s.transport).toBe('s2s-stream');
    const third = clipOf('third');
    r.s.sendEndTurn(third);
    await vi.waitFor(() => expect(r.clips[0]!.wavs.at(-1)).toBe(third));
    r.clips[0]!.say({ type: 'transcript', text: 'Obrigada', final: true }, { type: 'reply', text: 'De nada!' }, { type: 'done' });
    r.clips[0]!.finish();
    expect([r.count('transcript'), r.count('done')]).toEqual([3, 3]);
    expect(r.s.history.at(-1)).toEqual({ role: 'assistant', content: 'De nada!' });
    r.s.close();
  });

  it('the ack arrives in time: nothing is sent, the session is untouched', async () => {
    const r = rig();
    await r.s.connect();
    await r.answered();
    r.s.sendEndTurn(clipOf('second'));
    await pause(RESCUE_MS / 2);
    r.wss[0]!.say({ type: 'turn_ack' });
    await pause(RESCUE_MS * 3);
    expect([r.clips.length, r.counts.admissions, r.s.transport, r.of('turn.rescue_started').length]).toEqual([0, 1, 'ws', 0]);
    r.wss[0]!.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'reply', text: 'Saindo!' }, { type: 'done' });
    expect(typeof (r.of('turn.done').at(-1)!.attrs as { ackMs: number }).ackMs).toBe('number');
    r.s.close();
  });

  it('an edge that never acknowledges (older image), a turn with no clip, or rescueMs 0: never rescued', async () => {
    const old = rig();
    await old.s.connect();
    await old.answered(false);
    old.s.sendEndTurn(clipOf('second'));
    const noClip = rig();
    await noClip.s.connect();
    await noClip.answered();
    noClip.s.sendEndTurn();
    const off = rig({ timeouts: { ...TIMEOUTS, rescueMs: 0 } });
    await off.s.connect();
    await off.answered();
    off.s.sendEndTurn(clipOf('second'));
    await pause(RESCUE_MS * 3);
    expect([old.clips.length, noClip.clips.length, off.clips.length]).toEqual([0, 0, 0]);
    for (const r of [old, noClip, off]) r.s.close();
  });

  it('the stalled path acknowledges after the clip left but before it answered: the clip is dropped, the answer comes once, from the realtime path', async () => {
    const r = rig();
    await r.s.connect();
    await r.answered();
    r.s.sendEndTurn(clipOf('second'));
    await vi.waitFor(() => expect(r.clips).toHaveLength(1));
    r.wss[0]!.say({ type: 'turn_ack' });
    expect(r.clips[0]!.closed).toBe(true);
    r.clips[0]!.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'audio_start' }, { type: 'done' });
    expect([r.s.transport, r.count('transcript'), r.count('done')]).toEqual(['ws', 1, 1]);
    r.wss[0]!.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'audio_start' }, { type: 'reply', text: 'Saindo!' }, { type: 'audio_end' }, { type: 'done' });
    expect([r.count('transcript'), r.count('done'), r.counts.admissions, r.of('turn.rescued').length]).toEqual([2, 2, 1, 0]);
    expect(r.s.history).toEqual([...FIRST, ...SECOND]);
    r.s.close();
  });

  it('the clip path fails before answering: the session goes on waiting for the realtime path', async () => {
    const r = rig();
    await r.s.connect();
    await r.answered();
    r.s.sendEndTurn(clipOf('second'));
    await vi.waitFor(() => expect(r.clips).toHaveLength(1));
    r.clips[0]!.fail('s2s answered HTTP 502');
    await vi.waitFor(() => expect(r.clips[0]!.closed).toBe(true));
    expect([r.s.transport, r.wss[0]!.closed, r.count('error'), r.count('done')]).toEqual(['ws', false, 0, 1]);
    expect(r.of('turn.rescue_failed').map(e => e.attrs)).toEqual([{ committed: false, reason: 's2s answered HTTP 502' }]);
    r.wss[0]!.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'reply', text: 'Saindo!' }, { type: 'done' });
    expect([r.count('done'), r.clips.length, r.counts.admissions]).toEqual([2, 1, 1]);
    expect(r.s.history).toEqual([...FIRST, ...SECOND]);
    r.s.close();
  });

  it('barge-in: before the clip answered it is dropped and the realtime path is told; while its answer plays the clip turn is cut and closed', async () => {
    const early = rig();
    await early.s.connect();
    await early.answered();
    early.s.sendEndTurn(clipOf('second'));
    await vi.waitFor(() => expect(early.clips).toHaveLength(1));
    early.s.interrupt();
    expect([early.clips[0]!.closed, early.clips[0]!.interrupts, early.wss[0]!.sent.at(-1), early.s.transport]).toEqual([true, 0, { type: 'interrupt' }, 'ws']);
    early.s.close();

    const playing = rig();
    await playing.s.connect();
    await playing.answered();
    playing.s.sendEndTurn(clipOf('second'));
    await vi.waitFor(() => expect(playing.clips).toHaveLength(1));
    playing.clips[0]!.say({ type: 'transcript', text: 'E um café', final: true }, { type: 'audio_start' });
    playing.s.interrupt();
    await vi.waitFor(() => expect(playing.events.at(-1)).toEqual({ type: 'done', interrupted: true }));
    expect([playing.clips[0]!.interrupts, playing.count('interrupted'), playing.count('error')]).toEqual([1, 1, 0]);
    expect(playing.s.history).toEqual([...FIRST, { role: 'user', content: 'E um café' }]);
    await vi.waitFor(() => expect(playing.s.transport).toBe('ws'), { timeout: 3000 });
    expect(playing.wss[1]!.sent).toEqual([{ type: 'config_update', messages: [...FIRST, { role: 'user', content: 'E um café' }] }]);
    playing.s.close();
  });
});

describe('WS rung after close', () => {
  it('a message still in flight when the transport was closed is not delivered (the late answer of a stalled path)', async () => {
    class Ws {
      static last: Ws;
      binaryType = 'blob'; readyState = 0; bufferedAmount = 0;
      onopen: (() => void) | null = null; onerror = null; onclose = null;
      onmessage: ((e: { data: unknown }) => void) | null = null;
      constructor() { Ws.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: '{"type":"ready"}' }); }, 2); }
      send() {}
      close() { this.readyState = 2; }
    }
    const seen: string[] = [];
    const c = {
      timeouts: TIMEOUTS, traceparent: '00-a-b-01', telemetry: { emit: () => {} }, mic: async () => ({}), emit: (e: RealtimeEvent) => seen.push(e.type),
      fail: () => {}, dropped: () => {},
    } as unknown as TransportContext;
    const t = createWsTransport(c, 'wss://gw/ws', { WebSocket: Ws as unknown as typeof WebSocket, player: async () => ({ close: () => {} }) as unknown as PcmPlayer, capture: async () => ({ stop: () => {} }) });
    await t.connect(new AbortController().signal);
    t.close();
    Ws.last.onmessage!({ data: '{"type":"audio_start"}' });
    expect(seen).toEqual(['ready']);
  });
});
