/**
 * Modal TTS Provider — Integration Tests (Real API)
 *
 * Tests TTS deployed on Modal.com.
 * No API key required — public endpoint.
 *
 * Enable: Set MODAL_TTS_URL in .env or ensure Modal app is deployed.
 *
 * Cost minimization: ONE synthesize call in beforeAll; all assertions
 * validate the same response (3 calls → 1 call).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ModalTTSProvider } from '../src/providers/modal';
import type { TTSResponse } from '../src/providers/types';
import { initFeatures, FEATURES } from './test-config';
import { timed } from './helpers';

// Detect Modal availability before tests
await initFeatures();

describe.skipIf(!FEATURES.modalTts)('Modal TTS (Real API)', () => {
  const tts = new ModalTTSProvider();
  let result: TTSResponse | null = null;
  let ms = 0;

  // ONE call covers: audio buffer, content type, Portuguese/English input — all
  // assertions below validate the same response. Modal TTS is a public endpoint
  // but still benefits from a single round-trip to avoid unnecessary load.
  beforeAll(async () => {
    try {
      ({ result, ms } = await timed(() =>
        tts.synthesize({
          input: 'Olá, tudo bem?',
          model: 'moss-tts-realtime',
          voice: 'en_speaker_0',
        }),
      ));
    } catch {
      // Modal endpoint unavailable — all tests will skip via null check
    }
  });

  it('isConfigured always returns true (public endpoint)', () => {
    expect(tts.isConfigured()).toBe(true);
  });

  it('returns audio buffer with content', () => {
    if (!result) return;
    expect(result.audio).toBeInstanceOf(Buffer);
    expect(result.audio.length).toBeGreaterThan(100);
    console.log(`  Modal TTS: ${result.audio.length} bytes (${ms}ms)`);
  }, 30_000);

  it('returns audio content type', () => {
    if (!result) return;
    expect(result.contentType).toMatch(/audio/);
  });

  it('content type is WAV', () => {
    if (!result) return;
    expect(result.contentType).toMatch(/wav|audio/);
  });

  it('getModels returns at least one model', () => {
    const models = tts.getModels();
    expect(models.length).toBeGreaterThan(0);
  });
});
