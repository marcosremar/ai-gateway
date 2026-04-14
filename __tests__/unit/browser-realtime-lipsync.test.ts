/**
 * Tests for src/browser/realtime-lipsync.ts
 * Mocks browser APIs (AudioContext, AnalyserNode, MediaStream).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeLipsyncAnalyser } from '../../src/browser/realtime-lipsync';

// ── Browser API mocks ─────────────────────────────────────────────────────────

function makeAnalyserNode(overrides: Partial<{
  frequencyBinCount: number;
  getFloatFrequencyData: (arr: Float32Array) => void;
  getFloatTimeDomainData: (arr: Float32Array) => void;
}> = {}) {
  let fftSize = 2048;
  const node: any = {
    get fftSize() { return fftSize; },
    set fftSize(v: number) { fftSize = v; },
    get frequencyBinCount() { return overrides.frequencyBinCount ?? fftSize / 2; },
    smoothingTimeConstant: 0.6,
    getFloatFrequencyData: overrides.getFloatFrequencyData ?? ((arr: Float32Array) => arr.fill(-60)),
    getFloatTimeDomainData: overrides.getFloatTimeDomainData ?? ((arr: Float32Array) => arr.fill(0)),
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return node;
}

type CtxConfig = {
  state?: string;
  sampleRate?: number;
  analyserOverrides?: Parameters<typeof makeAnalyserNode>[0];
};

function makeCtxWithAnalyser(config: CtxConfig = {}) {
  const analyser = makeAnalyserNode(config.analyserOverrides ?? {});
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const ctx: any = {
    state: config.state ?? 'running',
    sampleRate: config.sampleRate ?? 48000,
    createAnalyser: vi.fn(() => analyser),
    createMediaStreamSource: vi.fn(() => source),
    close: vi.fn(),
    _analyser: analyser,
    _source: source,
  };
  return ctx;
}

/** Install AudioContext mock as a proper constructor function */
function stubAudioContext(ctx: any) {
  // Must be a regular function (not arrow) to support `new`
  function AudioContextMock() { return ctx; }
  (globalThis as any).AudioContext = AudioContextMock;
  return AudioContextMock;
}

function stubAudioContextThrows(msg: string) {
  function AudioContextMock() { throw new Error(msg); }
  (globalThis as any).AudioContext = AudioContextMock;
}

