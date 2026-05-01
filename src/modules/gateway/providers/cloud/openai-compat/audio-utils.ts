/**
 * Shared audio utilities for OpenAI-compatible providers.
 * Extracted from openai-stt.ts to avoid duplication.
 */

import { toFile } from 'openai';

export function detectAudioFormat(buffer: Buffer): { filename: string; contentType: string } {
  if (buffer.length < 4) return { filename: 'audio.wav', contentType: 'audio/wav' };
  if ((buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0)) return { filename: 'audio.mp3', contentType: 'audio/mpeg' };
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return { filename: 'audio.wav', contentType: 'audio/wav' };
  if (buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return { filename: 'audio.ogg', contentType: 'audio/ogg' };
  if (buffer[0] === 0x66 && buffer[1] === 0x4C && buffer[2] === 0x61 && buffer[3] === 0x43) return { filename: 'audio.flac', contentType: 'audio/flac' };
  if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return { filename: 'audio.m4a', contentType: 'audio/mp4' };
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return { filename: 'audio.webm', contentType: 'audio/webm' };
  return { filename: 'audio.wav', contentType: 'audio/wav' };
}

export async function prepareAudioFile(audio: Buffer | Blob): Promise<ReturnType<typeof toFile> extends Promise<infer R> ? R : never> {
  if (Buffer.isBuffer(audio)) {
    const { filename, contentType } = detectAudioFormat(audio);
    return await toFile(audio, filename, { type: contentType });
  }
  const arrayBuffer = await audio.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (audio.type) {
    // MIME types may carry parameters like "audio/webm;codecs=opus" — strip
    // anything past the semicolon and any whitespace before using the
    // subtype as a filename extension. Without this, OpenAI's multipart
    // upload sees `audio.webm;codecs=opus` and rejects the request.
    const subtype = audio.type.split('/')[1] || '';
    const ext = (subtype.split(';')[0] || 'wav').trim() || 'wav';
    return await toFile(buffer, `audio.${ext}`, { type: audio.type });
  }
  const { filename, contentType } = detectAudioFormat(buffer);
  return await toFile(buffer, filename, { type: contentType });
}
