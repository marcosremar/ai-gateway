import { describe, it, expect } from 'vitest';
import { TurnTrackingObserver, type TurnEvent } from '../../src/observers';

describe('TurnTrackingObserver', () => {
  it('emits user-turn-started/ended + bot-turn-started/ended for full pipeline', () => {
    const events: Array<{ name: string; turnId: number; provider?: string; transcript?: string; audioBytes?: number }> = [];
    const o = new TurnTrackingObserver({
      onUserTurnStarted: (e) => events.push({ name: 'user_started', turnId: e.turnId, provider: e.provider }),
      onUserTurnEnded: (e) => events.push({ name: 'user_ended', turnId: e.turnId, transcript: e.transcript }),
      onBotTurnStarted: (e) => events.push({ name: 'bot_started', turnId: e.turnId }),
      onBotTurnEnded: (e) => events.push({ name: 'bot_ended', turnId: e.turnId, audioBytes: e.audioBytes }),
    });

    o.onFrame({ kind: 'user_speech_start', ts: 0, provider: 'deepgram' });
    o.onFrame({ kind: 'stt_partial', ts: 100, provider: 'deepgram' });
    o.onFrame({ kind: 'stt_final', ts: 500, provider: 'deepgram', meta: { text: 'Hello world' } });
    o.onFrame({ kind: 'llm_request', ts: 510 });
    o.onFrame({ kind: 'llm_first_token', ts: 800, provider: 'groq' });
    o.onFrame({ kind: 'tts_first_audio', ts: 1000, provider: 'modal', meta: { bytes: 12345 } });
    o.onFrame({ kind: 'tts_complete', ts: 1500, provider: 'modal' });

    expect(events.map(e => e.name)).toEqual(['user_started', 'user_ended', 'bot_started', 'bot_ended']);
    expect(events[0].turnId).toBe(1);
    expect(events[1].transcript).toBe('Hello world');
    expect(events[2].turnId).toBe(1);
    expect(events[3].audioBytes).toBe(12345);
  });

  it('increments turn id on each new user_speech_start', () => {
    const ids: number[] = [];
    const o = new TurnTrackingObserver({ onUserTurnStarted: (e) => ids.push(e.turnId) });
    o.onFrame({ kind: 'user_speech_start', ts: 0 });
    o.onFrame({ kind: 'stt_final', ts: 100 });
    o.onFrame({ kind: 'tts_complete', ts: 200 });
    o.onFrame({ kind: 'user_speech_start', ts: 300 });
    o.onFrame({ kind: 'stt_final', ts: 400 });
    o.onFrame({ kind: 'tts_complete', ts: 500 });
    expect(ids).toEqual([1, 2]);
  });

  it('closes open bot turn when interrupted by new user_speech_start', () => {
    const events: string[] = [];
    const o = new TurnTrackingObserver({
      onBotTurnStarted: () => events.push('bot_started'),
      onBotTurnEnded: () => events.push('bot_ended'),
      onUserTurnStarted: () => events.push('user_started'),
    });
    o.onFrame({ kind: 'user_speech_start', ts: 0 });
    o.onFrame({ kind: 'tts_first_audio', ts: 500 });
    // User interrupts before tts_complete
    o.onFrame({ kind: 'user_speech_start', ts: 700 });
    expect(events).toEqual(['user_started', 'bot_started', 'bot_ended', 'user_started']);
  });

  it('survives observer-handler exceptions', () => {
    const seen: TurnEvent[] = [];
    const o = new TurnTrackingObserver({
      onUserTurnStarted: () => { throw new Error('boom'); },
      onUserTurnEnded: (e) => seen.push(e),
    });
    expect(() => o.onFrame({ kind: 'user_speech_start', ts: 0 })).not.toThrow();
    o.onFrame({ kind: 'stt_final', ts: 100 });
    expect(seen).toHaveLength(1);
  });
});
