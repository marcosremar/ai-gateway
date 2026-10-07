import { describe, it, expect } from 'vitest';
import {
  calibKey, observeThroughput, parseCalibLine, applyObservation, lookupCalib,
  type CalibStore,
} from '../src/gpu-finetune/calibration';

describe('calibration: calibKey', () => {
  it('buckets model size + canonicalizes GPU name', () => {
    const a = calibKey('RTX 4090', 7, 'finetune', 'qlora');
    const b = calibKey('NVIDIA GeForce RTX 4090', 9, 'finetune', 'qlora');
    expect(a).toBe(b);                       // 7B and 9B share the ≤9B bucket; name canonicalized
    expect(a).toContain('NVIDIA GeForce RTX 4090');
    expect(a).toContain('≤9B');
  });
  it('different bucket / task / mode → different key', () => {
    expect(calibKey('4090', 7, 'finetune', 'qlora')).not.toBe(calibKey('4090', 70, 'finetune', 'qlora'));
    expect(calibKey('4090', 7, 'finetune', 'full')).not.toBe(calibKey('4090', 7, 'finetune', 'qlora'));
    expect(calibKey('4090', 7, 'finetune', 'full')).not.toBe(calibKey('4090', 7, 'inference', 'full'));
  });
});

describe('calibration: observeThroughput', () => {
  it('computes steps/sec + encode rate from positive inputs', () => {
    const o = observeThroughput({ trainSteps: 600, trainSec: 200, encodeSamples: 1000, encodeSec: 40, numGpus: 1 });
    expect(o.stepsPerSec).toBeCloseTo(3, 5);
    expect(o.encodeRatePerGpu).toBeCloseTo(25, 5);
  });
  it('divides encode rate by GPU count', () => {
    const o = observeThroughput({ encodeSamples: 1000, encodeSec: 20, numGpus: 2 });
    expect(o.encodeRatePerGpu).toBeCloseTo(25, 5);
  });
  it('never fabricates from zero/missing inputs', () => {
    expect(observeThroughput({ trainSteps: 0, trainSec: 10 })).toEqual({});
    expect(observeThroughput({})).toEqual({});
  });
});

describe('calibration: parseCalibLine', () => {
  it('parses an explicit [calib] line', () => {
    const o = parseCalibLine('[calib] steps_per_sec=4.2 encode_rate_per_gpu=30.5');
    expect(o.stepsPerSec).toBeCloseTo(4.2);
    expect(o.encodeRatePerGpu).toBeCloseTo(30.5);
  });
  it('falls back to bare rate= as encode rate', () => {
    expect(parseCalibLine('rate=22.0 samples/s').encodeRatePerGpu).toBeCloseTo(22);
  });
  it('ignores junk', () => {
    expect(parseCalibLine('loss=1.2 step=10/100')).toEqual({});
  });
});

describe('calibration: applyObservation (EWMA)', () => {
  it('first observation seeds the value', () => {
    const store = applyObservation({}, 'k', { stepsPerSec: 3, encodeRatePerGpu: 25 });
    expect(store.k.stepsPerSec).toBe(3);
    expect(store.k.n).toBe(1);
  });
  it('blends subsequent observations toward the new sample', () => {
    let store: CalibStore = applyObservation({}, 'k', { stepsPerSec: 3 });
    store = applyObservation(store, 'k', { stepsPerSec: 5 }, undefined, 0.5);
    expect(store.k.stepsPerSec).toBeCloseTo(4, 5); // 0.5*5 + 0.5*3
    expect(store.k.n).toBe(2);
  });
  it('preserves fields absent from the new observation', () => {
    let store = applyObservation({}, 'k', { stepsPerSec: 3, encodeRatePerGpu: 25 });
    store = applyObservation(store, 'k', { stepsPerSec: 4 }); // no encode this time
    expect(store.k.encodeRatePerGpu).toBe(25);
    expect(store.k.stepsPerSec).not.toBe(3);
  });
  it('is a no-op when the observation is empty (does not mutate)', () => {
    const store = { k: { key: 'k', stepsPerSec: 3, n: 1 } } as CalibStore;
    expect(applyObservation(store, 'k', {})).toBe(store);
  });
  it('does not mutate the input store', () => {
    const store: CalibStore = {};
    applyObservation(store, 'k', { stepsPerSec: 3 });
    expect(store.k).toBeUndefined();
  });
});

describe('calibration: lookupCalib', () => {
  it('returns the record for a known key, undefined otherwise', () => {
    const store = applyObservation({}, 'k', { stepsPerSec: 3 });
    expect(lookupCalib(store, 'k')?.stepsPerSec).toBe(3);
    expect(lookupCalib(store, 'nope')).toBeUndefined();
  });
});
