/**
 * Tests for sdk/browser/voice/voice-level.ts — what Silero hears is put at the level of normal speech (a voice from
 * across a room was taken for noise: ucast.me benchmark `room`, 2026-10-25). Same rule as the desktop app's
 * `bc_audio::VadLevel` and `ai-gateway-audio`.
 */
import { describe, expect, it } from 'vitest';
import { VOICE_LEVEL, createVoiceActivityPipeline, createVoiceLevel, rmsOf, type VoiceFrameClassifier } from '../../sdk/browser/voice/index';
import { SILERO_FRAME_SAMPLES } from '../../sdk/browser/voice/silero';

function frame(rms: number): Float32Array {
  const out = new Float32Array(SILERO_FRAME_SAMPLES);
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 === 0 ? rms : -rms;
  return out;
}

const db = (x: number) => 20 * Math.log10(x);

describe('voice level', () => {
  it('a quiet room reaches the classifier louder, by at most maxDb', () => {
    const level = createVoiceLevel();
    let heard = 0;
    for (let i = 0; i < 312; i += 1) heard = rmsOf(level.apply(frame(0.016))); // −36 dBFS for 10 s
    expect(db(heard / 0.016)).toBeCloseTo(VOICE_LEVEL.maxDb, 0);
    for (let i = 0; i < 312; i += 1) heard = rmsOf(level.apply(frame(0.032))); // −30 dBFS: raised to −24
    expect(db(heard)).toBeCloseTo(VOICE_LEVEL.targetDb, 0);
  });

  it('speech already loud enough, from the first frame on, is never changed', () => {
    const level = createVoiceLevel();
    for (let i = 0; i < 100; i += 1) {
      const loud = frame(0.1);
      expect(Array.from(level.apply(loud))).toEqual(Array.from(loud));
    }
    expect(level.gain()).toBe(1);
  });

  it('a muted microphone is left alone and a short pause hardly moves the gain', () => {
    const muted = createVoiceLevel();
    for (let i = 0; i < 312; i += 1) muted.apply(frame(0.0005));
    expect(muted.gain()).toBe(1);
    const level = createVoiceLevel();
    for (let i = 0; i < 312; i += 1) level.apply(frame(0.03));
    const before = level.gain();
    for (let i = 0; i < 16; i += 1) level.apply(frame(0.002)); // 0.5 s pause
    expect(level.gain()).toBeLessThan(before * 1.25);
  });

  it('the classifier gets the levelled frame and the input frame is not touched', async () => {
    const seen: number[] = [];
    const classifier: VoiceFrameClassifier = {
      async probability(f) { seen.push(rmsOf(f)); return 0.9; },
      reset() {},
    };
    const pipeline = createVoiceActivityPipeline(classifier, () => {});
    const input = frame(0.03);
    for (let i = 0; i < 200; i += 1) await pipeline.push(input);
    expect(rmsOf(input)).toBeCloseTo(0.03, 6);
    expect(seen.at(-1)!).toBeGreaterThan(0.05);
    const raw: number[] = [];
    const plain = createVoiceActivityPipeline({ async probability(f) { raw.push(rmsOf(f)); return 0.9; }, reset() {} }, () => {}, undefined, null);
    for (let i = 0; i < 200; i += 1) await plain.push(input);
    expect(raw.at(-1)!).toBeCloseTo(0.03, 6);
  });
});
