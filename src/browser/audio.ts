/**
 * Browser-safe audio utilities extracted from `src/lib/audio/index.ts`.
 *
 * Only includes functions that work in both browser and non-browser environments
 * without Node `Buffer`. Server-only helpers (makeTestWav, makeTestWavBase64)
 * remain in `src/lib/audio`.
 */

// ── Base64 ─────────────────────────────────────────────────────────────────

/**
 * Convert a Uint8Array to a base64 string using btoa (browser + Bun safe).
 */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── WAV header ─────────────────────────────────────────────────────────────

function writeWavHeader(
  view: DataView,
  numSamples: number,
  sampleRate: number,
  numChannels: number = 1,
  bitsPerSample: number = 16,
): void {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * numChannels * bytesPerSample;

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
}

// ── Float32 PCM -> WAV ─────────────────────────────────────────────────────

/**
 * Convert a Float32Array of PCM samples (-1..1) to a 16-bit mono WAV buffer.
 */
export function float32ToWavBuffer(
  float32Array: Float32Array,
  sampleRate: number = 16000,
): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + float32Array.length * 2);
  const view = new DataView(buffer);
  writeWavHeader(view, float32Array.length, sampleRate);

  let offset = 44;
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}

// ── Combine WAV chunks ─────────────────────────────────────────────────────

/**
 * Check if a chunk starts with a RIFF/WAVE header.
 */
function isWavChunk(chunk: Uint8Array): boolean {
  if (chunk.length < 12) return false;
  // "RIFF" at offset 0 and "WAVE" at offset 8
  return chunk[0] === 0x52 && chunk[1] === 0x49 && chunk[2] === 0x46 && chunk[3] === 0x46
      && chunk[8] === 0x57 && chunk[9] === 0x41 && chunk[10] === 0x56 && chunk[11] === 0x45;
}

/**
 * Combine multiple audio chunks into a single base64 string.
 * If chunks are WAV (each with a 44-byte header), strips headers, merges PCM
 * data, and re-adds a single WAV header.
 * If chunks are not WAV (e.g. MP3, Opus), concatenates raw bytes as-is.
 */
export function combineWavChunksToBase64(chunks: Uint8Array[]): string {
  if (chunks.length === 0) return '';

  // Detect format from the first chunk
  const firstIsWav = isWavChunk(chunks[0]);

  if (!firstIsWav) {
    // Non-WAV audio (MP3, Opus, etc.) — just concatenate raw bytes
    let totalBytes = 0;
    for (const chunk of chunks) totalBytes += chunk.length;
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return uint8ToBase64(combined);
  }

  // WAV chunks — strip headers, merge PCM, re-add single header
  const firstView = new DataView(chunks[0].buffer, chunks[0].byteOffset);
  const sampleRate = firstView.getUint32(24, true);
  const bitsPerSample = firstView.getUint16(34, true);
  const numChannels = firstView.getUint16(22, true);

  const pcmChunks: Uint8Array[] = [];
  let totalPcmBytes = 0;
  for (const chunk of chunks) {
    if (chunk.length > 44) {
      const pcm = chunk.slice(44);
      pcmChunks.push(pcm);
      totalPcmBytes += pcm.length;
    }
  }
  if (totalPcmBytes === 0) return '';

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);
  view.setUint32(0, 0x46464952, true);   // "RIFF"
  view.setUint32(4, 36 + totalPcmBytes, true);
  view.setUint32(8, 0x45564157, true);    // "WAVE"
  view.setUint32(12, 0x20746d66, true);   // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x61746164, true);   // "data"
  view.setUint32(40, totalPcmBytes, true);

  const combined = new Uint8Array(44 + totalPcmBytes);
  combined.set(new Uint8Array(wavHeader), 0);
  let offset = 44;
  for (const pcm of pcmChunks) {
    combined.set(pcm, offset);
    offset += pcm.length;
  }

  return uint8ToBase64(combined);
}

// ── Silent WAV ─────────────────────────────────────────────────────────────

/**
 * Build a silent 16-bit mono WAV as an ArrayBuffer.
 * Useful for testing or warming up audio pipelines.
 */
export function buildSilentWav(
  durationSecs: number = 0.5,
  sampleRate: number = 16000,
): ArrayBuffer {
  const numSamples = Math.round(sampleRate * durationSecs);
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  writeWavHeader(view, numSamples, sampleRate);
  return buf;
}
