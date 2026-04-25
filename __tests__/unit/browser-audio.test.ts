/**
 * Tests for browser/audio.ts
 * - uint8ToBase64()
 * - float32ToWavBuffer()
 * - combineWavChunksToBase64()
 * - buildSilentWav()
 */

import { describe, it, expect } from 'vitest';
import {
  uint8ToBase64,
  float32ToWavBuffer,
  combineWavChunksToBase64,
  buildSilentWav,
} from '../../src/browser/audio';

// Helper to build a minimal WAV Uint8Array with PCM data
function makeWavChunk(pcmSamples: Int16Array, sampleRate = 16000): Uint8Array {
  const numSamples = pcmSamples.length;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  view.setUint32(0, 0x46464952, true);  // "RIFF"
  view.setUint32(4, 36 + dataSize, true);
  view.setUint32(8, 0x45564157, true);   // "WAVE"
  view.setUint32(12, 0x20746d66, true);  // "fmt "
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);          // 16-bit
  view.setUint32(36, 0x61746164, true);  // "data"
  view.setUint32(40, dataSize, true);

  const arr = new Uint8Array(buffer);
  for (let i = 0; i < numSamples; i++) {
    arr[44 + i * 2] = pcmSamples[i] & 0xff;
    arr[44 + i * 2 + 1] = (pcmSamples[i] >> 8) & 0xff;
  }
  return arr;
}

describe('uint8ToBase64', () => {
  it('converts empty array to empty string', () => {
    const result = uint8ToBase64(new Uint8Array(0));
    expect(result).toBe('');
  });

  it('converts bytes to base64', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const result = uint8ToBase64(bytes);
    expect(result).toBe('SGVsbG8=');
  });

  it('produces valid base64 decodeable string', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const b64 = uint8ToBase64(original);
    const decoded = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it('handles large arrays', () => {
    const large = new Uint8Array(10000).fill(42);
    const b64 = uint8ToBase64(large);
    expect(b64.length).toBeGreaterThan(0);
    const decoded = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    expect(decoded.length).toBe(10000);
  });
});

describe('float32ToWavBuffer', () => {
  it('returns a valid WAV buffer', () => {
    const pcm = new Float32Array(160).fill(0); // silence
    const buf = float32ToWavBuffer(pcm, 16000);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(44 + pcm.length * 2);
  });

  it('has correct RIFF header', () => {
    const pcm = new Float32Array(100);
    const buf = float32ToWavBuffer(pcm, 16000);
    const view = new DataView(buf);

    // "RIFF"
    expect(view.getUint8(0)).toBe(0x52);
    expect(view.getUint8(1)).toBe(0x49);
    expect(view.getUint8(2)).toBe(0x46);
    expect(view.getUint8(3)).toBe(0x46);
    // "WAVE"
    expect(view.getUint8(8)).toBe(0x57);
    expect(view.getUint8(9)).toBe(0x41);
    expect(view.getUint8(10)).toBe(0x56);
    expect(view.getUint8(11)).toBe(0x45);
  });

  it('clamps samples to -1..1 range', () => {
    // Values outside -1..1 should be clamped
    const pcm = new Float32Array([2.0, -2.0, 1.0, -1.0]);
    const buf = float32ToWavBuffer(pcm, 16000);
    const view = new DataView(buf);

    const sample0 = view.getInt16(44, true);
    const sample1 = view.getInt16(46, true);
    // Clamped 2.0 → max positive ~32767, -2.0 → max negative -32768
    expect(sample0).toBe(0x7FFF);
    expect(sample1).toBe(-32768);
  });

  it('uses default sampleRate=16000', () => {
    const pcm = new Float32Array(100);
    const buf = float32ToWavBuffer(pcm);
    const view = new DataView(buf);
    expect(view.getUint32(24, true)).toBe(16000);
  });

  it('encodes sine wave samples', () => {
    const numSamples = 160;
    const pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.sin(2 * Math.PI * 440 * i / 16000) * 0.5;
    }
    const buf = float32ToWavBuffer(pcm, 16000);
    expect(buf.byteLength).toBe(44 + numSamples * 2);
  });
});

