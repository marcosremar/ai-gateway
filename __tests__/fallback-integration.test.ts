/**
 * Provider Fallback — Integration Tests (Real APIs)
 *
 * Tests the fallback chain with real providers: if primary fails,
 * secondary should pick up. Also tests cooldown and timeout behavior.
 * Requires: At least 2 of GROQ_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  withProviderFallback,
  CooldownTracker,
  type FallbackEntry,
} from '../src/providers/fallback';
import { groqLLM } from '../src/providers/groq';
import { openrouterLLM } from '../src/providers/openrouter';
import { fireworksLLM } from '../src/providers/fireworks';
import { OpenAICompatLLMProvider } from '../src/providers/openai-compat/openai-compat-llm';
import { loadEnv, timed } from './helpers';

beforeAll(() => loadEnv());

function getAvailableProviders(): Array<{ id: string; llm: OpenAICompatLLMProvider; model: string }> {
  const providers: Array<{ id: string; llm: OpenAICompatLLMProvider; model: string }> = [];

  if (process.env.GROQ_API_KEY) {
    providers.push({ id: 'groq', llm: groqLLM, model: 'llama-3.3-70b-versatile' });
  }
  // Skip OpenAI — key may be deactivated. Use OpenRouter as OpenAI proxy instead.
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({ id: 'openrouter', llm: openrouterLLM, model: 'openai/gpt-4o-mini' });
  }
  if (process.env.FIREWORKS_API_KEY) {
    providers.push({ id: 'fireworks', llm: fireworksLLM, model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' });
  }

  return providers;
}

describe('Provider Fallback Chain (Real APIs)', () => {
  it('succeeds on first provider', async () => {
    const providers = getAvailableProviders();
    if (providers.length === 0) return;

    const chain: FallbackEntry[] = providers.map((p) => ({
      provider: p.id,
      model: p.model,
    }));

    const providerMap = Object.fromEntries(providers.map((p) => [p.id, p.llm]));

    const { result, ms } = await timed(() =>
      withProviderFallback(
        chain,
        async (entry) => {
          const llm = providerMap[entry.provider];
          return llm.chat({
            messages: [
              { role: 'system', content: 'Reply in one word.' },
              { role: 'user', content: 'Capital of Germany?' },
            ],
            model: entry.model!,
            temperature: 0,
            maxTokens: 10,
          });
        },
        { logPrefix: '[Test Fallback]', cooldownTracker: new CooldownTracker() },
      ),
    );

    expect(result.result.content.toLowerCase()).toContain('berlin');
    expect(result.usedProvider).toBe(providers[0].id);
    expect(result.attempts).toBe(1);
    console.log(`  Fallback: used ${result.usedProvider} → "${result.result.content}" (${ms}ms)`);
  });

  it('falls back to second provider on invalid key', async () => {
    const providers = getAvailableProviders();
    if (providers.length < 1) return;

    const working = providers[0];

    // First entry: fake provider with bad key that will 401
    const fakeProvider = groqLLM.withApiKey('invalid-key-12345') as OpenAICompatLLMProvider;

    const providerMap: Record<string, OpenAICompatLLMProvider> = {
      fake: fakeProvider,
      [working.id]: working.llm,
    };

    const chain: FallbackEntry[] = [
      { provider: 'fake', model: 'llama-3.3-70b-versatile' },
      { provider: working.id, model: working.model },
    ];

    const { result, ms } = await timed(() =>
      withProviderFallback(
        chain,
        async (entry) => {
          const llm = providerMap[entry.provider];
          return llm.chat({
            messages: [{ role: 'user', content: 'Say hello.' }],
            model: entry.model!,
            maxTokens: 5,
          });
        },
        { logPrefix: '[Test Fallback 401]', cooldownTracker: new CooldownTracker() },
      ),
    );

    expect(result.usedProvider).toBe(working.id);
    expect(result.attempts).toBe(2);
    console.log(`  Fallback after 401: fell to ${result.usedProvider} (${ms}ms)`);
  });

  it('respects timeout and falls back', async () => {
    const providers = getAvailableProviders();
    if (providers.length < 2) return;

    // Use only providers with valid keys (skip deactivated ones)
    const workingProviders = providers.filter((p) => {
      try {
        return p.llm.isConfigured();
      } catch { return false; }
    });
    if (workingProviders.length < 2) return;

    const chain: FallbackEntry[] = workingProviders.map((p) => ({
      provider: p.id,
      model: p.model,
    }));

    const providerMap = Object.fromEntries(workingProviders.map((p) => [p.id, p.llm]));

    const { result } = await timed(() =>
      withProviderFallback(
        chain,
        async (entry, attempt) => {
          if (attempt === 0) {
            // Simulate slow first provider
            await new Promise((r) => setTimeout(r, 5000));
          }
          const llm = providerMap[entry.provider];
          return llm.chat({
            messages: [{ role: 'user', content: 'Say ok.' }],
            model: entry.model!,
            maxTokens: 5,
          });
        },
        {
          logPrefix: '[Test Timeout]',
          timeoutMs: 3000, // 3s — enough for real API cold start, but first entry waits 5s
          cooldownTracker: new CooldownTracker(),
        },
      ),
    );

    // Should have used second provider due to timeout
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.result.content).toBeTruthy();
  });
});

describe('CooldownTracker', () => {
  it('tracks failures and enters cooldown', () => {
    const tracker = new CooldownTracker();
    const entry: FallbackEntry = { provider: 'test', model: 'model-1' };

    expect(tracker.isCoolingDown(entry)).toBe(false);

    tracker.recordFailure(entry, 2, 1000);
    expect(tracker.isCoolingDown(entry)).toBe(false);

    tracker.recordFailure(entry, 2, 1000);
    expect(tracker.isCoolingDown(entry)).toBe(true);
  });

  it('clears on success', () => {
    const tracker = new CooldownTracker();
    const entry: FallbackEntry = { provider: 'test', model: 'x' };

    tracker.recordFailure(entry, 1, 60000);
    expect(tracker.isCoolingDown(entry)).toBe(true);

    tracker.recordSuccess(entry);
    expect(tracker.isCoolingDown(entry)).toBe(false);
  });
});
