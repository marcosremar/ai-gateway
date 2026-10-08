import { describe, expect, it } from 'vitest';
import { ceilingReport, firstReplyAudioMs, firstSoundMs, type CeilingTurn } from '../../../scripts/realtime-e2e/ceiling';

const turn = (client: string, firstLoud: number | null, events: CeilingTurn['events'] = []): CeilingTurn => ({ client, speechEnd: 1_000, firstLoud, events });

describe('load harness: the first-audio ceiling', () => {
  it('without an opener the first sound is the reply', () => {
    const t = turn('ws', 2_100, [{ type: 'audio_start', at: 2_050 }]);
    expect([firstSoundMs(t), firstReplyAudioMs(t)]).toEqual([1_100, 1_100]);
  });

  it('with an opener the reply audio is heard when it arrived and the opener is over', () => {
    const queued = turn('ws', 2_750, [{ type: 'opener', state: 'start', at: 2_700, audio_ms: 900 }, { type: 'opener', state: 'end', at: 2_700 }, { type: 'audio_start', at: 3_100 }]);
    expect([firstSoundMs(queued), firstReplyAudioMs(queued)]).toEqual([1_750, 2_600]);
    const late = turn('s2s', 2_750, [{ type: 'opener', state: 'start', at: 2_700, audio_ms: 900 }, { type: 'first_audio', at: 4_400 }, { type: 'audio_start', at: 9_999 }]);
    expect(firstReplyAudioMs(late)).toBe(3_400);
    expect(firstReplyAudioMs(turn('ws', 2_750, [{ type: 'opener', state: 'start', at: 2_700, audio_ms: 900 }]))).toBeNull();
  });

  it('the run fails on one turn over the ceiling, whatever the percentiles; shares, openers and missed deadlines are counted', () => {
    const fine = Array.from({ length: 19 }, () => turn('ws', 2_200));
    const report = ceilingReport([
      ...fine, turn('ws', 3_600, [{ type: 'deadline_missed', at: 3_000 }]), turn('ws', 2_750, [{ type: 'opener', state: 'start', at: 2_700, audio_ms: 900 }]), turn('ws', null),
    ], 2_500);
    expect(report).toEqual({
      limitMs: 2_500, turnsWithSound: 21, max: 2_600, over2000Pct: 4.8, over2500Pct: 4.8, over3000Pct: 0, overLimit: 1, openers: 1, clientOpeners: 0, deadlineMissed: 1, ok: false,
    });
    expect(ceilingReport(fine, 2_500)).toMatchObject({ max: 1_200, overLimit: 0, ok: true });
    expect(ceilingReport([turn('ws', null)], 2_500)).toMatchObject({ max: null, ok: false });
  });
});
