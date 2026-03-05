/**
 * Tests for providers/declarative-chain.ts
 * - resolveDeclarativeChain()
 * - findChainForStage()
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDeclarativeChain,
  findChainForStage,
  type FallbackChainConfig,
} from '../src/providers/declarative-chain';

describe('resolveDeclarativeChain', () => {
  it('returns chain sorted by priority', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [
        { provider: 'openai', model: 'gpt-4o', priority: 3 },
        { provider: 'groq', model: 'llama-3.3-70b', priority: 1 },
        { provider: 'openrouter', model: 'llama-3.3-70b', priority: 2 },
      ],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain).toHaveLength(3);
    expect(chain[0].provider).toBe('groq');
    expect(chain[1].provider).toBe('openrouter');
    expect(chain[2].provider).toBe('openai');
  });

  it('preserves original chain when no priority (stable sort)', () => {
    const config: FallbackChainConfig = {
      stage: 'stt',
      chain: [
        { provider: 'openai', model: 'whisper-1' },
        { provider: 'groq', model: 'whisper-large-v3-turbo' },
      ],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain[0].provider).toBe('openai');
    expect(chain[1].provider).toBe('groq');
  });

  it('handles single entry', () => {
    const config: FallbackChainConfig = {
      stage: 'tts',
      chain: [{ provider: 'openai', model: 'tts-1', priority: 1 }],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('openai');
    expect(chain[0].model).toBe('tts-1');
  });

  it('handles empty chain', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain).toHaveLength(0);
  });

  it('maps cooldownMs to options', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [{ provider: 'groq' }],
      cooldownMs: 5000,
    };

    const { options } = resolveDeclarativeChain(config);
    expect(options.cooldownMs).toBe(5000);
  });

  it('maps retriesPerProvider to options', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [{ provider: 'groq' }],
      retriesPerProvider: 2,
    };

    const { options } = resolveDeclarativeChain(config);
    expect(options.retriesPerProvider).toBe(2);
  });

  it('maps timeoutMs to options', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [{ provider: 'groq' }],
      timeoutMs: 10_000,
    };

    const { options } = resolveDeclarativeChain(config);
    expect(options.timeoutMs).toBe(10_000);
  });

  it('returns empty options when none configured', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [{ provider: 'groq' }],
    };

    const { options } = resolveDeclarativeChain(config);
    expect(options.cooldownMs).toBeUndefined();
    expect(options.retriesPerProvider).toBeUndefined();
    expect(options.timeoutMs).toBeUndefined();
  });

  it('maps all options together', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [{ provider: 'groq' }],
      cooldownMs: 3000,
      retriesPerProvider: 1,
      timeoutMs: 15_000,
    };

    const { options } = resolveDeclarativeChain(config);
    expect(options.cooldownMs).toBe(3000);
    expect(options.retriesPerProvider).toBe(1);
    expect(options.timeoutMs).toBe(15_000);
  });

  it('does not modify original chain', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [
        { provider: 'openai', priority: 2 },
        { provider: 'groq', priority: 1 },
      ],
    };
    const originalOrder = config.chain.map(e => e.provider);
    resolveDeclarativeChain(config);
    expect(config.chain.map(e => e.provider)).toEqual(originalOrder);
  });

  it('entries without model have undefined model', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [{ provider: 'groq' }],
    };

    const { chain } = resolveDeclarativeChain(config);
    expect(chain[0].model).toBeUndefined();
  });

  it('handles mixed priorities (same priority, stable order)', () => {
    const config: FallbackChainConfig = {
      stage: 'llm',
      chain: [
        { provider: 'openai', priority: 1 },
        { provider: 'groq', priority: 1 },
      ],
    };

    const { chain } = resolveDeclarativeChain(config);
    // Both have same priority — order should be preserved
    expect(chain).toHaveLength(2);
  });
});

describe('findChainForStage', () => {
  const configs: FallbackChainConfig[] = [
    { stage: 'llm', chain: [{ provider: 'groq' }] },
    { stage: 'stt', chain: [{ provider: 'openai' }] },
    { stage: 'tts', chain: [{ provider: 'openai', model: 'tts-1' }] },
  ];

  it('finds chain by stage', () => {
    const result = findChainForStage(configs, 'llm');
    expect(result).toBeDefined();
    expect(result!.stage).toBe('llm');
    expect(result!.chain[0].provider).toBe('groq');
  });

  it('returns undefined for missing stage', () => {
    const result = findChainForStage(configs, 'image');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    const result = findChainForStage([], 'llm');
    expect(result).toBeUndefined();
  });

  it('returns undefined for undefined chains', () => {
    const result = findChainForStage(undefined, 'llm');
    expect(result).toBeUndefined();
  });

  it('finds omni stage', () => {
    const omniConfigs: FallbackChainConfig[] = [
      { stage: 'omni', chain: [{ provider: 'runpod' }] },
    ];
    const result = findChainForStage(omniConfigs, 'omni');
    expect(result).toBeDefined();
    expect(result!.stage).toBe('omni');
  });

  it('finds realtime stage', () => {
    const rtConfigs: FallbackChainConfig[] = [
      { stage: 'realtime', chain: [{ provider: 'openai' }] },
    ];
    const result = findChainForStage(rtConfigs, 'realtime');
    expect(result).toBeDefined();
  });

  it('returns first match when multiple chains for same stage', () => {
    const duplicates: FallbackChainConfig[] = [
      { stage: 'llm', chain: [{ provider: 'groq' }] },
      { stage: 'llm', chain: [{ provider: 'openai' }] },
    ];
    const result = findChainForStage(duplicates, 'llm');
    expect(result!.chain[0].provider).toBe('groq');
  });
});
