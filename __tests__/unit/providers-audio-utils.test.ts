/**
 * Tests for providers/openai-compat/audio-utils.ts
 * - detectAudioFormat()
 */

import { describe, it, expect } from 'vitest';
import { detectAudioFormat } from '../../src/gateway/providers/cloud/openai-compat/audio-utils';

function makeBuffer(bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('detectAudioFormat', () => {
  it('detects WAV by RIFF header', () => {
    // RIFF header: 52 49 46 46
    const wav = makeBuffer([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00]);
    const result = detectAudioFormat(wav);
    expect(result.filename).toBe('audio.wav');
    expect(result.contentType).toBe('audio/wav');
  });

  it('detects MP3 by ID3 tag', () => {
    // ID3 header: 49 44 33
    const mp3 = makeBuffer([0x49, 0x44, 0x33, 0x00, 0x00, 0x00]);
    const result = detectAudioFormat(mp3);
    expect(result.filename).toBe('audio.mp3');
    expect(result.contentType).toBe('audio/mpeg');
  });

  it('detects MP3 by MPEG sync word', () => {
    // MPEG sync: FF E0 or higher
    const mp3 = makeBuffer([0xFF, 0xFB, 0x90, 0x00]);
    const result = detectAudioFormat(mp3);
    expect(result.filename).toBe('audio.mp3');
    expect(result.contentType).toBe('audio/mpeg');
  });

  it('detects OGG by OggS header', () => {
    // OggS: 4F 67 67 53
    const ogg = makeBuffer([0x4F, 0x67, 0x67, 0x53, 0x00, 0x00]);
    const result = detectAudioFormat(ogg);
    expect(result.filename).toBe('audio.ogg');
    expect(result.contentType).toBe('audio/ogg');
  });

  it('detects FLAC by fLaC header', () => {
    // fLaC: 66 4C 61 43
    const flac = makeBuffer([0x66, 0x4C, 0x61, 0x43, 0x00, 0x00]);
    const result = detectAudioFormat(flac);
    expect(result.filename).toBe('audio.flac');
    expect(result.contentType).toBe('audio/flac');
  });

  it('detects M4A by ftyp box', () => {
    // M4A: bytes 4-7 are "ftyp": 66 74 79 70
    const m4a = makeBuffer([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70, 0x00]);
    const result = detectAudioFormat(m4a);
    expect(result.filename).toBe('audio.m4a');
    expect(result.contentType).toBe('audio/mp4');
  });

  it('detects WebM by EBML header', () => {
    // EBML: 1A 45 DF A3
    const webm = makeBuffer([0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00]);
    const result = detectAudioFormat(webm);
    expect(result.filename).toBe('audio.webm');
    expect(result.contentType).toBe('audio/webm');
  });

  it('defaults to WAV for unknown format', () => {
    const unknown = makeBuffer([0x00, 0x01, 0x02, 0x03]);
    const result = detectAudioFormat(unknown);
    expect(result.filename).toBe('audio.wav');
    expect(result.contentType).toBe('audio/wav');
  });

  it('defaults to WAV for buffer smaller than 4 bytes', () => {
    const small = makeBuffer([0x49, 0x44]); // Only 2 bytes
    const result = detectAudioFormat(small);
    expect(result.filename).toBe('audio.wav');
    expect(result.contentType).toBe('audio/wav');
  });

  it('defaults to WAV for empty buffer', () => {
    const empty = makeBuffer([]);
    const result = detectAudioFormat(empty);
    expect(result.filename).toBe('audio.wav');
    expect(result.contentType).toBe('audio/wav');
  });

  it('requires buffer.length >= 8 for M4A detection', () => {
    // M4A needs at least 8 bytes
    const tooShort = makeBuffer([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79]); // 7 bytes
    const result = detectAudioFormat(tooShort);
    // Should NOT detect as M4A
    expect(result.filename).not.toBe('audio.m4a');
  });
});
