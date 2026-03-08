/**
 * Modal TTS Provider — Integration Tests (Real API)
 *
 * Tests MOSS-TTS-Realtime deployed on Modal.com.
 * No API key required — public endpoint.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ModalTTSProvider } from '../src/providers/modal';
import { loadEnv, timed } from './helpers';

let modalReachable = false;

beforeAll(async () => {
  loadEnv();
  try {
    const tts = new ModalTTSProvider();
    const res = await fetch((tts as any).baseUrl || 'https://marcosremar--moss-tts-realtime-web.modal.run', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    });
    modalReachable = res.ok || res.status < 500;
  } catch {
    modalReachable = false;
  }
});

describe.skipIf(!modalReachable)('Modal TTS / MOSS-TTS-Realtime (Real API)', () => {
  const tts = new ModalTTSProvider();

  it('synthesizes Portuguese speech', async () => {
    const { result, ms } = await timed(() =>
      tts.synthesize({
        input: 'Olá, tudo bem?',
        model: 'moss-tts-realtime',
        voice: 'moss-pt',
      }),
    );

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    expect(result.contentType).toBe('audio/wav');
    console.log(`  Modal TTS (pt): ${result.audio.length} bytes (${ms}ms)`);
  });

  it('synthesizes English speech', async () => {
    const { result, ms } = await timed(() =>
      tts.synthesize({
        input: 'Hello, how are you?',
        model: 'moss-tts-realtime',
        voice: 'moss-en',
      }),
    );

    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(1000);
    console.log(`  Modal TTS (en): ${result.audio.length} bytes (${ms}ms)`);
  });

  it('synthesizeStream returns a ReadableStream', async () => {
    const stream = await tts.synthesizeStream({
      input: 'Test.',
      model: 'moss-tts-realtime',
      voice: 'moss-pt',
    });

    expect(stream).toBeDefined();
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toBeInstanceOf(Uint8Array);
    reader.releaseLock();
  });

  it('isConfigured always returns true (public endpoint)', () => {
    expect(tts.isConfigured()).toBe(true);
  });

  it('lists models', () => {
    const models = tts.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe('moss-tts-realtime');
  });
});
