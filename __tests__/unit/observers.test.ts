import { describe, it, expect, beforeEach } from 'vitest';
import {
  attachObserver,
  detachObserver,
  emitFrame,
  getObservers,
  UserBotLatencyObserver,
  DebugLogObserver,
  type PipelineFrame,
  type LatencyBreakdown,
} from '../../src/observers';

describe('observers registry', () => {
  beforeEach(() => {
    for (const o of getObservers()) detachObserver(o);
  });

  it('attaches and detaches', () => {
    const o = new DebugLogObserver({ log: () => {} });
    expect(getObservers()).toHaveLength(0);
    const remove = attachObserver(o);
    expect(getObservers()).toHaveLength(1);
    remove();
    expect(getObservers()).toHaveLength(0);
  });

  it('broadcasts to all attached observers', () => {
    const seen: string[] = [];
    const o1 = new DebugLogObserver({ log: (line) => seen.push(`1:${line}`) });
    const o2 = new DebugLogObserver({ log: (line) => seen.push(`2:${line}`) });
    attachObserver(o1);
    attachObserver(o2);
    emitFrame({ kind: 'llm_first_token', ts: 100, provider: 'groq' });
    expect(seen).toHaveLength(2);
  });

  it('filters frame kinds when configured', () => {
    const seen: string[] = [];
    const o = new DebugLogObserver({ filter: ['llm_first_token'], log: (l) => seen.push(l) });
    attachObserver(o);
    emitFrame({ kind: 'tts_first_audio', ts: 1 });
    emitFrame({ kind: 'llm_first_token', ts: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('llm_first_token');
  });

  it('isolates observer exceptions', () => {
    const goodSeen: PipelineFrame[] = [];
    class Bad extends DebugLogObserver {
      override readonly name = 'bad';
      override onFrame() { throw new Error('intentional'); }
    }
    attachObserver(new Bad({ log: () => {} }));
    attachObserver(new DebugLogObserver({ log: (l) => goodSeen.push({ kind: 'llm_first_token', ts: 0 }) }));
    emitFrame({ kind: 'llm_first_token', ts: 5 });
    expect(goodSeen).toHaveLength(1);
  });
});

describe('UserBotLatencyObserver', () => {
  it('measures total + per-stage breakdown', () => {
    let total: number | null = null;
    let breakdown: LatencyBreakdown | null = null;
    const o = new UserBotLatencyObserver({
      onLatencyMeasured: (m) => { total = m.totalMs; },
      onLatencyBreakdown: (b) => { breakdown = b; },
    });
    o.onFrame({ kind: 'user_speech_start', ts: 0 });
    o.onFrame({ kind: 'stt_partial', ts: 200, provider: 'deepgram' });
    o.onFrame({ kind: 'stt_final', ts: 800, provider: 'deepgram' });
    o.onFrame({ kind: 'llm_request', ts: 810, provider: 'groq' });
    o.onFrame({ kind: 'llm_first_token', ts: 1100, provider: 'groq' });
    o.onFrame({ kind: 'llm_complete', ts: 1500, provider: 'groq' });
    o.onFrame({ kind: 'tts_first_audio', ts: 1300, provider: 'modal' });
    expect(total).toBe(1300);
    expect(breakdown).not.toBeNull();
    if (breakdown) {
      expect(breakdown.totalMs).toBe(1300);
      expect(breakdown.sttTtfbMs).toBe(200);
      expect(breakdown.sttFinalMs).toBe(800);
      expect(breakdown.llmTtftMs).toBe(300);
      expect(breakdown.ttsTtfaMs).toBe(200);
      expect(breakdown.providers).toEqual({ stt: 'deepgram', llm: 'groq', tts: 'modal' });
    }
  });

  it('starts a new turn on user_speech_start (interrupt)', () => {
    let count = 0;
    const o = new UserBotLatencyObserver({
      onLatencyMeasured: () => { count++; },
    });
    o.onFrame({ kind: 'user_speech_start', ts: 0 });
    o.onFrame({ kind: 'user_speech_start', ts: 50 });
    o.onFrame({ kind: 'tts_first_audio', ts: 500 });
    expect(count).toBe(1); // only second turn measured
  });

  it('does not emit if no end frame', () => {
    let count = 0;
    const o = new UserBotLatencyObserver({
      onLatencyMeasured: () => { count++; },
    });
    o.onFrame({ kind: 'user_speech_start', ts: 0 });
    o.onFrame({ kind: 'stt_final', ts: 500 });
    expect(count).toBe(0);
  });
});
