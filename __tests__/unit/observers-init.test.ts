/**
 * observers-init test — verifies the boot-time observer wiring.
 * Module is singleton-scoped: detaching observers between tests breaks
 * the muteController binding. We rely on initObservers() idempotency
 * and never tear down between tests.
 */
import { describe, it, expect } from 'vitest';
import { emitFrame } from '../../src/observers';

describe('observers-init', () => {
  it('initObservers attaches observers idempotently', async () => {
    const { initObservers } = await import('../../server/observers-init');
    initObservers();
    initObservers();
    initObservers();
    // No throw, no double-attach (verified by sequential subscribe tests below).
  });

  it('getRecentTurnLatencies + getRecentTurns are arrays', async () => {
    const { initObservers, getRecentTurnLatencies, getRecentTurns } = await import('../../server/observers-init');
    initObservers();
    expect(Array.isArray(getRecentTurnLatencies())).toBe(true);
    expect(Array.isArray(getRecentTurns())).toBe(true);
  });

  it('subscribeFrames delivers emitted frames + unsubscribe removes listener', async () => {
    const { initObservers, subscribeFrames } = await import('../../server/observers-init');
    initObservers();
    const seen: string[] = [];
    const unsub = subscribeFrames((f) => seen.push(f.kind));
    emitFrame({ kind: 'llm_request', ts: Date.now() });
    emitFrame({ kind: 'llm_complete', ts: Date.now() });
    expect(seen).toEqual(['llm_request', 'llm_complete']);
    unsub();
    emitFrame({ kind: 'tts_request', ts: Date.now() });
    expect(seen).toHaveLength(2);
  });

  it('getMuteState exposes strategy when configured', async () => {
    const { initObservers, getMuteState } = await import('../../server/observers-init');
    initObservers();
    const state = getMuteState();
    expect(state).toHaveProperty('muted');
    expect(state).toHaveProperty('strategy');
    expect(typeof state.muted).toBe('boolean');
  });

  it('TurnRecord ring buffer captures observed turns', async () => {
    const { initObservers, getRecentTurns } = await import('../../server/observers-init');
    initObservers();
    const before = getRecentTurns().length;
    emitFrame({ kind: 'user_speech_start', ts: Date.now(), provider: 'deepgram' });
    emitFrame({ kind: 'stt_final', ts: Date.now() + 100, provider: 'deepgram', meta: { text: 'test' } });
    emitFrame({ kind: 'tts_first_audio', ts: Date.now() + 200, provider: 'modal', meta: { bytes: 100 } });
    emitFrame({ kind: 'tts_complete', ts: Date.now() + 500, provider: 'modal' });
    const after = getRecentTurns().length;
    expect(after).toBeGreaterThan(before);
  });
});
