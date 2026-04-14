/**
 * Shared WAV header builder.
 *
 * Fixes: #131 (duplicated WAV header construction in 4+ files)
 *
 * Usage:
 * ```ts
 * import { buildWavHeader } from './wav-header';
 *
 * const header = buildWavHeader(16000, dataSize);
 * const wav = Buffer.concat([header, audioData]);
 * ```
 */

/**
 * Build a 44-byte WAV header.
 *
 * @param sampleRate - Sample rate in Hz (e.g., 16000)
 * @param dataSize - Size of audio data in bytes
 * @param numChannels - Number of channels (default: 1 = mono)
 * @param bitsPerSample - Bits per sample (default: 16)
 */
export function buildWavHeader(
  sampleRate: number,
  dataSize: number,
  numChannels = 1,
  bitsPerSample = 16,
): Buffer {
  const header = Buffer.alloc(44);

  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4); // File size - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/**
 * Create a complete WAV buffer from raw PCM audio data.
 *
 * @param audioData - Raw PCM audio (16-bit, little-endian)
 * @param sampleRate - Sample rate in Hz
 */
export function createWavBuffer(audioData: Buffer, sampleRate = 16000): Buffer {
  const header = buildWavHeader(sampleRate, audioData.length);
  return Buffer.concat([header, audioData]);
}

/**
 * Validate a WAV header and return its properties.
 * Returns null if the buffer is not a valid WAV file.
 */
export function parseWavHeader(buffer: Buffer): {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataSize: number;
} | null {
  if (buffer.length < 44) return null;
  if (buffer.toString('utf8', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('utf8', 8, 12) !== 'WAVE') return null;
  if (buffer.toString('utf8', 12, 16) !== 'fmt ') return null;

  return {
    sampleRate: buffer.readUInt32LE(24),
    numChannels: buffer.readUInt16LE(22),
    bitsPerSample: buffer.readUInt16LE(34),
    dataSize: buffer.readUInt32LE(40),
  };
}
