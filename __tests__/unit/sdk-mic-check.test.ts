/**
 * Tests for sdk/browser/voice/mic-check.ts — what to tell the person about the microphone. Same cases as
 * `ai-gateway-audio`'s `mic_check` tests (Rust).
 */
import { describe, expect, it } from 'vitest';
import { createMicCheck, floorOf, type MicReport } from '../../sdk/browser/voice/index';
import { SILERO_FRAME_SAMPLES, SILERO_SAMPLE_RATE } from '../../sdk/browser/voice/silero';

/** 30 s alternating 2 s of "speech" (noise at speechDb, probability prob) and 1 s of pause (noise at pauseDb). */
function session(speechDb: number, pauseDb: number, prob: number, extra: (t: number, s: number, speaking: boolean) => number = (_, s) => s): MicReport | null {
  const check = createMicCheck();
  let seed = 9;
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) / 2 ** 24 - 0.5) * 3.46; };
  const perS = Math.floor(SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES);
  let t = 0;
  for (let i = 0; i < 30 * perS; i += 1) {
    const speaking = i % (3 * perS) < 2 * perS;
    const amp = 10 ** ((speaking ? speechDb : pauseDb) / 20);
    const frame = new Float32Array(SILERO_FRAME_SAMPLES);
    for (let j = 0; j < frame.length; j += 1) { t += 1; frame[j] = Math.max(-1, Math.min(1, extra(t, noise() * amp, speaking))); }
    check.push(frame, speaking ? prob : 0.05);
  }
  return check.report();
}

