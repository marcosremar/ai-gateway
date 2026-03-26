/**
 * Web Worker for PCM-to-Float32 decoding.
 * Offloads CPU-intensive byte-level conversion off the main thread
 * so Babylon.js rendering and React don't stutter during audio streaming.
 *
 * Protocol:
 *   Main → Worker: { pcm: Uint8Array, bitsPerSample: number, bytesPerSample: number, id: number }
 *   Worker → Main: { float32: Float32Array, id: number }
 */

self.onmessage = (e: MessageEvent) => {
  const { pcm, bitsPerSample, bytesPerSample, id } = e.data as {
    pcm: Uint8Array;
    bitsPerSample: number;
    bytesPerSample: number;
    id: number;
  };

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const numSamples = Math.floor(pcm.length / bytesPerSample);
  const float32 = new Float32Array(numSamples);

  if (bitsPerSample === 16) {
    for (let i = 0; i < numSamples; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768;
    }
  } else if (bitsPerSample === 24) {
    for (let i = 0; i < numSamples; i++) {
      const offset = i * 3;
      const sample = (view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16));
      float32[i] = sample / 8388608;
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < numSamples; i++) {
      float32[i] = view.getFloat32(i * 4, true);
    }
  }

  // Transfer the buffer (zero-copy back to main thread)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (self as any).postMessage({ float32, id }, [float32.buffer]);
};
