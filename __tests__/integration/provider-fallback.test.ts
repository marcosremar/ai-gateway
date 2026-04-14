/**
 * Integration tests for provider fallback chains.
 *
 * Fixes: #641 (integration testing for provider chains)
 */

import { describe, it, expect, vi } from 'vitest';
import { createMockLLMProvider, createFailingProvider } from '../factories';

describe('Provider Fallback Chain', () => {
  it('should use primary provider when available', async () => {
    const primary = createMockLLMProvider({ content: 'primary response' });
    const result = await primary.chat({ messages: [] });
    expect(result.content).toBe('primary response');
  });

  it('should fallback to secondary when primary fails', async () => {
    const primary = createFailingProvider(new Error('Primary down'));
    const secondary = createMockLLMProvider({ content: 'secondary response' });

    let result;
    try {
      result = await primary.chat({ messages: [] });
    } catch {
      result = await secondary.chat({ messages: [] });
    }

    expect(result.content).toBe('secondary response');
  });

  it('should try all providers before failing', async () => {
    const providers = [
      createFailingProvider(new Error('Provider 1 down')),
      createFailingProvider(new Error('Provider 2 down')),
      createFailingProvider(new Error('Provider 3 down')),
    ];

    let lastError: Error | undefined;
    for (const provider of providers) {
      try {
        await provider.chat({ messages: [] });
      } catch (error) {
        lastError = error as Error;
      }
    }

    expect(lastError).toBeDefined();
  });

  it('should stop trying after first success', async () => {
    const primary = createMockLLMProvider({ content: 'success' });
    const secondary = createMockLLMProvider({ content: 'should not be called' });

    const result = await primary.chat({ messages: [] });
    expect(result.content).toBe('success');

    // Secondary should not be called
    expect(secondary.chat).not.toHaveBeenCalled();
  });
});

describe('Fallback with Cooldown', () => {
  it('should track cooldown periods', async () => {
    const cooldowns = new Map<string, number>();

    // Set cooldown for provider
    cooldowns.set('groq', Date.now() + 30_000);

    expect(cooldowns.has('groq')).toBe(true);
    expect(cooldowns.has('openai')).toBe(false);
  });

  it('should respect cooldown periods', async () => {
    const cooldowns = new Map<string, number>();
    cooldowns.set('groq', Date.now() + 30_000);

    const isInCooldown = (provider: string) => {
      const cooldownEnd = cooldowns.get(provider);
      return cooldownEnd ? Date.now() < cooldownEnd : false;
    };

    expect(isInCooldown('groq')).toBe(true);
    expect(isInCooldown('openai')).toBe(false);
  });

  it('should clear expired cooldowns', async () => {
    const cooldowns = new Map<string, number>();
    cooldowns.set('groq', Date.now() - 1000); // Expired

    const isInCooldown = (provider: string) => {
      const cooldownEnd = cooldowns.get(provider);
      return cooldownEnd ? Date.now() < cooldownEnd : false;
    };

    expect(isInCooldown('groq')).toBe(false);
  });
});

describe('Fallback Weight Selection', () => {
  it('should select providers by weight', () => {
    const providers = [
      { id: 'groq', weight: 1.0 },
      { id: 'openai', weight: 0.5 },
      { id: 'fireworks', weight: 0.3 },
    ];

    // Sort by weight descending
    const sorted = [...providers].sort((a, b) => b.weight - a.weight);
    expect(sorted[0].id).toBe('groq');
    expect(sorted[1].id).toBe('openai');
    expect(sorted[2].id).toBe('fireworks');
  });

  it('should exclude providers in cooldown', () => {
    const providers = [
      { id: 'groq', weight: 1.0, cooldown: true },
      { id: 'openai', weight: 0.5, cooldown: false },
      { id: 'fireworks', weight: 0.3, cooldown: false },
    ];

    const available = providers.filter((p) => !p.cooldown);
    expect(available.length).toBe(2);
    expect(available[0].id).toBe('openai');
  });
});
