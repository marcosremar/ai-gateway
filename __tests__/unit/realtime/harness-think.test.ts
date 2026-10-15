import { describe, expect, it } from 'vitest';
import { mulberry32, nextAfterListening, parseThink } from '../../../scripts/realtime-e2e/think';

describe('load harness: think time after listening to the reply', () => {
  it('parses lo-hi seconds and refuses anything else', () => {
    expect(parseThink('2-6')).toEqual([2, 6]);
    expect(parseThink('1.5-1.5')).toEqual([1.5, 1.5]);
    expect([parseThink(undefined), parseThink('6-2'), parseThink('4')]).toEqual([null, null, null]);
  });

  it('the next utterance starts after the reply played out in real time plus a think time inside the range', () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const next = nextAfterListening({ firstLoud: 10_000, audioMs: 5_000 }, [2, 6], rand, 11_000);
      expect(next).toBeGreaterThanOrEqual(17_000);
      expect(next).toBeLessThan(21_000);
    }
  });

  it('a reply already over, or a turn with no audio, thinks from now', () => {
    expect(nextAfterListening({ firstLoud: 1_000, audioMs: 500 }, [3, 3], () => 0, 9_000)).toBe(12_000);
    expect(nextAfterListening({ firstLoud: null, audioMs: 0 }, [3, 3], () => 0, 9_000)).toBe(12_000);
  });

  it('the same seed gives the same think times', () => {
    const a = mulberry32(3), b = mulberry32(3), c = mulberry32(4);
    const seq = (r: () => number) => [r(), r(), r()];
    const first = seq(a);
    expect(seq(b)).toEqual(first);
    expect(seq(c)).not.toEqual(first);
  });
});
