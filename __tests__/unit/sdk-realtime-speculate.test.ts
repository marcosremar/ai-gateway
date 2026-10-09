import { describe, expect, it } from 'vitest';
import { encodeEvent } from '../../src/s2s/frames';
import { DEFAULT_TIMEOUTS, type PcmPlayer, type RealtimeEvent, type TransportContext } from '../../sdk/browser/realtime/index';
import { createS2SStreamTransport } from '../../sdk/browser/realtime/transports/clip';
import { createLocalTelemetry } from '../../sdk/browser/realtime/telemetry';
import { initialVoiceActivity, stepVoiceActivity, VOICE_ACTIVITY_TUNING } from '../../sdk/browser/voice/voice-activity';

const player: PcmPlayer = { pushPcm16: () => {}, pushFloat: () => {}, flush: () => {}, playing: false, idle: async () => {}, pushEncoded: async () => {}, close: () => {} };

function rung(provider: string) {
  const posts: Array<{ config: Record<string, unknown>; file: boolean }> = [];
  const telemetry = createLocalTelemetry({ send: false });
  const events: RealtimeEvent[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const form = init.body as FormData;
    const config = JSON.parse(String(form.get('config'))) as Record<string, unknown>;
    posts.push({ config, file: form.has('file') });
    const action = (config.speculation as { action?: string } | undefined)?.action;
    if (action) return new Response(JSON.stringify({ speculative: true }), { status: 202 });
    const frames = [{ type: 'route', provider }, { type: 'transcript', text: 'oi' }, { type: 'done', reply: '', transcript: 'oi' }].map(e => encodeEvent(e, 'binary'));
    return new Response(Buffer.concat(frames));
  }) as unknown as typeof fetch;
  const ctx: TransportContext = {
    descriptor: null, timeouts: DEFAULT_TIMEOUTS, fetchImpl, telemetry, traceparent: telemetry.traceparent,
    mic: async () => ({}) as MediaStream, emit: e => events.push(e), fail: () => {}, remoteAudio: () => {}, config: () => ({ system: 's' }), dropped: () => {},
  };
  return { t: createS2SStreamTransport(ctx, { url: '/s2s' }, async () => player), posts };
}

const wav = new Blob(['x'], { type: 'audio/wav' });
const ref = (p: { config: Record<string, unknown> }) => p.config.speculation as { id: string; turn?: string; action?: string } | undefined;

describe('s2s-stream rung: speculative clip', () => {
  it('speculates only after a turn answered by the composed fallback, and the turn names its speculation', async () => {
    const { t, posts } = rung('composite');
    t.speculate!(wav);
    expect(posts).toHaveLength(0);
    await t.sendTurn!(wav);
    t.speculate!(wav);
    expect(ref(posts[1])).toMatchObject({ action: 'start' });
    expect(posts[1].config.system).toBe('s');
    await t.sendTurn!(wav);
    expect(ref(posts[2])).toEqual({ id: ref(posts[1])!.id });
    await t.sendTurn!(wav);
    expect(ref(posts[3])).toBeUndefined();
  });

  it('speech resumed: the speculation is cancelled and the turn does not name it; at most two per turn', async () => {
    const { t, posts } = rung('composite');
    await t.sendTurn!(wav);
    t.speculate!(wav);
    t.cancelSpeculation!();
    expect(posts[2]).toMatchObject({ file: false, config: { speculation: { id: ref(posts[1])!.id, action: 'cancel' } } });
    t.speculate!(wav);
    t.cancelSpeculation!();
    t.speculate!(wav);
    expect(posts.filter(p => ref(p)?.action === 'start')).toHaveLength(2);
    await t.sendTurn!(wav);
    expect(ref(posts.at(-1)!)).toBeUndefined();
  });

  it('a turn answered by the GPU stops the speculation', async () => {
    const { t, posts } = rung('deployment:parle-speech');
    await t.sendTurn!(wav);
    t.speculate!(wav);
    expect(posts).toHaveLength(1);
  });
});

describe('voice activity: early pause', () => {
  const run = (probabilities: number[], pauseFrames?: number) => {
    let state = { ...initialVoiceActivity(), stage: 'speech' as const };
    const kinds: string[] = [];
    for (const probability of probabilities) {
      const next = stepVoiceActivity(state, { rms: 0.1, probability }, { ...VOICE_ACTIVITY_TUNING, ...(pauseFrames ? { pauseFrames } : {}) });
      state = next.state as typeof state;
      kinds.push(...next.effects.map(e => e.kind));
    }
    return kinds;
  };

  it('vadPause after pauseFrames low frames, vadResume when the voice comes back, vadEnd unchanged', () => {
    expect(run([0.9, 0.1, 0.1, 0.1, 0.1, 0.9], 4)).toEqual(['vadPause', 'vadResume']);
    expect(run([0.9, 0.1, 0.1, 0.9], 4)).toEqual([]);
    expect(run([0.9, ...Array(10).fill(0.1)], 4)).toEqual(['vadPause', 'vadEnd']);
    expect(run([0.9, ...Array(10).fill(0.1)])).toEqual(['vadEnd']);
  });
});