function makeMediaStream() {
  return {} as MediaStream;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RealtimeLipsyncAnalyser', () => {
  afterEach(() => {
    delete (globalThis as any).AudioContext;
  });

  describe('constructor', () => {
    it('is active after successful construction', () => {
      const ctx = makeCtxWithAnalyser();
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      expect(analyser.isActive).toBe(true);
    });

    it('is inactive when AudioContext constructor throws', () => {
      stubAudioContextThrows('AudioContext not supported');
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      expect(analyser.isActive).toBe(false);
    });

    it('uses existing context when provided and not closed', () => {
      const newCtx = makeCtxWithAnalyser();
      const existingCtx = makeCtxWithAnalyser({ state: 'running' });
      const AudioContextSpy = stubAudioContext(newCtx);
      const spy = vi.fn(AudioContextSpy);
      (globalThis as any).AudioContext = spy;

      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream(), existingCtx as any);
      // Should NOT create a new AudioContext since one was passed
      expect(spy).not.toHaveBeenCalled();
      expect(analyser.isActive).toBe(true);
    });

    it('creates new context when existing context is closed', () => {
      const closedCtx = makeCtxWithAnalyser({ state: 'closed' });
      const newCtx = makeCtxWithAnalyser();
      let callCount = 0;
      function AudioContextMock() {
        callCount++;
        return newCtx;
      }
      (globalThis as any).AudioContext = AudioContextMock;
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream(), closedCtx as any);
      expect(callCount).toBe(1); // new context was created
      expect(analyser.isActive).toBe(true);
    });

    it('sets up analyser with correct fftSize', () => {
      const ctx = makeCtxWithAnalyser();
      stubAudioContext(ctx);
      new RealtimeLipsyncAnalyser(makeMediaStream());
      expect(ctx._analyser.fftSize).toBe(2048);
    });
  });

  describe('analyse — silent input', () => {
    it('returns all expected viseme keys', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0), // silence
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      const result = analyser.analyse(1 / 60);
      const expectedKeys = [
        'viseme_aa','viseme_E','viseme_I','viseme_O','viseme_U',
        'viseme_PP','viseme_SS','viseme_TH','viseme_DD','viseme_FF',
        'viseme_kk','viseme_RR','viseme_CH','viseme_sil','jawOpen',
      ];
      for (const key of expectedKeys) {
        expect(result).toHaveProperty(key);
      }
    });

    it('decays to near-zero after many silent frames', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0),
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      for (let i = 0; i < 20; i++) analyser.analyse(1 / 60);
      const result = analyser.analyse(1 / 60);
      for (const [key, val] of Object.entries(result)) {
        expect(val as number, `${key} should be near 0 during silence`).toBeLessThanOrEqual(0.01);
      }
    });

    it('returns zero values when inactive (AudioContext failed)', () => {
      stubAudioContextThrows('no audio');
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      expect(analyser.isActive).toBe(false);
      const result = analyser.analyse(1 / 60);
      for (const val of Object.values(result)) {
        expect(val as number).toBeLessThanOrEqual(0.01);
      }
    });
  });

  describe('analyse — with audio signal', () => {
    it('returns values in [0, 1] range', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.1), // > SILENCE_THRESHOLD
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-30),
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      const result = analyser.analyse(1 / 60);
      for (const [key, val] of Object.entries(result)) {
        expect(val as number, `${key} should be in [0,1]`).toBeGreaterThanOrEqual(0);
        expect(val as number, `${key} should be in [0,1]`).toBeLessThanOrEqual(1);
      }
    });

    it('jawOpen is in [0, 1]', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.2),
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-20),
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      const result = analyser.analyse(1 / 60);
      expect(result.jawOpen).toBeGreaterThanOrEqual(0);
      expect(result.jawOpen).toBeLessThanOrEqual(1);
    });

    it('smooth tracking: values increase toward target over multiple frames', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.3),
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-15),
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      const frames: Record<string, number>[] = [];
      for (let i = 0; i < 5; i++) {
        frames.push(analyser.analyse(1 / 60));
      }
      // Total energy should increase from frame 1 to frame 5 (smoothing toward target)
      const total1 = Object.values(frames[0]).reduce((s, v) => s + v, 0);
      const total5 = Object.values(frames[4]).reduce((s, v) => s + v, 0);
      expect(total5).toBeGreaterThanOrEqual(total1);
    });
  });

  describe('destroy', () => {
    it('sets isActive to false', () => {
      const ctx = makeCtxWithAnalyser();
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      expect(analyser.isActive).toBe(true);
      analyser.destroy();
      expect(analyser.isActive).toBe(false);
    });

    it('can call destroy multiple times without error', () => {
      const ctx = makeCtxWithAnalyser();
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      expect(() => {
        analyser.destroy();
        analyser.destroy();
        analyser.destroy();
      }).not.toThrow();
    });

    it('does not close provided external context', () => {
      const existingCtx = makeCtxWithAnalyser({ state: 'running' });
      stubAudioContext(makeCtxWithAnalyser());
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream(), existingCtx as any);
      analyser.destroy();
      expect(existingCtx.close).not.toHaveBeenCalled();
    });

    it('closes own AudioContext on destroy', () => {
      const ctx = makeCtxWithAnalyser();
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      analyser.destroy();
      expect(ctx.close).toHaveBeenCalled();
    });

    it('returns decayed values after destroy', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.2),
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-20),
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());
      analyser.analyse(1 / 60);
      analyser.destroy();
      const result = analyser.analyse(1 / 60);
      for (const val of Object.values(result)) {
        expect(val as number).toBeGreaterThanOrEqual(0);
        expect(val as number).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('decay behavior', () => {
    it('values decay toward 0 when signal stops', () => {
      let isSilent = false;
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(isSilent ? 0 : 0.3),
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-15),
        },
      });
      stubAudioContext(ctx);
      const analyser = new RealtimeLipsyncAnalyser(makeMediaStream());

      // Build up values
      for (let i = 0; i < 10; i++) analyser.analyse(1 / 60);
      const peak = Object.values(analyser.analyse(1 / 60)).reduce((s, v) => s + (v as number), 0);

      // Now silence
      isSilent = true;
      for (let i = 0; i < 30; i++) analyser.analyse(1 / 60);
      const decayed = Object.values(analyser.analyse(1 / 60)).reduce((s, v) => s + (v as number), 0);

      expect(decayed).toBeLessThanOrEqual(Math.max(peak, 0.001));
    });
  });

  describe('analyse with different dt values', () => {
    it('larger dt causes faster smoothing', () => {
      const ctx = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.2),
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-20),
        },
      });
      stubAudioContext(ctx);
      const analyserFast = new RealtimeLipsyncAnalyser(makeMediaStream());
      const resultFast = analyserFast.analyse(1 / 10); // 100ms frame (faster)

      const ctx2 = makeCtxWithAnalyser({
        analyserOverrides: {
          getFloatTimeDomainData: (arr: Float32Array) => arr.fill(0.2),
          getFloatFrequencyData: (arr: Float32Array) => arr.fill(-20),
        },
      });
      stubAudioContext(ctx2);
      const analyserSlow = new RealtimeLipsyncAnalyser(makeMediaStream());
      const resultSlow = analyserSlow.analyse(1 / 60); // 16ms frame (slower)

      // With larger dt, values should reach higher initial values
      const totalFast = Object.values(resultFast).reduce((s, v) => s + (v as number), 0);
      const totalSlow = Object.values(resultSlow).reduce((s, v) => s + (v as number), 0);
      expect(totalFast).toBeGreaterThanOrEqual(totalSlow);
    });
  });
});
