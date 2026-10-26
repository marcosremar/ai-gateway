/**
 * MicCheck / Floor through the Node SDK — the same rules as `ai-gateway-audio` (Rust) and
 * `sdk/browser/voice/mic-check.ts`. Measured on the ucast.me benchmark sets (docs/medicoes.md § piso).
 */
import { describe, expect, it } from 'vitest';
import { AudioSegmenter, adviceIssues, createMicCheck, floorOf, MIC_CHECK } from '../../sdk/node/audio';

const FRAME = 512;
const PER_S = 16_000 / FRAME;

/** White noise at `db` dBFS for `seconds`, with a fixed VAD probability (or a function of the frame index). */
function feed(check: ReturnType<typeof createMicCheck>, seconds: number, db: number, prob: number | ((i: number) => number), seed = 7) {
  let state = seed;
  const noise = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state >>> 8) / 2 ** 24 - 0.5) * 3.46;
  };
  const amp = 10 ** (db / 20);
  for (let i = 0; i < seconds * PER_S; i += 1) {
    const frame = new Float32Array(FRAME);
    for (let j = 0; j < FRAME; j += 1) frame[j] = Math.max(-1, Math.min(1, noise() * amp));
    check.push(frame, typeof prob === 'function' ? prob(i) : prob);
  }
}

describe('mic check (node sdk)', () => {
  it('names the floor from the pauses', () => {
    expect(floorOf(-95, 0.6)).toBe('digitalSilence');
    expect(floorOf(-120, 0)).toBe('digitalSilence');
    expect(floorOf(-60, 0.17)).toBe('meetingFloor');
    expect(floorOf(-58, 0)).toBe('studioQuiet');
    expect(floorOf(-43, 0)).toBe('roomAmbient');
    expect(floorOf(-38, 0)).toBe('loudFloor');
  });

  it('a quiet floor hides the noisy advice but keeps far away', () => {
    const issues = ['farOrEcho', 'noisy', 'tooQuiet'] as const;
    for (const floor of ['studioQuiet', 'roomAmbient', 'meetingFloor', 'digitalSilence'] as const) {
      const kept = adviceIssues({ speechDb: -30, noiseDb: -36, vadConfidence: 0.9, clippedShare: 0, hum: null, issues: [...issues], floor });
      expect(kept).not.toContain('noisy');
      expect(kept).toContain('farOrEcho');
    }
    for (const floor of ['loudFloor', null] as const) {
      const all = [...issues];
      expect(adviceIssues({ speechDb: -30, noiseDb: -36, vadConfidence: 0.9, clippedShare: 0, hum: null, issues: [...issues], floor })).toEqual(all);
    }
  });

  it('says nothing before eight seconds of sound', () => {
    const check = createMicCheck();
    feed(check, 5, -28, 0.95);
    expect(check.report()).toBeNull();
  });

  it('a good microphone has nothing to change', () => {
    const check = createMicCheck();
    for (let second = 0; second < 30; second += 1) {
      const speaking = second % 3 < 2;
      feed(check, 1, speaking ? -28 : -65, speaking ? 0.95 : 0.05, second + 1);
    }
    const report = check.report();
    expect(report).not.toBeNull();
    expect(report!.issues).toEqual([]);
    expect(report!.floor).toBe('studioQuiet');
  });

  it('the room floor alone is not a noisy room', () => {
    const check = createMicCheck();
    feed(check, 30, -40, (i) => (i % 5 < 2 ? 0.92 : i % 5 === 2 ? 0.65 : 0.05));
    const report = check.report();
    if (report) expect(adviceIssues(report)).not.toContain('noisy');
  });

  it('a table microphone with only room tone is not a noisy room', () => {
    const check = createMicCheck();
    feed(check, 30, -58, (i) => (i % 3 === 0 ? 0.95 : 0.05));
    const report = check.report();
    if (report) expect(adviceIssues(report)).not.toContain('noisy');
  });

  it('loud noise with speech is still named', () => {
    const check = createMicCheck();
    for (let second = 0; second < 30; second += 1) {
      const speaking = second % 3 < 2;
      feed(check, 1, speaking ? -28 : -33, speaking ? 0.95 : 0.05, second + 1);
    }
    const report = check.report();
    expect(report).not.toBeNull();
    expect(adviceIssues(report!)).toContain('noisy');
    expect(report!.floor).toBe('loudFloor');
  });

  it('the segmenter exposes the report', () => {
    const segmenter = new AudioSegmenter({ vadInference: () => 0 });
    expect(segmenter.micReport()).toBeNull(); // nothing fed yet
    // 30 s alternating 2 s of loud sound and 1 s of a quiet floor, so there is sound above the floor.
    for (let i = 0; i < 30 * PER_S; i += 1) {
      const loud = i % (3 * PER_S) < 2 * PER_S;
      const amp = loud ? 4000 : 100;
      const frame = new Int16Array(FRAME);
      for (let j = 0; j < FRAME; j += 1) frame[j] = Math.round(amp * (j % 2 ? 1 : -1));
      segmenter.feedFrame(frame);
    }
    const report = segmenter.micReport();
    expect(report).not.toBeNull();
    expect(MIC_CHECK.noisyVoicedProb).toBe(0.85);
  });
});
