import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeTestWav } from '../src/benchmarking/bench';
import { ElevenLabsSTTProvider, ELEVENLABS_STT_MODELS } from '../src/providers/elevenlabs/index';

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env */ }
}
loadEnv();

const hasApiKey = !!process.env.ELEVENLABS_API_KEY;
const provider = new ElevenLabsSTTProvider();

describe('ElevenLabs STT Provider', () => {
  it('exports ELEVENLABS_STT_MODELS with correct structure', () => {
    expect(ELEVENLABS_STT_MODELS.length).toBeGreaterThanOrEqual(2);

    const v2 = ELEVENLABS_STT_MODELS.find(m => m.id === 'scribe_v2');
    const v1 = ELEVENLABS_STT_MODELS.find(m => m.id === 'scribe_v1');

    expect(v2).toBeTruthy();
    expect(v2!.capability).toBe('stt');
    expect(v2!.isDefault).toBe(true);

    expect(v1).toBeTruthy();
    expect(v1!.capability).toBe('stt');
  });

  it('isConfigured() returns true only when ELEVENLABS_API_KEY is set', () => {
    expect(provider.isConfigured()).toBe(hasApiKey);
  });

  it('providerId is elevenlabs', () => {
    expect(provider.providerId).toBe('elevenlabs');
  });

  it('getModels() returns Scribe models', () => {
    const models = provider.getModels();
    expect(models).toEqual(ELEVENLABS_STT_MODELS);
  });

  it('withApiKey() returns a new provider with the key', () => {
    const custom = provider.withApiKey('test-key-123');
    expect(custom).toBeInstanceOf(ElevenLabsSTTProvider);
    expect(custom.isConfigured()).toBe(true);
    expect(custom).not.toBe(provider);
  });

  it.skipIf(!hasApiKey)('transcribes audio via real API call', async () => {
    const audio = makeTestWav(0.5);

    const result = await provider.transcribe({ audio, language: 'en' });

    expect(typeof result.text).toBe('string');
    console.log(`[ElevenLabs] Transcription: "${result.text}"`);
  }, 30_000);

  it.skipIf(!hasApiKey)('transcribe() throws for missing API key when env is cleared', async () => {
    const originalKey = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    const freshProvider = new ElevenLabsSTTProvider();
    expect(freshProvider.isConfigured()).toBe(false);

    try {
      await expect(
        freshProvider.transcribe({ audio: makeTestWav(0.5) }),
      ).rejects.toThrow('ELEVENLABS_API_KEY is not set');
    } finally {
      if (originalKey) process.env.ELEVENLABS_API_KEY = originalKey;
    }
  });
});
