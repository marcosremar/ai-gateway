import { describe, it, expect } from 'vitest';
import {
  selectPercentageRoute,
  selectRandomRoute,
  buildPercentageRoutes,
} from '../../src/providers/percentage-routing';

describe('selectPercentageRoute', () => {
  it('empty routes → null', () => {
    const result = selectPercentageRoute({ routes: [], hashKey: 'test' });
    expect(result).toBeNull();
  });

  it('single route 100% → always returns that route', () => {
    const route = { provider: 'groq', percentage: 100 };
    for (let i = 0; i < 50; i++) {
      const result = selectPercentageRoute({ routes: [route], hashKey: `key-${i}` });
      expect(result).toEqual(route);
    }
  });

  it('deterministic: same hashKey → same route', () => {
    const routes = [
      { provider: 'groq', percentage: 50 },
      { provider: 'openai', percentage: 50 },
    ];
    const first = selectPercentageRoute({ routes, hashKey: 'user-123' });
    for (let i = 0; i < 10; i++) {
      const result = selectPercentageRoute({ routes, hashKey: 'user-123' });
      expect(result).toEqual(first);
    }
  });

  it('different hashKey → potentially different route', () => {
    const routes = [
      { provider: 'groq', percentage: 50 },
      { provider: 'openai', percentage: 50 },
    ];
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const result = selectPercentageRoute({ routes, hashKey: `key-${i}` });
      results.add(result!.provider);
    }
    expect(results.size).toBeGreaterThan(1);
  });

  it('with seed parameter → different seed = different result', () => {
    const routes = [
      { provider: 'groq', percentage: 50 },
      { provider: 'openai', percentage: 50 },
    ];
    const result1 = selectPercentageRoute({ routes, hashKey: 'user-1', seed: 'seed-a' });
    const result2 = selectPercentageRoute({ routes, hashKey: 'user-1', seed: 'seed-b' });
    expect(result1).not.toEqual(result2);
  });

  it('80/20 split — distribution is roughly 80/20 within 15%', () => {
    const routes = [
      { provider: 'groq', percentage: 80 },
      { provider: 'openai', percentage: 20 },
    ];
    let groqCount = 0;
    let openaiCount = 0;
    const total = 100;

    for (let i = 0; i < total; i++) {
      const result = selectPercentageRoute({ routes, hashKey: `user-${i}` });
      if (result!.provider === 'groq') groqCount++;
      else openaiCount++;
    }

    const groqPercent = (groqCount / total) * 100;
    expect(groqPercent).toBeGreaterThanOrEqual(65);
    expect(groqPercent).toBeLessThanOrEqual(95);
  });
});

describe('selectRandomRoute', () => {
  it('with 50/50 — both routes selected over 1000 runs', () => {
    const routes = [
      { provider: 'groq', percentage: 50 },
      { provider: 'openai', percentage: 50 },
    ];
    const providers = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const result = selectRandomRoute(routes);
      providers.add(result!.provider);
    }
    expect(providers.has('groq')).toBe(true);
    expect(providers.has('openai')).toBe(true);
  });

  it('with empty routes → null', () => {
    const result = selectRandomRoute([]);
    expect(result).toBeNull();
  });
});

describe('buildPercentageRoutes', () => {
  it('maps config to routes', () => {
    const config = [
      { provider: 'groq', model: 'llama-3.3-70b', weight: 70 },
      { provider: 'openai', model: 'gpt-4', weight: 30 },
    ];
    const routes = buildPercentageRoutes(config);
    expect(routes).toEqual([
      { provider: 'groq', model: 'llama-3.3-70b', percentage: 70 },
      { provider: 'openai', model: 'gpt-4', percentage: 30 },
    ]);
  });

  it('handles config without model', () => {
    const config = [{ provider: 'groq', weight: 100 }];
    const routes = buildPercentageRoutes(config);
    expect(routes).toEqual([{ provider: 'groq', model: undefined, percentage: 100 }]);
  });
});
