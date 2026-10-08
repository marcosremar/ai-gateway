/**
 * Browser realtime SDK (sdk/browser/realtime) without a browser: the ladder (order, timeouts, remembered winner),
 * the session (refused admission, mid-session failover keeping history, clip turn re-sent), the voice bridge and the
 * local telemetry emitter — with fake transports and injected clocks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TIMEOUTS, climbLadder, createLocalTelemetry, createRealtimeSession, createVoiceBridge, createWinnerMemory,
  orderWithWinner, safeAttrs, type RealtimeEvent, type RealtimeTransport, type SessionDescriptor, type StorageLike,
  type TelemetryEvent, type TransportContext, type TransportType,
} from '../../sdk/browser/realtime/index';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}

type Behaviour = 'ok' | 'fail' | 'hang';

interface Fake {
  log: string[];
  sent: Array<{ type: TransportType; msg: unknown }>;
  ctxs: Partial<Record<TransportType, TransportContext>>;
  transports: Partial<Record<TransportType, (ctx: TransportContext) => RealtimeTransport>>;
}

function fakes(behaviour: Partial<Record<TransportType, Behaviour>>, turnFails: Partial<Record<TransportType, boolean>> = {}): Fake {
  const f: Fake = { log: [], sent: [], ctxs: {}, transports: {} };
  for (const type of ['webrtc', 'ws', 's2s-stream', 'post'] as TransportType[]) {
    f.transports[type] = (ctx) => {
      f.ctxs[type] = ctx;
      return {
        type,
        clipBased: type === 's2s-stream' || type === 'post',
        connect: (signal) => {
          f.log.push(`try:${type}`);
          const b = behaviour[type] ?? 'fail';
          if (b === 'ok') return Promise.resolve();
          if (b === 'fail') return Promise.reject(new Error(`${type} refused`));
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        },
        send: (msg) => { f.sent.push({ type, msg }); },
        sendTurn: async () => {
          f.log.push(`turn:${type}`);
          if (turnFails[type]) throw new Error(`${type} turn failed`);
          ctx.emit({ type: 'transcript', text: 'oi', final: true });
          ctx.emit({ type: 'reply', text: 'olá' });
          ctx.emit({ type: 'done' });
        },
        close: () => { f.log.push(`close:${type}`); },
      };
    };
  }
  return f;
}

const DESCRIPTOR: SessionDescriptor = {
  sessionId: 'rt_test', expiresAt: '2026-10-07T10:00:00Z',
  // payload {cfg: base64url({"system":"S","messages":[{"role":"assistant","content":"Bom dia!"}]})}
  token: `h.${Buffer.from(JSON.stringify({ cfg: Buffer.from(JSON.stringify({ system: 'S', messages: [{ role: 'assistant', content: 'Bom dia!' }] })).toString('base64url') })).toString('base64url')}.s`,
  transports: [{ type: 'webrtc', offerUrl: 'https://gw/v1/realtime/sessions/rt_test/offer', iceServers: [] }, { type: 'ws', url: 'wss://gw/v1/realtime/ws?token=t' }, { type: 's2s-stream', url: '/v1/s2s' }, { type: 'post' }],
};

const FAST = { ...DEFAULT_TIMEOUTS, iceGatherMs: 10, signalingMs: 10, webrtcConnectMs: 10, wsOpenMs: 10, wsReadyMs: 10 };

function session(f: Fake, extra: Partial<Parameters<typeof createRealtimeSession>[0]> = {}) {
  const events: RealtimeEvent[] = [];
  const telemetry: TelemetryEvent[] = [];
  const s = createRealtimeSession({
    sessionEndpoint: async () => DESCRIPTOR,
    getMicStream: async () => ({}) as MediaStream,
    onEvent: e => events.push(e),
    onRemoteAudio: () => {},
    storage: null,
    timeouts: FAST,
    transports: f.transports,
    s2s: { url: '/app/s2s' },
    postTurn: async () => ({}),
    telemetry: { send: false, onEvent: e => telemetry.push(e) },
    ...extra,
  });
  return { s, events, telemetry };
}

describe('climbLadder', () => {
  it('tries in order, times a hanging rung out, keeps the first that connects', async () => {
    const f = fakes({ webrtc: 'hang', ws: 'fail', 's2s-stream': 'ok' });
    const tries: string[] = [];
    const { transport, attempts } = await climbLadder(['webrtc', 'ws', 's2s-stream', 'post'], t => f.transports[t]!({} as TransportContext), {
      timeouts: FAST, onTry: t => tries.push(t),
    });
    expect(transport.type).toBe('s2s-stream');
    expect(tries).toEqual(['webrtc', 'ws', 's2s-stream']);
    expect(attempts.map(a => [a.type, a.ok])).toEqual([['webrtc', false], ['ws', false], ['s2s-stream', true]]);
    expect(attempts[0]!.error).toMatch(/timeout after 30 ms/);
    expect(f.log).toContain('close:webrtc');
  });

  it('throws LadderExhausted with every attempt when nothing connects', async () => {
    const f = fakes({});
    await expect(climbLadder(['ws', 'post'], t => f.transports[t]!({} as TransportContext), { timeouts: FAST }))
      .rejects.toMatchObject({ attempts: [expect.objectContaining({ type: 'ws' }), expect.objectContaining({ type: 'post' })] });
  });
});

describe('winner memory', () => {
  it('remembers per network with a TTL, survives a throwing storage', () => {
    let now = 1000;
    const storage = memoryStorage();
    const m = createWinnerMemory(storage, { ttlMs: 100, now: () => now });
    m.set('wifi/4g', 'ws');
    expect(m.get('wifi/4g')).toBe('ws');
    expect(m.get('cellular/4g')).toBeNull();
    now += 101;
    expect(m.get('wifi/4g')).toBeNull();
    expect(storage.data.size).toBe(0);
    const broken = createWinnerMemory({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} });
    expect(() => broken.set('x', 'ws')).not.toThrow();
    expect(broken.get('x')).toBeNull();
    expect(orderWithWinner(['webrtc', 'ws', 'post'], 'ws')).toEqual(['ws', 'webrtc', 'post']);
    expect(orderWithWinner(['webrtc', 'post'], 'ws')).toEqual(['webrtc', 'post']);
  });
});

describe('createRealtimeSession', () => {
  afterEach(() => vi.useRealTimers());

  it('connects on the first rung that works, remembers it, and starts there next time on the same network', async () => {
    const storage = memoryStorage();
    const f1 = fakes({ webrtc: 'fail', ws: 'ok' });
    const a = session(f1, { storage, networkKey: () => 'school-wifi' });
    expect(await a.s.connect()).toBe('ws');
    expect(a.events).toContainEqual({ type: 'transport', transport: 'ws', reason: 'connected' });
    a.s.close();
    const f2 = fakes({ webrtc: 'ok', ws: 'ok' });
    const b = session(f2, { storage, networkKey: () => 'school-wifi' });
    expect(await b.s.connect()).toBe('ws');
    expect(f2.log[0]).toBe('try:ws');
    b.s.close();
  });

  it('a refused admission (cold) skips the realtime rungs at once and lands on s2s-stream', async () => {
    const f = fakes({ webrtc: 'ok', ws: 'ok', 's2s-stream': 'ok' });
    const { s, telemetry } = session(f, { sessionEndpoint: async () => ({ refused: true, status: 503, code: 'cold', message: 'waking', retryAfterSeconds: 30 }) });
    expect(await s.connect()).toBe('s2s-stream');
    expect(f.log).toEqual(['try:s2s-stream']);
    expect(telemetry.find(e => e.event === 'rt.session.rejected')).toMatchObject({ level: 'warn', attrs: { reason: 'cold', status: 503 } });
    s.close();
  });

  it('mid-session failure: next rung down, new session, history replayed with config_update', async () => {
    let sessions = 0;
    const f = fakes({ webrtc: 'ok', ws: 'ok' });
    const { s, events, telemetry } = session(f, { sessionEndpoint: async () => { sessions++; return DESCRIPTOR; } });
    expect(await s.connect()).toBe('webrtc');
    const rtc = f.ctxs.webrtc!;
    rtc.emit({ type: 'transcript', text: 'Bom dia, um pão', final: true });
    rtc.emit({ type: 'reply', text: 'Claro!' });
    s.updateHistory([{ role: 'user', content: '(nota)' }]);
    rtc.fail(new Error('connection lost'));
    await vi.waitFor(() => expect(s.transport).toBe('ws'));
    expect(sessions).toBe(2);
    expect(f.sent.find(x => x.type === 'ws')!.msg).toEqual({
      type: 'config_update',
      messages: [{ role: 'user', content: 'Bom dia, um pão' }, { role: 'assistant', content: 'Claro!' }, { role: 'user', content: '(nota)' }],
    });
    expect(events).toContainEqual({ type: 'transport', transport: 'ws', reason: 'failover', from: 'webrtc' });
    expect(s.metrics.failovers).toBe(1);
    expect(telemetry.some(e => e.event === 'rt.ladder.fallback' && e.attrs?.from === 'webrtc' && e.attrs?.to === 'ws')).toBe(true);
    // No transcript or reply text ever leaves in telemetry.
    expect(JSON.stringify(telemetry)).not.toMatch(/pão|Claro|nota/);
    s.close();
  });

  it('end_turn / interrupt go to the realtime transport; a clip turn that fails is re-sent on the next rung', async () => {
    const f = fakes({ ws: 'ok' });
    const a = session(f, { preferredTransports: ['ws'] });
    await a.s.connect();
    a.s.sendEndTurn();
    a.s.interrupt();
    expect(f.sent.map(x => x.msg)).toEqual([{ type: 'end_turn' }, { type: 'interrupt' }]);
    a.s.close();

    const g = fakes({ 's2s-stream': 'ok', post: 'ok' }, { 's2s-stream': true });
    const b = session(g, { preferredTransports: ['s2s-stream', 'post'] });
    expect(await b.s.connect()).toBe('s2s-stream');
    await b.s.sendTurn(new Blob(['wav']));
    expect(g.log).toEqual(['try:s2s-stream', 'turn:s2s-stream', 'close:s2s-stream', 'try:post', 'turn:post']);
    expect(b.s.transport).toBe('post');
    expect(b.s.history).toEqual([{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }]);
    expect(b.telemetry.filter(e => e.event === 'turn.done')).toHaveLength(1);
    expect(b.telemetry.find(e => e.event === 'turn.done')!.turnId).toMatch(/^turn_/);
    b.s.close();
  });

  it('clip rungs get the token config with the conversation; every event carries the trace id', async () => {
    const f = fakes({ 's2s-stream': 'ok' });
    const { s, telemetry } = session(f, { preferredTransports: ['webrtc', 's2s-stream'] });
    await s.connect();
    expect(f.ctxs['s2s-stream']!.config()).toEqual({ system: 'S', messages: [{ role: 'assistant', content: 'Bom dia!' }] });
    expect(f.ctxs['s2s-stream']!.traceparent).toMatch(new RegExp(`^00-${s.traceId}-[0-9a-f]{16}-01$`));
    expect(telemetry.length).toBeGreaterThan(0);
    expect(telemetry.every(e => e.traceId === s.traceId && e.source === 'browser')).toBe(true);
    expect(telemetry.find(e => e.event === 'rt.session.admitted')!.sessionId).toBe('rt_test');
    s.close();
  });

  it('clip rung: the page and turn.done learn who served the turn and why not the GPU', async () => {
    const f = fakes({});
    f.transports['s2s-stream'] = (ctx) => ({
      type: 's2s-stream', clipBased: true, connect: async () => {}, send: () => {}, close: () => {},
      sendTurn: async () => {
        ctx.emit({ type: 'route', provider: 'composite', fallback: 'saturated' });
        ctx.emit({ type: 'transcript', text: 'oi', final: true });
        ctx.emit({ type: 'done' });
      },
    });
    const { s, events, telemetry } = session(f, { preferredTransports: ['s2s-stream'] });
    await s.connect();
    await s.sendTurn(new Blob(['wav']));
    expect(events).toContainEqual({ type: 'route', provider: 'composite', fallback: 'saturated' });
    expect(telemetry.find(e => e.event === 'turn.done')!.attrs).toMatchObject({ transport: 's2s-stream', provider: 'composite', fallback: 'saturated' });
    s.close();
  });

  it('an opener and a missed deadline reach the page and the telemetry, with the turn they belong to', async () => {
    const f = fakes({});
    f.transports['s2s-stream'] = (ctx) => ({
      type: 's2s-stream', clipBased: true, connect: async () => {}, send: () => {}, close: () => {},
      sendTurn: async () => {
        ctx.emit({ type: 'opener', state: 'start', text: 'Hum, deixa eu ver.', index: 1, audio_ms: 900 });
        ctx.emit({ type: 'opener', state: 'end', index: 1 });
        ctx.emit({ type: 'deadline_missed', deadline_ms: 2000 });
        ctx.emit({ type: 'transcript', text: 'oi', final: true });
        ctx.emit({ type: 'metrics', ttfa_ms: 2900, first_sound_ms: 1700, opener: 'Hum, deixa eu ver.', deadline_missed: false });
        ctx.emit({ type: 'done' });
      },
    });
    const { s, events, telemetry } = session(f, { preferredTransports: ['s2s-stream'] });
    await s.connect();
    await s.sendTurn(new Blob(['wav']));
    expect(events).toContainEqual({ type: 'opener', state: 'start', text: 'Hum, deixa eu ver.', index: 1, audio_ms: 900 });
    const opener = telemetry.find(e => e.event === 'turn.opener')!;
    expect(opener.attrs).toMatchObject({ index: 1, transport: 's2s-stream' });
    expect(opener.turnId).toBe(telemetry.find(e => e.event === 'turn.done')!.turnId);
    expect(telemetry.find(e => e.event === 'turn.deadline_missed')!.attrs).toMatchObject({ deadlineMs: 2000 });
    expect(s.metrics.lastTurn).toMatchObject({ ttfa_ms: 2900, first_sound_ms: 1700, opener: 'Hum, deixa eu ver.', deadline_missed: false });
    s.close();
  });

  it('nothing connects: error + closed', async () => {
    const f = fakes({});
    const { s, events } = session(f);
    await expect(s.connect()).rejects.toThrow(/no transport connected/);
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['error', 'closed']));
  });
});

describe('voice bridge', () => {
  it('ends the turn after the rest of endSilence, cancels on new voice, interrupts the NPC on barge-in', () => {
    vi.useFakeTimers();
    let t = 0;
    const calls: string[] = [];
    let speaking = false;
    const bridge = createVoiceBridge({
      endAfterVadEndMs: 500, npcSpeaking: () => speaking, clipMode: () => false, now: () => t,
      onInterrupt: () => calls.push('interrupt'), onEndTurn: ms => calls.push(`end:${ms}`), onSegment: ms => calls.push(`seg:${ms}`),
    });
    bridge.onEffect({ kind: 'vadStart' } as never);
    t = 800;
    bridge.onEffect({ kind: 'vadEnd' } as never);
    vi.advanceTimersByTime(300);
    t = 1100;
    bridge.onEffect({ kind: 'vadStart' } as never); // the learner goes on: no end yet
    t = 1500;
    bridge.onEffect({ kind: 'vadEnd' } as never);
    t = 2000;
    vi.advanceTimersByTime(500);
    expect(calls).toEqual(['seg:800', 'seg:400', 'end:2000']);
    speaking = true;
    bridge.onEffect({ kind: 'vadStart' } as never);
    expect(calls.at(-1)).toBe('interrupt');
    vi.useRealTimers();
  });

  it('in clip mode hands the effects to turn-taking and sends no end_turn', () => {
    const effects: string[] = [];
    const ends: number[] = [];
    const bridge = createVoiceBridge({
      endAfterVadEndMs: 0, npcSpeaking: () => false, clipMode: () => true, onInterrupt: () => {}, onEndTurn: ms => ends.push(ms),
      onClipEffect: e => effects.push(e.kind), setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {},
    });
    bridge.onEffect({ kind: 'rmsOnset' } as never);
    bridge.onEffect({ kind: 'vadStart' } as never);
    bridge.onEffect({ kind: 'vadEnd' } as never);
    expect(effects).toEqual(['rmsOnset', 'vadStart', 'vadEnd']);
    expect(ends).toEqual([]);
  });
});

describe('local telemetry', () => {
  it('batches ≤ 100 events with the session token and traceparent, drops content attributes', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const t = createLocalTelemetry({ fetchImpl: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 202 }); }) as never });
    for (let i = 0; i < 150; i++) t.emit('vad.segment', { durMs: i, attrs: { transcript: 'secret words', textLength: 12, code: 1006 } });
    expect(calls).toHaveLength(0); // not bound yet: nowhere to send
    t.bind('rt_x', 'session-token', 'https://gw/v1/telemetry/events');
    await t.flush();
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0]!.init.body)) as { events: TelemetryEvent[] };
    expect(first.events).toHaveLength(100);
    expect(first.events[0]).toMatchObject({ source: 'browser', event: 'vad.segment', traceId: t.traceId, sessionId: 'rt_x', durMs: 0, attrs: { code: 1006 } });
    expect(typeof first.events[0]!.ts).toBe('number');
    expect(Math.abs(first.events[0]!.ts - Date.now())).toBeLessThan(60_000);
    expect(JSON.stringify(first)).not.toContain('secret');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    expect((calls[0]!.init.headers as Record<string, string>).traceparent).toBe(t.traceparent);
    expect(safeAttrs({ sdp: 'v=0', token: 'x', reply_text: 'y', ok: true, long: 'z'.repeat(100) })).toEqual({ ok: true });
    t.close();
  });
});
