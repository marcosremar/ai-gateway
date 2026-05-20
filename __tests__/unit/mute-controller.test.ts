import { describe, it, expect, vi } from 'vitest';
import { MuteController } from '../../src/observers';

describe('MuteController', () => {
  it('always_mute_during_bot_speech: mutes on tts_first_audio, unmutes on tts_complete', () => {
    const m = new MuteController({ strategy: 'always_mute_during_bot_speech' });
    expect(m.shouldDropUserAudio()).toBe(false);
    m.onFrame({ kind: 'tts_first_audio', ts: 0 });
    expect(m.shouldDropUserAudio()).toBe(true);
    m.onFrame({ kind: 'tts_complete', ts: 100 });
    expect(m.shouldDropUserAudio()).toBe(false);
  });

  it('always_mute: user_speech_start during muted does NOT unmute', () => {
    const m = new MuteController({ strategy: 'always_mute_during_bot_speech' });
    m.onFrame({ kind: 'tts_first_audio', ts: 0 });
    m.onFrame({ kind: 'user_speech_start', ts: 50 });
    expect(m.isMuted()).toBe(true);
  });

  it('mute_until_first_word: user_speech_start unmutes immediately', () => {
    const m = new MuteController({ strategy: 'mute_until_first_word' });
    m.onFrame({ kind: 'tts_first_audio', ts: 0 });
    expect(m.isMuted()).toBe(true);
    m.onFrame({ kind: 'user_speech_start', ts: 50 });
    expect(m.isMuted()).toBe(false);
  });

  it('mute_until_first_word: auto-unmutes after timeout', () => {
    vi.useFakeTimers();
    try {
      const m = new MuteController({ strategy: 'mute_until_first_word', unmuteAfterMs: 1000 });
      m.onFrame({ kind: 'tts_first_audio', ts: 0 });
      expect(m.isMuted()).toBe(true);
      vi.advanceTimersByTime(1100);
      expect(m.isMuted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never strategy: no muting ever', () => {
    const m = new MuteController({ strategy: 'never' });
    m.onFrame({ kind: 'tts_first_audio', ts: 0 });
    expect(m.shouldDropUserAudio()).toBe(false);
    expect(m.isMuted()).toBe(false);
  });

  it('fires onMuteChange callback on transitions', () => {
    const states: boolean[] = [];
    const m = new MuteController({
      strategy: 'always_mute_during_bot_speech',
      onMuteChange: (v) => states.push(v),
    });
    m.onFrame({ kind: 'tts_first_audio', ts: 0 });
    m.onFrame({ kind: 'tts_complete', ts: 100 });
    expect(states).toEqual([true, false]);
  });
});
