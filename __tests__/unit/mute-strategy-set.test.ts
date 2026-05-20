/**
 * setMuteStrategy test — verifies runtime strategy switching detaches the
 * old MuteController and attaches a new one.
 */
import { describe, it, expect } from 'vitest';
import { emitFrame } from '../../src/observers';

describe('setMuteStrategy', () => {
  it('switches strategy at runtime; new strategy applies to subsequent frames', async () => {
    const { initObservers, setMuteStrategy, getMuteState } = await import('../../server/observers-init');
    initObservers();
    const r = setMuteStrategy('never');
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('never');
    expect(getMuteState().strategy).toBe('never');
    // With strategy=never, tts_first_audio should NOT mute.
    emitFrame({ kind: 'tts_first_audio', ts: Date.now() });
    expect(getMuteState().muted).toBe(false);
  });

  it('rejects unknown strategy', async () => {
    const { initObservers, setMuteStrategy } = await import('../../server/observers-init');
    initObservers();
    const r = setMuteStrategy('garbage' as never);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Invalid');
  });

  it('always_mute_during_bot_speech mutes after switch', async () => {
    const { initObservers, setMuteStrategy, getMuteState } = await import('../../server/observers-init');
    initObservers();
    setMuteStrategy('always_mute_during_bot_speech');
    emitFrame({ kind: 'tts_first_audio', ts: Date.now() });
    expect(getMuteState().muted).toBe(true);
    emitFrame({ kind: 'tts_complete', ts: Date.now() });
    expect(getMuteState().muted).toBe(false);
  });
});