describe('combineWavChunksToBase64', () => {
  it('returns empty string for empty chunks', () => {
    const result = combineWavChunksToBase64([]);
    expect(result).toBe('');
  });

  it('combines WAV chunks by stripping headers', () => {
    const samples1 = new Int16Array([100, 200, 300]);
    const samples2 = new Int16Array([400, 500, 600]);
    const chunk1 = makeWavChunk(samples1);
    const chunk2 = makeWavChunk(samples2);

    const result = combineWavChunksToBase64([chunk1, chunk2]);
    expect(result.length).toBeGreaterThan(0);

    // Decode and verify it's a valid WAV
    const decoded = Uint8Array.from(atob(result), c => c.charCodeAt(0));
    const view = new DataView(decoded.buffer);
    // Should start with RIFF
    expect(decoded[0]).toBe(0x52); // R
    expect(decoded[1]).toBe(0x49); // I
    expect(decoded[2]).toBe(0x46); // F
    expect(decoded[3]).toBe(0x46); // F
  });

  it('returns empty string when all chunks too small', () => {
    const tinyChunk = makeWavChunk(new Int16Array(0)); // only header, no PCM
    const result = combineWavChunksToBase64([tinyChunk]);
    expect(result).toBe('');
  });

  it('concatenates non-WAV chunks as-is', () => {
    // MP3-like data (starts with FF E0 — MPEG sync)
    const mp3Chunk1 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00, 1, 2, 3]);
    const mp3Chunk2 = new Uint8Array([0xFF, 0xFB, 0x90, 0x00, 4, 5, 6]);

    const result = combineWavChunksToBase64([mp3Chunk1, mp3Chunk2]);
    const decoded = Uint8Array.from(atob(result), c => c.charCodeAt(0));
    // Should be concatenated raw bytes
    expect(decoded.length).toBe(14);
    expect(decoded[0]).toBe(0xFF);
  });

  it('preserves sample rate from first WAV chunk', () => {
    const samples = new Int16Array(100).fill(1000);
    const chunk = makeWavChunk(samples, 22050);

    const result = combineWavChunksToBase64([chunk]);
    const decoded = Uint8Array.from(atob(result), c => c.charCodeAt(0));
    const view = new DataView(decoded.buffer);
    expect(view.getUint32(24, true)).toBe(22050);
  });
});

describe('buildSilentWav', () => {
  it('returns an ArrayBuffer', () => {
    const buf = buildSilentWav();
    expect(buf).toBeInstanceOf(ArrayBuffer);
  });

  it('generates the correct size for default params', () => {
    // 0.5s * 16000 samples/s = 8000 samples * 2 bytes = 16000 bytes data
    const buf = buildSilentWav(0.5, 16000);
    const numSamples = Math.round(0.5 * 16000);
    expect(buf.byteLength).toBe(44 + numSamples * 2);
  });

  it('is all zeros in audio data', () => {
    const buf = buildSilentWav(0.1, 16000);
    const arr = new Uint8Array(buf);
    for (let i = 44; i < arr.length; i++) {
      expect(arr[i]).toBe(0);
    }
  });

  it('has correct RIFF/WAVE markers', () => {
    const buf = buildSilentWav();
    const view = new DataView(buf);
    // "RIFF"
    expect(view.getUint8(0)).toBe(0x52);
    expect(view.getUint8(1)).toBe(0x49);
    // "WAVE"
    expect(view.getUint8(8)).toBe(0x57);
    expect(view.getUint8(9)).toBe(0x41);
  });

  it('respects duration and sampleRate', () => {
    const buf1 = buildSilentWav(1, 8000);
    const buf2 = buildSilentWav(2, 16000);
    // 1s@8kHz = 8000 samples; 2s@16kHz = 32000 samples
    expect(buf2.byteLength).toBeGreaterThan(buf1.byteLength);
  });
});
