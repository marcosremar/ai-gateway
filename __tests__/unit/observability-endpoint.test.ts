import { describe, it, expect, beforeEach } from 'vitest';
import {
  attachObserver,
  detachObserver,
  emitFrame,
  getObservers,
  UserBotLatencyObserver,
} from '../../src/observers';

describe('Observability — UserBotLatencyObserver full pipeline simulation', () => {
  beforeEach(() => {
    for (const o of getObservers()) detachObserver(o);
  });

  it('emits a turn-latency record for a full STT→LLM→TTS turn', () => {
    const captured: number[] = [];
    const breakdowns: Array<{ totalMs: number; sttFinalMs: number | null; llmTtftMs: number | null; ttsTtfaMs: number | null; providers: { stt?: string; llm?: string; tts?: string } }> = [];
    attachObserver(new UserBotLatencyObserver({
      onLatencyMeasured: (m) => captured.push(m.totalMs),
      onLatencyBreakdown: (b) => breakdowns.push(b),
    }));

    const t0 = 1_000_000;
    emitFrame({ kind: 'user_speech_start', ts: t0, stage: 'stt', provider: 'deepgram' });
    emitFrame({ kind: 'stt_partial', ts: t0 + 250, stage: 'stt', provider: 'deepgram' });
    emitFrame({ kind: 'stt_final', ts: t0 + 700, stage: 'stt', provider: 'deepgram' });
    emitFrame({ kind: 'llm_request', ts: t0 + 720, stage: 'llm', provider: 'groq' });
    emitFrame({ kind: 'llm_first_token', ts: t0 + 1000, stage: 'llm', provider: 'groq' });
    emitFrame({ kind: 'llm_complete', ts: t0 + 1400, stage: 'llm', provider: 'groq' });
    emitFrame({ kind: 'tts_first_audio', ts: t0 + 1200, stage: 'tts', provider: 'modal' });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(1200);
    expect(breakdowns).toHaveLength(1);
    expect(breakdowns[0].sttFinalMs).toBe(700);
    expect(breakdowns[0].llmTtftMs).toBe(300);
    expect(breakdowns[0].ttsTtfaMs).toBe(200);
    expect(breakdowns[0].providers).toEqual({ stt: 'deepgram', llm: 'groq', tts: 'modal' });
  });

  it('handles interrupted turn (new user_speech_start mid-turn)', () => {
    let count = 0;
    attachObserver(new UserBotLatencyObserver({
      onLatencyMeasured: () => { count++; },
    }));
    emitFrame({ kind: 'user_speech_start', ts: 0 });
    emitFrame({ kind: 'stt_partial', ts: 100 });
    // Interruption
    emitFrame({ kind: 'user_speech_start', ts: 200 });
    emitFrame({ kind: 'tts_first_audio', ts: 800 });
    expect(count).toBe(1);
  });

  it('does not emit if no end frame', () => {
    let count = 0;
    attachObserver(new UserBotLatencyObserver({
      onLatencyMeasured: () => { count++; },
    }));
    emitFrame({ kind: 'user_speech_start', ts: 0 });
    emitFrame({ kind: 'stt_final', ts: 500 });
    emitFrame({ kind: 'llm_complete', ts: 1000 });
    expect(count).toBe(0);
  });
});
