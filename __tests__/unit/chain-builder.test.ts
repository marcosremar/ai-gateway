// ── chain-builder & declarative-chain — unit suite ───────────────────────────
// Covers:
//   • buildFallbackChain — null settings, profiles, pipelineStages, activeProvider fallback
//   • getSystemLlmEntryFromSettings — systemLlm override, chain fallback
//   • getSystemSttEntryFromSettings — systemStt override, chain fallback
//   • resolveApiKey — vault hit, vault miss → env, unknown provider
//   • resolveDeclarativeChain — priority sort, options mapping, endpoint passthrough
//   • findChainForStage — hit, miss, empty array, undefined

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildFallbackChain,
  getSystemLlmEntryFromSettings,
  getSystemSttEntryFromSettings,
  resolveApiKey,
  type UserProviderSettings,
  type SavedProfile,
} from '../../src/providers/chain-builder';
import {
  resolveDeclarativeChain,
  findChainForStage,
  type FallbackChainConfig,
} from '../../src/providers/declarative-chain';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<UserProviderSettings> = {}): UserProviderSettings {
  return {
    activeProvider: 'openai',
    keys: {},
    ...overrides,
  };
}

function pipelineProfile(
  stage: 'stt' | 'llm' | 'tts' | 'image',
  provider: string,
  model: string,
): SavedProfile {
  return {
    pipelineMode: 'pipeline',
    [stage]: { provider, model },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// buildFallbackChain
// ══════════════════════════════════════════════════════════════════════════════

describe('buildFallbackChain', () => {
  // ── Null / empty settings ──────────────────────────────────────────────────

  describe('null settings', () => {
    it('falls back to openai when settings is null', () => {
      const chain = buildFallbackChain(null, 'llm');
      expect(chain).toHaveLength(1);
      expect(chain[0].provider).toBe('openai');
    });

    it('returns undefined model when falling back to openai', () => {
      const chain = buildFallbackChain(null, 'stt');
      expect(chain[0].model).toBeUndefined();
    });

    it('falls back to openai for tts stage', () => {
      const chain = buildFallbackChain(null, 'tts');
      expect(chain[0].provider).toBe('openai');
    });

    it('falls back to openai for image stage', () => {
      const chain = buildFallbackChain(null, 'image');
      expect(chain[0].provider).toBe('openai');
    });
  });

  // ── activeProvider fallback ────────────────────────────────────────────────

  describe('activeProvider fallback', () => {
    it('uses groq as fallback when it is the active provider', () => {
      const settings = makeSettings({ activeProvider: 'groq' });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('groq');
    });

    it('uses openrouter as fallback when it is the active provider', () => {
      const settings = makeSettings({ activeProvider: 'openrouter' });
      const chain = buildFallbackChain(settings, 'stt');
      expect(chain[0].provider).toBe('openrouter');
    });

    it('falls back to openai when active provider is a GPU provider (not cloud)', () => {
      const settings = makeSettings({ activeProvider: 'gpu' as any });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('openai');
    });

    it('uses vast-serverless as fallback when it is the active provider', () => {
      const settings = makeSettings({ activeProvider: 'vast-serverless' as any });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('vast-serverless');
    });
  });

  // ── Profiles ──────────────────────────────────────────────────────────────

  describe('profiles', () => {
    it('picks provider from matching pipeline profile', () => {
      const settings = makeSettings({
        profiles: [pipelineProfile('llm', 'groq', 'llama-3.3-70b')],
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0]).toEqual({ provider: 'groq', model: 'llama-3.3-70b' });
    });

    it('skips omni profiles', () => {
      const settings = makeSettings({
        profiles: [{ pipelineMode: 'omni', llm: { provider: 'groq', model: 'llama' } }],
      });
      const chain = buildFallbackChain(settings, 'llm');
      // omni profile should be skipped → falls back to activeProvider
      expect(chain[0].provider).toBe('openai');
    });

    it('skips profile entries whose stage does not match', () => {
      const settings = makeSettings({
        profiles: [pipelineProfile('stt', 'groq', 'whisper-large-v3')],
      });
      // asking for 'llm' — stt profile entry should be ignored
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('openai');
    });

    it('deduplicates identical provider+model pairs across profiles', () => {
      const settings = makeSettings({
        profiles: [
          pipelineProfile('llm', 'groq', 'llama-3.3-70b'),
          pipelineProfile('llm', 'groq', 'llama-3.3-70b'),
        ],
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain).toHaveLength(1);
    });

    it('keeps distinct provider+model combinations from multiple profiles', () => {
      const settings = makeSettings({
        profiles: [
          pipelineProfile('llm', 'groq', 'llama-3.3-70b'),
          pipelineProfile('llm', 'openai', 'gpt-4o'),
        ],
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain).toHaveLength(2);
      expect(chain[0].provider).toBe('groq');
      expect(chain[1].provider).toBe('openai');
    });

    it('excludes GPU-backed providers (runpod) from chain', () => {
      const settings = makeSettings({
        profiles: [pipelineProfile('llm', 'runpod', 'llama')],
      });
      const chain = buildFallbackChain(settings, 'llm');
      // runpod is not cloud/local/vast-serverless → excluded → falls back to openai
      expect(chain[0].provider).toBe('openai');
    });

    it('allows ollama (local) in chain', () => {
      const settings = makeSettings({
        profiles: [pipelineProfile('llm', 'ollama', 'llama3')],
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('ollama');
    });

    it('allows vast-serverless in chain', () => {
      const settings = makeSettings({
        profiles: [pipelineProfile('llm', 'vast-serverless', 'llama-70b')],
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('vast-serverless');
    });

    it('skips profile entry that has no provider for the stage', () => {
      const settings = makeSettings({
        profiles: [{ pipelineMode: 'pipeline' }], // no stage config at all
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0].provider).toBe('openai');
    });
  });

  // ── pipelineStages fallback ───────────────────────────────────────────────

  describe('pipelineStages', () => {
    it('uses pipelineStages when no matching profile exists', () => {
      const settings = makeSettings({
        pipelineStages: { llm: { provider: 'fireworks', model: 'llama-v3-70b' } },
      });
      const chain = buildFallbackChain(settings, 'llm');
      expect(chain[0]).toEqual({ provider: 'fireworks', model: 'llama-v3-70b' });
    });

    it('ignores pipelineStages when profiles already contributed entries', () => {
      const settings = makeSettings({
        profiles: [pipelineProfile('llm', 'groq', 'llama-3.3-70b')],
        pipelineStages: { llm: { provider: 'openai', model: 'gpt-4o' } },
      });
      const chain = buildFallbackChain(settings, 'llm');
      // profiles take priority
      expect(chain).toHaveLength(1);
      expect(chain[0].provider).toBe('groq');
    });

    it('falls through to activeProvider when pipelineStages stage is absent', () => {
      const settings = makeSettings({
        pipelineStages: { stt: { provider: 'groq', model: 'whisper-large-v3' } },
      });
      const chain = buildFallbackChain(settings, 'llm'); // asking for llm, only stt configured
      expect(chain[0].provider).toBe('openai');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getSystemLlmEntryFromSettings
// ══════════════════════════════════════════════════════════════════════════════

describe('getSystemLlmEntryFromSettings', () => {
  it('returns systemLlm override when it is a cloud provider', () => {
    const settings = makeSettings({
      systemLlm: { provider: 'openrouter', model: 'gpt-4o' },
    });
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry).toEqual({ provider: 'openrouter', model: 'gpt-4o' });
  });

  it('returns systemLlm override for vast-serverless', () => {
    const settings = makeSettings({
      systemLlm: { provider: 'vast-serverless', model: 'custom-llm' },
    });
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry).toEqual({ provider: 'vast-serverless', model: 'custom-llm' });
  });

  it('ignores systemLlm when provider is a GPU-backed type', () => {
    const settings = makeSettings({
      systemLlm: { provider: 'runpod', model: 'llama' },
      profiles: [pipelineProfile('llm', 'groq', 'llama-3.3-70b')],
    });
    const entry = getSystemLlmEntryFromSettings(settings);
    // runpod is not cloud/vast-serverless → falls through to chain
    expect(entry.provider).toBe('groq');
  });

  it('falls back to buildFallbackChain when no systemLlm set', () => {
    const settings = makeSettings({
      profiles: [pipelineProfile('llm', 'fireworks', 'llama-v3-70b')],
    });
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry.provider).toBe('fireworks');
  });

  it('returns openai entry when settings is null', () => {
    const entry = getSystemLlmEntryFromSettings(null);
    expect(entry.provider).toBe('openai');
  });

  it('returns the first chain entry even when chain has multiple entries', () => {
    const settings = makeSettings({
      profiles: [
        pipelineProfile('llm', 'groq', 'llama-3.3-70b'),
        pipelineProfile('llm', 'openai', 'gpt-4o'),
      ],
    });
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry.provider).toBe('groq');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getSystemSttEntryFromSettings
// ══════════════════════════════════════════════════════════════════════════════

describe('getSystemSttEntryFromSettings', () => {
  it('returns systemStt override when it is a cloud provider', () => {
    const settings = makeSettings({
      systemStt: { provider: 'groq', model: 'whisper-large-v3' },
    });
    const entry = getSystemSttEntryFromSettings(settings);
    expect(entry).toEqual({ provider: 'groq', model: 'whisper-large-v3' });
  });

  it('returns systemStt override for vast-serverless', () => {
    const settings = makeSettings({
      systemStt: { provider: 'vast-serverless', model: 'whisper-custom' },
    });
    const entry = getSystemSttEntryFromSettings(settings);
    expect(entry).toEqual({ provider: 'vast-serverless', model: 'whisper-custom' });
  });

  it('ignores systemStt when provider is not cloud or vast-serverless', () => {
    const settings = makeSettings({
      systemStt: { provider: 'skypilot', model: 'whisper' },
      activeProvider: 'groq',
    });
    const entry = getSystemSttEntryFromSettings(settings);
    expect(entry.provider).toBe('groq');
  });

  it('falls back to buildFallbackChain when no systemStt set', () => {
    const settings = makeSettings({
      profiles: [pipelineProfile('stt', 'groq', 'whisper-large-v3-turbo')],
    });
    const entry = getSystemSttEntryFromSettings(settings);
    expect(entry.provider).toBe('groq');
  });

  it('returns openai entry when settings is null', () => {
    const entry = getSystemSttEntryFromSettings(null);
    expect(entry.provider).toBe('openai');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveApiKey
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveApiKey', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear relevant env vars
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns env var value when vault is not configured and env is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    const key = await resolveApiKey('openai');
    expect(key).toBe('sk-test-openai');
  });

  it('returns null when env var is not set and vault is absent', async () => {
    const key = await resolveApiKey('openai');
    expect(key).toBeNull();
  });

  it('returns null for unknown provider (not in PROVIDER_ENV_KEYS)', async () => {
    const key = await resolveApiKey('runpod' as any);
    expect(key).toBeNull();
  });

  it('returns empty string (truthy check) for ollama which has empty string key name', async () => {
    // ollama has envKey = '' which maps to null return (falsy key name)
    const key = await resolveApiKey('ollama');
    expect(key).toBeNull();
  });

  it('returns groq key from env when set', async () => {
    process.env.GROQ_API_KEY = 'gsk-test-groq';
    const key = await resolveApiKey('groq');
    expect(key).toBe('gsk-test-groq');
  });

  it('returns fireworks key from env when set', async () => {
    process.env.FIREWORKS_API_KEY = 'fw-test';
    const key = await resolveApiKey('fireworks');
    expect(key).toBe('fw-test');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveDeclarativeChain
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveDeclarativeChain', () => {
  // ── Priority sorting ───────────────────────────────────────────────────────

  describe('priority sorting', () => {
    it('sorts entries by priority ascending', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [
          { provider: 'openai', model: 'gpt-4o', priority: 3 },
          { provider: 'groq', model: 'llama-3.3-70b', priority: 1 },
          { provider: 'fireworks', model: 'llama-v3', priority: 2 },
        ],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain[0].provider).toBe('groq');
      expect(chain[1].provider).toBe('fireworks');
      expect(chain[2].provider).toBe('openai');
    });

    it('uses default priority 0 when priority is not specified', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [
          { provider: 'openai', model: 'gpt-4o', priority: 1 },
          { provider: 'groq', model: 'llama' }, // default priority 0
        ],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain[0].provider).toBe('groq');
      expect(chain[1].provider).toBe('openai');
    });

    it('preserves insertion order for equal priorities (stable sort)', () => {
      const config: FallbackChainConfig = {
        stage: 'stt',
        chain: [
          { provider: 'groq', priority: 1 },
          { provider: 'openai', priority: 1 },
        ],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain[0].provider).toBe('groq');
      expect(chain[1].provider).toBe('openai');
    });

    it('handles single entry without sorting', () => {
      const config: FallbackChainConfig = {
        stage: 'tts',
        chain: [{ provider: 'openai', model: 'tts-1', priority: 5 }],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain).toHaveLength(1);
      expect(chain[0].provider).toBe('openai');
    });

    it('handles empty chain', () => {
      const config: FallbackChainConfig = { stage: 'llm', chain: [] };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain).toHaveLength(0);
    });
  });

  // ── FallbackEntry mapping ──────────────────────────────────────────────────

  describe('FallbackEntry mapping', () => {
    it('maps provider and model to FallbackEntry', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [{ provider: 'groq', model: 'llama-3.3-70b' }],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain[0]).toEqual({ provider: 'groq', model: 'llama-3.3-70b' });
    });

    it('omits model when not provided', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [{ provider: 'groq' }],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain[0].model).toBeUndefined();
    });

    it('passes endpoint through when specified', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [{ provider: 'openai', endpoint: 'https://custom.example.com' }],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect(chain[0].endpoint).toBe('https://custom.example.com');
    });

    it('does not include endpoint key when not specified', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [{ provider: 'groq', model: 'llama' }],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect('endpoint' in chain[0]).toBe(false);
    });

    it('does not include priority in the output FallbackEntry', () => {
      const config: FallbackChainConfig = {
        stage: 'llm',
        chain: [{ provider: 'groq', priority: 1 }],
      };
      const { chain } = resolveDeclarativeChain(config);
      expect('priority' in chain[0]).toBe(false);
    });
  });

  // ── Options mapping ────────────────────────────────────────────────────────

  describe('options mapping', () => {
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
        retriesPerProvider: 3,
      };
      const { options } = resolveDeclarativeChain(config);
      expect(options.retriesPerProvider).toBe(3);
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

    it('omits options that are not set', () => {
      const config: FallbackChainConfig = { stage: 'llm', chain: [{ provider: 'groq' }] };
      const { options } = resolveDeclarativeChain(config);
      expect(options.cooldownMs).toBeUndefined();
      expect(options.retriesPerProvider).toBeUndefined();
      expect(options.timeoutMs).toBeUndefined();
    });

    it('maps all three options together', () => {
      const config: FallbackChainConfig = {
        stage: 'stt',
        chain: [{ provider: 'groq' }],
        cooldownMs: 3000,
        retriesPerProvider: 2,
        timeoutMs: 8000,
      };
      const { options } = resolveDeclarativeChain(config);
      expect(options).toEqual({ cooldownMs: 3000, retriesPerProvider: 2, timeoutMs: 8000 });
    });
  });

  // ── Does not mutate input ──────────────────────────────────────────────────

  describe('immutability', () => {
    it('does not mutate the original chain array', () => {
      const originalChain = [
        { provider: 'openai', priority: 2 },
        { provider: 'groq', priority: 1 },
      ];
      const config: FallbackChainConfig = { stage: 'llm', chain: originalChain };
      resolveDeclarativeChain(config);
      expect(originalChain[0].provider).toBe('openai');
      expect(originalChain[1].provider).toBe('groq');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// findChainForStage
// ══════════════════════════════════════════════════════════════════════════════

describe('findChainForStage', () => {
  const chains: FallbackChainConfig[] = [
    { stage: 'llm', chain: [{ provider: 'groq' }] },
    { stage: 'stt', chain: [{ provider: 'openai' }] },
    { stage: 'tts', chain: [{ provider: 'openai' }] },
  ];

  it('returns the matching chain config for a given stage', () => {
    const result = findChainForStage(chains, 'llm');
    expect(result?.stage).toBe('llm');
    expect(result?.chain[0].provider).toBe('groq');
  });

  it('returns stt chain when asked for stt stage', () => {
    const result = findChainForStage(chains, 'stt');
    expect(result?.stage).toBe('stt');
  });

  it('returns undefined when stage is not in the array', () => {
    const result = findChainForStage(chains, 'image');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty chains array', () => {
    const result = findChainForStage([], 'llm');
    expect(result).toBeUndefined();
  });

  it('returns undefined when chains is undefined', () => {
    const result = findChainForStage(undefined, 'llm');
    expect(result).toBeUndefined();
  });

  it('returns the first matching chain when multiple configs share the same stage', () => {
    const duplicates: FallbackChainConfig[] = [
      { stage: 'llm', chain: [{ provider: 'groq' }] },
      { stage: 'llm', chain: [{ provider: 'openai' }] },
    ];
    const result = findChainForStage(duplicates, 'llm');
    expect(result?.chain[0].provider).toBe('groq');
  });

  it('handles omni stage lookup', () => {
    const configs: FallbackChainConfig[] = [
      { stage: 'omni', chain: [{ provider: 'openai' }] },
    ];
    const result = findChainForStage(configs, 'omni');
    expect(result?.stage).toBe('omni');
  });

  it('handles realtime stage lookup', () => {
    const configs: FallbackChainConfig[] = [
      { stage: 'realtime', chain: [{ provider: 'openai' }] },
    ];
    const result = findChainForStage(configs, 'realtime');
    expect(result?.stage).toBe('realtime');
  });
});
