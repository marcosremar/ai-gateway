import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, createRealtimeSession, type RealtimeEvent, type RealtimeSessionOptions, type RealtimeTransport,
  type SessionDescriptor, type SessionRefusal, type StorageLike, type TelemetryEvent, type TransportContext, type TransportType,
} from '../../sdk/browser/realtime/index';

const DESCRIPTOR: SessionDescriptor = {
  sessionId: 'rt_later', expiresAt: '', token: 'tok',
  transports: [{ type: 'webrtc', offerUrl: 'https://gw/v1/realtime/sessions/rt_later/offer' }, { type: 'ws', url: 'wss://gw/v1/realtime/ws?token=tok' }],
};
const refused = (code: string, retryAfterSeconds = 0.02): SessionRefusal => ({ refused: true, status: 503, code, message: code, retryAfterSeconds });
const FAST = { ...DEFAULT_TIMEOUTS, readmitMs: 10, readmitMaxMs: 40, readmitForMs: 2_000 };
const TURN = [{ role: 'user', content: 'Um pão' }, { role: 'assistant', content: 'Claro!' }];
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

function rig(answers: Array<SessionDescriptor | SessionRefusal>, extra: Partial<RealtimeSessionOptions> = {}, broken: TransportType[] = []) {
  const log: string[] = [];
  const sent: Array<[TransportType, unknown]> = [];
  const ctxs: Partial<Record<TransportType, TransportContext>> = {};
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const data = new Map<string, string>();
  const storage: StorageLike = { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
  let admissions = 0;
  let endTurn: (() => void) | null = null;
  let breakTurn: (() => void) | null = null;
  const fake = (type: TransportType) => (c: TransportContext): RealtimeTransport => {
    ctxs[type] = c;
    return {
      type, clipBased: type === 's2s-stream',
      connect: async () => { log.push(`try:${type}${c.standby ? ':standby' : ''}`); if (broken.includes(type)) throw new Error(`${type} refused`); },
      send: (m) => { sent.push([type, m]); },
      sendTurn: () => new Promise<void>((resolve, reject) => {
        breakTurn = () => reject(new Error('s2s answered HTTP 502'));
        c.emit({ type: 'transcript', text: 'Um pão', final: true });
        endTurn = () => { c.emit({ type: 'reply', text: 'Claro!' }); c.emit({ type: 'done' }); resolve(); };
      }),
      goLive: () => { log.push(`live:${type}`); },
      close: () => { log.push(`close:${type}`); },
    };
  };
  const s = createRealtimeSession({
    sessionEndpoint: async () => answers[Math.min(admissions++, answers.length - 1)]!,
    getMicStream: async () => ({}) as MediaStream,
    onEvent: e => events.push(e), onRemoteAudio: () => {},
    storage, networkKey: () => 'net', timeouts: FAST, s2s: { url: '/app/s2s' },
    transports: { webrtc: fake('webrtc'), ws: fake('ws'), 's2s-stream': fake('s2s-stream') },
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  const of = (event: string) => telemetry.filter(e => e.event === event).map(e => e.attrs);
  const winner = () => (data.size ? (JSON.parse([...data.values()][0]!) as { type: string }).type : null);
  return { s, log, sent, ctxs, events, of, winner, admissions: () => admissions, endTurn: () => endTurn!(), breakTurn: () => breakTurn!() };
}

const transports = (events: RealtimeEvent[]) => events.filter(e => e.type === 'transport');

describe('a session refused at admission moves to the GPU when it is admitted later', () => {
  it('saturated: starts on the clip rung, keeps asking, and once admitted moves while idle with the history replayed once', async () => {
    const r = rig([refused('saturated'), refused('saturated'), refused('saturated'), DESCRIPTOR]);
    expect(await r.s.connect()).toBe('s2s-stream');
    expect(r.winner()).toBeNull();
    const turn = r.s.sendTurn(new Blob(['wav']));
    r.endTurn();
    await turn;
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'));
    expect(r.admissions()).toBe(4);
    expect(r.log).toEqual(['try:s2s-stream', 'try:webrtc:standby', 'close:s2s-stream', 'live:webrtc']);
    expect(r.sent).toEqual([['webrtc', { type: 'config_update', messages: TURN }]]);
    expect(r.s.history).toEqual(TURN);
    expect(transports(r.events)).toEqual([
      { type: 'transport', transport: 's2s-stream', reason: 'connected' }, { type: 'transport', transport: 'webrtc', reason: 'upgrade', from: 's2s-stream' },
    ]);
    expect(r.of('rt.session.rejected').map(a => a!.reason)).toEqual(['saturated', 'saturated', 'saturated']);
    expect(r.of('rt.ladder.upgrade')).toEqual([{ from: 's2s-stream', to: 'webrtc', reason: 'upgrade' }]);
    expect([r.s.sessionId, r.winner(), r.events.some(e => e.type === 'error')]).toEqual(['rt_later', 'webrtc', false]);
    r.s.sendEndTurn();
    expect(r.sent.at(-1)).toEqual(['webrtc', { type: 'end_turn' }]);
    r.s.close();
  });

  it('admitted in the middle of a turn: the move waits for the turn to end, the turn is neither lost nor doubled', async () => {
    const r = rig([refused('saturated'), DESCRIPTOR]);
    await r.s.connect();
    const turn = r.s.sendTurn(new Blob(['wav']));
    await vi.waitFor(() => expect(r.log).toContain('try:webrtc:standby'));
    await pause(450);
    expect([r.s.transport, r.log.includes('close:s2s-stream')]).toEqual(['s2s-stream', false]);
    r.endTurn();
    await turn;
    await vi.waitFor(() => expect(r.s.transport).toBe('webrtc'));
    expect(r.sent).toEqual([['webrtc', { type: 'config_update', messages: TURN }]]);
    expect(r.events.filter(e => e.type === 'done')).toEqual([{ type: 'done' }]);
    expect(r.events.filter(e => e.type === 'transcript')).toHaveLength(1);
    r.s.close();
  });

  it('the clip turn breaks while the realtime rung is ready: the session moves at once and says the turn was lost, once', async () => {
    const r = rig([refused('saturated'), DESCRIPTOR]);
    await r.s.connect();
    const turn = r.s.sendTurn(new Blob(['wav']));
    await vi.waitFor(() => expect(r.log).toContain('try:webrtc:standby'));
    r.breakTurn();
    await turn;
    expect(r.s.transport).toBe('webrtc');
    expect(transports(r.events).at(-1)).toEqual({ type: 'transport', transport: 'webrtc', reason: 'failover', from: 's2s-stream' });
    expect(r.events.filter(e => e.type === 'error').map(e => (e as { code: string }).code)).toEqual(['turn_lost']);
    expect(r.events.filter(e => e.type === 'done')).toEqual([{ type: 'done', error: true }]);
    r.s.close();
  });

  it('cold is treated the same; WebRTC not connecting falls to WS, still in standby', async () => {
    const r = rig([refused('cold'), DESCRIPTOR], {}, ['webrtc']);
    expect(await r.s.connect()).toBe('s2s-stream');
    await vi.waitFor(() => expect(r.s.transport).toBe('ws'));
    expect(r.log).toEqual(['try:s2s-stream', 'try:webrtc:standby', 'close:webrtc', 'try:ws:standby', 'close:s2s-stream', 'live:ws']);
    expect(transports(r.events).at(-1)).toEqual({ type: 'transport', transport: 'ws', reason: 'upgrade', from: 's2s-stream' });
    r.s.close();
  });

  it('gives up after the bound and stays on the clip rung', async () => {
    const r = rig([refused('saturated')], { timeouts: { ...FAST, readmitForMs: 120 } });
    await r.s.connect();
    await vi.waitFor(() => expect(r.of('rt.readmit.gave_up')).toEqual([{ reason: 'deadline' }]));
    const asked = r.admissions();
    expect(asked).toBeGreaterThan(2);
    await pause(150);
    expect([r.admissions(), r.s.transport]).toEqual([asked, 's2s-stream']);
    r.s.close();
  });

  it('stops on a refusal that waiting does not cure, when the page closes, and never starts with readmit: false', async () => {
    const forbidden = rig([refused('saturated'), refused('forbidden')]);
    await forbidden.s.connect();
    await vi.waitFor(() => expect(forbidden.of('rt.readmit.gave_up')).toEqual([{ reason: 'forbidden' }]));
    forbidden.s.close();

    const closing = rig([refused('saturated', 0.05)]);
    await closing.s.connect();
    closing.s.close();
    const off = rig([refused('saturated'), DESCRIPTOR], { readmit: false });
    await off.s.connect();
    await pause(200);
    expect([closing.admissions(), off.admissions(), off.s.transport]).toEqual([1, 1, 's2s-stream']);
    off.s.close();
  });
});
