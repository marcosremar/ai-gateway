/**
 * Noise suppression — covers factory dispatch, passthrough mode, error
 * paths. Browser-only adapters (WebRTC + DeepFilterNet) require live DOM
 * APIs we mock partially; full integration runs in Playwright.
 */
import { describe, it, expect } from 'vitest';
import { createNoiseSuppressor } from '../../src/browser/noise-suppression';

describe('createNoiseSuppressor — factory dispatch', () => {
  it("returns passthrough for mode='none'", async () => {
    const ns = await createNoiseSuppressor({ mode: 'none' });
    expect(ns.mode).toBe('none');
  });

  it('throws for unknown mode', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createNoiseSuppressor({ mode: 'bogus' as any })).rejects.toThrow(/unknown noise suppression mode/);
  });
});

describe("passthrough (mode='none')", () => {
  it('returns the stream unchanged', async () => {
    const ns = await createNoiseSuppressor({ mode: 'none' });
    const fakeStream = { id: 'fake-stream' } as unknown as MediaStream;
    const out = await ns.process(fakeStream);
    expect(out).toBe(fakeStream);
  });

  it('dispose is no-op + idempotent', async () => {
    const ns = await createNoiseSuppressor({ mode: 'none' });
    await ns.dispose();
    await ns.dispose();
    // No throw = pass.
  });

  it('stats returns zero counters', async () => {
    const ns = await createNoiseSuppressor({ mode: 'none' });
    const s = ns.stats();
    expect(s.framesProcessed).toBe(0);
    expect(s.avgInferenceMs).toBe(0);
    expect(s.mode).toBe('none');
  });
});

describe("WebRTC builtin (mode='webrtc')", () => {
  it('throws when navigator.mediaDevices unavailable', async () => {
    const ns = await createNoiseSuppressor({ mode: 'webrtc' });
    const fakeStream = { getAudioTracks: () => [] } as unknown as MediaStream;
    await expect(ns.process(fakeStream)).rejects.toThrow(/navigator\.mediaDevices/);
  });

  it('reports webrtc mode in stats', async () => {
    const ns = await createNoiseSuppressor({ mode: 'webrtc' });
    expect(ns.stats().mode).toBe('webrtc');
  });
});

describe("DeepFilterNet (mode='deepfilternet')", () => {
  it('fails fast when onnxruntime-web is missing', async () => {
    await expect(
      createNoiseSuppressor({ mode: 'deepfilternet', ortPath: '/__nonexistent_ort__' }),
    ).rejects.toThrow(/onnxruntime-web/);
  });
});
