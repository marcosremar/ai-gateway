// ── WAV Header Utilities — unit tests ────────────────────────────────────────
// Covers buildWavHeader, createWavBuffer, parseWavHeader.
// All functions are pure Buffer operations with no external I/O.

import { describe, it, expect } from 'vitest';
import {
  buildWavHeader,
  createWavBuffer,
  parseWavHeader,
} from '../../server/utils/wav-header';

// ── buildWavHeader ───────────────────────────────────────────────────────────

describe('buildWavHeader', () => {
  it('returns exactly 44 bytes', () => {
    const hdr = buildWavHeader(16_000, 0);
    expect(hdr.length).toBe(44);
  });

  it('writes RIFF chunk ID at offset 0', () => {
    const hdr = buildWavHeader(16_000, 1024);
    expect(hdr.toString('utf8', 0, 4)).toBe('RIFF');
  });

  it('writes WAVE format at offset 8', () => {
    const hdr = buildWavHeader(16_000, 1024);
    expect(hdr.toString('utf8', 8, 12)).toBe('WAVE');
  });

  it('writes fmt  sub-chunk ID at offset 12', () => {
    const hdr = buildWavHeader(16_000, 1024);
    expect(hdr.toString('utf8', 12, 16)).toBe('fmt ');
  });

  it('writes PCM sub-chunk size 16 at offset 16', () => {
    const hdr = buildWavHeader(16_000, 1024);
    expect(hdr.readUInt32LE(16)).toBe(16);
  });

  it('writes PCM audio format 1 at offset 20', () => {
    const hdr = buildWavHeader(16_000, 1024);
    expect(hdr.readUInt16LE(20)).toBe(1);
  });

  it('writes data chunk ID at offset 36', () => {
    const hdr = buildWavHeader(16_000, 1024);
    expect(hdr.toString('utf8', 36, 40)).toBe('data');
  });

  it('encodes dataSize at offset 40 (UInt32LE)', () => {
    const dataSize = 44_100 * 2; // 1s stereo 16-bit at 44.1kHz
    const hdr = buildWavHeader(44_100, dataSize);
    expect(hdr.readUInt32LE(40)).toBe(dataSize);
  });

  it('encodes file size = 36 + dataSize at offset 4', () => {
    const dataSize = 8_000;
    const hdr = buildWavHeader(8_000, dataSize);
    expect(hdr.readUInt32LE(4)).toBe(36 + dataSize);
  });

  it('encodes sampleRate at offset 24 (UInt32LE)', () => {
    const hdr = buildWavHeader(44_100, 0);
    expect(hdr.readUInt32LE(24)).toBe(44_100);
  });

  it('encodes numChannels at offset 22 (UInt16LE)', () => {
    const hdr = buildWavHeader(16_000, 0, 2);
    expect(hdr.readUInt16LE(22)).toBe(2);
  });

  it('defaults to mono (numChannels=1)', () => {
    const hdr = buildWavHeader(16_000, 0);
    expect(hdr.readUInt16LE(22)).toBe(1);
  });

  it('encodes bitsPerSample at offset 34 (UInt16LE)', () => {
    const hdr = buildWavHeader(16_000, 0, 1, 24);
    expect(hdr.readUInt16LE(34)).toBe(24);
  });

  it('defaults to 16-bit depth', () => {
    const hdr = buildWavHeader(16_000, 0);
    expect(hdr.readUInt16LE(34)).toBe(16);
  });

  it('computes byteRate = sampleRate * channels * bytesPerSample at offset 28', () => {
    // mono, 16-bit @ 16kHz → 16000 * 1 * 2 = 32000
    const hdr = buildWavHeader(16_000, 0, 1, 16);
    expect(hdr.readUInt32LE(28)).toBe(32_000);
  });

  it('computes byteRate for stereo 24-bit @ 48kHz', () => {
    // 48000 * 2 * 3 = 288000
    const hdr = buildWavHeader(48_000, 0, 2, 24);
    expect(hdr.readUInt32LE(28)).toBe(288_000);
  });

  it('computes blockAlign = channels * bytesPerSample at offset 32', () => {
    // mono 16-bit → 1 * 2 = 2
    const hdr = buildWavHeader(16_000, 0, 1, 16);
    expect(hdr.readUInt16LE(32)).toBe(2);
  });

  it('computes blockAlign for stereo 16-bit', () => {
    // stereo 16-bit → 2 * 2 = 4
    const hdr = buildWavHeader(16_000, 0, 2, 16);
    expect(hdr.readUInt16LE(32)).toBe(4);
  });

  it('handles zero dataSize without overflowing', () => {
    const hdr = buildWavHeader(16_000, 0);
    expect(hdr.readUInt32LE(40)).toBe(0);
    expect(hdr.readUInt32LE(4)).toBe(36);
  });

  it('handles large dataSize (100MB PCM)', () => {
    const dataSize = 100 * 1024 * 1024;
    const hdr = buildWavHeader(48_000, dataSize);
    expect(hdr.readUInt32LE(40)).toBe(dataSize);
    expect(hdr.readUInt32LE(4)).toBe(36 + dataSize);
  });
});

