/**
 * Tests for sdk/browser/voice/turn-taking.ts (effects → turns, injected clip and clock) and turn-clip.ts (voiced span,
 * WAV encoding).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STT_RATE,
  VOICE_FRAME_MS,
  createTurnTaking,
  encodeWav,
  voicedRange,
  type TurnTakingOptions,
} from '../../sdk/browser/voice/index';

function fakeClip() {
  let running = false;
  const log: string[] = [];
  return {
    log,
    clip: {
      running: () => running,
      start: () => { running = true; log.push('start'); },
      finish: async () => { running = false; log.push('finish'); return new Blob(['x']); },
      cancel: () => { running = false; log.push('cancel'); },
    },
  };
}

const END_SILENCE_MS = 1200;
const MAX_SPEECH_MS = 15_000;
const ECHO_TAIL_MS = 500;

function taking(extra: Partial<TurnTakingOptions> = {}) {
  const { clip, log } = fakeClip();
  const onVoice = vi.fn();
  const onTurn = vi.fn();
  const turns = createTurnTaking({
    clip,
    track: () => ({}) as MediaStreamTrack,
    toWav: async (blob) => new Blob([blob], { type: 'audio/wav' }),
    endSilenceMs: END_SILENCE_MS,
    maxSpeechMs: MAX_SPEECH_MS,
    echoTailMs: ECHO_TAIL_MS,
    onVoice,
    onTurn,
    now: () => Date.now(),
    ...extra,
  });
  return { turns, log, onVoice, onTurn };
}

const onset = { kind: 'rmsOnset' as const, frame: 0, rms: 0.05 };
const start = { kind: 'vadStart' as const, frame: 1, probability: 0.9, afterRmsFrames: 0 };
const end = { kind: 'vadEnd' as const, frame: 40, speechFrames: 29, peakProbability: 0.9 };
const rejected = { kind: 'rmsRejected' as const, frame: 25, armedFrames: 25, peakProbability: 0.1 };

describe('turn taking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opening the gate reports it once; effects inside the echo tail are ignored', async () => {
    const { turns, log, onVoice } = taking();
    expect(turns.setListening(true)).toBe(true);
    expect(turns.setListening(true)).toBe(false);
    turns.onEffect(onset);
    turns.onEffect(start);
    expect(log).toEqual([]);
    expect(onVoice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ECHO_TAIL_MS);
    turns.onEffect(onset);
    expect(log).toEqual(['start']);
  });

  it('no turn while the gate is closed', () => {
    const { turns, log } = taking();
    turns.onEffect(onset);
    expect(log).toEqual([]);
  });

  it('voice: onVoice once, the turn closes endSilenceMs − vadEndFrames×32 ms after vadEnd with one WAV', async () => {
    const { turns, log, onVoice, onTurn } = taking({ echoTailMs: 0 });
    turns.setListening(true);
    turns.onEffect(onset);
    turns.onEffect(start);
    turns.onEffect({ ...start, frame: 5 });
    expect(onVoice).toHaveBeenCalledTimes(1);
    turns.onEffect(end);
    await vi.advanceTimersByTimeAsync(END_SILENCE_MS - 10 * VOICE_FRAME_MS - 1);
    expect(onTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect((onTurn.mock.calls[0]![0] as Blob).type).toBe('audio/wav');
    expect(log).toEqual(['start', 'finish']);
  });

  it('speech resuming before the end cancels the pending end', async () => {
    const { turns, onTurn } = taking({ echoTailMs: 0 });
    turns.setListening(true);
    turns.onEffect(start);
    turns.onEffect(end);
    await vi.advanceTimersByTimeAsync(500);
    turns.onEffect({ ...start, frame: 60 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('a turn that never pauses closes at maxSpeechMs', async () => {
    const { turns, onTurn } = taking({ echoTailMs: 0 });
    turns.setListening(true);
    turns.onEffect(start);
    await vi.advanceTimersByTimeAsync(MAX_SPEECH_MS);
    expect(onTurn).toHaveBeenCalledTimes(1);
  });

  it('a rejected arming drops the clip; closing the gate drops a voiced turn without onTurn', async () => {
    const { turns, log, onTurn } = taking({ echoTailMs: 0 });
    turns.setListening(true);
    turns.onEffect(onset);
    turns.onEffect(rejected);
    expect(log).toEqual(['start', 'cancel']);
    turns.onEffect(start);
    turns.onEffect(end);
    turns.setListening(false);
    await vi.advanceTimersByTimeAsync(MAX_SPEECH_MS);
    expect(onTurn).not.toHaveBeenCalled();
    expect(log.at(-1)).toBe('cancel');
  });

  it('a rejection after voice keeps the turn', () => {
    const { turns, log } = taking({ echoTailMs: 0 });
    turns.setListening(true);
    turns.onEffect(start);
    turns.onEffect(rejected);
    expect(log).toEqual(['start']);
  });
});

describe('turn clip', () => {
  /** Synthetic clip: `silenceS` of low hiss, then `voiceS` of a loud tone, then `tailS` of hiss. */
  const clip = (silenceS: number, voiceS: number, tailS: number) => {
    const rate = STT_RATE, total = Math.round((silenceS + voiceS + tailS) * rate);
    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const t = i / rate;
      const voiced = t >= silenceS && t < silenceS + voiceS;
      out[i] = voiced ? 0.2 * Math.sin(2 * Math.PI * 220 * t) : 0.002 * Math.sin(2 * Math.PI * 3000 * t);
    }
    return out;
  };

  /* Regression (parle, cloud phone, 28/09/2026): «Bom dia!» after ~6 s of call hiss came back «Bonjour.» from STT. */
  it('trims leading and trailing hiss around the voice, with 0.3 s of margin', () => {
    const [from, to] = voicedRange(clip(6, 1, 2), STT_RATE);
    expect(from / STT_RATE).toBeCloseTo(6 - 0.3, 1);
    expect(to / STT_RATE).toBeCloseTo(7 + 0.3, 1);
  });

  it('a silent clip is kept whole', () => {
    const silent = new Float32Array(STT_RATE);
    expect(voicedRange(silent, STT_RATE)).toEqual([0, STT_RATE]);
  });

  it('encodes 16-bit mono WAV with the right RIFF header', () => {
    const samples = new Float32Array([0, 0.5, -1, 1]);
    const view = new DataView(encodeWav(samples, STT_RATE));
    const text = (at: number, n: number) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(at + i)));
    expect([text(0, 4), text(8, 4), text(12, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(STT_RATE);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 16383, -32767, 32767]);
  });
});
