/**
 * Modal TTS Provider — Integration Tests (Real API)
 *
 * Tests TTS deployed on Modal.com.
 * No API key required — public endpoint.
 *
 * Enable: Set MODAL_TTS_URL in .env or ensure Modal app is deployed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ModalTTSProvider } from '../src/providers/modal';
import { initFeatures, FEATURES } from './test-config';
import { timed } from './helpers';

// Detect Modal availability before tests
await initFeatures();

describe.skipIf(!FEATURES.modalTts)('Modal TTS (Real API)', () => {
  const tts = new ModalTTSProvider();

  it('isConfigured always returns true (public endpoint)', () => {
    expect(tts.isConfigured()).toBe(true);
  });

  it('synthesizes Portuguese speech', async () => {
    const { result, ms } = await timed(() =>
      tts.synthesize({
        input: 'Olá, tudo bem?',
        model: 'moss-tts-realtime',
        voice: 'en_speaker_0',
      }),
    );
    expect(result.audio.length).toBeGreaterThan(100);
    expect(result.contentType).toMatch(/audio/);
    console.log(`  Modal TTS: ${result.audio.length} bytes, ${ms}ms`);
  }, 30_000);

  it('synthesizes English speech', async () => {
    const { result } = await timed(() =>
      tts.synthesize({
        input: 'Hello world, this is a test.',
        model: 'moss-tts-realtime',
        voice: 'en_speaker_0',
      }),
    );
    expect(result.audio.length).toBeGreaterThan(100);
  }, 30_000);

  it('returns WAV content type', async () => {
    const result = await tts.synthesize({
      input: 'Test.',
      model: 'moss-tts-realtime',
    });
    expect(result.contentType).toMatch(/wav|audio/);
  }, 30_000);

  it('getModels returns at least one model', () => {
    const models = tts.getModels();
    expect(models.length).toBeGreaterThan(0);
  });
});
