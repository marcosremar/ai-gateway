import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY, decideTransport, initialPolicy, type NetworkSample, type PolicyContext, type PolicyEffect, type PolicyState,
} from '../../sdk/browser/realtime/transport-policy';

const TURN_MS = 15_000;
const CTX: PolicyContext = { spare: true, fidelity: false, recovery: true, thresholds: DEFAULT_POLICY };
const turn = (lossPct: number | null, stallMs: number | null = 0, isProtected: boolean | null = null): Omit<NetworkSample, 'at'> => ({ lossPct, jitterMs: 12, stallMs, protected: isProtected });

function run(samples: Array<Omit<NetworkSample, 'at'>>, ctx: PolicyContext = CTX, from: PolicyState = initialPolicy('ws'), turnMs = TURN_MS) {
  let state = from;
  const path: string[] = [];
  const effects: PolicyEffect[] = [];
  samples.forEach((sample, n) => {
    const out = decideTransport(state, { ...sample, at: n * turnMs }, ctx);
    state = out.state;
    effects.push(...out.effects);
    path.push(state.on);
  });
  return { state, path, effects };
}

const many = (n: number, sample: Omit<NetworkSample, 'at'>) => Array.from({ length: n }, () => sample);

describe('transport by network signal: the decision', () => {
  it('a clean network stays on WebSocket for the whole session', () => {
    const r = run(many(40, turn(0)));
    expect([r.effects, new Set(r.path), r.state.switches]).toEqual([[], new Set(['ws']), 0]);
    expect(run(many(40, turn(null, null))).effects).toEqual([]);
  });

  it('5 % loss sustained: moves to WebRTC after the window of turns, not before, and stays there while the loss lasts', () => {
    const r = run(many(12, turn(5)));
    expect(r.path.slice(0, 4)).toEqual(['ws', 'ws', 'webrtc', 'webrtc']);
    expect(r.effects).toEqual([{ type: 'switch', to: 'webrtc', reason: 'loss', lossPct: 5, jitterMs: 12, stallMs: 0 }]);
    expect(run([turn(5), turn(5), turn(0), turn(5), turn(5)]).effects).toEqual([]);
  });

  it('stalls on WebSocket (late end-of-turn acks, a rescued turn) are the same signal', () => {
    const r = run(many(3, turn(0, 1500)));
    expect(r.effects.map(e => [e.to, e.reason, e.stallMs])).toEqual([['webrtc', 'stall', 1500]]);
  });

  it('the loss clears: back to WebSocket only after the window of clean turns and the dwell time', () => {
    const r = run([...many(3, turn(5)), ...many(10, turn(0))]);
    expect(r.path.indexOf('webrtc')).toBe(2);
    expect(r.path.lastIndexOf('webrtc')).toBe(5);
    expect(r.effects.map(e => [e.to, e.reason])).toEqual([['webrtc', 'loss'], ['ws', 'clean']]);
    const quick = run([...many(3, turn(5)), ...many(10, turn(0))], CTX, initialPolicy('ws'), 2_000);
    expect(quick.path.slice(3)).toEqual(many(10, turn(0)).map(() => 'webrtc'));
    expect(quick.effects).toHaveLength(1);
  });

  it('flapping loss: never more than the bounded number of switches in a session', () => {
    const flap = Array.from({ length: 60 }, (_, n) => [...many(3, turn(6)), ...many(3, turn(0))]).flat();
    const r = run(flap, { ...CTX, thresholds: { ...DEFAULT_POLICY, dwellMs: 0 } });
    expect(r.state.switches).toBe(DEFAULT_POLICY.maxSwitches);
    expect(r.effects).toHaveLength(DEFAULT_POLICY.maxSwitches);
    const first24 = (dwellMs: number) => run(flap.slice(0, 24), { ...CTX, thresholds: { ...DEFAULT_POLICY, dwellMs, maxSwitches: 99 } }).effects.length;
    expect([first24(0), first24(60_000), first24(600_000)]).toEqual([8, 3, 1]);
  });

  it('WebRTC not connected (UDP blocked): never asks to move', () => {
    const r = run(many(20, turn(8, 2000)), { ...CTX, spare: false });
    expect([r.effects, new Set(r.path)]).toEqual([[], new Set(['ws'])]);
  });

  it('fidelity-sensitive session: no move to WebRTC under loss until loss recovery is negotiated; with it, moves', () => {
    expect(run(many(10, turn(5)), { ...CTX, fidelity: true, recovery: false }).effects).toEqual([]);
    expect(run(many(10, turn(0, 2000)), { ...CTX, fidelity: true, recovery: false }).effects).toEqual([]);
    expect(run(many(10, turn(5)), { ...CTX, fidelity: true, recovery: true }).effects.map(e => e.to)).toEqual(['webrtc']);
  });

  it('fidelity-sensitive session on WebRTC: loss recovery negotiated but not observed on lossy turns sends it back to WebSocket', () => {
    const on = { ...initialPolicy('webrtc') };
    const fidelity = { ...CTX, fidelity: true };
    expect(run(many(6, turn(5, 0, false)), fidelity, on).effects.map(e => [e.to, e.reason])).toEqual([['ws', 'unprotected']]);
    expect(run(many(6, turn(5, 0, true)), fidelity, on).effects).toEqual([]);
    expect(run(many(6, turn(5, 0, false)), CTX, on).effects).toEqual([]);
  });
});

import { vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, type ChatMessage, type LinkStats, type RealtimeEvent, type RealtimeSessionOptions, type RealtimeTransport,
  type SessionDescriptor, type TelemetryEvent, type TransportContext, type TransportType,
} from '../../sdk/browser/realtime/index';

const DESCRIPTOR: SessionDescriptor = {
  sessionId: 'rt_policy', expiresAt: '', token: 'tok',
  transports: [{ type: 'webrtc', offerUrl: 'https://gw/o/offer' }, { type: 'ws', url: 'wss://gw/ws' }, { type: 's2s-stream', url: '/v1/s2s' }],
};
const FAST = { ...DEFAULT_TIMEOUTS, iceGatherMs: 100, signalingMs: 100, webrtcConnectMs: 100, wsOpenMs: 200, wsReadyMs: 200, upgradeMs: 300, rescueMs: 60, readmitMs: 20 };
const WINDOW = { windowTurns: 2, dwellMs: 0, stallMs: 100 };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

function rig(extra: Partial<RealtimeSessionOptions> = {}) {
  const log: string[] = [];
  const sent: Array<[TransportType, { type: string; messages?: ChatMessage[] }]> = [];
  const ctxs: Partial<Record<TransportType, TransportContext>> = {};
  const settle: Partial<Record<TransportType, { up(): void; down(): void }>> = {};
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const clips: Blob[] = [];
  const link: LinkStats = { packetsSent: 0, packetsLost: 0, jitterMs: 9, rttMs: 150, jitterBufferMs: 110, outgoingKbps: 500, recovery: true };
  let n = 0;
  const fake = (type: TransportType) => (c: TransportContext): RealtimeTransport => {
    ctxs[type] = c;
    return {
      type, clipBased: type === 's2s-stream',
      connect: (signal) => new Promise<void>((resolve, reject) => {
        log.push(`try:${type}`);
        settle[type] = { up: resolve, down: () => reject(new Error(`${type} refused`)) };
        signal.addEventListener('abort', () => reject(signal.reason as Error));
        if (type === 's2s-stream') resolve();
      }),
      send: (m) => { sent.push([type, m as never]); },
      ...(type === 's2s-stream' ? { sendTurn: async (wav: Blob) => { clips.push(wav); } } : {}),
      goLive: () => { log.push(`live:${type}`); }, goStandby: () => { log.push(`standby:${type}`); },
      ...(type === 'webrtc' ? { stats: async () => ({ ...link }) } : {}),
      close: () => { log.push(`close:${type}`); },
    };
  };
  const s = createRealtimeSession({
    sessionEndpoint: async () => DESCRIPTOR, getMicStream: async () => ({}) as MediaStream, onEvent: e => events.push(e),
    storage: null, timeouts: FAST, s2s: { url: '/app/s2s' }, transportPolicy: 'auto', transportThresholds: WINDOW,
    transports: { webrtc: fake('webrtc'), ws: fake('ws'), 's2s-stream': fake('s2s-stream') },
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  const start = async (webrtc: 'up' | 'down' = 'up') => {
    const connecting = s.connect();
    await vi.waitFor(() => expect(settle.ws && settle.webrtc).toBeTruthy());
    settle.ws!.up();
    await connecting;
    settle.webrtc![webrtc]();
    await pause(20);
  };
  const turn = async (lossPct: number, o: { ackAfterMs?: number; metrics?: RealtimeEvent } = {}) => {
    const c = ctxs[s.transport!]!;
    n++;
    link.packetsSent += 1000 - lossPct * 10;
    link.packetsLost += lossPct * 10;
    s.sendEndTurn();
    if (o.ackAfterMs) await pause(o.ackAfterMs);
    c.emit({ type: 'turn_ack' });
    c.emit({ type: 'transcript', text: `fala ${n}`, final: true });
    c.emit({ type: 'reply', text: `resposta ${n}` });
    if (o.metrics) c.emit(o.metrics);
    c.emit({ type: 'done' });
    await pause(10);
  };
  const of = (event: string) => telemetry.filter(e => e.event === event).map(e => e.attrs);
  const moves = () => events.filter(e => e.type === 'transport').map(e => (e as { transport: string; reason: string }).transport + ':' + (e as { reason: string }).reason);
  return { s, log, sent, ctxs, settle, events, clips, link, start, turn, of, moves };
}

const settled = (r: ReturnType<typeof rig>, transport: TransportType) => vi.waitFor(() => expect(r.s.transport).toBe(transport), { timeout: 2000 });

describe('transport by network signal: the session (transportPolicy "auto")', () => {
  it('starts on WS and keeps WebRTC connected on standby, measuring; a clean network never moves', async () => {
    const r = rig();
    await r.start();
    expect([r.s.transport, r.log]).toEqual(['ws', ['try:webrtc', 'try:ws', 'standby:webrtc']]);
    for (let i = 0; i < 6; i++) await r.turn(0);
    await pause(450);
    expect([r.s.transport, r.moves(), r.s.metrics.switches, r.log.length]).toEqual(['ws', ['ws:connected'], 0, 3]);
    r.s.close();
    expect(r.of('rt.network.summary')).toEqual([{ turns: 6, wsTurns: 6, webrtcTurns: 0, lossPctMax: 0, lossPctAvg: 0, jitterMsMax: 9, stallMsMax: 0, switches: 0, rescues: 0 }]);
    expect(r.log.slice(3).sort()).toEqual(['close:webrtc', 'close:ws']);
  });

  it('sustained loss: moves to WebRTC between turns after the window, WS stays open on standby; when it clears, back to WS; each side gets only the history it missed', async () => {
    const r = rig();
    await r.start();
    await r.turn(0);
    r.s.updateHistory([{ role: 'system', content: '(regra nova)' }]);
    await r.turn(5);
    await r.turn(5);
    r.s.sendEndTurn();
    r.ctxs.ws!.emit({ type: 'turn_ack' });
    r.ctxs.ws!.emit({ type: 'transcript', text: 'em curso', final: true });
    await pause(500);
    expect(r.s.transport).toBe('ws');
    r.ctxs.ws!.emit({ type: 'reply', text: 'fim' });
    r.ctxs.ws!.emit({ type: 'done' });
    await settled(r, 'webrtc');
    expect(r.log.slice(3)).toEqual(['standby:ws', 'live:webrtc']);
    const replayed = r.sent.filter(([t, m]) => t === 'webrtc' && m.type === 'config_update').flatMap(([, m]) => m.messages!);
    expect(replayed.map(m => m.content)).toEqual(['fala 1', 'resposta 1', 'fala 2', 'resposta 2', 'fala 3', 'resposta 3', 'em curso', 'fim']);
    expect(replayed.every(m => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(r.of('transport.switch')).toEqual([{ from: 'ws', to: 'webrtc', reason: 'loss', lossPct: 5, jitterMs: 9, stallMs: 0 }]);

    await r.turn(5);
    await r.turn(0);
    await r.turn(0);
    await settled(r, 'ws');
    expect(r.log.slice(5)).toEqual(['standby:webrtc', 'live:ws']);
    const back = r.sent.filter(([t, m]) => t === 'ws' && m.type === 'config_update').flatMap(([, m]) => m.messages!.map(x => x.content));
    expect(back.filter(content => content !== '(regra nova)')).toEqual(['fala 4', 'resposta 4', 'fala 5', 'resposta 5', 'fala 6', 'resposta 6']);
    expect(r.moves()).toEqual(['ws:connected', 'webrtc:policy', 'ws:policy']);
    expect(r.s.history.filter(m => m.role === 'user')).toHaveLength(7);
    expect(r.events.filter(e => e.type === 'error')).toEqual([]);
    r.s.close();
  });

  it('a signed update reaches the standby transport too, so a later move finds the same session config', async () => {
    const r = rig();
    await r.start();
    await r.turn(0);
    r.s.applyUpdate('signed.update', [{ role: 'user', content: 'resumo' }]);
    expect(r.sent.filter(([, m]) => m.type === 'config_update').map(([t, m]) => [t, (m as { signed?: string }).signed])).toEqual([['ws', 'signed.update'], ['webrtc', 'signed.update']]);
    await r.turn(5);
    await r.turn(5);
    await settled(r, 'webrtc');
    expect(r.sent.filter(([t, m]) => t === 'webrtc' && m.messages).flatMap(([, m]) => m.messages!.map(x => x.content))).toEqual(['fala 2', 'resposta 2', 'fala 3', 'resposta 3']);
    r.s.close();
  });

  it('flapping loss: the session moves at most maxSwitches times', async () => {
    const r = rig({ transportThresholds: { ...WINDOW, maxSwitches: 2 } });
    await r.start();
    for (let round = 0; round < 4; round++) {
      await r.turn(6); await r.turn(6);
      await pause(450);
      await r.turn(0); await r.turn(0);
      await pause(450);
    }
    expect([r.s.metrics.switches, r.moves()]).toEqual([2, ['ws:connected', 'webrtc:policy', 'ws:policy']]);
    r.s.close();
  });

  it('WebRTC cannot connect (UDP blocked): the session never tries to move, whatever the WS shows', async () => {
    const r = rig();
    await r.start('down');
    for (let i = 0; i < 4; i++) await r.turn(0, { ackAfterMs: 120 });
    await pause(450);
    expect([r.s.transport, r.moves(), r.events.some(e => e.type === 'error')]).toEqual(['ws', ['ws:connected'], false]);
    r.s.close();
  });

  it('late end-of-turn acks on WS are the signal too: moves to WebRTC with reason stall', async () => {
    const r = rig();
    await r.start();
    await r.turn(0, { ackAfterMs: 130 });
    await r.turn(0, { ackAfterMs: 130 });
    await settled(r, 'webrtc');
    expect(r.of('transport.switch')).toMatchObject([{ from: 'ws', to: 'webrtc', reason: 'stall' }]);
    r.s.close();
  });

  it('a turn stalled on WS is rescued by the clip, never moved mid-turn; afterwards the session goes to the WebRTC it kept ready', async () => {
    const r = rig();
    await r.start();
    await r.turn(0);
    const clip = new Blob(['utterance']);
    r.s.sendEndTurn(clip);
    await vi.waitFor(() => expect(r.clips).toEqual([clip]));
    expect(r.s.transport).toBe('ws');
    r.ctxs['s2s-stream']!.emit({ type: 'transcript', text: 'travada', final: true });
    expect([r.s.transport, r.log.includes('close:ws'), r.log.includes('live:webrtc')]).toEqual(['s2s-stream', true, false]);
    r.ctxs['s2s-stream']!.emit({ type: 'reply', text: 'resgatada' });
    r.ctxs['s2s-stream']!.emit({ type: 'done' });
    await settled(r, 'webrtc');
    expect(r.moves()).toEqual(['ws:connected', 's2s-stream:rescue', 'webrtc:upgrade']);
    expect(r.sent.filter(([t, m]) => t === 'webrtc' && m.type === 'config_update').flatMap(([, m]) => m.messages!.map(x => x.content)))
      .toEqual(['fala 1', 'resposta 1', 'travada', 'resgatada']);
    r.s.close();
  });

  it('fidelity-sensitive session: stays on WS under loss while the edge offers no loss recovery; on WebRTC without recovery observed it goes back', async () => {
    const bare = rig({ fidelity: true });
    bare.link.recovery = false;
    await bare.start();
    for (let i = 0; i < 4; i++) await bare.turn(5);
    await pause(450);
    expect(bare.s.transport).toBe('ws');
    bare.s.close();

    const exposed = rig({ fidelity: true });
    await exposed.start();
    await exposed.turn(5);
    await exposed.turn(5);
    await settled(exposed, 'webrtc');
    const unprotected: RealtimeEvent = { type: 'metrics', uplink_lost_ms: 200, uplink_recovered_ms: 0, uplink_fec_pct: 0, uplink_red_pct: 0 };
    await exposed.turn(5, { metrics: unprotected });
    await exposed.turn(5, { metrics: unprotected });
    await settled(exposed, 'ws');
    expect(exposed.of('transport.switch').map(a => (a as { reason: string }).reason)).toEqual(['loss', 'unprotected']);
    exposed.s.close();

    const guarded = rig({ fidelity: true });
    await guarded.start();
    await guarded.turn(5);
    await guarded.turn(5);
    await settled(guarded, 'webrtc');
    for (let i = 0; i < 4; i++) await guarded.turn(5, { metrics: { type: 'metrics', uplink_lost_ms: 200, uplink_recovered_ms: 180, uplink_fec_pct: 0, uplink_red_pct: 100 } });
    await pause(450);
    expect(guarded.s.transport).toBe('webrtc');
    guarded.s.close();
  });

  it('transportPolicy "ws": WebRTC is not even tried; unset: as before, WebRTC takes over as soon as it is up', async () => {
    const ws = rig({ transportPolicy: 'ws' });
    const connecting = ws.s.connect();
    await vi.waitFor(() => expect(ws.settle.ws).toBeTruthy());
    ws.settle.ws!.up();
    expect([await connecting, ws.log]).toEqual(['ws', ['try:ws']]);
    ws.s.close();

    const before = rig({ transportPolicy: undefined });
    await before.start();
    await settled(before, 'webrtc');
    expect(before.log).toEqual(['try:webrtc', 'try:ws', 'close:ws', 'live:webrtc']);
    before.s.close();
  });
});
