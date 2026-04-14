import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeTestWav } from '../src/benchmarking/bench';
import { DeepgramSTTProvider } from '../src/providers/deepgram/index';

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

const hasApiKey = !!process.env.DEEPGRAM_API_KEY;
const provider = new DeepgramSTTProvider();

describe('Deepgram STT Provider', () => {
  it('isConfigured() returns true only when DEEPGRAM_API_KEY is set', () => {
    expect(provider.isConfigured()).toBe(hasApiKey);
  });

  it('providerId is deepgram', () => {
    expect(provider.providerId).toBe('deepgram');
  });

  it('getModels() returns Nova models', () => {
    const models = provider.getModels();
    expect(models.length).toBeGreaterThanOrEqual(2);

    const nova3 = models.find(m => m.id === 'nova-3');
    const nova2 = models.find(m => m.id === 'nova-2');

    expect(nova3).toBeTruthy();
    expect(nova3!.capability).toBe('stt');
    expect(nova3!.isDefault).toBe(true);

    expect(nova2).toBeTruthy();
    expect(nova2!.capability).toBe('stt');
  });

  it.skipIf(!hasApiKey)('transcribes audio via real API call', async () => {
    const audio = makeTestWav(0.5);

    const result = await provider.transcribe({ audio, language: 'en' });

    expect(typeof result.text).toBe('string');
    console.log(`[Deepgram] Transcription: "${result.text}"`);
  }, 30_000);

  it.skipIf(!hasApiKey)('transcribe() throws for missing API key when env is cleared', async () => {
    const originalKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    const freshProvider = new DeepgramSTTProvider();
    expect(freshProvider.isConfigured()).toBe(false);

    try {
      await expect(
        freshProvider.transcribe({ audio: makeTestWav(0.5) }),
      ).rejects.toThrow('DEEPGRAM_API_KEY is not set');
    } finally {
      if (originalKey) process.env.DEEPGRAM_API_KEY = originalKey;
    }
  });
});
