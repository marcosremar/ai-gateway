/**
 * Tests for tracking/budget-guard.ts
 * - Under threshold: chain unchanged, downgraded=false
 * - Between degrade and block threshold: chain models swapped, downgraded=true
 * - Over block threshold: BudgetExceededError thrown
 * - Unknown models in chain: pass through unchanged
 * - No dailyLimit: chain unchanged (no enforcement)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetGuard, BudgetExceededError } from '../src/tracking/budget-guard';
import type { SpendTracker } from '../src/tracking/spend-tracker';
import type { SpendSummary } from '../src/tracking/spend-tracker';
import type { FallbackEntry } from '../src/providers/fallback';

// ── Mock SpendTracker ────────────────────────────────────────────────────────

function makeSpendTracker(totalCostUsd: number): SpendTracker {
  return {
    getDailySummary: async (): Promise<SpendSummary> => ({
      date: new Date().toISOString().slice(0, 10),
      totalCostUsd,
      requestCount: 10,
      byProvider: {},
      byStage: {},
    }),
    // Unused in budget-guard but required by interface shape
    record: async () => {},
    estimateCost: () => 0,
    checkBudget: async () => ({ over: false, pct: 0, limitUsd: 0, currentUsd: 0 }),
  } as unknown as SpendTracker;
}

function makeChain(...models: [string, string][]): FallbackEntry[] {
  return models.map(([provider, model]) => ({ provider, model }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BudgetGuard', () => {
  describe('under degradeThreshold', () => {
    it('passes chain through unchanged', async () => {
      const guard = new BudgetGuard(makeSpendTracker(2.0)); // 20% of $10
      const chain = makeChain(['openai', 'gpt-4o'], ['groq', 'llama-3.3-70b-versatile']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(result.chain).toEqual(chain);
    });

    it('does not modify chain at 0% spend', async () => {
      const guard = new BudgetGuard(makeSpendTracker(0));
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 100);

      expect(result.downgraded).toBe(false);
      expect(result.chain).toEqual(chain);
    });

    it('does not modify chain at exactly degradeThreshold - epsilon', async () => {
      const guard = new BudgetGuard(makeSpendTracker(7.99)); // 79.9% of $10
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(false);
    });
  });

  describe('between degrade and block threshold', () => {
    it('swaps known expensive models to cheaper alternatives', async () => {
      const guard = new BudgetGuard(makeSpendTracker(8.5)); // 85% of $10
      const chain = makeChain(['openai', 'gpt-4o'], ['groq', 'llama-3.3-70b-versatile']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(true);
      expect(result.reason).toContain('85%');
      expect(result.reason).toContain('downgraded');
      expect(result.chain[0]).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
      expect(result.chain[1]).toEqual({ provider: 'groq', model: 'llama-3.1-8b-instant' });
    });

    it('downgrades at exactly degradeThreshold', async () => {
      const guard = new BudgetGuard(makeSpendTracker(8.0)); // exactly 80% of $10
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'stt', 10);

      expect(result.downgraded).toBe(true);
      expect(result.chain[0].model).toBe('gpt-4o-mini');
    });

    it('preserves provider when downgrading model', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0));
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.chain[0].provider).toBe('openai');
      expect(result.chain[0].model).toBe('gpt-4o-mini');
    });

    it('does not downgrade models that map to themselves (already cheapest)', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0));
      // whisper-large-v3-turbo maps to itself
      const chain = makeChain(['groq', 'whisper-large-v3-turbo']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'stt', 10);

      // Model maps to itself → no actual swap
      expect(result.downgraded).toBe(false);
      expect(result.chain[0].model).toBe('whisper-large-v3-turbo');
    });

    it('handles mixed chain with some downgradeable and some not', async () => {
      const guard = new BudgetGuard(makeSpendTracker(8.5));
      const chain = makeChain(
        ['openai', 'gpt-4o'],              // will be downgraded
        ['groq', 'whisper-large-v3-turbo'], // already cheapest (maps to itself)
      );

      const result = await guard.checkAndDowngrade('user-1', chain, 'pipeline', 10);

      expect(result.downgraded).toBe(true);
      expect(result.chain[0].model).toBe('gpt-4o-mini');
      expect(result.chain[1].model).toBe('whisper-large-v3-turbo');
    });

    it('includes stage in reason string', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0));
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'tts', 10);

      expect(result.reason).toContain('[tts]');
    });
  });

  describe('over blockThreshold', () => {
    it('throws BudgetExceededError when at 100%', async () => {
      const guard = new BudgetGuard(makeSpendTracker(10.0));
      const chain = makeChain(['openai', 'gpt-4o']);

      await expect(
        guard.checkAndDowngrade('user-1', chain, 'llm', 10),
      ).rejects.toThrow(BudgetExceededError);
    });

    it('throws BudgetExceededError when over 100%', async () => {
      const guard = new BudgetGuard(makeSpendTracker(15.0));
      const chain = makeChain(['openai', 'gpt-4o']);

      await expect(
        guard.checkAndDowngrade('user-1', chain, 'llm', 10),
      ).rejects.toThrow(BudgetExceededError);
    });

    it('error contains current and limit amounts', async () => {
      const guard = new BudgetGuard(makeSpendTracker(12.5));
      const chain = makeChain(['openai', 'gpt-4o']);

      try {
        await guard.checkAndDowngrade('user-1', chain, 'llm', 10);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        const budgetErr = err as BudgetExceededError;
        expect(budgetErr.currentUsd).toBeCloseTo(12.5);
        expect(budgetErr.limitUsd).toBe(10);
        expect(budgetErr.status).toBe(429);
        expect(budgetErr.message).toContain('12.5000');
        expect(budgetErr.message).toContain('10.00');
      }
    });

    it('respects custom blockThreshold', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0), { blockThreshold: 0.9 });
      const chain = makeChain(['openai', 'gpt-4o']);

      // 90% of $10 = $9 → at block threshold
      await expect(
        guard.checkAndDowngrade('user-1', chain, 'llm', 10),
      ).rejects.toThrow(BudgetExceededError);
    });
  });

  describe('unknown models in chain', () => {
    it('passes unknown models through unchanged when under threshold', async () => {
      const guard = new BudgetGuard(makeSpendTracker(2.0));
      const chain = makeChain(['custom', 'my-custom-model']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(false);
      expect(result.chain[0]).toEqual({ provider: 'custom', model: 'my-custom-model' });
    });

    it('passes unknown models through unchanged when in degrade zone', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0));
      const chain = makeChain(['custom', 'my-custom-model']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      // No known downgrade → chain unchanged, downgraded=false
      expect(result.downgraded).toBe(false);
      expect(result.chain[0].model).toBe('my-custom-model');
    });

    it('entries without model field pass through unchanged', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0));
      const chain: FallbackEntry[] = [{ provider: 'gpu' }];

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(false);
      expect(result.chain[0]).toEqual({ provider: 'gpu' });
    });
  });

  describe('no dailyLimit (no enforcement)', () => {
    it('returns chain unchanged when dailyLimitUsd is 0', async () => {
      const guard = new BudgetGuard(makeSpendTracker(999));
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 0);

      expect(result.downgraded).toBe(false);
      expect(result.chain).toEqual(chain);
    });

    it('returns chain unchanged when dailyLimitUsd is negative', async () => {
      const guard = new BudgetGuard(makeSpendTracker(999));
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', -5);

      expect(result.downgraded).toBe(false);
      expect(result.chain).toEqual(chain);
    });
  });

  describe('custom config', () => {
    it('uses custom degradeThreshold', async () => {
      const guard = new BudgetGuard(makeSpendTracker(5.0), { degradeThreshold: 0.5 });
      const chain = makeChain(['openai', 'gpt-4o']);

      // 50% of $10 → at degrade threshold
      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(true);
      expect(result.chain[0].model).toBe('gpt-4o-mini');
    });

    it('uses custom downgrades map', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0), {
        downgrades: { 'my-expensive-model': 'my-cheap-model' },
      });
      const chain = makeChain(['custom', 'my-expensive-model']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(true);
      expect(result.chain[0].model).toBe('my-cheap-model');
    });

    it('custom downgrades override defaults', async () => {
      const guard = new BudgetGuard(makeSpendTracker(9.0), {
        downgrades: { 'gpt-4o': 'gpt-3.5-turbo' }, // override default gpt-4o → gpt-4o-mini
      });
      const chain = makeChain(['openai', 'gpt-4o']);

      const result = await guard.checkAndDowngrade('user-1', chain, 'llm', 10);

      expect(result.downgraded).toBe(true);
      expect(result.chain[0].model).toBe('gpt-3.5-turbo');
    });
  });

  describe('BudgetExceededError', () => {
    it('has correct name and properties', () => {
      const err = new BudgetExceededError(15.5, 10);
      expect(err.name).toBe('BudgetExceededError');
      expect(err.status).toBe(429);
      expect(err.currentUsd).toBeCloseTo(15.5);
      expect(err.limitUsd).toBe(10);
      expect(err instanceof Error).toBe(true);
    });
  });
});
