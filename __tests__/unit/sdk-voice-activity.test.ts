/**
 * Tests for sdk/browser/voice/voice-activity.ts — RMS arms, Silero confirms, Silero's low run ends the utterance.
 * The real-model run (Portuguese speech, white noise, 50 Hz hum, whisper) lives in parle
 * (`test/core/voice/silero-voice-activity.spec.ts`, onnxruntime-node); here the classifier is scripted.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  VOICE_ACTIVITY_TUNING,
  VOICE_FRAME_MS,
  createVoiceActivityPipeline,
  rmsOf,
  turnEndAfterVadEndMs,
  type VadEffect,
  type VoiceFrameClassifier,
} from '../../sdk/browser/voice/index';
import { SILERO_FRAME_SAMPLES } from '../../sdk/browser/voice/silero';

/** A 32 ms frame with constant RMS (square wave of amplitude `rms`). */
function frame(rms: number): Float32Array {
  const out = new Float32Array(SILERO_FRAME_SAMPLES);
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 === 0 ? rms : -rms;
  return out;
}

function scripted(probabilities: (n: number) => number) {
  let n = 0;
  const resets = vi.fn();
  const classifier: VoiceFrameClassifier = { probability: async () => probabilities(n++), reset: resets };
  return { classifier, resets };
}

async function run(classifier: VoiceFrameClassifier, frames: Float32Array[]) {
  const effects: VadEffect[] = [];
  const pipeline = createVoiceActivityPipeline(classifier, (effect) => effects.push(effect));
  for (const f of frames) await pipeline.push(f);
  return { effects, kinds: effects.map((e) => e.kind), pipeline };
}

const repeat = (count: number, rms: number) => Array.from({ length: count }, () => frame(rms));

describe('voice activity reducer', () => {
  it('rmsOf: square wave of amplitude a has RMS a; empty is 0', () => {
    expect(rmsOf(frame(0.25))).toBeCloseTo(0.25, 6);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it('silence never runs the classifier', async () => {
    const probability = vi.fn(async () => 0.9);
    const { kinds, pipeline } = await run({ probability, reset: () => {} }, repeat(100, 0));
    expect(kinds).toEqual([]);
    expect(probability).not.toHaveBeenCalled();
    expect(pipeline.classifiedFrames()).toBe(0);
  });

  it('two loud frames arm (classifier reset), speech opens at p ≥ 0.5 and closes after 10 frames under 0.35', async () => {
    const { classifier, resets } = scripted((n) => (n < 20 ? 0.9 : 0.1));
    const { effects, kinds } = await run(classifier, [...repeat(2, 0.05), ...repeat(40, 0.05)]);
    expect(kinds).toEqual(['rmsOnset', 'vadStart', 'vadEnd']);
    expect(resets).toHaveBeenCalledTimes(1);
    expect(effects[0]).toMatchObject({ kind: 'rmsOnset', frame: 1 });
    expect(effects[1]).toMatchObject({ kind: 'vadStart', frame: 2, afterRmsFrames: 0 });
    /* 20 voiced frames (2..21), then 10 low frames: vadEnd on frame 31, speech = 20 frames. */
    expect(effects[2]).toMatchObject({ kind: 'vadEnd', frame: 31, speechFrames: 20, peakProbability: 0.9 });
  });

  it('a short dip under vadEnd does not split the utterance (hysteresis)', async () => {
    const { classifier } = scripted((n) => (n >= 10 && n < 15 ? 0.2 : 0.9));
    const { kinds } = await run(classifier, repeat(40, 0.05));
    expect(kinds).toEqual(['rmsOnset', 'vadStart']);
  });

  it('noise that arms without speech is rejected after 25 frames, then ~3 s of cooldown before re-arming', async () => {
    const { classifier } = scripted(() => 0.1);
    const { effects, kinds } = await run(classifier, repeat(200, 0.3));
    expect(kinds).toEqual(['rmsOnset', 'rmsRejected', 'rmsOnset', 'rmsRejected']);
    const [, rejected, rearmed] = effects;
    expect((rearmed!.frame - rejected!.frame) * VOICE_FRAME_MS).toBeGreaterThanOrEqual(3000);
    expect(rejected).toMatchObject({ armedFrames: VOICE_ACTIVITY_TUNING.armedTimeoutFrames });
  });

  it('after speech, an armed timeout falls back to silent without a rejection', async () => {
    const { classifier } = scripted((n) => (n < 5 ? 0.9 : 0.1));
    /* Voice on frames 2..6, vadEnd on 16, armed timeout on 41, then a quiet room. */
    const { kinds, pipeline } = await run(classifier, [...repeat(42, 0.05), ...repeat(20, 0)]);
    expect(kinds).toEqual(['rmsOnset', 'vadStart', 'vadEnd']);
    expect(pipeline.stage()).toBe('silent');
  });

  it('whisper under rmsOnset never reaches the classifier', async () => {
    const probability = vi.fn(async () => 0.9);
    const { kinds } = await run({ probability, reset: () => {} }, repeat(100, VOICE_ACTIVITY_TUNING.rmsOnset * 0.9));
    expect(kinds).toEqual([]);
    expect(probability).not.toHaveBeenCalled();
  });

  it('custom tuning is honoured', async () => {
    const { classifier } = scripted(() => 0.6);
    const effects: VadEffect[] = [];
    const pipeline = createVoiceActivityPipeline(classifier, (e) => effects.push(e), { ...VOICE_ACTIVITY_TUNING, vadStart: 0.7 });
    for (const f of repeat(40, 0.05)) await pipeline.push(f);
    expect(effects.map((e) => e.kind)).toEqual(['rmsOnset', 'rmsRejected']);
  });

  it('turnEndAfterVadEndMs: the rest of the consumer pause after the vadEnd frames, never negative', () => {
    expect(turnEndAfterVadEndMs(1200)).toBe(1200 - 10 * VOICE_FRAME_MS);
    expect(turnEndAfterVadEndMs(100)).toBe(0);
    expect(turnEndAfterVadEndMs(1000, { ...VOICE_ACTIVITY_TUNING, vadEndFrames: 5 })).toBe(1000 - 5 * VOICE_FRAME_MS);
  });
});
