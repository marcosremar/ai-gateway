/**
 * Tests for providers/chain-builder.ts
 * - resolveApiKey()
 * - buildFallbackChain()
 * - getSystemLlmEntryFromSettings()
 * - getSystemSttEntryFromSettings()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveApiKey,
  buildFallbackChain,
  getSystemLlmEntryFromSettings,
  getSystemSttEntryFromSettings,
  type UserProviderSettings,
  type SavedProfile,
} from '../../src/providers/chain-builder';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [
    'OPENAI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'FIREWORKS_API_KEY',
    'MODAL_API_KEY',
    'VAST_API_KEY',
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveApiKey', () => {
  it('returns env var when set for openai', async () => {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    const key = await resolveApiKey('openai');
    expect(key).toBe('env-openai-key');
  });

  it('returns null when no env var', async () => {
    const key = await resolveApiKey('openai');
    expect(key).toBeNull();
  });

  it('returns null for unknown provider with no env mapping', async () => {
    const key = await resolveApiKey('unknown-provider' as never);
    expect(key).toBeNull();
  });

  it('handles groq env var', async () => {
    process.env.GROQ_API_KEY = 'groq-env-key';
    const key = await resolveApiKey('groq');
    expect(key).toBe('groq-env-key');
  });

  it('handles openrouter env var', async () => {
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    const key = await resolveApiKey('openrouter');
    expect(key).toBe('or-env-key');
  });

  it('handles fireworks env var', async () => {
    process.env.FIREWORKS_API_KEY = 'fw-env-key';
    const key = await resolveApiKey('fireworks');
    expect(key).toBe('fw-env-key');
  });

  it('handles modal env var', async () => {
    process.env.MODAL_API_KEY = 'modal-env-key';
    const key = await resolveApiKey('modal');
    expect(key).toBe('modal-env-key');
  });

  it('returns null for ollama (no env key)', async () => {
    const key = await resolveApiKey('ollama');
    expect(key).toBeNull();
  });

  it('returns null for gpu (no env key)', async () => {
    const key = await resolveApiKey('gpu');
    expect(key).toBeNull();
  });
});

describe('buildFallbackChain', () => {
  function makeSettings(
    profiles: SavedProfile[],
    overrides: Partial<UserProviderSettings> = {},
  ): UserProviderSettings {
    return {
      activeProvider: 'openai',
      keys: {},
      profiles,
      ...overrides,
    };
  }

  it('builds chain from pipeline profiles', () => {
    const settings = makeSettings([
      { pipelineMode: 'pipeline', stt: { provider: 'groq', model: 'whisper-large-v3-turbo' } },
      { pipelineMode: 'pipeline', stt: { provider: 'openai', model: 'whisper-1' } },
    ]);

    const chain = buildFallbackChain(settings, 'stt');
    expect(chain).toHaveLength(2);
    expect(chain[0].provider).toBe('groq');
    expect(chain[1].provider).toBe('openai');
  });

  it('skips omni profiles when building chain', () => {
    const settings = makeSettings([
      { pipelineMode: 'omni', provider: 'runpod' },
      { pipelineMode: 'pipeline', llm: { provider: 'openai', model: 'gpt-4o-mini' } },
    ]);

    const chain = buildFallbackChain(settings, 'llm');
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('openai');
  });

  it('falls back to pipelineStages when no profiles', () => {
    const settings = makeSettings([], {
      pipelineStages: {
        tts: { provider: 'openai', model: 'tts-1' },
      },
    });

    const chain = buildFallbackChain(settings, 'tts');
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('openai');
    expect(chain[0].model).toBe('tts-1');
  });

  it('falls back to activeProvider as last resort', () => {
    const settings = makeSettings([]);
    const chain = buildFallbackChain(settings, 'llm');
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('openai');
  });

  it('falls back to openai when activeProvider is GPU provider', () => {
    const settings = makeSettings([], { activeProvider: 'runpod' as never });
    const chain = buildFallbackChain(settings, 'llm');
    expect(chain[0].provider).toBe('openai');
  });

  it('deduplicates entries', () => {
    const settings = makeSettings([
      { pipelineMode: 'pipeline', llm: { provider: 'openai', model: 'gpt-4o-mini' } },
      { pipelineMode: 'pipeline', llm: { provider: 'openai', model: 'gpt-4o-mini' } }, // duplicate
    ]);

    const chain = buildFallbackChain(settings, 'llm');
    expect(chain).toHaveLength(1);
  });

  it('filters out non-cloud providers', () => {
    const settings = makeSettings([
      { pipelineMode: 'pipeline', llm: { provider: 'runpod', model: 'some-model' } }, // GPU, not cloud
      { pipelineMode: 'pipeline', llm: { provider: 'openai', model: 'gpt-4o-mini' } },
    ]);

    const chain = buildFallbackChain(settings, 'llm');
    expect(chain.some((e) => e.provider === 'runpod')).toBe(false);
    expect(chain.some((e) => e.provider === 'openai')).toBe(true);
  });

  it('allows vast-serverless provider', () => {
    const settings = makeSettings([
      { pipelineMode: 'pipeline', llm: { provider: 'vast-serverless', model: 'some-model' } },
    ]);

    const chain = buildFallbackChain(settings, 'llm');
    expect(chain.some((e) => e.provider === 'vast-serverless')).toBe(true);
  });

  it('handles null settings', () => {
    const chain = buildFallbackChain(null, 'llm');
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('openai');
  });

  it('profiles without stage config are skipped', () => {
    const settings = makeSettings([
      { pipelineMode: 'pipeline' }, // no stt
      { pipelineMode: 'pipeline', stt: { provider: 'groq', model: 'whisper' } },
    ]);

    const chain = buildFallbackChain(settings, 'stt');
    expect(chain).toHaveLength(1);
    expect(chain[0].provider).toBe('groq');
  });
});

describe('getSystemLlmEntryFromSettings', () => {
  it('returns systemLlm when configured', () => {
    const settings: UserProviderSettings = {
      activeProvider: 'openai',
      keys: {},
      systemLlm: { provider: 'groq', model: 'llama-3.3-70b' },
    };
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry.provider).toBe('groq');
    expect(entry.model).toBe('llama-3.3-70b');
  });

  it('falls back to chain when no systemLlm', () => {
    const settings: UserProviderSettings = {
      activeProvider: 'openai',
      keys: {},
      profiles: [
        { pipelineMode: 'pipeline', llm: { provider: 'openrouter', model: 'llama-3.3-70b' } },
      ],
    };
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry.provider).toBe('openrouter');
  });

  it('handles null settings', () => {
    const entry = getSystemLlmEntryFromSettings(null);
    expect(entry).toBeDefined();
    expect(entry.provider).toBe('openai');
  });

  it('ignores non-cloud systemLlm provider', () => {
    const settings: UserProviderSettings = {
      activeProvider: 'openai',
      keys: {},
      systemLlm: { provider: 'runpod', model: 'some-model' }, // non-cloud
    };
    // Should fall back to chain
    const entry = getSystemLlmEntryFromSettings(settings);
    expect(entry.provider).toBe('openai'); // default fallback
  });
});

describe('getSystemSttEntryFromSettings', () => {
  it('returns systemStt when configured', () => {
    const settings: UserProviderSettings = {
      activeProvider: 'openai',
      keys: {},
      systemStt: { provider: 'groq', model: 'whisper-large-v3' },
    };
    const entry = getSystemSttEntryFromSettings(settings);
    expect(entry.provider).toBe('groq');
    expect(entry.model).toBe('whisper-large-v3');
  });

  it('falls back to chain when no systemStt', () => {
    const settings: UserProviderSettings = {
      activeProvider: 'openai',
      keys: {},
      profiles: [
        { pipelineMode: 'pipeline', stt: { provider: 'fireworks', model: 'whisper-v3-turbo' } },
      ],
    };
    const entry = getSystemSttEntryFromSettings(settings);
    expect(entry.provider).toBe('fireworks');
  });

  it('handles null settings', () => {
    const entry = getSystemSttEntryFromSettings(null);
    expect(entry).toBeDefined();
  });
});