describe('mic check', () => {
  it('a good microphone has nothing to change', () => {
    const r = session(-28, -65, 0.95)!;
    expect(r.issues).toEqual([]);
    expect(Math.abs(r.speechDb + 28)).toBeLessThan(1.5);
  });

  it('says nothing before eight seconds of sound', () => {
    const check = createMicCheck();
    for (let i = 0; i < 5 * 31; i += 1) check.push(new Float32Array(SILERO_FRAME_SAMPLES).fill(0.05), 0.9);
    expect(check.report()).toBeNull();
  });

  it('names each problem', () => {
    expect(session(-56, -90, 0.95)!.issues).toEqual(['tooQuiet']);
    expect(session(-28, -65, 0.35)!.issues).toEqual(['farOrEcho']);
    expect(session(-28, -34, 0.95)!.issues).toEqual(['noisy']);
    expect(session(-28, -65, 0.95, (t, s, speaking) => (speaking && t % 50 === 0 ? 1 : s))!.issues).toEqual(['clipping']);
  });

  it('names audible hum and not a faint one', () => {
    const hum = (db: number) => (t: number, s: number) => s + 10 ** (db / 20) * Math.sin((2 * Math.PI * 50 * t) / SILERO_SAMPLE_RATE);
    expect(session(-28, -70, 0.95, hum(-40))!.issues).toContain('hum');
    expect(session(-28, -70, 0.95, hum(-75))!.issues).not.toContain('hum');
  });

  it('ambient noise alone is not a noisy room', () => {
    const check = createMicCheck();
    let seed = 9;
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) / 2 ** 24 - 0.5) * 3.46; };
    const perS = Math.floor(SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES);
    let t = 0;
    for (let i = 0; i < 30 * perS; i += 1) {
      const loud = i % 4 < 2;
      const amp = 10 ** ((loud ? -28 : -35) / 20);
      const frame = new Float32Array(SILERO_FRAME_SAMPLES);
      for (let j = 0; j < frame.length; j += 1) { t += 1; frame[j] = Math.max(-1, Math.min(1, noise() * amp)); }
      check.push(frame, 0.05);
    }
    const r = check.report();
    if (r) expect(r.issues).not.toContain('noisy');
    if (r) expect(r.issues).not.toContain('farOrEcho');
  });

  it('silence with a high floor is not a noisy room', () => {
    const check = createMicCheck();
    let seed = 3;
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) / 2 ** 24 - 0.5) * 3.46; };
    const perS = Math.floor(SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES);
    let t = 0;
    for (let i = 0; i < 30 * perS; i += 1) {
      const amp = 10 ** ((i % 4 === 0 ? -33 : -42) / 20);
      const frame = new Float32Array(SILERO_FRAME_SAMPLES);
      for (let j = 0; j < frame.length; j += 1) { t += 1; frame[j] = Math.max(-1, Math.min(1, noise() * amp)); }
      check.push(frame, 0.05);
    }
    const r = check.report();
    if (r) expect(r.issues).not.toContain('noisy');
    if (r) expect(r.issues).not.toContain('farOrEcho');
  });

  it('mid VAD on the room floor is not a noisy room', () => {
    // HVAC pauses after VadLevel: ~22 % mid prob, ~6 % ≥ 0.9 — must not warn Noisy.
    const check = createMicCheck();
    let seed = 7;
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) / 2 ** 24 - 0.5) * 3.46; };
    const perS = Math.floor(SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES);
    let t = 0;
    for (let i = 0; i < 30 * perS; i += 1) {
      const amp = 10 ** (-40 / 20);
      const frame = new Float32Array(SILERO_FRAME_SAMPLES);
      for (let j = 0; j < frame.length; j += 1) { t += 1; frame[j] = Math.max(-1, Math.min(1, noise() * amp)); }
      const rem = i % 50;
      check.push(frame, rem <= 2 ? 0.92 : rem <= 13 ? 0.65 : 0.05);
    }
    const r = check.report();
    if (r) expect(r.issues).not.toContain('noisy');
  });

  it('studio pauses with confident VAD fakes are not far or echo', () => {
    const check = createMicCheck();
    let seed = 11;
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) / 2 ** 24 - 0.5) * 3.46; };
    const perS = Math.floor(SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES);
    let t = 0;
    for (let i = 0; i < 30 * perS; i += 1) {
      const amp = 10 ** ((i % 5 === 0 ? -40 : -55) / 20);
      const frame = new Float32Array(SILERO_FRAME_SAMPLES);
      for (let j = 0; j < frame.length; j += 1) { t += 1; frame[j] = Math.max(-1, Math.min(1, noise() * amp)); }
      const rem = i % 50;
      check.push(frame, rem <= 9 ? 0.92 : rem <= 17 ? 0.55 : 0.05);
    }
    const r = check.report();
    if (r) {
      expect(r.issues).not.toContain('farOrEcho');
      expect(r.issues).not.toContain('noisy');
    }
  });

  it('names the floor from the pauses', () => {
    expect(floorOf(-95, 0.6)).toBe('digitalSilence');
    expect(floorOf(-120, 0)).toBe('digitalSilence');
    expect(floorOf(-60, 0.17)).toBe('meetingFloor');
    expect(floorOf(-58, 0)).toBe('studioQuiet');
    expect(floorOf(-43, 0)).toBe('roomAmbient');
    expect(floorOf(-38, 0)).toBe('loudFloor');
  });

  it('a table microphone with only room tone is not a noisy room', () => {
    // AMI table mic after leveling: sure VAD on a −58 dBFS floor, SNR ~6 dB, digital gaps.
    const check = createMicCheck();
    let seed = 13;
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed >>> 8) / 2 ** 24 - 0.5) * 3.46; };
    const perS = Math.floor(SILERO_SAMPLE_RATE / SILERO_FRAME_SAMPLES);
    let t = 0;
    for (let i = 0; i < 30 * perS; i += 1) {
      const digital = i % 7 === 0;
      const amp = 10 ** (-58 / 20);
      const frame = new Float32Array(SILERO_FRAME_SAMPLES);
      for (let j = 0; j < frame.length; j += 1) { t += 1; frame[j] = digital ? 0 : Math.max(-1, Math.min(1, noise() * amp)); }
      check.push(frame, i % 3 === 0 ? 0.95 : 0.05);
    }
    const r = check.report();
    if (r) {
      expect(r.issues).not.toContain('noisy');
      expect(r.floor).not.toBeNull();
    }
  });
});
