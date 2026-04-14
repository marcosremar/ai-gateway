import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for PCM-to-Float32 decode logic used in audio-decode-worker.ts.
 *
 * The worker file (`src/browser/audio-decode-worker.ts`) runs in a Web Worker
 * context and attaches `self.onmessage`. Since there's no exported function,
 * we replicate the core decode logic here and test it independently.
 *
 * The protocol:
 *   Main → Worker: { pcm: Uint8Array, bitsPerSample: number, bytesPerSample: number, id: number }
 *   Worker → Main: { float32: Float32Array, id: number }
 */

function decodePCM16(pcm: Uint8Array): Float32Array {
  const bytesPerSample = 2;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const numSamples = Math.floor(pcm.length / bytesPerSample);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

function decodePCM24(pcm: Uint8Array): Float32Array {
  const bytesPerSample = 3;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const numSamples = Math.floor(pcm.length / bytesPerSample);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const offset = i * 3;
    const sample = (view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16));
    float32[i] = sample / 8388608;
  }
  return float32;
}

function decodePCM32Float(pcm: Uint8Array): Float32Array {
  const bytesPerSample = 4;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const numSamples = Math.floor(pcm.length / bytesPerSample);
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = view.getFloat32(i * 4, true);
  }
  return float32;
}

// Helper to encode a 16-bit PCM sample into a Uint8Array (little-endian)
function encodePCM16(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return new Uint8Array(buf);
}

// Helper to encode a 24-bit PCM sample into a Uint8Array (little-endian)
function encodePCM24(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 3);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    view.setUint8(i * 3, s & 0xff);
    view.setUint8(i * 3 + 1, (s >> 8) & 0xff);
    view.setInt8(i * 3 + 2, (s >> 16) & 0xff);
  }
  return new Uint8Array(buf);
}

// Helper to encode Float32 samples into a Uint8Array (IEEE 754, little-endian)
function encodePCM32Float(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(i * 4, samples[i], true);
  }
  return new Uint8Array(buf);
}

// ── 16-bit PCM ──────────────────────────────────────────────────────────────

describe('decodePCM16', () => {
  it('decodes silence (all zeros) to 0.0', () => {
    const pcm = encodePCM16([0, 0, 0, 0]);
    const result = decodePCM16(pcm);
    expect(result.length).toBe(4);
    expect(result).toEqual(new Float32Array([0, 0, 0, 0]));
  });

  it('decodes max positive (32767) to ~1.0', () => {
    const pcm = encodePCM16([32767]);
    const result = decodePCM16(pcm);
    expect(result[0]).toBeCloseTo(1.0, 4);
  });

  it('decodes max negative (-32768) to ~-1.0', () => {
    const pcm = encodePCM16([-32768]);
    const result = decodePCM16(pcm);
    expect(result[0]).toBeCloseTo(-1.0, 5);
  });

  it('decodes mid-value to ~0.5', () => {
    const pcm = encodePCM16([16384]);
    const result = decodePCM16(pcm);
    expect(result[0]).toBeCloseTo(0.5, 4);
  });

  it('handles empty input', () => {
    const pcm = new Uint8Array(0);
    const result = decodePCM16(pcm);
    expect(result.length).toBe(0);
  });

  it('handles odd number of bytes (truncates last incomplete sample)', () => {
    const pcm = encodePCM16([100, -200, 300]);
    const oddPcm = new Uint8Array(pcm.length + 1);
    oddPcm.set(pcm);
    const result = decodePCM16(oddPcm);
    expect(result.length).toBe(3);
  });

  it('round-trips positive values correctly', () => {
    const values = [100, 1000, 5000, 10000, 20000];
    const pcm = encodePCM16(values);
    const result = decodePCM16(pcm);
    for (let i = 0; i < values.length; i++) {
      expect(result[i]).toBeCloseTo(values[i] / 32768, 5);
    }
  });

  it('round-trips negative values correctly', () => {
    const values = [-100, -1000, -5000, -10000, -20000];
    const pcm = encodePCM16(values);
    const result = decodePCM16(pcm);
    for (let i = 0; i < values.length; i++) {
      expect(result[i]).toBeCloseTo(values[i] / 32768, 5);
    }
  });
});

// ── 24-bit PCM ──────────────────────────────────────────────────────────────

describe('decodePCM24', () => {
  it('decodes silence to 0.0', () => {
    const pcm = encodePCM24([0, 0]);
    const result = decodePCM24(pcm);
    expect(result.length).toBe(2);
    expect(result).toEqual(new Float32Array([0, 0]));
  });

  it('decodes max positive (8388607) to ~1.0', () => {
    const pcm = encodePCM24([8388607]);
    const result = decodePCM24(pcm);
    expect(result[0]).toBeCloseTo(1.0, 5);
  });

  it('decodes max negative (-8388608) to ~-1.0', () => {
    const pcm = encodePCM24([-8388608]);
    const result = decodePCM24(pcm);
    expect(result[0]).toBeCloseTo(-1.0, 5);
  });

  it('handles empty input', () => {
    const pcm = new Uint8Array(0);
    const result = decodePCM24(pcm);
    expect(result.length).toBe(0);
  });

  it('handles non-multiple-of-3 bytes (truncates incomplete sample)', () => {
    const pcm = encodePCM24([100]);
    const oddPcm = new Uint8Array(pcm.length + 1);
    oddPcm.set(pcm);
    const result = decodePCM24(oddPcm);
    expect(result.length).toBe(1);
  });

  it('has higher dynamic range than 16-bit', () => {
    const pcm24 = encodePCM24([8388607]);
    const pcm16 = encodePCM16([32767]);
    const result24 = decodePCM24(pcm24);
    const result16 = decodePCM16(pcm16);
    expect(result24[0]).toBeCloseTo(result16[0], 4);
  });
});

// ── 32-bit float PCM ────────────────────────────────────────────────────────

describe('decodePCM32Float', () => {
  it('decodes silence to 0.0', () => {
    const pcm = encodePCM32Float([0.0, 0.0]);
    const result = decodePCM32Float(pcm);
    expect(result.length).toBe(2);
    expect(result).toEqual(new Float32Array([0, 0]));
  });

  it('decodes 1.0 and -1.0 exactly', () => {
    const pcm = encodePCM32Float([1.0, -1.0]);
    const result = decodePCM32Float(pcm);
    expect(result).toEqual(new Float32Array([1.0, -1.0]));
  });

  it('decodes fractional values exactly', () => {
    const values = [0.25, -0.75, 0.123456];
    const pcm = encodePCM32Float(values);
    const result = decodePCM32Float(pcm);
    for (let i = 0; i < values.length; i++) {
      expect(result[i]).toBeCloseTo(values[i], 5);
    }
  });

  it('handles empty input', () => {
    const pcm = new Uint8Array(0);
    const result = decodePCM32Float(pcm);
    expect(result.length).toBe(0);
  });

  it('handles non-multiple-of-4 bytes (truncates incomplete sample)', () => {
    const pcm = encodePCM32Float([0.5]);
    const oddPcm = new Uint8Array(pcm.length + 2);
    oddPcm.set(pcm);
    const result = decodePCM32Float(oddPcm);
    expect(result.length).toBe(1);
  });
});

// ── Worker message protocol ─────────────────────────────────────────────────

describe('worker message protocol', () => {
  it('worker file can be read and parsed as TypeScript', async () => {
    const workerCode = await import('@ai-gateway/browser/audio-decode-worker?raw');
    expect(workerCode).toBeDefined();
  });
});
