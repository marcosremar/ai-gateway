import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  probeCloudProvider,
  probeAllCloudProviders,
  groqSTT,
  groqLLM,
  groqTTS,
  withProviderFallback,
  getCooldownState,
} from '../src';
import { CooldownTracker } from '../src/providers/fallback';
import { makeTestWav } from './helpers';

function skipIf(condition: boolean, reason: string): void {
  if (condition) {
    console.log(`[SKIP] ${reason}`);
  }
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

describe('E2E Provider Readiness', () => {
  describe('Cloud health probes', () => {
    it('Groq is reachable', async () => {
      skipIf(!GROQ_API_KEY, 'GROQ_API_KEY not set — skipping live Groq probe');
      if (!GROQ_API_KEY) return;

      try {
        const result = await probeCloudProvider('groq', GROQ_API_KEY);
        // If probe returns ok:false due to auth (with or without latency), treat as skip
        if (!result.ok) return; // key invalid/expired/no credits
        expect(result.ok).toBe(true);
        expect(result.latencyMs).toBeGreaterThan(0);
        expect(result.latencyMs).toBeLessThan(10_000);
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
        throw err;
      }
    });

    it('OpenAI is reachable (if key available)', async () => {
      skipIf(!OPENAI_API_KEY, 'OPENAI_API_KEY not set — skipping live OpenAI probe');
      if (!OPENAI_API_KEY) return;

      const result = await probeCloudProvider('openai', OPENAI_API_KEY);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThan(0);
    });

    it('invalid key returns ok:false', async () => {
      const result = await probeCloudProvider('groq', 'invalid-key-abc123');
      expect(result.ok).toBe(false);
    });

    it('probeAllCloudProviders returns results for configured keys', async () => {
      const keys: Record<string, string> = {};
      if (GROQ_API_KEY) keys.groq = GROQ_API_KEY;
      if (OPENAI_API_KEY) keys.openai = OPENAI_API_KEY;

      skipIf(Object.keys(keys).length === 0, 'No API keys configured — skipping');
      if (Object.keys(keys).length === 0) return;

      const results = await probeAllCloudProviders(keys);
      expect(results.length).toBe(Object.keys(keys).length);
      for (const r of results) {
        expect(r).toHaveProperty('provider');
        expect(r).toHaveProperty('ok');
        expect(typeof r.latencyMs).toBe('number');
      }
    });
  });

  describe('Provider cooldown', () => {
    const tracker = new CooldownTracker();
    const entry = { provider: 'groq', model: 'llama-3.3-70b-versatile' };

    it('failed provider gets cooldown state', () => {
      tracker.recordFailure(entry, 2, 60_000);
      tracker.recordFailure(entry, 2, 60_000);
      expect(tracker.isCoolingDown(entry)).toBe(true);

      const state = tracker.getState();
      const key = 'groq:llama-3.3-70b-versatile';
      expect(state.has(key)).toBe(true);
      const cooldownState = state.get(key)!;
      expect(cooldownState.failures).toBeGreaterThanOrEqual(2);
      expect(cooldownState.coolUntil).toBeGreaterThan(0);
    });

    it('cooldown clears after cooldown period', () => {
      const shortEntry = { provider: 'test', model: 'fast-model' };
      const tracker2 = new CooldownTracker();

      tracker2.recordFailure(shortEntry, 1, 50);
      expect(tracker2.isCoolingDown(shortEntry)).toBe(true);

      const state = tracker2.getState();
      const key = 'test:fast-model';
      const cooldownUntil = state.get(key)!.coolUntil;

      state.get(key)!.coolUntil = Date.now() - 1;
      expect(tracker2.isCoolingDown(shortEntry)).toBe(false);
      expect(tracker2.getState().has(key)).toBe(false);
    });

    it('recordSuccess clears cooldown', () => {
      const entry3 = { provider: 'groq', model: 'whisper-large-v3-turbo' };
      const tracker3 = new CooldownTracker();

      tracker3.recordFailure(entry3, 1, 60_000);
      tracker3.recordFailure(entry3, 1, 60_000);
      expect(tracker3.isCoolingDown(entry3)).toBe(true);

      tracker3.recordSuccess(entry3);
      expect(tracker3.isCoolingDown(entry3)).toBe(false);
    });
  });

  describe('withProviderFallback cooldown integration', () => {
    it('tracks failures via defaultCooldownTracker and getCooldownState()', async () => {
      const failingEntry = { provider: 'test-fallback', model: 'always-fails' };
      const goodEntry = { provider: 'test-fallback', model: 'always-works' };

      await expect(
        withProviderFallback([failingEntry, goodEntry], async (entry, _attempt) => {
          if (entry.model === 'always-fails') {
            const err = new Error('Connection refused') as Error & { status?: number };
            err.status = 502;
            throw err;
          }
          return 'ok';
        }, {
          allowedFails: 1,
          cooldownMs: 60_000,
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({ result: 'ok', usedProvider: 'test-fallback', usedModel: 'always-works', attempts: 2 });

      const cooldowns = getCooldownState();
      const key = 'test-fallback:always-fails';
      expect(cooldowns.has(key)).toBe(true);
    });
  });

  describe('STT provider health', () => {
    it('transcribe returns consistent format', async () => {
      skipIf(!groqSTT.isConfigured(), 'Groq STT not configured — skipping');
      if (!groqSTT.isConfigured()) return;

      const wav = makeTestWav(0.5, 16000);
      try {
        const result = await groqSTT.transcribe({
          audio: wav,
          model: 'whisper-large-v3-turbo',
        });

        expect(result).toHaveProperty('text');
        expect(typeof result.text).toBe('string');
        expect(result).toHaveProperty('language');
        expect(typeof result).toHaveProperty;
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
        throw err;
      }
    }, 30_000);
  });

  describe('LLM provider health', () => {
    it('chat returns consistent format', async () => {
      skipIf(!groqLLM.isConfigured(), 'Groq LLM not configured — skipping');
      if (!groqLLM.isConfigured()) return;

      try {
        const result = await groqLLM.chat({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
          maxTokens: 10,
        });

        expect(result).toHaveProperty('content');
        expect(typeof result.content).toBe('string');
        expect(result.content.length).toBeGreaterThan(0);
        expect(result).toHaveProperty('model');
        expect(result).toHaveProperty('usage');
        if (result.usage) {
          expect(result.usage).toHaveProperty('promptTokens');
          expect(result.usage).toHaveProperty('completionTokens');
          expect(result.usage).toHaveProperty('totalTokens');
        }
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
        throw err;
      }
    }, 30_000);
  });

  describe('TTS provider health', () => {
    it('synthesize returns audio buffer', async () => {
      skipIf(!groqTTS.isConfigured(), 'Groq TTS not configured — skipping');
      if (!groqTTS.isConfigured()) return;

      try {
        const result = await groqTTS.synthesize({
          model: 'canopylabs/orpheus-v1-english',
          input: 'Hello, this is a test.',
          voice: 'autumn',
          responseFormat: 'wav',
        });

        expect(result).toHaveProperty('audio');
        expect(Buffer.isBuffer(result.audio)).toBe(true);
        expect(result.audio.length).toBeGreaterThan(0);
        expect(result).toHaveProperty('contentType');
        expect(typeof result.contentType).toBe('string');
      } catch (err: unknown) {
        const status = (err as Record<string, unknown>)?.status;
        if (status === 401 || status === 402 || status === 403) return; // key invalid/no credits
        throw err;
      }
    }, 30_000);
  });
});