// ── createWavBuffer ──────────────────────────────────────────────────────────

describe('createWavBuffer', () => {
  it('total length = 44 (header) + audioData.length', () => {
    const audio = Buffer.alloc(1600, 0);
    const wav = createWavBuffer(audio, 16_000);
    expect(wav.length).toBe(44 + 1600);
  });

  it('first 44 bytes match buildWavHeader output', () => {
    const audio = Buffer.alloc(3200, 0x42);
    const wav = createWavBuffer(audio, 16_000);
    const expected = buildWavHeader(16_000, 3200);
    expect(wav.subarray(0, 44)).toEqual(expected);
  });

  it('audio data follows the header unchanged', () => {
    const audio = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const wav = createWavBuffer(audio, 8_000);
    expect(wav.subarray(44)).toEqual(audio);
  });

  it('defaults sampleRate to 16000 when omitted', () => {
    const audio = Buffer.alloc(100, 0);
    const wav = createWavBuffer(audio);
    // sampleRate at offset 24
    expect(wav.readUInt32LE(24)).toBe(16_000);
  });

  it('handles empty audio buffer', () => {
    const wav = createWavBuffer(Buffer.alloc(0), 44_100);
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0); // dataSize = 0
  });
});

// ── parseWavHeader ───────────────────────────────────────────────────────────

describe('parseWavHeader', () => {
  function makeValidWav(sampleRate = 16_000, dataSize = 0, channels = 1, bits = 16): Buffer {
    return createWavBuffer(Buffer.alloc(dataSize), sampleRate);
    // createWavBuffer always sets mono/16-bit; call buildWavHeader directly for other configs
  }

  it('returns null for buffer shorter than 44 bytes', () => {
    expect(parseWavHeader(Buffer.alloc(43))).toBeNull();
    expect(parseWavHeader(Buffer.alloc(0))).toBeNull();
  });

  it('returns null when RIFF signature is missing', () => {
    const buf = buildWavHeader(16_000, 0);
    buf.write('XXXX', 0);
    expect(parseWavHeader(buf)).toBeNull();
  });

  it('returns null when WAVE signature is missing', () => {
    const buf = buildWavHeader(16_000, 0);
    buf.write('XXXX', 8);
    expect(parseWavHeader(buf)).toBeNull();
  });

  it('returns null when fmt  signature is missing', () => {
    const buf = buildWavHeader(16_000, 0);
    buf.write('XXXX', 12);
    expect(parseWavHeader(buf)).toBeNull();
  });

  it('parses sampleRate from a valid header', () => {
    const hdr = buildWavHeader(44_100, 0);
    const parsed = parseWavHeader(hdr);
    expect(parsed?.sampleRate).toBe(44_100);
  });

  it('parses numChannels from a valid header', () => {
    const hdr = buildWavHeader(16_000, 0, 2, 16);
    const parsed = parseWavHeader(hdr);
    expect(parsed?.numChannels).toBe(2);
  });

  it('parses bitsPerSample from a valid header', () => {
    const hdr = buildWavHeader(16_000, 0, 1, 24);
    const parsed = parseWavHeader(hdr);
    expect(parsed?.bitsPerSample).toBe(24);
  });

  it('parses dataSize from a valid header', () => {
    const dataSize = 32_000;
    const hdr = buildWavHeader(16_000, dataSize);
    const parsed = parseWavHeader(hdr);
    expect(parsed?.dataSize).toBe(dataSize);
  });

  it('round-trips through buildWavHeader → parseWavHeader', () => {
    const sampleRate = 22_050;
    const dataSize = 22_050 * 2 * 2; // 2s stereo 16-bit
    const hdr = buildWavHeader(sampleRate, dataSize, 2, 16);
    const parsed = parseWavHeader(hdr);
    expect(parsed).not.toBeNull();
    expect(parsed?.sampleRate).toBe(sampleRate);
    expect(parsed?.numChannels).toBe(2);
    expect(parsed?.bitsPerSample).toBe(16);
    expect(parsed?.dataSize).toBe(dataSize);
  });

  it('round-trips through createWavBuffer with full file buffer', () => {
    const audio = Buffer.from([0xAB, 0xCD, 0xEF, 0x01]);
    const wav = createWavBuffer(audio, 8_000);
    const parsed = parseWavHeader(wav);
    expect(parsed).not.toBeNull();
    expect(parsed?.sampleRate).toBe(8_000);
    expect(parsed?.dataSize).toBe(4);
  });

  it('returns null for a completely zeroed 44-byte buffer', () => {
    expect(parseWavHeader(Buffer.alloc(44, 0))).toBeNull();
  });
});
